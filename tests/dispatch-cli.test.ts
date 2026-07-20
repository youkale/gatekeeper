import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument, stringify } from "yaml";
import type { DetectedAgentCli } from "../src/agent/detect.js";
import {
	DISPATCH_ATTENTION_EXIT_CODE,
	runDispatchCancel,
	runDispatchLogs,
	runDispatchResume,
	runDispatchStart,
	runDispatchStatus,
} from "../src/commands/dispatch.js";
import { saveRepos } from "../src/config/repos.js";
import {
	appendJournalEvent,
	createOrder,
	dispatchOrderDirectory,
	type LoadedWorkOrder,
} from "../src/dispatch/store.js";
import type { SuperviseWorkOrderInput, SupervisionResult } from "../src/dispatch/supervisor.js";
import type { Run, WorkOrder } from "../src/dispatch/types.js";
import { InfraError } from "../src/providers/github.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	temporaryDirectories.push(dir);
	return dir;
}

function captureStdout(): { text: () => string } {
	const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	return { text: () => spy.mock.calls.map(([chunk]) => String(chunk)).join("") };
}

function captureStderr(): { text: () => string } {
	const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return { text: () => spy.mock.calls.map(([chunk]) => String(chunk)).join("") };
}

const FIXED_NOW = () => new Date("2026-07-20T00:00:00.000Z");

async function makeOrder(
	env: NodeJS.ProcessEnv,
	targetPath: string,
	overrides: { associationKey?: string; candidateLadder?: WorkOrder["candidate_ladder"] } = {},
): Promise<LoadedWorkOrder> {
	let counter = 0;
	return createOrder(
		{
			association_key: overrides.associationKey ?? "acme/widgets#42",
			target_repo: { name: "acme/widgets", path: targetPath },
			brief: "Implement the thing.\n",
			acceptance_contract: {
				result_path: "out/RESULT.json",
				progress_path: "out/PROGRESS.md",
				require_non_wip_commit: true,
				criteria: [],
			},
			candidate_ladder: overrides.candidateLadder ?? [
				{ cli: "codex", vendor: "openai", command: "codex exec {brief} {out}" },
			],
		},
		{ env, now: FIXED_NOW, randomUUID: () => `fixed-${counter++}-${Math.random()}` },
	);
}

interface RunMetaOverrides {
	outcome?: Run["outcome"];
	exitCode?: number | null;
	signal?: string | null;
	pid?: number;
	pgid?: number;
}

