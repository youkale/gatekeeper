#!/usr/bin/env node
/**
 * Gatekeeper MCP server — thin stdio-transport wrapper over the main-package
 * engine, generic across any MCP client (Claude Code, Cursor, Codex, ...).
 * All matching / verdict logic lives in ../../src; this file only registers
 * MCP tools and assembles provider + engine calls (same composition as
 * ../pi/index.ts's gatekeeper_check, extended with staged/workingTree/repo/
 * actor). This package is a transport shim: it makes zero LLM/model calls
 * itself, and everything it imports from ../../src stays inside that
 * package's zero-model invariant.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { runValidate } from "../../src/commands/validate.js";
import { formatRegistryIssue, RegistryParseError } from "../../src/engine/registry.js";
import type { Verdict } from "../../src/engine/types.js";
import { evaluate } from "../../src/engine/verdict.js";
import { LanePresetParseError, LanePresetReadError, loadRegistryWithLanePresets } from "../../src/gate/presets.js";
import { RegistryReadError } from "../../src/providers/fsregistry.js";
import {
	attachPatches,
	type DiffRangeOptions,
	GitDiffError,
	getChangedFiles,
	resolveActor,
	resolveBaseRef,
	resolveRepo,
} from "../../src/providers/gitdiff.js";
import { renderExplain, renderSummary, renderVerdictJson } from "../../src/render/explain.js";

/**
 * Locate this package's own package.json to report a real version in the MCP
 * `serverInfo`. Source (index.ts) and the tsup-bundled dist/index.js sit at
 * different depths relative to package.json (dist/ is one directory deeper),
 * so try both candidate locations rather than assuming one; the `name` check
 * guards against accidentally picking up an unrelated package.json.
 */
function resolveServerVersion(): string {
	for (const candidate of ["./package.json", "../package.json"]) {
		try {
			const candidatePath = fileURLToPath(new URL(candidate, import.meta.url));
			const parsed = JSON.parse(readFileSync(candidatePath, "utf8")) as { name?: string; version?: string };
			if (parsed.name === "gatekeeper-mcp" && typeof parsed.version === "string") {
				return parsed.version;
			}
		} catch {
			// Try the next candidate; fall through to the default below.
		}
	}
	return "0.0.0";
}

const SERVER_VERSION = resolveServerVersion();

function describeError(error: unknown): string {
	if (error instanceof RegistryParseError) {
		return error.issues.map(formatRegistryIssue).join("; ");
	}
	if (error instanceof RegistryReadError || error instanceof GitDiffError || error instanceof LanePresetReadError) {
		return error.reason;
	}
	if (error instanceof LanePresetParseError) {
		return error.issues.map((issue) => `${issue.file} ${issue.path}: ${issue.message}`).join("; ");
	}
	return error instanceof Error ? error.message : String(error);
}

function formatHumanReport(verdict: Verdict): string {
	const summary = renderSummary(verdict);
	const explain = renderExplain(verdict);
	return [...summary, "", "Explain:", ...explain].join("\n");
}

// -------------------------------------------------------------------------
// gatekeeper_check
// -------------------------------------------------------------------------

// A plain .strict() object (not further wrapped in .refine()/.superRefine())
// on purpose: the MCP SDK's normalizeObjectSchema only recognizes raw shapes
// and actual ZodObject instances (it looks for `.shape`) when building the
// tool's advertised JSON Schema for ListTools -- a ZodEffects wrapper (what
// .refine()/.superRefine() produce) has no `.shape` of its own, so the SDK
// falls back to an empty `{}` schema for display purposes even though
// runtime parsing still enforces the refinement. To keep the schema clients
// see accurate (registryDir required, five optional fields, no extras), the
// base/staged/workingTree mutual-exclusion check lives in
// assertDiffModeExclusivity below instead of in the zod schema.
const gatekeeperCheckInputSchema = z
	.object({
		registryDir: z.string().min(1, "registryDir is required"),
		base: z.string().min(1).optional(),
		staged: z.boolean().optional(),
		workingTree: z.boolean().optional(),
		repo: z.string().min(1).optional(),
		actor: z.string().min(1).optional(),
	})
	.strict();

export type GatekeeperCheckParams = z.infer<typeof gatekeeperCheckInputSchema>;

/**
 * base, staged, and workingTree select three different diff modes (see
 * src/providers/gitdiff.ts's DiffRangeOptions / CLI check's --base/--staged/
 * --working-tree Option.conflicts()); enforced here (not in the zod schema,
 * see the comment above) so every entry point into this module -- the MCP
 * tool handler and direct callers alike -- rejects an ambiguous combination
 * instead of silently picking one.
 */
