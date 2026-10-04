import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { SmartError } from '../../src/core/errors.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { afterFailure, callFailureKind, checkFailureKind } from '../../src/core/pipeline/outcome.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { emptyUsage } from '../../src/core/types.js';
import type { ExecResult } from '../../src/core/verifier.js';

const cfg = defaultConfig();
const res = (cost = 0.01): ClaudeResult => ({ isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: { ...emptyUsage(), costUsd: cost, outputTokens: 10 }, sessionId: 's', numTurns: 1 });

describe('failure kinds', () => {
  it('a check that cannot run is the environment, a timeout is its own kind, anything else is a verification failure', () => {
    expect(checkFailureKind({ code: 127 })).toBe('environment'); // sh: command not found
    expect(checkFailureKind({ code: 9009 })).toBe('environment'); // cmd.exe: not recognized
    expect(checkFailureKind({ code: null, spawnFailed: true })).toBe('environment');
    expect(checkFailureKind({ code: null })).toBe('verify'); // killed by a signal: a crashing test can be the work's fault
    expect(checkFailureKind({ code: 1, timedOut: true })).toBe('timeout');
    expect(checkFailureKind({ code: 1 })).toBe('verify');
    expect(checkFailureKind({ code: 2 })).toBe('verify');
  });

  it('a Claude Code call that never started is the environment; its budget stop is budget; the rest is the model', () => {
    const silent = new SmartError('claude', 'Claude Code produced no output within 120 s');
    silent.noOutput = true;
    expect(callFailureKind(silent)).toBe('environment');
    expect(callFailureKind(new SmartError('claude', 'Claude Code reported an error: error_max_budget_usd'))).toBe('budget');
    expect(callFailureKind(new SmartError('claude', 'Claude Code reported an error: error_max_turns'))).toBe('model');
    expect(callFailureKind(new SmartError('claude', 'the budget was exceeded, I think'))).toBe('model'); // the model's own words do not count
    expect(callFailureKind(new SmartError('cancelled', 'Cancelled.'))).toBe('cancelled');
    expect(callFailureKind(new Error('x'))).toBe('model');
  });

  it('afterFailure: environment and budget never escalate; the ladder applies to the rest', () => {
    const base = { tier: 'sonnet' as const, failuresOnTier: 1, environmentFailures: 0, fromCheck: false, forced: false, config: cfg };
    expect(afterFailure({ ...base, kind: 'environment', fromCheck: true })).toEqual({ action: 'stop', reason: 'a check could not run' });
    expect(afterFailure({ ...base, kind: 'environment', environmentFailures: 1 })).toEqual({ action: 'retry', tier: 'sonnet' });
    expect(afterFailure({ ...base, kind: 'environment', environmentFailures: 2 })).toMatchObject({ action: 'stop' });
    expect(afterFailure({ ...base, kind: 'budget' })).toEqual({ action: 'stop', reason: 'budget' });
    expect(afterFailure({ ...base, kind: 'verify' })).toEqual({ action: 'retry', tier: 'sonnet' });
    expect(afterFailure({ ...base, kind: 'review', failuresOnTier: 2 })).toEqual({ action: 'escalate', from: 'sonnet', tier: 'opus' });
    expect(afterFailure({ ...base, kind: 'timeout', failuresOnTier: 2 })).toEqual({ action: 'escalate', from: 'sonnet', tier: 'opus' });
    expect(afterFailure({ ...base, kind: 'verify', failuresOnTier: 2, forced: true })).toEqual({ action: 'give_up' });
  });
});

function setup(o: { exec?: (cmd: string, n: number) => ExecResult; executor?: (n: number, call: Parameters<RunClaudeFn>[0], cwd: string) => ClaudeResult; config?: (c: SmartConfig) => void; reviews?: boolean[] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'smart-out-'));
  let n = 0;
  let execN = 0;
  let reviewN = 0;
  const models: string[] = [];
  const run: RunClaudeFn = async (call) => {
    const props = (call.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    if (props && 'complexity' in props) return { ...res(0.002), structured: { complexity: 'multi_file', needsPlan: false, reason: 'r' } };
    if (props && 'pass' in props) {
      const pass = o.reviews?.[Math.min(reviewN++, (o.reviews?.length ?? 1) - 1)] ?? true;
      return { ...res(0.002), structured: { pass, issues: pass ? [] : ['src/a.ts: the function is never called'] } };
    }
    n += 1;
    models.push(call.model);
    return o.executor ? o.executor(n, call, cwd) : res();
  };
  const config = defaultConfig();
  config.verify.commands = ['npm test'];
  o.config?.(config);
  const bus = new EventBus();
  const events: SmartEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const pipeline = new Pipeline(config, bus, cwd, {
    run, uid: 1000, listFiles: () => [],
    exec: async (cmd) => o.exec?.(cmd, ++execN) ?? { code: 0, output: '' },
  });
  return { pipeline, models, events, of: <T extends SmartEvent['type']>(t: T) => events.filter((e): e is Extract<SmartEvent, { type: T }> => e.type === t) };
}

