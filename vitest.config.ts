import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Safety net (defense in depth, on top of tests explicitly injecting their own
// GATEKEEPER_CONFIG_DIR -- see src/config/controls.ts): every command that
// resolves config now falls back to the user-level controls index
// (~/.config/gatekeeper/controls.yaml) when no .gatekeeper.yml is found. This
// global default redirects any test that forgets to inject its own
// GATEKEEPER_CONFIG_DIR away from the real one, so the test suite can never
// read or write real developer/CI-machine state.
const GLOBAL_TEST_CONFIG_DIR = path.join(tmpdir(), "gatekeeper-vitest-global-config-dir");

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		env: {
			GATEKEEPER_CONFIG_DIR: GLOBAL_TEST_CONFIG_DIR,
		},
	},
});
