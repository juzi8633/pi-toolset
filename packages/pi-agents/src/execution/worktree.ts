// ABOUTME: Git worktree helpers for optional per-agent isolation under <repo>/.worktrees/.
// ABOUTME: Wraps `git worktree add/remove`, `git status --porcelain`, and `git diff` for dirty detection.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Either from 'effect/Either';
import { WORKTREE_NAME_MAX_CHARS } from '../shared/constants.ts';

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

/** Internal Either core: Right = created worktree; Left = Error to throw at boundary. */
function createAgentWorktreeEither(
  repoRoot: string,
  agentName: string,
  index: number
): Either.Either<AgentWorktree, Error> {
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
    return Either.left(new Error(`Failed to create worktree at ${dir}: ${msg}`));
  }
  return Either.right({ path: dir, repoRoot: root });
}

export function createAgentWorktree(repoRoot: string, agentName: string, index = 0): AgentWorktree {
  return Either.match(createAgentWorktreeEither(repoRoot, agentName, index), {
    onLeft: (err) => {
      throw err;
    },
    onRight: (worktree) => worktree,
  });
}

export interface DirtyStatusResult {
  ok: boolean;
  output: string;
  error?: string;
}

function getWorktreeDirtyStatusEither(
  worktreePath: string
): Either.Either<{ output: string }, { error: string }> {
  const result = spawnSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    return Either.left({
      error: (result.stderr || result.stdout || '').trim() || 'git status failed',
    });
  }
  return Either.right({ output: result.stdout });
}

export function getWorktreeDirtyStatus(worktreePath: string): DirtyStatusResult {
  return Either.match(getWorktreeDirtyStatusEither(worktreePath), {
    onLeft: ({ error }) => ({ ok: false, output: '', error }),
    onRight: ({ output }) => ({ ok: true, output }),
  });
}

export interface WorktreeDiffSummary {
  ok: boolean;
  stat?: string;
  changedFiles?: string[];
  error?: string;
}

type DiffSuccess = { stat: string; changedFiles: string[] };

function getWorktreeDiffSummaryEither(
  worktreePath: string
): Either.Either<DiffSuccess, { error: string }> {
  const stat = spawnSync('git', ['-C', worktreePath, 'diff', '--stat', '--no-ext-diff', 'HEAD'], {
    encoding: 'utf-8',
  });
  if (stat.status !== 0) {
    return Either.left({
      error: (stat.stderr || stat.stdout || '').trim() || 'git diff --stat failed',
    });
  }
  const names = spawnSync(
    'git',
    ['-C', worktreePath, 'diff', '--name-only', '--no-ext-diff', 'HEAD'],
    { encoding: 'utf-8' }
  );
  if (names.status !== 0) {
    return Either.left({
      error: (names.stderr || names.stdout || '').trim() || 'git diff --name-only failed',
    });
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
  return Either.right({ stat: stat.stdout, changedFiles });
}

export function getWorktreeDiffSummary(worktreePath: string): WorktreeDiffSummary {
  return Either.match(getWorktreeDiffSummaryEither(worktreePath), {
    onLeft: ({ error }) => ({ ok: false, error }),
    onRight: ({ stat, changedFiles }) => ({ ok: true, stat, changedFiles }),
  });
}

export interface WorktreeSetupHookResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

type SetupSuccess = { exitCode: 0; stdout: string; stderr: string };
type SetupFailure = {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
};

function runWorktreeSetupHookEither(
  worktreePath: string,
  command: string
): Either.Either<SetupSuccess, SetupFailure> {
  const result = spawnSync(command, {
    cwd: worktreePath,
    shell: true,
    encoding: 'utf-8',
  });
  if (result.error) {
    return Either.left({
      exitCode: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error.message,
    });
  }
  const exitCode = result.status ?? -1;
  if (exitCode !== 0) {
    return Either.left({
      exitCode,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    });
  }
  return Either.right({
    exitCode: 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  });
}

export function runWorktreeSetupHook(
  worktreePath: string,
  command: string
): WorktreeSetupHookResult {
  return Either.match(runWorktreeSetupHookEither(worktreePath, command), {
    onLeft: (failure) => ({ ok: false, ...failure }),
    onRight: (success) => ({ ok: true, ...success }),
  });
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

type OpenFailure = { error: string; code: 'worktree_unavailable' };

function openAgentWorktreeEither(
  repoRoot: string,
  storedPath: string
): Either.Either<AgentWorktree, OpenFailure> {
  const root = path.resolve(repoRoot);
  const candidate = path.resolve(storedPath);
  if (!isUnderWorktreesDir(root, candidate)) {
    return Either.left({
      error: `Stored worktree path is outside <repo>/.worktrees: ${storedPath}`,
      code: 'worktree_unavailable',
    });
  }
  if (!fs.existsSync(candidate)) {
    return Either.left({
      error: `Stored worktree path no longer exists: ${storedPath}`,
      code: 'worktree_unavailable',
    });
  }
  // Verify it is a registered worktree.
  const list = spawnSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf-8',
  });
  if (list.status !== 0) {
    return Either.left({
      error: `Cannot list worktrees: ${(list.stderr || '').trim()}`,
      code: 'worktree_unavailable',
    });
  }
  const registered = list.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length).trim()));
  if (!registered.includes(candidate)) {
    return Either.left({
      error: `Stored worktree is no longer registered: ${storedPath}`,
      code: 'worktree_unavailable',
    });
  }
  return Either.right({ path: candidate, repoRoot: root });
}

/** Reopen a stored worktree for resume without creating a replacement. */
export function openAgentWorktree(repoRoot: string, storedPath: string): OpenWorktreeResult {
  return Either.match(openAgentWorktreeEither(repoRoot, storedPath), {
    onLeft: (failure) => ({ ok: false, ...failure }),
    onRight: (worktree) => ({ ok: true, worktree }),
  });
}

export interface RemoveWorktreeResult {
  removed: boolean;
  error?: string;
}

type RemoveSuccess = { removed: true };
type RemoveFailure = { removed: false; error?: string };

function removeAgentWorktreeEither(
  worktree: AgentWorktree
): Either.Either<RemoveSuccess, RemoveFailure> {
  if (!isUnderWorktreesDir(worktree.repoRoot, worktree.path)) {
    return Either.left({
      removed: false,
      error: `Refusing to remove worktree outside <repo>/.worktrees: ${worktree.path}`,
    });
  }

  const result = spawnSync(
    'git',
    ['-C', worktree.repoRoot, 'worktree', 'remove', worktree.path, '--force'],
    { encoding: 'utf-8' }
  );
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').trim() || 'git worktree remove failed';
    return Either.left({ removed: false, error: msg });
  }
  if (fs.existsSync(worktree.path)) {
    try {
      fs.rmSync(worktree.path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  if (fs.existsSync(worktree.path)) {
    return Either.left({ removed: false });
  }
  return Either.right({ removed: true });
}

export function removeAgentWorktree(worktree: AgentWorktree): RemoveWorktreeResult {
  return Either.match(removeAgentWorktreeEither(worktree), {
    onLeft: (failure) => failure,
    onRight: (success) => success,
  });
}
