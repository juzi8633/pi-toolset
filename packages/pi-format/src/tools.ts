// ABOUTME: Registers the LLM-callable `format` tool.
// ABOUTME: Provides TypeBox schema, execution, and compact TUI renderers.

import { Type } from '@earendil-works/pi-ai';
import { Text } from '@earendil-works/pi-tui';
import type { Static } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { formatPaths, formatSummaryText } from './service.ts';
import type { FormatServiceContext, FormatSummary } from './types.ts';

const PARAMETERS = Type.Object({
  paths: Type.Array(Type.String({ description: 'Path to a file to format' }), {
    description: 'One or more file paths to format.',
    minItems: 1,
  }),
  formatter: Type.Optional(
    Type.String({
      description: 'Optional formatter name to force for all files.',
    })
  ),
});

type Params = Static<typeof PARAMETERS>;

interface FormatToolDetails {
  formatted: string[];
  skipped: FormatSummary['skipped'];
  failed: FormatSummary['failed'];
}

const DESCRIPTION = `Format one or more files using project-local formatters.

Only formats files with a recognized extension and an available formatter.
Returns a summary of formatted, skipped, and failed files.`;

export function registerFormatTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'format',
    label: 'Format',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(_toolCallId, params: Params, _signal, _onUpdate, ctx) {
      if (!Array.isArray(params.paths) || params.paths.length === 0) {
        throw new Error('format tool requires at least one path');
      }
      const result = await formatPaths(
        params.paths,
        { mode: 'explicit', formatter: params.formatter },
        makeCtx(pi, ctx)
      );
      const text = formatSummaryText(result);
      if (result.failed.length > 0) {
        throw new Error(text);
      }
      return {
        content: [{ type: 'text', text }],
        details: {
          formatted: result.formatted.map((r) => r.filePath),
          skipped: result.skipped,
          failed: result.failed,
        },
      };
    },
    renderCall(args, theme) {
      const paths = Array.isArray(args.paths) ? args.paths : [];
      const formatter = typeof args.formatter === 'string' ? args.formatter : undefined;
      let text = theme.fg('toolTitle', theme.bold('format'));
      text += theme.fg('dim', ' ');
      text += theme.fg('accent', paths.join(' '));
      if (formatter) {
        text += theme.fg('dim', ` — ${formatter}`);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg('warning', 'Formatting...'), 0, 0);

      const content = result.content[0];
      if (content?.type !== 'text') {
        return new Text(theme.fg('error', 'No output'), 0, 0);
      }

      const details = result.details as FormatToolDetails | undefined;
      const failed = details?.failed.length ?? 0;
      const formatted = details?.formatted.length ?? 0;

      let text =
        failed > 0
          ? theme.fg('error', `Formatting failed (${failed})`)
          : theme.fg('success', `Formatted ${formatted} file${formatted !== 1 ? 's' : ''}`);

      if (expanded && content.text) {
        text += '\n' + theme.fg('dim', content.text);
      } else if (content.text.trim()) {
        text += theme.fg('muted', ' · ctrl+o to expand');
      }

      return new Text(text, 0, 0);
    },
  });
}

function makeCtx(pi: ExtensionAPI, ctx: ExtensionContext): FormatServiceContext {
  return {
    cwd: ctx.cwd,
    exec: (command, args, options) => pi.exec(command, args, { cwd: ctx.cwd, ...options }),
  };
}
