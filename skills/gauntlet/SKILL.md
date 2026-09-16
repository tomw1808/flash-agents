---
name: gauntlet
description: >-
  Orchestrate cheap parallel builder and critic subagents toward a runnable quality bar. The
  orchestrating (frontier) model frames the task, filters findings, and judges finalists in a
  blind A/B duel; smaller models do the building, critiquing, and revising. Use for tasks whose
  result can be checked by running something. Do not use for design decisions or vague goals.
---

# Gauntlet: frontier-model orchestration, cheap-model execution

> **Status: shipped with the `flash-agents` plugin, and still young.** Installing the plugin
> makes this available as `/flash-agents:gauntlet`. It assumes no helper script: every
> mechanical step is written as plain shell/git, so any agent harness can follow it — and it has
> been reasoned through more thoroughly than it has been run end to end. Read §10 (open
> questions) before handing it a long or expensive job, and run it on a task whose bar you can
> actually execute.

## The idea in one paragraph

You, the orchestrator, do the brain work: write the spec, write the bar (runnable acceptance
checks), split the work, filter what critics find, and pick winners. Cheap subagents do the
legwork: several *different* attempts in parallel, adversarial critique, and revisions. The
filesystem, not your context, carries state between rounds. Each round a challenger must beat
the current champion in a **blind side-by-side comparison**. The loop ends when the champion
keeps winning, when the budget runs out, or when progress stops.

Adapted from the gauntlet-loop pattern (named and fetchable bar, fresh-context critic, blind
pairwise choice, no fixed round count), with three changes for cheaper models: parallel
diversity instead of one serial builder, runnable checks as the first filter, and hard stop limits.

---

## 1. Use it, or don't

**Use when all of these hold:**
- The result can be **checked by running something**: tests, typecheck, a benchmark, a corpus,
  a linter, a golden-output diff.
- The work fits in **one or a few independent units** (separate files or modules, clear
  interfaces).
- More than one approach is plausible, so parallel attempts will actually differ.

**Do not use when:**
- You can't write the acceptance check. **Stop and ask the user**; there is nothing to run a
  gauntlet against.
- The task is mostly a design or taste decision with no reference to compare against.
- The change is tightly coupled across the codebase (parallel builders will conflict).
- The task is small enough to do directly in fewer tokens than writing the spec.

**Prerequisites:** a git repository with a clean working tree (or a commit to start from), a
command that runs the checks, and a way to start subagents on a cheaper model (see §7).

---

## 2. Roles

| Role | Model | Sees | Never sees |
|---|---|---|---|
| Orchestrator (you) | frontier | spec, bar, ledger, distilled findings, finalist diffs | builder or critic transcripts |
| Builder | cheap | its own scratch clone: spec, bar (public part), `findings.md` copied inside | the original repo, other candidates, held-out checks, who judges |
| Critic | cheap | spec, one candidate's diff and check output, pasted into the prompt | any checkout, the builder's reasoning, other candidates, labels |
| Reviser | cheap | its own scratch clone with that candidate's `findings.md` | the original repo, other candidates, held-out checks |
| Judge | frontier, **fresh context** | spec, bar, diff A, diff B, check output A/B | which is champion, which model, round history |

Why a separate judge: you know which candidate is the champion, so you can't judge blind
yourself. Start a fresh-context subagent **on a strong model** for the duel, and randomise which
side is A.

---

## 3. Layout on disk

Orchestrator state lives in the repo, hidden from git. **Workers never see the repo.** Each one gets a
disposable copy outside it, with its task files copied inside.

**Worker isolation: three layers, all required.**
1. **Tell:** every worker prompt says its directory is a disposable copy, and that the original
   repository is off-limits.
2. **Contain:** the copy is the only thing it needs. Start it with `cwd` set to the copy (and the
   sandbox root too, if the harness has one). Put its spec, bar, and findings *inside* the copy,
   and use only relative paths in everything it reads. A worker that never sees a real repo path
   is unlikely to wander there. Some harnesses do this themselves — with `flash-mcp`, a writing
   `flash_task` is handed its own copy of `--root` and the wall refuses any mutation outside it —
   in which case "make the copy" becomes "point `--root` at the repository to copy".
3. **Verify:** after every build or revise step, check that the original checkout is unchanged
   (§5.2). A worker that touched it is discarded, and the run pauses for the user.

