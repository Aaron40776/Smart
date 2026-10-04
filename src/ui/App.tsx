import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { homedir } from 'node:os';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { EventBus } from '../core/events.js';
import type { Pipeline } from '../core/pipeline.js';
import { costLines, summarize } from '../core/stats.js';
import type { Tracker } from '../core/store/tracker.js';
import { usageLines } from '../core/usage.js';
import type { ModelTier } from '../core/types.js';
import { foldersOf, projectFiles } from '../core/files.js';
import type { InputHistory } from '../core/store/inputHistory.js';
import { COMMANDS, HELP_TEXT, matchCommands, modeLabel, parseInput } from './commands.js';
import { CostMeter } from './components/CostMeter.js';
import { LimitsMeter } from './components/LimitsMeter.js';
import { InputBox, matchFiles } from './components/InputBox.js';
import { OutputLog } from './components/OutputLog.js';
import { PipelineBar } from './components/PipelineBar.js';
import { PlanApproval } from './components/PlanApproval.js';
import { PlanChecklist } from './components/PlanChecklist.js';
import { StatsView } from './components/StatsView.js';
import { CLEAR_PROGRESS, progressFor, progressSequence } from './progress.js';
import { initialState, reduce, taskUsage } from './state.js';
import { ACCENT } from './theme.js';
import { EXIT, exitCodeFor } from '../exitCodes.js';

type Focus = 'input' | 'plan' | 'output';

