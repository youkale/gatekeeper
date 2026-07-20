import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { parseNameStatusZ } from "../src/providers/gitdiff.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(repoRoot, "src/cli.ts");
const tsxLoader = path.join(repoRoot, "node_modules/tsx/dist/loader.mjs");

interface RunResult {
	status: number;
	stdout: string;
	stderr: string;
}

interface StreamErrorRunResult extends RunResult {
	signal: NodeJS.Signals | null;
	warningLog: string;
}

function runCli(cwd: string, args: string[], env?: NodeJS.ProcessEnv): RunResult {
	const result = spawnSync(process.execPath, ["--import", tsxLoader, cliPath, ...args], {
		cwd,
		encoding: "utf8",
		env: env ? { ...process.env, ...env } : process.env,
	});
	return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

async function runCliWithStreamError(
	cwd: string,
	args: string[],
	preloadPath: string,
	warningPath: string,
	streamName: "stdout" | "stderr",
): Promise<StreamErrorRunResult> {
	writeFileSync(warningPath, "");
	const child = spawn(process.execPath, ["--import", preloadPath, "--import", tsxLoader, cliPath, ...args], {
		cwd,
		env: {
			...process.env,
			GATEKEEPER_TEST_STREAM: streamName,
			GATEKEEPER_TEST_WARNING_LOG: warningPath,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const { status, signal } = await new Promise<{ status: number; signal: NodeJS.Signals | null }>((resolve) => {
		child.on("close", (code, closeSignal) => resolve({ status: code ?? -1, signal: closeSignal }));
	});
	return { status, signal, stdout, stderr, warningLog: readFileSync(warningPath, "utf8") };
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

// Reuse the M1 fixture corpus's ci-image-tag case so the registry under test
// matches a real-world contract rather than a hand-rolled duplicate.
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
const UNRELATED_FILE = "hello from an unrelated file\n";

describe("M2 CLI e2e", () => {
	let tmpBase: string;
	let registryDir: string;
	let repoDir: string;
	let streamErrorPreloadPath: string;

	beforeAll(() => {
		tmpBase = mkdtempSync(path.join(tmpdir(), "gatekeeper-e2e-"));
		streamErrorPreloadPath = path.join(tmpBase, "stream-error.mjs");
		writeFileSync(
			streamErrorPreloadPath,
			`import { appendFileSync } from "node:fs";

const streamName = process.env.GATEKEEPER_TEST_STREAM;
const otherStream = streamName === "stdout" ? process.stderr : process.stdout;
const originalWrite = otherStream.write.bind(otherStream);
otherStream.write = (chunk, ...args) => {
	appendFileSync(process.env.GATEKEEPER_TEST_WARNING_LOG, String(chunk));
	return originalWrite(chunk, ...args);
};

process.once("beforeExit", () => {
	const error = Object.assign(new Error("simulated stream failure"), { code: "EIO" });
	process[streamName].emit("error", error);
});
`,
		);

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
		git(repoDir, ["config", "user.email", "e2e@example.com"]);
		git(repoDir, ["config", "user.name", "E2E Bot"]);
		git(repoDir, ["remote", "add", "origin", "git@github.com:org/app.git"]);

		writeFileSync(path.join(repoDir, ".github/workflows/release.yml"), WORKFLOW_V1);
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-q", "-m", "init"]);
	});

	afterAll(() => {
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("blocks a diff that hits the ci-image-tag authority glob + if_content, with --json fields", () => {
		git(repoDir, ["checkout", "-q", "-b", "feature-image-tag"]);
		writeFileSync(path.join(repoDir, ".github/workflows/release.yml"), WORKFLOW_V2);
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-q", "-m", "bump image tag"]);

		const result = runCli(repoDir, ["check", "--registry", registryDir, "--json"]);

		expect(result.status).toBe(1);
		const verdict = JSON.parse(result.stdout);
		expect(verdict.decision).toBe("block");
		expect(verdict.repo).toBe("org/app");
		expect(verdict.touched.map((hit: { contract: string }) => hit.contract)).toEqual(["ci-image-tag"]);
		expect(verdict.forbiddenEdits).toEqual([]);
		expect(result.stderr).toContain("GATEKEEPER BLOCK");

		git(repoDir, ["checkout", "-q", "main"]);
		git(repoDir, ["branch", "-q", "-D", "feature-image-tag"]);
	});

	it("--explain renders a file -> glob -> contract -> policy provenance trace", () => {
		git(repoDir, ["checkout", "-q", "-b", "feature-explain"]);
		writeFileSync(path.join(repoDir, ".github/workflows/release.yml"), WORKFLOW_V2);
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-q", "-m", "bump image tag"]);

		const result = runCli(repoDir, ["check", "--registry", registryDir, "--explain"]);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain(".github/workflows/release.yml");
		expect(result.stdout).toContain('glob ".github/workflows/**"');
		expect(result.stdout).toContain("contract ci-image-tag");
		expect(result.stdout).toContain("policy enforcement=block");

		git(repoDir, ["checkout", "-q", "main"]);
		git(repoDir, ["branch", "-q", "-D", "feature-explain"]);
	});

	it("passes (exit 0) for a diff that touches no contract glob", () => {
		git(repoDir, ["checkout", "-q", "-b", "feature-unrelated"]);
		writeFileSync(path.join(repoDir, "README.md"), UNRELATED_FILE);
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-q", "-m", "add readme"]);

		const result = runCli(repoDir, ["check", "--registry", registryDir, "--json"]);

		expect(result.status).toBe(0);
		const verdict = JSON.parse(result.stdout);
		expect(verdict.decision).toBe("pass");
		expect(verdict.touched).toEqual([]);

		git(repoDir, ["checkout", "-q", "main"]);
		git(repoDir, ["branch", "-q", "-D", "feature-unrelated"]);
	});

	it("does not falsely match if_content on a pure git mv rename (no content change)", () => {
		git(repoDir, ["checkout", "-q", "-b", "feature-pure-rename"]);
		git(repoDir, ["mv", ".github/workflows/release.yml", ".github/workflows/release-renamed.yml"]);
		git(repoDir, ["commit", "-q", "-m", "rename workflow"]);

		const result = runCli(repoDir, ["check", "--registry", registryDir, "--base", "main", "--json"]);

		// The rename itself changes no content lines, so the if_content contract
		// must not fire — a pure rename must not manufacture a block.
		expect(result.status).toBe(0);
		const verdict = JSON.parse(result.stdout);
		expect(verdict.decision).toBe("pass");
		expect(verdict.touched).toEqual([]);

		git(repoDir, ["checkout", "-q", "main"]);
		git(repoDir, ["branch", "-q", "-D", "feature-pure-rename"]);
	});

	it("handles a git mv rename combined with a matching content edit (status R, blocked)", () => {
		git(repoDir, ["checkout", "-q", "-b", "feature-rename-edit"]);
		git(repoDir, ["mv", ".github/workflows/release.yml", ".github/workflows/release-renamed.yml"]);
		writeFileSync(path.join(repoDir, ".github/workflows/release-renamed.yml"), WORKFLOW_V2);
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-q", "-m", "rename workflow and bump tag"]);

		const result = runCli(repoDir, ["check", "--registry", registryDir, "--base", "main", "--json"]);

		expect(result.status).toBe(1);
		const verdict = JSON.parse(result.stdout);
		expect(verdict.decision).toBe("block");
		const authorityBinding = verdict.touched[0].bindings[0];
		const fileMatch = authorityBinding.files[0];
		expect(fileMatch.status).toBe("R");
		expect(fileMatch.path).toBe(".github/workflows/release-renamed.yml");
		expect(fileMatch.matchedGlob).toBe(".github/workflows/**");
		expect(fileMatch.contentCheck).toBe("matched");

		git(repoDir, ["checkout", "-q", "main"]);
		git(repoDir, ["branch", "-q", "-D", "feature-rename-edit"]);
	});

	it("--staged diffs the index instead of base...head", () => {
		writeFileSync(path.join(repoDir, ".github/workflows/release.yml"), WORKFLOW_V2);
		git(repoDir, ["add", "-A"]);

		const result = runCli(repoDir, ["check", "--registry", registryDir, "--staged", "--json"]);

		expect(result.status).toBe(1);
		const verdict = JSON.parse(result.stdout);
		expect(verdict.decision).toBe("block");
		expect(verdict.touched.map((hit: { contract: string }) => hit.contract)).toEqual(["ci-image-tag"]);

		git(repoDir, ["reset", "-q", "--hard", "HEAD"]);
	});

	it("--working-tree diffs HEAD against the working tree (unstaged changes included)", () => {
		writeFileSync(path.join(repoDir, ".github/workflows/release.yml"), WORKFLOW_V2);

		const result = runCli(repoDir, ["check", "--registry", registryDir, "--working-tree", "--json"]);

		expect(result.status).toBe(1);
		const verdict = JSON.parse(result.stdout);
		expect(verdict.decision).toBe("block");
		expect(verdict.touched.map((hit: { contract: string }) => hit.contract)).toEqual(["ci-image-tag"]);

		git(repoDir, ["checkout", "-q", "--", "."]);
	});

	it("rejects combined diff modes (--staged with --working-tree or --base) with exit 2", () => {
		const stagedAndWorkingTree = runCli(repoDir, ["check", "--registry", registryDir, "--staged", "--working-tree"]);
		expect(stagedAndWorkingTree.status).toBe(2);

		const baseAndStaged = runCli(repoDir, ["check", "--registry", registryDir, "--base", "main", "--staged"]);
		expect(baseAndStaged.status).toBe(2);
	});

	it("exits 0 when the stdout pipe closes early (EPIPE guard, fail-open)", async () => {
		// Passing scenario on main: without the guard, the EPIPE crash would
		// flip the exit code from 0 to 1.
		const child = spawn(
			process.execPath,
			["--import", tsxLoader, cliPath, "check", "--registry", registryDir, "--json"],
			{
				cwd: repoDir,
			},
		);
		child.stdout.destroy();
		child.stderr.resume();
		const status = await new Promise<number>((resolve) => {
			child.on("close", (code) => resolve(code ?? -1));
		});

		expect(status).toBe(0);
	});

	it("does not crash when the CLI stdout stream emits non-EPIPE EIO", async () => {
		const warningPath = path.join(tmpBase, "stdout-eio-warning.log");
		const result = await runCliWithStreamError(
			repoDir,
			["check", "--registry", registryDir, "--json"],
			streamErrorPreloadPath,
			warningPath,
			"stdout",
		);

		expect(result.signal).toBeNull();
		expect(result.status).toBe(0);
		expect(result.warningLog).toContain("warning: Gatekeeper stdout stream error (EIO); preserving exit code");
	});

	it("preserves a CLI block exit code when stderr emits non-EPIPE EIO", async () => {
		const warningPath = path.join(tmpBase, "stderr-eio-warning.log");
		writeFileSync(path.join(repoDir, ".github/workflows/release.yml"), WORKFLOW_V2);
		try {
			const result = await runCliWithStreamError(
				repoDir,
				["check", "--registry", registryDir, "--working-tree", "--json"],
				streamErrorPreloadPath,
				warningPath,
				"stderr",
			);

			expect(result.signal).toBeNull();
			expect(result.status).toBe(1);
			expect(result.warningLog).toContain("warning: Gatekeeper stderr stream error (EIO); preserving exit code");
			expect(result.stderr).not.toContain("simulated stream failure");
		} finally {
			git(repoDir, ["checkout", "-q", "--", ".github/workflows/release.yml"]);
		}
	});

	it("fails open (exit 0 + DEGRADED) when the registry directory does not exist, and --json reports degraded", () => {
		const result = runCli(repoDir, ["check", "--registry", path.join(tmpBase, "does-not-exist"), "--json"]);

		expect(result.status).toBe(0);
		expect(result.stderr).toContain("GATEKEEPER DEGRADED");
		const payload = JSON.parse(result.stdout);
		expect(payload.degraded).toBe(true);
		expect(typeof payload.reason).toBe("string");
	});

	it("--strict-infra turns an infra/config fault into exit 2", () => {
		const result = runCli(repoDir, ["check", "--registry", path.join(tmpBase, "does-not-exist"), "--strict-infra"]);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("GATEKEEPER DEGRADED");
	});

	it("--strict-infra with --json still writes the degraded JSON payload to stdout", () => {
		const result = runCli(repoDir, [
			"check",
			"--registry",
			path.join(tmpBase, "does-not-exist"),
			"--strict-infra",
			"--json",
		]);

		expect(result.status).toBe(2);
		const payload = JSON.parse(result.stdout);
		expect(payload.degraded).toBe(true);
		expect(typeof payload.reason).toBe("string");
		expect(result.stderr).toContain("GATEKEEPER DEGRADED");
	});

	it("commander usage errors (unknown flag) exit 2", () => {
		const result = runCli(repoDir, ["check", "--registry", registryDir, "--not-a-real-flag"]);

		expect(result.status).toBe(2);
	});

	it("commander usage errors (missing required option) exit 2", () => {
		const result = runCli(repoDir, ["check"]);

		expect(result.status).toBe(2);
	});

	it("validate exits 0 for a legal registry", () => {
		const result = runCli(repoDir, ["validate", "--registry", registryDir]);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("OK");
		expect(result.stderr).toContain("warning: policy lane human overrides preset");
	});

	it("validate accepts a policy whose requirement references only a bundled lane preset", () => {
		const presetRegistryDir = path.join(tmpBase, "preset-only-validate-registry");
		mkdirSync(path.join(presetRegistryDir, "contracts"), { recursive: true });
		writeFileSync(
			path.join(presetRegistryDir, "policy.yaml"),
			`apiVersion: gatekeeper/v1
lanes: {}
levels:
  strict:
    enforcement: block
    require: { m: 1, lanes: [greptile] }
`,
		);
		writeFileSync(
			path.join(presetRegistryDir, "contracts", "preset-only.yaml"),
			`apiVersion: gatekeeper/v1
name: preset-only
level: strict
authority: { repo: org/app, paths: [docs/**] }
`,
		);

		const result = runCli(repoDir, ["validate", "--registry", presetRegistryDir]);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("OK");
		expect(result.stderr).not.toContain("Unknown lane");
	});

	it("check evaluates a registry whose requirement references only a bundled lane preset", () => {
		const presetRegistryDir = path.join(tmpBase, "preset-only-check-registry");
		mkdirSync(path.join(presetRegistryDir, "contracts"), { recursive: true });
		writeFileSync(
			path.join(presetRegistryDir, "policy.yaml"),
			`apiVersion: gatekeeper/v1
lanes: {}
levels:
  strict:
    enforcement: block
    require: { m: 1, lanes: [greptile] }
`,
		);
		writeFileSync(
			path.join(presetRegistryDir, "contracts", "preset-only.yaml"),
			`apiVersion: gatekeeper/v1
name: preset-only
level: strict
authority: { repo: org/app, paths: [docs/**] }
`,
		);

		const result = runCli(repoDir, ["check", "--registry", presetRegistryDir, "--json"]);

		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ decision: "pass", repo: "org/app" });
		expect(result.stderr).not.toContain("GATEKEEPER DEGRADED");
	});

	it("preserves structured registry errors for invalid user lanes at validate/check entry points", () => {
		const invalidLaneRegistryDir = path.join(tmpBase, "invalid-user-lane-registry");
		mkdirSync(path.join(invalidLaneRegistryDir, "contracts"), { recursive: true });
		writeFileSync(
			path.join(invalidLaneRegistryDir, "policy.yaml"),
			`apiVersion: gatekeeper/v1
lanes:
  broken:
    type: check-run
    name: build-*
    pas: [success]
levels: {}
`,
		);

		const validation = runCli(repoDir, ["validate", "--registry", invalidLaneRegistryDir]);
		expect(validation.status).toBe(2);
		expect(validation.stderr).toContain("$.lanes.broken.pas: expected a known key or x-* extension");
		expect(validation.stderr).toContain('got array(1). Unknown key "pas". Did you mean "pass"?');

		const check = runCli(repoDir, ["check", "--registry", invalidLaneRegistryDir, "--json"]);
		expect(check.status).toBe(0);
		expect(JSON.parse(check.stdout)).toMatchObject({ degraded: true });
		expect(check.stderr).toContain("GATEKEEPER DEGRADED");
		expect(check.stderr).toContain("$.lanes.broken.pas: expected a known key or x-* extension");
	});

	it("validate exits 2 for an illegal registry (unknown policy level)", () => {
		const badRegistryDir = path.join(tmpBase, "bad-registry");
		mkdirSync(path.join(badRegistryDir, "contracts"), { recursive: true });
		writeFileSync(path.join(badRegistryDir, "policy.yaml"), stringifyYaml(fixture.registry.policy));
		const contract = fixture.registry.contracts[0] as { level: string };
		writeFileSync(
			path.join(badRegistryDir, "contracts", "ci-image-tag.yaml"),
			stringifyYaml({ ...(fixture.registry.contracts[0] as object), level: "no-such-level" }),
		);

		const result = runCli(repoDir, ["validate", "--registry", badRegistryDir]);

		expect(result.status).toBe(2);
		expect(result.stderr.length).toBeGreaterThan(0);
		expect(contract.level).not.toBe("no-such-level");
	});

	it("validate exits 2 for a missing or non-directory registry root, including under --strict", () => {
		const missingRegistry = path.join(tmpBase, "missing-validate-registry");

		const plain = runCli(repoDir, ["validate", "--registry", missingRegistry]);
		expect(plain.status).toBe(2);
		expect(plain.stderr).toContain("gatekeeper validate: failed to access registry directory");

		const strict = runCli(repoDir, ["validate", "--registry", missingRegistry, "--strict"]);
		expect(strict.status).toBe(2);
		expect(strict.stderr).toContain("gatekeeper validate: failed to access registry directory");

		const registryFile = path.join(tmpBase, "validate-registry-file");
		writeFileSync(registryFile, "not a registry directory\n");
		const nonDirectory = runCli(repoDir, ["validate", "--registry", registryFile]);
		expect(nonDirectory.status).toBe(2);
		expect(nonDirectory.stderr).toContain("gatekeeper validate: registry path is not a directory");
	});

	it("validate warns (exit 0) on a bare '**' glob, and --strict elevates it to exit 1", () => {
		const warnRegistryDir = path.join(tmpBase, "warn-registry");
		mkdirSync(path.join(warnRegistryDir, "contracts"), { recursive: true });
		writeFileSync(path.join(warnRegistryDir, "policy.yaml"), stringifyYaml(fixture.registry.policy));
		writeFileSync(
			path.join(warnRegistryDir, "contracts", "ci-image-tag.yaml"),
			stringifyYaml({ ...(fixture.registry.contracts[0] as object), authority: { repo: "org/app", paths: ["**"] } }),
		);

		const plain = runCli(repoDir, ["validate", "--registry", warnRegistryDir]);
		expect(plain.status).toBe(0);
		expect(plain.stderr).toContain("warning:");

		const strict = runCli(repoDir, ["validate", "--registry", warnRegistryDir, "--strict"]);
		expect(strict.status).toBe(1);
	});

	it("--version and --help succeed with exit 0", () => {
		const version = runCli(repoDir, ["--version"]);
		expect(version.status).toBe(0);
		expect(version.stdout.trim().length).toBeGreaterThan(0);

		const help = runCli(repoDir, ["--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("check");
		expect(help.stdout).toContain("validate");
	});

	it("adopt (zero-touch) followed by a bare `gatekeeper check` from inside the adopted repo resolves via the controls index", () => {
		// A control/hub checkout with the same fixture registry used throughout this
		// file, plus an unrelated target repo -- both live under tmpBase so afterAll's
		// rmSync cleans them up along with everything else.
		const controlRoot = path.join(tmpBase, "adopt-control");
		const controlRegistryDir = path.join(controlRoot, "governance", "registry");
		mkdirSync(path.join(controlRegistryDir, "contracts"), { recursive: true });
		writeFileSync(path.join(controlRegistryDir, "policy.yaml"), stringifyYaml(fixture.registry.policy));
		writeFileSync(
			path.join(controlRegistryDir, "contracts", "ci-image-tag.yaml"),
			stringifyYaml(fixture.registry.contracts[0]),
		);

		const targetRepoDir = path.join(tmpBase, "adopt-target");
		mkdirSync(targetRepoDir, { recursive: true });
		git(targetRepoDir, ["init", "-q"]);
		git(targetRepoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
		git(targetRepoDir, ["config", "user.email", "e2e@example.com"]);
		git(targetRepoDir, ["config", "user.name", "E2E Bot"]);
		git(targetRepoDir, ["remote", "add", "origin", "git@github.com:org/app.git"]);
		writeFileSync(path.join(targetRepoDir, "README.md"), "hello\n");
		git(targetRepoDir, ["add", "-A"]);
		git(targetRepoDir, ["commit", "-q", "-m", "init"]);

		// Isolated from every other test in this file: its own GATEKEEPER_CONFIG_DIR,
		// never the real ~/.config/gatekeeper/controls.yaml (see src/config/controls.ts).
		const controlsConfigDir = path.join(tmpBase, "adopt-controls-config");
		const env = { GATEKEEPER_CONFIG_DIR: controlsConfigDir };

		const adopted = runCli(targetRepoDir, ["adopt", "--control", controlRoot], env);
		expect(adopted.status).toBe(0);
		expect(existsSync(path.join(targetRepoDir, ".gatekeeper.yml"))).toBe(false);

		const checked = runCli(targetRepoDir, ["check", "--working-tree", "--json"], env);
		expect(checked.status).toBe(0);
		const verdict = JSON.parse(checked.stdout);
		expect(verdict.repo).toBe("org/app");
		expect(verdict.degraded).toBeUndefined();
	});
});

describe("M2 CLI e2e: gatekeeper dispatch status (empty store)", () => {
	it("lists no orders and exits 0 against a fresh GATEKEEPER_CONFIG_DIR", () => {
		const tmpBase = mkdtempSync(path.join(tmpdir(), "gatekeeper-e2e-dispatch-status-"));
		try {
			const configDir = path.join(tmpBase, "config");
			const env = { GATEKEEPER_CONFIG_DIR: configDir };

			const result = runCli(tmpBase, ["dispatch", "status"], env);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("no orders");

			const jsonResult = runCli(tmpBase, ["dispatch", "status", "--json"], env);
			expect(jsonResult.status).toBe(0);
			expect(JSON.parse(jsonResult.stdout)).toEqual({ orders: [] });
		} finally {
			rmSync(tmpBase, { recursive: true, force: true });
		}
	});
});

describe("M2 CLI e2e: gatekeeper dispatch resume --help (T-20260720-07 R2 wiring)", () => {
	it("documents the NEEDS_ATTENTION --agent resolution and exit-code contract, with no leftover 'not wired'/'not implemented' language", () => {
		const help = runCli(process.cwd(), ["dispatch", "resume", "--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("resume a NEEDS_ATTENTION order back to RUNNING");
		expect(help.stdout).toContain("detectAgentClis finds right now");
		expect(help.stdout).toContain("Exit codes: 0 on a DELIVERED result");
		expect(help.stdout).not.toContain("not yet wired");
		expect(help.stdout).not.toContain("not yet implemented");
	});
});

describe("M2 CLI e2e: gatekeeper dispatch --help (T-20260721-01 exit-code precision fix)", () => {
	it("no longer claims resume on an already-terminal order is uniformly exit 0 -- only DELIVERED is", () => {
		const help = runCli(process.cwd(), ["dispatch", "--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("specifically DELIVERED");
		expect(help.stdout).toContain("still exits 3");
		expect(help.stdout).not.toContain("resume/cancel on an order that was already terminal");
	});
});

describe("M2 CLI e2e: gatekeeper dispatch start --help (T-20260721-01 ad-hoc --brief entry point)", () => {
	it("documents --issue as optional and the ad-hoc --brief-alone mode", () => {
		const help = runCli(process.cwd(), ["dispatch", "start", "--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("At least one of --issue or --brief is");
		expect(help.stdout).toContain("ad-hoc order with no GitHub issue at all");
		expect(help.stdout).toContain("org/repo@adhoc-<id>");
	});
});

describe("gitdiff parseNameStatusZ status normalization", () => {
	it("normalizes type-change T and unmerged U to M instead of silently dropping them", () => {
		const files = parseNameStatusZ("T\0scripts/guarded.sh\0U\0conflicted.txt\0");

		expect(files).toEqual([
			{ path: "scripts/guarded.sh", status: "M" },
			{ path: "conflicted.txt", status: "M" },
		]);
	});

	it("keeps path/status alignment across a mixed A + T + M stream", () => {
		const files = parseNameStatusZ("A\0added.txt\0T\0became-symlink.txt\0M\0modified.txt\0");

		expect(files).toEqual([
			{ path: "added.txt", status: "A" },
			{ path: "became-symlink.txt", status: "M" },
			{ path: "modified.txt", status: "M" },
		]);
	});

	it("parses rename similarity suffixes and old/new path order, including spaces and non-ASCII", () => {
		const files = parseNameStatusZ("R100\0old dir/旧文件.txt\0new dir/新文件.txt\0M\0other.txt\0");

		expect(files).toEqual([
			{ path: "new dir/新文件.txt", oldPath: "old dir/旧文件.txt", status: "R" },
			{ path: "other.txt", status: "M" },
		]);
	});
});
