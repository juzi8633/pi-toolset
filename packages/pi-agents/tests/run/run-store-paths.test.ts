// ABOUTME: Tests for cross-platform runs-root resolution and capability probing.
// ABOUTME: Covers path precedence, probe failures, and no-replace contention classification.

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getDefaultRunsRoot,
  initializeRunsRoot,
  isNoReplaceContentionError,
  resolveRunsRoot,
  type RunStoreCapabilities,
} from '../../src/run/run-store-paths.ts';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-paths-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('resolveRunsRoot precedence', () => {
  it('uses non-empty programmatic rootDir as a complete root (absolute)', () => {
    const resolved = resolveRunsRoot({
      rootDir: '/custom/runs',
      platform: 'linux',
      env: { PI_AGENTS_RUNS_DIR: '/env/runs', XDG_STATE_HOME: '/xdg' },
      homeDir: '/home/user',
      cwd: '/cwd',
    });
    expect(resolved).toBe(path.posix.normalize('/custom/runs'));
  });

  it('resolves relative programmatic rootDir against injected cwd without package segments', () => {
    const resolved = resolveRunsRoot({
      rootDir: 'relative/runs',
      platform: 'linux',
      env: {},
      homeDir: '/home/user',
      cwd: '/work',
    });
    expect(resolved).toBe(path.posix.normalize('/work/relative/runs'));
  });

  it('uses non-empty PI_AGENTS_RUNS_DIR when rootDir is absent', () => {
    const resolved = resolveRunsRoot({
      platform: 'linux',
      env: { PI_AGENTS_RUNS_DIR: '/env/complete/root', XDG_STATE_HOME: '/xdg' },
      homeDir: '/home/user',
      cwd: '/cwd',
    });
    expect(resolved).toBe(path.posix.normalize('/env/complete/root'));
  });

  it('resolves relative PI_AGENTS_RUNS_DIR against cwd without package segments', () => {
    const resolved = resolveRunsRoot({
      platform: 'darwin',
      env: { PI_AGENTS_RUNS_DIR: 'env-rel/runs' },
      homeDir: '/Users/me',
      cwd: '/proj',
    });
    expect(resolved).toBe(path.posix.normalize('/proj/env-rel/runs'));
  });

  it('rejects explicitly supplied empty programmatic rootDir with run_store_error', () => {
    try {
      resolveRunsRoot({
        rootDir: '',
        platform: 'linux',
        env: { PI_AGENTS_RUNS_DIR: '', XDG_STATE_HOME: '/xdg/state' },
        homeDir: '/home/user',
        cwd: '/cwd',
      });
      expect.unreachable('expected empty rootDir to throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'run_store_error' });
      expect(String((err as { message: string }).message)).toMatch(/rootDir/i);
    }
  });

  it('ignores empty PI_AGENTS_RUNS_DIR without trimming and falls through to platform default', () => {
    const resolved = resolveRunsRoot({
      platform: 'linux',
      env: { PI_AGENTS_RUNS_DIR: '', XDG_STATE_HOME: '/xdg/state' },
      homeDir: '/home/user',
      cwd: '/cwd',
    });
    expect(resolved).toBe(path.posix.normalize('/xdg/state/@balaenis/pi-agents/runs'));
  });

  it('does not trim whitespace-only values as empty (non-empty string wins)', () => {
    const resolved = resolveRunsRoot({
      rootDir: '  ',
      platform: 'linux',
      env: {},
      homeDir: '/home/user',
      cwd: '/cwd',
    });
    expect(resolved).toBe(path.posix.normalize('/cwd/  '));
  });

  it('Windows: prefers LOCALAPPDATA and appends package segments', () => {
    const resolved = resolveRunsRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      homeDir: 'C:\\Users\\me',
      cwd: 'C:\\cwd',
    });
    expect(resolved).toBe(
      path.win32.normalize('C:\\Users\\me\\AppData\\Local\\@balaenis\\pi-agents\\runs')
    );
  });

  it('Windows: falls back to <home>/AppData/Local when LOCALAPPDATA is empty', () => {
    const resolved = resolveRunsRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: '' },
      homeDir: 'C:\\Users\\me',
      cwd: 'C:\\cwd',
    });
    expect(resolved).toBe(
      path.win32.normalize('C:\\Users\\me\\AppData\\Local\\@balaenis\\pi-agents\\runs')
    );
  });

  it('Linux/macOS/FreeBSD: prefers XDG_STATE_HOME and appends package segments', () => {
    for (const platform of ['linux', 'darwin', 'freebsd'] as const) {
      const resolved = resolveRunsRoot({
        platform,
        env: { XDG_STATE_HOME: '/var/lib/state' },
        homeDir: '/home/user',
        cwd: '/cwd',
      });
      expect(resolved).toBe(path.posix.normalize('/var/lib/state/@balaenis/pi-agents/runs'));
    }
  });

  it('non-Windows: falls back to <home>/.local/state when XDG_STATE_HOME is empty', () => {
    const resolved = resolveRunsRoot({
      platform: 'linux',
      env: { XDG_STATE_HOME: '' },
      homeDir: '/home/user',
      cwd: '/cwd',
    });
    expect(resolved).toBe(path.posix.normalize('/home/user/.local/state/@balaenis/pi-agents/runs'));
  });

  it('ignores TMPDIR/TEMP/TMP environment variables for default roots', () => {
    const resolved = resolveRunsRoot({
      platform: 'linux',
      env: {
        TMPDIR: '/tmp/custom',
        TEMP: '/tmp/temp',
        TMP: '/tmp/tmp',
        XDG_STATE_HOME: '',
      },
      homeDir: '/home/user',
      cwd: '/cwd',
    });
    expect(resolved).toBe(path.posix.normalize('/home/user/.local/state/@balaenis/pi-agents/runs'));
    expect(resolved.includes('/tmp')).toBe(false);
  });

  it('getDefaultRunsRoot matches resolveRunsRoot() for the live process', () => {
    expect(getDefaultRunsRoot()).toBe(resolveRunsRoot());
  });
});

