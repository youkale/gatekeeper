import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runGovernanceCheck } from "../scripts/check-governance.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const checkerPath = path.join(repoRoot, "scripts/check-governance.mjs");

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function initRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-q"]);
	git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	git(dir, ["config", "user.email", "governance-check@example.com"]);
	git(dir, ["config", "user.name", "Governance Check Bot"]);
}

function commitAll(dir: string, message: string): void {
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", message]);
}

const COMPLIANT_LEDGER = `# LEDGER

| 任务 ID | 里程碑 | 描述 | 编码 | Review（轮次） | 结果 | 记录 |
|---------|--------|------|------|----------------|------|------|
| T-20260101-01 | M1 | example task | tester | R1: PASS | ✅ 验收提交 | records/T-20260101-01-example.md |
`;

const COMPLIANT_RECORD = `# T-20260101-01 example

- 验收（tester，2026-01-01）：全部通过。
`;

function writeCompliantFixture(dir: string): void {
	mkdirSync(path.join(dir, "tasks", "records"), { recursive: true });
	writeFileSync(path.join(dir, "tasks", "LEDGER.md"), COMPLIANT_LEDGER, "utf8");
	writeFileSync(path.join(dir, "tasks", "records", "T-20260101-01-example.md"), COMPLIANT_RECORD, "utf8");
}

