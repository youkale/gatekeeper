import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * B8: `upsertRepo` (the load-modify-save round trip `gatekeeper adopt`
 * calls, see src/config/repos.ts) failing *after* the controls-index upsert
 * already succeeded must not be a bare rejection -- `adopt` catches it,
 * reports exit 2, and leaves the pre-existing roster untouched (the
 * controls-index entry written just before is harmless/idempotent; a rerun
 * of `adopt` finishes the job once the underlying problem is fixed).
 *
 * A deterministic, portable repro (no chmod/permission games, which
 * root-in-a-CI-container silently bypasses -- see the identical rationale in
 * tests/discover-realpath-failure.test.ts and tests/adopt.test.ts's B4 case)
 * requires injecting the failure directly at the `upsertRepo` call site
 * (not `saveRepos`: `upsertRepo` calls it as an ordinary same-module
 * function reference, which a `vi.mock` override of the *exported*
 * `saveRepos` binding does not intercept), hence the module-level
 * `vi.mock` below -- scoped to this file only.
 */

const state = vi.hoisted(() => ({ shouldFail: false }));

vi.mock("../src/config/repos.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/config/repos.js")>();
	return {
		...actual,
		upsertRepo: vi.fn(async (registryDir: string, entry: Parameters<typeof actual.upsertRepo>[1]) => {
			if (state.shouldFail) {
				throw new Error("simulated repos.yaml write failure (e.g. ENOSPC / EACCES on the registry checkout)");
			}
			return actual.upsertRepo(registryDir, entry);
		}),
	};
});

const { runAdopt } = await import("../src/commands/adopt.js");
const { loadRepos, saveRepos } = await import("../src/config/repos.js");

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

let tmpDir: string | undefined;

afterEach(async () => {
	state.shouldFail = false;
	if (tmpDir) {
		await rm(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});

async function makeControlRepo(base: string): Promise<{ controlRoot: string; registryDir: string }> {
	const controlRoot = path.join(base, "control");
	const registryDir = path.join(controlRoot, "governance", "registry");
	await mkdir(path.join(registryDir, "contracts"), { recursive: true });
	await writeFile(
		path.join(registryDir, "policy.yaml"),
		"apiVersion: gatekeeper/v1\nlanes: {}\nlevels:\n  strict:\n    enforcement: block\n    require: { m: 1, lanes: [human] }\n",
		"utf8",
	);
	return { controlRoot, registryDir };
}

async function makeGitRepo(base: string, name: string): Promise<string> {
	const repoDir = path.join(base, name);
	await mkdir(repoDir, { recursive: true });
	git(repoDir, ["init", "-q"]);
	git(repoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	git(repoDir, ["config", "user.email", "adopt@example.com"]);
	git(repoDir, ["config", "user.name", "Adopt Bot"]);
	git(repoDir, ["remote", "add", "origin", "git@github.com:acme/app.git"]);
	await writeFile(path.join(repoDir, "README.md"), "hello\n", "utf8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-q", "-m", "init"]);
	return repoDir;
}

describe("gatekeeper adopt: controls-index-succeeds-but-roster-write-fails (B8)", () => {
	it("exits 2, and the roster is left exactly as it was before this run", async () => {
		tmpDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-adopt-reposwrite-failure-"));
		const base = tmpDir;
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const repoDir = await makeGitRepo(base, "repo");
		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		// Pre-existing roster state: one already-adopted, unrelated repo. This
		// must survive the failed run byte-for-byte.
		await saveRepos(registryDir, [
			{
				repo: "acme/already-adopted",
				path: "/some/other/checkout",
				ci: "none",
				adopted_at: "2026-01-01T00:00:00.000Z",
			},
		]);
		const rosterBefore = await readFile(path.join(registryDir, "repos.yaml"), "utf8");

		state.shouldFail = true;
		let stderrOutput = "";
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
			stderrOutput += String(chunk);
			return true;
		}) as typeof process.stderr.write);
		let exitCode: number;
		try {
			exitCode = await runAdopt({ control: controlRoot }, repoDir, {
				now: () => "2026-07-20T00:00:00.000Z",
				env,
			});
		} finally {
			stderrSpy.mockRestore();
		}

		expect(exitCode).toBe(2);
		expect(stderrOutput).toContain("could not write");
		expect(stderrOutput).toContain("repos.yaml");

		const rosterAfter = await readFile(path.join(registryDir, "repos.yaml"), "utf8");
		expect(rosterAfter).toBe(rosterBefore);
		const reposAfter = await loadRepos(registryDir);
		expect(reposAfter).toEqual([
			{
				repo: "acme/already-adopted",
				path: "/some/other/checkout",
				ci: "none",
				adopted_at: "2026-01-01T00:00:00.000Z",
			},
		]);
	});

	it("succeeds normally once the underlying problem is gone (idempotent controls-index re-upsert, roster finally written)", async () => {
		tmpDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-adopt-reposwrite-recovery-"));
		const base = tmpDir;
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const repoDir = await makeGitRepo(base, "repo");
		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		state.shouldFail = true;
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const firstExitCode = await runAdopt({ control: controlRoot }, repoDir, {
			now: () => "2026-07-20T00:00:00.000Z",
			env,
		});
		expect(firstExitCode).toBe(2);

		state.shouldFail = false;
		const secondExitCode = await runAdopt({ control: controlRoot }, repoDir, {
			now: () => "2026-07-20T00:05:00.000Z",
			env,
		});

		expect(secondExitCode).toBe(0);
		const repos = await loadRepos(registryDir);
		expect(repos.map((entry) => entry.repo)).toEqual(["acme/app"]);
	});
});
