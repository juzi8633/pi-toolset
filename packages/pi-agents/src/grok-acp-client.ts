// ABOUTME: Grok ACP client adapter — Node child streams to SDK ndJsonStream and lifecycle.
// ABOUTME: Owns initialize/auth/session/prompt, permission handling, cancel, and process cleanup.

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
  | 'spawn'
  | 'initialize'
  | 'authenticate'
  | 'session'
  | 'prompt'
  | 'shutdown';

const DEFAULT_STAGE_TIMEOUT_MS = 60_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_CANCEL_GRACE_MS = 2_000;
const HARD_KILL_MS = 5_000;
const MAX_STDERR_CHARS = 16 * 1024;

export class GrokAcpClientError extends Error {
  readonly stage: GrokAcpLifecycleStage;
  readonly stderr: string;

  constructor(stage: GrokAcpLifecycleStage, message: string, stderr = '') {
    super(message);
    this.name = 'GrokAcpClientError';
    this.stage = stage;
    this.stderr = stderr;
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
  stageTimeoutMs?: number;
  promptTimeoutMs?: number;
  cancelGraceMs?: number;
  /** Test seam: override auth selection. */
  selectAuthMethod?: (init: InitializeResponse, env: NodeJS.ProcessEnv) => string | null;
}

export interface GrokAcpClientResult {
  promptResponse: PromptResponse;
  stderr: string;
  exitCode: number;
  wasAborted: boolean;
  sessionId: string;
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
  if (handle.cleaned) {
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
    try {
      handle.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await handle.exitPromise;
  }

  return handle.exitCode ?? 1;
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
  return new GrokAcpClientError(stage, 'Subagent was aborted', boundStderr(stderr));
}

/**
 * Drive one Grok ACP process through initialize → authenticate → session/new →
 * session/prompt, mapping session updates through the provided callback.
 */
export async function runGrokAcpClient(
  options: GrokAcpClientOptions
): Promise<GrokAcpClientResult> {
  const stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  const promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  const cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const spawnFn = options.spawnFn ?? (spawn as unknown as GrokAcpSpawnFn);
  const selectAuth = options.selectAuthMethod ?? selectGrokAcpAuthMethod;

  let stage: GrokAcpLifecycleStage = 'spawn';
  let wasAborted = false;
  let sessionId: string | undefined;
  let cancelSent = false;
  let handle: ProcessHandle | undefined;
  let agentCtx: { notify: (method: string, params?: unknown) => Promise<void> } | undefined;
  /** Optional hook armed only while a prompt is in flight (cancel grace). */
  let onAbortDuringPrompt: (() => void) | undefined;
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

  /** Race a stage promise against abort so hanging initialize/auth/session exit promptly. */
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

  try {
    throwIfAborted('spawn');

    handle = attachProcess(options.command, options.args, options.cwd, options.env, spawnFn);

    if (!handle.proc.stdin || !handle.proc.stdout) {
      throw new GrokAcpClientError(
        'spawn',
        'Grok ACP child process is missing stdin/stdout pipes',
        boundStderr(handle.stderr)
      );
    }

    throwIfAborted('spawn');

    const stream = childToNdJsonStream(handle.proc);
    let promptResponse: PromptResponse | undefined;

    await client({ name: 'pi-agents' })
      .onRequest(methods.client.session.requestPermission, (ctx) =>
        selectPermissionOutcome(ctx.params, wasAborted)
      )
      .onNotification(methods.client.session.update, (ctx) => {
        options.onSessionUpdate?.(ctx.params);
      })
      .connectWith(stream, async (ctx) => {
        agentCtx = ctx;

        stage = 'initialize';
        const init = await raceStage(
          withTimeout(
            ctx.request(methods.agent.initialize, options.initializeParams),
            stageTimeoutMs,
            'initialize',
            () => handle?.stderr ?? ''
          ),
          'initialize'
        );
        throwIfAborted('initialize');

        if (init.protocolVersion !== GROK_ACP_PROTOCOL_VERSION) {
          throw new GrokAcpClientError(
            'initialize',
            `Unsupported ACP protocol version: ${init.protocolVersion} (expected ${GROK_ACP_PROTOCOL_VERSION})`,
            boundStderr(handle?.stderr ?? '')
          );
        }

        // Auth method selection failures are authenticate-stage errors.
        stage = 'authenticate';
        throwIfAborted('authenticate');
        const methodId = selectAuth(init, options.env);
        if (methodId) {
          await raceStage(
            withTimeout(
              ctx.request(methods.agent.authenticate, buildGrokAcpAuthenticateParams(methodId)),
              stageTimeoutMs,
              'authenticate',
              () => handle?.stderr ?? ''
            ),
            'authenticate'
          );
          throwIfAborted('authenticate');
        }

        stage = 'session';
        const session = await raceStage(
          withTimeout(
            ctx.request(methods.agent.session.new, options.sessionNewParams),
            stageTimeoutMs,
            'session',
            () => handle?.stderr ?? ''
          ),
          'session'
        );
        sessionId = session.sessionId;
        throwIfAborted('session');

        // Never start session/prompt after cancellation.
        if (wasAborted) {
          await sendCancel();
          throw abortError('session', handle?.stderr ?? '');
        }

        stage = 'prompt';
        const promptParams = buildGrokAcpPromptParams(session.sessionId, options.task);
        const promptPromise = withTimeout(
          ctx.request(methods.agent.session.prompt, promptParams),
          promptTimeoutMs,
          'prompt',
          () => handle?.stderr ?? ''
        );
        // Avoid unhandled rejection if grace wins the race and prompt later fails.
        void promptPromise.catch(() => {});

        // Race the real prompt response against abort+grace so a hanging agent
        // still terminates after session/cancel + cancelGraceMs.
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        let resolveGrace: ((value: PromptResponse) => void) | undefined;
        const gracePromise = new Promise<PromptResponse>((resolve) => {
          resolveGrace = resolve;
        });

        const armGrace = () => {
          if (graceTimer) return;
          // Grace must not wait for sendCancel to resolve — arm immediately.
          graceTimer = setTimeout(() => {
            resolveGrace?.({ stopReason: 'cancelled' });
          }, cancelGraceMs);
        };

        onAbortDuringPrompt = () => {
          // sendCancel already fired from onAbort; only arm grace here.
          armGrace();
        };

        if (wasAborted) {
          // Abort raced in after the pre-prompt check; cancel + grace, no extra prompt.
          void sendCancel();
          armGrace();
        }

        try {
          promptResponse = await Promise.race([promptPromise, gracePromise]);
        } finally {
          onAbortDuringPrompt = undefined;
          if (graceTimer) clearTimeout(graceTimer);
        }
      });

    if (!promptResponse) {
      throw new GrokAcpClientError(
        stage,
        'Grok ACP prompt completed without a response',
        boundStderr(handle.stderr)
      );
    }

    stage = 'shutdown';
    // After cancel grace (or normal completion), SIGTERM then SIGKILL after HARD_KILL_MS.
    // wasAborted alone must not skip SIGTERM — only a real prior kill does.
    const exitCode = await cleanupProcess(handle);

    return {
      promptResponse,
      stderr: boundStderr(handle.stderr),
      exitCode: exitCode === 0 ? 0 : exitCode,
      wasAborted,
      sessionId: sessionId ?? '',
    };
  } catch (err) {
    if (handle) {
      await cleanupProcess(handle, { alreadyTermed: handle.termSent });
    }

    // Surface abort as a tagged client error so the orchestration layer can
    // throw the public "Subagent was aborted" error consistently.
    if (wasAborted) {
      throw abortError(stage, handle?.stderr ?? '');
    }

    if (err instanceof GrokAcpClientError) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    throw new GrokAcpClientError(
      stage,
      `Grok ACP ${stage} failed: ${message}`,
      boundStderr(handle?.stderr ?? '')
    );
  } finally {
    if (options.signal) {
      options.signal.removeEventListener('abort', onAbort);
    }
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
