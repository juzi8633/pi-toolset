// ABOUTME: Tests for runChainWorkflow — sequential handoff, named outputs, template failure, and stop-on-failure.
// ABOUTME: Uses an injected runStep stub so the engine is exercised without spawning real pi processes.

import { describe, expect, it } from 'bun:test';
import { runChainWorkflow, type ChainItemInput, type ChainStepRequest } from '../src/chain.ts';
import type { SingleResult, SubagentDetails } from '../src/types.ts';

const makeDetails = (results: SingleResult[]): SubagentDetails => ({
  mode: 'chain',
  agentScope: 'user',
  projectAgentsDir: null,
  builtinAgentsDir: '/tmp',
  results,
});

function makeAssistantResult(agent: string, text: string, step: number): SingleResult {
  return {
    agent,
    agentSource: 'builtin',
    task: '',
    exitCode: 0,
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
});