**Copy type.** Builders and revisers change files and run git, so give them a **scratch clone**.
A clone has its own `.git`, so `git branch -D`, `git stash drop`, `git reset --hard`, or a changed
hook can't reach the original's refs, stash, hooks, or config. A worktree shares all of those. Local
clones are cheap (hardlinked objects). Use a worktree only when the harness creates and cleans
it up for you and the worker is trusted not to run history-changing git. Critics and the judge
read diffs, so they need no checkout at all.

```
.gauntlet/<run-id>/              # add ".gauntlet/" to .git/info/exclude
  spec.md                        # frozen after round 0
  bar.md                         # public acceptance checks + named reference
  heldout.md                     # checks builders never see (optional but recommended)
  ledger.jsonl                   # one line per candidate per round
  findings/<candidate>.md        # distilled by you, max ~30 lines each
  patches/<candidate>.patch      # final diff of each candidate
  report.md                      # written at the end

$TMPDIR/gauntlet/<run-id>/<candidate>/   # one scratch clone per candidate
  .gauntlet-task/                        # copied in by you; excluded in the clone's .git/info/exclude
    spec.md  bar.md  findings.md         # never heldout.md
```

Names: `<run-id>` = `YYYYMMDD-HHMM-<slug>`, `<candidate>` = `r<round>-c<n>` (revisions:
`r2-c3v`). Branches: `gauntlet/<run-id>/<candidate>`. The champion is a branch ref:
`gauntlet/<run-id>/champion`.

---

## 4. Round 0: frame (you, once)

1. **Freeze a starting point.** `git rev-parse HEAD` → record it as `base` in `ledger.jsonl`.
   Create `gauntlet/<run-id>/champion` at `base`. The unchanged code is the first champion, so any
   challenger must at least beat "do nothing".
2. **Write `spec.md`** using the template in §9.1. Keep it under ~60 lines. Name the files and
   interfaces a unit may touch.
3. **Write `bar.md`** (§9.2). The acceptance command(s) must be *runnable now*. If the feature
   doesn't exist yet, write the tests first and confirm they fail on `base` for the right reason.
4. **Write `heldout.md`**: a few extra checks (edge cases, a second corpus, a perf limit) that you
   run but never show builders. This catches builders that game the visible tests.
5. **Split the work** if needed. Independent units run as separate gauntlets, in parallel.
   Units that share files run one after another.
6. **Set the budget** and record it in the ledger: `maxRounds` (default 4), `buildersPerRound`
   (default 3–4), `criticsPerSurvivor` (default 2), `reviseTop` (default 2), `stopAfterDefenses`
   (default 2).

**Don't start round 1** until spec and bar are good enough that a competent stranger could build
against them without asking you anything.

---

## 5. Each round

### 5.1 Build (cheap × N, parallel)

Before the first build of the run, record the original checkout's state so you can check it later:

```sh
git -C <repo> status --porcelain=v1 > .gauntlet/<run-id>/root-status.txt
git -C <repo> rev-parse HEAD > .gauntlet/<run-id>/root-head.txt
```

For each candidate `c` in `1..N`:

```sh
D="$TMPDIR/gauntlet/<run-id>/r<k>-c<c>"
git clone --local --quiet --branch gauntlet/<run-id>/champion <repo> "$D"
git -C "$D" switch --quiet -c gauntlet/<run-id>/r<k>-c<c>
git -C "$D" remote remove origin                 # no push path back to the original
mkdir -p "$D/.gauntlet-task"
cp .gauntlet/<run-id>/{spec.md,bar.md} "$D/.gauntlet-task/"
cp .gauntlet/<run-id>/findings.md "$D/.gauntlet-task/" 2>/dev/null || true
echo ".gauntlet-task/" >> "$D/.git/info/exclude"
```

Start one builder subagent per clone with `cwd = $D` and the **builder prompt** (§9.3). Leave the
original repository out of the prompt entirely: no absolute repo paths, no "see <repo>/…". To bring a
candidate back for checks and the duel, fetch its branch into the original repo:
`git -C <repo> fetch "$D" gauntlet/<run-id>/r<k>-c<c>:gauntlet/<run-id>/r<k>-c<c>`. Give each builder a
different **approach hint** so the attempts differ, for example: "smallest possible change",
"restructure for clarity first", "optimise for the edge cases in the spec", "different data
structure". If your harness allows it, also vary the model.

