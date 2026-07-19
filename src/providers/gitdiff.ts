import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";

import picomatch from "picomatch";

import type { ChangedFile, ChangeStatus, Contract } from "../engine/types.js";

/**
 * Local git data provider. This is the only module in the codebase allowed to
 * shell out via child_process — the engine (src/engine/**) stays pure and I/O
 * free, so all git interaction is confined to this provider layer.
 */

export class GitDiffError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(reason);
		this.name = "GitDiffError";
		this.reason = reason;
		if (options?.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

const MAX_BUFFER = 32 * 1024 * 1024;

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

function execGit(cwd: string, args: string[]): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFileCallback(
			"git",
			["-C", cwd, ...args],
			{ maxBuffer: MAX_BUFFER, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (!error) {
					resolve({ code: 0, stdout, stderr });
					return;
				}
				const execError = error as NodeJS.ErrnoException & { code?: number | string };
				if (typeof execError.code === "number") {
					resolve({ code: execError.code, stdout: stdout ?? "", stderr: stderr ?? "" });
					return;
				}
				// The git executable itself could not be spawned (e.g. not installed).
				resolve({ code: -1, stdout: stdout ?? "", stderr: execError.message });
			},
		);
	});
}

async function requireGit(cwd: string, args: string[], describe: string): Promise<string> {
	const result = await execGit(cwd, args);
	if (result.code !== 0) {
		throw new GitDiffError(`${describe} failed (exit ${result.code}): ${result.stderr.trim() || "no error output"}`);
	}
	return result.stdout;
}

export interface DiffRangeOptions {
	/** Base ref for a three-dot merge-base comparison. Ignored when `staged`/`workingTree` is set. */
	base?: string;
	/** Head ref for a three-dot merge-base comparison. Defaults to HEAD. Ignored when `staged`/`workingTree` is set. */
	head?: string;
	/** Diff the index (staged changes) instead of base...head. */
	staged?: boolean;
	/** Diff HEAD against the working tree (staged + unstaged) instead of base...head. */
	workingTree?: boolean;
}

function diffRangeArgs(options: DiffRangeOptions): string[] {
	if (options.workingTree) {
		return ["HEAD"];
	}
	if (options.staged) {
		return ["--cached"];
	}
	if (!options.base) {
		throw new GitDiffError("a base ref is required unless --staged or --working-tree is set");
	}
	const head = options.head ?? "HEAD";
	return [`${options.base}...${head}`];
}

/** Auto-detect the local base branch (main, falling back to master) unless one is given explicitly. */
export async function resolveBaseRef(cwd: string, explicitBase?: string): Promise<string> {
	if (explicitBase) {
		return explicitBase;
	}
	for (const candidate of ["main", "master"]) {
		const result = await execGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
		if (result.code === 0) {
			return candidate;
		}
	}
	throw new GitDiffError("could not auto-detect base branch (tried main, master); pass --base explicitly");
}

/** Parse `org/name` out of an origin remote URL, supporting both ssh and https forms. */
export function parseRepoFromRemoteUrl(url: string): string | undefined {
	const trimmed = url.trim();
	const sshShorthand = trimmed.match(/^git@[^:]+:(.+?)(\.git)?\/?$/);
	if (sshShorthand?.[1]) {
		return sshShorthand[1];
	}
	const sshUrl = trimmed.match(/^ssh:\/\/git@[^/]+\/(.+?)(\.git)?\/?$/);
	if (sshUrl?.[1]) {
		return sshUrl[1];
	}
	const httpsUrl = trimmed.match(/^https?:\/\/[^/]+\/(.+?)(\.git)?\/?$/);
	if (httpsUrl?.[1]) {
		return httpsUrl[1];
	}
	return undefined;
}

/** Resolve repo identity: explicit --repo wins, otherwise parsed from `git remote get-url origin`. */
export async function resolveRepo(cwd: string, explicitRepo?: string): Promise<string> {
	if (explicitRepo) {
		return explicitRepo;
	}
	const result = await execGit(cwd, ["remote", "get-url", "origin"]);
	if (result.code !== 0) {
		throw new GitDiffError(
			`could not resolve repo identity: git remote get-url origin failed: ${result.stderr.trim()}`,
		);
	}
	const url = result.stdout.trim();
	const parsed = parseRepoFromRemoteUrl(url);
	if (!parsed) {
		throw new GitDiffError(`could not parse repo identity ("org/name") from origin remote URL: ${url}`);
	}
	return parsed;
}

/**
 * Resolve the repository's working-tree root (`git rev-parse --show-toplevel`).
 * Used by `gatekeeper adopt`, which writes `.gatekeeper.yml`/AGENTS.md/CI
 * config/hooks at the repo root regardless of the subdirectory it is invoked
 * from. Throws GitDiffError when `cwd` is not inside a Git working tree.
 */
