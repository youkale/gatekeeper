/**
 * Pure, deterministic aggregation of per-lane VERDICT.json blockers into one
 * cross-lane list for a review round (tasks/records/T-20260721-02-review-design.md
 * §4/§6, dispatch table row D). No I/O, no model calls, no clock/random use --
 * every input (lane verdicts, prior-round ids, waiver ids) is supplied by the
 * caller. This module owns exactly three jobs:
 *
 * 1. `aggregateBlockers` collapses blockers that different reviewer lanes
 *    independently flagged for the same (file, line, title) into one entry
 *    carrying every lane's endorsement (cross-lane agreement is the
 *    highest-confidence signal, so multi-endorsed entries sort first), and
 *    mints a stable id in src/review/verdict.ts's `blockerReferenceSchema`
 *    format (`B-r<round>-L<lane>-<seq>`) -- same input (any lane order)
 *    always produces the same output.
 * 2. `resolveRefs` checks an incremental round's `ref` field against the
 *    *previous* round's minted ids. B package's zod schema only validates
 *    `ref`'s *syntax*; this module is where its *existence* is checked
 *    (T-20260721-02-review-design.md §4 explicitly draws this line).
 * 3. `applyWaivers` removes operator-waived blockers, rejecting unknown ids
 *    structurally (never silently ignored) so a typo in a waive command
 *    cannot make a real blocker vanish unnoticed.
 */

import type { ReviewVerdict } from "./verdict.js";

type VerdictBlockerCategory = ReviewVerdict["blockers"][number]["category"];

/** One reviewer lane's already-validated VERDICT.json, keyed by its lane id (e.g. `L1-codex`). */
export interface LaneVerdict {
	laneId: string;
	verdict: ReviewVerdict;
}

export interface AggregatedBlocker {
	/** Stable `B-r<round>-L<lane>-<seq>` id, minted deterministically from this call's input. */
	id: string;
	file: string;
	line?: number;
	title: string;
	evidence: string;
	suggested_fix?: string;
	category?: VerdictBlockerCategory;
	/**
	 * The representative reporting lane's `ref` (a prior-round blocker id this lane claims is the same issue),
	 * carried through unresolved -- `resolveRefs` is the module-level function that checks whether it actually
	 * exists among the prior round's ids.
	 */
	ref?: string;
	/**
	 * Every lane that independently reported this exact (file, line, title), sorted ascending by lane number.
	 * `endorsements[0]` is always the first-reporting (lowest lane number) lane and is the lane encoded in
	 * `id`'s `L` segment. More than one entry is the cross-lane "high confidence" signal that sorts this
	 * blocker to the top of `aggregateBlockers`' output.
	 */
	endorsements: string[];
}

export type ReviewAggregateErrorCode =
	| "INVALID_LANE_ID"
	| "DUPLICATE_LANE_ID"
	| "MIXED_ROUNDS"
	| "TOO_MANY_BLOCKERS"
	| "UNKNOWN_WAIVER_ID";

/** A programmer/input-contract error, never silently swallowed -- mirrors src/dispatch/classify.ts's ClassificationInputError. */
export class ReviewAggregateError extends Error {
	readonly code: ReviewAggregateErrorCode;
	readonly ids?: string[];

	constructor(code: ReviewAggregateErrorCode, message: string, ids?: string[]) {
		super(message);
		this.name = "ReviewAggregateError";
		this.code = code;
		if (ids !== undefined) {
			this.ids = ids;
		}
	}
}

/**
 * Extracts the numeric lane ordinal from `L<number>-<cli>` (src/review/types.ts's laneIdSchema shape). The
 * `[1-9]\d*` segment deliberately matches laneIdSchema's own pattern exactly (no leading zero, no `L0-*`) --
 * this module.header's promise that every minted id satisfies src/review/verdict.ts's blockerReferenceSchema
 * (whose `L` segment uses the same `[1-9]\d*` rule) depends on never accepting a lane number that schema would
 * reject. `L0-codex` and `L01-codex` both fall through to INVALID_LANE_ID rather than silently minting an
 * unparseable id.
 */
function laneNumber(laneId: string): number {
	const match = /^L([1-9]\d*)-/.exec(laneId);
	if (!match?.[1]) {
		throw new ReviewAggregateError(
			"INVALID_LANE_ID",
			`lane id ${JSON.stringify(laneId)} does not match L<number>-<cli> (no leading zero, no L0-*)`,
		);
	}
	return Number(match[1]);
}

