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

export function formatFailedAgentToolCall(params: unknown, failure: unknown): string {
  return `agent tool call failed params=${serialize(params)} failure=${serialize(failure)}`;
}

export function logFailedAgentToolCall(params: unknown, failure: unknown): void {
  logger.error(formatFailedAgentToolCall(params, failure));
}

interface AgentToolOutcome {
  content: unknown;
  isError?: boolean;
}

export async function withAgentToolFailureLogging<T extends AgentToolOutcome>(
  params: unknown,
  execute: () => Promise<T>,
  report: (params: unknown, failure: unknown) => void = logFailedAgentToolCall
): Promise<T> {
  try {
    const result = await execute();
    if (result.isError) report(params, result.content);
    return result;
  } catch (error) {
    report(params, error);
    throw error;
  }
}
