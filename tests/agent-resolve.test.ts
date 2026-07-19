import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { resolveAgentCommand } from "../src/agent/resolve.js";
import { MAX_AGENT_TIMEOUT_SECONDS } from "../src/config/discover.js";

const repoRootDir = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(repoRootDir, "src/cli.ts");
const tsxLoader = path.join(repoRootDir, "node_modules/tsx/dist/loader.mjs");

function runCli(args: string[]): { status: number; stderr: string } {
	const result = spawnSync(process.execPath, ["--import", tsxLoader, cliPath, ...args], { encoding: "utf8" });
	return { status: result.status ?? -1, stderr: result.stderr };
}

describe("resolveAgentCommand: --agent-timeout / GATEKEEPER_AGENT_TIMEOUT_SECONDS bounds", () => {
	it("accepts a cliTimeoutSeconds at or under the cap", async () => {
		const resolved = await resolveAgentCommand({
			cliCommand: "echo hi",
			cliTimeoutSeconds: MAX_AGENT_TIMEOUT_SECONDS,
			discovered: null,
			registryPath: undefined,
			role: "coder",
		});
		expect(resolved).toMatchObject({ source: "cli", timeoutSeconds: MAX_AGENT_TIMEOUT_SECONDS });
	});

	it("rejects a cliTimeoutSeconds over the cap with AgentTimeoutRangeError", async () => {
		await expect(
			resolveAgentCommand({
				cliCommand: "echo hi",
				cliTimeoutSeconds: MAX_AGENT_TIMEOUT_SECONDS + 1,
				discovered: null,
				registryPath: undefined,
				role: "coder",
			}),
		).rejects.toMatchObject({
			name: "AgentTimeoutRangeError",
			source: "cli",
			value: MAX_AGENT_TIMEOUT_SECONDS + 1,
		});
	});

	it("accepts a GATEKEEPER_AGENT_TIMEOUT_SECONDS at or under the cap", async () => {
		const resolved = await resolveAgentCommand({
			discovered: null,
			registryPath: undefined,
			role: "coder",
			env: {
				GATEKEEPER_AGENT_COMMAND: "echo hi",
				GATEKEEPER_AGENT_TIMEOUT_SECONDS: String(MAX_AGENT_TIMEOUT_SECONDS),
			},
		});
		expect(resolved).toMatchObject({ source: "env", timeoutSeconds: MAX_AGENT_TIMEOUT_SECONDS });
	});

	it("rejects a GATEKEEPER_AGENT_TIMEOUT_SECONDS over the cap with AgentTimeoutRangeError", async () => {
		await expect(
			resolveAgentCommand({
				discovered: null,
				registryPath: undefined,
				role: "coder",
				env: {
					GATEKEEPER_AGENT_COMMAND: "echo hi",
					GATEKEEPER_AGENT_TIMEOUT_SECONDS: String(MAX_AGENT_TIMEOUT_SECONDS + 1),
				},
			}),
		).rejects.toMatchObject({
			name: "AgentTimeoutRangeError",
			source: "env",
			value: MAX_AGENT_TIMEOUT_SECONDS + 1,
		});
	});

	it("a malformed (non-numeric) GATEKEEPER_AGENT_TIMEOUT_SECONDS still degrades to the default, not a throw", async () => {
		const resolved = await resolveAgentCommand({
			discovered: null,
			registryPath: undefined,
			role: "coder",
			env: { GATEKEEPER_AGENT_COMMAND: "echo hi", GATEKEEPER_AGENT_TIMEOUT_SECONDS: "not-a-number" },
		});
		expect(resolved).toMatchObject({ source: "env", timeoutSeconds: 600 });
	});
});

describe("CLI --agent-timeout validator: rejects an over-cap value at the commander layer (exit 2)", () => {
	it("triage --agent-timeout above the cap exits 2 before touching any registry/GitHub work", () => {
		const result = runCli([
			"triage",
			"--issue",
			"1",
			"--repo",
			"acme/app",
			"--run",
			"--agent-timeout",
			String(MAX_AGENT_TIMEOUT_SECONDS + 1),
		]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain(`at most ${MAX_AGENT_TIMEOUT_SECONDS} seconds`);
	});

	it("init --agent-timeout above the cap exits 2", () => {
		const result = runCli([
			"init",
			"--repos",
			".",
			"--out",
			".",
			"--run",
			"--agent-timeout",
			String(MAX_AGENT_TIMEOUT_SECONDS + 1),
		]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain(`at most ${MAX_AGENT_TIMEOUT_SECONDS} seconds`);
	});
});

describe("resolveAgentCommand: tier-3 governance/agents.yaml diagnostics on a damaged file", () => {
	let registryDir: string;

	beforeEach(async () => {
		registryDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-agent-resolve-registry-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(registryDir, { recursive: true, force: true });
	});

	it("names the file and reason on stderr (not silent) when agents.yaml fails to parse, still returns undefined", async () => {
		await writeFile(path.join(registryDir, "agents.yaml"), "not: [valid, yaml", "utf8");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const resolved = await resolveAgentCommand({ discovered: null, registryPath: registryDir, role: "coder" });

		expect(resolved).toBeUndefined();
		const stderrText = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
		expect(stderrText).toContain(path.join(registryDir, "agents.yaml"));
		expect(stderrText).toContain("failed to parse");
	});

	it("returns undefined silently (no stderr) when governance/agents.yaml simply does not exist", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const resolved = await resolveAgentCommand({ discovered: null, registryPath: registryDir, role: "coder" });

		expect(resolved).toBeUndefined();
		expect(stderr).not.toHaveBeenCalled();
	});

	it("resolves the matching role's assignment when governance/agents.yaml is well-formed", async () => {
		const content = stringify({
			apiVersion: "gatekeeper/v1",
			assignments: [
				{ role: "coder", cli: "codex", vendor: "openai", command_template: "codex {brief} {out}", rationale: "r" },
			],
			detected: [],
			warnings: [],
		});
		await writeFile(path.join(registryDir, "agents.yaml"), content, "utf8");

		const resolved = await resolveAgentCommand({ discovered: null, registryPath: registryDir, role: "coder" });

		expect(resolved).toMatchObject({
			source: "agents.yaml",
			command: "codex {brief} {out}",
			description: "using agent from governance/agents.yaml (coder: codex)",
		});
	});
});
