# Changelog

## Unreleased

**Safety**
- **Steps run with `acceptEdits` by default** (was `bypassPermissions`), in the schema, `smart init` and the example config. `bypassPermissions` still works when
  you choose it; it is shown in yellow in the header, and `/mode bypass` warns.
- **A project's own `smart.config.json` is no longer trusted automatically**: settings that run commands, loosen permissions, pass flags to Claude Code, move
  your history files or lift your budget are ignored (with a warning) until you run `smart trust` there. Trust is tied to the file's exact contents.
- Programs (git, Claude Code, taskkill) are started by absolute path on Windows: a `git.exe` committed to a repository no longer runs when smart opens it.
- Network paths (`\\server\share`), device names and other unsafe paths in model output are refused before the filesystem is touched; secrets (`.env`, keys)
  are not pasted into prompts unless you @mention them; terminal escape sequences in model text are removed before display.
- `/undo` never deletes through a folder that now links outside the project, refuses to overwrite your later edits to the task's files (`/undo force`
  does it on purpose), and reports a file it could not remove.
- `smart update` and the installer never discard local changes (they used to reset `package-lock.json`): they stop and list them; `smart update --stash`
  sets them aside. Dependencies install with `npm ci --ignore-scripts`. The installer can pin a version (`SMART_REF`) and verify a commit (`SMART_COMMIT`).

**Reliability**
- A locked save no longer runs unprotected after 3 s; it is skipped with a warning. Stores are versioned: a newer smart's files are never overwritten.
- A `claude` that never writes anything is ended after `runner.startupTimeoutSec` (120 s); a dead pre-started process is replaced without failing the call.
- `/resume` gives the continuing step the conversation summary and the files earlier steps changed when its session is gone.
- A check that cannot run (command not found) stops the step instead of escalating to Opus; a budget stop is not retried. Learning ignores such failures,
  failures even the top model had, counts `/bad` once per task, and limits one project's weight.
- Exit codes: 0 done, 1 not finished, 2 invalid usage or config, 3 Claude Code unavailable, 4 budget, 5 try later, 6 nothing to resume, 130 cancelled.
  With `-p --output-format json`, stdout is always one JSON document (with `failure` and `exitCode`), also for errors before a task.
- `smart --rate` uses the real router (keyword rules, account-limit downshift, warm cache) and explains what confidence means.

**Tooling**
- `npm run bench`: a reproducible, simulated routing benchmark (plus an optional `--live` mode against real Claude Code).
- CI installs the commit under test, checks that the installer keeps local edits, and checks the npm package contents.

## 0.3.4 (2026-10-01)

- Fix: when keep-alive turns out not to work with your Claude Code (the notice "Keeping Claude Code running between steps did not work here"), the pre-started spare processes for classify, plan and review calls now stop too. They use the same `--input-format stream-json` mode, so an older Claude Code that cannot keep a process alive may not take them either.
- Checked in a full pass over the code: lint, typecheck, 614 tests, the real-Claude smoke test, `smart -p` and the interactive app against the real Claude Code (classifier 1.9 s on a spare with thinking off, coding step and follow-up on the kept-alive process, nothing left running after `/quit`).

## 0.3.3 (2026-10-01)

- **Faster, cheaper classifier**: the classify call that starts every task ran with Haiku's extended thinking and wrote about 750 output tokens for a 60-token answer. It now runs without thinking (`MAX_THINKING_TOKENS=0` for that process only): 3.7 s instead of 9.2 s on average and 217 instead of 759 output tokens over the same 8 tasks, with the same complexity and plan decisions. Without thinking, borderline tasks were rated "hard" less often (a JWT refactor: 1 of 4 runs instead of 3 of 4); the classifier's instructions now say to pick "hard" when unsure, which brought it back to 3 of 4 without moving easy or normal tasks. Coding steps, planning and reviews keep thinking.

## 0.3.2 (2026-09-30)

