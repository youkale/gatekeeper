import { readFile } from "node:fs/promises";
import path from "node:path";

import { discoverConfigWithControlsIndex, resolveConfiguredField } from "../config/discover.js";
import { resolveRepo } from "../providers/gitdiff.js";
import type { GitHubFetch } from "../providers/github.js";
import { COMMENT_MARKER, type GatekeeperLedger } from "../render/comment.js";

const LEDGER_BLOCK = /```json gatekeeper-ledger\s*\n([\s\S]*?)\n```/;
const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;

export interface StatsOptions {
	source: "github" | "local";
	repo?: string;
	token?: string;
	file?: string;
	since?: string;
	json?: boolean;
}

export interface StatsComment {
	id: number;
	body: string | null;
}

export interface StatsUnparsable {
	pr: number | null;
	commentId: number | null;
	line: number | null;
	page: number | null;
	itemIndex: number | null;
	reason: string;
}

export interface ParsedLedgers {
	ledgers: GatekeeperLedger[];
	unparsable: StatsUnparsable[];
}

export interface StatsReport {
	totalPrs: number;
	matchedPrs: number;
	hitRate: number;
	rounds: number;
	byContract: Array<{ contract: string; count: number }>;
	byLevel: {
		block: number;
		warn: number;
		override: number;
		pass: number;
	};
	issues: Array<{ issue: string; prs: string[]; rounds: number }>;
	unparsable: StatsUnparsable[];
}

export interface StatsDependencies {
	fetch?: GitHubFetch;
	env?: NodeJS.ProcessEnv;
}

