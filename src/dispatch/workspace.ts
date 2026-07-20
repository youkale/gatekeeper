import type { GitExecutionResult, GitExecutor } from "./evidence.js";

export const DISPATCH_BRANCH_PREFIX = "gatekeeper/dispatch/";

export type DispatchWorkspaceErrorCode =
	| "DIRTY_WORKTREE"
	| "UNSAFE_BASE_REF"
	| "UNSAFE_BRANCH_REF"
	| "BASE_NOT_FOUND"
	| "BRANCH_CREATE_FAILED"
	| "BRANCH_NOT_FOUND"
	| "BRANCH_BASE_MISMATCH"
	| "BRANCH_HEAD_MISMATCH"
	| "WRONG_BRANCH"
	| "GIT_FAILED";

export class DispatchWorkspaceError extends Error {
	readonly code: DispatchWorkspaceErrorCode;
	readonly command?: readonly string[];
	readonly stderr?: string;

	constructor(
		code: DispatchWorkspaceErrorCode,
		message: string,
		details: { command?: readonly string[]; stderr?: string; cause?: unknown } = {},
	) {
		super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
		this.name = "DispatchWorkspaceError";
		this.code = code;
		this.command = details.command;
		this.stderr = details.stderr;
	}
}

export interface PrepareWorkspaceInput {
	readonly orderId: string;
	readonly baseRef: string;
	/** Resume an already-delivered dispatch branch instead of creating this order's branch. */
	readonly reuseBranch?: ReuseDispatchBranch;
	/** Called after resolving the immutable base commit and before any branch mutation. */
	readonly onBaseResolved?: (baseOid: string) => void | Promise<void>;
}

export interface ReuseDispatchBranch {
	readonly branch: string;
}

export interface PreparedWorkspace {
	readonly branch: string;
	readonly baseRef: string;
	readonly baseOid: string;
}

export interface WorkspaceFingerprint {
	readonly head: string;
	readonly porcelain: string;
	readonly trackedDiff: string;
	readonly untracked: readonly { readonly path: string; readonly hash: string }[];
}

export interface WipSnapshotResult {
	readonly hadChanges: boolean;
	readonly commitCreated: boolean;
	/** False means handoff must omit all git evidence for this transition. */
	readonly gitEvidenceAvailable: boolean;
	readonly commitMessage?: string;
	readonly warning?: {
		readonly stage: "add" | "commit";
		readonly message: string;
		readonly stderr: string;
	};
}

