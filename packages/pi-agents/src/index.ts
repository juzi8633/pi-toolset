// ABOUTME: Subagent tool entrypoint — registers the `agent` tool and the `before_agent_start` hook.
// ABOUTME: Delegates discovery, orchestration, and rendering to focused modules.

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Static } from '@earendil-works/pi-ai';
import { discoverAgents } from './agents.ts';
import {
  BACKGROUND_MESSAGE_TYPE,
  createBackgroundManager,
  renderBackgroundMessage,
} from './background.ts';
import { renderAgentCatalogue, shouldInjectAgentCatalogue } from './catalogue.ts';
import { registerAgentCommand } from './command.ts';
import {
  type AgentRenderState,
  renderCall,
  renderResult,
  stopAllSpinners,
  stopSpinner,
} from './render.ts';
import { SubagentParams } from './schema.ts';
import { setDiscoveredSkillsFromOptions } from './skills.ts';
import { executeAgentTool } from './tool.ts';
import type { SubagentDetails } from './types.ts';

type RawArgs = Record<string, unknown> & { run_in_background?: unknown };

export function normalizeAgentArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;
  const obj = args as RawArgs;
  if (
    typeof obj.run_in_background === 'boolean' &&
    (obj as { runInBackground?: unknown }).runInBackground === undefined
  ) {
    const { run_in_background, ...rest } = obj;
    return { ...rest, runInBackground: run_in_background };
  }
  return args;
}

/**
 * Register lifecycle hooks so the shared spinner ticker cannot leak past tool or
 * session teardown. Event names match Pi 0.80.1 ExtensionAPI (including /tree).
 * Handlers are additive with other extension listeners on the same event.
 */
export function registerSpinnerLifecycle(pi: ExtensionAPI): void {
  pi.on('tool_execution_end', (event) => {
    if (event.toolName === 'agent') stopSpinner(event.toolCallId);
  });
  pi.on('agent_end', stopAllSpinners);
  pi.on('session_before_compact', stopAllSpinners);
  pi.on('session_before_switch', stopAllSpinners);
  pi.on('session_before_tree', stopAllSpinners);
  pi.on('session_tree', stopAllSpinners);
  pi.on('session_start', stopAllSpinners);
  pi.on('session_shutdown', stopAllSpinners);
}

export default function (pi: ExtensionAPI) {
  const backgroundManager = createBackgroundManager(pi);
  registerSpinnerLifecycle(pi);

  pi.registerMessageRenderer(BACKGROUND_MESSAGE_TYPE, renderBackgroundMessage);

  pi.on('session_shutdown', () => {
    backgroundManager.cancelAll('session_shutdown');
  });

  pi.on('before_agent_start', async (event, ctx) => {
    setDiscoveredSkillsFromOptions(event.systemPromptOptions);
    const discovery = discoverAgents(ctx.cwd, 'both');
    const safeAgents = discovery.agents.filter((a) => a.source !== 'package');
    if (!shouldInjectAgentCatalogue(process.env, safeAgents)) return;
    const block = renderAgentCatalogue(safeAgents);
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  pi.registerTool<typeof SubagentParams, SubagentDetails, AgentRenderState>({
    name: 'agent',
    label: 'Agent',
    description: `Launch a new agent to handle complex, multi-step tasks. Available agent types are listed in the system prompt.
Provide exactly one execution mode:
- \`agent\` + \`task\`: run a single agent.
- \`tasks\`: run multiple {agent, task} items in parallel.
- \`chain\`: run sequential steps with output passing between them, optionally fanning out one step's structured output across parallel workers.
## When to use
Use when the task matches an agent type, for parallel independent work, or when answering requires reading several files - delegate and keep the conclusion, not the file dumps. For a single-fact lookup, search directly. Once delegated, don't redo the work yourself - wait for the result.
- The agent's final message is returned as the tool result (not shown to the user) - relay what matters.`,
    promptGuidelines: [
      '!! Use the `explore` agent when you need to search across multiple files or do broad code analysis exploration.',
    ],
    parameters: SubagentParams,
    prepareArguments: (args) => normalizeAgentArgs(args) as Static<typeof SubagentParams>,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return executeAgentTool(params, signal, onUpdate, ctx, { backgroundManager });
    },
    renderCall,
    renderResult,
  });

  registerAgentCommand(pi, { backgroundManager });
}
