import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { acquireLock, LockError, lockBusy, quarantineCorrupt, withFileLock, writeFileAtomic } from '../../src/core/store/atomicFile.js';
import { ConversationStore, newConversation } from '../../src/core/store/conversation.js';
import { Tracker } from '../../src/core/store/tracker.js';
import { emptyUsage } from '../../src/core/types.js';
import { projectRelative } from '../../src/core/runner.js';
import { InputHistory } from '../../src/core/store/inputHistory.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'smart-lock-'));

describe('withFileLock', () => {
  it('treats a held lock as busy everywhere, and Windows\' EPERM/EACCES/EBUSY (directory being deleted) as busy only there', () => {
    expect(lockBusy('EEXIST', 'linux')).toBe(true);
    for (const c of ['EPERM', 'EACCES', 'EBUSY']) {
      expect(lockBusy(c, 'win32'), c).toBe(true);
      expect(lockBusy(c, 'linux'), c).toBe(false); // a read-only directory on Linux must not make us wait 3 s
    }
    expect(lockBusy('ENOENT', 'win32')).toBe(false);
    expect(lockBusy(undefined, 'win32')).toBe(false);
  });

  it('runs the function, returns its value and removes the lock', () => {
    const f = join(tmp(), 'x.json');
    expect(withFileLock(f, () => 42)).toBe(42);
    expect(existsSync(`${f}.lock`)).toBe(false);
  });

  it('releases the lock when the function throws', () => {
    const f = join(tmp(), 'x.json');
    expect(() => withFileLock(f, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(`${f}.lock`)).toBe(false);
  });

  it('breaks a lock left behind by a crashed process', () => {
    const f = join(tmp(), 'x.json');
    mkdirSync(`${f}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${f}.lock`, old, old);
    expect(withFileLock(f, () => 'ran')).toBe('ran');
    expect(existsSync(`${f}.lock`)).toBe(false);
  });

  it('keeps concurrent smart sessions from losing each other\'s history entries', async () => {
    const file = join(tmp(), 'input-history.json');
    const script = join(tmp(), 'writer.ts');
    const src = fileURLToPath(new URL('../../src/core/store/inputHistory.ts', import.meta.url));
    writeFileSync(script, `import { InputHistory } from ${JSON.stringify(src)};\nconst h = new InputHistory(process.argv[2]!);\nfor (let i = 0; i < 8; i++) h.push(process.argv[3] + '-' + i);\n`);
    const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const run = (id: string) => new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, [tsx, script, file, id], { stdio: 'ignore' });
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`writer ${id} exited ${c}`))));
      p.on('error', reject);
    });
    await Promise.all(['a', 'b', 'c', 'd'].map(run));
    expect(new InputHistory(file).load()).toHaveLength(32);
  }, 60_000);
});

