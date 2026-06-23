// ABOUTME: Shared formatting service used by the tool, command, and automatic hook.
// ABOUTME: Loads config, resolves formatters, runs commands, and summarizes results.

import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { BUILTIN_FORMATTER_RECIPES } from './recipes.ts';
import { createFormatterRegistry } from './registry.ts';
import { runFormatter } from './runner.ts';
import { getFormatConfig } from './config.ts';
import { logDebug, logError } from './log.ts';
import type {
  FormatMode,
  FormatOptions,
  FormatResult,
  FormatServiceContext,
  FormatSummary,
} from './types.ts';

/**
 * Format one or more files. Loads config and rebuilds the registry on every
 * invocation so config edits are picked up without a restart.
 */
export async function formatPaths(
  paths: string[],
  options: FormatOptions,
  ctx: FormatServiceContext
): Promise<FormatSummary> {
  const config = await getFormatConfig(ctx.cwd);

  if (!config.enabled) {
    return { formatted: [], skipped: [], failed: [], disabled: true };
  }

  if (options.mode === 'automatic' && !config.formatOnWrite) {
    return { formatted: [], skipped: [], failed: [], disabled: false };
  }

  const registry = createFormatterRegistry(ctx.cwd, config.formatters, BUILTIN_FORMATTER_RECIPES);
  const summary: FormatSummary = {
    formatted: [],
    skipped: [],
    failed: [],
    disabled: false,
  };

  for (const rawPath of paths) {
    const absolutePath = path.resolve(ctx.cwd, rawPath);

    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch {
      summary.skipped.push({ filePath: absolutePath, reason: 'file does not exist' });
      continue;
    }

    if (!fileStat.isFile()) {
      summary.skipped.push({ filePath: absolutePath, reason: 'not a file' });
      continue;
    }

    const formatterMatch = options.formatter
      ? await resolveForcedFormatter(registry, options.formatter, absolutePath, summary)
      : await registry.getFormatterForFile(absolutePath);
    if (!formatterMatch) {
      if (!options.formatter) {
        summary.skipped.push({ filePath: absolutePath, reason: 'no formatter for extension' });
      }
      continue;
    }

    try {
      const result = await runFormatter(
        formatterMatch.formatter.name,
        formatterMatch.command,
        formatterMatch.timeoutMs,
        absolutePath,
        options.mode,
        ctx
      );
      summary.formatted.push(result);
      logDebug(`formatted ${absolutePath} with ${formatterMatch.formatter.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.failed.push({
        filePath: absolutePath,
        formatterName: formatterMatch.formatter.name,
        error: message,
      });
      logError(error);

      if (options.mode === 'explicit') {
        throw error;
      }
    }
  }

  return summary;
}

/**
 * Render a concise text summary from a format result for LLM or UI consumption.
 */
export function formatSummaryText(summary: FormatSummary): string {
  if (summary.disabled) {
    return 'Formatting is disabled (enabled: false).';
  }

  const lines: string[] = [];

  if (summary.formatted.length > 0) {
    const names = [...new Set(summary.formatted.map((r) => r.formatterName))];
    lines.push(`Formatted ${summary.formatted.length} file(s) using ${names.join(', ')}.`);
  }

  if (summary.failed.length > 0) {
    lines.push(`Failed to format ${summary.failed.length} file(s):`);
    for (const failure of summary.failed) {
      lines.push(`  - ${failure.filePath}: ${failure.error}`);
    }
  }

  if (summary.skipped.length > 0) {
    const byReason = new Map<string, string[]>();
    for (const skipped of summary.skipped) {
      const list = byReason.get(skipped.reason) ?? [];
      list.push(skipped.filePath);
      byReason.set(skipped.reason, list);
    }
    lines.push(`Skipped ${summary.skipped.length} file(s):`);
    for (const [reason, files] of byReason) {
      lines.push(`  - ${reason}: ${files.length}`);
    }
  }

  if (lines.length === 0) {
    return 'Nothing to format.';
  }

  return lines.join('\n');
}

export type { FormatResult, FormatSummary, FormatMode, FormatOptions };

async function resolveForcedFormatter(
  registry: ReturnType<typeof createFormatterRegistry>,
  name: string,
  absolutePath: string,
  summary: FormatSummary
) {
  const result = await registry.getFormatterByName(name, absolutePath);
  switch (result.kind) {
    case 'match':
      return result.match;
    case 'unknown':
      summary.failed.push({
        filePath: absolutePath,
        formatterName: name,
        error: `formatter '${name}' is not configured`,
      });
      return undefined;
    case 'disabled':
      summary.skipped.push({
        filePath: absolutePath,
        reason: `formatter '${name}' is disabled`,
      });
      return undefined;
    case 'unavailable':
      summary.skipped.push({
        filePath: absolutePath,
        reason: `formatter '${name}' is unavailable`,
      });
      return undefined;
    case 'extension-mismatch':
      summary.skipped.push({
        filePath: absolutePath,
        reason: `formatter '${name}' does not support this extension (supports: ${result.supported.join(', ') || 'none'})`,
      });
      return undefined;
  }
}
