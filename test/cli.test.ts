import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The real entry point (src/cli.tsx through tsx), with the fake Claude Code and a throwaway home, in a scratch folder. */
const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.tsx', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
function smart(args: string[], env: Record<string, string> = {}, files: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'smart-cli-'));
  const home = join(cwd, 'home');
  mkdirSync(home);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
  const r = spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, SMART_CLAUDE_BIN: fake, FAKE_DELAY_MS: '1', ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, cwd };
}

describe('command line contract', () => {
  it('an unknown option is a usage error (2); with -p --output-format json stdout is still one JSON document', () => {
    expect(smart(['--bogus']).code).toBe(2);
    const r = smart(['-p', '--output-format', 'json', '--bogus']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, exitCode: 2, failure: { kind: 'config' } });
  });

  it('--output-format without -p is a usage error instead of being ignored', () => {
    const r = smart(['--output-format', 'json', 'fix it']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/only apply with -p/);
  });

  it('a missing Claude Code exits 3 with a JSON error document', () => {
    const r = smart(['-p', '--output-format', 'json', 'fix the typo'], { SMART_CLAUDE_BIN: join(tmpdir(), 'no-such-claude-binary') });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).failure.kind).toBe('cli_missing');
    // The hint says how to fix it, including when claude is installed but not on PATH.
    expect(r.err).toMatch(/run `claude` once to log in/);
    expect(r.err).toContain('SMART_CLAUDE_BIN');
  });

  it('--help lists the commands, the environment and the exit codes', () => {
    const r = smart(['--help']);
    expect(r.code).toBe(0);
    for (const s of ['smart init', 'smart trust', 'smart update', 'SMART_CLAUDE_BIN', 'Exit codes']) expect(r.out).toContain(s);
  });

  it('--rate reports config warnings on stderr, keeping stdout for the rating', () => {
    const r = smart(['--rate', 'fix the typo'], {}, { 'smart.config.json': '{"routng":{}}' });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/unknown setting: routng/);
    expect(r.out).toContain('Decision:');
    expect(r.out).not.toContain('routng');
  });

  it('a successful headless task exits 0 and stdout holds only the JSON document', () => {
    const r = smart(['-p', '--output-format', 'json', 'fix the typo in the readme']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ ok: true, exitCode: 0, failure: null });
    expect(r.err).toContain('smart: ');
  });

  it('--resume with nothing to resume exits 6', () => {
    expect(smart(['-p', '--resume']).code).toBe(6);
  });

  it('`smart trust` without a project config fails clearly; a project config is ignored until trusted', () => {
    const t = smart(['trust']);
    expect(t.code).toBe(1);
    expect(t.err).toMatch(/no smart\.config\.json/);
  });

  it('--rate calls no model and explains the decision', () => {
    const r = smart(['--rate', 'fix the race condition in worker.js']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Decision: opus/);
    expect(r.out).toMatch(/No model was called/);
  });

  it('warns about a repository-shipped .claude/settings.json in headless runs', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'smart-cli-'));
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [] } }));
    const home = join(cwd, 'home');
    mkdirSync(home);
    const r = spawnSync(process.execPath, [tsx, cli, '-p', 'fix the typo in the readme'], { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home, USERPROFILE: home, SMART_CLAUDE_BIN: fake, FAKE_DELAY_MS: '1' } });
    expect(r.stderr).toMatch(/warning: This project's Claude Code settings apply.*hooks \(Stop/);
  });
});
