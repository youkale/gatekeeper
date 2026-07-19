import { randomUUID } from "node:crypto";
import { realpath as fsRealpath, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseDocument, stringify } from "yaml";
import { type ResolvedAgentCommand, resolveAgentCommand } from "../agent/resolve.js";
import { AgentRunError, type AgentRunOptions, type AgentRunResult, runAgentCommand } from "../agent/runner.js";
import { type ClassificationResult, classifyRunOutcome } from "./classify.js";
import {
	checkDeliveryEvidence,
	type DeliveryEvidence,
	evaluateDeliveryEvidence,
	type GitExecutor,
	type ResultFileReader,
} from "./evidence.js";
import { type HandoffPacket, synthesizeHandoffPacket } from "./handoff.js";
import {
	acquireSupervisorLock,
	type SupervisorLock,
	type SupervisorLockDependencies,
	type SupervisorLockRecord,
} from "./lock.js";
import { assertTransition } from "./machine.js";
import { appendJournalEvent, dispatchOrderDirectory, type LoadedWorkOrder, listOrders, loadOrder } from "./store.js";
import {
	type JournalEvent,
	type Run,
	type RunOutcome,
	runSchema,
	type StateTransitionEvent,
	type WorkOrder,
	workOrderSchema,
} from "./types.js";
import {
	createWipSnapshot,
	prepareDispatchWorkspace,
	readWorkspaceFingerprint,
	resolveDispatchBaseOid,
	verifyDispatchWorkspaceActive,
	type WipSnapshotResult,
	type WorkspaceFingerprint,
} from "./workspace.js";

export const DISPATCH_STALL_SECONDS = 600;
export const DISPATCH_MAX_RUN_SECONDS = 7_200;
export const DISPATCH_TOTAL_RUN_CAP = 4;
export const DISPATCH_COOLDOWN_EXIT_THRESHOLD_SECONDS = 15 * 60;

const TERMINAL_ORDER_STATES = new Set(["DELIVERED", "ABANDONED"]);
const TRANSIENT_OUTCOMES = new Set<RunOutcome>([
	"TIMEOUT",
	"STALLED",
	"AGENT_ERROR",
	"EXITED_NO_EVIDENCE",
	"ORPHANED_UNKNOWN",
]);

export type OrphanAction = "report" | "wait" | "kill" | "confirm-dead";

export interface DispatchTimerScheduler {
	set(delayMs: number, callback: () => void): unknown;
	clear(handle: unknown): void;
}

export interface ReviewerConflictWarning {
	readonly code: "REVIEWER_VENDOR_CONFLICT";
	readonly reviewerVendor: string;
	readonly authoringVendors: readonly string[];
	readonly suggestedVendors: readonly string[];
}

export interface SupervisorConflict {
	readonly code: "TARGET_REPOSITORY_BUSY";
	readonly conflictingOrderId: string;
	readonly targetRealpath: string;
}

export interface SupervisionResult {
	readonly orderId: string;
	readonly state: LoadedWorkOrder["state"];
	readonly runs: readonly Run[];
	readonly authoringVendors: readonly string[];
	readonly resumeHint?: string;
	readonly orphan?: {
		readonly action: "report" | "wait";
		readonly runId: string;
		readonly pgid?: number;
		readonly reason: "LIVE_PROCESS_GROUP" | "MISSING_PGID" | "PROCESS_GROUP_STILL_ALIVE";
	};
	readonly reviewerConflict?: ReviewerConflictWarning;
	readonly warnings: readonly string[];
}

export type DispatchSupervisorErrorCode =
	| "TARGET_REPOSITORY_BUSY"
	| "NO_AGENT_COMMAND"
	| "INVALID_TIMEOUT"
	| "RUN_LIMIT_EXCEEDED"
	| "MALFORMED_PEER_LOCK"
	| "STATE_REPAIR_FAILED";

export class DispatchSupervisorError extends Error {
	readonly code: DispatchSupervisorErrorCode;
	readonly conflict?: SupervisorConflict;

	constructor(
		code: DispatchSupervisorErrorCode,
		message: string,
		details: { conflict?: SupervisorConflict; cause?: unknown } = {},
	) {
		super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
		this.name = "DispatchSupervisorError";
		this.code = code;
		this.conflict = details.conflict;
	}
}

export interface SuperviseWorkOrderInput {
	readonly orderId: string;
	readonly baseRef: string;
	readonly stallSeconds?: number;
	readonly maxRunSeconds?: number;
	readonly forceCooldown?: boolean;
	/** Package E passes the non-interactive result of its --wait/--kill prompt here. */
	readonly orphanAction?: OrphanAction;
	readonly reviewerVendor?: string;
}

type Candidate = WorkOrder["candidate_ladder"][number];
type AgentRunner = (options: AgentRunOptions) => Promise<AgentRunResult>;

export interface SupervisorDependencies {
	readonly env?: NodeJS.ProcessEnv;
	readonly pid?: number;
	readonly now?: () => Date;
	readonly idGenerator?: () => string;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly probeProcessGroup?: (pgid: number) => boolean;
	readonly terminateProcessGroup?: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void | Promise<void>;
	readonly realpath?: (target: string) => Promise<string>;
	readonly readSupervisorRecord?: (
		orderId: string,
		env: NodeJS.ProcessEnv,
	) => Promise<SupervisorLockRecord | undefined>;
	readonly timers?: DispatchTimerScheduler;
	readonly sleep?: (delayMs: number) => Promise<void>;
	readonly acquireLock?: (orderId: string, dependencies: SupervisorLockDependencies) => Promise<SupervisorLock>;
	readonly load?: (orderId: string, env: NodeJS.ProcessEnv) => Promise<LoadedWorkOrder>;
	readonly list?: (env: NodeJS.ProcessEnv) => Promise<LoadedWorkOrder[]>;
	readonly append?: (orderId: string, event: JournalEvent, env: NodeJS.ProcessEnv) => Promise<void>;
	readonly resolveCommand?: (candidate: Candidate, env: NodeJS.ProcessEnv) => Promise<ResolvedAgentCommand | undefined>;
	readonly runner?: AgentRunner;
	readonly git: GitExecutor;
	readonly resultReader?: ResultFileReader;
	readonly prepareWorkspace?: typeof prepareDispatchWorkspace;
	readonly resolveBaseOid?: typeof resolveDispatchBaseOid;
	readonly activateWorkspace?: typeof verifyDispatchWorkspaceActive;
	readonly snapshot?: typeof createWipSnapshot;
	readonly workspaceFingerprint?: typeof readWorkspaceFingerprint;
	readonly evidence?: typeof checkDeliveryEvidence;
	readonly handoff?: typeof synthesizeHandoffPacket;
	readonly beforeRunPublish?: (temporaryRunDirectory: string) => void | Promise<void>;
}

