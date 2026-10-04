import type { RunClaudeFn, RunClaudeOptions } from '../claude.js';
import type { SmartConfig } from '../config.js';
import { cancelled, SmartError } from '../errors.js';
import type { LimitWindow, Usage } from '../types.js';

/** Waits before the retries of a call that found the API overloaded. */
export const OVERLOAD_WAITS_MS = [15_000, 45_000];

export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

export interface CallHooks {
  /** Account usage windows reported in any call's stream. */
  onLimits: (windows: Record<string, LimitWindow>, status?: string) => void;
  /** Spend of a call that ended in an error; `overhead` for classify, plan and review calls (they have a JSON schema). */
  onErrorUsage: (usage: Usage, overhead: boolean) => void;
  notice: (message: string) => void;
}

/**
 * Every Claude call of a pipeline goes through the function this returns:
 *   - account limits reported in any stream reach `onLimits`, and a failed call's spend still counts;
 *   - an overloaded API is waited out (15 s, then 45 s) on the same model instead of counting as a failure;
 *   - tool-less calls start `claude` lean, falling back to a normal start once if that breaks the login.
 */
export function makeRun(run: RunClaudeFn, config: SmartConfig, hooks: CallHooks, sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep): RunClaudeFn {
  const once = async (o: RunClaudeOptions) => {
    try {
      return await run({
        ...o,
        startupTimeoutMs: o.startupTimeoutMs ?? config.runner.startupTimeoutSec * 1000,
        onEvent: (e) => {
          if (e.kind === 'limits') hooks.onLimits(e.windows, e.status);
          o.onEvent?.(e);
        },
      });
    } catch (e) {
      // A call that errors (max turns, budget, ...) still spent tokens: count them, or the budget cap and the totals undercount.
      if (e instanceof SmartError && e.usage) hooks.onErrorUsage(e.usage, o.jsonSchema !== undefined);
      throw e;
    }
  };
  // Overloaded servers: wait and try again rather than count a failure and escalate (a bigger model is no less busy).
  const call = async (o: RunClaudeOptions) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(o);
      } catch (e) {
        const wait = OVERLOAD_WAITS_MS[attempt];
        if (!(e instanceof SmartError) || e.kind !== 'overloaded' || wait === undefined || o.signal?.aborted) throw e;
        hooks.notice(`Claude's servers are overloaded; trying again in ${wait / 1000} s (Esc cancels).`);
        await sleep(wait, o.signal);
        if (o.signal?.aborted) throw cancelled();
      }
    }
  };
  // Tool-less calls (classify, plan, review, small talk) start `claude` lean. If that breaks something that lives in the
  // settings files (an apiKeyHelper login, a provider or proxy in `env`), retry once the normal way; when that works,
  // stop using lean flags for this session. If the normal call fails too, lean was not the problem and stays on.
  let leanOk = true;
  return async (o) => {
    if (!leanOk || !config.runner.leanCalls || o.tools?.length !== 0) return call(o);
    try {
      return await call({ ...o, lean: true });
    } catch (e) {
      if (!(e instanceof SmartError) || (e.kind !== 'auth' && e.kind !== 'claude')) throw e;
      const res = await call(o);
      leanOk = false;
      return res;
    }
  };
}
