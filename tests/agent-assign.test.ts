import { describe, expect, it } from "vitest";

import { assignRolesToClis } from "../src/agent/assign.js";
import type { DetectedAgentCli } from "../src/agent/detect.js";
import type { RolesPolicy } from "../src/roles/policy.js";

function cli(
	overrides: Partial<DetectedAgentCli> & Pick<DetectedAgentCli, "name" | "vendor" | "tiers">,
): DetectedAgentCli {
	return {
		binary: overrides.name,
		commandTemplate: `${overrides.name} {brief} {out}`,
		path: `/usr/local/bin/${overrides.name}`,
		version: "1.0.0",
		...overrides,
	};
}

const REVIEWER_TIER = {
	prefer: ["openai/gpt-5.4-codex", "anthropic/claude-opus-4-8", "xai/grok-5-code"],
	count: 2,
	crossVendor: true,
};

const POLICY: RolesPolicy = {
	apiVersion: "gatekeeper/v1",
	tiers: {
		"deep-reasoner": { prefer: ["anthropic/claude-fable-5", "openai/gpt-5.6-sol"], count: 1, crossVendor: false },
		coder: { prefer: ["openai/gpt-5.4-codex", "anthropic/claude-sonnet-5"], count: 1, crossVendor: false },
		reviewer: REVIEWER_TIER,
	},
};

describe("assignRolesToClis", () => {
	it("assigns each tier the first eligible CLI in the tier's preference order", () => {
		const detected = [
			cli({ name: "codex", vendor: "openai", tiers: ["deep-reasoner", "coder", "reviewer"] }),
			cli({ name: "claude", vendor: "anthropic", tiers: ["deep-reasoner", "coder", "reviewer"] }),
		];

		const result = assignRolesToClis({ detected, rolesPolicy: POLICY });

		const byRole = Object.fromEntries(result.assignments.map((a) => [a.role, a]));
		expect(byRole["deep-reasoner"]).toMatchObject({ cliName: "claude", vendor: "anthropic" });
		expect(byRole.coder).toMatchObject({ cliName: "codex", vendor: "openai" });
	});

	it("reviewer tier (cross_vendor, count 2) fills two distinct-vendor CLIs when both are available", () => {
		const detected = [
			cli({ name: "codex", vendor: "openai", tiers: ["reviewer"] }),
			cli({ name: "claude", vendor: "anthropic", tiers: ["reviewer"] }),
			cli({ name: "grok", vendor: "xai", tiers: ["reviewer"] }),
		];

		const result = assignRolesToClis({
			detected,
			rolesPolicy: { apiVersion: "gatekeeper/v1", tiers: { reviewer: REVIEWER_TIER } },
		});

		const reviewers = result.assignments.filter((a) => a.role === "reviewer");
		expect(reviewers).toHaveLength(2);
		// Preference order is openai > anthropic > xai -- the top two vendors present win.
		expect(reviewers.map((r) => r.vendor)).toEqual(["openai", "anthropic"]);
		expect(result.warnings).toEqual([]);
	});

	it("reviewer tier falls back to same-vendor fill (with a warning) when only one vendor is available", () => {
		const detected = [cli({ name: "codex", vendor: "openai", tiers: ["reviewer"] })];

		const result = assignRolesToClis({
			detected,
			rolesPolicy: { apiVersion: "gatekeeper/v1", tiers: { reviewer: REVIEWER_TIER } },
		});

		const reviewers = result.assignments.filter((a) => a.role === "reviewer");
		expect(reviewers).toHaveLength(1);
		expect(reviewers[0]).toMatchObject({ cliName: "codex", vendor: "openai" });
		expect(result.warnings.some((w) => w.includes("only 1/2"))).toBe(true);
	});

	it("emits a warning (no assignment) for a tier with zero eligible CLIs", () => {
		const detected = [cli({ name: "grok", vendor: "xai", tiers: ["reviewer"] })]; // not eligible for deep-reasoner/coder

		const result = assignRolesToClis({ detected, rolesPolicy: POLICY });

		expect(result.assignments.some((a) => a.role === "deep-reasoner")).toBe(false);
		expect(result.assignments.some((a) => a.role === "coder")).toBe(false);
		expect(
			result.warnings.some((w) => w.startsWith("deep-reasoner tier: no detected agent CLI declares support")),
		).toBe(true);
		expect(result.warnings.some((w) => w.startsWith("coder tier: no detected agent CLI declares support"))).toBe(true);
	});

	it("emits a warning (no assignment) when an eligible CLI exists but its vendor isn't in the tier's preference list", () => {
		const detected = [cli({ name: "kimi", vendor: "moonshot", tiers: ["coder"] })];
		const policy: RolesPolicy = {
			apiVersion: "gatekeeper/v1",
			tiers: { coder: { prefer: ["openai/gpt-5.4-codex"], count: 1, crossVendor: false } },
		};

		const result = assignRolesToClis({ detected, rolesPolicy: policy });

		// kimi (moonshot) supports the "coder" tier but moonshot isn't in this tier's
		// preference list at all -- must not be silently assigned as an out-of-policy fallback.
		expect(result.assignments).toEqual([]);
		expect(result.warnings).toEqual([
			"coder tier: no detected agent CLI matches roles-policy's preferred vendors (openai/gpt-5.4-codex)",
		]);
	});

	it("returns zero assignments and one warning per tier when detected is empty", () => {
		const result = assignRolesToClis({ detected: [], rolesPolicy: POLICY });

		expect(result.assignments).toEqual([]);
		expect(result.warnings).toHaveLength(3);
		for (const warning of result.warnings) {
			expect(warning).toContain("no agent CLI detected on PATH");
		}
	});

	it("rationale references the tier's preference order", () => {
		const detected = [cli({ name: "codex", vendor: "openai", tiers: ["coder"] })];

		const result = assignRolesToClis({ detected, rolesPolicy: POLICY });

		const coder = result.assignments.find((a) => a.role === "coder");
		expect(coder?.rationale).toContain("openai/gpt-5.4-codex > anthropic/claude-sonnet-5");
	});
});