/** Exact-match dedupe key: (file, line, title) as specified by T-20260721-02-review-design.md §6. */
function dedupeKey(file: string, line: number | undefined, title: string): string {
	return JSON.stringify([file, line ?? null, title]);
}

interface BlockerGroup {
	file: string;
	line?: number;
	title: string;
	evidence: string;
	suggested_fix?: string;
	category?: VerdictBlockerCategory;
	ref?: string;
	/** Ascending by lane number (guaranteed by the iteration order in aggregateBlockers), de-duplicated per lane. */
	endorsingLanes: string[];
}

function firstEndorsingLane(group: BlockerGroup): string {
	const lane = group.endorsingLanes[0];
	if (lane === undefined) {
		// Unreachable: a group is only ever created alongside its first push (see aggregateBlockers below).
		throw new ReviewAggregateError("INVALID_LANE_ID", "internal invariant violated: blocker group has no endorsements");
	}
	return lane;
}

/**
 * Merge every lane's blockers into one deduplicated, endorsement-ranked, stably-id'd list. Input lane order does
 * not affect the output: lanes are re-sorted ascending by lane number before any grouping happens, so `endorsements`
 * and the minted `id`'s `L` segment are always anchored to the lowest lane number that reported a given blocker,
 * regardless of the order callers happen to pass lanes in.
 */
export function aggregateBlockers(lanes: readonly LaneVerdict[]): AggregatedBlocker[] {
	const orderedLanes = [...lanes].sort((a, b) => laneNumber(a.laneId) - laneNumber(b.laneId));
	const first = orderedLanes[0];
	if (first === undefined) {
		return [];
	}

	const laneIds = orderedLanes.map((lane) => lane.laneId);
	if (new Set(laneIds).size !== laneIds.length) {
		throw new ReviewAggregateError("DUPLICATE_LANE_ID", "aggregateBlockers requires every lane id to be unique");
	}

	const rounds = new Set(orderedLanes.map((lane) => lane.verdict.round));
	if (rounds.size > 1) {
		throw new ReviewAggregateError(
			"MIXED_ROUNDS",
			`aggregateBlockers requires every lane's verdict to share one round, got ${[...rounds]
				.sort((a, b) => a - b)
				.join(", ")}`,
		);
	}
	const round = first.verdict.round;

	const groups = new Map<string, BlockerGroup>();
	for (const lane of orderedLanes) {
		// A lane cannot endorse itself twice: if one VERDICT.json lists the identical (file, line, title) more than
		// once, cross-lane endorsement counting must still treat that lane as a single vote.
		const seenInThisLane = new Set<string>();
		for (const blocker of lane.verdict.blockers) {
			const key = dedupeKey(blocker.file, blocker.line, blocker.title);
			if (seenInThisLane.has(key)) {
				continue;
			}
			seenInThisLane.add(key);

			let group = groups.get(key);
			if (!group) {
				group = {
					file: blocker.file,
					line: blocker.line,
					title: blocker.title,
					evidence: blocker.evidence,
					suggested_fix: blocker.suggested_fix,
					category: blocker.category,
					ref: blocker.ref,
					endorsingLanes: [],
				};
				groups.set(key, group);
			}
			group.endorsingLanes.push(lane.laneId);
		}
	}

	const ranked = [...groups.values()].sort((a, b) => {
		if (a.endorsingLanes.length !== b.endorsingLanes.length) {
			return b.endorsingLanes.length - a.endorsingLanes.length; // more endorsements sorts first ("置顶")
		}
		const laneDelta = laneNumber(firstEndorsingLane(a)) - laneNumber(firstEndorsingLane(b));
		if (laneDelta !== 0) {
			return laneDelta;
		}
		if (a.file !== b.file) {
			return a.file < b.file ? -1 : 1;
		}
		const aLine = a.line ?? Number.POSITIVE_INFINITY;
		const bLine = b.line ?? Number.POSITIVE_INFINITY;
		if (aLine !== bLine) {
			return aLine - bLine;
		}
		return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
	});

	if (ranked.length > 99) {
		// blockerReferenceSchema's sequence segment is exactly two digits (01..99); see src/review/verdict.ts.
		throw new ReviewAggregateError(
			"TOO_MANY_BLOCKERS",
			`aggregateBlockers cannot mint more than 99 blocker ids in one round, got ${ranked.length}`,
		);
	}

	return ranked.map((group, index) => {
		const lane = laneNumber(firstEndorsingLane(group));
		const seq = String(index + 1).padStart(2, "0");
		const blocker: AggregatedBlocker = {
			id: `B-r${round}-L${lane}-${seq}`,
			file: group.file,
			title: group.title,
			evidence: group.evidence,
			endorsements: [...group.endorsingLanes],
		};
		if (group.line !== undefined) {
			blocker.line = group.line;
		}
		if (group.suggested_fix !== undefined) {
			blocker.suggested_fix = group.suggested_fix;
		}
		if (group.category !== undefined) {
			blocker.category = group.category;
		}
		if (group.ref !== undefined) {
			blocker.ref = group.ref;
		}
		return blocker;
	});
}

