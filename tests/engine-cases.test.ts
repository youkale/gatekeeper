import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { parseRegistry } from "../src/engine/registry.js";
import type { BindingHit, ChangedFile, FileMatch, Verdict } from "../src/engine/types.js";
import { evaluate } from "../src/engine/verdict.js";

interface FixtureFileCheck {
	contract: string;
	kind?: BindingHit["kind"];
	role?: BindingHit["role"];
	bindingRepo?: string;
	verify?: string | null;
	path: string;
	status?: FileMatch["status"];
	matchedPath: string;
	matchedGlob?: string;
	contentCheck: FileMatch["contentCheck"];
}

interface FixtureCase {
	name: string;
	realWorld?: boolean;
	registry: {
		policy: {
			adoption?: { enforcement_override?: "warn" };
			[key: string]: unknown;
		};
		contracts: unknown[];
	};
	input: {
		repo: string;
		actor?: string;
		changedFiles: ChangedFile[];
	};
	expected: {
		decision: Verdict["decision"];
		touched: string[];
		forbiddenEdits: string[];
		fileChecks?: FixtureFileCheck[];
		levels?: Record<string, string>;
		enforcement?: Record<string, "block" | "warn">;
		effectiveEnforcement?: Record<string, "block" | "warn">;
		consumerCount?: Record<string, number>;
		bindingCount?: Record<string, number>;
		bindingFileCount?: Record<string, number>;
		forbiddenFilePaths?: Record<string, string[]>;
	};
}

const fixtureDirectory = new URL("../fixtures/cases/", import.meta.url);
const fixtureFiles = readdirSync(fixtureDirectory)
	.filter((file) => file.endsWith(".yaml"))
	.sort();
const fixtures = fixtureFiles.map((file) =>
	parse(readFileSync(new URL(file, fixtureDirectory), "utf8"), { strict: true, uniqueKeys: true }),
) as FixtureCase[];

function registryFor(fixture: FixtureCase) {
	return parseRegistry([
		{ path: "policy.yaml", content: stringify(fixture.registry.policy) },
		...fixture.registry.contracts.map((contract, index) => ({
			path: `contracts/${index}.yaml`,
			content: stringify(contract),
		})),
	]);
}

function findFileCheck(
	verdict: Verdict,
	check: FixtureFileCheck,
): { binding: BindingHit; file: FileMatch } | undefined {
	const contract = verdict.touched.find((hit) => hit.contract === check.contract);
	for (const binding of contract?.bindings ?? []) {
		if (check.kind !== undefined && binding.kind !== check.kind) {
			continue;
		}
		if (check.role !== undefined && binding.role !== check.role) {
			continue;
		}
		const file = binding.files.find((candidate) => candidate.path === check.path);
		if (file) {
			return { binding, file };
		}
	}
	return undefined;
}

