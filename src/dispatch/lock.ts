import { randomUUID } from "node:crypto";
import { type FileHandle, link, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { appendJournalEvent, dispatchOrderDirectory } from "./store.js";
import type { JournalEvent } from "./types.js";

const SUPERVISOR_LOCK_FILENAME = "supervisor.lock";
const CLAIM_RETRY_DELAY_MS = 10;
const CLAIM_MAX_ATTEMPTS = 500;

const supervisorLockRecordSchema = z
	.object({
		pid: z.number().int().positive(),
		started_at: z.string().datetime({ offset: true }),
	})
	.strict();

const claimRecordSchema = supervisorLockRecordSchema
	.extend({
		token: z
			.string()
			.regex(/^[a-z0-9-]+$/)
			.min(1),
	})
	.strict();

export type SupervisorLockRecord = z.infer<typeof supervisorLockRecordSchema>;
type ClaimRecord = z.infer<typeof claimRecordSchema>;

export type DispatchLockErrorCode =
	| "ORDER_NOT_FOUND"
	| "HELD"
	| "CORRUPT"
	| "INVALID_DATA"
	| "NOT_OWNER"
	| "LOCK_IO_FAILED";

export class DispatchLockError extends Error {
	readonly code: DispatchLockErrorCode;
	readonly lockPath: string;
	readonly holder?: SupervisorLockRecord;

	constructor(
		code: DispatchLockErrorCode,
		reason: string,
		lockPath: string,
		details: { holder?: SupervisorLockRecord; cause?: unknown } = {},
	) {
		super(reason, details.cause !== undefined ? { cause: details.cause } : undefined);
		this.name = "DispatchLockError";
		this.code = code;
		this.lockPath = lockPath;
		this.holder = details.holder;
	}
}

export interface SupervisorLockDependencies {
	env?: NodeJS.ProcessEnv;
	pid?: number;
	now?: () => Date;
	randomUUID?: () => string;
	isProcessAlive?: (pid: number) => boolean;
	appendEvent?: (orderId: string, event: JournalEvent, env: NodeJS.ProcessEnv) => Promise<void>;
	/** Test seam; production requires FileHandle.sync before supervisor.lock acquisition succeeds. */
	sync?: (handle: FileHandle) => Promise<void>;
	/** Deterministic concurrency seam called immediately before competing for a stale/released owner's successor. */
	beforeClaim?: (owner: Readonly<ClaimRecord>) => void | Promise<void>;
	claimRetryDelayMs?: number;
}

export interface SupervisorLock {
	readonly orderId: string;
	readonly record: SupervisorLockRecord;
	readonly path: string;
	release(): Promise<void>;
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

function defaultIsProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSupervisorLock(lockPath: string): Promise<SupervisorLockRecord> {
	let content: string;
	try {
		content = await readFile(lockPath, "utf8");
	} catch (error) {
		throw new DispatchLockError("LOCK_IO_FAILED", `failed to read ${lockPath}`, lockPath, { cause: error });
	}
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		throw new DispatchLockError("CORRUPT", `${lockPath}: invalid lock JSON`, lockPath, { cause: error });
	}
	const parsed = supervisorLockRecordSchema.safeParse(value);
	if (!parsed.success) {
		throw new DispatchLockError("CORRUPT", `${lockPath}: invalid supervisor lock record`, lockPath, {
			cause: parsed.error,
		});
	}
	return parsed.data;
}

async function writeNewSupervisorLock(
	lockPath: string,
	record: SupervisorLockRecord,
	sync: (handle: FileHandle) => Promise<void>,
): Promise<void> {
	let handle: FileHandle | undefined;
	let createdIdentity: { dev: bigint; ino: bigint } | undefined;
	try {
		handle = await open(lockPath, "wx");
		const createdStat = await handle.stat({ bigint: true });
		createdIdentity = { dev: createdStat.dev, ino: createdStat.ino };
		await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
		await sync(handle);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		handle = undefined;
		if (createdIdentity) {
			const currentStat = await stat(lockPath, { bigint: true }).catch(() => undefined);
			if (currentStat?.dev === createdIdentity.dev && currentStat.ino === createdIdentity.ino) {
				await rm(lockPath, { force: true }).catch(() => undefined);
			}
		}
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function claimSuccessorPath(guardPath: string, token: string): string {
	return `${guardPath}.claim-${token}`;
}

function claimReleasePath(guardPath: string, token: string): string {
	return `${guardPath}.release-${token}`;
}

async function readClaim(filePath: string, lockPath: string): Promise<ClaimRecord> {
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch (error) {
		throw new DispatchLockError("LOCK_IO_FAILED", `failed to read claim ${filePath}`, lockPath, { cause: error });
	}
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch (error) {
		throw new DispatchLockError("CORRUPT", `${filePath}: invalid claim JSON`, lockPath, { cause: error });
	}
	const parsed = claimRecordSchema.safeParse(value);
	if (!parsed.success) {
		throw new DispatchLockError("CORRUPT", `${filePath}: invalid claim record`, lockPath, { cause: parsed.error });
	}
	return parsed.data;
}

/**
 * Publish a fully-written immutable claim with hard-link CAS. The unique
 * node is written + synced before link(); link to the deterministic target
 * is atomic and exactly one contender can win EEXIST arbitration, while
 * readers can never observe a partial target record.
 */
async function publishClaim(
	targetPath: string,
	record: ClaimRecord,
	guardPath: string,
	lockPath: string,
): Promise<boolean> {
	const nodePath = `${guardPath}.node-${record.token}`;
	let handle: FileHandle | undefined;
	try {
		handle = await open(nodePath, "wx");
		await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		try {
			await link(nodePath, targetPath);
			return true;
		} catch (error) {
			if (errorCode(error) === "EEXIST") {
				return false;
			}
			throw new DispatchLockError("LOCK_IO_FAILED", `failed to publish claim ${targetPath}`, lockPath, {
				cause: error,
			});
		}
	} catch (error) {
		if (error instanceof DispatchLockError) {
			throw error;
		}
		throw new DispatchLockError("LOCK_IO_FAILED", `failed to prepare claim ${targetPath}`, lockPath, { cause: error });
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(nodePath, { force: true }).catch(() => undefined);
	}
}

async function currentClaim(guardPath: string, lockPath: string): Promise<ClaimRecord> {
	let current = await readClaim(guardPath, lockPath);
	const seen = new Set<string>();
	while (true) {
		if (seen.has(current.token)) {
			throw new DispatchLockError("CORRUPT", `${guardPath}: claim chain contains a cycle`, lockPath);
		}
		seen.add(current.token);
		const successorPath = claimSuccessorPath(guardPath, current.token);
		try {
			current = await readClaim(successorPath, lockPath);
		} catch (error) {
			if (error instanceof DispatchLockError && error.code === "LOCK_IO_FAILED" && isMissingPathError(error.cause)) {
				return current;
			}
			throw error;
		}
	}
}

async function isClaimReleased(guardPath: string, claim: ClaimRecord, lockPath: string): Promise<boolean> {
	try {
		await stat(claimReleasePath(guardPath, claim.token));
		return true;
	} catch (error) {
		if (isMissingPathError(error)) {
			return false;
		}
		throw new DispatchLockError("LOCK_IO_FAILED", `failed to inspect release for claim ${claim.token}`, lockPath, {
			cause: error,
		});
	}
}

async function acquireClaim(
	guardPath: string,
	lockPath: string,
	record: ClaimRecord,
	dependencies: SupervisorLockDependencies,
): Promise<void> {
	const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
	const retryDelayMs = dependencies.claimRetryDelayMs ?? CLAIM_RETRY_DELAY_MS;
	if (await publishClaim(guardPath, record, guardPath, lockPath)) {
		return;
	}

	for (let attempt = 0; attempt < CLAIM_MAX_ATTEMPTS; attempt += 1) {
		const owner = await currentClaim(guardPath, lockPath);
		const released = await isClaimReleased(guardPath, owner, lockPath);
		if (!released && isProcessAlive(owner.pid)) {
			await sleep(retryDelayMs);
			continue;
		}
		await dependencies.beforeClaim?.(owner);
		if (await publishClaim(claimSuccessorPath(guardPath, owner.token), record, guardPath, lockPath)) {
			return;
		}
	}
	throw new DispatchLockError("LOCK_IO_FAILED", `timed out acquiring claim guard ${guardPath}`, lockPath);
}

async function releaseClaim(guardPath: string, claim: ClaimRecord, lockPath: string): Promise<void> {
	const releasePath = claimReleasePath(guardPath, claim.token);
	let handle: FileHandle | undefined;
	try {
		handle = await open(releasePath, "wx");
		// The empty marker is immediately sufficient for same-machine mutual
		// exclusion. If its fsync fails, a crash can lose it, but then this
		// claim's PID is dead and the successor rule still permits recovery.
		await handle.sync().catch(() => undefined);
	} catch (error) {
		if (errorCode(error) !== "EEXIST") {
			throw new DispatchLockError("LOCK_IO_FAILED", `failed to release claim ${claim.token}`, lockPath, {
				cause: error,
			});
		}
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function withSupervisorClaim<T>(
	guardPath: string,
	lockPath: string,
	claim: ClaimRecord,
	dependencies: SupervisorLockDependencies,
	fn: () => Promise<T>,
): Promise<T> {
	await acquireClaim(guardPath, lockPath, claim, dependencies);
	try {
		return await fn();
	} finally {
		await releaseClaim(guardPath, claim, lockPath);
	}
}

async function releaseOwnedSupervisorLock(lockPath: string, record: SupervisorLockRecord): Promise<void> {
	let current: SupervisorLockRecord;
	try {
		current = await readSupervisorLock(lockPath);
	} catch (error) {
		if (error instanceof DispatchLockError && error.code === "LOCK_IO_FAILED" && isMissingPathError(error.cause)) {
			throw new DispatchLockError("NOT_OWNER", `${lockPath}: lock no longer exists`, lockPath, { cause: error });
		}
		throw error;
	}
	if (current.pid !== record.pid || current.started_at !== record.started_at) {
		throw new DispatchLockError("NOT_OWNER", `${lockPath}: lock ownership changed`, lockPath, { holder: current });
	}
	try {
		await rm(lockPath);
	} catch (error) {
		throw new DispatchLockError("LOCK_IO_FAILED", `failed to release ${lockPath}`, lockPath, { cause: error });
	}
}

function makeClaimRecord(
	record: SupervisorLockRecord,
	pid: number,
	entropy: () => string,
	sequence: number,
	lockPath: string,
): ClaimRecord {
	const suffix = entropy()
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "")
		.slice(0, 64);
	const parsed = claimRecordSchema.safeParse({ ...record, pid, token: `${pid}-${suffix}-${sequence}` });
	if (!parsed.success) {
		throw new DispatchLockError("INVALID_DATA", "invalid supervisor claim identity", lockPath, { cause: parsed.error });
	}
	return parsed.data;
}

/**
 * Acquire the order's long-held supervisor.lock. Unlike config/filelock's
 * short callback lock, stale claim nodes are never unlinked or reused. Each
 * immutable owner token has exactly one deterministic successor path, and
 * contenders publish that successor via hard-link CAS, so two stale waiters
 * cannot both win or delete a newer owner. A released/dead owner remains as
 * audit structure and the next acquirer extends the chain.
 */
export async function acquireSupervisorLock(
	orderId: string,
	dependencies: SupervisorLockDependencies = {},
): Promise<SupervisorLock> {
	const env = dependencies.env ?? process.env;
	const pid = dependencies.pid ?? process.pid;
	const now = dependencies.now ?? (() => new Date());
	const entropy = dependencies.randomUUID ?? randomUUID;
	const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
	const appendEvent = dependencies.appendEvent ?? appendJournalEvent;
	const sync = dependencies.sync ?? ((handle: FileHandle) => handle.sync());
	const orderDirectory = dispatchOrderDirectory(orderId, env);
	const lockPath = path.join(orderDirectory, SUPERVISOR_LOCK_FILENAME);
	const guardPath = `${lockPath}.guard`;

	try {
		const orderStat = await stat(orderDirectory);
		if (!orderStat.isDirectory()) {
			throw new DispatchLockError("ORDER_NOT_FOUND", `order ${orderId} is not a directory`, lockPath);
		}
	} catch (error) {
		if (error instanceof DispatchLockError) {
			throw error;
		}
		if (isMissingPathError(error)) {
			throw new DispatchLockError("ORDER_NOT_FOUND", `order ${orderId} does not exist`, lockPath, { cause: error });
		}
		throw new DispatchLockError("LOCK_IO_FAILED", `failed to inspect order ${orderId}`, lockPath, { cause: error });
	}

	let recordCandidate: unknown;
	try {
		recordCandidate = { pid, started_at: now().toISOString() };
	} catch (error) {
		throw new DispatchLockError("INVALID_DATA", "invalid supervisor lock clock", lockPath, { cause: error });
	}
	const parsedRecord = supervisorLockRecordSchema.safeParse(recordCandidate);
	if (!parsedRecord.success) {
		throw new DispatchLockError("INVALID_DATA", "invalid supervisor lock pid or timestamp", lockPath, {
			cause: parsedRecord.error,
		});
	}
	const record = parsedRecord.data;
	let claimSequence = 0;
	const nextClaim = () => makeClaimRecord(record, pid, entropy, claimSequence++, lockPath);
	const claim = nextClaim();
	let previous: SupervisorLockRecord | undefined;
	await withSupervisorClaim(guardPath, lockPath, claim, dependencies, async () => {
		try {
			await writeNewSupervisorLock(lockPath, record, sync);
			return;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") {
				throw new DispatchLockError("LOCK_IO_FAILED", `failed to create ${lockPath}`, lockPath, { cause: error });
			}
		}

		const holder = await readSupervisorLock(lockPath);
		if (isProcessAlive(holder.pid)) {
			throw new DispatchLockError("HELD", `${lockPath} is held by live pid ${holder.pid}`, lockPath, { holder });
		}
		previous = holder;
		try {
			await rm(lockPath);
		} catch (error) {
			throw new DispatchLockError("LOCK_IO_FAILED", `failed to remove stale lock ${lockPath}`, lockPath, {
				cause: error,
			});
		}
		try {
			await writeNewSupervisorLock(lockPath, record, sync);
		} catch (error) {
			throw new DispatchLockError("LOCK_IO_FAILED", `failed to take over stale lock ${lockPath}`, lockPath, {
				cause: error,
			});
		}
	});

	if (previous) {
		const takeoverEvent: JournalEvent = {
			apiVersion: "gatekeeper/v1",
			type: "LOCK_TAKEN_OVER",
			order_id: orderId,
			at: record.started_at,
			previous_pid: previous.pid,
			previous_started_at: previous.started_at,
			new_pid: record.pid,
		};
		try {
			await appendEvent(orderId, takeoverEvent, env);
		} catch (error) {
			const cleanupClaim = nextClaim();
			await withSupervisorClaim(guardPath, lockPath, cleanupClaim, dependencies, () =>
				releaseOwnedSupervisorLock(lockPath, record),
			).catch(() => undefined);
			throw new DispatchLockError("LOCK_IO_FAILED", `stale takeover audit failed for ${lockPath}`, lockPath, {
				cause: error,
			});
		}
	}

	let released = false;
	return {
		orderId,
		record,
		path: lockPath,
		async release() {
			if (released) {
				return;
			}
			const releaseOwner = nextClaim();
			await withSupervisorClaim(guardPath, lockPath, releaseOwner, dependencies, () =>
				releaseOwnedSupervisorLock(lockPath, record),
			);
			released = true;
		},
	};
}
