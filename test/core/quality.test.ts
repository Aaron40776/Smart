import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { createCheckpoints, type Checkpointer } from '../../src/core/checkpoint.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { SmartError } from '../../src/core/errors.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { emptyUsage, type Complexity } from '../../src/core/types.js';
import type { ExecFn } from '../../src/core/verifier.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const res = (over: Partial<ClaudeResult> = {}, cost = 0.01): ClaudeResult => ({
  isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: { ...emptyUsage(), costUsd: cost, outputTokens: 20 }, sessionId: 's', numTurns: 1, ...over,
});

interface Call { role: 'classifier' | 'planner' | 'reviewer' | 'executor'; model: string; prompt: string; permissionMode?: string }
const made: Checkpointer[] = [];
afterEach(() => made.splice(0).forEach((c) => c.dispose()));

async function setup(opts: {
  git?: boolean;
  complexity?: Complexity;
  /** What the executor does on its nth call (write files into the project, etc.). */
  executor?: (n: number, cwd: string, call: Call) => ClaudeResult | void | Promise<ClaudeResult | void>;
  /** Reviewer verdicts in order; the last repeats. */
  reviews?: ({ pass: boolean; issues: string[] } | 'error')[];
  checks?: (n: number) => boolean;
  config?: (c: SmartConfig) => void;
  context?: string;
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'smart-qual-'));
  if (opts.git !== false) {
    sh(cwd, 'init', '-q');
    sh(cwd, 'config', 'user.email', 't@t.t');
    sh(cwd, 'config', 'user.name', 't');
    sh(cwd, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(cwd, 'base.txt'), 'base\n');
    sh(cwd, 'add', '-A');
    sh(cwd, 'commit', '-q', '-m', 'init');
  }
  const checkpoints = await createCheckpoints(cwd);
  made.push(checkpoints);
  const calls: Call[] = [];
  let execN = 0;
  let reviewN = 0;
  const run: RunClaudeFn = async (o) => {
    const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    const role = props && 'complexity' in props ? 'classifier' : props && 'steps' in props ? 'planner' : props && 'pass' in props ? 'reviewer' : 'executor';
    const call: Call = { role, model: o.model, prompt: o.prompt, permissionMode: o.permissionMode };
    calls.push(call);
    if (role === 'classifier') return res({ structured: { complexity: opts.complexity ?? 'multi_file', needsPlan: false, reason: 'r' } });
    if (role === 'planner') return res({ structured: { summary: 'Plan', steps: [{ title: 'A', instructions: 'do a', acceptance: ['a works'] }, { title: 'B', instructions: 'do b', acceptance: ['b works'] }] } });
    if (role === 'reviewer') {
      const v = (opts.reviews ?? [{ pass: true, issues: [] }])[Math.min(reviewN++, (opts.reviews ?? [1]).length - 1)]!;
      if (v === 'error') throw new SmartError('claude', 'reviewer down');
      return res({ structured: v }, 0.005);
    }
    execN += 1;
    const out = await opts.executor?.(execN, cwd, call);
    return out ?? res();
  };
  const config = defaultConfig();
  config.verify.auto = false;
  if (opts.checks) config.verify.commands = ['check'];
  opts.config?.(config);
  const execCalls: string[] = [];
  const exec: ExecFn = async (cmd) => {
    execCalls.push(cmd);
    return opts.checks?.(execCalls.length) === false ? { code: 1, output: 'CHECK FAILED' } : { code: 0, output: '' };
  };
  const bus = new EventBus();
  const events: SmartEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const pipeline = new Pipeline(config, bus, cwd, { run, exec, uid: 1000, listFiles: () => [], checkpoints, projectContext: () => opts.context ?? '' });
  return {
    pipeline, calls, cwd, events, execCalls,
    role: (r: Call['role']) => calls.filter((c) => c.role === r),
    of: <T extends SmartEvent['type']>(t: T) => events.filter((e): e is Extract<SmartEvent, { type: T }> => e.type === t),
  };
}
const write = (cwd: string, name: string, text: string) => writeFileSync(join(cwd, name), text);