describe("M1 engine fixture corpus", () => {
	it("contains the required breadth and four real-world cases", () => {
		expect(fixtures.length).toBeGreaterThanOrEqual(14);
		expect(fixtures.filter((fixture) => fixture.realWorld)).toHaveLength(4);
		expect(fixtures.filter((fixture) => fixture.realWorld).map((fixture) => fixture.name)).toEqual(
			expect.arrayContaining([
				"ci-image-tag-matched",
				"slink-headers-authority-and-consumer",
				"artifact-manifest-producer",
				"manuals-sync-allowed-actor",
			]),
		);
	});

	it.each(fixtures)("evaluates $name", (fixture) => {
		const registry = registryFor(fixture);
		expect(registry.warnings, `${fixture.name}: unexpected registry warnings`).toEqual([]);

		const verdict = evaluate({ ...fixture.input, registry });
		expect(verdict.decision).toBe(fixture.expected.decision);
		expect(verdict.repo).toBe(fixture.input.repo);
		expect(verdict.touched.map((hit) => hit.contract)).toEqual(fixture.expected.touched);
		expect(verdict.forbiddenEdits.map((finding) => finding.contract)).toEqual(fixture.expected.forbiddenEdits);
		expect(verdict.effectivePolicy).toEqual({
			enforcementOverride: fixture.registry.policy.adoption?.enforcement_override ?? null,
		});

		for (const check of fixture.expected.fileChecks ?? []) {
			const actual = findFileCheck(verdict, check);
			expect(actual, `${fixture.name}: missing file provenance for ${check.contract}/${check.path}`).toBeDefined();
			if (!actual) {
				throw new Error("Unreachable after provenance assertion");
			}
			expect(actual.file.matchedPath).toBe(check.matchedPath);
			expect(actual.file.contentCheck).toBe(check.contentCheck);
			if (check.bindingRepo !== undefined) {
				expect(actual.binding.repo).toBe(check.bindingRepo);
			}
			if (check.verify !== undefined) {
				expect(actual.binding.verify).toBe(check.verify);
			}
			if (check.status !== undefined) {
				expect(actual.file.status).toBe(check.status);
			}
			if (check.matchedGlob !== undefined) {
				expect(actual.file.matchedGlob).toBe(check.matchedGlob);
			}
		}

		for (const [contractName, enforcement] of Object.entries(fixture.expected.effectiveEnforcement ?? {})) {
			expect(verdict.touched.find((hit) => hit.contract === contractName)?.effectiveEnforcement).toBe(enforcement);
		}
		for (const [contractName, level] of Object.entries(fixture.expected.levels ?? {})) {
			expect(verdict.touched.find((hit) => hit.contract === contractName)?.level).toBe(level);
		}
		for (const [contractName, enforcement] of Object.entries(fixture.expected.enforcement ?? {})) {
			expect(verdict.touched.find((hit) => hit.contract === contractName)?.enforcement).toBe(enforcement);
		}

		for (const [contractName, count] of Object.entries(fixture.expected.consumerCount ?? {})) {
			expect(verdict.touched.find((hit) => hit.contract === contractName)?.consumers).toHaveLength(count);
		}
		for (const [contractName, count] of Object.entries(fixture.expected.bindingCount ?? {})) {
			expect(verdict.touched.find((hit) => hit.contract === contractName)?.bindings).toHaveLength(count);
		}
		for (const [contractName, count] of Object.entries(fixture.expected.bindingFileCount ?? {})) {
			expect(verdict.touched.find((hit) => hit.contract === contractName)?.bindings[0]?.files).toHaveLength(count);
		}
		for (const [contractName, paths] of Object.entries(fixture.expected.forbiddenFilePaths ?? {})) {
			expect(
				verdict.forbiddenEdits.find((finding) => finding.contract === contractName)?.files.map((file) => file.path),
			).toEqual(paths);
		}

		if (fixture.name === "slink-headers-authority-and-consumer") {
			expect(verdict.touched[0]?.bindings.map((binding) => binding.kind)).toEqual(["authority", "consumer"]);
			expect(verdict.touched[0]?.bindings.map(({ repo, verify }) => ({ repo, verify }))).toEqual([
				{ repo: "youkale/slink", verify: null },
				{ repo: "youkale/slink", verify: "go test ./..." },
			]);
		}
		if (fixture.name === "mirror-frozen-actor-undefined") {
			expect(verdict.forbiddenEdits[0]?.actor).toBeNull();
		}
		if (fixture.name === "ci-image-tag-matched") {
			expect(verdict.touched[0]?.requires).toEqual({ m: 1, lanes: ["human"] });
		}
		if (fixture.name === "artifact-manifest-producer") {
			expect(verdict.touched[0]?.consumers).toEqual([
				{ repo: "org/syncify", role: "producer", verify: "npm run release:check" },
				{ repo: "org/hub", role: "producer", verify: "make release-check" },
				{ repo: "org/slink", role: "producer", verify: "go test ./..." },
				{ repo: "org/deploy", role: "consumer", verify: "bin/validate" },
			]);
			expect(verdict.touched[0]?.bindings[0]).toMatchObject({
				kind: "consumer",
				role: "producer",
				repo: "org/syncify",
				verify: "npm run release:check",
			});
		}
		if (fixture.name === "manuals-sync-human-forbidden") {
			expect(verdict.forbiddenEdits[0]).toEqual({
				contract: "manuals-sync",
				repo: "org/agent",
				actor: "alice",
				allowActors: ["manuals-sync[bot]"],
				files: [
					{
						path: "manufacturer/wangdian/README.md",
						status: "M",
						matchedPath: "manufacturer/wangdian/README.md",
						matchedGlob: "manufacturer/**",
						contentCheck: "not-configured",
					},
				],
			});
		}
	});
});
