import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Path checks for anything that names a file smart reads, lists or removes: @mentions you type, files a plan step names (model
 * output), files Claude Code reports, and paths from persisted state. Two layers:
 *
 *  1. `unsafePathReason` looks at the text only, before the filesystem is touched. It matters on Windows, where merely asking
 *     whether `\\server\share\x` exists opens a network connection (and can hand over your login hash), and where `CON` or
 *     `C:x` do not mean what they look like.
 *  2. `resolveInside` then resolves symlinks and junctions and checks the real path is still inside the project's real path
 *     (case-insensitively on Windows), so a link that points out of the project is caught as well.
 */

export interface PathOptions {
  platform?: string;
  /** Allow an absolute path (it must still resolve inside the root). For paths you typed; never for model output. */
  allowAbsolute?: boolean;
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$) *(\..*)?$/i;

/** Why `p` is refused before touching the filesystem, or null when it is a plain path. */
export function unsafePathReason(p: string, o: PathOptions = {}): string | null {
  const win = (o.platform ?? process.platform) === 'win32';
  if (!p || !p.trim()) return 'empty path';
  if (p.includes('\0')) return 'contains a NUL character';
  if ([...p].some((c) => c.charCodeAt(0) < 0x20)) return 'contains control characters';
  if (win || /^[\\/]{2}/.test(p)) {
    // UNC (\\server\share), device (\\?\, \\.\) and their forward-slash spellings: a network or device path, never a project file.
    if (/^[\\/]{2}/.test(p)) return 'a network or device path';
  }
  if (win) {
    if (/^[A-Za-z]:(?![\\/])/.test(p)) return 'a drive-relative path';
    const segments = p.split(/[\\/]+/);
    for (const [i, seg] of segments.entries()) {
      if (RESERVED.test(seg.replace(/[ .]+$/, ''))) return `a reserved device name (${seg})`;
      if (seg.includes(':') && !(i === 0 && /^[A-Za-z]:$/.test(seg))) return 'contains ":" (an alternate data stream)';
    }
  }
  const abs = win ? path.win32.isAbsolute(p) : path.posix.isAbsolute(p);
  if (abs && !o.allowAbsolute) return 'an absolute path';
  if (!abs && p.split(win ? /[\\/]+/ : /\/+/).includes('..')) return 'leaves the project (..)';
  return null;
}

/** The real path of `p`, or of its nearest existing parent joined with the rest (for a file that does not exist yet). */
export function realPathOf(p: string): string {
  const missing: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...missing.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Whether `rel` (from path.relative) stays inside its base. */
export const insideRel = (rel: string): boolean => rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);

/**
 * `p` resolved against `root`, only when it is a plain path and its real location (links resolved) is inside `root`'s real
 * location. Returns the absolute real path and the project-relative path (posix separators), or null.
 */
export function resolveInside(root: string, p: string, o: PathOptions = {}): { abs: string; rel: string } | null {
  if (unsafePathReason(p, o)) return null;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  const real = realPathOf(path.resolve(root, p));
  const rel = path.relative(realRoot, real);
  if (!insideRel(rel)) return null;
  return { abs: real, rel: rel.split(path.sep).join('/') };
}

/**
 * Files that usually hold secrets. smart does not paste them into a prompt on its own initiative (a plan step that names
 * `.env`, a reviewer looking at what changed); a file you @mention yourself is still used.
 */
const SECRET = /^(\.env(\..*)?|\.npmrc|\.netrc|_netrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore|kdbx))$/i;
export const looksSecret = (file: string): boolean => {
  const name = file.split(/[\\/]/).pop() ?? file;
  return SECRET.test(name) && !/\.(example|sample|template)$/i.test(name);
};