interface MutableSupervision {
	loaded: LoadedWorkOrder;
	warnings: string[];
	gitEvidenceAvailable: boolean;
}

interface PendingRun {
	runId: Run["id"];
	candidate: Candidate;
}

interface FinishedProcess {
	exitCode: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
	supervisorOutcome?: "TIMEOUT" | "STALLED" | "KILLED";
	spawnFailed: boolean;
}

const defaultTimers: DispatchTimerScheduler = {
	set(delayMs, callback) {
		return setTimeout(callback, delayMs);
	},
	clear(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
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
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function processGroupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function terminateGroup(pgid: number, signal: "SIGTERM" | "SIGKILL"): void {
	try {
		process.kill(-pgid, signal);
	} catch (error) {
		if (errorCode(error) !== "ESRCH") {
			throw error;
		}
	}
}

function defaultSleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function validSeconds(value: number, label: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new DispatchSupervisorError("INVALID_TIMEOUT", `${label} must be a positive integer`);
	}
	return value;
}

export function resolveDispatchMaxRunSeconds(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.GATEKEEPER_DISPATCH_MAX_RUN_SECONDS ?? env.DISPATCH_MAX_RUN_SECONDS;
	if (raw === undefined) {
		return DISPATCH_MAX_RUN_SECONDS;
	}
	return validSeconds(Number(raw), "DISPATCH_MAX_RUN_SECONDS");
}

function agentEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GATEKEEPER_")));
}

function runNumber(runId: string): number {
	return Number(runId.slice(1));
}

function nextRunId(runs: readonly Run[]): Run["id"] {
	const next = runs.reduce((highest, run) => Math.max(highest, runNumber(run.id)), 0) + 1;
	if (next > 999) {
		throw new DispatchSupervisorError("RUN_LIMIT_EXCEEDED", "dispatch cannot represent more than 999 runs");
	}
	return `r${String(next).padStart(3, "0")}` as Run["id"];
}

function candidateIndex(order: WorkOrder, run: Run): number {
	const exact = order.candidate_ladder.findIndex(
		(candidate) => candidate.cli === run.cli && candidate.vendor === run.vendor && candidate.command === run.command,
	);
	if (exact >= 0) {
		return exact;
	}
	return order.candidate_ladder.findIndex((candidate) => candidate.cli === run.cli && candidate.vendor === run.vendor);
}

function nextCandidate(
	order: WorkOrder,
	runs: readonly Run[],
	previous: Run,
	afterCooldown = false,
): Candidate | undefined {
	const index = candidateIndex(order, previous);
	if (index < 0) {
		return undefined;
	}
	if (afterCooldown && previous.outcome === "RATE_LIMITED") {
		return order.candidate_ladder[index];
	}
	if (previous.outcome === "RATE_LIMITED") {
		return order.candidate_ladder[index + 1];
	}
	if (!previous.outcome || !TRANSIENT_OUTCOMES.has(previous.outcome)) {
		return undefined;
	}
	const attempts = runs.filter(
		(run) => run.cli === previous.cli && run.vendor === previous.vendor && candidateIndex(order, run) === index,
	).length;
	return attempts < 2 ? order.candidate_ladder[index] : order.candidate_ladder[index + 1];
}

function activeRun(runs: readonly Run[]): Run | undefined {
	return runs.find((run) => run.outcome === undefined);
}

function scheduledRunId(loaded: LoadedWorkOrder): Run["id"] | undefined {
	for (let index = loaded.journal.length - 1; index >= 0; index -= 1) {
		const event = loaded.journal[index];
		if (event?.type === "RUN_STARTED") {
			return event.run_id;
		}
		if (event?.type === "RUN_RETRY_SCHEDULED") {
			return event.next_run_id;
		}
		if (event?.type === "ORDER_RESUMED") {
			return event.new_run_id;
		}
	}
	return undefined;
}

function defaultCooldownSeconds(cli: string): number {
	return cli === "claude" ? 5 * 60 * 60 : 60 * 60;
}

async function defaultResultReader(file: string): Promise<string> {
	return readFile(file, "utf8");
}

async function defaultResolveCandidate(candidate: Candidate, env: NodeJS.ProcessEnv) {
	return resolveAgentCommand({
		cliCommand: candidate.command,
		env,
		discovered: null,
		registryPath: undefined,
		role: "coder",
	});
}

async function readLockRecord(orderId: string, env: NodeJS.ProcessEnv): Promise<SupervisorLockRecord | undefined> {
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
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw.started_at) &&
			Number.isFinite(Date.parse(raw.started_at))
		) {
			return { pid: Number(raw.pid), started_at: raw.started_at };
		}
		throw new DispatchSupervisorError(
			"MALFORMED_PEER_LOCK",
			`order ${orderId} has a malformed supervisor.lock; refusing concurrent repository access`,
		);
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
			return undefined;
		}
		if (error instanceof DispatchSupervisorError) {
			throw error;
		}
		if (error instanceof SyntaxError) {
			throw new DispatchSupervisorError(
				"MALFORMED_PEER_LOCK",
				`order ${orderId} has invalid supervisor.lock JSON; refusing concurrent repository access`,
				{ cause: error },
			);
		}
		throw error;
	}
}

async function atomicWrite(file: string, content: string, idGenerator: () => string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const suffix = idGenerator()
		.replace(/[^a-zA-Z0-9-]/g, "")
		.slice(0, 64);
	const temporary = `${file}.tmp-${suffix}`;
	try {
		await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
		await rename(temporary, file);
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

async function persistRun(orderDirectory: string, run: Run, idGenerator: () => string): Promise<void> {
	const parsed = runSchema.parse(run);
	await atomicWrite(
		path.join(orderDirectory, "runs", run.id, "meta.json"),
		`${JSON.stringify(parsed, null, 2)}\n`,
		idGenerator,
	);
}

const WORKSPACE_FINGERPRINT_FILENAME = "workspace-before.json";
const COOLDOWN_FILENAME = "cooldown.json";
const BASE_IDENTITY_FILENAME = "base.json";

async function readBaseIdentity(orderDirectory: string): Promise<string | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path.join(orderDirectory, BASE_IDENTITY_FILENAME), "utf8"));
		if (typeof value === "object" && value !== null && "oid" in value && typeof value.oid === "string") {
			return value.oid;
		}
		throw new DispatchSupervisorError("STATE_REPAIR_FAILED", "dispatch base identity sidecar is malformed");
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
			return undefined;
		}
		throw error;
	}
}

async function persistBaseIdentity(orderDirectory: string, oid: string, idGenerator: () => string): Promise<void> {
	const existing = await readBaseIdentity(orderDirectory);
	if (existing !== undefined && existing !== oid) {
		throw new DispatchSupervisorError("STATE_REPAIR_FAILED", `frozen dispatch base changed from ${existing} to ${oid}`);
	}
	if (existing === undefined) {
		await atomicWrite(path.join(orderDirectory, BASE_IDENTITY_FILENAME), `${JSON.stringify({ oid })}\n`, idGenerator);
	}
}

