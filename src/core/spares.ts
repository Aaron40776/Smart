import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { buildArgs, spawnEnv, type ClaudeCommand, type RunClaudeOptions } from './claude.js';
import { killTree } from './killTree.js';

/**
 * Pre-started `claude` processes for the short tool-less calls (classify, plan, review, answers). Claude Code's start-up
 * (about 1.3 s on Windows, measured) happens while you type or while a step runs; the call then only pays for the model.
 * A spare waits for its one message on stdin (`--input-format stream-json`) and costs nothing until then. Measured with the
 * real classifier: the same classifications as a normal start.
 */

/** Calls that can use a spare: one-shot (no session) and tool-less. Coding steps use the kept-alive process instead. */
export const sparable = (o: RunClaudeOptions): boolean => !o.session && !o.binary && (o.jsonSchema !== undefined || o.tools?.length === 0);

const MAX_SPARES = 3;
const SPARE_IDLE_MS = 10 * 60_000;
const handles = (c: ChildProcess) => [c, c.stdout, c.stderr, c.stdin] as ({ ref?: () => void; unref?: () => void } | null)[];

export class Spares {
  private readonly ready = new Map<string, { child: ChildProcess; timer: NodeJS.Timeout }>();
  private disposed = false;

  constructor(
    private readonly command: () => ClaudeCommand,
    private readonly spawnFn: typeof nodeSpawn = nodeSpawn,
    private readonly idleMs = SPARE_IDLE_MS,
  ) {}

  /** A spare only fits a call with exactly the same command line. */
  private keyOf(o: RunClaudeOptions): string {
    return JSON.stringify([o.cwd, o.thinking ?? null, buildArgs({ ...o, streamInput: true })]);
  }

  get size(): number {
    return this.ready.size;
  }

  /** Starts a process for the next call like `o`. */
  warm(o: RunClaudeOptions): void {
    const key = this.keyOf(o);
    if (this.disposed || this.ready.has(key)) return;
    const cmd = this.command();
    if (cmd.missing && this.spawnFn === nodeSpawn) return; // not installed: never start a bare name (see which.ts)
    let child: ChildProcess;
    try {
      child = this.spawnFn(cmd.cmd, [...cmd.prefix, ...buildArgs({ ...o, streamInput: true })], { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv(o) });
    } catch {
      return;
    }
    child.on('error', () => this.forget(key, child));
    child.on('exit', () => this.forget(key, child));
    child.stdin?.on('error', () => undefined);
    // A waiting spare must not keep smart from exiting.
    for (const h of handles(child)) h?.unref?.();
    const timer = setTimeout(() => this.forget(key, child, true), this.idleMs);
    timer.unref?.();
    this.ready.set(key, { child, timer });
    while (this.ready.size > MAX_SPARES) {
      const [oldKey, oldest] = this.ready.entries().next().value!;
      this.forget(oldKey, oldest.child, true);
    }
  }

  /** The spare for a call like `o`, if one is ready and still running. */
  take(o: RunClaudeOptions): ChildProcess | undefined {
    const key = this.keyOf(o);
    const spare = this.ready.get(key);
    if (!spare) return undefined;
    this.ready.delete(key);
    clearTimeout(spare.timer);
    const { child } = spare;
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return undefined;
    for (const h of handles(child)) h?.ref?.();
    return child;
  }

  dispose(): void {
    this.disposed = true;
    for (const [key, { child }] of [...this.ready]) this.forget(key, child, true);
  }

  private forget(key: string, child: ChildProcess, kill = false): void {
    const spare = this.ready.get(key);
    if (spare?.child === child) {
      this.ready.delete(key);
      clearTimeout(spare.timer);
    }
    if (kill && child.exitCode === null && child.signalCode === null) killTree(child, 'SIGTERM');
  }
}
