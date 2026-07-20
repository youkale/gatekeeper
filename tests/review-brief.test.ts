import { describe, expect, it } from "vitest";

import {
	type RenderFixBriefInput,
	type RenderIncrementalReviewBriefInput,
	type RenderReviewBriefInput,
	renderFixBrief,
	renderIncrementalReviewBrief,
	renderReviewBrief,
} from "../src/render/reviewBrief.js";
import { reviewVerdictSchema } from "../src/review/verdict.js";

const CONTRACT = { resultPath: "out/RESULT.json", progressPath: "out/PROGRESS.md" };

// Reflected from src/review/verdict.ts's reviewVerdictSchema, not hand-copied -- the same technique
// tests/review-aggregate.test.ts uses to validate minted ids against blockerReferenceSchema (see its
// blockerIdSchema constant). A hand-copied literal list would silently drift out of sync if verdict.ts's
// blocker `category` enum ever changes; this can't.
const VERDICT_CATEGORY_OPTIONS = reviewVerdictSchema.innerType().shape.blockers.element.shape.category.unwrap().options;

const ROLE_CARD = "# code-reviewer\n\nIndependent, read-only code reviewer.";

function baseReviewInput(overrides: Partial<RenderReviewBriefInput> = {}): RenderReviewBriefInput {
	return {
		round: 1,
		runToken: "rv1_test-token",
		roleCard: ROLE_CARD,
		diffScope: { summary: "acme/widgets base 3f2a1c..HEAD", command: "git diff 3f2a1c...HEAD" },
		subject: {
			deliveryReport: "Added a CSV exporter for widgets.",
			selfReportedRisks: "Not sure the streaming rewrite is safe under low memory.",
		},
		...overrides,
	};
}

function baseIncrementalInput(
	overrides: Partial<RenderIncrementalReviewBriefInput> = {},
): RenderIncrementalReviewBriefInput {
	return {
		...baseReviewInput(),
		round: 2,
		fixCommitRange: { summary: "fix commits abc123..def456", command: "git diff abc123...def456" },
		priorBlockers: [
			{ id: "B-r1-L1-01", title: "Missing null check", file: "src/exporter.ts", line: 42, evidence: "no guard on row" },
		],
		...overrides,
	};
}

function baseFixInput(overrides: Partial<RenderFixBriefInput> = {}): RenderFixBriefInput {
	return {
		blockers: [
			{
				id: "B-r1-L1-01",
				title: "Missing null check",
				file: "src/exporter.ts",
				line: 42,
				evidence: "no guard on row",
				suggested_fix: "add an early return when row is null",
			},
		],
		contract: CONTRACT,
		...overrides,
	};
}

