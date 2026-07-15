// ABOUTME: Tests for Grok ACP invocation builders — args, env, payloads, and auth selection.
// ABOUTME: Asserts maxTurns is never serialized and AgentConfig / base env are not mutated.

import { describe, expect, it } from 'bun:test';
import type { InitializeResponse } from '@agentclientprotocol/sdk';
import type { AgentConfig } from '../src/agents.ts';
import {
  buildGrokAcpArgs,
  buildGrokAcpAuthenticateParams,
  buildGrokAcpEnv,
  buildGrokAcpInitializeParams,
  buildGrokAcpPromptParams,
  buildGrokAcpSessionLoadParams,
  buildGrokAcpSessionMeta,
  buildGrokAcpSessionNewParams,
  selectGrokAcpAuthMethod,
} from '../src/grok-acp-invocation.ts';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'acp-agent',
    description: 'test acp agent',
    systemPrompt: '',
    source: 'builtin',
    filePath: '/tmp/acp-agent.md',
    runtime: 'grok-acp',
    maxTurns: 1,
    ...overrides,
  };
}

function serialized(...values: unknown[]): string {
  return JSON.stringify(values);
}

describe('buildGrokAcpArgs', () => {
  it('builds agent stdio args with model and reasoning effort before stdio', () => {
    const agent = makeAgent({ model: 'grok-4.5', thinking: 'high', maxTurns: 99 });
    const args = buildGrokAcpArgs(agent);
    expect(args).toEqual([
      'agent',
      '--model',
      'grok-4.5',
      '--reasoning-effort',
      'high',
      '--always-approve',
      '--no-leader',
      'stdio',
    ]);
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--output-format');
    expect(serialized(args)).not.toContain('99');
    expect(serialized(args)).not.toContain('maxTurns');
    expect(serialized(args)).not.toContain('max-turns');
  });

  it('maps thinking levels via the shared effort table', () => {
    expect(buildGrokAcpArgs(makeAgent({ thinking: 'minimal' }))).toEqual([
      'agent',
      '--reasoning-effort',
      'low',
      '--always-approve',
      '--no-leader',
      'stdio',
    ]);
    expect(buildGrokAcpArgs(makeAgent({ thinking: 'xhigh' }))).toEqual([
      'agent',
      '--reasoning-effort',
      'high',
      '--always-approve',
      '--no-leader',
      'stdio',
    ]);
    expect(buildGrokAcpArgs(makeAgent({ thinking: 'off' }))).toEqual([
      'agent',
      '--always-approve',
      '--no-leader',
      'stdio',
    ]);
  });

  it('does not mutate the agent config', () => {
    const agent = makeAgent({ tools: ['read'], model: 'm' });
    const snapshot = JSON.stringify(agent);
    buildGrokAcpArgs(agent);
    expect(JSON.stringify(agent)).toBe(snapshot);
  });
});

describe('buildGrokAcpEnv', () => {
  it('copies base env and sets Grok ACP overrides', () => {
    const base = { PATH: '/usr/bin', XAI_API_KEY: 'k', FOO: 'bar' };
    const env = buildGrokAcpEnv(base);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.XAI_API_KEY).toBe('k');
    expect(env.FOO).toBe('bar');
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe('1');
    expect(env.GROK_MEMORY).toBe('0');
    expect(env.GROK_SUBAGENTS).toBe('0');
    expect(base).not.toHaveProperty('GROK_MEMORY');
    expect(serialized(env)).not.toContain('maxTurns');
  });
});

