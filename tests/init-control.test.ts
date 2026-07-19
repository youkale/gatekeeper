import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import type { DetectedAgentCli } from "../src/agent/detect.js";
import { runAdopt } from "../src/commands/adopt.js";
import { type InitControlDependencies, runInitControl } from "../src/commands/init-control.js";
import { loadRepos } from "../src/config/repos.js";
import { ROLE_CARD_NAMES } from "../src/roles/cards.js";

const repoRootDir = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(repoRootDir, "src/cli.ts");
const tsxLoader = path.join(repoRootDir, "node_modules/tsx/dist/loader.mjs");

interface RunResult {
	status: number;
	stdout: string;
	stderr: string;
}

function runCli(cwd: string, args: string[]): RunResult {
	const result = spawnSync(process.execPath, ["--import", tsxLoader, cliPath, ...args], { cwd, encoding: "utf8" });
	return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await stat(candidate);
		return true;
	} catch {
		return false;
	}
}

let tmpDir: string | undefined;

async function makeTmpDir(prefix: string): Promise<string> {
	tmpDir = await mkdtemp(path.join(tmpdir(), prefix));
	return tmpDir;
}

afterEach(async () => {
	if (tmpDir) {
		await rm(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});

async function makeGitRepo(base: string, name: string, remote = "git@github.com:acme/app.git"): Promise<string> {
	const repoDir = path.join(base, name);
	await mkdir(repoDir, { recursive: true });
	git(repoDir, ["init", "-q"]);
	git(repoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	git(repoDir, ["config", "user.email", "init-control@example.com"]);
	git(repoDir, ["config", "user.name", "Init Control Bot"]);
	git(repoDir, ["remote", "add", "origin", remote]);
	await writeFile(path.join(repoDir, "README.md"), "hello\n", "utf8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-q", "-m", "init"]);
	return repoDir;
}

const REGISTRY_ARTIFACT_PATHS = [
	path.join("governance", "registry", "policy.yaml"),
	path.join("governance", "registry", "contracts", "_example.yaml.txt"),
	path.join("governance", "registry", "repos.yaml"),
	...ROLE_CARD_NAMES.map((card) => path.join("governance", "roles", `${card}.md`)),
	"roles-policy.yaml",
];

/**
 * Fixed, deterministic detection fixture used by every test below except the
 * dedicated real-CLI smoke test (`via the real CLI: init-control then adopt
 * --control succeed end to end`): none of these tests should depend on which
 * agent CLIs happen to be installed on whatever machine runs the suite.
 */
const STUB_DETECTED: DetectedAgentCli[] = [
	{
		name: "codex",
		binary: "codex",
		vendor: "openai",
		tiers: ["deep-reasoner", "coder", "reviewer"],
		commandTemplate: "codex exec --full-auto < {brief} > {out}",
		path: "/usr/local/bin/codex",
		version: "codex-cli 1.2.3",
	},
	{
		name: "claude",
		binary: "claude",
		vendor: "anthropic",
		tiers: ["deep-reasoner", "coder", "reviewer"],
		commandTemplate: "claude -p --output-format text < {brief} > {out}",
		path: "/usr/local/bin/claude",
		version: null,
	},
];
const STUB_DEPENDENCIES: InitControlDependencies = { detectAgentClis: async () => STUB_DETECTED };

describe("gatekeeper init-control: full skeleton generation", () => {
	it("creates every artifact and prints a generated/validate summary", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-full-");
		const controlRoot = path.join(base, "control");

		let stdout = "";
		const stdoutSpy = ((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = stdoutSpy;
		let exitCode: number;
		try {
			exitCode = await runInitControl({ path: "control" }, base, STUB_DEPENDENCIES);
		} finally {
			process.stdout.write = original;
		}

		expect(exitCode).toBe(0);
		for (const relativePath of REGISTRY_ARTIFACT_PATHS) {
			expect(await pathExists(path.join(controlRoot, relativePath))).toBe(true);
		}
		expect(stdout).toContain("artifact(s) at");
		expect(stdout).toContain("wrote governance/registry/policy.yaml");
		expect(stdout).toContain("validating the generated registry");
		expect(stdout).toContain("gatekeeper validate: OK (0 contract(s), 0 warning(s))");
	});

	it("generated policy.yaml validates with zero errors and zero warnings", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-validate-");
		const exitCode = await runInitControl({ path: "control" }, base, STUB_DEPENDENCIES);
		expect(exitCode).toBe(0);

		const result = runCli(base, ["validate", "--registry", path.join(base, "control", "governance", "registry")]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("OK (0 contract(s), 0 warning(s))");
	});

	it("generated repos.yaml parses through loadRepos as an empty roster", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-repos-");
		await runInitControl({ path: "control" }, base, STUB_DEPENDENCIES);

		const registryDir = path.join(base, "control", "governance", "registry");
		const repos = await loadRepos(registryDir);
		expect(repos).toEqual([]);

		const raw = await readFile(path.join(registryDir, "repos.yaml"), "utf8");
		expect(raw).toContain("workspace-specific");
		const parsed = parseYaml(raw);
		expect(parsed.apiVersion).toBe("gatekeeper/v1");
		expect(parsed.repos).toEqual([]);
	});

	it("writes all five role cards with a control-repo customization header", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-roles-");
		await runInitControl({ path: "control" }, base, STUB_DEPENDENCIES);

		expect(ROLE_CARD_NAMES).toHaveLength(5);
		for (const card of ROLE_CARD_NAMES) {
			const content = await readFile(path.join(base, "control", "governance", "roles", `${card}.md`), "utf8");
			expect(content).toContain("init-control");
			expect(content).toContain("按组织定制");
			// The packaged card's own body must still be present underneath the header.
			expect(content).toContain("role card");
		}
	});

	it("writes a roles-policy.yaml copy with a customization header at the control root", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-roles-policy-");
		await runInitControl({ path: "control" }, base, STUB_DEPENDENCIES);

		const content = await readFile(path.join(base, "control", "roles-policy.yaml"), "utf8");
		expect(content).toContain("init-control");
		expect(content).toContain("apiVersion: gatekeeper/v1");
		expect(content).toContain("tiers:");
	});
});

