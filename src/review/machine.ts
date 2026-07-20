import type { ReviewCycleState, ReviewCycleStatus, ReviewJournalEvent, ReviewStateEvent } from "./types.js";

export class ReviewTransitionError extends Error {
	readonly code = "INVALID_TRANSITION" as const;
	readonly from: ReviewCycleStatus | null;
	readonly to: ReviewCycleStatus;
	readonly eventType: ReviewJournalEvent["type"];

	constructor(
		from: ReviewCycleStatus | null,
		to: ReviewCycleStatus,
		eventType: ReviewJournalEvent["type"],
		reason: string,
	) {
		super(`${eventType}: ${reason} (${from ?? "UNINITIALIZED"} -> ${to})`);
		this.name = "ReviewTransitionError";
		this.from = from;
		this.to = to;
		this.eventType = eventType;
	}
}

type TransitionKey = `${ReviewCycleStatus}->${ReviewCycleStatus}`;

const allAuditSelfLoops = [
	"PENDING->PENDING",
	"REVIEWING->REVIEWING",
	"WAITING_COOLDOWN->WAITING_COOLDOWN",
	"BLOCKED->BLOCKED",
	"FIXING->FIXING",
	"AWAITING_ACCEPT->AWAITING_ACCEPT",
	"ARBITRATION->ARBITRATION",
	"ACCEPTED->ACCEPTED",
	"ABANDONED->ABANDONED",
] as const satisfies readonly TransitionKey[];

/** Independent review graph. Dispatch's edge table is intentionally not generalized or shared. */
const transitionTable: Readonly<Record<ReviewStateEvent["type"], ReadonlySet<TransitionKey>>> = {
	ROUND_STARTED: new Set(["PENDING->REVIEWING", "FIXING->REVIEWING", "ARBITRATION->REVIEWING"]),
	LANE_CONCLUDED: new Set(["REVIEWING->REVIEWING"]),
	COOLDOWN_STARTED: new Set(["REVIEWING->WAITING_COOLDOWN"]),
	CYCLE_RESUMED: new Set(["WAITING_COOLDOWN->REVIEWING"]),
	ROUND_CONCLUDED: new Set(["REVIEWING->AWAITING_ACCEPT", "REVIEWING->BLOCKED", "REVIEWING->ARBITRATION"]),
	BLOCKER_WAIVED: new Set(["BLOCKED->BLOCKED"]),
	FIX_DISPATCHED: new Set(["BLOCKED->FIXING", "AWAITING_ACCEPT->FIXING"]),
	FIX_FAILED: new Set(["FIXING->BLOCKED"]),
	CYCLE_ACCEPTED: new Set(["AWAITING_ACCEPT->ACCEPTED", "ARBITRATION->ACCEPTED"]),
	CYCLE_CANCELLED: new Set([
		"REVIEWING->ABANDONED",
		"WAITING_COOLDOWN->ABANDONED",
		"BLOCKED->ABANDONED",
		"FIXING->ABANDONED",
		"AWAITING_ACCEPT->ABANDONED",
		"ARBITRATION->ABANDONED",
	]),
	LOCK_TAKEN_OVER: new Set(allAuditSelfLoops),
};

function eventTransition(event: ReviewStateEvent): { from: ReviewCycleStatus; to: ReviewCycleStatus } | undefined {
	if ("from" in event && "to" in event) {
		return { from: event.from, to: event.to };
	}
	return undefined;
}

/** Table-driven enforcement of exactly the review design §3 graph, including audit-only self-loops. */
export function assertTransition(from: ReviewCycleStatus, to: ReviewCycleStatus, event: ReviewStateEvent): void {
	const key: TransitionKey = `${from}->${to}`;
	const declared = eventTransition(event);
	if (
		!transitionTable[event.type].has(key) ||
		(declared !== undefined && (declared.from !== from || declared.to !== to))
	) {
		throw new ReviewTransitionError(from, to, event.type, "transition is not allowed by the review state graph");
	}
}

function requirePositiveInteger(value: number, label: string): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new RangeError(`${label} must be a positive integer`);
	}
}

/**
 * Decide a concluded round's mandatory target. FAIL is BLOCKED only while a
 * further round remains; reaching the effective limit, or failing to form a
 * required route (UNAVAILABLE), is always ARBITRATION.
 */
