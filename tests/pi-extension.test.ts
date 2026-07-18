import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type {
	CommandDefinition,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionToolContext,
	GatekeeperCheckParams,
	ToolDefinition,
	ToolResult,
} from "../pi-extension/index.js";
import gatekeeperExtension, { runGatekeeperCheck } from "../pi-extension/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const fixturePath = path.join(repoRoot, "fixtures/cases/ci-image-tag-matched.yaml");
const fixture = parseYaml(readFileSync(fixturePath, "utf8"), { strict: true, uniqueKeys: true }) as {
	registry: { policy: unknown; contracts: unknown[] };
};

const WORKFLOW_V1 = `name: release
jobs:
  build:
    steps:
      - run: echo build
      - name: deploy
        run: |
          image: ghcr.io/org/app:v1
`;
const WORKFLOW_V2 = WORKFLOW_V1.replace("v1", "v2");

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

/**
 * Minimal host context stubs. Real ExtensionContext has many required fields
 * (sessionManager, modelRegistry, …); unit tests only exercise cwd + ui.notify.
 */
function toolCtx(cwd: string): ExtensionToolContext {
	return { cwd } as ExtensionToolContext;
}

function commandCtx(ui: { notify: ReturnType<typeof vi.fn> }, cwd = process.cwd()): ExtensionCommandContext {
	return { cwd, ui } as unknown as ExtensionCommandContext;
}

