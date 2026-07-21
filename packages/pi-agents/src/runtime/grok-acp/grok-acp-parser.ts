// ABOUTME: Maps Grok ACP session updates and prompt completion metadata into SingleResult.
// ABOUTME: Groups assistant text by messageId (or tool-boundary fallback) and tracks tool calls.

import type { Message } from '@earendil-works/pi-ai';
import type { SessionNotification, SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import { emptyUsage } from '../../shared/empty-usage.ts';
import type { SingleResult } from '../../shared/types.ts';

export interface GrokAcpParserState {
  currentMessageId: string | null;
  /**
   * Non-empty messageId -> assistant message index. Same messageId always appends
   * to the same message even when chunks are non-contiguous (e.g. interrupted by tools).
   */
  messageIdToIndex: Map<string, number>;
  /** When true, the next agent_message_chunk without messageId starts a new assistant message. */
  expectNewMessageAfterTool: boolean;
  /** toolCallId -> index into the owning assistant message content for the toolCall part. */
  toolCallParts: Map<string, { messageIndex: number; contentIndex: number }>;
  /** toolCallId -> last known terminal status. */
  toolStatuses: Map<string, string>;
  /** toolCallIds whose name came from x.ai structured metadata (title must not clobber). */
  structuredToolNames: Set<string>;
  configuredModel?: string;
}

export function createGrokAcpParserState(configuredModel?: string): GrokAcpParserState {
  return {
    currentMessageId: null,
    messageIdToIndex: new Map(),
    expectNewMessageAfterTool: false,
    toolCallParts: new Map(),
    toolStatuses: new Map(),
    structuredToolNames: new Set(),
    configuredModel: configuredModel,
  };
}

function ensureUsage(result: SingleResult) {
  if (!result.usage) result.usage = emptyUsage();
  return result.usage;
}

function countAssistantTurns(result: SingleResult): number {
  return result.messages.filter((m) => m.role === 'assistant').length;
}

type AssistantLike = {
  role: 'assistant';
  model: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
    | { type: string; [key: string]: unknown }
  >;
  stopReason?: string;
};

function createAssistantMessage(result: SingleResult): AssistantLike {
  return {
    role: 'assistant',
    model: result.model ?? '',
    content: [],
  };
}

function asMessage(msg: AssistantLike): Message {
  return msg as unknown as Message;
}

function lastAssistant(result: SingleResult): AssistantLike | undefined {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    if (result.messages[i].role === 'assistant') {
      return result.messages[i] as unknown as AssistantLike;
    }
  }
  return undefined;
}

function appendTextToMessage(msg: AssistantLike, text: string): void {
  const textPart = msg.content.find((p) => p.type === 'text');
  if (textPart && textPart.type === 'text') {
    textPart.text += text;
  } else {
    msg.content.push({ type: 'text', text });
  }
}

function appendTextToAssistant(result: SingleResult, text: string, startNew: boolean): void {
  const last = lastAssistant(result);
  if (!startNew && last) {
    appendTextToMessage(last, text);
    return;
  }
  const msg = createAssistantMessage(result);
  msg.content.push({ type: 'text', text });
  result.messages.push(asMessage(msg));
  ensureUsage(result).turns = countAssistantTurns(result);
}

function xaiToolName(
  update: SessionUpdate & { sessionUpdate: 'tool_call' | 'tool_call_update' }
): string | null {
  const meta = update._meta as { ['x.ai/tool']?: { name?: unknown } } | null | undefined;
  const xaiName = meta?.['x.ai/tool']?.name;
  if (typeof xaiName === 'string' && xaiName.trim()) return xaiName;
  return null;
}

function toolNameFromUpdate(
  update: SessionUpdate & { sessionUpdate: 'tool_call' | 'tool_call_update' }
): string {
  const xaiName = xaiToolName(update);
  if (xaiName) return xaiName;
  if (typeof update.title === 'string' && update.title.trim()) return update.title;
  return 'grok_tool';
}

function rawInputAsObject(rawInput: unknown): Record<string, unknown> {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    return rawInput as Record<string, unknown>;
  }
  return {};
}

