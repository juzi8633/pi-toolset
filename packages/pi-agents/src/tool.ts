// ABOUTME: Tool orchestration for the `agent` tool — mode dispatch and result assembly.
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
  type Runtime,
  discoverAgents,
  getBuiltinAgentsDir,
} from './agents.ts';
import type { BackgroundManager } from './background.ts';
import { runChainWorkflow, synthesizeFailure } from './chain.ts';
import { GROK_RUNTIME, MAX_CONCURRENCY, MAX_PARALLEL_TASKS } from './constants.ts';
import { validateCompletionOutput } from './completion-check.ts';
import { prepareAgentContext } from './context.ts';
import { listAvailableSkillNames, resolveSkillNames } from './skills.ts';
import { mapWithConcurrencyLimit, type OnUpdateCallback, runSingleAgent } from './execution.ts';
import {
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  truncateParallelOutput,
} from './output.ts';
import type { SubagentParams } from './schema.ts';
import { assertAgentDelegationAllowed } from './security.ts';
import type { IsolationMode, SingleResult, SubagentDetails, ChainOutputEntry } from './types.ts';
import {
  type AgentWorktree,
  createAgentWorktree,
  getGitRoot,
  getWorktreeDiffSummary,
  getWorktreeDirtyStatus,
  removeAgentWorktree,
  runWorktreeSetupHook,
} from './worktree.ts';

type Params = Static<typeof SubagentParams>;
type Mode = 'single' | 'parallel' | 'chain';
type AgentResult = AgentToolResult<SubagentDetails> & { isError?: boolean };
type DetailsFactory = (mode: Mode) => (results: SingleResult[]) => SubagentDetails;

export interface ExecuteAgentToolOptions {
  backgroundManager?: BackgroundManager;
  /** Test seam: override the post-validation workflow runner. */
  runWorkflow?: WorkflowRunner;
}

type WorkflowRunner = (
  params: Params,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  ctx: ExtensionContext,
  agents: AgentConfig[],
  makeDetails: DetailsFactory
) => Promise<AgentResult>;

export async function executeAgentTool(
  params: Params,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  ctx: ExtensionContext,
  options: ExecuteAgentToolOptions = {}
): Promise<AgentResult> {
  const agentScope: AgentScope = params.agentScope ?? 'both';

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

  if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) {
    return {
      content: [
        {
          type: 'text',
          text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
        },
      ],
      details: makeDetails('parallel')([]),
      isError: true,
    };
  }

  if (params.chain && params.chain.length > 0) {
    return await runWithBackgroundOption(
      params,
      signal,
      onUpdate,
      ctx,
      agents,
      makeDetails,
      'chain',
      options,
      (workflowSignal, workflowOnUpdate) =>
        runChain(
          ctx,
          agents,
          params.chain!,
          workflowSignal,
          workflowOnUpdate,
          makeDetails,
          params.model,
          params.thinking,
          params.runtime
        )
    );
  }
  if (params.tasks && params.tasks.length > 0) {
    return await runWithBackgroundOption(
      params,
      signal,
      onUpdate,
      ctx,
      agents,
      makeDetails,
      'parallel',
      options,
      (workflowSignal, workflowOnUpdate) =>
        runParallel(
          ctx,
          agents,
          params.tasks!,
          workflowSignal,
          workflowOnUpdate,
          makeDetails,
          params.model,
          params.thinking,
          params.runtime
        )
    );
  }
  if (params.agent && params.task) {
    return await runWithBackgroundOption(
      params,
      signal,
      onUpdate,
      ctx,
      agents,
      makeDetails,
      'single',
      options,
      (workflowSignal, workflowOnUpdate) =>
        runSingle(
          ctx,
          agents,
          params.agent!,
          params.task!,
          params.cwd,
          params.isolation,
          workflowSignal,
          workflowOnUpdate,
          makeDetails,
          params.model,
          params.thinking,
          params.runtime
        )
    );
  }

  const available = agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none';
  return {
    content: [{ type: 'text', text: `Invalid parameters. Available agents: ${available}` }],
    details: makeDetails('single')([]),
  };
}

