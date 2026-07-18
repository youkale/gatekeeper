# pi-gatekeeper

Pi coding-agent extension for [Gatekeeper](https://github.com/gatekeeper-dev): local contract checks, init/triage slash commands, and a pi-subagents role pack.

This is **one example adapter** among possible agent integrations (see the repo-root [`README.md`](../../README.md#agent-integrations) "Agent integrations" section). The role cards it wires up are vendor-neutral markdown specs that live in [`docs/roles/`](../../docs/roles/); this package only adds the pi-specific tool/command/agent-discovery plumbing around them. It is a **thin wrapper** around the Gatekeeper engine in the parent repo (`src/engine`, `src/providers`, `src/render`, `src/gate`) — it does not reimplement matching or verdict logic.

## Install

### Local path install (supported)

Install from this monorepo checkout so `../../src/...` resolves against the parent package:

```bash
pi install /abs/path/to/gatekeeper/integrations/pi
```

The package declares a `pi.extensions` manifest entry pointing at `./index.ts`, so the pi package manager can discover the extension after install.

### Development load (supported)

From the Gatekeeper repository root:

```bash
pi -e ./integrations/pi/index.ts
```

Or with an absolute path:

```bash
pi -e /abs/path/to/gatekeeper/integrations/pi/index.ts
```

Project-local auto-discovery alternative: copy or symlink into `.pi/extensions/gatekeeper/` (directory with `index.ts`).

### npm package install (planned / not available yet)

```bash
# NOT AVAILABLE YET — do not use in production workflows
pi install npm:pi-gatekeeper
```

A published tarball would currently contain only `integrations/pi/` itself and would **not** ship the parent package sources (`../../src/...`) this extension imports. Self-contained packaging is future work. Prefer local path install or `pi -e` until then.

> Extensions run with full system permissions. Only load code you trust.

## What you get

| Surface | Name | Purpose |
|--------|------|---------|
| Tool | `gatekeeper_check` | Params `{ registryDir, base? }`. Runs local `git` diff + registry evaluate (including lane presets from `lanes.d/`); returns verdict JSON + explain text in `content`, structured verdict in `details`. Failures **throw** so the host marks `isError`. |
| Command | `/gatekeeper-init` | Arg: path to an init brief file. Loads the brief and steers the session to draft `contracts/*.yaml`, then run `gatekeeper validate`. |
| Command | `/gatekeeper-triage` | Arg: path to a triage brief. Steers the session to delegate to **deep-reasoner** and finish with `gatekeeper triage --post`. |
| Agents | `agents/*.md` | pi-subagents adapters for the vendor-neutral role cards in `docs/roles/`: three thin pointer shells (`contract-scout`, `registry-drafter`, `registry-reviewer`) plus a self-contained copy for `deep-reasoner` (its judgment mode has no file-read access, so the isolation constraints must be inline; canonical text lives in `docs/roles/deep-reasoner.md`). |

### Tool example

Once the extension is loaded, the model can call:

```text
gatekeeper_check
  registryDir: ./registry
  base: main
```

Working directory is the pi session `cwd` (required on the host `ExtensionContext`).

## Role pack + model binding

Agent definitions live in `agents/`. Three of the four are small pi frontmatter shells pointing at `docs/roles/<name>.md`; `deep-reasoner` carries a full inline copy (isolation constraints must be readable without file access). The canonical role specification always lives in `docs/roles/` and applies regardless of which coding agent runs it:

| File | Role card |
|------|------|
| `contract-scout.md` | [`docs/roles/contract-scout.md`](../../docs/roles/contract-scout.md) — single-repo signal scout (facts only, no YAML) |
| `registry-drafter.md` | [`docs/roles/registry-drafter.md`](../../docs/roles/registry-drafter.md) — draft `contracts/*.yaml` from scout outputs |
| `registry-reviewer.md` | [`docs/roles/registry-reviewer.md`](../../docs/roles/registry-reviewer.md) — SPEC review of drafts |
| `deep-reasoner.md` | [`docs/roles/deep-reasoner.md`](../../docs/roles/deep-reasoner.md) — demand-gate judgment (M6 template) |

Model tier preference order is defined by the repo-root **`roles-policy.yaml`** (produced by the M6 task). Bind models in pi settings via `subagents.agentOverrides` — example aligned to that preference order:

```json
{
  "subagents": {
    "agentOverrides": {
      "deep-reasoner": {
        "model": "anthropic/claude-fable-5"
      },
      "contract-scout": {
        "model": "anthropic/claude-sonnet-5"
      },
      "registry-drafter": {
        "model": "openai/gpt-5.4-codex"
      },
      "registry-reviewer": {
        "model": "openai/gpt-5.4-codex"
      }
    }
  }
}
```

Replace model IDs with the first **available** entry from each tier in `roles-policy.yaml` (`tiers.deep-reasoner.prefer`, `tiers.coder.prefer`, `tiers.reviewer.prefer`). For dual-reviewer workflows, configure a second reviewer route per your pi-subagents version (cross-vendor when `cross_vendor: true`).

Point the host at this package's `agents/` directory using whatever discovery path your pi-subagents build documents (extension package agents folder or explicit agents path in settings). Any other coding agent can instead load the role cards in `docs/roles/` directly as its own subagent/system-prompt definitions — pi is not required.

## Layout

```text
integrations/pi/
  package.json          # name: pi-gatekeeper, keywords: pi-package, pi.extensions
  tsconfig.json         # standalone noEmit check
  index.ts              # export default function (pi)
  agents/
    contract-scout.md
    registry-drafter.md
    registry-reviewer.md
    deep-reasoner.md
  README.md
```

## Development notes

- Host types come from `@earendil-works/pi-coding-agent` (devDependency of this package).
- Host typecheck for the extension entry is covered when the parent test suite imports it; optional: `cd integrations/pi && npx tsc --noEmit`.
- Unit tests live in the parent package: `tests/integrations-pi.test.ts` (mock `ExtensionAPI`, no real pi runtime).
- Runtime still needs `git` and a valid registry directory for `gatekeeper_check`.
- Registry load uses the same `loadRegistryWithLanePresets` path as CLI `check`/`gate`/`doctor` (lane presets from `lanes.d/`).
