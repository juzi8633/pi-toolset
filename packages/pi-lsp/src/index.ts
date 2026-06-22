// ABOUTME: Pi LSP extension entry point and session lifecycle wiring.
// ABOUTME: Lazily starts the manager, registers tools/commands, and injects diagnostics.

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isEditToolResult, isWriteToolResult } from '@earendil-works/pi-coding-agent';
import * as diagnostics from './diagnostics.ts';
import {
  initializeManager,
  getManager,
  shutdownManager,
  waitForInitialization,
} from './manager.ts';
import { maybeNotifyMissingServer } from './notifications.ts';
import { registerLspCommand } from './command.ts';
import { formatLspStatus } from './statusline.ts';
import { registerLspTool } from './tools.ts';
import { logForDebugging } from './log.ts';

/** customType tag used for injected diagnostic blocks so they can be stripped. */
const DIAGNOSTIC_CUSTOM_TYPE = 'lsp-diagnostics';

/** Status segment key used to identify the LSP indicator in setStatus. */
const LSP_STATUS_KEY = 'lsp';

export default function (pi: ExtensionAPI): void {
  // No process/timer/watcher work in the factory body — registering the tool is
  // pure metadata. All process spawning is deferred to first tool use.
  registerLspTool(pi);
  registerLspCommand(pi);

  let unsubscribeLspStatus: (() => void) | undefined;

  pi.on('session_start', (_event, ctx) => {
    // Synchronous, non-blocking, idempotent. Servers are lazily started on the
    // first tool call (or the first edit, via syncFileChange), not here.
    initializeManager(ctx.cwd);

    const manager = getManager();
    if (!manager) return;

    const render = (): void => {
      const text = formatLspStatus(manager.getStateCounts(), (color, str) =>
        ctx.ui.theme.fg(color, str)
      );
      ctx.ui.setStatus(LSP_STATUS_KEY, text);
    };

    unsubscribeLspStatus?.();
    unsubscribeLspStatus = manager.onServersChanged(render);
    render();
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    // Idempotent: fires on quit/reload/new/resume/fork. Tears down all servers
    // and clears diagnostic state so the next session starts clean.
    unsubscribeLspStatus?.();
    unsubscribeLspStatus = undefined;
    ctx.ui.setStatus(LSP_STATUS_KEY, undefined);

    await shutdownManager();
    diagnostics.resetAll();
  });

  // Inject passive diagnostics before each LLM call. Diagnostics drained here
  // are ephemeral (transformContext output is not persisted to the transcript),
  // so stripping prior blocks is a safety net rather than the common path.
  pi.on('context', (event, ctx) => {
    const messages = stripDiagnosticBlocks(event.messages);
    const block = diagnostics.drain(ctx.cwd);
    if (block) {
      logForDebugging(`diagnostics: injecting block for ${ctx.cwd}`, { level: 'debug' });
      messages.push({
        role: 'custom',
        customType: DIAGNOSTIC_CUSTOM_TYPE,
        content: block,
        display: false,
        timestamp: Date.now(),
      });
    }
    return { messages };
  });

  // After the agent edits or writes a file, re-sync it to the LSP server so it
  // re-publishes diagnostics, and clear the file's dedup cache so new issues can
  // surface even if they match previously delivered ones.
  pi.on('tool_result', async (event, ctx) => {
    if (!isEditToolResult(event) && !isWriteToolResult(event)) return;
    if (event.isError) return;

    const input = event.input as { path?: string };
    if (!input.path) return;

    const absolutePath = path.resolve(ctx.cwd, input.path);
    const uri = pathToFileURL(absolutePath).href;

    diagnostics.clearForFile(uri);

    // Make sure the manager is ready, then push the disk content to the server.
    // Best-effort: never let a sync failure disrupt the agent.
    try {
      await waitForInitialization();
      const manager = getManager();
      if (manager) {
        const configured = manager.getConfiguredServersForFile(absolutePath);
        const active = manager.getServersForFile(absolutePath);
        const primaryBefore = manager.getPrimaryServerForFile(absolutePath);
        // Snapshot the state *value*, not the live instance: `instance.state`
        // is a getter over mutable closure state, so re-reading after the
        // `await syncFileChange` would mirror the latest state and break the
        // "just transitioned to error" comparison below.
        const primaryStateBefore = primaryBefore?.state;

        // Surface a notification when:
        // - no configured server covers the file (recipe-hint case)
        // - only inactive manual servers cover the file (configured but dormant)
        // - the active primary failed to start (lastError available)
        if (configured.length === 0 || active.length === 0) {
          maybeNotifyMissingServer(absolutePath, ctx, 'edit');
        } else if (primaryBefore && primaryStateBefore === 'error') {
          maybeNotifyMissingServer(
            absolutePath,
            ctx,
            'edit',
            primaryBefore.name,
            primaryBefore.lastError?.message
          );
        }

        await manager.syncFileChange(absolutePath);

        // syncFileChange swallows per-server start failures so one bad server
        // can't block edit sync; re-check the active primary state after sync
        // and surface a failed-start notice if it just transitioned to 'error'.
        const primaryAfter = manager.getPrimaryServerForFile(absolutePath);
        if (primaryAfter && primaryAfter.state === 'error' && primaryStateBefore !== 'error') {
          maybeNotifyMissingServer(
            absolutePath,
            ctx,
            'edit',
            primaryAfter.name,
            primaryAfter.lastError?.message
          );
        }
      }
    } catch (error) {
      const manager = getManager();
      const server = manager?.getPrimaryServerForFile(absolutePath);
      if (server?.state === 'error') {
        maybeNotifyMissingServer(absolutePath, ctx, 'edit', server.name, server.lastError?.message);
      }
      // Logged inside the manager; swallow here to keep the hook non-disruptive.
      void error;
    }
  });
}

/**
 * Remove any previously injected diagnostic custom messages so they cannot
 * accumulate if a future change persists transformContext output.
 */
function stripDiagnosticBlocks(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((m) => {
    if (m.role !== 'custom') return true;
    return (m as { customType?: string }).customType !== DIAGNOSTIC_CUSTOM_TYPE;
  });
}
