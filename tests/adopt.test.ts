import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type AdoptDependencies, runAdopt as runAdoptImpl } from "../src/commands/adopt.js";
import { loadControlsIndex, locateOwningControl } from "../src/config/controls.js";
import { loadRepos, pathsOverlap } from "../src/config/repos.js";

const repoRootDir = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(repoRootDir, "src/cli.ts");
const tsxLoader = path.join(repoRootDir, "node_modules/tsx/dist/loader.mjs");

// `gatekeeper adopt` is zero-touch on the target repo, but it does write
// host-machine state: this machine's user-level controls index (see
// src/config/controls.ts). Every test in this file gets its own throwaway
// config dir so none of them ever read or write the real
// ~/.config/gatekeeper/controls.yaml -- see the identical pattern in
// tests/init-control.test.ts and tests/provision.test.ts.
let controlsConfigDir: string | undefined;

afterEach(() => {
	if (controlsConfigDir) {
		rmSync(controlsConfigDir, { recursive: true, force: true });
		controlsConfigDir = undefined;
	}
});

function makeControlsConfigDir(): string {
	controlsConfigDir = mkdtempSync(path.join(tmpdir(), "gatekeeper-adopt-configdir-"));
	return controlsConfigDir;
}

async function runAdopt(
	options: Parameters<typeof runAdoptImpl>[0],
	cwd: string,
	dependencies: AdoptDependencies = {},
): Promise<number> {
	const configDir = controlsConfigDir ?? makeControlsConfigDir();
	return runAdoptImpl(options, cwd, { ...dependencies, env: dependencies.env ?? { GATEKEEPER_CONFIG_DIR: configDir } });
}

interface RunResult {
	status: number;
	stdout: string;
	stderr: string;
}

function runCli(cwd: string, args: string[]): RunResult {
	const configDir = controlsConfigDir ?? makeControlsConfigDir();
	const result = spawnSync(process.execPath, ["--import", tsxLoader, cliPath, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GATEKEEPER_CONFIG_DIR: configDir },
	});
	return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await readFile(candidate);
		return true;
	} catch {
		return false;
	}
}

let tmpDir: string | undefined;

async function makeTmpDir(prefix: string): Promise<string> {
	tmpDir = await mkdtemp(path.join(tmpdir(), prefix));
	return tmpDir;
}

