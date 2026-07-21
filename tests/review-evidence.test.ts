import { describe, expect, it, vi } from "vitest";

import {
	checkVerdictFile,
	checkWorkspaceUntouched,
	type EvidenceLaneOutcomeInput,
	laneOutcome,
	type VerdictFileReader,
} from "../src/review/evidence.js";
import type { ReviewVerdict } from "../src/review/verdict.js";

const TOKEN = "rv1_expected";
const EXPECTED = { run_token: TOKEN, round: 2 } as const;
const PASS_VERDICT: ReviewVerdict = {
	apiVersion: "gatekeeper/v1",
	verdict: "pass",
	run_token: TOKEN,
	round: 2,
	blockers: [],
	non_blockers: [],
};
const FAIL_VERDICT: ReviewVerdict = {
	...PASS_VERDICT,
	verdict: "fail",
	blockers: [
		{
			id: "B-r2-L1-01",
			file: "src/review/evidence.ts",
			line: 1,
			title: "Evidence gate can be bypassed",
			evidence: "The invalid branch is treated as a pass.",
			suggested_fix: "Keep INVALID distinct from PASS.",
			category: "fail-direction",
		},
	],
};

const CLEAN_FINGERPRINT = {
	head: "a".repeat(40),
	porcelain: "",
	trackedDiff: "",
	untracked: [{ path: "notes.txt", hash: "b".repeat(40) }],
} as const;

function reader(value: unknown): VerdictFileReader {
	return { readText: vi.fn(async () => (typeof value === "string" ? value : JSON.stringify(value))) };
}

function input(overrides: Partial<EvidenceLaneOutcomeInput> = {}): EvidenceLaneOutcomeInput {
	return {
		reader: reader(PASS_VERDICT),
		expected: EXPECTED,
		before: CLEAN_FINGERPRINT,
		after: CLEAN_FINGERPRINT,
		...overrides,
	};
}

