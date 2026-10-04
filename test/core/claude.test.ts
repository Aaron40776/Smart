import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { assertFound, buildArgs, resolveClaudeCommand, resolvePermissionMode, runClaude, StreamParser, type ClaudeStreamEvent } from '../../src/core/claude.js';
import { SmartError } from '../../src/core/errors.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

describe('StreamParser', () => {
  it('parses a tool-using run into init/tool/text/progress/result', () => {
    const events = new StreamParser().push(fixture('tool-use.jsonl'));
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('init');
    expect(kinds).toContain('tool');
    expect(kinds).toContain('text');
    const tool = events.find((e) => e.kind === 'tool');
    expect(tool && tool.kind === 'tool' && tool.summary).toMatch(/^Read .*a\.txt/);
    const result = events.find((e) => e.kind === 'result');
    expect(result && result.kind === 'result' && result.result.text).toBe('hello');
    expect(result && result.kind === 'result' && result.result.usage.costUsd).toBeGreaterThan(0);
    expect(result && result.kind === 'result' && result.result.isError).toBe(false);
  });

  it('extracts structured output and hides the StructuredOutput tool', () => {
    const events = new StreamParser().push(fixture('structured.jsonl'));
    expect(events.some((e) => e.kind === 'tool')).toBe(false);
    const r = events.find((e) => e.kind === 'result');
    expect(r && r.kind === 'result' && (r.result.structured as { complexity: string }).complexity).toBeTruthy();
  });

  it('handles lines split across chunks and ignores garbage', () => {
    const p = new StreamParser();
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.5 });
    expect(p.push('not json\n' + line.slice(0, 20))).toEqual([]);
    const out = p.push(line.slice(20) + '\n');
    expect(out).toHaveLength(1);
    expect(p.end()).toEqual([]);
  });

  it('counts each assistant message id once for live progress', () => {
    const msg = (block: object) =>
      JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [block], usage: { input_tokens: 10, output_tokens: 5 } } });
    const p = new StreamParser();
    const a = p.push(msg({ type: 'thinking' }) + '\n' + msg({ type: 'text', text: 'hi' }) + '\n');
    const progress = a.filter((e): e is Extract<ClaudeStreamEvent, { kind: 'progress' }> => e.kind === 'progress');
    expect(progress).toHaveLength(1);
    expect(progress[0]?.outputTokens).toBe(5);
  });

  it('reports the file written by edit tools but not by reads', () => {
    const msg = (name: string, id: string) =>
      JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'tool_use', name, input: { file_path: '/p/a.ts' } }] } });
    const evs = new StreamParser().push([msg('Edit', 'a'), msg('Write', 'b'), msg('Read', 'c')].join('\n') + '\n');
    const tools = evs.filter((e): e is Extract<ClaudeStreamEvent, { kind: 'tool' }> => e.kind === 'tool');
    expect(tools.map((t) => t.writtenFile)).toEqual(['/p/a.ts', '/p/a.ts', undefined]);
  });

  it('does not truncate long tool paths in the parser (the runner shortens them after making them relative)', () => {
    const deep = '/very/long/'.repeat(12) + 'file.ts';
    const evs = new StreamParser().push(JSON.stringify({ type: 'assistant', message: { id: 'x', content: [{ type: 'tool_use', name: 'Read', input: { file_path: deep } }] } }) + '\n');
    const tool = evs.find((e) => e.kind === 'tool');
    expect(tool && tool.kind === 'tool' && tool.summary.endsWith('file.ts')).toBe(true);
  });

  it('flags error results', () => {
    const [ev] = new StreamParser().push(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' }) + '\n');
    expect(ev && ev.kind === 'result' && ev.result.isError).toBe(true);
  });
});

describe('buildArgs / resolvePermissionMode', () => {
  it('lean skips settings, MCP servers and skills; off by default', () => {
    const lean = buildArgs({ prompt: 'x', model: 'haiku', cwd: '.', tools: [], lean: true });
    expect(lean).toEqual(expect.arrayContaining(['--strict-mcp-config', '--disable-slash-commands']));
    expect(lean[lean.indexOf('--setting-sources') + 1]).toBe('');
    expect(buildArgs({ prompt: 'x', model: 'haiku', cwd: '.' })).not.toContain('--strict-mcp-config');
  });

  it('builds headless flags', () => {
    const args = buildArgs({ prompt: 'x', model: 'haiku', cwd: '.', tools: [], systemPrompt: 'sys', jsonSchema: { type: 'object' }, permissionMode: 'acceptEdits', bare: true, maxBudgetUsd: 1, extraArgs: ['--foo'] });
    expect(args).toEqual(expect.arrayContaining(['-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--tools', '', '--system-prompt', 'sys', '--permission-mode', 'acceptEdits', '--bare', '--max-budget-usd', '1', '--foo']));
    expect(args).toContain('--json-schema');
  });

  it('is stateless by default and persists/resumes sessions when asked', () => {
    expect(buildArgs({ prompt: 'x', model: 'm', cwd: '.' })).toContain('--no-session-persistence');
    const first = buildArgs({ prompt: 'x', model: 'm', cwd: '.', session: { id: 'abc', resume: false }, effort: 'low' });
    expect(first).toEqual(expect.arrayContaining(['--session-id', 'abc', '--effort', 'low']));
    expect(first).not.toContain('--no-session-persistence');
    const next = buildArgs({ prompt: 'x', model: 'm', cwd: '.', session: { id: 'abc', resume: true } });
    expect(next).toEqual(expect.arrayContaining(['--resume', 'abc']));
    expect(next).not.toContain('--session-id');
  });

  it('surfaces the errors array of a failed result', () => {
    const [ev] = new StreamParser().push(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: null, errors: ['No conversation found with session ID: x'] }) + '\n');
    expect(ev && ev.kind === 'result' && ev.result.text).toContain('No conversation found');
  });

  it('omits --tools when unset', () => {
    expect(buildArgs({ prompt: 'x', model: 'm', cwd: '.' })).not.toContain('--tools');
  });

  it('falls back from bypassPermissions when root', () => {
    expect(resolvePermissionMode('bypassPermissions', 0).mode).toBe('acceptEdits');
    expect(resolvePermissionMode('bypassPermissions', 0).warning).toMatch(/root/);
    expect(resolvePermissionMode('bypassPermissions', 1000)).toEqual({ mode: 'bypassPermissions' });
    expect(resolvePermissionMode('acceptEdits', 0)).toEqual({ mode: 'acceptEdits' });
  });
});

