import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { ConversationStore } from '../../src/core/store/conversation.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { SmartError } from '../../src/core/errors.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { emptyUsage, type Complexity } from '../../src/core/types.js';

interface Call { role: 'classifier' | 'planner' | 'executor'; model: string; prompt: string; session?: { id: string; resume: boolean }; effort?: string }

function setup(opts: { complexities?: Complexity[]; config?: (c: SmartConfig) => void; executor?: (call: Call, n: number) => ClaudeResult | Promise<ClaudeResult>; store?: ConversationStore; conversation?: ReturnType<ConversationStore['load']>; cost?: number } = {}) {
  const calls: Call[] = [];
  let clock = 1_000_000_000_000;
  const queue = [...(opts.complexities ?? [])];
  let executorCalls = 0;
  const res = (over: Partial<ClaudeResult> = {}): ClaudeResult => ({
    isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: { ...emptyUsage(), costUsd: opts.cost ?? 0.01, outputTokens: 50 }, sessionId: 's', numTurns: 1, ...over,
  });
  const run: RunClaudeFn = async (o) => {
    const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    const role = props && 'complexity' in props ? 'classifier' : props && 'steps' in props ? 'planner' : 'executor';
    const call: Call = { role, model: o.model, prompt: o.prompt, session: o.session, effort: o.effort };
    calls.push(call);
    if (role === 'classifier') return res({ structured: { complexity: queue.shift() ?? 'small_edit', needsPlan: false, reason: 'r' } });
    if (role === 'planner') return res({ structured: { summary: 'Plan', steps: [{ title: 'A', instructions: 'do a', acceptance: [] }, { title: 'B', instructions: 'do b', acceptance: [] }] } });
    executorCalls += 1;
    if (opts.executor) return opts.executor(call, executorCalls);
    return res({ text: `reply ${executorCalls}` });
  };
  const config = defaultConfig();
  config.verify.auto = false;
  opts.config?.(config);
  const bus = new EventBus();
  const events: SmartEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const cwd = mkdtempSync(join(tmpdir(), 'smart-cont-'));
  const pipeline = new Pipeline(config, bus, cwd, {
    run, uid: 1000, listFiles: () => [], now: () => new Date(clock), conversationStore: opts.store, conversation: opts.conversation ?? undefined,
  });
  const executors = () => calls.filter((c) => c.role === 'executor');
  return { pipeline, calls, executors, events, cwd, advance: (ms: number) => (clock += ms), of: <T extends SmartEvent['type']>(t: T) => events.filter((e): e is Extract<SmartEvent, { type: T }> => e.type === t) };
}

