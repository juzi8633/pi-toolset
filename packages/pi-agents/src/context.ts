// ABOUTME: Resolves fresh-vs-fork context per agent and produces a session file path for the child.
// ABOUTME: Mirrors pi-subagents by opening the parent session file with SessionManager.open() and branching from its leaf.

import * as fs from 'node:fs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from './agents.ts';

export interface AgentContext {
  mode: 'fresh' | 'fork';
  sessionFile: string | undefined;
  cleanup: () => Promise<void>;
}

export function prepareAgentContext(agent: AgentConfig, ctx: ExtensionContext): AgentContext {
  const mode = agent.defaultContext ?? 'fresh';
  if (mode === 'fresh') {
    return { mode: 'fresh', sessionFile: undefined, cleanup: async () => {} };
  }

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

  const sessionDir =
    typeof (ctx.sessionManager as { getSessionDir?: () => string }).getSessionDir === 'function'
      ? (ctx.sessionManager as { getSessionDir: () => string }).getSessionDir()
      : undefined;

  let sessionFile: string | undefined;
  try {
    const sourceManager = SessionManager.open(parentSessionFile, sessionDir);
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

  return {
    mode: 'fork',
    sessionFile,
    cleanup: async () => {},
  };
}
