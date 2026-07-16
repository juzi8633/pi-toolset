// ABOUTME: Unit tests for PiRpcTransport framing, requests, UI cancellation, and disposal.
// ABOUTME: Uses an injected fake child process; no real Pi CLI or network access.

import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { MAX_STDOUT_RECORD_BYTES } from '../src/constants.ts';
import {
  buildUiCancelResponse,
  PI_RPC_TRANSPORT_EXIT,
  PiRpcTransport,
  PiRpcTransportError,
} from '../src/pi-rpc-transport.ts';
import type { SpawnFn, SpawnedChild } from '../src/execution.ts';

class FakeStdin extends Writable {
  chunks: string[] = [];
  private forceBackpressure = false;

  constructor() {
    super({ highWaterMark: 1 });
  }

  destroyForTest() {
    this.destroy();
  }

  enableBackpressure() {
    this.forceBackpressure = true;
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString('utf8'));
    if (this.forceBackpressure) {
      this.forceBackpressure = false;
      // Defer callback so write() returns false (buffer full), then drain.
      setImmediate(() => {
        callback();
        this.emit('drain');
      });
      return;
    }
    callback();
  }
}

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  stdin = new FakeStdin();
  killed = false;
  killSignals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.killSignals.push(signal);
    this.killed = true;
    if (signal === 'SIGKILL' || this.killSignals.length > 1) {
      this.exitCode = signal === 'SIGKILL' ? null : 0;
      this.signalCode = signal;
      this.stdout.push(null);
      this.stderr.push(null);
      setImmediate(() => this.emit('close', this.exitCode, signal));
    } else {
      // SIGTERM: close after microtask so dispose can escalate if needed
      setImmediate(() => {
        this.exitCode = 0;
        this.stdout.push(null);
        this.stderr.push(null);
        this.emit('close', 0, signal);
      });
    }
    return true;
  }

  pushStdout(text: string | Buffer) {
    this.stdout.push(text);
  }

  pushStderr(text: string | Buffer) {
    this.stderr.push(text);
  }
}

function makeSpawn(child: FakeChild): SpawnFn {
  return () => child as unknown as SpawnedChild;
}

async function spawnTransport(
  child: FakeChild,
  opts: Partial<Parameters<typeof PiRpcTransport.spawn>[0]> = {}
) {
  let id = 0;
  return PiRpcTransport.spawn({
    command: 'fake',
    args: ['--mode', 'rpc'],
    spawnFn: makeSpawn(child),
    requestIdGenerator: () => `id-${++id}`,
    requestTimeoutMs: 2000,
    killTimeoutMs: 50,
    ...opts,
  });
}

const STDOUT_RECORD_LIMIT_BYTES = MAX_STDOUT_RECORD_BYTES;
const STDOUT_OVERFLOW_MESSAGE = 'RPC stdout record exceeded 8 MiB';

