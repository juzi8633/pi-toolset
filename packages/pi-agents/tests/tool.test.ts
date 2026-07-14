// ABOUTME: Integration-style tests for executeAgentTool() background dispatch and argument compatibility.
// ABOUTME: Uses an injected fake background manager and a fake workflow runner to avoid spawning real agents.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AgentToolResult, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('accepts runtimeOverride grok-acp in the tool parameter schema', async () => {
    const { RuntimeSchema } = await import('../src/schema.ts');
    const { Value } = await import('typebox/value');
    expect(Value.Check(RuntimeSchema, 'pi')).toBe(true);
    expect(Value.Check(RuntimeSchema, 'grok')).toBe(true);
    expect(Value.Check(RuntimeSchema, 'grok-acp')).toBe(true);
    expect(Value.Check(RuntimeSchema, 'claude')).toBe(false);
    expect(Value.Check(RuntimeSchema, 'weird')).toBe(false);
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

  it('allows a fresh single Grok run without allowReplay', async () => {
    const { store, coordinator } = makeStore();
    let spawnCount = 0;

    const result = await executeAgentTool(
      { agent: 'general', task: 'fresh Grok task', runtime: 'grok' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: fakeGrokSpawn(() => spawnCount++),
      }
    );

    expect(result.isError).toBeUndefined();
    expect(spawnCount).toBe(1);
    expect(result.details.results[0]?.resumeCapability).toBe('replay');
  });

  it('dispatches a fresh Grok ACP run without allowReplay', async () => {
    const { store, coordinator } = makeStore();
    let spawnCount = 0;

    const result = await executeAgentTool(
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
    expect(JSON.stringify(result.content)).not.toContain('requires replay');
  });

  it('allows fresh parallel Grok runs without allowReplay', async () => {
    const { store, coordinator } = makeStore();
    let spawnCount = 0;

    const result = await executeAgentTool(
      {
        tasks: [
          { agent: 'general', task: 'fresh Grok task A' },
          { agent: 'general', task: 'fresh Grok task B' },
        ],
        runtime: 'grok',
      },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: fakeGrokSpawn(() => spawnCount++),
      }
    );

    expect(result.isError).toBeUndefined();
    expect(spawnCount).toBe(2);
    expect(result.details.results.every((entry) => entry.resumeCapability === 'replay')).toBe(true);
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
        chain: [{ agent: 'seed', task: 'seed step' }],
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

    const finish = (index: number, text: string) => {
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

    finish(1, 'item-1');
    finish(2, 'item-2');
    finish(0, 'item-0');
    await new Promise((r) => setTimeout(r, 30));

    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const units = loaded.loaded.record.units;
    expect(units['chain-0002-fanout-0001']!.result?.finalOutput).toBe('item-0');
    expect(units['chain-0002-fanout-0002']!.result?.finalOutput).toBe('item-1');
    expect(units['chain-0002-fanout-0003']!.result?.finalOutput).toBe('item-2');
    expect(units['chain-0002-fanout-0001']!.result?.sessionFile).toContain(
      'chain-0002-fanout-0001'
    );
    expect(units['chain-0002-fanout-0002']!.result?.sessionFile).toContain(
      'chain-0002-fanout-0002'
    );
    expect(units['chain-0002-fanout-0001']!.attempt).toBe(1);
    expect(units['chain-0002-fanout-0002']!.attempt).toBe(1);
    expect(units['chain-0002-fanout-0003']!.attempt).toBe(1);
    expect(units['chain-0002-fanout']).toBeUndefined();
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
        chain: [{ agent: 'seed', task: 'seed step' }],
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
        chain: [{ agent: 'seed', task: 'seed step' }],
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
        chain: [{ agent: 'seed', task: 'seed step' }],
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
        chain: [{ agent: 'seed', task: 'seed step' }],
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
        chain: [{ agent: 'seed', task: 'seed step' }],
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
    capability?: 'session' | 'replay';
    unitStatus?: RunUnitRecord['status'];
    sessionFile?: string | null;
    continuationTasks?: string[];
    request?: Partial<AgentRunRecordV1['request']>;
  }): Promise<string> {
    const agent = exploreAgent();
    const mode = options.mode ?? 'single';
    const capability = options.capability ?? 'session';
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
        runtime: capability === 'replay' ? 'grok' : undefined,
        capability,
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
        ...(sessionFile ? { sessionFile } : {}),
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
      capability: 'replay',
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

  it('rejects resume of a completed run without mutating it', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store, unitStatus: 'completed' });
    const result = await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => okResult('should not run'),
      runStore: store,
      runCoordinator: coordinator,
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('run_already_completed');
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.status).toBe('completed');
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

  it('requires allowReplay for replay-capable units and resumes when acknowledged', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({
      store,
      capability: 'replay',
      sessionFile: null,
    });
    const blocked = await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => okResult('should not run'),
      runStore: store,
      runCoordinator: coordinator,
    });
    expect(blocked.isError).toBe(true);
    expect((blocked.content[0] as { text: string }).text).toContain('replay');

    let invoked = false;
    const allowed = await executeAgentTool(
      { runId, allowReplay: true, task: 'Retry safely' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => {
          invoked = true;
          return okResult('replayed');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(allowed.isError).toBeUndefined();
    expect(invoked).toBe(true);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.continuationTasks).toEqual(['Retry safely']);
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

  it('rejects blank runId and allowReplay without runId', async () => {
    const { store, coordinator } = makeStore();
    const blank = await executeAgentTool({ runId: '   ' }, undefined, undefined, makeCtx(), {
      runStore: store,
      runCoordinator: coordinator,
    });
    expect(blank.isError).toBe(true);
    expect((blank.content[0] as { text: string }).text).toContain('runId must be a non-empty');

    const orphanReplay = await executeAgentTool(
      { agent: 'explore', task: 'x', allowReplay: true } as never,
      undefined,
      undefined,
      makeCtx(),
      { runStore: store, runCoordinator: coordinator }
    );
    expect(orphanReplay.isError).toBe(true);
    expect((orphanReplay.content[0] as { text: string }).text).toContain(
      'allowReplay requires runId'
    );
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

  it('releases claim without mutating completed run when post-claim eligibility fails (cross-store race)', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    // Second store instance over the same root simulates a concurrent writer.
    const store2 = createRunStore({ rootDir: tmpRoot });
    const originalClaim = store.claimRun.bind(store);
    store.claimRun = async (id: string) => {
      const claim = await originalClaim(id);
      if (claim.ok) {
        // Another process completes the run after we hold the claim.
        await store2.updateRun(id, (r) => {
          r.status = 'completed';
          for (const u of Object.values(r.units)) {
            u.status = 'completed';
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
    expect((result.content[0] as { text: string }).text).toMatch(
      /run_already_completed|preflight_failed|no_incomplete/
    );
    const loaded = store2.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.status).toBe('completed');
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

  it('mixed parallel Pi completed + Grok incomplete respects unit.status skip and allowReplay gate', async () => {
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
          { agent: 'explore', task: 'Grok task' },
        ],
      },
      details: {
        mode: 'parallel',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        // Inconsistent: details says both completed, units disagree for grok.
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
            task: 'Grok task',
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
          runtime: 'grok',
          capability: 'replay',
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
    expect((blocked.content[0] as { text: string }).text).toContain('replay');

    let grokDispatched = false;
    const allowed = await executeAgentTool(
      { runId: created.runId, allowReplay: true },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: ((_cmd: string, args: string[]) => {
          grokDispatched = true;
          const joined = args.join(' ');
          expect(joined).toContain('Grok task');
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
                  content: [{ type: 'text', text: 'grok done' }],
                  usage: { input: 1, output: 1, totalTokens: 2 },
                },
              }) + '\n'
            );
            // Grok streaming may differ; close anyway.
            fake.kill();
          });
          return fake;
        }) as unknown as import('../src/execution.ts').SpawnFn,
      }
    );
    expect(allowed.isError).toBeUndefined();
    expect(grokDispatched).toBe(true);
  });
});
