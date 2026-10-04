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
| 9 | Sessions, rollover, resume | pending |
| 10/12 | Pipeline state, failure classification, verification, review | pending |
| 11 | Planner and context robustness | pending |
| 13/14 | Routing benchmark, `--rate` diagnostics | pending |
| 15/16 | Learning robustness, cost accounting | pending |
| 17 | CLI, JSON, exit codes | pending |
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

## Unresolved / intentionally unchanged

(filled in as phases complete)
