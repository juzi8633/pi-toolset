// ABOUTME: Tests for Grok streaming-json parser - text accumulation, stopReason mapping, and end event.
// ABOUTME: Verifies EndTurn->end, Cancelled->max_turns, thought no-op, and invalid JSON handling.

import { describe, expect, it } from 'bun:test';
import type { SingleResult } from '../src/types.ts';
import { createGrokParserState, parseGrokEvent } from '../src/grok-parser.ts';
import { getFinalOutput } from '../src/output.ts';

function makeResult(model?: string): SingleResult {
  return {
    agent: 'grok-agent',
    agentSource: 'builtin',
    task: 'test',
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
    step: undefined,
  };
}

function parseLines(lines: string[], result: SingleResult): number {
  let updateCount = 0;
  const onUpdate = () => {
    updateCount++;
  };
  const state = createGrokParserState();
  for (const line of lines) parseGrokEvent(line, result, onUpdate, state);
  return updateCount;
}

describe('parseGrokEvent text events', () => {
  it('creates an assistant message on first text event', () => {
    const result = makeResult('grok-4.5');
    parseLines([JSON.stringify({ type: 'text', data: 'Hello' })], result);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'Hello' });
  });

  it('appends to existing message on subsequent text events', () => {
    const result = makeResult();
    parseLines(
      [
        JSON.stringify({ type: 'text', data: 'Hello' }),
        JSON.stringify({ type: 'text', data: ' ' }),
        JSON.stringify({ type: 'text', data: 'world' }),
      ],
      result
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'Hello world' });
  });

  it('calls onUpdate on each text event', () => {
    const result = makeResult();
    const updates = parseLines(
      [JSON.stringify({ type: 'text', data: 'a' }), JSON.stringify({ type: 'text', data: 'b' })],
      result
    );
    expect(updates).toBe(2);
  });

  it('sets model from result.model on the synthetic message', () => {
    const result = makeResult('grok-4.5');
    parseLines([JSON.stringify({ type: 'text', data: 'hi' })], result);
    expect((result.messages[0] as { model?: string }).model).toBe('grok-4.5');
  });
});

describe('parseGrokEvent end events', () => {
  it('maps EndTurn to end and sets turns to 1', () => {
    const result = makeResult();
    parseLines(
      [
        JSON.stringify({ type: 'text', data: 'done' }),
        JSON.stringify({ type: 'end', stopReason: 'EndTurn', sessionId: 's1', requestId: 'r1' }),
      ],
      result
    );
    expect(result.stopReason).toBe('end');
    expect(result.usage.turns).toBe(1);
    expect((result.messages[0] as { stopReason?: string }).stopReason).toBe('end');
  });

  it('maps Cancelled to max_turns', () => {
    const result = makeResult();
    parseLines(
      [JSON.stringify({ type: 'end', stopReason: 'Cancelled', sessionId: 's1', requestId: 'r1' })],
      result
    );
    expect(result.stopReason).toBe('max_turns');
    expect(result.usage.turns).toBe(1);
  });

  it('passes through unknown stopReason values', () => {
    const result = makeResult();
    parseLines(
      [
        JSON.stringify({
          type: 'end',
          stopReason: 'SomethingNew',
          sessionId: 's1',
          requestId: 'r1',
        }),
      ],
      result
    );
    expect(result.stopReason).toBe('SomethingNew');
  });

  it('calls onUpdate on end event', () => {
    const result = makeResult();
    const updates = parseLines([JSON.stringify({ type: 'end', stopReason: 'EndTurn' })], result);
    expect(updates).toBe(1);
  });

  it('creates a synthetic assistant message with stopReason when no text arrived', () => {
    const result = makeResult('grok-4.5');
    parseLines([JSON.stringify({ type: 'end', stopReason: 'EndTurn' })], result);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].content).toEqual([]);
    expect((result.messages[0] as { stopReason?: string }).stopReason).toBe('end');
    expect((result.messages[0] as { model?: string }).model).toBe('grok-4.5');
    expect(result.stopReason).toBe('end');
    expect(result.usage.turns).toBe(1);
  });
});

describe('parseGrokEvent thought events', () => {
  it('ignores thought events without creating messages', () => {
    const result = makeResult();
    parseLines([JSON.stringify({ type: 'thought', data: 'thinking...' })], result);
    expect(result.messages).toHaveLength(0);
    expect(result.usage.turns).toBe(0);
  });

  it('does not call onUpdate for thought events', () => {
    const result = makeResult();
    const updates = parseLines([JSON.stringify({ type: 'thought', data: 'hmm' })], result);
    expect(updates).toBe(0);
  });
});

