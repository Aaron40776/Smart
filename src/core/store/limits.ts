import { existsSync, readFileSync } from 'node:fs';
import type { Limits } from '../types.js';
import { writeFileAtomic } from './atomicFile.js';

/** Re-save unchanged limits at most this often (Claude reports them several times per call). */
const RESAVE_MS = 60_000;

/** Last-seen account limits, kept between runs so the header is not empty before the first call. Never throws. */
export class LimitsStore {
  private last: { content: string; at: number } | null = null;

  constructor(private readonly path: string) {}

  load(): Limits | null {
    try {
      if (!existsSync(this.path)) return null;
      const d = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Limits>;
      if (!d || typeof d.at !== 'number' || typeof d.windows !== 'object' || d.windows === null || Array.isArray(d.windows)) return null;
      // A cache, rewritten after every call: entries this version does not understand are simply left out.
      const windows = Object.fromEntries(Object.entries(d.windows).filter(([, w]) => typeof w?.utilization === 'number' && Number.isFinite(w.utilization) && (w.resetsAt === undefined || typeof w.resetsAt === 'number')));
      return { windows, status: typeof d.status === 'string' ? d.status : undefined, at: d.at };
    } catch {
      return null;
    }
  }

  /**
   * Saves what Claude reported. It is a cache, written synchronously while a call streams: an unchanged report is not written
   * again for a minute, and the write skips the flush to disk (a crash loses at most a stale cache, which is rebuilt on the next call).
   */
  save(limits: Limits): void {
    const content = JSON.stringify({ windows: limits.windows, status: limits.status });
    if (this.last && this.last.content === content && limits.at - this.last.at < RESAVE_MS) return;
    try {
      writeFileAtomic(this.path, JSON.stringify(limits), { durable: false });
      this.last = { content, at: limits.at };
    } catch {
      /* a convenience only */
    }
  }
}
