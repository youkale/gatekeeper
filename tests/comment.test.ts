import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyCommentPlan } from "../src/commands/gate.js";
import type { Verdict } from "../src/engine/types.js";
import { evaluateLane } from "../src/gate/lanes.js";
import { InfraError } from "../src/providers/github.js";
import {
	buildLedger,
	COMMENT_MARKER,
	type GitHubIssueComment,
	planCommentUpsert,
	renderComment,
	renderInactiveComment,
} from "../src/render/comment.js";

const verdict: Verdict = {
	decision: "block",
	repo: "acme/payments",
	touched: [
		{
			contract: "payments-api",
			level: "breaking-review-required",
			enforcement: "block",
			effectiveEnforcement: "block",
			requires: { m: 3, lanes: ["human", "coderabbit", "copilot", "greptile"] },
			bindings: [],
			consumers: [
				{ repo: "acme/web", role: "consumer", verify: "npm test" },
				{ repo: "acme/worker", role: "producer", verify: null },
			],
		},
	],
	forbiddenEdits: [],
	effectivePolicy: { enforcementOverride: null },
};

const renderInput = {
	verdict,
	gate: { state: "pending" as const, m: 3, n: 4 },
	lanes: [
		{ lane: "human", state: "pass" as const, evidence: "alice approved head abc123", type: "human-approval" as const },
		{
			lane: "coderabbit",
			state: "fail" as const,
			evidence: "latest review was COMMENTED | follow-up required",
			type: "review" as const,
		},
		{ lane: "copilot", state: "pending" as const, evidence: "no matching review", type: "review" as const },
		{
			lane: "greptile",
			state: "pass" as const,
			evidence: "ready to merge",
			type: "comment-scan" as const,
		},
	],
	pr: { number: 42, url: "https://github.com/acme/payments/pull/42" },
	linkedIssues: [17, { number: 18, url: "https://github.com/acme/payments/issues/18" }],
	override: null,
	timestamp: "2026-07-18T02:03:04Z",
	explainLines: ["src/api.ts -> contract payments-api", "untrusted <details> is escaped"],
	repositoryUrl: "https://github.com/acme/payments/",
};

const fixtureComments = JSON.parse(
	readFileSync(new URL("../fixtures/github/comments.json", import.meta.url), "utf8"),
) as Array<GitHubIssueComment & { updated_at: string }>;

afterEach(() => {
	vi.restoreAllMocks();
});

const commentAuthorLogin = "gatekeeper[bot]";

describe("sticky comment rendering", () => {
	it("snapshots the human Markdown and fenced ledger", () => {
		const body = renderComment(renderInput);
		const humanMarkdown = body.slice(0, body.indexOf("```json gatekeeper-ledger"));

		expect(humanMarkdown).toMatchInlineSnapshot(`
			"<!-- gatekeeper:verdict -->

			## Gatekeeper · ⏳ PENDING

			PR: [#42](https://github.com/acme/payments/pull/42)
			关联 issue: [#17](https://github.com/acme/payments/issues/17), [#18](https://github.com/acme/payments/issues/18)

			### 判定

			| 契约 | 消费方 | 要求 |
			| --- | --- | --- |
			| payments-api | acme/web (consumer; verify: npm test)<br>acme/worker (producer) | 3-of-4: human, coderabbit, copilot, greptile |

			### Lanes

			| Lane | 状态 | 证据 |
			| --- | --- | --- |
			| human | pass | alice approved head abc123 |
			| coderabbit | fail | latest review was COMMENTED \\| follow-up required |
			| copilot | pending | no matching review |
			| greptile | pass | ready to merge (text-matched) |

			### 等待中 lanes

			- **copilot**：no matching review

			<details>
			<summary>判定溯源</summary>

			- src/api.ts -&gt; contract payments-api
			- untrusted &lt;details&gt; is escaped

			</details>

			"
		`);

		const ledgerMatch = body.match(/```json gatekeeper-ledger\n([\s\S]*?)\n```/);
		expect(ledgerMatch).not.toBeNull();
		expect(JSON.parse(ledgerMatch?.[1] ?? "{}")).toEqual(buildLedger(renderInput));
	});

	it("renders the short no-longer-matched state without a ledger", () => {
		expect(renderInactiveComment()).toMatchInlineSnapshot(`
			"<!-- gatekeeper:verdict -->

			## Gatekeeper · 已不再命中

			此 PR 当前未命中任何契约。
			"
		`);
	});

	it("does not duplicate text-matched from the real comment-scan evaluator", () => {
		const result = evaluateLane(
			{
				lane: "greptile",
				type: "comment-scan",
				author: "greptile-apps[bot]",
				body_matches: "ready to merge",
				ignore_case: true,
			},
			{
				reviews: [],
				checkRuns: [],
				statuses: [],
				comments: fixtureComments,
				headSha: "abc123",
				headPushedAt: null,
			},
		);
		const input = { ...renderInput, lanes: [{ ...result, type: "comment-scan" as const }] };
		const ledger = buildLedger(input);

		expect(result.evidence).toContain("(text-matched)");
		expect(ledger.lanes[0]).toMatchObject({ evidence: result.evidence, text_matched: true });
		expect(renderComment(input)).not.toContain("(text-matched) (text-matched)");
	});
});

