import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { renderAgentsFile } from "../agent/agentsFile.js";
import { assignRolesToClis } from "../agent/assign.js";
import { type DetectedAgentCli, detectAgentClis } from "../agent/detect.js";
import { upsertControl } from "../config/controls.js";
import { saveRepos } from "../config/repos.js";
import { packagedRoleCardPath, ROLE_CARD_NAMES, RoleCardNotFoundError } from "../roles/cards.js";
import { defaultRolesPolicyPath, parseRolesPolicy, RolesPolicyParseError } from "../roles/policy.js";
import { runValidate } from "./validate.js";

/**
 * `gatekeeper init-control <path> [--force]`: one-command scaffold for a
 * brand-new control/hub repo -- the checkout `gatekeeper adopt --control`
 * later points at (see src/commands/adopt.ts's REGISTRY_CANDIDATE_SUBPATHS,
 * which this command's layout matches exactly: `governance/registry` holding
 * `policy.yaml`).
 *
 * Every template artifact is generated idempotently: an existing file is
 * left alone (skipped, not silently clobbered) unless --force is given,
 * mirroring `gatekeeper provision`'s per-artifact idempotency posture.
 * `repos.yaml` is the one exception -- see writeReposArtifact's doc comment
 * -- it is never overwritten by --force, because it is not a template: it is
 * stateful data exclusively owned by `gatekeeper adopt`, and clobbering it
 * would silently erase every already-registered repo.
 *
 * After writing (or skipping) everything, the freshly located registry is
 * run through `gatekeeper validate` and the result is printed either way --
 * a fresh scaffold is expected to validate clean, but a rerun over a
 * since-customized registry should still surface real problems rather than
 * silently declaring success.
 *
 * Unless `--no-detect` is given, this command also probes the local machine
 * for known agent CLIs (src/agent/detect.ts) and assigns each roles-policy
 * tier to one (src/agent/assign.ts), writing the result to
 * `governance/agents.yaml` (src/agent/agentsFile.ts). Unlike `repos.yaml`,
 * `governance/agents.yaml` *is* a regenerable template: `--force` re-detects
 * and overwrites it (a hand-edited copy would be lost) -- see its own header
 * comment. Unconditionally (even under --no-detect, since this is a
 * validation of the control repo's own config, not part of the detection
 * step it gates), this command reads the control repo's *own*
 * `roles-policy.yaml` off disk at this point (freshly written from the
 * packaged default, or a pre-existing hand-customized copy a skip left
 * untouched) -- never the in-memory packaged content -- and fails closed
 * (exit 2) if that file exists but fails to parse, rather than silently
 * falling back to packaged tier preferences.
 *
 * After the registry directory exists (policy.yaml/repos.yaml written or
 * left untouched), this command also registers *itself* in this machine's
 * user-level controls index (`~/.config/gatekeeper/controls.yaml`, see
 * src/config/controls.ts) -- the same registration `gatekeeper adopt` does
 * for a control it points `--control` at. Because a control repo never
 * adopts itself into its own `repos.yaml` (adopt refuses overlapping
 * control/target repos), `locateOwningControl`'s reverse lookup falls back
 * to a *self-match* (registry only, no repo identity -- there is no roster
 * entry to take one from) whenever the repo root being looked up is this
 * control's own root. That self-match is what actually lets a freshly
 * `init-control`'d hub be found by other commands' zero-flag config
 * discovery (src/config/discover.ts's discoverConfigWithControlsIndex,
 * src/config/controls.ts's locateOwningControl) from inside itself, without
 * a `.gatekeeper.yml` -- registration here alone is necessary but not
 * sufficient; see locateOwningControl's own doc comment for the matching
 * logic this registration feeds.
 */

export interface InitControlOptions {
	/** Control repo root to create/populate; resolved relative to cwd. */
	path: string;
	force?: boolean;
	/** Set to false (via --no-detect) to skip local agent CLI detection and governance/agents.yaml generation entirely. Defaults to true (detect). */
	detect?: boolean;
}

export interface InitControlDependencies {
	/** Injectable local-CLI detector (defaults to detectAgentClis) -- tests stub PATH/spawn without touching the real machine. */
	detectAgentClis?: typeof detectAgentClis;
	/** Injectable clock for the controls index `registered_at` timestamp. */
	now?: () => string;
	/** Process (or injected) environment; only GATEKEEPER_CONFIG_DIR is consulted (controls index location). */
	env?: NodeJS.ProcessEnv;
}

interface GeneratedLine {
	relativePath: string;
	action: "wrote" | "overwrote" | "skipped" | "skipped-stateful";
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await stat(candidate);
		return true;
	} catch {
		return false;
	}
}

