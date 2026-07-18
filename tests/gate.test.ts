import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type GateDependencies,
	laneEvidenceNeeds,
	requiredLanePassCount,
	resolveOverrideActor,
	runGate,
} from "../src/commands/gate.js";
import type { GitHubIssueComment, GitHubLabel, GitHubPullRequestReview } from "../src/providers/github.js";
import { InfraError } from "../src/providers/github.js";
import { COMMENT_MARKER } from "../src/render/comment.js";

const overrideLabel = "gatekeeper:override";

beforeEach(() => {
	vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

function issueComment(id: number, body: string, login = "gatekeeper[bot]"): GitHubIssueComment {
	return {
		id,
		body,
		user: { login },
		created_at: `2026-07-18T10:${String(id % 60).padStart(2, "0")}:00Z`,
		updated_at: `2026-07-18T10:${String(id % 60).padStart(2, "0")}:00Z`,
	};
}

function ledgerComment(actor: string | null, id = 91, login = "gatekeeper[bot]"): GitHubIssueComment {
	return issueComment(
		id,
		`${COMMENT_MARKER}\n\n\`\`\`json gatekeeper-ledger\n${JSON.stringify({
			schema_version: 1,
			override: { label: overrideLabel, actor },
		})}\n\`\`\`\n`,
		login,
	);
}

interface ProviderFixtureOptions {
	labels?: GitHubLabel[];
	comments?: GitHubIssueComment[];
	reviews?: GitHubPullRequestReview[];
	editableCommentIds?: number[];
}

function providerFixture(options: ProviderFixtureOptions = {}) {
	const getPullRequestReviews = vi.fn(async () => options.reviews ?? []);
	const getCheckRuns = vi.fn(async () => {
		throw new Error("check-runs endpoint must not be called");
	});
	const getCommitStatuses = vi.fn(async () => {
		throw new Error("statuses endpoint must not be called");
	});
	let writtenComment = "";
	const createIssueComment = vi.fn(async (_pr: number, body: string) => {
		writtenComment = body;
		return issueComment(99, body);
	});
	const updateIssueComment = vi.fn(async (id: number, body: string) => {
		if (options.editableCommentIds && !options.editableCommentIds.includes(id)) {
			throw new InfraError(`comment ${id} is not editable`, {
				kind: "http",
				operation: "update issue comment",
				status: 403,
			});
		}
		writtenComment = body;
		return issueComment(id, body);
	});
	const createProvider: NonNullable<GateDependencies["createProvider"]> = () => ({
		getPullRequest: vi.fn(async () => ({
			number: 7,
			body: null,
			user: { login: "contributor" },
			head: { ref: "feature", sha: "head-sha" },
			base: { ref: "main", sha: "base-sha" },
			labels: options.labels ?? [],
			html_url: "https://github.com/acme/app/pull/7",
		})),
		getPullRequestFiles: vi.fn(async () => [
			{
				sha: "file-sha",
				filename: "src/change.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				changes: 1,
				blob_url: "https://github.com/acme/app/blob/file-sha/src/change.ts",
				raw_url: "https://github.com/acme/app/raw/file-sha/src/change.ts",
				contents_url: "https://api.github.com/repos/acme/app/contents/src/change.ts",
			},
		]),
		getPullRequestReviews,
		getIssueComments: vi.fn(async () => options.comments ?? []),
		getCheckRuns,
		getCommitStatuses,
		getPullRequestLabels: vi.fn(async () => options.labels ?? []),
		createIssueComment,
		updateIssueComment,
	});
	return {
		createProvider,
		getPullRequestReviews,
		getCheckRuns,
		getCommitStatuses,
		createIssueComment,
		updateIssueComment,
		writtenComment: () => writtenComment,
	};
}

async function writeGateRegistry(directory: string): Promise<void> {
	const contractsDirectory = path.join(directory, "contracts");
	await mkdir(contractsDirectory);
	await Promise.all([
		writeFile(
			path.join(directory, "policy.yaml"),
			`apiVersion: gatekeeper/v1
lanes:
  human-required: { type: human-approval, min: 1, fresh: true }
  status-advisory: { type: check-run, selector: status, name: "advisory/*" }
levels:
  required:
    enforcement: block
    require: { m: 1, lanes: [human-required] }
  advisory:
    enforcement: warn
    require: { m: 1, lanes: [status-advisory] }
`,
			"utf8",
		),
		writeFile(
			path.join(contractsDirectory, "required.yaml"),
			`apiVersion: gatekeeper/v1
name: required-contract
level: required
authority: { repo: acme/app, paths: ["src/**"] }
`,
			"utf8",
		),
		writeFile(
			path.join(contractsDirectory, "advisory.yaml"),
			`apiVersion: gatekeeper/v1
name: advisory-contract
level: advisory
authority: { repo: acme/app, paths: ["src/**"] }
`,
			"utf8",
		),
	]);
}

describe("gate evidence selection", () => {
	it("maps configured lane primitives to only their required evidence endpoints", () => {
		expect(laneEvidenceNeeds([{ lane: "human", type: "human-approval", min: 1, fresh: true }])).toEqual({
			reviews: true,
			checkRuns: false,
			statuses: false,
		});
		expect(laneEvidenceNeeds([{ lane: "check", type: "check-run", name: "build-*" }])).toEqual({
			reviews: false,
			checkRuns: true,
			statuses: false,
		});
		expect(laneEvidenceNeeds([{ lane: "status", type: "check-run", selector: "status", name: "ci/*" }])).toEqual({
			reviews: false,
			checkRuns: false,
			statuses: true,
		});
		expect(
			laneEvidenceNeeds([{ lane: "comment", type: "comment-scan", author: "bot-*", body_matches: "ready" }]),
		).toEqual({ reviews: false, checkRuns: false, statuses: false });
	});

	it("does not let unused check endpoints hide a blocking review lane and counts only blocking lanes", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "gatekeeper-gate-evidence-"));
		try {
			await writeGateRegistry(directory);
			const provider = providerFixture({
				reviews: [
					{
						id: 1,
						user: { login: "alice" },
						body: null,
						state: "CHANGES_REQUESTED",
						commit_id: "head-sha",
						submitted_at: "2026-07-18T10:01:00Z",
					},
				],
			});
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			const exitCode = await runGate({ pr: 7, registry: directory, repo: "acme/app" }, directory, {
				createProvider: provider.createProvider,
				now: () => "2026-07-18T10:03:00Z",
			});

			expect(exitCode).toBe(1);
			expect(provider.getPullRequestReviews).toHaveBeenCalledOnce();
			expect(provider.getCheckRuns).not.toHaveBeenCalled();
			expect(provider.getCommitStatuses).not.toHaveBeenCalled();
			expect(stdout.mock.calls.map(([message]) => String(message)).join("")).toContain(
				"GATEKEEPER GATE BLOCK (0/1 required lanes passed)",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("skips all lane evidence when a blocking hit without requirements already determines block", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "gatekeeper-gate-definitive-block-"));
		try {
			await writeGateRegistry(directory);
			await writeFile(
				path.join(directory, "policy.yaml"),
				`apiVersion: gatekeeper/v1
lanes:
  status-required: { type: check-run, selector: status, name: "required/*" }
levels:
  required:
    enforcement: block
    require: {}
  advisory:
    enforcement: block
    require: { m: 1, lanes: [status-required] }
`,
				"utf8",
			);
			const provider = providerFixture();
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			const exitCode = await runGate({ pr: 7, registry: directory, repo: "acme/app" }, directory, {
				createProvider: provider.createProvider,
				now: () => "2026-07-18T10:03:00Z",
			});

			expect(exitCode).toBe(1);
			expect(provider.getPullRequestReviews).not.toHaveBeenCalled();
			expect(provider.getCheckRuns).not.toHaveBeenCalled();
			expect(provider.getCommitStatuses).not.toHaveBeenCalled();
			expect(stdout.mock.calls.map(([message]) => String(message)).join("")).toContain("GATEKEEPER GATE BLOCK");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("counts passes only from the selected blocking requirement", () => {
		expect(
			requiredLanePassCount(
				[
					{ lane: "human-required", state: "fail", evidence: "changes requested" },
					{ lane: "soft-advisory", state: "pass", evidence: "successful" },
				],
				{ lanes: ["human-required"] },
			),
		).toBe(0);
	});
});

describe("override attribution", () => {
	it("uses the matching labeled event sender and never the workflow re-run actor", () => {
		expect(
			resolveOverrideActor(
				{
					action: "labeled",
					label: { name: overrideLabel },
					sender: { login: "label-author" },
				},
				[ledgerComment("original-author")],
				overrideLabel,
			),
		).toBe("label-author");
	});

	it("retains the existing sticky ledger actor for a non-labeled re-run", () => {
		expect(
			resolveOverrideActor(
				{ action: "synchronize", sender: { login: "workflow-rerunner" } },
				[ledgerComment("original-label-author")],
				overrideLabel,
				"gatekeeper[bot]",
			),
		).toBe("original-label-author");
	});

	it("records unknown when neither event nor sticky ledger has an actor", () => {
		expect(resolveOverrideActor({ action: "synchronize" }, [], overrideLabel)).toBeNull();
	});

	it("wires non-labeled ledger attribution through runGate instead of GITHUB_ACTOR", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "gatekeeper-gate-override-"));
		try {
			await writeGateRegistry(directory);
			const provider = providerFixture({
				labels: [{ name: overrideLabel }],
				comments: [ledgerComment("original-label-author")],
			});
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			const exitCode = await runGate({ pr: 7, registry: directory, repo: "acme/app", json: true }, directory, {
				createProvider: provider.createProvider,
				commentAuthorLogin: "gatekeeper[bot]",
				env: { GITHUB_ACTOR: "workflow-rerunner" },
				eventPayload: { action: "synchronize", sender: { login: "workflow-rerunner" } },
				now: () => "2026-07-18T10:03:00Z",
			});

			expect(exitCode).toBe(0);
			expect(provider.updateIssueComment).toHaveBeenCalledOnce();
			expect(provider.writtenComment()).toContain('"override": {');
			expect(provider.writtenComment()).toContain('"actor": "original-label-author"');
			expect(provider.writtenComment()).not.toContain("workflow-rerunner");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("trusts only the editable sticky ledger when an earlier foreign marker injects an actor", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "gatekeeper-gate-safe-override-"));
		try {
			await writeGateRegistry(directory);
			const provider = providerFixture({
				labels: [{ name: overrideLabel }],
				comments: [ledgerComment("attacker", 90, "attacker"), ledgerComment("original-label-author", 91)],
				editableCommentIds: [91],
			});
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const exitCode = await runGate({ pr: 7, registry: directory, repo: "acme/app" }, directory, {
				createProvider: provider.createProvider,
				eventPayload: { action: "synchronize", sender: { login: "workflow-rerunner" } },
				now: () => "2026-07-18T10:03:00Z",
			});

			expect(exitCode).toBe(0);
			expect(provider.updateIssueComment.mock.calls.map(([id]) => id)).toEqual([90, 91, 91]);
			expect(provider.writtenComment()).toContain('"actor": "original-label-author"');
			expect(provider.writtenComment()).not.toContain("attacker");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("records unknown and creates safely when no marker is editable", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "gatekeeper-gate-unknown-override-"));
		try {
			await writeGateRegistry(directory);
			const provider = providerFixture({
				labels: [{ name: overrideLabel }],
				comments: [ledgerComment("attacker", 90, "attacker")],
				editableCommentIds: [],
			});
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const exitCode = await runGate({ pr: 7, registry: directory, repo: "acme/app" }, directory, {
				createProvider: provider.createProvider,
				eventPayload: { action: "synchronize" },
				now: () => "2026-07-18T10:03:00Z",
			});

			expect(exitCode).toBe(0);
			expect(provider.updateIssueComment).toHaveBeenCalledTimes(1);
			expect(provider.createIssueComment).toHaveBeenCalledOnce();
			expect(provider.writtenComment()).toContain('"actor": null');
			expect(provider.writtenComment()).not.toContain("attacker");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
