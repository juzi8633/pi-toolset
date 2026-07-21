// ABOUTME: Tests for Grok ACP → Pi message mapping (text, tools, usage, stop reasons).
// ABOUTME: Covers messageId grouping, no-messageId tool-boundary fallback, and completion regression.

import { describe, expect, it } from 'bun:test';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { validateCompletionOutput } from '../../../src/execution/completion-check.ts';
import {
  createGrokAcpParserState,
  finalizeGrokAcpPrompt,
  handleGrokAcpSessionUpdate,
  mapGrokAcpStopReason,
} from '../../../src/runtime/grok-acp/grok-acp-parser.ts';
import { getFinalOutput } from '../../../src/output/output.ts';
import type { SingleResult } from '../../../src/shared/types.ts';
import type { AgentConfig } from '../../../src/config/agents.ts';

function emptyResult(model = 'grok-4'): SingleResult {
  return {
    agent: 'a',
    agentSource: 'builtin',
    task: 't',
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model,
  };
}

function update(sessionUpdate: SessionNotification['update']): SessionNotification {
  return { sessionId: 's1', update: sessionUpdate };
}

describe('handleGrokAcpSessionUpdate message grouping', () => {
  it('appends chunks with the same messageId and starts a new message on change', () => {
    const result = emptyResult();
    const state = createGrokAcpParserState('grok-4');
    const updates: number[] = [];
    const onUpdate = () => updates.push(result.messages.length);

    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'Hel' },
      }),
      result,
      state,
      onUpdate
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'lo' },
      }),
      result,
      state,
      onUpdate
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm2',
        content: { type: 'text', text: 'World' },
      }),
      result,
      state,
      onUpdate
    );

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'Hello' });
    expect(result.messages[1].content[0]).toEqual({ type: 'text', text: 'World' });
    expect(getFinalOutput(result.messages)).toBe('World');
    expect(updates.length).toBeGreaterThan(0);
  });

  it('uses tool completion as the no-messageId boundary (Grok 0.2.93 fallback)', () => {
    const result = emptyResult();
    const state = createGrokAcpParserState();
    const noop = () => {};

    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Looking up the file…' },
      }),
      result,
      state,
      noop
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc1',
        title: 'Read file',
        status: 'pending',
        rawInput: { path: 'README.md' },
        _meta: { 'x.ai/tool': { name: 'read_file' } },
      }),
      result,
      state,
      noop
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
      }),
      result,
      state,
      noop
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '## Completed\n\nDone.\n' },
      }),
      result,
      state,
      noop
    );

    expect(result.messages).toHaveLength(2);
    const first = result.messages[0];
    expect(first.role).toBe('assistant');
    expect(first.content[0]).toEqual({ type: 'text', text: 'Looking up the file…' });
    expect(first.content[1]).toMatchObject({
      type: 'toolCall',
      id: 'tc1',
      name: 'read_file',
      arguments: { path: 'README.md' },
    });
    expect(result.messages[1].content[0]).toEqual({
      type: 'text',
      text: '## Completed\n\nDone.\n',
    });
    expect(getFinalOutput(result.messages)).toBe('## Completed\n\nDone.\n');
  });

  it('ignores user/thought/unknown updates for message construction', () => {
    const result = emptyResult();
    const state = createGrokAcpParserState();
    const noop = () => {};

    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'user' },
      }),
      result,
      state,
      noop
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking' },
      }),
      result,
      state,
      noop
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'available_commands_update',
        availableCommands: [],
      }),
      result,
      state,
      noop
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ok' },
      }),
      result,
      state,
      noop
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'ok' });
  });

  it('enriches tool call name/args from later tool_call_update', () => {
    const result = emptyResult();
    const state = createGrokAcpParserState();
    const noop = () => {};

    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Tool',
        status: 'pending',
      }),
      result,
      state,
      noop
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        title: 'Better title',
        rawInput: { q: 'x' },
        _meta: { 'x.ai/tool': { name: 'search' } },
        status: 'completed',
      }),
      result,
      state,
      noop
    );

    const part = result.messages[0].content[0];
    expect(part).toMatchObject({
      type: 'toolCall',
      id: 't1',
      name: 'search',
      arguments: { q: 'x' },
    });
  });

  it('merges non-contiguous chunks that share the same messageId across tools', () => {
    const result = emptyResult();
    const state = createGrokAcpParserState();
    const noop = () => {};

    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'Before ' },
      }),
      result,
      state,
      noop
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc1',
        title: 'Read',
        status: 'completed',
        _meta: { 'x.ai/tool': { name: 'read_file' } },
      }),
      result,
      state,
      noop
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm2',
        content: { type: 'text', text: 'Middle' },
      }),
      result,
      state,
      noop
    );
    // Same messageId as first chunk, after a different messageId and a tool — still m1.
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'after' },
      }),
      result,
      state,
      noop
    );

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'Before after' });
    expect(result.messages[0].content[1]).toMatchObject({
      type: 'toolCall',
      id: 'tc1',
      name: 'read_file',
    });
    expect(result.messages[1].content[0]).toEqual({ type: 'text', text: 'Middle' });
  });

  it('does not let a title-only tool_call_update clobber an x.ai structured name', () => {
    const result = emptyResult();
    const state = createGrokAcpParserState();
    const noop = () => {};

    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Human title',
        status: 'pending',
        _meta: { 'x.ai/tool': { name: 'read_file' } },
      }),
      result,
      state,
      noop
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        title: 'Some other display title',
        status: 'in_progress',
      }),
      result,
      state,
      noop
    );

    expect(result.messages[0].content[0]).toMatchObject({
      type: 'toolCall',
      id: 't1',
      name: 'read_file',
    });
  });

  it('allows a later x.ai structured name to overwrite a previous name', () => {
    const result = emptyResult();
    const state = createGrokAcpParserState();
    const noop = () => {};

    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Display',
        status: 'pending',
        _meta: { 'x.ai/tool': { name: 'old_tool' } },
      }),
      result,
      state,
      noop
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        title: 'Still display',
        _meta: { 'x.ai/tool': { name: 'new_tool' } },
        status: 'completed',
      }),
      result,
      state,
      noop
    );

    expect(result.messages[0].content[0]).toMatchObject({
      type: 'toolCall',
      id: 't1',
      name: 'new_tool',
    });
  });
});

