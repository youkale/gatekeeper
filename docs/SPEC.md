# Gatekeeper Contract Registry Specification

Status: v1

Gatekeeper Registry v1 is an open, agent-neutral format for declaring which repositories and paths form a shared contract, which review evidence a change requires, and which generated mirrors may be edited only by designated actors.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, and **MAY** in this document are to be interpreted as normative requirements. The schemas in `src/engine/schema.ts`, together with the matching and verdict behavior in `src/engine/match.ts` and `src/engine/verdict.ts`, are the source of truth when this document and an implementation disagree.

## 1. Version and registry layout

Every contract and policy document MUST set:

```text
apiVersion: gatekeeper/v1
```

A registry directory has one policy and zero or more contract files:

```text
registry/
├── policy.yaml
└── contracts/
    ├── artifact-manifest.yaml
    └── public-api.yml
```

- There MUST be exactly one file named `policy.yaml` at the registry root.
- Each direct `contracts/*.yaml` or `contracts/*.yml` file contains exactly one contract object. Nested directories are not read.
- Contract files are read in filename order. Contract names MUST be unique across the registry.
- YAML duplicate keys and invalid YAML are rejected.
- A contract's `level` MUST name a key under `policy.yaml`'s `levels` map.

### 1.1 Packaged `lanes.d` presets

Gatekeeper ships reusable lane definitions as direct `*.yaml` or `*.yml` files in its package-level `lanes.d` directory. A preset filename without its extension becomes the lane name; for example, `lanes.d/human.yaml` defines the `human` lane. Preset names MUST match `^[a-z0-9][a-z0-9-]*$`.

Commands that load lane presets merge them into `policy.yaml` before registry validation:

1. All valid packaged presets are loaded in filename order.
2. If `policy.lanes` is absent, the preset map becomes `policy.lanes`.
3. If the user defines a lane with the same name as a preset, the complete user definition wins. Definitions are not deep-merged.
4. A user-wins collision is reported as a warning.

`validate`, `check`, `gate`, `doctor`, and `triage` use this merge path. The registry format remains self-contained when every referenced lane is declared directly in `policy.yaml`.

## 2. Contract documents

The following example exercises every v1 contract field:

```yaml
apiVersion: gatekeeper/v1
name: artifact-manifest
description: Shared artifact manifest produced by release jobs and consumed by deployment.
level: breaking-review-required
x-owner: release-engineering
authority:
  repo: org/schemas
  paths:
    - artifact/manifest.schema.json
  exclude:
    - artifact/fixtures/**
  if_content: 'schemaVersion|artifacts'
  x-format: json-schema
consumers:
  - repo: org/deploy
    paths:
      - deploy/readers/**
    exclude:
      - deploy/readers/fixtures/**
    verify: bin/validate
    role: consumer
    if_content: 'manifest|artifacts'
  - repo: org/release
    paths:
      - release/manifests/**
    verify: npm run release:check
    role: producer
  - repo: org/mirror
    paths:
      - generated/manifests/**
    role: mirror-frozen
    allow_actors:
      - manifest-sync[bot]
    x-sync-job: manifest-sync
```

### 2.1 Top-level fields

| Field | Requirement | Meaning |
| --- | --- | --- |
| `apiVersion` | REQUIRED literal string | MUST be `gatekeeper/v1`. |
| `name` | REQUIRED string | MUST match `^[a-z0-9][a-z0-9-]*$` and be unique in the registry. |
| `description` | Optional string | Human-readable purpose of the contract. It does not affect matching. |
| `level` | REQUIRED string | Foreign key into `policy.levels`. |
| `authority` | REQUIRED object | The authoritative repository/path binding. |
| `consumers` | Optional array, default `[]` | Downstream consumer, producer, or frozen-mirror bindings. |

### 2.2 `authority`

