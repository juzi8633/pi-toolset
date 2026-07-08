// ABOUTME: pi-lsp adapter re-exporting the shared logger with package-local names.
// ABOUTME: Gated by PI_LSP_LOG_LEVEL (default error); streams to ~/.pi/@balaenis/pi-lsp/default.log.

import { homedir } from 'node:os';
import * as path from 'node:path';
import { createLogger, errorMessage } from '@balaenis/pi-log';

const DEFAULT_LOG_FILE = path.join(homedir(), '.pi', '@balaenis', 'pi-lsp', 'default.log');

const logger = createLogger({
  name: 'pi-lsp',
  envPrefix: 'PI_LSP',
  defaultLogFile: DEFAULT_LOG_FILE,
});

export function logForDebugging(message: string): void {
  logger.debug(message);
}

export function logError(error: unknown): void {
  logger.error(error);
}

export { errorMessage };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
