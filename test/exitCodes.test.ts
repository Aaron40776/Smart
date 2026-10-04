import { describe, expect, it } from 'vitest';
import { EXIT, exitCodeFor } from '../src/exitCodes.js';
import { errorDocument } from '../src/print.js';

describe('exit code contract', () => {
  it('maps every failure kind to its documented code', () => {
    expect(exitCodeFor(undefined)).toBe(0);
    for (const k of ['model', 'verify', 'review', 'timeout', 'environment', 'claude', 'internal', 'parse']) expect(exitCodeFor(k), k).toBe(EXIT.failed);
    expect(exitCodeFor('config')).toBe(2);
    expect(exitCodeFor('cli_missing')).toBe(3);
    expect(exitCodeFor('auth')).toBe(3);
    expect(exitCodeFor('budget')).toBe(4);
    expect(exitCodeFor('limit')).toBe(5);
    expect(exitCodeFor('overloaded')).toBe(5);
    expect(exitCodeFor('resume')).toBe(6);
    expect(exitCodeFor('cancelled')).toBe(130);
  });

  it('error documents are valid JSON with the same fields as a task result', () => {
    const j = JSON.parse(errorDocument('config', 'Invalid config in x.json', 'Fix it.'));
    expect(j).toEqual({ ok: false, cancelled: false, error: 'Invalid config in x.json Fix it.', failure: { kind: 'config', message: 'Invalid config in x.json' }, exitCode: 2 });
  });
});