describe('usage and stop reasons', () => {
  it('applies prompt metadata and usage_update into SingleResult.usage', () => {
    const result = emptyResult('configured-model');
    const state = createGrokAcpParserState('configured-model');
    const noop = () => {};

    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'usage_update',
        used: 111,
        size: 200000,
        cost: { amount: 0.0123, currency: 'USD' },
      }),
      result,
      state,
      noop
    );
    expect(result.usage.contextTokens).toBe(111);
    expect(result.usage.cost).toBe(0.0123);

    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done' },
      }),
      result,
      state,
      noop
    );

    finalizeGrokAcpPrompt(
      result,
      'end_turn',
      {
        inputTokens: 10,
        outputTokens: 4,
        cachedReadTokens: 2,
        cachedWriteTokens: 1,
        totalTokens: 17,
        modelId: 'meta-model',
      },
      state,
      { wasAborted: false }
    );

    expect(result.usage.input).toBe(10);
    expect(result.usage.output).toBe(4);
    expect(result.usage.cacheRead).toBe(2);
    expect(result.usage.cacheWrite).toBe(1);
    expect(result.usage.contextTokens).toBe(17);
    expect(result.usage.cost).toBe(0.0123);
    expect(result.usage.turns).toBe(1);
    expect(result.model).toBe('meta-model');
    expect(result.stopReason).toBe('end');
    expect(result.exitCode).toBe(0);
  });

  it('maps all documented stop reasons without mentioning agent.maxTurns', () => {
    expect(mapGrokAcpStopReason('end_turn', { wasAborted: false })).toEqual({
      stopReason: 'end',
      exitCode: 0,
    });
    expect(mapGrokAcpStopReason('max_turn_requests', { wasAborted: false })).toMatchObject({
      stopReason: 'max_turns',
      exitCode: 1,
    });
    expect(
      mapGrokAcpStopReason('max_turn_requests', { wasAborted: false }).errorMessage
    ).not.toMatch(/agent\.maxTurns/i);
    expect(mapGrokAcpStopReason('max_tokens', { wasAborted: false }).stopReason).toBe('error');
    expect(mapGrokAcpStopReason('refusal', { wasAborted: false }).stopReason).toBe('error');
    expect(mapGrokAcpStopReason('cancelled', { wasAborted: true }).stopReason).toBe('aborted');
    expect(mapGrokAcpStopReason('cancelled', { wasAborted: false })).toMatchObject({
      stopReason: 'error',
      exitCode: 1,
    });
    expect(mapGrokAcpStopReason('weird', { wasAborted: false }).errorMessage).toBe(
      'Unknown ACP stop reason: weird'
    );
  });
});

describe('completion-check regression', () => {
  it('passes validateCompletionOutput when pre-tool text is followed by ## Completed', () => {
    const result = emptyResult();
    const state = createGrokAcpParserState();
    const noop = () => {};
    const agent: AgentConfig = {
      name: 'worker',
      description: 'w',
      systemPrompt: '',
      source: 'builtin',
      filePath: '/tmp/w.md',
      completionCheck: ['## Completed'],
    };

    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I will read the file first.' },
      }),
      result,
      state,
      noop
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'r1',
        title: 'read',
        status: 'completed',
        rawInput: { path: 'a.ts' },
      }),
      result,
      state,
      noop
    );
    handleGrokAcpSessionUpdate(
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '## Completed\n\nAll good.\n' },
      }),
      result,
      state,
      noop
    );
    finalizeGrokAcpPrompt(result, 'end_turn', undefined, state, { wasAborted: false });

    const final = getFinalOutput(result.messages);
    expect(final).toContain('## Completed');
    expect(validateCompletionOutput(agent, final).ok).toBe(true);
  });
});
