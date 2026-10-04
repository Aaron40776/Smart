# Contributing

Thanks for helping make `smart` better.

## Setup
```sh
git clone https://github.com/Aaron40776/Smart.git
cd Smart
npm install
npm run check      # lint + typecheck + tests + build
npm run dev        # run from source (needs the `claude` CLI, logged in)
npm run bench      # simulated routing benchmark (no Claude calls); see ROUTING.md
```
Node.js 22+ is required. smart supports **Windows 10 and 11** only, and CI runs on Windows. A few small non-Windows branches remain in the code
(process groups, symlinked paths) so the test suite also runs on Linux, which is where automated tooling usually runs; do not build features on them.

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
test/         mirrors src; test/fixtures/fake-claude.mjs stands in for the CLI
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
- For anything that changes routing behavior, update `ROUTING.md`.

## Reporting problems
Use the issue templates. Include your OS/terminal, Node and Claude Code versions.
