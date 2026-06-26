// ABOUTME: Tool orchestration for the `agent` tool — mode dispatch, confirmation, and result assembly.
// ABOUTME: Owns single/parallel/chain execution flows so `index.ts` stays a thin extension entrypoint.

import type { Static } from '@earendil-works/pi-ai';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  type AgentConfig,
  type AgentScope,
  discoverAgents,
  getBuiltinAgentsDir,
} from './agents.ts';
import { runChainWorkflow, synthesizeFailure } from './chain.ts';
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS } from './constants.ts';
import { validateCompletionOutput } from './completion-check.ts';
import { prepareAgentContext } from './context.ts';
import { mapWithConcurrencyLimit, type OnUpdateCallback, runSingleAgent } from './execution.ts';
import {
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  truncateParallelOutput,
} from './output.ts';
import type { SubagentParams } from './schema.ts';
import { assertAgentDelegationAllowed } from './security.ts';
import type { IsolationMode, SingleResult, SubagentDetails } from './types.ts';
import {
  type AgentWorktree,
  createAgentWorktree,
  getGitRoot,
  getWorktreeDirtyStatus,
  removeAgentWorktree,
} from './worktree.ts';

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

  try {
    assertAgentDelegationAllowed(process.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: message }],
      details: {
        mode: 'single',
        agentScope,
        projectAgentsDir: null,
        builtinAgentsDir: getBuiltinAgentsDir(),
        results: [],
      },
      isError: true,
    };
  }

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

    const elevatedAgentsRequested = Array.from(requestedAgentNames)
      .map((name) => agents.find((a) => a.name === name))
      .filter((a): a is AgentConfig => a?.source === 'project' || a?.source === 'package');

    if (elevatedAgentsRequested.length > 0) {
      const entries = elevatedAgentsRequested.map((a) => `${a.name} [${a.source}] (${a.filePath})`);
      const projectDir = discovery.projectAgentsDir ?? '(unknown)';
      const ok = await ctx.ui.confirm(
        'Run project-trust agents?',
        `Agents:\n${entries.join('\n')}\nProject dir: ${projectDir}\n\nProject and package agents are repo-controlled. Only continue for trusted repositories.`
      );
      if (!ok)
        return {
          content: [{ type: 'text', text: 'Canceled: project-trust agents not approved.' }],
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
      params.isolation,
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
  const chainDetails = makeDetails('chain');
  return runChainWorkflow({
    chain,
    signal,
    onUpdate,
    makeDetails: chainDetails,
    runStep: (req) =>
      runStepWithContext(
        ctx,
        agents,
        req.agent,
        req.task,
        req.cwd,
        req.isolation,
        req.taskIndex,
        req.step,
        req.signal,
        req.onUpdate,
        chainDetails
      ),
  });
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
    const result = await runStepWithContext(
      ctx,
      agents,
      t.agent,
      t.task,
      t.cwd,
      t.isolation,
      index,
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
  isolation: IsolationMode | undefined,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  makeDetails: DetailsFactory
): Promise<AgentResult> {
  const result = await runStepWithContext(
    ctx,
    agents,
    agentName,
    task,
    cwd,
    isolation,
    0,
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

function resolveIsolation(
  agent: AgentConfig,
  taskIsolation: IsolationMode | undefined
): IsolationMode {
  return taskIsolation ?? agent.isolation ?? 'none';
}

async function runStepWithContext(
  ctx: ExtensionContext,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  taskIsolation: IsolationMode | undefined,
  taskIndex: number,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    return runSingleAgent(
      ctx.cwd,
      agents,
      agentName,
      task,
      cwd,
      step,
      signal,
      onUpdate,
      makeDetails
    );
  }

  let agentContext;
  try {
    agentContext = prepareAgentContext(agent, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return synthesizeFailure(agentName, agent, task, step, 'context_error', message);
  }

  const isolation = resolveIsolation(agent, taskIsolation);
  let worktree: AgentWorktree | undefined;
  let effectiveCwd = cwd;
  if (isolation === 'worktree') {
    const repoRoot = getGitRoot(cwd ?? ctx.cwd);
    if (!repoRoot) {
      await agentContext.cleanup();
      return synthesizeFailure(
        agentName,
        agent,
        task,
        step,
        'isolation_error',
        'Worktree isolation requires a git repository.'
      );
    }
    try {
      worktree = createAgentWorktree(repoRoot, agentName, taskIndex);
      effectiveCwd = worktree.path;
    } catch (err) {
      await agentContext.cleanup();
      const message = err instanceof Error ? err.message : String(err);
      return synthesizeFailure(agentName, agent, task, step, 'isolation_error', message);
    }
  }

  try {
    const result = await runSingleAgent(
      ctx.cwd,
      agents,
      agentName,
      task,
      effectiveCwd,
      step,
      signal,
      onUpdate,
      makeDetails,
      { sessionFile: agentContext.sessionFile }
    );
    if (worktree) {
      finalizeWorktree(worktree, result);
    }
    enforceCompletionCheck(agent, result);
    return result;
  } catch (err) {
    if (worktree) {
      // Best-effort: mark the worktree path on a synthetic result is not possible here
      // because we are about to rethrow; attempt status check + safe cleanup so we don't
      // leak directories on abort. Dirty or unknown-status worktrees are retained.
      const status = getWorktreeDirtyStatus(worktree.path);
      if (status.ok && status.output.trim().length === 0) {
        removeAgentWorktree(worktree);
      }
    }
    throw err;
  } finally {
    await agentContext.cleanup();
  }
}

function finalizeWorktree(worktree: AgentWorktree, result: SingleResult): void {
  const status = getWorktreeDirtyStatus(worktree.path);
  if (!status.ok) {
    // Treat unknown status as dirty so we never delete data we can't verify.
    result.worktreePath = worktree.path;
    result.worktreeDirty = true;
    result.stderr += result.stderr ? '\n' : '';
    result.stderr += `Worktree status check failed: ${status.error ?? 'unknown'}. Retaining ${worktree.path}.`;
    return;
  }
  if (status.output.trim().length > 0) {
    result.worktreePath = worktree.path;
    result.worktreeDirty = true;
    return;
  }
  const removal = removeAgentWorktree(worktree);
  if (!removal.removed) {
    result.worktreePath = worktree.path;
    result.worktreeDirty = false;
    result.stderr += result.stderr ? '\n' : '';
    result.stderr += `Worktree cleanup failed: ${removal.error ?? 'unknown'}. Retaining ${worktree.path}.`;
  }
}

function enforceCompletionCheck(agent: AgentConfig, result: SingleResult): void {
  if (isFailedResult(result)) return;
  const finalOutput = getFinalOutput(result.messages);
  const validation = validateCompletionOutput(agent, finalOutput);
  if (validation.ok) return;
  const missing = validation.missing.join(', ');
  result.stopReason = 'completion_check';
  result.errorMessage = `Completion check failed: missing ${missing}`;
  if (result.exitCode === 0) {
    result.exitCode = 1;
  }
}
