#!/usr/bin/env node
// Machine-checkable ledger discipline (CLAUDE.md rule 6 / AGENTS.md "Ledger
// discipline"). Zero new dependencies: only node: built-ins. Importable for
// tests (`runGovernanceCheck`) and directly runnable as `npm run
// check:governance` / `node scripts/check-governance.mjs [--repo <path>]`.
//
// Rules:
//   R1  Every commit whose subject starts with a task ID (T-YYYYMMDD-NN)
//       must have that task ID appear somewhere in tasks/LEDGER.md. Fails
//       loud (does not silently under-scan) when the checkout is a shallow
//       clone, since a truncated `git log` would otherwise pass R1 by
//       omission rather than by evidence.
//   R2  Every tasks/LEDGER.md table row whose 结果 (result) cell contains
//       "✅" must reference a tasks/records/*.md file that exists, is
//       non-empty, and contains the word "验收". The task table's header is
//       only recognized when a single row has a cell that exactly matches
//       /^任务\s*ID$/i (not merely contains it -- so an unrelated preamble
//       table with a cell like "任务 ID 格式" cannot be mistaken for the
//       header) AND that same row also has a 结果 cell and a 记录 cell;
//       rows failing that are skipped, not selected, so scanning continues
//       past unrelated tables. Fails loud when no row anywhere qualifies,
//       or when a qualifying header is found but the table has zero data
//       rows, instead of silently treating a parse miss as "nothing to
//       check".
//   R3  Every tasks/records/*.md path referenced anywhere in
//       tasks/LEDGER.md must exist.
//   R4  Every file under tasks/records/*.md must be referenced somewhere in
//       tasks/LEDGER.md (orphan detection). Warning-level only.
//   R5  No tracked *.md/*.ts/*.yaml/*.yml/*.mjs/*.mts/*.json file may
//       contain a control byte (any byte <= 0x1F other than TAB/LF/CR --
//       the recorded NUL-byte tooling defect from tasks/LESSONS.md hides in
//       exactly this range).
//
// R1-R3 and R5 violations are errors (process exits 1). R4 violations are
// warnings only (they do not affect the exit code).

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TASK_ID_PATTERN = /^(T-\d{8}-\d{2})\b/;
const RECORD_REF_PATTERN = /records\/(T-\d{8}-\d{2}-[a-z0-9][a-z0-9-]*\.md)/g;
// Anchored to the whole (trimmed) cell -- a cell that merely contains
// "任务 ID" as a substring (e.g. "任务 ID 格式" in an unrelated preamble
// table) must not qualify as the task table's ID column.
const TABLE_HEADER_ID_PATTERN = /^任务\s*ID$/i;
const CONTROL_BYTE_SCAN_GLOBS = ["*.md", "*.ts", "*.yaml", "*.yml", "*.mjs", "*.mts", "*.json"];

// Any byte <= 0x1F is a C0 control byte except the three whitespace
// controls markdown/YAML/JSON/TS source legitimately contains: TAB (0x09),
// LF (0x0A), and CR (0x0D). This intentionally also catches VT (0x0B) and
// FF (0x0C), which have no legitimate reason to appear in these file types.
function isControlByte(byte) {
	return byte <= 0x1f && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d;
}

function isEnoent(error) {
	return typeof error === "object" && error !== null && error.code === "ENOENT";
}