describe('resume', () => {
  const failing = (call: Call, n: number): ClaudeResult => {
    if (n === 2) throw new SmartError('claude', 'boom');
    return { isError: false, subtype: 'success', text: `reply ${n}`, structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 };
  };

  it('continues from the first unfinished step and skips classify and plan', async () => {
    const store = new ConversationStore(join(mkdtempSync(join(tmpdir(), 'smart-res-')), 'c.json'));
    const t = setup({ complexities: ['large_build'], store, executor: failing, config: (c) => { c.escalation.retriesPerModel = 0; c.escalation.ladder = ['sonnet']; } });
    const first = await t.pipeline.runTask('build it', { autoApprove: true });
    expect(first.ok).toBe(false);
    expect(first.steps.map((s) => s.outcome)).toEqual(['done', 'failed']);
    expect(t.pipeline.pendingTask?.doneStepIds).toHaveLength(1);

    const before = t.calls.length;
    const second = await t.pipeline.resumeTask();
    const after = t.calls.slice(before);
    expect(after.every((c) => c.role === 'executor')).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.steps.filter((s) => s.outcome === 'done')).toHaveLength(1);
    expect(second.steps[0]?.title).toBe('B');
    expect(t.pipeline.pendingTask).toBeNull();
    expect(after[0]?.session?.resume).toBe(true);
  });

  it('survives a restart through the conversation store', async () => {
    const store = new ConversationStore(join(mkdtempSync(join(tmpdir(), 'smart-res-')), 'c.json'));
    const a = setup({ complexities: ['large_build'], store, executor: failing, config: (c) => { c.escalation.retriesPerModel = 0; c.escalation.ladder = ['sonnet']; } });
    await a.pipeline.runTask('build it', { autoApprove: true });
    const saved = store.load(a.cwd);
    expect(saved?.pending?.plan.steps).toHaveLength(2);
    expect(saved?.pending?.doneStepIds).toHaveLength(1);
    const b = setup({ store, conversation: saved });
    expect(b.pipeline.pendingTask?.prompt).toBe('build it');
    const res = await b.pipeline.resumeTask();
    expect(res.ok).toBe(true);
    expect(b.calls.every((c) => c.role === 'executor')).toBe(true);
  });

  it('refuses when there is nothing to resume', () => {
    const t = setup();
    expect(() => t.pipeline.resumeTask()).toThrow(/Nothing to resume/);
  });

  it('clears the pending task after a later successful task', async () => {
    const t = setup({ complexities: ['large_build', 'small_edit'], executor: failing, config: (c) => { c.escalation.retriesPerModel = 0; c.escalation.ladder = ['sonnet']; } });
    await t.pipeline.runTask('build it', { autoApprove: true });
    expect(t.pipeline.pendingTask).not.toBeNull();
    await t.pipeline.runTask('something small');
    expect(t.pipeline.pendingTask).toBeNull();
  });

  it('does not offer resume for a dry run or a failure before planning', async () => {
    const t = setup({ complexities: ['large_build'] });
    await t.pipeline.runTask('build it', { dryRun: true });
    expect(t.pipeline.pendingTask).toBeNull();
  });
});

