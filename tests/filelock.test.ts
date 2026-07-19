import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withFileLock } from "../src/config/filelock.js";

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

	it("reclaims a stale lock left behind by a dead process instead of waiting out the full retry budget", async () => {
		const { writeFile } = await import("node:fs/promises");
		const base = await makeTmpDir("gatekeeper-filelock-stale-");
		const lockPath = path.join(base, "target.lock");
		// PID 999999 is virtually guaranteed not to be a live process on any
		// real machine or CI runner.
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
});
