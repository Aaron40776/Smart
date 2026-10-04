export type ErrorKind = 'cli_missing' | 'auth' | 'limit' | 'overloaded' | 'cancelled' | 'parse' | 'claude' | 'config' | 'internal';

export class SmartError extends Error {
  /** Spend of a call that ended in an error (it still cost money), so budgets and totals stay honest. */
  usage?: import('./types.js').Usage;
  /** For a `limit` error: when the usage window resets (epoch seconds), if Claude said. */
  resetsAt?: number;
  /**
   * The call never got going (Claude Code did not start, or produced no output at all), so nothing reached the model:
   * a problem with the machine, not with the work, which a bigger model would not fix.
   */
  noOutput?: boolean;

  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'SmartError';
  }
}

export const cliMissing = () =>
  new SmartError(
    'cli_missing',
    'The `claude` CLI was not found on your PATH.',
    'Install Claude Code (https://docs.claude.com/claude-code) and make sure `claude` runs in your shell.',
  );

export const authError = (detail: string) =>
  new SmartError('auth', `Claude Code is not authenticated: ${detail}`, 'Run `claude` once and log in (or set ANTHROPIC_API_KEY).');

/**
 * The Claude account's usage limit is reached. Retrying or switching model cannot help (every call is refused until the
 * window resets), so the task stops at once and can be continued with /resume later.
 */
export const limitError = (detail: string, resetsAt?: number) => {
  const e = new SmartError('limit', `Your Claude usage limit is reached: ${detail}`, 'Run /resume (or `smart --resume`) once it resets to continue from the unfinished step.');
  e.resetsAt = resetsAt;
  return e;
};

/** Anthropic's API is overloaded or failing for everyone: a bigger model would not help, waiting does. */
export const overloadedError = (detail: string) =>
  new SmartError('overloaded', `Claude's servers are overloaded right now: ${detail}`, 'Run /resume (or `smart --resume`) in a few minutes to continue from the unfinished step.');

export const cancelled = () => new SmartError('cancelled', 'Cancelled.');

export const isCancelled = (e: unknown): boolean => e instanceof SmartError && e.kind === 'cancelled';
