import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { SmartError } from '../../src/core/errors.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { Tracker } from '../../src/core/store/tracker.js';
import { emptyUsage, type Complexity } from '../../src/core/types.js';
import type { ExecFn } from '../../src/core/verifier.js';

const usage = (costUsd: number) => ({ ...emptyUsage(), costUsd, outputTokens: 100 });
const res = (over: Partial<ClaudeResult> = {}): ClaudeResult => ({
  isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: usage(0.01), sessionId: 's', numTurns: 1, ...over,
});
const plan2 = {
  summary: 'Two step plan',
  steps: [
    { title: 'One', instructions: 'do one', acceptance: ['a'] },
    { title: 'Two', instructions: 'do two', acceptance: ['b'] },
  ],
};

interface Call { role: 'classifier' | 'planner' | 'executor'; model: string; prompt: string }

function setup(opts: {
  complexity?: Complexity;
  needsPlan?: boolean;
  plan?: object;
  executor?: (call: Call, n: number, o: Parameters<RunClaudeFn>[0]) => Promise<ClaudeResult> | ClaudeResult;
  checks?: (n: number) => boolean; // returns pass/fail for the nth exec call
  config?: (c: SmartConfig) => void;
  uid?: number;
  tracker?: Tracker;
} = {}) {
  const calls: Call[] = [];
  let executorCalls = 0;
  const run: RunClaudeFn = async (o) => {
    const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    const role = props && 'complexity' in props ? 'classifier' : props && 'steps' in props ? 'planner' : 'executor';
    const call: Call = { role, model: o.model, prompt: o.prompt };
    calls.push(call);
    if (role === 'classifier') return res({ structured: { complexity: opts.complexity ?? 'small_edit', needsPlan: opts.needsPlan ?? false, reason: 'r' }, usage: usage(0.004) });
    if (role === 'planner') return res({ structured: opts.plan ?? plan2, usage: usage(0.03) });
    executorCalls += 1;
    return opts.executor ? opts.executor(call, executorCalls, o) : res();
  };
  const execCalls: string[] = [];
  const exec: ExecFn = async (cmd) => {
    execCalls.push(cmd);
    const pass = opts.checks ? opts.checks(execCalls.length) : true;
    return pass ? { code: 0, output: '' } : { code: 1, output: 'FAILED: assertion x' };
  };
  const config = defaultConfig();
  config.verify.commands = ['check'];
  opts.config?.(config);
  const bus = new EventBus();
  const events: SmartEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const pipeline = new Pipeline(config, bus, mkdtempSync(join(tmpdir(), 'smart-pipe-')), {
    run, exec, tracker: opts.tracker, listFiles: () => ['package.json'], uid: opts.uid ?? 1000,
  });
  const types = () => events.map((e) => e.type);
  const of = <T extends SmartEvent['type']>(t: T) => events.filter((e): e is Extract<SmartEvent, { type: T }> => e.type === t);
  return { pipeline, calls, events, types, of, execCalls, config, bus };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('Pipeline: happy paths', () => {
  it('runs a small edit end to end: classify, single step on sonnet, verify, done', async () => {
    const t = setup();
    const s = await t.pipeline.runTask('make the parser handle empty input');
    expect(s.ok).toBe(true);
    expect(t.calls.map((c) => c.role)).toEqual(['classifier', 'executor']);
    expect(t.calls[0]?.model).toBe('haiku');
    expect(t.calls[1]?.model).toBe('sonnet');
    expect(t.execCalls).toEqual(['check']);
    expect(t.types()).toEqual(expect.arrayContaining(['task:start', 'classified', 'plan:ready', 'step:start', 'step:verify', 'step:done', 'task:done']));
    expect(t.of('classified')[0]?.route.reason).toContain('small_edit');
    expect(s.totals.costUsd).toBeCloseTo(0.014);
  });

  it('routes a trivial question to haiku and skips verification when nothing was edited', async () => {
    const t = setup({ complexity: 'trivial' });
    await t.pipeline.runTask('what does git rebase do?');
    expect(t.calls[1]?.model).toBe('haiku');
    expect(t.execCalls).toEqual([]);
  });

  it('plans large builds with opus, executes steps in order and reports usage totals', async () => {
    const t = setup({ complexity: 'large_build', needsPlan: true });
    const s = await t.pipeline.runTask('make me a snake game', { autoApprove: true });
    expect(t.calls.map((c) => c.role)).toEqual(['classifier', 'planner', 'executor', 'executor']);
    expect(t.calls[1]?.model).toBe('opus');
    expect(t.calls[2]?.prompt).toContain('step 1 of 2');
    expect(t.calls[3]?.prompt).toContain('step 2 of 2');
    expect(s.steps.map((x) => x.outcome)).toEqual(['done', 'done']);
    expect(t.of('tokens').at(-1)?.sessionTotal.costUsd).toBeCloseTo(0.004 + 0.03 + 0.02);
  });

  it('respects noPlan by running the task as one step', async () => {
    const t = setup({ complexity: 'large_build', needsPlan: true });
    await t.pipeline.runTask('make me a snake game', { noPlan: true });
    expect(t.calls.map((c) => c.role)).toEqual(['classifier', 'executor']);
    expect(t.of('stage').some((e) => e.stage === 'plan' && e.status === 'skipped')).toBe(true);
  });

  it('accumulates session totals across tasks', async () => {
    const t = setup();
    await t.pipeline.runTask('a');
    await t.pipeline.runTask('b');
    expect(t.pipeline.sessionTotal.costUsd).toBeCloseTo(0.028);
  });
});

describe('Pipeline: dry run', () => {
  it('classifies and plans but never executes', async () => {
    const t = setup({ complexity: 'large_build', needsPlan: true });
    const s = await t.pipeline.runTask('make me a snake game', { dryRun: true });
    expect(s.ok).toBe(true);
    expect(t.calls.map((c) => c.role)).toEqual(['classifier', 'planner']);
    expect(t.execCalls).toEqual([]);
    const ready = t.of('plan:ready')[0]!;
    expect(Object.values(ready.routes).map((r) => r.tier)).toEqual(['sonnet', 'sonnet']);
    expect(ready.routes['s1']?.reason).toContain('rated'); // the rater explains itself
    expect(t.of('step:start')).toHaveLength(0);
  });

  it('honours setDryRun() and still routes a plain task', async () => {
    const t = setup({ complexity: 'trivial' });
    t.pipeline.setDryRun(true);
    await t.pipeline.runTask('what is a monad');
    expect(t.calls.map((c) => c.role)).toEqual(['classifier']);
    expect(Object.values(t.of('plan:ready')[0]!.routes)[0]?.tier).toBe('haiku');
  });
});

describe('Pipeline: approval', () => {
  it('pauses for approval and executes only the steps the user kept', async () => {
    const t = setup({ complexity: 'large_build', needsPlan: true });
    const p = t.pipeline.runTask('build it');
    while (!t.types().includes('plan:ready')) await tick();
    await tick();
    expect(t.calls.filter((c) => c.role === 'executor')).toHaveLength(0);
    const plan = t.of('plan:ready')[0]!.plan;
    t.pipeline.approvePlan({ ...plan, steps: plan.steps.map((s, i) => (i === 1 ? { ...s, skipped: true } : s)) });
    const s = await p;
    expect(t.calls.filter((c) => c.role === 'executor')).toHaveLength(1);
    expect(s.steps.map((x) => x.outcome)).toEqual(['done', 'skipped']);
    expect(t.types()).toContain('plan:approved');
  });

  it('lets the user pick a model per step during approval', async () => {
    const t = setup({ complexity: 'large_build', needsPlan: true });
    const p = t.pipeline.runTask('build it');
    while (!t.types().includes('plan:ready')) await tick();
    await tick();
    const plan = t.of('plan:ready')[0]!.plan;
    t.pipeline.approvePlan({ ...plan, steps: plan.steps.map((s, i) => (i === 0 ? { ...s, tier: 'opus' as const } : s)) });
    await p;
    expect(t.calls.filter((c) => c.role === 'executor').map((c) => c.model)).toEqual(['opus', 'sonnet']);
  });

  it('cancelling during approval ends the task as cancelled', async () => {
    const t = setup({ complexity: 'large_build', needsPlan: true });
    const p = t.pipeline.runTask('build it');
    while (!t.types().includes('plan:ready')) await tick();
    await tick();
    t.pipeline.cancel();
    const s = await p;
    expect(s.cancelled).toBe(true);
    expect(t.types()).toContain('task:cancelled');
    expect(t.calls.filter((c) => c.role === 'executor')).toHaveLength(0);
  });
});

describe('Pipeline: verify, retry and escalation', () => {
  it('retries once on the same model when verification fails, feeding the error back', async () => {
    const t = setup({ checks: (n) => n >= 2 });
    const s = await t.pipeline.runTask('fix it');
    const ex = t.calls.filter((c) => c.role === 'executor');
    expect(ex.map((c) => c.model)).toEqual(['sonnet', 'sonnet']);
    expect(ex[1]?.prompt).toContain('FAILED: assertion x');
    expect(s.ok).toBe(true);
    expect(s.steps[0]).toMatchObject({ attempts: 2, escalated: false, outcome: 'done' });
    expect(t.of('step:start').map((e) => e.attempt)).toEqual([1, 2]);
  });

  it('escalates to the next model after the retry also fails', async () => {
    const t = setup({ checks: (n) => n >= 3 });
    const s = await t.pipeline.runTask('fix it');
    expect(t.calls.filter((c) => c.role === 'executor').map((c) => c.model)).toEqual(['sonnet', 'sonnet', 'opus']);
    const esc = t.of('step:escalate')[0]!;
    expect([esc.from, esc.to]).toEqual(['sonnet', 'opus']);
    expect(s.steps[0]).toMatchObject({ attempts: 3, escalated: true, tier: 'opus', model: 'opus', outcome: 'done' });
  });

  it('gives up when the top model also fails and stops later steps', async () => {
    const t = setup({ complexity: 'large_build', needsPlan: true, checks: () => false });
    const s = await t.pipeline.runTask('build it', { autoApprove: true });
    expect(s.ok).toBe(false);
    expect(t.calls.filter((c) => c.role === 'executor').map((c) => c.model)).toEqual(['sonnet', 'sonnet', 'opus', 'opus']);
    expect(s.steps).toHaveLength(1);
    expect(t.of('step:failed')).toHaveLength(1);
    expect(t.of('task:done')[0]?.ok).toBe(false);
  });

  it('never escalates away from a forced model', async () => {
    const t = setup({ checks: () => false });
    t.pipeline.forceModel('haiku');
    const s = await t.pipeline.runTask('fix it');
    expect(t.calls.filter((c) => c.role === 'executor').map((c) => c.model)).toEqual(['haiku', 'haiku']);
    expect(t.of('step:escalate')).toHaveLength(0);
    expect(s.ok).toBe(false);
  });

  it('applies a forced model to execution and to the planner', async () => {
    const t = setup({ complexity: 'large_build', needsPlan: true });
    t.pipeline.forceModel('sonnet');
    await t.pipeline.runTask('build it', { autoApprove: true });
    expect(t.calls.filter((c) => c.role !== 'classifier').every((c) => c.model === 'sonnet')).toBe(true);
  });

  it('treats a generic Claude failure as a failed attempt and retries', async () => {
    const t = setup({ executor: (_c, n) => { if (n === 1) throw new SmartError('claude', 'budget exceeded'); return res(); } });
    const s = await t.pipeline.runTask('x');
    expect(s.ok).toBe(true);
    expect(s.steps[0]?.attempts).toBe(2);
  });

  it('passes files edited in earlier steps to later steps', async () => {
    const t = setup({
      complexity: 'large_build', needsPlan: true,
      executor: (_c, n, o) => { if (n === 1) o.onEvent?.({ kind: 'tool', name: 'Write', summary: 'Write a.js', writtenFile: 'a.js' }); return res(); },
    });
    await t.pipeline.runTask('build it', { autoApprove: true });
    expect(t.calls.filter((c) => c.role === 'executor')[1]?.prompt).toContain('Files changed in earlier steps: a.js');
  });
});

describe('Pipeline: errors and cancellation', () => {
  it('reports auth errors with a hint and does not retry', async () => {
    const t = setup({ executor: () => { throw new SmartError('auth', 'not logged in', 'Run claude'); } });
    const s = await t.pipeline.runTask('x');
    expect(s.ok).toBe(false);
    expect(t.calls.filter((c) => c.role === 'executor')).toHaveLength(1);
    expect(t.of('error')[0]).toMatchObject({ kind: 'auth', hint: 'Run claude' });
  });

  it('reports a missing CLI from the classifier stage', async () => {
    const bus = new EventBus();
    const events: SmartEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const p = new Pipeline(defaultConfig(), bus, '.', { run: async () => { throw new SmartError('cli_missing', 'no claude'); } });
    const s = await p.runTask('x');
    expect(s.ok).toBe(false);
    expect(events.find((e) => e.type === 'error')).toMatchObject({ kind: 'cli_missing' });
  });

  it('cancels a running step and reports it as cancelled, not failed', async () => {
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const t = setup({
      executor: (_c, _n, o) => new Promise((_, reject) => {
        started();
        o.signal?.addEventListener('abort', () => reject(new SmartError('cancelled', 'Cancelled.')));
      }),
    });
    const p = t.pipeline.runTask('x');
    await ready;
    t.pipeline.cancel();
    const s = await p;
    expect(s.cancelled).toBe(true);
    expect(s.ok).toBe(false);
    expect(t.types()).toContain('task:cancelled');
    expect(t.of('error')).toHaveLength(0);
    expect(s.steps[0]?.outcome).toBe('cancelled');
    expect(t.pipeline.isRunning).toBe(false);
  });

  it('rejects a second task while one is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup({ executor: async () => { await gate; return res(); } });
    const p = t.pipeline.runTask('x');
    await tick();
    await expect(t.pipeline.runTask('y')).rejects.toThrow(/already running/);
    release();
    await p;
  });
});

