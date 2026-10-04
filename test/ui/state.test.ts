import { describe, expect, it } from 'vitest';
import type { SmartEvent } from '../../src/core/events.js';
import { emptyUsage, type Plan } from '../../src/core/types.js';
import { parseInput } from '../../src/ui/commands.js';
import { initialState, MAX_OUTPUT, reduce, taskUsage } from '../../src/ui/state.js';

const plan: Plan = {
  summary: 's', features: [], fileStructure: [],
  steps: [
    { id: 's1', title: 'One', instructions: 'i', files: [], acceptance: [] },
    { id: 's2', title: 'Two', instructions: 'i', files: [], acceptance: [] },
  ],
};
const route = { tier: 'sonnet' as const, model: 'sonnet', reason: 'multi_file → sonnet' };
const apply = (events: SmartEvent[]) => events.reduce(reduce, initialState());

describe('reduce', () => {
  it('tracks the happy path from start to done', () => {
    const s = apply([
      { type: 'task:start', taskId: 't', prompt: 'p', dryRun: false },
      { type: 'stage', stage: 'classify', status: 'active' },
      { type: 'classified', classification: { complexity: 'multi_file', needsPlan: true, reason: 'r' }, route },
      { type: 'plan:ready', plan, routes: { s1: route, s2: route } },
      { type: 'step:start', stepId: 's1', title: 'One', route, attempt: 1 },
      { type: 'step:output', stepId: 's1', kind: 'tool', text: 'Edit a.ts' },
      { type: 'step:verify', stepId: 's1', command: 'npm test', ok: true, output: '' },
      { type: 'step:done', stepId: 's1' },
      { type: 'task:done', taskId: 't', totals: emptyUsage(), ok: true },
    ]);
    expect(s.phase).toBe('finished');
    expect(s.ok).toBe(true);
    expect(s.stepStatus).toEqual({ s1: 'done', s2: 'pending' });
    expect(s.stages.classify).toBe('active');
    expect(s.output.map((o) => o.kind)).toContain('tool');
    expect(s.classification?.complexity).toBe('multi_file');
  });

  it('enters and leaves the approval phase and marks skipped steps', () => {
    let s = apply([
      { type: 'task:start', taskId: 't', prompt: 'p', dryRun: false },
      { type: 'plan:ready', plan, routes: {} },
      { type: 'stage', stage: 'approve', status: 'active' },
    ]);
    expect(s.phase).toBe('approval');
    s = reduce(s, { type: 'plan:approved', plan: { ...plan, steps: [plan.steps[0]!, { ...plan.steps[1]!, skipped: true }] } });
    s = reduce(s, { type: 'stage', stage: 'approve', status: 'done' });
    expect(s.phase).toBe('running');
    expect(s.stepStatus['s2']).toBe('skipped');
  });

  it('records escalation, attempts and failures', () => {
    const s = apply([
      { type: 'plan:ready', plan, routes: {} },
      { type: 'step:start', stepId: 's1', title: 'One', route, attempt: 1 },
      { type: 'step:escalate', stepId: 's1', from: 'sonnet', to: 'opus', reason: 'failed 2x' },
      { type: 'step:start', stepId: 's1', title: 'One', route: { ...route, tier: 'opus', model: 'opus' }, attempt: 3 },
      { type: 'step:failed', stepId: 's1', error: 'tests failed' },
    ]);
    expect(s.escalatedTo['s1']).toBe('opus');
    expect(s.stepAttempt['s1']).toBe(3);
    expect(s.stepStatus['s1']).toBe('failed');
    expect(s.routes['s1']?.tier).toBe('opus');
  });

  it('distinguishes cancelled from failed steps', () => {
    const s = apply([{ type: 'plan:ready', plan, routes: {} }, { type: 'step:failed', stepId: 's1', error: 'Cancelled' }, { type: 'task:cancelled', taskId: 't' }]);
    expect(s.stepStatus['s1']).toBe('cancelled');
    expect(s.phase).toBe('finished');
    expect(s.ok).toBe(false);
  });

  it('shows errors with their hint and finishes', () => {
    const s = apply([{ type: 'error', kind: 'auth', message: 'not logged in', hint: 'Run claude' }]);
    expect(s.output.at(-1)?.text).toBe('not logged in\nRun claude');
    expect(s.phase).toBe('finished');
  });

  it('derives per-task usage from the session total', () => {
    const at = (cost: number) => ({ ...emptyUsage(), costUsd: cost, outputTokens: cost * 1000 });
    let s = apply([{ type: 'tokens', usage: at(1), sessionTotal: at(1) }]);
    s = reduce(s, { type: 'task:start', taskId: 't', prompt: 'p', dryRun: false });
    s = reduce(s, { type: 'tokens', usage: at(0.5), sessionTotal: at(1.5) });
    expect(taskUsage(s).costUsd).toBeCloseTo(0.5);
    expect(s.session.costUsd).toBeCloseTo(1.5);
  });

  it('resets per-task state on a new task but keeps the session and log', () => {
    let s = apply([{ type: 'plan:ready', plan, routes: {} }, { type: 'tokens', usage: emptyUsage(), sessionTotal: { ...emptyUsage(), costUsd: 2 } }]);
    s = reduce(s, { type: 'task:start', taskId: 't2', prompt: 'again', dryRun: true });
    expect(s.plan).toBeUndefined();
    expect(s.session.costUsd).toBe(2);
    expect(s.dryRun).toBe(true);
    expect(s.output.length).toBeGreaterThan(0);
  });

  it('tracks how many tasks the conversation remembers', () => {
    expect(initialState().chatTasks).toBe(0);
    expect(reduce(initialState(), { type: 'conversation', tasks: 3, resumed: true }).chatTasks).toBe(3);
  });

  it('records step durations and ends the task with a summary line', () => {
    const s = apply([
      { type: 'task:start', taskId: 't', prompt: 'p', dryRun: false, at: 1000 },
      { type: 'plan:ready', plan, routes: {} },
      { type: 'step:start', stepId: 's1', title: 'One', route, attempt: 1, at: 2000 },
      { type: 'step:done', stepId: 's1', at: 14_000 },
      { type: 'step:start', stepId: 's2', title: 'Two', route, attempt: 1, at: 14_000 },
      { type: 'step:done', stepId: 's2', at: 20_000 },
      { type: 'task:done', taskId: 't', totals: { ...emptyUsage(), costUsd: 0.153 }, ok: true, at: 65_000 },
    ]);
    expect(s.stepDuration).toEqual({ s1: 12_000, s2: 6000 });
    expect(s.output.at(-1)?.text).toBe('✓ Done in 1m 04s · $0.15 · 2/2 steps');
  });

  it('keeps the first start time of a step across retries', () => {
    const s = apply([
      { type: 'plan:ready', plan, routes: {} },
      { type: 'step:start', stepId: 's1', title: 'One', route, attempt: 1, at: 1000 },
      { type: 'step:start', stepId: 's1', title: 'One', route, attempt: 2, at: 9000 },
      { type: 'step:done', stepId: 's1', at: 11_000 },
    ]);
    expect(s.stepDuration['s1']).toBe(10_000);
  });

  it('shows review verdicts, the change summary and a coloured diff', () => {
    const s = apply([
      { type: 'step:review', stepId: 's1', pass: false, issues: ['game.js: tick() never moves the snake'] },
      { type: 'step:review', stepId: 's2', pass: true, issues: [] },
      { type: 'step:review', stepId: 's3', pass: true, issues: [], skipped: 'reviewer down' },
      { type: 'changes', files: [{ path: 'a.js', status: 'A' }, { path: 'b.js', status: 'M' }, { path: 'c.js', status: 'M' }, { path: 'd.js', status: 'M' }, { path: 'e.js', status: 'D' }], insertions: 12, deletions: 3 },
      { type: 'diff', text: 'diff --git a/a.js b/a.js\n@@ -1 +1 @@\n-old\n+new\n context\n' },
    ]);
    const text = s.output.map((o) => `${o.kind}|${o.text}`);
    expect(text[0]).toContain('verify-fail|✗ review found problems:');
    expect(text[0]).toContain('- game.js: tick() never moves the snake');
    expect(text[1]).toBe('verify-ok|✓ review: acceptance criteria met');
    expect(text[2]).toBe('info|review skipped (reviewer down)');
    expect(text[3]).toContain('Changed 5 files (+12 −3): a.js, b.js, c.js, d.js, +1 more. /diff to review, /undo to revert.');
    expect(text.slice(4)).toEqual(['diff-meta|diff --git a/a.js b/a.js', 'diff-meta|@@ -1 +1 @@', 'diff-del|-old', 'diff-add|+new', 'diff-ctx| context']);
  });

  it('keeps the latest account limits', () => {
    const limits = { at: 5, windows: { five_hour: { utilization: 0.5 } } };
    expect(reduce(initialState(), { type: 'limits', limits }).limits).toEqual(limits);
    expect(initialState().limits).toBeNull();
  });

  it('caps a huge diff', () => {
    const big = Array.from({ length: 400 }, (_, i) => `+line ${i}`).join('\n');
    const s = reduce(initialState(), { type: 'diff', text: big });
    expect(s.output.at(-1)?.text).toBe('… 150 more diff lines');
  });

  it('caps the output log', () => {
    let s = initialState();
    for (let i = 0; i < MAX_OUTPUT + 200; i++) s = reduce(s, { type: 'step:output', stepId: 's1', kind: 'text', text: String(i) });
    expect(s.output).toHaveLength(MAX_OUTPUT);
    expect(s.output.at(-1)?.text).toBe(String(MAX_OUTPUT + 199));
  });
});

