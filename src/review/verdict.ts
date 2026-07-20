import { z } from "zod";

const RUN_TOKEN_BYTES = 32;

/**
 * Blocker ids and references use `B-r{round}-L{lane}-{seq}`. Round and lane
 * are base-10 positive integers with no leading zero and no digit-count cap;
 * sequence is exactly two digits in the inclusive range 01..99. Consequently
 * `B-r1-L2-03` is valid while zero/zero-prefixed round or lane numbers and
 * sequence values 00 or 100 are invalid.
 */
const blockerReferenceSchema = z.string().regex(/^B-r[1-9]\d*-L[1-9]\d*-(?:0[1-9]|[1-9]\d)$/);

const fileSchema = z.string().min(1);
const lineSchema = z.number().int().positive();
const narrativeSchema = z.string().min(1);

const blockerSchema = z
	.object({
		id: blockerReferenceSchema.optional(),
		ref: blockerReferenceSchema.optional(),
		file: fileSchema,
		line: lineSchema.optional(),
		title: z.string().min(1),
		evidence: narrativeSchema,
		suggested_fix: narrativeSchema.optional(),
		category: z.enum(["correctness", "fail-direction", "security", "compat", "data-loss", "test"]).optional(),
	})
	.strict();

const nonBlockerSchema = z
	.object({
		file: fileSchema.optional(),
		line: lineSchema.optional(),
		note: narrativeSchema,
	})
	.strict();

/**
 * Strict v1 contract for one review lane's VERDICT.json artifact.
 *
 * The final refinement fail-closes contradictory verdicts: `fail` has at
 * least one blocker and `pass` has none.
 */
export const reviewVerdictSchema = z
	.object({
		apiVersion: z.literal("gatekeeper/v1"),
		verdict: z.enum(["pass", "fail"]),
		run_token: z.string().min(1),
		round: z.number().int().positive(),
		blockers: z.array(blockerSchema),
		non_blockers: z.array(nonBlockerSchema),
		out_of_scope: z.array(narrativeSchema).optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.verdict === "fail" && value.blockers.length === 0) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["blockers"],
				message: "a fail verdict requires at least one blocker",
			});
		}
		if (value.verdict === "pass" && value.blockers.length !== 0) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["blockers"],
				message: "a pass verdict requires an empty blockers array",
			});
		}
	});

/** Fully validated v1 VERDICT.json payload. */
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

/** Injected cryptographic byte source used by the brief-side token writer. */
export type RunTokenRandomSource = (length: number) => Uint8Array;

/**
 * Generate the one-time link between a review brief and evidence validation.
 * This is the sole formatter for run tokens; the evidence gate only performs
 * an exact comparison and deliberately does not duplicate format rules.
 */
export function generateRunToken(randomBytes: RunTokenRandomSource): string {
	const bytes = randomBytes(RUN_TOKEN_BYTES);
	if (!(bytes instanceof Uint8Array) || bytes.length !== RUN_TOKEN_BYTES) {
		throw new TypeError(`random source must return exactly ${RUN_TOKEN_BYTES} bytes`);
	}
	const encoded = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `rv1_${encoded}`;
}
