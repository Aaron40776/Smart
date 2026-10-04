import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig } from '../../src/core/config.js';
import { SmartError } from '../../src/core/errors.js';
import { EventBus } from '../../src/core/events.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { Tracker } from '../../src/core/store/tracker.js';
import { emptyUsage } from '../../src/core/types.js';

const usd = (costUsd: number) => ({ ...emptyUsage(), costUsd, outputTokens: 10, inputTokens: 100 });
const ok = (cost: number, structured?: unknown): ClaudeResult => ({ isError: false, subtype: 'success', text: 'ok', structured, usage: usd(cost), sessionId: 's', numTurns: 1 });
const role = (o: Parameters<RunClaudeFn>[0]) => {
  const p = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return p && 'complexity' in p ? 'classifier' : p && 'steps' in p ? 'planner' : p && 'pass' in p ? 'reviewer' : 'executor';
};

function setup(run: RunClaudeFn, checks: boolean[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'smart-acct-'));
  const tracker = new Tracker(join(dir, 'history.json'));
  const config = defaultConfig();
  config.verify.commands = ['check'];
  let i = 0;
  const pipeline = new Pipeline(config, new EventBus(), dir, { run, tracker, uid: 1000, listFiles: () => [], exec: async () => ({ code: checks[i++] === false ? 1 : 0, output: '' }) });
  return { pipeline, tracker };
}

describe('cost accounting', () => {
  it('failed classifier calls are each counted once, as overhead, and the task still runs', async () => {
    let classifierCalls = 0;
    const t = setup(async (o) => {
      if (role(o) === 'classifier') {
        classifierCalls += 1;
        const e = new SmartError('claude', 'Claude Code reported an error: boom');
        e.usage = usd(0.02);
        throw e;
      }
      return ok(0.1);
    });
    const s = await t.pipeline.runTask('add input validation to the parser and its callers');
    expect(s.ok).toBe(true);
    // A failed lean start is retried once the normal way (pipeline/calls.ts): two real calls, two charges.
    expect(classifierCalls).toBe(2);
    expect(s.totals.costUsd).toBeCloseTo(0.1 + 2 * 0.02);
    const rec = t.tracker.load()[0]!;
    expect(rec.overhead.costUsd).toBeCloseTo(2 * 0.02);
    expect(rec.steps[0]!.usage.costUsd).toBeCloseTo(0.1);
  });

  it('totals are exactly steps plus overhead, across retries and an escalation (nothing counted twice or dropped)', async () => {
    let n = 0;
    const t = setup(async (o) => {
      if (role(o) === 'classifier') return ok(0.004, { complexity: 'small_edit', needsPlan: false, reason: 'r' });
      n += 1;
      if (n === 2) {
        const e = new SmartError('claude', 'Claude Code reported an error: error_max_turns');
        e.usage = usd(0.05);
        throw e;
      }
      return ok(0.1);
    }, [false]);
    const s = await t.pipeline.runTask('fix the parser so it handles empty input');
    expect(s.ok).toBe(true);
    const rec = t.tracker.load()[0]!;
    const steps = rec.steps.reduce((x, st) => x + st.usage.costUsd, 0);
    expect(steps + rec.overhead.costUsd).toBeCloseTo(s.totals.costUsd);
    expect(s.totals.costUsd).toBeCloseTo(0.004 + 0.1 + 0.05 + 0.1);
    expect(rec.project).toMatch(/^[0-9a-f]{16}$/);
  });
});
