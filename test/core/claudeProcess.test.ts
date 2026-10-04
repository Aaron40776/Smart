import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeResult, RunClaudeFn, RunClaudeOptions } from '../../src/core/claude.js';
import { createClaudeRunner, type ClaudeRunner } from '../../src/core/claudeProcess.js';
import { emptyUsage } from '../../src/core/types.js';

const fake = fileURLToPath(new URL('../fixtures/fake-claude-stream.mjs', import.meta.url));
const command = { cmd: process.execPath, prefix: [fake] };
const runners: ClaudeRunner[] = [];
afterEach(() => {
  runners.splice(0).forEach((r) => r.dispose());
  vi.unstubAllEnvs();
});

function setup(opts: { idleMs?: number; firstOutputMs?: number; controlMs?: number } = {}) {
  let spawns = 0;
  const oneShot = vi.fn<RunClaudeFn>(async (): Promise<ClaudeResult> => ({ isError: false, subtype: 'success', text: 'one-shot', structured: undefined, usage: { ...emptyUsage(), costUsd: 0.5 }, sessionId: 's', numTurns: 1 }));
  const spawnImpl = ((...a: Parameters<typeof spawn>) => {
    spawns += 1;
    return spawn(...a);
  }) as typeof spawn;
  const run = createClaudeRunner({ keepAlive: true, command, spawnImpl, oneShot, idleMs: opts.idleMs, firstOutputMs: opts.firstOutputMs, controlMs: opts.controlMs });
  runners.push(run);
  return { run, oneShot, spawns: () => spawns };
}
const step = (over: Partial<RunClaudeOptions> = {}): RunClaudeOptions => ({ prompt: 'do it', model: 'sonnet', cwd: process.cwd(), session: { id: 'sess-1', resume: false }, effort: 'medium', ...over });

describe('kept-alive claude process', () => {
  it('sends the next step to the running process, with each message\'s own usage and cost', async () => {
    const t = setup();
    const a = await t.run(step({ prompt: 'first' }));
    const b = await t.run(step({ prompt: 'second', session: { id: 'sess-1', resume: true } }));
    expect(t.spawns()).toBe(1);
    expect(a.text).toBe('reply 1 from sonnet');
    expect(b.text).toBe('reply 2 from sonnet');
    expect(b.usage.costUsd).toBeCloseTo(0.01); // not the process's running total of 0.02
    expect(b.usage.inputTokens).toBe(100);
    expect(t.oneShot).not.toHaveBeenCalled();
  });

  it('switches the model on the running process', async () => {
    const t = setup();
    await t.run(step());
    const b = await t.run(step({ model: 'opus' }));
    expect(t.spawns()).toBe(1);
    expect(b.text).toBe('reply 2 from opus');
  });

  it('starts a fresh process when the effort or permission mode changes', async () => {
    const t = setup();
    await t.run(step());
    await t.run(step({ effort: 'high' }));
    await t.run(step({ effort: 'high', permissionMode: 'plan' }));
    expect(t.spawns()).toBe(3);
  });

  it('streams events of the message to the caller', async () => {
    const t = setup();
    const kinds: string[] = [];
    await t.run(step({ onEvent: (e) => kinds.push(e.kind) }));
    expect(kinds).toEqual(expect.arrayContaining(['init', 'text', 'progress', 'result']));
  });

  it('keeps JSON-output, budgeted, lean and session-less calls on one process each', async () => {
    const t = setup();
    await t.run(step({ jsonSchema: {} }));
    await t.run(step({ maxBudgetUsd: 1 }));
    await t.run(step({ lean: true, tools: [] }));
    await t.run(step({ session: undefined }));
    expect(t.oneShot).toHaveBeenCalledTimes(4);
    expect(t.spawns()).toBe(0);
  });

  it('an error result rejects that message only; the process stays in use', async () => {
    vi.stubEnv('FAKE_ERROR_TURN', '1');
    const t = setup();
    await expect(t.run(step())).rejects.toMatchObject({ kind: 'claude', message: expect.stringContaining('something broke') });
    const b = await t.run(step());
    expect(b.text).toBe('reply 2 from sonnet');
    expect(t.spawns()).toBe(1);
  });

  it('a process that cannot start falls back to one claude per call, from then on', async () => {
    vi.stubEnv('FAKE_DIE', '1');
    const t = setup();
    expect((await t.run(step())).text).toBe('one-shot');
    expect((await t.run(step())).text).toBe('one-shot');
    expect(t.spawns()).toBe(1);
  });

  it('cancelling ends the process; the next step starts a new one', async () => {
    vi.stubEnv('FAKE_SLOW_MS', '5000');
    const t = setup();
    const ctl = new AbortController();
    const pending = t.run(step({ signal: ctl.signal }));
    setTimeout(() => ctl.abort(), 200);
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    vi.stubEnv('FAKE_SLOW_MS', '0');
    await t.run(step());
    expect(t.spawns()).toBe(2);
  });

  it('an idle process is ended after a while', async () => {
    const t = setup({ idleMs: 100 });
    await t.run(step());
    await new Promise((r) => setTimeout(r, 400));
    await t.run(step());
    expect(t.spawns()).toBe(2);
  });

  it('a process that never answers is given up after a while and the call runs the classic way', async () => {
    vi.stubEnv('FAKE_SILENT', '1');
    const t = setup({ firstOutputMs: 300 });
    const r = await t.run(step());
    expect(r.text).toBe('one-shot');
    expect(t.oneShot).toHaveBeenCalledTimes(1);
  });

  it('a model switch that is refused or never confirmed moves to a fresh process on the new model', async () => {
    for (const mode of ['refuse', 'ignore']) {
      vi.stubEnv('FAKE_CONTROL', mode);
      const t = setup({ controlMs: 300 });
      await t.run(step());
      const b = await t.run(step({ model: 'opus', session: { id: 'sess-1', resume: true } }));
      expect(b.text).toBe('reply 1 from opus');
      expect(t.spawns()).toBe(2);
      expect(t.oneShot).not.toHaveBeenCalled();
    }
  });

  it('a replaced process has exited before a fresh one resumes its session', async () => {
    const children: ChildProcess[] = [];
    const aliveAtSpawn: boolean[] = [];
    const spawnImpl = ((...a: Parameters<typeof spawn>) => {
      aliveAtSpawn.push(children.some((c) => c.exitCode === null && c.signalCode === null));
      const c = spawn(...a);
      children.push(c);
      return c;
    }) as typeof spawn;
    const run = createClaudeRunner({ keepAlive: true, command, spawnImpl, oneShot: vi.fn<RunClaudeFn>() });
    runners.push(run);
    await run(step());
    await run(step({ effort: 'high', session: { id: 'sess-1', resume: true } }));
    expect(aliveAtSpawn).toEqual([false, false]);
  });

  it('a process that is given up leaves a line in the debug log', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'smart-dbg-')), 'debug.log');
    vi.stubEnv('SMART_DEBUG', '1');
    vi.stubEnv('SMART_DEBUG_FILE', file);
    vi.stubEnv('FAKE_SILENT', '1');
    const t = setup({ firstOutputMs: 300 });
    await t.run(step());
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { keepAlive?: string; reason?: string });
    expect(lines.find((l) => l.keepAlive === 'given up')?.reason).toMatch(/did not answer within/);
    expect(lines.some((l) => l.keepAlive === 'off for this run')).toBe(true);
  });

  it('says once on screen when keeping the process alive does not work', async () => {
    vi.stubEnv('FAKE_SILENT', '1');
    const notices: string[] = [];
    const run = createClaudeRunner({ keepAlive: true, command, oneShot: vi.fn<RunClaudeFn>(async () => ({ isError: false, subtype: 'success', text: 'one-shot', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 })), firstOutputMs: 300, onNotice: (m) => notices.push(m) });
    runners.push(run);
    await run(step());
    await run(step({ session: { id: 'sess-1', resume: true } }));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/did not answer within 0 s.*runner\.keepAlive: false/);
  });
});

