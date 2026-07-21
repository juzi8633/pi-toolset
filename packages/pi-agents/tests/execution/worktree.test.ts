// ABOUTME: Tests for the git-worktree helpers — create, dirty status, and cleanup behavior.
// ABOUTME: Uses a temporary git repository; skips when `git` is unavailable on the host.

import { describe, expect, it, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as worktreeMod from '../../src/execution/worktree.ts';
import {
  createAgentWorktree,
  getGitRoot,
  getWorktreeDiffSummary,
  getWorktreeDirtyStatus,
  removeAgentWorktree,
  runWorktreeSetupHook,
} from '../../src/execution/worktree.ts';
import { finalizeWorktree, runHookOrSynthesizeFailure } from '../../src/execution/tool.ts';
import type { AgentConfig } from '../../src/config/agents.ts';
import type { SingleResult } from '../../src/shared/types.ts';

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

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: 'tester',
    agentSource: 'builtin',
    task: 'task',
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    finalOutput: '',
    ...overrides,
  };
}

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;

function makeRepo(): { repo: string; cleanup: () => void } {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-worktree-'));
  spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf-8' });
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'pi@test.example'], { encoding: 'utf-8' });
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'Pi Test'], { encoding: 'utf-8' });
  spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf-8' });
  writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
  spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf-8' });
  spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf-8' });
  return {
    repo,
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
}

describe.if(gitAvailable)('worktree isolation', () => {
  it('creates a detached worktree under .worktrees/ and removes it when clean', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const root = getGitRoot(repo);
      expect(root).toBe(repo);

      const wt = createAgentWorktree(repo, 'tester', 0);
      expect(wt.path.startsWith(path.join(repo, '.worktrees'))).toBe(true);
      expect(existsSync(path.join(wt.path, 'README.md'))).toBe(true);

      const dirty = getWorktreeDirtyStatus(wt.path);
      expect(dirty.ok).toBe(true);
      expect(dirty.output.trim()).toBe('');

      const removal = removeAgentWorktree(wt);
      expect(removal.removed).toBe(true);
      expect(existsSync(wt.path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('reports dirty status and keeps the worktree when files are modified', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const wt = createAgentWorktree(repo, 'mutator', 1);
      const target = path.join(wt.path, 'README.md');
      writeFileSync(target, 'edited\n');

      const dirty = getWorktreeDirtyStatus(wt.path);
      expect(dirty.ok).toBe(true);
      expect(dirty.output.trim().length).toBeGreaterThan(0);

      // Caller should NOT remove dirty worktrees; verify removal still works when forced.
      expect(existsSync(wt.path)).toBe(true);
      const removal = removeAgentWorktree(wt);
      expect(removal.removed).toBe(true);
      expect(existsSync(wt.path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('runWorktreeSetupHook returns ok and captures stdout for a successful command', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const wt = createAgentWorktree(repo, 'hooked', 2);
      const result = runWorktreeSetupHook(wt.path, 'printf hello');
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello');
      removeAgentWorktree(wt);
    } finally {
      cleanup();
    }
  });

  it('runWorktreeSetupHook surfaces non-zero exit codes', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const wt = createAgentWorktree(repo, 'badhook', 3);
      const result = runWorktreeSetupHook(wt.path, 'exit 7');
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(7);
      removeAgentWorktree(wt);
    } finally {
      cleanup();
    }
  });

  it('getWorktreeDiffSummary reports diff stat and changed files for tracked edits', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const wt = createAgentWorktree(repo, 'differ', 4);
      writeFileSync(path.join(wt.path, 'README.md'), 'edited\n');
      writeFileSync(path.join(wt.path, 'NEW.txt'), 'new file\n');
      const diff = getWorktreeDiffSummary(wt.path);
      expect(diff.ok).toBe(true);
      expect(diff.stat ?? '').toContain('README.md');
      expect(diff.changedFiles).toContain('README.md');
      expect(diff.changedFiles).toContain('NEW.txt');
      removeAgentWorktree(wt);
    } finally {
      cleanup();
    }
  });
});