describe('parseInput', () => {
  it('parses tasks and commands', () => {
    expect(parseInput('  make a game ')).toEqual({ kind: 'task', prompt: 'make a game' });
    expect(parseInput('/stats')).toEqual({ kind: 'stats' });
    expect(parseInput('/dry')).toEqual({ kind: 'dry' });
    expect(parseInput('/model Opus')).toEqual({ kind: 'model', tier: 'opus' });
    expect(parseInput('/model auto')).toEqual({ kind: 'model', tier: null });
    expect(parseInput('/quit')).toEqual({ kind: 'quit' });
    expect(parseInput('/new')).toEqual({ kind: 'new' });
    expect(parseInput('/undo')).toEqual({ kind: 'undo', force: false });
    expect(parseInput('/undo force')).toEqual({ kind: 'undo', force: true });
    expect(parseInput('/undo everything')).toMatchObject({ kind: 'error' });
    expect(parseInput('/usage')).toEqual({ kind: 'usage' });
    expect(parseInput('/limits')).toEqual({ kind: 'usage' });
    expect(parseInput('/cost')).toEqual({ kind: 'cost' });
    expect(parseInput('/config')).toEqual({ kind: 'config' });
    expect(parseInput('/diff')).toEqual({ kind: 'diff' });
    expect(parseInput('/resume')).toEqual({ kind: 'resume' });
    expect(parseInput('/mode')).toEqual({ kind: 'mode', mode: 'show' });
    expect(parseInput('/mode plan')).toEqual({ kind: 'mode', mode: 'plan' });
    expect(parseInput('/mode edits')).toEqual({ kind: 'mode', mode: 'acceptEdits' });
    expect(parseInput('/mode bypass')).toEqual({ kind: 'mode', mode: 'bypassPermissions' });
    expect(parseInput('/mode auto')).toEqual({ kind: 'mode', mode: null });
    expect(parseInput('/mode nope')).toMatchObject({ kind: 'error' });
    expect(parseInput('/clear')).toEqual({ kind: 'new' });
  });
  it('rejects unknown input clearly and ignores blanks', () => {
    expect(parseInput('   ')).toBeNull();
    expect(parseInput('/model gpt')).toMatchObject({ kind: 'error' });
    expect(parseInput('/nope')).toMatchObject({ kind: 'error', message: expect.stringContaining('/nope') });
  });
});