function fakeSpawn(script: (child: FakeChild) => void) {
  return (() => {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = [];
    child.kill = (sig: string) => {
      child.killed.push(sig);
      setImmediate(() => child.emit('close', null));
      return true;
    };
    setImmediate(() => script(child));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
}
interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: string[];
  kill: (s: string) => boolean;
}

describe('runClaude', () => {
  const base = { prompt: 'hi', model: 'haiku', cwd: '.' };

  it('SMART_DEBUG appends a timing line per call, and does nothing without it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smart-dbg-'));
    const file = join(dir, 'nested', 'debug.log');
    const run = () => runClaude({ ...base, tools: [], lean: true, effort: 'low', spawnImpl: fakeSpawn((c) => { c.stdout.write(fixture('tool-use.jsonl')); c.emit('close', 0); }) });
    await run();
    expect(existsSync(file)).toBe(false);
    vi.stubEnv('SMART_DEBUG', '1');
    vi.stubEnv('SMART_DEBUG_FILE', file);
    try {
      await run();
    } finally {
      vi.unstubAllEnvs();
    }
    const line = JSON.parse(readFileSync(file, 'utf8').trim());
    expect(line).toMatchObject({ model: 'haiku', tools: 'none', lean: true, effort: 'low', session: 'none', exit: 0 });
    expect(line.ms.total).toBeGreaterThanOrEqual(0);
    expect(line.ms.result).not.toBeNull();
  });

  it('streams events and resolves with the result', async () => {
    const seen: string[] = [];
    const res = await runClaude({
      ...base,
      onEvent: (e) => seen.push(e.kind),
      spawnImpl: fakeSpawn((c) => {
        c.stdout.write(fixture('tool-use.jsonl'));
        c.emit('close', 0);
      }),
    });
    expect(res.text).toBe('hello');
    expect(seen).toContain('tool');
  });

  it('maps ENOENT to cli_missing', async () => {
    const spawnImpl = fakeSpawn((c) => c.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })));
    await expect(runClaude({ ...base, spawnImpl })).rejects.toMatchObject({ kind: 'cli_missing' });
  });

  it('maps auth failures', async () => {
    const spawnImpl = fakeSpawn((c) => {
      c.stderr.write('Error: Not logged in. Please run /login');
      c.emit('close', 1);
    });
    await expect(runClaude({ ...base, spawnImpl })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('reports other failures with stderr', async () => {
    const spawnImpl = fakeSpawn((c) => {
      c.stderr.write('boom');
      c.emit('close', 2);
    });
    const err = await runClaude({ ...base, spawnImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(SmartError);
    expect(err.message).toMatch(/boom/);
  });

  it('kills the process and rejects as cancelled on abort', async () => {
    const ac = new AbortController();
    let child!: FakeChild;
    const spawnImpl = fakeSpawn((c) => {
      child = c;
      ac.abort();
    });
    await expect(runClaude({ ...base, signal: ac.signal, spawnImpl })).rejects.toMatchObject({ kind: 'cancelled' });
    expect(child.killed).toContain('SIGTERM');
  });

  it('rejects immediately when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runClaude({ ...base, signal: ac.signal, spawnImpl: fakeSpawn(() => undefined) })).rejects.toMatchObject({ kind: 'cancelled' });
  });
});

describe('resolveClaudeCommand', () => {
  const win = (files: string[], pathVar = 'C:\\Tools;C:\\Users\\me\\AppData\\Roaming\\npm') =>
    resolveClaudeCommand('win32', { PATH: pathVar }, (p) => files.includes(p));

  it('uses plain `claude` on Linux and macOS', () => {
    expect(resolveClaudeCommand('linux', {}, () => false)).toEqual({ cmd: 'claude', prefix: [] });
  });
  it('honours SMART_CLAUDE_BIN', () => {
    expect(resolveClaudeCommand('win32', { SMART_CLAUDE_BIN: 'D:\\c.exe' }, () => false)).toEqual({ cmd: 'D:\\c.exe', prefix: [] });
  });
  it('finds claude.exe on the Windows PATH', () => {
    expect(win(['C:\\Tools\\claude.exe'])).toEqual({ cmd: 'C:\\Tools\\claude.exe', prefix: [] });
  });
  it('runs the npm shim\'s cli.js through node instead of the unspawnable .cmd', () => {
    const dir = 'C:\\Users\\me\\AppData\\Roaming\\npm';
    const cli = `${dir}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    expect(win([`${dir}\\claude.cmd`, cli])).toEqual({ cmd: process.execPath, prefix: [cli] });
  });
  it('reports Claude Code as missing when nothing is found, instead of starting a bare name', () => {
    // A bare `claude` on Windows would be looked up in the project folder first (a planted claude.exe would run).
    expect(win([])).toEqual({ cmd: 'claude', prefix: [], missing: true });
    expect(() => assertFound(win([]))).toThrow(/not found/);
    expect(() => assertFound(win(['C:\\Tools\\claude.exe']))).not.toThrow();
  });
  it('ignores relative PATH entries, which would mean the project folder', () => {
    expect(win(['.\\claude.exe', 'claude.exe', 'bin\\claude.exe'], '.;;bin;C:\\Tools')).toEqual({ cmd: 'claude', prefix: [], missing: true });
    expect(win(['C:\\Tools\\claude.exe'], '.;C:\\Tools')).toEqual({ cmd: 'C:\\Tools\\claude.exe', prefix: [] });
  });
});

describe('argument boundaries', () => {
  it('never puts the prompt on the command line, and keeps flag-like values paired with their option', () => {
    const hostile = '--dangerously-skip-permissions --permission-mode bypassPermissions "; rm -rf ~"';
    const args = buildArgs({ prompt: hostile, model: 'sonnet', cwd: '.', appendSystemPrompt: '--append-me', systemPrompt: '-x', permissionMode: 'acceptEdits' });
    expect(args).not.toContain(hostile);
    expect(args.join(' ')).not.toContain('rm -rf');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('--append-me');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('-x');
    expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
  });

  it('sends the prompt over stdin, verbatim, with no shell in between', async () => {
    const hostile = '$(touch pwned) `id` & del /q *';
    let stdin = '';
    let spawnOpts: { shell?: unknown } | undefined;
    const spawnImpl = ((_cmd: string, _args: string[], opts: { shell?: unknown }) => {
      spawnOpts = opts;
      const c = (fakeSpawn(() => undefined) as unknown as () => FakeChild)();
      c.stdin.on('data', (d: Buffer) => { stdin += d.toString(); });
      setImmediate(() => {
        c.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' })}\n`);
        c.emit('close', 0);
      });
      return c;
    }) as unknown as typeof import('node:child_process').spawn;
    await runClaude({ prompt: hostile, model: 'haiku', cwd: '.', spawnImpl });
    expect(stdin).toBe(hostile);
    expect(spawnOpts?.shell).toBeUndefined();
  });
});

