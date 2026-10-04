import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killTree } from './killTree.js';
import { pathDirs } from './which.js';
import { authError, cancelled, cliMissing, limitError, overloadedError, SmartError } from './errors.js';
import { emptyUsage, type LimitWindow, type Usage } from './types.js';

/** Normalised view of Claude Code's `--output-format stream-json` events. */
export type ClaudeStreamEvent =
  | { kind: 'init'; model: string; sessionId: string }
  | { kind: 'text'; text: string }
  /** A piece of text as the model writes it (`partial` calls only); the complete block follows as a `text` event. */
  | { kind: 'text-delta'; text: string }
  | { kind: 'tool'; name: string; summary: string; /** Set for tools that modify a file. */ writtenFile?: string }
  | { kind: 'progress'; inputTokens: number; outputTokens: number; cacheReadTokens: number; /** Size of the conversation as of the latest message: what the next turn re-reads. */ contextTokens: number }
  | { kind: 'limits'; windows: Record<string, LimitWindow>; status?: string }
  | { kind: 'result'; result: ClaudeResult };

export interface ClaudeResult {
  isError: boolean;
  subtype: string;
  text: string;
  structured: unknown;
  usage: Usage;
  sessionId: string;
  numTurns: number;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Longest stdout line kept while waiting for its end (a large tool result is a few MB). */
export const MAX_LINE = 64 * 1024 * 1024;

export function summarizeTool(name: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  const target = str(i.file_path) || str(i.path) || str(i.command) || str(i.pattern) || str(i.url) || str(i.description);
  const oneLine = target.replace(/\s+/g, ' ').trim();
  // Long values are shortened later, after the caller has made paths project-relative.
  return oneLine ? `${name} ${oneLine.length > 400 ? oneLine.slice(0, 397) + '...' : oneLine}` : name;
}

function resultUsage(d: Json): Usage {
  const usage = emptyUsage();
  usage.costUsd = num(d.total_cost_usd);
  const mu = d.modelUsage;
  if (isObj(mu) && Object.keys(mu).length > 0) {
    for (const m of Object.values(mu)) {
      if (!isObj(m)) continue;
      usage.inputTokens += num(m.inputTokens);
      usage.outputTokens += num(m.outputTokens);
      usage.cacheReadTokens += num(m.cacheReadInputTokens);
      usage.cacheCreationTokens += num(m.cacheCreationInputTokens);
    }
  } else if (isObj(d.usage)) {
    usage.inputTokens = num(d.usage.input_tokens);
    usage.outputTokens = num(d.usage.output_tokens);
    usage.cacheReadTokens = num(d.usage.cache_read_input_tokens);
    usage.cacheCreationTokens = num(d.usage.cache_creation_input_tokens);
  }
  return usage;
}

/**
 * Stateful line parser: feed it raw stdout chunks, get normalised events back.
 * Unknown / bulky event types (partial stream events, rate limits, hooks) are ignored.
 */
export class StreamParser {
  private buffer = '';
  private seenMessages = new Set<string>();
  private totals = { input: 0, output: 0, cacheRead: 0 };

  push(chunk: string): ClaudeStreamEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    // One event is one line; a "line" this long is not one Claude Code wrote, and must not grow without bound.
    if (this.buffer.length > MAX_LINE) this.buffer = '';
    return lines.flatMap((l) => this.parseLine(l));
  }

