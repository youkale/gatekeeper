import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	ConfigDiscoveryError,
	type DiscoveredConfig,
	discoverConfigWithControlsIndex,
	missingRegistryMessage,
	resolveRegistryOption,
} from "../config/discover.js";
import { loadRepos, pathsOverlap, type RepoEntry, ReposFileError } from "../config/repos.js";
import { GitDiffError, resolveGitCommonDir, resolveRepoRoot } from "../providers/gitdiff.js";

/**
 * `gatekeeper provision`: fan the local scaffolding actions that used to
 * live in `gatekeeper adopt` (CI job injection, pre-push hook, AGENTS.md
 * instruction block) out across every repo registered in
 * `<registry>/repos.yaml` (see `gatekeeper adopt`) — run from anywhere the
 * registry can be discovered (see src/config/discover.ts), typically a
 * "hub" checkout that has every other repo checked out as a sibling.
 *
 * Every write is idempotent (marker-block upsert) or --force-protected
 * (never silently clobbers content it doesn't own) — same invariants the
 * old single-repo `adopt --ci/--hooks/--agents-md` had, just applied
 * per-registered-repo instead of to the repo `adopt` itself runs in.
 */

export interface ProvisionOptions {
	/** Optional repo-name filter (org/name); empty/undefined means "every registered repo". */
	repos?: string[];
	registry?: string;
	ci?: boolean;
	hooks?: boolean;
	agentsMd?: boolean;
	dryRun?: boolean;
	force?: boolean;
}

export interface ProvisionDependencies {
	env?: NodeJS.ProcessEnv;
}