describe('change tracking, /diff and /undo', () => {
  it('reports changed files after a task, including files made by a shell command (no tool event)', async () => {
    const t = await setup({ executor: (_n, cwd) => { write(cwd, 'made.txt', 'hello\nworld\n'); } });
    await t.pipeline.runTask('create a file');
    const ch = t.of('changes')[0]!;
    expect(ch.files).toEqual([{ path: 'made.txt', status: 'A' }]);
    expect(ch.insertions).toBe(2);
  });

  it('emits nothing when a task changes no files', async () => {
    const t = await setup();
    await t.pipeline.runTask('just look around');
    expect(t.of('changes')).toHaveLength(0);
  });

  it('/undo restores the files, tells the next prompt, and marks the task reverted in memory', async () => {
    const t = await setup({ complexity: 'trivial', executor: (n, cwd) => { if (n === 1) { write(cwd, 'base.txt', 'CHANGED\n'); write(cwd, 'new.txt', 'x'); } } });
    await t.pipeline.runTask('edit things');
    expect(readFileSync(join(t.cwd, 'base.txt'), 'utf8')).toBe('CHANGED\n');
    await t.pipeline.undo();
    expect(readFileSync(join(t.cwd, 'base.txt'), 'utf8')).toBe('base\n');
    expect(existsSync(join(t.cwd, 'new.txt'))).toBe(false);
    expect(t.of('notice').some((n) => /Undid "edit things"/.test(n.message))).toBe(true);
    await t.pipeline.runTask('try something else');
    const second = t.role('executor')[1]!;
    expect(second.prompt).toContain('The user undid your file changes from the task "edit things"');
    expect(t.role('classifier')[1]?.prompt).toContain('→ reverted');
    await t.pipeline.undo();
    expect(t.of('notice').at(-1)?.message).toBe('Nothing to undo.');
  });

  it('/undo steps back one task at a time', async () => {
    const t = await setup({ complexity: 'trivial', executor: (n, cwd) => { write(cwd, 'f.txt', `v${n}`); } });
    await t.pipeline.runTask('one');
    await t.pipeline.runTask('two');
    expect(readFileSync(join(t.cwd, 'f.txt'), 'utf8')).toBe('v2');
    await t.pipeline.undo();
    expect(readFileSync(join(t.cwd, 'f.txt'), 'utf8')).toBe('v1');
    await t.pipeline.undo();
    expect(existsSync(join(t.cwd, 'f.txt'))).toBe(false);
  });

  it('/undo refuses to discard your own later edits to the task\'s files, and /undo force does it on purpose', async () => {
    const t = await setup({ complexity: 'trivial', executor: (_n, cwd) => { write(cwd, 'base.txt', 'by the task\n'); write(cwd, 'other.txt', 'task file\n'); } });
    await t.pipeline.runTask('edit things');
    write(t.cwd, 'base.txt', 'by the task\nand then my own edit\n');
    await t.pipeline.undo();
    const refusal = t.of('notice').at(-1)!;
    expect(refusal.level).toBe('warn');
    expect(refusal.message).toMatch(/Not undone: a file that task changed was edited after it \(base\.txt\).*\/undo force/);
    expect(readFileSync(join(t.cwd, 'base.txt'), 'utf8')).toBe('by the task\nand then my own edit\n');
    expect(existsSync(join(t.cwd, 'other.txt'))).toBe(true); // nothing at all was touched
    await t.pipeline.undo(true);
    expect(readFileSync(join(t.cwd, 'base.txt'), 'utf8')).toBe('base\n');
    expect(existsSync(join(t.cwd, 'other.txt'))).toBe(false);
  });

  it('/undo never applies an entry recorded for another repository location', async () => {
    const t = await setup({ complexity: 'trivial', executor: (_n, cwd) => { write(cwd, 'base.txt', 'CHANGED\n'); } });
    await t.pipeline.runTask('edit things');
    const conv = (t.pipeline as unknown as { conv: { undo: { repo?: string }[] } }).conv;
    expect(conv.undo[0]!.repo).toBeTruthy(); // recorded with the entry
    conv.undo[0]!.repo = join(tmpdir(), 'some-other-clone');
    await t.pipeline.undo();
    expect(t.of('notice').at(-1)?.message).toMatch(/another repository location/);
    expect(readFileSync(join(t.cwd, 'base.txt'), 'utf8')).toBe('CHANGED\n');
  });

  it('/diff emits the unified diff of the last task', async () => {
    const t = await setup({ executor: (_n, cwd) => { write(cwd, 'base.txt', 'base\nadded line\n'); } });
    await t.pipeline.runTask('add a line');
    await t.pipeline.diff();
    expect(t.of('diff')[0]?.text).toContain('+added line');
  });

  it('keeps changes made before a cancel so they can still be undone', async () => {
    let gate!: () => void;
    const block = new Promise<void>((r) => (gate = r));
    const t = await setup({
      executor: async (_n, cwd) => { write(cwd, 'partial.txt', 'half'); await block; },
    });
    const p = t.pipeline.runTask('long job');
    await new Promise((r) => setTimeout(r, 50));
    t.pipeline.cancel();
    gate();
    await p;
    expect(t.of('changes')[0]?.files.map((f) => f.path)).toEqual(['partial.txt']);
    await t.pipeline.undo();
    expect(existsSync(join(t.cwd, 'partial.txt'))).toBe(false);
  });

  it('outside a git repository: says so once and disables /undo and /diff', async () => {
    const t = await setup({ git: false, executor: (_n, cwd) => { write(cwd, 'x.txt', 'x'); } });
    await t.pipeline.runTask('one');
    await t.pipeline.runTask('two');
    expect(t.of('notice').filter((n) => /Not a git repository/.test(n.message))).toHaveLength(1);
    expect(t.of('changes')).toHaveLength(0);
    await t.pipeline.undo();
    await t.pipeline.diff();
    expect(t.of('notice').filter((n) => /needs a git repository/.test(n.message))).toHaveLength(2);
  });

  it('remembers files changed by the task for follow-up context, and shows them to later steps', async () => {
    const t = await setup({ complexity: 'large_build', executor: (n, cwd) => { if (n === 1) write(cwd, 'one.txt', '1'); } });
    await t.pipeline.runTask('build', { autoApprove: true });
    expect(t.role('executor')[1]?.prompt).toContain('Files changed in earlier steps: one.txt');
    await t.pipeline.runTask('follow up', { autoApprove: true });
    expect(t.role('classifier')[1]?.prompt).toContain('files: one.txt');
  });
});