function commandText(args: readonly string[]): string {
	return `git ${args.join(" ")}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function execute(git: GitExecutor, args: readonly string[]): Promise<GitExecutionResult> {
	try {
		return await git.exec(args);
	} catch (error) {
		throw new DispatchWorkspaceError("GIT_FAILED", `${commandText(args)} could not be executed`, {
			command: args,
			cause: error,
		});
	}
}

function requireSuccess(
	result: GitExecutionResult,
	args: readonly string[],
	code: Exclude<DispatchWorkspaceErrorCode, "DIRTY_WORKTREE" | "UNSAFE_BASE_REF" | "GIT_FAILED">,
): void {
	if (result.exitCode === 0) {
		return;
	}
	throw new DispatchWorkspaceError(code, `${commandText(args)} exited ${result.exitCode}`, {
		command: args,
		stderr: result.stderr,
	});
}

/**
 * Dispatch accepts configured local base names and commit ids, but never PR
 * refs. This syntactic check runs before any git command so a hostile or
 * mistaken base cannot turn the workspace protocol into a PR-head checkout.
 */
export function assertSafeDispatchBaseRef(baseRef: string): void {
	const normalized = baseRef.toLowerCase();
	const unsafeSyntax =
		baseRef.length === 0 ||
		baseRef.startsWith("-") ||
		!/^[a-zA-Z0-9._/-]+$/.test(baseRef) ||
		baseRef.includes("..") ||
		baseRef.includes("@{") ||
		baseRef.includes("//") ||
		baseRef.endsWith("/") ||
		baseRef.endsWith(".") ||
		baseRef.endsWith(".lock");
	const pullRef =
		normalized === "fetch_head" ||
		normalized.startsWith("refs/pull/") ||
		normalized.startsWith("pull/") ||
		normalized.includes("/refs/pull/") ||
		normalized.includes("/pull/") ||
		normalized.includes("merge-request") ||
		normalized.includes("merge_requests") ||
		normalized.includes("pull-request") ||
		normalized.includes("pull_requests");
	if (unsafeSyntax || pullRef) {
		throw new DispatchWorkspaceError(
			"UNSAFE_BASE_REF",
			`dispatch base ref is not a safe local configured base: ${baseRef}`,
		);
	}
}

/** Review fix dispatches may only resume a dedicated, already-local dispatch branch. */
export function assertSafeDispatchBranchRef(branch: string): void {
	const unsafeSyntax =
		!branch.startsWith(DISPATCH_BRANCH_PREFIX) ||
		branch.length === DISPATCH_BRANCH_PREFIX.length ||
		branch.startsWith("-") ||
		!/^[a-zA-Z0-9._/-]+$/.test(branch) ||
		branch.includes("..") ||
		branch.includes("@{") ||
		branch.includes("//") ||
		branch.endsWith("/") ||
		branch.endsWith(".") ||
		branch.endsWith(".lock");
	if (unsafeSyntax) {
		throw new DispatchWorkspaceError(
			"UNSAFE_BRANCH_REF",
			`dispatch reuse branch is not a safe local ${DISPATCH_BRANCH_PREFIX} ref: ${branch}`,
		);
	}
}

export async function verifyCleanWorkspace(git: GitExecutor): Promise<void> {
	const args = ["status", "--porcelain=v1", "--untracked-files=all"] as const;
	const result = await execute(git, args);
	if (result.exitCode !== 0) {
		throw new DispatchWorkspaceError("GIT_FAILED", `${commandText(args)} exited ${result.exitCode}`, {
			command: args,
			stderr: result.stderr,
		});
	}
	if (result.stdout.length > 0) {
		throw new DispatchWorkspaceError("DIRTY_WORKTREE", "target checkout has uncommitted changes", {
			command: args,
			stderr: result.stdout,
		});
	}
}

/** Verify cleanliness before creating the dedicated order branch. */
export async function prepareDispatchWorkspace(
	input: PrepareWorkspaceInput,
	git: GitExecutor,
): Promise<PreparedWorkspace> {
	assertSafeDispatchBaseRef(input.baseRef);
	await verifyCleanWorkspace(git);
	if (input.reuseBranch) {
		assertSafeDispatchBranchRef(input.reuseBranch.branch);
	}

	const baseOid = await resolveDispatchBaseOid(input.baseRef, git);
	await input.onBaseResolved?.(baseOid);
	if (input.reuseBranch) {
		return prepareReusedDispatchWorkspace(input, input.reuseBranch, baseOid, git);
	}

	const branch = `${DISPATCH_BRANCH_PREFIX}${input.orderId}`;
	const branchRef = `refs/heads/${branch}`;
	const existsArgs = ["show-ref", "--verify", "--quiet", branchRef] as const;
	const exists = await execute(git, existsArgs);
	if (exists.exitCode !== 0 && exists.exitCode !== 1) {
		throw new DispatchWorkspaceError("GIT_FAILED", `${commandText(existsArgs)} exited ${exists.exitCode}`, {
			command: existsArgs,
			stderr: exists.stderr,
		});
	}
	if (exists.exitCode === 0) {
		const branchTipArgs = ["rev-parse", "--verify", "--quiet", `${branchRef}^{commit}`] as const;
		const branchTip = await execute(git, branchTipArgs);
		if (branchTip.exitCode !== 0) {
			throw new DispatchWorkspaceError("BRANCH_NOT_FOUND", `expected dispatch branch ${branch} is not a commit`, {
				command: branchTipArgs,
				stderr: branchTip.stderr,
			});
		}
		if (branchTip.stdout.trim() !== baseOid) {
			throw new DispatchWorkspaceError(
				"BRANCH_BASE_MISMATCH",
				`existing dispatch branch ${branch} does not point at configured base ${input.baseRef}`,
				{ command: branchTipArgs },
			);
		}
	}
	const switchArgs =
		exists.exitCode === 0
			? (["switch", branch] as const)
			: (["switch", "--no-track", "--create", branch, baseOid] as const);
	const switched = await execute(git, switchArgs);
	requireSuccess(switched, switchArgs, "BRANCH_CREATE_FAILED");
	await verifyDispatchWorkspaceActive(input.orderId, git);
	return { branch, baseRef: input.baseRef, baseOid };
}

async function prepareReusedDispatchWorkspace(
	input: PrepareWorkspaceInput,
	reuseBranch: ReuseDispatchBranch,
	baseOid: string,
	git: GitExecutor,
): Promise<PreparedWorkspace> {
	const branch = reuseBranch.branch;
	const branchRef = `refs/heads/${branch}`;
	const existsArgs = ["show-ref", "--verify", "--quiet", branchRef] as const;
	const exists = await execute(git, existsArgs);
	if (exists.exitCode === 1) {
		throw new DispatchWorkspaceError("BRANCH_NOT_FOUND", `dispatch reuse branch ${branch} does not exist`, {
			command: existsArgs,
			stderr: exists.stderr,
		});
	}
	if (exists.exitCode !== 0) {
		throw new DispatchWorkspaceError("GIT_FAILED", `${commandText(existsArgs)} exited ${exists.exitCode}`, {
			command: existsArgs,
			stderr: exists.stderr,
		});
	}

	const branchTipArgs = ["rev-parse", "--verify", "--quiet", `${branchRef}^{commit}`] as const;
	const branchTip = await execute(git, branchTipArgs);
	requireSuccess(branchTip, branchTipArgs, "BRANCH_NOT_FOUND");
	const branchTipOid = branchTip.stdout.trim();
	if (branchTipOid.length === 0) {
		throw new DispatchWorkspaceError("BRANCH_NOT_FOUND", `dispatch reuse branch ${branch} is not a commit`, {
			command: branchTipArgs,
		});
	}

	const currentHeadArgs = ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"] as const;
	const currentHead = await execute(git, currentHeadArgs);
	requireSuccess(currentHead, currentHeadArgs, "BRANCH_NOT_FOUND");
	const currentHeadOid = currentHead.stdout.trim();
	const headReachableArgs = ["merge-base", "--is-ancestor", currentHeadOid, branchTipOid] as const;
	const headReachable = await execute(git, headReachableArgs);
	if (headReachable.exitCode === 1) {
		throw new DispatchWorkspaceError(
			"BRANCH_HEAD_MISMATCH",
			`current HEAD is not reachable from dispatch reuse branch ${branch}`,
			{ command: headReachableArgs, stderr: headReachable.stderr },
		);
	}
	if (headReachable.exitCode !== 0) {
		throw new DispatchWorkspaceError(
			"GIT_FAILED",
			`${commandText(headReachableArgs)} exited ${headReachable.exitCode}`,
			{
				command: headReachableArgs,
				stderr: headReachable.stderr,
			},
		);
	}

	const baseReachableArgs = ["merge-base", "--is-ancestor", baseOid, branchTipOid] as const;
	const baseReachable = await execute(git, baseReachableArgs);
	if (baseReachable.exitCode === 1) {
		throw new DispatchWorkspaceError(
			"BRANCH_BASE_MISMATCH",
			`dispatch reuse branch ${branch} does not contain configured base ${input.baseRef}`,
			{ command: baseReachableArgs, stderr: baseReachable.stderr },
		);
	}
	if (baseReachable.exitCode !== 0) {
		throw new DispatchWorkspaceError(
			"GIT_FAILED",
			`${commandText(baseReachableArgs)} exited ${baseReachable.exitCode}`,
			{
				command: baseReachableArgs,
				stderr: baseReachable.stderr,
			},
		);
	}

	const switchArgs = ["switch", branch] as const;
	const switched = await execute(git, switchArgs);
	requireSuccess(switched, switchArgs, "BRANCH_CREATE_FAILED");
	await verifyDispatchWorkspaceActive(input.orderId, git, reuseBranch);
	return { branch, baseRef: input.baseRef, baseOid };
}

export async function resolveDispatchBaseOid(baseRef: string, git: GitExecutor): Promise<string> {
	assertSafeDispatchBaseRef(baseRef);
	const verifyArgs = ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`] as const;
	const verified = await execute(git, verifyArgs);
	requireSuccess(verified, verifyArgs, "BASE_NOT_FOUND");
	const oid = verified.stdout.trim();
	if (oid.length === 0) {
		throw new DispatchWorkspaceError("BASE_NOT_FOUND", `configured base ${baseRef} did not resolve to a commit`, {
			command: verifyArgs,
		});
	}
	return oid;
}

