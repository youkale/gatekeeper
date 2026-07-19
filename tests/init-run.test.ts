import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runInit } from "../src/commands/init.js";

// process.execPath is the real node binary running this test -- every "agent" fixture
// below is a small `node -e` one-liner, never a real network call or coding-agent CLI.
const NODE = process.execPath;

const repoARoot = fileURLToPath(new URL("../fixtures/init-scan/repo-a/", import.meta.url));

const POLICY_YAML =
	"apiVersion: gatekeeper/v1\nlanes: {}\nlevels:\n  notify:\n    enforcement: warn\n    require: {}\n";
const CONTRACT_YAML =
	'apiVersion: gatekeeper/v1\nname: foo-contract\nlevel: notify\nauthority:\n  repo: acme/foo\n  paths: ["src/**"]\nconsumers: []\n';

/** A fake agent (placeholder mode: `{out}`) that drafts a self-contained, valid registry directory. */
function validDraftCommand(): string {
	const script =
		"const fs=require('fs');" +
		"const path=require('path');" +
		"const dir=process.argv[1];" +
		"fs.mkdirSync(path.join(dir,'contracts'),{recursive:true});" +
		`fs.writeFileSync(path.join(dir,'policy.yaml'), ${JSON.stringify(POLICY_YAML)});` +
		`fs.writeFileSync(path.join(dir,'contracts','foo.yaml'), ${JSON.stringify(CONTRACT_YAML)});`;
	return `${JSON.stringify(NODE)} -e ${JSON.stringify(script)} {out}`;
}

/** A fake agent that drafts an incomplete registry directory: a contract but no policy.yaml. */
function invalidDraftCommand(): string {
	const script =
		"const fs=require('fs');" +
		"const path=require('path');" +
		"const dir=process.argv[1];" +
		"fs.mkdirSync(path.join(dir,'contracts'),{recursive:true});" +
		`fs.writeFileSync(path.join(dir,'contracts','foo.yaml'), ${JSON.stringify(CONTRACT_YAML)});`;
	return `${JSON.stringify(NODE)} -e ${JSON.stringify(script)} {out}`;
}

function nonZeroExitCommand(): string {
	const script = "process.stderr.write('drafting agent crashed\\n');process.exit(1);";
	return `${JSON.stringify(NODE)} -e ${JSON.stringify(script)} {out}`;
}

async function writeAgentConfig(cwd: string, command: string): Promise<void> {
	await writeFile(
		path.join(cwd, ".gatekeeper.yml"),
		`apiVersion: gatekeeper/v1\nagent:\n  command: ${JSON.stringify(command)}\n  timeout_seconds: 30\n`,
		"utf8",
	);
}

describe("init --run", () => {
	let cwd: string;
	let outDir: string;

	beforeEach(async () => {
		cwd = await mkdtemp(path.join(tmpdir(), "gatekeeper-init-run-cwd-"));
		outDir = await mkdtemp(path.join(tmpdir(), "gatekeeper-init-run-out-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(cwd, { recursive: true, force: true });
		await rm(outDir, { recursive: true, force: true });
	});

	it("exits 2 with a configuration example when .gatekeeper.yml has no agent: block", async () => {
		let stderrText = "";
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderrText += String(chunk);
			return true;
		});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const exitCode = await runInit({ repos: [repoARoot], out: outDir, run: true }, cwd);

		expect(exitCode).toBe(2);
		expect(stderrText).toContain('no "agent:" block configured');
		expect(stderrText).toContain("agent:");
		stderrSpy.mockRestore();
	});

	it("drafts a valid registry, validates it --strict, and reports success without duplicating init-brief.md", async () => {
		await writeAgentConfig(cwd, validDraftCommand());
		let stdoutText = "";
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			stdoutText += String(chunk);
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const exitCode = await runInit({ repos: [repoARoot], out: outDir, run: true }, cwd);

		expect(exitCode).toBe(0);
		expect(stdoutText).toContain("passed validate --strict");

		const draftDir = path.join(outDir, "registry-draft");
		expect(await readFile(path.join(draftDir, "policy.yaml"), "utf8")).toBe(POLICY_YAML);
		expect(await readFile(path.join(draftDir, "contracts", "foo.yaml"), "utf8")).toBe(CONTRACT_YAML);

		// init-brief.md (the plain artifact) must not carry the --run-only draft-output note --
		// only the separate run-brief.md handed to the agent does.
		const plainBrief = await readFile(path.join(outDir, "init-brief.md"), "utf8");
		expect(plainBrief).not.toContain("--run draft-output instructions");

		const runBrief = await readFile(path.join(outDir, "run-brief.md"), "utf8");
		expect(runBrief).toContain("--run draft-output instructions");
		expect(runBrief).toContain(draftDir);
	});

	it("reports validate failure honestly and exits 2 (a validation defect, not an agent-run infra fault) when the drafted registry is structurally invalid", async () => {
		await writeAgentConfig(cwd, invalidDraftCommand());
		let stderrText = "";
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderrText += String(chunk);
			return true;
		});

		const exitCode = await runInit({ repos: [repoARoot], out: outDir, run: true }, cwd);

		expect(exitCode).toBe(2);
		expect(stderrText).toContain("failed validate --strict");
		expect(stderrText).toContain("policy.yaml");
	});

	it("fails loud (exit 1) with the agent's stderr tail when the agent command exits non-zero", async () => {
		await writeAgentConfig(cwd, nonZeroExitCommand());
		let stderrText = "";
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderrText += String(chunk);
			return true;
		});

		const exitCode = await runInit({ repos: [repoARoot], out: outDir, run: true }, cwd);

		expect(exitCode).toBe(1);
		expect(stderrText).toContain("agent command exited with code 1");
		expect(stderrText).toContain("drafting agent crashed");
	});
});
