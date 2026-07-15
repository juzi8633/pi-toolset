// ABOUTME: Tests for runChainWorkflow — sequential handoff, named outputs, template failure, and stop-on-failure.
// ABOUTME: Uses an injected runStep stub so the engine is exercised without spawning real pi processes.

import { describe, expect, it } from 'bun:test';
import {
  buildRestoredLogicalSteps,
  runChainWorkflow,
  type ChainItemInput,
  type ChainStepRequest,
} from '../src/chain.ts';
import { chainFanoutStepId, chainFanoutUnitId } from '../src/run-coordinator.ts';
import type { ChainOutputEntry, SingleResult, SubagentDetails } from '../src/types.ts';

const makeDetails = (
  results: SingleResult[],
  outputs?: Record<string, ChainOutputEntry>
): SubagentDetails => ({
  mode: 'chain',
  agentScope: 'user',
  projectAgentsDir: null,
  builtinAgentsDir: '/tmp',
  results,
  ...(outputs && Object.keys(outputs).length > 0 ? { outputs } : {}),
});

function makeAssistantResult(agent: string, text: string, step: number): SingleResult {
  return {
    agent,
    agentSource: 'builtin',
    task: '',
    exitCode: 0,
    status: 'completed',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text }],
      } as unknown as SingleResult['messages'][number],
    ],
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
    step,
  };
}

function makeFailureResult(agent: string, step: number, message: string): SingleResult {
  return {
    agent,
    agentSource: 'builtin',
    task: '',
    exitCode: 1,
    status: 'failed',
    messages: [],
    stderr: message,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    stopReason: 'error',
    errorMessage: message,
    step,
  };
}

function makeRunningPartial(agent: string, text: string, step: number): SingleResult {
  return {
    agent,
    agentSource: 'builtin',
    task: '',
    exitCode: -1,
    status: 'running',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text }],
      } as unknown as SingleResult['messages'][number],
    ],
    stderr: '',
    usage: {
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 10,
      turns: 1,
    },
    step,
  };
}

