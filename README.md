# flash-agent

Cheap DeepSeek Harness workers, in two shapes:

- **`flash-orchestrator`** — an interactive agent preset for DSH sessions that delegates to
  `flash` workers, in parallel (`workflow`), or as a bounded gauntlet (`ralph`).
- **`flash-mcp`** — a local stdio MCP server that lends the same worker pipeline to an *external*
  coding agent (Claude Code and anything else that speaks MCP), one narrow task at a time.

Everything delegated by either piece runs on **Ollama / `deepseek-v4.1-flash:cloud`**, even when the
orchestrating session runs on an expensive model.

## The routing contract

`flash` is a **strict routing contract**, not a preference:

- A child started through provider `flash` always uses `provider: ollama`,
  `model: deepseek-v4.1-flash:cloud`.
- `request.agentOptions.provider` and `request.agentOptions.model` are **dropped** — a caller, a
  model-authored workflow script, an MCP client, or an inherited parent route can never change the
  route. Other requested options (`reasoningEffort`, `maxTokens`) still pass through.
- Continuable children are **refused**: `flash` has no `prepareContinuable`, because the
  continuation manager resolves a continuable child's route outside the provider. Use the host
  `spawn` provider when you need a caller-selected or continuable child route.
- Every flash child is a **leaf**. `start()` refuses to run when the delegating parent is itself
  already a delegated child (`maxChildDepth: 0`). Because every flash child — the `flash` tool, a
  workflow `agent()`, a Ralph round — is created through this provider, a raised chain is rejected
  at the one place all of them pass. This is structural, independent of tool names, and can be
  relaxed per row with `maxChildDepth`.

Generic caller-selectable routing stays available on the shipped `spawn` provider.

## Layout

```
packages/dsh-subagent-flash/        host-plane provider row (the only custom Harness code)
  lib/index.js                      ~200 lines, zero imports, delegates to `spawn`
  test/contract.test.mjs            22 contract tests, run with `node --test`
packages/flash-mcp/                 MCP stdio server + SDK JSON-RPC client half
  lib/mcp.js                        minimal MCP stdio server: framing, initialize, tools, cancel
  lib/sdk.js                        client for one persistent `dsh` child over the shipped SDK protocol
  lib/service.js                    flash_task: fresh session per call, compact result, cwd fence
  lib/index.js                      CLI entry, tool contract, lifecycle
  test/mcp.test.mjs                 protocol-level server tests
  test/service.test.mjs             service tests against a fake runtime
  test/integration.test.mjs         MCP → SDK → stand-in Harness, whole pipeline, no LLM
  test/fake-dsh.mjs                 the stand-in Harness process
  test/verify-live.mjs              live end-to-end verification through the official MCP client
presets/flash-orchestrator/         interactive agent preset (repo is the source of truth)
  agent.cordis.yml                  17 rows: identity, shell, fs, jobs, skills, goals,
                                    compaction, delegation, remaining tools
  preset.yml                        roster metadata
profiles/flash-service/             the headless SDK profile behind `flash-mcp`
  cordis.patch.yml                  route, permissions, disabled competitors, provider, tool
  package.json / cordis.yml / pnpm-workspace.yaml
install.mjs                         idempotent installer / uninstaller
```

## Install

```sh
node install.mjs                 # install or update
node install.mjs --dry-run       # print the plan, write nothing
node install.mjs --uninstall     # remove preset, provider copy, and both managed blocks
node install.mjs --profile p     # target interactive profile (default: $DSH_PROFILE or "web")
node install.mjs --home /path    # target harness home (default: $DSH_HOME or ~/.dsh)
```

It materializes generated copies of repo-authored sources, replacing what it wrote before so reruns
update instead of duplicating:

| Generated target | Source |
|---|---|
| `$DSH_HOME/.agent-presets/flash-orchestrator/` | `presets/flash-orchestrator/` |
| `$DSH_HOME/profiles/<profile>/plugins/dsh-subagent-flash.js` | `packages/dsh-subagent-flash/lib/index.js` |
| `$DSH_HOME/profiles/<profile>/cordis.patch.yml` — one marker-delimited `insert` block | generated from the row id + config |
| `$DSH_HOME/profiles/flash-service/` — skeleton, created only when absent | `profiles/flash-service/` |
| `$DSH_HOME/profiles/flash-service/cordis.patch.yml` — one marker-delimited block | the marker block of `profiles/flash-service/cordis.patch.yml` |

