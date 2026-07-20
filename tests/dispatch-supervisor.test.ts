import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRunError, type AgentRunOptions, type AgentRunResult } from "../src/agent/runner.js";
import type { DeliveryEvidence, GitExecutor } from "../src/dispatch/evidence.js";
import {
	appendJournalEvent,
	type CreateWorkOrderInput,
	createOrder,
	dispatchOrderDirectory,
	loadOrder,
} from "../src/dispatch/store.js";
import {
	DISPATCH_MAX_RUN_SECONDS,
	DISPATCH_STALL_SECONDS,
	type DispatchTimerScheduler,
	resolveDispatchMaxRunSeconds,
	superviseWorkOrder,
} from "../src/dispatch/supervisor.js";
import type { Run, WorkOrder } from "../src/dispatch/types.js";
import { DispatchWorkspaceError, type WorkspaceFingerprint } from "../src/dispatch/workspace.js";
import type { LoadedReviewCycle } from "../src/review/store.js";

const temporaryDirectories: string[] = [];
let dependencySet = 0;

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const noEvidence: DeliveryEvidence = {
	resultFile: { established: false, reason: "missing", message: "missing" },
	commit: { established: false, reason: "no-commits", commitSubjects: [] },
};

const deliveredEvidence: DeliveryEvidence = {
	resultFile: {
		established: true,
		result: { apiVersion: "gatekeeper/v1", status: "delivered", summary: "done" },
	},
	commit: { established: true, commitSubjects: ["implement"], nonWipCommitSubjects: ["implement"] },
};

const blockedEvidence: DeliveryEvidence = {
	resultFile: {
		established: true,
		result: { apiVersion: "gatekeeper/v1", status: "blocked", summary: "needs operator input" },
	},
	commit: { established: false, reason: "no-commits", commitSubjects: [] },
};

interface SetupResult {
	configDirectory: string;
	targetDirectory: string;
	env: NodeJS.ProcessEnv;
	order: WorkOrder;
}

async function setup(
	ladder?: WorkOrder["candidate_ladder"],
	targetDirectory?: string,
	paths?: { resultPath: string; progressPath: string },
): Promise<SetupResult> {
	const configDirectory = await mkdtemp(path.join(tmpdir(), "gatekeeper-supervisor-config-"));
	temporaryDirectories.push(configDirectory);
	const target = targetDirectory ?? (await mkdtemp(path.join(tmpdir(), "gatekeeper-supervisor-target-")));
	if (!targetDirectory) {
		temporaryDirectories.push(target);
	}
	const env = { GATEKEEPER_CONFIG_DIR: configDirectory };
	const input: CreateWorkOrderInput = {
		association_key: "acme/widgets#42",
		target_repo: { name: "acme/widgets", path: target },
		brief: "Implement the acceptance contract.\n",
		acceptance_contract: {
			result_path: paths?.resultPath ?? "out/RESULT.json",
			progress_path: paths?.progressPath ?? "out/PROGRESS.md",
			require_non_wip_commit: true,
			criteria: ["tests pass"],
		},
		candidate_ladder: ladder ?? [{ cli: "codex", vendor: "openai", command: "codex exec {brief} {out}" }],
	};
	const created = await createOrder(input, {
		env,
		now: () => new Date("2026-07-20T00:00:00.000Z"),
		randomUUID: () => `order-${temporaryDirectories.length}`,
	});
	return { configDirectory, targetDirectory: target, env, order: created.order };
}

class RecordingTimers implements DispatchTimerScheduler {
	readonly delays: number[] = [];
	private fireStall: boolean;
	private fired = false;

	constructor(fireStall = false) {
		this.fireStall = fireStall;
	}

	set(delayMs: number, callback: () => void): { cleared: boolean } {
		const handle = { cleared: false };
		this.delays.push(delayMs);
		if (this.fireStall && !this.fired && delayMs === DISPATCH_STALL_SECONDS * 1000) {
			this.fired = true;
			queueMicrotask(() => {
				if (!handle.cleared) {
					callback();
				}
			});
		}
		return handle;
	}

	clear(handle: unknown): void {
		(handle as { cleared: boolean }).cleared = true;
	}
}

type Script =
	| { kind: "deliver"; activity?: boolean }
	| { kind: "error"; stderr: string; exitCode?: number }
	| { kind: "signal" }
	| { kind: "timeout" }
	| { kind: "stall" };

function scriptedRunner(scripts: readonly Script[]) {
	let index = 0;
	return vi.fn(async (options: AgentRunOptions): Promise<AgentRunResult> => {
		const script = scripts[index++];
		if (!script) {
			throw new Error("unexpected runner call");
		}
		options.onSpawn?.({ pid: 1_000 + index, pgid: 1_000 + index });
		if (script.kind === "deliver") {
			if (script.activity) {
				options.onActivity?.({ stream: "stdout", timestampMs: 123 });
			}
			return { stdout: "delivered", stderr: "" };
		}
		if (script.kind === "error") {
			throw new AgentRunError("nonzero-exit", "agent failed", {
				command: options.command,
				exitCode: script.exitCode ?? 1,
				signal: null,
				stderrTail: script.stderr,
			});
		}
		if (script.kind === "signal") {
			throw new AgentRunError("nonzero-exit", "agent was signalled", {
				command: options.command,
				exitCode: null,
				signal: "SIGTERM",
			});
		}
		if (script.kind === "timeout") {
			throw new AgentRunError("timeout", "agent exceeded wall-clock timeout", {
				command: options.command,
				exitCode: null,
				signal: "SIGTERM",
			});
		}
		return new Promise((_resolve, reject) => {
			options.signal?.addEventListener(
				"abort",
				() => {
					reject(
						new AgentRunError("external-abort", "stalled", {
							command: options.command,
							exitCode: null,
							signal: "SIGTERM",
						}),
					);
				},
				{ once: true },
			);
		});
	});
}

