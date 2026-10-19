---
name: setup
description: Check and finish the Flash Agents prerequisites — the harness, Ollama, the model, and the service profiles — then prove the pipeline with one real worker task.
disable-model-invocation: true
---

# Flash Agents setup

Run this once after installing the plugin. It is manual-only on purpose: it installs
software and writes profiles into `$DSH_HOME`, which nobody should trigger by accident.

Work through the steps in order and **stop at the first one that cannot be fixed**,
reporting what is missing. Do not silently skip a failing step.

## 1. Ask the doctor first

```sh
node "${CLAUDE_PLUGIN_ROOT}/packages/flash-mcp/lib/index.js" doctor
```

Every line is a check; every failure prints the command that repairs it. If all checks
pass, skip to step 5. Otherwise fix them in the order below — later checks depend on
earlier ones.

## 2. The harness

Flash Agents does not reimplement agent machinery; it composes DeepSeek Harness, which
must be installed separately:

```sh
npm i -g @deepseek-ai/dsh@0.2.0-rc.2
dsh --version
```

Install exactly this version, not `@latest`: the harness is pre-1.0, a new release may
rename the rows the profiles patch, and the doctor fails on a harness from another
release line. The version lives in `dsh.version` in `flash.config.json`.

Node 22.19 or newer is required (24.2 or newer on the 24 line). On an older Node, `dsh`
prints nothing and exits 0, so `dsh --version` printing nothing means Node is too old.

## 3. Ollama and a model

Ollama is the only hard model prerequisite. Install it from https://ollama.com, then:

```sh
ollama serve                              # unless it already runs as a service
ollama pull deepseek-v4.1-flash:cloud     # a ':cloud' model also needs: ollama signin
```

Any model the local Ollama serves will do — set the plugin's **Worker model** setting, or
`route.model` in `flash.config.json`, to something else if you prefer a fully local one.
Expect more variance from smaller models: they are weaker at tool calling, which shows up
as workers that do not delegate or do not finish.

## 4. The service profiles

```sh
node "${CLAUDE_PLUGIN_ROOT}/install.mjs"
```

This renders two profiles into `$DSH_HOME/profiles` — the writing service and its
read-only twin — from `flash.config.json`. Re-run it after changing that file. Then
confirm with the doctor again; the `profile` check must pass.

## 5. Prove it end to end

Let the doctor run one real worker task in a throwaway repository it creates and deletes, so
nothing touches the user's project or another session's uncommitted work:

```sh
node "${CLAUDE_PLUGIN_ROOT}/packages/flash-mcp/lib/index.js" doctor --e2e
```

It asks a worker to create `flash-hello.txt` containing `it works`, and passes when the worker
ended `ok` on the configured model, the patch holds exactly that file, and the temporary
repository itself was not touched — the work happened in a disposable copy. Report those lines,
the duration and the token count to the user.

If it reports `NOT_DELEGATED`, say so plainly: the cheap dispatcher occasionally does the work
itself instead of delegating, the call is discarded rather than trusted, and re-running usually
succeeds.

Then show what a copy of the user's own project costs:

```sh
node "${CLAUDE_PLUGIN_ROOT}/packages/flash-mcp/lib/index.js" doctor --copy --root "$CLAUDE_PROJECT_DIR"
```

It makes one copy the way a writing call would, prints its size, time and what was left out,
and deletes it. If the copy fails, every writing call would fail the same way — report the error.
If it is large or slow, point at the largest entries it lists and at a `.flash-agents.json` in
the project root (`copyExclude`, `slotEnv`; see the README's "Per-repository settings"). `.env`,
`.env.*` and `.mcp.json` are already left out by default.

## 6. Tell them what they have

Close with the tools and two caveats:
- `flash_task` — one coherent task, one worker, a patch back (`taskFile` sends a long brief).
- `flash_batch` — several independent tasks at once, sharing one copy.
- `flash_apply` — land a patch you decided to keep (`threeWay` when the tree moved on).
- `flash_patch` — read a stored patch whole or page by page.
- `background: true` with `flash_status`, `flash_result`, `flash_cancel` — run calls while
  doing other work, and stop one whose framing turned out wrong.
- A running worker cannot be steered mid-task, only cancelled. Point at `--log-file` and
  `scripts/flash-sessions.mjs` for watching, and at the `delegate` skill for the everyday loop
  and `gauntlet` for rounds of competing attempts.
- Workers share the machine: two copies in parallel share ports and per-user services.
