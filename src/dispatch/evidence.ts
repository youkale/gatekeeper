import { z } from "zod";

/**
 * The v1 delivery receipt written by an agent to its run output directory.
 * This is deliberately small and strict: new producer fields require an
 * explicit contract revision instead of being silently ignored.
 */
export const dispatchResultSchema = z
	.object({
		apiVersion: z.literal("gatekeeper/v1"),
		status: z.enum(["delivered", "blocked"]),
		summary: z.string().min(1),
	})
	.strict();

export type DispatchResult = z.infer<typeof dispatchResultSchema>;

export interface ResultFileReader {
	readText(path: string): Promise<string>;
}

export interface ResultSchemaIssue {
	readonly code: string;
	readonly path: readonly (string | number)[];
	readonly message: string;
}

export type ResultFileEvidence =
	| {
			established: true;
			result: DispatchResult;
	  }
	| {
			established: false;
			reason: "missing" | "read-error" | "corrupt" | "schema-mismatch";
			message: string;
			issues?: readonly ResultSchemaIssue[];
	  };

export interface GitExecutionResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** The caller owns cwd/repository selection; evidence.ts only supplies deterministic argv. */
export interface GitExecutor {
	exec(args: readonly string[]): Promise<GitExecutionResult>;
}

export type CommitEvidence =
	| {
			established: true;
			commitSubjects: readonly string[];
			nonWipCommitSubjects: readonly string[];
	  }
	| {
			established: false;
			reason: "no-commits" | "only-wip-commits" | "git-error";
			commitSubjects: readonly string[];
			message?: string;
	  };

export interface DeliveryEvidence {
	readonly resultFile: ResultFileEvidence;
	readonly commit: CommitEvidence;
}

export type DeliveryEvidenceVerdict = "COMPLETED" | "AGENT_BLOCKED" | "NOT_ESTABLISHED";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

/** Read and hard-validate RESULT.json through an injected reader. */
export async function checkResultFile(path: string, reader: ResultFileReader): Promise<ResultFileEvidence> {
	let raw: string;
	try {
		raw = await reader.readText(path);
	} catch (error) {
		return {
			established: false,
			reason: isMissingPathError(error) ? "missing" : "read-error",
			message: errorMessage(error),
		};
	}

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		return {
			established: false,
			reason: "corrupt",
			message: errorMessage(error),
		};
	}

	const parsed = dispatchResultSchema.safeParse(value);
	if (!parsed.success) {
		return {
			established: false,
			reason: "schema-mismatch",
			message: "RESULT.json does not match the gatekeeper/v1 dispatch result schema",
			issues: parsed.error.issues.map((issue) => ({
				code: issue.code,
				path: [...issue.path],
				message: issue.message,
			})),
		};
	}

	return { established: true, result: parsed.data };
}

export function isWipSnapshotCommit(subject: string): boolean {
	return subject.startsWith("wip: run r");
}

interface CommitRecord {
	readonly hash: string;
	readonly subject: string;
}

function parseCommitRecords(stdout: string): readonly CommitRecord[] | undefined {
	if (stdout.length === 0) {
		return [];
	}
	const lines = stdout.split(/\r?\n/);
	if (lines.at(-1) === "") {
		lines.pop();
	}
	const records: CommitRecord[] = [];
	for (const line of lines) {
		const separator = line.indexOf("\0");
		if (separator <= 0 || separator !== line.lastIndexOf("\0")) {
			return undefined;
		}
		const hash = line.slice(0, separator);
		if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) {
			return undefined;
		}
		records.push({ hash, subject: line.slice(separator + 1) });
	}
	return records;
}

/**
 * Establish whether base..HEAD contains at least one non-WIP commit. Git is
 * injected so this module never selects a repository or performs process I/O.
 */
export async function checkNonWipCommit(baseRef: string, git: GitExecutor): Promise<CommitEvidence> {
	let execution: GitExecutionResult;
	try {
		execution = await git.exec([
			"rev-list",
			"--format=%H%x00%s",
			"--no-commit-header",
			"--end-of-options",
			`${baseRef}..HEAD`,
		]);
	} catch (error) {
		return {
			established: false,
			reason: "git-error",
			commitSubjects: [],
			message: errorMessage(error),
		};
	}

	if (execution.exitCode !== 0) {
		return {
			established: false,
			reason: "git-error",
			commitSubjects: [],
			message: execution.stderr || `git rev-list exited ${execution.exitCode}`,
		};
	}

	const commitRecords = parseCommitRecords(execution.stdout);
	if (commitRecords === undefined) {
		return {
			established: false,
			reason: "git-error",
			commitSubjects: [],
			message: "git rev-list returned malformed commit records",
		};
	}
	if (commitRecords.length === 0) {
		const commitSubjects: string[] = [];
		return { established: false, reason: "no-commits", commitSubjects };
	}

	const commitSubjects = commitRecords.map((record) => record.subject);
	const nonWipCommitSubjects = commitSubjects.filter((subject) => !isWipSnapshotCommit(subject));
	if (nonWipCommitSubjects.length === 0) {
		return { established: false, reason: "only-wip-commits", commitSubjects };
	}

	return { established: true, commitSubjects, nonWipCommitSubjects };
}

export async function checkDeliveryEvidence(
	input: { resultPath: string; baseRef: string },
	dependencies: { resultReader: ResultFileReader; git: GitExecutor },
): Promise<DeliveryEvidence> {
	const [resultFile, commit] = await Promise.all([
		checkResultFile(input.resultPath, dependencies.resultReader),
		checkNonWipCommit(input.baseRef, dependencies.git),
	]);
	return { resultFile, commit };
}

/**
 * RESULT.json status "blocked" is an explicit agent verdict and wins even
 * when the process exit or commit evidence would otherwise be inconclusive.
 */
export function evaluateDeliveryEvidence(exitCode: number | null, evidence: DeliveryEvidence): DeliveryEvidenceVerdict {
	if (evidence.resultFile.established && evidence.resultFile.result.status === "blocked") {
		return "AGENT_BLOCKED";
	}
	if (
		exitCode === 0 &&
		evidence.resultFile.established &&
		evidence.resultFile.result.status === "delivered" &&
		evidence.commit.established
	) {
		return "COMPLETED";
	}
	return "NOT_ESTABLISHED";
}
