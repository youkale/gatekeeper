import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * B5: every command that consults the controls index (src/config/discover.ts's
 * discoverConfigWithControlsIndex) must thread its own `env`/`dependencies.env`
 * into that call instead of silently defaulting to `process.env` -- otherwise
 * an injected test environment is ignored and the command falls through to
 * (or, in production, actually reads) the real `~/.config/gatekeeper/controls.yaml`.
 *
 * Each test below seeds a *unique*, per-test `GATEKEEPER_CONFIG_DIR` (deliberately
 * different from both the real home directory and from vitest.config.ts's shared
 * global-safety-net directory) and asserts the command's behavior reflects data
 * that only exists at that unique path. Since nothing else on the machine (or in
 * this test run) can have written that data, a passing assertion is only
 * possible if the command actually consulted the injected `env` -- proving both
 * that `env` is threaded through and that the real `~/.config` was never
 * consulted (it has no matching entry either, but this is the stronger,
 * unique-path proof rather than an absence proof).
 */

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

async function writeMinimalRegistry(registryDir: string): Promise<void> {
	await mkdir(path.join(registryDir, "contracts"), { recursive: true });
	await writeFile(
		path.join(registryDir, "policy.yaml"),
		"apiVersion: gatekeeper/v1\nlanes: {}\nlevels:\n  notify:\n    enforcement: warn\n    require: {}\n",
		"utf8",
	);
}

async function makeRepoWithControlsIndex(
	prefix: string,
): Promise<{ repoDir: string; env: { GATEKEEPER_CONFIG_DIR: string } }> {
	const base = await mkdtemp(path.join(tmpdir(), prefix));
	const configDir = path.join(base, "config");
	const env = { GATEKEEPER_CONFIG_DIR: configDir };

	const controlRoot = path.join(base, "control");
	const registryDir = path.join(controlRoot, "governance", "registry");
	await writeMinimalRegistry(registryDir);

	const repoDir = path.join(base, "repo");
	await mkdir(repoDir, { recursive: true });
	git(repoDir, ["init", "-q"]);
	git(repoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	await writeFile(path.join(repoDir, "README.md"), "hello\n", "utf8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, [
		"-c",
		"user.email=env-thread@example.com",
		"-c",
		"user.name=Env Thread Bot",
		"commit",
		"-q",
		"-m",
		"init",
	]);
	const repoRealPath = await realpath(repoDir);

	const { saveRepos } = await import("../src/config/repos.js");
	await saveRepos(registryDir, [
		{ repo: "acme/app", path: repoRealPath, ci: "none", adopted_at: "2026-07-19T00:00:00.000Z" },
	]);
	const { upsertControl } = await import("../src/config/controls.js");
	await upsertControl(
		{
			control: await realpath(controlRoot),
			registry: await realpath(registryDir),
			registered_at: "2026-07-19T00:00:00.000Z",
		},
		env,
	);

	tmpDirs.push(base);
	return { repoDir, env };
}

let tmpDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	tmpDirs = [];
});

describe("check: dependencies.env threads into controls-index discovery", () => {
	it("resolves the registry/repo from an injected GATEKEEPER_CONFIG_DIR with zero flags", async () => {
		const { runCheck } = await import("../src/commands/check.js");
		const { repoDir, env } = await makeRepoWithControlsIndex("gatekeeper-envthread-check-");

		const exitCode = await runCheck({ workingTree: true, json: true }, repoDir, { env });

		expect(exitCode).toBe(0);
	});
});

describe("validate: options.env threads into controls-index discovery", () => {
	it("resolves the registry from an injected GATEKEEPER_CONFIG_DIR with zero flags", async () => {
		const { runValidate } = await import("../src/commands/validate.js");
		const { repoDir, env } = await makeRepoWithControlsIndex("gatekeeper-envthread-validate-");

		let stdoutOutput = "";
		const exitCode = await runValidate({ env, stdout: (chunk) => (stdoutOutput += chunk) }, repoDir);

		expect(exitCode).toBe(0);
		expect(stdoutOutput).toContain("gatekeeper validate: OK");
	});
});

describe("audit: dependencies.env threads into controls-index discovery", () => {
	it("resolves the registry from an injected GATEKEEPER_CONFIG_DIR with zero flags", async () => {
		const { runAudit } = await import("../src/commands/audit.js");
		const { repoDir, env } = await makeRepoWithControlsIndex("gatekeeper-envthread-audit-");

		const exitCode = await runAudit({}, repoDir, { env });

		expect(exitCode).toBe(0);
	});
});
