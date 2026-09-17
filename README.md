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
packages/dsh-flash-guard/           the deterministic wall (`tools/execute` wrapper)
  lib/index.js                      pure classifiers + one wrapper, zero imports
  test/index.test.mjs               19 tests, run with `node --test` (includes the bypass corpus)
packages/flash-mcp/                 MCP stdio server + SDK JSON-RPC client half
  lib/mcp.js                        minimal MCP stdio server: framing, initialize, tools, cancel
  lib/sdk.js                        client for one persistent `dsh` child over the shipped SDK protocol
  lib/service.js                    flash_task: fresh session per call, compact result, cwd fence
  lib/isolation.js                  disposable copies, patch provenance, and apply
  lib/config.js                     the one source of truth: route, limits, guard lists
  lib/doctor.js                     prerequisite checks, each with the command that fixes it
  lib/index.js                      CLI entry, tool contract, lifecycle
  test/mcp.test.mjs                 protocol-level server tests
  test/service.test.mjs             service tests against a fake runtime
  test/isolation.test.mjs            isolation against real git, real copies, real patches
  test/config.test.mjs               the configuration contract: merge, validate, freeze
  test/doctor.test.mjs               every prerequisite check, with injected effects
  test/cli.test.mjs                  where defaults come from, and what `doctor` reports
  test/integration.test.mjs         MCP → SDK → stand-in Harness, whole pipeline, no LLM
  test-support/fake-dsh.mjs         the stand-in Harness process (outside `test/`, so it is never collected)
  scripts/verify-live.mjs           live end-to-end verification through the official MCP client
  scripts/flash-sessions.mjs        list the worker sessions Harness persisted, newest first
  scripts/flash-drive.mjs           drive this server from a shell: the self-test loop
presets/flash-orchestrator/         interactive agent preset (repo is the source of truth)
  agent.cordis.yml                  17 rows: identity, shell, fs, jobs, skills, goals,
                                    compaction, delegation, remaining tools
  preset.yml                        roster metadata
profiles/flash-service/             the headless SDK profile behind `flash-mcp`
  cordis.patch.yml                  route, permissions, disabled competitors, provider, tool
  package.json / cordis.yml / pnpm-workspace.yaml
install.mjs                         idempotent installer / uninstaller
package.json                        `npm test` / `npm run verify` entry points
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

### The skills

The plugin ships three skills, each a way of working rather than a tool:

| Skill | Use it when |
|---|---|
| `/flash-agents:delegate` | The default. A goal should be done by flash workers instead of Claude subagents: it frames, slices, dispatches, verifies every result, reviews with a read-only worker, and fixes in rounds until a review finds nothing real. Also loads on "use flash-agents" or "fan out". |
| `/flash-agents:gauntlet` | Several genuinely different approaches are plausible and the result can be checked by running something: parallel builders, cheap critics, a blind duel. Costs the orchestrator more; the judge is a frontier-model step. |
| `/flash-agents:setup` | Once, after installing: checks the harness, Ollama, the model and the profiles, and proves the pipeline with one real task. Manual-only. |

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

Three doors, and nothing else:

| Tool | Required | Purpose |
|---|---|---|
| `flash_task` | `task`, `cwd` | one self-contained task on one worker |
| `flash_batch` | `tasks` | a fleet the caller has already split, one worker per task |
| `flash_apply` | `patchId` | put the change an earlier call produced into the workspace (`dryRun?`, `force?`) |

Optional on `flash_task` / `flash_batch`: `acceptance` (one string, or per task in `flash_batch`),
`cwd`, `mode` (`workspace-write` — the default — or `read-only`), and `apply` (`none` — the default —
or `auto`). There is no model, provider, effort, or permission parameter: the route is not a caller
capability, and neither is the sandbox. Unknown arguments are ignored rather than forwarded.

