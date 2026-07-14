// ABOUTME: Resolves fresh-vs-fork context per agent and produces a session file path for the child.
// ABOUTME: Fresh sessions are persisted under the run directory; fork branches the parent session into it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from './agents.ts';

export interface AgentContext {
  mode: 'fresh' | 'fork';
  sessionFile: string | undefined;
  cleanup: () => Promise<void>;
}

export interface PrepareContextOptions {
  /** Actual child cwd (worktree path when isolated); defaults to ctx.cwd. */
  effectiveCwd?: string;
  /** Run id; present when persistence is active. */
  runId?: string;
  /** Unit id; present when persistence is active. */
  unitId?: string;
  /** Coordinator-provided session directory (<runDir>/sessions). When present, sessions are persisted. */
  sessionsDir?: string;
  /** Stored session file for resume; when set, the existing session is reused. */
  storedSessionFile?: string;
}

export function prepareAgentContext(
  agent: AgentConfig,
  ctx: ExtensionContext,
  options: PrepareContextOptions = {}
): AgentContext {
  const mode = agent.defaultContext ?? 'fresh';
  const effectiveCwd = options.effectiveCwd ?? ctx.cwd;
  const { sessionsDir, storedSessionFile } = options;

  // Resume path: a stored session file exists, reuse it directly.
  if (storedSessionFile) {
    if (!fs.existsSync(storedSessionFile)) {
      throw new Error(
        `Cannot resume context: stored session file does not exist: ${storedSessionFile}`
      );
    }
    return { mode, sessionFile: storedSessionFile, cleanup: async () => {} };
  }

  // Fresh mode without a sessions dir: legacy behavior (no persisted session).
  if (mode === 'fresh') {
    if (!sessionsDir) {
      return { mode: 'fresh', sessionFile: undefined, cleanup: async () => {} };
    }
    // Create a persisted native session beneath <runDir>/sessions.
    // The JSONL file is written lazily by Pi on first append; getSessionFile()
    // returns the planned path, so we record it without checking existence.
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    const manager = SessionManager.create(effectiveCwd, sessionsDir);
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) {
      throw new Error('Cannot create fresh context: SessionManager did not persist a session file');
    }
    // Verify the session file is planned beneath the run sessions dir.
    const resolved = path.resolve(sessionFile);
    const resolvedDir = path.resolve(sessionsDir);
    if (!resolved.startsWith(resolvedDir + path.sep) && resolved !== resolvedDir) {
      throw new Error(
        `Cannot create fresh context: session file is not beneath <runDir>/sessions: ${sessionFile}`
      );
    }
    return { mode: 'fresh', sessionFile, cleanup: async () => {} };
  }

  // Fork mode.
  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile) {
    throw new Error('Cannot fork parent context: parent session is not persisted');
  }
  if (!fs.existsSync(parentSessionFile)) {
    throw new Error(
      `Cannot fork parent context: parent session file does not exist: ${parentSessionFile}`
    );
  }

  const leafId = ctx.sessionManager.getLeafId();
  if (!leafId) {
    throw new Error('Cannot fork parent context: current session has no leaf entry');
  }

  const parentSessionDir =
    typeof (ctx.sessionManager as { getSessionDir?: () => string }).getSessionDir === 'function'
      ? (ctx.sessionManager as { getSessionDir: () => string }).getSessionDir()
      : undefined;

  // When a run sessions dir is provided, branch into it; otherwise use the
  // parent's session dir (legacy behavior).
  const targetSessionDir = sessionsDir ?? parentSessionDir;
  if (sessionsDir) {
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  }

  let sessionFile: string | undefined;
  try {
    const sourceManager = SessionManager.open(parentSessionFile, targetSessionDir);
    sessionFile = sourceManager.createBranchedSession(leafId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot fork parent context: ${message}`, { cause: err });
  }
  if (!sessionFile) {
    throw new Error('Cannot fork parent context: parent session is not persisted');
  }
  if (!fs.existsSync(sessionFile)) {
    throw new Error(`Cannot fork parent context: branched session file is missing: ${sessionFile}`);
  }
  // Verify the branched session lives beneath the run sessions dir when persistence is active.
  if (sessionsDir) {
    const resolved = path.resolve(sessionFile);
    const resolvedDir = path.resolve(sessionsDir);
    if (!resolved.startsWith(resolvedDir + path.sep) && resolved !== resolvedDir) {
      throw new Error(
        `Cannot fork parent context: branched session file is not beneath <runDir>/sessions: ${sessionFile}`
      );
    }
  }

  return {
    mode: 'fork',
    sessionFile,
    cleanup: async () => {},
  };
}
