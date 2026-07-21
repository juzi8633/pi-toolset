// ABOUTME: Layered agent config overrides: parse, merge, inspect provenance, and atomic disk write.
// ABOUTME: Shared by discovery (user/project/session) and the /agent config TUI editor.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent';
import { DEFAULT_RUNTIME, GROK_ACP_RUNTIME } from '../shared/constants.ts';
import type { AgentConfig, AgentSource, Runtime } from './agents.ts';

export const CONFIG_PACKAGE_DIR = path.join('@balaenis', 'pi-agents');
export const CONFIG_FILE_NAME = 'config.json';

const RUNTIME_VALUES = [DEFAULT_RUNTIME, GROK_ACP_RUNTIME] as const;

export type AgentOverride = Partial<
  Omit<AgentConfig, 'name' | 'systemPrompt' | 'source' | 'filePath' | 'localName' | 'packageName'>
>;

export type OverrideLayer = 'frontmatter' | 'user' | 'project' | 'session';

export type OverridableAgentField =
  | 'description'
  | 'model'
  | 'thinking'
  | 'tools'
  | 'excludeTools'
  | 'systemPromptMode'
  | 'maxTurns'
  | 'noContextFiles'
  | 'noSkills'
  | 'skills'
  | 'defaultContext'
  | 'isolation'
  | 'completionCheck'
  | 'maxSubagentDepth'
  | 'worktreeSetupHook'
  | 'runtime';

export const OVERRIDABLE_AGENT_FIELDS: readonly OverridableAgentField[] = [
  'description',
  'model',
  'thinking',
  'tools',
  'excludeTools',
  'systemPromptMode',
  'maxTurns',
  'noContextFiles',
  'noSkills',
  'skills',
  'defaultContext',
  'isolation',
  'completionCheck',
  'maxSubagentDepth',
  'worktreeSetupHook',
  'runtime',
] as const;

export interface FieldResolution {
  effective: unknown;
  source: OverrideLayer;
  layers: Partial<Record<OverrideLayer, unknown>>;
}

export interface AgentConfigInspection {
  name: string;
  source: AgentSource;
  filePath: string;
  systemPrompt: string;
  effective: AgentConfig;
  fields: Record<OverridableAgentField, FieldResolution>;
}

function parseCsvList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
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

/** Parse a raw config/session override object; invalid fields are dropped. */
export function parseAgentOverride(raw: unknown): AgentOverride {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entry = raw as Record<string, unknown>;
  const out: AgentOverride = {};

  if (typeof entry.description === 'string') out.description = entry.description;
  if (typeof entry.model === 'string') out.model = entry.model;
  if (typeof entry.thinking === 'string') out.thinking = entry.thinking;

  const tools = parseCsvList(entry.tools);
  if (tools) out.tools = tools;
  const excludeTools = parseCsvList(entry.excludeTools);
  if (excludeTools) out.excludeTools = excludeTools;

  const systemPromptMode = parseEnum(entry.systemPromptMode, ['append', 'replace'] as const);
  if (systemPromptMode) out.systemPromptMode = systemPromptMode;

  const maxTurns = parsePositiveInt(entry.maxTurns);
  if (maxTurns !== undefined) out.maxTurns = maxTurns;

  const noContextFiles = parseBoolean(entry.noContextFiles);
  if (noContextFiles !== undefined) out.noContextFiles = noContextFiles;
  const noSkills = parseBoolean(entry.noSkills);
  if (noSkills !== undefined) out.noSkills = noSkills;

  const skills = parseCsvList(entry.skills);
  if (skills) out.skills = skills;

  const defaultContext = parseEnum(entry.defaultContext, ['fresh', 'fork'] as const);
  if (defaultContext) out.defaultContext = defaultContext;
  const isolation = parseEnum(entry.isolation, ['none', 'worktree'] as const);
  if (isolation) out.isolation = isolation;

  const completionCheck = parseCsvList(entry.completionCheck);
  if (completionCheck) out.completionCheck = completionCheck;

  const maxSubagentDepth = parseNonNegativeInt(entry.maxSubagentDepth);
  if (maxSubagentDepth !== undefined) out.maxSubagentDepth = maxSubagentDepth;

  const worktreeSetupHook = parseTrimmedString(entry.worktreeSetupHook);
  if (worktreeSetupHook !== undefined) out.worktreeSetupHook = worktreeSetupHook;

  const runtime = parseEnum(entry.runtime, RUNTIME_VALUES);
  if (runtime) out.runtime = runtime as Runtime;

  return out;
}

