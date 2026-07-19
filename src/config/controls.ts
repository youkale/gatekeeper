import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { parseDocument, stringify } from "yaml";
import { z } from "zod";

import { withFileLock } from "./filelock.js";
import { loadRepos } from "./repos.js";

/**
 * `~/.config/gatekeeper/controls.yaml`: the *user-level* index that makes
 * `gatekeeper adopt`'s target-repo footprint zero (see src/commands/adopt.ts's
 * header comment) while still letting every other command's zero-flag config
 * discovery (src/config/discover.ts) find "which control/registry governs the
 * repo I'm standing in" *without* a `.gatekeeper.yml` written into that repo.
 *
 * This file lives outside any git checkout on purpose -- it is host-machine
 * state, one step further removed than `<registry>/repos.yaml` (which is
 * itself already host-checkout-path state, see that file's header comment).
 * Re-running `gatekeeper adopt`/`gatekeeper init-control` on a new machine
 * naturally repopulates it; nothing here is meant to be committed or synced.
 *
 * Every entry is keyed by `control` (a control/hub repo root), stored as a
 * realpath so symlinked checkouts and case/trailing-slash variance collapse
 * onto one entry instead of accumulating duplicates. `registry` is also a
 * realpath (the located registry directory inside that control repo) so
 * `locateOwningControl` below can hand back an absolute, ready-to-use path
 * without the caller needing to re-resolve anything.
 */

export const CONTROLS_INDEX_FILENAME = "controls.yaml";

export class ControlsIndexError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(reason);
		this.name = "ControlsIndexError";
		this.reason = reason;
		if (options?.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

export interface ControlEntry {
	/** Control/hub repo root, realpath-normalized. */
	control: string;
	/** Located registry directory (containing policy.yaml) inside `control`, realpath-normalized. */
	registry: string;
	/** ISO timestamp, injected by the caller's clock -- never computed here (same convention as RepoEntry.adopted_at). */
	registered_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
	return isRecord(error) && (error as { code?: unknown }).code === "ENOENT";
}

const KNOWN_ENTRY_KEYS = new Set(["control", "registry", "registered_at"]);
const KNOWN_ROOT_KEYS = new Set(["apiVersion", "controls"]);

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

const controlEntrySchema = z.preprocess(
	(value, context) => {
		rejectUnknownKeys(value, KNOWN_ENTRY_KEYS, context);
		return value;
	},
	z
		.object({
			control: z.string().min(1),
			registry: z.string().min(1),
			registered_at: z.string().min(1),
		})
		.passthrough(),
);

const controlsIndexSchema = z.preprocess(
	(value, context) => {
		rejectUnknownKeys(value, KNOWN_ROOT_KEYS, context);
		return value;
	},
	z
		.object({
			apiVersion: z.literal("gatekeeper/v1"),
			controls: z.array(controlEntrySchema).default([]),
		})
		.passthrough(),
);

/**
 * Resolve the directory `controls.yaml` lives in: `GATEKEEPER_CONFIG_DIR`
 * when set (the injection point every test in this codebase must use --
 * never the real `~/.config/gatekeeper`), otherwise `~/.config/gatekeeper`.
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.GATEKEEPER_CONFIG_DIR;
	if (override) {
		return override;
	}
	return path.join(homedir(), ".config", "gatekeeper");
}

function controlsIndexPath(env: NodeJS.ProcessEnv): string {
	return path.join(resolveConfigDir(env), CONTROLS_INDEX_FILENAME);
}

/** Missing controls.yaml is the ordinary "no control registered on this machine yet" state, not an error. A file that exists but fails to parse/validate always throws (fail-loud config damage). */
export async function loadControlsIndex(env: NodeJS.ProcessEnv = process.env): Promise<ControlEntry[]> {
	const filePath = controlsIndexPath(env);
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			return [];
		}
		throw new ControlsIndexError(
			`failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}

	const document = parseDocument(content, { prettyErrors: false, uniqueKeys: true });
	if (document.errors.length > 0) {
		throw new ControlsIndexError(`${filePath}: invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`);
	}
	let value: unknown;
	try {
		value = document.toJS();
	} catch (error) {
		throw new ControlsIndexError(
			`${filePath}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			},
		);
	}

	const parsed = controlsIndexSchema.safeParse(value);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const location = issue && issue.path.length > 0 ? `$.${issue.path.join(".")}` : "$";
		throw new ControlsIndexError(`${filePath}: ${location}: ${issue?.message ?? "invalid controls.yaml"}`);
	}
	return parsed.data.controls as ControlEntry[];
}

