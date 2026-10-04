import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArgs, callError, isOverloaded, StreamParser, type ClaudeResult, type RunClaudeFn, type RunClaudeOptions } from '../../src/core/claude.js';
import type { Checkpointer } from '../../src/core/checkpoint.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { overloadedError } from '../../src/core/errors.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { emptyUsage } from '../../src/core/types.js';
import { toRows } from '../../src/ui/components/OutputLog.js';
import { initialState, reduce } from '../../src/ui/state.js';

const res = (over: Partial<ClaudeResult> = {}, cost = 0.01): ClaudeResult => ({ isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: { ...emptyUsage(), costUsd: cost }, sessionId: 's', numTurns: 1, ...over });
const isClassifier = (o: RunClaudeOptions) => Boolean((o.jsonSchema as { properties?: object } | undefined)?.properties && 'complexity' in (o.jsonSchema as { properties: object }).properties);

function setup(opts: { executor: (o: RunClaudeOptions, n: number) => ClaudeResult | Promise<ClaudeResult>; config?: (c: SmartConfig) => void; checkpoints?: Checkpointer; now?: () => Date }) {
  const calls: RunClaudeOptions[] = [];
  const slept: number[] = [];
  let n = 0;
  const run: RunClaudeFn = async (o) => {
    if (isClassifier(o)) return res({ structured: { complexity: 'small_edit', needsPlan: false, reason: 'r' } });
    calls.push(o);
    n += 1;
    return opts.executor(o, n);
  };
  const config = defaultConfig();
  config.verify.auto = false;
  config.review.enabled = false;
  opts.config?.(config);
  const bus = new EventBus();
  const events: SmartEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const pipeline = new Pipeline(config, bus, mkdtempSync(join(tmpdir(), 'smart-b2-')), {
    run, uid: 1000, listFiles: () => [], checkpoints: opts.checkpoints, now: opts.now,
    sleep: async (ms) => void slept.push(ms),
  });
  return { pipeline, calls, slept, events, of: <T extends SmartEvent['type']>(t: T) => events.filter((e): e is Extract<SmartEvent, { type: T }> => e.type === t) };
}

describe('live replies', () => {
  it('the parser turns streamed text into deltas, skipping thinking and subagents', () => {
    const p = new StreamParser();
    const line = (event: object, parent: string | null = null) => `${JSON.stringify({ type: 'stream_event', event, parent_tool_use_id: parent })}\n`;
    expect(p.push(line({ type: 'content_block_delta', delta: { type: 'text_delta', text: '1\n2' } }))).toEqual([{ kind: 'text-delta', text: '1\n2' }]);
    expect(p.push(line({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } }))).toEqual([]);
    expect(p.push(line({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } }, 'toolu_1'))).toEqual([]);
    expect(buildArgs({ prompt: '', model: 'sonnet', cwd: '.', partial: true })).toContain('--include-partial-messages');
    expect(buildArgs({ prompt: '', model: 'sonnet', cwd: '.' })).not.toContain('--include-partial-messages');
  });

  it('coding steps ask for live text and pass it on as step:stream', async () => {
    const t = setup({
      executor: (o) => {
        o.onEvent?.({ kind: 'text-delta', text: 'Wor' });
        o.onEvent?.({ kind: 'text-delta', text: 'king' });
        o.onEvent?.({ kind: 'text', text: 'Working.' });
        return res({ text: 'Working.' });
      },
    });
    await t.pipeline.runTask('make the parser handle empty input');
    expect(t.calls[0]?.partial).toBe(true);
    expect(t.of('step:stream').map((e) => e.text)).toEqual(['Wor', 'king']);
  });

  it('the output panel grows one live line and swaps in the complete text', () => {
    let s = reduce(initialState(), { type: 'step:stream', stepId: 's1', text: 'Hel' });
    s = reduce(s, { type: 'step:stream', stepId: 's1', text: 'lo' });
    expect(s.output).toHaveLength(1);
    expect(s.output[0]).toMatchObject({ text: 'Hello', live: true });
    s = reduce(s, { type: 'step:output', stepId: 's1', kind: 'text', text: 'Hello there.' });
    expect(s.output.map((l) => [l.text, Boolean(l.live)])).toEqual([['Hello there.', false]]);
    s = reduce(s, { type: 'step:output', stepId: 's1', kind: 'tool', text: 'Edit a.ts' });
    s = reduce(s, { type: 'step:stream', stepId: 's1', text: 'Next' });
    expect(s.output.map((l) => l.text)).toEqual(['Hello there.', 'Edit a.ts', 'Next']);
  });

  it('wrapping is cached per line, so streaming re-wraps only the growing line', () => {
    const lines = [{ id: 1, kind: 'text' as const, text: 'a long line of text that wraps' }, { id: 2, kind: 'text' as const, text: 'b' }];
    const first = toRows(lines, 12);
    const again = toRows([lines[0]!, { ...lines[1]!, text: 'bb' }], 12);
    expect(again.slice(0, 3)).toEqual(first.slice(0, 3));
    expect(toRows(lines, 40)).toHaveLength(2); // another width is wrapped afresh
  });
});

