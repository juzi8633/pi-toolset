// ABOUTME: Grok ACP client adapter — Node child streams to SDK ndJsonStream and lifecycle.
// ABOUTME: Owns initialize/auth/session new-or-load/prompt, permission handling, cancel, and cleanup.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { Readable, Transform, Writable } from 'node:stream';
import type { Readable as NodeReadable } from 'node:stream';
import {
  client,
  methods,
  ndJsonStream,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  buildGrokAcpAuthenticateParams,
  buildGrokAcpPromptParams,
  GROK_ACP_PROTOCOL_VERSION,
  selectGrokAcpAuthMethod,
} from './grok-acp-invocation.ts';

/** Compatible with execution.ts SpawnFn without importing it (avoids cycles). */
export type GrokAcpSpawnedChild = ChildProcess & {
  stdout: NodeReadable;
  stderr: NodeReadable;
  stdin: NodeJS.WritableStream;
};

export type GrokAcpSpawnFn = (
  command: string,
  args: string[],
  options: object
) => GrokAcpSpawnedChild;

export type GrokAcpLifecycleStage =
  'spawn' | 'initialize' | 'authenticate' | 'session' | 'load' | 'prompt' | 'shutdown';

export type GrokAcpSessionPhase = 'load' | 'prompt' | 'idle';

export type GrokAcpErrorCode =
  | 'acp_load_unsupported'
  | 'acp_session_not_found'
  | 'acp_cwd_mismatch'
  | 'acp_session_history_empty'
  | 'acp_load_error'
  | 'transport_error'
  | 'aborted'
  | 'dispose_failed';

const DEFAULT_STAGE_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_CANCEL_GRACE_MS = 2_000;
const HARD_KILL_MS = 5_000;
const MAX_STDERR_CHARS = 16 * 1024;

export class GrokAcpClientError extends Error {
  readonly stage: GrokAcpLifecycleStage;
  readonly stderr: string;
  readonly code?: GrokAcpErrorCode;

  constructor(stage: GrokAcpLifecycleStage, message: string, stderr = '', code?: GrokAcpErrorCode) {
    super(message);
    this.name = 'GrokAcpClientError';
    this.stage = stage;
    this.stderr = stderr;
    this.code = code;
  }
}

export interface GrokAcpClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnFn?: GrokAcpSpawnFn;
  signal?: AbortSignal;
  initializeParams: InitializeRequest;
  sessionNewParams: NewSessionRequest;
  task: string;
  onSessionUpdate?: (notification: SessionNotification) => void;
  /**
   * Awaited after session/new returns a non-empty ID and before the first prompt.
   * Rejection disposes the process without prompting.
   */
  onSessionEstablished?: (sessionId: string) => void | Promise<void>;
  stageTimeoutMs?: number;
  promptTimeoutMs?: number;
  cancelGraceMs?: number;
  /** Test seam: override auth selection. */
  selectAuthMethod?: (init: InitializeResponse, env: NodeJS.ProcessEnv) => string | null;
}

export interface GrokAcpClientResult {
  promptResponse: PromptResponse;
  /**
   * How the turn completed. Callers must only mark continuation delivery when
   * this is `response` (never `cancel_grace`).
   */
  promptCompletionSource: GrokAcpPromptCompletion['source'];
  stderr: string;
  exitCode: number;
  wasAborted: boolean;
  sessionId: string;
}

export interface GrokAcpConnectionOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnFn?: GrokAcpSpawnFn;
  signal?: AbortSignal;
  initializeParams: InitializeRequest;
  stageTimeoutMs?: number;
  promptTimeoutMs?: number;
  cancelGraceMs?: number;
  selectAuthMethod?: (init: InitializeResponse, env: NodeJS.ProcessEnv) => string | null;
  /**
   * Session updates tagged with the current phase. Load-phase updates must not
   * enter a one-shot SingleResult baseline.
   */
  onSessionUpdate?: (notification: SessionNotification, phase: GrokAcpSessionPhase) => void;
}

/**
 * Turn completion for a dispatched prompt. `response` is a real matching
 * session/prompt result; `cancel_grace` is a local timeout settlement after
 * session/cancel and must never confirm continuation delivery.
 */
