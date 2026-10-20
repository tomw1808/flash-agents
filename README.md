# Flash Agents

**Let Claude Code steer, and let a cheap model do the reading and the typing.**

Flash Agents is a Claude Code plugin that hands bounded coding work — implement this slice,
port these tests, review this diff, map this codebase — to **DeepSeek V4.1 Flash** workers
instead of Claude subagents. Claude keeps the architecture, the acceptance criteria and the
final review. The workers spend their tokens, not yours.

Every writing job runs in a **disposable copy of your repository** and comes back as a
**patch**. Nothing touches your working tree until you (or Claude) apply it.

```
You ── "add retry with backoff to the API client, with tests" ──► Claude Code (Opus / Sonnet)
                                                                     │ frames the task, slices it
                                                                     ▼
                                                    flash_task / flash_batch  (MCP)
                                                                     │
                                       ┌─────────────────────────────┼─────────────────────────────┐
                                       ▼                             ▼                             ▼
                              DeepSeek Flash worker         DeepSeek Flash worker         DeepSeek Flash worker
                              in a throwaway copy           in a throwaway copy           in a throwaway copy
                                       │                             │                             │
                                       └──────────── patch + diffstat, computed by git ────────────┘
                                                                     │
                                                                     ▼
                                              Claude reviews the diff, runs the tests,
                                              and applies only what it accepts
```

## Why

- **Your Claude budget goes to judgement, not keystrokes.** Reading 40 files to find a seam, or
  writing 1,200 lines of adapter and tests, is exactly what burns a session. A worker does it on
  its own model; Claude reads the result and the diff.
- **Workers can't wreck your tree.** They work in a copy-on-write clone (milliseconds, no extra
  space on APFS/Btrfs/XFS). A worker that runs `rm -rf .` deletes a throwaway copy, and you see
  that as a patch you decline.
- **You get evidence, not a story.** `filesChanged`, `diffstat` and the patch are computed by
  `git` from the copy — never taken from the worker's own account of what it did.
- **Fan-out is built in.** `flash_batch` runs up to 16 independent tasks in one call, four at a
  time, and returns each result in task order.

## What a worker can actually take on

Measured on a 50k-line Swift app, with Claude steering and reviewing:

| Task | Size | Wall time | Outcome |
|---|---|---|---|
| Domain seam: protocol, adapter, injection into two coordinators, fake, tests | 1,250 lines, 15 tests | 30 min | landed after review; one warning fixed by hand |
| Security fix round on an OAuth/MCP client, 11 findings, each with a fail-before/pass-after test | 1,400 lines | 40 min | landed; review still found one flow defect |
| Test-harness rework: parsing, scope policy, schema table, allow-list | 1,500 lines, 29 tests | 37 min | landed unchanged |
| Read-only security review of the same client against the RFCs | — | 25 min | 11 confirmed findings |
| Mechanical split of a 7,000-line file into 16, 41 scripts re-pointed | 7,900 lines moved | ~60 min | complete |

What it gets wrong — and what Claude therefore still reads itself: flow semantics across a
boundary, policy nuance, and anything outside the files it touched. The `delegate` skill
encodes that loop, so Claude does it without being told.

## Install

