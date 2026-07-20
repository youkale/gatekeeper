import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { parseDocument, stringify } from "yaml";
import type { z } from "zod";

import { resolveConfigDir } from "../config/controls.js";
import { withFileLock } from "../config/filelock.js";
import { foldJournal } from "./machine.js";
import {
	journalEventSchema,
	type Lane,
	laneIdSchema,
	laneSchema,
	type ReviewCycle,
	type ReviewCycleState,
	type ReviewJournalEvent,
	type ReviewSubject,
	type Round,
	reviewCycleIdSchema,
	reviewCycleSchema,
	roundIdSchema,
	roundSchema,
} from "./types.js";

const REVIEW_DIRECTORY = "review";
const CYCLES_DIRECTORY = "cycles";
const CYCLE_FILENAME = "cycle.yaml";
const JOURNAL_FILENAME = "journal.jsonl";
const SUBJECT_FILENAME = "subject.md";
const ROUNDS_DIRECTORY = "rounds";
const ROUND_SUMMARY_FILENAME = "summary.json";
const LANES_DIRECTORY = "lanes";
const LANE_METADATA_FILENAME = "meta.json";

const CYCLE_FILE_HEADER =
	"# This file is host-machine review state, not part of any git checkout.\n" +
	"# It freezes this cycle's subject, initial round limit, and reviewer route snapshot.\n" +
	"# Arbitration extensions are append-only journal records; never edit this file in place.\n";

export type ReviewStoreErrorCode =
	| "NOT_FOUND"
	| "ALREADY_EXISTS"
	| "CORRUPT"
	| "INVALID_DATA"
	| "READ_FAILED"
	| "WRITE_FAILED";

export class ReviewStoreError extends Error {
	readonly code: ReviewStoreErrorCode;
	readonly cycleId?: string;
	readonly file?: string;
	readonly line?: number;

	constructor(
		code: ReviewStoreErrorCode,
		reason: string,
		details: { cycleId?: string; file?: string; line?: number; cause?: unknown } = {},
	) {
		super(reason, details.cause !== undefined ? { cause: details.cause } : undefined);
		this.name = "ReviewStoreError";
		this.code = code;
		this.cycleId = details.cycleId;
		this.file = details.file;
		this.line = details.line;
	}
}

export interface CreateReviewCycleInput {
	readonly subject: ReviewSubject;
	readonly target_repo: ReviewCycle["target_repo"];
	readonly subject_markdown: string;
	readonly authoring_vendors: readonly string[];
	readonly max_rounds: number;
	readonly lane_snapshot: ReviewCycle["lane_snapshot"];
	readonly degraded: boolean;
}

export interface CreateReviewCycleDependencies {
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
	randomUUID?: () => string;
	/** Crash seam after every unpublished file is durable but before directory rename publishes the cycle. */
	beforePublish?: (temporaryCycleDirectory: string) => void | Promise<void>;
}

export interface AppendReviewJournalDependencies {
	/** Test seam; production writes the remaining Buffer slice and returns bytesWritten. */
	write?: (handle: FileHandle, buffer: Buffer, offset: number) => Promise<number>;
	/** Test seam; production uses FileHandle.sync and treats a failure as WRITE_FAILED. */
	sync?: (handle: FileHandle) => Promise<void>;
}

export interface LoadedReviewRound {
	readonly summary: Round;
	readonly lanes: Lane[];
}