const CONTROLS_INDEX_HEADER =
	"# This file is host-machine state, not part of any git checkout: it maps\n" +
	"# control/hub repo roots (registered by `gatekeeper adopt` / `gatekeeper\n" +
	"# init-control`) to their registry directory, so every other command's\n" +
	"# zero-flag config discovery can find \"which control governs the repo I'm\n" +
	'# standing in" without a .gatekeeper.yml written into that repo. Safe to\n' +
	"# delete -- re-run `gatekeeper adopt`/`gatekeeper init-control` to rebuild it.\n";

/**
 * Atomic write (temp file in the same directory, then `rename()` over the
 * target): a crash/interruption mid-write must never leave a truncated
 * controls.yaml behind. `locateOwningControl` below treats a damaged index
 * as a fail-loud `ControlsIndexError`/`ConfigDiscoveryError` for *every*
 * repo on this machine whose zero-flag config discovery walks through it --
 * not just the control being registered right now -- so a partial write
 * here has a machine-wide blast radius (every adopted repo's reverse
 * discovery degrades/fails until the file is fixed), the same class of risk
 * `saveRepos` (src/config/repos.ts) guards against for the same reason.
 * `rename()` within one directory is atomic on every filesystem Node
 * targets, so a reader only ever observes the fully-written old or new
 * content, never a partial one.
 */