export type GrokAcpPromptCompletion =
  | { source: 'response'; response: PromptResponse }
  | { source: 'cancel_grace'; response: PromptResponse };

export interface GrokAcpPromptDispatch {
  /** Resolves when the prompt request has been written/registered (dispatch acceptance). */
  accepted: Promise<void>;
  /**
   * Resolves when the turn ends. Delivery callbacks must only run for
   * `source: 'response'` — never for `cancel_grace`.
   */
  completed: Promise<GrokAcpPromptCompletion>;
}

export interface GrokAcpConnection {
  readonly sessionId: string;
  readonly phase: GrokAcpSessionPhase;
  readonly stderr: string;
  readonly wasAborted: boolean;
  /**
   * Create a new session, validate the ID, await onSessionEstablished, then idle.
   * Does not send a prompt.
   */
  newSession(
    params: NewSessionRequest,
    onSessionEstablished?: (sessionId: string) => void | Promise<void>
  ): Promise<string>;
  /**
   * Load an existing session. Collects matching session/update replay until the
   * load response (barrier). Hydrate-only callers should dispose after this returns.
   */
  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
  /**
   * Dispatch a prompt. `accepted` resolves at write registration; `completed`
   * resolves with the matching response. Only one prompt may be in flight.
   */
  prompt(taskOrParams: string | { sessionId?: string; task: string }): GrokAcpPromptDispatch;
  cancel(): Promise<void>;
  dispose(): Promise<number>;
  getExitCode(): number | null;
}