async function runWithBackgroundOption(
  params: Params,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  ctx: ExtensionContext,
  agents: AgentConfig[],
  makeDetails: DetailsFactory,
  mode: Mode,
  options: ExecuteAgentToolOptions,
  runWorkflow: (
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined
  ) => Promise<AgentResult>
): Promise<AgentResult> {
  if (!params.runInBackground) {
    if (options.runWorkflow)
      return options.runWorkflow(params, signal, onUpdate, ctx, agents, makeDetails);
    return runWorkflow(signal, onUpdate);
  }

  if (ctx.mode === 'json' || ctx.mode === 'print') {
    return {
      content: [
        {
          type: 'text',
          text: `Background agents require a long-lived TUI or RPC session; current mode "${ctx.mode}" exits after the tool returns. Re-run without runInBackground.`,
        },
      ],
      details: makeDetails(mode)([]),
      isError: true,
    };
  }

  const manager = options.backgroundManager;
  if (!manager) {
    return {
      content: [
        {
          type: 'text',
          text: 'Background execution is not available in this session.',
        },
      ],
      details: makeDetails(mode)([]),
      isError: true,
    };
  }

  const description = describeWorkflow(params, mode);
  const taskPreview = buildTaskPreview(params, mode);
  const projectAgentsDir = discoverAgents(ctx.cwd, params.agentScope ?? 'user').projectAgentsDir;

  return manager.launch({
    mode,
    agentScope: params.agentScope ?? 'user',
    description,
    taskPreview,
    projectAgentsDir,
    run: (bgSignal) => {
      if (options.runWorkflow) {
        const copy = stripRunInBackground(params);
        return options.runWorkflow(copy, bgSignal, undefined, ctx, agents, makeDetails);
      }
      return runWorkflow(bgSignal, undefined);
    },
  });
}

function stripRunInBackground(params: Params): Params {
  const { runInBackground: _ignore, ...rest } = params;
  return rest as Params;
}

function describeWorkflow(params: Params, mode: Mode): string {
  if (mode === 'chain') return `chain (${params.chain?.length ?? 0} steps)`;
  if (mode === 'parallel') return `parallel (${params.tasks?.length ?? 0} tasks)`;
  return `${params.agent ?? 'agent'}: ${truncatePreview(params.task ?? '', 80)}`;
}

function buildTaskPreview(params: Params, mode: Mode): string {
  if (mode === 'chain') {
    const first = params.chain?.[0];
    if (!first) return '';
    const task = 'task' in first ? first.task : first.parallel.task;
    return truncatePreview(task, 120);
  }
  if (mode === 'parallel') {
    const first = params.tasks?.[0];
    return first ? truncatePreview(first.task, 120) : '';
  }
  return truncatePreview(params.task ?? '', 120);
}

function truncatePreview(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

async function runChain(
  ctx: ExtensionContext,
  agents: AgentConfig[],
  chain: NonNullable<Params['chain']>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  makeDetails: DetailsFactory,
  modelOverride?: string,
  thinkingOverride?: string,
  runtimeOverride?: Runtime
): Promise<AgentResult> {
  const chainDetails = (results: SingleResult[], outputs?: Record<string, ChainOutputEntry>) => ({
    ...makeDetails('chain')(results),
    ...(outputs && Object.keys(outputs).length > 0 ? { outputs } : {}),
  });
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
        (results) => chainDetails(results),
        {
          skipCompletionCheck: req.skipCompletionCheck,
          modelOverride,
          thinkingOverride,
          runtimeOverride,
        }
      ),
  });
}