describe('parseGrokEvent turn boundaries', () => {
  it('splits text into separate messages when thought follows text', () => {
    const result = makeResult();
    parseLines(
      [
        JSON.stringify({ type: 'text', data: 'Preamble one.' }),
        JSON.stringify({ type: 'thought', data: 'Now I should do X.' }),
        JSON.stringify({ type: 'text', data: 'Preamble two.' }),
        JSON.stringify({ type: 'thought', data: 'Now I should do Y.' }),
        JSON.stringify({ type: 'text', data: '## Completed\n\nFinal output.' }),
        JSON.stringify({ type: 'end', stopReason: 'EndTurn' }),
      ],
      result
    );
    expect(result.messages).toHaveLength(3);
    expect((result.messages[0].content[0] as { text: string }).text).toBe('Preamble one.');
    expect((result.messages[1].content[0] as { text: string }).text).toBe('Preamble two.');
    expect((result.messages[2].content[0] as { text: string }).text).toBe(
      '## Completed\n\nFinal output.'
    );
  });

  it('getFinalOutput returns only the last turn', () => {
    const result = makeResult();
    parseLines(
      [
        JSON.stringify({ type: 'text', data: 'First preamble.' }),
        JSON.stringify({ type: 'thought', data: 'thinking' }),
        JSON.stringify({ type: 'text', data: '## Completed\n\nDone.' }),
        JSON.stringify({ type: 'end', stopReason: 'EndTurn' }),
      ],
      result
    );
    expect(getFinalOutput(result.messages)).toBe('## Completed\n\nDone.');
  });

  it('counts turns from assistant message count', () => {
    const result = makeResult();
    parseLines(
      [
        JSON.stringify({ type: 'text', data: 'Turn 1.' }),
        JSON.stringify({ type: 'thought', data: 'thinking' }),
        JSON.stringify({ type: 'text', data: 'Turn 2.' }),
        JSON.stringify({ type: 'thought', data: 'thinking' }),
        JSON.stringify({ type: 'text', data: 'Turn 3.' }),
        JSON.stringify({ type: 'end', stopReason: 'EndTurn' }),
      ],
      result
    );
    expect(result.usage.turns).toBe(3);
  });

  it('does not split when thoughts precede text (first-turn thinking)', () => {
    const result = makeResult();
    parseLines(
      [
        JSON.stringify({ type: 'thought', data: 'Let me think...' }),
        JSON.stringify({ type: 'thought', data: '...about this.' }),
        JSON.stringify({ type: 'text', data: 'Answer.' }),
        JSON.stringify({ type: 'end', stopReason: 'EndTurn' }),
      ],
      result
    );
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0].content[0] as { text: string }).text).toBe('Answer.');
    expect(result.usage.turns).toBe(1);
  });

  it('preserves newlines within a single turn', () => {
    const result = makeResult();
    parseLines(
      [
        JSON.stringify({ type: 'text', data: 'Line1' }),
        JSON.stringify({ type: 'text', data: '\n\n' }),
        JSON.stringify({ type: 'text', data: 'Line2' }),
        JSON.stringify({ type: 'end', stopReason: 'EndTurn' }),
      ],
      result
    );
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0].content[0] as { text: string }).text).toBe('Line1\n\nLine2');
  });

  it('handles multiple thoughts between turns without extra splits', () => {
    const result = makeResult();
    parseLines(
      [
        JSON.stringify({ type: 'text', data: 'First.' }),
        JSON.stringify({ type: 'thought', data: 'a' }),
        JSON.stringify({ type: 'thought', data: 'b' }),
        JSON.stringify({ type: 'thought', data: 'c' }),
        JSON.stringify({ type: 'text', data: 'Second.' }),
        JSON.stringify({ type: 'end', stopReason: 'EndTurn' }),
      ],
      result
    );
    expect(result.messages).toHaveLength(2);
  });

  it('sets stopReason on the last message', () => {
    const result = makeResult();
    parseLines(
      [
        JSON.stringify({ type: 'text', data: 'First.' }),
        JSON.stringify({ type: 'thought', data: 'thinking' }),
        JSON.stringify({ type: 'text', data: 'Second.' }),
        JSON.stringify({ type: 'end', stopReason: 'EndTurn' }),
      ],
      result
    );
    expect(result.messages).toHaveLength(2);
    expect((result.messages[0] as { stopReason?: string }).stopReason).toBeUndefined();
    expect((result.messages[1] as { stopReason?: string }).stopReason).toBe('end');
  });
});

describe('parseGrokEvent edge cases', () => {
  it('ignores empty lines', () => {
    const result = makeResult();
    parseLines(['', '   ', '\t'], result);
    expect(result.messages).toHaveLength(0);
  });

  it('ignores invalid JSON', () => {
    const result = makeResult();
    parseLines(['not json', '{broken', ''], result);
    expect(result.messages).toHaveLength(0);
  });

  it('ignores non-object JSON', () => {
    const result = makeResult();
    parseLines(['42', '"string"', 'null', 'true'], result);
    expect(result.messages).toHaveLength(0);
  });

  it('ignores text events with non-string data', () => {
    const result = makeResult();
    parseLines([JSON.stringify({ type: 'text', data: 123 })], result);
    expect(result.messages).toHaveLength(0);
  });

  it('ignores unknown event types', () => {
    const result = makeResult();
    parseLines([JSON.stringify({ type: 'unknown', data: 'x' })], result);
    expect(result.messages).toHaveLength(0);
  });
});