describe('PiRpcTransport framing', () => {
  it('parses multiple LF-delimited records and strips trailing CR', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    child.pushStdout('{"type":"agent_start"}\r\n{"type":"agent_end"}\n');
    await new Promise((r) => setImmediate(r));

    expect(events).toEqual([
      { type: 'agent_start' },
      { type: 'agent_end', messages: [], messagesOmitted: true, willRetry: false },
    ]);
    await transport.dispose();
  });

  it('preserves Unicode line separators inside JSON strings', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    const payload = { type: 'note', text: 'a\u2028b\u2029c' };
    child.pushStdout(JSON.stringify(payload) + '\n');
    await new Promise((r) => setImmediate(r));

    expect(events).toEqual([payload]);
    await transport.dispose();
  });

  it('handles a multibyte code point split across chunks', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    // U+1F600 grinning face as UTF-8: F0 9F 98 80
    const json = Buffer.from('{"type":"emoji","c":"😀"}\n', 'utf8');
    child.pushStdout(json.subarray(0, 18));
    child.pushStdout(json.subarray(18));
    await new Promise((r) => setImmediate(r));

    expect((events[0] as { c: string }).c).toBe('😀');
    await transport.dispose();
  });

  it('accepts a complete record above the former 2 MiB limit', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    const payload = 'A'.repeat(2 * 1024 * 1024 + 100);
    child.pushStdout(`${JSON.stringify({ type: 'large', payload })}\n`);
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(1);
    expect((events[0] as { type: string; payload: string }).type).toBe('large');
    expect((events[0] as { type: string; payload: string }).payload).toHaveLength(payload.length);
    await transport.dispose();
  });

  it('accepts the historical 2,320,362-byte agent_end regression under 8 MiB', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    // Preceding small model/context error must stay ordered before the large agent_end.
    const modelError = {
      type: 'error',
      error: 'model_context_overflow',
      message: 'context window exceeded',
    };
    child.pushStdout(`${JSON.stringify(modelError)}\n`);

    // Historical shape: 1 user + 50 assistant + 92 tool-result messages (143 total).
    const messages: Array<Record<string, unknown>> = [];
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: 'historical-user' }],
    });
    for (let i = 0; i < 50; i++) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: `assistant-${i}-${'A'.repeat(12000)}` }],
        usage: { input: 100 + i, output: 50 + i, totalTokens: 150 + i },
      });
    }
    for (let i = 0; i < 92; i++) {
      messages.push({
        role: 'toolResult',
        toolCallId: `call_${i}`,
        toolName: `tool_${i % 7}`,
        content: [{ type: 'text', text: `tool-result-${i}-${'B'.repeat(8000)}` }],
        isError: false,
      });
    }
    expect(messages).toHaveLength(143);

    // Pad the final tool result so the serialized agent_end is exactly 2,320,362 bytes.
    const targetBytes = 2_320_362;
    const baseMessages = messages.slice(0, -1);
    const last = messages[messages.length - 1]!;
    const lastContent = (last.content as Array<{ type: string; text: string }>)[0]!;
    let pad = 0;
    const buildAgentEndLine = (padding: number): string =>
      JSON.stringify({
        type: 'agent_end',
        messages: [
          ...baseMessages,
          {
            ...last,
            content: [{ type: 'text', text: `${lastContent.text}${'P'.repeat(padding)}` }],
          },
        ],
        willRetry: false,
      });
    let agentEndLine = buildAgentEndLine(0);
    for (;;) {
      const bytes = Buffer.byteLength(agentEndLine, 'utf8');
      if (bytes === targetBytes) break;
      if (bytes > targetBytes) {
        throw new Error(`unable to hit exact historical size: ${bytes}`);
      }
      pad += targetBytes - bytes;
      agentEndLine = buildAgentEndLine(pad);
    }
    expect(Buffer.byteLength(agentEndLine, 'utf8')).toBe(targetBytes);
    expect(targetBytes).toBeLessThan(STDOUT_RECORD_LIMIT_BYTES);

    child.pushStdout(`${agentEndLine}\n`);
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(modelError);
    // Transport compactly rewrites every agent_end regardless of size under 8 MiB.
    expect(events[1]).toEqual({
      type: 'agent_end',
      messages: [],
      messagesOmitted: true,
      willRetry: false,
    });
    await transport.dispose();
  });

  it('accepts a complete record exactly at the 8 MiB limit', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    const prefix = '{"type":"boundary","payload":"';
    const suffix = '"}';
    const payloadLength = STDOUT_RECORD_LIMIT_BYTES - Buffer.byteLength(prefix + suffix);
    const line = `${prefix}${'A'.repeat(payloadLength)}${suffix}`;
    expect(Buffer.byteLength(line)).toBe(STDOUT_RECORD_LIMIT_BYTES);

    child.pushStdout(`${line}\n`);
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe('boundary');
    await transport.dispose();
  });

  it('fails closed when an unterminated record exceeds 8 MiB', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    // Unterminated ordinary JSON (no closing quote/brace/LF) past the 8 MiB budget.
    const prefix = '{"type":"x","payload":"';
    const big = prefix + 'A'.repeat(STDOUT_RECORD_LIMIT_BYTES + 1 - Buffer.byteLength(prefix));
    expect(Buffer.byteLength(big)).toBe(STDOUT_RECORD_LIMIT_BYTES + 1);
    child.pushStdout(big);
    await new Promise((r) => setImmediate(r));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: PI_RPC_TRANSPORT_EXIT,
        error: expect.objectContaining({
          code: 'stdout_overflow',
          message: STDOUT_OVERFLOW_MESSAGE,
        }),
      })
    );
    await transport.dispose();
  });

  it('fails closed one byte above the 8 MiB limit before JSON.parse', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    const prefix = '{"type":"x","payload":"';
    const suffix = '"}';
    const payloadLength = STDOUT_RECORD_LIMIT_BYTES + 1 - Buffer.byteLength(prefix + suffix);
    const line = `${prefix}${'B'.repeat(payloadLength)}${suffix}`;
    expect(Buffer.byteLength(line)).toBe(STDOUT_RECORD_LIMIT_BYTES + 1);

    child.pushStdout(`${line}\n`);
    await new Promise((r) => setImmediate(r));

    expect(events.some((e) => (e as { type?: string }).type === 'x')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: PI_RPC_TRANSPORT_EXIT,
        error: expect.objectContaining({
          code: 'stdout_overflow',
          message: STDOUT_OVERFLOW_MESSAGE,
        }),
      })
    );
    await transport.dispose();
  });

  it('fails closed on malformed JSON', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    child.pushStdout('not-json\n');
    await new Promise((r) => setImmediate(r));
    await expect(transport.prompt('x')).rejects.toBeInstanceOf(PiRpcTransportError);
    await transport.dispose();
  });

  it('projects a canonical agent_end between 8.2 and 8.3 MiB and stays synchronized', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    const targetMin = Math.floor(8.2 * 1024 * 1024);
    const targetMax = Math.floor(8.3 * 1024 * 1024);
    const pad = 'P'.repeat(targetMin);
    let line = JSON.stringify({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: pad }],
      willRetry: false,
    });
    // Grow until inside the 8.2–8.3 MiB window.
    while (Buffer.byteLength(line, 'utf8') < targetMin) {
      line = JSON.stringify({
        type: 'agent_end',
        messages: [
          { role: 'assistant', content: pad + 'P'.repeat(Buffer.byteLength(line, 'utf8')) },
        ],
        willRetry: false,
      });
    }
    // If overshoot, rebuild with exact padding from a measured base.
    if (Buffer.byteLength(line, 'utf8') > targetMax) {
      const base = JSON.stringify({
        type: 'agent_end',
        messages: [{ role: 'assistant', content: '' }],
        willRetry: false,
      });
      const need = targetMin - Buffer.byteLength(base, 'utf8');
      line = JSON.stringify({
        type: 'agent_end',
        messages: [{ role: 'assistant', content: 'P'.repeat(Math.max(need, 0)) }],
        willRetry: false,
      });
    }
    const bytes = Buffer.byteLength(line, 'utf8');
    expect(bytes).toBeGreaterThan(STDOUT_RECORD_LIMIT_BYTES);
    expect(bytes).toBeGreaterThanOrEqual(targetMin);
    expect(bytes).toBeLessThanOrEqual(targetMax);

    const follow = JSON.stringify({ type: 'agent_start' });
    child.pushStdout(`${line}\n${follow}\n`);
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: 'agent_end',
      messages: [],
      messagesOmitted: true,
      willRetry: false,
    });
    expect(events[1]).toEqual({ type: 'agent_start' });
    await transport.dispose();
  });

  it('projects oversized canonical message/tool/turn shells', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    const big = 'X'.repeat(8 * 1024 * 1024 + 1000);
    const messageEnd = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: big },
    });
    const turnEnd = JSON.stringify({
      type: 'turn_end',
      message: { role: 'assistant', content: big },
      toolResults: [],
    });
    const toolEnd = JSON.stringify({
      type: 'tool_execution_end',
      toolCallId: 'call_9',
      toolName: 'bash',
      result: big,
      isError: false,
    });
    expect(Buffer.byteLength(messageEnd, 'utf8')).toBeGreaterThan(STDOUT_RECORD_LIMIT_BYTES);

    child.pushStdout(`${messageEnd}\n${turnEnd}\n${toolEnd}\n`);
    await new Promise((r) => setImmediate(r));

    expect(events).toEqual([
      { type: 'message_end', payloadOmitted: true, role: 'assistant' },
      { type: 'turn_end', payloadOmitted: true },
      {
        type: 'tool_execution_end',
        payloadOmitted: true,
        toolCallId: 'call_9',
        toolName: 'bash',
        isError: false,
      },
    ]);
    await transport.dispose();
  });

  it('fails ordinary unknown records one byte above 8 MiB', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    const prefix = '{"type":"response","id":"1","payload":"';
    const suffix = '"}';
    const payloadLength = STDOUT_RECORD_LIMIT_BYTES + 1 - Buffer.byteLength(prefix + suffix);
    const line = `${prefix}${'Z'.repeat(payloadLength)}${suffix}`;
    expect(Buffer.byteLength(line)).toBe(STDOUT_RECORD_LIMIT_BYTES + 1);

    child.pushStdout(`${line}\n`);
    await new Promise((r) => setImmediate(r));

    expect(events.some((e) => (e as { type?: string }).type === 'response')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: PI_RPC_TRANSPORT_EXIT,
        error: expect.objectContaining({
          code: 'stdout_overflow',
          message: STDOUT_OVERFLOW_MESSAGE,
        }),
      })
    );
    await transport.dispose();
  });

  it('compacts small agent_end regardless of key order', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    // Non-canonical key order still delivers a compact shell under 8 MiB.
    child.pushStdout(
      '{"willRetry":true,"messages":[{"role":"user","content":"hi"}],"type":"agent_end"}\n'
    );
    await new Promise((r) => setImmediate(r));

    expect(events).toEqual([
      { type: 'agent_end', messages: [], messagesOmitted: true, willRetry: true },
    ]);
    await transport.dispose();
  });

  it('delivers a prior same-chunk record before a later overflow failure', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    const good = JSON.stringify({ type: 'error', message: 'model_context_overflow' });
    const prefix = '{"type":"response","id":"1","payload":"';
    const suffix = '"}';
    const payloadLength = STDOUT_RECORD_LIMIT_BYTES + 1 - Buffer.byteLength(prefix + suffix);
    const bad = `${prefix}${'Z'.repeat(payloadLength)}${suffix}`;

    child.pushStdout(`${good}\n${bad}\n`);
    await new Promise((r) => setImmediate(r));

    expect(events[0]).toEqual({ type: 'error', message: 'model_context_overflow' });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: PI_RPC_TRANSPORT_EXIT,
        error: expect.objectContaining({
          code: 'stdout_overflow',
          message: STDOUT_OVERFLOW_MESSAGE,
        }),
      })
    );
    await transport.dispose();
  });
});

