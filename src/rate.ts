import type { SmartConfig } from './core/config.js';
import { routeWithSession } from './core/pipeline/session.js';
import type { History } from './core/rating/learn.js';
import { rateTask, rungLabel } from './core/rating/rate.js';
import { route } from './core/router.js';
import type { Conversation } from './core/store/conversation.js';
import type { Classification, Limits, RouteDecision } from './core/types.js';
import { pct, tightest, windowLabel } from './core/usage.js';

/** What `--rate` can know without calling a model: your history, the last account limits seen, and this folder's conversation. */
export interface RateContext {
  history?: History;
  limits?: Limits | null;
  conversation?: Conversation | null;
  nowMs?: number;
}

/** The classification a real run would start from when the classifier is unavailable: the local signals alone, Sonnet as floor. */
const OFFLINE: Classification = { complexity: 'multi_file', needsPlan: false, reason: 'offline', fallback: true };

const label = (d: RouteDecision): string => `${d.tier}${d.effort ? ` · ${d.effort}` : ''}`;

const SOURCE: Record<string, string> = {
  override: 'a forced model',
  step: 'your choice for the step',
  keyword: 'a keyword rule (routing.keywordRules)',
  fallback: 'the rater (local signals only)',
  complexity: 'the rater',
  session: 'a session rule (account limit or warm cache)',
};

/**
 * `smart --rate "<task>"`: how smart would route a request, and why, with no model call and no cost. It goes through the
 * same router as a real run (keyword rules, the rater with your history, the account-limit downshift and the warm-cache
 * rule for this folder's conversation). What it cannot know offline is the classifier's view of the request and the planner's
 * rating of each step; both are blended into the score in a real run, so the choice there can differ by a rung.
 */
export function describeRating(text: string, config: SmartConfig, ctxOrHistory?: History | RateContext): string[] {
  const ctx: RateContext = ctxOrHistory instanceof Map ? { history: ctxOrHistory } : (ctxOrHistory ?? {});
  const nowMs = ctx.nowMs ?? Date.now();
  const rating = rateTask({ text, config, history: ctx.history });
  const routed = route({ classification: OFFLINE, text, history: ctx.history }, config);
  const conv = ctx.conversation ?? null;
  const final = conv
    ? routeWithSession(routed, { conv, limits: ctx.limits ?? null, config, nowMs })
    : routeWithSession(routed, { conv: { id: '', sessionId: null, tasks: [] }, limits: ctx.limits ?? null, config, nowMs });
  const question = rateTask({ text, config, history: ctx.history, floorTier: config.routing.trivial });

  const signals = rating.detail[0]?.replace(/^local signals: /, '') ?? '';
  const t = tightest(ctx.limits ?? null, nowMs);
  const limitLine = !t
    ? 'Account limits: none seen yet (they arrive with the first call)'
    : config.usage.downshiftAt && t.window.utilization >= config.usage.downshiftAt
      ? `Account limits: ${windowLabel(t.name)} at ${pct(t.window.utilization)} (≥ usage.downshiftAt ${pct(config.usage.downshiftAt)}): automatic Opus choices become Sonnet`
      : `Account limits: ${windowLabel(t.name)} at ${pct(t.window.utilization)}, below usage.downshiftAt (${pct(config.usage.downshiftAt)}): no effect`;
  const warmLine = !conv || conv.sessionId === null || conv.tasks.length === 0
    ? 'Warm cache: no conversation to continue in this folder: no effect'
    : config.session.keepWarmTier && conv.lastCallAt !== undefined && nowMs - conv.lastCallAt <= config.session.cacheTtlSec * 1000
      ? `Warm cache: this folder's conversation last used ${conv.lastTier ?? '?'} ${Math.round((nowMs - conv.lastCallAt) / 1000)} s ago; a follow-up will not drop to a cheaper model with a cold cache`
      : 'Warm cache: the conversation here has gone cold: no effect';
  const learning = rating.detail.find((d) => d.startsWith('history:'));

  return [
    `Task: ${text.length > 100 ? `${text.slice(0, 97)}...` : text}`,
    '',
    `Decision: ${label(final)} for a change, decided by ${SOURCE[final.source ?? 'complexity']}${final.tier !== routed.tier ? ` (the rater chose ${label(routed)})` : ''}`,
    `If it is only a question: ${rungLabel(question.rung)}${question.rung.tier === 'haiku' ? ' (or answered by the classifier in the same call)' : ''}`,
    `Score ${rating.score.toFixed(2)} on 0 (routine) to 1 (hardest); confidence ${Math.round(rating.confidence * 100)}%.`,
    '  Confidence is a heuristic, not a probability: high when the signals agree and the score is clear of a rung boundary.',
    `Signals: ${signals}`,
    `Floor: ${config.routing.multi_file} (routing.<complexity> floors; a real run uses the classifier's complexity, e.g. a question may go to ${config.routing.trivial})`,
    ...(routed.source === 'keyword' ? [`Override: ${routed.reason}; effort still follows the score`] : []),
    `Learning: ${learning ?? (ctx.history?.size ? 'your history has no verdict for this rung and score band yet' : 'no history yet')}`,
    limitLine,
    warmLine,
    '',
    'No model was called. A real run also blends in the classifier\'s complexity and difficulty, and the planner\'s rating of each step.',
    `Tune it with routing.optimize (${config.routing.optimize} now${config.routing.optimize !== 'balanced' ? `: optimize=${config.routing.optimize} shifts the boundaries` : ''}), the routing.<complexity> floors, keywordRules and runner.effort; see ROUTING.md.`,
  ];
}
