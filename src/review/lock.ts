import path from "node:path";

import {
	acquireHardLinkSupervisorLock,
	DispatchLockError,
	type SupervisorLockDependencies,
	type SupervisorLockRecord,
} from "../dispatch/lock.js";
import { appendJournalEvent, reviewCycleDirectory } from "./store.js";
import type { ReviewJournalEvent } from "./types.js";

const SUPERVISOR_LOCK_FILENAME = "supervisor.lock";

export type ReviewLockErrorCode =
	| "CYCLE_NOT_FOUND"
	| "HELD"
	| "CORRUPT"
	| "INVALID_DATA"
	| "NOT_OWNER"
	| "LOCK_IO_FAILED";

export class ReviewLockError extends Error {
	readonly code: ReviewLockErrorCode;
	readonly lockPath: string;
	readonly holder?: SupervisorLockRecord;

	constructor(
		code: ReviewLockErrorCode,
		reason: string,
		lockPath: string,
		details: { holder?: SupervisorLockRecord; cause?: unknown } = {},
	) {
		super(reason, details.cause !== undefined ? { cause: details.cause } : undefined);
		this.name = "ReviewLockError";
		this.code = code;
		this.lockPath = lockPath;
		this.holder = details.holder;
	}
}

export interface ReviewSupervisorLockDependencies extends Omit<SupervisorLockDependencies, "env" | "appendEvent"> {
	env?: NodeJS.ProcessEnv;
	appendEvent?: (cycleId: string, event: ReviewJournalEvent, env: NodeJS.ProcessEnv) => Promise<void>;
}

export interface ReviewSupervisorLock {
	readonly cycleId: string;
	readonly record: SupervisorLockRecord;
	readonly path: string;
	release(): Promise<void>;
}

function mapLockError(error: DispatchLockError): ReviewLockError {
	return new ReviewLockError(
		error.code === "ORDER_NOT_FOUND" ? "CYCLE_NOT_FOUND" : error.code,
		error.message,
		error.lockPath,
		{
			holder: error.holder,
			cause: error,
		},
	);
}

/**
 * Thin review-cycle adapter over dispatch's exported hard-link CAS protocol.
 * The concurrency and exact-owner release semantics are identical; only the
 * owning directory and stale-takeover audit event differ (cycle_id rather
 * than order_id, written to the independent review journal).
 */
export async function acquireReviewSupervisorLock(
	cycleId: string,
	dependencies: ReviewSupervisorLockDependencies = {},
): Promise<ReviewSupervisorLock> {
	const env = dependencies.env ?? process.env;
	const appendEvent = dependencies.appendEvent ?? appendJournalEvent;
	const cycleDirectory = reviewCycleDirectory(cycleId, env);
	const lockPath = path.join(cycleDirectory, SUPERVISOR_LOCK_FILENAME);
	try {
		const lock = await acquireHardLinkSupervisorLock(
			{
				directory: cycleDirectory,
				lockPath,
				directoryNotFoundMessage: `review cycle ${cycleId} does not exist`,
				directoryNotDirectoryMessage: `review cycle ${cycleId} is not a directory`,
				directoryInspectFailedMessage: `failed to inspect review cycle ${cycleId}`,
				async onTakeover(previous, record) {
					await appendEvent(
						cycleId,
						{
							apiVersion: "gatekeeper/v1",
							type: "LOCK_TAKEN_OVER",
							cycle_id: cycleId,
							at: record.started_at,
							previous_pid: previous.pid,
							previous_started_at: previous.started_at,
							new_pid: record.pid,
						},
						env,
					);
				},
			},
			dependencies,
		);
		return {
			cycleId,
			record: lock.record,
			path: lock.path,
			async release() {
				try {
					await lock.release();
				} catch (error) {
					if (error instanceof DispatchLockError) {
						throw mapLockError(error);
					}
					throw error;
				}
			},
		};
	} catch (error) {
		if (error instanceof DispatchLockError) {
			throw mapLockError(error);
		}
		throw error;
	}
}
