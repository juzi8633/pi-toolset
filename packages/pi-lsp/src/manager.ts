// ABOUTME: Multi-server routing, file synchronization, and the global manager singleton.
// ABOUTME: Routes primary navigation to one server while fanning lifecycle out to all active candidates.

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  DocumentDiagnosticParams,
  DocumentDiagnosticReport,
  PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol';
import type { Diagnostic as LspDiagnostic } from 'vscode-languageserver-types';
import { getAllLspServers } from './config.ts';
import * as diagnostics from './diagnostics.ts';
import { createLSPServerInstance, type LSPServerInstance } from './instance.ts';
import { errorMessage, logError, logForDebugging } from './log.ts';
import type { LspServerState, ScopedLspServerConfig } from './types.ts';

/**
 * Factory for building LSPServerInstance objects. Tests inject a fake factory
 * so the manager can be exercised without spawning real child processes.
 */
export type LSPServerInstanceFactory = (
  name: string,
  config: ScopedLspServerConfig,
  onStateChange: () => void
) => LSPServerInstance;

const defaultInstanceFactory: LSPServerInstanceFactory = (name, config, onStateChange) =>
  createLSPServerInstance(name, config, undefined, () => onStateChange());

/**
 * Build the response value sent back to `workspace/configuration` requests.
 *
 * The LSP protocol expects an array with one entry per requested item. We
 * return the same resolved settings for every item so a server asking for
 * `eslint`, `eslint.format`, etc. receives the full configured object for
 * each section. Servers without configured `settings` receive `null` entries
 * — semantically equivalent to the previous "answer but don't configure"
 * behavior.
 */
function getWorkspaceConfigurationResponse(
  config: ScopedLspServerConfig,
  items: Array<{ section?: string }>
): unknown[] {
  const value = buildServerSettings(config);
  return items.map(() => value);
}

/**
 * Resolve the settings value handed to the server. When `settings` is omitted
 * we return `null` so the protocol shape stays the same as before. When
 * `settings` is an object we merge in a dynamic `workspaceFolder` (the format
 * `vscode-eslint-language-server` expects) unless the user already supplied
 * one. Non-object settings (e.g. boolean/number/string) are returned as-is.
 */
function buildServerSettings(config: ScopedLspServerConfig): unknown {
  const settings = config.settings;
  if (settings === undefined) return null;
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return settings;
  }
  const workspaceFolder = config.workspaceFolder ?? process.cwd();
  const obj = settings as Record<string, unknown>;
  if (obj.workspaceFolder !== undefined) {
    return { ...obj };
  }
  return {
    ...obj,
    workspaceFolder: {
      uri: pathToFileURL(workspaceFolder).href,
      name: path.basename(workspaceFolder),
    },
  };
}

/**
 * True when the server advertises `textDocument/diagnostic` (pull diagnostics)
 * support via its initialize result.
 */
function hasPullDiagnostics(server: LSPServerInstance): boolean {
  return server.capabilities?.diagnosticProvider !== undefined;
}

/**
 * Optional `identifier` value to forward in `DocumentDiagnosticParams`. Only
 * returned when the provider is an object (LSP options form) with a non-empty
 * string identifier; servers advertising the boolean form receive `undefined`.
 */
function getDiagnosticProviderIdentifier(server: LSPServerInstance): string | undefined {
  const provider = server.capabilities?.diagnosticProvider;
  if (!provider || typeof provider !== 'object') return undefined;
  const identifier = (provider as { identifier?: unknown }).identifier;
  return typeof identifier === 'string' && identifier.length > 0 ? identifier : undefined;
}

/**
 * Extract diagnostics from a full document diagnostic report. Returns
 * `undefined` for `kind: 'unchanged'` (we don't track previousResultId yet)
 * and any malformed report.
 */
function extractFullDiagnostics(
  report: DocumentDiagnosticReport | null | undefined
): LspDiagnostic[] | undefined {
  if (!report || typeof report !== 'object') return undefined;
  if ((report as { kind?: unknown }).kind !== 'full') return undefined;
  const items = (report as { items?: unknown }).items;
  if (!Array.isArray(items)) return undefined;
  return items as LspDiagnostic[];
}