export class StatsError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(reason);
		this.name = "StatsError";
		this.reason = reason;
		if (options?.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ledgerError(path: string, expected: string): StatsError {
	return new StatsError(`ledger ${path} must be ${expected}`);
}

function validateLedger(value: unknown): GatekeeperLedger {
	if (!isRecord(value)) {
		throw ledgerError("$", "an object");
	}
	if (value.schema_version !== 1) {
		throw ledgerError("$.schema_version", "1");
	}
	if (!isRecord(value.pr) || !Number.isSafeInteger(value.pr.number) || (value.pr.number as number) <= 0) {
		throw ledgerError("$.pr.number", "a positive integer");
	}
	if (!Array.isArray(value.issues)) {
		throw ledgerError("$.issues", "an array");
	}
	for (const [index, issue] of value.issues.entries()) {
		if (!isRecord(issue) || !Number.isSafeInteger(issue.number) || (issue.number as number) <= 0) {
			throw ledgerError(`$.issues[${index}].number`, "a positive integer");
		}
	}
	if (!isRecord(value.verdict)) {
		throw ledgerError("$.verdict", "an object");
	}
	if (!(["pass", "warn", "block"] as unknown[]).includes(value.verdict.decision)) {
		throw ledgerError("$.verdict.decision", "pass, warn, or block");
	}
	if (typeof value.verdict.repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(value.verdict.repo)) {
		throw ledgerError("$.verdict.repo", "an org/name repository identity");
	}
	if (
		!Array.isArray(value.verdict.touched_contracts) ||
		value.verdict.touched_contracts.some((contract) => typeof contract !== "string" || contract.length === 0)
	) {
		throw ledgerError("$.verdict.touched_contracts", "an array of non-empty strings");
	}
	if (value.override !== null) {
		if (
			!isRecord(value.override) ||
			typeof value.override.label !== "string" ||
			!(value.override.actor === null || typeof value.override.actor === "string")
		) {
			throw ledgerError("$.override", "null or a label/actor object");
		}
	}
	return value as unknown as GatekeeperLedger;
}

function parseLedgerJson(json: string): GatekeeperLedger {
	let value: unknown;
	try {
		value = JSON.parse(json) as unknown;
	} catch (error) {
		throw new StatsError(`invalid ledger JSON: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}
	return validateLedger(value);
}

/** Parse marker comments without letting one damaged ledger abort harvesting. */
export function parseLedgerComments(comments: readonly StatsComment[], pullRequest?: number): ParsedLedgers {
	const ledgers: GatekeeperLedger[] = [];
	const unparsable: StatsUnparsable[] = [];
	for (const comment of comments) {
		if (!comment.body?.includes(COMMENT_MARKER)) {
			continue;
		}
		const block = comment.body.match(LEDGER_BLOCK);
		if (!block?.[1]) {
			unparsable.push({
				pr: pullRequest ?? null,
				commentId: comment.id,
				line: null,
				page: null,
				itemIndex: null,
				reason: "marker comment has no fenced json gatekeeper-ledger block",
			});
			continue;
		}
		try {
			const ledger = parseLedgerJson(block[1]);
			if (pullRequest !== undefined && ledger.pr.number !== pullRequest) {
				throw new StatsError(`ledger PR #${ledger.pr.number} does not match harvested PR #${pullRequest}`);
			}
			ledgers.push(ledger);
		} catch (error) {
			unparsable.push({
				pr: pullRequest ?? null,
				commentId: comment.id,
				line: null,
				page: null,
				itemIndex: null,
				reason: error instanceof StatsError ? error.reason : error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { ledgers, unparsable };
}

/** Parse the append-only local ledger, recording bad lines instead of aborting. */
export function parseLedgerJsonl(content: string): ParsedLedgers {
	const ledgers: GatekeeperLedger[] = [];
	const unparsable: StatsUnparsable[] = [];
	for (const [index, line] of content.split(/\r?\n/).entries()) {
		if (line.trim().length === 0) {
			continue;
		}
		try {
			ledgers.push(parseLedgerJson(line));
		} catch (error) {
			unparsable.push({
				pr: null,
				commentId: null,
				line: index + 1,
				page: null,
				itemIndex: null,
				reason: error instanceof StatsError ? error.reason : error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { ledgers, unparsable };
}

function pullRequestKey(ledger: GatekeeperLedger): string {
	return `${ledger.verdict.repo}#${ledger.pr.number}`;
}

/** Aggregate valid rounds. Counts are per ledger round; PR lists are de-duplicated. */
export function aggregateStats(
	ledgers: readonly GatekeeperLedger[],
	totalPrs = new Set(ledgers.map(pullRequestKey)).size,
	unparsable: StatsUnparsable[] = [],
): StatsReport {
	const matchedPullRequests = new Set<string>();
	const contracts = new Map<string, number>();
	const levels = { block: 0, warn: 0, override: 0, pass: 0 };
	const issues = new Map<string, { prs: Set<string>; rounds: number }>();

	for (const ledger of ledgers) {
		const pr = pullRequestKey(ledger);
		matchedPullRequests.add(pr);
		for (const contract of new Set(ledger.verdict.touched_contracts)) {
			contracts.set(contract, (contracts.get(contract) ?? 0) + 1);
		}
		if (ledger.override !== null) {
			levels.override += 1;
		} else {
			levels[ledger.verdict.decision] += 1;
		}
		for (const issue of new Set(ledger.issues.map((linked) => linked.number))) {
			const key = `${ledger.verdict.repo}#${issue}`;
			const aggregate = issues.get(key) ?? { prs: new Set<string>(), rounds: 0 };
			aggregate.prs.add(pr);
			aggregate.rounds += 1;
			issues.set(key, aggregate);
		}
	}

	return {
		totalPrs,
		matchedPrs: matchedPullRequests.size,
		hitRate: totalPrs === 0 ? 0 : matchedPullRequests.size / totalPrs,
		rounds: ledgers.length,
		byContract: [...contracts.entries()]
			.map(([contract, count]) => ({ contract, count }))
			.sort((left, right) => right.count - left.count || left.contract.localeCompare(right.contract)),
		byLevel: levels,
		issues: [...issues.entries()]
			.map(([issue, value]) => ({ issue, prs: [...value.prs].sort(), rounds: value.rounds }))
			.sort((left, right) => left.issue.localeCompare(right.issue)),
		unparsable,
	};
}

interface GitHubPullSummary {
	number: number;
	merged_at: string | null;
	updated_at: string;
}

function githubRepo(repo: string): { owner: string; name: string } {
	const match = repo.trim().match(/^([^/\s]+)\/([^/\s]+)$/);
	if (!match?.[1] || !match[2]) {
		throw new StatsError(`invalid GitHub repository identity ${JSON.stringify(repo)}; expected org/name`);
	}
	return { owner: match[1], name: match[2] };
}

function sinceTimestamp(since: string | undefined): number | undefined {
	if (since === undefined) {
		return undefined;
	}
	const timestamp = Date.parse(since);
	if (!Number.isFinite(timestamp)) {
		throw new StatsError(`invalid --since value ${JSON.stringify(since)}; expected an ISO date/time`);
	}
	return timestamp;
}

async function requestJson(fetcher: GitHubFetch, url: string, token: string | undefined): Promise<unknown> {
	let response: Response;
	try {
		response = await fetcher(url, {
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
		});
	} catch (error) {
		throw new StatsError(
			`GitHub request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			},
		);
	}
	const body = await response.text();
	if (!response.ok) {
		throw new StatsError(`GitHub returned HTTP ${response.status} for ${url}`);
	}
	try {
		return JSON.parse(body) as unknown;
	} catch (error) {
		throw new StatsError(`GitHub returned invalid JSON for ${url}`, { cause: error });
	}
}

function pullSummaries(value: unknown): GitHubPullSummary[] {
	if (!Array.isArray(value)) {
		throw new StatsError("GitHub pull request response must be an array");
	}
	return value.map((item, index) => {
		if (
			!isRecord(item) ||
			!Number.isSafeInteger(item.number) ||
			(item.number as number) <= 0 ||
			!(item.merged_at === null || typeof item.merged_at === "string") ||
			typeof item.updated_at !== "string" ||
			(item.merged_at !== null && !Number.isFinite(Date.parse(item.merged_at))) ||
			!Number.isFinite(Date.parse(item.updated_at))
		) {
			throw new StatsError(`GitHub pull request response item ${index} is malformed`);
		}
		return item as unknown as GitHubPullSummary;
	});
}

interface ParsedStatsComments {
	comments: StatsComment[];
	unparsable: StatsUnparsable[];
	itemCount: number;
}

function statsComments(value: unknown, pullRequest: number, page: number): ParsedStatsComments {
	if (!Array.isArray(value)) {
		throw new StatsError("GitHub comments response must be an array");
	}
	const comments: StatsComment[] = [];
	const unparsable: StatsUnparsable[] = [];
	for (const [index, item] of value.entries()) {
		if (
			!isRecord(item) ||
			!Number.isSafeInteger(item.id) ||
			(item.id as number) <= 0 ||
			!(item.body === null || typeof item.body === "string")
		) {
			unparsable.push({
				pr: pullRequest,
				commentId:
					isRecord(item) && Number.isSafeInteger(item.id) && (item.id as number) > 0 ? (item.id as number) : null,
				line: null,
				page,
				itemIndex: index,
				reason: `GitHub comments response item ${index} is malformed`,
			});
			continue;
		}
		comments.push({ id: item.id as number, body: item.body as string | null });
	}
	return { comments, unparsable, itemCount: value.length };
}

async function fetchMergedPullRequests(
	fetcher: GitHubFetch,
	base: string,
	token: string | undefined,
	since: number | undefined,
): Promise<GitHubPullSummary[]> {
	const merged: GitHubPullSummary[] = [];
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const url = `${base}/pulls?state=closed&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`;
		const values = pullSummaries(await requestJson(fetcher, url, token));
		if (values.length > PAGE_SIZE) {
			throw new StatsError(`GitHub pulls page ${page} exceeded ${PAGE_SIZE} items`);
		}
		for (const pull of values) {
			if (pull.merged_at !== null && (since === undefined || Date.parse(pull.merged_at) >= since)) {
				merged.push(pull);
			}
		}
		const oldestUpdate = values.at(-1)?.updated_at;
		if (
			values.length < PAGE_SIZE ||
			(since !== undefined && oldestUpdate !== undefined && Date.parse(oldestUpdate) < since)
		) {
			return merged;
		}
	}
	throw new StatsError(`GitHub pull request pagination exceeded ${MAX_PAGES} pages`);
}

async function fetchPullComments(
	fetcher: GitHubFetch,
	base: string,
	pullRequest: number,
	token: string | undefined,
): Promise<ParsedLedgers> {
	const comments: StatsComment[] = [];
	const unparsable: StatsUnparsable[] = [];
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const url = `${base}/issues/${pullRequest}/comments?per_page=${PAGE_SIZE}&page=${page}`;
		const parsedPage = statsComments(await requestJson(fetcher, url, token), pullRequest, page);
		comments.push(...parsedPage.comments);
		unparsable.push(...parsedPage.unparsable);
		if (parsedPage.itemCount < PAGE_SIZE) {
			const harvested = parseLedgerComments(comments, pullRequest);
			return { ledgers: harvested.ledgers, unparsable: [...unparsable, ...harvested.unparsable] };
		}
	}
	throw new StatsError(`GitHub comment pagination for PR #${pullRequest} exceeded ${MAX_PAGES} pages`);
}

async function githubLedgers(
	options: StatsOptions,
	dependencies: StatsDependencies,
): Promise<{
	parsed: ParsedLedgers;
	totalPrs: number;
}> {
	if (!options.repo) {
		throw new StatsError("--repo is required when --source github is selected");
	}
	const { owner, name } = githubRepo(options.repo);
	const env = dependencies.env ?? process.env;
	const apiBase = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
	try {
		new URL(apiBase);
	} catch (error) {
		throw new StatsError(`invalid GitHub API base URL ${JSON.stringify(apiBase)}`, { cause: error });
	}
	const base = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
	const fetcher = dependencies.fetch ?? globalThis.fetch;
	const token = options.token ?? env.GITHUB_TOKEN;
	const pulls = await fetchMergedPullRequests(fetcher, base, token, sinceTimestamp(options.since));
	const parsed: ParsedLedgers = { ledgers: [], unparsable: [] };
	for (const pull of pulls) {
		const harvested = await fetchPullComments(fetcher, base, pull.number, token);
		parsed.ledgers.push(...harvested.ledgers);
		parsed.unparsable.push(...harvested.unparsable);
	}
	return { parsed, totalPrs: pulls.length };
}

function emitStats(report: StatsReport, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return;
	}
	process.stdout.write(
		`Gatekeeper stats: ${report.matchedPrs}/${report.totalPrs} PRs matched (${(report.hitRate * 100).toFixed(1)}%), ${report.rounds} rounds\n`,
	);
	process.stdout.write(
		`Levels: block=${report.byLevel.block} warn=${report.byLevel.warn} override=${report.byLevel.override} pass=${report.byLevel.pass}\n`,
	);
	for (const contract of report.byContract) {
		process.stdout.write(`CONTRACT ${contract.contract}: ${contract.count}\n`);
	}
	for (const issue of report.issues) {
		process.stdout.write(`ISSUE ${issue.issue}: ${issue.rounds} rounds (${issue.prs.join(", ")})\n`);
	}
	for (const item of report.unparsable) {
		const location = item.commentId !== null ? `comment ${item.commentId}` : `line ${item.line ?? "?"}`;
		process.stderr.write(`warning: unparsable ledger ${location}: ${item.reason}\n`);
	}
}

export async function runStats(
	options: StatsOptions,
	cwd: string,
	dependencies: StatsDependencies = {},
): Promise<number> {
	try {
		// Config discovery (.gatekeeper.yml, falling back to the user-level
		// controls index) only ever fills in `repo` here (stats has no registry
		// option); a damaged config file is fail-loud like every other stats
		// input error below.
		const { discovered, warnings: discoveryWarnings } = await discoverConfigWithControlsIndex(cwd, {
			mode: "tool",
			env: dependencies.env,
		});
		for (const discoveryWarning of discoveryWarnings) {
			process.stderr.write(`warning: ${discoveryWarning}\n`);
		}
		const effectiveOptions: StatsOptions = {
			...options,
			repo: resolveConfiguredField(options.repo, discovered, "repo"),
		};

		// Same fallback tail check.ts/gate.ts/doctor.ts/triage.ts already apply:
		// a self-match discovery (a hub repo discovering its own root, see
		// src/config/controls.ts's locateOwningControl) has no repo identity to
		// offer, so without this, `--source github` could never resolve a repo
		// with zero flags from inside a hub that does have an origin remote.
		// Scoped to `--source github` only -- `--source local` never needs a
		// repo at all, so this must not turn an unrelated missing-origin
		// checkout into a hard failure for that source.
		if (effectiveOptions.source === "github" && !effectiveOptions.repo) {
			try {
				effectiveOptions.repo = await resolveRepo(cwd, undefined);
			} catch {
				// Fall through -- githubLedgers below throws the existing, clearer
				// "--repo is required when --source github is selected" StatsError.
			}
		}

		let parsed: ParsedLedgers;
		let totalPrs: number | undefined;
		if (effectiveOptions.source === "github") {
			const harvested = await githubLedgers(effectiveOptions, dependencies);
			parsed = harvested.parsed;
			totalPrs = harvested.totalPrs;
		} else if (effectiveOptions.source === "local") {
			if (options.since !== undefined) {
				throw new StatsError("--since is supported only with --source github");
			}
			const file = path.resolve(cwd, options.file ?? ".gatekeeper/ledger.jsonl");
			let content: string;
			try {
				content = await readFile(file, "utf8");
			} catch (error) {
				throw new StatsError(`failed to read local ledger ${file}`, { cause: error });
			}
			parsed = parseLedgerJsonl(content);
		} else {
			throw new StatsError(`unsupported stats source ${JSON.stringify(options.source)}`);
		}
		const report = aggregateStats(parsed.ledgers, totalPrs, parsed.unparsable);
		emitStats(report, options.json ?? false);
		return 0;
	} catch (error) {
		const reason = error instanceof StatsError ? error.reason : error instanceof Error ? error.message : String(error);
		if (options.json) {
			process.stdout.write(`${JSON.stringify({ error: true, reason })}\n`);
		}
		process.stderr.write(`gatekeeper stats: ${reason}\n`);
		return 2;
	}
}
