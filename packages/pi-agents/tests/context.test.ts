// ABOUTME: Tests for prepareAgentContext — fresh passthrough and fork failure modes.
// ABOUTME: Uses a fake ExtensionContext-like shim so we don't need a real persisted session.

import { describe, expect, it } from 'bun:test';
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
