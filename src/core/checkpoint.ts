import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { insideRel, unsafePathReason } from './paths.js';
import { programPath } from './which.js';

export interface FileChange {
  path: string;
  /** Added, Modified or Deleted, relative to the earlier snapshot. */
  status: 'A' | 'M' | 'D';
}

export interface Changes {
  files: FileChange[];
  insertions: number;
  deletions: number;
}

/**
 * Snapshots of the working tree, used to see what a step changed and to undo a task.
 * Every method degrades to null instead of throwing: checkpoints are a convenience, never a blocker.
 */
export interface Checkpointer {
  /** False when the directory is not a git repository (or git is missing). */
  readonly available: boolean;
  /** Absolute path of the repository root (git paths are relative to it). */
  readonly root: string;
  /**
   * Where the project directory sits inside the repository, as a posix path relative to the root ('' at the top).
   * Use this, not path arithmetic between `root` and the project directory: on Windows the two can be spelled
   * differently (8.3 short names, casing, junctions) and a computed relative path comes out wrong.
   */
  readonly prefix: string;
  snapshot(): Promise<string | null>;
  changes(from: string, to: string): Promise<Changes | null>;
  diff(from: string, to: string): Promise<string | null>;
  /**
   * Make the working tree match `target` again (only files that differ from `current` are touched).
   * With `only`, just those repo-relative paths: the files one task changed, not every edit since.
   * `failed` lists files it could not put back (a file that is locked, a folder that now links out of the project).
   * Null when nothing could be done; files may still have been written if git failed part-way.
   */
  restore(target: string, current: string, only?: string[]): Promise<RestoreResult | null>;
  dispose(): void;
}

export interface RestoreResult {
  restored: number;
  removed: number;
  failed: string[];
}

interface GitResult {
  code: number;
  stdout: string;
}

const TIMEOUT_MS = 60_000;

function git(args: string[], opts: { cwd: string; env?: Record<string, string>; input?: string; timeoutMs?: number }): Promise<GitResult> {
  return new Promise((resolve) => {
    // An absolute path on Windows, so a git.exe inside the project is never the one that runs (see which.ts).
    const bin = programPath('git');
    if (!bin) return resolve({ code: 127, stdout: '' });
    const child = execFile(
      bin,
      args,
      { cwd: opts.cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...opts.env }, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? TIMEOUT_MS, encoding: 'utf8', windowsHide: true },
      (err, stdout) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: stdout ?? '' });
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input ?? '');
  });
}

/**
 * Checkpoints as git tree objects built from a private temporary index, so the user's index, branches and
 * history are never touched (the only trace is a few unreferenced objects that `git gc` cleans up).
 */
export class GitCheckpoints implements Checkpointer {
  available = false;
  root = '';
  prefix = '';
  private gitDir = '';
  private tmp = '';
  private cacheIndex = '';
  private seeded = false;

  constructor(private readonly cwd: string) {}

  /** Detect the repository. Call once before use; resolves to `available`. */
  async init(): Promise<boolean> {
    const top = await git(['rev-parse', '--show-toplevel'], { cwd: this.cwd, timeoutMs: 10_000 });
    if (top.code !== 0 || !top.stdout.trim()) return false;
    const dir = await git(['rev-parse', '--absolute-git-dir'], { cwd: this.cwd, timeoutMs: 10_000 });
    if (dir.code !== 0) return false;
    this.root = top.stdout.trim();
    this.gitDir = dir.stdout.trim();
    const pre = await git(['rev-parse', '--show-prefix'], { cwd: this.cwd, timeoutMs: 10_000 });
    this.prefix = pre.code === 0 ? pre.stdout.trim().replace(/\/+$/, '') : '';
    try {
      this.tmp = mkdtempSync(join(tmpdir(), 'smart-ckpt-'));
    } catch {
      return false;
    }
    this.cacheIndex = join(this.tmp, 'index');
    this.available = true;
    return true;
  }

  async snapshot(): Promise<string | null> {
    if (!this.available) return null;
    // Seed the private index from the real one once, so unchanged files are recognised by stat and not re-hashed.
    if (!this.seeded) {
      this.seeded = true;
      const real = join(this.gitDir, 'index');
      try {
        // assume-unchanged / skip-worktree entries would keep stale content in a seeded index, so then start empty.
        const flags = await git(['ls-files', '-v'], { cwd: this.root, timeoutMs: 15_000 });
        const stale = flags.code === 0 && /^[hsS] /m.test(flags.stdout);
        if (!stale && existsSync(real)) copyFileSync(real, this.cacheIndex);
      } catch {
        /* start from an empty index */
      }
    }
    const env = { GIT_INDEX_FILE: this.cacheIndex };
    // Only the project directory: a monorepo sibling the user edits elsewhere must not show up in (or be restored by) /undo.
    // The untracked-file cache lives in our private index: later snapshots skip re-scanning unchanged folders.
    const add = await git(['-c', 'core.untrackedCache=true', 'add', '-A', '--', this.prefix || '.'], { cwd: this.root, env });
    if (add.code !== 0) return null;
    const tree = await git(['write-tree'], { cwd: this.root, env });
    return tree.code === 0 && /^[0-9a-f]{40,64}$/.test(tree.stdout.trim()) ? tree.stdout.trim() : null;
  }

