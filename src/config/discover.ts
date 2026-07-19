import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parseDocument } from "yaml";
import { z } from "zod";

/**
 * `.gatekeeper.yml` config discovery: a single, shared implementation of
 * "find the nearest workspace config, apply it as a defaults layer under
 * explicit CLI flags" so every command consumes already-resolved values
 * instead of re-implementing directory walking or priority ordering.
 *
 * This module does filesystem I/O (directory walk, file read) and therefore
 * lives outside `src/engine/` (pure-engine zone) — same split as
 * `src/providers/fsregistry.ts` versus `src/engine/registry.ts`.
 */

export const GATEKEEPER_CONFIG_FILENAME = ".gatekeeper.yml";

export class ConfigDiscoveryError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(reason);
		this.name = "ConfigDiscoveryError";
		this.reason = reason;
		if (options?.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

export interface GatekeeperAgentConfig {
	/** Shell command for the BYO agent runner (src/agent/runner.ts). May reference `{brief}`/`{out}` placeholders. */
	command: string;
	/** Wall-clock budget in seconds before SIGTERM. Defaults to 600 when the file omits it. */
	timeoutSeconds: number;
}

export interface GatekeeperConfig {
	apiVersion: "gatekeeper/v1";
	/** Raw value from the file, not yet resolved against the config file's directory. */
	registry?: string;
	repo?: string;
	base?: string;
	actor?: string;
	/** `triage --run` / `init --run`'s BYO coding-agent command. No default — omitting it disables `--run`. */
	agent?: GatekeeperAgentConfig;
}

export interface DiscoveredConfig {
	/** Absolute path to the discovered `.gatekeeper.yml`. */
	path: string;
	/** Absolute path to the directory containing it (relative `registry:` values resolve against this). */
	dir: string;
	config: GatekeeperConfig;
}

const KNOWN_CONFIG_KEYS = new Set(["apiVersion", "registry", "repo", "base", "actor", "agent"]);

/**
 * Upper bound for `agent.timeout_seconds` -- generous enough for a slow
 * drafting run, small enough to bound a runaway `--run` invocation. Also the
 * shared cap for --run's tier-1 `--agent-command`/`--agent-timeout` and
 * `GATEKEEPER_AGENT_TIMEOUT_SECONDS` overrides (see src/agent/resolve.ts) --
 * exported so every timeout entry point enforces the exact same ceiling
 * instead of each copying the literal 3600.
 */
export const MAX_AGENT_TIMEOUT_SECONDS = 3600;
export const DEFAULT_AGENT_TIMEOUT_SECONDS = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict schema plus `x-*` passthrough — same shape as engine/schema.ts's extensibleStrictObject, kept local since config/ is outside the engine's public schema surface. */
function rejectUnknownConfigKeys(value: unknown, context: z.RefinementCtx): void {
	if (!isRecord(value)) {
		return;
	}
	for (const key of Object.keys(value)) {
		if (KNOWN_CONFIG_KEYS.has(key) || key.startsWith("x-")) {
			continue;
		}
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: [key],
			message: `Unknown key "${key}" (expected apiVersion/registry/repo/base/actor/agent, or an x-* extension)`,
		});
	}
}

const gatekeeperConfigSchema = z.preprocess(
	(value, context) => {
		rejectUnknownConfigKeys(value, context);
		return value;
	},
	z
		.object({
			apiVersion: z.literal("gatekeeper/v1"),
			registry: z.string().min(1).optional(),
			repo: z.string().min(1).optional(),
			base: z.string().min(1).optional(),
			actor: z.string().min(1).optional(),
			agent: z
				.object({
					command: z.string().min(1),
					timeout_seconds: z.number().int().positive().max(MAX_AGENT_TIMEOUT_SECONDS).optional(),
				})
				.strict()
				.optional(),
		})
		.passthrough(),
);

function issueLocation(issue: z.ZodIssue): string {
	return issue.path.length > 0 ? `$.${issue.path.join(".")}` : "$";
}

