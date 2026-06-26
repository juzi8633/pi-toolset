// ABOUTME: Chain execution engine — orchestrates sequential subagent steps with templated handoff.
// ABOUTME: Exposes runChainWorkflow with injectable runStep so the loop is unit-testable without spawning pi.

import type { Static } from '@earendil-works/pi-ai';
import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent';
import type { AgentConfig, AgentSource } from './agents.ts';
import type { OnUpdateCallback } from './execution.ts';
import { getFinalOutput, getResultOutput, isFailedResult } from './output.ts';
import type { ChainItem } from './schema.ts';
import { renderTaskTemplate } from './template.ts';
import type { IsolationMode, SingleResult, SubagentDetails } from './types.ts';

export type ChainItemInput = Static<typeof ChainItem>;

export type DetailsFactory = (results: SingleResult[]) => SubagentDetails;

export interface ChainStepRequest {
  agent: string;
  task: string;
  cwd: string | undefined;
  isolation: IsolationMode | undefined;
  taskIndex: number;
  step: number;
  signal: AbortSignal | undefined;
  onUpdate: OnUpdateCallback | undefined;
}

export type ChainRunStep = (req: ChainStepRequest) => Promise<SingleResult>;

export interface RunChainWorkflowOptions {
  chain: ChainItemInput[];
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined;
  makeDetails: DetailsFactory;
  runStep: ChainRunStep;
}

export type ChainResult = AgentToolResult<SubagentDetails> & { isError?: boolean };

export function synthesizeFailure(
  agentName: string,
  agent: AgentConfig | undefined,
  task: string,
  step: number | undefined,
  stopReason: string,
  message: string
): SingleResult {
  return {
    agent: agentName,
    agentSource: (agent?.source ?? 'unknown') as AgentSource | 'unknown',
    task,
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
    stopReason,
    errorMessage: message,
    step,
  };
}

export async function runChainWorkflow(options: RunChainWorkflowOptions): Promise<ChainResult> {
  const { chain, signal, onUpdate, makeDetails, runStep } = options;
  const results: SingleResult[] = [];
  let previousOutput = '';
  const outputs = new Map<string, string>();

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const rendered = renderTaskTemplate(step.task, { previous: previousOutput, outputs });
    if (!rendered.ok) {
      const failure = synthesizeFailure(
        step.agent,
        undefined,
        step.task,
        i + 1,
        'template_error',
        `Unknown chain output: ${rendered.unknown}`
      );
      results.push(failure);
      return {
        content: [
          {
            type: 'text',
            text: `Chain stopped at step ${i + 1} (${step.agent}): Unknown chain output: ${rendered.unknown}`,
          },
        ],
        details: makeDetails(results),
        isError: true,
      };
    }
    const taskWithContext = rendered.text;

    const chainUpdate: OnUpdateCallback | undefined = onUpdate
      ? (partial) => {
          const currentResult = partial.details?.results[0];
          if (currentResult) {
            const allResults = [...results, currentResult];
            onUpdate({
              content: partial.content,
              details: makeDetails(allResults),
            });
          }
        }
      : undefined;

    const result = await runStep({
      agent: step.agent,
      task: taskWithContext,
      cwd: step.cwd,
      isolation: step.isolation,
      taskIndex: i,
      step: i + 1,
      signal,
      onUpdate: chainUpdate,
    });
    results.push(result);

    if (isFailedResult(result)) {
      const errorMsg = getResultOutput(result);
      return {
        content: [
          { type: 'text', text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` },
        ],
        details: makeDetails(results),
        isError: true,
      };
    }
    previousOutput = getFinalOutput(result.messages);
    if (step.name) outputs.set(step.name, previousOutput);
  }

  return {
    content: [
      {
        type: 'text',
        text: getFinalOutput(results[results.length - 1].messages) || '(no output)',
      },
    ],
    details: makeDetails(results),
  };
}