  async changes(from: string, to: string): Promise<Changes | null> {
    if (!this.available) return null;
    const scope = this.prefix ? ['--', this.prefix] : [];
    const names = await git(['diff-tree', '-r', '--no-renames', '--name-status', '-z', from, to, ...scope], { cwd: this.root });
    if (names.code !== 0) return null;
    const files: FileChange[] = [];
    const parts = names.stdout.split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i];
      const path = parts[i + 1];
      // T (file <-> symlink type change) is restored like a modification.
      if (path && (status === 'A' || status === 'M' || status === 'D' || status === 'T')) files.push({ path, status: status === 'T' ? 'M' : status });
    }
    const stat = await git(['diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--numstat', from, to, ...scope], { cwd: this.root });
    let insertions = 0;
    let deletions = 0;
    if (stat.code === 0) {
      for (const line of stat.stdout.split('\n')) {
        const m = /^(\d+)\t(\d+)\t/.exec(line); // binary files show "-"
        if (m) {
          insertions += Number(m[1]);
          deletions += Number(m[2]);
        }
      }
    }
    return { files, insertions, deletions };
  }

  async diff(from: string, to: string): Promise<string | null> {
    if (!this.available) return null;
    // Plain unified diff whatever the user's git config says (an external difftool or textconv driver would break the output).
    const r = await git(['diff', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', from, to, ...(this.prefix ? ['--', this.prefix] : [])], { cwd: this.root });
    return r.code === 0 ? r.stdout : null;
  }

  async restore(target: string, current: string, only?: string[]): Promise<RestoreResult | null> {
    if (!this.available) return null;
    const ch = await this.changes(target, current);
    if (!ch) return null;
    const scope = only ? new Set(only) : null;
    // Never outside the project directory, whatever a (persisted) list says.
    const files = (scope ? ch.files.filter((f) => scope.has(f.path)) : ch.files).filter((f) => this.inScope(f.path));
    const toWrite = files.filter((f) => f.status !== 'A').map((f) => f.path); // in target, changed or deleted since
    const toRemove = files.filter((f) => f.status === 'A').map((f) => f.path); // created since the target
    let restored = 0;
    if (toWrite.length > 0) {
      const idx = join(this.tmp, 'restore-index');
      const env = { GIT_INDEX_FILE: idx };
      // git writes these files itself: it refuses paths outside the work tree and replaces a folder that became a link
      // with a real folder instead of writing through it.
      const read = await git(['read-tree', target], { cwd: this.root, env });
      if (read.code !== 0) return null;
      const out = await git(['checkout-index', '-f', '-z', '--stdin'], { cwd: this.root, env, input: toWrite.join('\0') + '\0' });
      rmSync(idx, { force: true });
      if (out.code !== 0) return null;
      restored = toWrite.length;
    }
    let removed = 0;
    const failed: string[] = [];
    for (const rel of toRemove) {
      const file = this.removable(rel);
      if (!file) {
        failed.push(rel);
        continue;
      }
      try {
        unlinkSync(file);
        removed += 1;
        this.pruneEmptyDirs(rel);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') failed.push(rel); // ENOENT: already gone, which is the goal
      }
    }
    return { restored, removed, failed };
  }

  /** Whether a repo-relative path lies in the project directory smart runs in (the whole repository at the top). */
  private inScope(rel: string): boolean {
    return !this.prefix || rel.startsWith(`${this.prefix}/`);
  }

  /**
   * Where to delete `rel` (a file a task created): only when its folder's real location is inside the repository. A folder
   * that was replaced by a symlink or junction pointing elsewhere would otherwise make smart delete a file outside it.
   * The file itself may be a link: unlinking removes the link, never its target.
   */
  private removable(rel: string): string | null {
    if (unsafePathReason(rel, { platform: 'linux' }) || !this.inScope(rel)) return null; // git paths always use '/'
    try {
      const root = realpathSync(this.root);
      const parts = rel.split('/');
      const folder = realpathSync(join(this.root, ...parts.slice(0, -1)));
      if (folder !== root && !insideRel(path.relative(root, folder))) return null;
      return join(folder, parts.at(-1)!);
    } catch {
      return null; // the folder is gone, so the file is too
    }
  }

  /** Remove now-empty parent folders of `rel`, innermost first, never the project directory itself or anything above it. */
  private pruneEmptyDirs(rel: string): void {
    const parts = rel.split('/').slice(0, -1);
    const stop = this.prefix ? this.prefix.split('/').length : 0;
    for (let n = parts.length; n > stop; n--) {
      const dir = join(this.root, ...parts.slice(0, n));
      try {
        // Only a real, empty folder: never a link (removing a junction is fine, but its target must not be emptied).
        if (lstatSync(dir).isSymbolicLink() || readdirSync(dir).length > 0) return;
        rmdirSync(dir);
      } catch {
        return;
      }
    }
  }

  dispose(): void {
    if (this.tmp) rmSync(this.tmp, { recursive: true, force: true });
    this.available = false;
  }
}

/** For directories that are not git repositories, or in tests. */
export class NoCheckpoints implements Checkpointer {
  readonly available = false;
  readonly root = '';
  readonly prefix = '';
  snapshot = async () => null;
  changes = async () => null;
  diff = async () => null;
  restore = async () => null;
  dispose(): void {}
}

/** Create a checkpointer for `cwd`: git-backed when possible, otherwise a no-op. */
export async function createCheckpoints(cwd: string): Promise<Checkpointer> {
  const g = new GitCheckpoints(cwd);
  return (await g.init()) ? g : new NoCheckpoints();
}

