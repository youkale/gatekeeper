import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runTriage, type TriageDependencies, type TriageOptions } from "../src/commands/triage.js";
import { parseRegistry } from "../src/engine/registry.js";
import { InfraError } from "../src/providers/github.js";
import {
	buildTriageLedgerEntry,
	findConsumerImpact,
	renderTriageBriefing,
	renderTriageComment,
	summarizeContracts,
	type TriageContractSummary,
	type TriageVerdict,
} from "../src/render/triage.js";
import { selectAllTiers } from "../src/roles/policy.js";

const POLICY_YAML = `apiVersion: gatekeeper/v1
lanes: {}
levels:
  notify:
    enforcement: warn
    require: {}
  strict:
    enforcement: block
    require: {}
`;

const CONTRACT_YAML = `apiVersion: gatekeeper/v1
name: shared-api-schema
description: checkout <-> billing wire shape
level: notify
authority:
  repo: acme/checkout-service
  paths: ["src/api/**"]
consumers:
  - repo: acme/billing-service
    paths: ["src/clients/checkout/**"]
    role: consumer
    verify: schema round-trips
`;

const registry = parseRegistry([
	{ path: "policy.yaml", content: POLICY_YAML },
	{ path: "contracts/api.yaml", content: CONTRACT_YAML },
]);

// ---------------------------------------------------------------------------
// Pure render/triage.ts unit tests
// ---------------------------------------------------------------------------

describe("summarizeContracts", () => {
	it("maps registry contracts into a sorted summary", () => {
		const summary = summarizeContracts(registry);
		expect(summary).toEqual([
			{
				name: "shared-api-schema",
				level: "notify",
				description: "checkout <-> billing wire shape",
				authorityRepo: "acme/checkout-service",
				authorityPaths: ["src/api/**"],
				consumers: [
					{
						repo: "acme/billing-service",
						role: "consumer",
						paths: ["src/clients/checkout/**"],
						verify: "schema round-trips",
					},
				],
			},
		]);
	});
});

describe("findConsumerImpact", () => {
	const contracts: TriageContractSummary[] = summarizeContracts(registry);

	it("matches a contract by repo name mentioned in issue text", () => {
		const hits = findConsumerImpact(contracts, "Please update acme/billing-service to add a new field.");
		expect(hits).toEqual([
			{ contract: "shared-api-schema", matchedRepos: ["acme/billing-service"], matchedPathHints: [] },
		]);
	});

	it("matches a contract by a static glob path prefix mentioned in issue text", () => {
		const hits = findConsumerImpact(contracts, "The change touches src/api/checkout.proto directly.");
		expect(hits).toEqual([{ contract: "shared-api-schema", matchedRepos: [], matchedPathHints: ["src/api"] }]);
	});

	it("is case-insensitive", () => {
		const hits = findConsumerImpact(contracts, "ACME/CHECKOUT-SERVICE needs a change.");
		expect(hits).toHaveLength(1);
	});

	it("returns no hits when nothing in the text matches", () => {
		expect(findConsumerImpact(contracts, "totally unrelated request about the coffee machine")).toEqual([]);
	});
});