describe('overloaded servers', () => {
  it('are recognised in short error lines only', () => {
    expect(isOverloaded('API Error: 529 {"type":"overloaded_error"}')).toBe(true);
    expect(isOverloaded('API Error: 500 Internal server error')).toBe(true);
    expect(isOverloaded(`Refactored the overloaded constructor. ${'More. '.repeat(100)}`)).toBe(false);
    expect(callError('API Error: 529 Overloaded', 'x').kind).toBe('overloaded');
  });

  it('wait and try again instead of counting a failure or escalating', async () => {
    const t = setup({ executor: (_o, n) => { if (n === 1) throw overloadedError('API Error: 529'); return res(); } });
    const out = await t.pipeline.runTask('make the parser handle empty input');
    expect(out.ok).toBe(true);
    expect(t.slept).toEqual([15_000]);
    expect(t.calls.map((c) => c.model)).toEqual(['sonnet', 'sonnet']);
    expect(t.of('step:escalate')).toHaveLength(0);
    expect(t.of('notice').some((n) => n.message.startsWith("Claude's servers are overloaded; trying again in 15 s"))).toBe(true);
  });

  it('stop the task after two waits, and keep it for /resume', async () => {
    const t = setup({ executor: () => { throw overloadedError('API Error: 529'); } });
    await t.pipeline.runTask('make the parser handle empty input');
    expect(t.slept).toEqual([15_000, 45_000]);
    expect(t.of('error')[0]).toMatchObject({ kind: 'overloaded' });
    expect(t.of('error')[0]?.hint).toContain('/resume');
    expect(t.pipeline.pendingTask?.prompt).toBe('make the parser handle empty input');
  });
});

describe('the task budget is a hard cap', () => {
  it('each coding call gets what is left of the task budget', async () => {
    const t = setup({
      config: (c) => { c.limits.maxBudgetUsdPerTask = 1; },
      executor: (_o, n) => {
        if (n === 1) {
          const e = overloadedError('x');
          Object.assign(e, { kind: 'claude', usage: { ...emptyUsage(), costUsd: 0.4 } }); // a failed attempt that cost $0.40
          throw e;
        }
        return res();
      },
    });
    await t.pipeline.runTask('make the parser handle empty input');
    // $1 minus the classifier's $0.01, then minus the failed attempt's $0.40
    expect(t.calls.map((c) => c.maxBudgetUsd)).toEqual([0.99, 0.59]);
  });

  it('the smaller of the per-step cap and what is left', async () => {
    const t = setup({ config: (c) => { c.limits.maxBudgetUsdPerTask = 5; c.limits.maxBudgetUsdPerStep = 0.5; }, executor: () => res() });
    await t.pipeline.runTask('make the parser handle empty input');
    expect(t.calls[0]?.maxBudgetUsd).toBe(0.5);
    const none = setup({ executor: () => res() });
    await none.pipeline.runTask('make the parser handle empty input');
    expect(none.calls[0]?.maxBudgetUsd).toBeNull();
  });
});

describe('fewer, faster snapshots', () => {
  const fakeCp = (delayMs: number, clock: { t: number }) => {
    let n = 0;
    const cp: Checkpointer & { count: () => number } = {
      available: true, root: '/r', prefix: '',
      snapshot: async () => { n += 1; clock.t += delayMs; return `tree${n}`; },
      changes: async () => ({ files: [{ path: 'a.ts', status: 'M' }], insertions: 1, deletions: 0 }),
      diff: async () => '', restore: async () => ({ restored: 0, removed: 0, failed: [] }), dispose: () => undefined,
      count: () => n,
    };
    return cp;
  };

  it('the end of a task reuses the last step\'s snapshot when nothing ran after it', async () => {
    const clock = { t: 0 };
    const cp = fakeCp(10, clock);
    const t = setup({ executor: () => res(), checkpoints: cp, now: () => new Date(clock.t) });
    await t.pipeline.runTask('make the parser handle empty input');
    expect(cp.count()).toBe(2); // before, and after the step; not again at the end
    expect(t.of('changes')).toHaveLength(1);
  });

  it('but takes a new one when a check ran after the step (it may have written files)', async () => {
    const clock = { t: 0 };
    const cp = fakeCp(10, clock);
    const t = setup({ executor: () => res(), checkpoints: cp, now: () => new Date(clock.t), config: (c) => { c.verify.commands = ['true']; } });
    await t.pipeline.runTask('make the parser handle empty input');
    expect(cp.count()).toBe(3);
  });

  it('a slow snapshot is pointed out once, with the fix', async () => {
    const clock = { t: 0 };
    const t = setup({ executor: () => res(), checkpoints: fakeCp(5000, clock), now: () => new Date(clock.t) });
    await t.pipeline.runTask('make the parser handle empty input');
    await t.pipeline.runTask('now handle null too');
    const hints = t.of('notice').filter((n) => n.message.includes('core.fsmonitor'));
    expect(hints).toHaveLength(1);
    expect(hints[0]?.message).toContain('took 5.0 s');
  });
});