You need **Claude Code**, **Node 22.19+** (or 24.2+), and **[Ollama](https://ollama.com)**. About five minutes.

**1. Install the worker runtime and the model**

```sh
npm i -g @deepseek-ai/dsh@0.2.0-rc.2     # DeepSeek Harness, the version the profiles are written for
ollama signin                            # the :cloud model runs on Ollama's cloud, under your account
ollama pull deepseek-v4.1-flash:cloud
```

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

It runs the doctor (Node, `dsh`, Ollama, the model, `git`), writes the two worker profiles into
`~/.dsh/profiles` (plus a `flash-orchestrator` preset for dsh's own UI), and proves the pipeline end to end with one real task. Every failing check
prints the exact command that fixes it.

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
| `flash_batch` | Several independent tasks at once; results come back in task order. |
| `flash_apply` | Land a patch from an earlier call (`dryRun` to check it first, `threeWay` to merge one whose context moved). |
| `flash_patch` | Read a stored patch whole, by file, or page by page — for a diff too long for the result. |
| `flash_status` · `flash_result` · `flash_cancel` | Follow, collect, and stop calls started with `background: true`. |
| `/flash-agents:delegate` | The everyday loop: frame → slice → dispatch → verify → review → fix → apply. |
| `/flash-agents:gauntlet` | Several competing builders, cheap critics, and a blind A/B judged by Claude. For problems with more than one plausible approach and a result you can run. |
| `/flash-agents:setup` | One-time install check and smoke test. |

Pass `mode: "read-only"` for reviews and codebase maps: that call runs in a second process whose
sandbox refuses every write — including the writes a build or a test run makes. For a review that
has to build or run tests, use a writing call with `apply: "discard"`: it runs in a throwaway copy,
reports what it changed, and keeps nothing.

Pass `background: true` and a call returns at once with a job id, so Claude can run tests or
review an earlier patch while workers run; `flash_result` collects the result (and can wait for
it), `flash_cancel` stops it. `flash_status` lists running jobs first, then the last few that
ended; a call still waiting for a free copy says so (`queued … waiting for a free tree`).

A long brief can be written to a file and sent with `taskFile` instead of `task` — exactly as
written, once. When a worker stopped partway, `basePatch: <its patchId>` starts the next call
from that work: the patch is applied to the new copy first (merged if your tree moved on), and
the new call's patch holds both, so you apply only the last one. A call whose worker ends with an empty report and no change comes back as
`status: "error"` with `emptyResult: true`, not as a quiet success.

Every result reports the tokens the call used (`usage`), and lists any uncommitted files the copy
started with (`isolation.uncommittedAtStart`). If another session has uncommitted work in the same
tree, `source: "head"` starts the copy from the last commit instead.

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
(`reset --hard`, `push --force`, …), catastrophic deletions, and any write outside the workspace.
Each refusal comes back to Claude with a code and a reason. Details, and the live test that proves
each rule, are in [docs/design.md](docs/design.md#permissions).

## Configuration

The plugin's settings (`/plugin` → flash-agents) cover the worker model, how many copies may be
in flight (each is a process, so this is a memory decision; default 2), and where patches live.
**Any model your Ollama serves works** — smaller local models are just weaker at tool calling.

Limits live in [`flash.config.json`](flash.config.json). The defaults: a call is stopped after
**10 minutes without any activity** (stuck), or 3 hours in total (a ceiling for honest work);
either way, the change so far is salvaged as a patch.

### Per-repository settings

A `.flash-agents.json` at the repository root tunes the disposable copy for that repository. It
is read when the server starts, so restart Claude Code after changing it.

```json
{
  "copyExclude": ["target"],
  "slotEnv": {
    "CARGO_TARGET_DIR": "cache:cargo-target",
    "XDG_CONFIG_HOME": "home:config"
  }
}
```

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
  `port:<base>` gives each slot its own port base (`base + slot × 10`; `port:41000/100` for a
  stride of 100), for test servers that would otherwise share a fixed port. `HOME` and `TMPDIR`
  can't be moved.
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
| cargo, new crates | `~/.cargo` | `CARGO_HOME: "cache:cargo-home"` (downloads once per slot; your `~/.cargo/config.toml` is not seen) |
| cargo, build output | `target/` | `CARGO_TARGET_DIR: "cache:cargo-target"` |
| Go | its build cache and `~/go/pkg/mod` | `GOCACHE: "cache:go-build"`, `GOMODCACHE: "cache:go-mod"` |
| npm | `~/.npm` | `npm_config_cache: "cache:npm"` |
| pip | `~/.cache/pip` | `PIP_CACHE_DIR: "cache:pip"` |

`FLASH_COPY_EXCLUDE` (comma-separated) or `--copy-exclude` add to `copyExclude` for one server.

To watch workers live, set a log file and `tail -f` it — see
[Observing a run](docs/design.md#observing-a-run).

## Honest limits

- **A running worker can't be steered** — the harness protocol has no attach. A background call
  can be cancelled, which stops its runtime and retires its copy (the partial work is not returned);
  the idle timeout is what stops a stuck one.
- **Members of one `flash_batch` share one copy**, so they see each other's edits. Give them
  disjoint files.
- **Gitignored output isn't carried in the patch.** It's named in the result instead — new ignored
  paths under `change.ignored`, and ignored files that already existed and were rewritten or deleted
  (a regenerated `worker-configuration.d.ts`, say) under `change.ignoredChanged`, with a warning to
  regenerate them after applying. Changes deep inside an ignored directory such as `node_modules/`
  are not tracked. The copy is emptied as soon as the patch is stored, build output included.
- **The dispatcher is a cheap model too.** Occasionally it does the work itself instead of
  delegating; that call fails as `NOT_DELEGATED`, nothing from it is kept, and a retry usually works.
- **Copies are separate folders, not separate machines.** Two workers in parallel share ports, the
  keyring and other per-user services: a test server on a fixed port can answer the other copy's
  tests. Pick a free port per run.
- **Parallel slices don't know about each other.** Five workers once picked the same database
  migration number on one day. Give each parallel slice its own range of numbered files, or number
  them yourself at apply time.
- **A nested repository the root's git ignores is read-only in effect**: a worker can edit it in its
  copy, but the change can't travel in the root's patch. Point `cwd` into that repository to work
  on it.
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

No runtime dependencies. [docs/design.md](docs/design.md) has the full contract, the safety
model, every option, what was verified live, and why things are the way they are.

## License

[MIT](LICENSE) © Thomas Wiesner
