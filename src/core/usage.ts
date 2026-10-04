import type { SmartConfig } from './config.js';
import type { Limits, LimitWindow, RouteDecision } from './types.js';
import { modelFor } from './router.js';

/** The two windows Claude reports for subscriptions. Other windows, if any, are still kept. */
const WINDOW_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' };
export const windowLabel = (name: string): string => WINDOW_LABEL[name] ?? name.replace(/_/g, ' ');

export const pct = (u: number): string => `${Math.round(u * 100)}%`;

/** "2h 14m", "45m", "now". `resetsAt` is epoch seconds. */
export function fmtReset(resetsAt: number | undefined, nowMs: number): string {
  if (resetsAt === undefined) return '';
  const s = Math.round(resetsAt - nowMs / 1000);
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${Math.max(1, m)}m`;
}

/** Colour band used by the header meter and bars. */
export const pressure = (u: number): 'ok' | 'warn' | 'high' => (u >= 0.85 ? 'high' : u >= 0.6 ? 'warn' : 'ok');

/** The most constraining window (highest utilization), for warnings and routing. */
export function tightest(limits: Limits | null, nowMs = Date.now()): { name: string; window: LimitWindow } | null {
  if (!limits) return null;
  // A window that has already reset says nothing about now (limits.json can be hours old).
  const entries = Object.entries(limits.windows).filter(([, w]) => w.resetsAt === undefined || w.resetsAt * 1000 > nowMs);
  if (entries.length === 0) return null;
  const [name, window] = entries.reduce((a, b) => (b[1].utilization > a[1].utilization ? b : a));
  return { name, window };
}

/**
 * Limit-aware routing: when the account is close to a usage limit, automatic routing stops picking Opus (which burns
 * the allowance fastest) and uses Sonnet instead. Forced models, your per-step choices and escalations are not touched.
 */
export function applyLimitPressure(decision: RouteDecision, limits: Limits | null, config: SmartConfig, nowMs: number = Date.now()): RouteDecision {
  const at = config.usage.downshiftAt;
  if (!at || decision.tier !== 'opus') return decision;
  if (decision.source === 'override' || decision.source === 'step') return decision;
  const t = tightest(limits, nowMs);
  if (!t || t.window.utilization < at) return decision;
  return {
    ...decision,
    tier: 'sonnet',
    model: modelFor('sonnet', config),
    reason: `${decision.reason}; ${windowLabel(t.name)} limit at ${pct(t.window.utilization)} so using sonnet instead of opus`,
    source: 'session',
  };
}

export const bar = (share: number, width = 10): string => {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
};

/** Lines for /usage: account windows as reported by Claude, with a bar and a reset countdown. */
export function usageLines(limits: Limits | null, nowMs: number): string[] {
  if (!limits || Object.keys(limits.windows).length === 0) {
    return ['No account usage seen yet. Claude reports it on each call, so it appears after your first task.'];
  }
  const age = Math.max(0, Math.round((nowMs - limits.at) / 60_000));
  const lines = [`Account usage (from Claude, ${age < 1 ? 'just now' : `${age}m ago`}):`];
  for (const [name, w] of Object.entries(limits.windows)) {
    const reset = fmtReset(w.resetsAt, nowMs);
    lines.push(`  ${windowLabel(name).padEnd(4)} ${bar(w.utilization)} ${pct(w.utilization).padStart(4)}${reset ? `  resets in ${reset}` : ''}`);
  }
  if (limits.status && limits.status !== 'allowed') lines.push(`  status: ${limits.status}`);
  return lines;
}
