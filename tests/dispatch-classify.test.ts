import { describe, expect, it } from "vitest";

import {
	type ClassificationInput,
	type ClassificationInputError,
	classifyRunOutcome,
} from "../src/dispatch/classify.js";
import type { CommitEvidence, DeliveryEvidence, ResultFileEvidence } from "../src/dispatch/evidence.js";
import { runSchema } from "../src/dispatch/types.js";

const NOW = new Date("2026-07-20T00:00:00.000Z");
const DELIVERED_RESULT: ResultFileEvidence = {
	established: true,
	result: {
		apiVersion: "gatekeeper/v1",
		status: "delivered",
		summary: "Delivery complete.",
	},
};
const BLOCKED_RESULT: ResultFileEvidence = {
	established: true,
	result: {
		apiVersion: "gatekeeper/v1",
		status: "blocked",
		summary: "Cannot continue without external input.",
	},
};
const MISSING_RESULT: ResultFileEvidence = {
	established: false,
	reason: "missing",
	message: "not found",
};
const VALID_COMMIT: CommitEvidence = {
	established: true,
	commitSubjects: ["feat: delivery"],
	nonWipCommitSubjects: ["feat: delivery"],
};
const NO_COMMIT: CommitEvidence = { established: false, reason: "no-commits", commitSubjects: [] };

const COMPLETE_EVIDENCE: DeliveryEvidence = { resultFile: DELIVERED_RESULT, commit: VALID_COMMIT };
const NO_EVIDENCE: DeliveryEvidence = { resultFile: MISSING_RESULT, commit: NO_COMMIT };

function input(overrides: Partial<ClassificationInput> = {}): ClassificationInput {
	return {
		cliName: "claude",
		exitCode: 1,
		signal: null,
		stdoutTail: "",
		stderrTail: "ordinary agent failure",
		evidence: NO_EVIDENCE,
		nowMs: NOW.getTime(),
		...overrides,
	};
}

function unsafeInput(overrides: Record<string, unknown>): ClassificationInput {
	return { ...input(), ...overrides } as ClassificationInput;
}

describe("classification priority", () => {
	it.each(["TIMEOUT", "STALLED", "KILLED"] as const)(
		"supervisor-attested %s wins over blocked evidence and rate patterns",
		(supervisorOutcome) => {
			const result = classifyRunOutcome(
				input({
					supervisorOutcome,
					evidence: { resultFile: BLOCKED_RESULT, commit: VALID_COMMIT },
					stderrTail: "You've hit your limit; resets in 2h",
				}),
			);
			expect(result).toEqual({ outcome: supervisorOutcome, source: "supervisor" });
		},
	);

	it("completed evidence wins over a rate-limit pattern", () => {
		expect(
			classifyRunOutcome(
				input({ exitCode: 0, evidence: COMPLETE_EVIDENCE, stderrTail: "You've hit your limit; resets in 2h" }),
			),
		).toEqual({ outcome: "COMPLETED", source: "evidence" });
	});

	it.each([0, 1, 17])("blocked RESULT.json overrides exit code %i", (exitCode) => {
		expect(
			classifyRunOutcome(input({ exitCode, evidence: { resultFile: BLOCKED_RESULT, commit: NO_COMMIT } })),
		).toEqual({ outcome: "AGENT_BLOCKED", source: "evidence" });
	});

	it("a rate-limit rule wins over a generic network-error pattern", () => {
		const result = classifyRunOutcome(
			input({ stderrTail: "You've hit your usage limit; resets in 2h (ETIMEDOUT while reporting)." }),
		);
		expect(result).toMatchObject({
			outcome: "RATE_LIMITED",
			source: "rule",
			matchedRule: { family: "claude", index: 0 },
		});
	});

	it("an other-pattern rule wins over the same conservative AGENT_ERROR fallback", () => {
		const result = classifyRunOutcome(input({ cliName: "unknown-agent", stderrTail: "request failed: ECONNRESET" }));
		expect(result).toMatchObject({
			outcome: "AGENT_ERROR",
			source: "rule",
			matchedRule: { family: "generic", index: 0 },
		});
	});

	it("known CLI families fall through to generic common-error rules after their family rules", () => {
		const result = classifyRunOutcome(input({ cliName: "claude", stderrTail: "request failed: ECONNREFUSED" }));
		expect(result).toMatchObject({
			outcome: "AGENT_ERROR",
			source: "rule",
			matchedRule: { family: "generic", index: 0 },
		});
	});
});

