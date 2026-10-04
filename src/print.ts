import type { EventBus, SmartEvent } from './core/events.js';
import type { Pipeline } from './core/pipeline.js';
import { formatEstimate } from './core/rating/estimate.js';
import { forTerminal } from './core/text.js';
import type { Plan, RouteDecision, Usage } from './core/types.js';

export interface PrintOptions {
  format: 'text' | 'json';
  /** Also print tool calls and streamed text (to stderr). */
  verbose: boolean;
  dryRun?: boolean;
  noPlan?: boolean;
  /** Continue the unfinished task instead of starting `prompt`. */
  resume?: boolean;
}

export interface PrintIO {
  out: { write(s: string): unknown };
  err: { write(s: string): unknown };
}

interface StepInfo {
  id: string;
  title: string;
  model?: string;
  reason?: string;
  attempts: number;
  outcome: 'pending' | 'done' | 'failed' | 'cancelled' | 'skipped';
}

const money = (n: number): string => `$${n.toFixed(n >= 1 ? 2 : 3)}`;
const secs = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))}s`;

/**
 * Headless mode: no TUI, works in pipes and CI. Progress goes to stderr, the final reply to stdout
 * (or one JSON document with `format: 'json'`). Returns the process exit code:
 * 0 done, 1 failed, 130 cancelled.
 */
export async function runPrint(pipeline: Pipeline, bus: EventBus, prompt: string, opts: PrintOptions, io: PrintIO): Promise<number> {
  const steps = new Map<string, StepInfo>();
  let plan: Plan | undefined;
  let routes: Record<string, RouteDecision> = {};
  let classification: string | undefined;
  let errorMessage: string | undefined;
  let changes: { files: number; insertions: number; deletions: number; paths: string[] } | undefined;
  // Progress and replies contain model text: never let escape sequences in it reach the terminal (see core/text.ts).
  const log = (s: string) => io.err.write(`smart: ${forTerminal(s)}\n`);
  const startedAt = Date.now();
  let totals: Usage | undefined;

  const handle = (e: SmartEvent) => {
    switch (e.type) {
      case 'notice':
        log(`${e.level === 'warn' ? 'warning: ' : ''}${e.message}`);
        break;
      case 'classified':
        classification = `${e.classification.complexity} → ${e.route.tier}`;
        log(`classified ${e.classification.complexity} (${e.classification.reason}) → ${e.route.tier}`);
        break;
      case 'plan:ready':
        plan = e.plan;
        routes = e.routes;
        for (const s of e.plan.steps) steps.set(s.id, { id: s.id, title: s.title, model: e.routes[s.id]?.model, reason: e.routes[s.id]?.reason, attempts: 0, outcome: e.done?.includes(s.id) ? 'done' : 'pending' });
        if (e.plan.steps.length > 1) log(`plan: ${e.plan.steps.length} steps — ${e.plan.summary}`);
        break;
      case 'plan:approved':
        for (const s of e.plan.steps) if (s.skipped) steps.set(s.id, { ...(steps.get(s.id) as StepInfo), outcome: 'skipped' });
        break;
      case 'step:start': {
        const st = steps.get(e.stepId);
        if (st) {
          st.attempts = e.attempt;
          st.model = e.route.model;
        }
        const n = plan ? plan.steps.findIndex((s) => s.id === e.stepId) + 1 : 1;
        log(`[${n}/${plan?.steps.length ?? 1}] ${e.title} (${e.route.tier}${e.attempt > 1 ? `, attempt ${e.attempt}` : ''})`);
        break;
      }
      case 'step:output':
        if (opts.verbose) log(`  ${e.kind === 'tool' ? '⏺ ' : ''}${e.text.split('\n')[0]}`);
        break;
      case 'step:verify':
        log(`  ${e.ok ? '✓' : '✗'} ${e.command}${e.ok ? '' : `\n${e.output.split('\n').map((l) => `    ${l}`).join('\n')}`}`);
        break;
      case 'step:review':
        log(e.skipped ? `  review skipped (${e.skipped})` : e.pass ? '  ✓ review: acceptance criteria met' : `  ✗ review found problems:\n${e.issues.map((i) => `    - ${i}`).join('\n')}`);
        break;
      case 'step:escalate':
        log(`  ↑ escalating ${e.from} → ${e.to} (${e.reason})`);
        break;
      case 'step:done': {
        const st = steps.get(e.stepId);
        if (st) st.outcome = 'done';
        break;
      }
      case 'step:failed': {
        const st = steps.get(e.stepId);
        if (st) st.outcome = e.error === 'Cancelled' ? 'cancelled' : 'failed';
        if (e.error !== 'Cancelled') {
          log(`  step failed: ${e.error.split('\n')[0]}`);
          // A failed step is an error for the caller too: without this, --output-format json says ok:false with error:null.
          errorMessage ??= `Step "${st?.title ?? e.stepId}" failed: ${e.error.split('\n')[0]}`;
        }
        break;
      }
      case 'changes':
        changes = { files: e.files.length, insertions: e.insertions, deletions: e.deletions, paths: e.files.map((f) => f.path) };
        log(`changed ${e.files.length} file${e.files.length === 1 ? '' : 's'} (+${e.insertions} −${e.deletions})`);
        break;
      case 'error':
        errorMessage = e.hint ? `${e.message} ${e.hint}` : e.message;
        log(`error: ${errorMessage}`);
        break;
      case 'task:done':
        totals = e.totals;
        break;
      default:
        break;
    }
  };
  const unsubscribe = bus.subscribe(handle);
  // First Ctrl-C cancels cleanly; a second one leaves immediately.
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    pipeline.cancel();
  };
  process.on('SIGINT', onSigint);

  let summary;
  try {
    summary = opts.resume ? await pipeline.resumeTask() : await pipeline.runTask(prompt, { dryRun: opts.dryRun, noPlan: opts.noPlan, autoApprove: true });
  } finally {
    unsubscribe();
    process.off('SIGINT', onSigint);
  }

  const cost = summary.totals.costUsd;
  const code = summary.cancelled ? 130 : summary.ok ? 0 : 1;
  const reply = pipeline.lastReplyText;

  if (opts.format === 'json') {
    io.out.write(
      JSON.stringify(
        {
          ok: summary.ok,
          cancelled: summary.cancelled,
          dryRun: summary.dryRun,
          classification: summary.classification && { complexity: summary.classification.complexity, needsPlan: summary.classification.needsPlan, reason: summary.classification.reason },
          plan: plan && { summary: plan.summary, steps: plan.steps.length },
          steps: [...steps.values()].map((s) => ({ id: s.id, title: s.title, model: s.model, reason: s.reason ?? routes[s.id]?.reason, attempts: s.attempts, outcome: s.outcome })),
          changes: changes ?? null,
          reply: opts.dryRun ? null : reply,
          error: errorMessage ?? null,
          usage: { costUsd: cost, inputTokens: summary.totals.inputTokens, outputTokens: summary.totals.outputTokens, cacheReadTokens: summary.totals.cacheReadTokens },
          durationMs: Date.now() - startedAt,
        },
        null,
        2,
      ) + '\n',
    );
  } else if (opts.dryRun) {
    // Dry run: the plan and the model chosen for each step (and why) is the output.
    io.out.write(`${classification ?? ''}\n`);
    for (const s of steps.values()) io.out.write(`- ${s.title} [${s.model}] ${s.reason ?? ''}\n`);
    if (plan && plan.steps.length > 0) {
      const parts = plan.steps.filter((st) => !st.skipped).map((st) => pipeline.previewStep(plan!, st).estimate);
      io.out.write(`Estimated cost: ${formatEstimate(parts)} if every step passes first time\n`);
    }
  } else if (reply) {
    const clean = forTerminal(reply);
    io.out.write(clean.endsWith('\n') ? clean : `${clean}\n`);
  }
  log(`${code === 0 ? 'done' : code === 130 ? 'cancelled' : 'failed'} in ${secs(Date.now() - startedAt)}${cost > 0 ? ` · ${money(cost)}` : ''}${totals ? '' : ''}`);
  return code;
}
