import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	appendJournalEvent,
	type CreateReviewCycleInput,
	createCycle,
	listCycles,
	loadCycle,
	ReviewStoreError,
	reviewCycleDirectory,
	reviewCyclesDirectory,
} from "../src/review/store.js";
import { type Lane, laneSchema, type ReviewJournalEvent, type Round, roundSchema } from "../src/review/types.js";

const temporaryDirectories: string[] = [];
const AT = "2026-07-21T01:03:00.000Z";

async function makeConfigDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function input(overrides: Partial<CreateReviewCycleInput> = {}): CreateReviewCycleInput {
	return {
		subject: { kind: "diff", repo: "acme/widgets", base_ref: "main", head_ref: "feature/review" },
		target_repo: { name: "acme/widgets", path: "/work/acme/widgets" },
		subject_markdown: "Review the frozen diff and the stated delivery risks.\n",
		authoring_vendors: ["openai"],
		max_rounds: 3,
		lane_snapshot: [
			{ id: "L1-claude", cli: "claude", vendor: "anthropic", command: "claude review", required: true },
			{ id: "L2-grok", cli: "grok", vendor: "xai", command: "grok review", required: false },
		],
		degraded: false,
		...overrides,
	};
}

function fixedDependencies(configDirectory: string) {
	return {
		env: { GATEKEEPER_CONFIG_DIR: configDirectory },
		now: () => new Date("2026-07-21T01:02:03.000Z"),
		randomUUID: () => "abcdef12-3456-7890-abcd-ef1234567890",
	};
}

function roundStarted(cycleId: string): ReviewJournalEvent {
	return {
		apiVersion: "gatekeeper/v1",
		type: "ROUND_STARTED",
		cycle_id: cycleId,
		at: "2026-07-21T01:03:00.000Z",
		round: 1,
		from: "PENDING",
		to: "REVIEWING",
	};
}

