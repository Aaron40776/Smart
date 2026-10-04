import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { assertFound, buildArgs, callError, claudeCommand, debugTiming, runClaude, StreamParser, toSpawnError, writeDebug, type ClaudeCommand, type ClaudeResult, type RunClaudeFn, type RunClaudeOptions } from './claude.js';
import { cancelled, SmartError } from './errors.js';
import { killTree } from './killTree.js';
import { sparable, Spares } from './spares.js';
import { emptyUsage, type Usage } from './types.js';

/**
 * Coding steps and follow-up tasks of one conversation talk to one long-lived `claude` process (`--input-format
 * stream-json`): the next message goes to a process that is already running, instead of paying Claude Code's start-up
 * (about 1.5 s measured, more on Windows) for every step. The model is switched on the running process when routing
 * picks another one; a different effort, permission mode or prompt setup gets a fresh process. Calls that need their own
 * process (JSON output, a per-call budget, a lean start) and anything unexpected fall back to one `claude` per call.
 */

const sub = (a: Usage, b: Usage): Usage => ({
  inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
  outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
  cacheReadTokens: Math.max(0, a.cacheReadTokens - b.cacheReadTokens),
  cacheCreationTokens: Math.max(0, a.cacheCreationTokens - b.cacheCreationTokens),
  costUsd: Math.max(0, a.costUsd - b.costUsd),
});

interface Turn {
  parser: StreamParser;
  onEvent?: RunClaudeOptions['onEvent'];
  resolve: (r: ClaudeResult) => void;
  reject: (e: Error) => void;
  /** Whether any event of this turn arrived (a process that dies before that is treated as unusable, not as a failed call). */
  started: boolean;
  timing: ReturnType<typeof debugTiming>;
}

const KILL_GRACE_MS = 2000;
/**
 * A process that shows no sign of life this long after its first message never will (an older Claude Code that ignores
 * `--input-format stream-json` waits for stdin to close). Nothing has reached the API by then, so trying again the
 * classic way costs nothing.
 */
export const FIRST_OUTPUT_MS = 30_000;
/** How long a model switch may take before the process is replaced by a fresh one on the new model. */
export const CONTROL_TIMEOUT_MS = 10_000;
/** How long a replaced process may take to exit before its session is resumed by a fresh one. */
const REPLACE_WAIT_MS = 3000;

/** One long-lived `claude -p --input-format stream-json` process. One message at a time. */
export class ClaudeProcess {
  model: string;
  dead = false;
  private child: ChildProcess;
  private buffer = '';
  private stderr = '';
  private turn: Turn | null = null;
  private controls = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private controlId = 0;
  /** Whether the process has written anything at all. */
  private heard = false;
  private readonly startedAt = Date.now();
  /** Resolves once the process has exited (or could not start). */
  private readonly exited: Promise<void>;
  /** Claude Code reports usage and cost as running totals for the process: each turn's own is the difference. */
  private seen: Usage = emptyUsage();

  constructor(
    readonly key: string,
    first: RunClaudeOptions,
    command: ClaudeCommand,
    spawnFn: typeof nodeSpawn,
    private readonly limits: { firstOutputMs: number; controlMs: number } = { firstOutputMs: FIRST_OUTPUT_MS, controlMs: CONTROL_TIMEOUT_MS },
  ) {
    this.model = first.model;
    const args = [...buildArgs(first), '--input-format', 'stream-json'];
    if (spawnFn === nodeSpawn) assertFound(command);
    this.child = spawnFn(command.cmd, [...command.prefix, ...args], { cwd: first.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (c: string) => this.onData(c));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (c: string) => {
      this.stderr = (this.stderr + c).slice(-4000);
    });
    this.child.stdin?.on('error', () => undefined);
    let markExited: () => void = () => undefined;
    this.exited = new Promise((r) => { markExited = r; });
    this.child.on('error', (e) => {
      markExited();
      this.die(toSpawnError(e));
    });
    this.child.on('exit', () => markExited());
    this.child.on('close', (code) => this.die(callError(this.stderr.trim() || `exit code ${code}`, 'Claude Code failed')));
    this.setRef(false);
  }

  get busy(): boolean {
    return this.turn !== null;
  }

