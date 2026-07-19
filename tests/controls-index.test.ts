import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
	type ControlEntry,
	ControlsIndexError,
	loadControlsIndex,
	locateOwningControl,
	resolveConfigDir,
	saveControlsIndex,
	upsertControl,
	upsertControlEntry,
} from "../src/config/controls.js";
import { saveRepos } from "../src/config/repos.js";

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

function entry(control: string, registry: string, registered_at = "2026-01-01T00:00:00.000Z"): ControlEntry {
	return { control, registry, registered_at };
}

describe("resolveConfigDir", () => {
	it("uses GATEKEEPER_CONFIG_DIR when set", () => {
		expect(resolveConfigDir({ GATEKEEPER_CONFIG_DIR: "/tmp/gk-config" })).toBe("/tmp/gk-config");
	});

	it("falls back to ~/.config/gatekeeper when unset", () => {
		expect(resolveConfigDir({})).toContain(path.join(".config", "gatekeeper"));
	});
});

describe("loadControlsIndex / saveControlsIndex: roundtrip and missing-file handling", () => {
	it("returns [] when controls.yaml does not exist yet", async () => {
		const configDir = await makeTmpDir("gatekeeper-controls-missing-");
		expect(await loadControlsIndex({ GATEKEEPER_CONFIG_DIR: configDir })).toEqual([]);
	});

	it("round-trips entries written by saveControlsIndex", async () => {
		const configDir = await makeTmpDir("gatekeeper-controls-roundtrip-");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };
		await saveControlsIndex([entry("/a/control", "/a/control/governance/registry")], env);

		const loaded = await loadControlsIndex(env);
		expect(loaded).toEqual([entry("/a/control", "/a/control/governance/registry")]);
	});

	it("creates the config directory if it does not exist yet", async () => {
		const base = await makeTmpDir("gatekeeper-controls-mkdir-");
		const configDir = path.join(base, "nested", "config-dir");
		await saveControlsIndex([entry("/a/control", "/a/registry")], { GATEKEEPER_CONFIG_DIR: configDir });

		const raw = await readFile(path.join(configDir, "controls.yaml"), "utf8");
		const parsed = parseYaml(raw);
		expect(parsed.apiVersion).toBe("gatekeeper/v1");
		expect(parsed.controls).toEqual([
			{ control: "/a/control", registry: "/a/registry", registered_at: "2026-01-01T00:00:00.000Z" },
		]);
	});

	it("throws ControlsIndexError on invalid YAML", async () => {
		const configDir = await makeTmpDir("gatekeeper-controls-badyaml-");
		await mkdir(configDir, { recursive: true });
		await writeFile(path.join(configDir, "controls.yaml"), "apiVersion: [unterminated\n", "utf8");

		await expect(loadControlsIndex({ GATEKEEPER_CONFIG_DIR: configDir })).rejects.toBeInstanceOf(ControlsIndexError);
	});

	it("throws ControlsIndexError when apiVersion is missing or wrong", async () => {
		const configDir = await makeTmpDir("gatekeeper-controls-badversion-");
		await mkdir(configDir, { recursive: true });
		await writeFile(path.join(configDir, "controls.yaml"), "controls: []\n", "utf8");

		await expect(loadControlsIndex({ GATEKEEPER_CONFIG_DIR: configDir })).rejects.toBeInstanceOf(ControlsIndexError);
	});

	it("throws ControlsIndexError on an unknown, non-x- key at either level", async () => {
		const configDir = await makeTmpDir("gatekeeper-controls-unknownkey-");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			path.join(configDir, "controls.yaml"),
			"apiVersion: gatekeeper/v1\nbogus: true\ncontrols: []\n",
			"utf8",
		);

		await expect(loadControlsIndex({ GATEKEEPER_CONFIG_DIR: configDir })).rejects.toThrow(/Unknown key "bogus"/);
	});

	it("accepts x-* extension keys without error", async () => {
		const configDir = await makeTmpDir("gatekeeper-controls-xkey-");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			path.join(configDir, "controls.yaml"),
			[
				"apiVersion: gatekeeper/v1",
				"controls:",
				"  - control: /a/control",
				"    registry: /a/registry",
				"    registered_at: '2026-01-01T00:00:00.000Z'",
				"    x-note: hello",
				"",
			].join("\n"),
			"utf8",
		);

		const loaded = await loadControlsIndex({ GATEKEEPER_CONFIG_DIR: configDir });
		expect(loaded).toHaveLength(1);
	});
});

