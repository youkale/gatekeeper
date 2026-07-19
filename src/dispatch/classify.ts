import { type DeliveryEvidence, evaluateDeliveryEvidence } from "./evidence.js";
import type { RunOutcome } from "./types.js";

export type SupervisorAttestedOutcome = "TIMEOUT" | "STALLED" | "KILLED";
export type RuleFamily = "claude" | "codex" | "grok" | "generic";

export interface OutcomeRule {
	readonly outcome: RunOutcome;
	readonly match: {
		readonly exitCodes?: readonly number[];
		readonly stderrPattern?: RegExp;
		readonly stdoutPattern?: RegExp;
	};
	readonly cooldown?: {
		readonly defaultSeconds: number;
		readonly resetTimeCapture?: RegExp;
	};
}

const CLAUDE_RESET_CAPTURE =
	/\byou(?:'ve| have) hit your (?:claude )?(?:usage )?limit\b[^\r\n]{0,200}?\bresets?\s+(?<reset>(?:in\s+(?:\d+h(?:\s+\d+m)?|\d+m|\d+\s+(?:seconds?|minutes?|hours?))|(?:at\s+)?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})))/i;
const CODEX_RESET_CAPTURE =
	/\byou(?:'ve| have) hit your (?:codex )?usage limit\b[^\r\n]{0,200}?\b(?:try again|resets?)\s+(?<reset>(?:(?:in|after)\s+(?:\d+h(?:\s+\d+m)?|\d+m|\d+\s+(?:seconds?|minutes?|hours?))|(?:at\s+)?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})))/i;
const GROK_RESET_CAPTURE =
	/\bgrok (?:api )?rate limit exceeded\b[^\r\n]{0,200}?\b(?:retry|resets?)\s+(?<reset>(?:(?:in|after)\s+(?:\d+h(?:\s+\d+m)?|\d+m|\d+\s+(?:seconds?|minutes?|hours?))|(?:at\s+)?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})))/i;

/**
 * CLI keys deliberately mirror KNOWN_AGENT_CLIS names. The generic group is
 * used for every unknown name; classifier patterns are separate from CLI
 * launch/detection metadata by design.
 */
