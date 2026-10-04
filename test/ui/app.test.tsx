import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeResult, RunClaudeFn } from '../../src/core/claude.js';
import { SmartError } from '../../src/core/errors.js';
import { emptyUsage } from '../../src/core/types.js';
import { App } from '../../src/ui/App.js';
import { KEYS, makeApp, wait, waitFor } from './helpers.js';

const type = async (stdin: { write: (s: string) => void }, text: string) => {
  stdin.write(text);
  await wait();
  stdin.write(KEYS.enter);
};

describe('App', () => {
  it('shows the idle screen: header, pipeline, panels, input and hints', () => {
    const { lastFrame } = render(<App {...makeApp()} />);
    const f = lastFrame()!;
    expect(f).toContain('smart');
    expect(f).toContain('classify');
    expect(f).toContain('Plan');
    expect(f).toContain('Output');
    expect(f).toContain('What should we build?');
    expect(f).toContain('[model:auto]');
    expect(f).toContain('Enter send');
  });

  it('runs a task end to end and shows classification, routing, output and cost', async () => {
    const executor: RunClaudeFn = async (o) => {
      o.onEvent?.({ kind: 'tool', name: 'Edit', summary: 'Edit src/a.ts', writtenFile: 'src/a.ts' });
      o.onEvent?.({ kind: 'text', text: 'Edited the file.' });
      return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: { ...emptyUsage(), costUsd: 0.05, outputTokens: 200 }, sessionId: 's', numTurns: 1 };
    };
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'small_edit', executor })} />);
    await type(stdin, 'make the parser handle empty input');
    await waitFor(() => lastFrame()!.includes('✓ Done'));
    const f = lastFrame()!;
    expect(f).toContain('> make the parser handle empty input');
    expect(f).toContain('Classified as small_edit');
    expect(f).toContain('Sonnet');
    expect(f).toMatch(/sonnet · \w+ · rated \d\.\d\d/); // the rater's reason is shown
    expect(f).toContain('Edit src/a.ts');
    expect(f).toContain('Edited the file.');
    expect(f).toContain('session $0.06');
  });

  it('dry run shows classification, plan and per-step model without executing', async () => {
    const executor = vi.fn<RunClaudeFn>();
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'trivial', executor })} initial={{ prompt: 'what is a monad', dryRun: true }} />);
    await waitFor(() => lastFrame()!.includes('✓ Done'));
    const f = lastFrame()!;
    expect(f).toContain('Dry run');
    expect(f).toContain('Haiku');
    expect(f).toMatch(/haiku · rated \d\.\d\d/);
    expect(f).toContain('[dry-run]');
    expect(executor).not.toHaveBeenCalled();
    void stdin;
  });

  it('/dry toggles dry-run and /model forces a model, shown as tags', async () => {
    const { stdin, lastFrame } = render(<App {...makeApp()} />);
    await type(stdin, '/dry');
    await waitFor(() => lastFrame()!.includes('[dry-run]'));
    await type(stdin, '/model opus');
    await waitFor(() => lastFrame()!.includes('[model:opus]'));
    await type(stdin, '/model auto');
    await waitFor(() => lastFrame()!.includes('[model:auto]'));
    await type(stdin, '/dry');
    await waitFor(() => !lastFrame()!.includes('[dry-run]'));
  });

  it('shows a chat indicator after a task and /new resets it', async () => {
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'trivial' })} />);
    expect(lastFrame()).not.toContain('[chat:');
    await type(stdin, 'first task');
    await waitFor(() => lastFrame()!.includes('[chat:1]'));
    await type(stdin, '/new');
    await waitFor(() => lastFrame()!.includes('Started a new conversation'));
    expect(lastFrame()).not.toContain('[chat:');
  });

  it('/mode sets a permission mode, shows it as a tag, and passes it to Claude', async () => {
    const seen: (string | undefined)[] = [];
    const executor: RunClaudeFn = async (o) => {
      seen.push(o.permissionMode);
      return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 };
    };
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'small_edit', executor })} />);
    await type(stdin, '/mode plan');
    await waitFor(() => lastFrame()!.includes('[mode:plan]'));
    expect(lastFrame()).toContain('read-only');
    await type(stdin, 'look at the code');
    await waitFor(() => lastFrame()!.includes('✓ Done'));
    expect(seen).toEqual(['plan']);
    await type(stdin, '/mode auto');
    await waitFor(() => !lastFrame()!.includes('[mode:plan]'));
  });

  it('makes bypass mode obvious in the header, from config or /mode, and quiet in the default mode', async () => {
    const quiet = render(<App {...makeApp()} />);
    await waitFor(() => quiet.lastFrame()!.includes('smart'));
    expect(quiet.lastFrame()).not.toContain('bypass');
    const cfg = render(<App {...makeApp({ config: (c) => { c.runner.permissionMode = 'bypassPermissions'; } })} />);
    await waitFor(() => cfg.lastFrame()!.includes('bypass: runs any command'));
    const { stdin, lastFrame } = render(<App {...makeApp()} />);
    await type(stdin, '/mode bypass');
    await waitFor(() => lastFrame()!.includes('bypass: runs any command'));
    expect(lastFrame()).toContain('without asking');
    await type(stdin, '/mode default');
    await waitFor(() => !lastFrame()!.includes('bypass: runs any command'));
  });

  it('/undo and /diff say so when there is no git repository to work with', async () => {
    const { stdin, lastFrame } = render(<App {...makeApp()} />);
    await type(stdin, '/undo');
    await waitFor(() => lastFrame()!.includes('Undo needs a git repository'));
    await type(stdin, '/diff');
    await waitFor(() => lastFrame()!.includes('Diff needs a git repository'));
  });

  it('/usage, /cost and /config print account limits, session spend and the effective settings', async () => {
    const ctx = makeApp({ complexity: 'small_edit' });
    const { stdin, lastFrame } = render(<App {...ctx} />);
    await type(stdin, '/usage');
    await waitFor(() => lastFrame()!.includes('No account usage seen yet'));
    await type(stdin, '/config');
    await waitFor(() => lastFrame()!.includes('Routing: trivial→haiku'));
    expect(lastFrame()).toContain('Escalation: retry 1× per model');
    await type(stdin, '/cost');
    await waitFor(() => lastFrame()!.includes('Nothing spent in this session yet'));
    await type(stdin, 'do a small thing');
    await waitFor(() => lastFrame()!.includes('✓ Done'));
    await type(stdin, '/cost');
    await waitFor(() => lastFrame()!.includes('This session: 1 task'));
  });

  it('shows account usage in the header once Claude reports it, and /usage details it', async () => {
    const executor: RunClaudeFn = async (o) => {
      o.onEvent?.({ kind: 'limits', windows: { five_hour: { utilization: 0.74, resetsAt: Date.now() / 1000 + 8040 }, seven_day: { utilization: 0.18 } } });
      return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 };
    };
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'small_edit', executor })} />);
    await type(stdin, 'x');
    await waitFor(() => lastFrame()!.includes('5h 74%'));
    await type(stdin, '/usage');
    await waitFor(() => lastFrame()!.includes('Account usage (from Claude'));
    expect(lastFrame()).toContain('resets in 2h');
  });

  it('shows startup notices', async () => {
    const { lastFrame } = render(<App {...makeApp()} startupNotices={['Continuing your previous conversation here (2 earlier tasks).']} />);
    await waitFor(() => lastFrame()!.includes('Continuing your previous conversation'));
  });

  it('warns about unknown commands and shows help', async () => {
    const { stdin, lastFrame } = render(<App {...makeApp()} />);
    await type(stdin, '/bogus');
    await waitFor(() => lastFrame()!.includes('Unknown command /bogus'));
    await type(stdin, '/help');
    await waitFor(() => lastFrame()!.includes('/stats'));
  });

  it('forced --model from the CLI applies to routing', async () => {
    const { lastFrame } = render(<App {...makeApp({ complexity: 'trivial' })} initial={{ prompt: 'x', dryRun: true, model: 'opus' }} />);
    await waitFor(() => lastFrame()!.includes('✓ Done'));
    expect(lastFrame()).toContain('forced to opus');
    expect(lastFrame()).toContain('[model:opus]');
  });

  it('Esc cancels a running step', async () => {
    let started = false;
    const executor: RunClaudeFn = (o) =>
      new Promise<ClaudeResult>((_, reject) => {
        started = true;
        o.signal?.addEventListener('abort', () => reject(new SmartError('cancelled', 'Cancelled.')));
      });
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'small_edit', executor })} />);
    await type(stdin, 'do a thing');
    await waitFor(() => started);
    expect(lastFrame()).toContain('Working');
    stdin.write(KEYS.esc);
    await waitFor(() => lastFrame()!.includes('Step cancelled.'), 4000);
    expect(lastFrame()).toContain('Cancelled.');
    expect(lastFrame()).not.toContain('Working');
  });

  it('shows the plan approval screen and runs only approved steps', async () => {
    const calls: string[] = [];
    const executor: RunClaudeFn = async (o) => {
      calls.push(o.prompt);
      return { isError: false, subtype: 'success', text: 'ok', structured: undefined, usage: emptyUsage(), sessionId: 's', numTurns: 1 };
    };
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'large_build', executor })} />);
    await type(stdin, 'build something big');
    await waitFor(() => lastFrame()!.includes('Review plan'), 4000);
    await wait(120); // Ink attaches the key listener in an effect just after the first render
    expect(lastFrame()).toContain('1. First');
    stdin.write(KEYS.down);
    await wait();
    stdin.write(' '); // skip step 2
    await wait();
    stdin.write(KEYS.enter);
    await waitFor(() => lastFrame()!.includes('✓ Done'), 4000);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('do 1');
    expect(lastFrame()).toContain('1. First');
  });

  it('never renders a frame as tall as the terminal (Ink clears the whole screen when it does, which flickers)', async () => {
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'large_build' })} />);
    const rows = 30; // ink-testing-library's default stdout has no rows; App falls back to 30
    expect(lastFrame()!.split('\n').length).toBeLessThan(rows);
    await type(stdin, 'build something big');
    await waitFor(() => lastFrame()!.includes('Review plan'), 4000);
    await wait(120); // Ink attaches the key listener in an effect just after the first render
    expect(lastFrame()!.split('\n').length).toBeLessThan(rows);
    stdin.write(KEYS.enter);
    await waitFor(() => lastFrame()!.includes('✓ Done'), 4000);
    expect(lastFrame()!.split('\n').length).toBeLessThan(rows);
  });

  it('Esc at the approval screen cancels the task', async () => {
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'large_build' })} />);
    await type(stdin, 'build something big');
    await waitFor(() => lastFrame()!.includes('Review plan'), 4000);
    await wait(120); // Ink attaches the key listener in an effect just after the first render
    stdin.write(KEYS.esc);
    await waitFor(() => lastFrame()!.includes('Cancelled.'), 4000);
    expect(lastFrame()).not.toContain('Review plan');
  });

  it('shows /stats history from the tracker and closes with Esc', async () => {
    const ctx = makeApp({ complexity: 'trivial' });
    const { stdin, lastFrame } = render(<App {...ctx} />);
    await type(stdin, 'what is the first task?');
    await waitFor(() => lastFrame()!.includes('✓ Done'));
    await type(stdin, '/stats');
    await waitFor(() => lastFrame()!.includes('Usage history'));
    expect(lastFrame()).toContain('first task');
    expect(lastFrame()).toContain('haiku'); // a plain question is rated low enough for Haiku
    stdin.write(KEYS.esc);
    await waitFor(() => !lastFrame()!.includes('Usage history'));
  });

  it('one-shot mode exits with the task result', async () => {
    const onExit = vi.fn();
    render(<App {...makeApp({ complexity: 'trivial' })} initial={{ prompt: 'quick question' }} oneShot onExit={onExit} />);
    await waitFor(() => onExit.mock.calls.length === 1, 4000);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('one-shot mode reports failure', async () => {
    const onExit = vi.fn();
    const executor: RunClaudeFn = async () => {
      throw new SmartError('auth', 'not logged in', 'Run `claude` to log in');
    };
    const { lastFrame } = render(<App {...makeApp({ complexity: 'small_edit', executor })} initial={{ prompt: 'x' }} oneShot onExit={onExit} />);
    // One-shot mode exits shortly after finishing and the screen is cleared on exit, so read the error while it is on screen.
    await waitFor(() => lastFrame()!.includes('Run `claude` to log in'), 4000);
    expect(lastFrame()).toContain('not logged in');
    await waitFor(() => onExit.mock.calls.length === 1, 4000);
    expect(onExit).toHaveBeenCalledWith(3); // the same exit code as `smart -p`: Claude Code not available
  });

  it('Tab moves focus between panels', async () => {
    const { stdin, lastFrame } = render(<App {...makeApp({ complexity: 'trivial' })} initial={{ prompt: 'x', dryRun: true }} />);
    await waitFor(() => lastFrame()!.includes('✓ Done'));
    stdin.write(KEYS.tab);
    await wait();
    stdin.write(KEYS.tab);
    await wait();
    stdin.write(KEYS.esc); // back to input
    await wait();
    expect(lastFrame()).toContain('Type another task…');
  });
});
