import { execFile as execFileCallback } from "node:child_process";
import { appendFile, readFile as fsReadFile, realpath as fsRealpath, mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { type DetectedAgentCli, detectAgentClis } from "../agent/detect.js";
import { ConfigDiscoveryError, discoverConfig } from "../config/discover.js";
import type { GitExecutionResult, GitExecutor } from "../dispatch/evidence.js";
import { checkResultFile } from "../dispatch/evidence.js";
import { DispatchStoreError, dispatchOrderDirectory, type LoadedWorkOrder, loadOrder } from "../dispatch/store.js";
import { DISPATCH_BRANCH_PREFIX } from "../dispatch/workspace.js";
import { GitDiffError, resolveActor, resolveBaseRef, resolveRepo, resolveRepoRoot } from "../providers/gitdiff.js";
import type { ReviewDiffScope } from "../render/reviewBrief.js";
import {
	type AggregatedBlocker,
	aggregateBlockers,
	type LaneVerdict,
	ReviewAggregateError,
	resolveRefs,
} from "../review/aggregate.js";
import { acquireReviewSupervisorLock, ReviewLockError, type ReviewSupervisorLock } from "../review/lock.js";
import { effectiveMaxRounds, extendRoundLimit } from "../review/machine.js";
import {
	appendJournalEvent,
	type CreateReviewCycleInput,
	createCycle,
	type LoadedReviewCycle,
	listCycles,
	loadCycle,
	ReviewStoreError,
	reviewCycleDirectory,
} from "../review/store.js";
import {
	type ReviewCycleOptions,
	type ReviewSupervisionResult,
	type ReviewSupervisorDependencies,
	ReviewSupervisorError,
	resumeReviewCycle,
	reviewFix,
	superviseReviewCycle,
} from "../review/supervisor.js";
import type { LaneRoute, ReviewCycle, ReviewCycleState, ReviewJournalEvent, ReviewSubject } from "../review/types.js";
import { type ReviewVerdict, reviewVerdictSchema } from "../review/verdict.js";
import { resolveRoleCardPath } from "../roles/cards.js";
import {
	loadRolesPolicy,
	type RolesPolicy,
	type RolesPolicyTier,
	resolveRolesPolicyPath,
	vendorOfModelId,
} from "../roles/policy.js";

/**
 * `gatekeeper review`: the CLI face of the local review-cycle supervisor
 * (src/review/*). Mirrors src/commands/dispatch.ts's split: this module is
 * the only place the nine subcommands (start/status/logs/fix/accept/
 * arbitrate/resume/cancel/render) are implemented -- src/cli.ts only
 * registers commander options and forwards to the functions below. Zero-model
 * invariant holds throughout: every decision here is either a direct
 * pass-through of a human flag/decision, or a deterministic read of
 * already-persisted review state; the reviewer *judgement* happens entirely
 * inside external reviewer CLIs driven by src/review/supervisor.ts.
 *
 * Exit code convention (T-20260721-02 design §1.3, same shape as dispatch's
 * own §1.3 -- see src/commands/dispatch.ts's own doc comment):
 *   0 -- a normal terminal outcome (ACCEPTED) or a harmless no-op (declined
 *        confirmation, already-ACCEPTED re-entry).
 *   2 -- user/config error (bad flags, an unknown/malformed cycle id, a
 *        command invoked against a cycle state it does not apply to, an
 *        unknown --waive/--adopt blocker id, ...).
 *   REVIEW_ATTENTION_EXIT_CODE (3) -- review's own report-and-stop outcome:
 *        every non-ACCEPTED report state (BLOCKED / ARBITRATION /
 *        WAITING_COOLDOWN / AWAITING_ACCEPT / ABANDONED), or an
 *        infrastructure fault raised by src/review/* while supervision was
 *        already under way.
 *   Exit code 1 is never used here -- it is reserved for `gatekeeper gate`'s
 *   block verdict (see CLAUDE.md's fail-direction law).
 */

export const REVIEW_ATTENTION_EXIT_CODE = 3;
/** Frozen at cycle creation (T-20260721-02 design §3: "轮次上限（默认 3）"); arbitration `extend` is the only way to raise it, one round at a time. */
export const REVIEW_DEFAULT_MAX_ROUNDS = 3;
/**
 * `review render --format comment`'s sticky-block marker. Deliberately distinct from src/render/comment.ts's
 * `COMMENT_MARKER` (`<!-- gatekeeper:verdict -->`, the *gate*'s sticky comment) -- the two must never collide on the
 * same PR thread (T-20260721-02 design §7's explicit standard-face guardrail). Versioned (`:v1`) so a future content
 * shape change can still recognize/replace its own prior comment without touching the gate's.
 */
export const REVIEW_RENDER_MARKER = "<!-- gatekeeper:review-verdict:v1 -->";

const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const LOG_TAIL_LINES = 50;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function defaultReadFile(file: string): Promise<string> {
	return fsReadFile(file, "utf8");
}

/** Same plain readline y/N prompt as src/commands/dispatch.ts's defaultPromptConfirm -- duplicated locally (that function is module-private). */
async function defaultPromptConfirm(message: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(message);
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

/** The only place this module shells out to git -- one target repo's local checkout, mirroring src/commands/dispatch.ts's own createGitExecutor (duplicated locally, that function is module-private). */
function createGitExecutor(cwd: string): GitExecutor {
	return {
		exec(args: readonly string[]): Promise<GitExecutionResult> {
			return new Promise((resolve, reject) => {
				execFileCallback(
					"git",
					["-C", cwd, ...args],
					{ maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
					(error, stdout, stderr) => {
						if (!error) {
							resolve({ exitCode: 0, stdout, stderr });
							return;
						}
						const execError = error as NodeJS.ErrnoException & { code?: number | string };
						if (typeof execError.code === "number") {
							resolve({ exitCode: execError.code, stdout: stdout ?? "", stderr: stderr ?? "" });
							return;
						}
						reject(execError);
					},
				);
			});
		},
	};
}

export interface ReviewCommandDependencies {
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
	randomUUID?: () => string;
	randomBytes?: ReviewSupervisorDependencies["randomBytes"];
	isInteractive?: boolean;
	promptConfirm?: (message: string) => Promise<boolean>;
	readFile?: (file: string) => Promise<string>;
	realpath?: (target: string) => Promise<string>;
	detectAgentClis?: typeof detectAgentClis;
	loadRolesPolicy?: typeof loadRolesPolicy;
	resolveRoleCardPath?: (card: string, registryDir?: string) => string;
	createGitExecutor?: (targetRepoPath: string) => GitExecutor;
	/** Explicit operator identity for journal events/ledger entries; skips the git-config lookup when given (mainly a test seam). */
	operator?: string;
	loadOrder?: typeof loadOrder;
	createCycle?: typeof createCycle;
	loadCycle?: typeof loadCycle;
	listCycles?: typeof listCycles;
	appendJournalEvent?: typeof appendJournalEvent;
	/** Narrowed to what accept/arbitrate/cancel actually use -- a test seam can hand back a lock whose release() throws without also fabricating the rest of ReviewSupervisorLock's shape (cycleId/record/path). */
	acquireReviewSupervisorLock?: (
		cycleId: string,
		deps: Parameters<typeof acquireReviewSupervisorLock>[1],
	) => Promise<Pick<ReviewSupervisorLock, "release">>;
	superviseReviewCycle?: typeof superviseReviewCycle;
	resumeReviewCycle?: typeof resumeReviewCycle;
	reviewFix?: typeof reviewFix;
}

// ---------------------------------------------------------------------------
// Shared helpers: exit codes, subject description, next-command hints
// ---------------------------------------------------------------------------

function exitCodeForState(state: ReviewCycleState): number {
	return state === "ACCEPTED" ? 0 : REVIEW_ATTENTION_EXIT_CODE;
}

/** The journal's own last ROUND_STARTED round number -- duplicated from src/review/supervisor.ts's private
 * currentRoundNumber (that module is out of scope for this task). Deliberately reads the journal, not
 * `loaded.rounds` (which mirrors on-disk round *directories* the front-of-terminal supervisor manages): a cycle
 * this CLI has only ever driven through journal events -- never mind normal production, where the two always
 * agree -- must still compute the correct next round number for an arbitration extension. */
function currentRoundNumber(events: readonly ReviewJournalEvent[]): number {
	let round = 0;
	for (const event of events) {
		if (event.type === "ROUND_STARTED") {
			round = event.round;
		}
	}
	return round;
}

/** `NOT_FOUND` (unknown cycle) and `INVALID_DATA` (malformed cycle id) are usage errors; everything else the store raises is review's own report-and-stop territory. Mirrors src/commands/dispatch.ts's loadFailureExitCode. */
function loadFailureExitCode(error: unknown): number {
	return error instanceof ReviewStoreError && (error.code === "NOT_FOUND" || error.code === "INVALID_DATA")
		? 2
		: REVIEW_ATTENTION_EXIT_CODE;
}

function lockFailureExitCode(error: unknown): number {
	return error instanceof ReviewLockError && error.code === "CYCLE_NOT_FOUND" ? 2 : REVIEW_ATTENTION_EXIT_CODE;
}

/**
 * `release()` can itself throw (src/review/lock.ts's own release() re-throws a mapped ReviewLockError on
 * NOT_OWNER/LOCK_IO_FAILED, not just a "best effort" no-op). accept/arbitrate/cancel already computed the correct
 * exit code for the journal work they actually did by the time their own `finally` runs a bare `await
 * lock.release()`; letting a release-time exception replace that already-decided return value would let it escape
 * uncaught to cli.ts's top-level rethrow, which exits 1 -- the code CLAUDE.md's fail-direction law reserves
 * exclusively for `gatekeeper gate`'s block verdict. A lock-release fault is report-only here: warn, never let it
 * override the return value these three commands already settled on (including a genuine 0 on the success path).
 */
async function releaseLockSafely(lock: Pick<ReviewSupervisorLock, "release">, prefix: string): Promise<void> {
	try {
		await lock.release();
	} catch (error) {
		process.stderr.write(`warning: ${prefix}: failed to release the review supervisor lock: ${errorMessage(error)}\n`);
	}
}

function describeSubject(subject: ReviewSubject): string {
	if (subject.kind === "dispatch-order") {
		return `order:${subject.order_id}`;
	}
	return `diff:${subject.repo}@${subject.base_ref}${subject.head_ref ? `..${subject.head_ref}` : ""}`;
}

function nextCommandHint(cycleId: string, state: ReviewCycleState): string | undefined {
	switch (state) {
		case "WAITING_COOLDOWN":
			return `gatekeeper review resume ${cycleId}`;
		case "BLOCKED":
			return `gatekeeper review fix ${cycleId} --waive <blocker-id>=<reason>`;
		case "AWAITING_ACCEPT":
			return `gatekeeper review accept ${cycleId}`;
		case "ARBITRATION":
			return `gatekeeper review arbitrate ${cycleId} --decision accept|abandon|extend --reason "..."`;
		case "FIXING":
			return `gatekeeper review resume ${cycleId}`;
		default:
			return undefined;
	}
}

async function resolveOperator(targetRepoPath: string, dependencies: ReviewCommandDependencies): Promise<string> {
	if (dependencies.operator) {
		return dependencies.operator;
	}
	try {
		const actor = await resolveActor(targetRepoPath);
		return actor ?? "gatekeeper review";
	} catch {
		return "gatekeeper review";
	}
}

// ---------------------------------------------------------------------------
// Lane routing (T-20260721-02 design §4): detect -> roles-policy reviewer
// tier prefer order -> exclude authoring vendors -> first `count` required,
// rest advisory.
// ---------------------------------------------------------------------------

/** Dedupe a tier's `prefer` model ids down to their vendor order. Duplicated from src/agent/assign.ts's private preferredVendorOrder (same convention src/commands/dispatch.ts already uses for its own copy). */
function preferredVendorOrder(prefer: readonly string[]): string[] {
	const seen = new Set<string>();
	const vendors: string[] = [];
	for (const modelId of prefer) {
		const vendor = vendorOfModelId(modelId);
		if (!seen.has(vendor)) {
			seen.add(vendor);
			vendors.push(vendor);
		}
	}
	return vendors;
}

function orderByVendor(eligible: readonly DetectedAgentCli[], preferredVendors: readonly string[]): DetectedAgentCli[] {
	const ordered: DetectedAgentCli[] = [];
	for (const vendor of preferredVendors) {
		for (const cli of eligible) {
			if (cli.vendor === vendor && !ordered.includes(cli)) {
				ordered.push(cli);
			}
		}
	}
	return ordered;
}

/**
 * Every eligible reviewer-tier CLI (already authoring-vendor-excluded), ordered cross-vendor-first when the tier
 * requests it: one CLI per preferred vendor first (mirrors src/agent/assign.ts's selectForTier first pass, but not
 * sliced to `tier.count` -- every vendor gets a shot, not just the first `count`), then every remaining eligible CLI
 * in preferred-vendor-bucket order. `planLaneRoutes` below takes the first `tier.count` entries as required lanes;
 * anything left over is exactly the "prefer 溢出且本机检测到的" advisory pool T-20260721-02 design §4 describes.
 */
function orderReviewerCandidates(eligible: readonly DetectedAgentCli[], tier: RolesPolicyTier): DetectedAgentCli[] {
	const byVendor = orderByVendor(eligible, preferredVendorOrder(tier.prefer));
	if (!tier.crossVendor) {
		return byVendor;
	}
	const seenVendors = new Set<string>();
	const primary: DetectedAgentCli[] = [];
	for (const cli of byVendor) {
		if (seenVendors.has(cli.vendor)) {
			continue;
		}
		seenVendors.add(cli.vendor);
		primary.push(cli);
	}
	const remaining = byVendor.filter((cli) => !primary.includes(cli));
	return [...primary, ...remaining];
}

interface LaneRoutingResult {
	routes: LaneRoute[];
	degraded: boolean;
	warnings: string[];
}

/**
 * Freeze the lane route snapshot a cycle will run with. A required-route shortfall is a hard refusal unless
 * `allowDegraded` -- T-20260721-02 design §4: "必需路凑不满拒发除非 --allow-degraded→DEGRADED 标记+ledger 补审债注明"
 * (the ledger annotation itself is just the `degraded` field every review-ledger line already carries, §7).
 */
function planLaneRoutes(
	eligible: readonly DetectedAgentCli[],
	tier: RolesPolicyTier,
	allowDegraded: boolean,
): LaneRoutingResult | { error: string } {
	const ordered = orderReviewerCandidates(eligible, tier);
	if (ordered.length === 0) {
		return { error: "no reviewer-tier agent CLI is available on this machine after excluding authoring vendors" };
	}
	const required = ordered.slice(0, tier.count);
	const advisory = ordered.slice(tier.count);
	const warnings: string[] = [];
	let degraded = false;
	if (required.length < tier.count) {
		if (!allowDegraded) {
			return {
				error:
					`only ${required.length}/${tier.count} reviewer-tier agent CLI(s) available after excluding authoring ` +
					"vendors; pass --allow-degraded to proceed with a DEGRADED cycle, or install/authorize more " +
					"reviewer-capable CLIs",
			};
		}
		degraded = true;
		warnings.push(`DEGRADED: only ${required.length}/${tier.count} required reviewer lane(s) could be formed`);
	}
	const routes: LaneRoute[] = [...required, ...advisory].map((cli, index) => ({
		id: `L${index + 1}-${cli.name}`,
		cli: cli.name,
		vendor: cli.vendor,
		command: cli.commandTemplate,
		required: index < required.length,
	}));
	return { routes, degraded, warnings };
}

// ---------------------------------------------------------------------------
// Subject resolution: dispatch-order or --diff
// ---------------------------------------------------------------------------

interface ResolvedSubject {
	subject: ReviewSubject;
	targetRepo: ReviewCycle["target_repo"];
	authoringVendors: string[];
	subjectMarkdown: string;
}

type SubjectResolution = ResolvedSubject | { error: string; exitCode: number };

/** Best-effort base-ref auto-detection shared by dispatch-order-subject diff scoping and review's own review-fix continuation. Duplicated from src/commands/dispatch.ts's private resolveOrderBaseRef. */
async function resolveTargetBaseRef(targetRepoPath: string): Promise<string> {
	try {
		const discovered = await discoverConfig(targetRepoPath);
		return await resolveBaseRef(targetRepoPath, discovered?.config.base);
	} catch (error) {
		if (error instanceof GitDiffError || error instanceof ConfigDiscoveryError) {
			return "HEAD";
		}
		throw error;
	}
}

async function buildDispatchOrderSubjectMarkdown(
	loaded: LoadedWorkOrder,
	env: NodeJS.ProcessEnv,
	dependencies: ReviewCommandDependencies,
): Promise<string> {
	const readFile = dependencies.readFile ?? defaultReadFile;
	const lines: string[] = [
		`# Dispatch order ${loaded.order.id}`,
		"",
		`association_key: ${loaded.order.association_key}`,
		`state: ${loaded.state}`,
		"",
	];
	const completed = [...loaded.runs].reverse().find((run) => run.outcome === "COMPLETED") ?? loaded.runs.at(-1);
	if (!completed) {
		lines.push("(no runs recorded yet for this order)");
		return `${lines.join("\n")}\n`;
	}
	lines.push(`## Run ${completed.id} (${completed.cli}/${completed.vendor}, ${completed.outcome ?? "RUNNING"})`, "");
	const resultPath = path.join(
		dispatchOrderDirectory(loaded.order.id, env),
		"runs",
		completed.id,
		loaded.order.acceptance_contract.result_path,
	);
	const evidence = await checkResultFile(resultPath, { readText: readFile });
	if (evidence.established) {
		lines.push(`status: ${evidence.result.status}`, "", evidence.result.summary);
	} else {
		lines.push(`(RESULT.json unavailable: ${evidence.reason} -- ${evidence.message})`);
	}
	return `${lines.join("\n")}\n`;
}

async function resolveDispatchOrderSubject(
	orderId: string,
	dependencies: ReviewCommandDependencies,
): Promise<SubjectResolution> {
	const env = dependencies.env ?? process.env;
	let loaded: LoadedWorkOrder;
	try {
		loaded = await (dependencies.loadOrder ?? loadOrder)(orderId, env);
	} catch (error) {
		const exitCode =
			error instanceof DispatchStoreError && (error.code === "NOT_FOUND" || error.code === "INVALID_DATA")
				? 2
				: REVIEW_ATTENTION_EXIT_CODE;
		return { error: errorMessage(error), exitCode };
	}
	const subjectMarkdown = await buildDispatchOrderSubjectMarkdown(loaded, env, dependencies);
	return {
		subject: { kind: "dispatch-order", order_id: loaded.order.id },
		targetRepo: { name: loaded.order.target_repo.name, path: loaded.order.target_repo.path },
		authoringVendors: [...loaded.order.authoring_vendors],
		subjectMarkdown,
	};
}

async function buildDiffSubjectMarkdown(git: GitExecutor, baseRef: string, headRef: string): Promise<string> {
	const lines: string[] = ["# Diff review subject", "", `range: ${baseRef}...${headRef}`, "", "## Commits", ""];
	const log = await git.exec(["log", "--oneline", `${baseRef}...${headRef}`]);
	if (log.exitCode === 0 && log.stdout.trim().length > 0) {
		lines.push(
			...log.stdout
				.trim()
				.split("\n")
				.map((line) => `- ${line}`),
		);
	} else {
		lines.push("(no commits found, or `git log` failed for this range)");
	}
	return `${lines.join("\n")}\n`;
}

export interface ReviewDiffSubjectInput {
	base: string;
	head?: string;
	authoredBy?: string[];
}

async function resolveDiffSubject(
	options: ReviewDiffSubjectInput,
	cwd: string,
	dependencies: ReviewCommandDependencies,
): Promise<SubjectResolution> {
	const realpath = dependencies.realpath ?? fsRealpath;
	let repoRoot: string;
	try {
		repoRoot = await resolveRepoRoot(cwd);
	} catch (error) {
		return { error: error instanceof GitDiffError ? error.reason : errorMessage(error), exitCode: 2 };
	}
	const targetPath = await realpath(repoRoot);
	let repoName: string;
	try {
		repoName = await resolveRepo(cwd);
	} catch (error) {
		return { error: error instanceof GitDiffError ? error.reason : errorMessage(error), exitCode: 2 };
	}
	const headRef = options.head ?? "HEAD";
	const authoringVendors = [...new Set(options.authoredBy ?? [])];
	const git = (dependencies.createGitExecutor ?? createGitExecutor)(targetPath);
	const subjectMarkdown = await buildDiffSubjectMarkdown(git, options.base, headRef);
	return {
		subject: {
			kind: "diff",
			repo: repoName,
			base_ref: options.base,
			...(options.head ? { head_ref: options.head } : {}),
		},
		targetRepo: { name: repoName, path: targetPath },
		authoringVendors,
		subjectMarkdown,
	};
}

// ---------------------------------------------------------------------------
// Supervisor dependency assembly + the "start detects non-PENDING -> delegate
// to resume" seam shared by start/resume/arbitrate --decision extend.
// ---------------------------------------------------------------------------

function diffScopeForSubject(subject: ReviewSubject, dispatchOrderBaseRef: string): ReviewDiffScope {
	if (subject.kind === "diff") {
		const head = subject.head_ref ?? "HEAD";
		return { summary: `${subject.base_ref}...${head}`, command: `git diff ${subject.base_ref}...${head} --` };
	}
	const branch = `${DISPATCH_BRANCH_PREFIX}${subject.order_id}`;
	return { summary: `${dispatchOrderBaseRef}...${branch}`, command: `git diff ${dispatchOrderBaseRef}...${branch} --` };
}

async function buildSupervisorDependencies(
	cycle: ReviewCycle,
	dependencies: ReviewCommandDependencies,
): Promise<ReviewSupervisorDependencies> {
	const git = (dependencies.createGitExecutor ?? createGitExecutor)(cycle.target_repo.path);
	const readFile = dependencies.readFile ?? defaultReadFile;
	const roleCardPath = (dependencies.resolveRoleCardPath ?? resolveRoleCardPath)("code-reviewer");
	const roleCard = await readFile(roleCardPath);
	const dispatchOrderBaseRef =
		cycle.subject.kind === "dispatch-order" ? await resolveTargetBaseRef(cycle.target_repo.path) : "";
	const diffScope = diffScopeForSubject(cycle.subject, dispatchOrderBaseRef);
	return {
		...(dependencies.env !== undefined ? { env: dependencies.env } : {}),
		...(dependencies.now !== undefined ? { now: dependencies.now } : {}),
		...(dependencies.randomUUID !== undefined ? { idGenerator: dependencies.randomUUID } : {}),
		...(dependencies.randomBytes !== undefined ? { randomBytes: dependencies.randomBytes } : {}),
		git,
		content: { roleCard, diffScope },
	};
}

/**
 * Load the cycle fresh and pick the correct supervisor entry point purely from its on-disk state: PENDING (a cycle
 * `start` just created, the only state it can be in right after `createCycle`) uses `superviseReviewCycle`;
 * everything else uses `resumeReviewCycle`, which alone performs the FIXING/ARBITRATION/WAITING_COOLDOWN
 * reconciliation `promoteJournalConcludedRound` path (C package's E-handoff note: "superviseReviewCycle 终态分支未接
 * promote... 建议 start 检测非 PENDING 时内部委托 resume"). Reused by start (after creation), resume, and
 * arbitrate --decision extend (after journaling the round-limit extension).
 */
async function driveCycle(
	cycleId: string,
	dependencies: ReviewCommandDependencies,
	options: ReviewCycleOptions = {},
): Promise<ReviewSupervisionResult> {
	const env = dependencies.env ?? process.env;
	const loaded = await (dependencies.loadCycle ?? loadCycle)(cycleId, env);
	const supervisorDeps = await buildSupervisorDependencies(loaded.cycle, dependencies);
	if (loaded.state === "PENDING") {
		return (dependencies.superviseReviewCycle ?? superviseReviewCycle)(loaded, supervisorDeps, options);
	}
	return (dependencies.resumeReviewCycle ?? resumeReviewCycle)(loaded, supervisorDeps, options);
}

function printSupervisionResult(prefix: string, result: ReviewSupervisionResult): void {
	process.stdout.write(`${prefix}: cycle ${result.cycleId} -> ${result.state}\n`);
	if (result.round) {
		process.stdout.write(
			`  round: R${result.round.number} (${result.round.status}${result.round.verdict ? `, verdict=${result.round.verdict}` : ""})\n`,
		);
	}
	if (result.blockers.length > 0) {
		process.stdout.write(`  blockers (${result.blockers.length}):\n`);
		for (const blocker of result.blockers) {
			const location = blocker.line !== undefined ? `${blocker.file}:${blocker.line}` : blocker.file;
			const endorsed = blocker.endorsements.length > 1 ? `  [${blocker.endorsements.length}x endorsed]` : "";
			process.stdout.write(`    ${blocker.id}  ${blocker.title} (${location})${endorsed}\n`);
		}
	}
	if (result.fixOrderId) {
		process.stdout.write(`  fix order: ${result.fixOrderId}\n`);
	}
	for (const warning of result.warnings) {
		process.stderr.write(`warning: ${warning.code}: ${warning.message}\n`);
	}
	const hint = nextCommandHint(result.cycleId, result.state);
	if (hint) {
		process.stdout.write(`  next: ${hint}\n`);
	}
}

// ---------------------------------------------------------------------------
// review-ledger (T-20260721-02 design §7: ACCEPTED/ABANDONED terminal lines)
// ---------------------------------------------------------------------------

interface ReviewLedgerEntry {
	schema_version: 1;
	kind: "review";
	cycle_id: string;
	subject: ReviewSubject;
	outcome: "ACCEPTED" | "ABANDONED";
	rounds: number;
	degraded: boolean;
	lane_verdicts: { lane_id: string; cli: string; vendor: string; required: boolean; outcome: string | null }[];
	waived: { blocker_id: string; operator: string; reason: string }[];
	fingerprint?: string;
	operator: string;
	note?: string;
	at: string;
}

/** `<target repo>/.gatekeeper/review-ledger.jsonl`, one line per cycle termination -- fail-open on write failure, same posture as src/commands/dispatch.ts's appendDispatchLedgerEntry. */
async function appendReviewLedgerEntry(
	loaded: LoadedReviewCycle,
	outcome: "ACCEPTED" | "ABANDONED",
	operator: string,
	note: string | undefined,
	dependencies: ReviewCommandDependencies,
): Promise<void> {
	const latestRound = loaded.rounds.at(-1);
	const waived = loaded.journal.flatMap((event) =>
		event.type === "BLOCKER_WAIVED"
			? [{ blocker_id: event.blocker_id, operator: event.operator, reason: event.reason }]
			: [],
	);
	const entry: ReviewLedgerEntry = {
		schema_version: 1,
		kind: "review",
		cycle_id: loaded.cycle.id,
		subject: loaded.cycle.subject,
		outcome,
		rounds: loaded.rounds.length,
		degraded: loaded.cycle.degraded,
		lane_verdicts: latestRound
			? latestRound.lanes.map((lane) => ({
					lane_id: lane.id,
					cli: lane.cli,
					vendor: lane.vendor,
					required: lane.required,
					outcome: lane.outcome ?? null,
				}))
			: [],
		waived,
		...(latestRound ? { fingerprint: latestRound.summary.subject_fingerprint.head } : {}),
		operator,
		...(note && note.length > 0 ? { note } : {}),
		at: (dependencies.now ?? (() => new Date()))().toISOString(),
	};
	const ledgerPath = path.join(loaded.cycle.target_repo.path, ".gatekeeper", "review-ledger.jsonl");
	try {
		await mkdir(path.dirname(ledgerPath), { recursive: true });
		await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
	} catch (error) {
		process.stderr.write(`warning: failed to write local review ledger ${ledgerPath}: ${errorMessage(error)}\n`);
	}
}

// ---------------------------------------------------------------------------
// review start
// ---------------------------------------------------------------------------

export interface ReviewStartOptions {
	subject?: string;
	diff?: boolean;
	base?: string;
	head?: string;
	authoredBy?: string[];
	allowDegraded?: boolean;
	maxParallel?: number;
	yes?: boolean;
}

export async function runReviewStart(
	options: ReviewStartOptions,
	cwd: string,
	dependencies: ReviewCommandDependencies = {},
): Promise<number> {
	const env = dependencies.env ?? process.env;
	const now = dependencies.now ?? (() => new Date());

	if (options.diff && options.subject) {
		process.stderr.write("gatekeeper review start: pass either a dispatch-order-id or --diff, not both\n");
		return 2;
	}
	if (!options.diff && !options.subject) {
		process.stderr.write("gatekeeper review start: a dispatch-order-id, or --diff --base <ref>, is required\n");
		return 2;
	}
	if (options.diff && !options.base) {
		process.stderr.write("gatekeeper review start: --diff requires --base <ref>\n");
		return 2;
	}

	const resolution = options.diff
		? await resolveDiffSubject(
				{ base: options.base as string, head: options.head, authoredBy: options.authoredBy },
				cwd,
				dependencies,
			)
		: await resolveDispatchOrderSubject(options.subject as string, dependencies);
	if ("error" in resolution) {
		process.stderr.write(`gatekeeper review start: ${resolution.error}\n`);
		return resolution.exitCode;
	}
	if (options.diff && resolution.authoringVendors.length === 0) {
		process.stderr.write(
			"warning: no --authored-by given for a --diff subject; the cross-vendor authoring exclusion will not be enforced for this cycle\n",
		);
	}

	let policy: RolesPolicy;
	try {
		policy = await (dependencies.loadRolesPolicy ?? loadRolesPolicy)(resolveRolesPolicyPath(cwd));
	} catch (error) {
		process.stderr.write(`gatekeeper review start: failed to load roles-policy: ${errorMessage(error)}\n`);
		return 2;
	}
	const tier = policy.tiers.reviewer;
	if (!tier) {
		process.stderr.write('gatekeeper review start: roles-policy has no "reviewer" tier configured\n');
		return 2;
	}
	const detected = await (dependencies.detectAgentClis ?? detectAgentClis)({ env });
	const eligible = detected.filter(
		(cli) => cli.tiers.includes("reviewer") && !resolution.authoringVendors.includes(cli.vendor),
	);
	const routing = planLaneRoutes(eligible, tier, options.allowDegraded === true);
	if ("error" in routing) {
		process.stderr.write(`gatekeeper review start: ${routing.error}\n`);
		return 2;
	}
	for (const warning of routing.warnings) {
		process.stderr.write(`warning: ${warning}\n`);
	}

	process.stdout.write(
		`gatekeeper review start: subject ${describeSubject(resolution.subject)} -> ${resolution.targetRepo.path}\n`,
	);
	process.stdout.write(
		`  lanes: ${routing.routes.map((route) => `${route.id}(${route.vendor}${route.required ? "" : ",advisory"})`).join(" ")}\n`,
	);
	if (routing.degraded) {
		process.stdout.write("  DEGRADED cycle: fewer than the configured required reviewer lanes could be formed\n");
	}

	let proceed = options.yes === true;
	if (!proceed) {
		const isTTY = dependencies.isInteractive ?? process.stdin.isTTY === true;
		if (!isTTY) {
			process.stderr.write(
				"gatekeeper review start: not an interactive TTY; re-run with --yes to confirm starting review supervision non-interactively\n",
			);
			return 2;
		}
		proceed = await (dependencies.promptConfirm ?? defaultPromptConfirm)("Start review supervision? [y/N] ");
	}
	if (!proceed) {
		process.stdout.write("gatekeeper review start: aborted (not confirmed); no cycle created\n");
		return 0;
	}

	const input: CreateReviewCycleInput = {
		subject: resolution.subject,
		target_repo: resolution.targetRepo,
		subject_markdown: resolution.subjectMarkdown,
		authoring_vendors: resolution.authoringVendors,
		max_rounds: REVIEW_DEFAULT_MAX_ROUNDS,
		lane_snapshot: routing.routes,
		degraded: routing.degraded,
	};
	let created: LoadedReviewCycle;
	try {
		created = await (dependencies.createCycle ?? createCycle)(input, { env, now, randomUUID: dependencies.randomUUID });
	} catch (error) {
		process.stderr.write(`gatekeeper review start: failed to create the review cycle: ${errorMessage(error)}\n`);
		return REVIEW_ATTENTION_EXIT_CODE;
	}
	process.stdout.write(`gatekeeper review start: created cycle ${created.cycle.id}\n`);

	let result: ReviewSupervisionResult;
	try {
		result = await driveCycle(created.cycle.id, dependencies, { maxParallel: options.maxParallel });
	} catch (error) {
		process.stderr.write(`gatekeeper review start: review supervision faulted: ${errorMessage(error)}\n`);
		return REVIEW_ATTENTION_EXIT_CODE;
	}
	printSupervisionResult("gatekeeper review start", result);
	return exitCodeForState(result.state);
}

// ---------------------------------------------------------------------------
// review status
// ---------------------------------------------------------------------------

export interface ReviewStatusOptions {
	cycleId?: string;
	json?: boolean;
	report?: boolean;
}

interface CycleSummary {
	id: string;
	state: ReviewCycleState;
	subject: ReviewSubject;
	round: number;
	createdAt: string;
	nextCommand?: string;
}

function summarizeCycle(loaded: LoadedReviewCycle): CycleSummary {
	const hint = nextCommandHint(loaded.cycle.id, loaded.state);
	return {
		id: loaded.cycle.id,
		state: loaded.state,
		subject: loaded.cycle.subject,
		round: loaded.rounds.length,
		createdAt: loaded.cycle.created_at,
		...(hint ? { nextCommand: hint } : {}),
	};
}

interface RoundHistoryEntry {
	number: number;
	status: string;
	verdict?: string;
	laneResults: { lane_id: string; required: boolean; outcome: string }[];
}

interface ReportLaneVerdictView {
	laneId: string;
	required: boolean;
	verdict?: ReviewVerdict;
	raw: string;
	parseError?: string;
}

interface ReportBlockerView extends AggregatedBlocker {
	newInIncremental?: boolean;
}

interface CycleDetail {
	id: string;
	state: ReviewCycleState;
	subject: ReviewSubject;
	targetRepo: { name: string; path: string };
	authoringVendors: string[];
	degraded: boolean;
	maxRounds: number;
	createdAt: string;
	laneSnapshot: LaneRoute[];
	rounds: RoundHistoryEntry[];
	nextCommand?: string;
	report?: {
		laneVerdicts: ReportLaneVerdictView[];
		blockers: ReportBlockerView[];
		advisoryFailWarnings: string[];
		waived: { blockerId: string; operator: string; reason: string }[];
		fingerprint: { recorded: string; current?: string; match?: boolean; error?: string };
	};
}

async function loadRoundLaneVerdicts(
	cycleDirectory: string,
	round: LoadedReviewCycle["rounds"][number],
	readFile: (file: string) => Promise<string>,
): Promise<{ verdicts: LaneVerdict[]; views: ReportLaneVerdictView[] }> {
	const verdicts: LaneVerdict[] = [];
	const views: ReportLaneVerdictView[] = [];
	for (const lane of round.lanes) {
		if (lane.outcome !== "PASS" && lane.outcome !== "FAIL") {
			continue;
		}
		let raw = "";
		let verdict: ReviewVerdict | undefined;
		let parseError: string | undefined;
		try {
			raw = await readFile(path.join(cycleDirectory, lane.result_path));
			const candidate = reviewVerdictSchema.safeParse(JSON.parse(raw));
			if (candidate.success) {
				verdict = candidate.data;
				verdicts.push({ laneId: lane.id, verdict: candidate.data });
			} else {
				parseError = "VERDICT.json no longer matches the strict v1 schema";
			}
		} catch (error) {
			parseError = errorMessage(error);
		}
		views.push({
			laneId: lane.id,
			required: lane.required,
			...(verdict ? { verdict } : {}),
			raw,
			...(parseError ? { parseError } : {}),
		});
	}
	return { verdicts, views };
}

async function buildReportSection(
	loaded: LoadedReviewCycle,
	env: NodeJS.ProcessEnv,
	dependencies: ReviewCommandDependencies,
): Promise<CycleDetail["report"] | undefined> {
	const latest = loaded.rounds.at(-1);
	if (!latest) {
		return undefined;
	}
	const readFile = dependencies.readFile ?? defaultReadFile;
	const cycleDirectory = reviewCycleDirectory(loaded.cycle.id, env);
	const { verdicts, views } = await loadRoundLaneVerdicts(cycleDirectory, latest, readFile);

	let blockers: ReportBlockerView[] = [];
	try {
		const aggregated = aggregateBlockers(verdicts);
		if (latest.summary.number > 1) {
			const previous = loaded.rounds.find((round) => round.summary.number === latest.summary.number - 1);
			const priorVerdicts = previous ? (await loadRoundLaneVerdicts(cycleDirectory, previous, readFile)).verdicts : [];
			const priorBlockers = aggregateBlockers(priorVerdicts);
			const resolved = resolveRefs(aggregated, priorBlockers);
			blockers = resolved.blockers.slice().sort((a, b) => Number(b.newInIncremental) - Number(a.newInIncremental));
		} else {
			blockers = aggregated;
		}
	} catch (error) {
		process.stderr.write(
			`warning: could not aggregate round R${latest.summary.number} blockers: ${errorMessage(error)}\n`,
		);
	}

	const advisoryFailWarnings = latest.summary.lane_results
		.filter((result) => !result.required && result.outcome === "FAIL")
		.map((result) => `advisory lane ${result.lane_id} reported FAIL (does not affect the round verdict)`);

	const waived = loaded.journal.flatMap((event) =>
		event.type === "BLOCKER_WAIVED" && event.round === latest.summary.number
			? [{ blockerId: event.blocker_id, operator: event.operator, reason: event.reason }]
			: [],
	);

	let fingerprint: NonNullable<CycleDetail["report"]>["fingerprint"] = {
		recorded: latest.summary.subject_fingerprint.head,
	};
	try {
		const git = (dependencies.createGitExecutor ?? createGitExecutor)(loaded.cycle.target_repo.path);
		const head = await git.exec(["rev-parse", "HEAD"]);
		if (head.exitCode === 0) {
			const current = head.stdout.trim();
			fingerprint = {
				recorded: latest.summary.subject_fingerprint.head,
				current,
				match: current === latest.summary.subject_fingerprint.head,
			};
		} else {
			fingerprint = {
				recorded: latest.summary.subject_fingerprint.head,
				error: head.stderr.trim() || `git rev-parse HEAD exited ${head.exitCode}`,
			};
		}
	} catch (error) {
		fingerprint = { recorded: latest.summary.subject_fingerprint.head, error: errorMessage(error) };
	}

	return { laneVerdicts: views, blockers, advisoryFailWarnings, waived, fingerprint };
}

async function buildCycleDetail(
	loaded: LoadedReviewCycle,
	env: NodeJS.ProcessEnv,
	dependencies: ReviewCommandDependencies,
	withReport: boolean,
): Promise<CycleDetail> {
	const rounds: RoundHistoryEntry[] = loaded.rounds.map((round) => ({
		number: round.summary.number,
		status: round.summary.status,
		...(round.summary.verdict ? { verdict: round.summary.verdict } : {}),
		laneResults: round.summary.lane_results.map((result) => ({ ...result })),
	}));
	const hint = nextCommandHint(loaded.cycle.id, loaded.state);
	const detail: CycleDetail = {
		id: loaded.cycle.id,
		state: loaded.state,
		subject: loaded.cycle.subject,
		targetRepo: loaded.cycle.target_repo,
		authoringVendors: [...loaded.cycle.authoring_vendors],
		degraded: loaded.cycle.degraded,
		maxRounds: effectiveMaxRounds(loaded.cycle.max_rounds, loaded.journal),
		createdAt: loaded.cycle.created_at,
		laneSnapshot: loaded.cycle.lane_snapshot,
		rounds,
		...(hint ? { nextCommand: hint } : {}),
	};
	if (!withReport) {
		return detail;
	}
	const report = await buildReportSection(loaded, env, dependencies);
	return report ? { ...detail, report } : detail;
}

function printCycleDetail(detail: CycleDetail): void {
	if (detail.nextCommand) {
		process.stdout.write(`>>> ${detail.state}\n>>> next: ${detail.nextCommand}\n\n`);
	}
	process.stdout.write(`cycle:   ${detail.id}\n`);
	process.stdout.write(`state:   ${detail.state}\n`);
	process.stdout.write(`subject: ${describeSubject(detail.subject)}\n`);
	process.stdout.write(`repo:    ${detail.targetRepo.name} (${detail.targetRepo.path})\n`);
	if (detail.authoringVendors.length > 0) {
		process.stdout.write(`authoring vendors: ${detail.authoringVendors.join(", ")}\n`);
	}
	if (detail.degraded) {
		process.stdout.write("DEGRADED: fewer than the configured required reviewer lanes were formed\n");
	}
	process.stdout.write(`max rounds: ${detail.maxRounds}\n`);
	process.stdout.write(
		`lanes: ${detail.laneSnapshot.map((route) => `${route.id}(${route.vendor}${route.required ? "" : ",advisory"})`).join(" ")}\n`,
	);
	process.stdout.write(`rounds (${detail.rounds.length}):\n`);
	for (const round of detail.rounds) {
		process.stdout.write(`  R${round.number}  ${round.status}${round.verdict ? `  verdict=${round.verdict}` : ""}\n`);
		for (const result of round.laneResults) {
			process.stdout.write(`    ${result.lane_id}${result.required ? "" : " (advisory)"}: ${result.outcome}\n`);
		}
	}
	if (!detail.report) {
		return;
	}
	process.stdout.write("\n--- report ---\n");
	const fp = detail.report.fingerprint;
	process.stdout.write(
		`subject fingerprint: recorded=${fp.recorded}` +
			`${fp.current ? ` current=${fp.current} (${fp.match ? "MATCH" : "MISMATCH"})` : ""}` +
			`${fp.error ? ` (unavailable: ${fp.error})` : ""}\n`,
	);
	for (const warning of detail.report.advisoryFailWarnings) {
		process.stdout.write(`!!! ${warning}\n`);
	}
	if (detail.report.blockers.length > 0) {
		process.stdout.write(`blockers (${detail.report.blockers.length}):\n`);
		for (const blocker of detail.report.blockers) {
			const location = blocker.line !== undefined ? `${blocker.file}:${blocker.line}` : blocker.file;
			const endorsed = blocker.endorsements.length > 1 ? `  [${blocker.endorsements.length}x endorsed]` : "";
			process.stdout.write(
				`  ${blocker.newInIncremental ? "[NEW_IN_INCREMENTAL] " : ""}${blocker.id}  ${blocker.title} (${location})${endorsed}\n`,
			);
			process.stdout.write(`    evidence: ${blocker.evidence}\n`);
		}
	}
	if (detail.report.waived.length > 0) {
		process.stdout.write("waived:\n");
		for (const item of detail.report.waived) {
			process.stdout.write(`  ${item.blockerId}  by ${item.operator}: ${item.reason}\n`);
		}
	}
	for (const laneVerdict of detail.report.laneVerdicts) {
		process.stdout.write(`--- ${laneVerdict.laneId} verdict (raw) ---\n${laneVerdict.raw || "(unavailable)"}\n`);
		if (laneVerdict.parseError) {
			process.stdout.write(`  (parse warning: ${laneVerdict.parseError})\n`);
		}
	}
}

export async function runReviewStatus(
	options: ReviewStatusOptions,
	_cwd: string,
	dependencies: ReviewCommandDependencies = {},
): Promise<number> {
	const env = dependencies.env ?? process.env;

	if (!options.cycleId) {
		let cycles: LoadedReviewCycle[];
		try {
			cycles = await (dependencies.listCycles ?? listCycles)(env);
		} catch (error) {
			process.stderr.write(`gatekeeper review status: ${errorMessage(error)}\n`);
			return REVIEW_ATTENTION_EXIT_CODE;
		}
		const summaries = cycles.map(summarizeCycle);
		if (options.json) {
			process.stdout.write(`${JSON.stringify({ cycles: summaries }, null, 2)}\n`);
			return 0;
		}
		if (summaries.length === 0) {
			process.stdout.write("gatekeeper review status: no cycles\n");
			return 0;
		}
		for (const summary of summaries) {
			process.stdout.write(
				`${summary.id}  ${summary.state.padEnd(15)}  round=${summary.round}  ${describeSubject(summary.subject)}\n`,
			);
			if (summary.nextCommand) {
				process.stdout.write(`    -> ${summary.nextCommand}\n`);
			}
		}
		return 0;
	}

	let loaded: LoadedReviewCycle;
	try {
		loaded = await (dependencies.loadCycle ?? loadCycle)(options.cycleId, env);
	} catch (error) {
		process.stderr.write(`gatekeeper review status: ${errorMessage(error)}\n`);
		return loadFailureExitCode(error);
	}
	const detail = await buildCycleDetail(loaded, env, dependencies, options.report === true);
	if (options.json) {
		process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
		return 0;
	}
	printCycleDetail(detail);
	return 0;
}

// ---------------------------------------------------------------------------
// review logs
// ---------------------------------------------------------------------------

export interface ReviewLogsOptions {
	cycleId: string;
	round?: string;
	lane?: string;
}

async function readTail(file: string, readFile: (file: string) => Promise<string>): Promise<string> {
	try {
		const content = await readFile(file);
		return content.split("\n").slice(-LOG_TAIL_LINES).join("\n");
	} catch (error) {
		return `(unavailable: ${errorMessage(error)})`;
	}
}

export async function runReviewLogs(
	options: ReviewLogsOptions,
	_cwd: string,
	dependencies: ReviewCommandDependencies = {},
): Promise<number> {
	const env = dependencies.env ?? process.env;
	let loaded: LoadedReviewCycle;
	try {
		loaded = await (dependencies.loadCycle ?? loadCycle)(options.cycleId, env);
	} catch (error) {
		process.stderr.write(`gatekeeper review logs: ${errorMessage(error)}\n`);
		return loadFailureExitCode(error);
	}
	if (loaded.rounds.length === 0) {
		process.stderr.write(`gatekeeper review logs: ${options.cycleId} has no rounds yet\n`);
		return 2;
	}
	// Strict `R?<digits>` only -- Number.parseInt tolerates (and silently ignores) trailing garbage like "R2x", which
	// must not resolve to round 2.
	if (options.round !== undefined && !/^R?\d+$/i.test(options.round)) {
		process.stderr.write(`gatekeeper review logs: ${options.cycleId} has no round ${options.round}\n`);
		return 2;
	}
	const roundNumber = options.round ? Number.parseInt(options.round.replace(/^R/i, ""), 10) : loaded.rounds.length;
	const round = loaded.rounds.find((entry) => entry.summary.number === roundNumber);
	if (!round) {
		process.stderr.write(`gatekeeper review logs: ${options.cycleId} has no round R${options.round ?? roundNumber}\n`);
		return 2;
	}
	const lanes = options.lane ? round.lanes.filter((lane) => lane.id === options.lane) : round.lanes;
	if (options.lane && lanes.length === 0) {
		process.stderr.write(`gatekeeper review logs: R${roundNumber} has no lane ${options.lane}\n`);
		return 2;
	}
	const cycleDirectory = reviewCycleDirectory(options.cycleId, env);
	const readFile = dependencies.readFile ?? defaultReadFile;
	for (const lane of lanes) {
		process.stdout.write(
			`${lane.id}  ${lane.cli}(${lane.vendor})${lane.required ? "" : " advisory"}  ${lane.outcome ?? lane.status}\n`,
		);
		const briefPath = path.join(cycleDirectory, lane.brief_path);
		const stdoutPath = path.join(cycleDirectory, lane.stdout_path);
		const stderrPath = path.join(cycleDirectory, lane.stderr_path);
		const resultPath = path.join(cycleDirectory, lane.result_path);
		process.stdout.write(`  brief:  ${briefPath}\n`);
		process.stdout.write(`  stdout: ${stdoutPath}\n`);
		process.stdout.write(`  stderr: ${stderrPath}\n`);
		process.stdout.write(`  out:    ${resultPath}\n`);
		process.stdout.write("  --- stdout (tail) ---\n");
		process.stdout.write(`${await readTail(stdoutPath, readFile)}\n`);
		process.stdout.write("  --- stderr (tail) ---\n");
		process.stdout.write(`${await readTail(stderrPath, readFile)}\n\n`);
	}
	return 0;
}

// ---------------------------------------------------------------------------
// review fix
// ---------------------------------------------------------------------------

export interface ReviewFixOptions {
	cycleId: string;
	waive?: string[];
	adopt?: string[];
	yes?: boolean;
}

export async function runReviewFix(
	options: ReviewFixOptions,
	_cwd: string,
	dependencies: ReviewCommandDependencies = {},
): Promise<number> {
	const env = dependencies.env ?? process.env;
	let loaded: LoadedReviewCycle;
	try {
		loaded = await (dependencies.loadCycle ?? loadCycle)(options.cycleId, env);
	} catch (error) {
		process.stderr.write(`gatekeeper review fix: ${errorMessage(error)}\n`);
		return loadFailureExitCode(error);
	}
	if (loaded.state !== "BLOCKED" && loaded.state !== "AWAITING_ACCEPT") {
		process.stderr.write(
			`gatekeeper review fix: cycle ${options.cycleId} is ${loaded.state}; fix only applies to BLOCKED ` +
				"(waive/adopt) or AWAITING_ACCEPT (adopt only)\n",
		);
		return 2;
	}

	const waivedIds: string[] = [];
	const waiverReasons: Record<string, string> = {};
	for (const raw of options.waive ?? []) {
		const separator = raw.indexOf("=");
		if (separator <= 0 || separator === raw.length - 1) {
			process.stderr.write(
				`gatekeeper review fix: --waive ${raw} must be "<blocker-id>=<reason>" with a non-empty reason\n`,
			);
			return 2;
		}
		const id = raw.slice(0, separator);
		const reason = raw.slice(separator + 1);
		waivedIds.push(id);
		waiverReasons[id] = reason;
	}
	if (loaded.state === "AWAITING_ACCEPT" && waivedIds.length > 0) {
		process.stderr.write(
			"gatekeeper review fix: AWAITING_ACCEPT advisory fixes cannot waive blockers (only --adopt)\n",
		);
		return 2;
	}
	const adoptedIds = options.adopt ?? [];

	process.stdout.write(
		`gatekeeper review fix: cycle ${options.cycleId} -- waiving ${waivedIds.length}, adopting ${adoptedIds.length}\n`,
	);

	let proceed = options.yes === true;
	if (!proceed) {
		const isTTY = dependencies.isInteractive ?? process.stdin.isTTY === true;
		if (!isTTY) {
			process.stderr.write(
				"gatekeeper review fix: not an interactive TTY; re-run with --yes to confirm dispatching a fix non-interactively\n",
			);
			return 2;
		}
		proceed = await (dependencies.promptConfirm ?? defaultPromptConfirm)(
			"Dispatch fix and run the next review round? [y/N] ",
		);
	}
	if (!proceed) {
		process.stdout.write("gatekeeper review fix: aborted (not confirmed)\n");
		return 0;
	}

	let supervisorDeps: ReviewSupervisorDependencies;
	try {
		supervisorDeps = await buildSupervisorDependencies(loaded.cycle, dependencies);
	} catch (error) {
		process.stderr.write(
			`gatekeeper review fix: could not assemble review supervision context: ${errorMessage(error)}\n`,
		);
		return REVIEW_ATTENTION_EXIT_CODE;
	}
	// Two-phase banner (T-20260721-02 design 裁决未决 2's mitigation): fix dispatch/supervision, then the automatic
	// incremental review round -- printed off the supervisor's own journal-append seam so the banner lands exactly
	// when each phase actually starts, not just when the CLI issued the call.
	const priorAfterJournal = supervisorDeps.afterJournal;
	const wrappedDeps: ReviewSupervisorDependencies = {
		...supervisorDeps,
		async afterJournal(event: ReviewJournalEvent) {
			if (event.type === "FIX_DISPATCHED") {
				process.stdout.write("=== phase 1 complete: fix dispatched -- supervising the original coding agent ===\n");
			}
			if (event.type === "ROUND_STARTED" && event.from === "FIXING") {
				process.stdout.write(`=== phase 2: incremental review round ${event.round} ===\n`);
			}
			await priorAfterJournal?.(event);
		},
	};

	let result: ReviewSupervisionResult;
	try {
		result = await (dependencies.reviewFix ?? reviewFix)(loaded, waivedIds, adoptedIds, wrappedDeps, {
			operator: await resolveOperator(loaded.cycle.target_repo.path, dependencies),
			waiverReasons,
		});
	} catch (error) {
		const exitCode =
			error instanceof ReviewAggregateError ||
			(error instanceof ReviewSupervisorError && error.code === "FIX_CONTEXT_REQUIRED")
				? 2
				: REVIEW_ATTENTION_EXIT_CODE;
		process.stderr.write(`gatekeeper review fix: ${errorMessage(error)}\n`);
		return exitCode;
	}
	printSupervisionResult("gatekeeper review fix", result);
	process.stdout.write(
		"(interrupted? run `gatekeeper review resume <cycle-id>` to continue from the last durable checkpoint)\n",
	);
	return exitCodeForState(result.state);
}

// ---------------------------------------------------------------------------
// review accept
// ---------------------------------------------------------------------------

export interface ReviewAcceptOptions {
	cycleId: string;
	note?: string;
}

export async function runReviewAccept(
	options: ReviewAcceptOptions,
	_cwd: string,
	dependencies: ReviewCommandDependencies = {},
): Promise<number> {
	const env = dependencies.env ?? process.env;
	let lock: Pick<ReviewSupervisorLock, "release">;
	try {
		lock = await (dependencies.acquireReviewSupervisorLock ?? acquireReviewSupervisorLock)(options.cycleId, { env });
	} catch (error) {
		process.stderr.write(`gatekeeper review accept: ${errorMessage(error)}\n`);
		return lockFailureExitCode(error);
	}
	try {
		const fresh = await (dependencies.loadCycle ?? loadCycle)(options.cycleId, env);
		if (fresh.state !== "AWAITING_ACCEPT" && fresh.state !== "ARBITRATION") {
			process.stderr.write(
				`gatekeeper review accept: cycle ${options.cycleId} is ${fresh.state}; accept only applies to AWAITING_ACCEPT or ARBITRATION\n`,
			);
			return 2;
		}
		const now = dependencies.now ?? (() => new Date());
		const operator = await resolveOperator(fresh.cycle.target_repo.path, dependencies);
		const event: ReviewJournalEvent = {
			apiVersion: "gatekeeper/v1",
			type: "CYCLE_ACCEPTED",
			cycle_id: options.cycleId,
			at: now().toISOString(),
			operator,
			...(options.note && options.note.length > 0 ? { note: options.note } : {}),
			from: fresh.state,
			to: "ACCEPTED",
		};
		await (dependencies.appendJournalEvent ?? appendJournalEvent)(options.cycleId, event, env);
		await appendReviewLedgerEntry(fresh, "ACCEPTED", operator, options.note, dependencies);
		process.stdout.write(`gatekeeper review accept: cycle ${options.cycleId} -> ACCEPTED\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`gatekeeper review accept: ${errorMessage(error)}\n`);
		return REVIEW_ATTENTION_EXIT_CODE;
	} finally {
		await releaseLockSafely(lock, "gatekeeper review accept");
	}
}

// ---------------------------------------------------------------------------
// review arbitrate
// ---------------------------------------------------------------------------

export interface ReviewArbitrateOptions {
	cycleId: string;
	decision: "accept" | "abandon" | "extend";
	reason: string;
}

type ArbitrateOutcome =
	| { kind: "invalid"; state: ReviewCycleState }
	| { kind: "accepted" }
	| { kind: "abandoned" }
	| { kind: "extend" };

export async function runReviewArbitrate(
	options: ReviewArbitrateOptions,
	_cwd: string,
	dependencies: ReviewCommandDependencies = {},
): Promise<number> {
	const env = dependencies.env ?? process.env;
	if (options.reason.trim().length === 0) {
		process.stderr.write("gatekeeper review arbitrate: --reason must not be empty\n");
		return 2;
	}

	let lock: Pick<ReviewSupervisorLock, "release">;
	try {
		lock = await (dependencies.acquireReviewSupervisorLock ?? acquireReviewSupervisorLock)(options.cycleId, { env });
	} catch (error) {
		process.stderr.write(`gatekeeper review arbitrate: ${errorMessage(error)}\n`);
		return lockFailureExitCode(error);
	}

	let outcome: ArbitrateOutcome;
	try {
		const fresh = await (dependencies.loadCycle ?? loadCycle)(options.cycleId, env);
		if (fresh.state !== "ARBITRATION") {
			outcome = { kind: "invalid", state: fresh.state };
		} else {
			const now = dependencies.now ?? (() => new Date());
			const operator = await resolveOperator(fresh.cycle.target_repo.path, dependencies);
			const append = dependencies.appendJournalEvent ?? appendJournalEvent;
			if (options.decision === "accept") {
				await append(
					options.cycleId,
					{
						apiVersion: "gatekeeper/v1",
						type: "CYCLE_ACCEPTED",
						cycle_id: options.cycleId,
						at: now().toISOString(),
						operator,
						note: options.reason,
						from: "ARBITRATION",
						to: "ACCEPTED",
					},
					env,
				);
				await appendReviewLedgerEntry(fresh, "ACCEPTED", operator, options.reason, dependencies);
				outcome = { kind: "accepted" };
			} else if (options.decision === "abandon") {
				await append(
					options.cycleId,
					{
						apiVersion: "gatekeeper/v1",
						type: "CYCLE_CANCELLED",
						cycle_id: options.cycleId,
						at: now().toISOString(),
						operator,
						reason: options.reason,
						from: "ARBITRATION",
						to: "ABANDONED",
					},
					env,
				);
				await appendReviewLedgerEntry(fresh, "ABANDONED", operator, options.reason, dependencies);
				outcome = { kind: "abandoned" };
			} else {
				const previousMax = effectiveMaxRounds(fresh.cycle.max_rounds, fresh.journal);
				const nextMax = extendRoundLimit(previousMax);
				const lastRound = currentRoundNumber(fresh.journal);
				await append(
					options.cycleId,
					{
						apiVersion: "gatekeeper/v1",
						type: "ROUND_STARTED",
						cycle_id: options.cycleId,
						at: now().toISOString(),
						round: lastRound + 1,
						from: "ARBITRATION",
						to: "REVIEWING",
						previous_max_rounds: previousMax,
						max_rounds: nextMax,
						extension_reason: options.reason,
					},
					env,
				);
				outcome = { kind: "extend" };
			}
		}
	} catch (error) {
		process.stderr.write(`gatekeeper review arbitrate: ${errorMessage(error)}\n`);
		return REVIEW_ATTENTION_EXIT_CODE;
	} finally {
		await releaseLockSafely(lock, "gatekeeper review arbitrate");
	}

	if (outcome.kind === "invalid") {
		process.stderr.write(
			`gatekeeper review arbitrate: cycle ${options.cycleId} is ${outcome.state}; arbitrate only applies to ARBITRATION\n`,
		);
		return 2;
	}
	if (outcome.kind === "accepted") {
		process.stdout.write(`gatekeeper review arbitrate: cycle ${options.cycleId} -> ACCEPTED\n`);
		return 0;
	}
	if (outcome.kind === "abandoned") {
		process.stdout.write(`gatekeeper review arbitrate: cycle ${options.cycleId} -> ABANDONED\n`);
		return REVIEW_ATTENTION_EXIT_CODE;
	}

	// extend: the lock above is already released; drive the freshly-extended round the same way `resume` would.
	let result: ReviewSupervisionResult;
	try {
		result = await driveCycle(options.cycleId, dependencies, {});
	} catch (error) {
		process.stderr.write(`gatekeeper review arbitrate: review supervision faulted: ${errorMessage(error)}\n`);
		return REVIEW_ATTENTION_EXIT_CODE;
	}
	printSupervisionResult("gatekeeper review arbitrate", result);
	return exitCodeForState(result.state);
}

// ---------------------------------------------------------------------------
// review resume
// ---------------------------------------------------------------------------

export interface ReviewResumeOptions {
	cycleId: string;
}

export async function runReviewResume(
	options: ReviewResumeOptions,
	_cwd: string,
	dependencies: ReviewCommandDependencies = {},
): Promise<number> {
	const env = dependencies.env ?? process.env;
	let loaded: LoadedReviewCycle;
	try {
		loaded = await (dependencies.loadCycle ?? loadCycle)(options.cycleId, env);
	} catch (error) {
		process.stderr.write(`gatekeeper review resume: ${errorMessage(error)}\n`);
		return loadFailureExitCode(error);
	}
	if (loaded.state === "ACCEPTED" || loaded.state === "ABANDONED") {
		process.stdout.write(
			`gatekeeper review resume: cycle ${options.cycleId} is already terminal (${loaded.state}); nothing to resume\n`,
		);
		return loaded.state === "ACCEPTED" ? 0 : REVIEW_ATTENTION_EXIT_CODE;
	}
	let result: ReviewSupervisionResult;
	try {
		result = await driveCycle(options.cycleId, dependencies, {});
	} catch (error) {
		process.stderr.write(`gatekeeper review resume: review supervision faulted: ${errorMessage(error)}\n`);
		return REVIEW_ATTENTION_EXIT_CODE;
	}
	printSupervisionResult("gatekeeper review resume", result);
	return exitCodeForState(result.state);
}

// ---------------------------------------------------------------------------
// review cancel
// ---------------------------------------------------------------------------

export interface ReviewCancelOptions {
	cycleId: string;
}

const PENDING_CANCEL_MESSAGE =
	"is PENDING (never started); the review state machine has no PENDING -> ABANDONED transition (T-20260721-02 " +
	"design §3: PENDING 无 cancel 边). Run `gatekeeper review start` first, or delete its cycle directory manually " +
	"if it must be discarded before starting.";

export async function runReviewCancel(
	options: ReviewCancelOptions,
	_cwd: string,
	dependencies: ReviewCommandDependencies = {},
): Promise<number> {
	const env = dependencies.env ?? process.env;
	let loaded: LoadedReviewCycle;
	try {
		loaded = await (dependencies.loadCycle ?? loadCycle)(options.cycleId, env);
	} catch (error) {
		process.stderr.write(`gatekeeper review cancel: ${errorMessage(error)}\n`);
		return loadFailureExitCode(error);
	}
	if (loaded.state === "ACCEPTED" || loaded.state === "ABANDONED") {
		process.stdout.write(
			`gatekeeper review cancel: cycle ${options.cycleId} is already terminal (${loaded.state}); nothing to cancel\n`,
		);
		return 0;
	}
	if (loaded.state === "PENDING") {
		process.stderr.write(`gatekeeper review cancel: cycle ${options.cycleId} ${PENDING_CANCEL_MESSAGE}\n`);
		return 2;
	}

	let lock: Pick<ReviewSupervisorLock, "release">;
	try {
		lock = await (dependencies.acquireReviewSupervisorLock ?? acquireReviewSupervisorLock)(options.cycleId, { env });
	} catch (error) {
		process.stderr.write(`gatekeeper review cancel: ${errorMessage(error)}\n`);
		return lockFailureExitCode(error);
	}
	try {
		const fresh = await (dependencies.loadCycle ?? loadCycle)(options.cycleId, env);
		if (fresh.state === "ACCEPTED" || fresh.state === "ABANDONED") {
			process.stdout.write(
				`gatekeeper review cancel: cycle ${options.cycleId} is already terminal (${fresh.state}); nothing to cancel\n`,
			);
			return 0;
		}
		if (fresh.state === "PENDING") {
			process.stderr.write(`gatekeeper review cancel: cycle ${options.cycleId} ${PENDING_CANCEL_MESSAGE}\n`);
			return 2;
		}
		const now = dependencies.now ?? (() => new Date());
		const operator = await resolveOperator(fresh.cycle.target_repo.path, dependencies);
		await (dependencies.appendJournalEvent ?? appendJournalEvent)(
			options.cycleId,
			{
				apiVersion: "gatekeeper/v1",
				type: "CYCLE_CANCELLED",
				cycle_id: options.cycleId,
				at: now().toISOString(),
				operator,
				reason: "cancelled via gatekeeper review cancel",
				from: fresh.state,
				to: "ABANDONED",
			},
			env,
		);
		await appendReviewLedgerEntry(fresh, "ABANDONED", operator, undefined, dependencies);
		process.stdout.write(`gatekeeper review cancel: cycle ${options.cycleId} -> ABANDONED\n`);
		return REVIEW_ATTENTION_EXIT_CODE;
	} catch (error) {
		process.stderr.write(`gatekeeper review cancel: ${errorMessage(error)}\n`);
		return REVIEW_ATTENTION_EXIT_CODE;
	} finally {
		await releaseLockSafely(lock, "gatekeeper review cancel");
	}
}

// ---------------------------------------------------------------------------
// review render
// ---------------------------------------------------------------------------

export interface ReviewRenderOptions {
	cycleId: string;
	format: string;
}

async function renderReviewCommentBody(
	loaded: LoadedReviewCycle,
	dependencies: ReviewCommandDependencies,
): Promise<string> {
	const lines: string[] = [REVIEW_RENDER_MARKER, "", `## Gatekeeper Review · ${loaded.state}`, ""];
	lines.push(`cycle: ${loaded.cycle.id}`);
	lines.push(`subject: ${describeSubject(loaded.cycle.subject)}`);
	lines.push(`repo: ${loaded.cycle.target_repo.name}`);
	if (loaded.cycle.authoring_vendors.length > 0) {
		lines.push(`authoring vendors: ${loaded.cycle.authoring_vendors.join(", ")}`);
	}
	if (loaded.cycle.degraded) {
		lines.push("DEGRADED cycle");
	}
	lines.push("", "### 轮次", "", "| Round | 状态 | 判定 |", "| --- | --- | --- |");
	for (const round of loaded.rounds) {
		lines.push(`| R${round.summary.number} | ${round.summary.status} | ${round.summary.verdict ?? "-"} |`);
	}
	const latest = loaded.rounds.at(-1);
	if (latest) {
		lines.push("", "### Lanes（最新一轮）", "", "| Lane | 必需 | 判定 |", "| --- | --- | --- |");
		for (const result of latest.summary.lane_results) {
			lines.push(`| ${result.lane_id} | ${result.required ? "是" : "否（advisory）"} | ${result.outcome} |`);
		}
	}
	const waived = loaded.journal.flatMap((event) =>
		event.type === "BLOCKER_WAIVED" ? [`${event.blocker_id}（${event.operator}: ${event.reason}）`] : [],
	);
	if (waived.length > 0) {
		lines.push("", "### 已 waive", "", ...waived.map((line) => `- ${line}`));
	}
	lines.push("", `<!-- generated: ${(dependencies.now ?? (() => new Date()))().toISOString()} -->`);
	return `${lines.join("\n")}\n`;
}

export async function runReviewRender(
	options: ReviewRenderOptions,
	_cwd: string,
	dependencies: ReviewCommandDependencies = {},
): Promise<number> {
	if (options.format !== "comment") {
		process.stderr.write(
			`gatekeeper review render: unsupported --format ${options.format} (only "comment" is supported)\n`,
		);
		return 2;
	}
	const env = dependencies.env ?? process.env;
	let loaded: LoadedReviewCycle;
	try {
		loaded = await (dependencies.loadCycle ?? loadCycle)(options.cycleId, env);
	} catch (error) {
		process.stderr.write(`gatekeeper review render: ${errorMessage(error)}\n`);
		return loadFailureExitCode(error);
	}
	process.stdout.write(await renderReviewCommentBody(loaded, dependencies));
	return 0;
}

// Re-exported so tests/other layers can recognize the failure classes this module surfaces without importing every
// underlying review/* module directly (same convention as src/commands/dispatch.ts's own re-export block).
export { ReviewAggregateError, ReviewLockError, ReviewStoreError, ReviewSupervisorError };
