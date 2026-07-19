import { describe, expect, it } from "vitest";

import { assertTransition, DispatchTransitionError, foldJournal } from "../src/dispatch/machine.js";
import {
	type JournalEvent,
	journalEventSchema,
	type StateTransitionEvent,
	WORK_ORDER_STATUSES,
	type WorkOrderStatus,
} from "../src/dispatch/types.js";

const ORDER_ID = "wo-20260720t010203000z-abcdef";
const AT = "2026-07-20T01:02:03.000Z";

function base(type: JournalEvent["type"]) {
	return { apiVersion: "gatekeeper/v1" as const, type, order_id: ORDER_ID, at: AT };
}

const transitionCases: Array<{
	name: string;
	event: StateTransitionEvent;
	allowed: ReadonlySet<string>;
}> = [
	{
		name: "start",
		event: { ...base("RUN_STARTED"), type: "RUN_STARTED", run_id: "r001", from: "PENDING", to: "RUNNING" },
		allowed: new Set(["PENDING->RUNNING"]),
	},
	{
		name: "retry",
		event: {
			...base("RUN_RETRY_SCHEDULED"),
			type: "RUN_RETRY_SCHEDULED",
			previous_run_id: "r001",
			next_run_id: "r002",
			outcome: "TIMEOUT",
			from: "RUNNING",
			to: "RUNNING",
		},
		allowed: new Set(["RUNNING->RUNNING"]),
	},
	{
		name: "cooldown",
		event: {
			...base("COOLDOWN_STARTED"),
			type: "COOLDOWN_STARTED",
			run_id: "r001",
			outcome: "RATE_LIMITED",
			resume_after: "2026-07-20T02:02:03.000Z",
			from: "RUNNING",
			to: "WAITING_COOLDOWN",
		},
		allowed: new Set(["RUNNING->WAITING_COOLDOWN"]),
	},
	{
		name: "attention",
		event: {
			...base("ATTENTION_REQUIRED"),
			type: "ATTENTION_REQUIRED",
			run_id: "r001",
			outcome: "AGENT_BLOCKED",
			reason: "missing credentials",
			from: "RUNNING",
			to: "NEEDS_ATTENTION",
		},
		allowed: new Set(["RUNNING->NEEDS_ATTENTION"]),
	},
	{
		name: "delivery",
		event: {
			...base("ORDER_DELIVERED"),
			type: "ORDER_DELIVERED",
			run_id: "r001",
			outcome: "COMPLETED",
			from: "RUNNING",
			to: "DELIVERED",
		},
		allowed: new Set(["RUNNING->DELIVERED"]),
	},
	...(["RUNNING", "WAITING_COOLDOWN", "NEEDS_ATTENTION"] as const).map((from) => ({
		name: `cancel from ${from}`,
		event: {
			...base("ORDER_CANCELLED"),
			type: "ORDER_CANCELLED" as const,
			from,
			to: "ABANDONED" as const,
			...(from === "RUNNING" ? { run_id: "r001" as const, outcome: "KILLED" as const } : {}),
		},
		allowed: new Set([`${from}->ABANDONED`]),
	})),
	...(["WAITING_COOLDOWN", "NEEDS_ATTENTION"] as const).map((from) => ({
		name: `resume from ${from}`,
		event: {
			...base("ORDER_RESUMED"),
			type: "ORDER_RESUMED" as const,
			new_run_id: "r002",
			from,
			to: "RUNNING" as const,
			forced: false,
		},
		allowed: new Set([`${from}->RUNNING`]),
	})),
];

describe("assertTransition", () => {
	it.each(transitionCases)(
		"accepts only the designed edge for $name and rejects every other status pair",
		({ event, allowed }) => {
			for (const from of WORK_ORDER_STATUSES) {
				for (const to of WORK_ORDER_STATUSES) {
					const key = `${from}->${to}`;
					if (allowed.has(key)) {
						expect(() => assertTransition(from, to, event)).not.toThrow();
					} else {
						expect(() => assertTransition(from, to, event)).toThrow(DispatchTransitionError);
					}
				}
			}
		},
	);
});

