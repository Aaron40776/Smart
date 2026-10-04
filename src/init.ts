import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * What `smart init` writes: only the settings people usually change, with notes. A copy of every default would pin them
 * all, so later improvements to the defaults would never reach you.
 */
export const STARTER = {
  '//': 'Only the settings you change go here; everything else keeps smart\'s defaults (which improve with updates). Every setting: smart.config.example.json and ROUTING.md. A project\'s smart.config.json applies on top of ~/.smart/smart.config.json.',
  routing: {
    '//': 'optimize: cost | balanced | quality (how readily bigger models and more effort are used)',
    optimize: 'balanced',
  },
  limits: {
    '//': 'Stop a task once it has cost this many dollars (null = no limit)',
    maxBudgetUsdPerTask: null,
  },
  runner: {
    '//': 'acceptEdits: Claude Code edits files; other tools (shell commands) only where your Claude Code permission rules allow them. bypassPermissions lets steps run any command unasked: choose it on purpose, in your global config, for projects you trust.',
    permissionMode: 'acceptEdits',
  },
};

/** Write a starter config to `target`. Returns a message for the user; never overwrites without `force`. */
export function initConfig(target: string, force = false): { ok: boolean; message: string } {
  if (existsSync(target) && !force) return { ok: false, message: `${target} already exists. Use \`smart init --force\` to overwrite it.` };
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(STARTER, null, 2)}\n`);
  } catch (e) {
    return { ok: false, message: `Could not write ${target}: ${(e as Error).message}` };
  }
  return { ok: true, message: `Created ${target}. It holds only a few settings; add any others you want to change (see ROUTING.md).` };
}