describe("table-driven CLI rules", () => {
	// All samples below are self-authored, pending replacement with real dogfood samples.
	it.each([
		{
			name: "claude positive",
			cliName: "claude",
			stderrTail: "You've hit your limit; resets in 2h.",
			expectedOutcome: "RATE_LIMITED",
			expectedSource: "rule",
			expectedFamily: "claude",
		},
		{
			name: "claude negative vague quota prose",
			cliName: "claude",
			stderrTail: "The project documentation discusses a rate limit.",
			expectedOutcome: "AGENT_ERROR",
			expectedSource: "fallback",
		},
		{
			name: "codex positive",
			cliName: "codex",
			stderrTail: "You have hit your Codex usage limit. Try again later.",
			expectedOutcome: "RATE_LIMITED",
			expectedSource: "rule",
			expectedFamily: "codex",
		},
		{
			name: "codex negative HTTP status alone",
			cliName: "codex",
			stderrTail: "request failed with status 429",
			expectedOutcome: "AGENT_ERROR",
			expectedSource: "fallback",
		},
		{
			name: "grok positive",
			cliName: "grok",
			stderrTail: "Grok API rate limit exceeded; retry after 60 seconds.",
			expectedOutcome: "RATE_LIMITED",
			expectedSource: "rule",
			expectedFamily: "grok",
		},
		{
			name: "grok negative generic limit wording",
			cliName: "grok",
			stderrTail: "A downstream service says requests are limited.",
			expectedOutcome: "AGENT_ERROR",
			expectedSource: "fallback",
		},
		{
			name: "generic positive",
			cliName: "kimi",
			stderrTail: "fetch failed: getaddrinfo ENOTFOUND api.example.invalid",
			expectedOutcome: "AGENT_ERROR",
			expectedSource: "rule",
			expectedFamily: "generic",
		},
		{
			name: "generic negative lowercase prose",
			cliName: "kimi",
			stderrTail: "the response says connection timed out",
			expectedOutcome: "AGENT_ERROR",
			expectedSource: "fallback",
		},
	] as const)("classifies $name", (testCase) => {
		const result = classifyRunOutcome(input({ cliName: testCase.cliName, stderrTail: testCase.stderrTail }));
		expect(result.outcome).toBe(testCase.expectedOutcome);
		expect(result.source).toBe(testCase.expectedSource);
		if (testCase.expectedFamily) {
			expect(result.matchedRule).toEqual({ family: testCase.expectedFamily, index: 0 });
		} else {
			expect(result.matchedRule).toBeUndefined();
		}
	});

	it("does not apply a family rule to an unknown CLI name", () => {
		const result = classifyRunOutcome(
			input({ cliName: "third-party", stderrTail: "You've hit your usage limit; resets in 2h." }),
		);
		expect(result).toEqual({ outcome: "AGENT_ERROR", source: "fallback" });
	});

	it("under-matches a precise rate message when the exit code is outside the rule domain", () => {
		const result = classifyRunOutcome(input({ exitCode: 2, stderrTail: "You've hit your usage limit; resets in 2h." }));
		expect(result).toEqual({ outcome: "AGENT_ERROR", source: "fallback" });
	});
});

describe("cooldown resolution", () => {
	it("resolves a captured relative reset into an absolute timestamp using the injected instant", () => {
		const result = classifyRunOutcome(input({ stderrTail: "You've hit your usage limit; resets in 2h 30m." }));
		expect(result.cooldown).toEqual({
			defaultSeconds: 18_000,
			resumeAfter: "2026-07-20T02:30:00.000Z",
			resetTimeCaptured: true,
		});
	});

	it("uses claude's five-hour default when no reset time is captured", () => {
		const result = classifyRunOutcome(input({ stderrTail: "You've hit your usage limit; resets sometime later." }));
		expect(result.cooldown).toEqual({
			defaultSeconds: 18_000,
			resumeAfter: "2026-07-20T05:00:00.000Z",
			resetTimeCaptured: false,
		});
	});

	it("accepts a future absolute ISO reset timestamp", () => {
		const result = classifyRunOutcome(
			input({ stderrTail: "You've hit your usage limit; resets at 2026-07-20T09:00:00+08:00." }),
		);
		expect(result.cooldown?.resumeAfter).toBe("2026-07-20T01:00:00.000Z");
		expect(result.cooldown?.resetTimeCaptured).toBe(true);
	});

	it("binds reset capture to the matched vendor clause when stderr contains a competing reset", () => {
		const result = classifyRunOutcome(
			input({
				stderrTail: "A background service resets in 1m.\nYou've hit your usage limit; resets in 2h.",
			}),
		);
		expect(result.cooldown?.resumeAfter).toBe("2026-07-20T02:00:00.000Z");
		expect(result.cooldown?.resetTimeCaptured).toBe(true);
	});

	it.each([
		["overflowing duration", "You've hit your usage limit; resets in 999999999999999999999999999h."],
		["invalid calendar date", "You've hit your usage limit; resets at 2027-02-30T09:00:00Z."],
	] as const)("falls back to claude's default for an %s", (_name, stderrTail) => {
		const result = classifyRunOutcome(input({ stderrTail }));
		expect(result.cooldown).toEqual({
			defaultSeconds: 18_000,
			resumeAfter: "2026-07-20T05:00:00.000Z",
			resetTimeCaptured: false,
		});
	});

	it("resolves a codex try-again duration with the injected instant", () => {
		const result = classifyRunOutcome(
			input({
				cliName: "codex",
				stderrTail: "You have hit your Codex usage limit. Try again in 45 minutes.",
			}),
		);
		expect(result.cooldown).toEqual({
			defaultSeconds: 3_600,
			resumeAfter: "2026-07-20T00:45:00.000Z",
			resetTimeCaptured: true,
		});
	});

	it("resolves a grok retry-after duration with the injected instant", () => {
		const result = classifyRunOutcome(
			input({
				cliName: "grok",
				stderrTail: "Grok API rate limit exceeded; retry after 90 seconds.",
			}),
		);
		expect(result.cooldown).toEqual({
			defaultSeconds: 3_600,
			resumeAfter: "2026-07-20T00:01:30.000Z",
			resetTimeCaptured: true,
		});
	});
});

