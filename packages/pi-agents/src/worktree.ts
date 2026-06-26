// ABOUTME: Git worktree helpers for optional per-agent isolation under <repo>/.worktrees/.
// ABOUTME: Wraps `git -C <repo> worktree add/remove` and `git status --porcelain` for dirty detection.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function getGitRoot(cwd: string): string | undefined {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) return undefined;
  const out = result.stdout.trim();
  return out || undefined;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) || 'agent';
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

function isUnderWorktreesDir(repoRoot: string, candidate: string): boolean {
  const root = path.resolve(repoRoot);
  const target = path.resolve(candidate);
  const expectedBase = path.join(root, '.worktrees') + path.sep;
  return target !== root && target.startsWith(expectedBase);
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
