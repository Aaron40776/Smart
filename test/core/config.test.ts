import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig } from '../../src/core/config.js';
import { SmartError } from '../../src/core/errors.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'smart-cfg-'));

describe('config', () => {
  it('has sensible defaults', () => {
    const c = defaultConfig();
    expect(c.routing.trivial).toBe('haiku');
    expect(c.routing.planner).toBe('opus');
    // Safe by default: edits only; commands need your own Claude Code permission rules or an explicit bypassPermissions.
    expect(c.runner.permissionMode).toBe('acceptEdits');
    expect(c.escalation.ladder).toEqual(['haiku', 'sonnet', 'opus']);
  });

  it('merges a partial file over defaults', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'smart.config.json'), JSON.stringify({ routing: { trivial: 'sonnet' }, models: { haiku: 'h', sonnet: 's', opus: 'o' } }));
    const { config, source } = loadConfig(dir);
    expect(source).toBe(join(dir, 'smart.config.json'));
    expect(config.routing.trivial).toBe('sonnet');
    expect(config.routing.multi_file).toBe('sonnet');
    expect(config.models.opus).toBe('o');
  });

  it('rejects invalid JSON and invalid values with a config error', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'smart.config.json'), '{nope');
    expect(() => loadConfig(dir)).toThrow(SmartError);
    writeFileSync(join(dir, 'smart.config.json'), JSON.stringify({ routing: { trivial: 'gpt' } }));
    expect(() => loadConfig(dir)).toThrow(/routing\.trivial/);
  });

  it('errors when an explicit path is missing', () => {
    expect(() => loadConfig(tmp(), 'nope.json')).toThrow(/not found/);
  });
});

describe('config keyword rules', () => {
  it('rejects an invalid regular expression', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smart-cfg-'));
    writeFileSync(join(dir, 'smart.config.json'), JSON.stringify({ routing: { keywordRules: [{ match: '(', tier: 'opus' }] } }));
    expect(() => loadConfig(dir)).toThrow(/invalid regular expression/);
  });
});