A writing call does not run in your repository. It runs in a **disposable copy** of it and returns the
change it made; `apply: "auto"` applies that change before returning, and `flash_apply { patchId }`
applies it later. See [Isolation](#isolation-the-worker-gets-a-tree-it-may-wreck).

`flash_task { task, cwd, acceptance?, mode?, apply? }` returns one worker's outcome:

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
  "runtime": { "pid": 98476, "booted": true, "uptimeMs": 13323, "sessions": 1, "profile": "flash-service" },
  "isolation": { "mode": "copy", "slot": 0 },
  "change": {
    "available": true,
    "filesChanged": ["flash-mcp-probe.txt"],
    "diffstat": " flash-mcp-probe.txt | 1 +\n 1 file changed, 1 insertion(+)",
    "diff": "diff --git a/flash-mcp-probe.txt …",
    "diffTruncated": false,
    "applied": false,
    "patchId": "flash-9d1c…"
  }
}
```

- `change` is computed by the service from the copy, not reported by the worker: `filesChanged` comes
  from `git diff --name-status`, `diffstat` from `--stat`, and `diff` is the patch itself (clipped to
  `--diff-chars`, with `diffTruncated` saying whether it was). A worker's own account of what it did
  is in `result` and is **not** evidence that it did it.
- Without git in the root the copy still isolates, but there is no diff to compute: `change.available`
  is `false` and `change.reason` says why.
- `isolation.mode` is `copy` for a writing call and `none` for a `read-only` call (which cannot write,
  and therefore reads your real tree instead of a copy of it).

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
| catastrophic | `rm`/`rmdir` of `/`, a top-level directory, a home, the service root or an ancestor, a bare glob at the root; an unbounded `find … -delete` or `find … -exec rm`; anything piped into `xargs rm`; redirects into a protected target; `git reset --hard`, `git clean -fdx`, `git push --force`, `git checkout -- .` | — | denied |
| the fence | **any** mutation naming a path outside the workspace: a deletion, a command-line write destination (`cp`, `mv`, `install`, `ln`, `rsync`, `tee`, `sed -i`, `dd of=`), or a redirect — device targets such as `/dev/null` excepted | allowed | denied |
| the fence's code | the fence reports `OUTSIDE_WORKSPACE`, not `CRITICAL_PATH`: `> /tmp/out.log` and `rm -rf /` are both refused, and a caller branching on the code can tell them apart | — | — |

The fence is the newest rule and the one a live run earned. The sandbox confines writes to the
workspace *plus* the platform's temporary areas, so with the workspace itself under `TMPDIR` a worker
deleted a file in the caller's tree by naming its absolute path — the sandbox allowed it, and the
path was neither a secret, nor repository state, nor adjacent to the root, so nothing refused it. Now
a mutation outside the workspace is refused however it is spelled, and reads stay open: a worker may
still read `/etc/hosts`, `/usr/share/doc`, or a shared cache.

A denied call never runs: the wrapper returns an `isError` result instead of calling `next()`, and
carries `error.info.code = "FLASH_GUARD_DENIED"` with a reason (`PROTECTED_SECRET`,
`PROTECTED_STATE`, `CRITICAL_PATH`, `OUTSIDE_WORKSPACE`, `DESTRUCTIVE_GIT`). Those refusals are
attributed back to the task that caused them in `results[i].denials`:

```json
"denials": [{ "index": 0, "childSessionId": "42bd62ef-…", "code": "FLASH_GUARD_DENIED",
              "reason": "PROTECTED_STATE", "message": "Error: flash-guard denied write (PROTECTED_STATE): .git holds repository state…" }]