describe("VERDICT.json evidence gate", () => {
	it("returns the validated verdict for both legal judgments", async () => {
		await expect(checkVerdictFile(reader(PASS_VERDICT), EXPECTED)).resolves.toEqual({
			status: "VALID",
			verdict: PASS_VERDICT,
		});
		await expect(checkVerdictFile(reader(FAIL_VERDICT), EXPECTED)).resolves.toEqual({
			status: "VALID",
			verdict: FAIL_VERDICT,
		});
	});

	it.each(["ENOENT", "ENOTDIR"])("classifies %s as MISSING", async (code) => {
		const missing = Object.assign(new Error("not found"), { code });
		await expect(
			checkVerdictFile({ readText: vi.fn(async () => Promise.reject(missing)) }, EXPECTED),
		).resolves.toMatchObject({ status: "INVALID", reason: "MISSING", message: "not found" });
	});

	it("fail-closes a non-missing reader error as CORRUPT", async () => {
		const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
		await expect(checkVerdictFile({ readText: vi.fn(async () => Promise.reject(denied)) }, EXPECTED)).resolves.toEqual({
			status: "INVALID",
			reason: "CORRUPT",
			message: "permission denied",
		});
	});

	it("fail-closes an unstringifiable reader rejection with a stable CORRUPT message", async () => {
		const unstringifiable = Object.create(null);
		await expect(
			checkVerdictFile({ readText: vi.fn(async () => Promise.reject(unstringifiable)) }, EXPECTED),
		).resolves.toEqual({
			status: "INVALID",
			reason: "CORRUPT",
			message: "reader failed without accessible error detail",
		});
	});

	it.each([
		[
			"throwing code getter",
			Object.defineProperty(new Error("getter failure"), "code", {
				get() {
					throw new Error("code getter trap");
				},
			}),
			"getter failure",
		],
		[
			"hostile proxy",
			new Proxy(Object.create(null), {
				get() {
					throw new Error("proxy get trap");
				},
				getPrototypeOf() {
					throw new Error("proxy prototype trap");
				},
			}),
			"reader failed without accessible error detail",
		],
	] as const)("fail-closes a %s rejection even when code extraction throws", async (_name, rejection, message) => {
		await expect(
			checkVerdictFile({ readText: vi.fn(async () => Promise.reject(rejection)) }, EXPECTED),
		).resolves.toEqual({ status: "INVALID", reason: "CORRUPT", message });
	});

	it("classifies malformed JSON as CORRUPT", async () => {
		await expect(checkVerdictFile(reader("{not-json"), EXPECTED)).resolves.toMatchObject({
			status: "INVALID",
			reason: "CORRUPT",
		});
	});

	it("classifies a parsed but invalid strict artifact as SCHEMA_MISMATCH with issues", async () => {
		const result = await checkVerdictFile(reader({ ...PASS_VERDICT, unknown: true }), EXPECTED);
		expect(result).toMatchObject({ status: "INVALID", reason: "SCHEMA_MISMATCH" });
		if (result.status === "INVALID") {
			expect(result.issues).not.toHaveLength(0);
		}
	});

	it.each([
		["token correct, round wrong", { ...PASS_VERDICT, round: 3 }, "ROUND_MISMATCH"],
		["round correct, token wrong", { ...PASS_VERDICT, run_token: "rv1_stale" }, "TOKEN_MISMATCH"],
	] as const)("rejects %s", async (_name, verdict, reason) => {
		await expect(checkVerdictFile(reader(verdict), EXPECTED)).resolves.toMatchObject({
			status: "INVALID",
			reason,
		});
	});

	it("checks token before round when both identities mismatch", async () => {
		await expect(
			checkVerdictFile(reader({ ...PASS_VERDICT, run_token: "rv1_stale", round: 99 }), EXPECTED),
		).resolves.toMatchObject({ status: "INVALID", reason: "TOKEN_MISMATCH" });
	});

	it("does not trust a runtime reader that returns a non-string", async () => {
		const invalidReader = { readText: vi.fn(async () => null) } as unknown as VerdictFileReader;
		await expect(checkVerdictFile(invalidReader, EXPECTED)).resolves.toEqual({
			status: "INVALID",
			reason: "CORRUPT",
			message: "VERDICT.json reader did not return text",
		});
	});

	it("handles heterogeneous and hostile JSON without throwing", async () => {
		let deeplyNested: unknown = "leaf";
		for (let depth = 0; depth < 1_000; depth += 1) {
			deeplyNested = { nested: deeplyNested };
		}
		const cases = [
			["array top level", [], "SCHEMA_MISMATCH"],
			["null top level", null, "SCHEMA_MISMATCH"],
			["deeply nested object", { ...PASS_VERDICT, blockers: deeplyNested }, "SCHEMA_MISMATCH"],
			["million-character token", { ...PASS_VERDICT, run_token: "x".repeat(1_000_000) }, "TOKEN_MISMATCH"],
		] as const;

		for (const [_name, value, reason] of cases) {
			await expect(checkVerdictFile(reader(value), EXPECTED)).resolves.toMatchObject({
				status: "INVALID",
				reason,
			});
		}
	});
});