| Field | Requirement | Meaning |
| --- | --- | --- |
| `repo` | REQUIRED string | Repository identity. It is compared with the evaluated repository by exact, case-sensitive string equality. |
| `paths` | REQUIRED non-empty string array | Include globs, evaluated with picomatch and `dot: true`. |
| `exclude` | Optional string array | Exclusion globs. An exclusion wins over an inclusion for the same candidate path. |
| `if_content` | Optional string | JavaScript regular expression tested against changed patch lines after the path matches. |

The authority binding has no `role`, `verify`, or `allow_actors` field.

### 2.3 `consumers`

Every consumer entry supports the same `repo`, `paths`, `exclude`, and `if_content` fields as `authority`, plus:

| Field | Requirement | Meaning |
| --- | --- | --- |
| `verify` | Optional string | Verification guidance surfaced in verdicts and comments. Gatekeeper v1 does not execute it. |
| `role` | Optional enum, default `consumer` | One of `consumer`, `producer`, or `mirror-frozen`. |
| `allow_actors` | Optional string array | Exact, case-sensitive actor allowlist used only by `mirror-frozen`. On another role it has no effect and produces a registry warning. |

The three role values are structural metadata:

- `consumer` identifies code that consumes the authority.
- `producer` identifies code that emits data in the authority's format. In v1 it has the same matching and enforcement behavior as `consumer`; its distinction is preserved in provenance and consumer summaries.
- `mirror-frozen` identifies a generated or synchronized copy. A matching edit is forbidden unless the actor is present and exactly equals an `allow_actors` entry. A missing actor is not allowed.

Multiple bindings for the same repository are evaluated independently. A repository may match the authority and one or more consumer bindings for the same contract.

## 3. Match semantics

### 3.1 Repository and path matching

For each binding whose `repo` exactly equals the evaluated repository:

1. Gatekeeper considers the changed file's current `path`, followed by its `oldPath` when present.
2. A candidate path matches when the first `paths` glob matches and no `exclude` glob matches that candidate.
3. All globs use picomatch with `dot: true`; dot-directories such as `.github` are therefore matchable.
4. The first successful candidate and first successful include glob are recorded as `matchedPath` and `matchedGlob`.
5. Duplicate changed-file entries are deduplicated by current `path` within a binding.

For a rename or copy, the new path is tried first and the old path second. Moving a protected file out of an include glob therefore still matches through `oldPath`. The verdict retains the new `path`, the `R` or `C` status, and the old path as `matchedPath` when that is what matched.

A deletion uses the deleted path with status `D` and matches normally. If `if_content` is configured and a deletion patch is available, removed lines beginning with `-` are eligible content lines.

### 3.2 `if_content`

`if_content` is compiled as a JavaScript `RegExp` without implicit flags. An invalid expression makes the registry invalid.

After a path match:

- Without `if_content`, `contentCheck` is `not-configured` and the file matches.
- If the patch is absent, `contentCheck` is `skipped-no-patch` and the file matches. This is the required fail-open behavior for binary, oversized, or provider-omitted patches.
- If the patch is present and a tested line matches, `contentCheck` is `matched` and the file matches.
- If the patch is present but no tested line matches, `contentCheck` is `no-match` and that file does not make the binding a hit.

Patch scanning uses these exact rules:

1. Lines are split on LF or CRLF.
2. A `diff --git ` line resets hunk state.
3. A line beginning with `@@` enters hunk state.
4. File header lines beginning with `+++ ` or `--- ` outside a hunk are skipped.
5. Every other line beginning with `+` or `-` is tested as a whole string, including its leading prefix.

If at least one file makes a binding a hit, the binding's `files` provenance contains every path-and-content-evaluated file for that binding. It may therefore include `no-match` entries alongside entries that matched. A binding containing only `no-match` entries is not emitted as a hit.

> [!WARNING]
> **`if_content` line-start anchoring:** An `if_content` regex SHOULD NOT anchor to the unprefixed content with `^`. The engine does not reject `^` at the schema level, but patch lines carry their leading `+` or `-` prefix, so a pattern like `^image-tag` silently misses every match (write `^\+\s*image-tag` if you genuinely mean the prefixed line).