describe('withFileLock: never runs unprotected', () => {
  const held = (f: string, owner: object | null) => {
    mkdirSync(`${f}.lock`);
    if (owner) writeFileSync(join(`${f}.lock`, 'owner.json'), JSON.stringify(owner));
  };

  it('does not run the function while another live process holds the lock, and says so', () => {
    const f = join(tmp(), 'x.json');
    held(f, { pid: 4242, host: hostname(), token: 't', at: Date.now() });
    let ran = false;
    const t0 = Date.now();
    expect(() => withFileLock(f, () => { ran = true; }, { waitMs: 150, alive: () => true })).toThrow(LockError);
    expect(ran).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(existsSync(`${f}.lock`)).toBe(true); // the holder's lock is left alone
  });

  it('takes over at once from an owner on this machine that is no longer running', () => {
    const f = join(tmp(), 'x.json');
    held(f, { pid: 4242, host: hostname(), token: 't', at: Date.now() });
    expect(withFileLock(f, () => 'ran', { waitMs: 50, alive: () => false })).toBe('ran');
    expect(existsSync(`${f}.lock`)).toBe(false);
  });

  it('a fresh lock from another machine (shared folder) is waited for, not taken over', () => {
    const f = join(tmp(), 'x.json');
    held(f, { pid: 1, host: 'some-other-host', token: 't', at: Date.now() });
    expect(() => withFileLock(f, () => 'ran', { waitMs: 80, alive: () => false })).toThrow(LockError);
  });

  it('an owner-less lock (older smart, or a crash right after creating it) is only taken over once it is old', () => {
    const f = join(tmp(), 'x.json');
    held(f, null);
    expect(() => withFileLock(f, () => 'ran', { waitMs: 80 })).toThrow(LockError);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${f}.lock`, old, old);
    expect(withFileLock(f, () => 'ran', { waitMs: 80 })).toBe('ran');
  });

  it('fails without running when no lock can be made at all (the folder cannot exist)', () => {
    const d = tmp();
    writeFileSync(join(d, 'not-a-dir'), '');
    let ran = false;
    expect(() => withFileLock(join(d, 'not-a-dir', 'x.json'), () => { ran = true; })).toThrow(LockError);
    expect(ran).toBe(false);
  });

  it('release never removes a lock that is no longer its own (taken over while it was paused)', () => {
    const f = join(tmp(), 'x.json');
    const release = acquireLock(f);
    writeFileSync(join(`${f}.lock`, 'owner.json'), JSON.stringify({ pid: 1, host: hostname(), token: 'someone-else', at: Date.now() }));
    release();
    expect(existsSync(`${f}.lock`)).toBe(true);
  });

  it('records its owner, so a crash can be recognised', () => {
    const f = join(tmp(), 'x.json');
    withFileLock(f, () => {
      const owner = JSON.parse(readFileSync(join(`${f}.lock`, 'owner.json'), 'utf8')) as { pid: number; host: string };
      expect(owner.pid).toBe(process.pid);
      expect(owner.host).toBe(hostname());
    });
  });

  it('the stores report a lock they could not take instead of writing unprotected', () => {
    const d = tmp();
    const hist = join(d, 'history.json');
    held(hist, { pid: process.ppid, host: hostname(), token: 't', at: Date.now() });
    const tracker = new Tracker(hist);
    const record = { id: 't1', startedAt: new Date().toISOString(), prompt: 'p', overhead: emptyUsage(), steps: [], totals: emptyUsage(), ok: true };
    // The default wait is 5 s; make the holder look alive and just check the message names the problem.
    const err = tracker.append(record);
    expect(err).toMatch(/in use by another smart process/);
    expect(existsSync(hist)).toBe(false);
    const convs = join(d, 'conversations.json');
    held(convs, { pid: process.ppid, host: hostname(), token: 't', at: Date.now() });
    expect(new ConversationStore(convs).save(d, newConversation())).toMatch(/in use by another smart process/);
  }, 20_000);
});

describe('writeFileAtomic / quarantineCorrupt', () => {
  it('creates missing directories, replaces the file whole and leaves no temp files behind', () => {
    const d = tmp();
    const f = join(d, 'deep', 'er', 'x.json');
    writeFileAtomic(f, '{"a":1}');
    writeFileAtomic(f, '{"a":2}');
    expect(readFileSync(f, 'utf8')).toBe('{"a":2}');
    expect(readdirSync(join(d, 'deep', 'er'))).toEqual(['x.json']);
  });

  it.runIf(process.platform !== 'win32')('writes owner-only files (history holds your prompts)', () => {
    const f = join(tmp(), 'x.json');
    writeFileAtomic(f, '{}');
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('removes its temp file and keeps the old content when the final rename fails', () => {
    const d = tmp();
    const f = join(d, 'target');
    mkdirSync(join(f, 'occupied'), { recursive: true }); // a non-empty folder where the file should go
    expect(() => writeFileAtomic(f, 'x')).toThrow();
    expect(readdirSync(d)).toEqual(['target']);
  });

  it('moves a corrupt file aside and does not throw when there is nothing to move', () => {
    const d = tmp();
    const f = join(d, 'bad.json');
    writeFileSync(f, '{oops');
    quarantineCorrupt(f);
    expect(existsSync(f)).toBe(false);
    expect(readdirSync(d).some((n) => n.startsWith('bad.json.corrupt-'))).toBe(true);
    expect(() => quarantineCorrupt(join(d, 'missing.json'))).not.toThrow();
  });
});

describe('projectRelative', () => {
  it('gives project-relative names for paths Claude reports as real paths, even under a symlinked project directory', () => {
    const real = tmp();
    mkdirSync(join(real, 'src'));
    writeFileSync(join(real, 'src', 'a.ts'), 'x');
    const link = join(tmp(), 'link');
    try {
      symlinkSync(real, link, 'dir');
    } catch {
      return; // no symlink permission (Windows without developer mode)
    }
    // Claude Code reports the real path; smart was started in the link.
    expect(projectRelative(link, join(real, 'src', 'a.ts'))).toBe('src/a.ts');
    expect(projectRelative(link, 'src/a.ts')).toBe('src/a.ts');
    expect(projectRelative(real, join(real, 'src', 'a.ts'))).toBe('src/a.ts');
  });
});
