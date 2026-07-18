// ABOUTME: TUI navigator widget and custom list/detail view for interactive Pi subagents.
// ABOUTME: Subscribes to registry snapshots; routes steer/follow-up/prompt/abort without host session switch.

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getSelectListTheme, type Theme } from '@earendil-works/pi-coding-agent';
import {
  type Component,
  type Focusable,
  Input,
  matchesKey,
  SelectList,
  type SelectItem,
  type SelectListTheme,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import {
  type InteractiveAgentRegistry,
  type InteractiveEndpointListItem,
  type InteractiveEndpointSnapshot,
  type InteractiveOutboundMode,
  type InteractiveRegistryEvent,
} from './interactive-agent.ts';
import { formatToolCall } from './render.ts';

const WIDGET_KEY = 'pi-agents-interactive-nav';
const TOOL_RESULT_MAX_LINES = 5;
const TOOL_RESULT_MAX_BYTES = 4 * 1024;
/** Default detail-panel content height: last N lines only (not terminal-row dependent). */
const DETAIL_PREVIEW_LINES = 15;

export interface InteractiveViewControllerOptions {
  registry: InteractiveAgentRegistry;
  /** When false, openView is a no-op (non-TUI hosts). */
  isTui: () => boolean;
  /** Extension UI surface for custom/widget. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getUi: () => any;
}

export function createInteractiveViewController(options: InteractiveViewControllerOptions) {
  const { registry } = options;
  let viewOpen = false;
  let widgetUnsub: (() => void) | undefined;
  let widgetInstalled = false;
  /** Refresh below-editor chrome; no-op until installWidget, suppressed while viewOpen. */
  let refreshWidget: (() => void) | undefined;

  function endpointLabelBase(
    snap: Pick<InteractiveEndpointListItem, 'title' | 'agent' | 'unitId'>
  ): string {
    const title = snap.title?.trim() ?? '';
    // Distinct non-empty title: always keep agent name, then title.
    if (title && title !== snap.agent) {
      return `${snap.agent || snap.unitId} - ${title}`;
    }
    // No title, empty, or title === agent: avoid duplicating the name.
    return title || snap.agent || snap.unitId;
  }

  function endpointLabel(
    snap: Pick<InteractiveEndpointListItem, 'title' | 'agent' | 'unitId'>,
    all: Array<Pick<InteractiveEndpointListItem, 'title' | 'agent' | 'unitId'>>
  ): string {
    const base = endpointLabelBase(snap);
    const collisions = all.filter((e) => endpointLabelBase(e) === base);
    if (collisions.length <= 1) return base;
    const suffix = snap.unitId.length > 8 ? snap.unitId.slice(-6) : snap.unitId;
    return `${base} · ${suffix}`;
  }

  function statusText(snap: Pick<InteractiveEndpointListItem, 'status' | 'queueCount'>): string {
    const q = snap.queueCount;
    const queue = q > 0 ? ` · ${q} queued` : '';
    return `${snap.status}${queue}`;
  }

  function installWidget(): void {
    if (!options.isTui()) return;
    const ui = options.getUi();
    if (!ui) return;

    const refresh = () => {
      // Whole custom nav (list + detail) owns the editor surface — hide chrome entirely.
      if (viewOpen) {
        if (widgetInstalled) {
          ui.setWidget(WIDGET_KEY, undefined);
          widgetInstalled = false;
        }
        return;
      }
      // Metadata only — never materialize message history for the navigator chrome.
      const all = registry.listVisibleMeta();
      // Show only while some visible endpoint is starting/running (status-only; not hasActivation).
      // Rows: only those running endpoints (idle/error/detached remain reachable via /agent view).
      const active = all.filter((ep) => isEndpointRunning(ep.status));
      if (active.length === 0) {
        ui.setWidget(WIDGET_KEY, undefined);
        widgetInstalled = false;
        return;
      }
      // Labels use full visible set for collision suffixes so they match Agent Nav.
      const names = active.map((ep) => endpointLabel(ep, all));
      const nameCol = maxVisibleWidth(names);
      // Component factory so status glyphs pick up theme colors (warning/text/error).
      // Capture the snapshot at refresh time; host invokes the factory immediately.
      ui.setWidget(
        WIDGET_KEY,
        (_tui: TUI, theme: Theme) => {
          const themeFg: ThemeFg = (color, text) => theme.fg(color, text);
          const lines: string[] = [];
          for (let i = 0; i < active.length; i++) {
            lines.push(
              formatEndpointListLabel(
                active[i]!,
                names[i]!,
                statusText(active[i]!),
                nameCol,
                themeFg
              )
            );
          }
          lines.push('/agent view or Ctrl+Alt+Down');
          return {
            render: () => lines.map((l) => ` ${l}`),
            invalidate: () => undefined,
          };
        },
        { placement: 'belowEditor' }
      );
      widgetInstalled = true;
    };

    refreshWidget = refresh;
    widgetUnsub?.();
    // Skip transcript-only stream deltas: status/label chrome does not change per token.
    widgetUnsub = registry.subscribe((event: InteractiveRegistryEvent) => {
      if (event.type === 'endpoint_updated' && event.kind === 'transcript') return;
      if (event.type === 'activation_settled') {
        // Status often flips on settle; refresh chrome.
        refresh();
        return;
      }
      if (
        event.type === 'endpoint_updated' ||
        event.type === 'endpoints_changed' ||
        event.type === 'shutdown'
      ) {
        refresh();
      }
    });
    refresh();
  }

  function clearWidget(): void {
    widgetUnsub?.();
    widgetUnsub = undefined;
    refreshWidget = undefined;
    const ui = options.getUi();
    if (ui && widgetInstalled) {
      ui.setWidget(WIDGET_KEY, undefined);
    }
    widgetInstalled = false;
  }

  async function openView(): Promise<void> {
    if (!options.isTui()) {
      options.getUi()?.notify?.('Interactive agent view is TUI-only.', 'warning');
      return;
    }
    if (viewOpen) return;
    const ui = options.getUi();
    if (!ui) return;
    viewOpen = true;
    // Hide below-editor agent widget for the whole custom-nav session (list and detail).
    refreshWidget?.();
    try {
      // Non-overlay: temporarily replaces the host editor (same surface as /settings).
      await ui.custom(
        (tui: TUI, theme: Theme, _keybindings: unknown, done: (result: null) => void) =>
          new AgentNavigatorPanel({
            tui,
            theme,
            registry,
            onClose: () => done(null),
            endpointLabel,
            statusText,
          }),
        { overlay: false }
      );
    } finally {
      viewOpen = false;
      // Restore only if installWidget is still active and endpoints are starting/running.
      refreshWidget?.();
    }
  }

  function isViewOpen(): boolean {
    return viewOpen;
  }

  return {
    installWidget,
    clearWidget,
    openView,
    isViewOpen,
    endpointLabel,
    statusText,
  };
}

export type InteractiveViewController = ReturnType<typeof createInteractiveViewController>;

interface NavigatorOptions {
  tui: TUI;
  theme: Theme;
  registry: InteractiveAgentRegistry;
  onClose: () => void;
  endpointLabel: (
    snap: Pick<InteractiveEndpointListItem, 'title' | 'agent' | 'unitId'>,
    all: Array<Pick<InteractiveEndpointListItem, 'title' | 'agent' | 'unitId'>>
  ) => string;
  statusText: (snap: Pick<InteractiveEndpointListItem, 'status' | 'queueCount'>) => string;
}

type PanelMode = 'list' | 'detail';

export class AgentNavigatorPanel implements Component, Focusable {
  private mode: PanelMode = 'list';
  private list: SelectList;
  private detail: AgentDetailPanel | null = null;
  private unsub: (() => void) | undefined;
  private _focused = false;
  private readonly opts: NavigatorOptions;
  private readonly listTheme: SelectListTheme;

  constructor(opts: NavigatorOptions) {
    this.opts = opts;
    // Labels embed a status-colored glyph via theme.fg(). For the selected row,
    // strip nested SGR so the whole row (prefix + glyph + name + status) is
    // uniformly accent — glyph status color applies only to non-selected rows.
    this.listTheme = {
      ...getSelectListTheme(),
      selectedText: (text: string) => opts.theme.fg('accent', stripSgr(text)),
    };
    this.list = new SelectList(this.buildItems(), 12, this.listTheme);
    this.list.onSelect = (item) => this.handleListSelect(item);
    this.list.onCancel = () => this.opts.onClose();
    this.unsub = opts.registry.subscribe((event) => {
      // List rows are metadata-only; ignore pure transcript streaming.
      // Detail panel owns its own subscription for token-level updates.
      if (event.type === 'endpoint_updated' && event.kind === 'transcript') return;
      if (this.mode === 'list') {
        this.rebuildList();
      }
      this.opts.tui.requestRender();
    });
  }

  private rebuildList(): void {
    const selected = this.list.getSelectedItem()?.value;
    this.list = new SelectList(this.buildItems(), 12, this.listTheme);
    this.list.onSelect = (item) => this.handleListSelect(item);
    this.list.onCancel = () => this.opts.onClose();
    if (selected) {
      const items = this.buildItems();
      const idx = items.findIndex((i) => i.value === selected);
      if (idx >= 0) this.list.setSelectedIndex(idx);
    }
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    if (this.detail) this.detail.focused = value;
  }

  private buildItems(): SelectItem[] {
    const endpoints = this.opts.registry.listVisibleMeta();
    // SelectList supplies → / two-space prefix; labels carry status glyphs for chrome parity.
    // Status lives in the primary label so narrow terminals still show it (description is dropped ≤40 cols).
    // Pad names to a shared column so trailing status (e.g. detached) lines up across rows.
    const names = endpoints.map((ep) => this.opts.endpointLabel(ep, endpoints));
    const nameCol = maxVisibleWidth(names);
    const themeFg: ThemeFg = (color, text) => this.opts.theme.fg(color, text);
    const items: SelectItem[] = [];
    for (let i = 0; i < endpoints.length; i++) {
      items.push({
        value: endpoints[i]!.key,
        label: formatEndpointListLabel(
          endpoints[i]!,
          names[i]!,
          this.opts.statusText(endpoints[i]!),
          nameCol,
          themeFg
        ),
      });
    }
    return items;
  }

  private handleListSelect(item: SelectItem): void {
    this.detail = new AgentDetailPanel({
      tui: this.opts.tui,
      theme: this.opts.theme,
      registry: this.opts.registry,
      endpointKey: item.value,
      onBack: () => {
        this.detail?.dispose();
        this.detail = null;
        this.mode = 'list';
        this.opts.tui.requestRender();
      },
    });
    this.detail.focused = this._focused;
    this.mode = 'detail';
    this.opts.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.mode === 'detail' && this.detail) {
      return this.detail.render(width);
    }
    // Every row (header, SelectList lines, help, borders) must satisfy visibleWidth <= width.
    // Top/bottom rules: accent + full-width ─.
    const border = this.opts.theme.fg('accent', '─'.repeat(Math.max(1, width)));
    const header = truncateToWidth(this.opts.theme.fg('accent', 'Agent navigator'), width);
    const help = truncateToWidth(this.opts.theme.fg('dim', 'Enter/→ open · ←/Esc close'), width);
    const listLines = this.list
      .render(width)
      .map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
    return [border, header, ...listLines, help, border];
  }

  handleInput(data: string): void {
    if (this.mode === 'detail' && this.detail) {
      this.detail.handleInput(data);
      return;
    }
    // Right: open selected endpoint (same as Enter).
    if (matchesKey(data, 'right')) {
      const selected = this.list.getSelectedItem();
      if (selected) this.handleListSelect(selected);
      return;
    }
    // Left: close navigator (same as Esc).
    if (matchesKey(data, 'left')) {
      this.opts.onClose();
      return;
    }
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
    this.detail?.invalidate();
  }

  dispose(): void {
    this.unsub?.();
    this.unsub = undefined;
    this.detail?.dispose();
    this.detail = null;
  }
}

