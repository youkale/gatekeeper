#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command, CommanderError, Option } from "commander";

import { runCheck } from "./commands/check.js";
import { runValidate } from "./commands/validate.js";

// EPIPE guard: when a consumer closes the read end of our pipe early
// (e.g. `gatekeeper check --json | head -1`), the pending write fails with
// EPIPE. Left unhandled that crashes Node with exit 1 and flips a
// pass/warn/degraded outcome into a spurious failure — violating fail-open.
// Exit with whatever verdict exit code was already decided (default 0).
function guardAgainstEpipe(stream: NodeJS.WriteStream): void {
	stream.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") {
			process.exit(process.exitCode ?? 0);
		}
		throw error;
	});
}
guardAgainstEpipe(process.stdout);
guardAgainstEpipe(process.stderr);

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };

const program = new Command();
program.name("gatekeeper").description("Contract-aware merge gate for multi-repo organizations.").version(version);

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
