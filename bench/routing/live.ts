import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS } from './tasks.js';

/**
 * The live benchmark: each task with a `fixture` is run with the built smart (`dist/cli.js -p --output-format json`) and the
 * real Claude Code, once per strategy (`smart` = automatic routing, or a forced model), in a scratch git repository. It costs
 * real money and its results vary from run to run; it exists to check the simulation's assumptions now and then, never in CI.
 * Needs `npm run build` and a logged-in `claude`.
 */
export async function runLive(o: { json?: string; models?: string[] }): Promise<number> {
  const cli = resolve(fileURLToPath(new URL('../../dist/cli.js', import.meta.url)));
  const strategies = o.models ?? ['smart', 'haiku', 'sonnet', 'opus'];
  const results: unknown[] = [];
  for (const task of TASKS.filter((t) => t.fixture)) {
    for (const strategy of strategies) {
      const dir = mkdtempSync(join(tmpdir(), 'smart-live-'));
      try {
        for (const [file, text] of Object.entries(task.fixture!.files)) {
          mkdirSync(dirname(join(dir, file)), { recursive: true });
          writeFileSync(join(dir, file), text);
        }
        spawnSync('git', ['init', '-q'], { cwd: dir });
        // The check goes in a config named with --config: a file you name yourself is trusted (a found one would be gated).
        const cfg = join(dir, '..', `${task.id}-${strategy}.smart.json`);
        writeFileSync(cfg, JSON.stringify({ verify: { auto: false, commands: task.fixture!.verify ? [task.fixture!.verify] : [] } }));
        const started = Date.now();
        const r = spawnSync(process.execPath, [cli, '-p', '--output-format', 'json', '--config', cfg, ...(strategy === 'smart' ? [] : ['--model', strategy]), task.prompt], { cwd: dir, encoding: 'utf8', timeout: 15 * 60_000 });
        rmSync(cfg, { force: true });
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(r.stdout) as Record<string, unknown>;
        } catch {
          parsed = { error: r.stderr.slice(-500) };
        }
        const verified = task.fixture!.verify ? spawnSync(task.fixture!.verify, { cwd: dir, shell: true }).status === 0 : null;
        results.push({ task: task.id, strategy, exitCode: r.status, ms: Date.now() - started, verified, ok: parsed.ok, usage: parsed.usage, steps: parsed.steps });
        process.stderr.write(`${task.id} · ${strategy}: exit ${r.status}, verified ${verified}, $${(parsed.usage as { costUsd?: number } | undefined)?.costUsd ?? '?'}\n`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  const text = JSON.stringify(results, null, 2);
  if (o.json) writeFileSync(o.json, text);
  else process.stdout.write(`${text}\n`);
  return 0;
}