interface DetailOptions {
  tui: TUI;
  theme: Theme;
  registry: InteractiveAgentRegistry;
  endpointKey: string;
  onBack: () => void;
}

export class AgentDetailPanel implements Component, Focusable {
  private readonly opts: DetailOptions;
  private readonly input = new Input();
  private unsub: (() => void) | undefined;
  private snap: InteractiveEndpointSnapshot | undefined;
  private scrollOffset = 0;
  private followTail = true;
  /** When false, content viewport is fixed at last DETAIL_PREVIEW_LINES lines. */
  private contentExpanded = false;
  private statusMessage = '';
  private _focused = false;
  /** True after dispose — async hydrate must not requestRender. */
  private disposed = false;
  /** Finalized history lines — append-aware when messages share the prior prefix. */
  private finalizedLines: string[] = [];
  private finalizedCacheKey = '';
  /** How many messages from the prior snapshot were already formatted into finalizedLines. */
  private finalizedFormattedCount = 0;
  /** Reference to the messages array last used for finalized formatting (prefix identity). */
  private finalizedMessagesRef: readonly unknown[] | undefined;
  /** Streaming + tools + queues — recomputed on streamRevision/tool/queue changes. */
  private dynamicLines: string[] = [];
  private dynamicCacheKey = '';
  private cachedWidth = 0;
  /** Test seam: number of finalized messages passed through formatMessage. */
  private _finalizedFormatCalls = 0;

