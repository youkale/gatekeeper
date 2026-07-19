import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { type AdoptDependencies, runAdopt as runAdoptImpl } from "../src/commands/adopt.js";
import { runProvision } from "../src/commands/provision.js";
import { upsertControl } from "../src/config/controls.js";
import { saveRepos } from "../src/config/repos.js";

// `runAdopt` now also upserts the host-machine controls index (see
// src/config/controls.ts) -- this file's own throwaway config dir keeps that
// off the real ~/.config/gatekeeper/controls.yaml (see the identical pattern
// and rationale in tests/init-control.test.ts).
const controlsConfigDir = mkdtempSync(path.join(tmpdir(), "gatekeeper-provision-configdir-"));

afterAll(() => {
	rmSync(controlsConfigDir, { recursive: true, force: true });
});

async function runAdopt(
	options: Parameters<typeof runAdoptImpl>[0],
	cwd: string,
	dependencies: AdoptDependencies = {},
): Promise<number> {
	return runAdoptImpl(options, cwd, {
		...dependencies,
		env: dependencies.env ?? { GATEKEEPER_CONFIG_DIR: controlsConfigDir },
	});
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await stat(candidate);
		return true;
	} catch {
		return false;
	}
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
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

async function makeControlRepo(base: string, name = "control"): Promise<{ controlRoot: string; registryDir: string }> {
	const controlRoot = path.join(base, name);
	const registryDir = path.join(controlRoot, "governance", "registry");
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
	return { controlRoot, registryDir };
}

async function makeGitRepo(base: string, name: string, remote = "git@github.com:acme/app.git"): Promise<string> {
	const repoDir = path.join(base, name);
	await mkdir(repoDir, { recursive: true });
	git(repoDir, ["init", "-q"]);
	git(repoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	git(repoDir, ["config", "user.email", "provision@example.com"]);
	git(repoDir, ["config", "user.name", "Provision Bot"]);
	git(repoDir, ["remote", "add", "origin", remote]);
	await writeFile(path.join(repoDir, "README.md"), "hello\n", "utf8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-q", "-m", "init"]);
	return repoDir;
}

