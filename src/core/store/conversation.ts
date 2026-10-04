import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Classification, Complexity, ModelTier, Plan } from '../types.js';
import { quarantineCorrupt, withFileLock, writeFileAtomic } from './atomicFile.js';

export interface TaskMemory {
  prompt: string;
  complexity?: Complexity;
  /** One-line plan summary, when the task was planned. */
  summary?: string;
  outcome: 'done' | 'failed' | 'cancelled' | 'reverted';
  files: string[];
  /** The last thing the model said, trimmed: this is what "the other one" or "that" usually refers to. */
  reply: string;
  at: string;
}

/** An unfinished task (failed or cancelled after planning) that `/resume` can continue. */
export interface PendingTask {
  prompt: string;
  classification: Classification;
  plan: Plan;
  /** Ids of the plan steps that already finished. */
  doneStepIds: string[];
  at: string;
}

/** A task that changed files: the working-tree snapshots before and after it (git tree ids), for /undo and /diff. */
export interface UndoEntry {
  prompt: string;
  start: string;
  end: string;
  /** The repository root and project folder the snapshots were taken in (absent in entries saved by older versions). */
  repo?: string;
  prefix?: string;
}

/**
 * One continuous conversation with Claude Code. `sessionId` is the persisted Claude Code session the
 * coding steps resume; `tasks` is a compact memory for the stateless calls (classifier, planner) and
 * the fallback when the native session is gone.
 */
export interface Conversation {
  id: string;
  sessionId: string | null;
  lastTier?: ModelTier;
  lastCallAt?: number;
  lastCallAtByTier?: Partial<Record<ModelTier, number>>;
  tasks: TaskMemory[];
  pending?: PendingTask;
  /** Tasks that changed files, oldest first (at most 20). */
  undo?: UndoEntry[];
  /** How big the Claude Code session has grown (tokens), as of its last call. */
  contextTokens?: number;
}

export const newConversation = (): Conversation => ({ id: randomUUID(), sessionId: null, tasks: [] });

const MAX_TASKS = 30;
const DETAILED = 5;
const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export function recordTask(conv: Conversation, memory: TaskMemory): void {
  conv.tasks.push({ ...memory, prompt: clip(memory.prompt, 400), reply: clip(memory.reply, 500), files: memory.files.slice(0, 15) });
  if (conv.tasks.length > MAX_TASKS) conv.tasks.splice(0, conv.tasks.length - MAX_TASKS);
}

/**
 * Compact text of what happened so far, newest tasks in detail and older ones as one line each,
 * capped at `maxChars` (oldest dropped first). Empty string for a new conversation.
 */
export function renderMemory(conv: Conversation, maxChars = 3500): string {
  if (conv.tasks.length === 0) return '';
  const lines = conv.tasks.map((t, i) => {
    const detailed = i >= conv.tasks.length - DETAILED;
    const head = `${i + 1}. User: "${clip(t.prompt, detailed ? 300 : 100)}" → ${t.outcome}`;
    if (!detailed) return head;
    const parts = [head];
    if (t.summary) parts.push(`plan: ${clip(t.summary, 160)}`);
    if (t.files.length) parts.push(`files: ${t.files.slice(0, 8).join(', ')}`);
    if (t.reply) parts.push(`you said: "${clip(t.reply, 300)}"`);
    return parts.join('; ');
  });
  let out = lines.join('\n');
  while (out.length > maxChars && lines.length > 1) {
    lines.shift();
    out = lines.join('\n');
  }
  return out.length > maxChars ? out.slice(-maxChars) : out;
}

function validUndo(u: unknown): UndoEntry[] | undefined {
  if (!Array.isArray(u)) return undefined;
  const tree = (t: unknown) => typeof t === 'string' && /^[0-9a-f]{40,64}$/.test(t);
  const ok = u.filter((e): e is UndoEntry => !!e && typeof e.prompt === 'string' && tree(e.start) && tree(e.end)
    && (e.repo === undefined || typeof e.repo === 'string') && (e.prefix === undefined || typeof e.prefix === 'string'));
  return ok.length ? ok : undefined;
}

function validPending(p: unknown): PendingTask | undefined {
  const t = p as Partial<PendingTask> | null | undefined;
  if (!t || typeof t.prompt !== 'string' || !t.plan || !Array.isArray(t.plan.steps) || !t.classification || !Array.isArray(t.doneStepIds)) return undefined;
  return t as PendingTask;
}

interface StoreFile {
  version: 1;
  byDir: Record<string, Conversation & { updatedAt: string }>;
}

/**
 * The key a project directory is stored under. Windows paths are case-insensitive: `C:\Users\Me\app` and `c:\users\me\app`
 * (as a shell may report it on another day) are the same folder and must find the same conversation.
 */
export function dirKey(cwd: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
  return path.win32.resolve(cwd).replace(/[\\/]+$/, '').toLowerCase();
}

/** Remembers the last conversation per project directory so `smart -c` can continue it. */
export class ConversationStore {
  constructor(
    private readonly path: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** The entry for `cwd`: under its key, or (older files) under any spelling of the same folder, the most recent first. */
  private find(byDir: StoreFile['byDir'], cwd: string): StoreFile['byDir'][string] | undefined {
    const key = dirKey(cwd, this.platform);
    return byDir[key] ?? Object.entries(byDir).filter(([k]) => dirKey(k, this.platform) === key).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))[0]?.[1];
  }

  private read(): StoreFile {
    if (!existsSync(this.path)) return { version: 1, byDir: {} };
    try {
      const d = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreFile>;
      return { version: 1, byDir: d.byDir && typeof d.byDir === 'object' ? d.byDir : {} };
    } catch {
      quarantineCorrupt(this.path); // keep it for inspection rather than silently overwriting it on the next save
      return { version: 1, byDir: {} };
    }
  }

  load(cwd: string): Conversation | null {
    const c = this.find(this.read().byDir, cwd);
    if (!c || !Array.isArray(c.tasks)) return null;
    return { id: c.id, sessionId: c.sessionId ?? null, lastTier: c.lastTier, lastCallAt: c.lastCallAt, lastCallAtByTier: c.lastCallAtByTier, tasks: c.tasks, pending: validPending(c.pending), undo: validUndo(c.undo), ...(typeof c.contextTokens === 'number' ? { contextTokens: c.contextTokens } : {}) };
  }

  /** Returns an error message when it could not be saved. */
  save(cwd: string, conv: Conversation, now = new Date()): string | null {
    try {
      withFileLock(this.path, () => {
        const file = this.read();
        const key = dirKey(cwd, this.platform);
        // One entry per folder: other spellings of it (from before keys were normalised) are replaced.
        for (const k of Object.keys(file.byDir)) if (dirKey(k, this.platform) === key) delete file.byDir[k];
        file.byDir[key] = { ...conv, updatedAt: now.toISOString() };
        // Keep the file small: only the 50 most recently used directories.
        const keep = Object.entries(file.byDir).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt)).slice(0, 50);
        file.byDir = Object.fromEntries(keep);
        writeFileAtomic(this.path, JSON.stringify(file, null, 2));
      });
      return null;
    } catch (e) {
      return `Could not save conversation to ${this.path}: ${(e as Error).message}`;
    }
  }
}