describe('runChainWorkflow', () => {
  it('passes the previous final output to the next step', async () => {
    const calls: ChainStepRequest[] = [];
    const chain: ChainItemInput[] = [
      { agent: 'a', task: 'first' },
      { agent: 'b', task: 'use {previous}' },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        calls.push(req);
        return makeAssistantResult(req.agent, `${req.agent} done`, req.step);
      },
    });

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[0].task).toBe('first');
    expect(calls[1].task).toBe('use a done');
  });

  it('substitutes {outputs.<name>} from a prior named step', async () => {
    const calls: ChainStepRequest[] = [];
    const chain: ChainItemInput[] = [
      { agent: 'planner', task: 'plan', name: 'plan' },
      { agent: 'impl', task: 'execute {outputs.plan}' },
    ];
    await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        calls.push(req);
        return makeAssistantResult(req.agent, 'PLAN-OUT', req.step);
      },
    });

    expect(calls[1].task).toBe('execute PLAN-OUT');
  });

  it('stops with template_error when {outputs.<name>} is unknown', async () => {
    let called = 0;
    const chain: ChainItemInput[] = [
      { agent: 'a', task: 'use {outputs.missing}' },
      { agent: 'b', task: 'never' },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        called++;
        return makeAssistantResult(req.agent, 'x', req.step);
      },
    });

    expect(called).toBe(0);
    expect(res.isError).toBe(true);
    const last = res.details.results[res.details.results.length - 1];
    expect(last.stopReason).toBe('template_error');
    expect(last.errorMessage).toContain('missing');
  });

  it('stops the chain when a step fails and does not run later steps', async () => {
    const calls: ChainStepRequest[] = [];
    const chain: ChainItemInput[] = [
      { agent: 'a', task: 'first' },
      { agent: 'b', task: 'second' },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        calls.push(req);
        if (req.step === 1) return makeFailureResult(req.agent, req.step, 'boom');
        return makeAssistantResult(req.agent, 'ok', req.step);
      },
    });

    expect(calls).toHaveLength(1);
    expect(res.isError).toBe(true);
    expect(res.details.results).toHaveLength(1);
  });

  it('stops with template_error after a successful step, preserving prior results', async () => {
    const calls: ChainStepRequest[] = [];
    const chain: ChainItemInput[] = [
      { agent: 'a', task: 'first', name: 'first' },
      { agent: 'b', task: 'use {outputs.missing}' },
      { agent: 'c', task: 'never' },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        calls.push(req);
        return makeAssistantResult(req.agent, `${req.agent} done`, req.step);
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe('a');
    expect(res.isError).toBe(true);
    expect(res.details.results).toHaveLength(2);
    expect(res.details.results[0].agent).toBe('a');
    expect(res.details.results[1].stopReason).toBe('template_error');
  });

  it('parses and validates outputSchema then exposes structuredOutput via outputs', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'list files',
        name: 'context',
        outputSchema: {
          type: 'object',
          required: ['files'],
          properties: { files: { type: 'array', items: { type: 'string' } } },
        },
      },
      { agent: 'planner', task: 'use {outputs.context}' },
    ];
    let plannerTask = '';
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.agent === 'explore') {
          return makeAssistantResult(req.agent, '{"files":["a.ts"]}', req.step);
        }
        plannerTask = req.task;
        return makeAssistantResult(req.agent, 'planned', req.step);
      },
    });

    expect(res.isError).toBeUndefined();
    expect(res.details.outputs).toBeDefined();
    expect(res.details.outputs!.context.structured).toEqual({ files: ['a.ts'] });
    expect(plannerTask).toBe('use {"files":["a.ts"]}');
  });

  it('stops with structured_output_error when output fails the schema', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'list files',
        outputSchema: {
          type: 'object',
          required: ['files'],
          properties: { files: { type: 'array', items: { type: 'string' } } },
        },
      },
      { agent: 'planner', task: 'never' },
    ];
    let plannerCalled = false;
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.agent === 'planner') plannerCalled = true;
        return makeAssistantResult(req.agent, '{}', req.step);
      },
    });

    expect(plannerCalled).toBe(false);
    expect(res.isError).toBe(true);
    const failing = res.details.results[0];
    expect(failing.stopReason).toBe('structured_output_error');
    expect(failing.structuredOutputError).toContain('missing required');
  });

  it('stops with structured_output_error when output is not parseable JSON', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'list files',
        outputSchema: { type: 'object' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => makeAssistantResult(req.agent, 'no json here', req.step),
    });
    expect(res.isError).toBe(true);
    const failing = res.details.results[0];
    expect(failing.stopReason).toBe('structured_output_error');
    expect(failing.structuredOutputError).toContain('parse');
  });

  it('treats null outputSchema as no schema', async () => {
    let observed = '';
    const chain: ChainItemInput[] = [
      {
        agent: 'a',
        task: 'go',
        outputSchema: null as unknown as Record<string, unknown>,
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        observed = req.task;
        return makeAssistantResult(req.agent, 'plain prose', req.step);
      },
    });
    expect(observed).toBe('go');
    expect(res.isError).toBeUndefined();
  });

  it('fails the step when outputSchema is not an object', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'a',
        task: 'go',
        outputSchema: [] as unknown as Record<string, unknown>,
      },
    ];
    let runStepCalled = false;
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        runStepCalled = true;
        return makeAssistantResult(req.agent, '{}', req.step);
      },
    });
    expect(runStepCalled).toBe(false);
    expect(res.isError).toBe(true);
    expect(res.details.results[0].stopReason).toBe('structured_output_error');
  });

  it('reports a structured_output_error when schema keywords are malformed', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'a',
        task: 'go',
        outputSchema: { enum: 'not-an-array' } as unknown as Record<string, unknown>,
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => makeAssistantResult(req.agent, '"hello"', req.step),
    });
    expect(res.isError).toBe(true);
    expect(res.details.results[0].stopReason).toBe('structured_output_error');
  });

  it('returns the collected fanout text as the chain final output when fanout is the last step', async () => {
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
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.agent === 'explore')
          return makeAssistantResult(req.agent, '{"items":["a","b"]}', req.step);
        return makeAssistantResult(req.agent, `done ${req.task}`, req.step);
      },
    });
    expect(res.isError).toBeUndefined();
    const final = res.content[0];
    expect(final.type).toBe('text');
    if (final.type === 'text') {
      const parsed = JSON.parse(final.text);
      expect(parsed).toEqual(['done Process a', 'done Process b']);
    }
  });

  it('truncates fanout items to expand.maxItems and notes the skipped count', async () => {
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
        expand: { from: { output: 'context', path: '/items' }, maxItems: 1 },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'results' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.agent === 'explore')
          return makeAssistantResult(req.agent, '{"items":["a","b"]}', req.step);
        return makeAssistantResult(req.agent, 'ok', req.step);
      },
    });
    expect(res.isError).toBeUndefined();
    const entry = res.details.outputs!.results;
    expect(Array.isArray(entry.structured)).toBe(true);
    expect((entry.structured as unknown[]).length).toBe(1);
    expect(entry.text).toContain('skipped 1');
  });

  it('fails fanout when expand.maxItems is not a positive integer', async () => {
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
        expand: { from: { output: 'context', path: '/items' }, maxItems: 0 },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'results' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => makeAssistantResult(req.agent, '{"items":["a"]}', req.step),
    });
    expect(res.isError).toBe(true);
    expect(res.details.results.at(-1)?.stopReason).toBe('fanout_error');
  });

  it('rejects ambiguous chain steps that mix sequential and fanout fields', async () => {
    const ambiguous = {
      agent: 'explore',
      task: 'mixed',
      expand: { from: { output: 'context', path: '/items' } },
      parallel: { agent: 'worker', task: 'Process {item}' },
      collect: { name: 'results' },
    } as unknown as ChainItemInput;
    const res = await runChainWorkflow({
      chain: [ambiguous],
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => makeAssistantResult(req.agent, 'ok', req.step),
    });
    expect(res.isError).toBe(true);
    expect(res.details.results[0].stopReason).toBe('fanout_error');
  });

  it('runs fanout over a structured array and collects results', async () => {
    const tasks: string[] = [];
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
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        tasks.push(req.task);
        if (req.agent === 'explore') {
          return makeAssistantResult(req.agent, '{"items":["a","b"]}', req.step);
        }
        return makeAssistantResult(req.agent, `done ${req.task}`, req.step);
      },
    });

    expect(res.isError).toBeUndefined();
    expect(tasks).toContain('Process a');
    expect(tasks).toContain('Process b');
    expect(res.details.outputs!.results.structured).toHaveLength(2);
  });

  it('stops fanout when JSON Pointer does not resolve to an array', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'find items',
        name: 'context',
        outputSchema: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'string' } },
        },
      },
      {
        expand: { from: { output: 'context', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'results' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => makeAssistantResult(req.agent, '{"items":"nope"}', req.step),
    });

    expect(res.isError).toBe(true);
    expect(res.details.results[1].stopReason).toBe('fanout_error');
  });

  it('runs all fanout subtasks and reports aggregate failure', async () => {
    const calls: string[] = [];
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
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        calls.push(req.task);
        if (req.agent === 'explore') {
          return makeAssistantResult(req.agent, '{"items":["a","b"]}', req.step);
        }
        if (req.task.endsWith('b')) return makeFailureResult(req.agent, req.step, 'bad b');
        return makeAssistantResult(req.agent, 'ok', req.step);
      },
    });

    expect(calls).toContain('Process a');
    expect(calls).toContain('Process b');
    expect(res.isError).toBe(true);
    const summary = res.content[0];
    expect(summary.type).toBe('text');
    if (summary.type === 'text') expect(summary.text).toContain('Fanout failed: 1/2 succeeded');
  });

  it('appends a JSON-only instruction to tasks that declare outputSchema', async () => {
    let observed = '';
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'base task',
        outputSchema: { type: 'object', required: ['k'], properties: { k: { type: 'string' } } },
      },
    ];
    await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        observed = req.task;
        return makeAssistantResult(req.agent, '{"k":"v"}', req.step);
      },
    });
    expect(observed.startsWith('base task')).toBe(true);
    expect(observed).toContain('IMPORTANT');
    expect(observed).toContain('"required":');
  });

  it('upserts sequential partials by step and exposes logical chain metadata', async () => {
    const snapshots: SubagentDetails[] = [];
    const chain: ChainItemInput[] = [
      { agent: 'a', task: 'first' },
      { agent: 'b', task: 'second' },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: (partial) => {
        if (partial.details) snapshots.push(partial.details);
      },
      makeDetails,
      runStep: async (req) => {
        if (req.onUpdate) {
          req.onUpdate({
            content: [{ type: 'text', text: 'partial' }],
            details: makeDetails([makeRunningPartial(req.agent, 'p1', req.step)]),
          });
          req.onUpdate({
            content: [{ type: 'text', text: 'partial2' }],
            details: makeDetails([makeRunningPartial(req.agent, 'p2', req.step)]),
          });
        }
        return makeAssistantResult(req.agent, `${req.agent} done`, req.step);
      },
    });

    expect(res.isError).toBeUndefined();
    expect(res.details.chain?.totalSteps).toBe(2);
    expect(res.details.chain?.steps).toHaveLength(2);
    expect(res.details.chain?.steps.every((s) => s.status === 'completed')).toBe(true);
    expect(res.details.results).toHaveLength(2);

    // During step 1 partials, results should not grow beyond one sequential slot
    const step1Partials = snapshots.filter(
      (d) =>
        d.results.length === 1 && d.results[0].agent === 'a' && d.results[0].status === 'running'
    );
    expect(step1Partials.length).toBeGreaterThanOrEqual(1);
    for (const snap of step1Partials) {
      expect(snap.results).toHaveLength(1);
      expect(snap.chain?.totalSteps).toBe(2);
    }
  });

  it('marks later logical steps skipped after a failure', async () => {
    const chain: ChainItemInput[] = [
      { agent: 'a', task: 'first' },
      { agent: 'b', task: 'second' },
      { agent: 'c', task: 'third' },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.step === 1) return makeFailureResult(req.agent, req.step, 'boom');
        return makeAssistantResult(req.agent, 'ok', req.step);
      },
    });
    expect(res.isError).toBe(true);
    expect(res.details.chain?.totalSteps).toBe(3);
    expect(res.details.chain?.steps[0].status).toBe('failed');
    expect(res.details.chain?.steps[1].status).toBe('skipped');
    expect(res.details.chain?.steps[2].status).toBe('skipped');
  });

  it('preserves partial chain state on cancellation', async () => {
    const chain: ChainItemInput[] = [
      { agent: 'a', task: 'first' },
      { agent: 'b', task: 'second' },
      { agent: 'c', task: 'third' },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.step === 1) return makeAssistantResult(req.agent, 'ok', req.step);
        throw new Error('Subagent was aborted');
      },
    });
    expect(res.isError).toBe(true);
    expect(res.details.results[0].status).toBe('completed');
    expect(res.details.chain?.steps[0].status).toBe('completed');
    expect(res.details.chain?.steps[1].status).toBe('cancelled');
    expect(res.details.chain?.steps[2].status).toBe('skipped');
  });

  it('fanout cancel stops scheduling, settles started workers, and ignores late updates', async () => {
    const controller = new AbortController();
    const updates: SubagentDetails[] = [];
    let lateUpdatesAfterTerminal = 0;
    let terminalSeen = false;

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
        concurrency: 2,
      },
      { agent: 'summary', task: 'wrap up' },
    ];

    const resolvers: Array<() => void> = [];
    const gates = [0, 1, 2, 3].map(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        })
    );
    let startedWorkers = 0;
    let resolveTwoStarted!: () => void;
    const twoStarted = new Promise<void>((resolve) => {
      resolveTwoStarted = resolve;
    });

    const runPromise = runChainWorkflow({
      chain,
      signal: controller.signal,
      onUpdate: (partial) => {
        if (partial.details) {
          if (terminalSeen) lateUpdatesAfterTerminal++;
          updates.push(partial.details);
          const fanout = partial.details.chain?.steps.find((s) => s.kind === 'fanout');
          if (fanout?.status === 'cancelled') terminalSeen = true;
        }
      },
      makeDetails,
      runStep: async (req) => {
        if (req.agent === 'explore') {
          return makeAssistantResult(req.agent, '{"items":["a","b","c","d"]}', req.step);
        }
        if (req.agent === 'summary') {
          throw new Error('summary should not run after fanout cancel');
        }
        const match = /Process ([abcd])/.exec(req.task);
        const letter = match?.[1] ?? 'a';
        const index = letter.charCodeAt(0) - 'a'.charCodeAt(0);
        startedWorkers++;
        if (startedWorkers === 2) resolveTwoStarted();
        // Emit a progressive update then wait
        req.onUpdate?.({
          content: [{ type: 'text', text: `working ${letter}` }],
          details: {
            mode: 'single',
            agentScope: 'user',
            projectAgentsDir: null,
            builtinAgentsDir: '/tmp',
            results: [
              {
                ...makeRunningPartial(req.agent, `working ${letter}`, req.step),
                fanout: { index, count: 4, itemTask: req.task },
              },
            ],
          },
        });
        await gates[index];
        // Late update after parent may have terminalized
        req.onUpdate?.({
          content: [{ type: 'text', text: `late ${letter}` }],
          details: {
            mode: 'single',
            agentScope: 'user',
            projectAgentsDir: null,
            builtinAgentsDir: '/tmp',
            results: [
              {
                ...makeRunningPartial(req.agent, `late ${letter}`, req.step),
                fanout: { index, count: 4, itemTask: req.task },
              },
            ],
          },
        });
        if (controller.signal.aborted) {
          throw new Error('Subagent was aborted');
        }
        return makeAssistantResult(req.agent, `done ${letter}`, req.step);
      },
    });

    await twoStarted;
    controller.abort();
    await new Promise((r) => setTimeout(r, 10));
    // Release started workers; unstarted must not have been scheduled.
    for (const resolve of resolvers) resolve();

    const res = await runPromise;
    expect(res.isError).toBe(true);
    expect(startedWorkers).toBe(2);
    expect(res.details.chain?.steps[1].status).toBe('cancelled');
    expect(res.details.chain?.steps[2].status).toBe('skipped');
    const fanoutResults = res.details.results.filter((r) => r.fanout);
    expect(fanoutResults).toHaveLength(4);
    // Ordered slots preserved
    expect(fanoutResults.map((r) => r.fanout?.index)).toEqual([0, 1, 2, 3]);
    const statuses = fanoutResults.map((r) => r.status);
    expect(statuses.filter((s) => s === 'cancelled').length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((s) => s === 'skipped').length).toBeGreaterThanOrEqual(1);
    // No late onUpdate should mutate terminal fanout after cancel finalize
    expect(lateUpdatesAfterTerminal).toBe(0);
  });

  it('counts fanout progress from statuses, not index+1, and keeps ordered slots', async () => {
    const updates: SubagentDetails[] = [];
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
        concurrency: 3,
      },
    ];

    // Resolve order: item 2 first, then 0, then 1 (concurrency 3 so all start)
    const resolvers: Array<() => void> = [];
    const gates = [0, 1, 2].map(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        })
    );

    let started = 0;
    let resolveStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const runPromise = runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: (partial) => {
        if (partial.details) updates.push(partial.details);
      },
      makeDetails,
      runStep: async (req) => {
        if (req.agent === 'explore') {
          return makeAssistantResult(req.agent, '{"items":["a","b","c"]}', req.step);
        }
        const match = /Process ([abc])/.exec(req.task);
        const letter = match?.[1] ?? '';
        const index = letter === 'a' ? 0 : letter === 'b' ? 1 : 2;
        started++;
        if (started === 3) resolveStarted();
        await gates[index];
        return makeAssistantResult(req.agent, `done ${letter}`, req.step);
      },
    });

    await allStarted;
    // Complete item 2 first — completedCount must be 1, not index+1 (3)
    resolvers[2]();
    await new Promise((r) => setTimeout(r, 30));

    const mid = updates
      .map((u) => u.chain?.steps.find((s) => s.kind === 'fanout'))
      .filter((s): s is NonNullable<typeof s> => !!s && s.kind === 'fanout')
      .find((s) => s.completedCount === 1);
    expect(mid).toBeDefined();
    expect(mid!.completedCount).toBe(1);
    expect(mid!.executedCount).toBe(3);

    resolvers[0]();
    resolvers[1]();
    const res = await runPromise;
    expect(res.isError).toBeUndefined();
    const fanoutResults = res.details.results.filter((r) => r.fanout);
    expect(fanoutResults).toHaveLength(3);
    expect(fanoutResults.map((r) => r.fanout!.index)).toEqual([0, 1, 2]);
    expect(res.details.chain?.steps[1].kind).toBe('fanout');
    if (res.details.chain?.steps[1].kind === 'fanout') {
      expect(res.details.chain.steps[1].completedCount).toBe(3);
      expect(res.details.chain.steps[1].status).toBe('completed');
    }
    // Fanout is one logical step; totalSteps stays 2
    expect(res.details.chain?.totalSteps).toBe(2);
  });

  it('handles empty fanout source as successful 0/0', async () => {
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
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.agent === 'explore')
          return makeAssistantResult(req.agent, '{"items":[]}', req.step);
        return makeAssistantResult(req.agent, 'should not run', req.step);
      },
    });
    expect(res.isError).toBeUndefined();
    expect(res.details.outputs!.results.structured).toEqual([]);
    const fanoutStep = res.details.chain?.steps[1];
    expect(fanoutStep?.kind).toBe('fanout');
    if (fanoutStep?.kind === 'fanout') {
      expect(fanoutStep.executedCount).toBe(0);
      expect(fanoutStep.status).toBe('completed');
    }
  });

  it('records skipped maxItems without fake results', async () => {
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
        expand: { from: { output: 'context', path: '/items' }, maxItems: 1 },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'results' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.agent === 'explore')
          return makeAssistantResult(req.agent, '{"items":["a","b","c"]}', req.step);
        return makeAssistantResult(req.agent, 'ok', req.step);
      },
    });
    expect(res.isError).toBeUndefined();
    const fanoutResults = res.details.results.filter((r) => r.fanout);
    expect(fanoutResults).toHaveLength(1);
    const fanoutStep = res.details.chain?.steps[1];
    if (fanoutStep?.kind === 'fanout') {
      expect(fanoutStep.executedCount).toBe(1);
      expect(fanoutStep.skippedCount).toBe(2);
    }
  });

  it('awaits onFanoutExpand before any fanout runStep and passes fanoutIndex', async () => {
    const events: string[] = [];
    const indexes: number[] = [];
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
        concurrency: 3,
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      onFanoutExpand: async (req) => {
        events.push(`expand:${req.items.length}`);
        expect(req.step).toBe(2);
        expect(req.agent).toBe('worker');
        expect(req.items).toEqual(['a', 'b', 'c']);
      },
      runStep: async (req) => {
        if (req.agent === 'explore') {
          events.push('seed');
          return makeAssistantResult(req.agent, '{"items":["a","b","c"]}', req.step);
        }
        events.push(`step:${req.fanoutIndex}`);
        indexes.push(req.fanoutIndex!);
        return makeAssistantResult(req.agent, `ok-${req.fanoutIndex}`, req.step);
      },
    });
    expect(res.isError).toBeUndefined();
    expect(events[0]).toBe('seed');
    expect(events[1]).toBe('expand:3');
    expect(events.slice(2).sort()).toEqual(['step:0', 'step:1', 'step:2']);
    expect(indexes.sort()).toEqual([0, 1, 2]);
  });

  it('invokes onFanoutExpand for empty scheduled items before returning 0/0', async () => {
    let expandCalled = false;
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
      },
    ];
    let workerCalls = 0;
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      onFanoutExpand: async (req) => {
        expandCalled = true;
        expect(req.items).toEqual([]);
      },
      runStep: async (req) => {
        if (req.agent === 'explore')
          return makeAssistantResult(req.agent, '{"items":[]}', req.step);
        workerCalls++;
        return makeAssistantResult(req.agent, 'nope', req.step);
      },
    });
    expect(expandCalled).toBe(true);
    expect(workerCalls).toBe(0);
    expect(res.isError).toBeUndefined();
  });

  it('creates expansion items only for maxItems-scheduled subset', async () => {
    let expanded: unknown[] | undefined;
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
        expand: { from: { output: 'context', path: '/items' }, maxItems: 2 },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'results' },
      },
    ];
    await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      onFanoutExpand: async (req) => {
        expanded = req.items;
      },
      runStep: async (req) => {
        if (req.agent === 'explore')
          return makeAssistantResult(req.agent, '{"items":["a","b","c","d"]}', req.step);
        return makeAssistantResult(req.agent, 'ok', req.step);
      },
    });
    expect(expanded).toEqual(['a', 'b']);
  });

  it('fails the fanout when onFanoutExpand rejects without scheduling workers', async () => {
    let workerCalls = 0;
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
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      onFanoutExpand: async () => {
        throw new Error('disk full');
      },
      runStep: async (req) => {
        if (req.agent === 'explore')
          return makeAssistantResult(req.agent, '{"items":["a"]}', req.step);
        workerCalls++;
        return makeAssistantResult(req.agent, 'ok', req.step);
      },
    });
    expect(workerCalls).toBe(0);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('expansion persistence failed');
  });

  it('cancel with concurrency < item count leaves unstarted presentation slots skipped', async () => {
    const controller = new AbortController();
    let started = 0;
    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'find',
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
        concurrency: 1,
      },
    ];
    const runPromise = runChainWorkflow({
      chain,
      signal: controller.signal,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.agent === 'explore') {
          return makeAssistantResult(req.agent, '{"items":["a","b","c","d"]}', req.step);
        }
        started++;
        if (started === 1) resolveFirstStarted();
        await gate;
        if (controller.signal.aborted) {
          throw new Error('Subagent was aborted');
        }
        return makeAssistantResult(req.agent, 'late', req.step);
      },
    });
    await firstStarted;
    controller.abort();
    resolveGate();
    const res = await runPromise;
    expect(res.isError).toBe(true);
    // Concurrency 1: only the in-flight worker started; others stay unscheduled.
    expect(started).toBe(1);
    const fanoutResults = res.details.results.filter((r) => r.fanout);
    expect(fanoutResults).toHaveLength(4);
    const statuses = fanoutResults.map((r) => r.status);
    expect(statuses.filter((s) => s === 'cancelled').length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((s) => s === 'skipped').length).toBeGreaterThanOrEqual(1);
  });
});

