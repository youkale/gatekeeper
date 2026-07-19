import type { JournalEvent, OrderState, StateTransitionEvent, WorkOrderStatus } from "./types.js";

export class DispatchTransitionError extends Error {
	readonly code = "INVALID_TRANSITION" as const;
	readonly from: WorkOrderStatus | null;
	readonly to: WorkOrderStatus;
	readonly eventType: JournalEvent["type"];

	constructor(from: WorkOrderStatus | null, to: WorkOrderStatus, eventType: JournalEvent["type"], reason: string) {
		super(`${eventType}: ${reason} (${from ?? "UNINITIALIZED"} -> ${to})`);
		this.name = "DispatchTransitionError";
		this.from = from;
		this.to = to;
		this.eventType = eventType;
	}
}

type TransitionKey = `${WorkOrderStatus}->${WorkOrderStatus}`;

const transitionTable: Readonly<Record<StateTransitionEvent["type"], ReadonlySet<TransitionKey>>> = {
	RUN_STARTED: new Set(["PENDING->RUNNING"]),
	RUN_RETRY_SCHEDULED: new Set(["RUNNING->RUNNING"]),
	COOLDOWN_STARTED: new Set(["RUNNING->WAITING_COOLDOWN"]),
	ATTENTION_REQUIRED: new Set(["RUNNING->NEEDS_ATTENTION"]),
	ORDER_DELIVERED: new Set(["RUNNING->DELIVERED"]),
	ORDER_CANCELLED: new Set(["RUNNING->ABANDONED", "WAITING_COOLDOWN->ABANDONED", "NEEDS_ATTENTION->ABANDONED"]),
	ORDER_RESUMED: new Set(["WAITING_COOLDOWN->RUNNING", "NEEDS_ATTENTION->RUNNING"]),
};

/** Table-driven enforcement of exactly the §2 WorkOrder graph. */
export function assertTransition(from: WorkOrderStatus, to: WorkOrderStatus, event: StateTransitionEvent): void {
	const key: TransitionKey = `${from}->${to}`;
	if (!transitionTable[event.type].has(key) || event.from !== from || event.to !== to) {
		throw new DispatchTransitionError(from, to, event.type, "transition is not allowed by the dispatch state graph");
	}
}

/**
 * Rebuild the current state from the complete append-only journal. Audit
 * events such as LOCK_TAKEN_OVER deliberately leave state unchanged.
 */
export function foldJournal(events: readonly JournalEvent[]): OrderState {
	const first = events[0];
	if (first?.type !== "ORDER_CREATED") {
		throw new DispatchTransitionError(
			null,
			"PENDING",
			first?.type ?? "ORDER_CREATED",
			"journal must begin with ORDER_CREATED",
		);
	}

	let state: WorkOrderStatus = "PENDING";
	for (let index = 1; index < events.length; index += 1) {
		const event = events[index];
		if (!event) {
			continue;
		}
		if (event.order_id !== first.order_id) {
			throw new DispatchTransitionError(state, state, event.type, "event order_id does not match journal order");
		}
		if (event.type === "LOCK_TAKEN_OVER") {
			continue;
		}
		if (event.type === "ORDER_CREATED") {
			throw new DispatchTransitionError(
				state,
				"PENDING",
				event.type,
				"ORDER_CREATED may only appear as the first event",
			);
		}
		assertTransition(state, event.to, event);
		state = event.to;
	}
	return state;
}
