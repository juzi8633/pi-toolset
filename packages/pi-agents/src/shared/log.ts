// ABOUTME: Package-local logging for failed agent tool invocations.
// ABOUTME: Records complete JSON tool parameters and failure details in the pi-agents log.

import { homedir } from 'node:os';
import * as path from 'node:path';
import { createLogger, errorMessage } from '@balaenis/pi-log';

const DEFAULT_LOG_FILE = path.join(homedir(), '.pi', '@balaenis', 'pi-agents', 'default.log');

const logger = createLogger({
  name: 'pi-agents',
  envPrefix: 'PI_AGENTS',
  defaultLogFile: DEFAULT_LOG_FILE,
});

function serialize(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (error) {
    return `[unserializable: ${errorMessage(error)}]`;
  }
}

/** Pull Error.stack values out of a failure payload for a dedicated log line. */
export function collectFailureStacks(failure: unknown): string[] {
  const stacks: string[] = [];
  const seen = new Set<string>();
  const add = (stack: unknown) => {
    if (typeof stack !== 'string' || !stack || seen.has(stack)) return;
    seen.add(stack);
    stacks.push(stack);
  };

  if (failure instanceof Error) {
    add(failure.stack);
    return stacks;
  }
  if (!failure || typeof failure !== 'object') return stacks;

  const record = failure as Record<string, unknown>;
  add(record.stack);
  add(record.errorStack);

  const details = record.details;
  if (details && typeof details === 'object') {
    const results = (details as { results?: unknown }).results;
    if (Array.isArray(results)) {
      for (const result of results) {
        if (!result || typeof result !== 'object') continue;
        add((result as { errorStack?: unknown }).errorStack);
        add((result as { stack?: unknown }).stack);
      }
    }
  }

  return stacks;
}

export function formatFailedAgentToolCall(params: unknown, failure: unknown): string {
  const base = `agent tool call failed params=${serialize(params)} failure=${serialize(failure)}`;
  const stacks = collectFailureStacks(failure);
  if (stacks.length === 0) return base;
  return `${base} stack=${stacks.map((stack) => serialize(stack)).join(' | ')}`;
}

export function logFailedAgentToolCall(params: unknown, failure: unknown): void {
  logger.error(formatFailedAgentToolCall(params, failure));
}

interface AgentToolOutcome {
  content: unknown;
  details?: unknown;
  isError?: boolean;
}

export async function withAgentToolFailureLogging<T extends AgentToolOutcome>(
  params: unknown,
  execute: () => Promise<T>,
  report: (params: unknown, failure: unknown) => void = logFailedAgentToolCall
): Promise<T> {
  try {
    const result = await execute();
    if (result.isError) {
      // Include details so per-result errorStack reaches the log file.
      report(params, {
        content: result.content,
        ...(result.details !== undefined ? { details: result.details } : {}),
      });
    }
    return result;
  } catch (error) {
    report(params, error);
    throw error;
  }
}
