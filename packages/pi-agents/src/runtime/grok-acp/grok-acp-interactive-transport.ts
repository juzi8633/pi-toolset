// ABOUTME: Long-lived Grok ACP interactive transport implementing new/load/prompt/cancel/dispose.
// ABOUTME: Projects ACP updates into normalized registry events; no steer/follow-up support.

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentConfig } from '../../config/agents.ts';
import {
  openGrokAcpConnection,
  type GrokAcpConnection,
  type GrokAcpSpawnFn,
  GrokAcpClientError,
} from './grok-acp-client.ts';
import {
  buildGrokAcpArgs,
  buildGrokAcpEnv,
  buildGrokAcpInitializeParams,
  buildGrokAcpSessionLoadParams,
  buildGrokAcpSessionNewParams,
} from './grok-acp-invocation.ts';
import { mapGrokAcpStopReason } from './grok-acp-parser.ts';
import { createGrokAcpTranscriptProjector } from './grok-acp-transcript.ts';
import { getGrokInvocation } from './grok-command.ts';
import type {
  InteractiveAgentTransport,
  InteractiveTransportEvent,
  InteractiveTransportState,
} from '../../interactive/interactive-transport.ts';
import { emptyUsage } from '../../shared/empty-usage.ts';
import type { UsageStats } from '../../shared/types.ts';
import { buildChildAgentEnv } from '../../execution/security.ts';

export interface GrokAcpInteractiveTransportOptions {
  agent: AgentConfig;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: GrokAcpSpawnFn;
  signal?: AbortSignal;
  /** When set, open with session/load instead of session/new. */
  sessionId?: string;
  /** Hydrate-only: load then leave idle without keep-alive prompts until prompt(). */
  hydrateOnly?: boolean;
  /** Called after session/new returns a non-empty ID (before any prompt). */
  onSessionEstablished?: (sessionId: string) => void | Promise<void>;
  /** Called when load replay completes (after load barrier). */
  onLoadComplete?: (messages: AgentMessage[]) => void | Promise<void>;
  stageTimeoutMs?: number;
  promptTimeoutMs?: number;
  cancelGraceMs?: number;
  configuredModel?: string;
}

/**
 * Create a long-lived Grok ACP transport. Callers must await `start()` before prompt.
 */
export class GrokAcpInteractiveTransport implements InteractiveAgentTransport {
  readonly runtime = 'grok-acp' as const;
  readonly runningInput = 'unsupported' as const;

  private connection: GrokAcpConnection | null = null;
  private disposed = false;
  private starting = false;
  private running = false;
  private sessionId = '';
  private readonly listeners = new Set<(event: InteractiveTransportEvent) => void>();
  private readonly projector;
  private lastUsage: UsageStats = emptyUsage();
  private lastModel: string | undefined;
  private lastError: string | undefined;
  /** Serializes full turn completion work after dispatch acceptance. */
  private promptChain: Promise<void> = Promise.resolve();
  private abortCoalesce: Promise<void> | null = null;
  private emittedMessageCount = 0;
  /** Shared dispose promise — true idempotence; sticky on dispose_failed. */
  private disposePromise: Promise<void> | null = null;
  private disposeError: Error | null = null;

  constructor(private readonly options: GrokAcpInteractiveTransportOptions) {
    this.projector = createGrokAcpTranscriptProjector({
      configuredModel: options.configuredModel ?? options.agent.model,
    });
    this.sessionId = options.sessionId?.trim() ?? '';
    this.lastModel = options.configuredModel ?? options.agent.model;
  }