function parseConfigDocument(filePath: string, content: string): GatekeeperConfig {
	const document = parseDocument(content, { prettyErrors: false, uniqueKeys: true });
	if (document.errors.length > 0) {
		throw new ConfigDiscoveryError(`${filePath}: invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`);
	}

	let value: unknown;
	try {
		value = document.toJS();
	} catch (error) {
		throw new ConfigDiscoveryError(
			`${filePath}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}

	if (!isRecord(value)) {
		throw new ConfigDiscoveryError(`${filePath}: must be a YAML mapping with apiVersion: gatekeeper/v1`);
	}

	const result = gatekeeperConfigSchema.safeParse(value);
	if (!result.success) {
		const issue = result.error.issues[0];
		const location = issue ? issueLocation(issue) : "$";
		throw new ConfigDiscoveryError(`${filePath}: ${location}: ${issue?.message ?? "invalid config"}`);
	}

	const parsed = result.data;
	const config: GatekeeperConfig = { apiVersion: "gatekeeper/v1" };
	if (parsed.registry !== undefined) {
		config.registry = parsed.registry;
	}
	if (parsed.repo !== undefined) {
		config.repo = parsed.repo;
	}
	if (parsed.base !== undefined) {
		config.base = parsed.base;
	}
	if (parsed.actor !== undefined) {
		config.actor = parsed.actor;
	}
	if (parsed.agent !== undefined) {
		config.agent = {
			command: parsed.agent.command,
			timeoutSeconds: parsed.agent.timeout_seconds ?? DEFAULT_AGENT_TIMEOUT_SECONDS,
		};
	}
	return config;
}

async function isFile(candidate: string): Promise<boolean> {
	try {
		return (await stat(candidate)).isFile();
	} catch {
		return false;
	}
}

async function isGitTop(dir: string): Promise<boolean> {
	try {
		await stat(path.join(dir, ".git"));
		return true;
	} catch {
		return false;
	}
}

/**
 * Search upward from `cwd` for `.gatekeeper.yml`, stopping (inclusive) at
 * whichever comes first: the filesystem root, or the directory containing
 * `.git` (the repository top). Returns `null` when no config file exists in
 * that range — this is the ordinary "not adopted yet" case, not an error.
 *
 * A config file that *does* exist but fails to parse/validate always throws
 * `ConfigDiscoveryError` ("config file damage is a config error"); callers
 * choose fail-open (check/gate) or fail-loud (validate/doctor/audit/stats/
 * triage/init) handling for that error per the fail-direction law.
 */
export async function discoverConfig(cwd: string): Promise<DiscoveredConfig | null> {
	let dir = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(dir, GATEKEEPER_CONFIG_FILENAME);
		if (await isFile(candidate)) {
			let content: string;
			try {
				content = await readFile(candidate, "utf8");
			} catch (error) {
				throw new ConfigDiscoveryError(
					`failed to read ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
			return { path: candidate, dir, config: parseConfigDocument(candidate, content) };
		}

		const atGitTop = await isGitTop(dir);
		const parent = path.dirname(dir);
		if (atGitTop || parent === dir) {
			return null;
		}
		dir = parent;
	}
}

export interface RegistryOptionInput {
	/** Explicit --registry CLI flag value, if given. */
	cliValue?: string;
	/** Process (or injected) environment; only GATEKEEPER_REGISTRY is consulted. */
	env?: NodeJS.ProcessEnv;
	discovered: DiscoveredConfig | null;
}

/**
 * Resolve the registry path: explicit `--registry` wins, then
 * `GATEKEEPER_REGISTRY` (registry only — no other field reads from the
 * environment), then `.gatekeeper.yml`'s `registry:` (resolved relative to
 * the config file's own directory so an adopted repo stays portable across
 * checkouts), otherwise `undefined` (caller reports the three-way hint).
 */
export function resolveRegistryOption(input: RegistryOptionInput): string | undefined {
	if (input.cliValue) {
		return input.cliValue;
	}
	const env = input.env ?? process.env;
	if (env.GATEKEEPER_REGISTRY) {
		return env.GATEKEEPER_REGISTRY;
	}
	const configured = input.discovered?.config.registry;
	if (!configured) {
		return undefined;
	}
	return path.isAbsolute(configured) ? configured : path.resolve(input.discovered?.dir ?? process.cwd(), configured);
}

/**
 * Resolve a `repo` / `base` / `actor` field: explicit CLI flag wins,
 * otherwise `.gatekeeper.yml`'s matching field (no environment-variable
 * layer for these — only `registry` has one, per GATEKEEPER_REGISTRY).
 * `undefined` falls through to each command's pre-existing auto-detection
 * (git remote / git config / GITHUB_REPOSITORY, depending on the command).
 */
export function resolveConfiguredField(
	cliValue: string | undefined,
	discovered: DiscoveredConfig | null,
	field: "repo" | "base" | "actor",
): string | undefined {
	return cliValue ?? discovered?.config[field];
}

/** Shared "how do I provide a registry" hint for the three-way message check/gate/validate/doctor/audit/triage print when none of CLI/env/config resolve one. */
export function missingRegistryMessage(command: string): string {
	return (
		`gatekeeper ${command}: --registry is required; provide --registry <dir>, set GATEKEEPER_REGISTRY, ` +
		`or add a ${GATEKEEPER_CONFIG_FILENAME} with a "registry:" field (see \`gatekeeper adopt\`).`
	);
}

/**
 * Shared "how do I configure --run's agent" hint for `triage --run`/`init
 * --run` when none of src/agent/resolve.ts's three resolution tiers produced
 * a command. There is deliberately no default command -- `--run` only ever
 * executes a coding-agent CLI the user (or `init-control`'s detection pass)
 * named (see src/agent/runner.ts's trust-boundary note). Both `.gatekeeper.yml`
 * example lines are placeholders: adjust the flags to whatever your local
 * Codex/Grok (or any other) CLI actually accepts.
 */
export function missingAgentMessage(command: string): string {
	return (
		`gatekeeper ${command} --run: no agent command could be resolved. Checked, in priority order:\n` +
		"  1. --agent-command / GATEKEEPER_AGENT_COMMAND -- not given\n" +
		`  2. no "agent:" block configured in ${GATEKEEPER_CONFIG_FILENAME}\n` +
		"  3. no matching role assignment in a located governance/agents.yaml (run `gatekeeper init-control` " +
		"to detect local agent CLIs and generate one)\n\n" +
		`Add an "agent:" block to ${GATEKEEPER_CONFIG_FILENAME}, e.g.:\n\n` +
		"agent:\n" +
		'  command: "codex exec --full-auto < {brief} > {out}"   # adjust to your local Codex CLI\'s actual flags\n' +
		"  timeout_seconds: 600\n\n" +
		"or, for a CLI that takes an explicit prompt-file flag instead of stdin:\n\n" +
		"agent:\n" +
		'  command: "grok --prompt-file {brief} > {out}"   # adjust to your local Grok CLI\'s actual flags\n'
	);
}