### 3.3 Frozen mirrors and enforcement downgrade

When a `mirror-frozen` consumer binding matches and the actor is absent or is not exactly present in `allow_actors`, Gatekeeper emits a `ForbiddenEdit`.

`adoption.enforcement_override: warn` MUST NOT downgrade a forbidden edit. Any non-empty `forbiddenEdits` array makes the engine verdict `block`, even when every touched contract has effective enforcement `warn`.

This rule concerns the adoption downgrade. The separate PR-level operator label configured by `overrides.label` can override a gate outcome, and that action is recorded in the gate ledger.

## 4. Policy document

```yaml
# Note: naming a lane "human" overrides the packaged lanes.d/human.yaml preset
# (user-wins). validate emits a collision warning, which --strict turns into a
# non-zero exit; pick a distinct name if that is not what you want.
apiVersion: gatekeeper/v1
lanes:
  human:
    type: human-approval
    min: 1
    fresh: true
  reviewer-bot:
    type: review
    author: 'coderabbitai[bot]'
    pass:
      state: APPROVED
  build:
    type: check-run
    selector: check-run
    name: build-*
    pass:
      - success
  security-comment:
    type: comment-scan
    author: 'security-reviewer[bot]'
    body_matches:
      pattern: 'no actionable findings'
      ignore_case: true
levels:
  breaking-review-required:
    enforcement: block
    require:
      m: 2
      lanes:
        - human
        - reviewer-bot
        - build
  notify-only:
    enforcement: warn
    require: {}
adoption:
  enforcement_override: warn
overrides:
  label: gatekeeper:override
```

### 4.1 `lanes`: four primitives

`lanes` is a REQUIRED string-keyed map. Each value MUST be one of these four shapes.

#### `human-approval`

| Field | Requirement | Meaning |
| --- | --- | --- |
| `type` | REQUIRED | Literal `human-approval`. |
| `min` | REQUIRED positive integer | Minimum number of current human approvals. |
| `fresh` | REQUIRED boolean | When true, approvals count only when their `commit_id` equals the PR head SHA. |

The latest decision for each non-bot login is used. Any latest `CHANGES_REQUESTED` decision fails the lane; `fresh` filters approvals, not changes-requested decisions. A dismissed latest decision does not count.

#### `review`

