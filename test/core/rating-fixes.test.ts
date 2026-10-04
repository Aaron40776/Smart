import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { SmartError } from '../../src/core/errors.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { extractFeatures, localScore } from '../../src/core/rating/features.js';
import { buildHistory } from '../../src/core/rating/learn.js';
import { route } from '../../src/core/router.js';
import type { StepRecord, TaskRecord } from '../../src/core/store/tracker.js';
import { emptyUsage, type Classification } from '../../src/core/types.js';
import { describeRating } from '../../src/rate.js';

interface Call { role: 'classifier' | 'planner' | 'executor'; model: string; effort?: string }

/** A pipeline with a scripted Claude: the classifier says `classifier`, the planner returns `steps`, the coder runs `coder`. */
function setup(opts: { classifier?: Record<string, unknown>; steps?: object[]; config?: (c: SmartConfig) => void; coder?: (n: number) => void } = {}) {
  const calls: Call[] = [];
  let coderCalls = 0;
  const ok = (over: Partial<ClaudeResult> = {}): ClaudeResult => ({ isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: { ...emptyUsage(), costUsd: 0.01 }, sessionId: 's', numTurns: 1, ...over });
  const run: RunClaudeFn = async (o) => {
    const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    const role = props && 'complexity' in props ? 'classifier' : props && 'steps' in props ? 'planner' : 'executor';
    calls.push({ role, model: o.model, effort: o.effort });
    if (role === 'classifier') return ok({ structured: { complexity: 'small_edit', needsPlan: false, reason: 'r', ...opts.classifier } });
    if (role === 'planner') return ok({ structured: { summary: 'Plan', steps: opts.steps ?? [{ title: 'A', instructions: 'do a' }, { title: 'B', instructions: 'do b' }] } });
    coderCalls += 1;
    opts.coder?.(coderCalls);
    return ok();
  };
  const config = defaultConfig();
  config.verify.auto = false;
  config.review.enabled = false;
  opts.config?.(config);
  const bus = new EventBus();
  const events: SmartEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const cwd = mkdtempSync(join(tmpdir(), 'smart-ratefix-'));
  const pipeline = new Pipeline(config, bus, cwd, { run, uid: 1000, listFiles: () => [] });
  return { pipeline, calls, events, cwd, coder: () => calls.filter((c) => c.role === 'executor') };
}

describe('retries', () => {
  it('raise the effort once from the rated level; a second retry does not add another level', async () => {
    const t = setup({
      classifier: { difficulty: 'easy' },
      config: (c) => { c.escalation.retriesPerModel = 3; },
      coder: (n) => { if (n <= 2) throw new SmartError('claude', 'boom'); },
    });
    await t.pipeline.runTask('fix the typo in the readme');
    expect(t.coder().map((c) => c.effort)).toEqual(['low', 'medium', 'medium']);
    expect(new Set(t.coder().map((c) => c.model)).size).toBe(1);
  });
});

describe('what learning records', () => {
  it('files the step under the rung the rater used, also when effort is not applied (autoEffort off)', async () => {
    const t = setup({ classifier: { difficulty: 'easy' }, config: (c) => { c.runner.autoEffort = false; } });
    const res = await t.pipeline.runTask('fix the typo in the readme');
    expect(t.coder()[0]?.effort).toBeUndefined(); // nothing is passed to Claude Code
    expect(res.steps[0]?.rated).toMatchObject({ tier: 'sonnet', effort: 'low' }); // but the record uses the rater's own rung, so lookups match
  });

  it('ignores steps that never ran (the task budget was already spent) instead of counting them as failures', () => {
    const never: StepRecord = { stepId: 's', title: 't', model: 'sonnet', tier: 'sonnet', attempts: 0, escalated: false, usage: emptyUsage(), outcome: 'failed', rated: { tier: 'sonnet', effort: 'medium', score: 0.35 } };
    const task: TaskRecord = { id: 't', startedAt: new Date().toISOString(), prompt: 'p', overhead: emptyUsage(), steps: [never, never, never], totals: emptyUsage(), ok: false };
    expect(buildHistory([task]).size).toBe(0);
  });
});

