// ABOUTME: Minimal internal logger for the format extension.
// ABOUTME: Gated by PI_FORMAT_LOG_LEVEL (default error); streams to ~/.pi/@balaenis/pi-format/default.log.

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

type LogLevel = 'debug' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, error: 1 };

function parseLogLevel(): LogLevel {
  const raw = process.env.PI_FORMAT_LOG_LEVEL?.toLowerCase().trim();
  if (raw === 'debug') return 'debug';
  return 'error';
}

const CURRENT_LEVEL = parseLogLevel();
const DEFAULT_LOG_FILE = path.join(homedir(), '.pi', '@balaenis', 'pi-format', 'default.log');
const LOG_FILE = process.env.PI_FORMAT_LOG_FILE?.trim() || DEFAULT_LOG_FILE;

let stream: WriteStream | null = null;
let streamDisabled = false;

function getStream(): WriteStream | null {
  if (streamDisabled) return null;
  if (stream) return stream;
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    stream = createWriteStream(LOG_FILE, { flags: 'a' });
    stream.on('error', () => {
      streamDisabled = true;
      stream = null;
    });
    return stream;
  } catch {
    streamDisabled = true;
    return null;
  }
}

function writeLine(line: string): void {
  const s = getStream();
  if (!s) return;
  s.write(`${new Date().toISOString()} ${line}\n`);
}

export function logDebug(message: string): void {
  if (LEVEL_ORDER[CURRENT_LEVEL] > LEVEL_ORDER.debug) return;
  writeLine(`[pi-format][debug] ${message}`);
}

export function logError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  writeLine(`[pi-format][error] ${message}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