function boundStderr(text: string): string {
  if (text.length <= MAX_STDERR_CHARS) return text;
  return text.slice(text.length - MAX_STDERR_CHARS);
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  stage: GrokAcpLifecycleStage,
  stderr: () => string
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new GrokAcpClientError(
          stage,
          `Grok ACP ${stage} timed out after ${ms}ms`,
          boundStderr(stderr())
        )
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function selectPermissionOutcome(
  params: RequestPermissionRequest,
  aborted: boolean
): RequestPermissionResponse {
  if (aborted) {
    return { outcome: { outcome: 'cancelled' } };
  }
  const once = params.options.find((o) => o.kind === 'allow_once');
  if (once) {
    return { outcome: { outcome: 'selected', optionId: once.optionId } };
  }
  const always = params.options.find((o) => o.kind === 'allow_always');
  if (always) {
    return { outcome: { outcome: 'selected', optionId: always.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

interface ProcessHandle {
  proc: GrokAcpSpawnedChild;
  stderr: string;
  exitCode: number | null;
  hasClosed: boolean;
  exitPromise: Promise<number>;
  cleaned: boolean;
  termSent: boolean;
  /** Sticky dispose failure; subsequent dispose() rethrows the same error. */
  disposeError?: GrokAcpClientError;
  /** Shared in-flight dispose promise for true idempotence. */
  disposePromise?: Promise<number>;
}

function attachProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  spawnFn: GrokAcpSpawnFn
): ProcessHandle {
  const proc = spawnFn(command, args, {
    cwd,
    env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const handle: ProcessHandle = {
    proc,
    stderr: '',
    exitCode: null,
    hasClosed: false,
    cleaned: false,
    termSent: false,
    exitPromise: new Promise<number>((resolve) => {
      proc.on('close', (code) => {
        handle.hasClosed = true;
        handle.exitCode = code ?? 0;
        resolve(handle.exitCode);
      });
      proc.on('error', (err: Error) => {
        handle.hasClosed = true;
        const message = err?.message || String(err);
        handle.stderr = handle.stderr ? `${handle.stderr}\n${message}` : message;
        handle.exitCode = 1;
        resolve(1);
      });
    }),
  };

  proc.stderr.on('data', (data) => {
    handle.stderr += data.toString();
    if (handle.stderr.length > MAX_STDERR_CHARS * 2) {
      handle.stderr = boundStderr(handle.stderr);
    }
  });

  return handle;
}

function sendSigterm(handle: ProcessHandle): void {
  if (handle.hasClosed || handle.termSent) return;
  handle.termSent = true;
  try {
    handle.proc.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

async function cleanupProcess(
  handle: ProcessHandle,
  options: { alreadyTermed?: boolean } = {}
): Promise<number> {
  // Sticky: once dispose failed, every later dispose rethrows the same error.
  if (handle.disposeError) {
    throw handle.disposeError;
  }
  // True idempotence: share one in-flight promise; completed success reuses exit.
  if (handle.disposePromise) {
    return handle.disposePromise;
  }

  handle.disposePromise = (async () => {
    if (handle.cleaned) {
      if (handle.disposeError) throw handle.disposeError;
      return handle.exitCode ?? (await handle.exitPromise);
    }
    handle.cleaned = true;

    try {
      handle.proc.stdin?.end?.();
    } catch {
      /* ignore */
    }

    if (handle.hasClosed) {
      return handle.exitCode ?? 0;
    }

    if (!options.alreadyTermed && !handle.termSent) {
      sendSigterm(handle);
    } else if (options.alreadyTermed) {
      handle.termSent = true;
    }

    const exited = await Promise.race([
      handle.exitPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), HARD_KILL_MS)),
    ]);

    if (!exited && !handle.hasClosed) {
      let killOk = true;
      try {
        const result = handle.proc.kill('SIGKILL');
        // Node returns false when the process could not be signaled.
        if (result === false) killOk = false;
      } catch {
        killOk = false;
      }
      if (!killOk && !handle.hasClosed) {
        const err = new GrokAcpClientError(
          'shutdown',
          'SIGKILL failed; child may still hold the session writer (dispose_failed)',
          boundStderr(handle.stderr),
          'dispose_failed'
        );
        handle.disposeError = err;
        throw err;
      }
      // Bounded wait after SIGKILL — never hang forever without close confirmation.
      const closedAfterKill = await Promise.race([
        handle.exitPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), HARD_KILL_MS)),
      ]);
      if (!closedAfterKill && !handle.hasClosed) {
        const err = new GrokAcpClientError(
          'shutdown',
          'Process did not close after SIGKILL within hard dispose bound (dispose_failed)',
          boundStderr(handle.stderr),
          'dispose_failed'
        );
        handle.disposeError = err;
        throw err;
      }
    }

    return handle.exitCode ?? 1;
  })();

  try {
    return await handle.disposePromise;
  } catch (err) {
    // Keep the rejected promise so later dispose() rethrows the same failure.
    if (err instanceof GrokAcpClientError && err.code === 'dispose_failed') {
      handle.disposeError = err;
    } else if (!handle.disposeError) {
      handle.disposeError = new GrokAcpClientError(
        'shutdown',
        err instanceof Error ? err.message : String(err),
        boundStderr(handle.stderr),
        'dispose_failed'
      );
    }
    throw handle.disposeError;
  }
}

function isGrokSkillsReloadResponse(line: string): boolean {
  try {
    const message = JSON.parse(line) as Record<string, unknown>;
    return (
      message.jsonrpc === '2.0' &&
      message.id === 'skills-reload' &&
      !('method' in message) &&
      ('result' in message || 'error' in message)
    );
  } catch {
    return false;
  }
}

function filterGrokControlResponses(): Transform {
  let buffered = '';
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!isGrokSkillsReloadResponse(line)) this.push(`${line}\n`);
      }
      callback();
    },
    flush(callback) {
      if (buffered && !isGrokSkillsReloadResponse(buffered)) this.push(buffered);
      callback();
    },
  });
}

function childToNdJsonStream(proc: GrokAcpSpawnedChild) {
  const output = Writable.toWeb(proc.stdin as Writable);
  const filteredStdout = proc.stdout.pipe(filterGrokControlResponses());
  const input = Readable.toWeb(filteredStdout) as unknown as ReadableStream<Uint8Array>;
  return ndJsonStream(output, input);
}

function abortError(stage: GrokAcpLifecycleStage, stderr: string): GrokAcpClientError {
  return new GrokAcpClientError(stage, 'Subagent was aborted', boundStderr(stderr), 'aborted');
}

