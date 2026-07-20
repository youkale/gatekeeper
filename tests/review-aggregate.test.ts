import { describe, expect, it } from "vitest";

import {
	type AggregatedBlocker,
	aggregateBlockers,
	applyWaivers,
	type LaneVerdict,
	ReviewAggregateError,
	type ReviewAggregateErrorCode,
	resolveRefs,
} from "../src/review/aggregate.js";
import type { ReviewVerdict } from "../src/review/verdict.js";
import { reviewVerdictSchema } from "../src/review/verdict.js";

type BlockerInput = Partial<ReviewVerdict["blockers"][number]> & {
	file: string;
	title: string;
	evidence: string;
};

function verdict(round: number, blockers: BlockerInput[]): ReviewVerdict {
	return {
		apiVersion: "gatekeeper/v1",
		verdict: blockers.length > 0 ? "fail" : "pass",
		run_token: "rv1_test-token",
		round,
		blockers,
		non_blockers: [],
	};
}

function lane(laneId: string, round: number, blockers: BlockerInput[]): LaneVerdict {
	return { laneId, verdict: verdict(round, blockers) };
}

function manyBlockers(count: number): BlockerInput[] {
	return Array.from({ length: count }, (_unused, index) => ({
		file: `src/f${index}.ts`,
		title: `Bug ${index}`,
		evidence: "e",
	}));
}

/** Asserts `fn` throws a ReviewAggregateError carrying exactly `code`, not just any error. */
function expectThrowsWithCode(fn: () => unknown, code: ReviewAggregateErrorCode): void {
	expect(fn).toThrow(ReviewAggregateError);
	try {
		fn();
		throw new Error("expected function to throw");
	} catch (error) {
		expect(error).toBeInstanceOf(ReviewAggregateError);
		expect((error as ReviewAggregateError).code).toBe(code);
	}
}

const blockerIdSchema = reviewVerdictSchema.innerType().shape.blockers.element.shape.id.unwrap();

