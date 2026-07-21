// ABOUTME: TUI editor for /agent config — agent SelectList plus field SettingsList with layer badges.
// ABOUTME: Session edits persist via store; Ctrl+S/Ctrl+P save, Ctrl+D unsets the selected field.

import {
  getSelectListTheme,
  getSettingsListTheme,
  type ExtensionCommandContext,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  Input,
  isKeyRelease,
  matchesKey,
  parseKey,
  SelectList,
  SettingsList,
  type Component,
  type SettingItem,
  type TUI,
} from '@earendil-works/pi-tui';
import {
  type AgentOverride,
  type OverridableAgentField,
  OVERRIDABLE_AGENT_FIELDS,
  buildDirtyPatch,
  formatOverrideValue,
  inspectAgentConfig,
  loadDiskOverrideMaps,
  projectAgentConfigPath,
  userAgentConfigPath,
  writeAgentConfigPatch,
} from './agent-config.ts';
import { type AgentConfig, discoverAgents } from './agents.ts';
import type { SessionAgentConfigStore } from './session-agent-config.ts';

const SETTINGS_MAX_VISIBLE = 16;
const SELECT_MAX_VISIBLE = 12;
const DESCRIPTION_TRUNCATE = 80;
const FINGERPRINT_HINT =
  'Session edits apply to new launches; in-flight/resumable units may fail fingerprint checks.';

const ENUM_VALUES: Partial<Record<OverridableAgentField, readonly string[]>> = {
  systemPromptMode: ['append', 'replace'],
  defaultContext: ['fresh', 'fork'],
  isolation: ['none', 'worktree'],
  runtime: ['pi', 'grok-acp'],
  noContextFiles: ['true', 'false'],
  noSkills: ['true', 'false'],
};

const FIELD_HELP: Partial<Record<OverridableAgentField, string>> = {
  description: 'Short catalogue description',
  model: 'Model id override',
  thinking: 'Thinking level',
  tools: 'Comma-separated tool allowlist',
  excludeTools: 'Comma-separated tool denylist',
  systemPromptMode: 'append or replace system prompt',
  maxTurns: 'Positive integer turn cap',
  noContextFiles: 'Skip project context files',
  noSkills: 'Disable skill loading',
  skills: 'Comma-separated skill names',
  defaultContext: 'fresh or fork parent context',
  isolation: 'none or worktree',
  completionCheck: 'Required final-message headings (CSV)',
  maxSubagentDepth: 'Non-negative nesting depth',
  worktreeSetupHook: 'Shell hook for worktree setup',
  runtime: 'pi or grok-acp',
};

export interface AgentConfigUiDeps {
  store: SessionAgentConfigStore;
  persist: () => void;
  cwd: string;
  isProjectTrusted: () => boolean;
  /** Test seam: override discovery. */
  discoverAgentsFn?: typeof discoverAgents;
  /** Test seam: override disk write. */
  writePatchFn?: typeof writeAgentConfigPatch;
}

export type SaveTarget = 'user' | 'project';

export interface SaveDirtyResult {
  ok: boolean;
  message: string;
  path?: string;
  fields?: OverridableAgentField[];
}

/**
 * Resolve save target from terminal input.
 * Project save uses Ctrl+P (legacy DC16 / 0x10), distinct from Ctrl+S (0x13).
 */
export function resolveConfigSaveTarget(data: string): SaveTarget | null {
  if (isKeyRelease(data)) return null;

  const id = parseKey(data);
  if (id === 'ctrl+p' || matchesKey(data, 'ctrl+p')) {
    return 'project';
  }
  if (id === 'ctrl+s' || matchesKey(data, 'ctrl+s')) {
    return 'user';
  }
  return null;
}

/**
 * Build patch from the agent's full session overlay (not UI-edit dirty-only).
 * Restored session fields after restart remain saveable without re-touching them.
 */
