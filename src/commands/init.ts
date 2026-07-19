import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Command } from "commander";

import { ConfigDiscoveryError, discoverConfig } from "../config/discover.js";
import { renderInitBrief } from "../init/brief.js";
import { RepoAccessError, scanRepos } from "../init/scan.js";

export interface InitOptions {
	repos: string[];
	out: string;
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
export async function runInit(options: InitOptions, cwd: string): Promise<number> {
	// `init` consumes no .gatekeeper.yml field (it has no --registry/--repo/--base/--actor
	// equivalent — it drafts a registry, it doesn't consume one), but config discovery
	// still runs here for the same fail-loud reason as validate/doctor/triage: a damaged
	// config file nearby is worth surfacing loudly to a local-authoring tool rather than
	// silently ignoring it.
	try {
		await discoverConfig(cwd);
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
	process.stdout.write(
		"Next step: hand init-brief.md to any coding agent (Claude Code / Codex / Cursor / pi / ...) running the " +
			"registry-drafter role per docs/roles/registry-drafter.md (in pi you can also run /gatekeeper-init) to draft " +
			"contracts/policy YAML from the candidates above, then run `gatekeeper validate --registry <dir>` to close the loop.\n",
	);

	return 0;
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
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
		.action(async (options) => {
			process.exitCode = await runInit(options, process.cwd());
		});
}
