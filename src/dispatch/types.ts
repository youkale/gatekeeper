import path from "node:path";

import { z } from "zod";

export const WORK_ORDER_STATUSES = [
	"PENDING",
	"RUNNING",
	"WAITING_COOLDOWN",
	"NEEDS_ATTENTION",
	"DELIVERED",
	"ABANDONED",
] as const;

export const RUN_OUTCOMES = [
	"COMPLETED",
	"KILLED",
	"TIMEOUT",
	"STALLED",
	"RATE_LIMITED",
	"AGENT_BLOCKED",
	"EXITED_NO_EVIDENCE",
	"AGENT_ERROR",
	"SPAWN_FAILED",
	"ORPHANED_UNKNOWN",
] as const;
/** Alias naming the same exhaustive set by its role in the state model. */
export const RUN_TERMINAL_STATUSES = RUN_OUTCOMES;

export const workOrderStatusSchema = z.enum(WORK_ORDER_STATUSES);
export const runOutcomeSchema = z.enum(RUN_OUTCOMES);

export type WorkOrderStatus = z.infer<typeof workOrderStatusSchema>;
export type RunOutcome = z.infer<typeof runOutcomeSchema>;
export type RunTerminalStatus = RunOutcome;
export type OrderState = WorkOrderStatus;

const isoTimestampSchema = z.string().datetime({ offset: true });
export const orderIdSchema = z.string().regex(/^wo-[a-z0-9][a-z0-9-]*$/, "must be a safe wo-* directory name");
export const runIdSchema = z.string().regex(/^r(?:00[1-9]|0[1-9]\d|[1-9]\d{2})$/, "must be exactly r001 through r999");
const repoIdentitySchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be an org/name repository identity");
const relativePathSchema = z
	.string()
	.min(1)
	.refine(
		(value) => !path.isAbsolute(value) && value !== "." && !value.split(/[\\/]+/).includes(".."),
		"must be a non-traversing relative path",
	);

const targetRepoSchema = z
	.object({
		name: repoIdentitySchema,
		path: z.string().min(1).refine(path.isAbsolute, "must be an absolute realpath"),
	})
	.strict();

const acceptanceContractSchema = z
	.object({
		result_path: relativePathSchema,
		progress_path: relativePathSchema,
		require_non_wip_commit: z.boolean(),
		criteria: z.array(z.string().min(1)),
	})
	.strict();

const candidateSchema = z
	.object({
		cli: z.string().min(1),
		vendor: z.string().min(1),
		command: z.string().min(1),
	})
	.strict();

/** Immutable order.yaml fields plus the deliberately small mutable authoring-vendor set. */
export const workOrderSchema = z
	.object({
		apiVersion: z.literal("gatekeeper/v1"),
		id: orderIdSchema,
		association_key: z.string().regex(/^[^/\s]+\/[^/\s]+#\d+$/, "must be org/repo#issue"),
		target_repo: targetRepoSchema,
		role: z.literal("coder"),
		/** Stable reference to the canonical original brief stored alongside order.yaml, without duplicating it in YAML. */
		brief_path: z.literal("brief.md"),
		acceptance_contract: acceptanceContractSchema,
		candidate_ladder: z.array(candidateSchema).min(1),
		authoring_vendors: z
			.array(z.string().min(1))
			.refine((vendors) => new Set(vendors).size === vendors.length, "must not contain duplicate vendors"),
		created_at: isoTimestampSchema,
	})
	.strict();

/** runs/rNNN/meta.json. Terminal-only fields are optional while a run is live. */
export const runSchema = z
	.object({
		apiVersion: z.literal("gatekeeper/v1"),
		id: runIdSchema,
		cli: z.string().min(1),
		vendor: z.string().min(1),
		command: z.string().min(1),
		/** Stable reference to this run's actual brief in runs/rNNN/brief.md. */
		brief_path: relativePathSchema,
		pid: z.number().int().positive().optional(),
		pgid: z.number().int().positive().optional(),
		started_at: isoTimestampSchema,
		ended_at: isoTimestampSchema.optional(),
		outcome: runOutcomeSchema.optional(),
		exit_code: z.number().int().nullable().optional(),
		signal: z.string().min(1).nullable().optional(),
		stdout_path: relativePathSchema,
		stderr_path: relativePathSchema,
		out_path: relativePathSchema,
	})
	.strict()
	.superRefine((run, context) => {
		if ((run.ended_at === undefined) !== (run.outcome === undefined)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "ended_at and outcome must either both be present or both be absent",
			});
		}
		if (run.outcome === undefined && (run.exit_code !== undefined || run.signal !== undefined)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "an active run must not contain exit_code or signal",
			});
		}
		if (run.outcome !== undefined && (run.exit_code === undefined || run.signal === undefined)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "a terminal run must explicitly contain exit_code and signal (either may be null)",
			});
		}
		if (run.outcome === "COMPLETED" || run.outcome === "EXITED_NO_EVIDENCE") {
			if (run.exit_code !== 0 || run.signal !== null) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: `${run.outcome} requires exit_code 0 and signal null`,
				});
			}
		}
		if (
			run.outcome === "AGENT_ERROR" &&
			(run.exit_code === undefined || run.exit_code === null || run.exit_code === 0 || run.signal !== null)
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "AGENT_ERROR requires a non-zero exit_code and signal null",
			});
		}
		const expectedPaths = {
			brief_path: `runs/${run.id}/brief.md`,
			stdout_path: `runs/${run.id}/stdout.log`,
			stderr_path: `runs/${run.id}/stderr.log`,
			out_path: `runs/${run.id}/out`,
		} as const;
		for (const [field, expected] of Object.entries(expectedPaths)) {
			if (run[field as keyof typeof expectedPaths] !== expected) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: [field],
					message: `must equal ${expected}`,
				});
			}
		}
	});