/**
 * Maximum time we'll wait for a single pull diagnostic response. Pull
 * diagnostics are awaited inline by `openFile()` and `syncFileChange()`, both
 * of which sit on the tool flow's hot path; a slow or hung companion server
 * must not block edits or navigation requests. Picked to comfortably cover
 * normal ESLint pulls (typically <500ms) while still bounding the worst case.
 */
const PULL_DIAGNOSTICS_TIMEOUT_MS = 2000;

/**
 * Race `promise` against a timer. Resolves with the promise's value, or
 * rejects with a timeout error after `ms` milliseconds. The timer is always
 * cleared so a fast resolution doesn't leak it.
 */
async function raceWithTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * LSP Server Manager interface.
 * Manages multiple LSP server instances and routes requests based on file extensions.
 */
export type LSPServerManager = {
  /** Initialize the manager by loading all configured LSP servers, rooted at cwd */
  initialize(cwd: string): Promise<void>;
  /** Shutdown all running servers and clear state */
  shutdown(): Promise<void>;
  /** Get the active primary LSP server instance for a given file path */
  getServerForFile(filePath: string): LSPServerInstance | undefined;
  /** Get every configured server (including inactive manual) covering the file */
  getConfiguredServersForFile(filePath: string): LSPServerInstance[];
  /** Get every active server (auto + manually enabled) covering the file */
  getServersForFile(filePath: string): LSPServerInstance[];
  /** Get the active primary server covering the file, if any */
  getPrimaryServerForFile(filePath: string): LSPServerInstance | undefined;
  /** Ensure the active primary LSP server is started for the given file */
  ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>;
  /** Send a request to the active primary LSP server for the given file */
  sendRequest<T>(filePath: string, method: string, params: unknown): Promise<T | undefined>;
  /** Get all server instances */
  getAllServers(): Map<string, LSPServerInstance>;
  /** Aggregated live counts across all server instances. */
  getStateCounts(): { running: number; starting: number; error: number };
  /** Subscribe to any per-instance state change. Returns an unsubscribe. */
  onServersChanged(listener: () => void): () => void;
  /** Mark a manual server as enabled for this session. */
  markManualServerActive(serverName: string): void;
  /** Clear a manual server's session enablement (e.g. user stopped it). */
  markManualServerInactive(serverName: string): void;
  /** Whether the server is automatically active (startupMode !== 'manual'). */
  isServerAutoActive(server: LSPServerInstance): boolean;
  /** Whether a manual server has been enabled for this session. */
  isServerManuallyActive(server: LSPServerInstance): boolean;
  /** Whether the server currently participates in routing. */
  isServerActive(server: LSPServerInstance): boolean;
  /** Synchronize file open to LSP server (sends didOpen notification) */
  openFile(filePath: string, content: string): Promise<void>;
  /** Synchronize file change to LSP server (sends didChange notification) */
  changeFile(filePath: string, content: string): Promise<void>;
  /** Synchronize file save to LSP server (sends didSave notification) */
  saveFile(filePath: string): Promise<void>;
  /** Synchronize file close to LSP server (sends didClose notification) */
  closeFile(filePath: string): Promise<void>;
  /** Re-sync a file after an external edit: reads disk, sends didChange + didSave */
  syncFileChange(filePath: string): Promise<void>;
  /** Check whether the active primary server already has the file open */
  isFileOpen(filePath: string): boolean;
  /** Check whether a specific server already has the file URI open */
  isFileOpenInServer(fileUri: string, serverName: string): boolean;
};

/**
 * Creates an LSP server manager instance.
 *
 * Manages multiple LSP server instances and routes requests based on file extensions.
 * Uses factory function pattern with closures for state encapsulation (avoiding classes).
 */