export function roundConclusionTarget(
	verdict: "PASS" | "FAIL" | "UNAVAILABLE",
	round: number,
	maxRounds: number,
): "AWAITING_ACCEPT" | "BLOCKED" | "ARBITRATION" {
	requirePositiveInteger(round, "round");
	requirePositiveInteger(maxRounds, "maxRounds");
	if (verdict === "PASS") {
		return "AWAITING_ACCEPT";
	}
	if (verdict === "UNAVAILABLE" || round >= maxRounds) {
		return "ARBITRATION";
	}
	return "BLOCKED";
}

/** The sole arithmetic primitive for an arbitration extension: exactly one additional round. */
export function extendRoundLimit(currentMaxRounds: number): number {
	requirePositiveInteger(currentMaxRounds, "currentMaxRounds");
	if (currentMaxRounds === Number.MAX_SAFE_INTEGER) {
		throw new RangeError("currentMaxRounds cannot be extended safely");
	}
	return currentMaxRounds + 1;
}

function eventRound(event: ReviewStateEvent): number | undefined {
	return "round" in event ? event.round : undefined;
}

/** Fold only the durable extension records over cycle.yaml's frozen initial limit. */
export function effectiveMaxRounds(initialMaxRounds: number, events: readonly ReviewJournalEvent[]): number {
	requirePositiveInteger(initialMaxRounds, "initialMaxRounds");
	let effective = initialMaxRounds;
	for (const event of events) {
		if (event.type !== "ROUND_STARTED" || event.from !== "ARBITRATION") {
			continue;
		}
		if (event.previous_max_rounds !== effective || event.max_rounds !== extendRoundLimit(effective)) {
			throw new ReviewTransitionError(
				"ARBITRATION",
				"REVIEWING",
				event.type,
				"extension does not advance the effective max_rounds by exactly one",
			);
		}
		effective = event.max_rounds;
	}
	return effective;
}

/**
 * Rebuild current state from the complete append-only journal. The frozen
 * cycle limit is required so replay, append validation, and crash recovery
 * all make the same forced-ARBITRATION decision.
 */
export function foldJournal(events: readonly ReviewJournalEvent[], initialMaxRounds: number): ReviewCycleState {
	requirePositiveInteger(initialMaxRounds, "initialMaxRounds");
	const first = events[0];
	if (first?.type !== "CYCLE_CREATED") {
		throw new ReviewTransitionError(
			null,
			"PENDING",
			first?.type ?? "CYCLE_CREATED",
			"journal must begin with CYCLE_CREATED",
		);
	}

	let state: ReviewCycleStatus = "PENDING";
	let currentRound = 0;
	let maxRounds = initialMaxRounds;
	for (let index = 1; index < events.length; index += 1) {
		const event = events[index];
		if (!event) {
			continue;
		}
		if (event.cycle_id !== first.cycle_id) {
			throw new ReviewTransitionError(state, state, event.type, "event cycle_id does not match journal cycle");
		}
		if (event.type === "CYCLE_CREATED") {
			throw new ReviewTransitionError(state, "PENDING", event.type, "CYCLE_CREATED may only appear as the first event");
		}

		if (event.type === "ROUND_STARTED") {
			const expectedRound = currentRound + 1;
			if (event.round !== expectedRound) {
				throw new ReviewTransitionError(state, event.to, event.type, `round must equal ${expectedRound}`);
			}
			if (event.from === "ARBITRATION") {
				if (event.previous_max_rounds !== maxRounds || event.max_rounds !== extendRoundLimit(maxRounds)) {
					throw new ReviewTransitionError(
						state,
						event.to,
						event.type,
						"extension does not advance the effective max_rounds by exactly one",
					);
				}
				maxRounds = event.max_rounds;
			}
			assertTransition(state, event.to, event);
			state = event.to;
			currentRound = event.round;
			continue;
		}

		const round = eventRound(event);
		if (round !== undefined && round !== currentRound) {
			throw new ReviewTransitionError(state, state, event.type, `event round does not match active R${currentRound}`);
		}

		if (event.type === "LANE_CONCLUDED" || event.type === "BLOCKER_WAIVED" || event.type === "LOCK_TAKEN_OVER") {
			assertTransition(state, state, event);
			continue;
		}

		if (event.type === "ROUND_CONCLUDED") {
			const target = roundConclusionTarget(event.verdict, event.round, maxRounds);
			if (event.to !== target) {
				throw new ReviewTransitionError(
					state,
					event.to,
					event.type,
					`round verdict requires target ${target} at max_rounds ${maxRounds}`,
				);
			}
		}

		assertTransition(state, event.to, event);
		state = event.to;
	}
	return state;
}
