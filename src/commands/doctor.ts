import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parseDocument } from "yaml";

import { formatRegistryIssue, RegistryParseError } from "../engine/registry.js";
import { LanePresetParseError, LanePresetReadError, loadRegistryWithLanePresets } from "../gate/presets.js";
import { RegistryReadError } from "../providers/fsregistry.js";
import { GitDiffError, resolveRepo } from "../providers/gitdiff.js";
import { GitHubProvider, type GitHubProviderOptions, InfraError } from "../providers/github.js";

export interface DoctorOptions {
	registry: string;
	repo?: string;
	branch?: string;
	workflow?: string;
	checkName?: string[];
}

type DoctorProvider = Pick<GitHubProvider, "getBranchProtectionRequiredChecks">;

export interface DoctorCapabilityResult {
	warnings?: string[];
	errors?: string[];
}

/** M6 appends provider/model checks through this interface without changing M3 behavior. */
export interface DoctorCapabilityCheck {
	name: string;
	run: () => Promise<DoctorCapabilityResult>;
}

export interface DoctorDependencies {
	createProvider?: (options: GitHubProviderOptions) => DoctorProvider;
	env?: NodeJS.ProcessEnv;
	presetDirectory?: string;
	capabilityChecks?: DoctorCapabilityCheck[];
}

class DoctorConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DoctorConfigError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function describeError(error: unknown): string {
	if (error instanceof RegistryParseError) {
		return error.issues.map(formatRegistryIssue).join("; ");
	}
	if (
		error instanceof RegistryReadError ||
		error instanceof LanePresetReadError ||
		error instanceof GitDiffError ||
		error instanceof InfraError
	) {
		return error.reason;
	}
	if (error instanceof LanePresetParseError) {
		return error.issues.map((issue) => `${issue.file} ${issue.path}: ${issue.message}`).join("; ");
	}
	return error instanceof Error ? error.message : String(error);
}

async function validateRegistry(registryDirectory: string, presetDirectory?: string) {
	return loadRegistryWithLanePresets(registryDirectory, presetDirectory);
}

async function workflowFiles(target: string): Promise<string[]> {
	let metadata: Awaited<ReturnType<typeof stat>>;
	try {
		metadata = await stat(target);
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`workflow path does not exist: ${target}`, { cause: error });
		}
		throw error;
	}
	if (metadata.isFile()) {
		return [/\.ya?ml$/.test(target) ? target : []].flat();
	}
	if (!metadata.isDirectory()) {
		throw new DoctorConfigError(`workflow path is neither a YAML file nor a directory: ${target}`);
	}
	let entries: Dirent[];
	try {
		entries = await readdir(target, { withFileTypes: true });
	} catch (error) {
		throw new Error(`failed to read workflow directory ${target}: ${describeError(error)}`, { cause: error });
	}
	return entries
		.filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
		.map((entry) => path.join(target, entry.name))
		.sort();
}

function looksLikeGateJob(jobId: string, job: Record<string, unknown>): boolean {
	if (jobId === "gate" || (typeof job.name === "string" && /gatekeeper|\bgate\b/i.test(job.name))) {
		return true;
	}
	const steps = Array.isArray(job.steps) ? job.steps : [];
	return steps.some(
		(step) =>
			isRecord(step) &&
			((typeof step.run === "string" && /(?:^|\s)gatekeeper\s+gate(?:\s|$)/m.test(step.run)) ||
				(typeof step.uses === "string" && /gatekeeper/i.test(step.uses))),
	);
}