describe('kept-alive process: lifecycle edges', () => {
  it('a cancel during a model switch ends at once instead of waiting for the switch to time out', async () => {
    vi.stubEnv('FAKE_CONTROL', 'ignore'); // the switch is never confirmed
    const t = setup({ controlMs: 20_000 });
    await t.run(step());
    const ac = new AbortController();
    const started = Date.now();
    const p = t.run(step({ model: 'opus', session: { id: 'sess-1', resume: true }, signal: ac.signal }));
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(t.oneShot).not.toHaveBeenCalled();
  });

  it('calls on one session never overlap: the second waits for the first', async () => {
    vi.stubEnv('FAKE_SLOW_MS', '150');
    const t = setup();
    const order: string[] = [];
    const a = t.run(step({ prompt: 'first' })).then((r) => { order.push(r.text); });
    const b = t.run(step({ prompt: 'second', session: { id: 'sess-1', resume: true } })).then((r) => { order.push(r.text); });
    await Promise.all([a, b]);
    expect(order).toEqual(['reply 1 from sonnet', 'reply 2 from sonnet']); // same process, in order
    expect(t.oneShot).not.toHaveBeenCalled(); // never a second process on the same session
    expect(t.spawns()).toBe(1);
  });

  it('a failed call does not block the next one on the same session', async () => {
    vi.stubEnv('FAKE_ERROR_TURN', '1');
    const t = setup();
    await expect(t.run(step())).rejects.toThrow(/something broke/);
    expect((await t.run(step({ session: { id: 'sess-1', resume: true } }))).text).toBe('reply 2 from sonnet');
  });
});

describe('kept-alive process that dies mid-message', () => {
  it('fails that call (it may have done work, so it is not silently repeated) and starts a fresh process next time', async () => {
    vi.stubEnv('FAKE_DIE_TURN', '1');
    const t = setup();
    await expect(t.run(step())).rejects.toMatchObject({ kind: 'claude' });
    expect(t.oneShot).not.toHaveBeenCalled(); // never re-run behind your back
    vi.unstubAllEnvs();
    const next = await t.run(step({ session: { id: 'sess-1', resume: true } }));
    expect(next.text).toBe('reply 1 from sonnet'); // a new process
    expect(t.spawns()).toBe(2);
  });
});