describe('worktree helpers (no git)', () => {
  it('getGitRoot returns undefined outside a git repository', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-nogit-'));
    try {
      expect(getGitRoot(tmp)).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('removeAgentWorktree refuses paths outside <repo>/.worktrees', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-guard-'));
    try {
      const result = removeAgentWorktree({ path: tmp, repoRoot: tmp });
      expect(result.removed).toBe(false);
      expect(result.error).toMatch(/Refusing to remove worktree outside/);
      expect(existsSync(tmp)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('finalizeWorktree removes the worktree when the child left it clean', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const wt = createAgentWorktree(repo, 'finalize-clean', 7);
      const result = makeResult();
      finalizeWorktree(wt, result);
      expect(result.worktreePath).toBeUndefined();
      expect(result.worktreeDirty).toBeUndefined();
      expect(result.worktreeDiffStat).toBeUndefined();
      expect(result.worktreeChangedFiles).toBeUndefined();
      expect(existsSync(wt.path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('finalizeWorktree retains a dirty worktree and exposes diff metadata', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const wt = createAgentWorktree(repo, 'finalize-dirty', 8);
      writeFileSync(path.join(wt.path, 'README.md'), 'edited\n');
      writeFileSync(path.join(wt.path, 'NEW.txt'), 'fresh\n');
      const result = makeResult();
      finalizeWorktree(wt, result);
      expect(result.worktreePath).toBe(wt.path);
      expect(result.worktreeDirty).toBe(true);
      expect(result.worktreeDiffStat ?? '').toContain('README.md');
      expect(result.worktreeChangedFiles).toContain('README.md');
      expect(result.worktreeChangedFiles).toContain('NEW.txt');
      expect(existsSync(wt.path)).toBe(true);
      removeAgentWorktree(wt);
    } finally {
      cleanup();
    }
  });

  it('runHookOrSynthesizeFailure deletes a clean worktree and returns worktree_setup_error', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const wt = createAgentWorktree(repo, 'hook-clean-fail', 9);
      const failure = runHookOrSynthesizeFailure(
        'tester',
        makeAgent({ worktreeSetupHook: 'exit 3' }),
        'do the thing',
        2,
        wt
      );
      expect(failure).toBeDefined();
      expect(failure!.stopReason).toBe('worktree_setup_error');
      expect(failure!.exitCode).toBe(1);
      expect(failure!.worktreeSetupError).toContain('exit 3');
      expect(failure!.worktreePath).toBeUndefined();
      expect(failure!.worktreeDirty).toBeUndefined();
      expect(existsSync(wt.path)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('runHookOrSynthesizeFailure keeps a dirty worktree and surfaces its path', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const wt = createAgentWorktree(repo, 'hook-dirty-fail', 10);
      const failure = runHookOrSynthesizeFailure(
        'tester',
        makeAgent({ worktreeSetupHook: 'printf scratch > scratch.txt && exit 4' }),
        'do the thing',
        3,
        wt
      );
      expect(failure).toBeDefined();
      expect(failure!.stopReason).toBe('worktree_setup_error');
      expect(failure!.worktreePath).toBe(wt.path);
      expect(failure!.worktreeDirty).toBe(true);
      expect(existsSync(wt.path)).toBe(true);
      removeAgentWorktree(wt);
    } finally {
      cleanup();
    }
  });

  it('runHookOrSynthesizeFailure returns undefined when the hook succeeds', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const wt = createAgentWorktree(repo, 'hook-success', 11);
      const result = runHookOrSynthesizeFailure(
        'tester',
        makeAgent({ worktreeSetupHook: 'true' }),
        'do the thing',
        4,
        wt
      );
      expect(result).toBeUndefined();
      removeAgentWorktree(wt);
    } finally {
      cleanup();
    }
  });

  it('runHookOrSynthesizeFailure retains dirty hook-created changes without force-delete', () => {
    const { repo, cleanup } = makeRepo();
    try {
      const wt = createAgentWorktree(repo, 'hook-dirty-retain', 12);
      const marker = path.join(wt.path, 'hook-created.txt');
      const failure = runHookOrSynthesizeFailure(
        'tester',
        makeAgent({
          worktreeSetupHook: 'printf retained-by-hook > hook-created.txt && exit 7',
        }),
        'setup should fail dirty',
        5,
        wt
      );
      expect(failure).toBeDefined();
      expect(failure!.stopReason).toBe('worktree_setup_error');
      expect(failure!.status ?? 'failed').toBe('failed');
      expect(failure!.worktreePath).toBe(wt.path);
      expect(failure!.worktreeDirty).toBe(true);
      expect(existsSync(wt.path)).toBe(true);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, 'utf-8')).toContain('retained-by-hook');
      expect(failure!.worktreeChangedFiles ?? []).toContain('hook-created.txt');
      removeAgentWorktree(wt);
    } finally {
      cleanup();
    }
  });

  it('runHookOrSynthesizeFailure retains path when clean removal fails', () => {
    const { repo, cleanup } = makeRepo();
    let wt: ReturnType<typeof createAgentWorktree> | undefined;
    const removeSpy = spyOn(worktreeMod, 'removeAgentWorktree').mockImplementation(() => ({
      removed: false,
      error: 'injected clean removal failure',
    }));
    try {
      wt = createAgentWorktree(repo, 'hook-clean-remove-fail', 13);
      const failure = runHookOrSynthesizeFailure(
        'tester',
        makeAgent({ worktreeSetupHook: 'exit 9' }),
        'clean hook fail but remove fails',
        6,
        wt
      );
      expect(failure).toBeDefined();
      expect(failure!.stopReason).toBe('worktree_setup_error');
      expect(failure!.worktreePath).toBe(wt.path);
      expect(failure!.worktreeDirty).toBe(false);
      expect(failure!.stderr).toContain('injected clean removal failure');
      expect(existsSync(wt.path)).toBe(true);
      expect(removeSpy).toHaveBeenCalled();
    } finally {
      removeSpy.mockRestore();
      if (wt) removeAgentWorktree(wt);
      cleanup();
    }
  });
});

if (!gitAvailable) {
  // eslint-disable-next-line no-console
  console.warn('skipping worktree isolation tests: `git` is not available');
}
