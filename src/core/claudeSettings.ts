import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Claude Code reads the project's own `.claude/settings.json` (and `.claude/settings.local.json`) in every coding step smart
 * runs there. A repository can ship them: `hooks` are shell commands Claude Code runs automatically, and `permissions.allow`
 * rules (or `defaultMode`) let tools run without asking, which can widen smart's `acceptEdits` default. smart does not change
 * how Claude Code treats them; it names them at startup so a repository you did not write cannot do this unnoticed.
 */
export function claudeProjectSettingsWarning(cwd: string): string | null {
  const found: string[] = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    let d: { hooks?: unknown; permissions?: { allow?: unknown; defaultMode?: unknown } };
    try {
      d = JSON.parse(readFileSync(join(cwd, '.claude', name), 'utf8')) as typeof d;
    } catch {
      continue; // absent or unreadable: Claude Code would not use it either
    }
    if (!d || typeof d !== 'object') continue;
    const what: string[] = [];
    if (d.hooks && typeof d.hooks === 'object' && Object.keys(d.hooks).length > 0) what.push(`hooks (${Object.keys(d.hooks).join(', ')}: commands Claude Code runs automatically)`);
    const allow = Array.isArray(d.permissions?.allow) ? d.permissions.allow.filter((r): r is string => typeof r === 'string') : [];
    const risky = allow.filter((r) => /^(Bash|WebFetch|mcp__)/.test(r));
    if (risky.length) what.push(`permission rules that allow ${risky.slice(0, 4).join(', ')}${risky.length > 4 ? ', …' : ''} without asking`);
    if (typeof d.permissions?.defaultMode === 'string') what.push(`permissions.defaultMode ${d.permissions.defaultMode}`);
    if (what.length) found.push(`.claude/${name} sets ${what.join('; ')}`);
  }
  return found.length
    ? `This project's Claude Code settings apply to every step smart runs here: ${found.join('. ')}. Review them if you did not write them (smart's own permission mode does not override them).`
    : null;
}
