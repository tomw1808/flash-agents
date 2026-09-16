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
npm i -g @deepseek-ai/dsh
dsh --version
```

Node 20 or newer is required. The doctor names the minimum harness version, and warns
rather than fails when the installed one is older.

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

Ask for one small, real task in a repository you do not mind a patch against, using the
`flash_task` tool with `apply: "none"`:

> Create a file `flash-hello.txt` containing the line `it works`, then read it back.

Then report to the user:
- the worker's `status` and observed `route` (it must be the configured model);
- `change.filesChanged` and `change.diffstat` — the machine-generated summary, not the
  worker's prose;
- that the file does **not** exist in their repository, because the work happened in a
  disposable copy;
- the `change.patchId`, and that `flash_apply { patchId }` is what would land it.

If `flash_task` reports `NOT_DELEGATED`, say so plainly: the cheap dispatcher occasionally
does the work itself instead of delegating, the call is discarded rather than trusted, and
re-running usually succeeds.

## 6. Tell them what they have

Close with the three doors and one caveat:
- `flash_task` — one narrow task, one worker, a patch back.
- `flash_batch` — several independent tasks at once, sharing one copy.
- `flash_apply` — land a patch you decided to keep.
- Workers cannot be steered mid-task: the harness protocol has no attach or cancel. Point
  at `--log-file` and `scripts/flash-sessions.mjs` for watching, and at the `gauntlet`
  skill for running rounds of competing attempts.