export interface LoadedReviewCycle {
	readonly cycle: ReviewCycle;
	readonly subject: string;
	readonly journal: ReviewJournalEvent[];
	readonly state: ReviewCycleState;
	readonly rounds: LoadedReviewRound[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isMissingPathError(error: unknown): boolean {
	return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
}

function describeZodError(error: z.ZodError): string {
	const issue = error.issues[0];
	const location = issue && issue.path.length > 0 ? `$.${issue.path.join(".")}` : "$";
	return `${location}: ${issue?.message ?? "invalid data"}`;
}

export function reviewCyclesDirectory(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(resolveConfigDir(env), REVIEW_DIRECTORY, CYCLES_DIRECTORY);
}

export function reviewCycleDirectory(cycleId: string, env: NodeJS.ProcessEnv = process.env): string {
	const parsed = reviewCycleIdSchema.safeParse(cycleId);
	if (!parsed.success) {
		throw new ReviewStoreError("INVALID_DATA", `invalid cycle id: ${describeZodError(parsed.error)}`, { cycleId });
	}
	return path.join(reviewCyclesDirectory(env), cycleId);
}

function makeCycleId(now: Date, entropy: string): string {
	const stamp = now.toISOString().replace(/[-:.]/g, "").toLowerCase();
	const suffix = entropy
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(0, 12);
	return `rc-${stamp}-${suffix}`;
}

async function atomicWriteFile(filePath: string, content: string, entropy: () => string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.tmp-${process.pid}-${entropy()}`;
	let handle: FileHandle | undefined;
	try {
		handle = await open(temporaryPath, "wx");
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, filePath);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

function parseYamlFile(content: string, file: string): unknown {
	const document = parseDocument(content, { prettyErrors: false, uniqueKeys: true });
	if (document.errors.length > 0) {
		throw new ReviewStoreError("CORRUPT", `${file}: invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`, {
			file,
		});
	}
	try {
		return document.toJS();
	} catch (error) {
		throw new ReviewStoreError(
			"CORRUPT",
			`${file}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
			{ file, cause: error },
		);
	}
}

function parseCycle(content: string, file: string, cycleId: string): ReviewCycle {
	const parsed = reviewCycleSchema.safeParse(parseYamlFile(content, file));
	if (!parsed.success) {
		throw new ReviewStoreError("CORRUPT", `${file}: ${describeZodError(parsed.error)}`, { cycleId, file });
	}
	if (parsed.data.id !== cycleId) {
		throw new ReviewStoreError("CORRUPT", `${file}: cycle id ${parsed.data.id} does not match directory ${cycleId}`, {
			cycleId,
			file,
		});
	}
	return parsed.data;
}

function parseJournal(content: string, file: string, cycleId: string): ReviewJournalEvent[] {
	const lines = content.split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	const events: ReviewJournalEvent[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const lineNumber = index + 1;
		const line = lines[index];
		let value: unknown;
		try {
			value = JSON.parse(line ?? "");
		} catch (error) {
			throw new ReviewStoreError("CORRUPT", `${file}:${lineNumber}: invalid journal JSON`, {
				cycleId,
				file,
				line: lineNumber,
				cause: error,
			});
		}
		const parsed = journalEventSchema.safeParse(value);
		if (!parsed.success) {
			throw new ReviewStoreError("CORRUPT", `${file}:${lineNumber}: ${describeZodError(parsed.error)}`, {
				cycleId,
				file,
				line: lineNumber,
			});
		}
		if (parsed.data.cycle_id !== cycleId) {
			throw new ReviewStoreError(
				"CORRUPT",
				`${file}:${lineNumber}: event cycle_id does not match directory ${cycleId}`,
				{ cycleId, file, line: lineNumber },
			);
		}
		events.push(parsed.data);
	}
	return events;
}

async function readRequiredFile(file: string, cycleId: string): Promise<string> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (isMissingPathError(error)) {
			throw new ReviewStoreError("CORRUPT", `${file}: required review file is missing`, {
				cycleId,
				file,
				cause: error,
			});
		}
		throw new ReviewStoreError(
			"READ_FAILED",
			`failed to read ${file}: ${error instanceof Error ? error.message : String(error)}`,
			{ cycleId, file, cause: error },
		);
	}
}

function parseJson<T>(content: string, file: string, cycleId: string, schema: z.ZodType<T>): T {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		throw new ReviewStoreError("CORRUPT", `${file}: invalid JSON`, { cycleId, file, cause: error });
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new ReviewStoreError("CORRUPT", `${file}: ${describeZodError(parsed.error)}`, { cycleId, file });
	}
	return parsed.data;
}

