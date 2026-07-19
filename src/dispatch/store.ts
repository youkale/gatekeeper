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
	type JournalEvent,
	journalEventSchema,
	type OrderState,
	orderIdSchema,
	type Run,
	runIdSchema,
	runSchema,
	type WorkOrder,
	workOrderSchema,
} from "./types.js";

const DISPATCH_DIRECTORY = "dispatch";
const ORDERS_DIRECTORY = "orders";
const ORDER_FILENAME = "order.yaml";
const JOURNAL_FILENAME = "journal.jsonl";
const BRIEF_FILENAME = "brief.md";
const RUNS_DIRECTORY = "runs";

const ORDER_FILE_HEADER =
	"# This file is host-machine dispatch state, not part of any git checkout.\n" +
	"# It contains local checkout paths and execution metadata for this machine.\n" +
	"# Delete the whole order directory only when intentionally discarding its audit history.\n";

export type DispatchStoreErrorCode =
	| "NOT_FOUND"
	| "ALREADY_EXISTS"
	| "CORRUPT"
	| "INVALID_DATA"
	| "READ_FAILED"
	| "WRITE_FAILED";

export class DispatchStoreError extends Error {
	readonly code: DispatchStoreErrorCode;
	readonly orderId?: string;
	readonly file?: string;
	readonly line?: number;

	constructor(
		code: DispatchStoreErrorCode,
		reason: string,
		details: { orderId?: string; file?: string; line?: number; cause?: unknown } = {},
	) {
		super(reason, details.cause !== undefined ? { cause: details.cause } : undefined);
		this.name = "DispatchStoreError";
		this.code = code;
		this.orderId = details.orderId;
		this.file = details.file;
		this.line = details.line;
	}
}

export interface CreateWorkOrderInput {
	association_key: string;
	target_repo: WorkOrder["target_repo"];
	brief: string;
	acceptance_contract: WorkOrder["acceptance_contract"];
	candidate_ladder: WorkOrder["candidate_ladder"];
}

export interface CreateWorkOrderDependencies {
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
	randomUUID?: () => string;
	/** Test seam for a crash after every unpublished file is durable but before the directory rename publishes the order. */
	beforePublish?: (temporaryOrderDirectory: string) => void | Promise<void>;
}

export interface LoadedWorkOrder {
	order: WorkOrder;
	/** Canonical original WorkOrder brief read from the order's immutable brief.md. */
	brief: string;
	journal: JournalEvent[];
	state: OrderState;
	runs: Run[];
}

export interface AppendJournalDependencies {
	/** Test seam; production writes the remaining Buffer slice and returns bytesWritten. */
	write?: (handle: FileHandle, buffer: Buffer, offset: number) => Promise<number>;
	/** Test seam; production uses FileHandle.sync and treats a failure as WRITE_FAILED. */
	sync?: (handle: FileHandle) => Promise<void>;
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

export function dispatchOrdersDirectory(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(resolveConfigDir(env), DISPATCH_DIRECTORY, ORDERS_DIRECTORY);
}

export function dispatchOrderDirectory(orderId: string, env: NodeJS.ProcessEnv = process.env): string {
	const parsed = orderIdSchema.safeParse(orderId);
	if (!parsed.success) {
		throw new DispatchStoreError("INVALID_DATA", `invalid order id: ${describeZodError(parsed.error)}`, { orderId });
	}
	return path.join(dispatchOrdersDirectory(env), orderId);
}

function makeOrderId(now: Date, entropy: string): string {
	const stamp = now.toISOString().replace(/[-:.]/g, "").toLowerCase();
	const suffix = entropy
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(0, 12);
	return `wo-${stamp}-${suffix}`;
}

async function atomicWriteFile(filePath: string, content: string, entropy: () => string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.tmp-${process.pid}-${entropy()}`;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
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
		throw new DispatchStoreError(
			"CORRUPT",
			`${file}: invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`,
			{
				file,
			},
		);
	}
	try {
		return document.toJS();
	} catch (error) {
		throw new DispatchStoreError(
			"CORRUPT",
			`${file}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
			{ file, cause: error },
		);
	}
}

