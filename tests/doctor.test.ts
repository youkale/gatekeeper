import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentsFileReadError } from "../src/agent/agentsFile.js";
import type { DetectedAgentCli } from "../src/agent/detect.js";
import { agentsCapabilityCheck, rolesPolicyCapabilityCheck, runDoctor } from "../src/commands/doctor.js";

describe("doctor fail direction and required checks", () => {
	let registryDirectory: string;

	beforeAll(async () => {
		registryDirectory = await mkdtemp(path.join(tmpdir(), "gatekeeper-doctor-"));
		await writeFile(
			path.join(registryDirectory, "policy.yaml"),
			`apiVersion: gatekeeper/v1
lanes: {}
levels:
  notify:
    enforcement: warn
    require: {}
`,
			"utf8",
		);
	});

	afterAll(async () => {
		await rm(registryDirectory, { recursive: true, force: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fails open when the workflow path is missing", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const createProvider = vi.fn(() => {
			throw new Error("provider must not be called after workflow IO failure");
		});

		const exitCode = await runDoctor(
			{
				registry: registryDirectory,
				repo: "acme/app",
				workflow: path.join(registryDirectory, "missing-workflow.yml"),
			},
			registryDirectory,
			{ createProvider },
		);

		expect(exitCode).toBe(0);
		expect(createProvider).not.toHaveBeenCalled();
		expect(stderr.mock.calls.map(([message]) => String(message)).join("\n")).toContain("无法校验 workflow");
	});

	it("returns one when a workflow contains an unresolved YAML alias", async () => {
		const workflow = path.join(registryDirectory, "invalid-alias.yml");
		await writeFile(
			workflow,
			`name: gatekeeper
jobs:
  gate: *missing
`,
			"utf8",
		);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const createProvider = vi.fn(() => {
			throw new Error("provider must not be called after workflow config failure");
		});

		const exitCode = await runDoctor({ registry: registryDirectory, repo: "acme/app", workflow }, registryDirectory, {
			createProvider,
		});

		expect(exitCode).toBe(1);
		expect(createProvider).not.toHaveBeenCalled();
		const output = stderr.mock.calls.map(([message]) => String(message)).join("\n");
		expect(output).toContain("invalid workflow YAML");
		expect(output).toContain("Unresolved alias");
	});

	it("reports an error when a required-check-producing job listens on pull_request (a PR could forge/spoof the required check)", async () => {
		const workflowDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-doctor-trigger-lint-"));
		try {
			await writeFile(
				path.join(workflowDir, "bad-gate.yml"),
				`name: bad-gate
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  gate:
    name: gatekeeper-gate
    runs-on: ubuntu-latest
    steps:
      - uses: acme/gatekeeper@v1
        with:
          mode: gate
`,
				"utf8",
			);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			const exitCode = await runDoctor(
				{ registry: registryDirectory, repo: "acme/app", workflow: workflowDir },
				registryDirectory,
				{
					createProvider: () => ({
						getBranchProtectionRequiredChecks: async () => ({
							available: true,
							contexts: ["gatekeeper-gate"],
							checks: [],
						}),
					}),
				},
			);

			expect(exitCode).toBe(1);
			const output = stderr.mock.calls.map(([message]) => String(message)).join("\n");
			expect(output).toContain("bad-gate.yml");
			expect(output).toContain("pull_request");
			expect(output).toContain("受信 ref");
		} finally {
			await rm(workflowDir, { recursive: true, force: true });
		}
	});

	it("reports an error when a required-check-producing job omits `with.mode` (mode defaults to gate in action.yml, so the step still runs as a gate)", async () => {
		const workflowDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-doctor-trigger-lint-default-mode-"));
		try {
			await writeFile(
				path.join(workflowDir, "bad-gate-default-mode.yml"),
				`name: bad-gate-default-mode
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  gate:
    name: gatekeeper-gate
    runs-on: ubuntu-latest
    steps:
      - uses: ./
`,
				"utf8",
			);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			const exitCode = await runDoctor(
				{ registry: registryDirectory, repo: "acme/app", workflow: workflowDir },
				registryDirectory,
				{
					createProvider: () => ({
						getBranchProtectionRequiredChecks: async () => ({
							available: true,
							contexts: ["gatekeeper-gate"],
							checks: [],
						}),
					}),
				},
			);

			expect(exitCode).toBe(1);
			const output = stderr.mock.calls.map(([message]) => String(message)).join("\n");
			expect(output).toContain("bad-gate-default-mode.yml");
			expect(output).toContain("pull_request");
			expect(output).toContain("受信 ref");
		} finally {
			await rm(workflowDir, { recursive: true, force: true });
		}
	});

	it("does not flag a step with an explicit non-gate mode (mode: check) even when it listens on pull_request", async () => {
		const workflowDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-doctor-trigger-lint-check-mode-"));
		try {
			await writeFile(
				path.join(workflowDir, "advisory-check.yml"),
				`name: advisory-check
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  check:
    name: gatekeeper-check
    runs-on: ubuntu-latest
    steps:
      - uses: ./
        with:
          mode: check
`,
				"utf8",
			);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			const exitCode = await runDoctor(
				{ registry: registryDirectory, repo: "acme/app", workflow: workflowDir, checkName: ["gatekeeper-check"] },
				registryDirectory,
				{
					createProvider: () => ({
						getBranchProtectionRequiredChecks: async () => ({
							available: true,
							contexts: ["gatekeeper-check"],
							checks: [],
						}),
					}),
				},
			);

			expect(exitCode).toBe(0);
			const output = stderr.mock.calls.map(([message]) => String(message)).join("\n");
			expect(output).not.toContain("受信 ref");
		} finally {
			await rm(workflowDir, { recursive: true, force: true });
		}
	});

	it("does not flag the selfgate shape (pull_request_target/check_suite/schedule + local action) as a trigger violation", async () => {
		const workflowDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-doctor-trigger-lint-ok-"));
		try {
			await writeFile(
				path.join(workflowDir, "selfgate.yml"),
				`name: selfgate
on:
  pull_request_target:
    types: [opened, synchronize, reopened]
  check_suite:
    types: [completed]
  schedule:
    - cron: "*/30 * * * *"
jobs:
  gatekeeper-selfgate:
    name: gatekeeper-selfgate
    runs-on: ubuntu-latest
    steps:
      - uses: ./
        with:
          mode: gate
`,
				"utf8",
			);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			const exitCode = await runDoctor(
				{ registry: registryDirectory, repo: "acme/app", workflow: workflowDir },
				registryDirectory,
				{
					createProvider: () => ({
						getBranchProtectionRequiredChecks: async () => ({
							available: true,
							contexts: ["gatekeeper-selfgate"],
							checks: [],
						}),
					}),
				},
			);

			expect(exitCode).toBe(0);
			const output = stderr.mock.calls.map(([message]) => String(message)).join("\n");
			expect(output).not.toContain("受信 ref");
		} finally {
			await rm(workflowDir, { recursive: true, force: true });
		}
	});

	it("degrades the gate workflow trigger check to a warning (not an error) when it cannot locate the workflow path", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const exitCode = await runDoctor(
			{
				registry: registryDirectory,
				repo: "acme/app",
				checkName: ["gatekeeper"],
				workflow: path.join(registryDirectory, "does-not-exist-workflows"),
			},
			registryDirectory,
			{
				createProvider: () => ({
					getBranchProtectionRequiredChecks: async () => ({
						available: true,
						contexts: ["gatekeeper"],
						checks: [],
					}),
				}),
			},
		);

		expect(exitCode).toBe(0);
		const output = stderr.mock.calls.map(([message]) => String(message)).join("\n");
		expect(output).toContain("无法校验 gate workflow 触发器");
	});

	it("warns and exits zero when branch protection is unavailable", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const exitCode = await runDoctor(
			{ registry: registryDirectory, repo: "acme/app", branch: "main", checkName: ["gatekeeper"] },
			registryDirectory,
			{
				createProvider: () => ({
					getBranchProtectionRequiredChecks: async () => ({
						available: false,
						reason: "forbidden",
						status: 403,
						message: "HTTP 403",
					}),
				}),
			},
		);

		expect(exitCode).toBe(0);
		expect(stderr.mock.calls.map(([message]) => String(message)).join("\n")).toContain("无法校验 branch protection");
	});

	it("returns one for a confirmed missing required check", async () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const exitCode = await runDoctor(
			{ registry: registryDirectory, repo: "acme/app", branch: "main", checkName: ["gatekeeper"] },
			registryDirectory,
			{
				createProvider: () => ({
					getBranchProtectionRequiredChecks: async () => ({
						available: true,
						contexts: ["build"],
						checks: [{ context: "build", app_id: null }],
					}),
				}),
			},
		);

		expect(exitCode).toBe(1);
	});

	it("returns one for a structured user lane schema error before creating a provider", async () => {
		const invalidRegistry = await mkdtemp(path.join(tmpdir(), "gatekeeper-doctor-invalid-lane-"));
		try {
			await writeFile(
				path.join(invalidRegistry, "policy.yaml"),
				`apiVersion: gatekeeper/v1
lanes:
  broken: { type: check-run, name: build-*, pas: [success] }
levels: {}
`,
				"utf8",
			);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const createProvider = vi.fn(() => {
				throw new Error("provider must not be created for an invalid registry");
			});

			const exitCode = await runDoctor(
				{ registry: invalidRegistry, repo: "acme/app", checkName: ["gatekeeper"] },
				invalidRegistry,
				{ createProvider },
			);

			expect(exitCode).toBe(1);
			expect(createProvider).not.toHaveBeenCalled();
			expect(stderr.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				"expected a known key or x-* extension",
			);
		} finally {
			await rm(invalidRegistry, { recursive: true, force: true });
		}
	});
});