describe('project directory inside a repository, and paths that differ in spelling from git\'s', () => {
  it('reports changed paths relative to the project directory when it is a subdirectory of the repo', async () => {
    const t = await setup({ executor: (_n, cwd) => { write(cwd, 'sub.txt', 'x'); } });
    // The setup repo root is t.cwd; run a second pipeline rooted in a subdirectory of it.
    const sub = join(t.cwd, 'pkg');
    mkdirSync(sub);
    const checkpoints = await createCheckpoints(sub);
    made.push(checkpoints);
    const events: SmartEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const run: RunClaudeFn = async (o) => {
      const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      if (props && 'complexity' in props) return res({ structured: { complexity: 'trivial', needsPlan: false, reason: 'r' } });
      writeFileSync(join(sub, 'inside.txt'), 'x');
      writeFileSync(join(t.cwd, 'outside.txt'), 'y');
      return res();
    };
    const config = defaultConfig();
    config.verify.auto = false;
    await new Pipeline(config, bus, sub, { run, uid: 1000, listFiles: () => [], checkpoints, projectContext: () => '' }).runTask('go');
    const ch = events.find((e): e is Extract<SmartEvent, { type: 'changes' }> => e.type === 'changes')!;
    // Paths are relative to the project directory, and files changed outside it are not part of this task.
    expect(ch.files.map((f) => f.path)).toEqual(['inside.txt']);
  });

  it('still works when the project path is spelled differently from the repository root (symlink; on Windows, 8.3 short names)', async () => {
    const t = await setup({ executor: (_n, cwd) => { write(cwd, 'aliased.txt', 'hello\n'); } });
    const alias = join(mkdtempSync(join(tmpdir(), 'smart-alias-')), 'link');
    try {
      symlinkSync(t.cwd, alias, 'junction');
    } catch {
      return; // cannot create links here (Windows without privileges): nothing to test
    }
    const checkpoints = await createCheckpoints(alias);
    made.push(checkpoints);
    const events: SmartEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const run: RunClaudeFn = async (o) => {
      const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      if (props && 'complexity' in props) return res({ structured: { complexity: 'trivial', needsPlan: false, reason: 'r' } });
      writeFileSync(join(alias, 'aliased.txt'), 'hello\n');
      return res();
    };
    const config = defaultConfig();
    config.verify.auto = false;
    await new Pipeline(config, bus, alias, { run, uid: 1000, listFiles: () => [], checkpoints, projectContext: () => '' }).runTask('go');
    const ch = events.find((e): e is Extract<SmartEvent, { type: 'changes' }> => e.type === 'changes')!;
    expect(ch.files).toEqual([{ path: 'aliased.txt', status: 'A' }]); // not "../real/path/aliased.txt"
  });
});

