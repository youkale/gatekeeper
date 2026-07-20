import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	appendJournalEvent,
	type CreateWorkOrderInput,
	createOrder,
	DispatchStoreError,
	dispatchOrderDirectory,
	dispatchOrdersDirectory,
	listOrders,
	loadOrder,
} from "../src/dispatch/store.js";
import { associationKeySchema, type JournalEvent, runSchema } from "../src/dispatch/types.js";

const temporaryDirectories: string[] = [];

async function makeConfigDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function input(): CreateWorkOrderInput {
	return {
		association_key: "acme/widgets#42",
		target_repo: { name: "acme/widgets", path: "/work/acme/widgets" },
		brief: "Implement the acceptance contract exactly.\n",
		acceptance_contract: {
			result_path: "out/RESULT.json",
			progress_path: "out/PROGRESS.md",
			require_non_wip_commit: true,
			criteria: ["typecheck passes", "tests pass"],
		},
		candidate_ladder: [{ cli: "codex", vendor: "openai", command: "codex exec {brief}" }],
	};
}

function fixedDependencies(configDirectory: string) {
	return {
		env: { GATEKEEPER_CONFIG_DIR: configDirectory },
		now: () => new Date("2026-07-20T01:02:03.000Z"),
		randomUUID: () => "abcdef12-3456-7890-abcd-ef1234567890",
	};
}

function activeRun() {
	return {
		apiVersion: "gatekeeper/v1" as const,
		id: "r001",
		cli: "codex",
		vendor: "openai",
		command: "codex exec /work/brief.md",
		brief_path: "runs/r001/brief.md",
		started_at: "2026-07-20T01:03:00.000Z",
		stdout_path: "runs/r001/stdout.log",
		stderr_path: "runs/r001/stderr.log",
		out_path: "runs/r001/out",
	};
}

describe("associationKeySchema (T-20260721-01 ad-hoc keys, backward compatible with historical org/repo#N)", () => {
	it("still accepts every pre-existing org/repo#N issue-mode key (backward compatibility)", () => {
		expect(associationKeySchema.safeParse("acme/widgets#42").success).toBe(true);
		expect(associationKeySchema.safeParse("acme/widgets#1").success).toBe(true);
	});

	it("accepts a well-formed org/repo@adhoc-<id> ad-hoc key", () => {
		expect(associationKeySchema.safeParse("acme/widgets@adhoc-abc123def456").success).toBe(true);
	});

	it("rejects malformed keys (neither shape)", () => {
		expect(associationKeySchema.safeParse("acme/widgets").success).toBe(false);
		expect(associationKeySchema.safeParse("acme/widgets#").success).toBe(false);
		expect(associationKeySchema.safeParse("acme/widgets@adhoc-").success).toBe(false);
		expect(associationKeySchema.safeParse("acme/widgets@adhoc-UPPER").success).toBe(false);
	});

	it("createOrder persists and loadOrder re-reads an ad-hoc-keyed order unchanged (round trip)", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-dispatch-store-adhoc-");
		const created = await createOrder(
			{ ...input(), association_key: "acme/widgets@adhoc-abc123def456" },
			fixedDependencies(configDirectory),
		);
		expect(created.order.association_key).toBe("acme/widgets@adhoc-abc123def456");

		const reloaded = await loadOrder(created.order.id, { GATEKEEPER_CONFIG_DIR: configDirectory });
		expect(reloaded.order.association_key).toBe("acme/widgets@adhoc-abc123def456");
	});
});

