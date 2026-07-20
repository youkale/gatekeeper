import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";
import type { ZodNumber, ZodString, ZodTypeAny } from "zod";

import { generateRunToken, reviewVerdictSchema } from "../src/review/verdict.js";

const PASS_VERDICT = {
	apiVersion: "gatekeeper/v1" as const,
	verdict: "pass" as const,
	run_token: "rv1_test-token",
	round: 1,
	blockers: [],
	non_blockers: [],
};

const FULL_BLOCKER = {
	id: "B-r1-L1-01",
	ref: "B-r999-L27-99",
	file: "src/review/verdict.ts",
	line: 42,
	title: "Schema accepts contradictory verdicts",
	evidence: "The fail branch can be emitted with no actionable blocker.",
	suggested_fix: "Tie verdict to blockers in a final schema refinement.",
	category: "correctness" as const,
};

const FAIL_VERDICT = {
	...PASS_VERDICT,
	verdict: "fail" as const,
	blockers: [FULL_BLOCKER],
	non_blockers: [{ file: "tests/review-verdict.test.ts", line: 7, note: "Consider a shorter local name." }],
	out_of_scope: ["A pre-existing formatting issue outside the assigned files."],
};

function requiredKeys(shape: Record<string, ZodTypeAny>): string[] {
	return Object.entries(shape)
		.filter(([, field]) => !field.isOptional())
		.map(([name]) => name)
		.sort();
}

function regexSource(schema: ZodString): string {
	const check = schema._def.checks.find((candidate) => candidate.kind === "regex");
	if (check?.kind !== "regex") {
		throw new Error("expected a regex-constrained Zod string");
	}
	return check.regex.source;
}

function expectNonEmptyStringAlignment(jsonField: Record<string, unknown>, zodField: ZodString): void {
	expect(jsonField.type).toBe("string");
	expect(jsonField.minLength ?? null).toBe(zodField.minLength);
}

function expectPositiveIntegerAlignment(jsonField: Record<string, unknown>, zodField: ZodNumber): void {
	const integerCheck = zodField._def.checks.find((candidate) => candidate.kind === "int");
	const minimumCheck = zodField._def.checks.find((candidate) => candidate.kind === "min");
	expect(integerCheck?.kind).toBe("int");
	expect(minimumCheck?.kind).toBe("min");
	expect(jsonField.type).toBe("integer");
	const integerMinimum =
		minimumCheck?.kind === "min" ? minimumCheck.value + (minimumCheck.inclusive ? 0 : 1) : undefined;
	expect(jsonField.minimum).toBe(integerMinimum);
}

function expectStringEnumAlignment(jsonField: Record<string, unknown>, options: readonly string[]): void {
	expect(jsonField.type).toBe("string");
	expect(jsonField.enum).toEqual(options);
}