afterEach(async () => {
	if (tmpDir) {
		await rm(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});

async function writeRegistryAt(registryDir: string): Promise<void> {
	await mkdir(path.join(registryDir, "contracts"), { recursive: true });
	await writeFile(
		path.join(registryDir, "policy.yaml"),
		[
			"apiVersion: gatekeeper/v1",
			"lanes: {}",
			"levels:",
			"  strict:",
			"    enforcement: block",
			"    require: { m: 1, lanes: [human] }",
			"",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		path.join(registryDir, "contracts", "sample.yaml"),
		[
			"apiVersion: gatekeeper/v1",
			"name: sample",
			"level: strict",
			"authority:",
			"  repo: acme/app",
			"  paths: [src/**]",
			"",
		].join("\n"),
		"utf8",
	);
}

/** A control/hub repo whose registry lives at the first candidate location (<control>/governance/registry) unless overridden. */
async function makeControlRepo(
	base: string,
	name = "control",
	registrySubpath = "governance/registry",
): Promise<{ controlRoot: string; registryDir: string }> {
	const controlRoot = path.join(base, name);
	await mkdir(controlRoot, { recursive: true });
	const registryDir = path.resolve(controlRoot, registrySubpath);
	await writeRegistryAt(registryDir);
	return { controlRoot, registryDir };
}

async function makeGitRepo(base: string, name: string, remote = "git@github.com:acme/app.git"): Promise<string> {
	const repoDir = path.join(base, name);
	await mkdir(repoDir, { recursive: true });
	git(repoDir, ["init", "-q"]);
	git(repoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	git(repoDir, ["config", "user.email", "adopt@example.com"]);
	git(repoDir, ["config", "user.name", "Adopt Bot"]);
	git(repoDir, ["remote", "add", "origin", remote]);
	await writeFile(path.join(repoDir, "README.md"), "hello\n", "utf8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-q", "-m", "init"]);
	return repoDir;
}

async function gitStatusPorcelain(repoDir: string): Promise<string> {
	return git(repoDir, ["status", "--porcelain"]);
}

describe("gatekeeper adopt: preconditions (nothing written on failure)", () => {
	it("exits 2 outside a Git working tree", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-nongit-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const nonGitDir = path.join(base, "not-a-repo");
		await mkdir(nonGitDir, { recursive: true });

		const exitCode = await runAdopt({ control: controlRoot }, nonGitDir);

		expect(exitCode).toBe(2);
		expect(await pathExists(path.join(registryDir, "repos.yaml"))).toBe(false);
	});

	it("exits 2 with the three tried candidates when no registry can be located under --control", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-noregistry-");
		const controlRoot = path.join(base, "control");
		await mkdir(controlRoot, { recursive: true });
		const repoDir = await makeGitRepo(base, "repo");

		const exitCode = await runAdopt({ control: controlRoot }, repoDir);

		expect(exitCode).toBe(2);
	});

	it("prints the three candidate locations it tried, in order, to stderr", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-candidates-");
		const controlRoot = path.join(base, "control");
		await mkdir(controlRoot, { recursive: true });
		const repoDir = await makeGitRepo(base, "repo");

		const result = runCli(repoDir, ["adopt", "--control", controlRoot]);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain(path.join(controlRoot, "governance", "registry"));
		expect(result.stderr).toContain(path.join(controlRoot, "registry"));
		expect(result.stderr).toContain(controlRoot);
	});

	it("locates the registry at <control>/registry when governance/registry is absent", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-secondcandidate-");
		const { controlRoot, registryDir } = await makeControlRepo(base, "control", "registry");
		const repoDir = await makeGitRepo(base, "repo");

		const exitCode = await runAdopt({ control: controlRoot }, repoDir, { now: () => "2026-01-01T00:00:00.000Z" });

		expect(exitCode).toBe(0);
		expect(await pathExists(path.join(registryDir, "repos.yaml"))).toBe(true);
	});

	it("locates the registry at the control repo root itself as a last resort", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-thirdcandidate-");
		const { controlRoot, registryDir } = await makeControlRepo(base, "control", ".");
		const repoDir = await makeGitRepo(base, "repo");

		const exitCode = await runAdopt({ control: controlRoot }, repoDir, { now: () => "2026-01-01T00:00:00.000Z" });

		expect(exitCode).toBe(0);
		expect(registryDir).toBe(controlRoot);
		expect(await pathExists(path.join(registryDir, "repos.yaml"))).toBe(true);
	});

	it("exits 2 and writes nothing when the located registry fails validation", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-badreg-");
		const controlRoot = path.join(base, "control", "governance", "registry");
		await mkdir(controlRoot, { recursive: true });
		await writeFile(
			path.join(controlRoot, "policy.yaml"),
			"apiVersion: gatekeeper/v1\nlevels: not-an-object\n",
			"utf8",
		);
		const repoDir = await makeGitRepo(base, "repo");

		const exitCode = await runAdopt({ control: path.join(base, "control") }, repoDir);

		expect(exitCode).toBe(2);
	});

	it("exits 2 when no repo identity can be resolved (no origin remote, no --repo)", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-norepo-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const repoDir = path.join(base, "repo");
		await mkdir(repoDir, { recursive: true });
		git(repoDir, ["init", "-q"]);
		git(repoDir, ["config", "user.email", "adopt@example.com"]);
		git(repoDir, ["config", "user.name", "Adopt Bot"]);

		const exitCode = await runAdopt({ control: controlRoot }, repoDir);

		expect(exitCode).toBe(2);
		expect(await pathExists(path.join(registryDir, "repos.yaml"))).toBe(false);
	});
});