Both patch blocks sit between `# >>> …` and `# <<< …` markers; any other patch content you have is
preserved, and an existing block is replaced in place. If a patch file has no markers and is not an
empty `[]` or a YAML sequence, the installer refuses to touch it. Profile skeleton files are written
only when absent, so local edits to `flash-service` survive an update.

**Restart the interactive profile** (`dsh --profile web web`) after installing: the provider row is
host-plane and mounts at boot.

## Use from Claude Code

```sh
claude mcp add flash -- node /Users/thomas/Projects/flash-agent/packages/flash-mcp/lib/index.js \
  --root /Users/thomas/Projects/flash-agent
```

or, in `.mcp.json`:

```json
{
  "mcpServers": {
    "flash": {
      "command": "node",
      "args": [
        "/Users/thomas/Projects/flash-agent/packages/flash-mcp/lib/index.js",
        "--root",
        "/Users/thomas/Projects/flash-agent"
      ]
    }
  }
}
```

`--root` is the workspace the workers may touch: it becomes the runtime's working directory, the
sandbox root, and the fence for the per-call `cwd`. It defaults to the MCP server's own working
directory.

### The pipeline

```
Claude Code ──MCP stdio──► flash-mcp ──SDK stdio JSON-RPC──► dsh --profile flash-service
                                                                    │
                                                     dispatch prompt → `flash` / `workflow`
                                                                    │
                                       one worker per task on ollama/deepseek-v4.1-flash:cloud
                                       behind the flash-guard wall (tools/execute wrapper)
```

- The Harness runtime is a **separate, persistent child process** — never embedded, never reached
  except through the shipped SDK stdio JSON-RPC protocol (`initialize`, `session/prompt`,
  `shutdown`, plus its notifications).
- It **starts lazily** on the first `flash_task` and is **reused** across calls; every call gets a
  fresh orchestration session *and* a fresh worker session. One process per mode: a call asking for
  `read-only` boots the read-only profile instead, and keeps it.
- Nothing is scraped: the runtime's stdout carries protocol frames, its stderr is kept only as a
  bounded diagnostic tail, and results come from the runtime's own `subagent.finished` notification
  plus the worker's logged `request/header` (which is where the reported route comes from — observed,
  not assumed).
- Subagent lifecycle, routing policy, limits, and the sandbox stay **inside Harness**. This repo
  composes them; it does not reimplement them.

### The tools

Two doors, and nothing else:

| Tool | Required | Purpose |
|---|---|---|
| `flash_task` | `task`, `cwd` | one self-contained task on one worker |
| `flash_batch` | `tasks` | a fleet the caller has already split, one worker per task |

Optional on both: `acceptance` (one string, or per task in `flash_batch`), `cwd`, and `mode`
(`workspace-write` — the default — or `read-only`). There is no model, provider, effort, or
permission parameter: the route is not a caller capability, and neither is the sandbox. Unknown
arguments are ignored rather than forwarded.

`flash_task { task, cwd, acceptance?, mode? }` returns one worker's outcome:

```json
{
  "status": "ok",
  "stopReason": "completed",
  "provider": "flash",
  "route": { "provider": "ollama", "model": "deepseek-v4.1-flash:cloud" },
  "result": "Created `flash-mcp-probe.txt` …",
  "resultTruncated": false,
  "childSessionId": "ac612f23-ddff-4765-9581-32c65ae7448b",
  "sessionId": "flash-task-564be63a-b6f7-45f1-aa9c-d74f61265991",
  "durationMs": 8123,
  "mode": "workspace-write",
  "runtime": { "pid": 98476, "booted": true, "uptimeMs": 13323, "sessions": 1, "profile": "flash-service" }
}
```

`flash_batch { tasks, cwd?, acceptance?, mode? }` returns one entry per task, **in task order**, so
`results[i]` always answers `tasks[i]`:

