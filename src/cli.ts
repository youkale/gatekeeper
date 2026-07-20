#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

import { runAdopt } from "./commands/adopt.js";
import { runAudit } from "./commands/audit.js";
import { runCheck } from "./commands/check.js";
import {
	runDispatchCancel,
	runDispatchLogs,
	runDispatchResume,
	runDispatchStart,
	runDispatchStatus,
} from "./commands/dispatch.js";
import { agentsCapabilityCheck, rolesPolicyCapabilityCheck, runDoctor } from "./commands/doctor.js";
import { runGate } from "./commands/gate.js";
import { registerInitCommand } from "./commands/init.js";
import { runInitControl } from "./commands/init-control.js";
import { runProvision } from "./commands/provision.js";
import {
	runReviewAccept,
	runReviewArbitrate,
	runReviewCancel,
	runReviewFix,
	runReviewLogs,
	runReviewRender,
	runReviewResume,
	runReviewStart,
	runReviewStatus,
} from "./commands/review.js";
import { runStats } from "./commands/stats.js";
import { runTriage } from "./commands/triage.js";
import { runValidate } from "./commands/validate.js";
import { MAX_AGENT_TIMEOUT_SECONDS } from "./config/discover.js";

// Stream failures are infrastructure degradation. Warn on the other stream
// when possible, then preserve whatever verdict exit code was already set.
function guardAgainstStreamErrors(
	stream: NodeJS.WriteStream,
	otherStream: NodeJS.WriteStream,
	streamName: "stdout" | "stderr",
): void {
	stream.on("error", (error: NodeJS.ErrnoException) => {
		try {
			otherStream.write(
				`warning: Gatekeeper ${streamName} stream error${error.code ? ` (${error.code})` : ""}; preserving exit code\n`,
			);
		} catch {
			// The warning is best-effort because the fallback stream may also be unavailable.
		}
		process.exit(process.exitCode ?? 0);
	});
}
guardAgainstStreamErrors(process.stdout, process.stderr, "stdout");
guardAgainstStreamErrors(process.stderr, process.stdout, "stderr");

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };

const program = new Command();
program.name("gatekeeper").description("Contract-aware merge gate for multi-repo organizations.").version(version);

function positiveInteger(value: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new InvalidArgumentError("must be a positive integer");
	}
	return parsed;
}

