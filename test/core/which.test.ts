import { describe, expect, it } from 'vitest';
import { findExecutable, pathDirs, programPath, taskkillPath } from '../../src/core/which.js';

describe('which: programs by absolute path', () => {
  const files = (list: string[]) => (p: string) => list.includes(p);

  it('uses only absolute PATH entries (Windows: not ".", "", "bin" or a drive-relative "\\\\x")', () => {
    expect(pathDirs({ platform: 'win32', env: { PATH: '.;;bin;\\tools;C:\\Git\\cmd;"C:\\Program Files\\x";\\\\server\\share' } }))
      .toEqual(['C:\\Git\\cmd', 'C:\\Program Files\\x', '\\\\server\\share']);
    expect(pathDirs({ platform: 'linux', env: { PATH: '/usr/bin::.:bin:/bin' } })).toEqual(['/usr/bin', '/bin']);
    expect(pathDirs({ platform: 'win32', env: { Path: 'C:\\A' } })).toEqual(['C:\\A']); // Windows spells it Path
  });

  it('finds git.exe on PATH and never in the project folder', () => {
    const env = { PATH: '.;C:\\Git\\cmd' };
    expect(findExecutable('git', { platform: 'win32', env, exists: files(['C:\\Git\\cmd\\git.exe', '.\\git.exe', 'git.exe']) })).toBe('C:\\Git\\cmd\\git.exe');
    expect(findExecutable('git', { platform: 'win32', env, exists: files(['.\\git.exe', 'git.exe']) })).toBeNull();
    expect(findExecutable('tool', { platform: 'win32', env: { PATH: 'C:\\T' }, exists: files(['C:\\T\\tool.com']) })).toBe('C:\\T\\tool.com');
    // .cmd / .bat cannot be started without a shell, so they are not offered
    expect(findExecutable('npm', { platform: 'win32', env: { PATH: 'C:\\N' }, exists: files(['C:\\N\\npm.cmd']) })).toBeNull();
  });

  it('programPath: absolute on Windows, null when missing; the bare name elsewhere', () => {
    expect(programPath('git', { platform: 'win32', env: { PATH: 'C:\\G' }, exists: files(['C:\\G\\git.exe']) })).toBe('C:\\G\\git.exe');
    expect(programPath('git', { platform: 'win32', env: { PATH: 'C:\\G' }, exists: files([]) })).toBeNull();
    expect(programPath('git', { platform: 'linux', env: { PATH: '/x' }, exists: files([]) })).toBe('git');
  });

  it('a name with a path is taken as is when it exists', () => {
    expect(findExecutable('C:\\x\\claude.exe', { platform: 'win32', exists: files(['C:\\x\\claude.exe']) })).toBe('C:\\x\\claude.exe');
    expect(findExecutable('/opt/claude', { platform: 'linux', exists: files([]) })).toBeNull();
  });

  it('taskkill comes from the Windows folder', () => {
    expect(taskkillPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\taskkill.exe');
    expect(taskkillPath({})).toBe('C:\\Windows\\System32\\taskkill.exe');
  });
});