describe("narrative-wrapped stdout channel extraction", () => {
	const NARRATIVE_PREFIX =
		"I'll review this branch independently: fetch the full diff, read surrounding context and repo rules, then verify the CHANGELOG against git history before emitting VERDICT.json only.Verifying key CHANGELOG claims against git history and checking file integrity.";

	it("extracts a verdict wrapped in a real-world CLI narrative prefix (captured evidence shape)", async () => {
		const raw = `${NARRATIVE_PREFIX}${JSON.stringify(PASS_VERDICT)}`;
		await expect(checkVerdictFile(reader(raw), EXPECTED)).resolves.toEqual({ status: "VALID", verdict: PASS_VERDICT });
	});

	it("extracts a verdict wrapped in a narrative suffix", async () => {
		const raw = `${JSON.stringify(FAIL_VERDICT)}\nThanks, that concludes my review.`;
		await expect(checkVerdictFile(reader(raw), EXPECTED)).resolves.toEqual({ status: "VALID", verdict: FAIL_VERDICT });
	});

	it("extracts a verdict wrapped in narrative on both sides", async () => {
		const raw = `${NARRATIVE_PREFIX}${JSON.stringify(PASS_VERDICT)}\nDone reviewing.`;
		await expect(checkVerdictFile(reader(raw), EXPECTED)).resolves.toEqual({ status: "VALID", verdict: PASS_VERDICT });
	});

	it("skips a decoy JSON fragment with no apiVersion and extracts the real trailing verdict", async () => {
		const decoy = JSON.stringify({ note: "example shape only, not a verdict" });
		const raw = `Example shape: ${decoy}\nFinal: ${JSON.stringify(PASS_VERDICT)}`;
		await expect(checkVerdictFile(reader(raw), EXPECTED)).resolves.toEqual({ status: "VALID", verdict: PASS_VERDICT });
	});

	it("skips a decoy with a matching apiVersion but a schema-failing shape, and extracts the real trailing verdict", async () => {
		const decoy = JSON.stringify({
			apiVersion: "gatekeeper/v1",
			verdict: "pass",
			run_token: TOKEN,
			round: 2,
			blockers: [],
			non_blockers: [],
			extra_field_not_in_schema: true,
		});
		const raw = `Draft attempt: ${decoy}\nFinal answer: ${JSON.stringify(PASS_VERDICT)}`;
		await expect(checkVerdictFile(reader(raw), EXPECTED)).resolves.toEqual({ status: "VALID", verdict: PASS_VERDICT });
	});

	it("skips both decoy shapes (no apiVersion, then apiVersion-but-schema-fail) before the real trailing verdict", async () => {
		const decoyNoApiVersion = JSON.stringify({ example: "not a verdict" });
		const decoyBadSchema = JSON.stringify({
			apiVersion: "gatekeeper/v1",
			verdict: "pass",
			run_token: TOKEN,
			round: 2,
			blockers: [],
			non_blockers: [],
			extra: true,
		});
		const raw = `Thinking... ${decoyNoApiVersion} Attempt: ${decoyBadSchema} Final answer: ${JSON.stringify(PASS_VERDICT)}`;
		await expect(checkVerdictFile(reader(raw), EXPECTED)).resolves.toEqual({ status: "VALID", verdict: PASS_VERDICT });
	});

	it("reports SCHEMA_MISMATCH from the last eligible candidate when every extracted candidate fails schema", async () => {
		const decoy = JSON.stringify({
			apiVersion: "gatekeeper/v1",
			verdict: "pass",
			run_token: TOKEN,
			round: 2,
			blockers: [],
			non_blockers: [],
			extra: true,
		});
		const raw = `Narrative only, no real delivery this time: ${decoy}`;
		const result = await checkVerdictFile(reader(raw), EXPECTED);
		expect(result).toMatchObject({ status: "INVALID", reason: "SCHEMA_MISMATCH" });
		if (result.status === "INVALID") {
			expect(result.issues).not.toHaveLength(0);
		}
	});

	it("classifies pure narrative with no JSON object at all as CORRUPT", async () => {
		await expect(checkVerdictFile(reader("I could not produce a verdict this time."), EXPECTED)).resolves.toMatchObject(
			{
				status: "INVALID",
				reason: "CORRUPT",
			},
		);
	});

	it("still enforces token/round freshness on an extracted narrative-wrapped verdict", async () => {
		const stale = { ...PASS_VERDICT, run_token: "rv1_stale" };
		const raw = `${NARRATIVE_PREFIX}${JSON.stringify(stale)}`;
		await expect(checkVerdictFile(reader(raw), EXPECTED)).resolves.toMatchObject({
			status: "INVALID",
			reason: "TOKEN_MISMATCH",
		});
	});

	it("still enforces the workspace-untouched check on an extracted narrative-wrapped verdict via laneOutcome", async () => {
		const raw = `${NARRATIVE_PREFIX}${JSON.stringify(PASS_VERDICT)}`;
		await expect(
			laneOutcome(
				input({
					reader: reader(raw),
					after: { ...CLEAN_FINGERPRINT, trackedDiff: "changed" },
				}),
			),
		).resolves.toEqual({ outcome: "INVALID", reason: "REVIEWER_WROTE_REPO" });
	});

	it("does not scan for an extractable verdict once raw text exceeds the 1MB ceiling", async () => {
		const raw = `${"padding ".repeat(200_000)}${JSON.stringify(PASS_VERDICT)}`;
		expect(raw.length).toBeGreaterThan(1_000_000);
		await expect(checkVerdictFile(reader(raw), EXPECTED)).resolves.toMatchObject({
			status: "INVALID",
			reason: "CORRUPT",
		});
	});

	it("classifies a non-JSON payload far below the 1MB ceiling as CORRUPT via the ordinary extraction miss", async () => {
		const raw = `${"padding ".repeat(1_000)}not json at all`;
		expect(raw.length).toBeLessThan(1_000_000);
		await expect(checkVerdictFile(reader(raw), EXPECTED)).resolves.toMatchObject({
			status: "INVALID",
			reason: "CORRUPT",
		});
	});

	it("extracts a verdict past a deeply nested decoy candidate without hanging", async () => {
		let deeplyNested: unknown = "leaf";
		for (let depth = 0; depth < 1_000; depth += 1) {
			deeplyNested = { nested: deeplyNested };
		}
		const decoy = JSON.stringify({ apiVersion: "gatekeeper/v1", deeplyNested });
		const raw = `Debug dump: ${decoy}\nFinal: ${JSON.stringify(PASS_VERDICT)}`;
		await expect(checkVerdictFile(reader(raw), EXPECTED)).resolves.toEqual({ status: "VALID", verdict: PASS_VERDICT });
	});

	it("extracts a verdict past a decoy candidate containing a huge string without hanging", async () => {
		const decoy = JSON.stringify({ apiVersion: "gatekeeper/v1", huge: "x".repeat(500_000) });
		const raw = `Draft: ${decoy}\nFinal: ${JSON.stringify(PASS_VERDICT)}`;
		await expect(checkVerdictFile(reader(raw), EXPECTED)).resolves.toEqual({ status: "VALID", verdict: PASS_VERDICT });
	});

	it("leaves the pure-JSON fast path unaffected (no narrative, no extraction needed)", async () => {
		await expect(checkVerdictFile(reader(PASS_VERDICT), EXPECTED)).resolves.toEqual({
			status: "VALID",
			verdict: PASS_VERDICT,
		});
	});
});

