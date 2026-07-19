import { type ChildProcess, spawn } from "node:child_process";
import { type FileHandle, open, readFile, writeFile } from "node:fs/promises";

/**
 * BYO ("bring your own") coding-agent runner: spawns exactly the shell
 * command the user declared in `.gatekeeper.yml`'s `agent:` block (see
 * src/config/discover.ts) against a briefing file and captures whatever it
 * produces.
 *
 * Zero-model invariant: this module makes no model/LLM call itself and never
 * chooses which agent to run -- it only ever `spawn`s a command string that
 * already exists in the user's own config file. Its trust boundary is the
 * same as any other command sourced from a config file the user controls
 * (an npm script, a git hook, a Makefile target): whoever can edit
 * `.gatekeeper.yml` can already run arbitrary shell commands as this user,
 * so `shell: true` here adds no new capability.
 */

export interface AgentRunOptions {
	/** The `agent.command` shell string. May reference `{brief}`/`{out}` placeholders. */
	command: string;
	/** Wall-clock budget before SIGTERM (a further 5s grace period precedes SIGKILL). */
	timeoutSeconds: number;
	/** Absolute path to the briefing file handed to the agent. */
	briefPath: string;
	/** Absolute path the agent is expected to produce its artifact at (a file or a directory, caller-defined). */
	outPath: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/**
	 * Optional durable stdout/stderr file sink. Each file is opened in append
	 * mode and inherited by an in-group relay, avoiding a supervisor-owned
	 * output pipe while isolating the agent from runtime sink write failures.
	 */
	logSink?: AgentRunLogSinkOptions;
	/** Called synchronously whenever new stdout/stderr output is observed. */
	onActivity?: (activity: AgentOutputActivity) => void;
	/** Optional external cancellation routed through the same process-group termination ladder as a timeout. */
	signal?: AbortSignal;
	/** Called immediately after a successful spawn with the child pid and its process-group id. */
	onSpawn?: (process: AgentProcessInfo) => void;
}

export interface AgentOutputActivity {
	stream: "stdout" | "stderr";
	timestampMs: number;
}

export interface AgentProcessInfo {
	pid: number;
	/** POSIX detached children lead a group whose id equals pid; Windows has no equivalent and reports null. */
	pgid: number | null;
}

export interface AgentRunLogSinkOptions {
	stdoutPath: string;
	stderrPath: string;
}

export interface AgentRunLogSinkResult {
	mode: "direct" | "pipe-fallback";
	degraded: boolean;
	error?: string;
}

export interface AgentRunResult {
	stdout: string;
	stderr: string;
	/** Present only when `logSink` was requested, preserving the legacy result shape by default. */
	logSink?: AgentRunLogSinkResult;
	/** Present only when an AbortSignal was supplied and the command exited without that signal firing. */
	termination?: "natural";
}

export type AgentRunErrorKind = "spawn-failed" | "timeout" | "external-abort" | "nonzero-exit";

export class AgentRunError extends Error {
	readonly kind: AgentRunErrorKind;
	readonly command: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	/** Tail of the agent's stderr output, for diagnostics -- may be empty (e.g. a spawn failure has none). */
	readonly stderrTail: string;
	/** Present only when a requested direct log sink was active or fell back. */
	readonly logSink?: AgentRunLogSinkResult;

	constructor(
		kind: AgentRunErrorKind,
		reason: string,
		details: {
			command: string;
			exitCode?: number | null;
			signal?: NodeJS.Signals | null;
			stderrTail?: string;
			logSink?: AgentRunLogSinkResult;
			cause?: unknown;
		},
	) {
		super(reason, details.cause !== undefined ? { cause: details.cause } : undefined);
		this.name = "AgentRunError";
		this.kind = kind;
		this.command = details.command;
		this.exitCode = details.exitCode ?? null;
		this.signal = details.signal ?? null;
		this.stderrTail = details.stderrTail ?? "";
		if (details.logSink !== undefined) {
			this.logSink = details.logSink;
		}
	}
}