function parseOrder(content: string, file: string, orderId: string): WorkOrder {
	const parsed = workOrderSchema.safeParse(parseYamlFile(content, file));
	if (!parsed.success) {
		throw new DispatchStoreError("CORRUPT", `${file}: ${describeZodError(parsed.error)}`, { orderId, file });
	}
	if (parsed.data.id !== orderId) {
		throw new DispatchStoreError("CORRUPT", `${file}: order id ${parsed.data.id} does not match directory ${orderId}`, {
			orderId,
			file,
		});
	}
	return parsed.data;
}

function parseJournal(content: string, file: string, orderId: string): JournalEvent[] {
	const lines = content.split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	const events: JournalEvent[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const lineNumber = index + 1;
		const line = lines[index];
		let value: unknown;
		try {
			value = JSON.parse(line ?? "");
		} catch (error) {
			throw new DispatchStoreError("CORRUPT", `${file}:${lineNumber}: invalid journal JSON`, {
				orderId,
				file,
				line: lineNumber,
				cause: error,
			});
		}
		const parsed = journalEventSchema.safeParse(value);
		if (!parsed.success) {
			throw new DispatchStoreError("CORRUPT", `${file}:${lineNumber}: ${describeZodError(parsed.error)}`, {
				orderId,
				file,
				line: lineNumber,
			});
		}
		if (parsed.data.order_id !== orderId) {
			throw new DispatchStoreError(
				"CORRUPT",
				`${file}:${lineNumber}: event order_id does not match directory ${orderId}`,
				{
					orderId,
					file,
					line: lineNumber,
				},
			);
		}
		events.push(parsed.data);
	}
	return events;
}

async function readRequiredFile(file: string, orderId: string): Promise<string> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (isMissingPathError(error)) {
			throw new DispatchStoreError("CORRUPT", `${file}: required order file is missing`, {
				orderId,
				file,
				cause: error,
			});
		}
		throw new DispatchStoreError(
			"READ_FAILED",
			`failed to read ${file}: ${error instanceof Error ? error.message : String(error)}`,
			{ orderId, file, cause: error },
		);
	}
}

async function loadRuns(orderDirectory: string, orderId: string): Promise<Run[]> {
	const runsDirectory = path.join(orderDirectory, RUNS_DIRECTORY);
	let entries: Dirent<string>[];
	try {
		entries = await readdir(runsDirectory, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		if (isMissingPathError(error)) {
			throw new DispatchStoreError("CORRUPT", `${runsDirectory}: runs directory is missing`, {
				orderId,
				file: runsDirectory,
				cause: error,
			});
		}
		throw new DispatchStoreError("READ_FAILED", `failed to read ${runsDirectory}`, {
			orderId,
			file: runsDirectory,
			cause: error,
		});
	}

	const runs: Run[] = [];
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name, undefined, { numeric: true }),
	)) {
		if (!entry.isDirectory() || !runIdSchema.safeParse(entry.name).success) {
			if (entry.name.startsWith(".tmp-")) {
				continue;
			}
			throw new DispatchStoreError("CORRUPT", `${runsDirectory}: unexpected entry ${entry.name}`, {
				orderId,
				file: runsDirectory,
			});
		}
		const metaFile = path.join(runsDirectory, entry.name, "meta.json");
		const content = await readRequiredFile(metaFile, orderId);
		let value: unknown;
		try {
			value = JSON.parse(content);
		} catch (error) {
			throw new DispatchStoreError("CORRUPT", `${metaFile}: invalid JSON`, {
				orderId,
				file: metaFile,
				cause: error,
			});
		}
		const parsed = runSchema.safeParse(value);
		if (!parsed.success) {
			throw new DispatchStoreError("CORRUPT", `${metaFile}: ${describeZodError(parsed.error)}`, {
				orderId,
				file: metaFile,
			});
		}
		if (parsed.data.id !== entry.name) {
			throw new DispatchStoreError("CORRUPT", `${metaFile}: run id does not match directory ${entry.name}`, {
				orderId,
				file: metaFile,
			});
		}
		runs.push(parsed.data);
	}
	return runs;
}

