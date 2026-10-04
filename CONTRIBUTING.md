# Contributing

Thanks for helping make `smart` better.

## Setup
Prerequisites: Node.js 22+, Git and, to run smart for real, the [Claude Code CLI](https://code.claude.com/docs/en/overview), logged in.
```sh
git clone https://github.com/Aaron40776/Smart.git
cd Smart
npm ci
npm run check      # lint + typecheck + tests + build
npm run dev        # run from source (needs the `claude` CLI, logged in)
npm run bench      # simulated routing benchmark (no Claude calls); see ROUTING.md
```
smart supports **Windows 10 and 11** only, and CI runs on Windows. A few small non-Windows branches remain in the code
(process groups, symlinked paths) so the test suite also runs on Linux, which is where automated tooling usually runs; do not build features on them.

| Command | What it does |
| --- | --- |
| `npm run lint` / `npm run typecheck` | ESLint (including the core/UI boundary) / `tsc --noEmit` |
| `npm test` | Vitest; every test uses `test/fixtures/fake-claude.mjs` or injected fakes, never the real Claude Code |
| `npm run build` | tsup bundles `src/cli.tsx` into `dist/cli.js` (the `smart` executable) |
| `node scripts/check-pack.mjs` | after a build: checks what the npm package would contain (CI runs it) |
| `$env:SMART_E2E=1; npm test -- test/e2e` | one real Haiku task through the real Claude Code (costs a little) |
| `$env:SMART_CLAUDE_BIN="$PWD\test\fixtures\fake-claude.mjs"; npm run dev` | try the UI against the fake Claude Code, for free |

## Layout
```
src/core/     the engine, no UI imports: pipeline (orchestrator; its state machine is described at the top of the class), classifier,
              planner, router, runner, verifier, review, effort, smalltalk, checkpoint (git undo), config (+ project trust gate), events;
              claude (one `claude` per call), claudeProcess (kept-alive process for coding steps), spares (pre-started processes for short
              calls), killTree; which (programs by absolute path), paths (path safety), text (terminal-safe model text)
src/core/pipeline/  split out of the pipeline: calls (call wrapper: overload retry, lean start), changes (snapshots, /undo, /diff),
              limits (account usage windows), session (warm cache, rotation), steps (review, checks, budget), outcome (failure kinds and policy)
src/core/store/   files under %USERPROFILE%\.smart: tracker (history), conversation, inputHistory, limits, trust, atomicFile (lock + atomic write),
              schema (format versions)
src/ui/       Ink components and the state reducer; src/cli.tsx and src/print.ts are the entry points; src/exitCodes.ts is the exit-code contract
test/         mostly mirrors src (a few files group tests by feature: batch*, improvements, bugfixes); test/fixtures/fake-claude.mjs
              stands in for the CLI; test/docs.test.ts fails when docs, example config, /help or flags drift from the code
bench/        the routing benchmark: tasks, the simulation and its assumptions, and the optional live runner
scripts/      check-pack.mjs (what the npm package contains; run in CI)
install.ps1   the Windows installer (CI parses it with Windows PowerShell 5.1 and runs it on the commit under test)
```

## Ground rules
- **`src/core` must not import UI code** (React/Ink). It emits events; frontends subscribe. ESLint enforces this.
- **Only `claude.ts`, `claudeProcess.ts` and `spares.ts` spawn `claude`.** Everything else takes a `RunClaudeFn`, so tests mock Claude.
- **Start programs by absolute path** (`programPath` in `which.ts`): on Windows a bare name is looked up in the project folder first.
- **Model output and repository files are untrusted input**: check paths with `paths.ts`, show text through `forTerminal`, validate plans.
- **Persisted files**: write with `writeFileAtomic` under `withFileLock` (which throws rather than run unlocked); bump the format version in
  `schema.ts` only for incompatible changes, with a migration, and keep reading the old format.
- Model names come from config, never from code.
- Add tests with every change. UI tests use `ink-testing-library`; core tests inject fakes.
- Do not skip or weaken tests to get green.

## Pull requests
- Branch from `main`, keep PRs focused, and fill in the PR template.
- `npm run check` must pass on Windows (CI runs Node 22 and 24).
- For anything that changes routing behavior, update `ROUTING.md`. User-facing changes go in `CHANGELOG.md` under `Unreleased`.

## Versions and releases
The version lives in `package.json` (`smart --version` reads it) and in the `CHANGELOG.md` heading for that release; bump both together.
smart is distributed from this repository by `install.ps1` and `smart update`, not from npm. No release tags exist yet; `SMART_REF` in the
installer works with any tag, branch or commit once they do.

## Known limitations
Decided on purpose, or not verifiable without a real Windows machine and Claude Code:
- A repository's own `.claude/settings.json` (hooks, permission rules) is named at startup, not blocked. Blocking would mean
  `--setting-sources user`, whose full effect (it may also drop the project's CLAUDE.md) has not been verified against a real Claude Code.
- Verify commands run through the shell with its normal program lookup, and automatic checks run the project's `package.json` scripts:
  that is what verification is. Untrusted code: `verify.auto: false`.
- There is no cross-process lock on the working tree: `/undo` in one smart can interleave with a task in another smart in the same folder.
  The store lock has a documented microsecond-scale residual race (`src/core/store/atomicFile.ts`).
- Routing thresholds are not tuned against the simulated benchmark (its model capabilities are assumptions); `npm run bench -- --live`
  checks them against real models.
- Windows-only behaviour (junctions, `taskkill`, cmd.exe exit code 9009, PowerShell 5.1) is unit-tested with injected platforms; CI on
  Windows is the real check.
- GitHub Actions are pinned by version tag, not commit SHA.

## Reporting problems
Use the issue templates. Include your OS/terminal, Node and Claude Code versions.
