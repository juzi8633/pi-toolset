// ABOUTME: Synthetic end-to-end memory regressions for compact parent/durable results.
// ABOUTME: Asserts raw tool-result bodies stay out of parent details while final output is preserved.

import { describe, expect, it } from 'bun:test';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES,
  RESULT_UPDATE_INTERVAL_MS,
} from '../src/constants.ts';
import { runChainWorkflow, type ChainItemInput, type ChainStepRequest } from '../src/chain.ts';
import { createInteractiveAgentRegistry, MAX_IDLE_TRANSPORTS } from '../src/interactive-agent.ts';
import { createRunCoordinator, agentFingerprint } from '../src/run-coordinator.ts';
import { createRunStore } from '../src/run-store.ts';
import { snapshotResults, snapshotSingleResult } from '../src/result-snapshot.ts';
import { discoverAgents, type AgentConfig } from '../src/agents.ts';
import type { SingleResult, SubagentDetails } from '../src/types.ts';
import { emptyUsage } from '../src/types.ts';
import { createLatestValueCoalescer } from '../src/update-coalescer.ts';
import type { PiRpcTransport } from '../src/pi-rpc-transport.ts';
import { executeAgentTool } from '../src/tool.ts';

function assistant(text: string, toolName?: string): SingleResult['messages'][number] {
  if (toolName) {
    return {
      role: 'assistant',
      content: [
        { type: 'toolCall', name: toolName, arguments: { path: 'file.ts' } },
        { type: 'text', text },
      ],
    } as never;
  }
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  } as never;
}

function toolResult(body: string): SingleResult['messages'][number] {
  return {
    role: 'toolResult',
    toolCallId: 'tc',
    toolName: 'bash',
    content: [{ type: 'text', text: body }],
    isError: false,
  } as never;
}

function base(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: 'explore',
    agentSource: 'user',
    task: 't',
    exitCode: 0,
    status: 'completed',
    messages: [],
    stderr: '',
    usage: emptyUsage(),
    ...overrides,
  };
}

function makeAgent(): AgentConfig {
  return {
    name: 'explore',
    description: 'test',
    systemPrompt: 'You explore.',
    source: 'user',
    filePath: '/tmp/explore.md',
  };
}