export const OUTCOME_RULES = {
	claude: [
		{
			outcome: "RATE_LIMITED",
			match: {
				exitCodes: [1],
				stderrPattern: /\byou(?:'ve| have) hit your (?:claude )?(?:usage )?limit\b(?=[^\r\n]{0,200}\bresets?\b)/i,
			},
			cooldown: { defaultSeconds: 5 * 60 * 60, resetTimeCapture: CLAUDE_RESET_CAPTURE },
		},
	],
	codex: [
		{
			outcome: "RATE_LIMITED",
			match: {
				exitCodes: [1],
				stderrPattern:
					/\byou(?:'ve| have) hit your (?:codex )?usage limit\b(?=[^\r\n]{0,200}\b(?:try again|resets?)\b)/i,
			},
			cooldown: { defaultSeconds: 60 * 60, resetTimeCapture: CODEX_RESET_CAPTURE },
		},
	],
	grok: [
		{
			outcome: "RATE_LIMITED",
			match: {
				exitCodes: [1],
				stderrPattern: /\bgrok (?:api )?rate limit exceeded\b(?=[^\r\n]{0,200}\b(?:retry after|resets?)\b)/i,
			},
			cooldown: { defaultSeconds: 60 * 60, resetTimeCapture: GROK_RESET_CAPTURE },
		},
	],
	generic: [
		{
			outcome: "AGENT_ERROR",
			match: {
				exitCodes: [1],
				stderrPattern: /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT)\b/,
			},
		},
	],
} as const satisfies Record<RuleFamily, readonly OutcomeRule[]>;

export interface ClassificationInput {
	readonly cliName: string;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly stdoutTail: string;
	readonly stderrTail: string;
	readonly evidence: DeliveryEvidence;
	readonly supervisorOutcome?: SupervisorAttestedOutcome;
	/** Caller-attested current instant; must be a finite epoch-millisecond value. */
	readonly nowMs: number;
}

export interface CooldownClassification {
	readonly defaultSeconds: number;
	readonly resumeAfter: string;
	readonly resetTimeCaptured: boolean;
}

export interface ClassificationResult {
	readonly outcome: RunOutcome;
	readonly source: "supervisor" | "evidence" | "rule" | "fallback";
	readonly matchedRule?: { readonly family: RuleFamily; readonly index: number };
	readonly cooldown?: CooldownClassification;
}

export type ClassificationInputErrorCode =
	| "INVALID_EXIT_CODE"
	| "INVALID_SIGNAL"
	| "INVALID_TERMINAL_TUPLE"
	| "INVALID_NOW"
	| "UNATTESTED_TERMINATION"
	| "UNREPRESENTABLE_TERMINATION";

/** A programmer/input-contract error, never a synthesized Run outcome. */
export class ClassificationInputError extends Error {
	readonly code: ClassificationInputErrorCode;

	constructor(code: ClassificationInputErrorCode, message: string) {
		super(message);
		this.name = "ClassificationInputError";
		this.code = code;
	}
}

function ruleFamily(cliName: string): RuleFamily {
	if (cliName === "claude" || cliName === "codex" || cliName === "grok") {
		return cliName;
	}
	return "generic";
}

function matchesRule(rule: OutcomeRule, input: ClassificationInput): boolean {
	const { match } = rule;
	if (match.exitCodes !== undefined && (input.exitCode === null || !match.exitCodes.includes(input.exitCode))) {
		return false;
	}
	if (match.stderrPattern !== undefined && !match.stderrPattern.test(input.stderrTail)) {
		return false;
	}
	if (match.stdoutPattern !== undefined && !match.stdoutPattern.test(input.stdoutTail)) {
		return false;
	}
	return true;
}

function durationMilliseconds(reset: string): number | undefined {
	const compact = /^in\s+(?:(\d+)h(?:\s+(\d+)m)?|(\d+)m)$/i.exec(reset);
	const words = /^(?:in|after)\s+(\d+)\s+(seconds?|minutes?|hours?)$/i.exec(reset);
	let milliseconds: bigint;
	if (compact) {
		const hours = BigInt(compact[1] ?? 0);
		const minutes = BigInt(compact[2] ?? compact[3] ?? 0);
		milliseconds = (hours * 60n + minutes) * 60_000n;
	} else if (words) {
		const value = BigInt(words[1] ?? 0);
		const unit = words[2]?.toLowerCase();
		const factor = unit?.startsWith("second") ? 1_000n : unit?.startsWith("minute") ? 60_000n : 3_600_000n;
		milliseconds = value * factor;
	} else {
		return undefined;
	}
	return milliseconds > 0n && milliseconds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(milliseconds) : undefined;
}

function parseStrictIsoTimestamp(reset: string): number | undefined {
	const value = reset.replace(/^at\s+/i, "");
	const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
		value,
	);
	if (!parts) {
		return undefined;
	}
	const year = Number(parts[1]);
	const month = Number(parts[2]);
	const day = Number(parts[3]);
	const hour = Number(parts[4]);
	const minute = Number(parts[5]);
	const second = Number(parts[6] ?? 0);
	const offsetHour = Number(parts[10] ?? 0);
	const offsetMinute = Number(parts[11] ?? 0);
	const calendarProbe = new Date(Date.UTC(year, month - 1, day));
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		calendarProbe.getUTCFullYear() !== year ||
		calendarProbe.getUTCMonth() !== month - 1 ||
		calendarProbe.getUTCDate() !== day ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		offsetHour > 23 ||
		offsetMinute > 59
	) {
		return undefined;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseCapturedReset(capture: RegExp, stderr: string, nowMs: number): number | undefined {
	const reset = capture.exec(stderr)?.groups?.reset;
	if (!reset) {
		return undefined;
	}
	const durationMs = durationMilliseconds(reset);
	const resolved = durationMs === undefined ? parseStrictIsoTimestamp(reset) : nowMs + durationMs;
	return resolved !== undefined && Number.isFinite(new Date(resolved).getTime()) && resolved > nowMs
		? resolved
		: undefined;
}

function cooldownFor(rule: OutcomeRule, stderr: string, nowMs: number): CooldownClassification | undefined {
	if (!rule.cooldown) {
		return undefined;
	}
	if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) {
		throw new ClassificationInputError("INVALID_NOW", "nowMs must resolve to a valid epoch-millisecond instant");
	}
	const capturedReset = rule.cooldown.resetTimeCapture
		? parseCapturedReset(rule.cooldown.resetTimeCapture, stderr, nowMs)
		: undefined;
	const resumeAfter = capturedReset ?? nowMs + rule.cooldown.defaultSeconds * 1000;
	const resumeAfterDate = new Date(resumeAfter);
	if (!Number.isFinite(resumeAfterDate.getTime())) {
		throw new ClassificationInputError("INVALID_NOW", "nowMs cannot be resolved to a valid cooldown timestamp");
	}
	return {
		defaultSeconds: rule.cooldown.defaultSeconds,
		resumeAfter: resumeAfterDate.toISOString(),
		resetTimeCaptured: capturedReset !== undefined,
	};
}