describe("gatekeeper init-control: idempotency", () => {
	it("a second run without --force skips every artifact and still validates", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-idempotent-");
		const first = await runInitControl({ path: "control" }, base, STUB_DEPENDENCIES);
		expect(first).toBe(0);

		const policyPath = path.join(base, "control", "governance", "registry", "policy.yaml");
		const before = await readFile(policyPath, "utf8");

		let stdout = "";
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		let second: number;
		try {
			second = await runInitControl({ path: "control" }, base, STUB_DEPENDENCIES);
		} finally {
			process.stdout.write = original;
		}

		expect(second).toBe(0);
		expect(stdout).toContain("skipped governance/registry/policy.yaml (already exists");
		const after = await readFile(policyPath, "utf8");
		expect(after).toBe(before);
	});

	it("--force overwrites template artifacts", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-force-");
		await runInitControl({ path: "control" }, base, STUB_DEPENDENCIES);

		const policyPath = path.join(base, "control", "governance", "registry", "policy.yaml");
		await writeFile(
			policyPath,
			"apiVersion: gatekeeper/v1\nlevels:\n  custom:\n    enforcement: warn\n    require: {}\n",
			"utf8",
		);

		let stdout = "";
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		let exitCode: number;
		try {
			exitCode = await runInitControl({ path: "control", force: true }, base, STUB_DEPENDENCIES);
		} finally {
			process.stdout.write = original;
		}

		expect(exitCode).toBe(0);
		expect(stdout).toContain("overwrote governance/registry/policy.yaml");
		const after = await readFile(policyPath, "utf8");
		expect(after).not.toContain("custom");
		expect(after).toContain("breaking-review-required");
	});

	it("--force never overwrites repos.yaml: adopt-registered repos survive a rerun (T-20260719-05 R1)", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-force-repos-safe-");
		const controlRoot = path.join(base, "control");
		const registryDir = path.join(controlRoot, "governance", "registry");

		const first = await runInitControl({ path: "control" }, base, STUB_DEPENDENCIES);
		expect(first).toBe(0);

		const repoDir = await makeGitRepo(base, "repo");
		const adoptExitCode = await runAdopt({ control: controlRoot }, repoDir, { now: () => "2026-01-01T00:00:00.000Z" });
		expect(adoptExitCode).toBe(0);

		const reposBefore = await loadRepos(registryDir);
		// git rev-parse --show-toplevel resolves symlinks (e.g. macOS /var -> /private/var),
		// so compare against the realpath of the tmp checkout, not its raw mkdtemp path.
		expect(reposBefore).toEqual([
			{ repo: "acme/app", path: await realpath(repoDir), ci: "none", adopted_at: "2026-01-01T00:00:00.000Z" },
		]);

		let stdout = "";
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		let rerunExitCode: number;
		try {
			rerunExitCode = await runInitControl({ path: "control", force: true }, base, STUB_DEPENDENCIES);
		} finally {
			process.stdout.write = original;
		}

		expect(rerunExitCode).toBe(0);
		expect(stdout).toContain("skipped governance/registry/repos.yaml (stateful, owned by `gatekeeper adopt`");
		expect(stdout).not.toContain("overwrote governance/registry/repos.yaml");
		expect(stdout).not.toContain("wrote governance/registry/repos.yaml");

		const reposAfter = await loadRepos(registryDir);
		expect(reposAfter).toEqual(reposBefore);
	});

	it("creates the control directory itself when it does not yet exist", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-mkdir-");
		const exitCode = await runInitControl({ path: path.join("nested", "control") }, base, STUB_DEPENDENCIES);
		expect(exitCode).toBe(0);
		expect(await pathExists(path.join(base, "nested", "control", "governance", "registry", "policy.yaml"))).toBe(true);
	});
});

