import type { SmartConfig } from '../config.js';
import { SmartError, type ErrorKind } from '../errors.js';
import type { FailureKind } from '../store/tracker.js';
import type { ModelTier } from '../types.js';
import { nextAttempt, type NextAttempt } from '../verifier.js';

/**
 * Why an attempt at a step did not pass, and what that means for the next one. Kept pure so the policy is easy to test.
 *
 *   model        Claude Code reported an error doing the work (max turns, an execution error)
 *   verify       a check ran and failed: the work is wrong, or broke something
 *   review       the reviewer found a concrete problem
 *   timeout      a check ran out of time: the work may hang (an infinite loop), or the suite is just slow
 *   environment  something around the work failed before it could be judged: Claude Code never started or said nothing, a check
 *                could not run at all (command not found). A bigger model would not change that.
 *   budget       the task's budget (or a call's share of it) ran out
 *   limit        the account's usage limit refused the call
 *   cancelled    you stopped it
 */
export type { FailureKind };

/** Exit codes that mean "the command does not exist": POSIX shells (127) and cmd.exe (9009). */
const NOT_FOUND_CODES = new Set([127, 9009]);

/**
 * A failed check: environment (it could not be started, or its command does not exist), timeout, or a real verification
 * failure. A check killed by a signal (a crashing test) is a verification failure: the work may well have caused it.
 */
export function checkFailureKind(r: { code: number | null; timedOut?: boolean; spawnFailed?: boolean }): FailureKind {
  if (r.timedOut) return 'timeout';
  if (r.spawnFailed || (r.code !== null && NOT_FOUND_CODES.has(r.code))) return 'environment';
  return 'verify';
}

/** A Claude Code call that failed for a step. Only `claude` errors reach here; the others stop the whole task. */
export function callFailureKind(e: unknown): FailureKind {
  if (e instanceof SmartError) {
    if (e.kind === 'cancelled') return 'cancelled';
    if (e.kind === 'limit') return 'limit';
    if (e.noOutput) return 'environment';
    // Claude Code stopped the call at its --max-budget-usd (our step or task budget; result subtype `error_max_budget_usd`):
    // retrying cannot help. Only that marker counts: a model's own words about a budget do not.
    if (/\berror_max_budget_usd\b|--max-budget-usd/i.test(e.message)) return 'budget';
  }
  return 'model';
}

/** Failures that say nothing about how well the model did the work: learning ignores them (see rating/learn.ts). */
export const NOT_THE_MODEL: ReadonlySet<FailureKind> = new Set(['environment', 'budget', 'limit', 'cancelled', 'timeout']);

export type AfterFailure = NextAttempt | { action: 'stop'; reason: string };

/**
 * What to do after a failed attempt.
 *  - environment: a check that could not run fails again whoever does the work, so stop at once and say what is missing; a Claude
 *    Code that did not start gets one more try on the same model (often a one-off), never a bigger model.
 *  - budget: stop; there is nothing left to spend.
 *  - anything else: the usual ladder (retry the model `retriesPerModel` times, then one tier up), or, for a model you forced,
 *    retries on that model only.
 */
export function afterFailure(a: {
  kind: FailureKind;
  tier: ModelTier;
  failuresOnTier: number;
  /** Environment failures so far in this step. */
  environmentFailures: number;
  /** The failure came from a check (as opposed to Claude Code). */
  fromCheck: boolean;
  forced: boolean;
  config: SmartConfig;
}): AfterFailure {
  if (a.kind === 'budget') return { action: 'stop', reason: 'budget' };
  if (a.kind === 'environment') {
    if (a.fromCheck) return { action: 'stop', reason: 'a check could not run' };
    return a.environmentFailures <= 1 ? { action: 'retry', tier: a.tier } : { action: 'stop', reason: 'Claude Code did not start' };
  }
  if (a.forced) return a.failuresOnTier <= a.config.escalation.retriesPerModel ? { action: 'retry', tier: a.tier } : { action: 'give_up' };
  return nextAttempt({ tier: a.tier, failuresOnTier: a.failuresOnTier }, a.config);
}

/** Why a task did not finish, for `-p --output-format json` and the exit code (see src/exitCodes.ts). */
export interface TaskFailure {
  kind: FailureKind | ErrorKind;
  message: string;
  stepId?: string;
}
