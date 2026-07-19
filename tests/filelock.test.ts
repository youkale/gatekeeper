import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileLockError, withFileLock } from "../src/config/filelock.js";

let tmpDir: string | undefined;

async function makeTmpDir(prefix: string): Promise<string> {
	tmpDir = await mkdtemp(path.join(tmpdir(), prefix));
	return tmpDir;
}

afterEach(async () => {
	if (tmpDir) {
		await rm(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await stat(candidate);
		return true;
	} catch {
		return false;
	}
}

describe("withFileLock (C3): serializes concurrent critical sections", () => {
	it("never overlaps two concurrent holders -- the second only starts after the first fully finishes", async () => {
		const base = await makeTmpDir("gatekeeper-filelock-serialize-");
		const lockPath = path.join(base, "target.lock");

		const events: string[] = [];
		const first = withFileLock(lockPath, async () => {
			events.push("first-start");
			await sleep(30);
			events.push("first-end");
		});
		// Give `first` a head start so it's guaranteed to win the initial
		// O_EXCL create race, making the interleaving assertion below
		// deterministic rather than depending on scheduling luck.
		await sleep(5);
		const second = withFileLock(lockPath, async () => {
			events.push("second-start");
			await sleep(5);
			events.push("second-end");
		});

		await Promise.all([first, second]);

		expect(events).toEqual(["first-start", "first-end", "second-start", "second-end"]);
	});

	it("releases the lock file after the critical section completes", async () => {
		const base = await makeTmpDir("gatekeeper-filelock-release-");
		const lockPath = path.join(base, "target.lock");

		await withFileLock(lockPath, async () => {
			expect(await pathExists(lockPath)).toBe(true);
		});

		expect(await pathExists(lockPath)).toBe(false);
	});

	it("releases the lock file even when the critical section throws", async () => {
		const base = await makeTmpDir("gatekeeper-filelock-release-on-throw-");
		const lockPath = path.join(base, "target.lock");

		await expect(
			withFileLock(lockPath, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(await pathExists(lockPath)).toBe(false);
	});

	it("creates the lock file's parent directory if it does not exist yet", async () => {
		const base = await makeTmpDir("gatekeeper-filelock-mkdir-");
		const lockPath = path.join(base, "nested", "dir", "target.lock");

		let ran = false;
		await withFileLock(lockPath, async () => {
			ran = true;
		});

		expect(ran).toBe(true);
		expect(await pathExists(lockPath)).toBe(false);
	});

	it("reclaims a stale lock left behind by a dead process instead of waiting out the full retry budget (legacy pid-only content, no nonce line)", async () => {
		const { writeFile } = await import("node:fs/promises");
		const base = await makeTmpDir("gatekeeper-filelock-stale-");
		const lockPath = path.join(base, "target.lock");
		// PID 999999 is virtually guaranteed not to be a live process on any
		// real machine or CI runner. Deliberately a bare pid with no second
		// (nonce) line, to also cover backward compatibility with lock files
		// written before this module started minting nonces -- the identity
		// re-check must still fall back to a (dev, ino, pid)-only comparison
		// for them (see src/config/filelock.ts's `identitiesMatch`) instead of
		// refusing to ever reclaim a legacy lock.
		await writeFile(lockPath, "999999", "utf8");

		let ran = false;
		const start = Date.now();
		await withFileLock(lockPath, async () => {
			ran = true;
		});
		const elapsedMs = Date.now() - start;

		expect(ran).toBe(true);
		// Reclaiming a stale lock happens on (near) the first retry attempt
		// (20ms cadence) -- nowhere close to the ~5s full-timeout budget.
		expect(elapsedMs).toBeLessThan(1000);
	});

	it("does not delete a lock whose inode still matches (dev, ino, pid) but whose nonce no longer matches the identity judged stale", async () => {
		const { writeFile } = await import("node:fs/promises");
		const base = await makeTmpDir("gatekeeper-filelock-nonce-mismatch-");
		const lockPath = path.join(base, "target.lock");
		// PID 999999 is virtually guaranteed not to be a live process on any
		// real machine or CI runner.
		await writeFile(lockPath, "999999\nold-nonce-aaaa", "utf8");

		let swapped = false;
		let reclaimCalls = 0;
		const beforeReclaim = async () => {
			reclaimCalls += 1;
			if (!swapped) {
				swapped = true;
				// `fs.writeFile` with default flags opens an *existing* file for
				// truncate-and-rewrite rather than unlinking and recreating it, so
				// this overwrites the SAME inode's content in place (dev/ino stay
				// identical) with a different nonce but the SAME dead pid. This
				// stands in, without needing to actually force real inode-number
				// reuse, for the exact false positive the nonce guards against: a
				// later lock generation coincidentally sharing (dev, ino, pid)
				// with the one this waiter already judged stale.
				await writeFile(lockPath, "999999\nnew-nonce-bbbb", "utf8");
			}
		};

		let ran = false;
		await withFileLock(
			lockPath,
			async () => {
				ran = true;
			},
			{ beforeReclaim },
		);

		expect(ran).toBe(true);
		// The mismatch must force a *second*, independent stale judgement
		// (against the swapped-in identity) rather than silently deleting the
		// swapped-in content as if it were the originally observed identity --
		// a bare (dev, ino, pid) check (without the nonce) would have missed
		// this and deleted it on the very first reclaim attempt.
		expect(reclaimCalls).toBeGreaterThanOrEqual(2);
	});

	it("writes the reclaiming waiter's own (pid, started_at) into the reclaim marker -- so a paused-after-verify reclaimer's marker can be told apart from a truly orphaned one by checking that pid's liveness", async () => {
		const { writeFile, readFile } = await import("node:fs/promises");
		const base = await makeTmpDir("gatekeeper-filelock-marker-owner-");
		const lockPath = path.join(base, "target.lock");
		// PID 999999 is virtually guaranteed not to be a live process on any
		// real machine or CI runner.
		await writeFile(lockPath, "999999", "utf8");

		// `beforeReclaimDelete` fires exactly in the "paused after final
		// verification, before delete" window F1 is about: the reclaim winner
		// has already written its own identity into the marker and confirmed
		// (dev, ino, pid[, nonce]) still matches -- this is the last point
		// before the destructive `rm(lockPath)`. Reading the marker's content
		// here, from outside this waiter, is exactly what a human operator
		// reaching acquireLock's "reclaim is stuck" timeout message would do.
		let observedMarkerContent: string | undefined;
		const beforeReclaimDelete = async (markerPath: string) => {
			observedMarkerContent = await readFile(markerPath, "utf8");
		};

		let ran = false;
		await withFileLock(
			lockPath,
			async () => {
				ran = true;
			},
			{ beforeReclaimDelete },
		);

		expect(ran).toBe(true);
		expect(observedMarkerContent).toBeDefined();
		const [pidLine, startedAtLine] = (observedMarkerContent ?? "").split("\n");
		expect(Number.parseInt(pidLine ?? "", 10)).toBe(process.pid);
		expect(() => new Date(startedAtLine ?? "")).not.toThrow();
		expect(Number.isNaN(new Date(startedAtLine ?? "").getTime())).toBe(false);
		// The recorded pid is this test process's own pid, which is (by
		// definition) alive for the duration of this test -- demonstrating
		// that a human (or, here, a `process.kill(pid, 0)` stand-in for a
		// shell `kill -0 <pid>`) inspecting a marker's content while its
		// reclaimer is merely paused can correctly tell "still in progress,
		// do not touch" apart from "orphaned, safe to clean up" instead of
		// guessing from an empty, owner-less marker.
		expect(() => process.kill(process.pid, 0)).not.toThrow();
	});

	it("times out with a 'held by a live process' message when the recorded holder is genuinely alive", async () => {
		const { writeFile } = await import("node:fs/promises");
		const base = await makeTmpDir("gatekeeper-filelock-timeout-live-");
		const lockPath = path.join(base, "target.lock");
		// Our own test process's pid is, by definition, alive for the whole
		// duration of this test.
		await writeFile(lockPath, String(process.pid), "utf8");

		let caught: unknown;
		try {
			await withFileLock(lockPath, async () => undefined, { maxAttempts: 3, retryDelayMs: 1 });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(FileLockError);
		const message = caught instanceof Error ? caught.message : "";
		expect(message).toContain("held by a live process");
	});

	it("times out with a distinct, non-misleading, two-phase-recovery message pointing at the exact marker path when the holder is dead but reclaim is stuck behind another waiter's marker", async () => {
		const { writeFile, stat: statFile } = await import("node:fs/promises");
		const base = await makeTmpDir("gatekeeper-filelock-timeout-blocked-");
		const lockPath = path.join(base, "target.lock");
		// PID 999999 is virtually guaranteed not to be a live process on any
		// real machine or CI runner.
		await writeFile(lockPath, "999999", "utf8");
		const info = await statFile(lockPath, { bigint: true });
		const markerPath = `${lockPath}.stale-${info.dev}-${info.ino}`;
		// Simulate a reclaimer that won the marker (recording its own pid, per
		// F1) and then crashed (or hung) before deleting or cleaning it up:
		// every attempt below observes the same dead identity, races for the
		// same marker, and loses to this pre-existing marker every time --
		// reclaim is stuck, but the *original* holder is definitely not alive,
		// so the error must say so accurately.
		await writeFile(markerPath, "424242\n2020-01-01T00:00:00.000Z", "utf8");

		let caught: unknown;
		try {
			await withFileLock(lockPath, async () => undefined, { maxAttempts: 3, retryDelayMs: 1 });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(FileLockError);
		const message = caught instanceof Error ? caught.message : "";
		expect(message).not.toContain("held by a live process");
		expect(message).toContain(markerPath);
		expect(message).toContain(lockPath);
		// Two-phase manual-recovery guidance (F1): must instruct checking the
		// marker's own recorded pid for liveness *before* ever suggesting
		// deletion, not just point at a path and imply it is always safe to
		// remove.
		expect(message).toContain("kill -0");
		expect(message).toContain("still alive");
		expect(message).toContain("confirmed dead");
	});

	it("fails closed instead of silently splitting the arbitration domain when lockPath's own final path component is a symlink", async () => {
		const { symlink, writeFile } = await import("node:fs/promises");
		const base = await makeTmpDir("gatekeeper-filelock-symlink-");
		const target = path.join(base, "real-target.lock");
		const lockPath = path.join(base, "alias.lock");
		// The target's own content is irrelevant -- the check must fire before
		// this module ever needs to resolve or interpret it.
		await writeFile(target, "999999", "utf8");
		await symlink(target, lockPath);

		let caught: unknown;
		try {
			await withFileLock(lockPath, async () => undefined);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(FileLockError);
		const message = caught instanceof Error ? caught.message : "";
		expect(message).toContain("must not be a symlink");
		expect(message).toContain(lockPath);
		// Fails closed, not open: the symlink itself is left untouched (no
		// silent deletion, no silent fallback to operating on the canonical
		// target under a different arbitration domain).
		const { lstat } = await import("node:fs/promises");
		const linkStat = await lstat(lockPath);
		expect(linkStat.isSymbolicLink()).toBe(true);
	});

	it("resolves a simultaneous double-stale-reader ABA race: exactly one waiter wins the reclaim marker and the two critical sections never interleave", async () => {
		const { writeFile } = await import("node:fs/promises");
		const base = await makeTmpDir("gatekeeper-filelock-aba-simultaneous-");
		const lockPath = path.join(base, "target.lock");
		// PID 999999 is virtually guaranteed not to be a live process on any
		// real machine or CI runner.
		await writeFile(lockPath, "999999", "utf8");

		const events: string[] = [];
		let arrivals = 0;
		let releaseBarrier: (() => void) | undefined;
		const barrier = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		// Barrier both waiters immediately after each independently captures the
		// same dead-pid identity and judges it stale, but before either acts on
		// that judgement -- i.e. deterministically constructs the read-then-write
		// ABA window the fix has to arbitrate, rather than relying on scheduling
		// luck.
		const beforeReclaim = async () => {
			arrivals += 1;
			if (arrivals === 2) {
				releaseBarrier?.();
			}
			await barrier;
		};

		const waiterA = withFileLock(
			lockPath,
			async () => {
				events.push("a-start");
				await sleep(20);
				events.push("a-end");
			},
			{ beforeReclaim },
		);
		const waiterB = withFileLock(
			lockPath,
			async () => {
				events.push("b-start");
				await sleep(20);
				events.push("b-end");
			},
			{ beforeReclaim },
		);

		await Promise.all([waiterA, waiterB]);

		// The hook fires on every reclaim *attempt*, not just once per waiter:
		// once both are released past the barrier, whichever loses the marker
		// race can legitimately poll the outer retry loop again -- re-observing
		// the same still-undeleted stale identity while the winner is mid-
		// reclaim -- and hit `beforeReclaim` again before the winner finishes
		// deleting it. That is expected, benign extra polling (each repeat still
		// loses the marker and touches nothing), not a correctness issue, so
		// this only asserts the floor: both waiters reached the barrier at least
		// once each.
		expect(arrivals).toBeGreaterThanOrEqual(2);
		// Before the fix, both waiters would independently decide "pid 999999 is
		// dead" inside this same barrier window and then *unconditionally*
		// `rm(lockPath, { force: true })` + re-create: whichever waiter lost the
		// race to re-create the lock first could still delete the winner's
		// brand-new, live lock out from under it moments later, letting both
		// critical sections run concurrently (an interleaved order like
		// ["a-start", "b-start", "a-end", "b-end"] would be observable). The
		// identity-scoped reclaim marker (see src/config/filelock.ts's
		// `reclaimStaleLock` doc comment) makes exactly one waiter win the right
		// to resolve this dead-pid identity, so the two critical sections must be
		// fully serialized in one order or the other -- never interleaved.
		const serializedAThenB = ["a-start", "a-end", "b-start", "b-end"];
		const serializedBThenA = ["b-start", "b-end", "a-start", "a-end"];
		expect([serializedAThenB, serializedBThenA]).toContainEqual(events);
	});

	it("resolves a delayed-observer ABA race: a straggler that judged an already-recycled identity stale must never touch the live lock that replaced it", async () => {
		const { writeFile } = await import("node:fs/promises");
		const base = await makeTmpDir("gatekeeper-filelock-aba-delayed-");
		const lockPath = path.join(base, "target.lock");
		// PID 999999 is virtually guaranteed not to be a live process on any
		// real machine or CI runner.
		await writeFile(lockPath, "999999", "utf8");

		const events: string[] = [];
		let arrivals = 0;
		let releaseObservedBarrier: (() => void) | undefined;
		const observedBarrier = new Promise<void>((resolve) => {
			releaseObservedBarrier = resolve;
		});
		// Phase 1 (shared by both waiters): force both to independently capture
		// the SAME dead-pid identity off the original stale lock file before
		// either acts on it -- the precondition for the ABA window, made
		// deterministic instead of left to scheduling luck.
		let releaseDelayedWaiter: (() => void) | undefined;
		const delayedGate = new Promise<void>((resolve) => {
			releaseDelayedWaiter = resolve;
		});
		const beforeReclaimA = async () => {
			arrivals += 1;
			if (arrivals === 2) {
				releaseObservedBarrier?.();
			}
			await observedBarrier;
			// A has nothing further to wait for -- it runs its entire reclaim ->
			// recreate -> critical section cycle uninterrupted from here.
		};
		const beforeReclaimB = async () => {
			arrivals += 1;
			if (arrivals === 2) {
				releaseObservedBarrier?.();
			}
			await observedBarrier;
			// Phase 2 (B only): additionally wait until A has already reclaimed,
			// recreated, and entered its own critical section -- i.e. B is the
			// "delayed observer" acting on now-stale information, reproducing the
			// exact interleaving a path-based rename-CAS could not survive.
			await delayedGate;
		};

		const waiterA = withFileLock(
			lockPath,
			async () => {
				events.push("a-start");
				// Signal B only once A demonstrably holds a live lock at
				// `lockPath` -- by this point reclaimStaleLock's marker for the
				// original stale identity has already been created, matched, used
				// to delete the stale lock, and cleaned up, so B's delayed
				// `open(markerPath, "wx")` below is guaranteed to observe a fresh
				// (reusable) marker path, not an in-progress one.
				releaseDelayedWaiter?.();
				await sleep(20);
				events.push("a-end");
			},
			{ beforeReclaim: beforeReclaimA },
		);
		const waiterB = withFileLock(
			lockPath,
			async () => {
				events.push("b-start");
				await sleep(5);
				events.push("b-end");
			},
			{ beforeReclaim: beforeReclaimB },
		);

		await Promise.all([waiterA, waiterB]);

		expect(arrivals).toBe(2);
		// B is externally held back until after "a-start", so under a correct
		// implementation the two critical sections can only ever be observed
		// fully serialized as A-then-B. Under the earlier (buggy) path-based
		// rename-CAS fix, B's late `rename(lockPath, ...)` would have succeeded
		// against A's live lock (moving it, not the stale inode B originally
		// observed) and then deleted it, letting B enter its critical section
		// while A was still inside -- producing an interleaved order such as
		// ["a-start", "b-start", "a-end", "b-end"] instead.
		expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
	});
});
