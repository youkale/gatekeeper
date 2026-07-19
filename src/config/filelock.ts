import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
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

export interface FileLockTestHooks {
	/**
	 * Test-only concurrency seam: invoked immediately after a waiter has
	 * atomically captured a lock file's identity (inode + holder pid/nonce)
	 * and judged that pid dead, right before it attempts to win the exclusive
	 * reclaim marker for that exact identity (see `reclaimStaleLock`'s doc
	 * comment). Lets tests deterministically pause -- or mutate state out from
	 * under -- one or more waiters mid-reclaim to reproduce the interleavings
	 * the marker protocol exists to arbitrate. Never set in production.
	 */
	beforeReclaim?: (holderPid: number) => void | Promise<void>;
	/** Test-only: override the retry cadence between acquisition attempts (production default: `LOCK_RETRY_DELAY_MS`). Lets tests exhaust the retry budget without waiting out the real-world ~5s worst case. Never set in production. */
	retryDelayMs?: number;
	/** Test-only: override the maximum number of acquisition attempts before giving up (production default: `LOCK_MAX_ATTEMPTS`). Never set in production. */
	maxAttempts?: number;
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

/**
 * A lock file's identity at a single point in time: which inode currently
 * sits at the path, and what its content names as the holder. `nonce` is a
 * fresh `randomUUID()` minted whenever this module creates a lock file (see
 * `acquireLock`'s create branch) and stored as a second content line, so
 * that two *different* lock generations can never be mistaken for the same
 * one purely because they happen to share a `(dev, ino, pid)` triple --
 * both inode numbers and pids get recycled by the OS over a long enough
 * timeline. `nonce` is `undefined` for a legacy (pre-nonce) lock file that
 * contains only a bare pid with no second line; see `identitiesMatch`.
 */
interface LockIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly pid: number;
	readonly nonce: string | undefined;
}

/**
 * Parse a lock file's content into `(pid, nonce)`. Lock files created by
 * this module always contain `"<pid>\n<nonce>"`. Older lock files written
 * before the nonce existed contain only `"<pid>"` with no second line --
 * those still parse (backward compatible), just with `nonce: undefined`.
 */
function parseLockContent(content: string): { pid: number; nonce: string | undefined } | undefined {
	const lines = content.split("\n");
	const pid = Number.parseInt((lines[0] ?? "").trim(), 10);
	if (!Number.isFinite(pid)) {
		return undefined;
	}
	const nonceLine = lines[1]?.trim();
	return { pid, nonce: nonceLine && nonceLine.length > 0 ? nonceLine : undefined };
}

/**
 * Whether `current` (freshly re-observed) still identifies the same lock
 * generation as `observed` (captured earlier and judged stale). Requires
 * `(dev, ino, pid)` to match in all cases; additionally requires the nonce
 * to match whenever `observed` has one. `observed.nonce` is only ever
 * `undefined` for a legacy (pre-nonce) lock file, in which case `(dev, ino,
 * pid)` is the strongest identity that was ever available for it, so that is
 * treated as sufficient -- preserving this module's pre-existing behavior
 * for such files rather than refusing to ever reclaim them.
 */
function identitiesMatch(observed: LockIdentity, current: LockIdentity): boolean {
	if (observed.dev !== current.dev || observed.ino !== current.ino || observed.pid !== current.pid) {
		return false;
	}
	return observed.nonce === undefined || observed.nonce === current.nonce;
}

/**
 * Atomically capture a lock file's identity as a single consistent
 * observation. Deliberately `fstat` + `readFile` on one already-open
 * `FileHandle` rather than two separate path-based calls (`stat(path)` then
 * `readFile(path)`): a path-based pair can silently observe two *different*
 * files if a reclaim races in between the two calls (the path gets
 * unlinked/replaced), which would make "the inode I judged stale" and "the
 * inode I later act on" different objects without either read ever failing
 * -- exactly the ambiguity this capture exists to rule out. A single open
 * `FileHandle` keeps referring to the same inode for its whole lifetime
 * regardless of what happens to the path afterward.
 */
