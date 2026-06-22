// ABOUTME: Tests for multi-server file routing, lifecycle fan-out, and manual server enablement.
// ABOUTME: Uses fake LSPServerInstance objects and a temp config dir so no real LSP process is spawned.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as diagnostics from '../src/diagnostics.ts';
import { createLSPServerManager, type LSPServerInstanceFactory } from '../src/manager.ts';
import type { LSPServerInstance } from '../src/instance.ts';
import type { LspServerState, ScopedLspServerConfig } from '../src/types.ts';

interface FakeInstance extends LSPServerInstance {
  notifications: { method: string; params: unknown }[];
  requests: { method: string; params: unknown }[];
  requestHandlers: Map<string, (params: unknown) => unknown | Promise<unknown>>;
  notificationHandlers: Map<string, (params: unknown) => void>;
  requestResponses: Map<string, (params: unknown) => unknown | Promise<unknown>>;
  setCapabilities(value: LSPServerInstance['capabilities']): void;
}

function fakeInstance(
  name: string,
  config: ScopedLspServerConfig,
  onStateChange?: () => void
): FakeInstance {
  const notifications: { method: string; params: unknown }[] = [];
  const requests: { method: string; params: unknown }[] = [];
  const requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  const notificationHandlers = new Map<string, (params: unknown) => void>();
  const requestResponses = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  let state: LspServerState = 'stopped';
  let capabilities: LSPServerInstance['capabilities'] = undefined;
  const setState = (next: LspServerState): void => {
    if (state === next) return;
    state = next;
    onStateChange?.();
  };

  return {
    name,
    config,
    notifications,
    requests,
    requestHandlers,
    notificationHandlers,
    requestResponses,
    get state() {
      return state;
    },
    startTime: undefined,
    lastError: undefined,
    restartCount: 0,
    get capabilities() {
      return capabilities;
    },
    setCapabilities(value) {
      capabilities = value;
    },
    async start() {
      setState('running');
    },
    async stop() {
      setState('stopped');
    },
    async restart() {
      setState('running');
    },
    isHealthy: () => state === 'running',
    async sendRequest(method, params) {
      requests.push({ method, params });
      const responder = requestResponses.get(method);
      if (responder) {
        return (await responder(params)) as never;
      }
      return undefined as never;
    },
    async sendNotification(method, params) {
      notifications.push({ method, params });
    },
    onNotification(method, handler) {
      notificationHandlers.set(method, handler);
    },
    onRequest(method, handler) {
      requestHandlers.set(method, handler as (params: unknown) => unknown | Promise<unknown>);
    },
  };
}

let tmpRoot: string;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-lsp-mgr-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
});

async function buildManager(configs: Record<string, ScopedLspServerConfig>): Promise<{
  manager: ReturnType<typeof createLSPServerManager>;
  instances: Map<string, FakeInstance>;
  cwdDir: string;
}> {
  const caseDir = mkdtempSync(path.join(tmpRoot, 'case-'));
  const cwdDir = path.join(caseDir, 'cwd');
  const agentDir = path.join(caseDir, 'agent');
  mkdirSync(cwdDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const projectConfigDir = path.join(cwdDir, '.pi', '@balaenis', 'pi-lsp');
  mkdirSync(projectConfigDir, { recursive: true });
  writeFileSync(path.join(projectConfigDir, 'config.json'), JSON.stringify({ servers: configs }));

  const instances = new Map<string, FakeInstance>();
  const factory: LSPServerInstanceFactory = (name, config, onStateChange) => {
    const inst = fakeInstance(name, config, onStateChange);
    instances.set(name, inst);
    return inst;
  };

  process.env.PATH = '';
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const manager = createLSPServerManager({ instanceFactory: factory });
  await manager.initialize(cwdDir);
  return { manager, instances, cwdDir };
}

function tsPrimary(): ScopedLspServerConfig {
  return {
    command: '/abs/path/typescript-language-server',
    extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact' },
    role: 'primary',
    startupMode: 'auto',
  };
}

function eslintCompanion(): ScopedLspServerConfig {
  return {
    command: '/abs/path/eslint-lsp',
    extensionToLanguage: { '.ts': 'typescript', '.js': 'javascript' },
    role: 'companion',
    startupMode: 'auto',
  };
}

function tailwindManual(): ScopedLspServerConfig {
  return {
    command: '/abs/path/tailwindcss-language-server',
    extensionToLanguage: { '.ts': 'typescript' },
    role: 'companion',
    startupMode: 'manual',
  };
}

describe('manager: configured vs active routing', () => {
  it('keeps inactive manual servers configured but excludes them from active routing', async () => {
    const { manager } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanion(),
      tailwindcss: tailwindManual(),
    });

    const configured = manager
      .getConfiguredServersForFile('/tmp/foo.ts')
      .map((s) => s.name)
      .sort();
    const active = manager
      .getServersForFile('/tmp/foo.ts')
      .map((s) => s.name)
      .sort();

    expect(configured).toEqual(['eslint', 'tailwindcss', 'typescript']);
    expect(active).toEqual(['eslint', 'typescript']);
  });

  it('returns the primary server even when a companion is listed first', async () => {
    const { manager } = await buildManager({
      eslint: eslintCompanion(),
      typescript: tsPrimary(),
    });
    expect(manager.getPrimaryServerForFile('/tmp/foo.ts')?.name).toBe('typescript');
    expect(manager.getServerForFile('/tmp/foo.ts')?.name).toBe('typescript');
  });

  it('returns undefined for primary when only companion servers cover the file', async () => {
    const { manager } = await buildManager({
      eslint: eslintCompanion(),
    });
    expect(manager.getServersForFile('/tmp/foo.ts').map((s) => s.name)).toEqual(['eslint']);
    expect(manager.getPrimaryServerForFile('/tmp/foo.ts')).toBeUndefined();
    expect(manager.getServerForFile('/tmp/foo.ts')).toBeUndefined();
  });

  it('admits a manual server into routing only after markManualServerActive', async () => {
    const { manager } = await buildManager({
      typescript: tsPrimary(),
      tailwindcss: tailwindManual(),
    });
    expect(manager.getServersForFile('/tmp/foo.ts').map((s) => s.name)).toEqual(['typescript']);

    manager.markManualServerActive('tailwindcss');
    expect(
      manager
        .getServersForFile('/tmp/foo.ts')
        .map((s) => s.name)
        .sort()
    ).toEqual(['tailwindcss', 'typescript']);

    manager.markManualServerInactive('tailwindcss');
    expect(manager.getServersForFile('/tmp/foo.ts').map((s) => s.name)).toEqual(['typescript']);
  });
});

