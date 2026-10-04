/**
 * Versions of smart's own files under `~/.smart/`. Every versioned file is `{ "version": n, ... }`:
 *
 *  - `version` equal to the current one: used as is.
 *  - older (or missing, for a file from before versions were written): migrated in memory, one version at a time, and written
 *    back in the new format by the next normal save (an atomic write, so a crash leaves the old file).
 *  - newer (written by a later smart, then this older one was started): read as far as it is understood, but never written,
 *    so going back a version cannot destroy data. Saves report why they were skipped.
 *  - not an object, or a version that is not a positive integer: unusable (callers move the file aside, see quarantineCorrupt).
 *
 * Today every versioned file is still at version 1: there have been no incompatible changes, only new optional fields, which
 * older records simply lack. The migration tables below are where a future change goes.
 */
export type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

export type Versioned =
  | { status: 'current'; data: Record<string, unknown>; migratedFrom?: number }
  | { status: 'newer'; data: Record<string, unknown>; version: number }
  | { status: 'invalid'; reason: string };

/**
 * Brings `raw` to `current`. `migrations[n]` turns version n into n+1; a file without a version counts as version 1 when
 * `current` is 1 (the shape never changed), else as version 0 (`migrations[0]` must handle it).
 */
export function readVersioned(raw: unknown, current: number, migrations: Record<number, Migration> = {}): Versioned {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { status: 'invalid', reason: 'not a JSON object' };
  let data = raw as Record<string, unknown>;
  const v = data.version === undefined ? (current === 1 ? 1 : 0) : data.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return { status: 'invalid', reason: `unknown version ${JSON.stringify(data.version)}` };
  if (v > current) return { status: 'newer', data, version: v };
  for (let n = v; n < current; n++) {
    const step = migrations[n];
    if (!step) return { status: 'invalid', reason: `no migration from version ${n}` };
    try {
      data = step(data);
    } catch (e) {
      return { status: 'invalid', reason: `migration from version ${n} failed: ${(e as Error).message}` };
    }
  }
  return v < current || data.version === undefined ? { status: 'current', data: { ...data, version: current }, migratedFrom: v } : { status: 'current', data };
}

/** The message for a save that was skipped because a newer smart wrote the file. */
export const newerFormat = (path: string, version: number): string =>
  `${path} was written by a newer version of smart (format ${version}); it is left unchanged. Run \`smart update\`.`;

const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

/** A usage record as stored (all five numbers). */
export const isUsage = (u: unknown): boolean => {
  const x = u as Record<string, unknown> | null;
  return !!x && typeof x === 'object' && num(x.inputTokens) && num(x.outputTokens) && num(x.cacheReadTokens) && num(x.cacheCreationTokens) && num(x.costUsd);
};