| Field | Requirement | Meaning |
| --- | --- | --- |
| `type` | REQUIRED | Literal `review`. |
| `author` | REQUIRED string | Exact login or picomatch glob selecting review authors. |
| `pass.state` | REQUIRED enum | One of `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, or `PENDING`. |
| `pass.body_matches` | Optional string or regex object | Required JavaScript-regex match against the latest selected review body. A regex object has `pattern` and optional `ignore_case`. |
| `pass.ignore_case` | Optional boolean | Case-insensitive fallback for `body_matches`; a nested regex object's `ignore_case` takes precedence. |

The latest matching review is authoritative. No review is `pending`; a state or body mismatch is `fail`; both matching is `pass`.

#### `check-run`

| Field | Requirement | Meaning |
| --- | --- | --- |
| `type` | REQUIRED | Literal `check-run`. |
| `selector` | Optional enum, default `check-run` | Select GitHub check runs or legacy commit `status` contexts. |
| `name` | REQUIRED string | Exact name/context or picomatch glob. |
| `pass` | Optional non-empty string array, default `["success"]` | Accepted conclusion/state values, compared case-insensitively. |

Only the latest item per check-run name or status context is evaluated. Any terminal failure (`failure`, `timed_out`, `cancelled`, `action_required`, or `error`) fails the lane; otherwise an unaccepted value is pending. Across multiple matching items, fail wins over pending, and pending wins over pass.

> [!IMPORTANT]
> **Operations note — non-terminal conclusions:** Check-run conclusion values `neutral`, `skipped`, and `stale` are treated as pending unless explicitly included in the lane's `pass` array. A required lane can therefore remain pending and permanently block merges unless those conclusions are operationally retried, resolved, or intentionally accepted by policy.

#### `comment-scan`

| Field | Requirement | Meaning |
| --- | --- | --- |
| `type` | REQUIRED | Literal `comment-scan`. |
| `author` | REQUIRED string | Exact login or picomatch glob selecting comment authors. |
| `body_matches` | REQUIRED string or regex object | JavaScript regex required in a matching comment body. A regex object has `pattern` and optional `ignore_case`. |
| `ignore_case` | Optional boolean | Case-insensitive fallback; a nested regex object's value takes precedence. |

Any comment matching both author and body passes the lane; otherwise the lane is pending.

> [!WARNING]
> **Lane author glob and `[bot]`:** `review.author` and `comment-scan.author` accept picomatch globs. When a literal `[bot]` suffix is mixed with wildcard syntax, picomatch can interpret the brackets as a character class and match unintended logins. Exact full logins are safe because Gatekeeper checks exact equality first. For a wildcard pattern, escape the brackets, for example `'coderabbit*\[bot\]'`, and test the pattern against both intended and unintended names before deployment.

### 4.2 `levels` and M-of-N

`levels` is a REQUIRED string-keyed map. Every level contains:

| Field | Requirement | Meaning |
| --- | --- | --- |
| `enforcement` | REQUIRED enum | `block` or `warn`. |
| `require` | REQUIRED object | Either `{}` for no lane requirement, or both `m` and `lanes`. |
| `require.m` | Conditional positive integer | Required passing-lane count. MUST be no greater than the number of listed lanes. |
| `require.lanes` | Conditional non-empty string array | Unique lane names, each declared in `policy.lanes`. |

`m` and `lanes` MUST either both be present or both be absent. For one requirement, the result is:

- `pass` when at least `m` lanes pass;
- `fail` when the passing plus pending lanes can no longer reach `m`;
- `pending` otherwise.

When a PR touches multiple relevant contracts, the gate combines requirements by taking the largest `m` and the ordered union of lane names. If any touched contracts have effective `block` enforcement, only those blocking hits contribute requirements; otherwise all touched warn-only hits contribute requirements for reporting. A warn-only requirement never makes the gate block.

### 4.3 `adoption.enforcement_override`

`adoption` is optional. Its only v1 field is optional `enforcement_override`, whose only accepted value is `warn`. When present, every touched level has `effectiveEnforcement: "warn"`, while the declared `enforcement` remains visible. Forbidden frozen-mirror edits remain blocking as specified in Section 3.3.

### 4.4 `overrides.label`

`overrides` is optional and defaults to `{ label: "gatekeeper:override" }`. `label` is a string naming the GitHub PR label that makes the PR gate pass without lane evaluation. Gatekeeper records both the label and its attributable actor, when known, in the sticky-comment ledger.

## 5. Verdict JSON

The engine emits this programmable JSON surface. `gatekeeper check --json` writes it as one line; the formatted example below shows the complete shape.

```json
{
  "decision": "block",
  "repo": "org/app",
  "touched": [
    {
      "contract": "public-api",
      "level": "breaking-review-required",
      "enforcement": "block",
      "effectiveEnforcement": "block",
      "requires": {
        "m": 1,
        "lanes": ["human"]
      },
      "bindings": [
        {
          "kind": "consumer",
          "role": "consumer",
          "repo": "org/app",
          "verify": "npm test",
          "files": [
            {
              "path": "src/client.ts",
              "status": "M",
              "matchedPath": "src/client.ts",
              "matchedGlob": "src/**",
              "contentCheck": "not-configured"
            }
          ]
        }
      ],
      "consumers": [
        {
          "repo": "org/app",
          "role": "consumer",
          "verify": "npm test"
        }
      ]
    }
  ],
  "forbiddenEdits": [],
  "effectivePolicy": {
    "enforcementOverride": null
  }
}
```

### 5.1 Field contract

- `decision` is `pass`, `warn`, or `block`. Forbidden edits win; otherwise any touched effective `block` wins over `warn`; no touched contract is `pass`.
- `repo` is the evaluated repository identity.
- `touched` contains one entry per matched contract.
- `touched[].enforcement` is the declared level value; `effectiveEnforcement` includes the adoption downgrade.
- `touched[].requires` is `{m, lanes}` or `null` when `require` is empty.
- `touched[].bindings` contains independently matched authority/consumer bindings. Authority bindings have `role: null` and `verify: null`.
- `touched[].consumers` summarizes every consumer declared by the contract, including consumers that did not match the current repository or diff.
- `FileMatch.status` is one of `A`, `M`, `D`, `R`, or `C`; `contentCheck` is `not-configured`, `matched`, `no-match`, or `skipped-no-patch`.
- `forbiddenEdits` contains `{contract, repo, actor, allowActors, files}`. `actor` is `null` when unavailable.
- `effectivePolicy.enforcementOverride` is `warn` or `null`.

The engine verdict describes contract enforcement before GitHub lane evidence is applied. The PR `gate` command may turn a blocking contract hit into a passing gate after its M-of-N requirement passes, or after the configured operator override label is applied.

Infrastructure degradation is not a Verdict. In default fail-open mode, `check --json` instead emits `{"degraded":true,"reason":"..."}` and exits zero.

## 6. Ledger fenced JSON blocks

Ledger blocks are embedded in GitHub comments as fenced JSON. Payload text originating outside Gatekeeper has backticks escaped as `\u0060` so it cannot close the fence.

### 6.1 PR gate ledger

The sticky PR verdict comment uses the `gatekeeper-ledger` fence:

```json gatekeeper-ledger
{
  "schema_version": 1,
  "pr": {
    "number": 42,
    "url": "https://github.com/org/app/pull/42"
  },
  "issues": [
    {
      "number": 12,
      "url": "https://github.com/org/app/issues/12"
    }
  ],
  "verdict": {
    "decision": "block",
    "gate_state": "pending",
    "required": 2,
    "total": 3,
    "repo": "org/app",
    "touched_contracts": ["public-api"],
    "forbidden_edits": 0
  },
  "lanes": [
    {
      "lane": "human",
      "state": "pass",
      "evidence": "1 human approval(s), minimum 1",
      "text_matched": false
    }
  ],
  "override": null,
  "timestamp": "2026-07-18T12:00:00.000Z"
}
```

The enclosing comment is identified by `<!-- gatekeeper:verdict -->`. `stats` harvests this ledger variant from marker comments or from one JSON object per line in a local JSONL file. Damaged ledger entries are reported and skipped rather than aborting the entire aggregation.

### 6.2 Issue triage ledger

The triage issue comment uses the `gatekeeper-triage-ledger` fence:

```json gatekeeper-triage-ledger
{
  "schema_version": 1,
  "kind": "triage",
  "key": "org/app#12",
  "decision": "accepted",
  "reason_summary": "The requirement has a bounded contract impact and verifiable acceptance criteria.",
  "suggested_level": "breaking-review-required",
  "dispatch": {
    "coder": "openai/example-coder",
    "reviewers": [
      "openai/example-reviewer",
      "anthropic/example-reviewer"
    ]
  },
  "at": "2026-07-18T12:00:00.000Z"
}
```

The enclosing comment is identified by `<!-- gatekeeper:triage -->`. `decision` is `accepted`, `rejected`, or `needs-info`; `key` is the `org/repo#N` issue key. The same object is appended as one line to `.gatekeeper/triage-ledger.jsonl`. Acceptance criteria may appear in the human comment and input verdict file, but are not part of the triage ledger payload.

