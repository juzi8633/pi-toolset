// ABOUTME: Strict JSONL Pi RPC transport with injected spawn, backpressure, and UI cancellation.
// ABOUTME: Correlates typed request/response pairs and fails closed on framing or process errors.

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
} from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { SpawnFn, SpawnedChild } from './execution.ts';

const MAX_STDOUT_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 1 * 1024 * 1024;
const DEFAULT_KILL_TIMEOUT_MS = 5000;
const STDERR_TRUNCATION_MARKER = '[stderr truncated]\n';

/** Synthetic event delivered to subscribers when the child exits unexpectedly. */
export const PI_RPC_TRANSPORT_EXIT = 'pi_rpc_transport_exit' as const;

export interface PiRpcTransportExitEvent {
  type: typeof PI_RPC_TRANSPORT_EXIT;
  intentional: boolean;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error: {
    message: string;
    code: string;
    stderr?: string;
  };
}

export function isPiRpcTransportExitEvent(event: unknown): event is PiRpcTransportExitEvent {
  return (
    !!event &&
    typeof event === 'object' &&
    (event as { type?: unknown }).type === PI_RPC_TRANSPORT_EXIT
  );
}

export type PiRpcEventListener = (event: unknown) => void;

export interface PiRpcTransportOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
  clock?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (id: unknown) => void;
  };
  requestIdGenerator?: () => string;
  killTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class PiRpcTransportError extends Error {
  readonly code: string;
  readonly stderr?: string;

  constructor(code: string, message: string, stderr?: string) {
    super(message);
    this.name = 'PiRpcTransportError';
    this.code = code;
    this.stderr = stderr;
  }
}

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer?: unknown;
}

export class PiRpcTransport {
  private process: SpawnedChild | null = null;
  private readonly listeners = new Set<PiRpcEventListener>();
  private readonly pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private stderrBuf = Buffer.alloc(0);
  private stderrTruncated = false;
  private exitError: Error | null = null;
  private disposed = false;
  private disposing = false;
  private intentionalClose = false;
  private disposePromise: Promise<void> | null = null;
  private stdoutBuffer = '';
  private stdoutByteLength = 0;
  private readonly decoder = new StringDecoder('utf8');
  private readonly options: Required<Pick<PiRpcTransportOptions, 'killTimeoutMs'>> &
    PiRpcTransportOptions;
  private stopStdout: (() => void) | null = null;
  private killTimer: unknown | null = null;
  private exitNotified = false;

  private constructor(options: PiRpcTransportOptions) {
    this.options = {
      killTimeoutMs: DEFAULT_KILL_TIMEOUT_MS,
      ...options,
    };
  }

  static async spawn(options: PiRpcTransportOptions): Promise<PiRpcTransport> {
    const transport = new PiRpcTransport(options);
    await transport.start();
    return transport;
  }

  getStderr(): string {
    const text = this.stderrBuf.toString('utf8');
    return this.stderrTruncated ? STDERR_TRUNCATION_MARKER + text : text;
  }

