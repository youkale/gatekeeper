import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireSupervisorLock, DispatchLockError } from "../src/dispatch/lock.js";
import { type CreateWorkOrderInput, createOrder, dispatchOrderDirectory, loadOrder } from "../src/dispatch/store.js";

const temporaryDirectories: string[] = [];

async function makeConfigDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "gatekeeper-dispatch-lock-"));
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
		brief: "Implement it.\n",
		acceptance_contract: {
			result_path: "out/RESULT.json",
			progress_path: "out/PROGRESS.md",
			require_non_wip_commit: true,
			criteria: [],
		},
		candidate_ladder: [{ cli: "codex", vendor: "openai", command: "codex exec {brief}" }],
	};
}

async function setupOrder() {
	const configDirectory = await makeConfigDirectory();
	const env = { GATEKEEPER_CONFIG_DIR: configDirectory };
	const created = await createOrder(input(), {
		env,
		now: () => new Date("2026-07-20T01:02:03.000Z"),
		randomUUID: () => "abcdef12-3456-7890-abcd-ef1234567890",
	});
	return { configDirectory, env, created };
}

async function exists(candidate: string): Promise<boolean> {
	try {
		await stat(candidate);
		return true;
	} catch {
		return false;
	}
}

describe("supervisor.lock", () => {
	it("uses O_EXCL semantics to reject a second holder while the recorded pid is live", async () => {
		const { env, created } = await setupOrder();
		const first = await acquireSupervisorLock(created.order.id, {
			env,
			pid: 111,
			now: () => new Date("2026-07-20T01:10:00.000Z"),
			isProcessAlive: () => true,
		});
		const raw = JSON.parse(await readFile(first.path, "utf8"));
		expect(raw).toEqual({ pid: 111, started_at: "2026-07-20T01:10:00.000Z" });

		await expect(
			acquireSupervisorLock(created.order.id, {
				env,
				pid: 222,
				now: () => new Date("2026-07-20T01:11:00.000Z"),
				isProcessAlive: (pid) => pid === 111,
			}),
		).rejects.toMatchObject({ code: "HELD", holder: { pid: 111 } });

		await first.release();
		expect(await exists(first.path)).toBe(false);
	});

	it("takes over a dead-pid stale lock, records an audit event, and leaves folded state unchanged", async () => {
		const { env, created } = await setupOrder();
		const lockPath = path.join(dispatchOrderDirectory(created.order.id, env), "supervisor.lock");
		await writeFile(lockPath, '{"pid":111,"started_at":"2026-07-20T00:00:00.000Z"}\n', "utf8");

		const lock = await acquireSupervisorLock(created.order.id, {
			env,
			pid: 222,
			now: () => new Date("2026-07-20T01:12:00.000Z"),
			isProcessAlive: () => false,
		});

		expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual({
			pid: 222,
			started_at: "2026-07-20T01:12:00.000Z",
		});
		const loaded = await loadOrder(created.order.id, env);
		expect(loaded.state).toBe("PENDING");
		expect(loaded.journal.at(-1)).toMatchObject({
			type: "LOCK_TAKEN_OVER",
			previous_pid: 111,
			new_pid: 222,
		});

		await lock.release();
	});

	it("lets exactly one of two synchronized waiters claim the same stale guard and supervisor", async () => {
		const { env, created } = await setupOrder();
		const orderDirectory = dispatchOrderDirectory(created.order.id, env);
		const lockPath = path.join(orderDirectory, "supervisor.lock");
		const guardPath = `${lockPath}.guard`;
		await writeFile(lockPath, '{"pid":111,"started_at":"2026-07-20T00:00:00.000Z"}\n', "utf8");
		await writeFile(guardPath, '{"pid":111,"started_at":"2026-07-20T00:00:00.000Z","token":"111-stale-0"}\n', "utf8");

		let arrivals = 0;
		let openBarrier: (() => void) | undefined;
		const barrier = new Promise<void>((resolve) => {
			openBarrier = resolve;
		});
		const beforeClaim = async (owner: { token: string }) => {
			if (owner.token !== "111-stale-0") {
				return;
			}
			arrivals += 1;
			if (arrivals === 2) {
				openBarrier?.();
			}
			await barrier;
		};
		const isProcessAlive = (pid: number) => pid === 222 || pid === 333;
		const contenders = [
			acquireSupervisorLock(created.order.id, {
				env,
				pid: 222,
				now: () => new Date("2026-07-20T01:12:00.000Z"),
				randomUUID: () => "claim-a",
				isProcessAlive,
				beforeClaim,
				claimRetryDelayMs: 0,
			}),
			acquireSupervisorLock(created.order.id, {
				env,
				pid: 333,
				now: () => new Date("2026-07-20T01:12:01.000Z"),
				randomUUID: () => "claim-b",
				isProcessAlive,
				beforeClaim,
				claimRetryDelayMs: 0,
			}),
		];

		const results = await Promise.allSettled(contenders);
		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter((result) => result.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]).toMatchObject({ reason: { code: "HELD" } });
		const loaded = await loadOrder(created.order.id, env);
		expect(loaded.journal.filter((event) => event.type === "LOCK_TAKEN_OVER")).toHaveLength(1);

		if (fulfilled[0]?.status === "fulfilled") {
			await fulfilled[0].value.release();
		}
	});

	it("never removes another holder's lock during release", async () => {
		const { env, created } = await setupOrder();
		const lock = await acquireSupervisorLock(created.order.id, {
			env,
			pid: 111,
			now: () => new Date("2026-07-20T01:10:00.000Z"),
		});
		const replacement = '{"pid":222,"started_at":"2026-07-20T01:11:00.000Z"}\n';
		await writeFile(lock.path, replacement, "utf8");

		await expect(lock.release()).rejects.toBeInstanceOf(DispatchLockError);
		expect(await readFile(lock.path, "utf8")).toBe(replacement);
	});

	it("rejects a corrupt lock instead of guessing whether its holder is stale", async () => {
		const { env, created } = await setupOrder();
		const lockPath = path.join(dispatchOrderDirectory(created.order.id, env), "supervisor.lock");
		await writeFile(lockPath, "not-json\n", "utf8");

		await expect(acquireSupervisorLock(created.order.id, { env, pid: 222 })).rejects.toMatchObject({
			code: "CORRUPT",
		});
		expect(await readFile(lockPath, "utf8")).toBe("not-json\n");
	});

	it("ownership-safely removes the inode it created when lock fsync fails", async () => {
		const { env, created } = await setupOrder();
		const lockPath = path.join(dispatchOrderDirectory(created.order.id, env), "supervisor.lock");

		await expect(
			acquireSupervisorLock(created.order.id, {
				env,
				pid: 222,
				sync: async () => {
					throw new Error("simulated fsync failure");
				},
			}),
		).rejects.toMatchObject({ code: "LOCK_IO_FAILED" });
		expect(await exists(lockPath)).toBe(false);
	});

	it("uses only the injected GATEKEEPER_CONFIG_DIR and rejects a missing order", async () => {
		const configDirectory = await makeConfigDirectory();
		const env = { GATEKEEPER_CONFIG_DIR: configDirectory };
		await expect(acquireSupervisorLock("wo-missing", { env, pid: 123 })).rejects.toMatchObject({
			code: "ORDER_NOT_FOUND",
		});
		expect(await exists(path.join(configDirectory, "dispatch", "orders", "wo-missing"))).toBe(false);
	});
});
