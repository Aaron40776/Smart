import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Runs one command in `cwd` with its output shown; returns the exit code. */
export type RunCommand = (cmd: string, args: string[], cwd: string) => number;
/** Runs one command in `cwd` quietly; returns the exit code and what it printed. */
export type CaptureCommand = (cmd: string, args: string[], cwd: string) => { code: number; stdout: string };

// npm goes through the shell on Windows so it finds npm.cmd; its arguments are fixed words. Nothing else does: the shell joins
// arguments without quoting, so `git stash push -m "smart update <time>"` would split into pathspecs. The working directory is
// smart's own installation folder.
export const needsShell = (cmd: string, platform: string = process.platform): boolean => platform === 'win32' && cmd === 'npm';
const run: RunCommand = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: needsShell(cmd) }).status ?? 1;
const capture: CaptureCommand = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return { code: r.status ?? 1, stdout: r.stdout ?? '' };
};

const versionIn = (root: string): string => {
  try {
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? '?';
  } catch {
    return '?';
  }
};

export interface UpdateDeps {
  run?: RunCommand;
  capture?: CaptureCommand;
  log?: (line: string) => void;
}

/**
 * `smart update`: bring the folder smart was cloned to up to date with its upstream branch, install and rebuild. Returns the
 * exit code. It never discards anything of yours:
 *   - changed tracked files (including a package-lock.json an older smart's `npm install` rewrote) stop it before anything
 *     happens, with the list; `--stash` sets them aside with `git stash` (`git stash pop` brings them back) and continues;
 *   - local commits are kept: it only fast-forwards (`git merge --ff-only`), and says so when your branch has diverged;
 *   - a pinned installation (a tag or commit checked out, no branch) is left as it is;
 *   - when install or build fails after the code moved, it says which commit you were on and how to get back to it.
 * Untracked files are left alone (git refuses to overwrite one, and says so).
 * Dependencies are installed with `npm ci --ignore-scripts`: exactly the lockfile, and no package's install scripts run.
 */
export function updateSmart(root: string, opts: { stash?: boolean } = {}, deps: UpdateDeps = {}): number {
  const exec = deps.run ?? run;
  const ask = deps.capture ?? capture;
  const log = deps.log ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const git = (...args: string[]) => ask('git', args, root);
  const step = (cmd: string, args: string[]): number => {
    log(`> ${cmd} ${args.join(' ')}`);
    return exec(cmd, args, root);
  };

  if (!existsSync(join(root, '.git'))) {
    log(`smart in ${root} was not installed with git, so it cannot update itself. Reinstall it with install.ps1 (see the README).`);
    return 1;
  }

  // 1. Your changes: never discarded.
  const status = git('status', '--porcelain', '--untracked-files=no');
  if (status.code !== 0) {
    log(`smart update: \`git status\` failed in ${root}. Check that the folder is a clone of https://github.com/Aaron40776/Smart.`);
    return 1;
  }
  const changed = status.stdout.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
  if (changed.length > 0) {
    if (!opts.stash) {
      const lockOnly = changed.length === 1 && changed[0] === 'package-lock.json';
      log(`smart update: nothing was changed, because files in ${root} have local changes:`);
      for (const f of changed.slice(0, 10)) log(`  ${f}`);
      if (changed.length > 10) log(`  … and ${changed.length - 10} more`);
      log(lockOnly
        ? 'package-lock.json was probably rewritten by `npm install` (older smart versions ran it). If you did not edit it yourself, `git -C "<folder>" checkout -- package-lock.json` restores it; or run `smart update --stash` to set it aside.'.replace('<folder>', root)
        : 'Commit them, or run `smart update --stash` to set them aside with git stash (`git stash pop` brings them back), then update.');
      return 1;
    }
    log('> git stash push');
    const stash = exec('git', ['stash', 'push', '-m', `smart update ${new Date().toISOString()}`], root);
    if (stash !== 0) {
      log('smart update: `git stash` failed, so nothing was changed. Commit your changes instead, then update.');
      return stash;
    }
    log(`Your changes are in git stash; \`git -C "${root}" stash pop\` brings them back.`);
  }

  // 2. Which branch, and where it stands against its upstream.
  const branch = git('symbolic-ref', '-q', '--short', 'HEAD');
  if (branch.code !== 0) {
    const at = git('describe', '--tags', '--always').stdout.trim();
    log(`smart update: this installation is pinned to ${at || 'a fixed commit'} (no branch is checked out), so it is left as it is. To move to another release, run install.ps1 with $env:SMART_REF set to it, or \`git -C "${root}" checkout <tag>\` and then \`smart update\`.`);
    return 1;
  }
  const upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  if (upstream.code !== 0) {
    log(`smart update: the branch ${branch.stdout.trim()} has no upstream to update from. \`git -C "${root}" branch -u origin/main\` sets one.`);
    return 1;
  }
  if (step('git', ['fetch', '--quiet']) !== 0) {
    log('smart update: `git fetch` failed, so nothing was changed. Check your internet connection, then run `smart update` again.');
    return 1;
  }
  const counts = git('rev-list', '--left-right', '--count', 'HEAD...@{u}').stdout.trim().split(/\s+/).map(Number);
  const [ahead = 0, behind = 0] = counts;
  if (ahead > 0 && behind > 0) {
    log(`smart update: your branch has ${ahead} local commit${ahead === 1 ? '' : 's'} and ${upstream.stdout.trim()} has ${behind} new one${behind === 1 ? '' : 's'}; they have diverged, so nothing was changed. Merge or rebase them yourself (\`git -C "${root}" pull\`), then run \`smart update\`.`);
    return 1;
  }
  if (ahead > 0) log(`Note: your ${ahead} local commit${ahead === 1 ? ' is' : 's are'} kept; there is nothing new upstream.`);

  // 3. Move the code forward (fast-forward only), then install and build. Remember where we were for a way back.
  const before = git('rev-parse', 'HEAD').stdout.trim();
  const beforeVersion = versionIn(root);
  if (behind > 0 && step('git', ['merge', '--ff-only', '--quiet', '@{u}']) !== 0) {
    log('smart update: the fast-forward failed, so nothing was changed (an untracked file in the way? git names it above). Move it, then run `smart update` again.');
    return 1;
  }
  const back = behind > 0
    ? ` The code is now at the new version; to return to the one you had: \`git -C "${root}" reset --keep ${before.slice(0, 12)}\`, then \`npm ci --ignore-scripts\` and \`npm run build\` there.`
    : '';
  if (step('npm', ['ci', '--ignore-scripts']) !== 0) {
    log(`smart update: \`npm ci\` failed (see above), so smart may not start until it succeeds. Check your internet connection, then in ${root} run \`npm ci --ignore-scripts\` and \`npm run build\`.${back}`);
    return 1;
  }
  if (step('npm', ['run', 'build']) !== 0) {
    log(`smart update: the build failed (see above). Please report it at https://github.com/Aaron40776/Smart/issues with the output.${back}`);
    return 1;
  }
  const after = versionIn(root);
  log(behind === 0 ? `smart ${after} is up to date and rebuilt.` : `Updated smart ${beforeVersion} → ${after}. See CHANGELOG.md for what changed.`);
  return 0;
}
