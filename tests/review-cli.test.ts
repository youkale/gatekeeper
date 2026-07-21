import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DetectedAgentCli } from "../src/agent/detect.js";
import {
	REVIEW_ATTENTION_EXIT_CODE,
	REVIEW_RENDER_MARKER,
	runReviewAccept,
	runReviewArbitrate,
	runReviewCancel,
	runReviewFix,
	runReviewLogs,
	runReviewRender,
	runReviewResume,
	runReviewStart,
	runReviewStatus,
} from "../src/commands/review.js";
import type { LoadedWorkOrder } from "../src/dispatch/store.js";
import { COMMENT_MARKER } from "../src/render/comment.js";
import { acquireReviewSupervisorLock } from "../src/review/lock.js";
import {
	appendJournalEvent,
	type CreateReviewCycleInput,
	createCycle,
	reviewCycleDirectory,
} from "../src/review/store.js";
import type { ReviewSupervisionResult } from "../src/review/supervisor.js";
import {
	type Lane,
	type LaneRoute,
	laneSchema,
	type ReviewJournalEvent,
	type Round,
	roundSchema,
} from "../src/review/types.js";
import type { RolesPolicy } from "../src/roles/policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	temporaryDirectories.push(dir);
	return dir;
}

function captureStdout(): { text: () => string } {
	const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	return { text: () => spy.mock.calls.map(([chunk]) => String(chunk)).join("") };
}

function captureStderr(): { text: () => string } {
	const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return { text: () => spy.mock.calls.map(([chunk]) => String(chunk)).join("") };
}

const AT = "2026-07-21T01:02:03.000Z";
const FIXED_NOW = () => new Date(AT);

const REAL_REVIEWER_SCRIPT = [
	'const fs = require("node:fs");',
	'const brief = fs.readFileSync(process.argv[1], "utf8");',
	'const tokenLine = brief.split("\\n").find((line) => line.includes("run_token（必须原样回显）"));',
	"const runToken = tokenLine && tokenLine.split(String.fromCharCode(96))[1];",
	"const roundMatch = /本次 round: (\\d+)/.exec(brief);",
	"const round = roundMatch && Number(roundMatch[1]);",
	'if (!runToken || !Number.isInteger(round)) throw new Error("invalid review brief");',
	"const failing = round === 1;",
	"const verdict = {",
	'apiVersion: "gatekeeper/v1",',
	'verdict: failing ? "fail" : "pass",',
	"run_token: runToken,",
	"round,",
	'blockers: failing ? [{ file: "src/fake.ts", title: "real runner blocker", evidence: "fixture evidence" }] : [],',
	"non_blockers: []",
	"};",
	'fs.writeFileSync(process.argv[2], JSON.stringify(verdict) + "\\n", "utf8");',
].join("");