export async function verifyDispatchWorkspaceActive(
	orderId: string,
	git: GitExecutor,
	reuseBranch?: ReuseDispatchBranch,
): Promise<void> {
	if (reuseBranch) {
		assertSafeDispatchBranchRef(reuseBranch.branch);
	}
	const expected = reuseBranch?.branch ?? `${DISPATCH_BRANCH_PREFIX}${orderId}`;
	const branchArgs = ["symbolic-ref", "--quiet", "--short", "HEAD"] as const;
	let branch = await execute(git, branchArgs);
	if (branch.exitCode === 0 && branch.stdout.trim() === expected) {
		return;
	}

	const statusArgs = ["status", "--porcelain=v1", "--untracked-files=all"] as const;
	const status = await execute(git, statusArgs);
	if (status.exitCode !== 0) {
		throw new DispatchWorkspaceError("GIT_FAILED", `${commandText(statusArgs)} exited ${status.exitCode}`, {
			command: statusArgs,
			stderr: status.stderr,
		});
	}
	if (status.stdout.length > 0) {
		throw new DispatchWorkspaceError(
			"DIRTY_WORKTREE",
			`cannot switch from ${branch.stdout.trim() || "detached HEAD"} to ${expected} with a dirty worktree`,
			{ command: statusArgs, stderr: status.stdout },
		);
	}

	const branchRef = `refs/heads/${expected}`;
	const existsArgs = ["show-ref", "--verify", "--quiet", branchRef] as const;
	const exists = await execute(git, existsArgs);
	if (exists.exitCode !== 0) {
		throw new DispatchWorkspaceError("BRANCH_NOT_FOUND", `expected dispatch branch ${expected} does not exist`, {
			command: existsArgs,
			stderr: exists.stderr,
		});
	}
	const switchArgs = ["switch", expected] as const;
	const switched = await execute(git, switchArgs);
	if (switched.exitCode !== 0) {
		throw new DispatchWorkspaceError("WRONG_BRANCH", `failed to activate dispatch branch ${expected}`, {
			command: switchArgs,
			stderr: switched.stderr,
		});
	}
	branch = await execute(git, branchArgs);
	if (branch.exitCode !== 0 || branch.stdout.trim() !== expected) {
		throw new DispatchWorkspaceError("WRONG_BRANCH", `git did not activate dispatch branch ${expected}`, {
			command: branchArgs,
			stderr: branch.stderr,
		});
	}
}

