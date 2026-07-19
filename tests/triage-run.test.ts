import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { runAgentCommand } from "../src/agent/runner.js";
import { runTriage, type TriageDependencies, type TriageOptions } from "../src/commands/triage.js";

// process.execPath is the real node binary running this test -- every "agent" fixture
// below is a small `node -e` one-liner, never a real network call or coding-agent CLI.
const NODE = process.execPath;

const POLICY_YAML = `apiVersion: gatekeeper/v1
lanes: {}
levels:
  notify:
    enforcement: warn
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

function githubIssue() {
	return {
		number: 42,
		title: "Add a region field to checkout",
		body: "We need acme/billing-service to consume it.",
		user: { login: "octocat" },
		labels: [],
		html_url: "https://github.com/acme/checkout-service/issues/42",
	};
}

function providerStub() {
	const getIssue = vi.fn(async () => githubIssue());
	const createIssueComment = vi.fn(async (_issueNumber: number, body: string) => ({
		id: 1,
		body,
		created_at: "2026-07-18T12:00:00Z",
		updated_at: "2026-07-18T12:00:00Z",
		user: null,
	}));
	const addIssueLabels = vi.fn(async (_issueNumber: number, labels: string[]) => labels.map((name) => ({ name })));
	const removeIssueLabel = vi.fn(async (_issueNumber: number, _label: string) => undefined);
	return { getIssue, createIssueComment, addIssueLabels, removeIssueLabel };
}

async function writeAgentConfig(cwd: string, command: string, timeoutSeconds?: number): Promise<void> {
	const lines = ["apiVersion: gatekeeper/v1", "agent:", `  command: ${JSON.stringify(command)}`];
	if (timeoutSeconds !== undefined) {
		lines.push(`  timeout_seconds: ${timeoutSeconds}`);
	}
	await writeFile(path.join(cwd, ".gatekeeper.yml"), `${lines.join("\n")}\n`, "utf8");
}

/** A fake agent (placeholder mode: `{brief} {out}`) that reads the brief and writes a canned, valid verdict. */
function validVerdictCommand(): string {
	const script =
		"const fs=require('fs');" +
		"const brief=fs.readFileSync(process.argv[1],'utf8');" +
		"fs.writeFileSync(process.argv[2], JSON.stringify({" +
		"decision:'accepted'," +
		"reason_summary:(brief.includes('shared-api-schema')?'aligns with shared-api-schema':'no match')+'\\nsecond line'," +
		"suggested_level:'notify'," +
		"dispatch:{coder:'openai/gpt-5.4-codex',reviewers:['anthropic/claude-opus-4-8','xai/grok-5-code']}" +
		"}));";
	return `${JSON.stringify(NODE)} -e ${JSON.stringify(script)} {brief} {out}`;
}

function malformedVerdictCommand(): string {
	const script = "const fs=require('fs');fs.writeFileSync(process.argv[2], JSON.stringify({decision:'maybe'}));";
	return `${JSON.stringify(NODE)} -e ${JSON.stringify(script)} {brief} {out}`;
}

function nonZeroExitCommand(): string {
	const script = "process.stderr.write('agent blew up\\n');process.exit(1);";
	return `${JSON.stringify(NODE)} -e ${JSON.stringify(script)} {brief} {out}`;
}

function sleepForeverCommand(): string {
	const script = "setTimeout(()=>{}, 60000);";
	return `${JSON.stringify(NODE)} -e ${JSON.stringify(script)} {brief} {out}`;
}

/** Writes a governance/agents.yaml sibling of `registryDir` (candidate 1 in locateAgentsFile -- registry IS the located directory here) with a single deep-reasoner assignment. */
async function writeAgentsYaml(registryDir: string, deepReasonerCommand: string): Promise<void> {
	const content = stringify({
		apiVersion: "gatekeeper/v1",
		assignments: [
			{
				role: "deep-reasoner",
				cli: "test-cli",
				vendor: "test-vendor",
				command_template: deepReasonerCommand,
				rationale: "test fixture",
			},
		],
		detected: [],
		warnings: [],
	});
	await writeFile(path.join(registryDir, "agents.yaml"), content, "utf8");
}

describe("triage --run", () => {
	let registryDir: string;
	let cwd: string;

	beforeEach(async () => {
		vi.spyOn(globalThis, "fetch");
		registryDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-triage-run-registry-"));
		await writeFile(path.join(registryDir, "policy.yaml"), POLICY_YAML, "utf8");
		await mkdir(path.join(registryDir, "contracts"), { recursive: true });
		await writeFile(path.join(registryDir, "contracts", "api.yaml"), CONTRACT_YAML, "utf8");
		cwd = await mkdtemp(path.join(tmpdir(), "gatekeeper-triage-run-cwd-"));
	});

	afterEach(async () => {
		expect(globalThis.fetch).not.toHaveBeenCalled();
		vi.restoreAllMocks();
		await rm(registryDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	});

	function baseOptions(overrides: Partial<TriageOptions> = {}): TriageOptions {
		return { issue: 42, repo: "acme/checkout-service", registry: registryDir, run: true, ...overrides };
	}

	function baseDependencies(
		stub: ReturnType<typeof providerStub>,
		overrides: TriageDependencies = {},
	): TriageDependencies {
		return {
			createProvider: () => stub,
			piConfigDir: path.join(cwd, "no-such-pi-config"),
			isInteractive: false,
			...overrides,
		};
	}

	it("--run and --verdict-file are mutually exclusive (exit 2, before any config/registry work)", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const stub = providerStub();

		const exitCode = await runTriage(baseOptions({ verdictFile: "verdict.json" }), cwd, baseDependencies(stub));

		expect(exitCode).toBe(2);
		expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("mutually exclusive");
		expect(stub.getIssue).not.toHaveBeenCalled();
	});

	it("--run and --post are mutually exclusive (exit 2)", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const stub = providerStub();

		const exitCode = await runTriage(baseOptions({ post: true }), cwd, baseDependencies(stub));

		expect(exitCode).toBe(2);
		expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("do not combine it with --post");
	});

	it("exits 2 with a configuration example when .gatekeeper.yml has no agent: block", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const stub = providerStub();

		const exitCode = await runTriage(baseOptions({ yes: true }), cwd, baseDependencies(stub));

		expect(exitCode).toBe(2);
		const stderrText = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(stderrText).toContain('no "agent:" block configured');
		expect(stderrText).toContain("agent:");
		expect(stderrText).toContain("command:");
		expect(stub.getIssue).not.toHaveBeenCalled();
	});

	it("--yes skips confirmation and posts the agent's verdict through the same --post pipeline", async () => {
		await writeAgentConfig(cwd, validVerdictCommand());
		const stub = providerStub();
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const exitCode = await runTriage(baseOptions({ yes: true }), cwd, baseDependencies(stub));

		expect(exitCode).toBe(0);
		expect(stub.createIssueComment).toHaveBeenCalledTimes(1);
		expect(stub.addIssueLabels).toHaveBeenCalledWith(42, ["gatekeeper:accepted"]);

		const ledgerPath = path.join(cwd, ".gatekeeper", "triage-ledger.jsonl");
		const ledgerContent = await readFile(ledgerPath, "utf8");
		expect(JSON.parse(ledgerContent.trim())).toMatchObject({
			decision: "accepted",
			suggested_level: "notify",
			dispatch: { coder: "openai/gpt-5.4-codex", reviewers: ["anthropic/claude-opus-4-8", "xai/grok-5-code"] },
		});

		const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(output).toContain("decision: accepted");
		expect(output).toContain("reason: aligns with shared-api-schema"); // first line only, no "second line"
		expect(output).not.toContain("second line");
		expect(output).toContain(
			"dispatch: coder=openai/gpt-5.4-codex reviewers=anthropic/claude-opus-4-8, xai/grok-5-code",
		);
	});

	it("cleans up the temp run directory by default", async () => {
		await writeAgentConfig(cwd, validVerdictCommand());
		const stub = providerStub();
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		let capturedRunDir: string | undefined;
		const runAgent = vi.fn(async (runOptions: Parameters<typeof runAgentCommand>[0]) => {
			capturedRunDir = path.dirname(runOptions.briefPath);
			return runAgentCommand(runOptions);
		});

		await runTriage(baseOptions({ yes: true }), cwd, baseDependencies(stub, { runAgent }));

		expect(capturedRunDir).toBeDefined();
		await expect(readFile(path.join(capturedRunDir as string, "brief.md"), "utf8")).rejects.toThrow();
	});

	it("--keep-artifacts keeps the temp run directory and prints its path", async () => {
		await writeAgentConfig(cwd, validVerdictCommand());
		const stub = providerStub();
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const exitCode = await runTriage(baseOptions({ yes: true, keepArtifacts: true }), cwd, baseDependencies(stub));

		expect(exitCode).toBe(0);
		const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
		const match = output.match(/kept run artifacts at (\S+)/);
		expect(match).not.toBeNull();
		const runDir = (match as RegExpMatchArray)[1] as string;
		expect(await readFile(path.join(runDir, "brief.md"), "utf8")).toContain("shared-api-schema");
		expect(await readFile(path.join(runDir, "verdict.json"), "utf8")).toContain('"decision":"accepted"');
		await rm(runDir, { recursive: true, force: true });
	});

	it("a non-zero agent exit fails loud (exit 1) and never posts", async () => {
		await writeAgentConfig(cwd, nonZeroExitCommand());
		const stub = providerStub();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const exitCode = await runTriage(baseOptions({ yes: true }), cwd, baseDependencies(stub));

		expect(exitCode).toBe(1);
		const stderrText = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(stderrText).toContain("agent command exited with code 1");
		expect(stderrText).toContain("agent blew up");
		expect(stub.createIssueComment).not.toHaveBeenCalled();
	});

	it("an agent that exceeds its configured timeout fails loud (exit 1) and never posts", async () => {
		await writeAgentConfig(cwd, sleepForeverCommand(), 1);
		const stub = providerStub();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const exitCode = await runTriage(baseOptions({ yes: true }), cwd, baseDependencies(stub));

		expect(exitCode).toBe(1);
		expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("exceeded 1s timeout");
		expect(stub.createIssueComment).not.toHaveBeenCalled();
	}, 10_000);

	it("a structurally invalid agent verdict fails the same hard validation as --post (exit 2), never posts", async () => {
		await writeAgentConfig(cwd, malformedVerdictCommand());
		const stub = providerStub();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const exitCode = await runTriage(baseOptions({ yes: true }), cwd, baseDependencies(stub));

		expect(exitCode).toBe(2);
		expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("$.decision");
		expect(stub.createIssueComment).not.toHaveBeenCalled();
	});

	it("without --yes, a non-interactive context (isInteractive: false) exits 2 instead of hanging", async () => {
		await writeAgentConfig(cwd, validVerdictCommand());
		const stub = providerStub();
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const exitCode = await runTriage(baseOptions(), cwd, baseDependencies(stub));

		expect(exitCode).toBe(2);
		expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("not an interactive TTY");
		expect(stub.createIssueComment).not.toHaveBeenCalled();
	});

	it("in an interactive context, prompts for confirmation and posts only when confirmed", async () => {
		await writeAgentConfig(cwd, validVerdictCommand());
		const stub = providerStub();
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const promptConfirm = vi.fn(async (message: string) => {
			expect(message).toContain("Post this verdict?");
			return true;
		});

		const exitCode = await runTriage(
			baseOptions(),
			cwd,
			baseDependencies(stub, { isInteractive: true, promptConfirm }),
		);

		expect(exitCode).toBe(0);
		expect(promptConfirm).toHaveBeenCalledTimes(1);
		expect(stub.createIssueComment).toHaveBeenCalledTimes(1);
	});

	it("aborts without posting when the interactive confirmation is declined", async () => {
		await writeAgentConfig(cwd, validVerdictCommand());
		const stub = providerStub();
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const promptConfirm = vi.fn(async () => false);

		const exitCode = await runTriage(
			baseOptions(),
			cwd,
			baseDependencies(stub, { isInteractive: true, promptConfirm }),
		);

		expect(exitCode).toBe(0);
		expect(stub.createIssueComment).not.toHaveBeenCalled();
		const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(output).toContain("aborted (not confirmed)");
	});
});

describe("triage --run: three-tier agent command resolution chain", () => {
	let registryDir: string;
	let cwd: string;

	beforeEach(async () => {
		vi.spyOn(globalThis, "fetch");
		registryDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-triage-run-resolve-registry-"));
		await writeFile(path.join(registryDir, "policy.yaml"), POLICY_YAML, "utf8");
		await mkdir(path.join(registryDir, "contracts"), { recursive: true });
		await writeFile(path.join(registryDir, "contracts", "api.yaml"), CONTRACT_YAML, "utf8");
		cwd = await mkdtemp(path.join(tmpdir(), "gatekeeper-triage-run-resolve-cwd-"));
	});

	afterEach(async () => {
		expect(globalThis.fetch).not.toHaveBeenCalled();
		vi.restoreAllMocks();
		await rm(registryDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	});

	function baseOptions(overrides: Partial<TriageOptions> = {}): TriageOptions {
		return { issue: 42, repo: "acme/checkout-service", registry: registryDir, run: true, yes: true, ...overrides };
	}

	function baseDependencies(
		stub: ReturnType<typeof providerStub>,
		overrides: TriageDependencies = {},
	): TriageDependencies {
		return {
			createProvider: () => stub,
			piConfigDir: path.join(cwd, "no-such-pi-config"),
			isInteractive: false,
			...overrides,
		};
	}

	it("tier 3: falls back to governance/agents.yaml's deep-reasoner assignment when no .gatekeeper.yml agent: block exists", async () => {
		await writeAgentsYaml(registryDir, validVerdictCommand());
		const stub = providerStub();
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const exitCode = await runTriage(baseOptions(), cwd, baseDependencies(stub));

		expect(exitCode).toBe(0);
		expect(stub.createIssueComment).toHaveBeenCalledTimes(1);
		const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(output).toContain("using agent from governance/agents.yaml (deep-reasoner: test-cli)");
	});

	it("tier 2 (.gatekeeper.yml agent.command) wins over tier 3 (governance/agents.yaml) when both are present", async () => {
		await writeAgentsYaml(registryDir, nonZeroExitCommand()); // would fail loud if this were the one actually run
		await writeAgentConfig(cwd, validVerdictCommand());
		const stub = providerStub();
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const exitCode = await runTriage(baseOptions(), cwd, baseDependencies(stub));

		expect(exitCode).toBe(0);
		const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(output).toContain("using agent from .gatekeeper.yml (agent.command)");
	});

	it("tier 1 (--agent-command) wins over tier 2 (.gatekeeper.yml) and tier 3 (governance/agents.yaml)", async () => {
		await writeAgentsYaml(registryDir, nonZeroExitCommand());
		await writeAgentConfig(cwd, nonZeroExitCommand());
		const stub = providerStub();
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const exitCode = await runTriage(baseOptions({ agentCommand: validVerdictCommand() }), cwd, baseDependencies(stub));

		expect(exitCode).toBe(0);
		const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(output).toContain("using agent from --agent-command");
	});

	it("GATEKEEPER_AGENT_COMMAND env var resolves (tier 1) ahead of .gatekeeper.yml/agents.yaml", async () => {
		await writeAgentsYaml(registryDir, nonZeroExitCommand());
		const stub = providerStub();
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const exitCode = await runTriage(
			baseOptions(),
			cwd,
			baseDependencies(stub, { env: { ...process.env, GATEKEEPER_AGENT_COMMAND: validVerdictCommand() } }),
		);

		expect(exitCode).toBe(0);
		const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(output).toContain("using agent from GATEKEEPER_AGENT_COMMAND");
	});

	it("a governance/agents.yaml with no deep-reasoner assignment falls through to the existing missingAgentMessage error", async () => {
		const content = stringify({
			apiVersion: "gatekeeper/v1",
			assignments: [{ role: "coder", cli: "x", vendor: "y", command_template: "echo hi", rationale: "r" }],
			detected: [],
			warnings: [],
		});
		await writeFile(path.join(registryDir, "agents.yaml"), content, "utf8");
		const stub = providerStub();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const exitCode = await runTriage(baseOptions(), cwd, baseDependencies(stub));

		expect(exitCode).toBe(2);
		expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain('no "agent:" block configured');
	});

	it("a malformed governance/agents.yaml still falls through to missingAgentMessage (exit 2, not a crash), but names the file/reason on stderr first", async () => {
		const agentsPath = path.join(registryDir, "agents.yaml");
		await writeFile(agentsPath, "not: [valid, agents, file", "utf8");
		const stub = providerStub();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const exitCode = await runTriage(baseOptions(), cwd, baseDependencies(stub));

		expect(exitCode).toBe(2);
		const stderrText = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
		// Not a silent skip: the diagnostic names the broken file before falling through.
		expect(stderrText).toContain(agentsPath);
		expect(stderrText).toContain("failed to parse");
		expect(stderrText).toContain('no "agent:" block configured');
	});
});
