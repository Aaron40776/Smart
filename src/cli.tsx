import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { render } from 'ink';
import pkg from '../package.json' with { type: 'json' };
import { resolveClaudeCommand } from './core/claude.js';
import { createClaudeRunner } from './core/claudeProcess.js';
import { classifierCall } from './core/classifier.js';
import { expandHome, globalConfigPath, loadConfig } from './core/config.js';
import { EventBus } from './core/events.js';
import { SmartError } from './core/errors.js';
import { createCheckpoints } from './core/checkpoint.js';
import { ConversationStore, newConversation } from './core/store/conversation.js';
import { InputHistory } from './core/store/inputHistory.js';
import { Pipeline } from './core/pipeline.js';
import { isTier } from './core/router.js';
import { buildHistory } from './core/rating/learn.js';
import { initConfig } from './init.js';
import { trustProject } from './trust.js';
import { updateSmart } from './update.js';
import { describeRating } from './rate.js';
import { runPrint } from './print.js';
import { Tracker } from './core/store/tracker.js';
import { LimitsStore } from './core/store/limits.js';
import type { ModelTier } from './core/types.js';
import { App } from './ui/App.js';
import { CLEAR_PROGRESS } from './ui/progress.js';

function parseModel(value: string): ModelTier {
  const v = value.toLowerCase();
  if (!isTier(v)) throw new InvalidArgumentError('use haiku, sonnet or opus (names map to models in smart.config.json)');
  return v;
}

/** True while the interactive UI owns the alternate screen. Errors must be printed after leaving it, or the exit wipes them. */
let altScreenActive = false;

const fail = (message: string, hint?: string): never => {
  if (altScreenActive) process.stdout.write('\x1b[?1049l');
  process.stderr.write(`smart: ${message}\n${hint ? `${hint}\n` : ''}`);
  process.exit(1);
};

interface Options {
  dryRun?: boolean;
  model?: ModelTier;
  plan: boolean;
  config?: string;
  continue?: boolean;
  resume?: boolean;
  rate?: boolean;
  print?: boolean;
  outputFormat: 'text' | 'json';
  verbose?: boolean;
  budget?: number;
  review: boolean;
}

const parseFormat = (v: string): 'text' | 'json' => {
  if (v !== 'text' && v !== 'json') throw new InvalidArgumentError('use text or json');
  return v;
};
const parseBudget = (v: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('must be a positive number of dollars');
  return n;
};

/** Read all of stdin (for `echo "task" | smart -p`). */
async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