describe('acceptance review', () => {
  // Different content each call, like real work: a step that changes nothing is (rightly) not reviewed.
  const writer = (n: number, cwd: string) => { write(cwd, 'game.js', `code v${n}`); };

  it('reviews every plan step with the reviewer model and counts its cost as overhead', async () => {
    const t = await setup({ complexity: 'large_build', executor: writer });
    const s = await t.pipeline.runTask('build', { autoApprove: true });
    expect(t.role('reviewer')).toHaveLength(2);
    expect(t.role('reviewer')[0]?.model).toBe('haiku');
    expect(t.role('reviewer')[0]?.prompt).toContain('a works');
    expect(t.role('reviewer')[0]?.prompt).toContain('<file path="game.js">');
    expect(t.of('step:review').every((e) => e.pass)).toBe(true);
    expect(s.totals.costUsd).toBeCloseTo(0.01 * 2 + 0.005 * 2 + 0.01 * 2); // classify+plan, reviews, executors
  });

  it('a failed review retries on the same model with the issues in the prompt, then passes', async () => {
    const t = await setup({ complexity: 'large_build', executor: writer, reviews: [{ pass: false, issues: ['game.js: tick() never moves the snake'] }, { pass: true, issues: [] }] });
    const s = await t.pipeline.runTask('build', { autoApprove: true });
    const ex = t.role('executor');
    expect(ex[1]?.prompt).toContain('tick() never moves the snake');
    expect(ex[1]?.model).toBe('sonnet');
    expect(s.ok).toBe(true);
    expect(s.steps[0]?.attempts).toBe(2);
    expect(t.of('step:review')[0]).toMatchObject({ pass: false });
  });

  it('keeps failing reviews escalate to the next model like failing tests do', async () => {
    const t = await setup({ complexity: 'large_build', executor: writer, reviews: [{ pass: false, issues: ['bad'] }, { pass: false, issues: ['bad'] }, { pass: true, issues: [] }] });
    const s = await t.pipeline.runTask('build', { autoApprove: true });
    expect(t.role('executor').slice(0, 3).map((c) => c.model)).toEqual(['sonnet', 'sonnet', 'opus']);
    expect(t.of('step:escalate')[0]).toMatchObject({ from: 'sonnet', to: 'opus' });
    expect(s.ok).toBe(true);
  });

  it('does not block when the reviewer is unavailable', async () => {
    const t = await setup({ complexity: 'large_build', executor: writer, reviews: ['error'] });
    const s = await t.pipeline.runTask('build', { autoApprove: true });
    expect(s.ok).toBe(true);
    expect(t.of('step:review')[0]?.skipped).toMatch(/reviewer down/);
  });

  it('skips review for trivial tasks, steps that changed nothing, and when disabled', async () => {
    const trivial = await setup({ complexity: 'trivial', executor: writer });
    await trivial.pipeline.runTask('what is this');
    expect(trivial.role('reviewer')).toHaveLength(0);

    const nothing = await setup({ complexity: 'large_build' });
    await nothing.pipeline.runTask('build', { autoApprove: true });
    expect(nothing.role('reviewer')).toHaveLength(0);

    const off = await setup({ complexity: 'large_build', executor: writer, config: (c) => { c.review.enabled = false; } });
    await off.pipeline.runTask('build', { autoApprove: true });
    expect(off.role('reviewer')).toHaveLength(0);
  });

  it('a single-step task is reviewed only when no automated check ran to gate it', async () => {
    const noChecks = await setup({ complexity: 'small_edit', executor: writer });
    await noChecks.pipeline.runTask('edit');
    expect(noChecks.role('reviewer')).toHaveLength(1);

    const withChecks = await setup({ complexity: 'small_edit', executor: writer, checks: () => true });
    await withChecks.pipeline.runTask('edit');
    expect(withChecks.role('reviewer')).toHaveLength(0);
  });

  it('reviews only after the automated checks pass', async () => {
    const t = await setup({ complexity: 'large_build', executor: writer, checks: (n) => n >= 2 });
    await t.pipeline.runTask('build', { autoApprove: true });
    // step 1: attempt 1 fails the check (no review), attempt 2 passes then is reviewed
    expect(t.of('step:review').length).toBeGreaterThanOrEqual(1);
    const firstReviewIdx = t.events.findIndex((e) => e.type === 'step:review');
    const firstFailIdx = t.events.findIndex((e) => e.type === 'step:verify' && !e.ok);
    expect(firstFailIdx).toBeGreaterThan(-1);
    expect(firstReviewIdx).toBeGreaterThan(firstFailIdx);
  });

  it('propagates a cancel raised while reviewing', async () => {
    const t = await setup({ complexity: 'large_build', executor: writer, reviews: [] });
    // reviews: [] -> falls back to pass; cancel path is covered in review.test, here just ensure no throw
    await expect(t.pipeline.runTask('build', { autoApprove: true })).resolves.toBeTruthy();
  });
});

