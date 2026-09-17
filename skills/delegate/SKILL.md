---
name: delegate
description: >-
  Run a goal through flash workers instead of Claude subagents: frame it, cut it into coherent
  slices, dispatch with flash_task/flash_batch, verify every result yourself, review with a
  read-only worker, fix in rounds until a review finds nothing real, then apply. Use whenever the
  user says "use flash-agents", "fan out", "delegate this", or when a task means reading or
  writing more code than fits a tight token budget. Not for design decisions; those stay with you.
---

# Delegate: you steer, flash workers do the reading and writing

The point of this plugin is to spend a cheap model's tokens instead of yours. So: **no Claude
subagents** (no Explore, no forks, no `/code-review`) for anything a flash worker can do —
mapping a codebase, porting tests, implementing a slice, reviewing a diff. You keep architecture,
acceptance, verification and judgement. Everything else goes out.

## 1. What a worker is

- A DeepSeek Flash worker is roughly a mid-tier thinking model: it implements a coherent feature
  slice correctly, reports honestly (quotes real command output, names what it was unsure about),
  and runs for hours. It **degrades when one session carries many separate points** — give it one
  goal, not a checklist of twenty.
- Every call starts with **zero context**. The task text is all it knows.
- A writing call runs in a **disposable copy** of the repository (uncommitted work included) and
  returns a patch. Nothing reaches the tree until `flash_apply`. Its summary of what it did is not
  evidence; the diff and your own verification are.
- The service root is fixed at the project; `cwd` selects a directory inside it.

## 2. The loop

1. **Frame.** Read what you must to own the design (the docs, the seams a slice will touch — a
   few hundred lines, not the codebase). Write the decisions down where a worker can read them
   (a design doc in the repo is ideal). If the goal needs a map of the code first, that map is a
   read-only worker task, not an Explore agent.
2. **Slice.** Cut the goal into slices with one unambiguous "done" each. A slice is a coherent
   unit of behaviour with its tests, not a file list. Order them by dependency; slices that share
   files run one after another.
3. **Dispatch.** One `flash_task` per slice, or one `flash_batch` for slices that touch disjoint
   files (§4). Write the task with the template in §3.
4. **Verify yourself.** Apply the patch to the working tree (it stays uncommitted), then run the
   project's real gates: the full test suite, the wiring/invariant scripts, a build of every
   target. Read the diff — all of it. A worker that reports green has still only tested its copy.
5. **Review independently.** Send the diff to a **read-only** worker with the review template
   (§5). Merge its findings with yours; keep only what you can confirm from the code.
6. **Fix round.** One task carrying every confirmed defect, each with "add a test that fails
   before and passes after". Apply, verify, review again. Stop when a review pass finds nothing
   real. Expect one to two rounds; three means the slice was framed badly — reframe it.
7. **Commit only when the user asks**, in the repository's own voice.

## 3. Writing a task

```
<Language/toolchain, targets, test framework and its idiom, one line.> Work only in <the files or
modules this slice owns>. Do not touch <what it must not>. No git commits. Read <files> completely
first.

# Goal
<One or two paragraphs: what exists today and why it falls short, what must be true afterwards,
and the rules that must hold (the invariants, the compatibility that matters, the design
decisions already taken). Point at the design doc for the rest.>

# What to build
<The shape in prose plus, where an API is a contract, the Swift/TS signatures. Give latitude on
implementation; be exact on behaviour and on names other slices will call.>

# Tests
<Which suites to extend or add, and the behaviours that must be pinned. "A test that fails before
and passes after" for every defect being fixed.>

# Build and verification
<The exact commands, in order. The worker must run them and paste their output.>

Reply with: files changed (one line each); the public API added or changed as signatures; the
verbatim output of every verification command; anything you deviated from, and why.
```

Rules that held up:

- **One goal per task.** Related fixes go in one task; unrelated goals do not.
- **Name what it must not touch** — including files a sibling in the same batch owns.
- **Give the verification recipe, not just "run the tests".** Compiled projects: cloned build
  state carries absolute paths and is unusable in a copy, so the recipe either removes it first
  (`rm -rf .build` as the task's first step) or uses a scratch build directory inside the copy.
  Toolchains with a sandbox of their own cannot start it inside the worker's sandbox: SwiftPM
  needs `--disable-sandbox` on every `swift build`/`swift test`, or the worker reports
  `Operation not permitted` and cannot verify anything. A cold build in the copy is usually
  seconds to a minute. Keep the recipe in project memory so every task carries it verbatim.
- **Ask for verbatim output** and for a "deviations" section. Workers use both honestly; that is
  where the real information is.
- Use `acceptance` for the one-sentence definition of done; the body carries the how.

## 4. `flash_task` versus `flash_batch`

- A batch is **one call, one shared copy, one patch**: its members see each other's edits. Batch
  only slices whose files are disjoint, and tell each member which files the others own. A
  member's full-suite run may compile a sibling's half-written file and fail once; the worker
  re-runs, and your own verification on the tree is what counts.
- Coupled slices go sequentially, each applied before the next is dispatched.
- Read-only work (maps, reviews) uses `mode: "read-only"`; it cannot change anything and needs no
  patch.

## 5. The review task

Send it read-only with the diff obtainable in place (`git status --short`, `git diff`, `cat` for
untracked files) and the design it implements. Ask, in priority order, for: correctness defects
on inputs the tests do not cover (name the classes: encodings, line endings, empty and oversized
values, duplicates, ordering of columns/bindings, rules that can lose a person's edit); behaviour
changes for existing callers (have it grep the call sites and say whether each still behaves);
assertions that do not match the code. Require file:line, a triggering input, and a confidence
(confirmed by tracing the path / plausible), and an explicit "none found" per category. No style
remarks. Then confirm each finding yourself before it enters a fix round.

## 6. Budgets and what to expect

- Per-task and per-fleet budgets are in `flash.config.json` (an hour and three hours by
  default). A timed-out call still stores the change so far as a patch and names the refusals it
  saw; the tree it used is retired, never recycled.
- A slice of a few hundred lines with tests typically returns in two to six minutes; a coherent
  feature slice in ten to forty.
- `NOT_DELEGATED`: the dispatcher did the work itself instead of delegating; re-run the call.
- Refusals appear in the result's `denials` and in the log with their reason; a worker that hit
  the wall says so in its reply.
- The result's `change.diff` may be truncated; `flash_apply` always uses the stored full patch.
- After editing this plugin's own `lib/`, reconnect the server (`/mcp reconnect
  plugin:flash-agents:flash`); a running one keeps the old code.

## 7. What stays with you

Design decisions, the acceptance bar, reading the diff, running the gates, the judgement on
findings, the commit. If you find yourself delegating a design decision, stop and decide it.