function git(repoRoot, args) {
	return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function readFileIfExists(filePath) {
	try {
		return readFileSync(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) {
			return undefined;
		}
		throw error;
	}
}

function collectRecordReferences(text) {
	const refs = new Set();
	for (const match of text.matchAll(RECORD_REF_PATTERN)) {
		refs.add(match[1]);
	}
	return refs;
}

/**
 * Split a markdown table row into trimmed cells, dropping the outer pipes.
 * An escaped pipe (`\|`) is treated as a literal `|` character inside its
 * cell rather than a column separator, so prose cells may contain `\|`
 * without shifting every column after them.
 */
function splitTableRow(line) {
	const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	const cells = [];
	let current = "";
	for (let index = 0; index < inner.length; index += 1) {
		const char = inner[index];
		if (char === "\\" && inner[index + 1] === "|") {
			current += "|";
			index += 1;
			continue;
		}
		if (char === "|") {
			cells.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	cells.push(current.trim());
	return cells;
}

function isSeparatorRow(cells) {
	return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}

function isShallowRepository(repoRoot) {
	const output = git(repoRoot, ["rev-parse", "--is-shallow-repository"]);
	return output.trim() === "true";
}

/**
 * R1: every commit whose subject starts with a task ID must have that ID
 * appear somewhere in tasks/LEDGER.md.
 */
function checkR1(repoRoot, ledgerText, errors) {
	try {
		if (isShallowRepository(repoRoot)) {
			errors.push({
				rule: "R1",
				message:
					"the git checkout at " +
					repoRoot +
					" is a shallow clone (git rev-parse --is-shallow-repository reported true); " +
					"R1's commit-task-ID scan requires full history. Checkout with fetch-depth: 0.",
			});
			return;
		}
	} catch (error) {
		errors.push({
			rule: "R1",
			message: `failed to check shallow-repository status in ${repoRoot}: ${describeError(error)}`,
		});
		return;
	}

	let log;
	try {
		log = git(repoRoot, ["log", "--format=%s"]);
	} catch (error) {
		errors.push({ rule: "R1", message: `failed to read git log in ${repoRoot}: ${describeError(error)}` });
		return;
	}
	const seen = new Set();
	for (const subject of log.split("\n")) {
		const match = subject.match(TASK_ID_PATTERN);
		if (!match) {
			continue;
		}
		const taskId = match[1];
		if (seen.has(taskId)) {
			continue;
		}
		seen.add(taskId);
		if (ledgerText === undefined || !ledgerText.includes(taskId)) {
			errors.push({
				rule: "R1",
				message: `commit subject "${subject}" starts with task ID ${taskId}, which does not appear in tasks/LEDGER.md`,
			});
		}
	}
}

/**
 * R2: LEDGER rows marked done (结果 cell contains "✅") must reference an
 * existing, non-empty tasks/records/*.md file that contains "验收". Fails
 * loud instead of silently no-op'ing when the table itself cannot be
 * located or parsed into at least one data row.
 */
function checkR2(repoRoot, ledgerText, errors) {
	if (ledgerText === undefined) {
		errors.push({ rule: "R2", message: "tasks/LEDGER.md is missing" });
		return;
	}

	let headerFound = false;
	let resultIndex = -1;
	let recordIndex = -1;
	let dataRowCount = 0;

	for (const line of ledgerText.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) {
			continue;
		}
		const cells = splitTableRow(trimmed);

		if (!headerFound) {
			const idIndex = cells.findIndex((cell) => TABLE_HEADER_ID_PATTERN.test(cell));
			const candidateResultIndex = cells.findIndex((cell) => cell.includes("结果"));
			const candidateRecordIndex = cells.findIndex((cell) => cell.includes("记录"));
			// Only a row carrying all three columns qualifies as the task
			// table's header. A row that merely mentions "任务 ID" (e.g. an
			// unrelated preamble table's "任务 ID 格式" cell) without both a
			// 结果 and a 记录 column is not selected -- scanning continues to
			// later rows/tables instead of latching onto a false positive.
			if (idIndex !== -1 && candidateResultIndex !== -1 && candidateRecordIndex !== -1) {
				headerFound = true;
				resultIndex = candidateResultIndex;
				recordIndex = candidateRecordIndex;
			}
			// Whether or not this row qualified, it is never itself a data
			// row.
			continue;
		}
		if (isSeparatorRow(cells)) {
			continue;
		}

		const idMatch = cells[0]?.match(TASK_ID_PATTERN);
		if (!idMatch) {
			// Not a task row (section headers, prose lines that happen to start
			// with "|" from an unrelated table, etc.).
			continue;
		}
		dataRowCount += 1;

		const taskId = idMatch[1];
		const resultCell = cells[resultIndex] ?? "";
		if (!resultCell.includes("✅")) {
			continue;
		}

		const recordCell = cells[recordIndex] ?? "";
		const refs = [...collectRecordReferences(recordCell)];
		if (refs.length === 0) {
			errors.push({
				rule: "R2",
				message: `LEDGER row ${taskId} is marked ✅ but its 记录 cell has no tasks/records/*.md reference`,
			});
			continue;
		}

		for (const ref of refs) {
			const recordPath = path.join(repoRoot, "tasks", "records", ref);
			const content = readFileIfExists(recordPath);
			if (content === undefined) {
				errors.push({
					rule: "R2",
					message: `LEDGER row ${taskId} references tasks/records/${ref}, which does not exist`,
				});
				continue;
			}
			if (content.trim().length === 0) {
				errors.push({ rule: "R2", message: `tasks/records/${ref} (referenced by ${taskId}, ✅) is empty` });
				continue;
			}
			if (!content.includes("验收")) {
				errors.push({
					rule: "R2",
					message: `tasks/records/${ref} (referenced by ${taskId}, ✅) does not contain "验收"`,
				});
			}
		}
	}

	if (!headerFound) {
		errors.push({
			rule: "R2",
			message:
				"tasks/LEDGER.md has no task table header (expected a row with a cell exactly matching " +
				"/^任务\\s*ID$/i plus a 结果 column and a 记录 column)",
		});
		return;
	}
	if (dataRowCount === 0) {
		errors.push({ rule: "R2", message: "tasks/LEDGER.md's task table has zero data rows" });
	}
}

/** R3: every tasks/records/*.md path referenced anywhere in LEDGER.md must exist. */
function checkR3(repoRoot, ledgerText, errors) {
	if (ledgerText === undefined) {
		return; // Already reported by R2.
	}
	for (const ref of collectRecordReferences(ledgerText)) {
		const recordPath = path.join(repoRoot, "tasks", "records", ref);
		if (readFileIfExists(recordPath) === undefined) {
			errors.push({ rule: "R3", message: `tasks/LEDGER.md references tasks/records/${ref}, which does not exist` });
		}
	}
}

/** R4 (warning-level): every tasks/records/*.md file must be referenced somewhere in LEDGER.md. */
function checkR4(repoRoot, ledgerText, warnings) {
	const recordsDir = path.join(repoRoot, "tasks", "records");
	let entries;
	try {
		entries = readdirSync(recordsDir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) {
			return;
		}
		throw error;
	}
	const refs = collectRecordReferences(ledgerText ?? "");
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) {
			continue;
		}
		if (!refs.has(entry.name)) {
			warnings.push({
				rule: "R4",
				message: `tasks/records/${entry.name} is not referenced by tasks/LEDGER.md (orphan record)`,
			});
		}
	}
}

