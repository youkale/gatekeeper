import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { upsertControl } from "../src/config/controls.js";
import {
	ConfigDiscoveryError,
	discoverConfig,
	discoverConfigWithControlsIndex,
	resolveConfiguredField,
	resolveRegistryOption,
} from "../src/config/discover.js";
import { saveRepos } from "../src/config/repos.js";
import { GitDiffError, resolveRepoRoot } from "../src/providers/gitdiff.js";

let tmpDir: string | undefined;

async function makeTmpDir(): Promise<string> {
	tmpDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-config-discover-"));
	return tmpDir;
}

afterEach(async () => {
	if (tmpDir) {
		await rm(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});

describe("discoverConfig: upward search", () => {
	it("finds .gatekeeper.yml in an ancestor directory from a nested cwd", async () => {
		const root = await makeTmpDir();
		await writeFile(path.join(root, ".gatekeeper.yml"), "apiVersion: gatekeeper/v1\nregistry: ./registry\n", "utf8");
		const nested = path.join(root, "a", "b", "c");
		await mkdir(nested, { recursive: true });

		const discovered = await discoverConfig(nested);

		expect(discovered).not.toBeNull();
		expect(discovered?.path).toBe(path.join(root, ".gatekeeper.yml"));
		expect(discovered?.dir).toBe(root);
		expect(discovered?.config.registry).toBe("./registry");
	});

	it("returns null when no .gatekeeper.yml exists anywhere up the tree", async () => {
		const root = await makeTmpDir();
		const nested = path.join(root, "a", "b");
		await mkdir(nested, { recursive: true });

		expect(await discoverConfig(nested)).toBeNull();
	});

	it("stops searching (inclusive) at the directory containing .git and does not search above it", async () => {
		const root = await makeTmpDir();
		// A config file that sits *above* the git top must never be found: adopt
		// scopes .gatekeeper.yml to one repository, not an ancestor workspace.
		await writeFile(
			path.join(root, ".gatekeeper.yml"),
			"apiVersion: gatekeeper/v1\nregistry: /should/not/be/found\n",
			"utf8",
		);
		const repo = path.join(root, "repo");
		await mkdir(path.join(repo, ".git"), { recursive: true });
		const nested = path.join(repo, "sub", "dir");
		await mkdir(nested, { recursive: true });

		expect(await discoverConfig(nested)).toBeNull();
	});

	it("finds .gatekeeper.yml that lives exactly at the git top", async () => {
		const root = await makeTmpDir();
		const repo = path.join(root, "repo");
		await mkdir(path.join(repo, ".git"), { recursive: true });
		await writeFile(path.join(repo, ".gatekeeper.yml"), "apiVersion: gatekeeper/v1\nregistry: ./registry\n", "utf8");
		const nested = path.join(repo, "sub");
		await mkdir(nested, { recursive: true });

		const discovered = await discoverConfig(nested);

		expect(discovered?.path).toBe(path.join(repo, ".gatekeeper.yml"));
	});
});

describe("discoverConfig: damaged config file (fail-loud direction)", () => {
	it("throws ConfigDiscoveryError on invalid YAML", async () => {
		const root = await makeTmpDir();
		await writeFile(path.join(root, ".gatekeeper.yml"), "apiVersion: [unterminated\n", "utf8");

		await expect(discoverConfig(root)).rejects.toBeInstanceOf(ConfigDiscoveryError);
	});

	it("throws ConfigDiscoveryError when apiVersion is missing or wrong", async () => {
		const root = await makeTmpDir();
		await writeFile(path.join(root, ".gatekeeper.yml"), "registry: ./registry\n", "utf8");

		await expect(discoverConfig(root)).rejects.toBeInstanceOf(ConfigDiscoveryError);
	});

	it("throws ConfigDiscoveryError on an unknown, non-x- key", async () => {
		const root = await makeTmpDir();
		await writeFile(
			path.join(root, ".gatekeeper.yml"),
			"apiVersion: gatekeeper/v1\nregistry: ./registry\nbogus: true\n",
			"utf8",
		);

		await expect(discoverConfig(root)).rejects.toThrow(/Unknown key "bogus"/);
	});

	it("throws ConfigDiscoveryError when the document is not a YAML mapping", async () => {
		const root = await makeTmpDir();
		await writeFile(path.join(root, ".gatekeeper.yml"), "- just\n- a\n- list\n", "utf8");

		await expect(discoverConfig(root)).rejects.toBeInstanceOf(ConfigDiscoveryError);
	});

	it("accepts x-* extension keys without error", async () => {
		const root = await makeTmpDir();
		await writeFile(
			path.join(root, ".gatekeeper.yml"),
			"apiVersion: gatekeeper/v1\nregistry: ./registry\nx-team: platform\n",
			"utf8",
		);

		const discovered = await discoverConfig(root);
		expect(discovered?.config.registry).toBe("./registry");
	});
});

describe("discoverConfig: full field set", () => {
	it("parses registry/repo/base/actor", async () => {
		const root = await makeTmpDir();
		await writeFile(
			path.join(root, ".gatekeeper.yml"),
			[
				"apiVersion: gatekeeper/v1",
				"registry: ../project-manager/governance/registry",
				"repo: pipe/syncify",
				"base: origin/main",
				"actor: sean",
				"",
			].join("\n"),
			"utf8",
		);

		const discovered = await discoverConfig(root);

		expect(discovered?.config).toEqual({
			apiVersion: "gatekeeper/v1",
			registry: "../project-manager/governance/registry",
			repo: "pipe/syncify",
			base: "origin/main",
			actor: "sean",
		});
	});
});

describe("resolveRegistryOption: priority order", () => {
	const discoveredWithRegistry = (dir: string, registry: string) => ({
		path: path.join(dir, ".gatekeeper.yml"),
		dir,
		config: { apiVersion: "gatekeeper/v1" as const, registry },
	});

	it("an explicit CLI flag always wins", () => {
		const resolved = resolveRegistryOption({
			cliValue: "/from/cli",
			env: { GATEKEEPER_REGISTRY: "/from/env" },
			discovered: discoveredWithRegistry("/repo", "./from-file"),
		});
		expect(resolved).toBe("/from/cli");
	});

	it("GATEKEEPER_REGISTRY wins over .gatekeeper.yml when no CLI flag is given", () => {
		const resolved = resolveRegistryOption({
			env: { GATEKEEPER_REGISTRY: "/from/env" },
			discovered: discoveredWithRegistry("/repo", "./from-file"),
		});
		expect(resolved).toBe("/from/env");
	});

	it("resolves .gatekeeper.yml's registry: relative to the config file's directory, not cwd", () => {
		const resolved = resolveRegistryOption({
			env: {},
			discovered: discoveredWithRegistry(path.join("/repo", "nested"), "../registry"),
		});
		expect(resolved).toBe(path.resolve(path.join("/repo", "nested"), "../registry"));
		expect(resolved).toBe(path.resolve("/repo", "registry"));
	});

	it("keeps an absolute registry: value as-is", () => {
		const resolved = resolveRegistryOption({
			env: {},
			discovered: discoveredWithRegistry("/repo", "/abs/registry"),
		});
		expect(resolved).toBe("/abs/registry");
	});

	it("returns undefined when no source provides a registry", () => {
		expect(resolveRegistryOption({ env: {}, discovered: null })).toBeUndefined();
		expect(
			resolveRegistryOption({
				env: {},
				discovered: { path: "/repo/.gatekeeper.yml", dir: "/repo", config: { apiVersion: "gatekeeper/v1" } },
			}),
		).toBeUndefined();
	});
});

describe("resolveConfiguredField: repo/base/actor", () => {
	const discovered = {
		path: "/repo/.gatekeeper.yml",
		dir: "/repo",
		config: { apiVersion: "gatekeeper/v1" as const, repo: "acme/app", base: "origin/main", actor: "sean" },
	};

	it("an explicit CLI value wins over the config file", () => {
		expect(resolveConfiguredField("acme/other", discovered, "repo")).toBe("acme/other");
	});

	it("falls back to the config file's field when the CLI value is undefined", () => {
		expect(resolveConfiguredField(undefined, discovered, "repo")).toBe("acme/app");
		expect(resolveConfiguredField(undefined, discovered, "base")).toBe("origin/main");
		expect(resolveConfiguredField(undefined, discovered, "actor")).toBe("sean");
	});

	it("returns undefined when neither the CLI value nor a discovered config supply the field", () => {
		expect(resolveConfiguredField(undefined, null, "repo")).toBeUndefined();
	});
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function makeGitRepo(base: string, name: string): Promise<string> {
	const repoDir = path.join(base, name);
	await mkdir(repoDir, { recursive: true });
	git(repoDir, ["init", "-q"]);
	git(repoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	git(repoDir, ["config", "user.email", "discover@example.com"]);
	git(repoDir, ["config", "user.name", "Discover Bot"]);
	await writeFile(path.join(repoDir, "README.md"), "hello\n", "utf8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-q", "-m", "init"]);
	return repoDir;
}

async function writeMinimalRegistry(registryDir: string): Promise<void> {
	await mkdir(registryDir, { recursive: true });
	await writeFile(
		path.join(registryDir, "policy.yaml"),
		"apiVersion: gatekeeper/v1\nlevels:\n  strict:\n    enforcement: block\n    require: { m: 1, lanes: [human] }\n",
		"utf8",
	);
}

describe("discoverConfigWithControlsIndex: fifth priority tier (controls index reverse discovery)", () => {
	it("resolves registry + repo from the controls index when no .gatekeeper.yml exists anywhere up the tree", async () => {
		const base = await makeTmpDir();
		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		const controlRoot = path.join(base, "control");
		const registryDir = path.join(controlRoot, "governance", "registry");
		await writeMinimalRegistry(registryDir);
		const repoDir = await makeGitRepo(base, "repo");
		const repoRealPath = await realpath(repoDir);

		await saveRepos(registryDir, [
			{ repo: "acme/app", path: repoRealPath, ci: "none", adopted_at: "2026-01-01T00:00:00.000Z" },
		]);
		await upsertControl(
			{ control: controlRoot, registry: registryDir, registered_at: "2026-01-01T00:00:00.000Z" },
			env,
		);

		const result = await discoverConfigWithControlsIndex(repoDir, { mode: "gate", env });

		expect(result.warnings).toEqual([]);
		expect(result.discovered?.config.registry).toBe(registryDir);
		expect(result.discovered?.config.repo).toBe("acme/app");
	});

	it("resolves the same way from a nested subdirectory of the repo, not only its root", async () => {
		const base = await makeTmpDir();
		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		const controlRoot = path.join(base, "control");
		const registryDir = path.join(controlRoot, "governance", "registry");
		await writeMinimalRegistry(registryDir);
		const repoDir = await makeGitRepo(base, "repo");
		const repoRealPath = await realpath(repoDir);
		const nested = path.join(repoDir, "src", "nested");
		await mkdir(nested, { recursive: true });

		await saveRepos(registryDir, [
			{ repo: "acme/app", path: repoRealPath, ci: "none", adopted_at: "2026-01-01T00:00:00.000Z" },
		]);
		await upsertControl(
			{ control: controlRoot, registry: registryDir, registered_at: "2026-01-01T00:00:00.000Z" },
			env,
		);

		const result = await discoverConfigWithControlsIndex(nested, { mode: "gate", env });

		expect(result.discovered?.config.registry).toBe(registryDir);
		expect(result.discovered?.config.repo).toBe("acme/app");
	});

	it("an explicit .gatekeeper.yml always wins over the controls index", async () => {
		const base = await makeTmpDir();
		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		const controlRoot = path.join(base, "control");
		const registryDir = path.join(controlRoot, "governance", "registry");
		await writeMinimalRegistry(registryDir);
		const repoDir = await makeGitRepo(base, "repo");
		const repoRealPath = await realpath(repoDir);

		await saveRepos(registryDir, [
			{ repo: "acme/app", path: repoRealPath, ci: "none", adopted_at: "2026-01-01T00:00:00.000Z" },
		]);
		await upsertControl(
			{ control: controlRoot, registry: registryDir, registered_at: "2026-01-01T00:00:00.000Z" },
			env,
		);

		const explicitRegistryDir = path.join(base, "explicit-registry");
		await writeMinimalRegistry(explicitRegistryDir);
		await writeFile(
			path.join(repoDir, ".gatekeeper.yml"),
			`apiVersion: gatekeeper/v1\nregistry: ${explicitRegistryDir}\nrepo: acme/explicit\n`,
			"utf8",
		);

		const result = await discoverConfigWithControlsIndex(repoDir, { mode: "gate", env });

		expect(result.discovered?.path).toBe(path.join(repoDir, ".gatekeeper.yml"));
		expect(result.discovered?.config.registry).toBe(explicitRegistryDir);
		expect(result.discovered?.config.repo).toBe("acme/explicit");
	});

	it("skips this discovery tier (no error, no match) when cwd is not a Git working tree", async () => {
		const base = await makeTmpDir();
		const configDir = path.join(base, "config");
		const nonGitDir = path.join(base, "not-a-repo");
		await mkdir(nonGitDir, { recursive: true });

		const result = await discoverConfigWithControlsIndex(nonGitDir, {
			mode: "gate",
			env: { GATEKEEPER_CONFIG_DIR: configDir },
		});

		expect(result).toEqual({ discovered: null, warnings: [] });
	});

	it("(C2) mode 'gate' escalates a stale-control entry that is the sole reason no match was found to a thrown ConfigDiscoveryError; mode 'tool' surfaces it as a plain warning", async () => {
		const base = await makeTmpDir();
		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };
		const repoDir = await makeGitRepo(base, "repo");

		// Register a control root that was never actually created on disk (stale).
		await upsertControl(
			{
				control: path.join(base, "ghost-control"),
				registry: path.join(base, "ghost-control", "registry"),
				registered_at: "2026-01-01T00:00:00.000Z",
			},
			env,
		);

		// Silently returning `discovered: null` here (the pre-C2 behavior) gave a
		// check/gate operator zero signal that a controls-index entry had gone
		// stale -- indistinguishable from "this repo was simply never adopted".
		// check/gate's own fail-open degrade path is what actually surfaces this
		// loudly (see gate.test.ts's "gate: controls-index reverse discovery"
		// describe block for the end-to-end degrade assertion); at this
		// function's own level, the observable contract is "throws".
		await expect(discoverConfigWithControlsIndex(repoDir, { mode: "gate", env })).rejects.toBeInstanceOf(
			ConfigDiscoveryError,
		);
		await expect(discoverConfigWithControlsIndex(repoDir, { mode: "gate", env })).rejects.toThrow(/no longer exists/);

		const toolResult = await discoverConfigWithControlsIndex(repoDir, { mode: "tool", env });
		expect(toolResult.discovered).toBeNull();
		expect(toolResult.warnings).toHaveLength(1);
		expect(toolResult.warnings[0]).toContain("no longer exists");
	});

	it("propagates a damaged controls index as ConfigDiscoveryError (same fail-loud/fail-open split as a damaged .gatekeeper.yml)", async () => {
		const base = await makeTmpDir();
		const configDir = path.join(base, "config");
		await mkdir(configDir, { recursive: true });
		await writeFile(path.join(configDir, "controls.yaml"), "apiVersion: [unterminated\n", "utf8");
		const repoDir = await makeGitRepo(base, "repo");

		await expect(
			discoverConfigWithControlsIndex(repoDir, { mode: "gate", env: { GATEKEEPER_CONFIG_DIR: configDir } }),
		).rejects.toBeInstanceOf(ConfigDiscoveryError);
	});

	it("propagates a damaged repos.yaml belonging to a matched (non-stale) control as ConfigDiscoveryError", async () => {
		const base = await makeTmpDir();
		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		const controlRoot = path.join(base, "control");
		const registryDir = path.join(controlRoot, "governance", "registry");
		await writeMinimalRegistry(registryDir);
		await writeFile(path.join(registryDir, "repos.yaml"), "apiVersion: gatekeeper/v1\nrepos: not-a-list\n", "utf8");
		await upsertControl(
			{ control: controlRoot, registry: registryDir, registered_at: "2026-01-01T00:00:00.000Z" },
			env,
		);
		const repoDir = await makeGitRepo(base, "repo");

		await expect(discoverConfigWithControlsIndex(repoDir, { mode: "gate", env })).rejects.toBeInstanceOf(
			ConfigDiscoveryError,
		);
	});
});

describe("resolveRepoRoot (C1): confirmed not-a-worktree vs. any other git failure", () => {
	it("classifies a real non-repo directory as kind 'not-a-worktree'", async () => {
		const base = await makeTmpDir();
		const nonGitDir = path.join(base, "not-a-repo");
		await mkdir(nonGitDir, { recursive: true });

		await expect(resolveRepoRoot(nonGitDir)).rejects.toMatchObject({
			name: "GitDiffError",
			kind: "not-a-worktree",
		});
	});

	it("classifies a nonexistent cwd (git can't even chdir there) as kind 'infra', not 'not-a-worktree'", async () => {
		const base = await makeTmpDir();
		const missingDir = path.join(base, "does-not-exist-at-all");

		let caught: unknown;
		try {
			await resolveRepoRoot(missingDir);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(GitDiffError);
		expect((caught as GitDiffError).kind).toBe("infra");
	});
});

describe("discoverConfigWithControlsIndex (C1): a non-'not-a-worktree' git failure is infrastructure damage, not 'tier doesn't apply'", () => {
	it("throws ConfigDiscoveryError instead of silently returning null for a git 'infra' failure (nonexistent cwd)", async () => {
		const base = await makeTmpDir();
		const missingDir = path.join(base, "does-not-exist-at-all");

		await expect(discoverConfigWithControlsIndex(missingDir, { mode: "gate" })).rejects.toBeInstanceOf(
			ConfigDiscoveryError,
		);
		await expect(discoverConfigWithControlsIndex(missingDir, { mode: "tool" })).rejects.toBeInstanceOf(
			ConfigDiscoveryError,
		);
	});

	it("still returns { discovered: null, warnings: [] } (this tier doesn't apply) for a confirmed non-repo directory", async () => {
		const base = await makeTmpDir();
		const nonGitDir = path.join(base, "not-a-repo");
		await mkdir(nonGitDir, { recursive: true });

		expect(await discoverConfigWithControlsIndex(nonGitDir, { mode: "gate" })).toEqual({
			discovered: null,
			warnings: [],
		});
	});
});

describe("validate: fail-loud (exit 2) on a C1 git 'infra' failure, the tool-mode counterpart of gate's degrade", () => {
	it("exits 2 with a descriptive stderr message for a nonexistent cwd", async () => {
		const { runValidate } = await import("../src/commands/validate.js");
		const base = await makeTmpDir();
		const missingDir = path.join(base, "does-not-exist-at-all");
		let stderrOutput = "";

		const exitCode = await runValidate({ stderr: (chunk) => (stderrOutput += chunk) }, missingDir);

		expect(exitCode).toBe(2);
		expect(stderrOutput).toContain("gatekeeper validate:");
	});
});