function classifyLoadError(message: string, stderr: string): GrokAcpClientError {
  const lower = `${message}\n${stderr}`.toLowerCase();
  if (
    lower.includes('path not found') ||
    lower.includes('session not found') ||
    lower.includes('not found')
  ) {
    return new GrokAcpClientError('load', message, boundStderr(stderr), 'acp_session_not_found');
  }
  if (lower.includes('cwd') && (lower.includes('mismatch') || lower.includes('does not match'))) {
    return new GrokAcpClientError('load', message, boundStderr(stderr), 'acp_cwd_mismatch');
  }
  return new GrokAcpClientError('load', message, boundStderr(stderr), 'acp_load_error');
}

type AgentCtx = {
  request: (method: string, params?: unknown) => Promise<unknown>;
  notify: (method: string, params?: unknown) => Promise<void>;
};

/**
 * Open a long-lived ACP connection: spawn → initialize → authenticate.
 * Callers then newSession or loadSession, optionally prompt, and dispose.
 */
export async function openGrokAcpConnection(
  options: GrokAcpConnectionOptions
): Promise<GrokAcpConnection> {
  const stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  const promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  const cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const spawnFn = options.spawnFn ?? (spawn as unknown as GrokAcpSpawnFn);
  const selectAuth = options.selectAuthMethod ?? selectGrokAcpAuthMethod;

  let stage: GrokAcpLifecycleStage = 'spawn';
  let wasAborted = false;
  let sessionId = '';
  let phase: GrokAcpSessionPhase = 'idle';
  let cancelSent = false;
  let handle: ProcessHandle | undefined;
  let agentCtx: AgentCtx | undefined;
  let onAbortDuringPrompt: (() => void) | undefined;
  let promptInFlight = false;
  let disposed = false;
  /** Session id currently expected for load-phase replay filtering. */
  let loadSessionFilter: string | null = null;
  let initResponse: InitializeResponse | undefined;
  const abortWaiters: Array<() => void> = [];

  const notifyAbortWaiters = () => {
    while (abortWaiters.length > 0) {
      abortWaiters.shift()?.();
    }
  };

  const sendCancel = async () => {
    if (cancelSent || !sessionId || !agentCtx) return;
    cancelSent = true;
    try {
      await agentCtx.notify(methods.agent.session.cancel, { sessionId });
    } catch {
      /* connection may already be closing */
    }
  };

  const onAbort = () => {
    wasAborted = true;
    void sendCancel();
    notifyAbortWaiters();
    onAbortDuringPrompt?.();
  };

  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  const throwIfAborted = (at: GrokAcpLifecycleStage = stage): void => {
    if (wasAborted) throw abortError(at, handle?.stderr ?? '');
  };

  const raceStage = async <T>(promise: Promise<T>, at: GrokAcpLifecycleStage): Promise<T> => {
    throwIfAborted(at);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let waiter: (() => void) | undefined;
      const settle = () => {
        if (settled) return false;
        settled = true;
        if (waiter) {
          const idx = abortWaiters.indexOf(waiter);
          if (idx >= 0) abortWaiters.splice(idx, 1);
        }
        return true;
      };
      const finish = (value: T) => {
        if (!settle()) return;
        resolve(value);
      };
      const fail = (err: unknown) => {
        if (!settle()) return;
        reject(err);
      };

      promise.then(finish, fail);

      if (wasAborted) {
        fail(abortError(at, handle?.stderr ?? ''));
        return;
      }
      waiter = () => {
        fail(abortError(at, handle?.stderr ?? ''));
      };
      abortWaiters.push(waiter);
    });
  };

  const getStderr = () => boundStderr(handle?.stderr ?? '');

  // Establish connection and run initialize/auth before returning the handle.
  // The SDK connectWith callback must stay alive for the connection lifetime.
  let resolveReady!: (ctx: AgentCtx) => void;
  let rejectReady!: (err: unknown) => void;
  const readyPromise = new Promise<AgentCtx>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((res) => {
    resolveClosed = res;
  });

  try {
    throwIfAborted('spawn');
    handle = attachProcess(options.command, options.args, options.cwd, options.env, spawnFn);

    if (!handle.proc.stdin || !handle.proc.stdout) {
      throw new GrokAcpClientError(
        'spawn',
        'Grok ACP child process is missing stdin/stdout pipes',
        getStderr()
      );
    }

    throwIfAborted('spawn');
    const stream = childToNdJsonStream(handle.proc);

    void client({ name: 'pi-agents' })
      .onRequest(methods.client.session.requestPermission, (ctx) =>
        selectPermissionOutcome(ctx.params, wasAborted)
      )
      .onNotification(methods.client.session.update, (ctx) => {
        const notification = ctx.params;
        // During load, only accept updates whose sessionId matches the requested id.
        if (phase === 'load' && loadSessionFilter) {
          const sid = notification.sessionId;
          if (sid !== loadSessionFilter) return;
        }
        options.onSessionUpdate?.(notification, phase);
      })
      .connectWith(stream, async (ctx) => {
        agentCtx = ctx as unknown as AgentCtx;
        try {
          stage = 'initialize';
          const init = (await raceStage(
            withTimeout(
              ctx.request(methods.agent.initialize, options.initializeParams),
              stageTimeoutMs,
              'initialize',
              getStderr
            ),
            'initialize'
          )) as InitializeResponse;
          throwIfAborted('initialize');

          if (init.protocolVersion !== GROK_ACP_PROTOCOL_VERSION) {
            throw new GrokAcpClientError(
              'initialize',
              `Unsupported ACP protocol version: ${init.protocolVersion} (expected ${GROK_ACP_PROTOCOL_VERSION})`,
              getStderr()
            );
          }

          initResponse = init;

          stage = 'authenticate';
          throwIfAborted('authenticate');
          const methodId = selectAuth(init, options.env);
          if (methodId) {
            await raceStage(
              withTimeout(
                ctx.request(methods.agent.authenticate, buildGrokAcpAuthenticateParams(methodId)),
                stageTimeoutMs,
                'authenticate',
                getStderr
              ),
              'authenticate'
            );
            throwIfAborted('authenticate');
          }

          resolveReady(agentCtx);
          // Keep the connectWith callback alive until dispose closes the process.
          await closedPromise;
        } catch (err) {
          rejectReady(err);
          throw err;
        }
      })
      .catch((err) => {
        rejectReady(err);
      });

    agentCtx = await readyPromise;
  } catch (err) {
    if (handle) {
      await cleanupProcess(handle, { alreadyTermed: handle.termSent });
    }
    if (options.signal) {
      options.signal.removeEventListener('abort', onAbort);
    }
    if (wasAborted) throw abortError(stage, handle?.stderr ?? '');
    if (err instanceof GrokAcpClientError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new GrokAcpClientError(
      stage,
      `Grok ACP ${stage} failed: ${message}`,
      boundStderr(handle?.stderr ?? '')
    );
  }

  const connection: GrokAcpConnection = {
    get sessionId() {
      return sessionId;
    },
    get phase() {
      return phase;
    },
    get stderr() {
      return getStderr();
    },
    get wasAborted() {
      return wasAborted;
    },
    getExitCode() {
      return handle?.exitCode ?? null;
    },

    async newSession(params, onSessionEstablished) {
      throwIfAborted('session');
      if (!agentCtx) throw new GrokAcpClientError('session', 'No agent context', getStderr());
      stage = 'session';
      phase = 'idle';
      const session = (await raceStage(
        withTimeout(
          agentCtx.request(methods.agent.session.new, params),
          stageTimeoutMs,
          'session',
          getStderr
        ),
        'session'
      )) as { sessionId?: string };
      const id = typeof session.sessionId === 'string' ? session.sessionId.trim() : '';
      if (!id) {
        throw new GrokAcpClientError(
          'session',
          'session/new returned an empty sessionId',
          getStderr()
        );
      }
      sessionId = id;
      throwIfAborted('session');
      if (onSessionEstablished) {
        await onSessionEstablished(id);
      }
      throwIfAborted('session');
      phase = 'idle';
      return id;
    },

    async loadSession(params) {
      throwIfAborted('load');
      if (!agentCtx) throw new GrokAcpClientError('load', 'No agent context', getStderr());
      if (initResponse?.agentCapabilities?.loadSession !== true) {
        throw new GrokAcpClientError(
          'load',
          'Grok ACP agent does not advertise agentCapabilities.loadSession',
          getStderr(),
          'acp_load_unsupported'
        );
      }
      const requestedId = params.sessionId?.trim?.()
        ? params.sessionId.trim()
        : String(params.sessionId ?? '').trim();
      if (!requestedId) {
        throw new GrokAcpClientError(
          'load',
          'session/load requires a non-empty sessionId',
          getStderr()
        );
      }
      stage = 'load';
      phase = 'load';
      loadSessionFilter = requestedId;
      sessionId = requestedId;
      try {
        const response = (await raceStage(
          withTimeout(
            agentCtx.request(methods.agent.session.load, params),
            stageTimeoutMs,
            'load',
            getStderr
          ),
          'load'
        )) as LoadSessionResponse;
        // Load response is the replay-complete barrier.
        phase = 'idle';
        loadSessionFilter = null;
        return response ?? {};
      } catch (err) {
        phase = 'idle';
        loadSessionFilter = null;
        if (err instanceof GrokAcpClientError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw classifyLoadError(message, getStderr());
      }
    },

    prompt(taskOrParams) {
      if (promptInFlight) {
        throw new GrokAcpClientError(
          'prompt',
          'A Grok ACP prompt is already in flight',
          getStderr()
        );
      }
      if (!agentCtx) {
        throw new GrokAcpClientError('prompt', 'No agent context', getStderr());
      }
      throwIfAborted('prompt');
      if (wasAborted) {
        throw abortError('prompt', getStderr());
      }

      const task = typeof taskOrParams === 'string' ? taskOrParams : taskOrParams.task;
      const sid =
        typeof taskOrParams === 'string' ? sessionId : taskOrParams.sessionId?.trim() || sessionId;
      if (!sid) {
        throw new GrokAcpClientError('prompt', 'Cannot prompt without a session id', getStderr());
      }

      stage = 'prompt';
      phase = 'prompt';
      promptInFlight = true;
      cancelSent = false;

      let resolveAccepted!: () => void;
      let rejectAccepted!: (err: unknown) => void;
      const accepted = new Promise<void>((res, rej) => {
        resolveAccepted = res;
        rejectAccepted = rej;
      });

      // Session-continuation prompts are full instruction text; bare tasks get `Task: `.
      const isContinuation =
        task.startsWith('You are resuming an interrupted task') ||
        task.startsWith('Task: You are resuming an interrupted task');
      const requestParams = isContinuation
        ? {
            sessionId: sid,
            prompt: [
              {
                type: 'text' as const,
                text: task.startsWith('Task: ') ? task.slice('Task: '.length) : task,
              },
            ],
          }
        : buildGrokAcpPromptParams(
            sid,
            task.startsWith('Task: ') ? task.slice('Task: '.length) : task
          );

      const promptPromise = withTimeout(
        agentCtx!.request(methods.agent.session.prompt, requestParams) as Promise<PromptResponse>,
        promptTimeoutMs,
        'prompt',
        getStderr
      );
      // Avoid unhandled rejection if grace wins the race and prompt later fails.
      void promptPromise.catch(() => {});

      // Dispatch acceptance: the request is registered with the SDK once we return.
      queueMicrotask(() => {
        if (wasAborted) {
          rejectAccepted(abortError('prompt', getStderr()));
          return;
        }
        resolveAccepted();
      });

      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      let resolveGrace: ((value: GrokAcpPromptCompletion) => void) | undefined;
      const gracePromise = new Promise<GrokAcpPromptCompletion>((resolve) => {
        resolveGrace = resolve;
      });

      const armGrace = () => {
        if (graceTimer) return;
        graceTimer = setTimeout(() => {
          // Local grace settlement — not a matching session/prompt response.
          resolveGrace?.({
            source: 'cancel_grace',
            response: { stopReason: 'cancelled' },
          });
        }, cancelGraceMs);
      };

      onAbortDuringPrompt = () => {
        armGrace();
      };

      if (wasAborted) {
        void sendCancel();
        armGrace();
      }

      const completed = (async (): Promise<GrokAcpPromptCompletion> => {
        try {
          // Real matching response vs local cancel-grace settlement — callers
          // must only confirm delivery for source === 'response'.
          return await Promise.race([
            promptPromise.then((response): GrokAcpPromptCompletion => ({
              source: 'response',
              response,
            })),
            gracePromise,
          ]);
        } finally {
          onAbortDuringPrompt = undefined;
          if (graceTimer) clearTimeout(graceTimer);
          promptInFlight = false;
          phase = 'idle';
        }
      })();

      return { accepted, completed };
    },

    async cancel() {
      await sendCancel();
      onAbortDuringPrompt?.();
    },

    async dispose() {
      // Sticky dispose: if a prior dispose failed, always rethrow dispose_failed.
      if (handle?.disposeError) {
        throw handle.disposeError;
      }
      if (handle?.disposePromise) {
        return handle.disposePromise;
      }
      if (disposed && !handle) {
        return 0;
      }
      disposed = true;
      stage = 'shutdown';
      resolveClosed();
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
      if (!handle) return 0;
      return cleanupProcess(handle, { alreadyTermed: handle.termSent });
    },
  };

  return connection;
}

/**
 * Drive one Grok ACP process through initialize → authenticate → session/new →
 * session/prompt, mapping session updates through the provided callback.
 * Compatibility facade for non-interactive one-shot calls.
 */
export async function runGrokAcpClient(
  options: GrokAcpClientOptions
): Promise<GrokAcpClientResult> {
  const connection = await openGrokAcpConnection({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    spawnFn: options.spawnFn,
    signal: options.signal,
    initializeParams: options.initializeParams,
    stageTimeoutMs: options.stageTimeoutMs,
    promptTimeoutMs: options.promptTimeoutMs,
    cancelGraceMs: options.cancelGraceMs,
    selectAuthMethod: options.selectAuthMethod,
    onSessionUpdate: (notification, phase) => {
      // One-shot facade only surfaces prompt-phase (and idle) updates to the parser.
      // session/new has no load phase here.
      if (phase === 'load') return;
      options.onSessionUpdate?.(notification);
    },
  });

  try {
    await connection.newSession(options.sessionNewParams, options.onSessionEstablished);
    if (connection.wasAborted) {
      throw abortError('session', connection.stderr);
    }
    const dispatch = connection.prompt(options.task);
    await dispatch.accepted;
    const completion = await dispatch.completed;
    let exitCode: number;
    try {
      exitCode = await connection.dispose();
    } catch (disposeErr) {
      // Dispose uncertainty must surface — never swallow dispose_failed.
      if (disposeErr instanceof GrokAcpClientError && disposeErr.code === 'dispose_failed') {
        throw disposeErr;
      }
      throw disposeErr;
    }
    return {
      promptResponse: completion.response,
      /** True only for a real matching prompt response (not local cancel grace). */
      promptCompletionSource: completion.source,
      stderr: connection.stderr,
      exitCode: exitCode === 0 ? 0 : exitCode,
      wasAborted: connection.wasAborted || completion.source === 'cancel_grace',
      sessionId: connection.sessionId,
    };
  } catch (err) {
    let disposeError: GrokAcpClientError | undefined;
    try {
      await connection.dispose();
    } catch (disposeErr) {
      if (disposeErr instanceof GrokAcpClientError && disposeErr.code === 'dispose_failed') {
        disposeError = disposeErr;
      } else if (disposeErr instanceof GrokAcpClientError) {
        disposeError = disposeErr;
      } else {
        disposeError = new GrokAcpClientError(
          'shutdown',
          disposeErr instanceof Error ? disposeErr.message : String(disposeErr),
          connection.stderr,
          'dispose_failed'
        );
      }
    }
    // Prefer sticky dispose failure over a prior business error (fail-closed lease).
    if (disposeError?.code === 'dispose_failed') throw disposeError;
    if (connection.wasAborted || (err instanceof GrokAcpClientError && err.code === 'aborted')) {
      throw abortError(err instanceof GrokAcpClientError ? err.stage : 'prompt', connection.stderr);
    }
    if (err instanceof GrokAcpClientError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new GrokAcpClientError('prompt', `Grok ACP failed: ${message}`, connection.stderr);
  }
}

/** Default Node spawn used when callers do not inject a spawnFn. */
export function defaultGrokAcpSpawn(
  command: string,
  args: string[],
  options: object
): GrokAcpSpawnedChild {
  return spawn(command, args, options) as unknown as GrokAcpSpawnedChild;
}