async function writeRunMeta(
	env: NodeJS.ProcessEnv,
	orderId: string,
	runId: string,
	overrides: RunMetaOverrides = {},
): Promise<void> {
	const orderDirectory = dispatchOrderDirectory(orderId, env);
	const runDirectory = path.join(orderDirectory, "runs", runId);
	await mkdir(path.join(runDirectory, "out"), { recursive: true });
	await writeFile(path.join(runDirectory, "brief.md"), "run brief", "utf8");
	await writeFile(path.join(runDirectory, "stdout.log"), "line one\nline two\n", "utf8");
	await writeFile(path.join(runDirectory, "stderr.log"), "warn: something\n", "utf8");
	const meta: Record<string, unknown> = {
		apiVersion: "gatekeeper/v1",
		id: runId,
		cli: "codex",
		vendor: "openai",
		command: "codex exec {brief} {out}",
		brief_path: `runs/${runId}/brief.md`,
		started_at: "2026-07-20T00:00:00.000Z",
		stdout_path: `runs/${runId}/stdout.log`,
		stderr_path: `runs/${runId}/stderr.log`,
		out_path: `runs/${runId}/out`,
		...(overrides.pid !== undefined ? { pid: overrides.pid } : {}),
		...(overrides.pgid !== undefined ? { pgid: overrides.pgid } : {}),
	};
	if (overrides.outcome) {
		meta.ended_at = "2026-07-20T01:00:00.000Z";
		meta.outcome = overrides.outcome;
		meta.exit_code = overrides.exitCode ?? null;
		meta.signal = overrides.signal ?? null;
	}
	await writeFile(path.join(runDirectory, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
}

async function setAuthoringVendors(env: NodeJS.ProcessEnv, orderId: string, vendors: string[]): Promise<void> {
	const file = path.join(dispatchOrderDirectory(orderId, env), "order.yaml");
	const content = await readFile(file, "utf8");
	const document = parseDocument(content);
	const data = document.toJS() as Record<string, unknown>;
	data.authoring_vendors = vendors;
	await writeFile(file, stringify(data), "utf8");
}

function fakeSupervise(result: SupervisionResult): { fn: ReturnType<typeof vi.fn>; calls: SuperviseWorkOrderInput[] } {
	const calls: SuperviseWorkOrderInput[] = [];
	const fn = vi.fn(async (input: SuperviseWorkOrderInput) => {
		calls.push(input);
		return result;
	});
	return { fn, calls };
}

/** A canned GitHub issue provider stub -- every runDispatchStart test that reaches brief synthesis must inject
 * one of these (or pass --brief) so the suite never performs a real network call, matching tests/triage.test.ts's
 * `expect(globalThis.fetch).not.toHaveBeenCalled()` discipline (enforced below via the runDispatchStart describe
 * block's own beforeEach/afterEach). */
function stubIssueProvider(): { getIssue: ReturnType<typeof vi.fn> } {
	return {
		getIssue: vi.fn(async (issueNumber: number) => ({
			number: issueNumber,
			title: "A sample issue",
			body: "Sample issue body.",
			user: { login: "octocat" },
			labels: [],
		})),
	};
}

function baseResult(overrides: Partial<SupervisionResult> = {}): SupervisionResult {
	return {
		orderId: "wo-placeholder",
		state: "DELIVERED",
		runs: [],
		authoringVendors: [],
		warnings: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// dispatch start
// ---------------------------------------------------------------------------

describe("runDispatchStart", () => {
	let configDir: string;
	let targetDir: string;
	let registryDir: string;
	let env: NodeJS.ProcessEnv;

	async function setup(): Promise<void> {
		configDir = await tempDir("gatekeeper-dispatch-cli-config-");
		targetDir = await tempDir("gatekeeper-dispatch-cli-target-");
		registryDir = await tempDir("gatekeeper-dispatch-cli-registry-");
		env = { GATEKEEPER_CONFIG_DIR: configDir };
		await saveRepos(registryDir, [
			{ repo: "acme/widgets", path: targetDir, ci: "none", adopted_at: "2026-07-01T00:00:00.000Z" },
		]);
	}

	beforeEach(async () => {
		vi.spyOn(globalThis, "fetch");
		await setup();
	});

	afterEach(() => {
		// Every test below must inject a createProvider stub (or pass --brief) before it can reach --issue-mode
		// brief synthesis -- this suite never performs a real network call, matching tests/triage.test.ts's
		// discipline for the same GitHub-issue-fetch code path.
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("creates an order and returns 0 when supervision delivers", async () => {
		const { fn: supervise, calls } = fakeSupervise(baseResult({ orderId: "placeholder", state: "DELIVERED" }));
		const stdout = captureStdout();

		const exitCode = await runDispatchStart(
			{ issue: 42, registry: registryDir, repo: "acme/widgets", agentCommand: "custom-cli {brief} {out}", yes: true },
			targetDir,
			{ env, now: FIXED_NOW, supervise: supervise as unknown as typeof supervise, createProvider: stubIssueProvider },
		);

		expect(exitCode).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.baseRef).toBeDefined();
		expect(stdout.text()).toContain("created order wo-");
		expect(stdout.text()).toContain("-> DELIVERED");

		const ledger = await readFile(path.join(targetDir, ".gatekeeper", "dispatch-ledger.jsonl"), "utf8");
		expect(JSON.parse(ledger.trim())).toMatchObject({ kind: "dispatch", key: "acme/widgets#42", outcome: "DELIVERED" });
	});

	it("returns 2 when --repo is not registered (and never calls supervise)", async () => {
		const stderr = captureStderr();
		const { fn: supervise, calls } = fakeSupervise(baseResult());

		const exitCode = await runDispatchStart(
			{ issue: 1, registry: registryDir, repo: "acme/unregistered", yes: true, agentCommand: "custom {brief} {out}" },
			targetDir,
			{ env, now: FIXED_NOW, supervise: supervise as unknown as typeof supervise },
		);

		expect(exitCode).toBe(2);
		expect(stderr.text()).toContain("is not registered in");
		expect(supervise).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
	});

	it("returns 2 when the registry cannot be resolved (and never calls supervise)", async () => {
		const stderr = captureStderr();
		const { fn: supervise, calls } = fakeSupervise(baseResult());

		const exitCode = await runDispatchStart({ issue: 1, repo: "acme/widgets", yes: true }, targetDir, {
			env: {},
			now: FIXED_NOW,
			supervise: supervise as unknown as typeof supervise,
		});

		expect(exitCode).toBe(2);
		expect(stderr.text()).toContain("--registry is required");
		expect(supervise).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
	});

	it("returns 2 when --brief names a file that cannot be read", async () => {
		const stderr = captureStderr();

		const exitCode = await runDispatchStart(
			{
				issue: 1,
				registry: registryDir,
				repo: "acme/widgets",
				brief: "does-not-exist.md",
				yes: true,
				agentCommand: "custom {brief} {out}",
			},
			targetDir,
			{ env, now: FIXED_NOW },
		);

		expect(exitCode).toBe(2);
		expect(stderr.text()).toContain("failed to read --brief");
	});

	it("requires --yes outside an interactive TTY and creates no order when aborted", async () => {
		captureStdout();
		const stderr = captureStderr();

		const exitCode = await runDispatchStart(
			{ issue: 1, registry: registryDir, repo: "acme/widgets", agentCommand: "custom {brief} {out}" },
			targetDir,
			{ env, now: FIXED_NOW, isInteractive: false, createProvider: stubIssueProvider },
		);

		expect(exitCode).toBe(2);
		expect(stderr.text()).toContain("not an interactive TTY");
		const orders = await import("../src/dispatch/store.js").then((mod) => mod.listOrders(env));
		expect(orders).toHaveLength(0);
	});

	it("prompts interactively and aborts without creating an order when declined", async () => {
		const stdout = captureStdout();
		const promptConfirm = vi.fn(async () => false);

		const exitCode = await runDispatchStart(
			{ issue: 1, registry: registryDir, repo: "acme/widgets", agentCommand: "custom {brief} {out}" },
			targetDir,
			{ env, now: FIXED_NOW, isInteractive: true, promptConfirm, createProvider: stubIssueProvider },
		);

		expect(exitCode).toBe(0);
		expect(promptConfirm).toHaveBeenCalledTimes(1);
		expect(stdout.text()).toContain("aborted (not confirmed)");
		const orders = await import("../src/dispatch/store.js").then((mod) => mod.listOrders(env));
		expect(orders).toHaveLength(0);
	});

	it("returns 2 when no coder-capable agent CLI is detected and no --agent-command is given", async () => {
		const stderr = captureStderr();

		const exitCode = await runDispatchStart(
			{ issue: 1, registry: registryDir, repo: "acme/widgets", yes: true },
			targetDir,
			{
				env,
				now: FIXED_NOW,
				detectAgentClis: async () => [],
				loadRolesPolicy: async () => ({ apiVersion: "gatekeeper/v1", tiers: {} }),
				createProvider: stubIssueProvider,
			},
		);

		expect(exitCode).toBe(2);
		expect(stderr.text()).toContain("no coder-capable agent CLI is available");
	});

	it("orders the candidate ladder by the coder tier's preferred vendor sequence", async () => {
		captureStdout();
		const detected: DetectedAgentCli[] = [
			{
				name: "grok",
				binary: "grok",
				vendor: "xai",
				tiers: ["coder"],
				commandTemplate: "grok {brief} {out}",
				path: "/bin/grok",
				version: null,
			},
			{
				name: "codex",
				binary: "codex",
				vendor: "openai",
				tiers: ["coder"],
				commandTemplate: "codex {brief} {out}",
				path: "/bin/codex",
				version: null,
			},
		];
		const { fn: supervise } = fakeSupervise(baseResult());

		const exitCode = await runDispatchStart(
			{ issue: 1, registry: registryDir, repo: "acme/widgets", yes: true },
			targetDir,
			{
				env,
				now: FIXED_NOW,
				supervise: supervise as unknown as typeof supervise,
				detectAgentClis: async () => detected,
				loadRolesPolicy: async () => ({
					apiVersion: "gatekeeper/v1",
					tiers: { coder: { prefer: ["openai/gpt-5.4-codex", "xai/grok-5-code"], count: 1, crossVendor: false } },
				}),
				createProvider: stubIssueProvider,
			},
		);
		expect(exitCode).toBe(0);

		const orders = await import("../src/dispatch/store.js").then((mod) => mod.listOrders(env));
		const capturedOrder: LoadedWorkOrder | undefined = orders[0];
		expect(capturedOrder?.order.candidate_ladder.map((candidate) => candidate.cli)).toEqual(["codex", "grok"]);
	});

	it("synthesizes the issue-mode brief and picks the LAST matching triage ledger line", async () => {
		captureStdout();
		const ledgerPath = path.join(targetDir, ".gatekeeper", "triage-ledger.jsonl");
		await mkdir(path.dirname(ledgerPath), { recursive: true });
		const firstLine = JSON.stringify({
			schema_version: 1,
			kind: "triage",
			key: "acme/widgets#42",
			decision: "needs-info",
			reason_summary: "first pass, unclear scope",
			suggested_level: "notify",
			dispatch: { coder: "openai/gpt-5.4-codex", reviewers: ["openai/gpt-5.4-codex", "anthropic/claude-opus-4-8"] },
			at: "2026-07-19T00:00:00.000Z",
		});
		const lastLine = JSON.stringify({
			schema_version: 1,
			kind: "triage",
			key: "acme/widgets#42",
			decision: "accepted",
			reason_summary: "re-triaged: scope clarified, accepted",
			suggested_level: "notify",
			dispatch: { coder: "openai/gpt-5.4-codex", reviewers: ["openai/gpt-5.4-codex", "anthropic/claude-opus-4-8"] },
			at: "2026-07-20T00:00:00.000Z",
		});
		await writeFile(ledgerPath, `${firstLine}\n${lastLine}\n`, "utf8");

		const { fn: supervise } = fakeSupervise(baseResult());
		const stub = {
			getIssue: vi.fn(async () => ({
				number: 42,
				title: "Add exporter",
				body: "please add it",
				user: { login: "octocat" },
				labels: [],
			})),
		};

		const exitCode = await runDispatchStart(
			{ issue: 42, registry: registryDir, repo: "acme/widgets", yes: true },
			targetDir,
			{
				env,
				now: FIXED_NOW,
				supervise: supervise as unknown as typeof supervise,
				createProvider: () => stub,
				detectAgentClis: async () => [
					{
						name: "codex",
						binary: "codex",
						vendor: "openai",
						tiers: ["coder"],
						commandTemplate: "codex {brief} {out}",
						path: "/bin/codex",
						version: null,
					},
				],
				loadRolesPolicy: async () => ({
					apiVersion: "gatekeeper/v1",
					tiers: { coder: { prefer: ["openai/gpt-5.4-codex"], count: 1, crossVendor: false } },
				}),
			},
		);

		expect(exitCode).toBe(0);
		const orders = await import("../src/dispatch/store.js").then((mod) => mod.listOrders(env));
		const brief = orders[0]?.brief ?? "";
		expect(brief).toContain("re-triaged: scope clarified, accepted");
		expect(brief).not.toContain("first pass, unclear scope");
	});

	it("degrades gracefully when the GitHub issue fetch fails (still creates an order)", async () => {
		const { fn: supervise } = fakeSupervise(baseResult());
		const stub = {
			getIssue: vi.fn(async () => {
				throw new InfraError("network down", { kind: "network", operation: "read issue" });
			}),
		};
		const stderr = captureStderr();
		captureStdout();

		const exitCode = await runDispatchStart(
			{ issue: 1, registry: registryDir, repo: "acme/widgets", yes: true },
			targetDir,
			{
				env,
				now: FIXED_NOW,
				supervise: supervise as unknown as typeof supervise,
				createProvider: () => stub,
				detectAgentClis: async () => [
					{
						name: "codex",
						binary: "codex",
						vendor: "openai",
						tiers: ["coder"],
						commandTemplate: "codex {brief} {out}",
						path: "/bin/codex",
						version: null,
					},
				],
				loadRolesPolicy: async () => ({
					apiVersion: "gatekeeper/v1",
					tiers: { coder: { prefer: ["openai/gpt-5.4-codex"], count: 1, crossVendor: false } },
				}),
			},
		);

		expect(exitCode).toBe(0);
		expect(stderr.text()).toContain("无法读取 issue");
	});

	it("returns 3 (not 1) when supervision faults", async () => {
		captureStdout();
		captureStderr();
		const supervise = vi.fn(async () => {
			throw new Error("boom");
		});

		const exitCode = await runDispatchStart(
			{ issue: 1, registry: registryDir, repo: "acme/widgets", agentCommand: "custom {brief} {out}", yes: true },
			targetDir,
			{ env, now: FIXED_NOW, supervise: supervise as unknown as typeof supervise, createProvider: stubIssueProvider },
		);

		expect(exitCode).toBe(DISPATCH_ATTENTION_EXIT_CODE);
		expect(exitCode).not.toBe(1);
	});

	it("returns DISPATCH_ATTENTION_EXIT_CODE (never 1) for a NEEDS_ATTENTION supervision result", async () => {
		captureStdout();
		const { fn: supervise } = fakeSupervise(
			baseResult({ state: "NEEDS_ATTENTION", resumeHint: "gatekeeper dispatch resume wo-x" }),
		);

		const exitCode = await runDispatchStart(
			{ issue: 1, registry: registryDir, repo: "acme/widgets", agentCommand: "custom {brief} {out}", yes: true },
			targetDir,
			{ env, now: FIXED_NOW, supervise: supervise as unknown as typeof supervise, createProvider: stubIssueProvider },
		);

		expect(exitCode).toBe(3);
		expect(exitCode).not.toBe(1);
	});

	// -------------------------------------------------------------------------
	// T-20260721-01: --issue is now optional, --brief-alone is an ad-hoc order
	// -------------------------------------------------------------------------

	it("[T-20260721-01] returns 2 (with a clear message) when neither --issue nor --brief is given", async () => {
		const stderr = captureStderr();
		const { fn: supervise, calls } = fakeSupervise(baseResult());

		const exitCode = await runDispatchStart({ registry: registryDir, repo: "acme/widgets", yes: true }, targetDir, {
			env,
			now: FIXED_NOW,
			supervise: supervise as unknown as typeof supervise,
		});

		expect(exitCode).toBe(2);
		expect(stderr.text()).toContain("at least one of --issue <n> or --brief <file> is required");
		expect(supervise).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
	});

	it("[T-20260721-01] --brief alone mints an org/repo@adhoc-<id> association key, makes zero GitHub calls, and wraps the brief through the delivery-contract template", async () => {
		const briefPath = path.join(targetDir, "adhoc-brief.md");
		await writeFile(briefPath, "Refactor the exporter to stream instead of buffering.\n", "utf8");
		const { fn: supervise, calls } = fakeSupervise(baseResult({ orderId: "placeholder", state: "DELIVERED" }));
		const stdout = captureStdout();

		const exitCode = await runDispatchStart(
			{
				registry: registryDir,
				repo: "acme/widgets",
				brief: briefPath,
				agentCommand: "custom-cli {brief} {out}",
				yes: true,
			},
			targetDir,
			{ env, now: FIXED_NOW, supervise: supervise as unknown as typeof supervise },
		);

		expect(exitCode).toBe(0);
		expect(calls).toHaveLength(1);
		expect(stdout.text()).toMatch(/acme\/widgets@adhoc-[a-z0-9]+ -> /);

		const orders = await import("../src/dispatch/store.js").then((mod) => mod.listOrders(env));
		expect(orders).toHaveLength(1);
		const order = orders[0];
		expect(order?.order.association_key).toMatch(/^acme\/widgets@adhoc-[a-z0-9]+$/);
		expect(order?.brief).toContain("## 任务");
		expect(order?.brief).toContain("Refactor the exporter to stream instead of buffering.");
		expect(order?.brief).not.toContain("## Issue");
		expect(order?.brief).not.toContain("## Triage 判断");
		expect(order?.brief).toContain("out/RESULT.json");

		const ledger = await readFile(path.join(targetDir, ".gatekeeper", "dispatch-ledger.jsonl"), "utf8");
		expect(JSON.parse(ledger.trim())).toMatchObject({ kind: "dispatch", outcome: "DELIVERED" });
		expect(JSON.parse(ledger.trim()).key).toMatch(/^acme\/widgets@adhoc-[a-z0-9]+$/);
	});

	it("[T-20260721-01] --issue and --brief together still use --brief verbatim (unchanged combined-mode behavior) with an org/repo#N key", async () => {
		const briefPath = path.join(targetDir, "combined-brief.md");
		await writeFile(briefPath, "Verbatim task package text.\n", "utf8");
		const { fn: supervise } = fakeSupervise(baseResult({ orderId: "placeholder", state: "DELIVERED" }));
		captureStdout();

		const exitCode = await runDispatchStart(
			{
				issue: 7,
				registry: registryDir,
				repo: "acme/widgets",
				brief: briefPath,
				agentCommand: "custom-cli {brief} {out}",
				yes: true,
			},
			targetDir,
			{ env, now: FIXED_NOW, supervise: supervise as unknown as typeof supervise },
		);

		expect(exitCode).toBe(0);
		const orders = await import("../src/dispatch/store.js").then((mod) => mod.listOrders(env));
		const order = orders[0];
		expect(order?.order.association_key).toBe("acme/widgets#7");
		expect(order?.brief).toBe("Verbatim task package text.\n");
	});
});

describe("ad-hoc dispatch orders (T-20260721-01): full lifecycle through status/resume/cancel", () => {
	let configDir: string;
	let targetDir: string;
	let registryDir: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(async () => {
		vi.spyOn(globalThis, "fetch");
		configDir = await tempDir("gatekeeper-dispatch-adhoc-config-");
		targetDir = await tempDir("gatekeeper-dispatch-adhoc-target-");
		registryDir = await tempDir("gatekeeper-dispatch-adhoc-registry-");
		env = { GATEKEEPER_CONFIG_DIR: configDir };
		await saveRepos(registryDir, [
			{ repo: "acme/widgets", path: targetDir, ci: "none", adopted_at: "2026-07-01T00:00:00.000Z" },
		]);
	});

	afterEach(() => {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("start --brief (ad-hoc) -> status shows the ad-hoc key -> resume/cancel behave normally", async () => {
		const briefPath = path.join(targetDir, "adhoc-brief.md");
		await writeFile(briefPath, "Ad-hoc task with no GitHub issue behind it.\n", "utf8");

		// 1. start: the injected supervise stub is a pure return-value stub (like every other test in this file --
		// see fakeSupervise's own doc comment), so it reports DELIVERED without itself mutating the real on-disk
		// journal. `start` still genuinely creates the ad-hoc-keyed order and its first dispatch-ledger line for
		// real -- only the *journalled* run/terminal transition is a fake stand-in for a real supervision loop
		// (already covered end to end by tests/dispatch-supervisor.test.ts).
		const startSupervise = fakeSupervise(baseResult({ orderId: "placeholder", state: "DELIVERED" }));
		const startStdout = captureStdout();
		const startExit = await runDispatchStart(
			{
				registry: registryDir,
				repo: "acme/widgets",
				brief: briefPath,
				agentCommand: "custom {brief} {out}",
				yes: true,
			},
			targetDir,
			{ env, now: FIXED_NOW, supervise: startSupervise.fn as unknown as typeof startSupervise.fn },
		);
		expect(startExit).toBe(0);
		const createdMatch = startStdout.text().match(/created order (wo-\S+)/);
		expect(createdMatch).not.toBeNull();
		const orderId = createdMatch?.[1] as string;

		const ledgerAfterStart = (await readFile(path.join(targetDir, ".gatekeeper", "dispatch-ledger.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(ledgerAfterStart).toHaveLength(1);
		expect(ledgerAfterStart[0]).toMatchObject({ kind: "dispatch", outcome: "DELIVERED" });
		expect(ledgerAfterStart[0].key).toMatch(/^acme\/widgets@adhoc-[a-z0-9]+$/);
		const adHocKey = ledgerAfterStart[0].key as string;

		// Manually advance the real on-disk journal to NEEDS_ATTENTION (same technique the resume/cancel describe
		// blocks above use) so status/resume/cancel below exercise their own real, unmocked code paths against a
		// genuinely persisted ad-hoc order -- not just a stubbed supervise() return value.
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: orderId,
				at: "2026-07-21T00:00:01.000Z",
				run_id: "r001",
				from: "PENDING",
				to: "RUNNING",
			},
			env,
		);
		await writeRunMeta(env, orderId, "r001", { outcome: "AGENT_ERROR", exitCode: 1, signal: null });
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "ATTENTION_REQUIRED",
				order_id: orderId,
				at: "2026-07-21T01:00:00.000Z",
				run_id: "r001",
				outcome: "AGENT_ERROR",
				reason: "candidate ladder exhausted",
				from: "RUNNING",
				to: "NEEDS_ATTENTION",
			},
			env,
		);

		// 2. status (list): the ad-hoc key shows up in the one-line summary, alongside its NEEDS_ATTENTION state.
		const listStdout = captureStdout();
		const listExit = await runDispatchStatus({}, targetDir, { env });
		expect(listExit).toBe(0);
		expect(listStdout.text()).toContain(orderId);
		expect(listStdout.text()).toContain(adHocKey);
		expect(listStdout.text()).toContain("NEEDS_ATTENTION");

		// 2b. status (detail): --json round-trips the ad-hoc key and the NEEDS_ATTENTION reason.
		const detailStdout = captureStdout();
		const detailExit = await runDispatchStatus({ orderId, json: true }, targetDir, { env });
		expect(detailExit).toBe(0);
		const detail = JSON.parse(detailStdout.text());
		expect(detail.associationKey).toBe(adHocKey);
		expect(detail.state).toBe("NEEDS_ATTENTION");

		// 3. resume: a rejected NEEDS_ATTENTION resume (e.g. ladder exhausted) is still reported with the real
		// ad-hoc association key threaded through to the (mocked) supervise call.
		const resumeSupervise = fakeSupervise(
			baseResult({ orderId, state: "NEEDS_ATTENTION", resumeHint: "still exhausted" }),
		);
		captureStdout();
		const resumeExit = await runDispatchResume({ orderId }, targetDir, {
			env,
			supervise: resumeSupervise.fn as unknown as typeof resumeSupervise.fn,
		});
		expect(resumeExit).toBe(DISPATCH_ATTENTION_EXIT_CODE);
		expect(resumeSupervise.calls[0]?.orderId).toBe(orderId);

		// 4. cancel: a real (unmocked) NEEDS_ATTENTION -> ABANDONED direct cancel, appending a second real
		// dispatch-ledger line keyed by the same ad-hoc key.
		captureStdout();
		const cancelExit = await runDispatchCancel({ orderId }, targetDir, { env });
		expect(cancelExit).toBe(DISPATCH_ATTENTION_EXIT_CODE);

		const ledgerAfterCancel = (await readFile(path.join(targetDir, ".gatekeeper", "dispatch-ledger.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(ledgerAfterCancel).toHaveLength(2);
		expect(ledgerAfterCancel[1]).toMatchObject({ order_id: orderId, outcome: "ABANDONED", key: adHocKey });

		const reloaded = await import("../src/dispatch/store.js").then((mod) => mod.loadOrder(orderId, env));
		expect(reloaded.state).toBe("ABANDONED");
		expect(reloaded.order.association_key).toBe(adHocKey);
	});
});

// ---------------------------------------------------------------------------
// dispatch status
// ---------------------------------------------------------------------------

describe("runDispatchStatus", () => {
	let configDir: string;
	let targetDir: string;
	let env: NodeJS.ProcessEnv;

	async function setup(): Promise<void> {
		configDir = await tempDir("gatekeeper-dispatch-status-config-");
		targetDir = await tempDir("gatekeeper-dispatch-status-target-");
		env = { GATEKEEPER_CONFIG_DIR: configDir };
	}

	it("prints 'no orders' and exits 0 for an empty store", async () => {
		await setup();
		const stdout = captureStdout();

		const exitCode = await runDispatchStatus({}, targetDir, { env });

		expect(exitCode).toBe(0);
		expect(stdout.text()).toContain("no orders");
	});

	it("--json lists an empty orders array", async () => {
		await setup();
		const stdout = captureStdout();

		const exitCode = await runDispatchStatus({ json: true }, targetDir, { env });

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.text())).toEqual({ orders: [] });
	});

	it("returns 2 for an unknown order id", async () => {
		await setup();
		const stderr = captureStderr();

		const exitCode = await runDispatchStatus({ orderId: "wo-does-not-exist" }, targetDir, { env });

		expect(exitCode).toBe(2);
		expect(stderr.text()).toContain("does not exist");
	});

	it("[R1 NB1] returns 2 (a usage error, not 3) for a malformed order id", async () => {
		await setup();
		const stderr = captureStderr();

		const exitCode = await runDispatchStatus({ orderId: "not-a-valid-order-id" }, targetDir, { env });

		expect(exitCode).toBe(2);
		expect(stderr.text()).toContain("invalid order id");
	});

	it("puts the WAITING_COOLDOWN resume time first and lists it in --json", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: orderId,
				at: "2026-07-20T00:00:01.000Z",
				run_id: "r001",
				from: "PENDING",
				to: "RUNNING",
			},
			env,
		);
		await writeRunMeta(env, orderId, "r001", { outcome: "RATE_LIMITED", exitCode: 1, signal: null });
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "COOLDOWN_STARTED",
				order_id: orderId,
				at: "2026-07-20T01:00:00.000Z",
				run_id: "r001",
				outcome: "RATE_LIMITED",
				resume_after: "2026-07-20T06:00:00.000Z",
				from: "RUNNING",
				to: "WAITING_COOLDOWN",
			},
			env,
		);

		const stdout = captureStdout();
		const exitCode = await runDispatchStatus({ orderId }, targetDir, { env });

		expect(exitCode).toBe(0);
		const text = stdout.text();
		const firstLine = text.split("\n")[0];
		expect(firstLine).toContain("WAITING_COOLDOWN");
		expect(firstLine).toContain("2026-07-20T06:00:00.000Z");

		const jsonStdout = captureStdout();
		await runDispatchStatus({ orderId, json: true }, targetDir, { env });
		const detail = JSON.parse(jsonStdout.text());
		expect(detail.resumeAfter).toBe("2026-07-20T06:00:00.000Z");
	});

	it("shows the NEEDS_ATTENTION next-command hint and reason first", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: orderId,
				at: "2026-07-20T00:00:01.000Z",
				run_id: "r001",
				from: "PENDING",
				to: "RUNNING",
			},
			env,
		);
		await writeRunMeta(env, orderId, "r001", { outcome: "AGENT_ERROR", exitCode: 1, signal: null });
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "ATTENTION_REQUIRED",
				order_id: orderId,
				at: "2026-07-20T01:00:00.000Z",
				run_id: "r001",
				outcome: "AGENT_ERROR",
				reason: "candidate ladder exhausted after AGENT_ERROR",
				from: "RUNNING",
				to: "NEEDS_ATTENTION",
			},
			env,
		);

		const stdout = captureStdout();
		const exitCode = await runDispatchStatus({ orderId }, targetDir, { env });

		expect(exitCode).toBe(0);
		const text = stdout.text();
		expect(text.split("\n")[0]).toContain("NEEDS_ATTENTION");
		expect(text).toContain("candidate ladder exhausted after AGENT_ERROR");
		expect(text).toContain(`gatekeeper dispatch resume ${orderId}`);
	});

	it("prints a REVIEWER_VENDOR_CONFLICT warning when an authoring vendor matches a preferred reviewer vendor", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await setAuthoringVendors(env, orderId, ["openai"]);

		const stderr = captureStderr();
		captureStdout();
		const exitCode = await runDispatchStatus({ orderId }, targetDir, {
			env,
			loadRolesPolicy: async () => ({
				apiVersion: "gatekeeper/v1",
				tiers: {
					reviewer: { prefer: ["openai/gpt-5.4-codex", "anthropic/claude-opus-4-8"], count: 2, crossVendor: true },
				},
			}),
		});

		expect(exitCode).toBe(0);
		expect(stderr.text()).toContain("REVIEWER_VENDOR_CONFLICT");
		expect(stderr.text()).toContain("openai");
	});

	it("lists multiple orders with state/agent/run-count summary", async () => {
		await setup();
		await makeOrder(env, targetDir, { associationKey: "acme/widgets#1" });
		await makeOrder(env, targetDir, { associationKey: "acme/widgets#2" });

		const stdout = captureStdout();
		const exitCode = await runDispatchStatus({}, targetDir, { env });

		expect(exitCode).toBe(0);
		const lines = stdout.text().trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines.join("\n")).toContain("PENDING");
	});
});