  end(): ClaudeStreamEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    return this.parseLine(rest);
  }

  parseLine(line: string): ClaudeStreamEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let d: unknown;
    try {
      d = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!isObj(d)) return [];

    switch (d.type) {
      case 'system':
        return d.subtype === 'init' ? [{ kind: 'init', model: str(d.model), sessionId: str(d.session_id) }] : [];
      case 'assistant':
        return this.assistant(d);
      case 'stream_event': {
        // Live text of the main conversation (a subagent's has a parent_tool_use_id); thinking is not shown.
        const ev = isObj(d.event) ? d.event : null;
        const delta = ev && ev.type === 'content_block_delta' && isObj(ev.delta) ? ev.delta : null;
        return delta && delta.type === 'text_delta' && !d.parent_tool_use_id && str(delta.text) ? [{ kind: 'text-delta', text: str(delta.text) }] : [];
      }
      case 'rate_limit_event': {
        const info = isObj(d.rate_limit_info) ? d.rate_limit_info : null;
        const windows: Record<string, LimitWindow> = {};
        if (info && isObj(info.unifiedWindows)) {
          for (const [name, w] of Object.entries(info.unifiedWindows)) {
            if (isObj(w) && typeof w.utilization === 'number') windows[name] = { utilization: w.utilization, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : undefined };
          }
        }
        return Object.keys(windows).length > 0 ? [{ kind: 'limits', windows, status: typeof info?.status === 'string' ? info.status : undefined }] : [];
      }
      case 'result':
        return [
          {
            kind: 'result',
            result: {
              isError: d.is_error === true || (typeof d.subtype === 'string' && d.subtype !== 'success'),
              subtype: str(d.subtype),
              // Failures such as "No conversation found" arrive in `errors`, not `result`.
              text: str(d.result) || (Array.isArray(d.errors) ? d.errors.filter((x) => typeof x === 'string').join('; ') : ''),
              structured: d.structured_output,
              usage: resultUsage(d),
              sessionId: str(d.session_id),
              numTurns: num(d.num_turns),
            },
          },
        ];
      default:
        return [];
    }
  }

  private assistant(d: Json): ClaudeStreamEvent[] {
    const msg = d.message;
    if (!isObj(msg)) return [];
    const events: ClaudeStreamEvent[] = [];
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === 'text' && str(block.text).trim()) events.push({ kind: 'text', text: str(block.text) });
      // StructuredOutput is an internal tool used for --json-schema; not interesting to show.
      else if (block.type === 'tool_use' && block.name !== 'StructuredOutput') {
        const name = str(block.name);
        const input = isObj(block.input) ? block.input : {};
        const writtenFile = WRITE_TOOLS.has(name) ? str(input.file_path) || str(input.notebook_path) || undefined : undefined;
        events.push({ kind: 'tool', name, summary: summarizeTool(name, block.input), writtenFile });
      }
    }
    // Claude Code repeats one message per content block, so count each message id once.
    const id = str(msg.id);
    if (isObj(msg.usage) && id && !this.seenMessages.has(id)) {
      this.seenMessages.add(id);
      this.totals.input += num(msg.usage.input_tokens);
      this.totals.output += num(msg.usage.output_tokens);
      this.totals.cacheRead += num(msg.usage.cache_read_input_tokens);
      const context = num(msg.usage.input_tokens) + num(msg.usage.cache_read_input_tokens) + num(msg.usage.cache_creation_input_tokens) + num(msg.usage.output_tokens);
      events.push({
        kind: 'progress',
        inputTokens: this.totals.input,
        outputTokens: this.totals.output,
        cacheReadTokens: this.totals.cacheRead,
        contextTokens: context,
      });
    }
    return events;
  }
}

export interface RunClaudeOptions {
  prompt: string;
  model: string;
  cwd: string;
  signal?: AbortSignal;
  systemPrompt?: string;
  /** Appended to Claude Code's default system prompt (keeps its tool instructions). */
  appendSystemPrompt?: string;
  /** JSON schema (object) for structured output. */
  jsonSchema?: object;
  /** Persist and continue a Claude Code conversation. Omit for stateless calls (nothing is saved). */
  session?: { id: string; resume: boolean };
  effort?: string;
  /** Built-in tools to allow. `[]` disables all tools; undefined keeps the default set. */
  tools?: string[];
  permissionMode?: string;
  bare?: boolean;
  /**
   * For tool-less calls: skip user/project settings (hooks, plugins), MCP servers and skills. They cannot matter without
   * tools, but each one slows every `claude` start-up.
   */
  lean?: boolean;
  maxBudgetUsd?: number | null;
  /** Stream text as it is written (`--include-partial-messages`): replies appear word by word instead of block by block. */
  partial?: boolean;
  /** Send the prompt as one stream-json message (`--input-format stream-json`), as a pre-started spare process expects. */
  streamInput?: boolean;
  /** `false`: no extended thinking (`MAX_THINKING_TOKENS=0` for this process). Undefined: Claude Code's default. */
  thinking?: boolean;
  /**
   * Give up when Claude Code has written nothing at all this long after it was started (default STARTUP_MS; 0 = wait forever).
   * Claude Code reports itself ready before the model is called, so a silent process is stuck starting (a login prompt, a
   * hung hook or MCP server), and nothing has been spent yet. A long-running step is never cut off: it keeps writing events.
   */
  startupTimeoutMs?: number;
  extraArgs?: string[];
  onEvent?: (e: ClaudeStreamEvent) => void;
  /** Injectable for tests. */
  spawnImpl?: typeof nodeSpawn;
  binary?: string;
}

