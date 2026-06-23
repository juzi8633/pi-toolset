// ABOUTME: Automatic post-write/edit formatting hook.
// ABOUTME: Listens for successful write/edit tool results and formats the target file.

import * as path from 'node:path';
import {
  isEditToolResult,
  isWriteToolResult,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { formatPaths } from './service.ts';
import { logDebug, logError } from './log.ts';
import type { FormatServiceContext } from './types.ts';

export function registerFormatHooks(pi: ExtensionAPI): void {
  pi.on('tool_result', async (event, ctx) => {
    if (!isWriteToolResult(event) && !isEditToolResult(event)) return;
    if (event.isError) return;

    const input = event.input as { path?: unknown };
    if (!input.path || typeof input.path !== 'string') return;

    const absolutePath = path.resolve(ctx.cwd, input.path);
    logDebug(`hook: auto-formatting ${absolutePath}`);

    try {
      await withFileMutationQueue(absolutePath, async () => {
        const result = await formatPaths([absolutePath], { mode: 'automatic' }, makeCtx(pi, ctx));

        if (result.disabled) {
          logDebug('hook: formatting disabled');
          return;
        }

        if (result.failed.length > 0) {
          const failure = result.failed[0]!;
          logError(new Error(`hook: auto-format failed for ${failure.filePath}: ${failure.error}`));
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Auto-format failed for ${failure.filePath}: ${failure.error}`,
              'warning'
            );
          }
        } else if (result.formatted.length > 0) {
          logDebug(`hook: formatted ${absolutePath}`);
        }
      });
    } catch (error) {
      logError(error);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Auto-format error: ${error instanceof Error ? error.message : String(error)}`,
          'warning'
        );
      }
    }
  });
}

function makeCtx(pi: ExtensionAPI, ctx: { cwd: string }): FormatServiceContext {
  return {
    cwd: ctx.cwd,
    exec: (command, args, options) => pi.exec(command, args, { cwd: ctx.cwd, ...options }),
  };
}
