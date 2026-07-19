import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { aggregateStats, parseLedgerComments, parseLedgerJsonl, runStats } from "../src/commands/stats.js";
import { upsertControl } from "../src/config/controls.js";
import { saveRepos } from "../src/config/repos.js";
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
				page: null,
				itemIndex: null,
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
		const unparsable = [{ pr: 3, commentId: 88, line: null, page: null, itemIndex: null, reason: "broken" }];

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

		// A real (but non-git) directory, not the literal nonexistent path
		// "/workspace" this test used before (C1): `repo` is given explicitly
		// so cwd's own git-root resolution is irrelevant to this test's
		// assertions, but it must still be a *real* directory -- a nonexistent
		// one now correctly classifies as a git "infra" failure (not "confirmed
		// not a repo"), which is fail-loud for a tool-mode command like stats.
		const cwd = await mkdtemp(path.join(tmpdir(), "gatekeeper-stats-cwd-"));
		try {
			const exitCode = await runStats({ source: "github", repo: "acme/app", token: "token", json: true }, cwd, {
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
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps valid REST comments when another envelope on the page is malformed", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/pulls?")) {
				return new Response(
					JSON.stringify([{ number: 7, merged_at: "2026-07-18T00:00:00Z", updated_at: "2026-07-18T00:01:00Z" }]),
				);
			}
			if (url.includes("/issues/7/comments")) {
				return new Response(
					JSON.stringify([
						ledgerComment(701, ledger(7)),
						{ id: 702, body: { malformed: true } },
						ledgerComment(703, ledger(7, { decision: "warn" })),
					]),
				);
			}
			throw new Error(`unexpected URL ${url}`);
		});
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		// See the identical rationale in the previous test: a real (but
		// non-git) directory, not the nonexistent literal "/workspace".
		const cwd = await mkdtemp(path.join(tmpdir(), "gatekeeper-stats-cwd-"));
		try {
			const exitCode = await runStats({ source: "github", repo: "acme/app", json: true }, cwd, {
				fetch: fetchMock as unknown as GitHubFetch,
				env: { GITHUB_API_URL: "https://api.github.test" },
			});

			expect(exitCode).toBe(0);
			const report = JSON.parse(stdout.mock.calls.map(([message]) => String(message)).join("")) as {
				rounds: number;
				unparsable: Array<Record<string, unknown>>;
			};
			expect(report.rounds).toBe(2);
			expect(report.unparsable).toEqual([
				{
					pr: 7,
					commentId: 702,
					line: null,
					page: 1,
					itemIndex: 1,
					reason: "GitHub comments response item 1 is malformed",
				},
			]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

describe("stats: --source github falls back to the origin remote after a self-match discovery (B7)", () => {
	it("resolves repo via git remote origin with zero --repo, inside a hub's own root (self-match, no repos.yaml entry)", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "gatekeeper-stats-selfmatch-"));
		try {
			const hubRoot = path.join(base, "hub");
			await mkdir(hubRoot, { recursive: true });
			git(hubRoot, ["init", "-q"]);
			git(hubRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);
			git(hubRoot, ["remote", "add", "origin", "git@github.com:acme/app.git"]);

			const registryDir = path.join(hubRoot, "governance", "registry");
			await mkdir(path.join(registryDir, "contracts"), { recursive: true });
			await writeFile(
				path.join(registryDir, "policy.yaml"),
				"apiVersion: gatekeeper/v1\nlanes: {}\nlevels:\n  notify:\n    enforcement: warn\n    require: {}\n",
				"utf8",
			);
			await saveRepos(registryDir, []); // a control repo never adopts itself

			const configDir = path.join(base, "config");
			const env = { GATEKEEPER_CONFIG_DIR: configDir, GITHUB_API_URL: "https://api.github.test" };
			await upsertControl(
				{
					control: await realpath(hubRoot),
					registry: await realpath(registryDir),
					registered_at: "2026-07-20T00:00:00.000Z",
				},
				env,
			);

			const fetchMock = vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes("/pulls?")) {
					return new Response(JSON.stringify([]));
				}
				throw new Error(`unexpected URL ${url}`);
			});
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			// No --repo, no .gatekeeper.yml -- must resolve entirely through the
			// self-match branch of locateOwningControl (registry only, no repo
			// identity) plus resolveRepo's origin-remote auto-detection.
			const exitCode = await runStats({ source: "github", json: true }, hubRoot, {
				fetch: fetchMock as unknown as GitHubFetch,
				env,
			});

			expect(exitCode).toBe(0);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/repos/acme/app/pulls");
			const report = JSON.parse(stdout.mock.calls.map(([message]) => String(message)).join("")) as {
				totalPrs: number;
			};
			expect(report.totalPrs).toBe(0);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("does not attempt origin-remote fallback for --source local (never needs a repo)", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "gatekeeper-stats-local-norepo-"));
		try {
			// Not even a git repo -- --source local must not care.
			const fetchMock = vi.fn(async () => {
				throw new Error("must not fetch for --source local");
			});

			const exitCode = await runStats({ source: "local", file: "does-not-exist.jsonl" }, base, {
				fetch: fetchMock as unknown as GitHubFetch,
			});

			// Fails for the expected reason (missing ledger file), not a repo-resolution error.
			expect(exitCode).toBe(2);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});
