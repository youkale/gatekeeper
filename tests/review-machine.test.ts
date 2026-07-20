import { describe, expect, it } from "vitest";

import {
	assertTransition,
	effectiveMaxRounds,
	extendRoundLimit,
	foldJournal,
	ReviewTransitionError,
	roundConclusionTarget,
} from "../src/review/machine.js";
import {
	journalEventSchema,
	REVIEW_CYCLE_STATUSES,
	type ReviewCycleStatus,
	type ReviewJournalEvent,
	type ReviewStateEvent,
} from "../src/review/types.js";

const CYCLE_ID = "rc-20260721t010203000z-abcdef123456";
const AT = "2026-07-21T01:02:03.000Z";

function base(type: ReviewJournalEvent["type"]) {
	return { apiVersion: "gatekeeper/v1" as const, type, cycle_id: CYCLE_ID, at: AT };
}

const eventCases: Array<{
	name: string;
	event: ReviewStateEvent;
	allowed: ReadonlySet<string>;
}> = [
	{
		name: "initial round",
		event: { ...base("ROUND_STARTED"), type: "ROUND_STARTED", round: 1, from: "PENDING", to: "REVIEWING" },
		allowed: new Set(["PENDING->REVIEWING"]),
	},
	{
		name: "post-fix round",
		event: { ...base("ROUND_STARTED"), type: "ROUND_STARTED", round: 2, from: "FIXING", to: "REVIEWING" },
		allowed: new Set(["FIXING->REVIEWING"]),
	},
	{
		name: "extended round",
		event: {
			...base("ROUND_STARTED"),
			type: "ROUND_STARTED",
			round: 2,
			from: "ARBITRATION",
			to: "REVIEWING",
			previous_max_rounds: 3,
			max_rounds: 4,
			extension_reason: "one additional review round",
		},
		allowed: new Set(["ARBITRATION->REVIEWING"]),
	},
	{
		name: "lane audit",
		event: {
			...base("LANE_CONCLUDED"),
			type: "LANE_CONCLUDED",
			round: 1,
			lane_id: "L1-codex",
			outcome: "PASS",
		},
		allowed: new Set(["REVIEWING->REVIEWING"]),
	},
	{
		name: "cooldown",
		event: {
			...base("COOLDOWN_STARTED"),
			type: "COOLDOWN_STARTED",
			round: 1,
			lane_id: "L1-codex",
			resume_after: "2026-07-21T01:03:03.000Z",
			from: "REVIEWING",
			to: "WAITING_COOLDOWN",
		},
		allowed: new Set(["REVIEWING->WAITING_COOLDOWN"]),
	},
	{
		name: "resume",
		event: {
			...base("CYCLE_RESUMED"),
			type: "CYCLE_RESUMED",
			round: 1,
			from: "WAITING_COOLDOWN",
			to: "REVIEWING",
		},
		allowed: new Set(["WAITING_COOLDOWN->REVIEWING"]),
	},
	{
		name: "pass conclusion",
		event: {
			...base("ROUND_CONCLUDED"),
			type: "ROUND_CONCLUDED",
			round: 1,
			verdict: "PASS",
			from: "REVIEWING",
			to: "AWAITING_ACCEPT",
		},
		allowed: new Set(["REVIEWING->AWAITING_ACCEPT"]),
	},
	{
		name: "blocked conclusion",
		event: {
			...base("ROUND_CONCLUDED"),
			type: "ROUND_CONCLUDED",
			round: 1,
			verdict: "FAIL",
			from: "REVIEWING",
			to: "BLOCKED",
		},
		allowed: new Set(["REVIEWING->BLOCKED"]),
	},
	{
		name: "arbitration conclusion",
		event: {
			...base("ROUND_CONCLUDED"),
			type: "ROUND_CONCLUDED",
			round: 3,
			verdict: "FAIL",
			from: "REVIEWING",
			to: "ARBITRATION",
		},
		allowed: new Set(["REVIEWING->ARBITRATION"]),
	},
	{
		name: "waiver audit",
		event: {
			...base("BLOCKER_WAIVED"),
			type: "BLOCKER_WAIVED",
			round: 1,
			blocker_id: "B-1",
			operator: "human",
			reason: "accepted risk",
		},
		allowed: new Set(["BLOCKED->BLOCKED"]),
	},
	...(["BLOCKED", "AWAITING_ACCEPT"] as const).map((from) => ({
		name: `fix from ${from}`,
		event: {
			...base("FIX_DISPATCHED"),
			type: "FIX_DISPATCHED" as const,
			round: 1,
			fix_order_id: "wo-fix-cycle-r1",
			from,
			to: "FIXING" as const,
		},
		allowed: new Set([`${from}->FIXING`]),
	})),
	{
		name: "fix failure",
		event: {
			...base("FIX_FAILED"),
			type: "FIX_FAILED",
			round: 1,
			fix_order_id: "wo-fix-cycle-r1",
			reason: "dispatch did not deliver",
			from: "FIXING",
			to: "BLOCKED",
		},
		allowed: new Set(["FIXING->BLOCKED"]),
	},
	...(["AWAITING_ACCEPT", "ARBITRATION"] as const).map((from) => ({
		name: `accept from ${from}`,
		event: {
			...base("CYCLE_ACCEPTED"),
			type: "CYCLE_ACCEPTED" as const,
			operator: "human",
			from,
			to: "ACCEPTED" as const,
		},
		allowed: new Set([`${from}->ACCEPTED`]),
	})),
	...(["REVIEWING", "WAITING_COOLDOWN", "BLOCKED", "FIXING", "AWAITING_ACCEPT", "ARBITRATION"] as const).map(
		(from) => ({
			name: `cancel from ${from}`,
			event: {
				...base("CYCLE_CANCELLED"),
				type: "CYCLE_CANCELLED" as const,
				operator: "human",
				reason: "stop review",
				from,
				to: "ABANDONED" as const,
			},
			allowed: new Set([`${from}->ABANDONED`]),
		}),
	),
	{
		name: "lock takeover audit",
		event: {
			...base("LOCK_TAKEN_OVER"),
			type: "LOCK_TAKEN_OVER",
			previous_pid: 111,
			previous_started_at: "2026-07-21T00:00:00.000Z",
			new_pid: 222,
		},
		allowed: new Set(REVIEW_CYCLE_STATUSES.map((status) => `${status}->${status}`)),
	},
];

