import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type CheckOptions, runCheck } from "./commands/check.js";
import {
	applyCommentPlan,
	type GateDependencies,
	type GateOptions,
	linkedIssueNumbers,
	runGate,
} from "./commands/gate.js";
import type { Verdict } from "./engine/types.js";
import { type GitHubIssueComment, GitHubProvider, type GitHubProviderOptions, InfraError } from "./providers/github.js";
import { COMMENT_MARKER, planCommentUpsert, renderComment, renderInactiveComment } from "./render/comment.js";

type ActionMode = "check" | "gate";
type ActionEnforcement = "hard" | "soft";
type ActionProviderFactory = NonNullable<GateDependencies["createProvider"]>;

interface ActionInputs {
	mode: ActionMode;
	registryPath: string;
	enforce: ActionEnforcement;
	githubToken: string;
}

interface ActionEvent {
	payload: unknown;
	pullRequest: number | null;
	baseSha: string | undefined;
}

interface CommandCapture {
	exitCode: number;
	payloads: unknown[];
}

interface ActionDecision {
	decision: "pass" | "warn" | "block";
	verdict: Verdict;
}

export interface ActionDependencies {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	readFile?: (file: string) => Promise<string>;
	appendSummary?: (file: string, content: string) => Promise<void>;
	runCheck?: (options: CheckOptions, cwd: string) => Promise<number>;
	runGate?: (options: GateOptions, cwd: string, dependencies?: GateDependencies) => Promise<number>;
	createProvider?: ActionProviderFactory;
	gateDependencies?: Omit<GateDependencies, "env" | "createProvider">;
	now?: () => string;
}

class ActionInfrastructureError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(reason);
		this.name = "ActionInfrastructureError";
		this.reason = reason;
		if (options?.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
}

/** Resolve all PR-bearing event shapes supported by the Action contract. */
export function resolvePullRequestNumber(payload: unknown, eventName?: string): number | null {
	if (!isRecord(payload)) {
		return null;
	}
	if (eventName === "check_suite" || (eventName === undefined && isRecord(payload.check_suite))) {
		const suite = payload.check_suite;
		if (!isRecord(suite) || !Array.isArray(suite.pull_requests)) {
			return null;
		}
		const first = suite.pull_requests[0];
		return isRecord(first) ? positiveInteger(first.number) : null;
	}
	// This branch also resolves `pull_request_review` payloads (which carry a
	// top-level `pull_request` key), kept intentionally even though this
	// repo's own trusted workflows (see .github/workflows/gatekeeper-
	// selfgate.yml and examples/workflows/gatekeeper-gate.yml) no longer
	// trigger on `pull_request_review` -- its workflow definition loads from
	// the PR's merge commit rather than the base branch, so it cannot safely
	// appear in a required-check-producing workflow's trigger list (see
	// tasks/LESSONS.md). Removing this reverse-lookup branch would be a
	// behavior change outside this fix's scope; it stays available for a
	// future trusted bridging path (e.g. a `workflow_run` relay) that still
	// needs to parse a `pull_request_review`-shaped payload.
	if (isRecord(payload.pull_request)) {
		return positiveInteger(payload.pull_request.number);
	}
	return positiveInteger(payload.number);
}

function resolveBaseSha(payload: unknown): string | undefined {
	if (!isRecord(payload) || !isRecord(payload.pull_request) || !isRecord(payload.pull_request.base)) {
		return undefined;
	}
	const sha = payload.pull_request.base.sha;
	return typeof sha === "string" && sha.length > 0 ? sha : undefined;
}

function inputValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const actionsKey = `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
	// GitHub's toolkit preserves hyphens in INPUT_* keys. The underscore alias
	// keeps local runners and tests interoperable without changing action.yml.
	return env[actionsKey] ?? env[actionsKey.replaceAll("-", "_")];
}

function readInputs(env: NodeJS.ProcessEnv): ActionInputs {
	const mode = (inputValue(env, "mode") ?? "gate").trim();
	if (mode !== "check" && mode !== "gate") {
		throw new ActionInfrastructureError(`invalid input mode=${JSON.stringify(mode)}; expected check or gate`);
	}
	const registryPath = inputValue(env, "registry-path")?.trim();
	if (!registryPath) {
		throw new ActionInfrastructureError("missing required input registry-path");
	}
	const enforce = (inputValue(env, "enforce") ?? "hard").trim();
	if (enforce !== "hard" && enforce !== "soft") {
		throw new ActionInfrastructureError(`invalid input enforce=${JSON.stringify(enforce)}; expected hard or soft`);
	}
	const githubToken = inputValue(env, "github-token")?.trim();
	if (!githubToken) {
		throw new ActionInfrastructureError("missing required input github-token");
	}
	return { mode, registryPath, enforce, githubToken };
}

async function readActionEvent(env: NodeJS.ProcessEnv, dependencies: ActionDependencies): Promise<ActionEvent> {
	const eventPath = env.GITHUB_EVENT_PATH;
	if (!eventPath) {
		throw new ActionInfrastructureError("GITHUB_EVENT_PATH is not set");
	}
	let content: string;
	try {
		content = await (dependencies.readFile ?? ((file) => readFile(file, "utf8")))(eventPath);
	} catch (error) {
		throw new ActionInfrastructureError(`failed to read GitHub event payload ${eventPath}`, { cause: error });
	}
	let payload: unknown;
	try {
		payload = JSON.parse(content) as unknown;
	} catch (error) {
		throw new ActionInfrastructureError(`failed to parse GitHub event payload ${eventPath}`, { cause: error });
	}
	return {
		payload,
		pullRequest: resolvePullRequestNumber(payload, env.GITHUB_EVENT_NAME),
		baseSha: resolveBaseSha(payload),
	};
}

function chunkText(chunk: string | Uint8Array): string {
	return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
}

/** Capture a command's JSON stdout so its exit code can be classified safely. */
async function captureCommand(run: () => Promise<number>): Promise<CommandCapture> {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array, ...arguments_: unknown[]): boolean => {
		chunks.push(chunkText(chunk));
		const callback = arguments_.find((argument) => typeof argument === "function");
		if (typeof callback === "function") {
			callback();
		}
		return true;
	}) as typeof process.stdout.write;
	let exitCode: number;
	try {
		exitCode = await run();
	} finally {
		process.stdout.write = originalWrite;
	}
	const payloads: unknown[] = [];
	for (const line of chunks.join("").split(/\r?\n/)) {
		if (line.trim().length === 0) {
			continue;
		}
		try {
			payloads.push(JSON.parse(line) as unknown);
		} catch {
			// Human output is allowed, but only a parsed report can authorize a block.
		}
	}
	return { exitCode, payloads };
}

function failureReason(payload: Record<string, unknown>): string | undefined {
	if (payload.degraded === true || payload.invalid === true || payload.error === true) {
		return typeof payload.reason === "string" ? payload.reason : "command reported a degraded result";
	}
	return undefined;
}

function asVerdict(value: unknown): Verdict | undefined {
	if (!isRecord(value) || !(["pass", "warn", "block"] as unknown[]).includes(value.decision)) {
		return undefined;
	}
	if (typeof value.repo !== "string" || !Array.isArray(value.touched) || !Array.isArray(value.forbiddenEdits)) {
		return undefined;
	}
	return value as unknown as Verdict;
}

function classifyCommand(capture: CommandCapture, mode: ActionMode): ActionDecision {
	for (const payload of capture.payloads) {
		if (isRecord(payload)) {
			const reason = failureReason(payload);
			if (reason) {
				throw new ActionInfrastructureError(reason);
			}
		}
	}
	for (const payload of [...capture.payloads].reverse()) {
		if (!isRecord(payload)) {
			continue;
		}
		if (mode === "gate") {
			const verdict = asVerdict(payload.verdict);
			if (verdict && (payload.decision === "pass" || payload.decision === "block")) {
				return { decision: payload.decision, verdict };
			}
		} else {
			const verdict = asVerdict(payload);
			if (verdict) {
				return { decision: verdict.decision, verdict };
			}
		}
	}
	throw new ActionInfrastructureError(
		`the ${mode} command did not emit a valid machine-readable report (exit ${capture.exitCode})`,
	);
}

function providerFactory(inputs: ActionInputs, dependencies: ActionDependencies): ActionProviderFactory {
	return (
		dependencies.createProvider ??
		((options: GitHubProviderOptions) => new GitHubProvider({ ...options, token: inputs.githubToken }))
	);
}

function syntheticComment(id: number, body: string): GitHubIssueComment {
	return {
		id,
		body,
		user: null,
		created_at: "1970-01-01T00:00:00.000Z",
		updated_at: "1970-01-01T00:00:00.000Z",
	};
}

function isCommentCandidateRejection(error: unknown): boolean {
	return error instanceof InfraError && (error.status === 403 || error.status === 404);
}

/**
 * runGate computes its verdict before its final sticky-comment write. Keep
 * those final POST/PATCH operations best-effort so comment infrastructure
 * cannot erase a determined block. An unchanged PATCH is the command's
 * override ownership probe and must retain its original trust semantics.
 */
function bestEffortGateProviderFactory(
	inputs: ActionInputs,
	dependencies: ActionDependencies,
	warnings: string[],
): ActionProviderFactory {
	const createProvider = providerFactory(inputs, dependencies);
	return (options) => {
		const provider = createProvider(options);
		const knownCommentBodies = new Map<number, string | null>();
		const probedCommentIds = new Set<number>();
		return new Proxy(provider, {
			get(target, property) {
				if (property === "getIssueComments") {
					return async (issueNumber: number) => {
						const comments = await target.getIssueComments(issueNumber);
						for (const comment of comments) {
							knownCommentBodies.set(comment.id, comment.body);
						}
						return comments;
					};
				}
				if (property === "createIssueComment") {
					return async (issueNumber: number, body: string) => {
						try {
							return await target.createIssueComment(issueNumber, body);
						} catch (error) {
							warnings.push(`sticky comment create failed after verdict: ${describeError(error)}`);
							return syntheticComment(0, body);
						}
					};
				}
				if (property === "updateIssueComment") {
					return async (commentId: number, body: string) => {
						const isOwnershipProbe =
							knownCommentBodies.has(commentId) &&
							knownCommentBodies.get(commentId) === body &&
							!probedCommentIds.has(commentId);
						if (isOwnershipProbe) {
							probedCommentIds.add(commentId);
						}
						try {
							return await target.updateIssueComment(commentId, body);
						} catch (error) {
							if (isOwnershipProbe || isCommentCandidateRejection(error)) {
								throw error;
							}
							warnings.push(`sticky comment update failed after verdict: ${describeError(error)}`);
							return syntheticComment(commentId, body);
						}
					};
				}
				const value = Reflect.get(target, property, target) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	};
}

function repositoryUrl(pullRequestUrl: string | undefined): string | undefined {
	return pullRequestUrl?.replace(/\/pull\/\d+\/?$/, "");
}

async function upsertCheckComment(
	verdict: Verdict,
	pullRequest: number,
	repo: string,
	inputs: ActionInputs,
	env: NodeJS.ProcessEnv,
	dependencies: ActionDependencies,
): Promise<void> {
	const provider = providerFactory(inputs, dependencies)({ repo, token: inputs.githubToken });
	const [pull, comments] = await Promise.all([
		provider.getPullRequest(pullRequest),
		provider.getIssueComments(pullRequest),
	]);
	const active = verdict.touched.length > 0;
	const repoUrl = repositoryUrl(pull.html_url);
	const body = active
		? renderComment({
				verdict,
				gate: { state: verdict.decision === "block" ? "fail" : "pass", m: 0, n: 0 },
				lanes: [],
				pr: { number: pullRequest, ...(pull.html_url ? { url: pull.html_url } : {}) },
				linkedIssues: linkedIssueNumbers(pull.body),
				override: null,
				timestamp: (dependencies.now ?? (() => new Date().toISOString()))(),
				...(repoUrl ? { repositoryUrl: repoUrl } : {}),
			})
		: renderInactiveComment();
	const plan = planCommentUpsert({
		comments,
		body,
		authorLogin: env.GATEKEEPER_COMMENT_AUTHOR,
		createIfMissing: active,
	});
	await applyCommentPlan(provider, pullRequest, plan);
}

function markdown(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

function actionSummary(
	inputs: Pick<ActionInputs, "mode" | "enforce">,
	pullRequest: number | null,
	status: string,
	verdict?: Verdict,
	reason?: string,
): string {
	const lines = [
		"## Gatekeeper",
		"",
		"| Mode | Pull request | Enforcement | Result |",
		"| --- | ---: | --- | --- |",
		`| ${inputs.mode} | ${pullRequest === null ? "—" : `#${pullRequest}`} | ${inputs.enforce} | ${markdown(status)} |`,
	];
	if (reason) {
		lines.push("", `> GATEKEEPER DEGRADED: ${markdown(reason)}`);
	}
	if (verdict && verdict.touched.length > 0) {
		lines.push("", "### Verdict", "", "| Contract | Level | Enforcement |", "| --- | --- | --- |");
		for (const hit of verdict.touched) {
			lines.push(`| ${markdown(hit.contract)} | ${markdown(hit.level)} | ${markdown(hit.effectiveEnforcement)} |`);
		}
	}
	return `${lines.join("\n")}\n`;
}

async function appendActionSummary(
	env: NodeJS.ProcessEnv,
	content: string,
	dependencies: ActionDependencies,
): Promise<void> {
	const summaryPath = env.GITHUB_STEP_SUMMARY;
	if (!summaryPath) {
		return;
	}
	try {
		await (dependencies.appendSummary ?? ((file, value) => appendFile(file, value, "utf8")))(summaryPath, content);
	} catch (error) {
		emitWarning(`failed to write GITHUB_STEP_SUMMARY: ${describeError(error)}`);
	}
}

function annotation(value: string): string {
	return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function emitWarning(reason: string): void {
	process.stdout.write(`::warning::GATEKEEPER DEGRADED ${annotation(reason)}\n`);
}

function describeError(error: unknown): string {
	return error instanceof ActionInfrastructureError
		? error.reason
		: error instanceof Error
			? error.message
			: String(error);
}

function degradedComment(reason: string): string {
	return `${COMMENT_MARKER}\n\n## Gatekeeper · ⚠️ DEGRADED\n\n基础设施故障，未据此阻塞合并。\n\n\`${reason.replaceAll("`", "\\`")}\`\n`;
}

