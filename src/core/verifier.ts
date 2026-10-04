import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRunning, killTree } from './killTree.js';
import type { SmartConfig } from './config.js';
import { escalate } from './router.js';
import type { ModelTier } from './types.js';

export interface Check {
  name: string;
  command: string;
}

export interface ExecResult {
  code: number | null;
  output: string;
  timedOut?: boolean;
  /** The command could not be started at all (no shell, bad working directory). */
  spawnFailed?: boolean;
}

export type ExecFn = (command: string, opts: { cwd: string; signal?: AbortSignal; timeoutMs: number }) => Promise<ExecResult>;

export interface VerifyResult {
  ok: boolean;
  /** True when there was nothing to run. */
  skipped: boolean;
  /** Commands that ran, in order, with their outcome. */
  ran: { command: string; ok: boolean }[];
  /** First failing check, if any, with how it failed (see pipeline/outcome.ts checkFailureKind). */
  failure?: { command: string; output: string; code: number | null; timedOut?: boolean; spawnFailed?: boolean };
}

const OUTPUT_LIMIT = 2000;
/** Keep the end of the output: that is where errors and summaries live. */
export const tail = (s: string, n = OUTPUT_LIMIT): string => (s.length > n ? '…' + s.slice(-n) : s).trim();

/** npm's `npm init` placeholder; running it always fails and says nothing about the code. */
const isPlaceholderTest = (cmd: string): boolean => /no test specified/i.test(cmd);

/** Ordered cheapest-first so a type or lint error fails fast before the slow build/tests. */
const SCRIPT_ORDER = ['typecheck', 'lint', 'build', 'test'] as const;

const DOCS_ONLY = /\.(md|mdx|markdown|txt|rst|adoc|png|jpe?g|gif|svg|webp|ico|pdf)$/i;
const DOC_NAMES = /^(readme|license|licence|changelog|contributing|notice|authors|code_of_conduct)(\.[a-z]+)?$/i;

/**
 * True when every changed file is prose or an image, so there is nothing for a typecheck, lint, build or test to break.
 * Config and data files (json, yaml, toml) are deliberately not here: they can break a build.
 */
export function isDocsOnly(files: string[]): boolean {
  return files.length > 0 && files.every((f) => {
    const name = f.split(/[\\/]/).pop() ?? f;
    return DOCS_ONLY.test(name) || DOC_NAMES.test(name);
  });
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const LOCKFILES: [string, PackageManager][] = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun']];
const installed = new Map<string, boolean>();

/**
 * Whether a command runs on this machine (through the shell, so Windows `.cmd` shims count). Asked once per process.
 * `bin` is one of smart's own fixed names, never text from a project. It is asked from your home folder with cmd.exe told not
 * to look in the current folder, so a `pnpm.cmd` committed to a repository does not answer (and run) for the real one.
 */
export function hasCommand(bin: string): boolean {
  let ok = installed.get(bin);
  if (ok === undefined) {
    ok = spawnSync(`${bin} --version`, {
      shell: true, stdio: 'ignore', timeout: 10_000, windowsHide: true, cwd: homedir(), env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
    }).status === 0;
    installed.set(bin, ok);
  }
  return ok;
}

/**
 * The project's package manager: package.json's `packageManager` field, else its lockfile, else npm. One that is not
 * installed falls back to npm, which runs the same scripts.
 */
export function packageManager(cwd: string, pkg: { packageManager?: unknown }, has: (bin: string) => boolean = hasCommand): PackageManager {
  const declared = typeof pkg.packageManager === 'string' ? /^(pnpm|yarn|bun|npm)@/.exec(pkg.packageManager)?.[1] as PackageManager | undefined : undefined;
  const pm = declared ?? LOCKFILES.find(([file]) => existsSync(join(cwd, file)))?.[1] ?? 'npm';
  return pm === 'npm' || has(pm) ? pm : 'npm';
}

const runScript = (pm: PackageManager, name: string): string => (pm === 'yarn' ? `yarn ${name}` : `${pm} run ${name}`);

export function detectChecks(cwd: string, config: SmartConfig, has?: (bin: string) => boolean): Check[] {
  const { auto, commands } = config.verify;
  if (commands.length > 0) return commands.map((command) => ({ name: command, command }));
  if (!auto) return [];
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string>; packageManager?: unknown };
    const scripts = pkg.scripts ?? {};
    const names = SCRIPT_ORDER.filter((name) => typeof scripts[name] === 'string' && !isPlaceholderTest(scripts[name]!));
    if (names.length === 0) return [];
    const pm = packageManager(cwd, pkg, has);
    return names.map((name) => ({ name, command: runScript(pm, name) }));
  } catch {
    return [];
  }
}

