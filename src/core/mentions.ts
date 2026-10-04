import { statSync } from 'node:fs';
import { folderFiles } from './files.js';
import { resolveInside } from './paths.js';
import { gatherFiles, type FileContext } from './runner.js';

const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const count = (s: string, ch: string): number => s.split(ch).length - 1;

/** Drops sentence punctuation after a mention, but keeps brackets that belong to the path (`app/[id]`, `src/(group)`). */
function trimMention(token: string): string {
  let p = token;
  for (;;) {
    const last = p.at(-1) ?? '';
    if (/[,.;:!?'"]/.test(last)) p = p.slice(0, -1);
    else if (last in PAIRS && count(p, last) > count(p, PAIRS[last]!)) p = p.slice(0, -1); // unbalanced closer: "(see @a.ts)"
    else return p;
  }
}

/** `@path` tokens in a prompt. An `@` glued to a word (an email address) is not a mention. */
export function extractMentions(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const p = trimMention(m[1] ?? '');
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** A folder inside the project (a symlink out of it, a path outside, or a network path is not). */
function projectFolder(cwd: string, p: string): string | null {
  const inside = resolveInside(cwd, p, { allowAbsolute: true });
  try {
    return inside && statSync(inside.abs).isDirectory() ? inside.rel : null;
  } catch {
    return null;
  }
}

/**
 * What the user referenced with @path: a file's contents (only real files inside the project, within the byte budget), or
 * for `@folder/` the list of its files, so the model knows what is there and reads what it needs.
 */
export function resolveMentions(cwd: string, prompt: string, maxBytes: number): FileContext[] {
  const paths = extractMentions(prompt);
  if (!paths.length) return [];
  const folders: FileContext[] = [];
  const files: string[] = [];
  for (const p of paths) {
    const folder = projectFolder(cwd, p);
    if (folder === null) {
      files.push(p);
      continue;
    }
    const { files: inside, more } = folderFiles(cwd, folder || '.');
    const name = folder ? `${folder}/` : './';
    folders.push({ path: name, content: `Folder ${name}: ${inside.length}${more ? '+' : ''} file${inside.length === 1 ? '' : 's'}\n${inside.join('\n')}`, truncated: more });
  }
  const used = folders.reduce((n, f) => n + f.content.length, 0);
  // Paths you typed: an absolute path inside the project is fine, and so is a secret file you named on purpose.
  return [...folders, ...gatherFiles(cwd, files, Math.max(0, maxBytes - used), { allowAbsolute: true })];
}
