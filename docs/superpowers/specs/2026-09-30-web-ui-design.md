# Web UI design

Status: draft for review. Date: 2026-09-30.

## Purpose

A local-first web UI for mockdata: edit a YAML/JSON schema with live validation, generate and preview tables, infer a draft schema from an existing source, optionally fill `llm` columns, and export files. Single user, localhost only, no accounts.

**In v1:** schema editor + preview, infer from source, LLM columns (with progress and cancel), export/download.
**Not in v1:** run history (SQLite), visual ER/schema builder, auth, multi-user, remote hosting.

## Architecture

- `packages/server`: library plus `mockdata-ui` bin (`npm run ui`); there is no `mockdata ui` CLI subcommand because the server depends on the CLI package. Exports `createApp({root, env, llm})` returning a Node `http` request handler (no port needed in tests; `llm` injects a fake provider). Small hand-rolled router, no framework. Binds `127.0.0.1` only. Serves `packages/web/dist` statically.
- `packages/web`: Vite + React 19 + TypeScript, CodeMirror 6 (`@uiw/react-codemirror`, `@codemirror/lang-yaml`). No router or state library; one top-level component with hooks; plain CSS with light/dark theme. Dev server proxies `/api` to the server.
- Build order: core, llm, inputs, cli, mcp, server, then web (Vite).
- The server is a thin layer over `@mockdata/core`, `llm`, `inputs` and `cli` (`loadEnv`, `parseSchemaText`, `serialize`).
- Refactor: move `resolveInside`, the `.env*` filename rule and the `connectionEnv` name/URL checks from `packages/mcp` into `@mockdata/cli` so MCP and the server share one copy.

## API (JSON)

| Route | Purpose |
|---|---|
| `GET /api/files` | List `.yaml/.yml/.json` schema files under root (never `.env*`). |
| `GET/PUT /api/file?path=` | Read / save a schema. Relative path, confined to root, same rules as MCP `outputDir`. |
| `POST /api/validate` | `{text}` -> parse errors (a line number for YAML syntax errors only; schema errors have none), table order, cycle/deferred-FK notes. |
| `POST /api/generate` | `{text, seed, rows?, tables?}` -> capped preview rows + validation report (deterministic only). |
| `POST /api/generate/stream` (SSE) | LLM run (same body as `/api/generate`; the schema text is the body, so it is a POST read with fetch streaming): per-column progress and token counts; closing the connection aborts the run before the next model request. |
| `POST /api/infer` | `{path}` \| `{content, kind}` \| `{connectionEnv}` -> `{schemaText, warnings}`. |
| `POST /api/export` | `{text, seed, format, outputDir, overwrite}` -> written file list; or `{zip: true}` instead of `outputDir` -> a zip download (nothing written). Exactly one of the two. |
| `GET /api/config` | LLM provider, model, key-present boolean, usable DB env var names. Never values. |

## Security

Inputs are treated like MCP tool input (untrusted).
- Paths confined to root (`resolveInside`, symlink-safe); `.env*` never readable; no overwrite without `overwrite: true`; conflicts checked before any LLM call.
- Schema text goes through `parseSchemaText` (table-name and `faker:` hardening apply).
- Connection strings are never accepted from the browser; only `connectionEnv` names, with the existing name rules. Values are never echoed; errors name variables only.
- Requests with a non-localhost `Host` or `Origin` are rejected (DNS rebinding / CSRF). No token: single-user local tool.

## UI

One screen, three regions.
- **Sidebar:** schema files under root; New, Save, "Infer from source..."; dot for unsaved changes.
- **Center:** YAML editor with inline lint markers (400ms debounced `/api/validate`); status strip with table count, generation order, cycle notes.
- **Right:** preview. Tab per table, grid of first 50 rows (raw JSON view), header with seed, row-count override (applies to every table; preview refuses more than 200,000 rows in total), Generate. Validation problems as a banner. FK cells marked; clicking jumps to the parent row.

Flows:
- **Generate:** without LLM, one POST. With LLM, open the SSE stream; progress bar (table.column, batch n of m), token counts, Cancel. A cancelled run is discarded and the previous preview stays, so a partial result never looks complete.
- **Infer:** dialog with tabs: file under root, pasted content + kind, DB env var name. Result opens as an unsaved draft; warnings listed beside it.
- **Export:** dialog for format (json/ndjson/csv), relative output folder (default `out/`), overwrite checkbox; shows written files; zip download.
- **LLM toggle:** disabled with tooltip when `/api/config` shows no provider/key; names missing variables, never values.

## Testing

- Server: call the `createApp` handler directly with a fake LLM provider (CLI pattern); empty temp cwd so a real `.env` never leaks.
- Web: Vitest + Testing Library with a stubbed `fetch`.
- End to end: start the server on an ephemeral port against `examples/shop.yaml`.
- Security tests: path escape, symlink, `.env`, bad Host/Origin, connectionEnv name rules.

## Docs

README gets a "Web UI" section; CLAUDE.md gets a server/web paragraph and the new build order.
