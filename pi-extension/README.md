# pi-gatekeeper

Pi coding-agent extension for [Gatekeeper](https://github.com/gatekeeper-dev): local contract checks, init/triage slash commands, and a pi-subagents role pack.

This package is a **thin wrapper** around the Gatekeeper engine in the parent repo (`src/engine`, `src/providers`, `src/render`, `src/gate`). It does not reimplement matching or verdict logic.

## Install

### Local path install (supported)

Install from this monorepo checkout so `../src/...` resolves against the parent package:

```bash
pi install /abs/path/to/gatekeeper/pi-extension
```

The package declares a `pi.extensions` manifest entry pointing at `./index.ts`, so the pi package manager can discover the extension after install.

### Development load (supported)

From the Gatekeeper repository root:

```bash
pi -e ./pi-extension/index.ts
```

Or with an absolute path:

```bash
pi -e /abs/path/to/gatekeeper/pi-extension/index.ts
```

Project-local auto-discovery alternative: copy or symlink into `.pi/extensions/gatekeeper/` (directory with `index.ts`).

### npm package install (planned / not available yet)

```bash
# NOT AVAILABLE YET — do not use in production workflows
pi install npm:pi-gatekeeper
```

A published tarball would currently contain only `pi-extension/` itself and would **not** ship the parent package sources (`../src/...`) this extension imports. Self-contained packaging is future work. Prefer local path install or `pi -e` until then.

> Extensions run with full system permissions. Only load code you trust.

## What you get

| Surface | Name | Purpose |
|--------|------|---------|
| Tool | `gatekeeper_check` | Params `{ registryDir, base? }`. Runs local `git` diff + registry evaluate (including lane presets from `lanes.d/`); returns verdict JSON + explain text in `content`, structured verdict in `details`. Failures **throw** so the host marks `isError`. |
| Command | `/gatekeeper-init` | Arg: path to an init brief file. Loads the brief and steers the session to draft `contracts/*.yaml`, then run `gatekeeper validate`. |
| Command | `/gatekeeper-triage` | Arg: path to a triage brief. Steers the session to delegate to **deep-reasoner** and finish with `gatekeeper triage --post`. |
| Agents | `agents/*.md` | pi-subagents roles: `contract-scout`, `registry-drafter`, `registry-reviewer`, `deep-reasoner`. |

### Tool example

Once the extension is loaded, the model can call:

```text
gatekeeper_check
  registryDir: ./registry
  base: main
```

Working directory is the pi session `cwd` (required on the host `ExtensionContext`).

## Role pack + model binding

Agent definitions live in `agents/`:

| File | Role |
|------|------|
| `contract-scout.md` | Single-repo signal scout (facts only, no YAML) |
| `registry-drafter.md` | Draft `contracts/*.yaml` from scout outputs |
| `registry-reviewer.md` | SPEC review of drafts |
| `deep-reasoner.md` | Demand-gate judgment (M6 template) |

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

Point the host at this package’s `agents/` directory using whatever discovery path your pi-subagents build documents (extension package agents folder or explicit agents path in settings).

## Layout

```text
pi-extension/
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
- Host typecheck for the extension entry is covered when the parent test suite imports it; optional: `cd pi-extension && npx tsc --noEmit`.
- Unit tests live in the parent package: `tests/pi-extension.test.ts` (mock `ExtensionAPI`, no real pi runtime).
- Runtime still needs `git` and a valid registry directory for `gatekeeper_check`.
- Registry load uses the same `loadRegistryWithLanePresets` path as CLI `check`/`gate`/`doctor` (lane presets from `lanes.d/`).
