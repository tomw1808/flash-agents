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

You need **Claude Code**, **Node 20+**, and **[Ollama](https://ollama.com)**. About five minutes.

**1. Install the worker runtime and the model**

```sh
npm i -g @deepseek-ai/dsh                # DeepSeek Harness: runs the workers and their sandbox
ollama signin                            # the :cloud model runs on Ollama's cloud, under your account
ollama pull deepseek-v4.1-flash:cloud
```

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
| `flash_apply` | Land a patch from an earlier call (`dryRun` to check it first). |
| `/flash-agents:delegate` | The everyday loop: frame → slice → dispatch → verify → review → fix → apply. |
| `/flash-agents:gauntlet` | Several competing builders, cheap critics, and a blind A/B judged by Claude. For problems with more than one plausible approach and a result you can run. |
| `/flash-agents:setup` | One-time install check and smoke test. |

Pass `mode: "read-only"` for reviews and codebase maps: that call runs in a second process whose
sandbox refuses every write.

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

To watch workers live, set a log file and `tail -f` it — see
[Observing a run](docs/design.md#observing-a-run).

## Honest limits

- **A running worker can't be steered or cancelled** — the harness protocol has no attach or
  cancel. You can watch it; you can't redirect it. The idle timeout is what stops a stuck one.
- **Members of one `flash_batch` share one copy**, so they see each other's edits. Give them
  disjoint files.
- **Gitignored output isn't carried in the patch.** It's named in the result instead.
- **The dispatcher is a cheap model too.** Occasionally it does the work itself instead of
  delegating; that call fails as `NOT_DELEGATED`, nothing from it is kept, and a retry usually works.
- macOS and Linux. Windows is untested.

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
