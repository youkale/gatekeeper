import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import picomatch from "picomatch";

import {
	ConfigDiscoveryError,
	discoverConfig,
	missingRegistryMessage,
	resolveRegistryOption,
} from "../config/discover.js";
import { formatRegistryIssue, parseRegistry, RegistryParseError } from "../engine/registry.js";
import type { Contract, Registry } from "../engine/types.js";
import { RegistryReadError, readRegistryFiles } from "../providers/fsregistry.js";

export interface AuditOptions {
	/** Optional at the CLI level: resolved against GATEKEEPER_REGISTRY / .gatekeeper.yml before use — see runAudit. */
	registry?: string;
	repoPath?: string[];
	json?: boolean;
}

export interface AuditMissingGlob {
	contract: string;
	binding: string;
	repo: string;
	glob: string;
}

export interface AuditReport {
	checkedGlobs: number;
	matchedGlobs: number;
	missing: AuditMissingGlob[];
}

export class AuditError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(reason);
		this.name = "AuditError";
		this.reason = reason;
		if (options?.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

interface GlobCheck extends AuditMissingGlob {}

function describeError(error: unknown): string {
	if (error instanceof RegistryParseError) {
		return error.issues.map(formatRegistryIssue).join("; ");
	}
	if (error instanceof RegistryReadError || error instanceof AuditError || error instanceof ConfigDiscoveryError) {
		return error.reason;
	}
	return error instanceof Error ? error.message : String(error);
}

function normalizeRepo(repo: string): string {
	const normalized = repo.trim();
	if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
		throw new AuditError(`invalid repository identity ${JSON.stringify(repo)}; expected org/name`);
	}
	return normalized;
}

/** Parse repeated `--repo-path org/name=/checkout/path` mappings. */
export function parseRepoPaths(values: readonly string[], cwd: string): Map<string, string> {
	const mappings = new Map<string, string>();
	for (const value of values) {
		const separator = value.indexOf("=");
		if (separator <= 0 || separator === value.length - 1) {
			throw new AuditError(`invalid --repo-path ${JSON.stringify(value)}; expected org/name=/path/to/local/checkout`);
		}
		const repo = normalizeRepo(value.slice(0, separator));
		const checkout = path.resolve(cwd, value.slice(separator + 1));
		if (mappings.has(repo)) {
			throw new AuditError(`duplicate --repo-path mapping for ${repo}`);
		}
		mappings.set(repo, checkout);
	}
	return mappings;
}

function contractChecks(contract: Contract): GlobCheck[] {
	const checks: GlobCheck[] = contract.authority.paths.map((glob) => ({
		contract: contract.name,
		binding: "authority",
		repo: contract.authority.repo,
		glob,
	}));
	for (const [index, consumer] of contract.consumers.entries()) {
		for (const glob of consumer.paths) {
			checks.push({
				contract: contract.name,
				binding: `consumer[${index}] (${consumer.role})`,
				repo: consumer.repo,
				glob,
			});
		}
	}
	return checks;
}

function registryChecks(registry: Registry): GlobCheck[] {
	return registry.contracts.flatMap(contractChecks);
}

async function listFiles(root: string): Promise<string[]> {
	let metadata: Awaited<ReturnType<typeof stat>>;
	try {
		metadata = await stat(root);
	} catch (error) {
		throw new AuditError(`failed to access repository checkout ${root}`, { cause: error });
	}
	if (!metadata.isDirectory()) {
		throw new AuditError(`repository checkout is not a directory: ${root}`);
	}

	const files: string[] = [];
	async function visit(directory: string, prefix: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			throw new AuditError(`failed to read repository directory ${directory}`, { cause: error });
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (prefix.length === 0 && entry.name === ".git") {
				continue;
			}
			const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) {
				await visit(path.join(directory, entry.name), relative);
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				files.push(relative);
			}
		}
	}

	await visit(root, "");
	return files;
}

export async function auditRegistryGlobs(registry: Registry, repoPaths: Map<string, string>): Promise<AuditReport> {
	const checks = registryChecks(registry);
	const filesByRepo = new Map<string, string[]>();
	for (const repo of new Set(checks.map((check) => check.repo))) {
		const checkout = repoPaths.get(repo);
		if (!checkout) {
			throw new AuditError(`missing --repo-path mapping for registry repository ${repo}`);
		}
		filesByRepo.set(repo, await listFiles(checkout));
	}

	const missing: AuditMissingGlob[] = [];
	for (const check of checks) {
		let matches: (value: string) => boolean;
		try {
			matches = picomatch(check.glob, { dot: true });
		} catch (error) {
			throw new AuditError(`failed to compile glob ${JSON.stringify(check.glob)} for contract ${check.contract}`, {
				cause: error,
			});
		}
		if (!(filesByRepo.get(check.repo) ?? []).some(matches)) {
			missing.push(check);
		}
	}

	return {
		checkedGlobs: checks.length,
		matchedGlobs: checks.length - missing.length,
		missing,
	};
}

function emitReport(report: AuditReport, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return;
	}
	process.stdout.write(`Gatekeeper audit: ${report.matchedGlobs}/${report.checkedGlobs} registry globs matched\n`);
	for (const missing of report.missing) {
		process.stdout.write(`MISSING ${missing.repo}:${missing.glob} (${missing.contract}, ${missing.binding})\n`);
	}
}

/**
 * Audit is a registry-health command, not a merge verdict: confirmed drift is
 * exit 1, while an invalid invocation/checkout/registry is exit 2.
 */
export async function runAudit(options: AuditOptions, cwd: string): Promise<number> {
	try {
		// Config discovery (.gatekeeper.yml) is a local-authoring-command input like
		// the registry directory itself: a damaged config file is fail-loud (exit
		// 2), same as any other audit input error below.
		const discovered = await discoverConfig(cwd);
		const registryPath = resolveRegistryOption({ cliValue: options.registry, discovered });
		if (!registryPath) {
			const reason = missingRegistryMessage("audit");
			if (options.json) {
				process.stdout.write(`${JSON.stringify({ error: true, reason })}\n`);
			}
			process.stderr.write(`${reason}\n`);
			return 2;
		}
		const files = await readRegistryFiles(registryPath);
		const registry = parseRegistry(files);
		const repoPaths = parseRepoPaths(options.repoPath ?? [], cwd);
		const report = await auditRegistryGlobs(registry, repoPaths);
		emitReport(report, options.json ?? false);
		for (const warning of registry.warnings) {
			process.stderr.write(`warning: ${formatRegistryIssue(warning)}\n`);
		}
		return report.missing.length > 0 ? 1 : 0;
	} catch (error) {
		const reason = describeError(error);
		if (options.json) {
			process.stdout.write(`${JSON.stringify({ error: true, reason })}\n`);
		}
		process.stderr.write(`gatekeeper audit: ${reason}\n`);
		return 2;
	}
}