export function prepareDirtySave(input: {
  store: SessionAgentConfigStore;
  agentName: string;
  target: SaveTarget;
  cwd: string;
  isProjectTrusted: () => boolean;
}):
  | {
      ok: true;
      path: string;
      patch: AgentOverride;
      fields: OverridableAgentField[];
      removeFields: OverridableAgentField[];
    }
  | { ok: false; message: string } {
  const fields = input.store.getSessionFields(input.agentName);
  // Ctrl+D unsets: remove these keys from the target user/project config.json on save.
  const removeFields = input.store.getUnsetFields(input.agentName);
  if (fields.length === 0 && removeFields.length === 0) {
    return { ok: false, message: 'No session overrides to save' };
  }
  if (input.target === 'project' && !input.isProjectTrusted()) {
    return { ok: false, message: 'Project is not trusted; cannot save project config' };
  }
  const override = input.store.getAgentOverride(input.agentName);
  const patch = buildDirtyPatch(override, fields);
  if (Object.keys(patch).length === 0 && removeFields.length === 0) {
    return { ok: false, message: 'No session overrides to save' };
  }
  const configPath =
    input.target === 'user' ? userAgentConfigPath() : projectAgentConfigPath(input.cwd);
  return { ok: true, path: configPath, patch, fields, removeFields };
}

