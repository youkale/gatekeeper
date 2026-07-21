import { randomBytes, randomUUID } from "node:crypto";
import { realpath as fsRealpath, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentRunOptions, AgentRunResult } from "../agent/runner.js";
import { AgentRunError, runAgentCommand } from "../agent/runner.js";
import { classifyRunOutcome, type SupervisorAttestedOutcome } from "../dispatch/classify.js";
import type { DeliveryEvidence, GitExecutor } from "../dispatch/evidence.js";
import type { SupervisorLockRecord } from "../dispatch/lock.js";
import { createOrder, dispatchOrderDirectory, type LoadedWorkOrder, listOrders, loadOrder } from "../dispatch/store.js";
import {
	type SupervisionResult as DispatchSupervisionResult,
	type SupervisorDependencies as DispatchSupervisorDependencies,
	superviseWorkOrder,
} from "../dispatch/supervisor.js";
import {
	DISPATCH_BRANCH_PREFIX,
	type ReuseDispatchBranch,
	readWorkspaceFingerprint,
	type WorkspaceFingerprint,
} from "../dispatch/workspace.js";
import {
	detectReviewResultChannel,
	type ReviewDiffScope,
	type ReviewSubjectMaterial,
	renderFixBrief,
	renderIncrementalReviewBrief,
	renderReviewBrief,
} from "../render/reviewBrief.js";
import { type AggregatedBlocker, aggregateBlockers, applyWaivers, type LaneVerdict, resolveRefs } from "./aggregate.js";
import { laneOutcome, type ReviewLaneOutcome } from "./evidence.js";
import { acquireReviewSupervisorLock, type ReviewSupervisorLock } from "./lock.js";
import { effectiveMaxRounds, roundConclusionTarget } from "./machine.js";
import { appendJournalEvent, type LoadedReviewCycle, listCycles, loadCycle, reviewCycleDirectory } from "./store.js";
import {
	aggregateRequiredLaneResults,
	type Lane,
	type LaneRoute,
	laneIdSchema,
	laneSchema,
	type ReviewCycle,
	type ReviewCycleState,
	type ReviewJournalEvent,
	type Round,
	roundSchema,
} from "./types.js";
import { generateRunToken, type ReviewVerdict, type RunTokenRandomSource } from "./verdict.js";

export const REVIEW_STALL_SECONDS = 600;
export const REVIEW_MAX_LANE_SECONDS = 3_600;

const ROUND_SUMMARY_FILENAME = "summary.json";
const ROUND_AGGREGATE_FILENAME = "aggregate.json";
const LANE_META_FILENAME = "meta.json";
const LANE_ATTEMPTS_FILENAME = "attempts.json";
const FIX_CONTEXT_FILENAME = "fix-context.json";

type ReviewRunner = (options: AgentRunOptions) => Promise<AgentRunResult>;
type Candidate = Pick<LaneRoute, "cli" | "vendor" | "command">;

export interface ReviewTimerScheduler {
	set(delayMs: number, callback: () => void): unknown;
	clear(handle: unknown): void;
}

export interface ReviewBriefContent {
	readonly roleCard: string;
	readonly diffScope: ReviewDiffScope;
	readonly subject?: ReviewSubjectMaterial;
}

export interface ReviewCycleOptions {
	readonly maxParallel?: number;
	/** Used by a resumed incremental round when its fix context was supplied out of band. */
	readonly priorBlockers?: readonly AggregatedBlocker[];
	readonly fixCommitRange?: ReviewDiffScope;
}

export interface ReviewSupervisorWarning {
	readonly code: "REVIEWER_WROTE_REPO" | "DANGLING_BLOCKER_REF" | "LOG_SINK_DEGRADED";
	readonly message: string;
	readonly laneId?: string;
}

export interface ReviewSupervisionResult {
	readonly cycleId: string;
	readonly state: ReviewCycleState;
	readonly round?: Round;
	readonly blockers: readonly AggregatedBlocker[];
	readonly warnings: readonly ReviewSupervisorWarning[];
	readonly fixOrderId?: string;
}

export type ReviewSupervisorErrorCode =
	| "TARGET_REPOSITORY_BUSY"
	| "INVALID_MAX_PARALLEL"
	| "ROUND_STATE_CORRUPT"
	| "FIX_CONTEXT_REQUIRED"
	| "FIX_DISPATCH_FAILED";

export class ReviewSupervisorError extends Error {
	readonly code: ReviewSupervisorErrorCode;
	readonly conflictingOrderId?: string;

	constructor(
		code: ReviewSupervisorErrorCode,
		message: string,
		details: { conflictingOrderId?: string; cause?: unknown } = {},
	) {
		super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
		this.name = "ReviewSupervisorError";
		this.code = code;
		this.conflictingOrderId = details.conflictingOrderId;
	}
}

export interface FixAuthorContext {
	readonly candidate: Candidate;
	readonly originalOrderId: string;
	readonly baseRef: string;
	readonly reuseBranch: ReuseDispatchBranch;
}

export interface ReviewFixOrderInput {
	readonly associationKey: string;
	readonly targetRepo: ReviewCycle["target_repo"];
	readonly brief: string;
	readonly candidate: Candidate;
	readonly criteria: readonly string[];
	readonly cycleId: string;
	readonly round: number;
}

export interface ReviewFixSupervisionInput {
	readonly orderId: string;
	readonly baseRef: string;
	readonly reuseBranch: ReuseDispatchBranch;
	/** The sole review cycle hidden from dispatch's reverse busy scan. */
	readonly busyExemptionCycleId: string;
}

export interface ReviewSupervisorDependencies {
	readonly env?: NodeJS.ProcessEnv;
	readonly pid?: number;
	readonly now?: () => Date;
	readonly idGenerator?: () => string;
	readonly randomBytes?: RunTokenRandomSource;
	readonly timers?: ReviewTimerScheduler;
	readonly runner?: ReviewRunner;
	readonly git: GitExecutor;
	readonly content: ReviewBriefContent;
	readonly workspaceFingerprint?: (git: GitExecutor) => Promise<WorkspaceFingerprint>;
	readonly realpath?: (target: string) => Promise<string>;
	readonly listDispatchOrders?: (env: NodeJS.ProcessEnv) => Promise<LoadedWorkOrder[]>;
	readonly readDispatchSupervisorRecord?: (
		orderId: string,
		env: NodeJS.ProcessEnv,
	) => Promise<SupervisorLockRecord | undefined>;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly load?: (cycleId: string, env: NodeJS.ProcessEnv) => Promise<LoadedReviewCycle>;
	readonly append?: (cycleId: string, event: ReviewJournalEvent, env: NodeJS.ProcessEnv) => Promise<void>;
	readonly acquireLock?: (cycleId: string) => Promise<Pick<ReviewSupervisorLock, "release">>;
	/** Crash-injection seam. It runs after the durable journal append and before the transition's visible side effect. */
	readonly afterJournal?: (event: ReviewJournalEvent) => void | Promise<void>;
	readonly resolveFixAuthorContext?: (cycle: ReviewCycle) => Promise<FixAuthorContext>;
	readonly loadDispatchOrder?: (orderId: string, env: NodeJS.ProcessEnv) => Promise<LoadedWorkOrder>;
	readonly createFixOrder?: (input: ReviewFixOrderInput) => Promise<{ orderId: string }>;
	readonly superviseFixOrder?: (input: ReviewFixSupervisionInput) => Promise<{ state: string }>;
	readonly dispatchSupervisorDependencies?: Omit<
		DispatchSupervisorDependencies,
		"env" | "now" | "idGenerator" | "git" | "listReviewCycles"
	>;
	readonly listReviewCyclesForDispatch?: (env: NodeJS.ProcessEnv) => Promise<LoadedReviewCycle[]>;
}

interface StoredAttempt {
	index: number;
	candidate: Candidate;
	runToken: string;
	startedAt: string;
	before: WorkspaceFingerprint;
	status: "RUNNING" | "FINISHED";
	endedAt?: string;
	outcome?: Lane["outcome"];
	reason?: string;
	exitCode?: number | null;
	signal?: string | null;
	cooldownResumeAfter?: string;
	pid?: number;
	pgid?: number;
}

