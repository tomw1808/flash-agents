# Flash Agents

<p align="center">
  <em>Claude is your tech lead. Stop paying a tech lead to type.</em>
</p>

<p align="center">
  <strong>Claude plans, briefs and reviews. Cheap flash models read and type, each in a throwaway copy of your repo.<br>
  Nothing lands until Claude has read the diff.</strong>
</p>

---

A good tech lead doesn't write every line. They cut the work into pieces, brief the team, and read
every pull request. That's where their hours are worth the most.

Claude Code works the other way round. Your most expensive model reads 40 files to find one seam,
types 1,200 lines of adapter and tests, reruns the suite, and your plan runs out by lunchtime.
Subagents don't help: they spend the same budget.

**Flash Agents gives Claude a team.** Claude writes the brief. A flash model does the work:
DeepSeek V4.1 Flash by default, at $0.30 per million input tokens on Ollama. Claude reads the
diff, runs your tests, and applies only what it accepts.

## The receipt

Flash Agents built its own 0.1.6 release (20 October 2026):

- Claude wrote the design and briefed **3 workers** on DeepSeek V4.1 Flash.
- Claude's review **caught a race condition**. A 4th worker fixed it.
- **25 files, +2,011 lines, 116/116 live checks**, 78 minutes from first hand-off to commit.
- What the workers' tokens cost: **under $0.50.**

Claude's own tokens for the design and the review aren't in that number.

## Why I built this

I saw DeepSeek's prices on Ollama, which says it never trains on your prompts. I wanted Claude's
judgement without paying Claude prices for keystrokes.

Now I use it every day as CTO of a fintech. More gets shipped, and tests and review are held to
the same bar as before.

## How it works

1. **Claude briefs.** One goal per hand-off: the files it owns, the tests to write, the exact
   commands that prove it works. The `delegate` skill teaches Claude this loop, so you just ask
   for the change as usual.
2. **A worker does it, in a copy.** Every writing job runs in a throwaway copy of your repo,
   inside a sandbox that stops at the copy's edge. A worker that runs `rm -rf .` deletes a copy.
   Claude picks the model per hand-off from your list (DeepSeek V4.1 Flash, MiniMax M3.1 Flash, …)
   and can run several workers at once.
3. **Claude checks.** The patch and the file list come from `git`, not from the worker's story.
   Claude reads the diff, runs your tests, can have it reviewed by a second worker, and applies
   what passes. Uncommitted: committing stays your call.

## What it really handled

On a 50k-line Swift app, with Claude steering and reviewing:

| Task | Size | Time | Outcome |
|---|---|---|---|
| A new seam: protocol, adapter, fake, wired into two coordinators | 1,250 lines, 15 tests | 30 min | landed; one warning fixed by hand |
| Security fix round, 11 findings, each with a test that fails before the fix | 1,400 lines | 40 min | landed; review still found one flow defect |
| Test-harness rework | 1,500 lines, 29 tests | 37 min | landed unchanged |
| A 7,000-line file split into 16, 41 scripts re-pointed | 7,900 lines moved | ~60 min | complete |

## What I won't hide

- **A flash model's diff is good; its picture of the whole system is not.** It misses flow across
  a boundary and the nuance of a policy. That's why Claude still reads the core of every change.
- **You need Ollama.** The cloud models run on your Ollama account and are billed by Ollama
  (Pro: $20 a month with $60 of usage). Local Ollama models work too; they're weaker.
- **Windows works, with limits.** The sandbox blocks owner-only temp folders and named pipes,
  so some Python test setups don't run there. Details under [Honest limits](#honest-limits).

## FAQ

**Is a model this cheap any good?**
On its own, no. With a written brief, the files it owns and the commands that prove it, yes.
See the table above. When it stops partway, it says why, and the next hand-off carries on from its patch.

**Why not just use subagents?**
They run on Claude, so they spend your plan. Flash workers run on a different model.

**Where does my code go?**
To the Ollama model you pick, and nowhere else. Ollama: "we process your prompts and responses
transiently to provide the service and never train on it" ([privacy](https://ollama.com/privacy)).
With a local model it stays on your machine.

**Will it commit or push?**
No. A patch lands only when Claude or you apply it, and it lands uncommitted.

**What does it cost?**
The plugin is free and MIT-licensed. The models cost what your Ollama plan charges.

## Install

