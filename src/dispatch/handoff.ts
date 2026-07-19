import path from "node:path";

import type { GitExecutionResult, GitExecutor } from "./evidence.js";
import type { Run } from "./types.js";

const DEFAULT_STDERR_TAIL_CHARS = 4_000;

export interface HandoffFileReader {
	readText(file: string): Promise<string>;
}

export interface SynthesizeHandoffInput {
	readonly originalBrief: string;
	readonly baseRef: string;
	readonly orderDirectory: string;
	readonly runs: readonly Run[];
	/** Run-directory relative checkpoint path from the frozen acceptance contract. */
	readonly progressPath: string;
	/** Risk-3 escape hatch: false after a failed WIP snapshot commit. */
	readonly includeGitEvidence: boolean;
	readonly stderrTailChars?: number;
}

export interface HandoffWarning {
	readonly section: "git-log" | "git-diff";
	readonly message: string;
}

export interface HandoffPacket {
	readonly content: string;
	readonly warnings: readonly HandoffWarning[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isMissing(error: unknown): boolean {
	return isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function tableCell(value: string): string {
	return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function runDuration(run: Run): string {
	if (run.ended_at === undefined) {
		return "running";
	}
	const durationMs = Date.parse(run.ended_at) - Date.parse(run.started_at);
	if (!Number.isFinite(durationMs) || durationMs < 0) {
		return "unknown";
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function runsTable(runs: readonly Run[]): string {
	const rows = ["| Run | Agent | Outcome | Duration |", "| --- | --- | --- | ---: |"];
	for (const run of runs) {
		rows.push(
			`| ${tableCell(run.id)} | ${tableCell(`${run.cli} (${run.vendor})`)} | ${tableCell(run.outcome ?? "RUNNING")} | ${runDuration(run)} |`,
		);
	}
	if (runs.length === 0) {
		rows.push("| - | - | - | - |");
	}
	return rows.join("\n");
}

function fenced(content: string): string {
	let fence = "```";
	while (content.includes(fence)) {
		fence += "`";
	}
	return `${fence}\n${content}\n${fence}`;
}

async function optionalText(reader: HandoffFileReader, file: string): Promise<string | undefined> {
	try {
		return await reader.readText(file);
	} catch (error) {
		if (isMissing(error)) {
			return undefined;
		}
		throw error;
	}
}

async function gitSection(
	git: GitExecutor,
	args: readonly string[],
	section: HandoffWarning["section"],
): Promise<{ text?: string; warning?: HandoffWarning }> {
	let result: GitExecutionResult;
	try {
		result = await git.exec(args);
	} catch (error) {
		return { warning: { section, message: errorMessage(error) } };
	}
	if (result.exitCode !== 0) {
		return {
			warning: {
				section,
				message: result.stderr || `git ${args[0] ?? "command"} exited ${result.exitCode}`,
			},
		};
	}
	return { text: result.stdout.trimEnd() || "(no output)" };
}

/**
 * Deterministic, model-free handoff synthesis. The caller injects both file
 * and git access; this module never spawns a process or reads the filesystem
 * directly.
 */
export async function synthesizeHandoffPacket(
	input: SynthesizeHandoffInput,
	dependencies: { readonly git: GitExecutor; readonly files: HandoffFileReader },
): Promise<HandoffPacket> {
	const previousRun = input.runs.at(-1);
	const previousProgress = previousRun
		? await optionalText(
				dependencies.files,
				path.join(input.orderDirectory, "runs", previousRun.id, input.progressPath),
			)
		: undefined;
	let lastFailedRun: Run | undefined;
	for (let index = input.runs.length - 1; index >= 0; index -= 1) {
		const candidate = input.runs[index];
		if (candidate?.outcome !== undefined && candidate.outcome !== "COMPLETED") {
			lastFailedRun = candidate;
			break;
		}
	}
	const failedStderr = lastFailedRun
		? await optionalText(dependencies.files, path.join(input.orderDirectory, lastFailedRun.stderr_path))
		: undefined;
	const tailChars = input.stderrTailChars ?? DEFAULT_STDERR_TAIL_CHARS;
	const stderrTail = failedStderr === undefined ? undefined : failedStderr.slice(-tailChars);

	const warnings: HandoffWarning[] = [];
	let gitEvidence = "";
	if (input.includeGitEvidence) {
		const [log, diff] = await Promise.all([
			gitSection(dependencies.git, ["log", "--oneline", "--end-of-options", `${input.baseRef}..HEAD`], "git-log"),
			gitSection(dependencies.git, ["diff", "--stat", "--no-ext-diff"], "git-diff"),
		]);
		if (log.warning) {
			warnings.push(log.warning);
		}
		if (diff.warning) {
			warnings.push(diff.warning);
		}
		if (log.text !== undefined && diff.text !== undefined) {
			gitEvidence = [
				"## Current git evidence",
				"",
				`### git log --oneline ${input.baseRef}..HEAD`,
				"",
				fenced(log.text),
				"",
				"### git diff --stat",
				"",
				fenced(diff.text),
			].join("\n");
		}
	}

	const sections = [
		input.originalBrief.trimEnd(),
		"",
		"---",
		"# Dispatch handoff appendix",
		"",
		"Inspect the current branch state before continuing. Continue from the existing work; do not restart from scratch.",
		"",
		"## Prior runs",
		"",
		runsTable(input.runs),
	];
	if (gitEvidence.length > 0) {
		sections.push("", gitEvidence);
	}
	if (previousProgress !== undefined) {
		sections.push("", `## ${previousRun?.id ?? "Previous run"} PROGRESS.md (full)`, "", fenced(previousProgress));
	}
	if (stderrTail !== undefined) {
		sections.push("", `## Last failed run stderr tail (${lastFailedRun?.id ?? "unknown"})`, "", fenced(stderrTail));
	}
	return { content: `${sections.join("\n")}\n`, warnings };
}
