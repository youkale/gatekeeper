import { describe, expect, it, vi } from "vitest";

import type { GitExecutor } from "../src/dispatch/evidence.js";
import { type HandoffFileReader, synthesizeHandoffPacket } from "../src/dispatch/handoff.js";
import type { Run } from "../src/dispatch/types.js";

function run(id: "r001" | "r002", outcome: Run["outcome"], cli: string, vendor: string): Run {
	return {
		apiVersion: "gatekeeper/v1",
		id,
		cli,
		vendor,
		command: `${cli} exec {brief}`,
		brief_path: `runs/${id}/brief.md`,
		started_at: id === "r001" ? "2026-07-20T01:00:00.000Z" : "2026-07-20T01:02:00.000Z",
		ended_at: id === "r001" ? "2026-07-20T01:01:30.000Z" : "2026-07-20T01:02:12.500Z",
		outcome,
		exit_code: outcome === "AGENT_ERROR" ? 1 : null,
		signal: null,
		stdout_path: `runs/${id}/stdout.log`,
		stderr_path: `runs/${id}/stderr.log`,
		out_path: `runs/${id}/out`,
	};
}

function readers(files: Readonly<Record<string, string>>): HandoffFileReader {
	return {
		async readText(file) {
			if (Object.hasOwn(files, file)) {
				return files[file] ?? "";
			}
			throw Object.assign(new Error(`missing ${file}`), { code: "ENOENT" });
		},
	};
}

describe("dispatch handoff synthesis", () => {
	it("preserves the original brief and appends complete deterministic continuation evidence", async () => {
		const git: GitExecutor & { exec: ReturnType<typeof vi.fn> } = {
			exec: vi
				.fn()
				.mockResolvedValueOnce({ exitCode: 0, stdout: "abc123 implement API\n", stderr: "" })
				.mockResolvedValueOnce({ exitCode: 0, stdout: " src/api.ts | 4 ++++\n", stderr: "" }),
		};
		const packet = await synthesizeHandoffPacket(
			{
				originalBrief: "Implement the acceptance criteria exactly.\n",
				baseRef: "main",
				orderDirectory: "/state/orders/wo-example",
				runs: [run("r001", "AGENT_ERROR", "codex", "openai"), run("r002", "TIMEOUT", "claude", "anthropic")],
				progressPath: "out/PROGRESS.md",
				includeGitEvidence: true,
			},
			{
				git,
				files: readers({
					"/state/orders/wo-example/runs/r002/out/PROGRESS.md": "Finished parser.\nNext: tests.\n",
					"/state/orders/wo-example/runs/r001/stderr.log": "old failure",
					"/state/orders/wo-example/runs/r002/stderr.log": `ignored-prefix-${"x".repeat(4_000)}-tail`,
				}),
			},
		);

		expect(packet.warnings).toEqual([]);
		expect(packet.content.startsWith("Implement the acceptance criteria exactly.\n\n---\n")).toBe(true);
		expect(packet.content).toContain(
			"Inspect the current branch state before continuing. Continue from the existing work; do not restart from scratch.",
		);
		expect(packet.content).toContain("| r001 | codex (openai) | AGENT_ERROR | 90.0s |");
		expect(packet.content).toContain("| r002 | claude (anthropic) | TIMEOUT | 12.5s |");
		expect(packet.content).toContain("abc123 implement API");
		expect(packet.content).toContain("src/api.ts | 4 ++++");
		expect(packet.content).toContain("Finished parser.\nNext: tests.\n");
		expect(packet.content).toContain(`${"x".repeat(3_995)}-tail`);
		expect(packet.content).not.toContain("ignored-prefix");
		expect(git.exec.mock.calls).toEqual([
			[["log", "--oneline", "--end-of-options", "main..HEAD"]],
			[["diff", "--stat", "--no-ext-diff"]],
		]);
	});

	it("omits the entire git evidence section after a WIP snapshot commit failure", async () => {
		const git: GitExecutor & { exec: ReturnType<typeof vi.fn> } = { exec: vi.fn() };
		const packet = await synthesizeHandoffPacket(
			{
				originalBrief: "Continue safely.",
				baseRef: "main",
				orderDirectory: "/state/orders/wo-example",
				runs: [run("r001", "AGENT_ERROR", "codex", "openai")],
				progressPath: "custom/checkpoint.md",
				includeGitEvidence: false,
			},
			{ git, files: readers({}) },
		);

		expect(packet.content).not.toContain("Current git evidence");
		expect(packet.content).not.toContain("git log --oneline");
		expect(packet.content).not.toContain("git diff --stat");
		expect(packet.content).toContain("| r001 | codex (openai) | AGENT_ERROR | 90.0s |");
		expect(git.exec).not.toHaveBeenCalled();
	});

	it("reads the frozen non-default progress contract path in full", async () => {
		const git: GitExecutor = { exec: vi.fn() };
		const packet = await synthesizeHandoffPacket(
			{
				originalBrief: "Continue.",
				baseRef: "main",
				orderDirectory: "/state/orders/wo-example",
				runs: [run("r001", "AGENT_ERROR", "codex", "openai")],
				progressPath: "notes/agent-progress.md",
				includeGitEvidence: false,
			},
			{
				git,
				files: readers({
					"/state/orders/wo-example/runs/r001/notes/agent-progress.md": "custom checkpoint\nall lines\n",
				}),
			},
		);

		expect(packet.content).toContain("custom checkpoint\nall lines\n");
	});
});