describe("conservative fallback and output legality", () => {
	it.each([
		["nonzero exit", { exitCode: 9, signal: null }, "AGENT_ERROR"],
		["zero exit", { exitCode: 0, signal: null }, "EXITED_NO_EVIDENCE"],
	] as const)("uses the legal fallback for %s", (_name, terminal, expectedOutcome) => {
		expect(classifyRunOutcome(input(terminal))).toEqual({ outcome: expectedOutcome, source: "fallback" });
	});

	it.each([["unknown exit", { exitCode: null, signal: null }]] as const)(
		"rejects %s instead of inferring an attested outcome",
		(_name, terminal) => {
			expect(() => classifyRunOutcome(input(terminal))).toThrowError(
				expect.objectContaining<Partial<ClassificationInputError>>({ code: "UNATTESTED_TERMINATION" }),
			);
		},
	);

	it("reports a genuine non-attested signal-only exit as unrepresentable by the current Run schema", () => {
		expect(() => classifyRunOutcome(input({ exitCode: null, signal: "SIGTERM" }))).toThrowError(
			expect.objectContaining<Partial<ClassificationInputError>>({ code: "UNREPRESENTABLE_TERMINATION" }),
		);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE])(
		"only validates invalid injected clock value %s when a cooldown is computed",
		(nowMs) => {
			expect(classifyRunOutcome(input({ nowMs }))).toEqual({ outcome: "AGENT_ERROR", source: "fallback" });
			expect(() =>
				classifyRunOutcome(input({ nowMs, stderrTail: "You've hit your usage limit; resets sometime later." })),
			).toThrowError(expect.objectContaining<Partial<ClassificationInputError>>({ code: "INVALID_NOW" }));
		},
	);

	it("reports cooldown timestamp overflow as the same structured clock-input error", () => {
		expect(() =>
			classifyRunOutcome(
				input({ nowMs: 8_640_000_000_000_000, stderrTail: "You've hit your usage limit; resets sometime later." }),
			),
		).toThrowError(expect.objectContaining<Partial<ClassificationInputError>>({ code: "INVALID_NOW" }));
	});

	it.each([
		[
			"missing RESULT.json",
			{ established: false, reason: "missing", message: "not found" } satisfies ResultFileEvidence,
			VALID_COMMIT,
			"EXITED_NO_EVIDENCE",
		],
		[
			"corrupt RESULT.json",
			{ established: false, reason: "corrupt", message: "invalid JSON" } satisfies ResultFileEvidence,
			VALID_COMMIT,
			"EXITED_NO_EVIDENCE",
		],
		[
			"schema-mismatched RESULT.json",
			{ established: false, reason: "schema-mismatch", message: "invalid shape" } satisfies ResultFileEvidence,
			VALID_COMMIT,
			"EXITED_NO_EVIDENCE",
		],
		["status blocked", BLOCKED_RESULT, VALID_COMMIT, "AGENT_BLOCKED"],
		["no commit", DELIVERED_RESULT, NO_COMMIT, "EXITED_NO_EVIDENCE"],
		[
			"only WIP commits",
			DELIVERED_RESULT,
			{
				established: false,
				reason: "only-wip-commits",
				commitSubjects: ["wip: run r001 checkpoint (gatekeeper dispatch)"],
			} satisfies CommitEvidence,
			"EXITED_NO_EVIDENCE",
		],
	] as const)("exit zero with %s never yields COMPLETED", (_name, resultFile, commit, expectedOutcome) => {
		const result = classifyRunOutcome(input({ exitCode: 0, evidence: { resultFile, commit } }));
		expect(result.outcome).toBe(expectedOutcome);
		expect(result.outcome).not.toBe("COMPLETED");
	});

	it("does not emit COMPLETED for a signaled terminal record even if both evidence checks pass", () => {
		expect(() =>
			classifyRunOutcome(input({ exitCode: 0, signal: "SIGTERM", evidence: COMPLETE_EVIDENCE })),
		).toThrowError(expect.objectContaining<Partial<ClassificationInputError>>({ code: "INVALID_TERMINAL_TUPLE" }));
	});
});

