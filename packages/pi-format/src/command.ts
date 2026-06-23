// ABOUTME: Registers the /format slash command.
// ABOUTME: Parses arguments, waits for idle, and shows UI notifications.

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { formatPaths, formatSummaryText } from './service.ts';
import type { FormatServiceContext } from './types.ts';

export function registerFormatCommand(pi: ExtensionAPI): void {
  pi.registerCommand('format', {
    description: 'Format one or more files using project-local formatters.',
    handler: async (args, ctx) => {
      const { paths, formatter } = parseCommandArgs(args);

      if (paths.length === 0) {
        ctx.ui.notify(
          'Usage: /format <path...> or /format --formatter <name> <path...>',
          'warning'
        );
        return;
      }

      await ctx.waitForIdle();

      try {
        const result = await formatPaths(paths, { mode: 'explicit', formatter }, makeCtx(pi, ctx));
        const text = formatSummaryText(result);

        if (result.failed.length > 0) {
          ctx.ui.notify(text, 'error');
          return;
        }
        if (result.formatted.length === 0 && result.skipped.length > 0) {
          ctx.ui.notify(text, 'warning');
          return;
        }
        ctx.ui.notify(text, 'info');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Formatting failed: ${message}`, 'error');
      }
    },
  });
}

function parseCommandArgs(args: string): { paths: string[]; formatter?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const paths: string[] = [];
  let formatter: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '--formatter' || token === '-f') {
      formatter = tokens[++i];
      continue;
    }
    paths.push(token);
  }

  return { paths, formatter };
}

function makeCtx(pi: ExtensionAPI, ctx: ExtensionCommandContext): FormatServiceContext {
  return {
    cwd: ctx.cwd,
    exec: (command, args, options) => pi.exec(command, args, { cwd: ctx.cwd, ...options }),
  };
}
