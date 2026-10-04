import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { isRunning, killTree } from '../../src/core/killTree.js';
import { taskkillPath } from '../../src/core/which.js';

const fakeChild = (pid: number | undefined) => {
  const signals: string[] = [];
  const child = { pid, exitCode: null as number | null, signalCode: null as string | null, kill: (s: string) => { signals.push(s); return true; } };
  return { child: child as unknown as ChildProcess, raw: child, signals };
};
const fakeSpawn = () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const proc = Object.assign(new EventEmitter(), { unref: () => undefined });
  const impl = ((cmd: string, args: string[]) => { calls.push({ cmd, args }); return proc; }) as never;
  return { impl, calls, proc };
};

describe('killTree', () => {
  it('sends the signal elsewhere', () => {
    const { child, signals } = fakeChild(42);
    const sp = fakeSpawn();
    killTree(child, 'SIGTERM', 'linux', sp.impl);
    expect(signals).toEqual(['SIGTERM']);
    expect(sp.calls).toEqual([]);
  });

  it('on Windows ends the whole tree with taskkill', () => {
    const { child, signals } = fakeChild(42);
    const sp = fakeSpawn();
    killTree(child, 'SIGTERM', 'win32', sp.impl);
    // taskkill by absolute path: never one found in the project folder
    expect(sp.calls).toEqual([{ cmd: taskkillPath(), args: ['/pid', '42', '/T', '/F'] }]);
    expect(sp.calls[0]!.cmd).toMatch(/System32[\\/]taskkill\.exe$/i);
    expect(signals).toEqual([]);
  });

  it('on Windows falls back to a plain kill when taskkill cannot run', () => {
    const { child, signals } = fakeChild(42);
    const sp = fakeSpawn();
    killTree(child, 'SIGKILL', 'win32', sp.impl);
    sp.proc.emit('error', new Error('ENOENT'));
    expect(signals).toEqual(['SIGKILL']);
  });

  it('never signals a process that has already exited: its id may belong to another program now', () => {
    for (const platform of ['win32', 'linux']) {
      const { child, raw, signals } = fakeChild(42);
      raw.exitCode = 0;
      const sp = fakeSpawn();
      killTree(child, 'SIGKILL', platform, sp.impl);
      expect(sp.calls).toEqual([]);
      expect(signals).toEqual([]);
      raw.exitCode = null;
      raw.signalCode = 'SIGTERM';
      killTree(child, 'SIGKILL', platform, sp.impl);
      expect(sp.calls).toEqual([]);
      expect(signals).toEqual([]);
    }
  });

  it('on Windows still ends the process itself when taskkill fails (access denied, partial tree)', () => {
    const { child, raw, signals } = fakeChild(42);
    const sp = fakeSpawn();
    killTree(child, 'SIGTERM', 'win32', sp.impl);
    sp.proc.emit('exit', 1);
    expect(signals).toEqual(['SIGTERM']);
    // ...but not when the process exited meanwhile (taskkill reported failure because it was already gone)
    const again = fakeChild(43);
    const sp2 = fakeSpawn();
    killTree(again.child, 'SIGTERM', 'win32', sp2.impl);
    again.raw.exitCode = 1;
    sp2.proc.emit('exit', 128);
    expect(again.signals).toEqual([]);
    expect(raw.exitCode).toBeNull();
  });

  it('isRunning reads Node\'s own exit state', () => {
    expect(isRunning({ exitCode: null, signalCode: null })).toBe(true);
    expect(isRunning({ exitCode: 0, signalCode: null })).toBe(false);
    expect(isRunning({ exitCode: null, signalCode: 'SIGKILL' })).toBe(false);
  });
});
