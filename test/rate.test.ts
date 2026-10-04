import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { describeRating } from '../src/rate.js';

describe('describeRating (smart --rate)', () => {
  it('shows the signals, the score, the chosen model and effort, and that no model was called', () => {
    const lines = describeRating('the workers stall intermittently, find the root cause of this concurrency bug', defaultConfig()).join('\n');
    expect(lines).toContain('concurrency');
    expect(lines).toMatch(/Decision: (opus|sonnet) · \w+ for a change/);
    expect(lines).toMatch(/Score \d\.\d\d .*confidence \d+%/);
    expect(lines).toContain('No model was called');
    expect(lines).toContain('routing.optimize (balanced now)');
  });

  it('is short for a routine task, truncates a very long request in the header, and reflects the config', () => {
    const cfg = defaultConfig();
    cfg.routing.optimize = 'quality';
    const lines = describeRating(`fix the typo ${'x'.repeat(300)}`, cfg);
    expect(lines[0]!.length).toBeLessThan(120);
    expect(lines.join('\n')).toContain('optimize=quality');
  });

  it('goes through the real router: a keyword rule wins and is named, with effort still from the score', () => {
    const lines = describeRating('fix the race condition in worker.js', defaultConfig()).join('\n');
    expect(lines).toMatch(/Decision: opus · \w+ for a change, decided by a keyword rule/);
    expect(lines).toMatch(/Override: keyword "race condition" → opus/);
  });

  it('says what confidence means instead of presenting it as a probability', () => {
    expect(describeRating('add a button', defaultConfig()).join('\n')).toMatch(/heuristic, not a probability/);
  });

  it('shows the account-limit downshift and the warm-cache rule when they apply', () => {
    const now = Date.UTC(2026, 9, 1, 12);
    const limits = { at: now, windows: { five_hour: { utilization: 0.95, resetsAt: now / 1000 + 3600 } } };
    const hot = describeRating('fix the race condition in worker.js', defaultConfig(), { limits, nowMs: now }).join('\n');
    expect(hot).toMatch(/Decision: sonnet · \w+ for a change, decided by a session rule \(account limit or warm cache\) \(the rater chose opus/);
    expect(hot).toMatch(/5h at 95% .*automatic Opus choices become Sonnet/);
    const conversation = { id: 'c', sessionId: 's', tasks: [{ prompt: 'p', outcome: 'done' as const, files: [], reply: '', at: '' }], lastTier: 'opus' as const, lastCallAt: now - 30_000, lastCallAtByTier: { opus: now - 30_000 } };
    const warm = describeRating('fix the typo in the readme', defaultConfig(), { conversation, nowMs: now }).join('\n');
    expect(warm).toMatch(/Decision: opus/);
    expect(warm).toMatch(/last used opus 30 s ago/);
  });

  it('names what learning did, or that there is no history yet', () => {
    expect(describeRating('add a button', defaultConfig()).join('\n')).toMatch(/Learning: no history yet/);
    const history = new Map([['sonnet/low/low', { n: 20, ok: 4 }], ['sonnet/medium/low', { n: 20, ok: 4 }]]);
    const lines = describeRating('fix the typo in the readme', defaultConfig(), history).join('\n');
    expect(lines).toMatch(/Learning: history: sonnet low passed first try in only 4 of 20/);
  });
});