describe('runClaude start-up timeout', () => {
  it('ends a claude that writes nothing at all, and says the call never reached the model', async () => {
    let child!: FakeChild;
    const spawnImpl = fakeSpawn((c) => { child = c; }); // never writes anything
    const err = await runClaude({ prompt: 'hi', model: 'haiku', cwd: '.', spawnImpl, startupTimeoutMs: 50 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmartError);
    expect((err as SmartError).message).toMatch(/no output within 0 s|no output within/);
    expect((err as SmartError).noOutput).toBe(true);
    expect(child.killed).toContain('SIGKILL');
  });

  it('a process that has started writing is never cut off by the start-up limit', async () => {
    const spawnImpl = fakeSpawn((c) => {
      c.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', model: 'haiku', session_id: 's' })}\n`);
      setTimeout(() => {
        c.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'late but fine', session_id: 's' })}\n`);
        c.emit('close', 0);
      }, 120);
    });
    expect((await runClaude({ prompt: 'hi', model: 'haiku', cwd: '.', spawnImpl, startupTimeoutMs: 40 })).text).toBe('late but fine');
  });

  it('marks a process that exited without a word as never having reached the model', async () => {
    const spawnImpl = fakeSpawn((c) => { c.stderr.write('segfault'); c.emit('close', 139); });
    const err = (await runClaude({ prompt: 'hi', model: 'haiku', cwd: '.', spawnImpl }).catch((e: unknown) => e)) as SmartError;
    expect(err.kind).toBe('claude');
    expect(err.noOutput).toBe(true);
  });

  it('drops a runaway line instead of buffering it forever', async () => {
    const { MAX_LINE } = await import('../../src/core/claude.js');
    const p = new StreamParser();
    p.push('x'.repeat(MAX_LINE + 1));
    expect(p.push(`\n${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 's' })}\n`).map((e) => e.kind)).toEqual(['result']);
  });
});
