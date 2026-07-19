import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseDocument, stringify } from "yaml";
import { z } from "zod";

/**
 * `<registry>/repos.yaml`: the registry-side roster `gatekeeper adopt`
 * appends/updates one entry to, and `gatekeeper provision` reads to fan a
 * batch of local scaffolding actions (CI job, pre-push hook, AGENTS.md
 * block) out across every registered checkout. This file is *workspace*
 * state (local checkout paths), not part of the contract/policy standard
 * surface — `readRegistryFiles`/`parseRegistry` never read it (they only
 * look at policy.yaml and contracts/*.yaml).
 */

export const REPOS_FILENAME = "repos.yaml";

export class ReposFileError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(reason);
		this.name = "ReposFileError";
		this.reason = reason;
		if (options?.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

export interface RepoEntry {
	repo: string;
	/** Absolute local checkout path on the machine that ran `adopt` — see the file header comment written by saveRepos. */
	path: string;
	ci: "gitlab" | "github" | "none";
	/** ISO timestamp, injected by the caller's clock (see AdoptDependencies.now) — never computed here. */
	adopted_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
	return isRecord(error) && (error as { code?: unknown }).code === "ENOENT";
}

const KNOWN_ENTRY_KEYS = new Set(["repo", "path", "ci", "adopted_at"]);
const KNOWN_ROOT_KEYS = new Set(["apiVersion", "repos"]);

function rejectUnknownKeys(value: unknown, known: Set<string>, context: z.RefinementCtx): void {
	if (!isRecord(value)) {
		return;
	}
	for (const key of Object.keys(value)) {
		if (known.has(key) || key.startsWith("x-")) {
			continue;
		}
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: [key],
			message: `Unknown key "${key}"`,
		});
	}
}

const repoEntrySchema = z.preprocess(
	(value, context) => {
		rejectUnknownKeys(value, KNOWN_ENTRY_KEYS, context);
		return value;
	},
	z
		.object({
			repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be an org/name repository identity"),
			path: z.string().min(1),
			ci: z.enum(["gitlab", "github", "none"]),
			adopted_at: z.string().min(1),
		})
		.passthrough(),
);

const reposFileSchema = z.preprocess(
	(value, context) => {
		rejectUnknownKeys(value, KNOWN_ROOT_KEYS, context);
		return value;
	},
	z
		.object({
			apiVersion: z.literal("gatekeeper/v1"),
			repos: z.array(repoEntrySchema).default([]),
		})
		.passthrough(),
);

function reposFilePath(registryDir: string): string {
	return path.join(registryDir, REPOS_FILENAME);
}

/** Missing repos.yaml is the ordinary "no repo adopted into this registry yet" state, not an error. A file that exists but fails to parse/validate always throws (fail-loud config damage). */
export async function loadRepos(registryDir: string): Promise<RepoEntry[]> {
	const filePath = reposFilePath(registryDir);
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			return [];
		}
		throw new ReposFileError(`failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}

	const document = parseDocument(content, { prettyErrors: false, uniqueKeys: true });
	if (document.errors.length > 0) {
		throw new ReposFileError(`${filePath}: invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`);
	}
	let value: unknown;
	try {
		value = document.toJS();
	} catch (error) {
		throw new ReposFileError(`${filePath}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}

	const parsed = reposFileSchema.safeParse(value);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const location = issue && issue.path.length > 0 ? `$.${issue.path.join(".")}` : "$";
		throw new ReposFileError(`${filePath}: ${location}: ${issue?.message ?? "invalid repos.yaml"}`);
	}
	return parsed.data.repos as RepoEntry[];
}

/** Identity key is `repo` (org/name), not `path`: re-adopting the same repo from a moved checkout updates the existing entry instead of appending a duplicate. */
export function upsertRepoEntry(entries: readonly RepoEntry[], entry: RepoEntry): RepoEntry[] {
	const next = entries.filter((existing) => existing.repo !== entry.repo);
	next.push(entry);
	next.sort((left, right) => left.repo.localeCompare(right.repo));
	return next;
}

const REPOS_FILE_HEADER =
	"# This file is workspace-specific: `path` values are local checkout paths\n" +
	"# on the machine that ran `gatekeeper adopt`. After cloning this registry\n" +
	"# onto a different machine, re-run `gatekeeper adopt` for each repo again\n" +
	"# so its `path` entry points at the new checkout.\n";

export async function saveRepos(registryDir: string, entries: readonly RepoEntry[]): Promise<void> {
	const body = stringify({ apiVersion: "gatekeeper/v1", repos: entries });
	await writeFile(reposFilePath(registryDir), `${REPOS_FILE_HEADER}${body}`, "utf8");
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await stat(candidate);
		return true;
	} catch {
		return false;
	}
}

/** `.gitlab-ci.yml` wins if a repo somehow has both (unusual, but not worth failing adopt over); no marker of either present is "none". */
export async function detectCiProvider(repoRoot: string): Promise<RepoEntry["ci"]> {
	if (await pathExists(path.join(repoRoot, ".gitlab-ci.yml"))) {
		return "gitlab";
	}
	if (await pathExists(path.join(repoRoot, ".github", "workflows"))) {
		return "github";
	}
	return "none";
}

function hasPathBoundary(parent: string, child: string): boolean {
	if (parent === child) {
		return true;
	}
	// Boundary-aware: "/a/b" must not be considered a parent of "/a/bc" just
	// because the raw string is a prefix -- only a full path-segment match counts.
	const withSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
	return child.startsWith(withSep);
}

/**
 * True when `a` and `b` are identical or one is nested inside the other.
 * Callers are responsible for normalizing both inputs first (realpath) so
 * e.g. a `/tmp` vs `/private/tmp` symlink difference on macOS can't produce
 * a false negative. Used both by `adopt` (control repo vs target repo) and
 * `provision` (control repo vs each registered repos.yaml entry, defending
 * against a hand-edited repos.yaml registering the control repo itself).
 */
export function pathsOverlap(a: string, b: string): boolean {
	return hasPathBoundary(a, b) || hasPathBoundary(b, a);
}
