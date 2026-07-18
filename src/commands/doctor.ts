import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parseDocument } from "yaml";

import { formatRegistryIssue, RegistryParseError } from "../engine/registry.js";
import { LanePresetParseError, LanePresetReadError, loadRegistryWithLanePresets } from "../gate/presets.js";
import { RegistryReadError } from "../providers/fsregistry.js";
import { GitDiffError, resolveRepo } from "../providers/gitdiff.js";
import { GitHubProvider, type GitHubProviderOptions, InfraError } from "../providers/github.js";
import {
	loadPiProviderAvailability,
	loadRolesPolicy,
	RolesPolicyParseError,
	RolesPolicyReadError,
	resolveRolesPolicyPath,
	selectAllTiers,
} from "../roles/policy.js";

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

/** Parses one workflow YAML file to a record, or throws DoctorConfigError for malformed content ("config damage" -- see runDoctor's fail-direction contract). */
async function parseWorkflowFile(file: string): Promise<Record<string, unknown> | undefined> {
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
	return isRecord(value) ? value : undefined;
}

export async function gateCheckNamesFromWorkflows(target: string): Promise<string[]> {
	const names = new Set<string>();
	const files = await workflowFiles(target);
	for (const file of files) {
		const value = await parseWorkflowFile(file);
		if (!value || !isRecord(value.jobs)) {
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

// T-09/LESSONS: "required check 只能由定义取自受信 ref 的 workflow
// （pull_request_target/check_suite/workflow_run/schedule）产出" -- a
// required-check-producing job that also listens on a trigger whose
// workflow definition loads from PR-controlled content (pull_request,
// pull_request_review) lets a PR forge/spoof its own required check. This
// is the deep-reasoner-directed hard-gate precondition tracked as debt in
// tasks/LEDGER.md (T-09).
const UNSAFE_GATE_TRIGGERS = new Set(["pull_request", "pull_request_review"]);

function workflowTriggerNames(value: Record<string, unknown>): string[] {
	const on = value.on;
	if (typeof on === "string") {
		return [on];
	}
	if (Array.isArray(on)) {
		return on.filter((entry): entry is string => typeof entry === "string");
	}
	if (isRecord(on)) {
		return Object.keys(on);
	}
	return [];
}

/**
 * Heuristic for "this step produces a Gatekeeper required check": a local
 * (`uses: ./...`) or published (`uses: *gatekeeper*`) action step invoked
 * with `mode: gate`. `mode` defaults to `gate` in action.yml (see its
 * `mode.default: gate`), so a step that omits `with.mode` entirely still
 * runs in gate mode at runtime -- only an explicit non-gate mode (e.g.
 * `mode: check`) opts a step out of this heuristic.
 */
function stepProducesRequiredCheck(step: unknown): boolean {
	if (!isRecord(step) || typeof step.uses !== "string") {
		return false;
	}
	const uses = step.uses;
	const looksLikeGateAction = uses === "./" || uses.startsWith("./") || /gatekeeper/i.test(uses);
	if (!looksLikeGateAction) {
		return false;
	}
	const withBlock = isRecord(step.with) ? step.with : undefined;
	return (withBlock?.mode ?? "gate") === "gate";
}

function jobProducesRequiredCheck(job: Record<string, unknown>): boolean {
	const steps = Array.isArray(job.steps) ? job.steps : [];
	return steps.some(stepProducesRequiredCheck);
}

export interface GateWorkflowTriggerViolation {
	file: string;
	jobId: string;
	triggers: string[];
}

/**
 * Flags required-check-producing jobs that listen on a PR-content-loaded
 * trigger (pull_request/pull_request_review) -- see UNSAFE_GATE_TRIGGERS
 * above. Callers treat "workflow path/file could not be located" as a
 * warning (fail-open, matching workflowFiles' own ENOENT -> generic Error
 * contract) and a detected violation, or malformed workflow YAML, as an
 * error (fail-closed, matching parseWorkflowFile's DoctorConfigError
 * contract) -- see runDoctor.
 */
export async function gateWorkflowTriggerViolations(target: string): Promise<GateWorkflowTriggerViolation[]> {
	const violations: GateWorkflowTriggerViolation[] = [];
	const files = await workflowFiles(target);
	for (const file of files) {
		const value = await parseWorkflowFile(file);
		if (!value) {
			continue;
		}
		const unsafeTriggers = workflowTriggerNames(value).filter((trigger) => UNSAFE_GATE_TRIGGERS.has(trigger));
		if (unsafeTriggers.length === 0 || !isRecord(value.jobs)) {
			continue;
		}
		for (const [jobId, rawJob] of Object.entries(value.jobs)) {
			if (isRecord(rawJob) && jobProducesRequiredCheck(rawJob)) {
				violations.push({ file, jobId, triggers: unsafeTriggers });
			}
		}
	}
	return violations;
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

export interface RolesPolicyCapabilityOptions {
	/** Defaults to <cwd>/roles-policy.yaml if it exists, otherwise the package-shipped roles-policy.yaml. */
	rolesPolicyPath?: string;
	/** Defaults to ~/.pi/agent. */
	piConfigDir?: string;
}

/**
 * Builds the M6 roles-policy capability check: does each tier in
 * roles-policy.yaml have an available model under the current pi config?
 *
 * Path resolution: prefer a consuming repo's own `<cwd>/roles-policy.yaml`
 * override; fall back to the package-shipped `roles-policy.yaml`
 * (`defaultRolesPolicyPath`, same file `src/roles/policy.ts` resolves for
 * `triage`) when the cwd has none. A missing file at *both* locations is a
 * reasonable "not configured" degrade (warning); a file that exists but
 * fails to parse is a real configuration defect and must not be silently
 * swallowed into a warning (error).
 *
 * deep-reasoner tier severity: zero selectable models (confirmed or
 * unknown) is an error -- nothing downstream of triage can produce a
 * judgement without it. Selections that exist but are all
 * model-level-unconfirmed (vendor credentialed only, no models.json
 * confirmation) are a warning, not an error or a silent OK: pi being logged
 * into a vendor does not prove that exact model id actually works. Every
 * other tier gap, and an unreadable pi config, is only a warning (fail-open
 * -- roles-policy availability is advisory, not a merge gate).
 */
export function rolesPolicyCapabilityCheck(
	cwd: string,
	options: RolesPolicyCapabilityOptions = {},
): DoctorCapabilityCheck {
	return {
		name: "roles-policy",
		run: async (): Promise<DoctorCapabilityResult> => {
			const rolesPolicyPath = resolveRolesPolicyPath(cwd, options.rolesPolicyPath);

			let policy: Awaited<ReturnType<typeof loadRolesPolicy>>;
			try {
				policy = await loadRolesPolicy(rolesPolicyPath);
			} catch (error) {
				if (error instanceof RolesPolicyReadError) {
					return { warnings: [`无法读取 roles-policy (${rolesPolicyPath}): ${error.reason}`] };
				}
				if (error instanceof RolesPolicyParseError) {
					return { errors: [`roles-policy (${rolesPolicyPath}) 解析失败: ${error.message}`] };
				}
				throw error;
			}

			const availability = await loadPiProviderAvailability({ piConfigDir: options.piConfigDir });
			const warnings: string[] = [];
			const errors: string[] = [];
			// auth.json and models.json are read independently (see loadPiProviderAvailability):
			// authKnown false is worth its own warning even when modelsKnown is true (models.json
			// confirmations still apply, but vendor-credentialed "unknown" picks cannot be made).
			if (!availability.authKnown) {
				const suffix = availability.modelsKnown
					? "；models.json 的显式确认仍生效，但无法识别仅凭厂商凭据可用的模型"
					: "；仅能展示 roles-policy 偏好序，无法确认可用模型";
				warnings.push(`无法读取 pi 认证配置 (${availability.reason ?? "unknown"})${suffix}`);
			}
			for (const selection of selectAllTiers(policy, availability)) {
				const isDeepReasoner = selection.tier === "deep-reasoner";
				const hasSelection = selection.selected.length > 0;
				const hasConfirmed = selection.selected.some((entry) => entry.status === "confirmed");
				if (isDeepReasoner && availability.known && !hasSelection) {
					errors.push(...selection.warnings);
					continue;
				}
				if (isDeepReasoner && availability.known && hasSelection && !hasConfirmed) {
					// Not OK (nothing model-level-confirmed) but not an error either
					// (vendor credentials exist and the preference order was honored).
					warnings.push(...selection.warnings);
					continue;
				}
				warnings.push(...selection.warnings);
			}
			return { warnings, errors };
		},
	};
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

	try {
		const workflowTarget = path.resolve(cwd, options.workflow ?? ".github/workflows");
		const violations = await gateWorkflowTriggerViolations(workflowTarget);
		for (const violation of violations) {
			hasErrors = true;
			failure(
				`${violation.file} job ${JSON.stringify(violation.jobId)} appears to produce a required check but is ` +
					`triggered by ${violation.triggers.join(", ")}; required check 只能由定义取自受信 ref 的 workflow` +
					"（pull_request_target/check_suite/workflow_run/schedule/workflow_dispatch）产出，不可绑定 pull_request/pull_request_review 触发器。",
			);
		}
	} catch (error) {
		if (error instanceof DoctorConfigError) {
			hasErrors = true;
			failure(error.message);
		} else {
			warning(`无法校验 gate workflow 触发器: ${describeError(error)}`);
		}
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