async function adoptGithubRepo(base: string, controlRoot: string, name: string, repo: string): Promise<string> {
	const repoDir = await makeGitRepo(base, name, `git@github.com:${repo}.git`);
	await mkdir(path.join(repoDir, ".github", "workflows"), { recursive: true });
	await writeFile(path.join(repoDir, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
	const exitCode = await runAdopt({ control: controlRoot, repo }, repoDir, { now: () => "2026-01-01T00:00:00.000Z" });
	expect(exitCode).toBe(0);
	return repoDir;
}

async function adoptGitlabRepo(base: string, controlRoot: string, name: string, repo: string): Promise<string> {
	const repoDir = await makeGitRepo(base, name, `git@gitlab.com:${repo}.git`);
	await writeFile(path.join(repoDir, ".gitlab-ci.yml"), "stages: [test]\n", "utf8");
	const exitCode = await runAdopt({ control: controlRoot, repo }, repoDir, { now: () => "2026-01-01T00:00:00.000Z" });
	expect(exitCode).toBe(0);
	return repoDir;
}

describe("gatekeeper provision: batch scaffolding", () => {
	it("applies AGENTS.md + CI (per registered ci:) + hooks to every registered repo by default", async () => {
		const base = await makeTmpDir("gatekeeper-provision-batch-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const githubRepo = await adoptGithubRepo(base, controlRoot, "gh-repo", "acme/gh-app");
		const gitlabRepo = await adoptGitlabRepo(base, controlRoot, "gl-repo", "acme/gl-app");

		const exitCode = await runProvision({ registry: registryDir }, base);

		expect(exitCode).toBe(0);
		expect(await readFile(path.join(githubRepo, "AGENTS.md"), "utf8")).toContain("<!-- gatekeeper:adopt -->");
		expect(await readFile(path.join(githubRepo, ".github", "workflows", "gatekeeper-check.yml"), "utf8")).toContain(
			"registry-path:",
		);
		expect(await pathExists(path.join(githubRepo, ".git", "hooks", "pre-push"))).toBe(true);

		expect(await readFile(path.join(gitlabRepo, "AGENTS.md"), "utf8")).toContain("<!-- gatekeeper:adopt -->");
		expect(await readFile(path.join(gitlabRepo, ".gitlab-ci.yml"), "utf8")).toContain("gatekeeper-check:");
		expect(await pathExists(path.join(gitlabRepo, ".git", "hooks", "pre-push"))).toBe(true);
	});

	it("skips CI injection for a repo registered with ci: none", async () => {
		const base = await makeTmpDir("gatekeeper-provision-noci-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const repoDir = await makeGitRepo(base, "plain-repo");
		await runAdopt({ control: controlRoot, repo: "acme/plain" }, repoDir, { now: () => "2026-01-01T00:00:00.000Z" });

		const exitCode = await runProvision({ registry: registryDir, ci: true }, base);

		expect(exitCode).toBe(0);
		expect(await pathExists(path.join(repoDir, ".gitlab-ci.yml"))).toBe(false);
		expect(await pathExists(path.join(repoDir, ".github", "workflows", "gatekeeper-check.yml"))).toBe(false);
	});
});

describe("gatekeeper provision: repo-name filter (single/multi select)", () => {
	it("limits provisioning to the given repo name(s) and warns about unknown names", async () => {
		const base = await makeTmpDir("gatekeeper-provision-select-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const repoA = await makeGitRepo(base, "repo-a", "git@github.com:acme/repo-a.git");
		await runAdopt({ control: controlRoot, repo: "acme/repo-a" }, repoA, { now: () => "2026-01-01T00:00:00.000Z" });
		const repoB = await makeGitRepo(base, "repo-b", "git@github.com:acme/repo-b.git");
		await runAdopt({ control: controlRoot, repo: "acme/repo-b" }, repoB, { now: () => "2026-01-01T00:00:00.000Z" });

		const exitCode = await runProvision(
			{ registry: registryDir, repos: ["acme/repo-a", "acme/does-not-exist"], agentsMd: true },
			base,
		);

		expect(exitCode).toBe(0);
		expect(await pathExists(path.join(repoA, "AGENTS.md"))).toBe(true);
		expect(await pathExists(path.join(repoB, "AGENTS.md"))).toBe(false);
	});
});

describe("gatekeeper provision: --dry-run", () => {
	it("writes nothing and reports what it would do", async () => {
		const base = await makeTmpDir("gatekeeper-provision-dryrun-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const repoDir = await adoptGithubRepo(base, controlRoot, "gh-repo", "acme/gh-app");

		const exitCode = await runProvision({ registry: registryDir, dryRun: true }, base);

		expect(exitCode).toBe(0);
		expect(await pathExists(path.join(repoDir, "AGENTS.md"))).toBe(false);
		expect(await pathExists(path.join(repoDir, ".github", "workflows", "gatekeeper-check.yml"))).toBe(false);
		expect(await pathExists(path.join(repoDir, ".git", "hooks", "pre-push"))).toBe(false);
	});
});

describe("gatekeeper provision: registered path no longer exists", () => {
	it("skips that repo with a warning and continues provisioning the rest (batch resilience)", async () => {
		const base = await makeTmpDir("gatekeeper-provision-missingpath-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const goodRepo = await adoptGithubRepo(base, controlRoot, "good-repo", "acme/good");

		// Register a second entry whose path was never created (simulating a
		// deleted/moved checkout) directly via saveRepos -- adopt itself always
		// requires a real git repo, so this can only happen via a stale entry.
		const { loadRepos, upsertRepoEntry } = await import("../src/config/repos.js");
		const existing = await loadRepos(registryDir);
		await saveRepos(
			registryDir,
			upsertRepoEntry(existing, {
				repo: "acme/gone",
				path: path.join(base, "does-not-exist"),
				ci: "none",
				adopted_at: "2026-01-01T00:00:00.000Z",
			}),
		);

		const exitCode = await runProvision({ registry: registryDir }, base);

		expect(exitCode).toBe(1);
		expect(await pathExists(path.join(goodRepo, "AGENTS.md"))).toBe(true);
	});
});

describe("gatekeeper provision: marker-block idempotency", () => {
	it("running provision twice does not duplicate the AGENTS.md or .gitlab-ci.yml marker blocks", async () => {
		const base = await makeTmpDir("gatekeeper-provision-idempotent-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const repoDir = await adoptGitlabRepo(base, controlRoot, "gl-repo", "acme/gl-app");

		await runProvision({ registry: registryDir }, base);
		const agentsFirst = await readFile(path.join(repoDir, "AGENTS.md"), "utf8");
		const gitlabFirst = await readFile(path.join(repoDir, ".gitlab-ci.yml"), "utf8");

		const secondExitCode = await runProvision({ registry: registryDir, force: true }, base);

		expect(secondExitCode).toBe(0);
		const agentsSecond = await readFile(path.join(repoDir, "AGENTS.md"), "utf8");
		const gitlabSecond = await readFile(path.join(repoDir, ".gitlab-ci.yml"), "utf8");
		expect(agentsSecond).toBe(agentsFirst);
		expect(gitlabSecond).toBe(gitlabFirst);
		expect((agentsSecond.match(/<!-- gatekeeper:adopt -->/g) ?? []).length).toBe(1);
		expect((gitlabSecond.match(/gatekeeper-check:/g) ?? []).length).toBe(1);
	});

	it("without --force, a second run skips an existing GitHub workflow copy (exit 1) but leaves it unchanged", async () => {
		const base = await makeTmpDir("gatekeeper-provision-github-force-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const repoDir = await adoptGithubRepo(base, controlRoot, "gh-repo", "acme/gh-app");

		await runProvision({ registry: registryDir, ci: true }, base);
		const firstContent = await readFile(path.join(repoDir, ".github", "workflows", "gatekeeper-check.yml"), "utf8");

		const secondExitCode = await runProvision({ registry: registryDir, ci: true }, base);
		expect(secondExitCode).toBe(1);
		const secondContent = await readFile(path.join(repoDir, ".github", "workflows", "gatekeeper-check.yml"), "utf8");
		expect(secondContent).toBe(firstContent);

		const forcedExitCode = await runProvision({ registry: registryDir, ci: true, force: true }, base);
		expect(forcedExitCode).toBe(0);
	});
});

describe("gatekeeper provision: pre-push hook content + fail-open semantics", () => {
	it("installs an executable fail-open hook", async () => {
		const base = await makeTmpDir("gatekeeper-provision-hooks-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const repoDir = await adoptGithubRepo(base, controlRoot, "gh-repo", "acme/gh-app");

		const exitCode = await runProvision({ registry: registryDir, hooks: true }, base);
		expect(exitCode).toBe(0);

		const hookPath = path.join(repoDir, ".git", "hooks", "pre-push");
		const content = await readFile(hookPath, "utf8");
		expect(content).toContain("#!/bin/sh");
		expect(content).toContain("gatekeeper check --base");
		expect(content).toContain("fail-open");
		const mode = (await stat(hookPath)).mode & 0o777;
		expect(mode & 0o111).not.toBe(0);
	});

	it("fail-open: exits 0 when gatekeeper is not on PATH", async () => {
		const base = await makeTmpDir("gatekeeper-provision-hook-nogatekeeper-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const repoDir = await adoptGithubRepo(base, controlRoot, "gh-repo", "acme/gh-app");
		await runProvision({ registry: registryDir, hooks: true }, base);
		const hookPath = path.join(repoDir, ".git", "hooks", "pre-push");

		const emptyBinDir = path.join(base, "empty-bin");
		await mkdir(emptyBinDir, { recursive: true });
		const result = spawnSync("sh", [hookPath], {
			cwd: repoDir,
			encoding: "utf8",
			env: { PATH: `${emptyBinDir}:/usr/bin:/bin` },
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toContain("not on PATH");
	});

	it("blocks the push (exit 1) only when the fake gatekeeper reports a confirmed block (exit 1)", async () => {
		const base = await makeTmpDir("gatekeeper-provision-hook-block-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const repoDir = await adoptGithubRepo(base, controlRoot, "gh-repo", "acme/gh-app");
		await runProvision({ registry: registryDir, hooks: true }, base);
		const hookPath = path.join(repoDir, ".git", "hooks", "pre-push");

		const binDir = path.join(base, "fake-bin");
		await mkdir(binDir, { recursive: true });
		const fakeGatekeeper = path.join(binDir, "gatekeeper");
		await writeFile(fakeGatekeeper, "#!/bin/sh\nexit 1\n", "utf8");
		await chmod(fakeGatekeeper, 0o755);

		const result = spawnSync("sh", [hookPath], {
			cwd: repoDir,
			encoding: "utf8",
			env: { PATH: `${binDir}:/usr/bin:/bin` },
		});

		expect(result.status).toBe(1);
	});

	it("fail-open: exits 0 when the fake gatekeeper reports degraded (exit 0) or a usage error (exit 2)", async () => {
		const base = await makeTmpDir("gatekeeper-provision-hook-degraded-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const repoDir = await adoptGithubRepo(base, controlRoot, "gh-repo", "acme/gh-app");
		await runProvision({ registry: registryDir, hooks: true }, base);
		const hookPath = path.join(repoDir, ".git", "hooks", "pre-push");

		for (const fakeExit of [0, 2]) {
			const binDir = path.join(base, `fake-bin-${fakeExit}`);
			await mkdir(binDir, { recursive: true });
			const fakeGatekeeper = path.join(binDir, "gatekeeper");
			await writeFile(fakeGatekeeper, `#!/bin/sh\nexit ${fakeExit}\n`, "utf8");
			await chmod(fakeGatekeeper, 0o755);

			const result = spawnSync("sh", [hookPath], {
				cwd: repoDir,
				encoding: "utf8",
				env: { PATH: `${binDir}:/usr/bin:/bin` },
			});

			expect(result.status).toBe(0);
		}
	});
});

describe("gatekeeper provision: overlap defense against a hand-edited repos.yaml", () => {
	it("skips a registered entry whose path overlaps the control repo", async () => {
		const base = await makeTmpDir("gatekeeper-provision-overlap-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		git(controlRoot, ["init", "-q"]);
		git(controlRoot, ["remote", "add", "origin", "git@github.com:acme/control.git"]);
		const goodRepo = await adoptGithubRepo(base, controlRoot, "gh-repo", "acme/gh-app");

		const { loadRepos, upsertRepoEntry } = await import("../src/config/repos.js");
		const existing = await loadRepos(registryDir);
		await saveRepos(
			registryDir,
			upsertRepoEntry(existing, {
				repo: "acme/control-itself",
				path: controlRoot,
				ci: "none",
				adopted_at: "2026-01-01T00:00:00.000Z",
			}),
		);

		const exitCode = await runProvision({ registry: registryDir, agentsMd: true }, base);

		expect(exitCode).toBe(0);
		expect(await pathExists(path.join(goodRepo, "AGENTS.md"))).toBe(true);
		expect(await pathExists(path.join(controlRoot, "AGENTS.md"))).toBe(false);
	});
});

describe("gatekeeper provision: real Git worktree checkout (T-20260719-03 R1 blocker)", () => {
	it("does not crash the batch on a worktree's file-based .git, and either installs the hook at the common dir or skips it gracefully -- while still provisioning the repo processed after it", async () => {
		const base = await makeTmpDir("gatekeeper-provision-worktree-");
		const { controlRoot, registryDir } = await makeControlRepo(base);

		// A linked worktree's `.git` is a *file* containing a `gitdir:` pointer,
		// not a directory: `mkdir("<repo>/.git/hooks", { recursive: true })`
		// against that file throws ENOTDIR, which -- before this fix -- was
		// uncaught and aborted the whole provision run.
		const mainRepo = await makeGitRepo(base, "main-repo", "git@github.com:acme/main.git");
		const worktreeDir = path.join(base, "worktree-repo");
		git(mainRepo, ["worktree", "add", worktreeDir, "-b", "feature"]);
		expect((await stat(path.join(worktreeDir, ".git"))).isDirectory()).toBe(false);

		// Names are chosen so repos.yaml's alphabetical sort (config/repos.ts's
		// upsertRepoEntry) puts the worktree entry first -- reproducing the
		// live-repro shape where the crash happened on an earlier repo and
		// every later one in the batch never ran.
		await runAdopt({ control: controlRoot, repo: "acme/a-worktree" }, worktreeDir, {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const laterRepo = await makeGitRepo(base, "later-repo", "git@github.com:acme/z-normal.git");
		await runAdopt({ control: controlRoot, repo: "acme/z-normal" }, laterRepo, {
			now: () => "2026-01-01T00:00:00.000Z",
		});

		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
			stdoutChunks.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
			stderrChunks.push(String(chunk));
			return true;
		}) as typeof process.stderr.write);
		let exitCode: number;
		try {
			exitCode = await runProvision({ registry: registryDir, hooks: true }, base);
		} finally {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		}
		const combinedOutput = stdoutChunks.join("") + stderrChunks.join("");

		// The call resolving at all (not throwing) is itself the primary
		// regression assertion -- vitest fails this test if runProvision throws.
		expect(typeof exitCode).toBe("number");

		// The repo registered after the worktree entry must still have been
		// provisioned -- the batch must not have aborted partway through.
		expect(await pathExists(path.join(laterRepo, ".git", "hooks", "pre-push"))).toBe(true);

		// The worktree entry itself: either the hook landed at the real,
		// shared common dir (git rev-parse --git-common-dir resolves worktree
		// checkouts back to the main repo's .git), or it was gracefully
		// skipped with a reported reason -- both are acceptable outcomes; a
		// thrown/uncaught exception (the original bug) is not, and is exactly
		// what the try/finally above would have let escape uncaught.
		const commonDirHookPath = path.join(mainRepo, ".git", "hooks", "pre-push");
		const worktreeGitFile = await readFile(path.join(worktreeDir, ".git"), "utf8");
		expect(worktreeGitFile).toContain("gitdir:");
		const hookInstalledAtCommonDir = await pathExists(commonDirHookPath);
		const worktreeGracefullySkipped = combinedOutput.includes("acme/a-worktree") && /skip/i.test(combinedOutput);
		expect(hookInstalledAtCommonDir || worktreeGracefullySkipped).toBe(true);
		if (hookInstalledAtCommonDir) {
			const content = await readFile(commonDirHookPath, "utf8");
			expect(content).toContain("#!/bin/sh");
		}
	});
});

describe("gatekeeper provision: hub self-discovery via the controls index (B2)", () => {
	it("resolves --registry with zero flags from inside a control repo's own root (self-match)", async () => {
		const base = await makeTmpDir("gatekeeper-provision-hub-selfdiscover-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		git(controlRoot, ["init", "-q"]);
		git(controlRoot, ["remote", "add", "origin", "git@github.com:acme/hub.git"]);

		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };
		await upsertControl(
			{
				control: await realpath(controlRoot),
				registry: await realpath(registryDir),
				registered_at: "2026-07-19T00:00:00.000Z",
			},
			env,
		);

		const stdoutChunks: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
			stdoutChunks.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);

		// No --registry at all -- must resolve entirely through the self-match
		// branch of locateOwningControl (src/config/controls.ts). The roster is
		// empty (a control repo never adopts itself), so a successful resolution
		// looks like "0 repo(s)", not the exit-2 missing-registry error a failed
		// self-match would produce.
		let exitCode: number;
		try {
			exitCode = await runProvision({}, controlRoot, { env });
		} finally {
			stdoutSpy.mockRestore();
		}

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toContain("gatekeeper provision: 0 repo(s)");
	});
});