describe("review VERDICT.json zod contract", () => {
	it("accepts complete pass and fail examples with every optional field", () => {
		expect(reviewVerdictSchema.parse(PASS_VERDICT)).toEqual(PASS_VERDICT);
		expect(reviewVerdictSchema.parse(FAIL_VERDICT)).toEqual(FAIL_VERDICT);
	});

	it.each([
		["apiVersion", { ...PASS_VERDICT, apiVersion: "gatekeeper/v2" }],
		["verdict", { ...PASS_VERDICT, verdict: "approve" }],
		["run_token type", { ...PASS_VERDICT, run_token: 7 }],
		["empty run_token", { ...PASS_VERDICT, run_token: "" }],
		["round zero", { ...PASS_VERDICT, round: 0 }],
		["fractional round", { ...PASS_VERDICT, round: 1.5 }],
		["blockers type", { ...PASS_VERDICT, blockers: {} }],
		["non_blockers type", { ...PASS_VERDICT, non_blockers: {} }],
		["out_of_scope type", { ...PASS_VERDICT, out_of_scope: "note" }],
		["empty out_of_scope note", { ...PASS_VERDICT, out_of_scope: [""] }],
	])("rejects an invalid %s field", (_name, value) => {
		expect(reviewVerdictSchema.safeParse(value).success).toBe(false);
	});

	it.each([
		["id", { ...FULL_BLOCKER, id: "bad-id" }],
		["ref", { ...FULL_BLOCKER, ref: "bad-ref" }],
		["file", { ...FULL_BLOCKER, file: "" }],
		["line", { ...FULL_BLOCKER, line: 0 }],
		["title", { ...FULL_BLOCKER, title: "" }],
		["evidence", { ...FULL_BLOCKER, evidence: "" }],
		["suggested_fix", { ...FULL_BLOCKER, suggested_fix: "" }],
		["category", { ...FULL_BLOCKER, category: "style" }],
		["unknown key", { ...FULL_BLOCKER, confidence: "high" }],
	])("rejects an invalid blocker %s", (_name, blocker) => {
		expect(reviewVerdictSchema.safeParse({ ...FAIL_VERDICT, blockers: [blocker] }).success).toBe(false);
	});

	it.each([
		["file", { file: "", line: 1, note: "note" }],
		["line", { file: "src/a.ts", line: 0, note: "note" }],
		["note", { file: "src/a.ts", line: 1, note: "" }],
		["unknown key", { note: "note", severity: "nit" }],
	])("rejects an invalid non-blocker %s", (_name, nonBlocker) => {
		expect(reviewVerdictSchema.safeParse({ ...PASS_VERDICT, non_blockers: [nonBlocker] }).success).toBe(false);
	});

	it("enforces the verdict/blockers lock in both directions", () => {
		expect(reviewVerdictSchema.safeParse({ ...PASS_VERDICT, verdict: "fail" }).success).toBe(false);
		expect(reviewVerdictSchema.safeParse({ ...FAIL_VERDICT, verdict: "pass" }).success).toBe(false);
	});

	it.each(["correctness", "fail-direction", "security", "compat", "data-loss", "test"] as const)(
		"accepts blocker category %s",
		(category) => {
			expect(
				reviewVerdictSchema.safeParse({ ...FAIL_VERDICT, blockers: [{ ...FULL_BLOCKER, category }] }).success,
			).toBe(true);
		},
	);

	it.each(["B-r1-L1-01", "B-r1-L2-99", "B-r999999999999-L888888888888-42"])(
		"accepts blocker reference boundary %s",
		(reference) => {
			expect(
				reviewVerdictSchema.safeParse({
					...FAIL_VERDICT,
					blockers: [{ ...FULL_BLOCKER, id: reference, ref: reference }],
				}).success,
			).toBe(true);
		},
	);

	it.each([
		"B-r0-L1-01",
		"B-r01-L1-01",
		"B-r1-L0-01",
		"B-r1-L01-01",
		"B-r1-L1-00",
		"B-r1-L1-1",
		"B-r1-L1-100",
		"b-r1-L1-01",
		"B-r1-L1-01-extra",
	])("rejects blocker reference boundary %s", (reference) => {
		expect(
			reviewVerdictSchema.safeParse({ ...FAIL_VERDICT, blockers: [{ ...FULL_BLOCKER, id: reference }] }).success,
		).toBe(false);
	});

	it("rejects unknown keys at the root and every nested object level", () => {
		expect(reviewVerdictSchema.safeParse({ ...PASS_VERDICT, extra: true }).success).toBe(false);
		expect(
			reviewVerdictSchema.safeParse({
				...PASS_VERDICT,
				non_blockers: [{ note: "advice", extra: true }],
			}).success,
		).toBe(false);
	});
});