describe("sticky comment upsert planning", () => {
	it("plans create when no marker exists", () => {
		const comments = fixtureComments.filter((comment) => !comment.body?.includes(COMMENT_MARKER));

		expect(planCommentUpsert({ comments, body: "new body", authorLogin: commentAuthorLogin })).toEqual({
			action: "create",
			commentId: null,
			candidateCommentIds: [],
			createIfMissing: true,
			body: "new body",
			warnings: [],
		});
	});

	it("does not create the inactive state when there was no old sticky comment", () => {
		expect(
			planCommentUpsert({
				comments: [],
				body: renderInactiveComment(),
				authorLogin: commentAuthorLogin,
				createIfMissing: false,
			}),
		).toEqual({
			action: "none",
			commentId: null,
			candidateCommentIds: [],
			createIfMissing: false,
			body: null,
			warnings: [],
		});
	});

	it("plans update for one marker and none when its body is already current", () => {
		const existing = fixtureComments.find((comment) => comment.id === 9100);
		expect(existing).toBeDefined();
		if (!existing) {
			throw new Error("fixture must contain comment 9100");
		}

		expect(
			planCommentUpsert({ comments: [existing], body: "new body", authorLogin: commentAuthorLogin }),
		).toMatchObject({
			action: "update",
			commentId: 9100,
			candidateCommentIds: [9100],
			createIfMissing: true,
			body: "new body",
			warnings: [],
		});
		expect(
			planCommentUpsert({ comments: [existing], body: existing.body ?? "", authorLogin: commentAuthorLogin }),
		).toEqual({
			action: "none",
			commentId: 9100,
			candidateCommentIds: [9100],
			createIfMissing: true,
			body: null,
			warnings: [],
		});
	});

	it("chooses the earliest comment and warns on marker collisions", () => {
		const markerComments = fixtureComments.filter((comment) => comment.body?.includes(COMMENT_MARKER)).reverse();

		const plan = planCommentUpsert({ comments: markerComments, body: "replacement", authorLogin: commentAuthorLogin });

		expect(plan).toEqual({
			action: "update",
			commentId: 9100,
			candidateCommentIds: [9100],
			createIfMissing: true,
			body: "replacement",
			warnings: ["发现 2 条自有 Gatekeeper sticky comments；将更新最早的评论并保留其余重复项。"],
		});
	});

	it("ignores foreign markers before and after owned comments", () => {
		const owned = fixtureComments.filter((comment) => comment.body?.includes(COMMENT_MARKER));
		const foreignBefore: GitHubIssueComment = {
			id: 8000,
			body: `${COMMENT_MARKER}\nforeign before`,
			created_at: "2026-07-18T00:00:00Z",
			user: { login: "mallory" },
		};
		const foreignAfter: GitHubIssueComment = {
			id: 9900,
			body: `${COMMENT_MARKER}\nforeign after`,
			created_at: "2026-07-18T03:00:00Z",
			user: { login: "eve" },
		};

		expect(
			planCommentUpsert({
				comments: [foreignAfter, ...owned.reverse(), foreignBefore],
				body: "replacement",
				authorLogin: "Gatekeeper[Bot]",
			}),
		).toEqual({
			action: "update",
			commentId: 9100,
			candidateCommentIds: [9100],
			createIfMissing: true,
			body: "replacement",
			warnings: [
				"发现 2 条其他作者的 Gatekeeper marker comments；不会更新这些评论。",
				"发现 2 条自有 Gatekeeper sticky comments；将更新最早的评论并保留其余重复项。",
			],
		});
	});

	it("creates only an active comment when all markers are foreign", () => {
		const foreign: GitHubIssueComment = {
			id: 8000,
			body: `${COMMENT_MARKER}\nnot ours`,
			created_at: "2026-07-18T00:00:00Z",
			user: { login: "mallory" },
		};
		const warning = "发现 1 条其他作者的 Gatekeeper marker comments；不会更新这些评论。";

		expect(planCommentUpsert({ comments: [foreign], body: "active body", authorLogin: commentAuthorLogin })).toEqual({
			action: "create",
			commentId: null,
			candidateCommentIds: [],
			createIfMissing: true,
			body: "active body",
			warnings: [warning],
		});
		expect(
			planCommentUpsert({
				comments: [foreign],
				body: renderInactiveComment(),
				authorLogin: commentAuthorLogin,
				createIfMissing: false,
			}),
		).toEqual({
			action: "none",
			commentId: null,
			candidateCommentIds: [],
			createIfMissing: false,
			body: null,
			warnings: [warning],
		});
	});

	it("orders every marker as a permission probe when the author is unknown", () => {
		const own = fixtureComments.find((comment) => comment.id === 9100);
		expect(own).toBeDefined();
		if (!own) {
			throw new Error("fixture must contain comment 9100");
		}
		const malicious: GitHubIssueComment = {
			id: 8000,
			body: `${COMMENT_MARKER}\nmalicious canonical claim`,
			created_at: "2026-07-18T00:00:00Z",
			user: { login: "mallory" },
		};

		expect(planCommentUpsert({ comments: [own, malicious], body: malicious.body ?? "" })).toEqual({
			action: "update",
			commentId: 8000,
			candidateCommentIds: [8000, 9100],
			createIfMissing: true,
			body: malicious.body,
			warnings: ["未提供评论作者；将按顺序探测 2 条 Gatekeeper marker comments 的更新权限。"],
		});
	});

	it("carries active versus inactive fallback intent for an unknown marker author", () => {
		const marker: GitHubIssueComment = {
			id: 8000,
			body: `${COMMENT_MARKER}\nexisting body`,
			created_at: "2026-07-18T00:00:00Z",
			user: { login: "mallory" },
		};
		const warning = "未提供评论作者；将按顺序探测 1 条 Gatekeeper marker comments 的更新权限。";

		expect(planCommentUpsert({ comments: [marker], body: marker.body ?? "" })).toEqual({
			action: "update",
			commentId: 8000,
			candidateCommentIds: [8000],
			createIfMissing: true,
			body: marker.body,
			warnings: [warning],
		});
		expect(planCommentUpsert({ comments: [marker], body: renderInactiveComment(), createIfMissing: false })).toEqual({
			action: "update",
			commentId: 8000,
			candidateCommentIds: [8000],
			createIfMissing: false,
			body: renderInactiveComment(),
			warnings: [warning],
		});
	});
});