export function createLSPServerManager(
  options: { instanceFactory?: LSPServerInstanceFactory } = {}
): LSPServerManager {
  const instanceFactory = options.instanceFactory ?? defaultInstanceFactory;

  // Private state managed via closures
  const servers: Map<string, LSPServerInstance> = new Map();
  const extensionMap: Map<string, string[]> = new Map();
  // URI → set of server names that have the file open via didOpen.
  const openedFiles: Map<string, Set<string>> = new Map();
  const manualEnabledServers: Set<string> = new Set();
  const stateChangeListeners: Set<() => void> = new Set();
  // Last observed state per server, used to detect transitions out of
  // 'running' so we can clear the server's open-file tracking when its child
  // process goes away (a restarted server has no prior open document state).
  const lastObservedState: Map<string, LspServerState> = new Map();

  function notifyServersChanged(): void {
    for (const listener of stateChangeListeners) {
      try {
        listener();
      } catch (error) {
        logError(new Error(`LSP statusLine listener threw: ${errorMessage(error)}`));
      }
    }
  }

  function isServerAutoActive(server: LSPServerInstance): boolean {
    return (server.config.startupMode ?? 'auto') !== 'manual';
  }

  function isServerManuallyActive(server: LSPServerInstance): boolean {
    return manualEnabledServers.has(server.name);
  }

  function isServerActive(server: LSPServerInstance): boolean {
    return isServerAutoActive(server) || isServerManuallyActive(server);
  }

  function markManualServerActive(serverName: string): void {
    const server = servers.get(serverName);
    if (!server) return;
    if (isServerAutoActive(server)) return;
    if (!manualEnabledServers.has(serverName)) {
      manualEnabledServers.add(serverName);
      notifyServersChanged();
    }
  }

  function markManualServerInactive(serverName: string): void {
    if (manualEnabledServers.delete(serverName)) {
      notifyServersChanged();
    }
  }

  /**
   * Initialize the manager by loading all configured LSP servers.
   * The cwd becomes each server's workspace folder.
   */
  async function initialize(cwd: string): Promise<void> {
    let serverConfigs: Record<string, ScopedLspServerConfig>;

    try {
      const result = await getAllLspServers(cwd);
      serverConfigs = result.servers;
      logForDebugging(
        `[LSP SERVER MANAGER] getAllLspServers returned ${Object.keys(serverConfigs).length} server(s)`
      );
    } catch (error) {
      const err = error as Error;
      logError(new Error(`Failed to load LSP server configuration: ${err.message}`));
      throw error;
    }

    // Build extension → server mapping
    for (const [serverName, rawConfig] of Object.entries(serverConfigs)) {
      try {
        // Validate config before using it
        if (!rawConfig.command) {
          throw new Error(`Server ${serverName} missing required 'command' field`);
        }
        if (
          !rawConfig.extensionToLanguage ||
          Object.keys(rawConfig.extensionToLanguage).length === 0
        ) {
          throw new Error(`Server ${serverName} missing required 'extensionToLanguage' field`);
        }

        // Root the server at the session's working directory
        const config: ScopedLspServerConfig = {
          ...rawConfig,
          workspaceFolder: rawConfig.workspaceFolder ?? cwd,
        };

        // Map file extensions to this server (derive from extensionToLanguage)
        const fileExtensions = Object.keys(config.extensionToLanguage);
        for (const ext of fileExtensions) {
          const normalized = ext.toLowerCase();
          if (!extensionMap.has(normalized)) {
            extensionMap.set(normalized, []);
          }
          extensionMap.get(normalized)?.push(serverName);
        }

        // Create server instance. The state-change callback both notifies
        // external listeners and clears per-server open-file tracking when
        // the server exits the 'running' state.
        const instance = instanceFactory(serverName, config, () => {
          const current = servers.get(serverName)?.state;
          const previous = lastObservedState.get(serverName);
          if (current) lastObservedState.set(serverName, current);
          if (
            previous === 'running' &&
            (current === 'stopped' || current === 'error' || current === 'stopping')
          ) {
            clearOpenedFilesForServer(serverName);
          }
          notifyServersChanged();
        });
        servers.set(serverName, instance);
        lastObservedState.set(serverName, instance.state);

        // Register handler for workspace/configuration requests from the server.
        // Returns the configured `settings` object (merged with a dynamic
        // workspaceFolder when settings is an object) so servers like
        // vscode-eslint-language-server can resolve their runtime configuration.
        // Servers without settings receive null, preserving the original
        // behavior of acknowledging the request without supplying config.
        instance.onRequest(
          'workspace/configuration',
          (params: { items: Array<{ section?: string }> }) => {
            const items = params.items ?? [];
            logForDebugging(
              `LSP: Received workspace/configuration request from ${serverName} (${items.length} item(s))`
            );
            return getWorkspaceConfigurationResponse(config, items);
          }
        );

        // Route passive diagnostics into the registry. Registered before start()
        // so the handler is queued and applied when the connection comes up.
        instance.onNotification('textDocument/publishDiagnostics', (params: unknown) => {
          try {
            const p = params as PublishDiagnosticsParams;
            if (!p || typeof p !== 'object' || !('uri' in p) || !('diagnostics' in p)) {
              logForDebugging(
                `LSP: ${serverName} sent invalid publishDiagnostics (missing uri/diagnostics)`
              );
              return;
            }
            diagnostics.register(serverName, p.uri, p.diagnostics ?? []);
          } catch (error) {
            // Isolate per-server failures so one bad publish can't break the loop.
            logError(
              new Error(
                `LSP: ${serverName} publishDiagnostics handler failed: ${errorMessage(error)}`
              )
            );
          }
        });
      } catch (error) {
        const err = error as Error;
        logError(new Error(`Failed to initialize LSP server ${serverName}: ${err.message}`));
        // Continue with other servers - don't fail entire initialization
      }
    }

    logForDebugging(`LSP manager initialized with ${servers.size} servers`);
  }

  /**
   * Shutdown all servers and clear state.
   * Only servers in 'running' or 'error' state are explicitly stopped.
   */
  async function shutdown(): Promise<void> {
    const toStop = Array.from(servers.entries()).filter(
      ([, s]) => s.state === 'running' || s.state === 'error'
    );

    const results = await Promise.allSettled(toStop.map(([, server]) => server.stop()));

    servers.clear();
    extensionMap.clear();
    openedFiles.clear();
    manualEnabledServers.clear();
    lastObservedState.clear();
    stateChangeListeners.clear();

    const errors = results
      .map((r, i) =>
        r.status === 'rejected' ? `${toStop[i]![0]}: ${errorMessage(r.reason)}` : null
      )
      .filter((e): e is string => e !== null);

    if (errors.length > 0) {
      const err = new Error(`Failed to stop ${errors.length} LSP server(s): ${errors.join('; ')}`);
      logError(err);
      throw err;
    }
  }

  /**
   * Return every configured server whose extensions cover the file, including
   * inactive manual servers.
   */
  function getConfiguredServersForFile(filePath: string): LSPServerInstance[] {
    const ext = path.extname(filePath).toLowerCase();
    const serverNames = extensionMap.get(ext);
    if (!serverNames || serverNames.length === 0) return [];
    const out: LSPServerInstance[] = [];
    for (const name of serverNames) {
      const server = servers.get(name);
      if (server) out.push(server);
    }
    return out;
  }

  /**
   * Return active servers (auto servers plus manually enabled servers) that
   * cover the file. Inactive manual servers are excluded.
   */
  function getServersForFile(filePath: string): LSPServerInstance[] {
    return getConfiguredServersForFile(filePath).filter((s) => isServerActive(s));
  }

  /**
   * Return the active primary server for a file.
   *
   * Returns the first active candidate carrying `role: 'primary'`. When all
   * active candidates explicitly have a role and none is `primary` (e.g. only
   * companion servers are active), returns `undefined` so navigation does not
   * accidentally fall through to a companion. The fallback to the first
   * candidate only applies for legacy candidates that lack a `role` entirely.
   */
  function getPrimaryServerForFile(filePath: string): LSPServerInstance | undefined {
    const candidates = getServersForFile(filePath);
    if (candidates.length === 0) return undefined;
    const primary = candidates.find((s) => (s.config.role ?? 'primary') === 'primary');
    if (primary) return primary;
    // All candidates have a non-primary role — do not route navigation here.
    if (candidates.every((s) => s.config.role !== undefined)) return undefined;
    // Legacy candidates without a role: preserve the historical first-wins behavior.
    return candidates[0];
  }

  /**
   * Backward-compatible alias: returns the active primary server for a file.
   * Multi-server callers should prefer the more specific getters above.
   */
  function getServerForFile(filePath: string): LSPServerInstance | undefined {
    return getPrimaryServerForFile(filePath);
  }

  /**
   * Ensure the appropriate LSP server is started for the given file.
   */
  async function ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined> {
    const server = getPrimaryServerForFile(filePath);
    if (!server) return undefined;

    if (server.state !== 'running') {
      try {
        await server.start();
      } catch (error) {
        const err = error as Error;
        logError(new Error(`Failed to start LSP server for file ${filePath}: ${err.message}`));
        throw error;
      }
    }

    return server;
  }

  /**
   * Send a request to the active primary LSP server for the file. Used for
   * navigation operations that should produce one authoritative result.
   */
  async function sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown
  ): Promise<T | undefined> {
    const server = await ensureServerStarted(filePath);
    if (!server) return undefined;

    try {
      return await server.sendRequest<T>(method, params);
    } catch (error) {
      const err = error as Error;
      logError(
        new Error(`LSP request failed for file ${filePath}, method '${method}': ${err.message}`)
      );
      throw error;
    }
  }

  function getAllServers(): Map<string, LSPServerInstance> {
    return servers;
  }

  function getStateCounts(): { running: number; starting: number; error: number } {
    let running = 0;
    let starting = 0;
    let error = 0;
    for (const server of servers.values()) {
      switch (server.state) {
        case 'running':
          running++;
          break;
        case 'starting':
          starting++;
          break;
        case 'error':
          error++;
          break;
        default:
          break;
      }
    }
    return { running, starting, error };
  }

  function onServersChanged(listener: () => void): () => void {
    stateChangeListeners.add(listener);
    return () => {
      stateChangeListeners.delete(listener);
    };
  }

  function addOpenedFile(fileUri: string, serverName: string): void {
    let set = openedFiles.get(fileUri);
    if (!set) {
      set = new Set();
      openedFiles.set(fileUri, set);
    }
    set.add(serverName);
  }

  function removeOpenedFile(fileUri: string, serverName: string): void {
    const set = openedFiles.get(fileUri);
    if (!set) return;
    set.delete(serverName);
    if (set.size === 0) openedFiles.delete(fileUri);
  }

  function isFileOpenInServer(fileUri: string, serverName: string): boolean {
    const set = openedFiles.get(fileUri);
    return set ? set.has(serverName) : false;
  }

  function clearOpenedFilesForServer(serverName: string): void {
    const emptied: string[] = [];
    for (const [uri, set] of openedFiles) {
      if (set.delete(serverName) && set.size === 0) emptied.push(uri);
    }
    for (const uri of emptied) openedFiles.delete(uri);
    if (emptied.length > 0 || servers.has(serverName)) {
      logForDebugging(`LSP: cleared open-file tracking for ${serverName}`);
    }
  }

  async function openOnServer(
    server: LSPServerInstance,
    filePath: string,
    content: string
  ): Promise<void> {
    if (server.state !== 'running') {
      try {
        await server.start();
      } catch (error) {
        logError(
          new Error(
            `Failed to start LSP server '${server.name}' for ${filePath}: ${errorMessage(error)}`
          )
        );
        return;
      }
    }

    const fileUri = pathToFileURL(path.resolve(filePath)).href;
    if (isFileOpenInServer(fileUri, server.name)) {
      logForDebugging(
        `LSP: ${server.name} already has ${filePath} open; skipping duplicate didOpen`
      );
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const languageId = server.config.extensionToLanguage[ext] || 'plaintext';

    try {
      await server.sendNotification('textDocument/didOpen', {
        textDocument: { uri: fileUri, languageId, version: 1, text: content },
      });
      addOpenedFile(fileUri, server.name);
      logForDebugging(
        `LSP: Sent didOpen for ${filePath} on ${server.name} (languageId: ${languageId})`
      );
    } catch (error) {
      logError(
        new Error(`Failed to sync file open ${filePath} on ${server.name}: ${errorMessage(error)}`)
      );
    }
  }

  async function openFile(filePath: string, content: string): Promise<void> {
    const candidates = getServersForFile(filePath);
    if (candidates.length === 0) return;
    await Promise.all(candidates.map((server) => openOnServer(server, filePath, content)));
    await pullDiagnosticsForFile(filePath);
  }

  async function changeFile(filePath: string, content: string): Promise<void> {
    const candidates = getServersForFile(filePath);
    if (candidates.length === 0) return;

    const fileUri = pathToFileURL(path.resolve(filePath)).href;

    await Promise.all(
      candidates.map(async (server) => {
        if (server.state !== 'running' || !isFileOpenInServer(fileUri, server.name)) {
          await openOnServer(server, filePath, content);
          return;
        }
        try {
          await server.sendNotification('textDocument/didChange', {
            textDocument: { uri: fileUri, version: 1 },
            contentChanges: [{ text: content }],
          });
          logForDebugging(`LSP: Sent didChange for ${filePath} on ${server.name}`);
        } catch (error) {
          logError(
            new Error(
              `Failed to sync file change ${filePath} on ${server.name}: ${errorMessage(error)}`
            )
          );
        }
      })
    );
  }

  /**
   * Save a file across active candidate servers (sends didSave notification).
   * Called after a file is written to disk to trigger diagnostics.
   */
  async function saveFile(filePath: string): Promise<void> {
    const candidates = getServersForFile(filePath);
    if (candidates.length === 0) return;

    const fileUri = pathToFileURL(path.resolve(filePath)).href;

    await Promise.all(
      candidates.map(async (server) => {
        if (server.state !== 'running') return;
        if (!isFileOpenInServer(fileUri, server.name)) return;
        try {
          await server.sendNotification('textDocument/didSave', {
            textDocument: { uri: fileUri },
          });
          logForDebugging(`LSP: Sent didSave for ${filePath} on ${server.name}`);
        } catch (error) {
          logError(
            new Error(
              `Failed to sync file save ${filePath} on ${server.name}: ${errorMessage(error)}`
            )
          );
        }
      })
    );
  }

  /**
   * Close a file across active candidate servers (sends didClose notification).
   */
  async function closeFile(filePath: string): Promise<void> {
    const candidates = getServersForFile(filePath);
    if (candidates.length === 0) return;

    const fileUri = pathToFileURL(path.resolve(filePath)).href;

    await Promise.all(
      candidates.map(async (server) => {
        if (server.state !== 'running') return;
        if (!isFileOpenInServer(fileUri, server.name)) return;
        try {
          await server.sendNotification('textDocument/didClose', {
            textDocument: { uri: fileUri },
          });
          removeOpenedFile(fileUri, server.name);
          logForDebugging(`LSP: Sent didClose for ${filePath} on ${server.name}`);
        } catch (error) {
          logError(
            new Error(
              `Failed to sync file close ${filePath} on ${server.name}: ${errorMessage(error)}`
            )
          );
        }
      })
    );
  }

  /**
   * Re-sync a file after an external edit (e.g. the agent's edit/write tool).
   *
   * Reads the current disk content and fans didChange + didSave out to every
   * active candidate so each one re-publishes diagnostics for the updated file.
   * Active candidates that have not seen the file yet are opened first.
   */
  async function syncFileChange(filePath: string): Promise<void> {
    const candidates = getServersForFile(filePath);
    if (candidates.length === 0) return;

    let content: string;
    try {
      content = await readFile(filePath, { encoding: 'utf-8' });
    } catch (error) {
      logForDebugging(`LSP: syncFileChange skipped ${filePath}: ${errorMessage(error)}`);
      return;
    }

    await changeFile(filePath, content);
    await saveFile(filePath);
    await pullDiagnosticsForFile(filePath);
  }

  async function pullDiagnosticsForFile(filePath: string): Promise<void> {
    const candidates = getServersForFile(filePath);
    if (candidates.length === 0) return;
    const fileUri = pathToFileURL(path.resolve(filePath)).href;

    await Promise.all(
      candidates.map(async (server) => {
        if (server.state !== 'running') return;
        if (!isFileOpenInServer(fileUri, server.name)) return;
        if (!hasPullDiagnostics(server)) return;

        const identifier = getDiagnosticProviderIdentifier(server);
        const params: DocumentDiagnosticParams = {
          textDocument: { uri: fileUri },
          ...(identifier ? { identifier } : {}),
        };

        try {
          const report = await raceWithTimeout(
            server.sendRequest<DocumentDiagnosticReport>('textDocument/diagnostic', params),
            PULL_DIAGNOSTICS_TIMEOUT_MS,
            `pull diagnostics timed out after ${PULL_DIAGNOSTICS_TIMEOUT_MS}ms`
          );
          const items = extractFullDiagnostics(report);
          if (items === undefined) {
            // 'unchanged' or non-conforming report. Without a previousResultId we
            // can't act on this; just leave the prior pending entry intact.
            logForDebugging(`LSP: pull diagnostics from ${server.name} unchanged for ${fileUri}`);
            return;
          }
          diagnostics.register(server.name, fileUri, items);
        } catch (error) {
          logForDebugging(
            `LSP: pull diagnostics failed for ${filePath} on ${server.name}: ${errorMessage(error)}`
          );
        }
      })
    );
  }

  function isFileOpen(filePath: string): boolean {
    const fileUri = pathToFileURL(path.resolve(filePath)).href;
    const server = getPrimaryServerForFile(filePath);
    if (!server) return false;
    return isFileOpenInServer(fileUri, server.name);
  }

  return {
    initialize,
    shutdown,
    getServerForFile,
    getConfiguredServersForFile,
    getServersForFile,
    getPrimaryServerForFile,
    ensureServerStarted,
    sendRequest,
    getAllServers,
    getStateCounts,
    onServersChanged,
    markManualServerActive,
    markManualServerInactive,
    isServerAutoActive,
    isServerManuallyActive,
    isServerActive,
    openFile,
    changeFile,
    saveFile,
    closeFile,
    syncFileChange,
    isFileOpen,
    isFileOpenInServer,
  };
}