async function bestEffortDegradedComment(
	reason: string,
	pullRequest: number | null,
	repo: string | undefined,
	inputs: ActionInputs | undefined,
	env: NodeJS.ProcessEnv,
	dependencies: ActionDependencies,
): Promise<void> {
	if (pullRequest === null || !repo || !inputs) {
		return;
	}
	try {
		const provider = providerFactory(inputs, dependencies)({ repo, token: inputs.githubToken });
		const comments = await provider.getIssueComments(pullRequest);
		const plan = planCommentUpsert({
			comments,
			body: degradedComment(reason),
			authorLogin: env.GATEKEEPER_COMMENT_AUTHOR,
		});
		await applyCommentPlan(provider, pullRequest, plan);
	} catch (error) {
		emitWarning(`unable to annotate the sticky comment: ${describeError(error)}`);
	}
}

async function executeAction(
	inputs: ActionInputs,
	event: ActionEvent,
	env: NodeJS.ProcessEnv,
	cwd: string,
	dependencies: ActionDependencies,
): Promise<ActionDecision> {
	const repo = env.GITHUB_REPOSITORY;
	if (!repo) {
		throw new ActionInfrastructureError("GITHUB_REPOSITORY is not set");
	}
	if (event.pullRequest === null) {
		throw new ActionInfrastructureError("the GitHub event does not identify a pull request");
	}

	if (inputs.mode === "gate") {
		const commentWarnings: string[] = [];
		const createProvider = bestEffortGateProviderFactory(inputs, dependencies, commentWarnings);
		const capture = await captureCommand(() =>
			(dependencies.runGate ?? runGate)(
				{ pr: event.pullRequest as number, registry: inputs.registryPath, repo, json: true },
				cwd,
				{
					...dependencies.gateDependencies,
					env,
					createProvider,
				},
			),
		);
		const decision = classifyCommand(capture, "gate");
		for (const warning of commentWarnings) {
			emitWarning(warning);
		}
		return decision;
	}

	const base = event.baseSha ?? (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : undefined);
	const capture = await captureCommand(() =>
		(dependencies.runCheck ?? runCheck)(
			{
				registry: inputs.registryPath,
				repo,
				...(base ? { base } : {}),
				actor: env.GITHUB_ACTOR,
				json: true,
			},
			cwd,
		),
	);
	const decision = classifyCommand(capture, "check");
	try {
		await upsertCheckComment(decision.verdict, event.pullRequest, repo, inputs, env, dependencies);
	} catch (error) {
		emitWarning(`sticky comment update failed after ${decision.decision} verdict: ${describeError(error)}`);
	}
	return decision;
}