function dependencies(
	setupResult: SetupResult,
	options: {
		runner: ReturnType<typeof scriptedRunner>;
		evidence: readonly DeliveryEvidence[];
		timers?: RecordingTimers;
		snapshots?: readonly { hadChanges: boolean; commitCreated: boolean; gitEvidenceAvailable: boolean }[];
		heads?: readonly string[];
		fingerprints?: readonly WorkspaceFingerprint[];
		handoff?: ReturnType<typeof vi.fn>;
	} & Omit<
		Partial<Parameters<typeof superviseWorkOrder>[1]>,
		"runner" | "evidence" | "timers" | "workspaceFingerprint" | "handoff"
	>,
): Parameters<typeof superviseWorkOrder>[1] {
	const { runner, evidence, timers, snapshots, heads, fingerprints, handoff, ...overrides } = options;
	const dependencyPrefix = ++dependencySet;
	let id = 0;
	let instant = Date.parse("2026-07-20T01:00:00.000Z");
	let evidenceIndex = 0;
	let snapshotIndex = 0;
	let headIndex = 0;
	const git: GitExecutor = { exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })) };
	return {
		env: setupResult.env,
		pid: 777,
		now: () => {
			const current = new Date(instant);
			instant += 1_000;
			return current;
		},
		idGenerator: () => `supervisor-${dependencyPrefix}-${++id}`,
		isProcessAlive: (candidate) => candidate === 777,
		git,
		runner,
		timers: timers ?? new RecordingTimers(),
		prepareWorkspace: vi.fn(async (input) => {
			await input.onBaseResolved?.("base-oid");
			return {
				branch: `gatekeeper/dispatch/${input.orderId}`,
				baseRef: input.baseRef,
				baseOid: "base-oid",
			};
		}),
		resolveBaseOid: vi.fn(async (baseRef) => (baseRef === "base-oid" ? baseRef : "base-oid")),
		activateWorkspace: vi.fn(async () => undefined),
		snapshot: vi.fn(
			async () =>
				snapshots?.[snapshotIndex++] ?? {
					hadChanges: false,
					commitCreated: false,
					gitEvidenceAvailable: true,
				},
		),
		workspaceFingerprint: vi.fn(async () => {
			const index = headIndex++;
			return (
				fingerprints?.[index] ?? {
					head: heads?.[index] ?? "head",
					porcelain: "",
					trackedDiff: "",
					untracked: [],
				}
			);
		}),
		evidence: vi.fn(async () => evidence[evidenceIndex++] ?? noEvidence),
		handoff: handoff ?? vi.fn(async (input) => ({ content: `${input.originalBrief}\nHANDOFF\n`, warnings: [] })),
		...overrides,
	};
}