describe("rolesPolicyCapabilityCheck", () => {
	let cwd: string;
	let piConfigDir: string;

	beforeEach(async () => {
		cwd = await mkdtemp(path.join(tmpdir(), "gatekeeper-doctor-roles-cwd-"));
		piConfigDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-doctor-roles-pi-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
		await rm(piConfigDir, { recursive: true, force: true });
	});

	it("falls back to the package-shipped roles-policy.yaml when the cwd has none, and actually evaluates it", async () => {
		// no roles-policy.yaml written into cwd -- and piConfigDir points nowhere, so
		// availability is unknown and no tier can be escalated to an error. If the
		// fallback failed to resolve a real file, this would surface as a distinct
		// "无法读取 roles-policy" warning instead of the tier warnings asserted below.
		const check = rolesPolicyCapabilityCheck(cwd, { piConfigDir: path.join(piConfigDir, "does-not-exist") });
		const result = await check.run();

		expect(result.errors ?? []).toEqual([]);
		expect(result.warnings?.some((warning) => warning.includes("无法读取 agent runtime 配置"))).toBe(true);
		expect(result.warnings?.some((warning) => warning.includes("无法读取 roles-policy"))).toBe(false);
		// The shipped file declares three tiers; each contributes its own warning when
		// availability is unknown, proving the real multi-tier file was actually loaded
		// and processed (not silently skipped).
		expect((result.warnings ?? []).length).toBeGreaterThanOrEqual(4);
	});

	it("prefers a cwd-local roles-policy.yaml override over the package-shipped file", async () => {
		// This override deliberately omits the deep-reasoner tier the shipped file has --
		// its absence from the output proves the override took effect.
		await writeFile(
			path.join(cwd, "roles-policy.yaml"),
			`apiVersion: gatekeeper/v1
tiers:
  coder:
    prefer: ["acme/only-model"]
`,
			"utf8",
		);
		await writeFile(path.join(piConfigDir, "auth.json"), "{}", "utf8");

		const check = rolesPolicyCapabilityCheck(cwd, { piConfigDir });
		const result = await check.run();

		expect(result.errors ?? []).toEqual([]);
		expect(result.warnings?.some((warning) => warning.includes("deep-reasoner"))).toBe(false);
		expect(result.warnings?.some((warning) => warning.includes("coder tier has no available model"))).toBe(true);
	});

	it("degrades to a warning (not an error) when roles-policy.yaml is missing everywhere", async () => {
		const check = rolesPolicyCapabilityCheck(cwd, {
			rolesPolicyPath: path.join(cwd, "nonexistent-roles-policy.yaml"),
			piConfigDir,
		});
		const result = await check.run();

		expect(result.errors ?? []).toEqual([]);
		expect(result.warnings?.some((warning) => warning.includes("无法读取 roles-policy"))).toBe(true);
	});

	it("escalates to an error when roles-policy.yaml exists but fails to parse (not silently downgraded)", async () => {
		await writeFile(path.join(cwd, "roles-policy.yaml"), "tiers: [", "utf8");

		const check = rolesPolicyCapabilityCheck(cwd, { piConfigDir });
		const result = await check.run();

		expect(result.errors?.length ?? 0).toBeGreaterThan(0);
		expect((result.warnings ?? []).some((warning) => warning.includes("无法读取 roles-policy"))).toBe(false);
	});

	it("errors when the deep-reasoner tier has zero available models under a known pi config", async () => {
		await writeFile(
			path.join(cwd, "roles-policy.yaml"),
			`apiVersion: gatekeeper/v1
tiers:
  deep-reasoner:
    prefer: ["acme/only-model"]
`,
			"utf8",
		);
		await writeFile(path.join(piConfigDir, "auth.json"), "{}", "utf8");

		const check = rolesPolicyCapabilityCheck(cwd, { piConfigDir });
		const result = await check.run();

		expect(result.errors?.length ?? 0).toBeGreaterThan(0);
	});

	it("warns (not errors, not silent OK) when the deep-reasoner tier has only model-level-unconfirmed candidates", async () => {
		await writeFile(
			path.join(cwd, "roles-policy.yaml"),
			`apiVersion: gatekeeper/v1
tiers:
  deep-reasoner:
    prefer: ["acme/only-model"]
`,
			"utf8",
		);
		// acme is credentialed (vendor-level only, no models.json) -- deep-reasoner has a
		// selection, but it cannot be model-level-confirmed.
		await writeFile(path.join(piConfigDir, "auth.json"), JSON.stringify({ acme: { apiKey: "x" } }), "utf8");

		const check = rolesPolicyCapabilityCheck(cwd, { piConfigDir });
		const result = await check.run();

		expect(result.errors ?? []).toEqual([]);
		expect(result.warnings?.some((warning) => warning.includes("model-level-unconfirmed"))).toBe(true);
	});

	it("neither warns nor errors on deep-reasoner beyond ordinary tier warnings when a selection is models.json-confirmed", async () => {
		await writeFile(
			path.join(cwd, "roles-policy.yaml"),
			`apiVersion: gatekeeper/v1
tiers:
  deep-reasoner:
    prefer: ["acme/only-model"]
`,
			"utf8",
		);
		await writeFile(path.join(piConfigDir, "auth.json"), JSON.stringify({ acme: { apiKey: "x" } }), "utf8");
		// Real pi models.json shape: providers.<vendor>.models[].id, not a flat string[].
		await writeFile(
			path.join(piConfigDir, "models.json"),
			JSON.stringify({ providers: { acme: { models: [{ id: "only-model" }] } } }),
			"utf8",
		);

		const check = rolesPolicyCapabilityCheck(cwd, { piConfigDir });
		const result = await check.run();

		expect(result.errors ?? []).toEqual([]);
		expect(result.warnings?.some((warning) => warning.includes("model-level-unconfirmed"))).toBe(false);
	});

	it("parses a real JSONC-shaped models.json (comments, trailing commas) end-to-end through the capability check", async () => {
		await writeFile(
			path.join(cwd, "roles-policy.yaml"),
			`apiVersion: gatekeeper/v1
tiers:
  deep-reasoner:
    prefer: ["acme/only-model"]
`,
			"utf8",
		);
		await writeFile(path.join(piConfigDir, "auth.json"), JSON.stringify({ acme: { apiKey: "x" } }), "utf8");
		await writeFile(
			path.join(piConfigDir, "models.json"),
			`{
  // acme is a local/custom provider
  "providers": {
    "acme": {
      "baseUrl": "http://localhost:9999/v1", // double-slash inside a string, must not be treated as a comment
      "models": [
        { "id": "only-model" }, /* trailing comment */
      ],
    },
  },
}`,
			"utf8",
		);

		const check = rolesPolicyCapabilityCheck(cwd, { piConfigDir });
		const result = await check.run();

		expect(result.errors ?? []).toEqual([]);
		expect(result.warnings?.some((warning) => warning.includes("model-level-unconfirmed"))).toBe(false);
	});

	it("[regression] a models.json confirmation counts even when auth.json is entirely missing -- no false 'no available model' error", async () => {
		await writeFile(
			path.join(cwd, "roles-policy.yaml"),
			`apiVersion: gatekeeper/v1
tiers:
  deep-reasoner:
    prefer: ["acme/only-model"]
`,
			"utf8",
		);
		// auth.json is deliberately never written -- piConfigDir has only models.json.
		await writeFile(
			path.join(piConfigDir, "models.json"),
			JSON.stringify({ providers: { acme: { models: [{ id: "only-model" }] } } }),
			"utf8",
		);

		const check = rolesPolicyCapabilityCheck(cwd, { piConfigDir });
		const result = await check.run();

		// Before the fix, piRuntimeAvailability's early return on the missing auth.json
		// meant models.json was never even read, so deep-reasoner would have zero selections
		// and wrongly escalate to an error here.
		expect(result.errors ?? []).toEqual([]);
		expect(result.warnings?.some((warning) => warning.includes("无法读取 agent runtime 配置"))).toBe(true);
		expect(result.warnings?.some((warning) => warning.includes("models.json 的显式确认仍生效"))).toBe(true);
		expect(result.warnings?.some((warning) => warning.includes("model-level-unconfirmed"))).toBe(false);
		expect(result.warnings?.some((warning) => warning.includes("no available model"))).toBe(false);
	});
});

