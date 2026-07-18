import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";
import { z } from "zod";

/**
 * roles-policy.yaml: which model each Gatekeeper role tier prefers (in
 * priority order), and how many concurrent instances a tier needs (e.g. the
 * reviewer tier's cross-vendor double review). This module never calls a
 * model itself -- it only resolves *which* model id a role should be handed
 * to, against whichever providers pi has actually been configured with.
 * Zero-model invariant: parsing/selection here is pure data plumbing.
 */

export interface RolesPolicyTier {
	prefer: string[];
	count: number;
	crossVendor: boolean;
}

export interface RolesPolicy {
	apiVersion: string;
	tiers: Record<string, RolesPolicyTier>;
}

export class RolesPolicyParseError extends Error {
	readonly file: string;
	readonly issues: string[];

	constructor(issues: string[], file: string) {
		super(issues.map((issue) => `${file}: ${issue}`).join("\n"));
		this.name = "RolesPolicyParseError";
		this.file = file;
		this.issues = issues;
	}
}

export class RolesPolicyReadError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(reason);
		this.name = "RolesPolicyReadError";
		this.reason = reason;
		if (options?.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

const tierSchema = z
	.object({
		prefer: z.array(z.string().min(1)).min(1, "prefer must list at least one model id"),
		count: z.number().int().positive().optional(),
		cross_vendor: z.boolean().optional(),
	})
	.strict();

const rolesPolicyFileSchema = z
	.object({
		apiVersion: z.literal("gatekeeper/v1"),
		tiers: z.record(z.string(), tierSchema),
	})
	.strict();

function yamlPath(segments: PropertyKey[]): string {
	return segments.reduce<string>((result, segment) => {
		return typeof segment === "number" ? `${result}[${segment}]` : `${result}.${String(segment)}`;
	}, "$");
}

function describeZodError(error: z.ZodError): string[] {
	return error.issues.map((issue) => `${yamlPath(issue.path)}: ${issue.message}`);
}

/** Parse roles-policy.yaml content. Pure -- no I/O. Mirrors engine/registry.ts's yaml-guard pattern. */
export function parseRolesPolicy(content: string, file = "roles-policy.yaml"): RolesPolicy {
	const document = parseDocument(content, { prettyErrors: false, uniqueKeys: true });
	if (document.errors.length > 0) {
		throw new RolesPolicyParseError(
			document.errors.map((error) => error.message),
			file,
		);
	}

	let value: unknown;
	try {
		value = document.toJS();
	} catch (error) {
		throw new RolesPolicyParseError([error instanceof Error ? error.message : String(error)], file);
	}

	const result = rolesPolicyFileSchema.safeParse(value);
	if (!result.success) {
		throw new RolesPolicyParseError(describeZodError(result.error), file);
	}

	const tiers: Record<string, RolesPolicyTier> = {};
	for (const [name, tier] of Object.entries(result.data.tiers)) {
		tiers[name] = {
			prefer: tier.prefer,
			count: tier.count ?? 1,
			crossVendor: tier.cross_vendor ?? false,
		};
	}
	return { apiVersion: result.data.apiVersion, tiers };
}

/**
 * Resolve the default roles-policy.yaml shipped at the package root. In
 * source form this module lives at src/roles/policy.ts (repo root is two
 * directories up); tsup bundles everything into a single dist/cli.js (repo
 * root is one directory up from dist/). Same dual-candidate approach as
 * gate/presets.ts's defaultLanePresetDirectory. This candidate always exists
 * in a correctly-installed package -- callers that fail to load it (see
 * resolveRolesPolicyPath) should treat that as an anomaly, not routine
 * "not configured".
 */
export function defaultRolesPolicyPath(moduleUrl: string | URL = import.meta.url): string {
	const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
	const bundledCandidate = path.resolve(moduleDirectory, "../roles-policy.yaml");
	const sourceCandidate = path.resolve(moduleDirectory, "../../roles-policy.yaml");
	return [bundledCandidate, sourceCandidate].find((candidate) => existsSync(candidate)) ?? sourceCandidate;
}

/**
 * Resolve which roles-policy.yaml a command should read: an explicit
 * override always wins (no further fallback -- an explicit path that fails
 * to load is the caller's problem, not silently retried elsewhere); absent
 * an override, prefer `<cwd>/roles-policy.yaml` when a consuming repo ships
 * its own, otherwise fall back to the package-shipped default. Shared by
 * `doctor`'s capability check and `triage`'s dispatch validation so both
 * commands resolve the same file the same way.
 */
export function resolveRolesPolicyPath(cwd: string, override?: string): string {
	if (override) {
		return override;
	}
	const cwdPath = path.join(cwd, "roles-policy.yaml");
	return existsSync(cwdPath) ? cwdPath : defaultRolesPolicyPath();
}

/** Read + parse roles-policy.yaml off disk. All I/O lives here. */
export async function loadRolesPolicy(filePath: string = defaultRolesPolicyPath()): Promise<RolesPolicy> {
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch (error) {
		throw new RolesPolicyReadError(
			`failed to read roles-policy ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	return parseRolesPolicy(content, filePath);
}

/**
 * Generic, adapter-agnostic snapshot of what one agent runtime's local config
 * reports about vendor/model availability. Any runtime adapter (pi today;
 * others in the future) can produce one of these -- doctor/triage consume
 * this shape without caring which adapter built it. This module never calls
 * a model itself, zero-model invariant holds regardless of adapter.
 */
export interface RuntimeAvailability {
	/**
	 * True when at least one of auth.json/models.json could be read and
	 * parsed. False only when *both* sources failed -- only then does
	 * selectTierModels degrade every tier to "preference order only,
	 * nothing confirmable" rather than making per-candidate confirmed/
	 * unknown/unavailable decisions from whichever source(s) did work.
	 * auth.json and models.json are read independently (neither's failure
	 * short-circuits reading the other) -- see piRuntimeAvailability.
	 */
	known: boolean;
	/** Whether auth.json specifically could be read and parsed as a vendor-credential map. */
	authKnown: boolean;
	/**
	 * Whether models.json specifically could be read and parsed (see
	 * extractConfirmedModelIds). models.json is optional, so this being
	 * false is a routine, silent state, not a fault worth its own warning --
	 * only authKnown false surfaces a `reason`.
	 */
	modelsKnown: boolean;
	/** Vendor ids (the part before "/" in a model id, e.g. "anthropic") that the runtime has credentials configured for. Empty when authKnown is false. */
	vendors: Set<string>;
	/**
	 * `vendor/model` ids explicitly declared in the runtime's models.json
	 * (`providers.<vendor>.models[].id`, reassembled as `<vendor>/<id>`).
	 * This is *additive* confirmation on top of `vendors`, not an exhaustive
	 * allowlist: built-in provider models are available through `vendors`
	 * credentials alone and are typically never listed here (see
	 * `candidateStatus`). Undefined when modelsKnown is false.
	 */
	models?: Set<string>;
	/** Human-readable reason when authKnown is false, for surfacing in doctor/triage output. */
	reason?: string;
}

/**
 * Backward-compatible alias: pi is the only concrete adapter shipped today
 * and its shape happens to be the generic shape. Prefer `RuntimeAvailability`
 * in new adapter-agnostic code.
 */
export type PiProviderAvailability = RuntimeAvailability;

/**
 * A pluggable source of RuntimeAvailability for one agent runtime. Any future
 * adapter (beyond pi) implements a function of this shape; `piRuntimeAvailability`
 * below is the default (and, today, only shipped) implementation.
 */
export type RuntimeAvailabilityProvider<TOptions = Record<string, unknown>> = (
	options?: TOptions,
) => Promise<RuntimeAvailability>;

export interface PiRuntimeAvailabilityOptions {
	/** Defaults to ~/.pi/agent. Injectable so tests never touch the real home directory. */
	piConfigDir?: string;
	/** Injectable file reader for fixture-backed tests. */
	readFile?: (filePath: string) => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthenticatedValue(value: unknown): boolean {
	if (value === null || value === undefined || value === false) {
		return false;
	}
	if (typeof value === "string") {
		return value.length > 0;
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	if (isRecord(value)) {
		return Object.keys(value).length > 0;
	}
	return Boolean(value);
}

/**
 * Strip `//` line comments and C-style block comments from JSONC text,
 * string-aware so that occurrences inside JSON string values (e.g. a
 * `"baseUrl": "http://..."`) are left untouched.
 */
function stripJsonComments(text: string): string {
	let output = "";
	let inString = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			output += ch;
			if (ch === "\\" && i + 1 < text.length) {
				output += text[i + 1];
				i += 1;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			output += ch;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			i += 1;
			while (i + 1 < text.length && text[i + 1] !== "\n") {
				i += 1;
			}
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			i += 1;
			while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
				i += 1;
			}
			i += 1;
			continue;
		}
		output += ch;
	}
	return output;
}

/** Drop trailing commas before `}`/`]`, string-aware. Runs after stripJsonComments. */
function stripTrailingCommas(text: string): string {
	let output = "";
	let inString = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			output += ch;
			if (ch === "\\" && i + 1 < text.length) {
				output += text[i + 1];
				i += 1;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			output += ch;
			continue;
		}
		if (ch === ",") {
			let lookahead = i + 1;
			while (lookahead < text.length && /\s/.test(text[lookahead] ?? "")) {
				lookahead += 1;
			}
			if (text[lookahead] === "}" || text[lookahead] === "]") {
				continue; // drop this trailing comma
			}
		}
		output += ch;
	}
	return output;
}

/**
 * pi's models.json tolerates JSONC (line and block comments, trailing
 * commas) -- see `~/.pi/agent/models.json` in pi's own docs. This is a
 * minimal, self-contained tolerant parse (comment/trailing-comma stripping
 * only; no single-quoted strings or unquoted keys, which pi's own examples
 * never use) rather than a new dependency.
 */
function parseJsonc(text: string): unknown {
	return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

/**
 * pi's real models.json shape is `{ "providers": { "<vendor>": { "models": [
 * { "id": "<model>", ... }, ... ], ... }, ... } }` (see pi's models.json
 * docs) -- not a flat `string[]`. Reassemble each entry into this repo's
 * `<vendor>/<model>` id convention. Any shape mismatch (missing/malformed
 * `providers`, a provider without a `models` array, a model without a
 * string `id`) is skipped rather than thrown -- best-effort extraction over
 * an advisory, external file.
 */
function extractConfirmedModelIds(value: unknown): Set<string> {
	const ids = new Set<string>();
	if (!isRecord(value) || !isRecord(value.providers)) {
		return ids;
	}
	for (const [vendor, providerConfig] of Object.entries(value.providers)) {
		if (!isRecord(providerConfig) || !Array.isArray(providerConfig.models)) {
			continue;
		}
		for (const model of providerConfig.models) {
			if (isRecord(model) && typeof model.id === "string" && model.id.length > 0) {
				ids.add(`${vendor}/${model.id}`);
			}
		}
	}
	return ids;
}

/**
 * Default RuntimeAvailabilityProvider: reads pi's local auth/model manifests
 * under `~/.pi/agent/`. `auth.json` is a `{ "<vendor>": <truthy credential> }`
 * map (pi's documented shape). pi is the only agent runtime this repo ships
 * an adapter for today; other runtimes (Claude Code, Codex, Cursor, ...) can
 * plug in their own RuntimeAvailabilityProvider without doctor/triage caring
 * which one produced the snapshot -- an unresolvable/unknown runtime just
 * degrades to `known: false` the same way an unreadable pi config does.
 *
 * auth.json and models.json are read and parsed **independently** -- a
 * broken/missing/unreadable auth.json must never prevent models.json's
 * confirmations from being honored (and models.json's absence, which is
 * normal since it's optional, must never suppress vendor-credential
 * availability). Runtime availability is advisory input for a
 * briefing/doctor check, never a merge gate, so neither file failing throws.
 */
export const piRuntimeAvailability: RuntimeAvailabilityProvider<PiRuntimeAvailabilityOptions> = async (
	options = {},
) => {
	const dir = options.piConfigDir ?? path.join(homedir(), ".pi", "agent");
	const readTextFile = options.readFile ?? ((filePath: string) => readFile(filePath, "utf8"));
	const authPath = path.join(dir, "auth.json");

	let vendors = new Set<string>();
	let authKnown = false;
	let reason: string | undefined;
	try {
		const authRaw = await readTextFile(authPath);
		try {
			const authValue: unknown = JSON.parse(authRaw);
			if (!isRecord(authValue)) {
				reason = `${authPath} must be a JSON object`;
			} else {
				vendors = new Set(Object.keys(authValue).filter((vendor) => isAuthenticatedValue(authValue[vendor])));
				authKnown = true;
			}
		} catch (error) {
			reason = `${authPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
		}
	} catch (error) {
		reason = `failed to read ${authPath}: ${error instanceof Error ? error.message : String(error)}`;
	}

	let models: Set<string> | undefined;
	let modelsKnown = false;
	try {
		const modelsRaw = await readTextFile(path.join(dir, "models.json"));
		models = extractConfirmedModelIds(parseJsonc(modelsRaw));
		modelsKnown = true;
	} catch {
		// models.json is optional and/or may fail to parse -- silently degrade (see
		// candidateStatus: absent models data just means "no models.json confirmations").
	}

	return {
		known: authKnown || modelsKnown,
		authKnown,
		modelsKnown,
		vendors,
		...(models ? { models } : {}),
		...(reason ? { reason } : {}),
	};
};

/**
 * A vendor credential in auth.json only proves pi *can* reach that vendor --
 * not that any specific model id is actually enabled/reachable. "confirmed"
 * means models.json explicitly names this exact `vendor/model` id;
 * "unknown" means only vendor-level credentials back it up. Confirmation is
 * *additive*, not exclusive: pi's built-in provider models are available
 * through vendor credentials alone and are normally never listed in
 * models.json (which mainly declares custom/local providers and explicit
 * overrides), so a model's absence from models.json must never demote it
 * from "unknown" to "unavailable".
 */
export type ModelConfirmationStatus = "confirmed" | "unknown";

export interface TierModelCandidate {
	modelId: string;
	status: ModelConfirmationStatus;
}

export interface TierModelSelection {
	tier: string;
	prefer: string[];
	requestedCount: number;
	crossVendor: boolean;
	/** Whether runtime availability could be determined at all (see RuntimeAvailability.known). */
	availabilityKnown: boolean;
	/** Chosen models, in preference order, up to requestedCount. Empty when availabilityKnown is false. */
	selected: TierModelCandidate[];
	warnings: string[];
}

/** The vendor id (the part before "/") of a `vendor/model` id string. Exported for dispatch validation elsewhere. */
export function vendorOfModelId(modelId: string): string {
	return modelId.split("/")[0] ?? modelId;
}

type CandidateStatusResult = ModelConfirmationStatus | "unavailable";

/**
 * Three-state availability for one candidate model id: an explicit
 * models.json hit is checked first (confirmed) independently of vendor
 * credentials; failing that, a vendor-level credential still makes the
 * candidate selectable, just unconfirmed (unknown); only when neither signal
 * backs it is the candidate excluded entirely (unavailable).
 */
function candidateStatus(modelId: string, availability: RuntimeAvailability): CandidateStatusResult {
	if (availability.models?.has(modelId)) {
		return "confirmed";
	}
	if (availability.vendors.has(vendorOfModelId(modelId))) {
		return "unknown";
	}
	return "unavailable";
}

/** Pick the top `count` available models for a tier from its preference order. Pure -- no I/O. */
export function selectTierModels(
	tierName: string,
	tier: RolesPolicyTier,
	availability: RuntimeAvailability,
): TierModelSelection {
	const base = {
		tier: tierName,
		prefer: tier.prefer,
		requestedCount: tier.count,
		crossVendor: tier.crossVendor,
	};

	if (!availability.known) {
		return {
			...base,
			availabilityKnown: false,
			selected: [],
			warnings: [
				`cannot confirm available models (${availability.reason ?? "agent runtime config unreadable"}); showing preference order only -- verify manually`,
			],
		};
	}

	const candidates: TierModelCandidate[] = [];
	for (const modelId of tier.prefer) {
		const status = candidateStatus(modelId, availability);
		if (status !== "unavailable") {
			candidates.push({ modelId, status });
		}
	}

	let selected: TierModelCandidate[];
	if (tier.crossVendor) {
		const seenVendors = new Set<string>();
		const primary: TierModelCandidate[] = [];
		for (const candidate of candidates) {
			const vendor = vendorOfModelId(candidate.modelId);
			if (seenVendors.has(vendor)) {
				continue;
			}
			seenVendors.add(vendor);
			primary.push(candidate);
			if (primary.length >= tier.count) {
				break;
			}
		}
		for (const candidate of candidates) {
			if (primary.length >= tier.count) {
				break;
			}
			if (!primary.some((entry) => entry.modelId === candidate.modelId)) {
				primary.push(candidate);
			}
		}
		selected = primary;
	} else {
		selected = candidates.slice(0, tier.count);
	}

	const warnings: string[] = [];
	if (selected.length === 0) {
		warnings.push(
			`${tierName} tier has no available model under the current agent runtime config (preference: ${tier.prefer.join(" > ")})`,
		);
	} else if (selected.length < tier.count) {
		warnings.push(`${tierName} tier has only ${selected.length}/${tier.count} available model(s)`);
	}
	if (
		tier.crossVendor &&
		selected.length > 1 &&
		new Set(selected.map((entry) => vendorOfModelId(entry.modelId))).size < selected.length
	) {
		warnings.push(`${tierName} tier could not fill a fully cross-vendor set -- some selections share a vendor`);
	}
	const unconfirmedCount = selected.filter((entry) => entry.status === "unknown").length;
	if (unconfirmedCount > 0) {
		warnings.push(
			`${tierName} tier has ${unconfirmedCount} model-level-unconfirmed selection(s) (vendor credentialed only, no models.json confirmation)`,
		);
	}

	return { ...base, availabilityKnown: true, selected, warnings };
}

/** Convenience: resolve every tier in a roles-policy against one availability snapshot. Pure -- no I/O. */
export function selectAllTiers(policy: RolesPolicy, availability: RuntimeAvailability): TierModelSelection[] {
	return Object.entries(policy.tiers).map(([name, tier]) => selectTierModels(name, tier, availability));
}
