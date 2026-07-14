// ABOUTME: Tests for prepareAgentContext — fresh passthrough and fork failure modes.
// ABOUTME: Uses a fake ExtensionContext-like shim so we don't need a real persisted session.

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from '../src/agents.ts';
import { prepareAgentContext } from '../src/context.ts';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'forky',
    description: 'fork test',
    systemPrompt: '',
    source: 'builtin',
    filePath: '/tmp/forky.md',
    ...overrides,
  };
}

function makeCtx(sessionManager: object) {
  return { sessionManager } as unknown as Parameters<typeof prepareAgentContext>[1];
}

describe('prepareAgentContext', () => {
  it('returns fresh mode with no session file when defaultContext is fresh or unset', () => {
    const ctx = makeCtx({});
    const result = prepareAgentContext(makeAgent(), ctx);
    expect(result.mode).toBe('fresh');
    expect(result.sessionFile).toBeUndefined();
  });

  it('throws when defaultContext is fork but parent session is not persisted', () => {
    const ctx = makeCtx({
      getSessionFile: () => undefined,
      getLeafId: () => 'leaf-1',
    });
    expect(() => prepareAgentContext(makeAgent({ defaultContext: 'fork' }), ctx)).toThrow(
      'Cannot fork parent context: parent session is not persisted'
    );
  });

  it('throws when defaultContext is fork but parent session file is missing on disk', () => {
    const ctx = makeCtx({
      getSessionFile: () => '/tmp/does-not-exist-pi-agents.jsonl',
      getLeafId: () => 'leaf-1',
    });
    expect(() => prepareAgentContext(makeAgent({ defaultContext: 'fork' }), ctx)).toThrow(
      /parent session file does not exist/
    );
  });

  it('returns mode=fork with a populated branched session file on success', async () => {
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');

    const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-fork-'));
    const projectCwd = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-cwd-'));
    try {
      const parent = SessionManager.create(projectCwd, dir);
      const parentFile = parent.getSessionFile();
      expect(parentFile).toBeDefined();
      parent.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        timestamp: Date.now(),
      });
      parent.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        model: 'fake-model',
        provider: 'fake',
        api: 'fake-api',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      });
      const leafId = parent.getLeafId();
      expect(leafId).not.toBeNull();

      const ctx = makeCtx({
        getSessionFile: () => parentFile,
        getSessionDir: () => dir,
        getLeafId: () => leafId,
      });
      const result = prepareAgentContext(makeAgent({ defaultContext: 'fork' }), ctx);
      expect(result.mode).toBe('fork');
      expect(result.sessionFile).toBeDefined();
      expect(result.sessionFile).not.toBe(parentFile);
      expect(existsSync(result.sessionFile!)).toBe(true);
      await result.cleanup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });
});

describe('prepareAgentContext with run sessions dir', () => {
  it('creates a persisted fresh session beneath <runDir>/sessions', async () => {
    const runDir = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-run-'));
    const sessionsDir = path.join(runDir, 'sessions');
    const effectiveCwd = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-cwd-'));
    try {
      const ctx = makeCtx({});
      const result = prepareAgentContext(makeAgent(), ctx, {
        effectiveCwd,
        sessionsDir,
        runId: 'run-test',
        unitId: 'single',
      });
      expect(result.mode).toBe('fresh');
      expect(result.sessionFile).toBeDefined();
      // The session file must live beneath the run sessions dir.
      expect(result.sessionFile!.startsWith(sessionsDir + path.sep)).toBe(true);
      // The file is written lazily by Pi (flushed on first assistant message).
      // Force persistence by appending a user+assistant pair via open().
      const sm = SessionManager.open(result.sessionFile!, sessionsDir, effectiveCwd);
      sm.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: 'init' }],
        timestamp: Date.now(),
      });
      sm.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'fake',
        provider: 'fake',
        api: 'fake',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      });
      const header = SessionManager.open(result.sessionFile!).getHeader();
      expect(header?.cwd).toBe(effectiveCwd);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(effectiveCwd, { recursive: true, force: true });
    }
  });

  it('creates a fork session beneath <runDir>/sessions and verifies location', async () => {
    const runDir = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-run-'));
    const sessionsDir = path.join(runDir, 'sessions');
    const projectCwd = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-cwd-'));
    try {
      const parent = SessionManager.create(projectCwd);
      const parentFile = parent.getSessionFile()!;
      parent.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        timestamp: Date.now(),
      });
      parent.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        model: 'fake',
        provider: 'fake',
        api: 'fake',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      });
      const leafId = parent.getLeafId()!;

      const ctx = makeCtx({
        getSessionFile: () => parentFile,
        getSessionDir: () => path.dirname(parentFile),
        getLeafId: () => leafId,
      });
      const result = prepareAgentContext(makeAgent({ defaultContext: 'fork' }), ctx, {
        effectiveCwd: projectCwd,
        sessionsDir,
        runId: 'run-test',
        unitId: 'single',
      });
      expect(result.mode).toBe('fork');
      expect(result.sessionFile).toBeDefined();
      expect(existsSync(result.sessionFile!)).toBe(true);
      expect(result.sessionFile!.startsWith(sessionsDir + path.sep)).toBe(true);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });

  it('reuses the stored session file when provided (resume path)', async () => {
    const runDir = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-run-'));
    const sessionsDir = path.join(runDir, 'sessions');
    const projectCwd = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-cwd-'));
    try {
      // Create a prior session to resume from (append a message to force persistence).
      const { mkdirSync } = await import('node:fs');
      mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
      const prior = SessionManager.create(projectCwd, sessionsDir);
      prior.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: 'prior work' }],
        timestamp: Date.now(),
      });
      prior.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'fake',
        provider: 'fake',
        api: 'fake',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      });
      const storedFile = prior.getSessionFile()!;
      expect(existsSync(storedFile)).toBe(true);

      const ctx = makeCtx({});
      const result = prepareAgentContext(makeAgent(), ctx, {
        effectiveCwd: projectCwd,
        sessionsDir,
        storedSessionFile: storedFile,
      });
      expect(result.sessionFile).toBe(storedFile);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });

  it('throws when stored session file does not exist (resume path)', () => {
    const ctx = makeCtx({});
    expect(() =>
      prepareAgentContext(makeAgent(), ctx, { storedSessionFile: '/tmp/nonexistent.jsonl' })
    ).toThrow(/stored session file does not exist/);
  });
});