describe('runChainWorkflow title propagation', () => {
  it('stamps step titles onto ChainStepRequest, results, and logical steps', async () => {
    const calls: ChainStepRequest[] = [];
    const chain: ChainItemInput[] = [
      { agent: 'a', task: 'first', title: '第一步' },
      { agent: 'b', task: 'second', title: '第二步' },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        calls.push(req);
        const r = makeAssistantResult(req.agent, 'out', req.step);
        r.title = req.title;
        return r;
      },
    });
    expect(calls[0].title).toBe('第一步');
    expect(calls[1].title).toBe('第二步');
    expect(res.details.results[0].title).toBe('第一步');
    expect(res.details.results[1].title).toBe('第二步');
    expect(res.details.chain?.steps[0].title).toBe('第一步');
    expect(res.details.chain?.steps[1].title).toBe('第二步');
  });

  it('stamps the fanout parallel.title onto the logical step and item results', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        name: 'context',
        task: 'list items',
        outputSchema: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
      },
      {
        expand: { from: { output: 'context', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}', title: '处理项' },
        collect: { name: 'results' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        const r = makeAssistantResult(
          req.agent,
          req.agent === 'explore' ? '{"items":["a","b"]}' : 'ok',
          req.step
        );
        r.title = req.title;
        return r;
      },
    });
    const fanoutStep = res.details.chain?.steps[1];
    expect(fanoutStep?.kind).toBe('fanout');
    if (fanoutStep?.kind === 'fanout') {
      expect(fanoutStep.title).toBe('处理项');
    }
    const fanoutResults = res.details.results.filter((r) => r.fanout);
    expect(fanoutResults).toHaveLength(2);
    for (const r of fanoutResults) {
      expect(r.title).toBe('处理项');
    }
  });

  it('omits title on logical steps and results when not provided', async () => {
    const chain: ChainItemInput[] = [{ agent: 'a', task: 'first' }];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => makeAssistantResult(req.agent, 'out', req.step),
    });
    expect(res.details.chain?.steps[0].title).toBeUndefined();
    expect(res.details.results[0].title).toBeUndefined();
  });
});

