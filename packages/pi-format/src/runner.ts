// ABOUTME: Formatter command runner.
// ABOUTME: Substitutes $FILE, enforces timeout, and shapes results.

import {
  truncateTail,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from '@earendil-works/pi-coding-agent';
import type { FormatMode, FormatResult, FormatServiceContext } from './types.ts';

/**
 * Replace every exact `$FILE` argument or `$FILE` substring with the absolute
 * file path.
 */
export function replaceFileToken(args: string[], filePath: string): string[] {
  return args.map((arg) => arg.replace(/\$FILE/g, filePath));
}

/**
 * Run a formatter command against a single file and return a structured result.
 * Throws on non-zero exit codes or execution errors.
 */
export async function runFormatter(
  formatterName: string,
  command: string[],
  timeoutMs: number,
  filePath: string,
  mode: FormatMode,
  ctx: FormatServiceContext
): Promise<FormatResult> {
  const args = replaceFileToken(command, filePath);

  const execResult = await ctx.exec(args[0]!, args.slice(1), {
    timeout: timeoutMs,
  });

  const stdout = truncateTail(execResult.stdout, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  }).content;
  const stderr = truncateTail(execResult.stderr, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  }).content;

  if (execResult.killed) {
    throw new Error(`Formatter '${formatterName}' timed out after ${timeoutMs}ms for ${filePath}`);
  }

  if (execResult.code !== 0) {
    const errorMessage =
      stderr.trim() || stdout.trim() || `formatter exited with code ${execResult.code}`;
    throw new Error(`Formatter '${formatterName}' failed for ${filePath}: ${errorMessage}`);
  }

  return {
    filePath,
    formatterName,
    command: args,
    exitCode: execResult.code,
    stdout,
    stderr,
    formatted: true,
    mode,
  };
}
