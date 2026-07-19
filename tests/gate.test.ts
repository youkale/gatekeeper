import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
import { upsertControl } from "../src/config/controls.js";
import { saveRepos } from "../src/config/repos.js";
import type { GitHubIssueComment, GitHubLabel, GitHubPullRequestReview } from "../src/providers/github.js";
import { InfraError } from "../src/providers/github.js";
import { COMMENT_MARKER } from "../src/render/comment.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

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

describe("gate: controls-index reverse discovery (B5 env threading + B1 fail-direction)", () => {
	let base: string | undefined;

	afterEach(async () => {
		if (base) {
			await rm(base, { recursive: true, force: true });
			base = undefined;
		}
	});

	it("resolves --registry/--repo via an injected GATEKEEPER_CONFIG_DIR controls index, with zero flags", async () => {
		base = await mkdtemp(path.join(tmpdir(), "gatekeeper-gate-controls-index-"));
		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };

		const registryDir = path.join(base, "registry");
		await mkdir(registryDir, { recursive: true });
		await writeGateRegistry(registryDir);

		const repoDir = path.join(base, "repo");
		await mkdir(repoDir, { recursive: true });
		git(repoDir, ["init", "-q"]);
		git(repoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
		await writeFile(path.join(repoDir, "README.md"), "hello\n", "utf8");
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["-c", "user.email=gate@example.com", "-c", "user.name=Gate Bot", "commit", "-q", "-m", "init"]);
		const repoRealPath = await realpath(repoDir);

		await saveRepos(registryDir, [
			{ repo: "acme/app", path: repoRealPath, ci: "none", adopted_at: "2026-07-18T00:00:00.000Z" },
		]);
		await upsertControl(
			{ control: path.join(base, "control"), registry: registryDir, registered_at: "2026-07-18T00:00:00.000Z" },
			env,
		);
		await mkdir(path.join(base, "control"), { recursive: true });

		const provider = providerFixture();
		let repoPassedToProvider: string | undefined;
		const createProvider: NonNullable<GateDependencies["createProvider"]> = (options) => {
			repoPassedToProvider = options.repo;
			return provider.createProvider(options);
		};

		// No `registry`/`repo` in options at all -- must resolve entirely through
		// the injected controls index, proving `env` is actually threaded into
		// discoverConfigWithControlsIndex rather than silently falling back to
		// the real process.env (which has no such entry).
		const exitCode = await runGate({ pr: 7 }, repoDir, {
			createProvider,
			now: () => "2026-07-18T10:03:00Z",
			env,
		});

		expect(repoPassedToProvider).toBe("acme/app");
		expect(exitCode).toBe(1); // human-required lane unmet -> block, same as the zero-evidence baseline
	});

	it("(C1) degrades (exit 0, GATEKEEPER DEGRADED) instead of blocking when resolving the Git root hits a non-'not-a-worktree' git failure", async () => {
		base = await mkdtemp(path.join(tmpdir(), "gatekeeper-gate-c1-infra-"));
		// A cwd git can't even chdir into (exit 128, "cannot change to ...", not
		// "not a git repository") is classified `kind: "infra"` by
		// resolveRepoRoot (src/providers/gitdiff.ts) -- deterministic and
		// portable, unlike permission-based repros (see this file's B1 test for
		// the identical rationale for the sibling realpath failure).
		const missingDir = path.join(base, "does-not-exist-at-all");

		let stderrOutput = "";
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
			stderrOutput += String(chunk);
			return true;
		}) as typeof process.stderr.write);
		let exitCode: number;
		try {
			exitCode = await runGate({ pr: 7 }, missingDir, {
				createProvider: () => {
					throw new Error("must not reach a GitHub provider call -- discovery should fail before this point");
				},
			});
		} finally {
			stderrSpy.mockRestore();
		}

		expect(exitCode).toBe(0);
		expect(stderrOutput).toContain("GATEKEEPER DEGRADED");
	});

	it("(C2) degrades (exit 0, GATEKEEPER DEGRADED) instead of a silent missing-registry exit 2 when a stale controls-index entry is the sole reason no match is found", async () => {
		base = await mkdtemp(path.join(tmpdir(), "gatekeeper-gate-c2-stale-"));
		const configDir = path.join(base, "config");
		const env = { GATEKEEPER_CONFIG_DIR: configDir };
		const repoDir = path.join(base, "repo");
		await mkdir(repoDir, { recursive: true });
		git(repoDir, ["init", "-q"]);
		git(repoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);

		// A control root that was never actually created on disk (stale) --
		// there is no other, non-stale index entry that could otherwise match.
		await upsertControl(
			{
				control: path.join(base, "ghost-control"),
				registry: path.join(base, "ghost-control", "registry"),
				registered_at: "2026-07-20T00:00:00.000Z",
			},
			env,
		);

		let stderrOutput = "";
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
			stderrOutput += String(chunk);
			return true;
		}) as typeof process.stderr.write);
		let exitCode: number;
		try {
			exitCode = await runGate({ pr: 7 }, repoDir, {
				createProvider: () => {
					throw new Error("must not reach a GitHub provider call -- discovery should fail before this point");
				},
				env,
			});
		} finally {
			stderrSpy.mockRestore();
		}

		expect(exitCode).toBe(0);
		expect(stderrOutput).toContain("GATEKEEPER DEGRADED");
		expect(stderrOutput).toContain("no longer exists");
	});
});

// B1's fail-direction regression (a non-GitDiffError failure resolving the
// controls-index's Git-root realpath must degrade gate/check, not fail
// closed) is covered end-to-end -- through this exact runGate call site --
// by tests/discover-realpath-failure.test.ts, which injects a deterministic
// fs.realpath failure via vi.mock rather than depending on real filesystem
// permission semantics (fragile and root-bypassed in CI containers).
