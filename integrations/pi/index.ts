/**
 * Gatekeeper pi extension — thin wrapper over the main-package engine.
 * All matching / verdict logic lives in ../../src; this file only registers
 * tools/commands and assembles provider + engine calls.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { formatRegistryIssue, RegistryParseError } from "../../src/engine/registry.js";
import type { Verdict } from "../../src/engine/types.js";
import { evaluate } from "../../src/engine/verdict.js";
import { LanePresetParseError, LanePresetReadError, loadRegistryWithLanePresets } from "../../src/gate/presets.js";
import { RegistryReadError } from "../../src/providers/fsregistry.js";
import {
	attachPatches,
	GitDiffError,
	getChangedFiles,
	resolveActor,
	resolveBaseRef,
	resolveRepo,
} from "../../src/providers/gitdiff.js";
import { renderExplain, renderSummary, renderVerdictJson } from "../../src/render/explain.js";

// Re-export host types for tests and consumers (resolvable via this package's devDependency).
export type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition };

/** Alias kept for test readability — same as AgentToolResult (no isError field). */
export type ToolResult<T = unknown> = AgentToolResult<T>;

/** Tool execute context is the host ExtensionContext (cwd is required). */
export type ExtensionToolContext = ExtensionContext;

export interface GatekeeperCheckParams {
	registryDir: string;
	base?: string;
}

export interface TextContent {
	type: "text";
	text: string;
}

/** Command registration shape (handler returns Promise<void> per RegisteredCommand). */
export interface CommandDefinition {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

/** JSON Schema for gatekeeper_check (avoids hard dep on TypeBox at runtime). */
const gatekeeperCheckParameters = {
	type: "object",
	properties: {
		registryDir: {
			type: "string",
			description: "Path to the contract registry directory (contains policy.yaml and contracts/).",
		},
		base: {
			type: "string",
			description: "Optional git base ref for three-dot diff (defaults to main/master auto-detect).",
		},
	},
	required: ["registryDir"],
	additionalProperties: false,
} as const;

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

function resolveCwd(ctx: { cwd: string }): string {
	if (ctx.cwd.length > 0) {
		return ctx.cwd;
	}
	return process.cwd();
}

function formatHumanReport(verdict: Verdict): string {
	const summary = renderSummary(verdict);
	const explain = renderExplain(verdict);
	return [...summary, "", "Explain:", ...explain].join("\n");
}

/**
 * Run local gitdiff + registry load (with lane presets) + evaluate.
 * Shared by the tool execute path so tests can call the same assembly without
 * mocking ExtensionAPI internals.
 */
export async function runGatekeeperCheck(
	params: GatekeeperCheckParams,
	cwd: string,
): Promise<{ verdict: Verdict; text: string }> {
	const registryDir = path.resolve(cwd, params.registryDir);
	const { registry } = await loadRegistryWithLanePresets(registryDir);

	const repo = await resolveRepo(cwd);
	const actor = await resolveActor(cwd);
	const base = await resolveBaseRef(cwd, params.base);
	const rangeOptions = { base };
	const withoutPatches = await getChangedFiles(cwd, rangeOptions);
	const changedFiles = await attachPatches(cwd, withoutPatches, registry.contracts, rangeOptions);

	const verdict = evaluate({ repo, actor, changedFiles, registry });
	const json = renderVerdictJson(verdict);
	const human = formatHumanReport(verdict);
	const text = `${json}\n\n${human}`;
	return { verdict, text };
}

function buildInitGuidance(briefPath: string, briefBody: string): string {
	return [
		"You are running /gatekeeper-init.",
		`Brief file: ${briefPath}`,
		"",
		"## Task",
		"Using the brief below, draft `contracts/*.yaml` for this repository's contract registry.",
		"- Follow the contract YAML template in docs/SPEC.md (apiVersion gatekeeper/v1, name, level, authority, consumers).",
		"- Use only level values that already exist in the registry policy.yaml.",
		"- One contract per YAML file under contracts/.",
		"- Globs are relative to each repo root; keep them as tight as the brief supports.",
		"- When finished, run `gatekeeper validate` on the registry directory and fix any reported issues.",
		"",
		"## Brief",
		briefBody.trimEnd(),
	].join("\n");
}

function buildTriageGuidance(briefPath: string, briefBody: string): string {
	return [
		"You are running /gatekeeper-triage.",
		`Brief file: ${briefPath}`,
		"",
		"## Task",
		"Using the triage brief below, produce a demand-gate judgment file.",
		"- Delegate to the deep-reasoner role via pi-subagents (do not invent a weaker model).",
		"- Follow the deep-reasoner output template in the brief (whether to accept, why, suggested level, acceptance criteria, dispatch plan).",
		"- Model tier preference order is defined by the repo-root `roles-policy.yaml` (deep-reasoner tier).",
		"- When the judgment file is ready, run `gatekeeper triage --post` (with the appropriate --verdict-file / issue flags) to write the result back.",
		"",
		"## Brief",
		briefBody.trimEnd(),
	].join("\n");
}

async function readBriefOrNotify(
	rawArgs: string,
	ctx: ExtensionCommandContext,
	commandLabel: string,
): Promise<{ path: string; body: string } | undefined> {
	const briefPath = rawArgs.trim();
	if (!briefPath) {
		ctx.ui.notify(`${commandLabel}: missing brief file path. Usage: /${commandLabel} <path-to-brief.md>`, "error");
		return undefined;
	}

	const resolved = path.resolve(resolveCwd(ctx), briefPath);
	try {
		const body = await readFile(resolved, "utf8");
		return { path: resolved, body };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`${commandLabel}: could not read brief file "${resolved}": ${detail}`, "error");
		return undefined;
	}
}