export function saveDirtyFields(input: {
  store: SessionAgentConfigStore;
  agentName: string;
  target: SaveTarget;
  cwd: string;
  isProjectTrusted: () => boolean;
  writePatchFn?: typeof writeAgentConfigPatch;
}): SaveDirtyResult {
  const prepared = prepareDirtySave(input);
  if (!prepared.ok) {
    return { ok: false, message: prepared.message };
  }
  const write = input.writePatchFn ?? writeAgentConfigPatch;
  try {
    write(prepared.path, input.agentName, prepared.patch, {
      removeFields: prepared.removeFields,
    });
    // Clear dirty badges for written/removed fields; keep remaining session values.
    const touched = [...prepared.fields, ...prepared.removeFields];
    input.store.markSaved(input.agentName, touched);
    const parts: string[] = [];
    if (prepared.fields.length > 0) parts.push(prepared.fields.join(', '));
    if (prepared.removeFields.length > 0) {
      parts.push(`unset ${prepared.removeFields.join(', ')}`);
    }
    return {
      ok: true,
      message: `Saved ${parts.join('; ')} → ${prepared.path}`,
      path: prepared.path,
      fields: touched,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Save failed: ${message}` };
  }
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function fieldLabel(field: OverridableAgentField, dirty: boolean): string {
  return dirty ? `* ${field}` : `  ${field}`;
}

function coerceCycleValue(field: OverridableAgentField, raw: string): unknown {
  if (field === 'noContextFiles' || field === 'noSkills') {
    return raw === 'true';
  }
  return raw;
}

function createStringInput(
  initial: string,
  onSubmit: (value: string) => void,
  onCancel: () => void
): Component {
  const input = new Input();
  input.setValue(initial === '(unset)' ? '' : initial);
  input.onSubmit = (value) => onSubmit(value);
  input.onEscape = () => onCancel();
  return {
    render: (width) => {
      const lines = input.render(width);
      return ['Edit value (Enter save · Esc cancel)', ...lines];
    },
    invalidate: () => input.invalidate(),
    handleInput: (data) => input.handleInput(data),
  };
}

export async function openAgentConfigUi(
  ctx: ExtensionCommandContext,
  deps: AgentConfigUiDeps,
  initialAgentName?: string
): Promise<void> {
  const discover = deps.discoverAgentsFn ?? discoverAgents;

  await ctx.ui.custom((tui, theme, _kb, done) => {
    return new AgentConfigEditor({
      tui,
      theme,
      deps,
      discover,
      initialAgentName,
      notify: (message, type) => ctx.ui.notify(message, type),
      onClose: () => done(undefined),
    });
  });
}

class AgentConfigEditor implements Component {
  private mode: 'list' | 'fields' = 'list';
  private list: SelectList;
  private settings: SettingsList | null = null;
  private agents: AgentConfig[] = [];
  private currentAgentName: string | null = null;
  private headerHint = '';
  private fingerprintHintShown = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly deps: AgentConfigUiDeps;
  private readonly discover: typeof discoverAgents;
  private readonly notify: (message: string, type: 'info' | 'warning' | 'error') => void;
  private readonly onClose: () => void;

  constructor(opts: {
    tui: TUI;
    theme: Theme;
    deps: AgentConfigUiDeps;
    discover: typeof discoverAgents;
    initialAgentName?: string;
    notify: (message: string, type: 'info' | 'warning' | 'error') => void;
    onClose: () => void;
  }) {
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.deps = opts.deps;
    this.discover = opts.discover;
    this.notify = opts.notify;
    this.onClose = opts.onClose;
    this.agents = this.loadAgents();
    this.list = this.buildList();
    if (opts.initialAgentName) {
      const found = this.agents.find((a) => a.name === opts.initialAgentName);
      if (found) {
        this.openFields(found.name);
      } else {
        this.notify(`Unknown agent: "${opts.initialAgentName}"`, 'error');
      }
    }
  }

  private loadAgents(): AgentConfig[] {
    return this.discover(this.deps.cwd, 'both', {
      sessionOverrides: this.deps.store.getOverrides(),
      sessionUnsets: this.deps.store.getUnsets(),
    }).agents;
  }

  private loadBaseAgent(name: string): AgentConfig | undefined {
    return this.discover(this.deps.cwd, 'both', { applyDiskOverrides: false }).agents.find(
      (a) => a.name === name
    );
  }

  private buildList(): SelectList {
    const items = this.agents.map((a) => ({
      value: a.name,
      label: `${a.name} [${a.source}]`,
      description: truncate(a.description, DESCRIPTION_TRUNCATE),
    }));
    const list = new SelectList(items, SELECT_MAX_VISIBLE, getSelectListTheme());
    list.onSelect = (item) => this.openFields(item.value);
    list.onCancel = () => this.onClose();
    return list;
  }

  private openFields(agentName: string): void {
    this.currentAgentName = agentName;
    this.mode = 'fields';
    this.settings = this.buildSettings(agentName);
    if (!this.fingerprintHintShown) {
      this.headerHint = FINGERPRINT_HINT;
      this.fingerprintHintShown = true;
    }
    this.tui.requestRender();
  }

  private backToList(): void {
    this.mode = 'list';
    this.settings = null;
    this.currentAgentName = null;
    this.agents = this.loadAgents();
    this.list = this.buildList();
    this.tui.requestRender();
  }

  private inspectAgent(agentName: string) {
    const base = this.loadBaseAgent(agentName);
    if (!base) return null;
    const disk = loadDiskOverrideMaps(this.deps.cwd, 'both');
    return inspectAgentConfig(base, {
      user: disk.user.get(agentName),
      project: disk.project.get(agentName),
      session: this.deps.store.getAgentOverride(agentName),
      sessionUnsets: this.deps.store.getUnsetFields(agentName),
    });
  }

  private buildSettings(agentName: string): SettingsList {
    const inspection = this.inspectAgent(agentName);
    const dirty = new Set(this.deps.store.getDirtyFields(agentName));
    const items: SettingItem[] = OVERRIDABLE_AGENT_FIELDS.map((field) => {
      const resolution = inspection?.fields[field];
      const currentValue = formatOverrideValue(resolution?.effective);
      const source = resolution?.source ?? 'frontmatter';
      const help = FIELD_HELP[field] ?? '';
      const description = `source: ${source}${help ? ` · ${help}` : ''}`;
      const enumValues = ENUM_VALUES[field];
      const item: SettingItem = {
        id: field,
        label: fieldLabel(field, dirty.has(field)),
        currentValue,
        description,
      };
      if (enumValues) {
        item.values = [...enumValues];
      } else {
        item.submenu = (val, done) =>
          createStringInput(
            val,
            (next) => done(next),
            () => done(undefined)
          );
      }
      return item;
    });

    return new SettingsList(
      items,
      Math.min(items.length + 2, SETTINGS_MAX_VISIBLE),
      getSettingsListTheme(),
      (id, newValue) => this.onFieldChange(id as OverridableAgentField, newValue),
      () => this.backToList()
    );
  }

  private onFieldChange(field: OverridableAgentField, newValue: string): void {
    if (!this.currentAgentName) return;
    try {
      const value = coerceCycleValue(field, newValue);
      this.deps.store.setField(this.currentAgentName, field, value);
      this.deps.persist();
      this.refreshSettings();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.notify(message, 'warning');
      this.refreshSettings();
    }
  }

  private refreshSettings(): void {
    if (!this.currentAgentName) return;
    const previousIndex = this.getSettingsSelectedIndex();
    this.agents = this.loadAgents();
    const latest = this.agents.find((a) => a.name === this.currentAgentName);
    if (!latest) {
      this.notify(`Agent "${this.currentAgentName}" is no longer available`, 'warning');
      this.backToList();
      return;
    }
    this.settings = this.buildSettings(this.currentAgentName);
    this.setSettingsSelectedIndex(previousIndex);
    this.tui.requestRender();
  }

  /** SettingsList keeps selectedIndex private; read/write via narrow cast. */
  private getSettingsSelectedIndex(): number {
    if (!this.settings) return 0;
    const index = (this.settings as unknown as { selectedIndex?: number }).selectedIndex;
    return typeof index === 'number' && Number.isFinite(index) ? index : 0;
  }

  private setSettingsSelectedIndex(index: number): void {
    if (!this.settings) return;
    const max = OVERRIDABLE_AGENT_FIELDS.length - 1;
    const clamped = Math.max(0, Math.min(max, index));
    (this.settings as unknown as { selectedIndex: number }).selectedIndex = clamped;
  }

  private handleUnsetSelectedField(): void {
    if (!this.currentAgentName || !this.settings) return;
    const field = OVERRIDABLE_AGENT_FIELDS[this.getSettingsSelectedIndex()];
    if (!field) return;
    this.deps.store.clearField(this.currentAgentName, field);
    this.deps.persist();
    this.notify(
      `Unset ${field} → frontmatter/default; Ctrl+S/Ctrl+P removes it from that config file`,
      'info'
    );
    this.refreshSettings();
  }

  private handleSave(target: SaveTarget): void {
    if (!this.currentAgentName) {
      this.notify('Open an agent to save its session overrides', 'warning');
      return;
    }
    const result = saveDirtyFields({
      store: this.deps.store,
      agentName: this.currentAgentName,
      target,
      cwd: this.deps.cwd,
      isProjectTrusted: this.deps.isProjectTrusted,
      writePatchFn: this.deps.writePatchFn,
    });
    this.notify(result.message, result.ok ? 'info' : 'error');
    this.refreshSettings();
  }

  private currentAgentMeta(): { name: string; source: string; filePath: string } | null {
    if (!this.currentAgentName) return null;
    const agent =
      this.agents.find((a) => a.name === this.currentAgentName) ??
      this.loadBaseAgent(this.currentAgentName);
    if (!agent) return null;
    return { name: agent.name, source: agent.source, filePath: agent.filePath };
  }

  render(width: number): string[] {
    const border = this.theme.fg('accent', '─'.repeat(Math.max(1, width)));
    if (this.mode === 'list') {
      const header = this.theme.fg('accent', this.theme.bold('Agent config'));
      const help = this.theme.fg('dim', 'Enter/→ edit · Esc close · Ctrl+S user · Ctrl+P project');
      return [border, header, ...this.list.render(width), help, border];
    }

    const meta = this.currentAgentMeta();
    const inspection = this.currentAgentName ? this.inspectAgent(this.currentAgentName) : null;
    const header = this.theme.fg(
      'accent',
      this.theme.bold(`Config: ${meta?.name ?? '?'} [${meta?.source ?? '?'}]`)
    );
    const pathLine = this.theme.fg('dim', truncate(meta?.filePath ?? '', Math.max(20, width - 2)));
    const promptLine = this.theme.fg(
      'dim',
      `prompt: ${inspection?.systemPrompt.length ?? 0} chars from file (not editable)`
    );
    const hint = this.headerHint
      ? this.theme.fg('warning', truncate(this.headerHint, Math.max(20, width - 2)))
      : '';
    const help = this.theme.fg(
      'dim',
      'Esc back · Ctrl+S→user · Ctrl+P→project · Ctrl+D unset · * unsaved'
    );
    const settingsLines = this.settings?.render(width) ?? [];
    return [
      border,
      header,
      pathLine,
      promptLine,
      ...(hint ? [hint] : []),
      ...settingsLines,
      help,
      border,
    ];
  }

  handleInput(data: string): void {
    const saveTarget = resolveConfigSaveTarget(data);
    if (saveTarget) {
      this.handleSave(saveTarget);
      return;
    }

    if (this.mode === 'fields' && this.settings) {
      if (!isKeyRelease(data) && matchesKey(data, 'ctrl+d')) {
        this.handleUnsetSelectedField();
        return;
      }
      this.settings.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, 'right')) {
      const selected = this.list.getSelectedItem();
      if (selected) this.openFields(selected.value);
      return;
    }
    if (matchesKey(data, 'left')) {
      this.onClose();
      return;
    }
    this.list.handleInput(data);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.list.invalidate();
    this.settings?.invalidate();
  }
}
