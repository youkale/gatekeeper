import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
	packagedRoleCardDirectory,
	packagedRoleCardPath,
	ROLE_CARD_NAMES,
	RoleCardNotFoundError,
	resolveRoleCardPath,
} from "../src/roles/cards.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

let tmpDir: string | undefined;

async function makeTmpDir(prefix: string): Promise<string> {
	tmpDir = await mkdtemp(path.join(tmpdir(), prefix));
	return tmpDir;
}

afterEach(async () => {
	if (tmpDir) {
		await rm(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});

describe("packagedRoleCardDirectory", () => {
	it.each(["src/roles/cards.ts", "dist/roles/cards.js", "dist/cli.js"])(
		"resolves the package-root docs/roles directory from %s",
		(modulePath) => {
			expect(packagedRoleCardDirectory(pathToFileURL(path.join(packageRoot, modulePath)))).toBe(
				path.join(packageRoot, "docs", "roles"),
			);
		},
	);
});

describe("packagedRoleCardPath", () => {
	it("resolves every shipped role card to a real, existing file", async () => {
		expect(ROLE_CARD_NAMES).toEqual(["deep-reasoner", "registry-drafter", "contract-scout", "registry-reviewer"]);
		for (const card of ROLE_CARD_NAMES) {
			const cardPath = packagedRoleCardPath(card);
			expect(cardPath).toBe(path.join(packageRoot, "docs", "roles", `${card}.md`));
			const content = await import("node:fs/promises").then((fs) => fs.readFile(cardPath, "utf8"));
			expect(content.length).toBeGreaterThan(0);
		}
	});
});

describe("resolveRoleCardPath", () => {
	it("falls back to the packaged copy when no registryDir is given", () => {
		const resolved = resolveRoleCardPath("deep-reasoner");
		expect(resolved).toBe(packagedRoleCardPath("deep-reasoner"));
	});

	it("falls back to the packaged copy when the control repo has no customized roles/ directory", async () => {
		const base = await makeTmpDir("gatekeeper-role-cards-fallback-");
		const registryDir = path.join(base, "governance", "registry");
		await mkdir(registryDir, { recursive: true });

		const resolved = resolveRoleCardPath("deep-reasoner", registryDir);
		expect(resolved).toBe(packagedRoleCardPath("deep-reasoner"));
	});

	it("prefers the control repo's own governance/roles/<card>.md over the packaged copy", async () => {
		const base = await makeTmpDir("gatekeeper-role-cards-control-");
		const registryDir = path.join(base, "governance", "registry");
		const rolesDir = path.join(base, "governance", "roles");
		await mkdir(registryDir, { recursive: true });
		await mkdir(rolesDir, { recursive: true });
		const customPath = path.join(rolesDir, "deep-reasoner.md");
		await writeFile(customPath, "# customized deep-reasoner card\n", "utf8");

		const resolved = resolveRoleCardPath("deep-reasoner", registryDir);
		expect(resolved).toBe(customPath);
	});

	it("falls back to <registry>/roles/<card>.md when the registry sits directly at the control repo root (no governance/registry nesting)", async () => {
		const base = await makeTmpDir("gatekeeper-role-cards-root-registry-");
		const registryDir = path.join(base, "control");
		const rolesDir = path.join(base, "control", "roles");
		await mkdir(registryDir, { recursive: true });
		await mkdir(rolesDir, { recursive: true });
		const customPath = path.join(rolesDir, "registry-drafter.md");
		await writeFile(customPath, "# customized registry-drafter card\n", "utf8");

		const resolved = resolveRoleCardPath("registry-drafter", registryDir);
		expect(resolved).toBe(customPath);
	});

	it('resolves to <root>/roles/<card>.md (not the parent\'s roles/) when the control repo root directory is itself literally named "registry" and the registry is that root (grok nb#1/#4 boundary)', async () => {
		// Regression for a basename("registry") heuristic that used to
		// misclassify this exact shape as the governance/registry sibling
		// layout and resolve one directory too high.
		const base = await makeTmpDir("gatekeeper-role-cards-root-named-registry-");
		const controlRoot = path.join(base, "registry");
		const rolesDir = path.join(controlRoot, "roles");
		await mkdir(rolesDir, { recursive: true });
		const rootLevelCustomPath = path.join(rolesDir, "deep-reasoner.md");
		await writeFile(rootLevelCustomPath, "# root-level customized deep-reasoner card\n", "utf8");
		// A decoy at the (wrong, pre-fix) parent-level roles/ directory the old
		// heuristic would have resolved to instead -- must never be picked.
		const parentDecoyRolesDir = path.join(base, "roles");
		await mkdir(parentDecoyRolesDir, { recursive: true });
		await writeFile(path.join(parentDecoyRolesDir, "deep-reasoner.md"), "# WRONG: parent decoy\n", "utf8");

		const resolved = resolveRoleCardPath("deep-reasoner", controlRoot);
		expect(resolved).toBe(rootLevelCustomPath);
	});

	it("throws RoleCardNotFoundError with all three tried paths when no copy exists", () => {
		const bogusModuleUrl = pathToFileURL("/nonexistent/dist/cli.js");
		const expectedPackagedPath = packagedRoleCardPath("deep-reasoner", bogusModuleUrl);
		try {
			resolveRoleCardPath("deep-reasoner", "/nonexistent/governance/registry", bogusModuleUrl);
			throw new Error("expected resolveRoleCardPath to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(RoleCardNotFoundError);
			const roleCardError = error as RoleCardNotFoundError;
			expect(roleCardError.card).toBe("deep-reasoner");
			expect(roleCardError.triedPaths).toEqual([
				path.join("/nonexistent", "governance", "registry", "roles", "deep-reasoner.md"),
				path.join("/nonexistent", "governance", "roles", "deep-reasoner.md"),
				expectedPackagedPath,
			]);
			expect(roleCardError.message).toContain("not found");
		}
	});
});