```

It is a **circuit breaker, not a sandbox**: the file and shell sandboxes remain the enforcement
boundary, and it makes no claim about the rest of the shell language. `fenceMutations: false` in a
profile's `flash-guard.config` turns the fence off where an agent works in more than one tree and the
sandbox is trusted to be the whole story; the service profile leaves it on. It refuses in the safe
direction — a command that merely *mentions* a secret path is denied too — so treat a denial as
"ask the caller", not "the command was necessarily malicious". Protected lists are composed in the
profile (`flash-guard.config`), so a deployment can widen or narrow them there.

A note on approval prompts: the one you see belongs to the **launcher**, not to a worker.
When a session runs this repo's installer or a live stage, the harness asks you to allow that
*command* wider filesystem access — that grant widens the command, and says nothing about what the
workers inside it will do. Workers never prompt anyone: this profile answers `never`, and deleting
something inside the service root needs no approval from the sandbox. That is exactly why the wall
has to be the gate for worker behaviour, why it is deterministic rather than a model call, and why
the live proof below treats it as the load-bearing part.

**3. Read-only, per call** — `mode: "read-only"` runs the call in a second, lazily-booted process
whose profile (`flash-service-readonly`, generated by `install.mjs` as this repo's flash-service
composition with exactly one change: `sandbox-policy.mode: read-only`) denies every mutation at the
sandbox. Nothing can widen the standing profile: unknown modes are refused with `MODE_UNAVAILABLE`.

### Isolation: the worker gets a tree it may wreck

The wall is a denylist over an open language, and a denylist over an open language is never finished —
`rm -rf "$(pwd)"`, `bash -c "…"`, inline interpreter code, `mv . /tmp` and a dozen other spellings all
had to be added after the fact. Isolation removes the premise instead:

1. a writing call leases a **disposable copy** of the root (a copy-on-write clone where the
   filesystem supports one, so an ordinary repository costs milliseconds and no space);
2. the runtime that serves the call is rooted *there*, so the sandbox confines the worker to a tree
   nobody needs;
3. afterwards the service computes what changed in the copy — `filesChanged`, `diffstat`, and the
   patch itself — and returns that instead of the worker's account of itself;
4. nothing reaches your repository until a patch is **applied**, by `apply: "auto"` on the call or by
   `flash_apply { patchId }` afterwards.

The copy includes `.git` and your uncommitted work, because a worker that sees the last commit
instead of your working tree is useless while you are mid-edit. `rm -rf` of everything the worker can
reach destroys a throwaway copy and shows up as a patch that deletes files — which you then decline
to apply.

| Flag | Default | Meaning |
|---|---|---|
| `--isolate copy` | ✓ | writing calls run in a disposable copy |
| `--isolate none` | | workers write to the root directly; the wall is the only defence |
| `--slots <n>` | 2 | how many copies may be in flight; each one is a runtime process |
| `--state-dir <path>` | private to this root and process | where copies and returned patches live |
| `--diff-chars <n>` | 20000 | how much of a patch a result carries |
| `--log-file <path>` | unset | append every diagnostic line, timestamped, to a file as well as stderr |

The state directory is keyed by root, by process, and by pool:

```
$TMPDIR/flash-mcp/<sha256(root)[0:12]>/<pid>/<pool>
```

A *shared* default was a data-loss bug: a second service deleted the first one's in-flight tree
and then handed the same path to a different worker, so one call's patch could carry another
call's work. A configured `--state-dir` is used as given — persistence across a restart, at the
cost of the deployment owning that guarantee (one service per directory). Trees belonging to
processes that no longer exist are swept at startup; a live service's trees never are.

Patches sit one level above that, in `<sha256(root)[0:12]>/patches`, precisely because the sweep
reclaims a dead owner's directory whole: a self-test lost a finished worker's patch that way when
the next service started on the same root. A patch therefore outlives the process that issued it,
and a later service on the same root can still apply it — at the cost of accumulating until you
delete them.

A patch is more than a file. Each one is stored with a record — the root it was computed for, the
base commit, the files it touches, and whether it has been applied — and `flash_apply` refuses:

- an id that is not the shape this service issues (`flash-<uuid>`), because the id is used to
  build a path and `../` used to reach any `.patch` on disk;
- a patch computed for a **different root**, because that is not a merge, it is a different edit
  to different files, landing one caller's work in another caller's tree;
- a patch whose record says it was **already applied**, unless the caller passes `force: true`.
  Recording the apply is what makes this a rule instead of a coincidence: `git apply` can find a
  second place to put the same change when the surrounding lines repeat elsewhere in the file.

Honest limits of this design:

- A **fleet is one call, so it is one copy**: its members share a working directory and therefore see
  each other's edits. Per-member trees would need a runtime per member, which the engine's design
  (one session per run) does not allow.
- The runtime is rooted at the **tree**, never at a subdirectory of it, even when the call names one:
  the sandbox root is fixed when a process starts, so keying a runtime on the requested `cwd` started
  one process per distinct directory and none of them ever exited. The subdirectory reaches the worker
  in the prompt instead, and one tree is one process.
- Each copy carries a scratch directory, `.flash-tmp/`, excluded from the diff through the copy's own
  `.git/info/exclude`; the worker is told about it in its prompt. It is deliberately **not** handed
  over through `TMPDIR`: the Harness derives the sandbox's writable roots from the runtime's own
  `TMPDIR`, so pointing that into the tree withdrew the platform temp area from the grant, and every
  toolchain that reaches it directly — `swift build` does, through `confstr` — failed with `EPERM`
  inside its own scratch files while `touch` in the same directory succeeded.
- A call that runs out of budget **still reports what its tree held**: the change so far is stored as
  a patch, any tool refusals seen are named, and the tree is retired rather than recycled — the SDK
  has no cancel, so the orphaned session may still be writing, and the next call must not inherit
  that as its own work.
- A call that is waiting for a tree is **bounded by its own budget and cancellable**: it used to queue,
  take a tree, copy the repository, and only then notice that nobody was waiting for the answer.
- A `read-only` call is deliberately **not** isolated: it cannot write anything, and running it in
  your real tree means it reads your current state rather than a copy's.
- A **non-git root** is still isolated, but there is no diff to compute, so there is no verdict — only
  the worker's report.
- Without copy-on-write the copy is a real copy and costs real time and space per call, and
  `--slots 1` bounds it. The clone is attempted with the platform's own spelling — `cp -cR` on macOS,
  `cp --reflink=always -R` on Linux — and the fallback is reported as `copy`, not silently as a clone.
- `apply` writes the patch with `git apply` (or `patch -p1` when the root is not a repository) into
  the working tree, leaving your index alone. A patch that no longer applies is reported as an error
  naming the kept patch file, so a conflict is never lost work.
- `--isolate none` exists for debugging the wall. With it, point `--root` at something you are willing
  to lose: the wall protects `.git` and secrets, but it does not protect your uncommitted source.

### Configuration

`flash.config.json` at the repository root owns the route, the numeric limits, and the
guard's protected lists. It is the one file to edit: the CLI takes its defaults from there,
and `lib/config.js` validates it, so an unknown key or a mistyped value fails at startup
naming the path that is wrong instead of silently falling back to something else.

```json
{
  "route": { "provider": "ollama", "model": "deepseek-v4.1-flash:cloud" },
  "limits": { "slots": 2, "maxTasks": 16, "taskTimeoutMs": 3600000, "diffChars": 20000 },
  "guard": { "protectedSegments": [".git"], "fenceMutations": true },
  "dsh": { "package": "@deepseek-ai/dsh", "minVersion": "0.1.5" }
}
```

**Another model needs no code change.** Set `route.model` — or `FLASH_SERVICE_MODEL` — to
anything the local Ollama serves; only Ollama itself is a hard prerequisite. Smaller local
models are weaker at tool calling, so expect more variance and more `NOT_DELEGATED` calls
than the pinned default. Support for other providers is a welcome pull request, not a
shipped feature.

### Prerequisites

```sh
node packages/flash-mcp/lib/index.js doctor
```

One line per check — Node, `dsh` and its version, the service profile composing, the Ollama
daemon, the configured model, `git`, and `zstd` — followed by the exact command that repairs
anything broken. A warning (an old `dsh`, a missing `zstd`, which only session reading needs)
does not fail the run; a real failure exits non-zero, so `doctor` doubles as a setup gate in
a script or in CI.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `FLASH_SERVICE_ROOT` | cwd | sandbox root, runtime working directory, `cwd` fence |
| `FLASH_SERVICE_PROFILE` | `flash-service` | profile the runtime boots |
| `FLASH_SERVICE_PROVIDER` / `FLASH_SERVICE_MODEL` | `ollama` / `deepseek-v4.1-flash:cloud` | pinned orchestrator route (the worker route is pinned by the profile) |
| `FLASH_TASK_TIMEOUT_MS` | `3600000` | per-task wall-clock budget; a coherent feature slice that builds and tests between steps takes real minutes per cycle, and the call returns as soon as the worker finishes |
| `FLASH_RESULT_MAX_CHARS` | `8000` | returned worker-message budget |
| `FLASH_MAX_TOKENS` | unset | optional output cap for SDK agents |
| `FLASH_BATCH_TIMEOUT_MS` | `10800000` | per-fleet wall-clock budget |
| `FLASH_MAX_TASKS` | `16` | ceiling on tasks in one `flash_batch` call |
| `FLASH_PER_ITEM_CHARS` | `4000` | returned per-worker budget inside a fleet |
| `FLASH_LOG_FILE` | unset | file the diagnostics are appended to, timestamped, as well as stderr |
| `FLASH_DSH_BIN` | `dsh` on `PATH` | the launcher to spawn (a `.js` path runs under the current Node) |

### Observing a run

The runtime is a separate, headless process, so nothing about a worker appears in your own session.
Two surfaces make a run watchable.

**While it runs** — `--log-file` (or `FLASH_LOG_FILE`) appends every diagnostic line to a file as well
as stderr, so a run can be followed from another terminal:

```sh
claude mcp add flash -- node …/flash-mcp/lib/index.js --root <workspace> --log-file /tmp/flash.log
tail -f /tmp/flash.log
```

Each line carries an ISO timestamp: runtime boot, session per call, child started, the observed route,
each tool call and result, every guard denial, and the collected change.

**Afterwards** — worker sessions are durable, in the same store the interactive surfaces use
(`$DSH_HOME/sessions/<workspace-key>/<sessionId>/session.v3.jsonl.zstd`, one JSON event per line).
`scripts/flash-sessions.mjs` lists them without guessing at the key:

```sh
node packages/flash-mcp/scripts/flash-sessions.mjs --limit 5          # newest first: time, id, cwd
node packages/flash-mcp/scripts/flash-sessions.mjs --under "$TMPDIR/flash-mcp" --json
zstd -dc <file> | jq -c '{type,seq}'                                  # the full event log
```

Note what the `cwd` column shows: with isolation on, a worker's workspace is a disposable copy, so its
sessions are filed under that copy's path, which changes per service. A fixed `--state-dir` makes those
keys stable and browsable, and `dsh --profile web` started in a slot directory will list them in the
GUI's own session history.

What neither surface offers is *intervention*: the SDK protocol has `initialize`, `session/prompt` and
`shutdown` and no attach or cancel, so a worker can be watched but not steered. Driving the
`flash-orchestrator` preset inside `dsh web` is the surface for that.

## Verify

```sh
npm test                                        # all three suites: 146 tests, no LLM
node --test packages/flash-mcp/test/            # 105 protocol, service, config, doctor, CLI, isolation, pipeline, fleet tests
node --test packages/dsh-flash-guard/test/      # 19 wall tests
node --test packages/dsh-subagent-flash/test/   # 22 provider contract tests
npm run verify                                  # live end-to-end, needs Ollama and a profile boot
npm run drive -- --root <dir> --task-file <f>   # hand one task to a real worker from a shell
```

`npm test` names the three `test/` directories on purpose. The stand-in Harness lives in
`test-support/` and the live suite in `scripts/` so that neither is ever collected as a test file —
it used to be possible to hang the suite for five minutes by running `node --test` bare.

`npm run verify` runs every stage against a **throwaway copy-on-write snapshot of this repository**
(including `.git`, and including uncommitted edits), because these stages ask workers with bash to
write files and one of them asks a worker to delete its workspace on purpose. `--root <dir>` overrides
that and warns loudly first. The workspace snapshot is removed afterwards; the `guard` stage keeps its
own separate decoy root on top of that.

The pipeline tests run a stand-in Harness process, so MCP framing, lazy boot, process reuse,
session-per-call, route observation, and result projection are covered without an LLM. `verify-live`
drives the real thing through the **official `@modelcontextprotocol/sdk` client** — a different
implementation of the protocol the target agent speaks — and prints one line per check.

### What was verified live

`npm run verify` → **92/92 checks**, from a real MCP client over real stdio, against real
`dsh --profile flash-service` and `flash-service-readonly` runtimes:

| Stage | Checks | What it establishes |
|---|---|---|
| `boot` | 8 | the server identifies itself, exposes the task/fleet/apply doors, offers **no model-selection property**, and defaults to applying nothing |
| `lazy` | 1 | no runtime process exists before the first call |
| `task` | 17 | a real worker writes and reads a repo-local file **without interactive approval**, the file is **not** in the caller's tree, the change comes back as a patch holding the worker's own line, `flash_apply` puts it there, and a second apply is refused |
| `route` | 2 | the worker ran `ollama/deepseek-v4.1-flash:cloud` under `provider: flash` |
| `hostile` | 2 | caller-supplied `provider`/`model`/`agentOptions` cannot change the child route and are not echoed |
| `reuse` | 6 | one process, one handshake, same pid across calls, a fresh orchestration **and** worker session per call |
| `local` | 2 | a repo-local command runs unattended, and the worker's reported output is real |
| `batch` | 13 | a pre-split fleet runs one worker per task, in parallel, on the pinned route, paired back in task order with each member's session and a `runId`; the fleet writes nothing into the caller's tree, and one applied patch materialises all three files |
| `isolation` | 10 | a worker told to delete its workspace's Markdown files really does delete them — **in the copy** — and the deletions arrive as a patch while the caller's README and sentinel survive; a worker told to delete the caller's file *by absolute path* fails; a dry run still changes nothing |
| `guard` | 18 | the wall refuses `.git` writes, a redirect into `.git`, and a secret read; **`rm -rf <service root>` and `rm -rf *` are stopped with `CRITICAL_PATH`**; an ordinary `rm -rf <scratch>` inside the root still runs; every denial comes back structured (`code`, `reason`) and attributed per task |
| `readonly` | 7 | `mode: "read-only"` runs the call in its own process on the generated profile, the write is denied by the sandbox, reads still work, the call is **not** isolated, and an unknown mode is refused |
| `fence` | 2 | a `cwd` outside the root fails closed with the confinement named |
| `escape` | 4 | a write outside the workspace is refused with `OUTSIDE_WORKSPACE`, and the file never appears |

Two stages are worth reading twice. The `isolation` stage runs with isolation **on** and asks a worker
to destroy everything it can reach; the assertion is that the caller's files are still there and that
the destruction is merely a patch the script declines to apply. The `guard` stage runs with isolation
deliberately **off**, against a **throwaway decoy root**: it is about what the wall does on its own,
and a disposable copy would make a wall regression invisible there — the decoy would survive for the
wrong reason. A wall regression costs a temp directory and fails a check; the repository this script
was pointed at is outside the blast radius by construction. That stage also reports *how* each
critical command was stopped — by the wall (a `CRITICAL_PATH` denial) or by the worker declining —
rather than assuming either, because a model cannot be relied upon to attempt a deletion on cue.

The `escape` stage's target is deliberately *not* under `/tmp`, and that is not a style choice: the
sandbox permits writes to the platform's temporary area, and an earlier run of the `isolation` stage
deleted a file in the caller's tree through an absolute path under `TMPDIR` — allowed by the sandbox,
because the copy and the root both happened to live there. The wall's fence rule is what closed that
hole, and this stage is where it stays closed.

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
- **A destructive test may not own anything it can destroy.** The live guard proof asks a worker to
  delete its workspace on purpose, so that workspace is a throwaway directory this script creates,
  served by its own `flash-mcp` instance — never the repository the caller passed in. This is not
  hypothetical: an earlier revision of this stage pointed a worker at the real root, and a guard gap
  let it delete the whole repository. A wall regression now destroys a temp directory and fails a
  check, and the caller's tree is outside the blast radius by construction.
- **The wall falls back to the process cwd.** Agents created by the workflow engine — every fleet
  member — carry no `meta.cwd`, so a rule that depends on the agent's own cwd silently stops
  applying exactly where it matters most. The seam therefore uses the agent's cwd when it has one
  and the process cwd otherwise, which the SDK has already set to the service root.
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
- **An approval you grant a launcher is not a policy for workers.** Escalations widen one command's
  filesystem access; they do not travel into the harness child, whose workers run under the service
  profile's own standing policy. Nothing a worker does can reach you as a prompt, by design — so
  treat the wall, not the approval, as the gate on worker behaviour.
- **The wall parses shell, imperfectly.** It recognises `rm`/`rmdir`/`shred`, unbounded `find`
  deletion, `xargs rm`, destructive `git`, redirects, and secret references, including inside inline
  interpreter code. It does not chase a secret piped through an interpreter variable, a program that
  writes in a shape it has never seen, or a deletion staged through a language runtime. It refuses in
  the safe direction when unsure, and the file and shell sandboxes remain the enforcement boundary.
- **A pattern-narrowed deletion is allowed on purpose.** `find . -name '*.log' -delete` is ordinary
  cleanup; `find . -delete` and `find . -type f -delete` are not, because nothing bounds what they
  reach. If you would rather refuse every deletion that does not name its targets with `rm`, narrow
  `FIND_NARROWING` in the row's source — but expect more denials, not fewer.
- **A running task cannot be interrupted.** The SDK protocol has no cancel method, so a cancelled
  MCP request or a timed-out task stops being *waited on* while the session keeps running inside
  Harness, and its later notifications are ignored.
- **The platform temporary area is writable by design.** `/tmp` and friends are not denied by
  `workspace-write`, and that is not theoretical: a live run deleted a file in the caller's tree
  through an absolute path under `TMPDIR` while the sandbox allowed it. The wall's fence rule
  (`fenceMutations`, on in the service profile) is what refuses a mutation outside the workspace now;
  the sandbox alone is not that boundary.
- **The fence is on by default and cannot be narrowed per call.** It is a standing profile rule, like
  every other one, so a worker cannot talk its way out of it — and a deployment that genuinely needs
  an agent writing across several trees has to turn it off in `flash-guard.config`
  (`fenceMutations: false`) rather than per call.
- **Work that git ignores is reported, not carried.** The patch is computed with `git diff`, so a file
  your `.gitignore` excludes never reaches `apply`: the result names it under `change.ignored` and
  warns, which turns a misleading "no change" into an explicit one, but the patch is still not a
  filesystem diff.
- **A patch applies to the working tree, not to your index.** `git apply` without `--index` leaves
  staging alone, so a partially-staged file can make an otherwise clean patch conflict; the patch file
  is kept and named in the error when that happens.
- **Patches outlive the service, and are never swept.** They live per root rather than per process, so
  a restarted server — or the next one on the same root — can still apply an id it did not issue. The
  copies are reclaimed, the patches are not: they accumulate under
  `$TMPDIR/flash-mcp/<sha256(root)[0:12]>/patches` until you delete them. With a configured
  `--state-dir` they stay in `<dir>/calls`, one service per directory.
- **The service needs a local Ollama serving the pinned model.** The route is registered by the
  profile, so a missing daemon or model surfaces as a worker-turn error rather than a startup error.
- **The dispatcher is a model, and it occasionally does the work itself.** A cheap model reads the
  dispatch prompt ("call `flash` exactly once") most of the time, but not always: a live run had the
  orchestrator run `find . -name '*.md' -delete` itself instead of delegating. That is caught — the
  call fails with `NOT_DELEGATED` and names what it did instead, and nothing of it reaches the caller,
  because the change is never collected — but the call is wasted, and the failure is variance rather
  than a rule. Structurally it cannot be fixed by a profile flag: `tools.restrict()` refuses a
  context-global filter on purpose, so the fix is to remove the dispatcher, not to police it. That is
  the next slice.
- **A cancelled call that is mid-flight is not interrupted.** Cancellation now stops a call that is
  *waiting for a tree* (and it never copies the repository), but once a worker is running, the SDK has
  no cancel method — the session finishes inside Harness and its notifications are ignored.
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
