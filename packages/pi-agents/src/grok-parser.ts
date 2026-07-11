// ABOUTME: Grok streaming-json NDJSON parser - splits text into per-turn Messages via thought boundaries.
// ABOUTME: Maps Grok stopReason values (EndTurn/Cancelled) onto pi conventions (end/max_turns).

import type { Message } from '@earendil-works/pi-ai';
import type { SingleResult } from './types.ts';

interface GrokStreamEvent {
  type?: string;
  data?: string;
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
}

/**
 * Mutable parser state persisted across parseGrokEvent calls for one stream.
 *
 * Grok's streaming-json emits only `text`, `thought`, and `end` events -- no
 * tool-call or tool-result events. A `thought` event that follows `text` is the
 * only stream signal that the model received a tool result and started a new
 * turn. We use it to split accumulated text into separate assistant messages so
 * getFinalOutput() returns only the last turn (matching the pi runtime).
 */
export interface GrokParserState {
  sawText: boolean;
  pendingBoundary: boolean;
}

export function createGrokParserState(): GrokParserState {
  return { sawText: false, pendingBoundary: false };
}

function mapGrokStopReason(reason?: string): string | undefined {
  if (reason === 'EndTurn') return 'end';
  if (reason === 'Cancelled') return 'max_turns';
  return reason;
}

export function parseGrokEvent(
  line: string,
  result: SingleResult,
  onUpdate: () => void,
  state: GrokParserState
): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let event: GrokStreamEvent;
  try {
    event = JSON.parse(trimmed) as GrokStreamEvent;
  } catch {
    return;
  }
  if (!event || typeof event !== 'object') return;

  // Thought events don't produce messages, but a thought following text marks a
  // likely turn boundary (model received a tool result and is re-thinking).
  if (event.type === 'thought') {
    if (state.sawText) state.pendingBoundary = true;
    return;
  }

  if (event.type === 'text' && typeof event.data === 'string') {
    const boundary = state.pendingBoundary;
    state.pendingBoundary = false;
    state.sawText = true;

    const lastMsg = result.messages[result.messages.length - 1];
    if (!boundary && lastMsg && lastMsg.role === 'assistant') {
      const textPart = lastMsg.content.find((p) => p.type === 'text');
      if (textPart && textPart.type === 'text') {
        textPart.text += event.data;
      } else {
        lastMsg.content.push({ type: 'text', text: event.data });
      }
    } else {
      result.messages.push({
        role: 'assistant',
        model: result.model ?? '',
        content: [{ type: 'text', text: event.data }],
      } as Message);
      result.usage.turns = result.messages.filter((m) => m.role === 'assistant').length;
    }
    onUpdate();
    return;
  }

  if (event.type === 'end') {
    const mapped = mapGrokStopReason(event.stopReason);
    result.stopReason = mapped;
    if (result.usage.turns === 0) result.usage.turns = 1;

    const lastMsg = result.messages[result.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      (lastMsg as { stopReason?: string }).stopReason = mapped;
    } else {
      result.messages.push({
        role: 'assistant',
        model: result.model ?? '',
        content: [],
        stopReason: mapped,
      } as unknown as Message);
    }
    onUpdate();
  }
}
