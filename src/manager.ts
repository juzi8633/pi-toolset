// ABOUTME: Multi-server routing, file synchronization, and the global manager singleton.
// ABOUTME: Trimmed merge of Claude Code's LSPServerManager + manager.ts, adapted to Pi lifecycle.

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PublishDiagnosticsParams } from 'vscode-languageserver-protocol';
import { getAllLspServers } from './config.ts';
import * as diagnostics from './diagnostics.ts';
import { createLSPServerInstance, type LSPServerInstance } from './instance.ts';
import { errorMessage, logError, logForDebugging } from './log.ts';
import type { ScopedLspServerConfig } from './types.ts';

/**
 * LSP Server Manager interface.
 * Manages multiple LSP server instances and routes requests based on file extensions.
 */
export type LSPServerManager = {
  /** Initialize the manager by loading all configured LSP servers, rooted at cwd */
  initialize(cwd: string): Promise<void>;
  /** Shutdown all running servers and clear state */
  shutdown(): Promise<void>;
  /** Get the LSP server instance for a given file path */
  getServerForFile(filePath: string): LSPServerInstance | undefined;
  /** Ensure the appropriate LSP server is started for the given file */
  ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>;
  /** Send a request to the appropriate LSP server for the given file */
  sendRequest<T>(filePath: string, method: string, params: unknown): Promise<T | undefined>;
  /** Get all server instances */
  getAllServers(): Map<string, LSPServerInstance>;
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
  /** Check if a file is already open on a compatible LSP server */
  isFileOpen(filePath: string): boolean;
};

/**
 * Creates an LSP server manager instance.
 *
 * Manages multiple LSP server instances and routes requests based on file extensions.
 * Uses factory function pattern with closures for state encapsulation (avoiding classes).
 */