describe("gatekeeper adopt: overlap validation (control vs target)", () => {
	it("pathsOverlap: identical paths overlap", () => {
		expect(pathsOverlap("/a/b", "/a/b")).toBe(true);
	});

	it("pathsOverlap: a nested target inside control overlaps", () => {
		expect(pathsOverlap("/a/b", "/a/b/c")).toBe(true);
	});

	it("pathsOverlap: a control nested inside the target also overlaps (order-independent)", () => {
		expect(pathsOverlap("/a/b/c", "/a/b")).toBe(true);
	});

	it("pathsOverlap: sibling paths with a shared string prefix do not overlap (boundary-aware)", () => {
		expect(pathsOverlap("/a/b", "/a/bc")).toBe(false);
		expect(pathsOverlap("/a/bc", "/a/b")).toBe(false);
	});

	it("pathsOverlap: unrelated paths do not overlap", () => {
		expect(pathsOverlap("/a/b", "/c/d")).toBe(false);
	});

	it("exits 2 when the target repo is identical to the control repo", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-overlap-identical-");
		const { controlRoot } = await makeControlRepo(base);
		git(controlRoot, ["init", "-q"]);
		git(controlRoot, ["remote", "add", "origin", "git@github.com:acme/control.git"]);

		const result = runCli(controlRoot, ["adopt", "--control", controlRoot]);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("overlaps with control repo");
		expect(result.stderr).toContain("self-gate");
	});

	it("exits 2 when the target repo is nested inside the control repo", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-overlap-nested-in-control-");
		const { controlRoot } = await makeControlRepo(base);
		const nestedTarget = path.join(controlRoot, "vendor", "nested-repo");
		await mkdir(nestedTarget, { recursive: true });
		git(nestedTarget, ["init", "-q"]);
		git(nestedTarget, ["remote", "add", "origin", "git@github.com:acme/nested.git"]);

		const exitCode = await runAdopt({ control: controlRoot }, nestedTarget);

		expect(exitCode).toBe(2);
	});

	it("exits 2 when the control repo is nested inside the target repo", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-overlap-control-in-target-");
		const targetDir = path.join(base, "outer-repo");
		await mkdir(targetDir, { recursive: true });
		git(targetDir, ["init", "-q"]);
		git(targetDir, ["remote", "add", "origin", "git@github.com:acme/outer.git"]);
		const { controlRoot } = await makeControlRepo(targetDir, "nested-control");

		const exitCode = await runAdopt({ control: controlRoot }, targetDir);

		expect(exitCode).toBe(2);
	});

	it("succeeds for an unrelated, non-overlapping control/target pair sharing a string prefix", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-overlap-prefix-ok-");
		const { controlRoot } = await makeControlRepo(base, "control-hub");
		const repoDir = await makeGitRepo(base, "control-hub-app");

		const exitCode = await runAdopt({ control: controlRoot }, repoDir, { now: () => "2026-01-01T00:00:00.000Z" });

		expect(exitCode).toBe(0);
	});
});

describe("gatekeeper adopt: zero-touch on the target repo", () => {
	it("writes no .gatekeeper.yml and leaves the target repo's git status clean", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-zerotouch-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot } = await makeControlRepo(base);

		const exitCode = await runAdopt({ control: controlRoot }, repoDir, { now: () => "2026-01-01T00:00:00.000Z" });

		expect(exitCode).toBe(0);
		expect(await pathExists(path.join(repoDir, ".gatekeeper.yml"))).toBe(false);
		expect(await gitStatusPorcelain(repoDir)).toBe("");
	});

	it("--repo does not require or write anything into the target repo", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-zerotouch-repo-flag-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot } = await makeControlRepo(base);

		const exitCode = await runAdopt({ control: controlRoot, repo: "acme/other" }, repoDir, {
			now: () => "2026-01-01T00:00:00.000Z",
		});

		expect(exitCode).toBe(0);
		expect(await pathExists(path.join(repoDir, ".gatekeeper.yml"))).toBe(false);
		expect(await gitStatusPorcelain(repoDir)).toBe("");
	});
});