describe('PiRpcTransport requests', () => {
  it('correlates responses by id including out-of-order replies', async () => {
    const child = new FakeChild();
    let id = 0;
    const transport = await spawnTransport(child, {
      requestIdGenerator: () => `r${++id}`,
    });

    const p1 = transport.request({ type: 'get_state' });
    const p2 = transport.request({ type: 'get_state' });
    await new Promise((r) => setImmediate(r));

    // respond to second first
    child.pushStdout(
      JSON.stringify({
        id: 'r2',
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 's2',
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'one-at-a-time',
          autoCompactionEnabled: true,
          messageCount: 1,
          pendingMessageCount: 0,
        },
      }) + '\n'
    );
    child.pushStdout(
      JSON.stringify({
        id: 'r1',
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 's1',
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'one-at-a-time',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      }) + '\n'
    );

    const [state1, state2] = await Promise.all([p1, p2]);
    expect((state1 as { success: boolean }).success).toBe(true);
    expect((state2 as { success: boolean }).success).toBe(true);
    await transport.dispose();
  });

  it('rejects get_messages before allocating request state or writing stdin', async () => {
    const child = new FakeChild();
    let idCalls = 0;
    const transport = await spawnTransport(child, {
      requestIdGenerator: () => `id-${++idCalls}`,
    });

    await expect(transport.request({ type: 'get_messages' })).rejects.toMatchObject({
      name: 'PiRpcTransportError',
      code: 'get_messages_disabled',
      message: 'get_messages is disabled; hydrate the validated sessionFile instead',
    });
    expect(idCalls).toBe(0);
    expect(child.stdin.chunks).toEqual([]);

    // A subsequent legitimate request still gets the first generated id.
    const statePromise = transport.request({ type: 'get_state' });
    await new Promise((r) => setImmediate(r));
    expect(idCalls).toBe(1);
    expect(child.stdin.chunks.some((c) => c.includes('"id":"id-1"'))).toBe(true);
    child.pushStdout(
      JSON.stringify({
        id: 'id-1',
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          sessionId: 's1',
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'one-at-a-time',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      }) + '\n'
    );
    await expect(statePromise).resolves.toMatchObject({ success: true });
    await transport.dispose();
  });

  it('publishes non-response records in stdout order', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const order: string[] = [];
    transport.subscribe((e) => order.push((e as { type: string }).type));

    child.pushStdout('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['a', 'b', 'c']);
    await transport.dispose();
  });

  it('awaits drain when write returns false', async () => {
    const child = new FakeChild();
    child.stdin.enableBackpressure();
    const transport = await spawnTransport(child);

    const promptP = transport.prompt('hello');
    // Allow backpressure callback + drain to fire before the response.
    await new Promise((r) => setTimeout(r, 20));
    child.pushStdout(
      JSON.stringify({ id: 'id-1', type: 'response', command: 'prompt', success: true }) + '\n'
    );
    await promptP;
    expect(child.stdin.chunks.some((c) => c.includes('hello'))).toBe(true);
    await transport.dispose();
  });

  it('rejects writes after close', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    child.stdin.destroyForTest();
    await expect(transport.prompt('x')).rejects.toBeInstanceOf(Error);
    await transport.dispose();
  });
});

