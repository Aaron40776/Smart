import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** The lock could not be taken: the protected operation did not run. */
export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

/**
 * Whether a failed `mkdir` of the lock means "someone holds it, try again". On Windows, creating a directory that another
 * process has just deleted (or is deleting) fails with EPERM/EACCES/EBUSY instead of EEXIST; treating that as "no lock
 * possible" let two sessions run unlocked and lose an update.
 */
export function lockBusy(code: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  return code === 'EEXIST' || (platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'));
}

/** Who holds a lock: written into the lock folder right after it is created. */
interface Owner {
  pid: number;
  host: string;
  token: string;
  at: number;
}

export interface LockOptions {
  /** How long to wait for another process to finish (default 5 s; each holder needs milliseconds). */
  waitMs?: number;
  /** A lock older than this is abandoned whoever holds it (default 30 s; nothing holds one for more than a moment). */
  staleMs?: number;
  /** Whether a process id is running here (injectable for tests). */
  alive?: (pid: number) => boolean;
}

const OWNER = 'owner.json';

function readOwner(lock: string): Owner | null {
  try {
    const o = JSON.parse(readFileSync(join(lock, OWNER), 'utf8')) as Partial<Owner>;
    return typeof o.token === 'string' && typeof o.pid === 'number' && typeof o.at === 'number' ? (o as Owner) : null;
  } catch {
    return null;
  }
}

/** `process.kill(pid, 0)` asks without signalling: ESRCH means no such process; EPERM means it exists (not ours). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The identity of a lock folder judged abandoned, or null when it is not. Abandoned means: its owner on this machine is no
 * longer running, or it is older than `staleMs` (also when it never got an owner file: an older smart, or a crash right after
 * creating it). A pid that is running may be a reused one, so a live-looking owner is only overruled by age.
 */
function staleIdentity(lock: string, o: Required<Pick<LockOptions, 'staleMs' | 'alive'>>): { ino: number; mtimeMs: number; token?: string } | null {
  const st = statSync(lock); // ENOENT: it was just released; the caller tries again
  const owner = readOwner(lock);
  const age = Date.now() - (owner?.at ?? st.mtimeMs);
  const dead = owner !== null && owner.host === hostname() && owner.pid !== process.pid && !o.alive(owner.pid);
  return dead || age > o.staleMs ? { ino: st.ino, mtimeMs: st.mtimeMs, token: owner?.token } : null;
}

/**
 * Removes an abandoned lock without ever removing a live one: the folder is first renamed (atomic, so of several processes
 * that judged it stale only one succeeds), then checked to be the very folder that was judged stale. If a fresh lock had
 * replaced it in between, it is put back. (If a third process created a new lock in that instant, the put-back fails and the
 * moved holder loses its lock; that needs three contending processes within microseconds of a stale lock.)
 */
function removeStale(lock: string, judged: { ino: number; mtimeMs: number; token?: string }): void {
  const grave = `${lock}.stale-${randomUUID()}`;
  try {
    renameSync(lock, grave);
  } catch {
    return; // someone else removed or replaced it first
  }
  let same: boolean;
  try {
    const st = statSync(grave);
    same = st.ino === judged.ino && st.mtimeMs === judged.mtimeMs && readOwner(grave)?.token === judged.token;
  } catch {
    same = false;
  }
  if (!same) {
    try {
      renameSync(grave, lock);
      return;
    } catch {
      /* the name was taken meanwhile: fall through and clean up */
    }
  }
  rmSync(grave, { recursive: true, force: true });
}

/**
 * Takes the lock folder next to `file`, so two smart sessions doing read-modify-write on the same JSON file (history,
 * conversations, prompt history, trust) never overwrite each other's update. `mkdir` is atomic on every platform.
 * Waits up to `waitMs` for another holder, abandons a stale lock (see staleIdentity), and otherwise throws LockError:
 * the caller's update does not happen, rather than happening unprotected. Returns the release function.
 */
export function acquireLock(file: string, opts: LockOptions = {}): () => void {
  const waitMs = opts.waitMs ?? 5000;
  const stale = { staleMs: opts.staleMs ?? 30_000, alive: opts.alive ?? pidAlive };
  const lock = `${file}.lock`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new LockError(`Cannot lock ${file}: ${(e as Error).message}`);
  }
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      try {
        writeFileSync(join(lock, OWNER), JSON.stringify({ pid: process.pid, host: hostname(), token, at: Date.now() } satisfies Owner), { mode: 0o600 });
      } catch {
        /* an owner-less lock still excludes others; it is judged by its age */
      }
      return () => releaseLock(lock, token);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!lockBusy(code)) throw new LockError(`Cannot lock ${file}: ${(e as Error).message}`);
    }
    try {
      const judged = staleIdentity(lock, stale);
      if (judged) {
        removeStale(lock, judged);
        continue;
      }
    } catch {
      continue; // released in the meantime: try again at once
    }
    if (Date.now() >= deadline) {
      throw new LockError(`${file} is in use by another smart process (lock: ${lock}). Try again; if no other smart is running, delete that folder.`);
    }
    sleep(Math.min(100, 10 + attempt * 5) + Math.floor(Math.random() * 10));
  }
}

function releaseLock(lock: string, token: string): void {
  const owner = readOwner(lock);
  // Taken over as stale meanwhile (a holder paused for longer than staleMs): it is someone else's now.
  if (owner && owner.token !== token) return;
  // On Windows a just-created directory can be briefly busy (antivirus, indexer): retry, or every other session waits out the timeout.
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(join(lock, OWNER), { force: true });
      rmdirSync(lock);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      sleep(10);
    }
  }
}

/**
 * Runs `fn` while holding the lock for `file` (see acquireLock). Throws LockError without running `fn` when the lock cannot
 * be taken: a protected read-modify-write never runs unprotected.
 */
export function withFileLock<T>(file: string, fn: () => T, opts?: LockOptions): T {
  const release = acquireLock(file, opts);
  try {
    return fn();
  } finally {
    release();
  }
}

/** On Windows a rename onto a file that is open elsewhere (antivirus, an editor, another reader) fails briefly. */
function renameRetrying(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || i >= 20 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw e;
      sleep(25);
    }
  }
}

/**
 * Writes `text` so a reader never sees half a file and a crash never leaves a truncated one: a uniquely named temp file (two
 * smart sessions must not share one), flushed to disk, then renamed over the target. Owner-only permissions, since history
 * and conversations contain your prompts. The temp file is removed if anything fails.
 */
export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameRetrying(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Moves an unreadable file aside (`file.corrupt-<time>`) instead of overwriting it on the next save. Never throws. */
export function quarantineCorrupt(file: string): void {
  try {
    renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    /* nothing more to do */
  }
}
