# AGENTS.md

Instructions for **any** coding agent (Codex, Copilot, Cursor, pi, Claude, human) working in this repository. `CLAUDE.md` is the authoritative rulebook; this file is the vendor-neutral entry point. If your harness auto-loads only this file, read `CLAUDE.md` before writing code.

## What this repo is

Gatekeeper: a contract registry standard + deterministic diff verdict engine + PR gate + ledger. TypeScript / Node 20 / vitest / biome. The authoritative execution plan is `docs/PLAN.md` (in-repo). Milestone/task history: `tasks/LEDGER.md`.

## Hard invariants (violations are top-priority blockers)

1. **Pure-engine zone**: `src/engine/` must stay free of I/O, network, env vars, randomness, and clock access.
2. **Zero model calls in product code**: nothing under `src/` may depend on any LLM/model API. LLM work is delegated to pi-subagents roles defined in `pi-extension/agents/`.
3. **Public standard surface** — treat any change as breaking-review-required and do not modify without an explicit task mandate: contract/policy schema (`src/engine/schema.ts`, `docs/SPEC.md` normative text), verdict JSON shape, sticky-comment ledger block format, `action.yml` inputs.
4. **Fail-direction law**: verdict defects fail **closed** (block); infrastructure faults fail **open** (exit 0 + loud warning). Reversing a direction is the highest-severity bug class.
5. **Fork-PR safety**: gate/check flows never check out or execute PR head code.

## Process rules (apply to every agent, every vendor)

- **No self-review, no skipped review**: every coding delivery goes through the multi-lane review loop (see `CLAUDE.md` dispatch table). Do not merge/commit your own work as "done" without it.
- **Ledger discipline**: tasks entering the loop are registered in `tasks/LEDGER.md` at dispatch and closed with a record under `tasks/records/`. Lessons go to `tasks/LESSONS.md`.
- **Do not commit or push** unless the task explicitly authorizes it; never use bare `git add -A` (always pathspec both add and commit).
- **Text integrity**: after writing files with unusual byte content (template literals, escapes), verify no control bytes (`file <path>`; byte-scan) — a known tooling defect has injected NULs four times (see LESSONS).
- Self-report risks in your delivery report; reviewers are instructed to verify each self-reported risk.

## Verification

```bash
cd <repo-root> && npm run typecheck && npm test && npx biome check src tests
```

Machine-checkable governance rules are enforced by `npm run check:governance` (ledger/record/round consistency). Run it before declaring any task closed.