  /** Test/debug: how many finalized messages were formatted since construction. */
  get finalizedFormatCalls(): number {
    return this._finalizedFormatCalls;
  }

  constructor(opts: DetailOptions) {
    this.opts = opts;
    // Pure in-memory get for first paint; async ensureTranscript fills history
    // after the process-scoped writer lease/dispose barrier (never bypasses it).
    this.snap = opts.registry.get(opts.endpointKey);
    this.input.onSubmit = (value) => {
      void this.send(value, 'default');
    };
    this.input.onEscape = () => this.opts.onBack();
    this.unsub = opts.registry.subscribe((event) => {
      if (this.disposed) return;
      if (event.type === 'endpoint_updated' && event.key === opts.endpointKey) {
        this.snap = event.snapshot;
        // Cache invalidation is revision-driven — do not blank keys here.
        if (this.followTail) this.scrollOffset = 0;
        this.opts.tui.requestRender();
      } else if (event.type === 'activation_settled' && event.key === opts.endpointKey) {
        this.snap = event.snapshot;
        if (this.followTail) this.scrollOffset = 0;
        this.opts.tui.requestRender();
      }
    });
    void this.requestTranscriptHydrate();
  }

  /**
   * Async detail hydrate via registry.ensureTranscript (awaits session lease).
   * No-ops after dispose or endpoint removal; never renders post-dispose.
   */
  private async requestTranscriptHydrate(): Promise<void> {
    const reg = this.opts.registry as InteractiveAgentRegistry & {
      ensureTranscript?: (
        key: string
      ) =>
        Promise<InteractiveEndpointSnapshot | undefined> | InteractiveEndpointSnapshot | undefined;
    };
    if (typeof reg.ensureTranscript !== 'function') return;
    try {
      const hydrated = await Promise.resolve(reg.ensureTranscript(this.opts.endpointKey));
      if (this.disposed) return;
      if (!hydrated) return;
      this.snap = hydrated;
      if (this.followTail) this.scrollOffset = 0;
      this.opts.tui.requestRender();
    } catch {
      /* soft hydrate failure: keep current in-memory snap */
    }
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  /**
   * Content rows shown. Collapsed is always last DETAIL_PREVIEW_LINES (not terminal-dependent).
   * Expanded shows every content line so the full transcript is visible.
   */
  private contentViewportHeight(totalLines: number): number {
    if (!this.contentExpanded) return DETAIL_PREVIEW_LINES;
    return Math.max(1, totalLines);
  }

  /** Keep scrollOffset in [0, maxOffset] so extra Up at top does not accumulate. */
  private clampScrollOffset(): void {
    const width = this.cachedWidth > 0 ? this.cachedWidth : 80;
    const { finalized, dynamic } = this.ensureSegmentCaches(width);
    const total = finalized.length + dynamic.length;
    const vh = this.contentViewportHeight(total);
    const maxOffset = Math.max(0, total - vh);
    this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxOffset);
  }