/**
 * Write `content` to `filePath` unless it already exists and `force` is
 * false, in which case the existing file is left untouched. Always creates
 * `filePath`'s parent directory (so callers never need a separate `mkdir`
 * for the directory an artifact lives in).
 */
async function writeArtifact(
	controlRoot: string,
	filePath: string,
	content: string,
	force: boolean,
	lines: GeneratedLine[],
): Promise<void> {
	const relativePath = path.relative(controlRoot, filePath);
	const exists = await pathExists(filePath);
	if (exists && !force) {
		lines.push({ relativePath, action: "skipped" });
		return;
	}
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, content, "utf8");
	lines.push({ relativePath, action: exists ? "overwrote" : "wrote" });
}

const POLICY_YAML = `apiVersion: gatekeeper/v1
# Gatekeeper control registry: policy.yaml
#
# Generated by \`gatekeeper init-control\`. This is a minimal, working starting
# point covering both required enforcement shapes -- edit every section below
# to fit your organization:
#
#   - \`levels\`: add/rename levels, tune \`enforcement\` (block | warn) and
#     \`require\` (an m-of-n lane count) per level. See docs/SPEC.md for the
#     full level/lane vocabulary.
#   - \`lanes\` is intentionally omitted here: \`validate\`/\`check\`/\`gate\` merge
#     the packaged \`lanes.d/*.yaml\` presets (human/coderabbit/copilot/
#     greptile) into an absent \`policy.lanes\` (see docs/SPEC.md section 1.1).
#     The \`human\` lane referenced below therefore resolves to
#     lanes.d/human.yaml (min: 1, fresh: true) without redeclaring it here.
#     Add a top-level \`lanes:\` block to override or extend a preset
#     (user-wins on a name collision).
#   - \`contracts/\`: add one YAML file per contract; see
#     contracts/_example.yaml.txt for a fully annotated template (its .txt
#     suffix keeps it out of the registry -- only contracts/*.yaml / *.yml
#     parse).
#   - repos.yaml (next to this file): registered by \`gatekeeper adopt\`, never
#     hand-edited. \`gatekeeper init-control --force\` never overwrites an
#     existing repos.yaml -- it is live state, not a template.
#   - ../roles/*.md (this control repo's own role-card copies) and
#     ../../roles-policy.yaml (this control repo's model-tier preferences):
#     both are safe to hand-edit -- see their own header comments.
levels:
  breaking-review-required:
    enforcement: block
    require:
      m: 1
      lanes:
        - human
  notify-only:
    enforcement: warn
    require: {}
`;

const EXAMPLE_CONTRACT_TXT = `# Example contract -- copy this file to contracts/<name>.yaml and fill it in.
# The .txt suffix keeps this template out of the registry: only
# contracts/*.yaml / *.yml files are parsed (see src/providers/fsregistry.ts).
#
# Full annotated field reference (see src/engine/schema.ts / docs/SPEC.md for
# the authoritative schema):

apiVersion: gatekeeper/v1        # required, literal "gatekeeper/v1"

name: example-contract           # required; ^[a-z0-9][a-z0-9-]*$, unique across the registry

description: >-                  # optional; one paragraph, human-readable context for reviewers
  One-paragraph explanation of what this contract protects and why a change
  under authority.paths requires the consumers below to react.

level: notify-only               # required; must name a level declared in policy.yaml

authority:                       # required; the single repo/paths that "own" this shape
  repo: org/producer-repo        # required
  paths:                         # required, at least one glob
    - src/shared/schema.ts
  exclude:                       # optional; globs to carve back out of paths
    - src/shared/schema.test.ts
  if_content: "BREAKING"         # optional regex; contract only fires when the diff content matches

consumers:                       # optional, defaults to []; repos that must react when authority changes
  - repo: org/consumer-repo      # required
    paths:                       # required, at least one glob (relative to *this* consumer's own root)
      - src/generated/schema.ts
    exclude: []                  # optional
    verify: "npm test"           # optional; human-readable note on what "in sync" means
    role: consumer                # consumer (should update) | producer (also owns it) | mirror-frozen (must not diverge)
    allow_actors: []             # required (non-empty) only when role: mirror-frozen -- who may edit anyway
    if_content: "BREAKING"       # optional regex, same semantics as authority.if_content
`;

const ROLE_CARD_HEADER =
	"<!-- 本副本由 `gatekeeper init-control` 生成，可按组织定制；`gatekeeper triage`/`gatekeeper init` 简报优先引用本副本（governance/roles/），而非包内默认版本。 -->\n\n";