describe("review cycle store", () => {
	it("atomically creates the documented layout and round-trips both strict subject forms", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-review-store-");
		const dependencies = fixedDependencies(configDirectory);
		const created = await createCycle(input(), dependencies);
		const cycleDirectory = reviewCycleDirectory(created.cycle.id, dependencies.env);

		expect(created.cycle.id).toBe("rc-20260721t010203000z-abcdef123456");
		expect((await readdir(cycleDirectory)).sort()).toEqual(["cycle.yaml", "journal.jsonl", "rounds", "subject.md"]);
		expect(await readdir(path.join(cycleDirectory, "rounds"))).toEqual([]);
		expect(await readFile(path.join(cycleDirectory, "subject.md"), "utf8")).toBe(input().subject_markdown);
		expect(await readFile(path.join(cycleDirectory, "cycle.yaml"), "utf8")).toContain(
			"This file is host-machine review state",
		);
		expect(await loadCycle(created.cycle.id, dependencies.env)).toEqual(created);
		expect((await listCycles(dependencies.env)).map((item) => item.cycle.id)).toEqual([created.cycle.id]);
		expect(cycleDirectory.startsWith(configDirectory)).toBe(true);

		const secondConfig = await makeConfigDirectory("gatekeeper-review-dispatch-subject-");
		const dispatchSubject = await createCycle(
			input({ subject: { kind: "dispatch-order", order_id: "wo-review-source" } }),
			fixedDependencies(secondConfig),
		);
		expect(dispatchSubject.cycle.subject).toEqual({ kind: "dispatch-order", order_id: "wo-review-source" });
	});

	it("keeps separate GATEKEEPER_CONFIG_DIR injections completely isolated", async () => {
		const left = await makeConfigDirectory("gatekeeper-review-env-left-");
		const right = await makeConfigDirectory("gatekeeper-review-env-right-");
		const created = await createCycle(input(), fixedDependencies(left));

		expect(await listCycles({ GATEKEEPER_CONFIG_DIR: right })).toEqual([]);
		await expect(loadCycle(created.cycle.id, { GATEKEEPER_CONFIG_DIR: right })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(await listCycles({ GATEKEEPER_CONFIG_DIR: left })).toHaveLength(1);
	});

	it("validates and folds the complete history before appending durable bytes", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-review-append-");
		const dependencies = fixedDependencies(configDirectory);
		const created = await createCycle(input(), dependencies);
		const event = roundStarted(created.cycle.id);
		const sync = vi.fn(async (handle: import("node:fs/promises").FileHandle) => handle.sync());

		await appendJournalEvent(created.cycle.id, event, dependencies.env, { sync });
		const loaded = await loadCycle(created.cycle.id, dependencies.env);
		expect(loaded.state).toBe("REVIEWING");
		expect(loaded.journal.at(-1)).toEqual(event);
		expect(sync).toHaveBeenCalledOnce();

		const journalFile = path.join(reviewCycleDirectory(created.cycle.id, dependencies.env), "journal.jsonl");
		const before = await readFile(journalFile, "utf8");
		await expect(appendJournalEvent(created.cycle.id, event, dependencies.env)).rejects.toMatchObject({
			code: "INVALID_DATA",
		});
		expect(await readFile(journalFile, "utf8")).toBe(before);
	});

	it("uses the frozen limit during append prevalidation to force a full round into arbitration", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-review-limit-");
		const dependencies = fixedDependencies(configDirectory);
		const created = await createCycle(input({ max_rounds: 1 }), dependencies);
		await appendJournalEvent(created.cycle.id, roundStarted(created.cycle.id), dependencies.env);
		const blocked: ReviewJournalEvent = {
			apiVersion: "gatekeeper/v1",
			type: "ROUND_CONCLUDED",
			cycle_id: created.cycle.id,
			at: "2026-07-21T01:04:00.000Z",
			round: 1,
			verdict: "FAIL",
			from: "REVIEWING",
			to: "BLOCKED",
		};
		await expect(appendJournalEvent(created.cycle.id, blocked, dependencies.env)).rejects.toMatchObject({
			code: "INVALID_DATA",
		});
		await appendJournalEvent(created.cycle.id, { ...blocked, to: "ARBITRATION" }, dependencies.env);
		expect((await loadCycle(created.cycle.id, dependencies.env)).state).toBe("ARBITRATION");
	});

	it("reports a malformed journal line as structured CORRUPT without skipping it", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-review-corrupt-journal-");
		const dependencies = fixedDependencies(configDirectory);
		const created = await createCycle(input(), dependencies);
		const journalFile = path.join(reviewCycleDirectory(created.cycle.id, dependencies.env), "journal.jsonl");
		await writeFile(journalFile, `${await readFile(journalFile, "utf8")}{not-json}\n`, "utf8");

		let caught: unknown;
		try {
			await loadCycle(created.cycle.id, dependencies.env);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ReviewStoreError);
		expect(caught).toMatchObject({ code: "CORRUPT", line: 2, cycleId: created.cycle.id });
	});

	it("does not publish a half-created cycle and cleans only its own staging directory", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-review-interrupted-");
		const dependencies = fixedDependencies(configDirectory);
		await expect(
			createCycle(input(), {
				...dependencies,
				beforePublish() {
					throw new Error("simulated power loss");
				},
			}),
		).rejects.toMatchObject({ code: "WRITE_FAILED" });

		expect(await listCycles(dependencies.env)).toEqual([]);
		expect(await readdir(reviewCyclesDirectory(dependencies.env))).toEqual([]);
	});

	it("loads strict round summaries and lane metadata tied to the frozen route snapshot", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-review-rounds-");
		const dependencies = fixedDependencies(configDirectory);
		const created = await createCycle(input(), dependencies);
		const roundDirectory = path.join(reviewCycleDirectory(created.cycle.id, dependencies.env), "rounds", "R1");
		const laneDirectory = path.join(roundDirectory, "lanes", "L1-claude");
		await mkdir(laneDirectory, { recursive: true });
		const summary: Round = {
			apiVersion: "gatekeeper/v1",
			id: "R1",
			cycle_id: created.cycle.id,
			number: 1,
			status: "REVIEWING",
			subject_fingerprint: { head: "abc123", porcelain: "", trackedDiff: "", untracked: [] },
			lane_ids: ["L1-claude"],
			lane_results: [],
			started_at: "2026-07-21T01:03:00.000Z",
		};
		const lane: Lane = {
			apiVersion: "gatekeeper/v1",
			id: "L1-claude",
			cycle_id: created.cycle.id,
			round: 1,
			cli: "claude",
			vendor: "anthropic",
			command: "claude review",
			required: true,
			status: "PENDING",
			brief_path: "rounds/R1/lanes/L1-claude/brief.md",
			stdout_path: "rounds/R1/lanes/L1-claude/stdout.log",
			stderr_path: "rounds/R1/lanes/L1-claude/stderr.log",
			out_path: "rounds/R1/lanes/L1-claude/out",
			result_path: "rounds/R1/lanes/L1-claude/out/VERDICT.json",
		};
		await writeFile(path.join(roundDirectory, "summary.json"), `${JSON.stringify(summary)}\n`, "utf8");
		await writeFile(path.join(laneDirectory, "meta.json"), `${JSON.stringify(lane)}\n`, "utf8");

		expect((await loadCycle(created.cycle.id, dependencies.env)).rounds).toEqual([{ summary, lanes: [lane] }]);
		await writeFile(
			path.join(laneDirectory, "meta.json"),
			`${JSON.stringify({
				...lane,
				status: "CONCLUDED",
				started_at: "2026-07-21T01:03:00.000Z",
				ended_at: "2026-07-21T01:04:00.000Z",
				outcome: "PASS",
				exit_code: 0,
				signal: null,
			})}\n`,
			"utf8",
		);
		await expect(loadCycle(created.cycle.id, dependencies.env)).rejects.toMatchObject({
			code: "CORRUPT",
			file: path.join(roundDirectory, "summary.json"),
		});
		await writeFile(path.join(laneDirectory, "meta.json"), `${JSON.stringify({ ...lane, unknown: true })}\n`, "utf8");
		await expect(loadCycle(created.cycle.id, dependencies.env)).rejects.toMatchObject({
			code: "CORRUPT",
			file: path.join(laneDirectory, "meta.json"),
		});
	});

	it("groups dispatch-run lifecycle fields and requires complete concluded round lane results", () => {
		const pending: Lane = {
			apiVersion: "gatekeeper/v1",
			id: "L1-claude",
			cycle_id: "rc-schema-cycle",
			round: 1,
			cli: "claude",
			vendor: "anthropic",
			command: "claude review",
			required: true,
			status: "PENDING",
			brief_path: "rounds/R1/lanes/L1-claude/brief.md",
			stdout_path: "rounds/R1/lanes/L1-claude/stdout.log",
			stderr_path: "rounds/R1/lanes/L1-claude/stderr.log",
			out_path: "rounds/R1/lanes/L1-claude/out",
			result_path: "rounds/R1/lanes/L1-claude/out/VERDICT.json",
		};
		expect(laneSchema.safeParse(pending).success).toBe(true);
		expect(laneSchema.safeParse({ ...pending, pid: 123 }).success).toBe(false);
		const running = { ...pending, status: "RUNNING" as const, pid: 123, pgid: 123, started_at: AT };
		expect(laneSchema.safeParse(running).success).toBe(true);
		expect(laneSchema.safeParse({ ...running, exit_code: 0 }).success).toBe(false);
		const concluded = {
			...running,
			status: "CONCLUDED" as const,
			ended_at: "2026-07-21T01:05:00.000Z",
			outcome: "PASS" as const,
			exit_code: 0,
			signal: null,
		};
		expect(laneSchema.safeParse(concluded).success).toBe(true);
		const { signal: _missingSignal, ...incomplete } = concluded;
		expect(laneSchema.safeParse(incomplete).success).toBe(false);

		const concludedRound = {
			apiVersion: "gatekeeper/v1" as const,
			id: "R1",
			cycle_id: "rc-schema-cycle",
			number: 1,
			status: "AWAITING_ACCEPT" as const,
			subject_fingerprint: { head: "abc123", porcelain: "", trackedDiff: "", untracked: [] },
			lane_ids: ["L1-claude"],
			lane_results: [{ lane_id: "L1-claude", required: true, outcome: "PASS" as const }],
			verdict: "PASS" as const,
			started_at: AT,
			concluded_at: "2026-07-21T01:05:00.000Z",
		};
		expect(roundSchema.safeParse(concludedRound).success).toBe(true);
		expect(roundSchema.safeParse({ ...concludedRound, lane_results: [] }).success).toBe(false);
		expect(
			roundSchema.safeParse({
				...concludedRound,
				lane_results: [{ lane_id: "L2-grok", required: false, outcome: "PASS" }],
			}).success,
		).toBe(false);

		const twoLaneRound = {
			...concludedRound,
			lane_ids: ["L1-claude", "L2-grok"],
		};
		expect(
			roundSchema.safeParse({
				...twoLaneRound,
				lane_results: [
					{ lane_id: "L1-claude", required: true, outcome: "FAIL" },
					{ lane_id: "L2-grok", required: true, outcome: "PASS" },
				],
				verdict: "PASS",
			}).success,
		).toBe(false);
		expect(
			roundSchema.safeParse({
				...twoLaneRound,
				status: "BLOCKED",
				lane_results: [
					{ lane_id: "L1-claude", required: true, outcome: "INVALID" },
					{ lane_id: "L2-grok", required: true, outcome: "PASS" },
				],
				verdict: "FAIL",
			}).success,
		).toBe(false);
		expect(
			roundSchema.safeParse({
				...twoLaneRound,
				status: "BLOCKED",
				lane_results: [
					{ lane_id: "L1-claude", required: true, outcome: "PASS" },
					{ lane_id: "L2-grok", required: true, outcome: "PASS" },
				],
				verdict: "FAIL",
			}).success,
		).toBe(false);
		expect(
			roundSchema.safeParse({
				...twoLaneRound,
				lane_results: [
					{ lane_id: "L1-claude", required: true, outcome: "PASS" },
					{ lane_id: "L2-grok", required: false, outcome: "FAIL" },
				],
				verdict: "PASS",
			}).success,
		).toBe(true);
	});

	it("loads a round as CORRUPT when it omits a required frozen route", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-review-required-route-");
		const dependencies = fixedDependencies(configDirectory);
		const created = await createCycle(
			input({
				lane_snapshot: [
					{ id: "L1-claude", cli: "claude", vendor: "anthropic", command: "claude review", required: true },
					{ id: "L2-grok", cli: "grok", vendor: "xai", command: "grok review", required: true },
				],
			}),
			dependencies,
		);
		const roundDirectory = path.join(reviewCycleDirectory(created.cycle.id, dependencies.env), "rounds", "R1");
		const laneDirectory = path.join(roundDirectory, "lanes", "L1-claude");
		await mkdir(laneDirectory, { recursive: true });
		await writeFile(
			path.join(roundDirectory, "summary.json"),
			`${JSON.stringify({
				apiVersion: "gatekeeper/v1",
				id: "R1",
				cycle_id: created.cycle.id,
				number: 1,
				status: "REVIEWING",
				subject_fingerprint: { head: "abc123", porcelain: "", trackedDiff: "", untracked: [] },
				lane_ids: ["L1-claude"],
				lane_results: [],
				started_at: AT,
			})}\n`,
			"utf8",
		);
		await writeFile(
			path.join(laneDirectory, "meta.json"),
			`${JSON.stringify({
				apiVersion: "gatekeeper/v1",
				id: "L1-claude",
				cycle_id: created.cycle.id,
				round: 1,
				cli: "claude",
				vendor: "anthropic",
				command: "claude review",
				required: true,
				status: "PENDING",
				brief_path: "rounds/R1/lanes/L1-claude/brief.md",
				stdout_path: "rounds/R1/lanes/L1-claude/stdout.log",
				stderr_path: "rounds/R1/lanes/L1-claude/stderr.log",
				out_path: "rounds/R1/lanes/L1-claude/out",
				result_path: "rounds/R1/lanes/L1-claude/out/VERDICT.json",
			})}\n`,
			"utf8",
		);

		await expect(loadCycle(created.cycle.id, dependencies.env)).rejects.toMatchObject({
			code: "CORRUPT",
			file: path.join(roundDirectory, "summary.json"),
		});
	});

	it("rejects unsafe ids before resolving a filesystem path", async () => {
		const configDirectory = await makeConfigDirectory("gatekeeper-review-path-");
		const env = { GATEKEEPER_CONFIG_DIR: configDirectory };
		expect(() => reviewCycleDirectory("../outside", env)).toThrow(ReviewStoreError);
		await expect(loadCycle("../outside", env)).rejects.toMatchObject({ code: "INVALID_DATA" });
	});
});