export async function readWorkspaceHead(git: GitExecutor): Promise<string> {
	const args = ["rev-parse", "--verify", "HEAD"] as const;
	const result = await execute(git, args);
	if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
		throw new DispatchWorkspaceError("GIT_FAILED", `${commandText(args)} did not resolve HEAD`, {
			command: args,
			stderr: result.stderr,
		});
	}
	return result.stdout.trim();
}

export async function readWorkspaceFingerprint(git: GitExecutor): Promise<WorkspaceFingerprint> {
	const [head, status, trackedDiff] = await Promise.all([
		readWorkspaceHead(git),
		execute(git, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
		execute(git, ["diff", "HEAD", "--binary", "--no-ext-diff", "--"]),
	]);
	if (status.exitCode !== 0) {
		throw new DispatchWorkspaceError("GIT_FAILED", "git status could not fingerprint the workspace", {
			command: ["status", "--porcelain=v1", "--untracked-files=all"],
			stderr: status.stderr,
		});
	}
	if (trackedDiff.exitCode !== 0) {
		throw new DispatchWorkspaceError("GIT_FAILED", "git diff could not fingerprint tracked workspace content", {
			command: ["diff", "HEAD", "--binary", "--no-ext-diff", "--"],
			stderr: trackedDiff.stderr,
		});
	}
	const records = status.stdout.split("\0");
	const untrackedPaths: string[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index] ?? "";
		if (record.startsWith("?? ")) {
			untrackedPaths.push(record.slice(3));
			continue;
		}
		const statusCode = record.slice(0, 2);
		if (statusCode.includes("R") || statusCode.includes("C")) {
			index += 1;
		}
	}
	untrackedPaths.sort((left, right) => left.localeCompare(right));
	const untracked: { path: string; hash: string }[] = [];
	for (const untrackedPath of untrackedPaths) {
		const hashed = await execute(git, ["hash-object", "--no-filters", "--", untrackedPath]);
		if (hashed.exitCode !== 0 || hashed.stdout.trim().length === 0) {
			throw new DispatchWorkspaceError("GIT_FAILED", `could not fingerprint untracked file ${untrackedPath}`, {
				command: ["hash-object", "--no-filters", "--", untrackedPath],
				stderr: hashed.stderr,
			});
		}
		untracked.push({ path: untrackedPath, hash: hashed.stdout.trim() });
	}
	return { head, porcelain: status.stdout, trackedDiff: trackedDiff.stdout, untracked };
}