function assertDiffModeExclusivity(params: GatekeeperCheckParams): void {
	const modesSet = [params.base !== undefined, params.staged === true, params.workingTree === true].filter(
		Boolean,
	).length;
	if (modesSet > 1) {
		throw new Error("base, staged, and workingTree are mutually exclusive; set at most one diff mode");
	}
}

/**
 * Run local gitdiff + registry load (with lane presets) + evaluate — the
 * same composition CLI `gatekeeper check` (src/commands/check.ts) uses, minus
 * its fail-open --json degrade branches: this tool throws on any
 * infrastructure/config fault so the MCP SDK surfaces it as an isError
 * result instead of a silent pass/degraded verdict.
 */
export async function runGatekeeperCheck(
	params: GatekeeperCheckParams,
	cwd: string,
): Promise<{ verdict: Verdict; text: string }> {
	assertDiffModeExclusivity(params);

	const registryDir = path.resolve(cwd, params.registryDir);
	const { registry } = await loadRegistryWithLanePresets(registryDir);

	const repo = await resolveRepo(cwd, params.repo);
	const actor = await resolveActor(cwd, params.actor);

	const rangeOptions: DiffRangeOptions = { staged: params.staged, workingTree: params.workingTree };
	if (!params.staged && !params.workingTree) {
		rangeOptions.base = await resolveBaseRef(cwd, params.base);
	}
	const withoutPatches = await getChangedFiles(cwd, rangeOptions);
	const changedFiles = await attachPatches(cwd, withoutPatches, registry.contracts, rangeOptions);

	const verdict = evaluate({ repo, actor, changedFiles, registry });
	const json = renderVerdictJson(verdict);
	const human = formatHumanReport(verdict);
	const text = `${json}\n\n${human}`;
	return { verdict, text };
}

// -------------------------------------------------------------------------
// gatekeeper_validate
// -------------------------------------------------------------------------

const gatekeeperValidateInputSchema = z
	.object({
		registryDir: z.string().min(1, "registryDir is required"),
		strict: z.boolean().optional(),
	})
	.strict();

export type GatekeeperValidateParams = z.infer<typeof gatekeeperValidateInputSchema>;

/**
 * Run `gatekeeper validate` semantics via the CLI's runValidate.
 *
 * runValidate (src/commands/validate.ts) is a CLI-shaped function: by
 * default it writes human/warning lines straight to process.stdout/stderr
 * and returns an exit code instead of returning text. This MCP server is a
 * *long-lived, single process handling concurrent JSON-RPC calls* over one
 * real stdout (the stdio transport's wire) -- unlike a one-shot CLI
 * invocation, another in-flight tool call's actual protocol response frame
 * can be mid-flight on process.stdout at the same await point. Globally
 * monkey-patching process.stdout/stderr.write for the duration of this call
 * (an earlier version of this function did exactly that, mirroring
 * src/action.ts's captureCommand) would swallow that other call's JSON-RPC
 * frame into *this* function's capture buffer instead of letting it reach
 * the transport, corrupting the protocol stream and starving the other
 * caller until its request times out. A per-call lock would only serialize
 * this tool's own concurrent invocations against each other -- it does
 * nothing for a concurrent gatekeeper_check/gatekeeper_brief call, which
 * write their own responses to the same real stdout at the same time. The
 * only sound fix is to never touch the global stream at all: runValidate's
 * optional stdout/stderr sink parameters (additive, CLI-default-preserving)
 * let this function collect its own output in a local buffer instead.
 *
 * Fail direction: exit 2 (registry schema/parse/read failure) is an
 * infrastructure-shaped fault, so it throws (isError). Exit 1 (--strict with
 * warnings present) is a legitimate negative *result*, not a call failure —
 * same treatment as gatekeeper_check returning a "block" verdict without
 * throwing — so it is returned normally with ok:false for the caller to act on.
 */
export async function runGatekeeperValidate(
	params: GatekeeperValidateParams,
	cwd: string,
): Promise<{ exitCode: number; ok: boolean; text: string }> {
	const registryDir = path.resolve(cwd, params.registryDir);
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	const exitCode = await runValidate({
		registry: registryDir,
		strict: params.strict,
		stdout: (chunk) => stdoutChunks.push(chunk),
		stderr: (chunk) => stderrChunks.push(chunk),
	});
	const text = [stdoutChunks.join("").trimEnd(), stderrChunks.join("").trimEnd()]
		.filter((part) => part.length > 0)
		.join("\n");

	if (exitCode === 2) {
		throw new Error(`GATEKEEPER VALIDATE FAILED: ${text || "registry validation failed (exit 2)"}`);
	}
	return { exitCode, ok: exitCode === 0, text };
}

