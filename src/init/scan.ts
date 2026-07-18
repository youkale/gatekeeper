import type { Dirent, Stats } from "node:fs";
import { access, constants as fsConstants, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Deterministic, zero-model, zero-network signal scanner for `gatekeeper init`.
 *
 * This walks a set of local repo checkouts on disk and produces a candidate
 * list of cross-repo "contract-shaped" signals: shared schema files, CI
 * config lines that pin an image tag, constants (HTTP header names, URL path
 * prefixes, env var names) that repeat across >=2 repos, and manifest/deploy
 * files. Recall is expected to be medium by design (regex heuristics, no
 * language-level AST) -- every candidate is meant for human review via
 * `src/init/brief.ts`, not auto-adoption.
 */

export type SignalType = "schema-file" | "ci-config" | "shared-constant" | "manifest";

export type ConstantKind = "http-header" | "url-prefix" | "env-var";

export interface ConstantMatch {
	kind: ConstantKind;
	value: string;
}

export interface Signal {
	type: SignalType;
	repo: string;
	path: string;
	/** Up to MAX_EXCERPT_LINES lines, each truncated to MAX_LINE_LENGTH characters. */
	excerpt: string[];
	/** Only present for type: "shared-constant" -- the matched value and its sub-kind. */
	match?: ConstantMatch;
}

export interface ScanSkipCounts {
	/** Distinct files that could not be read at all (permission error, race, ...). */
	unreadable: number;
	/** Distinct files skipped because they exceeded MAX_FILE_SIZE_BYTES for full-content scanning. */
	oversized: number;
}

export interface ScanResult {
	repos: string[];
	/** Basenames that collided across the --repos inputs and were disambiguated in `repos`/signal.repo. */
	repoLabelCollisions: string[];
	signals: Signal[];
	skipped: ScanSkipCounts;
}

export const MAX_EXCERPT_LINES = 3;
export const MAX_LINE_LENGTH = 200;

/** Files larger than this are skipped for full-content scanning (ci-config line matching, shared-constant regex extraction). */
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

/** Bounded prefix read for schema-file/manifest excerpts: filename alone is enough to classify these, so a
 * multi-megabyte file never needs a full read just to show its first few lines. */
const EXCERPT_PREFIX_READ_BYTES = 8 * 1024;

export interface RepoAccessIssue {
	/** The path as resolved from the caller's --repos argument. */
	root: string;
	reason: string;
}

export class RepoAccessError extends Error {
	readonly issues: RepoAccessIssue[];

	constructor(issues: RepoAccessIssue[]) {
		super(`repo path(s) not accessible: ${issues.map((issue) => `${issue.root} (${issue.reason})`).join("; ")}`);
		this.name = "RepoAccessError";
		this.issues = issues;
	}
}

// Directories that are never descended into. ".github" is the one dot-directory
// exception (workflows live under it) -- every other dot-directory (.git,
// .cache, .vscode, ...) and node_modules are skipped outright.
const ALWAYS_SKIP_DIRS = new Set(["node_modules"]);
const DOT_DIR_EXCEPTION = ".github";

function shouldDescend(dirName: string): boolean {
	if (ALWAYS_SKIP_DIRS.has(dirName)) {
		return false;
	}
	if (dirName === DOT_DIR_EXCEPTION) {
		return true;
	}
	if (dirName.startsWith(".")) {
		return false;
	}
	return true;
}

interface FileEntry {
	/** Path relative to the repo root, using "/" separators regardless of platform. */
	relPath: string;
	absPath: string;
}

function describeFsError(error: unknown): string {
	const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
	if (code === "ENOENT") {
		return "no such file or directory";
	}
	if (code === "EACCES" || code === "EPERM") {
		return "permission denied";
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Lists every file under `root` (already access-checked by resolveRepoTargets). The root's own
 * `readdir` is *not* caught here: if it fails despite the up-front R_OK|X_OK precheck (a race --
 * permissions revoked, directory removed between check and walk, or a filesystem quirk the precheck
 * couldn't see), that must surface as a hard RepoAccessError, not a silently "successful" empty/partial
 * scan. Only *sub*-directory readdir failures encountered mid-walk are skipped, since those are much
 * more likely to be an ordinary "one weird nested dir" case than a sign the whole repo is unusable.
 */
async function listFiles(root: string): Promise<FileEntry[]> {
	const results: FileEntry[] = [];

	let rootEntries: Dirent[];
	try {
		rootEntries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		throw new RepoAccessError([{ root, reason: describeFsError(error) }]);
	}

	async function walk(dir: string, entries: Dirent[]): Promise<void> {
		for (const entry of entries) {
			const absPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (shouldDescend(entry.name)) {
					let subEntries: Dirent[];
					try {
						subEntries = await readdir(absPath, { withFileTypes: true });
					} catch {
						// Unreadable sub-directory (permissions, race with a concurrent delete, ...):
						// skip just this branch rather than aborting the whole scan.
						continue;
					}
					await walk(absPath, subEntries);
				}
				continue;
			}
			if (entry.isFile()) {
				results.push({ absPath, relPath: path.relative(root, absPath).split(path.sep).join("/") });
			}
		}
	}

	await walk(root, rootEntries);
	return results.sort((left, right) => left.relPath.localeCompare(right.relPath));
}

/**
 * Untrusted file content can legitimately contain literal NUL bytes (binary-ish files, or a crafted
 * input). Strip them at this shared boundary -- the one place both the full-content read path and the
 * bounded-prefix read path funnel through before any Signal is built -- so a NUL byte from a scanned
 * repo can never reach ScanResult, scan.json, or init-brief.md and turn our own output into "binary"
 * the same way an unescaped NUL in our own source turned a file into "binary" (same failure mode, this
 * time on the data path instead of the source-code path).
 */
function stripNulBytes(text: string): string {
	return text.split("\u0000").join("");
}

function truncateLine(line: string): string {
	const withoutTrailingCr = line.endsWith("\r") ? line.slice(0, -1) : line;
	return withoutTrailingCr.length > MAX_LINE_LENGTH
		? `${withoutTrailingCr.slice(0, MAX_LINE_LENGTH)}…`
		: withoutTrailingCr;
}

function excerptFromLines(lines: string[]): string[] {
	return lines.slice(0, MAX_EXCERPT_LINES).map(truncateLine);
}

type ReadOutcome = { kind: "ok"; content: string } | { kind: "oversized" } | { kind: "unreadable" };

/** Full-content read, gated on MAX_FILE_SIZE_BYTES. Used where the whole file must be scanned (ci-config line
 * matching, shared-constant regex extraction). */
async function readFullFile(absPath: string): Promise<ReadOutcome> {
	let metadata: Awaited<ReturnType<typeof stat>>;
	try {
		metadata = await stat(absPath);
	} catch {
		return { kind: "unreadable" };
	}
	if (!metadata.isFile()) {
		return { kind: "unreadable" };
	}
	if (metadata.size > MAX_FILE_SIZE_BYTES) {
		return { kind: "oversized" };
	}
	try {
		const content = await readFile(absPath, "utf8");
		return { kind: "ok", content: stripNulBytes(content) };
	} catch {
		return { kind: "unreadable" };
	}
}

/** Bounded prefix read: reads at most EXCERPT_PREFIX_READ_BYTES regardless of file size, so a schema/manifest
 * file identified purely by filename always yields an excerpt without a full read. A multi-byte UTF-8
 * character straddling the boundary may render as a replacement character; that is an accepted trade-off
 * for a first-few-lines excerpt. */
async function readExcerptPrefix(absPath: string): Promise<string | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(absPath, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(EXCERPT_PREFIX_READ_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, EXCERPT_PREFIX_READ_BYTES, 0);
		return stripNulBytes(buffer.subarray(0, bytesRead).toString("utf8"));
	} catch {
		return undefined;
	} finally {
		await handle.close();
	}
}

// -- Schema files ------------------------------------------------------------

const SCHEMA_FILE_PATTERNS = [/\.schema\.json$/i, /^openapi.*\.ya?ml$/i, /\.proto$/i, /\.graphql$/i];

function isSchemaFile(basename: string): boolean {
	return SCHEMA_FILE_PATTERNS.some((pattern) => pattern.test(basename));
}

// -- Manifest / deploy files --------------------------------------------------

const MANIFEST_FILE_PATTERNS = [
	/^package\.json$/i,
	/\.manifest\.[^.]+$/i,
	/^deploy(?:ment)?\.ya?ml$/i,
	/^manifest\.ya?ml$/i,
];

function isManifestFile(basename: string): boolean {
	return MANIFEST_FILE_PATTERNS.some((pattern) => pattern.test(basename));
}

// -- CI config -----------------------------------------------------------------

const WORKFLOW_FILE_PATTERN = /\.ya?ml$/i;
const IMAGE_TAG_LINE_PATTERN = /\b(?:image|tag)\s*:\s*\S+/i;

function isWorkflowFile(relPath: string): boolean {
	return relPath.startsWith(".github/workflows/") && WORKFLOW_FILE_PATTERN.test(path.basename(relPath));
}

// -- Shared constants across repos ---------------------------------------------

// Extensions eligible for constant extraction. Deliberately excludes .json to
// keep noise down (dependency/version strings produce spurious matches).
const CONSTANT_SCAN_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".java",
	".rb",
	".rs",
	".yml",
	".yaml",
	".md",
	".txt",
	".env",
	".sh",
	".toml",
	".cfg",
	".ini",
	".proto",
	".graphql",
]);
const CONSTANT_SCAN_BASENAMES = new Set(["Dockerfile", "Makefile", ".env", ".env.example"]);