describe("aggregateBlockers", () => {
	it("mints ids that satisfy src/review/verdict.ts's blocker reference schema", () => {
		const result = aggregateBlockers([
			lane("L1-codex", 1, [{ file: "src/a.ts", line: 10, title: "Bug A", evidence: "evidence A" }]),
		]);
		expect(result).toHaveLength(1);
		const [blocker] = result;
		expect(blocker).toBeDefined();
		expect(blockerIdSchema.safeParse(blocker?.id).success).toBe(true);
		expect(blocker?.id).toBe("B-r1-L1-01");
	});

	it("is deterministic regardless of lane order and each lane's internal blocker order (3 lanes, shuffled)", () => {
		const bugA = { file: "src/a.ts", line: 10, title: "Bug A", evidence: "evidence A" };
		const bugAFromL2 = { ...bugA, evidence: "evidence A (from L2)" };
		const bugB = { file: "src/b.ts", line: 20, title: "Bug B", evidence: "evidence B" };
		const bugC = { file: "src/c.ts", line: 30, title: "Bug C", evidence: "evidence C" };

		const forwardLanes: LaneVerdict[] = [
			lane("L1-codex", 1, [bugA, bugB]),
			lane("L2-claude", 1, [bugB, bugAFromL2, bugC]),
			lane("L3-grok", 1, [bugC, bugB]),
		];
		// Same three lanes, reordered relative to each other, and each lane's own blocker array internally
		// reordered too -- neither axis of shuffling may change the aggregated result.
		const shuffledLanes: LaneVerdict[] = [
			lane("L3-grok", 1, [bugB, bugC]),
			lane("L1-codex", 1, [bugB, bugA]),
			lane("L2-claude", 1, [bugC, bugAFromL2, bugB]),
		];

		expect(aggregateBlockers(shuffledLanes)).toEqual(aggregateBlockers(forwardLanes));
	});

	it("collapses cross-lane duplicates by exact (file, line, title), recording every endorsing lane", () => {
		const result = aggregateBlockers([
			lane("L1-codex", 1, [{ file: "src/a.ts", line: 10, title: "Bug A", evidence: "evidence A" }]),
			lane("L2-claude", 1, [{ file: "src/a.ts", line: 10, title: "Bug A", evidence: "evidence A (from L2)" }]),
		]);
		expect(result).toHaveLength(1);
		expect(result[0]?.endorsements).toEqual(["L1-codex", "L2-claude"]);
	});

	it("sorts multi-endorsed blockers to the top, then breaks ties by first-reporting lane", () => {
		const result = aggregateBlockers([
			lane("L1-codex", 1, [
				{ file: "src/a.ts", line: 1, title: "Multi-endorsed", evidence: "e" },
				{ file: "src/b.ts", line: 2, title: "Only L1", evidence: "e" },
			]),
			lane("L2-claude", 1, [
				{ file: "src/a.ts", line: 1, title: "Multi-endorsed", evidence: "e (from L2)" },
				{ file: "src/c.ts", line: 3, title: "Only L2", evidence: "e" },
			]),
		]);

		expect(result.map((blocker) => blocker.title)).toEqual(["Multi-endorsed", "Only L1", "Only L2"]);
		expect(result.map((blocker) => blocker.id)).toEqual(["B-r1-L1-01", "B-r1-L1-02", "B-r1-L2-03"]);
		expect(result[0]?.endorsements).toEqual(["L1-codex", "L2-claude"]);
	});

	it("does not let one lane double-endorse itself by repeating the same (file, line, title) twice", () => {
		const result = aggregateBlockers([
			lane("L1-codex", 1, [
				{ file: "src/a.ts", line: 1, title: "Dup", evidence: "first" },
				{ file: "src/a.ts", line: 1, title: "Dup", evidence: "second" },
			]),
		]);
		expect(result).toHaveLength(1);
		expect(result[0]?.endorsements).toEqual(["L1-codex"]);
	});

	it("returns an empty list for no lanes", () => {
		expect(aggregateBlockers([])).toEqual([]);
	});

	it("carries through optional blocker fields (line, suggested_fix, category, ref)", () => {
		const [blocker] = aggregateBlockers([
			lane("L1-codex", 1, [
				{
					file: "src/a.ts",
					title: "No line",
					evidence: "e",
					suggested_fix: "do X",
					category: "correctness",
					ref: "B-r1-L1-01",
				},
			]),
		]);
		expect(blocker?.line).toBeUndefined();
		expect(blocker?.suggested_fix).toBe("do X");
		expect(blocker?.category).toBe("correctness");
		expect(blocker?.ref).toBe("B-r1-L1-01");
	});

	it("rejects mixed rounds across lanes", () => {
		expectThrowsWithCode(
			() =>
				aggregateBlockers([
					lane("L1-codex", 1, [{ file: "a.ts", title: "A", evidence: "e" }]),
					lane("L2-claude", 2, [{ file: "b.ts", title: "B", evidence: "e" }]),
				]),
			"MIXED_ROUNDS",
		);
	});

	it("rejects duplicate lane ids", () => {
		expectThrowsWithCode(
			() =>
				aggregateBlockers([
					lane("L1-codex", 1, [{ file: "a.ts", title: "A", evidence: "e" }]),
					lane("L1-codex", 1, [{ file: "b.ts", title: "B", evidence: "e" }]),
				]),
			"DUPLICATE_LANE_ID",
		);
	});

	it("rejects a malformed lane id", () => {
		expectThrowsWithCode(
			() => aggregateBlockers([lane("codex-1", 1, [{ file: "a.ts", title: "A", evidence: "e" }])]),
			"INVALID_LANE_ID",
		);
	});

	it.each(["L0-codex", "L01-codex", "L00-codex"])(
		"rejects a lane id with a leading zero or zero lane number (%s)",
		(laneId) => {
			expectThrowsWithCode(
				() => aggregateBlockers([lane(laneId, 1, [{ file: "a.ts", title: "A", evidence: "e" }])]),
				"INVALID_LANE_ID",
			);
		},
	);

	it("mints exactly 99 ids, ending at seq -99, for a round with exactly 99 distinct blockers", () => {
		const result = aggregateBlockers([lane("L1-codex", 1, manyBlockers(99))]);
		expect(result).toHaveLength(99);
		expect(result[98]?.id).toBe("B-r1-L1-99");
		expect(blockerIdSchema.safeParse(result[98]?.id).success).toBe(true);
	});

	it("throws TOO_MANY_BLOCKERS for a round with 100 distinct blockers (the id sequence segment caps at 99)", () => {
		expectThrowsWithCode(() => aggregateBlockers([lane("L1-codex", 1, manyBlockers(100))]), "TOO_MANY_BLOCKERS");
	});
});

