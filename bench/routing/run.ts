import { writeFileSync } from 'node:fs';
import { formatReport, runBenchmark, summarize } from './sim.js';

/**
 * `npm run bench` — the simulated routing benchmark (no Claude calls, no cost, same numbers every time).
 *   --seeds N      repetitions per task and strategy (default 20)
 *   --json FILE    also write every run and the summary as JSON
 *   --live         run the fixture tasks against the real Claude Code instead (see live.ts; costs money)
 */
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

if (args.includes('--live')) {
  const { runLive } = await import('./live.js');
  process.exit(await runLive({ json: opt('--json'), models: opt('--strategies')?.split(',') }));
}

const seeds = Number(opt('--seeds') ?? 20);
if (!Number.isInteger(seeds) || seeds < 1) {
  process.stderr.write('--seeds must be a positive whole number\n');
  process.exit(2);
}
const runs = await runBenchmark({ seeds });
process.stdout.write(`${formatReport(runs, seeds)}\n`);
const json = opt('--json');
if (json) writeFileSync(json, JSON.stringify({ seeds, summary: summarize(runs), runs }, null, 2));
