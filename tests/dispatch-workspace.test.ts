import { describe, expect, it, vi } from "vitest";

import type { GitExecutionResult, GitExecutor } from "../src/dispatch/evidence.js";
import {
	createWipSnapshot,
	type DispatchWorkspaceError,
	prepareDispatchWorkspace,
	readWorkspaceFingerprint,
	verifyDispatchWorkspaceActive,
} from "../src/dispatch/workspace.js";

function result(stdout = "", exitCode = 0, stderr = ""): GitExecutionResult {
	return { stdout, exitCode, stderr };
}

function scriptedGit(results: readonly GitExecutionResult[]): GitExecutor & { exec: ReturnType<typeof vi.fn> } {
	let index = 0;
	return {
		exec: vi.fn(async () => results[index++] ?? result("", 1, "unexpected git command")),
	};
}

describe("dispatch workspace protocol", () => {
	it("rejects a dirty target before resolving or switching the configured base", async () => {
		const git = scriptedGit([result(" M src/index.ts\n")]);

		await expect(prepareDispatchWorkspace({ orderId: "wo-example", baseRef: "main" }, git)).rejects.toMatchObject({
			code: "DIRTY_WORKTREE",
		} satisfies Partial<DispatchWorkspaceError>);
		expect(git.exec).toHaveBeenCalledTimes(1);
		expect(git.exec).toHaveBeenCalledWith(["status", "--porcelain=v1", "--untracked-files=all"]);
	});

	it("branches from the configured base without fetching or naming a PR head", async () => {
		const git = scriptedGit([
			result(),
			result("43dc1be\n"),
			result("", 1),
			result(),
			result("gatekeeper/dispatch/wo-example\n"),
		]);
		const onBaseResolved = vi.fn(async () => undefined);

		await expect(
			prepareDispatchWorkspace({ orderId: "wo-example", baseRef: "origin/main", onBaseResolved }, git),
		).resolves.toEqual({
			branch: "gatekeeper/dispatch/wo-example",
			baseRef: "origin/main",
			baseOid: "43dc1be",
		});
		expect(git.exec.mock.calls).toEqual([
			[["status", "--porcelain=v1", "--untracked-files=all"]],
			[["rev-parse", "--verify", "--quiet", "origin/main^{commit}"]],
			[["show-ref", "--verify", "--quiet", "refs/heads/gatekeeper/dispatch/wo-example"]],
			[["switch", "--no-track", "--create", "gatekeeper/dispatch/wo-example", "43dc1be"]],
			[["symbolic-ref", "--quiet", "--short", "HEAD"]],
		]);
		const switchCallIndex = git.exec.mock.calls.findIndex(([args]) => args[0] === "switch");
		expect(onBaseResolved.mock.invocationCallOrder[0]).toBeLessThan(
			git.exec.mock.invocationCallOrder[switchCallIndex] ?? Number.POSITIVE_INFINITY,
		);
	});

	it("rejects PR refs before invoking the injected executor", async () => {
		for (const baseRef of [
			"refs/pull/17/head",
			"FETCH_HEAD",
			"refs/merge-requests/9/head",
			"refs/merge-request/9/head",
			"pull-requests/3/head",
		]) {
			const git = scriptedGit([]);
			await expect(prepareDispatchWorkspace({ orderId: "wo-example", baseRef }, git)).rejects.toMatchObject({
				code: "UNSAFE_BASE_REF",
			} satisfies Partial<DispatchWorkspaceError>);
			expect(git.exec).not.toHaveBeenCalled();
		}
	});

	it("idempotently reuses an already-created expected branch after a first-prepare crash", async () => {
		const git = scriptedGit([
			result(),
			result("base\n"),
			result("branch-ref\n"),
			result("base\n"),
			result(),
			result("gatekeeper/dispatch/wo-example\n"),
		]);

		await expect(prepareDispatchWorkspace({ orderId: "wo-example", baseRef: "main" }, git)).resolves.toEqual({
			branch: "gatekeeper/dispatch/wo-example",
			baseRef: "main",
			baseOid: "base",
		});
		expect(git.exec).toHaveBeenCalledWith(["switch", "gatekeeper/dispatch/wo-example"]);
		expect(git.exec).not.toHaveBeenCalledWith(expect.arrayContaining(["--create"]));
	});

	it("rejects an expected-named pre-existing branch whose tip is not the configured base", async () => {
		const git = scriptedGit([result(), result("base\n"), result("branch-ref\n"), result("other-tip\n")]);

		await expect(prepareDispatchWorkspace({ orderId: "wo-example", baseRef: "main" }, git)).rejects.toMatchObject({
			code: "BRANCH_BASE_MISMATCH",
		});
		expect(git.exec).not.toHaveBeenCalledWith(["switch", "gatekeeper/dispatch/wo-example"]);
	});

	it("refuses to switch a wrong branch when inherited changes make switching unsafe", async () => {
		const git = scriptedGit([result("main\n"), result(" M src/work.ts\n")]);

		await expect(verifyDispatchWorkspaceActive("wo-example", git)).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
		expect(git.exec).not.toHaveBeenCalledWith(["switch", "gatekeeper/dispatch/wo-example"]);
	});

	it("fingerprints tracked and untracked content even when porcelain categories stay unchanged", async () => {
		const git = scriptedGit([
			result("head\n"),
			result(" M tracked.ts\0R  renamed.ts\0?? old-name.ts\0?? z.txt\0?? a.txt\0"),
			result("binary diff payload"),
			result("hash-a\n"),
			result("hash-z\n"),
		]);

		await expect(readWorkspaceFingerprint(git)).resolves.toEqual({
			head: "head",
			porcelain: " M tracked.ts\0R  renamed.ts\0?? old-name.ts\0?? z.txt\0?? a.txt\0",
			trackedDiff: "binary diff payload",
			untracked: [
				{ path: "a.txt", hash: "hash-a" },
				{ path: "z.txt", hash: "hash-z" },
			],
		});
		expect(git.exec).toHaveBeenCalledWith(["diff", "HEAD", "--binary", "--no-ext-diff", "--"]);
		expect(git.exec).toHaveBeenCalledWith(["hash-object", "--no-filters", "--", "a.txt"]);
	});

	it("creates the exact WIP checkpoint commit when changes are present", async () => {
		const git = scriptedGit([result("?? PROGRESS.md\n"), result(), result("[branch abc] wip\n")]);

		await expect(createWipSnapshot("r007", git)).resolves.toEqual({
			hadChanges: true,
			commitCreated: true,
			gitEvidenceAvailable: true,
			commitMessage: "wip: run r007 checkpoint (gatekeeper dispatch)",
		});
		expect(git.exec.mock.calls).toEqual([
			[["status", "--porcelain=v1", "--untracked-files=all"]],
			[["add", "--all", "--", "."]],
			[["commit", "-m", "wip: run r007 checkpoint (gatekeeper dispatch)", "--", "."]],
		]);
	});

	it("degrades a hook/LFS/signing commit failure without blocking rung switching", async () => {
		const git = scriptedGit([result(" M src/work.ts\n"), result(), result("", 1, "signing failed")]);

		await expect(createWipSnapshot("r002", git)).resolves.toEqual({
			hadChanges: true,
			commitCreated: false,
			gitEvidenceAvailable: false,
			commitMessage: "wip: run r002 checkpoint (gatekeeper dispatch)",
			warning: { stage: "commit", message: "WIP snapshot commit failed", stderr: "signing failed" },
		});
	});

	it("also degrades when the injected executor rejects during commit", async () => {
		const git: GitExecutor = {
			exec: vi
				.fn()
				.mockResolvedValueOnce(result(" M src/work.ts\n"))
				.mockResolvedValueOnce(result())
				.mockRejectedValueOnce(new Error("spawn git failed")),
		};

		await expect(createWipSnapshot("r003", git)).resolves.toMatchObject({
			hadChanges: true,
			commitCreated: false,
			gitEvidenceAvailable: false,
			warning: { stage: "commit", stderr: expect.stringContaining("could not be executed") },
		});
	});
});