/** The environment for a `claude` process: thinking switched off when the call asks for it. */
export function spawnEnv(o: RunClaudeOptions): NodeJS.ProcessEnv | undefined {
  return o.thinking === false ? { ...process.env, MAX_THINKING_TOKENS: '0' } : undefined;
}

export function buildArgs(o: RunClaudeOptions): string[] {
  const args = ['-p', '--model', o.model, '--output-format', 'stream-json', '--verbose'];
  if (o.session) args.push(o.session.resume ? '--resume' : '--session-id', o.session.id);
  else args.push('--no-session-persistence');
  if (o.effort) args.push('--effort', o.effort);
  if (o.systemPrompt !== undefined) args.push('--system-prompt', o.systemPrompt);
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt);
  if (o.tools) args.push('--tools', o.tools.join(','));
  if (o.jsonSchema) args.push('--json-schema', JSON.stringify(o.jsonSchema));
  if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
  if (o.bare) args.push('--bare');
  if (o.lean) args.push('--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '');
  if (o.maxBudgetUsd) args.push('--max-budget-usd', String(o.maxBudgetUsd));
  if (o.partial) args.push('--include-partial-messages');
  if (o.extraArgs?.length) args.push(...o.extraArgs);
  if (o.streamInput) args.push('--input-format', 'stream-json');
  return args;
}

/**
 * `bypassPermissions` is refused by Claude Code when running as root (common in Docker/CI),
 * so degrade to `acceptEdits` and tell the caller why.
 */
export function resolvePermissionMode(mode: string, uid: number | undefined = process.getuid?.()): { mode: string; warning?: string } {
  if (mode === 'bypassPermissions' && uid === 0) {
    return {
      mode: 'acceptEdits',
      warning: 'Running as root: Claude Code refuses bypassPermissions here, so using acceptEdits (file edits allowed, other tools may be denied).',
    };
  }
  return { mode };
}

/** Signs of an authentication problem. Deliberately specific: "No conversation found with session ID: …401…" must not match. */
const AUTH_RE = /(not logged in|please (?:run )?\/?log ?in|\/login|not authenticated|authentication (?:failed|error|required)|invalid (?:x-)?api[ -]key|missing api key|\b401\b|unauthori[sz]ed|oauth token)/i;
export const isAuthFailure = (detail: string): boolean => !/No conversation found/i.test(detail) && AUTH_RE.test(detail);

/**
 * Signs that the account's usage limit refused the call (subscription 5-hour / weekly windows, or an API rate limit).
 * Old Claude Code versions report "Claude AI usage limit reached|<epoch seconds>", newer ones "5-hour limit reached ∙ resets 3pm"
 * or "You've hit your limit · resets 5pm".
 */
const LIMIT_RE = /(usage limit reached|(?:5-hour|weekly|opus|session|daily) limit reached|hit your (?:[\w-]+ )?limit|limit reached[^\n]*resets|rate_limit_error)/i;
export function limitFailure(detail: string): { message: string; resetsAt?: number } | null {
  // Claude Code's limit notices are one short line; a long text is model output that merely talks about limits.
  if (detail.length > 400 || !LIMIT_RE.test(detail)) return null;
  const epoch = /\|(\d{9,11})\b/.exec(detail);
  const message = detail.replace(/\|\d{9,11}\b/, '').trim() || 'usage limit reached';
  return { message, resetsAt: epoch ? Number(epoch[1]) : undefined };
}

/** A temporary problem on Anthropic's side (HTTP 529 overloaded, 500/502/503). Only short error lines: long text is model output. */
const OVERLOAD_RE = /(overloaded|\b529\b|api error:? 5\d\d|internal server error|service unavailable|bad gateway)/i;
export const isOverloaded = (detail: string): boolean => detail.length <= 400 && OVERLOAD_RE.test(detail);

/** The error for a failed call: not logged in, usage limit, servers overloaded, or anything else. */
export function callError(detail: string, prefix: string): SmartError {
  if (isAuthFailure(detail)) return authError(detail);
  const limit = limitFailure(detail);
  if (limit) return limitError(limit.message, limit.resetsAt);
  if (isOverloaded(detail)) return overloadedError(detail);
  return new SmartError('claude', `${prefix}: ${detail}`);
}

