import type { SmartEvent, Stage, StageStatus } from '../core/events.js';
import type { Classification, Limits, ModelTier, Plan, RouteDecision, Usage } from '../core/types.js';
import { emptyUsage } from '../core/types.js';
import { forTerminal } from '../core/text.js';
import { fmtCost, fmtDuration } from './format.js';

export type StepStatus = 'pending' | 'active' | 'verifying' | 'done' | 'failed' | 'skipped' | 'cancelled';
export type Phase = 'idle' | 'running' | 'approval' | 'finished';

export interface OutputLine {
  id: number;
  kind: 'text' | 'tool' | 'info' | 'warn' | 'error' | 'verify-ok' | 'verify-fail' | 'user' | 'diff-add' | 'diff-del' | 'diff-meta' | 'diff-ctx';
  text: string;
  stepId?: string;
  /** Text still being written (streamed); replaced by the complete text when it arrives. */
  live?: boolean;
}

export interface UiState {
  phase: Phase;
  prompt: string;
  dryRun: boolean;
  stages: Record<Stage, StageStatus>;
  classification?: Classification;
  classifyReason?: string;
  plan?: Plan;
  routes: Record<string, RouteDecision>;
  stepStatus: Record<string, StepStatus>;
  stepAttempt: Record<string, number>;
  /** Tier a step ended up on after escalation. */
  escalatedTo: Record<string, ModelTier>;
  currentStepId?: string;
  output: OutputLine[];
  session: Usage;
  sessionAtTaskStart: Usage;
  ok?: boolean;
  taskStartedAt?: number;
  stepStartedAt: Record<string, number>;
  /** Wall time of finished steps, in ms. */
  stepDuration: Record<string, number>;
  /** Tasks remembered in the current conversation (follow-ups build on them). */
  chatTasks: number;
  /** Latest account usage windows reported by Claude. */
  limits: Limits | null;
  nextId: number;
}

export const MAX_OUTPUT = 800;

export const initialStages = (): Record<Stage, StageStatus> => ({
  classify: 'pending', plan: 'pending', approve: 'pending', execute: 'pending', verify: 'pending', done: 'pending',
});

export const initialState = (): UiState => ({
  phase: 'idle', prompt: '', dryRun: false, stages: initialStages(), routes: {}, stepStatus: {}, stepAttempt: {},
  escalatedTo: {}, output: [], session: emptyUsage(), sessionAtTaskStart: emptyUsage(), chatTasks: 0, limits: null, stepStartedAt: {}, stepDuration: {}, nextId: 1,
});

/** Every line shown goes through here: model text and diffs of your files lose terminal escape sequences (see core/text.ts). */
const push = (s: UiState, kind: OutputLine['kind'], text: string, stepId?: string): UiState => ({
  ...s,
  output: [...s.output, { id: s.nextId, kind, text: forTerminal(text), stepId }].slice(-MAX_OUTPUT),
  nextId: s.nextId + 1,
});

const withDuration = (s: UiState, stepId: string, at?: number): Record<string, number> => {
  const started = s.stepStartedAt[stepId];
  return at !== undefined && started !== undefined ? { ...s.stepDuration, [stepId]: at - started } : s.stepDuration;
};

/** " in 34s · $0.15 · 5/6 steps" for the final line of a task. */
function summaryTail(s: UiState, e: Extract<SmartEvent, { type: 'task:done' }>): string {
  const parts: string[] = [];
  if (e.at !== undefined && s.taskStartedAt !== undefined) parts.push(`in ${fmtDuration(e.at - s.taskStartedAt)}`);
  if (e.totals.costUsd > 0) parts.push(fmtCost(e.totals.costUsd));
  const total = s.plan?.steps.filter((st) => !st.skipped).length ?? 0;
  if (total > 1) parts.push(`${Object.values(s.stepStatus).filter((v) => v === 'done').length}/${total} steps`);
  return parts.length ? ` ${parts.join(' · ')}` : '.';
}

/** Adds a line of user input to the log (dispatched by the App, not the pipeline). */
export type UiAction = SmartEvent | { type: 'ui:user'; text: string } | { type: 'ui:info'; text: string };