- **Faster classify, plan and review calls**: they now run on a spare `claude` started ahead of time (the classifier's when smart opens, then one after each such call for the next), so Claude Code's start-up (about 1.3 s per call measured on Windows, where every task starts with a classifier call) happens while you type or while a step runs. A spare costs nothing until it is used and ends with smart; at most three wait at a time. Checked against the real classifier: the same classifications as a normal start. Part of `runner.keepAlive`; `smart -p` does not use spares.
- If keeping Claude Code running between steps does not work on your machine, smart now says so once on screen (and that `runner.keepAlive: false` skips the attempt) instead of only in the debug log.
- `npm audit` is clean again: esbuild (used only to build smart) is pinned to 0.28.2 through an npm override; the advisory concerned esbuild's development server, which smart never runs.

## 0.3.1 (2026-09-30)

- Fix (Windows): a follow-up task whose effort differed from the previous one could wait about a minute. smart replaced the kept-alive `claude` process and started the new one on the same session at once, while the old one was still being ended, and a second forced `taskkill /T` two seconds later could hit a reused process id. The old process is now waited for (up to 3 s) before its session is resumed, and the forced kill is only sent while it is still running. Found in the first real Windows run.
- `SMART_DEBUG=1` also logs when a kept-alive process is given up (`"keepAlive":"given up"`, with the reason and Claude Code's error output), so a fallback to one `claude` per call is visible.

## 0.3.0 (2026-09-30)

- Fix: a kept-alive `claude` process that never answers (an older Claude Code that ignores `--input-format stream-json`) no longer hangs the step: after 30 s without any output it is given up and the call runs the classic way, which is safe because nothing has reached the API by then. A model switch the process refuses or does not confirm within 10 s moves the step to a fresh process on the new model instead of failing it.
- Fix: `smart update` and `install.ps1` install with `npm ci`, which never rewrites `package-lock.json`. `npm install` could rewrite it and then block the next update's `git pull`; a lockfile changed that way is put back before pulling.
- Fix: `/undo` says "restored 1 file" instead of "restored 1 and removed 0 file".
- The test stand-in `test/fixtures/fake-claude.mjs` speaks the kept-alive protocol, so demo runs with `SMART_CLAUDE_BIN` work with `runner.keepAlive` on.
- Fix (Windows): cancelling a task (Esc) or quitting now ends Claude Code's whole process tree (`taskkill /T`), so a dev server or test run it started no longer keeps running.
- **Kept-alive coding process** (`runner.keepAlive`, on by default): coding steps and follow-up tasks of a conversation go to one running `claude` process (`--input-format stream-json`) instead of starting Claude Code for every step. Measured: a follow-up message took 1.4 s against 3.1 s, at the same cost. The model is switched on the running process; another effort or permission mode gets a fresh one; a process that cannot be kept alive falls back to one `claude` per call; cancelling ends it; idle ones end after 10 minutes. Claude Code reports usage as running totals per process, so each message's own usage and cost are the difference.
- Refactor: `src/core/pipeline.ts` is split into `src/core/pipeline/` modules (calls, changes, limits, session, steps); behaviour unchanged.

- **Cost estimate before you approve a plan**: the review header shows `≈ $0.42 if every step passes first time`, from the median cost of your own recent clean steps on each model and effort (a rough guess, marked as such, until you have a few). `--dry-run` prints it too.
- **Plan review follows your edits**: badges, routing reasons and the estimate are recomputed after every change (a model you pick with `m`, rewritten instructions, a step you add). Text editing has a real cursor: `←` `→` `Home` `End`, `Ctrl+W`, `Ctrl+U`.
- **`/good` and `/bad`** rate the last result. A `/bad` result counts as a miss for its model and effort in the learning, so similar work leans to a stronger model or more effort.
- **`@folder/`** attaches the folder's file list (git's view, up to 150 files) so the model knows what is there; folders appear in `@` completion. A folder outside the project is ignored.

- **Live replies**: coding steps and longer answers stream word by word (`--include-partial-messages`) instead of appearing block by block. The output panel caches the wrapping of every line, so streaming re-wraps only the line that grows.
- **Overloaded servers**: an "overloaded" or temporary server error from Anthropic's API makes `smart` wait (15 s, then 45 s) and retry the same call, instead of counting a failed step and escalating to a bigger model. Still overloaded: the task stops and stays resumable.
- **Hard budget cap**: every coding call gets what is left of the task budget as its own `--max-budget-usd`, so `--budget` can no longer be overshot by one long step.
- **Faster snapshots**: Git's untracked-file cache is used for the `/undo` snapshots, and the end-of-task snapshot is skipped when nothing ran after the last step's. A snapshot slower than 4 s is pointed out once with the fix (`git config core.fsmonitor true`).

- **Install and update in one command**: `irm https://raw.githubusercontent.com/Aaron40776/Smart/main/install.ps1 | iex` checks Git, Node.js 22+ and Claude Code, then clones, builds and links smart; `smart update` pulls, installs and rebuilds. CI parses the installer with Windows PowerShell 5.1 and runs it.
- **Progress on the taskbar**: in Windows Terminal the tab and taskbar button show how far a task is, turn yellow while a plan waits for your approval and red when a task failed.
- Fix (Windows): a folder spelled with different capitals (`C:\Users\Me\app` vs `c:\users\me\app`) no longer loses its conversation, `/resume` task and `/undo` history. Entries saved under another spelling are still found.

- **Windows 10/11 only**: CI runs on Windows (Node 22 and 24) and the docs are written for PowerShell. The README's install commands no longer use `&&`, which Windows PowerShell 5.1 (the default on Windows 10/11) rejects.

- **Cheaper long conversations**: once the Claude Code session has grown past `session.maxContextTokens` (default 80k tokens), the next task starts a fresh session with the conversation summary. Every turn of every step re-reads the whole session, so long chats used to make each step dearer. The size is measured from Claude's own usage report.
- **Faster plans**: steps before the last run the quick checks (typecheck, lint, build); the test suite runs after the last step, where anything an earlier step broke is still caught and fixed. `verify.testEveryStep: true` restores tests after every step; your own `verify.commands` always all run.
- **Config**: your global `~/.smart/smart.config.json` and a project's `smart.config.json` are merged (the project wins key by key). A project file used to hide your global settings completely. `smart init` now writes a small starter with notes instead of every default (which pinned them all, so improvements to the defaults never reached you); `smart init --global` writes your global one. `"//"` keys are allowed as comments.
- `--model <tier> --no-plan` no longer spends a classifier call: nothing it says would change what runs.
- Page Up / Page Down scroll the output while typing, without switching panels.
- Fix (macOS and other symlinked paths): a file Claude reported through a symlinked folder (macOS `/var` is `/private/var`) was listed as `../../…/src/a.ts` instead of `src/a.ts` in the files a step touched. Found by the new macOS CI.
- Node.js 22 or newer is required (Node 20 reached end of life in April 2026); CI runs on Linux, Windows and macOS with Node 22 and 24.

- **Usage limit reached**: Claude refusing a call because your 5-hour or weekly limit is used up now stops the task at once. It used to count as an ordinary failure: a retry, then escalation to a bigger model, each refused again. `smart` says when the limit resets (from Claude's message or the last reported window) and keeps the task for `/resume`, also when it happened in the first step (a task that failed before any step finished could not be resumed).
- **`/undo` is safer and survives restarts**: it reverts only the files the task changed (it used to revert every file that differed, including your own later edits to other files and files you created). The last 20 tasks are remembered per directory, so `/undo` and `/diff` work after quitting and starting `smart` again, and after `/new`.
- **Type while a task runs**: `Enter` queues the next task, which starts when the current one completes (not after a failure; `Esc` cancels both). Read-only commands such as `/usage`, `/cost` and `/diff` work meanwhile. `@file` completion now picks up files created during the session.
- Answers: a question the classifier rated easy keeps its answer instead of being re-asked, and keyword rules (`deadlock` → Opus) no longer apply to questions: "what is a deadlock?" was being re-answered by Opus.
- Checks run with the project's package manager (`packageManager` field, else `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`; npm when that tool is missing).
- Faster: the output panel no longer re-wraps its whole log on every token update, `/stats` reads the history file once instead of on every frame, the history file is written compactly (about 40% smaller) and re-parsed only when it changed, and on Windows the `claude` executable is looked up once instead of on every call.

- Fix (Windows): the file lock that keeps several smart sessions from overwriting each other's history could let two of them run unlocked, because Windows reports "directory is being deleted" as EPERM/EACCES/EBUSY instead of "exists"; that is now retried, as is a briefly busy lock removal. Found by CI on `main` (one of 32 concurrent history entries lost on Windows/Node 22).
- Speed: a lone edit rated easy ("fix the typo in the readme") is no longer sent to the reviewer: in a live run the review call took 11.6 s, longer than the 9.3 s edit, for nothing to check. Plan steps and anything not rated easy are still reviewed.
- **Every phase picks its own model and effort.** Classify: routine one-line edits ("fix the typo in the README") are recognised locally and skip the classifier call (`routing.fastLane`). Answer: an easy question is still answered by the classifier; a question the rater scores 0.25 or more goes to the model and effort it picks in one tool-free call (Sonnet capped at medium effort unless you pin `runner.effort.sonnet`). Plan: the notice now names the planner's model and effort. Review: Haiku normally, Sonnet at low effort for a step rated as hard as Opus work.

- **The rater** replaces the fixed "complexity → model" table. Every task and every plan step gets a 0..1 difficulty score from three opinions (local signals in the text, the classifier's complexity and difficulty, and the planner's own per-step rating) and a confidence, and is placed on a cost ladder: Haiku, Sonnet low/medium/high, Opus medium/high/xhigh. It leans up when the opinions disagree, uses the local signals alone if the classifier fails, and learns from your own history which rungs passed first time (one rung up after repeated failures, one effort level down after a long clean run). `routing.optimize` (`cost`/`balanced`/`quality`) shifts the boundaries, the per-complexity tiers are now floors, and `smart --rate "task"` shows the rating and reasons without calling a model. The routing reason now leads with the verdict.
- Correction: Opus is about 2x Sonnet per token (measured), not 5x as an earlier note here said.
- Cheaper planning: mid-size multi-part tasks are now planned by Sonnet (`routing.plannerLight`, about 2x cheaper and somewhat faster in a live comparison: $0.016 vs $0.033 for the same plan), Opus only plans big builds and `hard` tasks. Plans are steered towards fewer, larger steps (`limits.maxPlanSteps` default 8 to 6). A change that only touches prose or images skips the project checks.
- Docs can no longer drift from the code: tests compare `smart.config.example.json` (and so `smart init`), the README, ROUTING.md, CONTRIBUTING.md, `/help` and the command-line flags with the real settings, commands and files. The example config was missing `routing.reviewer`, `review` and the three file paths; the README was missing `--config`, `--continue`, `--print`, `--verbose` and `--no-review`.

- Tidy: README cut from 183 to about 80 lines (details live in ROUTING.md, which now also covers effort, faster start-up and undo); `PLAN.md` (the original build plan, long out of date) removed; file-backed stores grouped in `src/core/store/` with one shared atomic-write helper instead of four copies; `/config` also shows effort and lean-call settings.
- Speed: a greeting ("hey", "thanks") is answered by one short tool-less Haiku call instead of classify + a full Claude Code session (about 8 s down to 3 s here, and far more where plugins, hooks or MCP servers slow every `claude` start-up). Classify, plan and review calls also start `claude` lean (no hooks, plugins, MCP servers or skills; `runner.leanCalls`, on by default, with an automatic fallback if that breaks login).
- Routing: the classifier also rates difficulty and answers pure questions itself (one Haiku call in total, no coding session); a `hard` single task goes straight to Opus (steps of a written plan stay on Sonnet). The git snapshot now runs while the classifier and planner work instead of before them.
- Auto effort: each coding step gets a thinking-effort level chosen from the task (low for trivial/small edits, medium for multi-file and large builds, one higher on Opus and on retries; planner high for large builds; none for Haiku). `runner.autoEffort` (default on); an explicit `runner.effort` still wins. Shown next to the model in the plan.
- `SMART_DEBUG=1` writes per-call timing (start-up, first text, total) to `~/.smart/debug.log`.
- Fixes from a full code review:
  - Ending a task (Esc, Ctrl+C, an error, one-shot mode) now saves its state (cost record, `/resume`, `/undo` checkpoint) *before* the frontend is told it is over, and quitting waits up to 3 s for that; a greeting can no longer overwrite an unfinished task; a new task can start from the terminal event without "already running".
  - `/undo` and `/diff` only cover the directory smart runs in (in a monorepo they used to see, and could restore, sibling packages); `/diff` ignores external diff tools.
  - Calls that end in an error (max turns, budget) still count towards totals and the per-task budget.
  - Several smart sessions no longer overwrite each other's history, conversations and prompt history (lock file).
  - Stale account limits (a window that has already reset) no longer force Sonnet; the header shows the real permission mode; replies, help and diffs are shown in full instead of cut at 8 lines; scrolling stops at the first line; long plans scroll in the checklist; `@app/[id]/page.tsx` mentions work; an empty new plan step cancels itself; `-p --output-format json` reports a failed step in `error` and resumed steps as done; startup errors are visible instead of wiped with the alternate screen; file lists skip `node_modules`/`dist` and stop at the limit.
- Removed the estimated-savings comparison from `/stats` and `/cost`, the `pricing` setting (old configs that still have it load without a warning) and the `npm run bench` harness: they compared list prices, not real usage.
- Repo renamed to `Smart`: URLs, badge and clone instructions updated.
- `/resume` and `smart --resume` (also `smart -p --resume`): continue a failed or cancelled task from its first unfinished step, without re-classifying or re-planning. The approved plan and finished steps are saved with the conversation.
- Plan review: add (`a`), delete (`d`) and reorder (`J`/`K`) steps; multi-line instructions (`Alt+Enter` or `\` + `Enter`).
- `SMART_E2E=1` real-CLI smoke test.
- README: install from a clone (the package is not on npm yet).

## 0.2.0

First complete release: a Claude Code wrapper with smart model routing.

- Classify (Haiku) → plan (Opus, only when worthwhile) → route each step to the cheapest capable model (Sonnet by default) → verify → escalate on failure.
- Conversation continuity: one persisted Claude Code session per conversation (`--resume`), `-c` to continue, `/new` to reset, self-healing if the session is gone.
- Usage: `/stats`, `/usage` (5h/7d account windows), `/cost`, live header meter, limit-aware routing, `--budget`.
- Quality and safety: acceptance review, git shadow checkpoints with `/diff` and `/undo`, permission modes (`/mode`), config warnings.
- QOL: `@file` mentions with completion, multi-line input, persistent prompt history, slash-command completion, `smart init`.
- Headless `-p` mode with `--output-format json`, stdin tasks and stable exit codes (0/1/130).
- Layout: no flicker (measured), adapts down to very small terminals; plan review always shows title, list and details.
- Windows: `claude.exe` / npm shim detection, process-tree kill, CI on Ubuntu and Windows (Node 20/22).
