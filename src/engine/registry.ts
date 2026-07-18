import { parseDocument } from "yaml";
import type { z } from "zod";

import { contractSchema, policySchema } from "./schema.js";
import type { Contract, Policy, Registry, RegistryIssue } from "./types.js";

interface RegistryFile {
	path: string;
	content: string;
}

interface ParsedDocument {
	file: string;
	value: unknown;
}

export class RegistryParseError extends Error {
	readonly issues: RegistryIssue[];

	constructor(issues: RegistryIssue[]) {
		super(issues.map(formatRegistryIssue).join("\n"));
		this.name = "RegistryParseError";
		this.issues = issues;
	}
}

export function formatRegistryIssue(issue: RegistryIssue): string {
	return `${issue.file} ${issue.path}: expected ${issue.expected}, got ${issue.actual}. ${issue.hint}`;
}

function yamlPath(path: PropertyKey[]): string {
	if (path.length === 0) {
		return "$";
	}

	let result = "$";
	for (const segment of path) {
		if (typeof segment === "number") {
			result += `[${segment}]`;
		} else {
			result += `.${String(segment)}`;
		}
	}
	return result;
}

function valueAtPath(value: unknown, path: PropertyKey[]): unknown {
	let current = value;
	for (const segment of path) {
		if (typeof current !== "object" || current === null) {
			return undefined;
		}
		current = (current as Record<PropertyKey, unknown>)[segment];
	}
	return current;
}

function describeValue(value: unknown): string {
	if (value === undefined) {
		return "missing";
	}
	if (value === null) {
		return "null";
	}
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `array(${value.length})`;
	}
	if (typeof value === "object") {
		return "object";
	}
	return String(value);
}

function expectedFromZodIssue(issue: z.ZodIssue): string {
	switch (issue.code) {
		case "invalid_type":
			return issue.expected;
		case "invalid_literal":
			return JSON.stringify(issue.expected);
		case "invalid_enum_value":
			return issue.options.map(String).join(" | ");
		case "too_small":
			return issue.type === "array" ? `at least ${issue.minimum} item(s)` : `minimum ${issue.minimum}`;
		case "invalid_string":
			return "valid string format";
		case "invalid_union":
			return "one supported object shape";
		case "custom": {
			const params = issue.params as { kind?: string } | undefined;
			if (params?.kind === "unknown-key") {
				return "a known key or x-* extension";
			}
			if (params?.kind === "invalid-regex") {
				return "a valid JavaScript regular expression";
			}
			return "valid value";
		}
		default:
			return "valid value";
	}
}

function hintFromZodIssue(issue: z.ZodIssue): string {
	if (issue.message) {
		return issue.message;
	}
	return "Correct the value and retry.";
}

function zodIssues(file: string, value: unknown, issues: z.ZodIssue[]): RegistryIssue[] {
	return issues.map((issue) => ({
		file,
		path: yamlPath(issue.path),
		expected: expectedFromZodIssue(issue),
		actual: describeValue(valueAtPath(value, issue.path)),
		hint: hintFromZodIssue(issue),
	}));
}

function parseYaml(file: RegistryFile, errors: RegistryIssue[]): ParsedDocument | undefined {
	const document = parseDocument(file.content, { prettyErrors: false, uniqueKeys: true });
	if (document.errors.length > 0) {
		for (const error of document.errors) {
			errors.push({
				file: file.path,
				path: "$",
				expected: "valid YAML",
				actual: "invalid YAML",
				hint: error.message,
			});
		}
		return undefined;
	}

	let value: unknown;
	try {
		value = document.toJS();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// "Excessive alias count" is the yaml library's billion-laughs guard
		// (resource-exhaustion protection on runaway alias expansion), which is
		// a distinct failure mode from a plain unresolved-anchor reference and
		// deserves its own hint rather than reusing the anchor-definition hint
		// below.
		const isExcessiveAliasExpansion = /excessive alias count/i.test(message);
		errors.push({
			file: file.path,
			path: "$",
			expected: "valid alias reference",
			actual: message,
			hint: isExcessiveAliasExpansion
				? "YAML alias expansion exceeded safe limits; check for recursive or excessively nested aliases."
				: "Define the referenced YAML anchor before using its alias.",
		});
		return undefined;
	}

	return { file: file.path, value };
}

function semanticIssue(file: string, path: string, expected: string, actual: string, hint: string): RegistryIssue {
	return { file, path, expected, actual, hint };
}

