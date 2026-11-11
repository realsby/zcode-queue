# zcode-queue

A small file queue that lets Claude Code, a script, or you hand tasks to a
[ZCode](https://zcode.z.ai) Automation. The work runs inside the ZCode desktop
app, and the results come back as files.

One Node.js script, no dependencies. Not affiliated with Z.ai or ZCode.

## Why

ZCode's Start Plan only works inside the desktop app. The standalone CLI
(`zcode -p`) does not offer it, so you cannot call it headlessly. The app can
run **Automations** on a schedule, though. zcode-queue puts a folder between
the two:

```
producer ── zq submit ──> inbox/<id>.md
                              │  ZCode Automation, every few minutes: zq claim (2 at a time)
                              v
                          working/<id>.md ── one subagent per task, in <cwd> ──> outbox/<id>.md
                              │  zq finish
                              v
producer <── zq wait ──── outbox/<id>.json   (written last; the task file is deleted)
```

zcode-queue never calls a ZCode or Z.ai API. All model work happens in the app,
in an Automation you create and control.

## Setup

Requires Node.js 20 or newer and the ZCode desktop app.

```sh
git clone https://github.com/realsby/zcode-queue.git
cd zcode-queue
node zq.mjs init --allow ~/projects     # the folders where tasks may run
node zq.mjs automation                  # prints the Automation instructions
```

In the ZCode app, open **Automations → New** and set:

| Setting | Value |
| --- | --- |
| Project | the queue folder (`~/zcode-queue`, printed by `init`) |
| Model | any model you have, for example Start Plan → GLM-5.3-Flash |
| Repeat | custom, every 5 minutes |
| Permission | Autonomous. If runs stop and wait for approval, use Full access. |
| Instructions | the output of `node zq.mjs automation` |

Also check **Settings → Subagent model**: the tasks run in subagents.

Then try it:

```sh
id=$(node zq.mjs submit --cwd ~/projects/some-repo -m "List the top-level files and say what this project does.")
node zq.mjs wait "$id"
```

An empty run replies "idle". That is the Automation working with nothing to do.

## Commands

| Command | What it does |
| --- | --- |
| `zq init --allow DIR` | Create the queue and add a folder where tasks may run. Repeat `--allow` for more. |
| `zq automation` | Print the instructions for the ZCode Automation, with this script's path filled in. |
| `zq submit --cwd DIR [--mode read-only\|edit] [--title T] (-m TEXT \| --file F \| stdin)` | Queue a task. Prints its id. |
| `zq wait ID [--timeout 600] [--interval 5]` | Wait for a task and print its status and result. |
| `zq result ID` | Print the status and result without waiting. |
| `zq status [--limit 10]` | What is waiting, running and finished. |
| `zq cancel ID` | Remove a task that has not started yet. |
| `zq prune [--days 7]` | Delete finished results older than N days. |
| `zq balance [--json]` | ZCode's token balance: percent left, tokens, plan end. |
| `zq claim`, `zq finish ID --status done\|failed --summary TEXT` | Used by the Automation. |

Exit codes: `0` done, `1` failed or bad input, `2` timed out or not finished,
`3` unknown id. `ZQ_ROOT` selects another queue folder (default `~/zcode-queue`).

`--mode read-only` is the default. Use `--mode edit` for tasks that should
change files or run commands that change state.

## Configuration

`<queue>/config.json`, created by `zq init` (see `config.example.json`):

- `allowed_roots`: a task's `cwd` must be inside one of these. The queue folder
  and the folder holding `zq.mjs` are never allowed, so a task cannot rewrite
  the queue, other tasks, or the script.
- `max_parallel` (2): how many tasks run at the same time. `zq claim` takes a
  lock, so overlapping Automation runs cannot exceed it together. ZCode allows a
  few concurrent requests per user (3 on our plan): 4 parallel tasks gave "user
  concurrency limit exceeded", 3 ran without an error. 3 leaves no room for your
  own ZCode use while the queue is busy.
- `stale_minutes` (90): a claimed task with no result after this time is marked
  failed, which frees its slot. If it finishes later, its result replaces the
  failure and gets a `note` saying it finished late. Raise it for long tasks.

An Automation that runs every minute fills a freed slot within a minute; every run
is one model call, even when the queue is empty. A task that hangs in `working/`
after its work is done holds a slot until it goes stale; `zq finish ID --status
failed --summary TEXT` frees it at once.

## Using it from Claude Code

Add something like this to your `CLAUDE.md`:

```markdown
## Delegating to ZCode
To hand a task to ZCode: `node /path/to/zcode-queue/zq.mjs submit --cwd DIR -m "..."`,
then `node /path/to/zcode-queue/zq.mjs wait ID --timeout 590`. Tasks start within about 5 minutes. Every prompt must
contain all the context it needs: ZCode does not see this conversation.
```

## Safety

- **Anything that can write to `inbox/` can make ZCode run tasks.** The queue
  folders are created with mode `700`. Keep it that way.
- **Read-only is an instruction, not a sandbox.** ZCode applies the
  Automation's permission mode; the `read-only` mode only tells the subagent
  not to change anything.
- **Treat results as untrusted input.** An agent's answer can repeat text from
  the web pages and files it read.
- **Prompts must stand alone.** The worker sees only the task file.

## Token balance

Whenever the ZCode desktop app checks its token balance (for example when you
open its usage view), it writes it to its own log
(`~/.zcode/v2/logs/<date>.log`, the `billing/balance` lines).
`zq balance` reads the newest entry, with no network call and no credentials:

```
$ zq balance
2.9% left: 14.5M of 500M tokens (logged 2026-11-08 13:14:29)
  plan ZCODE WEEKEND BUILD, ends 2026-11-09T01:00:00.000Z
```

`--json` prints `{"at", "remaining", "total", "percent", "plans"}` for scripts:
a producer can stop submitting tasks when the balance gets low. The numbers are
only as fresh as the app's last check (`at`), which can be hours old: open the
usage view to refresh it.
`ZQ_ZCODE_LOGS` selects another log folder. Exit code `2` means no balance was
found (app not running, or not signed in).

The balance is the Start Plan's. When it has ended, the app logs an empty balance and
`zq balance` reports 0%. A pool past its expiry also counts as 0%, even when the last
logged balance still lists tokens in it. When the app has used the Individual Coding Plan since, it
reports `unknown` (`"percent": null`, `"plan": "individual-coding-plan"`): the app
does not log that plan's balance.

## Costs and limits

- Every Automation run is a model call, even when the queue is empty: about
  288 a day at a 5-minute interval. Pause the Automation when you do not need it.
- A task waits up to one interval before it starts.
- Results stay in `outbox/` until you run `zq prune`.

## Tests

```sh
node --test
```

## License

MIT. See [LICENSE](LICENSE).
