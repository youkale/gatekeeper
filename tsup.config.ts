import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		cli: "src/cli.ts",
		action: "src/action.ts",
	},
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
