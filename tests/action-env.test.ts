import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type ActionDependencies, resolvePullRequestNumber, runAction } from "../src/action.js";
import type { Verdict } from "../src/engine/types.js";

const blockingVerdict: Verdict = {
	decision: "block",
	repo: "acme/app",
	touched: [
		{
			contract: "public-api",
			level: "required",
			enforcement: "block",
			effectiveEnforcement: "block",
			requires: null,
			bindings: [],
			consumers: [],
		},
	],
	forbiddenEdits: [],
	effectivePolicy: { enforcementOverride: null },
};

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function eventEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		INPUT_MODE: "gate",
		"INPUT_REGISTRY-PATH": "/registry",
		INPUT_ENFORCE: "hard",
		"INPUT_GITHUB-TOKEN": "token",
		GITHUB_EVENT_PATH: "/event.json",
		GITHUB_EVENT_NAME: "pull_request_target",
		GITHUB_REPOSITORY: "acme/app",
		...overrides,
	};
}

function eventReader(payload: unknown): NonNullable<ActionDependencies["readFile"]> {
	return vi.fn(async () => JSON.stringify(payload));
}

function gateReport(decision: "pass" | "block", verdict = blockingVerdict): Record<string, unknown> {
	return {
		decision,
		verdict,
		requirement: null,
		lanes: [],
		override: null,
		comment: { action: "update", commentId: 7 },
	};
}