const KILL_GRACE_MS = 2000;

/** Runs a shell command in its own process group so cancel / timeout kill the whole tree. */
export const defaultExec: ExecFn = (command, { cwd, signal, timeoutMs }) =>
  new Promise<ExecResult>((resolve) => {
    if (signal?.aborted) return resolve({ code: null, output: 'Cancelled.' });
    const win = process.platform === 'win32';
    // POSIX: own process group so we can signal the whole tree. Windows: detached would open a console window.
    const child = spawn(command, { cwd, shell: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let output = '';
    let timedOut = false;
    let spawnFailed = false;
    let done = false;
    const append = (c: Buffer) => {
      output = (output + c.toString('utf8')).slice(-OUTPUT_LIMIT * 4);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const killGroup = (sig: NodeJS.Signals) => {
      // Once the command has finished, its id may belong to another program: never signal it again (see killTree).
      if (done || !child.pid) return;
      try {
        if (win) killTree(child, sig);
        else process.kill(-child.pid, sig); // the whole group: the shell and what it started, which may outlive it
      } catch {
        if (isRunning(child)) child.kill(sig);
      }
    };
    const stop = () => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });

    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ code, output, timedOut, ...(spawnFailed ? { spawnFailed } : {}) });
    };
    child.on('error', (e) => {
      output += `\n${e.message}`;
      spawnFailed = true;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });

export interface VerifyOptions {
  cwd: string;
  config: SmartConfig;
  exec?: ExecFn;
  signal?: AbortSignal;
  onCheck?: (r: { command: string; ok: boolean; output: string }) => void;
}

/** Runs each check in order and stops at the first failure. */
export async function runChecks(checks: Check[], opts: VerifyOptions): Promise<VerifyResult> {
  if (checks.length === 0) return { ok: true, skipped: true, ran: [] };
  const exec = opts.exec ?? defaultExec;
  const timeoutMs = opts.config.verify.timeoutSec * 1000;
  const ran: VerifyResult['ran'] = [];
  for (const check of checks) {
    const res = await exec(check.command, { cwd: opts.cwd, signal: opts.signal, timeoutMs });
    const ok = res.code === 0 && !res.timedOut;
    const output = tail(res.timedOut ? `${res.output}\n[timed out after ${opts.config.verify.timeoutSec}s]` : res.output);
    ran.push({ command: check.command, ok });
    opts.onCheck?.({ command: check.command, ok, output });
    if (!ok) return { ok: false, skipped: false, ran, failure: { command: check.command, output, code: res.code, timedOut: res.timedOut, spawnFailed: res.spawnFailed } };
  }
  return { ok: true, skipped: false, ran };
}

export interface AttemptState {
  tier: ModelTier;
  /** Failed attempts so far on the current tier. */
  failuresOnTier: number;
}

export type NextAttempt =
  | { action: 'retry'; tier: ModelTier }
  | { action: 'escalate'; from: ModelTier; tier: ModelTier }
  | { action: 'give_up' };

/**
 * Retry policy after a failed attempt: retry the same model `retriesPerModel` times,
 * then move one tier up the ladder, then give up. Pure, so it is easy to test and tune.
 */
export function nextAttempt(state: AttemptState, config: SmartConfig): NextAttempt {
  if (state.failuresOnTier <= config.escalation.retriesPerModel) return { action: 'retry', tier: state.tier };
  const up = escalate(state.tier, config);
  return up ? { action: 'escalate', from: state.tier, tier: up } : { action: 'give_up' };
}