async function writeActiveRun(setupResult: SetupResult, run: Run): Promise<void> {
	const directory = path.join(dispatchOrderDirectory(setupResult.order.id, setupResult.env), "runs", run.id);
	await mkdir(path.join(directory, "out"), { recursive: true });
	await writeFile(path.join(directory, "brief.md"), "brief\n", "utf8");
	await writeFile(path.join(directory, "stdout.log"), "", "utf8");
	await writeFile(path.join(directory, "stderr.log"), "", "utf8");
	await writeFile(path.join(directory, "meta.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

function activeRunFor(setupResult: SetupResult): Run {
	return {
		apiVersion: "gatekeeper/v1",
		id: "r001",
		cli: setupResult.order.candidate_ladder[0]?.cli ?? "codex",
		vendor: setupResult.order.candidate_ladder[0]?.vendor ?? "openai",
		command: setupResult.order.candidate_ladder[0]?.command ?? "codex exec {brief} {out}",
		brief_path: "runs/r001/brief.md",
		pid: 111,
		pgid: 222,
		started_at: "2026-07-20T00:30:00.000Z",
		stdout_path: "runs/r001/stdout.log",
		stderr_path: "runs/r001/stderr.log",
		out_path: "runs/r001/out",
	};
}

function reviewCycleFor(
	targetDirectory: string,
	state: LoadedReviewCycle["state"],
	id = "rc-conflicting-cycle",
): LoadedReviewCycle {
	return {
		cycle: {
			apiVersion: "gatekeeper/v1",
			id,
			subject: { kind: "diff", repo: "acme/widgets", base_ref: "main" },
			target_repo: { name: "acme/widgets", path: targetDirectory },
			authoring_vendors: [],
			max_rounds: 3,
			lane_snapshot: [
				{ id: "L1-claude", cli: "claude", vendor: "anthropic", command: "claude -p {brief}", required: true },
			],
			degraded: false,
			created_at: "2026-07-21T00:00:00.000Z",
		},
		subject: "Review the diff.\n",
		journal: [],
		state,
		rounds: [],
	};
}

describe("dispatch supervision loop", () => {
	it("switches immediately after a rate limit, delivers, and records author/reviewer conflict data", async () => {
		const setupResult = await setup([
			{ cli: "codex", vendor: "openai", command: "codex exec {brief} {out}" },
			{ cli: "claude", vendor: "anthropic", command: "claude -p {brief} {out}" },
		]);
		const runner = scriptedRunner([
			{ kind: "error", stderr: "You've hit your Codex usage limit; try again in 1h" },
			{ kind: "deliver", activity: true },
		]);
		const timers = new RecordingTimers();
		const handoff = vi.fn(async (input) => ({ content: `${input.originalBrief}\nHANDOFF\n`, warnings: [] }));
		const deps = dependencies(setupResult, {
			runner,
			evidence: [noEvidence, deliveredEvidence],
			timers,
			snapshots: [
				{ hadChanges: false, commitCreated: false, gitEvidenceAvailable: true },
				{ hadChanges: true, commitCreated: true, gitEvidenceAvailable: true },
			],
			heads: ["a", "a", "a", "b"],
			handoff,
		});

		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main", reviewerVendor: "anthropic" },
			deps,
		);

		expect(result.state).toBe("DELIVERED");
		expect(result.runs.map((run) => run.outcome)).toEqual(["RATE_LIMITED", "COMPLETED"]);
		expect(result.authoringVendors).toEqual(["anthropic"]);
		expect(result.reviewerConflict).toEqual({
			code: "REVIEWER_VENDOR_CONFLICT",
			reviewerVendor: "anthropic",
			authoringVendors: ["anthropic"],
			suggestedVendors: ["openai"],
		});
		expect(handoff).toHaveBeenCalledOnce();
		expect(timers.delays).toContain(DISPATCH_STALL_SECONDS * 1000);
		expect(timers.delays).toContain(DISPATCH_MAX_RUN_SECONDS * 1000);
		const loaded = await loadOrder(setupResult.order.id, setupResult.env);
		expect(loaded.journal.map((event) => event.type)).toEqual([
			"ORDER_CREATED",
			"RUN_STARTED",
			"RUN_RETRY_SCHEDULED",
			"ORDER_DELIVERED",
		]);
	});

	it("retries one transient failure on the same agent, then stops at NEEDS_ATTENTION", async () => {
		const setupResult = await setup();
		const runner = scriptedRunner([
			{ kind: "error", stderr: "compiler failed", exitCode: 2 },
			{ kind: "error", stderr: "compiler still failed", exitCode: 2 },
		]);

		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, { runner, evidence: [noEvidence, noEvidence] }),
		);

		expect(result.state).toBe("NEEDS_ATTENTION");
		expect(result.runs.map((run) => [run.cli, run.outcome])).toEqual([
			["codex", "AGENT_ERROR"],
			["codex", "AGENT_ERROR"],
		]);
		expect(runner).toHaveBeenCalledTimes(2);
	});

	it("resumes an exhausted ladder with one explicit override and delivers", async () => {
		const setupResult = await setup();
		const exhausted = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([
					{ kind: "error", stderr: "first failure" },
					{ kind: "error", stderr: "second failure" },
				]),
				evidence: [noEvidence, noEvidence],
			}),
		);
		expect(exhausted.state).toBe("NEEDS_ATTENTION");

		const override = { cli: "gemini", vendor: "google", command: "gemini run {brief} {out}" };
		const resumedRunner = scriptedRunner([{ kind: "deliver" }]);
		const resumed = await superviseWorkOrder(
			{
				orderId: setupResult.order.id,
				baseRef: "main",
				resumeFromAttention: true,
				agentOverride: override,
			},
			dependencies(setupResult, {
				runner: resumedRunner,
				evidence: [deliveredEvidence],
				heads: ["before-override", "after-override"],
			}),
		);

		expect(resumed.state).toBe("DELIVERED");
		expect(resumed.runs.map((run) => [run.cli, run.outcome])).toEqual([
			["codex", "AGENT_ERROR"],
			["codex", "AGENT_ERROR"],
			["gemini", "COMPLETED"],
		]);
		expect(resumed.authoringVendors).toEqual(["google"]);
		expect((resumedRunner.mock.calls[0]?.[0] as AgentRunOptions | undefined)?.command).toContain("gemini");
		expect((await loadOrder(setupResult.order.id, setupResult.env)).journal.map((event) => event.type)).toEqual([
			"ORDER_CREATED",
			"RUN_STARTED",
			"RUN_RETRY_SCHEDULED",
			"ATTENTION_REQUIRED",
			"ORDER_RESUMED",
			"ORDER_DELIVERED",
		]);
	});

	it("keeps the existing NEEDS_ATTENTION early return byte-for-byte when no resume intent is passed", async () => {
		const setupResult = await setup();
		const attention = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([
					{ kind: "error", stderr: "first failure" },
					{ kind: "error", stderr: "second failure" },
				]),
				evidence: [noEvidence, noEvidence],
			}),
		);
		const journalFile = path.join(dispatchOrderDirectory(setupResult.order.id, setupResult.env), "journal.jsonl");
		const beforeJournal = await readFile(journalFile, "utf8");
		const runner = scriptedRunner([]);

		const unchanged = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, { runner, evidence: [] }),
		);

		expect(unchanged).toEqual({
			orderId: setupResult.order.id,
			state: "NEEDS_ATTENTION",
			runs: attention.runs,
			authoringVendors: [],
			resumeHint: `gatekeeper dispatch resume ${setupResult.order.id}`,
			warnings: [],
		});
		expect(await readFile(journalFile, "utf8")).toBe(beforeJournal);
		expect(runner).not.toHaveBeenCalled();
	});

	it("resumes without an override at the next unexhausted frozen candidate", async () => {
		const setupResult = await setup([
			{ cli: "codex", vendor: "openai", command: "codex exec {brief} {out}" },
			{ cli: "claude", vendor: "anthropic", command: "claude -p {brief} {out}" },
		]);
		const attention = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([{ kind: "error", stderr: "blocked" }]),
				evidence: [blockedEvidence],
			}),
		);
		expect(attention.state).toBe("NEEDS_ATTENTION");

		const runner = scriptedRunner([{ kind: "deliver" }]);
		const resumed = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main", resumeFromAttention: true },
			dependencies(setupResult, { runner, evidence: [deliveredEvidence] }),
		);

		expect(resumed.state).toBe("DELIVERED");
		expect((runner.mock.calls[0]?.[0] as AgentRunOptions | undefined)?.command).toContain("claude");
	});

	it("explicitly refuses an attention resume after the total run cap without an override", async () => {
		const setupResult = await setup([
			{ cli: "codex", vendor: "v1", command: "codex 1 {brief} {out}" },
			{ cli: "codex", vendor: "v2", command: "codex 2 {brief} {out}" },
			{ cli: "codex", vendor: "v3", command: "codex 3 {brief} {out}" },
			{ cli: "codex", vendor: "v4", command: "codex 4 {brief} {out}" },
		]);
		const rateLimited = Array.from({ length: 4 }, () => ({
			kind: "error" as const,
			stderr: "You've hit your Codex usage limit; try again in 1h",
		}));
		const attention = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner(rateLimited),
				evidence: [noEvidence, noEvidence, noEvidence, noEvidence],
			}),
		);
		expect(attention.state).toBe("NEEDS_ATTENTION");
		const journalFile = path.join(dispatchOrderDirectory(setupResult.order.id, setupResult.env), "journal.jsonl");
		const beforeJournal = await readFile(journalFile, "utf8");
		const runner = scriptedRunner([]);

		const refused = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main", resumeFromAttention: true },
			dependencies(setupResult, { runner, evidence: [] }),
		);

		expect(refused.state).toBe("NEEDS_ATTENTION");
		expect(refused.runs).toHaveLength(4);
		expect(refused.resumeHint).toContain("total run cap of 4 is already exhausted");
		expect(refused.resumeHint).toContain("no agent override was supplied");
		expect(await readFile(journalFile, "utf8")).toBe(beforeJournal);
		expect(runner).not.toHaveBeenCalled();
	});

	it("folds and replays a truncated ORDER_RESUMED override before the run directory is published", async () => {
		const setupResult = await setup();
		await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([
					{ kind: "error", stderr: "first failure" },
					{ kind: "error", stderr: "second failure" },
				]),
				evidence: [noEvidence, noEvidence],
			}),
		);
		const override = { cli: "gemini", vendor: "google", command: "gemini run {brief} {out}" };
		await expect(
			superviseWorkOrder(
				{
					orderId: setupResult.order.id,
					baseRef: "main",
					resumeFromAttention: true,
					agentOverride: override,
				},
				dependencies(setupResult, {
					runner: scriptedRunner([]),
					evidence: [],
					beforeRunPublish: async () => {
						throw new Error("simulated attention resume publication crash");
					},
				}),
			),
		).rejects.toThrow("simulated attention resume publication crash");

		const truncated = await loadOrder(setupResult.order.id, setupResult.env);
		expect(truncated.state).toBe("RUNNING");
		expect(truncated.runs).toHaveLength(2);
		expect(truncated.journal.at(-1)).toMatchObject({
			type: "ORDER_RESUMED",
			from: "NEEDS_ATTENTION",
			to: "RUNNING",
			new_run_id: "r003",
		});

		const replayRunner = scriptedRunner([{ kind: "deliver" }]);
		const replayed = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, { runner: replayRunner, evidence: [deliveredEvidence] }),
		);

		expect(replayed.state).toBe("DELIVERED");
		expect(replayed.runs.at(-1)).toMatchObject({ id: "r003", cli: "gemini", vendor: "google", outcome: "COMPLETED" });
		expect((replayRunner.mock.calls[0]?.[0] as AgentRunOptions | undefined)?.command).toContain("gemini");
	});

	it("replaces a stale override schedule after journal append fails before a no-override replay", async () => {
		const setupResult = await setup([
			{ cli: "codex", vendor: "openai", command: "codex exec {brief} {out}" },
			{ cli: "claude", vendor: "anthropic", command: "claude -p {brief} {out}" },
		]);
		await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([{ kind: "error", stderr: "blocked" }]),
				evidence: [blockedEvidence],
			}),
		);

		await expect(
			superviseWorkOrder(
				{
					orderId: setupResult.order.id,
					baseRef: "main",
					resumeFromAttention: true,
					agentOverride: { cli: "gemini", vendor: "google", command: "gemini run {brief} {out}" },
				},
				dependencies(setupResult, {
					runner: scriptedRunner([]),
					evidence: [],
					append: async (_orderId, event) => {
						if (event.type === "ORDER_RESUMED") {
							throw new Error("simulated ORDER_RESUMED append failure");
						}
					},
				}),
			),
		).rejects.toThrow("simulated ORDER_RESUMED append failure");
		expect((await loadOrder(setupResult.order.id, setupResult.env)).state).toBe("NEEDS_ATTENTION");

		await expect(
			superviseWorkOrder(
				{ orderId: setupResult.order.id, baseRef: "main", resumeFromAttention: true },
				dependencies(setupResult, {
					runner: scriptedRunner([]),
					evidence: [],
					beforeRunPublish: async () => {
						throw new Error("simulated frozen-candidate publication crash");
					},
				}),
			),
		).rejects.toThrow("simulated frozen-candidate publication crash");

		const truncated = await loadOrder(setupResult.order.id, setupResult.env);
		expect(truncated.state).toBe("RUNNING");
		expect(truncated.journal.at(-1)).toMatchObject({ type: "ORDER_RESUMED", new_run_id: "r002" });
		const replayRunner = scriptedRunner([{ kind: "deliver" }]);
		const replayed = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, { runner: replayRunner, evidence: [deliveredEvidence] }),
		);

		expect(replayed.state).toBe("DELIVERED");
		expect(replayed.runs.at(-1)).toMatchObject({ id: "r002", cli: "claude", vendor: "anthropic" });
		expect((replayRunner.mock.calls[0]?.[0] as AgentRunOptions | undefined)?.command).toContain("claude");
	});

	it("persists each scheduling transition before invoking the corresponding runner action", async () => {
		const setupResult = await setup([
			{ cli: "codex", vendor: "openai", command: "codex exec {brief} {out}" },
			{ cli: "claude", vendor: "anthropic", command: "claude -p {brief} {out}" },
		]);
		const trace: string[] = [];
		const scripted = scriptedRunner([
			{ kind: "error", stderr: "You've hit your Codex usage limit; try again in 1h" },
			{ kind: "deliver" },
		]);
		const runner = vi.fn(async (options: AgentRunOptions) => {
			trace.push(`runner:${options.command.split(" ")[0]}`);
			return scripted(options);
		});
		const activateWorkspace = vi.fn(async () => undefined);
		const deps = dependencies(setupResult, {
			runner,
			evidence: [noEvidence, deliveredEvidence],
			activateWorkspace,
			append: async (orderId, event, env) => {
				trace.push(`journal:${event.type}`);
				await appendJournalEvent(orderId, event, env);
			},
		});

		await superviseWorkOrder({ orderId: setupResult.order.id, baseRef: "main" }, deps);

		expect(trace.indexOf("journal:RUN_STARTED")).toBeLessThan(trace.indexOf("runner:codex"));
		expect(trace.indexOf("journal:RUN_RETRY_SCHEDULED")).toBeLessThan(trace.indexOf("runner:claude"));
		expect(activateWorkspace).toHaveBeenCalledTimes(2);
	});

	it("passes the concrete frozen result path to runner and the frozen progress path to handoff", async () => {
		const setupResult = await setup(undefined, undefined, {
			resultPath: "artifacts/final-result.json",
			progressPath: "notes/checkpoint.md",
		});
		const runner = scriptedRunner([{ kind: "error", stderr: "compiler failed", exitCode: 2 }, { kind: "deliver" }]);
		const handoff = vi.fn(async (input) => ({ content: input.originalBrief, warnings: [] }));

		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, { runner, evidence: [noEvidence, deliveredEvidence], handoff }),
		);

		expect(result.state).toBe("DELIVERED");
		for (const call of runner.mock.calls) {
			expect((call[0] as AgentRunOptions).outPath).toMatch(/\/artifacts\/final-result\.json$/);
		}
		expect(handoff.mock.calls[0]?.[0]).toMatchObject({ progressPath: "notes/checkpoint.md" });
	});

	it("publishes a run directory atomically and safely resumes after a pre-rename crash", async () => {
		const setupResult = await setup();
		const firstRunner = scriptedRunner([]);
		await expect(
			superviseWorkOrder(
				{ orderId: setupResult.order.id, baseRef: "main" },
				dependencies(setupResult, {
					runner: firstRunner,
					evidence: [],
					beforeRunPublish: async () => {
						throw new Error("simulated publication crash");
					},
				}),
			),
		).rejects.toThrow("simulated publication crash");
		const prefix = await loadOrder(setupResult.order.id, setupResult.env);
		expect(prefix.state).toBe("RUNNING");
		expect(prefix.runs).toEqual([]);
		expect(firstRunner).not.toHaveBeenCalled();

		const resumedRunner = scriptedRunner([{ kind: "deliver" }]);
		const resumedDependencies = dependencies(setupResult, {
			runner: resumedRunner,
			evidence: [deliveredEvidence],
			resolveBaseOid: vi.fn(async (baseRef) => {
				expect(baseRef).toBe("base-oid");
				return "base-oid";
			}),
		});
		const resumed = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main-moved" },
			resumedDependencies,
		);
		expect(resumed.state).toBe("DELIVERED");
		expect(resumed.runs.map((run) => run.id)).toEqual(["r001"]);
		expect((resumedDependencies.evidence as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
			baseRef: "base-oid",
		});
	});

	it("does not credit a fallback vendor for inherited dirty state after a failed snapshot", async () => {
		const setupResult = await setup([
			{ cli: "codex", vendor: "openai", command: "codex exec {brief} {out}" },
			{ cli: "claude", vendor: "anthropic", command: "claude -p {brief} {out}" },
		]);
		const fingerprints: WorkspaceFingerprint[] = [
			{ head: "a", porcelain: "", trackedDiff: "", untracked: [] },
			{ head: "a", porcelain: " M src/work.ts\n", trackedDiff: "content-v1", untracked: [] },
			{ head: "a", porcelain: " M src/work.ts\n", trackedDiff: "content-v1", untracked: [] },
			{ head: "a", porcelain: " M src/work.ts\n", trackedDiff: "content-v1", untracked: [] },
		];
		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([
					{ kind: "error", stderr: "You've hit your Codex usage limit; try again in 1h" },
					{ kind: "deliver" },
				]),
				evidence: [noEvidence, deliveredEvidence],
				fingerprints,
				snapshots: [
					{ hadChanges: true, commitCreated: false, gitEvidenceAvailable: false },
					{ hadChanges: true, commitCreated: false, gitEvidenceAvailable: false },
				],
			}),
		);

		expect(result.state).toBe("DELIVERED");
		expect(result.authoringVendors).toEqual(["openai"]);
	});

	it("credits a vendor when content changes while HEAD and porcelain stay identical", async () => {
		const setupResult = await setup();
		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([{ kind: "deliver" }]),
				evidence: [deliveredEvidence],
				fingerprints: [
					{ head: "same", porcelain: " M src/work.ts\0", trackedDiff: "old bytes", untracked: [] },
					{ head: "same", porcelain: " M src/work.ts\0", trackedDiff: "new bytes", untracked: [] },
				],
			}),
		);

		expect(result.state).toBe("DELIVERED");
		expect(result.authoringVendors).toEqual(["openai"]);
	});

	it("uses activity and wall timers concurrently, aborts a stalled process group through runner B, then switches", async () => {
		const setupResult = await setup([
			{ cli: "codex", vendor: "openai", command: "codex exec {brief} {out}" },
			{ cli: "claude", vendor: "anthropic", command: "claude -p {brief} {out}" },
		]);
		const timers = new RecordingTimers(true);
		const runner = scriptedRunner([{ kind: "stall" }, { kind: "deliver" }]);
		const handoff = vi.fn(async (input) => ({ content: `${input.originalBrief}\nHANDOFF\n`, warnings: [] }));

		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner,
				evidence: [blockedEvidence, deliveredEvidence],
				timers,
				snapshots: [
					{ hadChanges: true, commitCreated: false, gitEvidenceAvailable: false },
					{ hadChanges: false, commitCreated: false, gitEvidenceAvailable: true },
				],
				handoff,
			}),
		);

		expect(result.state).toBe("DELIVERED");
		expect(result.runs.map((run) => run.outcome)).toEqual(["STALLED", "COMPLETED"]);
		expect((runner.mock.calls[0]?.[0] as AgentRunOptions | undefined)?.signal?.aborted).toBe(true);
		expect(handoff.mock.calls[0]?.[0]).toMatchObject({ includeGitEvidence: false });
		expect(timers.delays.filter((delay) => delay === DISPATCH_STALL_SECONDS * 1000)).toHaveLength(2);
		expect(timers.delays.filter((delay) => delay === DISPATCH_MAX_RUN_SECONDS * 1000)).toHaveLength(2);
	});

	it("keeps a supervisor-observed wall timeout ahead of blocked agent evidence and continues", async () => {
		const setupResult = await setup();
		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([{ kind: "timeout" }, { kind: "deliver" }]),
				evidence: [blockedEvidence, deliveredEvidence],
			}),
		);

		expect(result.state).toBe("DELIVERED");
		expect(result.runs.map((run) => run.outcome)).toEqual(["TIMEOUT", "COMPLETED"]);
	});

	it("waits for a stalled runner process group to die before snapshotting or switching", async () => {
		const setupResult = await setup([
			{ cli: "codex", vendor: "openai", command: "codex exec {brief} {out}" },
			{ cli: "claude", vendor: "anthropic", command: "claude -p {brief} {out}" },
		]);
		const trace: string[] = [];
		const probes = [true, false, false];
		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([{ kind: "stall" }, { kind: "deliver" }]),
				evidence: [noEvidence, deliveredEvidence],
				timers: new RecordingTimers(true),
				probeProcessGroup: () => probes.shift() ?? false,
				sleep: async (delay) => {
					trace.push(`sleep:${delay}`);
				},
				snapshot: vi.fn(async (runId) => {
					trace.push(`snapshot:${runId}`);
					return { hadChanges: false, commitCreated: false, gitEvidenceAvailable: true };
				}),
			}),
		);

		expect(result.state).toBe("DELIVERED");
		expect(trace.indexOf("sleep:5000")).toBeLessThan(trace.indexOf("snapshot:r001"));
	});

	it("keeps a timed-out active run conservative when pgid was never durably observed", async () => {
		const setupResult = await setup();
		const runner = vi.fn(
			async (options: AgentRunOptions): Promise<AgentRunResult> =>
				new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () => {
						reject(
							new AgentRunError("external-abort", "stalled", {
								command: options.command,
								exitCode: null,
								signal: "SIGTERM",
							}),
						);
					});
				}),
		);
		const snapshot = vi.fn();

		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner,
				evidence: [],
				timers: new RecordingTimers(true),
				snapshot,
			}),
		);

		expect(result.state).toBe("RUNNING");
		expect(result.orphan).toMatchObject({ runId: "r001", reason: "MISSING_PGID" });
		expect(result.runs[0]?.outcome).toBeUndefined();
		expect(snapshot).not.toHaveBeenCalled();
	});

	it("maps a natural signal-only runner termination to ORPHANED_UNKNOWN", async () => {
		const setupResult = await setup();
		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([{ kind: "signal" }, { kind: "deliver" }]),
				evidence: [noEvidence, deliveredEvidence],
			}),
		);

		expect(result.state).toBe("DELIVERED");
		expect(result.runs.map((run) => run.outcome)).toEqual(["ORPHANED_UNKNOWN", "COMPLETED"]);
		expect(result.runs[0]?.signal).toBe("SIGTERM");
	});

	it("keeps an explicit blocked RESULT ahead of a natural signal-only termination", async () => {
		const setupResult = await setup();
		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([{ kind: "signal" }]),
				evidence: [blockedEvidence],
			}),
		);

		expect(result.state).toBe("NEEDS_ATTENTION");
		expect(result.runs[0]?.outcome).toBe("AGENT_BLOCKED");
		expect(result.runs[0]?.signal).toBe("SIGTERM");
	});

	it("records an absolute cooldown and exits with a resume hint when no fallback is available", async () => {
		const setupResult = await setup();
		const runner = scriptedRunner([{ kind: "error", stderr: "You've hit your Codex usage limit; try again in 1h" }]);

		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, { runner, evidence: [noEvidence] }),
		);

		expect(result.state).toBe("WAITING_COOLDOWN");
		expect(result.resumeHint).toContain("gatekeeper dispatch resume");
		const loaded = await loadOrder(setupResult.order.id, setupResult.env);
		expect(loaded.journal.at(-1)).toMatchObject({ type: "COOLDOWN_STARTED", outcome: "RATE_LIMITED" });
		expect(Date.parse((loaded.journal.at(-1) as { resume_after: string }).resume_after)).toBeGreaterThan(
			Date.parse("2026-07-20T01:00:00.000Z"),
		);
	});

	it("reuses the persisted absolute cooldown when replaying a truncated journal prefix", async () => {
		const setupResult = await setup();
		const first = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([{ kind: "error", stderr: "You've hit your Codex usage limit; try again in 1h" }]),
				evidence: [noEvidence],
			}),
		);
		expect(first.state).toBe("WAITING_COOLDOWN");
		const orderDirectory = dispatchOrderDirectory(setupResult.order.id, setupResult.env);
		const journalFile = path.join(orderDirectory, "journal.jsonl");
		const lines = (await readFile(journalFile, "utf8")).trimEnd().split("\n");
		const firstResumeAfter = JSON.parse(lines.at(-1) ?? "{}").resume_after as string;
		await writeFile(journalFile, `${lines.slice(0, 2).join("\n")}\n`, "utf8");

		const replayed = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, { runner: scriptedRunner([]), evidence: [] }),
		);
		expect(replayed.state).toBe("WAITING_COOLDOWN");
		const replayLines = (await readFile(journalFile, "utf8")).trimEnd().split("\n");
		expect(JSON.parse(replayLines.at(-1) ?? "{}").resume_after).toBe(firstResumeAfter);
	});

	it("recovers a captured reset from durable stderr when a RATE sidecar is missing", async () => {
		const setupResult = await setup();
		const terminal: Run = {
			...activeRunFor(setupResult),
			ended_at: "2026-07-20T01:00:00.000Z",
			outcome: "RATE_LIMITED",
			exit_code: 1,
			signal: null,
		};
		await appendJournalEvent(
			setupResult.order.id,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: setupResult.order.id,
				at: "2026-07-20T00:59:00.000Z",
				run_id: terminal.id,
				from: "PENDING",
				to: "RUNNING",
			},
			setupResult.env,
		);
		await writeActiveRun(setupResult, terminal);
		await writeFile(
			path.join(dispatchOrderDirectory(setupResult.order.id, setupResult.env), terminal.stderr_path),
			"You've hit your Codex usage limit; try again in 47 minutes\n",
			"utf8",
		);

		const replayed = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, { runner: scriptedRunner([]), evidence: [] }),
		);
		expect(replayed.state).toBe("WAITING_COOLDOWN");
		const journal = (await loadOrder(setupResult.order.id, setupResult.env)).journal;
		expect(journal.at(-1)).toMatchObject({
			type: "COOLDOWN_STARTED",
			resume_after: "2026-07-20T01:47:00.000Z",
		});
	});

	it("rejects a dirty workspace before journaling RUN_STARTED", async () => {
		const setupResult = await setup();
		const runner = scriptedRunner([{ kind: "deliver" }]);
		const deps = dependencies(setupResult, {
			runner,
			evidence: [deliveredEvidence],
			prepareWorkspace: vi.fn(async () => {
				throw new DispatchWorkspaceError("DIRTY_WORKTREE", "dirty");
			}),
		});

		await expect(superviseWorkOrder({ orderId: setupResult.order.id, baseRef: "main" }, deps)).rejects.toMatchObject({
			code: "DIRTY_WORKTREE",
		});
		expect(runner).not.toHaveBeenCalled();
		expect((await loadOrder(setupResult.order.id, setupResult.env)).state).toBe("PENDING");
	});

	it("wires reuseBranch through prepare and every workspace activation", async () => {
		const setupResult = await setup();
		const deps = dependencies(setupResult, {
			runner: scriptedRunner([{ kind: "deliver" }]),
			evidence: [deliveredEvidence],
		});
		const reuseBranch = { branch: "gatekeeper/dispatch/wo-original" } as const;

		const result = await superviseWorkOrder({ orderId: setupResult.order.id, baseRef: "main", reuseBranch }, deps);

		expect(result.state).toBe("DELIVERED");
		expect(deps.prepareWorkspace).toHaveBeenCalledWith(
			expect.objectContaining({ orderId: setupResult.order.id, reuseBranch }),
			deps.git,
		);
		expect(deps.activateWorkspace).toHaveBeenCalledWith(setupResult.order.id, deps.git, reuseBranch);
	});

	it("refuses same-realpath concurrent supervision and reports the conflicting order id", async () => {
		const sharedTarget = await mkdtemp(path.join(tmpdir(), "gatekeeper-supervisor-shared-"));
		temporaryDirectories.push(sharedTarget);
		const first = await setup(undefined, sharedTarget);
		const secondInput: CreateWorkOrderInput = {
			association_key: "acme/widgets#43",
			target_repo: { name: "acme/widgets", path: sharedTarget },
			brief: "second\n",
			acceptance_contract: first.order.acceptance_contract,
			candidate_ladder: first.order.candidate_ladder,
		};
		const second = await createOrder(secondInput, {
			env: first.env,
			now: () => new Date("2026-07-20T00:01:00.000Z"),
			randomUUID: () => "second-order",
		});
		await writeFile(
			path.join(dispatchOrderDirectory(second.order.id, first.env), "supervisor.lock"),
			'{"pid":900,"started_at":"2026-07-20T00:30:00.000Z"}\n',
			"utf8",
		);
		const runner = scriptedRunner([{ kind: "deliver" }]);

		await expect(
			superviseWorkOrder(
				{ orderId: first.order.id, baseRef: "main" },
				dependencies(first, {
					runner,
					evidence: [deliveredEvidence],
					isProcessAlive: (pid) => pid === 777 || pid === 900,
				}),
			),
		).rejects.toMatchObject({
			code: "TARGET_REPOSITORY_BUSY",
			conflict: { conflictingOrderId: second.order.id },
		});
		expect(runner).not.toHaveBeenCalled();
	});

	it("refuses an active same-realpath review supervisor and reports the conflicting cycle id", async () => {
		const setupResult = await setup();
		const runner = scriptedRunner([{ kind: "deliver" }]);
		const cycle = reviewCycleFor(setupResult.targetDirectory, "REVIEWING");

		await expect(
			superviseWorkOrder(
				{ orderId: setupResult.order.id, baseRef: "main" },
				dependencies(setupResult, {
					runner,
					evidence: [deliveredEvidence],
					listReviewCycles: vi.fn(async () => [cycle]),
					readReviewSupervisorRecord: vi.fn(async () => ({
						pid: 900,
						started_at: "2026-07-21T00:00:00.000Z",
					})),
					isProcessAlive: (pid) => pid === 777 || pid === 900,
				}),
			),
		).rejects.toMatchObject({
			code: "TARGET_REPOSITORY_BUSY",
			message: expect.stringContaining(cycle.cycle.id),
			reviewConflict: { conflictingCycleId: cycle.cycle.id },
		});
		expect(runner).not.toHaveBeenCalled();
	});

	it("allows dispatch to proceed when a same-realpath review cycle is terminal", async () => {
		const setupResult = await setup();
		const readReviewSupervisorRecord = vi.fn(async () => ({
			pid: 900,
			started_at: "2026-07-21T00:00:00.000Z",
		}));
		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([{ kind: "deliver" }]),
				evidence: [deliveredEvidence],
				listReviewCycles: vi.fn(async () => [reviewCycleFor(setupResult.targetDirectory, "ACCEPTED")]),
				readReviewSupervisorRecord,
			}),
		);

		expect(result.state).toBe("DELIVERED");
		expect(readReviewSupervisorRecord).not.toHaveBeenCalled();
	});

	it("keeps the legacy successful result and journal when the review store is missing", async () => {
		const setupResult = await setup();
		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([{ kind: "deliver" }]),
				evidence: [deliveredEvidence],
			}),
		);

		expect(result).toMatchObject({
			orderId: setupResult.order.id,
			state: "DELIVERED",
			authoringVendors: [],
			warnings: [],
		});
		expect(result.runs.map((run) => run.outcome)).toEqual(["COMPLETED"]);
		expect((await loadOrder(setupResult.order.id, setupResult.env)).journal.map((event) => event.type)).toEqual([
			"ORDER_CREATED",
			"RUN_STARTED",
			"ORDER_DELIVERED",
		]);
	});

	it.each(["not-json\n", '{"pid":"bad","started_at":"not-an-instant"}\n'])(
		"fails conservatively when a same-repository peer lock is malformed: %s",
		async (lockContent) => {
			const sharedTarget = await mkdtemp(path.join(tmpdir(), "gatekeeper-supervisor-malformed-lock-"));
			temporaryDirectories.push(sharedTarget);
			const first = await setup(undefined, sharedTarget);
			const peer = await createOrder(
				{
					association_key: "acme/widgets#44",
					target_repo: { name: "acme/widgets", path: sharedTarget },
					brief: "peer\n",
					acceptance_contract: first.order.acceptance_contract,
					candidate_ladder: first.order.candidate_ladder,
				},
				{
					env: first.env,
					now: () => new Date("2026-07-20T00:02:00.000Z"),
					randomUUID: () => "malformed-peer",
				},
			);
			await writeFile(
				path.join(dispatchOrderDirectory(peer.order.id, first.env), "supervisor.lock"),
				lockContent,
				"utf8",
			);
			const runner = scriptedRunner([{ kind: "deliver" }]);

			await expect(
				superviseWorkOrder(
					{ orderId: first.order.id, baseRef: "main" },
					dependencies(first, { runner, evidence: [deliveredEvidence] }),
				),
			).rejects.toMatchObject({ code: "MALFORMED_PEER_LOCK" });
			expect(runner).not.toHaveBeenCalled();
		},
	);

	it("repairs a dead-pgid orphan from a replayable journal prefix and continues without restarting", async () => {
		const setupResult = await setup();
		const active = activeRunFor(setupResult);
		await appendJournalEvent(
			setupResult.order.id,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: setupResult.order.id,
				at: "2026-07-20T00:30:00.000Z",
				run_id: active.id,
				from: "PENDING",
				to: "RUNNING",
			},
			setupResult.env,
		);
		await writeActiveRun(setupResult, active);
		await writeFile(
			path.join(dispatchOrderDirectory(setupResult.order.id, setupResult.env), "supervisor.lock"),
			'{"pid":111,"started_at":"2026-07-20T00:30:00.000Z"}\n',
			"utf8",
		);
		const probe = vi.fn(() => false);
		const runner = scriptedRunner([{ kind: "deliver" }]);

		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner,
				evidence: [noEvidence, deliveredEvidence],
				probeProcessGroup: probe,
				isProcessAlive: (pid) => pid === 777,
			}),
		);

		expect(result.state).toBe("DELIVERED");
		expect(result.runs.map((run) => run.outcome)).toEqual(["ORPHANED_UNKNOWN", "COMPLETED"]);
		expect(probe).toHaveBeenCalledWith(222);
		const journal = (await loadOrder(setupResult.order.id, setupResult.env)).journal;
		expect(journal.map((event) => event.type)).toEqual([
			"ORDER_CREATED",
			"RUN_STARTED",
			"LOCK_TAKEN_OVER",
			"RUN_RETRY_SCHEDULED",
			"ORDER_DELIVERED",
		]);
	});

	it("reconstructs a truncated rate-limit prefix by skipping the cooled rung", async () => {
		const setupResult = await setup([
			{ cli: "codex", vendor: "openai", command: "codex exec {brief} {out}" },
			{ cli: "claude", vendor: "anthropic", command: "claude -p {brief} {out}" },
		]);
		const terminal: Run = {
			...activeRunFor(setupResult),
			ended_at: "2026-07-20T00:40:00.000Z",
			outcome: "RATE_LIMITED",
			exit_code: 1,
			signal: null,
		};
		await appendJournalEvent(
			setupResult.order.id,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: setupResult.order.id,
				at: "2026-07-20T00:30:00.000Z",
				run_id: terminal.id,
				from: "PENDING",
				to: "RUNNING",
			},
			setupResult.env,
		);
		await writeActiveRun(setupResult, terminal);
		await writeFile(
			path.join(dispatchOrderDirectory(setupResult.order.id, setupResult.env), "supervisor.lock"),
			'{"pid":111,"started_at":"2026-07-20T00:30:00.000Z"}\n',
			"utf8",
		);
		const runner = scriptedRunner([{ kind: "deliver" }]);

		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner,
				evidence: [deliveredEvidence],
				isProcessAlive: (pid) => pid === 777,
			}),
		);

		expect(result.state).toBe("DELIVERED");
		expect((runner.mock.calls[0]?.[0] as AgentRunOptions | undefined)?.command).toContain("claude");
		expect(result.runs.map((run) => run.outcome)).toEqual(["RATE_LIMITED", "COMPLETED"]);
	});

	it("reports a live orphan, while wait polls until death and then reconciles evidence", async () => {
		const setupResult = await setup();
		const active = activeRunFor(setupResult);
		await appendJournalEvent(
			setupResult.order.id,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: setupResult.order.id,
				at: "2026-07-20T00:30:00.000Z",
				run_id: active.id,
				from: "PENDING",
				to: "RUNNING",
			},
			setupResult.env,
		);
		await writeActiveRun(setupResult, active);
		const runner = scriptedRunner([]);
		const reportDeps = dependencies(setupResult, {
			runner,
			evidence: [],
			probeProcessGroup: () => true,
		});

		const report = await superviseWorkOrder({ orderId: setupResult.order.id, baseRef: "main" }, reportDeps);
		expect(report.orphan).toEqual({
			action: "report",
			runId: "r001",
			pgid: 222,
			reason: "LIVE_PROCESS_GROUP",
		});
		const probes = [true, true, false];
		const waitSleep = vi.fn(async () => undefined);
		const waitDeps = dependencies(setupResult, {
			runner,
			evidence: [deliveredEvidence],
			probeProcessGroup: () => probes.shift() ?? false,
			sleep: waitSleep,
		});
		const wait = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main", orphanAction: "wait" },
			waitDeps,
		);
		expect(wait.state).toBe("DELIVERED");
		expect(waitSleep).toHaveBeenCalledWith(1_000);
	});

	it("requires explicit confirm-dead to reconcile a resumed active run without pgid", async () => {
		const setupResult = await setup();
		const { pgid: _pgid, ...withoutPgid } = activeRunFor(setupResult);
		const active: Run = withoutPgid;
		await appendJournalEvent(
			setupResult.order.id,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: setupResult.order.id,
				at: "2026-07-20T00:30:00.000Z",
				run_id: active.id,
				from: "PENDING",
				to: "RUNNING",
			},
			setupResult.env,
		);
		await writeActiveRun(setupResult, active);
		const report = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, { runner: scriptedRunner([]), evidence: [] }),
		);
		expect(report.state).toBe("RUNNING");
		expect(report.orphan).toMatchObject({ runId: "r001", reason: "MISSING_PGID" });

		const confirmed = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main", orphanAction: "confirm-dead" },
			dependencies(setupResult, { runner: scriptedRunner([]), evidence: [deliveredEvidence] }),
		);
		expect(confirmed.state).toBe("DELIVERED");
		expect(confirmed.runs[0]?.outcome).toBe("COMPLETED");
	});

	it("requires confirm-dead to finish an already-journalled cancellation without pgid", async () => {
		const setupResult = await setup();
		const { pgid: _pgid, ...withoutPgid } = activeRunFor(setupResult);
		const active: Run = withoutPgid;
		await appendJournalEvent(
			setupResult.order.id,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: setupResult.order.id,
				at: "2026-07-20T00:30:00.000Z",
				run_id: active.id,
				from: "PENDING",
				to: "RUNNING",
			},
			setupResult.env,
		);
		await writeActiveRun(setupResult, active);
		await appendJournalEvent(
			setupResult.order.id,
			{
				apiVersion: "gatekeeper/v1",
				type: "ORDER_CANCELLED",
				order_id: setupResult.order.id,
				at: "2026-07-20T00:31:00.000Z",
				run_id: active.id,
				outcome: "KILLED",
				from: "RUNNING",
				to: "ABANDONED",
			},
			setupResult.env,
		);
		const probeProcessGroup = vi.fn(() => false);
		const terminateProcessGroup = vi.fn(async () => undefined);

		const report = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, {
				runner: scriptedRunner([]),
				evidence: [],
				probeProcessGroup,
				terminateProcessGroup,
			}),
		);
		expect(report.state).toBe("ABANDONED");
		expect(report.orphan).toMatchObject({ runId: "r001", reason: "MISSING_PGID" });
		expect(report.runs[0]?.outcome).toBeUndefined();

		const snapshot = vi.fn(async () => ({
			hadChanges: false,
			commitCreated: false,
			gitEvidenceAvailable: true,
		}));
		const confirmed = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main", orphanAction: "confirm-dead" },
			dependencies(setupResult, {
				runner: scriptedRunner([]),
				evidence: [],
				probeProcessGroup,
				terminateProcessGroup,
				snapshot,
			}),
		);
		expect(confirmed.state).toBe("ABANDONED");
		expect(confirmed.runs[0]?.outcome).toBe("KILLED");
		expect(snapshot).toHaveBeenCalledOnce();
		expect(probeProcessGroup).not.toHaveBeenCalled();
		expect(terminateProcessGroup).not.toHaveBeenCalled();
	});

	it("replays a crash-after-journal orphan kill through TERM, grace, KILL, snapshot, and terminal meta", async () => {
		const setupResult = await setup();
		const active = activeRunFor(setupResult);
		await appendJournalEvent(
			setupResult.order.id,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: setupResult.order.id,
				at: "2026-07-20T00:30:00.000Z",
				run_id: active.id,
				from: "PENDING",
				to: "RUNNING",
			},
			setupResult.env,
		);
		await writeActiveRun(setupResult, active);
		await appendJournalEvent(
			setupResult.order.id,
			{
				apiVersion: "gatekeeper/v1",
				type: "ORDER_CANCELLED",
				order_id: setupResult.order.id,
				at: "2026-07-20T00:31:00.000Z",
				run_id: active.id,
				outcome: "KILLED",
				from: "RUNNING",
				to: "ABANDONED",
			},
			setupResult.env,
		);

		const order: string[] = [];
		const probes = [true, true, false];
		const snapshot = vi.fn(async () => {
			order.push("snapshot");
			return { hadChanges: false, commitCreated: false, gitEvidenceAvailable: true };
		});
		const killDeps = dependencies(setupResult, {
			runner: scriptedRunner([]),
			evidence: [],
			probeProcessGroup: () => probes.shift() ?? false,
			sleep: async (delay) => {
				order.push(`sleep:${delay}`);
			},
			terminateProcessGroup: async (pgid, signal) => {
				order.push(`${signal}:${pgid}`);
			},
			snapshot,
		});
		const killed = await superviseWorkOrder({ orderId: setupResult.order.id, baseRef: "main" }, killDeps);
		expect(killed.state).toBe("ABANDONED");
		expect(killed.runs[0]?.outcome).toBe("KILLED");
		expect(order).toEqual(["SIGTERM:222", "sleep:5000", "SIGKILL:222", "sleep:0", "snapshot"]);
	});

	it("journals an operator orphan kill before sending SIGTERM", async () => {
		const setupResult = await setup();
		const active = activeRunFor(setupResult);
		await appendJournalEvent(
			setupResult.order.id,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: setupResult.order.id,
				at: "2026-07-20T00:30:00.000Z",
				run_id: active.id,
				from: "PENDING",
				to: "RUNNING",
			},
			setupResult.env,
		);
		await writeActiveRun(setupResult, active);
		const trace: string[] = [];
		const probes = [true, true, false, false];
		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main", orphanAction: "kill" },
			dependencies(setupResult, {
				runner: scriptedRunner([]),
				evidence: [],
				probeProcessGroup: () => probes.shift() ?? false,
				append: async (orderId, event, env) => {
					trace.push(`journal:${event.type}`);
					await appendJournalEvent(orderId, event, env);
				},
				terminateProcessGroup: async (_pgid, signal) => {
					trace.push(signal);
				},
				sleep: async () => undefined,
			}),
		);

		expect(result.state).toBe("ABANDONED");
		expect(trace.indexOf("journal:ORDER_CANCELLED")).toBeLessThan(trace.indexOf("SIGTERM"));
	});

	it("uses the dedicated wall-time environment override without touching the agent timeout cap", () => {
		expect(resolveDispatchMaxRunSeconds({ DISPATCH_MAX_RUN_SECONDS: "8100" })).toBe(8_100);
		expect(resolveDispatchMaxRunSeconds({ GATEKEEPER_DISPATCH_MAX_RUN_SECONDS: "8200" })).toBe(8_200);
		expect(resolveDispatchMaxRunSeconds({})).toBe(DISPATCH_MAX_RUN_SECONDS);
	});

	it("persists RATE_LIMITED at run four but uses the package-A compatible attention outcome", async () => {
		const setupResult = await setup([
			{ cli: "codex", vendor: "v1", command: "codex 1 {brief} {out}" },
			{ cli: "codex", vendor: "v2", command: "codex 2 {brief} {out}" },
			{ cli: "codex", vendor: "v3", command: "codex 3 {brief} {out}" },
			{ cli: "codex", vendor: "v4", command: "codex 4 {brief} {out}" },
		]);
		const runner = scriptedRunner(
			Array.from({ length: 4 }, () => ({
				kind: "error" as const,
				stderr: "You've hit your Codex usage limit; try again in 1h",
			})),
		);

		const result = await superviseWorkOrder(
			{ orderId: setupResult.order.id, baseRef: "main" },
			dependencies(setupResult, { runner, evidence: [noEvidence, noEvidence, noEvidence, noEvidence] }),
		);

		expect(result.state).toBe("NEEDS_ATTENTION");
		expect(runner).toHaveBeenCalledTimes(4);
		expect(result.runs.at(-1)?.outcome).toBe("RATE_LIMITED");
		expect((await loadOrder(setupResult.order.id, setupResult.env)).journal.at(-1)).toMatchObject({
			type: "ATTENTION_REQUIRED",
			outcome: "AGENT_ERROR",
			reason: expect.stringContaining("package A cannot encode RATE_LIMITED"),
		});
	});

	it("strips GATEKEEPER_* variables from the child runner environment", async () => {
		const setupResult = await setup();
		const runner = scriptedRunner([{ kind: "deliver" }]);
		const deps = dependencies(setupResult, {
			runner,
			evidence: [deliveredEvidence],
			env: { ...setupResult.env, GATEKEEPER_SECRET: "no", PATH: "/bin" },
		});

		await superviseWorkOrder({ orderId: setupResult.order.id, baseRef: "main" }, deps);

		expect((runner.mock.calls[0]?.[0] as AgentRunOptions | undefined)?.env).toEqual({ PATH: "/bin" });
	});
});
