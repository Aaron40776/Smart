import { describe, expect, it } from 'vitest';
import { adjustRung, buildHistory, PROJECT_CAP, statsKey } from '../../src/core/rating/learn.js';
import { RUNGS } from '../../src/core/rating/rate.js';
import { projectKey, type StepRecord, type TaskRecord } from '../../src/core/store/tracker.js';
import { emptyUsage } from '../../src/core/types.js';

const NOW = Date.parse('2026-06-15T12:00:00Z');
const mid = { tier: 'sonnet', effort: 'medium', score: 0.35 };
const KEY = statsKey('sonnet', 'medium', 0.35);
const step = (over: Partial<StepRecord> = {}): StepRecord => ({
  stepId: 's', title: 't', model: 'sonnet', tier: 'sonnet', attempts: 1, escalated: false, usage: emptyUsage(), outcome: 'done', rated: mid, ...over,
});
let n = 0;
const task = (steps: StepRecord[], over: Partial<TaskRecord> = {}): TaskRecord => ({
  id: `t${++n}`, startedAt: new Date(NOW - 86_400_000 + n * 1000).toISOString(), prompt: 'p', overhead: emptyUsage(), steps, totals: emptyUsage(), ok: true, ...over,
});
const miss = (over: Partial<StepRecord> = {}) => step({ attempts: 2, outcome: 'failed', failure: 'verify', ...over });

describe('learning does not overreact', () => {
  it('ignores failures that are not the model\'s: environment, budget, limit, cancel, timeout', () => {
    const h = buildHistory(['environment', 'budget', 'limit', 'cancelled', 'timeout'].map((f) => task([miss({ failure: f as StepRecord['failure'] })])), NOW);
    expect(h.get(KEY)).toBeUndefined();
    expect(buildHistory([task([miss()])], NOW).get(KEY)).toEqual({ n: 1, ok: 0 }); // a real verification failure counts
  });

  it('does not count attempts lost to Claude Code not starting', () => {
    const h = buildHistory([task([step({ attempts: 2, environmentRetries: 1 })])], NOW);
    expect(h.get(KEY)).toEqual({ n: 1, ok: 1 });
  });

  it('ignores a step that failed even on the top model: a stronger start would not have helped (or the suite was already red)', () => {
    const h = buildHistory([task([miss({ tier: 'opus', escalated: true, attempts: 4 })])], NOW);
    expect(h.get(KEY)).toBeUndefined();
    // with a ladder that tops out at sonnet, sonnet is the top
    expect(buildHistory([task([miss({ tier: 'sonnet', escalated: true })])], NOW, { topTier: 'sonnet' }).get(KEY)).toBeUndefined();
    // a step that escalated and then passed is still evidence that its first rung was too weak
    expect(buildHistory([task([step({ tier: 'opus', escalated: true, attempts: 3 })])], NOW).get(KEY)).toEqual({ n: 1, ok: 0 });
  });

  it('a /bad on a task with many steps counts once per rung', () => {
    const h = buildHistory([task(Array.from({ length: 6 }, () => step()), { feedback: 'bad' })], NOW);
    expect(h.get(KEY)).toEqual({ n: 1, ok: 0 });
  });

  it('one project cannot dominate a rung: only its most recent steps count', () => {
    const p = projectKey('/work/troubled');
    const bad = Array.from({ length: 40 }, () => task([miss()], { project: p }));
    const good = Array.from({ length: 8 }, () => task([step()], { project: projectKey('/work/fine') }));
    const h = buildHistory([...bad, ...good], NOW).get(KEY)!;
    expect(h).toEqual({ n: PROJECT_CAP + 8, ok: 8 });
    // records from before projects were recorded keep counting in full
    expect(buildHistory(Array.from({ length: 12 }, () => task([miss()])), NOW).get(KEY)!.n).toBe(12);
  });

  it('tiny samples change nothing, and no history moves more than one rung (no runaway escalation)', () => {
    const few = buildHistory(Array.from({ length: 5 }, () => task([miss()])), NOW);
    expect(adjustRung(2, 1, 0.35, RUNGS, few).idx).toBe(2);
    const all = buildHistory(Array.from({ length: 200 }, () => task([step()], { feedback: 'bad' })), NOW);
    expect(adjustRung(2, 1, 0.35, RUNGS, all).idx).toBe(3);
  });

  it('is deterministic: the same records give the same history whatever their order', () => {
    const records = [task([miss()], { project: 'a' }), task([step()], { project: 'b' }), task([step()], { feedback: 'bad' })];
    expect(buildHistory([...records].reverse(), NOW)).toEqual(buildHistory(records, NOW));
  });

  it('projectKey is a short hash, the same for any spelling of a Windows folder', () => {
    expect(projectKey('C:\\Users\\Me\\App', 'win32')).toBe(projectKey('c:\\users\\me\\app\\', 'win32'));
    expect(projectKey('/home/me/app', 'linux')).toMatch(/^[0-9a-f]{16}$/);
    expect(projectKey('/home/me/app', 'linux')).not.toContain('home');
  });
});