function realReviewerCommand(): string {
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(REAL_REVIEWER_SCRIPT)} {brief} {out}`;
}

async function realReviewGitRepo(): Promise<string> {
	const dir = await tempDir("gatekeeper-review-cli-real-runner-");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
	execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: dir });
	await writeFile(path.join(dir, "a.txt"), "a\n", "utf8");
	execFileSync("git", ["add", "a.txt"], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	execFileSync("git", ["branch", "-m", "main"], { cwd: dir });
	return dir;
}

function cycleInput(
	overrides: Partial<CreateReviewCycleInput> = {},
	targetPath = "/work/acme/widgets",
): CreateReviewCycleInput {
	return {
		subject: { kind: "diff", repo: "acme/widgets", base_ref: "main" },
		target_repo: { name: "acme/widgets", path: targetPath },
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

let idCounter = 0;
function nextId(prefix: string): string {
	idCounter += 1;
	return `${prefix}-${idCounter}`;
}

async function setupCycle(overrides: Partial<CreateReviewCycleInput> = {}, targetPath?: string) {
	const configDirectory = await tempDir("gatekeeper-review-cli-config-");
	const env = { GATEKEEPER_CONFIG_DIR: configDirectory };
	const created = await createCycle(cycleInput(overrides, targetPath ?? "/work/acme/widgets"), {
		env,
		now: FIXED_NOW,
		randomUUID: () => nextId("cycle"),
	});
	return { env, created, configDirectory };
}

async function journal(env: NodeJS.ProcessEnv, event: ReviewJournalEvent): Promise<void> {
	await appendJournalEvent(event.cycle_id, event, env);
}

/** Advance a freshly-created (PENDING) cycle straight to `to` via journal-only writes -- loadCycle's `state` is
 * folded purely from the journal, so no rounds/lanes fixture files are needed unless a test specifically reads
 * `loaded.rounds` (report/--report/logs tests build those explicitly below). */
async function advanceToBlocked(env: NodeJS.ProcessEnv, cycleId: string): Promise<void> {
	await journal(env, {
		apiVersion: "gatekeeper/v1",
		type: "ROUND_STARTED",
		cycle_id: cycleId,
		at: AT,
		round: 1,
		from: "PENDING",
		to: "REVIEWING",
	});
	await journal(env, {
		apiVersion: "gatekeeper/v1",
		type: "ROUND_CONCLUDED",
		cycle_id: cycleId,
		at: AT,
		round: 1,
		verdict: "FAIL",
		from: "REVIEWING",
		to: "BLOCKED",
	});
}

async function advanceToAwaitingAccept(env: NodeJS.ProcessEnv, cycleId: string): Promise<void> {
	await journal(env, {
		apiVersion: "gatekeeper/v1",
		type: "ROUND_STARTED",
		cycle_id: cycleId,
		at: AT,
		round: 1,
		from: "PENDING",
		to: "REVIEWING",
	});
	await journal(env, {
		apiVersion: "gatekeeper/v1",
		type: "ROUND_CONCLUDED",
		cycle_id: cycleId,
		at: AT,
		round: 1,
		verdict: "PASS",
		from: "REVIEWING",
		to: "AWAITING_ACCEPT",
	});
}

async function advanceToArbitration(env: NodeJS.ProcessEnv, cycleId: string): Promise<void> {
	await journal(env, {
		apiVersion: "gatekeeper/v1",
		type: "ROUND_STARTED",
		cycle_id: cycleId,
		at: AT,
		round: 1,
		from: "PENDING",
		to: "REVIEWING",
	});
	await journal(env, {
		apiVersion: "gatekeeper/v1",
		type: "ROUND_CONCLUDED",
		cycle_id: cycleId,
		at: AT,
		round: 1,
		verdict: "UNAVAILABLE",
		from: "REVIEWING",
		to: "ARBITRATION",
	});
}

async function advanceToWaitingCooldown(env: NodeJS.ProcessEnv, cycleId: string): Promise<void> {
	await journal(env, {
		apiVersion: "gatekeeper/v1",
		type: "ROUND_STARTED",
		cycle_id: cycleId,
		at: AT,
		round: 1,
		from: "PENDING",
		to: "REVIEWING",
	});
	await journal(env, {
		apiVersion: "gatekeeper/v1",
		type: "COOLDOWN_STARTED",
		cycle_id: cycleId,
		at: AT,
		round: 1,
		lane_id: "L1-claude",
		resume_after: "2026-07-21T02:00:00.000Z",
		from: "REVIEWING",
		to: "WAITING_COOLDOWN",
	});
}

async function advanceToAccepted(env: NodeJS.ProcessEnv, cycleId: string): Promise<void> {
	await advanceToAwaitingAccept(env, cycleId);
	await journal(env, {
		apiVersion: "gatekeeper/v1",
		type: "CYCLE_ACCEPTED",
		cycle_id: cycleId,
		at: AT,
		operator: "test",
		from: "AWAITING_ACCEPT",
		to: "ACCEPTED",
	});
}

async function advanceToAbandoned(env: NodeJS.ProcessEnv, cycleId: string): Promise<void> {
	await journal(env, {
		apiVersion: "gatekeeper/v1",
		type: "ROUND_STARTED",
		cycle_id: cycleId,
		at: AT,
		round: 1,
		from: "PENDING",
		to: "REVIEWING",
	});
	await journal(env, {
		apiVersion: "gatekeeper/v1",
		type: "CYCLE_CANCELLED",
		cycle_id: cycleId,
		at: AT,
		operator: "test",
		reason: "test abandon",
		from: "REVIEWING",
		to: "ABANDONED",
	});
}

interface RoundFixtureLane {
	route: LaneRoute;
	outcome: "PASS" | "FAIL" | "INVALID";
	verdict?: unknown;
}

/** Full round+lane on-disk fixture (used only by tests that read `loaded.rounds`: --report, logs, ledger fingerprint). */
async function writeRoundFixture(
	env: NodeJS.ProcessEnv,
	cycleId: string,
	round: number,
	status: Round["status"],
	lanes: RoundFixtureLane[],
): Promise<void> {
	const cycleDirectory = reviewCycleDirectory(cycleId, env);
	const roundDirectory = path.join(cycleDirectory, "rounds", `R${round}`);
	const laneResults: Round["lane_results"] = [];
	for (const { route, outcome, verdict } of lanes) {
		const laneDirectory = path.join(roundDirectory, "lanes", route.id);
		await mkdir(path.join(laneDirectory, "out"), { recursive: true });
		const root = `rounds/R${round}/lanes/${route.id}`;
		const lane: Lane = laneSchema.parse({
			apiVersion: "gatekeeper/v1",
			id: route.id,
			cycle_id: cycleId,
			round,
			cli: route.cli,
			vendor: route.vendor,
			command: route.command,
			required: route.required,
			status: "CONCLUDED",
			started_at: AT,
			ended_at: AT,
			outcome,
			exit_code: outcome === "PASS" ? 0 : 1,
			signal: null,
			brief_path: `${root}/brief.md`,
			stdout_path: `${root}/stdout.log`,
			stderr_path: `${root}/stderr.log`,
			out_path: `${root}/out`,
			result_path: `${root}/out/VERDICT.json`,
		});
		await writeFile(path.join(laneDirectory, "meta.json"), JSON.stringify(lane), "utf8");
		await writeFile(path.join(laneDirectory, "brief.md"), "brief text", "utf8");
		await writeFile(path.join(laneDirectory, "stdout.log"), "lane stdout line one\nlane stdout line two\n", "utf8");
		await writeFile(path.join(laneDirectory, "stderr.log"), "lane stderr warn\n", "utf8");
		if (verdict !== undefined) {
			await writeFile(path.join(laneDirectory, "out", "VERDICT.json"), JSON.stringify(verdict), "utf8");
		}
		laneResults.push({ lane_id: route.id, required: route.required, outcome });
	}
	const verdictAggregate =
		status === "REVIEWING" ? undefined : laneResults.every((r) => r.outcome === "PASS") ? "PASS" : "FAIL";
	const summary: Round = roundSchema.parse({
		apiVersion: "gatekeeper/v1",
		id: `R${round}`,
		cycle_id: cycleId,
		number: round,
		status,
		subject_fingerprint: { head: "deadbeefcafe", porcelain: "", trackedDiff: "", untracked: [] },
		lane_ids: lanes.map((l) => l.route.id),
		lane_results: laneResults,
		...(verdictAggregate ? { verdict: verdictAggregate } : {}),
		started_at: AT,
		...(status !== "REVIEWING" ? { concluded_at: AT } : {}),
	});
	await writeFile(path.join(roundDirectory, "summary.json"), JSON.stringify(summary), "utf8");
}

function fakeResult(overrides: Partial<ReviewSupervisionResult> = {}): ReviewSupervisionResult {
	return { cycleId: "rc-placeholder", state: "AWAITING_ACCEPT", blockers: [], warnings: [], ...overrides };
}

// ---------------------------------------------------------------------------
// runReviewStart
// ---------------------------------------------------------------------------

describe("runReviewStart", () => {
	const reviewerTierPolicy: RolesPolicy = {
		apiVersion: "gatekeeper/v1",
		tiers: { reviewer: { prefer: ["openai/gpt-5.4-codex", "anthropic/claude-opus-4-8"], count: 2, crossVendor: true } },
	};

	function detectedCli(name: string, vendor: string): DetectedAgentCli {
		return {
			name,
			binary: name,
			vendor,
			tiers: ["reviewer"],
			commandTemplate: `${name} review {brief} {out}`,
			path: `/usr/local/bin/${name}`,
			version: null,
		};
	}

	async function gitRepo(): Promise<string> {
		const dir = await tempDir("gatekeeper-review-cli-diffrepo-");
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
		execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: dir });
		await writeFile(path.join(dir, "a.txt"), "a\n", "utf8");
		execFileSync("git", ["add", "."], { cwd: dir });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
		execFileSync("git", ["branch", "-m", "main"], { cwd: dir });
		await writeFile(path.join(dir, "a.txt"), "a\nb\n", "utf8");
		execFileSync("git", ["commit", "-q", "-am", "second"], { cwd: dir });
		return dir;
	}

	it("rejects both a subject and --diff, and rejects neither", async () => {
		const err1 = captureStderr();
		expect(await runReviewStart({ subject: "wo-x", diff: true, base: "main" }, "/tmp")).toBe(2);
		expect(err1.text()).toContain("pass either a dispatch-order-id or --diff");

		const err2 = captureStderr();
		expect(await runReviewStart({}, "/tmp")).toBe(2);
		expect(err2.text()).toContain("a dispatch-order-id, or --diff --base");
	});

	it("rejects --diff without --base", async () => {
		const err = captureStderr();
		expect(await runReviewStart({ diff: true }, "/tmp")).toBe(2);
		expect(err.text()).toContain("--diff requires --base");
	});

	it("exits 2 for an unknown dispatch order id", async () => {
		const configDirectory = await tempDir("gatekeeper-review-cli-config-");
		const err = captureStderr();
		const code = await runReviewStart({ subject: "wo-does-not-exist-12345" }, "/tmp", {
			env: { GATEKEEPER_CONFIG_DIR: configDirectory },
		});
		expect(code).toBe(2);
		expect(err.text()).toContain("wo-does-not-exist-12345");
	});

	it("requires --yes when stdin is not a TTY, and never exits 1", async () => {
		const repo = await gitRepo();
		const stdout = captureStdout();
		const err = captureStderr();
		const code = await runReviewStart({ diff: true, base: "main", authoredBy: ["xai"] }, repo, {
			env: { GATEKEEPER_CONFIG_DIR: await tempDir("gatekeeper-review-cli-config-") },
			isInteractive: false,
			detectAgentClis: async () => [detectedCli("codex", "openai"), detectedCli("claude", "anthropic")],
			loadRolesPolicy: async () => reviewerTierPolicy,
		});
		expect(code).toBe(2);
		expect(err.text()).toContain("not an interactive TTY");
		expect(stdout.text()).not.toContain("created cycle");
		expect(code).not.toBe(1);
	});

	it("aborts (exit 0) when the confirmation prompt declines, creating no cycle", async () => {
		const repo = await gitRepo();
		const configDirectory = await tempDir("gatekeeper-review-cli-config-");
		const promptConfirm = vi.fn(async () => false);
		const stdout = captureStdout();
		const code = await runReviewStart({ diff: true, base: "main", authoredBy: ["xai"] }, repo, {
			env: { GATEKEEPER_CONFIG_DIR: configDirectory },
			isInteractive: true,
			promptConfirm,
			detectAgentClis: async () => [detectedCli("codex", "openai"), detectedCli("claude", "anthropic")],
			loadRolesPolicy: async () => reviewerTierPolicy,
		});
		expect(code).toBe(0);
		expect(promptConfirm).toHaveBeenCalledOnce();
		expect(stdout.text()).toContain("aborted");
		const { listCycles } = await import("../src/review/store.js");
		expect(await listCycles({ GATEKEEPER_CONFIG_DIR: configDirectory })).toEqual([]);
	});

	it("warns when --diff is given with no --authored-by (cross-vendor exclusion not enforced)", async () => {
		const repo = await gitRepo();
		const err = captureStderr();
		captureStdout();
		const superviseReviewCycle = vi.fn(async () => fakeResult({ state: "AWAITING_ACCEPT" }));
		const code = await runReviewStart({ diff: true, base: "main", yes: true }, repo, {
			env: { GATEKEEPER_CONFIG_DIR: await tempDir("gatekeeper-review-cli-config-") },
			detectAgentClis: async () => [detectedCli("codex", "openai"), detectedCli("claude", "anthropic")],
			loadRolesPolicy: async () => reviewerTierPolicy,
			superviseReviewCycle,
		});
		expect(err.text()).toContain("cross-vendor authoring exclusion will not be enforced");
		expect(code).toBe(REVIEW_ATTENTION_EXIT_CODE);
		expect(superviseReviewCycle).toHaveBeenCalledOnce();
	});

	it("refuses a required-lane shortfall without --allow-degraded, and proceeds DEGRADED with it", async () => {
		const repo = await gitRepo();
		const configDirectory = await tempDir("gatekeeper-review-cli-config-");
		const oneEligible = async () => [detectedCli("codex", "openai")]; // only 1 of 2 required after excluding "anthropic" authoring

		const err = captureStderr();
		const refused = await runReviewStart({ diff: true, base: "main", authoredBy: ["anthropic"], yes: true }, repo, {
			env: { GATEKEEPER_CONFIG_DIR: configDirectory },
			detectAgentClis: oneEligible,
			loadRolesPolicy: async () => reviewerTierPolicy,
		});
		expect(refused).toBe(2);
		expect(err.text()).toContain("--allow-degraded");

		const stdout = captureStdout();
		const superviseReviewCycle = vi.fn(async () => fakeResult({ state: "AWAITING_ACCEPT" }));
		const degraded = await runReviewStart(
			{ diff: true, base: "main", authoredBy: ["anthropic"], allowDegraded: true, yes: true },
			repo,
			{
				env: { GATEKEEPER_CONFIG_DIR: configDirectory },
				detectAgentClis: oneEligible,
				loadRolesPolicy: async () => reviewerTierPolicy,
				superviseReviewCycle,
			},
		);
		expect(degraded).toBe(REVIEW_ATTENTION_EXIT_CODE);
		expect(stdout.text()).toContain("DEGRADED");
		const { listCycles } = await import("../src/review/store.js");
		const cycles = await listCycles({ GATEKEEPER_CONFIG_DIR: configDirectory });
		expect(cycles).toHaveLength(1);
		expect(cycles[0]?.cycle.degraded).toBe(true);
		expect(cycles[0]?.cycle.lane_snapshot).toEqual([
			{ id: "L1-codex", cli: "codex", vendor: "openai", command: "codex review {brief} {out}", required: true },
		]);
	});

	it("freezes required-then-advisory lane routes excluding authoring vendors, and passes --max-parallel through", async () => {
		const repo = await gitRepo();
		const configDirectory = await tempDir("gatekeeper-review-cli-config-");
		const superviseReviewCycle = vi.fn(async (..._args: unknown[]) => fakeResult({ state: "AWAITING_ACCEPT" }));
		const code = await runReviewStart(
			{ diff: true, base: "main", authoredBy: ["xai"], maxParallel: 1, yes: true },
			repo,
			{
				env: { GATEKEEPER_CONFIG_DIR: configDirectory },
				detectAgentClis: async () => [
					detectedCli("codex", "openai"),
					detectedCli("claude", "anthropic"),
					detectedCli("grok", "xai"),
				],
				loadRolesPolicy: async () => reviewerTierPolicy,
				superviseReviewCycle,
			},
		);
		expect(code).toBe(REVIEW_ATTENTION_EXIT_CODE);
		const { listCycles } = await import("../src/review/store.js");
		const [cycle] = await listCycles({ GATEKEEPER_CONFIG_DIR: configDirectory });
		expect(cycle?.cycle.lane_snapshot).toEqual([
			{ id: "L1-codex", cli: "codex", vendor: "openai", command: "codex review {brief} {out}", required: true },
			{ id: "L2-claude", cli: "claude", vendor: "anthropic", command: "claude review {brief} {out}", required: true },
		]);
		expect(cycle?.cycle.authoring_vendors).toEqual(["xai"]);
		expect(superviseReviewCycle).toHaveBeenCalledOnce();
		const call = superviseReviewCycle.mock.calls[0];
		const options = call?.[2] as { maxParallel?: number } | undefined;
		expect(options?.maxParallel).toBe(1);
	});

	it("resolves the dispatch-order subject from its own authoring_vendors", async () => {
		const repo = await gitRepo();
		const order: LoadedWorkOrder = {
			order: {
				apiVersion: "gatekeeper/v1",
				id: "wo-20260721000000-abc123456789",
				association_key: "acme/widgets#7",
				target_repo: { name: "acme/widgets", path: repo },
				role: "coder",
				brief_path: "brief.md",
				acceptance_contract: {
					result_path: "out/RESULT.json",
					progress_path: "out/PROGRESS.md",
					require_non_wip_commit: true,
					criteria: [],
				},
				candidate_ladder: [{ cli: "codex", vendor: "openai", command: "codex exec {brief} {out}" }],
				authoring_vendors: ["openai"],
				created_at: AT,
			},
			brief: "do the thing",
			journal: [],
			state: "DELIVERED",
			runs: [],
		};
		const configDirectory = await tempDir("gatekeeper-review-cli-config-");
		const superviseReviewCycle = vi.fn(async () => fakeResult({ state: "BLOCKED" }));
		const code = await runReviewStart({ subject: order.order.id, allowDegraded: true, yes: true }, repo, {
			env: { GATEKEEPER_CONFIG_DIR: configDirectory },
			loadOrder: async () => order,
			detectAgentClis: async () => [detectedCli("codex", "openai"), detectedCli("claude", "anthropic")],
			loadRolesPolicy: async () => reviewerTierPolicy,
			superviseReviewCycle,
		});
		expect(code).toBe(REVIEW_ATTENTION_EXIT_CODE);
		const { listCycles } = await import("../src/review/store.js");
		const [cycle] = await listCycles({ GATEKEEPER_CONFIG_DIR: configDirectory });
		// "openai" is the order's own authoring vendor -- codex (openai) must be excluded, leaving only claude required.
		expect(cycle?.cycle.authoring_vendors).toEqual(["openai"]);
		expect(cycle?.cycle.lane_snapshot.map((route) => route.vendor)).toEqual(["anthropic"]);
		expect(cycle?.cycle.degraded).toBe(true);
	});

	it("delegates to resume, not supervise, when the freshly-loaded cycle is not PENDING (defensive positive/negative)", async () => {
		const repo = await gitRepo();
		const configDirectory = await tempDir("gatekeeper-review-cli-config-");
		const superviseReviewCycle = vi.fn(async () => fakeResult({ state: "AWAITING_ACCEPT" }));
		const resumeReviewCycle = vi.fn(async () => fakeResult({ state: "BLOCKED" }));

		// Positive: the cycle start() just created really is PENDING -> supervise is used, resume is not.
		const positive = await runReviewStart({ diff: true, base: "main", authoredBy: ["xai"], yes: true }, repo, {
			env: { GATEKEEPER_CONFIG_DIR: configDirectory },
			detectAgentClis: async () => [detectedCli("codex", "openai"), detectedCli("claude", "anthropic")],
			loadRolesPolicy: async () => reviewerTierPolicy,
			superviseReviewCycle,
			resumeReviewCycle,
		});
		expect(positive).toBe(REVIEW_ATTENTION_EXIT_CODE);
		expect(superviseReviewCycle).toHaveBeenCalledOnce();
		expect(resumeReviewCycle).not.toHaveBeenCalled();

		// Negative/defensive: force driveCycle's own fresh load to observe a non-PENDING state (simulating a race/
		// crash-recovery re-entry) -- it must delegate to resume instead, never supervise.
		superviseReviewCycle.mockClear();
		resumeReviewCycle.mockClear();
		const { loadCycle: realLoadCycle } = await import("../src/review/store.js");
		const loadCycle = vi.fn(async (cycleId: string, env: NodeJS.ProcessEnv = process.env) => {
			const loaded = await realLoadCycle(cycleId, env);
			return { ...loaded, state: "BLOCKED" as const };
		});
		const negative = await runReviewStart({ diff: true, base: "main", authoredBy: ["xai"], yes: true }, repo, {
			env: { GATEKEEPER_CONFIG_DIR: configDirectory },
			detectAgentClis: async () => [detectedCli("codex", "openai"), detectedCli("claude", "anthropic")],
			loadRolesPolicy: async () => reviewerTierPolicy,
			superviseReviewCycle,
			resumeReviewCycle,
			loadCycle,
		});
		expect(negative).toBe(REVIEW_ATTENTION_EXIT_CODE);
		expect(resumeReviewCycle).toHaveBeenCalledOnce();
		expect(superviseReviewCycle).not.toHaveBeenCalled();
	});

	it("exit code matrix: AWAITING_ACCEPT/BLOCKED/ARBITRATION/WAITING_COOLDOWN all exit 3, never 1", async () => {
		const repo = await gitRepo();
		for (const state of ["AWAITING_ACCEPT", "BLOCKED", "ARBITRATION", "WAITING_COOLDOWN"] as const) {
			const code = await runReviewStart({ diff: true, base: "main", authoredBy: ["xai"], yes: true }, repo, {
				env: { GATEKEEPER_CONFIG_DIR: await tempDir("gatekeeper-review-cli-config-") },
				detectAgentClis: async () => [detectedCli("codex", "openai"), detectedCli("claude", "anthropic")],
				loadRolesPolicy: async () => reviewerTierPolicy,
				superviseReviewCycle: async () => fakeResult({ state }),
			});
			expect(code).toBe(REVIEW_ATTENTION_EXIT_CODE);
			expect(code).not.toBe(1);
		}
	});
});

// ---------------------------------------------------------------------------
// runReviewStatus
// ---------------------------------------------------------------------------

describe("runReviewStatus", () => {
	it("lists no cycles and exits 0", async () => {
		const configDirectory = await tempDir("gatekeeper-review-cli-config-");
		const stdout = captureStdout();
		expect(await runReviewStatus({}, "/tmp", { env: { GATEKEEPER_CONFIG_DIR: configDirectory } })).toBe(0);
		expect(stdout.text()).toContain("no cycles");

		const jsonOut = captureStdout();
		expect(await runReviewStatus({ json: true }, "/tmp", { env: { GATEKEEPER_CONFIG_DIR: configDirectory } })).toBe(0);
		expect(JSON.parse(jsonOut.text())).toEqual({ cycles: [] });
	});

	it("exits 2 for an unknown cycle id", async () => {
		const configDirectory = await tempDir("gatekeeper-review-cli-config-");
		const err = captureStderr();
		expect(
			await runReviewStatus({ cycleId: "rc-does-not-exist" }, "/tmp", {
				env: { GATEKEEPER_CONFIG_DIR: configDirectory },
			}),
		).toBe(2);
		expect(err.text()).toContain("rc-does-not-exist");
	});

	it("lists cycle summaries with next-command hints, and --report surfaces blockers/NEW_IN_INCREMENTAL/advisory-fail/fingerprint", async () => {
		const { env, created } = await setupCycle();
		await advanceToBlocked(env, created.cycle.id);
		await writeRoundFixture(env, created.cycle.id, 1, "BLOCKED", [
			{
				route: created.cycle.lane_snapshot[0] as LaneRoute,
				outcome: "FAIL",
				verdict: {
					apiVersion: "gatekeeper/v1",
					verdict: "fail",
					run_token: "rv1_aaaa",
					round: 1,
					blockers: [{ file: "src/x.ts", line: 10, title: "bug", evidence: "proof" }],
					non_blockers: [],
				},
			},
			{ route: created.cycle.lane_snapshot[1] as LaneRoute, outcome: "FAIL", verdict: undefined },
		]);

		const listStdout = captureStdout();
		expect(await runReviewStatus({}, "/tmp", { env })).toBe(0);
		expect(listStdout.text()).toContain(created.cycle.id);
		expect(listStdout.text()).toContain("gatekeeper review fix");

		const stdout = captureStdout();
		const code = await runReviewStatus({ cycleId: created.cycle.id, report: true }, "/tmp", { env });
		expect(code).toBe(0);
		const text = stdout.text();
		expect(text).toContain("B-r1-L1-01");
		expect(text).toContain("advisory lane L2-grok reported FAIL");
		expect(text).toContain("subject fingerprint");

		const jsonStdout = captureStdout();
		await runReviewStatus({ cycleId: created.cycle.id, report: true, json: true }, "/tmp", { env });
		const detail = JSON.parse(jsonStdout.text());
		expect(detail.report.blockers).toHaveLength(1);
		expect(detail.report.advisoryFailWarnings).toHaveLength(1);
	});

	it("marks a round-2 blocker with no ref to round 1 as NEW_IN_INCREMENTAL and sorts it first", async () => {
		const { env, created } = await setupCycle({ max_rounds: 3 });
		await journal(env, {
			apiVersion: "gatekeeper/v1",
			type: "ROUND_STARTED",
			cycle_id: created.cycle.id,
			at: AT,
			round: 1,
			from: "PENDING",
			to: "REVIEWING",
		});
		await writeRoundFixture(env, created.cycle.id, 1, "BLOCKED", [
			{
				route: created.cycle.lane_snapshot[0] as LaneRoute,
				outcome: "FAIL",
				verdict: {
					apiVersion: "gatekeeper/v1",
					verdict: "fail",
					run_token: "rv1_r1",
					round: 1,
					blockers: [{ file: "src/x.ts", line: 10, title: "old bug", evidence: "proof" }],
					non_blockers: [],
				},
			},
		]);
		await journal(env, {
			apiVersion: "gatekeeper/v1",
			type: "ROUND_CONCLUDED",
			cycle_id: created.cycle.id,
			at: AT,
			round: 1,
			verdict: "FAIL",
			from: "REVIEWING",
			to: "BLOCKED",
		});
		await journal(env, {
			apiVersion: "gatekeeper/v1",
			type: "FIX_DISPATCHED",
			cycle_id: created.cycle.id,
			at: AT,
			round: 1,
			fix_order_id: "wo-20260721000000-fixaaaaaaaa",
			from: "BLOCKED",
			to: "FIXING",
		});
		await journal(env, {
			apiVersion: "gatekeeper/v1",
			type: "ROUND_STARTED",
			cycle_id: created.cycle.id,
			at: AT,
			round: 2,
			from: "FIXING",
			to: "REVIEWING",
		});
		await writeRoundFixture(env, created.cycle.id, 2, "BLOCKED", [
			{
				route: created.cycle.lane_snapshot[0] as LaneRoute,
				outcome: "FAIL",
				verdict: {
					apiVersion: "gatekeeper/v1",
					verdict: "fail",
					run_token: "rv1_r2",
					round: 2,
					blockers: [{ file: "src/y.ts", line: 20, title: "new regression", evidence: "proof2" }],
					non_blockers: [],
				},
			},
		]);
		await journal(env, {
			apiVersion: "gatekeeper/v1",
			type: "ROUND_CONCLUDED",
			cycle_id: created.cycle.id,
			at: AT,
			round: 2,
			verdict: "FAIL",
			from: "REVIEWING",
			to: "BLOCKED",
		});

		const jsonStdout = captureStdout();
		await runReviewStatus({ cycleId: created.cycle.id, report: true, json: true }, "/tmp", { env });
		const detail = JSON.parse(jsonStdout.text());
		expect(detail.report.blockers[0].newInIncremental).toBe(true);
		expect(detail.report.blockers[0].title).toBe("new regression");
	});

	it("does not label an ARBITRATION-origin round-2 blocker as NEW_IN_INCREMENTAL", async () => {
		const { env, created } = await setupCycle({ max_rounds: 1 });
		await journal(env, {
			apiVersion: "gatekeeper/v1",
			type: "ROUND_STARTED",
			cycle_id: created.cycle.id,
			at: AT,
			round: 1,
			from: "PENDING",
			to: "REVIEWING",
		});
		await writeRoundFixture(env, created.cycle.id, 1, "ARBITRATION", [
			{
				route: created.cycle.lane_snapshot[0] as LaneRoute,
				outcome: "FAIL",
				verdict: {
					apiVersion: "gatekeeper/v1",
					verdict: "fail",
					run_token: "rv1_r1",
					round: 1,
					blockers: [{ file: "src/x.ts", title: "old bug", evidence: "proof" }],
					non_blockers: [],
				},
			},
		]);
		await journal(env, {
			apiVersion: "gatekeeper/v1",
			type: "ROUND_CONCLUDED",
			cycle_id: created.cycle.id,
			at: AT,
			round: 1,
			verdict: "FAIL",
			from: "REVIEWING",
			to: "ARBITRATION",
		});
		await journal(env, {
			apiVersion: "gatekeeper/v1",
			type: "ROUND_STARTED",
			cycle_id: created.cycle.id,
			at: AT,
			round: 2,
			from: "ARBITRATION",
			to: "REVIEWING",
			previous_max_rounds: 1,
			max_rounds: 2,
			extension_reason: "full re-review",
		});
		await writeRoundFixture(env, created.cycle.id, 2, "ARBITRATION", [
			{
				route: created.cycle.lane_snapshot[0] as LaneRoute,
				outcome: "FAIL",
				verdict: {
					apiVersion: "gatekeeper/v1",
					verdict: "fail",
					run_token: "rv1_r2",
					round: 2,
					blockers: [{ file: "src/y.ts", title: "fresh full-review finding", evidence: "proof2" }],
					non_blockers: [],
				},
			},
		]);
		await journal(env, {
			apiVersion: "gatekeeper/v1",
			type: "ROUND_CONCLUDED",
			cycle_id: created.cycle.id,
			at: AT,
			round: 2,
			verdict: "FAIL",
			from: "REVIEWING",
			to: "ARBITRATION",
		});

		const jsonStdout = captureStdout();
		await runReviewStatus({ cycleId: created.cycle.id, report: true, json: true }, "/tmp", { env });
		const detail = JSON.parse(jsonStdout.text());
		expect(detail.report.blockers[0].title).toBe("fresh full-review finding");
		expect(detail.report.blockers[0].newInIncremental).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// runReviewLogs
// ---------------------------------------------------------------------------

describe("runReviewLogs", () => {
	it("exits 2 for a cycle with no rounds, an unknown round, and an unknown lane", async () => {
		const { env, created } = await setupCycle();
		const err1 = captureStderr();
		expect(await runReviewLogs({ cycleId: created.cycle.id }, "/tmp", { env })).toBe(2);
		expect(err1.text()).toContain("no rounds");

		await journal(env, {
			apiVersion: "gatekeeper/v1",
			type: "ROUND_STARTED",
			cycle_id: created.cycle.id,
			at: AT,
			round: 1,
			from: "PENDING",
			to: "REVIEWING",
		});
		await writeRoundFixture(env, created.cycle.id, 1, "REVIEWING", [
			{ route: created.cycle.lane_snapshot[0] as LaneRoute, outcome: "PASS" },
		]);

		const err2 = captureStderr();
		expect(await runReviewLogs({ cycleId: created.cycle.id, round: "R9" }, "/tmp", { env })).toBe(2);
		expect(err2.text()).toContain("R9");

		const err3 = captureStderr();
		expect(await runReviewLogs({ cycleId: created.cycle.id, lane: "L9-nope" }, "/tmp", { env })).toBe(2);
		expect(err3.text()).toContain("L9-nope");

		// "R2x" must not resolve to round 2 -- Number.parseInt tolerates (and silently ignores) trailing garbage.
		const err4 = captureStderr();
		expect(await runReviewLogs({ cycleId: created.cycle.id, round: "R1x" }, "/tmp", { env })).toBe(2);
		expect(err4.text()).toContain("R1x");
	});

	it("prints lane paths and stdout/stderr tails for the latest round", async () => {
		const { env, created } = await setupCycle();
		await journal(env, {
			apiVersion: "gatekeeper/v1",
			type: "ROUND_STARTED",
			cycle_id: created.cycle.id,
			at: AT,
			round: 1,
			from: "PENDING",
			to: "REVIEWING",
		});
		await writeRoundFixture(env, created.cycle.id, 1, "REVIEWING", [
			{ route: created.cycle.lane_snapshot[0] as LaneRoute, outcome: "PASS" },
		]);

		const stdout = captureStdout();
		const code = await runReviewLogs({ cycleId: created.cycle.id }, "/tmp", { env });
		expect(code).toBe(0);
		expect(stdout.text()).toContain("lane stdout line two");
		expect(stdout.text()).toContain("lane stderr warn");
		expect(stdout.text()).toContain("L1-claude");
	});
});

// ---------------------------------------------------------------------------
// runReviewFix
// ---------------------------------------------------------------------------

describe("runReviewFix", () => {
	it("exits 2 when the cycle is not BLOCKED/AWAITING_ACCEPT", async () => {
		const { env, created } = await setupCycle();
		const err = captureStderr();
		expect(await runReviewFix({ cycleId: created.cycle.id }, "/tmp", { env })).toBe(2);
		expect(err.text()).toContain("fix only applies to");
	});

	it("requires a non-empty reason on --waive, and forbids waiving from AWAITING_ACCEPT", async () => {
		const { env, created } = await setupCycle();
		await advanceToBlocked(env, created.cycle.id);
		const err1 = captureStderr();
		expect(await runReviewFix({ cycleId: created.cycle.id, waive: ["B-r1-L1-01"], yes: true }, "/tmp", { env })).toBe(
			2,
		);
		expect(err1.text()).toContain('"<blocker-id>=<reason>"');

		const { env: env2, created: created2 } = await setupCycle();
		await advanceToAwaitingAccept(env2, created2.cycle.id);
		const err2 = captureStderr();
		expect(
			await runReviewFix({ cycleId: created2.cycle.id, waive: ["B-r1-L1-01=typo"], yes: true }, "/tmp", { env: env2 }),
		).toBe(2);
		expect(err2.text()).toContain("AWAITING_ACCEPT advisory fixes cannot waive");
	});

	it("rejects --waive boundary forms: an empty blocker id (=reason) and an empty reason (id=)", async () => {
		const { env, created } = await setupCycle();
		await advanceToBlocked(env, created.cycle.id);

		const errEmptyId = captureStderr();
		expect(await runReviewFix({ cycleId: created.cycle.id, waive: ["=reason"], yes: true }, "/tmp", { env })).toBe(2);
		expect(errEmptyId.text()).toContain('"<blocker-id>=<reason>"');

		const errEmptyReason = captureStderr();
		expect(await runReviewFix({ cycleId: created.cycle.id, waive: ["B-r1-L1-01="], yes: true }, "/tmp", { env })).toBe(
			2,
		);
		expect(errEmptyReason.text()).toContain('"<blocker-id>=<reason>"');
	});

	it("requires --yes when stdin is not a TTY, and aborts (exit 0) when the prompt declines", async () => {
		const { env, created } = await setupCycle();
		await advanceToBlocked(env, created.cycle.id);
		const err = captureStderr();
		expect(await runReviewFix({ cycleId: created.cycle.id }, "/tmp", { env, isInteractive: false })).toBe(2);
		expect(err.text()).toContain("not an interactive TTY");

		const promptConfirm = vi.fn(async () => false);
		const stdout = captureStdout();
		expect(await runReviewFix({ cycleId: created.cycle.id }, "/tmp", { env, isInteractive: true, promptConfirm })).toBe(
			0,
		);
		expect(stdout.text()).toContain("aborted");
	});

	it("dispatches with exact waived/adopted ids + reasons + operator, prints phase banners, and never exits 1", async () => {
		const { env, created } = await setupCycle();
		await advanceToBlocked(env, created.cycle.id);
		const reviewFix = vi.fn(
			async (
				_cycle: unknown,
				waivedIds: readonly string[],
				adoptedIds: readonly string[],
				deps: { afterJournal?: (event: ReviewJournalEvent) => Promise<void> | void },
			) => {
				await deps.afterJournal?.({
					apiVersion: "gatekeeper/v1",
					type: "FIX_DISPATCHED",
					cycle_id: created.cycle.id,
					at: AT,
					round: 1,
					fix_order_id: "wo-20260721000000-fixaaaaaaaa",
					from: "BLOCKED",
					to: "FIXING",
				});
				await deps.afterJournal?.({
					apiVersion: "gatekeeper/v1",
					type: "ROUND_STARTED",
					cycle_id: created.cycle.id,
					at: AT,
					round: 2,
					from: "FIXING",
					to: "REVIEWING",
				});
				expect(waivedIds).toEqual(["B-r1-L1-01"]);
				expect(adoptedIds).toEqual(["B-r1-L2-01"]);
				return fakeResult({ state: "AWAITING_ACCEPT" });
			},
		);
		const stdout = captureStdout();
		const code = await runReviewFix(
			{ cycleId: created.cycle.id, waive: ["B-r1-L1-01=fixed in the last commit"], adopt: ["B-r1-L2-01"], yes: true },
			"/tmp",
			{ env, reviewFix, operator: "test-op" },
		);
		expect(code).toBe(REVIEW_ATTENTION_EXIT_CODE);
		expect(code).not.toBe(1);
		expect(reviewFix).toHaveBeenCalledOnce();
		const call = reviewFix.mock.calls[0] as unknown as [
			unknown,
			string[],
			string[],
			unknown,
			{ operator: string; waiverReasons: Record<string, string> },
		];
		expect(call[4].operator).toBe("test-op");
		expect(call[4].waiverReasons).toEqual({ "B-r1-L1-01": "fixed in the last commit" });
		expect(stdout.text()).toContain("phase 1 complete");
		expect(stdout.text()).toContain("phase 2: incremental review round 2");
	});

	it("maps an unknown --waive/--adopt id (ReviewAggregateError) to exit 2, and an infra fault to exit 3", async () => {
		const { ReviewAggregateError } = await import("../src/review/aggregate.js");
		const { env, created } = await setupCycle();
		await advanceToBlocked(env, created.cycle.id);
		const usageError = await runReviewFix({ cycleId: created.cycle.id, waive: ["B-nope=reason"], yes: true }, "/tmp", {
			env,
			reviewFix: async () => {
				throw new ReviewAggregateError("UNKNOWN_WAIVER_ID", "cannot waive unknown blocker id(s): B-nope");
			},
		});
		expect(usageError).toBe(2);

		const { env: env2, created: created2 } = await setupCycle();
		await advanceToBlocked(env2, created2.cycle.id);
		const infraError = await runReviewFix({ cycleId: created2.cycle.id, yes: true }, "/tmp", {
			env: env2,
			reviewFix: async () => {
				throw new Error("dispatch supervision faulted");
			},
		});
		expect(infraError).toBe(REVIEW_ATTENTION_EXIT_CODE);
	});
});

// ---------------------------------------------------------------------------
// runReviewAccept
// ---------------------------------------------------------------------------

describe("runReviewAccept", () => {
	it("exits 2 when the cycle is not AWAITING_ACCEPT/ARBITRATION", async () => {
		const { env, created } = await setupCycle();
		const err = captureStderr();
		expect(await runReviewAccept({ cycleId: created.cycle.id }, "/tmp", { env })).toBe(2);
		expect(err.text()).toContain("accept only applies to");
	});

	it("exits 2 for an unknown cycle id (lock acquisition reports CYCLE_NOT_FOUND)", async () => {
		const configDirectory = await tempDir("gatekeeper-review-cli-config-");
		const err = captureStderr();
		expect(
			await runReviewAccept({ cycleId: "rc-does-not-exist" }, "/tmp", {
				env: { GATEKEEPER_CONFIG_DIR: configDirectory },
			}),
		).toBe(2);
		expect(err.text().length).toBeGreaterThan(0);
	});

	it("exits 2 (never 3, never 1) for a malformed cycle id -- consistent with cancel/status/logs/fix/resume/render", async () => {
		const configDirectory = await tempDir("gatekeeper-review-cli-config-");
		const err = captureStderr();
		const code = await runReviewAccept({ cycleId: "bad!!id" }, "/tmp", {
			env: { GATEKEEPER_CONFIG_DIR: configDirectory },
		});
		expect(code).toBe(2);
		expect(code).not.toBe(REVIEW_ATTENTION_EXIT_CODE);
		expect(code).not.toBe(1);
		expect(err.text().length).toBeGreaterThan(0);
	});

	it("accepts AWAITING_ACCEPT -> ACCEPTED and appends a review-ledger ACCEPTED line", async () => {
		const targetPath = await tempDir("gatekeeper-review-cli-target-");
		const { env, created } = await setupCycle({}, targetPath);
		await advanceToAwaitingAccept(env, created.cycle.id);
		const stdout = captureStdout();
		const code = await runReviewAccept({ cycleId: created.cycle.id, note: "looks good" }, "/tmp", {
			env,
			operator: "alice",
		});
		expect(code).toBe(0);
		expect(stdout.text()).toContain("ACCEPTED");

		const ledger = await readFile(path.join(targetPath, ".gatekeeper", "review-ledger.jsonl"), "utf8");
		const entry = JSON.parse(ledger.trim());
		expect(entry).toMatchObject({
			kind: "review",
			cycle_id: created.cycle.id,
			outcome: "ACCEPTED",
			operator: "alice",
			note: "looks good",
		});
	});

	it("reports the held lock as a fault (exit 3), never exit 1", async () => {
		const { env, created } = await setupCycle();
		await advanceToAwaitingAccept(env, created.cycle.id);
		const held = await acquireReviewSupervisorLock(created.cycle.id, { env, pid: process.pid });
		try {
			const code = await runReviewAccept({ cycleId: created.cycle.id }, "/tmp", { env });
			expect(code).toBe(REVIEW_ATTENTION_EXIT_CODE);
			expect(code).not.toBe(1);
		} finally {
			await held.release();
		}
	});

	it("a release() fault never overrides the already-decided exit code (0 on the success path), never exit 1", async () => {
		const { env, created } = await setupCycle();
		await advanceToAwaitingAccept(env, created.cycle.id);
		const throwingRelease = {
			release: vi.fn(async () => {
				throw new Error("release boom");
			}),
		};
		const err = captureStderr();
		const code = await runReviewAccept({ cycleId: created.cycle.id }, "/tmp", {
			env,
			acquireReviewSupervisorLock: async () => throwingRelease,
		});
		expect(code).toBe(0);
		expect(code).not.toBe(1);
		expect(throwingRelease.release).toHaveBeenCalledOnce();
		expect(err.text()).toContain("failed to release the review supervisor lock");
	});
});

// ---------------------------------------------------------------------------
// runReviewArbitrate
// ---------------------------------------------------------------------------

describe("runReviewArbitrate", () => {
	it("requires a non-empty --reason", async () => {
		const { env, created } = await setupCycle();
		const err = captureStderr();
		expect(
			await runReviewArbitrate({ cycleId: created.cycle.id, decision: "accept", reason: "   " }, "/tmp", { env }),
		).toBe(2);
		expect(err.text()).toContain("--reason must not be empty");
	});

	it("exits 2 when the cycle is not in ARBITRATION", async () => {
		const { env, created } = await setupCycle();
		const err = captureStderr();
		expect(
			await runReviewArbitrate({ cycleId: created.cycle.id, decision: "accept", reason: "ok" }, "/tmp", { env }),
		).toBe(2);
		expect(err.text()).toContain("arbitrate only applies to ARBITRATION");
	});

	it("exits 2 (never 3, never 1) for a malformed cycle id -- consistent with cancel/status/logs/fix/resume/render", async () => {
		const configDirectory = await tempDir("gatekeeper-review-cli-config-");
		const err = captureStderr();
		const code = await runReviewArbitrate({ cycleId: "bad!!id", decision: "accept", reason: "ok" }, "/tmp", {
			env: { GATEKEEPER_CONFIG_DIR: configDirectory },
		});
		expect(code).toBe(2);
		expect(code).not.toBe(REVIEW_ATTENTION_EXIT_CODE);
		expect(code).not.toBe(1);
		expect(err.text().length).toBeGreaterThan(0);
	});

	it("--decision accept -> ACCEPTED (exit 0) with a review-ledger line", async () => {
		const targetPath = await tempDir("gatekeeper-review-cli-target-");
		const { env, created } = await setupCycle({}, targetPath);
		await advanceToArbitration(env, created.cycle.id);
		const code = await runReviewArbitrate(
			{ cycleId: created.cycle.id, decision: "accept", reason: "human overrides" },
			"/tmp",
			{ env, operator: "bob" },
		);
		expect(code).toBe(0);
		const ledger = JSON.parse(
			(await readFile(path.join(targetPath, ".gatekeeper", "review-ledger.jsonl"), "utf8")).trim(),
		);
		expect(ledger).toMatchObject({ outcome: "ACCEPTED", operator: "bob", note: "human overrides" });
	});

	it("--decision abandon -> ABANDONED (exit 3) with a review-ledger line, never exit 1", async () => {
		const targetPath = await tempDir("gatekeeper-review-cli-target-");
		const { env, created } = await setupCycle({}, targetPath);
		await advanceToArbitration(env, created.cycle.id);
		const code = await runReviewArbitrate(
			{ cycleId: created.cycle.id, decision: "abandon", reason: "not worth it" },
			"/tmp",
			{ env },
		);
		expect(code).toBe(REVIEW_ATTENTION_EXIT_CODE);
		expect(code).not.toBe(1);
		const ledger = JSON.parse(
			(await readFile(path.join(targetPath, ".gatekeeper", "review-ledger.jsonl"), "utf8")).trim(),
		);
		expect(ledger).toMatchObject({ outcome: "ABANDONED" });
	});

	it("--decision extend grants exactly +1 round, journals the extension, then drives the new round via resume", async () => {
		const { env, created } = await setupCycle({ max_rounds: 1 });
		await advanceToArbitration(env, created.cycle.id);
		const resumeReviewCycle = vi.fn(async () => fakeResult({ state: "BLOCKED" }));
		const superviseReviewCycle = vi.fn(async () => fakeResult({ state: "AWAITING_ACCEPT" }));
		const code = await runReviewArbitrate(
			{ cycleId: created.cycle.id, decision: "extend", reason: "one more shot" },
			"/tmp",
			{ env, resumeReviewCycle, superviseReviewCycle },
		);
		expect(code).toBe(REVIEW_ATTENTION_EXIT_CODE);
		expect(resumeReviewCycle).toHaveBeenCalledOnce();
		expect(superviseReviewCycle).not.toHaveBeenCalled();

		const { loadCycle } = await import("../src/review/store.js");
		const reloaded = await loadCycle(created.cycle.id, env);
		const { effectiveMaxRounds } = await import("../src/review/machine.js");
		expect(effectiveMaxRounds(reloaded.cycle.max_rounds, reloaded.journal)).toBe(2);
		expect(reloaded.journal.at(-1)).toMatchObject({
			type: "ROUND_STARTED",
			round: 2,
			extension_reason: "one more shot",
		});
	});

	it("--decision extend drives a real supervisor and real fake-reviewer process through a full R2 review", async () => {
		const targetPath = await realReviewGitRepo();
		const { env, created } = await setupCycle(
			{
				max_rounds: 1,
				lane_snapshot: [
					{
						id: "L1-claude",
						cli: "claude",
						vendor: "anthropic",
						command: realReviewerCommand(),
						required: true,
					},
				],
			},
			targetPath,
		);
		const stdout = captureStdout();
		const stderr = captureStderr();

		const firstCode = await runReviewResume({ cycleId: created.cycle.id }, "/tmp", { env });
		expect(firstCode).toBe(REVIEW_ATTENTION_EXIT_CODE);
		const { loadCycle } = await import("../src/review/store.js");
		expect((await loadCycle(created.cycle.id, env)).state).toBe("ARBITRATION");

		const extendCode = await runReviewArbitrate(
			{ cycleId: created.cycle.id, decision: "extend", reason: "real full re-review" },
			"/tmp",
			{ env, operator: "integration-test" },
		);
		expect(extendCode).toBe(REVIEW_ATTENTION_EXIT_CODE);
		const reloaded = await loadCycle(created.cycle.id, env);
		expect(reloaded.state).toBe("AWAITING_ACCEPT");
		expect(reloaded.rounds.at(-1)?.summary).toMatchObject({ number: 2, verdict: "PASS" });
		expect(reloaded.journal.find((event) => event.type === "ROUND_STARTED" && event.round === 2)).toMatchObject({
			from: "ARBITRATION",
			previous_max_rounds: 1,
			max_rounds: 2,
		});
		const brief = await readFile(
			path.join(reviewCycleDirectory(created.cycle.id, env), "rounds", "R2", "lanes", "L1-claude", "brief.md"),
			"utf8",
		);
		expect(brief).toContain("## Diff 范围");
		expect(brief).not.toContain("增量复审");
		expect(brief).not.toContain("## 修复 Commit 范围");
		expect(brief).not.toContain("## 范围锁");
		expect(stdout.text()).toContain("gatekeeper review arbitrate");
		expect(stderr.text()).not.toContain("FIX_CONTEXT_REQUIRED");
	});

	it("a release() fault never overrides the already-decided exit code (0 for accept, 3 for abandon), never exit 1", async () => {
		const targetPath = await tempDir("gatekeeper-review-cli-target-");
		const throwingRelease = () => ({
			release: vi.fn(async () => {
				throw new Error("release boom");
			}),
		});

		const { env, created } = await setupCycle({}, targetPath);
		await advanceToArbitration(env, created.cycle.id);
		const errAccept = captureStderr();
		const acceptCode = await runReviewArbitrate(
			{ cycleId: created.cycle.id, decision: "accept", reason: "human overrides" },
			"/tmp",
			{ env, acquireReviewSupervisorLock: async () => throwingRelease() },
		);
		expect(acceptCode).toBe(0);
		expect(acceptCode).not.toBe(1);
		expect(errAccept.text()).toContain("failed to release the review supervisor lock");

		const { env: env2, created: created2 } = await setupCycle({}, targetPath);
		await advanceToArbitration(env2, created2.cycle.id);
		const abandonCode = await runReviewArbitrate(
			{ cycleId: created2.cycle.id, decision: "abandon", reason: "not worth it" },
			"/tmp",
			{ env: env2, acquireReviewSupervisorLock: async () => throwingRelease() },
		);
		expect(abandonCode).toBe(REVIEW_ATTENTION_EXIT_CODE);
		expect(abandonCode).not.toBe(1);
	});
});

// ---------------------------------------------------------------------------
// runReviewResume
// ---------------------------------------------------------------------------

describe("runReviewResume", () => {
	it("is a no-op (exit 0) for an already-ACCEPTED cycle, and a no-op (exit 3, never 1) for ABANDONED", async () => {
		const { env, created } = await setupCycle();
		await advanceToAccepted(env, created.cycle.id);
		expect(await runReviewResume({ cycleId: created.cycle.id }, "/tmp", { env })).toBe(0);

		const { env: env2, created: created2 } = await setupCycle();
		await advanceToAbandoned(env2, created2.cycle.id);
		const code = await runReviewResume({ cycleId: created2.cycle.id }, "/tmp", { env: env2 });
		expect(code).toBe(REVIEW_ATTENTION_EXIT_CODE);
		expect(code).not.toBe(1);
	});

	it("exits 2 for an unknown cycle id", async () => {
		const configDirectory = await tempDir("gatekeeper-review-cli-config-");
		expect(
			await runReviewResume({ cycleId: "rc-does-not-exist" }, "/tmp", {
				env: { GATEKEEPER_CONFIG_DIR: configDirectory },
			}),
		).toBe(2);
	});

	it("drives a non-terminal cycle via resumeReviewCycle and reports its resulting state", async () => {
		const { env, created } = await setupCycle();
		await advanceToWaitingCooldown(env, created.cycle.id);
		const resumeReviewCycle = vi.fn(async () => fakeResult({ state: "BLOCKED" }));
		const code = await runReviewResume({ cycleId: created.cycle.id }, "/tmp", { env, resumeReviewCycle });
		expect(code).toBe(REVIEW_ATTENTION_EXIT_CODE);
		expect(resumeReviewCycle).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// runReviewCancel
// ---------------------------------------------------------------------------

describe("runReviewCancel", () => {
	it("is a no-op (exit 0) for an already-terminal cycle", async () => {
		const { env, created } = await setupCycle();
		await advanceToAccepted(env, created.cycle.id);
		expect(await runReviewCancel({ cycleId: created.cycle.id }, "/tmp", { env })).toBe(0);
	});

	it("refuses a PENDING cycle (exit 2, no cancel edge)", async () => {
		const { env, created } = await setupCycle();
		const err = captureStderr();
		expect(await runReviewCancel({ cycleId: created.cycle.id }, "/tmp", { env })).toBe(2);
		expect(err.text()).toContain("PENDING");
	});

	it("exits 2 for an unknown cycle id", async () => {
		const configDirectory = await tempDir("gatekeeper-review-cli-config-");
		expect(
			await runReviewCancel({ cycleId: "rc-does-not-exist" }, "/tmp", {
				env: { GATEKEEPER_CONFIG_DIR: configDirectory },
			}),
		).toBe(2);
	});

	it("cancels a non-terminal cycle to ABANDONED (exit 3, never 1) and appends a review-ledger line", async () => {
		const targetPath = await tempDir("gatekeeper-review-cli-target-");
		const { env, created } = await setupCycle({}, targetPath);
		await advanceToBlocked(env, created.cycle.id);
		const code = await runReviewCancel({ cycleId: created.cycle.id }, "/tmp", { env, operator: "carol" });
		expect(code).toBe(REVIEW_ATTENTION_EXIT_CODE);
		expect(code).not.toBe(1);
		const { loadCycle } = await import("../src/review/store.js");
		expect((await loadCycle(created.cycle.id, env)).state).toBe("ABANDONED");
		const ledger = JSON.parse(
			(await readFile(path.join(targetPath, ".gatekeeper", "review-ledger.jsonl"), "utf8")).trim(),
		);
		expect(ledger).toMatchObject({ outcome: "ABANDONED", operator: "carol" });
	});

	it("a release() fault never overrides the already-decided exit code (3), never exit 1", async () => {
		const targetPath = await tempDir("gatekeeper-review-cli-target-");
		const { env, created } = await setupCycle({}, targetPath);
		await advanceToBlocked(env, created.cycle.id);
		const throwingRelease = {
			release: vi.fn(async () => {
				throw new Error("release boom");
			}),
		};
		const err = captureStderr();
		const code = await runReviewCancel({ cycleId: created.cycle.id }, "/tmp", {
			env,
			acquireReviewSupervisorLock: async () => throwingRelease,
		});
		expect(code).toBe(REVIEW_ATTENTION_EXIT_CODE);
		expect(code).not.toBe(1);
		expect(throwingRelease.release).toHaveBeenCalledOnce();
		expect(err.text()).toContain("failed to release the review supervisor lock");
		const { loadCycle } = await import("../src/review/store.js");
		expect((await loadCycle(created.cycle.id, env)).state).toBe("ABANDONED");
	});
});

// ---------------------------------------------------------------------------
// runReviewRender -- marker collision guard
// ---------------------------------------------------------------------------

describe("runReviewRender", () => {
	it("rejects an unsupported --format", async () => {
		const { env, created } = await setupCycle();
		const err = captureStderr();
		expect(await runReviewRender({ cycleId: created.cycle.id, format: "json" }, "/tmp", { env })).toBe(2);
		expect(err.text()).toContain("unsupported --format");
	});

	it("exits 2 for an unknown cycle id", async () => {
		const configDirectory = await tempDir("gatekeeper-review-cli-config-");
		expect(
			await runReviewRender({ cycleId: "rc-does-not-exist", format: "comment" }, "/tmp", {
				env: { GATEKEEPER_CONFIG_DIR: configDirectory },
			}),
		).toBe(2);
	});

	it("renders its own versioned marker and never emits the gate's sticky-comment marker (collision guard)", async () => {
		const { env, created } = await setupCycle();
		await advanceToAccepted(env, created.cycle.id);
		const stdout = captureStdout();
		const code = await runReviewRender({ cycleId: created.cycle.id, format: "comment" }, "/tmp", { env });
		expect(code).toBe(0);
		const body = stdout.text();
		expect(body.startsWith(REVIEW_RENDER_MARKER)).toBe(true);
		expect(body).not.toContain(COMMENT_MARKER);
		expect(REVIEW_RENDER_MARKER).not.toContain(COMMENT_MARKER);
		expect(body).toContain(created.cycle.id);
		expect(body).toContain("ACCEPTED");
	});
});