describe('Pipeline: notices and tracking', () => {
  it('runs steps with acceptEdits by default and says nothing about bypassing', async () => {
    const modes: (string | undefined)[] = [];
    const t = setup({ executor: (_c, _n, o) => { modes.push(o.permissionMode); return res(); } });
    await t.pipeline.runTask('make the parser handle empty input');
    expect(modes).toEqual(['acceptEdits']);
    expect(t.of('notice').some((n) => /bypass/i.test(n.message))).toBe(false);
  });

  it('warns when /mode switches to bypassPermissions at runtime', () => {
    const t = setup();
    t.pipeline.setPermissionMode('bypassPermissions');
    expect(t.of('notice').some((n) => n.level === 'warn' && /bypassed from now on/.test(n.message))).toBe(true);
    t.pipeline.setPermissionMode('plan');
    expect(t.of('notice').filter((n) => /bypassed/.test(n.message))).toHaveLength(1);
  });

  it('warns once when bypassPermissions is active, and explains the root fallback', async () => {
    const bypass = (c: SmartConfig) => { c.runner.permissionMode = 'bypassPermissions'; };
    const normal = setup({ config: bypass });
    await normal.pipeline.runTask('a');
    await normal.pipeline.runTask('b');
    const notices = normal.of('notice').filter((n) => /bypassed/.test(n.message));
    expect(notices).toHaveLength(1);

    const root = setup({ uid: 0, config: bypass });
    await root.pipeline.runTask('a');
    expect(root.of('notice').some((n) => /root/.test(n.message))).toBe(true);
  });

  it('falls back to sonnet and warns when classification is malformed', async () => {
    const calls: string[] = [];
    const run: RunClaudeFn = async (o) => {
      calls.push(o.model);
      return o.jsonSchema ? res({ text: 'garbage' }) : res();
    };
    const bus = new EventBus();
    const events: SmartEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const cfg = defaultConfig();
    cfg.verify.auto = false;
    await new Pipeline(cfg, bus, '.', { run, uid: 1000 }).runTask('x');
    expect(calls).toEqual(['haiku', 'sonnet']);
    expect(events.some((e) => e.type === 'notice' && /Classifier unavailable/.test(e.message))).toBe(true);
  });

  it('records the task, per-step model usage and overhead in the tracker', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'smart-pipe-trk-')), 'h.json');
    const tracker = new Tracker(path);
    const t = setup({ complexity: 'large_build', needsPlan: true, tracker });
    await t.pipeline.runTask('build it', { autoApprove: true });
    const [rec] = tracker.load();
    expect(rec?.ok).toBe(true);
    expect(rec?.steps.map((s) => s.model)).toEqual(['sonnet', 'sonnet']);
    expect(rec?.overhead.costUsd).toBeCloseTo(0.034);
    expect(rec?.totals.costUsd).toBeCloseTo(0.054);
    expect(rec?.classification?.complexity).toBe('large_build');
  });

  it('records dry runs too, since classify and plan cost real money', async () => {
    const tracker = new Tracker(join(mkdtempSync(join(tmpdir(), 'smart-pipe-trk-')), 'h.json'));
    const t = setup({ complexity: 'large_build', needsPlan: true, tracker });
    await t.pipeline.runTask('build it', { dryRun: true });
    expect(tracker.load()[0]?.steps).toEqual([]);
    expect(tracker.load()[0]?.totals.costUsd).toBeCloseTo(0.034);
  });
});

describe('Pipeline: stage bookkeeping', () => {
  it('closes the verify stage after checks pass, fail, or are skipped', async () => {
    const verifyStatuses = (t: ReturnType<typeof setup>) => t.of('stage').filter((e) => e.stage === 'verify').map((e) => e.status);
    const pass = setup();
    await pass.pipeline.runTask('x');
    expect(verifyStatuses(pass).at(-1)).toBe('done');

    const fail = setup({ checks: () => false });
    await fail.pipeline.runTask('x');
    expect(verifyStatuses(fail).at(-1)).toBe('failed');

    const none = setup({ config: (c) => { c.verify.commands = []; c.verify.auto = false; } });
    await none.pipeline.runTask('x');
    expect(verifyStatuses(none).at(-1)).toBe('skipped');
  });
});
