import { readFileSync } from "node:fs";

import {
	ConfigDiscoveryError,
	type DiscoveredConfig,
	discoverConfig,
	missingRegistryMessage,
	resolveConfiguredField,
	resolveRegistryOption,
} from "../config/discover.js";
import { formatRegistryIssue, RegistryParseError } from "../engine/registry.js";
import type { ChangedFile, ContractHit, Registry, Verdict } from "../engine/types.js";
import { evaluate } from "../engine/verdict.js";
import {
	evaluateLanes,
	evaluateMOfN,
	type LaneConfig,
	type LaneDefinition,
	type LaneEvaluationData,
	type LaneResult,
} from "../gate/lanes.js";
import { LanePresetParseError, LanePresetReadError, loadRegistryWithLanePresets } from "../gate/presets.js";
import { RegistryReadError } from "../providers/fsregistry.js";
import { GitDiffError, resolveRepo } from "../providers/gitdiff.js";
import {
	type GitHubIssueComment,
	GitHubProvider,
	type GitHubProviderOptions,
	type GitHubPullRequestFile,
	InfraError,
} from "../providers/github.js";
import {
	COMMENT_MARKER,
	type CommentGateState,
	type CommentUpsertPlan,
	planCommentUpsert,
	renderComment,
	renderInactiveComment,
} from "../render/comment.js";
import { renderExplain } from "../render/explain.js";

export interface GateOptions {
	pr: number;
	/** Optional at the CLI level: resolved against GATEKEEPER_REGISTRY / .gatekeeper.yml before use — see runGate. */
	registry?: string;
	repo?: string;
	json?: boolean;
	explain?: boolean;
}

type GateProvider = Pick<
	GitHubProvider,
	| "getPullRequest"
	| "getPullRequestFiles"
	| "getPullRequestReviews"
	| "getIssueComments"
	| "getCheckRuns"
	| "getCommitStatuses"
	| "getPullRequestLabels"
	| "createIssueComment"
	| "updateIssueComment"
>;

export interface GateDependencies {
	createProvider?: (options: GitHubProviderOptions) => GateProvider;
	now?: () => string;
	env?: NodeJS.ProcessEnv;
	eventPayload?: unknown;
	readEventPayload?: (path: string) => unknown;
	presetDirectory?: string;
	commentAuthorLogin?: string;
}

interface Requirement {
	m: number;
	lanes: string[];
}

interface LoadedGateRegistry {
	registry: Registry;
	lanes: Record<string, LaneDefinition>;
	conflicts: Array<{ lane: string; presetFile: string; userFile: string; resolution: "user-wins" }>;
}

interface GateReport {
	decision: "pass" | "block";
	verdict: Verdict;
	requirement: Requirement | null;
	lanes: LaneResult[];
	override: { label: string; actor: string | null } | null;
	comment: { action: CommentUpsertPlan["action"]; commentId: number | null };
}

interface AppliedComment {
	action: CommentUpsertPlan["action"];
	commentId: number | null;
}

interface GateOutcome {
	state: CommentGateState;
	blocked: boolean;
	requirement: Requirement | null;
}

function describeError(error: unknown): string {
	if (error instanceof RegistryParseError) {
		return error.issues.map(formatRegistryIssue).join("; ");
	}
	if (
		error instanceof RegistryReadError ||
		error instanceof GitDiffError ||
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

function degrade(reason: string, options: GateOptions): number {
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ degraded: true, reason })}\n`);
	}
	process.stderr.write(`GATEKEEPER DEGRADED: ${reason}\n`);
	return 0;
}

function rejectInvalid(reason: string, options: GateOptions): number {
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ invalid: true, reason })}\n`);
	}
	process.stderr.write(`GATEKEEPER INVALID: ${reason}\n`);
	return 1;
}

function isInfrastructureFailure(error: unknown): boolean {
	return (
		error instanceof RegistryReadError ||
		error instanceof GitDiffError ||
		error instanceof LanePresetReadError ||
		error instanceof InfraError ||
		error instanceof ConfigDiscoveryError
	);
}

async function resolveGateRepo(
	cwd: string,
	options: GateOptions,
	env: NodeJS.ProcessEnv,
	discovered: DiscoveredConfig | null,
): Promise<string> {
	return resolveRepo(cwd, resolveConfiguredField(options.repo, discovered, "repo") ?? env.GITHUB_REPOSITORY);
}

