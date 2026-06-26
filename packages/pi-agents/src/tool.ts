// ABOUTME: Tool orchestration for the `agent` tool — mode dispatch, confirmation, and result assembly.
// ABOUTME: Owns single/parallel/chain execution flows so `index.ts` stays a thin extension entrypoint.

import type { Static } from '@earendil-works/pi-ai';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { type AgentConfig, type AgentScope, discoverAgents } from './agents.ts';
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS } from './constants.ts';
import { mapWithConcurrencyLimit, type OnUpdateCallback, runSingleAgent } from './execution.ts';
import {
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  truncateParallelOutput,
} from './output.ts';
import type { SubagentParams } from './schema.ts';
import type { SingleResult, SubagentDetails } from './types.ts';

type Params = Static<typeof SubagentParams>;
type Mode = 'single' | 'parallel' | 'chain';
type AgentResult = AgentToolResult<SubagentDetails> & { isError?: boolean };
type DetailsFactory = (mode: Mode) => (results: SingleResult[]) => SubagentDetails;

export async function executeAgentTool(
  params: Params,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  ctx: ExtensionContext
): Promise<AgentResult> {
  const agentScope: AgentScope = params.agentScope ?? 'user';
  const discovery = discoverAgents(ctx.cwd, agentScope);
  const agents = discovery.agents;
  const confirmProjectAgents = params.confirmProjectAgents ?? true;

  const hasChain = (params.chain?.length ?? 0) > 0;
  const hasTasks = (params.tasks?.length ?? 0) > 0;
  const hasSingle = Boolean(params.agent && params.task);
  const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

  const makeDetails: DetailsFactory =
    (mode) =>
    (results): SubagentDetails => ({
      mode,
      agentScope,
      projectAgentsDir: discovery.projectAgentsDir,
      builtinAgentsDir: discovery.builtinAgentsDir,
      results,
    });

  if (modeCount !== 1) {
    const available = agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none';
    return {
      content: [
        {
          type: 'text',
          text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
        },
      ],
      details: makeDetails('single')([]),
    };
  }

  if ((agentScope === 'project' || agentScope === 'both') && confirmProjectAgents && ctx.hasUI) {
    const requestedAgentNames = new Set<string>();
    if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
    if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
    if (params.agent) requestedAgentNames.add(params.agent);

    const projectAgentsRequested = Array.from(requestedAgentNames)
      .map((name) => agents.find((a) => a.name === name))
      .filter((a): a is AgentConfig => a?.source === 'project');

    if (projectAgentsRequested.length > 0) {
      const names = projectAgentsRequested.map((a) => a.name).join(', ');
      const dir = discovery.projectAgentsDir ?? '(unknown)';
      const ok = await ctx.ui.confirm(
        'Run project-local agents?',
        `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`
      );
      if (!ok)
        return {
          content: [{ type: 'text', text: 'Canceled: project-local agents not approved.' }],
          details: makeDetails(hasChain ? 'chain' : hasTasks ? 'parallel' : 'single')([]),
        };
    }
  }

  if (params.chain && params.chain.length > 0) {
    return await runChain(ctx, agents, params.chain, signal, onUpdate, makeDetails);
  }
  if (params.tasks && params.tasks.length > 0) {
    return await runParallel(ctx, agents, params.tasks, signal, onUpdate, makeDetails);
  }
  if (params.agent && params.task) {
    return await runSingle(
      ctx,
      agents,
      params.agent,
      params.task,
      params.cwd,
      signal,
      onUpdate,
      makeDetails
    );
  }

  const available = agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none';
  return {
    content: [{ type: 'text', text: `Invalid parameters. Available agents: ${available}` }],
    details: makeDetails('single')([]),
  };
}