async function readDirectory(directory: string, cycleId: string, missingMessage: string): Promise<Dirent<string>[]> {
	try {
		return await readdir(directory, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		if (isMissingPathError(error)) {
			throw new ReviewStoreError("CORRUPT", `${directory}: ${missingMessage}`, {
				cycleId,
				file: directory,
				cause: error,
			});
		}
		throw new ReviewStoreError("READ_FAILED", `failed to read ${directory}`, {
			cycleId,
			file: directory,
			cause: error,
		});
	}
}

async function loadLanes(roundDirectory: string, cycle: ReviewCycle, roundNumber: number): Promise<Lane[]> {
	const lanesDirectory = path.join(roundDirectory, LANES_DIRECTORY);
	const entries = await readDirectory(lanesDirectory, cycle.id, "lanes directory is missing");
	const lanes: Lane[] = [];
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name, undefined, { numeric: true }),
	)) {
		if (!entry.isDirectory() || !laneIdSchema.safeParse(entry.name).success) {
			if (entry.name.startsWith(".tmp-")) {
				continue;
			}
			throw new ReviewStoreError("CORRUPT", `${lanesDirectory}: unexpected entry ${entry.name}`, {
				cycleId: cycle.id,
				file: lanesDirectory,
			});
		}
		const metadataFile = path.join(lanesDirectory, entry.name, LANE_METADATA_FILENAME);
		const lane = parseJson(await readRequiredFile(metadataFile, cycle.id), metadataFile, cycle.id, laneSchema);
		if (lane.id !== entry.name || lane.cycle_id !== cycle.id || lane.round !== roundNumber) {
			throw new ReviewStoreError("CORRUPT", `${metadataFile}: lane identity does not match its directory`, {
				cycleId: cycle.id,
				file: metadataFile,
			});
		}
		const route = cycle.lane_snapshot.find((candidate) => candidate.id === lane.id);
		if (
			!route ||
			route.cli !== lane.cli ||
			route.vendor !== lane.vendor ||
			route.command !== lane.command ||
			route.required !== lane.required
		) {
			throw new ReviewStoreError("CORRUPT", `${metadataFile}: lane does not match the frozen route snapshot`, {
				cycleId: cycle.id,
				file: metadataFile,
			});
		}
		lanes.push(lane);
	}
	return lanes;
}

async function loadRounds(cycleDirectory: string, cycle: ReviewCycle): Promise<LoadedReviewRound[]> {
	const roundsDirectory = path.join(cycleDirectory, ROUNDS_DIRECTORY);
	const entries = await readDirectory(roundsDirectory, cycle.id, "rounds directory is missing");
	const rounds: LoadedReviewRound[] = [];
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name, undefined, { numeric: true }),
	)) {
		if (!entry.isDirectory() || !roundIdSchema.safeParse(entry.name).success) {
			if (entry.name.startsWith(".tmp-")) {
				continue;
			}
			throw new ReviewStoreError("CORRUPT", `${roundsDirectory}: unexpected entry ${entry.name}`, {
				cycleId: cycle.id,
				file: roundsDirectory,
			});
		}
		const number = Number.parseInt(entry.name.slice(1), 10);
		if (number !== rounds.length + 1) {
			throw new ReviewStoreError("CORRUPT", `${roundsDirectory}: rounds must be contiguous from R1`, {
				cycleId: cycle.id,
				file: roundsDirectory,
			});
		}
		const roundDirectory = path.join(roundsDirectory, entry.name);
		const summaryFile = path.join(roundDirectory, ROUND_SUMMARY_FILENAME);
		const summary = parseJson(await readRequiredFile(summaryFile, cycle.id), summaryFile, cycle.id, roundSchema);
		if (summary.id !== entry.name || summary.cycle_id !== cycle.id || summary.number !== number) {
			throw new ReviewStoreError("CORRUPT", `${summaryFile}: round identity does not match its directory`, {
				cycleId: cycle.id,
				file: summaryFile,
			});
		}
		const lanes = await loadLanes(roundDirectory, cycle, number);
		const loadedLaneIds = lanes.map((lane) => lane.id).sort();
		const summaryLaneIds = [...summary.lane_ids].sort();
		const missingRequiredRoute = cycle.lane_snapshot.find(
			(route) => route.required && !loadedLaneIds.includes(route.id),
		);
		if (missingRequiredRoute) {
			throw new ReviewStoreError(
				"CORRUPT",
				`${summaryFile}: required frozen route ${missingRequiredRoute.id} is missing from the round`,
				{ cycleId: cycle.id, file: summaryFile },
			);
		}
		if (JSON.stringify(loadedLaneIds) !== JSON.stringify(summaryLaneIds)) {
			throw new ReviewStoreError("CORRUPT", `${summaryFile}: lane_ids do not match lane metadata directories`, {
				cycleId: cycle.id,
				file: summaryFile,
			});
		}
		for (const result of summary.lane_results) {
			const lane = lanes.find((candidate) => candidate.id === result.lane_id);
			if (
				!lane ||
				lane.required !== result.required ||
				lane.status !== "CONCLUDED" ||
				lane.outcome !== result.outcome
			) {
				throw new ReviewStoreError("CORRUPT", `${summaryFile}: lane_results do not match concluded lane metadata`, {
					cycleId: cycle.id,
					file: summaryFile,
				});
			}
		}
		if (
			lanes.some(
				(lane) => lane.status === "CONCLUDED" && !summary.lane_results.some((result) => result.lane_id === lane.id),
			)
		) {
			throw new ReviewStoreError("CORRUPT", `${summaryFile}: concluded lane metadata is missing from lane_results`, {
				cycleId: cycle.id,
				file: summaryFile,
			});
		}
		rounds.push({ summary, lanes });
	}
	return rounds;
}