async function runActionWithStreamError(
	streamName: "stdout" | "stderr",
	presetExitCode?: number,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; warningLog: string }> {
	const directory = await mkdtemp(path.join(tmpdir(), "gatekeeper-action-stream-error-"));
	try {
		const eventPath = path.join(directory, "event.json");
		const preloadPath = path.join(directory, "stream-error.mjs");
		const warningPath = path.join(directory, "warning.log");
		await writeFile(eventPath, "{broken", "utf8");
		await writeFile(warningPath, "", "utf8");
		await writeFile(
			preloadPath,
			`import { appendFileSync } from "node:fs";

const streamName = process.env.GATEKEEPER_TEST_STREAM;
const otherStream = streamName === "stdout" ? process.stderr : process.stdout;
const originalWrite = otherStream.write.bind(otherStream);
otherStream.write = (chunk, ...args) => {
	appendFileSync(process.env.GATEKEEPER_TEST_WARNING_LOG, String(chunk));
	return originalWrite(chunk, ...args);
};

process.once("beforeExit", () => {
	if (process.env.GATEKEEPER_TEST_PRESET_EXIT_CODE !== undefined) {
		process.exitCode = Number(process.env.GATEKEEPER_TEST_PRESET_EXIT_CODE);
	}
	const error = Object.assign(new Error("simulated stream failure"), { code: "EIO" });
	process[streamName].emit("error", error);
});
`,
			"utf8",
		);
		const child = spawn(process.execPath, ["--import", preloadPath, "--import", "tsx", "src/action.ts"], {
			cwd: repoRoot,
			env: {
				...process.env,
				INPUT_MODE: "gate",
				"INPUT_REGISTRY-PATH": "/registry",
				INPUT_ENFORCE: "hard",
				"INPUT_GITHUB-TOKEN": "token",
				GITHUB_EVENT_PATH: eventPath,
				GITHUB_EVENT_NAME: "pull_request_target",
				GITHUB_REPOSITORY: "acme/app",
				GATEKEEPER_TEST_STREAM: streamName,
				GATEKEEPER_TEST_WARNING_LOG: warningPath,
				...(presetExitCode === undefined ? {} : { GATEKEEPER_TEST_PRESET_EXIT_CODE: String(presetExitCode) }),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.resume();
		child.stderr?.resume();
		const [exitCode, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
		return { exitCode, signal, warningLog: await readFile(warningPath, "utf8") };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Action pull request event resolution", () => {
	it.each([
		["pull_request", { number: 11, pull_request: { number: 11 } }, 11],
		["pull_request_target", { number: 12, pull_request: { number: 12 } }, 12],
		["pull_request_review", { review: {}, pull_request: { number: 13 } }, 13],
		["check_suite", { check_suite: { pull_requests: [{ number: 14 }] } }, 14],
		["workflow_run", { workflow_run: { pull_requests: [{ number: 15 }] } }, 15],
	] as const)("resolves %s payloads", (eventName, payload, expected) => {
		expect(resolvePullRequestNumber(payload, eventName)).toBe(expected);
	});

	it("returns null for a check suite without associated pull requests", () => {
		expect(resolvePullRequestNumber({ check_suite: { pull_requests: [] } }, "check_suite")).toBeNull();
	});
});

describe("Action fail-open/fail-closed boundary", () => {
	it("fails only for a parsed hard block verdict and writes the verdict summary", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const summaries: string[] = [];
		const runGate = vi.fn(async () => {
			process.stdout.write(`${JSON.stringify(gateReport("block"))}\n`);
			return 1;
		});

		const exitCode = await runAction({
			env: eventEnvironment({ GITHUB_STEP_SUMMARY: "/summary" }),
			readFile: eventReader({ pull_request: { number: 42, base: { sha: "base-sha" } } }),
			runGate,
			appendSummary: async (_file, content) => {
				summaries.push(content);
			},
		});

		expect(exitCode).toBe(1);
		expect(runGate).toHaveBeenCalledOnce();
		expect(summaries.join("\n")).toContain("| public-api | required | block |");
	});

	it("keeps the same block verdict non-failing in soft enforcement mode", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runGate = vi.fn(async () => {
			process.stdout.write(`${JSON.stringify(gateReport("block"))}\n`);
			return 1;
		});

		const exitCode = await runAction({
			env: eventEnvironment({ INPUT_ENFORCE: "soft" }),
			readFile: eventReader({ pull_request: { number: 42 } }),
			runGate,
		});

		expect(exitCode).toBe(0);
	});

	it("skips an unassociated check suite with exit zero", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runGate = vi.fn(async () => 1);

		const exitCode = await runAction({
			env: eventEnvironment({ GITHUB_EVENT_NAME: "check_suite" }),
			readFile: eventReader({ check_suite: { pull_requests: [] } }),
			runGate,
		});

		expect(exitCode).toBe(0);
		expect(runGate).not.toHaveBeenCalled();
	});

	it("runs a workflow_run gate for the pull request embedded in the event payload", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runGate = vi.fn(async () => {
			process.stdout.write(`${JSON.stringify(gateReport("block"))}\n`);
			return 1;
		});

		const exitCode = await runAction({
			env: eventEnvironment({ GITHUB_EVENT_NAME: "workflow_run", INPUT_ENFORCE: "soft" }),
			readFile: eventReader({
				workflow_run: { pull_requests: [{ number: 52 }], head_sha: "review-ping-head" },
			}),
			runGate,
		});

		expect(exitCode).toBe(0);
		expect(runGate).toHaveBeenCalledWith(
			expect.objectContaining({ pr: 52, repo: "acme/app" }),
			expect.any(String),
			expect.any(Object),
		);
	});

	it("looks up a fork workflow_run pull request by head SHA when pull_requests is empty", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const findPullRequestsByHeadSha = vi.fn(async () => [
			{
				number: 53,
				body: null,
				user: { login: "fork-author" },
				head: { ref: "feature", sha: "fork-head-sha" },
				base: { ref: "main", sha: "base-sha" },
				labels: [],
			},
		]);
		const createProvider: NonNullable<ActionDependencies["createProvider"]> = () =>
			({ findPullRequestsByHeadSha }) as unknown as ReturnType<NonNullable<ActionDependencies["createProvider"]>>;
		const runGate = vi.fn(async () => {
			process.stdout.write(`${JSON.stringify(gateReport("block"))}\n`);
			return 1;
		});

		const exitCode = await runAction({
			env: eventEnvironment({ GITHUB_EVENT_NAME: "workflow_run", INPUT_ENFORCE: "soft" }),
			readFile: eventReader({ workflow_run: { pull_requests: [], head_sha: "fork-head-sha" } }),
			createProvider,
			runGate,
		});

		expect(exitCode).toBe(0);
		expect(findPullRequestsByHeadSha).toHaveBeenCalledWith("fork-head-sha");
		expect(runGate).toHaveBeenCalledWith(
			expect.objectContaining({ pr: 53, repo: "acme/app" }),
			expect.any(String),
			expect.any(Object),
		);
	});

	it("skips a workflow_run when neither the payload nor head-SHA lookup identifies a pull request", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const findPullRequestsByHeadSha = vi.fn(async () => []);
		const createProvider: NonNullable<ActionDependencies["createProvider"]> = () =>
			({ findPullRequestsByHeadSha }) as unknown as ReturnType<NonNullable<ActionDependencies["createProvider"]>>;
		const runGate = vi.fn(async () => 1);

		const exitCode = await runAction({
			env: eventEnvironment({ GITHUB_EVENT_NAME: "workflow_run" }),
			readFile: eventReader({ workflow_run: { pull_requests: [], head_sha: "orphan-head-sha" } }),
			createProvider,
			runGate,
		});

		expect(exitCode).toBe(0);
		expect(findPullRequestsByHeadSha).toHaveBeenCalledWith("orphan-head-sha");
		expect(runGate).not.toHaveBeenCalled();
		expect(stdout.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"Gatekeeper skipped: workflow run has no associated pull request",
		);
	});

	it("turns an unexpected command exception into a warning and exit zero", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const createProvider: NonNullable<ActionDependencies["createProvider"]> = () => {
			throw new Error("provider exploded");
		};
		const runGate = vi.fn(async (_options, _cwd, dependencies) => {
			dependencies?.createProvider?.({ repo: "acme/app" });
			throw new Error("unreachable");
		});

		const exitCode = await runAction({
			env: eventEnvironment(),
			readFile: eventReader({ pull_request: { number: 42 } }),
			createProvider,
			runGate,
		});

		expect(exitCode).toBe(0);
		expect(stdout.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"::warning::GATEKEEPER DEGRADED provider exploded",
		);
	});

	it("turns malformed event JSON into a warning and exit zero", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const exitCode = await runAction({
			env: eventEnvironment(),
			readFile: async () => "{broken",
		});

		expect(exitCode).toBe(0);
		expect(stdout.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"::warning::GATEKEEPER DEGRADED failed to parse GitHub event payload",
		);
	});

	it("keeps a malformed-event degradation fail-open when stdout closes with EPIPE", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "gatekeeper-action-epipe-"));
		try {
			const eventPath = path.join(directory, "event.json");
			await writeFile(eventPath, "{broken", "utf8");
			const child = spawn(process.execPath, ["--import", "tsx", "src/action.ts"], {
				cwd: repoRoot,
				env: {
					...process.env,
					INPUT_MODE: "gate",
					"INPUT_REGISTRY-PATH": "/registry",
					INPUT_ENFORCE: "hard",
					"INPUT_GITHUB-TOKEN": "token",
					GITHUB_EVENT_PATH: eventPath,
					GITHUB_EVENT_NAME: "pull_request_target",
					GITHUB_REPOSITORY: "acme/app",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stdout?.destroy();
			child.stderr?.resume();
			const [exitCode, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];

			expect(signal).toBeNull();
			expect(exitCode).toBe(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("does not crash when the action stdout stream emits non-EPIPE EIO", async () => {
		const result = await runActionWithStreamError("stdout");

		expect(result.signal).toBeNull();
		expect(result.exitCode).toBe(0);
		expect(result.warningLog).toContain("warning: Gatekeeper stdout stream error (EIO); preserving exit code");
	});

	it("preserves an existing action exit code when stderr emits non-EPIPE EIO", async () => {
		const result = await runActionWithStreamError("stderr", 1);

		expect(result.signal).toBeNull();
		expect(result.exitCode).toBe(1);
		expect(result.warningLog).toContain("warning: Gatekeeper stderr stream error (EIO); preserving exit code");
	});

	it("preserves a check-mode hard block when sticky comment creation fails", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runCheck = vi.fn(async () => {
			process.stdout.write(`${JSON.stringify(blockingVerdict)}\n`);
			return 1;
		});
		const createProvider: NonNullable<ActionDependencies["createProvider"]> = () => ({
			getPullRequest: async () => ({
				number: 42,
				body: null,
				user: { login: "alice" },
				head: { ref: "feature", sha: "head" },
				base: { ref: "main", sha: "base" },
				labels: [],
			}),
			getPullRequestFiles: async () => [],
			getPullRequestReviews: async () => [],
			getIssueComments: async () => [],
			getCheckRuns: async () => [],
			getCommitStatuses: async () => [],
			getPullRequestLabels: async () => [],
			createIssueComment: async () => {
				throw new Error("comment permission denied");
			},
			updateIssueComment: async () => {
				throw new Error("no update expected");
			},
		});

		const exitCode = await runAction({
			env: eventEnvironment({ INPUT_MODE: "check", INPUT_ENFORCE: "hard" }),
			readFile: eventReader({ pull_request: { number: 42, base: { sha: "base" } } }),
			runCheck,
			createProvider,
		});

		expect(exitCode).toBe(1);
		expect(stdout.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"::warning::GATEKEEPER DEGRADED sticky comment update failed after block verdict: comment permission denied",
		);
	});

	it("preserves a gate-mode hard block when the final sticky comment write fails", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const createProvider: NonNullable<ActionDependencies["createProvider"]> = () => ({
			getPullRequest: async () => {
				throw new Error("unused");
			},
			getPullRequestFiles: async () => [],
			getPullRequestReviews: async () => [],
			getIssueComments: async () => [],
			getCheckRuns: async () => [],
			getCommitStatuses: async () => [],
			getPullRequestLabels: async () => [],
			createIssueComment: async () => {
				throw new Error("comment API unavailable");
			},
			updateIssueComment: async () => {
				throw new Error("unused");
			},
		});
		const runGate = vi.fn(async (_options, _cwd, dependencies) => {
			const provider = dependencies?.createProvider?.({ repo: "acme/app" });
			if (!provider) {
				throw new Error("missing provider");
			}
			await provider.createIssueComment(42, "final comment");
			process.stdout.write(`${JSON.stringify(gateReport("block"))}\n`);
			return 1;
		});

		const exitCode = await runAction({
			env: eventEnvironment(),
			readFile: eventReader({ pull_request: { number: 42 } }),
			createProvider,
			runGate,
		});

		expect(exitCode).toBe(1);
		expect(stdout.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"::warning::GATEKEEPER DEGRADED sticky comment create failed after verdict: comment API unavailable",
		);
	});

	it("uses check mode, upserts its sticky comment, and preserves soft exit zero", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		let writtenComment = "";
		const runCheck = vi.fn(async () => {
			process.stdout.write(`${JSON.stringify(blockingVerdict)}\n`);
			return 1;
		});
		const createProvider: NonNullable<ActionDependencies["createProvider"]> = () => ({
			getPullRequest: async () => ({
				number: 42,
				body: "Fixes #9",
				user: { login: "alice" },
				head: { ref: "feature", sha: "head" },
				base: { ref: "main", sha: "base" },
				labels: [],
				html_url: "https://github.com/acme/app/pull/42",
			}),
			getPullRequestFiles: async () => [],
			getPullRequestReviews: async () => [],
			getIssueComments: async () => [],
			getCheckRuns: async () => [],
			getCommitStatuses: async () => [],
			getPullRequestLabels: async () => [],
			createIssueComment: async (_pr, body) => {
				writtenComment = body;
				return {
					id: 99,
					body,
					user: { login: "gatekeeper[bot]" },
					created_at: "2026-07-18T00:00:00Z",
					updated_at: "2026-07-18T00:00:00Z",
				};
			},
			updateIssueComment: async () => {
				throw new Error("no update expected");
			},
		});

		const exitCode = await runAction({
			env: eventEnvironment({ INPUT_MODE: "check", INPUT_ENFORCE: "soft" }),
			readFile: eventReader({ pull_request: { number: 42, base: { sha: "base" } } }),
			runCheck,
			createProvider,
			now: () => "2026-07-18T00:00:00Z",
		});

		expect(exitCode).toBe(0);
		expect(runCheck).toHaveBeenCalledWith(expect.objectContaining({ base: "base", json: true }), expect.any(String));
		expect(writtenComment).toContain("<!-- gatekeeper:verdict -->");
		expect(writtenComment).toContain("```json gatekeeper-ledger");
	});
});
