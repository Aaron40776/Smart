import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { COMMANDS, HELP_TEXT } from '../src/ui/commands.js';

/**
 * Drift guards: the docs, the example config, the help text and the CLI flags are all written by hand, and they
 * quietly fall out of date. These tests fail the moment one of them stops matching the code.
 */
const root = new URL('../', import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, root), 'utf8');
const docs = { 'README.md': read('README.md'), 'ROUTING.md': read('ROUTING.md'), 'CONTRIBUTING.md': read('CONTRIBUTING.md') };

/** `section.key` for every setting two levels deep (`routing.planner`), plus one-level keys (`trackerPath`). */
function settingKeys(obj: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) for (const sub of Object.keys(v)) out.add(`${k}.${sub}`);
    else out.add(k);
  }
  return out;
}
const schemaKeys = settingKeys(defaultConfig() as unknown as Record<string, unknown>);

describe('smart.config.example.json', () => {
  const example = JSON.parse(read('smart.config.example.json')) as Record<string, unknown>;
  const exampleKeys = settingKeys(example);

  it('mentions every setting the program has (and `smart init` copies it)', () => {
    // effort is an optional map, so it is `{}` here and counts as one key
    const missing = [...schemaKeys].filter((k) => !exampleKeys.has(k) && !exampleKeys.has(k.split('.')[0]!));
    expect(missing).toEqual([]);
  });

  it('has no setting the program does not know', () => {
    const unknown = [...exampleKeys].filter((k) => !schemaKeys.has(k));
    expect(unknown).toEqual([]);
  });

  it('holds the default values, so copying it changes nothing', () => {
    const defaults = defaultConfig() as unknown as Record<string, Record<string, unknown>>;
    const differing: string[] = [];
    for (const [section, value] of Object.entries(example)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) if (JSON.stringify(defaults[section]?.[k]) !== JSON.stringify(v)) differing.push(`${section}.${k}`);
      } else if (JSON.stringify(defaults[section]) !== JSON.stringify(value)) differing.push(section);
    }
    expect(differing).toEqual([]);
  });
});

describe('documentation', () => {
  it('only mentions settings that exist (routing.planner, limits.maxPlanSteps, ...)', () => {
    const sections = ['models', 'routing', 'escalation', 'limits', 'session', 'runner', 'usage', 'review', 'verify'];
    const re = new RegExp(`\\b(${sections.join('|')})\\.([A-Za-z_]+)`, 'g');
    const bad: string[] = [];
    for (const [file, text] of Object.entries(docs)) {
      for (const m of text.matchAll(re)) {
        const key = `${m[1]}.${m[2]}`;
        // `models.haiku` and `escalation.ladder` style keys are in the schema; file names like `review.ts` are not settings
        if (!schemaKeys.has(key) && !/\.(ts|tsx|js|json|md)$/.test(m[0]) && !existsFile(`src/core/${m[1]}.${m[2]}`)) bad.push(`${file}: ${key}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('only names files that exist', () => {
    const bad: string[] = [];
    for (const [file, text] of Object.entries(docs)) {
      const paths = new Set<string>();
      for (const m of text.matchAll(/`((?:src|test|\.github)\/[A-Za-z0-9_./-]+|[A-Za-z_.-]+\.(?:md|json|yml))`/g)) paths.add(m[1]!);
      for (const p of paths) {
        if (/[*]/.test(p) || p.endsWith('/')) continue; // globs and directories are checked below
        if (!existsFile(p)) bad.push(`${file}: ${p}`);
      }
      for (const m of text.matchAll(/`((?:src|test)\/[A-Za-z0-9_./-]*\/)`/g)) if (!existsFile(m[1]!)) bad.push(`${file}: ${m[1]}`);
    }
    // smart.config.json / history.json are files the program creates for the user, not part of the repository
    expect(bad.filter((b) => !/smart\.config\.json|history\.json|conversations\.json|limits\.json|debug\.log/.test(b))).toEqual([]);
  });

  it('CONTRIBUTING lists only modules that exist', () => {
    const block = docs['CONTRIBUTING.md'].split('## Layout')[1]!.split('```')[1]!;
    const bad: string[] = [];
    let dir = '';
    for (const line of block.split('\n')) {
      const head = /^(src\/[a-z/]+?)\/?\s{2,}(.*)$/.exec(line);
      if (head) dir = head[1]!;
      const body = head ? head[2]! : /^\s{10,}(.*)$/.exec(line)?.[1];
      if (!body || !dir.startsWith('src/core')) continue;
      const list = body.includes(':') ? body.split(':').slice(1).join(':') : body;
      for (const item of list.replace(/\([^)]*\)/g, '').split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!/^[A-Za-z]+$/.test(item)) continue;
        if (!existsFile(`${dir}/${item}.ts`)) bad.push(`${dir}/${item}.ts`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('commands and flags', () => {
  it('every slash command is in /help and in the README', () => {
    const missingHelp = COMMANDS.map((c) => c.name).filter((n) => !HELP_TEXT.includes(n));
    const missingReadme = COMMANDS.map((c) => c.name).filter((n) => !docs['README.md'].includes(n));
    expect({ missingHelp, missingReadme }).toEqual({ missingHelp: [], missingReadme: [] });
  });

  it('every command-line flag is in the README', () => {
    const src = read('src/cli.tsx');
    const flags = [...src.matchAll(/\.option\('([^']+)'/g)].flatMap((m) => [...m[1]!.matchAll(/--[a-z][a-z-]*/g)].map((f) => f[0]));
    expect(flags.length).toBeGreaterThan(8);
    const missing = flags.filter((f) => !docs['README.md'].includes(f));
    expect(missing).toEqual([]);
  });

  it('the README says how to install and which Node version is needed', () => {
    expect(docs['README.md']).toContain('npm run build');
    expect(docs['README.md']).toMatch(/Node\.js 22/);
    expect(JSON.parse(read('package.json')).engines.node).toBe('>=22');
  });
});

function existsFile(p: string): boolean {
  return existsSync(new URL(p, root));
}
