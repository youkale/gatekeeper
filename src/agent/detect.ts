import { type ChildProcess, spawn } from "node:child_process";
import { access, constants as fsConstants, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Local coding-agent CLI detection: "which CLIs does this machine actually
 * have installed" (PATH probe + a short `--version` spawn), feeding
 * src/agent/assign.ts's per-role vendor selection and `gatekeeper
 * init-control`'s `governance/agents.yaml` generation.
 *
 * Zero-model invariant: this module never authenticates, prompts, or calls
 * any model -- `--version` is the only command ever spawned, and a missing/
 * failing binary degrades to `version: null` rather than throwing. No
 * network access.
 */

/**
 * One entry in the known-CLI table below. `commandTemplate` mirrors
 * `.gatekeeper.yml`'s `agent.command` shape (`{brief}`/`{out}` placeholders,
 * see src/agent/runner.ts) -- it is a *starting point* copied verbatim into
 * `governance/agents.yaml`, not a verified-working command: exact CLI flags
 * drift across versions, so every entry's comment says whether it has been
 * field-tested against a real local install (grok) or is an illustrative
 * example that must be checked against the installed CLI's own `--help`
 * (everything else).
 */
export interface KnownAgentCli {
	/** Short, stable identifier used in governance/agents.yaml and doctor output (e.g. "codex"). */
	name: string;
	/** The executable name probed on PATH. */
	binary: string;
	/** Vendor id in this repo's `vendor/model` convention (see src/roles/policy.ts's vendorOfModelId), or "multi" for a runtime that fronts several vendors (pi). */
	vendor: string;
	/** Which roles-policy.yaml role tiers this CLI is a plausible dispatch target for. */
	tiers: string[];
	/** Illustrative BYO agent.command shape -- see the field-tested-vs-example note above. */
	commandTemplate: string;
}

/**
 * Extend this table to teach `detectAgentClis`/`assignRolesToClis` about a
 * new coding-agent CLI: add one entry (name/binary/vendor/tiers/
 * commandTemplate) -- no other code changes required. `pi` is listed with
 * `vendor: "multi"` and empty `tiers` deliberately: it is a multi-vendor
 * runtime (see src/roles/policy.ts's piRuntimeAvailability), not a
 * single-vendor CLI, so it is detected for informational purposes only and
 * never participates in assignRolesToClis's per-vendor role matching.
 */
export const KNOWN_AGENT_CLIS: readonly KnownAgentCli[] = [
	{
		name: "claude",
		binary: "claude",
		vendor: "anthropic",
		tiers: ["deep-reasoner", "coder", "reviewer"],
		// Example shape only -- verify against your installed Claude Code CLI version's actual
		// headless/non-interactive flags (`claude --help`) before relying on it.
		commandTemplate: "claude -p --output-format text < {brief} > {out}",
	},
	{
		name: "codex",
		binary: "codex",
		vendor: "openai",
		tiers: ["deep-reasoner", "coder", "reviewer"],
		// Example shape only -- verify against your installed Codex CLI version's actual
		// headless flags (`codex exec --help`) before relying on it.
		commandTemplate: "codex exec --full-auto < {brief} > {out}",
	},
	{
		name: "grok",
		binary: "grok",
		vendor: "xai",
		tiers: ["coder", "reviewer"],
		// Field-tested: this exact invocation shape appears as a working example in
		// README.md's "BYO agent runner" section and src/config/discover.ts's
		// missingAgentMessage (both verified against a real local `grok --help`).
		commandTemplate: "grok --prompt-file {brief} > {out}",
	},
	{
		name: "kimi",
		binary: "kimi",
		vendor: "moonshot",
		tiers: ["coder"],
		// Unverified -- no local install has confirmed these flags; adjust to whatever your
		// installed Kimi CLI actually accepts before relying on it.
		commandTemplate: "kimi --prompt-file {brief} > {out}",
	},
	{
		name: "pi",
		binary: "pi",
		vendor: "multi",
		tiers: [],
		// pi fronts several vendors via its own auth.json/models.json (see
		// src/roles/policy.ts's piRuntimeAvailability) -- listed for informational detection
		// only; it never participates in assignRolesToClis's per-vendor matching.
		commandTemplate: "pi run --agent <role> < {brief} > {out}",
	},
] as const;

export interface DetectedAgentCli extends KnownAgentCli {
	/** Absolute path the binary resolved to on PATH. */
	path: string;
	/** First line of `<binary> --version`'s stdout, or null when the spawn failed, timed out, or exited non-zero. */
	version: string | null;
}

const IS_WINDOWS = process.platform === "win32";

/**
 * Checks one PATH directory for an executable *regular file* named `binary`
 * (plus Windows' PATHEXT variants), returning its absolute path or null.
 * `access(X_OK)` alone is not sufficient: a directory can also carry the
 * execute (search) permission bit, so a PATH directory that happens to
 * contain a subdirectory literally named `codex`/`claude`/etc would
 * false-positive as "found" without the `stat().isFile()` check below --
 * this is a real, if unusual, PATH-shadowing hazard (e.g. a build output
 * directory left on PATH by mistake), not a hypothetical one.
 */
async function findExecutableInDir(dir: string, binary: string, env: NodeJS.ProcessEnv): Promise<string | null> {
	const candidates = IS_WINDOWS
		? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((ext) => `${binary}${ext.toLowerCase()}`)
		: [binary];
	for (const candidate of candidates) {
		const full = path.resolve(dir, candidate);
		try {
			await access(full, fsConstants.X_OK);
			const stats = await stat(full);
			if (!stats.isFile()) {
				continue; // an executable-permission directory (or other non-regular entry) is not a match
			}
			return full;
		} catch {
			// Not present (or not executable/not a regular file) in this PATH directory -- try
			// the next candidate/dir.
		}
	}
	return null;
}

/**
 * Node-native `which`: walks `env.PATH` (or `env.Path` on Windows) looking
 * for an executable regular file named `binary`, without shelling out to a
 * real `which` binary (which may itself be absent, e.g. minimal containers).
 * Returns the first match's absolute path, or null if none of PATH's
 * directories have it. Exported so tests/other callers can reuse it without
 * going through detectAgentClis's KNOWN_AGENT_CLIS table.
 *
 * **Only absolute PATH components are ever probed** -- a deliberate, security-
 * motivated deviation from POSIX PATH semantics, not an oversight. POSIX
 * treats an empty component (from a leading/trailing/doubled `:`, e.g.
 * `PATH=:/usr/bin`) as "the current directory", and a relative component
 * (`./bin`, `bin`, ...) resolves against whatever the current directory
 * happens to be. Honoring either here would be a real vulnerability, not a
 * theoretical one: `gatekeeper` routinely runs from *inside* an untrusted
 * checkout -- the very PR diff it's gating -- so a same-named file the PR
 * author committed at the repo root (or any relative PATH directory) could
 * get resolved and then **spawned** as if it were a legitimate `claude`/
 * `codex`/`grok`/etc CLI. An empty or relative PATH component is therefore
 * skipped outright, never resolved against `process.cwd()` or anywhere else.
 */
export async function findOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
	const pathValue = env.PATH ?? env.Path ?? "";
	const rawDirs = pathValue.split(path.delimiter);
	for (const rawDir of rawDirs) {
		if (!path.isAbsolute(rawDir)) {
			continue; // empty/relative component -- see the security note above
		}
		const found = await findExecutableInDir(rawDir, binary, env);
		if (found) {
			return found;
		}
	}
	return null;
}

export type SpawnVersionFn = (
	/** Always the already-resolved absolute path from `findBinary`/`findOnPath` -- see detectAgentClis's call site for why a bare command name is never spawned here. */
	resolvedPath: string,
	args: string[],
	options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<string | null>;

/**
 * Sends SIGKILL to every process in the `--version` probe's process group,
 * not just the immediate child -- the same process-tree hazard
 * src/agent/runner.ts's `killProcessGroup` fixes for the BYO agent runner: a
 * CLI's `--version` invocation can itself be a wrapper (a shell shim, a
 * node/python launcher, ...) that forks a real interpreter/binary as a
 * *grandchild*, which a plain `child.kill()` never reaches and which can
 * then outlive a reported timeout. Unlike runner.ts there is no
 * SIGTERM-then-grace-period escalation here: version detection is
 * best-effort and advisory, so a probe that hasn't produced output within
 * `timeoutMs` is killed outright. `detached: true` at spawn time (POSIX
 * only) makes the child its own process-group leader so the negative-pid
 * signal here reaches the whole tree; Windows has no equivalent and falls
 * back to the single-process `child.kill()`, same documented limitation as
 * runner.ts.
 */
function killVersionProbeGroup(child: ChildProcess): void {
	if (IS_WINDOWS || !child.pid) {
		child.kill("SIGKILL");
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// ESRCH: the group is already gone -- nothing left to signal.
	}
}

/**
 * Runs `<binary> --version` (or whatever `args` names) with a short timeout
 * and returns the first line of stdout on a zero exit, or null on any
 * failure (spawn error, non-zero exit, or timeout) -- version detection is
 * advisory, never worth failing the whole detection pass over. Exported (in
 * addition to being the default `spawnVersion` implementation) so tests can
 * exercise its real process-group-kill behavior directly, the same posture
 * as runner.ts's `runAgentCommand`.
 */
export const defaultSpawnVersion: SpawnVersionFn = (resolvedPath, args, { env, timeoutMs }) => {
	return new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		const finish = (result: string | null) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(resolvedPath, args, {
				env,
				stdio: ["ignore", "pipe", "ignore"],
				// POSIX only -- see killVersionProbeGroup's doc comment.
				...(IS_WINDOWS ? {} : { detached: true }),
			});
		} catch {
			resolve(null);
			return;
		}

		const timer = setTimeout(() => {
			killVersionProbeGroup(child);
			finish(null);
		}, timeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", () => finish(null));
		child.on("close", (code) => {
			if (code !== 0) {
				finish(null);
				return;
			}
			const firstLine = stdout.trim().split("\n")[0];
			finish(firstLine && firstLine.length > 0 ? firstLine : null);
		});
	});
};

export interface DetectAgentClisOptions {
	/** Defaults to process.env. */
	env?: NodeJS.ProcessEnv;
	/** Per-CLI `--version` spawn budget in ms. Defaults to 2000. */
	timeoutMs?: number;
	/** Defaults to KNOWN_AGENT_CLIS -- injectable for tests without a real installed CLI. */
	entries?: readonly KnownAgentCli[];
	/** Injectable PATH lookup (defaults to findOnPath) -- tests stub this to avoid depending on the real machine's PATH. */
	findBinary?: (binary: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
	/** Injectable version probe (defaults to defaultSpawnVersion) -- tests stub this to avoid spawning real processes. */
	spawnVersion?: SpawnVersionFn;
}

/**
 * Probes each entry in `entries` (default KNOWN_AGENT_CLIS) for presence on
 * PATH, and -- only for entries that are present -- its `--version` output.
 * A binary not found on PATH is simply omitted from the result (not an
 * error); a binary found but whose `--version` spawn fails/times out is
 * still included, with `version: null`. Pure detection: no authentication,
 * no network, no model call.
 */
export async function detectAgentClis(options: DetectAgentClisOptions = {}): Promise<DetectedAgentCli[]> {
	const env = options.env ?? process.env;
	const timeoutMs = options.timeoutMs ?? 2000;
	const entries = options.entries ?? KNOWN_AGENT_CLIS;
	const findBinary = options.findBinary ?? findOnPath;
	const spawnVersion = options.spawnVersion ?? defaultSpawnVersion;

	const results: DetectedAgentCli[] = [];
	for (const entry of entries) {
		const resolvedPath = await findBinary(entry.binary, env);
		if (!resolvedPath) {
			continue;
		}
		// Spawns the already-resolved absolute path, never the bare entry.binary name: even
		// though findBinary/findOnPath itself is now PATH-shadow-safe (absolute components
		// only), a bare command name handed to `spawn` would still trigger the OS/Node's own
		// independent binary resolution (which does consult cwd on some platforms) --
		// defense-in-depth against ever executing a same-named file from an untrusted
		// checkout (see findOnPath's doc comment for the full threat model).
		const version = await spawnVersion(resolvedPath, ["--version"], { env, timeoutMs });
		results.push({ ...entry, path: resolvedPath, version });
	}
	return results;
}
