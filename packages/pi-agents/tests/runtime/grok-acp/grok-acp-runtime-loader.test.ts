// ABOUTME: Unit tests for the memoized Grok ACP runtime dynamic loader.
// ABOUTME: Covers concurrency, cache reuse, shared rejection, and retry-after-failure.

import { describe, expect, it, mock } from 'bun:test';
import {
  createGrokAcpRuntimeLoader,
  loadGrokAcpRuntime,
  type GrokAcpRuntimeModule,
} from '../../../src/runtime/grok-acp/grok-acp-runtime-loader.ts';

function makeRuntimeModule(): GrokAcpRuntimeModule {
  return {
    runSingleAgentGrokAcp: mock(async () => ({
      agent: 'x',
      agentSource: 'user',
      task: 't',
      exitCode: 0,
      status: 'completed',
      messages: [],
      stderr: '',
      usage: {
        turns: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
      },
    })) as unknown as GrokAcpRuntimeModule['runSingleAgentGrokAcp'],
    createGrokAcpInteractiveTransport: mock(async () => ({
      runtime: 'grok-acp',
    })) as unknown as GrokAcpRuntimeModule['createGrokAcpInteractiveTransport'],
  };
}

describe('createGrokAcpRuntimeLoader', () => {
  it('invokes the importer once for concurrent first loads', async () => {
    let resolveImport!: (mod: GrokAcpRuntimeModule) => void;
    const importPromise = new Promise<GrokAcpRuntimeModule>((resolve) => {
      resolveImport = resolve;
    });
    const importer = mock(() => importPromise);
    const load = createGrokAcpRuntimeLoader(importer);

    const p1 = load();
    const p2 = load();
    expect(importer).toHaveBeenCalledTimes(1);

    const mod = makeRuntimeModule();
    resolveImport(mod);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(mod);
    expect(b).toBe(mod);
  });

  it('reuses the resolved module on later calls', async () => {
    const mod = makeRuntimeModule();
    const importer = mock(async () => mod);
    const load = createGrokAcpRuntimeLoader(importer);

    const first = await load();
    const second = await load();
    expect(first).toBe(mod);
    expect(second).toBe(mod);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('shares a rejected import among concurrent callers', async () => {
    let rejectImport!: (err: Error) => void;
    const importPromise = new Promise<GrokAcpRuntimeModule>((_resolve, reject) => {
      rejectImport = reject;
    });
    const importer = mock(() => importPromise);
    const load = createGrokAcpRuntimeLoader(importer);

    const p1 = load();
    const p2 = load();
    rejectImport(new Error('chunk missing'));

    const [e1, e2] = await Promise.allSettled([p1, p2]);
    expect(e1.status).toBe('rejected');
    expect(e2.status).toBe('rejected');
    if (e1.status === 'rejected' && e2.status === 'rejected') {
      expect(e1.reason).toBe(e2.reason);
      expect(String(e1.reason.message)).toContain('Grok ACP runtime failed to load: chunk missing');
    }
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('retries after a rejected import', async () => {
    const mod = makeRuntimeModule();
    let calls = 0;
    const importer = mock(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return mod;
    });
    const load = createGrokAcpRuntimeLoader(importer);

    await expect(load()).rejects.toThrow('Grok ACP runtime failed to load: transient');
    const recovered = await load();
    expect(recovered).toBe(mod);
    expect(importer).toHaveBeenCalledTimes(2);
  });
});

describe('loadGrokAcpRuntime production façade', () => {
  it('exposes runSingleAgentGrokAcp and createGrokAcpInteractiveTransport', async () => {
    const runtime = await loadGrokAcpRuntime();
    expect(typeof runtime.runSingleAgentGrokAcp).toBe('function');
    expect(typeof runtime.createGrokAcpInteractiveTransport).toBe('function');
  });
});
