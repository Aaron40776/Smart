import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ConversationStore, dirKey, newConversation } from '../src/core/store/conversation.js';
import { App } from '../src/ui/App.js';
import { CLEAR_PROGRESS, progressFor, progressSequence } from '../src/ui/progress.js';
import { initialState } from '../src/ui/state.js';
import { KEYS, makeApp, wait, waitFor } from './ui/helpers.js';

const tmp = (p = 'smart-b1-') => mkdtempSync(join(tmpdir(), p));

describe('one conversation per folder on Windows, however the path is spelled', () => {
  it('dirKey ignores case and trailing separators on Windows only', () => {
    expect(dirKey('C:\\Users\\Me\\App', 'win32')).toBe(dirKey('c:\\users\\me\\app\\', 'win32'));
    expect(dirKey('C:/Users/Me/App', 'win32')).toBe(dirKey('c:\\users\\me\\app', 'win32'));
    expect(dirKey('/home/me/App', 'linux')).not.toBe(dirKey('/home/me/app', 'linux'));
    expect(dirKey('/home/me/app/', 'linux')).toBe('/home/me/app');
  });

  it('finds the conversation under another casing, and keeps a single entry when saving', () => {
    const file = join(tmp(), 'conversations.json');
    const store = new ConversationStore(file, 'win32');
    const conv = { ...newConversation(), tasks: [{ prompt: 'first', outcome: 'done' as const, files: [], reply: '', at: '' }] };
    store.save('C:\\Users\\Me\\App', conv);
    expect(store.load('c:\\users\\me\\app')?.tasks[0]?.prompt).toBe('first');
    store.save('c:\\users\\me\\app\\', conv);
    expect(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { byDir: object }).byDir)).toHaveLength(1);
  });

  it('still reads entries written before keys were normalised', () => {
    const file = join(tmp(), 'conversations.json');
    writeFileSync(file, JSON.stringify({ version: 1, byDir: { 'C:\\Projects\\Game': { ...newConversation(), tasks: [], sessionId: 'old', updatedAt: '2026-01-01T00:00:00Z' } } }));
    expect(new ConversationStore(file, 'win32').load('c:\\projects\\game')?.sessionId).toBe('old');
  });
});

describe('taskbar progress', () => {
  const plan = { summary: 's', features: [], fileStructure: [], steps: ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id, instructions: id, files: [], acceptance: [] })) };
  const base = initialState();

  it('maps the task state to Windows Terminal progress', () => {
    expect(progressFor(base)).toEqual({ state: 0, percent: 0 }); // idle: nothing shown
    expect(progressFor({ ...base, phase: 'running' })).toEqual({ state: 3, percent: 0 }); // classifying/planning: busy
    expect(progressFor({ ...base, phase: 'approval', plan })).toMatchObject({ state: 4 }); // waiting for you
    expect(progressFor({ ...base, phase: 'running', plan, stepStatus: { a: 'done', b: 'active' } })).toEqual({ state: 1, percent: 25 });
    expect(progressFor({ ...base, phase: 'running', plan, stepStatus: { a: 'active' } }).percent).toBeGreaterThan(0);
    expect(progressFor({ ...base, phase: 'finished', ok: false })).toMatchObject({ state: 2 }); // failed: red until the next task
    expect(progressFor({ ...base, phase: 'finished', ok: true })).toEqual({ state: 0, percent: 0 });
    expect(progressSequence({ state: 1, percent: 25 })).toBe('\x1b]9;4;1;25\x07');
  });

  it('the app sends it only when it changes, and clears it when closing', async () => {
    const sent: string[] = [];
    const slow = async () => {
      await wait(150); // long enough for the running state to be drawn
      return { isError: false, subtype: 'success', text: 'done', structured: undefined, usage: { inputTokens: 0, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01 }, sessionId: 's', numTurns: 1 };
    };
    const { stdin, lastFrame, unmount } = render(<App {...makeApp({ complexity: 'small_edit', executor: slow })} terminal={{ write: (s) => sent.push(s) }} />);
    stdin.write('make the parser handle empty input');
    await wait();
    stdin.write(KEYS.enter);
    await waitFor(() => lastFrame()!.includes('✓ Done'));
    await waitFor(() => sent.at(-1) === CLEAR_PROGRESS); // effects run just after the frame is drawn
    expect(sent).toContain(progressSequence({ state: 3, percent: 0 }));
    expect(sent.every((s, i) => i === 0 || s !== sent[i - 1])).toBe(true); // no repeats
    unmount();
    expect(sent.at(-1)).toBe(CLEAR_PROGRESS);
  });
});

// `smart update` is covered by test/update.test.ts (against real git repositories).