describe('memory regressions', () => {
  it('100-turn synthetic stream excludes raw tool bodies from parent snapshot', () => {
    const body = 'T'.repeat(64 * 1024);
    const messages: SingleResult['messages'] = [];
    for (let i = 0; i < 100; i++) {
      messages.push(assistant(`turn ${i} note`, 'read'));
      messages.push(toolResult(body));
    }
    messages.push(assistant('FINAL_ANSWER'));
    const snap = snapshotSingleResult(base({ messages, finalOutput: 'FINAL_ANSWER' }));
    const json = JSON.stringify(snap);
    expect(json).not.toContain(body);
    expect(snap.messages).toEqual([]);
    expect(snap.finalOutput).toBe('FINAL_ANSWER');
    expect(snap.presentation?.transcript.some((i) => i.type === 'toolCall')).toBe(true);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(2 * 1024 * 1024);
  });

  it('eight-item fanout details stay compact with ordered isolation and identity', () => {
    const body = 'R'.repeat(64 * 1024);
    const earlyUpdates: SingleResult[][] = [];
    const results: SingleResult[] = [];
    for (let i = 0; i < 8; i++) {
      results.push(
        snapshotSingleResult(
          base({
            task: `item ${i}`,
            messages: [assistant(`note ${i}`, 'bash'), toolResult(body), assistant(`done ${i}`)],
            finalOutput: `done ${i}`,
            structuredOutput: { i },
            fanout: { index: i, count: 8 },
            unitId: `u-${i}`,
            sessionFile: `/tmp/s-${i}.jsonl`,
            usage: { ...emptyUsage(), input: i + 1, output: i + 2, turns: 1 },
          })
        )
      );
      // Retain early aggregate shells as later slots fill (CoW isolation).
      earlyUpdates.push(snapshotResults(results));
    }
    const details = { mode: 'parallel', results: snapshotResults(results) };
    const json = JSON.stringify(details);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(2 * 1024 * 1024);
    expect(json).not.toContain(body);
    expect(details.results).toHaveLength(8);
    for (let i = 0; i < 8; i++) {
      const r = details.results[i]!;
      expect(r.finalOutput).toBe(`done ${i}`);
      expect(r.structuredOutput).toEqual({ i });
      expect(r.sessionFile).toBe(`/tmp/s-${i}.jsonl`);
      expect(r.messages).toEqual([]);
      expect(r.usage.input).toBe(i + 1);
      expect(r.fanout?.index).toBe(i);
    }
    // Early retained aggregates stay isolated from later growth.
    expect(earlyUpdates[0]).toHaveLength(1);
    expect(earlyUpdates[0]![0]!.finalOutput).toBe('done 0');
    expect(earlyUpdates[0]![0]!.structuredOutput).toEqual({ i: 0 });
    // Owned snapshot identity is shared for frozen payloads.
    const first = details.results[0]!;
    const clone = snapshotSingleResult(first);
    expect(clone.presentation).toBe(first.presentation);
    expect(clone.structuredOutput).toBe(first.structuredOutput);
  });

  it('eight-item chain fanout through real workflow bounds updates and isolates early shells', async () => {
    const body = 'R'.repeat(64 * 1024);
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'find items',
        name: 'context',
        outputSchema: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
      },
      {
        expand: { from: { output: 'context', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'results' },
        concurrency: 4,
      },
    ];

    const parentUpdates: SubagentDetails[] = [];
    const fanoutTexts: string[] = [];
    let updateCount = 0;
    // Fake timers for the real fanout content coalescer seam.
    let coalescerHandler: (() => void) | undefined;
    let coalescerArmed = 0;
    let coalescerFired = 0;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    // Patch only RESULT_UPDATE-length timers used by the fanout coalescer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).setTimeout = (handler: (...args: unknown[]) => void, ms?: number) => {
      if (ms === RESULT_UPDATE_INTERVAL_MS) {
        coalescerArmed += 1;
        coalescerHandler = () => {
          coalescerFired += 1;
          handler();
        };
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler as never, ms as never);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).clearTimeout = (handle: unknown) => {
      if (handle === 1) {
        coalescerHandler = undefined;
        return;
      }
      return originalClearTimeout(handle as never);
    };

    // Hold first-wave workers mid-flight so many concurrent partials share one interval.
    const firstWaveLetters = new Set(['a', 'b', 'c', 'd']);
    const releaseFirstWave: Array<() => void> = [];
    let firstWaveReady = 0;
    let resolveFirstWaveReady: (() => void) | undefined;
    const firstWaveReadyPromise = new Promise<void>((r) => {
      resolveFirstWaveReady = r;
    });

    try {
      const workflowPromise = runChainWorkflow({
        chain,
        signal: undefined,
        makeDetails: (results) => ({
          mode: 'chain',
          agentScope: 'user',
          projectAgentsDir: null,
          builtinAgentsDir: '/tmp',
          results,
        }),
        onUpdate: (partial) => {
          if (!partial.details) return;
          updateCount += 1;
          const text = Array.isArray(partial.content)
            ? partial.content.map((c) => ('text' in c ? String(c.text) : '')).join('')
            : '';
          if (text.startsWith('Fanout:')) fanoutTexts.push(text);
          // Retain early parent details shells for isolation assertions.
          parentUpdates.push({
            ...partial.details,
            results: partial.details.results.map((r) => ({ ...r, usage: { ...r.usage } })),
          });
        },
        runStep: async (req: ChainStepRequest) => {
          if (req.agent === 'explore') {
            return {
              ...base({
                agent: req.agent,
                task: req.task,
                messages: [assistant(JSON.stringify({ items }))],
                finalOutput: JSON.stringify({ items }),
                step: req.step,
                status: 'completed',
                exitCode: 0,
              }),
            };
          }
          const match = /Process ([a-h])/.exec(req.task);
          const letter = match?.[1] ?? 'a';
          const index = letter.charCodeAt(0) - 'a'.charCodeAt(0);
          // Many progressive content partials per worker inside the same fake-clock interval.
          for (let p = 0; p < 20; p++) {
            req.onUpdate?.({
              content: [{ type: 'text', text: `working ${letter} p${p}` }],
              details: {
                mode: 'single',
                agentScope: 'user',
                projectAgentsDir: null,
                builtinAgentsDir: '/tmp',
                results: [
                  base({
                    agent: req.agent,
                    task: req.task,
                    status: 'running',
                    exitCode: -1,
                    messages: [assistant(`working ${letter} p${p}`, 'bash'), toolResult(body)],
                    step: req.step,
                    fanout: { index, count: 8, itemTask: req.task },
                    usage: { ...emptyUsage(), input: index + 1, turns: 1 },
                    finalOutput: `partial-${letter}-${p}`,
                  }),
                ],
              },
            });
          }
          if (firstWaveLetters.has(letter)) {
            firstWaveReady += 1;
            if (firstWaveReady === firstWaveLetters.size) resolveFirstWaveReady?.();
            await new Promise<void>((resolve) => {
              releaseFirstWave.push(resolve);
            });
          }
          return base({
            agent: req.agent,
            task: req.task,
            messages: [
              assistant(`note ${letter}`, 'bash'),
              toolResult(body),
              assistant(`done ${letter}`),
            ],
            finalOutput: `done ${letter}`,
            structuredOutput: { i: index },
            fanout: { index, count: 8, itemTask: req.task },
            unitId: `u-${index}`,
            sessionFile: `/tmp/s-${index}.jsonl`,
            usage: { ...emptyUsage(), input: index + 1, output: index + 2, turns: 1 },
            step: req.step,
            status: 'completed',
            exitCode: 0,
          });
        },
      });

      // Wait until four concurrent workers have each emitted 20 partials.
      await firstWaveReadyPromise;
      const updatesBeforeFire = updateCount;
      const textsBeforeFire = fanoutTexts.length;
      // Exactly one coalesced content emission for the armed interval.
      expect(coalescerHandler).toBeDefined();
      coalescerHandler?.();
      expect(coalescerFired).toBe(1);
      expect(updateCount).toBe(updatesBeforeFire + 1);
      expect(fanoutTexts.length).toBe(textsBeforeFire + 1);
      // Latest aggregate should reflect concurrent first-wave running workers.
      const latest = fanoutTexts[fanoutTexts.length - 1]!;
      expect(latest).toMatch(/Fanout:.*running/);

      // Release first wave; second wave runs to completion with structural immediates.
      for (const release of releaseFirstWave) release();
      const res = await workflowPromise;
      // Terminal may cancel pending content timer; fire any leftover for determinism.
      coalescerHandler?.();

      expect(res.isError).toBeUndefined();
      const fanout = res.details.results.filter((r) => r.fanout);
      expect(fanout).toHaveLength(8);
      // Cumulative stable ordering by fanout index.
      expect(fanout.map((r) => r.fanout?.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      for (let i = 0; i < 8; i++) {
        const r = fanout[i]!;
        expect(r.finalOutput).toBe(`done ${items[i]}`);
        expect(r.structuredOutput).toEqual({ i });
        expect(r.sessionFile).toBe(`/tmp/s-${i}.jsonl`);
        expect(r.messages).toEqual([]);
        expect(r.usage.input).toBe(i + 1);
        expect(r.usage.output).toBe(i + 2);
      }

      // Content partials alone would be 8*20; coalescing + structural immediates stay far lower.
      expect(updateCount).toBeGreaterThan(0);
      expect(updateCount).toBeLessThan(8 * 20);
      // At least one content-interval fire occurred for the concurrent partial burst.
      expect(coalescerFired).toBeGreaterThanOrEqual(1);
      expect(coalescerArmed).toBeGreaterThanOrEqual(1);

      // Terminal ordering: final details are completed and compact.
      expect(fanout.every((r) => r.status === 'completed')).toBe(true);
      const finalJson = JSON.stringify(res.details);
      expect(Buffer.byteLength(finalJson, 'utf8')).toBeLessThan(2 * 1024 * 1024);
      expect(finalJson).not.toContain(body);

      // Retained early parent update isolation: first fanout-bearing update stays stable.
      const firstFanoutUpdate = parentUpdates.find((d) => d.results.some((r) => r.fanout));
      expect(firstFanoutUpdate).toBeDefined();
      if (firstFanoutUpdate) {
        const earlyCount = firstFanoutUpdate.results.filter((r) => r.fanout).length;
        expect(earlyCount).toBeGreaterThanOrEqual(1);
        const earlyFirst = firstFanoutUpdate.results.find((r) => r.fanout);
        if (earlyFirst) {
          earlyFirst.finalOutput = 'MUTATED';
          if (earlyFirst.structuredOutput && typeof earlyFirst.structuredOutput === 'object') {
            (earlyFirst.structuredOutput as { i?: number }).i = 999;
          }
        }
        expect(fanout[0]!.finalOutput).toBe('done a');
        expect(fanout[0]!.structuredOutput).toEqual({ i: 0 });
      }
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it('legacy durable large-record resume compacts via coordinator; read-only leaves unchanged', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-mem-durable-'));
    try {
      const store = createRunStore({ rootDir: root });
      const coordinator = createRunCoordinator({ store });
      // Use the real discovered explore agent so resume fingerprint checks pass.
      const agent =
        discoverAgents(process.cwd(), 'both').agents.find((a) => a.name === 'explore') ??
        makeAgent();
      const big = 'Q'.repeat(4 * 1024 * 1024);
      // Raw legacy fixture with full messages — not pre-snapshotted.
      const fat = base({
        messages: [assistant('note', 'bash'), toolResult(big), assistant('done')],
        finalOutput: 'done',
      });
      const sessionFile = path.join(root, 'legacy-session.jsonl');
      fs.writeFileSync(sessionFile, '{}\n');
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'explore',
          task: 't',
        },
        details: {
          mode: 'single',
          agentScope: 'both',
          projectAgentsDir: null,
          builtinAgentsDir: '/builtin',
          results: [fat, fat],
        },
        units: {
          single: {
            unitId: 'single',
            agent: 'explore',
            agentFingerprint: agentFingerprint(agent),
            runtime: undefined,
            capability: 'session',
            status: 'interrupted',
            attempt: 1,
            attempts: [{ attempt: 1, status: 'interrupted', startedAt: Date.now() - 1000 }],
            effectiveCwd: root,
            sessionFile,
            sessionPromptEstablished: true,
            result: fat,
          },
        },
      });
      await store.updateRun(runId, (r) => {
        r.status = 'interrupted';
      });

      // Read-only inspection must leave the large legacy record unchanged on disk.
      const before = fs.readFileSync(path.join(store.getRunDir(runId), 'run.json'), 'utf8');
      expect(before).toContain(big.slice(0, 64));
      expect(Buffer.byteLength(before, 'utf8')).toBeGreaterThan(4 * 1024 * 1024);
      const inspected = store.getRun(runId);
      expect(inspected.ok).toBe(true);
      const afterInspect = fs.readFileSync(path.join(store.getRunDir(runId), 'run.json'), 'utf8');
      expect(afterInspect).toBe(before);

      // Active resume routes the raw fixture through claim + normalization + coordinator write.
      const result = await executeAgentTool(
        { runId },
        undefined,
        undefined,
        {
          cwd: process.cwd(),
          mode: 'tui',
          hasUI: false,
          ui: {
            confirm: async () => true,
            select: async () => undefined,
            input: async () => undefined,
            notify: () => {},
          },
        } as never,
        {
          runWorkflow: async () => ({
            content: [{ type: 'text', text: 'resumed' }],
            details: {
              mode: 'single',
              agentScope: 'both',
              projectAgentsDir: null,
              builtinAgentsDir: '/builtin',
              results: [],
            },
          }),
          runStore: store,
          runCoordinator: coordinator,
        }
      );
      const resultText = Array.isArray(result.content)
        ? result.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
        : String(result.content);
      expect(resultText).not.toMatch(/resume_error|preflight_failed|claim_failed/);
      expect(result.isError).toBeUndefined();

      const after = store.getRun(runId);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      const unitResult = after.loaded.record.units.single!.result!;
      // Active resume writes compact unit result (empty messages + presentation).
      expect(unitResult.messages).toEqual([]);
      expect(unitResult.finalOutput).toBe('done');
      expect(unitResult.presentation).toBeDefined();
      const detailsResults = after.loaded.record.details.results ?? [];
      for (const r of detailsResults) {
        // Compact shells only — no raw 4 MiB tool bodies in details.
        expect(r.messages ?? []).toEqual([]);
      }
      const disk = fs.readFileSync(path.join(store.getRunDir(runId), 'run.json'), 'utf8');
      expect(disk).not.toContain(big.slice(0, 64));
      expect(Buffer.byteLength(disk, 'utf8')).toBeLessThan(512 * 1024);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('one-registry LRU warm retention: >MAX_IDLE_TRANSPORTS idle + one oversized', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-mem-ia-'));
    const store = createRunStore({ rootDir: root });
    const coordinator = createRunCoordinator({ store });
    const agent = makeAgent();

    // Per-endpoint event listener so each transport can emit independently.
    const listeners = new Map<string, (e: unknown) => void>();
    let factoryN = 0;
    let clock = 1_000_000;
    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      clock: () => clock,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        const id = `t-${factoryN++}`;
        return {
          async getState() {
            return {
              sessionId: id,
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt() {},
          async steer() {},
          async followUp() {},
          async abort() {},
          subscribe(fn: (e: unknown) => void) {
            listeners.set(id, fn);
            return () => {
              listeners.delete(id);
            };
          },
          async dispose() {},
          getStderr() {
            return '';
          },
          __id: id,
        } as unknown as PiRpcTransport;
      },
    });
    registry.setHostLinkAppender(() => undefined);

    async function registerOne(
      hostSessionId: string,
      unitSuffix: string
    ): Promise<{ key: string; sessionFile: string }> {
      const { runId, record } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'explore',
          task: `look-${unitSuffix}`,
        },
        details: {
          mode: 'single',
          agentScope: 'both',
          projectAgentsDir: null,
          builtinAgentsDir: '/builtin',
          results: [],
        },
        units: {
          single: {
            unitId: 'single',
            agent: 'explore',
            agentFingerprint: agentFingerprint(agent),
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      // Meaningful session history so lazy hydration after LRU eviction is real.
      const header = {
        type: 'session',
        version: 3,
        id: `sess-${unitSuffix}`,
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp',
      };
      const historyLine = {
        type: 'message',
        id: `m-${unitSuffix}`,
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `disk-history-${unitSuffix}` }],
          timestamp: Date.now(),
        },
      };
      fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(historyLine)}\n`);
      await store.updateRun(runId, (r) => {
        r.units.single.sessionFile = sessionFile;
        r.status = 'running';
      });
      const live = store.getRun(runId);
      if (live.ok) coordinator.registerRun(runId, live.loaded.record);
      const snap = await registry.registerInitial({
        runId,
        unitId: 'single',
        hostSessionId,
        launchSpec: {
          agent,
          request: record.request,
          sessionFile,
          effectiveCwd: root,
          agentScope: 'both',
          registrationKind: 'initial',
        },
        getBranchEntries: () => [],
      });
      return { key: snap.key, sessionFile };
    }

    // ~96 KiB per warm endpoint — under per-endpoint idle max, large enough that
    // retaining all of them would be meaningful under the warm ceiling.
    const warmPayload = 'W'.repeat(96 * 1024);

    try {
      const warmCount = MAX_IDLE_TRANSPORTS + 2;
      const warmKeys: string[] = [];
      const warmMarkers: string[] = [];
      for (let i = 0; i < warmCount; i++) {
        const { key } = await registerOne(`host-warm-${i}`, `warm-${i}`);
        warmKeys.push(key);
        const marker = `warm-final-${i}`;
        warmMarkers.push(marker);
        clock += 100;
        await registry.activate(key, `Task warm ${i}`, 'prompt', undefined, 'tool_call');
        await new Promise((r) => setImmediate(r));
        const latestId = `t-${factoryN - 1}`;
        const fn = listeners.get(latestId);
        expect(fn).toBeDefined();
        fn?.({
          type: 'message_end',
          message: {
            role: 'user',
            content: `warm-user-${i}:${warmPayload}`,
          },
        });
        fn?.({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `${marker}:${warmPayload}` }],
          },
        });
        fn?.({ type: 'agent_start' });
        fn?.({ type: 'agent_settled' });
        // Drain settle transition + deferred idle LRU chain.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setTimeout(r, 0));
      }
      expect(warmKeys).toHaveLength(warmCount);

      // One oversized endpoint that must settle-project then total-evict transcript.
      const { key: oversizedKey } = await registerOne('host-oversize', 'oversize');
      let settledCount = 0;
      let settledMessages = 0;
      registry.subscribe((e) => {
        if (e.type === 'activation_settled' && e.key === oversizedKey) {
          settledCount += 1;
          settledMessages = e.snapshot.messages.length;
        }
      });
      clock += 100;
      await registry.activate(oversizedKey, 'Task oversize', 'prompt', undefined, 'tool_call');
      await new Promise((r) => setImmediate(r));
      const overFn = listeners.get(`t-${factoryN - 1}`);
      expect(overFn).toBeDefined();
      const chunk = 'W'.repeat(40 * 1024);
      for (let i = 0; i < 20; i++) {
        overFn?.({
          type: 'message_end',
          message: {
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: i % 2 === 0 ? `u-${i}:${chunk}` : [{ type: 'text', text: `a-${i}:${chunk}` }],
          },
        });
      }
      overFn?.({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'OVERSIZE_FINAL' }],
        },
      });
      overFn?.({ type: 'agent_start' });
      overFn?.({ type: 'agent_settled' });
      await new Promise((r) => setImmediate(r));
      expect(settledCount).toBe(1);
      expect(settledMessages).toBeGreaterThan(2);
      // Deferred eviction + idle LRU.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 40));

      const oversized = registry.get(oversizedKey)!;
      expect(oversized.messages).toEqual([]);
      expect(oversized.hasTransport).toBe(false);
      expect(oversized.status).toBe('detached');

      // All identities remain registered (LRU detaches transport, does not remove endpoint).
      for (const key of warmKeys) {
        expect(registry.get(key)).toBeDefined();
      }
      expect(registry.get(oversizedKey)).toBeDefined();

      // Oversized settles as idle-with-client before its deferred self-detach, so it
      // participates in LRU and steals one warm slot. Final warm transports:
      // MAX_IDLE_TRANSPORTS - 1, with the oldest warmCount - (MAX_IDLE_TRANSPORTS - 1)
      // victims detached+evicted.
      const retainedWarmCount = MAX_IDLE_TRANSPORTS - 1;
      const lruVictimCount = warmCount - retainedWarmCount;
      const victimKeys = warmKeys.slice(0, lruVictimCount);
      const retainedKeys = warmKeys.slice(lruVictimCount);

      let warmTransportCount = 0;
      let warmBytes = 0;
      let totalTransportCount = 0;
      for (const ep of registry.listVisible()) {
        if (ep.hasTransport) totalTransportCount += 1;
      }
      for (const key of warmKeys) {
        const ep = registry.get(key)!;
        const bytes = Buffer.byteLength(JSON.stringify(ep.messages), 'utf8');
        warmBytes += bytes;
        if (ep.hasTransport) warmTransportCount += 1;
      }
      expect(totalTransportCount).toBeLessThanOrEqual(MAX_IDLE_TRANSPORTS);
      expect(warmTransportCount).toBe(retainedWarmCount);
      expect(retainedKeys).toHaveLength(retainedWarmCount);

      for (const key of victimKeys) {
        const ep = registry.get(key)!;
        expect(ep.status).toBe('detached');
        expect(ep.hasTransport).toBe(false);
        expect(ep.messages).toEqual([]);
      }
      for (let i = 0; i < retainedKeys.length; i++) {
        const key = retainedKeys[i]!;
        const marker = warmMarkers[lruVictimCount + i]!;
        const ep = registry.get(key)!;
        expect(ep.status).toBe('idle');
        expect(ep.hasTransport).toBe(true);
        expect(ep.messages.length).toBeGreaterThan(0);
        const text = JSON.stringify(ep.messages);
        expect(text).toContain(marker);
        // Meaningfully sized retained transcript (not a tiny placeholder).
        expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(64 * 1024);
      }

      expect(warmBytes).toBeLessThanOrEqual(
        MAX_IDLE_TRANSPORTS * INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES
      );
      // With meaningful warm payloads, retained bytes should exceed a trivial floor.
      expect(warmBytes).toBeGreaterThan(retainedWarmCount * 64 * 1024);

      // Lazy hydration eligibility: detached reloadable victims rehydrate from session.
      for (const key of victimKeys) {
        const before = registry.get(key)!;
        expect(before.messages).toEqual([]);
        const after = await registry.ensureTranscript(key);
        expect(after).toBeDefined();
        expect(after!.messages.length).toBeGreaterThan(0);
        expect(JSON.stringify(after!.messages)).toContain('disk-history-warm-');
      }
    } finally {
      await registry.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deferred oversized cleanup no-ops when a new activation starts before queued work', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-mem-race-'));
    const store = createRunStore({ rootDir: root });
    const coordinator = createRunCoordinator({ store });
    const agent = makeAgent();
    const listeners = new Map<string, (e: unknown) => void>();
    let factoryN = 0;
    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      // Keep pre-send idle-settle wait short if it ever arms; primary path settles for real.
      idleSettleWaitMs: 50,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        const id = `t-${factoryN++}`;
        return {
          async getState() {
            return {
              sessionId: id,
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt() {},
          async steer() {},
          async followUp() {},
          async abort() {},
          subscribe(fn: (e: unknown) => void) {
            listeners.set(id, fn);
            return () => {
              listeners.delete(id);
            };
          },
          async dispose() {},
          getStderr() {
            return '';
          },
        } as unknown as PiRpcTransport;
      },
    });
    registry.setHostLinkAppender(() => undefined);

    async function drain() {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 0));
    }

    try {
      const { runId, record } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'explore',
          task: 'race',
        },
        details: {
          mode: 'single',
          agentScope: 'both',
          projectAgentsDir: null,
          builtinAgentsDir: '/builtin',
          results: [],
        },
        units: {
          single: {
            unitId: 'single',
            agent: 'explore',
            agentFingerprint: agentFingerprint(agent),
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'race.jsonl');
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(
        sessionFile,
        '{"type":"session","version":3,"id":"sess-race","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
      );
      await store.updateRun(runId, (r) => {
        r.units.single.sessionFile = sessionFile;
        r.status = 'running';
      });
      const live = store.getRun(runId);
      if (live.ok) coordinator.registerRun(runId, live.loaded.record);
      const snap = await registry.registerInitial({
        runId,
        unitId: 'single',
        hostSessionId: 'host-race',
        launchSpec: {
          agent,
          request: record.request,
          sessionFile,
          effectiveCwd: root,
          agentScope: 'both',
          registrationKind: 'initial',
        },
        getBranchEntries: () => [],
      });
      const key = snap.key;

      const settledIds: string[] = [];
      const settledErrors: string[] = [];
      const settledMessageSnippets: string[] = [];
      registry.subscribe((e) => {
        if (e.type === 'activation_settled' && e.key === key) {
          settledIds.push(e.activationId);
          settledMessageSnippets.push(JSON.stringify(e.snapshot.messages));
          if (e.snapshot.lastError) settledErrors.push(e.snapshot.lastError);
        }
      });

      // --- Turn 1: small settle so endpoint is idle with an attached transport. ---
      await registry.activate(key, 'Task race warmup', 'prompt', undefined, 'tool_call');
      await drain();
      let emit = listeners.get(`t-${factoryN - 1}`);
      expect(emit).toBeDefined();
      emit?.({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'WARMUP_FINAL' }],
        },
      });
      emit?.({ type: 'agent_start' });
      emit?.({ type: 'agent_settled' });
      await drain();
      expect(settledIds.length).toBe(1);
      expect(registry.get(key)?.status).toBe('idle');

      // --- Turn 2: oversized settle that schedules deferred cleanup. ---
      await registry.activate(key, 'Task race oversized', 'prompt', undefined, 'tool_call');
      await drain();
      emit = listeners.get(`t-${factoryN - 1}`) ?? emit;
      const chunk = 'R'.repeat(40 * 1024);
      for (let i = 0; i < 20; i++) {
        emit?.({
          type: 'message_end',
          message: {
            role: i % 2 === 0 ? 'user' : 'assistant',
            content:
              i % 2 === 0 ? `ru-${i}:${chunk}` : [{ type: 'text', text: `ra-${i}:${chunk}` }],
          },
        });
      }
      emit?.({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'RACE_TURN2_OVERSIZE' }],
        },
      });
      await drain();

      // Block the transition queue before settle so we can enqueue turn-3 activate
      // after settle but before the deferred cleanup transition runs.
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      void registry._enqueueTransition(key, async () => {
        await gate;
      });

      emit?.({ type: 'agent_start' });
      emit?.({ type: 'agent_settled' });
      // Turn 3 starts while turn 2 settle is queued; syncPendingIdleSettle waits for
      // the real activation_settled, then prepare bumps the retention epoch.
      const activate3P = registry.activate(key, 'Task race 3', 'prompt', undefined, 'tool_call');

      releaseGate();
      const act3 = await activate3P;
      await drain();
      await new Promise((r) => setTimeout(r, 30));

      // Turn 2 settled; turn 3 must remain open — stale oversized cleanup must not
      // force-settle/detach the new activation or fabricate a cancel.
      expect(settledIds.length).toBe(2);
      expect(settledErrors.some((m) => /Endpoint detached|cancelled/i.test(m))).toBe(false);
      const liveEp = registry.get(key)!;
      expect(liveEp.activation?.id).toBe(act3.activationId);
      expect(liveEp.activation?.settled).not.toBe(true);
      expect(liveEp.hasTransport).toBe(true);
      expect(['starting', 'running', 'idle']).toContain(liveEp.status);

      // Finish turn 3 — marker must survive and no detach cancel is fabricated.
      const emit3 = listeners.get(`t-${factoryN - 1}`) ?? emit;
      emit3?.({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'RACE_TURN3_FINAL' }],
        },
      });
      emit3?.({ type: 'agent_start' });
      emit3?.({ type: 'agent_settled' });
      await drain();
      await new Promise((r) => setTimeout(r, 20));

      expect(settledIds.length).toBe(3);
      // Turn 3's settled snapshot must include its final output (pre-eviction).
      // Deferred retention may later empty a still-oversized reloadable transcript.
      expect(settledMessageSnippets[2]).toContain('RACE_TURN3_FINAL');
      const after = registry.get(key)!;
      expect(after.activation).toBeUndefined();
      expect(settledErrors.some((m) => /Endpoint detached/i.test(m))).toBe(false);
      // No fabricated cancel/error status for the surviving turn.
      expect(after.status === 'idle' || after.status === 'detached').toBe(true);
      expect(after.lastError).toBeUndefined();
    } finally {
      await registry.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('idle oversized endpoint still evicts when no newer activation intervenes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-mem-idle-evict-'));
    const store = createRunStore({ rootDir: root });
    const coordinator = createRunCoordinator({ store });
    const agent = makeAgent();
    const listeners = new Map<string, (e: unknown) => void>();
    let factoryN = 0;
    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        const id = `t-${factoryN++}`;
        return {
          async getState() {
            return {
              sessionId: id,
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt() {},
          async steer() {},
          async followUp() {},
          async abort() {},
          subscribe(fn: (e: unknown) => void) {
            listeners.set(id, fn);
            return () => {
              listeners.delete(id);
            };
          },
          async dispose() {},
          getStderr() {
            return '';
          },
        } as unknown as PiRpcTransport;
      },
    });
    registry.setHostLinkAppender(() => undefined);

    try {
      const { runId, record } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'explore',
          task: 'idle-evict',
        },
        details: {
          mode: 'single',
          agentScope: 'both',
          projectAgentsDir: null,
          builtinAgentsDir: '/builtin',
          results: [],
        },
        units: {
          single: {
            unitId: 'single',
            agent: 'explore',
            agentFingerprint: agentFingerprint(agent),
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'idle-evict.jsonl');
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(
        sessionFile,
        '{"type":"session","version":3,"id":"sess-idle-evict","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
      );
      await store.updateRun(runId, (r) => {
        r.units.single.sessionFile = sessionFile;
        r.status = 'running';
      });
      const live = store.getRun(runId);
      if (live.ok) coordinator.registerRun(runId, live.loaded.record);
      const snap = await registry.registerInitial({
        runId,
        unitId: 'single',
        hostSessionId: 'host-idle-evict',
        launchSpec: {
          agent,
          request: record.request,
          sessionFile,
          effectiveCwd: root,
          agentScope: 'both',
          registrationKind: 'initial',
        },
        getBranchEntries: () => [],
      });
      const key = snap.key;
      await registry.activate(key, 'Task idle-evict', 'prompt', undefined, 'tool_call');
      await new Promise((r) => setImmediate(r));
      const emit = listeners.get(`t-${factoryN - 1}`);
      expect(emit).toBeDefined();
      const chunk = 'E'.repeat(40 * 1024);
      for (let i = 0; i < 20; i++) {
        emit?.({
          type: 'message_end',
          message: {
            role: i % 2 === 0 ? 'user' : 'assistant',
            content:
              i % 2 === 0 ? `eu-${i}:${chunk}` : [{ type: 'text', text: `ea-${i}:${chunk}` }],
          },
        });
      }
      emit?.({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'IDLE_EVICT_FINAL' }],
        },
      });
      emit?.({ type: 'agent_start' });
      emit?.({ type: 'agent_settled' });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 40));

      const ep = registry.get(key)!;
      expect(ep.messages).toEqual([]);
      expect(ep.hasTransport).toBe(false);
      expect(ep.status).toBe('detached');
    } finally {
      await registry.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('externalizes 12 MiB final text so terminal SingleResult JSON stays under 1 MiB', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-mem-spill-'));
    const store = createRunStore({ rootDir: root });
    const { runId } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'spill' },
      details: {
        mode: 'single',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/b',
        results: [],
      },
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sentinel = 'SENTINEL_12MIB_PAYLOAD_MARKER';
    const large = sentinel + 'Z'.repeat(12 * 1024 * 1024);
    const { externalizeTerminalResult } = await import('../src/result-payload.ts');
    const spilled = await externalizeTerminalResult(
      {
        agent: 'explore',
        agentSource: 'user',
        task: 'spill',
        exitCode: 0,
        status: 'completed',
        messages: [],
        stderr: '',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 1,
        },
        finalOutput: large,
        structuredOutput: { body: large },
      },
      store,
      runId
    );
    const json = JSON.stringify(spilled);
    expect(json.length).toBeLessThan(1 * 1024 * 1024);
    expect(json).not.toContain(sentinel);
    expect(spilled.finalOutputRef?.bytes).toBeGreaterThan(12 * 1024 * 1024);
    expect(spilled.structuredOutputRef).toBeDefined();
    const text = await store.readTextArtifact(runId, spilled.finalOutputRef!);
    expect(text.startsWith(sentinel)).toBe(true);
    expect(text.length).toBe(large.length);
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('coalescer with deferred timer emits once for 1000 schedules', () => {
    let handler: (() => void) | undefined;
    const emitted: number[] = [];
    const c = createLatestValueCoalescer<number>(
      (v) => emitted.push(v),
      RESULT_UPDATE_INTERVAL_MS,
      {
        setTimeout(h) {
          handler = h;
          return 1;
        },
        clearTimeout() {
          handler = undefined;
        },
      }
    );
    for (let i = 0; i < 1000; i++) c.schedule(i);
    expect(emitted).toEqual([]);
    handler?.();
    expect(emitted).toEqual([999]);
  });

  it('finishUnit spills oversized structuredOutput to artifact and returns ref-only snapshot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-mem-fu-spill-'));
    try {
      const store = createRunStore({ rootDir: root });
      const coordinator = createRunCoordinator({ store });
      const sentinel = 'OVERSIZE_STRUCTURED_SENTINEL_FINISHUNIT';
      const large = sentinel + 'Z'.repeat(300 * 1024);

      const { runId, record } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'explore',
          task: 'spill-finish',
        },
        details: {
          mode: 'single',
          agentScope: 'both',
          projectAgentsDir: null,
          builtinAgentsDir: '/b',
          results: [],
        },
        units: {
          single: {
            unitId: 'single',
            agent: 'explore',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      record.status = 'running';
      coordinator.registerRun(runId, record);

      const ctx = {
        runId,
        unitId: 'single',
        agent: 'explore',
        runtime: undefined,
        resumeCapability: 'session' as const,
        effectiveCwd: root,
        attempt: 1,
      };
      await coordinator.startUnit(runId, ctx);

      const raw: SingleResult = {
        agent: 'explore',
        agentSource: 'user',
        task: 'spill-finish',
        exitCode: 0,
        status: 'completed',
        messages: [],
        stderr: '',
        usage: emptyUsage(),
        finalOutput: large,
        structuredOutput: { body: large, marker: sentinel },
      };

      const committed = await coordinator.finishUnit(runId, ctx, raw, 'completed');

      expect(committed.structuredOutput).toBeUndefined();
      expect(committed.structuredOutputRef).toBeDefined();
      expect(committed.structuredOutputRef!.payload).toBe('structured-output');
      expect(committed.finalOutput).toBeUndefined();
      expect(committed.finalOutputRef).toBeDefined();
      expect(committed.finalOutputRef!.payload).toBe('final-output');

      const json = JSON.stringify(committed);
      expect(json).not.toContain(sentinel);
      expect(json.length).toBeLessThan(1 * 1024 * 1024);

      const readBack = await store.readJsonArtifact(runId, committed.structuredOutputRef!);
      expect(readBack).toEqual({ body: large, marker: sentinel });

      const textBack = await store.readTextArtifact(runId, committed.finalOutputRef!);
      expect(textBack.startsWith(sentinel)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('structuredClone observer catches early clone before spill in finishUnit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-mem-sc-obs-'));
    const orig = globalThis.structuredClone;
    let earlyCloneCaught = false;
    try {
      const store = createRunStore({ rootDir: root });
      const coordinator = createRunCoordinator({ store });
      const sentinel = 'SC_OBSERVER_SENTINEL_' + crypto.randomUUID();
      const large = sentinel + 'Y'.repeat(300 * 1024);

      globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
        const s = JSON.stringify(value);
        if (s.includes(sentinel)) {
          earlyCloneCaught = true;
          throw new Error(`structuredClone observed sentinel before spill: ${s.slice(0, 80)}`);
        }
        return orig(value, options);
      }) as typeof structuredClone;

      const { runId, record } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'explore',
          task: 'sc-obs',
        },
        details: {
          mode: 'single',
          agentScope: 'both',
          projectAgentsDir: null,
          builtinAgentsDir: '/b',
          results: [],
        },
        units: {
          single: {
            unitId: 'single',
            agent: 'explore',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      record.status = 'running';
      coordinator.registerRun(runId, record);

      const ctx = {
        runId,
        unitId: 'single',
        agent: 'explore',
        runtime: undefined,
        resumeCapability: 'session' as const,
        effectiveCwd: root,
        attempt: 1,
      };
      await coordinator.startUnit(runId, ctx);

      const raw: SingleResult = {
        agent: 'explore',
        agentSource: 'user',
        task: 'sc-obs',
        exitCode: 0,
        status: 'completed',
        messages: [],
        stderr: '',
        usage: emptyUsage(),
        finalOutput: large,
        structuredOutput: { body: large, marker: sentinel },
      };

      const committed = await coordinator.finishUnit(runId, ctx, raw, 'completed');

      expect(earlyCloneCaught).toBe(false);
      expect(committed.structuredOutputRef).toBeDefined();
      expect(committed.structuredOutput).toBeUndefined();
    } finally {
      globalThis.structuredClone = orig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('finishUnit externalization failure produces failed snapshot without sentinel', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-mem-fu-fail-'));
    try {
      const baseStore = createRunStore({ rootDir: root });
      const sentinel = 'FAIL_EXT_SENTINEL_';
      const large = sentinel + 'W'.repeat(300 * 1024);

      // Wrap store so writeJsonArtifact throws after writeTextArtifact succeeds.
      let textSpilled = false;
      const failingStore: typeof baseStore = {
        ...baseStore,
        writeJsonArtifact: async (...args) => {
          if (textSpilled) throw new Error('simulated artifact write failure');
          return baseStore.writeJsonArtifact(...args);
        },
        writeTextArtifact: async (...args) => {
          textSpilled = true;
          return baseStore.writeTextArtifact(...args);
        },
      };
      const coordinator = createRunCoordinator({ store: failingStore });

      const { runId, record } = await failingStore.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'explore',
          task: 'fail-ext',
        },
        details: {
          mode: 'single',
          agentScope: 'both',
          projectAgentsDir: null,
          builtinAgentsDir: '/b',
          results: [],
        },
        units: {
          single: {
            unitId: 'single',
            agent: 'explore',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      record.status = 'running';
      // Use real coordinator (not the failing store wrapper) for proper lifecycle.
      coordinator.registerRun(runId, record);

      const ctx = {
        runId,
        unitId: 'single',
        agent: 'explore',
        runtime: undefined,
        resumeCapability: 'session' as const,
        effectiveCwd: root,
        attempt: 1,
      };
      await coordinator.startUnit(runId, ctx);

      const raw: SingleResult = {
        agent: 'explore',
        agentSource: 'user',
        task: 'fail-ext',
        exitCode: 0,
        status: 'completed',
        messages: [],
        stderr: '',
        usage: emptyUsage(),
        finalOutput: large,
        structuredOutput: { body: large, marker: sentinel },
      };

      // Must not throw; externalization failure produces a failed snapshot.
      const committed = await coordinator.finishUnit(runId, ctx, raw, 'completed');
      expect(committed.status).toBe('failed');
      expect(committed.exitCode).toBe(1);
      expect(committed.structuredOutput).toBeUndefined();
      expect(committed.structuredOutputRef).toBeUndefined();
      // finalOutput may be '' (empty) or undefined after snapshot; neither contains sentinel.
      if (typeof committed.finalOutput === 'string') {
        expect(committed.finalOutput).not.toContain(sentinel);
      }
      expect(committed.finalOutputRef).toBeUndefined();
      const json = JSON.stringify(committed);
      expect(json).not.toContain(sentinel);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('executeAgentTool single mode spills oversized finalOutput via finishUnit and returns bounded tool content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-mem-eat-single-'));
    try {
      const store = createRunStore({ rootDir: root });
      const coordinator = createRunCoordinator({ store });
      const sentinel = 'EAT_SINGLE_SENTINEL_';
      const oversized = sentinel + 'X'.repeat(300 * 1024);

      const result = await executeAgentTool(
        { agent: 'general', task: 'eat-single', agentScope: 'user' },
        undefined,
        undefined,
        {
          cwd: root,
          mode: 'tui',
          hasUI: false,
          ui: {
            confirm: async () => true,
            select: async () => undefined,
            input: async () => undefined,
            notify: () => {},
          },
        } as never,
        {
          runStore: store,
          runCoordinator: coordinator,
          spawnFn: ((_command: string, _args: string[]) => {
            const child = new (class extends EventEmitter {
              stdout = new Readable({ read() {} });
              stderr = new Readable({ read() {} });
              stdin = new Writable({
                write: (_c: unknown, _e: unknown, cb: () => void) => cb(),
              });
              kill() {
                this.stdout.push(null);
                this.stderr.push(null);
                setImmediate(() => this.emit('close', 0));
                return true;
              }
            })();
            setImmediate(() => {
              child.stdout.push(
                JSON.stringify({
                  type: 'message_end',
                  message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: oversized }],
                    usage: { input: 1, output: 1, totalTokens: 2 },
                  },
                }) + '\n'
              );
              child.kill();
            });
            return child;
          }) as unknown as import('../src/execution.ts').SpawnFn,
        }
      );

      const text = Array.isArray(result.content)
        ? result.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
        : String(result.content);

      // Tool content must be bounded artifact metadata, not raw sentinel or (no output).
      expect(text).not.toContain(sentinel);
      expect(text).not.toBe('(no output)');
      expect(text).toMatch(/^\[run-artifact /);
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048);

      // Detail records must use refs only, no inline payload.
      const details = result.details;
      expect(details).toBeDefined();
      const results = details?.results ?? [];
      expect(results.length).toBeGreaterThanOrEqual(1);
      const r = results[0]!;
      expect(r.finalOutput).toBeUndefined();
      expect(r.finalOutputRef).toBeDefined();
      const detailJson = JSON.stringify(details);
      expect(detailJson).not.toContain(sentinel);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('executeAgentTool parallel mode spills oversized finalOutput and returns bounded tool content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-mem-eat-par-'));
    try {
      const store = createRunStore({ rootDir: root });
      const coordinator = createRunCoordinator({ store });
      const sentinel = 'EAT_PAR_SENTINEL_';
      const oversized = sentinel + 'P'.repeat(300 * 1024);

      const result = await executeAgentTool(
        {
          tasks: [
            { agent: 'general', task: 'eat-par-1' },
            { agent: 'general', task: 'eat-par-2' },
          ],
          agentScope: 'user',
        },
        undefined,
        undefined,
        {
          cwd: root,
          mode: 'tui',
          hasUI: false,
          ui: {
            confirm: async () => true,
            select: async () => undefined,
            input: async () => undefined,
            notify: () => {},
          },
        } as never,
        {
          runStore: store,
          runCoordinator: coordinator,
          spawnFn: ((_command: string, _args: string[]) => {
            const child = new (class extends EventEmitter {
              stdout = new Readable({ read() {} });
              stderr = new Readable({ read() {} });
              stdin = new Writable({
                write: (_c: unknown, _e: unknown, cb: () => void) => cb(),
              });
              kill() {
                this.stdout.push(null);
                this.stderr.push(null);
                setImmediate(() => this.emit('close', 0));
                return true;
              }
            })();
            setImmediate(() => {
              child.stdout.push(
                JSON.stringify({
                  type: 'message_end',
                  message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: oversized }],
                    usage: { input: 1, output: 1, totalTokens: 2 },
                  },
                }) + '\n'
              );
              child.kill();
            });
            return child;
          }) as unknown as import('../src/execution.ts').SpawnFn,
        }
      );

      const text = Array.isArray(result.content)
        ? result.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
        : String(result.content);

      // Parallel content is an aggregate status line, not the raw output.
      expect(text).not.toContain(sentinel);
      expect(text).not.toContain('(no output)');
      expect(text).toMatch(/Parallel:/);
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048);

      // Detail records must use refs; one descriptor per successful child in content.
      const details = result.details;
      expect(details).toBeDefined();
      const results = details?.results ?? [];
      expect(results.length).toBeGreaterThanOrEqual(2);
      const successful = results.filter((r) => r.status === 'completed');
      expect(successful.length).toBeGreaterThanOrEqual(2);
      for (const r of successful) {
        expect(r.finalOutputRef).toBeDefined();
        expect(r.finalOutput).toBeUndefined();
        expect(JSON.stringify(r)).not.toContain(sentinel);
      }
      const descriptors = text.match(/\[run-artifact[^\]]*\]/g) ?? [];
      expect(descriptors.length).toBe(successful.length);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('executeAgentTool real Chain orchestration spills oversized handoff and bounds final content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-mem-eat-chain-'));
    try {
      const store = createRunStore({ rootDir: root });
      const coordinator = createRunCoordinator({ store });
      const sentinel1 = 'EAT_CHAIN_SENTINEL1_';
      const sentinel2 = 'EAT_CHAIN_SENTINEL2_';
      const oversized1 = sentinel1 + 'C'.repeat(300 * 1024);
      const oversized2 = sentinel2 + 'D'.repeat(300 * 1024);
      let spawnIndex = 0;
      const tasksBySpawnIndex = new Map<number, string[]>();

      // Real production chain path — no runWorkflow shortcut.
      const result = await executeAgentTool(
        {
          chain: [
            { agent: 'general', task: 'generate-oversize', name: 'seed' },
            { agent: 'general', task: 'use {previous}' },
          ],
          agentScope: 'user',
        },
        undefined,
        undefined,
        {
          cwd: root,
          mode: 'tui',
          hasUI: false,
          ui: {
            confirm: async () => true,
            select: async () => undefined,
            input: async () => undefined,
            notify: () => {},
          },
        } as never,
        {
          runStore: store,
          runCoordinator: coordinator,
          spawnFn: ((_command: string, args: string[]) => {
            spawnIndex += 1;
            const idx = spawnIndex;
            const captured: string[] = [];
            for (const a of args) {
              if (a.includes('run-artifact') || a.startsWith('Task:') || a.includes('{previous}')) {
                captured.push(a);
              }
            }
            tasksBySpawnIndex.set(idx, captured);
            const child = new (class extends EventEmitter {
              stdout = new Readable({ read() {} });
              stderr = new Readable({ read() {} });
              stdin = new Writable({
                write: (_c: unknown, _e: unknown, cb: () => void) => cb(),
              });
              kill() {
                this.stdout.push(null);
                this.stderr.push(null);
                setImmediate(() => this.emit('close', 0));
                return true;
              }
            })();
            const text = idx === 1 ? oversized1 : oversized2;
            setImmediate(() => {
              child.stdout.push(
                JSON.stringify({
                  type: 'message_end',
                  message: {
                    role: 'assistant',
                    content: [{ type: 'text', text }],
                    usage: { input: 1, output: 1, totalTokens: 2 },
                  },
                }) + '\n'
              );
              child.kill();
            });
            return child;
          }) as unknown as import('../src/execution.ts').SpawnFn,
        }
      );

      expect(spawnIndex).toBe(2);
      expect(tasksBySpawnIndex.size).toBe(2);
      expect(tasksBySpawnIndex.has(2)).toBe(true);

      const text = Array.isArray(result.content)
        ? result.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
        : String(result.content);

      expect(text).not.toContain(sentinel1);
      expect(text).not.toContain(sentinel2);
      expect(text).not.toBe('(no output)');
      expect(text).toContain('run-artifact');
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048);

      const details = result.details;
      expect(details).toBeDefined();
      const results = details?.results ?? [];
      expect(results.length).toBeGreaterThanOrEqual(2);
      // Step 1 and step 2 both spill oversized authority to refs.
      expect(results[0]!.finalOutputRef).toBeDefined();
      expect(results[0]!.finalOutput).toBeUndefined();
      expect(results[1]!.finalOutputRef).toBeDefined();
      expect(results[1]!.finalOutput).toBeUndefined();
      const step1Digest = results[0]!.finalOutputRef!.sha256;
      const step2Digest = results[1]!.finalOutputRef!.sha256;
      expect(step1Digest).toHaveLength(64);
      expect(step2Digest).toHaveLength(64);
      expect(step2Digest).not.toBe(step1Digest);
      expect(results[1]!.task).toContain(step1Digest);
      expect(results[1]!.task).toContain('pi_agents_read_artifact');
      expect(results[1]!.task).not.toContain(sentinel1);
      // Directly inspect invocation 2 against step 1's exact ref digest.
      const secondChild = (tasksBySpawnIndex.get(2) ?? []).join('\n');
      expect(secondChild).toContain(step1Digest);
      expect(secondChild).not.toContain(sentinel1);
      expect(secondChild).not.toContain(step2Digest);
      // Terminal tool content correlates to step 2 digest prefix specifically.
      expect(text).toContain(step2Digest.slice(0, 16));
      expect(text).not.toContain(step1Digest.slice(0, 16));
      // Durable details use refs only for spilled authority.
      expect(JSON.stringify(details)).not.toContain(sentinel1);
      expect(JSON.stringify(details)).not.toContain(sentinel2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
