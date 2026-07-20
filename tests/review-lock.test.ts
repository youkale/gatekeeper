import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireReviewSupervisorLock, ReviewLockError } from "../src/review/lock.js";
import { type CreateReviewCycleInput, createCycle, loadCycle, reviewCycleDirectory } from "../src/review/store.js";

const temporaryDirectories: string[] = [];

async function makeConfigDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "gatekeeper-review-lock-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function input(): CreateReviewCycleInput {
	return {
		subject: { kind: "diff", repo: "acme/widgets", base_ref: "main" },
		target_repo: { name: "acme/widgets", path: "/work/acme/widgets" },
		subject_markdown: "Review it.\n",
		authoring_vendors: ["openai"],
		max_rounds: 3,
		lane_snapshot: [{ id: "L1-claude", cli: "claude", vendor: "anthropic", command: "claude review", required: true }],
		degraded: false,
	};
}

async function setupCycle() {
	const configDirectory = await makeConfigDirectory();
	const env = { GATEKEEPER_CONFIG_DIR: configDirectory };
	const created = await createCycle(input(), {
		env,
		now: () => new Date("2026-07-21T01:02:03.000Z"),
		randomUUID: () => "abcdef12-3456-7890-abcd-ef1234567890",
	});
	return { env, created };
}

async function exists(candidate: string): Promise<boolean> {
	try {
		await stat(candidate);
		return true;
	} catch {
		return false;
	}
}

describe("review supervisor.lock adapter", () => {
	it("reuses the hard-link CAS primitive to reject a live second holder", async () => {
		const { env, created } = await setupCycle();
		const first = await acquireReviewSupervisorLock(created.cycle.id, {
			env,
			pid: 111,
			now: () => new Date("2026-07-21T01:10:00.000Z"),
			randomUUID: () => "review-claim-a",
			isProcessAlive: () => true,
		});
		expect(JSON.parse(await readFile(first.path, "utf8"))).toEqual({
			pid: 111,
			started_at: "2026-07-21T01:10:00.000Z",
		});
		expect(await exists(`${first.path}.guard`)).toBe(true);

		await expect(
			acquireReviewSupervisorLock(created.cycle.id, {
				env,
				pid: 222,
				now: () => new Date("2026-07-21T01:11:00.000Z"),
				randomUUID: () => "review-claim-b",
				isProcessAlive: (pid) => pid === 111,
				claimRetryDelayMs: 0,
			}),
		).rejects.toMatchObject({ code: "HELD", holder: { pid: 111 } });

		await first.release();
		expect(await exists(first.path)).toBe(false);
	});

	it("writes review LOCK_TAKEN_OVER audit while leaving folded state unchanged", async () => {
		const { env, created } = await setupCycle();
		const lockPath = path.join(reviewCycleDirectory(created.cycle.id, env), "supervisor.lock");
		await writeFile(lockPath, '{"pid":111,"started_at":"2026-07-21T00:00:00.000Z"}\n', "utf8");

		const lock = await acquireReviewSupervisorLock(created.cycle.id, {
			env,
			pid: 222,
			now: () => new Date("2026-07-21T01:12:00.000Z"),
			randomUUID: () => "review-takeover",
			isProcessAlive: () => false,
		});
		const loaded = await loadCycle(created.cycle.id, env);
		expect(loaded.state).toBe("PENDING");
		expect(loaded.journal.at(-1)).toMatchObject({
			type: "LOCK_TAKEN_OVER",
			cycle_id: created.cycle.id,
			previous_pid: 111,
			new_pid: 222,
		});
		await lock.release();
	});

	it("maps release ownership failures into the review lock error domain", async () => {
		const { env, created } = await setupCycle();
		const lock = await acquireReviewSupervisorLock(created.cycle.id, {
			env,
			pid: 111,
			now: () => new Date("2026-07-21T01:10:00.000Z"),
			randomUUID: () => "review-release",
		});
		const replacement = '{"pid":222,"started_at":"2026-07-21T01:11:00.000Z"}\n';
		await writeFile(lock.path, replacement, "utf8");

		let caught: unknown;
		try {
			await lock.release();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ReviewLockError);
		expect(caught).toMatchObject({ code: "NOT_OWNER" });
		expect(await readFile(lock.path, "utf8")).toBe(replacement);
	});
});
