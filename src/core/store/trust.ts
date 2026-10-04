import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dirKey } from './conversation.js';
import { withFileLock, writeFileAtomic } from './atomicFile.js';

/**
 * Projects whose `smart.config.json` you have reviewed and allowed (`smart trust`), like direnv's `allow`. A record holds the
 * SHA-256 of the file as it was when you trusted it: any later change to the file (a `git pull`, a new branch) makes it
 * untrusted again until you look at it and run `smart trust` once more.
 */
export interface TrustRecord {
  sha256: string;
  at: string;
}

interface TrustFile {
  version: 1;
  projects: Record<string, TrustRecord>;
}

export const trustStorePath = (home: string = homedir()): string => join(home, '.smart', 'trusted-projects.json');

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface TrustCheck {
  /** Whether `configText` is exactly the file you trusted for `dir`. */
  isTrusted(dir: string, configText: string): boolean;
  /** Whether `dir` was trusted with a different version of the file (it changed since). */
  changedSince(dir: string, configText: string): boolean;
}

export class TrustStore implements TrustCheck {
  constructor(
    private readonly path: string = trustStorePath(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** `foreign`: the file exists but is not a version-1 trust file this smart understands (a newer smart's, or damaged). */
  private read(): TrustFile & { foreign?: boolean } {
    if (!existsSync(this.path)) return { version: 1, projects: {} };
    try {
      const d = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<TrustFile>;
      // An unreadable or unknown-format trust file trusts nothing: failing closed is the safe direction here.
      if (d.version !== 1 || typeof d.projects !== 'object' || d.projects === null || Array.isArray(d.projects)) return { version: 1, projects: {}, foreign: true };
      return { version: 1, projects: d.projects };
    } catch {
      return { version: 1, projects: {}, foreign: true };
    }
  }

  private record(dir: string): TrustRecord | undefined {
    const r = this.read().projects[dirKey(dir, this.platform)];
    return r && typeof r.sha256 === 'string' ? r : undefined;
  }

  isTrusted(dir: string, configText: string): boolean {
    return this.record(dir)?.sha256 === sha256(configText);
  }

  changedSince(dir: string, configText: string): boolean {
    const r = this.record(dir);
    return r !== undefined && r.sha256 !== sha256(configText);
  }

  /** Remembers `configText` as trusted for `dir`. Returns an error message, or null when saved. */
  trust(dir: string, configText: string, now = new Date()): string | null {
    return this.update((projects) => {
      projects[dirKey(dir, this.platform)] = { sha256: sha256(configText), at: now.toISOString() };
    });
  }

  /** Forgets `dir`. Returns an error message, or null when saved. */
  revoke(dir: string): string | null {
    return this.update((projects) => {
      delete projects[dirKey(dir, this.platform)];
    });
  }

  private update(change: (projects: Record<string, TrustRecord>) => void): string | null {
    try {
      let refused: string | null = null;
      withFileLock(this.path, () => {
        const file = this.read();
        if (file.foreign) {
          refused = `${this.path} is not a trust file this version of smart understands; it is left unchanged. Move it aside or run \`smart update\`.`;
          return;
        }
        change(file.projects);
        writeFileAtomic(this.path, JSON.stringify({ version: 1, projects: file.projects } satisfies TrustFile, null, 2));
      });
      return refused;
    } catch (e) {
      return `Could not save ${this.path}: ${(e as Error).message}`;
    }
  }
}