/** Pure reducer: pipeline events in, screen state out. */
export function reduce(s: UiState, e: UiAction): UiState {
  switch (e.type) {
    case 'ui:user':
      return push(s, 'user', e.text);
    case 'ui:info':
      return push(s, 'info', e.text);
    case 'task:start':
      return push(
        {
          ...s, phase: 'running', prompt: e.prompt, dryRun: e.dryRun, stages: initialStages(), classification: undefined, classifyReason: undefined,
          plan: undefined, routes: {}, stepStatus: {}, stepAttempt: {}, escalatedTo: {}, currentStepId: undefined, ok: undefined,
          sessionAtTaskStart: s.session, taskStartedAt: e.at, stepStartedAt: {}, stepDuration: {},
        },
        'info', e.dryRun ? 'Dry run: classify and plan only, nothing will execute.' : 'Task started.',
      );
    case 'stage':
      return {
        ...s,
        stages: { ...s.stages, [e.stage]: e.status },
        phase: e.stage === 'approve' && e.status === 'active' ? 'approval' : e.stage === 'approve' && s.phase === 'approval' ? 'running' : s.phase,
      };
    case 'notice':
      return push(s, e.level === 'warn' ? 'warn' : 'info', e.message);
    case 'classified':
      return push({ ...s, classification: e.classification, classifyReason: e.route.reason }, 'info', `Classified as ${e.classification.complexity}: ${e.classification.reason}`);
    case 'plan:ready': {
      const stepStatus = Object.fromEntries(e.plan.steps.map((st) => [st.id, 'pending' as StepStatus]));
      return push({ ...s, plan: e.plan, routes: e.routes, stepStatus }, 'info', `Plan ready: ${e.plan.steps.length} step${e.plan.steps.length === 1 ? '' : 's'}.`);
    }
    case 'plan:approved': {
      const stepStatus = { ...s.stepStatus };
      for (const st of e.plan.steps) if (st.skipped) stepStatus[st.id] = 'skipped';
      return { ...s, plan: e.plan, stepStatus };
    }
    case 'step:start':
      return push(
        {
          ...s, currentStepId: e.stepId, routes: { ...s.routes, [e.stepId]: e.route },
          stepStartedAt: e.at !== undefined && s.stepStartedAt[e.stepId] === undefined ? { ...s.stepStartedAt, [e.stepId]: e.at } : s.stepStartedAt,
          stepStatus: { ...s.stepStatus, [e.stepId]: 'active' }, stepAttempt: { ...s.stepAttempt, [e.stepId]: e.attempt },
        },
        'info', `▶ ${e.title} [${e.route.tier}${e.attempt > 1 ? `, attempt ${e.attempt}` : ''}]`, e.stepId,
      );
    case 'step:stream': {
      // Grow the live line of this step, or start one.
      const last = s.output.at(-1);
      const text = forTerminal(e.text);
      if (last?.live && last.stepId === e.stepId) return { ...s, output: [...s.output.slice(0, -1), { ...last, text: last.text + text }] };
      return { ...s, output: [...s.output, { id: s.nextId, kind: 'text' as const, text, stepId: e.stepId, live: true }].slice(-MAX_OUTPUT), nextId: s.nextId + 1 };
    }
    case 'step:output': {
      // The complete text replaces what was streamed of it; anything else ends a live line as it stands.
      const withoutLive = s.output.filter((l) => !(l.live && l.stepId === e.stepId));
      return push({ ...s, output: withoutLive }, e.kind, e.text, e.stepId);
    }
    case 'tokens':
      return { ...s, session: e.sessionTotal };
    case 'step:verify':
      return push({ ...s, stepStatus: { ...s.stepStatus, [e.stepId]: 'verifying' } }, e.ok ? 'verify-ok' : 'verify-fail', e.ok ? `✓ ${e.command}` : `✗ ${e.command}\n${e.output}`, e.stepId);
    case 'step:review':
      return e.skipped
        ? push(s, 'info', `review skipped (${e.skipped})`, e.stepId)
        : push(s, e.pass ? 'verify-ok' : 'verify-fail', e.pass ? '✓ review: acceptance criteria met' : `✗ review found problems:\n${e.issues.map((i) => `  - ${i}`).join('\n')}`, e.stepId);
    case 'changes': {
      const shown = e.files.slice(0, 4).map((f) => f.path).join(', ');
      const more = e.files.length > 4 ? `, +${e.files.length - 4} more` : '';
      return push(s, 'info', `Changed ${e.files.length} file${e.files.length === 1 ? '' : 's'} (+${e.insertions} −${e.deletions}): ${shown}${more}. /diff to review, /undo to revert.`);
    }
    case 'diff': {
      const lines = e.text.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1);
      let next = s;
      for (const l of lines.slice(0, 250)) {
        const kind = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('@@') ? 'diff-meta' : l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : 'diff-ctx';
        next = push(next, kind, l);
      }
      return lines.length > 250 ? push(next, 'info', `… ${lines.length - 250} more diff lines`) : next;
    }
    case 'step:escalate':
      return push({ ...s, escalatedTo: { ...s.escalatedTo, [e.stepId]: e.to } }, 'warn', `↑ Escalating ${e.from} → ${e.to} (${e.reason})`, e.stepId);
    case 'step:done':
      return { ...s, stepStatus: { ...s.stepStatus, [e.stepId]: 'done' }, stepDuration: withDuration(s, e.stepId, e.at) };
    case 'step:failed':
      return push(
        { ...s, stepStatus: { ...s.stepStatus, [e.stepId]: e.error === 'Cancelled' ? 'cancelled' : 'failed' }, stepDuration: withDuration(s, e.stepId, e.at) },
        e.error === 'Cancelled' ? 'warn' : 'error', e.error === 'Cancelled' ? 'Step cancelled.' : `Step failed: ${e.error}`, e.stepId,
      );
    case 'task:done':
      return push({ ...s, phase: 'finished', ok: e.ok }, e.ok ? 'info' : 'error', `${e.ok ? '✓ Done' : '✗ Task did not complete'}${summaryTail(s, e)}`);
    case 'limits':
      return { ...s, limits: e.limits };
    case 'conversation':
      return { ...s, chatTasks: e.tasks };
    case 'task:cancelled':
      return push({ ...s, phase: 'finished', ok: false }, 'warn', 'Cancelled.');
    case 'error':
      return push({ ...s, phase: 'finished', ok: false }, 'error', e.hint ? `${e.message}\n${e.hint}` : e.message);
    default:
      return s;
  }
}

/** Cost/tokens of the current task, derived from the session totals. */
export function taskUsage(s: UiState): Usage {
  const a = s.session;
  const b = s.sessionAtTaskStart;
  return {
    inputTokens: a.inputTokens - b.inputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens - b.cacheCreationTokens,
    costUsd: a.costUsd - b.costUsd,
  };
}
