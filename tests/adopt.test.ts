import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { runAdopt } from "../src/commands/adopt.js";
import { loadRepos, pathsOverlap } from "../src/config/repos.js";

const repoRootDir = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(repoRootDir, "src/cli.ts");
const tsxLoader = path.join(repoRootDir, "node_modules/tsx/dist/loader.mjs");

interface RunResult {
	status: number;
	stdout: string;
	stderr: string;
}

function runCli(cwd: string, args: string[]): RunResult {
	const result = spawnSync(process.execPath, ["--import", tsxLoader, cliPath, ...args], { cwd, encoding: "utf8" });
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

describe("gatekeeper adopt: preconditions (nothing written on failure)", () => {
	it("exits 2 outside a Git working tree", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-nongit-");
		const { controlRoot, registryDir } = await makeControlRepo(base);
		const nonGitDir = path.join(base, "not-a-repo");
		await mkdir(nonGitDir, { recursive: true });

		const exitCode = await runAdopt({ control: controlRoot }, nonGitDir);

		expect(exitCode).toBe(2);
		expect(await pathExists(path.join(nonGitDir, ".gatekeeper.yml"))).toBe(false);
		expect(await pathExists(path.join(registryDir, "repos.yaml"))).toBe(false);
	});

	it("exits 2 with the three tried candidates when no registry can be located under --control", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-noregistry-");
		const controlRoot = path.join(base, "control");
		await mkdir(controlRoot, { recursive: true });
		const repoDir = await makeGitRepo(base, "repo");

		const exitCode = await runAdopt({ control: controlRoot }, repoDir);

		expect(exitCode).toBe(2);
		expect(await pathExists(path.join(repoDir, ".gatekeeper.yml"))).toBe(false);
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
		expect(await pathExists(path.join(repoDir, ".gatekeeper.yml"))).toBe(false);
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

describe("gatekeeper adopt: registration (repos.yaml + .gatekeeper.yml)", () => {
	it("writes .gatekeeper.yml with a target-root-relative registry path and upserts repos.yaml", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-write-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot, registryDir } = await makeControlRepo(base);

		const exitCode = await runAdopt({ control: controlRoot }, repoDir, { now: () => "2026-01-01T00:00:00.000Z" });
		expect(exitCode).toBe(0);

		const configPath = path.join(repoDir, ".gatekeeper.yml");
		const parsedConfig = parseYaml(await readFile(configPath, "utf8"));
		expect(parsedConfig.apiVersion).toBe("gatekeeper/v1");
		expect(parsedConfig.repo).toBeUndefined();
		expect(path.isAbsolute(parsedConfig.registry)).toBe(false);
		expect(path.resolve(repoDir, parsedConfig.registry)).toBe(registryDir);

		const repos = await loadRepos(registryDir);
		// git rev-parse --show-toplevel resolves symlinks (e.g. macOS /var -> /private/var),
		// so compare against the realpath of the tmp checkout, not its raw mkdtemp path.
		expect(repos).toEqual([
			{ repo: "acme/app", path: await realpath(repoDir), ci: "none", adopted_at: "2026-01-01T00:00:00.000Z" },
		]);
	});

	it("records an explicit --repo override in both .gatekeeper.yml and repos.yaml", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-repo-override-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot, registryDir } = await makeControlRepo(base);

		const exitCode = await runAdopt({ control: controlRoot, repo: "acme/other" }, repoDir, {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		expect(exitCode).toBe(0);

		const parsedConfig = parseYaml(await readFile(path.join(repoDir, ".gatekeeper.yml"), "utf8"));
		expect(parsedConfig.repo).toBe("acme/other");

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
		const { controlRoot } = await makeControlRepo(base);
		const repoDir = await makeGitRepo(base, "repo");

		const exitCode = await runAdopt({ control: controlRoot, path: "repo" }, base, {
			now: () => "2026-01-01T00:00:00.000Z",
		});

		expect(exitCode).toBe(0);
		expect(await pathExists(path.join(repoDir, ".gatekeeper.yml"))).toBe(true);
	});

	it("adopted config makes a bare `gatekeeper check` work with zero registry flags", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-e2e-check-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot } = await makeControlRepo(base);

		const adopted = runCli(repoDir, ["adopt", "--control", controlRoot]);
		expect(adopted.status).toBe(0);

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

	it("without --force, skips rewriting an existing .gatekeeper.yml but still refreshes repos.yaml (exit 0)", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-idempotent-config-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot, registryDir } = await makeControlRepo(base);

		await runAdopt({ control: controlRoot, repo: "acme/app" }, repoDir, { now: () => "2026-01-01T00:00:00.000Z" });
		const configBefore = await readFile(path.join(repoDir, ".gatekeeper.yml"), "utf8");

		const secondExitCode = await runAdopt({ control: controlRoot }, repoDir, { now: () => "2026-06-01T00:00:00.000Z" });

		expect(secondExitCode).toBe(0);
		const configAfter = await readFile(path.join(repoDir, ".gatekeeper.yml"), "utf8");
		expect(configAfter).toBe(configBefore);
		const repos = await loadRepos(registryDir);
		expect(repos).toHaveLength(1);
		expect(repos[0]?.adopted_at).toBe("2026-06-01T00:00:00.000Z");
	});

	it("--force overwrites an existing .gatekeeper.yml", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-force-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot } = await makeControlRepo(base);

		await runAdopt({ control: controlRoot, repo: "acme/app" }, repoDir, { now: () => "2026-01-01T00:00:00.000Z" });
		const exitCode = await runAdopt({ control: controlRoot, repo: "acme/other", force: true }, repoDir, {
			now: () => "2026-01-01T00:00:00.000Z",
		});

		expect(exitCode).toBe(0);
		const parsedConfig = parseYaml(await readFile(path.join(repoDir, ".gatekeeper.yml"), "utf8"));
		expect(parsedConfig.repo).toBe("acme/other");
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

describe("gatekeeper adopt: an existing .gatekeeper.yml is validated (not silently skipped) without --force (grok nb#4)", () => {
	it("warns (but still skips, unchanged) when the existing file is damaged", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-damaged-skip-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot } = await makeControlRepo(base);
		const configPath = path.join(repoDir, ".gatekeeper.yml");
		const damagedContent = "apiVersion: gatekeeper/v1\nregistry: [unterminated\n";
		await writeFile(configPath, damagedContent, "utf8");

		let stderrOutput = "";
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
			stderrOutput += String(chunk);
			return true;
		}) as typeof process.stderr.write);
		let exitCode: number;
		try {
			exitCode = await runAdopt({ control: controlRoot, repo: "acme/app" }, repoDir, {
				now: () => "2026-01-01T00:00:00.000Z",
			});
		} finally {
			stderrSpy.mockRestore();
		}

		expect(exitCode).toBe(0);
		expect(stderrOutput).toContain("could not be parsed");
		expect(await readFile(configPath, "utf8")).toBe(damagedContent);
	});

	it("stays silent (no warning) when the existing file is valid", async () => {
		const base = await makeTmpDir("gatekeeper-adopt-valid-skip-quiet-");
		const repoDir = await makeGitRepo(base, "repo");
		const { controlRoot } = await makeControlRepo(base);
		await runAdopt({ control: controlRoot, repo: "acme/app" }, repoDir, { now: () => "2026-01-01T00:00:00.000Z" });

		let stderrOutput = "";
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
			stderrOutput += String(chunk);
			return true;
		}) as typeof process.stderr.write);
		let exitCode: number;
		try {
			exitCode = await runAdopt({ control: controlRoot, repo: "acme/app" }, repoDir, {
				now: () => "2026-06-01T00:00:00.000Z",
			});
		} finally {
			stderrSpy.mockRestore();
		}

		expect(exitCode).toBe(0);
		expect(stderrOutput).not.toContain("could not be parsed");
	});
});