  /** Sends one message and resolves with its result (usage and cost of this message only). */
  async send(o: RunClaudeOptions): Promise<ClaudeResult> {
    if (this.dead) throw new SmartError('claude', 'The kept-alive Claude Code process has ended.');
    if (o.signal?.aborted) throw cancelled();
    if (o.model !== this.model) {
      try {
        await this.control({ subtype: 'set_model', model: o.model });
      } catch (e) {
        // The process cannot switch: a fresh one started on the new model can.
        throw new ProcessUnusable(e instanceof SmartError ? e : new SmartError('claude', String(e)), true);
      }
      this.model = o.model;
      if (o.signal?.aborted) throw cancelled();
    }
    this.setRef(true);
    let silence: NodeJS.Timeout | undefined;
    if (!this.heard) {
      silence = setTimeout(() => {
        if (!this.heard) this.abandon(new SmartError('claude', `Claude Code did not answer within ${Math.round(this.limits.firstOutputMs / 1000)} s on a kept-alive process.`));
      }, this.limits.firstOutputMs);
    }
    try {
      return await new Promise<ClaudeResult>((resolve, reject) => {
        const onAbort = () => {
          this.kill();
          reject(cancelled());
        };
        o.signal?.addEventListener('abort', onAbort, { once: true });
        const done = <T>(fn: (v: T) => void) => (v: T) => {
          o.signal?.removeEventListener('abort', onAbort);
          this.turn = null;
          fn(v);
        };
        this.turn = { parser: new StreamParser(), onEvent: o.onEvent, resolve: done(resolve), reject: done(reject), started: false, timing: debugTiming(o, true) };
        this.write({ type: 'user', message: { role: 'user', content: o.prompt } });
      });
    } finally {
      clearTimeout(silence);
      this.setRef(false);
    }
  }

  kill(): void {
    this.abandon(cancelled());
  }

  /** Waits until the process has exited, at most `ms`. */
  async closed(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.exited, new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
    clearTimeout(timer);
  }

