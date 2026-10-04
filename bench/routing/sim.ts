import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ClaudeResult, RunClaudeFn, RunClaudeOptions } from '../../src/core/claude.js';
import { defaultConfig, type SmartConfig } from '../../src/core/config.js';
import { EventBus, type SmartEvent } from '../../src/core/events.js';
import { Pipeline } from '../../src/core/pipeline.js';
import { emptyUsage, type ModelTier, type Usage } from '../../src/core/types.js';
import type { ExecFn } from '../../src/core/verifier.js';
import { TASKS, type BenchTask } from './tasks.js';

/**
 * Routing benchmark, simulated. It runs the real Pipeline (classifier handling, rater, router, effort, escalation ladder,
 * verification, review, accounting) with a stand-in for Claude Code whose behaviour follows a small, explicit model:
 *
 *   - an attempt at a step succeeds when  capability(model, effort) + noise >= the step's true difficulty  (tasks.ts);
 *     noise is uniform in ±NOISE and drawn from a seeded generator keyed by (seed, task, step, attempt), so every strategy
 *     faces the same luck on the same attempt (common random numbers);
 *   - a wrong result fails the project's checks when it has any; without checks, the reviewer catches it with REVIEW_CATCH;
 *   - tokens, cost and time per call follow TOKENS, PRICE and SPEED below.
 *
 * Every number here is an assumption, written down so it can be argued with. The benchmark is a reproducible way to see how
 * the routing logic behaves on a fixed task set under those assumptions; it is not a measurement of real model quality.
 * `--live` (live.ts) runs real tasks against the real Claude Code instead.
 */

/** How hard a step a (model, effort) gets right on an average day (0..1, same scale as BenchStep.difficulty). */
export const CAPABILITY: Record<string, number> = {
  'haiku/-': 0.3,
  'sonnet/low': 0.45, 'sonnet/medium': 0.55, 'sonnet/high': 0.62, 'sonnet/xhigh': 0.64, 'sonnet/max': 0.65, 'sonnet/-': 0.58,
  'opus/low': 0.66, 'opus/medium': 0.76, 'opus/high': 0.83, 'opus/xhigh': 0.88, 'opus/max': 0.9, 'opus/-': 0.8,
};
export const NOISE = 0.15;
/** Chance the reviewer flags a wrong result, by reviewer model; it wrongly fails a right one 5% of the time. */
export const REVIEW_CATCH: Record<ModelTier, number> = { haiku: 0.5, sonnet: 0.75, opus: 0.85 };
const REVIEW_FALSE_ALARM = 0.05;
/** USD per million tokens: input, output, cache read (list prices of the current Haiku, Sonnet and Opus at the time of writing). */
export const PRICE: Record<ModelTier, { input: number; output: number; cacheRead: number }> = {
  haiku: { input: 1, output: 5, cacheRead: 0.1 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3 },
  opus: { input: 5, output: 25, cacheRead: 0.5 },
};
/** Output tokens scale with thinking effort. */
const EFFORT_OUT: Record<string, number> = { low: 0.6, medium: 1, high: 1.5, xhigh: 2.1, max: 2.8, '-': 1.2 };
/** Output tokens per second, and Claude Code's own start-up per call. */
const SPEED: Record<ModelTier, number> = { haiku: 150, sonnet: 70, opus: 45 };
const STARTUP_MS = 1500;
const CHECK_MS = 4000;

export interface Strategy {
  name: string;
  /** Always this model (no escalation, like `--model`). */
  force?: ModelTier;
  config?: (c: SmartConfig) => void;
}

export const STRATEGIES: Strategy[] = [
  { name: 'smart' },
  { name: 'always haiku', force: 'haiku' },
  { name: 'always sonnet', force: 'sonnet' },
  { name: 'always sonnet · high', force: 'sonnet', config: (c) => { c.runner.effort.sonnet = 'high'; } },
  { name: 'always opus', force: 'opus' },
  { name: 'always opus · high', force: 'opus', config: (c) => { c.runner.effort.opus = 'high'; } },
];