### 5.2 Check (deterministic, you run commands, no model)

**First, check the original checkout.** Compare the current `git -C <repo> status --porcelain=v1` and
`rev-parse HEAD` with `root-status.txt` / `root-head.txt`, ignoring `.gauntlet/` and the
`gauntlet/<run-id>/*` branches you fetched yourself. If anything else changed, **stop the run**. Work out
which worker did it (timestamps, the files involved), discard that candidate, tell the user what changed,
and wait. Don't try to repair the original tree on your own.

Then, in each clone, have the builder commit its work (or commit it yourself:
`git -C "$D" add -A && git -C "$D" commit -qm r<k>-c<c>`. `.gauntlet-task/` is already excluded, and
naming it in an exclude pathspec makes `git add` fail), fetch it into
the repo (§5.1), copy `heldout.md` in *only now*, after the builder has finished, and run the public checks,
then the held-out checks. Record one ledger line:

```json
{"round":1,"candidate":"r1-c2","model":"<model>","approach":"smallest change",
 "public":"pass","heldout":"fail:2/9","extra":{"perf_ms":41},
 "diffstat":"+120 -34, 3 files","outOfScopeFiles":[],"verdict":null}
```

- Save the diff: `git -C <worktree> diff gauntlet/<run-id>/champion > patches/<candidate>.patch`.
- **Discard** a candidate that fails public checks or touches out-of-scope files. Keep its error
  output: one line of it goes into the next round's builder findings.
- **Read only the ledger lines**, not the diffs, at this stage.

### 5.3 Critique (cheap, fresh context, survivors only)

For each surviving candidate, start `criticsPerSurvivor` critics with the **critic prompt**
(§9.4). Give each critic one **focus**: correctness and edge cases / spec compliance and scope /
simplicity and maintainability / security and error handling. Critics list problems with file
and line evidence. They don't score, and they don't compare.

### 5.4 Distill (you)

Read the critics' lists (deduplicate first). For each claimed problem, keep it **only if you can
confirm it from the diff or check output in under a minute**. Everything else goes. Write
`findings/<candidate>.md`: at most ~30 lines, concrete, ordered by severity, each with a location.

This step is the main defence against cheap critics inventing problems and triggering rework.
Never skip it.

### 5.5 Revise (cheap, top survivors)

Pick the `reviseTop` best survivors by ledger (public pass, held-out score, smaller diff wins
ties). For each, make a fresh scratch clone of its branch exactly as in §5.1, but name it
`r<k>-c<n>v`, copy that candidate's findings to `.gauntlet-task/findings.md`, and remove any
`heldout.md` (a revision must not see it either). Start a builder with `cwd` set to the clone and the
**reviser prompt** (§9.5), then run §5.2 again, including the original-checkout check.

### 5.6 Duel (frontier judge, fresh context, blind)

Take the best challenger of the round (by ledger after revision) and the current champion.
If they are the same code, skip the duel.

1. Randomise the order. Label them **A** and **B** only.
2. Start a fresh-context judge subagent on a strong model with the **judge prompt** (§9.6):
   spec, bar, both diffs relative to `base`, both check outputs (public + held-out).
3. The judge returns `A` or `B` plus a reason of at most three sentences. No scores, no "both are
   good".
4. Map the letter back. If the challenger wins, move `gauntlet/<run-id>/champion` to it and reset
   `defenses = 0`. If the champion wins, `defenses += 1`. Record the verdict in the ledger.

### 5.7 Stop or continue

Stop when **any** of these holds:
- the champion has survived `stopAfterDefenses` duels in a row, and its public and held-out checks
  are green;
- `round == maxRounds`;
- **no progress**: this round's confirmed findings substantially repeat last round's, or no
  candidate survived checks two rounds in a row;
- the spec turns out to be wrong. Stop and tell the user; don't patch the spec mid-run.

Otherwise start the next round from §5.1. Builders get the champion plus a combined
`findings.md` of confirmed issues that still apply to it.

---

## 6. Finish

1. Write `report.md`: goal, rounds run, the ledger as a table, champion lineage, the final diffstat,
   remaining known issues, why the loop stopped.
2. Show the user the final diff (`patches/` of the champion, or `git diff base..champion`) and the
   report. **Don't merge on your own** unless the user asked for that.
