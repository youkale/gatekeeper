import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Role card resolution: which copy of a Gatekeeper role card (deep-reasoner,
 * registry-drafter, contract-scout, registry-reviewer) a command should hand
 * to an agent. Three candidates, in priority order:
 *
 *  1. A control repo's own customized copy at `<registry>/roles/<name>.md`
 *     -- the registry sits directly at the control repo root (see
 *     `gatekeeper adopt`'s REGISTRY_CANDIDATE_SUBPATHS "." case).
 *  2. `<registry>/../roles/<name>.md` -- registry and roles are sibling
 *     directories under `governance/` (the layout `gatekeeper init-control`
 *     writes by default: `governance/registry` + `governance/roles`).
 *  3. The packaged `docs/roles/<name>.md` that ships with every install --
 *     the vendor-neutral default every command falls back to.
 *
 * Candidates 1 and 2 are both tried by `existsSync`, never by inspecting
 * `registryDir`'s basename: an earlier basename("registry") heuristic
 * misresolved a control repo whose *root directory* happens to be literally
 * named "registry" with the "." (registry-is-the-control-root) layout --
 * it would skip straight to the parent's `roles/`, which is either wrong or
 * nonexistent, instead of checking `<registry>/roles` first. Trying both
 * real paths and taking whichever exists removes that misclassification
 * risk entirely, at the cost of one extra `existsSync` in the layouts where
 * candidate 1 doesn't apply -- a fixed, cheap tradeoff for a directory-name
 * coincidence that would otherwise silently point at the wrong file.
 *
 * Pure path resolution plus `existsSync` presence checks -- no file content
 * is read here (callers that need the text do their own `readFile`).
 */

export const ROLE_CARD_NAMES = ["deep-reasoner", "registry-drafter", "contract-scout", "registry-reviewer"] as const;
export type RoleCardName = (typeof ROLE_CARD_NAMES)[number];

export class RoleCardNotFoundError extends Error {
	readonly card: string;
	readonly triedPaths: string[];

	constructor(card: string, triedPaths: string[]) {
		super(`role card "${card}" not found; tried:\n${triedPaths.map((candidate) => `  - ${candidate}`).join("\n")}`);
		this.name = "RoleCardNotFoundError";
		this.card = card;
		this.triedPaths = triedPaths;
	}
}

/**
 * Resolve the packaged `docs/roles/` directory shipped with the CLI. In
 * source form this module lives at src/roles/cards.ts (repo root two
 * directories up); tsup bundles everything into a single dist/cli.js (repo
 * root one directory up from dist/). Same dual-candidate approach as
 * gate/presets.ts's defaultLanePresetDirectory and roles/policy.ts's
 * defaultRolesPolicyPath.
 */
export function packagedRoleCardDirectory(moduleUrl: string | URL = import.meta.url): string {
	const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
	const bundledCandidate = path.resolve(moduleDirectory, "../docs/roles");
	const sourceCandidate = path.resolve(moduleDirectory, "../../docs/roles");
	return [bundledCandidate, sourceCandidate].find((candidate) => existsSync(candidate)) ?? sourceCandidate;
}

/** The packaged `docs/roles/<card>.md` path (no existence check -- see resolveRoleCardPath for a checked lookup). */
export function packagedRoleCardPath(card: string, moduleUrl: string | URL = import.meta.url): string {
	return path.join(packagedRoleCardDirectory(moduleUrl), `${card}.md`);
}

/**
 * The two plausible directories for a control repo's own `roles/`, relative
 * to its located registry, in the priority order `resolveRoleCardPath`
 * tries them by `existsSync` -- never by inspecting `registryDir`'s
 * basename (see the module doc comment for why):
 *
 *  1. `<registryDir>/roles` -- the registry sits directly at the control
 *     repo root.
 *  2. `<registryDir>/../roles` -- registry and roles are sibling
 *     directories under `governance/`.
 */
function controlRoleCardDirectoryCandidates(registryDir: string): string[] {
	return [path.resolve(registryDir, "roles"), path.resolve(registryDir, "..", "roles")];
}

/**
 * Resolve which copy of a role card a command should hand to an agent: an
 * organization's own customized copy (see `controlRoleCardDirectoryCandidates`
 * for the two directories tried, in order, when `registryDir` is given) wins
 * when it exists, falling back to the packaged `docs/roles/<card>.md` that
 * ships with every install. `registryDir` is optional -- omit it to resolve
 * the packaged copy directly (e.g. `gatekeeper init-control`'s own copy
 * step, which has no existing registry to check yet).
 *
 * Throws `RoleCardNotFoundError` only when none of the candidates exist --
 * the packaged copy is expected to always exist in a correctly-installed
 * package, so that case is an installation anomaly, not routine "not
 * customized" (callers map it to exit 2, the same posture
 * `defaultRolesPolicyPath` callers take toward a missing roles-policy.yaml).
 */
export function resolveRoleCardPath(
	card: string,
	registryDir?: string,
	moduleUrl: string | URL = import.meta.url,
): string {
	const tried: string[] = [];
	if (registryDir) {
		for (const candidateDir of controlRoleCardDirectoryCandidates(registryDir)) {
			const candidate = path.join(candidateDir, `${card}.md`);
			tried.push(candidate);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}
	const packaged = packagedRoleCardPath(card, moduleUrl);
	tried.push(packaged);
	if (existsSync(packaged)) {
		return packaged;
	}
	throw new RoleCardNotFoundError(card, tried);
}
