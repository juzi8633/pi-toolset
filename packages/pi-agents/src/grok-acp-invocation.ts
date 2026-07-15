// ABOUTME: Grok ACP invocation helpers — CLI args, env overrides, thinking->effort mapping, and ACP startup payloads.
// ABOUTME: Omits maxTurns entirely; maps system prompt and tool filters into session/new._meta.

import type {
  AuthenticateRequest,
  AuthMethod,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  PromptRequest,
} from '@agentclientprotocol/sdk';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { AgentConfig } from './agents.ts';
import { VERSION } from './version.ts';

export const GROK_ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;

export interface GrokAcpSessionMeta {
  rules?: string;
  systemPromptOverride?: string;
  agentProfile?: {
    tools?: string[];
    disallowedTools?: string[];
  };
  [key: string]: unknown;
}

export function buildGrokAcpArgs(agent: AgentConfig): string[] {
  const args: string[] = ['agent'];

  if (agent.model) args.push('--model', agent.model);

  const effort = mapThinkingToEffort(agent.thinking);
  if (effort) args.push('--reasoning-effort', effort);

  args.push('--always-approve', '--no-leader', 'stdio');
  return args;
}

export function buildGrokAcpEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    GROK_DISABLE_AUTOUPDATER: '1',
    GROK_MEMORY: '0',
    GROK_SUBAGENTS: '0',
  };
}

export function buildGrokAcpInitializeParams(): InitializeRequest {
  return {
    protocolVersion: GROK_ACP_PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: {
      name: 'pi-agents',
      version: VERSION,
    },
  };
}

export function buildGrokAcpSessionMeta(agent: AgentConfig): GrokAcpSessionMeta | undefined {
  const meta: GrokAcpSessionMeta = {};

  if (agent.systemPrompt.trim()) {
    if (agent.systemPromptMode === 'replace') {
      meta.systemPromptOverride = agent.systemPrompt;
    } else {
      meta.rules = agent.systemPrompt;
    }
  }

  const hasTools = Boolean(agent.tools && agent.tools.length > 0);
  const hasExclude = Boolean(agent.excludeTools && agent.excludeTools.length > 0);
  if (hasTools || hasExclude) {
    meta.agentProfile = {};
    if (hasTools) meta.agentProfile.tools = [...(agent.tools as string[])];
    if (hasExclude) meta.agentProfile.disallowedTools = [...(agent.excludeTools as string[])];
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

export function buildGrokAcpSessionNewParams(cwd: string, agent: AgentConfig): NewSessionRequest {
  const meta = buildGrokAcpSessionMeta(agent);
  const params: NewSessionRequest = {
    cwd,
    mcpServers: [],
  };
  if (meta) params._meta = meta;
  return params;
}

export function buildGrokAcpPromptParams(sessionId: string, task: string): PromptRequest {
  return {
    sessionId,
    prompt: [{ type: 'text', text: `Task: ${task}` }],
  };
}

/**
 * Build exact ACP session/load parameters.
 * Always passes an empty mcpServers list; cwd is the original effective cwd/worktree.
 */
export function buildGrokAcpSessionLoadParams(
  sessionId: string,
  cwd: string
): { sessionId: string; cwd: string; mcpServers: [] } {
  return {
    sessionId,
    cwd,
    mcpServers: [],
  };
}

export function mapThinkingToEffort(thinking?: string): string | undefined {
  switch (thinking) {
    case 'off':
      return undefined;
    case 'minimal':
      return 'low';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'high';
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}

function authMethodId(method: AuthMethod): string {
  return method.id;
}

export function selectGrokAcpAuthMethod(
  init: InitializeResponse,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const methods = init.authMethods ?? [];
  if (methods.length === 0) return null;

  const ids = methods.map(authMethodId);
  const advertised = new Set(ids);

  const defaultId = (init._meta as { defaultAuthMethodId?: unknown } | null | undefined)
    ?.defaultAuthMethodId;
  if (typeof defaultId === 'string' && advertised.has(defaultId)) {
    return defaultId;
  }

  if (env.XAI_API_KEY && advertised.has('xai.api_key')) {
    return 'xai.api_key';
  }

  if (advertised.has('cached_token')) {
    return 'cached_token';
  }

  throw new Error(
    `Grok ACP authentication required but no supported method is available. Advertised methods: ${ids.join(', ') || 'none'}. Run \`grok login\` or set XAI_API_KEY.`
  );
}

export function buildGrokAcpAuthenticateParams(methodId: string): AuthenticateRequest {
  return { methodId };
}
