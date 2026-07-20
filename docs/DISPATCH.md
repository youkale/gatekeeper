# Gatekeeper Dispatch

Status: draft (see [Evolution](#evolution) below)

`gatekeeper dispatch` is a local **execution supervisor**: it drives a coding-agent CLI against a GitHub issue, in a locally managed checkout, toward a terminal or report-and-stop state. It fills the gap between `gatekeeper triage` (decide *whether* work should happen) and `gatekeeper gate`/review (decide whether a resulting diff is *acceptable*). This document is normative for dispatch's own on-disk state and CLI contract; the schemas in `src/dispatch/types.ts`, `src/dispatch/evidence.ts`, `src/dispatch/machine.ts`, and `schema/dispatch-result.schema.json` are the source of truth when this document and an implementation disagree.

## 1. Overview and positioning

### 1.1 Not a gate

Dispatch never itself renders a merge verdict, and it never blocks a merge. A `DELIVERED` work order means an agent produced RESULT.json evidence and at least one non-WIP commit on a dedicated branch — the resulting branch/PR still has to pass `gatekeeper gate`/review like any other change. `.gatekeeper/dispatch-ledger.jsonl` (one line per terminated order, in the target repo's own checkout) is dispatch's own audit trail; it is not currently read by `gatekeeper gate`, `check`, or `stats`.

### 1.2 Fail direction: "report and stop"

Dispatch has its own fail-direction law, distinct from (and never overriding) `gatekeeper gate`'s fail-open/fail-closed commitment:

- An uncertain outcome is **never** reported as success. Exit code 0 and process exit 0 alone never mean "delivered" — see the [RESULT.json contract](#2-resultjson-contract-the-delivery-evidence) below.
- Retrying/switching agents is bounded (see [§4](#4-retryswitch-ladder-and-handoff)). Once the ladder is exhausted, dispatch stops in `NEEDS_ATTENTION` and waits for a human — it never retries without limit and never silently discards a run.
- Every state transition is journalled *before* the corresponding side effect begins (spawn, workspace mutation, process kill). A supervisor crash mid-run always leaves a journal a later invocation can fold and reconcile against reality (see [§5](#5-recovery-playbook)).

### 1.3 Relationship to `gatekeeper gate`: exit codes

`gatekeeper gate`'s exit code `1` is reserved exclusively for a confirmed block verdict. Dispatch never returns `1`. Every dispatch subcommand (`start`/`status`/`logs`/`resume`/`cancel`) uses this convention instead (see `src/commands/dispatch.ts`'s own doc comment and each subcommand's `--help`):

| Exit code | Meaning |
| --- | --- |
| `0` | Normal flow only: a `DELIVERED` supervision result (from `start`, `resume`, or `cancel`'s `RUNNING`-branch evidence-first reconciliation, §5.2); `start` declining its confirmation prompt (no order created); `cancel` on an order that is already terminal, whether `DELIVERED` **or** `ABANDONED` (an unconditional no-op either way); or `resume` on an order that is already terminal **and specifically `DELIVERED`**. `status` and `logs` are unconditionally `0` on success and have no "already terminal" special case at all (§3.1) — they read and report state regardless of terminality. |
| `2` | User/config error: bad flags, `start` given neither `--issue` nor `--brief` (§1.5), an unregistered repo, a missing `--brief` file, an unknown/malformed order id, an unresolvable `--agent`, or a state transition the CLI itself refuses because `src/dispatch/machine.ts` has no journal edge for it (e.g. cancelling a still-`PENDING` order). |
| `3` (`DISPATCH_ATTENTION_EXIT_CODE`) | Dispatch's own report-and-stop outcome: a non-`DELIVERED` terminal/report supervision result (`NEEDS_ATTENTION`, `WAITING_COOLDOWN`, `ABANDONED`, an unresolved orphan); `resume` on an already-`ABANDONED` order (prints "already terminal; nothing to resume" but still exits `3`, not `0` — `ABANDONED` is a report-and-stop terminal, not a delivered one); `cancel` completing a *new* cancellation to `ABANDONED` (from `RUNNING`, `WAITING_COOLDOWN`, or `NEEDS_ATTENTION` — even though the cancellation itself succeeded); or an infrastructure fault raised by `src/dispatch/*` once supervision was already under way. |
| `1` | Never used by dispatch — reserved for `gatekeeper gate`'s block verdict. |

**Asymmetry to note:** `cancel` on an already-terminal order is `0` regardless of which terminal state it is, but `resume` on an already-terminal order is `0` only for `DELIVERED` — `resume ABANDONED-order-id` prints the same "already terminal; nothing to <verb>" shape of message as `cancel` does, but exits `3` instead of `0`. This is not an inconsistency between the two subcommands' *behavior* (both correctly refuse to act on a terminal order) — it reflects that `cancel`'s own job (reach `ABANDONED`, one way or another) is already satisfied by a pre-existing `ABANDONED` order, while `resume`'s job (reach `RUNNING` again, then eventually `DELIVERED`) is not, and never can be, once an order is `ABANDONED`.

### 1.4 Fork-PR safety

Dispatch only operates on a local, registered (`gatekeeper adopt`) checkout, on a dedicated branch (`gatekeeper/dispatch/<order-id>`) cut from a configured local base. It never fetches, checks out, or executes a pull-request head ref; `src/dispatch/workspace.ts`'s `assertSafeDispatchBaseRef` rejects any base ref that looks like `refs/pull/*`, `FETCH_HEAD`, or a merge-request ref before any git command runs. The brief handed to the agent never instructs it to do otherwise (`src/render/dispatchBrief.ts`).

### 1.5 Association key: issue-mode vs. ad-hoc

Every work order carries an `association_key` (`src/dispatch/types.ts`'s `associationKeySchema`) in one of two mutually exclusive, visually distinct forms:

- **Issue-mode**, `org/repo#N` — the original/default form, minted whenever `gatekeeper dispatch start --issue <n>` is given an issue number (with or without `--brief`).
- **Ad-hoc**, `org/repo@adhoc-<id>` — minted by `gatekeeper dispatch start --brief <file>` when **no** `--issue` is given at all (T-20260721-01): work with no GitHub issue behind it at all. Ad-hoc mode makes zero GitHub API calls and never looks at the target repo's triage ledger — the `--brief` file is the entire task package. Its brief still goes through the same synthesis template issue-mode briefs use (so the RESULT.json/PROGRESS.md delivery-evidence contract and the branch/commit instructions are always present), just with the "## Issue" and "## Triage 判断" sections omitted outright rather than degraded to an "unavailable" placeholder (`src/render/dispatchBrief.ts`'s `task` field).

Every other consumer of `association_key` — `dispatch status`'s summary/detail views, `.gatekeeper/dispatch-ledger.jsonl` lines, `REVIEWER_VENDOR_CONFLICT` warnings, `resume`/`cancel`/`logs` — treats the key as an opaque string and works identically for both forms; only its shape differs. `associationKeySchema` accepts both forms unconditionally, so every pre-existing `org/repo#N` order on disk keeps parsing unchanged (backward compatible).

## 2. RESULT.json contract (the delivery evidence)

`RESULT.json`, written by the dispatched coding agent into its run's output path, is dispatch's own **quasi-standard surface**: a small, strict, versioned receipt. It is the payload dispatch's evidence check hard-validates before ever calling a run `COMPLETED`. Producers MUST NOT add fields beyond this table — the schema is `.strict()` (zod) / `additionalProperties: false` (JSON Schema) and rejects unknown keys outright; a genuinely new field requires an explicit `apiVersion` bump, not silent tolerance.

### 2.1 Field table

This table is generated by hand from `src/dispatch/evidence.ts`'s `dispatchResultSchema` (zod) and MUST stay in lockstep with `schema/dispatch-result.schema.json` (machine-readable form, reviewed field-by-field alongside the zod schema at delivery time):

| Field | Type | Required | Constraint |
| --- | --- | --- | --- |
| `apiVersion` | string | yes | Must be the literal `"gatekeeper/v1"`. |
| `status` | string | yes | One of `"delivered"` \| `"blocked"`. `"blocked"` is an explicit agent verdict meaning "I cannot complete this without operator input" — it always routes the order straight to `NEEDS_ATTENTION`, even if the process exit code was 0 and commits exist (see [§3.4](#34-run-outcomes-priority-order)). |
| `summary` | string | yes | Non-empty. One paragraph describing what changed and why. |

No other keys are permitted. Example:

```json
{
  "apiVersion": "gatekeeper/v1",
  "status": "delivered",
  "summary": "one paragraph describing what changed and why"
}
```

### 2.2 Where the agent writes it, precisely

Each work order's `acceptance_contract` (`src/dispatch/types.ts`) carries two **run-directory-relative** paths, defaulted by `gatekeeper dispatch start` to:

- `result_path`: `out/RESULT.json`
- `progress_path`: `out/PROGRESS.md`

Both are relative to the run's own directory (`<configDir>/dispatch/orders/<order-id>/runs/<run-id>/`), not to the order directory and not to the target repo checkout. `<run-id>/out/` itself is a plain subdirectory dispatch pre-creates before spawning the agent; it is not a schema-governed path in its own right.

**Precision note on `{out}`** (previously ambiguous — see package E's own deviation report): when the resolved agent command contains an `{out}` placeholder (`src/agent/runner.ts`'s `substitutePlaceholders`), it is substituted with the **exact file path of `result_path`** (e.g. `.../runs/r001/out/RESULT.json`), not the `out/` directory. A command with no `{out}`/`{brief}` placeholder gets the brief piped to its stdin instead, and its raw stdout is written verbatim to that same `result_path` file — which will fail RESULT.json schema validation unless the agent's stdout genuinely is the JSON receipt. `PROGRESS.md` is never passed via a placeholder at all: the brief's own "delivery evidence contract" section (`src/render/dispatchBrief.ts`) is the only place an agent learns to write it, at the same run-relative `progress_path`.

### 2.3 `PROGRESS.md`: a soft contract

`PROGRESS.md` is optional and unvalidated. It exists purely for handoff quality: if an agent run is retried or switched to another agent, `src/dispatch/handoff.ts` embeds the previous run's `PROGRESS.md` verbatim (fenced) into the next run's brief when present. Not writing it never blocks delivery — it only degrades the next agent's context to whatever `git log`/`git diff` evidence remains (see [§4.3](#43-handoff-packet-composition)).

### 2.4 Delivery evidence, in full

Exit code 0 alone is never sufficient. A run is classified `COMPLETED` only when **all** of the following hold (`src/dispatch/evidence.ts`'s `evaluateDeliveryEvidence`):

1. The process exited with code `0` (no signal).
2. `result_path` parses as valid JSON matching §2.1 above, with `status: "delivered"`.
3. `git rev-list <frozen-base>..HEAD` on the dispatch branch contains at least one commit whose subject does **not** start with `wip: run r` (the WIP-snapshot prefix, `src/dispatch/evidence.ts`'s `isWipSnapshotCommit`) — i.e. at least one real, agent-authored commit beyond dispatch's own checkpoint commits.

If `result_path` parses and says `status: "blocked"`, that verdict wins outright regardless of exit code or commit evidence — the run is `AGENT_BLOCKED`, not `COMPLETED` or `EXITED_NO_EVIDENCE`.

### Evolution

Per the T-20260719-10 design's decision (deep-reasoner design, adjudicated by the dispatcher), RESULT.json's contract lives in this document — not `docs/SPEC.md` — while dispatch has no real third-party agent integration yet. Once a genuine external/third-party agent integrates against RESULT.json in production, promote this section to `docs/SPEC.md` proper (with the same MUST/SHOULD normative posture as the contract registry spec) and keep this file as dispatch's operational/runtime documentation only. Until then, any field addition or relaxation here is still a "treat as complex, evaluate backward compatibility" change per `CLAUDE.md`'s product-invariant table.

## 3. State machine

### 3.1 WorkOrder states (six)

`PENDING`, `RUNNING`, `WAITING_COOLDOWN`, `NEEDS_ATTENTION`, `DELIVERED`, `ABANDONED` (`src/dispatch/types.ts`'s `WORK_ORDER_STATUSES`). `DELIVERED` and `ABANDONED` are the only terminal states. `resume` and `cancel` each special-case an existing order that is already terminal as a no-op re-entry point, printing "already terminal; nothing to `<verb>`" — see §1.3's exit-code table for exactly which exit code each of the two produces (they are not the same). `start` has no already-terminal special case at all: it takes no order id and always creates a brand-new order, so its own no-op (declining the confirmation prompt, no order created) is unrelated to any existing order's state — see §1.3. `status` and `logs` likewise have no such special case: both read and report state unconditionally, regardless of whether it is terminal.

### 3.2 WorkOrder transition table (authoritative — mirrors `src/dispatch/machine.ts`'s `transitionTable` edge for edge)

| Journal event | Allowed `from -> to` |
| --- | --- |
| `RUN_STARTED` | `PENDING -> RUNNING` |
| `RUN_RETRY_SCHEDULED` | `RUNNING -> RUNNING` (self-loop: same or next-candidate retry within one order's active run sequence) |
| `COOLDOWN_STARTED` | `RUNNING -> WAITING_COOLDOWN` |
| `ATTENTION_REQUIRED` | `RUNNING -> NEEDS_ATTENTION` |
| `ORDER_DELIVERED` | `RUNNING -> DELIVERED` |
| `ORDER_CANCELLED` | `RUNNING -> ABANDONED`, `WAITING_COOLDOWN -> ABANDONED`, `NEEDS_ATTENTION -> ABANDONED` |
| `ORDER_RESUMED` | `WAITING_COOLDOWN -> RUNNING`, `NEEDS_ATTENTION -> RUNNING` |

There is deliberately **no** `PENDING -> ABANDONED` edge: `gatekeeper dispatch cancel` on a still-`PENDING` (never started) order exits `2` and tells the operator to either start it or delete its order directory by hand (see [§5.5](#55-pending-cancel)).

### 3.3 Migration diagram

```
                         ┌─────────────────────────┐
                         │   RUN_RETRY_SCHEDULED   │
                         │  (same-candidate retry  │
                         │   or ladder switch)     │
                         │                         v
PENDING ──RUN_STARTED──> RUNNING ──────────────────┘
                            │
                            ├──ORDER_DELIVERED───────> DELIVERED        [terminal]
                            │
                            ├──ATTENTION_REQUIRED────> NEEDS_ATTENTION
                            │
                            ├──COOLDOWN_STARTED──────> WAITING_COOLDOWN
                            │
                            └──ORDER_CANCELLED───────> ABANDONED        [terminal]

WAITING_COOLDOWN ──ORDER_RESUMED──────────────────────> RUNNING
WAITING_COOLDOWN ──ORDER_CANCELLED────────────────────> ABANDONED       [terminal]

NEEDS_ATTENTION ──ORDER_RESUMED [--agent X]───────────> RUNNING
NEEDS_ATTENTION ──ORDER_CANCELLED─────────────────────> ABANDONED       [terminal]
```

An audit-only event, `LOCK_TAKEN_OVER`, can appear anywhere in the journal (a new supervisor process took over a dead one's `supervisor.lock`) and never changes WorkOrder state (`foldJournal` skips it explicitly).

### 3.4 Run outcomes (priority order)

Ten Run terminal outcomes exist (`src/dispatch/types.ts`'s `RUN_OUTCOMES`). The table below is in the same priority order `src/dispatch/classify.ts`'s doc comment and `src/dispatch/supervisor.ts` use to decide *which* outcome wins when more than one condition could apply:

| Outcome | How it is reached | WorkOrder consequence |
| --- | --- | --- |
| `COMPLETED` | Exit 0 **and** full delivery evidence (§2.4). | `ORDER_DELIVERED` -> `DELIVERED`. |
| `KILLED` | Operator-issued `dispatch cancel` (or `dispatch resume --kill` on a live orphan). Assigned directly by the cancel/kill code path, never through the classifier. | `ORDER_CANCELLED` -> `ABANDONED`. |
| `TIMEOUT` | Wall-clock budget (`DISPATCH_MAX_RUN_SECONDS`, default 7200s / 2h) exceeded; the supervisor kills the process group itself. A **supervisor-attested** fact — passed straight through the classifier's top priority level, never inferred from exit code/stderr. | Ladder-retryable. |
| `STALLED` | No new stdout/stderr bytes for `DISPATCH_STALL_SECONDS` (600s); the supervisor kills the process group. Also supervisor-attested. | Ladder-retryable. |
| `RATE_LIMITED` | stderr matches a vendor-specific usage-limit pattern (§3.6). | Immediate switch to the next un-cooled ladder candidate, or `COOLDOWN_STARTED` -> `WAITING_COOLDOWN` if none remain. |
| `AGENT_BLOCKED` | `RESULT.json` parses with `status: "blocked"` — wins even over a 0 exit code with commit evidence. | Directly `ATTENTION_REQUIRED` -> `NEEDS_ATTENTION` (no ladder retry: more information is needed, not another agent). |
| `EXITED_NO_EVIDENCE` | Exit 0, but §2.4's evidence requirements are not fully met. **Never** treated as success. | Ladder-retryable. |
| `AGENT_ERROR` | Non-zero exit, reached one of two ways (§3.5): either the CLI-agnostic generic network-error pattern matched (level 4), or nothing matched at all and the conservative fallback applies (level 5). | Ladder-retryable. |
| `SPAWN_FAILED` | The process could not even start (bad command, missing binary). Treated as a configuration defect, not a transient failure. | Directly `ATTENTION_REQUIRED` -> `NEEDS_ATTENTION` (no ladder retry: switching agents will not fix a bad launch configuration). |
| `ORPHANED_UNKNOWN` | A crash-`resume` finds the previous supervisor dead, the run's process group dead too, and evidence inconclusive (neither `COMPLETED` nor `AGENT_BLOCKED`). Assigned directly from §2.4's evidence check, with no exit code/stderr available to run the classifier against. | Ladder-retryable, same as `EXITED_NO_EVIDENCE`. |

**Fidelity note on `ATTENTION_REQUIRED`'s journalled `outcome`:** `src/dispatch/types.ts`'s `attentionOutcomeSchema` does not currently include `RATE_LIMITED` (package A's schema predates package D's cap-exhaustion case). When a `RATE_LIMITED` run exhausts the total run cap (§4.1) with no cooled candidate left, the journal event's `outcome` field records `AGENT_ERROR` instead, with an explicit `reason` string spelling out the substitution (`"RATE_LIMITED exhausted the total run cap of 4; package A cannot encode RATE_LIMITED in ATTENTION_REQUIRED"`). This is a recorded, deliberate audit-fidelity gap (T-20260720-06's deviation report), not a misclassification of the underlying Run — the Run's own `meta.json` still says `RATE_LIMITED` truthfully; only the WorkOrder-level journal event's `outcome` field is affected. `attentionOutcomeSchema` is expected to gain `RATE_LIMITED` as a backward-compatible enum addition in a future package.

### 3.5 Classifier priority (five levels)

`src/dispatch/classify.ts`'s `classifyRunOutcome` is a pure, deterministic function — it never infers `TIMEOUT`/`STALLED`/`KILLED` itself (those are always supplied by the caller as an attested fact). Applied whenever a run's process actually terminated with a real exit code/signal:

1. **Supervisor-attested fact** — if the caller passes `supervisorOutcome` (`TIMEOUT` | `STALLED` | `KILLED`), it wins outright, no further checks.
2. **Delivery evidence** — `AGENT_BLOCKED` wins if RESULT.json says `blocked`; otherwise `COMPLETED` wins if exit 0, no signal, and full §2.4 evidence.
3. **Vendor-specific rate-limit pattern** — a stderr regex keyed by CLI name (`claude`/`codex`/`grok` today; see §3.6).
4. **Generic fallback pattern** — one CLI-agnostic network-error pattern (`ECONNRESET`/`ECONNREFUSED`/`ENOTFOUND`/`ETIMEDOUT` in stderr with exit code 1) -> `AGENT_ERROR`.
5. **Conservative fallback** — nothing matched: non-zero exit -> `AGENT_ERROR`; exit 0 -> `EXITED_NO_EVIDENCE`. A signal-only termination with no supervisor attestation, or a `null`/`null` exit+signal tuple with no attestation, is a programmer-contract error (`ClassificationInputError`) — the classifier refuses to synthesize an outcome it cannot represent, rather than guessing.

A signal without a `supervisorOutcome` attestation is explicitly `UNREPRESENTABLE_TERMINATION` today (there is no independent `SIGNALED` Run outcome) — see [§6](#6-known-limitations).

### 3.6 Rate-limit patterns and cooldown

Three vendor-specific stderr patterns are wired in today (`OUTCOME_RULES` in `src/dispatch/classify.ts`), all matched against exit code `1`:

| CLI family | Pattern anchor (paraphrased) | Default cooldown |
| --- | --- | --- |
| `claude` | "you've hit your (claude) (usage) limit ... resets ..." | **5 hours** |
| `codex` | "you've hit your (codex) usage limit ... try again/resets ..." | **1 hour** |
| `grok` | "grok (api) rate limit exceeded ... retry after/resets ..." | **1 hour** |

Every other CLI name falls back to the `generic` rule family (§3.5 level 4) and has no rate-limit pattern or cooldown default of its own. These defaults, plus the sample stderr text they match, are self-authored placeholders pending real dogfood samples (see [§6](#6-known-limitations)) — they are deliberately conservative (a missed match degrades to `AGENT_ERROR`, which still enters the retry ladder, never a silent false success).

If the matched stderr also contains a parseable reset time (`in 2h`, `in 30m`, `after 45 minutes`, or a strict ISO-8601 timestamp), that becomes `resume_after`; otherwise the vendor default above is used, computed from the run's own end time. `DISPATCH_COOLDOWN_EXIT_THRESHOLD_SECONDS` is **15 minutes**: if the remaining cooldown exceeds 15 minutes, the supervisor appends `COOLDOWN_STARTED` and exits immediately with a `resumeHint` naming the exact resumable-at timestamp (never sleeps in the foreground for a long wait); if 15 minutes or less remain, it sleeps in the foreground and auto-resumes on the same candidate once the cooldown elapses.

## 4. Retry/switch ladder and handoff

### 4.1 The ladder

- **Candidate ladder**: frozen at order-creation time (`gatekeeper dispatch start`) — auto-detected coder-capable CLIs ordered by `roles-policy.yaml`'s `coder` tier `prefer` vendor order, or a single `--agent-command` item that collapses the whole ladder to one entry. This snapshot never changes for the order's lifetime; a CLI installed after order creation is never picked up automatically (see [§6](#6-known-limitations)).
- **Same-candidate retry**: exactly **one** retry per candidate (two total attempts) for `TIMEOUT` / `STALLED` / `AGENT_ERROR` / `EXITED_NO_EVIDENCE` / `ORPHANED_UNKNOWN`. On a candidate's second consecutive failure, the ladder advances to the next candidate.
- **`RATE_LIMITED` never retries the same candidate**: it always either switches to the next un-cooled candidate immediately, or enters `WAITING_COOLDOWN` if none remain (§3.6).
- **`AGENT_BLOCKED` and `SPAWN_FAILED` skip the ladder entirely** and go straight to `NEEDS_ATTENTION` (§3.4).
- **Total run cap: `DISPATCH_TOTAL_RUN_CAP = 4`**, hard, across the whole order regardless of how many distinct candidates or how far along the ladder — the 4th terminal run always routes to `NEEDS_ATTENTION` if it is not itself `COMPLETED`/`KILLED`.
- **Resuming from `NEEDS_ATTENTION`** (`dispatch resume [--agent <cli>]`) does **not** reset the cap, and an `--agent` override does **not** bypass it: if the cap is already exhausted, resume refuses and reports why via `resumeHint`, whether or not `--agent` was given. Without `--agent`, resume continues along the same frozen ladder from wherever it left off; with `--agent`, the resumed run and every subsequent run of this resume episode use that single override candidate only (a durable sidecar records the choice so a crash mid-resume replays deterministically rather than re-guessing).

### 4.2 WIP snapshots

After every run terminates, for any reason, if the target checkout's worktree has uncommitted changes, the supervisor stages and commits them as `wip: run rNNN checkpoint (gatekeeper dispatch)`. This is deliberate, not incidental: git itself is the handoff medium between runs/agents. A staging or commit failure (hooks, LFS, signing) degrades gracefully — the run's own evidence/outcome is unaffected, but that transition's git evidence is marked unavailable and the handoff appendix (§4.3) omits its git-log/diff section rather than blocking the next rung.

### 4.3 Handoff packet composition

Every run after the order's first gets a synthesized brief instead of the original one verbatim (`src/dispatch/handoff.ts`, pure/deterministic, no I/O of its own):

1. The original brief, unchanged, followed by a `---` separator and a "Dispatch handoff appendix" heading.
2. An explicit instruction: inspect the current branch state; continue existing work, do not restart from scratch.
3. A table of every prior run (id, `cli (vendor)`, outcome, duration).
4. `git log --oneline <base>..HEAD` and `git diff --stat` (fenced), unless the last WIP snapshot's git evidence was unavailable (§4.2) or no run has actually authored a commit yet.
5. The previous run's `PROGRESS.md`, verbatim (fenced), if it wrote one.
6. The most recent *failed* run's stderr tail (last 4000 characters, fenced), if any run in this order has a non-`COMPLETED` outcome.

### 4.4 Cross-vendor reviewer conflict

Dispatch tracks `authoring_vendors` — every vendor whose agent actually authored a real (non-WIP) commit on the order (detected via workspace fingerprint diffing, `src/dispatch/supervisor.ts`'s `checkpointWorkspace`). `dispatch status` and a completed supervision result both surface a `REVIEWER_VENDOR_CONFLICT` warning if a configured reviewer-tier vendor is already in `authoring_vendors`, suggesting an alternative vendor from the order's own candidate ladder. This is warn-only in the MVP — dispatch never auto-reassigns a reviewer.

## 5. Recovery playbook

Every command below is quoted verbatim from `gatekeeper dispatch resume --help` / `gatekeeper dispatch cancel --help` (`src/cli.ts`) — flag names here are the real ones, not paraphrases.

### 5.1 Crash-resume (supervisor process died)

There is no daemon: `dispatch start`/`dispatch resume` run the whole supervision loop in the foreground until a terminal/report state. Every transition is journalled before its side effect begins, so re-running the relevant command after any crash always finds a consistent state to reconcile from:

- If the crash happened **after** a transition was journalled (e.g. `RUN_STARTED`/`RUN_RETRY_SCHEDULED`/`ORDER_RESUMED`) but **before** the corresponding run directory was published, the next invocation re-derives the scheduled run id and candidate straight from the journal's own last transition event and (re)publishes/starts that run — no data is lost, nothing is silently skipped.
- If the crash happened **after** a run was published and its process spawned (pid/pgid recorded), the next invocation finds that run still "active" (no `outcome` yet) and falls into orphan reconciliation — §5.2 below.
- If the process group is already confirmably dead when reconciliation runs (pgid was recorded and the group no longer exists), reconciliation is fully **automatic**: no `--wait`/`--kill`/`--confirm-dead` flag is needed. Delivery evidence (§2.4) decides the outcome — `COMPLETED` if it genuinely finished and delivered, `AGENT_BLOCKED` if it left a `status: "blocked"` receipt, otherwise `ORPHANED_UNKNOWN` (ladder-retryable, never assumed successful).

### 5.2 Orphan reconciliation: `--wait` / `--kill` / `--confirm-dead`

`gatekeeper dispatch resume <order-id>` on a `RUNNING` order whose previous supervisor process died:

- **No flag (default, "report")**: if the process group is still alive, dispatch reports `LIVE_PROCESS_GROUP` and tells you to re-run with `--wait` or `--kill`; it never guesses. If the process group id was never durably recorded at all (`MISSING_PGID`), only `--confirm-dead` can move forward — there is nothing to probe.
- **`--wait`**: wait for a live orphaned run's process group to exit on its own (blocks in the foreground, polling), then reconciles by evidence exactly as in §5.1 — this can still resolve to `COMPLETED` if the agent had actually finished and delivered while the supervisor was down.
- **`--kill`**: terminate a live orphaned run's process group now (SIGTERM, 5s grace, then SIGKILL) and mark that run `KILLED`, moving the order to `ABANDONED`.
- **`--confirm-dead`**: treat an orphaned run as confirmed dead even though its process group id was never durably recorded — the only way to make progress on a `MISSING_PGID` orphan. It does **not** override a genuinely detected live process group: if the group id *is* known and still probes alive, `--confirm-dead` still reports `LIVE_PROCESS_GROUP` rather than forcing a decision.

`--wait`, `--kill`, and `--confirm-dead` are mutually exclusive (`src/cli.ts` enforces this with commander `.conflicts()`).

**Deliberate note on `dispatch cancel` and `COMPLETED`:** `gatekeeper dispatch cancel` on a `RUNNING` order also passes `--kill` semantics internally. If, by the time cancel's kill attempt reaches the run, its process group has *already* exited with valid delivery evidence, the order lands on `DELIVERED`, not `ABANDONED` — cancel does not discard real, evidenced work just because a kill was requested. This is intentional, evidence-first behavior, not a race bug: `gatekeeper dispatch cancel`'s own `--help` and stdout both say so explicitly when it happens.

### 5.3 Cooldown resume

`gatekeeper dispatch resume <order-id>` on a `WAITING_COOLDOWN` order either waits out the remainder automatically (if ≤ 15 minutes are left) or, if invoked before that, reports the exact `resumable at <timestamp>` time via `dispatch status`/the `resumeHint`. `--force`: resume a `WAITING_COOLDOWN` order before its cooldown has elapsed — bypasses both the 15-minute exit threshold and the remaining-time sleep outright, resuming on the same candidate that was rate-limited immediately.

### 5.4 `NEEDS_ATTENTION` disposition

`gatekeeper dispatch resume <order-id> [--agent <cli>]`:

- Without `--agent`: continues along the order's own frozen candidate ladder from wherever it left off (§4.1).
- With `--agent <cli>`: a substitute agent CLI for a `NEEDS_ATTENTION` resume. A name `detectAgentClis` finds right now is used directly; otherwise it falls back to the same `.gatekeeper.yml`/`GATEKEEPER_AGENT_COMMAND`/`agents.yaml` resolution chain `triage --run` uses. Has no effect outside `NEEDS_ATTENTION` (a warning is printed and it is ignored). This is the intended escape hatch for a CLI outside the order's frozen ladder snapshot — a fresh install detection never saw at order-creation time, or a CLI the built-in detection table doesn't list at all.
- Neither the cap nor the ladder's already-exhausted-candidate state is bypassed by `--agent` (§4.1) — a resume the supervisor cannot honor is reported truthfully via `resumeHint`, the order stays `NEEDS_ATTENTION`, and the command exits `3`.

### 5.5 `PENDING` cancel

`gatekeeper dispatch cancel` on a still-`PENDING` (never started) order exits `2`: the state machine has no `PENDING -> ABANDONED` edge (§3.2). Run `gatekeeper dispatch start --issue <n>` to begin it, or delete its order directory under `<configDir>/dispatch/orders/<order-id>/` by hand if it must be discarded before starting.

### 5.6 filelock orphan marker: manual recovery

Two distinct persistence layers exist, with different recovery postures:

- **`supervisor.lock`** (`src/dispatch/lock.ts`, one long-held lock per order, hard-link CAS claim chain): stale-holder takeover is **fully automatic** — a new acquirer that finds the lock's recorded pid dead removes it, writes its own, and records a `LOCK_TAKEN_OVER` audit event, with no manual step required. Claim/release marker files under `<order-dir>/supervisor.lock.guard*` are permanent audit structure by design (never garbage-collected) and are not meant to be deleted by hand; a `LOCK_IO_FAILED` timeout acquiring the claim guard itself (after ~500 rapid retries, an extremely pathological contention case) is the only scenario that would call for manual inspection of those sidecar files, and no supported recovery procedure beyond that inspection exists yet.
- **Short read-modify-write locks** (`src/config/filelock.ts`, reused by `src/dispatch/store.ts` for `order.yaml` and `journal.jsonl` writes): these use `filelock.ts`'s own stale-marker reclaim protocol and its two distinct timeout messages, which apply unchanged to dispatch's use of them:
  1. *"held by a live process"* — the ordinary case; the process genuinely still holds the lock. No manual action; retry later.
  2. *"its recorded holder is dead, but reclaim of it is stuck behind another waiter's reclaim marker"* — this requires two failures in a row (the original holder crashed, **and** a waiter attempting to reclaim it also crashed mid-reclaim) and is rare. The error message itself names the exact stale marker path and instructs: read the marker's content (`"<pid>\n<started_at>"`), check that pid with the local equivalent of `kill -0 <pid>` (exit 0 or a permission error means still alive; "no such process" means dead), and only once it is confirmed dead is it safe to manually delete the marker and then the lock file it guards.

Do not delete either lock file speculatively — both mechanisms exist specifically so a human never has to guess whether a lock is safe to remove.

## 6. Known limitations

Honest, current-state list — none of these are silently hidden gaps, and each is a recorded decision, not an oversight:

- **Triage-ledger anchoring differs by call site.** `gatekeeper dispatch start`'s issue-mode brief synthesis reads the triage ledger from the *target repo's own checkout* (`<target-repo-path>/.gatekeeper/triage-ledger.jsonl`), not the invoking `cwd` — this matters when running `dispatch start --repo <org/name>` from a hub/control repo rather than from inside the target repo itself. This is a deliberate best-effort choice (package E), not a bug: the ledger lookup is context, not a hard dependency, and it degrades to "no triage entry found" rather than failing when the two diverge.
- **`PENDING` cancel has no state-machine edge** (§5.5) — by design, not omission; a never-started order is discarded by deleting its order directory, not by a journalled cancellation.
- **`dispatch logs --follow` is not implemented.** `gatekeeper dispatch logs` prints the log file paths plus a tail; watch a live run by tailing those paths directly (e.g. `tail -f`) instead.
- **Rate-limit stderr patterns and cooldown defaults are self-authored placeholders**, not yet calibrated against real vendor CLI output samples. They are conservative by construction (a missed match still enters the retry ladder as `AGENT_ERROR` rather than a false success), but should be revisited once real dogfooding stderr samples are collected.
- **Windows process-group control degrades** the same way `src/agent/runner.ts` already documents for `triage --run`/`init --run`: dispatch's own process-group kill/probe/pgid plumbing (`SIGTERM`/`SIGKILL` on `-pgid`) is POSIX-specific and inherits that runner-level Windows limitation unchanged; it is not a dispatch-specific new gap.
