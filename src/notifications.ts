// ABOUTME: Session-scoped dedup + Pi UI helper for missing-server and failed-start messages.
// ABOUTME: Distinguishes "no server configured" (install hint) from "failed to start" (error reason).

import * as path from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { logForDebugging } from './log.ts';
import { getRecipeHintForExtension } from './recipes.ts';

/**
 * Reason a missing-server notification fires:
 * - "tool":  the agent invoked the `lsp` tool and no server is configured.
 * - "edit":  the agent edited or wrote a file with no compatible server.
 */
export type MissingServerReason = 'tool' | 'edit';

const notified = new Set<string>();

function key(ext: string, reason: MissingServerReason): string {
  return `${reason}:${ext.toLowerCase()}`;
}

/**
 * Format the message for the "no server configured" case (zero-config with no
 * recipe binary on PATH). Includes the recipe install hint.
 * Returns undefined when no built-in recipe covers the extension.
 */
export function formatMissingServerMessage(filePath: string): string | undefined {
  const ext = path.extname(filePath);
  const hint = getRecipeHintForExtension(ext);
  if (!hint) return undefined;
  return `No LSP server is configured for ${ext} files. ${hint}`;
}

/**
 * Format the message for the "server exists but failed to start" case.
 * Includes the actual error reason (from lastError) so the user can diagnose
 * the problem — e.g. "spawn pyright ENOENT" (path wrong), "crashed with exit
 * code 1" (bad args / crash), "timed out" (server hung).
 *
 * Does NOT include a recipe install hint: the user either configured the server
 * themselves, or the recipe detected the binary on PATH (so it IS installed,
 * it just failed to start for some other reason).
 */
export function formatFailedStartMessage(serverName: string, errorDetail?: string): string {
  const reason = errorDetail ? `: ${errorDetail}` : '';
  return `LSP server '${serverName}' failed to start${reason}.`;
}

/**
 * Notify the user once per session about a missing or failed LSP server.
 *
 * - When `serverName` is omitted: the "no server configured" case — shows the
 *   recipe install hint (e.g. "Install pyright via npm install -g pyright").
 * - When `serverName` is provided: the "failed to start" case — shows the
 *   error reason instead of an install hint.
 *
 * Safe to call from any handler:
 * - skips silently when ctx has no UI
 * - dedups by (extension, reason) for the no-config case, or by
 *   (extension, reason, serverName) when a server name is provided
 * - swallows recipe misses (unknown extensions stay silent) in the no-config case
 */
export function maybeNotifyMissingServer(
  filePath: string,
  ctx: ExtensionContext,
  reason: MissingServerReason,
  serverName?: string,
  errorDetail?: string
): void {
  if (!ctx?.hasUI || !ctx.ui?.notify) return;
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return;

  let message: string | undefined;
  if (serverName) {
    message = formatFailedStartMessage(serverName, errorDetail);
  } else {
    message = formatMissingServerMessage(filePath);
  }
  if (!message) return;

  const k = serverName ? `${reason}:${ext}:${serverName}` : key(ext, reason);
  if (notified.has(k)) return;
  notified.add(k);

  try {
    ctx.ui.notify(message, 'warning');
    logForDebugging(`notifications: surfaced hint for ${ext} (${reason})`);
  } catch (error) {
    // Notifications are advisory — never let UI disruptions disrupt LSP flows.
    logForDebugging(`notifications: ui.notify failed: ${(error as Error).message}`);
  }
}

/** Test-only: clear the dedup set. */
export function resetMissingServerNotifications(): void {
  notified.clear();
}