/** Grace period between SIGTERM and SIGKILL for a command that exceeded its timeout. */
const KILL_GRACE_MS = 5_000;
/** Cap on how much stderr an AgentRunError carries for diagnostics -- the full output isn't needed to explain a failure. */
const STDERR_TAIL_CHARS = 4_000;

function tail(text: string, maxChars: number): string {
	return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

interface PreparedLogSink {
	stdoutHandle: FileHandle;
	stderrHandle: FileHandle;
	stdoutPath: string;
	stderrPath: string;
	stdoutStart: number;
	stderrStart: number;
}

function runnerWarning(message: string): void {
	try {
		process.stderr.write(`gatekeeper agent runner: ${message}\n`);
	} catch {
		// Reporting a log-sink fault is itself best-effort. It must never affect
		// the child process or turn an otherwise healthy run into a failure.
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function closeLogHandles(prepared: PreparedLogSink): Promise<string[]> {
	const results = await Promise.allSettled([prepared.stdoutHandle.close(), prepared.stderrHandle.close()]);
	return results.flatMap((result) => (result.status === "rejected" ? [errorMessage(result.reason)] : []));
}

async function prepareLogSink(
	options: AgentRunLogSinkOptions,
): Promise<{ prepared?: PreparedLogSink; result: AgentRunLogSinkResult }> {
	let stdoutHandle: FileHandle | undefined;
	let stderrHandle: FileHandle | undefined;
	try {
		stdoutHandle = await open(options.stdoutPath, "a");
		const stdoutStart = (await stdoutHandle.stat()).size;
		stderrHandle = await open(options.stderrPath, "a");
		const stderrStart = (await stderrHandle.stat()).size;
		return {
			prepared: {
				stdoutHandle,
				stderrHandle,
				stdoutPath: options.stdoutPath,
				stderrPath: options.stderrPath,
				stdoutStart,
				stderrStart,
			},
			result: { mode: "direct", degraded: false },
		};
	} catch (error) {
		await Promise.allSettled([stdoutHandle?.close(), stderrHandle?.close()]);
		const message = errorMessage(error);
		runnerWarning(`could not open direct log sink; falling back to output pipes: ${message}`);
		return { result: { mode: "pipe-fallback", degraded: true, error: message } };
	}
}

async function readAppendedOutput(path: string, start: number): Promise<string> {
	const content = await readFile(path);
	return content.subarray(Math.min(start, content.length)).toString("utf8");
}

async function finishLogSink(
	prepared: PreparedLogSink,
	initialResult: AgentRunLogSinkResult,
	runtimeErrors: string[],
): Promise<{ stdout: string; stderr: string; result: AgentRunLogSinkResult }> {
	const errors = [...runtimeErrors];
	const finalizationErrors: string[] = [];
	for (const handle of [prepared.stdoutHandle, prepared.stderrHandle]) {
		try {
			await handle.sync();
		} catch (error) {
			finalizationErrors.push(errorMessage(error));
		}
	}

	let stdout = "";
	let stderr = "";
	try {
		[stdout, stderr] = await Promise.all([
			readAppendedOutput(prepared.stdoutPath, prepared.stdoutStart),
			readAppendedOutput(prepared.stderrPath, prepared.stderrStart),
		]);
	} catch (error) {
		finalizationErrors.push(errorMessage(error));
	}
	finalizationErrors.push(...(await closeLogHandles(prepared)));
	errors.push(...finalizationErrors);

	if (errors.length === 0) {
		return { stdout, stderr, result: initialResult };
	}
	const message = errors.join("; ");
	if (finalizationErrors.length > 0) {
		runnerWarning(`direct log sink degraded while the agent continued: ${finalizationErrors.join("; ")}`);
	}
	return { stdout, stderr, result: { mode: "direct", degraded: true, error: message } };
}

function reportActivity(
	onActivity: ((activity: AgentOutputActivity) => void) | undefined,
	stream: AgentOutputActivity["stream"],
	timestampMs = Date.now(),
): void {
	if (!onActivity) {
		return;
	}
	try {
		onActivity({ stream, timestampMs });
	} catch (error) {
		runnerWarning(`output activity callback failed while the agent continued: ${errorMessage(error)}`);
	}
}

interface LogRelayMessage {
	type: "activity" | "sink-error" | "relay-complete";
	stream?: AgentOutputActivity["stream"];
	timestampMs?: number;
	error?: string;
	sinkErrors?: string[];
}

function isLogRelayMessage(message: unknown): message is LogRelayMessage {
	if (typeof message !== "object" || message === null) {
		return false;
	}
	const candidate = message as Partial<LogRelayMessage>;
	if (candidate.type === "relay-complete") {
		return Array.isArray(candidate.sinkErrors) && candidate.sinkErrors.every((error) => typeof error === "string");
	}
	return (
		(candidate.type === "activity" || candidate.type === "sink-error") &&
		(candidate.stream === "stdout" || candidate.stream === "stderr")
	);
}

/**
 * Runs only in the optional log-sink mode. This relay is the detached process
 * group leader exposed as the run's pid/pgid; the configured shell command is
 * its non-detached child and therefore remains inside the same termination
 * group. The relay owns the output pipes, not the supervisor, so supervisor
 * death does not close them. If a log write later fails, it discards and keeps
 * draining that stream so the agent never observes EPIPE/EFBIG from the sink.
 */
const LOG_RELAY_SCRIPT = `
const { spawn } = require("node:child_process");
const { createWriteStream } = require("node:fs");

const command = process.argv[1];
const useStdin = process.argv[2] === "pipe";
const sinkErrors = [];
const pendingActivity = { stdout: 0, stderr: 0 };
const sentActivity = { stdout: 0, stderr: 0 };

function send(message, callback) {
  if (!process.connected || typeof process.send !== "function") {
    callback?.();
    return;
  }
  try {
    process.send(message, (error) => callback?.(error));
  } catch {
    callback?.();
  }
}

function flushActivity() {
  for (const stream of ["stdout", "stderr"]) {
    const timestampMs = pendingActivity[stream];
    if (timestampMs > sentActivity[stream]) {
      sentActivity[stream] = timestampMs;
      send({ type: "activity", stream, timestampMs });
    }
  }
}

const activityTimer = setInterval(flushActivity, 100);
activityTimer.unref();
process.on("disconnect", () => undefined);
try {
  process.on("SIGXFSZ", () => undefined);
} catch {
  // SIGXFSZ is not available on every supported platform.
}

const agent = spawn(command, {
  shell: true,
  stdio: [useStdin ? "inherit" : "ignore", "pipe", "pipe"],
});

function relay(readable, fd, stream) {
  return new Promise((resolve) => {
    const sink = createWriteStream("", { fd, autoClose: false });
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };
    readable.on("data", () => {
      pendingActivity[stream] = Date.now();
    });
    sink.once("finish", finish);
    sink.once("error", (error) => {
      const detail = stream + ": " + (error instanceof Error ? error.message : String(error));
      sinkErrors.push(detail);
      send({ type: "sink-error", stream, error: detail });
      readable.unpipe(sink);
      readable.resume();
      finish();
    });
    readable.pipe(sink);
  });
}

const relays = [relay(agent.stdout, 3, "stdout"), relay(agent.stderr, 4, "stderr")];
let spawnError;
agent.once("error", (error) => {
  spawnError = error;
});
agent.once("close", async (code, signal) => {
  await Promise.all(relays);
  clearInterval(activityTimer);
  flushActivity();
  const finish = () => {
    if (process.connected) {
      process.disconnect();
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(spawnError ? 1 : (code ?? 1));
  };
  send({ type: "relay-complete", sinkErrors }, finish);
});
`;

/**
 * POSIX shell single-quoting for a path value *we* generated (mkdtemp's
 * output plus a fixed filename), not for any part of the user's own command
 * string. Wraps the value in `'...'` and escapes an embedded `'` as `'\''`
 * (close the quote, an escaped literal quote, reopen the quote) -- the
 * standard technique for safely embedding an arbitrary string as one shell
 * word. Without this, splicing a raw path into `command` before handing it
 * to `spawn(..., { shell: true })` breaks in two ways: a space in the path
 * (e.g. an mkdtemp parent directory with a space in it) splits it into
 * multiple words, and an embedded `'` flips quoting state and can fuse two
 * separate paths into one argument.
 */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Windows has no negative-pid process-group kill via child_process.kill -- see killProcessGroup. */
const IS_WINDOWS = process.platform === "win32";

/**
 * Sends `signal` to every process in the spawned command's process group, not
 * just the immediate child. `spawn(command, { shell: true })`'s immediate
 * child is a shell (e.g. `/bin/sh -c command`); the real agent CLI it runs
 * can be a *grandchild* (the shell forks rather than exec-replacing itself
 * whenever the command involves redirection/pipes/etc, which every
 * `{brief}`/`{out}` placeholder command does by construction). `child.kill()`
 * only ever signals that one immediate pid -- a grandchild that ignores or
 * outlives it keeps running (and can keep writing to `{out}`) even after this
 * module has already reported a timeout.
 *
 * The fix is `detached: true` at spawn time (POSIX: `setsid`, making the
 * child a new process-group leader whose pgid equals its pid) plus signalling
 * the negative pid here, which POSIX kill(2)/Node's process.kill() treat as
 * "every process in that group". Windows has no equivalent: `detached` means
 * something unrelated there (a new console, not a process group) and
 * `child_process.kill` has no negative-pid group semantics, so this falls
 * back to the previous single-process `child.kill()` there -- a known,
 * documented limitation: a Windows grandchild that ignores termination can
 * still outlive a reported timeout.
 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (IS_WINDOWS || !child.pid) {
		child.kill(signal);
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch {
		// ESRCH: the group is already gone (e.g. it exited between our timeout
		// firing and this call) -- nothing left to signal.
	}
}

/**
 * Substitutes `{brief}`/`{out}` with their absolute paths, each wrapped in a
 * shell-safe single-quoted word (see shellQuote) since the result is spliced
 * into a string executed through a shell. Plain string substitution, not
 * regex -- a path can legitimately contain regex metacharacters. Reports
 * whether either placeholder was present, which selects the run mode below.
 */
function substitutePlaceholders(
	command: string,
	briefPath: string,
	outPath: string,
): { command: string; usedPlaceholder: boolean } {
	let usedPlaceholder = false;
	let result = command;
	if (result.includes("{brief}")) {
		usedPlaceholder = true;
		result = result.split("{brief}").join(shellQuote(briefPath));
	}
	if (result.includes("{out}")) {
		usedPlaceholder = true;
		result = result.split("{out}").join(shellQuote(outPath));
	}
	return { command: result, usedPlaceholder };
}

/**
 * Runs the user's declared agent command in one of two modes, selected by
 * whether `command` contains a `{brief}`/`{out}` placeholder:
 *
 * - Placeholder mode: `{brief}`/`{out}` are substituted with absolute paths
 *   and the resulting string is executed through a shell. The command itself
 *   is responsible for reading the brief and writing its artifact at those
 *   paths (e.g. `codex exec --full-auto < {brief} > {out}`).
 * - Pipe mode (no placeholder present): the brief file's content is piped
 *   into the command's stdin, and the command's stdout is captured and
 *   written to `outPath` by this function (e.g. `grok -p "$(cat -)"`).
 *
 * A non-zero exit or a timeout always rejects with a structured
 * `AgentRunError` (fail-loud) -- callers must not treat either as a
 * degraded-but-successful run.
 */
export async function runAgentCommand(options: AgentRunOptions): Promise<AgentRunResult> {
	const {
		command: rawCommand,
		timeoutSeconds,
		briefPath,
		outPath,
		cwd,
		env,
		logSink,
		onActivity,
		signal: abortSignal,
		onSpawn,
	} = options;
	const { command, usedPlaceholder } = substitutePlaceholders(rawCommand, briefPath, outPath);

	const stdinContent = usedPlaceholder ? undefined : await readFile(briefPath, "utf8");
	const preparedLogSink = logSink ? await prepareLogSink(logSink) : undefined;

	const result = await new Promise<AgentRunResult>((resolve, reject) => {
		const directLogSink = preparedLogSink?.prepared;
		let child: ChildProcess;
		try {
			if (directLogSink) {
				child = spawn(process.execPath, ["-e", LOG_RELAY_SCRIPT, command, usedPlaceholder ? "ignore" : "pipe"], {
					cwd,
					env: env ?? process.env,
					stdio: [
						usedPlaceholder ? "ignore" : "pipe",
						"ignore",
						"ignore",
						directLogSink.stdoutHandle.fd,
						directLogSink.stderrHandle.fd,
						"ipc",
					],
					// The relay is the group leader and its agent child stays in this
					// same group, so the existing negative-pgid ladder covers both.
					...(IS_WINDOWS ? {} : { detached: true }),
				});
			} else {
				child = spawn(command, {
					cwd,
					env: env ?? process.env,
					shell: true,
					stdio: [usedPlaceholder ? "ignore" : "pipe", "pipe", "pipe"],
					// POSIX only -- see killProcessGroup's doc comment for why this (plus
					// signalling the negative pid on timeout) is needed to reap a real
					// agent process that outlives the immediate shell child.
					...(IS_WINDOWS ? {} : { detached: true }),
				});
			}
		} catch (error) {
			if (preparedLogSink?.prepared) {
				void closeLogHandles(preparedLogSink.prepared);
			}
			reject(error);
			return;
		}

		let stdout = "";
		let stderr = "";
		let settled = false;
		let terminationReason: "timeout" | "external-abort" | undefined;
		let termTimer: NodeJS.Timeout | undefined;
		let abortListener: (() => void) | undefined;
		const runtimeSinkErrors = new Set<string>();
		const recordRuntimeSinkError = (error: string): void => {
			if (runtimeSinkErrors.has(error)) {
				return;
			}
			runtimeSinkErrors.add(error);
			runnerWarning(`direct log sink degraded while the agent continued: ${error}`);
		};

		if (onSpawn) {
			child.once("spawn", () => {
				if (child.pid === undefined) {
					runnerWarning("spawn callback could not observe a child pid while the agent continued");
					return;
				}
				try {
					onSpawn({ pid: child.pid, pgid: IS_WINDOWS ? null : child.pid });
				} catch (error) {
					runnerWarning(`spawn callback failed while the agent continued: ${errorMessage(error)}`);
				}
			});
		}

		if (directLogSink) {
			child.on("message", (message) => {
				if (!isLogRelayMessage(message)) {
					return;
				}
				if (message.type === "activity" && message.stream && typeof message.timestampMs === "number") {
					reportActivity(onActivity, message.stream, message.timestampMs);
					return;
				}
				if (message.type === "sink-error" && typeof message.error === "string") {
					recordRuntimeSinkError(message.error);
					return;
				}
				for (const error of message.sinkErrors ?? []) {
					recordRuntimeSinkError(error);
				}
			});
		}

		const beginTermination = (reason: "timeout" | "external-abort"): void => {
			if (terminationReason) {
				// First trigger wins. A later abort or timeout reuses the ladder but must
				// not rewrite the causal outcome already recorded by the supervisor.
				return;
			}
			terminationReason = reason;
			killProcessGroup(child, "SIGTERM");
			// Deliberately not cancelled if the immediate child's own "close" fires
			// first (see below): a grandchild ignoring SIGTERM can outlive the
			// immediate child, so this escalation is a fire-and-forget safety net
			// that runs to completion regardless of when/whether our promise has
			// already settled. A dead-by-then group makes killProcessGroup a no-op.
			setTimeout(() => {
				killProcessGroup(child, "SIGKILL");
			}, KILL_GRACE_MS);
		};
		termTimer = setTimeout(() => beginTermination("timeout"), timeoutSeconds * 1000);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			reportActivity(onActivity, "stdout");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			reportActivity(onActivity, "stderr");
		});
		// A pipe-mode command whose process doesn't read stdin to completion (e.g. exits
		// as soon as it has enough input, or never reads at all) makes writing/ending our
		// end of the pipe raise EPIPE/ECONNRESET. That's routine, not an infrastructure
		// fault -- without this listener, Node's default behavior is to throw, crashing
		// the whole process.
		child.stdin?.on("error", () => undefined);

		child.on("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			if (termTimer) {
				clearTimeout(termTimer);
			}
			if (abortListener) {
				abortSignal?.removeEventListener("abort", abortListener);
			}
			if (preparedLogSink?.prepared) {
				void closeLogHandles(preparedLogSink.prepared);
			}
			reject(
				new AgentRunError("spawn-failed", `failed to run agent command: ${error.message}`, {
					command,
					logSink: preparedLogSink?.result,
					cause: error,
				}),
			);
		});

		child.on("close", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			if (termTimer) {
				clearTimeout(termTimer);
			}
			if (abortListener) {
				abortSignal?.removeEventListener("abort", abortListener);
			}
			void (async () => {
				let finalStdout = stdout;
				let finalStderr = stderr;
				let finalLogSink = preparedLogSink?.result;
				if (preparedLogSink?.prepared) {
					const finished = await finishLogSink(preparedLogSink.prepared, preparedLogSink.result, [
						...runtimeSinkErrors,
					]);
					finalStdout = finished.stdout;
					finalStderr = finished.stderr;
					finalLogSink = finished.result;
				}
				if (terminationReason === "external-abort") {
					reject(
						new AgentRunError("external-abort", `agent command was externally aborted: ${command}`, {
							command,
							exitCode: code,
							signal,
							stderrTail: tail(finalStderr, STDERR_TAIL_CHARS),
							logSink: finalLogSink,
						}),
					);
					return;
				}
				if (terminationReason === "timeout") {
					reject(
						new AgentRunError("timeout", `agent command exceeded ${timeoutSeconds}s timeout: ${command}`, {
							command,
							exitCode: code,
							signal,
							stderrTail: tail(finalStderr, STDERR_TAIL_CHARS),
							logSink: finalLogSink,
						}),
					);
					return;
				}
				if (code !== 0) {
					reject(
						new AgentRunError(
							"nonzero-exit",
							`agent command exited with code ${code}${signal ? ` (signal ${signal})` : ""}: ${command}`,
							{
								command,
								exitCode: code,
								signal,
								stderrTail: tail(finalStderr, STDERR_TAIL_CHARS),
								logSink: finalLogSink,
							},
						),
					);
					return;
				}
				resolve({
					stdout: finalStdout,
					stderr: finalStderr,
					...(finalLogSink ? { logSink: finalLogSink } : {}),
					...(abortSignal ? { termination: "natural" as const } : {}),
				});
			})().catch(reject);
		});

		if (abortSignal) {
			abortListener = () => {
				if (child.exitCode === null && child.signalCode === null) {
					beginTermination("external-abort");
				}
			};
			abortSignal.addEventListener("abort", abortListener, { once: true });
			if (abortSignal.aborted) {
				abortListener();
			}
		}

		if (!usedPlaceholder) {
			child.stdin?.write(stdinContent ?? "");
			child.stdin?.end();
		}
	});

	if (!usedPlaceholder) {
		await writeFile(outPath, result.stdout, "utf8");
	}

	return result;
}
