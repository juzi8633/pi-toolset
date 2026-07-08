// ABOUTME: Focused tests for the shared logger factory behavior.
// ABOUTME: Covers errorMessage formatting, debug gating, and file-streamed output.

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createLogger, errorMessage } from '../src/index.ts';

let tmpDir: string;

function freshTmpDir(): string {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'pi-log-'));
  return tmpDir;
}

async function readUntil(
  file: string,
  needle: string,
  attempts = 25,
  delayMs = 10
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    try {
      const content = readFileSync(file, 'utf8');
      if (content.includes(needle)) return content;
    } catch {
      // file or content may not be flushed yet
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return readFileSync(file, 'utf8');
}

describe('errorMessage', () => {
  it('returns Error.message for Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });
});

describe('createLogger', () => {
  it('writes a debug line when debug level is enabled', async () => {
    const logFile = path.join(freshTmpDir(), 'debug.log');
    let logger: ReturnType<typeof createLogger> | undefined;
    try {
      logger = createLogger({
        name: 'test-logger',
        envPrefix: 'TEST_LOGGER',
        defaultLogFile: logFile,
        env: { TEST_LOGGER_LOG_LEVEL: 'debug', TEST_LOGGER_LOG_FILE: logFile },
      });
      logger.debug('hello');
      const content = await readUntil(logFile, '[test-logger][debug] hello');
      expect(content).toContain('[test-logger][debug] hello');
    } finally {
      await logger?.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('suppresses debug output at the default error level but still writes errors', async () => {
    const logFile = path.join(freshTmpDir(), 'error.log');
    let logger: ReturnType<typeof createLogger> | undefined;
    try {
      logger = createLogger({
        name: 'test-logger',
        envPrefix: 'TEST_LOGGER',
        defaultLogFile: logFile,
        env: { TEST_LOGGER_LOG_FILE: logFile },
      });
      logger.debug('should-not-appear');
      logger.error(new Error('boom'));
      const content = await readUntil(logFile, '[test-logger][error] boom');
      expect(content).toContain('[test-logger][error] boom');
      expect(content).not.toContain('should-not-appear');
    } finally {
      await logger?.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('treats any non-debug LOG_LEVEL as the error level', async () => {
    const logFile = path.join(freshTmpDir(), 'warn.log');
    let logger: ReturnType<typeof createLogger> | undefined;
    try {
      logger = createLogger({
        name: 'test-logger',
        envPrefix: 'TEST_LOGGER',
        defaultLogFile: logFile,
        env: { TEST_LOGGER_LOG_LEVEL: 'warn', TEST_LOGGER_LOG_FILE: logFile },
      });
      logger.debug('should-not-appear');
      logger.error(new Error('boom'));
      const content = await readUntil(logFile, '[test-logger][error] boom');
      expect(content).toContain('[test-logger][error] boom');
      expect(content).not.toContain('should-not-appear');
    } finally {
      await logger?.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to defaultLogFile when the env override is blank', async () => {
    const logFile = path.join(freshTmpDir(), 'default.log');
    let logger: ReturnType<typeof createLogger> | undefined;
    try {
      logger = createLogger({
        name: 'test-logger',
        envPrefix: 'TEST_LOGGER',
        defaultLogFile: logFile,
        env: { TEST_LOGGER_LOG_LEVEL: 'debug', TEST_LOGGER_LOG_FILE: '   ' },
      });
      logger.debug('fallback');
      const content = await readUntil(logFile, '[test-logger][debug] fallback');
      expect(content).toContain('[test-logger][debug] fallback');
    } finally {
      await logger?.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('silently disables logging when the log directory cannot be created', async () => {
    // A regular file at `blocker` makes mkdir of dirname(logFile) fail, so the
    // stream is never created and logging must degrade to a no-op.
    const blocker = path.join(freshTmpDir(), 'blocker');
    writeFileSync(blocker, '');
    const logFile = path.join(blocker, 'sub.log');
    let logger: ReturnType<typeof createLogger> | undefined;
    try {
      logger = createLogger({
        name: 'test-logger',
        envPrefix: 'TEST_LOGGER',
        defaultLogFile: logFile,
        env: { TEST_LOGGER_LOG_LEVEL: 'debug', TEST_LOGGER_LOG_FILE: logFile },
      });
      expect(() => logger!.debug('nope')).not.toThrow();
      expect(() => logger!.error(new Error('nope'))).not.toThrow();
      // No file is ever materialized when the stream could not be opened.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(logFile)).toBe(false);
    } finally {
      await logger?.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
