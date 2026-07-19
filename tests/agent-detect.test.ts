import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultSpawnVersion, detectAgentClis, findOnPath, type KnownAgentCli } from "../src/agent/detect.js";

// process.execPath is the real node binary running this test -- every fixture spawned
// below is a small `node -e` one-liner, never a real network call or coding-agent CLI.
const NODE = process.execPath;

/**
 * Every test below injects `findBinary`/`spawnVersion`/`entries` -- no real
 * PATH lookup or process spawn -- except the single smoke test at the bottom,
 * which exercises the real `findOnPath` against `node` itself (a binary
 * guaranteed to exist wherever this test suite runs).
 */

const FIXTURE_ENTRIES: readonly KnownAgentCli[] = [
	{
		name: "claude",
		binary: "claude",
		vendor: "anthropic",
		tiers: ["deep-reasoner", "coder", "reviewer"],
		commandTemplate: "claude {brief} {out}",
	},
	{
		name: "codex",
		binary: "codex",
		vendor: "openai",
		tiers: ["deep-reasoner", "coder", "reviewer"],
		commandTemplate: "codex {brief} {out}",
	},
	{ name: "grok", binary: "grok", vendor: "xai", tiers: ["coder", "reviewer"], commandTemplate: "grok {brief} {out}" },
];

describe("detectAgentClis", () => {
	it("omits an entry whose binary is not found on PATH", async () => {
		const findBinary = vi.fn(async (binary: string) => (binary === "claude" ? "/usr/local/bin/claude" : null));
		const spawnVersion = vi.fn(async () => "claude 1.0.0");

		const detected = await detectAgentClis({ entries: FIXTURE_ENTRIES, findBinary, spawnVersion });

		expect(detected).toHaveLength(1);
		expect(detected[0]).toMatchObject({ name: "claude", path: "/usr/local/bin/claude", version: "claude 1.0.0" });
		expect(findBinary).toHaveBeenCalledTimes(3);
		expect(spawnVersion).toHaveBeenCalledTimes(1);
	});

	it("includes a found binary with version: null when the version probe fails/times out", async () => {
		const findBinary = vi.fn(async () => "/usr/local/bin/codex");
		const spawnVersion = vi.fn(async () => null);

		const detected = await detectAgentClis({
			entries: [FIXTURE_ENTRIES[1] as KnownAgentCli],
			findBinary,
			spawnVersion,
		});

		expect(detected).toEqual([
			{
				name: "codex",
				binary: "codex",
				vendor: "openai",
				tiers: ["deep-reasoner", "coder", "reviewer"],
				commandTemplate: "codex {brief} {out}",
				path: "/usr/local/bin/codex",
				version: null,
			},
		]);
	});

	it("returns an empty array when nothing on the known list is found", async () => {
		const findBinary = vi.fn(async () => null);
		const spawnVersion = vi.fn(async () => "should never be called");

		const detected = await detectAgentClis({ entries: FIXTURE_ENTRIES, findBinary, spawnVersion });

		expect(detected).toEqual([]);
		expect(spawnVersion).not.toHaveBeenCalled();
	});

	it("preserves KNOWN_AGENT_CLIS field ordering (detection order) in the result", async () => {
		const findBinary = vi.fn(async () => "/bin/found");
		const spawnVersion = vi.fn(async () => "v1");

		const detected = await detectAgentClis({ entries: FIXTURE_ENTRIES, findBinary, spawnVersion });

		expect(detected.map((cli) => cli.name)).toEqual(["claude", "codex", "grok"]);
	});

	it("passes the configured timeoutMs through to the version probe", async () => {
		const findBinary = vi.fn(async () => "/bin/codex");
		const spawnVersion = vi.fn(async (_binary: string, _args: string[], options: { timeoutMs: number }) => {
			expect(options.timeoutMs).toBe(500);
			return "v1";
		});

		await detectAgentClis({ entries: [FIXTURE_ENTRIES[1] as KnownAgentCli], findBinary, spawnVersion, timeoutMs: 500 });

		expect(spawnVersion).toHaveBeenCalledTimes(1);
	});

	it("security: spawns the version probe against findBinary's resolved absolute path, never the bare entry.binary name", async () => {
		// Even though findOnPath itself only ever resolves absolute PATH components (see its
		// own doc comment), handing spawn() a bare command name would still trigger the OS/
		// Node's own independent binary resolution (which can consult cwd on some platforms) --
		// this is the second, independent layer of defense against ever executing a same-named
		// file from an untrusted checkout.
		const findBinary = vi.fn(async (binary: string) => `/opt/agents/${binary}/current/${binary}`);
		const spawnVersion = vi.fn(async (resolvedPath: string) => `${resolvedPath} says hi`);

		const detected = await detectAgentClis({ entries: FIXTURE_ENTRIES, findBinary, spawnVersion });

		expect(detected).toHaveLength(FIXTURE_ENTRIES.length);
		for (const entry of FIXTURE_ENTRIES) {
			const resolvedPath = `/opt/agents/${entry.binary}/current/${entry.binary}`;
			expect(spawnVersion).toHaveBeenCalledWith(resolvedPath, ["--version"], expect.anything());
			// Never called with the bare binary name as the first argument.
			expect(spawnVersion).not.toHaveBeenCalledWith(entry.binary, expect.anything(), expect.anything());
			const match = detected.find((cli) => cli.name === entry.name);
			expect(match?.version).toBe(`${resolvedPath} says hi`);
		}
	});
});