describe('initializeRunsRoot', () => {
  it('creates the root recursively and reports capabilities', () => {
    const parent = makeTempRoot();
    const root = path.join(parent, 'nested', 'runs');
    const caps: RunStoreCapabilities = initializeRunsRoot(root);
    expect(fs.statSync(root).isDirectory()).toBe(true);
    expect(caps.fileFsync).toBe(true);
    expect(typeof caps.directoryFsync).toBe('boolean');
    // Successful probe leaves no known probe files.
    const entries = fs.readdirSync(root);
    expect(entries.every((n) => !n.startsWith('.capability-'))).toBe(true);
  });

  it('rejects empty rootDir', () => {
    expect(() => initializeRunsRoot('')).toThrow();
    try {
      initializeRunsRoot('');
    } catch (err) {
      expect(err).toMatchObject({ code: 'run_store_error' });
    }
  });

  it('leaves no probe leftovers after successful init', () => {
    const root = makeTempRoot();
    initializeRunsRoot(root);
    const leftovers = fs.readdirSync(root).filter((n) => n.startsWith('.capability-'));
    expect(leftovers).toEqual([]);
  });
});

describe('isNoReplaceContentionError', () => {
  it('treats EEXIST and ENOTEMPTY as contention', () => {
    expect(
      isNoReplaceContentionError(
        Object.assign(new Error('exists'), { code: 'EEXIST' }),
        () => false
      )
    ).toBe(true);
    expect(
      isNoReplaceContentionError(
        Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' }),
        () => false
      )
    ).toBe(true);
  });

  it('Windows EPERM is contention only when destination exists', () => {
    expect(
      isNoReplaceContentionError(
        Object.assign(new Error('perm'), { code: 'EPERM' }),
        () => true,
        'win32'
      )
    ).toBe(true);
    expect(
      isNoReplaceContentionError(
        Object.assign(new Error('perm'), { code: 'EPERM' }),
        () => false,
        'win32'
      )
    ).toBe(false);
  });

  it('non-Windows EPERM is not contention', () => {
    expect(
      isNoReplaceContentionError(
        Object.assign(new Error('perm'), { code: 'EPERM' }),
        () => true,
        'linux'
      )
    ).toBe(false);
  });

  it('other errors are not contention', () => {
    expect(
      isNoReplaceContentionError(Object.assign(new Error('io'), { code: 'EIO' }), () => true)
    ).toBe(false);
    expect(isNoReplaceContentionError(new Error('plain'), () => true)).toBe(false);
  });
});

describe('capability probe failure surfaces', () => {
  it('surfaces run_store_error when root cannot be created as a directory', () => {
    const parent = makeTempRoot();
    const fileAsRoot = path.join(parent, 'not-a-dir');
    fs.writeFileSync(fileAsRoot, 'x');
    try {
      initializeRunsRoot(fileAsRoot);
      expect.unreachable('expected initializeRunsRoot to throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'run_store_error' });
      expect(String((err as { message: string }).message)).toMatch(/cannot create runs root/i);
    }
  });
});

describe('capability probeFs seams', () => {
  it('surfaces run_store_error when injected regular-file fsync fails', () => {
    const root = makeTempRoot();
    try {
      initializeRunsRoot(root, {
        probeFs: {
          fsyncSync: () => {
            throw Object.assign(new Error('injected-file-fsync'), { code: 'EIO' });
          },
        },
      });
      expect.unreachable('expected file fsync probe to throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'run_store_error' });
      expect(String((err as { message: string }).message)).toMatch(/regular-file fsync/i);
    }
  });

  it('surfaces run_store_error when injected hard-link fails', () => {
    const root = makeTempRoot();
    try {
      initializeRunsRoot(root, {
        probeFs: {
          linkSync: () => {
            throw Object.assign(new Error('injected-link'), { code: 'EPERM' });
          },
        },
      });
      expect.unreachable('expected hard-link probe to throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'run_store_error' });
      expect(String((err as { message: string }).message)).toMatch(/hard-link/i);
    }
  });

  it('reports directoryFsync false when directory fsync fails with documented code', () => {
    const root = makeTempRoot();
    const caps = initializeRunsRoot(root, {
      platform: 'linux',
      probeFs: {
        fsyncSync: (fd: number) => {
          const st = fs.fstatSync(fd);
          if (st.isDirectory()) {
            throw Object.assign(new Error('dir-fsync-unsupported'), { code: 'EINVAL' });
          }
          fs.fsyncSync(fd);
        },
      },
    });
    expect(caps.fileFsync).toBe(true);
    expect(caps.directoryFsync).toBe(false);
  });

  it('surfaces unexpected directory-fsync errors as run_store_error', () => {
    const root = makeTempRoot();
    try {
      initializeRunsRoot(root, {
        platform: 'linux',
        probeFs: {
          fsyncSync: (fd: number) => {
            const st = fs.fstatSync(fd);
            if (st.isDirectory()) {
              throw Object.assign(new Error('unexpected-dir-fsync'), { code: 'EIO' });
            }
            fs.fsyncSync(fd);
          },
        },
      });
      expect.unreachable('expected unexpected directory fsync to throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'run_store_error' });
      expect(String((err as { message: string }).message)).toMatch(/directory fsync/i);
    }
  });
});
