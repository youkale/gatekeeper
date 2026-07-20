import type { SupervisorAttestedOutcome } from "../dispatch/classify.js";
import type { WorkspaceFingerprint } from "../dispatch/workspace.js";
import type { RoundLaneResult } from "./types.js";
import { type ReviewVerdict, reviewVerdictSchema } from "./verdict.js";

/** Injected, already-bound reader for one lane's VERDICT.json path. */
export interface VerdictFileReader {
	readText(): Promise<string>;
}

/** Brief-owned values that a lane must echo to establish fresh evidence. */
export interface ExpectedVerdictIdentity {
	readonly run_token: string;
	readonly round: number;
}

/** Stable schema diagnostic safe to persist in review supervision state. */
export interface VerdictSchemaIssue {
	readonly code: string;
	readonly path: readonly (string | number)[];
	readonly message: string;
}

/** Exhaustive invalidity classes produced by the VERDICT.json evidence gate. */
export type VerdictFileInvalidReason = "MISSING" | "CORRUPT" | "SCHEMA_MISMATCH" | "TOKEN_MISMATCH" | "ROUND_MISMATCH";

/** Structured result of reading, parsing, validating, and binding a verdict. */
export type VerdictFileCheck =
	| { readonly status: "VALID"; readonly verdict: ReviewVerdict }
	| {
			readonly status: "INVALID";
			readonly reason: VerdictFileInvalidReason;
			readonly message: string;
			readonly issues?: readonly VerdictSchemaIssue[];
	  };

/** Result of comparing the reviewer workspace fingerprints before and after a lane. */
export type WorkspaceUntouchedCheck = "CLEAN" | "REVIEWER_WROTE_REPO";

/** Every fail-closed reason emitted by the combined lane evidence decision. */
export type ReviewLaneInvalidReason = VerdictFileInvalidReason | "REVIEWER_WROTE_REPO" | SupervisorAttestedOutcome;

type ReviewLaneOutcomeValue = RoundLaneResult["outcome"];

/**
 * Evidence-backed lane result whose `outcome` is anchored to A package's
 * `RoundLaneResult` enum rather than redeclaring a parallel outcome contract.
 */
export type ReviewLaneOutcome =
	| {
			readonly outcome: Extract<ReviewLaneOutcomeValue, "PASS" | "FAIL">;
			readonly verdict: ReviewVerdict;
	  }
	| {
			readonly outcome: Extract<ReviewLaneOutcomeValue, "INVALID">;
			readonly reason: ReviewLaneInvalidReason;
			readonly message?: string;
			readonly issues?: readonly VerdictSchemaIssue[];
	  };

/** Supervisor-only lane input; attested facts require no self-authored evidence. */
export interface SupervisorLaneOutcomeInput {
	readonly supervisorOutcome: SupervisorAttestedOutcome;
}

/** Normal lane input containing every injected verdict and workspace seam. */
export interface EvidenceLaneOutcomeInput {
	readonly supervisorOutcome?: undefined;
	readonly reader: VerdictFileReader;
	readonly expected: ExpectedVerdictIdentity;
	readonly before: WorkspaceFingerprint;
	readonly after: WorkspaceFingerprint;
}

/** Discriminated input to the deterministic lane evidence decision. */
export type LaneOutcomeInput = SupervisorLaneOutcomeInput | EvidenceLaneOutcomeInput;

function errorCode(error: unknown): string | undefined {
	try {
		if ((typeof error !== "object" && typeof error !== "function") || error === null) {
			return undefined;
		}
		const code = Reflect.get(error, "code");
		return typeof code === "string" ? code : undefined;
	} catch {
		return undefined;
	}
}

function errorMessage(error: unknown): string {
	try {
		if (error instanceof Error && typeof error.message === "string") {
			return error.message;
		}
	} catch {
		// Hostile proxies can throw from instanceof/getPrototypeOf or property access.
	}
	try {
		return String(error);
	} catch {
		return "reader failed without accessible error detail";
	}
}