```json
{
  "status": "ok",
  "requested": 3,
  "agentsStarted": 3,
  "runId": "ea1adf8a-0395-44c3-b517-ea0d55161c33",
  "runName": "flash-batch",
  "runStopReason": "completed",
  "results": [
    { "index": 0, "status": "ok", "result": "…", "resultTruncated": false,
      "childSessionId": "6e5b7ea7-…", "outcome": "completed", "stopReason": "completed", "provider": "flash" }
  ],
  "routes": [{ "provider": "ollama", "model": "deepseek-v4.1-flash:cloud" }],
  "workers": [{ "status": "ok", "stopReason": "completed", "provider": "flash",
                "route": { "provider": "ollama", "model": "deepseek-v4.1-flash:cloud" },
                "childSessionId": "6e5b7ea7-…", "resultChars": 214 }],
  "maxParallel": 3,
  "sessionId": "flash-batch-…",
  "mode": "workspace-write",
  "durationMs": 41207,
  "runtime": { "pid": 98476, "booted": true, "uptimeMs": 51230, "sessions": 2, "profile": "flash-service" }
}
```

- `status` is `ok` only when every task is `ok`, `partial` when some are, `error` when none are, and
  `unknown` when the outcome could not be read.
- The pairing is **not** a guess. The caller sends a fixed script that returns its entries in task
  order, and the engine reports each member under the label this service generated (`task-N`), so a
  member's own session and outcome are read back even if the return value is truncated away. If
  neither source is available, `results` is `null` and `warnings` says so — the service never
  invents a mapping.
- `maxParallel` is the peak concurrency **observed** from the runtime's own start/finish
  notifications; a fleet that never ran two workers at once is reported with a warning.

The worker's transcript is never returned; `result` is its final message, clipped to
`--max-result-chars` (default 8000) — and per task to `--per-item-chars` (default 4000) inside a
fleet. Failures the caller can act on (timeout, no delegation, out-of-root `cwd`, unknown `mode`,
runtime failure) come back as MCP tool errors whose message names the cause and, for a
non-delegating orchestrator, what it did instead.

### Permissions

The caller's permission system only ever sees the `flash_task` / `flash_batch` call, so the scope it
authorizes is that call. Everything a worker does inside it is invisible to it. Three layers stand in
for that visibility, in order:

**1. The standing policy** — set by the profile, not by a caller:

| Knob | Value | Effect |
|---|---|---|
| `sandbox-policy.mode` | `workspace-write` | repository-local reads, edits, and commands run unattended |
| `approval.policy` | `never` | anything that would need approval is denied outright |
| `permission` row | disabled | no runtime switch can widen the mode |

Approval is consulted only for *escalations*, so ordinary in-workspace work needs none, and an
operation outside the workspace **fails closed** — a sandbox denial, not a prompt. This is
deliberately **not** `danger-full-access`.

**2. The wall** — `flash-guard`, a `tools/execute` wrapper in the same profile. The sandbox confines
*writes*, but it permits reads everywhere, so without this a worker could read a private key and
report it back. It refuses, deterministically and without consulting any model:

| Class | Rule | Read | Write |
|---|---|---|---|
| secrets | the `.env` family (minus `.env.example`/`.sample`/`.template`/`.dist`), `.netrc`, `.pgpass`, `.git-credentials`, and `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.dsh`, `~/.config/gh`, `~/.config/gcloud`, `~/.docker/config.json` | denied | denied |
| state | any `.git` segment; `.npmrc`, `.mcp.json`, `.gitconfig`, shell rc files | allowed | denied |
| catastrophic | `rm`/`rmdir` of `/`, a top-level directory, a home, the service root or an ancestor, a bare glob at the root; redirects into a protected target; `git reset --hard`, `git clean -fdx`, `git push --force`, `git checkout -- .` | — | denied |

A denied call never runs: the wrapper returns an `isError` result instead of calling `next()`, and
carries `error.info.code = "FLASH_GUARD_DENIED"` with a reason (`PROTECTED_SECRET`,
`PROTECTED_STATE`, `CRITICAL_PATH`, `DESTRUCTIVE_GIT`). Those refusals are attributed back to the
task that caused them in `results[i].denials`:

