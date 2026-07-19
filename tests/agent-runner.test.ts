import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
