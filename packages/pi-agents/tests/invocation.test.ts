// ABOUTME: Tests for invocation helpers — Pi CLI argument construction and runtime resolution.
// ABOUTME: Uses temp directories for prompt writes; mutates process.execPath via Object.defineProperty.

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentConfig } from '../src/agents.ts';
import {
  appendContinuationTasks,
  buildPiArgs,
  buildPiRpcArgs,
  buildSessionContinuationPrompt,
  getPiInvocation,
  RESUME_CONTINUATION_PROMPT,
  writePromptToTempFile,
} from '../src/invocation.ts';

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

  it('includes --exclude-tools when excludeTools is set', () => {
    const args = buildPiArgs(makeAgent({ tools: ['read'], excludeTools: ['write', 'edit'] }), 'go');
    expect(args).toContain('--exclude-tools');
    const idx = args.indexOf('--exclude-tools');
    expect(args[idx + 1]).toBe('write,edit');
  });

  it('uses --system-prompt when systemPromptMode is replace', () => {
    const args = buildPiArgs(makeAgent({ systemPromptMode: 'replace' }), 'go', {
      tmpPromptPath: '/tmp/p.md',
    });
    expect(args).toContain('--system-prompt');
    expect(args).not.toContain('--append-system-prompt');
  });

  it('uses --append-system-prompt when systemPromptMode is append (default)', () => {
    const args = buildPiArgs(makeAgent({ systemPromptMode: 'append' }), 'go', {
      tmpPromptPath: '/tmp/p.md',
    });
    expect(args).toContain('--append-system-prompt');
    expect(args).not.toContain('--system-prompt');
  });

  it('adds --no-context-files when noContextFiles is true', () => {
    const args = buildPiArgs(makeAgent({ noContextFiles: true }), 'go');
    expect(args).toContain('--no-context-files');
  });

  it('omits --no-context-files when noContextFiles is false or undefined', () => {
    expect(buildPiArgs(makeAgent({ noContextFiles: false }), 'go')).not.toContain(
      '--no-context-files'
    );
    expect(buildPiArgs(makeAgent(), 'go')).not.toContain('--no-context-files');
  });

  it('adds --no-skills when noSkills is true', () => {
    const args = buildPiArgs(makeAgent({ noSkills: true }), 'go');
    expect(args).toContain('--no-skills');
  });

  it('adds --no-skills and --skill <path> for each resolvedSkillPaths', () => {
    const args = buildPiArgs(makeAgent(), 'go', {
      resolvedSkillPaths: ['/abs/librarian/SKILL.md', '/abs/reviewer/SKILL.md'],
    });
    expect(args).toContain('--no-skills');
    const skillValues = args.filter((_, i) => i > 0 && args[i - 1] === '--skill');
    expect(skillValues).toEqual(['/abs/librarian/SKILL.md', '/abs/reviewer/SKILL.md']);
  });

  it('resolvedSkillPaths takes precedence over noSkills and emits --skill', () => {
    const args = buildPiArgs(makeAgent({ noSkills: true }), 'go', {
      resolvedSkillPaths: ['/abs/librarian/SKILL.md'],
    });
    expect(args.filter((a) => a === '--skill').length).toBe(1);
    expect(args).toContain('--no-skills');
  });

  it('omits skill flags when resolvedSkillPaths is empty', () => {
    const args = buildPiArgs(makeAgent(), 'go', { resolvedSkillPaths: [] });
    expect(args).not.toContain('--no-skills');
    expect(args).not.toContain('--skill');
  });

  it('uses --no-session in fresh context', () => {
    const args = buildPiArgs(makeAgent(), 'go');
    expect(args).toContain('--no-session');
    expect(args).not.toContain('--session');
  });

  it('uses --session <file> when a fork session file is provided', () => {
    const args = buildPiArgs(makeAgent(), 'go', { sessionFile: '/tmp/fork.jsonl' });
    expect(args).toContain('--session');
    const idx = args.indexOf('--session');
    expect(args[idx + 1]).toBe('/tmp/fork.jsonl');
    expect(args).not.toContain('--no-session');
  });

  it('sends Task: <task> once for a fresh task prompt', () => {
    const args = buildPiArgs(makeAgent(), 'do work', { prompt: { kind: 'task' } });
    expect(args[args.length - 1]).toBe('Task: do work');
    expect(args.filter((a) => a.startsWith('Task:')).length).toBe(1);
  });

  it('sends the fixed session-continuation prompt without resending the original task', () => {
    const args = buildPiArgs(makeAgent(), 'do work', {
      prompt: { kind: 'session_continuation' },
      sessionFile: '/tmp/stored.jsonl',
    });
    // Must reuse the stored session, not --no-session.
    expect(args).toContain('--session');
    expect(args).not.toContain('--no-session');
    // The last arg is the resume continuation, not Task: <task>.
    const last = args[args.length - 1];
    expect(last).not.toContain('Task: do work');
    expect(last).toBe(RESUME_CONTINUATION_PROMPT);
    expect(last).toContain('resuming');
    expect(last).toContain('interrupted');
  });

  it('appends the current continuation task exactly once on session continuation', () => {
    const args = buildPiArgs(makeAgent(), 'do work', {
      prompt: { kind: 'session_continuation', currentContinuationTask: 'Also verify migration.' },
      sessionFile: '/tmp/stored.jsonl',
    });
    const last = args[args.length - 1]!;
    expect(last).not.toContain('Task: do work');
    expect(last).toContain(RESUME_CONTINUATION_PROMPT);
    expect(last).toContain('Additional instruction for this resumed run:\nAlso verify migration.');
    expect(last.split('Additional instruction for this resumed run:').length - 1).toBe(1);
  });

  it('appends every undelivered continuation on session continuation', () => {
    const args = buildPiArgs(makeAgent(), 'do work', {
      prompt: {
        kind: 'session_continuation',
        undeliveredContinuationTasks: ['First undelivered', 'Second undelivered'],
      },
      sessionFile: '/tmp/stored.jsonl',
    });
    const last = args[args.length - 1]!;
    expect(last).toContain('First undelivered');
    expect(last).toContain('Second undelivered');
    expect(last.split('Additional instruction for this resumed run:').length - 1).toBe(2);
  });

  it('ignores a blank current continuation on session continuation', () => {
    const args = buildPiArgs(makeAgent(), 'do work', {
      prompt: { kind: 'session_continuation', currentContinuationTask: '   ' },
      sessionFile: '/tmp/stored.jsonl',
    });
    expect(args[args.length - 1]).toBe(RESUME_CONTINUATION_PROMPT);
  });

  it('forwards disableAgentTool to buildToolCliArgs', () => {
    const args = buildPiArgs(makeAgent({ tools: ['read'] }), 'go', { disableAgentTool: true });
    expect(args).toContain('--exclude-tools');
    const idx = args.indexOf('--exclude-tools');
    expect(args[idx + 1]).toBe('agent');
  });

  it('omits --tools when agent has no tools', () => {
    const args = buildPiArgs(makeAgent({ tools: [] }), 'go');
    expect(args).not.toContain('--tools');
    const args2 = buildPiArgs(makeAgent({ tools: undefined }), 'go');
    expect(args2).not.toContain('--tools');
  });
});

