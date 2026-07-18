import type { Verdict } from "../engine/types.js";

export const COMMENT_MARKER = "<!-- gatekeeper:verdict -->";

export type CommentGateState = "pass" | "fail" | "pending";
export type CommentLaneState = CommentGateState;

export interface CommentLaneResult {
	lane: string;
	state: CommentLaneState;
	evidence: string;
	type?: "human-approval" | "review" | "check-run" | "comment-scan";
}

export interface CommentGateSummary {
	state: CommentGateState;
	m: number;
	n: number;
}

export interface PullRequestLink {
	number: number;
	url?: string;
}

export interface LinkedIssue {
	number: number;
	url?: string;
}

export interface CommentOverride {
	label: string;
	actor: string | null;
}

export interface RenderCommentInput {
	verdict: Verdict;
	gate: CommentGateSummary;
	lanes: CommentLaneResult[];
	pr: PullRequestLink;
	linkedIssues: Array<number | LinkedIssue>;
	override: CommentOverride | null;
	timestamp: string;
	explainLines?: string[];
	repositoryUrl?: string;
}

export interface GatekeeperLedger {
	schema_version: 1;
	pr: {
		number: number;
		url: string | null;
	};
	issues: Array<{
		number: number;
		url: string | null;
	}>;
	verdict: {
		decision: Verdict["decision"];
		gate_state: CommentGateState;
		required: number;
		total: number;
		repo: string;
		touched_contracts: string[];
		forbidden_edits: number;
	};
	lanes: Array<{
		lane: string;
		state: CommentLaneState;
		evidence: string;
		text_matched: boolean;
	}>;
	override: CommentOverride | null;
	timestamp: string;
}

export interface GitHubIssueComment {
	id: number;
	body: string | null;
	created_at: string;
	user: {
		login: string;
	} | null;
}

export interface CommentUpsertInput {
	comments: readonly GitHubIssueComment[];
	body: string;
	authorLogin?: string;
	createIfMissing?: boolean;
}