describe("runSchema", () => {
	it("enforces active/terminal fields, exit semantics, canonical ids, and id-derived paths", () => {
		const active = activeRun();
		expect(runSchema.safeParse(active).success).toBe(true);
		expect(runSchema.safeParse({ ...active, exit_code: 0 }).success).toBe(false);
		expect(runSchema.safeParse({ ...active, ended_at: "2026-07-20T01:04:00.000Z" }).success).toBe(false);

		const completed = {
			...active,
			ended_at: "2026-07-20T01:04:00.000Z",
			outcome: "COMPLETED" as const,
			exit_code: 0,
			signal: null,
		};
		expect(runSchema.safeParse(completed).success).toBe(true);
		expect(runSchema.safeParse({ ...completed, exit_code: 1 }).success).toBe(false);
		expect(runSchema.safeParse({ ...completed, signal: "SIGTERM" }).success).toBe(false);
		const { signal: _missingSignal, ...completedWithoutSignal } = completed;
		expect(runSchema.safeParse(completedWithoutSignal).success).toBe(false);
		expect(runSchema.safeParse({ ...completed, outcome: "EXITED_NO_EVIDENCE" }).success).toBe(true);
		expect(runSchema.safeParse({ ...completed, outcome: "AGENT_ERROR", exit_code: 2 }).success).toBe(true);
		expect(runSchema.safeParse({ ...completed, outcome: "AGENT_ERROR", exit_code: 0 }).success).toBe(false);
		expect(runSchema.safeParse({ ...completed, outcome: "AGENT_ERROR", exit_code: 2, signal: "SIGTERM" }).success).toBe(
			false,
		);
		expect(runSchema.safeParse({ ...active, ended_at: completed.ended_at, outcome: "TIMEOUT" }).success).toBe(false);
		expect(
			runSchema.safeParse({
				...active,
				ended_at: completed.ended_at,
				outcome: "TIMEOUT",
				exit_code: null,
				signal: null,
			}).success,
		).toBe(true);

		expect(runSchema.safeParse({ ...active, id: "r1000" }).success).toBe(false);
		expect(runSchema.safeParse({ ...active, id: "r002" }).success).toBe(false);
		expect(runSchema.safeParse({ ...active, stdout_path: "runs/r001/other.log" }).success).toBe(false);
	});
});