  /**
   * Rebuild segmented caches: finalized history only when messagesRevision/width
   * change; dynamic tail (stream/tools/queues) on stream-side revisions.
   * Returns total line count without concatenating the full history array.
   */
  private ensureSegmentCaches(width: number): { finalized: string[]; dynamic: string[] } {
    const snap = this.snap;
    if (!snap) {
      this.finalizedLines = ['(endpoint unavailable)'];
      this.dynamicLines = [];
      this.finalizedCacheKey = '';
      this.finalizedFormattedCount = 0;
      this.finalizedMessagesRef = undefined;
      this.dynamicCacheKey = '';
      this.cachedWidth = width;
      return { finalized: this.finalizedLines, dynamic: this.dynamicLines };
    }

    const fg = (color: Parameters<Theme['fg']>[0], text: string) => this.opts.theme.fg(color, text);
    const finalizedKey = `${snap.messagesRevision}:${width}`;
    if (finalizedKey !== this.finalizedCacheKey || this.cachedWidth !== width) {
      const msgs = snap.messages;
      const prevRef = this.finalizedMessagesRef;
      const prevCount = this.finalizedFormattedCount;
      // Append-aware: same width, messages array keeps the old prefix by reference
      // (registry appendFinalizedMessage freezes prior entries). Only format new tails.
      // Restore / replacement / width change → full rebuild.
      const canAppend =
        width === this.cachedWidth &&
        prevRef !== undefined &&
        prevCount > 0 &&
        msgs.length >= prevCount &&
        this.finalizedLines.length > 0 &&
        // Shared prefix by identity (append-only frozen messages).
        (() => {
          for (let i = 0; i < prevCount; i++) {
            if (msgs[i] !== prevRef[i]) return false;
          }
          return true;
        })();

      if (canAppend && msgs.length > prevCount) {
        const lines = this.finalizedLines.slice();
        for (let i = prevCount; i < msgs.length; i++) {
          this._finalizedFormatCalls += 1;
          lines.push(...formatMessage(msgs[i]!, width, fg));
        }
        this.finalizedLines = lines;
        this.finalizedFormattedCount = msgs.length;
        this.finalizedMessagesRef = msgs;
      } else if (canAppend && msgs.length === prevCount) {
        // Revision bump with identical prefix length — nothing new to format.
        this.finalizedMessagesRef = msgs;
      } else {
        const lines: string[] = [];
        for (const msg of msgs) {
          this._finalizedFormatCalls += 1;
          lines.push(...formatMessage(msg, width, fg));
        }
        this.finalizedLines = lines;
        this.finalizedFormattedCount = msgs.length;
        this.finalizedMessagesRef = msgs;
      }
      this.finalizedCacheKey = finalizedKey;
    }

    const dynamicKey = buildDynamicCacheKey(snap, width);
    if (dynamicKey !== this.dynamicCacheKey || this.cachedWidth !== width) {
      const lines: string[] = [];
      if (snap.streamingMessage) {
        lines.push(...formatMessage(snap.streamingMessage, width, fg, true));
      }
      for (const tool of snap.activeTools) {
        const call = formatToolCall(tool.toolName, tool.args, (c, t) => fg(c, t));
        // Append status first, then truncate so · error/done cannot exceed width.
        const withStatus = tool.ended
          ? tool.isError
            ? `${call} · error`
            : `${call} · done`
          : call;
        lines.push(
          tool.ended
            ? fg('dim', truncateToWidth(withStatus, width))
            : truncateToWidth(withStatus, width)
        );
        // Surface partial tool output so same-count content replacement is visible.
        if (tool.partialResult !== undefined) {
          const partial =
            typeof tool.partialResult === 'string'
              ? tool.partialResult
              : JSON.stringify(tool.partialResult);
          lines.push(fg('dim', truncateToWidth(partial, Math.max(10, width))));
        }
      }
      for (const q of snap.steeringQueue) {
        lines.push(fg('dim', truncateToWidth(`queued steer: ${q}`, Math.max(10, width))));
      }
      for (const q of snap.followUpQueue) {
        lines.push(fg('dim', truncateToWidth(`queued follow-up: ${q}`, Math.max(10, width))));
      }
      this.dynamicLines = lines;
      this.dynamicCacheKey = dynamicKey;
    }

    this.cachedWidth = width;
    return { finalized: this.finalizedLines, dynamic: this.dynamicLines };
  }

  /**
   * Extract at most `vh` visible lines from segmented caches without
   * concatenating the entire finalized history on every frame.
   */
  private extractViewport(finalized: string[], dynamic: string[], vh: number): string[] {
    const total = finalized.length + dynamic.length;
    const maxOffset = Math.max(0, total - vh);
    if (this.followTail) this.scrollOffset = 0;
    const offsetFromEnd = Math.min(this.scrollOffset, maxOffset);
    const start = Math.max(0, total - vh - offsetFromEnd);
    const end = Math.min(total, start + vh);
    const view: string[] = [];

    // Lines in [start, end) may span finalized then dynamic.
    if (start < finalized.length) {
      const fEnd = Math.min(end, finalized.length);
      for (let i = start; i < fEnd; i++) view.push(finalized[i]!);
    }
    if (end > finalized.length) {
      const dStart = Math.max(0, start - finalized.length);
      const dEnd = end - finalized.length;
      for (let i = dStart; i < dEnd; i++) view.push(dynamic[i]!);
    }
    while (view.length < vh) view.push('');
    return view;
  }

  private isGrokAcp(): boolean {
    return this.snap?.sessionArtifact?.runtime === 'grok-acp';
  }

  private isRunningInputBlocked(): boolean {
    if (!this.isGrokAcp()) return false;
    const status = this.snap?.status;
    return status === 'starting' || status === 'running' || !!this.snap?.activation;
  }

