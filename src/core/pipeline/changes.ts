import path from 'node:path';
import type { Checkpointer } from '../checkpoint.js';
import type { EventBus } from '../events.js';
import type { Conversation } from '../store/conversation.js';

/** A snapshot slower than this is worth a hint. */
export const SLOW_SNAPSHOT_MS = 4000;

/** What change tracking needs from the pipeline around it. */
export interface ChangeHost {
  bus: EventBus;
  cp: Checkpointer;
  now: () => number;
  /** The current conversation (replaced by /new, so always asked for). */
  conversation: () => Conversation;
  saveConversation: () => void;
  isRunning: () => boolean;
  /** A one-off note for the model's next prompt. */
  note: (text: string) => void;
}

/**
 * Working-tree snapshots around a task: what each step and the whole task changed, `/diff` and `/undo`. Snapshots are git
 * trees (see checkpoint.ts); the list of tasks that changed files is kept with the conversation, so it survives a restart.
 */
export class ChangeTracker {
  /** The latest snapshot, while nothing can have changed since (reused at the end of the task). */
  fresh: string | null = null;
  private warnedSlow = false;

  constructor(private readonly h: ChangeHost) {}

  /** A working-tree snapshot. A slow one (a big repository, especially on Windows) is pointed out once, with the usual fix. */
  async snap(): Promise<string | null> {
    const t0 = this.h.now();
    const tree = await this.h.cp.snapshot();
    const ms = this.h.now() - t0;
    if (ms > SLOW_SNAPSHOT_MS && !this.warnedSlow) {
      this.warnedSlow = true;
      this.h.bus.emit({
        type: 'notice', level: 'info',
        message: `Saving the /undo snapshot took ${(ms / 1000).toFixed(1)} s in this repository. \`git config core.fsmonitor true\` (Git 2.37+) usually makes it much faster.`,
      });
    }
    return tree;
  }

  /** Convert a repository-relative git path to one relative to the project directory (posix separators). */
  fromRoot(p: string): string {
    return path.posix.relative(this.h.cp.prefix, p);
  }

  /** Snapshot the end state, publish the change summary and remember it for /undo. Returns changed paths (cwd-relative). */
  async summarize(dryRun: boolean, startTree: string | null, prompt: string): Promise<string[]> {
    if (dryRun || !startTree) return [];
    // The last step's snapshot is still the end state unless a check or a later call ran after it.
    const end = this.fresh ?? (await this.snap());
    this.fresh = null;
    if (!end || end === startTree) return [];
    const ch = await this.h.cp.changes(startTree, end);
    if (!ch || ch.files.length === 0) return [];
    // Kept with the conversation, so /undo and /diff still work after quitting and starting smart again here.
    const conv = this.h.conversation();
    // Which repository and folder the snapshots are of: an entry is never applied anywhere else (see undo).
    conv.undo = [...(conv.undo ?? []), { prompt, start: startTree, end, repo: this.h.cp.root, prefix: this.h.cp.prefix }].slice(-20);
    this.h.bus.emit({ type: 'changes', files: ch.files.map((f) => ({ ...f, path: this.fromRoot(f.path) })), insertions: ch.insertions, deletions: ch.deletions });
    return ch.files.filter((f) => f.status !== 'D').map((f) => this.fromRoot(f.path));
  }

