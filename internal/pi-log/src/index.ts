// ABOUTME: Shared private logger factory for the pi-toolset monorepo.
// ABOUTME: Reads level/file env vars at creation time and streams lines to a file.

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import * as path from 'node:path';

type LogLevel = 'debug' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, error: 1 };

export interface LoggerOptions {
  name: string;
  envPrefix: string;
  defaultLogFile: string;
  env?: Record<string, string | undefined>;
}

export interface Logger {
  debug(message: string): void;
  error(error: unknown): void;
  /** Flush pending writes and close the underlying stream. Safe to call multiple times. */
  close(): Promise<void>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLogger(options: LoggerOptions): Logger {
  const env = options.env ?? process.env;
  const rawLevel = env[`${options.envPrefix}_LOG_LEVEL`]?.toLowerCase().trim();
  const currentLevel: LogLevel = rawLevel === 'debug' ? 'debug' : 'error';
  const logFile = env[`${options.envPrefix}_LOG_FILE`]?.trim() || options.defaultLogFile;

  let stream: WriteStream | null = null;
  let streamDisabled = false;

  function getStream(): WriteStream | null {
    if (streamDisabled) return null;
    if (stream) return stream;
    try {
      mkdirSync(path.dirname(logFile), { recursive: true });
      stream = createWriteStream(logFile, { flags: 'a' });
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

  function close(): Promise<void> {
    if (!stream) return Promise.resolve();
    const s = stream;
    stream = null;
    // end() drains buffered writes before closing; the attached 'error' listener
    // keeps an errored stream from throwing during teardown.
    return new Promise<void>((resolve) => {
      s.end(resolve);
    });
  }

  return {
    debug(message: string): void {
      if (LEVEL_ORDER[currentLevel] > LEVEL_ORDER.debug) return;
      writeLine(`[${options.name}][debug] ${message}`);
    },
    error(error: unknown): void {
      const message = error instanceof Error ? error.message : String(error);
      writeLine(`[${options.name}][error] ${message}`);
    },
    close,
  };
}