  /** True after an unexpected process exit/error (not after intentional dispose). */
  get failed(): boolean {
    return !!this.exitError && !this.intentionalClose;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  subscribe(listener: PiRpcEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async request(command: RpcCommand): Promise<RpcResponse> {
    return this.send(command);
  }

  async prompt(message: string, images?: ImageContent[]): Promise<void> {
    const response = await this.send({ type: 'prompt', message, images });
    this.assertSuccess(response);
  }

  async steer(message: string, images?: ImageContent[]): Promise<void> {
    const response = await this.send({ type: 'steer', message, images });
    this.assertSuccess(response);
  }

  async followUp(message: string, images?: ImageContent[]): Promise<void> {
    const response = await this.send({ type: 'follow_up', message, images });
    this.assertSuccess(response);
  }

  async abort(): Promise<void> {
    const response = await this.send({ type: 'abort' });
    this.assertSuccess(response);
  }

  async getState(): Promise<RpcSessionState> {
    const response = await this.send({ type: 'get_state' });
    return this.getData(response) as RpcSessionState;
  }

  async getMessages(): Promise<AgentMessage[]> {
    const response = await this.send({ type: 'get_messages' });
    return (this.getData(response) as { messages: AgentMessage[] }).messages;
  }

  /**
   * Dispose is shareable: concurrent callers await the same in-flight teardown.
   * SIGTERM, then SIGKILL after killTimeoutMs, then wait for child `close`.
   * Never resolves after SIGKILL until `close` confirms the writer is gone.
   * Rejects (fail-closed) when SIGKILL fails or `close` does not arrive within
   * a short hard bound so callers must not spawn a same-session replacement.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.runDispose();
    return this.disposePromise;
  }

  private async runDispose(): Promise<void> {
    if (this.disposed) return;
    this.disposing = true;
    this.intentionalClose = true;
    const child = this.process;
    if (!child) {
      this.disposed = true;
      this.disposing = false;
      this.listeners.clear();
      return;
    }

    this.stopStdout?.();
    this.stopStdout = null;

    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore — escalate via timeout */
    }

    const clock = this.options.clock ?? {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
    const clearKillTimer = () => {
      if (this.killTimer != null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        clock.clearTimeout(this.killTimer as any);
        this.killTimer = null;
      }
    };

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearKillTimer();
          resolve();
        };
        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          clearKillTimer();
          reject(new PiRpcTransportError('dispose_failed', message, this.getStderr()));
        };
        child.once('close', done);
        // Process may already have exited before dispose began.
        if (child.exitCode !== null && child.exitCode !== undefined) {
          done();
          return;
        }
        // Soft wait for SIGTERM, then escalate to SIGKILL and wait for close.
        this.killTimer = clock.setTimeout(() => {
          let killOk = true;
          try {
            const result = child.kill('SIGKILL');
            // Node returns false when the kill signal could not be delivered.
            if (result === false) killOk = false;
          } catch (err) {
            killOk = false;
            void err;
          }
          if (!killOk) {
            fail('SIGKILL failed; child may still hold the session writer');
            return;
          }
          // Hard bound: never resolve without close after SIGKILL.
          this.killTimer = clock.setTimeout(() => {
            fail('Process did not close after SIGKILL within hard dispose bound');
          }, this.options.killTimeoutMs);
        }, this.options.killTimeoutMs);
      });
    } catch (err) {
      this.disposing = false;
      // Leave process attached and disposed=false so state stays unclean;
      // disposePromise remains rejected for concurrent waiters / barrier fail-closed.
      throw err;
    }

    this.process = null;
    this.disposed = true;
    this.disposing = false;
    this.listeners.clear();
  }

  private async start(): Promise<void> {
    const spawnFn = this.options.spawnFn ?? defaultSpawn;
    const child = spawnFn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;

    child.stderr.on('data', (chunk: Buffer | string) => {
      this.appendStderr(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });

    this.stopStdout = attachStdoutReader(child.stdout, {
      decoder: this.decoder,
      onLine: (line) => this.handleLine(line),
      onOverflow: () => {
        this.failProtocol('stdout_overflow', 'RPC stdout record exceeded 8 MiB');
      },
      getBuffer: () => this.stdoutBuffer,
      setBuffer: (v, bytes) => {
        this.stdoutBuffer = v;
        this.stdoutByteLength = bytes;
      },
      getByteLength: () => this.stdoutByteLength,
      maxBytes: MAX_STDOUT_RECORD_BYTES,
    });

    child.once('error', (err: Error) => {
      if (this.process !== child) return;
      const error = new PiRpcTransportError(
        'process_error',
        `Agent process error: ${err.message}`,
        this.getStderr()
      );
      this.handleProcessFailure(error, { code: null, signal: null });
    });

    child.once('close', (code, signal) => {
      if (this.process !== child && this.exitNotified) return;
      this.flushDecoder();
      const error =
        this.exitError ??
        new PiRpcTransportError(
          'process_exit',
          `Agent process exited (code=${code} signal=${signal})`,
          this.getStderr()
        );
      this.handleProcessFailure(error, {
        code: typeof code === 'number' ? code : null,
        signal: (signal as NodeJS.Signals | null) ?? null,
      });
      this.process = null;
    });

    const stdin = child.stdin as Writable | null;
    stdin?.on('error', (err: Error) => {
      if (this.process !== child) return;
      const error =
        this.exitError ??
        new PiRpcTransportError(
          'stdin_error',
          `Agent process stdin error: ${err.message}`,
          this.getStderr()
        );
      this.handleProcessFailure(error, { code: null, signal: null });
    });
  }

  private handleProcessFailure(
    error: Error,
    meta: { code: number | null; signal: NodeJS.Signals | null }
  ): void {
    this.exitError = error;
    this.rejectPending(error);
    if (this.exitNotified) return;
    this.exitNotified = true;
    const code =
      error instanceof PiRpcTransportError
        ? error.code
        : this.intentionalClose
          ? 'disposed'
          : 'process_exit';
    const event: PiRpcTransportExitEvent = {
      type: PI_RPC_TRANSPORT_EXIT,
      intentional: this.intentionalClose,
      code: meta.code,
      signal: meta.signal,
      error: {
        message: error.message,
        code,
        stderr: error instanceof PiRpcTransportError ? error.stderr : this.getStderr(),
      },
    };
    // Deliver even for intentional close so waiters can observe completion;
    // registry ignores intentional exits for activation failure.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* ignore */
      }
    }
  }

  private flushDecoder(): void {
    const rest = this.decoder.end();
    if (rest) {
      this.stdoutBuffer += rest;
      this.stdoutByteLength += Buffer.byteLength(rest, 'utf8');
    }
  }

  private appendStderr(chunk: Buffer): void {
    const combined = Buffer.concat([this.stderrBuf, chunk]);
    if (combined.length <= MAX_STDERR_BYTES) {
      this.stderrBuf = combined;
      return;
    }
    this.stderrTruncated = true;
    this.stderrBuf = combined.subarray(combined.length - MAX_STDERR_BYTES);
  }

  private handleLine(line: string): void {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      this.failProtocol('malformed_json', `Malformed RPC JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (!data || typeof data !== 'object') {
      this.failProtocol('malformed_json', 'RPC record is not a JSON object');
      return;
    }

    const record = data as Record<string, unknown>;
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id);
      if (pending) {
        this.pending.delete(record.id);
        if (pending.timer) this.clearTimer(pending.timer);
        pending.resolve(record as RpcResponse);
        return;
      }
    }

    if (record.type === 'extension_ui_request' && typeof record.id === 'string') {
      void this.replyUiRequest(record as unknown as RpcExtensionUIRequest);
    }

    for (const listener of [...this.listeners]) {
      try {
        listener(data);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  private async replyUiRequest(req: RpcExtensionUIRequest): Promise<void> {
    let response: RpcExtensionUIResponse;
    switch (req.method) {
      case 'select':
      case 'input':
      case 'editor':
        response = { type: 'extension_ui_response', id: req.id, cancelled: true };
        break;
      case 'confirm':
        response = { type: 'extension_ui_response', id: req.id, confirmed: false };
        break;
      default:
        // notify / setStatus / setWidget / setTitle / set_editor_text — fire-and-forget diagnostics only
        return;
    }
    try {
      await this.writeRaw(response);
    } catch {
      /* process may already be dead */
    }
  }

  private failProtocol(code: string, message: string): void {
    if (this.exitError) return;
    const error = new PiRpcTransportError(code, message, this.getStderr());
    this.handleProcessFailure(error, { code: null, signal: null });
    // Catch so protocol dispose failures never become unhandled rejections;
    // registry also tracks dispose on the session barrier when it observes exit.
    void this.dispose().catch(() => undefined);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) this.clearTimer(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private nextId(): string {
    if (this.options.requestIdGenerator) return this.options.requestIdGenerator();
    return `req_${++this.requestCounter}`;
  }

  private assertSuccess(response: RpcResponse): void {
    if (!response.success) {
      throw new PiRpcTransportError(
        'rpc_rejected',
        response.error || `RPC command ${response.command} rejected`,
        this.getStderr()
      );
    }
  }

  private getData(response: RpcResponse): unknown {
    this.assertSuccess(response);
    return 'data' in response ? response.data : undefined;
  }

  private async send(command: RpcCommand): Promise<RpcResponse> {
    if (this.disposed || this.disposing) {
      throw new PiRpcTransportError('disposed', 'Transport is disposed', this.getStderr());
    }
    if (this.exitError) throw this.exitError;
    const child = this.process;
    const stdin = child?.stdin as Writable | null | undefined;
    if (!child || !stdin) {
      throw new PiRpcTransportError('not_started', 'Client not started', this.getStderr());
    }
    if (child.exitCode !== null && child.exitCode !== undefined) {
      const error = new PiRpcTransportError(
        'process_exit',
        `Agent process already exited (code=${child.exitCode})`,
        this.getStderr()
      );
      this.exitError = error;
      throw error;
    }
    if (stdin.destroyed || !stdin.writable) {
      throw new PiRpcTransportError(
        'stdin_closed',
        'Agent process stdin is not writable',
        this.getStderr()
      );
    }

    const id = this.nextId();
    const fullCommand = { ...command, id } as RpcCommand & { id: string };

    return new Promise<RpcResponse>((resolve, reject) => {
      const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
      const clock = this.options.clock ?? { setTimeout, clearTimeout };
      const timer =
        timeoutMs > 0
          ? clock.setTimeout(() => {
              this.pending.delete(id);
              reject(
                new PiRpcTransportError(
                  'timeout',
                  `Timeout waiting for response to ${command.type}`,
                  this.getStderr()
                )
              );
            }, timeoutMs)
          : undefined;

      this.pending.set(id, { resolve, reject, timer });

      void this.writeRaw(fullCommand).catch((err) => {
        this.pending.delete(id);
        if (timer) this.clearTimer(timer);
        const writeError =
          err instanceof Error
            ? err
            : new PiRpcTransportError('write_error', String(err), this.getStderr());
        reject(writeError);
      });
    });
  }

  private clearTimer(timer: unknown): void {
    const clock = this.options.clock ?? {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clock.clearTimeout(timer as any);
  }

  private writeRaw(value: unknown): Promise<void> {
    const child = this.process;
    const stdin = child?.stdin as Writable | null | undefined;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return Promise.reject(
        new PiRpcTransportError('stdin_closed', 'stdin is not writable', this.getStderr())
      );
    }
    const line = `${JSON.stringify(value)}\n`;
    return new Promise<void>((resolve, reject) => {
      const ok = stdin.write(line, (err) => {
        if (err) reject(err);
      });
      if (ok) {
        resolve();
        return;
      }
      const onDrain = () => {
        stdin.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        stdin.off('drain', onDrain);
        reject(err);
      };
      stdin.once('drain', onDrain);
      stdin.once('error', onError);
    });
  }
}

function defaultSpawn(command: string, args: string[], options: object): SpawnedChild {
  return spawn(command, args, options) as unknown as SpawnedChild;
}

interface StdoutReaderState {
  decoder: StringDecoder;
  onLine: (line: string) => void;
  onOverflow: () => void;
  getBuffer: () => string;
  setBuffer: (value: string, byteLength: number) => void;
  getByteLength: () => number;
  maxBytes: number;
}

function attachStdoutReader(stream: Readable, state: StdoutReaderState): () => void {
  let failed = false;

  const onData = (chunk: Buffer | string) => {
    if (failed) return;
    const text = typeof chunk === 'string' ? chunk : state.decoder.write(chunk as Buffer);
    let buffer = state.getBuffer() + text;
    let byteLength = state.getByteLength() + Buffer.byteLength(text, 'utf8');

    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      // Byte length of the complete record (before CR strip) — must enforce the
      // 8 MiB limit before JSON.parse; a same-chunk terminated oversized line
      // must not bypass the incomplete-buffer check below.
      const lineBytes = Buffer.byteLength(line, 'utf8');
      buffer = buffer.slice(newlineIndex + 1);
      byteLength = Buffer.byteLength(buffer, 'utf8');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (lineBytes > state.maxBytes) {
        failed = true;
        state.setBuffer('', 0);
        state.onOverflow();
        return;
      }
      state.onLine(line);
    }

    if (byteLength > state.maxBytes) {
      failed = true;
      state.setBuffer('', 0);
      state.onOverflow();
      return;
    }
    state.setBuffer(buffer, byteLength);
  };

  const onEnd = () => {
    if (failed) return;
    const rest = state.decoder.end();
    if (!rest && !state.getBuffer()) return;
    let buffer = state.getBuffer() + rest;
    if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
    if (buffer.length > 0) state.onLine(buffer);
    state.setBuffer('', 0);
  };

  stream.on('data', onData);
  stream.on('end', onEnd);
  return () => {
    stream.off('data', onData);
    stream.off('end', onEnd);
  };
}

/** Exported for tests that need to craft UI responses without a live process. */
export function buildUiCancelResponse(
  req: RpcExtensionUIRequest
): RpcExtensionUIResponse | undefined {
  switch (req.method) {
    case 'select':
    case 'input':
    case 'editor':
      return { type: 'extension_ui_response', id: req.id, cancelled: true };
    case 'confirm':
      return { type: 'extension_ui_response', id: req.id, confirmed: false };
    default:
      return undefined;
  }
}