/**
 * Parse a single field value for session/UI edits.
 * Returns `{ ok: true, value }` on success, `{ ok: false }` when invalid.
 * Empty string / clear tokens yield `{ ok: true, value: undefined }` (clear field).
 */
export function parseOverrideFieldValue(
  field: OverridableAgentField,
  raw: unknown
): { ok: true; value: AgentOverride[OverridableAgentField] } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (typeof raw === 'string' && (raw.trim() === '' || raw.trim() === '(unset)')) {
    return { ok: true, value: undefined };
  }

  const parsed = parseAgentOverride({ [field]: raw });
  if (!(field in parsed)) {
    return { ok: false, reason: `Invalid value for ${field}` };
  }
  return { ok: true, value: parsed[field] };
}

export function userAgentConfigPath(): string {
  return path.join(getAgentDir(), CONFIG_PACKAGE_DIR, CONFIG_FILE_NAME);
}

/** Nearest ancestor `.pi` directory, or null if none. */
export function resolveProjectConfigDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME);
    if (isDirectory(candidate)) return candidate;
    const parent = path.dirname(currentDir);
    if (parent === currentDir) return null;
    currentDir = parent;
  }
}

/**
 * Project config.json path. Uses nearest `.pi` when present; otherwise
 * `<cwd>/.pi/@balaenis/pi-agents/config.json` (created on first write).
 */
export function projectAgentConfigPath(cwd: string): string {
  const projectDir = resolveProjectConfigDir(cwd);
  if (projectDir) {
    return path.join(projectDir, CONFIG_PACKAGE_DIR, CONFIG_FILE_NAME);
  }
  return path.join(cwd, CONFIG_DIR_NAME, CONFIG_PACKAGE_DIR, CONFIG_FILE_NAME);
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readOverridesFromConfig(configPath: string): Map<string, AgentOverride> {
  const result = new Map<string, AgentOverride>();
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
  const agents = (parsed as Record<string, unknown>).agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return result;
  for (const [name, value] of Object.entries(agents as Record<string, unknown>)) {
    if (typeof name !== 'string' || name.length === 0) continue;
    const override = parseAgentOverride(value);
    if (Object.keys(override).length > 0) result.set(name, override);
  }
  return result;
}

export function loadDiskOverrideMaps(
  cwd: string,
  scope: 'user' | 'project' | 'both'
): { user: Map<string, AgentOverride>; project: Map<string, AgentOverride> } {
  const user = new Map<string, AgentOverride>();
  const project = new Map<string, AgentOverride>();

  if (scope !== 'project') {
    for (const [name, override] of readOverridesFromConfig(userAgentConfigPath())) {
      user.set(name, override);
    }
  }

  if (scope !== 'user') {
    const projectDir = resolveProjectConfigDir(cwd);
    if (projectDir) {
      const configPath = path.join(projectDir, CONFIG_PACKAGE_DIR, CONFIG_FILE_NAME);
      for (const [name, override] of readOverridesFromConfig(configPath)) {
        project.set(name, override);
      }
    }
  }

  return { user, project };
}

/** Shallow field merge; later maps win. Arrays replace, not concat. */
export function mergeAgentOverride(...parts: Array<AgentOverride | undefined>): AgentOverride {
  const out: AgentOverride = {};
  for (const part of parts) {
    if (!part) continue;
    Object.assign(out, part);
  }
  return out;
}

function fieldValue(
  override: AgentOverride | undefined,
  field: OverridableAgentField
): unknown | undefined {
  if (!override || !(field in override)) return undefined;
  return override[field];
}

export function inspectAgentConfig(
  base: AgentConfig,
  layers: {
    user?: AgentOverride;
    project?: AgentOverride;
    session?: AgentOverride;
    /** Session Ctrl+D unsets: effective value falls back to frontmatter only. */
    sessionUnsets?: ReadonlySet<string> | readonly string[];
  }
): AgentConfigInspection {
  const fields = {} as Record<OverridableAgentField, FieldResolution>;
  const unsetSet = new Set(
    layers.sessionUnsets ? Array.from(layers.sessionUnsets as Iterable<string>) : []
  );
  const merged = mergeAgentOverride(layers.user, layers.project, layers.session);
  for (const field of unsetSet) {
    delete (merged as Record<string, unknown>)[field];
  }
  const effective: AgentConfig = { ...base, ...merged };

  for (const field of OVERRIDABLE_AGENT_FIELDS) {
    const layerValues: Partial<Record<OverrideLayer, unknown>> = {
      frontmatter: base[field],
    };
    const userVal = fieldValue(layers.user, field);
    if (userVal !== undefined) layerValues.user = userVal;
    const projectVal = fieldValue(layers.project, field);
    if (projectVal !== undefined) layerValues.project = projectVal;
    const sessionVal = fieldValue(layers.session, field);
    if (sessionVal !== undefined) layerValues.session = sessionVal;

    let source: OverrideLayer = 'frontmatter';
    if (unsetSet.has(field)) {
      // Explicit unset wins over user/project; badge shows session intent.
      source = 'session';
    } else if (sessionVal !== undefined) source = 'session';
    else if (projectVal !== undefined) source = 'project';
    else if (userVal !== undefined) source = 'user';

    fields[field] = {
      effective: effective[field],
      source,
      layers: layerValues,
    };
  }

  return {
    name: base.name,
    source: base.source,
    filePath: base.filePath,
    systemPrompt: base.systemPrompt,
    effective,
    fields,
  };
}

export function overrideValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => item === b[i]);
  }
  return false;
}

