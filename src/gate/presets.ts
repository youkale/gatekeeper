import { type Dirent, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument, stringify } from "yaml";

import { parseRegistry } from "../engine/registry.js";
import { laneSchema } from "../engine/schema.js";
import type { Registry } from "../engine/types.js";
import { type RegistryFileInput, readRegistryFiles } from "../providers/fsregistry.js";
import type { LaneDefinition } from "./lanes.js";

export interface LanePresetIssue {
	file: string;
	path: string;
	message: string;
}

export class LanePresetParseError extends Error {
	readonly issues: LanePresetIssue[];

	constructor(issues: LanePresetIssue[]) {
		super(issues.map((issue) => `${issue.file} ${issue.path}: ${issue.message}`).join("\n"));
		this.name = "LanePresetParseError";
		this.issues = issues;
	}
}

export class LanePresetReadError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(reason);
		this.name = "LanePresetReadError";
		this.reason = reason;
		if (options?.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

export interface LoadedLanePresets {
	lanes: Record<string, LaneDefinition>;
	sources: Record<string, string>;
}

export interface LanePresetConflict {
	lane: string;
	presetFile: string;
	userFile: string;
	resolution: "user-wins";
}

export interface MergedLaneDefinitions {
	lanes: Record<string, LaneDefinition>;
	conflicts: LanePresetConflict[];
}

export interface PreparedLanePolicy {
	/** Policy YAML with real lane definitions after applying user-wins preset merging. */
	policyYaml: string;
	conflicts: LanePresetConflict[];
}

export interface LoadedLaneRegistry {
	registry: Registry;
	lanes: Record<string, LaneDefinition>;
	conflicts: LanePresetConflict[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yamlPath(segments: PropertyKey[]): string {
	return segments.reduce<string>((result, segment) => {
		return typeof segment === "number" ? `${result}[${segment}]` : `${result}.${String(segment)}`;
	}, "$");
}

function parseYaml(file: string, content: string): unknown {
	const document = parseDocument(content, { prettyErrors: false, uniqueKeys: true });
	if (document.errors.length > 0) {
		throw new LanePresetParseError(document.errors.map((error) => ({ file, path: "$", message: error.message })));
	}
	try {
		return document.toJS();
	} catch (error) {
		throw new LanePresetParseError([
			{
				file,
				path: "$",
				message: error instanceof Error ? error.message : String(error),
			},
		]);
	}
}

function parseDefinition(file: string, value: unknown, pathPrefix: PropertyKey[] = []): LaneDefinition {
	const result = laneSchema.safeParse(value);
	if (!result.success) {
		throw new LanePresetParseError(
			result.error.issues.flatMap((issue) => {
				if (issue.code === "unrecognized_keys") {
					return issue.keys.map((key) => ({
						file,
						path: yamlPath([...pathPrefix, ...issue.path, key]),
						message: `Unknown key ${JSON.stringify(key)}`,
					}));
				}
				return [
					{
						file,
						path: yamlPath([...pathPrefix, ...issue.path]),
						message: issue.message,
					},
				];
			}),
		);
	}
	return result.data as LaneDefinition;
}

export function defaultLanePresetDirectory(moduleUrl: string | URL = import.meta.url): string {
	const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
	const sourceOrModuleCandidate = path.resolve(moduleDirectory, "../../lanes.d");
	const candidates = [path.resolve(moduleDirectory, "../lanes.d"), sourceOrModuleCandidate];
	return candidates.find((candidate) => existsSync(path.join(candidate, "human.yaml"))) ?? sourceOrModuleCandidate;
}

export async function loadLanePresets(directory = defaultLanePresetDirectory()): Promise<LoadedLanePresets> {
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		throw new LanePresetReadError(`failed to read lane preset directory ${directory}`, { cause: error });
	}

	const lanes: Record<string, LaneDefinition> = {};
	const sources: Record<string, string> = {};
	const issues: LanePresetIssue[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) {
			continue;
		}
		const lane = entry.name.replace(/\.ya?ml$/, "");
		const file = path.join(directory, entry.name);
		if (!/^[a-z0-9][a-z0-9-]*$/.test(lane)) {
			issues.push({ file, path: "$", message: `invalid lane name ${JSON.stringify(lane)}` });
			continue;
		}
		if (Object.hasOwn(lanes, lane)) {
			issues.push({ file, path: "$", message: `duplicate lane preset ${JSON.stringify(lane)}` });
			continue;
		}
		let content: string;
		try {
			content = await readFile(file, "utf8");
		} catch (error) {
			throw new LanePresetReadError(`failed to read lane preset ${file}`, { cause: error });
		}
		try {
			lanes[lane] = parseDefinition(file, parseYaml(file, content));
			sources[lane] = file;
		} catch (error) {
			if (error instanceof LanePresetParseError) {
				issues.push(...error.issues);
				continue;
			}
			throw error;
		}
	}
	if (issues.length > 0) {
		throw new LanePresetParseError(issues);
	}
	return { lanes, sources };
}

export function mergeLaneDefinitions(
	presets: LoadedLanePresets,
	userLanes: Record<string, LaneDefinition>,
	userFile = "policy.yaml",
): MergedLaneDefinitions {
	const conflicts = Object.keys(userLanes)
		.filter((lane) => Object.hasOwn(presets.lanes, lane))
		.sort()
		.map((lane) => ({
			lane,
			presetFile: presets.sources[lane] ?? lane,
			userFile,
			resolution: "user-wins" as const,
		}));
	return { lanes: { ...presets.lanes, ...userLanes }, conflicts };
}

export function preparePolicyWithLanePresets(
	policyContent: string,
	presets: LoadedLanePresets,
	userFile = "policy.yaml",
): PreparedLanePolicy {
	const policy = parseYaml(userFile, policyContent);
	if (!isRecord(policy)) {
		return { policyYaml: stringify(policy), conflicts: [] };
	}
	const rawUserLanes = policy.lanes;
	if (!isRecord(rawUserLanes)) {
		if (rawUserLanes === undefined) {
			return { policyYaml: stringify({ ...policy, lanes: presets.lanes }), conflicts: [] };
		}
		return { policyYaml: stringify(policy), conflicts: [] };
	}

	const conflicts = Object.keys(rawUserLanes)
		.filter((lane) => Object.hasOwn(presets.lanes, lane))
		.sort()
		.map((lane) => ({
			lane,
			presetFile: presets.sources[lane] ?? lane,
			userFile,
			resolution: "user-wins" as const,
		}));
	return {
		policyYaml: stringify({ ...policy, lanes: { ...presets.lanes, ...rawUserLanes } }),
		conflicts,
	};
}

function replacePolicyFile(files: RegistryFileInput[], content: string): RegistryFileInput[] {
	return files.map((file) => (file.path.replaceAll("\\", "/") === "policy.yaml" ? { ...file, content } : file));
}

/** Load registry files and apply the same real lane-preset merge used by GitHub commands. */
export async function loadRegistryWithLanePresets(
	registryDirectory: string,
	presetDirectory?: string,
): Promise<LoadedLaneRegistry> {
	const files = await readRegistryFiles(registryDirectory);
	const policyFile = files.find((file) => file.path.replaceAll("\\", "/") === "policy.yaml");
	if (!policyFile) {
		return { registry: parseRegistry(files), lanes: {}, conflicts: [] };
	}

	const presets = await loadLanePresets(presetDirectory);
	let prepared: PreparedLanePolicy;
	try {
		prepared = preparePolicyWithLanePresets(policyFile.content, presets, policyFile.path);
	} catch (error) {
		if (error instanceof LanePresetParseError) {
			// Policy parse failures belong to the registry standard surface. Let the
			// engine reconstruct the complete structured RegistryParseError.
			parseRegistry(files);
		}
		throw error;
	}
	const registry = parseRegistry(replacePolicyFile(files, prepared.policyYaml));
	return {
		registry,
		lanes: registry.policy.lanes as Record<string, LaneDefinition>,
		conflicts: prepared.conflicts,
	};
}