describe('appendContinuationTasks', () => {
  it('appends non-blank continuations with the stable delimiter', () => {
    const result = appendContinuationTasks('Original task', [
      'First follow-up',
      '  ',
      'Second follow-up',
    ]);
    expect(result).toBe(
      [
        'Original task',
        '',
        'Additional instruction for this resumed run:',
        'First follow-up',
        '',
        'Additional instruction for this resumed run:',
        'Second follow-up',
      ].join('\n')
    );
  });

  it('returns the original task when all continuations are blank', () => {
    expect(appendContinuationTasks('Original', ['', '  '])).toBe('Original');
  });
});

describe('buildSessionContinuationPrompt', () => {
  it('returns the fixed safety prompt when no current continuation is set', () => {
    expect(buildSessionContinuationPrompt()).toBe(RESUME_CONTINUATION_PROMPT);
    expect(buildSessionContinuationPrompt('  ')).toBe(RESUME_CONTINUATION_PROMPT);
  });

  it('appends a non-empty current continuation once', () => {
    const prompt = buildSessionContinuationPrompt('Finish validation.');
    expect(prompt.startsWith(RESUME_CONTINUATION_PROMPT)).toBe(true);
    expect(prompt).toContain('Additional instruction for this resumed run:\nFinish validation.');
  });
});

describe('buildPiRpcArgs', () => {
  it('uses --mode rpc without -p or argv prompt', () => {
    const args = buildPiRpcArgs(makeAgent({ model: 'gpt-x', thinking: 'high' }), {
      sessionFile: '/tmp/s.jsonl',
      tmpPromptPath: '/tmp/p.md',
    });
    expect(args[0]).toBe('--mode');
    expect(args[1]).toBe('rpc');
    expect(args).not.toContain('-p');
    expect(args.some((a) => a.startsWith('Task:'))).toBe(false);
    expect(args).toContain('--session');
    expect(args).toContain('/tmp/s.jsonl');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-x');
    expect(args).toContain('--thinking');
    expect(args).toContain('high');
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('/tmp/p.md');
    expect(args).toContain('-ne');
  });

  it('includes resolved skill paths and does not use --no-session', () => {
    const args = buildPiRpcArgs(makeAgent(), {
      sessionFile: '/tmp/s.jsonl',
      resolvedSkillPaths: ['/abs/skill/SKILL.md'],
    });
    expect(args).not.toContain('--no-session');
    expect(args).toContain('--skill');
    expect(args).toContain('/abs/skill/SKILL.md');
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