describe("gatekeeper adopt: registration (repos.yaml + controls index)", () => {
	it("upserts repos.yaml and registers the control in the controls index", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-write-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const configDir = makeControlsConfigDir();

		const exitCode = await runAdopt({ control: controlRoot }, repoDir, {
			now: () => "2026-01-01T00:00:00.000Z",
			env: { GATEKEEPER_CONFIG_DIR: configDir },
		});
		expect(exitCode).toBe(0);

		const repos = await loadRepos(registryDir);
		// git rev-parse --show-toplevel resolves symlinks (e.g. macOS /var -> /private/var),
		// so compare against the realpath of the tmp checkout, not its raw mkdtemp path.
		expect(repos).toEqual([
			{ repo: "acme/app", path: await realpath(repoDir), ci: "none", adopted_at: "2026-01-01T00:00:00.000Z" },
		]);

		const controls = await loadControlsIndex({ GATEKEEPER_CONFIG_DIR: configDir });
		expect(controls).toEqual([
			{
				control: await realpath(controlRoot),
				registry: await realpath(registryDir),
				registered_at: "2026-01-01T00:00:00.000Z",
			},
		]);
	});

	it("records an explicit --repo override in repos.yaml", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-repo-override-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot, registryDir } = await makeControlRepo(base);

		const exitCode = await runAdopt({ control: controlRoot, repo: "acme/other" }, repoDir, {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		expect(exitCode).toBe(0);

		const repos = await loadRepos(registryDir);
		expect(repos.map((entry) => entry.repo)).toEqual(["acme/other"]);
	});

	it("detects ci: github / gitlab / none from the target repo's own files", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-ci-detect-");
		const { controlRoot, registryDir } = await makeControlRepo(base);

		const githubRepo = await makeGitRepo(base, "github-repo");
		await mkdir(path.join(githubRepo, ".github", "workflows"), { recursive: true });
		await writeFile(path.join(githubRepo, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
		await runAdopt({ control: controlRoot, repo: "acme/gh" }, githubRepo, { now: () => "2026-01-01T00:00:00.000Z" });

		const gitlabRepo = await makeGitRepo(base, "gitlab-repo");
		await writeFile(path.join(gitlabRepo, ".gitlab-ci.yml"), "stages: [test]\n", "utf8");
		await runAdopt({ control: controlRoot, repo: "acme/gl" }, gitlabRepo, { now: () => "2026-01-01T00:00:00.000Z" });

		const repos = await loadRepos(registryDir);
		expect(repos.find((entry) => entry.repo === "acme/gh")?.ci).toBe("github");
		expect(repos.find((entry) => entry.repo === "acme/gl")?.ci).toBe("gitlab");
	});

	it("adopts a repo given as a positional path, without cd'ing into it", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-positional-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const repoDir = await makeGitRepo(base, "repo");

		const exitCode = await runAdopt({ control: controlRoot, path: "repo" }, base, {
			now: () => "2026-01-01T00:00:00.000Z",
		});

		expect(exitCode).toBe(0);
		expect(await pathExists(path.join(repoDir, ".gatekeeper.yml"))).toBe(false);
		expect(await loadRepos(registryDir)).toHaveLength(1);
	});

	it("adopted repo makes a bare `gatekeeper check` work with zero registry flags (reverse discovery via the controls index)", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-e2e-check-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot } = await makeControlRepo(base);

		const adopted = runCli(repoDir, ["adopt", "--control", controlRoot]);
		expect(adopted.status).toBe(0);
		expect(await pathExists(path.join(repoDir, ".gatekeeper.yml"))).toBe(false);

		const checked = runCli(repoDir, ["check", "--working-tree", "--json"]);
		expect(checked.status).toBe(0);
		const verdict = JSON.parse(checked.stdout);
		expect(verdict.repo).toBe("acme/app");
		expect(verdict.degraded).toBeUndefined();
	});
});

