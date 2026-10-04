import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readVersioned } from '../../src/core/store/schema.js';
import { ConversationStore, newConversation, validPending } from '../../src/core/store/conversation.js';
import { LimitsStore } from '../../src/core/store/limits.js';
import { Tracker, validTask } from '../../src/core/store/tracker.js';
import { TrustStore } from '../../src/core/store/trust.js';
import { emptyUsage } from '../../src/core/types.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'smart-schema-'));
const u = (costUsd = 0.01) => ({ ...emptyUsage(), costUsd, outputTokens: 10 });
const task = (id: string, extra: object = {}) => ({ id, startedAt: '2026-10-01T10:00:00.000Z', prompt: 'p', overhead: u(0), steps: [], totals: u(), ok: true, ...extra });

describe('readVersioned', () => {
  it('passes the current version through and treats a file without a version as version 1', () => {
    expect(readVersioned({ version: 1, a: 1 }, 1)).toEqual({ status: 'current', data: { version: 1, a: 1 } });
    expect(readVersioned({ a: 1 }, 1)).toEqual({ status: 'current', data: { version: 1, a: 1 }, migratedFrom: 1 });
  });

  it('migrates one version at a time, and reports a missing or failing step as unusable', () => {
    const migrations = { 1: (d: Record<string, unknown>) => ({ ...d, version: 2, b: 'added' }), 2: (d: Record<string, unknown>) => ({ ...d, version: 3, c: true }) };
    expect(readVersioned({ version: 1, a: 1 }, 3, migrations)).toEqual({ status: 'current', data: { version: 3, a: 1, b: 'added', c: true }, migratedFrom: 1 });
    expect(readVersioned({ version: 1 }, 3, { 1: migrations[1] })).toMatchObject({ status: 'invalid', reason: /no migration from version 2/ });
    expect(readVersioned({ version: 1 }, 2, { 1: () => { throw new Error('bad'); } })).toMatchObject({ status: 'invalid', reason: /failed: bad/ });
  });

  it('marks a newer file as such (read, never written) and rejects nonsense', () => {
    expect(readVersioned({ version: 7, x: 1 }, 1)).toEqual({ status: 'newer', data: { version: 7, x: 1 }, version: 7 });
    for (const bad of [null, [], 'x', { version: '1' }, { version: -1 }, { version: 1.5 }]) expect(readVersioned(bad, 1).status).toBe('invalid');
  });
});

describe('history.json across versions', () => {
  it('reads a file written by smart 0.3 (version 1, records without the newer optional fields)', () => {
    const f = join(tmp(), 'history.json');
    const old = { version: 1, tasks: [{ ...task('t_old'), steps: [{ stepId: 's1', title: 'x', model: 'sonnet', tier: 'sonnet', attempts: 1, escalated: false, usage: u(), outcome: 'done' }] }] };
    writeFileSync(f, JSON.stringify(old));
    const t = new Tracker(f);
    expect(t.load().map((x) => x.id)).toEqual(['t_old']);
    expect(t.append(task('t_new', { project: 'abc' }) as never)).toBeNull();
    const saved = JSON.parse(readFileSync(f, 'utf8')) as { version: number; tasks: { id: string }[] };
    expect(saved.version).toBe(1);
    expect(saved.tasks.map((x) => x.id)).toEqual(['t_old', 't_new']);
  });

  it('skips damaged records when reading but keeps them in the file', () => {
    const f = join(tmp(), 'history.json');
    writeFileSync(f, JSON.stringify({ version: 1, tasks: [task('good'), { id: 'half', steps: 'nope' }, null, task('bad-usage', { totals: { costUsd: 'x' } })] }));
    const t = new Tracker(f);
    expect(t.load().map((x) => x.id)).toEqual(['good']);
    t.append(task('next') as never);
    const saved = JSON.parse(readFileSync(f, 'utf8')) as { tasks: unknown[] };
    expect(saved.tasks).toHaveLength(5);
  });

  it('never writes a history file from a newer smart, and says why', () => {
    const f = join(tmp(), 'history.json');
    const newer = JSON.stringify({ version: 2, tasks: [task('future')], somethingNew: true });
    writeFileSync(f, newer);
    const t = new Tracker(f);
    expect(t.load().map((x) => x.id)).toEqual(['future']); // still readable as far as it is understood
    expect(t.append(task('mine') as never)).toMatch(/newer version of smart \(format 2\).*left unchanged/);
    expect(t.setFeedback('future', 'bad')).toMatch(/newer version/);
    expect(readFileSync(f, 'utf8')).toBe(newer);
  });

  it('moves an unusable file aside instead of overwriting it', () => {
    const d = tmp();
    const f = join(d, 'history.json');
    writeFileSync(f, JSON.stringify({ version: 1, tasks: 'not a list' }));
    expect(new Tracker(f).load()).toEqual([]);
    expect(readdirSync(d).some((n) => n.startsWith('history.json.corrupt-'))).toBe(true);
  });

  it('validTask fills the parts stats rely on and drops broken steps', () => {
    const v = validTask({ ...task('x'), overhead: undefined, steps: [{ stepId: 's', model: 'm', tier: 't', attempts: 1, outcome: 'done', usage: u() }, { stepId: 2 }] })!;
    expect(v.overhead).toEqual(emptyUsage());
    expect(v.steps).toHaveLength(1);
    expect(v.steps[0]!.escalated).toBe(false);
    expect(validTask({ id: 'x' })).toBeNull();
  });
});

