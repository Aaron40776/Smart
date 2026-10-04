# Implementation status: master engineering task

Working branch: `claude/master-hardening` (from `main` at `f04f002`, smart 0.3.4).
This file is the hand-off record. If work stops part-way, continue from the first phase that is not **done**.

## Phase overview

| # | Phase | Status |
| --- | --- | --- |
| 1 | Baseline | done |
| 2 | Security: permission defaults, project-config trust | done |
| 3 | Command execution | pending |
| 4/5 | Filesystem, paths, checkpoints, undo | pending |
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

## Decisions later phases depend on

- `LoadedConfig` has a new `notices` field (info lines; the CLI prints them like warnings but without "warning:").
- Trust is keyed by `dirKey()` (case-insensitive on Windows), the same key the conversation store uses.
- Persisted trust file is versioned (`version: 1`) from the start.

## Files changed

- Phase 2: `src/core/config.ts`, `src/core/store/trust.ts` (new), `src/trust.ts` (new), `src/init.ts`, `src/cli.tsx`, `src/core/pipeline.ts`,
  `smart.config.example.json`, `README.md`, `ROUTING.md`.

## Tests added or changed

- Phase 2: new `test/core/configTrust.test.ts` (10 tests: every gated key, tightening, repeat-of-global, trust/changed/revoke cycle, `smart trust`
  validation, fail-closed trust store, `smart init` safety, model-name validation, gate purity, permission ranking). Updated
  `test/core/config.test.ts` (default is `acceptEdits`), `test/core/bugfixes.test.ts` (risky project settings are now ignored, not just warned
  about), `test/core/pipeline.test.ts` (bypass notice needs an explicit bypass config; new default-mode and `/mode bypass` tests).
  Result: 626 passed, 1 skipped.

## Unresolved / intentionally unchanged

(filled in as phases complete)
