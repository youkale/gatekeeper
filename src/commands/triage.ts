import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { AgentTimeoutRangeError, resolveAgentCommand } from "../agent/resolve.js";
import { AgentRunError, type AgentRunResult, runAgentCommand } from "../agent/runner.js";
import {
	ConfigDiscoveryError,
	type DiscoveredConfig,
	discoverConfigWithControlsIndex,
	missingAgentMessage,
	missingRegistryMessage,
	resolveConfiguredField,
	resolveRegistryOption,
} from "../config/discover.js";
import { formatRegistryIssue, RegistryParseError } from "../engine/registry.js";
import type { Registry } from "../engine/types.js";
import { LanePresetParseError, LanePresetReadError, loadRegistryWithLanePresets } from "../gate/presets.js";
import { RegistryReadError } from "../providers/fsregistry.js";
import { GitDiffError, resolveRepo } from "../providers/gitdiff.js";
import { type GitHubIssue, GitHubProvider, type GitHubProviderOptions, InfraError } from "../providers/github.js";
import {
	buildTriageLedgerEntry,
	findConsumerImpact,
	renderTriageBriefing,
	renderTriageComment,
	summarizeContracts,
	TRIAGE_DECISION_LABELS,
	type TriageDecision,
	type TriageIssueInput,
	type TriageVerdict,
} from "../render/triage.js";
import { packagedRoleCardPath, resolveRoleCardPath } from "../roles/cards.js";
import type { TierModelSelection } from "../roles/policy.js";
import {
	loadRolesPolicy,
	piRuntimeAvailability,
	resolveRolesPolicyPath,
	selectAllTiers,
	vendorOfModelId,
} from "../roles/policy.js";

/**
 * `gatekeeper triage`: assembles a requirement-gate briefing for a GitHub
 * issue (contract summary + heuristic consumer-impact graph + roles-policy
 * dispatch candidates), or -- with --post -- writes back an *already
 * completed* judgement file as a structured issue comment, a
 * gatekeeper:accepted/rejected/needs-info label, and a local JSONL ledger
 * line keyed by `org/repo#N`.
 *
 * Judgement itself never happens in this process: the briefing is handed to
 * the deep-reasoner role outside the CLI (zero-model invariant), and --post
 * only ever replays a judgement file that already exists on disk.
 */

export interface TriageOptions {
	issue: number;
	/** Optional at the CLI level: resolved against .gatekeeper.yml before use — see runTriage. */
	repo?: string;
	/** Optional at the CLI level: resolved against GATEKEEPER_REGISTRY / .gatekeeper.yml before use — see runTriage. */
	registry?: string;
	post?: boolean;
	verdictFile?: string;
	actor?: string;
	/** Generate the briefing, run the resolved agent against it (see src/agent/resolve.ts's three-tier chain), then confirm before posting. Mutually exclusive with --verdict-file/--post. */
	run?: boolean;
	/** Skip --run's interactive y/N confirmation. Required outside a TTY. */
	yes?: boolean;
	/** Keep --run's temporary brief/verdict files instead of deleting them on exit (any exit path). */
	keepArtifacts?: boolean;
	/** --run's tier-1 explicit agent command override (see src/agent/resolve.ts). */
	agentCommand?: string;
	/** Wall-clock budget in seconds for --agent-command; ignored unless agentCommand is also given. */
	agentTimeout?: number;
}

type TriageProvider = Pick<GitHubProvider, "getIssue" | "createIssueComment" | "addIssueLabels" | "removeIssueLabel">;

export interface TriageDependencies {
	createProvider?: (options: GitHubProviderOptions) => TriageProvider;
	env?: NodeJS.ProcessEnv;
	presetDirectory?: string;
	/** Injectable clock for the ledger "at" timestamp when the verdict file omits one. */
	now?: () => string;
	/** Defaults to <cwd>/.gatekeeper/triage-ledger.jsonl. */
	ledgerFile?: string;
	rolesPolicyPath?: string;
	piConfigDir?: string;
	/** Injectable agent runner for --run (defaults to runAgentCommand). */
	runAgent?: typeof runAgentCommand;
	/** Injectable confirmation prompt for --run's interactive gate (defaults to a readline y/N prompt over process.stdin/stdout). */
	promptConfirm?: (message: string) => Promise<boolean>;
	/** Override for "is this an interactive TTY" in --run's confirmation gate (defaults to process.stdin.isTTY === true). */
	isInteractive?: boolean;
}