// ---------------------------------------------------------------------------
// Global singleton + lifecycle helpers (ported subset of Claude Code manager.ts)
// ---------------------------------------------------------------------------

type InitializationState = 'not-started' | 'pending' | 'success' | 'failed';

let managerInstance: LSPServerManager | undefined;
let initializationState: InitializationState = 'not-started';
let initializationPromise: Promise<void> | undefined;
// Generation counter prevents a stale in-flight init from updating state after
// a /reload triggered a fresh init.
let initializationGeneration = 0;

/**
 * Get the singleton manager. Returns undefined if not initialized or failed.
 */
export function getManager(): LSPServerManager | undefined {
  if (initializationState === 'failed') {
    return undefined;
  }
  return managerInstance;
}

/**
 * Whether at least one language server is connected (non-error).
 *
 * Reports overall manager liveness across all configured servers. The `lsp`
 * tool no longer uses this as a gate — it does per-file routing decisions
 * instead — but the helper is kept for external consumers (e.g. status
 * indicators or third-party callers) that want a coarse-grained "any server
 * up?" answer.
 */
export function isLspConnected(): boolean {
  if (initializationState === 'failed') return false;
  const manager = getManager();
  if (!manager) return false;
  const servers = manager.getAllServers();
  if (servers.size === 0) return false;
  for (const server of servers.values()) {
    if (server.state !== 'error') return true;
  }
  return false;
}