interface RepoOutcome {
	repo: string;
	lines: string[];
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await stat(candidate);
		return true;
	} catch {
		return false;
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Idempotent marker-block upsert: replace an existing `startMarker..endMarker` span in place, or append the block (with a blank-line separator) when no marker is present yet. Shared by AGENTS.md and .gitlab-ci.yml so a rerun never accumulates duplicate blocks and never touches content it doesn't own. */
export function upsertMarkerBlock(content: string, startMarker: string, endMarker: string, block: string): string {
	const pattern = new RegExp(`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`);
	if (pattern.test(content)) {
		return content.replace(pattern, block);
	}
	const trimmed = content.replace(/\s+$/, "");
	return trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

const AGENTS_MD_START = "<!-- gatekeeper:adopt -->";
const AGENTS_MD_END = "<!-- /gatekeeper:adopt -->";

function agentsMdBlock(): string {
	return [
		AGENTS_MD_START,
		"## Gatekeeper contract gate",
		"",
		"This repository is governed by Gatekeeper (see `.gatekeeper.yml`). Before finishing any change, run:",
		"",
		"```bash",
		"gatekeeper check --working-tree --explain",
		"```",
		"",
		"A `block` verdict means the diff touches a governed contract path without the evidence its policy " +
			"requires. Read the explain trace, satisfy the contract (or request the documented override label), " +
			"and re-run the check. Do not bypass a block by editing the registry or gate configuration yourself.",
		AGENTS_MD_END,
	].join("\n");
}

async function upsertAgentsMd(agentsPath: string): Promise<string> {
	const block = agentsMdBlock();
	const existing = (await pathExists(agentsPath)) ? await readFile(agentsPath, "utf8") : "";
	const next = upsertMarkerBlock(existing, AGENTS_MD_START, AGENTS_MD_END, block);
	await writeFile(agentsPath, next, "utf8");
	return next;
}

const GITLAB_START = "# <!-- gatekeeper:adopt -->";
const GITLAB_END = "# <!-- /gatekeeper:adopt -->";

function gitlabCiBlock(): string {
	return [
		GITLAB_START,
		"gatekeeper-check:",
		"  image: node:20",
		"  # No explicit `stage:` — defaults to the built-in `test` stage. If your pipeline declares",
		"  # custom `stages:` without a `test` stage, add `stage: <your-stage>` here.",
		"  allow_failure: true # soft mode by default; set to false (or remove this line) once you're ready to block merge requests on a Gatekeeper verdict",
		"  script:",
		"    - npx --yes @gatekeeper-dev/cli check --explain",
		"  rules:",
		"    - if: '$CI_PIPELINE_SOURCE == \"merge_request_event\"'",
		GITLAB_END,
	].join("\n");
}

/**
 * Text-block injection, not parse-merge-serialize: re-emitting `.gitlab-ci.yml`
 * through a YAML parser/stringifier would normalize away comments, anchors,
 * and formatting the user already owns. A marker-delimited text block is the
 * only append strategy here that can't corrupt content it doesn't understand
 * — the tradeoff is that this function does not (and cannot, without
 * parsing) verify the injected job is compatible with an existing custom
 * `stages:` list; see the in-file comment above for the fallback guidance.
 */
async function upsertGitlabCi(gitlabCiPath: string): Promise<void> {
	const block = gitlabCiBlock();
	const existing = (await pathExists(gitlabCiPath)) ? await readFile(gitlabCiPath, "utf8") : "";
	const next = upsertMarkerBlock(existing, GITLAB_START, GITLAB_END, block);
	await writeFile(gitlabCiPath, next, "utf8");
}

/** Resolve the packaged examples/workflows/gatekeeper-check.yml template from either the bundled dist/cli.js (one directory up) or the unbundled src/commands/provision.ts (two directories up) — same two-candidate strategy as gate/presets.ts's defaultLanePresetDirectory. */
function githubWorkflowTemplatePath(moduleUrl: string | URL = import.meta.url): string {
	const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
	const bundledCandidate = path.resolve(moduleDirectory, "../examples/workflows/gatekeeper-check.yml");
	const sourceCandidate = path.resolve(moduleDirectory, "../../examples/workflows/gatekeeper-check.yml");
	return existsSync(bundledCandidate) ? bundledCandidate : sourceCandidate;
}

function annotateGithubWorkflow(template: string, repoName: string): string {
	const banner = [
		"# Installed by `gatekeeper provision --ci` (see repos.yaml).",
		`# Registered repo: ${repoName}. CI runners don't share your local checkout, so this workflow`,
		"# checks out the registry repository separately below. Update `repository:` and",
		'# `registry-path:` in the "Checkout the registry only" step to point at your actual registry',
		"# repository before relying on this workflow.",
		"",
	].join("\n");
	return `${banner}${template}`;
}

const PRE_PUSH_HOOK = `#!/bin/sh
# Installed by \`gatekeeper provision --hooks\`. Fail-direction: infrastructure
# faults (gatekeeper not on PATH, a degraded registry/config) fail OPEN --
# only a confirmed policy block (exit 1) stops the push.

if ! command -v gatekeeper >/dev/null 2>&1; then
	echo "gatekeeper: not on PATH, skipping pre-push check (fail-open)" >&2
	exit 0
fi

base="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)"
if [ -z "$base" ]; then
	base="origin/HEAD"
fi

gatekeeper check --base "$base" --explain
status=$?

if [ "$status" -eq 1 ]; then
	exit 1
fi
exit 0
`;

interface WantedActions {
	ci: boolean;
	hooks: boolean;
	agentsMd: boolean;
}

/** No flag given at all means "do all three" (the useful default for a fresh hub-repo provisioning run); any explicit flag switches to opt-in only. */
function wantedActions(options: ProvisionOptions): WantedActions {
	const anyExplicit = Boolean(options.ci || options.hooks || options.agentsMd);
	if (!anyExplicit) {
		return { ci: true, hooks: true, agentsMd: true };
	}
	return { ci: Boolean(options.ci), hooks: Boolean(options.hooks), agentsMd: Boolean(options.agentsMd) };
}

async function provisionAgentsMd(repoPath: string, dryRun: boolean, lines: string[]): Promise<void> {
	const agentsPath = path.join(repoPath, "AGENTS.md");
	if (dryRun) {
		lines.push("would update AGENTS.md");
		return;
	}
	await upsertAgentsMd(agentsPath);
	lines.push("updated AGENTS.md");
}

async function provisionCi(
	entry: RepoEntry,
	force: boolean,
	dryRun: boolean,
	lines: string[],
): Promise<{ hasErrors: boolean }> {
	if (entry.ci === "none") {
		lines.push("skipped CI job (registered ci: none)");
		return { hasErrors: false };
	}
	if (entry.ci === "gitlab") {
		const gitlabCiPath = path.join(entry.path, ".gitlab-ci.yml");
		if (dryRun) {
			lines.push(`would update ${(await pathExists(gitlabCiPath)) ? "" : "(new) "}.gitlab-ci.yml`);
			return { hasErrors: false };
		}
		await upsertGitlabCi(gitlabCiPath);
		lines.push("updated .gitlab-ci.yml");
		return { hasErrors: false };
	}

	// entry.ci === "github"
	const workflowPath = path.join(entry.path, ".github", "workflows", "gatekeeper-check.yml");
	const exists = await pathExists(workflowPath);
	if (exists && !force) {
		lines.push(".github/workflows/gatekeeper-check.yml already exists; skipped (rerun with --force to overwrite)");
		return { hasErrors: true };
	}
	if (dryRun) {
		lines.push(`would ${exists ? "overwrite" : "write"} .github/workflows/gatekeeper-check.yml`);
		return { hasErrors: false };
	}
	const templatePath = githubWorkflowTemplatePath();
	let template: string;
	try {
		template = await readFile(templatePath, "utf8");
	} catch (error) {
		lines.push(
			`failed to read bundled workflow template ${templatePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { hasErrors: true };
	}
	await mkdir(path.dirname(workflowPath), { recursive: true });
	await writeFile(workflowPath, annotateGithubWorkflow(template, entry.repo), "utf8");
	lines.push("wrote .github/workflows/gatekeeper-check.yml");
	return { hasErrors: false };
}

/**
 * Resolves the hooks directory via `git rev-parse --git-common-dir`, not a
 * hardcoded `<repoPath>/.git/hooks`: in a linked worktree checkout, `.git`
 * is a *file* (a `gitdir:` pointer), not a directory, and
 * `mkdir(".../.git/hooks", { recursive: true })` against a file throws
 * ENOTDIR — the exact crash a live worktree checkout reproduced (T-20260719-03
 * R1 blocker). A resolution failure (not a Git working tree at all) degrades
 * to the same per-repo skip+warning every other provisionX helper uses,
 * never a thrown exception.
 */
async function provisionHooks(
	repoPath: string,
	force: boolean,
	dryRun: boolean,
	lines: string[],
): Promise<{ hasErrors: boolean }> {
	let gitCommonDir: string;
	try {
		gitCommonDir = await resolveGitCommonDir(repoPath);
	} catch (error) {
		lines.push(
			`skipped pre-push hook (could not resolve the Git directory: ` +
				`${error instanceof GitDiffError ? error.reason : error instanceof Error ? error.message : String(error)})`,
		);
		return { hasErrors: true };
	}
	const hookPath = path.join(gitCommonDir, "hooks", "pre-push");
	const exists = await pathExists(hookPath);
	if (exists && !force) {
		lines.push("pre-push hook already exists; skipped (rerun with --force to overwrite)");
		return { hasErrors: true };
	}
	if (dryRun) {
		lines.push(`would ${exists ? "overwrite" : "write"} the pre-push hook`);
		return { hasErrors: false };
	}
	await mkdir(path.dirname(hookPath), { recursive: true });
	await writeFile(hookPath, PRE_PUSH_HOOK, "utf8");
	await chmod(hookPath, 0o755);
	lines.push("wrote the pre-push hook");
	return { hasErrors: false };
}

function emitSummary(outcomes: RepoOutcome[], dryRun: boolean): void {
	process.stdout.write(`gatekeeper provision: ${outcomes.length} repo(s)${dryRun ? " (dry run)" : ""}\n`);
	for (const outcome of outcomes) {
		process.stdout.write(`  ${outcome.repo}:\n`);
		for (const line of outcome.lines) {
			process.stdout.write(`    - ${line}\n`);
		}
	}
}

export async function runProvision(
	options: ProvisionOptions,
	cwd: string,
	dependencies: ProvisionDependencies = {},
): Promise<number> {
	// Config discovery (.gatekeeper.yml, falling back to the user-level controls
	// index) is a local-authoring-command input like the registry directory
	// itself: provision fails loud on damage, not the check/gate degrade path.
	let discovered: DiscoveredConfig | null;
	try {
		const result = await discoverConfigWithControlsIndex(cwd, { mode: "tool", env: dependencies.env });
		discovered = result.discovered;
		for (const discoveryWarning of result.warnings) {
			process.stderr.write(`warning: ${discoveryWarning}\n`);
		}
	} catch (error) {
		if (!(error instanceof ConfigDiscoveryError)) {
			throw error;
		}
		process.stderr.write(`gatekeeper provision: ${error.reason}\n`);
		return 1;
	}

	const registryPath = resolveRegistryOption({ cliValue: options.registry, env: dependencies.env, discovered });
	if (!registryPath) {
		process.stderr.write(`${missingRegistryMessage("provision")}\n`);
		return 2;
	}

	let entries: RepoEntry[];
	try {
		entries = await loadRepos(registryPath);
	} catch (error) {
		process.stderr.write(`gatekeeper provision: ${error instanceof ReposFileError ? error.reason : String(error)}\n`);
		return 1;
	}

	// Defense in depth against a hand-edited repos.yaml: `adopt` already refuses
	// to register an entry that overlaps its control repo, but repos.yaml is a
	// plain file a human (or another tool) can still edit directly. Best-effort:
	// if the registry itself lives inside a Git working tree, treat that tree's
	// root as the control repo boundary and drop any overlapping entry.
	const controlRoot = await resolveRepoRoot(registryPath)
		.then((root) => realpath(root))
		.catch(() => null);
	if (controlRoot) {
		const kept: RepoEntry[] = [];
		for (const entry of entries) {
			const entryRealPath = await realpath(entry.path).catch(() => entry.path);
			if (pathsOverlap(controlRoot, entryRealPath)) {
				process.stderr.write(
					`warning: ${entry.repo}: registered path ${entry.path} overlaps with the control repo ${controlRoot}; ` +
						"skipping (repos.yaml must not register the control repo itself)\n",
				);
				continue;
			}
			kept.push(entry);
		}
		entries = kept;
	}

	const filter = options.repos && options.repos.length > 0 ? new Set(options.repos) : null;
	if (filter) {
		for (const name of filter) {
			if (!entries.some((entry) => entry.repo === name)) {
				process.stderr.write(`warning: ${name} is not registered in ${registryPath}/repos.yaml; skipping\n`);
			}
		}
	}
	const selected = filter ? entries.filter((entry) => filter.has(entry.repo)) : entries;

	const wanted = wantedActions(options);
	const dryRun = Boolean(options.dryRun);
	const force = Boolean(options.force);
	let hasErrors = false;
	const outcomes: RepoOutcome[] = [];

	// Depth-defense beyond each provisionX helper's own try/catch: no single
	// registered repo's unexpected I/O failure may abort the batch. Each
	// helper above already degrades its *known* failure modes (missing
	// checkout, ENOTDIR from a worktree's .git file, ...) into a per-repo
	// skip+warning without throwing, but this outer boundary exists so that
	// any failure mode neither of us has enumerated yet still degrades to
	// "skip this repo, keep going" instead of crashing the whole run.
	for (const entry of selected) {
		const lines: string[] = [];
		try {
			if (!(await pathExists(entry.path))) {
				process.stderr.write(`warning: ${entry.repo}: registered path ${entry.path} does not exist; skipping\n`);
				outcomes.push({ repo: entry.repo, lines: ["skipped (registered path does not exist)"] });
				hasErrors = true;
				continue;
			}

			if (wanted.agentsMd) {
				await provisionAgentsMd(entry.path, dryRun, lines);
			}
			if (wanted.ci) {
				const result = await provisionCi(entry, force, dryRun, lines);
				hasErrors = hasErrors || result.hasErrors;
			}
			if (wanted.hooks) {
				const result = await provisionHooks(entry.path, force, dryRun, lines);
				hasErrors = hasErrors || result.hasErrors;
			}

			outcomes.push({ repo: entry.repo, lines });
		} catch (error) {
			hasErrors = true;
			const reason = error instanceof Error ? error.message : String(error);
			process.stderr.write(
				`warning: ${entry.repo}: unexpected error while provisioning; skipping its remaining actions (${reason})\n`,
			);
			outcomes.push({ repo: entry.repo, lines: [...lines, `unexpected error, remaining actions skipped: ${reason}`] });
		}
	}

	emitSummary(outcomes, dryRun);
	return hasErrors ? 1 : 0;
}