describe("findOnPath (real PATH smoke test)", () => {
	// The one deliberately real-filesystem test in this file: `node` (the binary running this
	// test itself, via process.execPath) is guaranteed to exist on PATH wherever this suite runs.
	it("finds the real node binary via process.env.PATH", async () => {
		const found = await findOnPath("node");
		expect(found).not.toBeNull();
		expect(found).toMatch(/node(\.exe)?$/);
	});

	it("returns null for a binary that plausibly does not exist", async () => {
		const found = await findOnPath("this-binary-does-not-exist-xyz-gatekeeper-detect-test");
		expect(found).toBeNull();
	});
});

describe("findOnPath: real-filesystem edge cases", () => {
	let tmp: string;

	afterEach(async () => {
		if (tmp) {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	async function makeExecutable(filePath: string): Promise<void> {
		await writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8");
		await chmod(filePath, 0o755);
	}

	it("skips a PATH directory that merely has an executable-permission subdirectory shadowing the binary name (directory != regular file)", async () => {
		tmp = await mkdtemp(path.join(tmpdir(), "gatekeeper-detect-shadow-"));
		const shadowDir = path.join(tmp, "shadow");
		const realDir = path.join(tmp, "real");
		// A directory literally named "codex" -- executable (search) permission by default,
		// which access(X_OK) alone cannot distinguish from a real executable file.
		await mkdir(path.join(shadowDir, "codex"), { recursive: true });
		await mkdir(realDir, { recursive: true });
		await makeExecutable(path.join(realDir, "codex"));

		const found = await findOnPath("codex", { PATH: [shadowDir, realDir].join(path.delimiter) });

		expect(found).toBe(path.join(realDir, "codex"));
	});

	it("security: skips an empty PATH component (leading/trailing/doubled `:`) instead of resolving it against cwd -- a same-named file sitting in the working directory (e.g. committed into an untrusted PR checkout) must never be picked up", async () => {
		// Deliberately *not* using a tmp dir for the shadow file: the whole point is to prove
		// the empty component is never resolved against the real process.cwd() at all, so the
		// shadow file has to actually live there (cleaned up in `finally`, distinctive name to
		// avoid any collision).
		const shadowName = `gatekeeper-detect-cwd-shadow-${process.pid}-${Date.now()}`;
		const shadowPath = path.join(process.cwd(), shadowName);
		await makeExecutable(shadowPath);
		try {
			// PATH=":/nonexistent-dir-xyz" -- an empty leading component plus one real-looking
			// (but absent) absolute directory. POSIX would resolve the empty component to cwd
			// and find the shadow file there; this module must not.
			const found = await findOnPath(shadowName, { PATH: ["", "/nonexistent-dir-xyz"].join(path.delimiter) });
			expect(found).toBeNull();
		} finally {
			await rm(shadowPath, { force: true });
		}
	});

	it("security: skips a relative PATH component instead of resolving it against cwd -- a same-named file under a relative PATH entry must never be picked up", async () => {
		tmp = await mkdtemp(path.join(tmpdir(), "gatekeeper-detect-relseg-"));
		await mkdir(path.join(tmp, "bin"), { recursive: true });
		await makeExecutable(path.join(tmp, "bin", "mytool"));

		const originalCwd = process.cwd();
		process.chdir(tmp);
		try {
			// PATH="./bin" -- a relative component. The matching file genuinely exists at
			// cwd/bin/mytool (proving this isn't null merely because nothing was there), but a
			// relative PATH component must still never be resolved/probed.
			const found = await findOnPath("mytool", { PATH: "./bin" });
			expect(found).toBeNull();
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("still finds a real match via an absolute PATH component even when an earlier relative/empty component would have shadowed it", async () => {
		tmp = await mkdtemp(path.join(tmpdir(), "gatekeeper-detect-abs-"));
		await makeExecutable(path.join(tmp, "mytool"));

		const found = await findOnPath("mytool", { PATH: ["", "./bin", tmp].join(path.delimiter) });

		expect(found).toBe(path.join(tmp, "mytool"));
		expect(path.isAbsolute(found as string)).toBe(true);
	});
});

describe("defaultSpawnVersion: process-group timeout kill", () => {
	let tmp: string;

	afterEach(async () => {
		if (tmp) {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	function isAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	// POSIX-only: this exercises detached: true + negative-pid process-group signalling
	// (killVersionProbeGroup), which has no equivalent on Windows -- see its doc comment.
	it.skipIf(process.platform === "win32")(
		"kills a real grandchild process (spawned by the --version probe) when the probe times out, not just the immediate child",
		async () => {
			tmp = await mkdtemp(path.join(tmpdir(), "gatekeeper-detect-spawnversion-"));
			const pidFilePath = path.join(tmp, "grandchild.pid");
			// Shape: --version probe (this defaultSpawnVersion call) -> wrapper (plain node process,
			// no signal handler) -> grandchild (a *separate* OS process the wrapper spawns and never
			// waits on). A plain `child.kill()` on the wrapper alone would never reach the
			// grandchild -- only a process-group-wide signal does (see killVersionProbeGroup).
			const wrapperScript =
				"const { spawn } = require('child_process');" +
				"const fs = require('fs');" +
				"const grandchild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);'], { stdio: 'ignore' });" +
				"fs.writeFileSync(process.argv[1], String(grandchild.pid));" +
				"setTimeout(()=>{}, 60000);"; // keep the wrapper itself alive well past the probe's timeout

			const result = await defaultSpawnVersion(NODE, ["-e", wrapperScript, pidFilePath], {
				env: process.env,
				timeoutMs: 300,
			});

			expect(result).toBeNull();

			const grandchildPid = Number((await readFile(pidFilePath, "utf8")).trim());
			expect(Number.isInteger(grandchildPid)).toBe(true);

			// SIGKILL (unlike SIGTERM) cannot be caught/ignored, so the group-wide kill should reap
			// the grandchild almost immediately -- poll with a short, bounded ceiling so a real
			// regression (immediate-child-only kill leaving the grandchild running) fails the test
			// instead of hanging the suite.
			const deadline = Date.now() + 3_000;
			while (isAlive(grandchildPid) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(isAlive(grandchildPid)).toBe(false);
		},
		10_000,
	);
});
