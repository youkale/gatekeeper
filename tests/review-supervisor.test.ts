import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRunError, type AgentRunOptions, type AgentRunResult } from "../src/agent/runner.js";
import type { GitExecutor } from "../src/dispatch/evidence.js";
import type { LoadedWorkOrder } from "../src/dispatch/store.js";
import type { WorkspaceFingerprint } from "../src/dispatch/workspace.js";
import {
	type CreateReviewCycleInput,
	createCycle,
	type LoadedReviewCycle,
	loadCycle,
	reviewCycleDirectory,
} from "../src/review/store.js";
import {
	REVIEW_MAX_LANE_SECONDS,
	REVIEW_STALL_SECONDS,
	type ReviewFixOrderInput,
	type ReviewSupervisorDependencies,
	resumeReviewCycle,
	reviewCyclesVisibleToFixDispatch,
	reviewFix,
	superviseReviewCycle,
} from "../src/review/supervisor.js";
import type { LaneRoute, ReviewCycle } from "../src/review/types.js";

const temporaryDirectories: string[] = [];
let dependencySequence = 0;

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Harness {
	configDirectory: string;
	repoDirectory: string;
	cycle: ReviewCycle;
}

interface ReviewerContext {
	options: AgentRunOptions;
	brief: string;
	laneId: string;
	round: number;
	runToken: string;
}

type ReviewerBehavior = (context: ReviewerContext) => Promise<AgentRunResult>;

const git: GitExecutor = {
	async exec() {
		throw new Error("workspaceFingerprint must be injected in supervisor tests");
	},
};

const cleanFingerprint: WorkspaceFingerprint = {
	head: "head-1",
	porcelain: "",
	trackedDiff: "",
	untracked: [],
};

function passVerdict(runToken: string, round: number) {
	return {
		apiVersion: "gatekeeper/v1",
		verdict: "pass",
		run_token: runToken,
		round,
		blockers: [],
		non_blockers: [],
	};
}

function failVerdict(
	runToken: string,
	round: number,
	blockers: Array<{ file: string; line?: number; title: string; evidence: string }>,
) {
	return {
		apiVersion: "gatekeeper/v1",
		verdict: "fail",
		run_token: runToken,
		round,
		blockers,
		non_blockers: [],
	};
}

async function writeVerdict(options: AgentRunOptions, verdict: unknown): Promise<AgentRunResult> {
	await writeFile(options.outPath, `${JSON.stringify(verdict)}\n`, "utf8");
	return { stdout: JSON.stringify(verdict), stderr: "" };
}