function deliverGuidance(pi: ExtensionAPI, ctx: ExtensionCommandContext, guidance: string, notifyTitle: string): void {
	ctx.ui.notify(notifyTitle, "info");
	if (typeof pi.sendUserMessage === "function") {
		pi.sendUserMessage(guidance);
		return;
	}
	// Fallback when the host API cannot inject a user turn: surface full text via notify.
	ctx.ui.notify(guidance, "info");
}

export default function (pi: ExtensionAPI): void {
	// parameters uses plain JSON Schema (not TypeBox) so the parent package
	// does not need @sinclair/typebox / typebox at runtime; host validates args.
	const tool = {
		name: "gatekeeper_check",
		label: "Gatekeeper Check",
		description:
			"Run a local Gatekeeper contract check against the current git diff. " +
			"Returns verdict JSON plus a human-readable explain trace. " +
			"Use before/after edits to see which contracts a change hits.",
		parameters: gatekeeperCheckParameters,
		async execute(
			_toolCallId: string,
			params: GatekeeperCheckParams,
			_signal: AbortSignal | undefined,
			_onUpdate: ((partial: AgentToolResult<Verdict>) => void) | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<Verdict>> {
			const cwd = resolveCwd(ctx);
			try {
				const { verdict, text } = await runGatekeeperCheck(params, cwd);
				return {
					content: [{ type: "text", text }],
					details: verdict,
				};
			} catch (error) {
				// Host only sets isError when execute throws (see pi agent-loop executeToolCalls).
				// Returning { isError: true } is a no-op on the real AgentToolResult type.
				const reason = describeError(error);
				throw new Error(`GATEKEEPER CHECK FAILED: ${reason}`);
			}
		},
	};

	pi.registerTool(tool as unknown as ToolDefinition);

	pi.registerCommand("gatekeeper-init", {
		description: "Load an init brief and guide drafting contracts/*.yaml, then validate.",
		handler: async (args, ctx) => {
			const brief = await readBriefOrNotify(args, ctx, "gatekeeper-init");
			if (!brief) {
				return;
			}
			const guidance = buildInitGuidance(brief.path, brief.body);
			deliverGuidance(
				pi,
				ctx,
				guidance,
				"gatekeeper-init: brief loaded. Draft contracts/*.yaml per SPEC, then run gatekeeper validate.",
			);
		},
	});

	pi.registerCommand("gatekeeper-triage", {
		description: "Load a triage brief and guide deep-reasoner judgment + gatekeeper triage --post.",
		handler: async (args, ctx) => {
			const brief = await readBriefOrNotify(args, ctx, "gatekeeper-triage");
			if (!brief) {
				return;
			}
			const guidance = buildTriageGuidance(brief.path, brief.body);
			deliverGuidance(
				pi,
				ctx,
				guidance,
				"gatekeeper-triage: brief loaded. Delegate to deep-reasoner, then run gatekeeper triage --post.",
			);
		},
	});
}