export async function gateCheckNamesFromWorkflows(target: string): Promise<string[]> {
	const names = new Set<string>();
	const files = await workflowFiles(target);
	for (const file of files) {
		const content = await readFile(file, "utf8");
		const document = parseDocument(content, { prettyErrors: false, uniqueKeys: true });
		if (document.errors.length > 0) {
			throw new DoctorConfigError(`${file}: invalid workflow YAML: ${document.errors[0]?.message ?? "unknown error"}`);
		}
		let value: unknown;
		try {
			value = document.toJS();
		} catch (error) {
			throw new DoctorConfigError(
				`${file}: invalid workflow YAML: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!isRecord(value) || !isRecord(value.jobs)) {
			continue;
		}
		for (const [jobId, rawJob] of Object.entries(value.jobs)) {
			if (!isRecord(rawJob) || !looksLikeGateJob(jobId, rawJob)) {
				continue;
			}
			names.add(typeof rawJob.name === "string" && rawJob.name.length > 0 ? rawJob.name : jobId);
		}
	}
	return [...names].sort();
}

function warning(message: string): void {
	process.stderr.write(`warning: ${message}\n`);
}

function failure(message: string): void {
	process.stderr.write(`error: ${message}\n`);
}

async function resolveExpectedChecks(options: DoctorOptions, cwd: string): Promise<string[]> {
	if (options.checkName && options.checkName.length > 0) {
		return [...new Set(options.checkName)];
	}
	const target = path.resolve(cwd, options.workflow ?? ".github/workflows");
	const names = await gateCheckNamesFromWorkflows(target);
	if (names.length === 0) {
		throw new DoctorConfigError(`no gate job found in ${target}`);
	}
	return names;
}

export async function runDoctor(
	options: DoctorOptions,
	cwd: string,
	dependencies: DoctorDependencies = {},
): Promise<number> {
	let validated: Awaited<ReturnType<typeof validateRegistry>>;
	try {
		validated = await validateRegistry(options.registry, dependencies.presetDirectory);
	} catch (error) {
		if (error instanceof RegistryParseError || error instanceof LanePresetParseError) {
			failure(describeError(error));
			return 1;
		}
		warning(`无法校验注册表: ${describeError(error)}`);
		return 0;
	}

	let expectedChecks: string[];
	try {
		expectedChecks = await resolveExpectedChecks(options, cwd);
	} catch (error) {
		if (error instanceof DoctorConfigError) {
			failure(error.message);
			return 1;
		}
		warning(`无法校验 workflow: ${describeError(error)}`);
		return 0;
	}

	let hasErrors = false;
	for (const registryWarning of validated.registry.warnings) {
		warning(formatRegistryIssue(registryWarning));
	}
	for (const conflict of validated.conflicts) {
		warning(
			`policy lane ${conflict.lane} overrides preset ${conflict.presetFile}; ${conflict.resolution} (${conflict.userFile})`,
		);
	}

	const env = dependencies.env ?? process.env;
	try {
		const repo = await resolveRepo(cwd, options.repo ?? env.GITHUB_REPOSITORY);
		const branch = options.branch ?? env.GITHUB_BASE_REF ?? "main";
		const provider = (dependencies.createProvider ?? ((providerOptions) => new GitHubProvider(providerOptions)))({
			repo,
		});
		const required = await provider.getBranchProtectionRequiredChecks(branch);
		if (!required.available) {
			warning(`无法校验 branch protection required checks (${required.status}): ${required.message}`);
		} else {
			const configured = new Set([...required.contexts, ...required.checks.map((check) => check.context)]);
			for (const check of expectedChecks) {
				if (!configured.has(check)) {
					hasErrors = true;
					failure(`gate check ${JSON.stringify(check)} is not required on ${repo}:${branch}`);
				}
			}
		}
	} catch (error) {
		warning(`无法校验 branch protection required checks: ${describeError(error)}`);
	}

	for (const capability of dependencies.capabilityChecks ?? []) {
		try {
			const result = await capability.run();
			for (const message of result.warnings ?? []) {
				warning(`${capability.name}: ${message}`);
			}
			for (const message of result.errors ?? []) {
				hasErrors = true;
				failure(`${capability.name}: ${message}`);
			}
		} catch (error) {
			warning(`无法校验 ${capability.name}: ${describeError(error)}`);
		}
	}

	if (!hasErrors) {
		process.stdout.write(
			`gatekeeper doctor: OK (${validated.registry.contracts.length} contract(s), checks: ${expectedChecks.join(", ")})\n`,
		);
	}
	return hasErrors ? 1 : 0;
}
