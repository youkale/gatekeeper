import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { runDoctor } from "../src/commands/doctor.js";

describe("doctor fail direction and required checks", () => {
	let registryDirectory: string;

	beforeAll(async () => {
		registryDirectory = await mkdtemp(path.join(tmpdir(), "gatekeeper-doctor-"));
		await writeFile(
			path.join(registryDirectory, "policy.yaml"),
			`apiVersion: gatekeeper/v1
lanes: {}
levels:
  notify:
    enforcement: warn
    require: {}
`,
			"utf8",
		);
	});

	afterAll(async () => {
		await rm(registryDirectory, { recursive: true, force: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fails open when the workflow path is missing", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const createProvider = vi.fn(() => {
			throw new Error("provider must not be called after workflow IO failure");
		});

		const exitCode = await runDoctor(
			{
				registry: registryDirectory,
				repo: "acme/app",
				workflow: path.join(registryDirectory, "missing-workflow.yml"),
			},
			registryDirectory,
			{ createProvider },
		);

		expect(exitCode).toBe(0);
		expect(createProvider).not.toHaveBeenCalled();
		expect(stderr.mock.calls.map(([message]) => String(message)).join("\n")).toContain("无法校验 workflow");
	});

	it("returns one when a workflow contains an unresolved YAML alias", async () => {
		const workflow = path.join(registryDirectory, "invalid-alias.yml");
		await writeFile(
			workflow,
			`name: gatekeeper
jobs:
  gate: *missing
`,
			"utf8",
		);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const createProvider = vi.fn(() => {
			throw new Error("provider must not be called after workflow config failure");
		});

		const exitCode = await runDoctor({ registry: registryDirectory, repo: "acme/app", workflow }, registryDirectory, {
			createProvider,
		});

		expect(exitCode).toBe(1);
		expect(createProvider).not.toHaveBeenCalled();
		const output = stderr.mock.calls.map(([message]) => String(message)).join("\n");
		expect(output).toContain("invalid workflow YAML");
		expect(output).toContain("Unresolved alias");
	});

	it("warns and exits zero when branch protection is unavailable", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const exitCode = await runDoctor(
			{ registry: registryDirectory, repo: "acme/app", branch: "main", checkName: ["gatekeeper"] },
			registryDirectory,
			{
				createProvider: () => ({
					getBranchProtectionRequiredChecks: async () => ({
						available: false,
						reason: "forbidden",
						status: 403,
						message: "HTTP 403",
					}),
				}),
			},
		);

		expect(exitCode).toBe(0);
		expect(stderr.mock.calls.map(([message]) => String(message)).join("\n")).toContain("无法校验 branch protection");
	});

	it("returns one for a confirmed missing required check", async () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const exitCode = await runDoctor(
			{ registry: registryDirectory, repo: "acme/app", branch: "main", checkName: ["gatekeeper"] },
			registryDirectory,
			{
				createProvider: () => ({
					getBranchProtectionRequiredChecks: async () => ({
						available: true,
						contexts: ["build"],
						checks: [{ context: "build", app_id: null }],
					}),
				}),
			},
		);

		expect(exitCode).toBe(1);
	});

	it("returns one for a structured user lane schema error before creating a provider", async () => {
		const invalidRegistry = await mkdtemp(path.join(tmpdir(), "gatekeeper-doctor-invalid-lane-"));
		try {
			await writeFile(
				path.join(invalidRegistry, "policy.yaml"),
				`apiVersion: gatekeeper/v1
lanes:
  broken: { type: check-run, name: build-*, pas: [success] }
levels: {}
`,
				"utf8",
			);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const createProvider = vi.fn(() => {
				throw new Error("provider must not be created for an invalid registry");
			});

			const exitCode = await runDoctor(
				{ registry: invalidRegistry, repo: "acme/app", checkName: ["gatekeeper"] },
				invalidRegistry,
				{ createProvider },
			);

			expect(exitCode).toBe(1);
			expect(createProvider).not.toHaveBeenCalled();
			expect(stderr.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				"expected a known key or x-* extension",
			);
		} finally {
			await rm(invalidRegistry, { recursive: true, force: true });
		}
	});
});