describe('manager: lifecycle fan-out', () => {
  it('opens a .ts file on both the primary and the active companion', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanion(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'export const x = 1;');

    await manager.openFile(filePath, 'export const x = 1;');

    expect(instances.get('typescript')!.notifications.map((n) => n.method)).toEqual([
      'textDocument/didOpen',
    ]);
    expect(instances.get('eslint')!.notifications.map((n) => n.method)).toEqual([
      'textDocument/didOpen',
    ]);
  });

  it('inactive manual servers receive no lifecycle notifications', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      tailwindcss: tailwindManual(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'v1');

    await manager.openFile(filePath, 'v1');
    await manager.changeFile(filePath, 'v2');
    await manager.saveFile(filePath);

    expect(instances.get('tailwindcss')!.notifications).toEqual([]);
    expect(instances.get('typescript')!.notifications.length).toBeGreaterThan(0);
  });

  it('fans didChange and didSave to every active server after open', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanion(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'v1');

    await manager.openFile(filePath, 'v1');
    await manager.changeFile(filePath, 'v2');
    await manager.saveFile(filePath);

    for (const name of ['typescript', 'eslint']) {
      const methods = instances.get(name)!.notifications.map((n) => n.method);
      expect(methods).toContain('textDocument/didOpen');
      expect(methods).toContain('textDocument/didChange');
      expect(methods).toContain('textDocument/didSave');
    }
  });

  it('closeFile sends didClose to every server that has the file open', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanion(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'v1');

    await manager.openFile(filePath, 'v1');
    await manager.closeFile(filePath);

    for (const name of ['typescript', 'eslint']) {
      const methods = instances.get(name)!.notifications.map((n) => n.method);
      expect(methods).toContain('textDocument/didClose');
    }

    const fileUri = pathToFileURL(path.resolve(filePath)).href;
    expect(manager.isFileOpenInServer(fileUri, 'typescript')).toBe(false);
    expect(manager.isFileOpenInServer(fileUri, 'eslint')).toBe(false);
  });

  it('does not duplicate didOpen across repeated openFile calls', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanion(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'v1');

    await manager.openFile(filePath, 'v1');
    await manager.openFile(filePath, 'v1');

    for (const name of ['typescript', 'eslint']) {
      const opens = instances
        .get(name)!
        .notifications.filter((n) => n.method === 'textDocument/didOpen');
      expect(opens.length).toBe(1);
    }
  });

  it('clears open-file tracking when a server stops, so the next start re-sends didOpen', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'v1');

    await manager.openFile(filePath, 'v1');
    const fileUri = pathToFileURL(path.resolve(filePath)).href;
    expect(manager.isFileOpenInServer(fileUri, 'typescript')).toBe(true);

    // Stop the server (e.g. via /lsp start picker). The state-change listener
    // should clear the stale tracking entry.
    const ts = instances.get('typescript')!;
    await ts.stop();
    expect(manager.isFileOpenInServer(fileUri, 'typescript')).toBe(false);

    // Re-opening should produce a fresh didOpen rather than being skipped.
    await manager.openFile(filePath, 'v1');
    const opens = ts.notifications.filter((n) => n.method === 'textDocument/didOpen');
    expect(opens.length).toBe(2);
  });
});

