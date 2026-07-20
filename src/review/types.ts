import path from "node:path";

import { z } from "zod";

import { orderIdSchema } from "../dispatch/types.js";

export const REVIEW_CYCLE_STATUSES = [
	"PENDING",
	"REVIEWING",
	"WAITING_COOLDOWN",
	"BLOCKED",
	"FIXING",
	"AWAITING_ACCEPT",
	"ARBITRATION",
	"ACCEPTED",
	"ABANDONED",
] as const;

export const ROUND_STATUSES = ["REVIEWING", "AWAITING_ACCEPT", "BLOCKED", "ARBITRATION"] as const;
export const ROUND_VERDICTS = ["PASS", "FAIL", "UNAVAILABLE"] as const;
export const LANE_STATUSES = ["PENDING", "RUNNING", "CONCLUDED"] as const;
export const LANE_OUTCOMES = ["PASS", "FAIL", "INVALID", "RATE_LIMITED", "INFRA_ERROR"] as const;

export const reviewCycleStatusSchema = z.enum(REVIEW_CYCLE_STATUSES);
export const roundStatusSchema = z.enum(ROUND_STATUSES);
export const roundVerdictSchema = z.enum(ROUND_VERDICTS);
export const laneStatusSchema = z.enum(LANE_STATUSES);
export const laneOutcomeSchema = z.enum(LANE_OUTCOMES);

const isoTimestampSchema = z.string().datetime({ offset: true });
export const reviewCycleIdSchema = z.string().regex(/^rc-[a-z0-9][a-z0-9-]*$/, "must be a safe rc-* directory name");
export const roundIdSchema = z.string().regex(/^R[1-9]\d*$/, "must be R followed by a positive integer");
export const laneIdSchema = z
	.string()
	.regex(/^L[1-9]\d*-[a-z0-9][a-z0-9-]*$/, "must be L<number>-<cli> using safe directory characters");

const repoIdentitySchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be an org/name repository identity");
const relativePathSchema = z
	.string()
	.min(1)
	.refine(
		(value) => !path.isAbsolute(value) && value !== "." && !value.split(/[\\/]+/).includes(".."),
		"must be a non-traversing relative path",
	);

export const dispatchOrderSubjectSchema = z
	.object({
		kind: z.literal("dispatch-order"),
		order_id: orderIdSchema,
	})
	.strict();

export const diffSubjectSchema = z
	.object({
		kind: z.literal("diff"),
		repo: z.string().min(1),
		base_ref: z.string().min(1),
		head_ref: z.string().min(1).optional(),
	})
	.strict();

export const reviewSubjectSchema = z.discriminatedUnion("kind", [dispatchOrderSubjectSchema, diffSubjectSchema]);

export const reviewTargetRepoSchema = z
	.object({
		name: repoIdentitySchema,
		path: z.string().min(1).refine(path.isAbsolute, "must be an absolute realpath"),
	})
	.strict();

/** Frozen route selected when the cycle is created. Later policy changes cannot reorder or reclassify these lanes. */
export const laneRouteSchema = z
	.object({
		id: laneIdSchema,
		cli: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must use safe lane directory characters"),
		vendor: z.string().min(1),
		command: z.string().min(1),
		required: z.boolean(),
	})
	.strict()
	.superRefine((lane, context) => {
		if (lane.id.replace(/^L[1-9]\d*-/, "") !== lane.cli) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "CLI suffix must equal cli" });
		}
	});

