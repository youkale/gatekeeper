import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentRunError, runAgentCommand } from "../src/agent/runner.js";

// process.execPath is the real node binary running this test -- these fixtures are
// small `node -e` one-liners, never a real network call or real coding-agent CLI.
const NODE = process.execPath;

describe("runAgentCommand", () => {
	let tmpDir: string;
	let briefPath: string;
	let outPath: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-agent-runner-"));
		briefPath = path.join(tmpDir, "brief.md");
		outPath = path.join(tmpDir, "out.json");
		await writeFile(briefPath, "# briefing\nhello agent\n", "utf8");
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("placeholder mode: substitutes {brief}/{out} with absolute paths and runs via a shell", async () => {
		// Reads the brief file at the substituted path and writes a canned payload
		// to the substituted out path -- exactly the "codex exec < {brief} > {out}"
		// shape a real agent CLI config would use.
		const script =
			"const fs=require('fs');" +
			"const brief=fs.readFileSync(process.argv[1],'utf8');" +
			"fs.writeFileSync(process.argv[2], JSON.stringify({decision:'accepted',briefLength:brief.length}));";
		const command = `${JSON.stringify(NODE)} -e ${JSON.stringify(script)} {brief} {out}`;

		const result = await runAgentCommand({ command, timeoutSeconds: 10, briefPath, outPath, cwd: tmpDir });

		expect(result.stdout).toBe("");
		const written = JSON.parse(await readFile(outPath, "utf8"));
		expect(written).toEqual({ decision: "accepted", briefLength: "# briefing\nhello agent\n".length });
	});

	it("pipe mode (no placeholder): pipes the brief into stdin and writes captured stdout to outPath", async () => {
		const script =
			"process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);" +
			"process.stdin.on('end',()=>process.stdout.write(d.toUpperCase()));";
		const command = `${JSON.stringify(NODE)} -e ${JSON.stringify(script)}`;

		const result = await runAgentCommand({ command, timeoutSeconds: 10, briefPath, outPath, cwd: tmpDir });

		expect(result.stdout).toBe("# BRIEFING\nHELLO AGENT\n");
		expect(await readFile(outPath, "utf8")).toBe("# BRIEFING\nHELLO AGENT\n");
	});

	it("preserves the legacy byte output and exact result shape when every new option is omitted", async () => {
		const script =
			"process.stdin.resume();" +
			"process.stdin.on('data',c=>process.stdout.write(c));" +
			"process.stdin.on('end',()=>process.stderr.write('legacy stderr\\n'));";
		const command = `${JSON.stringify(NODE)} -e ${JSON.stringify(script)}`;

		const result = await runAgentCommand({ command, timeoutSeconds: 10, briefPath, outPath, cwd: tmpDir });

		expect(result).toStrictEqual({ stdout: "# briefing\nhello agent\n", stderr: "legacy stderr\n" });
		expect(await readFile(outPath, "utf8")).toBe("# briefing\nhello agent\n");
	});

	it("writes stdout/stderr directly to append-only log files when a log sink is enabled", async () => {
		const stdoutPath = path.join(tmpDir, "stdout.log");
		const stderrPath = path.join(tmpDir, "stderr.log");
		await writeFile(stdoutPath, "previous stdout\n", "utf8");
		await writeFile(stderrPath, "previous stderr\n", "utf8");
		const script = "process.stdout.write('fresh stdout\\n');process.stderr.write('fresh stderr\\n');";
		const command = `${JSON.stringify(NODE)} -e ${JSON.stringify(script)} {brief} {out}`;

		const result = await runAgentCommand({
			command,
			timeoutSeconds: 10,
			briefPath,
			outPath,
			cwd: tmpDir,
			logSink: { stdoutPath, stderrPath },
		});

		expect(await readFile(stdoutPath, "utf8")).toBe("previous stdout\nfresh stdout\n");
		expect(await readFile(stderrPath, "utf8")).toBe("previous stderr\nfresh stderr\n");
		expect(result).toStrictEqual({
			stdout: "fresh stdout\n",
			stderr: "fresh stderr\n",
			logSink: { mode: "direct", degraded: false },
		});
	});

	it("logs and continues with pipe capture when the requested log sink cannot be opened", async () => {
		const missingParent = path.join(tmpDir, "missing-parent");
		const warning = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const script = "process.stdout.write('fallback stdout');process.stderr.write('fallback stderr');";
		const command = `${JSON.stringify(NODE)} -e ${JSON.stringify(script)}`;

		const result = await runAgentCommand({
			command,
			timeoutSeconds: 10,
			briefPath,
			outPath,
			cwd: tmpDir,
			logSink: {
				stdoutPath: path.join(missingParent, "stdout.log"),
				stderrPath: path.join(missingParent, "stderr.log"),
			},
		});

		expect(result.stdout).toBe("fallback stdout");
		expect(result.stderr).toBe("fallback stderr");
		expect(result.logSink).toMatchObject({ mode: "pipe-fallback", degraded: true });
		expect(result.logSink?.error).toBeTruthy();
		expect(await readFile(outPath, "utf8")).toBe("fallback stdout");
		expect(warning.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
			"could not open direct log sink; falling back to output pipes",
		);
		warning.mockRestore();
	});

	it.skipIf(process.platform === "win32")(
		"keeps the agent healthy and reports degradation when a log write fails after spawn",
		async () => {
			const probe = `
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentCommand } from "./src/agent/runner.ts";

const dir = await mkdtemp(path.join(tmpdir(), "gatekeeper-runtime-sink-fault-"));
try {
  const briefPath = path.join(dir, "brief.md");
  const outPath = path.join(dir, "out.json");
  const stdoutPath = path.join(dir, "stdout.log");
  const stderrPath = path.join(dir, "stderr.log");
  await writeFile(briefPath, "brief", "utf8");
  const script = "process.stdout.write('x'.repeat(16384));process.stderr.write('agent-finished\\n');";
  const command = JSON.stringify(process.execPath) + " -e " + JSON.stringify(script) + " {brief} {out}";
  const result = await runAgentCommand({
    command,
    timeoutSeconds: 5,
    briefPath,
    outPath,
    cwd: dir,
    logSink: { stdoutPath, stderrPath },
    onSpawn: ({ pgid }) => process.stdout.write(JSON.stringify({ relayPgid: pgid }) + "\\n"),
  });
  process.stdout.write(JSON.stringify({
    stdoutBytes: result.stdout.length,
    stderr: result.stderr,
    logSink: result.logSink,
  }) + "\\n");
} finally {
  await rm(dir, { recursive: true, force: true });
}
`;
			const child = spawn(
				"/bin/sh",
				[
					"-c",
					'ulimit -f 1\nexec "$@"',
					"gatekeeper-sink-fault-probe",
					NODE,
					"--import",
					"tsx",
					"--input-type=module",
					"-e",
					probe,
				],
				{
					cwd: process.cwd(),
					env: process.env,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			let relayPgid: number | undefined;
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
				const match = stdout.match(/"relayPgid":(\d+)/);
				if (match?.[1]) {
					relayPgid = Number(match[1]);
				}
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});

			const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
				let timedOut = false;
				const killGroups = (signal: NodeJS.Signals): void => {
					for (const pgid of [child.pid, relayPgid]) {
						if (!pgid) {
							continue;
						}
						try {
							process.kill(-pgid, signal);
						} catch {
							// The probe or relay group already exited.
						}
					}
				};
				const timeout = setTimeout(() => {
					timedOut = true;
					killGroups("SIGTERM");
					const escalation = setTimeout(() => killGroups("SIGKILL"), 5_000);
					escalation.unref();
				}, 12_000);
				child.once("error", (error) => {
					clearTimeout(timeout);
					reject(error);
				});
				child.once("close", (code, signal) => {
					clearTimeout(timeout);
					if (timedOut) {
						reject(new Error("runtime sink fault probe timed out"));
						return;
					}
					resolve({ code, signal });
				});
			});

			expect(exit).toEqual({ code: 0, signal: null });
			const result = JSON.parse(stdout.trim().split("\n").at(-1) as string) as {
				stdoutBytes: number;
				stderr: string;
				logSink: { mode: string; degraded: boolean; error?: string };
			};
			expect(result.stdoutBytes).toBeGreaterThan(0);
			expect(result.stdoutBytes).toBeLessThan(16_384);
			expect(result.stderr).toBe("agent-finished\n");
			expect(result.logSink).toMatchObject({ mode: "direct", degraded: true });
			expect(result.logSink.error).toContain("file too large");
			expect(stderr).toContain("direct log sink degraded while the agent continued");
		},
		20_000,
	);

	it("reports advancing output-activity timestamps while direct log files grow", async () => {
		const stdoutPath = path.join(tmpDir, "activity-stdout.log");
		const stderrPath = path.join(tmpDir, "activity-stderr.log");
		const activities: Array<{ stream: "stdout" | "stderr"; timestampMs: number }> = [];
		const script =
			"process.stdout.write('first');" +
			"setTimeout(()=>process.stderr.write('second'),250);" +
			"setTimeout(()=>process.exit(0),500);";
		const command = `${JSON.stringify(NODE)} -e ${JSON.stringify(script)} {brief} {out}`;

		await runAgentCommand({
			command,
			timeoutSeconds: 10,
			briefPath,
			outPath,
			cwd: tmpDir,
			logSink: { stdoutPath, stderrPath },
			onActivity: (activity) => activities.push(activity),
		});

		expect(activities.map(({ stream }) => stream)).toEqual(["stdout", "stderr"]);
		expect(activities[0]?.timestampMs).toBeLessThan(activities[1]?.timestampMs as number);
		expect(await readFile(stdoutPath, "utf8")).toBe("first");
		expect(await readFile(stderrPath, "utf8")).toBe("second");
	});

	it("rejects with a structured AgentRunError on a non-zero exit", async () => {
		const command = `${JSON.stringify(NODE)} -e "process.exit(3)"`;

		await expect(
			runAgentCommand({ command, timeoutSeconds: 10, briefPath, outPath, cwd: tmpDir }),
		).rejects.toMatchObject({
			name: "AgentRunError",
			kind: "nonzero-exit",
			exitCode: 3,
		});
	});

	it("rejects with a structured AgentRunError carrying a stderr tail on a non-zero exit", async () => {
		const script = "process.stderr.write('boom: something broke\\n');process.exit(1);";
		const command = `${JSON.stringify(NODE)} -e ${JSON.stringify(script)}`;

		let caught: unknown;
		try {
			await runAgentCommand({ command, timeoutSeconds: 10, briefPath, outPath, cwd: tmpDir });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AgentRunError);
		expect((caught as AgentRunError).stderrTail).toContain("boom: something broke");
	});

	it("SIGTERMs (and eventually kills) a command that exceeds its timeout, rejecting with kind 'timeout'", async () => {
		// A default (unhandled) SIGTERM terminates a plain node process immediately,
		// so this resolves well before the runner's 5s SIGKILL grace period elapses.
		const script = "setTimeout(()=>{}, 60000);"; // would otherwise run for 60s
		const command = `${JSON.stringify(NODE)} -e ${JSON.stringify(script)}`;

		const start = Date.now();
		let caught: unknown;
		try {
			await runAgentCommand({ command, timeoutSeconds: 1, briefPath, outPath, cwd: tmpDir });
		} catch (error) {
			caught = error;
		}
		const elapsedMs = Date.now() - start;

		expect(caught).toBeInstanceOf(AgentRunError);
		expect((caught as AgentRunError).kind).toBe("timeout");
		// Well under the 1s timeout + 5s SIGKILL grace period -- proves SIGTERM alone stopped it.
		expect(elapsedMs).toBeLessThan(4_000);
	}, 10_000);

	it("marks a natural exit when an external AbortSignal was supplied but did not fire", async () => {
		const controller = new AbortController();
		const command = `${JSON.stringify(NODE)} -e "process.stdout.write('done')"`;

		const result = await runAgentCommand({
			command,
			timeoutSeconds: 10,
			briefPath,
			outPath,
			cwd: tmpDir,
			signal: controller.signal,
		});

		expect(result).toStrictEqual({ stdout: "done", stderr: "", termination: "natural" });
	});

	it("exposes the child pid and correct POSIX process-group id immediately after spawn", async () => {
		const command = `${JSON.stringify(NODE)} -e "setTimeout(()=>{},300)"`;
		const stdoutPath = path.join(tmpDir, "pgid-stdout.log");
		const stderrPath = path.join(tmpDir, "pgid-stderr.log");
		let observed: { pid: number; pgid: number | null } | undefined;
		let groupWasAlive = false;

		await runAgentCommand({
			command,
			timeoutSeconds: 10,
			briefPath,
			outPath,
			cwd: tmpDir,
			logSink: { stdoutPath, stderrPath },
			onSpawn: (processInfo) => {
				observed = processInfo;
				if (processInfo.pgid !== null) {
					process.kill(-processInfo.pgid, 0);
					groupWasAlive = true;
				}
			},
		});

		expect(observed?.pid).toBeGreaterThan(0);
		if (process.platform === "win32") {
			expect(observed?.pgid).toBeNull();
		} else {
			expect(observed?.pgid).toBe(observed?.pid);
			expect(groupWasAlive).toBe(true);
		}
	});

	// POSIX-only: external abort must reuse the timeout path's detached process
	// group and SIGTERM -> grace -> SIGKILL escalation, including grandchildren.
	it.skipIf(process.platform === "win32")(
		"externally aborts the full process group and reports a distinct error kind",
		async () => {
			const pidFilePath = path.join(tmpDir, "aborted-grandchild.pid");
			const wrapperScript =
				"const { spawn } = require('child_process');" +
				"const fs = require('fs');" +
				"const grandchild = spawn(process.execPath, " +
				"['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\"], { stdio: 'ignore' });" +
				"fs.writeFileSync(process.argv[1], String(grandchild.pid));" +
				"setTimeout(()=>{}, 60000);";
			const command = `${JSON.stringify(NODE)} -e ${JSON.stringify(wrapperScript)} {out}`;
			const controller = new AbortController();
			const stdoutPath = path.join(tmpDir, "abort-stdout.log");
			const stderrPath = path.join(tmpDir, "abort-stderr.log");
			const run = runAgentCommand({
				command,
				timeoutSeconds: 30,
				briefPath,
				outPath: pidFilePath,
				cwd: tmpDir,
				logSink: { stdoutPath, stderrPath },
				signal: controller.signal,
			});

			let grandchildPid: number | undefined;
			const spawnDeadline = Date.now() + 3_000;
			while (grandchildPid === undefined && Date.now() < spawnDeadline) {
				try {
					grandchildPid = Number((await readFile(pidFilePath, "utf8")).trim());
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			}
			expect(Number.isInteger(grandchildPid)).toBe(true);

			// Give the grandchild time to install its SIGTERM handler. The assertion
			// below then depends on the ladder's delayed group-wide SIGKILL.
			await new Promise((resolve) => setTimeout(resolve, 300));
			controller.abort();
			await expect(run).rejects.toMatchObject({ name: "AgentRunError", kind: "external-abort" });

			function isAlive(pid: number): boolean {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			}
			const killDeadline = Date.now() + 8_000;
			while (isAlive(grandchildPid as number) && Date.now() < killDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			expect(isAlive(grandchildPid as number)).toBe(false);
		},
		15_000,
	);

	// POSIX-only: this exercises detached: true + negative-pid process-group signalling
	// (killProcessGroup), which has no equivalent on Windows -- see its doc comment.
	it.skipIf(process.platform === "win32")(
		"reaps a grandchild process that ignores SIGTERM once the process-group SIGKILL fires after the grace period",
		async () => {
			// Shape: shell -> wrapper (a plain node process with no signal handler of its
			// own) -> grandchild (a *separate* OS process the wrapper spawns and does not
			// wait on, which explicitly ignores SIGTERM). Reproduces the real-world failure
			// this fixes: a real agent CLI that forks a worker process the top-level
			// `child.kill()` alone never reaches, which then keeps running -- and can keep
			// writing to {out} -- even after a timeout has already been reported.
			const pidFilePath = path.join(tmpDir, "grandchild.pid");
			const wrapperScript =
				"const { spawn } = require('child_process');" +
				"const fs = require('fs');" +
				"const grandchild = spawn(process.execPath, " +
				"['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\"], { stdio: 'ignore' });" +
				"fs.writeFileSync(process.argv[1], String(grandchild.pid));" +
				"setTimeout(()=>{}, 60000);"; // keep the wrapper itself alive past our 1s timeout
			const command = `${JSON.stringify(NODE)} -e ${JSON.stringify(wrapperScript)} {out}`;

			let caught: unknown;
			try {
				await runAgentCommand({ command, timeoutSeconds: 1, briefPath, outPath: pidFilePath, cwd: tmpDir });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(AgentRunError);
			expect((caught as AgentRunError).kind).toBe("timeout");

			const grandchildPid = Number((await readFile(pidFilePath, "utf8")).trim());
			expect(Number.isInteger(grandchildPid)).toBe(true);

			function isAlive(pid: number): boolean {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			}

			// The grandchild ignores SIGTERM, so it only dies once the group-wide SIGKILL
			// escalation fires ~5s after the SIGTERM (see KILL_GRACE_MS) -- poll for that
			// with a generous but bounded ceiling so a real regression fails the test
			// instead of hanging the suite.
			const deadline = Date.now() + 8_000;
			while (isAlive(grandchildPid) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			expect(isAlive(grandchildPid)).toBe(false);
		},
		15_000,
	);

	it("surfaces a missing binary as a non-zero shell exit (127), not a silent success", async () => {
		const command = "this-binary-does-not-exist-xyz-gatekeeper-test {brief} {out}";

		await expect(
			runAgentCommand({ command, timeoutSeconds: 10, briefPath, outPath, cwd: tmpDir }),
		).rejects.toMatchObject({ name: "AgentRunError", kind: "nonzero-exit" });
	});

	it("passes through the given cwd and env to the spawned command", async () => {
		const script = "const fs=require('fs');fs.writeFileSync(process.argv[1], process.cwd()+'|'+process.env.GK_TEST);";
		const command = `${JSON.stringify(NODE)} -e ${JSON.stringify(script)} {out}`;

		await runAgentCommand({
			command,
			timeoutSeconds: 10,
			briefPath,
			outPath,
			cwd: tmpDir,
			env: { ...process.env, GK_TEST: "marker-value" },
		});

		const written = await readFile(outPath, "utf8");
		// macOS's /tmp is a symlink to /private/tmp -- compare against the realpath
		// of the mkdtemp'd tmpDir, not its raw (possibly-symlinked) path.
		expect(written).toBe(`${await realpath(tmpDir)}|marker-value`);
	});

	describe("shell-quoting of substituted {brief}/{out} paths", () => {
		// Live-fire regressions: a raw, unquoted path splice into a `spawn(..., { shell: true
		// })` command string breaks in two different ways depending on what character the
		// mkdtemp-generated path happens to contain, so both are exercised against a real
		// shell rather than asserted against the quoting helper in isolation.
		let specialDir: string | undefined;

		afterEach(async () => {
			if (specialDir) {
				await rm(specialDir, { recursive: true, force: true });
				specialDir = undefined;
			}
		});

		it("a path with a space in an ancestor directory reaches the agent whole, not word-split", async () => {
			specialDir = await mkdtemp(path.join(tmpdir(), "gatekeeper agent runner with spaces "));
			const specialBrief = path.join(specialDir, "brief.md");
			const specialOut = path.join(specialDir, "out.json");
			await writeFile(specialBrief, "hello from a spacey directory", "utf8");

			// Reports exactly what the shell delivered: argv.length (2 extra args, or more if
			// word-split), and the brief/out strings themselves (corrupted -- e.g. truncated at
			// the first space -- if unquoted).
			const script =
				"const fs=require('fs');" +
				"const out=process.argv[process.argv.length-1];" +
				"fs.writeFileSync(out, JSON.stringify({" +
				"argvLength:process.argv.length," +
				"brief:process.argv[1]," +
				"out:process.argv[2]," +
				"briefContent:fs.readFileSync(process.argv[1],'utf8')" +
				"}));";
			const command = `${JSON.stringify(NODE)} -e ${JSON.stringify(script)} {brief} {out}`;

			await runAgentCommand({
				command,
				timeoutSeconds: 10,
				briefPath: specialBrief,
				outPath: specialOut,
				cwd: specialDir,
			});

			const written = JSON.parse(await readFile(specialOut, "utf8"));
			expect(written.argvLength).toBe(3);
			expect(written.brief).toBe(specialBrief);
			expect(written.out).toBe(specialOut);
			expect(written.briefContent).toBe("hello from a spacey directory");
		});

		it("a path with an embedded single quote in an ancestor directory reaches the agent whole, not fused with the next argument", async () => {
			specialDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-o'brien-agent-runner-"));
			const specialBrief = path.join(specialDir, "brief.md");
			const specialOut = path.join(specialDir, "out.json");
			await writeFile(specialBrief, "hello from a quoted directory", "utf8");

			const script =
				"const fs=require('fs');" +
				"const out=process.argv[process.argv.length-1];" +
				"fs.writeFileSync(out, JSON.stringify({" +
				"argvLength:process.argv.length," +
				"brief:process.argv[1]," +
				"out:process.argv[2]," +
				"briefContent:fs.readFileSync(process.argv[1],'utf8')" +
				"}));";
			const command = `${JSON.stringify(NODE)} -e ${JSON.stringify(script)} {brief} {out}`;

			await runAgentCommand({
				command,
				timeoutSeconds: 10,
				briefPath: specialBrief,
				outPath: specialOut,
				cwd: specialDir,
			});

			const written = JSON.parse(await readFile(specialOut, "utf8"));
			// Fused-argument failure mode would report argvLength 2 with a single argv[1]
			// containing both paths concatenated -- asserting both paths land in their own
			// distinct argv slot directly rules that out, not just the end-to-end file content.
			expect(written.argvLength).toBe(3);
			expect(written.brief).toBe(specialBrief);
			expect(written.out).toBe(specialOut);
			expect(written.briefContent).toBe("hello from a quoted directory");
		});
	});
});