describe("gatekeeper init-control: connects to adopt", () => {
	it("adopt --control locates the generated registry and registers a target repo", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-adopt-");
		const controlRoot = path.join(base, "control");
		const initExitCode = await runInitControl({ path: "control" }, base, STUB_DEPENDENCIES);
		expect(initExitCode).toBe(0);

		const repoDir = await makeGitRepo(base, "repo");
		const adoptExitCode = await runAdopt({ control: controlRoot }, repoDir, { now: () => "2026-01-01T00:00:00.000Z" });
		expect(adoptExitCode).toBe(0);

		expect(await pathExists(path.join(repoDir, ".gatekeeper.yml"))).toBe(true);
		const registryDir = path.join(controlRoot, "governance", "registry");
		const repos = await loadRepos(registryDir);
		expect(repos).toHaveLength(1);
		expect(repos[0]?.repo).toBe("acme/app");
	});

	it("via the real CLI: init-control then adopt --control succeed end to end", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-cli-adopt-");
		const controlRoot = path.join(base, "control");
		const initResult = runCli(base, ["init-control", "control"]);
		expect(initResult.status).toBe(0);

		const repoDir = await makeGitRepo(base, "repo");
		const adoptResult = runCli(repoDir, ["adopt", "--control", controlRoot]);
		expect(adoptResult.status).toBe(0);
		expect(adoptResult.stdout).toContain("registered acme/app");
	});
});

