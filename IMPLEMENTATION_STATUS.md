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
| 6/7 | Persistence, locking, privacy, schema versions | pending |
| 8 | Claude process lifecycle, PID safety | pending |
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

## Unresolved / intentionally unchanged

(filled in as phases complete)
