// ABOUTME: Tests for the shared format service.
// ABOUTME: Covers config handling, forced formatter, explicit vs automatic failures.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatPaths } from '../src/service.ts';
import type { FormatServiceContext } from '../src/types.ts';

let tmpRoot: string;
let agentDir: string;
let cwdDir: string;

const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

function makeContext(cwd: string, execFn?: FormatServiceContext['exec']): FormatServiceContext {
  return {
    cwd,
    exec: execFn ?? (async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
  };
}

function writeProjectConfig(content: string): void {
  const dir = path.join(cwdDir, '.pi', '@balaenis', 'pi-format');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), content);
}

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-format-service-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
});

beforeEach(() => {
  const sub = mkdtempSync(path.join(tmpRoot, 'case-'));
  agentDir = path.join(sub, 'agent');
  cwdDir = path.join(sub, 'cwd');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwdDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

describe('formatPaths', () => {
  it('formats a matching file using a built-in recipe', async () => {
    writeProjectConfig(
      JSON.stringify({
        formatters: {
          custom: { command: ['custom', '--write', '$FILE'], extensions: ['.ts'] },
        },
      })
    );
    const file = path.join(cwdDir, 'file.ts');
    writeFileSync(file, 'const x=1');

    let ran = false;
    const ctx = makeContext(cwdDir, async (command, args) => {
      expect(command).toBe('custom');
      expect(args[0]).toBe('--write');
      expect(args[1]).toBe(file);
      ran = true;
      return { stdout: '', stderr: '', code: 0, killed: false };
    });

    const summary = await formatPaths(['file.ts'], { mode: 'explicit' }, ctx);
    expect(ran).toBe(true);
    expect(summary.formatted.length).toBe(1);
  });

  it('skips files with no matching formatter', async () => {
    const file = path.join(cwdDir, 'file.unknown');
    writeFileSync(file, 'x');
    const summary = await formatPaths(['file.unknown'], { mode: 'explicit' }, makeContext(cwdDir));
    expect(summary.skipped.length).toBe(1);
    expect(summary.formatted.length).toBe(0);
  });

  it('throws on formatter failure in explicit mode', async () => {
    writeProjectConfig(
      JSON.stringify({
        formatters: {
          custom: { command: ['custom', '$FILE'], extensions: ['.ts'] },
        },
      })
    );
    const file = path.join(cwdDir, 'file.ts');
    writeFileSync(file, 'const x=1');
    const ctx = makeContext(cwdDir, async () => ({
      stdout: '',
      stderr: 'fail',
      code: 1,
      killed: false,
    }));

    await expect(formatPaths(['file.ts'], { mode: 'explicit' }, ctx)).rejects.toThrow('fail');
  });

  it('does not throw on formatter failure in automatic mode', async () => {
    writeProjectConfig(
      JSON.stringify({
        formatters: {
          custom: { command: ['custom', '$FILE'], extensions: ['.ts'] },
        },
      })
    );
    const file = path.join(cwdDir, 'file.ts');
    writeFileSync(file, 'const x=1');
    const ctx = makeContext(cwdDir, async () => ({
      stdout: '',
      stderr: 'fail',
      code: 1,
      killed: false,
    }));

    const summary = await formatPaths(['file.ts'], { mode: 'automatic' }, ctx);
    expect(summary.failed.length).toBe(1);
  });

  it('returns disabled summary when enabled is false', async () => {
    writeProjectConfig(JSON.stringify({ enabled: false }));
    const summary = await formatPaths(['file.ts'], { mode: 'explicit' }, makeContext(cwdDir));
    expect(summary.disabled).toBe(true);
  });

  it('skips automatic formatting when formatOnWrite is false', async () => {
    writeProjectConfig(JSON.stringify({ formatOnWrite: false }));
    const file = path.join(cwdDir, 'file.ts');
    writeFileSync(file, 'x');
    const summary = await formatPaths(['file.ts'], { mode: 'automatic' }, makeContext(cwdDir));
    expect(summary.formatted.length).toBe(0);
    expect(summary.skipped.length).toBe(0);
    expect(summary.disabled).toBe(false);
  });

  it('forces a specific formatter when requested', async () => {
    writeProjectConfig(
      JSON.stringify({
        formatters: {
          custom: {
            command: ['custom', '$FILE'],
            extensions: ['.ts'],
          },
        },
      })
    );
    const file = path.join(cwdDir, 'file.ts');
    writeFileSync(file, 'x');

    let ran = false;
    const ctx = makeContext(cwdDir, async (command) => {
      expect(command).toBe('custom');
      ran = true;
      return { stdout: '', stderr: '', code: 0, killed: false };
    });

    const summary = await formatPaths(['file.ts'], { mode: 'explicit', formatter: 'custom' }, ctx);
    expect(ran).toBe(true);
    expect(summary.formatted.length).toBe(1);
  });

  it('marks unknown forced formatter as failed in explicit mode', async () => {
    const file = path.join(cwdDir, 'file.ts');
    writeFileSync(file, 'x');
    const summary = await formatPaths(
      ['file.ts'],
      { mode: 'explicit', formatter: 'nonexistent' },
      makeContext(cwdDir)
    );
    expect(summary.failed.length).toBe(1);
    expect(summary.failed[0]?.formatterName).toBe('nonexistent');
  });

  it('skips when forced formatter does not support the file extension', async () => {
    writeProjectConfig(
      JSON.stringify({
        formatters: {
          'md-only': {
            command: ['custom', '$FILE'],
            extensions: ['.md'],
          },
        },
      })
    );
    const file = path.join(cwdDir, 'file.ts');
    writeFileSync(file, 'x');
    const summary = await formatPaths(
      ['file.ts'],
      { mode: 'explicit', formatter: 'md-only' },
      makeContext(cwdDir)
    );
    expect(summary.skipped.length).toBe(1);
    expect(summary.skipped[0]?.reason).toContain('does not support this extension');
  });

  it('uses a lower-priority forced formatter when requested', async () => {
    writeProjectConfig(
      JSON.stringify({
        formatters: {
          // 'rustfmt' is a built-in. Forcing it should select it even if a
          // higher-priority formatter (prettier) also matches.
          'low-priority': {
            command: ['low-priority', '$FILE'],
            extensions: ['.ts'],
          },
        },
      })
    );
    const file = path.join(cwdDir, 'file.ts');
    writeFileSync(file, 'x');

    let ran = false;
    const ctx = makeContext(cwdDir, async (command) => {
      expect(command).toBe('low-priority');
      ran = true;
      return { stdout: '', stderr: '', code: 0, killed: false };
    });

    const summary = await formatPaths(
      ['file.ts'],
      { mode: 'explicit', formatter: 'low-priority' },
      ctx
    );
    expect(ran).toBe(true);
    expect(summary.formatted.length).toBe(1);
  });
});