describe("journal event schema", () => {
	it("ties cancellation payload to the source state", () => {
		const running = {
			...base("ORDER_CANCELLED"),
			type: "ORDER_CANCELLED" as const,
			from: "RUNNING" as const,
			to: "ABANDONED" as const,
		};
		expect(journalEventSchema.safeParse(running).success).toBe(false);
		expect(journalEventSchema.safeParse({ ...running, run_id: "r001", outcome: "KILLED" }).success).toBe(true);

		const waiting = { ...running, from: "WAITING_COOLDOWN" as const };
		expect(journalEventSchema.safeParse(waiting).success).toBe(true);
		expect(journalEventSchema.safeParse({ ...waiting, run_id: "r001", outcome: "KILLED" }).success).toBe(false);
		const attention = { ...running, from: "NEEDS_ATTENTION" as const };
		expect(journalEventSchema.safeParse(attention).success).toBe(true);
		expect(journalEventSchema.safeParse({ ...attention, run_id: "r001", outcome: "KILLED" }).success).toBe(false);
	});

	it("requires retry events to name distinct previous and next runs", () => {
		const retry = {
			...base("RUN_RETRY_SCHEDULED"),
			type: "RUN_RETRY_SCHEDULED" as const,
			previous_run_id: "r001",
			next_run_id: "r002",
			outcome: "TIMEOUT" as const,
			from: "RUNNING" as const,
			to: "RUNNING" as const,
		};
		expect(journalEventSchema.safeParse(retry).success).toBe(true);
		expect(journalEventSchema.safeParse({ ...retry, next_run_id: "r001" }).success).toBe(false);
	});
});

describe("foldJournal", () => {
	const events: JournalEvent[] = [
		{ ...base("ORDER_CREATED"), type: "ORDER_CREATED", to: "PENDING" },
		transitionCases[0]?.event as StateTransitionEvent,
		{
			...base("LOCK_TAKEN_OVER"),
			type: "LOCK_TAKEN_OVER",
			previous_pid: 111,
			previous_started_at: "2026-07-20T00:00:00.000Z",
			new_pid: 222,
		},
		transitionCases[2]?.event as StateTransitionEvent,
		transitionCases[8]?.event as StateTransitionEvent,
		transitionCases[1]?.event as StateTransitionEvent,
		transitionCases[3]?.event as StateTransitionEvent,
		transitionCases[7]?.event as StateTransitionEvent,
	];

	it("is deterministic when every prefix is replayed repeatedly", () => {
		for (let length = 1; length <= events.length; length += 1) {
			const prefix = events.slice(0, length);
			expect(foldJournal(prefix)).toBe(foldJournal(prefix));
		}
		expect(foldJournal(events)).toBe("ABANDONED");
	});

	it("keeps LOCK_TAKEN_OVER audit-only", () => {
		expect(foldJournal(events.slice(0, 2))).toBe("RUNNING");
		expect(foldJournal(events.slice(0, 3))).toBe("RUNNING");
	});

	it("rejects an empty journal, duplicate creation, and mismatched order ids", () => {
		expect(() => foldJournal([])).toThrow(DispatchTransitionError);
		expect(() => foldJournal([events[0] as JournalEvent, events[0] as JournalEvent])).toThrow(DispatchTransitionError);
		const foreign = { ...(events[1] as StateTransitionEvent), order_id: "wo-foreign" };
		expect(() => foldJournal([events[0] as JournalEvent, foreign])).toThrow(DispatchTransitionError);
	});

	it("returns a WorkOrderStatus value", () => {
		const state: WorkOrderStatus = foldJournal(events.slice(0, 1));
		expect(state).toBe("PENDING");
	});
});