// ---- deterministic randomness --------------------------------------------------------------

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A number in [0, 1) fixed by its key (mulberry32 of the key's hash). */
export function draw(key: string): number {
  let t = (hash(key) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const capability = (tier: ModelTier, effort?: string): number => CAPABILITY[`${tier}/${tier === 'haiku' ? '-' : (effort ?? '-')}`] ?? CAPABILITY[`${tier}/-`]!;
export const succeeds = (tier: ModelTier, effort: string | undefined, difficulty: number, u: number): boolean => capability(tier, effort) + (u - 0.5) * 2 * NOISE >= difficulty;

// ---- one simulated task ----------------------------------------------------------------------

export interface TaskRun {
  task: string;
  category: string;
  strategy: string;
  seed: number;
  /** The pipeline reported the task done. */
  ok: boolean;
  /** Every step's accepted result was actually right (known to the simulation only). */
  correct: boolean;
  steps: number;
  /** Steps that passed on their first attempt. */
  firstTry: number;
  attempts: number;
  escalations: number;
  /** Model and effort of the first attempt of each step. */
  firstRoutes: string[];
  usage: Usage;
  latencyMs: number;
  checks: { ran: number; failed: number };
  reviews: { passed: number; failed: number };
}

const tierOf = (model: string): ModelTier => (/opus/.test(model) ? 'opus' : /haiku/.test(model) ? 'haiku' : 'sonnet');

function callUsage(tier: ModelTier, input: number, output: number, cacheRead: number): Usage {
  const p = PRICE[tier];
  return { ...emptyUsage(), inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, costUsd: (input * p.input + output * p.output + cacheRead * p.cacheRead) / 1e6 };
}

const role = (o: RunClaudeOptions): 'classifier' | 'planner' | 'reviewer' | 'answer' | 'executor' => {
  const props = (o.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (props && 'complexity' in props) return 'classifier';
  if (props && 'steps' in props) return 'planner';
  if (props && 'pass' in props) return 'reviewer';
  return o.tools?.length === 0 ? 'answer' : 'executor';
};

export async function simulateTask(task: BenchTask, strategy: Strategy, seed: number): Promise<TaskRun> {
  const cwd = mkdtempSync(join(tmpdir(), 'smart-bench-'));
  const correct = new Map<number, boolean>();
  const attemptsOf = new Map<number, number>();
  let current = 0;
  let latencyMs = 0;
  let answerCorrect: boolean | undefined;
  const key = (...parts: (string | number)[]) => [seed, task.id, ...parts].join('/');
  const timed = (tier: ModelTier, u: Usage): ClaudeResult => {
    latencyMs += STARTUP_MS + (u.outputTokens / SPEED[tier]) * 1000 + (u.inputTokens / 20_000) * 1000;
    return { isError: false, subtype: 'success', text: 'done', structured: undefined, usage: u, sessionId: 'bench', numTurns: 1 };
  };

  const run: RunClaudeFn = async (o) => {
    const tier = tierOf(o.model);
    const effortMul = EFFORT_OUT[o.effort ?? '-'] ?? 1;
    switch (role(o)) {
      case 'classifier': {
        const c = task.classifier;
        // The classifier's own answer is right when the question is within its reach (it is the same model answering).
        if (c.answer) answerCorrect = succeeds(tier, undefined, task.steps[0]!.difficulty, draw(key('answer')));
        return { ...timed(tier, callUsage(tier, 700, 70, 0)), structured: { complexity: c.complexity, needsPlan: c.needsPlan, reason: `bench: ${task.category}`, ...(c.difficulty ? { difficulty: c.difficulty } : {}), ...(c.answer ? { answer: c.answer } : {}) } };
      }
      case 'planner':
        return {
          ...timed(tier, callUsage(tier, 3500, Math.round(700 * effortMul), 0)),
          structured: {
            summary: task.prompt,
            steps: task.steps.map((s, i) => ({ title: s.title, instructions: `${s.title} for: ${task.prompt} [bench:${i}]`, acceptance: ['it works'], ...(s.plannerDifficulty ? { difficulty: s.plannerDifficulty } : {}) })),
          },
        };
      case 'reviewer': {
        const right = correct.get(current) === true;
        const u = draw(key('review', current, attemptsOf.get(current) ?? 0));
        const pass = right ? u >= REVIEW_FALSE_ALARM : u >= REVIEW_CATCH[tier];
        return { ...timed(tier, callUsage(tier, 3000, Math.round(90 * effortMul), 0)), structured: { pass, issues: pass ? [] : ['bench: the result is wrong'] } };
      }
      case 'answer': {
        answerCorrect = succeeds(tier, o.effort, task.steps[0]!.difficulty, draw(key('answer')));
        return timed(tier, callUsage(tier, 1500, Math.round(500 * effortMul), 0));
      }
      case 'executor': {
        const m = /\[bench:(\d+)\]/.exec(o.prompt);
        current = m ? Number(m[1]) : 0;
        const step = task.steps[current]!;
        const n = (attemptsOf.get(current) ?? 0) + 1;
        attemptsOf.set(current, n);
        const right = succeeds(tier, o.effort, step.difficulty, draw(key('step', current, n)));
        correct.set(current, right);
        if (!task.readOnly) {
          const file = step.docsOnly ? `docs/step-${current}.md` : `src/step-${current}.ts`;
          mkdirSync(dirname(join(cwd, file)), { recursive: true });
          writeFileSync(join(cwd, file), `attempt ${n}\n`);
          o.onEvent?.({ kind: 'tool', name: 'Write', summary: `Write ${file}`, writtenFile: file });
        }
        const input = 6000 + 1500 * current + (n > 1 ? 600 : 0);
        return timed(tier, callUsage(tier, input, Math.round((300 + 2500 * step.difficulty) * effortMul), 18_000));
      }
    }
  };
  const exec: ExecFn = async () => {
    latencyMs += CHECK_MS;
    return correct.get(current) ? { code: 0, output: 'ok' } : { code: 1, output: 'bench: a test fails' };
  };

  const config = defaultConfig();
  config.verify.auto = false;
  config.verify.commands = task.checks ? ['bench-check'] : [];
  strategy.config?.(config);
  const bus = new EventBus();
  const events: SmartEvent[] = [];
  bus.subscribe((e) => events.push(e));
  let clock = Date.UTC(2026, 0, 1);
  const pipeline = new Pipeline(config, bus, cwd, {
    run, exec, uid: 1000, listFiles: () => [], projectContext: () => '', now: () => new Date((clock += 1000)), sleep: async () => undefined,
  });
  pipeline.forceModel(strategy.force ?? null);
  try {
    const summary = await pipeline.runTask(task.prompt, { autoApprove: true });
    const of = <T extends SmartEvent['type']>(t: T) => events.filter((e): e is Extract<SmartEvent, { type: T }> => e.type === t);
    const ran = summary.steps.filter((s) => s.outcome !== 'skipped');
    const firstRoutes = of('step:start').filter((e) => e.attempt === 1).map((e) => `${e.route.tier}${e.route.effort ? ` · ${e.route.effort}` : ''}`);
    const answered = answerCorrect !== undefined && ran.length === 1 && ran[0]!.title === 'Reply';
    const allRight = answered ? answerCorrect === true : task.steps.every((_, i) => correct.get(i) === true);
    return {
      task: task.id, category: task.category, strategy: strategy.name, seed,
      ok: summary.ok, correct: summary.ok && allRight,
      steps: ran.length, firstTry: ran.filter((s) => s.outcome === 'done' && s.attempts === 1).length,
      attempts: ran.reduce((n, s) => n + s.attempts, 0), escalations: of('step:escalate').length, firstRoutes,
      usage: summary.totals, latencyMs: Math.round(latencyMs),
      checks: { ran: of('step:verify').length, failed: of('step:verify').filter((e) => !e.ok).length },
      reviews: { passed: of('step:review').filter((e) => !e.skipped && e.pass).length, failed: of('step:review').filter((e) => !e.pass).length },
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ---- the whole benchmark ---------------------------------------------------------------------

export interface StrategySummary {
  strategy: string;
  runs: number;
  /** Done and actually right. */
  success: number;
  /** Reported done (right or not). */
  completed: number;
  /** Reported done but wrong: nothing caught it. */
  silentFailure: number;
  /** Steps right on the first attempt, of all steps run. */
  firstTry: number;
  attemptsPerTask: number;
  escalationsPerTask: number;
  costPerTask: number;
  tokensPerTask: { input: number; output: number; cacheRead: number };
  latencyPerTaskMs: number;
  /** Share of first attempts on each model. */
  models: Record<string, number>;
}

export function summarize(runs: TaskRun[]): StrategySummary[] {
  const by = new Map<string, TaskRun[]>();
  for (const r of runs) by.set(r.strategy, [...(by.get(r.strategy) ?? []), r]);
  return [...by.entries()].map(([strategy, rs]) => {
    const n = rs.length;
    const steps = rs.reduce((x, r) => x + r.steps, 0) || 1;
    const firsts = rs.flatMap((r) => r.firstRoutes.map((f) => f.split(' ')[0]!));
    const models: Record<string, number> = {};
    for (const f of firsts) models[f] = (models[f] ?? 0) + 1 / (firsts.length || 1);
    const mean = (f: (r: TaskRun) => number) => rs.reduce((x, r) => x + f(r), 0) / n;
    return {
      strategy, runs: n,
      success: mean((r) => (r.correct ? 1 : 0)), completed: mean((r) => (r.ok ? 1 : 0)), silentFailure: mean((r) => (r.ok && !r.correct ? 1 : 0)),
      firstTry: rs.reduce((x, r) => x + r.firstTry, 0) / steps,
      attemptsPerTask: mean((r) => r.attempts), escalationsPerTask: mean((r) => r.escalations),
      costPerTask: mean((r) => r.usage.costUsd),
      tokensPerTask: { input: mean((r) => r.usage.inputTokens), output: mean((r) => r.usage.outputTokens), cacheRead: mean((r) => r.usage.cacheReadTokens) },
      latencyPerTaskMs: mean((r) => r.latencyMs), models,
    };
  });
}

export async function runBenchmark(o: { seeds: number; strategies?: Strategy[]; tasks?: BenchTask[] }): Promise<TaskRun[]> {
  const out: TaskRun[] = [];
  for (const strategy of o.strategies ?? STRATEGIES) {
    for (let seed = 1; seed <= o.seeds; seed++) for (const task of o.tasks ?? TASKS) out.push(await simulateTask(task, strategy, seed));
  }
  return out;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x: number) => `$${x.toFixed(3)}`;

export function formatReport(runs: TaskRun[], seeds: number): string {
  const rows = summarize(runs);
  const lines = [
    `Routing benchmark (simulated): ${new Set(runs.map((r) => r.task)).size} tasks × ${seeds} seeds per strategy. Assumptions: bench/routing/sim.ts.`,
    '',
    '| strategy | success | silent failure | first try | attempts/task | escalations/task | cost/task | tokens in/out/cache (k) | time/task | first model |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.strategy} | ${pct(r.success)} | ${pct(r.silentFailure)} | ${pct(r.firstTry)} | ${r.attemptsPerTask.toFixed(2)} | ${r.escalationsPerTask.toFixed(2)} | ${usd(r.costPerTask)} | ${(r.tokensPerTask.input / 1000).toFixed(1)}/${(r.tokensPerTask.output / 1000).toFixed(1)}/${(r.tokensPerTask.cacheRead / 1000).toFixed(1)} | ${(r.latencyPerTaskMs / 1000).toFixed(1)}s | ${Object.entries(r.models).map(([m, s]) => `${m} ${pct(s)}`).join(', ')} |`),
    '',
    'Per category, smart:',
    '',
    '| category | success | first route(s) | attempts | cost |',
    '| --- | --- | --- | --- | --- |',
  ];
  const smart = runs.filter((r) => r.strategy === 'smart');
  for (const id of new Set(smart.map((r) => r.task))) {
    const rs = smart.filter((r) => r.task === id);
    const routes = [...new Set(rs.flatMap((r) => r.firstRoutes))].join('; ');
    lines.push(`| ${rs[0]!.category} (${id}) | ${pct(rs.filter((r) => r.correct).length / rs.length)} | ${routes} | ${(rs.reduce((x, r) => x + r.attempts, 0) / rs.length).toFixed(1)} | ${usd(rs.reduce((x, r) => x + r.usage.costUsd, 0) / rs.length)} |`);
  }
  return lines.join('\n');
}