// ---------------------------------------------------------------------------
// dispatch logs
// ---------------------------------------------------------------------------

describe("runDispatchLogs", () => {
	let configDir: string;
	let targetDir: string;
	let env: NodeJS.ProcessEnv;

	async function setup(): Promise<void> {
		configDir = await tempDir("gatekeeper-dispatch-logs-config-");
		targetDir = await tempDir("gatekeeper-dispatch-logs-target-");
		env = { GATEKEEPER_CONFIG_DIR: configDir };
	}

	it("returns 2 for an unknown order id", async () => {
		await setup();
		const stderr = captureStderr();

		const exitCode = await runDispatchLogs({ orderId: "wo-nope" }, targetDir, { env });

		expect(exitCode).toBe(2);
		expect(stderr.text()).toContain("does not exist");
	});

	it("returns 2 when the order has no runs yet", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);

		const stderr = captureStderr();
		const exitCode = await runDispatchLogs({ orderId: created.order.id }, targetDir, { env });

		expect(exitCode).toBe(2);
		expect(stderr.text()).toContain("has no runs yet");
	});

	it("prints log paths and the stdout/stderr tail for the most recent run", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await writeRunMeta(env, orderId, "r001");

		const stdout = captureStdout();
		const exitCode = await runDispatchLogs({ orderId }, targetDir, { env });

		expect(exitCode).toBe(0);
		const text = stdout.text();
		expect(text).toContain(path.join(dispatchOrderDirectory(orderId, env), "runs", "r001", "stdout.log"));
		expect(text).toContain("line one");
		expect(text).toContain("warn: something");
		expect(text).toContain("--follow is not implemented");
	});

	it("honors --run to select a specific run and 404s an unknown one", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await writeRunMeta(env, orderId, "r001", { outcome: "AGENT_ERROR", exitCode: 1, signal: null });

		const stderr = captureStderr();
		const exitCode = await runDispatchLogs({ orderId, run: "r002" }, targetDir, { env });
		expect(exitCode).toBe(2);
		expect(stderr.text()).toContain("has no run r002");

		const stdout = captureStdout();
		const exitCodeOk = await runDispatchLogs({ orderId, run: "r001" }, targetDir, { env });
		expect(exitCodeOk).toBe(0);
		expect(stdout.text()).toContain("r001");
	});
});

