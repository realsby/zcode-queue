# The ZCode Automation

The worker side of zcode-queue is one ZCode Automation. Create it once in the
desktop app: **Automations → New**.

| Setting | Value |
| --- | --- |
| Project | the queue folder (default `~/zcode-queue`) |
| Model | any model you have, for example Start Plan → GLM-5.3-Flash |
| Repeat | custom, every 5 minutes (pause it when you do not need it) |
| Permission | Autonomous. If runs stop and wait for approval, use Full access. |
| Instructions | the output of `node zq.mjs automation` |

Check **Settings → Subagent model** too. Tasks run in subagents, and a subagent
on a plan without quota fails.

## Instructions

`node zq.mjs automation` prints these with the real paths filled in. For
reference, with `<zq>` standing for `node /path/to/zq.mjs` and `<queue>` for
the queue folder:

```text
You are the worker for the task queue in <queue>. Follow these steps exactly, then stop.

1. Run this command:
   <zq> claim
   It prints JSON. If "claimed" is empty, reply "idle" and stop. Do nothing else.

2. For every item in "claimed", start one subagent. Start all of them in the same step, so they run in parallel. Wait until all of them have finished.
   Give each subagent this brief, with the values from its item:

   Your task is in the file <prompt_file>. Read it. The text after the front matter is your task.
   Work in this directory: <cwd>
   Mode: <mode>. If the mode is read-only, do not create, edit or delete files, and do not run commands that change anything. The only exception is the result files below.
   When you are done, write your complete final answer as Markdown to <result_file>.
   If you produce other files as output, put them in <files_dir>. Create that folder if needed.
   Reply with a one-line summary of what you did.

3. When a subagent has finished, run:
   <zq> finish <id> --status done --summary "<one-line summary>"
   If the subagent failed or could not finish, use --status failed and give the reason in --summary.
   Keep the summary short and do not use double quotes in it.

4. Only run tasks that "zq claim" gives you. Do not read, change or delete any other files in <queue>.
```

## Why the script does the bookkeeping

Claiming, the parallel limit, recovering stuck tasks and writing the status
file all happen inside `zq claim` and `zq finish`. The Automation only runs two
commands and starts subagents, which a small model follows reliably.