/** Bounded variant of positiveInteger for --agent-timeout: enforces the same MAX_AGENT_TIMEOUT_SECONDS ceiling as .gatekeeper.yml's agent.timeout_seconds and GATEKEEPER_AGENT_TIMEOUT_SECONDS (see src/agent/resolve.ts). */
function agentTimeoutSeconds(value: string): number {
	const parsed = positiveInteger(value);
	if (parsed > MAX_AGENT_TIMEOUT_SECONDS) {
		throw new InvalidArgumentError(`must be at most ${MAX_AGENT_TIMEOUT_SECONDS} seconds`);
	}
	return parsed;
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

// exitOverride must be set before subcommands are added: Command#command()
// copies the parent's exit callback onto the new subcommand at creation time.
program.exitOverride();

program
	.command("check")
	.description("Evaluate the current diff against the contract registry.")
	.option(
		"--registry <dir>",
		"path to the registry directory (defaults to GATEKEEPER_REGISTRY, then .gatekeeper.yml's registry:)",
	)
	.option("--repo <org/name>", "explicit repo identity (defaults to .gatekeeper.yml's repo:, then the origin remote)")
	.addOption(
		new Option(
			"--base <ref>",
			"diff base ref (defaults to .gatekeeper.yml's base:, then auto-detected main/master)",
		).conflicts(["staged", "workingTree"]),
	)
	.addOption(
		new Option("--staged", "diff staged changes instead of base...head")
			.default(false)
			.conflicts(["base", "workingTree"]),
	)
	.addOption(
		new Option("--working-tree", "diff HEAD against the working tree (staged + unstaged, for pre-commit checks)")
			.default(false)
			.conflicts(["base", "staged"]),
	)
	.option("--json", "emit machine-readable verdict JSON on stdout", false)
	.option("--explain", "render file -> glob -> contract -> policy provenance", false)
	.option("--actor <name>", "explicit actor identity (defaults to .gatekeeper.yml's actor:, then git config user.name)")
	.option(
		"--strict-infra",
		"treat infrastructure/config faults as failures (exit 2) instead of fail-open (local debugging)",
		false,
	)
	.action(async (options) => {
		process.exitCode = await runCheck(options, process.cwd());
	});

program
	.command("validate")
	.description("Validate the contract registry: schema check plus glob/foreign-key lint.")
	.option(
		"--registry <dir>",
		"path to the registry directory (defaults to GATEKEEPER_REGISTRY, then .gatekeeper.yml's registry:)",
	)
	.option("--strict", "treat warnings as failures (exit 1)", false)
	.action(async (options) => {
		process.exitCode = await runValidate(options, process.cwd());
	});

program
	.command("gate")
	.description("Evaluate a GitHub pull request and upsert its sticky gate verdict comment.")
	.requiredOption("--pr <n>", "pull request number", positiveInteger)
	.option(
		"--registry <dir>",
		"path to the registry directory (defaults to GATEKEEPER_REGISTRY, then .gatekeeper.yml's registry:)",
	)
	.option(
		"--repo <org/name>",
		"explicit GitHub repository (defaults to .gatekeeper.yml's repo:, then GITHUB_REPOSITORY or origin)",
	)
	.option("--json", "emit the gate report as JSON on stdout", false)
	.option("--explain", "include file -> glob -> contract -> policy provenance in the sticky comment", false)
	.action(async (options) => {
		process.exitCode = await runGate(options, process.cwd());
	});

program
	.command("doctor")
	.description("Validate registry lanes and GitHub branch-protection required checks.")
	.option(
		"--registry <dir>",
		"path to the registry directory (defaults to GATEKEEPER_REGISTRY, then .gatekeeper.yml's registry:)",
	)
	.option(
		"--repo <org/name>",
		"explicit GitHub repository (defaults to .gatekeeper.yml's repo:, then GITHUB_REPOSITORY or origin)",
	)
	.option("--branch <name>", "protected branch (defaults to GITHUB_BASE_REF or main)")
	.option("--workflow <path>", "workflow file or directory (defaults to .github/workflows)")
	.option("--check-name <name>", "expected required check name (repeatable; bypasses workflow discovery)", collect, [])
	.action(async (options) => {
		const cwd = process.cwd();
		process.exitCode = await runDoctor(options, cwd, {
			capabilityChecks: [
				rolesPolicyCapabilityCheck(cwd),
				agentsCapabilityCheck(cwd, { registryOverride: options.registry }),
			],
		});
	});

program
	.command("audit")
	.description("Check registry glob drift against local repository checkouts.")
	.option(
		"--registry <dir>",
		"path to the registry directory (defaults to GATEKEEPER_REGISTRY, then .gatekeeper.yml's registry:)",
	)
	.requiredOption(
		"--repo-path <org/name=path>",
		"map a registry repository to a local checkout (repeatable)",
		collect,
		[],
	)
	.option("--json", "emit the audit report as JSON", false)
	.action(async (options) => {
		process.exitCode = await runAudit(options, process.cwd());
	});

program
	.command("stats")
	.description("Aggregate Gatekeeper ledger rounds from GitHub or a local JSONL file.")
	.addOption(new Option("--source <source>", "ledger source").choices(["github", "local"]).default("local"))
	.option("--repo <org/name>", "GitHub repository (required with --source github; defaults to .gatekeeper.yml's repo:)")
	.option("--token <token>", "GitHub token (defaults to GITHUB_TOKEN)")
	.option("--file <path>", "local JSONL ledger (defaults to .gatekeeper/ledger.jsonl)")
	.option("--since <date>", "harvest merged GitHub PRs at or after this ISO date/time")
	.option("--json", "emit the aggregate report as JSON", false)
	.action(async (options) => {
		process.exitCode = await runStats(options, process.cwd());
	});

program
	.command("triage")
	.description(
		"Assemble a requirement-gate triage briefing for a GitHub issue, or post a completed judgement back to it.",
	)
	.requiredOption("--issue <n>", "issue number", positiveInteger)
	.option("--repo <org/name>", "GitHub repository (defaults to .gatekeeper.yml's repo:)")
	.option(
		"--registry <dir>",
		"path to the registry directory (defaults to GATEKEEPER_REGISTRY, then .gatekeeper.yml's registry:)",
	)
	.option("--post", "post a completed --verdict-file judgement back to the issue instead of printing a briefing", false)
	.option("--verdict-file <path>", "path to a completed judgement JSON file (required with --post)")
	.option(
		"--actor <name>",
		"explicit actor identity recorded on the posted comment (defaults to .gatekeeper.yml's actor:)",
	)
	.option(
		"--run",
		"generate the briefing, run .gatekeeper.yml's configured agent: command against it, then confirm before posting the resulting verdict (mutually exclusive with --verdict-file/--post)",
		false,
	)
	.option("--yes", "skip --run's interactive y/N confirmation (required when stdin is not a TTY)", false)
	.option("--keep-artifacts", "keep --run's temporary brief/verdict files instead of deleting them on exit", false)
	.option(
		"--agent-command <cmd>",
		"--run's tier-1 explicit agent command override (defaults to GATEKEEPER_AGENT_COMMAND, then .gatekeeper.yml's agent.command, then governance/agents.yaml's deep-reasoner assignment)",
	)
	.option(
		"--agent-timeout <seconds>",
		`wall-clock budget in seconds for --agent-command (max ${MAX_AGENT_TIMEOUT_SECONDS})`,
		agentTimeoutSeconds,
	)
	.action(async (options) => {
		process.exitCode = await runTriage(options, process.cwd());
	});

const dispatch = program
	.command("dispatch")
	.description(
		"Local execution supervisor: create/drive a coding-agent run against a GitHub issue (or, via `start --brief` " +
			"alone, an ad-hoc task with no GitHub issue at all) toward a verdict. Not a merge gate -- see each " +
			"subcommand's own --help for its exact exit code contract. In every subcommand, exit code 0 covers a " +
			"DELIVERED supervision result plus a few harmless no-ops -- but not every 'already terminal' re-entry: " +
			"`start` declining its confirmation prompt and `cancel` on an already-terminal order are both 0 " +
			"regardless of terminal state, while `resume` on an already-terminal order is 0 only when that state is " +
			"specifically DELIVERED (an already-ABANDONED order still exits 3 -- see docs/DISPATCH.md §1.3). Exit " +
			"code 1 is reserved for `gatekeeper gate`'s block verdict and is never used here.",
	);

dispatch
	.command("start")
	.description(
		"Create a dispatch work order and run its front-of-terminal supervision loop until a terminal/report state " +
			"(DELIVERED / NEEDS_ATTENTION / WAITING_COOLDOWN / ABANDONED). At least one of --issue or --brief is " +
			"required. The target repo must already be registered via `gatekeeper adopt` (auto-detected from the " +
			"current checkout, or named explicitly with --repo). Three modes: --issue alone dispatches that GitHub " +
			"issue, with the brief synthesized from its body plus the target repo's triage ledger " +
			"(.gatekeeper/triage-ledger.jsonl -- when the same issue has more than one triage line, the LAST one " +
			"wins); --brief alone starts an ad-hoc order with no GitHub issue at all (no GitHub API call, no triage " +
			"ledger lookup, an `org/repo@adhoc-<id>` association key instead of `org/repo#N`); --issue and --brief " +
			"together use the --brief file as the task package verbatim, with --issue only supplying the " +
			"`org/repo#N` association key. Exit codes: 0 on a DELIVERED supervision result, or when the " +
			"confirmation prompt (or --yes) declines to start (no order is created); 2 on bad input/config " +
			"(including neither --issue nor --brief given); 3 on every other non-error report-and-stop outcome " +
			"(NEEDS_ATTENTION / WAITING_COOLDOWN / ABANDONED / an unresolved orphan / a dispatch infrastructure " +
			"fault); never 1.",
	)
	.option(
		"--issue <n>",
		"GitHub issue number to dispatch (omit for an ad-hoc order started from --brief alone)",
		positiveInteger,
	)
	.option(
		"--brief <file>",
		"explicit brief file: the task package outright when --issue is also given, or an ad-hoc order's whole " +
			"brief (no GitHub issue, no triage ledger lookup) when given alone",
	)
	.option(
		"--agent-command <cmd>",
		"explicit single-candidate agent command override (collapses the candidate ladder to this one item)",
	)
	.option(
		"--run-timeout <seconds>",
		"per-run wall-clock budget in seconds (defaults to DISPATCH_MAX_RUN_SECONDS/GATEKEEPER_DISPATCH_MAX_RUN_SECONDS)",
		positiveInteger,
	)
	.option(
		"--repo <org/name>",
		"explicit target repo identity, must already be registered via `gatekeeper adopt` " +
			"(defaults to auto-detecting the current checkout's repo)",
	)
	.option(
		"--registry <dir>",
		"path to the registry directory holding repos.yaml (defaults to GATEKEEPER_REGISTRY, then .gatekeeper.yml's registry:)",
	)
	.option(
		"--yes",
		"skip the interactive y/N confirmation before starting supervision (required when stdin is not a TTY)",
		false,
	)
	.action(async (options) => {
		process.exitCode = await runDispatchStart(options, process.cwd());
	});

dispatch
	.command("status")
	.description(
		"Show every dispatch order's one-line summary, or (given an order id) one order's full detail: current/most " +
			"recent run, log file paths, WAITING_COOLDOWN's resumable-at time (shown first), NEEDS_ATTENTION's next " +
			"command (shown first), and any REVIEWER_VENDOR_CONFLICT warnings against roles-policy.yaml's reviewer " +
			"tier. Read-only; never mutates an order. Exit codes: 0 normally; 2 for an unknown/malformed order id; 3 " +
			"on any other dispatch store read fault; never 1.",
	)
	.argument("[order-id]", "order id (wo-...); omit to list every order")
	.option("--json", "emit machine-readable JSON instead of the human-readable summary", false)
	.action(async (orderId, options) => {
		process.exitCode = await runDispatchStatus({ ...options, orderId }, process.cwd());
	});

dispatch
	.command("logs")
	.description(
		"Print an order run's log file paths and their tail (last 50 lines each). --follow is deliberately not " +
			"implemented -- tail the printed paths directly (e.g. `tail -f`) to watch a live run. Exit codes: 0 " +
			"normally; 2 for an unknown/malformed order id, an order with no runs yet, or an unknown --run; 3 on " +
			"any other dispatch store read fault; never 1.",
	)
	.argument("<order-id>", "order id (wo-...)")
	.option("--run <rNNN>", "which run to show (defaults to the most recent run)")
	.action(async (orderId, options) => {
		process.exitCode = await runDispatchLogs({ ...options, orderId }, process.cwd());
	});

dispatch
	.command("resume")
	.description(
		"Resume a WAITING_COOLDOWN order once its cooldown elapses (or immediately with --force), resume a " +
			"NEEDS_ATTENTION order back to RUNNING (optionally with --agent naming a substitute CLI), or reconcile a " +
			"RUNNING order whose previous supervisor process died: --wait waits for its process group to exit on its " +
			"own, --kill terminates it now, --confirm-dead treats it as confirmed dead when its process group id was " +
			"never durably recorded. A NEEDS_ATTENTION resume the supervisor cannot honor (total run cap already " +
			"exhausted, or the frozen ladder has no unexhausted candidate and no --agent was given) is reported via " +
			"its resumeHint rather than silently retried; the order stays NEEDS_ATTENTION (exit code 3). Exit codes: " +
			"0 on a DELIVERED result, or when the order was already terminal (DELIVERED); 2 for an unknown/malformed " +
			"order id or an unresolvable --agent; 3 on every other non-error outcome; never 1.",
	)
	.argument("<order-id>", "order id (wo-...)")
	.option(
		"--agent <cli>",
		"substitute agent CLI for a NEEDS_ATTENTION resume: a name detectAgentClis finds right now is used " +
			"directly, otherwise it falls back to the same .gatekeeper.yml/GATEKEEPER_AGENT_COMMAND/agents.yaml " +
			"resolution `triage --run` uses (no effect outside NEEDS_ATTENTION)",
	)
	.addOption(
		new Option("--wait", "wait for a live orphaned run's process group to exit on its own").conflicts([
			"kill",
			"confirmDead",
		]),
	)
	.addOption(
		new Option("--kill", "terminate a live orphaned run's process group now").conflicts(["wait", "confirmDead"]),
	)
	.addOption(
		new Option(
			"--confirm-dead",
			"treat an orphaned run as confirmed dead even though its process group id was never durably recorded",
		).conflicts(["wait", "kill"]),
	)
	.option("--force", "resume a WAITING_COOLDOWN order before its cooldown has elapsed", false)
	.action(async (orderId, options) => {
		process.exitCode = await runDispatchResume({ ...options, orderId }, process.cwd());
	});

dispatch
	.command("cancel")
	.description(
		"Terminate an order's active run (if any) and mark it ABANDONED. An already-terminal order is a no-op (exit " +
			"0). A PENDING order (never started) cannot be cancelled -- the dispatch state machine has no PENDING -> " +
			"ABANDONED transition (see the T-20260720-07 deviation report); run `dispatch start` first. Exit codes: " +
			"0 when the order was already terminal (or its active run had already delivered before cancel reached " +
			"it); 2 for an unknown/malformed order id or a still-PENDING order; 3 once cancellation lands on " +
			"ABANDONED, or when it could not complete; never 1.",
	)
	.argument("<order-id>", "order id (wo-...)")
	.action(async (orderId) => {
		process.exitCode = await runDispatchCancel({ orderId }, process.cwd());
	});

const review = program
	.command("review")
	.description(
		"Local review-cycle supervisor: drive N reviewer-CLI lanes through an adversarial diff review, machine-harvest " +
			"structured VERDICT.json judgements, and cycle blocker -> fix -> incremental-re-review rounds until a human " +
			"terminates the cycle (accept or arbitrate). Not a merge gate -- see each subcommand's own --help for its " +
			"exact exit code contract. In every subcommand, exit code 0 covers ACCEPTED plus a few harmless no-ops " +
			"(a declined confirmation, an already-ACCEPTED re-entry); exit code 2 is a user/config error; every other " +
			"non-error outcome (BLOCKED / ARBITRATION / WAITING_COOLDOWN / AWAITING_ACCEPT / ABANDONED / a review " +
			"infrastructure fault) is report-and-stop, exit 3. Exit code 1 is reserved for `gatekeeper gate`'s block " +
			"verdict and is never used here.",
	);

review
	.command("start")
	.description(
		"Create a review cycle and run its front-of-terminal supervision loop for one round, until a report state " +
			"(AWAITING_ACCEPT / BLOCKED / ARBITRATION / WAITING_COOLDOWN). The subject is either a dispatch order id " +
			"(reads its authoring_vendors automatically) or, with --diff, an ad-hoc local diff (--authored-by declares " +
			"the authoring vendors explicitly; omitting it warns that the cross-vendor exclusion will not be enforced). " +
			"The reviewer-tier lane route is frozen at creation: detected reviewer-capable agent CLIs, ordered by " +
			"roles-policy.yaml's reviewer tier preference and excluding every authoring vendor -- the first " +
			"reviewer.count CLIs become required lanes, any further detected CLI becomes advisory (never blocks the " +
			"round, always runs). A required-lane shortfall refuses to start unless --allow-degraded, which proceeds " +
			"with fewer required lanes and marks the cycle DEGRADED (recorded on every review-ledger line it produces). " +
			"Exit codes: 0 when the confirmation prompt (or --yes) declines to start (no cycle is created); 2 on bad " +
			"input/config (including a required-lane shortfall without --allow-degraded); 3 on every report state " +
			"above, or a review infrastructure fault; never 1.",
	)
	.argument("[dispatch-order-id]", "dispatch order id (wo-...) to review; omit when --diff is given")
	.option("--diff", "review an ad-hoc local diff instead of a dispatch order", false)
	.option("--base <ref>", "diff base ref (required with --diff)")
	.option("--head <ref>", "diff head ref (defaults to HEAD, only meaningful with --diff)")
	.option(
		"--authored-by <vendor>",
		"declare a --diff subject's authoring vendor, excluded from the reviewer lane route (repeatable; omitting it " +
			"warns that cross-vendor exclusion is not enforced)",
		collect,
		[],
	)
	.option(
		"--allow-degraded",
		"proceed with fewer than the configured required reviewer lanes, marking the cycle DEGRADED",
		false,
	)
	.option(
		"--max-parallel <n>",
		"maximum reviewer lanes to run concurrently (defaults to the required-lane count)",
		positiveInteger,
	)
	.option(
		"--yes",
		"skip the interactive y/N confirmation before starting review supervision (required when stdin is not a TTY)",
		false,
	)
	.action(async (subject, options) => {
		process.exitCode = await runReviewStart({ ...options, subject }, process.cwd());
	});

review
	.command("status")
	.description(
		"Show every review cycle's one-line summary, or (given a cycle id) one cycle's full detail: subject, target " +
			"repo, lane route, round history, and the state's own next-command hint (WAITING_COOLDOWN's resumable-at " +
			"time is not tracked separately -- see `review logs`/the journal for it). --report additionally recomputes " +
			"the latest round's aggregated blockers (NEW_IN_INCREMENTAL entries sorted first for an incremental round), " +
			"every required/advisory lane's raw VERDICT.json, an advisory-lane-FAIL notice, waived blockers, and a " +
			"subject-fingerprint check against the target repo's current HEAD. Read-only; never mutates a cycle. Exit " +
			"codes: 0 normally; 2 for an unknown/malformed cycle id; 3 on any other review store read fault; never 1.",
	)
	.argument("[cycle-id]", "cycle id (rc-...); omit to list every cycle")
	.option("--json", "emit machine-readable JSON instead of the human-readable summary", false)
	.option(
		"--report",
		"include the latest round's full report material (blockers, raw verdicts, fingerprint check)",
		false,
	)
	.action(async (cycleId, options) => {
		process.exitCode = await runReviewStatus({ ...options, cycleId }, process.cwd());
	});

review
	.command("logs")
	.description(
		"Print a round's lane log/brief/verdict file paths and each lane's stdout/stderr tail (last 50 lines each). " +
			"Defaults to the latest round and every lane in it. Exit codes: 0 normally; 2 for an unknown/malformed " +
			"cycle id, a cycle with no rounds yet, an unknown --round, or an unknown --lane; 3 on any other review " +
			"store read fault; never 1.",
	)
	.argument("<cycle-id>", "cycle id (rc-...)")
	.option("--round <RN>", "which round to show, e.g. R2 or 2 (defaults to the latest round)")
	.option("--lane <LN>", "which lane to show, e.g. L1-codex (defaults to every lane in the round)")
	.action(async (cycleId, options) => {
		process.exitCode = await runReviewLogs({ ...options, cycleId }, process.cwd());
	});

review
	.command("fix")
	.description(
		"Apply human blocker decisions for a BLOCKED (or AWAITING_ACCEPT, advisory-only) cycle, dispatch the original " +
			"coding agent back to fix exactly the still-open blockers, then automatically run the next incremental " +
			"review round -- one command, front-of-terminal, printing a phase banner as each phase actually starts " +
			"(fix dispatch/supervision, then the incremental review round). Every blocker not named by --waive is left " +
			"open and included in the fix brief. --waive <blocker-id>=<reason> records a human waiver (reason " +
			"required, non-empty) and excludes that blocker from the fix brief; AWAITING_ACCEPT cannot waive (there is " +
			"nothing BLOCKED to waive) -- use --adopt <advisory-id> there to promote an advisory finding into the fix. " +
			"Interrupted (Ctrl-C)? Run `gatekeeper review resume <cycle-id>` to continue from the last durable " +
			"checkpoint. Exit codes: 0 when the confirmation prompt (or --yes) declines to proceed; 2 on bad input " +
			"(an unknown/malformed cycle id, wrong cycle state, a malformed --waive, waiving from AWAITING_ACCEPT, or " +
			"an unknown --waive/--adopt blocker id); 3 on every report state the resulting round reaches, or a " +
			"review/dispatch infrastructure fault; never 1.",
	)
	.argument("<cycle-id>", "cycle id (rc-...)")
	.option("--waive <blocker-id=reason>", "waive a blocker with a required, non-empty reason (repeatable)", collect, [])
	.option(
		"--adopt <advisory-id>",
		"adopt an advisory (non-required-lane) finding into the fix brief (repeatable)",
		collect,
		[],
	)
	.option(
		"--yes",
		"skip the interactive y/N confirmation before dispatching the fix (required when stdin is not a TTY)",
		false,
	)
	.action(async (cycleId, options) => {
		process.exitCode = await runReviewFix({ ...options, cycleId }, process.cwd());
	});

review
	.command("accept")
	.description(
		"Terminate an AWAITING_ACCEPT or ARBITRATION cycle as ACCEPTED and append a review-ledger line to the target " +
			"repo's .gatekeeper/review-ledger.jsonl. Exit codes: 0 on success; 2 for an unknown/malformed cycle id, or " +
			"when the cycle is in any other state; 3 on a review infrastructure fault (including a lock currently held " +
			"by a live supervision process); never 1.",
	)
	.argument("<cycle-id>", "cycle id (rc-...)")
	.option("--note <text>", "optional note recorded on the acceptance journal event and ledger line")
	.action(async (cycleId, options) => {
		process.exitCode = await runReviewAccept({ ...options, cycleId }, process.cwd());
	});

review
	.command("arbitrate")
	.description(
		"Resolve an ARBITRATION cycle (round limit reached, or a required lane could not be formed) with one of three " +
			"human decisions: --decision accept terminates ACCEPTED (ledger line appended); --decision abandon " +
			"terminates ABANDONED (ledger line appended); --decision extend grants exactly one additional round " +
			"(max_rounds +1, journaled with --reason) and immediately runs it, front-of-terminal, to its own report " +
			"state. Exit codes: 0 for --decision accept; 2 for an unknown/malformed cycle id, when the cycle is not in " +
			"ARBITRATION, or when --reason is empty; 3 for --decision abandon, or for --decision extend's resulting " +
			"report state / any review infrastructure fault; never 1.",
	)
	.argument("<cycle-id>", "cycle id (rc-...)")
	.requiredOption("--reason <text>", "non-empty rationale for this arbitration decision (journaled)")
	.addOption(
		new Option("--decision <decision>", "arbitration decision")
			.choices(["accept", "abandon", "extend"])
			.makeOptionMandatory(true),
	)
	.action(async (cycleId, options) => {
		process.exitCode = await runReviewArbitrate({ ...options, cycleId }, process.cwd());
	});

review
	.command("resume")
	.description(
		"Reconcile journal/artifact skew, re-adjudicate any orphaned lane by its evidence, and continue a non-terminal " +
			"cycle (WAITING_COOLDOWN resumes the cooled-down round; FIXING continues supervising its dispatched fix " +
			"order; any other non-terminal state re-derives its report state from durable evidence) to its next report " +
			"state. An already-terminal cycle is a no-op. Exit codes: 0 when the cycle is already ACCEPTED, or becomes " +
			"ACCEPTED; 2 for an unknown/malformed cycle id; 3 when the cycle is already ABANDONED, or reaches any " +
			"other report state, or a review infrastructure fault occurs; never 1.",
	)
	.argument("<cycle-id>", "cycle id (rc-...)")
	.action(async (cycleId) => {
		process.exitCode = await runReviewResume({ cycleId }, process.cwd());
	});

review
	.command("cancel")
	.description(
		"Journal-terminate a non-terminal cycle as ABANDONED and append a review-ledger line. An already-terminal " +
			"cycle is a no-op (exit 0). A PENDING cycle (never started) cannot be cancelled -- the review state " +
			"machine has no PENDING -> ABANDONED transition; run `review start` first. Does not attempt to kill any " +
			"live reviewer/fix subprocess -- while a live supervision process still holds the cycle's lock, this " +
			"command cannot proceed at all (its lock acquisition fails and is reported as a fault) rather than racing " +
			"it. Exit codes: 0 when the cycle was already terminal; 2 for an unknown/malformed cycle id or a still-" +
			"PENDING cycle; 3 once cancellation lands on ABANDONED, or when it could not complete; never 1.",
	)
	.argument("<cycle-id>", "cycle id (rc-...)")
	.action(async (cycleId) => {
		process.exitCode = await runReviewCancel({ cycleId }, process.cwd());
	});

review
	.command("render")
	.description(
		"Render a cycle's current state as a version-independent Markdown block, marked with its own sticky-comment " +
			"marker (<!-- gatekeeper:review-verdict:v1 -->) -- deliberately never the gate's own sticky marker (<!-- " +
			"gatekeeper:verdict -->), so a review-render comment and a gate-verdict comment can coexist on the same PR " +
			"thread without colliding. Prints to stdout only -- publishing it as an actual PR comment/check-run (the " +
			"only trusted way for a local review-ledger line to become gate evidence) is left to the caller's own " +
			"trusted-identity publishing path; see docs/REVIEW.md. Exit codes: 0 normally; 2 for an unsupported " +
			"--format or an unknown/malformed cycle id; 3 on any other review store read fault; never 1.",
	)
	.argument("<cycle-id>", "cycle id (rc-...)")
	.requiredOption("--format <format>", 'output format (only "comment" is supported)')
	.action(async (cycleId, options) => {
		process.exitCode = await runReviewRender({ ...options, cycleId }, process.cwd());
	});

registerInitCommand(program);

program
	.command("init-control")
	.description(
		"Scaffold a brand-new control/hub repo: governance/registry (policy.yaml, contracts/, an empty repos.yaml), " +
			"governance/roles (customizable role-card copies), and a root roles-policy.yaml copy, then validate the result.",
	)
	.argument("<path>", "control repo root to create/populate")
	.option(
		"--force",
		"overwrite every existing template artifact, except repos.yaml (gatekeeper adopt's own roster, never touched once it exists)",
		false,
	)
	.option("--no-detect", "skip local agent CLI detection and governance/agents.yaml generation")
	.action(async (targetPath, options) => {
		process.exitCode = await runInitControl({ ...options, path: targetPath }, process.cwd());
	});

program
	.command("adopt")
	.description(
		"Register a repository with the contract registry located inside a control/hub checkout. Zero-touch: " +
			"nothing is written into the target repo -- upserts its entry into <registry>/repos.yaml and this " +
			"machine's user-level controls index (~/.config/gatekeeper/controls.yaml), so every other command's " +
			"zero-flag config discovery can find it from inside the repo without any file living there.",
	)
	.argument("[path]", "target repo to adopt (defaults to the current directory)")
	.requiredOption(
		"--control <path>",
		"control/hub repo path; the registry is located inside it (governance/registry, then registry, then the control repo itself)",
	)
	.option("--repo <org/name>", "explicit repo identity (defaults to the origin remote)")
	.action(async (targetPath, options) => {
		process.exitCode = await runAdopt({ ...options, path: targetPath }, process.cwd());
	});

program
	.command("provision")
	.description(
		"Fan CI job / pre-push hook / AGENTS.md scaffolding out across every repo registered by `gatekeeper adopt`.",
	)
	.argument("[repos...]", "limit to these registered org/name repos (default: every registered repo)")
	.option(
		"--registry <path>",
		"path to the registry directory holding repos.yaml (defaults to GATEKEEPER_REGISTRY, then .gatekeeper.yml's registry:)",
	)
	.option("--ci", "generate/update each repo's CI job (per its registered ci: provider)", false)
	.option("--hooks", "install a fail-open pre-push hook in each repo", false)
	.option("--agents-md", "add/update a Gatekeeper instruction block in each repo's AGENTS.md", false)
	.option("--dry-run", "print what would be done per repo without writing anything", false)
	.option("--force", "overwrite an existing pre-push hook or GitHub workflow copy", false)
	.action(async (repos, options) => {
		process.exitCode = await runProvision({ ...options, repos }, process.cwd());
	});

try {
	await program.parseAsync(process.argv);
} catch (error) {
	if (error instanceof CommanderError) {
		// Usage errors (unknown flag, missing argument value, ...) map to exit 2.
		// --help/--version use CommanderError too, but with exitCode 0 — preserve that.
		process.exitCode = error.exitCode === 0 ? 0 : 2;
	} else {
		throw error;
	}
}
