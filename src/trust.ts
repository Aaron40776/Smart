import { homedir } from 'node:os';
import { describeProjectTrust } from './core/config.js';
import { TrustStore, trustStorePath } from './core/store/trust.js';

/**
 * `smart trust` allows the settings of this directory's `smart.config.json` that cross the trust boundary (commands, permission
 * mode, Claude Code flags, data paths, budgets); `smart trust --remove` withdraws that. The file's exact contents are trusted:
 * any later change needs another `smart trust`.
 */
export function trustProject(cwd: string, opts: { remove?: boolean; home?: string; store?: TrustStore } = {}): { ok: boolean; message: string } {
  const home = opts.home ?? homedir();
  const store = opts.store ?? new TrustStore(trustStorePath(home));
  if (opts.remove) {
    const err = store.revoke(cwd);
    return err ? { ok: false, message: err } : { ok: true, message: `This project's smart.config.json is no longer trusted (${cwd}).` };
  }
  let info;
  try {
    info = describeProjectTrust(cwd, home);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const err = store.trust(cwd, info.text);
  if (err) return { ok: false, message: err };
  const what = info.loosened.length
    ? `It now may:\n${info.loosened.map((l) => `  - ${l}`).join('\n')}`
    : 'It sets nothing that needs trust right now; any such setting added later needs `smart trust` again.';
  return { ok: true, message: `Trusted ${info.path} as it is now. ${what}\nIf the file changes, smart ignores those settings again until you run \`smart trust\` once more.` };
}
