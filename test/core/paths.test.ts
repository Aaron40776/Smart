import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMentions } from '../../src/core/mentions.js';
import { looksSecret, resolveInside, unsafePathReason } from '../../src/core/paths.js';
import { gatherFiles } from '../../src/core/runner.js';

const dir = () => mkdtempSync(join(tmpdir(), 'smart-paths-'));
const win = { platform: 'win32' };
const lin = { platform: 'linux' };

describe('unsafePathReason: refused before the filesystem is touched', () => {
  it('refuses network and device paths on every platform (asking if one exists opens a connection on Windows)', () => {
    for (const p of ['\\\\attacker\\share\\x.ts', '//attacker/share/x.ts', '\\\\?\\C:\\x', '\\\\.\\PhysicalDrive0']) {
      expect(unsafePathReason(p, win)).toMatch(/network or device/);
    }
    expect(unsafePathReason('//attacker/share/x', lin)).toMatch(/network or device/);
  });

  it('refuses traversal, absolute and drive-relative paths', () => {
    expect(unsafePathReason('../../etc/passwd', lin)).toMatch(/leaves the project/);
    expect(unsafePathReason('src\\..\\..\\x', win)).toMatch(/leaves the project/);
    expect(unsafePathReason('/etc/passwd', lin)).toMatch(/absolute/);
    expect(unsafePathReason('C:\\Windows\\win.ini', win)).toMatch(/absolute/);
    expect(unsafePathReason('\\Windows\\win.ini', win)).toMatch(/absolute/);
    expect(unsafePathReason('C:secret.txt', win)).toMatch(/drive-relative/);
    expect(unsafePathReason('/etc/passwd', { ...lin, allowAbsolute: true })).toBeNull();
  });

  it('refuses Windows device names and alternate data streams', () => {
    for (const p of ['CON', 'nul.txt', 'src/COM1', 'aux.ts', 'LPT9.log', 'CON .txt']) expect(unsafePathReason(p, win)).toMatch(/reserved device/);
    expect(unsafePathReason('file.txt:hidden', win)).toMatch(/alternate data stream/);
    expect(unsafePathReason('console.ts', win)).toBeNull();
    expect(unsafePathReason('CON', lin)).toBeNull(); // an ordinary name elsewhere
  });

  it('refuses empty names and control characters, accepts ordinary project paths', () => {
    expect(unsafePathReason('', lin)).toMatch(/empty/);
    expect(unsafePathReason('a\0b', lin)).toMatch(/NUL/);
    expect(unsafePathReason('a\x1b[2Jb', lin)).toMatch(/control/);
    for (const ok of ['src/app/[id]/page.tsx', 'a..b.ts', '.github/workflows/ci.yml', 'dir/./file']) expect(unsafePathReason(ok, lin)).toBeNull();
  });
});

describe('resolveInside: the real location must stay inside the project', () => {
  it('accepts files inside, missing files inside, and refuses a symlink that leads out', () => {
    const root = dir();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'x');
    expect(resolveInside(root, 'src/a.ts')?.rel).toBe('src/a.ts');
    expect(resolveInside(root, 'src/not-yet.ts')?.rel).toBe('src/not-yet.ts');
    if (process.platform !== 'win32') {
      const outside = dir();
      writeFileSync(join(outside, 'secret'), 's');
      symlinkSync(outside, join(root, 'out'));
      expect(resolveInside(root, 'out/secret')).toBeNull();
      expect(resolveInside(root, 'out/missing')).toBeNull();
    }
  });

  it('allows an absolute path you typed only when it is inside the project', () => {
    const root = dir();
    writeFileSync(join(root, 'a.ts'), 'x');
    expect(resolveInside(root, join(root, 'a.ts'))).toBeNull();
    expect(resolveInside(root, join(root, 'a.ts'), { allowAbsolute: true })?.rel).toBe('a.ts');
    expect(resolveInside(root, join(dir(), 'b.ts'), { allowAbsolute: true })).toBeNull();
  });
});

describe('context gathering uses the checks', () => {
  it('reads each file once, skips secrets it picked itself, and never reads outside', () => {
    const root = dir();
    writeFileSync(join(root, 'a.ts'), 'AAAA');
    writeFileSync(join(root, '.env'), 'API_KEY=s3cret');
    writeFileSync(join(root, '.env.example'), 'API_KEY=');
    const got = gatherFiles(root, ['a.ts', './a.ts', 'a.ts', '.env', '.env.example', '../x', '\\\\h\\s\\x'], 1000, { skipSecrets: true });
    expect(got.map((f) => f.path)).toEqual(['a.ts', '.env.example']);
    // You can still point at it yourself
    expect(gatherFiles(root, ['.env'], 1000).map((f) => f.content)).toEqual(['API_KEY=s3cret']);
  });

  it('an @mention of an absolute path inside the project works; one outside or a network path does not', () => {
    const root = dir();
    writeFileSync(join(root, 'a.ts'), 'A');
    const outside = join(dir(), 'o.ts');
    writeFileSync(outside, 'O');
    const got = resolveMentions(root, `look at @${join(root, 'a.ts')} and @${outside} and @//evil/share/x`, 10_000);
    expect(got.map((f) => f.content)).toEqual(['A']);
  });

  it('looksSecret knows the usual suspects but not templates', () => {
    for (const s of ['.env', '.env.local', 'config/.npmrc', 'id_rsa', 'id_ed25519.pub', 'server.pem', 'tls.key', 'cert.pfx']) expect(looksSecret(s)).toBe(true);
    for (const s of ['.env.example', '.env.sample', 'env.ts', 'keys.ts', 'README.md', 'monkey.ts']) expect(looksSecret(s)).toBe(false);
  });
});
