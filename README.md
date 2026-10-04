# Smart

[![CI](https://github.com/Aaron40776/Smart/actions/workflows/ci.yml/badge.svg)](https://github.com/Aaron40776/Smart/actions/workflows/ci.yml)

**Claude Code, routed to the cheapest model that can do each step well.**

Type a task. `smart` classifies it with Haiku, answers simple questions on the spot, plans big builds with Opus, runs each step on the cheapest capable model (Sonnet by default),
checks the result with your tests and a quick review, and escalates to a stronger model only when a step fails. It is a full-screen terminal UI around [Claude Code](https://docs.claude.com/claude-code),
with the same follow-up context, and shows what everything costs.

## Install

For **Windows 10 and 11**. Needs [Git](https://git-scm.com/download/win), Node.js 22+ and the [Claude Code CLI](https://docs.claude.com/claude-code), logged in (run `claude` once). In PowerShell:

```powershell
irm https://raw.githubusercontent.com/Aaron40776/Smart/main/install.ps1 | iex
```

That clones smart into `%USERPROFILE%\Smart` (`$env:SMART_DIR` picks another folder), builds it and puts `smart` on your `PATH`. **Update** any time with `smart update`.
By hand instead: `git clone https://github.com/Aaron40776/Smart.git`, then in `Smart` run `npm ci`, `npm run build` and `npm link`.
If scripts are blocked, run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once.
If `claude` is not found, set its full path: `$env:SMART_CLAUDE_BIN = "C:\path\to\claude.exe"`.

## Use

```powershell
smart                              # interactive
smart "make me a snake game"       # one-shot: same UI, exits when done
smart -c                           # continue the last conversation in this directory (--continue)
smart --resume                     # continue a failed or cancelled task from its first unfinished step
smart --dry-run "add dark mode"    # show the plan and the model per step, run nothing
smart --model haiku "fix the typo" # force a tier      (--no-plan skips planning, --budget 1.50 caps the cost)
smart -p "fix the typo" | cat      # headless (--print): reply on stdout, progress on stderr (--output-format json for scripts, --verbose for tool calls)
smart --rate "fix the race in worker.js"  # show which model and effort it would pick, and why (calls no model)
smart --no-review "..."            # skip the acceptance review     (--config ./my.json uses another config file)
smart update                       # get the latest version (git pull, install, build)
smart init                         # write a starter smart.config.json (--global: %USERPROFILE%\.smart, for all projects)
smart trust                        # allow this project's smart.config.json to run commands / loosen settings (--remove)
```

In the app: `Enter` sends, `Esc` cancels, `Tab` switches panel, `@path` adds a file and `@folder/` its file list (Tab completes), `\`+`Enter` starts a new line, `↑` recalls earlier prompts.
Replies appear as they are written. In Windows Terminal the tab and taskbar button show progress: steps done, yellow while a plan waits for you, red if a task failed.
While a task runs you can type the next one: `Enter` queues it and it starts when the current task completes (`/usage`, `/cost`, `/diff` work meanwhile).

| Command | |
| --- | --- |
| `/stats` `/usage` `/cost` | spend history, your 5-hour / 7-day account limits, this session's cost |
| `/model haiku\|sonnet\|opus\|auto` | force a model; `/dry` toggles dry-run |
| `/good` `/bad` | rate the last result; `/bad` teaches smart to use a stronger model or more effort for similar work |
| `/undo` `/diff` `/resume` | revert or show the last task's file changes (needs git; also after a restart), continue an unfinished task |
| `/mode bypass\|edits\|plan\|auto` | permission mode (`plan` is read-only) |
| `/new` `/config` `/help` `/quit` | fresh conversation, effective settings, help, exit |

**Plan review** (big builds): `↑↓` select, `Space` skip, `a` add, `d` delete, `J`/`K` move, `m` model, `e`/`i` edit title/instructions (`←→` `Home` `End` `Ctrl+W` while editing), `Enter` run, `Esc` cancel.
The header shows what the plan will likely cost, from what your own steps on each model and effort have cost; model badges and the estimate update as you edit.

## How it saves usage

- A cheap model classifies every task (skipped for routine edits like "fix the typo"); an **easy question is answered by that same call**, a hard one by the model it needs, and "hey" costs one tiny call.
- **Opus plans, Sonnet builds**: big builds get a short plan from Opus (mid-size ones from Sonnet), then each step runs on the cheapest model and effort its rating allows. A hard step goes to Opus. Docs-only changes skip the test run.
- **Model and effort come from a rating**, not a fixed table: local signals in your text, the classifier's opinion and, per plan step, the planner's, blended into a score with a confidence. Routine work runs on Sonnet at low effort, hard work on Opus at medium to xhigh. It also learns which rungs worked for you. `smart --rate "your task"` shows the rating and why, for free.
- Failures **escalate one model at a time**; nothing jumps to Opus by default. Near an account limit, automatic Opus choices drop to Sonnet.
- Follow-ups reuse one Claude Code session, so "now make it red" has the real history (and Anthropic's prompt cache).

Costs shown are what Claude Code reports. Routing rules and every setting: **[ROUTING.md](ROUTING.md)** and [`smart.config.example.json`](smart.config.example.json).

## Safety

- **Permissions.** Steps run with `acceptEdits` by default: Claude Code edits files, and runs shell commands only where your own Claude Code permission rules
  (`permissions.allow` in its settings) allow them. `smart` still runs your checks itself (see below). To let steps run any command unasked, set
  `"runner": { "permissionMode": "bypassPermissions" }` in your global config; `smart` then warns at startup and shows `bypass` in the header.
  `/mode plan` makes a session read-only. Claude Code refuses `bypassPermissions` as root, and `smart` falls back to `acceptEdits`.
- **Checks run project code.** After a step changes code, `smart` runs the project's `typecheck`, `lint`, `build` and `test` scripts from `package.json`
  (or your `verify.commands`). In a repository you do not trust, set `"verify": { "auto": false }` in your global config.
- **A project's `smart.config.json` is not trusted automatically.** Settings in it that would run commands (`verify.commands`), loosen permissions
  (`runner.permissionMode`, `runner.bare`), pass flags to Claude Code (`runner.extraArgs`), move your history files (`trackerPath`, ...) or lift your budget
  caps are ignored, with a warning, until you read the file and run `smart trust` in that directory. Trust covers the file's exact contents: if it
  changes (a pull, another branch), those settings are ignored again. `smart trust --remove` withdraws it. A file you name with `--config` is yours and always applies.
- **Undo.** Run it in a git repository: `/undo` needs one. Details in [ROUTING.md](ROUTING.md#undo-and-safety-net).

## Development

```powershell
npm install
npm run check      # lint + typecheck + tests + build
npm run dev        # run from source
```

Layout and rules: [CONTRIBUTING.md](CONTRIBUTING.md). History: [CHANGELOG.md](CHANGELOG.md). `$env:SMART_DEBUG=1` logs per-call timings to `%USERPROFILE%\.smart\debug.log`; `$env:SMART_E2E=1; npm test -- test/e2e` runs one real Haiku task.

## License

MIT
