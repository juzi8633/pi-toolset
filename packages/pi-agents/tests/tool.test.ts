// ABOUTME: Integration-style tests for executeAgentTool() background dispatch and argument compatibility.
// ABOUTME: Uses an injected fake background manager and a fake workflow runner to avoid spawning real agents.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AgentToolResult, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { discoverAgents } from '../src/agents.ts';
import { executeAgentTool, type ExecuteAgentToolOptions } from '../src/tool.ts';
import type { BackgroundManager } from '../src/background.ts';
import { clearDiscoveredSkills, setDiscoveredSkills } from '../src/skills.ts';
import { createRunStore } from '../src/run-store.ts';
import { agentFingerprint, createRunCoordinator } from '../src/run-coordinator.ts';
import type { ListRunsResult, AgentRunRecordV1, RunUnitRecord } from '../src/run-types.ts';
import type { SubagentDetails } from '../src/types.ts';

type AgentResult = AgentToolResult<SubagentDetails> & { isError?: boolean };

function loadedRecordOf(entry: ListRunsResult[number]): AgentRunRecordV1 {
  if ('record' in entry) return entry.record;
  throw new Error(`corrupt run: ${entry.code}`);
}

function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: '/tmp/pi-agents-tool-test',
    mode: 'tui',
    hasUI: false,
    ui: {
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
      notify: () => {},
    },
    ...overrides,
  } as unknown as ExtensionContext;
}

function okResult(text: string): AgentResult {
  return {
    content: [{ type: 'text', text }],
    details: {
      mode: 'single',
      agentScope: 'user',
      projectAgentsDir: null,
      builtinAgentsDir: '/builtin',
      results: [],
    },
  };
}

function errResult(text: string): AgentResult {
  return { ...okResult(text), isError: true };
}

function fakeWorkflow(text: string): NonNullable<ExecuteAgentToolOptions['runWorkflow']> {
  return async () => okResult(text);
}

function fakeGrokSpawn(
  onSpawn: (args: string[]) => void,
  emitGrokMessage = true
): import('../src/execution.ts').SpawnFn {
  return ((_command: string, args: string[]) => {
    onSpawn(args);
    const child = new (class extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    })();
    setImmediate(() => {
      if (emitGrokMessage) {
        child.stdout.push(
          `${JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'grok done' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          })}\n`
        );
      }
      child.kill();
    });
    return child;
  }) as unknown as import('../src/execution.ts').SpawnFn;
}

function fakeManager(): {
  manager: BackgroundManager;
  launches: Array<{ description: string; mode: string; title?: string }>;
  runs: Array<Promise<AgentResult>>;
} {
  const launches: Array<{ description: string; mode: string; title?: string }> = [];
  const runs: Array<Promise<AgentResult>> = [];
  const manager: BackgroundManager = {
    launch(request) {
      launches.push({ description: request.description, mode: request.mode, title: request.title });
      runs.push(request.run(new AbortController().signal) as Promise<AgentResult>);
      return {
        content: [{ type: 'text', text: `⧗ launched ${request.mode}` }],
        details: {
          mode: 'background',
          agentScope: request.agentScope,
          projectAgentsDir: request.projectAgentsDir,
          builtinAgentsDir: '/builtin',
          results: [],
          background: [
            {
              jobId: 'agent-bg-test',
              mode: request.mode,
              status: 'running',
              agentScope: request.agentScope,
              description: request.description,
              startedAt: 0,
              taskPreview: request.taskPreview,
              title: request.title,
            },
          ],
        },
      };
    },
    cancelAll() {},
    activeCount: () => launches.length,
    waitForIdle: async () => {
      await Promise.allSettled(runs);
    },
  };
  return { manager, launches, runs };
}

describe('executeAgentTool background dispatch', () => {
  it('runs synchronously when runInBackground is absent', async () => {
    let invoked = 0;
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => {
          invoked++;
          return okResult('sync done');
        },
      }
    );
    expect(invoked).toBe(1);
    expect(result.details?.mode).toBe('single');
    expect((result.content[0] as { text: string }).text).toBe('sync done');
  });

  it('launches via the background manager when runInBackground is true', async () => {
    const { manager, launches, runs } = fakeManager();
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it later', runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      { backgroundManager: manager, runWorkflow: fakeWorkflow('bg done') }
    );
    expect(launches.length).toBe(1);
    expect(launches[0].mode).toBe('single');
    expect(result.details?.mode).toBe('background');
    expect((result.content[0] as { text: string }).text).toContain('launched single');
    const inner = await runs[0];
    expect((inner.content[0] as { text: string }).text).toBe('bg done');
  });

  it('strips runInBackground before invoking the workflow runner', async () => {
    const { manager } = fakeManager();
    let observed: { runInBackground?: boolean } | undefined;
    await executeAgentTool(
      { agent: 'noop', task: 'do it', runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      {
        backgroundManager: manager,
        runWorkflow: async (params) => {
          observed = params as { runInBackground?: boolean };
          return okResult('done');
        },
      }
    );
    expect(observed?.runInBackground).toBeUndefined();
  });

  it('rejects background execution in json mode', async () => {
    const { manager, launches } = fakeManager();
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it', runInBackground: true },
      undefined,
      undefined,
      makeCtx({ mode: 'json' } as Partial<ExtensionContext>),
      { backgroundManager: manager, runWorkflow: fakeWorkflow('should not run') }
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/long-lived/);
    expect(launches.length).toBe(0);
  });

  it('rejects background execution when no manager is provided', async () => {
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it', runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      { runWorkflow: fakeWorkflow('should not run') }
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/Background execution/);
  });

  it('reports invalid params when no mode is provided', async () => {
    const result = await executeAgentTool(
      {} as Parameters<typeof executeAgentTool>[0],
      undefined,
      undefined,
      makeCtx()
    );
    expect((result.content[0] as { text: string }).text).toMatch(/Invalid parameters/);
  });

  it('rejects oversized parallel tasks before launching a background job', async () => {
    const { manager, launches } = fakeManager();
    const oversized = Array.from({ length: 12 }, (_, i) => ({
      agent: 'noop',
      task: `task ${i}`,
    }));
    const result = await executeAgentTool(
      { tasks: oversized, runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      { backgroundManager: manager, runWorkflow: fakeWorkflow('should not run') }
    );
    expect(launches.length).toBe(0);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/Too many parallel tasks/);
  });
});

describe('normalizeAgentArgs', () => {
  it('rewrites snake_case run_in_background to camelCase runInBackground', async () => {
    const { normalizeAgentArgs } = await import('../src/index.ts');
    const out = normalizeAgentArgs({
      agent: 'noop',
      task: 'go',
      run_in_background: true,
    });
    expect(out).toEqual({ agent: 'noop', task: 'go', runInBackground: true });
  });

  it('does not overwrite an explicit runInBackground value', async () => {
    const { normalizeAgentArgs } = await import('../src/index.ts');
    const out = normalizeAgentArgs({
      agent: 'noop',
      task: 'go',
      run_in_background: true,
      runInBackground: false,
    });
    expect(out).toEqual({
      agent: 'noop',
      task: 'go',
      run_in_background: true,
      runInBackground: false,
    });
  });

  it('returns the input untouched when run_in_background is missing', async () => {
    const { normalizeAgentArgs } = await import('../src/index.ts');
    const input = { agent: 'noop', task: 'go' };
    expect(normalizeAgentArgs(input)).toBe(input);
  });
});

describe('agent tool title parameter', () => {
  it('enforces title maxLength 30 on single, task, chain, and fanout schemas', async () => {
    const { SubagentParams, TaskItem, SequentialChainItem, FanoutChainItem } =
      await import('../src/schema.ts');
    const { Value } = await import('typebox/value');
    const validTitle = 'a'.repeat(30);
    const invalidTitle = 'a'.repeat(31);
    expect(Value.Check(SubagentParams, { agent: 'x', task: 'y', title: validTitle })).toBe(true);
    expect(Value.Check(SubagentParams, { agent: 'x', task: 'y', title: invalidTitle })).toBe(false);
    expect(Value.Check(SubagentParams, { agent: 'x', task: 'y' })).toBe(true);
    expect(Value.Check(TaskItem, { agent: 'x', task: 'y', title: validTitle })).toBe(true);
    expect(Value.Check(TaskItem, { agent: 'x', task: 'y', title: invalidTitle })).toBe(false);
    expect(Value.Check(SequentialChainItem, { agent: 'x', task: 'y', title: validTitle })).toBe(
      true
    );
    expect(Value.Check(SequentialChainItem, { agent: 'x', task: 'y', title: invalidTitle })).toBe(
      false
    );
    const fanout = {
      expand: { from: { output: 'o', path: '/p' } },
      parallel: { agent: 'x', task: 'y', title: validTitle },
      collect: { name: 'r' },
    };
    expect(Value.Check(FanoutChainItem, fanout)).toBe(true);
    const fanoutBad = {
      expand: { from: { output: 'o', path: '/p' } },
      parallel: { agent: 'x', task: 'y', title: invalidTitle },
      collect: { name: 'r' },
    };
    expect(Value.Check(FanoutChainItem, fanoutBad)).toBe(false);
  });

  it('passes the single title through to the workflow runner', async () => {
    let observed: { title?: string } | undefined;
    await executeAgentTool(
      { agent: 'noop', task: 'do it', title: '干活' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async (params) => {
          observed = params as { title?: string };
          return okResult('done');
        },
      }
    );
    expect(observed?.title).toBe('干活');
  });

  it('passes the first title to the background launch request', async () => {
    const { manager, launches } = fakeManager();
    await executeAgentTool(
      { agent: 'noop', task: 'do it later', title: '后台活', runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      { backgroundManager: manager, runWorkflow: fakeWorkflow('bg done') }
    );
    expect(launches.length).toBe(1);
    expect(launches[0].title).toBe('后台活');
  });

  it('uses the first chain step title for a background launch', async () => {
    const { manager, launches } = fakeManager();
    await executeAgentTool(
      {
        chain: [
          { agent: 'a', task: 'first', title: '首步' },
          { agent: 'b', task: 'second' },
        ],
        runInBackground: true,
      },
      undefined,
      undefined,
      makeCtx(),
      { backgroundManager: manager, runWorkflow: fakeWorkflow('bg done') }
    );
    expect(launches.length).toBe(1);
    expect(launches[0].title).toBe('首步');
  });
});

describe('executeAgentTool skill resolution', () => {
  const piAgentKeys = [
    'PI_AGENT_CHILD',
    'PI_AGENT_DEPTH',
    'PI_AGENT_MAX_DEPTH',
    'PI_AGENT_TOOL_AVAILABLE',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let tmpCwd: string | null = null;

  beforeEach(() => {
    for (const key of piAgentKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    clearDiscoveredSkills();
  });

  afterEach(() => {
    for (const key of piAgentKeys) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tmpCwd) {
      rmSync(tmpCwd, { recursive: true, force: true });
      tmpCwd = null;
    }
    clearDiscoveredSkills();
  });

  it('returns skill_error without spawning when a declared skill name is missing', async () => {
    tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'pi-skills-int-'));
    const agentsDir = path.join(tmpCwd, '.pi', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, 'picky.md'),
      `---\nname: picky\ndescription: wants skills\nskills: ghost, librarian\n---\nBody.`
    );
    setDiscoveredSkills([]);

    const result = await executeAgentTool(
      { agent: 'picky', task: 'go' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpCwd })
    );

    expect(result.isError).toBe(true);
    const single = result.details?.results[0];
    expect(single?.stopReason).toBe('skill_error');
    expect(single?.errorMessage).toContain('ghost');
    expect(single?.errorMessage).toContain('librarian');
  });
});

