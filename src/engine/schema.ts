import { z } from "zod";

const contractNamePattern = /^[a-z0-9][a-z0-9-]*$/;

function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		const current = [leftIndex];
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const substitution = (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
			current[rightIndex] = Math.min((previous[rightIndex] ?? 0) + 1, (current[rightIndex - 1] ?? 0) + 1, substitution);
		}
		previous.splice(0, previous.length, ...current);
	}

	return previous[right.length] ?? 0;
}

function closestKey(candidate: string, validKeys: string[]): string | undefined {
	return validKeys
		.map((key) => ({ key, distance: editDistance(candidate, key) }))
		.sort((left, right) => left.distance - right.distance || left.key.localeCompare(right.key))[0]?.key;
}

function reportUnknownKeys(value: unknown, shape: z.ZodRawShape, context: z.RefinementCtx): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return;
	}

	const validKeys = Object.keys(shape);
	for (const key of Object.keys(value)) {
		if (Object.hasOwn(shape, key) || key.startsWith("x-")) {
			continue;
		}

		const nearest = closestKey(key, validKeys);
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: [key],
			message: `Unknown key "${key}".${nearest ? ` Did you mean "${nearest}"?` : ""}`,
			params: {
				kind: "unknown-key",
				nearest,
			},
		});
	}
}

function extensibleStrictObject<T extends z.ZodRawShape>(shape: T) {
	return z.preprocess((value, context) => {
		reportUnknownKeys(value, shape, context);
		return value;
	}, z.object(shape).passthrough());
}

const stringArray = z.array(z.string());

export const authoritySchema = extensibleStrictObject({
	repo: z.string(),
	paths: stringArray.min(1, "At least one path glob is required"),
	exclude: stringArray.optional(),
	if_content: z.string().optional(),
});

export const consumerSchema = extensibleStrictObject({
	repo: z.string(),
	paths: stringArray.min(1, "At least one path glob is required"),
	exclude: stringArray.optional(),
	verify: z.string().optional(),
	role: z.enum(["consumer", "producer", "mirror-frozen"]).default("consumer"),
	allow_actors: stringArray.optional(),
	if_content: z.string().optional(),
});

export const contractSchema = extensibleStrictObject({
	apiVersion: z.literal("gatekeeper/v1"),
	name: z.string().regex(contractNamePattern, "Must match ^[a-z0-9][a-z0-9-]*$"),
	description: z.string().optional(),
	level: z.string(),
	authority: authoritySchema,
	consumers: z.array(consumerSchema).default([]),
});

const humanApprovalLaneShape = {
	type: z.literal("human-approval"),
	min: z.number().int().positive(),
	fresh: z.boolean(),
};

const humanApprovalLaneSchema = z.object(humanApprovalLaneShape).passthrough();

const reviewLanePassSchema = extensibleStrictObject({
	state: z.literal("APPROVED"),
});

const reviewLaneShape = {
	type: z.literal("review"),
	author: z.string(),
	pass: reviewLanePassSchema,
};

const reviewLaneSchema = z.object(reviewLaneShape).passthrough();

export const laneSchema = z.preprocess(
	(value, context) => {
		const type =
			typeof value === "object" && value !== null && !Array.isArray(value)
				? (value as Record<string, unknown>).type
				: undefined;
		const shape =
			type === "human-approval" ? humanApprovalLaneShape : type === "review" ? reviewLaneShape : { type: z.never() };
		reportUnknownKeys(value, shape, context);
		return value;
	},
	z.discriminatedUnion("type", [humanApprovalLaneSchema, reviewLaneSchema]),
);

export const levelRequirementSchema = extensibleStrictObject({
	m: z.number().int().positive().optional(),
	lanes: z.array(z.string()).min(1).optional(),
}).superRefine((requirement, context) => {
	if ((requirement.m === undefined) !== (requirement.lanes === undefined)) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: "m and lanes must either both be present or both be absent",
		});
	}

	if (requirement.lanes && new Set(requirement.lanes).size !== requirement.lanes.length) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["lanes"],
			message: "Lane names must be unique",
		});
	}
});

export const policyLevelSchema = extensibleStrictObject({
	enforcement: z.enum(["block", "warn"]),
	require: levelRequirementSchema,
});

export const policyAdoptionSchema = extensibleStrictObject({
	enforcement_override: z.literal("warn").optional(),
});

export const policyOverridesSchema = extensibleStrictObject({
	label: z.string().default("gatekeeper:override"),
});

export const policySchema = extensibleStrictObject({
	apiVersion: z.literal("gatekeeper/v1"),
	lanes: z.record(z.string(), laneSchema),
	levels: z.record(z.string(), policyLevelSchema),
	adoption: policyAdoptionSchema.optional(),
	overrides: policyOverridesSchema.default({ label: "gatekeeper:override" }),
});
