import { isTier } from '../core/router.js';
import type { ModelTier } from '../core/types.js';

export type Command =
  | { kind: 'stats' }
  | { kind: 'dry' }
  | { kind: 'help' }
  | { kind: 'quit' }
  | { kind: 'new' }
  | { kind: 'undo'; force: boolean }
  | { kind: 'usage' }
  | { kind: 'cost' }
  | { kind: 'config' }
  | { kind: 'diff' }
  | { kind: 'resume' }
  | { kind: 'feedback'; value: 'good' | 'bad' }
  | { kind: 'mode'; mode: string | null | 'show' }
  | { kind: 'model'; tier: ModelTier | null }
  | { kind: 'error'; message: string }
  | { kind: 'task'; prompt: string };

/** Parses a line typed into the input box: a slash command or a task. */
export function parseInput(raw: string): Command | null {
  const text = raw.trim();
  if (!text) return null;
  if (!text.startsWith('/')) return { kind: 'task', prompt: text };
  const [name = '', ...rest] = text.slice(1).split(/\s+/);
  switch (name.toLowerCase()) {
    case 'stats':
      return { kind: 'stats' };
    case 'dry':
    case 'dry-run':
      return { kind: 'dry' };
    case 'help':
    case '?':
      return { kind: 'help' };
    case 'quit':
    case 'exit':
      return { kind: 'quit' };
    case 'new':
    case 'clear':
      return { kind: 'new' };
    case 'undo':
      if (rest[0] && rest[0].toLowerCase() !== 'force') return { kind: 'error', message: `Unknown /undo option "${rest[0]}". Use /undo or /undo force.` };
      return { kind: 'undo', force: rest[0]?.toLowerCase() === 'force' };
    case 'usage':
    case 'limits':
      return { kind: 'usage' };
    case 'cost':
      return { kind: 'cost' };
    case 'config':
      return { kind: 'config' };
    case 'diff':
      return { kind: 'diff' };
    case 'resume':
    case 'continue':
      return { kind: 'resume' };
    case 'good':
      return { kind: 'feedback', value: 'good' };
    case 'bad':
      return { kind: 'feedback', value: 'bad' };
    case 'mode': {
      const arg = (rest[0] ?? '').toLowerCase();
      if (arg === '') return { kind: 'mode', mode: 'show' };
      if (arg === 'auto' || arg === 'default') return { kind: 'mode', mode: null };
      const mode = MODES[arg];
      return mode ? { kind: 'mode', mode } : { kind: 'error', message: `Unknown mode "${rest[0]}". Use edits, plan, bypass or default.` };
    }
    case 'model': {
      const arg = (rest[0] ?? '').toLowerCase();
      if (arg === 'auto' || arg === 'off' || arg === '') return { kind: 'model', tier: null };
      return isTier(arg) ? { kind: 'model', tier: arg } : { kind: 'error', message: `Unknown model "${rest[0]}". Use haiku, sonnet, opus or auto.` };
    }
    default:
      return { kind: 'error', message: `Unknown command /${name}. Try /help.` };
  }
}

/** Permission modes you can switch to at runtime. `default` (or `auto`) returns to the configured mode. */
export const MODES: Record<string, string> = { bypass: 'bypassPermissions', edits: 'acceptEdits', accept: 'acceptEdits', plan: 'plan' };
export const modeLabel = (mode: string): string => Object.entries(MODES).find(([, v]) => v === mode)?.[0] ?? mode;

/** Commands offered by Tab completion and the suggestion line. */
export const COMMANDS: { name: string; help: string }[] = [
  { name: '/stats', help: 'usage history and spend' },
  { name: '/usage', help: 'account limits (5h / 7d)' },
  { name: '/cost', help: 'this session\'s spend' },
  { name: '/config', help: 'effective routing settings' },
  { name: '/model', help: 'force haiku | sonnet | opus | auto' },
  { name: '/dry', help: 'toggle dry-run' },
  { name: '/new', help: 'fresh conversation' },
  { name: '/undo', help: 'revert the last task\'s file changes' },
  { name: '/diff', help: 'show the last task\'s changes' },
  { name: '/resume', help: 'continue a failed or cancelled task' },
  { name: '/good', help: 'the last result was right' },
  { name: '/bad', help: 'the last result was wrong (smart learns)' },
  { name: '/mode', help: 'edits | plan | bypass | default' },
  { name: '/help', help: 'show help' },
  { name: '/quit', help: 'exit' },
];

export function matchCommands(draft: string): string[] {
  if (!draft.startsWith('/') || /\s/.test(draft)) return [];
  return COMMANDS.map((c) => c.name).filter((n) => n.startsWith(draft.toLowerCase()));
}

export const HELP_TEXT = [
  'Type a task and press Enter. Commands:',
  '  /stats            usage history and per-model costs',
  '  /usage            your Claude account limits (5-hour / 7-day) and resets',
  '  /cost             what this session spent, by model',
  '  /config           show the effective routing and safety settings',
  '  /model <tier>     force haiku | sonnet | opus (or "auto" to route)',
  '  /dry              toggle dry-run (classify + plan only)',
  '  /new              start a fresh conversation (forget earlier tasks)',
  '  /undo             revert the file changes of the last task (needs git; /undo force also over your later edits)',
  '  /diff             show what the last task changed',
  '  /resume           continue a failed or cancelled task from its first unfinished step',
  '  /good, /bad       rate the last result; /bad makes smart use a stronger model for similar work',
  '  /mode <m>         permissions: edits | plan (read-only) | bypass (any command, unasked) | default (the configured one)',
  '  /help, /quit',
  'While a task runs, Enter queues the next task (Esc cancels both); /usage, /cost and /diff work meanwhile.',
  'Keys: Esc cancel · PgUp/PgDn scroll the output · Tab switch panel · ↑/↓ scroll or select · Ctrl+C quit',
].join('\n');