describe("saveControlsIndex (B8): atomic write leaves no temp file behind and no partial content", () => {
	it("round-trips entries and leaves only controls.yaml in the config dir (no leftover .tmp-* file)", async () => {
		const configDir = await makeTmpDir("gatekeeper-savecontrolsindex-atomic-");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		await saveControlsIndex([entry("/a/control", "/a/registry")], env);

		expect(await loadControlsIndex(env)).toEqual([entry("/a/control", "/a/registry")]);
		const files = await readdir(configDir);
		expect(files).toEqual(["controls.yaml"]);
	});

	it("a second save fully replaces the first (rename overwrites, not appends)", async () => {
		const configDir = await makeTmpDir("gatekeeper-savecontrolsindex-atomic-overwrite-");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		await saveControlsIndex([entry("/a/control", "/a/registry")], env);
		await saveControlsIndex([entry("/b/control", "/b/registry")], env);

		expect(await loadControlsIndex(env)).toEqual([entry("/b/control", "/b/registry")]);
		const files = await readdir(configDir);
		expect(files).toEqual(["controls.yaml"]);
	});
});

describe("upsertControlEntry: dedup by control realpath", () => {
	it("appends a new entry", () => {
		const next = upsertControlEntry([], entry("/a/control", "/a/registry"));
		expect(next).toEqual([entry("/a/control", "/a/registry")]);
	});

	it("replaces the existing entry for the same control instead of duplicating it", () => {
		const existing = [entry("/a/control", "/a/registry-old", "2026-01-01T00:00:00.000Z")];
		const next = upsertControlEntry(existing, entry("/a/control", "/a/registry-new", "2026-06-01T00:00:00.000Z"));

		expect(next).toEqual([entry("/a/control", "/a/registry-new", "2026-06-01T00:00:00.000Z")]);
	});

	it("sorts entries by control", () => {
		const next = upsertControlEntry([entry("/z/control", "/z/registry")], entry("/a/control", "/a/registry"));
		expect(next.map((item) => item.control)).toEqual(["/a/control", "/z/control"]);
	});
});

describe("upsertControl: load + upsert + save in one call", () => {
	it("persists a new entry to disk", async () => {
		const configDir = await makeTmpDir("gatekeeper-controls-upsert-");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		await upsertControl(entry("/a/control", "/a/registry"), env);

		expect(await loadControlsIndex(env)).toEqual([entry("/a/control", "/a/registry")]);
	});

	it("updates an existing entry on a second call for the same control", async () => {
		const configDir = await makeTmpDir("gatekeeper-controls-upsert-update-");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		await upsertControl(entry("/a/control", "/a/registry", "2026-01-01T00:00:00.000Z"), env);
		await upsertControl(entry("/a/control", "/a/registry", "2026-06-01T00:00:00.000Z"), env);

		const loaded = await loadControlsIndex(env);
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.registered_at).toBe("2026-06-01T00:00:00.000Z");
	});
});

describe("upsertControl (C3): concurrent, interleaved upserts all survive (no lost update)", () => {
	it("N concurrent upserts of N different controls against the same index all end up present", async () => {
		const configDir = await makeTmpDir("gatekeeper-controls-concurrent-");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };
		const count = 12;

		// Fired via Promise.all (not awaited one at a time): every upsertControl
		// call's own internal await points (open/readFile/writeFile/rename, all
		// real libuv-threadpool round trips) genuinely interleave with the
		// others'. Without the same-directory lock file (src/config/
		// filelock.ts) serializing the load-modify-save round trip, two calls
		// that both load the same "before" index and then each save back only
		// their own entry would silently discard one writer's update.
		await Promise.all(
			Array.from({ length: count }, (_, index) => upsertControl(entry(`/control-${index}`, `/registry-${index}`), env)),
		);

		const loaded = await loadControlsIndex(env);
		expect(loaded).toHaveLength(count);
		expect(loaded.map((item) => item.control).sort()).toEqual(
			Array.from({ length: count }, (_, index) => `/control-${index}`).sort(),
		);
	});
});

