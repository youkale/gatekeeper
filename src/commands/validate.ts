import { formatRegistryIssue, RegistryParseError } from "../engine/registry.js";
import type { Registry, RegistryIssue } from "../engine/types.js";
import { LanePresetParseError, LanePresetReadError, loadRegistryWithLanePresets } from "../gate/presets.js";
import { RegistryReadError } from "../providers/fsregistry.js";

export interface ValidateOptions {
	registry: string;
	strict?: boolean;
	/**
	 * Output sinks. Optional and additive: default to the real
	 * process.stdout/stderr, so the CLI (src/cli.ts, which never sets these)
	 * is unchanged. A long-lived host that runs multiple commands
	 * concurrently over one process (e.g. the MCP server in
	 * integrations/mcp/index.ts, which may have another in-flight JSON-RPC
	 * response frame writing to the same real stdout at the same time)
	 * should inject its own sink instead of temporarily monkey-patching the
	 * global stream — see integrations/mcp/index.ts's runGatekeeperValidate
	 * for why that global-patch approach is unsafe in that context.
	 */
	stdout?: (chunk: string) => void;
	stderr?: (chunk: string) => void;
}

function isBareDoubleStar(glob: string): boolean {
	return glob.trim() === "**";
}

function lintGlobs(file: string, path: string, globs: string[] | undefined, warnings: RegistryIssue[]): void {
	for (const glob of globs ?? []) {
		if (isBareDoubleStar(glob)) {
			warnings.push({
				file,
				path,
				expected: 'a scoped glob (e.g. "src/**")',
				actual: JSON.stringify(glob),
				hint: 'A bare "**" matches every file in the repo; scope it with a directory prefix.',
			});
		}
	}
}

/**
 * CLI-level lint on top of parseRegistry's schema/foreign-key checks (which
 * already cover regex-compile failures and level/lane foreign keys): flags
 * overly broad bare "**" globs and mirror-frozen bindings that can never be
 * satisfied because allow_actors is empty.
 */
function lintRegistry(registry: Registry): RegistryIssue[] {
	const warnings: RegistryIssue[] = [];
	for (const contract of registry.contracts) {
		const file = `contract:${contract.name}`;
		lintGlobs(file, "$.authority.paths", contract.authority.paths, warnings);
		lintGlobs(file, "$.authority.exclude", contract.authority.exclude, warnings);
		contract.consumers.forEach((consumer, index) => {
			lintGlobs(file, `$.consumers[${index}].paths`, consumer.paths, warnings);
			lintGlobs(file, `$.consumers[${index}].exclude`, consumer.exclude, warnings);
			if (consumer.role === "mirror-frozen" && (consumer.allow_actors ?? []).length === 0) {
				warnings.push({
					file,
					path: `$.consumers[${index}].allow_actors`,
					expected: "at least one actor in allow_actors",
					actual: "missing",
					hint: "A mirror-frozen binding without allow_actors forbids every edit; add allow_actors or drop the role.",
				});
			}
		});
	}
	return warnings;
}

export async function runValidate(options: ValidateOptions): Promise<number> {
	const writeStdout = options.stdout ?? ((chunk: string) => void process.stdout.write(chunk));
	const writeStderr = options.stderr ?? ((chunk: string) => void process.stderr.write(chunk));

	let loaded: Awaited<ReturnType<typeof loadRegistryWithLanePresets>>;
	try {
		loaded = await loadRegistryWithLanePresets(options.registry);
	} catch (error) {
		if (error instanceof RegistryParseError) {
			for (const issue of error.issues) {
				writeStderr(`${formatRegistryIssue(issue)}\n`);
			}
			return 2;
		}
		if (error instanceof LanePresetParseError) {
			for (const issue of error.issues) {
				writeStderr(`${issue.file} ${issue.path}: ${issue.message}\n`);
			}
			return 2;
		}
		if (error instanceof RegistryReadError || error instanceof LanePresetReadError) {
			writeStderr(`gatekeeper validate: ${error.reason}\n`);
			return 2;
		}
		throw error;
	}
	const registry: Registry = loaded.registry;

	const warnings = [...registry.warnings, ...lintRegistry(registry)];
	for (const warning of warnings) {
		writeStderr(`warning: ${formatRegistryIssue(warning)}\n`);
	}
	for (const conflict of loaded.conflicts) {
		writeStderr(
			`warning: policy lane ${conflict.lane} overrides preset ${conflict.presetFile}; ${conflict.resolution} (${conflict.userFile})\n`,
		);
	}
	const warningCount = warnings.length + loaded.conflicts.length;

	writeStdout(`gatekeeper validate: OK (${registry.contracts.length} contract(s), ${warningCount} warning(s))\n`);

	if (warningCount > 0 && options.strict) {
		return 1;
	}
	return 0;
}