## 7. Extension points

Registry objects reject unknown fields, with one reserved extension namespace: any key beginning with `x-` is accepted and preserved. The namespace is available on contracts, authority and consumer bindings, policy objects, levels and requirements, adoption/overrides, lane definitions, review-pass objects, and regex-match objects.

An extension field MAY contain any YAML value. A v1 implementation MUST NOT change core matching, enforcement, or lane behavior merely because an unknown `x-` field is present. Non-prefixed unknown keys are invalid and receive a nearest-key diagnostic when possible.

## Appendix A. Worked examples from the fixture corpus

These are the four `realWorld: true` contract families in `fixtures/cases/`. Each contract excerpt is a complete `contracts/*.yaml` document.

### A.1 CI image tag

Fixture files: `ci-image-tag-matched.yaml` and `ci-image-tag-unrelated-line.yaml`.

```yaml
apiVersion: gatekeeper/v1
name: ci-image-tag
level: breaking-review-required
authority:
  repo: org/app
  paths:
    - .github/workflows/**
  if_content: 'image:\s+ghcr\.io/org/app:v\d+'
```

Changing `-  image: ...:v1` to `+  image: ...:v2` under `.github/workflows/release.yml` matches despite the dot-directory and produces a blocking contract hit. Changing only `timeout-minutes` has the same path match but an `if_content` no-match, so the contract is untouched and the verdict passes.