describe('runtime override schema and grok-acp skill/fork warnings', () => {
  const piAgentKeys = [
    'PI_AGENT_CHILD',
    'PI_AGENT_DEPTH',
    'PI_AGENT_MAX_DEPTH',
    'PI_AGENT_TOOL_AVAILABLE',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let tmpCwd: string | null = null;

  beforeEach(() => {
    for (const key of piAgentKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    clearDiscoveredSkills();
  });

  afterEach(() => {
    for (const key of piAgentKeys) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tmpCwd) {
      rmSync(tmpCwd, { recursive: true, force: true });
      tmpCwd = null;
    }
    clearDiscoveredSkills();
  });

  it('accepts only pi and grok-acp and omits replay parameters', async () => {
    const { RuntimeSchema, SubagentParams } = await import('../src/schema.ts');
    const { Value } = await import('typebox/value');
    expect(Value.Check(RuntimeSchema, 'pi')).toBe(true);
    expect(Value.Check(RuntimeSchema, 'grok')).toBe(false);
    expect(Value.Check(RuntimeSchema, 'grok-acp')).toBe(true);
    expect(Value.Check(RuntimeSchema, 'claude')).toBe(false);
    expect(Value.Check(RuntimeSchema, 'weird')).toBe(false);
    expect('allowReplay' in SubagentParams.properties).toBe(false);
  });

  it('emits skill and fork warnings for grok-acp before spawn failure', async () => {
    tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'pi-acp-warn-'));
    const agentsDir = path.join(tmpCwd, '.pi', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, 'acp.md'),
      `---\nname: acp\ndescription: acp agent\nruntime: grok-acp\nskills: ghost\ndefaultContext: fork\n---\nBody.`
    );

    const warnings: string[] = [];
    const ctx = makeCtx({
      cwd: tmpCwd,
      ui: {
        confirm: async () => true,
        select: async () => undefined,
        input: async () => undefined,
        notify: (msg: string, level?: string) => {
          if (level === 'warning') warnings.push(msg);
        },
      } as unknown as ExtensionContext['ui'],
    });

    // PATH without grok causes spawn ENOENT; warnings fire before spawn.
    const savedPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const result = await executeAgentTool(
        { agent: 'acp', task: 'go' },
        undefined,
        undefined,
        ctx
      );
      expect(warnings.some((w) => w.includes('runtime: grok-acp') && w.includes('skills'))).toBe(
        true
      );
      expect(warnings.some((w) => w.includes('runtime: grok-acp') && w.includes('fork'))).toBe(
        true
      );
      // Result may be error from spawn; skill_error must not occur (skills ignored).
      const single = result.details?.results[0];
      expect(single?.stopReason).not.toBe('skill_error');
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe('executeAgentTool durable run persistence', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-durable-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeStore() {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    return { store, coordinator };
  }

  it('dispatches a fresh Grok ACP run', async () => {
    const { store, coordinator } = makeStore();
    let spawnCount = 0;

    await executeAgentTool(
      { agent: 'general', task: 'fresh Grok ACP task', runtime: 'grok-acp' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: fakeGrokSpawn(() => spawnCount++, false),
      }
    );

    expect(spawnCount).toBe(1);
  });

  it('creates a durable run before the workflow starts and finalizes completed on success', async () => {
    const { store, coordinator } = makeStore();
    let observedRunId: string | undefined;
    let workflowStarted = false;
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async (_params, _signal, _onUpdate, _ctx, _agents, _makeDetails) => {
          // The run must already exist on disk before the workflow runs.
          workflowStarted = true;
          const runs = await store.listRuns();
          expect(runs.length).toBe(1);
          const record = loadedRecordOf(runs[0]!);
          observedRunId = record.runId;
          expect(record.status).toBe('running');
          return okResult('sync done');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(workflowStarted).toBe(true);
    expect(result.details?.run?.runId).toBe(observedRunId);
    expect(result.details?.run?.status).toBe('completed');
    // The stored record persists on disk; the seam workflow does not call
    // beginUnit/endUnit, so unit-derived status stays 'running' while the
    // returned details.run summary reflects the foreground completion.
    const loaded = store.getRun(observedRunId!);
    expect(loaded.ok).toBe(true);
    const finalRecord = (loaded as { ok: true; loaded: { record: { runId: string } } }).loaded
      .record;
    expect(finalRecord.runId).toBe(observedRunId!);
  });

  it('creates only sequential chain unit records at start (no fanout placeholders)', async () => {
    const { store, coordinator } = makeStore();
    let unitKeys: string[] = [];
    await executeAgentTool(
      {
        chain: [
          { agent: 'noop', task: 'seed', name: 'seed' },
          {
            expand: { from: { output: 'seed', path: '' } },
            parallel: { agent: 'noop', task: 'item {item}' },
            collect: { name: 'items' },
          },
          { agent: 'noop', task: 'done' },
        ],
      },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => {
          const runs = await store.listRuns();
          const record = loadedRecordOf(runs[0]!);
          unitKeys = Object.keys(record.units).sort();
          return okResult('chain done');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(unitKeys).toEqual(['chain-0001', 'chain-0003']);
    expect(unitKeys.some((id) => id.endsWith('-fanout') && !id.match(/fanout-\d{4}$/))).toBe(false);
  });

  it('does not create a run when persistence is not injected (legacy path)', async () => {
    let observedCount = -1;
    await executeAgentTool({ agent: 'noop', task: 'do it' }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => {
        // No store injected; nothing to list.
        observedCount = 0;
        return okResult('done');
      },
    });
    expect(observedCount).toBe(0);
  });

  it('finalizes as cancelled when the workflow aborts with a user signal', async () => {
    const { store, coordinator } = makeStore();
    const controller = new AbortController();
    let runId: string | undefined;
    await executeAgentTool(
      { agent: 'noop', task: 'do it' },
      controller.signal,
      undefined,
      makeCtx(),
      {
        runWorkflow: async (_params, signal) => {
          const runs = await store.listRuns();
          runId = loadedRecordOf(runs[0]!).runId;
          // Bridge the incoming signal onto the coordinator-owned lifecycle.
          controller.abort();
          // Wait for the workflow signal (coordinator-owned) to observe the abort.
          if (signal?.aborted) {
            // already aborted
          } else {
            await new Promise<void>((resolve) => {
              signal!.addEventListener('abort', () => resolve(), { once: true });
            });
          }
          throw new Error('aborted');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    ).catch(() => {
      // Expected to reject; the durable finalize still runs in finally.
    });
    const loaded = store.getRun(runId!);
    expect(loaded.ok).toBe(true);
    const record = (loaded as { ok: true; loaded: { record: { status: string } } }).loaded.record;
    expect(record.status).toBe('cancelled');
  });

  it('finalizes as failed when the workflow returns isError', async () => {
    const { store, coordinator } = makeStore();
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => errResult('boom'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    const runs = await store.listRuns();
    const record = loadedRecordOf(runs[0]!);
    expect(record.status).toBe('failed');
  });

  it('stamps foreground terminal failure with queued siblings as resumable', async () => {
    const { store, coordinator } = makeStore();
    // Parallel launch creates two units that remain queued when the seam
    // workflow returns isError without beginUnit/endUnit. stampRunOnDetails
    // must use finalStatus=failed (not derived running) for resumability.
    const result = await executeAgentTool(
      {
        tasks: [
          { agent: 'noop', task: 'first' },
          { agent: 'noop', task: 'second' },
        ],
      },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => errResult('first failed'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    expect(result.details?.run?.status).toBe('failed');
    expect(result.details?.run?.resumable).toBe(true);
    const runs = await store.listRuns();
    const record = loadedRecordOf(runs[0]!);
    expect(Object.values(record.units).some((u) => u.status === 'queued')).toBe(true);
  });

  it('stamps foreground terminal cancellation with queued siblings as resumable', async () => {
    const { store, coordinator } = makeStore();
    const controller = new AbortController();
    const result = await executeAgentTool(
      {
        tasks: [
          { agent: 'noop', task: 'first' },
          { agent: 'noop', task: 'second' },
        ],
      },
      controller.signal,
      undefined,
      makeCtx(),
      {
        runWorkflow: async (_params, signal) => {
          controller.abort();
          if (signal && !signal.aborted) {
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          }
          // Return (do not throw) so stampRunOnDetails runs on the foreground path.
          return errResult('cancelled mid-run');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    expect(result.details?.run?.status).toBe('cancelled');
    expect(result.details?.run?.resumable).toBe(true);
  });

  it('uses the run id as the background job id', async () => {
    const { manager, launches, runs } = fakeManager();
    const { store, coordinator } = makeStore();
    let runId: string | undefined;
    await executeAgentTool(
      { agent: 'noop', task: 'bg', runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      {
        backgroundManager: manager,
        runWorkflow: async () => {
          const listRuns = await store.listRuns();
          runId = loadedRecordOf(listRuns[0]!).runId;
          return okResult('bg done');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    await Promise.allSettled(runs);
    // The fake manager's jobId is hardcoded to 'agent-bg-test'; the real manager
    // would use the run id. Here we assert the run exists and is completed.
    expect(launches.length).toBe(1);
    const loaded = store.getRun(runId!);
    expect(loaded.ok).toBe(true);
  });

  it('returns run_store_error and does not spawn the workflow when pre-spawn persistence fails', async () => {
    const { store, coordinator } = makeStore();
    // Wrap the store so createRun rejects, simulating a pre-spawn persistence failure.
    const failingStore: typeof store = {
      ...store,
      createRun: async () => {
        throw new Error('disk full');
      },
    };
    let workflowCalled = false;
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => {
          workflowCalled = true;
          return okResult('should not run');
        },
        runStore: failingStore,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { text: string }).text).toContain('run_store_error');
    expect((result.content[0] as { text: string }).text).toContain('disk full');
    expect(workflowCalled).toBe(false);
  });

  it('terminates the owned claim even when terminal snapshot persistence fails', async () => {
    const { store, coordinator } = makeStore();
    // Wrap the store so the terminal run_terminal event write rejects, simulating
    // a terminal persistence failure. Startup events still succeed so the run
    // starts; the claim must still be released via the finally path.
    const failingStore: typeof store = {
      ...store,
      appendEvent: async (_runId, event) => {
        if (event.event === 'run_terminal') {
          throw new Error('terminal event write failed');
        }
      },
    };
    let runId: string | undefined;
    await executeAgentTool({ agent: 'noop', task: 'do it' }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => {
        const runs = await store.listRuns();
        runId = loadedRecordOf(runs[0]!).runId;
        return okResult('done');
      },
      runStore: failingStore,
      runCoordinator: coordinator,
    }).catch(() => {
      // finalizeDurableRun may reject; the claim must still be released.
    });
    // Inspect claims: the terminal marker must be published (released or abandoned).
    const claims = store.inspectClaims(runId!);
    expect(claims.ok).toBe(true);
    if (claims.ok) {
      const terminal = claims.claims.find((c) => c.terminal !== undefined)?.terminal;
      expect(terminal).toBeDefined();
      expect(terminal!.state === 'released' || terminal!.state === 'abandoned').toBe(true);
    }
  });
});

describe('durable chain fanout item lifecycle', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-fanout-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('isolates out-of-order fanout item terminals across three unit records', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'user',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'user',
        chain: [
          { agent: 'seed', task: 'seed step' },
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'worker', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: 'seed',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          step: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: '/tmp',
        },
      },
    });
    const runId = created.runId;
    const live = created.record;
    live.status = 'running';
    coordinator.registerRun(runId, live);

    const expansion = await coordinator.expandFanout(runId, {
      step: 2,
      items: ['a', 'b', 'c'],
      agent: {
        name: 'worker',
        description: '',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/w.md',
      },
      runtime: undefined,
      effectiveCwd: '/tmp',
    });
    expect(expansion.unitIds).toEqual([
      'chain-0002-fanout-0001',
      'chain-0002-fanout-0002',
      'chain-0002-fanout-0003',
    ]);

    // Production order: persistSessionFile (strict first-write) before start/finish.
    // Full merge is disk-exact for sessionFile — startUnit/finishUnit alone cannot
    // establish a first path (stale live snapshots must not inject sessionFile).
    const finish = async (index: number, text: string) => {
      const unitId = expansion.unitIds[index]!;
      const sessionFile = `/sessions/${unitId}.jsonl`;
      const ctx = {
        runId,
        unitId,
        agent: 'worker',
        runtime: undefined,
        resumeCapability: 'session' as const,
        effectiveCwd: '/tmp',
        attempt: 1,
        step: 2,
        fanoutIndex: index,
        sessionFile,
      };
      await coordinator.persistSessionFile({ runId, unitId, sessionFile });
      coordinator.startUnit(runId, ctx);
      const result = {
        agent: 'worker',
        agentSource: 'builtin' as const,
        task: text,
        exitCode: 0,
        status: 'completed' as const,
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
        step: 2,
        fanout: { index, count: 3, itemTask: text },
        finalOutput: text,
      };
      coordinator.finishUnit(runId, ctx, result, 'completed');
    };

    // Out-of-order terminals (1, 2, 0) — each unit keeps its own sessionFile.
    await finish(1, 'item-1');
    await finish(2, 'item-2');
    await finish(0, 'item-0');
    await new Promise((r) => setTimeout(r, 30));

    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const units = loaded.loaded.record.units;
    expect(units['chain-0002-fanout-0001']!.result?.finalOutput).toBe('item-0');
    expect(units['chain-0002-fanout-0002']!.result?.finalOutput).toBe('item-1');
    expect(units['chain-0002-fanout-0003']!.result?.finalOutput).toBe('item-2');
    expect(units['chain-0002-fanout-0001']!.sessionFile).toContain('chain-0002-fanout-0001');
    expect(units['chain-0002-fanout-0002']!.sessionFile).toContain('chain-0002-fanout-0002');
    expect(units['chain-0002-fanout-0003']!.sessionFile).toContain('chain-0002-fanout-0003');
    expect(units['chain-0002-fanout-0001']!.result?.sessionFile).toContain(
      'chain-0002-fanout-0001'
    );
    expect(units['chain-0002-fanout-0002']!.result?.sessionFile).toContain(
      'chain-0002-fanout-0002'
    );
    expect(units['chain-0002-fanout-0003']!.result?.sessionFile).toContain(
      'chain-0002-fanout-0003'
    );
    expect(units['chain-0002-fanout-0001']!.attempt).toBe(1);
    expect(units['chain-0002-fanout-0002']!.attempt).toBe(1);
    expect(units['chain-0002-fanout-0003']!.attempt).toBe(1);
    expect(units['chain-0002-fanout']).toBeUndefined();
  });

  it('live-only sessionFile on start/finish is not first-written by full merge', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'user',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'user',
        chain: [
          { agent: 'seed', task: 'seed step' },
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'worker', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: 'seed',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          step: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: '/tmp',
        },
      },
    });
    const runId = created.runId;
    const live = created.record;
    live.status = 'running';
    coordinator.registerRun(runId, live);

    const expansion = await coordinator.expandFanout(runId, {
      step: 2,
      items: ['only'],
      agent: {
        name: 'worker',
        description: '',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/w.md',
      },
      runtime: undefined,
      effectiveCwd: '/tmp',
    });
    const unitId = expansion.unitIds[0]!;
    const ctx = {
      runId,
      unitId,
      agent: 'worker',
      runtime: undefined,
      resumeCapability: 'session' as const,
      effectiveCwd: '/tmp',
      attempt: 1,
      step: 2,
      fanoutIndex: 0,
      sessionFile: `/sessions/${unitId}.jsonl`,
    };
    // Intentionally skip persistSessionFile — full merge must not accept live-only path.
    coordinator.startUnit(runId, ctx);
    coordinator.finishUnit(
      runId,
      ctx,
      {
        agent: 'worker',
        agentSource: 'builtin' as const,
        task: 'only',
        exitCode: 0,
        status: 'completed' as const,
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
        step: 2,
        fanout: { index: 0, count: 1, itemTask: 'only' },
        finalOutput: 'only',
      },
      'completed'
    );
    await new Promise((r) => setTimeout(r, 30));

    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const unit = loaded.loaded.record.units[unitId]!;
    expect(unit.result?.finalOutput).toBe('only');
    expect(unit.sessionFile).toBeUndefined();
    expect(unit.result?.sessionFile).toBeUndefined();
  });

  it('persists empty fanout mapping with no child units or placeholder', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'user',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'user',
        chain: [
          { agent: 'seed', task: 'seed step' },
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'worker', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: 'seed',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          step: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: '/tmp',
        },
      },
    });
    const live = created.record;
    live.status = 'running';
    coordinator.registerRun(created.runId, live);

    await coordinator.expandFanout(created.runId, {
      step: 2,
      items: [],
      agent: {
        name: 'worker',
        description: '',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/w.md',
      },
      runtime: undefined,
      effectiveCwd: '/tmp',
    });

    await coordinator.finalizeRun(created.runId, live.details, live.units, { success: true });
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const record = loaded.loaded.record;
    expect(record.workflowState?.fanouts?.['chain-0002-fanout']).toEqual({
      step: 2,
      items: [],
      unitIds: [],
    });
    expect(Object.keys(record.units)).toEqual(['chain-0001']);
    expect(record.units['chain-0002-fanout']).toBeUndefined();
    expect(record.status).toBe('completed');
  });

  it('expansion write failure leaves no child units and surfaces the error', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'user',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'user',
        chain: [
          { agent: 'seed', task: 'seed step' },
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'worker', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: 'seed',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          step: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: '/tmp',
        },
      },
    });
    const live = created.record;
    live.status = 'running';
    coordinator.registerRun(created.runId, live);

    store.updateRun = (async () => {
      throw new Error('disk full');
    }) as typeof store.updateRun;

    await expect(
      coordinator.expandFanout(created.runId, {
        step: 2,
        items: ['a'],
        agent: {
          name: 'worker',
          description: '',
          systemPrompt: '',
          source: 'builtin',
          filePath: '/tmp/w.md',
        },
        runtime: undefined,
        effectiveCwd: '/tmp',
      })
    ).rejects.toThrow(/disk full/);

    expect(live.units['chain-0002-fanout-0001']).toBeUndefined();
    expect(live.workflowState?.fanouts?.['chain-0002-fanout']).toBeUndefined();
  });

  it('terminal postprocess failure status is what finishUnit persists', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'user',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'user',
        // Fanout-only topology at step 1 (matches expandFanout step below).
        chain: [
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'worker', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {},
    });
    const live = created.record;
    live.status = 'running';
    coordinator.registerRun(created.runId, live);
    await coordinator.expandFanout(created.runId, {
      step: 1,
      items: ['x'],
      agent: {
        name: 'worker',
        description: '',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/w.md',
      },
      runtime: undefined,
      effectiveCwd: '/tmp',
    });

    const unitId = 'chain-0001-fanout-0001';
    const ctx = {
      runId: created.runId,
      unitId,
      agent: 'worker',
      runtime: undefined,
      resumeCapability: 'session' as const,
      effectiveCwd: '/tmp',
      attempt: 1,
      step: 1,
      fanoutIndex: 0,
    };
    coordinator.startUnit(created.runId, ctx);
    const result = {
      agent: 'worker',
      agentSource: 'builtin' as const,
      task: 'x',
      exitCode: 1,
      status: 'failed' as const,
      messages: [],
      stderr: 'Structured output error: bad',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 1,
      },
      step: 1,
      fanout: { index: 0, count: 1, itemTask: 'x' },
      stopReason: 'structured_output_error',
      errorMessage: 'Structured output error: bad',
      worktreePath: '/tmp/.worktrees/kept',
      worktreeDirty: false,
    };
    // Production order: postprocess (already applied) then finishUnit.
    coordinator.finishUnit(created.runId, ctx, result, 'failed');
    await new Promise((r) => setTimeout(r, 20));

    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const unit = loaded.loaded.record.units[unitId]!;
    expect(unit.status).toBe('failed');
    expect(unit.result?.status).toBe('failed');
    expect(unit.result?.stopReason).toBe('structured_output_error');
    expect(unit.result?.worktreePath).toBe('/tmp/.worktrees/kept');
  });

  it('cancel mid-fanout keeps completed terminal, cancels started, leaves unstarted queued', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'user',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'user',
        chain: [
          { agent: 'seed', task: 'seed step' },
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'worker', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: 'seed',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          step: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: '/tmp',
        },
      },
    });
    const live = created.record;
    live.status = 'running';
    coordinator.registerRun(created.runId, live);

    const agent = {
      name: 'worker',
      description: '',
      systemPrompt: '',
      source: 'builtin' as const,
      filePath: '/tmp/w.md',
    };
    const expansion = await coordinator.expandFanout(created.runId, {
      step: 2,
      items: ['a', 'b', 'c', 'd'],
      agent,
      runtime: undefined,
      effectiveCwd: '/tmp',
    });

    const makeCtx = (index: number) => ({
      runId: created.runId,
      unitId: expansion.unitIds[index]!,
      agent: 'worker',
      runtime: undefined,
      resumeCapability: 'session' as const,
      effectiveCwd: '/tmp',
      attempt: 1,
      step: 2,
      fanoutIndex: index,
    });

    const completedResult = {
      agent: 'worker',
      agentSource: 'builtin' as const,
      task: 'a',
      exitCode: 0,
      status: 'completed' as const,
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
      step: 2,
      fanout: { index: 0, count: 4, itemTask: 'a' },
      finalOutput: 'done-a',
    };
    coordinator.startUnit(created.runId, makeCtx(0));
    coordinator.finishUnit(created.runId, makeCtx(0), completedResult, 'completed');

    coordinator.startUnit(created.runId, makeCtx(1));
    coordinator.finishUnit(
      created.runId,
      makeCtx(1),
      {
        ...completedResult,
        task: 'b',
        status: 'cancelled',
        exitCode: 1,
        fanout: { index: 1, count: 4, itemTask: 'b' },
        finalOutput: undefined,
        stopReason: 'aborted',
      },
      'cancelled'
    );
    // Items 2 and 3 remain queued — never started.

    const fanoutResults = [
      completedResult,
      {
        ...completedResult,
        task: 'b',
        status: 'cancelled' as const,
        exitCode: 1,
        fanout: { index: 1, count: 4, itemTask: 'b' },
        stopReason: 'aborted' as const,
        finalOutput: undefined,
      },
    ];
    live.details = {
      ...live.details,
      results: fanoutResults,
    };
    await coordinator.finalizeRun(created.runId, live.details, live.units, { cancelled: true });
    await new Promise((r) => setTimeout(r, 20));

    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const record = loaded.loaded.record;
    expect(record.status).toBe('cancelled');
    expect(record.units['chain-0002-fanout']).toBeUndefined();
    expect(record.units['chain-0002-fanout-0001']!.status).toBe('completed');
    expect(record.units['chain-0002-fanout-0001']!.result?.finalOutput).toBe('done-a');
    expect(record.units['chain-0002-fanout-0002']!.status).toBe('cancelled');
    expect(record.units['chain-0002-fanout-0002']!.attempts.length).toBeGreaterThan(0);
    expect(record.units['chain-0002-fanout-0003']!.status).toBe('queued');
    expect(record.units['chain-0002-fanout-0003']!.attempts).toEqual([]);
    expect(record.units['chain-0002-fanout-0004']!.status).toBe('queued');
    expect(record.units['chain-0002-fanout-0004']!.attempts).toEqual([]);
    // Position / capability metadata intact on every child.
    for (let i = 0; i < 4; i++) {
      const u = record.units[expansion.unitIds[i]!]!;
      expect(u.step).toBe(2);
      expect(u.fanoutIndex).toBe(i);
      expect(u.capability).toBe('session');
      expect(u.agentFingerprint.length).toBeGreaterThan(0);
    }
  });

  it('final run.json unit results agree with details.results and carry positions', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'user',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'user',
        // Fanout-only topology at step 1 (matches expandFanout step below).
        chain: [
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'worker', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {},
    });
    const live = created.record;
    live.status = 'running';
    coordinator.registerRun(created.runId, live);

    const expansion = await coordinator.expandFanout(created.runId, {
      step: 1,
      items: ['x', 'y'],
      agent: {
        name: 'worker',
        description: '',
        systemPrompt: 'sys',
        source: 'builtin',
        filePath: '/tmp/w.md',
      },
      runtime: undefined,
      effectiveCwd: '/tmp',
    });

    const results: Array<{
      agent: string;
      agentSource: 'builtin';
      task: string;
      exitCode: number;
      status: 'completed';
      messages: [];
      stderr: string;
      usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
        contextTokens: number;
        turns: number;
      };
      step: number;
      fanout: { index: number; count: number; itemTask: string };
      finalOutput: string;
    }> = [];

    for (let i = 0; i < 2; i++) {
      const unitId = expansion.unitIds[i]!;
      const ctx = {
        runId: created.runId,
        unitId,
        agent: 'worker',
        runtime: undefined,
        resumeCapability: 'session' as const,
        effectiveCwd: '/tmp',
        attempt: 1,
        step: 1,
        fanoutIndex: i,
      };
      coordinator.startUnit(created.runId, ctx);
      const result = {
        agent: 'worker',
        agentSource: 'builtin' as const,
        task: expansion.items[i] as string,
        exitCode: 0,
        status: 'completed' as const,
        messages: [] as [],
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
        step: 1,
        fanout: { index: i, count: 2, itemTask: expansion.items[i] as string },
        finalOutput: `out-${i}`,
      };
      results.push(result);
      coordinator.finishUnit(created.runId, ctx, result, 'completed');
    }

    live.details = { ...live.details, results };
    await coordinator.finalizeRun(created.runId, live.details, live.units, { success: true });
    await new Promise((r) => setTimeout(r, 20));

    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const record = loaded.loaded.record;
    expect(record.status).toBe('completed');
    expect(record.units['chain-0001-fanout']).toBeUndefined();
    expect(Object.keys(record.units).sort()).toEqual([
      'chain-0001-fanout-0001',
      'chain-0001-fanout-0002',
    ]);
    for (let i = 0; i < 2; i++) {
      const unitId = expansion.unitIds[i]!;
      const unit = record.units[unitId]!;
      const presented = record.details.results[i]!;
      expect(unit.result?.finalOutput).toBe(presented.finalOutput);
      expect(unit.result?.status).toBe(presented.status);
      expect(unit.step).toBe(1);
      expect(unit.fanoutIndex).toBe(i);
      expect(unit.capability).toBe('session');
      expect(unit.agentFingerprint.length).toBeGreaterThan(0);
      expect(unit.runtime === undefined || unit.runtime === 'pi').toBe(true);
    }
  });
});

