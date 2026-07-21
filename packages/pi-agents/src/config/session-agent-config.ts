// ABOUTME: Session-scoped agent config override store with explicit field unsets and dirty badges.
// ABOUTME: Restores from the latest pi-agents-agent-config custom entry on session start/tree.

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  type AgentOverride,
  type OverridableAgentField,
  OVERRIDABLE_AGENT_FIELDS,
  parseAgentOverride,
  parseOverrideFieldValue,
} from './agent-config.ts';

export const PI_AGENTS_AGENT_CONFIG_ENTRY = 'pi-agents-agent-config';

export interface SessionAgentConfigEntryV1 {
  version: 1;
  agents: Record<string, AgentOverride>;
  /** Fields forced back to frontmatter/builtin, ignoring user/project for the session. */
  unsets?: Record<string, string[]>;
}

export interface SessionAgentConfigStore {
  getOverrides(): ReadonlyMap<string, AgentOverride>;
  getAgentOverride(name: string): AgentOverride;
  /** Per-agent fields marked unset (Ctrl+D); discovery skips user/project for these. */
  getUnsets(): ReadonlyMap<string, ReadonlySet<OverridableAgentField>>;
  getUnsetFields(agentName: string): OverridableAgentField[];
  setField(agentName: string, field: OverridableAgentField, value: unknown): void;
  clearField(agentName: string, field: OverridableAgentField): void;
  getDirtyFields(agentName: string): OverridableAgentField[];
  /** Fields currently present on the session overlay for this agent (save source). */
  getSessionFields(agentName: string): OverridableAgentField[];
  markSaved(agentName: string, fields: readonly OverridableAgentField[]): void;
  replaceAll(
    agents: Record<string, AgentOverride>,
    unsets?: Record<string, readonly string[]>
  ): void;
  snapshot(): SessionAgentConfigEntryV1;
  toMap(): Map<string, AgentOverride>;
}

const OVERRIDABLE_FIELD_SET = new Set<string>(OVERRIDABLE_AGENT_FIELDS);

function isOverridableField(value: string): value is OverridableAgentField {
  return OVERRIDABLE_FIELD_SET.has(value);
}

class SessionAgentConfigStoreImpl implements SessionAgentConfigStore {
  private readonly overrides = new Map<string, AgentOverride>();
  private readonly unsets = new Map<string, Set<OverridableAgentField>>();
  private readonly dirty = new Map<string, Set<OverridableAgentField>>();

  getOverrides(): ReadonlyMap<string, AgentOverride> {
    return this.overrides;
  }

  getAgentOverride(name: string): AgentOverride {
    return { ...(this.overrides.get(name) ?? {}) };
  }

  getUnsets(): ReadonlyMap<string, ReadonlySet<OverridableAgentField>> {
    return this.unsets;
  }

  getUnsetFields(agentName: string): OverridableAgentField[] {
    const set = this.unsets.get(agentName);
    return set ? Array.from(set) : [];
  }

  setField(agentName: string, field: OverridableAgentField, value: unknown): void {
    const parsed = parseOverrideFieldValue(field, value);
    if (!parsed.ok) {
      throw new Error(parsed.reason);
    }
    if (parsed.value === undefined) {
      this.clearField(agentName, field);
      return;
    }

    this.clearUnset(agentName, field);
    const current = { ...(this.overrides.get(agentName) ?? {}) };
    (current as Record<string, unknown>)[field] = parsed.value;
    this.overrides.set(agentName, current);
    this.markDirty(agentName, field);
  }

  clearField(agentName: string, field: OverridableAgentField): void {
    const current = this.overrides.get(agentName);
    if (current && field in current) {
      const next = { ...current };
      delete (next as Record<string, unknown>)[field];
      if (Object.keys(next).length === 0) {
        this.overrides.delete(agentName);
      } else {
        this.overrides.set(agentName, next);
      }
    }
    // Explicit unset: ignore user/project for this field until set again.
    this.addUnset(agentName, field);
    this.markDirty(agentName, field);
  }

  getDirtyFields(agentName: string): OverridableAgentField[] {
    const set = this.dirty.get(agentName);
    return set ? Array.from(set) : [];
  }

  getSessionFields(agentName: string): OverridableAgentField[] {
    const override = this.overrides.get(agentName);
    if (!override) return [];
    return Object.keys(override).filter(
      (key): key is OverridableAgentField =>
        key in override && (override as Record<string, unknown>)[key] !== undefined
    );
  }

  markSaved(agentName: string, fields: readonly OverridableAgentField[]): void {
    const set = this.dirty.get(agentName);
    if (!set) return;
    for (const field of fields) set.delete(field);
    if (set.size === 0) this.dirty.delete(agentName);
  }