function createMockApi(): {
	api: ExtensionAPI;
	tools: ToolDefinition[];
	commands: Map<string, CommandDefinition>;
	registerTool: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
} {
	const tools: ToolDefinition[] = [];
	const commands = new Map<string, CommandDefinition>();
	const registerTool = vi.fn((definition: ToolDefinition) => {
		tools.push(definition);
	});
	const registerCommand = vi.fn((name: string, options: CommandDefinition) => {
		commands.set(name, options);
	});
	const api = {
		registerTool,
		registerCommand,
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	return { api, tools, commands, registerTool, registerCommand };
}

describe("pi-extension registration", () => {
	it("registers gatekeeper_check tool and init/triage commands", () => {
		const { api, registerTool, registerCommand, tools, commands } = createMockApi();

		gatekeeperExtension(api);

		expect(registerTool).toHaveBeenCalledTimes(1);
		expect(tools[0]?.name).toBe("gatekeeper_check");
		expect(tools[0]?.label).toBe("Gatekeeper Check");
		expect(tools[0]?.parameters).toMatchObject({
			type: "object",
			required: ["registryDir"],
		});

		expect(registerCommand).toHaveBeenCalledTimes(2);
		const commandNames = registerCommand.mock.calls.map((call) => call[0] as string).sort();
		expect(commandNames).toEqual(["gatekeeper-init", "gatekeeper-triage"]);
		expect(commands.get("gatekeeper-init")?.description).toMatch(/init|contracts/i);
		expect(commands.get("gatekeeper-triage")?.description).toMatch(/triage|deep-reasoner/i);
	});

	it("gatekeeper-init notifies clearly when the brief file is missing", async () => {
		const { api, commands } = createMockApi();
		gatekeeperExtension(api);

		const notify = vi.fn();
		const handler = commands.get("gatekeeper-init")?.handler;
		expect(handler).toBeTypeOf("function");

		await handler?.("/nonexistent/path/brief-missing.md", commandCtx({ notify }));

		expect(notify).toHaveBeenCalled();
		const message = String(notify.mock.calls[0]?.[0] ?? "");
		expect(message).toMatch(/could not read brief file/i);
		expect(notify.mock.calls[0]?.[1]).toBe("error");
	});
});

describe("pi-extension gatekeeper_check execute", () => {
	let tmpBase: string;
	let registryDir: string;
	let repoDir: string;

	beforeAll(() => {
		tmpBase = mkdtempSync(path.join(tmpdir(), "gatekeeper-pi-ext-"));

		registryDir = path.join(tmpBase, "registry");
		mkdirSync(path.join(registryDir, "contracts"), { recursive: true });
		writeFileSync(path.join(registryDir, "policy.yaml"), stringifyYaml(fixture.registry.policy));
		writeFileSync(
			path.join(registryDir, "contracts", "ci-image-tag.yaml"),
			stringifyYaml(fixture.registry.contracts[0]),
		);

		repoDir = path.join(tmpBase, "repo");
		mkdirSync(path.join(repoDir, ".github/workflows"), { recursive: true });
		git(repoDir, ["init", "-q"]);
		git(repoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
		git(repoDir, ["config", "user.email", "pi-ext@example.com"]);
		git(repoDir, ["config", "user.name", "Pi Ext Bot"]);
		git(repoDir, ["remote", "add", "origin", "git@github.com:org/app.git"]);

		writeFileSync(path.join(repoDir, ".github/workflows/release.yml"), WORKFLOW_V1);
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-q", "-m", "init"]);
	});

	afterAll(() => {
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("runGatekeeperCheck blocks ci-image-tag authority hit", async () => {
		git(repoDir, ["checkout", "-q", "-b", "feature-image-tag"]);
		writeFileSync(path.join(repoDir, ".github/workflows/release.yml"), WORKFLOW_V2);
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-q", "-m", "bump image tag"]);

		const { verdict, text } = await runGatekeeperCheck({ registryDir, base: "main" }, repoDir);

		expect(verdict.decision).toBe("block");
		expect(verdict.repo).toBe("org/app");
		expect(verdict.touched.map((hit) => hit.contract)).toEqual(["ci-image-tag"]);
		expect(text).toContain("ci-image-tag");
		expect(text).toMatch(/GATEKEEPER BLOCK/i);

		git(repoDir, ["checkout", "-q", "main"]);
		git(repoDir, ["branch", "-q", "-D", "feature-image-tag"]);
	});

	it("registered tool execute returns content + details verdict", async () => {
		const { api, tools } = createMockApi();
		gatekeeperExtension(api);
		const tool = tools.find((entry) => entry.name === "gatekeeper_check");
		expect(tool).toBeDefined();

		git(repoDir, ["checkout", "-q", "-b", "feature-tool-execute"]);
		writeFileSync(path.join(repoDir, ".github/workflows/release.yml"), WORKFLOW_V2);
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-q", "-m", "bump image tag for tool"]);

		if (!tool) {
			throw new Error("expected gatekeeper_check tool to be registered");
		}

		const params: GatekeeperCheckParams = { registryDir, base: "main" };
		const result: ToolResult = await tool.execute("call-1", params, undefined, undefined, toolCtx(repoDir));

		const first = result.content[0];
		expect(first?.type).toBe("text");
		if (first?.type !== "text") {
			throw new Error("expected text content block");
		}
		expect(first.text).toContain("ci-image-tag");

		const details = result.details as {
			decision: string;
			touched: { contract: string }[];
		};
		expect(details.decision).toBe("block");
		expect(details.touched.map((hit) => hit.contract)).toEqual(["ci-image-tag"]);

		git(repoDir, ["checkout", "-q", "main"]);
		git(repoDir, ["branch", "-q", "-D", "feature-tool-execute"]);
	});

	it("tool execute rejects with GATEKEEPER CHECK FAILED on missing registry", async () => {
		const { api, tools } = createMockApi();
		gatekeeperExtension(api);
		const tool = tools.find((entry) => entry.name === "gatekeeper_check");
		if (!tool) {
			throw new Error("expected gatekeeper_check tool to be registered");
		}

		await expect(
			tool.execute(
				"call-err",
				{ registryDir: path.join(tmpBase, "no-such-registry") },
				undefined,
				undefined,
				toolCtx(repoDir),
			),
		).rejects.toThrow(/GATEKEEPER CHECK FAILED/i);
	});

	it("loads preset-only registry (lanes: {} + lanes.d refs) without parse failure", async () => {
		const presetRegistryDir = path.join(tmpBase, "preset-only-registry");
		mkdirSync(path.join(presetRegistryDir, "contracts"), { recursive: true });
		// lanes: {} with require.lanes referencing lanes.d presets (coderabbit, human).
		// CLI check/gate use loadRegistryWithLanePresets; pi extension must match.
		writeFileSync(
			path.join(presetRegistryDir, "policy.yaml"),
			`apiVersion: gatekeeper/v1
lanes: {}
levels:
  strict:
    enforcement: block
    require:
      m: 1
      lanes: [coderabbit, human]
`,
		);
		writeFileSync(
			path.join(presetRegistryDir, "contracts", "example.yaml"),
			`apiVersion: gatekeeper/v1
name: example
level: strict
authority:
  repo: org/app
  paths:
    - .github/workflows/**
`,
		);

		git(repoDir, ["checkout", "-q", "-b", "feature-preset-only"]);
		writeFileSync(path.join(repoDir, ".github/workflows/release.yml"), WORKFLOW_V2);
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-q", "-m", "touch workflow for preset registry"]);

		const { verdict, text } = await runGatekeeperCheck({ registryDir: presetRegistryDir, base: "main" }, repoDir);

		expect(verdict.decision).toBeDefined();
		expect(["pass", "block", "advisory"]).toContain(verdict.decision);
		expect(text.length).toBeGreaterThan(0);
		expect(text).not.toMatch(/GATEKEEPER CHECK FAILED/i);

		const { api, tools } = createMockApi();
		gatekeeperExtension(api);
		const tool = tools.find((entry) => entry.name === "gatekeeper_check");
		if (!tool) {
			throw new Error("expected gatekeeper_check tool to be registered");
		}
		const toolResult = await tool.execute(
			"call-preset",
			{ registryDir: presetRegistryDir, base: "main" },
			undefined,
			undefined,
			toolCtx(repoDir),
		);
		expect(toolResult.content[0]?.type).toBe("text");
		expect(toolResult.details).toBeDefined();

		git(repoDir, ["checkout", "-q", "main"]);
		git(repoDir, ["branch", "-q", "-D", "feature-preset-only"]);
	});

	it("tool execute rejects with parse failure reason on bad YAML", async () => {
		const badRegistryDir = path.join(tmpBase, "bad-yaml-registry");
		mkdirSync(path.join(badRegistryDir, "contracts"), { recursive: true });
		writeFileSync(path.join(badRegistryDir, "policy.yaml"), "apiVersion: gatekeeper/v1\nlanes: [\n  broken");
		writeFileSync(
			path.join(badRegistryDir, "contracts", "x.yaml"),
			`apiVersion: gatekeeper/v1
name: x
level: strict
authority: { repo: org/app, paths: [src/**] }
`,
		);

		const { api, tools } = createMockApi();
		gatekeeperExtension(api);
		const tool = tools.find((entry) => entry.name === "gatekeeper_check");
		if (!tool) {
			throw new Error("expected gatekeeper_check tool to be registered");
		}

		await expect(
			tool.execute("call-bad-yaml", { registryDir: badRegistryDir }, undefined, undefined, toolCtx(repoDir)),
		).rejects.toThrow(/GATEKEEPER CHECK FAILED/i);

		try {
			await tool.execute("call-bad-yaml-2", { registryDir: badRegistryDir }, undefined, undefined, toolCtx(repoDir));
			expect.fail("expected execute to throw");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toMatch(/GATEKEEPER CHECK FAILED/i);
			// RegistryParseError / YAML issues surface file path or expected/got hints.
			expect(message).toMatch(/policy\.yaml|expected|parse|YAML|Map|sequence|Invalid|got /i);
		}
	});

	it("tool execute rejects with git-related reason on non-git cwd", async () => {
		const notGitDir = path.join(tmpBase, "not-a-git-repo");
		mkdirSync(notGitDir, { recursive: true });

		const { api, tools } = createMockApi();
		gatekeeperExtension(api);
		const tool = tools.find((entry) => entry.name === "gatekeeper_check");
		if (!tool) {
			throw new Error("expected gatekeeper_check tool to be registered");
		}

		await expect(
			tool.execute("call-not-git", { registryDir }, undefined, undefined, toolCtx(notGitDir)),
		).rejects.toThrow(/GATEKEEPER CHECK FAILED/i);

		try {
			await tool.execute("call-not-git-2", { registryDir }, undefined, undefined, toolCtx(notGitDir));
			expect.fail("expected execute to throw");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toMatch(/GATEKEEPER CHECK FAILED/i);
			// GitDiffError from resolveRepo / git commands on non-repo cwd.
			expect(message).toMatch(/not a git repository|git remote|repo identity|git /i);
		}
	});
});
