// ABOUTME: Tests for invocation helpers — Pi CLI argument construction and runtime resolution.
// ABOUTME: Uses temp directories for prompt writes; mutates process.execPath via Object.defineProperty.

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentConfig } from '../src/agents.ts';
import { buildPiArgs, getPiInvocation, writePromptToTempFile } from '../src/invocation.ts';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'tester',
    description: 'test agent',
    systemPrompt: '',
    source: 'builtin',
    filePath: '/tmp/tester.md',
    ...overrides,
  };
}

describe('buildPiArgs', () => {
  it('produces base args with --no-session', () => {
    const args = buildPiArgs(makeAgent(), 'do work');
    expect(args).toEqual(['--mode', 'json', '-p', '--no-session', 'Task: do work']);
  });

  it('includes --model, --thinking, --tools, --append-system-prompt in order', () => {
    const args = buildPiArgs(
      makeAgent({ model: 'gpt-x', thinking: 'high', tools: ['read', 'bash'] }),
      'go',
      { tmpPromptPath: '/tmp/p.md' }
    );
    expect(args).toEqual([
      '--mode',
      'json',
      '-p',
      '--no-session',
      '--model',
      'gpt-x',
      '--thinking',
      'high',
      '--tools',
      'read,bash',
      '--append-system-prompt',
      '/tmp/p.md',
      'Task: go',
    ]);
  });

  it('omits --tools when agent has no tools', () => {
    const args = buildPiArgs(makeAgent({ tools: [] }), 'go');
    expect(args).not.toContain('--tools');
    const args2 = buildPiArgs(makeAgent({ tools: undefined }), 'go');
    expect(args2).not.toContain('--tools');
  });
});

describe('getPiInvocation', () => {
  it('falls back to `pi` when current script is missing and runtime is generic', () => {
    const originalArgv1 = process.argv[1];
    const originalExecPath = process.execPath;
    try {
      process.argv[1] = '/nonexistent/script.js';
      Object.defineProperty(process, 'execPath', { value: '/usr/bin/node', configurable: true });
      const inv = getPiInvocation(['--help']);
      expect(inv.command).toBe('pi');
      expect(inv.args).toEqual(['--help']);
    } finally {
      process.argv[1] = originalArgv1;
      Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    }
  });
});

describe('writePromptToTempFile', () => {
  it('writes the prompt to a unique temp file with 0o600 mode', async () => {
    const { dir, filePath } = await writePromptToTempFile('safe.name', 'hello');
    try {
      expect(existsSync(filePath)).toBe(true);
      expect(path.basename(filePath)).toBe('prompt-safe.name.md');
      if (process.platform !== 'win32') {
        expect(statSync(filePath).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes unsafe agent names in the filename', async () => {
    const { dir, filePath } = await writePromptToTempFile('a/b c', 'hi');
    try {
      expect(path.basename(filePath)).toBe('prompt-a_b_c.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the OS temp dir', async () => {
    const { dir } = await writePromptToTempFile('t', 'x');
    try {
      const tmpRoot = os.tmpdir();
      const ours = mkdtempSync(path.join(tmpRoot, 'probe-'));
      rmSync(ours, { recursive: true, force: true });
      expect(dir.startsWith(tmpRoot)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