describe("sticky comment permission-probe execution", () => {
	function apiComment(id: number, body: string) {
		return {
			id,
			body,
			user: { login: "gatekeeper[bot]" },
			created_at: "2026-07-18T01:00:00Z",
			updated_at: "2026-07-18T01:00:00Z",
		};
	}

	function notEditable(commentId: number): InfraError {
		return new InfraError(`cannot edit ${commentId}`, {
			kind: "http",
			operation: "update issue comment",
			status: 403,
		});
	}

	it("skips a foreign marker and updates the next editable candidate", async () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const malicious: GitHubIssueComment = {
			id: 8000,
			body: `${COMMENT_MARKER}\nforeign`,
			created_at: "2026-07-18T00:00:00Z",
			user: { login: "mallory" },
		};
		const owned = fixtureComments.find((comment) => comment.id === 9100);
		expect(owned).toBeDefined();
		if (!owned) {
			throw new Error("fixture must contain comment 9100");
		}
		const plan = planCommentUpsert({ comments: [owned, malicious], body: "replacement" });
		const updateIssueComment = vi.fn(async (commentId: number, body: string) => {
			if (commentId === malicious.id) {
				throw notEditable(commentId);
			}
			return apiComment(commentId, body);
		});
		const createIssueComment = vi.fn(async (_issue: number, body: string) => apiComment(9300, body));

		await expect(applyCommentPlan({ updateIssueComment, createIssueComment }, 42, plan)).resolves.toEqual({
			action: "update",
			commentId: 9100,
		});
		expect(updateIssueComment.mock.calls.map(([commentId]) => commentId)).toEqual([8000, 9100]);
		expect(createIssueComment).not.toHaveBeenCalled();
	});

	it("creates an active sticky after every marker candidate is foreign", async () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const foreign: GitHubIssueComment = {
			id: 8000,
			body: `${COMMENT_MARKER}\nforeign`,
			created_at: "2026-07-18T00:00:00Z",
			user: { login: "mallory" },
		};
		const plan = planCommentUpsert({ comments: [foreign], body: "active" });
		const updateIssueComment = vi.fn(async (commentId: number) => {
			throw notEditable(commentId);
		});
		const createIssueComment = vi.fn(async (_issue: number, body: string) => apiComment(9300, body));

		await expect(applyCommentPlan({ updateIssueComment, createIssueComment }, 42, plan)).resolves.toEqual({
			action: "create",
			commentId: 9300,
		});
		expect(createIssueComment).toHaveBeenCalledWith(42, "active");
	});

	it("does not create an inactive sticky after foreign probes fail", async () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const foreign: GitHubIssueComment = {
			id: 8000,
			body: `${COMMENT_MARKER}\nforeign`,
			created_at: "2026-07-18T00:00:00Z",
			user: { login: "mallory" },
		};
		const plan = planCommentUpsert({
			comments: [foreign],
			body: renderInactiveComment(),
			createIfMissing: false,
		});
		const updateIssueComment = vi.fn(async (commentId: number) => {
			throw notEditable(commentId);
		});
		const createIssueComment = vi.fn(async (_issue: number, body: string) => apiComment(9300, body));

		await expect(applyCommentPlan({ updateIssueComment, createIssueComment }, 42, plan)).resolves.toEqual({
			action: "none",
			commentId: null,
		});
		expect(createIssueComment).not.toHaveBeenCalled();
	});
});