async function runChain(
  ctx: ExtensionContext,
  agents: AgentConfig[],
  chain: NonNullable<Params['chain']>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  makeDetails: DetailsFactory
): Promise<AgentResult> {
  const results: SingleResult[] = [];
  let previousOutput = '';

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

    const chainUpdate: OnUpdateCallback | undefined = onUpdate
      ? (partial) => {
          const currentResult = partial.details?.results[0];
          if (currentResult) {
            const allResults = [...results, currentResult];
            onUpdate({
              content: partial.content,
              details: makeDetails('chain')(allResults),
            });
          }
        }
      : undefined;

    const result = await runSingleAgent(
      ctx.cwd,
      agents,
      step.agent,
      taskWithContext,
      step.cwd,
      i + 1,
      signal,
      chainUpdate,
      makeDetails('chain')
    );
    results.push(result);

    if (isFailedResult(result)) {
      const errorMsg = getResultOutput(result);
      return {
        content: [
          { type: 'text', text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` },
        ],
        details: makeDetails('chain')(results),
        isError: true,
      };
    }
    previousOutput = getFinalOutput(result.messages);
  }

  return {
    content: [
      {
        type: 'text',
        text: getFinalOutput(results[results.length - 1].messages) || '(no output)',
      },
    ],
    details: makeDetails('chain')(results),
  };
}

async function runParallel(
  ctx: ExtensionContext,
  agents: AgentConfig[],
  tasks: NonNullable<Params['tasks']>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  makeDetails: DetailsFactory
): Promise<AgentResult> {
  if (tasks.length > MAX_PARALLEL_TASKS)
    return {
      content: [
        {
          type: 'text',
          text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
        },
      ],
      details: makeDetails('parallel')([]),
    };

  const allResults: SingleResult[] = new Array(tasks.length);
  for (let i = 0; i < tasks.length; i++) {
    allResults[i] = {
      agent: tasks[i].agent,
      agentSource: 'unknown',
      task: tasks[i].task,
      exitCode: -1,
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
    };
  }

  const emitParallelUpdate = () => {
    if (onUpdate) {
      const running = allResults.filter((r) => r.exitCode === -1).length;
      const done = allResults.filter((r) => r.exitCode !== -1).length;
      onUpdate({
        content: [
          {
            type: 'text',
            text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
          },
        ],
        details: makeDetails('parallel')([...allResults]),
      });
    }
  };

  const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
    const result = await runSingleAgent(
      ctx.cwd,
      agents,
      t.agent,
      t.task,
      t.cwd,
      undefined,
      signal,
      (partial) => {
        if (partial.details?.results[0]) {
          allResults[index] = partial.details.results[0];
          emitParallelUpdate();
        }
      },
      makeDetails('parallel')
    );
    allResults[index] = result;
    emitParallelUpdate();
    return result;
  });

  const successCount = results.filter((r) => !isFailedResult(r)).length;
  const summaries = results.map((r) => {
    const output = truncateParallelOutput(getResultOutput(r));
    const status = isFailedResult(r)
      ? `failed${r.stopReason && r.stopReason !== 'end' ? ` (${r.stopReason})` : ''}`
      : 'completed';
    return `### [${r.agent}] ${status}\n\n${output}`;
  });
  return {
    content: [
      {
        type: 'text',
        text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join('\n\n---\n\n')}`,
      },
    ],
    details: makeDetails('parallel')(results),
  };
}

async function runSingle(
  ctx: ExtensionContext,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  makeDetails: DetailsFactory
): Promise<AgentResult> {
  const result = await runSingleAgent(
    ctx.cwd,
    agents,
    agentName,
    task,
    cwd,
    undefined,
    signal,
    onUpdate,
    makeDetails('single')
  );
  if (isFailedResult(result)) {
    const errorMsg = getResultOutput(result);
    return {
      content: [{ type: 'text', text: `Agent ${result.stopReason || 'failed'}: ${errorMsg}` }],
      details: makeDetails('single')([result]),
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: getFinalOutput(result.messages) || '(no output)' }],
    details: makeDetails('single')([result]),
  };
}