describe("gatekeeper adopt: idempotency (rerun for the same repo)", () => {
	it("updates the existing repos.yaml entry in place instead of duplicating it", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-idempotent-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot, registryDir } = await makeControlRepo(base);

		await runAdopt({ control: controlRoot }, repoDir, { now: () => "2026-01-01T00:00:00.000Z" });
		await runAdopt({ control: controlRoot }, repoDir, { now: () => "2026-06-01T00:00:00.000Z" });

		const repos = await loadRepos(registryDir);
		expect(repos).toHaveLength(1);
		expect(repos[0]?.adopted_at).toBe("2026-06-01T00:00:00.000Z");
	});

	it("updates the existing controls index entry in place instead of duplicating it", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-idempotent-controls-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const configDir = makeControlsConfigDir();
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		await runAdopt({ control: controlRoot }, repoDir, { now: () => "2026-01-01T00:00:00.000Z", env });
		await runAdopt({ control: controlRoot }, repoDir, { now: () => "2026-06-01T00:00:00.000Z", env });

		const controls = await loadControlsIndex(env);
		expect(controls).toHaveLength(1);
		expect(controls[0]?.registered_at).toBe("2026-06-01T00:00:00.000Z");
		expect(controls[0]?.registry).toBe(await realpath(registryDir));
	});

	it("re-adopting the same repo from a moved checkout updates its path", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-moved-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const originalRepoDir = await makeGitRepo(base, "repo-original");
		await runAdopt({ control: controlRoot, repo: "acme/app" }, originalRepoDir, {
			now: () => "2026-01-01T00:00:00.000Z",
		});

		const movedRepoDir = await makeGitRepo(base, "repo-moved");
		await runAdopt({ control: controlRoot, repo: "acme/app" }, movedRepoDir, { now: () => "2026-06-01T00:00:00.000Z" });

		const repos = await loadRepos(registryDir);
		expect(repos).toHaveLength(1);
		expect(repos[0]?.path).toBe(await realpath(movedRepoDir));
	});

	it("re-adopting the same checkout with a corrected --repo identity replaces the stale row instead of leaving two entries for the same path (B3)", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-repo-correction-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const configDir = makeControlsConfigDir();
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		await runAdopt({ control: controlRoot, repo: "acme/wrong-name" }, repoDir, {
			now: () => "2026-01-01T00:00:00.000Z",
			env,
		});
		await runAdopt({ control: controlRoot, repo: "acme/right-name" }, repoDir, {
			now: () => "2026-06-01T00:00:00.000Z",
			env,
		});

		const repos = await loadRepos(registryDir);
		// Exactly one row for this checkout's path, under the corrected identity
		// -- not two (the stale "acme/wrong-name" row must be gone, not merely
		// shadowed), since locateOwningControl (src/config/controls.ts) matches
		// repos.yaml by `path` and would otherwise silently resolve whichever
		// row happens to sort first, which can be the abandoned identity.
		expect(repos).toHaveLength(1);
		expect(repos[0]?.repo).toBe("acme/right-name");
		const repoRealPath = await realpath(repoDir);
		expect(repos[0]?.path).toBe(repoRealPath);

		// Reverse discovery from inside the repo resolves the corrected identity.
		const result = await locateOwningControl(repoRealPath, env);
		expect(result.match?.repo).toBe("acme/right-name");
	});
});