function describeError(error: unknown): string {
	if (error instanceof RegistryParseError) {
		return error.issues.map(formatRegistryIssue).join("; ");
	}
	if (
		error instanceof RegistryReadError ||
		error instanceof LanePresetReadError ||
		error instanceof InfraError ||
		error instanceof ConfigDiscoveryError
	) {
		return error.reason;
	}
	if (error instanceof LanePresetParseError) {
		return error.issues.map((issue) => `${issue.file} ${issue.path}: ${issue.message}`).join("; ");
	}
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** TriageOptions with `repo`/`registry` narrowed to `string` once runTriage has resolved them (CLI flag / .gatekeeper.yml / usage-error exit). */
interface ResolvedTriageOptions extends Omit<TriageOptions, "repo" | "registry"> {
	repo: string;
	registry: string;
}

const VALID_DECISIONS = new Set<TriageDecision>(["accepted", "rejected", "needs-info"]);

class VerdictFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VerdictFileError";
	}
}

interface ParsedVerdictFile extends TriageVerdict {
	at?: string;
}

/** Validate a --verdict-file payload. This is a CLI-internal artifact (not the protected sticky-comment ledger). */
function parseVerdictFile(raw: string, filePath: string): ParsedVerdictFile {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new VerdictFileError(`${filePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!isRecord(value)) {
		throw new VerdictFileError(`${filePath}: must be a JSON object`);
	}
	if (typeof value.decision !== "string" || !VALID_DECISIONS.has(value.decision as TriageDecision)) {
		throw new VerdictFileError(`${filePath}: $.decision must be one of accepted, rejected, needs-info`);
	}
	if (typeof value.reason_summary !== "string" || value.reason_summary.length === 0) {
		throw new VerdictFileError(`${filePath}: $.reason_summary must be a non-empty string`);
	}
	if (typeof value.suggested_level !== "string" || value.suggested_level.length === 0) {
		throw new VerdictFileError(`${filePath}: $.suggested_level must be a non-empty string`);
	}
	if (!isRecord(value.dispatch) || typeof value.dispatch.coder !== "string" || value.dispatch.coder.length === 0) {
		throw new VerdictFileError(`${filePath}: $.dispatch.coder must be a non-empty string`);
	}
	const reviewers = value.dispatch.reviewers;
	if (
		!Array.isArray(reviewers) ||
		reviewers.length === 0 ||
		reviewers.some((reviewer) => typeof reviewer !== "string" || reviewer.length === 0)
	) {
		throw new VerdictFileError(`${filePath}: $.dispatch.reviewers must be a non-empty array of non-empty strings`);
	}
	if (new Set(reviewers).size !== reviewers.length) {
		throw new VerdictFileError(`${filePath}: $.dispatch.reviewers must not contain duplicate model ids`);
	}
	let acceptanceCriteria: string[] | undefined;
	if (value.acceptance_criteria !== undefined) {
		if (
			!Array.isArray(value.acceptance_criteria) ||
			value.acceptance_criteria.some((item) => typeof item !== "string")
		) {
			throw new VerdictFileError(`${filePath}: $.acceptance_criteria must be an array of strings`);
		}
		acceptanceCriteria = value.acceptance_criteria as string[];
	}
	let at: string | undefined;
	if (value.at !== undefined) {
		if (typeof value.at !== "string" || value.at.length === 0) {
			throw new VerdictFileError(`${filePath}: $.at must be a non-empty string`);
		}
		at = value.at;
	}

	return {
		decision: value.decision as TriageDecision,
		reason_summary: value.reason_summary,
		suggested_level: value.suggested_level,
		dispatch: { coder: value.dispatch.coder, reviewers: reviewers as string[] },
		...(acceptanceCriteria ? { acceptance_criteria: acceptanceCriteria } : {}),
		...(at ? { at } : {}),
	};
}

/**
 * Product default: double review. This floor holds regardless of
 * roles-policy availability -- roles-policy may only ever *raise* it (a
 * larger configured reviewer.count), never lower it or be bypassed by
 * failing to load.
 */
const STRUCTURAL_MINIMUM_REVIEWERS = 2;

/**
 * Validate dispatch.reviewers: too few reviewers to satisfy the structural
 * floor (or the roles-policy reviewer tier's `count`, whichever is higher)
 * is a hard failure -- the whole point of a two-lane review is the second
 * lane; one is silently no better than none. A same-vendor pair when the
 * tier prefers `cross_vendor` is only a warning -- "cross_vendor" is a
 * best-effort preference for when the available set allows it, not a hard
 * requirement, per roles-policy.yaml.
 *
 * roles-policy.yaml always ships with the package (`defaultRolesPolicyPath`
 * resolves to a real file); failing to load it here -- whether a cwd
 * override or the shipped fallback -- is therefore an anomaly, not a
 * routine "not configured" state, and fails the write rather than silently
 * skipping the count/cross-vendor check it exists to enforce.
 */
async function validateDispatchAgainstRolesPolicy(
	cwd: string,
	verdict: TriageVerdict,
	dependencies: TriageDependencies,
	filePath: string,
): Promise<{ warnings: string[] }> {
	if (verdict.dispatch.reviewers.length < STRUCTURAL_MINIMUM_REVIEWERS) {
		throw new VerdictFileError(
			`${filePath}: $.dispatch.reviewers must include at least ${STRUCTURAL_MINIMUM_REVIEWERS} reviewer(s) ` +
				"(product default: double review)",
		);
	}

	const rolesPolicyPath = resolveRolesPolicyPath(cwd, dependencies.rolesPolicyPath);
	let policy: Awaited<ReturnType<typeof loadRolesPolicy>>;
	try {
		policy = await loadRolesPolicy(rolesPolicyPath);
	} catch (error) {
		throw new VerdictFileError(
			`${filePath}: failed to load roles-policy (${rolesPolicyPath}) to validate dispatch.reviewers: ` +
				`${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const reviewerTier = policy.tiers.reviewer;
	if (!reviewerTier) {
		return { warnings: [] };
	}

	if (verdict.dispatch.reviewers.length < reviewerTier.count) {
		throw new VerdictFileError(
			`${filePath}: $.dispatch.reviewers must include at least ${reviewerTier.count} reviewer(s) ` +
				`(roles-policy reviewer tier requires count=${reviewerTier.count})`,
		);
	}

	const warnings: string[] = [];
	if (reviewerTier.crossVendor) {
		const vendors = verdict.dispatch.reviewers.map(vendorOfModelId);
		if (new Set(vendors).size < vendors.length) {
			warnings.push(
				"dispatch.reviewers are not fully cross-vendor (roles-policy reviewer tier prefers cross_vendor: true)",
			);
		}
	}
	return { warnings };
}

function toIssueInput(issue: GitHubIssue): TriageIssueInput {
	return {
		number: issue.number,
		title: issue.title,
		body: issue.body,
		author: issue.user?.login ?? null,
		labels: issue.labels.map((label) => label.name),
		...(issue.html_url ? { url: issue.html_url } : {}),
	};
}

function issueTextForImpact(issue: TriageIssueInput | null): string {
	return issue ? `${issue.title}\n${issue.body ?? ""}` : "";
}

async function resolveTierSelections(
	cwd: string,
	dependencies: TriageDependencies,
): Promise<{
	tiers: TierModelSelection[];
	warning?: string;
}> {
	try {
		const rolesPolicyPath = resolveRolesPolicyPath(cwd, dependencies.rolesPolicyPath);
		const policy = await loadRolesPolicy(rolesPolicyPath);
		const availability = await piRuntimeAvailability({ piConfigDir: dependencies.piConfigDir });
		return { tiers: selectAllTiers(policy, availability) };
	} catch (error) {
		return { tiers: [], warning: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Resolve the deep-reasoner role card path the briefing should point its
 * reader at: the control repo's own `governance/roles/deep-reasoner.md` when
 * `options.registry` has one (see src/roles/cards.ts's resolveRoleCardPath),
 * otherwise the packaged default. The packaged copy always ships with the
 * package, so a RoleCardNotFoundError here is an installation anomaly, not a
 * routine "not customized" state -- degrade to a warning and the literal
 * fallback string rather than failing the whole briefing over it.
 */
function resolveDeepReasonerCardPath(registryPath: string): string {
	try {
		return resolveRoleCardPath("deep-reasoner", registryPath);
	} catch (error) {
		process.stderr.write(
			`warning: 无法定位 deep-reasoner 角色卡: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return "docs/roles/deep-reasoner.md";
	}
}

const PACKAGED_CODE_REVIEWER_CARD_PATH = "docs/roles/code-reviewer.md";

/**
 * Resolve the code-reviewer role card path the posted comment's dispatch-plan
 * "reviewers" line points at.
 *
 * Unlike resolveDeepReasonerCardPath -- whose result only ever gets printed
 * to stdout for whoever is running `gatekeeper triage` right now, on the same
 * machine and the same checkout -- this value gets embedded in a GitHub issue
 * comment: a durable artifact that may be read from a different machine, a
 * different checkout, or a CI runner entirely. resolveRoleCardPath's raw
 * return value is filesystem-resolved (an absolute path, or a path rooted at
 * whatever `moduleUrl`/`registryPath` happened to be on *this* machine), so
 * embedding it directly would leak local directory structure and be useless
 * (or actively misleading) to a reader elsewhere -- this function therefore
 * returns a *portable representation* for persisted output, not the
 * filesystem-resolved path itself: resolveRoleCardPath is still used
 * internally to determine existence and source (packaged vs. control-repo
 * override), but only the source classification survives into the returned
 * string.
 *
 * - Packaged default matched: return the fixed, checkout-relative literal
 *   `docs/roles/code-reviewer.md` (true for any install, never a local path).
 * - A control repo's own customized copy matched: return it relative to
 *   `registryPath` (the same `--registry` directory every reader of a
 *   dispatch-plan comment must already have located to act on it), e.g.
 *   `roles/code-reviewer.md` or `../roles/code-reviewer.md` depending on
 *   which of the two customization layouts matched. This deliberately does
 *   *not* attempt to re-derive and express the path relative to a guessed
 *   "control repo root": src/roles/cards.ts's own module doc comment records
 *   that a control repo's `roles/` can sit at either of two different depths
 *   relative to `registryPath` (`<registryPath>/roles` when the registry
 *   directory *is* the control root, or `<registryPath>/../roles` when they
 *   are `governance/` siblings) with no reliable way to tell which one
 *   matched from `registryPath` alone -- that is precisely the
 *   basename/depth-heuristic misclassification class `resolveRoleCardPath`
 *   was hardened against (see its module doc comment). Reusing that same
 *   precedent here (registry-relative, not a re-guessed control-root-relative
 *   path) is deliberate: a plausible-looking shortcut that reintroduces an
 *   already-fixed heuristic in a new call site is exactly the "precedent
 *   reuse without re-verifying its safety in the new context" failure class
 *   documented in docs/roles/code-reviewer.md's precedent-judgments section.
 *
 * Same degrade-to-warning-and-packaged-fallback posture as
 * resolveDeepReasonerCardPath: the packaged copy always ships with the
 * package, so a lookup failure here is an installation anomaly, not a reason
 * to fail the whole --post write.
 */
function resolveCodeReviewerCardPath(registryPath: string): string {
	try {
		const resolved = resolveRoleCardPath("code-reviewer", registryPath);
		if (resolved === packagedRoleCardPath("code-reviewer")) {
			return PACKAGED_CODE_REVIEWER_CARD_PATH;
		}
		return path.relative(registryPath, resolved).split(path.sep).join("/");
	} catch (error) {
		process.stderr.write(
			`warning: 无法定位 code-reviewer 角色卡: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return PACKAGED_CODE_REVIEWER_CARD_PATH;
	}
}

/**
 * Assembles the triage briefing markdown (contract summary + heuristic
 * consumer-impact graph + roles-policy dispatch candidates). Shared by the
 * plain-printing path (runTriageBrief) and --run, which instead writes it to
 * a temp file as the agent's input.
 */
async function buildTriageBriefing(
	options: ResolvedTriageOptions,
	cwd: string,
	key: string,
	registry: Registry,
	provider: TriageProvider,
	dependencies: TriageDependencies,
): Promise<string> {
	let issueInput: TriageIssueInput | null = null;
	let issueFetchWarning: string | undefined;
	try {
		issueInput = toIssueInput(await provider.getIssue(options.issue));
	} catch (error) {
		if (!(error instanceof InfraError)) {
			throw error;
		}
		issueFetchWarning = error.reason;
		process.stderr.write(`warning: 无法读取 issue ${key}: ${error.reason}（简报仍会生成，缺少 issue 正文）\n`);
	}

	const contracts = summarizeContracts(registry);
	const impact = findConsumerImpact(contracts, issueTextForImpact(issueInput));
	const { tiers, warning: rolesPolicyWarning } = await resolveTierSelections(cwd, dependencies);
	if (rolesPolicyWarning) {
		process.stderr.write(`warning: 无法加载 roles-policy: ${rolesPolicyWarning}\n`);
	}
	const deepReasonerCardPath = resolveDeepReasonerCardPath(options.registry);

	return renderTriageBriefing({
		key,
		repo: options.repo,
		issue: issueInput,
		...(issueFetchWarning ? { issueFetchWarning } : {}),
		contracts,
		impact,
		tiers,
		...(registry.warnings.length > 0 ? { registryWarnings: registry.warnings.map(formatRegistryIssue) } : {}),
		deepReasonerCardPath,
	});
}

async function runTriageBrief(
	options: ResolvedTriageOptions,
	cwd: string,
	key: string,
	registry: Registry,
	provider: TriageProvider,
	dependencies: TriageDependencies,
): Promise<number> {
	const briefing = await buildTriageBriefing(options, cwd, key, registry, provider, dependencies);
	process.stdout.write(briefing);
	return 0;
}

/**
 * gatekeeper:accepted/rejected/needs-info are mutually exclusive. Rather
 * than pre-reading the issue's current labels and conditionally deciding
 * what to remove (a TOCTOU: the label set can change between the read and
 * the write, and concurrent/retried runs would race each other), this
 * unconditionally issues a DELETE for both non-target decision labels and
 * relies on GitHub's DELETE-on-a-missing-label 404 being idempotent success
 * (see GitHubProvider.removeIssueLabel) -- safe to call every time, no
 * snapshot to go stale.
 *
 * If a cleanup DELETE genuinely fails (not a 404 -- a real infra fault), the
 * target label is deliberately *not* added: adding it while an old decision
 * label might still be present would risk three-way label pollution
 * (needs-info + rejected + accepted all present at once), which is worse
 * than leaving the sync incomplete for a retry. GitHub sync failures stay
 * fail-open at the process level (exit 0, warning) since the local ledger
 * line already durably recorded the decision.
 */
async function syncDecisionLabel(
	provider: TriageProvider,
	issueNumber: number,
	decision: TriageDecision,
	key: string,
): Promise<{ failed: boolean }> {
	const targetLabel = TRIAGE_DECISION_LABELS[decision];
	const otherLabels = Object.values(TRIAGE_DECISION_LABELS).filter((label) => label !== targetLabel);

	for (const label of otherLabels) {
		try {
			await provider.removeIssueLabel(issueNumber, label);
		} catch (error) {
			if (!(error instanceof InfraError)) {
				throw error;
			}
			process.stderr.write(
				`warning: 无法清理旧标签 ${label} (${key}): ${error.reason}（为避免多标签并存，本次不添加新标签，可重试）\n`,
			);
			return { failed: true };
		}
	}

	try {
		await provider.addIssueLabels(issueNumber, [targetLabel]);
	} catch (error) {
		if (!(error instanceof InfraError)) {
			throw error;
		}
		process.stderr.write(`warning: 无法打标签 (${key}): ${error.reason}（本地台账已写入）\n`);
		return { failed: true };
	}

	return { failed: false };
}

async function runTriagePost(
	options: ResolvedTriageOptions,
	cwd: string,
	key: string,
	registry: Registry,
	provider: TriageProvider,
	dependencies: TriageDependencies,
): Promise<number> {
	if (!options.verdictFile) {
		process.stderr.write("gatekeeper triage: --verdict-file is required with --post\n");
		return 2;
	}

	const verdictPath = path.resolve(cwd, options.verdictFile);
	let raw: string;
	try {
		raw = await readFile(verdictPath, "utf8");
	} catch (error) {
		process.stderr.write(
			`gatekeeper triage: failed to read --verdict-file ${verdictPath}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 2;
	}

	let parsed: ParsedVerdictFile;
	try {
		parsed = parseVerdictFile(raw, verdictPath);
	} catch (error) {
		if (!(error instanceof VerdictFileError)) {
			throw error;
		}
		process.stderr.write(`gatekeeper triage: ${error.message}\n`);
		return 2;
	}

	// Everything below this point is validation-only until the explicit "no more
	// validation failures" marker further down -- no local/GitHub write may happen
	// before every check below has passed, so a rejected verdict file never leaves
	// a partial trace (ledger line, comment, or label) behind.
	if (!Object.hasOwn(registry.policy.levels, parsed.suggested_level)) {
		process.stderr.write(
			`gatekeeper triage: ${verdictPath}: $.suggested_level ${JSON.stringify(parsed.suggested_level)} is not declared in ${options.registry}/policy.yaml\n`,
		);
		return 2;
	}

	const verdict: TriageVerdict = {
		decision: parsed.decision,
		reason_summary: parsed.reason_summary,
		suggested_level: parsed.suggested_level,
		dispatch: parsed.dispatch,
		...(parsed.acceptance_criteria ? { acceptance_criteria: parsed.acceptance_criteria } : {}),
	};

	let dispatchWarnings: string[];
	try {
		dispatchWarnings = (await validateDispatchAgainstRolesPolicy(cwd, verdict, dependencies, verdictPath)).warnings;
	} catch (error) {
		if (!(error instanceof VerdictFileError)) {
			throw error;
		}
		process.stderr.write(`gatekeeper triage: ${error.message}\n`);
		return 2;
	}
	for (const warning of dispatchWarnings) {
		process.stderr.write(`warning: ${warning}\n`);
	}
	// -- validation complete; every write below is allowed to happen. --

	const at = parsed.at ?? (dependencies.now ?? (() => new Date().toISOString()))();
	const ledgerEntry = buildTriageLedgerEntry(key, verdict, at);

	const ledgerPath = dependencies.ledgerFile ?? path.join(cwd, ".gatekeeper", "triage-ledger.jsonl");
	try {
		await mkdir(path.dirname(ledgerPath), { recursive: true });
		await appendFile(ledgerPath, `${JSON.stringify(ledgerEntry)}\n`, "utf8");
	} catch (error) {
		process.stderr.write(
			`gatekeeper triage: failed to write local ledger ${ledgerPath}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}

	const codeReviewerCardPath = resolveCodeReviewerCardPath(options.registry);
	const commentBody = renderTriageComment(key, verdict, ledgerEntry, options.actor, codeReviewerCardPath);
	let githubSyncIncomplete = false;
	try {
		await provider.createIssueComment(options.issue, commentBody);
	} catch (error) {
		if (!(error instanceof InfraError)) {
			throw error;
		}
		githubSyncIncomplete = true;
		process.stderr.write(`warning: 无法回写 issue 评论 (${key}): ${error.reason}（本地台账已写入）\n`);
	}

	const labelSync = await syncDecisionLabel(provider, options.issue, verdict.decision, key);
	if (labelSync.failed) {
		githubSyncIncomplete = true;
	}

	process.stdout.write(
		`gatekeeper triage: recorded ${verdict.decision} for ${key} (${ledgerPath})` +
			`${githubSyncIncomplete ? " — GitHub sync incomplete, see warnings above" : ""}\n`,
	);
	return 0;
}

/** Default --run confirmation prompt: a plain readline y/N question over process.stdin/stdout. */
async function defaultPromptConfirm(message: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(message);
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

/**
 * `triage --run`: generates the same briefing runTriageBrief would print,
 * hands it to the agent resolved through src/agent/resolve.ts's three-tier
 * chain (--agent-command/GATEKEEPER_AGENT_COMMAND, then .gatekeeper.yml's
 * agent.command, then governance/agents.yaml's deep-reasoner assignment),
 * subjects whatever verdict file the agent produces to the exact same hard
 * validation (parseVerdictFile + suggested_level +
 * validateDispatchAgainstRolesPolicy) --post applies to a hand-authored one,
 * prints a summary, and -- after an explicit confirmation -- replays it
 * through runTriagePost so posting logic is never duplicated.
 */
async function runTriageRun(
	options: ResolvedTriageOptions,
	cwd: string,
	key: string,
	registry: Registry,
	provider: TriageProvider,
	dependencies: TriageDependencies,
	discovered: DiscoveredConfig | null,
): Promise<number> {
	let resolvedAgent: Awaited<ReturnType<typeof resolveAgentCommand>>;
	try {
		resolvedAgent = await resolveAgentCommand({
			cliCommand: options.agentCommand,
			cliTimeoutSeconds: options.agentTimeout,
			env: dependencies.env,
			discovered,
			registryPath: options.registry,
			role: "deep-reasoner",
		});
	} catch (error) {
		if (!(error instanceof AgentTimeoutRangeError)) {
			throw error;
		}
		process.stderr.write(`gatekeeper triage --run: ${error.message}\n`);
		return 2;
	}
	if (!resolvedAgent) {
		process.stderr.write(`${missingAgentMessage("triage")}\n`);
		return 2;
	}
	process.stdout.write(`gatekeeper triage --run: ${resolvedAgent.description}\n`);

	const briefing = await buildTriageBriefing(options, cwd, key, registry, provider, dependencies);

	const runDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-triage-run-"));
	try {
		const briefPath = path.join(runDir, "brief.md");
		const verdictPath = path.join(runDir, "verdict.json");
		await writeFile(briefPath, briefing, "utf8");

		let runResult: AgentRunResult;
		try {
			runResult = await (dependencies.runAgent ?? runAgentCommand)({
				command: resolvedAgent.command,
				timeoutSeconds: resolvedAgent.timeoutSeconds,
				briefPath,
				outPath: verdictPath,
				cwd,
				env: dependencies.env ?? process.env,
			});
		} catch (error) {
			if (!(error instanceof AgentRunError)) {
				throw error;
			}
			process.stderr.write(`gatekeeper triage --run: ${error.message}\n`);
			if (error.stderrTail) {
				process.stderr.write(`--- agent stderr (tail) ---\n${error.stderrTail}\n`);
			}
			return 1;
		}
		void runResult; // captured stdout/stderr from the agent run are diagnostic-only here.

		let raw: string;
		try {
			raw = await readFile(verdictPath, "utf8");
		} catch (error) {
			process.stderr.write(
				`gatekeeper triage --run: agent command did not produce a verdict file at ${verdictPath}: ` +
					`${error instanceof Error ? error.message : String(error)}\n`,
			);
			return 1;
		}

		let parsed: ParsedVerdictFile;
		try {
			parsed = parseVerdictFile(raw, verdictPath);
		} catch (error) {
			if (!(error instanceof VerdictFileError)) {
				throw error;
			}
			process.stderr.write(`gatekeeper triage --run: ${error.message}\n`);
			return 2;
		}
		if (!Object.hasOwn(registry.policy.levels, parsed.suggested_level)) {
			process.stderr.write(
				`gatekeeper triage --run: ${verdictPath}: $.suggested_level ${JSON.stringify(parsed.suggested_level)} ` +
					`is not declared in ${options.registry}/policy.yaml\n`,
			);
			return 2;
		}
		const verdict: TriageVerdict = {
			decision: parsed.decision,
			reason_summary: parsed.reason_summary,
			suggested_level: parsed.suggested_level,
			dispatch: parsed.dispatch,
			...(parsed.acceptance_criteria ? { acceptance_criteria: parsed.acceptance_criteria } : {}),
		};
		let dispatchWarnings: string[];
		try {
			dispatchWarnings = (await validateDispatchAgainstRolesPolicy(cwd, verdict, dependencies, verdictPath)).warnings;
		} catch (error) {
			if (!(error instanceof VerdictFileError)) {
				throw error;
			}
			process.stderr.write(`gatekeeper triage --run: ${error.message}\n`);
			return 2;
		}
		for (const warning of dispatchWarnings) {
			process.stderr.write(`warning: ${warning}\n`);
		}

		process.stdout.write(`gatekeeper triage --run: agent verdict for ${key}\n`);
		process.stdout.write(`  decision: ${verdict.decision}\n`);
		process.stdout.write(`  reason: ${verdict.reason_summary.split("\n")[0]}\n`);
		process.stdout.write(`  suggested_level: ${verdict.suggested_level}\n`);
		process.stdout.write(
			`  dispatch: coder=${verdict.dispatch.coder} reviewers=${verdict.dispatch.reviewers.join(", ")}\n`,
		);

		let proceed = options.yes === true;
		if (!proceed) {
			const isTTY = dependencies.isInteractive ?? process.stdin.isTTY === true;
			if (!isTTY) {
				process.stderr.write(
					"gatekeeper triage --run: not an interactive TTY; re-run with --yes to confirm posting non-interactively\n",
				);
				return 2;
			}
			proceed = await (dependencies.promptConfirm ?? defaultPromptConfirm)("Post this verdict? [y/N] ");
		}
		if (!proceed) {
			process.stdout.write("gatekeeper triage --run: aborted (not confirmed); verdict not posted\n");
			return 0;
		}

		return await runTriagePost({ ...options, verdictFile: verdictPath }, cwd, key, registry, provider, dependencies);
	} finally {
		if (options.keepArtifacts) {
			process.stdout.write(`gatekeeper triage --run: kept run artifacts at ${runDir}\n`);
		} else {
			await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

export async function runTriage(
	options: TriageOptions,
	cwd: string,
	dependencies: TriageDependencies = {},
): Promise<number> {
	if (options.run && options.verdictFile) {
		process.stderr.write("gatekeeper triage: --run and --verdict-file are mutually exclusive\n");
		return 2;
	}
	if (options.run && options.post) {
		process.stderr.write("gatekeeper triage: --run already posts once confirmed; do not combine it with --post\n");
		return 2;
	}

	// Config discovery (.gatekeeper.yml, falling back to the user-level controls
	// index) is a local-authoring-command input like the registry directory
	// itself: triage fails loud on damage, not the check/gate degrade path.
	let discovered: Awaited<ReturnType<typeof discoverConfigWithControlsIndex>>["discovered"];
	try {
		const result = await discoverConfigWithControlsIndex(cwd, { mode: "tool", env: dependencies.env });
		discovered = result.discovered;
		for (const discoveryWarning of result.warnings) {
			process.stderr.write(`warning: ${discoveryWarning}\n`);
		}
	} catch (error) {
		if (!(error instanceof ConfigDiscoveryError)) {
			throw error;
		}
		process.stderr.write(`gatekeeper triage: ${describeError(error)}\n`);
		return 1;
	}

	const registryPath = resolveRegistryOption({ cliValue: options.registry, discovered });
	if (!registryPath) {
		process.stderr.write(`${missingRegistryMessage("triage")}\n`);
		return 2;
	}
	// Same fallback chain as check.ts/gate.ts/doctor.ts: explicit --repo, then
	// .gatekeeper.yml/controls-index `repo:` (resolveConfiguredField), then
	// resolveRepo's own `git remote get-url origin` auto-detection -- a
	// self-match discovery (a hub repo discovering its own root, see
	// src/config/controls.ts's locateOwningControl) has no repo identity to
	// offer, so without this fallback triage could never resolve a repo with
	// zero flags from inside a hub that does have an origin remote.
	let repo: string;
	try {
		repo = await resolveRepo(cwd, resolveConfiguredField(options.repo, discovered, "repo"));
	} catch (error) {
		process.stderr.write(
			"gatekeeper triage: could not resolve a repo identity " +
				`(${error instanceof GitDiffError ? error.reason : String(error)}); ` +
				'provide --repo <org/name> or add a .gatekeeper.yml with a "repo:" field.\n',
		);
		return 2;
	}
	const effectiveOptions: ResolvedTriageOptions = {
		...options,
		registry: registryPath,
		repo,
		actor: resolveConfiguredField(options.actor, discovered, "actor"),
	};

	const key = `${effectiveOptions.repo}#${effectiveOptions.issue}`;

	let loaded: Awaited<ReturnType<typeof loadRegistryWithLanePresets>>;
	try {
		loaded = await loadRegistryWithLanePresets(registryPath, dependencies.presetDirectory);
	} catch (error) {
		if (
			error instanceof RegistryParseError ||
			error instanceof LanePresetParseError ||
			error instanceof RegistryReadError ||
			error instanceof LanePresetReadError
		) {
			const usageError = error instanceof RegistryReadError || error instanceof LanePresetReadError;
			process.stderr.write(`gatekeeper triage: ${describeError(error)}\n`);
			return usageError ? 2 : 1;
		}
		throw error;
	}
	for (const warning of loaded.registry.warnings) {
		process.stderr.write(`warning: ${formatRegistryIssue(warning)}\n`);
	}

	let provider: TriageProvider;
	try {
		provider = (dependencies.createProvider ?? ((providerOptions) => new GitHubProvider(providerOptions)))({
			repo,
		});
	} catch (error) {
		if (!(error instanceof InfraError)) {
			throw error;
		}
		process.stderr.write(`gatekeeper triage: ${error.reason}\n`);
		return 2;
	}

	if (effectiveOptions.run) {
		return runTriageRun(effectiveOptions, cwd, key, loaded.registry, provider, dependencies, discovered);
	}
	return effectiveOptions.post
		? runTriagePost(effectiveOptions, cwd, key, loaded.registry, provider, dependencies)
		: runTriageBrief(effectiveOptions, cwd, key, loaded.registry, provider, dependencies);
}
