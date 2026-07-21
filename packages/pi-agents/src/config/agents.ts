// ABOUTME: Discovers builtin/user/project subagent definitions and parses their frontmatter.
// ABOUTME: Returns AgentConfig records keyed by name with later scopes overriding earlier ones.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { type AgentOverride, loadDiskOverrideMaps, mergeAgentOverride } from './agent-config.ts';
import { DEFAULT_RUNTIME, GROK_ACP_RUNTIME } from '../shared/constants.ts';
import { discoverPackageAgentDirs } from './package-agents.ts';
import type { DefaultContext, IsolationMode, SystemPromptMode } from '../shared/types.ts';

export type { AgentOverride } from './agent-config.ts';
export {
  parseAgentOverride,
  projectAgentConfigPath,
  resolveProjectConfigDir,
  userAgentConfigPath,
} from './agent-config.ts';

export type AgentScope = 'user' | 'project' | 'both';
export type AgentSource = 'builtin' | 'package' | 'user' | 'project';

export type Runtime = typeof DEFAULT_RUNTIME | typeof GROK_ACP_RUNTIME;

const RUNTIME_VALUES = [DEFAULT_RUNTIME, GROK_ACP_RUNTIME] as const;

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  excludeTools?: string[];
  model?: string;
  thinking?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
  systemPromptMode?: SystemPromptMode;
  maxTurns?: number;
  noContextFiles?: boolean;
  noSkills?: boolean;
  skills?: string[];
  defaultContext?: DefaultContext;
  isolation?: IsolationMode;
  completionCheck?: string[];
  maxSubagentDepth?: number;
  localName?: string;
  packageName?: string;
  worktreeSetupHook?: string;
  runtime?: Runtime;
}

function parseCsvList(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const items = value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return (allowed as readonly string[]).includes(trimmed) ? (trimmed as T) : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
  }
  return undefined;
}

function parseTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') n = Number(value.trim());
  else return undefined;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

function parseNonNegativeInt(value: unknown): number | undefined {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    n = Number(trimmed);
  } else return undefined;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return undefined;
  return n;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  builtinAgentsDir: string;
}

export interface DiscoverAgentsOptions {
  sessionOverrides?: ReadonlyMap<string, AgentOverride>;
  /** Session Ctrl+D unsets: force frontmatter/builtin for these fields (skip user/project). */
  sessionUnsets?: ReadonlyMap<string, ReadonlySet<string> | readonly string[]>;
  /** When false, skip user/project config.json merges. Default true. */
  applyDiskOverrides?: boolean;
}

/** Package root for both source (src/**) and bundled (dist/) layouts. */
function resolvePackageRoot(moduleUrl: string): string {
  let cur = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const base = path.basename(cur);
    if (base === 'src' || base === 'dist') {
      const candidate = path.dirname(cur);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..');
}

const BUILTIN_AGENTS_DIR = path.join(resolvePackageRoot(import.meta.url), 'agents');

export function getBuiltinAgentsDir(): string {
  return BUILTIN_AGENTS_DIR;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) {
    return agents;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    const agent = loadAgentFromFile(filePath, source);
    if (agent) agents.push(agent);
  }

  return agents;
}

function loadAgentFromFile(filePath: string, source: AgentSource): AgentConfig | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

  if (typeof frontmatter.name !== 'string' || typeof frontmatter.description !== 'string') {
    return null;
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: parseCsvList(frontmatter.tools),
    excludeTools: parseCsvList(frontmatter.excludeTools),
    model: typeof frontmatter.model === 'string' ? frontmatter.model : undefined,
    thinking: typeof frontmatter.thinking === 'string' ? frontmatter.thinking : undefined,
    systemPrompt: body,
    source,
    filePath,
    systemPromptMode:
      parseEnum(frontmatter.systemPromptMode, ['append', 'replace'] as const) ?? 'append',
    maxTurns: parsePositiveInt(frontmatter.maxTurns),
    noContextFiles: parseBoolean(frontmatter.noContextFiles),
    noSkills: parseBoolean(frontmatter.noSkills),
    skills: parseCsvList(frontmatter.skills),
    defaultContext: parseEnum(frontmatter.defaultContext, ['fresh', 'fork'] as const) ?? 'fresh',
    isolation: parseEnum(frontmatter.isolation, ['none', 'worktree'] as const) ?? 'none',
    completionCheck: parseCsvList(frontmatter.completionCheck),
    maxSubagentDepth: parseNonNegativeInt(frontmatter.maxSubagentDepth),
    worktreeSetupHook: parseTrimmedString(frontmatter.worktreeSetupHook),
    runtime: parseEnum(frontmatter.runtime, RUNTIME_VALUES),
  };
}

