---
name: setup
description: Check and finish the Flash Agents prerequisites — the harness, Ollama, the default and allowed models, and the service profiles — then prove the pipeline with one real worker task.
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

Every line is a check; every failure prints the command that repairs it. The doctor checks the
default model and every model on the allowlist: the default's absence fails, while another one's
absence only warns. A `profile-models` warning means the installed profile predates model choice
and needs the installer rerun (step 4). If all checks pass and `profile-models` is not warning,
skip to step 5. Otherwise fix them in the order below — later checks depend on earlier ones.

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

Any model the local Ollama serves will do. The plugin's **Default worker model** setting (or
`route.model` in `flash.config.json`) is the model a call runs when it names none; the **Models a
call may choose** setting (or `route.models`, or `FLASH_MODELS`) is the comma-separated allowlist for
per-call choice. The default is always allowed, and every listed model must be pulled. Expect more
variance from smaller models: they are weaker at tool calling, which shows up as workers that do
not delegate or do not finish.

A profile installed before 0.1.6 pinned one literal model, so after upgrading from 0.1.5 or older
run the installer once (step 4) before relying on per-call choice.

## 4. The service profiles

```sh
node "${CLAUDE_PLUGIN_ROOT}/install.mjs"
```

This renders two profiles into `$DSH_HOME/profiles` — the writing service and its
read-only twin — from `flash.config.json`. Re-run it after changing that file, and once after
upgrading from 0.1.5 or older: a profile installed before 0.1.6 pins one literal model and cannot
run a per-call choice. Then confirm with the doctor again; the `profile` check must pass, and
`profile-models` must not warn.

## 5. Prove it end to end

Let the doctor run one real worker task in a throwaway repository it creates and deletes, so
nothing touches the user's project or another session's uncommitted work:

```sh
node "${CLAUDE_PLUGIN_ROOT}/packages/flash-mcp/lib/index.js" doctor --e2e
```

It asks a worker to create `flash-hello.txt` containing `it works`, and passes when the worker
ended `ok` on the default model, the patch holds exactly that file, and the temporary repository
itself was not touched — the work happened in a disposable copy. To prove a specific model from the
allowlist, add `--model <id>`: the run then fails if the worker's `route` reports another model.
Report those lines, the duration and the token count to the user.

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
`.env.*` and `.mcp.json` are already left out by default. `slotEnv` takes `"NAME": "value:<text>"`
for a plain value set in every copy — a prebuilt OpenSSL, `RUSTC_WRAPPER` — so briefs need not
repeat it.

## 6. Tell them what they have

Close with the tools and two caveats:
- `flash_task` — one coherent task, one worker, a patch back (`taskFile` sends a long brief).
  Omit `model` for the default, or name one from the allowlist.
- `flash_batch` — several independent tasks at once, sharing one copy and one model.
- `flash_apply` — land a patch you decided to keep (`threeWay` when the tree moved on).
- `flash_patch` — read a stored patch whole or page by page.
- `background: true` with `flash_status`, `flash_result`, `flash_cancel` — run calls while
  doing other work, and stop one whose framing turned out wrong.
- A running worker cannot be steered mid-task, only cancelled. Point at `--log-file` and
  `scripts/flash-sessions.mjs` for watching, and at the `delegate` skill for the everyday loop
  and `gauntlet` for rounds of competing attempts.
- Workers share the machine: two copies in parallel share ports and per-user services.
