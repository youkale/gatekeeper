import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { ControlsIndexError, upsertControl } from "../config/controls.js";
import { detectCiProvider, pathsOverlap, ReposFileError, upsertRepo } from "../config/repos.js";
import { formatRegistryIssue, RegistryParseError } from "../engine/registry.js";
import { LanePresetParseError, LanePresetReadError, loadRegistryWithLanePresets } from "../gate/presets.js";
import { RegistryReadError } from "../providers/fsregistry.js";
import { GitDiffError, resolveRepo, resolveRepoRoot } from "../providers/gitdiff.js";

/**
 * `gatekeeper adopt --control <hub> [target]`: register one repository
 * ("target", defaulting to cwd) with the contract registry that lives
 * inside a "control"/hub checkout. This command has **zero touch** on the
 * target repo in the sense that matters: it never writes to or modifies any
 * file inside it (it does *read* a couple of marker files there --
 * `.gitlab-ci.yml` / `.github/workflows` -- purely to auto-detect the CI
 * provider for the roster entry below; see detectCiProvider). It does
 * exactly two things, both host-machine state outside any git checkout:
 *
 *  1. Upsert this machine's user-level controls index
 *     (`~/.config/gatekeeper/controls.yaml`, see src/config/controls.ts)
 *     with this control repo's root and located registry directory --
 *     first, and only proceeding to (2) once it succeeds, so a controls-
 *     index write failure (e.g. an unwritable ~/.config) never leaves a
 *     half-registered repo.yaml entry that reverse discovery can't find.
 *  2. Upsert this repo's entry into `<registry>/repos.yaml` (inside the
 *     control repo) via `upsertRepo` (src/config/repos.ts) -- its own
 *     load-modify-save round trip runs under a same-directory lock file so a
 *     concurrent `adopt` against the same registry can't interleave and
 *     silently lose either writer's update, and its underlying write is
 *     itself atomic (write-then-rename, see saveRepos's own doc comment) so
 *     an interruption mid-write can never truncate/corrupt the roster. A
 *     failure here (e.g. a permissions problem on the registry checkout) is
 *     caught and reported as an explicit exit 2, not a bare rejection -- the
 *     controls-index entry from (1) is left in place either way (harmless
 *     and idempotent; re-running `adopt` finishes the job).
 *
 * Together, (1) and (2) are what every other command's zero-flag config
 * discovery (src/config/discover.ts's fifth priority tier,
 * discoverConfigWithControlsIndex) walks backwards through at run time: from
 * a bare `cwd` inside the target repo, find its git root, look it up in the
 * controls index to find the owning control, then look that control's
 * repos.yaml up to confirm the repo identity -- without ever needing a
 * `.gatekeeper.yml` written into the target repo. A repo can still opt into
 * an explicit `.gatekeeper.yml` (e.g. a hub self-configuring itself, or a
 * user who wants a portable, git-tracked override) -- see discover.ts's
 * priority chain, where an explicit file always wins over the index.
 *
 * The registry itself is *located* inside `--control`, not passed directly:
 * `<control>/governance/registry`, `<control>/registry`, then `<control>`
 * itself, in that order, keyed on which one has a `policy.yaml`.
 *
 * Everything else (CI job injection, pre-push hook, AGENTS.md block) lives
 * in `gatekeeper provision`, which fans those actions out across every repo
 * registered here — adopt itself never touches CI config or hooks either.
 */

export interface AdoptOptions {
	control: string;
	/** Target repo to adopt; defaults to cwd. Resolved relative to cwd. */
	path?: string;
	/** Explicit repo identity; overrides origin-remote auto-detection in repos.yaml. */
	repo?: string;
}

export interface AdoptDependencies {
	/** Injectable clock for the repos.yaml `adopted_at` / controls index `registered_at` timestamp. */
	now?: () => string;
	/** Process (or injected) environment; only GATEKEEPER_CONFIG_DIR is consulted (controls index location). */
	env?: NodeJS.ProcessEnv;
}

const REGISTRY_CANDIDATE_SUBPATHS = ["governance/registry", "registry", "."];

function describeRegistryError(error: unknown): string {
	if (error instanceof RegistryParseError) {
		return error.issues.map(formatRegistryIssue).join("; ");
	}
	if (error instanceof RegistryReadError || error instanceof LanePresetReadError) {
		return error.reason;
	}
	if (error instanceof LanePresetParseError) {
		return error.issues.map((issue) => `${issue.file} ${issue.path}: ${issue.message}`).join("; ");
	}
	return error instanceof Error ? error.message : String(error);
}

function describeControlsIndexError(error: unknown): string {
	if (error instanceof ControlsIndexError) {
		return error.reason;
	}
	return error instanceof Error ? error.message : String(error);
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await stat(candidate);
		return true;
	} catch {
		return false;
	}
}

/** Probe the three conventional registry locations inside a control repo, in order, keyed on the presence of policy.yaml. Returns null (with the caller responsible for listing the tried candidates) when none match. */
async function locateRegistry(controlRoot: string): Promise<string | null> {
	for (const sub of REGISTRY_CANDIDATE_SUBPATHS) {
		const candidate = path.resolve(controlRoot, sub);
		if (await pathExists(path.join(candidate, "policy.yaml"))) {
			return candidate;
		}
	}
	return null;
}

function registryCandidates(controlRoot: string): string[] {
	return REGISTRY_CANDIDATE_SUBPATHS.map((sub) => path.resolve(controlRoot, sub));
}