```json
"denials": [{ "index": 0, "childSessionId": "42bd62ef-…", "code": "FLASH_GUARD_DENIED",
              "reason": "PROTECTED_STATE", "message": "Error: flash-guard denied write (PROTECTED_STATE): .git holds repository state…" }]
```

It is a **circuit breaker, not a sandbox**: the file and shell sandboxes remain the enforcement
boundary, and it makes no claim about the rest of the shell language. It refuses in the safe
direction — a command that merely *mentions* a secret path is denied too — so treat a denial as
"ask the caller", not "the command was necessarily malicious". Protected lists are composed in the
profile (`flash-guard.config`), so a deployment can widen or narrow them there.

**3. Read-only, per call** — `mode: "read-only"` runs the call in a second, lazily-booted process
whose profile (`flash-service-readonly`, generated by `install.mjs` as this repo's flash-service
composition with exactly one change: `sandbox-policy.mode: read-only`) denies every mutation at the
sandbox. Nothing can widen the standing profile: unknown modes are refused with `MODE_UNAVAILABLE`.

### Worktree guidance

The sandbox root is the whole workspace, and a worker may write anywhere inside it. Point `--root`
at something you are willing to lose: a **git worktree or a scratch clone**, not a checkout holding
uncommitted work you care about. The wall protects `.git` and secrets, but it does not protect your
uncommitted source.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `FLASH_SERVICE_ROOT` | cwd | sandbox root, runtime working directory, `cwd` fence |
| `FLASH_SERVICE_PROFILE` | `flash-service` | profile the runtime boots |
| `FLASH_SERVICE_PROVIDER` / `FLASH_SERVICE_MODEL` | `ollama` / `deepseek-v4.1-flash:cloud` | pinned orchestrator route (the worker route is pinned by the profile) |
| `FLASH_TASK_TIMEOUT_MS` | `300000` | per-task wall-clock budget |
| `FLASH_RESULT_MAX_CHARS` | `8000` | returned worker-message budget |
| `FLASH_MAX_TOKENS` | unset | optional output cap for SDK agents |
| `FLASH_BATCH_TIMEOUT_MS` | `900000` | per-fleet wall-clock budget |
| `FLASH_MAX_TASKS` | `16` | ceiling on tasks in one `flash_batch` call |
| `FLASH_PER_ITEM_CHARS` | `4000` | returned per-worker budget inside a fleet |
| `FLASH_DSH_BIN` | `dsh` on `PATH` | the launcher to spawn (a `.js` path runs under the current Node) |

## Verify

```sh
node --test packages/dsh-subagent-flash/test/   # 22 provider contract tests
node --test packages/flash-mcp/test/            # 44 protocol, service, pipeline, and fleet tests
node packages/flash-mcp/test/verify-live.mjs    # live end-to-end, needs Ollama and a profile boot
```

The pipeline tests run a stand-in Harness process, so MCP framing, lazy boot, process reuse,
session-per-call, route observation, and result projection are covered without an LLM. `verify-live`
drives the real thing through the **official `@modelcontextprotocol/sdk` client** — a different
implementation of the protocol the target agent speaks — and prints one line per check.

### What was verified live

`node packages/flash-mcp/test/verify-live.mjs` → **33/33 checks**, from a real MCP client over real
stdio, against a real `dsh --profile flash-service` runtime:

- MCP handshake identifies `flash-mcp`; exactly one tool; `task`/`cwd` required; **no
  model-selection property exists**.
- No runtime process before the first call; exactly one boot, one handshake, one process for the
  whole session (same pid across calls).
- A real `flash_task` wrote and read a repository-local file **without interactive approval**, and
  ran `node --test packages/dsh-subagent-flash/test/` in-workspace (22 passing, exit 0).
- The worker's observed route was `ollama/deepseek-v4.1-flash:cloud`, with `provider: flash`.
- Hostile caller fields (`provider`, `model`, `reasoningEffort`, `agentOptions`) did **not** change
  the worker route and were not echoed back.
