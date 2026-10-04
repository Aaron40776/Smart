# How `smart` routes tasks (and how to tune it)

`smart` never guesses a model name. Every model it uses comes from `smart.config.json`, and every routing
decision is shown in the UI with its reason, verdict first: `sonnet · medium · rated 0.41 · 78% sure (3 files, 2 parts; multi_file, normal)`.
To see one without running anything: `smart --rate "your task"`.

## The pipeline

1. **Classify** (cheap model, default Haiku). Scores your prompt as one of four complexities, says whether it needs a plan and how hard it is (`easy`, `normal`, `hard`). Clearly routine one-line edits ("fix the typo in the README", "rename x to count") are recognised locally and **skip this call entirely** (the fast lane, about 5 s saved; `routing.fastLane`). Greetings ("hey", "thanks") skip it too.
2. **Answer**, if the prompt is a pure question that needs none of your files, tools or current information. An easy one is answered by the classifier in the same call (one Haiku call in total). A question the classifier does not rate easy and the rater scores 0.25 or more is answered by the model and effort it picks, in one more tool-free call: still no coding session. Keyword rules do not apply to answers (they are about doing the work: "what is a deadlock?" is not Opus work).
3. **Plan**, only when the task needs one (a large build always does; `--no-plan` turns this off). Big builds and requests rated hard are planned by Opus (`routing.planner`); mid-size, multi-part changes by Sonnet (`routing.plannerLight`): about 2× cheaper (measured $0.016 vs $0.033 for the same plan) and somewhat faster, and plenty for a short plan. The planner also rates each step `easy`, `normal` or `hard`. Plans are kept to a few substantial steps (`limits.maxPlanSteps`, default 6), because every step is a separate Claude Code call.
4. **Rate and route** every step: the rater (below) picks a model and an effort.
5. **Execute** each step with a lean prompt, then **verify** it (tests, lint, build; not for docs-only changes) and **review** it. The reviewer is Haiku, or Sonnet at low effort for a step rated as hard as Opus work: a weak model cannot check work it could not do.
6. **Escalate** a step that keeps failing: one more try with more effort, then the next model up.

## The rater: which model, which effort

Two things cost money: the model (Opus is about 2× Sonnet per token; measured) and how long it thinks (effort). Effort changed cost only slightly on short prompts and mostly buys quality, so the ladder spends effort first and the bigger model next:

| rung | when the score is | |
| --- | --- | --- |
| haiku | below 0.12 | only where `routing.<complexity>` allows Haiku (questions by default) |
| sonnet · low | 0.12 to 0.25 | routine edits |
| sonnet · medium | 0.25 to 0.45 | ordinary features |
| sonnet · high | 0.45 to 0.62 | bigger, multi-part work |
| opus · medium | 0.62 to 0.80 | hard problems |
| opus · high | 0.80 to 0.92 | very hard |
| opus · xhigh | above 0.92 | the hardest |

`smart --rate "task"` shows the decision as a real run would make it without the classifier and planner: the model and effort, which rule decided
(a keyword rule, the rater, a session rule), the score and the signals behind it, the floor, what your history changed, and whether the account-limit
or warm-cache rule applies in this folder right now.

The score (0 = routine, 1 = hardest) blends three independent opinions:

- **Local signals**, read from the text at no cost: what the work is about (concurrency, security, architecture, algorithms, intermittent bugs, performance, migrations, work across many files: harder; typos, renames, comments, formatting: easier), stack traces, questions that change nothing, how many files, parts and words. Several hard signals count with diminishing weight.
- **The classifier** (complexity and difficulty), a cheap model's read of what the request means. It runs without extended thinking: in a comparison over the same tasks that made it 2.5x faster (3.7 s against 9.2 s on average, 217 against 759 output tokens) with the same complexity and plan decisions, and its instructions say to pick "hard" when unsure, which kept borderline tasks as cautious as with thinking.
- **For a plan step, the planner's** own rating of that step. The task's difficulty does not spread to every step, so a plan can mix a Sonnet scaffold step and an Opus concurrency step.

When they disagree the score leans towards the higher one (a retry and lost time cost more than a somewhat pricier model), and the confidence drops. Confidence is also low near a rung boundary. The percentage is a heuristic (do the signals agree, and is the score clear of a boundary), not a calibrated probability. If the classifier failed, the local signals still rate the work. Local signals are keyword based and can misfire on a plan step ("scheduler" reads as an algorithm), which is why the planner's rating carries 60% of a step's score.