interface RoundAggregateFile {
	apiVersion: "gatekeeper/v1";
	round: number;
	blockers: AggregatedBlocker[];
	warnings: ReviewSupervisorWarning[];
	resolvedBlockers?: ReturnType<typeof resolveRefs>["blockers"];
	danglingRefs?: ReturnType<typeof resolveRefs>["danglingRefs"];
}

interface StoredFixContext {
	cycleId: string;
	round: number;
	orderId: string;
	baseRef: string;
	reuseBranch: ReuseDispatchBranch;
	priorBlockers: AggregatedBlocker[];
}

interface AttemptExecution {
	outcome: NonNullable<Lane["outcome"]>;
	verdict?: ReviewVerdict;
	reason?: string;
	cooldownResumeAfter?: string;
	exitCode: number | null;
	signal: string | null;
	pid?: number;
	pgid?: number;
}

interface LaneExecution {
	lane: Lane;
	verdict?: ReviewVerdict;
	warnings: ReviewSupervisorWarning[];
	cooldown?: { laneId: string; resumeAfter: string };
}

interface RoundPaths {
	work: string;
	final: string;
	visible: string;
	isFinal: boolean;
}

interface RoundRuntime {
	loaded: LoadedReviewCycle;
	journal: JournalWriter;
	paths: RoundPaths;
	roundNumber: number;
	roundFrom: Extract<ReviewJournalEvent, { type: "ROUND_STARTED" }>["from"];
	priorBlockers: readonly AggregatedBlocker[];
	fixCommitRange?: ReviewDiffScope;
	maxParallel: number;
}

const defaultTimers: ReviewTimerScheduler = {
	set(delayMs, callback) {
		return setTimeout(callback, delayMs);
	},
	clear(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

const noEvidence: DeliveryEvidence = {
	resultFile: { established: false, reason: "missing", message: "review lanes do not use dispatch RESULT.json" },
	commit: { established: false, reason: "no-commits", commitSubjects: [] },
};

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function readDispatchSupervisorRecord(
	orderId: string,
	env: NodeJS.ProcessEnv,
): Promise<SupervisorLockRecord | undefined> {
	try {
		const raw: unknown = JSON.parse(
			await readFile(path.join(dispatchOrderDirectory(orderId, env), "supervisor.lock"), "utf8"),
		);
		if (
			typeof raw === "object" &&
			raw !== null &&
			"pid" in raw &&
			Number.isInteger(raw.pid) &&
			Number(raw.pid) > 0 &&
			"started_at" in raw &&
			typeof raw.started_at === "string" &&
			Number.isFinite(Date.parse(raw.started_at))
		) {
			return { pid: Number(raw.pid), started_at: raw.started_at };
		}
		throw new ReviewSupervisorError(
			"TARGET_REPOSITORY_BUSY",
			`dispatch order ${orderId} has a malformed supervisor lock`,
			{ conflictingOrderId: orderId },
		);
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
			return undefined;
		}
		if (error instanceof ReviewSupervisorError) {
			throw error;
		}
		throw new ReviewSupervisorError("TARGET_REPOSITORY_BUSY", `dispatch order ${orderId} lock could not be verified`, {
			conflictingOrderId: orderId,
			cause: error,
		});
	}
}

function cycleIdOf(cycle: string | ReviewCycle | LoadedReviewCycle): string {
	if (typeof cycle === "string") {
		return cycle;
	}
	return "cycle" in cycle ? cycle.cycle.id : cycle.id;
}

function routeCandidate(route: LaneRoute): Candidate {
	return { cli: route.cli, vendor: route.vendor, command: route.command };
}

function sameCandidate(left: Candidate, right: Candidate): boolean {
	return left.cli === right.cli && left.vendor === right.vendor && left.command === right.command;
}

function validParallelism(value: number): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new ReviewSupervisorError("INVALID_MAX_PARALLEL", "maxParallel must be a positive integer");
	}
	return value;
}

function currentRoundNumber(events: readonly ReviewJournalEvent[]): number {
	let round = 0;
	for (const event of events) {
		if (event.type === "ROUND_STARTED") {
			round = event.round;
		}
	}
	return round;
}

function at(now: () => Date): string {
	return now().toISOString();
}

function requireIncrementalFixCommitRange(runtime: RoundRuntime): ReviewDiffScope {
	if (runtime.fixCommitRange === undefined) {
		throw new ReviewSupervisorError(
			"FIX_CONTEXT_REQUIRED",
			`incremental R${runtime.roundNumber} requires a persisted fix commit range`,
		);
	}
	return runtime.fixCommitRange;
}