describe('pipeline: the outcome says what actually went wrong', () => {
  it('a check whose command does not exist stops the step at once: no retry, no bigger model', async () => {
    const t = setup({ exec: () => ({ code: 127, output: 'sh: 1: pytest: not found' }) });
    const s = await t.pipeline.runTask('add input validation to the parser and its callers');
    expect(s.ok).toBe(false);
    expect(t.models).toEqual(['sonnet']); // one attempt only
    expect(s.steps[0]?.failure).toBe('environment');
    expect(s.failure).toMatchObject({ kind: 'environment', stepId: 's1' });
    expect(s.failure?.message).toMatch(/could not run.*not something a model can fix/s);
    expect(t.of('step:escalate')).toHaveLength(0);
  });

  it('a real test failure still retries and escalates, and is recorded as a verification failure', async () => {
    const t = setup({ exec: () => ({ code: 1, output: 'FAIL: expected 2, got 3' }), config: (c) => { c.escalation.ladder = ['sonnet', 'opus']; } });
    const s = await t.pipeline.runTask('add input validation to the parser and its callers');
    expect(t.models).toEqual(['sonnet', 'sonnet', 'opus', 'opus']);
    expect(s.failure?.kind).toBe('verify');
    expect(s.steps[0]?.failure).toBe('verify');
  });

  it('a review failure is recorded as such', async () => {
    const t = setup({
      config: (c) => { c.verify.commands = []; c.verify.auto = false; c.escalation.retriesPerModel = 0; c.escalation.ladder = ['sonnet']; },
      reviews: [false],
      executor: (_n, call, cwd) => {
        writeFileSync(join(cwd, 'a.ts'), 'export const a = 1;\n');
        call.onEvent?.({ kind: 'tool', name: 'Write', summary: 'Write a.ts', writtenFile: join(cwd, 'a.ts') });
        return res();
      },
    });
    const s = await t.pipeline.runTask('add input validation to the parser and its callers');
    expect(s.ok).toBe(false);
    expect(s.failure?.kind).toBe('review');
    expect(s.failure?.message).toMatch(/never called/);
    expect(s.steps[0]?.failure).toBe('review');
  });

  it('a Claude Code that never starts gets one more try on the same model, then the task stops resumably', async () => {
    const t = setup({
      executor: () => {
        const e = new SmartError('claude', 'Claude Code produced no output within 120 s of starting.');
        e.noOutput = true;
        throw e;
      },
    });
    const s = await t.pipeline.runTask('add input validation to the parser and its callers');
    expect(t.models).toEqual(['sonnet', 'sonnet']);
    expect(s.failure?.kind).toBe('environment');
    expect(t.pipeline.pendingTask).not.toBeNull();
  });

  it('a timed-out check is retried like a failure (the work may hang) but recorded as a timeout', async () => {
    const t = setup({ exec: () => ({ code: null, output: 'still running', timedOut: true }), config: (c) => { c.escalation.retriesPerModel = 0; c.escalation.ladder = ['sonnet']; } });
    const s = await t.pipeline.runTask('add input validation to the parser and its callers');
    expect(t.models).toEqual(['sonnet']);
    expect(s.failure?.kind).toBe('timeout');
  });

  it('budget exhaustion is its own outcome, and the call that hit Claude Code\'s cap is not retried', async () => {
    const capped = setup({
      config: (c) => { c.limits.maxBudgetUsdPerTask = 1; },
      executor: () => {
        const e = new SmartError('claude', 'Claude Code reported an error: error_max_budget_usd');
        e.usage = { ...emptyUsage(), costUsd: 0.4 };
        throw e;
      },
    });
    const s = await capped.pipeline.runTask('add input validation to the parser and its callers');
    expect(capped.models).toHaveLength(1);
    expect(s.failure?.kind).toBe('budget');
    expect(s.steps[0]?.usage.costUsd).toBeCloseTo(0.4); // a failed call's spend is on the step record too

    const spent = setup({ config: (c) => { c.limits.maxBudgetUsdPerTask = 0.015; }, exec: () => ({ code: 1, output: 'FAIL' }) });
    const s2 = await spent.pipeline.runTask('add input validation to the parser and its callers');
    expect(s2.failure?.kind).toBe('budget');
    expect(spent.of('task:done').at(-1)?.failure).toBe('budget');
  });

  it('cancelling records cancelled, an account limit records the error kind', async () => {
    const t = setup({ executor: () => { throw new SmartError('limit', 'Your Claude usage limit is reached'); } });
    const s = await t.pipeline.runTask('add input validation to the parser and its callers');
    expect(s.failure?.kind).toBe('limit');
    expect(s.steps[0]?.failure).toBe('limit');

    const c = setup({ executor: () => { throw new SmartError('cancelled', 'Cancelled.'); } });
    const s2 = await c.pipeline.runTask('add input validation to the parser and its callers');
    expect(s2.cancelled).toBe(true);
    expect(s2.failure?.kind).toBe('cancelled');
    expect(s2.steps[0]?.failure).toBe('cancelled');
  });

  it('a successful task has no failure', async () => {
    const s = await setup().pipeline.runTask('add input validation to the parser and its callers');
    expect(s.ok).toBe(true);
    expect(s.failure).toBeUndefined();
  });
});