describe('PiRpcTransport stderr and UI', () => {
  it('retains only the final 1 MiB of stderr with truncation marker', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const big = Buffer.alloc(1 * 1024 * 1024 + 500, 0x62);
    child.pushStderr(big);
    await new Promise((r) => setImmediate(r));
    const stderr = transport.getStderr();
    expect(stderr.startsWith('[stderr truncated]\n')).toBe(true);
    expect(Buffer.byteLength(stderr, 'utf8')).toBeLessThanOrEqual(
      1 * 1024 * 1024 + '[stderr truncated]\n'.length
    );
    await transport.dispose();
  });

  it('replies to dialog UI requests with complete cancellation envelopes', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);

    child.pushStdout(
      JSON.stringify({
        type: 'extension_ui_request',
        id: 'ui-1',
        method: 'select',
        title: 'Pick',
        options: ['a'],
      }) + '\n'
    );
    child.pushStdout(
      JSON.stringify({
        type: 'extension_ui_request',
        id: 'ui-2',
        method: 'confirm',
        title: 'Sure?',
        message: 'y/n',
      }) + '\n'
    );
    child.pushStdout(
      JSON.stringify({
        type: 'extension_ui_request',
        id: 'ui-3',
        method: 'notify',
        message: 'hi',
      }) + '\n'
    );
    await new Promise((r) => setTimeout(r, 20));

    const joined = child.stdin.chunks.join('');
    expect(joined).toContain('"id":"ui-1"');
    expect(joined).toContain('"cancelled":true');
    expect(joined).toContain('"id":"ui-2"');
    expect(joined).toContain('"confirmed":false');
    expect(joined).not.toContain('"id":"ui-3"');
    await transport.dispose();
  });

  it('buildUiCancelResponse covers all dialog methods', () => {
    expect(
      buildUiCancelResponse({
        type: 'extension_ui_request',
        id: '1',
        method: 'input',
        title: 't',
      })
    ).toEqual({ type: 'extension_ui_response', id: '1', cancelled: true });
    expect(
      buildUiCancelResponse({
        type: 'extension_ui_request',
        id: '2',
        method: 'editor',
        title: 't',
      })
    ).toEqual({ type: 'extension_ui_response', id: '2', cancelled: true });
    expect(
      buildUiCancelResponse({
        type: 'extension_ui_request',
        id: '3',
        method: 'notify',
        message: 'x',
      })
    ).toBeUndefined();
  });
});