  /** Ends the process; a message in flight fails with `err` (or as ProcessUnusable if nothing of it arrived yet). */
  private abandon(err: SmartError): void {
    if (this.dead) return;
    killTree(this.child, 'SIGTERM');
    // Only if it is still running: Windows reuses process ids quickly, and `taskkill /T` on a reused id would end
    // some other process tree (possibly the fresh Claude Code that replaced this one).
    setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) killTree(this.child, 'SIGKILL');
    }, KILL_GRACE_MS).unref?.();
    this.die(err);
  }

  private control(request: Record<string, unknown>): Promise<void> {
    const id = `smart-${++this.controlId}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id);
        reject(new SmartError('claude', 'Claude Code did not confirm a setting change.'));
      }, this.limits.controlMs);
      timer.unref?.();
      const settle = (fn: () => void) => { clearTimeout(timer); fn(); };
      this.controls.set(id, { resolve: () => settle(resolve), reject: (e) => settle(() => reject(e)) });
      this.write({ type: 'control_request', request_id: id, request });
    });
  }

  private write(obj: object): void {
    this.child.stdin?.write(`${JSON.stringify(obj)}\n`);
  }

  private onData(chunk: string): void {
    this.heard = true;
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.onLine(line);
  }

  private onLine(line: string): void {
    if (line.includes('"control_response"')) {
      try {
        const d = JSON.parse(line) as { type?: string; response?: { request_id?: string; subtype?: string; error?: string } };
        const pending = d.type === 'control_response' && d.response?.request_id ? this.controls.get(d.response.request_id) : undefined;
        if (pending) {
          this.controls.delete(d.response!.request_id!);
          if (d.response!.subtype === 'success') pending.resolve();
          else pending.reject(new SmartError('claude', `Claude Code refused a setting change: ${d.response!.error ?? 'unknown error'}`));
          return;
        }
      } catch {
        /* not a control response after all */
      }
    }
    const turn = this.turn;
    if (!turn) return;
    for (const ev of turn.parser.parseLine(line)) {
      turn.started = true;
      turn.timing?.mark(ev.kind);
      if (ev.kind !== 'result') {
        turn.onEvent?.(ev);
        continue;
      }
      const total = ev.result.usage;
      const own: ClaudeResult = { ...ev.result, usage: sub(total, this.seen) };
      this.seen = total;
      turn.onEvent?.({ kind: 'result', result: own });
      turn.timing?.done(0);
      if (own.isError) {
        const err = callError(own.text || own.subtype || 'unknown error', 'Claude Code reported an error');
        err.usage = own.usage;
        turn.reject(err);
      } else turn.resolve(own);
    }
  }

  private die(err: SmartError): void {
    if (this.dead) return;
    this.dead = true;
    for (const c of this.controls.values()) c.reject(err);
    this.controls.clear();
    const turn = this.turn;
    if (turn && !turn.started && err.kind !== 'cancelled') {
      writeDebug({ keepAlive: 'given up', model: this.model, afterMs: Date.now() - this.startedAt, heard: this.heard, reason: err.message, stderr: this.stderr.trim().slice(-600) });
    }
    if (turn) {
      // Died before this message produced anything: the process was unusable (an old Claude Code, a crash on start-up).
      // A cancel is always a cancel, never a reason to try again another way.
      turn.reject(turn.started || err.kind === 'cancelled' ? err : new ProcessUnusable(err));
    }
  }

  /** An idle process must not keep smart from exiting; a busy one must keep it alive. */
  private setRef(on: boolean): void {
    for (const h of [this.child, this.child.stdout, this.child.stderr, this.child.stdin] as ({ ref?: () => void; unref?: () => void } | null)[]) {
      if (on) h?.ref?.();
      else h?.unref?.();
    }
  }
}

/** The process could not handle the message at all; the call is repeated the classic way. */
export class ProcessUnusable extends Error {
  /** `switchOnly`: this process cannot change model, but a fresh one would work. */
  constructor(readonly error: SmartError, readonly switchOnly = false) {
    super(error.message);
  }
}

export interface ClaudeRunner extends RunClaudeFn {
  /** Starts a spare process for the next call like this one (see spares.ts); a no-op when keep-alive is off. */
  warm: (o: RunClaudeOptions) => void;
  /** Ends every kept-alive and spare process. */
  dispose: () => void;
}

/**
 * The `run` smart uses: coding calls in a session go to a kept-alive process (see ClaudeProcess); everything else, and
 * everything after a process proved unusable, runs one `claude` per call.
 */
export function createClaudeRunner(opts: { keepAlive: boolean; idleMs?: number; spawnImpl?: typeof nodeSpawn; command?: ClaudeCommand; oneShot?: RunClaudeFn; firstOutputMs?: number; controlMs?: number; onNotice?: (message: string) => void; spares?: boolean } = { keepAlive: true }): ClaudeRunner {
  const oneShot = opts.oneShot ?? runClaude;
  const bySession = new Map<string, ClaudeProcess>();
  const idle = new Map<string, NodeJS.Timeout>();
  let usable = opts.keepAlive;
  const spares = opts.keepAlive && opts.spares !== false ? new Spares(() => opts.command ?? claudeCommand(), opts.spawnImpl ?? nodeSpawn) : null;

  /** A tool-less one-shot call: on a spare process when one is ready, then a spare is started for the next such call. */
  const spared = async (o: RunClaudeOptions): Promise<ClaudeResult> => {
    const child = spares!.take(o);
    try {
      return child ? await oneShot({ ...o, streamInput: true, spawnImpl: (() => child) as unknown as typeof nodeSpawn }) : await oneShot(o);
    } finally {
      if (!o.signal?.aborted) spares!.warm(o);
    }
  };

  const drop = (id: string): ClaudeProcess | undefined => {
    const old = bySession.get(id);
    old?.kill();
    bySession.delete(id);
    clearTimeout(idle.get(id));
    idle.delete(id);
    return old;
  };
  /** Ends a session's process and waits for it to exit, so two Claude Code processes never hold one session at once. */
  const replace = async (id: string) => {
    await drop(id)?.closed(REPLACE_WAIT_MS);
  };

  const run = async (o: RunClaudeOptions): Promise<ClaudeResult> => {
    const eligible = usable && o.session && !o.jsonSchema && !o.maxBudgetUsd && !o.lean && o.tools === undefined && !o.binary;
    if (!eligible) return spares && usable && sparable(o) ? spared(o) : oneShot(o);
    const id = o.session!.id;
    const key = JSON.stringify([o.cwd, o.effort ?? '', o.permissionMode ?? '', o.appendSystemPrompt ?? '', o.systemPrompt ?? null, o.bare ?? false, o.extraArgs ?? [], Boolean(o.partial)]);
    let proc = bySession.get(id);
    if (proc && (proc.dead || proc.key !== key)) {
      await replace(id);
      proc = undefined;
    }
    if (proc?.busy) return oneShot(o);
    clearTimeout(idle.get(id));
    const limits = { firstOutputMs: opts.firstOutputMs ?? FIRST_OUTPUT_MS, controlMs: opts.controlMs ?? CONTROL_TIMEOUT_MS };
    const start = () => new ClaudeProcess(key, o, opts.command ?? claudeCommand(), opts.spawnImpl ?? nodeSpawn, limits);
    try {
      proc ??= start();
      bySession.set(id, proc);
      let res: ClaudeResult;
      try {
        res = await proc.send(o);
      } catch (e) {
        if (!(e instanceof ProcessUnusable && e.switchOnly)) throw e;
        await replace(id);
        proc = start();
        bySession.set(id, proc);
        res = await proc.send(o);
      }
      // The session now exists in Claude Code, whether this call started it or resumed it.
      const timer = setTimeout(() => drop(id), opts.idleMs ?? 10 * 60_000);
      timer.unref?.();
      idle.set(id, timer);
      return res;
    } catch (e) {
      if (proc?.dead) bySession.delete(id);
      if (!(e instanceof ProcessUnusable)) throw e;
      // Keeping the process alive does not work here: stop trying for this session and do it the classic way.
      writeDebug({ keepAlive: 'off for this run', reason: e.message });
      usable = false;
      spares?.dispose(); // the same Claude Code that cannot keep a process alive may not take stream-json input for spares either
      opts.onNotice?.(`Keeping Claude Code running between steps did not work here (${e.message.replace(/\.$/, '')}), so each step now starts its own \`claude\` for the rest of this session. \`runner.keepAlive: false\` skips the attempt; \`SMART_DEBUG=1\` logs the details.`);
      return oneShot(o);
    }
  };
  return Object.assign(run, {
    warm: (o: RunClaudeOptions) => {
      if (usable) spares?.warm(o);
    },
    dispose: () => {
      spares?.dispose();
      for (const id of [...bySession.keys()]) drop(id);
    },
  });
}

