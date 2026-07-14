// ABOUTME: Unit tests for PiRpcTransport framing, requests, UI cancellation, and disposal.
// ABOUTME: Uses an injected fake child process; no real Pi CLI or network access.

import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import {
  buildUiCancelResponse,
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

describe('PiRpcTransport framing', () => {
  it('parses multiple LF-delimited records and strips trailing CR', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    child.pushStdout('{"type":"agent_start"}\r\n{"type":"agent_end"}\n');
    await new Promise((r) => setImmediate(r));

    expect(events).toEqual([{ type: 'agent_start' }, { type: 'agent_end' }]);
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

  it('fails closed when an unterminated record exceeds 2 MiB', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const big = Buffer.alloc(2 * 1024 * 1024 + 100, 0x41);
    child.pushStdout(big);
    await new Promise((r) => setImmediate(r));
    await expect(transport.getState()).rejects.toBeInstanceOf(PiRpcTransportError);
    await transport.dispose();
  });

  it('fails closed on a same-chunk terminated oversized record before JSON.parse', async () => {
    const child = new FakeChild();
    const transport = await spawnTransport(child);
    const events: unknown[] = [];
    transport.subscribe((e) => events.push(e));

    // Complete LF-terminated line larger than 2 MiB in a single chunk must not
    // reach JSON.parse / event listeners.
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 50, 0x42);
    const line = Buffer.concat([Buffer.from('{"type":"x","p":"'), oversized, Buffer.from('"}\n')]);
    child.pushStdout(line);
    await new Promise((r) => setImmediate(r));

    expect(events.some((e) => (e as { type?: string }).type === 'x')).toBe(false);
    await expect(transport.prompt('x')).rejects.toBeInstanceOf(PiRpcTransportError);
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
});

describe('PiRpcTransport requests', () => {
  it('correlates responses by id including out-of-order replies', async () => {
    const child = new FakeChild();
    let id = 0;
    const transport = await spawnTransport(child, {
      requestIdGenerator: () => `r${++id}`,
    });

    const p1 = transport.request({ type: 'get_state' });
    const p2 = transport.request({ type: 'get_messages' });
    await new Promise((r) => setImmediate(r));

    // respond to second first
    child.pushStdout(
      JSON.stringify({
        id: 'r2',
        type: 'response',
        command: 'get_messages',
        success: true,
        data: { messages: [{ role: 'user', content: 'hi' }] },
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

    const [state, messages] = await Promise.all([p1, p2]);
    expect((state as { success: boolean }).success).toBe(true);
    expect((messages as { success: boolean }).success).toBe(true);
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
