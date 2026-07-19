import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseDocument, stringify } from "yaml";
import { z } from "zod";

import type { RoleAssignment } from "./assign.js";
import type { DetectedAgentCli } from "./detect.js";

/**
 * `governance/agents.yaml`: `gatekeeper init-control`'s snapshot of "which
 * agent CLIs did this machine have installed, and which role tier did each
 * get assigned to" (src/agent/detect.ts + src/agent/assign.ts). Unlike
 * `repos.yaml` (live state exclusively owned by `gatekeeper adopt`, never
 * overwritten by --force), this file is a *regenerable template*: rerunning
 * `init-control --force` re-detects and overwrites it, same posture as
 * policy.yaml/the role-card copies. It is the third and lowest-priority tier
 * of the BYO agent command resolution chain triage --run/init --run use (see
 * src/agent/resolve.ts) -- a convenience fallback, never required.
 */

export const AGENTS_FILENAME = "agents.yaml";

export class AgentsFileParseError extends Error {
	readonly file: string;
	readonly issues: string[];

	constructor(issues: string[], file: string) {
		super(issues.map((issue) => `${file}: ${issue}`).join("\n"));
		this.name = "AgentsFileParseError";
		this.file = file;
		this.issues = issues;
	}
}

export class AgentsFileReadError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(reason);
		this.name = "AgentsFileReadError";
		this.reason = reason;
		if (options?.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

export interface AgentsFileAssignment {
	role: string;
	cli: string;
	vendor: string;
	command_template: string;
	rationale: string;
}

export interface AgentsFileDetectedEntry {
	name: string;
	binary: string;
	vendor: string;
	path: string;
	version: string | null;
}

export interface AgentsFile {
	apiVersion: "gatekeeper/v1";
	assignments: AgentsFileAssignment[];
	detected: AgentsFileDetectedEntry[];
	warnings: string[];
}

const assignmentSchema = z
	.object({
		role: z.string().min(1),
		cli: z.string().min(1),
		vendor: z.string().min(1),
		command_template: z.string().min(1),
		rationale: z.string().min(1),
	})
	.strict();

const detectedEntrySchema = z
	.object({
		name: z.string().min(1),
		binary: z.string().min(1),
		vendor: z.string().min(1),
		path: z.string().min(1),
		version: z.string().nullable(),
	})
	.strict();

const agentsFileSchema = z
	.object({
		apiVersion: z.literal("gatekeeper/v1"),
		assignments: z.array(assignmentSchema).default([]),
		detected: z.array(detectedEntrySchema).default([]),
		warnings: z.array(z.string()).default([]),
	})
	.strict();

function yamlPath(segments: PropertyKey[]): string {
	return segments.reduce<string>((result, segment) => {
		return typeof segment === "number" ? `${result}[${segment}]` : `${result}.${String(segment)}`;
	}, "$");
}

function describeZodError(error: z.ZodError): string[] {
	return error.issues.map((issue) => `${yamlPath(issue.path)}: ${issue.message}`);
}

/** Parse agents.yaml content. Pure -- no I/O. Mirrors roles/policy.ts's parseRolesPolicy pattern. */
export function parseAgentsFile(content: string, file = AGENTS_FILENAME): AgentsFile {
	const document = parseDocument(content, { prettyErrors: false, uniqueKeys: true });
	if (document.errors.length > 0) {
		throw new AgentsFileParseError(
			document.errors.map((error) => error.message),
			file,
		);
	}

	let value: unknown;
	try {
		value = document.toJS();
	} catch (error) {
		throw new AgentsFileParseError([error instanceof Error ? error.message : String(error)], file);
	}

	const result = agentsFileSchema.safeParse(value);
	if (!result.success) {
		throw new AgentsFileParseError(describeZodError(result.error), file);
	}
	return result.data;
}

/** Read + parse governance/agents.yaml off disk. All I/O lives here. */
export async function loadAgentsFile(filePath: string): Promise<AgentsFile> {
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch (error) {
		throw new AgentsFileReadError(
			`failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	return parseAgentsFile(content, filePath);
}

/**
 * The two plausible locations for a sibling `agents.yaml` relative to a
 * located registry directory, tried by `existsSync` in this priority order
 * -- same two-candidate approach as src/roles/cards.ts's
 * controlRoleCardDirectoryCandidates (and for the same reason: never guess
 * from `registryDir`'s basename):
 *
 *  1. `<registryDir>/agents.yaml` -- the registry sits directly at the
 *     control repo root.
 *  2. `<registryDir>/../agents.yaml` -- registry and agents.yaml are sibling
 *     paths under `governance/` (the layout `gatekeeper init-control` writes:
 *     `governance/registry` + `governance/agents.yaml`).
 *
 * Returns `undefined` when neither exists -- this is the routine "no
 * agents.yaml generated for this registry yet" state, not an error; callers
 * (src/agent/resolve.ts, doctor's agents capability check) silently skip
 * this resolution tier rather than failing.
 */
export function locateAgentsFile(registryDir: string): string | undefined {
	const candidates = [path.resolve(registryDir, AGENTS_FILENAME), path.resolve(registryDir, "..", AGENTS_FILENAME)];
	return candidates.find((candidate) => existsSync(candidate));
}

const AGENTS_FILE_HEADER =
	"# 本文件由 `gatekeeper init-control` 生成：本机探测到的 agent CLI（src/agent/detect.ts）与按\n" +
	"# roles-policy.yaml 选配的角色分派快照（src/agent/assign.ts）。可手改；但它是可再生的推导\n" +
	"# 产物，不是像 repos.yaml 那样的累积状态 -- `gatekeeper init-control --force` 重跑时会重新\n" +
	"# 探测并覆盖本文件，届时手改内容会丢失。`triage --run`/`init --run` 在没有显式\n" +
	"# --agent-command/GATEKEEPER_AGENT_COMMAND、也没有 .gatekeeper.yml 的 agent.command 时，会把\n" +
	"# 本文件的 deep-reasoner/coder 分派作为兜底命令来源（见 src/agent/resolve.ts）。\n";

/**
 * Renders `governance/agents.yaml`'s content from a detection + assignment
 * pass. Pure formatting -- writing to disk is the caller's job (see
 * src/commands/init-control.ts's writeArtifact, same idempotency posture as
 * every other init-control template).
 */
export function renderAgentsFile(input: {
	detected: readonly DetectedAgentCli[];
	assignments: readonly RoleAssignment[];
	warnings: readonly string[];
}): string {
	const body = stringify({
		apiVersion: "gatekeeper/v1",
		assignments: input.assignments.map((assignment) => ({
			role: assignment.role,
			cli: assignment.cliName,
			vendor: assignment.vendor,
			command_template: assignment.commandTemplate,
			rationale: assignment.rationale,
		})),
		detected: input.detected.map((cli) => ({
			name: cli.name,
			binary: cli.binary,
			vendor: cli.vendor,
			path: cli.path,
			version: cli.version,
		})),
		warnings: [...input.warnings],
	});
	return `${AGENTS_FILE_HEADER}${body}`;
}