describe("dispatch order store", () => {
	it("creates the complete documented layout atomically and round-trips through the injected config root", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-dispatch-store-");
		const dependencies = fixedDependencies(configDirectory);
		const created = await createOrder(input(), dependencies);
		const orderDirectory = dispatchOrderDirectory(created.order.id, dependencies.env);

		expect(created.order.id).toBe("wo-20260720t010203000z-abcdef123456");
		expect((await readdir(orderDirectory)).sort()).toEqual(["brief.md", "journal.jsonl", "order.yaml", "runs"]);
		expect(await readdir(path.join(orderDirectory, "runs"))).toEqual([]);
		expect(await readFile(path.join(orderDirectory, "brief.md"), "utf8")).toBe(input().brief);
		expect(await readFile(path.join(orderDirectory, "order.yaml"), "utf8")).toContain(
			"This file is host-machine dispatch state",
		);

		const loaded = await loadOrder(created.order.id, dependencies.env);
		expect(loaded).toEqual(created);
		expect((await listOrders(dependencies.env)).map((item) => item.order.id)).toEqual([created.order.id]);
		expect(orderDirectory.startsWith(configDirectory)).toBe(true);
	});

	it("hard-validates an event and requires the injected fsync operation before reporting the new folded state", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-dispatch-append-");
		const dependencies = fixedDependencies(configDirectory);
		const created = await createOrder(input(), dependencies);
		const event: JournalEvent = {
			apiVersion: "gatekeeper/v1",
			type: "RUN_STARTED",
			order_id: created.order.id,
			at: "2026-07-20T01:03:00.000Z",
			run_id: "r001",
			from: "PENDING",
			to: "RUNNING",
		};

		const sync = vi.fn(async (handle: import("node:fs/promises").FileHandle) => handle.sync());
		await appendJournalEvent(created.order.id, event, dependencies.env, { sync });

		const loaded = await loadOrder(created.order.id, dependencies.env);
		expect(loaded.state).toBe("RUNNING");
		expect(loaded.journal).toEqual([created.journal[0], event]);
		const journal = await readFile(
			path.join(dispatchOrderDirectory(created.order.id, dependencies.env), "journal.jsonl"),
			"utf8",
		);
		expect(journal.endsWith("\n")).toBe(true);
		expect(journal.trim().split("\n")).toHaveLength(2);
		expect(sync).toHaveBeenCalledOnce();
	});

	it("retries short Buffer writes and keeps loadOrder behind the journal lock until the full line is synced", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-dispatch-short-write-");
		const dependencies = fixedDependencies(configDirectory);
		const created = await createOrder(input(), dependencies);
		const event: JournalEvent = {
			apiVersion: "gatekeeper/v1",
			type: "RUN_STARTED",
			order_id: created.order.id,
			at: "2026-07-20T01:03:00.000Z",
			run_id: "r001",
			from: "PENDING",
			to: "RUNNING",
		};
		let firstChunkWritten: (() => void) | undefined;
		const firstChunk = new Promise<void>((resolve) => {
			firstChunkWritten = resolve;
		});
		let continueWrite: (() => void) | undefined;
		const permitted = new Promise<void>((resolve) => {
			continueWrite = resolve;
		});
		const write = vi.fn(async (handle: import("node:fs/promises").FileHandle, buffer: Buffer, offset: number) => {
			const length = Math.min(7, buffer.length - offset);
			const result = await handle.write(buffer, offset, length, null);
			if (offset === 0) {
				firstChunkWritten?.();
				await permitted;
			}
			return result.bytesWritten;
		});

		const append = appendJournalEvent(created.order.id, event, dependencies.env, { write });
		await firstChunk;
		let loadFinished = false;
		const load = loadOrder(created.order.id, dependencies.env).then((value) => {
			loadFinished = true;
			return value;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(loadFinished).toBe(false);
		continueWrite?.();
		await append;
		const loaded = await load;

		expect(write.mock.calls.length).toBeGreaterThan(1);
		expect(loaded.state).toBe("RUNNING");
		expect(loaded.journal.at(-1)).toEqual(event);
	});

	it("retains both previous and next run ids when recovery stops immediately after a retry event", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-dispatch-retry-replay-");
		const dependencies = fixedDependencies(configDirectory);
		const created = await createOrder(input(), dependencies);
		await appendJournalEvent(
			created.order.id,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: created.order.id,
				at: "2026-07-20T01:03:00.000Z",
				run_id: "r001",
				from: "PENDING",
				to: "RUNNING",
			},
			dependencies.env,
		);
		const retry: JournalEvent = {
			apiVersion: "gatekeeper/v1",
			type: "RUN_RETRY_SCHEDULED",
			order_id: created.order.id,
			at: "2026-07-20T01:04:00.000Z",
			previous_run_id: "r001",
			next_run_id: "r002",
			outcome: "TIMEOUT",
			from: "RUNNING",
			to: "RUNNING",
		};
		await appendJournalEvent(created.order.id, retry, dependencies.env);

		const recovered = await loadOrder(created.order.id, dependencies.env);
		expect(recovered.state).toBe("RUNNING");
		expect(recovered.journal.at(-1)).toEqual(retry);
	});

	it("reports a malformed journal line as a structured CORRUPT error without skipping it", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-dispatch-corrupt-journal-");
		const dependencies = fixedDependencies(configDirectory);
		const created = await createOrder(input(), dependencies);
		const journalFile = path.join(dispatchOrderDirectory(created.order.id, dependencies.env), "journal.jsonl");
		await writeFile(journalFile, `${await readFile(journalFile, "utf8")}{not-json}\n`, "utf8");

		let caught: unknown;
		try {
			await loadOrder(created.order.id, dependencies.env);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DispatchStoreError);
		expect(caught).toMatchObject({ code: "CORRUPT", line: 2, orderId: created.order.id });
	});

	it("does not publish a half-created order and cleans its temp directory when interrupted before rename", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-dispatch-interrupted-");
		const dependencies = fixedDependencies(configDirectory);

		await expect(
			createOrder(input(), {
				...dependencies,
				beforePublish() {
					throw new Error("simulated power loss");
				},
			}),
		).rejects.toMatchObject({ code: "WRITE_FAILED" });

		expect(await listOrders(dependencies.env)).toEqual([]);
		expect(await readdir(dispatchOrdersDirectory(dependencies.env))).toEqual([]);
	});

	it("never replaces a pre-existing empty final directory", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-dispatch-existing-empty-");
		const dependencies = fixedDependencies(configDirectory);
		const id = "wo-20260720t010203000z-abcdef123456";
		const finalDirectory = dispatchOrderDirectory(id, dependencies.env);
		await mkdir(finalDirectory, { recursive: true });

		await expect(createOrder(input(), dependencies)).rejects.toMatchObject({ code: "ALREADY_EXISTS", orderId: id });
		expect(await readdir(finalDirectory)).toEqual([]);
	});

	it("serializes concurrent creation of the same injected id so exactly one succeeds", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-dispatch-create-race-");
		const dependencies = fixedDependencies(configDirectory);
		const results = await Promise.allSettled([createOrder(input(), dependencies), createOrder(input(), dependencies)]);
		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter((result) => result.status === "rejected");

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]).toMatchObject({ reason: { code: "ALREADY_EXISTS" } });
		expect(await listOrders(dependencies.env)).toHaveLength(1);
	});

	it("does not clean a staging directory that this call did not create", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-dispatch-foreign-staging-");
		const dependencies = fixedDependencies(configDirectory);
		const id = "wo-20260720t010203000z-abcdef123456";
		const staging = path.join(
			dispatchOrdersDirectory(dependencies.env),
			`.tmp-${id}-abcdef12-3456-7890-abcd-ef1234567890`,
		);
		await mkdir(staging, { recursive: true });
		await writeFile(path.join(staging, "owner-marker"), "foreign", "utf8");

		await expect(createOrder(input(), dependencies)).rejects.toMatchObject({ code: "WRITE_FAILED" });
		expect(await readFile(path.join(staging, "owner-marker"), "utf8")).toBe("foreign");
	});

	it("hard-rejects unknown order.yaml and run meta.json keys", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-dispatch-strict-");
		const dependencies = fixedDependencies(configDirectory);
		const created = await createOrder(input(), dependencies);
		const orderDirectory = dispatchOrderDirectory(created.order.id, dependencies.env);
		const orderFile = path.join(orderDirectory, "order.yaml");
		const validOrder = await readFile(orderFile, "utf8");
		await writeFile(orderFile, `${await readFile(orderFile, "utf8")}unknown_key: true\n`, "utf8");
		await expect(loadOrder(created.order.id, dependencies.env)).rejects.toMatchObject({ code: "CORRUPT" });

		await writeFile(orderFile, validOrder, "utf8");
		await mkdir(path.join(orderDirectory, "runs", "r001"));
		await writeFile(
			path.join(orderDirectory, "runs", "r001", "meta.json"),
			JSON.stringify({
				apiVersion: "gatekeeper/v1",
				id: "r001",
				cli: "codex",
				vendor: "openai",
				command: "codex exec /work/brief.md",
				brief_path: "runs/r001/brief.md",
				started_at: "2026-07-20T01:03:00.000Z",
				stdout_path: "runs/r001/stdout.log",
				stderr_path: "runs/r001/stderr.log",
				out_path: "runs/r001/out",
				unknown_key: true,
			}),
			"utf8",
		);
		await expect(loadOrder(created.order.id, dependencies.env)).rejects.toMatchObject({
			code: "CORRUPT",
			file: path.join(orderDirectory, "runs", "r001", "meta.json"),
		});
	});

	it("loads a valid active run meta and reports semantic run corruption against meta.json", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-dispatch-run-meta-");
		const dependencies = fixedDependencies(configDirectory);
		const created = await createOrder(input(), dependencies);
		const orderDirectory = dispatchOrderDirectory(created.order.id, dependencies.env);
		const runDirectory = path.join(orderDirectory, "runs", "r001");
		const metaFile = path.join(runDirectory, "meta.json");
		await mkdir(runDirectory);
		await writeFile(metaFile, `${JSON.stringify(activeRun())}\n`, "utf8");

		expect((await loadOrder(created.order.id, dependencies.env)).runs).toEqual([activeRun()]);
		await writeFile(metaFile, `${JSON.stringify({ ...activeRun(), exit_code: 0 })}\n`, "utf8");
		await expect(loadOrder(created.order.id, dependencies.env)).rejects.toMatchObject({
			code: "CORRUPT",
			file: metaFile,
		});
	});

	it("rejects unsafe order ids before resolving a filesystem path", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-dispatch-path-escape-");
		const env = { GATEKEEPER_CONFIG_DIR: configDirectory };
		expect(() => dispatchOrderDirectory("../outside", env)).toThrow(DispatchStoreError);
		await expect(loadOrder("../outside", env)).rejects.toMatchObject({ code: "INVALID_DATA" });
	});
});