function aggregated(overrides: Partial<AggregatedBlocker> = {}): AggregatedBlocker {
	return {
		id: "B-r2-L1-01",
		file: "src/a.ts",
		line: 10,
		title: "Still broken",
		evidence: "e",
		endorsements: ["L1-codex"],
		...overrides,
	};
}

describe("resolveRefs", () => {
	it("marks a blocker whose ref matches a prior-round id as not new, with no dangling ref reported", () => {
		const result = resolveRefs([aggregated({ ref: "B-r1-L1-01" })], [{ id: "B-r1-L1-01" }]);
		expect(result.blockers[0]?.newInIncremental).toBe(false);
		expect(result.danglingRefs).toEqual([]);
	});

	it("flags NEW_IN_INCREMENTAL and no dangling entry for a blocker with no ref at all", () => {
		const result = resolveRefs([aggregated({ ref: undefined })], [{ id: "B-r1-L1-01" }]);
		expect(result.blockers[0]?.newInIncremental).toBe(true);
		expect(result.danglingRefs).toEqual([]);
	});

	it("flags NEW_IN_INCREMENTAL and reports a dangling ref for a ref that names no real prior id", () => {
		const result = resolveRefs([aggregated({ ref: "B-r1-L9-99" })], [{ id: "B-r1-L1-01" }]);
		expect(result.blockers[0]?.newInIncremental).toBe(true);
		expect(result.danglingRefs).toEqual([{ blockerId: "B-r2-L1-01", ref: "B-r1-L9-99" }]);
	});

	it("preserves every other field of the aggregated blocker unchanged", () => {
		const input = aggregated({ ref: "B-r1-L1-01" });
		const [resolved] = resolveRefs([input], [{ id: "B-r1-L1-01" }]).blockers;
		expect(resolved).toMatchObject({
			id: input.id,
			file: input.file,
			line: input.line,
			title: input.title,
			evidence: input.evidence,
			endorsements: input.endorsements,
			ref: input.ref,
		});
	});
});

describe("applyWaivers", () => {
	it("removes exactly the waived ids and keeps the rest", () => {
		const blockers = [aggregated({ id: "B-r1-L1-01" }), aggregated({ id: "B-r1-L1-02" })];
		const remaining = applyWaivers(blockers, ["B-r1-L1-01"]);
		expect(remaining.map((blocker) => blocker.id)).toEqual(["B-r1-L1-02"]);
	});

	it("throws a structured error for an unknown waive id instead of silently ignoring it", () => {
		const blockers = [aggregated({ id: "B-r1-L1-01" })];
		expectThrowsWithCode(() => applyWaivers(blockers, ["B-r1-L1-99"]), "UNKNOWN_WAIVER_ID");
		try {
			applyWaivers(blockers, ["B-r1-L1-99"]);
		} catch (error) {
			expect((error as ReviewAggregateError).ids).toEqual(["B-r1-L1-99"]);
		}
	});

	it("de-duplicates repeated waive ids without complaint", () => {
		const blockers = [aggregated({ id: "B-r1-L1-01" })];
		expect(applyWaivers(blockers, ["B-r1-L1-01", "B-r1-L1-01"])).toEqual([]);
	});
});