export async function createCycle(
	input: CreateReviewCycleInput,
	dependencies: CreateReviewCycleDependencies = {},
): Promise<LoadedReviewCycle> {
	const env = dependencies.env ?? process.env;
	const now = dependencies.now ?? (() => new Date());
	const entropy = dependencies.randomUUID ?? randomUUID;
	let createdAt: string;
	let id: string;
	try {
		const instant = now();
		createdAt = instant.toISOString();
		id = makeCycleId(new Date(createdAt), entropy());
	} catch (error) {
		throw new ReviewStoreError("INVALID_DATA", "invalid review cycle clock or random source", { cause: error });
	}
	const cycleCandidate = {
		apiVersion: "gatekeeper/v1" as const,
		id,
		subject: input.subject,
		target_repo: input.target_repo,
		authoring_vendors: [...input.authoring_vendors],
		max_rounds: input.max_rounds,
		lane_snapshot: input.lane_snapshot,
		degraded: input.degraded,
		created_at: createdAt,
	};
	const parsedCycle = reviewCycleSchema.safeParse(cycleCandidate);
	if (!parsedCycle.success) {
		throw new ReviewStoreError("INVALID_DATA", describeZodError(parsedCycle.error));
	}
	if (input.subject_markdown.length === 0) {
		throw new ReviewStoreError("INVALID_DATA", "subject_markdown must not be empty");
	}
	const createdEvent: ReviewJournalEvent = {
		apiVersion: "gatekeeper/v1",
		type: "CYCLE_CREATED",
		cycle_id: id,
		at: createdAt,
		to: "PENDING",
	};

	const cyclesDirectory = reviewCyclesDirectory(env);
	const finalDirectory = path.join(cyclesDirectory, id);
	const temporaryDirectory = path.join(cyclesDirectory, `.tmp-${id}-${entropy()}`);
	try {
		await mkdir(cyclesDirectory, { recursive: true });
	} catch (error) {
		throw new ReviewStoreError("WRITE_FAILED", `failed to create ${cyclesDirectory}`, { cycleId: id, cause: error });
	}

	const createLockPath = path.join(cyclesDirectory, `.create-${id}.lock`);
	try {
		await withFileLock(createLockPath, async () => {
			try {
				await lstat(finalDirectory);
				throw new ReviewStoreError("ALREADY_EXISTS", `review cycle ${id} already exists`, { cycleId: id });
			} catch (error) {
				if (error instanceof ReviewStoreError) {
					throw error;
				}
				if (!isMissingPathError(error)) {
					throw new ReviewStoreError("READ_FAILED", `failed to inspect ${finalDirectory}`, {
						cycleId: id,
						file: finalDirectory,
						cause: error,
					});
				}
			}

			let stagingCreated = false;
			let publishing = false;
			try {
				await mkdir(temporaryDirectory);
				stagingCreated = true;
				await mkdir(path.join(temporaryDirectory, ROUNDS_DIRECTORY));
				await atomicWriteFile(
					path.join(temporaryDirectory, CYCLE_FILENAME),
					`${CYCLE_FILE_HEADER}${stringify(parsedCycle.data)}`,
					entropy,
				);
				await atomicWriteFile(path.join(temporaryDirectory, SUBJECT_FILENAME), input.subject_markdown, entropy);
				await atomicWriteFile(
					path.join(temporaryDirectory, JOURNAL_FILENAME),
					`${JSON.stringify(createdEvent)}\n`,
					entropy,
				);
				await dependencies.beforePublish?.(temporaryDirectory);
				publishing = true;
				await rename(temporaryDirectory, finalDirectory);
				stagingCreated = false;
			} catch (error) {
				if (stagingCreated) {
					await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
				}
				if (publishing && (errorCode(error) === "EEXIST" || errorCode(error) === "ENOTEMPTY")) {
					throw new ReviewStoreError("ALREADY_EXISTS", `review cycle ${id} already exists`, {
						cycleId: id,
						cause: error,
					});
				}
				throw error;
			}
		});
	} catch (error) {
		if (error instanceof ReviewStoreError) {
			throw error;
		}
		throw new ReviewStoreError(
			"WRITE_FAILED",
			`failed to create review cycle ${id}: ${error instanceof Error ? error.message : String(error)}`,
			{ cycleId: id, cause: error },
		);
	}

	return {
		cycle: parsedCycle.data,
		subject: input.subject_markdown,
		journal: [createdEvent],
		state: "PENDING",
		rounds: [],
	};
}

