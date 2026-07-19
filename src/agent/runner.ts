import { type ChildProcess, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

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
}

export interface AgentRunResult {
	stdout: string;
	stderr: string;
}

export type AgentRunErrorKind = "spawn-failed" | "timeout" | "nonzero-exit";

export class AgentRunError extends Error {
	readonly kind: AgentRunErrorKind;
	readonly command: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	/** Tail of the agent's stderr output, for diagnostics -- may be empty (e.g. a spawn failure has none). */
	readonly stderrTail: string;

	constructor(
		kind: AgentRunErrorKind,
		reason: string,
		details: {
			command: string;
			exitCode?: number | null;
			signal?: NodeJS.Signals | null;
			stderrTail?: string;
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
	}
}

/** Grace period between SIGTERM and SIGKILL for a command that exceeded its timeout. */
const KILL_GRACE_MS = 5_000;
/** Cap on how much stderr an AgentRunError carries for diagnostics -- the full output isn't needed to explain a failure. */
const STDERR_TAIL_CHARS = 4_000;

function tail(text: string, maxChars: number): string {
	return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

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
	const { command: rawCommand, timeoutSeconds, briefPath, outPath, cwd, env } = options;
	const { command, usedPlaceholder } = substitutePlaceholders(rawCommand, briefPath, outPath);

	const stdinContent = usedPlaceholder ? undefined : await readFile(briefPath, "utf8");

	const result = await new Promise<AgentRunResult>((resolve, reject) => {
		const child = spawn(command, {
			cwd,
			env: env ?? process.env,
			shell: true,
			stdio: [usedPlaceholder ? "ignore" : "pipe", "pipe", "pipe"],
			// POSIX only -- see killProcessGroup's doc comment for why this (plus
			// signalling the negative pid on timeout) is needed to reap a real
			// agent process that outlives the immediate shell child.
			...(IS_WINDOWS ? {} : { detached: true }),
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let termTimer: NodeJS.Timeout | undefined;

		termTimer = setTimeout(() => {
			timedOut = true;
			killProcessGroup(child, "SIGTERM");
			// Deliberately not cancelled if the immediate child's own "close" fires
			// first (see below): a grandchild ignoring SIGTERM can outlive the
			// immediate child, so this escalation is a fire-and-forget safety net
			// that runs to completion regardless of when/whether our promise has
			// already settled. A dead-by-then group makes killProcessGroup a no-op.
			setTimeout(() => {
				killProcessGroup(child, "SIGKILL");
			}, KILL_GRACE_MS);
		}, timeoutSeconds * 1000);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
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
			reject(
				new AgentRunError("spawn-failed", `failed to run agent command: ${error.message}`, {
					command,
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
			if (timedOut) {
				reject(
					new AgentRunError("timeout", `agent command exceeded ${timeoutSeconds}s timeout: ${command}`, {
						command,
						exitCode: code,
						signal,
						stderrTail: tail(stderr, STDERR_TAIL_CHARS),
					}),
				);
				return;
			}
			if (code !== 0) {
				reject(
					new AgentRunError(
						"nonzero-exit",
						`agent command exited with code ${code}${signal ? ` (signal ${signal})` : ""}: ${command}`,
						{ command, exitCode: code, signal, stderrTail: tail(stderr, STDERR_TAIL_CHARS) },
					),
				);
				return;
			}
			resolve({ stdout, stderr });
		});

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