describe("renderTriageBriefing", () => {
	it("renders a stable snapshot with issue content, contracts, impact, and tiers", () => {
		const tiers = selectAllTiers(
			{
				apiVersion: "gatekeeper/v1",
				tiers: {
					"deep-reasoner": { prefer: ["anthropic/claude-fable-5"], count: 1, crossVendor: false },
					coder: { prefer: ["openai/gpt-5.4-codex"], count: 1, crossVendor: false },
				},
			},
			{ known: true, authKnown: true, modelsKnown: false, vendors: new Set(["anthropic"]) },
		);
		const briefing = renderTriageBriefing({
			key: "acme/checkout-service#42",
			repo: "acme/checkout-service",
			issue: {
				number: 42,
				title: "Add a `region` field to checkout",
				body: "We need acme/billing-service to consume a new field under src/api/.",
				author: "octocat",
				labels: ["gatekeeper:triage"],
				url: "https://github.com/acme/checkout-service/issues/42",
			},
			contracts: summarizeContracts(registry),
			impact: findConsumerImpact(summarizeContracts(registry), "acme/billing-service src/api/"),
			tiers,
		});

		expect(briefing).toContain("# Gatekeeper Triage 简报: acme/checkout-service#42");
		expect(briefing).toContain("编号: #42");
		expect(briefing).toContain("Add a 'region' field to checkout");
		expect(briefing).toContain("| shared-api-schema | notify |");
		expect(briefing).toContain("acme/billing-service");
		expect(briefing).toContain("deep-reasoner");
		expect(briefing).toContain("anthropic/claude-fable-5");
		expect(briefing).toContain("gatekeeper triage --issue 42 --repo acme/checkout-service");
		expect(briefing.endsWith("\n")).toBe(true);
	});

	it("neutralizes markdown-breaking characters in untrusted issue title/body", () => {
		const briefing = renderTriageBriefing({
			key: "acme/x#1",
			repo: "acme/x",
			issue: {
				number: 1,
				title: "backtick ` in title\nwith newline",
				body: "```\nfence break attempt\n```",
				author: null,
				labels: [],
			},
			contracts: [],
			impact: [],
			tiers: [],
		});
		expect(briefing).not.toContain("backtick ` in title");
		expect(briefing).toContain("backtick ' in title with newline");
	});

	it("explains why issue content is missing when the fetch failed", () => {
		const briefing = renderTriageBriefing({
			key: "acme/x#1",
			repo: "acme/x",
			issue: null,
			issueFetchWarning: "GitHub request failed: network down",
			contracts: [],
			impact: [],
			tiers: [],
		});
		expect(briefing).toContain("issue content unavailable: GitHub request failed: network down");
	});
});

describe("buildTriageLedgerEntry / renderTriageComment", () => {
	const verdict: TriageVerdict = {
		decision: "accepted",
		reason_summary: "aligns with existing checkout/billing contract",
		suggested_level: "notify",
		dispatch: { coder: "openai/gpt-5.4-codex", reviewers: ["anthropic/claude-opus-4-8", "xai/grok-5-code"] },
		acceptance_criteria: ["updates the shared-api-schema contract", "adds a lane for billing-service"],
	};

	it("builds the exact ledger line shape from the spec", () => {
		const entry = buildTriageLedgerEntry("acme/checkout-service#42", verdict, "2026-07-18T12:00:00Z");
		expect(entry).toEqual({
			schema_version: 1,
			kind: "triage",
			key: "acme/checkout-service#42",
			decision: "accepted",
			reason_summary: "aligns with existing checkout/billing contract",
			suggested_level: "notify",
			dispatch: { coder: "openai/gpt-5.4-codex", reviewers: ["anthropic/claude-opus-4-8", "xai/grok-5-code"] },
			at: "2026-07-18T12:00:00Z",
		});
	});

	it("renders a structured comment embedding the ledger as a fenced json block", () => {
		const entry = buildTriageLedgerEntry("acme/checkout-service#42", verdict, "2026-07-18T12:00:00Z");
		const comment = renderTriageComment("acme/checkout-service#42", verdict, entry, "octocat");
		expect(comment.startsWith("<!-- gatekeeper:triage -->\n")).toBe(true);
		expect(comment).toContain("ACCEPTED");
		expect(comment).toContain("处理人: `octocat`");
		expect(comment).toContain("updates the shared-api-schema contract");
		expect(comment).toContain("- coder: `openai/gpt-5.4-codex`");
		expect(comment).toContain("```json gatekeeper-triage-ledger");
		expect(comment).toContain('"kind": "triage"');
		expect(comment).not.toContain("```json gatekeeper-ledger\n");
		// reviewers line points at the packaged code-reviewer card path by default (no explicit override given).
		expect(comment).toContain("按 `docs/roles/code-reviewer.md` 角色卡执行 review");
	});

	it("points the reviewers line at an explicitly resolved code-reviewer card path when one is given", () => {
		const entry = buildTriageLedgerEntry("acme/checkout-service#42", verdict, "2026-07-18T12:00:00Z");
		const comment = renderTriageComment(
			"acme/checkout-service#42",
			verdict,
			entry,
			"octocat",
			"governance/roles/code-reviewer.md",
		);
		expect(comment).toContain("按 `governance/roles/code-reviewer.md` 角色卡执行 review");
		expect(comment).not.toContain("docs/roles/code-reviewer.md");
	});
});

// ---------------------------------------------------------------------------
// Command layer: runTriage
// ---------------------------------------------------------------------------

function githubIssue(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		number: 42,
		title: "Add a region field to checkout",
		body: "We need acme/billing-service to consume it.",
		user: { login: "octocat" },
		labels: [],
		html_url: "https://github.com/acme/checkout-service/issues/42",
		...overrides,
	};
}

