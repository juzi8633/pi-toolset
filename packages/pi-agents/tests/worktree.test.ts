// ABOUTME: Tests for the git-worktree helpers — create, dirty status, and cleanup behavior.
// ABOUTME: Uses a temporary git repository; skips when `git` is unavailable on the host.

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createAgentWorktree,
  getGitRoot,
  getWorktreeDirtyStatus,
  removeAgentWorktree,
} from '../src/worktree.ts';

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
});

if (!gitAvailable) {
  // eslint-disable-next-line no-console
  console.warn('skipping worktree isolation tests: `git` is not available');
}