export function formatOverrideValue(value: unknown): string {
  if (value === undefined || value === null) return '(unset)';
  if (Array.isArray(value)) return value.length === 0 ? '(unset)' : value.join(', ');
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.length === 0 ? '(unset)' : value;
  return String(value);
}

export interface WriteAgentConfigPatchOptions {
  /** Fields to delete from the agent's stored override (session unset / Ctrl+D). */
  removeFields?: readonly OverridableAgentField[];
}

/**
 * Merge-write field patch for one agent into config.json, optionally removing keys.
 * Atomic write via temp file + rename. Empty patch with no removals is a no-op.
 * Malformed existing file is treated as empty and rewritten with a valid structure.
 */
export function writeAgentConfigPatch(
  configPath: string,
  agentName: string,
  patch: AgentOverride,
  options?: WriteAgentConfigPatchOptions
): void {
  const cleanPatch = parseAgentOverride(patch);
  const removeFields = options?.removeFields ?? [];
  if (Object.keys(cleanPatch).length === 0 && removeFields.length === 0) return;

  let root: Record<string, unknown> = { agents: {} };
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    }
  } catch {
    // missing or malformed → start fresh
  }

  let agents: Record<string, unknown>;
  if (root.agents && typeof root.agents === 'object' && !Array.isArray(root.agents)) {
    agents = { ...(root.agents as Record<string, unknown>) };
  } else {
    agents = {};
  }

  const existingRaw = agents[agentName];
  const existing = parseAgentOverride(existingRaw);
  const merged: AgentOverride = mergeAgentOverride(existing, cleanPatch);
  for (const field of removeFields) {
    delete (merged as Record<string, unknown>)[field];
  }
  if (Object.keys(merged).length === 0) {
    delete agents[agentName];
  } else {
    agents[agentName] = merged;
  }
  root.agents = agents;

  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`);
  const payload = `${JSON.stringify(root, null, 2)}\n`;
  fs.writeFileSync(tmpPath, payload, 'utf-8');
  fs.renameSync(tmpPath, configPath);
}

/** Build a disk patch from dirty session fields (presence only; no tombstones). */
export function buildDirtyPatch(
  override: AgentOverride,
  dirtyFields: readonly OverridableAgentField[]
): AgentOverride {
  const patch: AgentOverride = {};
  for (const field of dirtyFields) {
    if (field in override && override[field] !== undefined) {
      (patch as Record<string, unknown>)[field] = override[field];
    }
  }
  return parseAgentOverride(patch);
}
