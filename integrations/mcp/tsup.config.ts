import { defineConfig } from "tsup";

// Bundles the standalone stdio MCP server into a single dist/index.js so an
// MCP client can invoke `node dist/index.js` directly without a workspace
// checkout or tsx/ts-node runtime. Bundling (noExternal: [/.*/]) also avoids
// the relative-import breakage that a non-bundled tsc emit would hit for the
// `../../src/...` imports (dist/ sits one directory deeper than index.ts).
export default defineConfig({
	entry: { index: "index.ts" },
	format: ["esm"],
	platform: "node",
	target: "node20",
	outDir: "dist",
	clean: true,
	bundle: true,
	splitting: false,
	sourcemap: true,
	dts: false,
	noExternal: [/.*/],
	banner: {
		js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
	},
});