/**
 * Top-level fail-direction boundary. Every thrown exception is infrastructure
 * degradation and exits zero; only a parsed block verdict with enforce=hard
 * can return one.
 */
export async function runAction(dependencies: ActionDependencies = {}): Promise<number> {
	const env = dependencies.env ?? process.env;
	const cwd = dependencies.cwd ?? process.cwd();
	let inputs: ActionInputs | undefined;
	let pullRequest: number | null = null;
	try {
		inputs = readInputs(env);
		const event = await readActionEvent(env, dependencies);
		pullRequest = event.pullRequest;
		if (env.GITHUB_EVENT_NAME === "check_suite" && event.pullRequest === null) {
			await appendActionSummary(
				env,
				actionSummary(inputs, null, "SKIPPED (check suite has no associated pull request)"),
				dependencies,
			);
			process.stdout.write("Gatekeeper skipped: check suite has no associated pull request\n");
			return 0;
		}

		const result = await executeAction(inputs, event, env, cwd, dependencies);
		const hardBlock = result.decision === "block" && inputs.enforce === "hard";
		const status =
			result.decision === "block" && inputs.enforce === "soft"
				? "BLOCK (soft; not enforced)"
				: result.decision.toUpperCase();
		await appendActionSummary(env, actionSummary(inputs, pullRequest, status, result.verdict), dependencies);
		process.stdout.write(`Gatekeeper ${status}\n`);
		return hardBlock ? 1 : 0;
	} catch (error) {
		const reason = describeError(error);
		emitWarning(reason);
		await bestEffortDegradedComment(reason, pullRequest, env.GITHUB_REPOSITORY, inputs, env, dependencies);
		await appendActionSummary(
			env,
			actionSummary(inputs ?? { mode: "gate", enforce: "hard" }, pullRequest, "DEGRADED", undefined, reason),
			dependencies,
		);
		return 0;
	}
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	function guardAgainstStreamErrors(
		stream: NodeJS.WriteStream,
		otherStream: NodeJS.WriteStream,
		streamName: "stdout" | "stderr",
	): void {
		stream.on("error", (error: NodeJS.ErrnoException) => {
			try {
				otherStream.write(
					`warning: Gatekeeper ${streamName} stream error${error.code ? ` (${error.code})` : ""}; preserving exit code\n`,
				);
			} catch {
				// The warning is best-effort because the fallback stream may also be unavailable.
			}
			process.exit(process.exitCode ?? 0);
		});
	}
	guardAgainstStreamErrors(process.stdout, process.stderr, "stdout");
	guardAgainstStreamErrors(process.stderr, process.stdout, "stderr");

	// Keep a literal entry-point catch in addition to runAction's boundary: a
	// future setup regression must still fail open rather than escaping to Node.
	try {
		process.exitCode = await runAction();
	} catch (error) {
		emitWarning(describeError(error));
		process.exitCode = 0;
	}
}