export async function saveControlsIndex(
	entries: readonly ControlEntry[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const filePath = controlsIndexPath(env);
	await mkdir(path.dirname(filePath), { recursive: true });
	const body = stringify({ apiVersion: "gatekeeper/v1", controls: entries });
	const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	await writeFile(tmpPath, `${CONTROLS_INDEX_HEADER}${body}`, "utf8");
	await rename(tmpPath, filePath);
}

/** Identity key is `control` (the control repo root), not `registry`: re-registering the same control repo (e.g. a rerun of `init-control`, or `adopt` against the same hub) updates the existing entry instead of appending a duplicate. */
export function upsertControlEntry(entries: readonly ControlEntry[], entry: ControlEntry): ControlEntry[] {
	const next = entries.filter((existing) => existing.control !== entry.control);
	next.push(entry);
	next.sort((left, right) => left.control.localeCompare(right.control));
	return next;
}

/**
 * Load, upsert, and persist one control entry in a single call -- the shape
 * every registration call site (`adopt`, `init-control`) actually wants.
 *
 * The whole read-modify-write round trip runs under a same-directory lock
 * file (`<controls.yaml>.lock`, see src/config/filelock.ts): without it, two
 * concurrent invocations (e.g. a batch script running `gatekeeper adopt`
 * against several repos at once, or `adopt` racing `init-control`) could
 * both load the same "before" state, then each save back only their own
 * entry -- the second write silently discarding the first writer's update.
 */
export async function upsertControl(
	entry: ControlEntry,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ControlEntry[]> {
	const lockPath = `${controlsIndexPath(env)}.lock`;
	return withFileLock(lockPath, async () => {
		const existing = await loadControlsIndex(env);
		const next = upsertControlEntry(existing, entry);
		await saveControlsIndex(next, env);
		return next;
	});
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await stat(candidate);
		return true;
	} catch {
		return false;
	}
}

export interface LocateOwningControlWarning {
	kind: "stale-control" | "multi-claim";
	message: string;
}

export interface LocateOwningControlMatch {
	registry: string;
	/**
	 * `undefined` for a self-match (`repoRootRealPath` *is* a registered
	 * control's own root, e.g. a hub running `doctor`/`provision` against
	 * itself) -- there is no `repos.yaml` roster entry to take a repo identity
	 * from in that case. Callers that need a repo identity (most commands, via
	 * `resolveRepo`'s git-remote fallback) already tolerate an absent
	 * `config.repo` from discovery; this is the same shape.
	 */
	repo?: string;
}

export interface LocateOwningControlResult {
	match: LocateOwningControlMatch | null;
	warnings: LocateOwningControlWarning[];
}

/**
 * Reverse-discovery lookup: given a repo root's realpath, walk the controls
 * index (in registration order) and, for each control whose repo root still
 * exists on disk, load its `repos.yaml` roster and check whether any entry's
 * `path` (itself already realpath-normalized by `gatekeeper adopt`, see
 * adopt.ts) matches. A stale index entry (control repo root no longer
 * present -- e.g. deleted, or registered on a different machine) is skipped
 * rather than failing the whole lookup; a `repos.yaml` that fails to
 * parse/load for a control whose root *does* exist is a real configuration
 * defect and is re-thrown (`ReposFileError`) rather than silently skipped --
 * callers apply their own fail-direction handling to that (see
 * src/config/discover.ts's discoverConfigWithControlsIndex, which wraps it
 * into a ConfigDiscoveryError so every existing call site's fail-open/
 * fail-loud branch already handles it without new code).
 *
 * A control repo never adopts *itself* into its own `repos.yaml` (adopt
 * refuses overlapping control/target repos -- see adopt.ts's overlap check),
 * so `repoRootRealPath` equal to an index entry's `control` never produces a
 * `repos.yaml` hit above. Without a separate self-match branch, running e.g.
 * `doctor`/`provision` from inside a freshly `init-control`'d hub -- with
 * zero flags, zero `.gatekeeper.yml` -- would silently fail to find its own
 * registry, defeating `init-control`'s own self-registration (see its doc
 * comment). So: an entry whose `control` equals `repoRootRealPath` is also
 * recorded as a *self-match* (registry only, no repo identity -- there is no
 * roster entry to take one from). A `repos.yaml` hit always outranks a
 * self-match for the same lookup when both exist (e.g. some other control's
 * roster happens to also list this control repo as one of its managed
 * repos) -- self-match is the fallback, not a competing claim.
 *
 * When more than one control's `repos.yaml` claims the same repo (two
 * independently registered hubs both adopted it), the first match in index
 * order wins and a `multi-claim` warning is returned -- unlike the
 * `stale-control` case, this warning is never dropped by callers, gating or
 * otherwise, since it signals a real ambiguity in the operator's own setup.
 * A self-match can never itself be multi-claimed: the controls index is
 * keyed on `control` (see upsertControlEntry), so at most one entry can have
 * `control === repoRootRealPath`.
 */
export async function locateOwningControl(
	repoRootRealPath: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<LocateOwningControlResult> {
	const entries = await loadControlsIndex(env);
	const warnings: LocateOwningControlWarning[] = [];
	const repoMatchClaims: Array<{ control: string; registry: string; repo: string }> = [];
	let selfMatch: { registry: string } | null = null;

	for (const entry of entries) {
		if (!(await pathExists(entry.control))) {
			warnings.push({
				kind: "stale-control",
				message:
					`control repo ${entry.control} (from the controls index) no longer exists on disk; skipping -- ` +
					"re-run `gatekeeper adopt`/`gatekeeper init-control` from that machine, or remove the stale entry",
			});
			continue;
		}

		// A damaged repos.yaml for a control whose root does exist is re-thrown as-is
		// (ReposFileError) -- see the doc comment above for why this is deliberate.
		const repos = await loadRepos(entry.registry);

		const match = repos.find((repoEntry) => repoEntry.path === repoRootRealPath);
		if (match) {
			repoMatchClaims.push({ control: entry.control, registry: entry.registry, repo: match.repo });
			continue;
		}
		if (entry.control === repoRootRealPath) {
			selfMatch = { registry: entry.registry };
		}
	}

	if (repoMatchClaims.length > 0) {
		if (repoMatchClaims.length > 1) {
			warnings.push({
				kind: "multi-claim",
				message:
					`repo ${repoRootRealPath} is registered under multiple controls (${repoMatchClaims.map((claim) => claim.control).join(", ")}); ` +
					`using the first entry in the controls index (${repoMatchClaims[0]?.control})`,
			});
		}
		const winner = repoMatchClaims[0];
		if (winner) {
			return { match: { registry: winner.registry, repo: winner.repo }, warnings };
		}
	}

	if (selfMatch) {
		return { match: { registry: selfMatch.registry }, warnings };
	}

	return { match: null, warnings };
}
