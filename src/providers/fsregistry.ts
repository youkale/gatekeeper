import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Local filesystem registry provider: reads registry file text from a
 * directory and hands it to the (pure, I/O-free) `parseRegistry`. All I/O
 * lives here — the engine never touches the filesystem.
 */

export class RegistryReadError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(reason);
		this.name = "RegistryReadError";
		this.reason = reason;
		if (options?.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

function describeIoError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface RegistryFileInput {
	path: string;
	content: string;
}

/**
 * Read `policy.yaml` and every `contracts/*.yaml`/`*.yml` file under `registryDir`
 * into the `{path, content}` shape `parseRegistry` expects. Missing files/directories
 * are not an error here — `parseRegistry` reports the resulting semantic issues
 * (e.g. "exactly one policy.yaml"); only genuine I/O failures throw.
 */
export async function readRegistryFiles(registryDir: string): Promise<RegistryFileInput[]> {
	const files: RegistryFileInput[] = [];

	const policyPath = path.join(registryDir, "policy.yaml");
	try {
		const content = await readFile(policyPath, "utf8");
		files.push({ path: "policy.yaml", content });
	} catch (error) {
		if (!isEnoent(error)) {
			throw new RegistryReadError(`failed to read ${policyPath}: ${describeIoError(error)}`, { cause: error });
		}
	}

	const contractsDir = path.join(registryDir, "contracts");
	let entries: Dirent[];
	try {
		entries = await readdir(contractsDir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) {
			entries = [];
		} else {
			throw new RegistryReadError(`failed to read directory ${contractsDir}: ${describeIoError(error)}`, {
				cause: error,
			});
		}
	}

	// Sort for determinism across filesystems: contract file order feeds the
	// engine's touched array, which is externally visible output.
	entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

	for (const entry of entries) {
		if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) {
			continue;
		}
		const filePath = path.join(contractsDir, entry.name);
		try {
			const content = await readFile(filePath, "utf8");
			files.push({ path: `contracts/${entry.name}`, content });
		} catch (error) {
			throw new RegistryReadError(`failed to read ${filePath}: ${describeIoError(error)}`, { cause: error });
		}
	}

	return files;
}
