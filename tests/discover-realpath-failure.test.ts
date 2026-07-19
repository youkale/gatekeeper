import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * B1 regression coverage: a non-`GitDiffError` failure while resolving the
 * controls index's repo-root realpath (src/config/discover.ts's
 * discoverConfigWithControlsIndex, ~"repoRootRealPath = await
 * realpath(repoRoot)") must be wrapped into `ConfigDiscoveryError` -- the
 * same shared error type every call site's existing fail-open (check/gate
 * degrade) / fail-loud (validate/doctor/...) branch already handles for a
 * damaged `.gatekeeper.yml`. Before the fix, a bare non-GitDiffError throw
 * here fell outside gate's `isInfrastructureFailure` allowlist and was
 * treated as a *verdict* defect (`rejectInvalid`, fail-closed exit 1) --
 * exactly backwards for what is actually an infrastructure fault (a
 * realpath EACCES/ELOOP, not a bad diff).
 *
 * Reproducing a real EACCES/ELOOP deterministically (without depending on
 * filesystem permission semantics that root-in-a-CI-container silently
 * bypasses) requires injecting the failure directly at the `fs.realpath`
 * call site, hence the module-level `vi.mock` below -- scoped to this file
 * only, so no other test file's `node:fs/promises` usage is affected.
 */

const state = vi.hoisted(() => ({ triggerPath: undefined as string | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		realpath: vi.fn(async (targetPath: unknown, ...rest: unknown[]) => {
			if (typeof targetPath === "string" && targetPath === state.triggerPath) {
				const error = new Error(`EACCES: simulated permission denied, realpath '${targetPath}'`);
				(error as NodeJS.ErrnoException).code = "EACCES";
				throw error;
			}
			// biome-ignore lint/suspicious/noExplicitAny: passthrough to the real implementation with whatever overload was called.
			return (actual.realpath as any)(targetPath, ...rest);
		}),
	};
});

const { discoverConfigWithControlsIndex, ConfigDiscoveryError } = await import("../src/config/discover.js");
const { resolveRepoRoot } = await import("../src/providers/gitdiff.js");
const { runGate } = await import("../src/commands/gate.js");
const { runValidate } = await import("../src/commands/validate.js");

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

let tmpDir: string | undefined;

async function makeTriggerRepo(prefix: string): Promise<string> {
	tmpDir = await mkdtemp(path.join(tmpdir(), prefix));
	const repoDir = path.join(tmpDir, "repo");
	await mkdir(repoDir, { recursive: true });
	git(repoDir, ["init", "-q"]);
	git(repoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	// Whatever `git rev-parse --show-toplevel` reports for this repo is the exact
	// string discoverConfigWithControlsIndex hands to realpath() -- arm the mock
	// with that precise value (not our own `repoDir` variable, which can disagree
	// on a symlinked tmp checkout, e.g. macOS's /var -> /private/var).
	state.triggerPath = await resolveRepoRoot(repoDir);
	return repoDir;
}

afterEach(async () => {
	state.triggerPath = undefined;
	if (tmpDir) {
		await rm(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});

describe("discoverConfigWithControlsIndex: non-GitDiffError realpath failure (B1)", () => {
	it("throws ConfigDiscoveryError (not a bare error) instead of letting the raw fs error escape", async () => {
		const repoDir = await makeTriggerRepo("gatekeeper-b1-unit-");

		await expect(discoverConfigWithControlsIndex(repoDir, { mode: "gate" })).rejects.toBeInstanceOf(
			ConfigDiscoveryError,
		);
	});
});

describe("gate: fail-open (degrade) on this failure, per the fail-direction law", () => {
	it("exits 0 (default, non-strict degrade) with a GATEKEEPER DEGRADED warning instead of blocking", async () => {
		const repoDir = await makeTriggerRepo("gatekeeper-b1-gate-");
		let stderrOutput = "";
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
			stderrOutput += String(chunk);
			return true;
		}) as typeof process.stderr.write);

		let exitCode: number;
		try {
			exitCode = await runGate({ pr: 7 }, repoDir, {
				createProvider: () => {
					throw new Error("must not reach a GitHub provider call -- discovery should fail before this point");
				},
			});
		} finally {
			stderrSpy.mockRestore();
		}

		expect(exitCode).toBe(0);
		expect(stderrOutput).toContain("GATEKEEPER DEGRADED");
	});
});

describe("validate: fail-loud on this failure (a local-authoring-tool input problem, not a merge decision)", () => {
	it("exits 2 with a descriptive stderr message instead of crashing or silently passing", async () => {
		const repoDir = await makeTriggerRepo("gatekeeper-b1-validate-");
		let stderrOutput = "";

		const exitCode = await runValidate({ stderr: (chunk) => (stderrOutput += chunk) }, repoDir);

		expect(exitCode).toBe(2);
		expect(stderrOutput).toContain("gatekeeper validate:");
	});
});