  private async send(value: string, kind: 'default' | 'follow_up'): Promise<void> {
    const text = value.trim();
    if (!text) return;
    if (this.isRunningInputBlocked()) {
      return;
    }
    const status = this.snap?.status;
    const hasActivation = !!this.snap?.activation || status === 'running' || status === 'starting';
    // Grok ACP never steers or queues follow-ups; idle/detached always prompt.
    const mode: InteractiveOutboundMode =
      this.isGrokAcp() || !hasActivation ? 'prompt' : kind === 'follow_up' ? 'follow_up' : 'steer';
    try {
      await this.opts.registry.send(this.opts.endpointKey, text, mode);
      this.input.setValue('');
      this.statusMessage = '';
      this.followTail = true;
      this.scrollOffset = 0;
    } catch (err) {
      this.statusMessage = err instanceof Error ? err.message : String(err);
    }
    this.opts.tui.requestRender();
  }

  render(width: number): string[] {
    const snap = this.snap;
    const { finalized, dynamic } = this.ensureSegmentCaches(width);
    const totalLines = finalized.length + dynamic.length;
    const vh = this.contentViewportHeight(totalLines);
    const view = this.extractViewport(finalized, dynamic, vh);

    const title = snap ? `${snap.title || snap.agent} · ${snap.status}` : this.opts.endpointKey;
    // ANSI-aware width: truncate after coloring so visibleWidth <= width on every row.
    // Top/bottom rules: accent + full-width ─.
    const border = this.opts.theme.fg('accent', '─'.repeat(Math.max(1, width)));
    const header = truncateToWidth(this.opts.theme.fg('accent', title), width);
    const sessionLabel = snap?.sessionArtifact
      ? snap.sessionArtifact.runtime === 'grok-acp'
        ? `acp:${snap.sessionArtifact.sessionId.length > 12 ? `${snap.sessionArtifact.sessionId.slice(0, 6)}…${snap.sessionArtifact.sessionId.slice(-4)}` : snap.sessionArtifact.sessionId}`
        : snap.sessionFile
          ? 'session'
          : 'no-session'
      : snap?.sessionFile
        ? 'session'
        : 'no-session';
    const status =
      this.statusMessage || (snap ? `queues ${snap.queueCount} · ${sessionLabel}` : '');
    const statusLine = this.opts.theme.fg(
      this.statusMessage ? 'warning' : 'dim',
      truncateToWidth(status, width)
    );
    // Collapsed: hint expand-all; expanded: hint fold back to last-N preview.
    const helpKeys = this.isGrokAcp()
      ? this.contentExpanded
        ? 'Enter send · Ctrl+X cancel · Ctrl+O collapse · Up/Down · End · ←/Esc back'
        : 'Enter send · Ctrl+X cancel · Ctrl+O expand all · Up/Down · End · ←/Esc back'
      : this.contentExpanded
        ? 'Enter send · Alt+Enter follow-up · Ctrl+X abort · Ctrl+O collapse · Up/Down · End · ←/Esc back'
        : 'Enter send · Alt+Enter follow-up · Ctrl+X abort · Ctrl+O expand all · Up/Down · End · ←/Esc back';
    const help = truncateToWidth(this.opts.theme.fg('dim', helpKeys), width);
    const inputLines = this.isRunningInputBlocked()
      ? [
          truncateToWidth(
            this.opts.theme.fg(
              'warning',
              'Grok ACP input is unavailable while running; wait or press Ctrl+X to cancel.'
            ),
            width
          ),
        ]
      : this.input
          .render(width)
          // pi-tui Input hardcodes "> "; swap to heavy arrow prompt for detail input.
          .map((l) => {
            const line = l.startsWith('> ') ? `❱ ${l.slice(2)}` : l;
            return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
          });
    const safeView = view.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
    const separator = this.opts.theme.fg('accent', '─'.repeat(Math.max(1, width)));
    return [border, header, ...safeView, separator, statusLine, ...inputLines, help, border];
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.opts.onBack();
      return;
    }
    // Left returns only when the prompt is empty; otherwise move the input cursor.
    if (matchesKey(data, 'left') && this.input.getValue().length === 0) {
      this.opts.onBack();
      return;
    }
    if (matchesKey(data, 'up')) {
      this.followTail = false;
      // Page against the collapsed preview height; expanded shows all lines at once.
      this.scrollOffset += DETAIL_PREVIEW_LINES;
      this.clampScrollOffset();
      this.opts.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'down')) {
      this.scrollOffset -= DETAIL_PREVIEW_LINES;
      this.clampScrollOffset();
      if (this.scrollOffset === 0) this.followTail = true;
      this.opts.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'end')) {
      this.followTail = true;
      this.scrollOffset = 0;
      this.opts.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'ctrl+x')) {
      void this.opts.registry.abort(this.opts.endpointKey).then(() => {
        this.statusMessage = 'abort sent';
        this.opts.tui.requestRender();
      });
      return;
    }
    // Toggle last-N preview vs full transcript (must not fall into Input).
    if (matchesKey(data, 'ctrl+o')) {
      this.contentExpanded = !this.contentExpanded;
      if (!this.contentExpanded) {
        this.followTail = true;
        this.scrollOffset = 0;
      }
      this.opts.tui.requestRender();
      return;
    }
    // Running Grok ACP: reject text/steer/follow-up input (cancel still works above).
    if (this.isRunningInputBlocked()) {
      return;
    }
    // Alt+Enter: many terminals send \x1b\r — no follow-up for Grok ACP.
    if (data === '\x1b\r' || data === '\x1b\n' || matchesKey(data, 'alt+enter')) {
      if (this.isGrokAcp()) {
        this.statusMessage = 'Follow-up is not supported for Grok ACP; wait for idle then Enter.';
        this.opts.tui.requestRender();
        return;
      }
      void this.send(this.input.getValue(), 'follow_up');
      return;
    }
    this.input.handleInput(data);
    this.opts.tui.requestRender();
  }

  invalidate(): void {
    this.finalizedCacheKey = '';
    this.finalizedFormattedCount = 0;
    this.finalizedMessagesRef = undefined;
    this.dynamicCacheKey = '';
    this.input.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.unsub?.();
    this.unsub = undefined;
    this.finalizedLines = [];
    this.finalizedFormattedCount = 0;
    this.finalizedMessagesRef = undefined;
  }
}

