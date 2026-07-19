import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	ConfigDiscoveryError,
	discoverConfig,
	resolveConfiguredField,
	resolveRegistryOption,
} from "../src/config/discover.js";

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