function validateRegex(file: string, path: string, pattern: string | undefined, errors: RegistryIssue[]): void {
	if (pattern === undefined) {
		return;
	}

	try {
		new RegExp(pattern);
	} catch (error) {
		errors.push(
			semanticIssue(
				file,
				path,
				"a valid JavaScript regular expression",
				JSON.stringify(pattern),
				error instanceof Error ? error.message : "Regular expression compilation failed",
			),
		);
	}
}

export function parseRegistry(files: { path: string; content: string }[]): Registry {
	const errors: RegistryIssue[] = [];
	const warnings: RegistryIssue[] = [];
	const policyFiles = files.filter((file) => file.path.replaceAll("\\", "/") === "policy.yaml");
	const contractFiles = files.filter((file) => /^contracts\/[^/]+\.ya?ml$/.test(file.path.replaceAll("\\", "/")));

	if (policyFiles.length !== 1) {
		errors.push(
			semanticIssue(
				"policy.yaml",
				"$",
				"exactly one policy.yaml",
				`${policyFiles.length} files`,
				"Provide one registry policy file at policy.yaml.",
			),
		);
	}

	const parsedPolicy = policyFiles[0] ? parseYaml(policyFiles[0], errors) : undefined;
	let policy: Policy | undefined;
	if (parsedPolicy) {
		const result = policySchema.safeParse(parsedPolicy.value);
		if (result.success) {
			policy = result.data as Policy;
		} else {
			errors.push(...zodIssues(parsedPolicy.file, parsedPolicy.value, result.error.issues));
		}
	}

	const contracts: Array<{ contract: Contract; file: string }> = [];
	for (const file of contractFiles) {
		const parsed = parseYaml(file, errors);
		if (!parsed) {
			continue;
		}

		const result = contractSchema.safeParse(parsed.value);
		if (result.success) {
			contracts.push({ contract: result.data as Contract, file: parsed.file });
		} else {
			errors.push(...zodIssues(parsed.file, parsed.value, result.error.issues));
		}
	}

	const seenNames = new Map<string, string>();
	for (const { contract, file } of contracts) {
		const previous = seenNames.get(contract.name);
		if (previous) {
			errors.push(
				semanticIssue(
					file,
					"$.name",
					"a unique contract name",
					JSON.stringify(contract.name),
					`The same name is already declared in ${previous}.`,
				),
			);
		} else {
			seenNames.set(contract.name, file);
		}

		if (policy && !Object.hasOwn(policy.levels, contract.level)) {
			errors.push(
				semanticIssue(
					file,
					"$.level",
					"a level declared in policy.yaml",
					JSON.stringify(contract.level),
					`Declare level "${contract.level}" in policy.levels or correct the contract level.`,
				),
			);
		}

		validateRegex(file, "$.authority.if_content", contract.authority.if_content, errors);
		contract.consumers.forEach((consumer, index) => {
			validateRegex(file, `$.consumers[${index}].if_content`, consumer.if_content, errors);
			if (consumer.allow_actors && consumer.role !== "mirror-frozen") {
				warnings.push(
					semanticIssue(
						file,
						`$.consumers[${index}].allow_actors`,
						"allow_actors on a mirror-frozen binding",
						consumer.role,
						"allow_actors has no effect unless role is mirror-frozen.",
					),
				);
			}
		});
	}

	if (policy) {
		for (const [levelName, level] of Object.entries(policy.levels)) {
			const lanes = level.require.lanes;
			const minimum = level.require.m;
			if (!lanes || minimum === undefined) {
				continue;
			}

			if (minimum > lanes.length) {
				errors.push(
					semanticIssue(
						"policy.yaml",
						`$.levels.${levelName}.require.m`,
						`a number no greater than ${lanes.length}`,
						String(minimum),
						"m cannot exceed the number of required lanes.",
					),
				);
			}

			lanes.forEach((lane, index) => {
				if (!Object.hasOwn(policy?.lanes ?? {}, lane)) {
					errors.push(
						semanticIssue(
							"policy.yaml",
							`$.levels.${levelName}.require.lanes[${index}]`,
							"a lane declared in policy.lanes",
							JSON.stringify(lane),
							`Declare lane "${lane}" or remove it from this requirement.`,
						),
					);
				}
			});
		}
	}

	if (errors.length > 0 || !policy) {
		throw new RegistryParseError(errors);
	}

	return {
		policy,
		contracts: contracts.map(({ contract }) => contract),
		warnings,
	};
}