const KILL_GRACE_MS = 2000;
/** See RunClaudeOptions.startupTimeoutMs (`runner.startupTimeoutSec`). */
export const STARTUP_MS = 120_000;

/** The error for a `claude` that never said anything: see RunClaudeOptions.startupTimeoutMs. */
export function startupError(ms: number, stderr: string): SmartError {
  const e = new SmartError(
    'claude',
    `Claude Code produced no output within ${Math.round(ms / 1000)} s of starting${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ''}.`,
    'Run `claude` by itself to see what it waits for (a login, a hook, an MCP server). runner.startupTimeoutSec changes the limit.',
  );
  e.noOutput = true;
  return e;
}

/** Runs one headless Claude Code call. The prompt goes over stdin (no argv size limits, no stdin wait). */
export function runClaude(opts: RunClaudeOptions): Promise<ClaudeResult> {
  return new Promise<ClaudeResult>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(cancelled());

    const spawnFn = opts.spawnImpl ?? nodeSpawn;
    const command: ClaudeCommand = opts.binary ? { cmd: opts.binary, prefix: [] } : claudeCommand();
    let child: ChildProcess;
    try {
      // An injected spawn (tests, a pre-started spare) does not look anything up.
      if (!opts.spawnImpl) assertFound(command);
      child = spawnFn(command.cmd, [...command.prefix, ...buildArgs(opts)], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv(opts) });
    } catch (e) {
      return reject(toSpawnError(e));
    }

    const parser = new StreamParser();
    const timing = debugTiming(opts);
    let result: ClaudeResult | undefined;
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let hangTimer: NodeJS.Timeout | undefined;
    let heard = false;
    const startupMs = opts.startupTimeoutMs ?? STARTUP_MS;
    const startTimer = startupMs > 0
      ? setTimeout(() => {
          if (heard) return;
          killTree(child, 'SIGKILL');
          finish(() => reject(startupError(startupMs, stderr)));
        }, startupMs)
      : undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (hangTimer) clearTimeout(hangTimer);
      if (startTimer) clearTimeout(startTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const handle = (events: ClaudeStreamEvent[]) => {
      for (const ev of events) {
        timing?.mark(ev.kind);
        if (ev.kind === 'result') result = ev.result;
        opts.onEvent?.(ev);
      }
    };

    const onAbort = () => {
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        killTree(child, 'SIGKILL');
        // If a grandchild still holds our pipes, 'close' may never fire: do not let a cancel hang.
        hangTimer = setTimeout(() => finish(() => reject(cancelled())), 1000);
        hangTimer.unref?.();
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      heard = true;
      handle(parser.push(c));
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => {
      stderr = (stderr + c).slice(-4000);
    });
    // The child may exit before reading stdin; ignore EPIPE.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.streamInput ? `${JSON.stringify({ type: 'user', message: { role: 'user', content: opts.prompt } })}\n` : opts.prompt);

    child.on('error', (e) => finish(() => reject(toSpawnError(e))));
    child.on('close', (code) => {
      handle(parser.end());
      timing?.done(code);
      finish(() => {
        if (opts.signal?.aborted) return reject(cancelled());
        if (result) {
          if (result.isError) {
            const err = callError(result.text || result.subtype || 'unknown error', 'Claude Code reported an error');
            err.usage = result.usage; // the call still cost money
            return reject(err);
          }
          return resolve(result);
        }
        const err = callError(stderr.trim() || `exit code ${code}`, 'Claude Code failed');
        // Exited without a word on stdout: it never got to the model (a crash on start-up, a spare that had died).
        if (!heard && err.kind === 'claude') err.noOutput = true;
        reject(err);
      });
    });
  });
}

/**
 * `SMART_DEBUG=1` appends one line per `claude` call to ~/.smart/debug.log (or `SMART_DEBUG_FILE`): how long start-up took
 * (spawn until Claude Code reports it is ready), how long until the first text, and the total. It shows whether a slow
 * call is Claude Code's own start-up (plugins, hooks, MCP servers) or the model.
 */