async function atomicWrite(file: string, content: string, idGenerator: () => string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}-${idGenerator().replace(/[^a-zA-Z0-9-]/g, "")}`;
	try {
		await writeFile(temporary, content, "utf8");
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function atomicJson(file: string, value: unknown, idGenerator: () => string): Promise<void> {
	await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, idGenerator);
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
			return undefined;
		}
		throw error;
	}
}

function laneRoot(round: number, laneId: string): string {
	return `rounds/R${round}/lanes/${laneId}`;
}

function pendingLane(cycle: ReviewCycle, route: LaneRoute, round: number): Lane {
	const root = laneRoot(round, route.id);
	return laneSchema.parse({
		apiVersion: "gatekeeper/v1",
		id: route.id,
		cycle_id: cycle.id,
		round,
		cli: route.cli,
		vendor: route.vendor,
		command: route.command,
		required: route.required,
		status: "PENDING",
		brief_path: `${root}/brief.md`,
		stdout_path: `${root}/stdout.log`,
		stderr_path: `${root}/stderr.log`,
		out_path: `${root}/out`,
		result_path: `${root}/out/VERDICT.json`,
	});
}

function laneDirectory(roundDirectory: string, laneId: string): string {
	return path.join(roundDirectory, "lanes", laneId);
}

function resultPath(roundDirectory: string, laneId: string): string {
	return path.join(laneDirectory(roundDirectory, laneId), "out", "VERDICT.json");
}

async function readLane(roundDirectory: string, laneId: string): Promise<Lane> {
	const value = await readJson<unknown>(path.join(laneDirectory(roundDirectory, laneId), LANE_META_FILENAME));
	const parsed = laneSchema.safeParse(value);
	if (!parsed.success) {
		throw new ReviewSupervisorError("ROUND_STATE_CORRUPT", `lane ${laneId} metadata is missing or invalid`);
	}
	return parsed.data;
}

async function readRound(roundDirectory: string): Promise<Round> {
	const value = await readJson<unknown>(path.join(roundDirectory, ROUND_SUMMARY_FILENAME));
	const parsed = roundSchema.safeParse(value);
	if (!parsed.success) {
		throw new ReviewSupervisorError("ROUND_STATE_CORRUPT", `${roundDirectory}/summary.json is missing or invalid`);
	}
	return parsed.data;
}

async function roundPaths(cycle: ReviewCycle, round: number, env: NodeJS.ProcessEnv): Promise<RoundPaths> {
	const rounds = path.join(reviewCycleDirectory(cycle.id, env), "rounds");
	const final = path.join(rounds, `R${round}`);
	const work = path.join(rounds, `.tmp-R${round}-supervisor`);
	const finalExists = await readFile(path.join(final, ROUND_SUMMARY_FILENAME), "utf8")
		.then(() => true)
		.catch((error) => {
			if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
				return false;
			}
			throw error;
		});
	if (finalExists) {
		return { work, final, visible: final, isFinal: true };
	}
	return { work, final, visible: work, isFinal: false };
}

class JournalWriter {
	readonly events: ReviewJournalEvent[];
	private tail: Promise<void> = Promise.resolve();

	constructor(
		private readonly cycleId: string,
		events: readonly ReviewJournalEvent[],
		private readonly env: NodeJS.ProcessEnv,
		private readonly append: NonNullable<ReviewSupervisorDependencies["append"]>,
		private readonly afterJournal?: ReviewSupervisorDependencies["afterJournal"],
	) {
		this.events = [...events];
	}

	async write(event: ReviewJournalEvent): Promise<void> {
		const operation = this.tail.then(async () => {
			await this.append(this.cycleId, event, this.env);
			this.events.push(event);
			await this.afterJournal?.(event);
		});
		this.tail = operation.catch(() => undefined);
		await operation;
	}
}

async function createRoundWorkspace(
	loaded: LoadedReviewCycle,
	round: number,
	paths: RoundPaths,
	fingerprint: WorkspaceFingerprint,
	now: () => Date,
	idGenerator: () => string,
): Promise<void> {
	await mkdir(paths.work, { recursive: true });
	const summary = roundSchema.parse({
		apiVersion: "gatekeeper/v1",
		id: `R${round}`,
		cycle_id: loaded.cycle.id,
		number: round,
		status: "REVIEWING",
		subject_fingerprint: fingerprint,
		lane_ids: loaded.cycle.lane_snapshot.map((route) => route.id),
		lane_results: [],
		started_at: at(now),
	});
	await atomicJson(path.join(paths.work, ROUND_SUMMARY_FILENAME), summary, idGenerator);
	for (const route of loaded.cycle.lane_snapshot) {
		const directory = laneDirectory(paths.work, route.id);
		await mkdir(path.join(directory, "out"), { recursive: true });
		await atomicJson(path.join(directory, LANE_META_FILENAME), pendingLane(loaded.cycle, route, round), idGenerator);
		await atomicJson(path.join(directory, LANE_ATTEMPTS_FILENAME), [], idGenerator);
	}
}

function terminalDetails(error: unknown): {
	exitCode: number | null;
	signal: string | null;
	stderr: string;
	spawnFailed: boolean;
} {
	if (error instanceof AgentRunError) {
		return {
			exitCode: error.exitCode,
			signal: error.signal,
			stderr: error.stderrTail,
			spawnFailed: error.kind === "spawn-failed",
		};
	}
	return { exitCode: null, signal: null, stderr: errorMessage(error), spawnFailed: true };
}

async function runWithTimers(
	options: AgentRunOptions,
	runner: ReviewRunner,
	timers: ReviewTimerScheduler,
): Promise<{
	result?: AgentRunResult;
	error?: unknown;
	supervisorOutcome?: Extract<SupervisorAttestedOutcome, "TIMEOUT" | "STALLED">;
}> {
	const controller = new AbortController();
	let supervisorOutcome: Extract<SupervisorAttestedOutcome, "TIMEOUT" | "STALLED"> | undefined;
	let stallTimer: unknown;
	let wallTimer: unknown;
	const abortFor = (outcome: Extract<SupervisorAttestedOutcome, "TIMEOUT" | "STALLED">) => {
		if (supervisorOutcome === undefined) {
			supervisorOutcome = outcome;
			controller.abort();
		}
	};
	const resetStall = () => {
		if (stallTimer !== undefined) {
			timers.clear(stallTimer);
		}
		stallTimer = timers.set(REVIEW_STALL_SECONDS * 1_000, () => abortFor("STALLED"));
	};
	resetStall();
	wallTimer = timers.set(REVIEW_MAX_LANE_SECONDS * 1_000, () => abortFor("TIMEOUT"));
	try {
		const result = await runner({
			...options,
			timeoutSeconds: REVIEW_MAX_LANE_SECONDS,
			signal: controller.signal,
			onActivity: resetStall,
		});
		return { result, supervisorOutcome };
	} catch (error) {
		return { error, supervisorOutcome };
	} finally {
		if (stallTimer !== undefined) {
			timers.clear(stallTimer);
		}
		if (wallTimer !== undefined) {
			timers.clear(wallTimer);
		}
	}
}

function outcomeReason(outcome: ReviewLaneOutcome): string | undefined {
	return outcome.outcome === "INVALID" ? outcome.reason : undefined;
}

async function executeAttempt(
	runtime: RoundRuntime,
	route: LaneRoute,
	candidate: Candidate,
	index: number,
	dependencies: ReviewSupervisorDependencies,
	attempts: StoredAttempt[],
): Promise<AttemptExecution> {
	const env = dependencies.env ?? process.env;
	const now = dependencies.now ?? (() => new Date());
	const idGenerator = dependencies.idGenerator ?? randomUUID;
	const tokenSource = dependencies.randomBytes ?? ((length: number) => randomBytes(length));
	const workspaceFingerprint = dependencies.workspaceFingerprint ?? readWorkspaceFingerprint;
	const timers = dependencies.timers ?? defaultTimers;
	const runner = dependencies.runner ?? runAgentCommand;
	await assertNoDispatchConflict(runtime.loaded.cycle, dependencies, env);

	const directory = laneDirectory(runtime.paths.visible, route.id);
	const verdictFile = resultPath(runtime.paths.visible, route.id);
	await rm(verdictFile, { force: true });
	const before = await workspaceFingerprint(dependencies.git);
	const runToken = generateRunToken(tokenSource);
	const substitute = !sameCandidate(candidate, routeCandidate(route));
	const roleCard = substitute
		? `${dependencies.content.roleCard}\n\n替补路声明：原候选无法建立合法 verdict；你是非 authoring 替补，须从严独立复核。`
		: dependencies.content.roleCard;
	const subject = dependencies.content.subject ?? {
		deliveryReport: runtime.loaded.subject,
		selfReportedRisks: "(not separately supplied)",
	};
	// candidate.command is the *unsubstituted* {brief}/{out} template (see runWithTimers below, which hands
	// it straight to runAgentCommand for placeholder substitution) -- exactly what detectReviewResultChannel
	// expects. Every lane gets its own detection here rather than one cycle-wide value because a substitute
	// candidate (see `substitute`/routeCandidate above) can carry a different command/vendor than the
	// route's original.
	const resultChannel = detectReviewResultChannel(candidate.command);
	const brief =
		runtime.roundFrom !== "FIXING"
			? renderReviewBrief({
					round: runtime.roundNumber,
					runToken,
					roleCard,
					diffScope: dependencies.content.diffScope,
					subject,
					resultChannel,
				})
			: renderIncrementalReviewBrief({
					round: runtime.roundNumber,
					runToken,
					roleCard,
					diffScope: dependencies.content.diffScope,
					subject,
					fixCommitRange: requireIncrementalFixCommitRange(runtime),
					priorBlockers: runtime.priorBlockers,
					resultChannel,
				});
	await atomicWrite(path.join(directory, "brief.md"), brief, idGenerator);
	const startedAt = at(now);
	const attempt: StoredAttempt = {
		index,
		candidate,
		runToken,
		startedAt,
		before,
		status: "RUNNING",
	};
	attempts.push(attempt);
	await atomicJson(path.join(directory, LANE_ATTEMPTS_FILENAME), attempts, idGenerator);
	const current = await readLane(runtime.paths.visible, route.id);
	const running = laneSchema.parse({
		...current,
		status: "RUNNING",
		started_at: current.started_at ?? startedAt,
	});
	await atomicJson(path.join(directory, LANE_META_FILENAME), running, idGenerator);

	let spawned: { pid: number; pgid: number | null } | undefined;
	const terminal = await runWithTimers(
		{
			command: candidate.command,
			timeoutSeconds: REVIEW_MAX_LANE_SECONDS,
			briefPath: path.join(directory, "brief.md"),
			outPath: verdictFile,
			cwd: runtime.loaded.cycle.target_repo.path,
			env,
			logSink: {
				stdoutPath: path.join(directory, "stdout.log"),
				stderrPath: path.join(directory, "stderr.log"),
			},
			onSpawn(process) {
				spawned = process;
			},
		},
		runner,
		timers,
	);
	const endedAt = at(now);
	let execution: AttemptExecution;
	if (terminal.supervisorOutcome !== undefined) {
		const evidenceOutcome = await laneOutcome({ supervisorOutcome: terminal.supervisorOutcome });
		const details = terminal.error ? terminalDetails(terminal.error) : { exitCode: null, signal: null };
		execution = {
			outcome: evidenceOutcome.outcome,
			reason: outcomeReason(evidenceOutcome),
			exitCode: details.exitCode,
			signal: details.signal,
		};
	} else if (terminal.error !== undefined) {
		const details = terminalDetails(terminal.error);
		let rateLimited: ReturnType<typeof classifyRunOutcome> | undefined;
		if (!details.spawnFailed && details.exitCode !== null && details.signal === null) {
			rateLimited = classifyRunOutcome({
				cliName: candidate.cli,
				exitCode: details.exitCode,
				signal: details.signal,
				stdoutTail: "",
				stderrTail: details.stderr,
				evidence: noEvidence,
				nowMs: Date.parse(endedAt),
			});
		}
		execution =
			rateLimited?.outcome === "RATE_LIMITED"
				? {
						outcome: "RATE_LIMITED",
						reason: "RATE_LIMITED",
						cooldownResumeAfter: rateLimited.cooldown?.resumeAfter,
						exitCode: details.exitCode,
						signal: details.signal,
					}
				: {
						outcome: "INFRA_ERROR",
						reason: details.spawnFailed ? "SPAWN_FAILED" : errorMessage(terminal.error),
						exitCode: details.exitCode,
						signal: details.signal,
					};
	} else {
		const after = await workspaceFingerprint(dependencies.git);
		const evidenceOutcome = await laneOutcome({
			reader: { readText: () => readFile(verdictFile, "utf8") },
			expected: { run_token: runToken, round: runtime.roundNumber },
			before,
			after,
		});
		execution = {
			outcome: evidenceOutcome.outcome,
			verdict: "verdict" in evidenceOutcome ? evidenceOutcome.verdict : undefined,
			reason: outcomeReason(evidenceOutcome),
			exitCode: 0,
			signal: null,
		};
	}
	if (spawned) {
		execution.pid = spawned.pid;
		if (spawned.pgid !== null) {
			execution.pgid = spawned.pgid;
		}
	}
	Object.assign(attempt, {
		status: "FINISHED" as const,
		endedAt,
		outcome: execution.outcome,
		reason: execution.reason,
		exitCode: execution.exitCode,
		signal: execution.signal,
		cooldownResumeAfter: execution.cooldownResumeAfter,
		pid: execution.pid,
		pgid: execution.pgid,
	});
	await atomicJson(path.join(directory, LANE_ATTEMPTS_FILENAME), attempts, idGenerator);
	return execution;
}

async function recoverRunningAttempt(
	runtime: RoundRuntime,
	route: LaneRoute,
	attempt: StoredAttempt,
	dependencies: ReviewSupervisorDependencies,
): Promise<AttemptExecution | undefined> {
	const workspaceFingerprint = dependencies.workspaceFingerprint ?? readWorkspaceFingerprint;
	const verdictFile = resultPath(runtime.paths.visible, route.id);
	const after = await workspaceFingerprint(dependencies.git);
	const outcome = await laneOutcome({
		reader: { readText: () => readFile(verdictFile, "utf8") },
		expected: { run_token: attempt.runToken, round: runtime.roundNumber },
		before: attempt.before,
		after,
	});
	if (
		outcome.outcome === "PASS" ||
		outcome.outcome === "FAIL" ||
		(outcome.outcome === "INVALID" && outcome.reason === "REVIEWER_WROTE_REPO")
	) {
		return {
			outcome: outcome.outcome,
			verdict: "verdict" in outcome ? outcome.verdict : undefined,
			reason: outcomeReason(outcome),
			exitCode: 0,
			signal: null,
			pid: attempt.pid,
			pgid: attempt.pgid,
		};
	}
	return undefined;
}

async function verdictForStoredAttempt(
	runtime: RoundRuntime,
	route: LaneRoute,
	attempt: StoredAttempt,
): Promise<ReviewVerdict | undefined> {
	const outcome = await laneOutcome({
		reader: { readText: () => readFile(resultPath(runtime.paths.visible, route.id), "utf8") },
		expected: { run_token: attempt.runToken, round: runtime.roundNumber },
		before: attempt.before,
		after: attempt.before,
	});
	return "verdict" in outcome ? outcome.verdict : undefined;
}

function candidatesForLane(cycle: ReviewCycle, route: LaneRoute): Candidate[] {
	const candidates = [routeCandidate(route)];
	if (route.required) {
		for (const backup of cycle.lane_snapshot) {
			if (backup.required || backup.id === route.id) {
				continue;
			}
			const candidate = routeCandidate(backup);
			if (!candidates.some((current) => sameCandidate(current, candidate))) {
				candidates.push(candidate);
			}
		}
	}
	return candidates;
}

function laneEvent(
	cycleId: string,
	round: number,
	laneId: string,
	outcome: NonNullable<Lane["outcome"]>,
	now: () => Date,
): ReviewJournalEvent {
	return {
		apiVersion: "gatekeeper/v1",
		type: "LANE_CONCLUDED",
		cycle_id: cycleId,
		at: at(now),
		round,
		lane_id: laneId,
		outcome,
	};
}

function journalledLaneOutcome(
	events: readonly ReviewJournalEvent[],
	round: number,
	laneId: string,
): Lane["outcome"] | undefined {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type === "LANE_CONCLUDED" && event.round === round && event.lane_id === laneId) {
			return event.outcome;
		}
	}
	return undefined;
}

async function concludeLane(
	runtime: RoundRuntime,
	route: LaneRoute,
	lane: Lane,
	execution: AttemptExecution,
	dependencies: ReviewSupervisorDependencies,
): Promise<LaneExecution> {
	const now = dependencies.now ?? (() => new Date());
	const idGenerator = dependencies.idGenerator ?? randomUUID;
	const existingOutcome = journalledLaneOutcome(runtime.journal.events, runtime.roundNumber, route.id);
	if (existingOutcome === undefined) {
		await runtime.journal.write(
			laneEvent(runtime.loaded.cycle.id, runtime.roundNumber, route.id, execution.outcome, now),
		);
	} else if (existingOutcome !== execution.outcome) {
		throw new ReviewSupervisorError(
			"ROUND_STATE_CORRUPT",
			`journal outcome ${existingOutcome} disagrees with recovered ${execution.outcome} for ${route.id}`,
		);
	}
	const terminalLane = laneSchema.parse({
		...lane,
		status: "CONCLUDED",
		started_at: lane.started_at ?? at(now),
		ended_at: at(now),
		outcome: execution.outcome,
		exit_code: execution.exitCode,
		signal: execution.signal,
		...(execution.pid !== undefined ? { pid: execution.pid } : {}),
		...(execution.pgid !== undefined ? { pgid: execution.pgid } : {}),
	});
	await atomicJson(
		path.join(laneDirectory(runtime.paths.visible, route.id), LANE_META_FILENAME),
		terminalLane,
		idGenerator,
	);
	const warnings: ReviewSupervisorWarning[] = [];
	if (execution.reason === "REVIEWER_WROTE_REPO") {
		warnings.push({
			code: "REVIEWER_WROTE_REPO",
			laneId: route.id,
			message: `${route.id} changed the target repository; its verdict is INVALID and the round requires arbitration`,
		});
	}
	return { lane: terminalLane, verdict: execution.verdict, warnings };
}

async function executeLane(
	runtime: RoundRuntime,
	route: LaneRoute,
	dependencies: ReviewSupervisorDependencies,
): Promise<LaneExecution> {
	const now = dependencies.now ?? (() => new Date());
	const idGenerator = dependencies.idGenerator ?? randomUUID;
	let lane = await readLane(runtime.paths.visible, route.id);
	const journalOutcome = journalledLaneOutcome(runtime.journal.events, runtime.roundNumber, route.id);
	const attemptsFile = path.join(laneDirectory(runtime.paths.visible, route.id), LANE_ATTEMPTS_FILENAME);
	const attempts = (await readJson<StoredAttempt[]>(attemptsFile)) ?? [];
	if (lane.status === "CONCLUDED") {
		if (journalOutcome === undefined) {
			await runtime.journal.write(
				laneEvent(
					runtime.loaded.cycle.id,
					runtime.roundNumber,
					route.id,
					lane.outcome as NonNullable<Lane["outcome"]>,
					now,
				),
			);
		}
		const finalAttempt = attempts.at(-1);
		const verdict = finalAttempt ? await verdictForStoredAttempt(runtime, route, finalAttempt) : undefined;
		if ((lane.outcome === "PASS" || lane.outcome === "FAIL") && verdict === undefined) {
			throw new ReviewSupervisorError(
				"ROUND_STATE_CORRUPT",
				`${route.id} has a durable ${lane.outcome} conclusion but no longer has valid verdict evidence`,
			);
		}
		return { lane, verdict, warnings: [] };
	}
	if (journalOutcome !== undefined) {
		const last = attempts.at(-1);
		const verdict = last ? await verdictForStoredAttempt(runtime, route, last) : undefined;
		if ((journalOutcome === "PASS" || journalOutcome === "FAIL") && verdict === undefined) {
			throw new ReviewSupervisorError(
				"ROUND_STATE_CORRUPT",
				`${route.id} journal conclusion cannot be reconciled with valid verdict evidence`,
			);
		}
		const execution: AttemptExecution = {
			outcome: journalOutcome,
			verdict,
			reason: last?.reason,
			exitCode: last?.exitCode ?? null,
			signal: last?.signal ?? null,
			pid: last?.pid,
			pgid: last?.pgid,
		};
		return concludeLane(runtime, route, lane, execution, dependencies);
	}
	const orphan = attempts.at(-1);
	if (lane.status === "RUNNING" && orphan?.status === "RUNNING") {
		const recovered = await recoverRunningAttempt(runtime, route, orphan, dependencies);
		if (recovered !== undefined) {
			Object.assign(orphan, {
				status: "FINISHED" as const,
				endedAt: at(now),
				outcome: recovered.outcome,
				reason: recovered.reason,
				exitCode: recovered.exitCode,
				signal: recovered.signal,
			});
			await atomicJson(attemptsFile, attempts, idGenerator);
			return concludeLane(runtime, route, lane, recovered, dependencies);
		}
		Object.assign(orphan, {
			status: "FINISHED" as const,
			endedAt: at(now),
			outcome: "INVALID" as const,
			reason: "ORPHANED_NO_VALID_VERDICT",
			exitCode: null,
			signal: null,
		});
		await atomicJson(attemptsFile, attempts, idGenerator);
	}

	const candidates = candidatesForLane(runtime.loaded.cycle, route);
	const rateLimitedThisPass: Candidate[] = [];
	let finalExecution: AttemptExecution | undefined;
	for (;;) {
		let candidate: Candidate | undefined;
		for (const possible of candidates) {
			if (rateLimitedThisPass.some((limited) => sameCandidate(limited, possible))) {
				continue;
			}
			const failedAttempts = attempts.filter(
				(attempt) =>
					sameCandidate(attempt.candidate, possible) &&
					attempt.status === "FINISHED" &&
					(attempt.outcome === "INVALID" || attempt.outcome === "INFRA_ERROR"),
			).length;
			if (failedAttempts < 2) {
				candidate = possible;
				break;
			}
		}
		if (candidate === undefined) {
			break;
		}
		const execution = await executeAttempt(runtime, route, candidate, attempts.length + 1, dependencies, attempts);
		lane = await readLane(runtime.paths.visible, route.id);
		if (execution.outcome === "PASS" || execution.outcome === "FAIL") {
			return concludeLane(runtime, route, lane, execution, dependencies);
		}
		if (execution.reason === "REVIEWER_WROTE_REPO") {
			return concludeLane(runtime, route, lane, execution, dependencies);
		}
		if (execution.outcome === "RATE_LIMITED") {
			rateLimitedThisPass.push(candidate);
			finalExecution = execution;
			continue;
		}
		finalExecution = execution;
	}

	if (finalExecution?.outcome === "RATE_LIMITED" && route.required) {
		const resumeAfter =
			finalExecution.cooldownResumeAfter ?? new Date(Date.parse(at(now)) + 60 * 60 * 1_000).toISOString();
		const reset = pendingLane(runtime.loaded.cycle, route, runtime.roundNumber);
		await atomicJson(path.join(laneDirectory(runtime.paths.visible, route.id), LANE_META_FILENAME), reset, idGenerator);
		return {
			lane: reset,
			warnings: [],
			cooldown: { laneId: route.id, resumeAfter },
		};
	}
	const exhausted =
		finalExecution ??
		({ outcome: "INVALID", reason: "BACKUPS_EXHAUSTED", exitCode: null, signal: null } satisfies AttemptExecution);
	return concludeLane(runtime, route, lane, exhausted, dependencies);
}

async function mapParallel<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const consume = async () => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) {
				return;
			}
			const item = items[index];
			if (item !== undefined) {
				results[index] = await worker(item);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => consume()));
	return results;
}

async function assertNoDispatchConflict(
	cycle: ReviewCycle,
	dependencies: ReviewSupervisorDependencies,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const list = dependencies.listDispatchOrders ?? listOrders;
	const resolveRealpath = dependencies.realpath ?? fsRealpath;
	const readRecord = dependencies.readDispatchSupervisorRecord ?? readDispatchSupervisorRecord;
	const isAlive = dependencies.isProcessAlive ?? processAlive;
	const target = await resolveRealpath(cycle.target_repo.path);
	for (const order of await list(env)) {
		if (order.state !== "RUNNING") {
			continue;
		}
		let other: string;
		try {
			other = await resolveRealpath(order.order.target_repo.path);
		} catch {
			continue;
		}
		if (other !== target) {
			continue;
		}
		const record = await readRecord(order.order.id, env);
		if (record && isAlive(record.pid)) {
			throw new ReviewSupervisorError(
				"TARGET_REPOSITORY_BUSY",
				`dispatch order ${order.order.id} is RUNNING on ${target}`,
				{ conflictingOrderId: order.order.id },
			);
		}
	}
}

function laneVerdicts(results: readonly LaneExecution[]): LaneVerdict[] {
	const verdicts: LaneVerdict[] = [];
	for (const result of results) {
		if (result.verdict === undefined) {
			continue;
		}
		// Mandatory handoff: validate the complete lane id before constructing the LaneVerdict consumed by aggregate.
		const laneId = laneIdSchema.parse(result.lane.id);
		verdicts.push({ laneId, verdict: result.verdict });
	}
	return verdicts;
}

function roundStatusFor(state: ReviewCycleState): Round["status"] {
	if (state === "AWAITING_ACCEPT" || state === "BLOCKED" || state === "ARBITRATION") {
		return state;
	}
	throw new ReviewSupervisorError("ROUND_STATE_CORRUPT", `cannot map cycle state ${state} to a round status`);
}

async function finishRound(
	runtime: RoundRuntime,
	results: readonly LaneExecution[],
	dependencies: ReviewSupervisorDependencies,
): Promise<ReviewSupervisionResult> {
	const now = dependencies.now ?? (() => new Date());
	const idGenerator = dependencies.idGenerator ?? randomUUID;
	const summary = await readRound(runtime.paths.visible);
	const laneResults = results.map((result) => ({
		lane_id: result.lane.id,
		required: result.lane.required,
		outcome: result.lane.outcome as NonNullable<Lane["outcome"]>,
	}));
	const verdict = aggregateRequiredLaneResults(laneResults);
	if (verdict === undefined) {
		throw new ReviewSupervisorError("ROUND_STATE_CORRUPT", "round has no required lane result");
	}
	const maxRounds = effectiveMaxRounds(runtime.loaded.cycle.max_rounds, runtime.journal.events);
	const target = roundConclusionTarget(verdict, runtime.roundNumber, maxRounds);
	const blockers = aggregateBlockers(laneVerdicts(results));
	const resolved = runtime.roundFrom === "FIXING" ? resolveRefs(blockers, runtime.priorBlockers) : undefined;
	const warnings = results.flatMap((result) => result.warnings);
	if (resolved) {
		for (const dangling of resolved.danglingRefs) {
			warnings.push({
				code: "DANGLING_BLOCKER_REF",
				message: `${dangling.blockerId} references unknown prior blocker ${dangling.ref}`,
			});
		}
	}
	const aggregateFile: RoundAggregateFile = {
		apiVersion: "gatekeeper/v1",
		round: runtime.roundNumber,
		blockers,
		warnings,
		...(resolved ? { resolvedBlockers: resolved.blockers, danglingRefs: resolved.danglingRefs } : {}),
	};
	const concluded = roundSchema.parse({
		...summary,
		status: roundStatusFor(target),
		lane_results: laneResults,
		verdict,
		concluded_at: at(now),
	});
	await atomicJson(path.join(runtime.paths.visible, ROUND_AGGREGATE_FILENAME), aggregateFile, idGenerator);
	await atomicJson(path.join(runtime.paths.visible, ROUND_SUMMARY_FILENAME), concluded, idGenerator);
	const existing = runtime.journal.events.find(
		(event) => event.type === "ROUND_CONCLUDED" && event.round === runtime.roundNumber,
	);
	if (existing === undefined) {
		await runtime.journal.write({
			apiVersion: "gatekeeper/v1",
			type: "ROUND_CONCLUDED",
			cycle_id: runtime.loaded.cycle.id,
			at: at(now),
			round: runtime.roundNumber,
			verdict,
			from: "REVIEWING",
			to: target,
		});
	}
	if (!runtime.paths.isFinal) {
		await rename(runtime.paths.work, runtime.paths.final);
	}
	return { cycleId: runtime.loaded.cycle.id, state: target, round: concluded, blockers, warnings };
}

async function reconcileConcludedRound(
	loaded: LoadedReviewCycle,
	paths: RoundPaths,
	journal: JournalWriter,
	dependencies: ReviewSupervisorDependencies,
): Promise<ReviewSupervisionResult | undefined> {
	const summary = await readRound(paths.visible);
	if (summary.status === "REVIEWING") {
		return undefined;
	}
	const now = dependencies.now ?? (() => new Date());
	for (const result of summary.lane_results) {
		if (journalledLaneOutcome(journal.events, summary.number, result.lane_id) === undefined) {
			await journal.write(laneEvent(loaded.cycle.id, summary.number, result.lane_id, result.outcome, now));
		}
	}
	const target = summary.status;
	if (!journal.events.some((event) => event.type === "ROUND_CONCLUDED" && event.round === summary.number)) {
		await journal.write({
			apiVersion: "gatekeeper/v1",
			type: "ROUND_CONCLUDED",
			cycle_id: loaded.cycle.id,
			at: at(now),
			round: summary.number,
			verdict: summary.verdict as NonNullable<Round["verdict"]>,
			from: "REVIEWING",
			to: target,
		});
	}
	if (!paths.isFinal) {
		await rename(paths.work, paths.final);
	}
	const aggregate = await readAggregate(paths.final);
	return {
		cycleId: loaded.cycle.id,
		state: target,
		round: summary,
		blockers: aggregate?.blockers ?? [],
		warnings: aggregate?.warnings ?? [],
	};
}

async function promoteJournalConcludedRound(
	loaded: LoadedReviewCycle,
	dependencies: ReviewSupervisorDependencies,
): Promise<LoadedReviewCycle> {
	const round = currentRoundNumber(loaded.journal);
	const conclusion = [...loaded.journal]
		.reverse()
		.find((event) => event.type === "ROUND_CONCLUDED" && event.round === round);
	if (conclusion?.type !== "ROUND_CONCLUDED") {
		return loaded;
	}

	const env = dependencies.env ?? process.env;
	const paths = await roundPaths(loaded.cycle, round, env);
	if (paths.isFinal) {
		return loaded;
	}
	const summary = await readRound(paths.work);
	if (
		summary.cycle_id !== loaded.cycle.id ||
		summary.number !== round ||
		summary.status !== conclusion.to ||
		summary.verdict !== conclusion.verdict
	) {
		throw new ReviewSupervisorError(
			"ROUND_STATE_CORRUPT",
			`R${round} staged summary does not match its durable ROUND_CONCLUDED event`,
		);
	}
	const aggregate = await readAggregate(paths.work);
	if (aggregate?.round !== round) {
		throw new ReviewSupervisorError("ROUND_STATE_CORRUPT", `R${round} staged aggregate is missing or invalid`);
	}
	await rename(paths.work, paths.final);
	return (dependencies.load ?? loadCycle)(loaded.cycle.id, env);
}

async function runRound(
	loaded: LoadedReviewCycle,
	journal: JournalWriter,
	dependencies: ReviewSupervisorDependencies,
	options: ReviewCycleOptions,
	startFrom: "PENDING" | "FIXING" | "REVIEWING",
): Promise<ReviewSupervisionResult> {
	const env = dependencies.env ?? process.env;
	const now = dependencies.now ?? (() => new Date());
	const idGenerator = dependencies.idGenerator ?? randomUUID;
	const workspaceFingerprint = dependencies.workspaceFingerprint ?? readWorkspaceFingerprint;
	let round = currentRoundNumber(journal.events);
	if (startFrom !== "REVIEWING") {
		round += 1;
		await journal.write({
			apiVersion: "gatekeeper/v1",
			type: "ROUND_STARTED",
			cycle_id: loaded.cycle.id,
			at: at(now),
			round,
			from: startFrom,
			to: "REVIEWING",
		});
	}
	if (round <= 0) {
		throw new ReviewSupervisorError("ROUND_STATE_CORRUPT", "REVIEWING cycle has no ROUND_STARTED event");
	}
	const started = [...journal.events]
		.reverse()
		.find((event) => event.type === "ROUND_STARTED" && event.round === round);
	if (started?.type !== "ROUND_STARTED") {
		throw new ReviewSupervisorError("ROUND_STATE_CORRUPT", `R${round} has no ROUND_STARTED event`);
	}
	const paths = await roundPaths(loaded.cycle, round, env);
	if (!paths.isFinal) {
		const existing = await readJson<unknown>(path.join(paths.work, ROUND_SUMMARY_FILENAME));
		if (existing === undefined) {
			const fingerprint = await workspaceFingerprint(dependencies.git);
			await createRoundWorkspace(loaded, round, paths, fingerprint, now, idGenerator);
		}
	}
	const repaired = await reconcileConcludedRound(loaded, paths, journal, dependencies);
	if (repaired !== undefined) {
		return repaired;
	}
	const requiredCount = loaded.cycle.lane_snapshot.filter((route) => route.required).length;
	const maxParallel = validParallelism(options.maxParallel ?? requiredCount);
	const priorBlockers = options.priorBlockers ?? [];
	const runtime: RoundRuntime = {
		loaded,
		journal,
		paths,
		roundNumber: round,
		roundFrom: started.from,
		priorBlockers,
		fixCommitRange: options.fixCommitRange,
		maxParallel,
	};
	const results = await mapParallel(loaded.cycle.lane_snapshot, maxParallel, (route) =>
		executeLane(runtime, route, dependencies),
	);
	const cooldown = results.find((result) => result.cooldown !== undefined)?.cooldown;
	if (cooldown !== undefined) {
		await journal.write({
			apiVersion: "gatekeeper/v1",
			type: "COOLDOWN_STARTED",
			cycle_id: loaded.cycle.id,
			at: at(now),
			round,
			lane_id: cooldown.laneId,
			resume_after: cooldown.resumeAfter,
			from: "REVIEWING",
			to: "WAITING_COOLDOWN",
		});
		return {
			cycleId: loaded.cycle.id,
			state: "WAITING_COOLDOWN",
			round: await readRound(paths.visible),
			blockers: [],
			warnings: results.flatMap((result) => result.warnings),
		};
	}
	return finishRound(runtime, results, dependencies);
}

async function activeRoundOptions(
	loaded: LoadedReviewCycle,
	journal: JournalWriter,
	dependencies: ReviewSupervisorDependencies,
	options: ReviewCycleOptions,
): Promise<ReviewCycleOptions> {
	const round = currentRoundNumber(journal.events);
	const started = [...journal.events]
		.reverse()
		.find((event) => event.type === "ROUND_STARTED" && event.round === round);
	if (started?.type !== "ROUND_STARTED" || started.from !== "FIXING" || options.priorBlockers) {
		return options;
	}
	const context = await readJson<StoredFixContext>(
		path.join(reviewCycleDirectory(loaded.cycle.id, dependencies.env), FIX_CONTEXT_FILENAME),
	);
	if (!context || context.cycleId !== loaded.cycle.id || context.round !== round - 1) {
		throw new ReviewSupervisorError(
			"FIX_CONTEXT_REQUIRED",
			`incremental R${round} cannot recover its prior blocker context`,
		);
	}
	if (options.fixCommitRange) {
		return { ...options, priorBlockers: context.priorBlockers };
	}
	const previous = loaded.rounds.find((item) => item.summary.number === round - 1)?.summary;
	const current = await (dependencies.workspaceFingerprint ?? readWorkspaceFingerprint)(dependencies.git);
	return {
		...options,
		priorBlockers: context.priorBlockers,
		fixCommitRange: {
			summary: `fix commits for ${loaded.cycle.id} R${round - 1}`,
			command: previous
				? `git diff ${previous.subject_fingerprint.head}..${current.head} --`
				: "git diff HEAD^..HEAD --",
		},
	};
}

async function withCycleLock<T>(
	cycle: string | ReviewCycle | LoadedReviewCycle,
	dependencies: ReviewSupervisorDependencies,
	work: (loaded: LoadedReviewCycle, journal: JournalWriter) => Promise<T>,
): Promise<T> {
	const cycleId = cycleIdOf(cycle);
	const env = dependencies.env ?? process.env;
	const now = dependencies.now ?? (() => new Date());
	const idGenerator = dependencies.idGenerator ?? randomUUID;
	const append = dependencies.append ?? appendJournalEvent;
	const lock = dependencies.acquireLock
		? await dependencies.acquireLock(cycleId)
		: await acquireReviewSupervisorLock(cycleId, {
				env,
				pid: dependencies.pid,
				now,
				randomUUID: idGenerator,
				isProcessAlive: dependencies.isProcessAlive,
				appendEvent: append,
			});
	try {
		const loaded = await (dependencies.load ?? loadCycle)(cycleId, env);
		const journal = new JournalWriter(cycleId, loaded.journal, env, append, dependencies.afterJournal);
		return await work(loaded, journal);
	} finally {
		await lock.release();
	}
}

/**
 * Freeze and supervise the cycle's stored route snapshot. All routes are scheduled, while the default concurrency
 * equals the number of required routes; required-route validity alone controls the round state.
 */
export async function superviseReviewCycle(
	cycle: string | ReviewCycle | LoadedReviewCycle,
	dependencies: ReviewSupervisorDependencies,
	options: ReviewCycleOptions = {},
): Promise<ReviewSupervisionResult> {
	return withCycleLock(cycle, dependencies, async (loaded, journal) => {
		if (loaded.state === "PENDING") {
			return runRound(loaded, journal, dependencies, options, "PENDING");
		}
		if (loaded.state === "REVIEWING") {
			return runRound(
				loaded,
				journal,
				dependencies,
				await activeRoundOptions(loaded, journal, dependencies, options),
				"REVIEWING",
			);
		}
		const lastRound = loaded.rounds.at(-1)?.summary;
		const aggregate = lastRound
			? await readAggregate(path.join(reviewCycleDirectory(loaded.cycle.id, dependencies.env), "rounds", lastRound.id))
			: undefined;
		return {
			cycleId: loaded.cycle.id,
			state: loaded.state,
			round: lastRound,
			blockers: aggregate?.blockers ?? [],
			warnings: aggregate?.warnings ?? [],
		};
	});
}

async function readAggregate(roundDirectory: string): Promise<RoundAggregateFile | undefined> {
	const value = await readJson<RoundAggregateFile>(path.join(roundDirectory, ROUND_AGGREGATE_FILENAME));
	if (
		value === undefined ||
		value.apiVersion !== "gatekeeper/v1" ||
		!Number.isInteger(value.round) ||
		!Array.isArray(value.blockers) ||
		!Array.isArray(value.warnings)
	) {
		return undefined;
	}
	return value;
}

function completedAuthorCandidate(order: LoadedWorkOrder): Candidate {
	const completed = [...order.runs].reverse().find((run) => run.outcome === "COMPLETED");
	if (completed) {
		return { cli: completed.cli, vendor: completed.vendor, command: completed.command };
	}
	const first = order.order.candidate_ladder[0];
	if (!first) {
		throw new ReviewSupervisorError("FIX_CONTEXT_REQUIRED", `${order.order.id} has no authoring candidate`);
	}
	return first;
}

async function defaultFixAuthorContext(
	cycle: ReviewCycle,
	dependencies: ReviewSupervisorDependencies,
	env: NodeJS.ProcessEnv,
): Promise<FixAuthorContext> {
	if (cycle.subject.kind !== "dispatch-order") {
		throw new ReviewSupervisorError(
			"FIX_CONTEXT_REQUIRED",
			"diff-subject cycles require an injected resolveFixAuthorContext before dispatching a fix",
		);
	}
	const order = await (dependencies.loadDispatchOrder ?? loadOrder)(cycle.subject.order_id, env);
	const branch = `${DISPATCH_BRANCH_PREFIX}${order.order.id}`;
	return {
		candidate: completedAuthorCandidate(order),
		originalOrderId: order.order.id,
		baseRef: branch,
		reuseBranch: { branch },
	};
}

async function createFixOrderDefault(
	input: ReviewFixOrderInput,
	dependencies: ReviewSupervisorDependencies,
): Promise<{ orderId: string }> {
	const loaded = await createOrder(
		{
			association_key: input.associationKey,
			target_repo: input.targetRepo,
			brief: input.brief,
			acceptance_contract: {
				result_path: "out/RESULT.json",
				progress_path: "out/PROGRESS.md",
				require_non_wip_commit: true,
				criteria: [...input.criteria],
			},
			candidate_ladder: [input.candidate],
		},
		{
			env: dependencies.env,
			now: dependencies.now,
			randomUUID: dependencies.idGenerator,
		},
	);
	return { orderId: loaded.order.id };
}

/** Narrow exemption: only the owning cycle disappears; every other review cycle remains a dispatch conflict. */
export function reviewCyclesVisibleToFixDispatch(
	cycles: readonly LoadedReviewCycle[],
	busyExemptionCycleId: string,
): LoadedReviewCycle[] {
	return cycles.filter((cycle) => cycle.cycle.id !== busyExemptionCycleId);
}

async function superviseFixOrderDefault(
	input: ReviewFixSupervisionInput,
	dependencies: ReviewSupervisorDependencies,
): Promise<Pick<DispatchSupervisionResult, "state">> {
	const env = dependencies.env ?? process.env;
	const base = dependencies.dispatchSupervisorDependencies;
	const listReviewCycles = dependencies.listReviewCyclesForDispatch ?? listCycles;
	return superviseWorkOrder(
		{
			orderId: input.orderId,
			baseRef: input.baseRef,
			reuseBranch: input.reuseBranch,
		},
		{
			...base,
			env,
			now: dependencies.now,
			idGenerator: dependencies.idGenerator,
			git: dependencies.git,
			listReviewCycles: async (dispatchEnv) =>
				reviewCyclesVisibleToFixDispatch(await listReviewCycles(dispatchEnv), input.busyExemptionCycleId),
		},
	);
}

function blockersForFix(
	cycle: ReviewCycle,
	blockers: readonly AggregatedBlocker[],
	waivedIds: readonly string[],
	adoptedIds: readonly string[],
): AggregatedBlocker[] {
	const open = applyWaivers(blockers, waivedIds);
	const known = new Set(blockers.map((blocker) => blocker.id));
	const unknownAdoptions = [...new Set(adoptedIds)].filter((id) => !known.has(id));
	if (unknownAdoptions.length > 0) {
		throw new ReviewSupervisorError(
			"FIX_CONTEXT_REQUIRED",
			`cannot adopt unknown advisory blocker id(s): ${unknownAdoptions.join(", ")}`,
		);
	}
	const requiredLaneIds = new Set(cycle.lane_snapshot.filter((route) => route.required).map((route) => route.id));
	const adopted = new Set(adoptedIds);
	return open.filter(
		(blocker) => blocker.endorsements.some((laneId) => requiredLaneIds.has(laneId)) || adopted.has(blocker.id),
	);
}

async function superviseDispatchedFix(
	loaded: LoadedReviewCycle,
	journal: JournalWriter,
	context: StoredFixContext,
	dependencies: ReviewSupervisorDependencies,
	options: ReviewCycleOptions,
): Promise<ReviewSupervisionResult> {
	const now = dependencies.now ?? (() => new Date());
	const superviseFix = dependencies.superviseFixOrder ?? ((input) => superviseFixOrderDefault(input, dependencies));
	let result: { state: string };
	try {
		result = await superviseFix({
			orderId: context.orderId,
			baseRef: context.baseRef,
			reuseBranch: context.reuseBranch,
			busyExemptionCycleId: loaded.cycle.id,
		});
	} catch (error) {
		await journal.write({
			apiVersion: "gatekeeper/v1",
			type: "FIX_FAILED",
			cycle_id: loaded.cycle.id,
			at: at(now),
			round: context.round,
			fix_order_id: context.orderId,
			reason: errorMessage(error),
			from: "FIXING",
			to: "BLOCKED",
		});
		return {
			cycleId: loaded.cycle.id,
			state: "BLOCKED",
			blockers: context.priorBlockers,
			warnings: [],
			fixOrderId: context.orderId,
		};
	}
	if (result.state !== "DELIVERED") {
		await journal.write({
			apiVersion: "gatekeeper/v1",
			type: "FIX_FAILED",
			cycle_id: loaded.cycle.id,
			at: at(now),
			round: context.round,
			fix_order_id: context.orderId,
			reason: `fix dispatch ended in ${result.state}`,
			from: "FIXING",
			to: "BLOCKED",
		});
		return {
			cycleId: loaded.cycle.id,
			state: "BLOCKED",
			blockers: context.priorBlockers,
			warnings: [],
			fixOrderId: context.orderId,
		};
	}
	const previousRound = loaded.rounds.find((round) => round.summary.number === context.round)?.summary;
	const current = await (dependencies.workspaceFingerprint ?? readWorkspaceFingerprint)(dependencies.git);
	const fixCommitRange =
		options.fixCommitRange ??
		({
			summary: `fix commits for ${loaded.cycle.id} R${context.round}`,
			command: previousRound
				? `git diff ${previousRound.subject_fingerprint.head}..${current.head} --`
				: `git diff HEAD^..HEAD --`,
		} satisfies ReviewDiffScope);
	return runRound(
		loaded,
		journal,
		dependencies,
		{ ...options, priorBlockers: context.priorBlockers, fixCommitRange },
		"FIXING",
	);
}

/** Apply human decisions, dispatch the original author back to the original branch, then automatically re-review. */
export async function reviewFix(
	cycle: string | ReviewCycle | LoadedReviewCycle,
	waivedIds: readonly string[],
	adoptedIds: readonly string[],
	dependencies: ReviewSupervisorDependencies,
	options: ReviewCycleOptions & { operator?: string; waiverReasons?: Readonly<Record<string, string>> } = {},
): Promise<ReviewSupervisionResult> {
	return withCycleLock(cycle, dependencies, async (loaded, journal) => {
		if (loaded.state !== "BLOCKED" && loaded.state !== "AWAITING_ACCEPT") {
			throw new ReviewSupervisorError("FIX_CONTEXT_REQUIRED", `cannot dispatch a fix from ${loaded.state}`);
		}
		const currentRound = loaded.rounds.at(-1)?.summary;
		if (!currentRound) {
			throw new ReviewSupervisorError("FIX_CONTEXT_REQUIRED", "cycle has no concluded round to fix");
		}
		const directory = path.join(reviewCycleDirectory(loaded.cycle.id, dependencies.env), "rounds", currentRound.id);
		const aggregate = await readAggregate(directory);
		if (!aggregate) {
			throw new ReviewSupervisorError("FIX_CONTEXT_REQUIRED", `${currentRound.id} has no aggregate evidence`);
		}
		const alreadyWaived = journal.events.flatMap((event) =>
			event.type === "BLOCKER_WAIVED" && event.round === currentRound.number ? [event.blocker_id] : [],
		);
		const allWaived = [...new Set([...alreadyWaived, ...waivedIds])];
		const fixBlockers = blockersForFix(loaded.cycle, aggregate.blockers, allWaived, adoptedIds);
		if (loaded.state === "AWAITING_ACCEPT" && waivedIds.length > 0) {
			throw new ReviewSupervisorError("FIX_CONTEXT_REQUIRED", "AWAITING_ACCEPT advisory fixes cannot waive blockers");
		}
		for (const blockerId of waivedIds) {
			if (alreadyWaived.includes(blockerId)) {
				continue;
			}
			await journal.write({
				apiVersion: "gatekeeper/v1",
				type: "BLOCKER_WAIVED",
				cycle_id: loaded.cycle.id,
				at: at(dependencies.now ?? (() => new Date())),
				round: currentRound.number,
				blocker_id: blockerId,
				operator: options.operator ?? "review-fix",
				reason: options.waiverReasons?.[blockerId] ?? "waived by review fix invocation",
			});
		}
		const author = dependencies.resolveFixAuthorContext
			? await dependencies.resolveFixAuthorContext(loaded.cycle)
			: await defaultFixAuthorContext(loaded.cycle, dependencies, dependencies.env ?? process.env);
		const brief = renderFixBrief({
			blockers: fixBlockers,
			contract: { resultPath: "out/RESULT.json", progressPath: "out/PROGRESS.md" },
		});
		const associationKey = `${loaded.cycle.target_repo.name}@adhoc-fix-${loaded.cycle.id}-r${currentRound.number}`;
		const created = await (dependencies.createFixOrder ?? ((input) => createFixOrderDefault(input, dependencies)))({
			associationKey,
			targetRepo: loaded.cycle.target_repo,
			brief,
			candidate: author.candidate,
			criteria: fixBlockers.map((blocker) => `${blocker.id}: ${blocker.title}`),
			cycleId: loaded.cycle.id,
			round: currentRound.number,
		});
		const context: StoredFixContext = {
			cycleId: loaded.cycle.id,
			round: currentRound.number,
			orderId: created.orderId,
			baseRef: author.baseRef,
			reuseBranch: author.reuseBranch,
			// Mandatory handoff: this persisted incremental input has already had every waived item removed.
			priorBlockers: fixBlockers,
		};
		await atomicJson(
			path.join(reviewCycleDirectory(loaded.cycle.id, dependencies.env), FIX_CONTEXT_FILENAME),
			context,
			dependencies.idGenerator ?? randomUUID,
		);
		await journal.write({
			apiVersion: "gatekeeper/v1",
			type: "FIX_DISPATCHED",
			cycle_id: loaded.cycle.id,
			at: at(dependencies.now ?? (() => new Date())),
			round: currentRound.number,
			fix_order_id: created.orderId,
			from: loaded.state,
			to: "FIXING",
		});
		return superviseDispatchedFix(loaded, journal, context, dependencies, options);
	});
}

/** Reconcile journal/artifact skew, re-adjudicate orphaned lanes, or pass a FIXING cycle through dispatch resume. */
export async function resumeReviewCycle(
	cycle: string | ReviewCycle | LoadedReviewCycle,
	dependencies: ReviewSupervisorDependencies,
	options: ReviewCycleOptions = {},
): Promise<ReviewSupervisionResult> {
	return withCycleLock(cycle, dependencies, async (loaded, journal) => {
		if (loaded.state === "PENDING") {
			return runRound(loaded, journal, dependencies, options, "PENDING");
		}
		if (loaded.state === "WAITING_COOLDOWN") {
			const round = currentRoundNumber(journal.events);
			await journal.write({
				apiVersion: "gatekeeper/v1",
				type: "CYCLE_RESUMED",
				cycle_id: loaded.cycle.id,
				at: at(dependencies.now ?? (() => new Date())),
				round,
				from: "WAITING_COOLDOWN",
				to: "REVIEWING",
			});
			return runRound(
				loaded,
				journal,
				dependencies,
				await activeRoundOptions(loaded, journal, dependencies, options),
				"REVIEWING",
			);
		}
		if (loaded.state === "REVIEWING") {
			return runRound(
				loaded,
				journal,
				dependencies,
				await activeRoundOptions(loaded, journal, dependencies, options),
				"REVIEWING",
			);
		}
		if (loaded.state === "FIXING") {
			const context = await readJson<StoredFixContext>(
				path.join(reviewCycleDirectory(loaded.cycle.id, dependencies.env), FIX_CONTEXT_FILENAME),
			);
			if (!context || context.cycleId !== loaded.cycle.id) {
				throw new ReviewSupervisorError("FIX_CONTEXT_REQUIRED", "FIXING cycle lacks its durable fix context");
			}
			return superviseDispatchedFix(loaded, journal, context, dependencies, options);
		}
		const reconciled = await promoteJournalConcludedRound(loaded, dependencies);
		const round = reconciled.rounds.at(-1)?.summary;
		const aggregate = round
			? await readAggregate(path.join(reviewCycleDirectory(reconciled.cycle.id, dependencies.env), "rounds", round.id))
			: undefined;
		return {
			cycleId: reconciled.cycle.id,
			state: reconciled.state,
			round,
			blockers: aggregate?.blockers ?? [],
			warnings: aggregate?.warnings ?? [],
		};
	});
}
