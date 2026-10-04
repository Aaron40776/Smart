# CLAUDE.md

smart is a TypeScript + React Ink terminal UI and headless CLI that wraps the Claude Code CLI and routes each task and plan step to a
model and effort (classify → plan → rate → run → verify/review → escalate). Windows 10/11 is the supported platform; this repository's
test suite also runs on Linux.

## Commands
- `npm ci` then `npm run check` (lint + typecheck + tests + build). Run it before every commit; all of it must pass.
- `npx vitest run test/<file>` for one test file. No test calls the real Claude Code; `test/fixtures/fake-claude.mjs` stands in.
- `node scripts/check-pack.mjs` after `npm run build` checks the npm package contents.

## Where things are
- `src/cli.tsx` entry point (commands `init`/`trust`/`update` are handled before commander), `src/print.ts` headless `-p`,
  `src/exitCodes.ts` exit-code contract, `src/ui/` Ink UI.
- `src/core/` the engine: `pipeline.ts` (+ `pipeline/`), `router.ts`, `rating/` (rater, features, learning, estimate), `classifier.ts`,
  `planner.ts`, `verifier.ts`, `review.ts`, `config.ts` (zod schema = the source of truth for settings and defaults), `store/` (files under `~/.smart`).
- Full layout and ground rules: `CONTRIBUTING.md`. Routing behaviour as implemented: `ROUTING.md`.

## Rules that are easy to break
- `src/core` must not import React/Ink or `src/ui` (ESLint enforces it).
- Only `claude.ts`, `claudeProcess.ts` and `spares.ts` spawn `claude`; everything else takes a `RunClaudeFn` so tests can fake it.
- Start programs by absolute path (`programPath` in `which.ts`); treat model output and repository files as untrusted (`paths.ts`, `forTerminal`).
- Persisted files: `writeFileAtomic` under `withFileLock`; schema versions in `store/schema.ts` change only with a migration.
- Do not change routing thresholds, scoring, escalation, Claude Code arguments or the exit codes without being asked: they are user-facing
  behaviour, documented in `ROUTING.md` and `README.md`.
- `test/docs.test.ts` fails when README/ROUTING/CONTRIBUTING, `smart.config.example.json`, `/help` or CLI flags drift from the code.
  A new setting goes in the schema, the example config (with its default) and `ROUTING.md`; a new flag or slash command in the README.
- Never skip or weaken a test to get green. User-facing changes go in `CHANGELOG.md` under `Unreleased`.
