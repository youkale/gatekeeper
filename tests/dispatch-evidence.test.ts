import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
	type CommitEvidence,
	checkDeliveryEvidence,
	checkNonWipCommit,
	checkResultFile,
	type DeliveryEvidence,
	dispatchResultSchema,
	evaluateDeliveryEvidence,
	type GitExecutor,
	isWipSnapshotCommit,
	type ResultFileEvidence,
} from "../src/dispatch/evidence.js";

const DELIVERED_RESULT = {
	apiVersion: "gatekeeper/v1" as const,
	status: "delivered" as const,
	summary: "Implemented and verified the requested change.",
};

const BLOCKED_RESULT = {
	apiVersion: "gatekeeper/v1" as const,
	status: "blocked" as const,
	summary: "A required external credential is unavailable.",
};

const NON_WIP_COMMIT: CommitEvidence = {
	established: true,
	commitSubjects: ["feat: deliver dispatch package"],
	nonWipCommitSubjects: ["feat: deliver dispatch package"],
};
const COMMIT_HASHES = ["a".repeat(40), "b".repeat(40), "c".repeat(40)] as const;

function resultReader(raw: string) {
	return { readText: vi.fn(async () => raw) };
}

function gitResult(stdout: string, exitCode = 0, stderr = ""): GitExecutor {
	return { exec: vi.fn(async () => ({ exitCode, stdout, stderr })) };
}

function commitOutput(...subjects: readonly string[]): string {
	return subjects.map((subject, index) => `${COMMIT_HASHES[index % COMMIT_HASHES.length]}\0${subject}\n`).join("");
}

describe("dispatch RESULT.json schema and read classification", () => {
	it("accepts the complete minimal delivered and blocked shapes", () => {
		expect(dispatchResultSchema.parse(DELIVERED_RESULT)).toEqual(DELIVERED_RESULT);
		expect(dispatchResultSchema.parse(BLOCKED_RESULT)).toEqual(BLOCKED_RESULT);
	});

	it.each([
		["wrong apiVersion", { ...DELIVERED_RESULT, apiVersion: "gatekeeper/v2" }],
		["unknown status", { ...DELIVERED_RESULT, status: "complete" }],
		["empty summary", { ...DELIVERED_RESULT, summary: "" }],
		["missing summary", { apiVersion: "gatekeeper/v1", status: "delivered" }],
		["unknown key", { ...DELIVERED_RESULT, details: "not in v1" }],
	])("rejects %s", (_name, value) => {
		expect(dispatchResultSchema.safeParse(value).success).toBe(false);
	});

	it("keeps the checked-in JSON Schema field-for-field aligned with the zod shape", async () => {
		const jsonSchema = JSON.parse(
			await readFile(new URL("../schema/dispatch-result.schema.json", import.meta.url), "utf8"),
		);
		expect(jsonSchema).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$id: "https://gatekeeper.dev/schema/dispatch-result.schema.json",
			title: "Gatekeeper Dispatch Result",
			type: "object",
			additionalProperties: false,
			required: ["apiVersion", "status", "summary"],
			properties: {
				apiVersion: { const: "gatekeeper/v1" },
				status: { type: "string", enum: ["delivered", "blocked"] },
				summary: { type: "string", minLength: 1 },
			},
		});
	});

	it("structurally distinguishes missing, read-error, corrupt, and schema-mismatch", async () => {
		const missingError = Object.assign(new Error("not found"), { code: "ENOENT" });
		const missing = await checkResultFile("out/RESULT.json", {
			readText: vi.fn(async () => Promise.reject(missingError)),
		});
		const readError = await checkResultFile("out/RESULT.json", {
			readText: vi.fn(async () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))),
		});
		const corrupt = await checkResultFile("out/RESULT.json", resultReader("{not-json"));
		const schemaMismatch = await checkResultFile(
			"out/RESULT.json",
			resultReader(JSON.stringify({ ...DELIVERED_RESULT, unexpected: true })),
		);

		expect(missing).toMatchObject({ established: false, reason: "missing" });
		expect(readError).toMatchObject({ established: false, reason: "read-error" });
		expect(corrupt).toMatchObject({ established: false, reason: "corrupt" });
		expect(schemaMismatch).toMatchObject({ established: false, reason: "schema-mismatch" });
		if (!schemaMismatch.established) {
			expect(schemaMismatch.issues?.[0]?.path).toEqual([]);
		}
	});

	it("returns parsed data for a strict valid receipt", async () => {
		await expect(checkResultFile("out/RESULT.json", resultReader(JSON.stringify(DELIVERED_RESULT)))).resolves.toEqual({
			established: true,
			result: DELIVERED_RESULT,
		});
	});
});