describe("checked-in JSON Schema alignment", () => {
	it("derives every field's strictness, requiredness, type, bounds, enum, and pattern from zod metadata", async () => {
		const jsonSchema = JSON.parse(
			await readFile(new URL("../schema/review-verdict.schema.json", import.meta.url), "utf8"),
		);
		const rootObject = reviewVerdictSchema.innerType();
		const rootShape = rootObject.shape;
		const blockerShape = rootShape.blockers.element.shape;
		const nonBlockerShape = rootShape.non_blockers.element.shape;
		const outOfScopeItem = rootShape.out_of_scope.unwrap().element;

		expect(rootObject._def.unknownKeys).toBe("strict");
		expect(jsonSchema.additionalProperties).toBe(false);
		expect(Object.keys(jsonSchema.properties).sort()).toEqual(Object.keys(rootShape).sort());
		expect([...jsonSchema.required].sort()).toEqual(requiredKeys(rootShape));
		expect(jsonSchema.properties.apiVersion.type).toBe(typeof rootShape.apiVersion.value);
		expect(jsonSchema.properties.apiVersion.const).toBe(rootShape.apiVersion.value);
		expectStringEnumAlignment(jsonSchema.properties.verdict, rootShape.verdict.options);
		expectNonEmptyStringAlignment(jsonSchema.properties.run_token, rootShape.run_token);
		expectPositiveIntegerAlignment(jsonSchema.properties.round, rootShape.round);
		expect(jsonSchema.properties.blockers.type).toBe("array");
		expect(jsonSchema.properties.blockers.items.$ref).toBe("#/$defs/blocker");
		expect(jsonSchema.properties.non_blockers.type).toBe("array");
		expect(jsonSchema.properties.non_blockers.items.$ref).toBe("#/$defs/nonBlocker");
		expect(jsonSchema.properties.out_of_scope.type).toBe("array");
		expectNonEmptyStringAlignment(jsonSchema.properties.out_of_scope.items, outOfScopeItem);

		expect(rootShape.blockers.element._def.unknownKeys).toBe("strict");
		expect(jsonSchema.$defs.blocker.additionalProperties).toBe(false);
		expect(Object.keys(jsonSchema.$defs.blocker.properties).sort()).toEqual(Object.keys(blockerShape).sort());
		expect([...jsonSchema.$defs.blocker.required].sort()).toEqual(requiredKeys(blockerShape));
		expect(jsonSchema.$defs.blocker.properties.id.$ref).toBe("#/$defs/blockerReference");
		expect(jsonSchema.$defs.blocker.properties.ref.$ref).toBe("#/$defs/blockerReference");
		expectNonEmptyStringAlignment(jsonSchema.$defs.blockerReference, blockerShape.id.unwrap());
		expect(jsonSchema.$defs.blockerReference.pattern).toBe(regexSource(blockerShape.id.unwrap()));
		expect(regexSource(blockerShape.ref.unwrap())).toBe(regexSource(blockerShape.id.unwrap()));
		expectNonEmptyStringAlignment(jsonSchema.$defs.blocker.properties.file, blockerShape.file);
		expectPositiveIntegerAlignment(jsonSchema.$defs.blocker.properties.line, blockerShape.line.unwrap());
		expectNonEmptyStringAlignment(jsonSchema.$defs.blocker.properties.title, blockerShape.title);
		expectNonEmptyStringAlignment(jsonSchema.$defs.blocker.properties.evidence, blockerShape.evidence);
		expectNonEmptyStringAlignment(
			jsonSchema.$defs.blocker.properties.suggested_fix,
			blockerShape.suggested_fix.unwrap(),
		);
		expectStringEnumAlignment(jsonSchema.$defs.blocker.properties.category, blockerShape.category.unwrap().options);

		expect(rootShape.non_blockers.element._def.unknownKeys).toBe("strict");
		expect(jsonSchema.$defs.nonBlocker.additionalProperties).toBe(false);
		expect(Object.keys(jsonSchema.$defs.nonBlocker.properties).sort()).toEqual(Object.keys(nonBlockerShape).sort());
		expect([...jsonSchema.$defs.nonBlocker.required].sort()).toEqual(requiredKeys(nonBlockerShape));
		expectNonEmptyStringAlignment(jsonSchema.$defs.nonBlocker.properties.file, nonBlockerShape.file.unwrap());
		expectPositiveIntegerAlignment(jsonSchema.$defs.nonBlocker.properties.line, nonBlockerShape.line.unwrap());
		expectNonEmptyStringAlignment(jsonSchema.$defs.nonBlocker.properties.note, nonBlockerShape.note);

		for (const value of Object.values(jsonSchema.properties)) {
			const description = (value as { description?: unknown }).description;
			expect(typeof description).toBe("string");
			expect(typeof description === "string" ? description.length : 0).toBeGreaterThan(0);
		}
		for (const definition of [jsonSchema.$defs.blocker, jsonSchema.$defs.nonBlocker]) {
			expect(definition.description).toEqual(expect.any(String));
			for (const value of Object.values(definition.properties)) {
				const description = (value as { description?: unknown }).description;
				expect(typeof description).toBe("string");
				expect(typeof description === "string" ? description.length : 0).toBeGreaterThan(0);
			}
		}
		expect(jsonSchema.$defs.blockerReference.description).toEqual(expect.any(String));
	});

	it("encodes the same pass/fail blocker lock as the zod refinement", async () => {
		const jsonSchema = JSON.parse(
			await readFile(new URL("../schema/review-verdict.schema.json", import.meta.url), "utf8"),
		);
		const ruleFor = (verdict: "pass" | "fail") =>
			jsonSchema.allOf.find(
				(rule: { if?: { properties?: { verdict?: { const?: string } } } }) =>
					rule.if?.properties?.verdict?.const === verdict,
			);

		expect(ruleFor("fail")?.then.properties.blockers.minItems).toBe(1);
		expect(ruleFor("pass")?.then.properties.blockers.maxItems).toBe(0);
		expect(reviewVerdictSchema.safeParse({ ...PASS_VERDICT, verdict: "fail" }).success).toBe(false);
		expect(reviewVerdictSchema.safeParse({ ...FAIL_VERDICT, verdict: "pass" }).success).toBe(false);
	});
});

describe("run token generation", () => {
	it("formats exactly 32 injected random bytes as one canonical rv1 token", () => {
		const randomBytes = vi.fn((length: number) => Uint8Array.from({ length }, (_unused, index) => index));
		expect(generateRunToken(randomBytes)).toBe("rv1_000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
		expect(randomBytes).toHaveBeenCalledWith(32);
		expect(randomBytes).toHaveBeenCalledOnce();
	});

	it("rejects a random source that violates the byte-count contract", () => {
		expect(() => generateRunToken(() => new Uint8Array(31))).toThrow("exactly 32 bytes");
	});
});
