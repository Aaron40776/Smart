import { spawn, type ChildProcess } from 'node:child_process';
import { taskkillPath } from './which.js';

type Spawn = typeof spawn;

/**
 * Whether Node still holds `child` as a live process. Once it has exited, Node has released it and the operating system
 * may hand its process id to an unrelated program (Windows reuses ids quickly), so a stored pid must never be signalled again.
 * While it has not, Node keeps a handle to the process open, which on Windows stops the id from being reused: the id still
 * names this process (or what is left of it). That handle is the identity check smart relies on; it never kills by a pid it
 * read from anywhere else.
 */
export const isRunning = (child: Pick<ChildProcess, 'exitCode' | 'signalCode'>): boolean => child.exitCode == null && child.signalCode == null;

/**
 * Ends a child process. On Windows `child.kill()` ends only that one process, so anything Claude Code
 * started (a dev server, a test run) would keep running; `taskkill /T` ends the whole tree. Elsewhere it is a plain signal.
 * A process that has already exited is left alone (see isRunning). When taskkill cannot run, or fails (access denied,
 * part of the tree already gone), the process itself is still ended directly.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM', platform: string = process.platform, spawnImpl: Spawn = spawn): void {
  if (!isRunning(child)) return;
  if (platform !== 'win32' || child.pid === undefined) {
    child.kill(signal);
    return;
  }
  const fallback = () => {
    if (isRunning(child)) child.kill(signal);
  };
  try {
    // By absolute path: a bare `taskkill` would be looked up in the working directory first (see which.ts).
    const tk = spawnImpl(taskkillPath(), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    tk.on('error', fallback);
    tk.on('exit', (code) => {
      if (code !== 0) fallback();
    });
    tk.unref();
  } catch {
    fallback();
  }
}