async function readLockIdentity(lockPath: string): Promise<LockIdentity | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(lockPath, "r");
	} catch {
		// Lock file vanished between our failed create and this open (the
		// holder released it, or another waiter already reclaimed it as
		// stale) -- treat as "no information", the retry loop will simply try
		// to create it again.
		return undefined;
	}
	try {
		const info = await handle.stat({ bigint: true });
		const content = await handle.readFile("utf8");
		const parsed = parseLockContent(content);
		if (parsed === undefined) {
			return undefined;
		}
		return { dev: info.dev, ino: info.ino, pid: parsed.pid, nonce: parsed.nonce };
	} finally {
		await handle.close();
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry cadence: 20ms between attempts, up to 250 attempts (~5s worst case) -- generous enough to ride out another `adopt` invocation's real git-subprocess + file-IO critical section, small enough not to hang a CI job indefinitely on a truly stuck/abandoned lock. */
const LOCK_RETRY_DELAY_MS = 20;
const LOCK_MAX_ATTEMPTS = 250;

function staleMarkerPath(lockPath: string, identity: LockIdentity): string {
	return `${lockPath}.stale-${identity.dev}-${identity.ino}`;
}

/**
 * Reclaim a lock file whose recorded holder pid was just observed dead, by
 * winning exclusive rights -- scoped to the *exact inode* `identity`
 * describes, not to `lockPath` the string -- to delete it.
 *
 * ## The bug this replaces
 *
 * The original implementation, on judging a holder pid dead, unconditionally
 * ran `rm(lockPath, { force: true })` then looped back to re-create. Two
 * waiters reading the same dead pid could both decide to reclaim; whichever
 * one re-created first was already inside the critical section by the time
 * the second one's *already-decided* `rm` ran -- deleting the live winner's
 * brand-new lock and letting both waiters' critical sections run at once.
 *
 * ## Why a naive rename-CAS on `lockPath` is not the fix either
 *
 * A first fix attempt replaced the blind `rm` with `rename(lockPath,
 * someTempPath)`, reasoning that `rename`'s atomicity would let only one
 * waiter "win" the reclaim. That reasoning is wrong: POSIX `rename`
 * arbitrates on the *path*, not on any inode identity the caller observed
 * earlier. A waiter that decided "stale" against inode I1 and is then
 * delayed has no way to make its later `rename(lockPath, ...)` call fail
 * just because `lockPath` now names a *different* inode I2 -- the call still
 * succeeds (moving I2, not I1), and the delayed waiter's `ENOENT`-means-"I
 * lost" check never fires because there is no `ENOENT`; the rename simply
 * "succeeds" against the wrong target. Concretely:
 *
 *   1. `lockPath` holds dead-pid inode I1.
 *   2. W_a and W_b both read I1, both judge it stale.
 *   3. W_a `rename(lockPath, reclaimA)` -- succeeds (moves I1 to `reclaimA`).
 *      W_a deletes `reclaimA`, then re-creates `lockPath` as I2 (its own
 *      live pid), and enters the critical section.
 *   4. W_b, delayed, now runs its already-decided `rename(lockPath,
 *      reclaimB)`. `lockPath` currently names I2 (W_a's *live* lock), not
 *      the I1 it observed -- but `rename` doesn't know or care; it moves
 *      whatever is at the path right now. The call succeeds, silently
 *      stealing W_a's live lock.
 *   5. W_b deletes `reclaimB` (== I2, W_a's live lock content) and re-creates
 *      `lockPath` as I3 (its own live pid) -- entering the critical section
 *      while W_a is still inside it. Double entry, unfixed.
 *
 * ## The fix: identity-scoped exclusive reclaim marker
 *
 * `identity` was captured atomically (see `readLockIdentity`) as a specific
 * `(dev, ino)` pair, not merely "whatever is currently at `lockPath`". This
 * function derives a marker path *deterministically from that identity*
 * (`staleMarkerPath`) and uses `O_EXCL` creation of that marker as the sole
 * arbitration point for "who may delete the inode with this exact identity":
 *
 *   - Two waiters that both observed the *same* dead inode I1 compute the
 *     *same* marker path and race on its `O_EXCL` creation; exactly one
 *     wins. The loser gets `EEXIST` and returns immediately, touching
 *     nothing -- it does not know or care what is currently at `lockPath`,
 *     because it never needs to: the winner's job is to resolve I1's fate
 *     safely on both of their behalf.
 *   - Winning the marker only proves "no other waiter *currently trying to
 *     resolve I1* can act concurrently". Before deleting anything, the
 *     winner additionally re-observes `lockPath`'s *current* identity (via
 *     `readLockIdentity` again, the same atomic fstat+read) and compares it
 *     to `identity` with `identitiesMatch`. This re-check is not defensive
 *     garnish, it is load-bearing: the marker is deleted once its winning
 *     session finishes (so the same path can be reused, keeping the lock
 *     directory from accumulating one orphan file per crash-recovery
 *     forever), which means a sufficiently delayed straggler can still win a
 *     *reused* marker after the original session already resolved I1 -- at
 *     that point `lockPath` no longer holds I1 at all (it holds whatever
 *     the marker's original session created, live or not), so the re-check
 *     finds a mismatch and the straggler correctly does nothing.
 *
 * Replaying the same interleaving with this protocol:
 *
 *   1. `lockPath` holds dead-pid inode I1. W_a and W_b both call
 *      `readLockIdentity` and both capture I1 (same `dev`/`ino`/`pid`/
 *      `nonce`).
 *   2. Both compute `staleMarkerPath(lockPath, I1)` -- identical path, since
 *      it is a pure function of `(dev, ino)`. Both race `open(markerPath,
 *      "wx")`; say W_a wins.
 *   3. W_b gets `EEXIST`, returns immediately without touching `lockPath` or
 *      anything else. It falls through to the outer retry loop, which will
 *      re-observe whatever `lockPath` holds *fresh* on its next attempt.
 *   4. W_a re-observes `lockPath`'s identity: it still matches I1 (nothing
 *      else could have changed it -- the only path that ever mutates a
 *      `lockPath` holding a given identity is through that identity's own
 *      marker, which W_a exclusively holds; I1's own process is confirmed
 *      dead and so can never itself call `release`). Match confirmed ->
 *      `rm(lockPath)`, then clean up its marker, then return.
 *   5. The retry loop's next `open(lockPath, "wx")` is the real arbiter of
 *      who actually enters the critical section next (W_a, W_b, or a third
 *      contender) -- exactly one `open(..., "wx")` call can ever succeed for
 *      a given inode generation.
 *
 * Now the "delayed straggler" variant that the rename-based fix could not
 * survive:
 *
 *   1. As above through step 4: W_a has deleted I1, cleaned up
 *      `staleMarkerPath(lockPath, I1)`, re-created `lockPath` as I2 (its own
 *      live pid), and entered the critical section.
 *   2. W_b, still delayed, *now* runs `open(staleMarkerPath(lockPath, I1),
 *      "wx")`. Because W_a already cleaned that marker up, the create
 *      *succeeds* -- W_b "wins" a reclaim session for an identity (I1) that
 *      has already been fully resolved.
 *   3. W_b re-observes `lockPath`: it now identifies I2 (W_a's live lock),
 *      not I1. Mismatch -> W_b does **not** delete `lockPath`. It cleans up
 *      its own marker and returns, touching nothing.
 *   4. The retry loop's next `open(lockPath, "wx")` for W_b fails `EEXIST`
 *      against W_a's live I2; W_b reads I2's (live) pid and sleeps normally,
 *      exactly as it would have if it had observed I2 from the start.
 *
 * ## Guarding against `(dev, ino, pid)` false positives with a nonce
 *
 * The re-check above was originally just a `dev`/`ino` comparison. That is
 * enough to defeat every interleaving above, but not a theoretical
 * (if extremely rare on a real filesystem within a lock's short reclaim
 * window) coincidence: an inode number can be recycled by the OS once its
 * original file is truly gone, and a pid can independently be recycled too,
 * so `(dev, ino, pid)` alone cannot *prove* "this is the exact same lock
 * generation I judged stale" -- it can only make a false positive
 * astronomically unlikely, not impossible. `identity.nonce`, a fresh
 * `randomUUID()` written as the lock file's second content line at creation
 * time, closes that gap: a coincidental `(dev, ino, pid)` match still cannot
 * also coincidentally match a 122-bit random nonce, so `identitiesMatch`
 * additionally requires nonce equality whenever the originally-observed
 * identity has one. Legacy (pre-nonce) lock files -- `nonce: undefined` --
 * fall back to the `(dev, ino, pid)` comparison this module always had,
 * which is the strongest identity that was ever recorded for them.
 *
 * ## Why the marker itself is never taken over, only ever timed out
 *
 * A marker that some waiter won but never releases (that waiter itself
 * crashed between winning it and either deleting it or cleaning it up)
 * permanently blocks reclaim of *that one specific dead-pid identity*: every
 * future waiter that observes the same identity will lose the `O_EXCL` race
 * against it forever, loop, and eventually exhaust `acquireLock`'s retry
 * budget (see the distinct "reclaim is stuck" `FileLockError` this produces,
 * as opposed to the ordinary "held by a live process" one). This is a
 * deliberate tradeoff, not an oversight: a "steal an abandoned marker after
 * some timeout" recovery path would have to itself decide, without any
 * additional coordination primitive, whether the marker's current holder is
 * truly gone -- which is exactly the blind-delete race this whole module
 * exists to prevent, just recursively reintroduced one layer down at the
 * marker itself. Compounding failures (the original lock holder *and* its
 * reclaimer both crashing, in the narrow window between the reclaimer
 * winning the marker and finishing with it) are rare enough, and the
 * consequence contained enough (one specific already-dead identity's
 * recovery stalls; every other lock file and every other identity on the
 * same lock file are unaffected), that failing loudly and pointing a human
 * at the exact marker path to delete (see `acquireLock`'s timeout message)
 * is the safer choice over adding more automated machinery here.
 *
 * No path in this protocol ever deletes or moves an inode that is still
 * reachable and alive: every destructive step is gated on an inode-identity
 * match established immediately beforehand, under exclusive ownership of
 * that identity's marker, and a dead-pid inode can never regain a live
 * successor except by being replaced through this same gate. This is also
 * why `releaseLock` needs no analogous identity check (contrast
 * `src/dispatch/lock.ts`'s `releaseOwnedSupervisorLock`, which re-reads its
 * lock file and verifies its *content* -- `pid` and `started_at` -- still
 * matches the record it created, not a `dev`/`ino` stat, before removing
 * it): nothing in this protocol ever moves or deletes a *live* holder's lock
 * file out from under it, so a holder's own `lockPath` is always still
 * exactly the file it created when it releases.
 */
async function reclaimStaleLock(lockPath: string, identity: LockIdentity, hooks?: FileLockTestHooks): Promise<void> {
	await hooks?.beforeReclaim?.(identity.pid);
	const markerPath = staleMarkerPath(lockPath, identity);
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(markerPath, "wx");
	} catch (error) {
		if (errorCode(error) === "EEXIST") {
			// Another waiter currently holds the exclusive right to resolve
			// this exact (lockPath, dev, ino) identity -- we must not touch
			// `lockPath` ourselves. The retry loop below re-observes fresh
			// state on its next attempt.
			return;
		}
		throw new FileLockError(
			`failed to create reclaim marker ${markerPath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	await handle.close();
	try {
		// Load-bearing re-check -- see this function's doc comment for the
		// exact interleaving it defeats, and for why (dev, ino, pid) alone is
		// not enough (the nonce). Only delete `lockPath` if it still
		// identifies the exact generation we captured; a mismatch (or the
		// path no longer existing at all) means some other session already
		// resolved this identity, and `lockPath` currently holds state we
		// never ourselves observed as stale.
		const current = await readLockIdentity(lockPath);
		if (current !== undefined && identitiesMatch(identity, current)) {
			await rm(lockPath, { force: true });
		}
	} finally {
		// Best-effort: free the marker path for reuse. If this fails (e.g. a
		// crash right here), the only cost is one permanent orphan file for
		// this one already-resolved identity -- it can never cause a future
		// waiter to skip a real reclaim, since no future waiter will ever
		// observe this exact (dev, ino) pair again once `lockPath` has moved
		// on to a new inode.
		await rm(markerPath, { force: true }).catch(() => undefined);
	}
}

async function acquireLock(lockPath: string, hooks?: FileLockTestHooks): Promise<void> {
	const retryDelayMs = hooks?.retryDelayMs ?? LOCK_RETRY_DELAY_MS;
	const maxAttempts = hooks?.maxAttempts ?? LOCK_MAX_ATTEMPTS;
	await mkdir(path.dirname(lockPath), { recursive: true });
	// Tracks the marker path for the most recently observed dead-but-
	// unreclaimable identity, so that if every attempt is exhausted we can
	// report *why* accurately (see the two distinct timeout messages below)
	// instead of always blaming "held by a live process", which would be
	// actively misleading when the true holder is long dead and reclaim is
	// merely stuck behind another waiter's marker.
	let lastDeadMarkerPath: string | undefined;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
			const identity = await readLockIdentity(lockPath);
			if (identity !== undefined && !isProcessAlive(identity.pid)) {
				// The process that created this lock is gone (crashed mid-critical-
				// section) -- reclaim it via the identity-scoped marker CAS (see
				// reclaimStaleLock's doc comment for why plain `rm` and plain
				// path-based `rename` are both unsafe here). Whether this waiter
				// wins or loses the reclaim, the next loop iteration's
				// `open(..., "wx")` is the real arbiter of who actually enters the
				// critical section.
				lastDeadMarkerPath = staleMarkerPath(lockPath, identity);
				await reclaimStaleLock(lockPath, identity, hooks);
				continue;
			}
			if (identity !== undefined) {
				lastDeadMarkerPath = undefined;
			}
			await sleep(retryDelayMs);
			continue;
		}
		try {
			await handle.writeFile(`${process.pid}\n${randomUUID()}`, "utf8");
		} finally {
			await handle.close();
		}
		return;
	}
	if (lastDeadMarkerPath !== undefined) {
		throw new FileLockError(
			`timed out after ${maxAttempts} attempts trying to reclaim a stale lock ${lockPath}: its recorded holder is dead, but reclaim is stuck behind another waiter's reclaim marker that was never cleaned up (crashed mid-reclaim?). This is not a live-holder wait. Manual recovery: after confirming no process is actually using ${lockPath}, delete ${lastDeadMarkerPath} and then ${lockPath}.`,
		);
	}
	throw new FileLockError(
		`timed out after ${maxAttempts} attempts waiting for lock ${lockPath} (held by a live process)`,
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
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, hooks?: FileLockTestHooks): Promise<T> {
	await acquireLock(lockPath, hooks);
	try {
		return await fn();
	} finally {
		await releaseLock(lockPath);
	}
}
