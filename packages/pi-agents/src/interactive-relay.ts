// ABOUTME: Relays interrupted/cancelled interactive agent view continuations to the bound host model.
// ABOUTME: Subscribes to registry settle events; injects a custom message via the Pi Extension API.

import type {
  ExtensionAPI,
  ExtensionContext,
  MessageRenderOptions,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Spacer, Text, type Component } from '@earendil-works/pi-tui';
import { getFinalOutput } from './output.ts';
import {
  INTERACTIVE_LINK_TYPE,
  type InteractiveAgentRegistry,
  type InteractiveEndpointSnapshot,
  type InteractiveRegistryEvent,
  type InteractiveTerminalOverride,
} from './interactive-agent.ts';

export const CONTINUATION_MESSAGE_TYPE = 'pi-agents-interactive-continuation';

/** Public details payload persisted on the continuation custom message. */
export interface InteractiveContinuationDetails {
  runId: string;
  unitId: string;
  agent: string;
  endpointKey: string;
  activationId: string;
  /** Terminal status of this continuation activation. */
  status: 'completed' | 'cancelled' | 'error';
  /** Terminal override recorded by the registry, if any. */
  terminalOverride?: InteractiveTerminalOverride;
  /** Final post-baseline assistant text, empty when the turn produced no output. */
  output: string;
  /** Whether the preceding tool-call activation was interrupted/cancelled. */
  precedingInterrupted: boolean;
  /** Error text when the continuation failed/cancelled with no output. */
  error?: string;
  relayedAt: number;
}

/** Terminal shape of a recorded tool-call activation, used for relay eligibility. */
interface RecordedToolCallTerminal {
  terminalOverride?: InteractiveTerminalOverride;
  error?: string;
  hostSessionId: string;
  bindingId: string;
}

/**
 * Minimal Pi API surface used by the relay. Modeled as a Pick so tests inject a stub.
 * `sendMessage` is the official Extension API path for injecting custom/session messages
 * into the current host model context (see Pi core/extensions types.d.ts).
 */
export type RelayPiApi = Pick<ExtensionAPI, 'sendMessage'>;

export interface InteractiveRelayOptions {
  registry: InteractiveAgentRegistry;
  pi: RelayPiApi;
  /** Resolves the current host ExtensionContext (session identity + branch). */
  getCtx: () => ExtensionContext | undefined;
  now?: () => number;
  /** Test seam to observe suppressed notifications (no content is leaked). */
  onSuppressed?: (reason: string, key: string) => void;
}

function terminalOverrideToStatus(
  override: InteractiveTerminalOverride | undefined,
  snapStatus: InteractiveEndpointSnapshot['status']
): 'completed' | 'cancelled' | 'error' {
  if (override === 'cancelled') return 'cancelled';
  if (override === 'error') return 'error';
  if (override === 'max_turns') return 'completed';
  if (snapStatus === 'error') return 'error';
  return 'completed';
}

/**
 * Build the relay custom-message content. Marked clearly as an interactive
 * continuation so the host model can distinguish it from the original tool call.
 * Includes agent/run/unit identity and the post-baseline final output (or a
 * status line for failed/cancelled turns with no text).
 */