async function loadGateRegistry(registryDirectory: string, presetDirectory?: string): Promise<LoadedGateRegistry> {
	return loadRegistryWithLanePresets(registryDirectory, presetDirectory);
}

function changedFile(file: GitHubPullRequestFile): ChangedFile {
	const status: ChangedFile["status"] =
		file.status === "added"
			? "A"
			: file.status === "removed"
				? "D"
				: file.status === "renamed"
					? "R"
					: file.status === "copied"
						? "C"
						: "M";
	return {
		path: file.filename,
		status,
		...(file.previous_filename ? { oldPath: file.previous_filename } : {}),
		...(file.patch !== undefined ? { patch: file.patch } : {}),
	};
}

export function mergeRequirements(hits: ContractHit[]): Requirement | null {
	const lanes: string[] = [];
	const seen = new Set<string>();
	let minimum: number | undefined;
	for (const hit of hits) {
		if (!hit.requires) {
			continue;
		}
		minimum = Math.max(minimum ?? 0, hit.requires.m);
		for (const lane of hit.requires.lanes) {
			if (!seen.has(lane)) {
				seen.add(lane);
				lanes.push(lane);
			}
		}
	}
	return minimum === undefined ? null : { m: minimum, lanes };
}

export function linkedIssueNumbers(body: string | null): number[] {
	if (!body) {
		return [];
	}
	const issues = new Set<number>();
	for (const match of body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?)\s+#(\d+)\b/gi)) {
		const issue = Number(match[1]);
		if (Number.isSafeInteger(issue) && issue > 0) {
			issues.add(issue);
		}
	}
	for (const match of body.matchAll(/\bgatekeeper:issue=(\d+)\b/gi)) {
		const issue = Number(match[1]);
		if (Number.isSafeInteger(issue) && issue > 0) {
			issues.add(issue);
		}
	}
	return [...issues];
}

function repositoryUrl(pullRequestUrl: string | undefined): string | undefined {
	return pullRequestUrl?.replace(/\/pull\/\d+\/?$/, "");
}

function laneData(
	reviews: Awaited<ReturnType<GateProvider["getPullRequestReviews"]>>,
	checkRuns: Awaited<ReturnType<GateProvider["getCheckRuns"]>>,
	statuses: Awaited<ReturnType<GateProvider["getCommitStatuses"]>>,
	comments: Awaited<ReturnType<GateProvider["getIssueComments"]>>,
	headSha: string,
): LaneEvaluationData {
	return {
		reviews: reviews.map((review) => ({
			id: review.id,
			user: review.user,
			body: review.body,
			state: review.state,
			commit_id: review.commit_id,
			submitted_at: review.submitted_at,
		})),
		checkRuns: checkRuns.map((checkRun) => ({
			id: checkRun.id,
			name: checkRun.name,
			status: checkRun.status,
			conclusion: checkRun.conclusion,
			started_at: checkRun.started_at ?? null,
			completed_at: checkRun.completed_at ?? null,
		})),
		statuses: statuses.map((status) => ({
			id: status.id,
			state: status.state,
			context: status.context,
			created_at: status.created_at ?? "",
			updated_at: status.updated_at ?? status.created_at ?? "",
		})),
		comments: comments.map((comment) => ({
			id: comment.id,
			user: comment.user,
			body: comment.body,
			created_at: comment.created_at,
			updated_at: comment.updated_at,
		})),
		headSha,
		headPushedAt: null,
	};
}

export interface LaneEvidenceNeeds {
	reviews: boolean;
	checkRuns: boolean;
	statuses: boolean;
}

