import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateGateOutcome, runGate } from "../src/commands/gate.js";
import { parseRegistry, RegistryParseError } from "../src/engine/registry.js";
import type { ContractHit, Verdict } from "../src/engine/types.js";
import {
	evaluateLane,
	evaluateLanes,
	evaluateMOfN,
	type GitHubCheckRunPayload,
	type GitHubCommentPayload,
	type GitHubReviewPayload,
	type GitHubStatusPayload,
	type LaneConfig,
	type LaneEvaluationData,
	type LaneResult,
} from "../src/gate/lanes.js";
import {
	defaultLanePresetDirectory,
	LanePresetParseError,
	loadLanePresets,
	loadRegistryWithLanePresets,
	preparePolicyWithLanePresets,
} from "../src/gate/presets.js";

const fixtureDirectory = new URL("../fixtures/github/", import.meta.url);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function jsonFixture<T>(name: string): T {
	return JSON.parse(readFileSync(new URL(name, fixtureDirectory), "utf8")) as T;
}

const reviews = jsonFixture<GitHubReviewPayload[]>("reviews.json");
const checkRunsPayload = jsonFixture<{ total_count: number; check_runs: GitHubCheckRunPayload[] }>("check-runs.json");
const statuses = jsonFixture<GitHubStatusPayload[]>("statuses.json");
const comments = jsonFixture<GitHubCommentPayload[]>("comments.json");

const data: LaneEvaluationData = {
	reviews,
	checkRuns: checkRunsPayload.check_runs,
	statuses,
	comments,
	headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	headPushedAt: "2026-07-18T09:59:00Z",
};