export interface ResolvedBlocker extends AggregatedBlocker {
	/**
	 * True when this blocker's `ref` does not resolve to a real id in `priorBlockers` -- either because there was
	 * no `ref` at all, or because the ref names something that isn't actually a prior-round id. Fail-closed: the
	 * blocker itself is never dropped or downgraded, it is only flagged so the incremental-round brief and
	 * `review status --report` can surface it prominently (T-20260721-02-review-design.md §6's
	 * NEW_IN_INCREMENTAL marker) -- these are exactly the findings the round's "only judge (a) fixed? (b) new
	 * regression?" scope lock did not anticipate.
	 */
	newInIncremental: boolean;
}

export interface DanglingBlockerRef {
	blockerId: string;
	ref: string;
}

export interface ResolveRefsResult {
	blockers: ResolvedBlocker[];
	/**
	 * Refs that named something that is not actually a `priorBlockers` id. Reported, not thrown: the blocker
	 * itself is still a real finding worth keeping (it is simply also tagged newInIncremental), and a malformed
	 * `ref` from an external reviewer CLI should not be able to abort aggregation for the whole round.
	 */
	danglingRefs: DanglingBlockerRef[];
}

/**
 * Resolves each blocker's `ref` (if any) against the caller-supplied set of ids that are valid to reference --
 * ordinarily the previous round's full `aggregateBlockers` output. B package's `blockerReferenceSchema` (see
 * src/review/verdict.ts) only checked that a `ref`, if present, is *syntactically* a well-formed blocker id; it
 * has no way to know which ids actually existed in a prior round, so that existence check lives here.
 */
export function resolveRefs(
	blockers: readonly AggregatedBlocker[],
	priorBlockers: readonly { id: string }[],
): ResolveRefsResult {
	const priorIds = new Set(priorBlockers.map((blocker) => blocker.id));
	const danglingRefs: DanglingBlockerRef[] = [];

	const resolved = blockers.map((blocker) => {
		let newInIncremental = true;
		if (blocker.ref !== undefined) {
			if (priorIds.has(blocker.ref)) {
				newInIncremental = false;
			} else {
				danglingRefs.push({ blockerId: blocker.id, ref: blocker.ref });
			}
		}
		return { ...blocker, newInIncremental };
	});

	return { blockers: resolved, danglingRefs };
}

/**
 * Removes every waived blocker and returns the remaining (still-open) list. Every id in `waivedIds` must actually
 * be present in `blockers` -- an id that does not exist is a structural error (a typo'd waive must never silently
 * make a real blocker disappear from the "still open" accounting), reported via ReviewAggregateError rather than
 * ignored.
 */
export function applyWaivers(
	blockers: readonly AggregatedBlocker[],
	waivedIds: readonly string[],
): AggregatedBlocker[] {
	const knownIds = new Set(blockers.map((blocker) => blocker.id));
	const unknownIds = [...new Set(waivedIds)].filter((id) => !knownIds.has(id));
	if (unknownIds.length > 0) {
		throw new ReviewAggregateError(
			"UNKNOWN_WAIVER_ID",
			`cannot waive unknown blocker id(s): ${unknownIds.join(", ")}`,
			unknownIds,
		);
	}

	const waived = new Set(waivedIds);
	return blockers.filter((blocker) => !waived.has(blocker.id));
}