- Each call produced a fresh orchestration session and a fresh worker session.
- A `cwd` outside the root failed closed with an explicit refusal; a write to
  `/Users/thomas/flash-mcp-escape-*.txt` was denied by the sandbox
  (`Operation not permitted`, `workspace-write` policy) and the file never appeared.
- The result carried the worker's terminal status, stop reason, observed route, and final message —
  and no transcript.
- The runtime's own session logs confirm the composed surface: the orchestrator's request header
  lists 23 tools including `flash` and **no** `subagent`, `subagent_fork`, `workflow`, `ralph`, or
  goal tool; the worker's header lists 22 — the same set minus `flash`, so a worker can still read,
  edit, search, and run commands.

Earlier, for the interactive preset: the host row mounts through live patch reload with the pinned
`agentRouteDefaults`; a hostile-override child was forwarded `ollama/deepseek-v4.1-flash:cloud` and
answered `flash ok`; the leaf guard rejected a depth-1 parent; and the `flash-orchestrator` subtree
composes against the live provider.

## Hard limits

| Limit | Delegation (`flash`) | Parallel (`workflow`) | Gauntlet (`ralph`) | MCP (`flash_task` / `flash_batch`) |
|---|---|---|---|---|
| total child agents | 1 per call | `maxTotalAgents: 32` per run | `maxRounds: 12` | 1 / `FLASH_MAX_TASKS` (16) per call |
| concurrent child agents | 1 | `maxConcurrentAgents: 4` | 1 (sequential by design) | 1 / `maxConcurrentAgents: 4`, plus any number of calls in flight |
| rounds | n/a | n/a | `maxRounds: 12` | 1 |
| failures / no progress | single result | `agent()` resolves `null`; the script decides | first failed round ends the run; no-progress is bounded only by `maxRounds` | a failed worker is reported, never retried; a fleet reports `partial` |
| delegation depth | `maxDepth: 1` on the row, plus the provider's leaf guard (`maxChildDepth: 0`) | same leaf guard | same leaf guard | same leaf guard |
| time | provider default | engine default | engine default | `FLASH_TASK_TIMEOUT_MS` (5 min) / `FLASH_BATCH_TIMEOUT_MS` (15 min) |

The engine caps are **per run**; two concurrent workflows each get their own budget.

## How each requirement is met

| # | Requirement | Implementation |
|---|---|---|
| 1 | named backend `flash` | `subagent-flash-in-process` provider row on the host `subagents` registry |
| 2 | V4.1 Flash via the configured Ollama route | row config `provider: ollama`, `model: deepseek-v4.1-flash:cloud`, forced in `start()` |
| 3 | one narrow delegation tool | `tool-flash` (`@deepseek-ai/dsh-tool-subagent`) — one-shot, `maxDepth: 1`, narrow child persona |
| 4 | child model independent of parent | the contract drops caller routing, so an expensive parent cannot leak; override a *child route* by using the `spawn` provider instead |
| 5 | bounded parallel execution | `@deepseek-ai/dsh-tool-workflow` + `@deepseek-ai/dsh-workflow-worker-thread` |
| 6 | bounded fresh-agent gauntlet | `@deepseek-ai/dsh-tool-ralph` (shipped fixed script, workspace + structured handoff) |
| 7 | hard limits | table above |
| 8 | no unrestricted fs/shell | the preset only selects tools; the sandbox and approval rows stay host-plane, and children inherit them |
| 9 | modifications inside this repo | all authored files live here; `install.mjs` generates the copies DSH must read |
| 10 | prefer existing packages | 16 of 17 preset rows are shipped packages; the single custom row delegates the run to the shipped `spawn` provider |
| 11 | external agent can use the workers | `flash-mcp`, a stdio MCP server over the shipped SDK JSON-RPC runtime |
| 12 | only the shipped protocol crosses the boundary | `@deepseek-ai/dsh-sdk-protocol` frames; no embedding, no CLI scraping, no `dsh web` session |
| 13 | persistent, reused runtime | one lazily started `dsh --profile flash-service` child; sessions per call, process per service |
| 14 | headless permissions solved explicitly | `workspace-write` + `approval: never`, `permission` disabled; in-workspace works, outside fails closed |
| 15 | a fleet an external agent can split itself | `flash_batch` — one workflow run per call, pinned `flash` members, per-task results in task order |
| 16 | permission escalations are visible to the caller | `flash-guard` denials are structured (`code`, `reason`) and attributed per task in `results[i].denials`; a sandbox denial stays a denial, never a prompt |
| 17 | a caller can narrow, never widen | `mode: "read-only"` boots a second profile whose sandbox denies every mutation; unknown modes are refused |