export async function resolveRepoRoot(cwd: string): Promise<string> {
	const result = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (result.code !== 0) {
		throw new GitDiffError(`not a Git working tree (git rev-parse --show-toplevel failed): ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

/**
 * Resolve the real directory hooks live in (`git rev-parse --git-common-dir`),
 * not `<cwd>/.git`: in a linked worktree checkout, `.git` is a *file*
 * containing a `gitdir:` pointer, not a directory, and hooks are shared from
 * the main working tree's common dir regardless of which worktree a command
 * runs from. Used by `gatekeeper provision`'s pre-push hook installer so it
 * never assumes `<repo>/.git` is a directory it can `mkdir` into.
 */
export async function resolveGitCommonDir(cwd: string): Promise<string> {
	const result = await execGit(cwd, ["rev-parse", "--git-common-dir"]);
	if (result.code !== 0) {
		throw new GitDiffError(
			`could not resolve git common dir (git rev-parse --git-common-dir failed): ${result.stderr.trim()}`,
		);
	}
	const raw = result.stdout.trim();
	return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

/** Resolve actor identity: explicit --actor wins, otherwise `git config user.name` (undefined if unset). */
export async function resolveActor(cwd: string, explicitActor?: string): Promise<string | undefined> {
	if (explicitActor) {
		return explicitActor;
	}
	const result = await execGit(cwd, ["config", "user.name"]);
	if (result.code !== 0) {
		return undefined;
	}
	const name = result.stdout.trim();
	return name.length > 0 ? name : undefined;
}

function normalizeStatus(kind: string): ChangeStatus {
	switch (kind) {
		case "A":
			return "A";
		case "M":
			return "M";
		case "D":
			return "D";
		default:
			// Unhandled status (type change T, unmerged U, broken B, ...): the path
			// did change, so fail closed — normalize to M so contracts still match
			// instead of silently dropping the file (e.g. a guarded file replaced
			// by a symlink reports T and must not bypass the gate).
			process.stderr.write(`gatekeeper: git status "${kind}" normalized to M\n`);
			return "M";
	}
}

/** Parse the -z separated output of `git diff --name-status -M -z`. */
export function parseNameStatusZ(output: string): ChangedFile[] {
	const tokens = output.split("\0").filter((token) => token.length > 0);
	const files: ChangedFile[] = [];
	let index = 0;

	while (index < tokens.length) {
		const statusToken = tokens[index];
		if (statusToken === undefined) {
			break;
		}
		index += 1;
		const kind = statusToken[0];

		if (kind === "R" || kind === "C") {
			const oldPath = tokens[index];
			const newPath = tokens[index + 1];
			index += 2;
			if (oldPath === undefined || newPath === undefined) {
				continue;
			}
			files.push({ path: newPath, oldPath, status: kind });
			continue;
		}

		const filePath = tokens[index];
		index += 1;
		if (filePath === undefined || kind === undefined) {
			continue;
		}
		files.push({ path: filePath, status: normalizeStatus(kind) });
	}

	return files;
}

/** List changed files (no patches attached) for the given range/staged mode. */
export async function getChangedFiles(cwd: string, options: DiffRangeOptions): Promise<ChangedFile[]> {
	const args = ["diff", "--name-status", "-M", "-z", ...diffRangeArgs(options)];
	const output = await requireGit(cwd, args, "git diff --name-status");
	return parseNameStatusZ(output);
}

function collectGlobCandidates(contracts: Contract[]): string[] {
	// Include globs only: a file that hits nothing but an exclude glob can never
	// produce a binding hit, so spawning a git subprocess for its patch is waste.
	const globs = new Set<string>();
	for (const contract of contracts) {
		for (const glob of contract.authority.paths) {
			globs.add(glob);
		}
		for (const consumer of contract.consumers) {
			for (const glob of consumer.paths) {
				globs.add(glob);
			}
		}
	}
	return [...globs];
}

function fileNeedsPatch(file: ChangedFile, globs: string[]): boolean {
	return [file.path, file.oldPath].some(
		(candidate) => candidate !== undefined && globs.some((glob) => picomatch.isMatch(candidate, glob, { dot: true })),
	);
}

const BINARY_MARKER = /^Binary files .* differ$/m;

async function fetchPatch(cwd: string, file: ChangedFile, rangeArgs: string[]): Promise<string | undefined> {
	const oldPath = file.status === "R" || file.status === "C" ? file.oldPath : undefined;
	// Renames/copies need -M plus both pathspecs so git can pair the two sides;
	// a single-path diff would render a pure rename as an all-"+" patch and make
	// if_content contracts falsely match unchanged content.
	const diffArgs =
		oldPath !== undefined
			? ["diff", "-U0", "-M", ...rangeArgs, "--", oldPath, file.path]
			: ["diff", "-U0", ...rangeArgs, "--", file.path];
	const result = await execGit(cwd, diffArgs);
	if (result.code !== 0) {
		// A real command failure must degrade the whole run (fail-open), not
		// silently yield undefined — the engine treats a missing patch as
		// "skipped-no-patch" and counts the file as a hit, which would turn an
		// infrastructure fault into a block.
		throw new GitDiffError(
			`git diff -U0 for ${file.path} failed (exit ${result.code}): ${result.stderr.trim() || "no error output"}`,
		);
	}
	if (BINARY_MARKER.test(result.stdout)) {
		// Binary file: patch is legitimately unavailable.
		return undefined;
	}
	return result.stdout;
}

/**
 * Attach patches only to files that hit the initial glob screen (any contract
 * include glob matches path/oldPath) — avoids pulling full diffs for unrelated files.
 */
export async function attachPatches(
	cwd: string,
	files: ChangedFile[],
	contracts: Contract[],
	options: DiffRangeOptions,
): Promise<ChangedFile[]> {
	const globs = collectGlobCandidates(contracts);
	const rangeArgs = diffRangeArgs(options);
	const result: ChangedFile[] = [];
	for (const file of files) {
		if (!fileNeedsPatch(file, globs)) {
			result.push(file);
			continue;
		}
		const patch = await fetchPatch(cwd, file, rangeArgs);
		result.push({ ...file, patch });
	}
	return result;
}
