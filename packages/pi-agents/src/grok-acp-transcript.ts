// ABOUTME: Projects ACP session/update notifications into complete AgentMessage history.
// ABOUTME: Used for load replay and live Agent View streaming; separate from one-shot SingleResult parsing.

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  SessionNotification,
  SessionUpdate,
  StopReason as AcpStopReason,
} from '@agentclientprotocol/sdk';
import { mapGrokAcpStopReason } from './grok-acp-parser.ts';
import type { UsageStats } from './types.ts';
import { emptyUsage } from './types.ts';

export type GrokAcpTranscriptPhase = 'load' | 'prompt' | 'idle';

export interface GrokAcpTranscriptOptions {
  /** Fallback model when no usage/prompt metadata supplies one. */
  configuredModel?: string;
  /** Finite load-start timestamp used when ACP metadata lacks timestamps. */
  loadStartTimestamp?: number;
  /** Clock for live prompt timestamps; defaults to Date.now. */
  now?: () => number;
}

export interface GrokAcpTranscriptUsage {
  usage: UsageStats;
  model?: string;
  stopReason?: string;
}

export interface GrokAcpTranscriptProjector {
  readonly phase: GrokAcpTranscriptPhase;
  /** Finalized transcript messages (replace wholesale after load barrier). */
  readonly messages: readonly AgentMessage[];
  /** Current streaming assistant draft during live prompt (if any). */
  readonly streamingMessage: AgentMessage | undefined;
  /** Active tools for Agent View while a prompt is running. */
  readonly activeTools: ReadonlyMap<
    string,
    {
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult?: unknown;
      isError?: boolean;
      ended?: boolean;
    }
  >;
  readonly usage: GrokAcpTranscriptUsage;
  /** True when at least one user message was finalized during load/prompt. */
  readonly hasUserHistory: boolean;
  handleSessionUpdate(notification: SessionNotification, phase: GrokAcpTranscriptPhase): void;
  /** Flush drafts and mark non-terminal tools unconfirmed at the load barrier. */
  finalizeLoadBarrier(): AgentMessage[];
  /** Attach prompt response model/usage/stopReason to the final live assistant. */
  finalizePromptResponse(input: {
    stopReason: AcpStopReason | string;
    meta?: Record<string, unknown> | null;
    model?: string;
  }): void;
  /** Replace finalized messages (used when replaying a complete load). */
  replaceMessages(messages: AgentMessage[]): void;
  getFinalizedMessages(): AgentMessage[];
}

type AssistantContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };

type AssistantDraft = {
  role: 'assistant';
  content: AssistantContentPart[];
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  timestamp: number;
  messageId?: string;
  /** When reopening a non-contiguous messageId, flush back into this slot. */
  slotIndex?: number;
};

type UserDraft = {
  role: 'user';
  content: string;
  timestamp: number;
  messageId?: string;
};

type ToolState = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  title?: string;
  kind?: string;
  locations?: unknown;
  content?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: string;
  terminalEmitted: boolean;
  partialResult?: unknown;
};

const MAX_RAW_OUTPUT_CHARS = 64 * 1024;

function zeroAssistantUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function asAgentMessage(msg: unknown): AgentMessage {
  return msg as AgentMessage;
}

