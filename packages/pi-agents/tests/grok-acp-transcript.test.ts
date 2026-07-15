// ABOUTME: Tests for full Grok ACP historical/live transcript projection.
// ABOUTME: Covers user/thought/assistant/tool/result history, failures, and load barrier flush.

import { describe, expect, it } from 'bun:test';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { createGrokAcpTranscriptProjector } from '../src/grok-acp-transcript.ts';

function update(sessionId: string, body: Record<string, unknown>): SessionNotification {
  return {
    sessionId,
    update: body as SessionNotification['update'],
  };
}

describe('createGrokAcpTranscriptProjector', () => {
  it('uses configuredModel as default assistant model', () => {
    const p = createGrokAcpTranscriptProjector({
      configuredModel: 'configured-model-x',
      loadStartTimestamp: 1,
    });
    p.handleSessionUpdate(
      update('s', {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'hi' },
      }),
      'load'
    );
    p.handleSessionUpdate(
      update('s', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'yo' },
      }),
      'load'
    );
    const messages = p.finalizeLoadBarrier();
    const assistant = messages.find((m) => (m as { role?: string }).role === 'assistant') as {
      model?: string;
    };
    expect(assistant?.model).toBe('configured-model-x');
  });

  it('merges non-contiguous same messageId in first-seen slot order (msg1,msg2,msg1)', () => {
    const p = createGrokAcpTranscriptProjector({
      configuredModel: 'm',
      loadStartTimestamp: 1,
    });
    p.handleSessionUpdate(
      update('s', {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-1',
        content: { type: 'text', text: 'partA ' },
      }),
      'load'
    );
    // Intervening different message forces flush.
    p.handleSessionUpdate(
      update('s', {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-2',
        content: { type: 'text', text: 'other' },
      }),
      'load'
    );
    // Return to msg-1 non-contiguously — must update in place, not re-append.
    p.handleSessionUpdate(
      update('s', {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-1',
        content: { type: 'text', text: 'partB' },
      }),
      'load'
    );
    const messages = p.finalizeLoadBarrier();
    const assistants = messages.filter(
      (m) => (m as { role?: string }).role === 'assistant'
    ) as Array<{
      content?: Array<{ type?: string; text?: string }>;
      messageId?: string;
    }>;
    expect(assistants.map((a) => a.messageId)).toEqual(['msg-1', 'msg-2']);
    const text0 = (assistants[0]?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    expect(text0).toContain('partA');
    expect(text0).toContain('partB');
  });

  it('attributes real ACP usage_update used/size/cost and prompt-style tokens', () => {
    const p = createGrokAcpTranscriptProjector({
      configuredModel: 'fallback',
      loadStartTimestamp: 1,
    });
    p.handleSessionUpdate(
      update('s', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'x' },
      }),
      'prompt'
    );
    // Real ACP usage_update shape.
    p.handleSessionUpdate(
      update('s', {
        sessionUpdate: 'usage_update',
        used: 42,
        size: 128_000,
        cost: { amount: 0.012, currency: 'USD' },
        _meta: { modelId: 'from-usage' },
      }),
      'prompt'
    );
    p.finalizePromptResponse({ stopReason: 'end_turn' });
    expect(p.usage.model).toBe('from-usage');
    expect(p.usage.usage.contextTokens).toBe(42);
    expect(p.usage.usage.cost).toBe(0.012);
  });

  it('maps max_tokens/refusal/max_turn_requests to formal failure terminals', () => {
    const cases: Array<{ acp: string; formal: string; assistant: string }> = [
      { acp: 'max_tokens', formal: 'error', assistant: 'error' },
      { acp: 'refusal', formal: 'error', assistant: 'error' },
      { acp: 'max_turn_requests', formal: 'max_turns', assistant: 'error' },
      { acp: 'end_turn', formal: 'end', assistant: 'stop' },
      { acp: 'cancelled', formal: 'aborted', assistant: 'aborted' },
    ];
    for (const c of cases) {
      const p = createGrokAcpTranscriptProjector({ configuredModel: 'm' });
      p.handleSessionUpdate(
        update('s', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'x' },
        }),
        'prompt'
      );
      p.finalizePromptResponse({ stopReason: c.acp });
      expect(p.usage.stopReason).toBe(c.formal);
      const last = p.getFinalizedMessages().at(-1) as { stopReason?: string };
      expect(last.stopReason).toBe(c.assistant);
    }
  });

  it('flushes interrupted tools at load barrier and emits one terminal result', () => {
    const p = createGrokAcpTranscriptProjector({
      configuredModel: 'm',
      loadStartTimestamp: 1,
    });
    p.handleSessionUpdate(
      update('s', {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'go' },
      }),
      'load'
    );
    p.handleSessionUpdate(
      update('s', {
        sessionUpdate: 'tool_call',
        toolCallId: 't-open',
        title: 'read',
        status: 'in_progress',
        rawInput: { path: 'a' },
      }),
      'load'
    );
    const messages = p.finalizeLoadBarrier();
    const results = messages.filter(
      (m) => (m as { role?: string }).role === 'toolResult'
    ) as Array<{
      toolCallId?: string;
      details?: { status?: string };
      isError?: boolean;
    }>;
    expect(results.length).toBe(1);
    expect(results[0]?.toolCallId).toBe('t-open');
    expect(results[0]?.details?.status).toBe('interrupted');
  });

  it('projects user → thought → assistant → tool → result → final assistant', () => {
    const p = createGrokAcpTranscriptProjector({
      configuredModel: 'grok-test',
      loadStartTimestamp: 1_000,
    });
    const sid = 'sess-1';

    p.handleSessionUpdate(
      update(sid, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Hello' },
      }),
      'load'
    );
    p.handleSessionUpdate(
      update(sid, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking…' },
      }),
      'load'
    );
    p.handleSessionUpdate(
      update(sid, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I will read' },
      }),
      'load'
    );
    p.handleSessionUpdate(
      update(sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'read',
        status: 'in_progress',
        rawInput: { path: 'a.ts' },
        _meta: { 'x.ai/tool': { name: 'read_file' } },
      }),
      'load'
    );
    p.handleSessionUpdate(
      update(sid, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        rawOutput: 'file contents',
      }),
      'load'
    );
    p.handleSessionUpdate(
      update(sid, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Done.' },
      }),
      'load'
    );

    const messages = p.finalizeLoadBarrier();
    expect(p.hasUserHistory).toBe(true);
    expect(messages.length).toBeGreaterThanOrEqual(4);

    const roles = messages.map((m) => (m as { role?: string }).role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    expect(roles).toContain('toolResult');

    const firstUser = messages.find((m) => (m as { role?: string }).role === 'user') as {
      content?: string;
    };
    expect(firstUser?.content).toContain('Hello');

    const assistants = messages.filter(
      (m) => (m as { role?: string }).role === 'assistant'
    ) as Array<{
      content?: Array<{ type?: string; thinking?: string; text?: string; name?: string }>;
      api?: string;
      provider?: string;
      model?: string;
    }>;
    expect(assistants[0]?.api).toBe('grok-acp');
    expect(assistants[0]?.provider).toBe('xai');
    const thinking = assistants.flatMap((a) => a.content ?? []).find((c) => c.type === 'thinking');
    expect(thinking?.thinking).toContain('thinking');
    const toolCall = assistants.flatMap((a) => a.content ?? []).find((c) => c.type === 'toolCall');
    expect(toolCall?.name).toBe('read_file');

    const toolResult = messages.find((m) => (m as { role?: string }).role === 'toolResult') as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    expect(toolResult?.isError).toBe(false);
    expect(JSON.stringify(toolResult?.content)).toContain('file contents');
  });

  it('emits exactly one tool result for failed tools and ignores duplicate terminal updates', () => {
    const p = createGrokAcpTranscriptProjector({ loadStartTimestamp: 1 });
    const sid = 's';
    p.handleSessionUpdate(
      update(sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 't-fail',
        title: 'bad',
        status: 'failed',
        rawOutput: { error: 'nope' },
      }),
      'load'
    );
    p.handleSessionUpdate(
      update(sid, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't-fail',
        status: 'failed',
        rawOutput: { error: 'nope again' },
      }),
      'load'
    );
    const messages = p.finalizeLoadBarrier();
    const results = messages.filter((m) => (m as { role?: string }).role === 'toolResult');
    expect(results).toHaveLength(1);
    expect((results[0] as { isError?: boolean }).isError).toBe(true);
  });

  it('flushes unfinished tools as unconfirmed at the load barrier', () => {
    const p = createGrokAcpTranscriptProjector({ loadStartTimestamp: 1 });
    p.handleSessionUpdate(
      update('s', {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'go' },
      }),
      'load'
    );
    p.handleSessionUpdate(
      update('s', {
        sessionUpdate: 'tool_call',
        toolCallId: 'open',
        title: 'run',
        status: 'in_progress',
        rawInput: {},
      }),
      'load'
    );
    const messages = p.finalizeLoadBarrier();
    const results = messages.filter((m) => (m as { role?: string }).role === 'toolResult');
    expect(results).toHaveLength(1);
    expect((results[0] as { isError?: boolean }).isError).toBe(false);
  });

  it('attaches prompt response model and stop reason on finalizePromptResponse', () => {
    const p = createGrokAcpTranscriptProjector({ configuredModel: 'cfg' });
    p.handleSessionUpdate(
      update('s', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'live' },
      }),
      'prompt'
    );
    p.finalizePromptResponse({
      stopReason: 'end_turn',
      meta: { modelId: 'live-model', inputTokens: 2, outputTokens: 3 },
    });
    const messages = p.getFinalizedMessages();
    const last = messages[messages.length - 1] as {
      role?: string;
      model?: string;
      stopReason?: string;
    };
    expect(last.role).toBe('assistant');
    expect(last.model).toBe('live-model');
    expect(last.stopReason).toBe('stop');
    expect(p.usage.usage.input).toBe(2);
  });
});
