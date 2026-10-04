import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { programPath } from './which.js';

/** git by absolute path on Windows (see which.ts); throws when it is not installed, so callers fall back to a walk. */
const gitBin = (): string => {
  const bin = programPath('git');
  if (!bin) throw new Error('git not found');
  return bin;
};

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.venv', '__pycache__', 'target']);

/** Compact list of project files (tracked + untracked-not-ignored via git, else a shallow walk). */
export function projectFiles(cwd: string, limit = 80): string[] {
  try {
    const out = execFileSync(gitBin(), ['-c', 'core.quotepath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    // Filter lazily and stop at `limit`: a repo with 100k files must not cost 100k stat calls, and node_modules or dist must not crowd out sources.
    const files: string[] = [];
    for (const f of out.split('\0')) {
      if (files.length >= limit) break;
      if (!f || f.split('/').some((part) => SKIP.has(part)) || !existsSync(join(cwd, f))) continue;
      files.push(f);
    }
    return files;
  } catch {
    return walk(cwd, '', 3, limit);
  }
}

function walk(root: string, rel: string, depth: number, limit: number): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= limit) break;
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (depth > 0) out.push(...walk(root, path, depth - 1, limit - out.length));
    } else out.push(path);
  }
  return out.slice(0, limit);
}

/**
 * The files in one folder of the project (git's view: tracked plus untracked-not-ignored; else a walk), relative to `cwd`,
 * for an `@folder/` mention. Stops at `limit`.
 */
export function folderFiles(cwd: string, folder: string, limit = 150): { files: string[]; more: boolean } {
  const rel = folder.replace(/[\\/]+$/, '');
  let all: string[];
  try {
    const out = execFileSync(gitBin(), ['-c', 'core.quotepath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', rel], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    all = out.split('\0').filter((f) => f && !f.split('/').some((part) => SKIP.has(part)));
  } catch {
    all = walk(cwd, rel.replace(/\\/g, '/'), 4, limit + 1);
  }
  return { files: all.slice(0, limit), more: all.length > limit };
}

/** Every folder that holds one of `files`, as `dir/`, for @ completion. */
export function foldersOf(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  return [...dirs];
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n[truncated]` : s);

/**
 * What a planner should know about the project that a file list does not say: the project's own
 * instructions (CLAUDE.md / AGENTS.md) and what `package.json` says about scripts and dependencies.
 */
export function projectContext(cwd: string, maxChars = 3500): string {
  const parts: string[] = [];
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const p = join(cwd, name);
    try {
      if (existsSync(p)) parts.push(`${name}:\n${clip(readFileSync(p, 'utf8').trim(), 2200)}`);
    } catch {
      /* unreadable: skip */
    }
  }
  try {
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; type?: string; scripts?: Record<string, string>; dependencies?: object; devDependencies?: object };
      const bits = [`package.json: name=${pkg.name ?? '?'}${pkg.type ? `, type=${pkg.type}` : ''}`];
      if (pkg.scripts) bits.push(`scripts: ${Object.keys(pkg.scripts).join(', ')}`);
      const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
      if (deps.length) bits.push(`dependencies: ${deps.slice(0, 25).join(', ')}${deps.length > 25 ? ', …' : ''}`);
      parts.push(bits.join('\n'));
    }
  } catch {
    /* malformed package.json: skip */
  }
  return clip(parts.join('\n\n'), maxChars);
}
