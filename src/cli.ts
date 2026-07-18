#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

import { runAudit } from "./commands/audit.js";
import { runCheck } from "./commands/check.js";
import { rolesPolicyCapabilityCheck, runDoctor } from "./commands/doctor.js";
import { runGate } from "./commands/gate.js";
import { registerInitCommand } from "./commands/init.js";
import { runStats } from "./commands/stats.js";
import { runTriage } from "./commands/triage.js";
import { runValidate } from "./commands/validate.js";

// Stream failures are infrastructure degradation. Warn on the other stream
// when possible, then preserve whatever verdict exit code was already set.
function guardAgainstStreamErrors(
	stream: NodeJS.WriteStream,
	otherStream: NodeJS.WriteStream,
	streamName: "stdout" | "stderr",
): void {
	stream.on("error", (error: NodeJS.ErrnoException) => {
		try {
			otherStream.write(
				`warning: Gatekeeper ${streamName} stream error${error.code ? ` (${error.code})` : ""}; preserving exit code\n`,
			);
		} catch {
			// The warning is best-effort because the fallback stream may also be unavailable.
		}
		process.exit(process.exitCode ?? 0);
	});
}
guardAgainstStreamErrors(process.stdout, process.stderr, "stdout");
guardAgainstStreamErrors(process.stderr, process.stdout, "stderr");

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };

const program = new Command();
program.name("gatekeeper").description("Contract-aware merge gate for multi-repo organizations.").version(version);

function positiveInteger(value: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new InvalidArgumentError("must be a positive integer");
	}
	return parsed;
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

// exitOverride must be set before subcommands are added: Command#command()
// copies the parent's exit callback onto the new subcommand at creation time.
program.exitOverride();

program
	.command("check")
	.description("Evaluate the current diff against the contract registry.")
	.requiredOption("--registry <dir>", "path to the registry directory")
	.option("--repo <org/name>", "explicit repo identity (defaults to the origin remote)")
	.addOption(
		new Option("--base <ref>", "diff base ref (defaults to auto-detected main/master)").conflicts([
			"staged",
			"workingTree",
		]),
	)
	.addOption(
		new Option("--staged", "diff staged changes instead of base...head")
			.default(false)
			.conflicts(["base", "workingTree"]),
	)
	.addOption(
		new Option("--working-tree", "diff HEAD against the working tree (staged + unstaged, for pre-commit checks)")
			.default(false)
			.conflicts(["base", "staged"]),
	)
	.option("--json", "emit machine-readable verdict JSON on stdout", false)
	.option("--explain", "render file -> glob -> contract -> policy provenance", false)
	.option("--actor <name>", "explicit actor identity (defaults to git config user.name)")
	.option(
		"--strict-infra",
		"treat infrastructure/config faults as failures (exit 2) instead of fail-open (local debugging)",
		false,
	)
	.action(async (options) => {
		process.exitCode = await runCheck(options, process.cwd());
	});

program
	.command("validate")
	.description("Validate the contract registry: schema check plus glob/foreign-key lint.")
	.requiredOption("--registry <dir>", "path to the registry directory")
	.option("--strict", "treat warnings as failures (exit 1)", false)
	.action(async (options) => {
		process.exitCode = await runValidate(options);
	});

program
	.command("gate")
	.description("Evaluate a GitHub pull request and upsert its sticky gate verdict comment.")
	.requiredOption("--pr <n>", "pull request number", positiveInteger)
	.requiredOption("--registry <dir>", "path to the registry directory")
	.option("--repo <org/name>", "explicit GitHub repository (defaults to GITHUB_REPOSITORY or origin)")
	.option("--json", "emit the gate report as JSON on stdout", false)
	.option("--explain", "include file -> glob -> contract -> policy provenance in the sticky comment", false)
	.action(async (options) => {
		process.exitCode = await runGate(options, process.cwd());
	});

program
	.command("doctor")
	.description("Validate registry lanes and GitHub branch-protection required checks.")
	.requiredOption("--registry <dir>", "path to the registry directory")
	.option("--repo <org/name>", "explicit GitHub repository (defaults to GITHUB_REPOSITORY or origin)")
	.option("--branch <name>", "protected branch (defaults to GITHUB_BASE_REF or main)")
	.option("--workflow <path>", "workflow file or directory (defaults to .github/workflows)")
	.option("--check-name <name>", "expected required check name (repeatable; bypasses workflow discovery)", collect, [])
	.action(async (options) => {
		const cwd = process.cwd();
		process.exitCode = await runDoctor(options, cwd, { capabilityChecks: [rolesPolicyCapabilityCheck(cwd)] });
	});

program
	.command("audit")
	.description("Check registry glob drift against local repository checkouts.")
	.requiredOption("--registry <dir>", "path to the registry directory")
	.requiredOption(
		"--repo-path <org/name=path>",
		"map a registry repository to a local checkout (repeatable)",
		collect,
		[],
	)
	.option("--json", "emit the audit report as JSON", false)
	.action(async (options) => {
		process.exitCode = await runAudit(options, process.cwd());
	});

program
	.command("stats")
	.description("Aggregate Gatekeeper ledger rounds from GitHub or a local JSONL file.")
	.addOption(new Option("--source <source>", "ledger source").choices(["github", "local"]).default("local"))
	.option("--repo <org/name>", "GitHub repository (required with --source github)")
	.option("--token <token>", "GitHub token (defaults to GITHUB_TOKEN)")
	.option("--file <path>", "local JSONL ledger (defaults to .gatekeeper/ledger.jsonl)")
	.option("--since <date>", "harvest merged GitHub PRs at or after this ISO date/time")
	.option("--json", "emit the aggregate report as JSON", false)
	.action(async (options) => {
		process.exitCode = await runStats(options, process.cwd());
	});

program
	.command("triage")
	.description(
		"Assemble a requirement-gate triage briefing for a GitHub issue, or post a completed judgement back to it.",
	)
	.requiredOption("--issue <n>", "issue number", positiveInteger)
	.requiredOption("--repo <org/name>", "GitHub repository")
	.requiredOption("--registry <dir>", "path to the registry directory")
	.option("--post", "post a completed --verdict-file judgement back to the issue instead of printing a briefing", false)
	.option("--verdict-file <path>", "path to a completed judgement JSON file (required with --post)")
	.option("--actor <name>", "explicit actor identity recorded on the posted comment")
	.action(async (options) => {
		process.exitCode = await runTriage(options, process.cwd());
	});

registerInitCommand(program);

try {
	await program.parseAsync(process.argv);
} catch (error) {
	if (error instanceof CommanderError) {
		// Usage errors (unknown flag, missing argument value, ...) map to exit 2.
		// --help/--version use CommanderError too, but with exitCode 0 — preserve that.
		process.exitCode = error.exitCode === 0 ? 0 : 2;
	} else {
		throw error;
	}
}