  /**
   * Revert the working tree to how it was before the most recent task that changed files. Refuses, without touching anything,
   * when you have edited one of that task's files since (the edit would be lost) unless `force`, and when the entry was recorded
   * for another repository or folder.
   */
  async undo(force = false): Promise<void> {
    const emit = this.h.bus.emit.bind(this.h.bus);
    if (this.h.isRunning()) return emit({ type: 'notice', level: 'warn', message: 'Cancel the running task (Esc) before undoing.' });
    if (!this.h.cp.available) return emit({ type: 'notice', level: 'warn', message: 'Undo needs a git repository. Run `git init` in this directory first.' });
    const conv = this.h.conversation();
    const entry = conv.undo?.at(-1);
    if (!entry) return emit({ type: 'notice', level: 'info', message: 'Nothing to undo.' });
    if (!sameScope(entry, this.h.cp)) {
      return emit({ type: 'notice', level: 'warn', message: `The last change recorded here was made in another repository location (${entry.repo}${entry.prefix ? `/${entry.prefix}` : ''}), so it is not undone here.` });
    }
    // Only the files this task changed: an edit you made yourself to another file since then is not the task's to revert.
    const own = await this.h.cp.changes(entry.start, entry.end);
    const now = own ? await this.snap() : null;
    if (own && now && !force) {
      const mine = new Set(own.files.map((f) => f.path));
      const since = await this.h.cp.changes(entry.end, now);
      const edited = (since?.files ?? []).filter((f) => mine.has(f.path)).map((f) => this.fromRoot(f.path));
      if (edited.length) {
        return emit({
          type: 'notice', level: 'warn',
          message: `Not undone: ${edited.length === 1 ? 'a file' : `${edited.length} files`} that task changed ${edited.length === 1 ? 'was' : 'were'} edited after it (${edited.slice(0, 5).join(', ')}${edited.length > 5 ? ', …' : ''}), and undoing would discard those edits. \`/undo force\` reverts them anyway; \`/diff\` shows what the task changed.`,
        });
      }
    }
    const r = own && now ? await this.h.cp.restore(entry.start, now, own.files.map((f) => f.path)) : null;
    if (!r) return emit({ type: 'notice', level: 'warn', message: 'Could not restore the previous state (the snapshot may have been cleaned up by git gc, or git failed part-way: check `git status`). The undo entry is kept.' });
    if (r.failed.length) {
      // Keep the entry: running /undo again retries once the file is free; nothing is reported as undone that was not.
      return emit({ type: 'notice', level: 'warn', message: `Undo was incomplete: ${undoSummary(r.restored, r.removed)}, but could not put back ${r.failed.map((f) => this.fromRoot(f)).join(', ')} (in use, or its folder now points outside the project). Fix that and run /undo again.` });
    }
    conv.undo = conv.undo?.slice(0, -1);
    // The task that was undone (not simply the latest: after a restart or a question in between they differ). Memory keeps a clipped prompt.
    const key = entry.prompt.replace(/\s+/g, ' ').trim().slice(0, 200);
    const undone = [...conv.tasks].reverse().find((t) => t.outcome !== 'reverted' && t.prompt.startsWith(key));
    if (undone) undone.outcome = 'reverted';
    const quoted = entry.prompt.length > 80 ? `${entry.prompt.slice(0, 79)}…` : entry.prompt;
    this.h.note(`The user undid your file changes from the task "${quoted}"; those files are back to how they were before it. Do not assume that work exists.`);
    this.h.saveConversation();
    emit({ type: 'notice', level: 'info', message: `Undid "${entry.prompt.length > 50 ? `${entry.prompt.slice(0, 49)}…` : entry.prompt}": ${undoSummary(r.restored, r.removed)}.` });
  }

  /** Publish a unified diff of the most recent task that changed files. */
  async diff(): Promise<void> {
    const emit = this.h.bus.emit.bind(this.h.bus);
    if (!this.h.cp.available) return emit({ type: 'notice', level: 'warn', message: 'Diff needs a git repository. Run `git init` in this directory first.' });
    const entry = this.h.conversation().undo?.at(-1);
    if (!entry) return emit({ type: 'notice', level: 'info', message: 'No changes to show yet.' });
    const text = await this.h.cp.diff(entry.start, entry.end);
    emit(text ? { type: 'diff', text } : { type: 'notice', level: 'warn', message: 'Could not compute the diff.' });
  }
}

/** Whether an undo entry was recorded for this repository and folder. Entries from before this was recorded are accepted. */
function sameScope(entry: { repo?: string; prefix?: string }, cp: { root: string; prefix: string }): boolean {
  if (entry.repo === undefined) return true;
  const norm = (p: string) => (process.platform === 'win32' ? path.win32.resolve(p).toLowerCase() : path.resolve(p));
  return norm(entry.repo) === norm(cp.root) && (entry.prefix ?? '') === cp.prefix;
}

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
/** "restored 2 files", "removed 1 file", or both. */
export function undoSummary(restored: number, removed: number): string {
  const parts = [restored ? `restored ${files(restored)}` : '', removed ? `removed ${files(removed)}` : ''].filter(Boolean);
  return parts.length ? parts.join(' and ') : 'no files needed changing';
}