3. Clean up: run the original-checkout check one last time, delete every `$TMPDIR/gauntlet/<run-id>/`
   scratch clone, delete `gauntlet/<run-id>/*` branches except the champion, and leave
   `.gauntlet/<run-id>/` in place for inspection.

---

## 7. Dispatch adapters

The loop only needs "start a subagent on model M with prompt P in directory D, and get its final
message". Map that to whatever is available:

| Harness | Builders / critics / revisers (cheap) | Judge (strong, fresh) |
|---|---|---|
| Claude Code | subagent (Agent/Task tool) with a cheaper `model`. It starts in the parent's cwd with the parent's permissions, so the prompt must name `D` and say to `cd` there first. Prefer the tool's `isolation: "worktree"` option, or launch a separate headless session with its working directory set to `D`. Either way, the original-checkout check in §5.2 is what you rely on | subagent on the same frontier model |
| Codex / other CLI agents | their `exec` equivalent with a cheaper model, `cwd = D`, and a workspace-write sandbox whose root is `D`. This is the strongest containment | a fresh session on a strong model |
| flash-mcp (this repo) | a writing `flash_task` now runs in a **disposable copy of the server's `--root`**: the worker's sandbox root is that copy, the wall refuses any mutation outside it, and what comes back is a patch applied only by `flash_apply`. So `--root` is the repository you are willing to have copied, and `cwd` still selects the subdirectory inside it. One caveat for candidates: a `flash_batch` fleet is **one call and therefore one copy**, so one-copy-per-candidate means N *parallel* `flash_task` calls, bounded by `--slots` (each slot is a runtime process, so memory is the limit) | not a cheap-model job; use the host agent's own subagent |
| No subagents available | don't use this skill | — |

**Field notes from a real flash-mcp run** (two feature tasks, both landed as patches):

- **One long-lived server per run, not one per call.** A patch is issued by a server and applied
  through `flash_apply` on a server. Spawning a server per call works, but then you must locate the
  patch file yourself; keep one process up for the whole gauntlet instead.
- **Prefer N parallel `flash_task` over one `flash_batch`.** Beyond the one-copy-per-call point: a
  fleet's payload has to survive being relayed *by a model*, and in a live run the dispatcher passed
  `args` as a JSON string, so the workflow tool rejected it and no worker started. A single task
  relays only its own text and is markedly more reliable.
- **Two tasks, 120s and 137s**, each returning `filesChanged` plus a diff — good enough for the check
  step (§5.2) to run on the applied patch.
- **Watch a round with `--log-file`**, and read a worker's whole transcript afterwards with
  `scripts/flash-sessions.mjs`. There is no way to intervene mid-task.
- **The dispatcher occasionally does the work itself** instead of delegating; the call then fails with
  `NOT_DELEGATED` and nothing is collected. Treat a failed candidate as variance and re-run it.

Whatever the harness, containment is **best effort**. The original-checkout check is the guarantee. Never skip it,
and never run a round with `D` inside the original repository.

Parallelism: launch all builders of a round together, then all critics together. Never run the
judge in parallel with anything that could change the candidates it is judging.

---

## 8. Rules that make it work

- **Fresh context everywhere.** No subagent ever sees a previous transcript, only files.
- **Nobody judges their own work.** Builders don't critique, critics don't build, the judge
  doesn't know which side is the champion.
- **Pairwise choice, not scores.** Numeric scores creep upward; forced choices don't.
- **Runnable checks decide first.** Only candidates that pass reach models' judgment.
- **Keep some checks hidden.** Builders must not see `heldout.md`.
- **Freeze the spec.** Changing the target mid-run invalidates every comparison; start a new run.
- **Keep your own reading small.** Per round you read ledger lines, deduplicated findings, and at
  most one duel verdict. If you catch yourself reading whole candidate diffs every round, the bar
  is too weak: improve the checks instead.
- **Budget honestly.** Count your own tokens. If a run costs more than doing the task directly,
  record that in `report.md`; that's a result worth knowing.

---

## 9. Templates

### 9.1 `spec.md`

```markdown
# Goal
<one or two sentences: the observable outcome>

# Context
<only what a stranger needs: relevant files, existing patterns to follow, links to the reference>

# Scope
- May change: <paths / modules>
- Must not change: <paths / public APIs / config>

# Interfaces
<signatures, formats, CLI flags, or data shapes that must hold>

# Non-goals
<what is explicitly out of scope>

# Constraints
<dependencies allowed, performance limits, style rules, compatibility>
```