describe('a single step written by the planner', () => {
  it('is rated with the planner\'s difficulty, unlike the fallback single step', async () => {
    const rated = setup({ classifier: { complexity: 'large_build', needsPlan: true }, steps: [{ title: 'Queue', instructions: 'implement the work queue', difficulty: 'hard' }] });
    await rated.pipeline.runTask('build a job runner', { autoApprove: true });
    expect(rated.coder()[0]?.model).toBe('opus');
    const unrated = setup({ classifier: { complexity: 'large_build', needsPlan: true }, steps: [{ title: 'Queue', instructions: 'implement the work queue' }] });
    await unrated.pipeline.runTask('build a job runner', { autoApprove: true });
    expect(unrated.coder()[0]?.model).toBe('sonnet');
  });
});

describe('files the request refers to', () => {
  it('count towards the size of the work in the step that runs, not only in the classification', async () => {
    const t = setup({ classifier: { complexity: 'multi_file' } });
    for (const f of ['a', 'b', 'c', 'd', 'e', 'f']) writeFileSync(join(t.cwd, `${f}.ts`), 'x');
    await t.pipeline.runTask('tidy up @a.ts @b.ts @c.ts @d.ts @e.ts @f.ts');
    const started = t.events.find((e): e is Extract<SmartEvent, { type: 'step:start' }> => e.type === 'step:start')!;
    const classified = t.events.find((e): e is Extract<SmartEvent, { type: 'classified' }> => e.type === 'classified')!;
    expect(started.route.reason).toContain('6 files');
    expect(classified.route.reason).toContain('6 files');
  });
});

describe('the routing reason', () => {
  const cls: Classification = { complexity: 'small_edit', needsPlan: false, reason: '', difficulty: 'easy' };

  it('names the effort only when it will be applied', () => {
    const on = route({ classification: cls, text: 'fix the typo in the readme' }, defaultConfig());
    const c = defaultConfig();
    c.runner.autoEffort = false;
    const off = route({ classification: cls, text: 'fix the typo in the readme' }, c);
    expect(on.reason).toMatch(/^sonnet · low ·/);
    expect(off.reason).toMatch(/^sonnet · rated/);
  });

  it('starts with the verdict, so a truncated line still shows the decision', () => {
    expect(route({ classification: cls, text: 'fix the typo in the readme' }, defaultConfig()).reason.split(' · ').slice(0, 2)).toEqual(['sonnet', 'low']);
  });
});

describe('easy-edit signals are limited to clearly small changes', () => {
  const easy = (text: string) => extractFeatures({ text }).easy.some((s) => s.label === 'trivial edit');

  it('does not treat feature nouns as trivial', () => {
    for (const t of ['add a comment system with threaded replies', 'copy files between buckets', 'implement font loading with fallbacks', 'add permissions labels to the admin screen']) expect(easy(t), t).toBe(false);
  });

  it('still recognises the small changes people actually ask for', () => {
    for (const t of ['fix the typo in the readme', 'rename the variable x to count', 'add a comment above the loop', 'change the button colour to blue', 'update the label wording', 'bump the version number', 'remove the unused import']) expect(easy(t), t).toBe(true);
  });

  it('a feature that merely contains such a word is scored above the routine edit', () => {
    const score = (t: string) => localScore(extractFeatures({ text: t })).score;
    expect(score('add a comment system with threaded replies')).toBeGreaterThan(score('add a comment above the loop'));
  });
});

describe('smart --rate', () => {
  it('shows both answers when the floor matters: a question may go to Haiku, a change starts at Sonnet', () => {
    const out = describeRating('fix the typo in the readme', defaultConfig()).join('\n');
    expect(out).toMatch(/Decision: sonnet · \w+ for a change/);
    expect(out).toMatch(/If it is only a question: haiku/);
  });

  it('a hard task is the same model whether it is a change or a question', () => {
    const out = describeRating('the workers stall intermittently, find the root cause of this concurrency bug in the pool', defaultConfig()).join('\n');
    expect(out).toMatch(/Decision: opus · \w+ for a change/);
    expect(out).toMatch(/If it is only a question: opus/);
  });
});
