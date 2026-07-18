import { formatRegistryIssue, parseRegistry, RegistryParseError } from "../engine/registry.js";
import type { Registry } from "../engine/types.js";
import { evaluate } from "../engine/verdict.js";
import { RegistryReadError, readRegistryFiles } from "../providers/fsregistry.js";
import {
	attachPatches,
	GitDiffError,
	getChangedFiles,
	resolveActor,
	resolveBaseRef,
	resolveRepo,
} from "../providers/gitdiff.js";
import { renderDegradedJson, renderExplain, renderSummary, renderVerdictJson } from "../render/explain.js";

export interface CheckOptions {
	registry: string;
	repo?: string;
	base?: string;
	staged?: boolean;
	workingTree?: boolean;
	json?: boolean;
	explain?: boolean;
	actor?: string;
	strictInfra?: boolean;
}

function describeCheckError(error: unknown): string {
	if (error instanceof RegistryParseError) {
		return error.issues.map(formatRegistryIssue).join("; ");
	}
	if (error instanceof RegistryReadError || error instanceof GitDiffError) {
		return error.reason;
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Fail-open handling for infrastructure/config faults (registry load, git
 * commands, repo identity resolution): default is exit 0 with a loud stderr
 * warning (and, under --json, a {"degraded": true} stdout payload) so a bare
 * CLI invocation in CI never turns an infra hiccup into a merge block.
 * --strict-infra flips this to exit 2 for local debugging.
 */
function degrade(reason: string, options: CheckOptions): number {
	// The degraded JSON payload goes to stdout in --json mode regardless of
	// --strict-infra, so machine consumers always see a parseable result.
	if (options.json) {
		process.stdout.write(`${renderDegradedJson(reason)}\n`);
	}
	process.stderr.write(`GATEKEEPER DEGRADED: ${reason}\n`);
	return options.strictInfra ? 2 : 0;
}

export async function runCheck(options: CheckOptions, cwd: string): Promise<number> {
	let registry: Registry;
	try {
		const files = await readRegistryFiles(options.registry);
		registry = parseRegistry(files);
	} catch (error) {
		return degrade(describeCheckError(error), options);
	}

	let repo: string;
	try {
		repo = await resolveRepo(cwd, options.repo);
	} catch (error) {
		return degrade(describeCheckError(error), options);
	}

	const actor = await resolveActor(cwd, options.actor);

	let changedFiles: Awaited<ReturnType<typeof getChangedFiles>>;
	try {
		const base = options.staged || options.workingTree ? undefined : await resolveBaseRef(cwd, options.base);
		const rangeOptions = { base, staged: options.staged, workingTree: options.workingTree };
		const withoutPatches = await getChangedFiles(cwd, rangeOptions);
		changedFiles = await attachPatches(cwd, withoutPatches, registry.contracts, rangeOptions);
	} catch (error) {
		return degrade(describeCheckError(error), options);
	}

	const verdict = evaluate({ repo, actor, changedFiles, registry });

	const humanLines = [...renderSummary(verdict), ...(options.explain ? renderExplain(verdict) : [])];

	if (options.json) {
		process.stdout.write(`${renderVerdictJson(verdict)}\n`);
		for (const line of humanLines) {
			process.stderr.write(`${line}\n`);
		}
	} else {
		for (const line of humanLines) {
			process.stdout.write(`${line}\n`);
		}
	}

	for (const warning of registry.warnings) {
		process.stderr.write(`warning: ${formatRegistryIssue(warning)}\n`);
	}

	return verdict.decision === "block" ? 1 : 0;
}