### 9.2 `bar.md`

```markdown
# Acceptance (public: builders see this)
- Command: `<exact command, run from the worktree root>`
- Passes when: <exit code 0 / specific output / threshold>

# Reference (the named thing we compare against)
- <existing module, benchmark result, golden files, or upstream implementation> at <path or URL>

# Scope check
- `git diff --name-only <champion>` lists only files under: <paths>
```

### 9.3 Builder prompt

```text
You are one of several independent builders.

Your directory: <D>
If you are not already there, run `cd <D>` first. This directory is a disposable scratch copy made for
you. It is the only place you may read project files from, write to, or run commands in. The
original project lives somewhere else, and you must not look for it, open it, or change it. Use relative
paths. Never `cd` out of this directory and never write to an absolute path outside it (temporary files
may go in `.gauntlet-task/tmp/`).

Read these files first (relative to your directory):
- .gauntlet-task/spec.md  (the task; follow it exactly)
- .gauntlet-task/bar.md   (how your work will be checked)
- .gauntlet-task/findings.md (known problems with the current best version, if present)

The code in your directory is the current best version. Improve on it.
Your approach for this attempt: <approach hint>.

Rules:
- Stay within the scope in spec.md. Do not modify tests listed in bar.md or files in .gauntlet-task/.
- Run the acceptance command before you finish, and fix failures.
- Git: you may use `git status`, `git diff`, `git add`, and `git commit`. Do not push, add remotes,
  delete branches, stash, reset, rebase, or change git config or hooks.
- Finish with at most 10 lines: what you changed (files), the final acceptance command output
  summary, and anything you could not do.
```

### 9.4 Critic prompt

```text
You are reviewing a proposed change. You did not write it, and you don't know who did.
Focus only on: <focus>.

Inputs:
- The task: <run>/spec.md
- The change: <pasted patch contents>
- Check output: <pasted check output>

Everything you need is in this message. Do not open, run, or change any files. If a
finding needs more context than the diff shows, say so in the finding instead of looking it up.

List concrete problems only. For each: severity (high/medium/low), file:line, what is wrong, and
evidence (a quote from the diff, a failing input, or a spec clause it breaks). If you find
nothing real, say "no findings". Do not praise, score, rewrite the code, or suggest style-only changes.
At most 12 findings.
```

### 9.5 Reviser prompt

```text
Your directory: <D>
If you are not already there, run `cd <D>` first. It is a disposable scratch copy holding a candidate
solution to .gauntlet-task/spec.md, and it is the only place you may read, write, or run commands. The
original project is elsewhere and off-limits. Use relative paths and never `cd` out of this directory.

Confirmed problems to fix (and nothing else): .gauntlet-task/findings.md

Rules: fix each listed problem, keep the change minimal, stay in scope, run the acceptance command
from .gauntlet-task/bar.md before finishing, and commit your changes. Do not push, add remotes, stash,
reset, rebase, or change git config or hooks. Finish with at most 10 lines: which findings you fixed, which you
could not fix and why, and the acceptance result.
```

### 9.6 Judge prompt

```text
Two candidate solutions to the same task are below, labelled A and B in random order.
You know nothing else about them.

Task: <spec.md contents>
How correctness is checked: <bar.md contents>

Candidate A, diff against the original: <diff A>
Candidate A, check results: <public + held-out output A>

Candidate B, diff against the original: <diff B>
Candidate B, check results: <public + held-out output B>

Choose the one you would merge. Weigh, in order: passes the checks, meets the spec, correctness
on edge cases, simplicity, staying in scope. You must choose exactly one.
Reply in exactly this form:
WINNER: A|B
REASON: <at most three sentences>
```

---

## 10. Open questions for reviewers

Points worth challenging before this is installed:

1. Is a fresh-context judge on the orchestrator's own model blind enough, or should the judge be a
   *different* strong model?
2. Is `stopAfterDefenses = 2` too eager for noisy judges? Would best-of-3 duels be worth the cost?
3. Should step 5.4 (distilling findings) itself go to a mid-tier model once the pattern is trusted?
4. Should the mechanical steps (worktrees, checks, ledger, blinding) move into a helper script so the
   orchestrator can't skip or mis-order them?
5. How should the loop pick `N` and `maxRounds` per task? Fixed defaults, or based on how often
   candidates failed checks in round 1?