const ROLES_POLICY_HEADER = `# 本文件由 \`gatekeeper init-control\` 生成，是这个总控仓自己的 roles-policy.yaml 副本。
# 按需调整每个角色档位（tiers.<role>.prefer / count / cross_vendor）以匹配你组织
# 实际可用的模型队形；从这个控制仓根目录运行 \`gatekeeper doctor\`/\`gatekeeper triage\`
# 时会优先读取 <cwd>/roles-policy.yaml（即本文件），缺失时才回落到包内默认版本
# （见 src/roles/policy.ts 的 resolveRolesPolicyPath）。
`;

/**
 * Write an empty `repos.yaml` roster (via saveRepos, reusing its shared
 * serialization -- see the module doc comment) only when one does not
 * already exist. Unlike every other writeArtifact-driven artifact,
 * `--force` never applies here: `repos.yaml` is not a template, it is the
 * live roster `gatekeeper adopt` upserts entries into, and blindly
 * resetting it to `repos: []` on a rerun would silently discard every
 * already-registered repo (T-20260719-05 R1 finding -- a live-data-loss
 * regression, not a cosmetic one). An existing `repos.yaml` is therefore
 * always left untouched, regardless of `force`.
 */
async function writeReposArtifact(controlRoot: string, registryDir: string, lines: GeneratedLine[]): Promise<void> {
	const reposPath = path.join(registryDir, "repos.yaml");
	const relativePath = path.relative(controlRoot, reposPath);
	if (await pathExists(reposPath)) {
		lines.push({ relativePath, action: "skipped-stateful" });
		return;
	}
	// registryDir already exists by this point (policy.yaml write above
	// creates it) -- saveRepos itself does not mkdir.
	await saveRepos(registryDir, []);
	lines.push({ relativePath, action: "wrote" });
}

function summarize(lines: GeneratedLine[]): string[] {
	return lines.map((line) => {
		if (line.action === "skipped") {
			return `  skipped ${line.relativePath} (already exists; rerun with --force to overwrite)`;
		}
		if (line.action === "skipped-stateful") {
			return `  skipped ${line.relativePath} (stateful, owned by \`gatekeeper adopt\`; --force never overwrites it)`;
		}
		return `  ${line.action} ${line.relativePath}`;
	});
}

