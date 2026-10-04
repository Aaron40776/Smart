import { readFileSync, statSync } from 'node:fs';
import type { Classification, Usage } from '../types.js';
import { emptyUsage } from '../types.js';
import { quarantineCorrupt, withFileLock, writeFileAtomic } from './atomicFile.js';
import { isUsage, newerFormat, readVersioned, type Migration } from './schema.js';

export type StepOutcome = 'done' | 'failed' | 'cancelled' | 'skipped';

/**
 * Why a step that did not finish stopped (see pipeline/outcome.ts): learning treats them differently, since a broken test
 * environment or an exhausted budget says nothing about how well a model did the work.
 */
export type FailureKind = 'model' | 'verify' | 'review' | 'timeout' | 'environment' | 'budget' | 'limit' | 'cancelled';

export interface StepRecord {
  stepId: string;
  title: string;
  /** Model name of the final attempt, as passed to Claude Code. */
  model: string;
  tier: string;
  attempts: number;
  escalated: boolean;
  usage: Usage;
  outcome: StepOutcome;
  /** What the rater chose at the start of the step; the learning rule compares it with how the step went. */
  rated?: { tier: string; effort?: string; score: number };
  /** For a step that did not finish: why (absent in records from before 0.4). */
  failure?: FailureKind;
}

export interface TaskRecord {
  id: string;
  startedAt: string;
  prompt: string;
  classification?: Classification;
  /** Cost of the classify + plan calls. */
  overhead: Usage;
  steps: StepRecord[];
  totals: Usage;
  ok: boolean;
  /** Your verdict with /good or /bad: whether the result was right, beyond passing its checks. */
  feedback?: 'good' | 'bad';
  /** Which project the task ran in (a hash of the folder, see learn.ts); absent in records from before 0.4. */
  project?: string;
}

export const HISTORY_VERSION = 1;
/** history.json has only ever been version 1 (see schema.ts). */
const MIGRATIONS: Record<number, Migration> = {};

const MAX_TASKS = 1000;
const MAX_PROMPT = 500;

const isStep = (s: unknown): s is StepRecord => {
  const x = s as Partial<StepRecord> | null;
  return !!x && typeof x.stepId === 'string' && typeof x.model === 'string' && typeof x.tier === 'string' && typeof x.attempts === 'number'
    && typeof x.outcome === 'string' && isUsage(x.usage);
};

/** A stored task usable by stats, learning and estimates; anything else (a hand-edited or half-written record) is skipped. */
export function validTask(t: unknown): TaskRecord | null {
  const x = t as Partial<TaskRecord> | null;
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || typeof x.startedAt !== 'string' || !Array.isArray(x.steps) || !isUsage(x.totals)) return null;
  return {
    ...(x as TaskRecord),
    prompt: typeof x.prompt === 'string' ? x.prompt : '',
    ok: x.ok === true,
    overhead: isUsage(x.overhead) ? x.overhead! : emptyUsage(),
    steps: x.steps.filter(isStep).map((s) => ({ ...s, title: typeof s.title === 'string' ? s.title : '', escalated: s.escalated === true })),
  };
}

interface Parsed {
  /** Every stored record, valid or not: a save keeps the ones this version cannot use. */
  raw: unknown[];
  tasks: TaskRecord[];
  /** Set when a newer smart wrote the file: it is read, never written. */
  newer?: number;
}

/** Append-only task log in a single local JSON file. Never throws into the pipeline. */
export class Tracker {
  /** The last parse, reused while the file is unchanged: it is read at the start of every task, for /cost and for /stats. */
  private cache: { stamp: string; parsed: Parsed } | null = null;

  constructor(private readonly path: string) {}

  private parse(): Parsed {
    let stamp: string;
    try {
      const st = statSync(this.path);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return { raw: [], tasks: [] };
    }
    if (this.cache?.stamp === stamp) return this.cache.parsed;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      quarantineCorrupt(this.path); // keep it for inspection and start fresh rather than crash
      return { raw: [], tasks: [] };
    }
    const v = readVersioned(json, HISTORY_VERSION, MIGRATIONS);
    if (v.status === 'invalid' || !Array.isArray(v.data.tasks)) {
      quarantineCorrupt(this.path);
      return { raw: [], tasks: [] };
    }
    const raw = v.data.tasks as unknown[];
    const parsed: Parsed = { raw, tasks: raw.map(validTask).filter((t): t is TaskRecord => t !== null), ...(v.status === 'newer' ? { newer: v.version } : {}) };
    this.cache = { stamp, parsed };
    return parsed;
  }

  load(): TaskRecord[] {
    return [...this.parse().tasks];
  }

  /** Records /good or /bad on a task. Returns an error message, or null when saved. */
  setFeedback(id: string, feedback: 'good' | 'bad'): string | null {
    try {
      let found = false;
      let skipped: string | null = null;
      withFileLock(this.path, () => {
        const p = this.parse();
        if (p.newer) {
          skipped = newerFormat(this.path, p.newer);
          return;
        }
        const raw = p.raw.map((t) => {
          if ((t as TaskRecord | null)?.id !== id) return t;
          found = true;
          return { ...(t as TaskRecord), feedback };
        });
        if (!found) return;
        this.write(raw);
      });
      if (skipped) return skipped;
      return found ? null : 'That task is not in your history (it cost nothing, or the history was cleared).';
    } catch (e) {
      return `Could not write history to ${this.path}: ${(e as Error).message}`;
    }
  }

  /** Returns an error message when the record could not be persisted. */
  append(record: TaskRecord): string | null {
    try {
      let skipped: string | null = null;
      withFileLock(this.path, () => {
        const p = this.parse();
        if (p.newer) {
          skipped = newerFormat(this.path, p.newer);
          return;
        }
        this.write([...p.raw, { ...record, prompt: record.prompt.slice(0, MAX_PROMPT) }].slice(-MAX_TASKS));
      });
      return skipped;
    } catch (e) {
      return `Could not write history to ${this.path}: ${(e as Error).message}`;
    }
  }

  private write(tasks: unknown[]): void {
    // Compact: up to 1000 tasks with their steps; indentation made the file about 40% bigger to read and write.
    writeFileAtomic(this.path, JSON.stringify({ version: HISTORY_VERSION, tasks }));
    this.cache = null;
  }
}
