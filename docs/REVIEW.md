# Gatekeeper Review

Status: draft (see [Evolution](#evolution) below)

`gatekeeper review` is a local **judgment supervisor**: it drives N reviewer-CLI lanes through an adversarial read-only
review of a diff, machine-harvests each lane's structured `VERDICT.json`, and cycles blocker → fix → incremental-
re-review rounds until a human terminates the cycle (`accept` or `arbitrate`). It is the sibling of
[`gatekeeper dispatch`](DISPATCH.md): dispatch supervises *producing* a diff, review supervises *judging* one. This
document is normative for review's own on-disk state and CLI contract; `src/review/types.ts`, `src/review/machine.ts`,
`src/review/verdict.ts`, `src/review/evidence.ts`, `src/review/supervisor.ts`, and `schema/review-verdict.schema.json`
are the source of truth when this document and an implementation disagree.

## 1. Overview and positioning

### 1.1 A judgment supervisor, not the merge gate

Review never itself renders a merge verdict and never blocks a merge. An `ACCEPTED` cycle means a human looked at
every required lane's evidence-backed judgment (and the full round history) and terminated the cycle; nothing about
`ACCEPTED` is automatically visible to `gatekeeper gate` or to a PR's checks. The only way a review cycle's outcome
becomes gate evidence is `review render`'s output being published, through a *trusted* channel, as a PR comment or
check-run — see [§8](#8-gate-integration-and-the-anti-forgery-boundary). `.gatekeeper/review-ledger.jsonl` (one line
per terminated cycle, in the target repo's own checkout) is review's own audit trail, exactly like dispatch's
`dispatch-ledger.jsonl`; it is not currently read by `gatekeeper gate`, `check`, or `stats`.

### 1.2 Fail direction: never a false PASS

Review's fail-direction law is **stricter** than dispatch's "report and stop" (`docs/DISPATCH.md` §1.2), because
review's whole job is producing a judgment other systems may eventually trust:

- A lane whose evidence cannot be established as VALID — a missing/corrupt/schema-mismatched `VERDICT.json`, a
  stale/mismatched `run_token` or `round`, a workspace the lane wrote to, or a supervisor-attested `TIMEOUT`/
  `STALLED`/`KILLED` — is **never** folded into a `PASS`. It is `INVALID`, and a required lane that ends its retry
  ladder still `INVALID` makes the whole round `UNAVAILABLE`, which always routes to human `ARBITRATION`, never to a
  false `AWAITING_ACCEPT` (see [§4](#4-lane-routing-and-the-evidence-gate), [§5](#5-state-machine)).
- Retrying/substituting reviewer candidates is bounded (§4). Once a required lane's ladder is exhausted, the round is
  `UNAVAILABLE` and the cycle stops in `ARBITRATION` for a human — it never silently drops a required lane's opinion
  or reports success without it.
- Every state transition is journalled *before* the corresponding side effect begins (round-directory publish, fix
  dispatch, lane conclusion). A supervisor crash mid-cycle always leaves a journal a later `review resume` can fold
  and reconcile against reality (§7).

### 1.3 Exit codes

Every review subcommand (`start`/`status`/`logs`/`fix`/`accept`/`arbitrate`/`resume`/`cancel`/`render`) uses the same
three-value convention `docs/DISPATCH.md` §1.3 defines for dispatch — same shape, independently implemented (see
`src/commands/review.ts`'s own doc comment and each subcommand's `--help`):

There is **no** single rule that holds uniformly across all nine subcommands for any exit code — each subcommand's
own trigger conditions are listed separately below, by name, precisely because pooling several subcommands behind one
shared adjective ("already terminal", "report state", ...) is exactly what has produced contradictions in this kind
of table before. Do not infer one subcommand's behavior from another's unless a row explicitly says they match.

| Exit code | Meaning, per subcommand |
| --- | --- |
| `0` | `start`: the confirmation prompt (or `--yes`) declined — no cycle was created. `fix`: the confirmation prompt (or `--yes`) declined — no fix was dispatched. `accept`: the cycle became `ACCEPTED`. `arbitrate --decision accept`: the cycle became `ACCEPTED`. `resume`: the cycle was **already** `ACCEPTED` ("already terminal; nothing to resume"). `cancel`: the cycle was **already terminal**, whether `ACCEPTED` **or** `ABANDONED` (an unconditional no-op either way, mirroring dispatch's own `cancel` asymmetry). `status`/`logs`/`render`: unconditionally `0` on a successful read — these three never mutate a cycle and have no state-dependent branch at all. |
| `2` | `start`: bad flags (`--diff` together with a dispatch-order id, or neither; `--diff` without `--base`), a subject-resolution usage error, a roles-policy load failure or missing `reviewer` tier, a required-reviewer-lane shortfall without `--allow-degraded`, or a non-interactive terminal without `--yes`. `status`: an unknown/malformed cycle id. `logs`: an unknown/malformed cycle id, a cycle with no rounds yet, an unknown `--round`, or an unknown `--lane`. `fix`: an unknown/malformed cycle id, a cycle that is not `BLOCKED`/`AWAITING_ACCEPT`, a malformed `--waive`, waiving from `AWAITING_ACCEPT`, a non-interactive terminal without `--yes`, or an unknown `--waive`/`--adopt` blocker id. `accept`: an unknown/malformed cycle id, or a cycle **not** in `AWAITING_ACCEPT`/`ARBITRATION` — this includes an *already-`ACCEPTED`* cycle: `accept` has no "already terminal, harmless no-op" branch at all. `arbitrate`: an unknown/malformed cycle id, an empty `--reason`, or a cycle **not** in `ARBITRATION` — this includes an already-`ACCEPTED` **or** an already-`ABANDONED` cycle: like `accept`, `arbitrate` has no "already terminal" no-op branch either, for either terminal state. `cancel`: an unknown/malformed cycle id, or a still-`PENDING` cycle (no `PENDING -> ABANDONED` edge, §5.1/§7.4). `render`: an unsupported `--format`, or an unknown/malformed cycle id. |
| `REVIEW_ATTENTION_EXIT_CODE` (`3`) | `start`/`fix`/`resume`/`arbitrate --decision extend`: every non-`ACCEPTED` report state the resulting round reaches (`BLOCKED` / `ARBITRATION` / `WAITING_COOLDOWN` / `AWAITING_ACCEPT`). `resume`: also, specifically, an already-terminal `ABANDONED` cycle ("already terminal; nothing to resume") — this is the **only** subcommand where re-invoking against an already-`ABANDONED` cycle exits `3` rather than `2` (see the asymmetry note below; `arbitrate` on an already-`ABANDONED` cycle is a `2`, not a `3` — it is rejected by the `2` row's "cycle not in ARBITRATION" branch before any abandon logic runs). `cancel`: a completed cancellation to `ABANDONED`, i.e. the cycle was genuinely non-terminal beforehand. `arbitrate --decision abandon`: a completed cancellation to `ABANDONED` — reachable only starting from `ARBITRATION`, never from an already-`ABANDONED` cycle (that case is a `2`, per above). `status`/`logs`/`render`: any review-store read fault other than an unknown/malformed cycle id (e.g. a corrupt `cycle.yaml` or journal). Any subcommand: a supervisor lock currently held by a live process, or a review/dispatch infrastructure fault raised once supervision was already under way. |
| `1` | Never used by review — reserved exclusively for `gatekeeper gate`'s block verdict (`CLAUDE.md`'s fail-direction law). |

**Asymmetry to note (mirrors `docs/DISPATCH.md` §1.3's own callout, independently true here):** `cancel` on an
already-terminal cycle is `0` regardless of which terminal state it is, but `resume` on an already-terminal cycle is
`0` only for `ACCEPTED` — `resume` on an `ABANDONED` cycle prints the same "already terminal; nothing to `<verb>`"
shape of message `cancel` does, but exits `3`, not `0`. And unlike either of those two, `accept`/`arbitrate` have
**no** already-terminal no-op path at all — calling `review accept` on a cycle that is already `ACCEPTED` is a plain
`2` usage error ("cycle is ACCEPTED; accept only applies to AWAITING_ACCEPT or ARBITRATION"), not a harmless re-entry.
Do not generalize "review's terminal states are harmless to re-invoke a command against" across every subcommand —
it is true of `resume` and `cancel` specifically, not of `accept`/`arbitrate`.

### 1.4 Mutual exclusion with dispatch

Review and dispatch never run against the same target-repo checkout (same realpath) concurrently, in either
direction:

- Before every reviewer-lane attempt, review scans dispatch's own orders for a `RUNNING` order on the same realpath
  with a live supervisor process and refuses (`TARGET_REPOSITORY_BUSY`) if it finds one — `src/review/supervisor.ts`'s
  `assertNoDispatchConflict`.
- Symmetrically, `dispatch start`/`resume`'s own busy scan (package F, `src/dispatch/supervisor.ts`) checks review's
  non-terminal cycles for the same realpath and refuses to start if a live review supervisor already holds one —
  reusing `listCycles`; a missing/empty review store is a normal default (`[]`), never a conflict.
- The one deliberate exception: `review fix`'s own fix `WorkOrder` (dispatched back to the *original* coding agent,
  §6.2) would otherwise be rejected by dispatch's busy scan as conflicting with the very review cycle that dispatched
  it. `reviewCyclesVisibleToFixDispatch` filters out exactly the *owning* cycle's own entry before dispatch's scan
  runs (`busyExemptionCycleId`) — every *other* live review cycle on that repo remains a real conflict.

### 1.5 Fork-PR safety and the zero-model invariant

Review only operates on a local, already-resolved checkout (a registered dispatch order's `target_repo`, or a `--diff`
subject's local Git working tree) — it never fetches, checks out, or executes a pull-request head ref itself. The
zero-model invariant holds throughout `src/review/*` and `src/commands/review.ts`: every decision in this module is
either a direct pass-through of a human flag/decision, or a deterministic read of already-persisted state. The actual
reviewer *judgment* happens entirely inside external reviewer CLIs the supervisor spawns and reads structured
`VERDICT.json` evidence from — same "product core makes zero model calls" posture the rest of `src/` holds to.

## 2. Storage layout

```
<configDir>/review/cycles/<cycle-id>/
  cycle.yaml            # frozen at creation: subject, target_repo, authoring_vendors, max_rounds, lane_snapshot, degraded
  journal.jsonl          # append-only, strict discriminated-union events (§5)
  subject.md              # rendered once at creation (dispatch-order run summary, or diff commit log)
  supervisor.lock         # reuses src/dispatch/lock.ts's parameterized hard-link CAS primitive (package A)
  rounds/
    R1/
      summary.json         # this round's Round record (status/verdict/lane_results/subject_fingerprint)
      aggregate.json        # this round's deduplicated AggregatedBlocker[] + warnings (src/review/aggregate.ts)
      lanes/
        L1-codex/
          brief.md            # rendered reviewer brief (src/render/reviewBrief.ts), injected run_token/round
          stdout.log / stderr.log
          meta.json             # this lane's Lane record (status/outcome/pid/pgid/exit_code/signal)
          attempts.json          # every attempt this lane has made against its candidate ladder (§4)
          out/VERDICT.json         # the lane's own evidence artifact (§3) -- must never be written to by anyone else
        L2-claude/ ...
    R2/ ...
```

`<configDir>` defaults to `~/.config/gatekeeper`, overridable via `GATEKEEPER_CONFIG_DIR` — the same host-machine
state posture as `dispatch/orders/`. A round's directory is staged under `rounds/.tmp-R<n>-supervisor/` while its
lanes are still running and only atomically renamed into its final `rounds/R<n>/` path once the round has concluded
and its `ROUND_CONCLUDED` journal event is durable — see [§7](#7-recovery-playbook) for why a crash between those two
steps needs `review resume`, specifically, to repair.

## 3. VERDICT.json contract

`VERDICT.json`, written by each reviewer-lane CLI into its own run's `out/` directory, is review's own
**quasi-standard surface** (parallel to dispatch's `RESULT.json`, `docs/DISPATCH.md` §2): a small, strict, versioned
judgment receipt. `src/review/evidence.ts`'s evidence gate hard-validates it before a lane's outcome can ever be
`PASS`/`FAIL`. Producers MUST NOT add fields beyond this table — both representations are strict (zod `.strict()` /
JSON Schema `additionalProperties: false`) and reject unknown keys outright; a genuinely new field requires an
explicit `apiVersion` bump, not silent tolerance.

### 3.1 Top-level field table

Generated by hand from `src/review/verdict.ts`'s `reviewVerdictSchema` and MUST stay in lockstep with
`schema/review-verdict.schema.json` (reviewed field-by-field alongside the zod schema at delivery time — package B's
own acceptance criterion):

| Field | Type | Required | Constraint |
| --- | --- | --- | --- |
| `apiVersion` | string | yes | Must be the literal `"gatekeeper/v1"`. |
| `verdict` | string | yes | `"pass"` \| `"fail"`. |
| `run_token` | string | yes | Non-empty. Must equal, verbatim, the one-time token this lane's brief injected for this run — the sole formatter is `generateRunToken` (`rv1_` prefix + 32 injected random bytes as lowercase hex); the evidence gate performs only an exact string comparison and deliberately does not duplicate the format rule. |
| `round` | integer | yes | Positive. Must equal the round number this lane's brief was generated for. |
| `blockers` | array of [Blocker](#32-blocker-object) | yes | **Interlocked with `verdict`**: empty exactly when `verdict` is `"pass"`; at least one entry exactly when `verdict` is `"fail"`. Enforced by a zod `superRefine` and, identically, a JSON Schema `allOf`/`if`/`then` pair — the two representations were verified equivalent by both external reviewers at delivery time. |
| `non_blockers` | array of [NonBlocker](#33-nonblocker-object) | yes | Advisory observations; may be empty. Never changes the lane's `verdict`. |
| `out_of_scope` | array of string | no | Each entry non-empty. Things the lane noticed but deliberately did not treat as in-scope for this review. |

### 3.2 Blocker object

Strict (`additionalProperties: false` / zod `.strict()`). Required: `file`, `title`, `evidence`.

| Field | Type | Required | Constraint |
| --- | --- | --- | --- |
| `id` | string | no | `blockerReferenceSchema`: `^B-r[1-9]\d*-L[1-9]\d*-(?:0[1-9]|[1-9]\d)$` (positive, non-zero-prefixed round/lane; a two-digit `01`–`99` sequence). The schema accepts this field on an inbound lane `VERDICT.json`, but `src/review/aggregate.ts`'s `aggregateBlockers` never reads a lane-supplied `id` — stable ids are always minted server-side, deterministically, from `(file, line, title)` grouping (§6.2); a lane setting its own `id` here has no effect on Gatekeeper's own id assignment. |
| `ref` | string | no | Same `blockerReferenceSchema` shape as `id`. Declares "this is the same issue as prior-round blocker `<ref>`". This schema validates **syntax only** — whether `ref` actually names a real id from the previous round is checked later, by `src/review/aggregate.ts`'s `resolveRefs` (§6.5's `NEW_IN_INCREMENTAL` marker), not by this schema. |
| `file` | string | **yes** | Non-empty. |
| `line` | integer | no | Positive, one-based. |
| `title` | string | **yes** | Non-empty, concise. |
| `evidence` | string | **yes** | Non-empty. Concrete, verifiable evidence — not a restated title. |
| `suggested_fix` | string | no | Non-empty. |
| `category` | string enum | no | One of `correctness` \| `fail-direction` \| `security` \| `compat` \| `data-loss` \| `test`. `src/render/reviewBrief.ts` derives the exact value list shown to reviewers by zod introspection of this same schema (not a hand-copied literal), so a future enum change can never silently drift the brief's own rendered text out of sync. |

### 3.3 NonBlocker object

Strict. Required: `note`.

| Field | Type | Required | Constraint |
| --- | --- | --- | --- |
| `file` | string | no | Non-empty. |
| `line` | integer | no | Positive, one-based. |
| `note` | string | **yes** | Non-empty advisory observation. |

### Evolution

Per `T-20260721-02`'s design (deep-reasoner design, adjudicated by the dispatcher, same posture `docs/DISPATCH.md`'s
own RESULT.json Evolution clause takes), `VERDICT.json`'s contract lives in this document — not `docs/SPEC.md` —
while review has no genuine third-party reviewer-CLI integration in production yet. Once a real external/third-party
reviewer integrates against `VERDICT.json`, promote this section to `docs/SPEC.md` proper (same MUST/SHOULD
normative posture as the contract registry spec) and keep this file as review's operational/runtime documentation
only. Until then, any field addition or relaxation here is still a "treat as complex, evaluate backward
compatibility" change per `CLAUDE.md`'s product-invariant table.

## 4. Lane routing and the evidence gate

### 4.1 Route selection (frozen at `review start`)

`review start` freezes the cycle's entire lane route once, at creation (`cycle.yaml`'s `lane_snapshot`); nothing
about it can change for the cycle's lifetime, even if `roles-policy.yaml` or installed CLIs change later:

1. Detect every locally installed agent CLI tagged for the `reviewer` role tier (`detectAgentClis`).
2. Exclude every CLI whose vendor is an **authoring vendor** for this subject — read automatically from a
   dispatch-order subject's `authoring_vendors`, or declared explicitly via one or more `--authored-by <vendor>` for
   a `--diff` subject (omitting it only warns that cross-vendor exclusion will not be enforced — it never blocks
   `start`).
3. Order the remaining eligible CLIs by `roles-policy.yaml`'s `reviewer` tier `prefer` vendor order, cross-vendor
   first when the tier requests it (`cross_vendor: true`, the packaged default) — one CLI per preferred vendor first,
   then every remaining eligible CLI.
4. The first `tier.count` entries (default `2`, the packaged `roles-policy.yaml`'s `reviewer.count`) become
   **required** lanes (`L1`, `L2`, ...); every further detected-and-eligible CLI becomes an **advisory** lane
   (`L3`, ...) — it always runs, but its outcome never blocks the round.

> **⚠️ Loud warning:** the required/advisory split above is purely **positional** — "first `tier.count` after
> ordering" — not an explicit per-lane field anywhere in `cycle.yaml`. Reordering `roles-policy.yaml`'s `reviewer`
> tier's `prefer` list (or its `count`) changes which real, already-installed CLI lands inside the first `count` slots
> versus the advisory overflow, **silently, for every review cycle created after that edit** — a CLI that used to be
> required can become advisory (and stop blocking rounds) purely because someone reordered a preference list for an
> unrelated reason. This is a deliberate MVP simplification (`T-20260721-02` design §4, dispatcher-adjudicated
> undecided item 1): an explicit `advisory: true`/quorum field is deferred until either the first accidental
> reorder-induced drift, or the first genuine non-default-quorum requirement, is actually observed in practice — not
> designed speculatively ahead of that signal. Until then, treat any `roles-policy.yaml` `reviewer` tier edit as a
> change that can silently reclassify which lanes are load-bearing.

A required-lane shortfall (fewer eligible CLIs than `tier.count` after authoring exclusion) refuses to start at all
(exit `2`) unless `--allow-degraded`, which proceeds with fewer required lanes and marks the cycle `degraded: true` —
recorded on every `review-ledger.jsonl` line this cycle ever produces (see §6, §8), as the durable "reviewer debt" bookkeeping
for whoever needs to close the gap later (install/authorize more reviewer-capable CLIs, then run another cycle).

### 4.2 The evidence gate: three-tier priority

`src/review/evidence.ts`'s `laneOutcome` decides one lane's attempt outcome, in this fixed priority order — a lower
tier is never even consulted once a higher tier has already decided:

1. **Supervisor-attested fact.** If the lane's own process was killed by the supervisor for `TIMEOUT` (wall clock,
   `REVIEW_MAX_LANE_SECONDS = 3600`s) or `STALLED` (no stdout/stderr activity for `REVIEW_STALL_SECONDS = 600`s), that
   fact wins outright and the lane is `INVALID` with that exact reason — no `VERDICT.json` I/O happens at all.
2. **`VERDICT.json` structure and freshness.** In order: the file must exist (`MISSING` if not); it must parse as
   JSON (`CORRUPT` if not, and any non-missing reader failure conservatively maps to `CORRUPT` too — there is no
   silent read-error escape hatch); it must satisfy `reviewVerdictSchema` (`SCHEMA_MISMATCH` if not); its `run_token`
   must equal the value this lane's brief injected (`TOKEN_MISMATCH` if not); its `round` must equal the cycle's
   current round (`ROUND_MISMATCH` if not). Any failure here is `INVALID` and skips tier 3 entirely.
3. **Read-only workspace fingerprint.** Only once tier 2 has produced a structurally valid verdict: the target
   checkout's workspace fingerprint (`HEAD`, `git status --porcelain`, the tracked diff, and untracked-file hashes) is
   compared before/after the lane ran. Any difference — even for an otherwise-valid `pass` or `fail` — invalidates
   the lane as `INVALID(REVIEWER_WROTE_REPO)` and raises a cycle-level warning that becomes arbitration material. A
   review lane is contractually read-only; this is the mechanical enforcement of that contract, not merely the
   brief's own "only warn" instruction to the reviewer CLI.

Only a lane that clears all three tiers becomes `PASS` or `FAIL` (from `VERDICT.json`'s own `verdict` field). Every
other outcome is `INVALID`, `RATE_LIMITED`, or `INFRA_ERROR` — see [§4.3](#43-the-invalid-lane-ladder).

### 4.3 The invalid-lane ladder

`src/review/supervisor.ts`'s `executeLane`/`candidatesForLane` drive one lane's attempts:

- **Same-candidate retry, once.** A candidate is retried until it has accumulated two `INVALID`/`INFRA_ERROR`
  attempts (two total attempts, one retry); on the second such failure it is abandoned for this round.
  `REVIEWER_WROTE_REPO` is a special case: it is **never retried at all** — the lane concludes `INVALID` on the very
  attempt it is detected, since the workspace is already known to have been mutated once and a retry against the
  same (now-dirty) checkout would not produce trustworthy evidence.
- **Required-lane-only substitute ladder.** Only a **required** route has a backup candidate list at all —
  every currently-*advisory* route in the cycle's frozen `lane_snapshot`, tried in snapshot order, once its own
  primary candidate is exhausted. An advisory lane has no backup: if its own candidate's ladder is exhausted, that
  advisory lane simply concludes `INVALID` (or whatever its last attempt's outcome was) and the round proceeds
  without it, unaffected — advisory lanes never block. A substitute lane's brief carries an explicit
  "对方缺席从严" (the original candidate is absent; review from a stricter, non-authoring-adjacent posture) notice.
- **`RATE_LIMITED` never counts against the retry budget** and never retries the same candidate — it immediately
  tries the next un-rate-limited-this-pass candidate. If a **required** route's last standing attempt this pass is
  `RATE_LIMITED` with no further candidate to try, the lane is reset to `PENDING` (not concluded) and the round
  emits `COOLDOWN_STARTED` (§5) instead of any lane conclusion — the cycle waits, it does not fail the round on a
  rate limit. An **advisory** route in the identical situation is simply concluded `RATE_LIMITED` (an outcome value
  distinct from `INVALID`) and the round proceeds; advisory rate limits never trigger `WAITING_COOLDOWN`.
- **Backups exhausted.** If a required route's candidate ladder (primary + every advisory backup) is fully exhausted
  with no `PASS`/`FAIL`/cooldown, the lane concludes `INVALID(BACKUPS_EXHAUSTED)`.
- **Aggregation is fail-closed by construction, not by convention.** `aggregateRequiredLaneResults`
  (`src/review/types.ts`) treats *any* required lane whose outcome is `INVALID`/`RATE_LIMITED`/`INFRA_ERROR` as an
  aggregate `UNAVAILABLE` — and `roundConclusionTarget` (`src/review/machine.ts`) routes `UNAVAILABLE` straight to
  `ARBITRATION` unconditionally, at *any* round number, never `AWAITING_ACCEPT`. There is no code path that can
  round a required lane's missing/invalid evidence up to a `PASS`.

## 5. State machine

Nine states, two terminal: `PENDING`, `REVIEWING`, `WAITING_COOLDOWN`, `BLOCKED`, `FIXING`, `AWAITING_ACCEPT`,
`ARBITRATION`, `ACCEPTED` [terminal], `ABANDONED` [terminal] (`src/review/types.ts`'s `REVIEW_CYCLE_STATUSES`).
Twelve journal event types drive it — nine that actually move state, three that are audit-only self-loops
(`LANE_CONCLUDED`, `BLOCKER_WAIVED`, `LOCK_TAKEN_OVER`) that `foldJournal` always folds without changing state.
`src/review/machine.ts` deliberately does **not** share dispatch's own `transitionTable`/edge type: it is an
independently defined graph (same table-driven `fold` convention, distinct edge set).

### 5.1 Transition table (authoritative — mirrors `src/review/machine.ts`'s `transitionTable` edge for edge)

| Journal event | Allowed `from -> to` |
| --- | --- |
| `CYCLE_CREATED` | *(none) `-> PENDING`* — valid only as the journal's literal first event; enforced by `foldJournal` itself, not by `transitionTable` (this event has no entry there at all). |
| `ROUND_STARTED` | `PENDING -> REVIEWING`; `FIXING -> REVIEWING` (a dispatched fix reached `DELIVERED`, automatic incremental round); `ARBITRATION -> REVIEWING` (a human's `arbitrate --decision extend`, `max_rounds` +1). |
| `LANE_CONCLUDED` | `REVIEWING -> REVIEWING` (audit only — one lane finished; the round itself has not concluded). |
| `COOLDOWN_STARTED` | `REVIEWING -> WAITING_COOLDOWN`. |
| `CYCLE_RESUMED` | `WAITING_COOLDOWN -> REVIEWING`. |
| `ROUND_CONCLUDED` | `REVIEWING -> AWAITING_ACCEPT` (verdict `PASS`); `REVIEWING -> BLOCKED` (verdict `FAIL`, round below the cycle's *effective* `max_rounds`); `REVIEWING -> ARBITRATION` (verdict `FAIL` at or beyond the effective `max_rounds`, **or** verdict `UNAVAILABLE` at any round — a required lane could not establish evidence, §4.3). |
| `BLOCKER_WAIVED` | `BLOCKED -> BLOCKED` (audit only — records an operator waiver + reason; the state itself does not change until a `fix`/`accept`/`arbitrate` command is issued). |
| `FIX_DISPATCHED` | `BLOCKED -> FIXING`; `AWAITING_ACCEPT -> FIXING` (a human adopted an advisory finding into a fix via `--adopt` with no open blocker to waive). |
| `FIX_FAILED` | `FIXING -> BLOCKED` (the dispatched fix `WorkOrder` did not reach `DELIVERED`). |
| `CYCLE_ACCEPTED` | `AWAITING_ACCEPT -> ACCEPTED`; `ARBITRATION -> ACCEPTED`. |
| `CYCLE_CANCELLED` | `REVIEWING -> ABANDONED`; `WAITING_COOLDOWN -> ABANDONED`; `BLOCKED -> ABANDONED`; `FIXING -> ABANDONED`; `AWAITING_ACCEPT -> ABANDONED`; `ARBITRATION -> ABANDONED`. There is deliberately **no** `PENDING -> ABANDONED` edge (§7.4). |
| `LOCK_TAKEN_OVER` | Every one of the nine states `-> itself` (audit only — a new supervisor process took over a dead one's `supervisor.lock`; never changes cycle state). |

`ROUND_STARTED`'s `ARBITRATION -> REVIEWING` edge additionally carries `previous_max_rounds`/`max_rounds`/
`extension_reason`; the journal schema's own `superRefine` (and, identically, `effectiveMaxRounds`'s replay check)
rejects any extension where `max_rounds` is not *exactly* `previous_max_rounds + 1` — extension is always exactly one
round at a time, never a batch grant, and every prior extension is folded to derive the cycle's current effective
limit rather than trusting `cycle.yaml`'s frozen `max_rounds` alone.

### 5.2 Migration diagram

```
PENDING ──ROUND_STARTED──> REVIEWING
                              │  ^
                              │  │ CYCLE_RESUMED
                              │  │
                              ├──┴──COOLDOWN_STARTED──> WAITING_COOLDOWN
                              │
                              ├──ROUND_CONCLUDED (verdict=PASS)───────────────────> AWAITING_ACCEPT
                              │
                              ├──ROUND_CONCLUDED (verdict=FAIL, round<eff.max)────> BLOCKED
                              │
                              └──ROUND_CONCLUDED (verdict=FAIL@max | UNAVAILABLE)─> ARBITRATION

BLOCKED ─────────FIX_DISPATCHED──────────────> FIXING
AWAITING_ACCEPT ─FIX_DISPATCHED (--adopt)─────> FIXING
FIXING ──ROUND_STARTED (fix WorkOrder DELIVERED, automatic incremental round)────> REVIEWING
FIXING ──FIX_FAILED (fix WorkOrder did not deliver)──────────────────────────────> BLOCKED

AWAITING_ACCEPT ──CYCLE_ACCEPTED (review accept)─────────────────────> ACCEPTED           [terminal]
ARBITRATION ──────CYCLE_ACCEPTED (arbitrate --decision accept)───────> ACCEPTED           [terminal]
ARBITRATION ──────ROUND_STARTED (arbitrate --decision extend, +1)────> REVIEWING

{REVIEWING, WAITING_COOLDOWN, BLOCKED, FIXING, AWAITING_ACCEPT, ARBITRATION}
    ────CYCLE_CANCELLED (review cancel / arbitrate --decision abandon)──> ABANDONED       [terminal]

Audit-only self-loops (journalled, state never moves): LANE_CONCLUDED within REVIEWING;
BLOCKER_WAIVED within BLOCKED; LOCK_TAKEN_OVER from/to any of the nine states.
```

## 6. Rounds and the human's position

### 6.1 `AWAITING_ACCEPT`: every required lane passed

`review status <cycle-id> --report` recomputes and prints the latest round's material: every required/advisory
lane's raw `VERDICT.json`, an advisory-`FAIL` notice (printed but never blocking), any deduplicated blockers still on
record (only relevant on an incremental round that reached `AWAITING_ACCEPT` after a fix — a fresh round-1 `PASS`
round has none), and a subject-fingerprint check against the target repo's *current* `HEAD`. A human then runs
`review accept [--note <text>]`, which journals `CYCLE_ACCEPTED` and appends a terminal `review-ledger.jsonl` line.

### 6.2 `BLOCKED`: at least one required lane found a blocker

`src/review/aggregate.ts`'s `aggregateBlockers` collapses every required *and* advisory lane's blockers, matched
exactly on `(file, line, title)`, into one deterministic list: a blocker independently reported by more than one lane
carries every reporting lane in its `endorsements` and sorts first (the "cross-lane agreement is the highest-
confidence signal" rule) — same input, any lane order, always the same output, with stable minted ids
(`B-r<round>-L<lane>-<seq>`, the lowest-numbered reporting lane's number).

The human's decision collapses to one command: `review fix <cycle-id> [--waive <id>=<reason>]... [--adopt
<advisory-id>]... [--yes]`.

- Every `--waive <id>=<reason>` records a `BLOCKER_WAIVED` audit event (operator + non-empty reason, required) and
  excludes that blocker from the fix brief.
- Every blocker **not** waived, and endorsed by at least one *required* lane, is included in the fix brief
  automatically. A blocker that only an advisory lane reported is **not** included unless explicitly named by
  `--adopt <advisory-id>` — advisory findings never silently escalate into a mandatory fix.
- `fix` then, front-of-terminal, in one command: dispatches an ad-hoc fix `WorkOrder` back to the **original**
  authoring candidate on the **original** branch (the completed dispatch run's own candidate/branch for a
  dispatch-order subject; a `--diff` subject requires an injected `resolveFixAuthorContext` — the default
  implementation only knows how to resolve a dispatch-order subject's author, so `review fix` on a bare `--diff`
  cycle fails with `FIX_CONTEXT_REQUIRED` unless a caller supplies one), supervises it to `DELIVERED`, and then
  automatically starts the next incremental round — printing a phase banner (`=== phase 1 complete... ===` /
  `=== phase 2: incremental review round N ===`) exactly as each phase actually begins.
- If the fix `WorkOrder` does not reach `DELIVERED` (any other terminal dispatch state), `FIX_FAILED` returns the
  cycle straight back to `BLOCKED` with the same fix-order id preserved — the cycle does not silently retry the fix
  or lose track of what was attempted.

### 6.3 `AWAITING_ACCEPT` with an advisory finding worth adopting

`fix` also applies at `AWAITING_ACCEPT`, but only in `--adopt`-only mode: `--waive` is rejected outright there
("AWAITING_ACCEPT advisory fixes cannot waive blockers") since there is nothing `BLOCKED` to waive — a human who
wants to promote an advisory-lane finding into a mandatory fix runs `review fix <cycle-id> --adopt <advisory-id>`,
which dispatches the same fix flow as §6.2 for that one adopted finding.

### 6.4 `ARBITRATION`: round limit reached, or a required lane could not be formed

`review arbitrate <cycle-id> --decision accept|abandon|extend --reason "..."` is the only way out of `ARBITRATION` —
three CLI-parameter-driven branches, deliberately not an interactive/decision-file flow (`T-20260721-02` design's
own adjudicated undecided item 2):

- `--decision accept`: journals `CYCLE_ACCEPTED` (`from: ARBITRATION`), appends a `review-ledger.jsonl` line, exits
  `0`.
- `--decision abandon`: journals `CYCLE_CANCELLED` (`from: ARBITRATION`), appends a `review-ledger.jsonl` line, exits
  `3` (a completed-cancellation report-and-stop outcome, same as `cancel`'s own successful-cancellation exit).
- `--decision extend`: journals `ROUND_STARTED` (`from: ARBITRATION`, `max_rounds` exactly `+1`, `extension_reason`
  = `--reason`), then immediately, front-of-terminal, drives that freshly-extended round to its own next report
  state — same call convention `start`/`resume` use. Every `extend` grants exactly one additional round; there is
  no way to grant more than one round in a single `arbitrate` invocation. Extend rounds are full re-review rounds.

### 6.5 `NEW_IN_INCREMENTAL` and the range-lock honesty boundary

An incremental round's brief (`src/render/reviewBrief.ts`'s `renderIncrementalReviewBrief`) carries the previous
round's still-open (non-waived) blockers and an explicit scope-lock instruction: judge only (a) is each listed id
actually fixed, and (b) did the fix introduce something new — do not reopen anything that already passed.

`src/review/aggregate.ts`'s `resolveRefs` is where that instruction's machine-side enforcement lives, and it is
**deliberately weaker than a hard block**, by design: a newly reported blocker with no `ref` (or a `ref` that does not
resolve to a real id from the previous round — a "dangling" ref) is **still recorded as a normal blocker** — it is
never silently dropped — but flagged `newInIncremental: true` and sorted first in `review status --report`'s blocker
list (a dangling `ref` additionally raises a `DANGLING_BLOCKER_REF` warning attached to the round, not a hard fault).
Zero-model invariant in practice: **the machine only marks, it never adjudicates** whether a `NEW_IN_INCREMENTAL`
finding is legitimate new-regression evidence or an out-of-scope reviewer reopening an already-passed area — that
judgment call is left entirely to the human at the next `review fix`/`review arbitrate` decision point. The worst
case this produces is more rounds reaching `ARBITRATION` than strictly necessary, never a false `PASS` — the failure
mode is direction-safe.

## 7. Recovery playbook

### 7.1 `review resume` is the one recovery verb

There is no daemon: every subcommand runs the whole relevant supervision step in the foreground until a terminal/
report state. `review resume <cycle-id>` is the general recovery entry point, and it behaves differently per state:
`PENDING` re-enters exactly as `start` would (in case a crash happened before the cycle's very first round was ever
supervised at all); `WAITING_COOLDOWN` re-emits `CYCLE_RESUMED` and re-enters the round's still-pending lanes;
`REVIEWING` re-enters the same round — an orphaned lane whose last stored attempt is still `RUNNING` is
re-adjudicated purely from durable evidence (`recoverRunningAttempt`'s read-only re-check: a `PASS`/`FAIL`/
`REVIEWER_WROTE_REPO`-`INVALID` resolves immediately with **no new process spawned**; anything else falls through to
`ORPHANED_NO_VALID_VERDICT` and re-enters the normal §4.3 retry ladder); `FIXING` transparently delegates to
`superviseWorkOrder` — the fix `WorkOrder`'s own crash-resume machinery from `docs/DISPATCH.md` §5.1/§5.2 runs
underneath this one `review resume` call, unmodified.

### 7.2 Two-verb asymmetry: `start`/`superviseReviewCycle` do not self-heal a stalled promote

**This is load-bearing and easy to get backwards.** `superviseReviewCycle` (what `review start` calls for a brand-new
`PENDING` cycle) does **not** itself repair a round whose `ROUND_CONCLUDED` journal event is already durable but
whose round directory is still staged under `rounds/.tmp-R<n>-supervisor/` — i.e. a crash landed exactly between
journalling the round's conclusion and the atomic rename that publishes it to `rounds/R<n>/`. Re-running a command
that internally calls `superviseReviewCycle` against an already-non-`PENDING` cycle in this state does **not**
self-heal it; it just reads the still-staged round directory as-is and reports the cycle's current state without
repairing the on-disk layout underneath it.

Only `resumeReviewCycle` — called by `review resume` directly, and transitively by `review fix`/
`review arbitrate --decision extend` once their own journal work is done, both of which drive the resulting round
through the exact same dispatcher `resume` uses — runs `promoteJournalConcludedRound`: it cross-checks the staged
`summary.json`/`aggregate.json` against the durable `ROUND_CONCLUDED` event and idempotently renames the staged
directory into its final place before reporting the cycle's state.

Operationally: after any interruption, **always run `gatekeeper review resume <cycle-id>`, never re-run
`gatekeeper review start`**, against an existing cycle. `src/commands/review.ts`'s own `driveCycle` helper already
encodes exactly this rule — `PENDING` cycles use `superviseReviewCycle`, every other state uses `resumeReviewCycle` —
so every CLI entry point except the very first `review start` call on a brand-new cycle gets this compensation
automatically. It is only a hazard for code driving `src/review/supervisor.ts` directly rather than through
`src/commands/review.ts`.

### 7.3 Cooldown resume

`review resume <cycle-id>` on a `WAITING_COOLDOWN` cycle reissues `CYCLE_RESUMED` and re-enters the round
immediately. Unlike dispatch's own cooldown resume (`docs/DISPATCH.md` §5.3, which has a `--force` flag and a
15-minute foreground-sleep-vs-exit threshold), review has neither: every `WAITING_COOLDOWN` resume is an explicit,
human-issued command with no foreground wait logic of its own — the rate-limited lane's own resume-after timestamp
is available via `review status`/the journal's `COOLDOWN_STARTED` event, but review itself never auto-sleeps.

### 7.4 `PENDING` cancel

`gatekeeper review cancel` on a still-`PENDING` (never started) cycle exits `2`: the state machine has no
`PENDING -> ABANDONED` edge (§5.1), by design — a never-started cycle is discarded by deleting its cycle directory
under `<configDir>/review/cycles/<cycle-id>/` by hand, not by a journalled cancellation. Run
`gatekeeper review start` first, or delete the directory if it must be discarded before starting.

## 8. Gate integration and the anti-forgery boundary

`gatekeeper review render --format comment <cycle-id>` prints — to stdout only, it **never publishes anything
itself** — a self-contained Markdown summary of the cycle's current state (round history, latest lane verdicts,
waived blockers), marked with its own version-independent sticky-comment marker, `<!-- gatekeeper:review-verdict:v1
-->`. This is **deliberately distinct** from `src/render/comment.ts`'s gate sticky marker, `<!-- gatekeeper:verdict
-->` — a version-2 `T-20260721-02` design §7 standard-face guardrail, tested with an explicit collision assertion so
a `review render` comment and a `gate`-verdict comment can coexist on the same PR thread without one clobbering the
other.

**Honest anti-forgery boundary:** the local `.gatekeeper/review-ledger.jsonl` line and the on-disk review-cycle store
under `<configDir>/review/cycles/` are both host-machine-local, and by themselves are exactly as trustworthy as any
other file an attacker with local write access could fabricate — **neither is itself gate evidence**, and neither
ever will be by being read directly. The only trusted path for a review outcome to become gate evidence is for a
human or CI process holding a real GitHub token to actually **publish** `review render`'s output as a PR comment or
check-run through that trusted identity — the same publisher-identity trust anchor `gatekeeper gate`'s own sticky-
comment update already relies on. `review render`'s body shape is deliberately compatible with a `policy.yaml`
`review`/`comment-scan` lane's `body_matches` primitive (`src/engine/schema.ts`), so this can, in principle, close a
self-referential loop and let one repo's review cycle satisfy another contract's evidence lane — but no automatic
publisher (`review publish`) or `lanes.d` preset for it ships yet; both are deferred until the "publish through a
trusted channel" step itself has a real caller (see [§9](#9-known-limitations)). Feeding a local `review-ledger.jsonl`
line or the raw cycle store directly to `gate` is not supported and would be rejected on principle even if
mechanically possible — the forgeable surface it would open cannot be closed by anything review itself controls.

## 9. Known limitations

Honest, current-state list — none of these are silently hidden gaps, and each is a recorded decision or a recorded
debt, not an oversight:

- **Bare reviewer-CLI JSON output has not been machine-verified end to end against real vendor CLIs.** The evidence
  gate (§4.2) is exercised in tests against scripted/fake reviewer processes, not yet against three real vendor CLIs
  each genuinely writing a clean `VERDICT.json` with zero conversational wrapper text around it (package C's own
  recorded risk 1 at design time). A vendor CLI that cannot be coaxed into clean JSON output degrades that vendor to
  an advisory-only lane and is recorded as debt, never silently masked as a passing required lane.
- **`review status --report`'s live-recomputed material can drift from the persisted round aggregate.** `--report`
  re-reads each lane's on-disk `VERDICT.json` and a fresh `git rev-parse HEAD` at the moment it is invoked, while
  `rounds/R<n>/aggregate.json` was computed once, durably, at the round's actual conclusion time. If a `VERDICT.json`
  file is edited after the fact, or the target repo's `HEAD` moves between rounds, the two can disagree. This is a
  read-only display-layer risk only — the persisted `ROUND_CONCLUDED` verdict and the journal itself are never
  recomputed or overwritten by `--report`.
- **`review cancel` does not clean up an orphaned reviewer/fix subprocess.** While a live supervision process still
  holds a cycle's `supervisor.lock`, `cancel`'s own lock acquisition simply fails and is reported as an
  infrastructure fault (exit `3`) rather than racing or signaling the live process — there is no orphan-process
  reconciliation path analogous to dispatch's `resume --wait`/`--kill`/`--confirm-dead` (`docs/DISPATCH.md` §5.2).
- **Two simultaneous required-lane rate limits in one pass record only one `COOLDOWN_STARTED` event.** This is an
  observability gap, not a correctness gap: the round still correctly transitions to `WAITING_COOLDOWN` and both
  lanes still resume normally, but only the first one to trip the cooldown path is individually journalled.
- **Grok review debt is currently outstanding on two of review's own packages.** Both the C (lane supervisor) and E
  (CLI) packages shipped their external double-review with `grok` logged out (`GROK_UNAVAILABLE`); an adversarial
  `claude(opus)` substitute stood in as the second reviewer both times, per `CLAUDE.md`'s degradation rule. A `grok`
  increment review against both packages is still owed once the channel recovers — see the `T-20260721-07` and
  `T-20260721-08` records for the exact degradation notes.
- **Inherited from `src/agent/runner.ts`**: review's lane spawning reuses the same process-group kill/probe/pgid
  plumbing dispatch already documents as POSIX-specific (`docs/DISPATCH.md` §6) — Windows process-group control
  degrades the same way there too. This is not a review-specific new gap.
