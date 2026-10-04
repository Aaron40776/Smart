import { describe, expect, it } from 'vitest';
import { draw, formatReport, runBenchmark, STRATEGIES, succeeds, summarize } from '../bench/routing/sim.js';
import { TASKS } from '../bench/routing/tasks.js';

/**
 * The routing benchmark runs in CI in its simulated form only (no Claude calls). These checks hold whatever the tuning:
 * the run is reproducible, every scenario of the task set is present, and the comparison is internally consistent.
 */
describe('routing benchmark (simulated)', () => {
  it('covers the scenarios the routing has to handle', () => {
    const categories = new Set(TASKS.map((t) => t.category));
    for (const c of ['trivial edit', 'typo fix', 'simple question', 'ordinary bug fix', 'multi-file feature', 'large build', 'architecture change', 'security issue',
      'concurrency', 'performance', 'investigation', 'migration', 'documentation only', 'ambiguous', 'needs escalation', 'verification catches a wrong result']) {
      expect(categories.has(c), c).toBe(true);
    }
    expect(STRATEGIES.map((s) => s.name)).toEqual(expect.arrayContaining(['smart', 'always haiku', 'always sonnet', 'always opus']));
  });

  it('is reproducible: the same seeds give exactly the same runs', async () => {
    const a = await runBenchmark({ seeds: 2 });
    const b = await runBenchmark({ seeds: 2 });
    expect(b).toEqual(a);
    expect(formatReport(b, 2)).toBe(formatReport(a, 2));
  });

  it('is internally consistent: forced models never escalate, more capable baselines do not do worse, smart spends less than opus-high', async () => {
    const runs = await runBenchmark({ seeds: 3 });
    const s = Object.fromEntries(summarize(runs).map((r) => [r.strategy, r]));
    for (const name of ['always haiku', 'always sonnet', 'always opus']) expect(s[name]!.escalationsPerTask).toBe(0);
    expect(s['always opus']!.success).toBeGreaterThanOrEqual(s['always sonnet']!.success);
    expect(s['always sonnet']!.success).toBeGreaterThanOrEqual(s['always haiku']!.success);
    expect(s.smart!.costPerTask).toBeLessThan(s['always opus · high']!.costPerTask);
    // A question the classifier answers costs one small call.
    const q = runs.filter((r) => r.strategy === 'smart' && r.task === 'question-general');
    expect(q.every((r) => r.attempts === 1 && r.usage.costUsd < 0.01)).toBe(true);
  });

  it('the luck of an attempt does not depend on the strategy (common random numbers)', () => {
    expect(draw('1/race/step/0/1')).toBe(draw('1/race/step/0/1'));
    expect(draw('1/race/step/0/1')).not.toBe(draw('1/race/step/0/2'));
    expect(succeeds('opus', 'xhigh', 0.5, 0.5)).toBe(true);
    expect(succeeds('haiku', undefined, 0.9, 0.99)).toBe(false);
  });
});
