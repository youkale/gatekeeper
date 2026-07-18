import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
	defaultRolesPolicyPath,
	loadPiProviderAvailability,
	loadRolesPolicy,
	type PiProviderAvailability,
	parseRolesPolicy,
	type RolesPolicy,
	RolesPolicyParseError,
	RolesPolicyReadError,
	selectAllTiers,
	selectTierModels,
	vendorOfModelId,
} from "../src/roles/policy.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const VALID_ROLES_POLICY_YAML = `apiVersion: gatekeeper/v1
tiers:
  deep-reasoner:
    prefer: ["anthropic/claude-fable-5", "anthropic/claude-opus-4-8", "openai/gpt-5.6-sol"]
  coder:
    prefer: ["openai/gpt-5.4-codex", "anthropic/claude-sonnet-5"]
  reviewer:
    prefer: ["openai/gpt-5.4-codex", "anthropic/claude-opus-4-8", "xai/grok-5-code"]
    count: 2
    cross_vendor: true
`;

describe("parseRolesPolicy", () => {
	it("parses tiers with defaults for count and cross_vendor", () => {
		const policy = parseRolesPolicy(VALID_ROLES_POLICY_YAML);
		expect(policy.apiVersion).toBe("gatekeeper/v1");
		expect(policy.tiers["deep-reasoner"]).toEqual({
			prefer: ["anthropic/claude-fable-5", "anthropic/claude-opus-4-8", "openai/gpt-5.6-sol"],
			count: 1,
			crossVendor: false,
		});
		expect(policy.tiers.coder).toEqual({
			prefer: ["openai/gpt-5.4-codex", "anthropic/claude-sonnet-5"],
			count: 1,
			crossVendor: false,
		});
		expect(policy.tiers.reviewer).toEqual({
			prefer: ["openai/gpt-5.4-codex", "anthropic/claude-opus-4-8", "xai/grok-5-code"],
			count: 2,
			crossVendor: true,
		});
	});

	it("rejects invalid YAML", () => {
		expect(() => parseRolesPolicy("tiers: [", "bad.yaml")).toThrow(RolesPolicyParseError);
	});

	it("rejects a missing apiVersion literal", () => {
		expect(() =>
			parseRolesPolicy(
				`apiVersion: gatekeeper/v2
tiers:
  coder:
    prefer: ["a/b"]
`,
			),
		).toThrow(RolesPolicyParseError);
	});

	it("rejects a tier with an empty prefer list", () => {
		expect(() =>
			parseRolesPolicy(
				`apiVersion: gatekeeper/v1
tiers:
  coder:
    prefer: []
`,
			),
		).toThrow(RolesPolicyParseError);
	});

	it("rejects unknown top-level keys", () => {
		expect(() =>
			parseRolesPolicy(
				`apiVersion: gatekeeper/v1
tiers: {}
extra: true
`,
			),
		).toThrow(RolesPolicyParseError);
	});

	it("rejects unknown tier keys", () => {
		expect(() =>
			parseRolesPolicy(
				`apiVersion: gatekeeper/v1
tiers:
  coder:
    prefer: ["a/b"]
    typo: true