describe('planner context and permission mode', () => {
  it('gives the planner the project context (CLAUDE.md and package info)', async () => {
    const t = await setup({ complexity: 'large_build', context: 'CLAUDE.md:\nAlways use pnpm.' });
    await t.pipeline.runTask('build', { autoApprove: true });
    expect(t.role('planner')[0]?.prompt).toContain('<project>');
    expect(t.role('planner')[0]?.prompt).toContain('Always use pnpm.');
  });

  it('omits the project block when there is nothing to say', async () => {
    const t = await setup({ complexity: 'large_build' });
    await t.pipeline.runTask('build', { autoApprove: true });
    expect(t.role('planner')[0]?.prompt).not.toContain('<project>');
  });

  it('a runtime permission mode overrides the configured one, and null restores it', async () => {
    const t = await setup({ complexity: 'trivial', config: (c) => { c.runner.permissionMode = 'acceptEdits'; } });
    t.pipeline.setPermissionMode('plan');
    expect(t.pipeline.permissionMode).toBe('plan');
    await t.pipeline.runTask('look');
    expect(t.role('executor')[0]?.permissionMode).toBe('plan');
    t.pipeline.setPermissionMode(null);
    await t.pipeline.runTask('look again');
    expect(t.role('executor')[1]?.permissionMode).toBe('acceptEdits');
  });
});
