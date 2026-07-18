import { afterEach, describe, expect, it, vi } from "vitest";

import { aggregateStats, parseLedgerComments, parseLedgerJsonl, runStats } from "../src/commands/stats.js";
import type { GitHubFetch } from "../src/providers/github.js";
import { COMMENT_MARKER, type GatekeeperLedger } from "../src/render/comment.js";

function ledger(
	pr: number,
	options: {
		decision?: "pass" | "warn" | "block";
		contracts?: string[];
		issues?: number[];
		override?: boolean;
	} = {},
): GatekeeperLedger {
	return {
		schema_version: 1,
		pr: { number: pr, url: `https://github.com/acme/app/pull/${pr}` },
		issues: (options.issues ?? []).map((number) => ({
			number,
			url: `https://github.com/acme/app/issues/${number}`,
		})),
		verdict: {
			decision: options.decision ?? "block",
			gate_state: options.decision === "block" || options.decision === undefined ? "fail" : "pass",
			required: 1,
			total: 1,
			repo: "acme/app",
			touched_contracts: options.contracts ?? ["public-api"],
			forbidden_edits: 0,
		},
		lanes: [],
		override: options.override ? { label: "gatekeeper:override", actor: "maintainer" } : null,
		timestamp: "2026-07-18T00:00:00Z",
	};
}

function comment(id: number, body: string | null) {
	return { id, body };
}

function ledgerComment(id: number, value: GatekeeperLedger): ReturnType<typeof comment> {
	return comment(id, `${COMMENT_MARKER}\n\n\`\`\`json gatekeeper-ledger\n${JSON.stringify(value)}\n\`\`\`\n`);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("stats ledger harvesting", () => {
	it("filters by marker and tolerates a damaged fenced JSON block", () => {
		const parsed = parseLedgerComments(
			[
				ledgerComment(1, ledger(42)),
				comment(2, `${COMMENT_MARKER}\n\n\`\`\`json gatekeeper-ledger\n{bad\n\`\`\``),
				comment(3, "ordinary discussion without the marker"),
			],
			42,
		);

		expect(parsed.ledgers).toEqual([ledger(42)]);
		expect(parsed.unparsable).toHaveLength(1);
		expect(parsed.unparsable[0]).toMatchObject({ pr: 42, commentId: 2 });
		expect(parsed.unparsable[0]?.reason).toContain("invalid ledger JSON");
	});

	it("treats a marker without a ledger block as unparsable and continues", () => {
		const parsed = parseLedgerComments(
			[comment(10, `${COMMENT_MARKER}\nno machine block`), ledgerComment(11, ledger(7))],
			7,
		);

		expect(parsed.ledgers).toHaveLength(1);
		expect(parsed.unparsable).toEqual([
			{
				pr: 7,
				commentId: 10,
				line: null,
				reason: "marker comment has no fenced json gatekeeper-ledger block",
			},
		]);
	});

	it("records invalid local JSONL lines without aborting valid rounds", () => {
		const parsed = parseLedgerJsonl(`${JSON.stringify(ledger(1))}\nnot-json\n${JSON.stringify(ledger(2))}\n`);

		expect(parsed.ledgers.map((item) => item.pr.number)).toEqual([1, 2]);
		expect(parsed.unparsable).toHaveLength(1);
		expect(parsed.unparsable[0]).toMatchObject({ line: 2, commentId: null });
	});
});

describe("stats aggregation", () => {
	it("aggregates PR hit rate, contracts, levels, overrides, and linked issue rounds", () => {
		const rounds = [
			ledger(1, { contracts: ["public-api", "artifact-manifest"], issues: [9] }),
			ledger(1, { contracts: ["public-api"], issues: [9], override: true }),
			ledger(2, { decision: "warn", contracts: ["artifact-manifest"], issues: [9, 10] }),
		];
		const unparsable = [{ pr: 3, commentId: 88, line: null, reason: "broken" }];

		const report = aggregateStats(rounds, 4, unparsable);

		expect(report).toMatchObject({
			totalPrs: 4,
			matchedPrs: 2,
			hitRate: 0.5,
			rounds: 3,
			byLevel: { block: 1, warn: 1, override: 1, pass: 0 },
			unparsable,
		});
		expect(report.byContract).toEqual([
			{ contract: "artifact-manifest", count: 2 },
			{ contract: "public-api", count: 2 },
		]);
		expect(report.issues).toEqual([
			{ issue: "acme/app#10", prs: ["acme/app#2"], rounds: 1 },
			{ issue: "acme/app#9", prs: ["acme/app#1", "acme/app#2"], rounds: 3 },
		]);
	});

	it("harvests merged GitHub PR comments through the paginated REST source", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/pulls?")) {
				return new Response(
					JSON.stringify([
						{ number: 1, merged_at: "2026-07-18T00:00:00Z", updated_at: "2026-07-18T00:01:00Z" },
						{ number: 2, merged_at: "2026-07-18T00:02:00Z", updated_at: "2026-07-18T00:03:00Z" },
						{ number: 3, merged_at: null, updated_at: "2026-07-18T00:04:00Z" },
					]),
				);
			}
			if (url.includes("/issues/1/comments")) {
				return new Response(JSON.stringify([ledgerComment(101, ledger(1))]));
			}
			if (url.includes("/issues/2/comments")) {
				return new Response(
					JSON.stringify([comment(102, `${COMMENT_MARKER}\n\`\`\`json gatekeeper-ledger\n{bad\n\`\`\``)]),
				);
			}
			throw new Error(`unexpected URL ${url}`);
		});
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const exitCode = await runStats({ source: "github", repo: "acme/app", token: "token", json: true }, "/workspace", {
			fetch: fetchMock as unknown as GitHubFetch,
			env: { GITHUB_API_URL: "https://api.github.test" },
		});

		expect(exitCode).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const report = JSON.parse(stdout.mock.calls.map(([message]) => String(message)).join("")) as Record<
			string,
			unknown
		>;
		expect(report).toMatchObject({ totalPrs: 2, matchedPrs: 1, hitRate: 0.5, rounds: 1 });
		expect(report.unparsable).toHaveLength(1);
	});
});