describe("gatekeeper adopt: two concurrent, interleaved adopts against the same control both survive (C3)", () => {
	it("adopting two different repos at once leaves both registered in repos.yaml and the controls index", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-concurrent-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const repoADir = await makeGitRepo(base, "repo-a", "git@github.com:acme/repo-a.git");
		const repoBDir = await makeGitRepo(base, "repo-b", "git@github.com:acme/repo-b.git");
		const configDir = makeControlsConfigDir();
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		// Fired via Promise.all (not one at a time): each `runAdopt` call's own
		// git-subprocess + file-IO await points give the event loop plenty of
		// opportunities to interleave the two runs' controls-index and
		// repos.yaml read-modify-write round trips. Without the same-directory
		// lock files src/config/filelock.ts adds to upsertControl/upsertRepo,
		// one of the two adopts could silently lose the other's update.
		const [exitCodeA, exitCodeB] = await Promise.all([
			runAdopt({ control: controlRoot, repo: "acme/repo-a" }, repoADir, {
				now: () => "2026-07-20T00:00:00.000Z",
				env,
			}),
			runAdopt({ control: controlRoot, repo: "acme/repo-b" }, repoBDir, {
				now: () => "2026-07-20T00:00:01.000Z",
				env,
			}),
		]);

		expect(exitCodeA).toBe(0);
		expect(exitCodeB).toBe(0);

		const repos = await loadRepos(registryDir);
		expect(repos.map((entry) => entry.repo).sort()).toEqual(["acme/repo-a", "acme/repo-b"]);

		// Both adopts registered the *same* control (one entry, not lost/split).
		const controls = await loadControlsIndex(env);
		expect(controls).toHaveLength(1);
		expect(controls[0]?.control).toBe(await realpath(controlRoot));
	});
});

describe("gatekeeper adopt: repos.yaml `path` is realpath-normalized (grok nb#2)", () => {
	it("stores the realpath of a symlinked target repo, the same value the overlap check uses -- not the symlink path", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-symlink-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const actualRepoDir = await makeGitRepo(base, "actual-repo");
		const symlinkedRepoDir = path.join(base, "symlinked-repo");
		await symlink(actualRepoDir, symlinkedRepoDir, "dir");

		const exitCode = await runAdopt({ control: controlRoot, path: "symlinked-repo" }, base, {
			now: () => "2026-01-01T00:00:00.000Z",
		});

		expect(exitCode).toBe(0);
		const repos = await loadRepos(registryDir);
		const expectedRealPath = await realpath(actualRepoDir);
		expect(repos[0]?.path).toBe(expectedRealPath);
		expect(repos[0]?.path).not.toBe(symlinkedRepoDir);
	});
});

describe("gatekeeper adopt: controls-index write failure leaves no half-registered repo (B4)", () => {
	it("exits 2 and never touches repos.yaml when the controls index cannot be written", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-controlsindex-failure-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot, registryDir } = await makeControlRepo(base);

		// A regular *file* sitting where the controls-config directory needs to
		// be created makes `mkdir(..., { recursive: true })` inside
		// saveControlsIndex fail with ENOTDIR -- deterministic and portable
		// (unlike chmod-based permission games, which root-in-a-CI-container
		// silently bypasses).
		const blockedConfigDir = path.join(base, "blocked-config-dir");
		await writeFile(blockedConfigDir, "not a directory\n", "utf8");
		const env = { GATEKEEPER_CONFIG_DIR: blockedConfigDir };

		let stderrOutput = "";
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
			stderrOutput += String(chunk);
			return true;
		}) as typeof process.stderr.write);
		let exitCode: number;
		try {
			exitCode = await runAdopt({ control: controlRoot }, repoDir, { now: () => "2026-01-01T00:00:00.000Z", env });
		} finally {
			stderrSpy.mockRestore();
		}

		expect(exitCode).toBe(2);
		expect(stderrOutput).toContain("could not register control");
		// The ordering fix (controls index first, repos.yaml second): a failed
		// controls-index write must leave repos.yaml completely untouched, not
		// merely "not yet containing this repo" -- the file must not exist at
		// all, since makeControlRepo never wrote one and nothing before this
		// point does either.
		expect(await pathExists(path.join(registryDir, "repos.yaml"))).toBe(false);
		expect(await loadRepos(registryDir)).toEqual([]);
	});
});
