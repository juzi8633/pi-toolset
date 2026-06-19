// ABOUTME: JSON-RPC stdio transport to a single LSP server process.
// ABOUTME: Faithful port of Claude Code's LSPClient, adapted to Pi (ESM dynamic import + local logging).

import { type ChildProcess, spawn } from 'node:child_process';
import type { GenericRequestHandler, MessageConnection } from 'vscode-jsonrpc/node';
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from 'vscode-languageserver-protocol';
import { errorMessage, logError, logForDebugging } from './log.ts';
import { attachStartupErrorMetadata, type StartupErrorMetadata } from './startup-errors.ts';

const STARTUP_STDERR_LIMIT_BYTES = 8 * 1024;

/**
 * LSP client interface.
 */
export type LSPClient = {
  readonly capabilities: ServerCapabilities | undefined;
  readonly isInitialized: boolean;
  start: (
    command: string,
    args: string[],
    options?: {
      env?: Record<string, string>;
      cwd?: string;
    }
  ) => Promise<void>;
  initialize: (params: InitializeParams) => Promise<InitializeResult>;
  sendRequest: <TResult>(method: string, params: unknown) => Promise<TResult>;
  sendNotification: (method: string, params: unknown) => Promise<void>;
  onNotification: (method: string, handler: (params: unknown) => void) => void;
  onRequest: <TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>
  ) => void;
  stop: (options?: { shutdownTimeout?: number }) => Promise<void>;
};

/**
 * Create an LSP client wrapper using vscode-jsonrpc.
 * Manages communication with an LSP server process via stdio.
 *
 * @param onCrash - Called when the server process exits unexpectedly (non-zero
 *   exit code during operation, not during intentional stop). Allows the owner
 *   to propagate crash state so the server can be restarted on next use.
 */
