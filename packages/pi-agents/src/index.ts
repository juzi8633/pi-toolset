// ABOUTME: Subagent tool entrypoint — registers the `agent` tool and the `before_agent_start` hook.
// ABOUTME: Delegates discovery, orchestration, and rendering to focused modules.

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { discoverAgents } from './agents.ts';
import { renderCall, renderResult } from './render.ts';
import { SubagentParams } from './schema.ts';
import { executeAgentTool } from './tool.ts';

export default function (pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event, ctx) => {
    const discovery = discoverAgents(ctx.cwd, 'both');
    const agents = discovery.agents;
    if (agents.length === 0) return;
    const lines = agents.map((a) => `- ${a.name}: ${a.description}`).join('\n');
    const block = `Available agent types for the \`agent\` tool:\n${lines}`;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  pi.registerTool({
    name: 'agent',
    label: 'Agent',
    description: `Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.
When using the Agent tool, specify a \`agent\` parameter to select which agent type to use. If omitted, the general-purpose agent is used.
## When to use
Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.
- The agent's final message is returned to you as the tool result; it is not shown to the user — relay what matters.`,
    parameters: SubagentParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return executeAgentTool(params, signal, onUpdate, ctx);
    },
    renderCall,
    renderResult,
  });
}
