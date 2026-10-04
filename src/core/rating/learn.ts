import type { TaskRecord } from '../store/tracker.js';

/**
 * Learning from your own history, with no model calls.
 *
 * Every step records which rung the rater chose and how the step went. A rung "succeeded" when the step passed on its
 * first attempt (no failed check, no retry, no escalation). For the rung and score band about to be used again:
 *   - if it has failed too often (posterior mean below UP_BELOW after MIN_UP steps) it is raised one rung;
 *   - if it has almost never failed (above DOWN_ABOVE after MIN_DOWN steps) its effort is lowered one level, same model.
 * The posterior mean is (successes + 4) / (steps + 5): a prior of "usually works" that data has to overcome.
 * Only the last 30 days count, so a bad patch (a broken test suite, a new project) does not raise costs forever.
 *
 * What does not count, because it says nothing about whether the rung was strong enough:
 *   - steps that stopped for reasons around the work (StepRecord.failure: environment, budget, limit, cancelled, timeout) and
 *     attempts lost to Claude Code not starting (environmentRetries);
 *   - a step that failed even after escalating to the top of the ladder: a stronger start would not have saved it, and a
 *     check that was already broken (an unrelated red test suite) looks exactly like that;
 *   - beyond the most recent PROJECT_CAP steps of one project per rung, so one troubled repository cannot speak for all.
 * `/bad` counts as one miss per task and rung, however many steps the task had. Adjustment is one rung at most (adjustRung),
 * so no amount of history or `/bad` escalates further than that.
 */
export interface RungStats {
  n: number;
  ok: number;
}
export type History = Map<string, RungStats>;

const PRIOR_OK = 4;
const PRIOR_N = 5;
const MIN_UP = 6;
const UP_BELOW = 0.72;
const MIN_DOWN = 15;
const DOWN_ABOVE = 0.95;
const WINDOW_MS = 30 * 86_400_000;
/** At most this many steps of one project count per rung (records from before projects were recorded are not capped). */
export const PROJECT_CAP = 10;
/** Failures that are not the model's (kept in sync with pipeline/outcome.ts NOT_THE_MODEL; learn.ts must not import the pipeline). */
const NOT_THE_MODEL = new Set(['environment', 'budget', 'limit', 'cancelled', 'timeout']);

export const band = (score: number): 'low' | 'mid' | 'high' => (score < 0.3 ? 'low' : score < 0.6 ? 'mid' : 'high');
export const statsKey = (tier: string, effort: string | undefined, score: number): string => `${tier}/${effort ?? '-'}/${band(score)}`;
export const posterior = (s: RungStats): number => (s.ok + PRIOR_OK) / (s.n + PRIOR_N);

export function buildHistory(tasks: TaskRecord[], nowMs = Date.now(), opts: { topTier?: string } = {}): History {
  const top = opts.topTier ?? 'opus';
  // Newest first, so the per-project cap keeps the most recent steps.
  const recent = tasks.filter((t) => nowMs - Date.parse(t.startedAt) <= WINDOW_MS).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const h: History = new Map();
  const perProject = new Map<string, number>();
  for (const t of recent) {
    const badCounted = new Set<string>();
    for (const s of t.steps) {
      // A step that never ran (attempts 0: the task budget was already spent) says nothing about the rung.
      if (!s.rated || s.attempts === 0 || (s.outcome !== 'done' && s.outcome !== 'failed')) continue;
      if (s.failure && NOT_THE_MODEL.has(s.failure)) continue;
      if (s.outcome === 'failed' && s.escalated && s.tier === top) continue;
      const key = statsKey(s.rated.tier, s.rated.effort, s.rated.score);
      const bad = t.feedback === 'bad';
      if (bad && badCounted.has(key)) continue; // one /bad, one miss for this rung
      if (t.project) {
        const pk = `${t.project}\0${key}`;
        const used = perProject.get(pk) ?? 0;
        if (used >= PROJECT_CAP) continue;
        perProject.set(pk, used + 1);
      }
      if (bad) badCounted.add(key);
      const cur = h.get(key) ?? { n: 0, ok: 0 };
      cur.n += 1;
      // Attempts lost to Claude Code not starting are not the model's; /bad (your verdict) is a miss even though checks passed.
      const modelAttempts = s.attempts - (s.environmentRetries ?? 0);
      cur.ok += s.outcome === 'done' && modelAttempts <= 1 && !bad ? 1 : 0;
      h.set(key, cur);
    }
  }
  return h;
}

export interface RungLike {
  tier: string;
  effort?: string;
}

/** Returns the index of the rung to use after applying what history says about `rungs[idx]`. */
export function adjustRung(idx: number, floorIdx: number, score: number, rungs: readonly RungLike[], history: History | undefined): { idx: number; note?: string } {
  const rung = rungs[idx];
  const stats = rung && history?.get(statsKey(rung.tier, rung.effort, score));
  if (!rung || !stats) return { idx };
  const p = posterior(stats);
  const label = `${rung.tier}${rung.effort ? ` ${rung.effort}` : ''}`;
  if (stats.n >= MIN_UP && p < UP_BELOW && idx + 1 < rungs.length) {
    return { idx: idx + 1, note: `history: ${label} passed first try in only ${stats.ok} of ${stats.n} similar steps, so one level up` };
  }
  const below = rungs[idx - 1];
  if (stats.n >= MIN_DOWN && p > DOWN_ABOVE && idx - 1 >= floorIdx && below && below.tier === rung.tier) {
    return { idx: idx - 1, note: `history: ${label} passed first try in ${stats.ok} of ${stats.n} similar steps, so one effort level down` };
  }
  return { idx };
}