## Design decisions

- **Plane split.** The `subagents` registry and its providers are host-plane process singletons
  (the api-proxy reads the registry across sessions, and a provider name registers once), so the
  `flash` provider is a host row and the preset only contributes tools. `workflowEngine` is owned by
  the preset, so every row that reaches it shares one `isolate` realm.
- **A delegating provider, not a reimplementation.** `flash` calls
  `ctx.subagents.getProvider('spawn').start(...)`. The shared in-process driver keeps owning child
  creation, depth accounting, structured output, cancellation, and disposal; this row owns policy
  only.
- **Zero imports.** The row is loaded from the profile composition, whose module resolution anchor
  is the harness install rather than this repository. Depending on nothing keeps the file portable
  and avoids a second copy of `@deepseek-ai/*` packages in the process.
- **A leaf guard instead of an injected `maxDepth`.** A provider cannot make its children leaves by
  passing `maxDepth`: that value caps the depth of the child being created, not the child's own
  later budget, which travels on the child's options and every future request. The guard therefore
  reads the delegating parent's depth and refuses to deepen an existing chain.
- **No universal tool deny list.** `tools.restrict()` *throws* when a filter names a tool the
  composition does not define (``names unknown global tools "x"``), and that error aborts the whole
  child start — so a composition-agnostic deny list silently breaks delegation in any preset that
  does not happen to register every name. The provider ships none; each row denies only names its
  own composition defines, which is also where `tools.restrict()` is scoped.
- **Tool filters merge, never widen.** A configured deny list unions with the request's; allow lists
  intersect. A provider policy can only tighten what a caller asked for.
- **The SDK protocol is the only boundary.** It is the supported out-of-process seam, it carries
  structured events rather than prose, and it lets the client observe a child's *logged* route
  instead of trusting configuration. `flash-mcp` therefore hand-rolls the small client half against
  `JsonRpcLineTransport` semantics (newline-delimited JSON-RPC) and needs no dependency at all.
- **The service profile composes Flash directly.** SDK-created agents join no preset — the SDK server
  calls `agents.create` without one — so the provider row and the `flash` tool are composed into the
  profile itself. There is no preset selection to get wrong, and no dependency on preset discovery.
- **The route is declared by the profile, not read from user settings.** A service that silently
  picks up whatever a user-facing settings document happens to say can break — or widen — outside
  this repo's control. Declaring it also pins exactly one model, so no caller can select a larger or
  costlier one. Omitting `apiKeyEnv` keeps the route credential-free (the Ollama daemon
  authenticates cloud models from its own sign-in); the profile carries an `authorization` header
  because pi-ai's completions transport requires either that or a key.
- **Two doors, and no others.** The service profile disables `tool-subagent`, `tool-subagent-fork`,
  `tool-subagent-control`, `tool-subagent-list-agents`, `tool-ralph`, and `tool-goal`, so a
  dispatcher cannot start unrouted or long-running work instead of the work it was given: it may
  delegate one task (`flash`) or fan a pre-split batch out (`workflow`), and nothing else.
- **The caller splits the work; Harness runs it.** `flash_batch` adds no scheduler. It sends one
  prompt that carries a fixed script and the caller's tasks as arguments, the shipped engine owns
  fan-out, concurrency, and the child ceiling, and the profile pins `provider: flash` on that engine
  so a fleet member cannot pick a route. This repo owns the contract — how many tasks a call may
  carry, and how the fleet's outcome is projected back — and nothing below it.
- **Per-task pairing is read, never inferred.** The script returns its entries in task order, and
  the engine reports each member under the label this service generated (`task-N`), which also
  carries the member's own child session and outcome. When neither the return value nor a complete
  label set is available, `results` is `null` with a warning instead of a guessed mapping.
