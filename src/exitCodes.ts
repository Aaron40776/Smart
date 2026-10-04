/**
 * smart's exit codes: the contract for scripts (`smart -p`), CI and the one-shot UI (`smart "task"`). README lists them.
 *
 *   0    the task finished (a dry run that planned counts as finished)
 *   1    the task did not finish: a step failed its checks or review, Claude Code reported an error, a check could not run, ...
 *        (`-p --output-format json` says which in `failure.kind`)
 *   2    smart was used wrongly: an invalid option or argument, or an invalid config file
 *   3    Claude Code is not available: not installed, or not logged in
 *   4    the task stopped at its budget (`--budget`, limits.maxBudgetUsdPerTask / PerStep)
 *   5    try again later: the account's usage limit is reached, or Anthropic's API is overloaded (the task is resumable)
 *   6    `--resume` with nothing to resume
 *   130  cancelled (Ctrl+C / Esc); 143 and 129 when ended by SIGTERM / SIGHUP
 */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  claudeUnavailable: 3,
  budget: 4,
  later: 5,
  nothingToResume: 6,
  cancelled: 130,
  sighup: 129,
  sigterm: 143,
} as const;

/** The exit code for a failure kind (a step's FailureKind or a SmartError's kind); undefined kind means success. */
export function exitCodeFor(kind: string | undefined, ok = kind === undefined): number {
  if (ok) return EXIT.ok;
  switch (kind) {
    case 'cancelled':
      return EXIT.cancelled;
    case 'budget':
      return EXIT.budget;
    case 'limit':
    case 'overloaded':
      return EXIT.later;
    case 'cli_missing':
    case 'auth':
      return EXIT.claudeUnavailable;
    case 'config':
      return EXIT.usage;
    case 'resume':
      return EXIT.nothingToResume;
    default:
      return EXIT.failed;
  }
}