describe("review assertTransition", () => {
	it.each(eventCases)("rejects every undesigned nine-state pair for $name", ({ event, allowed }) => {
		for (const from of REVIEW_CYCLE_STATUSES) {
			for (const to of REVIEW_CYCLE_STATUSES) {
				const key = `${from}->${to}`;
				if (allowed.has(key)) {
					expect(() => assertTransition(from, to, event)).not.toThrow();
				} else {
					expect(() => assertTransition(from, to, event)).toThrow(ReviewTransitionError);
				}
			}
		}
	});
});

describe("review journal schema", () => {
	it("strictly rejects unknown fields and any extension other than exactly +1", () => {
		const extend = eventCases.find((item) => item.name === "extended round")?.event;
		expect(extend).toBeDefined();
		expect(journalEventSchema.safeParse(extend).success).toBe(true);
		expect(journalEventSchema.safeParse({ ...extend, max_rounds: 5 }).success).toBe(false);
		expect(journalEventSchema.safeParse({ ...extend, unknown: true }).success).toBe(false);
		expect(
			journalEventSchema.safeParse({
				...extend,
				from: "FIXING",
				previous_max_rounds: 3,
				max_rounds: 4,
			}).success,
		).toBe(false);
	});
});

describe("review foldJournal", () => {
	const events: ReviewJournalEvent[] = [
		{ ...base("CYCLE_CREATED"), type: "CYCLE_CREATED", to: "PENDING" },
		{ ...base("ROUND_STARTED"), type: "ROUND_STARTED", round: 1, from: "PENDING", to: "REVIEWING" },
		{
			...base("LANE_CONCLUDED"),
			type: "LANE_CONCLUDED",
			round: 1,
			lane_id: "L1-codex",
			outcome: "FAIL",
		},
		{
			...base("COOLDOWN_STARTED"),
			type: "COOLDOWN_STARTED",
			round: 1,
			lane_id: "L2-claude",
			resume_after: "2026-07-21T01:03:03.000Z",
			from: "REVIEWING",
			to: "WAITING_COOLDOWN",
		},
		{
			...base("CYCLE_RESUMED"),
			type: "CYCLE_RESUMED",
			round: 1,
			from: "WAITING_COOLDOWN",
			to: "REVIEWING",
		},
		{
			...base("ROUND_CONCLUDED"),
			type: "ROUND_CONCLUDED",
			round: 1,
			verdict: "FAIL",
			from: "REVIEWING",
			to: "BLOCKED",
		},
		{
			...base("BLOCKER_WAIVED"),
			type: "BLOCKER_WAIVED",
			round: 1,
			blocker_id: "B-1",
			operator: "human",
			reason: "accepted risk",
		},
		{
			...base("FIX_DISPATCHED"),
			type: "FIX_DISPATCHED",
			round: 1,
			fix_order_id: "wo-fix-cycle-r1",
			from: "BLOCKED",
			to: "FIXING",
		},
		{ ...base("ROUND_STARTED"), type: "ROUND_STARTED", round: 2, from: "FIXING", to: "REVIEWING" },
		{
			...base("ROUND_CONCLUDED"),
			type: "ROUND_CONCLUDED",
			round: 2,
			verdict: "FAIL",
			from: "REVIEWING",
			to: "BLOCKED",
		},
		{
			...base("FIX_DISPATCHED"),
			type: "FIX_DISPATCHED",
			round: 2,
			fix_order_id: "wo-fix-cycle-r2",
			from: "BLOCKED",
			to: "FIXING",
		},
		{ ...base("ROUND_STARTED"), type: "ROUND_STARTED", round: 3, from: "FIXING", to: "REVIEWING" },
		{
			...base("ROUND_CONCLUDED"),
			type: "ROUND_CONCLUDED",
			round: 3,
			verdict: "FAIL",
			from: "REVIEWING",
			to: "ARBITRATION",
		},
		{
			...base("LOCK_TAKEN_OVER"),
			type: "LOCK_TAKEN_OVER",
			previous_pid: 111,
			previous_started_at: "2026-07-21T00:00:00.000Z",
			new_pid: 222,
		},
		{
			...base("ROUND_STARTED"),
			type: "ROUND_STARTED",
			round: 4,
			from: "ARBITRATION",
			to: "REVIEWING",
			previous_max_rounds: 3,
			max_rounds: 4,
			extension_reason: "one more round",
		},
		{
			...base("ROUND_CONCLUDED"),
			type: "ROUND_CONCLUDED",
			round: 4,
			verdict: "PASS",
			from: "REVIEWING",
			to: "AWAITING_ACCEPT",
		},
		{
			...base("CYCLE_ACCEPTED"),
			type: "CYCLE_ACCEPTED",
			operator: "human",
			from: "AWAITING_ACCEPT",
			to: "ACCEPTED",
		},
	];

	it("replays every arbitrary prefix consistently", () => {
		for (let length = 1; length <= events.length; length += 1) {
			const prefix = events.slice(0, length);
			expect(foldJournal(prefix, 3)).toBe(foldJournal(prefix, 3));
		}
		expect(foldJournal(events, 3)).toBe("ACCEPTED");
		expect(effectiveMaxRounds(3, events)).toBe(4);
	});

	it("rejects empty/duplicate/foreign histories and non-sequential rounds", () => {
		expect(() => foldJournal([], 3)).toThrow(ReviewTransitionError);
		expect(() => foldJournal([events[0] as ReviewJournalEvent, events[0] as ReviewJournalEvent], 3)).toThrow(
			ReviewTransitionError,
		);
		expect(() =>
			foldJournal(
				[events[0] as ReviewJournalEvent, { ...(events[1] as ReviewJournalEvent), cycle_id: "rc-foreign" }],
				3,
			),
		).toThrow(ReviewTransitionError);
		expect(() =>
			foldJournal(
				[events[0] as ReviewJournalEvent, { ...(events[1] as ReviewJournalEvent), round: 2 } as ReviewJournalEvent],
				3,
			),
		).toThrow(ReviewTransitionError);
	});

	it("forces a full round into arbitration and permits only a single +1 extension", () => {
		expect(roundConclusionTarget("FAIL", 2, 3)).toBe("BLOCKED");
		expect(roundConclusionTarget("FAIL", 3, 3)).toBe("ARBITRATION");
		expect(roundConclusionTarget("UNAVAILABLE", 1, 3)).toBe("ARBITRATION");
		expect(extendRoundLimit(3)).toBe(4);

		const wrongAtLimit = events
			.slice(0, 13)
			.map((event) =>
				event.type === "ROUND_CONCLUDED" && event.round === 3 ? { ...event, to: "BLOCKED" as const } : event,
			);
		expect(() => foldJournal(wrongAtLimit, 3)).toThrow(/requires target ARBITRATION/);
		const plusTwo = events.map((event) =>
			event.type === "ROUND_STARTED" && event.from === "ARBITRATION" ? { ...event, max_rounds: 5 } : event,
		);
		expect(() => foldJournal(plusTwo, 3)).toThrow(/exactly one/);
	});

	it("allows early arbitration extension to raise 3 to 4 while the next round is R2", () => {
		const early: ReviewJournalEvent[] = [
			{ ...base("CYCLE_CREATED"), type: "CYCLE_CREATED", to: "PENDING" },
			{ ...base("ROUND_STARTED"), type: "ROUND_STARTED", round: 1, from: "PENDING", to: "REVIEWING" },
			{
				...base("ROUND_CONCLUDED"),
				type: "ROUND_CONCLUDED",
				round: 1,
				verdict: "UNAVAILABLE",
				from: "REVIEWING",
				to: "ARBITRATION",
			},
			{
				...base("ROUND_STARTED"),
				type: "ROUND_STARTED",
				round: 2,
				from: "ARBITRATION",
				to: "REVIEWING",
				previous_max_rounds: 3,
				max_rounds: 4,
				extension_reason: "replace unavailable route",
			},
		];
		expect(foldJournal(early, 3)).toBe("REVIEWING");
	});

	it("returns the exhaustive status type", () => {
		const state: ReviewCycleStatus = foldJournal(events.slice(0, 1), 3);
		expect(state).toBe("PENDING");
	});
});