describe("read-only workspace evidence", () => {
	it("accepts a value-equal dispatch fingerprint", () => {
		expect(
			checkWorkspaceUntouched(CLEAN_FINGERPRINT, {
				...CLEAN_FINGERPRINT,
				untracked: CLEAN_FINGERPRINT.untracked.map((item) => ({ ...item })),
			}),
		).toBe("CLEAN");
	});

	it.each([
		["head", { ...CLEAN_FINGERPRINT, head: "c".repeat(40) }],
		["porcelain", { ...CLEAN_FINGERPRINT, porcelain: " M src/a.ts\0" }],
		["tracked diff", { ...CLEAN_FINGERPRINT, trackedDiff: "diff --git a/a b/a" }],
		["untracked path", { ...CLEAN_FINGERPRINT, untracked: [{ path: "other.txt", hash: "b".repeat(40) }] }],
		["untracked hash", { ...CLEAN_FINGERPRINT, untracked: [{ path: "notes.txt", hash: "c".repeat(40) }] }],
		[
			"untracked order",
			{ ...CLEAN_FINGERPRINT, untracked: [...CLEAN_FINGERPRINT.untracked, ...CLEAN_FINGERPRINT.untracked] },
		],
	] as const)("detects changed %s", (_name, after) => {
		expect(checkWorkspaceUntouched(CLEAN_FINGERPRINT, after)).toBe("REVIEWER_WROTE_REPO");
	});
});

describe("combined lane outcome", () => {
	it.each(["TIMEOUT", "STALLED", "KILLED"] as const)(
		"gives supervisor-attested %s priority without requiring self-authored evidence",
		async (supervisorOutcome) => {
			await expect(laneOutcome({ supervisorOutcome })).resolves.toEqual({
				outcome: "INVALID",
				reason: supervisorOutcome,
			});
		},
	);

	it("gives an invalid verdict priority over workspace mutation", async () => {
		await expect(
			laneOutcome(
				input({
					reader: reader({ ...PASS_VERDICT, run_token: "rv1_stale" }),
					after: { ...CLEAN_FINGERPRINT, trackedDiff: "changed" },
				}),
			),
		).resolves.toMatchObject({ outcome: "INVALID", reason: "TOKEN_MISMATCH" });
	});

	it("invalidates a valid verdict when the reviewer wrote the repository", async () => {
		await expect(laneOutcome(input({ after: { ...CLEAN_FINGERPRINT, trackedDiff: "changed" } }))).resolves.toEqual({
			outcome: "INVALID",
			reason: "REVIEWER_WROTE_REPO",
		});
	});

	it.each([
		[PASS_VERDICT, "PASS"],
		[FAIL_VERDICT, "FAIL"],
	] as const)("maps a clean valid %s verdict into the A-package lane outcome enum", async (verdict, outcome) => {
		await expect(laneOutcome(input({ reader: reader(verdict) }))).resolves.toEqual({ outcome, verdict });
	});
});
