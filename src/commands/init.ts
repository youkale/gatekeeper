import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { type Command, InvalidArgumentError } from "commander";

import { AgentTimeoutRangeError, resolveAgentCommand } from "../agent/resolve.js";
import { AgentRunError, runAgentCommand } from "../agent/runner.js";
import {
	ConfigDiscoveryError,
	type DiscoveredConfig,
	discoverConfigWithControlsIndex,
	MAX_AGENT_TIMEOUT_SECONDS,
	missingAgentMessage,
	resolveRegistryOption,
} from "../config/discover.js";
import { renderInitBrief } from "../init/brief.js";
import { RepoAccessError, scanRepos } from "../init/scan.js";
import { resolveRoleCardPath } from "../roles/cards.js";
import { runValidate } from "./validate.js";

export interface InitOptions {
	repos: string[];
	out: string;
	/** Run the resolved agent (see src/agent/resolve.ts's three-tier chain) against the brief to draft a registry, then validate --strict it. */
	run?: boolean;
	/** --run's tier-1 explicit agent command override (see src/agent/resolve.ts). */
	agentCommand?: string;
	/** Wall-clock budget in seconds for --agent-command; ignored unless agentCommand is also given. */
	agentTimeout?: number;
}

export interface InitDependencies {
	/** Process (or injected) environment; forwarded to config discovery's controls-index fallback (only GATEKEEPER_CONFIG_DIR is consulted there -- see src/config/controls.ts). */
	env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the registry-drafter role card path to point the printed next-step
 * hint at: `init` consumes no `.gatekeeper.yml` field of its own, but a
 * `discovered` config's `registry:` (if any -- `init` has no `--registry`
 * flag, so only env/config can supply one here) is enough to prefer a
 * control repo's own customized `governance/roles/registry-drafter.md` over
 * the packaged default (see src/roles/cards.ts's resolveRoleCardPath). The
 * packaged copy always ships with the package, so a lookup failure here is
 * an installation anomaly, not a routine "not customized" state -- degrade
 * to the literal fallback path rather than failing the whole command over a
 * printed hint.
 */
function resolveRegistryDrafterCardPath(discovered: DiscoveredConfig | null): string {
	try {
		return resolveRoleCardPath("registry-drafter", resolveRegistryOption({ discovered }));
	} catch (error) {
		process.stderr.write(
			`warning: could not locate the registry-drafter role card: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return "docs/roles/registry-drafter.md";
	}
}

/**
 * Fixed instructions appended (only for --run) to the brief handed to the
 * agent: tells it exactly where to write its draft and in what shape, so the
 * resulting directory can be validated standalone.
 */
function renderRunInstructions(draftDir: string): string {
	return (
		"\n---\n\n" +
		"## --run draft-output instructions\n\n" +
		`Write your drafted registry into ${draftDir} as a self-contained directory: a minimal ` +
		"policy.yaml (declaring at least the level(s) your drafted contracts reference) plus one " +
		"contracts/<name>.yaml file per candidate contract above, so the directory can be validated " +
		"standalone with `gatekeeper validate --strict`. Do not write anywhere else.\n"
	);
}

/**
 * `gatekeeper init`: deterministic three-step handoff.
 *
 * 1. Scan local repo checkouts for candidate contract signals (zero model, zero network).
 * 2. Render the scan into a markdown brief for the registry-drafter role.
 * 3. Write both to --out and print the next-step instruction — drafting/parsing/model
 *    work happens outside this process, in any coding agent (per docs/roles/) or by hand.
 *
 * `init` is a local authoring tool, not a merge gate: unlike `check`/`gate` it must
 * fail loudly (non-zero exit, structured stderr) on a bad --repos path rather than
 * fail open with an empty brief -- there is no downstream policy decision to protect
 * from an infrastructure hiccup here, only a human about to be handed misleading output.
 */
export async function runInit(options: InitOptions, cwd: string, dependencies: InitDependencies = {}): Promise<number> {
	// `init` consumes no .gatekeeper.yml field (it has no --registry/--repo/--base/--actor
	// equivalent — it drafts a registry, it doesn't consume one), but config discovery
	// (including the user-level controls index fallback) still runs here for the same
	// fail-loud reason as validate/doctor/triage: a damaged config file nearby is worth
	// surfacing loudly to a local-authoring tool rather than silently ignoring it.
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
		process.stderr.write(`gatekeeper init: ${error.reason}\n`);
		return 2;
	}

	const repos = options.repos ?? [];
	if (repos.length === 0) {
		process.stderr.write("gatekeeper init: at least one --repos <path> is required\n");
		return 2;
	}
	if (!options.out) {
		process.stderr.write("gatekeeper init: --out <dir> is required\n");
		return 2;
	}

	const resolvedRepos = repos.map((repoPath) => path.resolve(cwd, repoPath));

	let scan: Awaited<ReturnType<typeof scanRepos>>;
	try {
		scan = await scanRepos(resolvedRepos);
	} catch (error) {
		if (error instanceof RepoAccessError) {
			process.stderr.write(`gatekeeper init: ${error.message}\n`);
			for (const issue of error.issues) {
				process.stderr.write(`  ${issue.root}: ${issue.reason}\n`);
			}
			return 2;
		}
		throw error;
	}

	if (scan.repoLabelCollisions.length > 0) {
		process.stderr.write(
			`warning: repo basename collision(s) disambiguated by parent directory: ${scan.repoLabelCollisions.join(", ")}\n`,
		);
	}
	if (scan.skipped.unreadable > 0 || scan.skipped.oversized > 0) {
		process.stderr.write(
			`warning: skipped ${scan.skipped.unreadable} unreadable file(s) and ${scan.skipped.oversized} oversized file(s) during scan\n`,
		);
	}

	const outDir = path.resolve(cwd, options.out);
	await mkdir(outDir, { recursive: true });

	const scanJsonPath = path.join(outDir, "scan.json");
	const briefPath = path.join(outDir, "init-brief.md");
	await writeFile(scanJsonPath, `${JSON.stringify(scan, null, 2)}\n`, "utf8");
	await writeFile(briefPath, renderInitBrief(scan), "utf8");

	process.stdout.write(
		`gatekeeper init: found ${scan.signals.length} candidate signal(s) across ${scan.repos.length} repo(s)\n`,
	);
	process.stdout.write(`  ${scanJsonPath}\n`);
	process.stdout.write(`  ${briefPath}\n\n`);

	if (!options.run) {
		const registryDrafterCardPath = resolveRegistryDrafterCardPath(discovered);
		process.stdout.write(
			"Next step: hand init-brief.md to any coding agent (Claude Code / Codex / Cursor / pi / ...) running the " +
				`registry-drafter role per ${registryDrafterCardPath} (in pi you can also run /gatekeeper-init) to draft ` +
				"contracts/policy YAML from the candidates above, then run `gatekeeper validate --registry <dir>` to close the loop.\n",
		);
		return 0;
	}

	// init has no --registry flag of its own; only env/config can supply a registry to locate a
	// sibling governance/agents.yaml against (same as resolveRegistryDrafterCardPath above).
	const registryPath = resolveRegistryOption({ discovered });
	// registry-drafter is a coder-tier task (see roles-policy.yaml's tiers) -- tier 3 falls back
	// to governance/agents.yaml's coder assignment, not deep-reasoner's.
	let resolvedAgent: Awaited<ReturnType<typeof resolveAgentCommand>>;
	try {
		resolvedAgent = await resolveAgentCommand({
			cliCommand: options.agentCommand,
			cliTimeoutSeconds: options.agentTimeout,
			discovered,
			registryPath,
			role: "coder",
		});
	} catch (error) {
		if (!(error instanceof AgentTimeoutRangeError)) {
			throw error;
		}
		process.stderr.write(`gatekeeper init --run: ${error.message}\n`);
		return 2;
	}
	if (!resolvedAgent) {
		process.stderr.write(`${missingAgentMessage("init")}\n`);
		return 2;
	}
	process.stdout.write(`gatekeeper init --run: ${resolvedAgent.description}\n`);

	const draftDir = path.join(outDir, "registry-draft");
	const runBriefPath = path.join(outDir, "run-brief.md");
	await writeFile(runBriefPath, renderInitBrief(scan) + renderRunInstructions(draftDir), "utf8");

	try {
		await runAgentCommand({
			command: resolvedAgent.command,
			timeoutSeconds: resolvedAgent.timeoutSeconds,
			briefPath: runBriefPath,
			outPath: draftDir,
			cwd,
			env: process.env,
		});
	} catch (error) {
		if (!(error instanceof AgentRunError)) {
			throw error;
		}
		process.stderr.write(`gatekeeper init --run: ${error.message}\n`);
		if (error.stderrTail) {
			process.stderr.write(`--- agent stderr (tail) ---\n${error.stderrTail}\n`);
		}
		return 1;
	}

	const validateOutput: string[] = [];
	const validateWarnings: string[] = [];
	const validateExitCode = await runValidate(
		{
			registry: draftDir,
			strict: true,
			stdout: (chunk) => validateOutput.push(chunk),
			stderr: (chunk) => validateWarnings.push(chunk),
		},
		cwd,
	);

	if (validateExitCode !== 0) {
		process.stderr.write(`gatekeeper init --run: draft registry at ${draftDir} failed validate --strict:\n`);
		for (const line of validateWarnings) {
			process.stderr.write(line);
		}
		return 2;
	}

	// Strict validate only ever exits 0 when it produced zero warnings, so
	// validateWarnings is necessarily empty here -- nothing left to relay.
	for (const line of validateOutput) {
		process.stdout.write(line);
	}
	process.stdout.write(
		`gatekeeper init --run: draft registry at ${draftDir} passed validate --strict. Review it, then copy its ` +
			"contracts/*.yaml (and merge any new policy.yaml levels) into your real registry.\n",
	);
	return 0;
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

function positiveInteger(value: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new InvalidArgumentError("must be a positive integer");
	}
	return parsed;
}

/** Bounded variant of positiveInteger for --agent-timeout: enforces the same MAX_AGENT_TIMEOUT_SECONDS ceiling as .gatekeeper.yml's agent.timeout_seconds and GATEKEEPER_AGENT_TIMEOUT_SECONDS (see src/agent/resolve.ts). */
function agentTimeoutSeconds(value: string): number {
	const parsed = positiveInteger(value);
	if (parsed > MAX_AGENT_TIMEOUT_SECONDS) {
		throw new InvalidArgumentError(`must be at most ${MAX_AGENT_TIMEOUT_SECONDS} seconds`);
	}
	return parsed;
}

/**
 * Registers `gatekeeper init` on the given commander program. Not called from
 * src/cli.ts yet — wiring is owned by a separate task to avoid editing cli.ts
 * concurrently; callers wire this in with `registerInitCommand(program)`.
 */
export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description(
			"Scan local repo checkouts for candidate contract signals and draft a registry-authoring brief (zero model, zero network).",
		)
		.option("--repos <path>", "local repo root path to scan (repeatable)", collect, [])
		.requiredOption("--out <dir>", "output directory for scan.json and init-brief.md")
		.option(
			"--run",
			"run the resolved agent (see src/agent/resolve.ts's three-tier chain) against the brief to draft a registry into <out>/registry-draft, then validate --strict it",
			false,
		)
		.option(
			"--agent-command <cmd>",
			"--run's tier-1 explicit agent command override (defaults to GATEKEEPER_AGENT_COMMAND, then .gatekeeper.yml's agent.command, then governance/agents.yaml's coder assignment)",
		)
		.option(
			"--agent-timeout <seconds>",
			`wall-clock budget in seconds for --agent-command (max ${MAX_AGENT_TIMEOUT_SECONDS})`,
			agentTimeoutSeconds,
		)
		.action(async (options) => {
			process.exitCode = await runInit(options, process.cwd());
		});
}
