import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadRepos, type RepoEntry, saveRepos, upsertRepo, upsertRepoEntry } from "../src/config/repos.js";

function entry(repo: string, path: string, adopted_at = "2026-01-01T00:00:00.000Z"): RepoEntry {
	return { repo, path, ci: "none", adopted_at };
}

describe("upsertRepoEntry (B3): path-unique, not just repo-unique", () => {
	it("appends a new entry", () => {
		expect(upsertRepoEntry([], entry("acme/app", "/checkouts/app"))).toEqual([entry("acme/app", "/checkouts/app")]);
	});

	it("replaces an existing entry with the same repo identity (ordinary re-adopt from a moved checkout)", () => {
		const existing = [entry("acme/app", "/checkouts/app-old")];
		const next = upsertRepoEntry(existing, entry("acme/app", "/checkouts/app-new", "2026-06-01T00:00:00.000Z"));

		expect(next).toEqual([entry("acme/app", "/checkouts/app-new", "2026-06-01T00:00:00.000Z")]);
	});

	it("also replaces an existing entry that shares the new entry's path but has a *different* repo identity (re-adopt with a corrected --repo)", () => {
		// Same checkout (path), first adopted under a wrong/placeholder identity,
		// then re-adopted with the corrected one -- without the path half of the
		// filter, the stale "acme/wrong" row would survive alongside the new
		// "acme/right" row, leaving two entries for the same `path`.
		const existing = [entry("acme/wrong", "/checkouts/app", "2026-01-01T00:00:00.000Z")];
		const next = upsertRepoEntry(existing, entry("acme/right", "/checkouts/app", "2026-06-01T00:00:00.000Z"));

		expect(next).toEqual([entry("acme/right", "/checkouts/app", "2026-06-01T00:00:00.000Z")]);
	});

	it("never leaves two rows for the same path after a corrected re-adopt, even with other unrelated entries present", () => {
		const existing = [
			entry("acme/other", "/checkouts/other"),
			entry("acme/wrong", "/checkouts/app", "2026-01-01T00:00:00.000Z"),
		];
		const next = upsertRepoEntry(existing, entry("acme/right", "/checkouts/app", "2026-06-01T00:00:00.000Z"));

		expect(next).toHaveLength(2);
		expect(next.filter((row) => row.path === "/checkouts/app")).toEqual([
			entry("acme/right", "/checkouts/app", "2026-06-01T00:00:00.000Z"),
		]);
		expect(next.find((row) => row.repo === "acme/wrong")).toBeUndefined();
	});

	it("sorts entries by repo", () => {
		const next = upsertRepoEntry([entry("acme/z", "/z")], entry("acme/a", "/a"));
		expect(next.map((row) => row.repo)).toEqual(["acme/a", "acme/z"]);
	});
});

describe("saveRepos (B8): atomic write leaves no temp file behind and no partial content", () => {
	let registryDir: string | undefined;

	afterEach(async () => {
		if (registryDir) {
			await rm(registryDir, { recursive: true, force: true });
			registryDir = undefined;
		}
	});

	it("round-trips entries and leaves only repos.yaml in the directory (no leftover .tmp-* file)", async () => {
		registryDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-saverepos-atomic-"));
		await mkdir(registryDir, { recursive: true });

		await saveRepos(registryDir, [entry("acme/app", "/checkouts/app")]);

		expect(await loadRepos(registryDir)).toEqual([entry("acme/app", "/checkouts/app")]);
		const files = await readdir(registryDir);
		expect(files).toEqual(["repos.yaml"]);
	});

	it("a second save fully replaces the first (rename overwrites, not appends)", async () => {
		registryDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-saverepos-atomic-overwrite-"));
		await mkdir(registryDir, { recursive: true });

		await saveRepos(registryDir, [entry("acme/first", "/checkouts/first")]);
		await saveRepos(registryDir, [entry("acme/second", "/checkouts/second")]);

		expect(await loadRepos(registryDir)).toEqual([entry("acme/second", "/checkouts/second")]);
		const files = await readdir(registryDir);
		expect(files).toEqual(["repos.yaml"]);
	});
});

describe("upsertRepo (C3): concurrent, interleaved upserts all survive (no lost update)", () => {
	let registryDir: string | undefined;

	afterEach(async () => {
		if (registryDir) {
			await rm(registryDir, { recursive: true, force: true });
			registryDir = undefined;
		}
	});

	it("N concurrent upserts of N different repos against the same roster all end up present", async () => {
		registryDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-upsertrepo-concurrent-"));
		await mkdir(registryDir, { recursive: true });
		const count = 12;

		// Fired via Promise.all (not awaited one at a time) -- see the identical
		// rationale in tests/controls-index.test.ts's sibling test for
		// upsertControl: without the same-directory lock file
		// (src/config/filelock.ts) serializing the load-modify-save round trip,
		// two calls that both load the same "before" roster and then each save
		// back only their own entry would silently discard one writer's update
		// (this is exactly `gatekeeper adopt`'s own call chain -- see
		// src/commands/adopt.ts).
		await Promise.all(
			Array.from({ length: count }, (_, index) =>
				upsertRepo(registryDir as string, entry(`acme/repo-${index}`, `/checkouts/repo-${index}`)),
			),
		);

		const repos = await loadRepos(registryDir);
		expect(repos).toHaveLength(count);
		expect(repos.map((row) => row.repo).sort()).toEqual(
			Array.from({ length: count }, (_, index) => `acme/repo-${index}`).sort(),
		);
	});
});