export function createLSPClient(serverName: string, onCrash?: (error: Error) => void): LSPClient {
  // State variables in closure
  let childProcess: ChildProcess | undefined;
  let connection: MessageConnection | undefined;
  let capabilities: ServerCapabilities | undefined;
  let isInitialized = false;
  let startFailed = false;
  let startError: Error | undefined;
  let isStopping = false; // Track intentional shutdown to avoid spurious error logging
  let startupStderr = '';
  // Queue handlers registered before connection ready (lazy initialization support)
  const pendingHandlers: Array<{
    method: string;
    handler: (params: unknown) => void;
  }> = [];
  const pendingRequestHandlers: Array<{
    method: string;
    handler: (params: unknown) => unknown | Promise<unknown>;
  }> = [];

  function checkStartFailed(): void {
    if (startFailed) {
      throw startError || new Error(`LSP server ${serverName} failed to start`);
    }
  }

  function appendStartupStderr(data: Buffer): string {
    const output = data.toString();
    startupStderr = `${startupStderr}${output}`.slice(-STARTUP_STDERR_LIMIT_BYTES);
    return output.trim();
  }

  function markStartupError<T extends Error>(
    error: T,
    phase: NonNullable<StartupErrorMetadata['phase']>
  ): T {
    return attachStartupErrorMetadata(error, {
      spawnCode: getErrorCode(error),
      startupStderr,
      phase,
    });
  }

  return {
    get capabilities(): ServerCapabilities | undefined {
      return capabilities;
    },

    get isInitialized(): boolean {
      return isInitialized;
    },

    async start(
      command: string,
      args: string[],
      options?: {
        env?: Record<string, string>;
        cwd?: string;
      }
    ): Promise<void> {
      startFailed = false;
      startError = undefined;
      startupStderr = '';
      capabilities = undefined;
      isInitialized = false;

      try {
        // Lazy-load vscode-jsonrpc so its transport code is only evaluated when
        // a server is actually started, not at module import time.
        const { createMessageConnection, StreamMessageReader, StreamMessageWriter, Trace } =
          await import('vscode-jsonrpc/node');

        // 1. Spawn LSP server process
        childProcess = spawn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...options?.env },
          cwd: options?.cwd,
          // Prevent visible console window on Windows (no-op on other platforms)
          windowsHide: true,
        });

        if (!childProcess.stdout || !childProcess.stdin) {
          throw new Error('LSP server process stdio not available');
        }

        // 1.5. Wait for process to successfully spawn before using streams
        // This is CRITICAL: spawn() returns immediately, but the 'error' event
        // (e.g., ENOENT for command not found) fires asynchronously.
        // If we use the streams before confirming spawn succeeded, we get
        // unhandled promise rejections when writes fail on invalid streams.
        const spawnedProcess = childProcess; // Capture for closure
        await new Promise<void>((resolve, reject) => {
          const onSpawn = (): void => {
            cleanup();
            resolve();
          };
          const onError = (error: Error): void => {
            cleanup();
            reject(markStartupError(error, 'start'));
          };
          const cleanup = (): void => {
            spawnedProcess.removeListener('spawn', onSpawn);
            spawnedProcess.removeListener('error', onError);
          };
          spawnedProcess.once('spawn', onSpawn);
          spawnedProcess.once('error', onError);
        });

        // Capture bounded stderr for startup classification and server diagnostics
        if (childProcess.stderr) {
          childProcess.stderr.on('data', (data: Buffer) => {
            const output = appendStartupStderr(data);
            if (output) {
              logForDebugging(`[LSP SERVER ${serverName}] ${output}`);
            }
          });
        }

        // Handle process errors (after successful spawn, e.g., crash during operation)
        childProcess.on('error', (error) => {
          if (!isStopping) {
            const startupError = markStartupError(error, 'start');
            startFailed = true;
            startError = startupError;
            logError(
              new Error(`LSP server ${serverName} failed to start: ${startupError.message}`)
            );
          }
        });

        childProcess.on('exit', (code, _signal) => {
          if (code !== 0 && code !== null && !isStopping) {
            const wasInitialized = isInitialized;
            isInitialized = false;
            startFailed = !wasInitialized;
            const crashError = markStartupError(
              new Error(`LSP server ${serverName} crashed with exit code ${code}`),
              'exit'
            );
            startError = crashError;
            logError(crashError);
            onCrash?.(crashError);
            // Dispose the JSON-RPC connection so any pending requests (e.g. the
            // initialize handshake) are rejected immediately rather than hanging
            // indefinitely.
            connection?.dispose();
          }
        });

        // Handle stdin stream errors to prevent unhandled promise rejections
        // when the LSP server process exits before we finish writing
        childProcess.stdin.on('error', (error: Error) => {
          if (!isStopping) {
            logForDebugging(`LSP server ${serverName} stdin error: ${error.message}`);
          }
          // Error is logged but not thrown - the connection error handler will catch this
        });

        // 2. Create JSON-RPC connection
        const reader = new StreamMessageReader(childProcess.stdout);
        const writer = new StreamMessageWriter(childProcess.stdin);
        connection = createMessageConnection(reader, writer);

        // 2.5. Register error/close handlers BEFORE listen() to catch all errors
        // This prevents unhandled promise rejections when the server crashes or closes unexpectedly
        connection.onError(([error, _message, _code]) => {
          // Only log if not intentionally stopping (avoid spurious errors during shutdown)
          if (!isStopping) {
            const startupError = markStartupError(error, 'connection');
            startFailed = true;
            startError = startupError;
            logError(
              new Error(`LSP server ${serverName} connection error: ${startupError.message}`)
            );
            // Dispose the connection so any pending requests (e.g. initialize)
            // are rejected immediately rather than hanging indefinitely.
            connection?.dispose();
          }
        });

        connection.onClose(() => {
          // Only treat as error if not intentionally stopping
          if (!isStopping) {
            const wasInitialized = isInitialized;
            isInitialized = false;
            if (!wasInitialized && !startFailed) {
              startFailed = true;
              startError = markStartupError(
                new Error(`LSP server ${serverName} connection closed during startup`),
                'connection'
              );
            }
            logForDebugging(`LSP server ${serverName} connection closed`);
          }
        });

        // 3. Start listening for messages
        connection.listen();

        // 3.5. Enable protocol tracing for debugging
        // Note: trace() sends a $/setTrace notification which can fail if the server
        // process has already exited. We catch and log the error rather than letting
        // it become an unhandled promise rejection.
        connection
          .trace(Trace.Verbose, {
            log: (message: string) => {
              logForDebugging(`[LSP PROTOCOL ${serverName}] ${message}`);
            },
          })
          .catch((error: Error) => {
            logForDebugging(`Failed to enable tracing for ${serverName}: ${error.message}`);
          });

        // 4. Apply any queued notification handlers
        for (const { method, handler } of pendingHandlers) {
          connection.onNotification(method, handler);
          logForDebugging(`Applied queued notification handler for ${serverName}.${method}`);
        }
        pendingHandlers.length = 0; // Clear the queue

        // 5. Apply any queued request handlers
        for (const { method, handler } of pendingRequestHandlers) {
          connection.onRequest(method, handler as GenericRequestHandler<unknown, unknown>);
          logForDebugging(`Applied queued request handler for ${serverName}.${method}`);
        }
        pendingRequestHandlers.length = 0; // Clear the queue

        logForDebugging(`LSP client started for ${serverName}`);
      } catch (error) {
        const err = error as Error;
        const startupError = markStartupError(err, 'start');
        logError(new Error(`LSP server ${serverName} failed to start: ${startupError.message}`));
        throw startupError;
      }
    },

    async initialize(params: InitializeParams): Promise<InitializeResult> {
      if (!connection) {
        throw new Error('LSP client not started');
      }

      checkStartFailed();

      try {
        const result: InitializeResult = await connection.sendRequest('initialize', params);

        capabilities = result.capabilities;

        // Send initialized notification
        await connection.sendNotification('initialized', {});

        isInitialized = true;
        logForDebugging(`LSP server ${serverName} initialized`);

        return result;
      } catch (error) {
        const err = (startError ?? error) as Error;
        const startupError = markStartupError(err, 'initialize');
        logError(new Error(`LSP server ${serverName} initialize failed: ${startupError.message}`));
        throw startupError;
      }
    },

    async sendRequest<TResult>(method: string, params: unknown): Promise<TResult> {
      if (!connection) {
        throw new Error('LSP client not started');
      }

      checkStartFailed();

      if (!isInitialized) {
        throw new Error('LSP server not initialized');
      }

      try {
        return await connection.sendRequest(method, params);
      } catch (error) {
        const err = error as Error;
        logError(new Error(`LSP server ${serverName} request ${method} failed: ${err.message}`));
        throw error;
      }
    },

    async sendNotification(method: string, params: unknown): Promise<void> {
      if (!connection) {
        throw new Error('LSP client not started');
      }

      checkStartFailed();

      try {
        await connection.sendNotification(method, params);
      } catch (error) {
        const err = error as Error;
        logError(
          new Error(`LSP server ${serverName} notification ${method} failed: ${err.message}`)
        );
        // Don't re-throw for notifications - they're fire-and-forget
        logForDebugging(`Notification ${method} failed but continuing`);
      }
    },

    onNotification(method: string, handler: (params: unknown) => void): void {
      if (!connection) {
        // Queue handler for application when connection is ready (lazy initialization)
        pendingHandlers.push({ method, handler });
        logForDebugging(
          `Queued notification handler for ${serverName}.${method} (connection not ready)`
        );
        return;
      }

      checkStartFailed();

      connection.onNotification(method, handler);
    },

    onRequest<TParams, TResult>(
      method: string,
      handler: (params: TParams) => TResult | Promise<TResult>
    ): void {
      if (!connection) {
        // Queue handler for application when connection is ready (lazy initialization)
        pendingRequestHandlers.push({
          method,
          handler: handler as (params: unknown) => unknown | Promise<unknown>,
        });
        logForDebugging(
          `Queued request handler for ${serverName}.${method} (connection not ready)`
        );
        return;
      }

      checkStartFailed();

      connection.onRequest(method, handler as GenericRequestHandler<TResult, unknown>);
    },

    async stop(options?: { shutdownTimeout?: number }): Promise<void> {
      let shutdownError: Error | undefined;
      const activeConnection = connection;
      const activeChildProcess = childProcess;
      const ownsCurrentResources =
        connection === activeConnection && childProcess === activeChildProcess;
      let shutdownPromise: Promise<void> | undefined;

      // Mark as stopping to prevent error handlers from logging spurious errors
      isStopping = true;

      try {
        if (activeConnection) {
          // Try to send shutdown request and exit notification
          shutdownPromise = (async () => {
            await activeConnection.sendRequest('shutdown', {});
            await activeConnection.sendNotification('exit', {});
          })();

          if (options?.shutdownTimeout !== undefined) {
            await withTimeout(
              shutdownPromise,
              options.shutdownTimeout,
              `LSP server ${serverName} shutdown timed out after ${options.shutdownTimeout}ms`
            );
          } else {
            await shutdownPromise;
          }
        }
      } catch (error) {
        const err = error as Error;
        logError(new Error(`LSP server ${serverName} stop failed: ${err.message}`));
        shutdownError = err;
        // Continue to cleanup despite shutdown failure
      } finally {
        // Avoid unhandled rejections if the timeout wins before shutdown settles.
        shutdownPromise?.catch(() => {});

        // Always cleanup the resources that belonged to this stop call, even if
        // shutdown/exit failed or a later start replaced the client fields.
        if (activeConnection) {
          try {
            activeConnection.dispose();
          } catch (error) {
            // Log but don't throw - disposal errors are less critical
            logForDebugging(`Connection disposal failed for ${serverName}: ${errorMessage(error)}`);
          }
          if (connection === activeConnection) {
            connection = undefined;
          }
        }

        if (activeChildProcess) {
          // Remove event listeners to prevent memory leaks
          activeChildProcess.removeAllListeners('error');
          activeChildProcess.removeAllListeners('exit');
          if (activeChildProcess.stdin) {
            activeChildProcess.stdin.removeAllListeners('error');
          }
          if (activeChildProcess.stderr) {
            activeChildProcess.stderr.removeAllListeners('data');
          }

          try {
            activeChildProcess.kill();
          } catch (error) {
            // Process might already be dead, which is fine
            logForDebugging(
              `Process kill failed for ${serverName} (may already be dead): ${errorMessage(error)}`
            );
          }
          if (childProcess === activeChildProcess) {
            childProcess = undefined;
          }
        }

        if (ownsCurrentResources) {
          isInitialized = false;
          capabilities = undefined;
        }
        isStopping = false; // Reset for potential restart
        // Don't reset startFailed - preserve error state for diagnostics
        // startFailed and startError remain as-is
        if (shutdownError) {
          startFailed = true;
          startError = shutdownError;
        }

        logForDebugging(`LSP client stopped for ${serverName}`);
      }

      // Re-throw shutdown error after cleanup is complete
      if (shutdownError) {
        throw shutdownError;
      }
    },
  };
}

function getErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout((rej, msg) => rej(new Error(msg)), ms, reject, message);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer!));
}