function validateTerminalInput(input: ClassificationInput): void {
	if (
		input.exitCode !== null &&
		(typeof input.exitCode !== "number" ||
			!Number.isFinite(input.exitCode) ||
			!Number.isInteger(input.exitCode) ||
			input.exitCode < 0)
	) {
		throw new ClassificationInputError("INVALID_EXIT_CODE", "exitCode must be null or a finite nonnegative integer");
	}
	if (input.signal !== null && (typeof input.signal !== "string" || input.signal.length === 0)) {
		throw new ClassificationInputError("INVALID_SIGNAL", "signal must be null or a non-empty string");
	}
	if (input.exitCode !== null && input.signal !== null) {
		throw new ClassificationInputError("INVALID_TERMINAL_TUPLE", "exitCode and signal cannot both be non-null");
	}
}

/**
 * Deterministic priority ladder: supervisor fact > evidence > CLI rule >
 * conservative fallback. This function never infers timeout/stall/kill.
 */
export function classifyRunOutcome(input: ClassificationInput): ClassificationResult {
	validateTerminalInput(input);
	if (input.supervisorOutcome !== undefined) {
		return { outcome: input.supervisorOutcome, source: "supervisor" };
	}

	const evidenceVerdict = evaluateDeliveryEvidence(input.exitCode, input.evidence);
	if (evidenceVerdict === "AGENT_BLOCKED") {
		return { outcome: "AGENT_BLOCKED", source: "evidence" };
	}
	if (evidenceVerdict === "COMPLETED" && input.signal === null) {
		return { outcome: "COMPLETED", source: "evidence" };
	}

	if (input.signal !== null) {
		throw new ClassificationInputError(
			"UNREPRESENTABLE_TERMINATION",
			"a non-attested signal-only termination is not representable by the current Run outcome schema",
		);
	}
	if (input.exitCode === null) {
		throw new ClassificationInputError(
			"UNATTESTED_TERMINATION",
			"a null exit and null signal require a supervisor-attested outcome",
		);
	}

	const family = ruleFamily(input.cliName);
	const families: readonly RuleFamily[] = family === "generic" ? ["generic"] : [family, "generic"];
	for (const candidateFamily of families) {
		const rules: readonly OutcomeRule[] = OUTCOME_RULES[candidateFamily];
		for (const [index, rule] of rules.entries()) {
			if (!matchesRule(rule, input)) {
				continue;
			}
			return {
				outcome: rule.outcome,
				source: "rule",
				matchedRule: { family: candidateFamily, index },
				...(rule.cooldown ? { cooldown: cooldownFor(rule, input.stderrTail, input.nowMs) } : {}),
			};
		}
	}
	if (input.exitCode !== 0) {
		return { outcome: "AGENT_ERROR", source: "fallback" };
	}
	return { outcome: "EXITED_NO_EVIDENCE", source: "fallback" };
}
