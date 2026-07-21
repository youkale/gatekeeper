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
 * The extraction fallback's own byte ceiling (approximated as UTF-16
 * code-unit length, which for the near-ASCII JSON this gate expects is a
 * tight proxy for byte size). This does not cap how much a `VerdictFileReader`
 * itself buffers into `raw` — that stays an open reader-level debt, recorded
 * in `docs/REVIEW.md` §9 — it only guarantees that a strict-parse failure on
 * an oversized payload fails closed as CORRUPT immediately, without ever
 * walking the text looking for candidate JSON objects.
 */
const VERDICT_JSON_SCAN_MAX_BYTES = 1_000_000;

/**
 * Narrow a parsed JSON value to "structurally could be a gatekeeper/v1
 * verdict" without running the full schema — used only to decide which
 * extracted candidates are worth a `reviewVerdictSchema` attempt at all.
 */
function hasGatekeeperV1ApiVersion(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as Record<string, unknown>).apiVersion === "gatekeeper/v1"
	);
}

/**
 * Scan `raw` once, left to right, for every complete *top-level* `{...}`
 * object literal — every span whose brace nesting starts at zero and returns
 * to zero — while treating characters inside JSON string literals (including
 * escaped quotes) as inert so a brace quoted in narrative prose or inside a
 * JSON string value never perturbs the count. This is a single linear pass
 * over a small fixed amount of state (nesting depth, string/escape flags,
 * one pending start index): O(raw.length) time, O(candidate count) space, no
 * recursion and no regex, so it cannot backtrack and cannot be driven into
 * quadratic or worse behavior by adversarial input.
 *
 * Deliberately top-level-only rather than "try every `{` as an independent
 * start": a stdout-direct reviewer CLI wraps its real delivered object in
 * prose, never inside another JSON object, and any decoy/example JSON
 * fragment narrative might quote is itself a complete, self-contained
 * object — so restricting candidates to top-level spans loses nothing a real
 * reviewer CLI could produce while keeping the scan strictly linear (trying
 * every `{` as a start point would be quadratic in the worst case on hostile
 * input). If narrative prose happens to contain an unbalanced literal quote
 * or brace, the affected region simply fails to yield a usable candidate —
 * that fails closed into CORRUPT/SCHEMA_MISMATCH downstream, which is the
 * safe direction for a fail-closed evidence gate.
 */
function extractBalancedTopLevelJsonCandidates(raw: string): string[] {
	const candidates: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) {
				start = i;
			}
			depth += 1;
			continue;
		}
		if (ch === "}" && depth > 0) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				candidates.push(raw.slice(start, i + 1));
				start = -1;
			}
		}
	}
	return candidates;
}

/**
 * Best-effort, framework-tolerant recovery for a stdout-direct channel's raw
 * text that failed a strict `JSON.parse`: extract every complete top-level
 * JSON object, keep only those that at least look like a gatekeeper/v1
 * verdict (`apiVersion` literal match), and hand back the *last* one — in
 * document order — that fully passes `reviewVerdictSchema`. A narrative
 * preamble can plausibly quote an example or decoy JSON fragment before the
 * real delivered object, and by convention a streaming CLI's real payload is
 * emitted last, so "last schema-valid candidate wins" finds a genuine
 * trailing delivery without being fooled by an earlier decoy.
 *
 * Returns `undefined` when no candidate is even structurally a
 * gatekeeper/v1-tagged object, so the caller falls back to the original
 * CORRUPT diagnosis unchanged. When at least one such candidate exists but
 * none passes the full schema, this still returns the last one so the
 * caller's ordinary `reviewVerdictSchema.safeParse` call reproduces exactly
 * the SCHEMA_MISMATCH issues extraction would otherwise have had to
 * duplicate — extraction only ever changes the *value* fed into the existing
 * strict pipeline, never that pipeline's own pass/fail semantics.
 */
function recoverNarrativeWrappedVerdict(raw: string): unknown {
	const eligible = extractBalancedTopLevelJsonCandidates(raw)
		.map((candidate) => {
			try {
				return JSON.parse(candidate) as unknown;
			} catch {
				return undefined;
			}
		})
		.filter((value): value is Record<string, unknown> => value !== undefined && hasGatekeeperV1ApiVersion(value));

	if (eligible.length === 0) {
		return undefined;
	}
	for (let i = eligible.length - 1; i >= 0; i -= 1) {
		if (reviewVerdictSchema.safeParse(eligible[i]).success) {
			return eligible[i];
		}
	}
	return eligible[eligible.length - 1];
}

/**
 * Read and hard-validate VERDICT.json through an injected reader, then perform
 * the sole token and round freshness checks. The public reason set has no
 * read-error variant, so non-missing reader failures conservatively map to
 * CORRUPT rather than escaping or being mistaken for valid evidence.
 *
 * Parsing is framework-tolerant, semantics-strict: a direct `JSON.parse`
 * failure is not immediately fatal. Real stdout-direct reviewer CLIs stream
 * conversational narrative around their JSON payload (verified against a
 * captured real-world artifact) — a fact prompt wording cannot reliably
 * suppress — so a bounded fallback (`recoverNarrativeWrappedVerdict`, guarded
 * by `VERDICT_JSON_SCAN_MAX_BYTES`) attempts to extract the delivered object
 * before giving up. This applies identically to both the file and stdout
 * channels: a clean, file-sourced VERDICT.json parses on the first attempt
 * and never reaches the extraction path at all. Once a value is in hand —
 * parsed directly or recovered — every subsequent check (schema, token,
 * round) is exactly as strict as before; extraction never loosens what
 * counts as a valid verdict.
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
		if (raw.length > VERDICT_JSON_SCAN_MAX_BYTES) {
			return { status: "INVALID", reason: "CORRUPT", message: errorMessage(error) };
		}
		const recovered = recoverNarrativeWrappedVerdict(raw);
		if (recovered === undefined) {
			return { status: "INVALID", reason: "CORRUPT", message: errorMessage(error) };
		}
		value = recovered;
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