export function buildContinuationMessageContent(
  snap: InteractiveEndpointSnapshot,
  baseline: number,
  status: 'completed' | 'cancelled' | 'error',
  precedingInterrupted: boolean,
  now: () => number
): { content: string; details: InteractiveContinuationDetails } {
  const post = snap.messages.slice(baseline);
  const output = getFinalOutput(post as unknown as Parameters<typeof getFinalOutput>[0]);
  const activation = snap.activation;
  const error = activation?.error;
  const sections: string[] = [];
  sections.push(
    `<pi-agents-continuation agent="${escapeXml(snap.agent)}" runId="${escapeXml(
      snap.runId
    )}" unitId="${escapeXml(snap.unitId)}" status="${status}"${
      precedingInterrupted ? ' precedingInterrupted="true"' : ''
    }>`
  );
  sections.push(
    `<summary>An interactive continuation for subagent ${snap.agent} (run ${snap.runId}) settled as ${status}.</summary>`
  );
  if (output) {
    sections.push(`<output>\n${output}\n</output>`);
  } else if (status !== 'completed') {
    sections.push(
      `<status>The continuation produced no final text (status: ${status}${
        error ? `, error: ${escapeXml(error)}` : ''
      }).</status>`
    );
  } else {
    sections.push('<status>The continuation produced no final text.</status>');
  }
  sections.push('</pi-agents-continuation>');
  const details: InteractiveContinuationDetails = {
    runId: snap.runId,
    unitId: snap.unitId,
    agent: snap.agent,
    endpointKey: snap.key,
    activationId: activation?.id ?? '',
    status,
    ...(activation?.terminalOverride ? { terminalOverride: activation.terminalOverride } : {}),
    output,
    precedingInterrupted,
    ...(error ? { error } : {}),
    relayedAt: now(),
  };
  return { content: sections.join('\n'), details };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Create a relay coordinator that listens for interactive activation settle events
 * and forwards qualifying view continuations to the bound host model context.
 *
 * Relay policy (exactly-once, binding-scoped):
 * - Only `origin: 'view'` activations are relay candidates.
 * - A view continuation relays only when the preceding `origin: 'tool_call'`
 *   activation on the same endpoint terminated interrupted/cancelled (terminalOverride
 *   `cancelled`/`error`, or endpoint status `error`).
 * - Exactly-once dedup by endpointKey + activationId.
 * - Trust: the endpoint's recorded hostSessionId must equal the current host
 *   session id; live `getCtx().sessionManager.getSessionId()` must equal
 *   snap.hostSessionId; `getBranch()` must contain an INTERACTIVE_LINK with
 *   version===1 and runId/unitId/bindingId/hostSessionId/createdAt matching
 *   the snapshot; and the registry must still report active-branch membership
 *   (`registry.isOnActiveBranch(key)`). Cached trust alone is not enough — the
 *   live branch may have switched before session_tree updates bindings.
 *   Operable-but-off-branch running units must not receive relay injection.
 *   Otherwise the relay is suppressed (no content injected); a content-free
 *   notification may be emitted via onSuppressed.
 * - A new `origin: 'tool_call'` activation clears the recorded terminal, so only
 *   continuations immediately following an interrupted tool call qualify.
 * - The detail-panel send is non-blocking: this coordinator observes settle
 *   independently and never blocks the UI send path.
 */
/** Soft cap on retained relayed activation ids (prune oldest insertion order). */
const RELAYED_IDS_MAX = 256;

export function createInteractiveRelayCoordinator(options: InteractiveRelayOptions) {
  const { registry, pi } = options;
  const now = options.now ?? (() => Date.now());
  /** Last tool-call activation terminal per endpoint, used to gate view relays. */
  const lastToolCallTerminal = new Map<string, RecordedToolCallTerminal>();
  /**
   * Relayed activation ids, for exactly-once dedup. Map value is endpoint key so
   * endpoint removal can drop related entries without scanning opaque strings.
   */
  const relayed = new Map<string, string>();
  let disposed = false;

  function currentHostSessionId(): string | undefined {
    const ctx = options.getCtx();
    return ctx?.sessionManager.getSessionId();
  }

  /**
   * Relay requires true active-branch membership (not merely operable/running).
   * Falls back to get() only when the registry lacks isOnActiveBranch (tests).
   */
  function isActiveBranchMember(key: string): boolean {
    const reg = registry as InteractiveAgentRegistry & {
      isOnActiveBranch?: (k: string) => boolean;
    };
    if (typeof reg.isOnActiveBranch === 'function') {
      return reg.isOnActiveBranch(key);
    }
    return registry.get(key) !== undefined;
  }

  /**
   * Live host-branch check: do not rely solely on session_tree-updated
   * trustedBranchBindings. Fail closed unless:
   * - current ctx sessionManager.getSessionId() === snap.hostSessionId
   * - getBranch() contains an INTERACTIVE_LINK with version===1 and
   *   runId/unitId/bindingId/hostSessionId/createdAt all matching the snapshot
   * (registry isOnActiveBranch is checked separately by the caller).
   */
  function liveBranchHasMatchingLink(snap: InteractiveEndpointSnapshot): boolean {
    const ctx = options.getCtx();
    if (!ctx?.sessionManager) {
      // No live branch API (minimal test stubs): fall back to registry trust only.
      return true;
    }
    // Copied link into a foreign host session must not relay.
    try {
      const getSessionId = ctx.sessionManager.getSessionId;
      if (typeof getSessionId === 'function') {
        const sid = getSessionId.call(ctx.sessionManager);
        if (sid !== snap.hostSessionId) return false;
      }
    } catch {
      return false;
    }
    const getBranch = ctx.sessionManager.getBranch;
    if (typeof getBranch !== 'function') {
      // Minimal stubs without branch API: host id already matched when available.
      return true;
    }
    let branch: unknown;
    try {
      branch = getBranch.call(ctx.sessionManager);
    } catch {
      return false;
    }
    if (!Array.isArray(branch)) return false;
    for (const entry of branch) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
      if (e.type !== 'custom' || e.customType !== INTERACTIVE_LINK_TYPE) continue;
      const d = e.data;
      if (!d || typeof d !== 'object') continue;
      const link = d as Record<string, unknown>;
      if (
        link.version === 1 &&
        link.runId === snap.runId &&
        link.unitId === snap.unitId &&
        link.bindingId === snap.bindingId &&
        link.hostSessionId === snap.hostSessionId &&
        link.createdAt === snap.linkCreatedAt
      ) {
        return true;
      }
    }
    return false;
  }

  function isInterruptedTerminal(rec: RecordedToolCallTerminal): boolean {
    return rec.terminalOverride === 'cancelled' || rec.terminalOverride === 'error';
  }

  function pruneRelayedIfNeeded(): void {
    while (relayed.size > RELAYED_IDS_MAX) {
      const first = relayed.keys().next().value;
      if (first === undefined) break;
      relayed.delete(first);
    }
  }

  /** Drop retained gate/dedup state for endpoints no longer present. */
  function pruneRetainedForKeys(liveKeys: ReadonlySet<string>): void {
    for (const key of [...lastToolCallTerminal.keys()]) {
      if (!liveKeys.has(key)) lastToolCallTerminal.delete(key);
    }
    for (const [activationId, endpointKey] of [...relayed.entries()]) {
      if (!liveKeys.has(endpointKey)) relayed.delete(activationId);
    }
  }

  function handleRegistryEvent(event: InteractiveRegistryEvent): void {
    if (disposed) return;

    if (event.type === 'shutdown') {
      lastToolCallTerminal.clear();
      relayed.clear();
      return;
    }

    if (event.type === 'endpoints_changed') {
      pruneRetainedForKeys(new Set(event.keys));
      return;
    }

    if (event.type !== 'activation_settled') return;
    const snap = event.snapshot;
    const activation = snap.activation;
    if (!activation) return;
    const key = event.key;

    if (activation.origin === 'tool_call') {
      // Record the terminal of the originating tool-call activation. A normal
      // completion (no terminal override / status not error) clears the gate so
      // ordinary post-completion chat stays in the child session only.
      if (!activation.terminalOverride && snap.status !== 'error') {
        lastToolCallTerminal.delete(key);
        return;
      }
      lastToolCallTerminal.set(key, {
        terminalOverride: activation.terminalOverride,
        error: activation.error,
        hostSessionId: snap.hostSessionId,
        bindingId: snap.bindingId,
      });
      return;
    }

    if (activation.origin !== 'view') return;

    // Exactly-once: never relay the same activation twice.
    if (relayed.has(activation.id)) return;

    const rec = lastToolCallTerminal.get(key);
    if (!rec || !isInterruptedTerminal(rec)) {
      // No interrupted tool call preceded this view continuation: ordinary
      // post-completion/post-idle chat — stays in the child session only.
      return;
    }

    // Binding-scoped gate: cross-tree / new-binding endpoints must not consume
    // an old binding's continuation eligibility.
    if (rec.bindingId !== snap.bindingId) {
      options.onSuppressed?.('binding_mismatch', key);
      // Drop the stale gate so it cannot fire under a different binding later.
      lastToolCallTerminal.delete(key);
      return;
    }

    // Trust checks: host session, live branch link identity, and registry trust.
    const hostSession = currentHostSessionId();
    if (!hostSession || rec.hostSessionId !== hostSession || snap.hostSessionId !== hostSession) {
      options.onSuppressed?.('host_session_mismatch', key);
      // Consume the gate: a later activation after host change must re-arm via
      // a new tool_call terminal, not inherit the interrupted continuation.
      lastToolCallTerminal.delete(key);
      return;
    }
    // Sync check against the real host branch before any inject — covers the window
    // where the branch switched but session_tree has not yet updated cached trust.
    if (!liveBranchHasMatchingLink(snap)) {
      options.onSuppressed?.('branch_link_mismatch', key);
      lastToolCallTerminal.delete(key);
      return;
    }
    if (!isActiveBranchMember(key)) {
      options.onSuppressed?.('branch_not_visible', key);
      // Off-branch suppress also consumes the tool-call gate so returning to the
      // original branch does not inherit a stale continuation eligibility.
      // A new tool_call terminal (or new host) re-arms explicitly.
      lastToolCallTerminal.delete(key);
      return;
    }

    const status = terminalOverrideToStatus(activation.terminalOverride, snap.status);
    const { content, details } = buildContinuationMessageContent(
      snap,
      activation.baselineMessageCount,
      status,
      true,
      now
    );

    try {
      // Deliver as followUp so a currently-streaming host turn queues the
      // continuation without interrupting; triggerTurn starts a new turn when
      // the host is idle. display=true keeps a rendered row in the transcript.
      pi.sendMessage(
        {
          customType: CONTINUATION_MESSAGE_TYPE,
          content,
          display: true,
          details,
        },
        { triggerTurn: true, deliverAs: 'followUp' }
      );
      relayed.set(activation.id, key);
      pruneRelayedIfNeeded();
      // Consume the gate: a later view activation (different id) must not re-fire
      // the host turn unless a new tool_call terminal re-arms the gate.
      lastToolCallTerminal.delete(key);
    } catch {
      // Failed delivery: do not mark relayed and do not consume the gate, so a
      // later view settle (or retry path) can re-attempt once. We never loop
      // tightly from this catch alone — only the next activation_settled fires.
      options.onSuppressed?.('send_failed', key);
    }
  }

  const unsub = registry.subscribe((event) => {
    try {
      handleRegistryEvent(event);
    } catch {
      /* never crash the registry listener */
    }
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try {
      unsub();
    } catch {
      /* ignore */
    }
    lastToolCallTerminal.clear();
    relayed.clear();
  }

  return {
    dispose,
    /** Test helpers (not for production use). */
    _hasRecordedTerminal: (key: string) => lastToolCallTerminal.has(key),
    _wasRelayed: (activationId: string) => relayed.has(activationId),
    _relayedSize: () => relayed.size,
    _gateSize: () => lastToolCallTerminal.size,
  };
}

export type InteractiveRelayCoordinator = ReturnType<typeof createInteractiveRelayCoordinator>;

/**
 * Renderer for the interactive continuation custom message. Mirrors the
 * background-result renderer shape so the host transcript shows a clear,
 * non-forged continuation row instead of raw XML.
 */
export function renderContinuationMessage(
  message: { details?: InteractiveContinuationDetails; content?: unknown },
  options: MessageRenderOptions,
  theme: Theme
): Component {
  const details = message.details;
  if (!details) {
    return new Text(theme.fg('muted', '(interactive agent continuation: no details)'), 0, 0);
  }

  const statusIcon = (() => {
    switch (details.status) {
      case 'completed':
        return theme.fg('success', '✔');
      case 'cancelled':
        return theme.fg('warning', '⊘');
      case 'error':
        return theme.fg('error', '✗');
      default:
        return theme.fg('warning', '⧖');
    }
  })();

  const header =
    `${statusIcon} ${theme.fg('toolTitle', theme.bold('interactive continuation '))}` +
    theme.fg('accent', details.agent) +
    theme.fg('muted', ` [run ${details.runId.slice(0, 8)}]`);

  if (!options.expanded) {
    let text = header;
    text += `\n${theme.fg('dim', `unit ${details.unitId} · ${details.status}`)}`;
    if (details.output) {
      const preview = details.output.split('\n')[0] ?? '';
      const trimmed = preview.length > 240 ? `${preview.slice(0, 240)}…` : preview;
      text += `\n${theme.fg('toolOutput', trimmed)}`;
    } else if (details.error) {
      text += `\n${theme.fg('error', details.error.slice(0, 240))}`;
    } else {
      text += `\n${theme.fg('muted', '(no final text)')}`;
    }
    return new Text(text, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(header, 0, 0));
  container.addChild(new Text(theme.fg('muted', `Status: ${details.status}`), 0, 0));
  container.addChild(
    new Text(theme.fg('muted', `Agent: `) + theme.fg('accent', details.agent), 0, 0)
  );
  container.addChild(new Text(theme.fg('muted', `Run: `) + theme.fg('dim', details.runId), 0, 0));
  container.addChild(new Text(theme.fg('muted', `Unit: `) + theme.fg('dim', details.unitId), 0, 0));
  if (details.terminalOverride) {
    container.addChild(new Text(theme.fg('muted', `Terminal: ${details.terminalOverride}`), 0, 0));
  }
  if (details.error) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg('muted', '─── Error ───'), 0, 0));
    container.addChild(new Text(theme.fg('error', details.error), 0, 0));
  }
  if (details.output) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg('muted', '─── Output ───'), 0, 0));
    container.addChild(new Markdown(details.output.trim(), 0, 0, getMarkdownTheme()));
  } else {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg('muted', '(no final text)'), 0, 0));
  }
  return container;
}