The per-complexity settings (`routing.trivial`, `small_edit`, `multi_file`, `large_build`) are **floors**: the rater can go up from them, never below. `routing.optimize` shifts the boundaries: `cost` needs stronger evidence before a bigger rung, `quality` less (by 0.06).

**It learns from your history.** Each step records the rung it was rated at and whether it passed first time. If a rung passed first time in under about 72% of your last-30-days steps in the same score band (after at least 6), the next similar step goes one rung up; after 15 near-perfect steps, one effort level down on the same model. The reason says so (`history: sonnet · medium passed first try in only 4 of 9 similar steps`). No model is called for any of this.
It does not learn from failures that are not the model's: a check that could not run, a budget or usage limit, a cancel, a timed-out check, or attempts
lost to Claude Code not starting. A step that failed even after escalating to the top model is left out too (a stronger start would not have
saved it, and an already red test suite looks the same), and one project counts with at most its 10 most recent steps per rung, so a single
troubled repository cannot raise costs everywhere. Whatever the history says, it moves a choice by one rung at most.
`/bad` after a task tells it the result was wrong even though its checks passed: it counts as one miss for each rung the task used, so similar work leans to a stronger model or more effort. `/good` confirms a result.

**Cost estimate.** The plan review shows what the plan will likely cost if every step passes first time: per step, the median cost of your own recent
clean steps on the same model and effort (at least 3; last 60 days), or a rough built-in guess until you have them (marked "rough"). `--dry-run` prints it too.

**How good is it?** On 30 prompts I labelled while tuning it, 30 land in the expected range; on 20 written beforehand and not tuned on, 18 do (both are in `test/fixtures` and run in the tests). The labels are one person's judgement and the prompts are short, so treat that as a regression net, not proof: run `smart --rate` on your own tasks and adjust `optimize`, the floors and `keywordRules`.

**Benchmark.** `npm run bench` runs a reproducible, simulated benchmark (`bench/routing/`): 18 representative tasks (typo, question, bug fix,
feature, large build, architecture, security, concurrency, performance, investigation, migration, docs-only, ambiguous, a task that needs escalation,
one where the checks catch a wrong result, ...) through the real pipeline (classifier handling, rater, escalation, checks, review, cost accounting),
with a stand-in for Claude Code. It compares smart's routing with always Haiku, always Sonnet, always Opus and pinned-effort baselines on success,
first-try success, retries, escalations, the model and effort chosen, tokens, cost and time; `--seeds N` repeats it, `--json FILE` saves every run.
The stand-in follows written-down assumptions (`bench/routing/sim.ts`: how hard a step each model and effort gets right, prices, speed, how often a
reviewer catches a wrong result), so its numbers show how the routing logic behaves under those assumptions, not how good real models are; thresholds
are not tuned against it. `npm run bench -- --live` runs the tasks that have fixture files with the built smart and the real Claude Code instead
(it costs money and varies from run to run). CI runs the simulation only, as tests of its reproducibility and internal consistency.

Under the current assumptions (20 seeds) smart and always-Opus both finish about 98% of tasks, smart at about 6% lower cost; always-Sonnet finishes
about 74%. Most of smart's extra cost and time sits in hard tasks the classifier underrates (they start on Sonnet and escalate). Treat these as
properties of the model in `sim.ts`, and check them with `--live` on your own kind of work before drawing conclusions.

After a failed attempt the same model is retried one effort level up (Sonnet stops at high, Opus at xhigh); after escalating to a stronger model, that model's effort for the score plus one.

## Precedence

For each step, the first rule that applies decides the **model**; effort still follows the score.

1. **Forced model**: `--model <tier>` or `/model <tier>`. It applies to every step and to the planner, and a forced model is never escalated away from.
2. **Your per-step choice** on the plan approval screen (press `m`).
3. **Keyword rules**: `routing.keywordRules`, case-insensitive regexes matched against the step text (or your prompt, when there is no plan). First match wins. The default rule sends `architecture`, `race condition` and `deadlock` to Opus.
4. **The rater**, above.

If the classifier output is unusable the rater works from the text alone, with Sonnet as the floor. When an account limit is nearly used up (`usage.downshiftAt`), automatic Opus choices are downshifted to Sonnet. Forced models and your per-step choices are never changed.

