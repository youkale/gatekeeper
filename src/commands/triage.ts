import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { formatRegistryIssue, RegistryParseError } from "../engine/registry.js";
import type { Registry } from "../engine/types.js";
import { LanePresetParseError, LanePresetReadError, loadRegistryWithLanePresets } from "../gate/presets.js";
import { RegistryReadError } from "../providers/fsregistry.js";
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
	repo: string;
	registry: string;
	post?: boolean;
	verdictFile?: string;
	actor?: string;
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
}

function describeError(error: unknown): string {
	if (error instanceof RegistryParseError) {
		return error.issues.map(formatRegistryIssue).join("; ");
	}
	if (error instanceof RegistryReadError || error instanceof LanePresetReadError || error instanceof InfraError) {
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

async function runTriageBrief(
	options: TriageOptions,
	cwd: string,
	key: string,
	registry: Registry,
	provider: TriageProvider,
	dependencies: TriageDependencies,
): Promise<number> {
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

	const briefing = renderTriageBriefing({
		key,
		repo: options.repo,
		issue: issueInput,
		...(issueFetchWarning ? { issueFetchWarning } : {}),
		contracts,
		impact,
		tiers,
		...(registry.warnings.length > 0 ? { registryWarnings: registry.warnings.map(formatRegistryIssue) } : {}),
	});
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
	options: TriageOptions,
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

	const commentBody = renderTriageComment(key, verdict, ledgerEntry, options.actor);
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

export async function runTriage(
	options: TriageOptions,
	cwd: string,
	dependencies: TriageDependencies = {},
): Promise<number> {
	const key = `${options.repo}#${options.issue}`;

	let loaded: Awaited<ReturnType<typeof loadRegistryWithLanePresets>>;
	try {
		loaded = await loadRegistryWithLanePresets(options.registry, dependencies.presetDirectory);
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
			repo: options.repo,
		});
	} catch (error) {
		if (!(error instanceof InfraError)) {
			throw error;
		}
		process.stderr.write(`gatekeeper triage: ${error.reason}\n`);
		return 2;
	}

	return options.post
		? runTriagePost(options, cwd, key, loaded.registry, provider, dependencies)
		: runTriageBrief(options, cwd, key, loaded.registry, provider, dependencies);
}
