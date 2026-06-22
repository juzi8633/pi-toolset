// ABOUTME: Tests that LSPServerInstance fires onStateChange on every transition.
// ABOUTME: Uses an injectable fake LSP client so no real child process is needed.

import { describe, expect, it } from 'bun:test';
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from 'vscode-languageserver-protocol';
import type { LSPClient } from '../src/client.ts';
import { createLSPServerInstance, type LSPClientFactory } from '../src/instance.ts';
import type { LspServerState, ScopedLspServerConfig } from '../src/types.ts';

function baseConfig(overrides: Partial<ScopedLspServerConfig> = {}): ScopedLspServerConfig {
  return {
    command: 'fake-lsp',
    args: ['--stdio'],
    extensionToLanguage: { '.ts': 'typescript' },
    workspaceFolder: process.cwd(),
    startupTimeout: 1000,
    maxRestarts: 3,
    ...overrides,
  };
}

type Outcome = 'success' | Error;

function makeFactory(
  outcomes: Outcome[],
  options: { serverCapabilities?: ServerCapabilities } = {}
): {
  factory: LSPClientFactory;
  triggerCrash(error: Error): void;
  initParams: InitializeParams[];
} {
  let initialized = false;
  let crashHandler: ((error: Error) => void) | undefined;
  const initParams: InitializeParams[] = [];
  const serverCapabilities = options.serverCapabilities ?? {};

  const factory: LSPClientFactory = (_name, onCrash) => {
    crashHandler = onCrash;
    const client: LSPClient = {
      get capabilities() {
        return initialized ? serverCapabilities : undefined;
      },
      get isInitialized() {
        return initialized;
      },
      async start() {},
      async initialize(params: InitializeParams): Promise<InitializeResult> {
        initParams.push(params);
        const outcome = outcomes.shift() ?? 'success';
        if (outcome instanceof Error) {
          throw outcome;
        }
        initialized = true;
        return { capabilities: serverCapabilities };
      },
      async sendRequest() {
        return undefined as never;
      },
      async sendNotification() {},
      onNotification() {},
      onRequest() {},
      async stop() {
        initialized = false;
      },
    };
    return client;
  };

  return {
    factory,
    triggerCrash(error: Error) {
      if (!crashHandler) throw new Error('no crash handler captured');
      crashHandler(error);
    },
    initParams,
  };
}

describe('LSPServerInstance onStateChange', () => {
  it('fires for the starting → running success path', async () => {
    const harness = makeFactory(['success']);
    const transitions: LspServerState[] = [];
    const server = createLSPServerInstance('typescript', baseConfig(), harness.factory, (state) =>
      transitions.push(state)
    );

    await server.start();
    expect(transitions).toEqual(['starting', 'running']);
  });

  it('fires for the starting → error startup-failure path', async () => {
    const harness = makeFactory([new Error('connection closed before initialize response')]);
    const transitions: LspServerState[] = [];
    const server = createLSPServerInstance('typescript', baseConfig(), harness.factory, (state) =>
      transitions.push(state)
    );

    await expect(server.start()).rejects.toThrow();
    expect(transitions).toEqual(['starting', 'error']);
  });

  it('fires running → stopping → stopped on stop()', async () => {
    const harness = makeFactory(['success']);
    const transitions: LspServerState[] = [];
    const server = createLSPServerInstance('typescript', baseConfig(), harness.factory, (state) =>
      transitions.push(state)
    );

    await server.start();
    await server.stop();
    expect(transitions).toEqual(['starting', 'running', 'stopping', 'stopped']);
  });

  it('fires running → error when the client emits an unexpected crash', async () => {
    const harness = makeFactory(['success']);
    const transitions: LspServerState[] = [];
    const server = createLSPServerInstance(
      'typescript',
      baseConfig({ restartOnCrash: false }),
      harness.factory,
      (state) => transitions.push(state)
    );

    await server.start();
    expect(transitions).toEqual(['starting', 'running']);

    harness.triggerCrash(new Error('child exited unexpectedly'));
    expect(transitions).toEqual(['starting', 'running', 'error']);
    expect(server.state).toBe('error');
  });

  it('does not refire when the same state is set twice', async () => {
    const harness = makeFactory(['success']);
    const transitions: LspServerState[] = [];
    const server = createLSPServerInstance('typescript', baseConfig(), harness.factory, (state) =>
      transitions.push(state)
    );

    await server.start();
    // Second start() call returns immediately; state stays running.
    await server.start();
    expect(transitions).toEqual(['starting', 'running']);
  });

  it('advertises workspace/configuration and pull diagnostic client capabilities', async () => {
    const harness = makeFactory(['success']);
    const server = createLSPServerInstance('typescript', baseConfig(), harness.factory);

    await server.start();
    expect(harness.initParams.length).toBe(1);
    const params = harness.initParams[0]!;
    expect(params.capabilities.workspace?.configuration).toBe(true);
    const diagnostic = params.capabilities.textDocument?.diagnostic;
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.dynamicRegistration).toBe(false);
    expect((diagnostic as { relatedDocumentSupport?: boolean }).relatedDocumentSupport).toBe(false);
  });

  it('exposes server-reported diagnosticProvider capability after start', async () => {
    const harness = makeFactory(['success'], {
      serverCapabilities: {
        diagnosticProvider: {
          identifier: 'eslint',
          interFileDependencies: false,
          workspaceDiagnostics: false,
        },
      },
    });
    const server = createLSPServerInstance('eslint', baseConfig(), harness.factory);

    await server.start();
    const provider = server.capabilities?.diagnosticProvider;
    expect(provider).toBeDefined();
    expect(typeof provider === 'object' && provider && 'identifier' in provider).toBe(true);
  });
});
