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

- A DeepSeek Flash worker is a mid-tier thinking model, and it is more capable than "flash"
  suggests. Measured on a 50k-line Swift app (2026-09-17): a 1,250-line provider seam with a
  fake, 15 tests and three re-pointed scripts in 30 min; an 11-finding security fix round, each
  finding with a fail-before/pass-after test, in 40 min; a 1,500-line harness rework with 29
  tests in 37 min; a 7,000-line file split into 16 files with 41 grep-based scripts re-pointed
  (it hit the hour budget, and the salvaged patch was complete). It reports honestly — real
  command output, real counts, a "caveats" section that is where the information is.
- What it reliably gets wrong, and therefore what your review must read: **flow semantics**
  across a boundary (an OAuth callback that carried the server's *decline* was treated as noise
  and left the command waiting for its timeout), **policy nuance** (an allow-list redactor
  blanked the one string that explains a failure), **warnings outside its own files**, and
  **checks that go stale** when a second code path appears next to the one a script greps for.
  Its diff is right; its model of the whole is not. Read the core of a slice — the state
  machine, the auth flow, the classification switch — yourself, every time.
- It **degrades when one session carries many separate points**: one coherent goal with up to
  about six numbered sub-goals works; a checklist of twenty does not. A task text of 800–1,500
  words is the working range.
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
   target, the mutation controls where the project has them. Read the diff — all of it, and the
   semantic core twice (§1). A worker that reports green has still only tested its copy, and
   "no warnings in the files I created" says nothing about the files it changed.
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

- **One goal per task.** Related fixes go in one task; unrelated goals do not. A fix round with
  ten findings is one goal ("make these ten things true, each with a test"); a feature plus a
  refactor plus a doc rewrite is three.
- **Decide the architecture in the task, not in the worker.** Give the protocol signatures, the
  type names other slices will call, the contract each type must express, and the mapping rules
  (which error becomes which case, and why). The worker implements a decision well and invents
  one badly.
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
- **Two `flash_task` calls in parallel** is the other shape: each gets its *own* copy and its own
  patch, so two slices on disjoint files can run at once (the service has two slots). A copy
  is taken from the working tree at dispatch, uncommitted work included. Apply the patches in
  either order; a commit in between does not matter as long as the files are disjoint. Keep a
  note of which files each running worker owns so the next task you write does not touch them.
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
  feature slice of 1,000–1,500 lines with tests in thirty to forty; a fix round of ten findings
  in thirty to forty. A large mechanical job (a multi-thousand-line split with scripts to
  re-point) can hit the hour: the salvaged patch is still complete, but take it only after
  checking for transient artefacts — a snapshot taken while the worker's own mutation-controls
  run had a file mutated carried that mutation into the patch once.
- In Claude Code the call moves to the background after two minutes and the result arrives as a
  task notification; keep steering (write the next task, review the previous patch) rather than
  waiting. The idle abort at 30 minutes is covered by progress notifications and the plugin's
  own timeout, but a long call still needs the server reconnected after any plugin edit.
- `NOT_DELEGATED`: the dispatcher did the work itself instead of delegating; re-run the call.
- Refusals appear in the result's `denials` and in the log with their reason; a worker that hit
  the wall says so in its reply.
- The result's `change.diff` may be truncated; `flash_apply` always uses the stored full patch.
  Review on the tree after applying (`git diff`), not from the truncated result.
- A read-only worker is a good security reviewer of a bounded surface: given an OAuth/MCP client
  and RFC citations it returned eleven real findings in one pass. It is not a substitute for
  your own read of the same surface; the two lists differ, and both matter.
- After editing this plugin's own `lib/`, reconnect the server (`/mcp reconnect
  plugin:flash-agents:flash`); a running one keeps the old code.

## 7. What stays with you

Design decisions, the acceptance bar, reading the diff, running the gates, the judgement on
findings, the commit. If you find yourself delegating a design decision, stop and decide it.
