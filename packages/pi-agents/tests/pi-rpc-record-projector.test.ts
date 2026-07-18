// ABOUTME: Unit tests for the incremental Pi RPC record projector.
// ABOUTME: Covers framing, grammar, exact-prefix classification, caps, and shell projection.

import { describe, expect, it } from 'bun:test';
import {
  createPiRpcRecordProjector,
  PiRpcProjectorError,
  type PiRpcProjectedRecord,
} from '../src/pi-rpc-record-projector.ts';

function projectAll(
  chunks: Array<string | Buffer>,
  limits?: Parameters<typeof createPiRpcRecordProjector>[0]
): PiRpcProjectedRecord[] {
  const projector = createPiRpcRecordProjector(limits);
  const out: PiRpcProjectedRecord[] = [];
  for (const chunk of chunks) out.push(...projector.push(chunk));
  out.push(...projector.finish());
  return out;
}

function expectOverflow(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected stdout_overflow');
  } catch (err) {
    expect(err).toBeInstanceOf(PiRpcProjectorError);
    expect((err as PiRpcProjectorError).code).toBe('stdout_overflow');
  }
}

function expectMalformed(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected malformed_json');
  } catch (err) {
    expect(err).toBeInstanceOf(PiRpcProjectorError);
    expect((err as PiRpcProjectorError).code).toBe('malformed_json');
  }
}

describe('PiRpcRecordProjector framing', () => {
  it('parses multiple LF records and strips one trailing CR', () => {
    const out = projectAll(['{"type":"a"}\r\n{"type":"b"}\n']);
    // Byte count includes the optional trailing CR (overflow accounting) while
    // the emitted ordinary line has the CR stripped.
    expect(out).toEqual([
      { kind: 'ordinary', line: '{"type":"a"}', bytes: Buffer.byteLength('{"type":"a"}\r') },
      { kind: 'ordinary', line: '{"type":"b"}', bytes: Buffer.byteLength('{"type":"b"}') },
    ]);
  });

  it('preserves U+2028 and U+2029 inside JSON strings', () => {
    const line = JSON.stringify({ type: 'note', text: 'a\u2028b\u2029c' });
    const out = projectAll([`${line}\n`]);
    expect(out).toEqual([{ kind: 'ordinary', line, bytes: Buffer.byteLength(line) }]);
  });

  it('handles multibyte UTF-8 split across chunks', () => {
    const json = Buffer.from('{"type":"emoji","c":"😀"}\n', 'utf8');
    const out = projectAll([json.subarray(0, 18), json.subarray(18)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('ordinary');
    expect(JSON.parse((out[0] as { line: string }).line).c).toBe('😀');
  });

  it('emits multiple complete records from one chunk and keeps a partial', () => {
    const projector = createPiRpcRecordProjector();
    const first = projector.push('{"type":"a"}\n{"type":"b"}\n{"type":"c"');
    expect(first).toHaveLength(2);
    const rest = projector.push('}\n');
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ kind: 'ordinary', line: '{"type":"c"}' });
  });

  it('finish() completes an unterminated final record', () => {
    const out = projectAll(['{"type":"tail"}']);
    expect(out).toEqual([
      {
        kind: 'ordinary',
        line: '{"type":"tail"}',
        bytes: Buffer.byteLength('{"type":"tail"}'),
      },
    ]);
  });
});

describe('PiRpcRecordProjector grammar', () => {
  it('rejects trailing commas', () => {
    expectMalformed(() => projectAll(['{"type":"x",}\n']));
  });

  it('rejects invalid numbers and literals', () => {
    expectMalformed(() => projectAll(['{"n":01}\n']));
    expectMalformed(() => projectAll(['{"n":tru}\n']));
  });

  it('rejects invalid escapes and incomplete unicode', () => {
    expectMalformed(() => projectAll(['{"a":"\\q"}\n']));
    expectMalformed(() => projectAll(['{"a":"\\u12"}\n']));
  });

  it('accepts escaped quotes and backslashes', () => {
    const line = '{"type":"x","s":"a\\"b\\\\c"}';
    const out = projectAll([`${line}\n`]);
    expect(out[0]).toMatchObject({ kind: 'ordinary', line });
  });

  it('rejects depth overflow', () => {
    expectMalformed(() => projectAll(['{"a":{"b":1}}'], { maxDepth: 1 }));
  });

  it('overflows when a duplicate top-level key revokes projectability past ordinary cap', () => {
    const pad = 'x'.repeat(200);
    const line = `{"type":"agent_end","messages":[{"c":"${pad}"}],"willRetry":false,"type":"dup"}`;
    expectOverflow(() =>
      projectAll([`${line}\n`], {
        ordinaryMaxBytes: 80,
        projectableMaxBytes: 10_000,
      })
    );
  });
});