async function runParallel(
  ctx: ExtensionContext,
  agents: AgentConfig[],
  tasks: NonNullable<Params['tasks']>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  makeDetails: DetailsFactory,
  modelOverride?: string,
  thinkingOverride?: string,
  runtimeOverride?: Runtime
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
      isError: true,
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
      makeDetails('parallel'),
      { modelOverride, thinkingOverride, runtimeOverride }
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
  makeDetails: DetailsFactory,
  modelOverride?: string,
  thinkingOverride?: string,
  runtimeOverride?: Runtime
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
    makeDetails('single'),
    { modelOverride, thinkingOverride, runtimeOverride }
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
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  options: {
    skipCompletionCheck?: boolean;
    modelOverride?: string;
    thinkingOverride?: string;
    runtimeOverride?: Runtime;
  } = {}
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
      makeDetails,
      {
        modelOverride: options.modelOverride,
        thinkingOverride: options.thinkingOverride,
        runtimeOverride: options.runtimeOverride,
      }
    );
  }

  const effectiveRuntime: Runtime | undefined = options.runtimeOverride ?? agent.runtime;

  let resolvedSkillPaths: string[] | undefined;
  if (effectiveRuntime === GROK_RUNTIME) {
    if (agent.skills && agent.skills.length > 0) {
      ctx.ui.notify(
        `Agent "${agentName}" uses runtime: grok; skills are ignored (not transferable to Grok).`,
        'warning'
      );
    }
  } else if (agent.skills && agent.skills.length > 0) {
    const { resolved, missing } = resolveSkillNames(agent.skills);
    if (missing.length > 0) {
      const available = listAvailableSkillNames();
      const MAX_LIST = 20;
      const availableText =
        available.length === 0
          ? 'none'
          : available.length > MAX_LIST
            ? `${available.slice(0, MAX_LIST).join(', ')}, +${available.length - MAX_LIST} more`
            : available.join(', ');
      return synthesizeFailure(
        agentName,
        agent,
        task,
        step,
        'skill_error',
        `Cannot resolve skill name(s): ${missing.join(', ')}. Available skills: ${availableText}.`
      );
    }
    resolvedSkillPaths = resolved;
  }

  let agentContext;
  try {
    if (effectiveRuntime === GROK_RUNTIME) {
      if (agent.defaultContext === 'fork') {
        ctx.ui.notify(
          `Agent "${agentName}" uses runtime: grok; defaultContext: fork is ignored (runs as fresh).`,
          'warning'
        );
      }
      agentContext = {
        mode: 'fresh' as const,
        sessionFile: undefined,
        cleanup: async () => {},
      };
    } else {
      agentContext = prepareAgentContext(agent, ctx);
    }
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

    if (agent.worktreeSetupHook) {
      const failure = runHookOrSynthesizeFailure(agentName, agent, task, step, worktree);
      if (failure) {
        await agentContext.cleanup();
        return failure;
      }
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
      {
        sessionFile: agentContext.sessionFile,
        resolvedSkillPaths,
        modelOverride: options.modelOverride,
        thinkingOverride: options.thinkingOverride,
        runtimeOverride: options.runtimeOverride,
      }
    );
    if (worktree) {
      finalizeWorktree(worktree, result);
    }
    if (!options.skipCompletionCheck) {
      enforceCompletionCheck(agent, result);
    }
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

export function runHookOrSynthesizeFailure(
  agentName: string,
  agent: AgentConfig,
  task: string,
  step: number | undefined,
  worktree: AgentWorktree
): SingleResult | undefined {
  const hook = agent.worktreeSetupHook;
  if (!hook) return undefined;
  const hookResult = runWorktreeSetupHook(worktree.path, hook);
  if (hookResult.ok) return undefined;
  const errSummary = hookResult.error
    ? `error: ${hookResult.error}`
    : `exit ${hookResult.exitCode}`;
  const tail = (hookResult.stderr || hookResult.stdout).trim();
  const detail = tail ? `\n${tail.slice(-400)}` : '';
  const failure = synthesizeFailure(
    agentName,
    agent,
    task,
    step,
    'worktree_setup_error',
    `worktreeSetupHook "${hook}" failed (${errSummary})${detail}`
  );
  failure.worktreeSetupError = failure.errorMessage;
  const cleanupStatus = getWorktreeDirtyStatus(worktree.path);
  if (cleanupStatus.ok && cleanupStatus.output.trim().length === 0) {
    removeAgentWorktree(worktree);
  } else {
    failure.worktreePath = worktree.path;
    failure.worktreeDirty = true;
  }
  return failure;
}

export function finalizeWorktree(worktree: AgentWorktree, result: SingleResult): void {
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
    const diff = getWorktreeDiffSummary(worktree.path);
    if (diff.ok) {
      if (diff.stat) result.worktreeDiffStat = diff.stat;
      if (diff.changedFiles) result.worktreeChangedFiles = diff.changedFiles;
    } else {
      result.stderr += result.stderr ? '\n' : '';
      result.stderr += `Worktree diff summary failed: ${diff.error ?? 'unknown'}.`;
    }
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
