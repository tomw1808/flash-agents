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
and needs the installer rerun (step 4), and a `profile-version` warning means the profile is not
installed or came from another release than this server, with `node install.mjs` as the fix. On
Windows, `slot-path-length` warns when the first copy's path is long enough that MSVC's `cl.exe`
and other tools without long-path support may fail, and `state-base-permissions` fails when the
user cannot change permissions under the state base, which stops every shell command in a slot;
step 5 says what to set and which `icacls` line to run. If all checks pass and none of those
warns, skip to step 5. Otherwise fix them in the order below — later checks depend on earlier
ones.

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
read-only twin — from `flash.config.json`. Re-run it after changing that file and after every
plugin update: an update replaces the server but not the guard or the profiles the server runs
with, so the old guard stays in place until the installer rewrites it. It also writes the ESM
`plugins/package.json` stamp into the interactive profile, but only when every `.js` file in that
folder is an ES module; otherwise it leaves the folder alone and its report names the file that
stopped it, because `"type": "module"` there would change how a CommonJS plugin is loaded. Run it
once after upgrading from 0.1.5 or older too: a profile installed before 0.1.6 pins one literal
model and cannot run a per-call choice. Then confirm with the doctor again; `profile` must pass,
and `profile-models` and `profile-version` must not warn. The stamp is re-read by every runtime that
boots after the installer ran, so a `profile-version` warning clears on the next call without a
reconnect; only a runtime that booted before the install keeps the old verdict, and reconnecting is
how that one is replaced.

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
for a plain value set in every copy — `RUSTC_WRAPPER`, `OPENSSL_NO_VENDOR` — so briefs need not
repeat it; a path only one machine has, a prebuilt OpenSSL for instance, belongs in a git-ignored
`.flash-agents.local.json` beside it, under `platform.win32` when it is that platform's business.
On Windows, if `slot-path-length` warns, the copy's root is already long before the
project's own build folders are added: point the plugin's **Base folder for worker copies** setting
(`state_base`, or `FLASH_STATE_BASE` / `--state-base` for a manual install) at a short absolute
folder such as `C:\fm`. It moves the default copy layout only, and a leading `~` expands. A folder
made directly under `C:\` gives the user modify rights but not the right to change its permissions,
and the sandbox's first step for every shell command then fails (`SetNamedSecurityInfoW failed
(Win32 5)`); grant them once with `icacls "C:\fm" /grant "%USERNAME%:(OI)(CI)F"`, which is also the
fix `doctor`'s `state-base-permissions` row prints.

## 6. Tell them what they have

Close with the tools and two caveats:
- `flash_task` — one coherent task, one worker, a patch back (`taskFile` sends a long brief).
  Omit `model` for the default, or name one from the allowlist.
- `flash_batch` — several independent tasks at once, sharing one copy and one model.
- `flash_apply` — land a patch you decided to keep (`threeWay` when the tree moved on, `files` when
  only some of its files should land).
- `flash_patch` — read a stored patch whole or page by page.
- `background: true` with `flash_status`, `flash_result`, `flash_cancel` — run calls while
  doing other work, and stop one whose framing turned out wrong.
- A running worker cannot be steered mid-task, only cancelled. Point at `--log-file` and
  `scripts/flash-sessions.mjs` for watching, and at the `delegate` skill for the everyday loop
  and `gauntlet` for rounds of competing attempts.
- Workers share the machine: two copies in parallel share ports and per-user services.
