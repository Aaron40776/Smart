import { existsSync, readFileSync } from 'node:fs';
import type { Limits } from '../types.js';
import { writeFileAtomic } from './atomicFile.js';

/** Last-seen account limits, kept between runs so the header is not empty before the first call. Never throws. */
export class LimitsStore {
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

  save(limits: Limits): void {
    try {
      writeFileAtomic(this.path, JSON.stringify(limits));
    } catch {
      /* a convenience only */
    }
  }
}
