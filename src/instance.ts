// ABOUTME: Lifecycle state machine for a single LSP server (start/stop/retry/health).
// ABOUTME: Faithful port of Claude Code's LSPServerInstance, adapted to Pi closures.

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { InitializeParams } from 'vscode-languageserver-protocol';
import { createLSPClient } from './client.ts';
import { errorMessage, logError, logForDebugging, sleep } from './log.ts';
import type { LspServerState, ScopedLspServerConfig } from './types.ts';

/**
 * LSP error code for "content modified" - indicates the server's state changed
 * during request processing (e.g., rust-analyzer still indexing the project).
 * This is a transient error that can be retried.
 */
const LSP_ERROR_CONTENT_MODIFIED = -32801;

/**
 * Maximum number of retries for transient LSP errors like "content modified".
 */
const MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3;

/**
 * Base delay in milliseconds for exponential backoff on transient errors.
 * Actual delays: 500ms, 1000ms, 2000ms
 */
const RETRY_BASE_DELAY_MS = 500;

/**
 * LSP server instance interface returned by createLSPServerInstance.
 * Manages the lifecycle of a single LSP server with state tracking and health monitoring.
 */
export type LSPServerInstance = {
  /** Unique server identifier */
  readonly name: string;
  /** Server configuration */
  readonly config: ScopedLspServerConfig;
  /** Current server state */
  readonly state: LspServerState;
  /** When the server was last started */
  readonly startTime: Date | undefined;
  /** Last error encountered */
  readonly lastError: Error | undefined;
  /** Number of times restart() has been called */
  readonly restartCount: number;
  /** Start the server and initialize it */
  start(): Promise<void>;
  /** Stop the server gracefully */
  stop(): Promise<void>;
  /** Manually restart the server (stop then start) */
  restart(): Promise<void>;
  /** Check if server is healthy and ready for requests */
  isHealthy(): boolean;
  /** Send an LSP request to the server */
  sendRequest<T>(method: string, params: unknown): Promise<T>;
  /** Send an LSP notification to the server (fire-and-forget) */
  sendNotification(method: string, params: unknown): Promise<void>;
  /** Register a handler for LSP notifications */
  onNotification(method: string, handler: (params: unknown) => void): void;
  /** Register a handler for LSP requests from the server */
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>
  ): void;
};

/**
 * Creates and manages a single LSP server instance.
 *
 * Uses factory function pattern with closures for state encapsulation (avoiding classes).
 * Provides state tracking, health monitoring, and request forwarding for an LSP server.
 * Supports manual restart with configurable retry limits.
 *
 * State machine transitions:
 * - stopped → starting → running
 * - running → stopping → stopped
 * - any → error (on failure)
 * - error → starting (on retry)
 */
