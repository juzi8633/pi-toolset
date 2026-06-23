// ABOUTME: Tests for formatter command runner.
// ABOUTME: Covers $FILE substitution, timeout, killed, and failure handling.

import { describe, expect, it } from 'bun:test';
import { runFormatter, replaceFileToken } from '../src/runner.ts';
import type { FormatServiceContext } from '../src/types.ts';

function makeContext(
  execFn: (
    command: string,
    args: string[],
    options?: { timeout?: number; signal?: AbortSignal }
  ) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>
): FormatServiceContext {
  return {
    cwd: '/project',
    exec: execFn,
  };
}

describe('replaceFileToken', () => {
  it('replaces $FILE with the absolute path', () => {
    expect(replaceFileToken(['prettier', '--write', '$FILE'], '/project/file.ts')).toEqual([
      'prettier',
      '--write',
      '/project/file.ts',
    ]);
  });

  it('replaces multiple occurrences', () => {
    expect(replaceFileToken(['cmd', '$FILE', '$FILE.bak'], '/project/file.ts')).toEqual([
      'cmd',
      '/project/file.ts',
      '/project/file.ts.bak',
    ]);
  });
});

describe('runFormatter', () => {
  it('returns a result for successful execution', async () => {
    const ctx = makeContext(async (command, args, options) => {
      expect(command).toBe('prettier');
      expect(args).toEqual(['--write', '/project/file.ts']);
      expect(options?.timeout).toBe(5000);
      return { stdout: 'ok', stderr: '', code: 0, killed: false };
    });

    const result = await runFormatter(
      'prettier',
      ['prettier', '--write', '$FILE'],
      5000,
      '/project/file.ts',
      'explicit',
      ctx
    );

    expect(result.formatted).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.formatterName).toBe('prettier');
  });

  it('throws on non-zero exit code', async () => {
    const ctx = makeContext(async () => ({
      stdout: '',
      stderr: 'syntax error',
      code: 1,
      killed: false,
    }));

    await expect(
      runFormatter('fmt', ['fmt', '$FILE'], 30_000, '/project/file.ts', 'explicit', ctx)
    ).rejects.toThrow("Formatter 'fmt' failed for /project/file.ts: syntax error");
  });

  it('throws when execResult is killed (timeout)', async () => {
    const ctx = makeContext(async () => ({
      stdout: '',
      stderr: '',
      code: 0,
      killed: true,
    }));

    await expect(
      runFormatter('fmt', ['fmt', '$FILE'], 5000, '/project/file.ts', 'explicit', ctx)
    ).rejects.toThrow("Formatter 'fmt' timed out after 5000ms for /project/file.ts");
  });

  it('throws on missing executable error', async () => {
    const ctx = makeContext(async () => {
      throw new Error('spawn ENOENT');
    });

    await expect(
      runFormatter('fmt', ['fmt', '$FILE'], 30_000, '/project/file.ts', 'explicit', ctx)
    ).rejects.toThrow('spawn ENOENT');
  });
});