describe("git commit delivery evidence", () => {
	it("uses deterministic rev-list argv and accepts a non-WIP commit relative to base", async () => {
		const git = gitResult(commitOutput("feat: final delivery", "wip: run r001 checkpoint (gatekeeper dispatch)"));
		await expect(checkNonWipCommit("main", git)).resolves.toEqual({
			established: true,
			commitSubjects: ["feat: final delivery", "wip: run r001 checkpoint (gatekeeper dispatch)"],
			nonWipCommitSubjects: ["feat: final delivery"],
		});
		expect(git.exec).toHaveBeenCalledWith([
			"rev-list",
			"--format=%H%x00%s",
			"--no-commit-header",
			"--end-of-options",
			"main..HEAD",
		]);
	});

	it.each([
		["no commits", "", "no-commits"],
		[
			"only WIP snapshots",
			commitOutput("wip: run r001 checkpoint (gatekeeper dispatch)", "wip: run r002 checkpoint (gatekeeper dispatch)"),
			"only-wip-commits",
		],
	] as const)("rejects %s", async (_name, stdout, reason) => {
		await expect(checkNonWipCommit("main", gitResult(stdout))).resolves.toMatchObject({
			established: false,
			reason,
		});
	});

	it("uses the exact lowercase wip: run r prefix convention", () => {
		expect(isWipSnapshotCommit("wip: run r999 checkpoint (gatekeeper dispatch)")).toBe(true);
		expect(isWipSnapshotCommit("WIP: run r999 checkpoint (gatekeeper dispatch)")).toBe(false);
		expect(isWipSnapshotCommit("wip: unrelated checkpoint")).toBe(false);
	});

	it("counts a commit with an empty subject as non-WIP evidence", async () => {
		await expect(checkNonWipCommit("main", gitResult(commitOutput("")))).resolves.toEqual({
			established: true,
			commitSubjects: [""],
			nonWipCommitSubjects: [""],
		});
	});

	it.each([
		["missing separator", `${COMMIT_HASHES[0]} feat: delivery\n`],
		["invalid hash", `not-a-hash\0feat: delivery\n`],
		["multiple separators", `${COMMIT_HASHES[0]}\0feat\0delivery\n`],
		["blank record", "\n"],
	])("fails malformed executor output safely: %s", async (_name, stdout) => {
		await expect(checkNonWipCommit("main", gitResult(stdout))).resolves.toEqual({
			established: false,
			reason: "git-error",
			commitSubjects: [],
			message: "git rev-list returned malformed commit records",
		});
	});

	it("classifies rejected and nonzero git executions as git-error", async () => {
		const rejected: GitExecutor = { exec: vi.fn(async () => Promise.reject(new Error("spawn failed"))) };
		await expect(checkNonWipCommit("main", rejected)).resolves.toMatchObject({
			established: false,
			reason: "git-error",
			message: "spawn failed",
		});
		await expect(checkNonWipCommit("bad-base", gitResult("", 128, "unknown revision"))).resolves.toMatchObject({
			established: false,
			reason: "git-error",
			message: "unknown revision",
		});
	});

	it("checks RESULT.json and git exclusively through injected interfaces", async () => {
		const reader = resultReader(JSON.stringify(DELIVERED_RESULT));
		const git = gitResult(commitOutput("fix: satisfy acceptance"));
		await expect(
			checkDeliveryEvidence(
				{ resultPath: "runs/r001/out/RESULT.json", baseRef: "base-sha" },
				{ resultReader: reader, git },
			),
		).resolves.toMatchObject({ resultFile: { established: true }, commit: { established: true } });
		expect(reader.readText).toHaveBeenCalledWith("runs/r001/out/RESULT.json");
		expect(git.exec).toHaveBeenCalledOnce();
	});
});

describe("delivery verdict", () => {
	const deliveredResult: ResultFileEvidence = { established: true, result: DELIVERED_RESULT };
	const blockedResult: ResultFileEvidence = { established: true, result: BLOCKED_RESULT };
	const missingResult: ResultFileEvidence = {
		established: false,
		reason: "missing",
		message: "not found",
	};
	const noCommit: CommitEvidence = { established: false, reason: "no-commits", commitSubjects: [] };

	it.each([
		["zero exit plus both checks", 0, { resultFile: deliveredResult, commit: NON_WIP_COMMIT }, "COMPLETED"],
		["nonzero exit despite both checks", 1, { resultFile: deliveredResult, commit: NON_WIP_COMMIT }, "NOT_ESTABLISHED"],
		["missing receipt", 0, { resultFile: missingResult, commit: NON_WIP_COMMIT }, "NOT_ESTABLISHED"],
		["missing commit", 0, { resultFile: deliveredResult, commit: noCommit }, "NOT_ESTABLISHED"],
		["blocked receipt with zero exit", 0, { resultFile: blockedResult, commit: NON_WIP_COMMIT }, "AGENT_BLOCKED"],
		["blocked receipt with nonzero exit", 17, { resultFile: blockedResult, commit: noCommit }, "AGENT_BLOCKED"],
	] as const)("returns the expected verdict for %s", (_name, exitCode, evidence, verdict) => {
		expect(evaluateDeliveryEvidence(exitCode, evidence as DeliveryEvidence)).toBe(verdict);
	});
});