describe('manager: primary-only request routing', () => {
  it('sendRequest targets the active primary server only', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanion(),
      tailwindcss: tailwindManual(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'v1');

    await manager.openFile(filePath, 'v1');
    await manager.sendRequest(filePath, 'textDocument/definition', {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: { line: 0, character: 0 },
    });

    expect(instances.get('typescript')!.requests.map((r) => r.method)).toEqual([
      'textDocument/definition',
    ]);
    expect(instances.get('eslint')!.requests).toEqual([]);
    expect(instances.get('tailwindcss')!.requests).toEqual([]);
  });

  it('still opens active companions before primary-only requests', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanion(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'v1');

    // The tool flow calls openFile() before sendRequest(); replicate that here.
    await manager.openFile(filePath, 'v1');
    await manager.sendRequest(filePath, 'textDocument/hover', {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: { line: 0, character: 0 },
    });

    expect(instances.get('eslint')!.notifications.map((n) => n.method)).toContain(
      'textDocument/didOpen'
    );
    expect(instances.get('eslint')!.requests).toEqual([]);
  });
});

function tsPrimaryWithSettings(): ScopedLspServerConfig {
  return { ...tsPrimary() };
}

function eslintCompanionWithSettings(): ScopedLspServerConfig {
  return {
    ...eslintCompanion(),
    settings: { validate: 'on', packageManager: 'npm' },
  };
}

describe('manager: workspace/configuration handler', () => {
  it('returns the configured settings object merged with a workspaceFolder', async () => {
    const { instances, cwdDir } = await buildManager({
      eslint: eslintCompanionWithSettings(),
    });
    const eslint = instances.get('eslint')!;
    const handler = eslint.requestHandlers.get('workspace/configuration');
    expect(handler).toBeDefined();
    const result = (await handler!({ items: [{ section: '' }] })) as Array<Record<string, unknown>>;
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    const entry = result[0]!;
    expect(entry.validate).toBe('on');
    expect(entry.packageManager).toBe('npm');
    const workspaceFolder = entry.workspaceFolder as { uri: string; name: string };
    expect(workspaceFolder).toBeDefined();
    expect(workspaceFolder.uri).toBe(pathToFileURL(cwdDir).href);
    expect(workspaceFolder.name).toBe(path.basename(cwdDir));
  });

  it('returns [null] when the server has no configured settings', async () => {
    const { instances } = await buildManager({
      typescript: tsPrimaryWithSettings(),
    });
    const ts = instances.get('typescript')!;
    const handler = ts.requestHandlers.get('workspace/configuration');
    expect(handler).toBeDefined();
    const result = await handler!({ items: [{ section: 'typescript' }] });
    expect(result).toEqual([null]);
  });
});