describe('buildRestoredLogicalSteps', () => {
  it('builds a complete array from request topology when presentation is absent', () => {
    const chain: ChainItemInput[] = [
      { agent: 'seed', task: 'seed' },
      {
        expand: { from: { output: 'seed', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'out' },
      },
      { agent: 'finish', task: 'done {previous}' },
    ];
    const steps = buildRestoredLogicalSteps(chain, undefined, {});
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({
      kind: 'sequential',
      step: 1,
      agent: 'seed',
      status: 'queued',
    });
    expect(steps[1]).toMatchObject({
      kind: 'fanout',
      step: 2,
      agent: 'worker',
      status: 'queued',
      collectName: 'out',
    });
    expect(steps[2]).toMatchObject({
      kind: 'sequential',
      step: 3,
      agent: 'finish',
      status: 'queued',
    });
  });

  it('overlays shortened presentation by step and re-queues incomplete units', () => {
    const chain: ChainItemInput[] = [
      { agent: 'seed', task: 'seed' },
      {
        expand: { from: { output: 'seed', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'out' },
      },
      { agent: 'finish', task: 'done' },
    ];
    // Presentation only covers the first step (shortened / stale metadata).
    const presentation = [
      {
        kind: 'sequential' as const,
        step: 1,
        agent: 'seed',
        task: 'seed',
        status: 'completed' as const,
      },
    ];
    const units = {
      'chain-0001': {
        unitId: 'chain-0001',
        agent: 'seed',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session' as const,
        status: 'completed' as const,
        step: 1,
        attempt: 1,
        attempts: [],
        effectiveCwd: '/tmp',
      },
      'chain-0002-fanout-0001': {
        unitId: 'chain-0002-fanout-0001',
        agent: 'worker',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session' as const,
        status: 'interrupted' as const,
        step: 2,
        fanoutIndex: 0,
        attempt: 1,
        attempts: [],
        effectiveCwd: '/tmp',
      },
    };
    const steps = buildRestoredLogicalSteps(chain, presentation, units);
    expect(steps).toHaveLength(3);
    expect(steps[0]!.status).toBe('completed');
    expect(steps[1]).toMatchObject({ kind: 'fanout', step: 2, agent: 'worker', status: 'queued' });
    expect(steps[2]).toMatchObject({
      kind: 'sequential',
      step: 3,
      agent: 'finish',
      status: 'queued',
    });
  });

  it('derives completed sequential status from durable units when presentation is absent', () => {
    const chain: ChainItemInput[] = [
      { agent: 'seed', task: 'seed' },
      { agent: 'finish', task: 'finish {previous}' },
    ];
    const units = {
      'chain-0001': {
        unitId: 'chain-0001',
        agent: 'seed',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session' as const,
        status: 'completed' as const,
        step: 1,
        attempt: 1,
        attempts: [],
        effectiveCwd: '/tmp',
      },
      'chain-0002': {
        unitId: 'chain-0002',
        agent: 'finish',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session' as const,
        status: 'interrupted' as const,
        step: 2,
        attempt: 1,
        attempts: [],
        effectiveCwd: '/tmp',
      },
    };
    const steps = buildRestoredLogicalSteps(chain, undefined, units);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.status).toBe('completed');
    expect(steps[1]!.status).toBe('queued');
  });

  it('re-queues reopened completed units so all-completed continuation redispatches', () => {
    const chain: ChainItemInput[] = [
      { agent: 'seed', task: 'seed' },
      { agent: 'finish', task: 'finish' },
    ];
    // After reopenCompletedUnitsForResume, completed units are interrupted.
    const units = {
      'chain-0001': {
        unitId: 'chain-0001',
        agent: 'seed',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session' as const,
        status: 'interrupted' as const,
        step: 1,
        attempt: 2,
        attempts: [],
        effectiveCwd: '/tmp',
      },
      'chain-0002': {
        unitId: 'chain-0002',
        agent: 'finish',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session' as const,
        status: 'interrupted' as const,
        step: 2,
        attempt: 2,
        attempts: [],
        effectiveCwd: '/tmp',
      },
    };
    const presentation = [
      {
        kind: 'sequential' as const,
        step: 1,
        agent: 'seed',
        task: 'seed',
        status: 'completed' as const,
      },
      {
        kind: 'sequential' as const,
        step: 2,
        agent: 'finish',
        task: 'finish',
        status: 'completed' as const,
      },
    ];
    const steps = buildRestoredLogicalSteps(chain, presentation, units);
    expect(steps[0]!.status).toBe('queued');
    expect(steps[1]!.status).toBe('queued');
  });

  it('skips completed seed and dispatches incomplete later step when presentation is absent', async () => {
    const chain: ChainItemInput[] = [
      { agent: 'seed', task: 'seed work', name: 'seed' },
      { agent: 'finish', task: 'finish {previous}' },
    ];
    const seedOutput = 'seed-done';
    const units: Record<string, import('../src/run-types.ts').RunUnitRecord> = {
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
        result: makeAssistantResult('seed', seedOutput, 1),
      },
      'chain-0002': {
        unitId: 'chain-0002',
        agent: 'finish',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session',
        status: 'interrupted',
        step: 2,
        attempt: 2,
        attempts: [],
        effectiveCwd: '/tmp',
      },
    };
    const calls: Array<{ agent: string; step: number; task: string }> = [];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req: ChainStepRequest) => {
        calls.push({ agent: req.agent, step: req.step, task: req.task });
        return makeAssistantResult(req.agent, `${req.agent}-out`, req.step);
      },
      restored: {
        results: [makeAssistantResult('seed', seedOutput, 1)],
        outputs: {
          seed: {
            text: seedOutput,
            structured: undefined,
            agent: 'seed',
            step: 1,
          },
        },
        // No presentation steps — status must come from durable units.
        logicalSteps: [],
        units,
      },
    });
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual([{ agent: 'finish', step: 2, task: 'finish seed-done' }]);
    expect(res.details.chain?.steps[0]?.status).toBe('completed');
    expect(res.details.chain?.steps[1]?.status).toBe('completed');
  });

  it('uses durable sequential unit result for previous output when presentation results lag', async () => {
    const chain: ChainItemInput[] = [
      { agent: 'seed', task: 'seed work', name: 'seed' },
      { agent: 'finish', task: 'finish {previous} / {outputs.seed}' },
    ];
    const seedOutput = 'durable-seed-text';
    const durableSeed = makeAssistantResult('seed', seedOutput, 1);
    durableSeed.finalOutput = seedOutput;
    const units: Record<string, import('../src/run-types.ts').RunUnitRecord> = {
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
        result: durableSeed,
      },
      'chain-0002': {
        unitId: 'chain-0002',
        agent: 'finish',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session',
        status: 'interrupted',
        step: 2,
        attempt: 2,
        attempts: [],
        effectiveCwd: '/tmp',
      },
    };
    const calls: Array<{ agent: string; task: string }> = [];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req: ChainStepRequest) => {
        calls.push({ agent: req.agent, task: req.task });
        return makeAssistantResult(req.agent, `${req.agent}-out`, req.step);
      },
      restored: {
        // Presentation results and named outputs intentionally empty/stale.
        results: [],
        outputs: {},
        logicalSteps: [],
        units,
      },
    });
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual([{ agent: 'finish', task: `finish ${seedOutput} / ${seedOutput}` }]);
    // Durable unit.result must not be mutated by rehydrate (clone on insert).
    expect(durableSeed.messages).toHaveLength(1);
    expect(units['chain-0001']!.result).toBe(durableSeed);
  });

  it('rehydrates named structured outputs from durable unit for fanout expansion', async () => {
    const items = ['alpha', 'beta'];
    const structured = { items };
    const seedText = JSON.stringify(structured);
    const durableSeed = makeAssistantResult('seed', seedText, 1);
    durableSeed.finalOutput = seedText;
    durableSeed.structuredOutput = structured;
    // Only sequential seed unit exists — fanout never expanded; no frozen mapping.
    // Expansion must read rehydrated `{outputs.seed}` structured data.
    const units: Record<string, import('../src/run-types.ts').RunUnitRecord> = {
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
        result: durableSeed,
      },
    };
    const chain: ChainItemInput[] = [
      {
        agent: 'seed',
        task: 'seed',
        name: 'seed',
        outputSchema: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
      },
      {
        expand: { from: { output: 'seed', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'out' },
      },
    ];
    const fanoutTasks: string[] = [];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.fanoutIndex !== undefined) {
          fanoutTasks.push(req.task);
          return makeAssistantResult(req.agent, `item-${req.fanoutIndex}`, req.step);
        }
        throw new Error(`unexpected redispatch of ${req.agent}`);
      },
      restored: {
        // Presentation outputs/results intentionally lag; durable unit has structuredOutput.
        results: [],
        outputs: {},
        logicalSteps: [],
        units,
      },
    });
    expect(res.isError).toBeUndefined();
    expect(fanoutTasks).toEqual(['Process alpha', 'Process beta']);
    // Rehydrate must clone structuredOutput so presentation mutations stay local.
    expect(res.details.outputs?.seed?.structured).not.toBe(durableSeed.structuredOutput);
    expect(res.details.outputs?.seed?.structured).toEqual({ items: ['alpha', 'beta'] });
    (res.details.outputs!.seed!.structured as { items: string[] }).items.push('mutated');
    expect(durableSeed.structuredOutput).toEqual({ items: ['alpha', 'beta'] });
    expect(units['chain-0001']!.result).toBe(durableSeed);
  });

  it('prefers durable unit result over stale presentation sequential output', async () => {
    const chain: ChainItemInput[] = [
      { agent: 'seed', task: 'seed', name: 'seed' },
      { agent: 'finish', task: 'use {previous}' },
    ];
    const durableSeed = makeAssistantResult('seed', 'durable-correct', 1);
    durableSeed.finalOutput = 'durable-correct';
    const stalePresentation = makeAssistantResult('seed', 'stale-wrong', 1);
    const units: Record<string, import('../src/run-types.ts').RunUnitRecord> = {
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
        result: durableSeed,
      },
      'chain-0002': {
        unitId: 'chain-0002',
        agent: 'finish',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session',
        status: 'interrupted',
        step: 2,
        attempt: 1,
        attempts: [],
        effectiveCwd: '/tmp',
      },
    };
    const calls: string[] = [];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        calls.push(req.task);
        return makeAssistantResult(req.agent, 'done', req.step);
      },
      restored: {
        results: [stalePresentation],
        outputs: {
          seed: { text: 'stale-wrong', structured: undefined, agent: 'seed', step: 1 },
        },
        logicalSteps: [
          {
            kind: 'sequential',
            step: 1,
            agent: 'seed',
            task: 'seed',
            status: 'completed',
          },
        ],
        units,
      },
    });
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual(['use durable-correct']);
  });

  it('preserves later fanout collect over earlier sequential same-name on rehydrate', async () => {
    // Step 1 sequential name "shared" collides with step 2 fanout collect "shared".
    // Normal later-step-wins must hold on restore: rehydrate must not clobber the fanout value.
    const earlyText = 'early-sequential';
    const laterFanoutText = '["later-fanout-a","later-fanout-b"]';
    const durableSeed = makeAssistantResult('seed', earlyText, 1);
    durableSeed.finalOutput = earlyText;
    const fanoutChild0 = makeAssistantResult('worker', 'later-fanout-a', 2);
    fanoutChild0.finalOutput = 'later-fanout-a';
    const fanoutChild1 = makeAssistantResult('worker', 'later-fanout-b', 2);
    fanoutChild1.finalOutput = 'later-fanout-b';
    const units: Record<string, import('../src/run-types.ts').RunUnitRecord> = {
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
        result: durableSeed,
      },
      [chainFanoutUnitId(2, 0)]: {
        unitId: chainFanoutUnitId(2, 0),
        agent: 'worker',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session',
        status: 'completed',
        step: 2,
        fanoutIndex: 0,
        attempt: 1,
        attempts: [],
        effectiveCwd: '/tmp',
        result: fanoutChild0,
      },
      [chainFanoutUnitId(2, 1)]: {
        unitId: chainFanoutUnitId(2, 1),
        agent: 'worker',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session',
        status: 'completed',
        step: 2,
        fanoutIndex: 1,
        attempt: 1,
        attempts: [],
        effectiveCwd: '/tmp',
        result: fanoutChild1,
      },
      'chain-0003': {
        unitId: 'chain-0003',
        agent: 'finish',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session',
        status: 'interrupted',
        step: 3,
        attempt: 1,
        attempts: [],
        effectiveCwd: '/tmp',
      },
    };
    const chain: ChainItemInput[] = [
      { agent: 'seed', task: 'seed', name: 'shared' },
      {
        expand: { from: { output: 'shared', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'shared' },
      },
      { agent: 'finish', task: 'downstream sees {outputs.shared}' },
    ];
    const fanoutStepId = chainFanoutStepId(2);
    const calls: string[] = [];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        calls.push(req.task);
        return makeAssistantResult(req.agent, 'done', req.step);
      },
      restored: {
        // Presentation already has later fanout collect under the colliding name.
        results: [durableSeed, fanoutChild0, fanoutChild1],
        outputs: {
          shared: {
            text: laterFanoutText,
            structured: ['later-fanout-a', 'later-fanout-b'],
            agent: 'worker',
            step: 2,
          },
        },
        logicalSteps: [
          {
            kind: 'sequential',
            step: 1,
            agent: 'seed',
            task: 'seed',
            status: 'completed',
          },
          {
            kind: 'fanout',
            step: 2,
            agent: 'worker',
            taskTemplate: 'Process {item}',
            status: 'completed',
            sourceOutput: 'shared',
            sourcePath: '/items',
            collectName: 'shared',
            executedCount: 2,
            completedCount: 2,
            failedCount: 0,
            runningCount: 0,
            queuedCount: 0,
            skippedCount: 0,
          },
        ],
        units,
        fanouts: {
          [fanoutStepId]: {
            step: 2,
            items: ['later-fanout-a', 'later-fanout-b'],
            unitIds: [chainFanoutUnitId(2, 0), chainFanoutUnitId(2, 1)],
          },
        },
      },
    });
    expect(res.isError).toBeUndefined();
    // Only the incomplete later sequential step dispatches; seed/fanout stay completed.
    expect(calls).toEqual([`downstream sees ${laterFanoutText}`]);
    expect(res.details.outputs?.shared?.text).toBe(laterFanoutText);
    expect(res.details.outputs?.shared?.step).toBe(2);
    expect(res.details.outputs?.shared?.structured).toEqual(['later-fanout-a', 'later-fanout-b']);
    // Clone/immutability: presentation mutation must not touch durable unit result.
    expect(units['chain-0001']!.result).toBe(durableSeed);
    expect(durableSeed.finalOutput).toBe(earlyText);
  });

  it('pads short restored state and dispatches later steps from frozen fanout mapping', async () => {
    const items = ['a'];
    const unitIds = [chainFanoutUnitId(2, 0)];
    const units: Record<string, import('../src/run-types.ts').RunUnitRecord> = {
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
        result: makeAssistantResult('seed', JSON.stringify({ items }), 1),
      },
      [unitIds[0]!]: {
        unitId: unitIds[0]!,
        agent: 'worker',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session',
        status: 'interrupted',
        step: 2,
        fanoutIndex: 0,
        attempt: 2,
        attempts: [],
        effectiveCwd: '/tmp',
      },
    };
    const chain: ChainItemInput[] = [
      {
        agent: 'seed',
        task: 'seed',
        name: 'seed',
        outputSchema: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
      },
      {
        expand: { from: { output: 'seed', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'out' },
      },
    ];
    const calls: number[] = [];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.fanoutIndex !== undefined) {
          calls.push(req.fanoutIndex);
          return makeAssistantResult(req.agent, `item-${req.fanoutIndex}`, req.step);
        }
        return makeAssistantResult(req.agent, JSON.stringify({ items }), req.step);
      },
      restored: {
        results: [makeAssistantResult('seed', JSON.stringify({ items }), 1)],
        outputs: {
          seed: {
            text: JSON.stringify({ items }),
            structured: { items },
            agent: 'seed',
            step: 1,
          },
        },
        // Intentionally short presentation — only seed step.
        logicalSteps: [
          {
            kind: 'sequential',
            step: 1,
            agent: 'seed',
            task: 'seed',
            status: 'completed',
          },
        ],
        units,
        fanouts: {
          [chainFanoutStepId(2)]: { step: 2, items, unitIds },
        },
      },
    });
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual([0]);
    expect(res.details.chain?.steps).toHaveLength(2);
    expect(res.details.chain?.steps[1]?.kind).toBe('fanout');
  });

  it('queues empty fanout mapping without presentation/output (crash window)', () => {
    const chain: ChainItemInput[] = [
      { agent: 'seed', task: 'seed' },
      {
        expand: { from: { output: 'seed', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'out' },
      },
      { agent: 'finish', task: 'done {previous}' },
    ];
    const units = {
      'chain-0001': {
        unitId: 'chain-0001',
        agent: 'seed',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session' as const,
        status: 'completed' as const,
        step: 1,
        attempt: 1,
        attempts: [],
        effectiveCwd: '/tmp',
      },
    };
    const emptyFanouts = {
      [chainFanoutStepId(2)]: { step: 2, items: [] as unknown[], unitIds: [] as string[] },
    };
    // Mapping alone, no presentation, no collect output → must queue.
    const steps = buildRestoredLogicalSteps(chain, undefined, units, emptyFanouts);
    expect(steps[1]).toMatchObject({ kind: 'fanout', step: 2, status: 'queued' });
  });

  it('keeps empty fanout completed when presentation status proves completion', () => {
    const chain: ChainItemInput[] = [
      { agent: 'seed', task: 'seed' },
      {
        expand: { from: { output: 'seed', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'out' },
      },
    ];
    const units = {
      'chain-0001': {
        unitId: 'chain-0001',
        agent: 'seed',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session' as const,
        status: 'completed' as const,
        step: 1,
        attempt: 1,
        attempts: [],
        effectiveCwd: '/tmp',
      },
    };
    const presentation = [
      {
        kind: 'sequential' as const,
        step: 1,
        agent: 'seed',
        task: 'seed',
        status: 'completed' as const,
      },
      {
        kind: 'fanout' as const,
        step: 2,
        agent: 'worker',
        taskTemplate: 'Process {item}',
        status: 'completed' as const,
        collectName: 'out',
        executedCount: 0,
        completedCount: 0,
        failedCount: 0,
        runningCount: 0,
        queuedCount: 0,
        skippedCount: 0,
      },
    ];
    const emptyFanouts = {
      [chainFanoutStepId(2)]: { step: 2, items: [] as unknown[], unitIds: [] as string[] },
    };
    const steps = buildRestoredLogicalSteps(chain, presentation, units, emptyFanouts);
    expect(steps[1]).toMatchObject({ kind: 'fanout', step: 2, status: 'completed' });
  });

  it('re-runs empty fanout crash window to reconstruct [] collect and previous', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'seed',
        task: 'seed',
        name: 'seed',
        outputSchema: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
      },
      {
        expand: { from: { output: 'seed', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'out' },
      },
      { agent: 'finish', task: 'after {previous}' },
    ];
    const units: Record<string, import('../src/run-types.ts').RunUnitRecord> = {
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
        result: makeAssistantResult('seed', JSON.stringify({ items: [] }), 1),
      },
      'chain-0003': {
        unitId: 'chain-0003',
        agent: 'finish',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session',
        status: 'interrupted',
        step: 3,
        attempt: 2,
        attempts: [],
        effectiveCwd: '/tmp',
      },
    };
    const expandCalls: Array<{ step: number; items: unknown[] }> = [];
    const calls: Array<{ agent: string; step: number; task: string }> = [];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req: ChainStepRequest) => {
        calls.push({ agent: req.agent, step: req.step, task: req.task });
        return makeAssistantResult(req.agent, `${req.agent}-out`, req.step);
      },
      onFanoutExpand: async (req) => {
        expandCalls.push({ step: req.step, items: req.items });
        return { step: req.step, items: req.items, unitIds: [] };
      },
      restored: {
        results: [makeAssistantResult('seed', JSON.stringify({ items: [] }), 1)],
        outputs: {
          seed: {
            text: JSON.stringify({ items: [] }),
            structured: { items: [] },
            agent: 'seed',
            step: 1,
          },
          // Collect output missing — crash between expand persist and empty completion.
        },
        logicalSteps: [
          {
            kind: 'sequential',
            step: 1,
            agent: 'seed',
            task: 'seed',
            status: 'completed',
          },
          {
            kind: 'fanout',
            step: 2,
            agent: 'worker',
            taskTemplate: 'Process {item}',
            // Presentation incomplete: expansion persisted, collect not written.
            status: 'running',
            collectName: 'out',
            executedCount: 0,
            completedCount: 0,
            failedCount: 0,
            runningCount: 0,
            queuedCount: 0,
            skippedCount: 0,
          },
        ],
        units,
        fanouts: {
          [chainFanoutStepId(2)]: { step: 2, items: [], unitIds: [] },
        },
      },
    });
    expect(res.isError).toBeUndefined();
    // Zero-worker fanout re-ran via restored empty expansion (no workers dispatched).
    expect(expandCalls).toEqual([{ step: 2, items: [] }]);
    expect(calls).toEqual([{ agent: 'finish', step: 3, task: 'after []' }]);
    expect(res.details.outputs?.out?.structured).toEqual([]);
    expect(res.details.chain?.steps[1]?.status).toBe('completed');
  });

  it('preserves truly completed empty fanout and skips re-dispatch on selective resume', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'seed',
        task: 'seed',
        name: 'seed',
        outputSchema: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
      },
      {
        expand: { from: { output: 'seed', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'out' },
      },
      { agent: 'finish', task: 'after {previous}' },
    ];
    const units: Record<string, import('../src/run-types.ts').RunUnitRecord> = {
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
        result: makeAssistantResult('seed', JSON.stringify({ items: [] }), 1),
      },
      'chain-0003': {
        unitId: 'chain-0003',
        agent: 'finish',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session',
        status: 'interrupted',
        step: 3,
        attempt: 2,
        attempts: [],
        effectiveCwd: '/tmp',
      },
    };
    const expandCalls: unknown[] = [];
    const calls: Array<{ agent: string; task: string }> = [];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req: ChainStepRequest) => {
        calls.push({ agent: req.agent, task: req.task });
        return makeAssistantResult(req.agent, `${req.agent}-out`, req.step);
      },
      onFanoutExpand: async (req) => {
        expandCalls.push(req);
        return { step: req.step, items: req.items, unitIds: [] };
      },
      restored: {
        results: [makeAssistantResult('seed', JSON.stringify({ items: [] }), 1)],
        outputs: {
          seed: {
            text: JSON.stringify({ items: [] }),
            structured: { items: [] },
            agent: 'seed',
            step: 1,
          },
          out: {
            text: '[]',
            structured: [],
            agent: 'worker',
            step: 2,
          },
        },
        logicalSteps: [
          {
            kind: 'sequential',
            step: 1,
            agent: 'seed',
            task: 'seed',
            status: 'completed',
          },
          {
            kind: 'fanout',
            step: 2,
            agent: 'worker',
            taskTemplate: 'Process {item}',
            status: 'completed',
            collectName: 'out',
            executedCount: 0,
            completedCount: 0,
            failedCount: 0,
            runningCount: 0,
            queuedCount: 0,
            skippedCount: 0,
          },
        ],
        units,
        fanouts: {
          [chainFanoutStepId(2)]: { step: 2, items: [], unitIds: [] },
        },
      },
    });
    expect(res.isError).toBeUndefined();
    expect(expandCalls).toEqual([]);
    expect(calls).toEqual([{ agent: 'finish', task: 'after []' }]);
    expect(res.details.outputs?.out?.structured).toEqual([]);
  });
});