/** Select only the GitHub evidence endpoints required by the configured lanes. */
export function laneEvidenceNeeds(configs: readonly LaneConfig[]): LaneEvidenceNeeds {
	return {
		reviews: configs.some((config) => config.type === "human-approval" || config.type === "review"),
		checkRuns: configs.some(
			(config) => config.type === "check-run" && (config.selector ?? "check-run") === "check-run",
		),
		statuses: configs.some((config) => config.type === "check-run" && config.selector === "status"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function labeledOverrideActor(eventPayload: unknown, overrideLabel: string): string | null | undefined {
	if (!isRecord(eventPayload) || eventPayload.action !== "labeled") {
		return undefined;
	}
	const label = eventPayload.label;
	if (!isRecord(label) || label.name !== overrideLabel) {
		return undefined;
	}
	const sender = eventPayload.sender;
	return isRecord(sender) && typeof sender.login === "string" && sender.login.length > 0 ? sender.login : null;
}

function ledgerOverrideActor(body: string | null, overrideLabel: string): string | null | undefined {
	if (!body?.includes(COMMENT_MARKER)) {
		return undefined;
	}
	const ledger = body.match(/```json gatekeeper-ledger\s*\n([\s\S]*?)\n```/);
	if (!ledger?.[1]) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(ledger[1]);
		if (!isRecord(parsed) || !isRecord(parsed.override) || parsed.override.label !== overrideLabel) {
			return undefined;
		}
		return typeof parsed.override.actor === "string" && parsed.override.actor.length > 0 ? parsed.override.actor : null;
	} catch {
		return undefined;
	}
}

/** Resolve override attribution without treating the workflow re-run actor as the label author. */
export function resolveOverrideActor(
	eventPayload: unknown,
	comments: readonly GitHubIssueComment[],
	overrideLabel: string,
	commentAuthorLogin?: string,
	verifiedCommentId?: number,
): string | null {
	const eventActor = labeledOverrideActor(eventPayload, overrideLabel);
	if (eventActor !== undefined) {
		return eventActor;
	}
	const normalizedAuthor = commentAuthorLogin?.trim().toLowerCase();
	if (!normalizedAuthor && verifiedCommentId === undefined) {
		return null;
	}
	const candidates = comments
		.filter(
			(comment) =>
				comment.body?.includes(COMMENT_MARKER) &&
				(normalizedAuthor ? comment.user?.login.toLowerCase() === normalizedAuthor : comment.id === verifiedCommentId),
		)
		.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id - right.id);
	for (const comment of candidates) {
		const actor = ledgerOverrideActor(comment.body, overrideLabel);
		if (actor !== undefined) {
			return actor;
		}
	}
	return null;
}

async function probeEditableMarkerComment(
	provider: Pick<GateProvider, "updateIssueComment">,
	comments: readonly GitHubIssueComment[],
): Promise<number | null> {
	const candidates = comments
		.filter((comment) => comment.body?.includes(COMMENT_MARKER))
		.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id - right.id);
	for (const comment of candidates) {
		try {
			await provider.updateIssueComment(comment.id, comment.body ?? "");
			return comment.id;
		} catch (error) {
			if (error instanceof InfraError && (error.status === 403 || error.status === 404)) {
				process.stderr.write(
					`warning: marker comment ${comment.id} is not editable by this token; trying the next candidate\n`,
				);
				continue;
			}
			throw error;
		}
	}
	return null;
}

function loadEventPayload(env: NodeJS.ProcessEnv, dependencies: GateDependencies): unknown {
	if (Object.hasOwn(dependencies, "eventPayload")) {
		return dependencies.eventPayload;
	}
	const eventPath = env.GITHUB_EVENT_PATH;
	if (!eventPath) {
		return undefined;
	}
	try {
		const loaded = (dependencies.readEventPayload ?? ((path) => readFileSync(path, "utf8")))(eventPath);
		return typeof loaded === "string" ? JSON.parse(loaded) : loaded;
	} catch {
		return undefined;
	}
}

export async function applyCommentPlan(
	provider: Pick<GateProvider, "createIssueComment" | "updateIssueComment">,
	pr: number,
	plan: CommentUpsertPlan,
): Promise<AppliedComment> {
	for (const warning of plan.warnings) {
		process.stderr.write(`warning: ${warning}\n`);
	}
	if (plan.action === "create" && plan.body !== null) {
		const created = await provider.createIssueComment(pr, plan.body);
		return { action: "create", commentId: created.id };
	}
	if (plan.action === "update" && plan.body !== null) {
		for (const commentId of plan.candidateCommentIds) {
			try {
				const updated = await provider.updateIssueComment(commentId, plan.body);
				return { action: "update", commentId: updated.id };
			} catch (error) {
				if (error instanceof InfraError && (error.status === 403 || error.status === 404)) {
					process.stderr.write(
						`warning: marker comment ${commentId} is not editable by this token; trying the next candidate\n`,
					);
					continue;
				}
				throw error;
			}
		}
		if (plan.createIfMissing) {
			const created = await provider.createIssueComment(pr, plan.body);
			return { action: "create", commentId: created.id };
		}
	}
	return { action: "none", commentId: plan.action === "none" ? plan.commentId : null };
}

