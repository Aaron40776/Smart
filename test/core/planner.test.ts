import { describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { defaultConfig } from '../../src/core/config.js';
import { SmartError } from '../../src/core/errors.js';
import { makePlan, parsePlan, singleStepPlan } from '../../src/core/planner.js';
import { emptyUsage, type Classification } from '../../src/core/types.js';

const cls: Classification = { complexity: 'large_build', needsPlan: true, reason: 'x' };
const result = (structured: unknown): ClaudeResult => ({
  isError: false, subtype: 'success', text: '', structured, usage: { ...emptyUsage(), costUsd: 0.05 }, sessionId: 's', numTurns: 1,
});
const good = {
  summary: 'Snake game',
  features: ['movement'],
  fileStructure: ['index.html'],
  steps: [
    { id: 'x', title: 'Scaffold', instructions: 'Create index.html', acceptance: ['opens'] },
    { id: 'x', title: 'Logic', instructions: 'Add game loop', files: ['index.html'], acceptance: ['snake moves'] },
  ],
};

describe('parsePlan', () => {
  it('normalises ids to unique s1..sn and fills defaults', () => {
    const p = parsePlan(good, 8)!.plan;
    expect(p.steps.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(p.steps[0]?.files).toEqual([]);
  });
  it('truncates to maxPlanSteps and reports it', () => {
    const r = parsePlan(good, 1)!;
    expect(r.plan.steps).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });
  it.each([[undefined], [{}], [{ steps: [] }], [{ steps: [{ title: '' , instructions: 'x' }] }], ['text']])('rejects %j', (bad) => {
    expect(parsePlan(bad, 8)).toBeNull();
  });
});

describe('makePlan', () => {
  const ctx = (run: RunClaudeFn) => ({ config: defaultConfig(), cwd: '.', run });

  it('uses the planner model with no tools and includes project files', async () => {
    let seen: Parameters<RunClaudeFn>[0] | undefined;
    const out = await makePlan('make a snake game', cls, {
      ...ctx(async (o) => { seen = o; return result(good); }),
      projectFiles: ['package.json'],
    });
    expect(out.plan.steps).toHaveLength(2);
    expect(out.usage.costUsd).toBe(0.05);
    expect(seen?.model).toBe('opus');
    expect(seen?.tools).toEqual([]);
    expect(seen?.prompt).toContain('package.json');
    expect(seen?.prompt).toContain('make a snake game');
  });

  it('honours a model override for the planner', async () => {
    let model = '';
    await makePlan('x', cls, { ...ctx(async (o) => { model = o.model; return result(good); }), override: 'sonnet' });
    expect(model).toBe('sonnet');
  });

  it('degrades to a single step on malformed output', async () => {
    const out = await makePlan('do it', cls, ctx(async () => result({ nope: true })));
    expect(out.plan.steps).toHaveLength(1);
    expect(out.plan.steps[0]?.instructions).toBe('do it');
    expect(out.warning).toMatch(/malformed/);
  });

  it('degrades on a generic failure and propagates fatal ones', async () => {
    const out = await makePlan('do it', cls, ctx(async () => { throw new SmartError('claude', 'boom'); }));
    expect(out.warning).toMatch(/boom/);
    await expect(makePlan('x', cls, ctx(async () => { throw new SmartError('auth', 'no'); }))).rejects.toMatchObject({ kind: 'auth' });
    await expect(makePlan('x', cls, ctx(async () => { throw new SmartError('cancelled', 'no'); }))).rejects.toMatchObject({ kind: 'cancelled' });
  });
});

describe('singleStepPlan', () => {
  it('wraps the prompt as one step', () => {
    expect(singleStepPlan('fix bug').steps[0]?.instructions).toBe('fix bug');
  });
});

describe('parsePlan: planner output is untrusted', () => {
  const step = (over: object = {}) => ({ title: 'Add parser', instructions: 'Parse the input in src/parse.ts', acceptance: ['parses'], ...over });

  it('drops file references that are not plain project paths and says which', () => {
    const r = parsePlan({ summary: 's', steps: [step({ files: ['src/a.ts', '../../etc/passwd', '/etc/shadow', '\\\\evil\\share\\x', 'src/a.ts', ''] })] }, 6)!;
    expect(r.plan.steps[0]!.files).toEqual(['src/a.ts']);
    expect(r.droppedFiles).toEqual(['../../etc/passwd', '/etc/shadow', '\\\\evil\\share\\x']);
  });

  it('drops empty and repeated steps, renumbers the rest, and is null when nothing is left', () => {
    const r = parsePlan({ summary: 's', steps: [step(), step(), step({ title: '   ' }), step({ title: 'Second', instructions: 'Other' })] }, 6)!;
    expect(r.plan.steps.map((s) => [s.id, s.title])).toEqual([['s1', 'Add parser'], ['s2', 'Second']]);
    expect(r.droppedSteps).toBe(2);
    expect(parsePlan({ summary: 's', steps: [step({ title: ' ', instructions: ' ' })] }, 6)).toBeNull();
  });

  it('caps lengths and counts, and strips terminal escape sequences from what is shown', () => {
    const r = parsePlan({
      summary: `Plan \u001b]0;pwned\u0007 ${'x'.repeat(1000)}`,
      features: Array.from({ length: 50 }, (_, i) => `f${i}`),
      steps: [step({ title: `\u001b[2J\u001b[HTitle ${'y'.repeat(500)}`, instructions: 'z'.repeat(10_000), acceptance: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], files: Array.from({ length: 40 }, (_, i) => `f${i}.ts`) })],
    }, 6)!;
    const s = r.plan.steps[0]!;
    expect(s.title.startsWith('Title ')).toBe(true);
    expect(s.title.length).toBeLessThanOrEqual(120);
    expect(s.instructions.length).toBeLessThanOrEqual(2000);
    expect(s.acceptance).toHaveLength(5);
    expect(s.files).toHaveLength(20);
    expect(r.plan.summary.includes('\u001b') || r.plan.summary.includes('\u0007')).toBe(false);
    expect(r.plan.summary.length).toBeLessThanOrEqual(300);
    expect(r.plan.features).toHaveLength(20);
  });

  it('ignores fields the planner has no say over (a model tier) and keeps its difficulty rating', () => {
    const p = parsePlan({ summary: 's', steps: [step({ tier: 'opus', model: 'claude-opus', difficulty: 'hard' })] }, 6)!.plan;
    expect(p.steps[0]).not.toHaveProperty('tier');
    expect(p.steps[0]).not.toHaveProperty('model');
    expect(p.steps[0]!.difficulty).toBe('hard');
  });

  it('rejects partial or wrongly shaped output, so the task runs as one step', () => {
    for (const bad of [undefined, '', {}, { steps: [] }, { steps: 'all of them' }, { steps: [{ title: 'x' }] }, [step()]]) expect(parsePlan(bad, 6)).toBeNull();
  });

  it('makePlan tells you what it dropped', async () => {
    const run = async () => ({ isError: false, subtype: 'success', text: '', structured: { summary: 's', steps: [step({ files: ['C:\\Windows\\win.ini'] }), step()] }, usage: emptyUsage(), sessionId: 's', numTurns: 1 });
    const out = await makePlan('build', cls, { config: defaultConfig(), cwd: '.', run });
    expect(out.warning).toMatch(/Dropped 1 empty or repeated step/);
    if (process.platform === 'win32') expect(out.warning).toMatch(/not plain project paths/);
  });
});
