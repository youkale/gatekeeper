# gatekeeper-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Gatekeeper](https://github.com/gatekeeper-dev): a stdio-transport process exposing `gatekeeper_check`, `gatekeeper_validate`, and `gatekeeper_brief` to **any** MCP-capable client (Claude Code, Cursor, Codex, or any other MCP host) — not just one vendor's coding agent.

This is a **host-agnostic** integration surface, distinct from [`integrations/pi/`](../pi/) (a pi-specific extension). Both are thin wrappers around the same engine in the parent repo (`../../src/engine`, `../../src/providers`, `../../src/render`, `../../src/gate`, `../../src/commands`) — this package does not reimplement matching, verdict, or CLI-command logic, and it makes **zero LLM/model calls** itself (it is a transport shim, not an agent).

## What you get

| Tool | Params | Purpose |
|------|--------|---------|
| `gatekeeper_check` | `{ registryDir, base?, staged?, workingTree?, repo?, actor? }` | Run a local Gatekeeper contract check against a git diff. Exactly one of `base` / `staged` / `workingTree` may be set (all unset auto-detects `main`/`master`); setting more than one is rejected. Returns verdict JSON plus a human-readable explain trace as a text content block. Infrastructure/config faults (bad registry, git failures) throw, which the MCP SDK surfaces as an `isError` result — a computed `block`/`warn`/`pass` decision never throws. |
| `gatekeeper_validate` | `{ registryDir, strict? }` | Validate a contract registry: schema check plus glob/foreign-key lint (same semantics as `gatekeeper validate`). A schema/parse/read failure (CLI exit 2) throws (`isError`). With `strict: true` and warnings present (CLI exit 1), the tool returns normally with `ok: false` in its text — a strict-mode failure is a legitimate negative *result*, not a call failure, same treatment as `gatekeeper_check` returning a `block` decision without throwing. |
| `gatekeeper_brief` | `{ path }` | Read an init/triage brief file (produced by `gatekeeper init` / `gatekeeper triage`) verbatim, so a client-side agent can load it and execute the matching [`docs/roles/`](../../docs/roles/) role card (`registry-drafter`, `deep-reasoner`, ...). Missing file throws (`isError`). |

All three tools return plain `content: [{ type: "text", ... }]` blocks (no `structuredContent`/`outputSchema`) — parse the JSON verdict out of `gatekeeper_check`'s text if you need it structurally.

Working directory: the server has no per-call session `cwd` (stdio transport has none by default), so relative `registryDir`/`base`/`path` arguments and git commands resolve against the server **process's own** `process.cwd()`. Launch the server with your client's working-directory setting pointed at the repository root you want it to operate on (see the client configs below).

## Install / run

### Claude Code

Build once, then register the built entry point:

```bash
cd /abs/path/to/gatekeeper/integrations/mcp
npm install
npm run build   # emits dist/index.js (bundled, no workspace checkout needed to run it)
claude mcp add gatekeeper -- node /abs/path/to/gatekeeper/integrations/mcp/dist/index.js
```

Or run straight from source without building (development loop):

```bash
claude mcp add gatekeeper -- npx tsx /abs/path/to/gatekeeper/integrations/mcp/index.ts
```

### Cursor / any client with a generic `mcpServers` JSON config

```json
{
  "mcpServers": {
    "gatekeeper": {
      "command": "node",
      "args": ["/abs/path/to/gatekeeper/integrations/mcp/dist/index.js"]
    }
  }
}
```

Development variant (no build step, runs the TypeScript source directly via `tsx`):

```json
{
  "mcpServers": {
    "gatekeeper": {
      "command": "npx",
      "args": ["tsx", "/abs/path/to/gatekeeper/integrations/mcp/index.ts"]
    }
  }
}
```

### Codex / other MCP clients

Any client that spawns a stdio MCP server from a command works the same way: point it at `node dist/index.js` (after `npm run build`) or `npx tsx index.ts` from this directory, using absolute paths. Consult your client's own MCP configuration docs for where that command/args pair goes.

> The server runs with the permissions of whatever process spawns it (it shells out to `git`, reads the registry/brief files you point it at). Only configure it against repositories/registries you trust.

## Tool semantics + role card handoff

`gatekeeper_check` and `gatekeeper_validate` follow the same fail-direction law as the CLI (`docs/SPEC.md` / `AGENTS.md`): a computed governance decision (block/warn/pass, or a strict-mode warning count) is a normal result, never an `isError`; only an infrastructure/configuration fault (unreadable registry, git failure, schema/parse error) throws and becomes `isError`.

`gatekeeper_brief` is intentionally dumb — it just returns file bytes. The pattern (matching `integrations/pi/index.ts`'s `/gatekeeper-init` and `/gatekeeper-triage` commands) is:

1. Run `gatekeeper init --out <dir>` or `gatekeeper triage --issue <n> --repo <org/name> --registry <dir>` locally to produce a brief file.
2. Call `gatekeeper_brief` with that path to load it into the current MCP session.
3. Have your client-side agent execute the matching [`docs/roles/`](../../docs/roles/) role card (`registry-drafter` for an init brief, `deep-reasoner` for a triage brief) against the brief content.
4. Close the loop with `gatekeeper_check`/`gatekeeper validate` (or `gatekeeper triage --post`) as the role card instructs.

## Layout

```text
integrations/mcp/
  package.json     # name: gatekeeper-mcp, deps: @modelcontextprotocol/sdk, zod
  tsconfig.json     # standalone noEmit check
  tsup.config.ts    # bundled build -> dist/index.js
  index.ts          # createGatekeeperMcpServer() + stdio main() entry point
  testing.ts        # test-only: real Client<->Server in-memory connection helper
  README.md
```

## Development notes

- Host types/classes come from `@modelcontextprotocol/sdk` (dependency of this package, pinned alongside `zod` at the same major line the parent package uses).
- Standalone typecheck: `cd integrations/mcp && npx tsc --noEmit`. Also covered transitively by the root `npm run typecheck` (via `tests/integrations-mcp.test.ts`'s imports) — bare `@modelcontextprotocol/sdk/*` specifiers always resolve relative to the *importing file's own location*, so this package's own `node_modules` supplies them regardless of which top-level test imports it (same trick `integrations/pi/index.ts` uses for its host type re-exports; CI runs `npm ci --prefix integrations/mcp` for the same reason `npm ci --prefix integrations/pi` exists).
- Unit/integration tests live in the parent package: `tests/integrations-mcp.test.ts`, using `testing.ts`'s `connectInMemory()` helper to do a real client/server protocol round trip over `InMemoryTransport` (no real network, no child process) plus direct calls into the exported `runGatekeeperCheck`/`runGatekeeperValidate`/`runGatekeeperBrief` functions.
- Build: `npm run build` (tsup, bundled — `noExternal: [/.*/]` — so `dist/index.js` has no dependency on this monorepo's relative `../../src/...` imports resolving from a different directory depth; see the comment in `tsup.config.ts`).
- Runtime still needs `git` on PATH and a valid registry directory for `gatekeeper_check`, same as the CLI and the pi extension.
- Registry load uses the same `loadRegistryWithLanePresets` path as CLI `check`/`gate`/`doctor`/pi's `gatekeeper_check` (lane presets from `lanes.d/`).