describe("agentsCapabilityCheck", () => {
	let cwd: string;
	let registryDir: string;

	beforeEach(async () => {
		cwd = await mkdtemp(path.join(tmpdir(), "gatekeeper-doctor-agents-cwd-"));
		registryDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-doctor-agents-registry-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
		await rm(registryDir, { recursive: true, force: true });
	});

	it("is silent when no registry is resolvable at all (no --registry override, no .gatekeeper.yml)", async () => {
		const check = agentsCapabilityCheck(cwd);
		const result = await check.run();

		expect(result).toEqual({});
	});

	it("reports an info-level nudge (not a warning) when the registry has no governance/agents.yaml", async () => {
		const check = agentsCapabilityCheck(cwd, { registryOverride: registryDir });
		const result = await check.run();

		expect(result.warnings ?? []).toEqual([]);
		expect(result.errors ?? []).toEqual([]);
		expect(result.infos?.some((message) => message.includes("gatekeeper init-control"))).toBe(true);
	});

	it("is silent (no warnings) when every assigned CLI is still detected on PATH", async () => {
		await writeFile(
			path.join(registryDir, "agents.yaml"),
			[
				"apiVersion: gatekeeper/v1",
				"assignments:",
				"  - role: deep-reasoner",
				"    cli: codex",
				"    vendor: openai",
				'    command_template: "codex exec --full-auto < {brief} > {out}"',
				"    rationale: test",
				"detected: []",
				"warnings: []",
			].join("\n"),
			"utf8",
		);
		const detected: DetectedAgentCli[] = [
			{
				name: "codex",
				binary: "codex",
				vendor: "openai",
				tiers: ["deep-reasoner", "coder", "reviewer"],
				commandTemplate: "codex exec --full-auto < {brief} > {out}",
				path: "/usr/local/bin/codex",
				version: "1.0.0",
			},
		];

		const check = agentsCapabilityCheck(cwd, { registryOverride: registryDir, detect: async () => detected });
		const result = await check.run();

		expect(result.warnings ?? []).toEqual([]);
		expect(result.infos ?? []).toEqual([]);
	});

	it("warns when an assigned CLI is no longer found on PATH", async () => {
		await writeFile(
			path.join(registryDir, "agents.yaml"),
			[
				"apiVersion: gatekeeper/v1",
				"assignments:",
				"  - role: deep-reasoner",
				"    cli: codex",
				"    vendor: openai",
				'    command_template: "codex exec --full-auto < {brief} > {out}"',
				"    rationale: test",
				"detected: []",
				"warnings: []",
			].join("\n"),
			"utf8",
		);

		const check = agentsCapabilityCheck(cwd, { registryOverride: registryDir, detect: async () => [] });
		const result = await check.run();

		expect(
			result.warnings?.some((warning) => warning.includes('"codex"') && warning.includes("no longer on PATH")),
		).toBe(true);
	});

	it("escalates to an error (not a crash, not a silent warning) when governance/agents.yaml exists but fails to parse", async () => {
		await writeFile(path.join(registryDir, "agents.yaml"), "not: [valid, yaml", "utf8");

		const check = agentsCapabilityCheck(cwd, { registryOverride: registryDir, detect: async () => [] });
		const result = await check.run();

		// Mirrors rolesPolicyCapabilityCheck's fail-loud-on-parse-damage posture: an
		// agents.yaml that exists but is malformed is a real configuration defect, not
		// routine "unreadable"/"not configured" (which stay warnings/infos).
		expect(result.warnings ?? []).toEqual([]);
		expect(result.errors?.some((message) => message.includes(path.join(registryDir, "agents.yaml")))).toBe(true);
	});

	it("degrades to a warning (not an error) when governance/agents.yaml exists but cannot be read", async () => {
		await writeFile(path.join(registryDir, "agents.yaml"), "apiVersion: gatekeeper/v1\nassignments: []\n", "utf8");
		const check = agentsCapabilityCheck(cwd, {
			registryOverride: registryDir,
			detect: async () => [],
			loadAgentsFile: async () => {
				throw new AgentsFileReadError(`failed to read ${path.join(registryDir, "agents.yaml")}: EACCES`);
			},
		});
		const result = await check.run();

		expect(result.errors ?? []).toEqual([]);
		expect(result.warnings?.some((message) => message.includes("EACCES"))).toBe(true);
	});
});
