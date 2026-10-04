import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Where an external program lives, as an absolute path.
 *
 * On Windows, starting a program by bare name (`spawn('git', …, { cwd })`) searches the working directory BEFORE `PATH`
 * (libuv follows cmd.exe here). smart starts git, Claude Code and taskkill with the project as working directory, so a
 * `git.exe` or `claude.exe` committed to a repository you just cloned would run the moment smart opens it. Resolving to an
 * absolute path from the absolute `PATH` entries only closes that: the project directory is never searched.
 * Elsewhere `execvp` does not search the working directory (unless PATH holds an empty or relative entry, which is skipped
 * here too), so a bare name is kept.
 */
export interface WhichOptions {
  platform?: string;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
}

/** Absolute `PATH` entries, in order. Relative ones (`.`, `bin`, an empty entry) would mean "the working directory". */
export function pathDirs(o: WhichOptions = {}): string[] {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const raw = env.PATH ?? env.Path ?? '';
  return raw
    .split(p.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1')) // Windows allows quoted entries
    .filter((d) => d && p.isAbsolute(d) && !(platform === 'win32' && /^[\\/](?![\\/])/.test(d))); // `\foo` is drive-relative
}

/**
 * The absolute path of `name` found in `PATH` (Windows: `name.exe`, then `name.com`), or null. A name that already holds a
 * path is returned unchanged when it exists.
 */
export function findExecutable(name: string, o: WhichOptions = {}): string | null {
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? existsSync;
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (name.includes('/') || (platform === 'win32' && name.includes('\\'))) return exists(name) ? name : null;
  const names = platform === 'win32' && !/\.(exe|com)$/i.test(name) ? [`${name}.exe`, `${name}.com`] : [name];
  for (const dir of pathDirs(o)) {
    for (const n of names) {
      const full = p.join(dir, n);
      if (exists(full)) return full;
    }
  }
  return null;
}

const cache = new Map<string, string | null>();

/**
 * What to pass to spawn for `name`: on Windows its absolute path (null when it is not installed: callers then treat the
 * program as missing instead of letting Windows look in the project folder); elsewhere the bare name.
 * Remembered while PATH is unchanged.
 */
export function programPath(name: string, o: WhichOptions = {}): string | null {
  const platform = o.platform ?? process.platform;
  if (platform !== 'win32') return name;
  const env = o.env ?? process.env;
  const key = `${name}\0${env.PATH ?? env.Path ?? ''}`;
  if (!o.exists && cache.has(key)) return cache.get(key)!;
  const found = findExecutable(name, o);
  if (!o.exists) cache.set(key, found);
  return found;
}

/** Windows' own taskkill, by absolute path (never one found in the project folder). */
export function taskkillPath(env: Record<string, string | undefined> = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', 'taskkill.exe');
}