function isConstantScanCandidate(basename: string): boolean {
	if (CONSTANT_SCAN_BASENAMES.has(basename)) {
		return true;
	}
	return CONSTANT_SCAN_EXTENSIONS.has(path.extname(basename).toLowerCase());
}

const HTTP_HEADER_PATTERN = /\bX-[A-Za-z][A-Za-z-]*\b/g;
const ENV_VAR_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const URL_PREFIX_PATTERN = /["'](\/[a-zA-Z][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9_-]+)*)["']/g;

function normalizeUrlPrefix(raw: string): string {
	const segments = raw.split("/").filter((segment) => segment.length > 0);
	return `/${segments.slice(0, 2).join("/")}`;
}

function extractLineMatches(line: string): ConstantMatch[] {
	const matches: ConstantMatch[] = [];
	for (const match of line.matchAll(HTTP_HEADER_PATTERN)) {
		matches.push({ kind: "http-header", value: match[0] });
	}
	for (const match of line.matchAll(ENV_VAR_PATTERN)) {
		matches.push({ kind: "env-var", value: match[0] });
	}
	for (const match of line.matchAll(URL_PREFIX_PATTERN)) {
		const captured = match[1];
		if (captured) {
			matches.push({ kind: "url-prefix", value: normalizeUrlPrefix(captured) });
		}
	}
	return matches;
}

interface ConstantOccurrence {
	/** Canonical resolved repo root -- the identity used for the >=2-repo intersection rule. */
	repoKey: string;
	/** Display label for this occurrence's repo (disambiguated if basenames collided). */
	repoLabel: string;
	relPath: string;
	kind: ConstantKind;
	value: string;
	lines: string[];
}

function constantKey(kind: ConstantKind, value: string): string {
	return [kind, value].join(":");
}

function occurrenceKey(occurrence: ConstantOccurrence): string {
	return [occurrence.repoKey, occurrence.relPath, constantKey(occurrence.kind, occurrence.value)].join(":");
}

function collectConstantOccurrences(
	repoKey: string,
	repoLabel: string,
	entry: FileEntry,
	content: string,
): ConstantOccurrence[] {
	const lines = content.split("\n");
	const byKey = new Map<string, ConstantOccurrence>();

	for (const line of lines) {
		for (const match of extractLineMatches(line)) {
			const key = constantKey(match.kind, match.value);
			let occurrence = byKey.get(key);
			if (!occurrence) {
				occurrence = { repoKey, repoLabel, relPath: entry.relPath, kind: match.kind, value: match.value, lines: [] };
				byKey.set(key, occurrence);
			}
			if (occurrence.lines.length < MAX_EXCERPT_LINES) {
				occurrence.lines.push(line);
			}
		}
	}

	return [...byKey.values()];
}

// -- Repo target resolution (identity + display-label disambiguation) ----------

interface RepoTarget {
	/** Canonical resolved absolute path (post-realpath) -- used for walking the filesystem and for
	 * deriving the display label. Not used as the intersection/de-dup identity: see RepoTarget.identityKey. */
	canonicalPath: string;
	/** dev:ino of the canonical path -- the identity used for the >=2-repo intersection rule and for
	 * de-duplication. realpath() alone still doesn't collapse every alias (e.g. some bind mounts present
	 * as ordinary directories, not symlinks), so identity is pinned to the physical device+inode pair
	 * rather than to any path string. */
	identityKey: string;
	/** Display label (repo basename, disambiguated by parent directory on collision). */
	label: string;
}

interface ResolvedRepoInput {
	canonicalPath: string;
	identityKey: string;
}

/**
 * Validates and resolves a single --repos argument: exists, is a directory, and is both readable *and*
 * searchable (R_OK|X_OK -- a directory with read but no execute/search permission lets `readdir` list
 * names while every subsequent stat/open inside it fails, which must not be discovered file-by-file
 * after the fact), then resolves it to a realpath and a dev+inode identity pair.
 */
async function resolveRepoInput(originalPath: string): Promise<{ ok: ResolvedRepoInput } | { issue: RepoAccessIssue }> {
	const displayRoot = path.resolve(originalPath);

	let metadata: Stats;
	try {
		metadata = await stat(displayRoot);
	} catch (error) {
		return { issue: { root: displayRoot, reason: describeFsError(error) } };
	}
	if (!metadata.isDirectory()) {
		return { issue: { root: displayRoot, reason: "not a directory" } };
	}
	try {
		await access(displayRoot, fsConstants.R_OK | fsConstants.X_OK);
	} catch {
		return { issue: { root: displayRoot, reason: "permission denied" } };
	}

	let canonicalPath: string;
	try {
		canonicalPath = await realpath(displayRoot);
	} catch (error) {
		return { issue: { root: displayRoot, reason: `failed to resolve real path: ${describeFsError(error)}` } };
	}

	let canonicalMetadata: Stats;
	try {
		canonicalMetadata = await stat(canonicalPath);
	} catch (error) {
		return { issue: { root: displayRoot, reason: `failed to stat real path: ${describeFsError(error)}` } };
	}

	return { ok: { canonicalPath, identityKey: `${canonicalMetadata.dev}:${canonicalMetadata.ino}` } };
}

/**
 * Resolves every --repos argument to a canonical path and a physical dev+inode identity (collapsing
 * symlink aliases, case differences resolved by realpath, and macOS-style firmlink prefixes such as
 * /Users/... vs /System/Volumes/Data/Users/... that name the same physical checkout), then assigns a
 * display label. Two different *physical* directories that happen to share a basename (e.g. two
 * checkouts both named "svc") must not silently merge into one label -- that would both under-count the
 * intersection rule and produce an unreadable brief with two identical repo headings.
 */
async function resolveRepoTargets(
	repoPaths: string[],
): Promise<{ targets: RepoTarget[]; collisions: string[]; issues: RepoAccessIssue[] }> {
	const issues: RepoAccessIssue[] = [];
	const resolutions: ResolvedRepoInput[] = [];
	for (const repoPath of repoPaths) {
		const result = await resolveRepoInput(repoPath);
		if ("issue" in result) {
			issues.push(result.issue);
		} else {
			resolutions.push(result.ok);
		}
	}
	if (issues.length > 0) {
		return { targets: [], collisions: [], issues };
	}

	// De-dup by physical identity, not by path string: two different --repos arguments that resolve to
	// the same dev+inode are the same repo and must produce exactly one target.
	const byIdentity = new Map<string, ResolvedRepoInput>();
	for (const resolution of resolutions) {
		if (!byIdentity.has(resolution.identityKey)) {
			byIdentity.set(resolution.identityKey, resolution);
		}
	}
	const uniqueResolutions = [...byIdentity.values()];

	const basenameCounts = new Map<string, number>();
	for (const resolution of uniqueResolutions) {
		const basename = path.basename(resolution.canonicalPath);
		basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
	}
	const collisions = [...basenameCounts.entries()]
		.filter(([, count]) => count > 1)
		.map(([basename]) => basename)
		.sort();

	const usedLabels = new Set<string>();
	const targets: RepoTarget[] = uniqueResolutions.map((resolution) => {
		const basename = path.basename(resolution.canonicalPath);
		if ((basenameCounts.get(basename) ?? 0) <= 1) {
			usedLabels.add(basename);
			return { canonicalPath: resolution.canonicalPath, identityKey: resolution.identityKey, label: basename };
		}
		const parent = path.basename(path.dirname(resolution.canonicalPath)) || resolution.canonicalPath;
		let label = `${basename} (${parent})`;
		let attempt = 2;
		while (usedLabels.has(label)) {
			label = `${basename} (${parent}-${attempt})`;
			attempt += 1;
		}
		usedLabels.add(label);
		return { canonicalPath: resolution.canonicalPath, identityKey: resolution.identityKey, label };
	});

	return { targets, collisions, issues: [] };
}

// -- Top-level scan --------------------------------------------------------------

interface SkipTracker {
	unreadable: Set<string>;
	oversized: Set<string>;
}

/**
 * Scan a set of local repo checkouts and return the candidate signal list.
 * Deterministic and read-only: no network access, no model calls, no writes.
 *
 * Throws RepoAccessError (rather than silently returning an empty result) if
 * any --repos path does not exist, is not a directory, or is not readable --
 * `gatekeeper init` is a local authoring tool, not a merge gate, so a
 * mis-typed path must fail loudly instead of producing an empty brief.
 */
export async function scanRepos(repoPaths: string[]): Promise<ScanResult> {
	const { targets, collisions, issues } = await resolveRepoTargets(repoPaths);
	if (issues.length > 0) {
		throw new RepoAccessError(issues);
	}

	const signals: Signal[] = [];
	const allOccurrences: ConstantOccurrence[] = [];
	const skip: SkipTracker = { unreadable: new Set(), oversized: new Set() };

	for (const target of targets) {
		const entries = await listFiles(target.canonicalPath);

		for (const entry of entries) {
			const basename = path.basename(entry.relPath);

			if (isSchemaFile(basename)) {
				const prefix = await readExcerptPrefix(entry.absPath);
				if (prefix !== undefined) {
					signals.push({
						type: "schema-file",
						repo: target.label,
						path: entry.relPath,
						excerpt: excerptFromLines(prefix.split("\n")),
					});
				} else {
					skip.unreadable.add(entry.absPath);
				}
			}

			if (isManifestFile(basename)) {
				const prefix = await readExcerptPrefix(entry.absPath);
				if (prefix !== undefined) {
					signals.push({
						type: "manifest",
						repo: target.label,
						path: entry.relPath,
						excerpt: excerptFromLines(prefix.split("\n")),
					});
				} else {
					skip.unreadable.add(entry.absPath);
				}
			}

			if (isWorkflowFile(entry.relPath)) {
				const outcome = await readFullFile(entry.absPath);
				if (outcome.kind === "ok") {
					const matchedLines = outcome.content.split("\n").filter((line) => IMAGE_TAG_LINE_PATTERN.test(line));
					if (matchedLines.length > 0) {
						signals.push({
							type: "ci-config",
							repo: target.label,
							path: entry.relPath,
							excerpt: excerptFromLines(matchedLines),
						});
					}
				} else if (outcome.kind === "oversized") {
					skip.oversized.add(entry.absPath);
				} else {
					skip.unreadable.add(entry.absPath);
				}
			}

			if (isConstantScanCandidate(basename)) {
				const outcome = await readFullFile(entry.absPath);
				if (outcome.kind === "ok") {
					allOccurrences.push(...collectConstantOccurrences(target.identityKey, target.label, entry, outcome.content));
				} else if (outcome.kind === "oversized") {
					skip.oversized.add(entry.absPath);
				} else {
					skip.unreadable.add(entry.absPath);
				}
			}
		}
	}

	// A constant only becomes a signal once it is observed in >=2 distinct repos,
	// keyed by canonical repo root (never by display label, which may be shared
	// by unrelated repos before disambiguation is applied above).
	const reposByConstant = new Map<string, Set<string>>();
	for (const occurrence of allOccurrences) {
		const key = constantKey(occurrence.kind, occurrence.value);
		const repos = reposByConstant.get(key) ?? new Set<string>();
		repos.add(occurrence.repoKey);
		reposByConstant.set(key, repos);
	}

	const seenOccurrenceKeys = new Set<string>();
	for (const occurrence of allOccurrences) {
		const key = constantKey(occurrence.kind, occurrence.value);
		if ((reposByConstant.get(key)?.size ?? 0) < 2) {
			continue;
		}
		const dedupeKey = occurrenceKey(occurrence);
		if (seenOccurrenceKeys.has(dedupeKey)) {
			continue;
		}
		seenOccurrenceKeys.add(dedupeKey);
		signals.push({
			type: "shared-constant",
			repo: occurrence.repoLabel,
			path: occurrence.relPath,
			excerpt: excerptFromLines(occurrence.lines),
			match: { kind: occurrence.kind, value: occurrence.value },
		});
	}

	return {
		repos: targets.map((target) => target.label),
		repoLabelCollisions: collisions,
		signals,
		skipped: { unreadable: skip.unreadable.size, oversized: skip.oversized.size },
	};
}