export function createLSPServerInstance(
  name: string,
  config: ScopedLspServerConfig
): LSPServerInstance {
  let state: LspServerState = 'stopped';
  let startTime: Date | undefined;
  let lastError: Error | undefined;
  let restartCount = 0;
  // Counts crash recoveries across this instance lifetime; do not reset after
  // successful start, or restartOnCrash can loop forever.
  let crashRecoveryCount = 0;
  // In-flight start() promise so concurrent callers await the same startup
  // instead of racing a not-yet-healthy server.
  let startingPromise: Promise<void> | undefined;
  // Propagate crash state so ensureServerStarted can restart on next use.
  // Without this, state stays 'running' after crash and the server is never
  // restarted (zombie state).
  const client = createLSPClient(name, (error) => {
    state = 'error';
    lastError = error;
    crashRecoveryCount++;

    // restartOnCrash: best-effort auto-restart, bounded by maxRestarts. Never
    // throws — failures just leave the server in 'error' for the next
    // ensureServerStarted to retry. The client guards onCrash with !isStopping,
    // so this only fires on genuinely unexpected exits.
    if (config.restartOnCrash) {
      const maxRestarts = config.maxRestarts ?? 3;
      if (crashRecoveryCount > maxRestarts) {
        logForDebugging(
          `LSP server '${name}' crashed but restartOnCrash gave up (exceeded ${maxRestarts} restarts)`
        );
        return;
      }
      logForDebugging(`LSP server '${name}' crashed; restartOnCrash restarting…`);
      start().catch((startError) => {
        logError(
          new Error(
            `restartOnCrash auto-restart failed for '${name}': ${(startError as Error).message}`
          )
        );
      });
    }
  });

  /**
   * Starts the LSP server and initializes it with workspace information.
   *
   * If already running, returns immediately. If another caller is already
   * starting it, awaits that in-flight start instead of returning a
   * not-yet-healthy server. On failure, sets state to 'error', logs, and throws.
   */
  async function start(): Promise<void> {
    if (state === 'running') return;
    if (state === 'starting' && startingPromise) {
      await startingPromise;
      return;
    }
    startingPromise = doStart();
    try {
      await startingPromise;
    } finally {
      startingPromise = undefined;
    }
  }

  async function doStart(): Promise<void> {
    // Cap crash-recovery attempts so a persistently crashing server doesn't
    // spawn unbounded child processes on every incoming request.
    const maxRestarts = config.maxRestarts ?? 3;
    if (state === 'error' && crashRecoveryCount > maxRestarts) {
      const error = new Error(
        `LSP server '${name}' exceeded max crash recovery attempts (${maxRestarts})`
      );
      lastError = error;
      logError(error);
      throw error;
    }

    let initPromise: Promise<unknown> | undefined;
    try {
      state = 'starting';
      logForDebugging(`Starting LSP server instance: ${name}`);

      // Start the client
      await client.start(config.command, config.args || [], {
        env: config.env,
        cwd: config.workspaceFolder,
      });

      // Initialize with workspace info
      const workspaceFolder = config.workspaceFolder || process.cwd();
      const workspaceUri = pathToFileURL(workspaceFolder).href;

      const initParams: InitializeParams = {
        processId: process.pid,

        // Pass server-specific initialization options from config.
        // Required by some servers, optional for others. Provide empty object
        // as default to avoid undefined errors in servers that expect this field.
        initializationOptions: config.initializationOptions ?? {},

        // Modern approach (LSP 3.16+) - required for Pyright, gopls
        workspaceFolders: [
          {
            uri: workspaceUri,
            name: path.basename(workspaceFolder),
          },
        ],

        // Deprecated fields - some servers still need these for proper URI resolution
        rootPath: workspaceFolder, // Deprecated in LSP 3.8 but needed by some servers
        rootUri: workspaceUri, // Deprecated in LSP 3.16 but needed by typescript-language-server for goToDefinition

        // Client capabilities - declare what features we support
        capabilities: {
          workspace: {
            // Don't claim to support workspace/configuration since we don't implement it
            // This prevents servers from requesting config we can't provide
            configuration: false,
            // Don't claim to support workspace folders changes since we don't handle
            // workspace/didChangeWorkspaceFolders notifications
            workspaceFolders: false,
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true,
            },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: {
                valueSet: [1, 2], // Unnecessary (1), Deprecated (2)
              },
              versionSupport: false,
              codeDescriptionSupport: true,
              dataSupport: false,
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ['markdown', 'plaintext'],
            },
            definition: {
              dynamicRegistration: false,
              linkSupport: true,
            },
            references: {
              dynamicRegistration: false,
            },
            documentSymbol: {
              dynamicRegistration: false,
              hierarchicalDocumentSymbolSupport: true,
            },
            callHierarchy: {
              dynamicRegistration: false,
            },
          },
          general: {
            positionEncodings: ['utf-16'],
          },
        },
      };

      initPromise = client.initialize(initParams);
      if (config.startupTimeout !== undefined) {
        await withTimeout(
          initPromise,
          config.startupTimeout,
          `LSP server '${name}' timed out after ${config.startupTimeout}ms during initialization`
        );
      } else {
        await initPromise;
      }

      state = 'running';
      startTime = new Date();
      logForDebugging(`LSP server instance started: ${name}`);
    } catch (error) {
      // Clean up the spawned child process on timeout/error
      client.stop().catch(() => {});
      // Prevent unhandled rejection from abandoned initialize promise
      initPromise?.catch(() => {});
      state = 'error';
      lastError = error as Error;
      logError(error);
      throw error;
    }
  }

  /**
   * Stops the LSP server gracefully.
   *
   * If already stopped or stopping, returns immediately. When `shutdownTimeout`
   * is configured, the graceful shutdown is raced against a timer; on timeout
   * the process is still killed by `client.stop()`'s finally block, and we
   * mark the server stopped rather than erroring.
   */
  async function stop(): Promise<void> {
    if (state === 'stopped' || state === 'stopping') {
      return;
    }

    state = 'stopping';
    try {
      if (config.shutdownTimeout !== undefined) {
        try {
          await withTimeout(
            client.stop(),
            config.shutdownTimeout,
            `LSP server '${name}' graceful shutdown timed out after ${config.shutdownTimeout}ms`
          );
        } catch (error) {
          // Timeout or shutdown error: client.stop()'s finally already killed
          // the process. Don't surface shutdown hiccups as errors.
          logForDebugging(`LSP server '${name}' stop completed with: ${(error as Error).message}`);
        }
      } else {
        await client.stop();
      }
      state = 'stopped';
      logForDebugging(`LSP server instance stopped: ${name}`);
    } catch (error) {
      state = 'error';
      lastError = error as Error;
      logError(error);
      throw error;
    }
  }

  /**
   * Manually restarts the server by stopping and starting it.
   *
   * Increments restartCount and enforces maxRestarts limit.
   * Note: This is NOT automatic - must be called explicitly.
   */
  async function restart(): Promise<void> {
    try {
      await stop();
    } catch (error) {
      const stopError = new Error(
        `Failed to stop LSP server '${name}' during restart: ${errorMessage(error)}`
      );
      logError(stopError);
      throw stopError;
    }

    restartCount++;

    const maxRestarts = config.maxRestarts ?? 3;
    if (restartCount > maxRestarts) {
      const error = new Error(
        `Max restart attempts (${maxRestarts}) exceeded for server '${name}'`
      );
      logError(error);
      throw error;
    }

    try {
      await start();
    } catch (error) {
      const startError = new Error(
        `Failed to start LSP server '${name}' during restart (attempt ${restartCount}/${maxRestarts}): ${errorMessage(error)}`
      );
      logError(startError);
      throw startError;
    }
  }

  /**
   * Checks if the server is healthy and ready to handle requests.
   */
  function isHealthy(): boolean {
    return state === 'running' && client.isInitialized;
  }

  /**
   * Sends an LSP request to the server with retry logic for transient errors.
   *
   * Checks server health before sending and wraps errors with context.
   * Automatically retries on "content modified" errors (code -32801) which occur
   * when servers like rust-analyzer are still indexing. This is expected LSP behavior
   * and clients should retry silently per the LSP specification.
   */
  async function sendRequest<T>(method: string, params: unknown): Promise<T> {
    if (!isHealthy()) {
      const error = new Error(
        `Cannot send request to LSP server '${name}': server is ${state}` +
          `${lastError ? `, last error: ${lastError.message}` : ''}`
      );
      logError(error);
      throw error;
    }

    let lastAttemptError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES_FOR_TRANSIENT_ERRORS; attempt++) {
      try {
        return await client.sendRequest(method, params);
      } catch (error) {
        lastAttemptError = error as Error;

        // Check if this is a transient "content modified" error that we should retry.
        // This commonly happens with rust-analyzer during initial project indexing.
        // We use duck typing instead of instanceof because there may be multiple
        // versions of vscode-jsonrpc in the dependency tree (8.2.0 vs 8.2.1).
        const errorCode = (error as { code?: number }).code;
        const isContentModifiedError =
          typeof errorCode === 'number' && errorCode === LSP_ERROR_CONTENT_MODIFIED;

        if (isContentModifiedError && attempt < MAX_RETRIES_FOR_TRANSIENT_ERRORS) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          logForDebugging(
            `LSP request '${method}' to '${name}' got ContentModified error, ` +
              `retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES_FOR_TRANSIENT_ERRORS})…`
          );
          await sleep(delay);
          continue;
        }

        // Non-retryable error or max retries exceeded
        break;
      }
    }

    // All retries failed or non-retryable error
    const requestError = new Error(
      `LSP request '${method}' failed for server '${name}': ${lastAttemptError?.message ?? 'unknown error'}`
    );
    logError(requestError);
    throw requestError;
  }

  /**
   * Send a notification to the LSP server (fire-and-forget).
   * Used for file synchronization (didOpen, didChange, didClose).
   */
  async function sendNotification(method: string, params: unknown): Promise<void> {
    if (!isHealthy()) {
      const error = new Error(
        `Cannot send notification to LSP server '${name}': server is ${state}`
      );
      logError(error);
      throw error;
    }

    try {
      await client.sendNotification(method, params);
    } catch (error) {
      const notificationError = new Error(
        `LSP notification '${method}' failed for server '${name}': ${errorMessage(error)}`
      );
      logError(notificationError);
      throw notificationError;
    }
  }

  /**
   * Registers a handler for LSP notifications from the server.
   */
  function onNotification(method: string, handler: (params: unknown) => void): void {
    client.onNotification(method, handler);
  }

  /**
   * Registers a handler for LSP requests from the server.
   *
   * Some LSP servers send requests TO the client (reverse direction).
   * This allows registering handlers for such requests.
   */
  function onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>
  ): void {
    client.onRequest(method, handler);
  }

  // Return public API
  return {
    name,
    config,
    get state() {
      return state;
    },
    get startTime() {
      return startTime;
    },
    get lastError() {
      return lastError;
    },
    get restartCount() {
      return restartCount;
    },
    start,
    stop,
    restart,
    isHealthy,
    sendRequest,
    sendNotification,
    onNotification,
    onRequest,
  };
}

/**
 * Race a promise against a timeout. Cleans up the timer regardless of outcome
 * to avoid unhandled rejections from orphaned setTimeout callbacks.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout((rej, msg) => rej(new Error(msg)), ms, reject, message);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer!));
}
