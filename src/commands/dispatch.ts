import { execFile as execFileCallback } from "node:child_process";
import { randomUUID as nodeRandomUUID } from "node:crypto";
import { appendFile, readFile as fsReadFile, realpath as fsRealpath, mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { type DetectedAgentCli, detectAgentClis } from "../agent/detect.js";
import { resolveAgentCommand } from "../agent/resolve.js";
import {
	ConfigDiscoveryError,
	type DiscoveredConfig,
	discoverConfig,
	discoverConfigWithControlsIndex,
	missingRegistryMessage,
	resolveConfiguredField,
	resolveRegistryOption,
} from "../config/discover.js";
import { loadRepos, type RepoEntry, ReposFileError } from "../config/repos.js";
import type { GitExecutionResult, GitExecutor } from "../dispatch/evidence.js";
import { acquireSupervisorLock, DispatchLockError } from "../dispatch/lock.js";
import { DispatchTransitionError } from "../dispatch/machine.js";
import {
	appendJournalEvent,
	createOrder,
	DispatchStoreError,
	dispatchOrderDirectory,
	type LoadedWorkOrder,
	listOrders,
	loadOrder,
} from "../dispatch/store.js";
import {
	DISPATCH_TOTAL_RUN_CAP,
	DispatchSupervisorError,
	type OrphanAction,
	type ReviewerConflictWarning,
	resolveDispatchMaxRunSeconds,
	reviewerConflictWarning,
	type SuperviseWorkOrderInput,
	type SupervisionResult,
	superviseWorkOrder,
} from "../dispatch/supervisor.js";
import type { JournalEvent, Run, WorkOrder, WorkOrderStatus } from "../dispatch/types.js";
import { DispatchWorkspaceError } from "../dispatch/workspace.js";
import { GitDiffError, resolveBaseRef, resolveRepo } from "../providers/gitdiff.js";
import { GitHubProvider, type GitHubProviderOptions, InfraError } from "../providers/github.js";
import {
	type DispatchBriefIssueInput,
	type DispatchBriefTriageSummary,
	renderDispatchBrief,
} from "../render/dispatchBrief.js";
import { loadRolesPolicy, resolveRolesPolicyPath, vendorOfModelId } from "../roles/policy.js";

/**
 * `gatekeeper dispatch`: the CLI face of the local execution supervisor
 * (src/dispatch/*). This module is the only place the five subcommands
 * (start/status/logs/resume/cancel) are implemented -- src/cli.ts only
 * registers commander options and forwards to the functions below. Zero-model
 * invariant holds throughout: every decision here is either a direct
 * pass-through of a human flag or a deterministic read of already-persisted
 * dispatch state.
 *
 * Exit code convention (dispatch is a supervisor, not a gate -- see
 * docs/PLAN.md / T-20260719-10 design's §0 "report and stop", not fail-open):
 *   0 -- normal flow (including a DELIVERED terminal outcome).
 *   2 -- user/config error (bad flags, unregistered repo, missing files, an
 *        order id that does not exist, a state transition the CLI itself
 *        refuses because src/dispatch/ has no journal edge for it).
 *   DISPATCH_ATTENTION_EXIT_CODE (3) -- dispatch's own report-and-stop
 *        outcome: a non-DELIVERED terminal/report supervision result
 *        (NEEDS_ATTENTION, WAITING_COOLDOWN, ABANDONED, an unresolved
 *        orphan), or an infrastructure fault raised by src/dispatch/*
 *        (DispatchSupervisorError, DispatchLockError, DispatchWorkspaceError,
 *        DispatchTransitionError) while supervision was already under way.
 *   Exit code 1 is never used here -- it is reserved for `gatekeeper gate`'s
 *   block verdict (see CLAUDE.md's fail-direction law).
 */

export const DISPATCH_ATTENTION_EXIT_CODE = 3;

const TERMINAL_STATES = new Set<WorkOrderStatus>(["DELIVERED", "ABANDONED"]);
const DEFAULT_RESULT_PATH = "out/RESULT.json";
const DEFAULT_PROGRESS_PATH = "out/PROGRESS.md";
const LOG_TAIL_LINES = 50;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

type Candidate = WorkOrder["candidate_ladder"][number];
type IssueProvider = Pick<GitHubProvider, "getIssue">;

export interface DispatchCommandDependencies {
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
	/** Entropy source for `start`'s ad-hoc association-key suffix (T-20260721-01) -- a test seam mirroring
	 * src/dispatch/store.ts's own `randomUUID` dependency, unrelated to that module's order-id generation. */
	randomUUID?: () => string;
	isInteractive?: boolean;
	promptConfirm?: (message: string) => Promise<boolean>;
	readFile?: (file: string) => Promise<string>;
	realpath?: (target: string) => Promise<string>;
	createProvider?: (options: GitHubProviderOptions) => IssueProvider;
	detectAgentClis?: typeof detectAgentClis;
	loadRolesPolicy?: typeof loadRolesPolicy;
	createGitExecutor?: (targetRepoPath: string) => GitExecutor;
	supervise?: typeof superviseWorkOrder;
	createOrder?: typeof createOrder;
	loadOrder?: typeof loadOrder;
	listOrders?: typeof listOrders;
	appendJournalEvent?: typeof appendJournalEvent;
	acquireSupervisorLock?: typeof acquireSupervisorLock;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
	return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function defaultReadFile(file: string): Promise<string> {
	return fsReadFile(file, "utf8");
}

/** Default `--run-timeout`-less resume confirmation prompt: a plain readline y/N question, same posture as triage --run's. */
async function defaultPromptConfirm(message: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(message);
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

/** The only place dispatch shells out to git -- scoped to one target repo's local checkout, mirroring src/providers/gitdiff.ts's execGit. */
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

/**
 * Best-effort dispatch-branch base ref resolution, shared by start/resume/
 * cancel: `.gatekeeper.yml`'s `base:` (searched from the *target repo's own
 * checkout*, not the invoking cwd -- resume/cancel may run from a hub), then
 * auto-detected main/master. Falling back to the literal `"HEAD"` on any
 * resolution failure is safe for every already-started order: once a run has
 * happened, src/dispatch/supervisor.ts freezes the base commit OID in a
 * sidecar file and never re-resolves `input.baseRef` again (see
 * superviseWorkOrder's own doc comment) -- this fallback only has any real
 * effect for a still-PENDING order being resumed with no configured base and
 * no main/master branch, an edge case that surfaces its own clear
 * DispatchWorkspaceError (BASE_NOT_FOUND) instead of silently doing nothing.
 */
async function resolveOrderBaseRef(targetRepoPath: string): Promise<string> {
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

// ---------------------------------------------------------------------------
// Candidate ladder resolution (issue-mode / default path only -- an explicit
// --agent-command degrades the ladder to a single item per T-20260719-10
// design §8).
// ---------------------------------------------------------------------------

/** The vendor preference order for the coder tier, deduplicated while preserving order. Mirrors src/agent/assign.ts's preferredVendorOrder, duplicated locally rather than exporting it from that module for this one call site. */
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

interface CandidateLadderResult {
	candidates: Candidate[];
	warnings: string[];
}

/**
 * Snapshot the full candidate ladder at order-creation time (detect + the
 * coder tier's prefer order) -- T-20260719-10 design §1's "冻结快照", picked
 * up unchanged for the whole order's lifetime by src/dispatch/supervisor.ts.
 * An explicit --agent-command collapses the ladder to one custom item and
 * skips detection/roles-policy entirely.
 */
async function resolveCandidateLadder(
	cwd: string,
	agentCommand: string | undefined,
	dependencies: DispatchCommandDependencies,
): Promise<CandidateLadderResult> {
	if (agentCommand) {
		return { candidates: [{ cli: "agent-command", vendor: "custom", command: agentCommand }], warnings: [] };
	}
	const env = dependencies.env ?? process.env;
	const detect = dependencies.detectAgentClis ?? detectAgentClis;
	const loadPolicy = dependencies.loadRolesPolicy ?? loadRolesPolicy;
	const warnings: string[] = [];
	const detected = await detect({ env });
	const eligible = detected.filter((cli) => cli.tiers.includes("coder"));

	let preferredVendors: string[] = [];
	try {
		const policy = await loadPolicy(resolveRolesPolicyPath(cwd));
		const coderTier = policy.tiers.coder;
		if (coderTier) {
			preferredVendors = preferredVendorOrder(coderTier.prefer);
		} else {
			warnings.push('roles-policy has no "coder" tier configured; candidate ladder falls back to detection order');
		}
	} catch (error) {
		warnings.push(
			`failed to load roles-policy for candidate ladder ordering (falling back to detection order): ${errorMessage(error)}`,
		);
	}

	const ordered = preferredVendors.length > 0 ? orderByVendor(eligible, preferredVendors) : eligible;
	const candidates: Candidate[] = ordered.map((cli) => ({
		cli: cli.name,
		vendor: cli.vendor,
		command: cli.commandTemplate,
	}));
	return { candidates, warnings };
}

// ---------------------------------------------------------------------------
// Issue-mode brief synthesis (--brief overrides this entirely)
// ---------------------------------------------------------------------------

interface ParsedTriageLedgerLine extends DispatchBriefTriageSummary {
	key: string;
}

function isPlausibleTriageLedgerLine(value: unknown): value is ParsedTriageLedgerLine {
	if (!isRecord(value) || value.kind !== "triage") {
		return false;
	}
	if (
		value.acceptance_criteria !== undefined &&
		!(Array.isArray(value.acceptance_criteria) && value.acceptance_criteria.every((item) => typeof item === "string"))
	) {
		return false;
	}
	return (
		typeof value.key === "string" &&
		typeof value.decision === "string" &&
		typeof value.reason_summary === "string" &&
		typeof value.suggested_level === "string" &&
		typeof value.at === "string" &&
		isRecord(value.dispatch) &&
		typeof value.dispatch.coder === "string" &&
		Array.isArray(value.dispatch.reviewers) &&
		value.dispatch.reviewers.every((reviewer) => typeof reviewer === "string")
	);
}

/** Repo-relative, portable label for the triage ledger -- see findLatestTriageLedgerEntry's doc comment for why this, not the real absolute path, is what ends up inside triageLedgerWarning. */
const TRIAGE_LEDGER_RELATIVE_PATH = ".gatekeeper/triage-ledger.jsonl";

/**
 * `gatekeeper dispatch start --issue N` (no --brief) synthesizes its brief
 * from the triage ledger's verdict for the same `org/repo#issue` association
 * key. **The same issue may have been triaged more than once** (re-triage
 * after new information, a corrected verdict, ...) -- src/commands/triage.ts
 * appends, it never rewrites a prior line, so the ledger can contain several
 * lines sharing one `key`. Per T-20260719-10 design's decision #2, this
 * reads the file front-to-back and keeps overwriting `match` on every
 * further hit, so **the last matching line wins**, not the first. A missing
 * ledger file is the ordinary "no triage ledger for this repo yet" case, not
 * an error. Malformed lines (bad JSON, or JSON missing the fields the
 * dispatch brief needs) are skipped, not fatal -- this lookup is best-effort
 * context, never a hard dependency for `dispatch start`.
 *
 * The returned `warning` string is not just a local stderr diagnostic --
 * `synthesizeIssueBrief` also embeds it verbatim into `triageLedgerWarning`,
 * which `renderDispatchBrief` writes into the brief handed to whichever
 * coding-agent CLI ends up running (possibly on a different machine's
 * checkout than this one). It therefore uses `ledgerPath`'s portable,
 * repo-relative form (`TRIAGE_LEDGER_RELATIVE_PATH`) rather than the real
 * absolute `ledgerPath` this function reads from -- same "never leak a local
 * filesystem path into content a remote reader consumes" posture as
 * src/commands/triage.ts's resolveCodeReviewerCardPath.
 */
async function findLatestTriageLedgerEntry(
	ledgerPath: string,
	key: string,
	readFile: (file: string) => Promise<string>,
): Promise<{ entry?: ParsedTriageLedgerLine; warning?: string }> {
	let raw: string;
	try {
		raw = await readFile(ledgerPath);
	} catch (error) {
		if (isMissingPathError(error)) {
			return {};
		}
		return { warning: `could not read triage ledger ${TRIAGE_LEDGER_RELATIVE_PATH}: ${errorMessage(error)}` };
	}

	let match: ParsedTriageLedgerLine | undefined;
	let malformed = 0;
	for (const line of raw.split("\n")) {
		if (line.length === 0) {
			continue;
		}
		try {
			const value: unknown = JSON.parse(line);
			if (isPlausibleTriageLedgerLine(value) && value.key === key) {
				match = value;
			}
		} catch {
			malformed += 1;
		}
	}
	if (match) {
		return { entry: match };
	}
	return malformed > 0
		? {
				warning: `triage ledger ${TRIAGE_LEDGER_RELATIVE_PATH} has ${malformed} malformed line(s); no valid entry found for ${key}`,
			}
		: {};
}

interface SynthesizedBrief {
	brief: string;
	criteria: string[];
}

async function synthesizeIssueBrief(
	issueNumber: number,
	key: string,
	repo: string,
	targetRepoPath: string,
	contract: { resultPath: string; progressPath: string },
	dependencies: DispatchCommandDependencies,
): Promise<SynthesizedBrief | { exitCode: number }> {
	let provider: IssueProvider;
	try {
		provider = (dependencies.createProvider ?? ((options) => new GitHubProvider(options)))({ repo });
	} catch (error) {
		if (!(error instanceof InfraError)) {
			throw error;
		}
		process.stderr.write(`gatekeeper dispatch start: ${error.reason}\n`);
		return { exitCode: 2 };
	}

	let issueInput: DispatchBriefIssueInput | null = null;
	let issueFetchWarning: string | undefined;
	try {
		const issue = await provider.getIssue(issueNumber);
		issueInput = {
			number: issue.number,
			title: issue.title,
			body: issue.body,
			author: issue.user?.login ?? null,
			labels: issue.labels.map((label) => label.name),
			...(issue.html_url ? { url: issue.html_url } : {}),
		};
	} catch (error) {
		if (!(error instanceof InfraError)) {
			throw error;
		}
		issueFetchWarning = error.reason;
		process.stderr.write(`warning: 无法读取 issue ${key}: ${error.reason}（简报仍会生成，缺少 issue 正文）\n`);
	}

	const readFile = dependencies.readFile ?? defaultReadFile;
	const ledgerPath = path.join(targetRepoPath, ".gatekeeper", "triage-ledger.jsonl");
	const { entry: triageEntry, warning: ledgerWarning } = await findLatestTriageLedgerEntry(ledgerPath, key, readFile);
	if (ledgerWarning) {
		process.stderr.write(`warning: ${ledgerWarning}\n`);
	}

	const brief = renderDispatchBrief({
		key,
		repo,
		issue: issueInput,
		...(issueFetchWarning ? { issueFetchWarning } : {}),
		...(triageEntry
			? {
					triage: {
						decision: triageEntry.decision,
						reason_summary: triageEntry.reason_summary,
						suggested_level: triageEntry.suggested_level,
						dispatch: triageEntry.dispatch,
						...(triageEntry.acceptance_criteria ? { acceptance_criteria: triageEntry.acceptance_criteria } : {}),
						at: triageEntry.at,
					},
				}
			: {}),
		...(!triageEntry && ledgerWarning ? { triageLedgerWarning: ledgerWarning } : {}),
		contract,
	});
	return { brief, criteria: triageEntry?.acceptance_criteria ?? [] };
}

// ---------------------------------------------------------------------------
// Shared supervision + ledger plumbing
// ---------------------------------------------------------------------------

interface DispatchLedgerEntry {
	schema_version: 1;
	kind: "dispatch";
	key: string;
	order_id: string;
	outcome: "DELIVERED" | "ABANDONED";
	runs: { id: string; cli: string; vendor: string; outcome: string | null }[];
	authoring_vendors: string[];
	at: string;
}

/**
 * `<target repo>/.gatekeeper/dispatch-ledger.jsonl`, one line per order
 * termination -- T-20260719-10 design §3's "台账衔接". Rooted at the target
 * repo's own checkout (not the invoking cwd) so the ledger stays put
 * regardless of whether `start`/`resume`/`cancel` happened to run from a hub
 * checkout naming a sibling repo via --repo; the design text's literal
 * `<cwd>` is ambiguous across those call sites, and this choice keeps one
 * ledger per repo regardless of where the command was invoked from. A write
 * failure here is fail-open (warning, not a command failure) -- same
 * posture as src/commands/triage.ts's own local ledger write.
 */
async function appendDispatchLedgerEntry(
	targetRepoPath: string,
	key: string,
	outcome: { orderId: string; state: WorkOrderStatus; runs: readonly Run[]; authoringVendors: readonly string[] },
	dependencies: DispatchCommandDependencies,
): Promise<void> {
	const entry: DispatchLedgerEntry = {
		schema_version: 1,
		kind: "dispatch",
		key,
		order_id: outcome.orderId,
		outcome: outcome.state === "DELIVERED" ? "DELIVERED" : "ABANDONED",
		runs: outcome.runs.map((run) => ({ id: run.id, cli: run.cli, vendor: run.vendor, outcome: run.outcome ?? null })),
		authoring_vendors: [...outcome.authoringVendors],
		at: (dependencies.now ?? (() => new Date()))().toISOString(),
	};
	const ledgerPath = path.join(targetRepoPath, ".gatekeeper", "dispatch-ledger.jsonl");
	try {
		await mkdir(path.dirname(ledgerPath), { recursive: true });
		await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
	} catch (error) {
		process.stderr.write(`warning: failed to write local dispatch ledger ${ledgerPath}: ${errorMessage(error)}\n`);
	}
}

/** Calls superviseWorkOrder and appends a dispatch-ledger line iff this specific call is the one that crossed into a terminal state (never re-appends for an order that was already terminal before this call). */
async function runSupervisionWithLedger(
	key: string,
	targetRepoPath: string,
	input: SuperviseWorkOrderInput,
	git: GitExecutor,
	beforeState: WorkOrderStatus,
	dependencies: DispatchCommandDependencies,
): Promise<SupervisionResult> {
	const env = dependencies.env ?? process.env;
	const supervise = dependencies.supervise ?? superviseWorkOrder;
	const result = await supervise(input, { env, git });
	if (!TERMINAL_STATES.has(beforeState) && TERMINAL_STATES.has(result.state)) {
		await appendDispatchLedgerEntry(targetRepoPath, key, result, dependencies);
	}
	return result;
}

function printReviewerConflict(conflict: ReviewerConflictWarning): void {
	process.stderr.write(
		`warning: REVIEWER_VENDOR_CONFLICT: reviewer vendor "${conflict.reviewerVendor}" already authored this order ` +
			`(authoring vendors: ${conflict.authoringVendors.join(", ")})` +
			`${conflict.suggestedVendors.length > 0 ? `; consider a reviewer from: ${conflict.suggestedVendors.join(", ")}` : "; no alternative vendor is available in this order's candidate ladder"}\n`,
	);
}

function printSupervisionResult(prefix: string, result: SupervisionResult): void {
	process.stdout.write(`${prefix}: order ${result.orderId} -> ${result.state}\n`);
	process.stdout.write(`  runs: ${result.runs.length}\n`);
	for (const run of result.runs) {
		process.stdout.write(`    ${run.id}  ${run.cli}(${run.vendor})  ${run.outcome ?? "RUNNING"}\n`);
	}
	if (result.authoringVendors.length > 0) {
		process.stdout.write(`  authoring vendors: ${result.authoringVendors.join(", ")}\n`);
	}
	for (const warning of result.warnings) {
		process.stderr.write(`warning: ${warning}\n`);
	}
	if (result.orphan) {
		process.stderr.write(
			`warning: run ${result.orphan.runId} could not be reconciled automatically (${result.orphan.reason})` +
				`${result.orphan.pgid !== undefined ? ` pgid=${result.orphan.pgid}` : ""}\n`,
		);
	}
	if (result.reviewerConflict) {
		printReviewerConflict(result.reviewerConflict);
	}
	if (result.resumeHint) {
		process.stdout.write(`  next: ${result.resumeHint}\n`);
	}
}

function describeCommandError(error: unknown): string {
	return errorMessage(error);
}

/** `NOT_FOUND` (unknown order) and `INVALID_DATA` (malformed order id, e.g. failing orderIdSchema) are both usage errors -- the user gave a bad order-id argument, not something dispatch itself broke on. Everything else the store/lock/machine/workspace layers raise is dispatch's own report-and-stop territory. */
function loadFailureExitCode(error: unknown): number {
	return error instanceof DispatchStoreError && (error.code === "NOT_FOUND" || error.code === "INVALID_DATA")
		? 2
		: DISPATCH_ATTENTION_EXIT_CODE;
}

// ---------------------------------------------------------------------------
// dispatch start
// ---------------------------------------------------------------------------

/**
 * `org/repo@adhoc-<id>` -- the association key `dispatch start --brief <file>` mints when no `--issue` is given at
 * all (T-20260721-01's ad-hoc entry point, for work that never had a GitHub issue behind it). The `@adhoc-` marker
 * deliberately cannot collide with the `#<digits>` issue-mode suffix `associationKeySchema` also accepts, so every
 * downstream reader (dispatch-ledger lines, `dispatch status`'s association-key column, REVIEWER_VENDOR_CONFLICT
 * text) can tell the two kinds of order apart at a glance. The suffix itself mirrors src/dispatch/store.ts's own
 * `makeOrderId` entropy-to-id-safe-characters shape (lowercase, non-alphanumerics stripped, truncated) without
 * importing that module directly -- store.ts is out of scope for this change.
 */
function generateAdHocAssociationKey(repo: string, randomUUIDFn: () => string): string {
	const suffix = randomUUIDFn()
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(0, 12);
	return `${repo}@adhoc-${suffix}`;
}

export interface DispatchStartOptions {
	issue?: number;
	brief?: string;
	agentCommand?: string;
	runTimeout?: number;
	yes?: boolean;
	repo?: string;
	registry?: string;
}

export async function runDispatchStart(
	options: DispatchStartOptions,
	cwd: string,
	dependencies: DispatchCommandDependencies = {},
): Promise<number> {
	const env = dependencies.env ?? process.env;
	const now = dependencies.now ?? (() => new Date());

	if (options.issue === undefined && !options.brief) {
		process.stderr.write(
			"gatekeeper dispatch start: at least one of --issue <n> or --brief <file> is required " +
				"(--issue alone dispatches a GitHub issue as before; --brief alone starts an ad-hoc order with no " +
				"GitHub issue at all; both together use --brief as the task package with --issue only as the " +
				"association key).\n",
		);
		return 2;
	}

	let discovered: DiscoveredConfig | null;
	try {
		const result = await discoverConfigWithControlsIndex(cwd, { mode: "tool", env });
		discovered = result.discovered;
		for (const warning of result.warnings) {
			process.stderr.write(`warning: ${warning}\n`);
		}
	} catch (error) {
		if (!(error instanceof ConfigDiscoveryError)) {
			throw error;
		}
		process.stderr.write(`gatekeeper dispatch start: ${error.reason}\n`);
		return 2;
	}

	const registryPath = resolveRegistryOption({ cliValue: options.registry, env, discovered });
	if (!registryPath) {
		process.stderr.write(`${missingRegistryMessage("dispatch start")}\n`);
		return 2;
	}

	let repo: string;
	try {
		repo = await resolveRepo(cwd, resolveConfiguredField(options.repo, discovered, "repo"));
	} catch (error) {
		process.stderr.write(
			"gatekeeper dispatch start: could not resolve a repo identity " +
				`(${error instanceof GitDiffError ? error.reason : errorMessage(error)}); ` +
				'provide --repo <org/name> or add a .gatekeeper.yml with a "repo:" field.\n',
		);
		return 2;
	}

	let entries: RepoEntry[];
	try {
		entries = await loadRepos(registryPath);
	} catch (error) {
		process.stderr.write(
			`gatekeeper dispatch start: ${error instanceof ReposFileError ? error.reason : errorMessage(error)}\n`,
		);
		return 2;
	}
	const entry = entries.find((candidate) => candidate.repo === repo);
	if (!entry) {
		process.stderr.write(
			`gatekeeper dispatch start: ${repo} is not registered in ${registryPath}/repos.yaml; ` +
				"run `gatekeeper adopt` first, or pass --repo <org/name> naming an already-registered repo.\n",
		);
		return 2;
	}

	let targetPath: string;
	try {
		targetPath = await (dependencies.realpath ?? fsRealpath)(entry.path);
	} catch (error) {
		process.stderr.write(
			`gatekeeper dispatch start: registered path ${entry.path} for ${repo} does not exist ` +
				`(${errorMessage(error)}); re-run \`gatekeeper adopt\`.\n`,
		);
		return 2;
	}

	// options.issue drives the association key's shape: issue-mode (`org/repo#N`) when given, ad-hoc mode
	// (`org/repo@adhoc-<id>`, T-20260721-01) when not -- the earlier guard above already guarantees --brief is set
	// whenever --issue is absent, so an ad-hoc order is never created without an explicit task package.
	const issueNumber = options.issue;
	const key =
		issueNumber !== undefined
			? `${repo}#${issueNumber}`
			: generateAdHocAssociationKey(repo, dependencies.randomUUID ?? nodeRandomUUID);

	let brief: string;
	let criteria: string[] = [];
	if (options.brief) {
		const briefPath = path.resolve(cwd, options.brief);
		let briefFileContent: string;
		try {
			briefFileContent = await (dependencies.readFile ?? defaultReadFile)(briefPath);
		} catch (error) {
			process.stderr.write(`gatekeeper dispatch start: failed to read --brief ${briefPath}: ${errorMessage(error)}\n`);
			return 2;
		}
		// Issue mode (--issue and --brief both given): --brief remains the task package verbatim, unchanged from
		// before T-20260721-01 -- the human owns the whole brief text. Ad-hoc mode (--brief alone): wrap it through
		// the same brief-synthesis template issue mode uses, minus the "## Issue"/"## Triage 判断" sections (see
		// src/render/dispatchBrief.ts's `task` field), so the ad-hoc coder still learns the RESULT.json delivery
		// contract instead of silently never producing it.
		brief =
			issueNumber !== undefined
				? briefFileContent
				: renderDispatchBrief({
						key,
						repo,
						task: briefFileContent,
						contract: { resultPath: DEFAULT_RESULT_PATH, progressPath: DEFAULT_PROGRESS_PATH },
					});
	} else if (issueNumber === undefined) {
		// Unreachable: the guard above already returns 2 when both --issue and --brief are absent, and this branch
		// only runs when options.brief is falsy -- kept only so TypeScript can narrow issueNumber to `number` below
		// without an unsound assertion.
		process.stderr.write("gatekeeper dispatch start: internal error -- neither --issue nor --brief resolved\n");
		return 2;
	} else {
		const synthesized = await synthesizeIssueBrief(
			issueNumber,
			key,
			repo,
			targetPath,
			{ resultPath: DEFAULT_RESULT_PATH, progressPath: DEFAULT_PROGRESS_PATH },
			dependencies,
		);
		if ("exitCode" in synthesized) {
			return synthesized.exitCode;
		}
		brief = synthesized.brief;
		criteria = synthesized.criteria;
	}

	const { candidates, warnings: ladderWarnings } = await resolveCandidateLadder(
		cwd,
		options.agentCommand,
		dependencies,
	);
	for (const warning of ladderWarnings) {
		process.stderr.write(`warning: ${warning}\n`);
	}
	if (candidates.length === 0) {
		process.stderr.write(
			"gatekeeper dispatch start: no coder-capable agent CLI is available. Checked, in priority order:\n" +
				"  1. --agent-command -- not given\n" +
				'  2. roles-policy.yaml\'s "coder" tier prefer order intersected with locally detected agent CLIs -- none matched\n\n' +
				"Install one of the coder-tier CLIs named in roles-policy.yaml's coder.prefer list, or pass --agent-command explicitly.\n",
		);
		return 2;
	}

	process.stdout.write(`gatekeeper dispatch start: ${key} -> ${targetPath}\n`);
	process.stdout.write(
		`  candidate ladder: ${candidates.map((candidate) => `${candidate.cli}(${candidate.vendor})`).join(" > ")}\n`,
	);
	process.stdout.write(
		`  run timeout: ${options.runTimeout ?? resolveDispatchMaxRunSeconds(env)}s, total run cap: ${DISPATCH_TOTAL_RUN_CAP}\n`,
	);

	let proceed = options.yes === true;
	if (!proceed) {
		const isTTY = dependencies.isInteractive ?? process.stdin.isTTY === true;
		if (!isTTY) {
			process.stderr.write(
				"gatekeeper dispatch start: not an interactive TTY; re-run with --yes to confirm starting supervision non-interactively\n",
			);
			return 2;
		}
		proceed = await (dependencies.promptConfirm ?? defaultPromptConfirm)(
			`Start dispatch supervision for ${key}? [y/N] `,
		);
	}
	if (!proceed) {
		process.stdout.write("gatekeeper dispatch start: aborted (not confirmed); no order created\n");
		return 0;
	}

	const createOrderFn = dependencies.createOrder ?? createOrder;
	let created: LoadedWorkOrder;
	try {
		created = await createOrderFn(
			{
				association_key: key,
				target_repo: { name: repo, path: targetPath },
				brief,
				acceptance_contract: {
					result_path: DEFAULT_RESULT_PATH,
					progress_path: DEFAULT_PROGRESS_PATH,
					require_non_wip_commit: true,
					criteria,
				},
				candidate_ladder: candidates,
			},
			{ env, now },
		);
	} catch (error) {
		process.stderr.write(
			`gatekeeper dispatch start: failed to create the dispatch order: ${describeCommandError(error)}\n`,
		);
		return DISPATCH_ATTENTION_EXIT_CODE;
	}
	process.stdout.write(`gatekeeper dispatch start: created order ${created.order.id}\n`);

	const baseRef = await resolveOrderBaseRef(targetPath);
	const git = (dependencies.createGitExecutor ?? createGitExecutor)(targetPath);

	let result: SupervisionResult;
	try {
		result = await runSupervisionWithLedger(
			key,
			targetPath,
			{
				orderId: created.order.id,
				baseRef,
				...(options.runTimeout !== undefined ? { maxRunSeconds: options.runTimeout } : {}),
			},
			git,
			"PENDING",
			dependencies,
		);
	} catch (error) {
		process.stderr.write(`gatekeeper dispatch start: dispatch supervision faulted: ${describeCommandError(error)}\n`);
		return DISPATCH_ATTENTION_EXIT_CODE;
	}

	printSupervisionResult("gatekeeper dispatch start", result);
	return result.state === "DELIVERED" ? 0 : DISPATCH_ATTENTION_EXIT_CODE;
}

// ---------------------------------------------------------------------------
// dispatch status
// ---------------------------------------------------------------------------

export interface DispatchStatusOptions {
	orderId?: string;
	json?: boolean;
}

function findLastEvent<T extends JournalEvent["type"]>(
	journal: readonly JournalEvent[],
	type: T,
): Extract<JournalEvent, { type: T }> | undefined {
	for (let index = journal.length - 1; index >= 0; index -= 1) {
		const event = journal[index];
		if (event?.type === type) {
			return event as Extract<JournalEvent, { type: T }>;
		}
	}
	return undefined;
}

function computeResumeHint(loaded: LoadedWorkOrder): string | undefined {
	if (loaded.state === "WAITING_COOLDOWN") {
		const cooldown = findLastEvent(loaded.journal, "COOLDOWN_STARTED");
		return cooldown
			? `resumable at ${cooldown.resume_after} -- gatekeeper dispatch resume ${loaded.order.id}`
			: `gatekeeper dispatch resume ${loaded.order.id}`;
	}
	if (loaded.state === "NEEDS_ATTENTION") {
		return `gatekeeper dispatch resume ${loaded.order.id}`;
	}
	return undefined;
}

interface OrderSummary {
	id: string;
	associationKey: string;
	state: WorkOrderStatus;
	runs: number;
	lastRunCli?: string;
	lastRunVendor?: string;
	createdAt: string;
	resumeHint?: string;
}

function summarizeOrder(loaded: LoadedWorkOrder): OrderSummary {
	const lastRun = loaded.runs.at(-1);
	const resumeHint = computeResumeHint(loaded);
	return {
		id: loaded.order.id,
		associationKey: loaded.order.association_key,
		state: loaded.state,
		runs: loaded.runs.length,
		...(lastRun ? { lastRunCli: lastRun.cli, lastRunVendor: lastRun.vendor } : {}),
		createdAt: loaded.order.created_at,
		...(resumeHint ? { resumeHint } : {}),
	};
}

/** Best-effort: check every preferred reviewer-tier vendor against this order's authoring_vendors, reusing supervisor.ts's own reviewerConflictWarning. A missing/unreadable roles-policy just skips the check (non-fatal, matches src/commands/triage.ts's own roles-policy degrade posture). */
async function computeReviewerConflicts(
	order: WorkOrder,
	cwd: string,
	dependencies: DispatchCommandDependencies,
): Promise<ReviewerConflictWarning[]> {
	if (order.authoring_vendors.length === 0) {
		return [];
	}
	try {
		const loadPolicy = dependencies.loadRolesPolicy ?? loadRolesPolicy;
		const policy = await loadPolicy(resolveRolesPolicyPath(cwd));
		const reviewerTier = policy.tiers.reviewer;
		if (!reviewerTier) {
			return [];
		}
		const conflicts: ReviewerConflictWarning[] = [];
		const seenVendors = new Set<string>();
		for (const modelId of reviewerTier.prefer) {
			const vendor = vendorOfModelId(modelId);
			if (seenVendors.has(vendor)) {
				continue;
			}
			seenVendors.add(vendor);
			const conflict = reviewerConflictWarning(order, vendor);
			if (conflict) {
				conflicts.push(conflict);
			}
		}
		return conflicts;
	} catch {
		return [];
	}
}

interface OrderDetail {
	id: string;
	associationKey: string;
	state: WorkOrderStatus;
	targetRepo: { name: string; path: string };
	authoringVendors: string[];
	runs: {
		id: string;
		cli: string;
		vendor: string;
		outcome: string | null;
		startedAt: string;
		endedAt?: string;
		stdoutPath: string;
		stderrPath: string;
	}[];
	resumeAfter?: string;
	attentionReason?: string;
	resumeHint?: string;
	reviewerConflicts: ReviewerConflictWarning[];
}

function buildOrderDetail(
	loaded: LoadedWorkOrder,
	env: NodeJS.ProcessEnv,
	reviewerConflicts: ReviewerConflictWarning[],
): OrderDetail {
	const orderDirectory = dispatchOrderDirectory(loaded.order.id, env);
	const cooldown = findLastEvent(loaded.journal, "COOLDOWN_STARTED");
	const attention = findLastEvent(loaded.journal, "ATTENTION_REQUIRED");
	return {
		id: loaded.order.id,
		associationKey: loaded.order.association_key,
		state: loaded.state,
		targetRepo: { name: loaded.order.target_repo.name, path: loaded.order.target_repo.path },
		authoringVendors: [...loaded.order.authoring_vendors],
		runs: loaded.runs.map((run) => ({
			id: run.id,
			cli: run.cli,
			vendor: run.vendor,
			outcome: run.outcome ?? null,
			startedAt: run.started_at,
			...(run.ended_at ? { endedAt: run.ended_at } : {}),
			stdoutPath: path.join(orderDirectory, run.stdout_path),
			stderrPath: path.join(orderDirectory, run.stderr_path),
		})),
		...(loaded.state === "WAITING_COOLDOWN" && cooldown ? { resumeAfter: cooldown.resume_after } : {}),
		...(loaded.state === "NEEDS_ATTENTION" && attention ? { attentionReason: attention.reason } : {}),
		...(computeResumeHint(loaded) ? { resumeHint: computeResumeHint(loaded) } : {}),
		reviewerConflicts,
	};
}

function printOrderDetail(detail: OrderDetail): void {
	if (detail.state === "WAITING_COOLDOWN" && detail.resumeAfter) {
		process.stdout.write(`>>> WAITING_COOLDOWN -- resumable at ${detail.resumeAfter}\n`);
		process.stdout.write(`>>> next: gatekeeper dispatch resume ${detail.id}\n\n`);
	} else if (detail.state === "NEEDS_ATTENTION") {
		process.stdout.write(`>>> NEEDS_ATTENTION${detail.attentionReason ? `: ${detail.attentionReason}` : ""}\n`);
		process.stdout.write(`>>> next: gatekeeper dispatch resume ${detail.id}\n\n`);
	}
	process.stdout.write(`order:   ${detail.id}\n`);
	process.stdout.write(`state:   ${detail.state}\n`);
	process.stdout.write(`issue:   ${detail.associationKey}\n`);
	process.stdout.write(`repo:    ${detail.targetRepo.name} (${detail.targetRepo.path})\n`);
	if (detail.authoringVendors.length > 0) {
		process.stdout.write(`authors: ${detail.authoringVendors.join(", ")}\n`);
	}
	process.stdout.write(`runs (${detail.runs.length}):\n`);
	for (const run of detail.runs) {
		process.stdout.write(
			`  ${run.id}  ${run.cli}(${run.vendor})  ${run.outcome ?? "RUNNING"}  started=${run.startedAt}${run.endedAt ? ` ended=${run.endedAt}` : ""}\n`,
		);
		process.stdout.write(`    stdout: ${run.stdoutPath}\n`);
		process.stdout.write(`    stderr: ${run.stderrPath}\n`);
	}
	for (const conflict of detail.reviewerConflicts) {
		printReviewerConflict(conflict);
	}
}

export async function runDispatchStatus(
	options: DispatchStatusOptions,
	cwd: string,
	dependencies: DispatchCommandDependencies = {},
): Promise<number> {
	const env = dependencies.env ?? process.env;

	if (!options.orderId) {
		let orders: LoadedWorkOrder[];
		try {
			orders = await (dependencies.listOrders ?? listOrders)(env);
		} catch (error) {
			process.stderr.write(`gatekeeper dispatch status: ${describeCommandError(error)}\n`);
			return DISPATCH_ATTENTION_EXIT_CODE;
		}
		const summaries = orders.map(summarizeOrder);
		if (options.json) {
			process.stdout.write(`${JSON.stringify({ orders: summaries }, null, 2)}\n`);
			return 0;
		}
		if (summaries.length === 0) {
			process.stdout.write("gatekeeper dispatch status: no orders\n");
			return 0;
		}
		for (const summary of summaries) {
			process.stdout.write(
				`${summary.id}  ${summary.state.padEnd(17)}  ${summary.lastRunCli ?? "-"}  runs=${summary.runs}  ${summary.associationKey}\n`,
			);
			if (summary.resumeHint) {
				process.stdout.write(`    -> ${summary.resumeHint}\n`);
			}
		}
		return 0;
	}

	let loaded: LoadedWorkOrder;
	try {
		loaded = await (dependencies.loadOrder ?? loadOrder)(options.orderId, env);
	} catch (error) {
		process.stderr.write(`gatekeeper dispatch status: ${describeCommandError(error)}\n`);
		return loadFailureExitCode(error);
	}

	const reviewerConflicts = await computeReviewerConflicts(loaded.order, cwd, dependencies);
	const detail = buildOrderDetail(loaded, env, reviewerConflicts);
	if (options.json) {
		process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
		return 0;
	}
	printOrderDetail(detail);
	return 0;
}

// ---------------------------------------------------------------------------
// dispatch logs
// ---------------------------------------------------------------------------

export interface DispatchLogsOptions {
	orderId: string;
	run?: string;
}

async function readTail(file: string, readFile: (file: string) => Promise<string>): Promise<string> {
	try {
		const content = await readFile(file);
		const lines = content.split("\n");
		return lines.slice(-LOG_TAIL_LINES).join("\n");
	} catch (error) {
		return `(unavailable: ${errorMessage(error)})`;
	}
}

export async function runDispatchLogs(
	options: DispatchLogsOptions,
	_cwd: string,
	dependencies: DispatchCommandDependencies = {},
): Promise<number> {
	const env = dependencies.env ?? process.env;
	let loaded: LoadedWorkOrder;
	try {
		loaded = await (dependencies.loadOrder ?? loadOrder)(options.orderId, env);
	} catch (error) {
		process.stderr.write(`gatekeeper dispatch logs: ${describeCommandError(error)}\n`);
		return loadFailureExitCode(error);
	}

	if (loaded.runs.length === 0) {
		process.stderr.write(`gatekeeper dispatch logs: ${options.orderId} has no runs yet\n`);
		return 2;
	}
	const run = options.run ? loaded.runs.find((candidate) => candidate.id === options.run) : loaded.runs.at(-1);
	if (!run) {
		process.stderr.write(`gatekeeper dispatch logs: ${options.orderId} has no run ${options.run}\n`);
		return 2;
	}

	const orderDirectory = dispatchOrderDirectory(options.orderId, env);
	const stdoutPath = path.join(orderDirectory, run.stdout_path);
	const stderrPath = path.join(orderDirectory, run.stderr_path);
	process.stdout.write(
		`gatekeeper dispatch logs: ${options.orderId} ${run.id} (${run.cli}/${run.vendor}, ${run.outcome ?? "RUNNING"})\n`,
	);
	process.stdout.write(`  stdout: ${stdoutPath}\n`);
	process.stdout.write(`  stderr: ${stderrPath}\n`);
	process.stdout.write(
		"  (--follow is not implemented; re-run this command, or tail the paths above directly, to watch a live run)\n\n",
	);

	const readFile = dependencies.readFile ?? defaultReadFile;
	process.stdout.write("--- stdout (tail) ---\n");
	process.stdout.write(`${await readTail(stdoutPath, readFile)}\n`);
	process.stdout.write("--- stderr (tail) ---\n");
	process.stdout.write(`${await readTail(stderrPath, readFile)}\n`);
	return 0;
}

// ---------------------------------------------------------------------------
// dispatch resume
// ---------------------------------------------------------------------------

/**
 * Resolve `--agent <cli>` into a full `{ cli, vendor, command }` candidate for
 * a NEEDS_ATTENTION resume's `agentOverride` -- src/dispatch/supervisor.ts's
 * own doc comment on that field: "A manually selected single-candidate
 * ladder for this attention resume." Per T-20260719-10 design's decision #3,
 * this override point exists specifically for a CLI *outside* the order's
 * frozen candidate-ladder snapshot (a fresh install detection never saw at
 * order-creation time, or a CLI KNOWN_AGENT_CLIS doesn't list at all) -- so
 * this re-detects fresh rather than consulting the order's own frozen
 * ladder:
 *
 *   1. If `agentName` matches a CLI `detectAgentClis` finds *right now*, use
 *      its known vendor/commandTemplate directly -- "in the detected set"
 *      (e.g. re-running detection now finds a CLI that was missing when the
 *      order was first created).
 *   2. Otherwise -- "outside the detected set", the override's primary
 *      intended use -- fall back to the same three-tier BYO command
 *      resolution `triage --run`/`init --run` use (src/agent/resolve.ts's
 *      `resolveAgentCommand`, tiers 2/3 only: there is no `--agent-command`
 *      equivalent flag on `dispatch resume`), tagging the resolved command
 *      with the operator-given name rather than a detected vendor.
 *
 * Returns an exit code only when neither step produces a command, or when
 * the target repo's own `.gatekeeper.yml` exists but fails to parse.
 */
async function resolveAgentOverride(
	agentName: string,
	targetRepoPath: string,
	dependencies: DispatchCommandDependencies,
): Promise<{ candidate: Candidate } | { exitCode: number; message: string }> {
	const env = dependencies.env ?? process.env;
	const detect = dependencies.detectAgentClis ?? detectAgentClis;
	const detected = await detect({ env });
	const known = detected.find((cli) => cli.name === agentName);
	if (known) {
		return { candidate: { cli: known.name, vendor: known.vendor, command: known.commandTemplate } };
	}

	let discovered: DiscoveredConfig | null;
	try {
		discovered = await discoverConfig(targetRepoPath);
	} catch (error) {
		if (!(error instanceof ConfigDiscoveryError)) {
			throw error;
		}
		return { exitCode: 2, message: error.reason };
	}
	const registryPath = resolveRegistryOption({ env, discovered });
	const resolved = await resolveAgentCommand({ env, discovered, registryPath, role: "coder" });
	if (!resolved) {
		return {
			exitCode: 2,
			message:
				`--agent ${agentName} is not among the agent CLIs detected on PATH right now, and no fallback BYO ` +
				`agent command could be resolved either. Add an "agent:" block to .gatekeeper.yml in ${targetRepoPath} ` +
				"(or set GATEKEEPER_AGENT_COMMAND) for this CLI, or install it so detection can find it.",
		};
	}
	return { candidate: { cli: agentName, vendor: "custom", command: resolved.command } };
}

export interface DispatchResumeOptions {
	orderId: string;
	agent?: string;
	wait?: boolean;
	kill?: boolean;
	confirmDead?: boolean;
	force?: boolean;
}

export async function runDispatchResume(
	options: DispatchResumeOptions,
	_cwd: string,
	dependencies: DispatchCommandDependencies = {},
): Promise<number> {
	const env = dependencies.env ?? process.env;
	let loaded: LoadedWorkOrder;
	try {
		loaded = await (dependencies.loadOrder ?? loadOrder)(options.orderId, env);
	} catch (error) {
		process.stderr.write(`gatekeeper dispatch resume: ${describeCommandError(error)}\n`);
		return loadFailureExitCode(error);
	}

	if (TERMINAL_STATES.has(loaded.state)) {
		if (options.agent) {
			process.stderr.write(
				`warning: --agent only applies to resuming a NEEDS_ATTENTION order; ignored (order is ${loaded.state})\n`,
			);
		}
		process.stdout.write(
			`gatekeeper dispatch resume: order ${options.orderId} is already terminal (${loaded.state}); nothing to resume\n`,
		);
		return loaded.state === "DELIVERED" ? 0 : DISPATCH_ATTENTION_EXIT_CODE;
	}

	const targetRepoPath = loaded.order.target_repo.path;

	let resumeFromAttention: boolean | undefined;
	let agentOverride: Candidate | undefined;
	if (loaded.state === "NEEDS_ATTENTION") {
		resumeFromAttention = true;
		if (options.agent) {
			const overrideResult = await resolveAgentOverride(options.agent, targetRepoPath, dependencies);
			if ("exitCode" in overrideResult) {
				process.stderr.write(`gatekeeper dispatch resume: ${overrideResult.message}\n`);
				return overrideResult.exitCode;
			}
			agentOverride = overrideResult.candidate;
		}
	} else if (options.agent) {
		process.stderr.write(
			`warning: --agent only applies to resuming a NEEDS_ATTENTION order; ignored (order is ${loaded.state})\n`,
		);
	}

	let orphanAction: OrphanAction | undefined;
	if (options.kill) {
		orphanAction = "kill";
	} else if (options.wait) {
		orphanAction = "wait";
	} else if (options.confirmDead) {
		orphanAction = "confirm-dead";
	}

	const baseRef = await resolveOrderBaseRef(targetRepoPath);
	const git = (dependencies.createGitExecutor ?? createGitExecutor)(targetRepoPath);

	let result: SupervisionResult;
	try {
		result = await runSupervisionWithLedger(
			loaded.order.association_key,
			targetRepoPath,
			{
				orderId: options.orderId,
				baseRef,
				...(resumeFromAttention ? { resumeFromAttention } : {}),
				...(agentOverride ? { agentOverride } : {}),
				...(orphanAction ? { orphanAction } : {}),
				...(options.force ? { forceCooldown: true } : {}),
			},
			git,
			loaded.state,
			dependencies,
		);
	} catch (error) {
		process.stderr.write(`gatekeeper dispatch resume: dispatch supervision faulted: ${describeCommandError(error)}\n`);
		return DISPATCH_ATTENTION_EXIT_CODE;
	}

	// A NEEDS_ATTENTION resume that supervisor.ts rejects (total run cap already exhausted, or the frozen
	// ladder has no unexhausted candidate and no --agent override was given) reports truthfully via
	// resumeHint rather than pretending to have resumed -- printSupervisionResult already surfaces it, and
	// the order stays NEEDS_ATTENTION, so the DELIVERED-only exit-0 rule below already yields exit 3 here.
	printSupervisionResult("gatekeeper dispatch resume", result);
	return result.state === "DELIVERED" ? 0 : DISPATCH_ATTENTION_EXIT_CODE;
}

// ---------------------------------------------------------------------------
// dispatch cancel
// ---------------------------------------------------------------------------

export interface DispatchCancelOptions {
	orderId: string;
}

export async function runDispatchCancel(
	options: DispatchCancelOptions,
	_cwd: string,
	dependencies: DispatchCommandDependencies = {},
): Promise<number> {
	const env = dependencies.env ?? process.env;
	let loaded: LoadedWorkOrder;
	try {
		loaded = await (dependencies.loadOrder ?? loadOrder)(options.orderId, env);
	} catch (error) {
		process.stderr.write(`gatekeeper dispatch cancel: ${describeCommandError(error)}\n`);
		return loadFailureExitCode(error);
	}

	if (TERMINAL_STATES.has(loaded.state)) {
		process.stdout.write(
			`gatekeeper dispatch cancel: order ${options.orderId} is already terminal (${loaded.state}); nothing to cancel\n`,
		);
		return 0;
	}

	if (loaded.state === "PENDING") {
		process.stderr.write(
			`gatekeeper dispatch cancel: order ${options.orderId} is PENDING (never started); the dispatch state ` +
				"machine has no PENDING -> ABANDONED transition (see src/dispatch/machine.ts's transition table and the " +
				`T-20260720-07 deviation report). Run \`gatekeeper dispatch start --issue <n>\` to begin it, or delete ` +
				"its order directory manually if it must be discarded before starting.\n",
		);
		return 2;
	}

	if (loaded.state === "RUNNING") {
		const targetRepoPath = loaded.order.target_repo.path;
		const baseRef = await resolveOrderBaseRef(targetRepoPath);
		const git = (dependencies.createGitExecutor ?? createGitExecutor)(targetRepoPath);
		let result: SupervisionResult;
		try {
			result = await runSupervisionWithLedger(
				loaded.order.association_key,
				targetRepoPath,
				{ orderId: options.orderId, baseRef, orphanAction: "kill" },
				git,
				loaded.state,
				dependencies,
			);
		} catch (error) {
			process.stderr.write(
				`gatekeeper dispatch cancel: dispatch supervision faulted: ${describeCommandError(error)}\n`,
			);
			return DISPATCH_ATTENTION_EXIT_CODE;
		}
		printSupervisionResult("gatekeeper dispatch cancel", result);
		if (result.state !== "ABANDONED" && result.state !== "DELIVERED") {
			process.stderr.write(
				`gatekeeper dispatch cancel: could not cancel order ${options.orderId}; it is still ${result.state}` +
					`${result.resumeHint ? ` -- ${result.resumeHint}` : ""}\n`,
			);
		} else if (result.state === "DELIVERED") {
			// The active run had already exited with valid delivery evidence before cancel's kill attempt could
			// reach it -- superviseWorkOrder's evidence-first reconciliation truthfully completed the order
			// instead of discarding real, evidenced work. Deliberate, not a bug -- surfaced plainly.
			process.stdout.write(
				`gatekeeper dispatch cancel: order ${options.orderId} was not cancelled -- its active run had already ` +
					"finished with valid delivery evidence before cancel could kill it\n",
			);
		}
		return result.state === "DELIVERED" ? 0 : DISPATCH_ATTENTION_EXIT_CODE;
	}

	// WAITING_COOLDOWN / NEEDS_ATTENTION: no active run/process to kill --
	// src/dispatch/supervisor.ts has no cancel entry point for either idle
	// state (see the T-20260720-07 deviation report), so this appends
	// ORDER_CANCELLED directly through the store's own exported primitives
	// (the exact transition src/dispatch/machine.ts's table already allows).
	// The supervisor lock is held for the read-modify-write regardless, as
	// cheap insurance against a racing live process.
	const acquire = dependencies.acquireSupervisorLock ?? acquireSupervisorLock;
	let lock: Awaited<ReturnType<typeof acquireSupervisorLock>>;
	try {
		lock = await acquire(options.orderId, { env });
	} catch (error) {
		process.stderr.write(`gatekeeper dispatch cancel: ${describeCommandError(error)}\n`);
		return DISPATCH_ATTENTION_EXIT_CODE;
	}
	try {
		const fresh = await (dependencies.loadOrder ?? loadOrder)(options.orderId, env);
		if (TERMINAL_STATES.has(fresh.state)) {
			process.stdout.write(
				`gatekeeper dispatch cancel: order ${options.orderId} is already terminal (${fresh.state}); nothing to cancel\n`,
			);
			return 0;
		}
		if (fresh.state !== "WAITING_COOLDOWN" && fresh.state !== "NEEDS_ATTENTION") {
			process.stderr.write(
				`gatekeeper dispatch cancel: order ${options.orderId} changed state to ${fresh.state} while cancelling; ` +
					`re-run \`gatekeeper dispatch cancel ${options.orderId}\`\n`,
			);
			return DISPATCH_ATTENTION_EXIT_CODE;
		}
		const now = dependencies.now ?? (() => new Date());
		const event: JournalEvent = {
			apiVersion: "gatekeeper/v1",
			type: "ORDER_CANCELLED",
			order_id: options.orderId,
			at: now().toISOString(),
			from: fresh.state,
			to: "ABANDONED",
		};
		await (dependencies.appendJournalEvent ?? appendJournalEvent)(options.orderId, event, env);
		await appendDispatchLedgerEntry(
			fresh.order.target_repo.path,
			fresh.order.association_key,
			{
				orderId: options.orderId,
				state: "ABANDONED",
				runs: fresh.runs,
				authoringVendors: fresh.order.authoring_vendors,
			},
			dependencies,
		);
		process.stdout.write(`gatekeeper dispatch cancel: order ${options.orderId} -> ABANDONED\n`);
		return DISPATCH_ATTENTION_EXIT_CODE;
	} catch (error) {
		// A raced live supervisor (e.g. a concurrent RUN_STARTED landing between our loadOrder and
		// appendJournalEvent) can turn this append into an illegal-transition DispatchStoreError -- report and
		// stop like every other dispatch infrastructure fault, never let it escape uncaught to cli.ts's top-level
		// rethrow (which would exit 1, the code reserved for `gatekeeper gate`'s block verdict).
		process.stderr.write(`gatekeeper dispatch cancel: ${describeCommandError(error)}\n`);
		return DISPATCH_ATTENTION_EXIT_CODE;
	} finally {
		await lock.release();
	}
}

// Re-exported so tests/other layers can recognize the failure classes this module surfaces without importing every underlying dispatch/* module directly.
export {
	DispatchLockError,
	DispatchStoreError,
	DispatchSupervisorError,
	DispatchTransitionError,
	DispatchWorkspaceError,
};