async function main() {
  const argv = process.argv.slice(2);
  // `smart update` pulls the latest version into the folder smart was cloned to and rebuilds it. Like `init`, only as the
  // whole command line, so a task that starts with the word ("update the readme") still runs as a task.
  if (argv.length === 1 && argv[0] === 'update') process.exit(updateSmart(fileURLToPath(new URL('..', import.meta.url))));

  // `smart init [--global] [--force]` writes a starter config. Only when it is the whole command line, so a task
  // that merely starts with the word "init" (`smart init the repo`) still runs as a task.
  const initFlags = argv.slice(1);
  if (argv[0] === 'init' && initFlags.length <= 2 && initFlags.every((f) => f === '--force' || f === '--global')) {
    const target = initFlags.includes('--global') ? globalConfigPath() : join(process.cwd(), 'smart.config.json');
    const r = initConfig(target, initFlags.includes('--force'));
    process.stdout.write(`${r.message}\n`);
    process.exit(r.ok ? 0 : 1);
  }

  // `smart trust [--remove]` allows (or withdraws) the settings of this directory's smart.config.json that cross the trust
  // boundary. Whole command line only, like `init`.
  if (argv[0] === 'trust' && (argv.length === 1 || (argv.length === 2 && argv[1] === '--remove'))) {
    const r = trustProject(process.cwd(), { remove: argv[1] === '--remove' });
    (r.ok ? process.stdout : process.stderr).write(`${r.message}\n`);
    process.exit(r.ok ? 0 : 1);
  }

  const program = new Command()
    .name('smart')
    .description('Run Claude Code through a router that picks the cheapest capable model for each step.')
    .version(pkg.version)
    .argument('[task...]', 'task to run (omit for interactive mode)')
    .option('--dry-run', 'classify and plan only; show the model chosen per step, run nothing')
    .option('--model <name>', 'force a model tier for every step: haiku | sonnet | opus', parseModel)
    .option('--no-plan', 'skip the planning step and run the task as a single step')
    .option('--config <path>', 'path to a smart.config.json')
    .option('-c, --continue', 'continue the previous conversation in this directory')
    .option('--rate', 'show how the task would be rated (model and effort) and why; calls no model')
    .option('--resume', 'continue the last failed or cancelled task from its first unfinished step (implies -c)')
    .option('-p, --print', 'headless mode: no UI, progress on stderr, final reply on stdout (reads the task from stdin if none given)')
    .option('--output-format <format>', 'with --print: text (default) or json', parseFormat, 'text')
    .option('--verbose', 'with --print: also stream tool calls to stderr')
    .option('--budget <usd>', 'stop a task once it has cost this many dollars', parseBudget)
    .option('--no-review', 'skip the acceptance review after each step')
    .parse();

  const opts = program.opts<Options>();
  if (opts.resume) opts.continue = true;
  const task = program.args.join(' ').trim();
  const cwd = process.cwd();

  let loaded;
  try {
    loaded = loadConfig(cwd, opts.config);
  } catch (e) {
    return fail((e as Error).message);
  }
  const { config } = loaded;
  const configWarnings = loaded.warnings;
  const configNotices = loaded.notices;
  if (opts.budget) config.limits.maxBudgetUsdPerTask = opts.budget;
  if (!opts.review) config.review.enabled = false;

  if (opts.rate) {
    if (!task) return fail('give the task to rate: smart --rate "fix the race condition in worker.js"');
    const tracker = new Tracker(expandHome(config.trackerPath));
    process.stdout.write(`${describeRating(task, config, buildHistory(tracker.load())).join('\n')}\n`);
    process.exit(0);
  }

  const claude = resolveClaudeCommand();
  if (spawnSync(claude.cmd, [...claude.prefix, '--version'], { stdio: 'ignore' }).error) {
    const err = new SmartError('cli_missing', 'The `claude` CLI was not found on your PATH.', 'Install Claude Code (https://docs.claude.com/claude-code), then run `claude` once to log in.');
    return fail(err.message, err.hint);
  }
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (!opts.print && !interactive) {
    return fail('an interactive terminal is required (stdin and stdout must be a TTY). Use `smart -p "task"` for scripts and pipes.');
  }

  const trackerPath = expandHome(config.trackerPath);
  const tracker = new Tracker(trackerPath);
  const bus = new EventBus();
  const conversationStore = new ConversationStore(expandHome(config.conversationsPath));
  const stored = conversationStore.load(cwd);
  const previous = opts.continue ? stored : null;
  // A fresh conversation still keeps the file-undo history of this directory: /undo and /diff work across restarts.
  const conversation = previous ?? (stored?.undo ? { ...newConversation(), undo: stored.undo } : undefined);
  const startupNotices = [...configWarnings, ...configNotices, ...(opts.continue
    ? [previous ? `Continuing your previous conversation here (${previous.tasks.length} earlier task${previous.tasks.length === 1 ? '' : 's'}).` : 'No previous conversation in this directory; starting a new one.']
    : [])];
  const checkpoints = await createCheckpoints(cwd);
  process.on('exit', () => checkpoints.dispose());
  const limitsStore = new LimitsStore(expandHome(config.limitsPath));
  // Coding steps reuse one running `claude` per conversation (runner.keepAlive); it is ended when smart exits.
  // Short tool-less calls (classify, plan, review) use pre-started spares in the interactive app (see spares.ts).
  const run = createClaudeRunner({ keepAlive: config.runner.keepAlive, spares: !opts.print, onNotice: (message) => bus.emit({ type: 'notice', level: 'warn', message }) });
  process.on('exit', () => run.dispose());
  const pipeline = new Pipeline(config, bus, cwd, { run, tracker, conversation, conversationStore, checkpoints, limits: limitsStore.load(), limitsStore });

  if (opts.print) {
    let prompt = task;
    if (!prompt && !opts.resume && !process.stdin.isTTY) prompt = await readStdin();
    if (!prompt && !opts.resume) return fail('with --print, give a task as an argument or on stdin: smart -p "fix the typo in README"');
    pipeline.forceModel(opts.model ?? null);
    for (const w of configWarnings) process.stderr.write(`smart: warning: ${w}\n`);
    for (const n of configNotices) process.stderr.write(`smart: ${n}\n`);
    // `kill` / `timeout` / a closed terminal must stop Claude Code too, not orphan it (it would keep editing files and spending money).
    const stop = (code: number) => () => {
      pipeline.cancel();
      // Give the task a moment to save its state (checkpoint, /resume, cost record) before the process goes.
      void pipeline.settle(3000).then(() => {
        checkpoints.dispose();
        process.exit(code);
      });
    };
    process.on('SIGTERM', stop(143));
    process.on('SIGHUP', stop(129));
    const code = await runPrint(pipeline, bus, prompt, { format: opts.outputFormat, verbose: Boolean(opts.verbose), dryRun: opts.dryRun, noPlan: !opts.plan, resume: opts.resume }, { out: process.stdout, err: process.stderr });
    checkpoints.dispose();
    // process.exit() can drop what is still buffered when stdout is a pipe (output past ~64 KB was lost), so flush first.
    await new Promise<void>((r) => process.stdout.write('', () => r()));
    await new Promise<void>((r) => process.stderr.write('', () => r()));
    process.exit(code);
  }

  let exitCode = 0;
  const altScreen = (on: boolean) => {
    altScreenActive = on;
    process.stdout.write(on ? '\x1b[?1049h\x1b[H' : '\x1b[?1049l');
  };
  altScreen(true);
  // The first task's classifier call then skips Claude Code's start-up (the prompt is not part of the command line).
  if (config.runner.keepAlive) run.warm({ ...classifierCall(config, cwd), prompt: '', lean: config.runner.leanCalls });
  const restore = () => {
    if (altScreenActive) {
      process.stdout.write(CLEAR_PROGRESS); // never leave a stuck progress bar on the taskbar
      altScreen(false);
    }
  };
  process.on('exit', restore);
  process.on('SIGTERM', () => {
    pipeline.cancel();
    void pipeline.settle(3000).then(() => process.exit(143));
  });

  const app = render(
    <App
      pipeline={pipeline}
      bus={bus}
      tracker={tracker}
      trackerPath={trackerPath}
      cwd={cwd}
      version={pkg.version}
      permissionMode={config.runner.permissionMode}
      startupNotices={startupNotices}
      inputHistory={new InputHistory(expandHome(config.historyPath))}
      oneShot={Boolean(task) || Boolean(opts.resume)}
      terminal={{ write: (seq) => void process.stdout.write(seq) }}
      initial={{ prompt: task, dryRun: opts.dryRun, noPlan: !opts.plan, model: opts.model ?? null, resume: opts.resume }}
      onExit={(ok) => {
        exitCode = ok ? 0 : 1;
      }}
    />,
    // A modest fps cap keeps spinners from redrawing constantly. incrementalRendering is opt-in (SMART_INCREMENTAL=1): see README.
    { exitOnCtrlC: false, incrementalRendering: process.env.SMART_INCREMENTAL === '1', maxFps: 12 },
  );
  await app.waitUntilExit();
  // Ctrl+C / Esc cancel a running task: let it finish saving before the process exits.
  await pipeline.settle(3000);
  restore();
  process.off('exit', restore);
  process.exit(exitCode);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