You need **Claude Code**, **Node 22.19+** (or 24.2+), and **[Ollama](https://ollama.com)**. About five minutes.

**1. Install the worker runtime and the default model**

```sh
npm i -g @deepseek-ai/dsh@0.2.0-rc.2     # DeepSeek Harness, the version the profiles are written for
ollama signin                            # the :cloud model runs on Ollama's cloud, under your account
ollama pull deepseek-v4.1-flash:cloud
```

The default allowlist also names two more models; pull any you want a call to choose from (see
[Configuration](#configuration)).

npm 11 skips dependency install scripts and lists the ones it blocked (`node-pty`,
`@deepseek-ai/dsh-subprocess-local`, `koffi`, `protobufjs`, `@google/genai`). On macOS and the
common Linux and Windows machines that is harmless: `node-pty` ships prebuilt binaries, and the
others are not needed here. The setup's doctor checks the one piece that matters (that `node-pty`
can start a worker's shell) and prints the exact fix if it can't.

**2. Add the plugin in Claude Code**

```
/plugin marketplace add tomw1808/flash-agents
/plugin install flash-agents@flash-agents
```

Restart Claude Code when it asks you to.

**3. Run the setup once**

```
/flash-agents:setup
```

It runs the doctor (Node, `dsh`, Ollama, the default and allowed models, `git`), writes the two
worker profiles into `~/.dsh/profiles` (plus a `flash-orchestrator` preset for dsh's own UI), and
proves the pipeline end to end with one real task. Every failing check
prints the exact command that fixes it.

Run it again after every plugin update: the update replaces the server but not the worker profile or
the guard it runs with, so the installer has to rewrite both. No reconnect is needed afterwards: a
worker runtime started before the install is replaced at its next use (see
[Configuration](#configuration)).

**4. Use it**

```
/flash-agents:delegate add retry with exponential backoff to src/api/client.ts, with tests
```

Or just ask in plain words — "use flash-agents for this", "fan this out". Claude frames the
task, dispatches workers, checks every diff, has a read-only worker review the result, fixes
in rounds, and applies the patches it accepts.

## What you get

| | |
|---|---|
| `flash_task` | One coherent task on one worker. Returns its report and a patch. |
| `flash_batch` | Up to 16 independent tasks in one call, four at a time; results come back in task order. |
| `flash_apply` | Land a patch from an earlier call (`dryRun` to check it first, `threeWay` to merge one whose context moved, `files` to land only some of its files). |
| `flash_patch` | Read a stored patch whole, by file, or page by page — for a diff too long for the result. |
| `flash_status` · `flash_result` · `flash_cancel` | Follow, collect, and stop calls started with `background: true`. |
| `/flash-agents:delegate` | The everyday loop: frame → slice → dispatch → verify → review → fix → apply. |
| `/flash-agents:gauntlet` | Several competing builders, cheap critics, and a blind A/B judged by Claude. For problems with more than one plausible approach and a result you can run. |
| `/flash-agents:setup` | One-time install check and smoke test. |

Pass `mode: "read-only"` (or `readOnly: true`) for reviews and codebase maps: that call runs in a second process whose
sandbox refuses every write — including the writes a build or a test run makes. For a review that
has to build or run tests, use a writing call with `apply: "none"` (the default): it runs in a
throwaway copy and stores what it changed as a patch, so its test files can be applied later — a
review's proof tests become the fix's failing-first tests. Use `apply: "discard"` when nothing is to
be kept: it reports the change and stores nothing.

Pass `background: true` and a call returns at once with a job id, so Claude can run tests or
review an earlier patch while workers run; `flash_result` collects the result (and can wait for
it), `flash_cancel` stops it. `flash_status` lists running jobs first, then the last few that
ended, and for a running one says what its workers are doing: `current` holds each open tool call
(`tool`, `command`, `since`, `runningMs`, as of the last heartbeat) and `warnings` names a command
that failed three or more times in the call. A worker waiting on a backgrounded command shows that
command instead, with `background: <job id>` and the time since the shell call that started it;
every other running background job is listed too, whether or not anyone waits on it. A background
command that ends non-zero counts toward `warnings` like a foreground one. In the listing an ended
job's `lastProgress` keeps only its first line, at most 160 characters; a running job, and a job
asked for by id, keeps the line whole. The warning names the real command after a prefix such as
`nice -n 19` or `timeout 600`, groups spellings of one command (`cargo test 2>&1 | tail -50` and
`cargo test`), quotes the last output line, says when a later run passed, and reads an exit code
above 128 as a signal (`exit 137 = killed by signal 9`). For `bash -c '<script>'`, `sh -c` and
`pwsh -Command`, it names the script's first 60 characters, so two scripts are told apart. When the
brief asks for tests that fail before a fix, those failures are an `info` line, not a warning; only
a shell command can be such a check, so a failed `edit` or `write` keeps the ordinary warning.

Since 0.1.12 `flash_result` also takes `jobIds` (2 to 16 ids, not with `jobId`): with `waitSeconds`
it returns as soon as any one of them ends, with that job's result and `pending` naming the rest;
without it, it returns the first in the list that has already ended, or lists them all as `pending`. An id whose
job the server no longer holds is answered from its stored report; when at least one id is known,
an id with neither a job nor a report is named under `unknown`.

The service also watches each running worker's process tree from outside the sandbox (once a minute,
for every running call, with or without a progress token). `current` names a `child` of an open
command (`child: { command, runningMs, cpuSeconds }`, such as the `cmake` under a `cargo check`):
the deepest idle process of the command's own tree, or its longest-running one while the command is
busy. Sandbox processes such as `bwrap`, `dsh` and the harness runner are never the child, and their
CPU never counts. A command whose own tree used under a second of CPU for five minutes gets a
warning that it may be waiting forever — background commands included, as `<command> (background
job <job id>) sat with no CPU for 5 min` — and a warning raised during the call stays in the result
after the command ends. A call whose worker ends while one of its background commands is still
running says so: `the worker ended while its background command <job id> (<command>) was still
running; the sandbox stopped it, so its outcome is unknown`. The held-open-shell warning of 0.1.11
is gone: the sandbox ends a call's children, so it could not arise. Nothing is stopped for you:
`flash_cancel` keeps the change so far.

A job is labelled with `label` when you pass one (up to 120 characters), else with the brief's first
line, so jobs whose briefs start with the same shared rules still differ in the listing. A
call still waiting for a free copy says where it stands and what it waits behind — `queued 1m10s: 2nd
in line for a free tree (first come, first served); trees held by job-ab12cd34 (fix the parser,
31m0s, idle 6m0s) and a foreground call (review it, 2m0s)` — and `flash_status` carries the same as
`queue: { position, of, holders }`. A holder's `idleMs` is its time since the last heartbeat, and
a holder active within the last minute carries none. A writing call sent without
`background: true` reads `queued in the foreground …`: it holds your turn while it waits, and its
result carries the same warning. A background call checks its
arguments before it answers, so a bad `task`/`taskFile` pair, an unreadable brief, an unknown `mode`
or a `source` a read-only call cannot honour fails the call at once, as a foreground one does.

An argument a tool does not know is refused, with the nearest known name:
`unknown argument "file" for flash_patch; did you mean "files"?`. Before 0.1.10 it was ignored, so
`flash_patch` with `file` returned the first page of the whole patch. `provider`, `reasoningEffort`,
`agentOptions`, `permissions` and `sandbox` were ignored the same way and are refused now too.

A first attempt that ends early with nothing — under three minutes and at most twelve model calls,
nothing delegated or only empty reports, and no change in the copy — is retried once after ten
seconds in the same copy, because that shape is usually a cold runtime rather than a real attempt.
The result carries `retried` (the reason, and the first attempt's session, duration and usage) and a
warning. A slow failure, and any attempt that left a change in the copy, is not retried: that is a
verdict.

A call that ends "ok" but whose final message is no report — empty, or the worker's next tool call
written out as text (`<｜DSML｜ invoke name="edit">`, `invoke name="bash"`) — comes back as
`status: "error"` with `finalMessageProblem: "empty"` or `"tool-call-markup"`. That planned call never
ran, so checks the worker claims may not have run either. The change so far is still stored as a
patch: verify it, and continue with `basePatch`. `flash_status` shows a job's state as its result's
status (`ok`, `partial`, `error`), so the two never disagree.

A long brief can be written to a file and sent with `taskFile` instead of `task` — exactly as
written, once. `taskFile` is the whole task: passing `task` beside it is refused. When a worker
stopped partway, `basePatch: <its patchId>` starts the next call
from that work: the patch is applied to the new copy first (merged if your tree moved on), and
the new call's patch holds both, so you apply only the last one. The exception is a base patch you
already applied: the copy is taken from your tree, so it already holds that change. It is not
applied again, the result warns (`basePatch … was already in the tree the copy was taken from`), and
the new patch holds only the new work, to apply on top of the base, not instead of it. A call whose worker ends with an empty report and no change comes back as
`status: "error"` with `emptyResult: true`, not as a quiet success.

A patch id can be quoted short: `flash_apply`, `flash_patch` and `basePatch` take any unique prefix
of at least eight hex digits, with or without the leading `flash-` (`1a2b3c4d`,
`flash-1a2b3c4d-5e6f`), and an ambiguous prefix is refused naming the patches it could mean. Each
stored patch records the task that made it — the brief's first line, the job id, the session, and
the `taskFile` path — and, once the call finished, the worker's final report (first 8,000
characters). `flash_patch` returns the task on every page and the report on the first; `flash_apply`
returns the task. A patch salvaged after a crash still names its task.

Every finished job's whole report is also stored on disk by job id, read-only and `discard` jobs
included, and the result names it as `reportPath`; a result cut at 24,000 characters points there.
`flash_result` for a job the server no longer holds (after a restart) returns that stored report with
its status, and `flash_patch` returns the whole report rather than the excerpt. Since 0.1.12 a
server without copies (`--isolate none`) stores its reports under the state base, in
`<state base>/<root digest>/reports` (the digest is 12 hex characters of a hash of the root
path), so `reportPath` and `flash_result` after a restart work there too. A report is written to a
temporary file and renamed into place, so a reader never sees a half-written one. Reports use the
patch window: a server with a copy pool prunes the expired ones at start-up, and `clean` removes
them. `flash_cancel` on a writing job stores the copy's change as a patch before the copy goes and
returns its `patchId`, or says `stored: false` when there was none. `flash_patch` and a writing
result list `overlaps`: other unapplied patches of the same root that change any of the same
files, such as two jobs that both took the next schema number.

A writing call whose worker changed nothing stores no patch: `change.available` stays true,
`filesChanged` is empty, there is no `patchId` or `patchPath`, and `change.note` says `the worker
changed nothing, so no patch was stored`. `apply: "auto"` then applies nothing and adds no
`applied` entry, which is not an error.

A patch can also be applied a file at a time. `flash_apply` takes `files`, naming entries as
`change.filesChanged` spells them (a rename by its old or by its new path), and records each applied
file in the patch, so the rest can follow later. A patch applied in part is not rewritten: the
stored patch stays whole, and `flash_patch` reports `appliedFiles` on its first page. Applying the
whole patch after a partial one is refused with the count — `3 of 7 files were already applied …;
pass files with the rest, or force: true to apply the whole patch again` — and `force: true` lifts
it.

Since 0.1.12 `flash_patch` and `flash_apply` take `excludeBase: true` for a patch that continued
from another (`basePatch`): it reads, or lands, only the work this call added, not the base
patch's change as well. A patch that added nothing of its own comes back empty with the note `this patch holds no
work beyond its base patch <id>; nothing to apply`. A second `excludeBase` apply is refused like a
second whole apply, and `force: true` lifts it. Both refuse when the patch recorded no base patch,
or that base patch is no longer stored.

`flash_apply` and `flash_patch` report `drift`: `commitsBehind` (how many commits your `HEAD` has
since the patch's base; `null` when that cannot be answered) and `filesChangedSince` (the patch's
own files whose content in your tree differs from the base the copy was made from; `flash_patch`
computes it on the page at offset 0 only, and it is `null` once the patch was applied). A
non-empty file list comes back as a warning on the apply. `commitsBehind` survives a restart, a
patch salvaged after a crash and a patch from another session; before 0.1.9 it was `null` for
those. An apply that would delete or rename away a file you changed since the copy was made is
refused instead: `threeWay: true` merges it and keeps
your edit (conflicts are marked in the file), and `force: true` applies it anyway and discards the
edit. Before 0.1.8 such an apply removed the file without a word.

A `threeWay` apply reports every file as `applied`, `merged`, `conflict` or `failed` (with the
reason), under `files`, with an overall `status`. A file whose base the patch record lacks is merged
from the base blob in your own repository, named by the patch's `index` line. Before 0.1.11 one such
file refused the whole apply as "base not available". When a file still fails, nothing is written,
and `appliable` lists the files that can be applied with `files`. A patch that itself adds conflict markers
(left over from a merge in the worker's copy, or a test fixture that means them) gets a loud warning
naming the files, on a `dryRun` too.

A `threeWay` apply reads every merged file before it writes the first one, so one that fails
writes nothing; only a disk error during the writes can stop it partway, and then its error names
every file it already wrote or deleted. A merged file keeps the line endings it has in your tree
(CRLF or LF), and binary content is written untouched. Files over 1 MiB merge like any other: before
0.1.10 they failed the apply with `git cat-file --filters … failed`.

Every result reports the tokens the call used (`usage`), and lists any uncommitted files the copy
started with (`isolation.uncommittedAtStart`). Since 0.1.12 it also carries `timing`, the call's
phases in milliseconds: `queuedMs` for a free tree, `prepareMs` for the copy, `setupMs` for the
`slotSetup` steps (when any ran), `workerMs` for the worker's runs, `collectMs` for collecting the
patch (when there was a copy) and `totalMs`. `queuedMs` is 0 when there was no wait, and a phase
that did not run is absent. `flash_status` by id reports it for an ended job, and it survives a
restart with the stored report. If another session has uncommitted work in the same tree, `source: "head"`
starts the copy from the last commit instead; the result then warns how many uncommitted files
of your tree it left out, since the patch may not apply on top of them. `head` is a writing
call's choice only: a read-only call runs in your tree rather than in a copy, and refuses it.

Project facts every worker needs — layout, check commands, style rules — go in an `AGENTS.md` (or
`CLAUDE.md`) in your repository. The harness loads it into every worker, from the repository root
down to the worker's directory, so tasks don't have to repeat it. It loads at most **64 KB** of
these files per worker, the most specific first; a longer file is cut, so keep a short one for
workers, and repeat the rules that must hold in the brief itself.

## Safety, in one paragraph

Three layers stand between a cheap model and your machine. **The copy**: writing calls never run
in your tree. **The sandbox**: workers are confined to their workspace by DeepSeek Harness, with
no approval prompts — anything outside fails closed. **The wall**: a deterministic, model-free
filter refuses reads of secrets (`.env`, `~/.ssh`, `~/.aws`, …), writes to `.git`, destructive git
(`reset --hard`, `push --force`, …), catastrophic deletions, and any write outside the workspace,
with every path placed in the directory its own command runs in after a `cd`. Each refusal comes
back to Claude with a code and a reason. Details, and the live test that proves
each rule, are in [docs/design.md](docs/design.md#permissions).

## Configuration

The plugin's settings (`/plugin` → flash-agents) have two model knobs:

- **Default worker model** — the model a call runs when it names none (`route.model`, or
  `FLASH_SERVICE_MODEL` for a manual install). It must be served by your Ollama; the default is the
  one this project is tuned for, and smaller local models are weaker at tool calling.
- **Models a call may choose** — a comma-separated allowlist (`FLASH_MODELS`, or `route.models` in
  `flash.config.json` for a manual install). The default is always allowed, even if the list omits
  it. Each entry must be available in your Ollama (`ollama pull <model>`; a `:cloud` model also
  needs `ollama signin`).

Any model your Ollama serves can be used, but a call can only choose one that is on the list.

Both `flash_task` and `flash_batch` take a `model` from that list: one task, or a whole fleet, can
run on a different allowed model, and the result's `route` reports the model that actually ran.
Omit `model` for the default.

The settings also cover how many copies may be in flight (up to 16, each a process, so this is a
memory decision; default 2), where copies and patches live, and **Base folder for worker copies**
(`state_base`; `FLASH_STATE_BASE` or `--state-base` for a manual install). That base moves the
default copy layout only — a configured state directory replaces it — and it must be an absolute
path, with a leading `~` expanded. It works on every platform. On Linux and macOS a short one
such as `/tmp/fm` keeps a test's Unix socket paths under the length limit ("path must be shorter
than SUN_LEN"). On Windows a short one such as `C:\fm` leaves room for build
tools that ignore long-path support; see [Honest limits](#honest-limits). A folder made directly
under `C:\` gives you modify rights but not the right to change its permissions, and the sandbox's
first step for every shell command then fails (`SetNamedSecurityInfoW failed (Win32 5)`). Grant
them once, before the first call:

```sh
icacls "C:\fm" /grant "%USERNAME%:(OI)(CI)F"
```

`doctor` has a `state-base-permissions` row on Windows that tests exactly this and names the fix.

**After updating the plugin, run `node install.mjs` again in the plugin folder**
(`/flash-agents:setup` does the same from the plugin). An update replaces the server but not the
worker profile or the guard the server runs with, so the old guard stays in place until the
installer rewrites it. 0.1.8 names that drift: the server logs it at start, every `flash_task` and
`flash_batch` result carries the warning, and `doctor`'s `profile-version` row warns until the
installed profile matches the server. The warning clears by itself, without a reconnect: a
runtime booted after the install re-reads its profile's stamp, and since 0.1.10 an idle runtime
that booted before the install is replaced at its next use. A busy one keeps serving its running
calls, and their warning says it will be replaced when they end.

**After upgrading from 0.1.5 or older, run the setup once more** (`/flash-agents:setup`, or
`node install.mjs` in a manual install). Before 0.1.6 the installed worker profile pinned one
literal model: setting the plugin's model alone did not switch the worker, and a profile from an
older release refuses a per-call choice until it is regenerated.

Limits live in [`flash.config.json`](flash.config.json). The defaults: a call is stopped after
**10 minutes without any activity** (stuck), or 3 hours in total (a ceiling for honest work);
either way, the change so far is salvaged as a patch. A worker runtime that no call is using is
shut down after the same 10 minutes, read-only runtimes included.

### Per-repository settings

A `.flash-agents.json` at the repository root tunes the disposable copy for that repository, and a
git-ignored `.flash-agents.local.json` beside it holds what belongs to one machine. Both are
checked at the start of every writing call and re-read when they changed, so an edit applies from
the next call on, without a reconnect. That matters where `/mcp reconnect` is not available, as in
Claude Code's VS Code extension. A call that is already running keeps the settings it started with.
A changed `slotEnv` restarts that copy's worker runtime when it is idle, since the runtime's
environment is fixed when it starts. A file that turns invalid (a stray comma) keeps its last good
settings, and every call warns until it is fixed (`<file> could not be used: …`).

Both files have the same shape. A top-level `platform` object, keyed by Node's `process.platform`
names (`win32`, `linux`, `darwin`, …), holds sections with the same keys as the top level; only the
running platform's section applies. The layers apply in this order: the shared file, its platform
section, the local file, its platform section, then the server's own options
(`FLASH_COPY_EXCLUDE`, `--copy-exclude`, …). `copyExclude` and `slotSetup` add up across layers;
`slotEnv` merges by variable name, case-insensitively on Windows, and a `null` in a later layer
removes an earlier entry; the last `copyExcludeDefaults` wins. A local `slotSetup` is host code like
any other, behind the same `--allow-slot-setup` gate.

The local file may also set this machine's state base: `{ "stateBase": "/data/fm" }`, or a
`stateBase` in its `platform.<os>` section. It wins over the plugin setting and `FLASH_STATE_BASE`,
because the plugin's setting is synced between machines, but not over an explicit `--state-base`.
A value that is not a non-empty path is refused at start, naming the file. `doctor`'s `state-base`
row says which layer the value came from, and `clean` reads the same local file under its `--root`.

The server logs the layers it applied
(`settings: .flash-agents.json, .flash-agents.json platform.win32, .flash-agents.local.json
platform.win32`) at start and again after a reload (`settings reloaded: …`), and warns once when the
local file is tracked by git or not ignored by it.

```json
{
  "copyExclude": ["target"],
  "slotEnv": {
    "CARGO_TARGET_DIR": "cache:cargo-target",
    "XDG_CONFIG_HOME": "home:config",
    "OPENSSL_NO_VENDOR": "value:1"
  }
}
```

One Windows machine with a prebuilt OpenSSL. The committed `.flash-agents.json` carries what every
Windows checkout needs — MSVC's build output left out of the copy:

```json
{ "platform": { "win32": { "copyExclude": ["build-msvc"] } } }
```

The git-ignored `.flash-agents.local.json` carries the path only this machine has:

```json
{ "platform": { "win32": { "slotEnv": { "OPENSSL_DIR": "value:C:\\openssl" } } } }
```

A worker on that machine gets a copy without `build-msvc/` and with `OPENSSL_DIR` set. A Linux
checkout gets neither, because no `platform.linux` section names them.

- **`copyExclude`** — paths left out of each copy. A bare name matches at any depth (`target`,
  `node_modules`), a bare name ending in `*` matches a prefix (`build-*`), and a name with a slash
  is a path from the root. A match is left out only where git ignores it and tracks nothing under
  it, so source is never dropped. For a Rust workspace with a multi-gigabyte `target/`, this is the
  difference between a copy that takes half a minute and one that takes a second.
- **Secrets are left out by default**: `.env`, `.env.*` and `.mcp.json`, under the same rule (a
  tracked `.env.example` is still copied). `"copyExcludeDefaults": false` copies them again, for a
  repository whose tests really need them.
- **`slotEnv`** — environment variables pointing the worker at writable folders inside its copy,
  for tools that otherwise write to your (read-only, to a worker) home folder. `home:<name>` is
  emptied for every call; `cache:<name>` is kept between calls in the same slot, so
  `CARGO_TARGET_DIR: "cache:cargo-target"` keeps incremental builds warm without copying `target/`.
  A call that timed out or was cancelled retires its copy, and since 0.1.10 the copy's `cache:`
  folders (and `slotSetup`'s `keep` paths) move to the replacement copy instead of being deleted, so
  the retry does not build from cold; each `slotSetup` step runs once more there. A result with
  `isolation.buildCacheEmpty: true` started with an empty cache, which explains a slow build.
  Since 0.1.11 the `cache:` folders also outlive the server: they can go into a store for the
  repository (one per slot, kept 14 days), and a slot with none takes one from there
  (`isolation.buildCacheFrom: "store"`). Since 0.1.12 a slot's cache normally stays in its stable
  directory instead (see below), so the store serves the retired trees and a slot that is new.
  `flash-agents clean` removes the stored caches with the rest, `clean --caches` removes only them, and
  `doctor` lists what each slot, its cache and the store take on disk. A call warns when the volume
  holding the copies has under 10 % or under 5 GiB free.
  `port:<base>` gives each slot its own port base (`base + slot × 10`; `port:41000/100` for a
  stride of 100), for test servers that would otherwise share a fixed port. `value:<text>` sets a
  plain value in every slot, for a setting the whole project shares rather than one brief:
  `"OPENSSL_NO_VENDOR": "value:1"` in the example above, `"OPENSSL_DIR": "value:C:\\openssl"` for a
  Rust project with a prebuilt OpenSSL, or `"RUSTC_WRAPPER": "value:sccache"`. A `value:` entry
  reaches the worker and its `slotSetup` steps. `HOME`, `TMPDIR`, `TMP`, `TEMP`, `DSH_HOME` and
  `FLASH_ROUTE_MODEL` can't be moved, and neither can `PATH`, `PATHEXT`, `NODE_OPTIONS`, `NODE_PATH`
  or any `LD_*`/`DYLD_*` name: the slot environment is also the environment of the `dsh` runtime
  process, which runs outside the worker's sandbox, so a `PATH` or a `NODE_OPTIONS=--require …`
  would act there. Only a writing call has a slot; a `read-only` call sees none of this.
- **`slotSetup`** — commands that build what the copy needs before the worker starts, such as a
  virtual environment whose editable installs must point into the copy, not into your checkout:

  ```json
  "slotSetup": [
    { "run": ["uv", "sync", "--frozen"], "inputs": ["uv.lock", "pyproject.toml"], "keep": [".venv"] },
    { "run": ["bun", "install", "--frozen-lockfile"], "inputs": ["bun.lock"], "keep": ["node_modules"] }
  ]
  ```

  A step runs in the copy on the first call in a slot, and again only when one of its `inputs`
  changes or a `keep` path is gone; `keep` paths (which must be git-ignored) survive between calls
  in the same slot and are not copied from your tree. A step with no `keep` runs on every call,
  since nothing it wrote in the copy survives. `run` is an argv, not a shell line (on Windows
  a `.cmd` tool needs `["cmd", "/c", …]`); `timeoutSeconds` defaults to 900. A failing step fails
  the call with its output. **These commands run on your machine outside the worker sandbox**, so
  they only run when you turn on the plugin setting **Run slotSetup commands** (`/plugin` →
  flash-agents; `FLASH_ALLOW_SLOT_SETUP=1` or `--allow-slot-setup` for a manual install); otherwise
  every result says they were skipped.

| Tool | Writes to | Variable to move |
|---|---|---|
| wrangler | `~/.config/.wrangler` | `XDG_CONFIG_HOME: "home:config"` |
| cargo, new crates | `~/.cargo` | `CARGO_HOME: "cache:cargo-home"` (downloads once per slot; your `~/.cargo/config.toml` is not seen). It starts without the crate registry, so a first `--offline` build fails: seed it with a `slotSetup` step, or leave `CARGO_HOME` out of `slotEnv` so workers read your `~/.cargo` |
| cargo, build output | `target/` | `CARGO_TARGET_DIR: "cache:cargo-target"` |
| Go | its build cache and `~/go/pkg/mod` | `GOCACHE: "cache:go-build"`, `GOMODCACHE: "cache:go-mod"` |
| npm | `~/.npm` | `npm_config_cache: "cache:npm"` |
| pip | `~/.cache/pip` | `PIP_CACHE_DIR: "cache:pip"` |
| uv | `~/.cache/uv`, its tools and Pythons | `UV_CACHE_DIR: "cache:uv"`, `UV_TOOL_DIR: "cache:uv-tools"`, `UV_PYTHON_INSTALL_DIR: "cache:uv-python"` |

`FLASH_COPY_EXCLUDE` (comma-separated) or `--copy-exclude` add to `copyExclude` for one server.

Since 0.1.12 a writing call's copy lives at the same path across restarts:
`<state base>/<root digest>/slots/<n>`, with its `.flash-cache` inside. Build tools write absolute
paths into what they build (SwiftPM's `.build`, CMake's caches, cargo's fingerprints for path
dependencies), so a slot that moved would rebuild from cold; now the next server on that root uses
the same directory. A slot is claimed by a lock file, `<n>.lock`, written complete in one step, that
names the server's pid and command line. A lock is taken over when its pid is gone, or when the pid
now runs a different command (the system reused it); no clock is involved, so a time-zone or
daylight-saving change cannot make a live lock look dead. Only the holder of a slot's lock moves,
empties or deletes that slot, and a server's own sweep never deletes a stable `slots/<n>`. Two
servers on one root get different numbers:
the second starts at the first number no live server holds. A server that shuts down removes its
lock, empties the copy and leaves the directory and its cache; a server that crashes leaves its
copy behind, and the next server on that number moves the tree aside to
`slots/<n>.dead-<pid>-<ms>`, keeps the cache in the slot, and a sweep stores the uncommitted work
as a patch before removing it. A configured state directory (`--state-dir`) keeps the older
per-process layout.

On Linux a copy tries a reflink clone first and falls back to a byte copy, with one log line naming
the flag the filesystem did not support; macOS and Windows copy plainly from the first file.

To watch workers live, set a log file and `tail -f` it — see
[Observing a run](docs/design.md#observing-a-run).

## Honest limits

- **A running worker can't be steered** — the harness protocol has no attach. A background call
  can be cancelled, which stops its runtime and retires its copy; as on a timeout, the change so far
  is stored as a patch named in the error. The idle timeout is what stops a stuck one.
- **Members of one `flash_batch` share one copy**, so they see each other's edits. Give them
  disjoint files.
- **Gitignored output isn't carried in the patch.** It's named in the result instead — new ignored
  paths under `change.ignored`, and ignored files that already existed and were rewritten or deleted
  (a regenerated `worker-configuration.d.ts`, say) under `change.ignoredChanged`, with a warning to
  regenerate them after applying. Changes deep inside an ignored directory such as `node_modules/`
  are not tracked. The copy is emptied as soon as the patch is stored, build output included.
- **The dispatcher is a cheap model too.** Occasionally it does the work itself instead of
  delegating; that call fails as `NOT_DELEGATED`, nothing from it is kept, and a retry usually works.
  One shape of that is retried automatically — an attempt that ended within three minutes and at
  most twelve model calls with no delegation, or only empty reports, and no change in the copy — once,
  after ten seconds. Anything else it got wrong is a verdict, not a hiccup.
- **A repeated-failure warning reads the shell's exit code, so a pipe hides it.** A command piped
  into `tee` reports `tee`'s exit code, not the failing command's, so a build that fails on the left
  of a pipe cannot be counted; read the worker's output for those. Exit 1 from `grep`, `rg`,
  `git grep`, `diff` or `cmp` means "no match" or "they differ" and is not counted, and a warning
  says so when a later run of the same step succeeded.
- **A read-only call runs in your live tree, not in a copy.** It sees edits that land while it
  reads, yours or another session's.
- **Copies are separate folders, not separate machines.** Two workers in parallel share ports, the
  keyring and other per-user services: a test server on a fixed port can answer the other copy's
  tests. Pick a free port per run.
- **Parallel slices don't know about each other.** Five workers once picked the same database
  migration number on one day. Give each parallel slice its own range of numbered files, or number
  them yourself at apply time.
- **Nested repositories travel in the patch only in the workspace layout.** Since 0.1.10 a worker's
  edits inside a nested git repository of a whole-root copy are carried in the patch when that
  repository has its own `.git` directory and the top repository either does not track or ignore
  it, or ignores exactly its directory (`inner/` in `.gitignore`). A repository under an ignored
  parent (`vendor/`, `node_modules/`, `.build/checkouts/`) is left out as before, and a submodule
  keeps its pointer. A nested repository whose changes cannot be read is named in `warnings`, and
  the copy is kept until the next call in that slot. Pointing `cwd` into the repository still copies
  only that one.
- **Jobs are this server's, not your machine's.** `flash_status` and `flash_result` know only the
  jobs the running server process started: another session's jobs, or one from before a restart, are
  not listed. A finished writing call's work survives that as a patch, which `flash_apply` can still
  apply by id.
- **The guard follows the shell, and an update no longer leaves it behind.** The wall now places
  every path in the directory its own command runs in, so `cd .. && echo x > ../elsewhere` is refused
  and `cd server && … > ../log` is allowed; a deletion after a `cd` it cannot follow is refused
  rather than guessed at. Since 0.1.12 it reads PowerShell too: writes through `Set-Content`,
  `Add-Content`, `Out-File`, `New-Item`, `Copy-Item`, `Move-Item`, `Rename-Item`, `Remove-Item` and
  their aliases, through redirects, and through `[System.IO.File]::WriteAllText(…)` calls with a
  literal path. A shell started as a program is read with that shell's rules — `& "C:\Program
  Files\Git\bin\bash.exe" -c "…"`, `sh -c`, `pwsh -Command`, `powershell -c`, `cmd /c` — whatever
  its path or `.exe` spelling, and the refusal says where the nested line was found
  (`inside bash.exe -c`). `.git` matches in any case, a path with one leading slash is the root of
  the current drive, and a PowerShell deletion reports the same code as `rm`. A plugin update no
  longer leaves the old guard and worker profile behind silently: the
  server names the drift in its log and in every task result, and `node install.mjs` in the plugin folder
  is the fix. A runtime that boots after that install re-reads the profile's stamp and drops the
  warning by itself; an idle runtime booted before it is replaced at its next use, and a busy one
  once its calls end.
- **A crash used to lose the unfinished work; 0.1.7 fixes that.** Before 0.1.7 the start-up sweep
  looked for a dead server's copies one directory too high, found nothing to salvage, and deleted
  them. It now finds them and salvages a copy that holds work as a patch named in the log, and keeps a copy it
  could not read — retried at most once every ten minutes, up to three attempts — instead of deleting
  it. The dead server's directory is renamed out of the way and deleted in the background, and the
  handshake is answered before any of it runs, so a large clean-up cannot outlast Claude Code's
  connect timeout.
- **On Windows, a long slot path can break tools that ignore long-path support.** MSVC's `cl.exe`
  and others still fail past 260 characters, and a slot root is about 85 before a project's own
  build folders are added. A slot root over 64 characters logs a warning at start and on every call,
  and `doctor` reports a `slot-path-length` row; set **Base folder for worker copies** (`state_base`,
  `FLASH_STATE_BASE` or `--state-base`) to a short absolute folder such as `C:\fm`, and run
  `icacls "C:\fm" /grant "%USERNAME%:(OI)(CI)F"` once on it. A folder made directly under `C:\`
  gives you modify rights but not the right to change its permissions, and every shell command in a
  slot then fails at the sandbox's first step (`SetNamedSecurityInfoW failed (Win32 5)`);
  `doctor`'s `state-base-permissions` row tests that and names the fix (see
  [Configuration](#configuration)).
- **On Windows the dsh sandbox blocks owner-only folders and named pipes.** This is the harness's
  sandbox, not the plugin. A folder created with an owner-only access list cannot be used inside
  it: Python 3.12.4+ and 3.13 create one for `os.mkdir(..., 0o700)`, `tempfile.mkdtemp()` and
  therefore pytest's `tmp_path`. Named pipes are blocked too, which stops `multiprocessing` and
  pytest-xdist, and may be the cause of Node's `spawn EPERM`, since libuv uses named pipes. Run
  such tests yourself on the applied patch. A user traced the pipe block (thank you): a pipe made
  without its own security descriptor gets a default that a sandboxed process cannot open for
  writing, even its own. So ninja hangs forever (it does not check that open), and MSBuild with more
  than one node fails with "0 errors"; CMake's Visual Studio generator with one node works. Cargo
  also cannot reach crates.io inside the sandbox (TLS fails). Workers on Windows are told all three.
  Native CMake dependencies are best built by a `slotSetup` step, which runs outside the sandbox,
  into a `cache:` folder, which since 0.1.11 survives a restart.
- macOS and Linux are what we test on. Windows 11 works in daily use by at least one user; directory
  junctions are recreated as junctions inside the copy.

## Manual install (without the plugin)

```sh
git clone https://github.com/tomw1808/flash-agents.git && cd flash-agents
node install.mjs                                   # writes the worker profiles into ~/.dsh
node packages/flash-mcp/lib/index.js doctor        # every check, with its fix
claude mcp add flash -- node "$PWD/packages/flash-mcp/lib/index.js" --root /path/to/your/project
```

`node install.mjs --uninstall` removes everything the installer wrote. The server speaks plain
MCP over stdio, so any MCP client can use it, not only Claude Code.

## Development

```sh
npm test          # 3 suites, no LLM, no network, about 10 seconds
npm run verify    # live end-to-end through the official MCP client; needs Ollama
```

`npm run verify` must run from a full git clone, not from the installed plugin folder and not from
a git worktree (its copy would share the original's objects and refs), because its change
checks read the snapshot's git state. It also needs the official MCP client SDK, which is
not a dependency of this package: install it with `npm i @modelcontextprotocol/sdk@1` in a folder
of its own and set `MCP_SDK_DIR` to that folder's `node_modules/@modelcontextprotocol/sdk`.

No runtime dependencies. [docs/design.md](docs/design.md) has the full contract, the safety
model, every option, what was verified live, and why things are the way they are.

## License

[MIT](LICENSE) © Thomas Wiesner