function emitReport(report: GateReport, options: GateOptions): void {
	if (options.json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return;
	}
	const passed = requiredLanePassCount(report.lanes, report.requirement);
	process.stdout.write(
		`GATEKEEPER GATE ${report.decision.toUpperCase()} (${passed}/${report.requirement?.m ?? 0} required lanes passed)\n`,
	);
}

export function requiredLanePassCount(
	results: readonly LaneResult[],
	requirement: { lanes: readonly string[] } | null,
): number {
	const requiredLanes = new Set(requirement?.lanes ?? []);
	return results.filter((lane) => requiredLanes.has(lane.lane) && lane.state === "pass").length;
}

function inactiveReport(verdict: Verdict, comment: AppliedComment): GateReport {
	return {
		decision: "pass",
		verdict,
		requirement: null,
		lanes: [],
		override: null,
		comment,
	};
}

export function evaluateGateOutcome(verdict: Verdict, results: LaneResult[]): GateOutcome {
	const blockingHits = verdict.touched.filter((hit) => hit.effectiveEnforcement === "block");
	const requirement = evaluationRequirement(verdict);
	if (verdict.forbiddenEdits.length > 0 || blockingHits.some((hit) => hit.requires === null)) {
		return { state: "fail", blocked: true, requirement };
	}
	if (!requirement) {
		return { state: "pass", blocked: false, requirement: null };
	}
	const names = new Set(requirement.lanes);
	const state = evaluateMOfN(
		results.filter((result) => names.has(result.lane)),
		requirement.m,
	).state;
	return { state, blocked: blockingHits.length > 0 && state !== "pass", requirement };
}

function evaluationRequirement(verdict: Verdict): Requirement | null {
	const blockingHits = verdict.touched.filter((hit) => hit.effectiveEnforcement === "block");
	return mergeRequirements(blockingHits.length > 0 ? blockingHits : verdict.touched);
}

function evidenceRequirement(verdict: Verdict): Requirement | null {
	const blockingHits = verdict.touched.filter((hit) => hit.effectiveEnforcement === "block");
	if (verdict.forbiddenEdits.length > 0 || blockingHits.some((hit) => hit.requires === null)) {
		return null;
	}
	return evaluationRequirement(verdict);
}

function configsFor(requirement: Requirement | null, lanes: LoadedGateRegistry["lanes"]): LaneConfig[] {
	if (!requirement) {
		return [];
	}
	return requirement.lanes.map((lane) => {
		const definition = lanes[lane];
		if (!definition) {
			throw new LanePresetParseError([
				{ file: "policy.yaml", path: `$.levels.*.require.lanes`, message: `lane ${JSON.stringify(lane)} is undefined` },
			]);
		}
		return { lane, ...definition } as LaneConfig;
	});
}

function commentPlan(
	comments: GitHubIssueComment[],
	body: string,
	authorLogin: string | undefined,
	createIfMissing = true,
): CommentUpsertPlan {
	return planCommentUpsert({ comments, body, authorLogin, createIfMissing });
}