// ---------------------------------------------------------------------------
// dispatch resume
// ---------------------------------------------------------------------------

describe("runDispatchResume", () => {
	let configDir: string;
	let targetDir: string;
	let env: NodeJS.ProcessEnv;

	async function setup(): Promise<void> {
		configDir = await tempDir("gatekeeper-dispatch-resume-config-");
		targetDir = await tempDir("gatekeeper-dispatch-resume-target-");
		env = { GATEKEEPER_CONFIG_DIR: configDir };
	}

	async function toNeedsAttention(orderId: string): Promise<void> {
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: orderId,
				at: "2026-07-20T00:00:01.000Z",
				run_id: "r001",
				from: "PENDING",
				to: "RUNNING",
			},
			env,
		);
		await writeRunMeta(env, orderId, "r001", { outcome: "AGENT_ERROR", exitCode: 1, signal: null });
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "ATTENTION_REQUIRED",
				order_id: orderId,
				at: "2026-07-20T01:00:00.000Z",
				run_id: "r001",
				outcome: "AGENT_ERROR",
				reason: "candidate ladder exhausted",
				from: "RUNNING",
				to: "NEEDS_ATTENTION",
			},
			env,
		);
	}

	async function toWaitingCooldown(orderId: string): Promise<void> {
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: orderId,
				at: "2026-07-20T00:00:01.000Z",
				run_id: "r001",
				from: "PENDING",
				to: "RUNNING",
			},
			env,
		);
		await writeRunMeta(env, orderId, "r001", { outcome: "RATE_LIMITED", exitCode: 1, signal: null });
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "COOLDOWN_STARTED",
				order_id: orderId,
				at: "2026-07-20T01:00:00.000Z",
				run_id: "r001",
				outcome: "RATE_LIMITED",
				resume_after: "2026-07-20T06:00:00.000Z",
				from: "RUNNING",
				to: "WAITING_COOLDOWN",
			},
			env,
		);
	}

	it("returns 2 for an unknown order id", async () => {
		await setup();
		captureStderr();
		const exitCode = await runDispatchResume({ orderId: "wo-nope" }, targetDir, { env });
		expect(exitCode).toBe(2);
	});

	it("resumes a NEEDS_ATTENTION order by passing resumeFromAttention (no --agent, no agentOverride)", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await toNeedsAttention(orderId);
		const { fn: supervise, calls } = fakeSupervise(baseResult({ orderId, state: "DELIVERED" }));
		captureStdout();

		const exitCode = await runDispatchResume({ orderId }, targetDir, {
			env,
			supervise: supervise as unknown as typeof supervise,
		});

		expect(exitCode).toBe(0);
		expect(supervise).toHaveBeenCalledTimes(1);
		expect(calls[0]?.resumeFromAttention).toBe(true);
		expect(calls[0]?.agentOverride).toBeUndefined();
	});

	it("[R2] a NEEDS_ATTENTION resume the supervisor rejects (e.g. total run cap exhausted) is reported via resumeHint and exits DISPATCH_ATTENTION_EXIT_CODE (never 1)", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await toNeedsAttention(orderId);
		const rejectionHint = `cannot resume ${orderId}: total run cap of 4 is already exhausted and no agent override was supplied`;
		const { fn: supervise } = fakeSupervise(
			baseResult({ orderId, state: "NEEDS_ATTENTION", resumeHint: rejectionHint }),
		);
		const stdout = captureStdout();

		const exitCode = await runDispatchResume({ orderId }, targetDir, {
			env,
			supervise: supervise as unknown as typeof supervise,
		});

		expect(exitCode).toBe(DISPATCH_ATTENTION_EXIT_CODE);
		expect(exitCode).not.toBe(1);
		expect(stdout.text()).toContain(rejectionHint);
	});

	it("--agent matching a currently-detected CLI resolves { cli, vendor, command } and passes it as agentOverride", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await toNeedsAttention(orderId);
		const { fn: supervise, calls } = fakeSupervise(baseResult({ orderId, state: "DELIVERED" }));
		captureStdout();

		const exitCode = await runDispatchResume({ orderId, agent: "grok" }, targetDir, {
			env,
			supervise: supervise as unknown as typeof supervise,
			detectAgentClis: async () => [
				{
					name: "grok",
					binary: "grok",
					vendor: "xai",
					tiers: ["coder"],
					commandTemplate: "grok --prompt-file {brief} > {out}",
					path: "/bin/grok",
					version: null,
				},
			],
		});

		expect(exitCode).toBe(0);
		expect(calls[0]?.resumeFromAttention).toBe(true);
		expect(calls[0]?.agentOverride).toEqual({
			cli: "grok",
			vendor: "xai",
			command: "grok --prompt-file {brief} > {out}",
		});
	});

	it("--agent outside the detected set falls back to .gatekeeper.yml's agent.command, tagged vendor 'custom'", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await toNeedsAttention(orderId);
		await writeFile(
			path.join(targetDir, ".gatekeeper.yml"),
			'apiVersion: gatekeeper/v1\nagent:\n  command: "mycli --run {brief} > {out}"\n',
			"utf8",
		);
		const { fn: supervise, calls } = fakeSupervise(baseResult({ orderId, state: "DELIVERED" }));
		captureStdout();

		const exitCode = await runDispatchResume({ orderId, agent: "mycli" }, targetDir, {
			env,
			supervise: supervise as unknown as typeof supervise,
			detectAgentClis: async () => [],
		});

		expect(exitCode).toBe(0);
		expect(calls[0]?.resumeFromAttention).toBe(true);
		expect(calls[0]?.agentOverride).toEqual({ cli: "mycli", vendor: "custom", command: "mycli --run {brief} > {out}" });
	});

	it("--agent that cannot be resolved at all (not detected, no BYO fallback configured) returns exit 2 without calling supervise", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await toNeedsAttention(orderId);
		const { fn: supervise } = fakeSupervise(baseResult());
		const stderr = captureStderr();

		const exitCode = await runDispatchResume({ orderId, agent: "no-such-cli" }, targetDir, {
			env,
			supervise: supervise as unknown as typeof supervise,
			detectAgentClis: async () => [],
		});

		expect(exitCode).toBe(2);
		expect(supervise).not.toHaveBeenCalled();
		expect(stderr.text()).toContain("no-such-cli");
	});

	it("--agent is ignored (with a warning) outside NEEDS_ATTENTION -- resume still proceeds normally", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await toWaitingCooldown(orderId);
		const { fn: supervise, calls } = fakeSupervise(
			baseResult({ orderId, state: "WAITING_COOLDOWN", resumeHint: "later" }),
		);
		const stderr = captureStderr();
		captureStdout();

		const exitCode = await runDispatchResume({ orderId, agent: "claude" }, targetDir, {
			env,
			supervise: supervise as unknown as typeof supervise,
		});

		expect(exitCode).toBe(DISPATCH_ATTENTION_EXIT_CODE);
		expect(stderr.text()).toContain("--agent only applies to resuming a NEEDS_ATTENTION order");
		expect(supervise).toHaveBeenCalledTimes(1);
		expect(calls[0]?.resumeFromAttention).toBeUndefined();
		expect(calls[0]?.agentOverride).toBeUndefined();
	});

	it("treats an already-DELIVERED order as a 0-exit no-op", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: orderId,
				at: "2026-07-20T00:00:01.000Z",
				run_id: "r001",
				from: "PENDING",
				to: "RUNNING",
			},
			env,
		);
		await writeRunMeta(env, orderId, "r001", { outcome: "COMPLETED", exitCode: 0, signal: null });
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "ORDER_DELIVERED",
				order_id: orderId,
				at: "2026-07-20T01:00:00.000Z",
				run_id: "r001",
				outcome: "COMPLETED",
				from: "RUNNING",
				to: "DELIVERED",
			},
			env,
		);
		const { fn: supervise } = fakeSupervise(baseResult());
		const stdout = captureStdout();

		const exitCode = await runDispatchResume({ orderId }, targetDir, {
			env,
			supervise: supervise as unknown as typeof supervise,
		});

		expect(exitCode).toBe(0);
		expect(supervise).not.toHaveBeenCalled();
		expect(stdout.text()).toContain("already terminal (DELIVERED)");
	});

	it("forwards --force as forceCooldown for a WAITING_COOLDOWN order", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await toWaitingCooldown(orderId);
		const { fn: supervise, calls } = fakeSupervise(baseResult({ orderId, state: "DELIVERED" }));
		captureStdout();

		const exitCode = await runDispatchResume({ orderId, force: true }, targetDir, {
			env,
			supervise: supervise as unknown as typeof supervise,
		});

		expect(exitCode).toBe(0);
		expect(calls[0]?.forceCooldown).toBe(true);
		expect(calls[0]?.orphanAction).toBeUndefined();
	});

	it.each([
		["wait", "wait"],
		["kill", "kill"],
		["confirmDead", "confirm-dead"],
	] as const)("forwards --%s as orphanAction %s for a RUNNING order", async (flag, expected) => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: orderId,
				at: "2026-07-20T00:00:01.000Z",
				run_id: "r001",
				from: "PENDING",
				to: "RUNNING",
			},
			env,
		);
		const { fn: supervise, calls } = fakeSupervise(baseResult({ orderId, state: "DELIVERED" }));
		captureStdout();

		const exitCode = await runDispatchResume(
			{ orderId, [flag]: true } as Parameters<typeof runDispatchResume>[0],
			targetDir,
			{
				env,
				supervise: supervise as unknown as typeof supervise,
			},
		);

		expect(exitCode).toBe(0);
		expect(calls[0]?.orphanAction).toBe(expected);
	});

	it("appends a dispatch-ledger line only when this call crosses into a terminal state", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await toWaitingCooldown(orderId);
		const { fn: supervise } = fakeSupervise(baseResult({ orderId, state: "ABANDONED" }));
		captureStdout();

		const exitCode = await runDispatchResume({ orderId }, targetDir, {
			env,
			supervise: supervise as unknown as typeof supervise,
		});

		expect(exitCode).toBe(DISPATCH_ATTENTION_EXIT_CODE);
		const ledger = await readFile(path.join(targetDir, ".gatekeeper", "dispatch-ledger.jsonl"), "utf8");
		const line = JSON.parse(ledger.trim());
		expect(line).toMatchObject({ kind: "dispatch", order_id: orderId, outcome: "ABANDONED" });
	});
});

