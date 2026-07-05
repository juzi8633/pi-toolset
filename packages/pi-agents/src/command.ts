// ABOUTME: Registers /agent and /agent:<name> slash commands that actively invoke discovered agents.
// ABOUTME: Reuses executeAgentTool for orchestration; foreground-only, with an injected executor test seam.

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { type AgentConfig, discoverAgents } from './agents.ts';
import type { BackgroundManager } from './background.ts';
import { setDiscoveredSkillsFromOptions } from './skills.ts';
import { executeAgentTool } from './tool.ts';
import type { SubagentDetails } from './types.ts';

type AgentResult = AgentToolResult<SubagentDetails> & { isError?: boolean };
type AgentExecutor = typeof executeAgentTool;
type AgentWidgetUpdater = (partial?: AgentResult) => void;

export interface RegisterAgentCommandOptions {
  backgroundManager?: BackgroundManager;
  /** Test seam: override the agent executor. Defaults to executeAgentTool. */
  execute?: AgentExecutor;
  /** Directory used to discover per-agent /agent:<name> commands at registration time. */
  cwd?: string;
}

const LIST_KEYWORD = 'list';
const AGENT_WIDGET_KEY = 'pi-agent-command';
const AGENT_COMMAND_DESCRIPTION =
  'Invoke a discovered subagent: /agent list | /agent <name> <task...>';

export function registerAgentCommand(
  pi: ExtensionAPI,
  options: RegisterAgentCommandOptions = {}
): void {
  const execute = options.execute ?? executeAgentTool;
  const registrationCwd = options.cwd ?? process.cwd();

  pi.registerCommand('agent', {
    description: AGENT_COMMAND_DESCRIPTION,
    getArgumentCompletions: (prefix) => agentArgumentCompletions(registrationCwd, prefix),
    handler: async (args, ctx) => {
      await runAgentFallbackCommand(args, ctx, execute, options);
    },
  });

  for (const agent of discoverAgents(registrationCwd, 'both').agents) {
    const commandName = `agent:${agent.name}`;
    pi.registerCommand(commandName, {
      description: agentDescription(agent),
      handler: async (args, ctx) => {
        await runNamedAgentCommand(agent.name, args, ctx, execute, options);
      },
    });
  }
}

async function runAgentFallbackCommand(
  args: string,
  ctx: ExtensionCommandContext,
  execute: AgentExecutor,
  options: RegisterAgentCommandOptions
): Promise<void> {
  await ctx.waitForIdle();

  const trimmed = args.trim();
  if (trimmed.length === 0) {
    ctx.ui.notify(usageText(ctx.cwd), 'warning');
    return;
  }

  const spaceIndex = trimmed.indexOf(' ');
  const firstToken = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const rest = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();

  if (firstToken.toLowerCase() === LIST_KEYWORD) {
    ctx.ui.notify(renderAgentList(discoverAgents(ctx.cwd, 'both').agents), 'info');
    return;
  }

  if (rest.length === 0) {
    ctx.ui.notify(`Missing task for agent "${firstToken}".\n${usageText(ctx.cwd)}`, 'warning');
    return;
  }

  await invokeAgent(firstToken, rest, ctx, execute, options);
}

async function runNamedAgentCommand(
  agentName: string,
  args: string,
  ctx: ExtensionCommandContext,
  execute: AgentExecutor,
  options: RegisterAgentCommandOptions
): Promise<void> {
  await ctx.waitForIdle();

  const task = args.trim();
  if (task.length === 0) {
    ctx.ui.notify(`Missing task. Usage: /agent:${agentName} <task...>`, 'warning');
    return;
  }

  await invokeAgent(agentName, task, ctx, execute, options);
}

async function invokeAgent(
  agentName: string,
  task: string,
  ctx: ExtensionCommandContext,
  execute: AgentExecutor,
  options: RegisterAgentCommandOptions
): Promise<void> {
  const agents = discoverAgents(ctx.cwd, 'both').agents;
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    ctx.ui.notify(`Unknown agent: "${agentName}".\n${availableAgentsText(agents)}`, 'error');
    return;
  }

  // Slash commands bypass before_agent_start, so refresh the skill cache from the
  // host's system prompt options before executeAgentTool resolves agent.skills.
  setDiscoveredSkillsFromOptions(ctx.getSystemPromptOptions());

  const updateWidget = createAgentWidgetUpdater(ctx, agentName, task);
  updateWidget();

  let result: AgentResult;
  try {
    result = await execute({ agent: agentName, task }, ctx.signal, updateWidget, ctx, {
      backgroundManager: options.backgroundManager,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Agent "${agentName}" failed: ${message}`, 'error');
    return;
  } finally {
    ctx.ui.setWidget(AGENT_WIDGET_KEY, undefined);
  }

  const text = extractResultText(result);
  if (result.isError) {
    ctx.ui.notify(text || `Agent "${agentName}" failed.`, 'error');
    return;
  }
  ctx.ui.notify(text || `Agent "${agentName}" completed.`, 'info');
}

function createAgentWidgetUpdater(
  ctx: ExtensionCommandContext,
  agentName: string,
  task: string
): AgentWidgetUpdater {
  return (partial?: AgentResult) => {
    const result = partial?.details?.results[0];
    const lines = [
      `Agent: ${agentName}`,
      `Task: ${truncateWidgetText(task, 120)}`,
      `Status: ${partial ? 'running...' : 'starting...'}`,
      `Turns: ${result?.usage.turns ?? 0}`,
    ];
    const latest = partial ? truncateWidgetText(extractResultText(partial), 160) : '';
    if (latest) lines.push(`Latest: ${latest}`);
    ctx.ui.setWidget(AGENT_WIDGET_KEY, lines);
  };
}

function truncateWidgetText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function agentArgumentCompletions(cwd: string, prefix: string): AutocompleteItem[] {
  const items: AutocompleteItem[] = [
    { value: LIST_KEYWORD, label: LIST_KEYWORD, description: 'List all discovered agents' },
  ];
  for (const a of discoverAgents(cwd, 'both').agents) {
    items.push({ value: a.name, label: a.name, description: a.description });
  }
  const lower = prefix.toLowerCase();
  return lower.length === 0 ? items : items.filter((i) => i.value.toLowerCase().startsWith(lower));
}

function agentDescription(agent: AgentConfig): string {
  return `Invoke the "${agent.name}" agent. ${agent.description}`;
}

function renderAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return 'No agents discovered.';
  const lines = agents.map((a) => `- ${a.name} [${a.source}]: ${a.description}`);
  return `Discovered agents (${agents.length}):\n${lines.join('\n')}`;
}

function availableAgentsText(agents: AgentConfig[]): string {
  if (agents.length === 0) return 'Available agents: none';
  return `Available agents: ${agents.map((a) => a.name).join(', ')}`;
}

function usageText(cwd: string): string {
  const agents = discoverAgents(cwd, 'both').agents;
  const available = agents.length === 0 ? 'none' : agents.map((a) => a.name).join(', ');
  return [
    'Usage:',
    '  /agent list              List discovered agents',
    '  /agent <name> <task...>  Invoke <name> with the remaining text as task',
    '  /agent:<name> <task...>  Shorthand for a specific agent',
    `Available agents: ${available}`,
  ].join('\n');
}

function extractResultText(result: AgentResult): string {
  const first = result.content[0];
  if (first && first.type === 'text') return first.text;
  return '';
}