### A.2 Slink headers

Fixture file: `slink-headers-authority-and-consumer.yaml`.

```yaml
apiVersion: gatekeeper/v1
name: slink-headers
level: breaking-review-required
authority:
  repo: youkale/slink
  paths:
    - internal/protocol/**
  if_content: 'X-Slink-(Client-ID|Alias)'
consumers:
  - repo: youkale/slink
    paths:
      - cmd/**
    role: consumer
    verify: go test ./...
    if_content: 'X-Slink-(Client-ID|Alias)'
```

One pull request changes both `internal/protocol/headers.go` and `cmd/proxy/main.go`. The same repository matches an authority binding and a consumer binding, and both appear independently in the blocking verdict.

### A.3 Artifact manifest

Fixture file: `artifact-manifest-producer.yaml`.

```yaml
apiVersion: gatekeeper/v1
name: artifact-manifest
level: breaking-review-required
authority:
  repo: org/schemas
  paths:
    - artifact/manifest.schema.json
consumers:
  - repo: org/syncify
    paths:
      - release/manifests/**
    role: producer
    verify: npm run release:check
  - repo: org/hub
    paths:
      - release/manifests/**
    role: producer
    verify: make release-check
  - repo: org/slink
    paths:
      - release/manifests/**
    role: producer
    verify: go test ./...
  - repo: org/deploy
    paths:
      - deploy/readers/**
    role: consumer
    verify: bin/validate
```

Adding `release/manifests/v2.json` in `org/syncify` matches the producer binding and produces a blocking verdict. The contract hit's `consumers` summary still lists all four declared downstream bindings, which exposes the full blast radius.

### A.4 Manuals synchronization

Fixture files: `manuals-sync-allowed-actor.yaml` and `manuals-sync-human-forbidden.yaml`.

```yaml
apiVersion: gatekeeper/v1
name: manuals-sync
level: notify-only
authority:
  repo: org/manufacturer
  paths:
    - manuals/**
consumers:
  - repo: org/agent
    paths:
      - manufacturer/**
    role: mirror-frozen
    allow_actors:
      - manuals-sync[bot]
```

An edit by `manuals-sync[bot]` matches the notify-only contract and yields `warn` without a forbidden edit. The same edit by `alice` emits a forbidden edit and yields `block`, even though the level is warn-only.

## Revision history

- 2026-07-18 — v1 initial normative release. Trigger-model revision same day: `pull_request_review` removed from trusted gate triggers (workflow definitions load from the PR merge commit for that event); required-check deployment guidance moved to ruleset-pinned workflows. See `tasks/LESSONS.md` in the repository for the full evidence trail.