export interface CommentUpsertPlan {
	action: "create" | "update" | "none";
	commentId: number | null;
	candidateCommentIds: number[];
	createIfMissing: boolean;
	body: string | null;
	warnings: string[];
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeTableCell(value: string): string {
	return escapeHtml(value).replaceAll("|", "\\|").replaceAll(/\r?\n/g, "<br>");
}

function issueLink(issue: LinkedIssue, repositoryUrl: string | undefined): string {
	const url = issue.url ?? (repositoryUrl ? `${repositoryUrl.replace(/\/$/, "")}/issues/${issue.number}` : undefined);
	return url ? `[#${issue.number}](${url})` : `#${issue.number}`;
}

function requirementText(requirement: { m: number; lanes: string[] } | null): string {
	if (!requirement) {
		return "—";
	}
	return `${requirement.m}-of-${requirement.lanes.length}: ${requirement.lanes.join(", ")}`;
}

function consumerText(consumers: Verdict["touched"][number]["consumers"]): string {
	if (consumers.length === 0) {
		return "—";
	}
	return consumers
		.map((consumer) => {
			const details = [consumer.role, consumer.verify ? `verify: ${consumer.verify}` : undefined].filter(Boolean);
			return `${consumer.repo} (${details.join("; ")})`;
		})
		.join("\n");
}

function laneEvidence(lane: CommentLaneResult): string {
	const suffix =
		lane.type === "comment-scan" && lane.state === "pass" && !lane.evidence.includes("(text-matched)")
			? " (text-matched)"
			: "";
	return `${lane.evidence}${suffix}`;
}

function stateLabel(state: CommentGateState): string {
	switch (state) {
		case "pass":
			return "✅ PASS";
		case "fail":
			return "❌ FAIL";
		case "pending":
			return "⏳ PENDING";
	}
}

function normalizedIssues(input: RenderCommentInput): LinkedIssue[] {
	return input.linkedIssues.map((issue) => (typeof issue === "number" ? { number: issue } : issue));
}

/** Build the stable machine-readable block without reading time or external state. */
export function buildLedger(input: RenderCommentInput): GatekeeperLedger {
	return {
		schema_version: 1,
		pr: {
			number: input.pr.number,
			url: input.pr.url ?? null,
		},
		issues: normalizedIssues(input).map((issue) => ({
			number: issue.number,
			url:
				issue.url ?? (input.repositoryUrl ? `${input.repositoryUrl.replace(/\/$/, "")}/issues/${issue.number}` : null),
		})),
		verdict: {
			decision: input.verdict.decision,
			gate_state: input.gate.state,
			required: input.gate.m,
			total: input.gate.n,
			repo: input.verdict.repo,
			touched_contracts: input.verdict.touched.map((hit) => hit.contract),
			forbidden_edits: input.verdict.forbiddenEdits.length,
		},
		lanes: input.lanes.map((lane) => ({
			lane: lane.lane,
			state: lane.state,
			evidence: laneEvidence(lane),
			text_matched: lane.type === "comment-scan" && lane.state === "pass",
		})),
		override: input.override,
		timestamp: input.timestamp,
	};
}

function renderLedger(ledger: GatekeeperLedger): string[] {
	// Evidence originates in GitHub. Escaping backticks keeps it inside the
	// fenced ledger while preserving valid JSON (JSON.parse restores them).
	const json = JSON.stringify(ledger, null, 2).replaceAll("`", "\\u0060");
	return ["```json gatekeeper-ledger", json, "```"];
}

/** Render the complete sticky PR comment. This function is deterministic and side-effect free. */
export function renderComment(input: RenderCommentInput): string {
	const lines = [COMMENT_MARKER, "", `## Gatekeeper · ${stateLabel(input.gate.state)}`, ""];

	const prUrl = input.pr.url;
	lines.push(prUrl ? `PR: [#${input.pr.number}](${prUrl})` : `PR: #${input.pr.number}`);
	const issues = normalizedIssues(input);
	if (issues.length > 0) {
		lines.push(`关联 issue: ${issues.map((issue) => issueLink(issue, input.repositoryUrl)).join(", ")}`);
	}
	if (input.override) {
		lines.push(
			`Override: \`${escapeHtml(input.override.label)}\`${
				input.override.actor ? `，操作者 \`${escapeHtml(input.override.actor)}\`` : "，操作者未知"
			}`,
		);
	}

	lines.push("", "### 判定", "", "| 契约 | 消费方 | 要求 |", "| --- | --- | --- |");
	for (const hit of input.verdict.touched) {
		lines.push(
			`| ${escapeTableCell(hit.contract)} | ${escapeTableCell(consumerText(hit.consumers))} | ${escapeTableCell(
				requirementText(hit.requires),
			)} |`,
		);
	}

	lines.push("", "### Lanes", "", "| Lane | 状态 | 证据 |", "| --- | --- | --- |");
	for (const lane of input.lanes) {
		lines.push(
			`| ${escapeTableCell(lane.lane)} | ${escapeTableCell(lane.state)} | ${escapeTableCell(laneEvidence(lane))} |`,
		);
	}

	const pending = input.lanes.filter((lane) => lane.state === "pending");
	if (pending.length > 0) {
		lines.push("", "### 等待中 lanes", "");
		for (const lane of pending) {
			lines.push(`- **${escapeHtml(lane.lane)}**：${escapeHtml(lane.evidence)}`);
		}
	}

	if (input.explainLines && input.explainLines.length > 0) {
		lines.push("", "<details>", "<summary>判定溯源</summary>", "");
		for (const line of input.explainLines) {
			lines.push(`- ${escapeHtml(line)}`);
		}
		lines.push("", "</details>");
	}

	lines.push("", ...renderLedger(buildLedger(input)));
	return `${lines.join("\n")}\n`;
}

/** Render the short state used only when an existing sticky comment no longer matches a contract. */
export function renderInactiveComment(): string {
	return `${COMMENT_MARKER}\n\n## Gatekeeper · 已不再命中\n\n此 PR 当前未命中任何契约。\n`;
}

function byCreationTime(left: GitHubIssueComment, right: GitHubIssueComment): number {
	return left.created_at.localeCompare(right.created_at) || left.id - right.id;
}

/**
 * Decide whether the provider should POST, PATCH, or do nothing. When the
 * authenticated author is unknown, every marker is returned as an ordered
 * permission-probe candidate; the command layer tries each candidate and may
 * create only after every candidate rejects the PATCH with 403/404.
 */
export function planCommentUpsert(input: CommentUpsertInput): CommentUpsertPlan {
	const createIfMissing = input.createIfMissing ?? true;
	const authorLogin = input.authorLogin?.trim().toLowerCase() || undefined;
	const marked = input.comments.filter((comment) => comment.body?.includes(COMMENT_MARKER)).sort(byCreationTime);

	if (!authorLogin) {
		const candidateCommentIds = marked.map((comment) => comment.id);
		const warnings =
			marked.length > 0
				? [`未提供评论作者；将按顺序探测 ${marked.length} 条 Gatekeeper marker comments 的更新权限。`]
				: [];
		if (candidateCommentIds.length > 0) {
			return {
				action: "update",
				commentId: candidateCommentIds[0] ?? null,
				candidateCommentIds,
				createIfMissing,
				body: input.body,
				warnings,
			};
		}
		if (!createIfMissing) {
			return {
				action: "none",
				commentId: null,
				candidateCommentIds,
				createIfMissing,
				body: null,
				warnings,
			};
		}
		return {
			action: "create",
			commentId: null,
			candidateCommentIds,
			createIfMissing,
			body: input.body,
			warnings,
		};
	}

	const owned = marked.filter((comment) => comment.user?.login.toLowerCase() === authorLogin).sort(byCreationTime);
	const foreign = marked.filter((comment) => comment.user?.login.toLowerCase() !== authorLogin);
	const warnings: string[] = [];
	if (foreign.length > 0) {
		warnings.push(`发现 ${foreign.length} 条其他作者的 Gatekeeper marker comments；不会更新这些评论。`);
	}
	if (owned.length > 1) {
		warnings.push(`发现 ${owned.length} 条自有 Gatekeeper sticky comments；将更新最早的评论并保留其余重复项。`);
	}
	const existing = owned[0];
	const candidateCommentIds = existing ? [existing.id] : [];

	if (!existing) {
		if (!createIfMissing) {
			return { action: "none", commentId: null, candidateCommentIds, createIfMissing, body: null, warnings };
		}
		return {
			action: "create",
			commentId: null,
			candidateCommentIds,
			createIfMissing,
			body: input.body,
			warnings,
		};
	}

	if (existing.body === input.body) {
		return { action: "none", commentId: existing.id, candidateCommentIds, createIfMissing, body: null, warnings };
	}

	return {
		action: "update",
		commentId: existing.id,
		candidateCommentIds,
		createIfMissing,
		body: input.body,
		warnings,
	};
}