/** Home as ~, and when too long only the last path components: `…/parent/project`. */
export function shortPath(p: string, max = 28): string {
  const home = homedir();
  // Only at a path boundary: /home/al must not turn /home/alice into ~ice.
  const inHome = home.length > 1 && (p === home || p.startsWith(`${home}/`) || p.startsWith(`${home}\\`));
  const withTilde = inHome ? `~${p.slice(home.length)}` : p;
  if (withTilde.length <= max) return withTilde;
  const parts = withTilde.split(/[\\/]/).filter(Boolean);
  let out = parts.at(-1) ?? withTilde;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}/${out}`;
    if (next.length + 2 > max) break;
    out = next;
  }
  return out.length + 2 > max ? `…${out.slice(-(max - 1))}` : `…/${out}`;
}

export interface AppProps {
  pipeline: Pipeline;
  bus: EventBus;
  tracker: Tracker;
  trackerPath: string;
  cwd: string;
  version: string;
  permissionMode: string;
  initial?: { prompt: string; dryRun?: boolean; noPlan?: boolean; model?: ModelTier | null; resume?: boolean };
  inputHistory?: InputHistory;
  /** Info lines shown at startup (e.g. "Continuing your previous conversation"). */
  startupNotices?: string[];
  /** One-shot mode: exit when the task finishes. */
  oneShot?: boolean;
  /** Where to send terminal control sequences (taskbar progress). Omit to send none. */
  terminal?: { write: (s: string) => void };
  /** One-shot mode and quitting: the process exit code (see src/exitCodes.ts). */
  onExit?: (code: number) => void;
}

const clipPrompt = (p: string): string => {
  const one = p.replace(/\s+/g, ' ').trim();
  return one.length > 50 ? `${one.slice(0, 49)}…` : one;
};

const WELCOME = ['Claude Code, routed to the cheapest capable model.', 'Type a task and press Enter, e.g. "make me a snake game".', '/help lists commands.'];

export function App({ pipeline, bus, tracker, trackerPath, cwd, version, initial, startupNotices, inputHistory, oneShot, onExit, terminal }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout.columns ?? 100, rows: stdout.rows ?? 30 });
  const [state, dispatch] = useReducer(reduce, undefined, () => ({ ...initialState(), chatTasks: pipeline.chatTasks, limits: pipeline.accountLimits }));
  const sessionStart = useRef(Date.now());
  const [focus, setFocus] = useState<Focus>('input');
  const [view, setView] = useState<'main' | 'stats'>('main');
  const [dryRun, setDryRun] = useState(initial?.dryRun ?? false);
  const [forced, setForced] = useState<ModelTier | null>(initial?.model ?? null);
  const [mode, setMode] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [scroll, setScroll] = useState(0);
  const maxScroll = useRef(0);
  const [draft, setDraft] = useState('');
  const [history] = useState(() => inputHistory?.load() ?? []);
  // Files and the folders that hold them: `@src/` attaches a folder's file list.
  const listFiles = () => {
    const f = projectFiles(cwd, 400);
    return [...f, ...foldersOf(f)];
  };
  const [files, setFiles] = useState(listFiles);
  /** A task typed while another one runs: it starts when that one completes. */
  const [queued, setQueued] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const on = () => setSize({ cols: stdout.columns ?? 100, rows: stdout.rows ?? 30 });
    stdout.on('resize', on);
    return () => void stdout.off('resize', on);
  }, [stdout]);

  // Subscribe first so no event emitted by the initial task is missed.
  useEffect(() => bus.subscribe(dispatch), [bus]);
  useEffect(() => {
    for (const text of startupNotices ?? []) dispatch({ type: 'ui:info', text });
  }, []);
  useEffect(() => pipeline.setDryRun(dryRun), [pipeline, dryRun]);
  useEffect(() => pipeline.forceModel(forced), [pipeline, forced]);
  useEffect(() => () => pipeline.cancel(), [pipeline]);

  const startTask = (prompt: string, opts: { noPlan?: boolean } = {}) => {
    dispatch({ type: 'ui:user', text: prompt });
    setScroll(0);
    pipeline.runTask(prompt, { dryRun, noPlan: opts.noPlan ?? initial?.noPlan }).catch((e: Error) => dispatch({ type: 'notice', level: 'warn', message: e.message }));
  };

  const startResume = () => {
    const p = pipeline.pendingTask;
    if (!p) return dispatch({ type: 'notice', level: 'info', message: 'Nothing to resume: the last task finished or never got past planning.' });
    dispatch({ type: 'ui:user', text: `/resume: ${p.prompt}` });
    setScroll(0);
    pipeline.resumeTask().catch((e: Error) => dispatch({ type: 'notice', level: 'warn', message: e.message }));
  };

  useEffect(() => {
    if (initial?.resume) startResume();
    else if (initial?.prompt) startTask(initial.prompt, { noPlan: initial.noPlan });
  }, []);

  useEffect(() => {
    if (oneShot && state.phase === 'finished') {
      const t = setTimeout(() => {
        onExit?.(state.ok ? EXIT.ok : exitCodeFor(state.failure, false));
        exit();
      }, 150);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [oneShot, state.phase, state.ok, state.failure, exit, onExit]);

  // Read the history once when /stats opens (and again when a task ends), not on every frame.
  const statsSummary = useMemo(() => (view === 'stats' ? summarize(tracker.load(), { now: Date.now() }) : null), [view, tracker, state.phase]);

  // When a task ends: pick up files it created for @ completion, and start the queued task if it completed.
  useEffect(() => {
    if (state.phase !== 'finished') return;
    setFiles(listFiles());
    if (!queued || pipeline.isRunning) return;
    setQueued(null);
    if (state.ok) startTask(queued);
    else dispatch({ type: 'notice', level: 'warn', message: `The queued task was not started because this one did not complete: "${clipPrompt(queued)}". Press ↑ to send it again.` });
  }, [state.phase]);

  // Taskbar and tab progress, sent only when it changes; cleared when smart closes.
  const progress = progressSequence(progressFor(state));
  // Braces matter: an effect must not return write()'s result (React would call it as the cleanup).
  useEffect(() => {
    terminal?.write(progress);
  }, [terminal, progress]);
  useEffect(() => () => {
    terminal?.write(CLEAR_PROGRESS);
  }, [terminal]);

  const steps = state.plan?.steps.length ?? 0;
  const busy = state.phase === 'running' || state.phase === 'approval';

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      pipeline.cancel();
      onExit?.(EXIT.cancelled);
      exit();
      return;
    }
    if (state.phase === 'approval') return; // the approval screen owns the keyboard
    if (key.escape) {
      if (view === 'stats') setView('main');
      else if (pipeline.isRunning) {
        pipeline.cancel();
        if (queued) {
          setQueued(null);
          dispatch({ type: 'ui:info', text: `Dropped the queued task too: "${clipPrompt(queued)}".` });
        }
      }
      else if (focus !== 'input') setFocus('input');
      return;
    }
    // Tab completes a /command while typing one; otherwise it switches panels.
    if (key.tab && view === 'main' && !(focus === 'input' && (draft.startsWith('/') || /(?:^|\s)@\S*$/.test(draft)))) {
      const order: Focus[] = steps > 0 ? ['input', 'plan', 'output'] : ['input', 'output'];
      setFocus((f) => order[(order.indexOf(f) + 1) % order.length] ?? 'input');
      return;
    }
    // Page Up/Down scroll the output from anywhere on the main screen: no need to Tab to the panel first.
    if ((key.pageUp || key.pageDown) && view === 'main') {
      setScroll((s) => (key.pageUp ? Math.min(maxScroll.current, s + 10) : Math.max(0, s - 10)));
      return;
    }
    if (focus === 'plan') {
      if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow) setSelected((s) => Math.min(Math.max(0, steps - 1), s + 1));
    } else if (focus === 'output') {
      if (key.upArrow) setScroll((s) => Math.min(maxScroll.current, s + 1));
      if (key.downArrow) setScroll((s) => Math.max(0, s - 1));
      if (key.end) setScroll(0);
    }
  });

  const onSubmit = (text: string) => {
    const cmd = parseInput(text);
    if (!cmd) return;
    inputHistory?.push(text);
    switch (cmd.kind) {
      case 'task':
        if (pipeline.isRunning) {
          setQueued(cmd.prompt);
          return dispatch({ type: 'ui:info', text: `${queued ? 'Replaced the queued task' : 'Queued'}: "${clipPrompt(cmd.prompt)}". It starts when this task completes (Esc cancels both).` });
        }
        return startTask(cmd.prompt);
      case 'stats':
        return setView('stats');
      case 'help':
        return dispatch({ type: 'ui:info', text: HELP_TEXT });
      case 'quit':
        pipeline.cancel();
        onExit?.(EXIT.ok);
        return exit();
      case 'new':
        if (pipeline.isRunning) return dispatch({ type: 'notice', level: 'warn', message: 'Cancel the running task (Esc) before starting a new conversation.' });
        pipeline.newConversation();
        return dispatch({ type: 'ui:info', text: 'Started a new conversation. Earlier tasks are forgotten.' });
      case 'usage':
        return dispatch({ type: 'ui:info', text: usageLines(state.limits, Date.now()).join('\n') });
      case 'cost': {
        const mine = tracker.load().filter((t) => Date.parse(t.startedAt) >= sessionStart.current);
        return dispatch({ type: 'ui:info', text: costLines(summarize(mine, { now: Date.now() })).join('\n') });
      }
      case 'config':
        return dispatch({ type: 'ui:info', text: pipeline.describe().join('\n') });
      case 'undo':
        void pipeline.undo(cmd.force);
        return;
      case 'diff':
        void pipeline.diff();
        return;
      case 'feedback':
        if (pipeline.isRunning) return dispatch({ type: 'notice', level: 'warn', message: 'Rate a task once it has finished.' });
        return pipeline.rateLast(cmd.value);
      case 'resume':
        if (pipeline.isRunning) return dispatch({ type: 'notice', level: 'warn', message: 'A task is already running.' });
        return startResume();
      case 'mode':
        if (cmd.mode === 'show') return dispatch({ type: 'ui:info', text: `Permission mode: ${pipeline.permissionMode}${mode ? ' (set with /mode; /mode default goes back to the configured one)' : ' (from config)'}.` });
        setMode(cmd.mode);
        pipeline.setPermissionMode(cmd.mode);
        return dispatch({ type: 'ui:info', text: cmd.mode ? `Permission mode set to ${cmd.mode}${cmd.mode === 'plan' ? ' (read-only: Claude will not edit files).' : cmd.mode === 'bypassPermissions' ? ': Claude Code may run any command without asking, for the rest of this session.' : '.'}` : `Permission mode back to the configured one (${pipeline.permissionMode}).` });
      case 'dry':
        setDryRun(!dryRun);
        return dispatch({ type: 'ui:info', text: `Dry-run ${!dryRun ? 'on: tasks will classify and plan only.' : 'off.'}` });
      case 'model':
        setForced(cmd.tier);
        return dispatch({ type: 'ui:info', text: cmd.tier ? `Model forced to ${cmd.tier} for all steps.` : 'Model routing is automatic.' });
      case 'error':
        return dispatch({ type: 'notice', level: 'warn', message: cmd.message });
    }
  };

  // header 1 + pipeline 1 + input 3 + hint 1 = 6, plus one spare row: Ink clears the screen when output fills every row.
  const mainHeight = Math.max(6, size.rows - 7);
  const tags = [queued ? 'queued' : '', dryRun ? 'dry-run' : '', mode ? `mode:${modeLabel(mode)}` : '', forced ? `model:${forced}` : 'model:auto', state.chatTasks > 0 ? `chat:${state.chatTasks}` : ''].filter(Boolean);
  const suggestions = matchCommands(draft);
  const fileHits = matchFiles(draft, files);
  const hint =
    state.phase === 'approval'
      ? ''
      : fileHits
        ? fileHits.matches.length > 0
          ? `${fileHits.matches.slice(0, 5).map((f) => `@${f}`).join('  ')}   (Tab completes)`
          : 'No matching file.'
        : suggestions.length > 0
        ? suggestions.map((n) => `${n} ${COMMANDS.find((c) => c.name === n)?.help ?? ''}`.trim()).join('  ·  ') + '   (Tab completes)'
        : draft.startsWith('/')
          ? 'No such command. Try /help.'
          : busy
            ? queued
              ? `Queued next: ${clipPrompt(queued)} · Esc cancels both`
              : 'Esc cancel · Enter queues the next task · /usage /cost /diff work meanwhile'
            : 'Enter send · PgUp/PgDn scroll · Tab panel · /stats /model /new /help · Ctrl+C quit';
  const wide = size.cols >= 120;

  return (
    // One row shorter than the terminal: when Ink's output fills every row it clears the whole screen on each frame (flicker).
    <Box flexDirection="column" width={size.cols} height={size.rows - 1}>
      <Box justifyContent="space-between" paddingX={1} height={1}>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={ACCENT} bold>✻ smart</Text>
            <Text dimColor>{` v${version}${size.cols >= 120 ? ` · ${shortPath(cwd)}` : ''}`}</Text>
            {/* Only the modes that change what happens unasked are shown: bypass in warning colour, plan (read-only) plainly. */}
            {pipeline.permissionMode === 'bypassPermissions' ? <Text color="yellow" bold>{' · bypass: runs any command'}</Text> : null}
            {pipeline.permissionMode === 'plan' ? <Text dimColor>{' · read-only'}</Text> : null}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={2}>
          {state.limits ? (
            <Box marginRight={2}>
              <LimitsMeter limits={state.limits} nowMs={Date.now()} compact={!wide} />
            </Box>
          ) : null}
          <CostMeter task={taskUsage(state)} session={state.session} showTask={state.phase !== 'idle'} compact={!wide} />
        </Box>
      </Box>
      <Box paddingX={1}>
        <PipelineBar stages={state.stages} compact={size.cols < 70} />
      </Box>
      {state.phase === 'approval' && state.plan ? (
        <PlanApproval plan={state.plan} routes={state.routes} preview={(p, st) => pipeline.previewStep(p, st)} onApprove={(p) => pipeline.approvePlan(p)} onCancel={() => pipeline.cancel()} height={mainHeight} width={size.cols} />
      ) : view === 'stats' && statsSummary ? (
        <StatsView summary={statsSummary} limits={state.limits} path={trackerPath} height={mainHeight} width={size.cols} />
      ) : (
        <Box height={mainHeight}>
          <Box width="40%" flexShrink={0} flexDirection="column">
            <PlanChecklist plan={state.plan} routes={state.routes} stepStatus={state.stepStatus} escalatedTo={state.escalatedTo} durations={state.stepDuration} selected={selected} focused={focus === 'plan'} height={mainHeight} />
          </Box>
          <OutputLog lines={state.output} height={mainHeight} scroll={scroll} width={size.cols - Math.floor(size.cols * 0.4) - 4} focused={focus === 'output'} welcome={WELCOME} onMaxScroll={(n) => { maxScroll.current = n; }} />
        </Box>
      )}
      <InputBox
        onSubmit={onSubmit}
        width={size.cols}
        initialHistory={history}
        onDraft={setDraft}
        completions={COMMANDS.map((c) => c.name)}
        files={files}
        active={focus === 'input' && view === 'main' && state.phase !== 'approval'}
        tags={tags}
        placeholder={state.phase === 'running' ? 'Working… type the next task to queue it (Esc cancels)' : state.phase === 'idle' ? 'What should we build?' : 'Type another task…'}
      />
      <Box paddingX={1}>
        <Text dimColor wrap="truncate-end">{hint}</Text>
      </Box>
    </Box>
  );
}