## Conversations and follow-ups

`smart` keeps one conversation per run, like Claude Code:

- **Coding steps** run in a persisted Claude Code session (`--session-id`, then `--resume`) shared by all steps and all follow-up tasks,
  so the model sees the real history, its own earlier tool calls, and the files it read.
- **Classifier and planner** are stateless (no tools, no transcript). They get a compact memory instead: for each earlier task, the request,
  outcome, plan summary, files changed, and your last reply. That is what lets "make it red" be classified and planned correctly.
- `smart -c` continues the last conversation for the current directory (stored in `%USERPROFILE%\.smart\conversations.json`); `/new` forgets it.
- If Claude Code no longer has the saved session, `smart` starts a new one and puts the memory summary in the prompt.
- `session.resume: false` turns the persisted session off: every step is stateless and gets the memory summary in its prompt instead.
- A session that has grown past `session.maxContextTokens` (default 80k tokens) is replaced by a fresh one at the next task, which gets the
  memory summary instead. Every turn of every step re-reads the whole session, so a long chat otherwise makes each step dearer. `0` never rotates.

**Model switches and the prompt cache.** Anthropic's prompt cache is per model. Resuming a long session on a *different* model re-reads the whole
history at full price (I measured $0.18 vs $0.025 for the same follow-up). So for follow-up tasks, while the session is warm
(`session.cacheTtlSec`, default 300), automatic routing will not downgrade to a model that has no warm cache in this conversation; the reason
shown says `kept sonnet`. Upgrades, `--model`, your per-step choice on the approval screen and keyword rules always apply, and steps within one plan are always routed on their own merits.
Set `session.keepWarmTier: false` to disable.

## Review: a quality gate that works without tests

Automated checks (below) only exist when the project has them. So after every plan step, `smart` also asks a cheap reviewer model (`routing.reviewer`,
default `haiku`) whether the step's **acceptance criteria** are met by the files it changed. Single-step tasks are reviewed only when no check ran, and never when the edit is rated easy (a typo or rename: the review call took longer than the edit itself, 11.6 s vs 9.3 s in a live run).
The reviewer is told to fail only for concrete, verifiable problems (unmet criterion, syntax error, missing function), never for style. A "fail" feeds
the same retry-then-escalate loop as a failing test. It costs a few cents per step; set `review.enabled: false` to skip it, or `routing.reviewer: "sonnet"` for a stricter one.

## Usage limits

Claude reports your account's 5-hour and 7-day usage on every call. When any window reaches `usage.downshiftAt` (default 0.9), *automatic* routing and
planning use Sonnet instead of Opus, with the reason shown (`5h limit at 93% so using sonnet instead of opus`). Forced models, your per-step choice, and
escalations after a failing step are never downshifted. Warnings appear once per window at `usage.warnAt` (default 0.8) and at 95%.

## Escalation

After a step runs, `smart` runs your checks. If they fail:

1. retry on the **same model** (`escalation.retriesPerModel`, default 1), with the failing output added to the prompt;
2. then move **one tier up** `escalation.ladder` (`haiku → sonnet → opus`) and repeat;
3. if the top model also fails, the step fails and later steps are not run.

Not every failure is the model's, and those do not climb the ladder: a check that cannot run at all (command not found, exit 127 or 9009)
stops the step at once with a message saying what to install or adjust (then `/resume`); a call Claude Code stopped at the budget is not
retried; a Claude Code that never started gets one more try on the same model. A check that runs out of time (`verify.timeoutSec`) is
retried like a failure, since the work itself may hang. `-p --output-format json` reports which it was in `failure.kind`.