interface ProviderStubOptions {
	issue?: ReturnType<typeof githubIssue> | null;
	issueError?: InfraError;
	commentError?: InfraError;
	labelError?: InfraError;
	removeLabelError?: InfraError;
}

function providerStub(options: ProviderStubOptions = {}) {
	const getIssue = vi.fn(async () => {
		if (options.issueError) {
			throw options.issueError;
		}
		return options.issue ?? githubIssue();
	});
	const createIssueComment = vi.fn(async (_issueNumber: number, body: string) => {
		if (options.commentError) {
			throw options.commentError;
		}
		return { id: 1, body, created_at: "2026-07-18T12:00:00Z", updated_at: "2026-07-18T12:00:00Z", user: null };
	});
	const addIssueLabels = vi.fn(async (_issueNumber: number, labels: string[]) => {
		if (options.labelError) {
			throw options.labelError;
		}
		return labels.map((name) => ({ name }));
	});
	const removeIssueLabel = vi.fn(async (_issueNumber: number, _label: string) => {
		if (options.removeLabelError) {
			throw options.removeLabelError;
		}
	});
	return { getIssue, createIssueComment, addIssueLabels, removeIssueLabel };
}

describe("runTriage", () => {
	let registryDir: string;
	let cwd: string;

	beforeEach(async () => {
		vi.spyOn(globalThis, "fetch");
		registryDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-triage-registry-"));
		await writeFile(path.join(registryDir, "policy.yaml"), POLICY_YAML, "utf8");
		await mkdir(path.join(registryDir, "contracts"), { recursive: true });
		await writeFile(path.join(registryDir, "contracts", "api.yaml"), CONTRACT_YAML, "utf8");
		cwd = await mkdtemp(path.join(tmpdir(), "gatekeeper-triage-cwd-"));
	});

	afterEach(async () => {
		expect(globalThis.fetch).not.toHaveBeenCalled();
		vi.restoreAllMocks();
		await rm(registryDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	});

	function baseOptions(overrides: Partial<TriageOptions> = {}): TriageOptions {
		return { issue: 42, repo: "acme/checkout-service", registry: registryDir, ...overrides };
	}

	function baseDependencies(
		stub: ReturnType<typeof providerStub>,
		overrides: TriageDependencies = {},
	): TriageDependencies {
		return {
			createProvider: () => stub,
			piConfigDir: path.join(cwd, "no-such-pi-config"),
			...overrides,
		};
	}

	it("prints a briefing to stdout and exits 0", async () => {
		const stub = providerStub();
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const exitCode = await runTriage(baseOptions(), cwd, baseDependencies(stub));

		expect(exitCode).toBe(0);
		expect(stub.getIssue).toHaveBeenCalledWith(42);
		expect(stub.createIssueComment).not.toHaveBeenCalled();
		expect(stub.addIssueLabels).not.toHaveBeenCalled();
		expect(stub.removeIssueLabel).not.toHaveBeenCalled();
		const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(output).toContain("# Gatekeeper Triage 简报: acme/checkout-service#42");
		expect(output).toContain("shared-api-schema");
	});

	it("still produces a briefing when the GitHub issue fetch fails with an infra fault", async () => {
		const stub = providerStub({
			issueError: new InfraError("network down", { kind: "network", operation: "read issue #42" }),
		});
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const exitCode = await runTriage(baseOptions(), cwd, baseDependencies(stub));

		expect(exitCode).toBe(0);
		const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(output).toContain("issue content unavailable");
		expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("无法读取 issue");
	});

	it("[regression] end-to-end: a models.json confirmation (auth.json unparsable) shows in the briefing without the 'unconfirmed' annotation", async () => {
		const stub = providerStub();
		const piConfigDir = path.join(cwd, "pi-config");
		await mkdir(piConfigDir, { recursive: true });
		// auth.json is readable but fails JSON.parse (the inner parse-catch branch) --
		// models.json must still be read and honored independently (no roles-policy.yaml
		// override in cwd, so this resolves the real package-shipped roles-policy.yaml,
		// whose deep-reasoner tier prefers "anthropic/claude-fable-5" first).
		await writeFile(path.join(piConfigDir, "auth.json"), "{not json", "utf8");
		await writeFile(
			path.join(piConfigDir, "models.json"),
			JSON.stringify({ providers: { anthropic: { models: [{ id: "claude-fable-5" }] } } }),
			"utf8",
		);
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const exitCode = await runTriage(baseOptions(), cwd, { createProvider: () => stub, piConfigDir });

		expect(exitCode).toBe(0);
		const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(output).toContain("anthropic/claude-fable-5");
		expect(output).not.toContain("anthropic/claude-fable-5 (未经模型级确认)");
	});

	it("returns a usage error (2) for a malformed --repo", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const exitCode = await runTriage(baseOptions({ repo: "not-org-slash-repo" }), cwd, {
			piConfigDir: path.join(cwd, "no-such-pi-config"),
		});
		expect(exitCode).toBe(2);
		expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("gatekeeper triage:");
	});

	it("returns 1 for a structurally invalid registry", async () => {
		const brokenRegistry = await mkdtemp(path.join(tmpdir(), "gatekeeper-triage-broken-"));
		try {
			await writeFile(
				path.join(brokenRegistry, "policy.yaml"),
				`apiVersion: gatekeeper/v1
lanes: {}
levels:
  notify:
    enforcement: not-a-real-enforcement
    require: {}
`,
				"utf8",
			);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const exitCode = await runTriage(baseOptions({ registry: brokenRegistry }), cwd, {
				piConfigDir: path.join(cwd, "no-such-pi-config"),
			});
			expect(exitCode).toBe(1);
			expect(stderr.mock.calls.length).toBeGreaterThan(0);
		} finally {
			await rm(brokenRegistry, { recursive: true, force: true });
		}
	});

	describe("--post", () => {
		const verdictPayload = {
			decision: "accepted",
			reason_summary: "aligns with the shared-api-schema contract",
			suggested_level: "notify",
			dispatch: { coder: "openai/gpt-5.4-codex", reviewers: ["anthropic/claude-opus-4-8", "xai/grok-5-code"] },
			acceptance_criteria: ["update contract", "add lane"],
			at: "2026-07-18T12:00:00Z",
		};

		async function writeVerdictFile(payload: unknown, name = "verdict.json"): Promise<string> {
			const file = path.join(cwd, name);
			await writeFile(file, JSON.stringify(payload), "utf8");
			return name;
		}

		async function writeRolesPolicyFixture(
			overrides: { reviewerCount?: number; crossVendor?: boolean } = {},
			name = "roles-policy-test.yaml",
		): Promise<string> {
			const file = path.join(cwd, name);
			await writeFile(
				file,
				`apiVersion: gatekeeper/v1
tiers:
  reviewer:
    prefer: ["openai/gpt-5.4-codex", "anthropic/claude-opus-4-8", "xai/grok-5-code"]
    count: ${overrides.reviewerCount ?? 2}
    cross_vendor: ${overrides.crossVendor ?? true}
`,
				"utf8",
			);
			return file;
		}

		async function expectNoLedgerFile(): Promise<void> {
			await expect(readFile(path.join(cwd, ".gatekeeper", "triage-ledger.jsonl"), "utf8")).rejects.toThrow();
		}

		it("requires --verdict-file", async () => {
			const stub = providerStub();
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const exitCode = await runTriage(baseOptions({ post: true }), cwd, baseDependencies(stub));
			expect(exitCode).toBe(2);
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("--verdict-file is required");
		});

		it("rejects a malformed verdict file", async () => {
			const stub = providerStub();
			const verdictFile = await writeVerdictFile({ decision: "maybe" });
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const exitCode = await runTriage(baseOptions({ post: true, verdictFile }), cwd, baseDependencies(stub));
			expect(exitCode).toBe(2);
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("$.decision");
		});

		it("writes the local ledger, posts a comment, and applies the accepted label", async () => {
			const stub = providerStub();
			const verdictFile = await writeVerdictFile(verdictPayload);
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			const exitCode = await runTriage(
				baseOptions({ post: true, verdictFile, actor: "gatekeeper-bot" }),
				cwd,
				baseDependencies(stub),
			);

			expect(exitCode).toBe(0);
			expect(stub.createIssueComment).toHaveBeenCalledTimes(1);
			const [issueNumber, body] = stub.createIssueComment.mock.calls[0] ?? [];
			expect(issueNumber).toBe(42);
			expect(String(body)).toContain("处理人: `gatekeeper-bot`");
			expect(stub.addIssueLabels).toHaveBeenCalledWith(42, ["gatekeeper:accepted"]);
			// reviewers line points at the packaged code-reviewer card by its portable,
			// checkout-relative literal -- no filesystem-absolute path (registryDir/cwd) leaked
			// into a comment that may be read from a different machine or CI runner.
			expect(String(body)).toContain("按 `docs/roles/code-reviewer.md` 角色卡执行 review");
			expect(String(body)).not.toContain(registryDir);
			expect(String(body)).not.toContain(cwd);

			const ledgerPath = path.join(cwd, ".gatekeeper", "triage-ledger.jsonl");
			const ledgerContent = await readFile(ledgerPath, "utf8");
			const lines = ledgerContent.trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0] ?? "")).toEqual({
				schema_version: 1,
				kind: "triage",
				key: "acme/checkout-service#42",
				decision: "accepted",
				reason_summary: "aligns with the shared-api-schema contract",
				suggested_level: "notify",
				dispatch: { coder: "openai/gpt-5.4-codex", reviewers: ["anthropic/claude-opus-4-8", "xai/grok-5-code"] },
				at: "2026-07-18T12:00:00Z",
			});
			const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
			expect(output).toContain("recorded accepted for acme/checkout-service#42");
		});

		it("points the posted comment's reviewers line at a control repo's own code-reviewer card, expressed relative to --registry, never as a filesystem-absolute path", async () => {
			const stub = providerStub();
			await mkdir(path.join(registryDir, "roles"), { recursive: true });
			await writeFile(path.join(registryDir, "roles", "code-reviewer.md"), "# customized code-reviewer card\n", "utf8");
			const verdictFile = await writeVerdictFile(verdictPayload);
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			const exitCode = await runTriage(baseOptions({ post: true, verdictFile }), cwd, baseDependencies(stub));

			expect(exitCode).toBe(0);
			const [, body] = stub.createIssueComment.mock.calls[0] ?? [];
			expect(String(body)).toContain("按 `roles/code-reviewer.md` 角色卡执行 review");
			// No absolute filesystem path anywhere in the posted comment -- registryDir/cwd are
			// both mkdtemp absolute paths, neither of which may leak into persisted, cross-machine output.
			expect(String(body)).not.toContain(registryDir);
			expect(String(body)).not.toContain(cwd);
		});

		it("maps rejected/needs-info decisions to their labels", async () => {
			const stub = providerStub();
			const verdictFile = await writeVerdictFile({ ...verdictPayload, decision: "needs-info" });
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			await runTriage(baseOptions({ post: true, verdictFile }), cwd, baseDependencies(stub));

			expect(stub.addIssueLabels).toHaveBeenCalledWith(42, ["gatekeeper:needs-info"]);
		});

		it("still writes the local ledger and exits 0 when the GitHub comment write fails (fail-open)", async () => {
			const stub = providerStub({
				commentError: new InfraError("GitHub returned HTTP 500", {
					kind: "http",
					operation: "create comment",
					status: 500,
				}),
			});
			const verdictFile = await writeVerdictFile(verdictPayload);
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const exitCode = await runTriage(baseOptions({ post: true, verdictFile }), cwd, baseDependencies(stub));

			expect(exitCode).toBe(0);
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("无法回写 issue 评论");
			const ledgerPath = path.join(cwd, ".gatekeeper", "triage-ledger.jsonl");
			const ledgerContent = await readFile(ledgerPath, "utf8");
			expect(ledgerContent.trim().split("\n")).toHaveLength(1);
		});

		it("fills the ledger 'at' timestamp from the injected clock when the verdict file omits one", async () => {
			const stub = providerStub();
			const { at: _omit, ...withoutAt } = verdictPayload;
			const verdictFile = await writeVerdictFile(withoutAt);
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			await runTriage(baseOptions({ post: true, verdictFile }), cwd, {
				...baseDependencies(stub),
				now: () => "2099-01-01T00:00:00Z",
			});

			const ledgerPath = path.join(cwd, ".gatekeeper", "triage-ledger.jsonl");
			const ledgerContent = await readFile(ledgerPath, "utf8");
			expect(JSON.parse(ledgerContent.trim())).toMatchObject({ at: "2099-01-01T00:00:00Z" });
		});

		it("rejects a verdict whose suggested_level is not declared in the registry, before any write", async () => {
			const stub = providerStub();
			const verdictFile = await writeVerdictFile({ ...verdictPayload, suggested_level: "no-such-level" });
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const exitCode = await runTriage(baseOptions({ post: true, verdictFile }), cwd, baseDependencies(stub));

			expect(exitCode).toBe(2);
			expect(stub.createIssueComment).not.toHaveBeenCalled();
			expect(stub.addIssueLabels).not.toHaveBeenCalled();
			expect(stub.removeIssueLabel).not.toHaveBeenCalled();
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("no-such-level");
			await expectNoLedgerFile();
		});

		it("rejects fewer reviewers than the roles-policy reviewer tier's count requires, before any write", async () => {
			const stub = providerStub();
			const rolesPolicyPath = await writeRolesPolicyFixture({ reviewerCount: 2 });
			const verdictFile = await writeVerdictFile({
				...verdictPayload,
				dispatch: { coder: "openai/gpt-5.4-codex", reviewers: ["anthropic/claude-opus-4-8"] },
			});
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const exitCode = await runTriage(
				baseOptions({ post: true, verdictFile }),
				cwd,
				baseDependencies(stub, { rolesPolicyPath }),
			);

			expect(exitCode).toBe(2);
			expect(stub.createIssueComment).not.toHaveBeenCalled();
			expect(stub.addIssueLabels).not.toHaveBeenCalled();
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("at least 2 reviewer(s)");
			await expectNoLedgerFile();
		});

		it("rejects duplicate reviewer model ids, before any write", async () => {
			const stub = providerStub();
			const verdictFile = await writeVerdictFile({
				...verdictPayload,
				dispatch: {
					coder: "openai/gpt-5.4-codex",
					reviewers: ["anthropic/claude-opus-4-8", "anthropic/claude-opus-4-8"],
				},
			});
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const exitCode = await runTriage(baseOptions({ post: true, verdictFile }), cwd, baseDependencies(stub));

			expect(exitCode).toBe(2);
			expect(stub.createIssueComment).not.toHaveBeenCalled();
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("duplicate");
			await expectNoLedgerFile();
		});

		it("warns but proceeds when reviewers satisfy count but are not cross-vendor", async () => {
			const stub = providerStub();
			const rolesPolicyPath = await writeRolesPolicyFixture({ reviewerCount: 2, crossVendor: true });
			const verdictFile = await writeVerdictFile({
				...verdictPayload,
				dispatch: {
					coder: "openai/gpt-5.4-codex",
					reviewers: ["anthropic/claude-opus-4-8", "anthropic/claude-sonnet-5"],
				},
			});
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const exitCode = await runTriage(
				baseOptions({ post: true, verdictFile }),
				cwd,
				baseDependencies(stub, { rolesPolicyPath }),
			);

			expect(exitCode).toBe(0);
			expect(stub.createIssueComment).toHaveBeenCalledTimes(1);
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("not fully cross-vendor");
		});

		it("rejects a verdict when roles-policy cannot be loaded -- anomalous (defaultRolesPolicyPath always ships a real file), not routine 'unconfigured'", async () => {
			const stub = providerStub();
			// verdictPayload already carries 2 cross-vendor reviewers, satisfying the structural
			// floor on its own -- an explicit rolesPolicyPath override that resolves nowhere is
			// what must fail this, not the reviewer count.
			const verdictFile = await writeVerdictFile(verdictPayload);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const exitCode = await runTriage(baseOptions({ post: true, verdictFile }), cwd, {
				...baseDependencies(stub),
				rolesPolicyPath: path.join(cwd, "nonexistent-roles-policy.yaml"),
			});

			expect(exitCode).toBe(2);
			expect(stub.createIssueComment).not.toHaveBeenCalled();
			expect(stub.addIssueLabels).not.toHaveBeenCalled();
			expect(stub.removeIssueLabel).not.toHaveBeenCalled();
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("failed to load roles-policy");
			await expectNoLedgerFile();
		});

		it("enforces the structural double-review floor even when roles-policy's own reviewer tier requires fewer", async () => {
			const stub = providerStub();
			const rolesPolicyPath = await writeRolesPolicyFixture({ reviewerCount: 1, crossVendor: false });
			const verdictFile = await writeVerdictFile({
				...verdictPayload,
				dispatch: { coder: "openai/gpt-5.4-codex", reviewers: ["anthropic/claude-opus-4-8"] },
			});
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const exitCode = await runTriage(
				baseOptions({ post: true, verdictFile }),
				cwd,
				baseDependencies(stub, { rolesPolicyPath }),
			);

			expect(exitCode).toBe(2);
			expect(stub.createIssueComment).not.toHaveBeenCalled();
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("product default: double review");
			await expectNoLedgerFile();
		});

		it("raises the reviewer floor above the structural minimum when roles-policy's reviewer tier requires more (count=3)", async () => {
			const stub = providerStub();
			const rolesPolicyPath = await writeRolesPolicyFixture({ reviewerCount: 3, crossVendor: false });
			const verdictFile = await writeVerdictFile({
				...verdictPayload,
				// 2 reviewers satisfies the structural floor but not roles-policy's count=3.
				dispatch: {
					coder: "openai/gpt-5.4-codex",
					reviewers: ["anthropic/claude-opus-4-8", "xai/grok-5-code"],
				},
			});
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const exitCode = await runTriage(
				baseOptions({ post: true, verdictFile }),
				cwd,
				baseDependencies(stub, { rolesPolicyPath }),
			);

			expect(exitCode).toBe(2);
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("count=3");
			expect(stub.createIssueComment).not.toHaveBeenCalled();
		});

		it("resolves a cwd-local roles-policy.yaml override (no explicit dependency) the same way doctor does", async () => {
			await writeFile(
				path.join(cwd, "roles-policy.yaml"),
				`apiVersion: gatekeeper/v1
tiers:
  reviewer:
    prefer: ["openai/gpt-5.4-codex", "anthropic/claude-opus-4-8"]
    count: 3
    cross_vendor: false
`,
				"utf8",
			);
			const stub = providerStub();
			const verdictFile = await writeVerdictFile(verdictPayload); // only 2 reviewers
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const exitCode = await runTriage(baseOptions({ post: true, verdictFile }), cwd, {
				createProvider: () => stub,
				piConfigDir: path.join(cwd, "no-such-pi-config"),
				// deliberately no rolesPolicyPath override -- must resolve <cwd>/roles-policy.yaml
			});

			expect(exitCode).toBe(2);
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("count=3");
		});

		it("unconditionally clears both non-target decision labels before applying the new one -- no pre-read, no TOCTOU", async () => {
			const stub = providerStub();
			const verdictFile = await writeVerdictFile(verdictPayload); // decision: accepted
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			const exitCode = await runTriage(baseOptions({ post: true, verdictFile }), cwd, baseDependencies(stub));

			expect(exitCode).toBe(0);
			// No snapshot read of the issue's current labels -- nothing to go stale under concurrent runs.
			expect(stub.getIssue).not.toHaveBeenCalled();
			expect(stub.removeIssueLabel).toHaveBeenCalledTimes(2);
			expect(stub.removeIssueLabel).toHaveBeenCalledWith(42, "gatekeeper:rejected");
			expect(stub.removeIssueLabel).toHaveBeenCalledWith(42, "gatekeeper:needs-info");
			expect(stub.addIssueLabels).toHaveBeenCalledWith(42, ["gatekeeper:accepted"]);
		});

		it("never issues a DELETE for labels outside the three managed gatekeeper decision labels", async () => {
			const stub = providerStub();
			const verdictFile = await writeVerdictFile(verdictPayload); // decision: accepted
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			await runTriage(baseOptions({ post: true, verdictFile }), cwd, baseDependencies(stub));

			const removedLabels = stub.removeIssueLabel.mock.calls.map(([, label]) => label);
			expect([...removedLabels].sort()).toEqual(["gatekeeper:needs-info", "gatekeeper:rejected"]);
		});

		it("does not add the new label when a cleanup DELETE genuinely fails (avoids three-way label pollution)", async () => {
			const stub = providerStub({
				removeLabelError: new InfraError("GitHub returned HTTP 403", {
					kind: "http",
					operation: "remove label",
					status: 403,
				}),
			});
			const verdictFile = await writeVerdictFile(verdictPayload);
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

			const exitCode = await runTriage(baseOptions({ post: true, verdictFile }), cwd, baseDependencies(stub));

			// Fail-open at the process level (exit 0) -- the local ledger line already durably
			// recorded the decision -- but the target label must not be added, to avoid ending up
			// with e.g. needs-info + rejected + accepted all present at once.
			expect(exitCode).toBe(0);
			expect(stub.addIssueLabels).not.toHaveBeenCalled();
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("无法清理旧标签");
		});
	});
});