  subscribe(listener: (event: InteractiveTransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: InteractiveTransportEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* listener errors must not break the transport */
      }
    }
  }

  private emitNewFinalizedMessages(): void {
    const all = this.projector.getFinalizedMessages();
    for (const msg of all.slice(this.emittedMessageCount)) {
      this.emit({ type: 'message_end', message: msg });
    }
    this.emittedMessageCount = all.length;
  }

  private projectLiveUpdate(): void {
    const streaming = this.projector.streamingMessage;
    if (streaming) {
      this.emit({ type: 'message_update', message: streaming });
    }
    for (const tool of this.projector.activeTools.values()) {
      if (tool.ended) {
        this.emit({
          type: 'tool_execution_end',
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          result: tool.partialResult,
          isError: tool.isError,
        });
      } else {
        this.emit({
          type: 'tool_execution_start',
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          args: tool.args,
        });
        if (tool.partialResult !== undefined) {
          this.emit({
            type: 'tool_execution_update',
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            args: tool.args,
            partialResult: tool.partialResult,
          });
        }
      }
    }
    this.emitNewFinalizedMessages();
  }

  /**
   * Spawn, initialize, authenticate, and either create or load a session.
   * For load mode, replays history through the projector and emits message_end events.
   */
  async start(): Promise<void> {
    if (this.disposed) throw new Error('Transport is disposed');
    if (this.connection) return;
    if (this.starting) {
      while (this.starting && !this.connection && !this.disposed) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return;
    }
    this.starting = true;
    try {
      const agent = this.options.agent;
      const effectiveAgent: AgentConfig = {
        ...agent,
        model: this.options.configuredModel ?? agent.model,
      };
      const childEnv = buildGrokAcpEnv(
        buildChildAgentEnv(this.options.env ?? process.env, { agent: effectiveAgent })
      );
      const args = buildGrokAcpArgs(effectiveAgent);
      const invocation = getGrokInvocation(args);

      this.connection = await openGrokAcpConnection({
        command: invocation.command,
        args: invocation.args,
        cwd: this.options.cwd,
        env: childEnv,
        spawnFn: this.options.spawnFn,
        signal: this.options.signal,
        initializeParams: buildGrokAcpInitializeParams(),
        stageTimeoutMs: this.options.stageTimeoutMs,
        promptTimeoutMs: this.options.promptTimeoutMs,
        cancelGraceMs: this.options.cancelGraceMs,
        onSessionUpdate: (notification, phase) => {
          this.projector.handleSessionUpdate(notification, phase);
          if (phase === 'prompt') {
            this.projectLiveUpdate();
          }
        },
      });

      if (this.sessionId) {
        const loadParams = buildGrokAcpSessionLoadParams(this.sessionId, this.options.cwd);
        await this.connection.loadSession(loadParams);
        const finalized = this.projector.finalizeLoadBarrier();
        if (!this.projector.hasUserHistory) {
          throw new GrokAcpClientError(
            'load',
            'Loaded ACP session has no replayed user history (acp_session_history_empty)',
            this.connection.stderr,
            'acp_session_history_empty'
          );
        }
        for (const msg of finalized) {
          this.emit({ type: 'message_end', message: msg });
        }
        this.emittedMessageCount = finalized.length;
        await this.options.onLoadComplete?.(finalized);
      } else {
        const newParams = buildGrokAcpSessionNewParams(this.options.cwd, effectiveAgent);
        const id = await this.connection.newSession(newParams, this.options.onSessionEstablished);
        this.sessionId = id;
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      let disposeError: Error | undefined;
      try {
        await this.dispose();
      } catch (disposeErr) {
        disposeError = disposeErr instanceof Error ? disposeErr : new Error(String(disposeErr));
      }
      // Dispose uncertainty is sticky and must not be swallowed.
      if (disposeError) throw disposeError;
      throw err;
    } finally {
      this.starting = false;
    }
  }

  getSessionId(): string {
    return this.sessionId || this.connection?.sessionId || '';
  }

  getFinalizedMessages(): AgentMessage[] {
    return this.projector.getFinalizedMessages();
  }

  /**
   * Dispatch a prompt. Resolves at SDK dispatch acceptance (request registered),
   * not at turn completion. Completion is reported via `prompt_completed` then
   * `agent_settled` on the background serial chain.
   */
  async prompt(message: string): Promise<void> {
    if (this.disposed) throw new Error('Transport is disposed');
    if (!this.connection) {
      await this.start();
    }
    if (!this.connection) throw new Error('Failed to open Grok ACP connection');

    // Serialize start of each turn after prior turns settle (or fail).
    await this.promptChain.catch(() => undefined);

    if (this.disposed || !this.connection) throw new Error('Transport is disposed');
    this.running = true;
    this.emit({ type: 'agent_start' });
    this.emit({ type: 'turn_start' });

    const dispatch = this.connection.prompt(message);
    await dispatch.accepted;

    // Background: await response, emit completion + settled, free the chain.
    const completion = (async () => {
      try {
        const settled = await dispatch.completed;
        const response = settled.response;

        // Cancel grace is local settlement only — never emit prompt_completed
        // (delivery depends on a real matching prompt response).
        if (settled.source === 'cancel_grace') {
          this.projector.finalizePromptResponse({
            stopReason: 'cancelled',
            meta: undefined,
          });
          this.emitNewFinalizedMessages();
          this.lastError = this.lastError ?? 'Prompt cancelled (cancel grace)';
          this.emit({ type: 'turn_end' });
          this.emit({ type: 'agent_settled' });
          return;
        }

        this.projector.finalizePromptResponse({
          stopReason: response.stopReason,
          meta: response._meta as Record<string, unknown> | null | undefined,
        });
        this.emitNewFinalizedMessages();

        const mapped = mapGrokAcpStopReason(String(response.stopReason ?? ''), {
          wasAborted: false,
        });
        // Prefer projector formal stop reason (end/max_turns/error/aborted).
        const formalStop = this.projector.usage.stopReason ?? mapped.stopReason;
        const meta = (response._meta ?? {}) as Record<string, unknown>;
        // Merge full projector usage (cache/cost) with response meta tokens.
        const proj = this.projector.usage.usage;
        const usage = emptyUsage();
        usage.input = typeof meta.inputTokens === 'number' ? meta.inputTokens : proj.input;
        usage.output = typeof meta.outputTokens === 'number' ? meta.outputTokens : proj.output;
        usage.cacheRead = proj.cacheRead;
        usage.cacheWrite = proj.cacheWrite;
        usage.cost = proj.cost;
        usage.contextTokens =
          typeof meta.totalTokens === 'number' ? meta.totalTokens : proj.contextTokens;
        usage.turns = proj.turns;
        this.lastUsage = usage;
        this.lastModel =
          (typeof meta.modelId === 'string' && meta.modelId) ||
          this.projector.usage.model ||
          this.options.configuredModel ||
          this.options.agent.model;

        if (mapped.errorMessage) {
          this.lastError = mapped.errorMessage;
        }

        this.emit({
          type: 'prompt_completed',
          // Formal SingleResult stop reason — not raw ACP vocabulary.
          stopReason: formalStop,
          usage,
          model: this.lastModel,
          responseMeta: meta,
          errorMessage: mapped.errorMessage,
        });
        this.emit({ type: 'turn_end' });
        this.emit({ type: 'agent_settled' });
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        // Preserve structured GrokAcpClientError.code (never blanket transport_error).
        const code =
          err instanceof GrokAcpClientError && err.code
            ? err.code
            : err &&
                typeof err === 'object' &&
                'code' in err &&
                typeof (err as { code?: unknown }).code === 'string'
              ? (err as { code: string }).code
              : 'transport_error';
        // Structured failure before settle so registry marks terminal failed and
        // does not treat the activation as a successful prompt completion.
        this.emit({
          type: 'prompt_failed',
          error: this.lastError,
          code,
        });
        this.emit({ type: 'agent_settled' });
        throw err;
      } finally {
        this.running = false;
      }
    })();

    this.promptChain = completion.then(
      () => undefined,
      () => undefined
    );

    // prompt() resolves at acceptance; completion continues on promptChain.
    void completion.catch(() => undefined);
  }

  async abort(): Promise<void> {
    if (this.abortCoalesce) return this.abortCoalesce;
    this.abortCoalesce = (async () => {
      try {
        await this.connection?.cancel();
      } finally {
        await new Promise((r) => setTimeout(r, 0));
        this.abortCoalesce = null;
      }
    })();
    return this.abortCoalesce;
  }

  async getState(): Promise<InteractiveTransportState> {
    return {
      running: this.running || this.starting,
      idle: !this.running && !this.starting && !!this.connection && !this.disposed,
      disposed: this.disposed,
      messageCount: this.projector.messages.length,
      model: this.lastModel,
      usage: this.lastUsage,
      lastError: this.lastError,
    };
  }

  async dispose(): Promise<void> {
    // Sticky: once dispose failed, every later call rethrows dispose_failed.
    if (this.disposeError) throw this.disposeError;
    if (this.disposePromise) return this.disposePromise;

    this.disposePromise = (async () => {
      this.disposed = true;
      this.running = false;
      const conn = this.connection;
      this.connection = null;
      if (!conn) return;
      try {
        await conn.dispose();
      } catch (err) {
        const wrapped =
          err instanceof GrokAcpClientError && err.code === 'dispose_failed'
            ? err
            : new GrokAcpClientError(
                'shutdown',
                err instanceof Error ? err.message : String(err),
                conn.stderr,
                'dispose_failed'
              );
        this.disposeError = wrapped;
        throw wrapped;
      }
    })();

    try {
      await this.disposePromise;
    } catch (err) {
      if (!this.disposeError) {
        this.disposeError = err instanceof Error ? err : new Error(String(err));
      }
      throw this.disposeError;
    }
  }

  getStderr(): string {
    return this.connection?.stderr ?? '';
  }
}

/** Factory helper used by the interactive registry. */
export async function createGrokAcpInteractiveTransport(
  options: GrokAcpInteractiveTransportOptions
): Promise<GrokAcpInteractiveTransport> {
  const transport = new GrokAcpInteractiveTransport(options);
  await transport.start();
  return transport;
}