async function writeMinimalRegistry(registryDir: string): Promise<void> {
	await mkdir(path.join(registryDir, "contracts"), { recursive: true });
	await writeFile(
		path.join(registryDir, "policy.yaml"),
		"apiVersion: gatekeeper/v1\nlevels:\n  strict:\n    enforcement: block\n    require: { m: 1, lanes: [human] }\n",
		"utf8",
	);
}

describe("locateOwningControl: reverse discovery", () => {
	it("returns no match and no warnings when the index is empty", async () => {
		const configDir = await makeTmpDir("gatekeeper-locate-empty-");
		const result = await locateOwningControl("/some/repo", { GATEKEEPER_CONFIG_DIR: configDir });
		expect(result).toEqual({ match: null, warnings: [] });
	});

	it("finds the control whose repos.yaml roster contains the given repo root", async () => {
		const base = await makeTmpDir("gatekeeper-locate-match-");
		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		const controlRoot = path.join(base, "control");
		const registryDir = path.join(controlRoot, "governance", "registry");
		await writeMinimalRegistry(registryDir);
		const repoRoot = await realpath(base); // any real dir stands in for a repo root here

		await saveRepos(registryDir, [
			{ repo: "acme/app", path: repoRoot, ci: "none", adopted_at: "2026-01-01T00:00:00.000Z" },
		]);
		await upsertControl(entry(controlRoot, registryDir), env);

		const result = await locateOwningControl(repoRoot, env);
		expect(result).toEqual({ match: { registry: registryDir, repo: "acme/app" }, warnings: [] });
	});

	it("returns no match when no repos.yaml entry's path matches", async () => {
		const base = await makeTmpDir("gatekeeper-locate-nomatch-");
		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		const controlRoot = path.join(base, "control");
		const registryDir = path.join(controlRoot, "governance", "registry");
		await writeMinimalRegistry(registryDir);
		await saveRepos(registryDir, [
			{ repo: "acme/app", path: "/somewhere/else", ci: "none", adopted_at: "2026-01-01T00:00:00.000Z" },
		]);
		await upsertControl(entry(controlRoot, registryDir), env);

		const result = await locateOwningControl(await realpath(base), env);
		expect(result.match).toBeNull();
	});

	it("skips a stale index entry (control repo root no longer exists) with a stale-control warning", async () => {
		const base = await makeTmpDir("gatekeeper-locate-stale-");
		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		// Register a control root that is never actually created on disk.
		await upsertControl(entry(path.join(base, "ghost-control"), path.join(base, "ghost-control", "registry")), env);

		const result = await locateOwningControl(await realpath(base), env);
		expect(result.match).toBeNull();
		expect(result.warnings).toEqual([{ kind: "stale-control", message: expect.stringContaining("no longer exists") }]);
	});

	it("re-throws when a matched (non-stale) control's repos.yaml fails to parse", async () => {
		const base = await makeTmpDir("gatekeeper-locate-damaged-");
		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		const controlRoot = path.join(base, "control");
		const registryDir = path.join(controlRoot, "governance", "registry");
		await writeMinimalRegistry(registryDir);
		await writeFile(path.join(registryDir, "repos.yaml"), "apiVersion: gatekeeper/v1\nrepos: not-a-list\n", "utf8");
		await upsertControl(entry(controlRoot, registryDir), env);

		await expect(locateOwningControl(await realpath(base), env)).rejects.toThrow(/repos\.yaml/);
	});

	it("when two controls both claim the same repo, uses the first index entry and warns", async () => {
		const base = await makeTmpDir("gatekeeper-locate-multiclaim-");
		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };
		const repoRoot = await realpath(base);

		const controlA = path.join(base, "control-a");
		const registryA = path.join(controlA, "governance", "registry");
		await writeMinimalRegistry(registryA);
		await saveRepos(registryA, [
			{ repo: "acme/app-a", path: repoRoot, ci: "none", adopted_at: "2026-01-01T00:00:00.000Z" },
		]);

		const controlB = path.join(base, "control-b");
		const registryB = path.join(controlB, "governance", "registry");
		await writeMinimalRegistry(registryB);
		await saveRepos(registryB, [
			{ repo: "acme/app-b", path: repoRoot, ci: "none", adopted_at: "2026-01-01T00:00:00.000Z" },
		]);

		// upsertControlEntry sorts by control, so control-a sorts before control-b -- deterministic winner.
		await upsertControl(entry(controlA, registryA), env);
		await upsertControl(entry(controlB, registryB), env);

		const result = await locateOwningControl(repoRoot, env);
		expect(result.match).toEqual({ registry: registryA, repo: "acme/app-a" });
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]?.kind).toBe("multi-claim");
	});

	describe("self-match (B2): a control repo discovering its own root", () => {
		it("returns a registry-only match (no repo identity) when the repo root is a registered control's own root", async () => {
			const base = await makeTmpDir("gatekeeper-locate-selfmatch-");
			const configDir = path.join(base, "config");
			const env = { GATEKEEPER_CONFIG_DIR: configDir };

			const controlRoot = path.join(base, "control");
			const registryDir = path.join(controlRoot, "governance", "registry");
			await writeMinimalRegistry(registryDir);
			// Empty repos.yaml roster -- a control repo never adopts itself.
			await saveRepos(registryDir, []);
			// Store the realpath, same as adopt.ts/init-control.ts do -- a raw
			// (possibly symlinked, e.g. macOS /var -> /private/var) path would
			// never string-equal the realpath locateOwningControl compares against.
			const controlRootRealPath = await realpath(controlRoot);
			await upsertControl(entry(controlRootRealPath, registryDir), env);

			const result = await locateOwningControl(controlRootRealPath, env);

			expect(result).toEqual({ match: { registry: registryDir }, warnings: [] });
			expect(result.match?.repo).toBeUndefined();
		});

		it("a repos.yaml hit always outranks a self-match for the same lookup", async () => {
			const base = await makeTmpDir("gatekeeper-locate-selfmatch-priority-");
			const configDir = path.join(base, "config");
			const env = { GATEKEEPER_CONFIG_DIR: configDir };

			// controlRoot is registered as a control (so it's self-match-eligible),
			// but some *other* control's repos.yaml also happens to list controlRoot
			// as one of its managed repos -- the roster hit must win.
			const controlRoot = path.join(base, "control");
			const controlRegistryDir = path.join(controlRoot, "governance", "registry");
			await writeMinimalRegistry(controlRegistryDir);
			await saveRepos(controlRegistryDir, []);
			await upsertControl(entry(controlRoot, controlRegistryDir), env);

			const otherControlRoot = path.join(base, "other-control");
			const otherRegistryDir = path.join(otherControlRoot, "governance", "registry");
			await writeMinimalRegistry(otherRegistryDir);
			const controlRootRealPath = await realpath(controlRoot);
			await saveRepos(otherRegistryDir, [
				{
					repo: "acme/control-as-a-repo",
					path: controlRootRealPath,
					ci: "none",
					adopted_at: "2026-01-01T00:00:00.000Z",
				},
			]);
			await upsertControl(entry(otherControlRoot, otherRegistryDir), env);

			const result = await locateOwningControl(controlRootRealPath, env);

			expect(result).toEqual({
				match: { registry: otherRegistryDir, repo: "acme/control-as-a-repo" },
				warnings: [],
			});
		});

		it("cannot itself be multi-claimed: the controls index is keyed on control, so at most one entry can self-match", async () => {
			const base = await makeTmpDir("gatekeeper-locate-selfmatch-unique-");
			const configDir = path.join(base, "config");
			const env = { GATEKEEPER_CONFIG_DIR: configDir };

			const controlRoot = path.join(base, "control");
			const registryDir = path.join(controlRoot, "governance", "registry");
			await writeMinimalRegistry(registryDir);
			await saveRepos(registryDir, []);
			const controlRootRealPath = await realpath(controlRoot);
			// Re-registering the same control (e.g. a rerun of `init-control`)
			// upserts in place -- still exactly one index entry.
			await upsertControl(entry(controlRootRealPath, registryDir, "2026-01-01T00:00:00.000Z"), env);
			await upsertControl(entry(controlRootRealPath, registryDir, "2026-06-01T00:00:00.000Z"), env);

			const result = await locateOwningControl(controlRootRealPath, env);

			expect(result.warnings).toEqual([]);
			expect(result.match).toEqual({ registry: registryDir });
		});
	});
});