export async function runGate(options: GateOptions, cwd: string, dependencies: GateDependencies = {}): Promise<number> {
	const env = dependencies.env ?? process.env;
	const commentAuthorLogin = dependencies.commentAuthorLogin ?? env.GATEKEEPER_COMMENT_AUTHOR;
	try {
		// Config discovery (.gatekeeper.yml) is infrastructure like the registry/GitHub
		// providers below: a damaged config file degrades (fail-open) rather than blocking.
		const discovered = await discoverConfig(cwd);
		const registryPath = resolveRegistryOption({ cliValue: options.registry, discovered });
		if (!registryPath) {
			process.stderr.write(`${missingRegistryMessage("gate")}\n`);
			return 2;
		}
		const repo = await resolveGateRepo(cwd, options, env, discovered);
		const loaded = await loadGateRegistry(registryPath, dependencies.presetDirectory);
		const provider = (dependencies.createProvider ?? ((providerOptions) => new GitHubProvider(providerOptions)))({
			repo,
		});
		const [pullRequest, files, labels] = await Promise.all([
			provider.getPullRequest(options.pr),
			provider.getPullRequestFiles(options.pr),
			provider.getPullRequestLabels(options.pr),
		]);
		const verdict = evaluate({
			repo,
			actor: pullRequest.user?.login,
			changedFiles: files.map(changedFile),
			registry: loaded.registry,
		});
		const comments = await provider.getIssueComments(options.pr);

		for (const warning of loaded.registry.warnings) {
			process.stderr.write(`warning: ${formatRegistryIssue(warning)}\n`);
		}
		for (const conflict of loaded.conflicts) {
			process.stderr.write(
				`warning: user lane ${conflict.lane} overrides preset ${conflict.presetFile} (${conflict.resolution})\n`,
			);
		}

		if (verdict.touched.length === 0) {
			const plan = commentPlan(comments, renderInactiveComment(), commentAuthorLogin, false);
			const appliedComment = await applyCommentPlan(provider, options.pr, plan);
			emitReport(inactiveReport(verdict, appliedComment), options);
			return 0;
		}

		const overrideLabel = loaded.registry.policy.overrides.label;
		let verifiedOverrideCommentId: number | null | undefined;
		let override: GateReport["override"] = null;
		if (labels.some((label) => label.name === overrideLabel)) {
			const eventPayload = loadEventPayload(env, dependencies);
			const eventActor = labeledOverrideActor(eventPayload, overrideLabel);
			let actor: string | null;
			if (eventActor !== undefined) {
				actor = eventActor;
			} else if (commentAuthorLogin) {
				actor = resolveOverrideActor(eventPayload, comments, overrideLabel, commentAuthorLogin);
			} else {
				verifiedOverrideCommentId = await probeEditableMarkerComment(provider, comments);
				actor = resolveOverrideActor(
					eventPayload,
					comments,
					overrideLabel,
					undefined,
					verifiedOverrideCommentId ?? undefined,
				);
			}
			override = { label: overrideLabel, actor };
		}
		const configs = configsFor(evidenceRequirement(verdict), loaded.lanes);
		let results: LaneResult[] = [];
		if (!override && configs.length > 0) {
			const needs = laneEvidenceNeeds(configs);
			const [reviews, checkRuns, statuses] = await Promise.all([
				needs.reviews ? provider.getPullRequestReviews(options.pr) : Promise.resolve([]),
				needs.checkRuns ? provider.getCheckRuns(pullRequest.head.sha) : Promise.resolve([]),
				needs.statuses ? provider.getCommitStatuses(pullRequest.head.sha) : Promise.resolve([]),
			]);
			results = evaluateLanes({
				lanes: configs,
				data: laneData(reviews, checkRuns, statuses, comments, pullRequest.head.sha),
			});
		}

		const outcome = evaluateGateOutcome(verdict, results);
		const state = override ? "pass" : outcome.state;
		const repoUrl = repositoryUrl(pullRequest.html_url);
		const body = renderComment({
			verdict,
			gate: { state, m: outcome.requirement?.m ?? 0, n: outcome.requirement?.lanes.length ?? 0 },
			lanes: results.map((result) => ({
				...result,
				type: configs.find((config) => config.lane === result.lane)?.type,
			})),
			pr: { number: options.pr, ...(pullRequest.html_url ? { url: pullRequest.html_url } : {}) },
			linkedIssues: linkedIssueNumbers(pullRequest.body),
			override,
			timestamp: (dependencies.now ?? (() => new Date().toISOString()))(),
			...(options.explain ? { explainLines: renderExplain(verdict) } : {}),
			...(repoUrl ? { repositoryUrl: repoUrl } : {}),
		});
		const plan =
			verifiedOverrideCommentId === undefined
				? commentPlan(comments, body, commentAuthorLogin)
				: verifiedOverrideCommentId === null
					? {
							action: "create" as const,
							commentId: null,
							candidateCommentIds: [],
							createIfMissing: true,
							body,
							warnings: [],
						}
					: {
							action: "update" as const,
							commentId: verifiedOverrideCommentId,
							candidateCommentIds: [verifiedOverrideCommentId],
							createIfMissing: true,
							body,
							warnings: [],
						};
		const appliedComment = await applyCommentPlan(provider, options.pr, plan);
		const blocked = override ? false : outcome.blocked;
		const report: GateReport = {
			decision: blocked ? "block" : "pass",
			verdict,
			requirement: outcome.requirement,
			lanes: results,
			override,
			comment: appliedComment,
		};
		emitReport(report, options);
		return blocked ? 1 : 0;
	} catch (error) {
		const reason = describeError(error);
		return isInfrastructureFailure(error) ? degrade(reason, options) : rejectInvalid(reason, options);
	}
}
