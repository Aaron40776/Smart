import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCheckpoints, GitCheckpoints, NoCheckpoints } from '../../src/core/checkpoint.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
function repo(commit = true): string {
  const d = mkdtempSync(join(tmpdir(), 'smart-git-'));
  sh(d, 'init', '-q');
  sh(d, 'config', 'user.email', 't@t.t');
  sh(d, 'config', 'user.name', 't');
  sh(d, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(d, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(d, 'keep.txt'), 'keep\n');
  writeFileSync(join(d, '.gitignore'), 'ignored.log\n');
  if (commit) {
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'init');
  }
  return d;
}

const made: GitCheckpoints[] = [];
afterEach(() => made.splice(0).forEach((c) => c.dispose()));
async function cp(dir: string): Promise<GitCheckpoints> {
  const c = new GitCheckpoints(dir);
  expect(await c.init()).toBe(true);
  made.push(c);
  return c;
}

describe('GitCheckpoints', () => {
  it('is unavailable outside a git repository', async () => {
    const d = mkdtempSync(join(tmpdir(), 'smart-nogit-'));
    const c = new GitCheckpoints(d);
    expect(await c.init()).toBe(false);
    expect(await c.snapshot()).toBeNull();
    expect((await createCheckpoints(d)) instanceof NoCheckpoints).toBe(true);
  });

  it('reports added, modified and deleted files with line counts', async () => {
    const d = repo();
    const c = await cp(d);
    const before = (await c.snapshot())!;
    writeFileSync(join(d, 'a.txt'), 'one\nTWO\nthree\n'); // 1 changed line + 1 added
    writeFileSync(join(d, 'new.txt'), 'x\ny\n');
    unlinkSync(join(d, 'keep.txt'));
    const after = (await c.snapshot())!;
    const ch = (await c.changes(before, after))!;
    expect(Object.fromEntries(ch.files.map((f) => [f.path, f.status]))).toEqual({ 'a.txt': 'M', 'new.txt': 'A', 'keep.txt': 'D' });
    expect(ch.insertions).toBe(2 + 2);
    expect(ch.deletions).toBe(1 + 1);
    expect(await c.changes(before, before)).toEqual({ files: [], insertions: 0, deletions: 0 });
  });

  it('sees files created any way (e.g. by a shell command), including untracked ones, but not ignored ones', async () => {
    const d = repo();
    const c = await cp(d);
    const before = (await c.snapshot())!;
    mkdirSync(join(d, 'src', 'deep'), { recursive: true });
    writeFileSync(join(d, 'src', 'deep', 'made.js'), 'x');
    writeFileSync(join(d, 'ignored.log'), 'noise');
    const ch = (await c.changes(before, (await c.snapshot())!))!;
    expect(ch.files.map((f) => f.path)).toEqual(['src/deep/made.js']);
  });

  it('never touches the real index, HEAD or working tree state', async () => {
    const d = repo();
    writeFileSync(join(d, 'a.txt'), 'edited\n'); // unstaged edit
    writeFileSync(join(d, 'untracked.txt'), 'u\n');
    const statusBefore = sh(d, 'status', '--porcelain');
    const headBefore = sh(d, 'rev-parse', 'HEAD');
    const c = await cp(d);
    await c.snapshot();
    await c.snapshot();
    expect(sh(d, 'status', '--porcelain')).toBe(statusBefore);
    expect(sh(d, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(sh(d, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('works in a repository with no commits yet', async () => {
    const d = repo(false);
    const c = await cp(d);
    const before = (await c.snapshot())!;
    writeFileSync(join(d, 'fresh.txt'), 'hi');
    const ch = (await c.changes(before, (await c.snapshot())!))!;
    expect(ch.files).toEqual([{ path: 'fresh.txt', status: 'A' }]);
  });

  it('restores modified, deleted and created files (undo)', async () => {
    const d = repo();
    const c = await cp(d);
    const start = (await c.snapshot())!;
    writeFileSync(join(d, 'a.txt'), 'CHANGED\n');
    unlinkSync(join(d, 'keep.txt'));
    mkdirSync(join(d, 'gen', 'inner'), { recursive: true });
    writeFileSync(join(d, 'gen', 'inner', 'file.js'), 'new');
    writeFileSync(join(d, 'ignored.log'), 'stays');
    const end = (await c.snapshot())!;
    const r = await c.restore(start, end);
    expect(r).toEqual({ restored: 2, removed: 1, failed: [] });
    expect(readFileSync(join(d, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(readFileSync(join(d, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(d, 'gen'))).toBe(false); // empty parents are cleaned up too
    expect(existsSync(join(d, 'ignored.log'))).toBe(true); // ignored files are never touched
    expect(await c.snapshot()).toBe(start);
  });

  it('produces a readable unified diff', async () => {
    const d = repo();
    const c = await cp(d);
    const a = (await c.snapshot())!;
    writeFileSync(join(d, 'a.txt'), 'one\nTWO\n');
    const diff = (await c.diff(a, (await c.snapshot())!))!;
    expect(diff).toContain('-two');
    expect(diff).toContain('+TWO');
  });

  it('works from a subdirectory of the repository', async () => {
    const d = repo();
    mkdirSync(join(d, 'pkg'));
    const c = await cp(join(d, 'pkg'));
    const a = (await c.snapshot())!;
    writeFileSync(join(d, 'pkg', 'x.txt'), 'x');
    const ch = (await c.changes(a, (await c.snapshot())!))!;
    expect(ch.files).toEqual([{ path: 'pkg/x.txt', status: 'A' }]);
  });
});

describe('GitCheckpoints: project directory position', () => {
  it('reports where the project directory sits inside the repository', async () => {
    const d = repo();
    mkdirSync(join(d, 'pkg', 'inner'), { recursive: true });
    expect((await cp(d)).prefix).toBe('');
    expect((await cp(join(d, 'pkg'))).prefix).toBe('pkg');
    expect((await cp(join(d, 'pkg', 'inner'))).prefix).toBe('pkg/inner');
  });
  it('prunes only the empty parent directories of removed files', async () => {
    const d = repo();
    mkdirSync(join(d, 'keepdir'), { recursive: true });
    writeFileSync(join(d, 'keepdir', 'stays.txt'), 's');
    const c = await cp(d);
    const start = (await c.snapshot())!;
    mkdirSync(join(d, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(d, 'a', 'b', 'c', 'x.txt'), 'x');
    writeFileSync(join(d, 'a', 'y.txt'), 'y');
    writeFileSync(join(d, 'keepdir', 'new.txt'), 'n');
    await c.restore(start, (await c.snapshot())!);
    expect(existsSync(join(d, 'a'))).toBe(false);
    expect(existsSync(join(d, 'keepdir', 'stays.txt'))).toBe(true);
    expect(existsSync(join(d, 'keepdir', 'new.txt'))).toBe(false);
  });
});

describe('GitCheckpoints: scoped to the project directory (monorepo)', () => {
  function mono(): string {
    const d = repo();
    mkdirSync(join(d, 'packages', 'a'), { recursive: true });
    mkdirSync(join(d, 'packages', 'b'), { recursive: true });
    writeFileSync(join(d, 'packages', 'a', 'a.txt'), 'a\n');
    writeFileSync(join(d, 'packages', 'b', 'b.txt'), 'b\n');
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'mono');
    return d;
  }

  it('does not report or restore files outside the directory smart runs in', async () => {
    const d = mono();
    const c = await cp(join(d, 'packages', 'a'));
    const start = (await c.snapshot())!;
    writeFileSync(join(d, 'packages', 'a', 'a.txt'), 'changed by smart\n');
    const end = (await c.snapshot())!;
    // The user edits a sibling package (and the root) by hand after the task
    writeFileSync(join(d, 'packages', 'b', 'b.txt'), 'my own precious edit\n');
    writeFileSync(join(d, 'a.txt'), 'root edit\n');
    const now = (await c.snapshot())!;
    expect((await c.changes(start, end))!.files).toEqual([{ path: 'packages/a/a.txt', status: 'M' }]);
    expect((await c.changes(start, now))!.files.map((f) => f.path)).toEqual(['packages/a/a.txt']);
    await c.restore(start, now);
    expect(readFileSync(join(d, 'packages', 'a', 'a.txt'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(d, 'packages', 'b', 'b.txt'), 'utf8')).toBe('my own precious edit\n');
    expect(readFileSync(join(d, 'a.txt'), 'utf8')).toBe('root edit\n');
  });

  it('/diff is a plain unified diff even when git is configured with an external diff tool', async () => {
    const d = repo();
    sh(d, 'config', 'diff.external', 'false'); // would run `false` instead of producing a diff
    const c = await cp(d);
    const a = (await c.snapshot())!;
    writeFileSync(join(d, 'a.txt'), 'one\nchanged\n');
    const text = await c.diff(a, (await c.snapshot())!);
    expect(text).toContain('+changed');
  });
});


describe('GitCheckpoints: restore stays inside the project', () => {
  const linkable = process.platform !== 'win32'; // symlinks need extra rights on Windows; junction behaviour is covered by realpath there

  it.runIf(linkable)('never deletes through a folder that now links outside the project', async () => {
    const d = repo();
    const outside = mkdtempSync(join(tmpdir(), 'smart-outside-'));
    writeFileSync(join(outside, 'precious.txt'), 'do not delete');
    const c = await cp(d);
    const start = (await c.snapshot())!;
    mkdirSync(join(d, 'gen'));
    writeFileSync(join(d, 'gen', 'precious.txt'), 'made by the task');
    const end = (await c.snapshot())!;
    // After the task, `gen` is replaced by a link to a folder outside the project holding a file of the same name.
    rmSync(join(d, 'gen'), { recursive: true });
    symlinkSync(outside, join(d, 'gen'));
    const r = (await c.restore(start, end))!;
    expect(r.removed).toBe(0);
    expect(r.failed).toEqual(['gen/precious.txt']);
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('do not delete');
  });

  it.runIf(linkable)('removes a link the task created without touching what it points to', async () => {
    const d = repo();
    const outside = mkdtempSync(join(tmpdir(), 'smart-outside-'));
    writeFileSync(join(outside, 'target.txt'), 'keep me');
    const c = await cp(d);
    const start = (await c.snapshot())!;
    symlinkSync(join(outside, 'target.txt'), join(d, 'link.txt'));
    const end = (await c.snapshot())!;
    const r = (await c.restore(start, end))!;
    expect(r).toEqual({ restored: 0, removed: 1, failed: [] });
    expect(existsSync(join(d, 'link.txt'))).toBe(false);
    expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe('keep me');
  });

  it.runIf(linkable)('writes restored files into the project even when a folder became a link (git replaces the link)', async () => {
    const d = repo();
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 'a.txt'), 'orig');
    const outside = mkdtempSync(join(tmpdir(), 'smart-outside-'));
    const c = await cp(d);
    const start = (await c.snapshot())!;
    writeFileSync(join(d, 'sub', 'a.txt'), 'changed');
    const end = (await c.snapshot())!;
    rmSync(join(d, 'sub'), { recursive: true });
    symlinkSync(outside, join(d, 'sub'));
    await c.restore(start, end, ['sub/a.txt']);
    expect(existsSync(join(outside, 'a.txt'))).toBe(false);
    expect(readFileSync(join(d, 'sub', 'a.txt'), 'utf8')).toBe('orig');
  });

  it('a rename is undone as a delete plus an add: the old name comes back, the new one goes', async () => {
    const d = repo();
    const c = await cp(d);
    const start = (await c.snapshot())!;
    renameSync(join(d, 'a.txt'), join(d, 'b.txt'));
    const end = (await c.snapshot())!;
    expect((await c.changes(start, end))!.files).toEqual([{ path: 'a.txt', status: 'D' }, { path: 'b.txt', status: 'A' }]);
    expect(await c.restore(start, end)).toEqual({ restored: 1, removed: 1, failed: [] });
    expect(readFileSync(join(d, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(existsSync(join(d, 'b.txt'))).toBe(false);
  });

  it('ignores paths outside the project folder even when a caller asks for them (monorepo)', async () => {
    const d = repo();
    mkdirSync(join(d, 'pkg'));
    const c = await cp(join(d, 'pkg'));
    const start = (await c.snapshot())!;
    writeFileSync(join(d, 'pkg', 'mine.txt'), 'x');
    writeFileSync(join(d, 'a.txt'), 'edited outside the project');
    const end = (await c.snapshot())!;
    const r = (await c.restore(start, end, ['a.txt', 'pkg/mine.txt']))!;
    expect(r).toEqual({ restored: 0, removed: 1, failed: [] });
    expect(readFileSync(join(d, 'a.txt'), 'utf8')).toBe('edited outside the project');
    expect(existsSync(join(d, 'pkg'))).toBe(true); // never prunes the project folder itself
  });

  it('a failed git step reports null rather than success', async () => {
    const d = repo();
    const c = await cp(d);
    const start = (await c.snapshot())!;
    writeFileSync(join(d, 'a.txt'), 'x');
    const end = (await c.snapshot())!;
    expect(await c.restore('0'.repeat(40), end)).toBeNull(); // a tree that does not exist (gc'd, or another repository's)
    expect(readFileSync(join(d, 'a.txt'), 'utf8')).toBe('x');
    expect(await c.restore(start, end)).not.toBeNull();
  });
});