/** Max terminal columns among strings (ANSI/CJK-aware via visibleWidth). */
function maxVisibleWidth(texts: string[]): number {
  let max = 0;
  for (const t of texts) {
    const w = visibleWidth(t);
    if (w > max) max = w;
  }
  return max;
}

/** Pad `text` with spaces to at least `width` visible columns. */
function padEndVisible(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}

/** Theme color applicator; optional so pure helpers stay usable without a Theme. */
type ThemeFg = (color: Parameters<Theme['fg']>[0], text: string) => string;

/** Whether an endpoint counts as "running" for the below-editor widget. */
function isEndpointRunning(status: InteractiveEndpointListItem['status']): boolean {
  return status === 'starting' || status === 'running';
}

/**
 * Classify list/widget glyph kind from endpoint status + durable stopReason.
 * - running: starting | running
 * - error: error | unavailable
 * - interrupted: settled with stopReason aborted or interrupted (both → ⊘ warning)
 * - completed: idle | detached | registered (and other settled non-error)
 *
 * stopReason sources (glyph only; no behavior difference between the two):
 * - `aborted`: interactive cancel is always this — registry markCancelledUsage
 *   writes usage.stopReason = 'aborted' so the signal survives after activation clear
 *   (do not rely on transient terminalOverride).
 * - `interrupted`: pass-through from assistant / prompt_completed (and similar
 *   formal settle paths); accepted for compatibility, not produced by nav cancel.
 */
function endpointStatusKind(
  snap: Pick<InteractiveEndpointListItem, 'status' | 'usage'>
): 'running' | 'completed' | 'interrupted' | 'error' {
  if (isEndpointRunning(snap.status)) return 'running';
  if (snap.status === 'error' || snap.status === 'unavailable') return 'error';
  const stop = snap.usage?.stopReason;
  if (stop === 'aborted' || stop === 'interrupted') return 'interrupted';
  return 'completed';
}

/**
 * Strip SGR color/style sequences (`\x1b[…m`) so selectedText can wrap the whole
 * row in accent without nested glyph status colors bleeding through.
 * Intentionally SGR-only (not OSC/APC).
 */