describe("terminal input domain validation", () => {
	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1"])(
		"rejects invalid exitCode %s before supervisor or blocked-evidence priority",
		(exitCode) => {
			expect(() =>
				classifyRunOutcome(
					unsafeInput({
						exitCode,
						supervisorOutcome: "TIMEOUT",
						evidence: { resultFile: BLOCKED_RESULT, commit: VALID_COMMIT },
					}),
				),
			).toThrowError(expect.objectContaining<Partial<ClassificationInputError>>({ code: "INVALID_EXIT_CODE" }));
		},
	);

	it.each(["", 7])("rejects invalid signal %s before supervisor or blocked-evidence priority", (signal) => {
		expect(() =>
			classifyRunOutcome(
				unsafeInput({
					exitCode: null,
					signal,
					supervisorOutcome: "KILLED",
					evidence: { resultFile: BLOCKED_RESULT, commit: VALID_COMMIT },
				}),
			),
		).toThrowError(expect.objectContaining<Partial<ClassificationInputError>>({ code: "INVALID_SIGNAL" }));
	});

	it("rejects a dual non-null exit/signal tuple before supervisor or blocked-evidence priority", () => {
		expect(() =>
			classifyRunOutcome(
				input({
					exitCode: 1,
					signal: "SIGTERM",
					supervisorOutcome: "KILLED",
					evidence: { resultFile: BLOCKED_RESULT, commit: VALID_COMMIT },
				}),
			),
		).toThrowError(expect.objectContaining<Partial<ClassificationInputError>>({ code: "INVALID_TERMINAL_TUPLE" }));
	});

	it("allows attested signal-only/null-null tuples and blocked signal-only evidence", () => {
		expect(classifyRunOutcome(input({ exitCode: null, signal: "SIGTERM", supervisorOutcome: "KILLED" }))).toEqual({
			outcome: "KILLED",
			source: "supervisor",
		});
		expect(classifyRunOutcome(input({ exitCode: null, signal: null, supervisorOutcome: "TIMEOUT" }))).toEqual({
			outcome: "TIMEOUT",
			source: "supervisor",
		});
		expect(
			classifyRunOutcome({
				...input(),
				exitCode: null,
				signal: "SIGTERM",
				evidence: { resultFile: BLOCKED_RESULT, commit: NO_COMMIT },
			}),
		).toEqual({ outcome: "AGENT_BLOCKED", source: "evidence" });
	});
});

describe("classifier output compatibility with package A runSchema", () => {
	const cases: readonly ClassificationInput[] = [
		input({ exitCode: 0, evidence: COMPLETE_EVIDENCE }),
		input({ evidence: { resultFile: BLOCKED_RESULT, commit: NO_COMMIT } }),
		input({ stderrTail: "You've hit your usage limit; resets in 2h." }),
		input(),
		input({ exitCode: 0 }),
		input({ exitCode: null, signal: "SIGTERM", supervisorOutcome: "KILLED" }),
		input({ exitCode: null, signal: null, supervisorOutcome: "TIMEOUT" }),
		input({ exitCode: null, signal: null, supervisorOutcome: "STALLED" }),
	];

	it.each(cases)("emits a legal $supervisorOutcome/$exitCode/$signal terminal record", (classificationInput) => {
		const result = classifyRunOutcome(classificationInput);
		const parsed = runSchema.safeParse({
			apiVersion: "gatekeeper/v1",
			id: "r001",
			cli: classificationInput.cliName,
			vendor: "test-vendor",
			command: "test-agent",
			brief_path: "runs/r001/brief.md",
			started_at: "2026-07-20T00:00:00.000Z",
			ended_at: "2026-07-20T01:00:00.000Z",
			outcome: result.outcome,
			exit_code: classificationInput.exitCode,
			signal: classificationInput.signal,
			stdout_path: "runs/r001/stdout.log",
			stderr_path: "runs/r001/stderr.log",
			out_path: "runs/r001/out",
		});
		expect(parsed.success, parsed.success ? undefined : parsed.error.message).toBe(true);
	});
});
