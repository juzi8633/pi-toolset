// ABOUTME: Registers /agent (list only) and /agent:<name> (invoke) slash commands for discovered agents.
// ABOUTME: Reuses executeAgentTool for orchestration; foreground-only, with an injected executor test seam.

import {
  DynamicBorder,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  type AutocompleteItem,
  Container,
  Loader,
  Spacer,
  Text,
  type TUI,
} from '@earendil-works/pi-tui';
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
  'List discovered subagents (/agent list); invoke a specific one via /agent:<name> <task...>';

export function registerAgentCommand(
  pi: ExtensionAPI,
  options: RegisterAgentCommandOptions = {}
): void {
  const execute = options.execute ?? executeAgentTool;
  const registrationCwd = options.cwd ?? process.cwd();

  pi.registerCommand('agent', {
    description: AGENT_COMMAND_DESCRIPTION,
    getArgumentCompletions: (prefix) => agentArgumentCompletions(prefix),
    handler: async (args, ctx) => {
      await runAgentFallbackCommand(args, ctx);
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

async function runAgentFallbackCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle();

  const trimmed = args.trim();
  if (trimmed.toLowerCase() === LIST_KEYWORD) {
    ctx.ui.notify(renderAgentList(discoverAgents(ctx.cwd, 'both').agents), 'info');
    return;
  }

  ctx.ui.notify(usageText(ctx.cwd), 'warning');
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
  let widget: AgentStatusWidget | undefined;
  ctx.ui.setWidget(AGENT_WIDGET_KEY, (tui: TUI, widgetTheme: Theme) => {
    widget = new AgentStatusWidget(tui, widgetTheme, agentName, task);
    return widget;
  });

  return (partial?: AgentResult) => {
    widget?.update(partial);
  };
}

class AgentStatusWidget extends Container {
  private readonly content = new Container();
  private readonly loader: Loader;
  private latest = '';
  private status = 'starting...';
  private turns = 0;

  constructor(
    private readonly tui: TUI,
    private readonly widgetTheme: Theme,
    private readonly agentName: string,
    private readonly task: string
  ) {
    super();
    const borderColor = (text: string) => this.widgetTheme.fg('bashMode', text);
    this.loader = new Loader(
      tui,
      (spinner) => this.widgetTheme.fg('bashMode', spinner),
      (text) => this.widgetTheme.fg('muted', text),
      'Starting subagent...'
    );

    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder(borderColor));
    this.addChild(this.content);
    this.addChild(new DynamicBorder(borderColor));
    this.rebuild();
  }

  update(partial?: AgentResult): void {
    const result = partial?.details?.results[0];
    this.status = partial ? 'running...' : 'starting...';
    this.turns = result?.usage.turns ?? 0;
    this.latest = partial ? truncateWidgetText(extractResultText(partial), 160) : '';
    this.loader.setMessage(partial ? 'Running subagent...' : 'Starting subagent...');
    this.rebuild();
    this.tui.requestRender();
  }

  dispose(): void {
    this.loader.stop();
  }

  private rebuild(): void {
    const color = (text: string) => this.widgetTheme.fg('bashMode', text);
    const muted = (text: string) => this.widgetTheme.fg('muted', text);
    this.content.clear();
    this.content.addChild(
      new Text(color(this.widgetTheme.bold(`subagent ${this.agentName}`)), 1, 0)
    );
    this.content.addChild(new Text(muted(`Task: ${truncateWidgetText(this.task, 120)}`), 1, 0));
    this.content.addChild(new Text(muted(`Status: ${this.status}`), 1, 0));
    this.content.addChild(new Text(muted(`Turns: ${this.turns}`), 1, 0));
    if (this.latest) this.content.addChild(new Text(muted(`Latest: ${this.latest}`), 1, 0));
    this.content.addChild(this.loader);
  }
}

function truncateWidgetText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function agentArgumentCompletions(prefix: string): AutocompleteItem[] {
  const items: AutocompleteItem[] = [
    { value: LIST_KEYWORD, label: LIST_KEYWORD, description: 'List all discovered agents' },
  ];
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
    '  /agent:<name> <task...>  Invoke a specific agent',
    `Available agents: ${available}`,
  ].join('\n');
}

function extractResultText(result: AgentResult): string {
  const first = result.content[0];
  if (first && first.type === 'text') return first.text;
  return '';
}