function assertNoLocalAbsolutePaths(output: string): void {
	// A rendered brief must never leak a local dev-machine path (e.g. /Users/..., /home/..., C:\...) -- every path
	// it mentions must come from caller-supplied, repo-relative data.
	expect(output).not.toMatch(/\/Users\//);
	expect(output).not.toMatch(/\/home\//);
	expect(output).not.toMatch(/[A-Za-z]:\\/);
}

describe("renderReviewBrief", () => {
	it("renders the role card, diff scope, subject material, and VERDICT.json contract", () => {
		const output = renderReviewBrief(baseReviewInput());

		expect(output).toContain("# Gatekeeper Review 简报（第 1 轮）");
		expect(output).toContain("Independent, read-only code reviewer.");
		expect(output).toContain("git diff 3f2a1c...HEAD");
		expect(output).toContain("Added a CSV exporter for widgets.");
		expect(output).toContain("Not sure the streaming rewrite is safe under low memory.");
		expect(output).toContain("rv1_test-token");
		expect(output).toContain("本次 round: 1");
		expect(output).toContain("不得修改仓库任何文件");

		// VERDICT.json field table matches src/review/verdict.ts's reviewVerdictSchema field-for-field.
		for (const field of [
			"apiVersion",
			"verdict",
			"run_token",
			"round",
			"blockers",
			"non_blockers",
			"out_of_scope",
			"id",
			"ref",
			"file",
			"line",
			"title",
			"evidence",
			"suggested_fix",
			"category",
		]) {
			expect(output).toContain(field);
		}
		for (const category of VERDICT_CATEGORY_OPTIONS) {
			expect(output).toContain(category);
		}

		assertNoLocalAbsolutePaths(output);
	});

	it("fences role card and subject text that itself contains a triple-backtick fence without escaping the brief", () => {
		const trickyRoleCard = "before\n```\nfenced content\n```\nafter";
		const output = renderReviewBrief(
			baseReviewInput({
				roleCard: trickyRoleCard,
				subject: {
					deliveryReport: "```\nsneaky\n```",
					selfReportedRisks: "none",
				},
			}),
		);

		// The dynamic fence must be longer than any backtick run already present in the embedded text, so the
		// embedded ``` never terminates the outer fence early.
		expect(output).toContain("````");
		expect(output).toContain("fenced content");
		expect(output).toContain("sneaky");
	});

	it("fences text containing a run of 4+ consecutive backticks without escaping the brief", () => {
		// A run longer than a plain triple-backtick fence (e.g. someone pasting an already-fenced-with-N-backticks
		// markdown block) must still be strictly out-fenced -- the dynamic fence always grows to
		// longestBacktickRun(text) + 1, not a fixed 3.
		const output = renderReviewBrief(
			baseReviewInput({
				roleCard: "before\n`````\nfive backticks fenced content\n`````\nafter",
				subject: {
					deliveryReport: "````\nfour backticks fenced content\n````",
					selfReportedRisks: "none",
				},
			}),
		);

		// longestBacktickRun(roleCard) === 5, so its outer fence must be exactly 6 backticks on their own line.
		expect(output).toMatch(/^ {2}`{6}$/m);
		expect(output).toContain("five backticks fenced content");
		// longestBacktickRun(deliveryReport) === 4, so its outer fence must be exactly 5 backticks on their own line.
		expect(output).toMatch(/^ {2}`{5}$/m);
		expect(output).toContain("four backticks fenced content");
	});

	it("sanitizes inline diff-scope fields (backticks and embedded newlines)", () => {
		const output = renderReviewBrief(
			baseReviewInput({
				diffScope: { summary: "break `out` of\nthe span", command: "echo `oops`" },
			}),
		);
		expect(output).toContain("break 'out' of the span");
		expect(output).toContain("echo 'oops'");
		expect(output).not.toContain("break `out` of");
	});
});

describe("renderIncrementalReviewBrief", () => {
	it("renders prior blockers, fix commit range, and the scope-lock instruction", () => {
		const output = renderIncrementalReviewBrief(baseIncrementalInput());

		expect(output).toContain("# Gatekeeper Review 简报（第 2 轮，增量复审）");
		expect(output).toContain("git diff abc123...def456");
		expect(output).toContain("B-r1-L1-01");
		expect(output).toContain("Missing null check");
		expect(output).toContain("src/exporter.ts:42");
		expect(output).toContain("no guard on row");
		expect(output).toContain(
			"只判定 (a) 各 id 是否正确修复 (b) 修复是否引入新 blocker；新发现须 ref 关联或如实作为新条目，不得重开已通过面。",
		);
		expect(output).toContain("不得修改仓库任何文件");
		expect(output).toContain("本次 round: 2");

		assertNoLocalAbsolutePaths(output);
	});

	it("renders a placeholder when there are no prior unwaived blockers", () => {
		const output = renderIncrementalReviewBrief(baseIncrementalInput({ priorBlockers: [] }));
		expect(output).toContain("## 上一轮未 Waive 的 Blocker");
		expect(output).toContain("(none)");
	});

	it("sanitizes prior-blocker title/file text (backticks and embedded newlines)", () => {
		const output = renderIncrementalReviewBrief(
			baseIncrementalInput({
				priorBlockers: [
					{
						id: "B-r1-L1-01",
						title: "Break `out`\nof the list item",
						file: "src/a.ts",
						line: 1,
						evidence: "e",
					},
				],
			}),
		);
		expect(output).toContain("Break 'out' of the list item");
		expect(output).not.toContain("Break `out`\nof the list item");
	});
});

describe("renderFixBrief", () => {
	it("renders the blocker list (with suggested_fix), the fix-scope instruction, and the RESULT.json contract", () => {
		const output = renderFixBrief(baseFixInput());

		expect(output).toContain("B-r1-L1-01");
		expect(output).toContain("Missing null check");
		expect(output).toContain("src/exporter.ts");
		expect(output).toContain("add an early return when row is null");
		expect(output).toContain("派回原编码者增量修复勿重构无关面");
		expect(output).toContain("out/RESULT.json");
		expect(output).toContain("out/PROGRESS.md");
		expect(output).toContain('"apiVersion": "gatekeeper/v1"');
		expect(output).toContain('"status": "delivered"');
		expect(output).toContain('"summary"');
		expect(output).toContain('apiVersion` 必须是字面量 `"gatekeeper/v1"`');
		expect(output).toContain('status` 必须是 `"delivered"` 或 `"blocked"`');
		expect(output).toContain("非 WIP 提交");

		assertNoLocalAbsolutePaths(output);
	});

	it("renders a placeholder when there are no blockers to fix", () => {
		const output = renderFixBrief(baseFixInput({ blockers: [] }));
		expect(output).toContain("## 待修复 Blocker");
		expect(output).toContain("(none)");
	});

	it("omits the suggested_fix line when a blocker has none", () => {
		const output = renderFixBrief(
			baseFixInput({
				blockers: [{ id: "B-r1-L1-01", title: "No suggestion", file: "src/a.ts", evidence: "e" }],
			}),
		);
		expect(output).not.toContain("suggested_fix:");
	});

	it("sanitizes blocker title/evidence text (backticks and embedded newlines)", () => {
		const output = renderFixBrief(
			baseFixInput({
				blockers: [
					{
						id: "B-r1-L1-01",
						title: "Break `out`\nof the heading",
						file: "src/a.ts",
						evidence: "evidence with `backticks`\nand a newline",
					},
				],
			}),
		);
		expect(output).toContain("Break 'out' of the heading");
		expect(output).toContain("evidence with 'backticks' and a newline");
		expect(output).not.toContain("Break `out`\nof the heading");
	});
});