describe('PiRpcTransport lifecycle', () => {
  it('rejects pending requests once on process exit and includes stderr', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    child.pushStderr('boom-detail');
    const pending = transport.getState();
    await new Promise((r) => setImmediate(r));
    child.exitCode = 1;
    child.emit('close', 1, null);
    await expect(pending).rejects.toMatchObject({
      message: expect.stringContaining('exited'),
    });
    try {
      await pending;
    } catch (err) {
      expect((err as PiRpcTransportError).stderr).toContain('boom-detail');
    }
    await transport.dispose();
  });

  it('abort is a turn command and does not exit the process', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const abortP = transport.abort();
    await new Promise((r) => setImmediate(r));
    child.pushStdout(
      JSON.stringify({ id: 'id-1', type: 'response', command: 'abort', success: true }) + '\n'
    );
    await abortP;
    expect(child.killed).toBe(false);
    await transport.dispose();
  });

  it('dispose is idempotent and uses SIGTERM then SIGKILL timeout', async () => {
    const child = new FakeChild();
    // override kill to not auto-close on SIGTERM so SIGKILL path runs
    const originalKill = child.kill.bind(child);
    child.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
      child.killSignals.push(signal);
      child.killed = true;
      if (signal === 'SIGKILL') {
        setImmediate(() => {
          child.exitCode = null;
          child.emit('close', null, 'SIGKILL');
        });
      }
      return true;
    };
    const transport = await spawnTransport(child, { killTimeoutMs: 20 });
    await transport.dispose();
    await transport.dispose();
    expect(child.killSignals[0]).toBe('SIGTERM');
    // restore
    child.kill = originalKill;
  });

  it('does not settle dispose before child close after SIGKILL', async () => {
    const child = new FakeChild();
    let closed = false;
    child.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
      child.killSignals.push(signal);
      child.killed = true;
      if (signal === 'SIGKILL') {
        // Close after SIGKILL but within the hard dispose bound (killTimeoutMs).
        setTimeout(() => {
          closed = true;
          child.exitCode = null;
          child.emit('close', null, 'SIGKILL');
        }, 35);
      }
      return true;
    };
    // SIGTERM wait 40ms → SIGKILL → close at +35ms (hard bound 40ms) → settle.
    const transport = await spawnTransport(child, { killTimeoutMs: 40 });
    let disposeSettled = false;
    const disposeP = transport.dispose().then(() => {
      disposeSettled = true;
    });
    // After SIGKILL (~40ms) but before close (~75ms): dispose must still be pending.
    await new Promise((r) => setTimeout(r, 55));
    expect(child.killSignals).toContain('SIGKILL');
    expect(closed).toBe(false);
    expect(disposeSettled).toBe(false);
    await disposeP;
    expect(closed).toBe(true);
    expect(disposeSettled).toBe(true);
  });

  it('rejects dispose when SIGKILL fails so reopen can fail closed', async () => {
    const child = new FakeChild();
    child.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
      child.killSignals.push(signal);
      child.killed = true;
      if (signal === 'SIGKILL') return false;
      return true;
    };
    const transport = await spawnTransport(child, { killTimeoutMs: 15 });
    await expect(transport.dispose()).rejects.toMatchObject({
      code: 'dispose_failed',
      message: expect.stringContaining('SIGKILL'),
    });
    // Shared dispose promise stays rejected for concurrent waiters.
    await expect(transport.dispose()).rejects.toMatchObject({ code: 'dispose_failed' });
  });

  it('rejects dispose when close never arrives after SIGKILL (hard bound)', async () => {
    const child = new FakeChild();
    child.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
      child.killSignals.push(signal);
      child.killed = true;
      // Never emit close after SIGKILL.
      return true;
    };
    const transport = await spawnTransport(child, { killTimeoutMs: 15 });
    await expect(transport.dispose()).rejects.toMatchObject({
      code: 'dispose_failed',
      message: expect.stringMatching(/close|SIGKILL/i),
    });
  });
});

