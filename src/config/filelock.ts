import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Same-directory advisory lock file (`O_CREAT | O_EXCL`, content = holder
 * PID), used to serialize the read-modify-write sequences in
 * src/config/controls.ts's `upsertControl` and src/config/repos.ts's
 * `upsertRepo` -- both are load-then-save round trips with no lock of their
 * own otherwise, so two concurrent `gatekeeper adopt`/`gatekeeper
 * init-control` invocations (e.g. a batch script adopting several repos at
 * once) could interleave their reads and saves and silently lose one
 * writer's update. `O_EXCL` create is atomic on every filesystem Node
 * targets, so "did I win the race to create the lock file" is never itself
 * racy.
 *
 * This is advisory, single-machine, single-filesystem locking -- it does not
 * (and does not need to) handle NFS or cross-machine coordination; the files
 * it protects (`repos.yaml`, `controls.yaml`) are themselves single-machine,
 * single-user state (see their own header comments).
 */

export class FileLockError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(reason);
		this.name = "FileLockError";
		this.reason = reason;
		if (options?.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function errorCode(error: unknown): string | undefined {
	return isRecord(error) && typeof (error as { code?: unknown }).code === "string"
		? (error as { code: string }).code
		: undefined;
}

/** True when `pid` names a currently-running process on this machine. `EPERM` (process exists but we lack permission to signal it) still counts as alive -- only `ESRCH` ("no such process") means the holder is gone. */
function isProcessAlive(pid: number): boolean {
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

async function readLockHolderPid(lockPath: string): Promise<number | undefined> {
	let content: string;
	try {
		content = await readFile(lockPath, "utf8");
	} catch {
		// Lock file vanished between our failed create and this read (the
		// holder released it, or another waiter already reclaimed it as
		// stale) -- treat as "no information", the retry loop will simply try
		// to create it again.
		return undefined;
	}
	const pid = Number.parseInt(content.trim(), 10);
	return Number.isFinite(pid) ? pid : undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry cadence: 20ms between attempts, up to 250 attempts (~5s worst case) -- generous enough to ride out another `adopt` invocation's real git-subprocess + file-IO critical section, small enough not to hang a CI job indefinitely on a truly stuck/abandoned lock. */
const LOCK_RETRY_DELAY_MS = 20;
const LOCK_MAX_ATTEMPTS = 250;

async function acquireLock(lockPath: string): Promise<void> {
	await mkdir(path.dirname(lockPath), { recursive: true });
	for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(lockPath, "wx");
		} catch (error) {
			if (errorCode(error) !== "EEXIST") {
				throw new FileLockError(
					`failed to create lock file ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
			// Someone else holds the lock (or a stale one was left behind).
			const holderPid = await readLockHolderPid(lockPath);
			if (holderPid !== undefined && !isProcessAlive(holderPid)) {
				// The process that created this lock is gone (crashed mid-critical-
				// section) -- reclaim it. A benign race against another waiter doing
				// the same thing is fine: rm with force never throws on ENOENT, and
				// the next loop iteration's `open(..., "wx")` is the real
				// arbiter of who actually wins the reclaimed lock.
				await rm(lockPath, { force: true });
				continue;
			}
			await sleep(LOCK_RETRY_DELAY_MS);
			continue;
		}
		try {
			await handle.writeFile(String(process.pid), "utf8");
		} finally {
			await handle.close();
		}
		return;
	}
	throw new FileLockError(
		`timed out after ${LOCK_MAX_ATTEMPTS} attempts waiting for lock ${lockPath} (held by a live process)`,
	);
}

async function releaseLock(lockPath: string): Promise<void> {
	await rm(lockPath, { force: true });
}

/**
 * Run `fn` with `lockPath` held for its entire duration (acquired before
 * `fn` starts, released -- even on throw -- immediately after it settles).
 * Callers pick `lockPath` themselves (conventionally `<target-file>.lock`,
 * alongside the file the lock protects) so the lock and the data it guards
 * live in the same directory and share the same lifecycle expectations.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	await acquireLock(lockPath);
	try {
		return await fn();
	} finally {
		await releaseLock(lockPath);
	}
}