`,
			),
		).toThrow(RolesPolicyParseError);
	});
});

describe("defaultRolesPolicyPath", () => {
	it.each(["src/roles/policy.ts", "dist/roles/policy.js", "dist/cli.js"])(
		"resolves the package-root roles-policy.yaml from %s",
		(modulePath) => {
			expect(defaultRolesPolicyPath(pathToFileURL(path.join(packageRoot, modulePath)))).toBe(
				path.join(packageRoot, "roles-policy.yaml"),
			);
		},
	);
});

describe("loadRolesPolicy", () => {
	it("loads the real repo-root roles-policy.yaml matching the spec's tier structure", async () => {
		const policy = await loadRolesPolicy();
		expect(policy.tiers["deep-reasoner"]?.prefer).toEqual([
			"anthropic/claude-fable-5",
			"anthropic/claude-opus-4-8",
			"openai/gpt-5.6-sol",
		]);
		expect(policy.tiers.coder?.prefer).toEqual(["openai/gpt-5.4-codex", "anthropic/claude-sonnet-5"]);
		expect(policy.tiers.reviewer).toEqual({
			prefer: ["openai/gpt-5.4-codex", "anthropic/claude-opus-4-8", "xai/grok-5-code"],
			count: 2,
			crossVendor: true,
		});
	});

	it("raises a RolesPolicyReadError for a missing file", async () => {
		await expect(loadRolesPolicy("/nonexistent/roles-policy.yaml")).rejects.toBeInstanceOf(RolesPolicyReadError);
	});
});

describe("loadPiProviderAvailability", () => {
	it("reads auth.json vendors and an optional models.json manifest (real pi providers.<vendor>.models[].id shape)", async () => {
		const files: Record<string, string> = {
			"/pi/auth.json": JSON.stringify({ anthropic: { apiKey: "x" }, openai: { apiKey: "y" }, xai: {} }),
			"/pi/models.json": JSON.stringify({
				providers: {
					anthropic: { models: [{ id: "claude-fable-5" }] },
					openai: { baseUrl: "https://api.openai.com/v1", models: [{ id: "gpt-5.4-codex" }] },
				},
			}),
		};
		const availability = await loadPiProviderAvailability({
			piConfigDir: "/pi",
			readFile: async (filePath) => {
				const content = files[filePath];
				if (content === undefined) {
					throw new Error(`ENOENT: ${filePath}`);
				}
				return content;
			},
		});
		expect(availability.known).toBe(true);
		// xai's credential value is an empty object -- treated as "not actually configured".
		expect([...availability.vendors].sort()).toEqual(["anthropic", "openai"]);
		// providers.<vendor>.models[].id is reassembled into this repo's <vendor>/<model> convention.
		expect(availability.models).toEqual(new Set(["anthropic/claude-fable-5", "openai/gpt-5.4-codex"]));
	});

	it("tolerates JSONC (line/block comments, trailing commas) in models.json, matching pi's real file format", async () => {
		const files: Record<string, string> = {
			"/pi/auth.json": JSON.stringify({ ollama: { apiKey: "ollama" } }),
			"/pi/models.json": `{
  // local models served by Ollama
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1", // note the double-slash inside a string value
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }, /* trailing comment on a real entry */
      ],
    },
  },
}`,
		};
		const availability = await loadPiProviderAvailability({
			piConfigDir: "/pi",
			readFile: async (filePath) => {
				const content = files[filePath];
				if (content === undefined) {
					throw new Error(`ENOENT: ${filePath}`);
				}
				return content;
			},
		});
		expect(availability.known).toBe(true);
		expect(availability.models).toEqual(new Set(["ollama/llama3.1:8b", "ollama/qwen2.5-coder:7b"]));
	});

	it("degrades authKnown (and known, since models.json is also absent) to false when auth.json is unreadable", async () => {
		const availability = await loadPiProviderAvailability({
			piConfigDir: "/pi",
			readFile: async () => {
				throw new Error("ENOENT");
			},
		});
		expect(availability.known).toBe(false);
		expect(availability.authKnown).toBe(false);
		expect(availability.modelsKnown).toBe(false);
		expect(availability.vendors.size).toBe(0);
		expect(availability.reason).toBeDefined();
	});

	it("degrades authKnown to false when auth.json is malformed JSON (models.json unaffected -- read independently)", async () => {
		const availability = await loadPiProviderAvailability({
			piConfigDir: "/pi",
			readFile: async (filePath) => {
				if (filePath === "/pi/auth.json") {
					return "{not json";
				}
				throw new Error("ENOENT");
			},
		});
		expect(availability.known).toBe(false);
		expect(availability.authKnown).toBe(false);
		expect(availability.reason).toContain("not valid JSON");
	});

	it("degrades authKnown to false when auth.json is not a JSON object (models.json unaffected -- read independently)", async () => {
		const availability = await loadPiProviderAvailability({
			piConfigDir: "/pi",
			readFile: async (filePath) => {
				if (filePath === "/pi/auth.json") {
					return "[]";
				}
				throw new Error("ENOENT");
			},
		});
		expect(availability.known).toBe(false);
		expect(availability.authKnown).toBe(false);
		expect(availability.reason).toContain("must be a JSON object");
	});

	it("tolerates a missing or invalid models.json (falls back to vendor-only inference)", async () => {
		const availability = await loadPiProviderAvailability({
			piConfigDir: "/pi",
			readFile: async (filePath) => {
				if (filePath === "/pi/auth.json") {
					return JSON.stringify({ anthropic: { apiKey: "x" } });
				}
				throw new Error("ENOENT");
			},
		});
		expect(availability.known).toBe(true);
		expect(availability.authKnown).toBe(true);
		expect(availability.modelsKnown).toBe(false);
		expect(availability.models).toBeUndefined();
		expect(availability.vendors.has("anthropic")).toBe(true);
	});

	it("defaults piConfigDir to ~/.pi/agent when not overridden", async () => {
		// Smoke-test the default path composition without touching the real home directory:
		// an injected readFile records which paths it was asked for.
		const requested: string[] = [];
		await loadPiProviderAvailability({
			readFile: async (filePath) => {
				requested.push(filePath);
				throw new Error("ENOENT");
			},
		});
		expect(requested[0]).toMatch(/\.pi[\\/]agent[\\/]auth\.json$/);
	});

	describe("[regression] auth.json and models.json are read independently (neither's failure short-circuits the other)", () => {
		it("honors a models.json confirmation even when auth.json is entirely missing/unreadable", async () => {
			const files: Record<string, string> = {
				"/pi/models.json": JSON.stringify({ providers: { acme: { models: [{ id: "only-model" }] } } }),
				// auth.json intentionally absent from `files` -- readFile throws ENOENT for it.
			};
			const availability = await loadPiProviderAvailability({
				piConfigDir: "/pi",
				readFile: async (filePath) => {
					const content = files[filePath];
					if (content === undefined) {
						throw new Error(`ENOENT: ${filePath}`);
					}
					return content;
				},
			});

			expect(availability.authKnown).toBe(false);
			expect(availability.modelsKnown).toBe(true);
			expect(availability.known).toBe(true); // at least one source worked
			expect(availability.vendors.size).toBe(0);
			expect(availability.models).toEqual(new Set(["acme/only-model"]));

			// The fix must actually change selection: a models.json hit is confirmed even
			// though auth.json (the vendor-credential source) is entirely unreadable -- this
			// is exactly the defect the previous round's early-return caused.
			const selection = selectTierModels(
				"deep-reasoner",
				{ prefer: ["acme/only-model"], count: 1, crossVendor: false },
				availability,
			);
			expect(selection.selected).toEqual([{ modelId: "acme/only-model", status: "confirmed" }]);
			expect(selection.warnings).toEqual([]);
		});

		it("preserves the existing vendor-only 'unknown' behavior when models.json is missing/unreadable and auth.json is fine (no regression)", async () => {
			const files: Record<string, string> = {
				"/pi/auth.json": JSON.stringify({ anthropic: { apiKey: "x" } }),
				// models.json intentionally absent -- readFile throws ENOENT for it.
			};
			const availability = await loadPiProviderAvailability({
				piConfigDir: "/pi",
				readFile: async (filePath) => {
					const content = files[filePath];
					if (content === undefined) {
						throw new Error(`ENOENT: ${filePath}`);
					}
					return content;
				},
			});

			expect(availability.authKnown).toBe(true);
			expect(availability.modelsKnown).toBe(false);
			expect(availability.known).toBe(true);
			expect(availability.models).toBeUndefined();

			const selection = selectTierModels(
				"deep-reasoner",
				{ prefer: ["anthropic/claude-fable-5"], count: 1, crossVendor: false },
				availability,
			);
			expect(selection.selected).toEqual([{ modelId: "anthropic/claude-fable-5", status: "unknown" }]);
		});

		it("honors a models.json confirmation when auth.json is readable but fails JSON.parse (inner parse-catch branch, not the outer ENOENT branch)", async () => {
			const files: Record<string, string> = {
				"/pi/auth.json": "{not json",
				"/pi/models.json": JSON.stringify({ providers: { acme: { models: [{ id: "only-model" }] } } }),
			};
			const availability = await loadPiProviderAvailability({
				piConfigDir: "/pi",
				readFile: async (filePath) => {
					const content = files[filePath];
					if (content === undefined) {
						throw new Error(`ENOENT: ${filePath}`);
					}
					return content;
				},
			});

			// auth.json was readable (no ENOENT) but JSON.parse on its content threw -- this
			// exercises the inner parse-catch branch specifically, distinct from the outer
			// read-failure branch already covered above.
			expect(availability.authKnown).toBe(false);
			expect(availability.modelsKnown).toBe(true);
			expect(availability.known).toBe(true);
			expect(availability.reason).toContain("not valid JSON");
			expect(availability.models).toEqual(new Set(["acme/only-model"]));

			const selection = selectTierModels(
				"deep-reasoner",
				{ prefer: ["acme/only-model"], count: 1, crossVendor: false },
				availability,
			);
			expect(selection.selected).toEqual([{ modelId: "acme/only-model", status: "confirmed" }]);
			expect(selection.warnings).toEqual([]);
		});

		it("marks every candidate unavailable (with a warning) when both auth.json and models.json are unreadable", async () => {
			const availability = await loadPiProviderAvailability({
				piConfigDir: "/pi",
				readFile: async () => {
					throw new Error("ENOENT");
				},
			});

			expect(availability.authKnown).toBe(false);
			expect(availability.modelsKnown).toBe(false);
			expect(availability.known).toBe(false);

			const selection = selectTierModels(
				"deep-reasoner",
				{ prefer: ["anthropic/claude-fable-5"], count: 1, crossVendor: false },
				availability,
			);
			expect(selection.availabilityKnown).toBe(false);
			expect(selection.selected).toEqual([]);
			expect(selection.warnings.length).toBeGreaterThan(0);
		});
	});
});

describe("selectTierModels", () => {
	const policy: RolesPolicy = parseRolesPolicy(VALID_ROLES_POLICY_YAML);
	const deepReasoner = policy.tiers["deep-reasoner"];
	const coder = policy.tiers.coder;
	const reviewer = policy.tiers.reviewer;
	if (!deepReasoner || !coder || !reviewer) {
		throw new Error("fixture roles-policy is missing an expected tier");
	}

	function availability(vendors: string[]): PiProviderAvailability {
		return { known: true, authKnown: true, modelsKnown: false, vendors: new Set(vendors) };
	}

	it("picks the highest-preference available model for a single-slot tier, marked unknown (vendor-only credential)", () => {
		const selection = selectTierModels("deep-reasoner", deepReasoner, availability(["anthropic"]));
		expect(selection.selected).toEqual([{ modelId: "anthropic/claude-fable-5", status: "unknown" }]);
		// vendor-only credentials cannot confirm this exact model id -- surfaced as a warning, not silent OK.
		expect(selection.warnings[0]).toContain("model-level-unconfirmed");
	});

	it("falls through the preference order when higher-priority vendors are unavailable", () => {
		const selection = selectTierModels("deep-reasoner", deepReasoner, availability(["openai"]));
		expect(selection.selected).toEqual([{ modelId: "openai/gpt-5.6-sol", status: "unknown" }]);
	});

	it("warns and returns no selection when a tier has zero available models", () => {
		const selection = selectTierModels("coder", coder, availability([]));
		expect(selection.selected).toEqual([]);
		expect(selection.warnings[0]).toContain("no available model");
	});

	it("fills a cross-vendor tier with distinct vendors when enough are available", () => {
		const selection = selectTierModels("reviewer", reviewer, availability(["openai", "anthropic", "xai"]));
		expect(selection.selected).toEqual([
			{ modelId: "openai/gpt-5.4-codex", status: "unknown" },
			{ modelId: "anthropic/claude-opus-4-8", status: "unknown" },
		]);
		expect(selection.crossVendor).toBe(true);
	});

	it("warns with a partial fill when a cross-vendor tier cannot reach its requested count", () => {
		const selection = selectTierModels("reviewer", reviewer, availability(["anthropic"]));
		expect(selection.selected).toEqual([{ modelId: "anthropic/claude-opus-4-8", status: "unknown" }]);
		expect(selection.warnings.some((warning) => warning.includes("1/2"))).toBe(true);
	});

	it("marks availability unknown and returns no selection when pi config could not be read", () => {
		const selection = selectTierModels("deep-reasoner", deepReasoner, {
			known: false,
			authKnown: false,
			modelsKnown: false,
			vendors: new Set(),
			reason: "boom",
		});
		expect(selection.availabilityKnown).toBe(false);
		expect(selection.selected).toEqual([]);
		expect(selection.warnings[0]).toContain("boom");
	});

	it("falls back through the preference order past a genuinely unavailable model to the next models.json-confirmed one", () => {
		// coder's prefer order is [openai/gpt-5.4-codex, anthropic/claude-sonnet-5]. openai has
		// neither a vendor credential nor a models.json entry -- genuinely unavailable, must be
		// skipped. anthropic/claude-sonnet-5 is confirmed via models.json (a models.json hit
		// stands on its own, independent of auth.json -- see the additive-semantics tests below).
		const selection = selectTierModels("coder", coder, {
			known: true,
			authKnown: false,
			modelsKnown: true,
			vendors: new Set(),
			models: new Set(["anthropic/claude-sonnet-5"]),
		});
		expect(selection.selected).toEqual([{ modelId: "anthropic/claude-sonnet-5", status: "confirmed" }]);
		expect(selection.warnings).toEqual([]);
	});

	it("does not exclude a vendor-authenticated model just because models.json exists and omits it (additive, not exclusive)", () => {
		// openai is vendor-authenticated but not enumerated in models.json -- the normal case,
		// since built-in provider models are typically never listed there. It must stay
		// selectable as "unknown", not be demoted to unavailable by models.json's mere presence.
		const selection = selectTierModels("coder", coder, {
			known: true,
			authKnown: true,
			modelsKnown: true,
			vendors: new Set(["openai"]),
			models: new Set(["anthropic/claude-sonnet-5"]), // an unrelated entry; openai/gpt-5.4-codex is not listed
		});
		expect(selection.selected).toEqual([{ modelId: "openai/gpt-5.4-codex", status: "unknown" }]);
	});

	it("upgrades a vendor-authenticated pick's status to confirmed when models.json also lists it", () => {
		const selection = selectTierModels("coder", coder, {
			known: true,
			authKnown: true,
			modelsKnown: true,
			vendors: new Set(["openai"]),
			models: new Set(["openai/gpt-5.4-codex"]),
		});
		expect(selection.selected).toEqual([{ modelId: "openai/gpt-5.4-codex", status: "confirmed" }]);
		expect(selection.warnings).toEqual([]);
	});

	it("does not warn about unconfirmed selections when every pick is models.json-confirmed", () => {
		const selection = selectTierModels("reviewer", reviewer, {
			known: true,
			authKnown: true,
			modelsKnown: true,
			vendors: new Set(["openai", "anthropic", "xai"]),
			models: new Set(["openai/gpt-5.4-codex", "anthropic/claude-opus-4-8"]),
		});
		expect(selection.selected.every((entry) => entry.status === "confirmed")).toBe(true);
		expect(selection.warnings.some((warning) => warning.includes("unconfirmed"))).toBe(false);
	});

	it("mixes confirmed and unknown status within one cross-vendor selection when models.json only confirms some", () => {
		const selection = selectTierModels("reviewer", reviewer, {
			known: true,
			authKnown: true,
			modelsKnown: false,
			vendors: new Set(["openai", "anthropic"]),
			models: undefined,
		});
		expect(selection.selected).toEqual([
			{ modelId: "openai/gpt-5.4-codex", status: "unknown" },
			{ modelId: "anthropic/claude-opus-4-8", status: "unknown" },
		]);
	});
});

describe("selectAllTiers", () => {
	it("resolves every tier from the policy in declaration order", async () => {
		const policy = parseRolesPolicy(VALID_ROLES_POLICY_YAML);
		const selections = selectAllTiers(policy, {
			known: true,
			authKnown: true,
			modelsKnown: false,
			vendors: new Set(["anthropic", "openai", "xai"]),
		});
		expect(selections.map((selection) => selection.tier)).toEqual(["deep-reasoner", "coder", "reviewer"]);
	});
});

describe("shipped roles-policy.yaml", () => {
	it("is byte-for-byte parseable YAML with no stray control bytes", async () => {
		const raw = await readFile(path.join(packageRoot, "roles-policy.yaml"), "utf8");
		expect(raw.includes(String.fromCharCode(0))).toBe(false);
		expect(() => parseRolesPolicy(raw)).not.toThrow();
	});
});

describe("vendorOfModelId", () => {
	it("extracts the vendor prefix from a vendor/model id", () => {
		expect(vendorOfModelId("anthropic/claude-fable-5")).toBe("anthropic");
		expect(vendorOfModelId("openai/gpt-5.4-codex")).toBe("openai");
	});

	it("returns the whole string when there is no vendor prefix", () => {
		expect(vendorOfModelId("no-slash-here")).toBe("no-slash-here");
	});
});