describe("gatekeeper init-control: agent CLI detection + governance/agents.yaml", () => {
	it("writes governance/agents.yaml with the detected CLIs and their role assignments", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-agents-");
		const exitCode = await runInitControl({ path: "control" }, base, STUB_DEPENDENCIES);
		expect(exitCode).toBe(0);

		const agentsPath = path.join(base, "control", "governance", "agents.yaml");
		expect(await pathExists(agentsPath)).toBe(true);
		const raw = await readFile(agentsPath, "utf8");
		expect(raw).toContain("init-control");
		const parsed = parseYaml(raw);
		expect(parsed.apiVersion).toBe("gatekeeper/v1");

		expect(parsed.detected).toEqual([
			{ name: "codex", binary: "codex", vendor: "openai", path: "/usr/local/bin/codex", version: "codex-cli 1.2.3" },
			{ name: "claude", binary: "claude", vendor: "anthropic", path: "/usr/local/bin/claude", version: null },
		]);

		const byRole = Object.fromEntries(
			(parsed.assignments as Array<{ role: string; cli: string; vendor: string }>).map((a) => [a.role, a]),
		);
		expect(byRole["deep-reasoner"]).toMatchObject({ cli: "claude", vendor: "anthropic" });
		expect(byRole.coder).toMatchObject({ cli: "codex", vendor: "openai" });
		// reviewer tier (count 2, cross_vendor) fills both detected vendors.
		const reviewers = (parsed.assignments as Array<{ role: string; cli: string }>).filter((a) => a.role === "reviewer");
		expect(reviewers.map((r) => r.cli).sort()).toEqual(["claude", "codex"]);
	});

	it("prints a detected-CLI table and a role-assignment summary", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-agents-summary-");
		let stdout = "";
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await runInitControl({ path: "control" }, base, STUB_DEPENDENCIES);
		} finally {
			process.stdout.write = original;
		}

		expect(stdout).toContain("detected agent CLI(s):");
		expect(stdout).toContain("codex (openai)");
		expect(stdout).toContain("claude (anthropic)");
		expect(stdout).toContain("role assignment:");
		expect(stdout).toContain("deep-reasoner: claude (anthropic)");
		expect(stdout).toContain("coder: codex (openai)");
	});

	it("--no-detect skips detection entirely: no governance/agents.yaml is written", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-no-detect-");
		const detectAgentClis = vi.fn(async () => STUB_DETECTED);
		let stdout = "";
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		let exitCode: number;
		try {
			exitCode = await runInitControl({ path: "control", detect: false }, base, { detectAgentClis });
		} finally {
			process.stdout.write = original;
		}

		expect(exitCode).toBe(0);
		expect(detectAgentClis).not.toHaveBeenCalled();
		expect(await pathExists(path.join(base, "control", "governance", "agents.yaml"))).toBe(false);
		expect(stdout).toContain("skipped agent CLI detection (--no-detect)");
	});

	it("--force re-detects and overwrites an existing governance/agents.yaml (regenerable template, unlike repos.yaml)", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-agents-force-");
		await runInitControl({ path: "control" }, base, STUB_DEPENDENCIES);

		const agentsPath = path.join(base, "control", "governance", "agents.yaml");
		await writeFile(agentsPath, "apiVersion: gatekeeper/v1\nassignments: []\ndetected: []\nwarnings: []\n", "utf8");

		let stdout = "";
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await runInitControl({ path: "control", force: true }, base, STUB_DEPENDENCIES);
		} finally {
			process.stdout.write = original;
		}

		expect(stdout).toContain("overwrote governance/agents.yaml");
		const after = parseYaml(await readFile(agentsPath, "utf8"));
		expect(after.assignments.length).toBeGreaterThan(0);
	});

	it("--no-detect init, then hand-edit roles-policy.yaml, then rerun: assignment honors the hand-edited preferences, not the packaged defaults", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-handedit-");
		const first = await runInitControl({ path: "control", detect: false }, base);
		expect(first).toBe(0);

		const rolesPolicyPath = path.join(base, "control", "roles-policy.yaml");
		const agentsPath = path.join(base, "control", "governance", "agents.yaml");
		// Deliberately incompatible with the packaged default: only a single "coder" tier,
		// preferring a vendor (xai) the packaged roles-policy.yaml never mentions for that
		// role at all -- if a later run used the in-memory packaged content instead of this
		// on-disk hand-edit, the assertions below would fail.
		await writeFile(
			rolesPolicyPath,
			'apiVersion: gatekeeper/v1\ntiers:\n  coder:\n    prefer: ["xai/grok-5-code"]\n',
			"utf8",
		);

		// Second call: still --no-detect. Proves the R2 fix directly -- disk roles-policy
		// validation now runs unconditionally (it's no longer nested inside the detect gate),
		// so this must succeed silently (the hand-edit is valid YAML/schema) without performing
		// any detection/assignment/agents.yaml work.
		const second = await runInitControl({ path: "control", detect: false }, base);
		expect(second).toBe(0);
		expect(await pathExists(agentsPath)).toBe(false);

		// Third call: detection now runs (via a stub), so the assignment actually happens --
		// against the still-hand-edited on-disk roles-policy.yaml, not the packaged content.
		const grokOnly: DetectedAgentCli[] = [
			{
				name: "grok",
				binary: "grok",
				vendor: "xai",
				tiers: ["coder", "reviewer"],
				commandTemplate: "grok --prompt-file {brief} > {out}",
				path: "/usr/local/bin/grok",
				version: "grok 1.0.0",
			},
		];
		let stdout = "";
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		let third: number;
		try {
			third = await runInitControl({ path: "control" }, base, { detectAgentClis: async () => grokOnly });
		} finally {
			process.stdout.write = original;
		}

		expect(third).toBe(0);
		// roles-policy.yaml itself must have been left untouched throughout (not overwritten by force: false).
		expect(stdout).toContain("skipped roles-policy.yaml (already exists");

		const parsed = parseYaml(await readFile(agentsPath, "utf8"));
		expect(parsed.assignments).toEqual([
			{
				role: "coder",
				cli: "grok",
				vendor: "xai",
				command_template: "grok --prompt-file {brief} > {out}",
				rationale: expect.stringContaining("xai/grok-5-code"),
			},
		]);
	});

	it("fails closed (exit 2) when the control repo's own roles-policy.yaml exists but fails to parse -- even with --no-detect", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-badpolicy-");
		const first = await runInitControl({ path: "control", detect: false }, base);
		expect(first).toBe(0);

		const rolesPolicyPath = path.join(base, "control", "roles-policy.yaml");
		await writeFile(rolesPolicyPath, "tiers: [", "utf8");

		let stderr = "";
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: unknown) => {
			stderr += String(chunk);
			return true;
		}) as typeof process.stderr.write;
		let exitCode: number;
		try {
			// The critical regression case: --no-detect must NOT bypass this validation --
			// before the R2 fix, the whole read/parse/fail-closed block was nested inside the
			// detect gate, so a damaged roles-policy.yaml silently passed under --no-detect.
			exitCode = await runInitControl({ path: "control", detect: false }, base);
		} finally {
			process.stderr.write = original;
		}

		expect(exitCode).toBe(2);
		expect(stderr).toContain(rolesPolicyPath);
		expect(stderr).toContain("failed to parse");
		// Must not have written governance/agents.yaml off a bad parse.
		expect(await pathExists(path.join(base, "control", "governance", "agents.yaml"))).toBe(false);
	});

	it("also fails closed (exit 2) when a malformed roles-policy.yaml is hit on a run that does perform detection", async () => {
		const base = await makeTmpDir("gatekeeper-init-control-badpolicy-detect-");
		const first = await runInitControl({ path: "control", detect: false }, base);
		expect(first).toBe(0);

		const rolesPolicyPath = path.join(base, "control", "roles-policy.yaml");
		await writeFile(rolesPolicyPath, "tiers: [", "utf8");

		const exitCode = await runInitControl({ path: "control" }, base, STUB_DEPENDENCIES);

		expect(exitCode).toBe(2);
		expect(await pathExists(path.join(base, "control", "governance", "agents.yaml"))).toBe(false);
	});
});