function stripSgr(text: string): string {
  // CSI SGR: ESC [ params m — build via fromCharCode to avoid no-control-regex.
  return text.replace(new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g'), '');
}

/**
 * Leading status glyph for agent list rows (widget + Agent Nav).
 * running: warning ◐ · completed: text ● · interrupted: warning ⊘ · error: error ●
 */
function formatEndpointStatusGlyph(
  snap: Pick<InteractiveEndpointListItem, 'status' | 'usage'>,
  themeFg?: ThemeFg
): string {
  const kind = endpointStatusKind(snap);
  let char: string;
  let color: Parameters<Theme['fg']>[0];
  switch (kind) {
    case 'running':
      char = '◐';
      color = 'warning';
      break;
    case 'interrupted':
      char = '⊘';
      color = 'warning';
      break;
    case 'error':
      char = '●';
      color = 'error';
      break;
    case 'completed':
    default:
      char = '●';
      color = 'text';
      break;
  }
  return themeFg ? themeFg(color, char) : char;
}

/**
 * Navigator/widget row: `{glyph} <name>` padded so status starts at a shared column.
 * `nameColumnWidth` is the max visible width of bare names in the current list.
 */
function formatEndpointListLabel(
  snap: Pick<InteractiveEndpointListItem, 'status' | 'usage'>,
  name: string,
  status: string,
  nameColumnWidth: number,
  themeFg?: ThemeFg
): string {
  const glyph = formatEndpointStatusGlyph(snap, themeFg);
  return `${glyph} ${padEndVisible(name, nameColumnWidth)} ${status}`;
}

/**
 * Full cache key (finalized + dynamic) for tests / legacy callers.
 * Uses explicit messagesRevision/streamRevision so same-length content replacement
 * invalidates without relying on length+tail fingerprints that can collide.
 */
export function buildTranscriptCacheKey(
  snap: {
    messagesRevision: number;
    streamRevision: number;
    queueCount: number;
    activeTools: InteractiveEndpointSnapshot['activeTools'];
    steeringQueue?: string[];
    followUpQueue?: string[];
  },
  width: number
): string {
  return `${snap.messagesRevision}:${buildDynamicCacheKey(snap, width)}`;
}

/**
 * Dynamic-tail cache key: streamRevision + tool identity/content + queue content.
 * Same queueCount/tool count with different payload must invalidate.
 */
export function buildDynamicCacheKey(
  snap: {
    streamRevision: number;
    queueCount: number;
    activeTools: InteractiveEndpointSnapshot['activeTools'];
    steeringQueue?: string[];
    followUpQueue?: string[];
  },
  width: number
): string {
  const toolsToken = snap.activeTools
    .map((t) => {
      // Content-sensitive: same tool count with replaced partialResult must invalidate.
      let partial = '';
      if (t.partialResult !== undefined) {
        partial =
          typeof t.partialResult === 'string' ? t.partialResult : JSON.stringify(t.partialResult);
        // Bound token size while remaining content-sensitive.
        if (partial.length > 64) {
          partial = `${partial.length}:${partial.slice(0, 32)}:${partial.slice(-16)}`;
        }
      }
      return `${t.toolCallId}:${t.ended ? 1 : 0}:${t.isError ? 1 : 0}:${partial}`;
    })
    .join(',');
  const steerToken = (snap.steeringQueue ?? []).join('\u0001');
  const followToken = (snap.followUpQueue ?? []).join('\u0001');
  return `${snap.streamRevision}:${toolsToken}:${snap.queueCount}:${steerToken}:${followToken}:${width}`;
}

function formatMessage(
  msg: AgentMessage,
  width: number,
  fg: (color: Parameters<Theme['fg']>[0], text: string) => string,
  partial = false
): string[] {
  const role = (msg as { role?: string }).role;
  if (role === 'user') {
    const text = extractText(msg);
    return wrapLabelled('You', text, width, fg);
  }
  if (role === 'assistant') {
    return formatAssistantMessage(msg, width, fg, partial);
  }
  if (role === 'toolResult' || role === 'tool_result') {
    const text = extractText(msg);
    return wrapToolResult(text, width, fg);
  }
  // custom and other roles
  const text = extractText(msg);
  if (!text) return [];
  return wrapPlain(text, width);
}

function formatAssistantMessage(
  msg: AgentMessage,
  width: number,
  fg: (color: Parameters<Theme['fg']>[0], text: string) => string,
  partial: boolean
): string[] {
  const content = (msg as { content?: unknown }).content;
  const lines: string[] = [];
  if (typeof content === 'string') {
    const wrapped = wrapPlain(content, width);
    if (partial && wrapped.length > 0) {
      const last = wrapped[wrapped.length - 1]!;
      wrapped[wrapped.length - 1] = truncateToWidth(last.endsWith('▍') ? last : `${last}▍`, width);
      lines.push(...wrapped);
      return lines;
    }
    if (partial && wrapped.length === 0) {
      lines.push(truncateToWidth('▍', width));
      return lines;
    }
    lines.push(...wrapped);
    return lines;
  }
  if (Array.isArray(content)) {
    let textBuf = '';
    const flushText = () => {
      if (!textBuf) return;
      lines.push(...wrapPlain(textBuf, width));
      textBuf = '';
    };
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as {
        type?: string;
        text?: string;
        thinking?: string;
        name?: string;
        arguments?: Record<string, unknown>;
        args?: Record<string, unknown>;
      };
      if (p.type === 'thinking' && typeof p.thinking === 'string') {
        flushText();
        const thinkingLines = wrapPlain(p.thinking, width).map((line) =>
          fg('dim', truncateToWidth(`💭 ${line}`, width))
        );
        lines.push(...thinkingLines);
        continue;
      }
      if (p.type === 'text' && typeof p.text === 'string') {
        textBuf += p.text;
        continue;
      }
      if (p.type === 'toolCall' || p.type === 'tool_use' || p.type === 'functionCall') {
        flushText();
        const name = p.name ?? 'tool';
        const args = p.arguments ?? p.args ?? {};
        lines.push(
          truncateToWidth(
            formatToolCall(name, args, (c, t) => fg(c, t)),
            width
          )
        );
      }
    }
    flushText();
    if (partial && lines.length > 0) {
      // Append stream cursor then re-truncate so the marker cannot exceed width.
      const last = lines[lines.length - 1]!;
      const withCursor = last.endsWith('▍') ? last : `${last}▍`;
      lines[lines.length - 1] = truncateToWidth(withCursor, width);
    } else if (partial && lines.length === 0) {
      lines.push(truncateToWidth('▍', width));
    }
    return lines;
  }
  const text = extractText(msg);
  const wrapped = wrapPlain(text, width);
  if (partial && wrapped.length > 0) {
    const last = wrapped[wrapped.length - 1]!;
    wrapped[wrapped.length - 1] = truncateToWidth(last.endsWith('▍') ? last : `${last}▍`, width);
    return wrapped;
  }
  if (partial && wrapped.length === 0) return [truncateToWidth('▍', width)];
  return wrapped;
}

function extractText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const p = part as { type?: string; text?: string };
        if (p.type === 'text' && typeof p.text === 'string') return p.text;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  return '';
}

function wrapLabelled(
  label: string,
  text: string,
  width: number,
  fg: (color: Parameters<Theme['fg']>[0], text: string) => string
): string[] {
  const prefix = fg('accent', `${label}: `);
  const prefixWidth = visibleWidth(`${label}: `);
  const bodyWidth = Math.max(8, width - prefixWidth);
  const body = wrapPlain(text, bodyWidth);
  if (body.length === 0) return [prefix];
  return body.map((line, i) => (i === 0 ? prefix + line : ' '.repeat(prefixWidth) + line));
}

/**
 * Truncate to at most maxBytes UTF-8 bytes without splitting a Unicode code point
 * (including surrogate pairs / multi-byte CJK and emoji).
 */
function truncateUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 };
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  let bytes = 0;
  let end = 0;
  // for...of iterates by Unicode code point (not UTF-16 code units).
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    bytes += chBytes;
    end += ch.length;
  }
  return { text: text.slice(0, end), truncated: true };
}

function wrapPlain(text: string, width: number): string[] {
  if (!text) return [];
  if (width <= 0) return text.split('\n');
  // Linear grapheme/ANSI-aware wrap from pi-tui (avoids O(n²) visibleWidth rescans).
  return wrapTextWithAnsi(text, width);
}

