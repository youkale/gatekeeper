import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type GitHubFetch, GitHubProvider, type GitHubPullRequestFile, InfraError } from "../src/providers/github.js";

const fixtureDirectory = new URL("../fixtures/github/", import.meta.url);

function jsonFixture<T>(name: string): T {
	return JSON.parse(readFileSync(new URL(name, fixtureDirectory), "utf8")) as T;
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function providerWith(respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => respond(String(input), init));
	return {
		provider: new GitHubProvider({
			repo: "acme/gatekeeper",
			token: "fixture-token",
			fetch: fetchMock as unknown as GitHubFetch,
		}),
		fetchMock,
	};
}

function validFile(index: number): GitHubPullRequestFile {
	return {
		sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		filename: `src/file-${index}.ts`,
		status: "modified",
		additions: 1,
		deletions: 0,
		changes: 1,
		blob_url: `https://github.test/blob/${index}`,
		raw_url: `https://github.test/raw/${index}`,
		contents_url: `https://api.github.test/contents/${index}`,
		patch: "@@ -1 +1 @@",
	};
}

beforeEach(() => {
	vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

describe("GitHubProvider payload validation", () => {
	it.each<{
		name: string;
		payload: unknown;
		invoke: (provider: GitHubProvider) => Promise<unknown>;
	}>([
		{
			name: "pull request",
			payload: {},
			invoke: (provider) => provider.getPullRequest(42),
		},
		{
			name: "pull request files",
			payload: [{}],
			invoke: (provider) => provider.getPullRequestFiles(42),
		},
		{
			name: "pull request reviews",
			payload: [{}],
			invoke: (provider) => provider.getPullRequestReviews(42),
		},
		{
			name: "issue comments",
			payload: [{}],
			invoke: (provider) => provider.getIssueComments(42),
		},
		{
			name: "check runs",
			payload: { total_count: 1, check_runs: [{}] },
			invoke: (provider) => provider.getCheckRuns("head-sha"),
		},
		{
			name: "commit statuses",
			payload: { total_count: 1, statuses: [{}] },
			invoke: (provider) => provider.getCommitStatuses("head-sha"),
		},
		{
			name: "pull request labels",
			payload: [{}],
			invoke: (provider) => provider.getPullRequestLabels(42),
		},
		{
			name: "required checks",
			payload: { contexts: [], checks: [{}] },
			invoke: (provider) => provider.getBranchProtectionRequiredChecks("main"),
		},
		{
			name: "created comment",
			payload: {},
			invoke: (provider) => provider.createIssueComment(42, "verdict"),
		},
		{
			name: "updated comment",
			payload: {},
			invoke: (provider) => provider.updateIssueComment(9001, "verdict"),
		},
	])("turns a malformed 2xx $name payload into InfraError", async ({ payload, invoke }) => {
		const { provider } = providerWith(() => jsonResponse(payload));
		await expect(invoke(provider)).rejects.toMatchObject({
			name: "InfraError",
			kind: "payload",
		});
	});

	it("rejects a malformed second pagination page and terminates", async () => {
		const payloads: unknown[] = [Array.from({ length: 100 }, (_, index) => validFile(index)), { files: [] }];
		const { provider, fetchMock } = providerWith(() => jsonResponse(payloads.shift()));

		await expect(provider.getPullRequestFiles(42)).rejects.toMatchObject({ kind: "payload" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1]?.[0]).toContain("page=2");
	});

	it("wraps malformed required-check contexts instead of leaking TypeError", async () => {
		const { provider } = providerWith(() => jsonResponse({ contexts: {}, checks: [] }));
		await expect(provider.getBranchProtectionRequiredChecks("main")).rejects.toMatchObject({
			name: "InfraError",
			kind: "payload",
		});
	});
});

describe("GitHubProvider success and HTTP boundaries", () => {
	it("accepts a recorded REST review fixture through an injected fetch", async () => {
		const reviews = jsonFixture<unknown[]>("reviews.json");
		const { provider, fetchMock } = providerWith(() => jsonResponse(reviews));

		const result = await provider.getPullRequestReviews(42);

		expect(result).toHaveLength(reviews.length);
		expect(result[0]?.id).toBe(2001);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toContain("/repos/acme/gatekeeper/pulls/42/reviews");
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
			headers: { Authorization: "Bearer fixture-token" },
		});
	});

	it.each([403, 404] as const)("returns unavailable for branch-protection HTTP %s", async (status) => {
		const { provider } = providerWith(() => jsonResponse({ message: "unavailable" }, status));
		await expect(provider.getBranchProtectionRequiredChecks("main")).resolves.toMatchObject({
			available: false,
			status,
		});
	});

	it("turns other non-2xx responses into structured HTTP InfraError", async () => {
		const { provider } = providerWith(() => jsonResponse({ message: "server failed" }, 500));
		let thrown: unknown;
		try {
			await provider.getPullRequest(42);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(InfraError);
		expect(thrown).toMatchObject({ kind: "http", status: 500 });
	});
});
