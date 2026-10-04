import type { SmartConfig } from '../config.js';
import { effortAt } from '../rating/rate.js';
import { applyWarmCache, plannerTier } from '../router.js';
import type { Conversation } from '../store/conversation.js';
import type { Classification, Limits, ModelTier, RouteDecision } from '../types.js';
import { applyLimitPressure } from '../usage.js';

/**
 * The rater's choice, adjusted for the account and the conversation: near a usage limit automatic Opus choices become
 * Sonnet, and follow-up tasks avoid downgrading to a model with a cold cache (see applyWarmCache). Within one task every
 * step is routed on its own merits, so a single escalated step cannot drag the rest up.
 */
export function routeWithSession(decision: RouteDecision, s: { conv: Conversation; limits: Limits | null; config: SmartConfig; nowMs: number }): RouteDecision {
  const pressured = applyLimitPressure(decision, s.limits, s.config, s.nowMs);
  const followUp = s.conv.tasks.length > 0 && s.conv.sessionId !== null;
  const out = s.config.session.resume && followUp ? applyWarmCache(pressured, s.conv, s.nowMs, s.config) : pressured;
  // If a rule swapped the model, the rated effort belongs to the model that is no longer used.
  return out.tier !== decision.tier && out.score !== undefined ? { ...out, effort: effortAt(out.tier, out.score) } : out;
}

/** While an account usage window is nearly used up, plan with Sonnet instead of the (heavier) configured planner model. */
export function plannerDownshift(classification: Classification, score: number, limits: Limits | null, config: SmartConfig, nowMs: number = Date.now()): ModelTier | null {
  const tier = plannerTier(classification, config, score);
  const probe = applyLimitPressure({ tier, model: config.models[tier], reason: 'planner', source: 'complexity' }, limits, config, nowMs);
  return probe.tier !== tier ? probe.tier : null;
}

/**
 * A Claude Code session that has grown big makes every later step expensive: each turn re-reads all of it. Past
 * `session.maxContextTokens` the next task starts a fresh session, and the first step gets the compact summary of the
 * conversation instead (the same memory used when a saved session is lost). Returns the size when it is time, else null.
 */
export function sessionTooBig(conv: Conversation, config: SmartConfig): number | null {
  const max = config.session.maxContextTokens;
  const size = conv.contextTokens ?? 0;
  return max && conv.sessionId && size >= max ? size : null;
}