  replaceAll(
    agents: Record<string, AgentOverride>,
    unsets?: Record<string, readonly string[]>
  ): void {
    this.overrides.clear();
    this.unsets.clear();
    this.dirty.clear();
    for (const [name, raw] of Object.entries(agents)) {
      if (typeof name !== 'string' || name.length === 0) continue;
      const override = parseAgentOverride(raw);
      if (Object.keys(override).length === 0) continue;
      this.overrides.set(name, override);
      for (const field of Object.keys(override) as OverridableAgentField[]) {
        this.markDirty(name, field);
      }
    }
    if (unsets) {
      for (const [name, fields] of Object.entries(unsets)) {
        if (typeof name !== 'string' || name.length === 0 || !Array.isArray(fields)) continue;
        for (const field of fields) {
          if (typeof field !== 'string' || !isOverridableField(field)) continue;
          this.addUnset(name, field);
          this.markDirty(name, field);
        }
      }
    }
  }

  snapshot(): SessionAgentConfigEntryV1 {
    const agents: Record<string, AgentOverride> = {};
    for (const [name, override] of this.overrides) {
      agents[name] = { ...override };
    }
    const unsets: Record<string, string[]> = {};
    for (const [name, fields] of this.unsets) {
      if (fields.size === 0) continue;
      unsets[name] = Array.from(fields).sort();
    }
    const entry: SessionAgentConfigEntryV1 = { version: 1, agents };
    if (Object.keys(unsets).length > 0) entry.unsets = unsets;
    return entry;
  }

  toMap(): Map<string, AgentOverride> {
    return new Map(
      Array.from(this.overrides.entries()).map(([name, override]) => [name, { ...override }])
    );
  }

  private addUnset(agentName: string, field: OverridableAgentField): void {
    let set = this.unsets.get(agentName);
    if (!set) {
      set = new Set();
      this.unsets.set(agentName, set);
    }
    set.add(field);
  }

  private clearUnset(agentName: string, field: OverridableAgentField): void {
    const set = this.unsets.get(agentName);
    if (!set) return;
    set.delete(field);
    if (set.size === 0) this.unsets.delete(agentName);
  }

  private markDirty(agentName: string, field: OverridableAgentField): void {
    let set = this.dirty.get(agentName);
    if (!set) {
      set = new Set();
      this.dirty.set(agentName, set);
    }
    set.add(field);
  }
}

export function createSessionAgentConfigStore(
  initial?: Record<string, AgentOverride>,
  initialUnsets?: Record<string, readonly string[]>
): SessionAgentConfigStore {
  const store = new SessionAgentConfigStoreImpl();
  if (initial || initialUnsets) store.replaceAll(initial ?? {}, initialUnsets);
  return store;
}

export function persistToSession(pi: ExtensionAPI, store: SessionAgentConfigStore): void {
  pi.appendEntry(PI_AGENTS_AGENT_CONFIG_ENTRY, store.snapshot());
}

export function restoreFromBranch(
  ctx: Pick<ExtensionContext, 'sessionManager'>
): SessionAgentConfigEntryV1 {
  const branch = ctx.sessionManager.getBranch();
  let latest: unknown;
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === PI_AGENTS_AGENT_CONFIG_ENTRY) {
      latest = entry.data;
    }
  }
  return parseSessionEntry(latest);
}

export function parseSessionEntry(data: unknown): SessionAgentConfigEntryV1 {
  const empty: SessionAgentConfigEntryV1 = { version: 1, agents: {} };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return empty;
  const record = data as Record<string, unknown>;
  if (record.version !== 1) return empty;

  const agents: Record<string, AgentOverride> = {};
  const rawAgents = record.agents;
  if (rawAgents && typeof rawAgents === 'object' && !Array.isArray(rawAgents)) {
    for (const [name, value] of Object.entries(rawAgents as Record<string, unknown>)) {
      if (typeof name !== 'string' || name.length === 0) continue;
      const override = parseAgentOverride(value);
      if (Object.keys(override).length > 0) agents[name] = override;
    }
  }

  const unsets: Record<string, string[]> = {};
  const rawUnsets = record.unsets;
  if (rawUnsets && typeof rawUnsets === 'object' && !Array.isArray(rawUnsets)) {
    for (const [name, value] of Object.entries(rawUnsets as Record<string, unknown>)) {
      if (typeof name !== 'string' || name.length === 0 || !Array.isArray(value)) continue;
      const fields = value.filter(
        (item): item is OverridableAgentField =>
          typeof item === 'string' && isOverridableField(item)
      );
      if (fields.length > 0) unsets[name] = fields;
    }
  }

  const entry: SessionAgentConfigEntryV1 = { version: 1, agents };
  if (Object.keys(unsets).length > 0) entry.unsets = unsets;
  return entry;
}