Checks are auto-detected from `package.json` scripts, in cheapest-first order: `typecheck`, `lint`, `build`, `test`
(npm's placeholder test script is ignored). They run with the project's package manager: `packageManager` in `package.json`, else the lockfile
(`pnpm-lock.yaml`, `yarn.lock`, `bun.lock`), else npm (also when that tool is not installed). Other languages are not guessed, because a first
`cargo check` or `go vet` can take minutes and a timeout would count as a failed step: set `verify.commands`, for example `["pytest -q", "ruff check ."]`.
In a plan, the steps before the last get the quick checks (typecheck, lint, build) and the last step also runs `test`: a test suite is often the slow
part, and anything an earlier step broke still fails there and is fixed before the task counts as done. `verify.testEveryStep: true` runs the tests
after every step; your own `verify.commands` always all run.
A question that changed no files is not verified, and neither is a change that only touched prose or images (`.md`, `.txt`, `.png`, ...): there is nothing for a build or test to break. Config files such as `package.json` are still checked.

## Tuning

`smart init` writes a small `./smart.config.json`, `smart init --global` one in `%USERPROFILE%\.smart\` for all your projects. Put in only the settings you change
(every setting and its default: `smart.config.example.json`); the rest keeps the defaults, including future improvements. A project's file applies on top
of your global one, key by key, so it only needs what differs. `"//"` keys are notes and ignored. `--config <path>` takes the project file's place.

**Spend less**
- Send more work to a cheaper model: `"routing": { "multi_file": "haiku" }`.
- Escalation is your safety net, so an aggressive downgrade costs little when checks exist. Without checks there is no signal to escalate on, so keep Sonnet.
- Lower `limits.maxPlanSteps` (default 6). Every step is a separate Claude Code call, and each call carries Claude Code's own base context.
- Set `limits.maxBudgetUsdPerStep` to cap a runaway step.

**Cap spending**: `limits.maxBudgetUsdPerTask` (or `--budget`) stops a task once its total cost reaches that many dollars; `limits.maxBudgetUsdPerStep` caps one step.
Each coding call is given what is left of the task budget as its own limit, and Claude Code stops a call that goes over, so a single long step cannot run far past the cap.

**Effort**: chosen per step by the rater (see above; `runner.autoEffort`, on by default). Pin a level per model with `"runner": { "effort": { "haiku": "low", "opus": "high" } }` (levels: low, medium, high, xhigh, max); a pinned level always wins. `"autoEffort": false` leaves Claude Code's default. The Opus planner runs at `high` for big or hard-looking requests and `medium` otherwise.

**Faster start-up**: `runner.keepAlive` (on by default) keeps one `claude` process running per conversation for the coding steps: the next step or
follow-up task goes to the running process (the model is switched on it when routing picks another) instead of waiting for Claude Code to start again.
Measured here: a follow-up message took 1.4 s on the running process against 3.1 s with a new one, at the same cost. A different effort or permission mode
gets a fresh process; calls with JSON output, a per-call budget or a lean start still run one `claude` each; if a process cannot be kept alive, smart
goes back to one `claude` per call. An idle process ends after 10 minutes and when smart exits.
The short tool-less calls (classify, plan, review, answers) use a spare `claude` started ahead of time: one for the classifier when smart opens,
and after each such call one for the next call of the same kind (at most three). A spare waits for its message and costs nothing until then, so
Claude Code's start-up (about 1.3 s per call on Windows) happens while you type or while a step runs. In the debug log these calls show as
`"session":"warm none"`. `runner.keepAlive: false` turns spares off too; `smart -p` does not use them.
A `claude` that writes nothing at all within `runner.startupTimeoutSec` (default 120 s) of starting is stuck before reaching the model (a login prompt,
a hanging hook or MCP server) and is ended; the task stops and stays available for `/resume` (a long step is never cut off: it keeps reporting progress).
A pre-started spare that has died is replaced by a fresh `claude` for that call, without counting as a failure.
`runner.leanCalls` (on by default) starts the tool-less classify, plan and review calls without your hooks, plugins, MCP servers and skills. `$env:SMART_DEBUG=1` writes one line per
`claude` call to `%USERPROFILE%\.smart\debug.log` (start-up, first text, total) so you can see whether a slow call is Claude Code's own start-up or the model.

**Get better results**
- `"routing": { "large_build": "opus" }` or `"multi_file": "opus"` for harder work.
- Add keyword rules for the areas where you want the strongest model:
  `{ "match": "auth|payment|migration|concurren", "tier": "opus" }`.
- Raise `escalation.retriesPerModel`, or set it to `0` to escalate immediately.

**Use different models**: change `models`. Values are passed to `claude --model`, so aliases (`sonnet`) and full model IDs both work.

## Undo and safety net

In a git repository, `smart` snapshots the project directory before and after each step using a private temporary index: your index, branches and history are never touched
(only a few unreferenced objects are added, which `git gc` removes). That finds every changed file, including ones made by shell commands, shows a per-task summary
(`Changed 3 files (+120 −4)`), and powers `/diff` and `/undo`. Only the directory you started `smart` in is covered, so in a monorepo a sibling package is never reverted.
Snapshots use Git's untracked-file cache in their private index, and the end-of-task snapshot is skipped when nothing ran after the last step's.
If one still takes over 4 s (big repositories, especially on Windows), `smart` says so once and suggests `git config core.fsmonitor true`.
`/undo` reverts only the files the task itself changed: your own edits to other files since then are kept. If you have edited one of the task's own files since,
`/undo` changes nothing and names the file (`/undo force` reverts it anyway). It never deletes through a folder that has become a link pointing outside the
project, reports a file it could not remove (and keeps the entry so `/undo` can be retried), and refuses an entry recorded for another repository location.
Files git ignores (`.env`, `node_modules`) are never snapshotted or touched. The last 20 tasks are remembered per directory, so `/undo`
and `/diff` still work after you quit and start `smart` again (unless `git gc` has since removed the snapshot).
Not a git repo? `git init` enables it. A failed or cancelled task can be continued with `/resume` (or `smart --resume`), from its first unfinished step,
also after a restart. If the saved Claude Code session is gone by then (or was replaced because it grew too big), the continuing step gets the
conversation summary and the list of files the finished steps changed instead.

**Your files under `%USERPROFILE%\.smart\`** (history, conversations, trust, account limits, prompt history) are written owner-only, atomically
(a crash never leaves half a file) and under a lock: when another smart holds the lock for more than a few seconds, the save is skipped with a
warning rather than done unprotected; a lock left by a crashed smart is taken over. History and conversations carry a format version: a file from
a newer smart is read but never overwritten (so going back a version loses nothing), a damaged record is skipped, and an unreadable file is moved
aside as `*.corrupt-<time>` rather than overwritten.

**Usage limit reached**: when Claude refuses a call because your 5-hour or weekly limit is used up, `smart` stops the task at once instead of retrying or
escalating to a bigger model (every call would be refused until the reset), says when the limit resets, and keeps the task for `/resume`.

**Servers overloaded**: when Anthropic's API answers "overloaded" (or another temporary server error), `smart` waits 15 s and tries the same call
again, then 45 s. It never counts that as a failed step or escalates (a bigger model is no less busy). If it is still overloaded, the task stops and
stays available for `/resume`.

## Permissions

`runner.permissionMode` defaults to `acceptEdits`: steps edit files, and run shell commands only where your Claude Code permission rules allow them
(for example `"permissions": { "allow": ["Bash(npm test:*)"] }` in Claude Code's settings). `smart`'s own checks (above) do not depend on it.
`bypassPermissions` lets steps run any command unasked (installing packages, starting servers); set it on purpose in your global config, for projects you trust.
Claude Code refuses that mode when run as root (common in Docker and CI), so `smart` falls back to `acceptEdits` and tells you. `plan` is read-only.

## Project config and trust

Your global `%USERPROFILE%\.smart\smart.config.json` and a file you pass with `--config` are yours. A `smart.config.json` that `smart` finds in the
directory came with the repository, so settings in it that cross a trust boundary are ignored (with a warning naming each one) until you trust it:

| setting | ignored from an untrusted project file when it |
| --- | --- |
| `verify.commands` | sets commands (they run in a shell) |
| `verify.auto` | turns automatic checks on when your config turned them off |
| `runner.permissionMode` | is more permissive than your own (`plan` < `dontAsk`, `manual` < `acceptEdits` < `auto` < `bypassPermissions`) |
| `runner.extraArgs` | passes flags to Claude Code |
| `runner.bare` | turns on `--bare` (which skips your Claude Code hooks and settings) |
| `limits.maxBudgetUsdPerTask`, `limits.maxBudgetUsdPerStep` | removes or raises a cap you set |
| `trackerPath`, `conversationsPath`, `limitsPath`, `historyPath` | moves where your prompts and history are written |

Tightening is always allowed (a project may choose `plan` or a lower budget). `smart trust` records the file's SHA-256 in
`%USERPROFILE%\.smart\trusted-projects.json`; any change to the file makes it untrusted again. `smart trust --remove` forgets it.
Model names are checked everywhere: a value that starts with `-` or holds spaces is rejected, so it cannot be read as another Claude Code flag.