function reviewer(behavior: ReviewerBehavior): (options: AgentRunOptions) => Promise<AgentRunResult> {
	return async (options) => {
		const brief = await readFile(options.briefPath, "utf8");
		const runToken = /本次 run_token（必须原样回显）: `([^`]+)`/.exec(brief)?.[1];
		const round = Number(/本次 round: (\d+)/.exec(brief)?.[1]);
		const laneId = /\/lanes\/(L[1-9]\d*-[a-z0-9-]+)\//.exec(options.briefPath)?.[1];
		if (!runToken || !Number.isInteger(round) || !laneId) {
			throw new Error(`could not parse reviewer context from ${options.briefPath}`);
		}
		options.onSpawn?.({ pid: 4242, pgid: 4242 });
		return behavior({ options, brief, laneId, round, runToken });
	};
}

async function makeHarness(lanes: LaneRoute[], overrides: Partial<CreateReviewCycleInput> = {}): Promise<Harness> {
	const configDirectory = await mkdtemp(path.join(tmpdir(), "gatekeeper-review-supervisor-"));
	temporaryDirectories.push(configDirectory);
	const repoDirectory = path.join(configDirectory, "target-repo");
	await mkdir(repoDirectory);
	const created = await createCycle(
		{
			subject: { kind: "diff", repo: "acme/widgets", base_ref: "main", head_ref: "feature/review" },
			target_repo: { name: "acme/widgets", path: repoDirectory },
			subject_markdown: "Delivery report\n\nRisks: verify the touched orchestration paths.\n",
			authoring_vendors: ["author-vendor"],
			max_rounds: 3,
			lane_snapshot: lanes,
			degraded: false,
			...overrides,
		},
		{
			env: { GATEKEEPER_CONFIG_DIR: configDirectory },
			now: () => new Date("2026-07-21T02:00:00.000Z"),
			randomUUID: () => "cycle-entropy-0001",
		},
	);
	return { configDirectory, repoDirectory, cycle: created.cycle };
}

function dependencies(
	harness: Harness,
	runner: (options: AgentRunOptions) => Promise<AgentRunResult>,
	overrides: Partial<ReviewSupervisorDependencies> = {},
): ReviewSupervisorDependencies {
	let clockTick = 0;
	let id = 0;
	let token = 0;
	const dependencyId = ++dependencySequence;
	return {
		env: { GATEKEEPER_CONFIG_DIR: harness.configDirectory },
		pid: 9191,
		now: () => new Date(Date.parse("2026-07-21T02:01:00.000Z") + clockTick++ * 1_000),
		idGenerator: () => `supervisor-${dependencyId}-id-${++id}`,
		randomBytes: (length) => {
			token += 1;
			return new Uint8Array(length).fill(token);
		},
		timers: {
			set: () => ({ timer: ++id }),
			clear: () => undefined,
		},
		runner,
		git,
		content: {
			roleCard: "Review independently and return only the required verdict artifact.",
			diffScope: { summary: "main..HEAD", command: "git diff main..HEAD --" },
			subject: { deliveryReport: "Implemented package C.", selfReportedRisks: "Concurrency and recovery." },
		},
		workspaceFingerprint: async () => cleanFingerprint,
		realpath: async (target) => target,
		listDispatchOrders: async () => [],
		isProcessAlive: () => true,
		...overrides,
	};
}

const claudeRequired: LaneRoute = {
	id: "L1-claude",
	cli: "claude",
	vendor: "anthropic",
	command: "claude review",
	required: true,
};

describe("review lane supervisor", () => {
	it("fans out required lanes in parallel and reaches AWAITING_ACCEPT after two PASS verdicts", async () => {
		const harness = await makeHarness([
			claudeRequired,
			{ id: "L2-codex", cli: "codex", vendor: "openai", command: "codex review", required: true },
		]);
		let starts = 0;
		let release: (() => void) | undefined;
		const bothStarted = new Promise<void>((resolve) => {
			release = resolve;
		});
		const run = reviewer(async ({ options, runToken, round }) => {
			starts += 1;
			if (starts === 2) {
				release?.();
			}
			await bothStarted;
			return writeVerdict(options, passVerdict(runToken, round));
		});

		const result = await superviseReviewCycle(harness.cycle, dependencies(harness, run));

		expect(starts).toBe(2);
		expect(result.state).toBe("AWAITING_ACCEPT");
		expect(result.round).toMatchObject({ verdict: "PASS", status: "AWAITING_ACCEPT" });
		expect(result.round?.subject_fingerprint).toEqual(cleanFingerprint);
		const loaded = await loadCycle(harness.cycle.id, { GATEKEEPER_CONFIG_DIR: harness.configDirectory });
		expect(loaded.state).toBe("AWAITING_ACCEPT");
		expect(loaded.rounds[0]?.lanes.map((lane) => lane.outcome)).toEqual(["PASS", "PASS"]);
	});

	it("aggregates one required FAIL into BLOCKED with a stable blocker id", async () => {
		const harness = await makeHarness([
			claudeRequired,
			{ id: "L2-codex", cli: "codex", vendor: "openai", command: "codex review", required: true },
		]);
		const run = reviewer(({ options, laneId, runToken, round }) =>
			laneId === "L1-claude"
				? writeVerdict(
						options,
						failVerdict(runToken, round, [
							{ file: "src/review/supervisor.ts", line: 10, title: "Unsafe conclusion", evidence: "branch is wrong" },
						]),
					)
				: writeVerdict(options, passVerdict(runToken, round)),
		);

		const result = await superviseReviewCycle(harness.cycle, dependencies(harness, run));

		expect(result.state).toBe("BLOCKED");
		expect(result.round?.verdict).toBe("FAIL");
		expect(result.blockers).toEqual([
			expect.objectContaining({ id: "B-r1-L1-01", title: "Unsafe conclusion", endorsements: ["L1-claude"] }),
		]);
	});

	it("switches candidates immediately on a classified quota error", async () => {
		const harness = await makeHarness([
			{ id: "L1-codex", cli: "codex", vendor: "openai", command: "codex review", required: true },
			{ id: "L2-grok", cli: "grok", vendor: "xai", command: "grok review", required: false },
		]);
		const commands: string[] = [];
		const run = reviewer(async ({ options, laneId, runToken, round }) => {
			if (laneId === "L1-codex") {
				commands.push(options.command);
			}
			if (laneId === "L1-codex" && options.command === "codex review") {
				throw new AgentRunError("nonzero-exit", "quota", {
					command: options.command,
					exitCode: 1,
					signal: null,
					stderrTail: "You've hit your codex usage limit; try again in 1h",
				});
			}
			return writeVerdict(options, passVerdict(runToken, round));
		});

		const result = await superviseReviewCycle(harness.cycle, dependencies(harness, run));

		expect(result.state).toBe("AWAITING_ACCEPT");
		expect(commands).toEqual(["codex review", "grok review"]);
	});

	it("journals a cooldown when quota has no backup and resumes the same round deterministically", async () => {
		const harness = await makeHarness([
			{ id: "L1-codex", cli: "codex", vendor: "openai", command: "codex review", required: true },
		]);
		let calls = 0;
		const run = reviewer(async ({ options, runToken, round }) => {
			calls += 1;
			if (calls === 1) {
				throw new AgentRunError("nonzero-exit", "quota", {
					command: options.command,
					exitCode: 1,
					signal: null,
					stderrTail: "You've hit your codex usage limit; try again in 1h",
				});
			}
			return writeVerdict(options, passVerdict(runToken, round));
		});
		const deps = dependencies(harness, run);

		const waiting = await superviseReviewCycle(harness.cycle, deps);
		expect(waiting.state).toBe("WAITING_COOLDOWN");
		expect((await loadCycle(harness.cycle.id, deps.env)).journal.at(-1)?.type).toBe("COOLDOWN_STARTED");

		const resumed = await resumeReviewCycle(harness.cycle, deps);
		expect(resumed.state).toBe("AWAITING_ACCEPT");
		expect(calls).toBe(2);
	});

	it("retries INVALID once, exhausts a backup, and fail-closes to ARBITRATION rather than PASS", async () => {
		const harness = await makeHarness([
			claudeRequired,
			{ id: "L2-grok", cli: "grok", vendor: "xai", command: "grok review", required: false },
		]);
		const requiredCommands: string[] = [];
		const run = reviewer(async ({ options, laneId, round }) => {
			if (laneId === "L1-claude") {
				requiredCommands.push(options.command);
			}
			return writeVerdict(options, passVerdict("wrong-token", round));
		});

		const result = await superviseReviewCycle(harness.cycle, dependencies(harness, run));

		expect(requiredCommands).toEqual(["claude review", "claude review", "grok review", "grok review"]);
		expect(result.state).toBe("ARBITRATION");
		expect(result.round).toMatchObject({ verdict: "UNAVAILABLE", status: "ARBITRATION" });
		expect(result.round?.verdict).not.toBe("PASS");
	});

	it("invalidates read-only contamination and emits a cycle-visible warning", async () => {
		const harness = await makeHarness([claudeRequired]);
		let fingerprintReads = 0;
		const changed: WorkspaceFingerprint = { ...cleanFingerprint, trackedDiff: "reviewer mutation" };
		const run = reviewer(({ options, runToken, round }) => writeVerdict(options, passVerdict(runToken, round)));
		const deps = dependencies(harness, run, {
			workspaceFingerprint: async () => (++fingerprintReads <= 2 ? cleanFingerprint : changed),
		});

		const result = await superviseReviewCycle(harness.cycle, deps);

		expect(result.state).toBe("ARBITRATION");
		expect(result.round?.lane_results).toEqual([{ lane_id: "L1-claude", required: true, outcome: "INVALID" }]);
		expect(result.warnings).toEqual([expect.objectContaining({ code: "REVIEWER_WROTE_REPO", laneId: "L1-claude" })]);
	});

	it("uses injected timers for stall invalidation without real time", async () => {
		const harness = await makeHarness([claudeRequired]);
		const callbacks: Array<() => void> = [];
		let calls = 0;
		const run = reviewer(async ({ options }) => {
			calls += 1;
			callbacks.shift()?.();
			expect(options.signal?.aborted).toBe(true);
			throw new AgentRunError("external-abort", "stalled", {
				command: options.command,
				exitCode: null,
				signal: "SIGTERM",
			});
		});
		const deps = dependencies(harness, run, {
			timers: {
				set: (_delay, callback) => {
					callbacks.push(callback);
					return callback;
				},
				clear: (handle) => {
					const index = callbacks.indexOf(handle as () => void);
					if (index >= 0) callbacks.splice(index, 1);
				},
			},
		});

		const result = await superviseReviewCycle(harness.cycle, deps);

		expect(REVIEW_STALL_SECONDS).toBe(600);
		expect(REVIEW_MAX_LANE_SECONDS).toBe(3_600);
		expect(calls).toBe(2);
		expect(result.state).toBe("ARBITRATION");
	});
});

describe("review fix and recovery orchestration", () => {
	it("runs fix dispatch then an incremental round, excluding waived blockers from both briefs", async () => {
		const harness = await makeHarness([claudeRequired]);
		const incrementalBriefs: string[] = [];
		const run = reviewer(async ({ options, brief, runToken, round }) => {
			if (round === 1) {
				return writeVerdict(
					options,
					failVerdict(runToken, round, [
						{ file: "src/a.ts", line: 1, title: "Waive me", evidence: "accepted risk" },
						{ file: "src/b.ts", line: 2, title: "Fix me", evidence: "real defect" },
					]),
				);
			}
			incrementalBriefs.push(brief);
			return writeVerdict(options, passVerdict(runToken, round));
		});
		let createdFixInput: ReviewFixOrderInput | undefined;
		const createFixOrder = vi.fn(async (input: ReviewFixOrderInput) => {
			createdFixInput = input;
			return { orderId: "wo-review-fix-r1" };
		});
		const superviseFixOrder = vi.fn(async () => ({ state: "DELIVERED" }));
		const deps = dependencies(harness, run, {
			resolveFixAuthorContext: async () => ({
				candidate: { cli: "author", vendor: "author-vendor", command: "author fix" },
				originalOrderId: "wo-original",
				baseRef: "gatekeeper/dispatch/wo-original",
				reuseBranch: { branch: "gatekeeper/dispatch/wo-original" },
			}),
			createFixOrder,
			superviseFixOrder,
		});
		const first = await superviseReviewCycle(harness.cycle, deps);
		expect(first.state).toBe("BLOCKED");
		const waived = first.blockers.find((blocker) => blocker.title === "Waive me")?.id;
		const kept = first.blockers.find((blocker) => blocker.title === "Fix me")?.id;
		expect(waived).toBeDefined();
		expect(kept).toBeDefined();

		const result = await reviewFix(harness.cycle, [waived as string], [], deps, {
			operator: "human",
			waiverReasons: { [waived as string]: "accepted explicitly" },
		});

		expect(result.state).toBe("AWAITING_ACCEPT");
		expect(result.round?.number).toBe(2);
		expect(createFixOrder).toHaveBeenCalledWith(
			expect.objectContaining({
				associationKey: `${harness.cycle.target_repo.name}@adhoc-fix-${harness.cycle.id}-r1`,
				candidate: { cli: "author", vendor: "author-vendor", command: "author fix" },
			}),
		);
		expect(createdFixInput?.brief).not.toContain("Waive me");
		expect(createdFixInput?.brief).toContain("Fix me");
		expect(superviseFixOrder).toHaveBeenCalledWith(
			expect.objectContaining({
				orderId: "wo-review-fix-r1",
				busyExemptionCycleId: harness.cycle.id,
				reuseBranch: { branch: "gatekeeper/dispatch/wo-original" },
			}),
		);
		expect(incrementalBriefs).toHaveLength(1);
		expect(incrementalBriefs[0]).not.toContain(waived as string);
		expect(incrementalBriefs[0]).toContain(kept as string);
		const loaded = await loadCycle(harness.cycle.id, { GATEKEEPER_CONFIG_DIR: harness.configDirectory });
		expect(loaded.rounds).toHaveLength(2);
		expect(loaded.journal.map((event) => event.type)).toContain("FIX_DISPATCHED");
	});

	it("recovers a valid orphaned lane after a journal-first crash", async () => {
		const harness = await makeHarness([claudeRequired]);
		let runnerCalls = 0;
		const run = reviewer(async ({ options, runToken, round }) => {
			runnerCalls += 1;
			return writeVerdict(options, passVerdict(runToken, round));
		});
		let crashed = false;
		const crashing = dependencies(harness, run, {
			afterJournal(event) {
				if (!crashed && event.type === "LANE_CONCLUDED") {
					crashed = true;
					throw new Error("simulated crash after lane journal");
				}
			},
		});
		await expect(superviseReviewCycle(harness.cycle, crashing)).rejects.toThrow("simulated crash");

		const result = await resumeReviewCycle(harness.cycle, dependencies(harness, run));

		expect(result.state).toBe("AWAITING_ACCEPT");
		expect(runnerCalls).toBe(1);
	});

	it("promotes a BLOCKED round after crashing between ROUND_CONCLUDED journal append and rename", async () => {
		const harness = await makeHarness([claudeRequired]);
		const run = reviewer(({ options, runToken, round }) =>
			round === 1
				? writeVerdict(
						options,
						failVerdict(runToken, round, [{ file: "src/fix.ts", title: "Must fix", evidence: "required blocker" }]),
					)
				: writeVerdict(options, passVerdict(runToken, round)),
		);
		let crashed = false;
		const deps = dependencies(harness, run, {
			resolveFixAuthorContext: async () => ({
				candidate: { cli: "author", vendor: "author-vendor", command: "author fix" },
				originalOrderId: "wo-original",
				baseRef: "gatekeeper/dispatch/wo-original",
				reuseBranch: { branch: "gatekeeper/dispatch/wo-original" },
			}),
			createFixOrder: async () => ({ orderId: "wo-round-conclusion-fix" }),
			superviseFixOrder: async () => ({ state: "DELIVERED" }),
			afterJournal(event) {
				if (!crashed && event.type === "ROUND_CONCLUDED") {
					crashed = true;
					throw new Error("crash after ROUND_CONCLUDED before round promotion");
				}
			},
		});

		await expect(superviseReviewCycle(harness.cycle, deps)).rejects.toThrow(
			"crash after ROUND_CONCLUDED before round promotion",
		);
		const cycleDirectory = reviewCycleDirectory(harness.cycle.id, deps.env);
		const stranded = await loadCycle(harness.cycle.id, deps.env);
		expect(stranded.state).toBe("BLOCKED");
		expect(stranded.rounds).toEqual([]);
		await expect(
			readFile(path.join(cycleDirectory, "rounds", ".tmp-R1-supervisor", "summary.json"), "utf8"),
		).resolves.toContain('"status": "BLOCKED"');
		await expect(readFile(path.join(cycleDirectory, "rounds", "R1", "summary.json"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});

		const resumed = await resumeReviewCycle(harness.cycle, deps);

		expect(resumed).toMatchObject({ state: "BLOCKED", round: { id: "R1", status: "BLOCKED" } });
		expect((await loadCycle(harness.cycle.id, deps.env)).rounds.map((round) => round.summary.id)).toEqual(["R1"]);
		await expect(reviewFix(harness.cycle, [], [], deps)).resolves.toMatchObject({
			state: "AWAITING_ACCEPT",
			round: { id: "R2", status: "AWAITING_ACCEPT" },
		});
	});

	it("passes a crash-left FIXING cycle back through dispatch supervision before incremental review", async () => {
		const harness = await makeHarness([claudeRequired]);
		const run = reviewer(({ options, runToken, round }) =>
			round === 1
				? writeVerdict(
						options,
						failVerdict(runToken, round, [{ file: "src/fix.ts", title: "Must fix", evidence: "required blocker" }]),
					)
				: writeVerdict(options, passVerdict(runToken, round)),
		);
		let crashed = false;
		const superviseFixOrder = vi.fn(async () => ({ state: "DELIVERED" }));
		const deps = dependencies(harness, run, {
			resolveFixAuthorContext: async () => ({
				candidate: { cli: "author", vendor: "author-vendor", command: "author fix" },
				originalOrderId: "wo-original",
				baseRef: "gatekeeper/dispatch/wo-original",
				reuseBranch: { branch: "gatekeeper/dispatch/wo-original" },
			}),
			createFixOrder: async () => ({ orderId: "wo-resumable-fix" }),
			superviseFixOrder,
			afterJournal(event) {
				if (!crashed && event.type === "FIX_DISPATCHED") {
					crashed = true;
					throw new Error("crash before fix supervision");
				}
			},
		});
		await superviseReviewCycle(harness.cycle, deps);
		await expect(reviewFix(harness.cycle, [], [], deps)).rejects.toThrow("crash before fix supervision");
		expect((await loadCycle(harness.cycle.id, deps.env)).state).toBe("FIXING");

		const result = await resumeReviewCycle(harness.cycle, deps);

		expect(superviseFixOrder).toHaveBeenCalledOnce();
		expect(result.state).toBe("AWAITING_ACCEPT");
		expect(result.round?.number).toBe(2);
	});

	it("repairs a journal truncated at the final event without rerunning reviewers", async () => {
		const harness = await makeHarness([claudeRequired]);
		let runnerCalls = 0;
		const run = reviewer(async ({ options, runToken, round }) => {
			runnerCalls += 1;
			return writeVerdict(options, passVerdict(runToken, round));
		});
		const deps = dependencies(harness, run);
		await superviseReviewCycle(harness.cycle, deps);
		const journalFile = path.join(reviewCycleDirectory(harness.cycle.id, deps.env), "journal.jsonl");
		const lines = (await readFile(journalFile, "utf8")).trimEnd().split("\n");
		expect(JSON.parse(lines.at(-1) ?? "{}").type).toBe("ROUND_CONCLUDED");
		await writeFile(journalFile, `${lines.slice(0, -1).join("\n")}\n`, "utf8");
		expect((await loadCycle(harness.cycle.id, deps.env)).state).toBe("REVIEWING");

		const result = await resumeReviewCycle(harness.cycle, deps);

		expect(result.state).toBe("AWAITING_ACCEPT");
		expect(runnerCalls).toBe(1);
		expect((await loadCycle(harness.cycle.id, deps.env)).state).toBe("AWAITING_ACCEPT");
	});

	it("exempts only the owning review cycle from fix-dispatch busy scans", async () => {
		const own = { cycle: { id: "rc-own" } } as LoadedReviewCycle;
		const other = { cycle: { id: "rc-other" } } as LoadedReviewCycle;

		expect(reviewCyclesVisibleToFixDispatch([own, other], "rc-own")).toEqual([other]);
		expect(reviewCyclesVisibleToFixDispatch([own, other], "rc-missing")).toEqual([own, other]);
	});
});

describe("reverse target repository exclusion", () => {
	function dispatchOrder(id: string, targetPath: string, state: LoadedWorkOrder["state"]): LoadedWorkOrder {
		return {
			state,
			order: { id, target_repo: { name: "acme/widgets", path: targetPath } },
		} as LoadedWorkOrder;
	}

	it("rejects a RUNNING dispatch order on the same realpath before reviewer start", async () => {
		const harness = await makeHarness([claudeRequired]);
		const run = vi.fn(reviewer(({ options, runToken, round }) => writeVerdict(options, passVerdict(runToken, round))));
		const deps = dependencies(harness, run, {
			listDispatchOrders: async () => [dispatchOrder("wo-busy", harness.repoDirectory, "RUNNING")],
			readDispatchSupervisorRecord: async () => ({ pid: 777, started_at: "2026-07-21T02:00:00.000Z" }),
		});

		await expect(superviseReviewCycle(harness.cycle, deps)).rejects.toMatchObject({
			code: "TARGET_REPOSITORY_BUSY",
			conflictingOrderId: "wo-busy",
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("does not reject delivered orders or RUNNING orders on a different realpath", async () => {
		const harness = await makeHarness([claudeRequired]);
		const run = reviewer(({ options, runToken, round }) => writeVerdict(options, passVerdict(runToken, round)));
		const deps = dependencies(harness, run, {
			listDispatchOrders: async () => [
				dispatchOrder("wo-delivered", harness.repoDirectory, "DELIVERED"),
				dispatchOrder("wo-stale", harness.repoDirectory, "RUNNING"),
				dispatchOrder("wo-other", `${harness.repoDirectory}-other`, "RUNNING"),
			],
		});

		await expect(superviseReviewCycle(harness.cycle, deps)).resolves.toMatchObject({ state: "AWAITING_ACCEPT" });
	});
});
