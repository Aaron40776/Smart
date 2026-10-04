import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { updateSmart, type CaptureCommand, type RunCommand } from '../src/update.js';

const tmp = (p = 'smart-upd-') => mkdtempSync(join(tmpdir(), p));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const setIdentity = (d: string) => {
  git(d, 'config', 'user.email', 't@t.t');
  git(d, 'config', 'user.name', 't');
  git(d, 'config', 'core.autocrlf', 'false');
};

/** An "upstream" Smart repository and an installation cloned from it. */
function fixture() {
  const upstream = tmp('smart-up-');
  git(upstream, 'init', '-q', '-b', 'main');
  setIdentity(upstream);
  writeFileSync(join(upstream, 'package.json'), JSON.stringify({ version: '0.3.0' }));
  writeFileSync(join(upstream, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(upstream, 'README.md'), 'smart\n');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-qm', 'v0.3.0');
  const root = join(tmp('smart-inst-'), 'Smart');
  execFileSync('git', ['clone', '-q', upstream, root]);
  setIdentity(root);
  const release = (version: string, file = 'package.json') => {
    writeFileSync(join(upstream, file), file === 'package.json' ? JSON.stringify({ version }) : `${version}\n`);
    git(upstream, 'commit', '-qam', version);
  };
  return { upstream, root, release };
}

/** Real git (quiet), fake npm: records what ran. */
function deps(npm: (args: string[]) => number = () => 0) {
  const ran: string[] = [];
  const lines: string[] = [];
  const run: RunCommand = (cmd, args, cwd) => {
    ran.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'npm') return npm(args);
    return spawnSync(cmd, args, { cwd, stdio: 'ignore' }).status ?? 1;
  };
  const capture: CaptureCommand = (cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { code: r.status ?? 1, stdout: r.stdout ?? '' };
  };
  return { ran, lines, deps: { run, capture, log: (l: string) => lines.push(l) } };
}

describe('smart update', () => {
  it('fast-forwards, installs without install scripts, rebuilds, and names the versions', () => {
    const f = fixture();
    f.release('0.4.0');
    const d = deps();
    expect(updateSmart(f.root, {}, d.deps)).toBe(0);
    expect(d.ran).toEqual(['git fetch --quiet', 'git merge --ff-only --quiet @{u}', 'npm ci --ignore-scripts', 'npm run build']);
    expect(d.lines.at(-1)).toBe('Updated smart 0.3.0 → 0.4.0. See CHANGELOG.md for what changed.');
    expect(JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8')).version).toBe('0.4.0');
  });

  it('refuses to touch a folder with local changes, and keeps them byte for byte', () => {
    const f = fixture();
    f.release('0.4.0');
    writeFileSync(join(f.root, 'README.md'), 'my own notes\n');
    const d = deps();
    expect(updateSmart(f.root, {}, d.deps)).toBe(1);
    expect(d.ran).toEqual([]); // not even a fetch
    expect(readFileSync(join(f.root, 'README.md'), 'utf8')).toBe('my own notes\n');
    expect(d.lines.join('\n')).toMatch(/nothing was changed.*\n {2}README\.md\n.*smart update --stash/s);
  });

  it('a package-lock.json rewritten by an old `npm install` is explained, never silently reverted', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'package-lock.json'), '{"lockfileVersion":3,"rewritten":true}\n');
    const d = deps();
    expect(updateSmart(f.root, {}, d.deps)).toBe(1);
    expect(readFileSync(join(f.root, 'package-lock.json'), 'utf8')).toContain('rewritten');
    expect(d.lines.join('\n')).toMatch(/probably rewritten by `npm install`.*checkout -- package-lock\.json/s);
  });

  it('--stash sets local changes aside (recoverable with git stash pop) and updates', () => {
    const f = fixture();
    f.release('0.4.0');
    writeFileSync(join(f.root, 'README.md'), 'my own notes\n');
    const d = deps();
    expect(updateSmart(f.root, { stash: true }, d.deps)).toBe(0);
    expect(git(f.root, 'stash', 'list')).toMatch(/smart update/);
    git(f.root, 'stash', 'pop');
    expect(readFileSync(join(f.root, 'README.md'), 'utf8')).toBe('my own notes\n');
  });

  it('leaves untracked files alone', () => {
    const f = fixture();
    f.release('0.4.0');
    writeFileSync(join(f.root, 'my-script.ps1'), 'keep me');
    expect(updateSmart(f.root, {}, deps().deps)).toBe(0);
    expect(readFileSync(join(f.root, 'my-script.ps1'), 'utf8')).toBe('keep me');
  });

  it('keeps local commits: nothing new upstream is fine, a diverged branch is explained and left alone', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'mine.txt'), 'local');
    git(f.root, 'add', 'mine.txt');
    git(f.root, 'commit', '-qm', 'mine');
    const d = deps();
    expect(updateSmart(f.root, {}, d.deps)).toBe(0);
    expect(d.lines.join('\n')).toMatch(/local commit is kept/);
    f.release('0.4.0');
    const head = git(f.root, 'rev-parse', 'HEAD');
    const d2 = deps();
    expect(updateSmart(f.root, {}, d2.deps)).toBe(1);
    expect(d2.lines.join('\n')).toMatch(/diverged, so nothing was changed/);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('a failed fetch changes nothing', () => {
    const f = fixture();
    git(f.root, 'remote', 'set-url', 'origin', join(tmpdir(), 'no-such-repo-anywhere'));
    const head = git(f.root, 'rev-parse', 'HEAD');
    const d = deps();
    expect(updateSmart(f.root, {}, d.deps)).toBe(1);
    expect(d.lines.at(-1)).toMatch(/`git fetch` failed, so nothing was changed/);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('when npm ci or the build fails after the code moved, it says how to get back to the previous commit', () => {
    for (const failing of ['ci', 'run']) {
      const f = fixture();
      const before = git(f.root, 'rev-parse', 'HEAD');
      f.release('0.4.0');
      const d = deps((args) => (args[0] === failing ? 1 : 0));
      expect(updateSmart(f.root, {}, d.deps)).toBe(1);
      expect(d.lines.at(-1)).toContain(`reset --keep ${before.slice(0, 12)}`);
      // and that way back works without losing anything
      git(f.root, 'reset', '--keep', before);
      expect(JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8')).version).toBe('0.3.0');
    }
  });

  it('a pinned installation (a tag checked out) is left as it is', () => {
    const f = fixture();
    git(f.upstream, 'tag', 'v0.3.0');
    git(f.root, 'fetch', '-q', '--tags');
    git(f.root, 'checkout', '-q', 'v0.3.0');
    const d = deps();
    expect(updateSmart(f.root, {}, d.deps)).toBe(1);
    expect(d.lines.at(-1)).toMatch(/pinned to v0\.3\.0.*SMART_REF/);
    expect(d.ran).toEqual([]);
  });

  it('explains when smart was not installed from a git clone', () => {
    const d = deps();
    expect(updateSmart(tmp(), {}, d.deps)).toBe(1);
    expect(d.lines[0]).toMatch(/not installed with git.*install\.ps1/);
  });
});

describe('smart update: how commands are started', () => {
  it('only npm goes through the shell on Windows (it joins arguments unquoted: a stash message with spaces would split)', async () => {
    const { needsShell } = await import('../src/update.js');
    expect(needsShell('npm', 'win32')).toBe(true);
    expect(needsShell('git', 'win32')).toBe(false);
    expect(needsShell('npm', 'linux')).toBe(false);
  });
});