describe('PiRpcTransport rejection and shared dispose', () => {
  it('rejects prompt/steer/follow_up/abort when RPC success is false', async () => {
    const child = new FakeChild();
    let id = 0;
    const transport = await spawnTransport(child, {
      requestIdGenerator: () => `id-${++id}`,
    });

    const promptP = transport.prompt('hello');
    await new Promise((r) => setImmediate(r));
    child.pushStdout(
      JSON.stringify({
        id: 'id-1',
        type: 'response',
        command: 'prompt',
        success: false,
        error: 'agent is streaming; specify streamingBehavior',
      }) + '\n'
    );
    await expect(promptP).rejects.toMatchObject({
      code: 'rpc_rejected',
      message: expect.stringContaining('streaming'),
    });

    const steerP = transport.steer('nudge');
    await new Promise((r) => setImmediate(r));
    child.pushStdout(
      JSON.stringify({
        id: 'id-2',
        type: 'response',
        command: 'steer',
        success: false,
        error: 'not running',
      }) + '\n'
    );
    await expect(steerP).rejects.toMatchObject({ code: 'rpc_rejected' });

    const followP = transport.followUp('later');
    await new Promise((r) => setImmediate(r));
    child.pushStdout(
      JSON.stringify({
        id: 'id-3',
        type: 'response',
        command: 'follow_up',
        success: false,
        error: 'queue full',
      }) + '\n'
    );
    await expect(followP).rejects.toMatchObject({ code: 'rpc_rejected' });

    const abortP = transport.abort();
    await new Promise((r) => setImmediate(r));
    child.pushStdout(
      JSON.stringify({
        id: 'id-4',
        type: 'response',
        command: 'abort',
        success: false,
        error: 'nothing to abort',
      }) + '\n'
    );
    await expect(abortP).rejects.toMatchObject({ code: 'rpc_rejected' });

    await transport.dispose();
  });

  it('notifies subscribers on unexpected process exit after prompt acceptance', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    const promptP = transport.prompt('go');
    await new Promise((r) => setImmediate(r));
    child.pushStdout(
      JSON.stringify({ id: 'id-1', type: 'response', command: 'prompt', success: true }) + '\n'
    );
    await promptP;

    child.exitCode = 1;
    child.emit('close', 1, null);
    await new Promise((r) => setImmediate(r));

    const exitEvent = events.find(
      (e) => e && typeof e === 'object' && (e as { type?: string }).type === 'pi_rpc_transport_exit'
    ) as { intentional: boolean; error: { message: string } } | undefined;
    expect(exitEvent).toBeDefined();
    expect(exitEvent!.intentional).toBe(false);
    expect(exitEvent!.error.message).toContain('exited');
    await transport.dispose();
  });

  it('shares in-flight dispose so concurrent callers wait for full exit', async () => {
    const child = new FakeChild();
    const originalKill = child.kill.bind(child);
    let closeArmed = false;
    child.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
      child.killSignals.push(signal);
      child.killed = true;
      if (signal === 'SIGTERM') {
        // Delay close so concurrent dispose callers share the wait.
        setTimeout(() => {
          closeArmed = true;
          child.exitCode = 0;
          child.emit('close', 0, signal);
        }, 30);
        return true;
      }
      return originalKill(signal);
    };

    const transport = await spawnTransport(child, { killTimeoutMs: 200 });
    const d1 = transport.dispose();
    const d2 = transport.dispose();
    await Promise.all([d1, d2]);
    expect(closeArmed).toBe(true);
    expect(child.killSignals.filter((s) => s === 'SIGTERM').length).toBe(1);
    await transport.dispose();
  });
});