export function debugTiming(o: RunClaudeOptions, keptAlive = false): { mark: (kind: string) => void; done: (code: number | null) => void } | null {
  if (!process.env.SMART_DEBUG) return null;
  const t0 = Date.now();
  const at: Record<string, number> = {};
  return {
    mark: (kind) => {
      at[kind] ??= Date.now() - t0;
    },
    done: (code) => {
      const line = {
        time: new Date().toISOString(), model: o.model, tools: o.tools ? (o.tools.length ? 'some' : 'none') : 'all', lean: Boolean(o.lean), effort: o.effort ?? null, ...(o.thinking === false ? { thinking: false } : {}),
        session: `${keptAlive ? 'keep-alive ' : o.streamInput ? 'warm ' : ''}${o.session ? (o.session.resume ? 'resume' : 'new') : 'none'}`, exit: code,
        ms: { startupUntilReady: at.init ?? null, firstText: at.text ?? null, firstTool: at.tool ?? null, result: at.result ?? null, total: Date.now() - t0 },
      };
      writeDebug(line);
    },
  };
}

/** Appends one JSON line to the debug log when `SMART_DEBUG` is set; never throws. */
export function writeDebug(entry: object): void {
  if (!process.env.SMART_DEBUG) return;
  try {
    const file = process.env.SMART_DEBUG_FILE || `${os.homedir()}/.smart/debug.log`;
    mkdirSync(file.replace(/[\\/][^\\/]*$/, '') || '.', { recursive: true, mode: 0o700 });
    // Timings and error tails only, never prompts; still owner-only like the other files under ~/.smart.
    appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    /* diagnostics must never break a run */
  }
}

export function toSpawnError(e: unknown): SmartError {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT'
    ? cliMissing()
    : new SmartError('claude', `Could not start Claude Code: ${(e as Error).message}`);
}

export type RunClaudeFn = (opts: RunClaudeOptions) => Promise<ClaudeResult>;

export interface ClaudeCommand {
  cmd: string;
  /** Arguments that must precede the real ones (e.g. the cli.js path when launching via node). */
  prefix: string[];
  /**
   * Windows only: Claude Code was not found on PATH. Starting the bare name would make Windows look in the project folder
   * first (see which.ts), so callers report it as missing instead of starting anything.
   */
  missing?: boolean;
}

/** Fails like a missing CLI when `command` was not found (Windows), so nothing is started by a bare name. */
export function assertFound(command: ClaudeCommand): void {
  if (command.missing) throw cliMissing();
}

let resolved: { key: string; command: ClaudeCommand } | undefined;
/** `resolveClaudeCommand`, remembered while PATH is unchanged: on Windows it probes every PATH directory, and a task makes many calls. */
export function claudeCommand(): ClaudeCommand {
  const key = `${process.env.SMART_CLAUDE_BIN ?? ''}\0${process.env.PATH ?? process.env.Path ?? ''}`;
  if (resolved?.key !== key) resolved = { key, command: resolveClaudeCommand() };
  return resolved.command;
}

/**
 * Where to find Claude Code. On Windows `claude` may be `claude.exe` (native installer) or the npm
 * `claude.cmd` shim; .cmd files cannot be spawned without a shell (and shell quoting would mangle our
 * arguments), so for the shim we run its `cli.js` with node directly. `SMART_CLAUDE_BIN` overrides all.
 */
export function resolveClaudeCommand(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
): ClaudeCommand {
  // A JavaScript file (a stand-in such as test/fixtures/fake-claude.mjs) runs through Node: Windows cannot start it directly.
  if (env.SMART_CLAUDE_BIN) return /\.(c|m)?js$/i.test(env.SMART_CLAUDE_BIN) ? { cmd: process.execPath, prefix: [env.SMART_CLAUDE_BIN] } : { cmd: env.SMART_CLAUDE_BIN, prefix: [] };
  if (platform !== 'win32') return { cmd: 'claude', prefix: [] };
  const w = path.win32;
  // Absolute PATH entries only: `.` or an empty entry would mean the project folder.
  for (const dir of pathDirs({ platform, env })) {
    const exe = w.join(dir, 'claude.exe');
    if (exists(exe)) return { cmd: exe, prefix: [] };
    if (exists(w.join(dir, 'claude.cmd'))) {
      for (const rel of [['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'], ['node_modules', '@anthropic-ai', 'claude-code', 'cli.mjs']]) {
        const cli = w.join(dir, ...rel);
        if (exists(cli)) return { cmd: process.execPath, prefix: [cli] };
      }
    }
  }
  return { cmd: 'claude', prefix: [], missing: true };
}
