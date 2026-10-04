import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { looksSecret, realPathOf, resolveInside } from './paths.js';

const slash = (p: string): string => p.split(sep).join('/');
import type { ClaudeStreamEvent, RunClaudeFn } from './claude.js';
import type { SmartConfig } from './config.js';
import type { Plan, PlanStep, RouteDecision, Usage } from './types.js';

export interface FileContext {
  path: string;
  content: string;
  truncated: boolean;
}

export interface GatherOptions {
  /** Allow absolute paths that resolve inside the project (paths you typed). Model output never gets this. */
  allowAbsolute?: boolean;
  /** Leave out files that usually hold secrets (`.env`, keys): for files smart picks itself, not ones you @mention. */
  skipSecrets?: boolean;
}

/**
 * Reads the files a step names, within a byte budget. Only regular files inside `cwd` are read (a plan is model output, so
 * `../../etc/passwd`, `\\server\share\x` or a symlink out must not leak into a prompt; see paths.ts), each one once.
 */
export function gatherFiles(cwd: string, files: string[], maxBytes: number, opts: GatherOptions = {}): FileContext[] {
  const out: FileContext[] = [];
  if (maxBytes <= 0) return out;
  let budget = maxBytes;
  const seen = new Set<string>();
  for (const f of files) {
    if (budget <= 0) break;
    const inside = resolveInside(cwd, f, { allowAbsolute: opts.allowAbsolute });
    if (!inside || inside.rel === '' || seen.has(inside.abs)) continue;
    if (opts.skipSecrets && looksSecret(inside.rel)) continue;
    seen.add(inside.abs);
    try {
      // Read at most the budget (+1 byte to know if it was cut): a referenced multi-GB log must not be loaded whole.
      const fd = openSync(inside.abs, 'r');
      let buf: Buffer;
      let size: number;
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) continue;
        size = st.size;
        buf = Buffer.alloc(Math.min(size, budget + 1));
        readSync(fd, buf, 0, buf.length, 0);
      } finally {
        closeSync(fd);
      }
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      const slice = buf.subarray(0, budget);
      out.push({ path: inside.rel || f, content: slice.toString('utf8'), truncated: size > slice.length });
      budget -= slice.length;
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * A project-relative path for a file Claude Code reports. It reports real paths, so when the project sits under a
 * symlink (macOS /tmp, a junction, a Windows 8.3 name) the plain relative path starts with `../..`: compare against the real root then.
 */
export function projectRelative(cwd: string, file: string): string {
  const plain = relative(cwd, resolve(cwd, file));
  if (plain !== '' && !plain.startsWith('..')) return slash(plain);
  try {
    // Resolve both sides: the file's own path can pass through a symlink too (macOS: /var is /private/var).
    const viaReal = relative(realpathSync(cwd), realPathOf(resolve(cwd, file)));
    if (viaReal !== '' && !viaReal.startsWith('..') && !isAbsolute(viaReal)) return slash(viaReal);
  } catch {
    /* fall through */
  }
  return slash(plain) || file;
}

export interface StepPromptInput {
  plan: Plan;
  step: PlanStep;
  index: number;
  total: number;
  touchedFiles: string[];
  fileContext: FileContext[];
  /** Verification output from the previous failed attempt, if this is a retry. */
  failure?: string;
  /** Conversation memory to include when the coding session cannot be resumed (new, lost, or resume disabled). */
  memory?: string;
  /** One-off notices for the model, e.g. that the user undid its previous changes. */
  note?: string;
}

/** The lean per-step prompt: the step, its acceptance criteria and only the relevant files. No history. */
export function buildStepPrompt(i: StepPromptInput): string {
  const parts: string[] = [];
  const multi = i.total > 1;
  if (i.note) parts.push(`Note: ${i.note}`);
  if (i.memory) parts.push(`Context from earlier in this conversation (for reference):\n${i.memory}`);
  if (multi) {
    parts.push(`You are executing step ${i.index + 1} of ${i.total} of a plan. Do only this step.`);
    parts.push(`Project goal: ${i.plan.summary}`);
    parts.push(`Step: ${i.step.title}\n${i.step.instructions}`);
  } else {
    // A single-step task is the user's own words: keep them verbatim so follow-ups read naturally.
    parts.push(i.step.instructions);
  }
  if (i.step.acceptance.length) parts.push('Acceptance criteria:\n' + i.step.acceptance.map((a) => `- ${a}`).join('\n'));
  if (i.touchedFiles.length) parts.push('Files changed in earlier steps: ' + i.touchedFiles.join(', '));
  if (i.fileContext.length) {
    parts.push(
      'Current contents of relevant files:\n' +
        i.fileContext.map((f) => `<file path="${f.path}">\n${f.content}${f.truncated ? '\n[truncated]' : ''}\n</file>`).join('\n'),
    );
  }
  if (i.failure) parts.push(`Your previous attempt failed verification. Fix the cause, do not just re-run:\n<failure>\n${i.failure}\n</failure>`);
  return parts.join('\n\n');
}

export const EXECUTOR_APPEND = 'Be terse: no preamble or recap. Never ask questions; make reasonable assumptions. End with one line saying what you did.';

export interface RunStepOptions extends Omit<StepPromptInput, 'fileContext'> {
  /** Files the user referenced with @path; shown to the model along with the step's own files. */
  referenced?: FileContext[];
  config: SmartConfig;
  cwd: string;
  run: RunClaudeFn;
  route: RouteDecision;
  permissionMode: string;
  signal?: AbortSignal;
  /** Persisted Claude Code session to start (resume=false) or continue (resume=true). */
  session?: { id: string; resume: boolean };
  effort?: string;
  onOutput?: (kind: 'text' | 'tool', text: string) => void;
  /** Live text as it is written; the complete text follows through `onOutput`. */
  onDelta?: (text: string) => void;
  /** Most this call may spend (the step cap, or what is left of the task budget). */
  maxBudgetUsd?: number | null;
  onProgress?: (p: { inputTokens: number; outputTokens: number; cacheReadTokens: number; contextTokens?: number }) => void;
}

export interface StepRunResult {
  text: string;
  usage: Usage;
  /** Files Claude Code wrote or edited during this step (paths as reported by the tool). */
  touched: string[];
}

/** Runs one plan step as one headless Claude Code call on the routed model. */
export async function runStep(o: RunStepOptions): Promise<StepRunResult> {
  // A plan step's files are model output: plain project paths only, and no secrets pasted in on smart's own initiative.
  const own = gatherFiles(o.cwd, o.step.files, o.config.limits.maxContextBytes, { skipSecrets: true });
  const fileContext = [...(o.referenced ?? []), ...own.filter((f) => !o.referenced?.some((r) => r.path === f.path))];
  const prompt = buildStepPrompt({ ...o, fileContext });
  const touched = new Set<string>();

  const onEvent = (e: ClaudeStreamEvent) => {
    if (e.kind === 'text') o.onOutput?.('text', e.text);
    else if (e.kind === 'text-delta') o.onDelta?.(e.text);
    else if (e.kind === 'tool') {
      // Show project-relative paths: absolute ones are long and add no information.
      const short = slash(e.summary.split(`${o.cwd}${sep}`).join('').split(`${o.cwd}/`).join(''));
      o.onOutput?.('tool', short.length > 110 ? `${short.slice(0, 107)}...` : short);
      if (e.writtenFile) touched.add(projectRelative(o.cwd, e.writtenFile));
    } else if (e.kind === 'progress') o.onProgress?.(e);
  };

  const result = await o.run({
    prompt,
    model: o.route.model,
    cwd: o.cwd,
    signal: o.signal,
    appendSystemPrompt: EXECUTOR_APPEND,
    permissionMode: o.permissionMode,
    session: o.session,
    effort: o.effort,
    bare: o.config.runner.bare,
    maxBudgetUsd: o.maxBudgetUsd !== undefined ? o.maxBudgetUsd : o.config.limits.maxBudgetUsdPerStep,
    extraArgs: o.config.runner.extraArgs,
    partial: Boolean(o.onDelta),
    onEvent,
  });
  return { text: result.text, usage: result.usage, touched: [...touched] };
}
