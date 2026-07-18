import { formatRegistryIssue, parseRegistry, RegistryParseError } from "../engine/registry.js";
import type { Registry, RegistryIssue } from "../engine/types.js";
import { RegistryReadError, readRegistryFiles } from "../providers/fsregistry.js";

export interface ValidateOptions {
	registry: string;
	strict?: boolean;
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
	let files: Awaited<ReturnType<typeof readRegistryFiles>>;
	try {
		files = await readRegistryFiles(options.registry);
	} catch (error) {
		const reason =
			error instanceof RegistryReadError ? error.reason : error instanceof Error ? error.message : String(error);
		process.stderr.write(`gatekeeper validate: ${reason}\n`);
		return 2;
	}

	let registry: Registry;
	try {
		registry = parseRegistry(files);
	} catch (error) {
		if (error instanceof RegistryParseError) {
			for (const issue of error.issues) {
				process.stderr.write(`${formatRegistryIssue(issue)}\n`);
			}
			return 2;
		}
		throw error;
	}

	const warnings = [...registry.warnings, ...lintRegistry(registry)];
	for (const warning of warnings) {
		process.stderr.write(`warning: ${formatRegistryIssue(warning)}\n`);
	}

	process.stdout.write(
		`gatekeeper validate: OK (${registry.contracts.length} contract(s), ${warnings.length} warning(s))\n`,
	);

	if (warnings.length > 0 && options.strict) {
		return 1;
	}
	return 0;
}