export function createLSPServerManager(): LSPServerManager {
  // Private state managed via closures
  const servers: Map<string, LSPServerInstance> = new Map();
  const extensionMap: Map<string, string[]> = new Map();
  // Track which files have been opened on which servers (URI -> server name)
  const openedFiles: Map<string, string> = new Map();

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

        // Create server instance
        const instance = createLSPServerInstance(serverName, config);
        servers.set(serverName, instance);

        // Register handler for workspace/configuration requests from the server.
        // Some servers (like TypeScript) send these even when we say we don't support them.
        instance.onRequest(
          'workspace/configuration',
          (params: { items: Array<{ section?: string }> }) => {
            logForDebugging(`LSP: Received workspace/configuration request from ${serverName}`);
            // Return null config for each requested item - satisfies the protocol
            // without providing actual configuration.
            return params.items.map(() => null);
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
            diagnostics.register(p.uri, p.diagnostics ?? []);
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
   * Get the LSP server instance for a given file path.
   * If multiple servers handle the same extension, returns the first registered server.
   */
  function getServerForFile(filePath: string): LSPServerInstance | undefined {
    const ext = path.extname(filePath).toLowerCase();
    const serverNames = extensionMap.get(ext);

    if (!serverNames || serverNames.length === 0) {
      return undefined;
    }

    // Use first server (can add priority later)
    const serverName = serverNames[0];
    if (!serverName) {
      return undefined;
    }

    return servers.get(serverName);
  }

  /**
   * Ensure the appropriate LSP server is started for the given file.
   */
  async function ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined> {
    const server = getServerForFile(filePath);
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
   * Send a request to the appropriate LSP server for the given file.
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

  async function openFile(filePath: string, content: string): Promise<void> {
    const server = await ensureServerStarted(filePath);
    if (!server) return;

    const fileUri = pathToFileURL(path.resolve(filePath)).href;

    // Skip if already opened on this server
    if (openedFiles.get(fileUri) === server.name) {
      logForDebugging(`LSP: File already open, skipping didOpen for ${filePath}`);
      return;
    }

    // Get language ID from server's extensionToLanguage mapping
    const ext = path.extname(filePath).toLowerCase();
    const languageId = server.config.extensionToLanguage[ext] || 'plaintext';

    try {
      await server.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: fileUri,
          languageId,
          version: 1,
          text: content,
        },
      });
      // Track that this file is now open on this server
      openedFiles.set(fileUri, server.name);
      logForDebugging(`LSP: Sent didOpen for ${filePath} (languageId: ${languageId})`);
    } catch (error) {
      const err = new Error(`Failed to sync file open ${filePath}: ${errorMessage(error)}`);
      logError(err);
      throw err;
    }
  }

  async function changeFile(filePath: string, content: string): Promise<void> {
    const server = getServerForFile(filePath);
    if (!server || server.state !== 'running') {
      return openFile(filePath, content);
    }

    const fileUri = pathToFileURL(path.resolve(filePath)).href;

    // If file hasn't been opened on this server yet, open it first.
    // LSP servers require didOpen before didChange.
    if (openedFiles.get(fileUri) !== server.name) {
      return openFile(filePath, content);
    }

    try {
      await server.sendNotification('textDocument/didChange', {
        textDocument: {
          uri: fileUri,
          version: 1,
        },
        contentChanges: [{ text: content }],
      });
      logForDebugging(`LSP: Sent didChange for ${filePath}`);
    } catch (error) {
      const err = new Error(`Failed to sync file change ${filePath}: ${errorMessage(error)}`);
      logError(err);
      throw err;
    }
  }

  /**
   * Save a file in LSP servers (sends didSave notification).
   * Called after a file is written to disk to trigger diagnostics.
   */
  async function saveFile(filePath: string): Promise<void> {
    const server = getServerForFile(filePath);
    if (!server || server.state !== 'running') return;

    try {
      await server.sendNotification('textDocument/didSave', {
        textDocument: {
          uri: pathToFileURL(path.resolve(filePath)).href,
        },
      });
      logForDebugging(`LSP: Sent didSave for ${filePath}`);
    } catch (error) {
      const err = new Error(`Failed to sync file save ${filePath}: ${errorMessage(error)}`);
      logError(err);
      throw err;
    }
  }

  /**
   * Close a file in LSP servers (sends didClose notification).
   */
  async function closeFile(filePath: string): Promise<void> {
    const server = getServerForFile(filePath);
    if (!server || server.state !== 'running') return;

    const fileUri = pathToFileURL(path.resolve(filePath)).href;

    try {
      await server.sendNotification('textDocument/didClose', {
        textDocument: {
          uri: fileUri,
        },
      });
      // Remove from tracking so file can be reopened later
      openedFiles.delete(fileUri);
      logForDebugging(`LSP: Sent didClose for ${filePath}`);
    } catch (error) {
      const err = new Error(`Failed to sync file close ${filePath}: ${errorMessage(error)}`);
      logError(err);
      throw err;
    }
  }

  /**
   * Re-sync a file after an external edit (e.g. the agent's edit/write tool).
   *
   * Reads the current disk content and sends didChange + didSave so the LSP
   * server re-publishes diagnostics for the updated file. Falls back to didOpen
   * via changeFile when the file has not been opened on the server yet.
   */
  async function syncFileChange(filePath: string): Promise<void> {
    const server = getServerForFile(filePath);
    if (!server) return;

    let content: string;
    try {
      content = await readFile(filePath, { encoding: 'utf-8' });
    } catch (error) {
      // File may have been deleted or is unreadable; nothing to sync.
      logForDebugging(`LSP: syncFileChange skipped ${filePath}: ${errorMessage(error)}`);
      return;
    }

    await changeFile(filePath, content);
    await saveFile(filePath);
  }

  function isFileOpen(filePath: string): boolean {
    const fileUri = pathToFileURL(path.resolve(filePath)).href;
    return openedFiles.has(fileUri);
  }

  return {
    initialize,
    shutdown,
    getServerForFile,
    ensureServerStarted,
    sendRequest,
    getAllServers,
    openFile,
    changeFile,
    saveFile,
    closeFile,
    syncFileChange,
    isFileOpen,
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
 * Whether at least one language server is connected (non-error). Gates the tool.
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