describe('session metadata and prompt payloads', () => {
  it('maps append system prompt to rules and replace to systemPromptOverride', () => {
    const append = buildGrokAcpSessionMeta(
      makeAgent({ systemPrompt: 'Be careful', systemPromptMode: 'append', maxTurns: 7 })
    );
    expect(append).toEqual({ rules: 'Be careful' });
    expect(serialized(append)).not.toContain('7');
    expect(serialized(append)).not.toContain('maxTurns');

    const replace = buildGrokAcpSessionMeta(
      makeAgent({ systemPrompt: 'Only this', systemPromptMode: 'replace' })
    );
    expect(replace).toEqual({ systemPromptOverride: 'Only this' });
  });

  it('includes inline agentProfile for tools and excludeTools', () => {
    const meta = buildGrokAcpSessionMeta(
      makeAgent({
        systemPrompt: 'rules',
        tools: ['read', 'grep'],
        excludeTools: ['bash'],
        maxTurns: 3,
      })
    );
    expect(meta).toEqual({
      rules: 'rules',
      agentProfile: {
        tools: ['read', 'grep'],
        disallowedTools: ['bash'],
      },
    });
    expect(serialized(meta)).not.toContain('maxTurns');
    expect(serialized(meta)).not.toContain('3');
  });

  it('builds exact session/load params with empty mcpServers', () => {
    expect(buildGrokAcpSessionLoadParams('sess-1', '/work')).toEqual({
      sessionId: 'sess-1',
      cwd: '/work',
      mcpServers: [],
    });
  });

  it('omits empty session meta and builds session/new + prompt without maxTurns', () => {
    const empty = buildGrokAcpSessionMeta(makeAgent({ systemPrompt: '  ', maxTurns: 1 }));
    expect(empty).toBeUndefined();

    const session = buildGrokAcpSessionNewParams('/work', makeAgent({ maxTurns: 1 }));
    expect(session).toEqual({ cwd: '/work', mcpServers: [] });
    expect(serialized(session)).not.toContain('maxTurns');
    expect(serialized(session)).not.toContain('"1"');

    const prompt = buildGrokAcpPromptParams('sess-1', 'do the thing');
    expect(prompt).toEqual({
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'Task: do the thing' }],
    });
    expect(serialized(prompt)).not.toContain('maxTurns');
  });

  it('initialize payload uses protocol version 1 and pi-agents clientInfo', () => {
    const init = buildGrokAcpInitializeParams();
    expect(init.protocolVersion).toBe(1);
    expect(init.clientCapabilities).toEqual({});
    expect(init.clientInfo?.name).toBe('pi-agents');
    expect(serialized(init)).not.toContain('maxTurns');
  });
});

describe('selectGrokAcpAuthMethod', () => {
  it('returns null when no auth methods are advertised', () => {
    expect(selectGrokAcpAuthMethod({ protocolVersion: 1 })).toBeNull();
    expect(selectGrokAcpAuthMethod({ protocolVersion: 1, authMethods: [] })).toBeNull();
  });

  it('prefers defaultAuthMethodId when advertised', () => {
    const init: InitializeResponse = {
      protocolVersion: 1,
      authMethods: [
        { id: 'cached_token', name: 'Cached' },
        { id: 'xai.api_key', name: 'API Key' },
      ],
      _meta: { defaultAuthMethodId: 'xai.api_key' },
    };
    expect(selectGrokAcpAuthMethod(init, {})).toBe('xai.api_key');
  });

  it('prefers xai.api_key when XAI_API_KEY is set', () => {
    const init: InitializeResponse = {
      protocolVersion: 1,
      authMethods: [
        { id: 'cached_token', name: 'Cached' },
        { id: 'xai.api_key', name: 'API Key' },
      ],
    };
    expect(selectGrokAcpAuthMethod(init, { XAI_API_KEY: 'secret' })).toBe('xai.api_key');
  });

  it('falls back to cached_token when advertised', () => {
    const init: InitializeResponse = {
      protocolVersion: 1,
      authMethods: [{ id: 'cached_token', name: 'Cached' }],
    };
    expect(selectGrokAcpAuthMethod(init, {})).toBe('cached_token');
  });

  it('fails with an actionable message when no supported method is available', () => {
    const init: InitializeResponse = {
      protocolVersion: 1,
      authMethods: [{ id: 'oauth_browser', name: 'Browser OAuth' }],
    };
    expect(() => selectGrokAcpAuthMethod(init, {})).toThrow(/oauth_browser/);
    expect(() => selectGrokAcpAuthMethod(init, {})).toThrow(/grok login/);
    expect(() => selectGrokAcpAuthMethod(init, {})).toThrow(/XAI_API_KEY/);
  });

  it('buildGrokAcpAuthenticateParams only carries methodId', () => {
    expect(buildGrokAcpAuthenticateParams('cached_token')).toEqual({ methodId: 'cached_token' });
  });
});