function wrapToolResult(
  text: string,
  width: number,
  fg: (color: Parameters<Theme['fg']>[0], text: string) => string
): string[] {
  // Order: UTF-8 safe byte cap → wrap → cap total lines including marker ≤ MAX.
  let body = text;
  let truncated = false;
  const byBytes = truncateUtf8Bytes(body, TOOL_RESULT_MAX_BYTES);
  if (byBytes.truncated) {
    body = byBytes.text;
    truncated = true;
  }
  let lines = wrapPlain(body, width).map((l) =>
    fg('dim', visibleWidth(l) > width ? truncateToWidth(l, width) : l)
  );
  // Marker counts toward TOOL_RESULT_MAX_LINES (total rows ≤ 5).
  if (lines.length > TOOL_RESULT_MAX_LINES) {
    lines = lines.slice(0, TOOL_RESULT_MAX_LINES - 1);
    truncated = true;
  }
  if (truncated) {
    if (lines.length >= TOOL_RESULT_MAX_LINES) {
      lines = lines.slice(0, TOOL_RESULT_MAX_LINES - 1);
    }
    lines.push(truncateToWidth(fg('warning', '… (truncated)'), width));
  }
  if (lines.length > TOOL_RESULT_MAX_LINES) {
    lines = lines.slice(0, TOOL_RESULT_MAX_LINES);
  }
  return lines;
}

/** Pure helpers exported for unit tests. */
export const __test = {
  formatMessage,
  formatAssistantMessage,
  wrapToolResult,
  wrapPlain,
  truncateUtf8Bytes,
  TOOL_RESULT_MAX_LINES,
  TOOL_RESULT_MAX_BYTES,
  DETAIL_PREVIEW_LINES,
  buildTranscriptCacheKey,
  buildDynamicCacheKey,
  maxVisibleWidth,
  padEndVisible,
  formatEndpointListLabel,
  formatEndpointStatusGlyph,
  endpointStatusKind,
  stripSgr,
  isEndpointRunning,
  endpointOrdering: (snaps: InteractiveEndpointSnapshot[]) =>
    [...snaps].sort((a, b) => a.linkCreatedAt - b.linkCreatedAt),
  /**
   * Segmented format used by the detail panel: finalized history and dynamic tail
   * are independent so burst stream deltas need not re-walk finalized messages.
   * `formatMessageCalls` counts formatMessage invocations for finalized msgs only
   * when `onFinalizedFormat` is provided via the optional counters seam.
   */
  formatTranscriptSegments(
    snap: Pick<
      InteractiveEndpointSnapshot,
      | 'messages'
      | 'streamingMessage'
      | 'activeTools'
      | 'steeringQueue'
      | 'followUpQueue'
      | 'messagesRevision'
      | 'streamRevision'
      | 'queueCount'
    >,
    width: number,
    fg: (color: Parameters<Theme['fg']>[0], text: string) => string,
    counters?: { finalizedFormats: number; dynamicFormats: number }
  ): { finalized: string[]; dynamic: string[] } {
    const finalized: string[] = [];
    for (const msg of snap.messages) {
      if (counters) counters.finalizedFormats += 1;
      finalized.push(...formatMessage(msg, width, fg));
    }
    const dynamic: string[] = [];
    if (snap.streamingMessage) {
      if (counters) counters.dynamicFormats += 1;
      dynamic.push(...formatMessage(snap.streamingMessage, width, fg, true));
    }
    for (const tool of snap.activeTools) {
      if (counters) counters.dynamicFormats += 1;
      const call = formatToolCall(tool.toolName, tool.args, (c, t) => fg(c, t));
      const withStatus = tool.ended ? (tool.isError ? `${call} · error` : `${call} · done`) : call;
      dynamic.push(
        tool.ended
          ? fg('dim', truncateToWidth(withStatus, width))
          : truncateToWidth(withStatus, width)
      );
    }
    for (const q of snap.steeringQueue ?? []) {
      dynamic.push(fg('dim', truncateToWidth(`queued steer: ${q}`, Math.max(10, width))));
    }
    for (const q of snap.followUpQueue ?? []) {
      dynamic.push(fg('dim', truncateToWidth(`queued follow-up: ${q}`, Math.max(10, width))));
    }
    return { finalized, dynamic };
  },
  /** Build transcript lines the same way the detail panel does (for tool-call regressions). */
  formatTranscriptLines(
    snap: {
      messages: InteractiveEndpointSnapshot['messages'];
      streamingMessage?: InteractiveEndpointSnapshot['streamingMessage'];
      activeTools: InteractiveEndpointSnapshot['activeTools'];
      steeringQueue?: string[];
      followUpQueue?: string[];
    },
    width: number,
    fg: (color: Parameters<Theme['fg']>[0], text: string) => string
  ): string[] {
    const { finalized, dynamic } = __test.formatTranscriptSegments(
      {
        messages: snap.messages,
        streamingMessage: snap.streamingMessage,
        activeTools: snap.activeTools,
        messagesRevision: 0,
        streamRevision: 0,
        queueCount: 0,
        steeringQueue: snap.steeringQueue ?? [],
        followUpQueue: snap.followUpQueue ?? [],
      },
      width,
      fg
    );
    return [...finalized, ...dynamic];
  },
  /**
   * Viewport extract without full history concat (mirrors AgentDetailPanel).
   */
  extractViewport(finalized: string[], dynamic: string[], vh: number, scrollOffset = 0): string[] {
    const total = finalized.length + dynamic.length;
    const maxOffset = Math.max(0, total - vh);
    const offsetFromEnd = Math.min(scrollOffset, maxOffset);
    const start = Math.max(0, total - vh - offsetFromEnd);
    const end = Math.min(total, start + vh);
    const view: string[] = [];
    if (start < finalized.length) {
      const fEnd = Math.min(end, finalized.length);
      for (let i = start; i < fEnd; i++) view.push(finalized[i]!);
    }
    if (end > finalized.length) {
      const dStart = Math.max(0, start - finalized.length);
      const dEnd = end - finalized.length;
      for (let i = dStart; i < dEnd; i++) view.push(dynamic[i]!);
    }
    while (view.length < vh) view.push('');
    return view;
  },
};