describe('conversations.json across versions', () => {
  const step = { id: 's1', title: 'A', instructions: 'do a', files: [], acceptance: [] };
  const pending = { prompt: 'p', classification: { complexity: 'multi_file', needsPlan: true, reason: 'r' }, plan: { summary: 's', features: [], fileStructure: [], steps: [step] }, doneStepIds: [], at: 'now' };

  it('reads a 0.3 file and drops only the damaged parts of an entry', () => {
    const d = tmp();
    const f = join(d, 'conversations.json');
    const goodTask = { prompt: 'a', outcome: 'done', files: [], reply: 'r', at: 'now' };
    writeFileSync(f, JSON.stringify({ version: 1, byDir: { [d]: { id: 'c1', sessionId: 'sess', tasks: [goodTask, { prompt: 1 }], pending, undo: [{ prompt: 'p', start: 'nothex', end: 'x' }], updatedAt: 'now' } } }));
    const c = new ConversationStore(f).load(d)!;
    expect(c.id).toBe('c1');
    expect(c.tasks).toEqual([goodTask]);
    expect(c.pending?.plan.steps).toHaveLength(1);
    expect(c.undo).toBeUndefined();
  });

  it('a /resume plan must be well formed to be offered: model-written steps are checked again when read back', () => {
    expect(validPending(pending)).toBeDefined();
    expect(validPending({ ...pending, plan: { ...pending.plan, steps: [] } })).toBeUndefined(); // would "finish" with nothing run
    expect(validPending({ ...pending, plan: { ...pending.plan, steps: [{ ...step, files: 'src' }] } })).toBeUndefined();
    expect(validPending({ ...pending, classification: { complexity: 'galaxy_brain' } })).toBeUndefined();
    expect(validPending({ ...pending, doneStepIds: [1] })).toBeUndefined();
  });

  it('never writes a conversations file from a newer smart', () => {
    const d = tmp();
    const f = join(d, 'conversations.json');
    const newer = JSON.stringify({ version: 3, byDir: {} });
    writeFileSync(f, newer);
    expect(new ConversationStore(f).save(d, newConversation())).toMatch(/newer version of smart \(format 3\)/);
    expect(readFileSync(f, 'utf8')).toBe(newer);
  });

  it('tolerates entries without updatedAt instead of crashing on save', () => {
    const d = tmp();
    const f = join(d, 'conversations.json');
    writeFileSync(f, JSON.stringify({ version: 1, byDir: { '/x': { id: 'a', tasks: [] }, '/y': { id: 'b', tasks: [], updatedAt: 'z' } } }));
    expect(new ConversationStore(f).save(d, newConversation())).toBeNull();
  });
});

describe('caches and the trust file', () => {
  it('limits.json keeps only windows it understands', () => {
    const f = join(tmp(), 'limits.json');
    writeFileSync(f, JSON.stringify({ at: 1, windows: { five_hour: { utilization: 0.5 }, weird: { utilization: 'high' }, bad: null } }));
    expect(new LimitsStore(f).load()).toEqual({ at: 1, windows: { five_hour: { utilization: 0.5 } }, status: undefined });
  });

  it('a trust file in an unknown format is neither trusted nor overwritten', () => {
    const d = tmp();
    const f = join(d, 'trusted-projects.json');
    const foreign = JSON.stringify({ version: 2, projects: { x: { sha256: 'y' } } });
    writeFileSync(f, foreign);
    const store = new TrustStore(f);
    expect(store.trust(d, '{}')).toMatch(/not a trust file this version of smart understands/);
    expect(readFileSync(f, 'utf8')).toBe(foreign);
    expect(existsSync(`${f}.lock`)).toBe(false);
  });
});
