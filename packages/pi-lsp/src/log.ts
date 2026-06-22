// ABOUTME: Minimal internal logger for the LSP extension.
// ABOUTME: Gated by PI_LSP_LOG_LEVEL (default error); streams to ~/.pi/pi-x-ide/debug.log (override with PI_LSP_LOG_FILE).

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

type LogLevel = 'debug' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, error: 1 };

function parseLogLevel(): LogLevel {
  const raw = process.env.PI_LSP_LOG_LEVEL?.toLowerCase().trim();
  if (raw === 'debug') return 'debug';
  return 'error';
}

const CURRENT_LEVEL = parseLogLevel();
const DEFAULT_LOG_FILE = path.join(homedir(), '.pi', 'pi-x-ide', 'debug.log');
const LOG_FILE = process.env.PI_LSP_LOG_FILE?.trim() || DEFAULT_LOG_FILE;

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
  // WriteStream.write is non-blocking; writes are queued and ordered within the stream.
  s.write(`${new Date().toISOString()} ${line}\n`);
}

export function logForDebugging(message: string, options?: { level?: string }): void {
  if (LEVEL_ORDER[CURRENT_LEVEL] > LEVEL_ORDER.debug) return;
  const level = options?.level ? `[${options.level}]` : '';
  writeLine(`[pi-lsp]${level} ${message}`);
}

export function logError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  writeLine(`[pi-lsp][error] ${message}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
