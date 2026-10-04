#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json`: one message per stdin line, running-total usage and cost like the real CLI.
// Env: FAKE_DIE=1 exit at once (an unusable process), FAKE_SILENT=1 never answer (an old CLI waiting for stdin to close),
//      FAKE_CONTROL=refuse|ignore refuse or ignore a model switch, FAKE_ERROR_TURN=n make message n an error result, FAKE_SLOW_MS delay per message,
//      FAKE_DIE_TURN=n crash in the middle of message n (after some output, before its result).
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
if (process.env.FAKE_DIE) process.exit(3);
if (process.env.FAKE_SILENT) { process.stdin.resume(); await new Promise(() => undefined); }
let model = flag('--model') ?? 'sonnet';
const sessionId = flag('--session-id') ?? flag('--resume') ?? 'fake';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let turn = 0;
let total = { cost: 0, input: 0, output: 0 };
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const d = JSON.parse(line);
  if (d.type === 'control_request') {
    if (process.env.FAKE_CONTROL === 'ignore') return;
    if (process.env.FAKE_CONTROL === 'refuse') {
      out({ type: 'control_response', response: { subtype: 'error', request_id: d.request_id, error: 'unknown model' } });
      return;
    }
    if (d.request.subtype === 'set_model') model = d.request.model;
    out({ type: 'control_response', response: { subtype: 'success', request_id: d.request_id } });
    return;
  }
  if (d.type !== 'user') return;
  turn += 1;
  if (process.env.FAKE_SLOW_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLOW_MS)));
  total = { cost: total.cost + 0.01, input: total.input + 100, output: total.output + 10 };
  out({ type: 'system', subtype: 'init', model, session_id: sessionId });
  out({ type: 'assistant', message: { id: `m${turn}`, model, content: [{ type: 'text', text: `reply ${turn} from ${model}: ${d.message.content}` }], usage: { input_tokens: 100, output_tokens: 10 } } });
  if (Number(process.env.FAKE_DIE_TURN) === turn) process.exit(9);
  const error = Number(process.env.FAKE_ERROR_TURN) === turn;
  out({
    type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: error, result: error ? 'something broke' : `reply ${turn} from ${model}`,
    session_id: sessionId, num_turns: 1, total_cost_usd: total.cost,
    modelUsage: { [model]: { inputTokens: total.input, outputTokens: total.output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  });
});
rl.on('close', () => process.exit(0));