describe('shortPath', () => {
  it('keeps short paths, uses ~ for home, and otherwise the last components', async () => {
    const { shortPath } = await import('../../src/ui/App.js');
    expect(shortPath('/a/b', 28)).toBe('/a/b');
    expect(shortPath('/very/long/path/to/some/project-name', 28)).toBe('…/path/to/some/project-name');
    expect(shortPath('/very/long/path/to/some/project-name', 20)).toBe('…/some/project-name');
    expect(shortPath('C:\\Users\\Anton\\Documents\\Projects\\my-app', 28)).toBe('…/Documents/Projects/my-app');
    expect(shortPath('C:\\Users\\Anton\\Documents\\Projects\\my-app', 20)).toBe('…/Projects/my-app');
    expect(shortPath('/x/' + 'y'.repeat(60), 20).length).toBeLessThanOrEqual(20);
  });

  it('only shortens the home directory at a path boundary', async () => {
    const { shortPath } = await import('../../src/ui/App.js');
    const os = await import('node:os');
    const home = os.homedir();
    expect(shortPath(`${home}/proj`, 40)).toBe('~/proj');
    expect(shortPath(home, 40)).toBe('~');
    expect(shortPath(`${home}x/proj`, 40)).toBe(`${home}x/proj`); // /home/al vs /home/alice
  });
});