/** R5: no tracked *.md/*.ts/*.yaml/*.yml/*.mjs/*.mts/*.json file may contain a control byte. */
function checkR5(repoRoot, errors) {
	let listing;
	try {
		listing = git(repoRoot, ["ls-files", "--", ...CONTROL_BYTE_SCAN_GLOBS]);
	} catch (error) {
		errors.push({ rule: "R5", message: `failed to list tracked files in ${repoRoot}: ${describeError(error)}` });
		return;
	}
	const files = listing
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	for (const relativePath of files) {
		const filePath = path.join(repoRoot, relativePath);
		let buffer;
		try {
			buffer = readFileSync(filePath);
		} catch (error) {
			errors.push({ rule: "R5", message: `failed to read tracked file ${relativePath}: ${describeError(error)}` });
			continue;
		}
		for (let offset = 0; offset < buffer.length; offset += 1) {
			const byte = buffer[offset];
			if (isControlByte(byte)) {
				errors.push({
					rule: "R5",
					message: `tracked file ${relativePath} contains a control byte 0x${byte.toString(16).padStart(2, "0")} at offset ${offset}`,
				});
				break; // One report per offending file is enough signal.
			}
		}
	}
}

/**
 * Run every governance rule against `repoRoot` (a git working tree root)
 * and return the collected issues. Pure with respect to process state: it
 * never calls process.exit and only performs read-only git/filesystem I/O.
 */
export function runGovernanceCheck(repoRoot) {
	const errors = [];
	const warnings = [];

	const ledgerPath = path.join(repoRoot, "tasks", "LEDGER.md");
	const ledgerText = readFileIfExists(ledgerPath);

	checkR1(repoRoot, ledgerText, errors);
	checkR2(repoRoot, ledgerText, errors);
	checkR3(repoRoot, ledgerText, errors);
	checkR4(repoRoot, ledgerText, warnings);
	checkR5(repoRoot, errors);

	return { errors, warnings };
}

function formatIssue(issue) {
	return `[${issue.rule}] ${issue.message}`;
}

function parseArgs(argv) {
	let repo = process.cwd();
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--repo") {
			const value = argv[index + 1];
			if (value === undefined) {
				throw new Error("--repo requires a path argument");
			}
			repo = value;
			index += 1;
		}
	}
	return { repo };
}

async function main() {
	const { repo } = parseArgs(process.argv.slice(2));
	const repoRoot = path.resolve(repo);
	const { errors, warnings } = runGovernanceCheck(repoRoot);

	for (const warning of warnings) {
		process.stderr.write(`warning: ${formatIssue(warning)}\n`);
	}
	for (const error of errors) {
		process.stderr.write(`error: ${formatIssue(error)}\n`);
	}

	if (errors.length > 0) {
		process.stderr.write(
			`gatekeeper check:governance: FAIL (${errors.length} error(s), ${warnings.length} warning(s))\n`,
		);
		process.exitCode = 1;
		return;
	}
	process.stdout.write(`gatekeeper check:governance: OK (0 errors, ${warnings.length} warning(s))\n`);
	process.exitCode = 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		process.stderr.write(`gatekeeper check:governance: infrastructure error: ${describeError(error)}\n`);
		process.exitCode = 1;
	}
}