// ---------------------------------------------------------------------------
// dispatch cancel
// ---------------------------------------------------------------------------

describe("runDispatchCancel", () => {
	let configDir: string;
	let targetDir: string;
	let env: NodeJS.ProcessEnv;

	async function setup(): Promise<void> {
		configDir = await tempDir("gatekeeper-dispatch-cancel-config-");
		targetDir = await tempDir("gatekeeper-dispatch-cancel-target-");
		env = { GATEKEEPER_CONFIG_DIR: configDir };
	}

	it("returns 2 for an unknown order id", async () => {
		await setup();
		captureStderr();
		const exitCode = await runDispatchCancel({ orderId: "wo-nope" }, targetDir, { env });
		expect(exitCode).toBe(2);
	});

	it("is a 0-exit no-op for an already-terminal order", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: orderId,
				at: "2026-07-20T00:00:01.000Z",
				run_id: "r001",
				from: "PENDING",
				to: "RUNNING",
			},
			env,
		);
		await writeRunMeta(env, orderId, "r001", { outcome: "COMPLETED", exitCode: 0, signal: null });
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "ORDER_DELIVERED",
				order_id: orderId,
				at: "2026-07-20T01:00:00.000Z",
				run_id: "r001",
				outcome: "COMPLETED",
				from: "RUNNING",
				to: "DELIVERED",
			},
			env,
		);
		const stdout = captureStdout();

		const exitCode = await runDispatchCancel({ orderId }, targetDir, { env });

		expect(exitCode).toBe(0);
		expect(stdout.text()).toContain("already terminal");
	});

	it("returns 2 for a still-PENDING order (no PENDING -> ABANDONED transition)", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const stderr = captureStderr();

		const exitCode = await runDispatchCancel({ orderId: created.order.id }, targetDir, { env });

		expect(exitCode).toBe(2);
		expect(stderr.text()).toContain("has no PENDING -> ABANDONED transition");
	});

	it("cancels a RUNNING order via orphanAction kill and appends a ledger line", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: orderId,
				at: "2026-07-20T00:00:01.000Z",
				run_id: "r001",
				from: "PENDING",
				to: "RUNNING",
			},
			env,
		);
		const { fn: supervise, calls } = fakeSupervise(baseResult({ orderId, state: "ABANDONED" }));
		captureStdout();

		const exitCode = await runDispatchCancel({ orderId }, targetDir, {
			env,
			supervise: supervise as unknown as typeof supervise,
		});

		expect(exitCode).toBe(DISPATCH_ATTENTION_EXIT_CODE);
		expect(calls[0]?.orphanAction).toBe("kill");
		const ledger = await readFile(path.join(targetDir, ".gatekeeper", "dispatch-ledger.jsonl"), "utf8");
		expect(JSON.parse(ledger.trim())).toMatchObject({ outcome: "ABANDONED" });
	});

	it("reports (without failing) when the active run had already delivered before cancel could kill it", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: orderId,
				at: "2026-07-20T00:00:01.000Z",
				run_id: "r001",
				from: "PENDING",
				to: "RUNNING",
			},
			env,
		);
		const { fn: supervise } = fakeSupervise(baseResult({ orderId, state: "DELIVERED" }));
		const stdout = captureStdout();

		const exitCode = await runDispatchCancel({ orderId }, targetDir, {
			env,
			supervise: supervise as unknown as typeof supervise,
		});

		expect(exitCode).toBe(0);
		expect(stdout.text()).toContain("was not cancelled");
	});

	it("cancels a WAITING_COOLDOWN order directly (no supervise call) and marks it ABANDONED", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: orderId,
				at: "2026-07-20T00:00:01.000Z",
				run_id: "r001",
				from: "PENDING",
				to: "RUNNING",
			},
			env,
		);
		await writeRunMeta(env, orderId, "r001", { outcome: "RATE_LIMITED", exitCode: 1, signal: null });
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "COOLDOWN_STARTED",
				order_id: orderId,
				at: "2026-07-20T01:00:00.000Z",
				run_id: "r001",
				outcome: "RATE_LIMITED",
				resume_after: "2026-07-20T06:00:00.000Z",
				from: "RUNNING",
				to: "WAITING_COOLDOWN",
			},
			env,
		);
		const supervise = vi.fn();
		const stdout = captureStdout();

		const exitCode = await runDispatchCancel({ orderId }, targetDir, {
			env,
			supervise: supervise as unknown as typeof supervise,
		});

		expect(exitCode).toBe(DISPATCH_ATTENTION_EXIT_CODE);
		expect(supervise).not.toHaveBeenCalled();
		expect(stdout.text()).toContain("-> ABANDONED");

		const reloaded = await import("../src/dispatch/store.js").then((mod) => mod.loadOrder(orderId, env));
		expect(reloaded.state).toBe("ABANDONED");

		const ledger = await readFile(path.join(targetDir, ".gatekeeper", "dispatch-ledger.jsonl"), "utf8");
		expect(JSON.parse(ledger.trim())).toMatchObject({ outcome: "ABANDONED", order_id: orderId });
	});

	it("[R1 B1 regression] never exits 1 when the direct WAITING_COOLDOWN/NEEDS_ATTENTION cancel append faults (e.g. a race with a live supervisor) -- reports and returns DISPATCH_ATTENTION_EXIT_CODE, still releases the lock", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: orderId,
				at: "2026-07-20T00:00:01.000Z",
				run_id: "r001",
				from: "PENDING",
				to: "RUNNING",
			},
			env,
		);
		await writeRunMeta(env, orderId, "r001", { outcome: "RATE_LIMITED", exitCode: 1, signal: null });
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "COOLDOWN_STARTED",
				order_id: orderId,
				at: "2026-07-20T01:00:00.000Z",
				run_id: "r001",
				outcome: "RATE_LIMITED",
				resume_after: "2026-07-20T06:00:00.000Z",
				from: "RUNNING",
				to: "WAITING_COOLDOWN",
			},
			env,
		);
		const stderr = captureStderr();
		captureStdout();
		const failingAppend = vi.fn(async () => {
			throw new Error("simulated race: journal no longer matches the state this append assumed");
		});

		let exitCode: number | undefined;
		let thrown: unknown;
		try {
			exitCode = await runDispatchCancel({ orderId }, targetDir, {
				env,
				appendJournalEvent: failingAppend as unknown as typeof appendJournalEvent,
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeUndefined();
		expect(exitCode).toBe(DISPATCH_ATTENTION_EXIT_CODE);
		expect(exitCode).not.toBe(1);
		expect(failingAppend).toHaveBeenCalledTimes(1);
		expect(stderr.text()).toContain("simulated race");

		// The lock must still have been released in `finally` despite the thrown error -- a fresh acquire (and
		// this order's still-WAITING_COOLDOWN state) both confirm no stale lock or partial state was left behind.
		const { acquireSupervisorLock: acquire } = await import("../src/dispatch/lock.js");
		const lock = await acquire(orderId, { env });
		await lock.release();
		const reloaded = await import("../src/dispatch/store.js").then((mod) => mod.loadOrder(orderId, env));
		expect(reloaded.state).toBe("WAITING_COOLDOWN");
	});

	it("cancels a NEEDS_ATTENTION order directly and marks it ABANDONED", async () => {
		await setup();
		const created = await makeOrder(env, targetDir);
		const orderId = created.order.id;
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "RUN_STARTED",
				order_id: orderId,
				at: "2026-07-20T00:00:01.000Z",
				run_id: "r001",
				from: "PENDING",
				to: "RUNNING",
			},
			env,
		);
		await writeRunMeta(env, orderId, "r001", { outcome: "AGENT_ERROR", exitCode: 1, signal: null });
		await appendJournalEvent(
			orderId,
			{
				apiVersion: "gatekeeper/v1",
				type: "ATTENTION_REQUIRED",
				order_id: orderId,
				at: "2026-07-20T01:00:00.000Z",
				run_id: "r001",
				outcome: "AGENT_ERROR",
				reason: "ladder exhausted",
				from: "RUNNING",
				to: "NEEDS_ATTENTION",
			},
			env,
		);
		captureStdout();

		const exitCode = await runDispatchCancel({ orderId }, targetDir, { env });

		expect(exitCode).toBe(DISPATCH_ATTENTION_EXIT_CODE);
		const reloaded = await import("../src/dispatch/store.js").then((mod) => mod.loadOrder(orderId, env));
		expect(reloaded.state).toBe("ABANDONED");
	});
});
