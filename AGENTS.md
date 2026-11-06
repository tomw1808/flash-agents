# Working in flash-agents

A Claude Code plugin: an MCP server (`packages/flash-mcp/`) that hands tasks to DeepSeek Harness
workers inside a dsh sandbox, on macOS, Linux and Windows. Plain Node ESM, no TypeScript, no
dependencies, no build step.

- `packages/flash-mcp/lib/`: `index.js` (CLI, MCP tool schemas and descriptions), `service.js`
  (calls, results, warnings, worker instructions), `isolation.js` (copies, slots, patches, apply,
  caches), `jobs.js` (background jobs), `proctree.js` (process-tree watcher), `doctor.js`,
  `config.js`, `sdk.js`, `mcp.js`.
- `packages/flash-mcp/test/` (unit tests, `node --test`), `test-support/` (the stand-in Harness),
  `scripts/verify-live.mjs` (the live suite, needs Ollama; never run it in a task).
- `packages/dsh-flash-guard/` (the command guard, `lib/` and `test/`), `packages/dsh-subagent-flash/`.
- `README.md`, `docs/design.md`, `skills/` are user-facing docs.

Check: `npm test` from the repository root (all three suites). Run a single file with
`node --test packages/flash-mcp/test/<file>`. Every change ends with a full `npm test`; paste the
summary lines.

Hard rules:
- Tests never touch the real home directory, the real `DSH_HOME`, the real temp state base or the
  real data directory: use temp dirs and the idioms of the existing tests. Never run real `icacls`.
- No silent defaults, caps, prefixes or truncation unless the task asks for them; every threshold is
  a named constant with a comment saying why.
- Match the surrounding style and comment density; JSDoc on new functions like the neighbours.
- Every defect fixed gets a test that fails before and passes after, through the real entry point.
- Do not edit version numbers. Do not touch `docs/handoff-disk-hygiene.md`.