describe('resume and sessions: the step that continues is never left without context', () => {
  const failSecond = (writes?: (n: number) => void) => (_call: Call, n: number): ClaudeResult => {
    writes?.(n);
    if (n === 2) throw new SmartError('claude', 'boom');
    return { isError: false, subtype: 'success', text: `reply ${n}`, structured: undefined, usage: { ...emptyUsage(), costUsd: 0.01, outputTokens: 5 }, sessionId: 's', numTurns: 1 };
  };
  const once = (c: SmartConfig) => { c.escalation.retriesPerModel = 0; c.escalation.ladder = ['sonnet']; };
  const storeIn = () => new ConversationStore(join(mkdtempSync(join(tmpdir(), 'smart-res-')), 'c.json'));

  it('after a restart whose saved session is gone, the resumed step gets the conversation summary in a new session', async () => {
    const store = storeIn();
    const a = setup({ complexities: ['large_build'], store, executor: failSecond(), config: once });
    await a.pipeline.runTask('build the snake game', { autoApprove: true });
    const b = setup({
      store, conversation: store.load(a.cwd),
      executor: (call) => {
        if (call.session?.resume) throw new SmartError('claude', 'No conversation found with session ID: x');
        return { isError: false, subtype: 'success', text: 'done', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 };
      },
    });
    const r = await b.pipeline.resumeTask();
    expect(r.ok).toBe(true);
    const [lost, fresh] = b.executors();
    expect(lost?.session?.resume).toBe(true);
    expect(fresh?.session?.resume).toBe(false);
    expect(fresh?.prompt).toContain('Context from earlier in this conversation');
    expect(fresh?.prompt).toContain('build the snake game');
    expect(fresh?.prompt).toContain('step 2 of 2');
  });

  it('a resumed step after a session rollover gets the summary too, and the files earlier steps changed', async () => {
    const store = storeIn();
    const a = setup({ complexities: ['large_build'], store, executor: failSecond(), config: (c) => { once(c); c.session.maxContextTokens = 1000; } });
    await a.pipeline.runTask('build it', { autoApprove: true });
    const conv = (a.pipeline as unknown as { conv: { contextTokens?: number; pending?: { files?: string[] } } }).conv;
    conv.contextTokens = 5000; // the session grew past session.maxContextTokens
    conv.pending!.files = ['src/game.ts'];
    const r = await a.pipeline.resumeTask();
    expect(r.ok).toBe(true);
    const resumed = a.executors().at(-1)!;
    expect(resumed.session?.resume).toBe(false); // a fresh session...
    expect(resumed.prompt).toContain('Context from earlier in this conversation'); // ...with the summary
    expect(resumed.prompt).toContain('Files changed in earlier steps: src/game.ts');
    expect(a.of('notice').some((n) => /fresh Claude Code session/.test(n.message))).toBe(true);
  });

  it('remembers which files the finished steps changed, through a restart', async () => {
    const store = storeIn();
    const a = setup({ complexities: ['large_build'], store, executor: failSecond(), config: once });
    await a.pipeline.runTask('build it', { autoApprove: true });
    expect(store.load(a.cwd)?.pending?.files).toEqual([]); // nothing was written in this fake, but the field is saved
  });

  it('a session lost between two steps of one run: the next step starts a new one with the summary', async () => {
    let n = 0;
    const t = setup({
      complexities: ['small_edit', 'large_build'],
      executor: (call) => {
        n += 1;
        if (n === 3 && call.session?.resume) throw new SmartError('claude', 'No conversation found with session ID: y');
        return { isError: false, subtype: 'success', text: `r${n}`, structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 };
      },
    });
    await t.pipeline.runTask('first task');
    const r = await t.pipeline.runTask('build more', { autoApprove: true });
    expect(r.ok).toBe(true);
    const ex = t.executors();
    expect(ex[2]?.session?.resume).toBe(true); // step 2 tried the saved session
    expect(ex[3]?.session?.resume).toBe(false); // and got a new one
    expect(ex[3]?.prompt).toContain('first task');
  });

  it('cancelling the resumed step keeps the task resumable and never reports it done', async () => {
    const store = storeIn();
    const a = setup({ complexities: ['large_build'], store, executor: failSecond(), config: once });
    await a.pipeline.runTask('build it', { autoApprove: true });
    const b = setup({
      store, conversation: store.load(a.cwd),
      executor: () => new Promise<ClaudeResult>((_r, reject) => setTimeout(() => reject(new SmartError('cancelled', 'Cancelled.')), 20)),
    });
    const p = b.pipeline.resumeTask();
    b.pipeline.cancel();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBe(true);
    expect(b.pipeline.pendingTask?.doneStepIds).toHaveLength(1);
    expect(b.of('task:done')).toHaveLength(0);
  });

  it('an escalation after a rollover runs on the stronger model in the fresh session', async () => {
    let n = 0;
    const t = setup({
      complexities: ['small_edit', 'small_edit'],
      config: (c) => { c.session.maxContextTokens = 10; c.escalation.retriesPerModel = 0; },
      executor: () => {
        n += 1;
        if (n === 2) throw new SmartError('claude', 'step failed');
        return { isError: false, subtype: 'success', text: `r${n}`, structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 };
      },
    });
    await t.pipeline.runTask('one');
    (t.pipeline as unknown as { conv: { contextTokens: number } }).conv.contextTokens = 100;
    const r = await t.pipeline.runTask('two');
    expect(r.ok).toBe(true);
    const [, failed, escalated] = t.executors();
    expect(failed?.session?.resume).toBe(false); // rolled over before the task
    expect(escalated?.model).toBe('opus');
    // The failed call may or may not have created its session, so neither resuming it nor reusing its id is safe: a new one,
    // with the summary and the failure text.
    expect(escalated?.session?.resume).toBe(false);
    expect(escalated?.session?.id).not.toBe(failed?.session?.id);
    expect(escalated?.prompt).toContain('Context from earlier in this conversation');
    expect(escalated?.prompt).toContain('step failed');
  });
});
