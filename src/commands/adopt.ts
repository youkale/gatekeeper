import { realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { stringify } from "yaml";

import { ConfigDiscoveryError, discoverConfig } from "../config/discover.js";
import {
	detectCiProvider,
	loadRepos,
	pathsOverlap,
	type RepoEntry,
	ReposFileError,
	saveRepos,
	upsertRepoEntry,
} from "../config/repos.js";
import { formatRegistryIssue, RegistryParseError } from "../engine/registry.js";
import { LanePresetParseError, LanePresetReadError, loadRegistryWithLanePresets } from "../gate/presets.js";
import { RegistryReadError } from "../providers/fsregistry.js";
import { GitDiffError, resolveRepo, resolveRepoRoot } from "../providers/gitdiff.js";

/**
 * `gatekeeper adopt --control <hub> [target]`: register one repository
 * ("target", defaulting to cwd) with the contract registry that lives
 * inside a "control"/hub checkout. Does exactly two things, both required
 * for every other command's zero-flag config discovery (see
 * src/config/discover.ts) and for `gatekeeper provision`'s batch
 * scaffolding (see src/commands/provision.ts) to work:
 *
 *  1. Write a minimal `.gatekeeper.yml` at the target repo's root.
 *  2. Upsert this repo's entry into `<registry>/repos.yaml`.
 *
 * The registry itself is *located* inside `--control`, not passed directly:
 * `<control>/governance/registry`, `<control>/registry`, then `<control>`
 * itself, in that order, keyed on which one has a `policy.yaml`.
 *
 * Everything else (CI job injection, pre-push hook, AGENTS.md block) lives
 * in `gatekeeper provision`, which fans those actions out across every repo
 * registered here — adopt itself never touches CI config or hooks.
 */

export interface AdoptOptions {
	control: string;
	/** Target repo to adopt; defaults to cwd. Resolved relative to cwd. */
	path?: string;
	/** Explicit repo identity; overrides origin-remote auto-detection for both repos.yaml and the optional .gatekeeper.yml `repo:` override. */
	repo?: string;
	force?: boolean;
}

export interface AdoptDependencies {
	/** Injectable clock for the repos.yaml `adopted_at` timestamp. */
	now?: () => string;
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

/** Store `registry:` relative to the target repo root when possible (portable across checkouts/clones); absolute only when it truly can't be made relative (e.g. a different Windows drive). */
function registryConfigValue(targetRoot: string, registryAbsolute: string): string {
	const relative = path.relative(targetRoot, registryAbsolute);
	if (relative.length === 0) {
		return ".";
	}
	return path.isAbsolute(relative) ? registryAbsolute : relative.split(path.sep).join("/");
}

function renderGatekeeperConfigYaml(config: { registry: string; repo?: string }): string {
	const ordered: Record<string, unknown> = { apiVersion: "gatekeeper/v1", registry: config.registry };
	if (config.repo) {
		ordered.repo = config.repo;
	}
	return stringify(ordered);
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

	let existingRepos: RepoEntry[];
	try {
		existingRepos = await loadRepos(registryAbsolute);
	} catch (error) {
		process.stderr.write(`gatekeeper adopt: ${error instanceof ReposFileError ? error.reason : String(error)}\n`);
		return 2;
	}

	const ci = await detectCiProvider(targetRoot);
	const adoptedAt = (dependencies.now ?? (() => new Date().toISOString()))();
	// Store the same realpath-normalized value the overlap check above used
	// (targetRealPath), not the raw git-toplevel targetRoot: on a symlinked
	// workspace the two can otherwise disagree, so provision's own overlap
	// defense (config/repos.ts's pathsOverlap, which realpaths repos.yaml
	// entries before comparing) and this entry's `path` share one source of
	// truth instead of two independently-normalized values.
	const nextRepos = upsertRepoEntry(existingRepos, { repo, path: targetRealPath, ci, adopted_at: adoptedAt });
	await saveRepos(registryAbsolute, nextRepos);
	process.stdout.write(
		`gatekeeper adopt: registered ${repo} (ci: ${ci}) in ${path.join(registryAbsolute, "repos.yaml")}\n`,
	);

	const configPath = path.join(targetRoot, ".gatekeeper.yml");
	if ((await pathExists(configPath)) && !options.force) {
		// Not silent: an existing .gatekeeper.yml that's already damaged is
		// worth surfacing even though this skip leaves it untouched (only
		// --force rewrites it) -- otherwise a broken config could sit
		// unnoticed until some other command's config-discovery trips on it.
		try {
			await discoverConfig(targetRoot);
		} catch (error) {
			if (!(error instanceof ConfigDiscoveryError)) {
				throw error;
			}
			process.stderr.write(
				`warning: existing ${configPath} could not be parsed (${error.reason}); skipping without overwrite -- rerun with --force to replace it\n`,
			);
		}
		process.stdout.write(`gatekeeper adopt: skipped ${configPath} (already exists; rerun with --force to overwrite)\n`);
		return 0;
	}

	const registryValue = registryConfigValue(targetRoot, registryAbsolute);
	await writeFile(configPath, renderGatekeeperConfigYaml({ registry: registryValue, repo: options.repo }), "utf8");
	process.stdout.write(`gatekeeper adopt: wrote ${configPath}\n`);
	return 0;
}
