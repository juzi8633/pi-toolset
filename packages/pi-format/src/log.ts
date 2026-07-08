// ABOUTME: pi-format adapter re-exporting the shared logger with package-local names.
// ABOUTME: Gated by PI_FORMAT_LOG_LEVEL (default error); streams to ~/.pi/@balaenis/pi-format/default.log.

import { homedir } from 'node:os';
import * as path from 'node:path';
import { createLogger, errorMessage } from '@balaenis/pi-log';

const DEFAULT_LOG_FILE = path.join(homedir(), '.pi', '@balaenis', 'pi-format', 'default.log');

const logger = createLogger({
  name: 'pi-format',
  envPrefix: 'PI_FORMAT',
  defaultLogFile: DEFAULT_LOG_FILE,
});

export function logDebug(message: string): void {
  logger.debug(message);
}

export function logError(error: unknown): void {
  logger.error(error);
}

export { errorMessage };
