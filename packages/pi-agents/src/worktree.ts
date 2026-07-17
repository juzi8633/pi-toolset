// ABOUTME: Git worktree helpers for optional per-agent isolation under <repo>/.worktrees/.
// ABOUTME: Wraps `git worktree add/remove`, `git status --porcelain`, and `git diff` for dirty detection.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WORKTREE_NAME_MAX_CHARS } from './constants.ts';

export function getGitRoot(cwd: string): string | undefined {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) return undefined;
  const out = result.stdout.trim();
  return out || undefined;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, WORKTREE_NAME_MAX_CHARS) || 'agent';
}

export interface AgentWorktree {
  path: string;
  repoRoot: string;
}

export function createAgentWorktree(repoRoot: string, agentName: string, index = 0): AgentWorktree {
  const root = path.resolve(repoRoot);
  const baseDir = path.join(root, '.worktrees');
  fs.mkdirSync(baseDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  const dir = path.join(baseDir, `pi-agent-${safeName(agentName)}-${stamp}-${index}-${rand}`);

  const result = spawnSync('git', ['-C', root, 'worktree', 'add', '--detach', dir, 'HEAD'], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').trim() || 'git worktree add failed';
    throw new Error(`Failed to create worktree at ${dir}: ${msg}`);
  }
  return { path: dir, repoRoot: root };
}

export interface DirtyStatusResult {
  ok: boolean;
  output: string;
  error?: string;
}

export function getWorktreeDirtyStatus(worktreePath: string): DirtyStatusResult {
  const result = spawnSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    return {
      ok: false,
      output: '',
      error: (result.stderr || result.stdout || '').trim() || 'git status failed',
    };
  }
  return { ok: true, output: result.stdout };
}

export interface WorktreeDiffSummary {
  ok: boolean;
  stat?: string;
  changedFiles?: string[];
  error?: string;
}

export function getWorktreeDiffSummary(worktreePath: string): WorktreeDiffSummary {
  const stat = spawnSync('git', ['-C', worktreePath, 'diff', '--stat', '--no-ext-diff', 'HEAD'], {
    encoding: 'utf-8',
  });
  if (stat.status !== 0) {
    return {
      ok: false,
      error: (stat.stderr || stat.stdout || '').trim() || 'git diff --stat failed',
    };
  }
  const names = spawnSync(
    'git',
    ['-C', worktreePath, 'diff', '--name-only', '--no-ext-diff', 'HEAD'],
    { encoding: 'utf-8' }
  );
  if (names.status !== 0) {
    return {
      ok: false,
      error: (names.stderr || names.stdout || '').trim() || 'git diff --name-only failed',
    };
  }
  const untracked = spawnSync(
    'git',
    ['-C', worktreePath, 'ls-files', '--others', '--exclude-standard'],
    { encoding: 'utf-8' }
  );
  const untrackedFiles =
    untracked.status === 0
      ? untracked.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const changedFiles = Array.from(
    new Set([
      ...names.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      ...untrackedFiles,
    ])
  );
  return { ok: true, stat: stat.stdout, changedFiles };
}

export interface WorktreeSetupHookResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export function runWorktreeSetupHook(
  worktreePath: string,
  command: string
): WorktreeSetupHookResult {
  const result = spawnSync(command, {
    cwd: worktreePath,
    shell: true,
    encoding: 'utf-8',
  });
  if (result.error) {
    return {
      ok: false,
      exitCode: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error.message,
    };
  }
  const exitCode = result.status ?? -1;
  if (exitCode !== 0) {
    return {
      ok: false,
      exitCode,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }
  return {
    ok: true,
    exitCode: 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function isUnderWorktreesDir(repoRoot: string, candidate: string): boolean {
  const root = path.resolve(repoRoot);
  const target = path.resolve(candidate);
  const expectedBase = path.join(root, '.worktrees') + path.sep;
  return target !== root && target.startsWith(expectedBase);
}

export type OpenWorktreeResult =
  | { ok: true; worktree: AgentWorktree }
  | { ok: false; error: string; code: 'worktree_unavailable' };

/** Reopen a stored worktree for resume without creating a replacement. */
export function openAgentWorktree(repoRoot: string, storedPath: string): OpenWorktreeResult {
  const root = path.resolve(repoRoot);
  const candidate = path.resolve(storedPath);
  if (!isUnderWorktreesDir(root, candidate)) {
    return {
      ok: false,
      error: `Stored worktree path is outside <repo>/.worktrees: ${storedPath}`,
      code: 'worktree_unavailable',
    };
  }
  if (!fs.existsSync(candidate)) {
    return {
      ok: false,
      error: `Stored worktree path no longer exists: ${storedPath}`,
      code: 'worktree_unavailable',
    };
  }
  // Verify it is a registered worktree.
  const list = spawnSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf-8',
  });
  if (list.status !== 0) {
    return {
      ok: false,
      error: `Cannot list worktrees: ${(list.stderr || '').trim()}`,
      code: 'worktree_unavailable',
    };
  }
  const registered = list.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length).trim()));
  if (!registered.includes(candidate)) {
    return {
      ok: false,
      error: `Stored worktree is no longer registered: ${storedPath}`,
      code: 'worktree_unavailable',
    };
  }
  return { ok: true, worktree: { path: candidate, repoRoot: root } };
}

export interface RemoveWorktreeResult {
  removed: boolean;
  error?: string;
}

export function removeAgentWorktree(worktree: AgentWorktree): RemoveWorktreeResult {
  if (!isUnderWorktreesDir(worktree.repoRoot, worktree.path)) {
    return {
      removed: false,
      error: `Refusing to remove worktree outside <repo>/.worktrees: ${worktree.path}`,
    };
  }

  const result = spawnSync(
    'git',
    ['-C', worktree.repoRoot, 'worktree', 'remove', worktree.path, '--force'],
    { encoding: 'utf-8' }
  );
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').trim() || 'git worktree remove failed';
    return { removed: false, error: msg };
  }
  if (fs.existsSync(worktree.path)) {
    try {
      fs.rmSync(worktree.path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  return { removed: !fs.existsSync(worktree.path) };
}