function isMissingPathError(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Read and hard-validate VERDICT.json through an injected reader, then perform
 * the sole token and round freshness checks. The public reason set has no
 * read-error variant, so non-missing reader failures conservatively map to
 * CORRUPT rather than escaping or being mistaken for valid evidence.
 */
export async function checkVerdictFile(
	reader: VerdictFileReader,
	expected: ExpectedVerdictIdentity,
): Promise<VerdictFileCheck> {
	let raw: string;
	try {
		raw = await reader.readText();
	} catch (error) {
		return {
			status: "INVALID",
			reason: isMissingPathError(error) ? "MISSING" : "CORRUPT",
			message: errorMessage(error),
		};
	}

	if (typeof raw !== "string") {
		return { status: "INVALID", reason: "CORRUPT", message: "VERDICT.json reader did not return text" };
	}

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		return { status: "INVALID", reason: "CORRUPT", message: errorMessage(error) };
	}

	const parsed = reviewVerdictSchema.safeParse(value);
	if (!parsed.success) {
		return {
			status: "INVALID",
			reason: "SCHEMA_MISMATCH",
			message: "VERDICT.json does not match the gatekeeper/v1 review verdict schema",
			issues: parsed.error.issues.map((issue) => ({
				code: issue.code,
				path: [...issue.path],
				message: issue.message,
			})),
		};
	}

	if (parsed.data.run_token !== expected.run_token) {
		return {
			status: "INVALID",
			reason: "TOKEN_MISMATCH",
			message: "VERDICT.json run_token does not match the lane brief",
		};
	}
	if (parsed.data.round !== expected.round) {
		return {
			status: "INVALID",
			reason: "ROUND_MISMATCH",
			message: "VERDICT.json round does not match the active review round",
		};
	}

	return { status: "VALID", verdict: parsed.data };
}

/** Compare the complete dispatch workspace fingerprint without performing I/O. */
export function checkWorkspaceUntouched(
	before: WorkspaceFingerprint,
	after: WorkspaceFingerprint,
): WorkspaceUntouchedCheck {
	const untrackedMatches =
		before.untracked.length === after.untracked.length &&
		before.untracked.every(
			(item, index) => item.path === after.untracked[index]?.path && item.hash === after.untracked[index]?.hash,
		);
	return before.head === after.head &&
		before.porcelain === after.porcelain &&
		before.trackedDiff === after.trackedDiff &&
		untrackedMatches
		? "CLEAN"
		: "REVIEWER_WROTE_REPO";
}

/**
 * Decide one lane in strict priority order:
 *
 * 1. Supervisor-attested TIMEOUT/STALLED/KILLED facts outrank self-authored
 *    artifacts, so they become INVALID immediately and skip all evidence I/O.
 * 2. VERDICT.json must then establish schema, token, and round freshness.
 * 3. Only a valid verdict reaches the final read-only fingerprint check; any
 *    repository mutation invalidates even an otherwise valid pass or fail.
 *
 * C package owns runner wiring, including the existing stdout-to-result_path
 * fallback for CLIs without an output-file flag. That channel must materialize
 * VERDICT.json before this pure evidence function is called.
 */
export async function laneOutcome(input: LaneOutcomeInput): Promise<ReviewLaneOutcome> {
	if (input.supervisorOutcome !== undefined) {
		return { outcome: "INVALID", reason: input.supervisorOutcome };
	}

	const file = await checkVerdictFile(input.reader, input.expected);
	if (file.status === "INVALID") {
		return { outcome: "INVALID", reason: file.reason, message: file.message, issues: file.issues };
	}

	const workspace = checkWorkspaceUntouched(input.before, input.after);
	if (workspace === "REVIEWER_WROTE_REPO") {
		return { outcome: "INVALID", reason: workspace };
	}

	return { outcome: file.verdict.verdict === "pass" ? "PASS" : "FAIL", verdict: file.verdict };
}