export async function loadCycle(cycleId: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadedReviewCycle> {
	const cycleDirectory = reviewCycleDirectory(cycleId, env);
	let entries: Dirent<string>[];
	try {
		entries = await readdir(cycleDirectory, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		if (isMissingPathError(error)) {
			throw new ReviewStoreError("NOT_FOUND", `review cycle ${cycleId} does not exist`, { cycleId, cause: error });
		}
		throw new ReviewStoreError("READ_FAILED", `failed to read review cycle directory ${cycleDirectory}`, {
			cycleId,
			file: cycleDirectory,
			cause: error,
		});
	}
	if (entries.length === 0) {
		throw new ReviewStoreError("CORRUPT", `${cycleDirectory}: empty review cycle directory`, {
			cycleId,
			file: cycleDirectory,
		});
	}

	const cycleFile = path.join(cycleDirectory, CYCLE_FILENAME);
	const journalFile = path.join(cycleDirectory, JOURNAL_FILENAME);
	const cycle = parseCycle(await readRequiredFile(cycleFile, cycleId), cycleFile, cycleId);
	const subject = await readRequiredFile(path.join(cycleDirectory, SUBJECT_FILENAME), cycleId);
	let journalState: { journal: ReviewJournalEvent[]; state: ReviewCycleState };
	try {
		journalState = await withFileLock(`${journalFile}.lock`, async () => {
			const journal = parseJournal(await readRequiredFile(journalFile, cycleId), journalFile, cycleId);
			try {
				return { journal, state: foldJournal(journal, cycle.max_rounds) };
			} catch (error) {
				throw new ReviewStoreError(
					"CORRUPT",
					`${journalFile}: invalid state history: ${error instanceof Error ? error.message : String(error)}`,
					{ cycleId, file: journalFile, cause: error },
				);
			}
		});
	} catch (error) {
		if (error instanceof ReviewStoreError) {
			throw error;
		}
		throw new ReviewStoreError("READ_FAILED", `failed to lock ${journalFile} for reading`, {
			cycleId,
			file: journalFile,
			cause: error,
		});
	}
	const rounds = await loadRounds(cycleDirectory, cycle);
	return { cycle, subject, journal: journalState.journal, state: journalState.state, rounds };
}

export async function listCycles(env: NodeJS.ProcessEnv = process.env): Promise<LoadedReviewCycle[]> {
	const cyclesDirectory = reviewCyclesDirectory(env);
	let entries: Dirent<string>[];
	try {
		entries = await readdir(cyclesDirectory, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		if (isMissingPathError(error)) {
			return [];
		}
		throw new ReviewStoreError("READ_FAILED", `failed to list ${cyclesDirectory}`, {
			file: cyclesDirectory,
			cause: error,
		});
	}
	const ids = entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".tmp-"))
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
	return Promise.all(ids.map((id) => loadCycle(id, env)));
}

/**
 * Append-only journal write. The same-journal lock excludes cooperating
 * readers/writers while the existing history is parsed and completely
 * folded against cycle.yaml's frozen round limit before any new bytes are
 * written. A torn line is never skipped: the next read reports CORRUPT.
 */
export async function appendJournalEvent(
	cycleId: string,
	event: ReviewJournalEvent,
	env: NodeJS.ProcessEnv = process.env,
	dependencies: AppendReviewJournalDependencies = {},
): Promise<void> {
	const parsed = journalEventSchema.safeParse(event);
	if (!parsed.success) {
		throw new ReviewStoreError("INVALID_DATA", describeZodError(parsed.error), { cycleId });
	}
	if (parsed.data.cycle_id !== cycleId) {
		throw new ReviewStoreError("INVALID_DATA", `event cycle_id does not match ${cycleId}`, { cycleId });
	}
	const cycleDirectory = reviewCycleDirectory(cycleId, env);
	try {
		if (!(await stat(cycleDirectory)).isDirectory()) {
			throw new Error("not a directory");
		}
	} catch (error) {
		if (isMissingPathError(error)) {
			throw new ReviewStoreError("NOT_FOUND", `review cycle ${cycleId} does not exist`, {
				cycleId,
				file: cycleDirectory,
				cause: error,
			});
		}
		throw new ReviewStoreError("READ_FAILED", `failed to inspect ${cycleDirectory}`, {
			cycleId,
			file: cycleDirectory,
			cause: error,
		});
	}
	const cycleFile = path.join(cycleDirectory, CYCLE_FILENAME);
	const journalFile = path.join(cycleDirectory, JOURNAL_FILENAME);
	try {
		await withFileLock(`${journalFile}.lock`, async () => {
			const cycle = parseCycle(await readRequiredFile(cycleFile, cycleId), cycleFile, cycleId);
			const existing = parseJournal(await readRequiredFile(journalFile, cycleId), journalFile, cycleId);
			try {
				foldJournal([...existing, parsed.data], cycle.max_rounds);
			} catch (error) {
				throw new ReviewStoreError(
					"INVALID_DATA",
					`event would create an invalid state history: ${error instanceof Error ? error.message : String(error)}`,
					{ cycleId, file: journalFile, cause: error },
				);
			}

			let handle: FileHandle | undefined;
			try {
				handle = await open(journalFile, "a");
				const buffer = Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8");
				const write =
					dependencies.write ??
					(async (fileHandle: FileHandle, bytes: Buffer, offset: number) => {
						const result = await fileHandle.write(bytes, offset, bytes.length - offset, null);
						return result.bytesWritten;
					});
				let offset = 0;
				while (offset < buffer.length) {
					const bytesWritten = await write(handle, buffer, offset);
					if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buffer.length - offset) {
						throw new Error(`invalid journal bytesWritten ${bytesWritten}`);
					}
					offset += bytesWritten;
				}
				await (dependencies.sync ? dependencies.sync(handle) : handle.sync());
			} catch (error) {
				throw new ReviewStoreError(
					"WRITE_FAILED",
					`failed to append ${journalFile}: ${error instanceof Error ? error.message : String(error)}`,
					{ cycleId, file: journalFile, cause: error },
				);
			} finally {
				await handle?.close().catch(() => undefined);
			}
		});
	} catch (error) {
		if (error instanceof ReviewStoreError) {
			throw error;
		}
		throw new ReviewStoreError("WRITE_FAILED", `failed to lock ${journalFile} for append`, {
			cycleId,
			file: journalFile,
			cause: error,
		});
	}
}