export async function runAdopt(
	options: AdoptOptions,
	cwd: string,
	dependencies: AdoptDependencies = {},
): Promise<number> {
	const targetInput = path.resolve(cwd, options.path ?? ".");
	let targetRoot: string;
	try {
		targetRoot = await resolveRepoRoot(targetInput);
	} catch (error) {
		process.stderr.write(`gatekeeper adopt: ${error instanceof GitDiffError ? error.reason : String(error)}\n`);
		return 2;
	}

	let controlRoot: string;
	try {
		controlRoot = await realpath(path.resolve(cwd, options.control));
	} catch (error) {
		process.stderr.write(
			`gatekeeper adopt: --control ${options.control} is not accessible: ` +
				`${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 2;
	}

	let targetRealPath: string;
	try {
		targetRealPath = await realpath(targetRoot);
	} catch (error) {
		process.stderr.write(
			`gatekeeper adopt: failed to resolve target repo path ${targetRoot}: ` +
				`${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 2;
	}

	if (pathsOverlap(controlRoot, targetRealPath)) {
		process.stderr.write(
			`gatekeeper adopt: target repo ${targetRealPath} overlaps with control repo ${controlRoot}; a repo must not ` +
				"be identical to, contain, or be nested inside the control repo. A control repo governs itself through " +
				"its own self-gate workflow, not through `gatekeeper adopt`.\n",
		);
		return 2;
	}

	const registryAbsolute = await locateRegistry(controlRoot);
	if (!registryAbsolute) {
		process.stderr.write(
			`gatekeeper adopt: could not locate a registry (a directory containing policy.yaml) under control repo ` +
				`${controlRoot}; tried:\n${registryCandidates(controlRoot)
					.map((candidate) => `  ${candidate}\n`)
					.join("")}`,
		);
		return 2;
	}

	try {
		await loadRegistryWithLanePresets(registryAbsolute);
	} catch (error) {
		process.stderr.write(
			`gatekeeper adopt: registry at ${registryAbsolute} is not valid: ${describeRegistryError(error)}\n`,
		);
		return 2;
	}

	let repo: string;
	try {
		repo = await resolveRepo(targetRoot, options.repo);
	} catch (error) {
		process.stderr.write(
			`gatekeeper adopt: could not resolve a repo identity for ${targetRoot} ` +
				`(${error instanceof GitDiffError ? error.reason : String(error)}); pass --repo org/name explicitly\n`,
		);
		return 2;
	}

	const ci = await detectCiProvider(targetRoot);
	const now = dependencies.now ?? (() => new Date().toISOString());
	const adoptedAt = now();

	// Register (upsert) the controls index *before* touching repos.yaml, and
	// bail (exit 2, roster untouched) if it fails: this is what makes the two
	// writes below effectively atomic from the operator's point of view. The
	// old order (repos.yaml first, controls index second) could leave a
	// half-registered repo behind on a controls-index write failure (e.g. an
	// unwritable ~/.config/gatekeeper) -- repos.yaml already updated and a
	// success message already printed, but reverse discovery (src/config/
	// discover.ts's discoverConfigWithControlsIndex) still can't find it from
	// inside the repo, with no error surfaced anywhere. Zero-touch on
	// targetRoot either way: nothing under it is read, written, or even
	// stat'd beyond what resolveRepoRoot/detectCiProvider already needed
	// above -- the controls index and repos.yaml are both host-machine-local
	// state outside any git checkout.
	const registryRealPath = await realpath(registryAbsolute);
	try {
		await upsertControl(
			{ control: controlRoot, registry: registryRealPath, registered_at: adoptedAt },
			dependencies.env ?? process.env,
		);
	} catch (error) {
		process.stderr.write(
			`gatekeeper adopt: could not register control ${controlRoot} in the local controls index: ` +
				`${describeControlsIndexError(error)}\n`,
		);
		return 2;
	}
	process.stdout.write(`gatekeeper adopt: registered control ${controlRoot} in the local controls index\n`);

	// Store the same realpath-normalized value the overlap check above used
	// (targetRealPath), not the raw git-toplevel targetRoot: on a symlinked
	// workspace the two can otherwise disagree, so provision's own overlap
	// defense (config/repos.ts's pathsOverlap, which realpaths repos.yaml
	// entries before comparing) and this entry's `path` share one source of
	// truth instead of two independently-normalized values.
	//
	// upsertRepo (src/config/repos.ts) does the whole load-modify-save round
	// trip itself, under a same-directory lock file so a concurrent `adopt`
	// against the same registry can't interleave with this one and silently
	// lose either writer's update (see its own doc comment).
	try {
		await upsertRepo(registryAbsolute, { repo, path: targetRealPath, ci, adopted_at: adoptedAt });
	} catch (error) {
		if (error instanceof ReposFileError) {
			// An existing repos.yaml that fails to parse/validate -- a real
			// configuration defect, unrelated to the controls-index entry
			// registered just above (left in place either way; harmless and
			// idempotent to re-register on a rerun once this is fixed).
			process.stderr.write(`gatekeeper adopt: ${error.reason}\n`);
			return 2;
		}
		// Not a bare rejection: the controls index above already succeeded (and
		// is left as-is -- upserting it again on a rerun is idempotent, and
		// saveRepos itself writes atomically, see its own doc comment, so this
		// failure never leaves a truncated repos.yaml behind either). Surface
		// this loudly and exit 2 rather than let the process crash uncaught.
		process.stderr.write(
			`gatekeeper adopt: could not write ${path.join(registryAbsolute, "repos.yaml")}: ` +
				`${error instanceof Error ? error.message : String(error)}; the controls index entry registered above is ` +
				"unaffected and harmless -- rerun `gatekeeper adopt` once the underlying problem is fixed to finish registering this repo.\n",
		);
		return 2;
	}
	process.stdout.write(
		`gatekeeper adopt: registered ${repo} (ci: ${ci}) in ${path.join(registryAbsolute, "repos.yaml")}\n`,
	);
	return 0;
}
