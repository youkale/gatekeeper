import { describe, expect, it } from "vitest";

import { parseRegistry, RegistryParseError } from "../src/engine/registry.js";

const validPolicy = `
apiVersion: gatekeeper/v1
lanes:
  human: { type: human-approval, min: 1, fresh: true }
levels:
  breaking-review-required:
    enforcement: block
    require: { m: 1, lanes: [human] }
`;

function capturedIssues(files: { path: string; content: string }[]) {
	try {
		parseRegistry(files);
	} catch (error) {
		if (error instanceof RegistryParseError) {
			return error.issues;
		}
		throw error;
	}
	throw new Error("Expected registry parsing to fail");
}

describe("registry schema diagnostics", () => {
	it("reports unresolved YAML aliases as structured registry issues", () => {
		const issues = capturedIssues([{ path: "policy.yaml", content: "a: *missing" }]);

		expect(issues).toEqual([
			{
				file: "policy.yaml",
				path: "$",
				expected: "valid alias reference",
				actual: "Unresolved alias (the anchor must be set before the alias): missing",
				hint: "Define the referenced YAML anchor before using its alias.",
			},
		]);
	});

	it("snapshots file, YAML path, expected/actual, and typo hint", () => {
		const issues = capturedIssues([
			{ path: "policy.yaml", content: validPolicy },
			{
				path: "contracts/typo.yaml",
				content: `
apiVersion: gatekeeper/v1
name: typo-contract
levle: breaking-review-required
authority:
  repo: org/app
  paths: [src/**]
`,
			},
		]);

		expect(issues).toMatchInlineSnapshot(`
			[
			  {
			    "actual": ""breaking-review-required"",
			    "expected": "a known key or x-* extension",
			    "file": "contracts/typo.yaml",
			    "hint": "Unknown key "levle". Did you mean "level"?",
			    "path": "$.levle",
			  },
			  {
			    "actual": "missing",
			    "expected": "string",
			    "file": "contracts/typo.yaml",
			    "hint": "Required",
			    "path": "$.level",
			  },
			]
		`);
	});

	it("reports required-key typos before base validation at top level and inside lane unions", () => {
		const issues = capturedIssues([
			{
				path: "policy.yaml",
				content: `
apiVersion: gatekeeper/v1
lanes:
  human: { type: human-approval, min: 1, fersh: true }
levels:
  strict: { enforcement: block, require: { m: 1, lanes: [human] } }
`,
			},
			{
				path: "contracts/typo.yaml",
				content: `
apiVersion: gatekeeper/v1
name: typo-contract
levle: strict
authority: { repo: org/app, paths: [src/**] }
`,
			},
		]);

		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: "contracts/typo.yaml",
					path: "$.levle",
					hint: 'Unknown key "levle". Did you mean "level"?',
				}),
				expect.objectContaining({
					file: "policy.yaml",
					path: "$.lanes.human.fersh",
					hint: 'Unknown key "fersh". Did you mean "fresh"?',
				}),
			]),
		);
		expect(issues).not.toContainEqual(expect.objectContaining({ expected: "one supported object shape" }));
	});

	it("snapshots semantic foreign-key, lane threshold, and regex failures together", () => {
		const issues = capturedIssues([
			{
				path: "policy.yaml",
				content: `
apiVersion: gatekeeper/v1
lanes:
  human: { type: human-approval, min: 1, fresh: true }
levels:
  strict:
    enforcement: block
    require: { m: 2, lanes: [missing] }
`,
			},
			{
				path: "contracts/broken.yaml",
				content: `
apiVersion: gatekeeper/v1
name: broken-contract
level: absent
authority:
  repo: org/app
  paths: [src/**]
  if_content: "["
`,
			},
		]);

		expect(issues).toMatchInlineSnapshot(`
			[
			  {
			    "actual": ""absent"",
			    "expected": "a level declared in policy.yaml",
			    "file": "contracts/broken.yaml",
			    "hint": "Declare level "absent" in policy.levels or correct the contract level.",
			    "path": "$.level",
			  },
			  {
			    "actual": ""["",
			    "expected": "a valid JavaScript regular expression",
			    "file": "contracts/broken.yaml",
			    "hint": "Invalid regular expression: /[/: Unterminated character class",
			    "path": "$.authority.if_content",
			  },
			  {
			    "actual": "2",
			    "expected": "a number no greater than 1",
			    "file": "policy.yaml",
			    "hint": "m cannot exceed the number of required lanes.",
			    "path": "$.levels.strict.require.m",
			  },
			  {
			    "actual": ""missing"",
			    "expected": "a lane declared in policy.lanes",
			    "file": "policy.yaml",
			    "hint": "Declare lane "missing" or remove it from this requirement.",
			    "path": "$.levels.strict.require.lanes[0]",
			  },
			]
		`);
	});

	it("retains x- extensions and warns when allow_actors has no mirror-frozen meaning", () => {
		const registry = parseRegistry([
			{ path: "policy.yaml", content: validPolicy },
			{
				path: "contracts/extensions.yaml",
				content: `
apiVersion: gatekeeper/v1
name: extension-contract
level: breaking-review-required
x-owner: platform
authority:
  repo: org/app
  paths: [src/**]
  x-note: retained
consumers:
  - repo: org/client
    paths: [client/**]
    allow_actors: [bot]
`,
			},
		]);

		expect(registry.contracts[0]?.["x-owner"]).toBe("platform");
		expect(registry.contracts[0]?.authority["x-note"]).toBe("retained");
		expect(registry.warnings).toMatchInlineSnapshot(`
			[
			  {
			    "actual": "consumer",
			    "expected": "allow_actors on a mirror-frozen binding",
			    "file": "contracts/extensions.yaml",
			    "hint": "allow_actors has no effect unless role is mirror-frozen.",
			    "path": "$.consumers[0].allow_actors",
			  },
			]
		`);
	});

	it("rejects prototype-chain key names at top-level and nested objects", () => {
		const issues = capturedIssues([
			{ path: "policy.yaml", content: validPolicy },
			{
				path: "contracts/prototype.yaml",
				content: `
apiVersion: gatekeeper/v1
name: prototype-contract
level: breaking-review-required
constructor: blocked
authority:
  repo: org/app
  paths: [src/**]
  toString: blocked
consumers:
  - repo: org/client
    paths: [client/**]
    __proto__: blocked
`,
			},
		]);

		expect(issues.map((issue) => issue.path)).toEqual(
			expect.arrayContaining(["$.constructor", "$.authority.toString", "$.consumers[0].__proto__"]),
		);
		for (const path of ["$.constructor", "$.authority.toString", "$.consumers[0].__proto__"]) {
			expect(issues.find((issue) => issue.path === path)?.hint).toContain("Did you mean");
		}
	});

	it("accepts empty strings where the specification only declares string", () => {
		const registry = parseRegistry([
			{
				path: "policy.yaml",
				content: `
apiVersion: gatekeeper/v1
lanes:
  review: { type: review, author: "", pass: { state: APPROVED } }
levels:
  "": { enforcement: warn, require: {} }
overrides: { label: "" }
`,
			},
			{
				path: "contracts/empty-strings.yaml",
				content: `
apiVersion: gatekeeper/v1
name: empty-strings
description: ""
level: ""
authority:
  repo: ""
  paths: [""]
  if_content: ""
consumers:
  - repo: ""
    paths: [""]
    verify: ""
    allow_actors: [""]
`,
			},
		]);

		expect(registry.contracts[0]).toMatchObject({
			description: "",
			level: "",
			authority: { repo: "", paths: [""], if_content: "" },
			consumers: [{ repo: "", paths: [""], verify: "", allow_actors: [""] }],
		});
		expect(registry.policy.overrides.label).toBe("");
	});
});