function handleAgentMessageChunk(
  update: SessionUpdate & { sessionUpdate: 'agent_message_chunk' },
  result: SingleResult,
  state: GrokAcpParserState,
  onUpdate: () => void
): void {
  if (!update.content || update.content.type !== 'text') return;
  const text = update.content.text;
  if (typeof text !== 'string') return;

  const messageId =
    typeof update.messageId === 'string' && update.messageId.length > 0 ? update.messageId : null;

  if (messageId) {
    // Same non-empty messageId always merges into one assistant message, even when
    // chunks are non-contiguous (tools or other messageIds in between).
    const existingIndex = state.messageIdToIndex.get(messageId);
    if (existingIndex !== undefined) {
      const msg = result.messages[existingIndex] as unknown as AssistantLike | undefined;
      if (msg && msg.role === 'assistant') {
        appendTextToMessage(msg, text);
        state.currentMessageId = messageId;
        state.expectNewMessageAfterTool = false;
        onUpdate();
        return;
      }
    }
    state.currentMessageId = messageId;
    state.expectNewMessageAfterTool = false;
    appendTextToAssistant(result, text, true);
    state.messageIdToIndex.set(messageId, result.messages.length - 1);
    onUpdate();
    return;
  }

  // No messageId (Grok 0.2.93 fallback): tool-boundary grouping only applies here.
  const startNew = state.expectNewMessageAfterTool || lastAssistant(result) === undefined;
  if (startNew) state.expectNewMessageAfterTool = false;
  state.currentMessageId = null;
  appendTextToAssistant(result, text, startNew);
  onUpdate();
}

function handleToolCall(
  update: SessionUpdate & { sessionUpdate: 'tool_call' },
  result: SingleResult,
  state: GrokAcpParserState,
  onUpdate: () => void
): void {
  const toolCallId = update.toolCallId;
  if (!toolCallId) return;

  // Tool boundary only affects no-messageId streams; messageId map is unchanged.
  state.currentMessageId = null;

  let assistant = lastAssistant(result);
  if (!assistant) {
    assistant = createAssistantMessage(result);
    result.messages.push(asMessage(assistant));
    ensureUsage(result).turns = countAssistantTurns(result);
  }

  const xaiName = xaiToolName(update);
  const part = {
    type: 'toolCall' as const,
    id: toolCallId,
    name: toolNameFromUpdate(update),
    arguments: rawInputAsObject(update.rawInput),
  };
  assistant.content.push(part);
  state.toolCallParts.set(toolCallId, {
    messageIndex: result.messages.length - 1,
    contentIndex: assistant.content.length - 1,
  });
  if (xaiName) state.structuredToolNames.add(toolCallId);
  if (typeof update.status === 'string') {
    state.toolStatuses.set(toolCallId, update.status);
    if (update.status === 'completed' || update.status === 'failed') {
      state.expectNewMessageAfterTool = true;
    }
  }
  onUpdate();
}

function handleToolCallUpdate(
  update: SessionUpdate & { sessionUpdate: 'tool_call_update' },
  result: SingleResult,
  state: GrokAcpParserState,
  onUpdate: () => void
): void {
  const toolCallId = update.toolCallId;
  if (!toolCallId) return;

  const loc = state.toolCallParts.get(toolCallId);
  if (loc) {
    const msg = result.messages[loc.messageIndex] as unknown as AssistantLike | undefined;
    if (msg && msg.role === 'assistant') {
      const part = msg.content[loc.contentIndex];
      if (part && part.type === 'toolCall') {
        const xaiName = xaiToolName(update);
        if (xaiName) {
          // New x.ai structured name may overwrite any previous name.
          part.name = xaiName;
          state.structuredToolNames.add(toolCallId);
        } else if (typeof update.title === 'string' && update.title.trim()) {
          // Title-only updates must not clobber an existing structured name.
          if (!state.structuredToolNames.has(toolCallId)) {
            part.name = update.title;
          }
        }
        if (update.rawInput !== undefined) {
          if (update.rawInput && typeof update.rawInput === 'object') {
            part.arguments = rawInputAsObject(update.rawInput);
          }
        }
      }
    }
  }

  if (typeof update.status === 'string') {
    state.toolStatuses.set(toolCallId, update.status);
    if (update.status === 'completed' || update.status === 'failed') {
      state.expectNewMessageAfterTool = true;
    }
  }
  onUpdate();
}

function handleUsageUpdate(
  update: SessionUpdate & { sessionUpdate: 'usage_update' },
  result: SingleResult,
  onUpdate: () => void
): void {
  const usage = ensureUsage(result);
  if (typeof update.used === 'number' && Number.isFinite(update.used)) {
    usage.contextTokens = update.used;
  }
  const cost = update.cost;
  if (cost && typeof cost.amount === 'number' && cost.currency === 'USD') {
    usage.cost = cost.amount;
  }
  onUpdate();
}