/**
 * Snapshot every tracked/untracked change under the injected executor's
 * repository. Hook/LFS/signing (and staging) failures are deliberately
 * returned as degraded evidence rather than blocking the next agent rung.
 */
export async function createWipSnapshot(runId: string, git: GitExecutor): Promise<WipSnapshotResult> {
	const statusArgs = ["status", "--porcelain=v1", "--untracked-files=all"] as const;
	const status = await execute(git, statusArgs);
	if (status.exitCode !== 0) {
		throw new DispatchWorkspaceError("GIT_FAILED", `${commandText(statusArgs)} exited ${status.exitCode}`, {
			command: statusArgs,
			stderr: status.stderr,
		});
	}
	if (status.stdout.length === 0) {
		return { hadChanges: false, commitCreated: false, gitEvidenceAvailable: true };
	}

	const addArgs = ["add", "--all", "--", "."] as const;
	let added: GitExecutionResult;
	try {
		added = await execute(git, addArgs);
	} catch (error) {
		return {
			hadChanges: true,
			commitCreated: false,
			gitEvidenceAvailable: false,
			warning: { stage: "add", message: "WIP snapshot staging failed", stderr: errorMessage(error) },
		};
	}
	if (added.exitCode !== 0) {
		return {
			hadChanges: true,
			commitCreated: false,
			gitEvidenceAvailable: false,
			warning: { stage: "add", message: "WIP snapshot staging failed", stderr: added.stderr },
		};
	}

	const commitMessage = `wip: run ${runId} checkpoint (gatekeeper dispatch)`;
	const commitArgs = ["commit", "-m", commitMessage, "--", "."] as const;
	let committed: GitExecutionResult;
	try {
		committed = await execute(git, commitArgs);
	} catch (error) {
		return {
			hadChanges: true,
			commitCreated: false,
			gitEvidenceAvailable: false,
			commitMessage,
			warning: { stage: "commit", message: "WIP snapshot commit failed", stderr: errorMessage(error) },
		};
	}
	if (committed.exitCode !== 0) {
		return {
			hadChanges: true,
			commitCreated: false,
			gitEvidenceAvailable: false,
			commitMessage,
			warning: { stage: "commit", message: "WIP snapshot commit failed", stderr: committed.stderr },
		};
	}
	return { hadChanges: true, commitCreated: true, gitEvidenceAvailable: true, commitMessage };
}
