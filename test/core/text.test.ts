import { describe, expect, it } from 'vitest';
import { block, forTerminal, oneLine } from '../../src/core/text.js';
import { initialState, reduce } from '../../src/ui/state.js';

describe('forTerminal: model text cannot drive your terminal', () => {
  it('removes OSC (title, clipboard, links), CSI (clear screen, cursor), DCS and lone control characters', () => {
    expect(forTerminal('a\u001b]0;evil title\u0007b')).toBe('ab');
    expect(forTerminal('copy\u001b]52;c;ZXZpbA==\u001b\\ me')).toBe('copy me');
    expect(forTerminal('\u001b[2J\u001b[Hhi\u001b[31m red\u001b[0m')).toBe('hi red');
    expect(forTerminal('x\u001bPq#0;2;0;0;0\u001b\\y')).toBe('xy');
    expect(forTerminal('a\u0007b\u0008c\u0085d')).toBe('abcd');
    expect(forTerminal('a\u009b2Jb')).toBe('ab'); // 8-bit CSI
    expect(forTerminal('line\r\nnext\tcol\rover')).toBe('line\nnext\tcolover');
  });

  it('keeps ordinary text, markdown and non-ASCII intact', () => {
    const md = '# Title\n\n- **bold** `code` ü 日本 🚀\n```ts\nconst a = 1;\n```';
    expect(forTerminal(md)).toBe(md);
  });

  it('oneLine and block clean and cap', () => {
    expect(oneLine('  a\n\n b \u001b[1m c ', 50)).toBe('a b c');
    expect(oneLine('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(block('para one\n\npara two\u0007', 100)).toBe('para one\n\npara two');
  });

  it('the TUI shows streamed and complete step text without escape sequences', () => {
    let s = reduce(initialState(), { type: 'step:stream', stepId: 's1', text: 'hello \u001b' });
    s = reduce(s, { type: 'step:stream', stepId: 's1', text: '[2Jworld' });
    expect(s.output.at(-1)!.text).not.toContain('\u001b');
    s = reduce(s, { type: 'step:output', stepId: 's1', kind: 'text', text: 'done \u001b]0;x\u0007ok' });
    expect(s.output.at(-1)!.text).toBe('done ok');
    s = reduce(s, { type: 'diff', text: '+added \u001b[31mline' });
    expect(s.output.map((l) => l.text).join('\n')).not.toContain('\u001b');
  });
});
