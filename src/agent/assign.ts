import type { RolesPolicy, RolesPolicyTier } from "../roles/policy.js";
import { vendorOfModelId } from "../roles/policy.js";
import type { DetectedAgentCli } from "./detect.js";

/**
 * Pure role-tier -> local-CLI assignment: given "which agent CLIs did
 * detectAgentClis find on this machine" and "which model vendors does each
 * roles-policy.yaml tier prefer, in order", pick a CLI (or, for a
 * multi-count tier like `reviewer`, several distinct-vendor CLIs) per tier.
 * Mirrors src/roles/policy.ts's selectTierModels cross-vendor-fill algorithm,
 * but selecting installed CLIs instead of model ids. No I/O, no randomness --
 * same pure-selection posture as selectTierModels.
 */

export interface RoleAssignment {
	role: string;
	cliName: string;
	vendor: string;
	commandTemplate: string;
	rationale: string;
}

export interface AssignRolesInput {
	detected: readonly DetectedAgentCli[];
	rolesPolicy: RolesPolicy;
}

export interface AssignRolesResult {
	assignments: RoleAssignment[];
	warnings: string[];
}

/** The vendor preference order for one tier, derived from its `prefer` model ids, deduplicated while preserving order. */
function preferredVendorOrder(tier: RolesPolicyTier): string[] {
	const seen = new Set<string>();
	const vendors: string[] = [];
	for (const modelId of tier.prefer) {
		const vendor = vendorOfModelId(modelId);
		if (!seen.has(vendor)) {
			seen.add(vendor);
			vendors.push(vendor);
		}
	}
	return vendors;
}

/**
 * Orders `eligible` CLIs by the tier's preferred-vendor sequence (within a
 * vendor, detection order is preserved). A CLI whose vendor isn't in the
 * tier's `prefer` list at all is deliberately *not* included here -- per the
 * "take the CLI of the first *preferred* vendor with something available"
 * contract, a tier with detected-but-unpreferred-vendor CLIs and nothing
 * else still reports "no detected agent CLI matches roles-policy's preferred
 * vendors" rather than silently assigning an arbitrary out-of-policy vendor.
 */
function orderCandidates(
	eligible: readonly DetectedAgentCli[],
	preferredVendors: readonly string[],
): DetectedAgentCli[] {
	const ordered: DetectedAgentCli[] = [];
	for (const vendor of preferredVendors) {
		for (const cli of eligible) {
			if (cli.vendor === vendor && !ordered.includes(cli)) {
				ordered.push(cli);
			}
		}
	}
	return ordered;
}

/**
 * Picks up to `tier.count` CLIs from `ordered`. When `tier.crossVendor` is
 * set, a first pass fills distinct-vendor slots (same "prefer diversity, but
 * never leave a slot empty" posture as selectTierModels); any slot still
 * unmet after that is filled from whatever's left, regardless of vendor
 * repeats, with a warning recorded.
 */
function selectForTier(
	ordered: readonly DetectedAgentCli[],
	tier: RolesPolicyTier,
	warnings: string[],
	tierName: string,
): DetectedAgentCli[] {
	if (!tier.crossVendor) {
		return ordered.slice(0, tier.count);
	}
	const seenVendors = new Set<string>();
	const primary: DetectedAgentCli[] = [];
	for (const cli of ordered) {
		if (seenVendors.has(cli.vendor)) {
			continue;
		}
		seenVendors.add(cli.vendor);
		primary.push(cli);
		if (primary.length >= tier.count) {
			break;
		}
	}
	if (primary.length < tier.count) {
		for (const cli of ordered) {
			if (primary.length >= tier.count) {
				break;
			}
			if (!primary.includes(cli)) {
				primary.push(cli);
			}
		}
		if (primary.length > 0) {
			warnings.push(
				`${tierName} tier could not fill a fully cross-vendor set from detected agent CLIs -- some selections share a vendor`,
			);
		}
	}
	return primary;
}

/**
 * Assigns each roles-policy.yaml tier (deep-reasoner/coder/reviewer, or any
 * future tier) a local agent CLI: a CLI is only eligible for a tier when its
 * `tiers` list (see KNOWN_AGENT_CLIS) declares support for that tier name,
 * then candidates are ranked by the tier's `prefer` vendor order and picked
 * per selectForTier above. A tier with zero eligible CLIs, zero vendor
 * matches, or fewer matches than `tier.count` each produce a warning rather
 * than throwing -- role assignment is advisory input for
 * `governance/agents.yaml`, not a hard requirement.
 */
export function assignRolesToClis(input: AssignRolesInput): AssignRolesResult {
	const { detected, rolesPolicy } = input;
	const warnings: string[] = [];
	const assignments: RoleAssignment[] = [];

	for (const [tierName, tier] of Object.entries(rolesPolicy.tiers)) {
		const eligible = detected.filter((cli) => cli.tiers.includes(tierName));
		if (eligible.length === 0) {
			warnings.push(
				`${tierName} tier: no detected agent CLI declares support for this role` +
					(detected.length > 0
						? ` (detected: ${detected.map((cli) => cli.name).join(", ")})`
						: " (no agent CLI detected on PATH)"),
			);
			continue;
		}

		const preferredVendors = preferredVendorOrder(tier);
		const ordered = orderCandidates(eligible, preferredVendors);
		const selected = selectForTier(ordered, tier, warnings, tierName);

		if (selected.length === 0) {
			warnings.push(
				`${tierName} tier: no detected agent CLI matches roles-policy's preferred vendors (${tier.prefer.join(" > ")})`,
			);
			continue;
		}
		if (selected.length < tier.count) {
			warnings.push(`${tierName} tier: only ${selected.length}/${tier.count} agent CLI(s) available to fill this role`);
		}

		for (const cli of selected) {
			assignments.push({
				role: tierName,
				cliName: cli.name,
				vendor: cli.vendor,
				commandTemplate: cli.commandTemplate,
				rationale: `${cli.name} (${cli.vendor}) matched roles-policy tier "${tierName}"'s preference order (${tier.prefer.join(" > ")})`,
			});
		}
	}

	return { assignments, warnings };
}