describe("check-governance", () => {
	let tmpBase: string;
	let repoDir: string;

	beforeEach(() => {
		tmpBase = mkdtempSync(path.join(tmpdir(), "gatekeeper-governance-check-"));
		repoDir = path.join(tmpBase, "repo");
		initRepo(repoDir);
	});

	afterEach(() => {
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("is fully green against this repository's real history (R1-R5)", () => {
		const result = runGovernanceCheck(repoRoot);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it("passes with zero errors and zero warnings on a fully compliant fixture", () => {
		writeCompliantFixture(repoDir);
		commitAll(repoDir, "T-20260101-01 example: initial delivery");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it("R1: flags a commit whose task ID never appears in LEDGER.md", () => {
		writeCompliantFixture(repoDir);
		commitAll(repoDir, "T-20260101-01 example: initial delivery");
		writeFileSync(path.join(repoDir, "scratch.txt"), "noop", "utf8");
		commitAll(repoDir, "T-20260101-99 undocumented: never entered the ledger");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors.some((issue) => issue.rule === "R1" && issue.message.includes("T-20260101-99"))).toBe(true);
	});

	it("does not flag a commit whose subject does not start with a task ID", () => {
		writeCompliantFixture(repoDir);
		commitAll(repoDir, "T-20260101-01 example: initial delivery");
		writeFileSync(path.join(repoDir, "scratch.txt"), "noop", "utf8");
		commitAll(repoDir, "chore: unrelated tidy-up, no task ID here");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors.filter((issue) => issue.rule === "R1")).toEqual([]);
	});

	it("R2: flags a ✅ row whose record reference does not exist", () => {
		mkdirSync(path.join(repoDir, "tasks", "records"), { recursive: true });
		writeFileSync(
			path.join(repoDir, "tasks", "LEDGER.md"),
			`# LEDGER

| 任务 ID | 里程碑 | 描述 | 编码 | Review（轮次） | 结果 | 记录 |
|---------|--------|------|------|----------------|------|------|
| T-20260101-02 | M1 | example task | tester | R1: PASS | ✅ 验收提交 | records/T-20260101-02-missing.md |
`,
			"utf8",
		);
		commitAll(repoDir, "T-20260101-02 example: missing record");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors.some((issue) => issue.rule === "R2" && issue.message.includes("does not exist"))).toBe(true);
		// The same missing path is also caught by R3's whole-file reference scan.
		expect(result.errors.some((issue) => issue.rule === "R3")).toBe(true);
	});

	it("R2: flags a ✅ row whose record file exists but is empty", () => {
		mkdirSync(path.join(repoDir, "tasks", "records"), { recursive: true });
		writeFileSync(
			path.join(repoDir, "tasks", "LEDGER.md"),
			`# LEDGER

| 任务 ID | 里程碑 | 描述 | 编码 | Review（轮次） | 结果 | 记录 |
|---------|--------|------|------|----------------|------|------|
| T-20260101-03 | M1 | example task | tester | R1: PASS | ✅ 验收提交 | records/T-20260101-03-empty.md |
`,
			"utf8",
		);
		writeFileSync(path.join(repoDir, "tasks", "records", "T-20260101-03-empty.md"), "", "utf8");
		commitAll(repoDir, "T-20260101-03 example: empty record");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors.some((issue) => issue.rule === "R2" && issue.message.includes("empty"))).toBe(true);
	});

	it("R2: flags a ✅ row whose record file lacks the word 验收", () => {
		mkdirSync(path.join(repoDir, "tasks", "records"), { recursive: true });
		writeFileSync(
			path.join(repoDir, "tasks", "LEDGER.md"),
			`# LEDGER

| 任务 ID | 里程碑 | 描述 | 编码 | Review（轮次） | 结果 | 记录 |
|---------|--------|------|------|----------------|------|------|
| T-20260101-04 | M1 | example task | tester | R1: PASS | ✅ 验收提交 | records/T-20260101-04-nowd.md |
`,
			"utf8",
		);
		writeFileSync(path.join(repoDir, "tasks", "records", "T-20260101-04-nowd.md"), "# no signal word here\n", "utf8");
		commitAll(repoDir, "T-20260101-04 example: record missing the required word");

		const result = runGovernanceCheck(repoDir);

		expect(
			result.errors.some((issue) => issue.rule === "R2" && issue.message.includes('does not contain "验收"')),
		).toBe(true);
	});

	it("R3: flags a non-✅ row that still references a missing record path, without triggering R2", () => {
		mkdirSync(path.join(repoDir, "tasks", "records"), { recursive: true });
		writeFileSync(
			path.join(repoDir, "tasks", "LEDGER.md"),
			`# LEDGER

| 任务 ID | 里程碑 | 描述 | 编码 | Review（轮次） | 结果 | 记录 |
|---------|--------|------|------|----------------|------|------|
| T-20260101-05 | M1 | example task | tester | DISPATCH | 进行中 | records/T-20260101-05-not-yet.md |
`,
			"utf8",
		);
		commitAll(repoDir, "T-20260101-05 example: in progress");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors.some((issue) => issue.rule === "R2")).toBe(false);
		expect(
			result.errors.some((issue) => issue.rule === "R3" && issue.message.includes("T-20260101-05-not-yet.md")),
		).toBe(true);
	});

	it("R4 (warning only): flags an orphan record not referenced by LEDGER.md, without failing", () => {
		writeCompliantFixture(repoDir);
		writeFileSync(
			path.join(repoDir, "tasks", "records", "T-20260101-06-orphan.md"),
			"# orphan record\n\n验收：n/a\n",
			"utf8",
		);
		commitAll(repoDir, "T-20260101-01 example: initial delivery with an orphan record");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors).toEqual([]);
		expect(
			result.warnings.some((issue) => issue.rule === "R4" && issue.message.includes("T-20260101-06-orphan.md")),
		).toBe(true);
	});

	it("R5: flags a tracked markdown file containing a control byte", () => {
		writeCompliantFixture(repoDir);
		writeFileSync(
			path.join(repoDir, "tasks", "records", "T-20260101-01-example.md"),
			Buffer.concat([Buffer.from(COMPLIANT_RECORD, "utf8"), Buffer.from([0x00])]),
		);
		commitAll(repoDir, "T-20260101-01 example: corrupted record");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors.some((issue) => issue.rule === "R5" && issue.message.includes("control byte"))).toBe(true);
	});

	it("R5: flags a control byte in each of the scanned extensions (.yml/.mjs/.mts/.json, not just .md/.ts/.yaml)", () => {
		writeCompliantFixture(repoDir);
		writeFileSync(path.join(repoDir, "workflow.yml"), Buffer.from([0x41, 0x00, 0x42]));
		writeFileSync(path.join(repoDir, "helper.mjs"), Buffer.from([0x41, 0x00, 0x42]));
		writeFileSync(path.join(repoDir, "types.mts"), Buffer.from([0x41, 0x00, 0x42]));
		writeFileSync(path.join(repoDir, "data.json"), Buffer.from([0x41, 0x00, 0x42]));
		commitAll(repoDir, "T-20260101-01 example: control bytes across the newly scanned extensions");

		const result = runGovernanceCheck(repoDir);

		const flaggedFiles = result.errors.filter((issue) => issue.rule === "R5").map((issue) => issue.message);
		expect(flaggedFiles.some((message) => message.includes("workflow.yml"))).toBe(true);
		expect(flaggedFiles.some((message) => message.includes("helper.mjs"))).toBe(true);
		expect(flaggedFiles.some((message) => message.includes("types.mts"))).toBe(true);
		expect(flaggedFiles.some((message) => message.includes("data.json"))).toBe(true);
	});

	it("R5: ignores a control byte in a file extension outside the scan set (e.g. .txt)", () => {
		writeCompliantFixture(repoDir);
		writeFileSync(path.join(repoDir, "notes.txt"), Buffer.from([0x41, 0x00, 0x42]));
		commitAll(repoDir, "T-20260101-01 example: unscanned extension with a control byte");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors.filter((issue) => issue.rule === "R5")).toEqual([]);
	});

	it("R5: flags VT (0x0B) and FF (0x0C) as control bytes, not just the two pre-existing gaps", () => {
		writeCompliantFixture(repoDir);
		writeFileSync(
			path.join(repoDir, "tasks", "records", "T-20260101-01-example.md"),
			Buffer.concat([Buffer.from(COMPLIANT_RECORD, "utf8"), Buffer.from([0x0b])]),
		);
		commitAll(repoDir, "T-20260101-01 example: VT byte instead of NUL");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors.some((issue) => issue.rule === "R5" && issue.message.includes("0x0b"))).toBe(true);
	});

	it("R5: does not flag legitimate TAB/LF/CR bytes", () => {
		writeCompliantFixture(repoDir);
		writeFileSync(
			path.join(repoDir, "tasks", "records", "T-20260101-01-example.md"),
			Buffer.concat([Buffer.from(COMPLIANT_RECORD, "utf8"), Buffer.from([0x09, 0x0d])]),
		);
		commitAll(repoDir, "T-20260101-01 example: trailing tab and CR are legitimate");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors.filter((issue) => issue.rule === "R5")).toEqual([]);
	});

	it("R1: fails loud (does not silently under-scan) when the checkout is a shallow clone", () => {
		writeCompliantFixture(repoDir);
		commitAll(repoDir, "T-20260101-01 example: initial delivery");
		writeFileSync(path.join(repoDir, "scratch.txt"), "more history", "utf8");
		commitAll(repoDir, "T-20260101-01 example: second commit, still documented");

		const shallowDir = path.join(tmpBase, "shallow-clone");
		// `--depth` is silently ignored for a plain local-path clone; a
		// `file://` URL is required to force git to actually create a shallow
		// clone from a filesystem source (matches how a CI runner clones a
		// remote https:// URL, unlike an unadorned local-path clone).
		git(tmpBase, ["clone", "-q", "--depth", "1", "--branch", "main", `file://${repoDir}`, shallowDir]);

		const result = runGovernanceCheck(shallowDir);

		expect(result.errors.some((issue) => issue.rule === "R1" && issue.message.toLowerCase().includes("shallow"))).toBe(
			true,
		);
	});

	it("R2: fails loud when the task table header cannot be found (renamed/missing 任务 ID column)", () => {
		mkdirSync(path.join(repoDir, "tasks", "records"), { recursive: true });
		writeFileSync(
			path.join(repoDir, "tasks", "LEDGER.md"),
			`# LEDGER

| Code | Desc |
|------|------|
| something | else |
`,
			"utf8",
		);
		commitAll(repoDir, "chore: ledger with no recognizable task table");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors.some((issue) => issue.rule === "R2" && issue.message.includes("no task table header"))).toBe(
			true,
		);
	});

	it("R2: an unrelated preamble table containing an '任务 ID 格式' cell does not shadow the real task table", () => {
		mkdirSync(path.join(repoDir, "tasks", "records"), { recursive: true });
		writeFileSync(
			path.join(repoDir, "tasks", "LEDGER.md"),
			`# LEDGER

## Column format notes

| 字段 | 任务 ID 格式 | 说明 |
|------|--------------|------|
| 示例 | T-20260101-01 | 仅示例，不是真正的任务行 |

## Task table

| 任务 ID | 里程碑 | 描述 | 编码 | Review（轮次） | 结果 | 记录 |
|---------|--------|------|------|----------------|------|------|
| T-20260101-09 | M1 | example task | tester | R1: PASS | ✅ 验收提交 | records/T-20260101-09-example.md |
`,
			"utf8",
		);
		writeFileSync(
			path.join(repoDir, "tasks", "records", "T-20260101-09-example.md"),
			"# example\n\n验收：全部通过。\n",
			"utf8",
		);
		commitAll(repoDir, "T-20260101-09 example: preamble table precedes the real task table");

		const result = runGovernanceCheck(repoDir);

		// The preamble row's "任务 ID 格式" cell must not be mistaken for the
		// header (it lacks 结果/记录 columns too), and the preamble's
		// "示例"/"T-20260101-01" data-shaped row must not be miscounted as a
		// task row either -- only the real table below is parsed.
		expect(result.errors).toEqual([]);
	});

	it("R2: fails loud when the task table header exists but has zero data rows", () => {
		mkdirSync(path.join(repoDir, "tasks", "records"), { recursive: true });
		writeFileSync(
			path.join(repoDir, "tasks", "LEDGER.md"),
			`# LEDGER

| 任务 ID | 结果 | 记录 |
|---------|------|------|
`,
			"utf8",
		);
		commitAll(repoDir, "chore: ledger table header with no rows yet");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors.some((issue) => issue.rule === "R2" && issue.message.includes("zero data rows"))).toBe(true);
	});

	it("R2: a loosely-spaced header (/任务\\s*ID/i) is still recognized", () => {
		mkdirSync(path.join(repoDir, "tasks", "records"), { recursive: true });
		writeFileSync(
			path.join(repoDir, "tasks", "LEDGER.md"),
			`# LEDGER

| 任务ID | 结果 | 记录 |
|--------|------|------|
| T-20260101-07 | ✅ 验收提交 | records/T-20260101-07-example.md |
`,
			"utf8",
		);
		writeFileSync(
			path.join(repoDir, "tasks", "records", "T-20260101-07-example.md"),
			"# example\n\n验收：全部通过。\n",
			"utf8",
		);
		commitAll(repoDir, "T-20260101-07 example: tight header spacing");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors).toEqual([]);
	});

	it("R2: an escaped pipe (\\|) inside a cell does not shift later columns out of alignment", () => {
		mkdirSync(path.join(repoDir, "tasks", "records"), { recursive: true });
		writeFileSync(
			path.join(repoDir, "tasks", "LEDGER.md"),
			`# LEDGER

| 任务 ID | 里程碑 | 描述 | 编码 | Review（轮次） | 结果 | 记录 |
|---------|--------|------|------|----------------|------|------|
| T-20260101-08 | M1 | description with an escaped pipe \\| inside | tester | R1: PASS | ✅ 验收提交 | records/T-20260101-08-example.md |
`,
			"utf8",
		);
		writeFileSync(
			path.join(repoDir, "tasks", "records", "T-20260101-08-example.md"),
			"# example\n\n验收：全部通过。\n",
			"utf8",
		);
		commitAll(repoDir, "T-20260101-08 example: escaped pipe in description cell");

		const result = runGovernanceCheck(repoDir);

		expect(result.errors).toEqual([]);
	});

	it("CLI: exits 0 with an OK summary on a compliant fixture", () => {
		writeCompliantFixture(repoDir);
		commitAll(repoDir, "T-20260101-01 example: initial delivery");

		const result = spawnSync(process.execPath, [checkerPath, "--repo", repoDir], { encoding: "utf8" });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("OK");
	});

	it("CLI: exits 1 with a formatted [R1] error line and FAIL summary on a violation", () => {
		writeCompliantFixture(repoDir);
		commitAll(repoDir, "T-20260101-01 example: initial delivery");
		writeFileSync(path.join(repoDir, "scratch.txt"), "noop", "utf8");
		commitAll(repoDir, "T-20260101-99 undocumented: never entered the ledger");

		const result = spawnSync(process.execPath, [checkerPath, "--repo", repoDir], { encoding: "utf8" });

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("[R1]");
		expect(result.stderr).toContain("FAIL");
	});

	it("CLI: exits 0 but still reports an [R4] warning line for an orphan record", () => {
		writeCompliantFixture(repoDir);
		writeFileSync(
			path.join(repoDir, "tasks", "records", "T-20260101-06-orphan.md"),
			"# orphan record\n\n验收：n/a\n",
			"utf8",
		);
		commitAll(repoDir, "T-20260101-01 example: initial delivery with an orphan record");

		const result = spawnSync(process.execPath, [checkerPath, "--repo", repoDir], { encoding: "utf8" });

		expect(result.status).toBe(0);
		expect(result.stderr).toContain("[R4]");
		expect(result.stdout).toContain("OK");
	});
});