describe('manager: pull diagnostics', () => {
  it('requests textDocument/diagnostic from pull-capable companions after syncFileChange', async () => {
    const diag = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 15 } },
      message: 'Unexpected console statement.',
      source: 'eslint',
      code: 'no-console',
    };

    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanionWithSettings(),
    });

    // Give ESLint pull-diagnostic capability
    const eslint = instances.get('eslint')!;
    const ts = instances.get('typescript')!;
    eslint.setCapabilities({
      diagnosticProvider: {
        identifier: 'eslint',
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    });

    // Configure the textDocument/diagnostic response on ESLint
    eslint.requestResponses.set('textDocument/diagnostic', () => ({
      kind: 'full',
      items: [diag],
    }));

    const filePath = path.join(cwdDir, 'src', 'app.ts');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'console.log("hi");');

    await manager.syncFileChange(filePath);

    // ESLint should have received a textDocument/diagnostic request
    const eslintRequests = eslint.requests;
    const diagRequest = eslintRequests.find((r) => r.method === 'textDocument/diagnostic');
    expect(diagRequest).toBeDefined();
    const params = diagRequest!.params as { textDocument: { uri: string }; identifier?: string };
    expect(params.textDocument.uri).toContain('src/app.ts');
    expect(params.identifier).toBe('eslint');

    // TypeScript should NOT have received a textDocument/diagnostic request
    const tsRequests = ts.requests;
    expect(tsRequests.find((r) => r.method === 'textDocument/diagnostic')).toBeUndefined();

    // Diagnostics should be drained with the ESLint message
    const blocked = diagnostics.drain(cwdDir);
    expect(blocked).not.toBeNull();
    expect(blocked).toContain('Unexpected console statement.');
    expect(blocked).toContain('[no-console]');
  });

  it('tolerates pull diagnostic request failures without throwing', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      eslint: eslintCompanionWithSettings(),
    });

    const eslint = instances.get('eslint')!;
    eslint.setCapabilities({
      diagnosticProvider: {
        identifier: 'eslint',
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    });
    eslint.requestResponses.set('textDocument/diagnostic', () => {
      throw new Error('diagnostic pull failed');
    });

    const filePath = path.join(cwdDir, 'src', 'app.ts');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'console.log("hi");');

    // Should not throw — failure is logged and swallowed
    await expect(manager.syncFileChange(filePath)).resolves.toBeUndefined();

    // Lifecycle notifications should still have been sent
    const notifications = eslint.notifications;
    expect(notifications.some((n) => n.method === 'textDocument/didOpen')).toBe(true);

    // No diagnostics from the failed pull should appear
    const blocked = diagnostics.drain(cwdDir);
    expect(blocked).toBeNull();
  });

  it('clears prior pending diagnostics when pull returns empty items', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      eslint: eslintCompanionWithSettings(),
    });

    const eslint = instances.get('eslint')!;
    eslint.setCapabilities({
      diagnosticProvider: {
        identifier: 'eslint',
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    });

    const filePath = path.join(cwdDir, 'src', 'app.ts');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'bad code');

    // Register an old diagnostic for this server+URI
    eslint.requestResponses.set('textDocument/diagnostic', () => ({
      kind: 'full',
      items: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
          message: 'old error',
          source: 'eslint',
        },
      ],
    }));
    await manager.syncFileChange(filePath);

    // Now make the same pull return empty items
    eslint.requestResponses.set('textDocument/diagnostic', () => ({
      kind: 'full',
      items: [],
    }));
    await manager.syncFileChange(filePath);

    const blocked = diagnostics.drain(cwdDir);
    expect(blocked).toBeNull();
  });

  it('also pulls diagnostics after openFile', async () => {
    const diag = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      message: 'Unexpected console statement.',
      source: 'eslint',
      code: 'no-console',
    };

    const { manager, instances, cwdDir } = await buildManager({
      eslint: eslintCompanionWithSettings(),
    });

    const eslint = instances.get('eslint')!;
    eslint.setCapabilities({
      diagnosticProvider: {
        identifier: 'eslint',
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    });
    eslint.requestResponses.set('textDocument/diagnostic', () => ({
      kind: 'full',
      items: [diag],
    }));

    const filePath = path.join(cwdDir, 'src', 'app.ts');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'console.log("hi");');

    await manager.openFile(filePath, 'console.log("hi");');

    const diagRequest = eslint.requests.find((r) => r.method === 'textDocument/diagnostic');
    expect(diagRequest).toBeDefined();

    const blocked = diagnostics.drain(cwdDir);
    expect(blocked).toContain('Unexpected console statement.');
  });

  it('preserves previously registered diagnostics when the server returns kind:unchanged', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      eslint: eslintCompanionWithSettings(),
    });

    const eslint = instances.get('eslint')!;
    eslint.setCapabilities({
      diagnosticProvider: {
        identifier: 'eslint',
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    });

    const filePath = path.join(cwdDir, 'src', 'app.ts');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'bad');

    // First pull: full report with one diagnostic. Drain so the registry's
    // delivered-tracking is updated and pending is empty.
    eslint.requestResponses.set('textDocument/diagnostic', () => ({
      kind: 'full',
      items: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          message: 'first error',
          source: 'eslint',
        },
      ],
    }));
    await manager.syncFileChange(filePath);
    const firstDrain = diagnostics.drain(cwdDir);
    expect(firstDrain).toContain('first error');

    // Second pull: server reports kind:unchanged (no previousResultId support).
    eslint.requestResponses.set('textDocument/diagnostic', () => ({
      kind: 'unchanged',
      resultId: 'r1',
    }));
    await manager.syncFileChange(filePath);

    // No new pending entries are introduced and no error is thrown. Nothing
    // new to deliver, so a follow-up drain returns null.
    const secondDrain = diagnostics.drain(cwdDir);
    expect(secondDrain).toBeNull();
  });

  it('does not block syncFileChange when a pull diagnostic request hangs', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      eslint: eslintCompanionWithSettings(),
    });

    const eslint = instances.get('eslint')!;
    eslint.setCapabilities({
      diagnosticProvider: {
        identifier: 'eslint',
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    });
    // Never resolves — simulates a hung lint server.
    eslint.requestResponses.set('textDocument/diagnostic', () => new Promise<never>(() => {}));

    const filePath = path.join(cwdDir, 'src', 'app.ts');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'console.log("hi");');

    const start = Date.now();
    await manager.syncFileChange(filePath);
    const elapsed = Date.now() - start;

    // The 2s timeout bounds the wait; allow generous slack for slow CI.
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);
});