export async function createOrder(
	input: CreateWorkOrderInput,
	dependencies: CreateWorkOrderDependencies = {},
): Promise<LoadedWorkOrder> {
	const env = dependencies.env ?? process.env;
	const now = dependencies.now ?? (() => new Date());
	const entropy = dependencies.randomUUID ?? randomUUID;
	const createdAt = now().toISOString();
	const id = makeOrderId(new Date(createdAt), entropy());
	const order: WorkOrder = {
		apiVersion: "gatekeeper/v1",
		id,
		association_key: input.association_key,
		target_repo: input.target_repo,
		role: "coder",
		brief_path: BRIEF_FILENAME,
		acceptance_contract: input.acceptance_contract,
		candidate_ladder: input.candidate_ladder,
		authoring_vendors: [],
		created_at: createdAt,
	};
	const parsedOrder = workOrderSchema.safeParse(order);
	if (!parsedOrder.success) {
		throw new DispatchStoreError("INVALID_DATA", describeZodError(parsedOrder.error));
	}
	const createdEvent: JournalEvent = {
		apiVersion: "gatekeeper/v1",
		type: "ORDER_CREATED",
		order_id: id,
		at: createdAt,
		to: "PENDING",
	};

	const ordersDirectory = dispatchOrdersDirectory(env);
	const finalDirectory = path.join(ordersDirectory, id);
	const temporaryDirectory = path.join(ordersDirectory, `.tmp-${id}-${entropy()}`);
	try {
		await mkdir(ordersDirectory, { recursive: true });
	} catch (error) {
		throw new DispatchStoreError("WRITE_FAILED", `failed to create ${ordersDirectory}`, { orderId: id, cause: error });
	}

	const createLockPath = path.join(ordersDirectory, `.create-${id}.lock`);
	try {
		await withFileLock(createLockPath, async () => {
			try {
				await lstat(finalDirectory);
				throw new DispatchStoreError("ALREADY_EXISTS", `order ${id} already exists`, { orderId: id });
			} catch (error) {
				if (error instanceof DispatchStoreError) {
					throw error;
				}
				if (!isMissingPathError(error)) {
					throw new DispatchStoreError("READ_FAILED", `failed to inspect ${finalDirectory}`, {
						orderId: id,
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
				await mkdir(path.join(temporaryDirectory, RUNS_DIRECTORY));
				await atomicWriteFile(
					path.join(temporaryDirectory, ORDER_FILENAME),
					`${ORDER_FILE_HEADER}${stringify(parsedOrder.data)}`,
					entropy,
				);
				await atomicWriteFile(path.join(temporaryDirectory, BRIEF_FILENAME), input.brief, entropy);
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
					throw new DispatchStoreError("ALREADY_EXISTS", `order ${id} already exists`, {
						orderId: id,
						cause: error,
					});
				}
				throw error;
			}
		});
	} catch (error) {
		if (error instanceof DispatchStoreError) {
			throw error;
		}
		throw new DispatchStoreError(
			"WRITE_FAILED",
			`failed to create order ${id}: ${error instanceof Error ? error.message : String(error)}`,
			{ orderId: id, cause: error },
		);
	}

	return { order: parsedOrder.data, brief: input.brief, journal: [createdEvent], state: "PENDING", runs: [] };
}

export async function loadOrder(orderId: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadedWorkOrder> {
	const orderDirectory = dispatchOrderDirectory(orderId, env);
	let entries: Dirent<string>[];
	try {
		entries = await readdir(orderDirectory, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		if (isMissingPathError(error)) {
			throw new DispatchStoreError("NOT_FOUND", `order ${orderId} does not exist`, { orderId, cause: error });
		}
		throw new DispatchStoreError("READ_FAILED", `failed to read order directory ${orderDirectory}`, {
			orderId,
			file: orderDirectory,
			cause: error,
		});
	}
	if (entries.length === 0) {
		throw new DispatchStoreError("CORRUPT", `${orderDirectory}: empty order directory`, {
			orderId,
			file: orderDirectory,
		});
	}

	const orderFile = path.join(orderDirectory, ORDER_FILENAME);
	const journalFile = path.join(orderDirectory, JOURNAL_FILENAME);
	const order = parseOrder(await readRequiredFile(orderFile, orderId), orderFile, orderId);
	const brief = await readRequiredFile(path.join(orderDirectory, BRIEF_FILENAME), orderId);
	let journalState: { journal: JournalEvent[]; state: OrderState };
	try {
		journalState = await withFileLock(`${journalFile}.lock`, async () => {
			const journal = parseJournal(await readRequiredFile(journalFile, orderId), journalFile, orderId);
			try {
				return { journal, state: foldJournal(journal) };
			} catch (error) {
				throw new DispatchStoreError(
					"CORRUPT",
					`${journalFile}: invalid state history: ${error instanceof Error ? error.message : String(error)}`,
					{ orderId, file: journalFile, cause: error },
				);
			}
		});
	} catch (error) {
		if (error instanceof DispatchStoreError) {
			throw error;
		}
		throw new DispatchStoreError("READ_FAILED", `failed to lock ${journalFile} for reading`, {
			orderId,
			file: journalFile,
			cause: error,
		});
	}
	const runs = await loadRuns(orderDirectory, orderId);
	return { order, brief, journal: journalState.journal, state: journalState.state, runs };
}

export async function listOrders(env: NodeJS.ProcessEnv = process.env): Promise<LoadedWorkOrder[]> {
	const ordersDirectory = dispatchOrdersDirectory(env);
	let entries: Dirent<string>[];
	try {
		entries = await readdir(ordersDirectory, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		if (isMissingPathError(error)) {
			return [];
		}
		throw new DispatchStoreError("READ_FAILED", `failed to list ${ordersDirectory}`, {
			file: ordersDirectory,
			cause: error,
		});
	}
	const ids = entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".tmp-"))
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
	return Promise.all(ids.map((id) => loadOrder(id, env)));
}

/**
 * JSONL is intentionally append-only rather than rename-replaced. A
 * same-journal lock excludes cooperating readers/writers while the complete
 * UTF-8 Buffer is written (including short-write retries); sync() must
 * succeed before success is reported. A crash that still tears a line is
 * fail-loud on the next load as a structured CORRUPT error.
 */
export async function appendJournalEvent(
	orderId: string,
	event: JournalEvent,
	env: NodeJS.ProcessEnv = process.env,
	dependencies: AppendJournalDependencies = {},
): Promise<void> {
	const parsed = journalEventSchema.safeParse(event);
	if (!parsed.success) {
		throw new DispatchStoreError("INVALID_DATA", describeZodError(parsed.error), { orderId });
	}
	if (parsed.data.order_id !== orderId) {
		throw new DispatchStoreError("INVALID_DATA", `event order_id does not match ${orderId}`, { orderId });
	}
	const orderDirectory = dispatchOrderDirectory(orderId, env);
	try {
		if (!(await stat(orderDirectory)).isDirectory()) {
			throw new Error("not a directory");
		}
	} catch (error) {
		if (isMissingPathError(error)) {
			throw new DispatchStoreError("NOT_FOUND", `order ${orderId} does not exist`, {
				orderId,
				file: orderDirectory,
				cause: error,
			});
		}
		throw new DispatchStoreError("READ_FAILED", `failed to inspect ${orderDirectory}`, {
			orderId,
			file: orderDirectory,
			cause: error,
		});
	}
	const journalFile = path.join(orderDirectory, JOURNAL_FILENAME);
	try {
		await withFileLock(`${journalFile}.lock`, async () => {
			const existing = parseJournal(await readRequiredFile(journalFile, orderId), journalFile, orderId);
			try {
				foldJournal([...existing, parsed.data]);
			} catch (error) {
				throw new DispatchStoreError(
					"INVALID_DATA",
					`event would create an invalid state history: ${error instanceof Error ? error.message : String(error)}`,
					{ orderId, file: journalFile, cause: error },
				);
			}

			let handle: Awaited<ReturnType<typeof open>> | undefined;
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
				throw new DispatchStoreError(
					"WRITE_FAILED",
					`failed to append ${journalFile}: ${error instanceof Error ? error.message : String(error)}`,
					{ orderId, file: journalFile, cause: error },
				);
			} finally {
				await handle?.close().catch(() => undefined);
			}
		});
	} catch (error) {
		if (error instanceof DispatchStoreError) {
			throw error;
		}
		throw new DispatchStoreError("WRITE_FAILED", `failed to lock ${journalFile} for append`, {
			orderId,
			file: journalFile,
			cause: error,
		});
	}
}