export function handleGrokAcpSessionUpdate(
  notification: SessionNotification,
  result: SingleResult,
  state: GrokAcpParserState,
  onUpdate: () => void
): void {
  const update = notification.update;
  if (!update || typeof update !== 'object') return;

  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      handleAgentMessageChunk(update, result, state, onUpdate);
      return;
    case 'tool_call':
      handleToolCall(update, result, state, onUpdate);
      return;
    case 'tool_call_update':
      handleToolCallUpdate(update, result, state, onUpdate);
      return;
    case 'usage_update':
      handleUsageUpdate(update, result, onUpdate);
      return;
    case 'user_message_chunk':
    case 'agent_thought_chunk':
    case 'plan':
    case 'plan_update':
    case 'plan_removed':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    default:
      // Unknown / non-message updates are ignored for SingleResult construction.
      return;
  }
}

export interface GrokAcpPromptMeta {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedReadTokens?: unknown;
  cachedWriteTokens?: unknown;
  totalTokens?: unknown;
  modelId?: unknown;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

export function applyGrokAcpPromptMeta(
  result: SingleResult,
  meta: GrokAcpPromptMeta | null | undefined,
  state: GrokAcpParserState
): void {
  if (!meta || typeof meta !== 'object') return;
  const usage = ensureUsage(result);

  const input = asFiniteNumber(meta.inputTokens);
  if (input !== undefined) usage.input = input;

  const output = asFiniteNumber(meta.outputTokens);
  if (output !== undefined) usage.output = output;

  const cacheRead = asFiniteNumber(meta.cachedReadTokens);
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;

  const cacheWrite = asFiniteNumber(meta.cachedWriteTokens);
  usage.cacheWrite = cacheWrite !== undefined ? cacheWrite : usage.cacheWrite || 0;

  const total = asFiniteNumber(meta.totalTokens);
  if (total !== undefined) usage.contextTokens = total;

  if (typeof meta.modelId === 'string' && meta.modelId.trim()) {
    result.model = meta.modelId;
  } else if (!result.model && state.configuredModel) {
    result.model = state.configuredModel;
  }
}

export interface MappedStopReason {
  stopReason: string;
  errorMessage?: string;
  exitCode: number;
}

export function mapGrokAcpStopReason(
  acpStopReason: string | undefined,
  options: { wasAborted: boolean }
): MappedStopReason {
  switch (acpStopReason as StopReason | string | undefined) {
    case 'end_turn':
      return { stopReason: 'end', exitCode: 0 };
    case 'max_turn_requests':
      return {
        stopReason: 'max_turns',
        errorMessage: 'Grok reported a max turn request limit',
        exitCode: 1,
      };
    case 'max_tokens':
      return {
        stopReason: 'error',
        errorMessage: 'Grok stopped because the token limit was reached',
        exitCode: 1,
      };
    case 'refusal':
      return {
        stopReason: 'error',
        errorMessage: 'Grok refused to continue the prompt',
        exitCode: 1,
      };
    case 'cancelled':
      if (options.wasAborted) {
        return { stopReason: 'aborted', exitCode: 1 };
      }
      return {
        stopReason: 'error',
        errorMessage: 'Grok ACP session was cancelled unexpectedly',
        exitCode: 1,
      };
    default:
      return {
        stopReason: 'error',
        errorMessage: `Unknown ACP stop reason: ${acpStopReason ?? '<missing>'}`,
        exitCode: 1,
      };
  }
}

export function finalizeGrokAcpPrompt(
  result: SingleResult,
  acpStopReason: string | undefined,
  meta: GrokAcpPromptMeta | null | undefined,
  state: GrokAcpParserState,
  options: { wasAborted: boolean },
  onUpdate?: () => void
): MappedStopReason {
  applyGrokAcpPromptMeta(result, meta, state);

  if (result.usage.turns === 0) result.usage.turns = 1;

  const mapped = mapGrokAcpStopReason(acpStopReason, options);
  result.stopReason = mapped.stopReason;
  if (mapped.errorMessage) result.errorMessage = mapped.errorMessage;
  result.exitCode = mapped.exitCode;

  const last = lastAssistant(result);
  if (last) {
    last.stopReason = mapped.stopReason;
    if (result.model) last.model = result.model;
  } else {
    const msg = createAssistantMessage(result);
    msg.stopReason = mapped.stopReason;
    result.messages.push(asMessage(msg));
  }

  onUpdate?.();
  return mapped;
}