- **The fleet's result ceiling is raised on purpose.** `tool-workflow.maxResultChars` is 250 000 in
  this profile: the per-task return value is rendered as *text* into the tool result, and the service
  reads it back out of that text. A tighter default would silently truncate the fleet's own answer.
- **The wall wraps dispatch, not the intent waterfall.** The shipped observation policy registers on
  `fs/write-intent` and returns *without calling `next()`*, so a later listener on that waterfall can
  be skipped entirely. `tools/execute` cannot be skipped that way: a wrapper either calls `next()`
  (the body runs) or returns its own result (no body runs at all), which is exactly the veto needed.
- **Secrets are read-denied; state is write-denied.** The sandbox confines writes, so a read of
  `~/.ssh/id_rsa` is the hole a cheap worker would otherwise have — exfiltration needs no write.
  `.git` stays readable because `git status` reads it, and a worker that cannot run git is not a
  worker. Both lists live in the composition, not in code.
- **Read-only is a second profile, not a flag.** `sandbox-policy.mode` is fixed for the life of a
  process and the SDK protocol has no method to change it, so "this call cannot write" is only true
  in a process whose sandbox was composed that way. `install.mjs` generates that profile from the
  same source with one line changed, and the service boots it lazily per mode.
- **Dispatch, don't do.** Each call sends one tightly constrained prompt: call `flash` once, with the
  task text verbatim, attempt nothing else, do not retry, and answer `DELEGATED`. The prompt is the
  only place this repo influences the orchestrator; every policy downstream is Harness's.

## Known limits

- **`flash_gauntlet` is not implemented over MCP.** The Ralph row stays disabled in the service
  profile: `flash_task` covers one task and `flash_batch` covers a pre-split fleet, and an iterative
  gauntlet has no external-agent use case yet. (The interactive preset keeps `ralph`.)
- **The judge layer is not implemented.** The shipped default is the deterministic wall: no model is
  consulted, so no prompt can argue with it. An opt-in `autojudge` mode would consult a second route
  for the gray zone the wall deliberately leaves open (deletions it allows, commands that reach the
  network), fail closed, and log every verdict — it is planned, not present.
- **The wall parses shell, imperfectly.** It recognises `rm`/`rmdir`/`shred`, destructive `git`,
  redirects, and secret references, including inside inline interpreter code. It does not chase
  `find -delete`, `xargs rm`, a secret piped through an interpreter variable, or a program that
  writes outside these shapes. It refuses in the safe direction when unsure.
- **A running task cannot be interrupted.** The SDK protocol has no cancel method, so a cancelled
  MCP request or a timed-out task stops being *waited on* while the session keeps running inside
  Harness, and its later notifications are ignored.
- **The platform temporary area is writable by design.** `/tmp` and friends are not denied by
  `workspace-write`; the wall is around the workspace root, not around every path outside it.
- **The service needs a local Ollama serving the pinned model.** The route is registered by the
  profile, so a missing daemon or model surfaces as a worker-turn error rather than a startup error.
  To serve a different model, edit `profiles/flash-service/cordis.patch.yml` and reinstall.
- **No failure/no-progress cap in the gauntlet.** Ralph's shipped loop is used as-is: a failed round
  ends the run, and a loop that keeps reporting `continue` is bounded by `maxRounds` alone.
- **Continuable children are not available over `flash`** (by design — see the contract).
- **Per-call model selection is not wired for `flash`.** The `subagent-model-selection` host setting
  exists but is disabled; enabling it would have no effect on `flash` rows, whose routing is fixed.
  `install.mjs` prints the settings snippet for the generic `spawn` provider.
- **Machine-wide patch layers still apply.** Rows from `$DSH_HOME/cordis.patch.yml` reach this
  profile too — in the authoring session an MCP client row there added `mcp__memorix__*` tools to
  both the orchestrator and the workers. The service profile does not disable machine-wide rows;
  it only governs what it composes.
- **The MCP server is a local stdio process.** It is not a network service, has no authentication of
  its own, and trusts the client that spawned it; the confinement that matters is the Harness
  sandbox behind it.
