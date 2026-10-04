# Implementation status: master engineering task

Working branch: `claude/master-hardening` (from `main` at `f04f002`, smart 0.3.4).
This file is the hand-off record. If work stops part-way, continue from the first phase that is not **done**.

## Phase overview

| # | Phase | Status |
| --- | --- | --- |
| 1 | Baseline | done |
| 2 | Security: permission defaults, project-config trust | done |
| 3 | Command execution | done |
| 4/5 | Filesystem, paths, checkpoints, undo | done |
| 6/7 | Persistence, locking, privacy, schema versions | done |
| 8 | Claude process lifecycle, PID safety | done |
| 9 | Sessions, rollover, resume | done |
| 10/12 | Pipeline state, failure classification, verification, review | done |
| 11 | Planner and context robustness | done |
| 13/14 | Routing benchmark, `--rate` diagnostics | done |
| 15/16 | Learning robustness, cost accounting | done |
| 17 | CLI, JSON, exit codes | done |
| 18 | TUI | pending |
| 19 | Installer and updater | pending |
| 20 | CI, package, release hygiene | pending |
| 21 | Performance | pending |
| 22 | Documentation | pending |
| 24/25 | Final audit and validation | pending |

## Phase 1: baseline (done)

Environment: Linux container, Node 22.22.0, npm 10.9.4 (the project targets Windows 10/11; CI runs on Windows).
No PowerShell is available here, so `install.ps1` cannot be parsed or run locally; CI does both.