// -------------------------------------------------------------------------
// gatekeeper_brief
// -------------------------------------------------------------------------

const gatekeeperBriefInputSchema = z
	.object({
		path: z.string().min(1, "path is required"),
	})
	.strict();

export type GatekeeperBriefParams = z.infer<typeof gatekeeperBriefInputSchema>;

/**
 * Read an init/triage brief file (produced by `gatekeeper init` /
 * `gatekeeper triage`) verbatim, so an MCP client's own agent can load it and
 * follow the matching docs/roles/ role card (registry-drafter, deep-reasoner, ...).
 */
export async function runGatekeeperBrief(params: GatekeeperBriefParams, cwd: string): Promise<{ text: string }> {
	const resolved = path.resolve(cwd, params.path);
	try {
		const body = await readFile(resolved, "utf8");
		return { text: body };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`GATEKEEPER BRIEF FAILED: could not read brief file "${resolved}": ${detail}`);
	}
}

// -------------------------------------------------------------------------
// Server assembly
// -------------------------------------------------------------------------

export interface GatekeeperMcpServerOptions {
	/**
	 * Working directory used to resolve relative registryDir/base/path
	 * arguments and run git commands. Defaults to process.cwd() at call time
	 * (there is no per-call session cwd in the stdio transport). Overridable
	 * for tests so they don't have to mutate the real process cwd.
	 */
	cwd?: string;
}

/** Builds (but does not connect) the Gatekeeper MCP server: three tools, no transport. */
export function createGatekeeperMcpServer(options: GatekeeperMcpServerOptions = {}): McpServer {
	const resolveCwd = (): string => options.cwd ?? process.cwd();

	const server = new McpServer({ name: "gatekeeper-mcp", version: SERVER_VERSION }, { capabilities: { tools: {} } });

	server.registerTool(
		"gatekeeper_check",
		{
			title: "Gatekeeper Check",
			description:
				"Run a local Gatekeeper contract check against a git diff (base...head, --staged, or the working tree). " +
				"Returns verdict JSON plus a human-readable explain trace. Use before/after edits to see which contracts a change hits.",
			inputSchema: gatekeeperCheckInputSchema,
		},
		async (params) => {
			try {
				const { text } = await runGatekeeperCheck(params, resolveCwd());
				return { content: [{ type: "text", text }] };
			} catch (error) {
				throw new Error(`GATEKEEPER CHECK FAILED: ${describeError(error)}`);
			}
		},
	);

	server.registerTool(
		"gatekeeper_validate",
		{
			title: "Gatekeeper Validate",
			description:
				"Validate a contract registry: schema check plus glob/foreign-key lint. " +
				"With strict:true, warnings are reported as a non-ok result instead of being silently accepted.",
			inputSchema: gatekeeperValidateInputSchema,
		},
		async (params) => {
			try {
				const { text, ok, exitCode } = await runGatekeeperValidate(params, resolveCwd());
				const status = ok ? "OK" : `NOT OK (exit ${exitCode})`;
				return { content: [{ type: "text", text: `gatekeeper validate: ${status}\n${text}`.trimEnd() }] };
			} catch (error) {
				// runGatekeeperValidate already prefixes its own thrown errors with
				// "GATEKEEPER VALIDATE FAILED:" (unlike gatekeeper_check's raw-reason
				// errors, prefixed once here at the protocol boundary) -- do not
				// prepend it again here, or the isError text doubles the prefix.
				throw new Error(describeError(error));
			}
		},
	);

	server.registerTool(
		"gatekeeper_brief",
		{
			title: "Gatekeeper Brief",
			description:
				"Read an init/triage brief file verbatim (produced by `gatekeeper init` / `gatekeeper triage`), " +
				"for a client-side agent to execute the matching docs/roles/ role card against.",
			inputSchema: gatekeeperBriefInputSchema,
		},
		async (params) => {
			try {
				const { text } = await runGatekeeperBrief(params, resolveCwd());
				return { content: [{ type: "text", text }] };
			} catch (error) {
				throw new Error(describeError(error));
			}
		},
	);

	return server;
}

async function main(): Promise<void> {
	const server = createGatekeeperMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

// Only auto-start the stdio transport when this module is run directly
// (`node dist/index.js` / `tsx index.ts` as an MCP server process) — not when
// imported by tests or another module, which would otherwise hang on stdin.
const isDirectlyExecuted = (() => {
	const entry = process.argv[1];
	if (!entry) {
		return false;
	}
	return import.meta.url === new URL(`file://${path.resolve(entry)}`).href;
})();

if (isDirectlyExecuted) {
	main().catch((error) => {
		process.stderr.write(`gatekeeper-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
