import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runClaude, spawnEnv, type ClaudeResult, type RunClaudeFn, type RunClaudeOptions } from '../../src/core/claude.js';
import { createClaudeRunner, type ClaudeRunner } from '../../src/core/claudeProcess.js';
import { sparable, Spares } from '../../src/core/spares.js';
import { CLASSIFIER_SYSTEM, classifierCall } from '../../src/core/classifier.js';
import { defaultConfig } from '../../src/core/config.js';
import { emptyUsage } from '../../src/core/types.js';

const fake = fileURLToPath(new URL('../fixtures/fake-claude-stream.mjs', import.meta.url));
const command = { cmd: process.execPath, prefix: [fake] };
const cleanup: { dispose: () => void }[] = [];
afterEach(() => cleanup.splice(0).forEach((c) => c.dispose()));

const classify = (over: Partial<RunClaudeOptions> = {}): RunClaudeOptions => ({ prompt: 'fix the typo', model: 'haiku', cwd: process.cwd(), systemPrompt: 'Classify.', jsonSchema: { type: 'object' }, tools: [], lean: true, ...over });
const cold: ClaudeResult = { isError: false, subtype: 'success', text: 'cold start', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 };

describe('spare processes for short calls', () => {
  it('only tool-less one-shot calls use them', () => {
    expect(sparable(classify())).toBe(true);
    expect(sparable(classify({ jsonSchema: undefined }))).toBe(true); // an answer: tools: []
    expect(sparable(classify({ session: { id: 's', resume: false } }))).toBe(false);
    expect(sparable({ prompt: 'x', model: 'sonnet', cwd: '.' })).toBe(false); // a coding call
  });

  it('a spare fits only a call with the same command line, and is handed out once', () => {
    const spares = new Spares(() => command, spawn);
    cleanup.push(spares);
    spares.warm(classify());
    expect(spares.take(classify({ model: 'sonnet' }))).toBeUndefined();
    const child = spares.take(classify({ prompt: 'another task' })); // the prompt is not part of the command line
    expect(child?.pid).toBeDefined();
    expect(spares.take(classify())).toBeUndefined();
    child?.kill();
  });

  it('keeps at most three and ends them on dispose', () => {
    const spares = new Spares(() => command, spawn);
    for (const model of ['haiku', 'sonnet', 'opus', 'haiku-2']) spares.warm(classify({ model }));
    expect(spares.size).toBe(3);
    expect(spares.take(classify({ model: 'haiku' }))).toBeUndefined(); // the oldest was ended
    spares.dispose();
    expect(spares.size).toBe(0);
  });

  it('the runner answers the next short call on a spare, started after the first', async () => {
    const oneShot = vi.fn<RunClaudeFn>(async (o) => (o.spawnImpl ? runClaude(o) : cold));
    const run: ClaudeRunner = createClaudeRunner({ keepAlive: true, command, oneShot });
    cleanup.push(run);
    expect((await run(classify())).text).toBe('cold start');
    const texts: string[] = [];
    const warm = await run(classify({ prompt: 'rename x', onEvent: (e) => { if (e.kind === 'text') texts.push(e.text); } }));
    expect(oneShot.mock.calls[1]?.[0].streamInput).toBe(true);
    expect(warm.text).toBe('reply 1 from haiku'); // from the spare, not the cold start
    expect(texts).toEqual(['reply 1 from haiku: rename x']); // the prompt reached it
  });

  it('warm() starts one ahead of the first call; no spares when keep-alive is off', async () => {
    const oneShot = vi.fn<RunClaudeFn>(async (o) => (o.spawnImpl ? runClaude(o) : cold));
    const run = createClaudeRunner({ keepAlive: true, command, oneShot });
    cleanup.push(run);
    run.warm(classify());
    expect((await run(classify())).text).toBe('reply 1 from haiku');
    const off = createClaudeRunner({ keepAlive: false, command, oneShot });
    cleanup.push(off);
    off.warm(classify());
    expect((await off(classify())).text).toBe('cold start');
  });

  it('the classifier runs without extended thinking, and its spare matches only such calls', () => {
    const call = classifierCall(defaultConfig(), process.cwd());
    expect(call.thinking).toBe(false);
    expect(CLASSIFIER_SYSTEM).toContain('If unsure between "normal" and "hard", choose "hard"');
    expect(spawnEnv({ ...call, prompt: '' })?.MAX_THINKING_TOKENS).toBe('0');
    expect(spawnEnv(classify())).toBeUndefined(); // other calls keep Claude Code's default
    const spares = new Spares(() => command, spawn);
    cleanup.push(spares);
    spares.warm(classify({ thinking: false }));
    expect(spares.take(classify())).toBeUndefined();
    const child = spares.take(classify({ thinking: false }));
    expect(child?.pid).toBeDefined();
    child?.kill();
  });

  it('spares stop once keep-alive has proven unusable for this Claude Code', async () => {
    vi.stubEnv('FAKE_DIE', '1'); // the process exits at once, as an old Claude Code that rejects stream-json input would
    const oneShot = vi.fn<RunClaudeFn>(async () => cold);
    const run = createClaudeRunner({ keepAlive: true, command, oneShot });
    cleanup.push(run);
    await run({ prompt: 'x', model: 'sonnet', cwd: process.cwd(), session: { id: 's1', resume: false } }); // unusable → classic way, keep-alive off
    vi.unstubAllEnvs();
    await run(classify());
    expect(oneShot.mock.calls.every(([o]) => !o.streamInput)).toBe(true);
    run.warm(classify()); // a no-op now
    await run(classify());
    expect(oneShot.mock.calls.every(([o]) => !o.streamInput)).toBe(true);
  });
});

describe('spares that died', () => {
  it('a spare that exited while waiting is replaced by a fresh claude for that call, not reported as a failure', async () => {
    const oneShot = vi.fn<RunClaudeFn>(async (o) => (o.spawnImpl ? runClaude(o) : cold));
    const run: ClaudeRunner = createClaudeRunner({ keepAlive: true, command, oneShot });
    cleanup.push(run);
    vi.stubEnv('FAKE_DIE', '1'); // the spare started now dies at once
    run.warm(classify());
    await new Promise((r) => setTimeout(r, 300));
    vi.unstubAllEnvs();
    const r = await run(classify());
    expect(r.text).toBe('cold start'); // answered by the fresh one-shot call
    expect(oneShot).toHaveBeenCalledTimes(1); // the dead spare was not even offered (it had exited)
  });

  it('a spare that is taken but turns out dead is retried once on a fresh process', async () => {
    const calls: boolean[] = [];
    const oneShot = vi.fn<RunClaudeFn>(async (o) => {
      calls.push(Boolean(o.spawnImpl));
      if (o.spawnImpl) {
        const { SmartError } = await import('../../src/core/errors.js');
        const e = new SmartError('claude', 'Claude Code failed: exit code 3');
        e.noOutput = true;
        throw e;
      }
      return cold;
    });
    const run: ClaudeRunner = createClaudeRunner({ keepAlive: true, command, oneShot });
    cleanup.push(run);
    run.warm(classify());
    const r = await run(classify());
    expect(r.text).toBe('cold start');
    expect(calls).toEqual([true, false]);
  });
});