export const reviewCycleSchema = z
	.object({
		apiVersion: z.literal("gatekeeper/v1"),
		id: reviewCycleIdSchema,
		subject: reviewSubjectSchema,
		target_repo: reviewTargetRepoSchema,
		authoring_vendors: z.array(z.string().min(1)),
		/** Initial frozen limit. Arbitration extensions live only in the journal and each add exactly one. */
		max_rounds: z.number().int().positive(),
		lane_snapshot: z.array(laneRouteSchema).min(1),
		degraded: z.boolean(),
		created_at: isoTimestampSchema,
	})
	.strict()
	.superRefine((cycle, context) => {
		const uniqueFields: Array<[string, readonly string[]]> = [
			["authoring_vendors", cycle.authoring_vendors],
			["lane_snapshot.id", cycle.lane_snapshot.map((lane) => lane.id)],
			["lane_snapshot.cli", cycle.lane_snapshot.map((lane) => lane.cli)],
		];
		for (const [field, values] of uniqueFields) {
			if (new Set(values).size !== values.length) {
				context.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must not contain duplicates` });
			}
		}
		if (!cycle.lane_snapshot.some((lane) => lane.required)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["lane_snapshot"],
				message: "must contain at least one required lane",
			});
		}
		for (let index = 0; index < cycle.lane_snapshot.length; index += 1) {
			const lane = cycle.lane_snapshot[index];
			if (lane && lane.id !== `L${index + 1}-${lane.cli}`) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["lane_snapshot", index, "id"],
					message: `must equal L${index + 1}-${lane.cli}`,
				});
			}
		}
		if (cycle.lane_snapshot.some((lane) => cycle.authoring_vendors.includes(lane.vendor))) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["lane_snapshot"],
				message: "must exclude authoring vendors",
			});
		}
	});

export const subjectFingerprintSchema = z
	.object({
		head: z.string().min(1),
		porcelain: z.string(),
		trackedDiff: z.string(),
		untracked: z.array(
			z
				.object({
					path: z.string().min(1),
					hash: z.string().min(1),
				})
				.strict(),
		),
	})
	.strict();

export const roundLaneResultSchema = z
	.object({
		lane_id: laneIdSchema,
		required: z.boolean(),
		outcome: laneOutcomeSchema,
	})
	.strict();

export type RoundLaneResult = z.infer<typeof roundLaneResultSchema>;

/** Deterministic fail-closed aggregate: advisory lanes never influence the declared round verdict. */
export function aggregateRequiredLaneResults(
	results: readonly RoundLaneResult[],
): "PASS" | "FAIL" | "UNAVAILABLE" | undefined {
	const required = results.filter((result) => result.required);
	if (required.length === 0) {
		return undefined;
	}
	if (required.some((result) => ["INVALID", "RATE_LIMITED", "INFRA_ERROR"].includes(result.outcome))) {
		return "UNAVAILABLE";
	}
	if (required.every((result) => result.outcome === "PASS")) {
		return "PASS";
	}
	return "FAIL";
}

export const roundSchema = z
	.object({
		apiVersion: z.literal("gatekeeper/v1"),
		id: roundIdSchema,
		cycle_id: reviewCycleIdSchema,
		number: z.number().int().positive(),
		status: roundStatusSchema,
		subject_fingerprint: subjectFingerprintSchema,
		lane_ids: z.array(laneIdSchema).min(1),
		lane_results: z.array(roundLaneResultSchema),
		verdict: roundVerdictSchema.optional(),
		fix_order_id: orderIdSchema.optional(),
		started_at: isoTimestampSchema,
		concluded_at: isoTimestampSchema.optional(),
	})
	.strict()
	.superRefine((round, context) => {
		if (round.id !== `R${round.number}`) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: `must equal R${round.number}` });
		}
		if (new Set(round.lane_ids).size !== round.lane_ids.length) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["lane_ids"], message: "must not contain duplicates" });
		}
		const resultIds = round.lane_results.map((result) => result.lane_id);
		if (new Set(resultIds).size !== resultIds.length) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["lane_results"], message: "must not contain duplicates" });
		}
		if (resultIds.some((id) => !round.lane_ids.includes(id))) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["lane_results"],
				message: "must be a subset of lane_ids",
			});
		}
		if (round.status === "REVIEWING") {
			if (round.verdict !== undefined || round.concluded_at !== undefined || round.fix_order_id !== undefined) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "a REVIEWING round must not contain verdict, concluded_at, or fix_order_id",
				});
			}
			return;
		}
		if (resultIds.length !== round.lane_ids.length) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["lane_results"],
				message: "a concluded round requires exactly one result for every lane_id",
			});
		}
		const aggregate = aggregateRequiredLaneResults(round.lane_results);
		if (aggregate === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["lane_results"],
				message: "a concluded round requires at least one required lane result",
			});
		} else if (round.verdict !== aggregate) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["verdict"],
				message: `must equal required-lane aggregate ${aggregate}`,
			});
		}
		if (round.verdict === undefined || round.concluded_at === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "a concluded round requires verdict and concluded_at",
			});
		}
		if (round.status === "AWAITING_ACCEPT" && round.verdict !== "PASS") {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "AWAITING_ACCEPT requires verdict PASS" });
		}
		if (round.status === "BLOCKED" && round.verdict !== "FAIL") {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "BLOCKED requires verdict FAIL" });
		}
		if (round.status === "ARBITRATION" && round.verdict === "PASS") {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "ARBITRATION cannot contain verdict PASS" });
		}
		if (round.fix_order_id !== undefined && round.status !== "BLOCKED") {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "fix_order_id is only valid for a BLOCKED round" });
		}
	});

export const laneSchema = z
	.object({
		apiVersion: z.literal("gatekeeper/v1"),
		id: laneIdSchema,
		cycle_id: reviewCycleIdSchema,
		round: z.number().int().positive(),
		cli: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must use safe lane directory characters"),
		vendor: z.string().min(1),
		command: z.string().min(1),
		required: z.boolean(),
		status: laneStatusSchema,
		pid: z.number().int().positive().optional(),
		pgid: z.number().int().positive().optional(),
		brief_path: relativePathSchema,
		stdout_path: relativePathSchema,
		stderr_path: relativePathSchema,
		out_path: relativePathSchema,
		result_path: relativePathSchema,
		started_at: isoTimestampSchema.optional(),
		ended_at: isoTimestampSchema.optional(),
		outcome: laneOutcomeSchema.optional(),
		exit_code: z.number().int().nullable().optional(),
		signal: z.string().min(1).nullable().optional(),
	})
	.strict()
	.superRefine((lane, context) => {
		if (lane.id.replace(/^L[1-9]\d*-/, "") !== lane.cli) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "CLI suffix must equal cli" });
		}
		const expectedRoot = `rounds/R${lane.round}/lanes/${lane.id}`;
		const expectedPaths = {
			brief_path: `${expectedRoot}/brief.md`,
			stdout_path: `${expectedRoot}/stdout.log`,
			stderr_path: `${expectedRoot}/stderr.log`,
			out_path: `${expectedRoot}/out`,
			result_path: `${expectedRoot}/out/VERDICT.json`,
		} as const;
		for (const [field, expected] of Object.entries(expectedPaths)) {
			if (lane[field as keyof typeof expectedPaths] !== expected) {
				context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `must equal ${expected}` });
			}
		}
		const lifecycleFields = [
			lane.pid,
			lane.pgid,
			lane.started_at,
			lane.ended_at,
			lane.outcome,
			lane.exit_code,
			lane.signal,
		];
		if (lane.status === "PENDING" && lifecycleFields.some((value) => value !== undefined)) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "a PENDING lane must not contain lifecycle fields" });
		}
		if (
			lane.status === "RUNNING" &&
			(lane.started_at === undefined ||
				lane.ended_at !== undefined ||
				lane.outcome !== undefined ||
				lane.exit_code !== undefined ||
				lane.signal !== undefined)
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "a RUNNING lane requires started_at and must not contain terminal fields",
			});
		}
		if (
			lane.status === "CONCLUDED" &&
			(lane.started_at === undefined ||
				lane.ended_at === undefined ||
				lane.outcome === undefined ||
				lane.exit_code === undefined ||
				lane.signal === undefined)
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "a CONCLUDED lane requires started_at, ended_at, outcome, exit_code, and signal",
			});
		}
	});

const journalBase = {
	apiVersion: z.literal("gatekeeper/v1"),
	cycle_id: reviewCycleIdSchema,
	at: isoTimestampSchema,
};

const cycleCreatedEventSchema = z
	.object({ ...journalBase, type: z.literal("CYCLE_CREATED"), to: z.literal("PENDING") })
	.strict();

const roundStartedEventSchema = z
	.object({
		...journalBase,
		type: z.literal("ROUND_STARTED"),
		round: z.number().int().positive(),
		from: z.enum(["PENDING", "FIXING", "ARBITRATION"]),
		to: z.literal("REVIEWING"),
		previous_max_rounds: z.number().int().positive().optional(),
		max_rounds: z.number().int().positive().optional(),
		extension_reason: z.string().min(1).optional(),
	})
	.strict();

const laneConcludedEventSchema = z
	.object({
		...journalBase,
		type: z.literal("LANE_CONCLUDED"),
		round: z.number().int().positive(),
		lane_id: laneIdSchema,
		outcome: laneOutcomeSchema,
	})
	.strict();

const cooldownStartedEventSchema = z
	.object({
		...journalBase,
		type: z.literal("COOLDOWN_STARTED"),
		round: z.number().int().positive(),
		lane_id: laneIdSchema,
		resume_after: isoTimestampSchema,
		from: z.literal("REVIEWING"),
		to: z.literal("WAITING_COOLDOWN"),
	})
	.strict();

const cycleResumedEventSchema = z
	.object({
		...journalBase,
		type: z.literal("CYCLE_RESUMED"),
		round: z.number().int().positive(),
		from: z.literal("WAITING_COOLDOWN"),
		to: z.literal("REVIEWING"),
	})
	.strict();

const roundConcludedEventSchema = z
	.object({
		...journalBase,
		type: z.literal("ROUND_CONCLUDED"),
		round: z.number().int().positive(),
		verdict: roundVerdictSchema,
		from: z.literal("REVIEWING"),
		to: z.enum(["AWAITING_ACCEPT", "BLOCKED", "ARBITRATION"]),
	})
	.strict();

const blockerWaivedEventSchema = z
	.object({
		...journalBase,
		type: z.literal("BLOCKER_WAIVED"),
		round: z.number().int().positive(),
		blocker_id: z.string().min(1),
		operator: z.string().min(1),
		reason: z.string().min(1),
	})
	.strict();

const fixDispatchedEventSchema = z
	.object({
		...journalBase,
		type: z.literal("FIX_DISPATCHED"),
		round: z.number().int().positive(),
		fix_order_id: orderIdSchema,
		from: z.enum(["BLOCKED", "AWAITING_ACCEPT"]),
		to: z.literal("FIXING"),
	})
	.strict();

const fixFailedEventSchema = z
	.object({
		...journalBase,
		type: z.literal("FIX_FAILED"),
		round: z.number().int().positive(),
		fix_order_id: orderIdSchema,
		reason: z.string().min(1),
		from: z.literal("FIXING"),
		to: z.literal("BLOCKED"),
	})
	.strict();

const cycleAcceptedEventSchema = z
	.object({
		...journalBase,
		type: z.literal("CYCLE_ACCEPTED"),
		operator: z.string().min(1),
		note: z.string().min(1).optional(),
		from: z.enum(["AWAITING_ACCEPT", "ARBITRATION"]),
		to: z.literal("ACCEPTED"),
	})
	.strict();

const cycleCancelledEventSchema = z
	.object({
		...journalBase,
		type: z.literal("CYCLE_CANCELLED"),
		operator: z.string().min(1),
		reason: z.string().min(1),
		from: z.enum(["REVIEWING", "WAITING_COOLDOWN", "BLOCKED", "FIXING", "AWAITING_ACCEPT", "ARBITRATION"]),
		to: z.literal("ABANDONED"),
	})
	.strict();

const lockTakenOverEventSchema = z
	.object({
		...journalBase,
		type: z.literal("LOCK_TAKEN_OVER"),
		previous_pid: z.number().int().positive(),
		previous_started_at: isoTimestampSchema,
		new_pid: z.number().int().positive(),
	})
	.strict();

/** Every journal line is one strict, discriminated v1 event. Unknown keys are rejected. */
export const journalEventSchema = z
	.discriminatedUnion("type", [
		cycleCreatedEventSchema,
		roundStartedEventSchema,
		laneConcludedEventSchema,
		cooldownStartedEventSchema,
		cycleResumedEventSchema,
		roundConcludedEventSchema,
		blockerWaivedEventSchema,
		fixDispatchedEventSchema,
		fixFailedEventSchema,
		cycleAcceptedEventSchema,
		cycleCancelledEventSchema,
		lockTakenOverEventSchema,
	])
	.superRefine((event, context) => {
		if (event.type === "ROUND_STARTED") {
			const extension = [event.previous_max_rounds, event.max_rounds, event.extension_reason];
			if (event.from === "ARBITRATION") {
				if (extension.some((value) => value === undefined)) {
					context.addIssue({ code: z.ZodIssueCode.custom, message: "ARBITRATION extension requires all limit fields" });
				} else if ((event.max_rounds as number) !== (event.previous_max_rounds as number) + 1) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: "an extension must increase max_rounds by exactly one",
					});
				}
			} else if (extension.some((value) => value !== undefined)) {
				context.addIssue({ code: z.ZodIssueCode.custom, message: "only ARBITRATION may extend max_rounds" });
			}
		}
		if (event.type === "ROUND_CONCLUDED") {
			const valid =
				(event.verdict === "PASS" && event.to === "AWAITING_ACCEPT") ||
				(event.verdict === "FAIL" && (event.to === "BLOCKED" || event.to === "ARBITRATION")) ||
				(event.verdict === "UNAVAILABLE" && event.to === "ARBITRATION");
			if (!valid) {
				context.addIssue({ code: z.ZodIssueCode.custom, message: "verdict and target state disagree" });
			}
		}
	});

export type ReviewCycleStatus = z.infer<typeof reviewCycleStatusSchema>;
export type ReviewCycleState = ReviewCycleStatus;
export type ReviewSubject = z.infer<typeof reviewSubjectSchema>;
export type LaneRoute = z.infer<typeof laneRouteSchema>;
export type ReviewCycle = z.infer<typeof reviewCycleSchema>;
export type Round = z.infer<typeof roundSchema>;
export type Lane = z.infer<typeof laneSchema>;
export type ReviewJournalEvent = z.infer<typeof journalEventSchema>;
export type ReviewStateEvent = Exclude<ReviewJournalEvent, { type: "CYCLE_CREATED" }>;

/** Descriptive aliases matching the persistent filenames used by callers. */
export const cycleSchema = reviewCycleSchema;
export const roundSummarySchema = roundSchema;
export const laneMetadataSchema = laneSchema;