const journalBase = {
	apiVersion: z.literal("gatekeeper/v1"),
	order_id: orderIdSchema,
	at: isoTimestampSchema,
};

const orderCreatedEventSchema = z
	.object({
		...journalBase,
		type: z.literal("ORDER_CREATED"),
		to: z.literal("PENDING"),
	})
	.strict();

const runStartedEventSchema = z
	.object({
		...journalBase,
		type: z.literal("RUN_STARTED"),
		run_id: runIdSchema,
		from: z.literal("PENDING"),
		to: z.literal("RUNNING"),
	})
	.strict();

const retryableOutcomeSchema = z.enum([
	"TIMEOUT",
	"STALLED",
	"RATE_LIMITED",
	"EXITED_NO_EVIDENCE",
	"AGENT_ERROR",
	"ORPHANED_UNKNOWN",
]);

const runRetryScheduledEventSchema = z
	.object({
		...journalBase,
		type: z.literal("RUN_RETRY_SCHEDULED"),
		previous_run_id: runIdSchema,
		next_run_id: runIdSchema,
		outcome: retryableOutcomeSchema,
		from: z.literal("RUNNING"),
		to: z.literal("RUNNING"),
	})
	.strict();

const cooldownStartedEventSchema = z
	.object({
		...journalBase,
		type: z.literal("COOLDOWN_STARTED"),
		run_id: runIdSchema,
		outcome: z.literal("RATE_LIMITED"),
		resume_after: isoTimestampSchema,
		from: z.literal("RUNNING"),
		to: z.literal("WAITING_COOLDOWN"),
	})
	.strict();

const attentionOutcomeSchema = z.enum([
	"TIMEOUT",
	"STALLED",
	"AGENT_BLOCKED",
	"EXITED_NO_EVIDENCE",
	"AGENT_ERROR",
	"SPAWN_FAILED",
	"ORPHANED_UNKNOWN",
]);

const attentionRequiredEventSchema = z
	.object({
		...journalBase,
		type: z.literal("ATTENTION_REQUIRED"),
		run_id: runIdSchema,
		outcome: attentionOutcomeSchema,
		reason: z.string().min(1),
		from: z.literal("RUNNING"),
		to: z.literal("NEEDS_ATTENTION"),
	})
	.strict();

const orderDeliveredEventSchema = z
	.object({
		...journalBase,
		type: z.literal("ORDER_DELIVERED"),
		run_id: runIdSchema,
		outcome: z.literal("COMPLETED"),
		from: z.literal("RUNNING"),
		to: z.literal("DELIVERED"),
	})
	.strict();

const orderCancelledEventSchema = z
	.object({
		...journalBase,
		type: z.literal("ORDER_CANCELLED"),
		run_id: runIdSchema.optional(),
		outcome: z.literal("KILLED").optional(),
		from: z.enum(["RUNNING", "WAITING_COOLDOWN", "NEEDS_ATTENTION"]),
		to: z.literal("ABANDONED"),
	})
	.strict();

const orderResumedEventSchema = z
	.object({
		...journalBase,
		type: z.literal("ORDER_RESUMED"),
		new_run_id: runIdSchema,
		from: z.enum(["WAITING_COOLDOWN", "NEEDS_ATTENTION"]),
		to: z.literal("RUNNING"),
		forced: z.boolean(),
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
		orderCreatedEventSchema,
		runStartedEventSchema,
		runRetryScheduledEventSchema,
		cooldownStartedEventSchema,
		attentionRequiredEventSchema,
		orderDeliveredEventSchema,
		orderCancelledEventSchema,
		orderResumedEventSchema,
		lockTakenOverEventSchema,
	])
	.superRefine((event, context) => {
		if (event.type === "RUN_RETRY_SCHEDULED" && event.previous_run_id === event.next_run_id) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "RUN_RETRY_SCHEDULED requires distinct previous_run_id and next_run_id",
			});
		}
		if (event.type !== "ORDER_CANCELLED") {
			return;
		}
		if (event.from === "RUNNING") {
			if (event.run_id === undefined || event.outcome !== "KILLED") {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "cancelling RUNNING requires run_id and outcome KILLED",
				});
			}
		} else if (event.run_id !== undefined || event.outcome !== undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: `cancelling ${event.from} must not contain run_id or outcome`,
			});
		}
	});

export type WorkOrder = z.infer<typeof workOrderSchema>;
export type Run = z.infer<typeof runSchema>;
export type JournalEvent = z.infer<typeof journalEventSchema>;
export type StateTransitionEvent = Exclude<JournalEvent, { type: "ORDER_CREATED" | "LOCK_TAKEN_OVER" }>;