beforeEach(() => {
	vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

describe("human-approval lane", () => {
	it.each<{
		name: string;
		config: LaneConfig;
		data: LaneEvaluationData;
		expected: LaneResult["state"];
	}>([
		{
			name: "uses each human's latest review and ignores bots",
			config: { lane: "human", type: "human-approval", min: 1, fresh: true },
			data,
			expected: "pass",
		},
		{
			name: "does not count an approval for an older commit when fresh is true",
			config: { lane: "human", type: "human-approval", min: 2, fresh: true },
			data,
			expected: "pending",
		},
		{
			name: "counts an older-commit approval when fresh is false",
			config: { lane: "human", type: "human-approval", min: 2, fresh: false },
			data,
			expected: "pass",
		},
		{
			name: "fails on a latest unresolved changes request",
			config: { lane: "human", type: "human-approval", min: 1, fresh: true },
			data: { ...data, reviews: reviews.filter((review) => review.id !== 2005) },
			expected: "fail",
		},
	])("$name", ({ config, data: laneData, expected }) => {
		expect(evaluateLane(config, laneData).state).toBe(expected);
	});

	it("does not revive an older head approval after the user's latest review is dismissed without a commit", () => {
		const aliceApproval = reviews.find((review) => review.id === 2005);
		if (!aliceApproval) {
			throw new Error("recorded Alice approval is missing");
		}
		const latestDismissed: GitHubReviewPayload = {
			...aliceApproval,
			id: 2010,
			state: "DISMISSED",
			commit_id: null,
			submitted_at: "2026-07-18T10:20:00Z",
		};
		const result = evaluateLane(
			{ lane: "human", type: "human-approval", min: 1, fresh: true },
			{ ...data, reviews: [...reviews, latestDismissed] },
		);
		expect(result.state).toBe("pending");
		expect(result.evidence).toContain("0/1");
	});

	it("keeps an approval after the same user posts a later comment", () => {
		const aliceApproval = reviews.find((review) => review.id === 2005);
		if (!aliceApproval) {
			throw new Error("recorded Alice approval is missing");
		}
		const laterComment: GitHubReviewPayload = {
			...aliceApproval,
			id: 2010,
			state: "COMMENTED",
			submitted_at: "2026-07-18T10:20:00Z",
		};
		const result = evaluateLane(
			{ lane: "human", type: "human-approval", min: 1, fresh: true },
			{ ...data, reviews: [...reviews, laterComment] },
		);
		expect(result.state).toBe("pass");
		expect(result.evidence).toContain("1 human approval(s)");
	});

	it("keeps an older-commit changes request blocking after a later comment", () => {
		const aliceChangesRequested = reviews.find((review) => review.id === 2001);
		if (!aliceChangesRequested) {
			throw new Error("recorded Alice changes request is missing");
		}
		const olderCommitChangesRequested: GitHubReviewPayload = {
			...aliceChangesRequested,
			commit_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		};
		const laterComment: GitHubReviewPayload = {
			...olderCommitChangesRequested,
			id: 2010,
			state: "COMMENTED",
			submitted_at: "2026-07-18T10:20:00Z",
		};
		const result = evaluateLane(
			{ lane: "human", type: "human-approval", min: 1, fresh: true },
			{ ...data, reviews: [olderCommitChangesRequested, laterComment] },
		);
		expect(result.state).toBe("fail");
		expect(result.evidence).toContain("changes requested by alice");
	});

	it("clears an older changes request when the same user's latest decision is dismissed", () => {
		const aliceChangesRequested = reviews.find((review) => review.id === 2001);
		if (!aliceChangesRequested) {
			throw new Error("recorded Alice changes request is missing");
		}
		const latestDismissed: GitHubReviewPayload = {
			...aliceChangesRequested,
			id: 2010,
			state: "DISMISSED",
			commit_id: null,
			submitted_at: "2026-07-18T10:20:00Z",
		};
		const result = evaluateLane(
			{ lane: "human", type: "human-approval", min: 1, fresh: true },
			{ ...data, reviews: [aliceChangesRequested, latestDismissed] },
		);
		expect(result.state).toBe("pending");
		expect(result.evidence).toContain("0/1");
	});

	it("treats an older changes request as resolved by the same user's latest head approval", () => {
		const aliceReviews = reviews.filter((review) => review.user?.login === "alice");
		const result = evaluateLane(
			{ lane: "human", type: "human-approval", min: 1, fresh: true },
			{ ...data, reviews: aliceReviews },
		);
		expect(result.state).toBe("pass");
	});
});

describe("review lane", () => {
	it.each<{
		name: string;
		config: LaneConfig;
		expected: LaneResult["state"];
		textMatched?: boolean;
	}>([
		{
			name: "matches a literal bot login containing glob metacharacters",
			config: {
				lane: "coderabbit",
				type: "review",
				author: "coderabbitai[bot]",
				pass: { state: "APPROVED" },
			},
			expected: "pass",
		},
		{
			name: "matches author glob and case-insensitive body regex",
			config: {
				lane: "copilot",
				type: "review",
				author: "copilot-*",
				pass: {
					state: "COMMENTED",
					body_matches: { pattern: "PULL REQUEST REVIEW SUMMARY", ignore_case: true },
				},
			},
			expected: "pass",
			textMatched: true,
		},
		{
			name: "fails when the latest matching review body does not match",
			config: {
				lane: "copilot",
				type: "review",
				author: "copilot-*",
				pass: { state: "COMMENTED", body_matches: "blocking finding" },
			},
			expected: "fail",
		},
		{
			name: "is pending when the author has no review",
			config: { lane: "absent", type: "review", author: "absent-*", pass: { state: "APPROVED" } },
			expected: "pending",
		},
	])("$name", ({ config, expected, textMatched }) => {
		const result = evaluateLane(config, data);
		expect(result.state).toBe(expected);
		if (textMatched) {
			expect(result.evidence).toContain("(text-matched)");
		}
	});

	it("uses the latest review across reviews matching the author glob", () => {
		const sourceReview = reviews.find((review) => review.id === 2003);
		if (!sourceReview) {
			throw new Error("recorded CodeRabbit review is missing");
		}
		const laterReview: GitHubReviewPayload = {
			...sourceReview,
			id: 2999,
			state: "COMMENTED",
			submitted_at: "2026-07-18T10:30:00Z",
		};
		const result = evaluateLane(
			{ lane: "coderabbit", type: "review", author: "coderabbit*", pass: { state: "APPROVED" } },
			{ ...data, reviews: [...reviews, laterReview] },
		);
		expect(result.state).toBe("fail");
		expect(result.evidence).toContain("latest review is COMMENTED");
	});
});

describe("check-run lane", () => {
	it.each<{
		name: string;
		config: LaneConfig;
		expected: LaneResult["state"];
	}>([
		{
			name: "passes a successful check run selected by name glob",
			config: { lane: "greptile", type: "check-run", name: "greptile*" },
			expected: "pass",
		},
		{
			name: "keeps an in-progress check run pending",
			config: { lane: "build", type: "check-run", name: "build-*" },
			expected: "pending",
		},
		{
			name: "keeps a neutral conclusion pending when it is outside the pass set",
			config: { lane: "license", type: "check-run", name: "license-*" },
			expected: "pending",
		},
		{
			name: "allows an explicitly configured neutral conclusion",
			config: { lane: "license", type: "check-run", name: "license-*", pass: ["neutral"] },
			expected: "pass",
		},
		{
			name: "is pending when no check run matches",
			config: { lane: "missing", type: "check-run", name: "missing-*" },
			expected: "pending",
		},
		{
			name: "uses the latest commit status for a matching context",
			config: {
				lane: "legacy",
				type: "check-run",
				selector: "status",
				name: "continuous-integration/*",
			},
			expected: "pass",
		},
		{
			name: "keeps a pending commit status pending",
			config: { lane: "preview", type: "check-run", selector: "status", name: "deploy/*" },
			expected: "pending",
		},
	])("$name", ({ config, expected }) => {
		expect(evaluateLane(config, data).state).toBe(expected);
	});

	it.each(["failure", "timed_out", "cancelled", "action_required"])(
		"fails a check run with terminal conclusion %s",
		(conclusion) => {
			const failed = checkRunsPayload.check_runs.map((checkRun) =>
				checkRun.name === "greptile-review" ? { ...checkRun, conclusion } : checkRun,
			);
			expect(
				evaluateLane({ lane: "greptile", type: "check-run", name: "greptile*" }, { ...data, checkRuns: failed }).state,
			).toBe("fail");
		},
	);

	it("fails a commit status in the error state", () => {
		const failed = statuses.map((status) =>
			status.context === "deploy/preview" ? { ...status, state: "error", id: 4999 } : status,
		);
		expect(
			evaluateLane(
				{ lane: "preview", type: "check-run", selector: "status", name: "deploy/*" },
				{ ...data, statuses: failed },
			).state,
		).toBe("fail");
	});
});

describe("comment-scan lane", () => {
	it("passes on an author glob and regex match and marks text evidence", () => {
		const result = evaluateLane(
			{
				lane: "comment-review",
				type: "comment-scan",
				author: "greptile-*",
				body_matches: { pattern: "READY TO MERGE", ignore_case: true },
			},
			data,
		);
		expect(result.state).toBe("pass");
		expect(result.evidence).toContain("(text-matched)");
	});

	it.each(["not present", "["])("is pending, never fail, when text does not match (%s)", (pattern) => {
		const result = evaluateLane(
			{
				lane: "comment-review",
				type: "comment-scan",
				author: "greptile-*",
				body_matches: pattern,
			},
			data,
		);
		expect(result.state).toBe("pending");
	});
});

describe("lane evaluation and M-of-N composition", () => {
	it("does not mutate recorded payload data", () => {
		const before = structuredClone(data);
		evaluateLanes({
			lanes: [
				{ lane: "human", type: "human-approval", min: 1, fresh: true },
				{ lane: "greptile", type: "check-run", name: "greptile*" },
			],
			data,
		});
		expect(data).toEqual(before);
	});

	it.each<{
		name: string;
		states: LaneResult["state"][];
		minimum: number;
		expected: LaneResult["state"];
	}>([
		{ name: "passes once enough lanes pass", states: ["pass", "pass", "pending"], minimum: 2, expected: "pass" },
		{
			name: "stays pending while pending lanes can still meet the minimum",
			states: ["pass", "fail", "pending"],
			minimum: 2,
			expected: "pending",
		},
		{
			name: "fails once pass plus pending cannot meet the minimum",
			states: ["pass", "fail", "fail"],
			minimum: 2,
			expected: "fail",
		},
	])("$name", ({ states, minimum, expected }) => {
		const results = states.map((state, index) => ({ lane: `lane-${index}`, state, evidence: "fixture" }));
		const composite = evaluateMOfN(results, minimum);
		expect(composite.state).toBe(expected);
		expect(composite.pass + composite.fail + composite.pending).toBe(results.length);
	});

	function contractHit(
		contract: string,
		effectiveEnforcement: ContractHit["effectiveEnforcement"],
		lane: string,
	): ContractHit {
		return {
			contract,
			level: `${effectiveEnforcement}-level`,
			enforcement: effectiveEnforcement,
			effectiveEnforcement,
			requires: { m: 1, lanes: [lane] },
			bindings: [],
			consumers: [],
		};
	}

	it("uses the blocking requirement as the single comment and exit-code outcome", () => {
		const verdict: Verdict = {
			decision: "block",
			repo: "acme/app",
			touched: [contractHit("hard", "block", "human"), contractHit("soft", "warn", "coderabbit")],
			forbiddenEdits: [],
			effectivePolicy: { enforcementOverride: null },
		};
		const outcome = evaluateGateOutcome(verdict, [
			{ lane: "human", state: "fail", evidence: "changes requested" },
			{ lane: "coderabbit", state: "pass", evidence: "approved" },
		]);

		expect(outcome).toEqual({
			state: "fail",
			blocked: true,
			requirement: { m: 1, lanes: ["human"] },
		});
	});

	it("keeps warn-only unmet lanes non-blocking while preserving their pending state", () => {
		const verdict: Verdict = {
			decision: "warn",
			repo: "acme/app",
			touched: [contractHit("soft", "warn", "coderabbit")],
			forbiddenEdits: [],
			effectivePolicy: { enforcementOverride: null },
		};

		expect(evaluateGateOutcome(verdict, [{ lane: "coderabbit", state: "pending", evidence: "waiting" }])).toEqual({
			state: "pending",
			blocked: false,
			requirement: { m: 1, lanes: ["coderabbit"] },
		});
	});
});

describe("lane presets", () => {
	it("strictly loads all four data-file presets", async () => {
		const presets = await loadLanePresets();
		expect(Object.keys(presets.lanes).sort()).toEqual(["coderabbit", "copilot", "greptile", "human"]);
		expect(presets.lanes.greptile).toEqual({
			type: "check-run",
			selector: "check-run",
			name: "greptile*",
			pass: ["success"],
		});
	});

	it.each(["src/gate/presets.ts", "dist/gate/presets.js", "dist/cli.js"])(
		"resolves the package-root preset directory from %s",
		(modulePath) => {
			expect(defaultLanePresetDirectory(pathToFileURL(path.join(packageRoot, modulePath)))).toBe(
				path.join(packageRoot, "lanes.d"),
			);
		},
	);

	it("injects real preset definitions for registry validation", async () => {
		const presets = await loadLanePresets();
		const prepared = preparePolicyWithLanePresets(
			`apiVersion: gatekeeper/v1
lanes: {}
levels:
  strict:
    enforcement: block
    require: { m: 2, lanes: [human, greptile] }
`,
			presets,
		);
		const registry = parseRegistry([
			{ path: "policy.yaml", content: prepared.policyYaml },
			{
				path: "contracts/example.yaml",
				content: `apiVersion: gatekeeper/v1
name: example
level: strict
authority: { repo: acme/gatekeeper, paths: [src/**] }
`,
			},
		]);
		expect(registry.policy.lanes.greptile).toMatchObject({ type: "check-run", name: "greptile*" });
		expect(registry.policy.lanes.greptile).toEqual({
			type: "check-run",
			selector: "check-run",
			name: "greptile*",
			pass: ["success"],
		});
	});

	it("lets a user lane override a same-name preset and reports the conflict", async () => {
		const presets = await loadLanePresets();
		const prepared = preparePolicyWithLanePresets(
			`apiVersion: gatekeeper/v1
lanes:
  human: { type: human-approval, min: 2, fresh: false }
levels:
  strict:
    enforcement: block
    require: { m: 1, lanes: [human] }
`,
			presets,
			"custom-policy.yaml",
		);
		const registry = parseRegistry([{ path: "policy.yaml", content: prepared.policyYaml }]);
		expect(registry.policy.lanes.human).toEqual({ type: "human-approval", min: 2, fresh: false });
		expect(registry.policy.lanes.greptile).toMatchObject({ type: "check-run" });
		expect(prepared.conflicts).toEqual([
			{
				lane: "human",
				presetFile: expect.stringMatching(/lanes\.d\/human\.yaml$/),
				userFile: "custom-policy.yaml",
				resolution: "user-wins",
			},
		]);
	});

	it("allows and preserves x-* extensions on the lane, review pass, and body regex object", async () => {
		const presets = await loadLanePresets();
		const prepared = preparePolicyWithLanePresets(
			`apiVersion: gatekeeper/v1
lanes:
  extended-review:
    type: review
    author: reviewer[bot]
    x-lane-owner: platform
    pass:
      state: COMMENTED
      x-pass-source: recorded-review
      body_matches:
        pattern: review summary
        ignore_case: true
        x-regex-note: stable-copy
levels:
  strict:
    enforcement: block
    require: { m: 1, lanes: [extended-review] }
`,
			presets,
		);
		const registry = parseRegistry([{ path: "policy.yaml", content: prepared.policyYaml }]);
		expect(registry.policy.lanes["extended-review"]).toEqual({
			type: "review",
			author: "reviewer[bot]",
			"x-lane-owner": "platform",
			pass: {
				state: "COMMENTED",
				"x-pass-source": "recorded-review",
				body_matches: {
					pattern: "review summary",
					ignore_case: true,
					"x-regex-note": "stable-copy",
				},
			},
		});
	});

	it("reports user lane errors as complete structured registry issues", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "gatekeeper-policy-lanes-"));
		try {
			await writeFile(
				path.join(directory, "policy.yaml"),
				`apiVersion: gatekeeper/v1
lanes:
  broken-review:
    type: review
    author: reviewer[bot]
    lane_note: rejected
    pass:
      state: COMMENTED
      pass_note: rejected
      body_matches:
        pattern: review summary
        regex_note: rejected
levels: {}
`,
				"utf8",
			);

			let captured: unknown;
			try {
				await loadRegistryWithLanePresets(directory);
			} catch (error) {
				captured = error;
			}
			expect(captured).toBeInstanceOf(RegistryParseError);
			expect((captured as RegistryParseError).issues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						file: "policy.yaml",
						path: "$.lanes.broken-review.lane_note",
						expected: "a known key or x-* extension",
						actual: '"rejected"',
						hint: expect.stringContaining("Unknown key"),
					}),
					expect.objectContaining({
						path: "$.lanes.broken-review.pass.pass_note",
						expected: "a known key or x-* extension",
						actual: '"rejected"',
						hint: expect.stringContaining("Unknown key"),
					}),
					expect.objectContaining({
						path: "$.lanes.broken-review.pass.body_matches.regex_note",
						expected: "a known key or x-* extension",
						actual: '"rejected"',
						hint: expect.stringContaining("Unknown key"),
					}),
				]),
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("gate classifies a user lane schema error as invalid before creating a provider", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "gatekeeper-invalid-gate-lane-"));
		try {
			await writeFile(
				path.join(directory, "policy.yaml"),
				`apiVersion: gatekeeper/v1
lanes:
  broken: { type: check-run, name: build-*, pas: [success] }
levels: {}
`,
				"utf8",
			);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const createProvider = vi.fn(() => {
				throw new Error("provider must not be created for an invalid registry");
			});

			const exitCode = await runGate({ pr: 7, registry: directory, repo: "acme/app", json: true }, directory, {
				createProvider,
			});

			expect(exitCode).toBe(1);
			expect(createProvider).not.toHaveBeenCalled();
			expect(stderr.mock.calls.map(([message]) => String(message)).join("\n")).toContain("GATEKEEPER INVALID");
			expect(stdout.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				"expected a known key or x-* extension",
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects unknown preset keys and invalid body regexes", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "gatekeeper-lanes-"));
		try {
			await writeFile(
				path.join(directory, "broken.yaml"),
				"type: comment-scan\nauthor: bot-*\nbody_matches: '['\nunknown: true\n",
				"utf8",
			);
			await expect(loadLanePresets(directory)).rejects.toBeInstanceOf(LanePresetParseError);
			await expect(loadLanePresets(directory)).rejects.toMatchObject({
				issues: expect.arrayContaining([
					expect.objectContaining({ path: "$.unknown" }),
					expect.objectContaining({ path: "$.body_matches" }),
				]),
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