export async function runInitControl(
	options: InitControlOptions,
	cwd: string,
	dependencies: InitControlDependencies = {},
): Promise<number> {
	const controlRoot = path.resolve(cwd, options.path);
	const force = Boolean(options.force);
	await mkdir(controlRoot, { recursive: true });

	const registryDir = path.join(controlRoot, "governance", "registry");
	const contractsDir = path.join(registryDir, "contracts");
	const rolesDir = path.join(controlRoot, "governance", "roles");

	const lines: GeneratedLine[] = [];

	await writeArtifact(controlRoot, path.join(registryDir, "policy.yaml"), POLICY_YAML, force, lines);
	await writeArtifact(controlRoot, path.join(contractsDir, "_example.yaml.txt"), EXAMPLE_CONTRACT_TXT, force, lines);

	await writeReposArtifact(controlRoot, registryDir, lines);

	// Self-register in the user-level controls index (see this command's own
	// doc comment above) -- registryDir already exists by this point (the
	// policy.yaml write above creates it, whether or not it was skipped).
	const controlRootRealPath = await realpath(controlRoot);
	const registryRealPath = await realpath(registryDir);
	const now = dependencies.now ?? (() => new Date().toISOString());
	await upsertControl(
		{ control: controlRootRealPath, registry: registryRealPath, registered_at: now() },
		dependencies.env ?? process.env,
	);

	for (const card of ROLE_CARD_NAMES) {
		const sourcePath = packagedRoleCardPath(card);
		if (!(await pathExists(sourcePath))) {
			process.stderr.write(`gatekeeper init-control: ${new RoleCardNotFoundError(card, [sourcePath]).message}\n`);
			return 2;
		}
		const sourceContent = await readFile(sourcePath, "utf8");
		await writeArtifact(controlRoot, path.join(rolesDir, `${card}.md`), ROLE_CARD_HEADER + sourceContent, force, lines);
	}

	const rolesPolicySourcePath = defaultRolesPolicyPath();
	if (!(await pathExists(rolesPolicySourcePath))) {
		process.stderr.write(`gatekeeper init-control: packaged roles-policy.yaml not found: ${rolesPolicySourcePath}\n`);
		return 2;
	}
	const rolesPolicySourceContent = await readFile(rolesPolicySourcePath, "utf8");
	await writeArtifact(
		controlRoot,
		path.join(controlRoot, "roles-policy.yaml"),
		ROLES_POLICY_HEADER + rolesPolicySourceContent,
		force,
		lines,
	);

	// Read + parse the control repo's *own* roles-policy.yaml on disk -- not the in-memory
	// packaged content read above -- so a hand-customized copy (e.g. from a prior --no-detect
	// run, then hand-edited, then rerun) is honored rather than silently overridden by the
	// packaged default's tier prefer/count/cross_vendor values. writeArtifact above guarantees
	// this file exists by this point (freshly written, or a pre-existing customization left
	// untouched by a skip) -- falling back to the packaged content is therefore only a
	// defensive degrade for the unexpected case where it's still missing, not the routine path.
	//
	// This validation runs *unconditionally*, regardless of --no-detect: an existing-but-
	// malformed roles-policy.yaml is a real configuration defect (most likely a bad hand-edit)
	// that must fail closed every time this command touches the control repo, not only on runs
	// that happen to also perform detection. Only the detection/assignment/agents.yaml-writing
	// work below is gated on `options.detect`.
	const controlRolesPolicyPath = path.join(controlRoot, "roles-policy.yaml");
	const rolesPolicyContentForAssignment = (await pathExists(controlRolesPolicyPath))
		? await readFile(controlRolesPolicyPath, "utf8")
		: rolesPolicySourceContent;

	let rolesPolicy: ReturnType<typeof parseRolesPolicy>;
	try {
		rolesPolicy = parseRolesPolicy(rolesPolicyContentForAssignment, controlRolesPolicyPath);
	} catch (error) {
		if (!(error instanceof RolesPolicyParseError)) {
			throw error;
		}
		// Fail-closed: an existing-but-malformed roles-policy.yaml is a real configuration
		// defect that must never be silently swallowed into "just use the packaged defaults
		// instead" -- the operator needs to fix it.
		process.stderr.write(
			`gatekeeper init-control: control repo's roles-policy.yaml (${controlRolesPolicyPath}) failed to parse: ${error.message}\n`,
		);
		return 2;
	}

	let detected: DetectedAgentCli[] = [];
	let assignSummary: { assignments: ReturnType<typeof assignRolesToClis>["assignments"]; warnings: string[] } = {
		assignments: [],
		warnings: [],
	};
	if (options.detect !== false) {
		detected = await (dependencies.detectAgentClis ?? detectAgentClis)();
		assignSummary = assignRolesToClis({ detected, rolesPolicy });
		await writeArtifact(
			controlRoot,
			path.join(controlRoot, "governance", "agents.yaml"),
			renderAgentsFile({ detected, assignments: assignSummary.assignments, warnings: assignSummary.warnings }),
			force,
			lines,
		);
	}

	process.stdout.write(`gatekeeper init-control: ${lines.length} artifact(s) at ${controlRoot}\n`);
	for (const line of summarize(lines)) {
		process.stdout.write(`${line}\n`);
	}
	process.stdout.write(
		`gatekeeper init-control: registered control ${controlRootRealPath} in the local controls index\n`,
	);

	if (options.detect === false) {
		process.stdout.write("\ngatekeeper init-control: skipped agent CLI detection (--no-detect)\n");
	} else {
		process.stdout.write("\ngatekeeper init-control: detected agent CLI(s):\n");
		if (detected.length === 0) {
			process.stdout.write(
				"  (none found on PATH -- see KNOWN_AGENT_CLIS in src/agent/detect.ts for the supported list)\n",
			);
		} else {
			for (const cli of detected) {
				process.stdout.write(`  ${cli.name} (${cli.vendor}) ${cli.version ?? "version unknown"} -- ${cli.path}\n`);
			}
		}
		process.stdout.write("\ngatekeeper init-control: role assignment:\n");
		if (assignSummary.assignments.length === 0) {
			process.stdout.write("  (no role could be assigned from detected agent CLIs)\n");
		} else {
			for (const assignment of assignSummary.assignments) {
				process.stdout.write(`  ${assignment.role}: ${assignment.cliName} (${assignment.vendor})\n`);
			}
		}
		for (const warning of assignSummary.warnings) {
			process.stderr.write(`warning: ${warning}\n`);
		}
	}

	process.stdout.write("\ngatekeeper init-control: validating the generated registry...\n");
	const validateOutput: string[] = [];
	const validateWarnings: string[] = [];
	const validateExitCode = await runValidate(
		{
			registry: registryDir,
			stdout: (chunk) => validateOutput.push(chunk),
			stderr: (chunk) => validateWarnings.push(chunk),
		},
		cwd,
	);
	for (const line of validateWarnings) {
		process.stderr.write(line);
	}
	for (const line of validateOutput) {
		process.stdout.write(line);
	}
	if (validateExitCode !== 0) {
		process.stderr.write(
			`gatekeeper init-control: the generated registry at ${registryDir} did not pass validate; see warnings above\n`,
		);
	}
	return validateExitCode;
}