| Command | Result |
| --- | --- |
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm test` | 47 files passed, 1 skipped (the live-Claude E2E); 614 tests passed, 1 skipped |
| `npm run build` | pass (`dist/cli.js` 232 KB) |
| `npm run check` | pass (the four above) |

### What was inspected

- Whole `src/` tree (~6.6k lines), build config (tsup, tsconfig, vitest, eslint boundaries), CI (`.github/workflows/ci.yml`, Windows only,
  Node 22/24, installer parse + install), Dependabot, `install.ps1`, `src/update.ts`.
- Persisted files (all under `~/.smart/`): `history.json` (`{version:1,tasks}` since the first commit), `conversations.json`
  (`{version:1,byDir}`), `limits.json` (unversioned snapshot), `input-history.json` (unversioned array). No other historic formats exist
  (checked with `git log -S`), so no fabricated migrations are needed: the only "old" shapes are v1 records that lack later optional fields.
- Every process start (see Phase 3 table), every filesystem mutation (stores, checkpoint restore, init, debug log), config loading and precedence,
  routing/rating/learning/estimation, and the pipeline's state transitions.

### Strengths preserved (do not regress)

Core/UI separation enforced by ESLint; `RunClaudeFn` injection so every test mocks Claude; EventBus; pure routing/rating; escalation ladder;
kept-alive process + spares + one-shot fallback; session reuse; verification + review; private-index git checkpoints; `/undo` `/diff` across
restarts; `/resume`; usage/limit tracking; dry-run; `/rate` `/good` `/bad`; TUI; `-p` with JSON; Windows-specific handling.

## Phase 2: security and trust boundaries (done)

- Default `runner.permissionMode` is now `acceptEdits` in the schema, `smart init`'s starter, `smart.config.example.json`, README and ROUTING.md.
  `bypassPermissions` still works when chosen; the startup notice names the setting, and `/mode bypass` at runtime now warns too.
- Trust boundary for an auto-discovered `./smart.config.json` (`gateProjectConfig` in `src/core/config.ts`): settings that would *loosen* what the
  user's own config (global file or defaults) allows are dropped unless the file is trusted, with one warning naming each setting and its effect.
  Covered: `verify.commands`, `verify.auto` (off→on), `runner.permissionMode` (by rank), `runner.extraArgs`, `runner.bare`, both budget caps (removed or
  raised), the four persistence paths. Tightening is always allowed.
- `smart trust` / `smart trust --remove` (`src/trust.ts`, `src/core/store/trust.ts`): trust is the SHA-256 of the file's exact contents in
  `~/.smart/trusted-projects.json`; any change re-gates it. Unknown/corrupt trust file → trusts nothing (fails closed).
- `--config <path>` is explicitly supplied by the user and treated as trusted (documented); the global file is trusted.
- Model names are validated (no leading `-`, no whitespace/control characters) so a config cannot smuggle a flag through `--model`.

## Phase 3: command execution (done)

Inventory of every process smart starts (and what changed):

| Where | Program | Shell | Args from | cwd | Change |
| --- | --- | --- | --- | --- | --- |
| `claude.ts` runClaude, `claudeProcess.ts`, `spares.ts` | Claude Code | no | smart + config (`extraArgs` trust-gated, model names validated); prompt via stdin | project | Windows: absolute PATH entries only; not found → `missing`, nothing spawned (`assertFound`) |
| `cli.tsx` | `claude --version` probe | no | fixed | was project, now home | probe never runs a project-folder binary |
| `checkpoint.ts` | git | no | fixed + tree ids | repo root | absolute git path on Windows; `--no-textconv` on numstat |
| `files.ts` | git ls-files | no | fixed + project-relative folder | project | absolute git path on Windows, `windowsHide` |
| `verifier.ts` defaultExec | verify command | yes (intended: user/trusted commands and package.json scripts) | config / package.json | project | delayed kill only while running; Windows tree kill via `killTree` |
| `verifier.ts` hasCommand | `pnpm/yarn/bun --version` | yes (fixed names) | fixed | was project, now home | `NoDefaultCurrentDirectoryInExePath=1` |
| `killTree.ts` | taskkill | no | pid of a live child | inherited | absolute `%SystemRoot%\System32\taskkill.exe`; never after exit; fallback when taskkill fails |
| `update.ts` | git, npm | Windows only (npm.cmd), fixed args | fixed | smart's install folder | reworked in Phase 19 |

Concrete bug fixed: on Windows, libuv looks up a bare program name in the spawn's working directory before `PATH`, so a `git.exe`,
`claude.exe` or `taskkill.exe` committed to a cloned repository would run when smart opened it (checkpoint init and the file list run git at
startup). `src/core/which.ts` resolves programs to absolute paths from absolute PATH entries only.

Intentionally unchanged: verify commands keep cmd.exe's normal lookup (a user's `run-tests.bat` in the project root keeps working); they are
either the user's own/trusted `verify.commands` or the project's package.json scripts, which run project code by design (documented in README Safety).

## Phase 4/5: filesystem, paths, checkpoints, undo (done)

Reusable primitives in `src/core/paths.ts`: `unsafePathReason` (lexical, before any filesystem access), `resolveInside` (realpath containment,
case-insensitive on Windows through `path.relative`), `realPathOf`, `looksSecret`. Used by `gatherFiles` (plan-step files, reviewer files,
@mentions), `resolveMentions` folders, and checkpoint removal; the existing realpath protections in `runner.ts`/`mentions.ts` were kept and moved there.

Concrete bugs fixed:
- **UNC/device paths from model output** (`\\attacker\share\x` in a plan step's `files`) reached `existsSync`/`realpathSync`, which on Windows opens an
  SMB connection (NTLM hash leak). Now refused lexically. Drive-relative (`C:x`), device names (`CON`, `NUL.txt`), ADS (`a:b`) refused too.
- **Undo deleted through links**: `/undo` removed task-created files with `unlinkSync(root/rel)`; if a folder had since become a symlink/junction to
  outside the project, a file outside was deleted. Removal now requires the folder's real path inside the repository (`removable`).
  Verified separately that `git checkout-index` replaces a linked folder instead of writing through it.
- **Undo pruned the project folder itself** in a monorepo subfolder when its last file was removed; pruning now stops at the project folder and
  never descends into links.
- **Undo silently overwrote later user edits** to files the task had changed: it now refuses (nothing touched) and names the files; `/undo force` does it on purpose.
- **Undo reported success when a removal failed** (locked file on Windows): failures are listed, the entry is kept so `/undo` can be retried.
- **Undo entries could be applied to another location**: entries now record `repo` and `prefix`; a mismatch is refused. Old entries (no `repo`) still work.
- Persisted undo entries are validated (tree ids must be hex object ids) before use.
- Secrets (`.env`, keys, `.npmrc`, ...) are no longer pasted into prompts on smart's own initiative (plan-step files, reviewer); an explicit @mention still works.
- Duplicate file references (`a.ts`, `./a.ts`) are read once.

Intentionally unchanged: two smart processes in the same folder can still interleave a task in one with `/undo` in the other (each has its own private
index; there is no cross-process lock on the working tree). Git's own config (`core.fsmonitor`, filters) is the user's and is not overridden.

## Phase 6/7: persistence, locking, privacy, schema versions (done)

Concrete bug fixed (reproduced first): `withFileLock` ran the callback **unlocked** after ~3 s of waiting, and also whenever the lock folder could
not be created for any non-"busy" reason. New policy (`src/core/store/atomicFile.ts`):
- `acquireLock` waits up to 5 s; the callback never runs without the lock (`LockError` instead). All stores already turn errors into a message
  (history, conversations, trust) or ignore them (input history), so a busy lock means "not saved, and you are told", never "saved unprotected".
- The lock folder holds `owner.json` (pid, host, token, time). Stale = owner on this host no longer running (`process.kill(pid, 0)` → ESRCH), or
  older than 30 s (also for owner-less locks from older versions or a crash between mkdir and the owner write). A live-looking pid is only overruled
  by age (pid reuse). A lock from another host is only abandoned by age.
- Stale removal renames the folder first (atomic; one winner) and checks it is the same folder (inode, mtime, token) it judged stale; a fresh lock
  moved by mistake is put back. Release only removes a lock whose token is still its own. Residual race documented in the code comment.
- Windows EPERM/EACCES/EBUSY on mkdir stay "busy" (deleting folder), now bounded by the wait.
- `writeFileAtomic`: `wx` temp file with mode 0600, `fsync` before rename, rename retried on Windows sharing errors, temp removed on failure.

Privacy: history/conversations/trust/limits/input history are written 0600 (existing files get the mode on their next save), lock owner files 0600,
the debug log 0600 in a 0700 folder; the debug log never contains prompts (timings and error tails only). Checkpoint temp folders come from `mkdtemp` (0700).

Schema (`src/core/store/schema.ts`): `readVersioned` handles current / older (migrations table, one step at a time, written back by the next atomic
save) / newer (read best-effort, **never written**, saves return "written by a newer version of smart") / invalid (quarantined). Inspecting git history
showed `history.json` and `conversations.json` have only ever been version 1, so both migration tables are empty (no fabricated migrations); the
mechanism is tested with test-only migrations. Per-record validation: damaged history records are skipped when reading but kept in the file;
damaged conversation tasks, undo entries and `/resume` plans are dropped individually. `limits.json` and `input-history.json` stay unversioned
caches (validated on read, rewritten often). The trust file refuses to overwrite a format it does not know.

New optional record fields (additive, no version bump): `TaskRecord.project`, `StepRecord.failure` (filled in by later phases), `UndoEntry.repo/prefix`.

## Phase 8: Claude process lifecycle and Windows reliability (done)

PID safety (see Phase 3 for the code): smart only ever signals a `ChildProcess` it spawned and still holds; `killTree` refuses once Node has
seen it exit (`isRunning`), because only while Node holds the process handle is the pid guaranteed not to be reused on Windows. No pid is ever
persisted or read back. Failed or partial `taskkill` falls back to ending the direct child. The verifier's delayed SIGKILL no longer fires after
the command finished (it used to `taskkill /F` a pid 2 s after exit, a reuse hazard).

Concrete fixes:
- **One-shot `claude` with no output hung forever** (e.g. a login prompt or a hung hook in `smart -p` / CI). New `runner.startupTimeoutSec`
  (default 120, 0 = off): a process that has written *nothing* by then is killed and fails with `noOutput`; anything that has started writing is
  never cut off. Injected for every call by `pipeline/calls.ts`.
- **A dead spare failed the call** (classifier fell back to defaults, planner to a single step): a taken spare that fails with no output is
  retried once on a fresh process (nothing reached the model).
- **Cancel during a model switch** waited up to 10 s for the switch timeout; the control request now listens to the abort signal.
- **Two calls on one session** could run in two processes (`proc.busy` → one-shot `--resume` of the same session): calls are serialized per
  session id. A failed call does not block the queue.
- Stream line buffers are capped (64 MB) so a runaway line cannot grow memory without bound.
- `SmartError.noOutput` marks failures that never reached the model (start-up timeout, exit with no stdout); Phase 10 classifies them as
  environment failures.

Tested: start-up failure, start-up timeout, no-output exit, long-but-alive call not cut off, mid-message death (call fails, never silently
re-run; next call gets a new process), model switch refused/ignored/cancelled, process replacement waits for exit, keep-alive reuse,
spares (dead before take, dead after take), serialization, cancellation, idle shutdown (existing).

## Phase 9: session, rollover and resume (done)

Concrete bug fixed: the conversation summary, one-off notes (e.g. "the user undid your changes") and @referenced files were only given to plan step
**index 0**. `/resume` starts at a later step, so after a restart with the saved session gone, after a session rollover, or with
`session.resume: false`, the continuing step ran in a fresh session with no context at all; the undo note was not delivered either.
Now: memory goes to every step that does not resume a session; notes go to the next step that runs (once); @files to the first step this run
executes. The files earlier steps changed are saved with the pending task (`PendingTask.files`) and restored on `/resume`, so the step is told
"Files changed in earlier steps" as in the original run.

Verified (tests): restart + lost session → new session with summary; rollover before a resumed step; session lost between two steps of one
run; cancel during the resumed step keeps it resumable and emits no `task:done`; escalation after rollover (a failed call's session is never
resumed or reused: a new one with the summary and the failure text). Existing tests cover the normal multi-step task, context limit rollover,
resume after verification failure / process death (claude error), and resume through the conversation store.
"A task never appears complete because state was lost": an empty or malformed stored plan is no longer offered for `/resume` (Phase 6/7
validation), which would otherwise have "finished" with nothing run.

## Phase 10/12: pipeline state, failure classification, verification and review (done)

The state machine is documented at the top of `Pipeline` (task states and the per-step attempt loop). `pipeline.ts` was **not** split further:
its remaining size is the step loop and `finish`, which share a lot of per-task state; the decision logic that was tangled into the loop was
extracted instead, as pure functions in `src/core/pipeline/outcome.ts`:
- `checkFailureKind` (check result → `verify` | `timeout` | `environment`: exit 127/9009 or spawn failure; a signal-killed check stays `verify`),
- `callFailureKind` (Claude Code error → `environment` when it never produced output, `budget` on `error_max_budget_usd`, else `model`),
- `afterFailure` (policy: environment from a check → stop at once; Claude Code not starting → one same-model retry without an effort bump,
  then stop; budget → stop; otherwise the existing ladder / forced-model retries).

Concrete bugs fixed:
- A verify command that does not exist (`pytest` not installed, missing node_modules → 127) was retried and escalated up to Opus, paying for
  three or four model attempts that could not succeed. Now one attempt and a message saying what to install, task resumable.
- A call Claude Code stopped at `--max-budget-usd` was retried (and could escalate) with no budget left.
- A Claude Code that never started counted as a model failure and bumped effort/escalated.
- A step aborted by a task-level error (usage limit, auth) was missing from the task summary and history (its spend vanished from per-step stats).
- A failed call's spend was in the task total but not on the step record.

New data: `StepRecord.failure` (persisted; Phase 15 learning uses it), `TaskSummary.failure {kind, message, stepId}` and `task:done.failure`
(Phase 17 maps them to JSON and exit codes). Review stays fail-open when the reviewer is unavailable (reported as skipped); when review is
skipped/upgraded is unchanged (`shouldReview`, `reviewerTier`) and covered by existing tests.

## Phase 11: planner and execution robustness (done)

`parsePlan` treats planner output as untrusted (schema validity proves nothing): titles/summary/features/acceptance become single clean lines with
caps (`PLAN_LIMITS`), instructions are capped at 2000 characters, at most 20 files and 5 criteria per step, file references must pass
`unsafePathReason` (dropped ones are named in the warning), empty and repeated steps are dropped and ids regenerated, fields the planner has no say
over (`tier`, `model`) are ignored, and a plan with nothing usable left falls back to a single step (existing fallback kept). The classifier's
reason and answer are cleaned the same way.

Concrete bug fixed: **terminal escape injection**. Model text (replies, plan titles, notices with error output) and file contents (`/diff`) were
written straight to the terminal; a prompt-injected reply could set the window title, clear or rewrite the screen, or write the clipboard
(OSC 52). `src/core/text.ts` `forTerminal` strips escape sequences and control characters; it is applied at the TUI reducer's single output
choke point (complete lines and streamed deltas), to `-p` progress on stderr and to the text reply on stdout (JSON output is escaped by JSON).

Context gathering (Phase 4/5) already covers binary files (NUL sniff), huge files (budget-capped reads), duplicates, nonexistent files, path
boundaries and secrets; repository size is bounded by the 80/400-file lists and `limits.maxContextBytes`.

## Phase 13/14: routing benchmark and diagnostics (done)

`bench/routing/` (`npm run bench`, also typechecked and linted; not in the npm package):
- `tasks.ts`: 18 tasks covering every scenario the task lists, each with a labelled true difficulty per step, the classifier's plausible
  (sometimes deliberately wrong) label, the planner's step ratings, and whether checks exist; some have fixture files for live runs.
- `sim.ts`: runs the **real Pipeline** with a stand-in Claude: success iff capability(model, effort) + seeded noise ≥ difficulty, with common
  random numbers across strategies; written-down token, price, speed and reviewer-catch assumptions. Strategies: smart, always
  haiku/sonnet/opus, sonnet·high and opus·high pinned. Metrics: success, silent failure, first-try, attempts, escalations, first model/effort,
  tokens, cost, latency, checks and reviews.
- `live.ts` (`--live`): runs fixture tasks through the built CLI and real Claude Code (`-p --output-format json --config ...`), optional, never in CI.
- `test/bench.test.ts`: reproducibility (identical runs for identical seeds), coverage of every category, internal consistency.

Result (20 seeds): smart 98% success at $0.120/task, always-opus 98% at $0.128, always-opus·high 99% at $0.145, always-sonnet 74% at $0.094,
always-haiku 32%. Decision: **thresholds were not retuned**. The capabilities are my assumptions; fitting the router to them would be circular.
What the benchmark did surface: (1) a stale comment claiming `hard` single tasks go straight to Opus (they rate Sonnet·high when the request is
a small edit) — fixed; (2) most of smart's extra cost/time is underrated hard tasks escalating — documented in ROUTING.md as a property of the
model, to be checked with `--live`.

`smart --rate` now goes through the real router (`route` + `routeWithSession`) instead of the rater alone, so it shows keyword-rule overrides
(it used to say Sonnet for "fix the race condition" while a run used Opus), the account-limit downshift (from `limits.json`) and the warm-cache
rule (from this folder's conversation), plus the deciding rule, both change/question routings, score, signals, floor, learning note, and an explicit
statement that confidence is a heuristic, not a probability.

Bug fixed on the way: `applyLimitPressure` / `plannerDownshift` judged window expiry by the wall clock instead of the pipeline's clock.

## Phase 15/16: learning robustness and cost accounting (done)

`buildHistory` (`src/core/rating/learn.ts`) no longer counts as a miss for the rung:
- steps whose `failure` is not the model's (`environment`, `budget`, `limit`, `cancelled`, `timeout`), and attempts lost to Claude Code not starting
  (`StepRecord.environmentRetries`, recorded by the pipeline);
- a step that failed even after escalating to the top of the configured ladder (an unrelated red suite is indistinguishable from it);
- more than `PROJECT_CAP` (10) recent steps of one project per rung (`TaskRecord.project` = 16-hex hash of the folder key, no path stored;
  older records without it are not capped);
- a `/bad` counts once per task and rung, not once per step. `adjustRung` already moves at most one rung; a test pins that even 200 `/bad`
  tasks move one rung only.

Cost accounting audit: retries, escalations, keep-alive turns (running-total differences), process replacement and rollover (fresh totals),
and classifier/planner/reviewer calls were checked. Fix: a failed classify/plan/review call's spend was in the task total but not in `overhead`
(`onErrorUsage(usage, overhead)` now separates them). Test: totals = steps + overhead exactly, across a retry with a failed call and a lean-start
fallback (two real failed calls, two charges). Estimates stay labelled "≈ … if every step passes first time" and "(rough)"; reported costs come
from Claude Code.

## Phase 17: CLI, JSON and exit-code contract (done)

`src/exitCodes.ts` defines the contract (README table, `--help` footer): 0 done, 1 did not finish, 2 invalid usage/config, 3 Claude Code
missing or not logged in, 4 budget, 5 usage limit / overloaded (try later), 6 nothing to resume, 130 cancelled, 143/129 SIGTERM/SIGHUP.
`exitCodeFor(kind)` maps a `TaskFailure.kind` or `SmartError.kind`; print mode, the CLI's early errors and the one-shot TUI all use it, so
`smart "task"` and `smart -p` exit the same way.

Fixes:
- Invalid options exited 1 (indistinguishable from a failed task); now 2 via commander `exitOverride` (help/version stay 0).
- `--resume` with nothing pending crashed out of `runPrint` with a text error and no JSON; now exit 6 and a JSON error document.
- With `-p --output-format json`, errors before the task (bad config, Claude Code missing, bad options) printed only to stderr and left stdout
  empty; now stdout always holds one JSON document (`errorDocument`).
- `--output-format`/`--verbose` without `-p` were silently ignored; now a usage error.
- JSON adds `failure {kind, message, step}`, `exitCode`, `usage.cacheCreationTokens`; `error` is filled for every failure (it was null for
  failures that emitted no `error` event).
- Auth failures inside a task exit 3 (were 1).
- The TUI's `onExit` passes an exit code instead of a boolean.

Verified with the built `dist/cli.js` and the fake Claude: unknown option (2, JSON doc), format without `-p` (2), bad config (2, JSON), nothing to
resume (6, JSON), missing Claude (3, JSON), success (0, stdout is only the JSON document), `--version`/`--help` (0).

## Decisions later phases depend on

- `LoadedConfig` has a new `notices` field (info lines; the CLI prints them like warnings but without "warning:").
- Trust is keyed by `dirKey()` (case-insensitive on Windows), the same key the conversation store uses.
- Persisted trust file is versioned (`version: 1`) from the start.

## Files changed

- Phase 2: `src/core/config.ts`, `src/core/store/trust.ts` (new), `src/trust.ts` (new), `src/init.ts`, `src/cli.tsx`, `src/core/pipeline.ts`,
  `smart.config.example.json`, `README.md`, `ROUTING.md`.
- Phase 3: `src/core/which.ts` (new), `src/core/killTree.ts`, `src/core/claude.ts`, `src/core/claudeProcess.ts`, `src/core/spares.ts`,
  `src/core/checkpoint.ts`, `src/core/files.ts`, `src/core/verifier.ts`, `src/cli.tsx`.
- Phase 4/5: `src/core/paths.ts` (new), `src/core/runner.ts`, `src/core/mentions.ts`, `src/core/checkpoint.ts`, `src/core/pipeline/changes.ts`,
  `src/core/pipeline.ts`, `src/core/store/conversation.ts`, `src/ui/commands.ts`, `src/ui/App.tsx`.
- Phase 6/7: `src/core/store/atomicFile.ts`, `src/core/store/schema.ts` (new), `src/core/store/tracker.ts`, `src/core/store/conversation.ts`,
  `src/core/store/trust.ts`, `src/core/store/limits.ts`, `src/core/claude.ts` (debug log mode).
- Phase 8: `src/core/claude.ts`, `src/core/claudeProcess.ts`, `src/core/errors.ts`, `src/core/config.ts` (`runner.startupTimeoutSec`),
  `src/core/pipeline/calls.ts`, `smart.config.example.json`, `ROUTING.md`, `test/fixtures/fake-claude-stream.mjs` (`FAKE_DIE_TURN`).
- Phase 9: `src/core/pipeline.ts`, `src/core/store/conversation.ts` (`PendingTask.files`).
- Phase 10/12: `src/core/pipeline/outcome.ts` (new), `src/core/pipeline.ts`, `src/core/verifier.ts` (exit details, spawn failure),
  `src/core/events.ts` (`task:done.failure`), `src/core/store/tracker.ts` (`FailureKind`).
- Phase 11: `src/core/planner.ts`, `src/core/text.ts` (new), `src/core/classifier.ts`, `src/ui/state.ts`, `src/print.ts`.
- Phase 13/14: `bench/routing/{tasks,sim,run,live}.ts` (new), `package.json` (`bench` script), `tsconfig.json` (includes `bench`), `src/rate.ts`,
  `src/cli.tsx`, `src/core/usage.ts`, `src/core/pipeline/session.ts`, `src/core/pipeline.ts`, `src/core/types.ts` (comment), `ROUTING.md`, `CONTRIBUTING.md`.
- Phase 15/16: `src/core/rating/learn.ts`, `src/core/store/tracker.ts` (`projectKey`, `environmentRetries`), `src/core/pipeline.ts`,
  `src/core/pipeline/calls.ts`, `src/cli.tsx`, `ROUTING.md`.
- Phase 17: `src/exitCodes.ts` (new), `src/print.ts`, `src/cli.tsx`, `src/ui/App.tsx`, `src/ui/state.ts`, `src/core/errors.ts` (`resume` kind),
  `src/core/pipeline.ts`, `README.md`.

## Tests added or changed

- Phase 2: new `test/core/configTrust.test.ts` (10 tests: every gated key, tightening, repeat-of-global, trust/changed/revoke cycle, `smart trust`
  validation, fail-closed trust store, `smart init` safety, model-name validation, gate purity, permission ranking). Updated
  `test/core/config.test.ts` (default is `acceptEdits`), `test/core/bugfixes.test.ts` (risky project settings are now ignored, not just warned
  about), `test/core/pipeline.test.ts` (bypass notice needs an explicit bypass config; new default-mode and `/mode bypass` tests).
  Result: 626 passed, 1 skipped.
- Phase 3: new `test/core/which.test.ts`; `test/core/killTree.test.ts` (absolute taskkill, no kill after exit, fallback when taskkill fails);
  `test/core/claude.test.ts` (missing claude on Windows, relative PATH ignored, argument boundaries, prompt over stdin with no shell).
  Result: 637 passed, 1 skipped.
- Phase 4/5: new `test/core/paths.test.ts` (UNC/device/drive-relative/ADS/reserved names, symlink escape, absolute mentions, dedupe, secrets);
  `test/core/checkpoint.test.ts` (+6: delete through a linked folder refused, link removed not its target, git replaces a linked folder,
  rename undo, monorepo scope, failed git → null); `test/core/quality.test.ts` (+2: later-edit refusal and `/undo force`, foreign repo entry);
  `test/ui/state.test.ts` (`/undo force`). Result: 654 passed, 1 skipped.
- Phase 6/7: `test/core/atomicFile.test.ts` (+10: live holder blocks and the callback does not run, dead owner taken over, foreign host waited for,
  owner-less lock by age, uncreatable lock folder, release safety, owner record, stores report a held lock, 0600 files, temp cleanup);
  new `test/core/schema.test.ts` (14: version handling, 0.3 files, damaged records, newer files never written, quarantine, pending validation,
  missing `updatedAt`, limits cache, foreign trust file). The 4-process concurrent writer test passes repeatedly. Result: 678 passed, 1 skipped.
- Phase 8: `test/core/claude.test.ts` (+4 start-up timeout / no-output / runaway line), `test/core/claudeProcess.test.ts` (+4: cancel during
  switch, per-session serialization, failed call does not block, mid-message death), `test/core/spares.test.ts` (+2 dead spares).
  Result: 688 passed, 1 skipped.
- Phase 9: `test/core/resume.test.ts` (+6 session/resume scenarios). Result: 694 passed, 1 skipped.
- Phase 10/12: new `test/core/outcome.test.ts` (11: kind classification, policy, and pipeline runs for missing command, real test failure,
  review failure, Claude Code not starting, timeout, budget (both kinds), limit, cancel, success). Result: 705 passed, 1 skipped.
- Phase 11: `test/core/planner.test.ts` (+6 untrusted-plan cases), new `test/core/text.test.ts` (4: escape removal, markdown kept, caps, TUI
  reducer). Result: 715 passed, 1 skipped.
- Phase 13/14: new `test/bench.test.ts` (4); `test/rate.test.ts` (+4: keyword override, confidence wording, limit and warm-cache rules,
  learning note); `test/core/rating-fixes.test.ts` (2 updated for the new output). Result: 723 passed, 1 skipped.
- Phase 15/16: new `test/core/learning.test.ts` (8) and `test/core/accounting.test.ts` (2). Result: 733 passed, 1 skipped.
- Phase 17: new `test/exitCodes.test.ts` (2); `test/print.test.ts` (auth → 3, +4: failure kind and pure-JSON stdout, limit 5 / budget 4,
  nothing to resume 6 with JSON, success fields); `test/ui/app.test.tsx` (one-shot exit codes). Result: 739 passed, 1 skipped.

## Unresolved / intentionally unchanged

(filled in as phases complete)