function metaTimestamp(meta: unknown, fallback: number): number {
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    for (const key of ['timestamp', 'ts', 'createdAt', 'created_at']) {
      const v = m[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
        const parsed = Date.parse(v);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return fallback;
}

function xaiToolName(update: SessionUpdate): string | null {
  const meta = (update as { _meta?: { ['x.ai/tool']?: { name?: unknown } } })._meta;
  const name = meta?.['x.ai/tool']?.name;
  if (typeof name === 'string' && name.trim()) return name.trim();
  return null;
}

function toolNameFromUpdate(update: SessionUpdate & { title?: string }): string {
  return (
    xaiToolName(update) ??
    (typeof update.title === 'string' && update.title.trim() ? update.title.trim() : 'grok_tool')
  );
}

function asArgs(rawInput: unknown): Record<string, unknown> {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    return rawInput as Record<string, unknown>;
  }
  return {};
}

function renderToolContent(content: unknown, rawOutput: unknown): string {
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const c = item as {
        type?: string;
        text?: string;
        content?: string;
        output?: string;
        path?: string;
        oldText?: string;
        newText?: string;
      };
      if (c.type === 'content' && typeof c.text === 'string') {
        parts.push(c.text);
      } else if (c.type === 'text' && typeof c.text === 'string') {
        parts.push(c.text);
      } else if (c.type === 'diff') {
        const pathLabel = typeof c.path === 'string' ? c.path : 'file';
        parts.push(`diff ${pathLabel}`);
        if (typeof c.oldText === 'string' || typeof c.newText === 'string') {
          parts.push(`--- a/${pathLabel}\n+++ b/${pathLabel}`);
        }
      } else if (c.type === 'terminal' && typeof c.output === 'string') {
        parts.push(c.output);
      } else if (typeof c.text === 'string') {
        parts.push(c.text);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  if (typeof content === 'string' && content.trim()) return content;
  if (typeof rawOutput === 'string') {
    return rawOutput.length > MAX_RAW_OUTPUT_CHARS
      ? rawOutput.slice(0, MAX_RAW_OUTPUT_CHARS)
      : rawOutput;
  }
  if (rawOutput !== undefined) {
    try {
      const json = JSON.stringify(rawOutput, null, 2);
      return json.length > MAX_RAW_OUTPUT_CHARS ? json.slice(0, MAX_RAW_OUTPUT_CHARS) : json;
    } catch {
      return String(rawOutput);
    }
  }
  return '';
}

function isTerminalStatus(status: string | undefined): status is 'completed' | 'failed' {
  return status === 'completed' || status === 'failed';
}

/**
 * Create a projector that turns ACP session updates into Agent View messages.
 */
export function createGrokAcpTranscriptProjector(
  options: GrokAcpTranscriptOptions = {}
): GrokAcpTranscriptProjector {
  const now = options.now ?? (() => Date.now());
  const loadStart = options.loadStartTimestamp ?? now();
  let replaySeq = 0;
  let phase: GrokAcpTranscriptPhase = 'idle';
  const messages: AgentMessage[] = [];
  let userDraft: UserDraft | null = null;
  let assistantDraft: AssistantDraft | null = null;
  let streamingMessage: AgentMessage | undefined;
  const tools = new Map<string, ToolState>();
  const activeTools = new Map<
    string,
    {
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult?: unknown;
      isError?: boolean;
      ended?: boolean;
    }
  >();
  let hasUserHistory = false;
  let usage: GrokAcpTranscriptUsage = {
    usage: emptyUsage(),
    model: options.configuredModel,
  };
  /** messageId -> index into messages for re-open of non-contiguous chunks. */
  const messageIdToIndex = new Map<string, number>();

  const nextTimestamp = (meta: unknown): number => {
    const base = metaTimestamp(meta, loadStart + replaySeq);
    replaySeq += 1;
    return base;
  };

  const flushUser = () => {
    if (!userDraft) return;
    const msg = asAgentMessage({
      role: 'user',
      content: userDraft.content,
      timestamp: userDraft.timestamp,
      // Preserve protocol messageId for identity/merge across non-contiguous chunks.
      ...(userDraft.messageId ? { messageId: userDraft.messageId } : {}),
    });
    if (userDraft.messageId) {
      messageIdToIndex.set(userDraft.messageId, messages.length);
    }
    messages.push(msg);
    hasUserHistory = true;
    userDraft = null;
  };

  const assistantHasToolCall = (draft: AssistantDraft): boolean =>
    draft.content.some((p) => p.type === 'toolCall');

  const flushAssistant = () => {
    if (!assistantDraft) return;
    if (assistantDraft.content.length === 0) {
      assistantDraft = null;
      streamingMessage = undefined;
      return;
    }
    if (!assistantDraft.stopReason) {
      assistantDraft.stopReason = assistantHasToolCall(assistantDraft) ? 'toolUse' : 'stop';
    }
    const slot = assistantDraft.slotIndex;
    // slotIndex is only for reopen bookkeeping — strip before materializing.
    const { slotIndex: _slot, ...draftFields } = assistantDraft;
    const msg = asAgentMessage({ ...draftFields });
    if (typeof slot === 'number' && slot >= 0 && slot < messages.length) {
      // In-place update preserves first-seen messageId order (msg1,msg2,msg1 → msg1,msg2).
      messages[slot] = msg;
      if (assistantDraft.messageId) {
        messageIdToIndex.set(assistantDraft.messageId, slot);
      }
    } else {
      if (assistantDraft.messageId) {
        messageIdToIndex.set(assistantDraft.messageId, messages.length);
      }
      messages.push(msg);
    }
    assistantDraft = null;
    streamingMessage = undefined;
  };

  const ensureAssistant = (messageId: string | undefined, meta: unknown): AssistantDraft => {
    if (
      assistantDraft &&
      messageId &&
      assistantDraft.messageId &&
      assistantDraft.messageId === messageId
    ) {
      return assistantDraft;
    }
    if (assistantDraft && !messageId && !assistantDraft.messageId) {
      return assistantDraft;
    }
    // Non-contiguous same messageId: keep first slot, continue as draft, flush in-place.
    if (
      messageId &&
      (!assistantDraft || assistantDraft.messageId !== messageId) &&
      messageIdToIndex.has(messageId)
    ) {
      if (assistantDraft) flushAssistant();
      const idx = messageIdToIndex.get(messageId)!;
      const existing = messages[idx] as unknown as AssistantDraft | undefined;
      if (existing && (existing as { role?: string }).role === 'assistant') {
        assistantDraft = {
          role: 'assistant',
          content: Array.isArray(existing.content) ? [...existing.content] : [],
          api: existing.api ?? 'grok-acp',
          provider: existing.provider ?? 'xai',
          model: existing.model || usage.model || options.configuredModel || '',
          usage: existing.usage
            ? { ...existing.usage, cost: { ...existing.usage.cost } }
            : zeroAssistantUsage(),
          stopReason: existing.stopReason ?? 'stop',
          timestamp: existing.timestamp ?? nextTimestamp(meta),
          messageId,
          slotIndex: idx,
        };
        streamingMessage = asAgentMessage({ ...assistantDraft });
        return assistantDraft;
      }
    }
    // Different message id or role boundary: flush previous draft.
    if (assistantDraft) flushAssistant();
    assistantDraft = {
      role: 'assistant',
      content: [],
      api: 'grok-acp',
      provider: 'xai',
      model: usage.model ?? options.configuredModel ?? '',
      usage: zeroAssistantUsage(),
      stopReason: 'stop',
      timestamp: nextTimestamp(meta),
      messageId,
    };
    streamingMessage = asAgentMessage({ ...assistantDraft });
    return assistantDraft;
  };

  const publishStreaming = () => {
    if (assistantDraft) {
      streamingMessage = asAgentMessage({
        ...assistantDraft,
        content: [...assistantDraft.content],
      });
    }
  };

  const ensureTool = (toolCallId: string, update: SessionUpdate): ToolState => {
    const u = update as SessionUpdate & {
      title?: string | null;
      rawInput?: unknown;
      kind?: string | null;
      locations?: unknown;
    };
    let tool = tools.get(toolCallId);
    if (!tool) {
      tool = {
        toolCallId,
        toolName: toolNameFromUpdate(u as SessionUpdate & { title?: string }),
        args: asArgs(u.rawInput),
        title: typeof u.title === 'string' ? u.title : undefined,
        kind: typeof u.kind === 'string' ? u.kind : undefined,
        locations: u.locations,
        rawInput: u.rawInput,
        status: undefined,
        terminalEmitted: false,
      };
      tools.set(toolCallId, tool);
    } else {
      // Prefer structured x.ai name, then existing, then title.
      const structured = xaiToolName(update);
      if (structured) tool.toolName = structured;
      else if (typeof u.title === 'string' && u.title.trim() && tool.toolName === 'grok_tool') {
        tool.toolName = u.title.trim();
      }
      if (u.rawInput && typeof u.rawInput === 'object') {
        tool.args = asArgs(u.rawInput);
        tool.rawInput = u.rawInput;
      }
      if (typeof u.title === 'string') tool.title = u.title;
      if (typeof u.kind === 'string') tool.kind = u.kind;
      if (u.locations !== undefined) tool.locations = u.locations;
    }
    return tool;
  };

  const ensureToolOnAssistant = (tool: ToolState, meta: unknown) => {
    const draft = ensureAssistant(undefined, meta);
    const existing = draft.content.find(
      (p) => p.type === 'toolCall' && p.id === tool.toolCallId
    ) as
      | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
      | undefined;
    if (existing) {
      existing.name = tool.toolName;
      existing.arguments = tool.args;
    } else {
      draft.content.push({
        type: 'toolCall',
        id: tool.toolCallId,
        name: tool.toolName,
        arguments: tool.args,
      });
      draft.stopReason = 'toolUse';
    }
    publishStreaming();
    activeTools.set(tool.toolCallId, {
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      args: tool.args,
      partialResult: tool.partialResult,
      ended: false,
    });
  };

  const emitToolResult = (tool: ToolState, isError: boolean, meta: unknown) => {
    const text = renderToolContent(tool.content, tool.rawOutput);
    // Later richer/failed terminal updates: in-place replace same result, no duplicate.
    if (tool.terminalEmitted) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as {
          role?: string;
          toolCallId?: string;
          content?: unknown;
          details?: Record<string, unknown>;
          isError?: boolean;
          timestamp?: number;
        };
        if (m.role === 'toolResult' && m.toolCallId === tool.toolCallId) {
          messages[i] = asAgentMessage({
            ...m,
            content: text ? [{ type: 'text', text }] : [],
            details: {
              ...(m.details ?? {}),
              title: tool.title,
              kind: tool.kind,
              locations: tool.locations,
              content: tool.content,
              rawInput: tool.rawInput,
              rawOutput: tool.rawOutput,
              status: tool.status,
            },
            isError,
          });
          break;
        }
      }
      activeTools.set(tool.toolCallId, {
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        args: tool.args,
        partialResult: tool.partialResult,
        isError,
        ended: true,
      });
      return;
    }
    tool.terminalEmitted = true;
    // Flush assistant so the tool-result follows the tool-call part.
    flushAssistant();
    const msg = asAgentMessage({
      role: 'toolResult',
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      content: text ? [{ type: 'text', text }] : [],
      details: {
        title: tool.title,
        kind: tool.kind,
        locations: tool.locations,
        content: tool.content,
        rawInput: tool.rawInput,
        rawOutput: tool.rawOutput,
        status: tool.status,
      },
      isError,
      timestamp: nextTimestamp(meta),
    });
    messages.push(msg);
    activeTools.set(tool.toolCallId, {
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      args: tool.args,
      partialResult: tool.partialResult,
      isError,
      ended: true,
    });
  };

  const handleUpdate = (update: SessionUpdate, notificationMeta: unknown) => {
    const kind = update.sessionUpdate;

    if (kind === 'user_message_chunk') {
      flushAssistant();
      const text =
        update.content && typeof update.content === 'object' && 'text' in update.content
          ? String((update.content as { text?: unknown }).text ?? '')
          : '';
      const messageId =
        typeof (update as { messageId?: unknown }).messageId === 'string'
          ? ((update as { messageId?: string }).messageId as string)
          : undefined;
      if (!userDraft || (messageId && userDraft.messageId && userDraft.messageId !== messageId)) {
        flushUser();
        userDraft = {
          role: 'user',
          content: text,
          timestamp: nextTimestamp(notificationMeta ?? (update as { _meta?: unknown })._meta),
          messageId,
        };
      } else {
        userDraft.content += text;
        if (messageId) userDraft.messageId = messageId;
      }
      return;
    }

    if (kind === 'agent_thought_chunk') {
      flushUser();
      const text =
        update.content && typeof update.content === 'object' && 'text' in update.content
          ? String((update.content as { text?: unknown }).text ?? '')
          : '';
      const messageId =
        typeof (update as { messageId?: unknown }).messageId === 'string'
          ? ((update as { messageId?: string }).messageId as string)
          : undefined;
      const draft = ensureAssistant(
        messageId,
        notificationMeta ?? (update as { _meta?: unknown })._meta
      );
      if (messageId) draft.messageId = messageId;
      const last = draft.content[draft.content.length - 1];
      if (last && last.type === 'thinking') {
        last.thinking += text;
      } else {
        draft.content.push({ type: 'thinking', thinking: text });
      }
      publishStreaming();
      return;
    }

    if (kind === 'agent_message_chunk') {
      flushUser();
      const text =
        update.content && typeof update.content === 'object' && 'text' in update.content
          ? String((update.content as { text?: unknown }).text ?? '')
          : '';
      const messageId =
        typeof (update as { messageId?: unknown }).messageId === 'string'
          ? ((update as { messageId?: string }).messageId as string)
          : undefined;
      const draft = ensureAssistant(
        messageId,
        notificationMeta ?? (update as { _meta?: unknown })._meta
      );
      if (messageId) draft.messageId = messageId;
      const last = draft.content[draft.content.length - 1];
      if (last && last.type === 'text') {
        last.text += text;
      } else {
        draft.content.push({ type: 'text', text });
      }
      publishStreaming();
      return;
    }

    if (kind === 'tool_call') {
      flushUser();
      const toolCallId = String((update as { toolCallId?: unknown }).toolCallId ?? '');
      if (!toolCallId) return;
      const tool = ensureTool(toolCallId, update);
      tool.status =
        typeof (update as { status?: unknown }).status === 'string'
          ? String((update as { status?: string }).status)
          : tool.status;
      if ((update as { content?: unknown }).content !== undefined) {
        tool.content = (update as { content?: unknown }).content;
      }
      if ((update as { rawOutput?: unknown }).rawOutput !== undefined) {
        tool.rawOutput = (update as { rawOutput?: unknown }).rawOutput;
      }
      ensureToolOnAssistant(tool, notificationMeta ?? (update as { _meta?: unknown })._meta);
      if (isTerminalStatus(tool.status)) {
        emitToolResult(
          tool,
          tool.status === 'failed',
          notificationMeta ?? (update as { _meta?: unknown })._meta
        );
      }
      return;
    }

    if (kind === 'tool_call_update') {
      const toolCallId = String((update as { toolCallId?: unknown }).toolCallId ?? '');
      if (!toolCallId) return;
      const tool = ensureTool(toolCallId, update);
      if (typeof (update as { status?: unknown }).status === 'string') {
        tool.status = String((update as { status?: string }).status);
      }
      if ((update as { content?: unknown }).content !== undefined) {
        // Content replacement: later updates fully replace prior content payload.
        tool.content = (update as { content?: unknown }).content;
      }
      if ((update as { title?: unknown }).title !== undefined) {
        const t = (update as { title?: unknown }).title;
        if (typeof t === 'string') tool.title = t;
      }
      if ((update as { rawOutput?: unknown }).rawOutput !== undefined) {
        tool.rawOutput = (update as { rawOutput?: unknown }).rawOutput;
        tool.partialResult = (update as { rawOutput?: unknown }).rawOutput;
      }
      // Keep assistant tool-call part in sync when still drafting.
      if (assistantDraft) {
        ensureToolOnAssistant(tool, notificationMeta ?? (update as { _meta?: unknown })._meta);
      } else {
        activeTools.set(tool.toolCallId, {
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          args: tool.args,
          partialResult: tool.partialResult,
          ended: isTerminalStatus(tool.status),
          isError: tool.status === 'failed',
        });
      }
      // Terminal replacement/update: first terminal wins (emitToolResult no-ops after).
      if (isTerminalStatus(tool.status)) {
        emitToolResult(
          tool,
          tool.status === 'failed',
          notificationMeta ?? (update as { _meta?: unknown })._meta
        );
      } else if (tool.terminalEmitted && tool.content !== undefined) {
        // Non-status content replacement after terminal: update stored tool-result text if present.
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i] as {
            role?: string;
            toolCallId?: string;
            content?: unknown;
            details?: Record<string, unknown>;
          };
          if (m.role === 'toolResult' && m.toolCallId === tool.toolCallId) {
            const text = renderToolContent(tool.content, tool.rawOutput);
            messages[i] = asAgentMessage({
              ...m,
              content: text ? [{ type: 'text', text }] : [],
              details: {
                ...(m.details ?? {}),
                content: tool.content,
                rawOutput: tool.rawOutput,
                title: tool.title,
                status: tool.status,
              },
            });
            break;
          }
        }
      }
      return;
    }

    if (kind === 'usage_update') {
      // Real ACP usage_update uses used/size/cost; also accept prompt-style token fields.
      const u = update as {
        used?: number;
        size?: number;
        cost?: { amount?: number; currency?: string };
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        thoughtTokens?: number;
        cachedReadTokens?: number;
        cachedWriteTokens?: number;
        _meta?: { modelId?: string; model?: string };
      };
      const next = emptyUsage();
      next.input = typeof u.inputTokens === 'number' ? u.inputTokens : usage.usage.input;
      next.output = typeof u.outputTokens === 'number' ? u.outputTokens : usage.usage.output;
      next.cacheRead =
        typeof u.cachedReadTokens === 'number' ? u.cachedReadTokens : usage.usage.cacheRead;
      next.cacheWrite =
        typeof u.cachedWriteTokens === 'number' ? u.cachedWriteTokens : usage.usage.cacheWrite;
      // ACP: `used` is context consumption; `size` is context window capacity (informational).
      if (typeof u.used === 'number' && Number.isFinite(u.used)) {
        next.contextTokens = u.used;
      } else if (typeof u.totalTokens === 'number' && Number.isFinite(u.totalTokens)) {
        next.contextTokens = u.totalTokens;
      } else {
        next.contextTokens = next.input + next.output;
      }
      if (
        u.cost &&
        typeof u.cost.amount === 'number' &&
        Number.isFinite(u.cost.amount) &&
        (u.cost.currency === undefined || u.cost.currency === 'USD')
      ) {
        next.cost = u.cost.amount;
      } else {
        next.cost = usage.usage.cost;
      }
      next.turns = usage.usage.turns;
      const modelFromUpdate =
        (typeof u._meta?.modelId === 'string' && u._meta.modelId) ||
        (typeof u._meta?.model === 'string' && u._meta.model) ||
        usage.model ||
        options.configuredModel;
      usage = {
        usage: next,
        model: modelFromUpdate,
        stopReason: usage.stopReason,
      };
      // Attribute usage to the current assistant draft (endpoint/current-turn ownership).
      if (assistantDraft) {
        if (usage.model) assistantDraft.model = usage.model;
        const au = assistantDraft.usage;
        au.input = next.input;
        au.output = next.output;
        au.cacheRead = next.cacheRead;
        au.cacheWrite = next.cacheWrite;
        au.totalTokens = next.contextTokens;
        if (next.cost) {
          au.cost = { ...au.cost, total: next.cost };
        }
        publishStreaming();
      }
      return;
    }
  };

  return {
    get phase() {
      return phase;
    },
    get messages() {
      return messages;
    },
    get streamingMessage() {
      return streamingMessage;
    },
    get activeTools() {
      return activeTools;
    },
    get usage() {
      return usage;
    },
    get hasUserHistory() {
      return hasUserHistory;
    },
    handleSessionUpdate(notification, nextPhase) {
      phase = nextPhase;
      const sessionUpdate = notification.update;
      if (!sessionUpdate) return;
      handleUpdate(sessionUpdate, notification._meta);
    },
    finalizeLoadBarrier() {
      flushUser();
      flushAssistant();
      // Non-terminal tools become unconfirmed/interrupted tool results.
      for (const tool of tools.values()) {
        if (!tool.terminalEmitted) {
          // Force interrupted regardless of prior in_progress/pending status.
          tool.status = 'interrupted';
          emitToolResult(tool, false, undefined);
        }
      }
      activeTools.clear();
      streamingMessage = undefined;
      phase = 'idle';
      return messages.slice();
    },
    finalizePromptResponse(input) {
      flushUser();
      const model =
        input.model ||
        (typeof input.meta?.modelId === 'string' ? input.meta.modelId : undefined) ||
        (typeof input.meta?.model === 'string' ? input.meta.model : undefined) ||
        usage.model ||
        options.configuredModel ||
        '';
      // Unified ACP stop-reason semantics (same as one-shot SingleResult mapping).
      const wasAborted =
        input.stopReason === 'cancelled' ||
        input.stopReason === 'aborted' ||
        input.stopReason === 'cancel_grace';
      const mapped = mapGrokAcpStopReason(String(input.stopReason ?? ''), { wasAborted });
      // AgentMessage assistant stopReason vocabulary.
      const assistantStop: AssistantDraft['stopReason'] =
        mapped.stopReason === 'end'
          ? 'stop'
          : mapped.stopReason === 'aborted'
            ? 'aborted'
            : input.stopReason === 'tool_use' || input.stopReason === 'toolUse'
              ? 'toolUse'
              : 'error';
      if (assistantDraft) {
        assistantDraft.model = model;
        assistantDraft.stopReason = assistantStop;
        // Merge completion meta onto the terminal assistant (preserve cache/cost).
        const u = assistantDraft.usage;
        if (usage.usage.cacheRead) u.cacheRead = usage.usage.cacheRead;
        if (usage.usage.cacheWrite) u.cacheWrite = usage.usage.cacheWrite;
        if (usage.usage.cost) {
          u.cost = {
            ...u.cost,
            total: usage.usage.cost,
          };
        }
        if (input.meta) {
          const meta = input.meta;
          if (typeof meta.inputTokens === 'number') u.input = meta.inputTokens;
          if (typeof meta.outputTokens === 'number') u.output = meta.outputTokens;
          if (typeof meta.totalTokens === 'number') u.totalTokens = meta.totalTokens;
          if (typeof meta.cachedReadTokens === 'number') u.cacheRead = meta.cachedReadTokens;
          if (typeof meta.cachedWriteTokens === 'number') u.cacheWrite = meta.cachedWriteTokens;
        }
      }
      flushAssistant();
      // Count assistant turns in usage summary; keep full projector stats.
      const turns = messages.filter((m) => (m as { role?: string }).role === 'assistant').length;
      const nextUsage = emptyUsage();
      nextUsage.turns = turns;
      nextUsage.cacheRead = usage.usage.cacheRead;
      nextUsage.cacheWrite = usage.usage.cacheWrite;
      nextUsage.cost = usage.usage.cost;
      nextUsage.input = usage.usage.input;
      nextUsage.output = usage.usage.output;
      nextUsage.contextTokens = usage.usage.contextTokens;
      if (input.meta) {
        const meta = input.meta;
        if (typeof meta.inputTokens === 'number') nextUsage.input = meta.inputTokens;
        if (typeof meta.outputTokens === 'number') nextUsage.output = meta.outputTokens;
        if (typeof meta.totalTokens === 'number') nextUsage.contextTokens = meta.totalTokens;
        if (typeof meta.cachedReadTokens === 'number') nextUsage.cacheRead = meta.cachedReadTokens;
        if (typeof meta.cachedWriteTokens === 'number') {
          nextUsage.cacheWrite = meta.cachedWriteTokens;
        }
      }
      usage = {
        usage: nextUsage,
        model,
        // Formal SingleResult-compatible terminal (end / max_turns / error / aborted).
        stopReason: mapped.stopReason,
      };
      phase = 'idle';
    },
    replaceMessages(next) {
      messages.length = 0;
      messages.push(...next);
      hasUserHistory = next.some((m) => (m as { role?: string }).role === 'user');
      userDraft = null;
      assistantDraft = null;
      streamingMessage = undefined;
      tools.clear();
      activeTools.clear();
      messageIdToIndex.clear();
    },
    getFinalizedMessages() {
      return messages.slice();
    },
  };
}