/**
 * Wait for manager initialization to complete (resolves immediately if already
 * done or never started).
 */
export async function waitForInitialization(): Promise<void> {
  if (initializationState === 'success' || initializationState === 'failed') {
    return;
  }
  if (initializationState === 'pending' && initializationPromise) {
    await initializationPromise;
  }
}

/**
 * Initialize the manager singleton. Synchronous and non-blocking: it constructs
 * the manager and starts async config loading in the background. Idempotent;
 * retries if a previous attempt failed. Servers are lazily started on first use.
 */
export function initializeManager(cwd: string): void {
  logForDebugging('[LSP MANAGER] initializeManager() called');

  // Skip if already initialized or currently initializing
  if (managerInstance !== undefined && initializationState !== 'failed') {
    logForDebugging('[LSP MANAGER] Already initialized or initializing');
    return;
  }

  // Reset state for retry if previous initialization failed
  if (initializationState === 'failed') {
    managerInstance = undefined;
  }

  managerInstance = createLSPServerManager();
  initializationState = 'pending';

  const currentGeneration = ++initializationGeneration;

  initializationPromise = managerInstance
    .initialize(cwd)
    .then(() => {
      if (currentGeneration === initializationGeneration) {
        initializationState = 'success';
        logForDebugging('LSP server manager initialized successfully');
      }
    })
    .catch((error: unknown) => {
      if (currentGeneration === initializationGeneration) {
        initializationState = 'failed';
        managerInstance = undefined;
        logError(error);
        logForDebugging(`Failed to initialize LSP server manager: ${errorMessage(error)}`);
      }
    });
}

/**
 * Shutdown the manager and clear state. Idempotent; errors are swallowed so
 * shutdown never throws during session teardown.
 */
export async function shutdownManager(): Promise<void> {
  if (managerInstance === undefined) {
    initializationState = 'not-started';
    initializationPromise = undefined;
    initializationGeneration++;
    return;
  }

  try {
    await managerInstance.shutdown();
    logForDebugging('LSP server manager shut down successfully');
  } catch (error: unknown) {
    logError(error);
    logForDebugging(`Failed to shutdown LSP server manager: ${errorMessage(error)}`);
  } finally {
    managerInstance = undefined;
    initializationState = 'not-started';
    initializationPromise = undefined;
    // Invalidate any pending initialization
    initializationGeneration++;
  }
}