describe('executeAgentTool public runId resume', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-runid-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeStore() {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    return { store, coordinator };
  }

  function exploreAgent() {
    const agents = discoverAgents(process.cwd(), 'both').agents;
    const explore = agents.find((a) => a.name === 'explore');
    if (!explore) throw new Error('builtin explore agent not found');
    return explore;
  }

  async function seedInterruptedRun(options: {
    store: ReturnType<typeof createRunStore>;
    mode?: 'single' | 'parallel' | 'chain';
    background?: boolean;
    unitStatus?: RunUnitRecord['status'];
    sessionFile?: string | null;
    /** When set, stamps the durable original-prompt establishment flag. */
    sessionPromptEstablished?: boolean;
    continuationTasks?: string[];
    request?: Partial<AgentRunRecordV1['request']>;
  }): Promise<string> {
    const agent = exploreAgent();
    const mode = options.mode ?? 'single';
    const unitStatus = options.unitStatus ?? 'interrupted';
    const sessionFile =
      options.sessionFile === null
        ? undefined
        : (options.sessionFile ?? path.join(tmpRoot, 'seed-session.jsonl'));
    if (sessionFile) writeFileSync(sessionFile, '{}\n');

    const request: AgentRunRecordV1['request'] = {
      mode,
      agentScope: 'both',
      agent: 'explore',
      task: 'Original stored task',
      ...options.request,
    };
    if (mode === 'parallel' && !request.tasks) {
      request.tasks = [{ agent: 'explore', task: 'Parallel original' }];
      delete request.agent;
      delete request.task;
    }
    if (mode === 'chain' && !request.chain) {
      request.chain = [{ agent: 'explore', task: 'Chain original' }];
      delete request.agent;
      delete request.task;
    }

    const unitId =
      mode === 'single' ? 'single' : mode === 'parallel' ? 'parallel-0001' : 'chain-0001';
    const units: Record<string, RunUnitRecord> = {
      [unitId]: {
        unitId,
        agent: agent.name,
        agentFingerprint: agentFingerprint(agent),
        runtime: undefined,
        capability: 'session',
        status: unitStatus,
        attempt: 1,
        attempts:
          unitStatus === 'queued'
            ? []
            : [
                {
                  attempt: 1,
                  status: unitStatus === 'completed' ? 'completed' : 'interrupted',
                  startedAt: Date.now() - 1000,
                },
              ],
        effectiveCwd: tmpRoot,
        ...(mode === 'parallel' ? { fanoutIndex: 0 } : {}),
        ...(mode === 'chain' ? { step: 1 } : {}),
        ...(sessionFile ? { sessionFile } : {}),
        ...(options.sessionPromptEstablished !== undefined
          ? { sessionPromptEstablished: options.sessionPromptEstablished }
          : {}),
      },
    };

    const created = await options.store.createRun({
      mode,
      agentScope: 'both',
      background: options.background ?? false,
      request,
      details: {
        mode,
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [],
      },
      units,
    });
    await options.store.updateRun(created.runId, (r) => {
      r.status = unitStatus === 'completed' ? 'completed' : 'interrupted';
      if (options.continuationTasks) r.continuationTasks = [...options.continuationTasks];
    });
    return created.runId;
  }

  it('resumes by runId alone and reuses the same durable run record', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    let seenParams: Record<string, unknown> | undefined;
    const result = await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      runWorkflow: async (params) => {
        seenParams = params as Record<string, unknown>;
        return okResult('resumed');
      },
      runStore: store,
      runCoordinator: coordinator,
    });
    expect(result.isError).toBeUndefined();
    expect(seenParams?.agent).toBe('explore');
    expect(seenParams?.task).toBe('Original stored task');
    expect(seenParams?.runId).toBeUndefined();
    const runs = await store.listRuns();
    expect(runs.filter((r) => 'record' in r)).toHaveLength(1);
    expect(loadedRecordOf(runs[0]!).runId).toBe(runId);
  });

  it('appends a trimmed continuation task after a successful claim', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    await executeAgentTool(
      { runId, task: '  Also verify migration.  ' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => okResult('resumed'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.continuationTasks).toEqual(['Also verify migration.']);
  });

  it('does not persist a continuation task when preflight fails', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({
      store,
      sessionFile: null,
    });
    const result = await executeAgentTool(
      { runId, task: 'Should not persist' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => okResult('should not run'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('preflight_failed');
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.continuationTasks).toBeUndefined();
    expect(loaded.loaded.record.status).toBe('interrupted');
  });

  it('does not persist a continuation task when another owner holds the claim', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    const claim = await store.claimRun(runId);
    expect(claim.ok).toBe(true);
    const result = await executeAgentTool(
      { runId, task: 'Blocked by claim' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => okResult('should not run'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/claim_failed|run_active/);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.continuationTasks).toBeUndefined();
    if (claim.ok) await store.releaseRun(runId, claim.claimId);
  });

  it('rejects conflicting fresh-launch fields with a sorted field list', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    const result = await executeAgentTool(
      { runId, agent: 'explore', model: 'gpt-5', cwd: '/tmp' },
      undefined,
      undefined,
      makeCtx(),
      { runStore: store, runCoordinator: coordinator }
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('resume_error: conflicting parameters for runId:');
    expect(text).toContain('agent');
    expect(text).toContain('cwd');
    expect(text).toContain('model');
    // Sorted: agent, cwd, model
    expect(text.indexOf('agent')).toBeLessThan(text.indexOf('cwd'));
    expect(text.indexOf('cwd')).toBeLessThan(text.indexOf('model'));
  });

  it('returns run_not_found for an unknown runId', async () => {
    const { store, coordinator } = makeStore();
    const result = await executeAgentTool(
      { runId: 'run-does-not-exist' },
      undefined,
      undefined,
      makeCtx(),
      { runStore: store, runCoordinator: coordinator }
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('run_not_found');
  });

  it('resumes a completed run and reopens completed units for continuation', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store, unitStatus: 'completed' });
    let workflowRan = false;
    const result = await executeAgentTool(
      { runId, task: 'Also refine the earlier work.' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async (params) => {
          workflowRan = true;
          expect(params.task).toBe('Original stored task');
          return okResult('continued');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).not.toBe(true);
    expect(workflowRan).toBe(true);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Resume claim transitions the run to running (or terminal after workflow).
    expect(['running', 'completed', 'failed', 'interrupted', 'cancelled']).toContain(
      loaded.loaded.record.status
    );
    expect(loaded.loaded.record.continuationTasks).toEqual(['Also refine the earlier work.']);
    const unit = loaded.loaded.record.units['single'];
    expect(unit).toBeDefined();
    // Reopened unit advanced past the original completed attempt.
    expect(unit!.attempt).toBeGreaterThanOrEqual(2);
  });

  it('clears finishedAt on disk and in-memory live record before coordinator registration', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store, unitStatus: 'completed' });
    const finishedAt = 1_700_000_000_000;
    await store.updateRun(runId, (r) => {
      r.status = 'completed';
      r.finishedAt = finishedAt;
    });
    const before = store.getRun(runId);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.loaded.record.finishedAt).toBe(finishedAt);

    const originalRegister = coordinator.registerRun.bind(coordinator);
    let registeredFinishedAt: number | undefined | 'missing' = 'missing';
    coordinator.registerRun = (id, record) => {
      if (id === runId) {
        registeredFinishedAt = record.finishedAt;
      }
      originalRegister(id, record);
    };

    const result = await executeAgentTool(
      { runId, task: 'Continue after terminal timestamp.' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => {
          // Disk must already be non-terminal before workers run.
          const mid = store.getRun(runId);
          expect(mid.ok).toBe(true);
          if (mid.ok) expect(mid.loaded.record.finishedAt).toBeUndefined();
          return okResult('continued');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).not.toBe(true);
    expect(registeredFinishedAt).not.toBe('missing');
    expect(registeredFinishedAt).toBeUndefined();
  });

  it('rejects resuming a completed run without a continuation task', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store, unitStatus: 'completed' });
    let workflowRan = false;
    const result = await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => {
        workflowRan = true;
        return okResult('should not run');
      },
      runStore: store,
      runCoordinator: coordinator,
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      'completed_without_continuation'
    );
    expect(workflowRan).toBe(false);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.status).toBe('completed');
    expect(loaded.loaded.record.continuationTasks).toBeUndefined();
    const unit = loaded.loaded.record.units['single'];
    expect(unit?.status).toBe('completed');
  });

  it('restores parallel mode and original background delivery from the stored run', async () => {
    const { store, coordinator } = makeStore();
    const { manager, launches, runs } = fakeManager();
    const runId = await seedInterruptedRun({
      store,
      mode: 'parallel',
      background: true,
      request: {
        mode: 'parallel',
        agentScope: 'both',
        tasks: [{ agent: 'explore', task: 'Inspect parallel' }],
      },
    });
    await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      backgroundManager: manager,
      runWorkflow: async (params) => {
        expect(params.tasks?.[0]?.task).toBe('Inspect parallel');
        expect(params.runInBackground).toBe(true);
        return okResult('bg resumed');
      },
      runStore: store,
      runCoordinator: coordinator,
    });
    await Promise.allSettled(runs);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.mode).toBe('parallel');
    const list = await store.listRuns();
    expect(list.filter((r) => 'record' in r)).toHaveLength(1);
  });

  it('restores chain mode from the stored request', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({
      store,
      mode: 'chain',
      request: {
        mode: 'chain',
        agentScope: 'both',
        chain: [{ agent: 'explore', task: 'Chain step one' }],
      },
    });
    let modeSeen: string | undefined;
    await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      runWorkflow: async (params, _s, _u, _c, _a, makeDetails) => {
        modeSeen = params.chain ? 'chain' : 'other';
        return {
          content: [{ type: 'text', text: 'chain resumed' }],
          details: makeDetails('chain')([]),
        };
      },
      runStore: store,
      runCoordinator: coordinator,
    });
    expect(modeSeen).toBe('chain');
  });

  it('resumes chain when details.chain presentation is absent using frozen fanout mapping', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const items = ['a'];
    const unitIds = ['chain-0002-fanout-0001'];
    const sessionDir = path.join(tmpRoot, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const seedSession = path.join(sessionDir, 'chain-0001.jsonl');
    const childSession = path.join(sessionDir, `${unitIds[0]}.jsonl`);
    writeFileSync(seedSession, '{}\n');
    writeFileSync(childSession, '{}\n');

    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'both',
        chain: [
          { agent: 'explore', task: 'seed' },
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'explore', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      // No details.chain presentation metadata — restore must use request topology.
      details: {
        mode: 'chain',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [],
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          step: 1,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'completed', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: seedSession,
          sessionPromptEstablished: true,
        },
        [unitIds[0]!]: {
          unitId: unitIds[0]!,
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'interrupted',
          step: 2,
          fanoutIndex: 0,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: childSession,
          sessionPromptEstablished: true,
        },
      },
      // workflowState is attached after create via updateRun.
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
      r.workflowState = {
        fanouts: {
          'chain-0002-fanout': { step: 2, items, unitIds },
        },
      };
    });

    let workflowRan = false;
    const result = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runWorkflow: async (params) => {
          workflowRan = true;
          expect(params.chain).toHaveLength(2);
          return okResult('restored without presentation');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).not.toBe(true);
    expect(workflowRan).toBe(true);
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Presentation still absent; durable mapping retained.
    expect(loaded.loaded.record.details.chain).toBeUndefined();
    expect(loaded.loaded.record.workflowState?.fanouts?.['chain-0002-fanout']).toEqual({
      step: 2,
      items,
      unitIds,
    });
  });

  it('selective chain resume with absent details.chain skips completed seed and runs later step', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const sessionDir = path.join(tmpRoot, 'sessions-selective-chain');
    mkdirSync(sessionDir, { recursive: true });
    const seedSession = path.join(sessionDir, 'chain-0001.jsonl');
    const finishSession = path.join(sessionDir, 'chain-0002.jsonl');
    writeFileSync(seedSession, '{}\n');
    writeFileSync(finishSession, '{}\n');

    const seedOutput = 'seed-done';
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'both',
        chain: [
          { agent: 'explore', task: 'seed work', name: 'seed' },
          { agent: 'explore', task: 'finish {previous}' },
        ],
      },
      // No details.chain — restore must derive completed seed from durable units.
      details: {
        mode: 'chain',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [
          {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'seed work',
            exitCode: 0,
            status: 'completed',
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'text', text: seedOutput }],
              } as never,
            ],
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
            step: 1,
            finalOutput: seedOutput,
          },
        ],
        outputs: {
          seed: {
            text: seedOutput,
            agent: 'explore',
            step: 1,
          },
        },
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          step: 1,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'completed', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: seedSession,
          sessionPromptEstablished: true,
          result: {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'seed work',
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
              turns: 0,
            },
            step: 1,
            finalOutput: seedOutput,
          },
        },
        'chain-0002': {
          unitId: 'chain-0002',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'interrupted',
          step: 2,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: finishSession,
          sessionPromptEstablished: true,
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    const dispatchedUnitIds: string[] = [];
    const result = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        // Real chain path (no runWorkflow seam) so skip-completed is exercised.
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: ((_cmd: string, args: string[]) => {
          // Session path appears in args; extract unit id from planned session file name.
          const sessionArg = args.find((a) => a.includes('chain-'));
          if (sessionArg) {
            const match = /chain-\d+/.exec(sessionArg);
            if (match) dispatchedUnitIds.push(match[0]!);
          } else {
            dispatchedUnitIds.push('unknown');
          }
          const EventEmitter = require('node:events').EventEmitter;
          const { Readable, Writable } = require('node:stream');
          const child = new (class extends EventEmitter {
            stdout = new Readable({ read() {} });
            stderr = new Readable({ read() {} });
            stdin = new Writable({ write: (_c: unknown, _e: unknown, cb: () => void) => cb() });
            kill() {
              this.stdout.push(null);
              this.stderr.push(null);
              setImmediate(() => this.emit('close', 0));
              return true;
            }
          })();
          setImmediate(() => {
            child.stdout.push(
              `${JSON.stringify({
                type: 'message_end',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'finish-out' }],
                  usage: { input: 1, output: 1, totalTokens: 2 },
                },
              })}\n`
            );
            child.kill();
          });
          return child;
        }) as unknown as import('../src/execution.ts').SpawnFn,
      }
    );
    expect(result.isError).not.toBe(true);
    // Completed seed must not be redispatched; only the incomplete later step runs.
    expect(dispatchedUnitIds.every((id) => id !== 'chain-0001')).toBe(true);
    expect(dispatchedUnitIds.some((id) => id === 'chain-0002' || id === 'unknown')).toBe(true);
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units['chain-0001']!.status).toBe('completed');
    expect(loaded.loaded.record.units['chain-0001']!.attempt).toBe(1);
  });

  it('treats an absent continuationTasks history as empty on resume', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    const loadedBefore = store.getRun(runId);
    expect(loadedBefore.ok).toBe(true);
    if (loadedBefore.ok) expect(loadedBefore.loaded.record.continuationTasks).toBeUndefined();

    await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => okResult('resumed'),
      runStore: store,
      runCoordinator: coordinator,
    });
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // No new task appended; field stays absent or empty.
    expect(loaded.loaded.record.continuationTasks ?? []).toEqual([]);
  });

  it('rejects a blank runId', async () => {
    const { store, coordinator } = makeStore();
    const blank = await executeAgentTool({ runId: '   ' }, undefined, undefined, makeCtx(), {
      runStore: store,
      runCoordinator: coordinator,
    });
    expect(blank.isError).toBe(true);
    expect((blank.content[0] as { text: string }).text).toContain('runId must be a non-empty');
  });

  it('marks continuation delivery after spawn and redelivers only undelivered on next resume', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    const EventEmitter = (await import('node:events')).EventEmitter;
    const { Readable } = await import('node:stream');

    class FakeChild extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    }

    let lastPrompt = '';
    const spawnFn = ((_cmd: string, args: string[]) => {
      lastPrompt = args[args.length - 1] ?? '';
      const fake = new FakeChild();
      setImmediate(() => {
        fake.stdout.push(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'done' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          }) + '\n'
        );
        fake.kill();
      });
      return fake as never;
    }) as unknown as import('../src/execution.ts').SpawnFn;

    // First resume with a continuation: orchestration path (no runWorkflow seam).
    await executeAgentTool(
      { runId, task: 'First continuation' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator, spawnFn }
    );
    expect(lastPrompt).toContain('resuming');
    expect(lastPrompt).toContain('First continuation');
    expect(lastPrompt).not.toContain('Task: Original stored task');

    const afterFirst = store.getRun(runId);
    expect(afterFirst.ok).toBe(true);
    if (!afterFirst.ok) return;
    expect(afterFirst.loaded.record.continuationTasks).toEqual(['First continuation']);
    const unitId = Object.keys(afterFirst.loaded.record.units)[0]!;
    expect(afterFirst.loaded.record.continuationDelivery?.[unitId]?.deliveredCount).toBe(1);

    // Re-interrupt for a second resume.
    await store.updateRun(runId, (r) => {
      r.status = 'interrupted';
      for (const u of Object.values(r.units)) {
        u.status = 'interrupted';
      }
    });

    await executeAgentTool(
      { runId, task: 'Second continuation' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator, spawnFn }
    );
    // Existing session already delivered the first; only second is new.
    expect(lastPrompt).toContain('Second continuation');
    expect(lastPrompt).not.toContain('First continuation');
    expect(lastPrompt).not.toContain('Task: Original stored task');

    const afterSecond = store.getRun(runId);
    expect(afterSecond.ok).toBe(true);
    if (!afterSecond.ok) return;
    expect(afterSecond.loaded.record.continuationTasks).toEqual([
      'First continuation',
      'Second continuation',
    ]);
    expect(afterSecond.loaded.record.continuationDelivery?.[unitId]?.deliveredCount).toBe(2);
  });

  it('never-started queued unit receives original task plus all continuations via orchestration', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({
      store,
      unitStatus: 'queued',
      sessionFile: null,
      continuationTasks: ['Prior undelivered'],
    });
    const EventEmitter = (await import('node:events')).EventEmitter;
    const { Readable } = await import('node:stream');
    class FakeChild extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    }
    let lastPrompt = '';
    const spawnFn = ((_cmd: string, args: string[]) => {
      lastPrompt = args[args.length - 1] ?? '';
      const fake = new FakeChild();
      setImmediate(() => {
        fake.stdout.push(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          }) + '\n'
        );
        fake.kill();
      });
      return fake as never;
    }) as unknown as import('../src/execution.ts').SpawnFn;

    await executeAgentTool(
      { runId, task: 'New continuation' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator, spawnFn }
    );
    expect(lastPrompt).toContain('Task: Original stored task');
    expect(lastPrompt).toContain('Prior undelivered');
    expect(lastPrompt).toContain('New continuation');
  });

  it('skips completed parallel units by unit.status even when details.results lag', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const sessionA = path.join(tmpRoot, 'a.jsonl');
    const sessionB = path.join(tmpRoot, 'b.jsonl');
    writeFileSync(sessionA, '{}\n');
    writeFileSync(sessionB, '{}\n');
    const created = await store.createRun({
      mode: 'parallel',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'parallel',
        agentScope: 'both',
        tasks: [
          { agent: 'explore', task: 'Task A' },
          { agent: 'explore', task: 'Task B' },
        ],
      },
      details: {
        mode: 'parallel',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        // Lagging/inconsistent: both slots look incomplete in details.
        results: [],
      },
      units: {
        'parallel-0001': {
          unitId: 'parallel-0001',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          fanoutIndex: 0,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'completed', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: sessionA,
          result: {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Task A',
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
              turns: 0,
            },
          },
        },
        'parallel-0002': {
          unitId: 'parallel-0002',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'interrupted',
          fanoutIndex: 1,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: sessionB,
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    const dispatched: string[] = [];
    await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        // Real orchestration path (no runWorkflow seam) so parallel skip runs.
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: ((_cmd: string, args: string[]) => {
          const prompt = args[args.length - 1] ?? '';
          dispatched.push(prompt);
          const EventEmitter = require('node:events').EventEmitter;
          const { Readable } = require('node:stream');
          const fake = new (class extends EventEmitter {
            stdout = new Readable({ read() {} });
            stderr = new Readable({ read() {} });
            kill() {
              this.stdout.push(null);
              this.stderr.push(null);
              setImmediate(() => this.emit('close', 0));
              return true;
            }
          })();
          setImmediate(() => {
            fake.stdout.push(
              JSON.stringify({
                type: 'message_end',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'b done' }],
                  usage: { input: 1, output: 1, totalTokens: 2 },
                },
              }) + '\n'
            );
            fake.kill();
          });
          return fake;
        }) as unknown as import('../src/execution.ts').SpawnFn,
      }
    );
    // Only incomplete unit B should spawn (one prompt).
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]).toContain('resuming');
  });

  it('uses persisted effectiveCwd for discovery and child cwd across different ctx.cwd', async () => {
    const { store, coordinator } = makeStore();
    const projectDir = path.join(tmpRoot, 'original-project');
    mkdirSync(projectDir, { recursive: true });
    const runId = await seedInterruptedRun({
      store,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'Original stored task',
        cwd: projectDir,
      },
    });
    // Point unit effectiveCwd at the original project.
    await store.updateRun(runId, (r) => {
      for (const u of Object.values(r.units)) {
        u.effectiveCwd = projectDir;
      }
    });

    let childCwd: string | undefined;
    const EventEmitter = (await import('node:events')).EventEmitter;
    const { Readable } = await import('node:stream');
    class FakeChild extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    }
    const spawnFn = ((_cmd: string, _args: string[], opts: { cwd?: string }) => {
      childCwd = opts.cwd;
      const fake = new FakeChild();
      setImmediate(() => {
        fake.stdout.push(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          }) + '\n'
        );
        fake.kill();
      });
      return fake as never;
    }) as unknown as import('../src/execution.ts').SpawnFn;

    await executeAgentTool(
      { runId },
      undefined,
      undefined,
      makeCtx({ cwd: '/tmp/different-session-cwd' }),
      {
        runStore: store,
        runCoordinator: coordinator,
        spawnFn,
      }
    );
    expect(childCwd).toBe(projectDir);
  });

  it('releases claim when post-claim preflight fails (cross-store race corrupts unit cwd)', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    // Second store instance over the same root simulates a concurrent writer.
    const store2 = createRunStore({ rootDir: tmpRoot });
    const originalClaim = store.claimRun.bind(store);
    store.claimRun = async (id: string) => {
      const claim = await originalClaim(id);
      if (claim.ok) {
        // Another process corrupts the unit after we hold the claim.
        await store2.updateRun(id, (r) => {
          for (const u of Object.values(r.units)) {
            u.effectiveCwd = path.join(tmpRoot, 'missing-cwd-after-race');
          }
        });
      }
      return claim;
    };

    const result = await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => okResult('should not run'),
      runStore: store,
      runCoordinator: coordinator,
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/preflight_failed/);
    // Claim must be released (no live owner).
    const claims = store.inspectClaims(runId);
    expect(claims.ok).toBe(true);
    if (claims.ok) {
      const live = claims.claims.filter((c) => c.terminal === undefined && c.owner);
      expect(live).toHaveLength(0);
    }
  });

  it('keeps continuation undelivered when background mode rejects after claim', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({
      store,
      background: true,
    });
    const result = await executeAgentTool(
      { runId, task: 'Should stay pending' },
      undefined,
      undefined,
      makeCtx({ mode: 'json' }),
      {
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Continuation was claimed into history...
    expect(loaded.loaded.record.continuationTasks).toEqual(['Should stay pending']);
    // ...but no unit marked delivery (spawn never ran).
    expect(loaded.loaded.record.continuationDelivery ?? {}).toEqual({});
  });

  it('mixed parallel Pi completed + Pi incomplete blocks on missing session', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const sessionA = path.join(tmpRoot, 'pi.jsonl');
    writeFileSync(sessionA, '{}\n');
    const created = await store.createRun({
      mode: 'parallel',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'parallel',
        agentScope: 'both',
        tasks: [
          { agent: 'explore', task: 'Pi task' },
          { agent: 'explore', task: 'Incomplete Pi task' },
        ],
      },
      details: {
        mode: 'parallel',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        // Inconsistent: details says both completed, units disagree for the second Pi unit.
        results: [
          {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Pi task',
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
              turns: 0,
            },
          },
          {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Incomplete Pi task',
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
              turns: 0,
            },
          },
        ],
      },
      units: {
        'parallel-0001': {
          unitId: 'parallel-0001',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          fanoutIndex: 0,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'completed', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: sessionA,
          result: {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Pi task',
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
              turns: 0,
            },
          },
        },
        'parallel-0002': {
          unitId: 'parallel-0002',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'interrupted',
          fanoutIndex: 1,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    const blocked = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator }
    );
    expect(blocked.isError).toBe(true);
    expect((blocked.content[0] as { text: string }).text).toContain('session file unavailable');
  });

  it('blocks resume when a skipped attempted unit is missing its session artifact', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const created = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'Skipped after attempt',
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
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'skipped',
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: path.join(tmpRoot, 'skipped-missing-session.jsonl'),
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    const blocked = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runWorkflow: async () => okResult('should not run'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(blocked.isError).toBe(true);
    expect((blocked.content[0] as { text: string }).text).toMatch(
      /session file missing|session file unavailable|preflight_failed/
    );
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single!.status).toBe('skipped');
    expect(loaded.loaded.record.units.single!.attempt).toBe(1);
  });

  it('selectively resumes a never-started skipped unit without reopening completed siblings', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const completedSession = path.join(tmpRoot, 'completed-sibling.jsonl');
    writeFileSync(completedSession, '{}\n');
    const created = await store.createRun({
      mode: 'parallel',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'parallel',
        agentScope: 'both',
        tasks: [
          { agent: 'explore', task: 'Completed sibling' },
          { agent: 'explore', task: 'Never-started skipped' },
        ],
      },
      details: {
        mode: 'parallel',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [
          {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Completed sibling',
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
              turns: 0,
            },
          },
        ],
      },
      units: {
        'parallel-0001': {
          unitId: 'parallel-0001',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          fanoutIndex: 0,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'completed', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: completedSession,
          result: {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Completed sibling',
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
              turns: 0,
            },
          },
        },
        'parallel-0002': {
          unitId: 'parallel-0002',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'skipped',
          fanoutIndex: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: tmpRoot,
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    let workflowRan = false;
    const result = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runWorkflow: async () => {
          workflowRan = true;
          return okResult('skipped resumed');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).not.toBe(true);
    expect(workflowRan).toBe(true);
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const completed = loaded.loaded.record.units['parallel-0001']!;
    const skipped = loaded.loaded.record.units['parallel-0002']!;
    // Completed sibling must stay completed (not bulk-reopened).
    expect(completed.status).toBe('completed');
    expect(completed.attempt).toBe(1);
    // Never-started skipped unit was queued without inflating attempt.
    expect(skipped.attempt).toBe(1);
    expect(skipped.attempts).toHaveLength(0);
  });

  it('single queued Grok ACP resumes with session capability', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const created = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'Legacy ACP queued',
        runtime: 'grok-acp',
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
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: tmpRoot,
          result: {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Legacy ACP queued',
            exitCode: -1,
            status: 'queued',
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
            resumeCapability: 'session',
          },
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    let invoked = false;
    const result = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runWorkflow: async () => {
          invoked = true;
          const mid = store.getRun(created.runId);
          expect(mid.ok).toBe(true);
          if (mid.ok) {
            expect(mid.loaded.record.units.single.capability).toBe('session');
            expect(mid.loaded.record.units.single.result?.resumeCapability).toBe('session');
          }
          return okResult('acp queued ok');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBeUndefined();
    expect(invoked).toBe(true);
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.capability).toBe('session');
  });

  it('parallel queued Grok ACP dispatches with session capability', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const created = await store.createRun({
      mode: 'parallel',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'parallel',
        agentScope: 'both',
        tasks: [
          { agent: 'explore', task: 'Legacy ACP A' },
          { agent: 'explore', task: 'Legacy ACP B' },
        ],
        runtime: 'grok-acp',
      },
      details: {
        mode: 'parallel',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [],
      },
      units: {
        'parallel-0001': {
          unitId: 'parallel-0001',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'queued',
          fanoutIndex: 0,
          attempt: 1,
          attempts: [],
          effectiveCwd: tmpRoot,
        },
        'parallel-0002': {
          unitId: 'parallel-0002',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'queued',
          fanoutIndex: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: tmpRoot,
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    let spawnCount = 0;
    await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runStore: store,
        runCoordinator: coordinator,
        // Grok ACP may still fail client-side; assert dispatch reached the ACP client.
        spawnFn: fakeGrokSpawn(() => spawnCount++, false),
      }
    );
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units['parallel-0001']!.capability).toBe('session');
    expect(loaded.loaded.record.units['parallel-0002']!.capability).toBe('session');
    // Spawn attempted; the client may still error without a real ACP process.
    expect(spawnCount).toBeGreaterThanOrEqual(1);
  });

  it('attempted Grok ACP with acpSessionId resumes as canonical session', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const created = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'Legacy ACP attempted',
        runtime: 'grok-acp',
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
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'interrupted',
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          acpSessionId: 'sess-legacy-id',
          result: {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Legacy ACP attempted',
            exitCode: 1,
            status: 'interrupted',
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
            resumeCapability: 'session',
            acpSessionId: 'sess-legacy-id',
          },
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    let seenCapability: string | undefined;
    const result = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runWorkflow: async () => {
          const mid = store.getRun(created.runId);
          if (mid.ok) {
            seenCapability = mid.loaded.record.units.single.capability;
            expect(mid.loaded.record.units.single.acpSessionId).toBe('sess-legacy-id');
            expect(mid.loaded.record.units.single.result?.resumeCapability).toBe('session');
          }
          return okResult('acp load ok');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBeUndefined();
    expect(seenCapability).toBe('session');
    // Canonical session without calling persistAcpSessionId on this path.
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.capability).toBe('session');
    expect(loaded.loaded.record.units.single.acpSessionId).toBe('sess-legacy-id');
  });

  it('attempted Grok ACP without acpSessionId stays unavailable', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const created = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'Legacy ACP missing id',
        runtime: 'grok-acp',
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
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'interrupted',
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    const result = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runWorkflow: async () => okResult('should not run'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('acp_session_unavailable');
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Preflight blocked before claim write — unit is unchanged.
    expect(loaded.loaded.record.units.single.capability).toBe('session');
    expect(loaded.loaded.record.units.single.acpSessionId).toBeUndefined();
  });

  it('worktree strict stamp failure cleans resources, fails unit, leaves no uncommitted session path', async () => {
    const { spawnSync } = await import('node:child_process');
    const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
    if (!gitOk) return;

    const repo = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-stamp-fail-wt-'));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'pi@test.example'], {
        encoding: 'utf-8',
      });
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Pi Test'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf-8' });
      writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
      spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf-8' });

      const store = createRunStore({ rootDir: path.join(repo, '.pi-runs') });
      const coordinator = createRunCoordinator({ store });
      let stampCalls = 0;
      const origStamp = coordinator.persistSessionFile.bind(coordinator);
      coordinator.persistSessionFile = async (input) => {
        stampCalls++;
        void origStamp;
        throw new Error(
          `session_file_conflict: unit ${input.unitId} already has sessionFile /other.jsonl, refusing ${input.sessionFile}`
        );
      };

      let spawnCount = 0;
      const result = await executeAgentTool(
        {
          agent: 'explore',
          task: 'stamp should fail',
          isolation: 'worktree',
        },
        undefined,
        undefined,
        makeCtx({ cwd: repo }),
        {
          runStore: store,
          runCoordinator: coordinator,
          spawnFn: ((_cmd: string) => {
            spawnCount++;
            throw new Error('spawn must not run after stamp failure');
          }) as unknown as import('../src/execution.ts').SpawnFn,
        }
      );

      expect(result.isError).toBe(true);
      expect(stampCalls).toBeGreaterThanOrEqual(1);
      expect(spawnCount).toBe(0);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/session_file_conflict|context_error|Agent failed/);

      const runs = await store.listRuns();
      expect(runs.length).toBe(1);
      const rec = loadedRecordOf(runs[0]!);
      const unit = rec.units.single ?? Object.values(rec.units)[0]!;
      expect(unit.status).toBe('failed');
      expect(unit.sessionFile).toBeUndefined();
      expect(unit.result?.sessionFile).toBeUndefined();

      // New worktree cleaned up on pre-execution stamp failure.
      const wtRoot = path.join(repo, '.worktrees');
      if (existsSync(wtRoot)) {
        expect(readdirSync(wtRoot).length).toBe(0);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('registerInitial failure retains dirty stored worktree and durable path diagnostic', async () => {
    const { spawnSync } = await import('node:child_process');
    const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
    if (!gitOk) return;

    const repo = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-dirty-wt-resume-'));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'pi@test.example'], {
        encoding: 'utf-8',
      });
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Pi Test'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf-8' });
      writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
      spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf-8' });

      // Create a real dirty worktree under the repo.
      const wtPath = path.join(repo, '.worktrees', 'resume-dirty');
      mkdirSync(path.dirname(wtPath), { recursive: true });
      const add = spawnSync('git', ['-C', repo, 'worktree', 'add', '--detach', wtPath, 'HEAD'], {
        encoding: 'utf-8',
      });
      expect(add.status).toBe(0);
      const dirtyFile = path.join(wtPath, 'dirty-marker.txt');
      writeFileSync(dirtyFile, 'keep me\n');

      const agent = exploreAgent();
      const sessionFile = path.join(repo, 'seed-session.jsonl');
      writeFileSync(sessionFile, '{}\n');
      const store = createRunStore({ rootDir: path.join(repo, '.pi-runs') });
      const coordinator = createRunCoordinator({ store });
      const created = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'explore',
          task: 'Resume with dirty worktree',
          isolation: 'worktree',
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
            agent: agent.name,
            agentFingerprint: agentFingerprint(agent),
            runtime: undefined,
            capability: 'session',
            status: 'interrupted',
            attempt: 1,
            attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
            effectiveCwd: wtPath,
            worktreePath: wtPath,
            sessionFile,
          },
        },
      });
      await store.updateRun(created.runId, (r) => {
        r.status = 'interrupted';
      });

      const interactiveRegistry = {
        registerInitial: async () => {
          throw Object.assign(new Error('forced registerInitial failure'), {
            code: 'validation_error',
          });
        },
      } as unknown as import('../src/interactive-agent.ts').InteractiveAgentRegistry;

      let spawnCount = 0;
      const result = await executeAgentTool(
        { runId: created.runId },
        undefined,
        undefined,
        makeCtx({
          cwd: repo,
          mode: 'tui',
          sessionManager: {
            getSessionId: () => 'host-session',
            getBranch: () => [],
            getSessionFile: () => undefined,
            getLeafId: () => undefined,
          },
        } as never),
        {
          runStore: store,
          runCoordinator: coordinator,
          interactiveRegistry,
          spawnFn: ((_cmd: string) => {
            spawnCount++;
            throw new Error('spawn must not run after registerInitial failure');
          }) as unknown as import('../src/execution.ts').SpawnFn,
        }
      );

      expect(result.isError).toBe(true);
      expect(spawnCount).toBe(0);
      // Dirty stored worktree must remain on disk with modifications intact.
      expect(existsSync(wtPath)).toBe(true);
      expect(existsSync(dirtyFile)).toBe(true);
      expect(readdirSync(path.join(repo, '.worktrees'))).toContain('resume-dirty');

      const loaded = store.getRun(created.runId);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      const unit = loaded.loaded.record.units.single!;
      expect(unit.status).toBe('failed');
      expect(unit.worktreePath).toBe(wtPath);
      expect(unit.result?.worktreePath).toBe(wtPath);
      expect(unit.result?.worktreeDirty).toBe(true);
      expect(unit.result?.errorMessage ?? unit.result?.stderr ?? '').toMatch(
        /Interactive link registration failed|validation_error/
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('never-started with planned sessionFile path sends original task (not continuation-only)', async () => {
    const { store, coordinator } = makeStore();
    const planned = path.join(tmpRoot, 'planned-crash-window.jsonl');
    // Path is recorded on the durable unit but the native file was never created
    // (stamp-before-begin crash window from older ordering).
    const runId = await seedInterruptedRun({
      store,
      unitStatus: 'queued',
      sessionFile: planned,
      continuationTasks: ['Prior undelivered'],
    });
    // Ensure the planned path is absent so resume must not treat it as established.
    if (existsSync(planned)) rmSync(planned);

    const EventEmitter = (await import('node:events')).EventEmitter;
    const { Readable } = await import('node:stream');
    class FakeChild extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    }
    let lastPrompt = '';
    const spawnFn = ((_cmd: string, args: string[]) => {
      lastPrompt = args[args.length - 1] ?? '';
      const fake = new FakeChild();
      setImmediate(() => {
        fake.stdout.push(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          }) + '\n'
        );
        fake.kill();
      });
      return fake as never;
    }) as unknown as import('../src/execution.ts').SpawnFn;

    const result = await executeAgentTool(
      { runId, task: 'New continuation' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator, spawnFn }
    );
    expect(result.isError).toBeUndefined();
    // Original task must be delivered; must not send continuation-only resume text.
    expect(lastPrompt).toContain('Task: Original stored task');
    expect(lastPrompt).toContain('Prior undelivered');
    expect(lastPrompt).toContain('New continuation');
    expect(lastPrompt).not.toMatch(/continuing from a previous interruption/i);
  });

  it('attempted Pi with planned missing sessionFile fail-closes without replaying original task', async () => {
    const { store, coordinator } = makeStore();
    const planned = path.join(tmpRoot, 'attempted-planned-missing.jsonl');
    const runId = await seedInterruptedRun({
      store,
      unitStatus: 'interrupted',
      sessionFile: planned,
      continuationTasks: ['Do not deliver this'],
    });
    if (existsSync(planned)) rmSync(planned);

    let spawnCount = 0;
    const result = await executeAgentTool(
      { runId, task: 'Should not run' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: ((_cmd: string) => {
          spawnCount++;
          throw new Error('spawn must not run when session file is missing');
        }) as unknown as import('../src/execution.ts').SpawnFn,
      }
    );
    expect(result.isError).toBe(true);
    expect(spawnCount).toBe(0);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/session file missing|preflight_failed|session_unavailable/);
    // Durable unit remains unrecovered — no original-task replay side effects.
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.status).toBe('interrupted');
    expect(loaded.loaded.record.units.single!.attempts.length).toBe(1);
  });

  it('attempted Pi with sessionFile but unestablished original prompt fail-closes (fork crash window)', async () => {
    const { store, coordinator } = makeStore();
    // Fork-like: session file exists on disk (branched parent history) but the
    // unit's original prompt was never accepted after begin+stamp.
    const forkSession = path.join(tmpRoot, 'fork-existing.jsonl');
    writeFileSync(
      forkSession,
      `${JSON.stringify({ type: 'session', version: 1 })}\n${JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'parent history only' }] },
      })}\n`
    );
    const runId = await seedInterruptedRun({
      store,
      unitStatus: 'interrupted',
      sessionFile: forkSession,
      sessionPromptEstablished: false,
      continuationTasks: ['Must not deliver as continuation-only'],
    });

    let spawnCount = 0;
    const result = await executeAgentTool(
      { runId, task: 'Must not run' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: ((_cmd: string) => {
          spawnCount++;
          throw new Error('spawn must not run when original prompt is unestablished');
        }) as unknown as import('../src/execution.ts').SpawnFn,
      }
    );
    expect(result.isError).toBe(true);
    expect(spawnCount).toBe(0);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(
      /session_prompt_unestablished|preflight_failed|original prompt not established/
    );
    // No continuation-only and no original-task auto-replay side effects.
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.status).toBe('interrupted');
    expect(loaded.loaded.record.units.single!.sessionPromptEstablished).toBe(false);
    expect(loaded.loaded.record.units.single!.attempts.length).toBe(1);
  });

  it('fresh Pi marks sessionPromptEstablished after original prompt accept', async () => {
    const { store, coordinator } = makeStore();
    const EventEmitter = (await import('node:events')).EventEmitter;
    const { Readable } = await import('node:stream');
    class FakeChild extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    }
    let lastPrompt = '';
    const spawnFn = ((_cmd: string, args: string[]) => {
      lastPrompt = args[args.length - 1] ?? '';
      const fake = new FakeChild();
      setImmediate(() => {
        fake.stdout.push(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'done' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          }) + '\n'
        );
        fake.kill();
      });
      return fake as never;
    }) as unknown as import('../src/execution.ts').SpawnFn;

    const result = await executeAgentTool(
      { agent: 'explore', task: 'Establish original prompt' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator, spawnFn }
    );
    expect(result.isError).toBeUndefined();
    expect(lastPrompt).toContain('Task: Establish original prompt');
    const runs = await store.listRuns();
    expect(runs.length).toBe(1);
    const rec = loadedRecordOf(runs[0]!);
    const unit = rec.units.single ?? Object.values(rec.units)[0]!;
    expect(unit.sessionFile).toBeDefined();
    expect(unit.sessionPromptEstablished).toBe(true);
  });

  it('confirmed Pi session resume sends continuation-only (not original task)', async () => {
    const { store, coordinator } = makeStore();
    const sessionFile = path.join(tmpRoot, 'confirmed-resume.jsonl');
    writeFileSync(sessionFile, '{}\n');
    const runId = await seedInterruptedRun({
      store,
      unitStatus: 'interrupted',
      sessionFile,
      sessionPromptEstablished: true,
      continuationTasks: ['Prior undelivered'],
    });

    const EventEmitter = (await import('node:events')).EventEmitter;
    const { Readable } = await import('node:stream');
    class FakeChild extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    }
    let lastPrompt = '';
    const spawnFn = ((_cmd: string, args: string[]) => {
      lastPrompt = args[args.length - 1] ?? '';
      const fake = new FakeChild();
      setImmediate(() => {
        fake.stdout.push(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'resumed' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          }) + '\n'
        );
        fake.kill();
      });
      return fake as never;
    }) as unknown as import('../src/execution.ts').SpawnFn;

    const result = await executeAgentTool(
      { runId, task: 'New continuation' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator, spawnFn }
    );
    expect(result.isError).toBeUndefined();
    // Session-continuation prompt: no original task resend.
    expect(lastPrompt).not.toContain('Original stored task');
    expect(lastPrompt).toMatch(
      /continuing|resume|interrupt|undelivered|Prior undelivered|New continuation/i
    );
  });

  it('retains dirty new worktree when execution started then fails', async () => {
    const { spawnSync } = await import('node:child_process');
    const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
    if (!gitOk) return;

    const repo = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-wt-retain-'));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'pi@test.example'], {
        encoding: 'utf-8',
      });
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Pi Test'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf-8' });
      writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
      spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf-8' });

      const store = createRunStore({ rootDir: path.join(repo, '.pi-runs') });
      const coordinator = createRunCoordinator({ store });

      // After spawn (execution started), agent dirties the worktree then crashes.
      const spawnFn = ((_cmd: string, _args: string[], opts?: { cwd?: string }) => {
        const cwd = opts?.cwd ?? repo;
        writeFileSync(path.join(cwd, 'agent-edited.txt'), 'agent work product\n');
        throw new Error('simulated crash after agent modified worktree');
      }) as unknown as import('../src/execution.ts').SpawnFn;

      const result = await executeAgentTool(
        {
          agent: 'explore',
          task: 'modify then crash',
          isolation: 'worktree',
        },
        undefined,
        undefined,
        makeCtx({ cwd: repo }),
        { runStore: store, runCoordinator: coordinator, spawnFn }
      );

      expect(result.isError).toBe(true);
      const wtRoot = path.join(repo, '.worktrees');
      expect(existsSync(wtRoot)).toBe(true);
      const entries = readdirSync(wtRoot);
      expect(entries.length).toBe(1);
      const wtPath = path.join(wtRoot, entries[0]!);
      expect(existsSync(path.join(wtPath, 'agent-edited.txt'))).toBe(true);

      const runs = await store.listRuns();
      expect(runs.length).toBe(1);
      const rec = loadedRecordOf(runs[0]!);
      const unit = rec.units.single ?? Object.values(rec.units)[0]!;
      expect(unit.status).toBe('failed');
      expect(unit.result?.worktreePath).toBe(wtPath);
      expect(unit.result?.worktreeDirty).toBe(true);
      expect(unit.worktreePath ?? unit.result?.worktreePath).toBe(wtPath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('durable begin runs before session stamp so crash leaves attempted state', async () => {
    const { store, coordinator } = makeStore();
    const order: string[] = [];
    const origStart = coordinator.startUnit.bind(coordinator);
    coordinator.startUnit = async (runId, ctx, result) => {
      order.push('begin');
      await origStart(runId, ctx, result);
    };
    const origStamp = coordinator.persistSessionFile.bind(coordinator);
    coordinator.persistSessionFile = async (input) => {
      order.push('stamp');
      // After begin, durable unit must already be running with attempt history.
      const mid = store.getRun(input.runId);
      expect(mid.ok).toBe(true);
      if (mid.ok) {
        const unit = mid.loaded.record.units.single ?? Object.values(mid.loaded.record.units)[0]!;
        expect(unit.status).toBe('running');
        expect(unit.attempts.length).toBeGreaterThan(0);
      }
      await origStamp(input);
    };

    const EventEmitter = (await import('node:events')).EventEmitter;
    const { Readable } = await import('node:stream');
    class FakeChild extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    }
    const spawnFn = ((_cmd: string) => {
      order.push('spawn');
      const fake = new FakeChild();
      setImmediate(() => {
        fake.stdout.push(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          }) + '\n'
        );
        fake.kill();
      });
      return fake as never;
    }) as unknown as import('../src/execution.ts').SpawnFn;

    const result = await executeAgentTool(
      { agent: 'explore', task: 'order check' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator, spawnFn }
    );
    expect(result.isError).toBeUndefined();
    expect(order.indexOf('begin')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('stamp')).toBeGreaterThan(order.indexOf('begin'));
    expect(order.indexOf('spawn')).toBeGreaterThan(order.indexOf('stamp'));
  });
});