describe('PiRpcRecordProjector classification and projection', () => {
  const smallLimits = {
    ordinaryMaxBytes: 200,
    projectableMaxBytes: 10_000,
    shellFieldMaxBytes: 32,
    prefixProbeBytes: 64,
    maxDepth: 32,
  };

  it('emits ordinary for small canonical agent_end', () => {
    const line = JSON.stringify({
      type: 'agent_end',
      messages: [{ role: 'user', content: 'hi' }],
      willRetry: false,
    });
    const out = projectAll([`${line}\n`], smallLimits);
    expect(out).toEqual([{ kind: 'ordinary', line, bytes: Buffer.byteLength(line) }]);
  });

  it('projects oversized exact-prefix agent_end shell', () => {
    const messages = [{ role: 'assistant', content: 'X'.repeat(500) }];
    const line = JSON.stringify({ type: 'agent_end', messages, willRetry: true });
    expect(Buffer.byteLength(line)).toBeGreaterThan(smallLimits.ordinaryMaxBytes);
    const out = projectAll([`${line}\n`], smallLimits);
    expect(out).toEqual([
      {
        kind: 'projected',
        bytes: Buffer.byteLength(line),
        requiresSettleRehydrate: false,
        event: {
          type: 'agent_end',
          messages: [],
          messagesOmitted: true,
          willRetry: true,
        },
      },
    ]);
  });

  it('projects oversized message_end with role and requires rehydrate', () => {
    const line = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: 'Y'.repeat(500) },
    });
    const out = projectAll([`${line}\n`], smallLimits);
    expect(out).toEqual([
      {
        kind: 'projected',
        bytes: Buffer.byteLength(line),
        requiresSettleRehydrate: true,
        event: {
          type: 'message_end',
          payloadOmitted: true,
          role: 'assistant',
        },
      },
    ]);
  });

  it('projects oversized message_update with exact runtime key order', () => {
    const line = JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'z' },
      message: { role: 'assistant', content: 'Z'.repeat(500) },
    });
    const out = projectAll([`${line}\n`], smallLimits);
    expect(out[0]).toMatchObject({
      kind: 'projected',
      requiresSettleRehydrate: true,
      event: { type: 'message_update', payloadOmitted: true, role: 'assistant' },
    });
  });

  it('projects tool_execution_end shell fields including isError', () => {
    const line = JSON.stringify({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'bash',
      result: 'R'.repeat(500),
      isError: true,
    });
    const out = projectAll([`${line}\n`], smallLimits);
    expect(out[0]).toMatchObject({
      kind: 'projected',
      requiresSettleRehydrate: true,
      event: {
        type: 'tool_execution_end',
        payloadOmitted: true,
        toolCallId: 'call_1',
        toolName: 'bash',
        isError: true,
      },
    });
  });

  it('projects turn_end without identity fields', () => {
    const line = JSON.stringify({
      type: 'turn_end',
      message: { role: 'assistant', content: 'T'.repeat(500) },
      toolResults: [{ toolCallId: 'c', content: 'ok' }],
    });
    const out = projectAll([`${line}\n`], smallLimits);
    expect(out[0]).toMatchObject({
      kind: 'projected',
      requiresSettleRehydrate: true,
      event: { type: 'turn_end', payloadOmitted: true },
    });
  });

  it('keeps reordered projectable keys ordinary and fails above ordinary cap', () => {
    // willRetry before messages — not canonical.
    const line = JSON.stringify({
      type: 'agent_end',
      willRetry: false,
      messages: [{ x: 'M'.repeat(500) }],
    });
    // JSON.stringify key order follows insertion: type, willRetry, messages
    expectOverflow(() => projectAll([`${line}\n`], smallLimits));
  });

  it('fails unknown oversized events at ordinary cap', () => {
    const line = JSON.stringify({ type: 'response', id: '1', payload: 'P'.repeat(500) });
    expectOverflow(() => projectAll([`${line}\n`], smallLimits));
  });

  it('fails projectable records above projectable cap', () => {
    const line = JSON.stringify({
      type: 'agent_end',
      messages: [{ content: 'Q'.repeat(300) }],
      willRetry: false,
    });
    expectOverflow(() =>
      projectAll([`${line}\n`], {
        ordinaryMaxBytes: 50,
        projectableMaxBytes: 100,
      })
    );
  });

  it('revokes projectability when required shell string exceeds budget', () => {
    const longId = 'c'.repeat(64);
    const line = JSON.stringify({
      type: 'tool_execution_start',
      toolCallId: longId,
      toolName: 'bash',
      args: { x: 'A'.repeat(400) },
    });
    expectOverflow(() =>
      projectAll([`${line}\n`], {
        ...smallLimits,
        shellFieldMaxBytes: 16,
      })
    );
  });

  it('does not emit a synthetic event on late invalidation after ordinary cap', () => {
    // Canonical until extra key arrives after crossing ordinary budget.
    const base = `{"type":"agent_end","messages":[{"c":"${'X'.repeat(300)}"}],"willRetry":false`;
    // Missing closing } — add extra key that breaks prefix length.
    const line = `${base},"extra":1}`;
    expectOverflow(() => projectAll([`${line}\n`], smallLimits));
  });

  it('covers every byte split for a representative projectable prefix', () => {
    const line = JSON.stringify({
      type: 'message_start',
      message: { role: 'user', content: 'C'.repeat(400) },
    });
    const buf = Buffer.from(`${line}\n`, 'utf8');
    for (let split = 1; split < buf.length; split++) {
      const out = projectAll([buf.subarray(0, split), buf.subarray(split)], smallLimits);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        kind: 'projected',
        event: { type: 'message_start', payloadOmitted: true, role: 'user' },
      });
    }
  });

  it('keeps following records synchronized after a projected record', () => {
    const big = JSON.stringify({
      type: 'agent_end',
      messages: [{ content: 'B'.repeat(400) }],
      willRetry: false,
    });
    const small = JSON.stringify({ type: 'agent_start' });
    const out = projectAll([`${big}\n${small}\n`], smallLimits);
    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe('projected');
    expect(out[1]).toEqual({
      kind: 'ordinary',
      line: small,
      bytes: Buffer.byteLength(small),
    });
  });

  it('counts non-BMP UTF-8 bytes exactly', () => {
    const line = JSON.stringify({ type: 'emoji', c: '😀'.repeat(10) });
    const out = projectAll([`${line}\n`]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'ordinary',
      line,
      bytes: Buffer.byteLength(line, 'utf8'),
    });
  });

  it('fails ordinary unknown types at ordinary cap even with large whitespace after type key', () => {
    // type is known non-projectable before crossing ordinary; must not ride projectable budget.
    const line = `{"type":"response","payload":"${'P'.repeat(400)}"}`;
    expectOverflow(() => projectAll([`${line}\n`], smallLimits));
  });

  it('fails at ordinary cap when type is still unknown past ordinary budget', () => {
    // Spaces before first key keep type unknown — never grant projectable budget.
    const line = `{${' '.repeat(250)}"type":"agent_end","messages":[],"willRetry":false}`;
    expectOverflow(() => projectAll([`${line}\n`], smallLimits));
  });

  it('rejects array trailing commas', () => {
    expectMalformed(() => projectAll(['{"a":[1,]}\n']));
    expectMalformed(() => projectAll(['{"a":[1,2,]}\n']));
  });

  it('projects tool_execution_start and tool_execution_update shells', () => {
    const start = JSON.stringify({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { cmd: 'X'.repeat(400) },
    });
    const update = JSON.stringify({
      type: 'tool_execution_update',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { cmd: 'y' },
      partialResult: 'P'.repeat(400),
    });
    const out = projectAll([`${start}\n${update}\n`], smallLimits);
    expect(out[0]).toMatchObject({
      kind: 'projected',
      requiresSettleRehydrate: true,
      event: {
        type: 'tool_execution_start',
        payloadOmitted: true,
        toolCallId: 'c1',
        toolName: 'bash',
      },
    });
    expect(out[1]).toMatchObject({
      kind: 'projected',
      requiresSettleRehydrate: true,
      event: {
        type: 'tool_execution_update',
        payloadOmitted: true,
        toolCallId: 'c1',
        toolName: 'bash',
      },
    });
  });

  it('treats nested duplicate keys as ordinary under the ordinary cap', () => {
    const line = '{"type":"note","a":{"k":1,"k":2}}';
    const out = projectAll([`${line}\n`], smallLimits);
    expect(out[0]).toMatchObject({ kind: 'ordinary', line });
  });

  it('preserves prior complete records when a later same-chunk record fails', () => {
    const good = JSON.stringify({ type: 'error', message: 'model_context_overflow' });
    const bad = '{"type":"x","payload":"' + 'P'.repeat(500);
    const projector = createPiRpcRecordProjector(smallLimits);
    try {
      projector.push(`${good}\n${bad}`);
      throw new Error('expected overflow');
    } catch (err) {
      expect(err).toBeInstanceOf(PiRpcProjectorError);
      const pe = err as PiRpcProjectorError;
      expect(pe.code).toBe('stdout_overflow');
      expect(pe.priorRecords).toEqual([
        { kind: 'ordinary', line: good, bytes: Buffer.byteLength(good) },
      ]);
    }
  });

  // Bulk-field structural type validation
  it('revokes projectability when messages is an object instead of array', () => {
    const limits = { ordinaryMaxBytes: 128, projectableMaxBytes: 1024 };
    const record = JSON.stringify({
      type: 'agent_end',
      messages: { notAnArray: true },
      willRetry: false,
    });
    const out = projectAll([`${record}\n`], limits);
    expect(out).toEqual([{ kind: 'ordinary', line: record, bytes: Buffer.byteLength(record) }]);
  });

  it('fails at ordinary cap when messages is an object and exceeds budget', () => {
    const limits = { ordinaryMaxBytes: 128, projectableMaxBytes: 1024 };
    const record = JSON.stringify({
      type: 'agent_end',
      messages: { notAnArray: true },
      willRetry: false,
      oversized: 'X'.repeat(200),
    });
    expectOverflow(() => projectAll([`${record}\n`], limits));
  });

  it('revokes projectability when toolResults is not an array', () => {
    const limits = { ordinaryMaxBytes: 128, projectableMaxBytes: 1024 };
    const record = JSON.stringify({
      type: 'turn_end',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      toolResults: 'not-an-array',
    });
    const out = projectAll([`${record}\n`], limits);
    expect(out).toEqual([{ kind: 'ordinary', line: record, bytes: Buffer.byteLength(record) }]);
  });

  it('revokes projectability when message is an array instead of object', () => {
    const limits = { ordinaryMaxBytes: 128, projectableMaxBytes: 1024 };
    const record = JSON.stringify({
      type: 'message_end',
      message: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
    });
    const out = projectAll([`${record}\n`], limits);
    expect(out).toEqual([{ kind: 'ordinary', line: record, bytes: Buffer.byteLength(record) }]);
  });

  it('revokes projectability when assistantMessageEvent is an array instead of object', () => {
    const limits = { ordinaryMaxBytes: 200, projectableMaxBytes: 1024 };
    const record = JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: ['not-an-object'],
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    });
    const out = projectAll([`${record}\n`], limits);
    expect(out).toEqual([{ kind: 'ordinary', line: record, bytes: Buffer.byteLength(record) }]);
  });

  // Scalar/wrong-kind regressions for constrained bulk fields
  it('fails at ordinary cap when messages is an oversized string', () => {
    const limits = { ordinaryMaxBytes: 128, projectableMaxBytes: 1024 };
    const record = JSON.stringify({
      type: 'agent_end',
      messages: 'X'.repeat(200),
      willRetry: false,
    });
    expectOverflow(() => projectAll([`${record}\n`], limits));
  });

  it('fails at ordinary cap when messages is an oversized number', () => {
    const limits = { ordinaryMaxBytes: 128, projectableMaxBytes: 1024 };
    const record = JSON.stringify({
      type: 'agent_end',
      messages: Number.MAX_SAFE_INTEGER,
      willRetry: false,
      pad: 'X'.repeat(120),
    });
    expectOverflow(() => projectAll([`${record}\n`], limits));
  });

  it('fails at ordinary cap when messages is an oversized boolean', () => {
    const limits = { ordinaryMaxBytes: 128, projectableMaxBytes: 1024 };
    const record = JSON.stringify({
      type: 'agent_end',
      messages: true,
      willRetry: false,
      pad: 'X'.repeat(120),
    });
    expectOverflow(() => projectAll([`${record}\n`], limits));
  });

  it('fails at ordinary cap when messages is an oversized null', () => {
    const limits = { ordinaryMaxBytes: 128, projectableMaxBytes: 1024 };
    const record = JSON.stringify({
      type: 'agent_end',
      messages: null,
      willRetry: false,
      pad: 'X'.repeat(120),
    });
    expectOverflow(() => projectAll([`${record}\n`], limits));
  });

  it('fails at ordinary cap when toolResults is an oversized string', () => {
    const limits = { ordinaryMaxBytes: 128, projectableMaxBytes: 1024 };
    const record = JSON.stringify({
      type: 'turn_end',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      toolResults: 'Y'.repeat(200),
    });
    expectOverflow(() => projectAll([`${record}\n`], limits));
  });

  it('fails at ordinary cap when message is an oversized string', () => {
    const limits = { ordinaryMaxBytes: 128, projectableMaxBytes: 1024 };
    const record = JSON.stringify({
      type: 'message_end',
      message: 'Z'.repeat(200),
    });
    expectOverflow(() => projectAll([`${record}\n`], limits));
  });

  it('fails at ordinary cap when assistantMessageEvent is an oversized string', () => {
    const limits = { ordinaryMaxBytes: 128, projectableMaxBytes: 1024 };
    const record = JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: 'W'.repeat(200),
      message: { role: 'assistant', content: [] },
    });
    expectOverflow(() => projectAll([`${record}\n`], limits));
  });

  it('keeps a small scalar wrong-kind messages record ordinary (at/below 8 MiB)', () => {
    const limits = { ordinaryMaxBytes: 128, projectableMaxBytes: 1024 };
    const record = JSON.stringify({
      type: 'agent_end',
      messages: 'small-string',
      willRetry: false,
    });
    const out = projectAll([`${record}\n`], limits);
    expect(out).toEqual([{ kind: 'ordinary', line: record, bytes: Buffer.byteLength(record) }]);
  });

  // Positive controls for any-typed fields (args, partialResult, result)
  it('still projects tool_execution_start with any-typed args as array', () => {
    const record = JSON.stringify({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'echo',
      args: ['an', 'array', 'of', 'args'],
    });
    const out = projectAll([`${record}\n`]);
    expect(out).toEqual([{ kind: 'ordinary', line: record, bytes: Buffer.byteLength(record) }]);
  });

  it('still projects tool_execution_start with any-typed args as null', () => {
    const record = JSON.stringify({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'echo',
      args: null,
    });
    const out = projectAll([`${record}\n`]);
    expect(out).toEqual([{ kind: 'ordinary', line: record, bytes: Buffer.byteLength(record) }]);
  });

  it('still projects tool_execution_end with any-typed result as scalar', () => {
    const record = JSON.stringify({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'echo',
      result: 42,
      isError: false,
    });
    const out = projectAll([`${record}\n`]);
    expect(out).toEqual([{ kind: 'ordinary', line: record, bytes: Buffer.byteLength(record) }]);
  });

  it('still projects oversized tool_execution_start with any-typed args as array', () => {
    const limits = { ordinaryMaxBytes: 60, projectableMaxBytes: 2048 };
    const oversizedArgs = Array.from({ length: 30 }, (_, i) => `item-${i}`);
    const record = JSON.stringify({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'echo',
      args: oversizedArgs,
    });
    const out = projectAll([`${record}\n`], limits);
    expect(out[0]!.kind).toBe('projected');
    if (out[0]!.kind === 'projected') {
      expect(out[0]!.event.type).toBe('tool_execution_start');
    }
  });

  it('still projects oversized tool_execution_update with any-typed partialResult as object', () => {
    const limits = { ordinaryMaxBytes: 60, projectableMaxBytes: 2048 };
    const record = JSON.stringify({
      type: 'tool_execution_update',
      toolCallId: 't1',
      toolName: 'echo',
      args: { key: 'val' },
      partialResult: { items: Array.from({ length: 40 }, (_, i) => ({ n: i })) },
    });
    const out = projectAll([`${record}\n`], limits);
    expect(out[0]!.kind).toBe('projected');
    if (out[0]!.kind === 'projected') {
      expect(out[0]!.event.type).toBe('tool_execution_update');
    }
  });
});