async function publishRun(
	input: {
		orderDirectory: string;
		run: Run;
		brief: string;
		fingerprint: WorkspaceFingerprint;
		resultPath: string;
		progressPath: string;
	},
	dependencies: { idGenerator: () => string; beforePublish?: (temporary: string) => void | Promise<void> },
): Promise<void> {
	const runsDirectory = path.join(input.orderDirectory, "runs");
	const suffix = dependencies
		.idGenerator()
		.replace(/[^a-zA-Z0-9-]/g, "")
		.slice(0, 64);
	const temporary = path.join(runsDirectory, `.tmp-${input.run.id}-${suffix}`);
	const finalDirectory = path.join(runsDirectory, input.run.id);
	try {
		await mkdir(temporary);
		await mkdir(path.join(temporary, "out"), { recursive: true });
		await mkdir(path.join(temporary, path.dirname(input.resultPath)), { recursive: true });
		await mkdir(path.join(temporary, path.dirname(input.progressPath)), { recursive: true });
		await writeFile(path.join(temporary, "brief.md"), input.brief, "utf8");
		await writeFile(path.join(temporary, "stdout.log"), "", "utf8");
		await writeFile(path.join(temporary, "stderr.log"), "", "utf8");
		await writeFile(
			path.join(temporary, WORKSPACE_FINGERPRINT_FILENAME),
			`${JSON.stringify(input.fingerprint)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(temporary, "meta.json"),
			`${JSON.stringify(runSchema.parse(input.run), null, 2)}\n`,
			"utf8",
		);
		await dependencies.beforePublish?.(temporary);
		await rename(temporary, finalDirectory);
	} catch (error) {
		await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

async function readRunFingerprint(orderDirectory: string, runId: string): Promise<WorkspaceFingerprint | undefined> {
	try {
		const value: unknown = JSON.parse(
			await readFile(path.join(orderDirectory, "runs", runId, WORKSPACE_FINGERPRINT_FILENAME), "utf8"),
		);
		if (
			typeof value === "object" &&
			value !== null &&
			"head" in value &&
			typeof value.head === "string" &&
			"porcelain" in value &&
			typeof value.porcelain === "string" &&
			"trackedDiff" in value &&
			typeof value.trackedDiff === "string" &&
			"untracked" in value &&
			Array.isArray(value.untracked) &&
			value.untracked.every(
				(item) =>
					typeof item === "object" &&
					item !== null &&
					"path" in item &&
					typeof item.path === "string" &&
					"hash" in item &&
					typeof item.hash === "string",
			)
		) {
			return {
				head: value.head,
				porcelain: value.porcelain,
				trackedDiff: value.trackedDiff,
				untracked: value.untracked as { path: string; hash: string }[],
			};
		}
		throw new Error("invalid workspace fingerprint");
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
			return undefined;
		}
		throw error;
	}
}

function workspaceChanged(before: WorkspaceFingerprint | undefined, after: WorkspaceFingerprint): boolean {
	return (
		before !== undefined &&
		(before.head !== after.head ||
			before.porcelain !== after.porcelain ||
			before.trackedDiff !== after.trackedDiff ||
			JSON.stringify(before.untracked) !== JSON.stringify(after.untracked))
	);
}

async function persistCooldown(
	orderDirectory: string,
	runId: string,
	resumeAfter: string,
	idGenerator: () => string,
): Promise<void> {
	await atomicWrite(
		path.join(orderDirectory, "runs", runId, COOLDOWN_FILENAME),
		`${JSON.stringify({ resume_after: resumeAfter })}\n`,
		idGenerator,
	);
}

async function readPersistedCooldown(orderDirectory: string, runId: string): Promise<string | undefined> {
	try {
		const value: unknown = JSON.parse(
			await readFile(path.join(orderDirectory, "runs", runId, COOLDOWN_FILENAME), "utf8"),
		);
		return typeof value === "object" &&
			value !== null &&
			"resume_after" in value &&
			typeof value.resume_after === "string"
			? value.resume_after
			: undefined;
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
			return undefined;
		}
		throw error;
	}
}

async function recoverRateLimitCooldown(orderDirectory: string, run: Run): Promise<string | undefined> {
	if (run.outcome !== "RATE_LIMITED" || run.ended_at === undefined) {
		return undefined;
	}
	const [stdout, stderr] = await Promise.all([
		readLog(path.join(orderDirectory, run.stdout_path), ""),
		readLog(path.join(orderDirectory, run.stderr_path), ""),
	]);
	try {
		const recovered = classifyRunOutcome({
			cliName: run.cli,
			exitCode: run.exit_code ?? null,
			signal: run.signal ?? null,
			stdoutTail: stdout.slice(-4_000),
			stderrTail: stderr.slice(-4_000),
			evidence: {
				resultFile: { established: false, reason: "missing", message: "replay uses conservative no-evidence" },
				commit: { established: false, reason: "no-commits", commitSubjects: [] },
			},
			nowMs: Date.parse(run.ended_at),
		});
		return recovered.outcome === "RATE_LIMITED" ? recovered.cooldown?.resumeAfter : undefined;
	} catch {
		return undefined;
	}
}

async function persistAuthoringVendor(
	orderDirectory: string,
	order: WorkOrder,
	vendor: string,
	idGenerator: () => string,
): Promise<WorkOrder> {
	if (order.authoring_vendors.includes(vendor)) {
		return order;
	}
	const file = path.join(orderDirectory, "order.yaml");
	const content = await readFile(file, "utf8");
	const document = parseDocument(content, { prettyErrors: false, uniqueKeys: true });
	if (document.errors.length > 0) {
		throw new DispatchSupervisorError("STATE_REPAIR_FAILED", `${file}: invalid order YAML`);
	}
	const parsed = workOrderSchema.parse({
		...(document.toJS() as WorkOrder),
		authoring_vendors: [...order.authoring_vendors, vendor],
	});
	const header = content
		.split("\n")
		.filter((line) => line.startsWith("#"))
		.join("\n");
	await atomicWrite(file, `${header}${header ? "\n" : ""}${stringify(parsed)}`, idGenerator);
	return parsed;
}

export function reviewerConflictWarning(
	order: WorkOrder,
	reviewerVendor: string | undefined,
): ReviewerConflictWarning | undefined {
	if (!reviewerVendor || !order.authoring_vendors.includes(reviewerVendor)) {
		return undefined;
	}
	return {
		code: "REVIEWER_VENDOR_CONFLICT",
		reviewerVendor,
		authoringVendors: [...order.authoring_vendors],
		suggestedVendors: [
			...new Set(
				order.candidate_ladder
					.map((candidate) => candidate.vendor)
					.filter((vendor) => vendor !== reviewerVendor && !order.authoring_vendors.includes(vendor)),
			),
		],
	};
}

async function appendTransition(
	mutable: MutableSupervision,
	event: StateTransitionEvent,
	env: NodeJS.ProcessEnv,
	append: NonNullable<SupervisorDependencies["append"]>,
): Promise<void> {
	assertTransition(mutable.loaded.state, event.to, event);
	await append(mutable.loaded.order.id, event, env);
	mutable.loaded = {
		...mutable.loaded,
		state: event.to,
		journal: [...mutable.loaded.journal, event],
	};
}

async function findRepositoryConflict(
	loaded: LoadedWorkOrder,
	env: NodeJS.ProcessEnv,
	dependencies: {
		list: NonNullable<SupervisorDependencies["list"]>;
		realpath: NonNullable<SupervisorDependencies["realpath"]>;
		readSupervisorRecord: NonNullable<SupervisorDependencies["readSupervisorRecord"]>;
		isProcessAlive: NonNullable<SupervisorDependencies["isProcessAlive"]>;
	},
): Promise<SupervisorConflict | undefined> {
	const targetRealpath = await dependencies.realpath(loaded.order.target_repo.path);
	for (const other of await dependencies.list(env)) {
		if (other.order.id === loaded.order.id || TERMINAL_ORDER_STATES.has(other.state)) {
			continue;
		}
		let otherRealpath: string;
		try {
			otherRealpath = await dependencies.realpath(other.order.target_repo.path);
		} catch {
			continue;
		}
		if (otherRealpath !== targetRealpath) {
			continue;
		}
		const record = await dependencies.readSupervisorRecord(other.order.id, env);
		if (record && dependencies.isProcessAlive(record.pid)) {
			return { code: "TARGET_REPOSITORY_BUSY", conflictingOrderId: other.order.id, targetRealpath };
		}
	}
	return undefined;
}

async function runWithTimers(
	options: AgentRunOptions,
	runner: AgentRunner,
	timers: DispatchTimerScheduler,
	stallSeconds: number,
	wallSeconds: number,
	onSpawn: AgentRunOptions["onSpawn"],
): Promise<FinishedProcess> {
	const controller = new AbortController();
	let supervisorOutcome: FinishedProcess["supervisorOutcome"];
	let stallTimer: unknown;
	let wallTimer: unknown;
	const abortFor = (outcome: "TIMEOUT" | "STALLED") => {
		if (supervisorOutcome === undefined) {
			supervisorOutcome = outcome;
			controller.abort();
		}
	};
	const resetStall = () => {
		if (stallTimer !== undefined) {
			timers.clear(stallTimer);
		}
		stallTimer = timers.set(stallSeconds * 1000, () => abortFor("STALLED"));
	};
	resetStall();
	wallTimer = timers.set(wallSeconds * 1000, () => abortFor("TIMEOUT"));
	try {
		const result = await runner({
			...options,
			timeoutSeconds: wallSeconds,
			signal: controller.signal,
			onSpawn,
			onActivity: () => resetStall(),
		});
		return {
			exitCode: 0,
			signal: null,
			stdout: result.stdout,
			stderr: result.stderr,
			supervisorOutcome,
			spawnFailed: false,
		};
	} catch (error) {
		if (error instanceof AgentRunError) {
			return {
				exitCode: error.exitCode,
				signal: error.signal,
				stdout: "",
				stderr: error.stderrTail,
				supervisorOutcome: supervisorOutcome ?? (error.kind === "timeout" ? "TIMEOUT" : undefined),
				spawnFailed: error.kind === "spawn-failed",
			};
		}
		return {
			exitCode: null,
			signal: null,
			stdout: "",
			stderr: errorMessage(error),
			supervisorOutcome,
			spawnFailed: true,
		};
	} finally {
		if (stallTimer !== undefined) {
			timers.clear(stallTimer);
		}
		if (wallTimer !== undefined) {
			timers.clear(wallTimer);
		}
	}
}

async function waitForRunnerProcessGroupDeath(
	pgid: number,
	dependencies: {
		probe: (pgid: number) => boolean;
		sleep: (delayMs: number) => Promise<void>;
		terminate: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void | Promise<void>;
	},
): Promise<boolean> {
	if (!dependencies.probe(pgid)) {
		return true;
	}
	await dependencies.sleep(5_000);
	if (dependencies.probe(pgid)) {
		await dependencies.terminate(pgid, "SIGKILL");
		await dependencies.sleep(0);
	}
	return !dependencies.probe(pgid);
}

async function killOrphanProcessGroup(
	pgid: number,
	dependencies: {
		probe: (pgid: number) => boolean;
		sleep: (delayMs: number) => Promise<void>;
		terminate: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void | Promise<void>;
	},
): Promise<boolean> {
	if (!dependencies.probe(pgid)) {
		return true;
	}
	await dependencies.terminate(pgid, "SIGTERM");
	await dependencies.sleep(5_000);
	if (dependencies.probe(pgid)) {
		await dependencies.terminate(pgid, "SIGKILL");
		await dependencies.sleep(0);
	}
	return !dependencies.probe(pgid);
}

async function waitForOrphanProcessGroup(
	pgid: number,
	probe: (pgid: number) => boolean,
	sleep: (delayMs: number) => Promise<void>,
): Promise<void> {
	while (probe(pgid)) {
		await sleep(1_000);
	}
}

function lastTransitionEvent(loaded: LoadedWorkOrder): StateTransitionEvent | undefined {
	for (let index = loaded.journal.length - 1; index >= 0; index -= 1) {
		const event = loaded.journal[index];
		if (event && event.type !== "ORDER_CREATED" && event.type !== "LOCK_TAKEN_OVER") {
			return event;
		}
	}
	return undefined;
}

async function readLog(file: string, fallback: string): Promise<string> {
	try {
		const durable = await readFile(file, "utf8");
		return durable.length > 0 ? durable : fallback;
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
			return fallback;
		}
		throw error;
	}
}

function replaceRun(runs: readonly Run[], run: Run): Run[] {
	const index = runs.findIndex((candidate) => candidate.id === run.id);
	if (index < 0) {
		return [...runs, run].sort((left, right) => left.id.localeCompare(right.id));
	}
	const updated = [...runs];
	updated[index] = run;
	return updated;
}

/**
 * Drive one order while holding package A's supervisor lock. The injected
 * git executor is already scoped to target_repo.path by package E.
 */
export async function superviseWorkOrder(
	input: SuperviseWorkOrderInput,
	dependencies: SupervisorDependencies,
): Promise<SupervisionResult> {
	const env = dependencies.env ?? process.env;
	const pid = dependencies.pid ?? process.pid;
	const now = dependencies.now ?? (() => new Date());
	const idGenerator = dependencies.idGenerator ?? randomUUID;
	const isProcessAlive = dependencies.isProcessAlive ?? processAlive;
	const probeProcessGroup = dependencies.probeProcessGroup ?? processGroupAlive;
	const terminateProcessGroup = dependencies.terminateProcessGroup ?? terminateGroup;
	const resolveRealpath = dependencies.realpath ?? fsRealpath;
	const readSupervisorRecord = dependencies.readSupervisorRecord ?? readLockRecord;
	const timers = dependencies.timers ?? defaultTimers;
	const sleep = dependencies.sleep ?? defaultSleep;
	const acquireLock = dependencies.acquireLock ?? acquireSupervisorLock;
	const load = dependencies.load ?? loadOrder;
	const list = dependencies.list ?? listOrders;
	const append = dependencies.append ?? appendJournalEvent;
	const resolveCommand = dependencies.resolveCommand ?? defaultResolveCandidate;
	const runner = dependencies.runner ?? runAgentCommand;
	const prepareWorkspace = dependencies.prepareWorkspace ?? prepareDispatchWorkspace;
	const resolveBaseOid = dependencies.resolveBaseOid ?? resolveDispatchBaseOid;
	const activateWorkspace = dependencies.activateWorkspace ?? verifyDispatchWorkspaceActive;
	const snapshot = dependencies.snapshot ?? createWipSnapshot;
	const workspaceFingerprint = dependencies.workspaceFingerprint ?? readWorkspaceFingerprint;
	const evidenceCheck = dependencies.evidence ?? checkDeliveryEvidence;
	const handoff = dependencies.handoff ?? synthesizeHandoffPacket;
	const resultReader = dependencies.resultReader ?? { readText: defaultResultReader };
	const stallSeconds = validSeconds(input.stallSeconds ?? DISPATCH_STALL_SECONDS, "stallSeconds");
	const maxRunSeconds = validSeconds(input.maxRunSeconds ?? resolveDispatchMaxRunSeconds(env), "maxRunSeconds");

	const lock = await acquireLock(input.orderId, {
		env,
		pid,
		now,
		randomUUID: idGenerator,
		isProcessAlive,
	});
	try {
		const mutable: MutableSupervision = {
			loaded: await load(input.orderId, env),
			warnings: [],
			gitEvidenceAvailable: true,
		};
		const orderDirectory = dispatchOrderDirectory(input.orderId, env);
		let frozenBaseOid = await readBaseIdentity(orderDirectory);
		let baseRef = frozenBaseOid ?? input.baseRef;
		if (frozenBaseOid !== undefined) {
			const verifiedBaseOid = await resolveBaseOid(frozenBaseOid, dependencies.git);
			if (verifiedBaseOid !== frozenBaseOid) {
				throw new DispatchSupervisorError("STATE_REPAIR_FAILED", "frozen dispatch base no longer resolves to itself");
			}
		} else if (mutable.loaded.state !== "PENDING") {
			frozenBaseOid = await resolveBaseOid(input.baseRef, dependencies.git);
			await persistBaseIdentity(orderDirectory, frozenBaseOid, idGenerator);
			baseRef = frozenBaseOid;
			mutable.warnings.push("legacy order lacked a frozen base sidecar; froze the currently resolved configured base");
		}

		const result = (extra: Partial<SupervisionResult> = {}): SupervisionResult => ({
			orderId: input.orderId,
			state: mutable.loaded.state,
			runs: mutable.loaded.runs,
			authoringVendors: mutable.loaded.order.authoring_vendors,
			warnings: mutable.warnings,
			...extra,
		});

		const conflictCheck = async (): Promise<void> => {
			const conflict = await findRepositoryConflict(mutable.loaded, env, {
				list,
				realpath: resolveRealpath,
				readSupervisorRecord,
				isProcessAlive,
			});
			if (conflict) {
				throw new DispatchSupervisorError(
					"TARGET_REPOSITORY_BUSY",
					`order ${conflict.conflictingOrderId} already supervises ${conflict.targetRealpath}`,
					{ conflict },
				);
			}
		};

		const checkpointWorkspace = async (run: Run): Promise<WipSnapshotResult> => {
			const before = await readRunFingerprint(orderDirectory, run.id);
			const after = await workspaceFingerprint(dependencies.git);
			const authored = workspaceChanged(before, after);
			const snapshotResult = await snapshot(run.id, dependencies.git);
			mutable.gitEvidenceAvailable = snapshotResult.gitEvidenceAvailable;
			if (snapshotResult.warning) {
				mutable.warnings.push(`${snapshotResult.warning.message}: ${snapshotResult.warning.stderr}`);
			}
			if (!snapshotResult.gitEvidenceAvailable) {
				await writeFile(
					path.join(orderDirectory, "runs", run.id, "git-evidence-unavailable"),
					`${snapshotResult.warning?.message ?? "WIP snapshot failed"}\n`,
					"utf8",
				);
			}
			if (authored) {
				mutable.loaded = {
					...mutable.loaded,
					order: await persistAuthoringVendor(orderDirectory, mutable.loaded.order, run.vendor, idGenerator),
				};
			}
			return snapshotResult;
		};

		const finalizeJournalledKill = async (run: Run): Promise<SupervisionResult> => {
			if (run.pgid === undefined && input.orphanAction !== "confirm-dead") {
				return result({
					orphan: { action: "report", runId: run.id, reason: "MISSING_PGID" },
					resumeHint: `cannot prove ${run.id} stopped because package B did not durably publish pgid`,
				});
			}
			if (run.pgid !== undefined) {
				const dead = await killOrphanProcessGroup(run.pgid, {
					probe: probeProcessGroup,
					sleep,
					terminate: terminateProcessGroup,
				});
				if (!dead) {
					return result({
						orphan: {
							action: "report",
							runId: run.id,
							pgid: run.pgid,
							reason: "PROCESS_GROUP_STILL_ALIVE",
						},
						resumeHint: `process group ${run.pgid} is still alive; inspect before resuming`,
					});
				}
			}
			await activateWorkspace(input.orderId, dependencies.git);
			await checkpointWorkspace(run);
			const killed: Run = {
				...run,
				ended_at: now().toISOString(),
				outcome: "KILLED",
				exit_code: null,
				signal: null,
			};
			await persistRun(orderDirectory, killed, idGenerator);
			mutable.loaded = { ...mutable.loaded, runs: replaceRun(mutable.loaded.runs, killed) };
			return result();
		};

		const scheduleAfterOutcome = async (
			run: Run,
			classification?: ClassificationResult,
		): Promise<PendingRun | SupervisionResult> => {
			const outcome = run.outcome;
			if (!outcome) {
				throw new DispatchSupervisorError("STATE_REPAIR_FAILED", `${run.id} is not terminal`);
			}
			const at = now().toISOString();
			if (outcome === "COMPLETED") {
				await appendTransition(
					mutable,
					{
						apiVersion: "gatekeeper/v1",
						type: "ORDER_DELIVERED",
						order_id: input.orderId,
						at,
						run_id: run.id,
						outcome,
						from: "RUNNING",
						to: "DELIVERED",
					},
					env,
					append,
				);
				return result({
					reviewerConflict: reviewerConflictWarning(mutable.loaded.order, input.reviewerVendor),
				});
			}
			if (outcome === "KILLED") {
				await appendTransition(
					mutable,
					{
						apiVersion: "gatekeeper/v1",
						type: "ORDER_CANCELLED",
						order_id: input.orderId,
						at,
						run_id: run.id,
						outcome,
						from: "RUNNING",
						to: "ABANDONED",
					},
					env,
					append,
				);
				return result();
			}

			const atCap = mutable.loaded.runs.length >= DISPATCH_TOTAL_RUN_CAP;
			const directAttention = outcome === "AGENT_BLOCKED" || outcome === "SPAWN_FAILED";
			if (atCap || directAttention) {
				const journalOutcome = outcome === "RATE_LIMITED" ? "AGENT_ERROR" : outcome;
				await appendTransition(
					mutable,
					{
						apiVersion: "gatekeeper/v1",
						type: "ATTENTION_REQUIRED",
						order_id: input.orderId,
						at,
						run_id: run.id,
						outcome: journalOutcome,
						reason:
							outcome === "RATE_LIMITED"
								? `RATE_LIMITED exhausted the total run cap of ${DISPATCH_TOTAL_RUN_CAP}; package A cannot encode RATE_LIMITED in ATTENTION_REQUIRED`
								: atCap
									? `total run cap of ${DISPATCH_TOTAL_RUN_CAP} exhausted after ${outcome}`
									: `${outcome} requires human attention`,
						from: "RUNNING",
						to: "NEEDS_ATTENTION",
					},
					env,
					append,
				);
				return result();
			}

			const candidate = nextCandidate(mutable.loaded.order, mutable.loaded.runs, run);
			const newRunId = nextRunId(mutable.loaded.runs);
			if (candidate) {
				await appendTransition(
					mutable,
					{
						apiVersion: "gatekeeper/v1",
						type: "RUN_RETRY_SCHEDULED",
						order_id: input.orderId,
						at,
						previous_run_id: run.id,
						next_run_id: newRunId,
						outcome: outcome as Exclude<RunOutcome, "COMPLETED" | "KILLED" | "AGENT_BLOCKED" | "SPAWN_FAILED">,
						from: "RUNNING",
						to: "RUNNING",
					},
					env,
					append,
				);
				return { runId: newRunId, candidate };
			}

			if (outcome === "RATE_LIMITED") {
				const resumeAfter =
					classification?.cooldown?.resumeAfter ??
					(await readPersistedCooldown(orderDirectory, run.id)) ??
					(await recoverRateLimitCooldown(orderDirectory, run)) ??
					new Date(Date.parse(run.ended_at ?? run.started_at) + defaultCooldownSeconds(run.cli) * 1000).toISOString();
				await persistCooldown(orderDirectory, run.id, resumeAfter, idGenerator);
				await appendTransition(
					mutable,
					{
						apiVersion: "gatekeeper/v1",
						type: "COOLDOWN_STARTED",
						order_id: input.orderId,
						at,
						run_id: run.id,
						outcome,
						resume_after: resumeAfter,
						from: "RUNNING",
						to: "WAITING_COOLDOWN",
					},
					env,
					append,
				);
				const remainingMs = Math.max(0, Date.parse(resumeAfter) - now().getTime());
				if (remainingMs > DISPATCH_COOLDOWN_EXIT_THRESHOLD_SECONDS * 1000) {
					return result({ resumeHint: `gatekeeper dispatch resume ${input.orderId} after ${resumeAfter}` });
				}
				if (remainingMs > 0) {
					await sleep(remainingMs);
				}
				await appendTransition(
					mutable,
					{
						apiVersion: "gatekeeper/v1",
						type: "ORDER_RESUMED",
						order_id: input.orderId,
						at: now().toISOString(),
						new_run_id: newRunId,
						from: "WAITING_COOLDOWN",
						to: "RUNNING",
						forced: false,
					},
					env,
					append,
				);
				const sameCandidate = nextCandidate(mutable.loaded.order, mutable.loaded.runs, run, true);
				if (!sameCandidate) {
					throw new DispatchSupervisorError("STATE_REPAIR_FAILED", `cannot reselect cooled candidate for ${run.id}`);
				}
				return { runId: newRunId, candidate: sameCandidate };
			}

			await appendTransition(
				mutable,
				{
					apiVersion: "gatekeeper/v1",
					type: "ATTENTION_REQUIRED",
					order_id: input.orderId,
					at,
					run_id: run.id,
					outcome,
					reason: `candidate ladder exhausted after ${outcome}`,
					from: "RUNNING",
					to: "NEEDS_ATTENTION",
				},
				env,
				append,
			);
			return result();
		};

		if (mutable.loaded.state === "DELIVERED") {
			return result();
		}
		if (mutable.loaded.state === "ABANDONED") {
			const unfinishedCancellation = activeRun(mutable.loaded.runs);
			return unfinishedCancellation ? finalizeJournalledKill(unfinishedCancellation) : result();
		}
		if (mutable.loaded.state === "NEEDS_ATTENTION") {
			return result({ resumeHint: `gatekeeper dispatch resume ${input.orderId}` });
		}

		let pending: PendingRun | undefined;
		if (mutable.loaded.state === "WAITING_COOLDOWN") {
			let cooldown: Extract<JournalEvent, { type: "COOLDOWN_STARTED" }> | undefined;
			for (let index = mutable.loaded.journal.length - 1; index >= 0; index -= 1) {
				const event = mutable.loaded.journal[index];
				if (event?.type === "COOLDOWN_STARTED") {
					cooldown = event;
					break;
				}
			}
			const previous = mutable.loaded.runs.at(-1);
			if (!cooldown || !previous) {
				throw new DispatchSupervisorError("STATE_REPAIR_FAILED", "WAITING_COOLDOWN lacks a prior rate-limited run");
			}
			const remainingMs = Math.max(0, Date.parse(cooldown.resume_after) - now().getTime());
			if (!input.forceCooldown && remainingMs > DISPATCH_COOLDOWN_EXIT_THRESHOLD_SECONDS * 1000) {
				return result({
					resumeHint: `gatekeeper dispatch resume ${input.orderId} after ${cooldown.resume_after}`,
				});
			}
			if (!input.forceCooldown && remainingMs > 0) {
				await sleep(remainingMs);
			}
			const newRunId = nextRunId(mutable.loaded.runs);
			await appendTransition(
				mutable,
				{
					apiVersion: "gatekeeper/v1",
					type: "ORDER_RESUMED",
					order_id: input.orderId,
					at: now().toISOString(),
					new_run_id: newRunId,
					from: "WAITING_COOLDOWN",
					to: "RUNNING",
					forced: input.forceCooldown ?? false,
				},
				env,
				append,
			);
			const candidate = nextCandidate(mutable.loaded.order, mutable.loaded.runs, previous, true);
			if (!candidate) {
				throw new DispatchSupervisorError("STATE_REPAIR_FAILED", "cooled ladder candidate is no longer available");
			}
			pending = { runId: newRunId, candidate };
		}

		if (mutable.loaded.state === "PENDING") {
			await conflictCheck();
			await prepareWorkspace(
				{
					orderId: input.orderId,
					baseRef,
					onBaseResolved: async (resolvedOid) => {
						await persistBaseIdentity(orderDirectory, resolvedOid, idGenerator);
						frozenBaseOid = resolvedOid;
						baseRef = resolvedOid;
					},
				},
				dependencies.git,
			);
			const firstCandidate = mutable.loaded.order.candidate_ladder[0];
			if (!firstCandidate) {
				throw new DispatchSupervisorError("NO_AGENT_COMMAND", "candidate ladder is empty");
			}
			const runId = nextRunId(mutable.loaded.runs);
			await appendTransition(
				mutable,
				{
					apiVersion: "gatekeeper/v1",
					type: "RUN_STARTED",
					order_id: input.orderId,
					at: now().toISOString(),
					run_id: runId,
					from: "PENDING",
					to: "RUNNING",
				},
				env,
				append,
			);
			pending = { runId, candidate: firstCandidate };
		}

		if (mutable.loaded.state === "RUNNING" && !pending) {
			const orphan = activeRun(mutable.loaded.runs);
			if (orphan) {
				if (orphan.pgid === undefined && input.orphanAction !== "confirm-dead") {
					return result({
						orphan: { action: "report", runId: orphan.id, reason: "MISSING_PGID" },
						resumeHint: `cannot reconcile ${orphan.id}: package B onSpawn is not awaitable and pgid was not durably recorded`,
					});
				}
				if (orphan.pgid !== undefined && probeProcessGroup(orphan.pgid)) {
					const action = input.orphanAction ?? "report";
					if (action === "report" || action === "confirm-dead") {
						return result({
							orphan: { action: "report", runId: orphan.id, pgid: orphan.pgid, reason: "LIVE_PROCESS_GROUP" },
							resumeHint: `gatekeeper dispatch resume ${input.orderId} --wait|--kill`,
						});
					}
					if (action === "wait") {
						await waitForOrphanProcessGroup(orphan.pgid, probeProcessGroup, sleep);
					} else {
						await appendTransition(
							mutable,
							{
								apiVersion: "gatekeeper/v1",
								type: "ORDER_CANCELLED",
								order_id: input.orderId,
								at: now().toISOString(),
								run_id: orphan.id,
								outcome: "KILLED",
								from: "RUNNING",
								to: "ABANDONED",
							},
							env,
							append,
						);
						return finalizeJournalledKill(orphan);
					}
				}

				await activateWorkspace(input.orderId, dependencies.git);
				await checkpointWorkspace(orphan);
				const evidence = await evidenceCheck(
					{
						resultPath: path.join(
							orderDirectory,
							"runs",
							orphan.id,
							mutable.loaded.order.acceptance_contract.result_path,
						),
						baseRef,
					},
					{ resultReader, git: dependencies.git },
				);
				const verdict = evaluateDeliveryEvidence(0, evidence);
				const outcome: RunOutcome =
					verdict === "COMPLETED" ? "COMPLETED" : verdict === "AGENT_BLOCKED" ? "AGENT_BLOCKED" : "ORPHANED_UNKNOWN";
				const reconciled: Run = {
					...orphan,
					ended_at: now().toISOString(),
					outcome,
					exit_code: outcome === "COMPLETED" ? 0 : null,
					signal: null,
				};
				await persistRun(orderDirectory, reconciled, idGenerator);
				mutable.loaded = { ...mutable.loaded, runs: replaceRun(mutable.loaded.runs, reconciled) };
				const decision = await scheduleAfterOutcome(reconciled);
				if (!("candidate" in decision)) {
					return decision;
				}
				pending = decision;
			} else {
				const scheduled = scheduledRunId(mutable.loaded);
				const alreadyExists = scheduled && mutable.loaded.runs.some((run) => run.id === scheduled);
				if (scheduled && !alreadyExists) {
					const previous = mutable.loaded.runs.at(-1);
					const transition = lastTransitionEvent(mutable.loaded);
					const candidate = previous
						? nextCandidate(mutable.loaded.order, mutable.loaded.runs, previous, transition?.type === "ORDER_RESUMED")
						: mutable.loaded.order.candidate_ladder[0];
					if (!candidate) {
						throw new DispatchSupervisorError("STATE_REPAIR_FAILED", `cannot reconstruct candidate for ${scheduled}`);
					}
					pending = { runId: scheduled, candidate };
				} else {
					const previous = mutable.loaded.runs.at(-1);
					if (!previous?.outcome) {
						throw new DispatchSupervisorError("STATE_REPAIR_FAILED", "RUNNING has no active or terminal run to repair");
					}
					const decision = await scheduleAfterOutcome(previous);
					if (!("candidate" in decision)) {
						return decision;
					}
					pending = decision;
				}
			}
		}

		while (pending) {
			if (mutable.loaded.runs.length >= DISPATCH_TOTAL_RUN_CAP) {
				const previous = mutable.loaded.runs.at(-1);
				if (!previous?.outcome) {
					throw new DispatchSupervisorError("STATE_REPAIR_FAILED", "run cap reached without a terminal prior run");
				}
				const capped = await scheduleAfterOutcome(previous);
				if ("candidate" in capped) {
					throw new DispatchSupervisorError("STATE_REPAIR_FAILED", "run cap repair attempted to schedule another run");
				}
				return capped;
			}
			await conflictCheck();
			await activateWorkspace(input.orderId, dependencies.git);
			const { runId, candidate } = pending;
			pending = undefined;
			const resolved = await resolveCommand(candidate, env);
			if (!resolved) {
				throw new DispatchSupervisorError("NO_AGENT_COMMAND", `could not resolve command for ${candidate.cli}`);
			}

			if (mutable.loaded.runs.length > 0) {
				try {
					await readFile(
						path.join(orderDirectory, "runs", mutable.loaded.runs.at(-1)?.id ?? "", "git-evidence-unavailable"),
					);
					mutable.gitEvidenceAvailable = false;
				} catch (error) {
					if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") {
						throw error;
					}
				}
			}
			let brief = mutable.loaded.brief;
			if (mutable.loaded.runs.length > 0) {
				const packet: HandoffPacket = await handoff(
					{
						originalBrief: mutable.loaded.brief,
						baseRef,
						orderDirectory,
						runs: mutable.loaded.runs,
						progressPath: mutable.loaded.order.acceptance_contract.progress_path,
						includeGitEvidence: mutable.gitEvidenceAvailable,
					},
					{ git: dependencies.git, files: { readText: defaultResultReader } },
				);
				brief = packet.content;
				mutable.warnings.push(...packet.warnings.map((warning) => `${warning.section}: ${warning.message}`));
			}

			const runDirectory = path.join(orderDirectory, "runs", runId);
			const briefPath = path.join(runDirectory, "brief.md");
			const stdoutPath = path.join(runDirectory, "stdout.log");
			const stderrPath = path.join(runDirectory, "stderr.log");
			const runOutputPath = path.join(runDirectory, mutable.loaded.order.acceptance_contract.result_path);
			const beforeFingerprint = await workspaceFingerprint(dependencies.git);
			let currentRun: Run = {
				apiVersion: "gatekeeper/v1",
				id: runId,
				cli: candidate.cli,
				vendor: candidate.vendor,
				command: resolved.command,
				brief_path: `runs/${runId}/brief.md`,
				started_at: now().toISOString(),
				stdout_path: `runs/${runId}/stdout.log`,
				stderr_path: `runs/${runId}/stderr.log`,
				out_path: `runs/${runId}/out`,
			};
			await publishRun(
				{
					orderDirectory,
					run: currentRun,
					brief,
					fingerprint: beforeFingerprint,
					resultPath: mutable.loaded.order.acceptance_contract.result_path,
					progressPath: mutable.loaded.order.acceptance_contract.progress_path,
				},
				{ idGenerator, beforePublish: dependencies.beforeRunPublish },
			);
			mutable.loaded = { ...mutable.loaded, runs: replaceRun(mutable.loaded.runs, currentRun) };
			let spawnPersistence = Promise.resolve();
			const processResult = await runWithTimers(
				{
					command: resolved.command,
					timeoutSeconds: maxRunSeconds,
					briefPath,
					outPath: runOutputPath,
					cwd: mutable.loaded.order.target_repo.path,
					env: agentEnvironment(env),
					logSink: { stdoutPath, stderrPath },
				},
				runner,
				timers,
				stallSeconds,
				maxRunSeconds,
				(process) => {
					currentRun = {
						...currentRun,
						pid: process.pid,
						...(process.pgid === null ? {} : { pgid: process.pgid }),
					};
					spawnPersistence = spawnPersistence.then(() => persistRun(orderDirectory, currentRun, idGenerator));
				},
			);
			await spawnPersistence;
			if (
				(processResult.supervisorOutcome === "TIMEOUT" ||
					processResult.supervisorOutcome === "STALLED" ||
					processResult.signal !== null) &&
				!currentRun.pgid
			) {
				return result({
					orphan: { action: "report", runId, reason: "MISSING_PGID" },
					resumeHint: `cannot prove ${runId} stopped because package B onSpawn is not awaitable and pgid was not durably recorded`,
				});
			}
			if (
				currentRun.pgid !== undefined &&
				(processResult.supervisorOutcome === "TIMEOUT" ||
					processResult.supervisorOutcome === "STALLED" ||
					processResult.signal !== null)
			) {
				const dead = await waitForRunnerProcessGroupDeath(currentRun.pgid, {
					probe: probeProcessGroup,
					sleep,
					terminate: terminateProcessGroup,
				});
				if (!dead) {
					return result({
						orphan: {
							action: "report",
							runId,
							pgid: currentRun.pgid,
							reason: "PROCESS_GROUP_STILL_ALIVE",
						},
						resumeHint: `process group ${currentRun.pgid} is still alive; do not start another rung`,
					});
				}
			}
			await checkpointWorkspace(currentRun);

			const evidence: DeliveryEvidence = await evidenceCheck(
				{
					resultPath: runOutputPath,
					baseRef,
				},
				{ resultReader, git: dependencies.git },
			);
			const stdout = await readLog(stdoutPath, processResult.stdout);
			const stderr = await readLog(stderrPath, processResult.stderr);
			let classification: ClassificationResult | undefined;
			const normalizedExitCode = processResult.signal === null ? processResult.exitCode : null;
			const evidenceVerdict = evaluateDeliveryEvidence(normalizedExitCode, evidence);
			let outcome: RunOutcome;
			if (processResult.spawnFailed) {
				outcome = "SPAWN_FAILED";
			} else if (processResult.supervisorOutcome !== undefined) {
				classification = classifyRunOutcome({
					cliName: candidate.cli,
					exitCode: normalizedExitCode,
					signal: processResult.signal,
					stdoutTail: stdout.slice(-4_000),
					stderrTail: stderr.slice(-4_000),
					evidence,
					supervisorOutcome: processResult.supervisorOutcome,
					nowMs: now().getTime(),
				});
				outcome = classification.outcome;
			} else if (evidenceVerdict === "AGENT_BLOCKED") {
				outcome = "AGENT_BLOCKED";
			} else if (processResult.signal !== null && processResult.supervisorOutcome === undefined) {
				outcome = "ORPHANED_UNKNOWN";
			} else {
				classification = classifyRunOutcome({
					cliName: candidate.cli,
					exitCode: normalizedExitCode,
					signal: processResult.signal,
					stdoutTail: stdout.slice(-4_000),
					stderrTail: stderr.slice(-4_000),
					evidence,
					supervisorOutcome: processResult.supervisorOutcome,
					nowMs: now().getTime(),
				});
				outcome = classification.outcome;
			}
			if (classification?.outcome === "RATE_LIMITED" && classification.cooldown?.resumeAfter) {
				await persistCooldown(orderDirectory, runId, classification.cooldown.resumeAfter, idGenerator);
			}
			currentRun = {
				...currentRun,
				ended_at: now().toISOString(),
				outcome,
				exit_code: normalizedExitCode,
				signal: processResult.signal,
			};
			await persistRun(orderDirectory, currentRun, idGenerator);
			mutable.loaded = { ...mutable.loaded, runs: replaceRun(mutable.loaded.runs, currentRun) };
			const decision = await scheduleAfterOutcome(currentRun, classification);
			if (!("candidate" in decision)) {
				return decision;
			}
			pending = decision;
		}

		throw new DispatchSupervisorError("STATE_REPAIR_FAILED", "supervision loop ended without a result");
	} finally {
		await lock.release();
	}
}