function loadAgentsFromPackagePath(
  agentPath: string,
  packageName: string,
  packageRoot: string
): AgentConfig[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(agentPath);
  } catch {
    return [];
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(packageRoot);
  } catch {
    return [];
  }
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  const isContained = (target: string): boolean => {
    let real: string;
    try {
      real = fs.realpathSync(target);
    } catch {
      return false;
    }
    return real === realRoot || real.startsWith(rootWithSep);
  };

  const collected: AgentConfig[] = [];
  if (stat.isFile() && agentPath.endsWith('.md')) {
    if (!isContained(agentPath)) return [];
    const agent = loadAgentFromFile(agentPath, 'package');
    if (agent) collected.push(agent);
  } else if (stat.isDirectory()) {
    if (!isContained(agentPath)) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(agentPath, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const filePath = path.join(agentPath, entry.name);
      // Validate realpath containment BEFORE reading; symlinks pointing outside
      // the package root must not even open the target file.
      if (!isContained(filePath)) continue;
      const agent = loadAgentFromFile(filePath, 'package');
      if (agent) collected.push(agent);
    }
  }

  return collected.map((agent) => ({
    ...agent,
    localName: agent.name,
    packageName,
    name: `${packageName}.${agent.name}`,
  }));
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, 'agents');
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function discoverAgents(
  cwd: string,
  scope: AgentScope,
  options?: DiscoverAgentsOptions
): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), 'agents');
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const builtinAgents = loadAgentsFromDir(BUILTIN_AGENTS_DIR, 'builtin');
  const packageAgents = discoverPackageAgentDirs(cwd, scope).flatMap((pkg) =>
    loadAgentsFromPackagePath(pkg.agentPath, pkg.packageName, pkg.packageRoot)
  );
  const userAgents = scope === 'project' ? [] : loadAgentsFromDir(userDir, 'user');
  const projectAgents =
    scope === 'user' || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, 'project');

  const agentMap = new Map<string, AgentConfig>();

  for (const agent of builtinAgents) agentMap.set(agent.name, agent);
  for (const agent of packageAgents) agentMap.set(agent.name, agent);
  if (scope === 'both' || scope === 'user') {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
  }
  if (scope === 'both' || scope === 'project') {
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  }

  const applyDisk = options?.applyDiskOverrides !== false;
  const disk = applyDisk
    ? loadDiskOverrideMaps(cwd, scope)
    : { user: new Map<string, AgentOverride>(), project: new Map<string, AgentOverride>() };
  const sessionOverrides = options?.sessionOverrides;
  const sessionUnsets = options?.sessionUnsets;

  for (const [name, agent] of agentMap) {
    const user = disk.user.get(name);
    const project = disk.project.get(name);
    const session = sessionOverrides?.get(name);
    const unsetFields = sessionUnsets?.get(name);
    const merged = mergeAgentOverride(user, project, session);
    if (unsetFields) {
      for (const field of unsetFields) {
        delete (merged as Record<string, unknown>)[field];
      }
    }
    if (Object.keys(merged).length === 0) continue;
    agentMap.set(name, { ...agent, ...merged });
  }

  return {
    agents: Array.from(agentMap.values()),
    projectAgentsDir,
    builtinAgentsDir: BUILTIN_AGENTS_DIR,
  };
}

export function formatAgentList(
  agents: AgentConfig[],
  maxItems: number
): { text: string; remaining: number } {
  if (agents.length === 0) return { text: 'none', remaining: 0 };
  const listed = agents.slice(0, maxItems);
  const remaining = agents.length - listed.length;
  return {
    text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join('; '),
    remaining,
  };
}
