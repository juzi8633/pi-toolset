// ABOUTME: Session-scoped interactive Pi subagent registry: links, trust resolution, RPC reducer.
// ABOUTME: Owns endpoint lifecycle, activations, messaging serialization, and idle transport LRU.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentConfig, AgentScope, Runtime } from './agents.ts';
import { discoverAgents } from './agents.ts';
import {
  DEFAULT_RUNTIME,
  GROK_ACP_RUNTIME,
  INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES,
  INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES,
} from './constants.ts';
import { getPiInvocation, buildPiRpcArgs, writePromptToTempFile } from './invocation.ts';
import {
  isPiRpcTransportExitEvent,
  PiRpcTransport,
  type PiRpcTransportOptions,
} from './pi-rpc-transport.ts';
import type { RunCoordinator } from './run-coordinator.ts';
import { agentFingerprint } from './run-coordinator.ts';
import type { RunStore } from './run-store.ts';
import type {
  InteractiveAgentBindingV1,
  InteractiveAgentLinkV1,
  StoredRunRequest,
} from './run-types.ts';
import { buildChildAgentEnv, isAgentDelegationAllowed } from './security.ts';
import { resolveSkillNames } from './skills.ts';
import { getGitRoot, openAgentWorktree } from './worktree.ts';
import type { SpawnFn } from './execution.ts';
import {
  acquireSessionLease,
  awaitSessionLease,
  buildSessionLeaseKey,
  canonicalizeSessionLeaseKey,
  disposalCertaintyFromCaught,
  getSessionLeaseGlobalKeyForTest,
  getSessionLeaseStoreSizesForTest,
  isDisposeFailedError,
  releaseSessionLeaseWithCertainty,
  type SessionLeaseToken,
} from './session-lease.ts';
import type {
  InteractiveAgentTransport,
  InteractiveSessionArtifact,
} from './interactive-transport.ts';

export {
  acquireSessionLease,
  awaitSessionLease,
  buildSessionLeaseKey,
  canonicalizeSessionLeaseKey,
  getSessionLeaseGlobalKeyForTest,
  getSessionLeaseStoreSizesForTest,
};
export type { SessionLeaseToken };
export type { InteractiveSessionArtifact };

export const INTERACTIVE_LINK_TYPE = 'pi-agents-interactive-link';
export const MAX_IDLE_TRANSPORTS = 4;

export type InteractiveEndpointStatus =
  'registered' | 'starting' | 'running' | 'idle' | 'detached' | 'error' | 'unavailable';

export type InteractiveOutboundMode = 'prompt' | 'steer' | 'follow_up';

/** Origin of an activation, used to distinguish the original tool-call run from a view continuation. */
export type InteractiveActivationOrigin = 'tool_call' | 'view';

export type InteractiveErrorCode =
  | 'blank_message'
  | 'slash_message'
  | 'unavailable'
  | 'shutdown'
  | 'session_busy'
  | 'not_running'
  | 'transport_error'
  | 'validation_error'
  | 'hydrate_error'
  | 'rejected'
  | 'running_input_unsupported'
  | 'cwd_missing'
  | 'worktree_unavailable'
  | 'acp_session_unavailable'
  | 'acp_load_unsupported'
  | 'acp_session_not_found'
  | 'acp_cwd_mismatch'
  | 'acp_session_history_empty'
  | 'acp_load_error'
  | 'dispose_failed';

export interface InteractiveToolActivity {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  partialResult?: unknown;
  isError?: boolean;
  ended?: boolean;
}

export interface InteractiveActivationPolicy {
  maxTurns?: number;
}

export type InteractiveTerminalOverride = 'max_turns' | 'cancelled' | 'error';

export interface InteractiveActivation {
  id: string;
  endpointKey: string;
  mode: InteractiveOutboundMode;
  baselineMessageCount: number;
  sequence: number;
  policy?: InteractiveActivationPolicy;
  terminalOverride?: InteractiveTerminalOverride;
  /** Origin used by the relay coordinator to scope continuation relays. */
  origin: InteractiveActivationOrigin;
  settled: boolean;
  error?: string;
  createdAt: number;
  /**
   * True after agent_start for this activation. Used so a late/duplicate
   * agent_settled from a prior turn cannot settle a newer activation B.
   */
  observedAgentStart?: boolean;
  /**
   * True after a real matching prompt_completed event for this activation.
   * Grok ACP continuation delivery requires this flag; cancel-grace settlement
   * and prompt_failed never set it.
   */
  promptCompleted?: boolean;
}

export interface InteractiveLaunchSpec {
  agent: AgentConfig;
  request: StoredRunRequest;
  resolvedSkillPaths?: string[];
  /** @deprecated Prefer sessionArtifact; retained for Pi call-site compatibility. */
  sessionFile: string;
  sessionArtifact?: InteractiveSessionArtifact;
  effectiveCwd: string;
  worktreePath?: string;
  title?: string;
  modelOverride?: string;
  thinkingOverride?: string;
  runtimeOverride?: Runtime;
  isolation?: 'none' | 'worktree';
  agentScope: AgentScope;
  registrationKind: 'initial' | 'restore';
}

export interface InteractiveAgentEndpoint {
  key: string;
  hostSessionId: string;
  runId: string;
  unitId: string;
  bindingId: string;
  agent: string;
  title?: string;
  /** @deprecated Prefer sessionArtifact; retained for Pi call-site compatibility. */
  sessionFile: string;
  sessionArtifact?: InteractiveSessionArtifact;
  effectiveCwd: string;
  worktreePath?: string;
  status: InteractiveEndpointStatus;
  /** Finalized transcript; append-only immutable view (never mutate in place). */
  messages: readonly AgentMessage[];
  /**
   * Stable immutable array view of finalized messages (same ref as `messages`).
   * Replaced only on message_end / hydrate / restore — shared into transcript snapshots
   * so message_update never allocates a new messages array.
   */
  finalizedMessagesView: readonly AgentMessage[];
  /** Bumps when finalizedMessagesView is replaced. */
  messagesRevision: number;
  /** Bumps when streaming message or tool rows change. */
  streamRevision: number;
  streamingMessage?: AgentMessage;
  activeTools: Map<string, InteractiveToolActivity>;
  steeringQueue: string[];
  followUpQueue: string[];
  activation?: InteractiveActivation;
  transportReady?: Promise<PiRpcTransport | InteractiveAgentTransport>;
  lastError?: string;
  errorCode?: InteractiveErrorCode | string;
  client?: PiRpcTransport | InteractiveAgentTransport;
  /**
   * Monotonic spawn generation. Handshake resolve/reject/events/dispose only
   * mutate this endpoint when the event's generation still matches.
   */
  transportGeneration: number;
  /**
   * Whether session transcript has been loaded into finalizedMessagesView.
   * Restore is metadata-only; hydrate on get / detail / activation reopen.
   * Only set after a successful hydrate or when the in-memory view is authoritative.
   */
  transcriptHydrated: boolean;
  /**
   * Internal per-message UTF-8 JSON sizes for finalizedMessagesView accounting.
   * Not exposed on public snapshots.
   */
  finalizedMessageBytes?: number[];
  /** Cached sum of finalizedMessageBytes (JSON array body without brackets/commas). */
  finalizedMessagesBytes?: number;
  /**
   * Live-process-only: initial registration accepted a planned session path that
   * did not exist yet. Reopen revalidation may re-accept that missing path.
   * Cleared once the file appears. Never set for trusted restore links.
   */
  allowPlannedMissingSession?: boolean;
  lastUsedAt: number;
  createdAt: number;
  linkCreatedAt: number;
  launchSpec?: InteractiveLaunchSpec;
  usage?: {
    turns: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    model?: string;
    stopReason?: string;
  };
  isCompacting?: boolean;
  isRetrying?: boolean;
}

export type InteractiveEndpointSnapshot = Omit<
  InteractiveAgentEndpoint,
  | 'activeTools'
  | 'client'
  | 'transportReady'
  | 'launchSpec'
  | 'finalizedMessagesView'
  | 'messages'
  | 'transportGeneration'
  | 'transcriptHydrated'
  | 'allowPlannedMissingSession'
  | 'finalizedMessageBytes'
  | 'finalizedMessagesBytes'
> & {
  /** Read-only finalized messages; consumers must not push or mutate nested content. */
  messages: readonly AgentMessage[];
  activeTools: InteractiveToolActivity[];
  hasTransport: boolean;
  queueCount: number;
  sessionArtifact?: InteractiveSessionArtifact;
};

/**
 * Lightweight list/widget row: no message history or streaming payload.
 * Used so transcript-only stream events never force full history materialization.
 */
export type InteractiveEndpointListItem = Pick<
  InteractiveEndpointSnapshot,
  | 'key'
  | 'hostSessionId'
  | 'runId'
  | 'unitId'
  | 'bindingId'
  | 'agent'
  | 'title'
  | 'sessionFile'
  | 'sessionArtifact'
  | 'effectiveCwd'
  | 'worktreePath'
  | 'status'
  | 'lastError'
  | 'errorCode'
  | 'lastUsedAt'
  | 'createdAt'
  | 'linkCreatedAt'
  | 'usage'
  | 'isCompacting'
  | 'isRetrying'
  | 'hasTransport'
  | 'queueCount'
> & {
  /** True when an activation is in flight (list/status only). */
  hasActivation: boolean;
};

/**
 * What changed on an endpoint publish.
 * - `transcript`: streaming/finalized messages or tool rows only (detail view)
 * - `meta`: status/queues/activation/errors (widget + list)
 * - `full`: both (settle, registration, restore, structural changes)
 */
export type InteractiveEndpointUpdateKind = 'transcript' | 'meta' | 'full';

export type InteractiveRegistryEvent =
  | {
      type: 'endpoint_updated';
      key: string;
      snapshot: InteractiveEndpointSnapshot;
      kind: InteractiveEndpointUpdateKind;
    }
  | { type: 'endpoints_changed'; keys: string[] }
  | {
      type: 'activation_settled';
      key: string;
      activationId: string;
      snapshot: InteractiveEndpointSnapshot;
    }
  | { type: 'shutdown' };

export interface InteractiveRegisterInput {
  runId: string;
  unitId: string;
  hostSessionId: string;
  launchSpec: InteractiveLaunchSpec;
  /** Optional override; defaults to the host link appender installed on the registry. */
  appendLink?: (link: InteractiveAgentLinkV1) => void;
  getBranchEntries: () => Array<{ type: string; customType?: string; data?: unknown }>;
}

export interface InteractiveRegistryOptions {
  runStore: RunStore;
  runCoordinator: RunCoordinator;
  spawnFn?: SpawnFn;
  transportFactory?: (options: PiRpcTransportOptions) => Promise<PiRpcTransport>;
  /**
   * Injectable Grok ACP transport factory (hydrate + spawn/reopen). Defaults to
   * the production `createGrokAcpInteractiveTransport` helper.
   */
  grokAcpTransportFactory?: (
    options: import('./grok-acp-interactive-transport.ts').GrokAcpInteractiveTransportOptions
  ) => Promise<InteractiveAgentTransport>;
  clock?: () => number;
  idleLimit?: number;
  discoverAgentsFn?: typeof discoverAgents;
  /**
   * After a live abort RPC is fired, force-detach if the activation is still open.
   * Keeps the transition queue free of long-running abort RPCs (transport default 30s).
   * Injectable for tests; production default 10s.
   */
  abortSettleTimeoutMs?: number;
  /**
   * Single absolute wall-clock budget for the whole shutdown path
   * (abort/settle/dispose/barrier). Not two serial races. Default 5500ms.
   */
  shutdownDisposeBudgetMs?: number;
  /**
   * When send preflight sees get_state idle but the current activation is still
   * open, wait this long for a real agent_settled before activation-scoped
   * detach. Does not force-settle. Injectable for tests; default 10s.
   */
  idleSettleWaitMs?: number;
  timers?: {
    setTimeout: (fn: () => void, ms?: number) => unknown;
    clearTimeout: (id: unknown) => void;
  };
}

export class InteractiveAgentError extends Error {
  readonly code: InteractiveErrorCode | string;

  constructor(code: InteractiveErrorCode | string, message: string) {
    super(message);
    this.name = 'InteractiveAgentError';
    this.code = code;
  }
}

function endpointKey(runId: string, unitId: string): string {
  return `${runId}:${unitId}`;
}

function isLinkData(data: unknown): data is InteractiveAgentLinkV1 {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    d.version === 1 &&
    typeof d.runId === 'string' &&
    typeof d.unitId === 'string' &&
    typeof d.bindingId === 'string' &&
    typeof d.hostSessionId === 'string' &&
    typeof d.createdAt === 'number'
  );
}

/** Shared empty finalized view — frozen so consumers cannot push/mutate. */
const EMPTY_FINALIZED: readonly AgentMessage[] = Object.freeze([]);

/**
 * Module-private ownership of messages projected by this file.
 * External freeze does not establish ownership; only post-project freezes do.
 */
const projectedMessageOwnership = new WeakSet<object>();

function isProjectedMessage(msg: unknown): msg is AgentMessage {
  return typeof msg === 'object' && msg !== null && projectedMessageOwnership.has(msg);
}

function markProjectedMessage<T extends object>(value: T): T {
  projectedMessageOwnership.add(value);
  return value;
}

/** Deep-freeze a value in place (post-clone). Arrays and plain objects only. */
function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
  } else {
    for (const v of Object.values(value as Record<string, unknown>)) {
      freezeDeep(v);
    }
  }
  return Object.freeze(value);
}

function utf8JsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  let slice = value.slice(0, end);
  while (end > 0 && Buffer.byteLength(slice, 'utf8') > maxBytes) {
    end -= 1;
    slice = value.slice(0, end);
  }
  return slice;
}

function boundStringToBudget(value: string, label: string, maxBytes: number): string {
  const original = Buffer.byteLength(value, 'utf8');
  if (original <= maxBytes) return value;
  if (maxBytes <= 0) return '';
  const marker = `\n\n[${label} truncated: ${original} bytes omitted; inspect child session history]`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes >= maxBytes) {
    const short = `[truncated: ${original} bytes]`;
    if (Buffer.byteLength(short, 'utf8') <= maxBytes) return short;
    return truncateUtf8(short, maxBytes);
  }
  const budget = Math.max(0, maxBytes - markerBytes);
  return `${truncateUtf8(value, budget)}${marker}`;
}

function boundStringField(value: string, label: string): string {
  return boundStringToBudget(value, label, INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES);
}

function boundUnknownPayload(value: unknown, label: string): unknown {
  const size = utf8JsonBytes(value);
  if (size <= INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) {
    // Always clone under-budget objects/arrays so freeze never mutates transport-owned data.
    if (value !== null && typeof value === 'object') return structuredClone(value);
    return value;
  }
  return {
    _omitted: true,
    omittedBytes: size,
    message: `${label} exceeded interactive budget; inspect child session history.`,
  };
}

/** Force an omission marker regardless of payload size (used when complete entry exceeds budget). */
function omitPayloadMarker(value: unknown, label: string): Record<string, unknown> {
  return {
    _omitted: true,
    omittedBytes: utf8JsonBytes(value),
    message: `${label} exceeded interactive budget; inspect child session history.`,
  };
}

/** Identity-ish keys kept on content parts; everything else is size-bounded. */
const CONTENT_PART_IDENTITY_KEYS = new Set([
  'type',
  'id',
  'name',
  'toolCallId',
  'mimeType',
  'toolName',
  'isError',
]);

/** Assistant top-level keys that remain authoritative (text/content + required metadata). */
const ASSISTANT_AUTHORITATIVE_TOP_KEYS = new Set([
  'role',
  'content',
  'usage',
  'model',
  'stopReason',
]);

function boundRecordFields(
  record: Record<string, unknown>,
  label: string,
  preserveKeys: ReadonlySet<string> = CONTENT_PART_IDENTITY_KEYS
): void {
  for (const key of Object.keys(record)) {
    if (preserveKeys.has(key)) continue;
    const val = record[key];
    if (typeof val === 'string') {
      record[key] = boundStringField(val, `${label} ${key}`);
    } else if (val !== null && typeof val === 'object') {
      record[key] = boundUnknownPayload(val, `${label} ${key}`);
    }
  }
}

/**
 * Replace an oversized non-authoritative object with a marker that fits the
 * complete-item budget, retaining small identity keys when possible.
 */
function omitOversizedItem(part: Record<string, unknown>, label: string): Record<string, unknown> {
  const originalSize = utf8JsonBytes(part);
  const base: Record<string, unknown> = {
    _omitted: true,
    omittedBytes: originalSize,
    message: `${label} exceeded interactive budget; inspect child session history.`,
  };
  const out: Record<string, unknown> = { ...base };
  for (const key of CONTENT_PART_IDENTITY_KEYS) {
    const val = part[key];
    if (val === undefined || val === null || typeof val === 'object') continue;
    const trial = { ...out, [key]: val };
    if (utf8JsonBytes(trial) <= INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) {
      out[key] = val;
    }
  }
  if (utf8JsonBytes(out) <= INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) return out;
  return {
    _omitted: true,
    omittedBytes: originalSize,
    message: 'exceeded interactive budget',
  };
}

/**
 * Enforce the complete retained non-authoritative item budget, including JSON
 * object overhead and every field (not just independently bounded payloads).
 * Prefers shrinking non-identity string fields so truncated content is retained
 * when possible; falls back to a compact omission marker only when needed.
 */
function enforceNonAuthoritativeItemBudget(part: unknown, label: string): unknown {
  if (part === null || typeof part !== 'object') {
    if (typeof part === 'string') return boundStringField(part, label);
    return part;
  }
  const p = part as Record<string, unknown>;
  if (utf8JsonBytes(p) <= INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) return p;

  for (let round = 0; round < 16; round++) {
    const size = utf8JsonBytes(p);
    if (size <= INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) return p;
    const overshoot = size - INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES;
    let victim: string | undefined;
    let victimBytes = 0;
    for (const [key, val] of Object.entries(p)) {
      if (CONTENT_PART_IDENTITY_KEYS.has(key)) continue;
      if (typeof val !== 'string') continue;
      const bytes = Buffer.byteLength(val, 'utf8');
      if (bytes > victimBytes) {
        victimBytes = bytes;
        victim = key;
      }
    }
    if (!victim || victimBytes === 0) break;
    // Leave slack for marker growth and JSON encoding overhead on the next check.
    const target = Math.max(0, victimBytes - overshoot - 128);
    const next = boundStringToBudget(p[victim] as string, `${label} ${victim}`, target);
    if (Buffer.byteLength(next, 'utf8') >= victimBytes) break;
    p[victim] = next;
  }

  if (utf8JsonBytes(p) <= INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) return p;
  return omitOversizedItem(p, label);
}

/**
 * Bound non-authoritative siblings on an assistant text part without touching text.
 * Identity fields (id/name/toolCallId/…) and unknown extras are each complete-item
 * budgeted, then dropped until the non-text envelope fits the item cap.
 */
function boundTextPartSiblings(part: Record<string, unknown>): void {
  for (const key of Object.keys(part)) {
    if (key === 'type' || key === 'text') continue;
    const val = part[key];
    if (typeof val === 'string') {
      part[key] = boundStringField(val, `assistant text ${key}`);
    } else if (val !== null && typeof val === 'object') {
      part[key] = boundUnknownPayload(val, `assistant text ${key}`);
    } else if (val !== undefined && typeof val !== 'number' && typeof val !== 'boolean') {
      part[key] = enforceNonAuthoritativeItemBudget(val, `assistant text ${key}`);
    }
  }
  // Drop largest siblings until the non-text envelope fits the complete-item budget.
  for (let round = 0; round < 32; round++) {
    const shell: Record<string, unknown> = { type: part.type };
    for (const [key, val] of Object.entries(part)) {
      if (key === 'type' || key === 'text') continue;
      shell[key] = val;
    }
    if (utf8JsonBytes(shell) <= INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) return;
    let victim: string | undefined;
    let victimBytes = 0;
    for (const [key, val] of Object.entries(part)) {
      if (key === 'type' || key === 'text') continue;
      const bytes = utf8JsonBytes(val);
      if (bytes > victimBytes) {
        victimBytes = bytes;
        victim = key;
      }
    }
    if (!victim) return;
    delete part[victim];
  }
}

function boundAssistantContentPart(part: unknown): unknown {
  if (!part || typeof part !== 'object') return part;
  const p = part as Record<string, unknown>;
  if (p.type === 'text') {
    // Authoritative assistant text remains exact (even when > 64 KiB).
    // Identity siblings and unknown extras are complete-item budgeted and may be stripped.
    boundTextPartSiblings(p);
    return p;
  }
  if (p.type === 'thinking' && typeof p.thinking === 'string') {
    p.thinking = boundStringField(p.thinking, 'thinking');
    boundRecordFields(p, 'thinking content', new Set([...CONTENT_PART_IDENTITY_KEYS, 'thinking']));
    return enforceNonAuthoritativeItemBudget(p, 'thinking content');
  }
  if (p.type === 'toolCall') {
    if (typeof p.id === 'string') p.id = boundStringField(p.id, 'tool-call id');
    if (typeof p.name === 'string') p.name = boundStringField(p.name, 'tool-call name');
    if (p.arguments !== undefined) {
      p.arguments = boundUnknownPayload(p.arguments, 'tool-call arguments');
    }
    boundRecordFields(
      p,
      'tool-call content',
      new Set([...CONTENT_PART_IDENTITY_KEYS, 'arguments'])
    );
    return enforceNonAuthoritativeItemBudget(p, 'tool-call content');
  }
  if (p.type === 'image') {
    if (typeof p.data === 'string') p.data = boundStringField(p.data, 'image data');
    if (typeof p.base64 === 'string') p.base64 = boundStringField(p.base64, 'image base64');
    boundRecordFields(
      p,
      'image content',
      new Set([...CONTENT_PART_IDENTITY_KEYS, 'data', 'base64'])
    );
    return enforceNonAuthoritativeItemBudget(p, 'image content');
  }
  // Unknown / custom content variants: bound every non-identity field, then the item.
  boundRecordFields(p, 'assistant content');
  return enforceNonAuthoritativeItemBudget(p, 'assistant content');
}

function boundNonAuthoritativeContentPart(part: unknown, role: string): unknown {
  if (!part || typeof part !== 'object') return part;
  const p = part as Record<string, unknown>;
  if (typeof p.text === 'string') p.text = boundStringField(p.text, `${role} text`);
  if (typeof p.data === 'string') p.data = boundStringField(p.data, `${role} data`);
  if (typeof p.base64 === 'string') p.base64 = boundStringField(p.base64, `${role} base64`);
  boundRecordFields(
    p,
    `${role} content`,
    new Set([...CONTENT_PART_IDENTITY_KEYS, 'text', 'data', 'base64'])
  );
  return enforceNonAuthoritativeItemBudget(p, `${role} content`);
}

/**
 * Project a native message for in-memory Agent View retention.
 * Clones first so the native session/event object remains raw and untouched.
 * Authoritative assistant text is preserved; non-authoritative payloads are bounded.
 */
function projectFinalizedMessage(msg: AgentMessage): AgentMessage {
  const projected = structuredClone(msg) as AgentMessage & Record<string, unknown>;
  const role = (projected as { role?: string }).role;
  if (role === 'assistant') {
    const content = (projected as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        content[i] = boundAssistantContentPart(content[i]);
      }
    }
    // Only role/content/usage/model/stopReason are authoritative; all other top-level
    // extras (errorMessage, responseId, api, provider, timestamp, custom…) are bounded
    // as complete non-authoritative items.
    const assistantRec = projected as Record<string, unknown>;
    for (const key of Object.keys(assistantRec)) {
      if (ASSISTANT_AUTHORITATIVE_TOP_KEYS.has(key)) continue;
      const val = assistantRec[key];
      if (typeof val === 'string') {
        assistantRec[key] = boundStringField(val, `assistant ${key}`);
      } else if (val !== null && typeof val === 'object') {
        assistantRec[key] = enforceNonAuthoritativeItemBudget(
          structuredClone(val),
          `assistant ${key}`
        );
      } else {
        assistantRec[key] = enforceNonAuthoritativeItemBudget(val, `assistant ${key}`);
      }
      // Drop extras that still cannot fit a complete-item budget after bounding.
      if (
        typeof assistantRec[key] === 'object' &&
        assistantRec[key] !== null &&
        utf8JsonBytes(assistantRec[key]) > INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
      ) {
        delete assistantRec[key];
      } else if (
        typeof assistantRec[key] === 'string' &&
        Buffer.byteLength(assistantRec[key] as string, 'utf8') >
          INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
      ) {
        delete assistantRec[key];
      }
    }
  } else if (role === 'toolResult' || role === 'user' || role === 'custom') {
    const content = (projected as { content?: unknown }).content;
    if (typeof content === 'string') {
      (projected as { content: string }).content = boundStringField(content, `${role} content`);
    } else if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        content[i] = boundNonAuthoritativeContentPart(content[i], role);
      }
    }
    if ((projected as { details?: unknown }).details !== undefined) {
      (projected as { details: unknown }).details = boundUnknownPayload(
        (projected as { details: unknown }).details,
        `${role} details`
      );
    }
    // Display/identity scalars are non-authoritative and must not bypass the item budget.
    const rec = projected as Record<string, unknown>;
    for (const key of ['toolCallId', 'toolName', 'customType'] as const) {
      const val = rec[key];
      if (typeof val === 'string') {
        rec[key] = boundStringField(val, `${role} ${key}`);
      } else if (val !== undefined && val !== null && typeof val === 'object') {
        rec[key] = enforceNonAuthoritativeItemBudget(structuredClone(val), `${role} ${key}`);
      } else if (val !== undefined && typeof val !== 'number' && typeof val !== 'boolean') {
        rec[key] = enforceNonAuthoritativeItemBudget(val, `${role} ${key}`);
      }
    }
    const ts = rec.timestamp;
    if (typeof ts === 'string') {
      rec.timestamp = boundStringField(ts, `${role} timestamp`);
    } else if (ts !== undefined && ts !== null && typeof ts === 'object') {
      rec.timestamp = enforceNonAuthoritativeItemBudget(structuredClone(ts), `${role} timestamp`);
    } else if (ts !== undefined && typeof ts !== 'number' && typeof ts !== 'boolean') {
      rec.timestamp = enforceNonAuthoritativeItemBudget(ts, `${role} timestamp`);
    }
    // Bound other top-level non-identity payload fields (custom message bodies, etc.).
    // Identity keys above are already budgeted; preserve them from double-processing.
    const preserveTop = new Set([
      'role',
      'content',
      'details',
      'toolCallId',
      'toolName',
      'isError',
      'timestamp',
      'customType',
    ]);
    boundRecordFields(projected as Record<string, unknown>, role, preserveTop);
  } else {
    // bashExecution and every other/unknown role: complete-item bound all payloads.
    // Especially large non-authoritative fields like bashExecution.output.
    const label = typeof role === 'string' && role.length > 0 ? role : 'message';
    const rec = projected as Record<string, unknown>;
    if (typeof rec.output === 'string') {
      rec.output = boundStringField(rec.output, `${label} output`);
    } else if (rec.output !== undefined) {
      rec.output = boundUnknownPayload(rec.output, `${label} output`);
    }
    const content = rec.content;
    if (typeof content === 'string') {
      rec.content = boundStringField(content, `${label} content`);
    } else if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        content[i] = boundNonAuthoritativeContentPart(content[i], label);
      }
    } else if (content !== undefined) {
      rec.content = boundUnknownPayload(content, `${label} content`);
    }
    if (rec.details !== undefined) {
      rec.details = boundUnknownPayload(rec.details, `${label} details`);
    }
    // Bound remaining top-level fields (command, exitCode strings, custom extras…).
    const preserveTop = new Set(['role', 'content', 'output', 'details']);
    boundRecordFields(rec, label, preserveTop);
    for (const key of Object.keys(rec)) {
      if (key === 'role') continue;
      const val = rec[key];
      if (val !== null && typeof val === 'object') {
        rec[key] = enforceNonAuthoritativeItemBudget(val, `${label} ${key}`);
      } else if (typeof val === 'string' && key !== 'content' && key !== 'output') {
        // Re-check complete-item budget for scalars not already bound above.
        if (Buffer.byteLength(val, 'utf8') > INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) {
          rec[key] = boundStringField(val, `${label} ${key}`);
        }
      }
    }
  }
  return projected;
}

/** Project a transient display payload (streaming message / live tool row). */
function projectTransientDisplayMessage(msg: AgentMessage): AgentMessage {
  return projectFinalizedMessage(msg);
}

function projectToolArgs(args: unknown): Record<string, unknown> {
  if (args === null || args === undefined) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    // Clone under-budget arrays/primitives into a private shell before freeze.
    const size = utf8JsonBytes(args);
    if (size <= INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) {
      const cloned = args !== null && typeof args === 'object' ? structuredClone(args) : args;
      return Array.isArray(cloned) || (cloned !== null && typeof cloned === 'object')
        ? { value: cloned }
        : { value: cloned };
    }
    const bounded = boundUnknownPayload(args, 'tool-call arguments');
    return typeof bounded === 'object' && bounded !== null && !Array.isArray(bounded)
      ? (bounded as Record<string, unknown>)
      : { value: bounded };
  }
  const size = utf8JsonBytes(args);
  if (size <= INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) {
    return structuredClone(args) as Record<string, unknown>;
  }
  return boundUnknownPayload(args, 'tool-call arguments') as Record<string, unknown>;
}

function projectToolPartialResult(value: unknown): unknown {
  if (value === undefined) return undefined;
  const size = utf8JsonBytes(value);
  if (size <= INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) {
    return value !== null && typeof value === 'object' ? structuredClone(value) : value;
  }
  return boundUnknownPayload(value, 'tool result');
}

/** Bound one queue display string as a complete non-authoritative item. */
function projectQueueEntry(value: unknown, label: string): string {
  if (typeof value === 'string') return boundStringField(value, label);
  if (value === null || value === undefined) return '';
  const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return boundStringField(serialized, label);
}

function projectQueueEntries(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, i) => projectQueueEntry(entry, `queue[${i}]`));
}

/** Max UTF-8 bytes retained as a raw activeTools Map key before hashing. */
const ACTIVE_TOOL_MAP_KEY_MAX_BYTES = 256;

/**
 * Deterministic bounded Map key for active tool rows. Huge toolCallIds are hashed
 * so the Map never retains an unbounded key string; short IDs pass through.
 */
function activeToolMapKey(toolCallId: string): string {
  if (Buffer.byteLength(toolCallId, 'utf8') <= ACTIVE_TOOL_MAP_KEY_MAX_BYTES) {
    return toolCallId;
  }
  return crypto.createHash('sha256').update(toolCallId, 'utf8').digest('hex');
}

/**
 * Project a complete active-tool entry: bound id/name/args/result and freeze so
 * snapshot publication never shares mutable transport-owned nested objects.
 * Enforces an exact complete-entry serialized cap including all fields + JSON overhead.
 */
function projectActiveToolEntry(input: {
  toolCallId: unknown;
  toolName: unknown;
  args: unknown;
  partialResult?: unknown;
  isError?: boolean;
  ended?: boolean;
}): InteractiveToolActivity {
  // Bound identity first so nested field budgets have room inside the complete entry.
  let toolCallId = boundStringField(String(input.toolCallId ?? ''), 'toolCallId');
  let toolName = boundStringField(String(input.toolName ?? 'tool'), 'toolName');
  let args = projectToolArgs(input.args);
  let partialResult =
    input.partialResult !== undefined ? projectToolPartialResult(input.partialResult) : undefined;

  const build = (): InteractiveToolActivity => {
    const entry: InteractiveToolActivity = { toolCallId, toolName, args };
    if (partialResult !== undefined) entry.partialResult = partialResult;
    if (input.isError !== undefined) entry.isError = Boolean(input.isError);
    if (input.ended !== undefined) entry.ended = Boolean(input.ended);
    return entry;
  };

  let entry = build();
  // Deterministically shrink until the entire serialized entry fits the cap.
  // Order: omit partialResult → bound oversized identity → omit args → drop
  // partialResult → minimal args → further identity shrink. Identity is bounded
  // before args are dropped so small nested payloads survive when only id/name
  // made the complete entry exceed the budget.
  if (utf8JsonBytes(entry) > INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) {
    if (partialResult !== undefined) {
      partialResult = omitPayloadMarker(partialResult, 'tool result');
      entry = build();
    }
  }
  if (utf8JsonBytes(entry) > INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) {
    toolCallId = boundStringToBudget(toolCallId, 'toolCallId', 256);
    toolName = boundStringToBudget(toolName, 'toolName', 256);
    entry = build();
  }
  if (utf8JsonBytes(entry) > INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) {
    args = omitPayloadMarker(args, 'tool-call arguments');
    entry = build();
  }
  if (utf8JsonBytes(entry) > INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) {
    partialResult = undefined;
    entry = build();
  }
  if (utf8JsonBytes(entry) > INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) {
    args = { _omitted: true, message: 'exceeded interactive budget' };
    entry = build();
  }
  // Last resort: shrink identity until the complete entry fits (always terminates).
  while (utf8JsonBytes(entry) > INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES) {
    const idBytes = Buffer.byteLength(toolCallId, 'utf8');
    const nameBytes = Buffer.byteLength(toolName, 'utf8');
    if (idBytes > 1) {
      toolCallId = truncateUtf8(toolCallId, Math.max(1, idBytes >> 1));
    } else if (nameBytes > 1) {
      toolName = truncateUtf8(toolName, Math.max(1, nameBytes >> 1));
    } else {
      entry = { toolCallId: '', toolName: '', args: {} };
      if (input.isError !== undefined) entry.isError = Boolean(input.isError);
      if (input.ended !== undefined) entry.ended = Boolean(input.ended);
      break;
    }
    entry = build();
  }
  return freezeDeep(entry);
}

/** Clone+freeze an active-tool row for public snapshot isolation. */
function isolateActiveToolForSnapshot(t: InteractiveToolActivity): InteractiveToolActivity {
  return projectActiveToolEntry({
    toolCallId: t.toolCallId,
    toolName: t.toolName,
    args: t.args,
    partialResult: t.partialResult,
    isError: t.isError,
    ended: t.ended,
  });
}

/** Exact UTF-8 JSON-array size including brackets and commas. */
function finalizedTranscriptArrayBytes(messageBytes: number[]): number {
  const n = messageBytes.length;
  return 2 + messageBytes.reduce((a, b) => a + b, 0) + Math.max(0, n - 1);
}

function recomputeFinalizedBytes(ep: InteractiveAgentEndpoint): void {
  ep.finalizedMessageBytes = ep.finalizedMessagesView.map((m) => utf8JsonBytes(m));
  ep.finalizedMessagesBytes = (ep.finalizedMessageBytes ?? []).reduce((a, b) => a + b, 0);
}

/**
 * Isolate one message for the shared finalized view: project, clone, freeze, mark owned.
 * Call only on message_end / hydrate / restore — never per delta.
 * Externally frozen native messages are reprojected; only module-owned messages are reused.
 */
function isolateFinalizedMessage(msg: AgentMessage): AgentMessage {
  if (isProjectedMessage(msg)) return msg;
  return markProjectedMessage(freezeDeep(projectFinalizedMessage(msg)));
}

/** Build a frozen readonly array of isolated finalized messages. */
function isolateFinalizedMessages(messages: readonly AgentMessage[]): readonly AgentMessage[] {
  if (messages.length === 0) return EMPTY_FINALIZED;
  return Object.freeze(messages.map((m) => isolateFinalizedMessage(m)));
}

/**
 * Replace the stable finalized-messages view (message_end / hydrate / restore).
 * Transcript-only publishes reuse the previous view without allocating.
 */
function replaceFinalizedMessages(
  ep: InteractiveAgentEndpoint,
  messages: readonly AgentMessage[]
): void {
  const view = isolateFinalizedMessages(messages);
  ep.messages = view;
  ep.finalizedMessagesView = view;
  ep.messagesRevision += 1;
  recomputeFinalizedBytes(ep);
}

/** Append one finalized message (project+clone+freeze once) and publish a new readonly array. */
function appendFinalizedMessage(ep: InteractiveAgentEndpoint, msg: AgentMessage): void {
  const frozen = isolateFinalizedMessage(msg);
  const bytes = utf8JsonBytes(frozen);
  const view = Object.freeze([...ep.finalizedMessagesView, frozen]);
  ep.messages = view;
  ep.finalizedMessagesView = view;
  ep.messagesRevision += 1;
  ep.finalizedMessageBytes = [...(ep.finalizedMessageBytes ?? []), bytes];
  ep.finalizedMessagesBytes = (ep.finalizedMessagesBytes ?? 0) + bytes;
}

/** Drop in-memory transcript after settled subscribers have observed it. */
function evictFinalizedTranscript(ep: InteractiveAgentEndpoint): void {
  ep.messages = EMPTY_FINALIZED;
  ep.finalizedMessagesView = EMPTY_FINALIZED;
  ep.finalizedMessageBytes = [];
  ep.finalizedMessagesBytes = 0;
  ep.messagesRevision += 1;
  ep.streamingMessage = undefined;
  ep.activeTools = new Map();
  ep.streamRevision += 1;
  ep.transcriptHydrated = false;
}

function endpointHasReloadableIdentity(ep: InteractiveAgentEndpoint): boolean {
  if (ep.sessionFile && ep.sessionFile.trim() !== '') return true;
  const art = ep.sessionArtifact;
  if (!art) return false;
  if (art.runtime === 'pi' && art.sessionFile.trim() !== '') return true;
  if (art.runtime === 'grok-acp' && art.sessionId.trim() !== '') return true;
  return false;
}

/**
 * After a settled full publish + activation_settled emission, schedule deferred
 * idle retention work so settled consumers observe the complete pre-eviction snapshot.
 * Success, error, and cancellation all share this path.
 *
 * Cleanup is activation/epoch-scoped and runs only inside the endpoint transition
 * queue. A newer activation (or any epoch bump) makes a stale schedule no-op.
 */
function maybeScheduleIdleTranscriptEviction(
  ep: InteractiveAgentEndpoint,
  epoch: number,
  enqueue: (key: string, fn: () => void | Promise<void>) => Promise<unknown>,
  resolve: (key: string) => InteractiveAgentEndpoint | undefined,
  getEpoch: (key: string) => number,
  detachFn: (
    key: string,
    opts?: { evictTranscript?: boolean; retentionEpoch?: number }
  ) => Promise<void>,
  publishFn: (ep: InteractiveAgentEndpoint, kind?: InteractiveEndpointUpdateKind) => void
): void {
  if (ep.status === 'starting' || ep.status === 'running') return;
  if (ep.activation && !ep.activation.settled) return;
  const total = finalizedTranscriptArrayBytes(ep.finalizedMessageBytes ?? []);
  if (total <= INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES) return;
  const key = ep.key;
  // Defer so activation_settled consumers observe the pre-eviction snapshot first.
  // Then serialize through the endpoint transition queue and revalidate epoch.
  queueMicrotask(() => {
    void enqueue(key, () => {
      if (getEpoch(key) !== epoch) return;
      const current = resolve(key);
      if (!current) return;
      if (current.status === 'starting' || current.status === 'running') return;
      if (current.activation && !current.activation.settled) return;
      const still = finalizedTranscriptArrayBytes(current.finalizedMessageBytes ?? []);
      if (still <= INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES) return;
      if (endpointHasReloadableIdentity(current)) {
        // Pass epoch into detach so a later chained detach transition cannot
        // force-settle a newer activation that starts after this check.
        void detachFn(key, { evictTranscript: true, retentionEpoch: epoch }).catch(() => undefined);
        return;
      }
      if (compactNonReloadableTranscript(current)) {
        publishFn(current, 'full');
      }
    }).catch(() => undefined);
  });
}

/**
 * Replace oldest entries with role-preserving omission markers; keep latest assistant.
 * Returns true when the view changed.
 */
function compactNonReloadableTranscript(ep: InteractiveAgentEndpoint): boolean {
  const msgs = [...ep.finalizedMessagesView];
  if (msgs.length === 0) return false;
  let latestAssistantIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if ((msgs[i] as { role?: string }).role === 'assistant') {
      latestAssistantIdx = i;
      break;
    }
  }
  const marker = (role: string) =>
    markProjectedMessage(
      freezeDeep({
        role,
        content: [
          {
            type: 'text',
            text: '[Earlier history omitted: non-reloadable endpoint exceeded retention budget]',
          },
        ],
      }) as AgentMessage
    );
  let changed = false;
  for (let i = 0; i < msgs.length; i++) {
    if (i === latestAssistantIdx) continue;
    const role = ((msgs[i] as { role?: string }).role ?? 'user') as string;
    const next = marker(role);
    if (msgs[i] !== next) {
      msgs[i] = next;
      changed = true;
    }
  }
  if (!changed) return false;
  const view = Object.freeze(msgs);
  ep.messages = view;
  ep.finalizedMessagesView = view;
  ep.messagesRevision += 1;
  recomputeFinalizedBytes(ep);
  ep.transcriptHydrated = true;
  return true;
}

/** Isolate session identity so public consumers cannot mutate endpoint state. */
function isolateSessionArtifact(
  art: InteractiveSessionArtifact | undefined
): InteractiveSessionArtifact | undefined {
  if (!art) return undefined;
  return freezeDeep(structuredClone(art));
}

/** Isolate activation (incl. nested policy) for public snapshot publication. */
function isolateActivation(activation: InteractiveActivation): InteractiveActivation {
  return freezeDeep({
    ...activation,
    policy: activation.policy ? { ...activation.policy } : undefined,
  });
}

/** Isolate usage aggregate for public snapshot/list publication. */
function isolateUsage(usage: InteractiveAgentEndpoint['usage']): InteractiveAgentEndpoint['usage'] {
  if (!usage) return undefined;
  return freezeDeep({ ...usage });
}

/**
 * Build a read-only endpoint snapshot with structure sharing.
 * Finalized messages use the stable view (no slice on transcript publishes).
 * Streaming and active-tool payloads are projected/bounded before retention.
 * Nested metadata (sessionArtifact, activation.policy, usage) is cloned/frozen
 * so consumer mutation cannot alter endpoint identity or later snapshots.
 */
function snapshotOf(ep: InteractiveAgentEndpoint): InteractiveEndpointSnapshot {
  // Isolate transient nested payloads: never share mutable transport-owned objects.
  // Finalized messages are already module-owned frozen views (structure-shared).
  return {
    key: ep.key,
    hostSessionId: ep.hostSessionId,
    runId: ep.runId,
    unitId: ep.unitId,
    bindingId: ep.bindingId,
    agent: ep.agent,
    title: ep.title,
    sessionFile: ep.sessionFile,
    sessionArtifact: isolateSessionArtifact(ep.sessionArtifact),
    effectiveCwd: ep.effectiveCwd,
    worktreePath: ep.worktreePath,
    status: ep.status,
    messages: ep.finalizedMessagesView,
    messagesRevision: ep.messagesRevision,
    streamRevision: ep.streamRevision,
    streamingMessage: ep.streamingMessage
      ? freezeDeep(structuredClone(ep.streamingMessage))
      : undefined,
    activeTools: [...ep.activeTools.values()].map(isolateActiveToolForSnapshot),
    steeringQueue: projectQueueEntries(ep.steeringQueue),
    followUpQueue: projectQueueEntries(ep.followUpQueue),
    activation: ep.activation ? isolateActivation(ep.activation) : undefined,
    lastError: ep.lastError,
    errorCode: ep.errorCode,
    lastUsedAt: ep.lastUsedAt,
    createdAt: ep.createdAt,
    linkCreatedAt: ep.linkCreatedAt,
    usage: isolateUsage(ep.usage),
    isCompacting: ep.isCompacting,
    isRetrying: ep.isRetrying,
    hasTransport: !!ep.client,
    queueCount: ep.steeringQueue.length + ep.followUpQueue.length,
  };
}

function listItemOf(ep: InteractiveAgentEndpoint): InteractiveEndpointListItem {
  return {
    key: ep.key,
    hostSessionId: ep.hostSessionId,
    runId: ep.runId,
    unitId: ep.unitId,
    bindingId: ep.bindingId,
    agent: ep.agent,
    title: ep.title,
    sessionFile: ep.sessionFile,
    sessionArtifact: isolateSessionArtifact(ep.sessionArtifact),
    effectiveCwd: ep.effectiveCwd,
    worktreePath: ep.worktreePath,
    status: ep.status,
    lastError: ep.lastError,
    errorCode: ep.errorCode,
    lastUsedAt: ep.lastUsedAt,
    createdAt: ep.createdAt,
    linkCreatedAt: ep.linkCreatedAt,
    usage: isolateUsage(ep.usage),
    isCompacting: ep.isCompacting,
    isRetrying: ep.isRetrying,
    hasTransport: !!ep.client,
    queueCount: ep.steeringQueue.length + ep.followUpQueue.length,
    hasActivation: !!ep.activation,
  };
}

/** Default bound after live abort before activation-scoped force-detach. */
const DEFAULT_ABORT_SETTLE_TIMEOUT_MS = 10_000;
/** Default wait for real agent_settled when preflight observes idle child. */
const DEFAULT_IDLE_SETTLE_WAIT_MS = 10_000;

/**
 * Session lease implementation lives in session-lease.ts and is re-exported above
 * for compatibility with existing tests and call sites.
 */

/**
 * Per-transport release for the lease acquired by that spawn. WeakMap so a disposed
 * transport does not pin the release closure forever. Module-local is fine: transports
 * are never shared across Jiti reloads.
 */
const transportLeaseReleases = new WeakMap<object, (err?: Error) => void>();

/**
 * Global per-transport dispose promise: shutdown, hydrate, register, and execution
 * callers share one dispose() invocation even when multiple layers race disposeTracked.
 */
const transportDisposePromises = new WeakMap<object, Promise<void>>();

/** @deprecated Use awaitSessionLease — kept as the dispose-barrier alias for call sites. */
async function awaitSessionFileDispose(sessionFile: string): Promise<void> {
  await awaitSessionLease(sessionFile);
}

export function createInteractiveAgentRegistry(options: InteractiveRegistryOptions) {
  const endpoints = new Map<string, InteractiveAgentEndpoint>();
  const sessionOwners = new Map<string, string>(); // resolved session path -> endpoint key
  /**
   * UI tree claim: keys currently listed on the active host-session branch
   * (including unavailable/forged claims). Not sufficient for relay trust.
   */
  const treeClaimKeys = new Set<string>();
  /**
   * Relay-trusted active-branch membership: endpoint key → bindingId that
   * passed resolveTrusted. Forged/untrusted links never enter this map.
   */
  const trustedBranchBindings = new Map<string, string>();
  const listeners = new Set<(event: InteractiveRegistryEvent) => void>();
  const transitionQueues = new Map<string, Promise<void>>();
  /** Serializes RPC writes (prompt/steer/follow_up) per endpoint so order is preserved. */
  const outboundQueues = new Map<string, Promise<void>>();
  /**
   * Fail-closed poison for outbound writes: once a write fails for an activation,
   * later concurrent steer/follow-up for the same activation must not write.
   * Cleared when a new activation id is prepared.
   */
  const outboundPoisonByKey = new Map<string, { activationId: string; error: unknown }>();
  /** Pending activation-scoped abort settle timers (key -> timer id). */
  const abortSettleTimers = new Map<string, unknown>();
  /**
   * Reject in-flight spawn/handshake waiters when generation is invalidated so
   * aborted getState cannot block the outbound queue forever.
   */
  const spawnCancelByKey = new Map<string, { generation: number; reject: (err: Error) => void }>();
  /**
   * Per-endpoint disposal barrier: spawn/reopen must wait until prior transports
   * fully dispose so the same sessionFile has a single writer.
   */
  const disposeBarriers = new Map<string, Promise<void>>();
  /**
   * While shutdown runs, transports disposed via disposeSpawned (handshake cancel)
   * are recorded here so a deadline timeout can sticky-fail their leases.
   */
  let shutdownTransportBag: Array<PiRpcTransport | InteractiveAgentTransport> | undefined;
  /**
   * Unified pending-owner tracking for every registry-internal pre-acquired
   * lease/transport (hydrate-only, registerGrokAcpLive, spawn/reopen). Entry
   * registers owner token + release immediately; transport bind follows factory
   * return; clean dispose / handoff removes the entry. Shutdown dynamically
   * drains pending owners; deadline sticky-settles any still open so a late
   * clean dispose cannot clear fail-closed session identity.
   */
  const pendingOwners = new Map<
    string,
    {
      ownerId: string;
      key?: string;
      generation?: number;
      release: (err?: Error) => void;
      transport?: PiRpcTransport | InteractiveAgentTransport;
    }
  >();
  /**
   * Per-key registration generation + serial chain. Entry reserves generation
   * synchronously; only the latest generation may insert endpoint/trust/attach
   * after awaits. Concurrent losers fail closed and never overwrite a live owner.
   */
  const registrationGeneration = new Map<string, number>();
  const registrationSerial = new Map<string, Promise<void>>();
  type RegistrationHandle = { key: string; generation: number; leave: () => void };
  const idleLimit = options.idleLimit ?? MAX_IDLE_TRANSPORTS;
  /** Bumped on every new activation so deferred idle retention cannot touch a newer turn. */
  const idleRetentionEpoch = new Map<string, number>();
  const bumpIdleRetentionEpoch = (key: string): number => {
    const next = (idleRetentionEpoch.get(key) ?? 0) + 1;
    idleRetentionEpoch.set(key, next);
    return next;
  };
  const getIdleRetentionEpoch = (key: string): number => idleRetentionEpoch.get(key) ?? 0;
  const scheduleIdleTranscriptEviction = (ep: InteractiveAgentEndpoint): void => {
    maybeScheduleIdleTranscriptEviction(
      ep,
      getIdleRetentionEpoch(ep.key),
      enqueueTransition,
      (key) => endpoints.get(key),
      getIdleRetentionEpoch,
      detach,
      publish
    );
  };
  const abortSettleTimeoutMs = options.abortSettleTimeoutMs ?? DEFAULT_ABORT_SETTLE_TIMEOUT_MS;
  /** Unified absolute budget for the whole shutdown path (not N × killTimeout). */
  const shutdownDisposeBudgetMs = options.shutdownDisposeBudgetMs ?? 5_500;
  const idleSettleWaitMs = options.idleSettleWaitMs ?? DEFAULT_IDLE_SETTLE_WAIT_MS;
  const timers = options.timers ?? {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };

  /**
   * Chain a dispose promise onto the endpoint barrier (serial per key).
   * Dispose failures reject the barrier and stay fail-closed so a same-session
   * replacement spawn cannot start while the prior writer may still be alive.
   */
  function noteDispose(key: string, work: Promise<unknown>): Promise<void> {
    const prev = disposeBarriers.get(key) ?? Promise.resolve();
    const next = prev.then(
      () => work.then(() => undefined),
      async (firstErr) => {
        // Prior dispose already failed: still attempt cleanup, then rethrow.
        try {
          await work;
        } catch {
          /* secondary dispose error does not mask the first failure */
        }
        throw firstErr;
      }
    );
    disposeBarriers.set(key, next);
    void next.then(
      () => {
        if (disposeBarriers.get(key) === next) disposeBarriers.delete(key);
      },
      () => {
        // Keep the rejected promise in the map so later awaitDisposeBarrier fails closed.
      }
    );
    return next;
  }

  async function awaitDisposeBarrier(key: string): Promise<void> {
    const pending = disposeBarriers.get(key);
    if (pending) await pending;
  }

  /**
   * Register a pre-acquired lease (and optional transport) as a pending owner.
   * Must be called at the acquisition site before any await that can race shutdown.
   */
  function beginPendingOwner(opts: {
    key?: string;
    generation?: number;
    release: (err?: Error) => void;
    transport?: PiRpcTransport | InteractiveAgentTransport;
  }): {
    ownerId: string;
    release: (err?: Error) => void;
    bindTransport: (transport: PiRpcTransport | InteractiveAgentTransport) => void;
    /** Drop pending entry once long-lived path (ep.client) or settle owns the lease. */
    complete: () => void;
  } {
    const ownerId = crypto.randomBytes(8).toString('hex');
    let settled = false;
    const wrappedRelease = (err?: Error): void => {
      if (settled) return;
      settled = true;
      pendingOwners.delete(ownerId);
      opts.release(err);
    };
    const entry: {
      ownerId: string;
      key?: string;
      generation?: number;
      release: (err?: Error) => void;
      transport?: PiRpcTransport | InteractiveAgentTransport;
    } = {
      ownerId,
      key: opts.key,
      generation: opts.generation,
      release: wrappedRelease,
      transport: opts.transport,
    };
    pendingOwners.set(ownerId, entry);
    if (opts.transport) {
      transportLeaseReleases.set(opts.transport, wrappedRelease);
    }
    return {
      ownerId,
      release: wrappedRelease,
      bindTransport(transport) {
        entry.transport = transport;
        transportLeaseReleases.set(transport, wrappedRelease);
      },
      complete() {
        // Leave transportLeaseReleases bound; only drop the pending map entry.
        pendingOwners.delete(ownerId);
      },
    };
  }

  async function createGrokAcpTransport(
    factoryOpts: import('./grok-acp-interactive-transport.ts').GrokAcpInteractiveTransportOptions
  ): Promise<InteractiveAgentTransport> {
    if (options.grokAcpTransportFactory) {
      return options.grokAcpTransportFactory(factoryOpts);
    }
    const { createGrokAcpInteractiveTransport } =
      await import('./grok-acp-interactive-transport.ts');
    return createGrokAcpInteractiveTransport(factoryOpts);
  }

  /**
   * Dispose a transport and track it on the per-endpoint barrier.
   * Session lease release is bound to the transport at spawn time (WeakMap);
   * dispose settles that lease (success or sticky fail-closed).
   * Per-transport WeakMap caches a single dispose promise so concurrent
   * shutdown/hydrate/register/execution callers never call dispose() twice.
   */
  function disposeTracked(
    key: string,
    transport: PiRpcTransport | InteractiveAgentTransport,
    _sessionFile?: string
  ): Promise<void> {
    let work = transportDisposePromises.get(transport);
    if (!work) {
      work = Promise.resolve()
        .then(() => transport.dispose())
        .then(
          () => {
            const rel = transportLeaseReleases.get(transport);
            if (rel) {
              transportLeaseReleases.delete(transport);
              rel();
            }
          },
          (err) => {
            const rel = transportLeaseReleases.get(transport);
            if (rel) {
              transportLeaseReleases.delete(transport);
              rel(err instanceof Error ? err : new Error(String(err)));
            }
            throw err;
          }
        );
      transportDisposePromises.set(transport, work);
    }
    return noteDispose(key, work);
  }

  /**
   * Reserve a per-key registration generation synchronously, then wait for the
   * previous registration on that key to leave. After the wait, only the latest
   * generation remains current — earlier reservations fail closed.
   */
  async function acquireRegistration(key: string): Promise<RegistrationHandle> {
    const generation = (registrationGeneration.get(key) ?? 0) + 1;
    registrationGeneration.set(key, generation);

    const prev = registrationSerial.get(key) ?? Promise.resolve();
    let leave!: () => void;
    const done = new Promise<void>((resolve) => {
      leave = resolve;
    });
    registrationSerial.set(
      key,
      prev.then(
        () => done,
        () => done
      )
    );

    try {
      await prev;
    } catch {
      /* prior registration failure does not block the next */
    }

    if (shutDown) {
      leave();
      throw new InteractiveAgentError('shutdown', 'Interactive registry is shut down');
    }
    if (registrationGeneration.get(key) !== generation) {
      leave();
      throw new InteractiveAgentError(
        'session_busy',
        `Registration for ${key} superseded by a newer attempt`
      );
    }
    return { key, generation, leave };
  }

  /** Fail closed when this registration generation is no longer current or shutdown began. */
  function assertRegistration(handle: RegistrationHandle): void {
    if (shutDown) {
      throw new InteractiveAgentError('shutdown', 'Interactive registry is shut down');
    }
    if (registrationGeneration.get(handle.key) !== handle.generation) {
      throw new InteractiveAgentError(
        'session_busy',
        `Registration for ${handle.key} superseded by a newer attempt`
      );
    }
  }

  /** Build the process-global lease key for an endpoint (Pi path or Grok ACP identity). */
  function endpointLeaseKey(ep: InteractiveAgentEndpoint): string {
    const artifact =
      ep.sessionArtifact ??
      (ep.sessionFile
        ? ({ runtime: 'pi' as const, sessionFile: ep.sessionFile } as const)
        : undefined);
    if (artifact?.runtime === 'grok-acp') {
      return buildSessionLeaseKey({
        runtime: 'grok-acp',
        cwd: ep.worktreePath ?? ep.effectiveCwd,
        sessionIdentity: artifact.sessionId,
      });
    }
    return ep.sessionFile || '';
  }

  /** Await endpoint dispose barrier + process-scoped session lease before spawn. */
  async function awaitSpawnDisposeBarriers(
    key: string,
    leaseKeyOrSessionFile: string
  ): Promise<void> {
    await awaitDisposeBarrier(key);
    await awaitSessionLease(leaseKeyOrSessionFile);
  }

  /**
   * Track dispose of a transport that resolves from a ready promise.
   * Lease was acquired inside spawnTransport; disposeTracked releases it.
   * Spawn rejection without a transport releases the lease in spawnTransport.
   */
  function noteReadyDispose(
    key: string,
    _sessionFile: string,
    ready: Promise<PiRpcTransport | InteractiveAgentTransport>
  ): Promise<void> {
    return noteDispose(
      key,
      ready.then(
        (transport) => disposeTracked(key, transport),
        () => undefined
      )
    );
  }
  const now = options.clock ?? (() => Date.now());
  const discover = options.discoverAgentsFn ?? discoverAgents;
  let shutDown = false;
  /** Single cached shutdown promise — success and rejection are both reused. */
  let shutdownPromise: Promise<void> | undefined;
  let sequenceCounter = 0;
  /** Host-session link writer installed by the extension entrypoint. */
  let hostLinkAppender: ((link: InteractiveAgentLinkV1) => void) | undefined;

  function setHostLinkAppender(fn: ((link: InteractiveAgentLinkV1) => void) | undefined): void {
    hostLinkAppender = fn;
  }

  function appendHostLink(link: InteractiveAgentLinkV1): void {
    if (!hostLinkAppender) {
      throw new InteractiveAgentError('validation_error', 'Host link appender is not configured');
    }
    hostLinkAppender(link);
  }

  function emit(event: InteractiveRegistryEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        /* ignore */
      }
    }
  }

  function publish(
    ep: InteractiveAgentEndpoint,
    kind: InteractiveEndpointUpdateKind = 'full'
  ): InteractiveEndpointSnapshot {
    const snap = snapshotOf(ep);
    emit({ type: 'endpoint_updated', key: ep.key, snapshot: snap, kind });
    return snap;
  }

  function enqueueTransition<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = transitionQueues.get(key) ?? Promise.resolve();
    const next = prev.then(
      () => fn(),
      () => fn()
    );
    const tracked = next.then(
      () => undefined,
      () => undefined
    );
    transitionQueues.set(key, tracked);
    // Drop map entry when this generation of the chain completes so a blocked
    // transition does not retain the key forever (and subsequent coalesced
    // flushes do not pile onto a permanently retained head).
    void tracked.then(() => {
      if (transitionQueues.get(key) === tracked) transitionQueues.delete(key);
    });
    return next;
  }

  /**
   * Serial outbound RPC writes per endpoint. Same-activation failures poison the
   * chain so concurrent steer/follow-up cannot write after a failed prompt; a new
   * activation id clears the poison (retry on reopen is allowed).
   */
  function enqueueOutbound<T>(
    key: string,
    activationId: string,
    fn: () => Promise<T> | T
  ): Promise<T> {
    const prev = outboundQueues.get(key) ?? Promise.resolve();
    const run = async (): Promise<T> => {
      const poison = outboundPoisonByKey.get(key);
      if (poison && poison.activationId === activationId) {
        throw poison.error instanceof Error
          ? poison.error
          : new InteractiveAgentError('transport_error', String(poison.error));
      }
      // A newer activation must not be blocked by an older poison entry.
      if (poison && poison.activationId !== activationId) {
        outboundPoisonByKey.delete(key);
      }
      try {
        return await fn();
      } catch (err) {
        outboundPoisonByKey.set(key, { activationId, error: err });
        throw err;
      }
    };
    // Fail-closed: do not continue the chain after a prior rejection for this key
    // unless the poison was cleared by a new activation (checked inside run).
    const next = prev.then(run, run);
    const tracked = next.then(
      () => undefined,
      () => undefined
    );
    outboundQueues.set(key, tracked);
    void tracked.then(() => {
      if (outboundQueues.get(key) === tracked) outboundQueues.delete(key);
    });
    return next;
  }

  function clearAbortSettleTimer(key: string): void {
    const id = abortSettleTimers.get(key);
    if (id !== undefined) {
      timers.clearTimeout(id);
      abortSettleTimers.delete(key);
    }
  }

  /** Arm activation-scoped force-detach if agent_settled never arrives after abort. */
  function armAbortSettleTimeout(key: string, activationId: string): void {
    clearAbortSettleTimer(key);
    const timer = timers.setTimeout(() => {
      abortSettleTimers.delete(key);
      void detach(key, { activationId }).catch(() => undefined);
    }, abortSettleTimeoutMs);
    abortSettleTimers.set(key, timer);
  }

  /** Reject any in-flight spawn waiter for this endpoint (generation-agnostic). */
  function rejectSpawnWaiter(key: string, err: Error): void {
    const waiter = spawnCancelByKey.get(key);
    if (!waiter) return;
    spawnCancelByKey.delete(key);
    try {
      waiter.reject(err);
    } catch {
      /* ignore */
    }
  }

  /**
   * Atomically invalidate a live/starting transport so late T1 handshake/events
   * cannot install or settle a later endpoint generation. Disposal is tracked on
   * the per-key barrier so a later spawn waits for process teardown.
   */
  function invalidateLiveTransport(ep: InteractiveAgentEndpoint, reason: string): void {
    ep.transportGeneration += 1;
    rejectSpawnWaiter(
      ep.key,
      new InteractiveAgentError('rejected', 'Transport generation superseded')
    );
    const ready = ep.transportReady;
    const sessionFile = ep.sessionFile;
    ep.transportReady = undefined;
    if (ready) {
      void noteReadyDispose(ep.key, sessionFile, ready);
    }
    if (ep.client) {
      const client = ep.client;
      ep.client = undefined;
      void disposeTracked(ep.key, client, sessionFile);
    }
    clearAbortSettleTimer(ep.key);
    clearTransientActivity(ep);
    coalescedStreamEvents.delete(ep.key);
    streamCoalesceScheduled.delete(ep.key);
    coalesceCellSeq.delete(ep.key);
    outboundPoisonByKey.delete(ep.key);
    if (ep.activation && !ep.activation.settled) {
      // Terminal non-running status is established inside settleActivationError.
      settleActivationError(ep, reason, 'error');
    } else if (ep.activation) {
      ep.activation = undefined;
      if (ep.status === 'starting' || ep.status === 'running' || ep.status === 'registered') {
        ep.status = 'error';
        ep.lastError = reason;
        if (!ep.errorCode) ep.errorCode = 'transport_error';
      }
    }
  }

  /**
   * Latest-value coalesce for cumulative message_update / message_start.
   * Non-transcript boundary events seal the pre-boundary held delta so a later
   * update cannot be flushed before the boundary (U1 → boundary → U2).
   * Each coalesce cell has a generation id so a stale flush transition cannot
   * consume a post-boundary update.
   */
  const coalescedStreamEvents = new Map<string, { cell: number; event: unknown }>();
  /** key → cell id for which a flush transition is already queued */
  const streamCoalesceScheduled = new Map<string, number>();
  const coalesceCellSeq = new Map<string, number>();

  function scheduleCoalescedStreamFlush(key: string): void {
    const entry = coalescedStreamEvents.get(key);
    if (!entry) return;
    if (streamCoalesceScheduled.get(key) === entry.cell) return;
    streamCoalesceScheduled.set(key, entry.cell);
    const cell = entry.cell;
    void enqueueTransition(key, () => {
      if (streamCoalesceScheduled.get(key) === cell) {
        streamCoalesceScheduled.delete(key);
      }
      const held = coalescedStreamEvents.get(key);
      // Stale flush after seal, or a newer cell: do not consume.
      if (!held || held.cell !== cell) return;
      coalescedStreamEvents.delete(key);
      const ep = endpoints.get(key);
      if (!ep) return;
      reduceEvent(ep, held.event);
    });
  }

  /**
   * Seal the current coalesce cell: capture held event now, clear the cell so
   * post-boundary updates form a new cell, and return the sealed pre-boundary event.
   */
  function sealCoalescedStream(key: string): unknown | undefined {
    const held = coalescedStreamEvents.get(key);
    coalescedStreamEvents.delete(key);
    streamCoalesceScheduled.delete(key);
    return held?.event;
  }

  function holdCoalescedStream(key: string, event: unknown): void {
    const prev = coalescedStreamEvents.get(key);
    const cell = prev?.cell ?? (coalesceCellSeq.get(key) ?? 0) + 1;
    if (!prev) coalesceCellSeq.set(key, cell);
    coalescedStreamEvents.set(key, { cell, event });
    scheduleCoalescedStreamFlush(key);
  }

  /** Clear large transient UI state (tools, streaming, queues) and bump stream revision. */
  function clearTransientActivity(ep: InteractiveAgentEndpoint): void {
    const hadActivity =
      !!ep.streamingMessage ||
      ep.activeTools.size > 0 ||
      ep.steeringQueue.length > 0 ||
      ep.followUpQueue.length > 0;
    ep.streamingMessage = undefined;
    ep.activeTools.clear();
    ep.steeringQueue = [];
    ep.followUpQueue = [];
    if (hadActivity) ep.streamRevision += 1;
  }

  /**
   * True when the endpoint has a resolveTrusted-validated binding on the active
   * branch with an exact bindingId match. Distinct from UI tree claim and from
   * operable: a running off-branch unit is still operable for abort/status but
   * is not on the active branch (relay must not inject).
   */
  function isOnActiveBranch(key: string): boolean {
    const trustedBinding = trustedBranchBindings.get(key);
    if (trustedBinding === undefined) return false;
    const ep = endpoints.get(key);
    return !!ep && ep.bindingId === trustedBinding;
  }

  function isBranchVisible(ep: InteractiveAgentEndpoint): boolean {
    if (treeClaimKeys.has(ep.key) || isOnActiveBranch(ep.key)) return true;
    // Still-running units remain operable after a temporary tree navigation away.
    return ep.status === 'starting' || ep.status === 'running' || !!ep.activation;
  }

  function grantTrustedBranch(key: string, bindingId: string): void {
    treeClaimKeys.add(key);
    trustedBranchBindings.set(key, bindingId);
  }

  /** Revoke relay trust before settle so sync listeners never see old binding+active. */
  function revokeTrustedBranch(key: string): void {
    trustedBranchBindings.delete(key);
  }

  function visibleEndpoints(): InteractiveAgentEndpoint[] {
    return [...endpoints.values()]
      .filter(isBranchVisible)
      .sort((a, b) => a.linkCreatedAt - b.linkCreatedAt || a.createdAt - b.createdAt);
  }

  /**
   * Visible endpoint snapshots. Hydration is lazy: messages may be empty until
   * `ensureTranscript` / activation reopen loads the session transcript.
   * `get` is pure in-memory (no SessionManager.open). Prefer `listVisibleMeta`
   * for widget/list chrome (never touches transcript).
   */
  function listVisible(): InteractiveEndpointSnapshot[] {
    return visibleEndpoints().map(snapshotOf);
  }

  /** Metadata-only visible rows for widget/list (no message history). */
  function listVisibleMeta(): InteractiveEndpointListItem[] {
    return visibleEndpoints().map(listItemOf);
  }

  /**
   * Load session transcript into the endpoint once.
   * Awaits the process-scoped session lease/dispose barrier before any
   * SessionManager.open so detail/activate never baseline from a partial write.
   * Only sets `transcriptHydrated` after a successful hydrate or when in-memory
   * state is already authoritative (live transport / empty fresh register).
   * Temporary read/parse failures leave the flag false so the next ensure/activate
   * retries. When `required` is true (activate paths that need history), failure
   * throws before any activation is created.
   */
  async function ensureTranscriptHydrated(
    ep: InteractiveAgentEndpoint,
    opts: { required?: boolean } = {}
  ): Promise<void> {
    // Once the planned session file exists, drop the live-only missing grace —
    // even when the endpoint is already hydrated via a live transport.
    if (ep.allowPlannedMissingSession && ep.sessionFile && fs.existsSync(ep.sessionFile)) {
      ep.allowPlannedMissingSession = false;
    }
    if (ep.transcriptHydrated) return;
    // Live transports already own the in-memory transcript.
    if (ep.client || ep.activation || ep.status === 'running' || ep.status === 'starting') {
      ep.transcriptHydrated = true;
      return;
    }

    const artifact =
      ep.sessionArtifact ??
      (ep.sessionFile ? ({ runtime: 'pi', sessionFile: ep.sessionFile } as const) : undefined);

    // Grok ACP: hydrate-only session/load, hold lease through dispose.
    if (artifact?.runtime === 'grok-acp') {
      await hydrateGrokAcpTranscript(ep, artifact.sessionId, opts);
      return;
    }

    if (!ep.sessionFile || !fs.existsSync(ep.sessionFile)) {
      // Missing session: leave false so a later path can retry once the file exists.
      // Planned empty (flag set, never written) is still not authoritative history.
      return;
    }
    // Writer barrier before any SessionManager.open (lease covers dispose).
    await awaitSessionLease(ep.sessionFile);
    // Endpoint may have been removed or become live during the barrier wait.
    // Re-read status from the live endpoint (async gap invalidates prior narrowing).
    const after = endpoints.get(ep.key);
    if (!after || after !== ep) return;
    if (after.transcriptHydrated) return;
    if (
      after.client ||
      after.activation ||
      after.status === 'running' ||
      after.status === 'starting'
    ) {
      after.transcriptHydrated = true;
      return;
    }
    if (!after.sessionFile || !fs.existsSync(after.sessionFile)) return;

    const loaded = hydrateMessages(after.sessionFile);
    if (!loaded.ok) {
      if (opts.required) {
        throw new InteractiveAgentError(
          'hydrate_error',
          `Failed to hydrate session transcript: ${loaded.error}`
        );
      }
      // Soft path (detail ensureTranscript): leave unhydrated for retry after fix.
      return;
    }
    // Final race check after disk read.
    if (endpoints.get(ep.key) !== ep) return;
    replaceFinalizedMessages(ep, loaded.messages);
    ep.transcriptHydrated = true;
  }

  async function hydrateGrokAcpTranscript(
    ep: InteractiveAgentEndpoint,
    sessionId: string,
    opts: { required?: boolean } = {}
  ): Promise<void> {
    const leaseKey = buildSessionLeaseKey({
      runtime: 'grok-acp',
      cwd: ep.worktreePath ?? ep.effectiveCwd,
      sessionIdentity: sessionId,
    });
    await awaitSessionLease(leaseKey);
    if (shutDown || endpoints.get(ep.key) !== ep) return;
    if (ep.transcriptHydrated) return;
    if (ep.client || ep.activation || ep.status === 'running' || ep.status === 'starting') {
      ep.transcriptHydrated = true;
      return;
    }

    const lease = await acquireSessionLease(leaseKey);
    // Register pending owner immediately so shutdown can wait/sticky-settle.
    const pending = beginPendingOwner({
      key: ep.key,
      release: (err) => lease.release(err),
    });
    let transport: InteractiveAgentTransport | undefined;
    try {
      if (shutDown || endpoints.get(ep.key) !== ep) {
        pending.release();
        return;
      }
      const agent = ep.launchSpec?.agent;
      if (!agent) {
        throw new InteractiveAgentError(
          'hydrate_error',
          'Missing launch specification for Grok ACP hydrate'
        );
      }
      transport = await createGrokAcpTransport({
        agent,
        cwd: ep.worktreePath ?? ep.effectiveCwd,
        sessionId,
        hydrateOnly: true,
        spawnFn: options.spawnFn as never,
        configuredModel: ep.launchSpec?.modelOverride ?? agent.model,
      });
      pending.bindTransport(transport);
      if (shutDown || endpoints.get(ep.key) !== ep) {
        // Fail closed: tracked dispose; do not publish hydrate results.
        await disposeTracked(ep.key, transport);
        pending.complete();
        return;
      }
      const messages =
        'getFinalizedMessages' in transport &&
        typeof (transport as { getFinalizedMessages?: () => readonly AgentMessage[] })
          .getFinalizedMessages === 'function'
          ? (
              transport as { getFinalizedMessages: () => readonly AgentMessage[] }
            ).getFinalizedMessages()
          : ([] as readonly AgentMessage[]);
      replaceFinalizedMessages(ep, messages);
      ep.transcriptHydrated = true;
      ep.status = ep.status === 'unavailable' ? ep.status : 'detached';
      ep.lastError = undefined;
      ep.errorCode = undefined;
      publish(ep, 'full');
      await disposeTracked(ep.key, transport);
      pending.complete();
    } catch (err) {
      let disposeError: Error | undefined;
      if (transport) {
        try {
          // disposeTracked settles the lease via transportLeaseReleases.
          await disposeTracked(ep.key, transport);
        } catch (disposeErr) {
          disposeError = disposeErr instanceof Error ? disposeErr : new Error(String(disposeErr));
        }
        pending.complete();
      } else {
        // Factory may have spawned then failed cleanup without returning a handle.
        // Never treat !transport as never-spawned when dispose_failed is present.
        const certainty = disposalCertaintyFromCaught(err);
        if (certainty.kind === 'failed') disposeError = certainty.error;
        releaseSessionLeaseWithCertainty(pending.release, certainty);
      }
      const message = err instanceof Error ? err.message : String(err);
      // Prefer structured GrokAcpClientError.code over message matching.
      const clientCode =
        err &&
        typeof err === 'object' &&
        'code' in err &&
        typeof (err as { code?: unknown }).code === 'string'
          ? ((err as { code: string }).code as string)
          : undefined;
      const code =
        err instanceof InteractiveAgentError
          ? err.code
          : disposeError || isDisposeFailedError(err)
            ? 'dispose_failed'
            : clientCode === 'dispose_failed' ||
                clientCode === 'acp_session_not_found' ||
                clientCode === 'acp_cwd_mismatch' ||
                clientCode === 'acp_load_unsupported' ||
                clientCode === 'acp_session_history_empty' ||
                clientCode === 'acp_load_error' ||
                clientCode === 'transport_error' ||
                clientCode === 'aborted'
              ? clientCode
              : message.includes('acp_session_history_empty')
                ? 'acp_session_history_empty'
                : message.includes('loadSession') || message.includes('acp_load_unsupported')
                  ? 'acp_load_unsupported'
                  : message.includes('not found') || message.includes('Path not found')
                    ? 'acp_session_not_found'
                    : message.includes('cwd') && message.includes('mismatch')
                      ? 'acp_cwd_mismatch'
                      : message.includes('cwd_missing')
                        ? 'cwd_missing'
                        : message.includes('worktree')
                          ? 'worktree_unavailable'
                          : 'acp_load_error';
      const permanent =
        code === 'acp_session_unavailable' ||
        code === 'acp_session_not_found' ||
        code === 'acp_cwd_mismatch' ||
        code === 'acp_session_history_empty' ||
        code === 'acp_load_unsupported' ||
        code === 'cwd_missing' ||
        code === 'worktree_unavailable';
      if (endpoints.get(ep.key) === ep) {
        ep.status = permanent ? 'unavailable' : 'error';
        ep.lastError = disposeError?.message ?? message;
        ep.errorCode = disposeError || isDisposeFailedError(err) ? 'dispose_failed' : code;
        publish(ep, 'full');
      }
      if (opts.required) {
        throw new InteractiveAgentError(
          disposeError || isDisposeFailedError(err) ? 'dispose_failed' : code,
          disposeError?.message ?? message
        );
      }
    }
  }

  /**
   * Explicit transcript load for detail/reopen callers.
   * Awaits the session lease barrier, then hydrates; returns undefined if the
   * endpoint is missing, off-branch, or removed during the wait.
   */
  async function ensureTranscript(key: string): Promise<InteractiveEndpointSnapshot | undefined> {
    const ep = endpoints.get(key);
    if (!ep || !isBranchVisible(ep)) return undefined;
    await ensureTranscriptHydrated(ep);
    // Re-check after barrier: dispose/unavailable/removal may have raced.
    if (!endpoints.has(key) || !isBranchVisible(ep)) return undefined;
    return snapshotOf(ep);
  }

  /**
   * Pure in-memory snapshot read. Does not open SessionManager or wait on leases.
   * Callers that need history (detail panel) must use `ensureTranscript`.
   */
  function get(key: string): InteractiveEndpointSnapshot | undefined {
    const ep = endpoints.get(key);
    if (!ep || !isBranchVisible(ep)) return undefined;
    return snapshotOf(ep);
  }

  function emitEndpointsChanged(): void {
    emit({ type: 'endpoints_changed', keys: visibleEndpoints().map((e) => e.key) });
  }

  function getMutable(key: string): InteractiveAgentEndpoint | undefined {
    return endpoints.get(key);
  }

  function subscribe(listener: (event: InteractiveRegistryEvent) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function assertNotShutdown(): void {
    if (shutDown) throw new InteractiveAgentError('shutdown', 'Interactive registry is shut down');
  }

  function resolveSessionPath(sessionFile: string): string {
    return canonicalizeSessionLeaseKey(sessionFile);
  }

  function claimSessionFile(key: string, sessionFile: string): void {
    const resolved = resolveSessionPath(sessionFile);
    const existing = sessionOwners.get(resolved);
    if (existing && existing !== key) {
      throw new InteractiveAgentError(
        'session_busy',
        `Session already owned by endpoint ${existing}`
      );
    }
    sessionOwners.set(resolved, key);
  }

  function releaseSessionFile(key: string, sessionFile: string): void {
    const resolved = resolveSessionPath(sessionFile);
    if (sessionOwners.get(resolved) === key) sessionOwners.delete(resolved);
  }

  async function persistBinding(
    runId: string,
    unitId: string,
    binding: InteractiveAgentBindingV1
  ): Promise<void> {
    await options.runCoordinator.persistInteractiveBinding({
      runId,
      unitId,
      binding,
    });
  }

  /**
   * Exact host-branch link match: version/runId/unitId/bindingId/hostSessionId/createdAt.
   * Forged or stale links that only share run/unit must not suppress append or grant trust.
   */
  function branchHasExactLink(
    entries: Array<{ type: string; customType?: string; data?: unknown }>,
    link: InteractiveAgentLinkV1
  ): boolean {
    for (const entry of entries) {
      if (entry.type !== 'custom' || entry.customType !== INTERACTIVE_LINK_TYPE) continue;
      if (!isLinkData(entry.data)) continue;
      if (
        entry.data.version === link.version &&
        entry.data.runId === link.runId &&
        entry.data.unitId === link.unitId &&
        entry.data.bindingId === link.bindingId &&
        entry.data.hostSessionId === link.hostSessionId &&
        entry.data.createdAt === link.createdAt
      ) {
        return true;
      }
    }
    return false;
  }

  /** Locate the exact branch link for an existing endpoint binding, if present. */
  function findExactBranchLink(
    entries: Array<{ type: string; customType?: string; data?: unknown }>,
    link: InteractiveAgentLinkV1
  ): InteractiveAgentLinkV1 | undefined {
    for (const entry of entries) {
      if (entry.type !== 'custom' || entry.customType !== INTERACTIVE_LINK_TYPE) continue;
      if (!isLinkData(entry.data)) continue;
      if (
        entry.data.version === link.version &&
        entry.data.runId === link.runId &&
        entry.data.unitId === link.unitId &&
        entry.data.bindingId === link.bindingId &&
        entry.data.hostSessionId === link.hostSessionId &&
        entry.data.createdAt === link.createdAt
      ) {
        return entry.data;
      }
    }
    return undefined;
  }

  /**
   * Validate Grok ACP registerInitial/resume against authoritative RunStore.
   * Requires runtime=grok-acp, session-only capability (`capability=session`),
   * and an exact trimmed ACP session ID that matches the unit's stored
   * `acpSessionId`. When a binding already exists for this host,
   * bindingId/hostSessionId/createdAt must match the endpoint link.
   */
  function validateGrokAcpRegistrationFromStore(input: {
    runId: string;
    unitId: string;
    sessionId: string;
    hostSessionId: string;
    existing?: InteractiveAgentEndpoint;
  }): void {
    const sessionId = input.sessionId.trim();
    if (!sessionId) {
      throw new InteractiveAgentError(
        'validation_error',
        'Grok ACP registration requires a non-empty sessionId'
      );
    }
    const loaded = options.runStore.getRun(input.runId);
    if (!loaded.ok) {
      throw new InteractiveAgentError(
        'validation_error',
        `Run ${input.runId} not found for Grok ACP registration`
      );
    }
    const unit = loaded.loaded.record.units[input.unitId];
    if (!unit) {
      throw new InteractiveAgentError(
        'validation_error',
        `Unit ${input.unitId} not found in run ${input.runId}`
      );
    }
    const runtime = unit.runtime ?? loaded.loaded.record.request.runtime ?? DEFAULT_RUNTIME;
    if (runtime !== GROK_ACP_RUNTIME) {
      throw new InteractiveAgentError(
        'validation_error',
        `Grok ACP registration requires runtime=grok-acp (got ${runtime})`
      );
    }
    if (unit.capability !== 'session') {
      throw new InteractiveAgentError(
        'validation_error',
        `Grok ACP registration requires capability=session (got ${unit.capability})`
      );
    }
    const storedId = unit.acpSessionId?.trim();
    if (!storedId || unit.acpSessionId !== storedId) {
      throw new InteractiveAgentError(
        'acp_session_unavailable',
        'Grok ACP registration requires a non-empty trimmed acpSessionId on the unit'
      );
    }
    if (storedId !== sessionId) {
      throw new InteractiveAgentError(
        'validation_error',
        `Grok ACP sessionId mismatch: launchSpec=${sessionId}, runStore=${storedId}`
      );
    }
    // Existing endpoint: re-validate host/binding/timestamp/link against store.
    if (input.existing) {
      const ep = input.existing;
      if (ep.hostSessionId !== input.hostSessionId) {
        throw new InteractiveAgentError(
          'validation_error',
          'Grok ACP hostSessionId mismatch on existing endpoint'
        );
      }
      const art = ep.sessionArtifact;
      if (!art || art.runtime !== 'grok-acp' || art.sessionId.trim() !== storedId) {
        throw new InteractiveAgentError(
          'validation_error',
          'Grok ACP existing endpoint session artifact mismatch'
        );
      }
      const binding = unit.interactiveBindings?.[ep.bindingId];
      if (!binding) {
        throw new InteractiveAgentError(
          'validation_error',
          'Grok ACP existing endpoint binding missing from RunStore'
        );
      }
      if (
        binding.bindingId !== ep.bindingId ||
        binding.hostSessionId !== ep.hostSessionId ||
        binding.createdAt !== ep.linkCreatedAt ||
        binding.hostSessionId !== input.hostSessionId
      ) {
        throw new InteractiveAgentError(
          'validation_error',
          'Grok ACP existing endpoint binding/link mismatch'
        );
      }
    }
  }

  async function registerInitial(
    input: InteractiveRegisterInput,
    /** When set, caller already holds the per-key registration slot (e.g. registerGrokAcpLive). */
    heldRegistration?: RegistrationHandle
  ): Promise<InteractiveEndpointSnapshot> {
    assertNotShutdown();
    const key = endpointKey(input.runId, input.unitId);
    const reg = heldRegistration ?? (await acquireRegistration(key));
    const ownsSlot = !heldRegistration;

    try {
      assertRegistration(reg);

      const artifact =
        input.launchSpec.sessionArtifact ??
        (input.launchSpec.sessionFile
          ? ({ runtime: 'pi' as const, sessionFile: input.launchSpec.sessionFile } as const)
          : undefined);
      const isGrokAcp = artifact?.runtime === 'grok-acp';

      // Existing-key path: every live endpoint (Pi and Grok ACP) requires an
      // exact six-field branch link + resolveTrusted / RunStore revalidation
      // before grant. Forged/second-host/empty-branch without same-host append
      // must not bypass. Grok ACP unavailable may be replaced by a fresh register.
      // Supersede: after serial wait, a trusted live endpoint is reused — never
      // overwritten by a concurrent registration.
      if (endpoints.has(key)) {
        const existing = endpoints.get(key)!;
        const liveOrReady =
          existing.status === 'starting' ||
          existing.status === 'running' ||
          existing.status === 'idle' ||
          existing.status === 'registered' ||
          existing.status === 'detached' ||
          existing.status === 'error' ||
          !!existing.client ||
          !!existing.activation ||
          !!existing.transportReady;

        // Grok ACP unavailable (not live): drop and fall through to full register.
        if (isGrokAcp && !liveOrReady) {
          endpoints.delete(key);
          revokeTrustedBranch(key);
          treeClaimKeys.delete(key);
        } else {
          const desiredLink: InteractiveAgentLinkV1 = {
            version: 1,
            runId: input.runId,
            unitId: input.unitId,
            bindingId: existing.bindingId,
            hostSessionId: input.hostSessionId,
            createdAt: existing.linkCreatedAt,
          };
          // Fail closed: existing-key re-entry requires an authoritative exact
          // six-field branch link. Never trust a local desiredLink, appender
          // no-op, empty branch, or forged-only branch.
          const exactLink = findExactBranchLink(input.getBranchEntries(), desiredLink);
          if (!exactLink) {
            if (existing.hostSessionId !== input.hostSessionId) {
              // Second host / forged host cannot steal an existing binding.
              throw new InteractiveAgentError(
                'validation_error',
                'Existing endpoint requires matching hostSessionId and an exact branch link'
              );
            }
            // Same host with empty/missing/forged-only branch: revoke relay trust.
            revokeTrustedBranch(key);
            throw new InteractiveAgentError(
              'validation_error',
              'Existing endpoint requires an exact six-field branch link on the active branch'
            );
          }

          // Grok: store revalidation before grant so capability/session
          // failures do not mutate trust state incorrectly.
          const grokSessionId =
            artifact?.runtime === 'grok-acp'
              ? artifact.sessionId
              : existing.sessionArtifact?.runtime === 'grok-acp'
                ? existing.sessionArtifact.sessionId
                : undefined;
          if (grokSessionId) {
            validateGrokAcpRegistrationFromStore({
              runId: input.runId,
              unitId: input.unitId,
              sessionId: grokSessionId,
              hostSessionId: input.hostSessionId,
              existing,
            });
          }

          assertRegistration(reg);
          const trust = resolveTrusted(exactLink, input.hostSessionId, {
            allowPlannedMissing: existing.allowPlannedMissingSession,
          });
          if (!trust.ok) {
            revokeTrustedBranch(key);
            throw new InteractiveAgentError(
              'validation_error',
              `Existing endpoint failed resolveTrusted: ${trust.reason}`
            );
          }

          // Trusted launch spec only — never grant from unvalidated caller input.
          applyTrustedLaunchSpec(existing, trust.resolved, exactLink);
          grantTrustedBranch(key, existing.bindingId);
          treeClaimKeys.add(key);
          return publish(existing, 'full');
        }
      }

      const sessionFile = isGrokAcp ? '' : input.launchSpec.sessionFile;
      if (!isGrokAcp) {
        if (input.launchSpec.registrationKind === 'initial') {
          // Planned path may not exist yet.
        } else if (!fs.existsSync(sessionFile)) {
          throw new InteractiveAgentError(
            'validation_error',
            `Session file missing for registration: ${sessionFile}`
          );
        }
      } else {
        if (!artifact.sessionId?.trim()) {
          throw new InteractiveAgentError(
            'validation_error',
            'Grok ACP registration requires a non-empty sessionId'
          );
        }
        // Resume/initial registration must match durable RunStore session identity.
        validateGrokAcpRegistrationFromStore({
          runId: input.runId,
          unitId: input.unitId,
          sessionId: artifact.sessionId,
          hostSessionId: input.hostSessionId,
        });
      }

      // Pi claims the session-file path; Grok ACP uses process-global session lease
      // keys (runtime+cwd+sessionId) at spawn/hydrate time instead.
      if (!isGrokAcp && sessionFile) {
        claimSessionFile(key, sessionFile);
      }

      const bindingId = crypto.randomBytes(16).toString('hex');
      const createdAt = now();
      const binding: InteractiveAgentBindingV1 = {
        bindingId,
        hostSessionId: input.hostSessionId,
        createdAt,
      };

      try {
        await persistBinding(input.runId, input.unitId, binding);
        // After await: refuse endpoint insert if superseded or shutdown mid-binding.
        assertRegistration(reg);

        const link: InteractiveAgentLinkV1 = {
          version: 1,
          runId: input.runId,
          unitId: input.unitId,
          bindingId,
          hostSessionId: input.hostSessionId,
          createdAt,
        };
        // Exact match only — forged/stale run:unit links must not block the precise append.
        if (!branchHasExactLink(input.getBranchEntries(), link)) {
          if (input.appendLink) {
            input.appendLink(link);
          } else {
            appendHostLink(link);
          }
        }
        assertRegistration(reg);
      } catch (err) {
        // Binding or link persistence failed: roll back the in-process session claim
        // so a retry can re-register without session_busy.
        if (!isGrokAcp && sessionFile) {
          releaseSessionFile(key, sessionFile);
        }
        throw err;
      }

      assertRegistration(reg);

      // Prefer durable run request/scope when available; launchSpec remains authoritative
      // for the live agent object, cwd, session path, and first-process overrides.
      const loaded = options.runStore.getRun(input.runId);
      const durableRequest = loaded.ok ? loaded.loaded.record.request : undefined;
      const durableScope = loaded.ok ? loaded.loaded.record.agentScope : undefined;
      const launchSpec: InteractiveLaunchSpec = {
        ...input.launchSpec,
        request: durableRequest ?? input.launchSpec.request,
        agentScope: durableScope ?? input.launchSpec.agentScope,
        title: input.launchSpec.title ?? durableRequest?.title,
        modelOverride: input.launchSpec.modelOverride ?? durableRequest?.model,
        thinkingOverride: input.launchSpec.thinkingOverride ?? durableRequest?.thinking,
        runtimeOverride: input.launchSpec.runtimeOverride ?? durableRequest?.runtime,
        isolation: input.launchSpec.isolation ?? durableRequest?.isolation,
      };

      const sessionArtifact: InteractiveSessionArtifact =
        launchSpec.sessionArtifact ??
        (sessionFile ? { runtime: 'pi', sessionFile } : { runtime: 'pi', sessionFile: '' });
      const ep: InteractiveAgentEndpoint = {
        key,
        hostSessionId: input.hostSessionId,
        runId: input.runId,
        unitId: input.unitId,
        bindingId,
        agent: launchSpec.agent.name,
        title: launchSpec.title,
        sessionFile,
        sessionArtifact,
        effectiveCwd: launchSpec.effectiveCwd,
        worktreePath: launchSpec.worktreePath,
        status: 'registered',
        messages: EMPTY_FINALIZED,
        finalizedMessagesView: EMPTY_FINALIZED,
        messagesRevision: 0,
        streamRevision: 0,
        activeTools: new Map(),
        steeringQueue: [],
        followUpQueue: [],
        transportGeneration: 0,
        // Only mark hydrated when memory is authoritative. Non-empty fork/resume
        // session history must hydrate on get/detail/activate, not stay empty forever.
        transcriptHydrated: false,
        finalizedMessageBytes: [],
        finalizedMessagesBytes: 0,
        lastUsedAt: createdAt,
        createdAt,
        linkCreatedAt: createdAt,
        launchSpec: { ...launchSpec, sessionArtifact },
        usage: {
          turns: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
        },
      };
      // Grok ACP: no local session file; hydrate lazily via session/load.
      if (sessionArtifact.runtime === 'grok-acp') {
        assertRegistration(reg);
        ep.transcriptHydrated = false;
        ep.allowPlannedMissingSession = false;
        endpoints.set(key, ep);
        grantTrustedBranch(key, bindingId);
        treeClaimKeys.add(key);
        publish(ep, 'full');
        emitEndpointsChanged();
        return snapshotOf(ep);
      }
      // Fresh planned path (file not created yet): empty view is authoritative for
      // live turns, but reopen may still need the planned-missing grace flag.
      // Existing session (fork/resume): wait for any prior writer lease, then hydrate
      // so baseline reflects the final JSONL (never a partial dispose write).
      if (!sessionFile || !fs.existsSync(sessionFile)) {
        ep.transcriptHydrated = true;
        ep.allowPlannedMissingSession = true;
      } else {
        // Non-read validation (claim/bind/path) already completed above; only now read.
        await awaitSessionLease(sessionFile);
        assertRegistration(reg);
        const existing = hydrateMessages(sessionFile);
        if (!existing.ok) {
          // File present but unreadable: leave unhydrated so get/activate can retry.
          ep.transcriptHydrated = false;
        } else if (existing.messages.length === 0) {
          ep.transcriptHydrated = true;
        } else {
          replaceFinalizedMessages(ep, existing.messages);
          ep.transcriptHydrated = true;
        }
      }
      assertRegistration(reg);
      endpoints.set(key, ep);
      grantTrustedBranch(key, bindingId);
      emitEndpointsChanged();
      return publish(ep);
    } finally {
      if (ownsSlot) reg.leave();
    }
  }

  /**
   * Register a Grok ACP endpoint that already owns a live transport after
   * session/new + durable ID flush. Keeps the same process for the first prompt
   * (no second owner / no re-load).
   *
   * Ownership transfer: the first effective operation is `beginPendingOwner` of
   * `transport` + `leaseRelease`, then optional `acceptOwnership` so the caller
   * drops local handles. Callers must not dispose or release after acceptOwnership
   * — fail-closed cleanup runs once via disposeTracked for acquire, validation,
   * shutdown, and generation failure.
   */
  async function registerGrokAcpLive(input: {
    runId: string;
    unitId: string;
    hostSessionId: string;
    launchSpec: InteractiveLaunchSpec;
    transport: InteractiveAgentTransport;
    leaseRelease: (err?: Error) => void;
    /** Sync: invoke immediately after beginPendingOwner so the caller clears handles. */
    acceptOwnership?: () => void;
    getBranchEntries: () => Array<{ type: string; customType?: string; data?: unknown }>;
    appendLink?: (link: InteractiveAgentLinkV1) => void;
  }): Promise<InteractiveEndpointSnapshot> {
    // First effective op: own the caller's lease/transport before any check/await.
    // acceptOwnership tells the caller to drop local handles; registry alone disposes.
    const key = endpointKey(input.runId, input.unitId);
    const pending = beginPendingOwner({
      key,
      release: input.leaseRelease,
      transport: input.transport,
    });
    input.acceptOwnership?.();
    let handedOff = false;
    let disposedBeforeHandoff = false;
    let reg: RegistrationHandle | undefined;

    const trackedDisposeBeforeHandoff = async (): Promise<void> => {
      if (disposedBeforeHandoff) return;
      disposedBeforeHandoff = true;
      if (shutdownTransportBag) {
        shutdownTransportBag.push(input.transport);
      }
      try {
        await disposeTracked(key, input.transport);
      } catch {
        /* dispose_failed sticky path; lease settled by disposeTracked */
      }
      pending.complete();
    };

    const failClosedTrackedDispose = async (code: InteractiveErrorCode, message: string) => {
      await trackedDisposeBeforeHandoff();
      throw new InteractiveAgentError(code, message);
    };

    try {
      assertNotShutdown();
      const artifact = input.launchSpec.sessionArtifact;
      if (!artifact || artifact.runtime !== 'grok-acp' || !artifact.sessionId.trim()) {
        throw new InteractiveAgentError(
          'validation_error',
          'registerGrokAcpLive requires a grok-acp sessionArtifact with sessionId'
        );
      }

      // Reserve generation + serial slot under pending ownership so a superseded
      // acquire still disposes transport and releases the lease once.
      reg = await acquireRegistration(key);
      assertRegistration(reg);

      // Supersede: after serial wait, never overwrite a live endpoint owner.
      if (endpoints.has(key)) {
        const existing = endpoints.get(key)!;
        const liveOwner =
          !!existing.client ||
          !!existing.activation ||
          !!existing.transportReady ||
          existing.status === 'starting' ||
          existing.status === 'running' ||
          existing.status === 'idle' ||
          existing.status === 'registered' ||
          existing.status === 'detached';
        if (liveOwner) {
          await failClosedTrackedDispose(
            'session_busy',
            `Endpoint ${key} already registered; refuse to overwrite live owner`
          );
        }
      }

      const snap = await registerInitial(
        {
          runId: input.runId,
          unitId: input.unitId,
          hostSessionId: input.hostSessionId,
          launchSpec: input.launchSpec,
          getBranchEntries: input.getBranchEntries,
          appendLink: input.appendLink,
        },
        reg
      );

      // After every await: refuse attach if superseded or shutdown mid-registration.
      assertRegistration(reg);

      const ep = endpoints.get(key);
      if (!ep) {
        await failClosedTrackedDispose('unavailable', `Failed to register ${key}`);
      }
      // Never attach over a different live transport already bound to this key.
      if (ep!.client && ep!.client !== input.transport) {
        await failClosedTrackedDispose(
          'session_busy',
          `Endpoint ${key} already has a live transport owner`
        );
      }
      // Attach the live transport as the sole process owner for this session.
      // Lease release remains on transportLeaseReleases via pending owner.
      ep!.client = input.transport;
      ep!.transcriptHydrated = true;
      ep!.status = 'registered';
      ep!.sessionArtifact = artifact;
      ep!.sessionFile = '';
      if (ep!.launchSpec) {
        ep!.launchSpec.sessionArtifact = artifact;
        ep!.launchSpec.sessionFile = '';
      }

      input.transport.subscribe((event: unknown) => {
        const current = endpoints.get(key);
        if (!current || current.client !== input.transport) return;
        if (isPiRpcTransportExitEvent(event)) {
          if (event.intentional) return;
          void enqueueTransition(key, () => {
            const cur = endpoints.get(key);
            if (!cur || cur.client !== input.transport) return;
            handleUnexpectedTransportExit(cur, event.error.message);
          });
          return;
        }
        const evtType =
          event && typeof event === 'object' ? (event as { type?: unknown }).type : undefined;
        if (evtType === 'message_update' || evtType === 'message_start') {
          holdCoalescedStream(key, event);
          return;
        }
        const sealed = sealCoalescedStream(key);
        void enqueueTransition(key, () => {
          const cur = endpoints.get(key);
          if (!cur || cur.client !== input.transport) return;
          if (sealed !== undefined) reduceEvent(cur, sealed);
          reduceEvent(cur, event);
        });
      });

      // Long-lived ownership is ep.client; drop pending so shutdown uses client path.
      pending.complete();
      handedOff = true;
      publish(ep!, 'full');
      return snapshotOf(ep!) ?? snap;
    } catch (err) {
      if (!handedOff && !disposedBeforeHandoff) {
        await trackedDisposeBeforeHandoff();
      }
      throw err;
    } finally {
      reg?.leave();
    }
  }

  /**
   * Open and parse a Pi session file. Distinguishes success (including legal
   * empty history) from temporary read/parse failures — callers must not set
   * `transcriptHydrated` on failure.
   */
  function hydrateMessages(
    sessionFile: string
  ): { ok: true; messages: readonly AgentMessage[] } | { ok: false; error: string } {
    try {
      const sm = SessionManager.open(sessionFile);
      const branch = sm.getBranch();
      const messages: AgentMessage[] = [];
      for (const entry of branch) {
        if (entry.type === 'message') {
          messages.push(entry.message as AgentMessage);
        }
      }
      // Isolate once on hydrate — shared finalized view is frozen thereafter.
      return { ok: true, messages: isolateFinalizedMessages(messages) };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  interface ResolvedArtifacts {
    sessionFile: string;
    sessionArtifact: InteractiveSessionArtifact;
    effectiveCwd: string;
    worktreePath?: string;
    agent: AgentConfig;
    request: StoredRunRequest;
    agentScope: AgentScope;
    resolvedSkillPaths?: string[];
    modelOverride?: string;
    thinkingOverride?: string;
    runtimeOverride?: Runtime;
    isolation?: 'none' | 'worktree';
    title?: string;
  }

  function resolveTrusted(
    link: InteractiveAgentLinkV1,
    hostSessionId: string,
    opts: { allowPlannedMissing?: boolean } = {}
  ): { ok: true; resolved: ResolvedArtifacts } | { ok: false; reason: string } {
    if (link.hostSessionId !== hostSessionId) {
      return { ok: false, reason: 'host_session_mismatch' };
    }
    const loaded = options.runStore.getRun(link.runId);
    if (!loaded.ok) return { ok: false, reason: 'run_not_found' };
    const record = loaded.loaded.record;
    if (record.version !== 1) return { ok: false, reason: 'invalid_run_version' };
    const unit = record.units[link.unitId];
    if (!unit) return { ok: false, reason: 'unit_not_found' };
    const runtime = unit.runtime ?? record.request.runtime ?? DEFAULT_RUNTIME;

    if (runtime === GROK_ACP_RUNTIME) {
      // Grok ACP requires a durable protocol session ID and session capability.
      const acpId = unit.acpSessionId?.trim();
      if (!acpId || unit.acpSessionId !== acpId) {
        return { ok: false, reason: 'acp_session_unavailable' };
      }
    }
    if (unit.capability !== 'session') {
      return { ok: false, reason: 'non_session_capability' };
    }

    const bindings = unit.interactiveBindings;
    const binding = bindings?.[link.bindingId];
    if (!binding) return { ok: false, reason: 'binding_missing' };
    if (
      binding.bindingId !== link.bindingId ||
      binding.hostSessionId !== link.hostSessionId ||
      binding.createdAt !== link.createdAt
    ) {
      return { ok: false, reason: 'binding_mismatch' };
    }

    const effectiveCwd = unit.worktreePath ?? unit.effectiveCwd;
    if (!effectiveCwd || !fs.existsSync(effectiveCwd) || !fs.statSync(effectiveCwd).isDirectory()) {
      return { ok: false, reason: 'cwd_missing' };
    }
    if (unit.worktreePath) {
      if (!fs.existsSync(unit.worktreePath) || !fs.statSync(unit.worktreePath).isDirectory()) {
        return { ok: false, reason: 'worktree_missing' };
      }
      // Worktree paths live under <repo>/.worktrees/<name>; resolve repo root via git.
      const repoRoot = getGitRoot(unit.worktreePath) ?? path.resolve(unit.worktreePath, '..', '..');
      const opened = openAgentWorktree(repoRoot, unit.worktreePath);
      if (!opened.ok) {
        return { ok: false, reason: 'worktree_unavailable' };
      }
    }

    let sessionArtifact: InteractiveSessionArtifact;
    let resolvedSession = '';

    if (runtime === GROK_ACP_RUNTIME) {
      const acpId = unit.acpSessionId!.trim();
      sessionArtifact = { runtime: 'grok-acp', sessionId: acpId };
    } else {
      if (!unit.sessionFile) return { ok: false, reason: 'session_missing' };

      const sessionsDir = path.join(loaded.loaded.runDir, 'sessions');
      const resolvedSessionsDir = fs.existsSync(sessionsDir)
        ? fs.realpathSync(sessionsDir)
        : path.resolve(sessionsDir);
      let sessionFileMissing = false;
      try {
        resolvedSession = fs.realpathSync(unit.sessionFile);
      } catch {
        // Live-only planned path: same-process initial registration may reopen
        // before Pi persists the JSONL. Restored links never pass this flag.
        if (!opts.allowPlannedMissing) {
          return { ok: false, reason: 'session_unreadable' };
        }
        resolvedSession = path.resolve(unit.sessionFile);
        sessionFileMissing = true;
      }
      if (
        resolvedSession !== resolvedSessionsDir &&
        !resolvedSession.startsWith(resolvedSessionsDir + path.sep)
      ) {
        return { ok: false, reason: 'session_outside_run' };
      }
      if (!sessionFileMissing) {
        try {
          if (!fs.statSync(resolvedSession).isFile()) {
            return { ok: false, reason: 'session_not_file' };
          }
        } catch {
          return { ok: false, reason: 'session_unreadable' };
        }
      }
      sessionArtifact = { runtime: 'pi', sessionFile: resolvedSession };
    }

    const agentScope = record.agentScope;
    const discovery = discover(effectiveCwd, agentScope);
    const agent = discovery.agents.find((a) => a.name === unit.agent);
    if (!agent) return { ok: false, reason: 'agent_not_found' };
    const currentFp = agentFingerprint(agent);
    if (currentFp !== unit.agentFingerprint) {
      return { ok: false, reason: 'fingerprint_mismatch' };
    }

    let resolvedSkillPaths: string[] | undefined;
    if (agent.skills && agent.skills.length > 0) {
      const { resolved, missing } = resolveSkillNames(agent.skills);
      if (missing.length > 0) return { ok: false, reason: 'skill_resolution_failed' };
      resolvedSkillPaths = resolved;
    }

    const request = record.request;
    return {
      ok: true,
      resolved: {
        sessionFile: resolvedSession,
        sessionArtifact,
        effectiveCwd,
        worktreePath: unit.worktreePath,
        agent,
        request,
        agentScope,
        resolvedSkillPaths,
        modelOverride: request.model,
        thinkingOverride: request.thinking,
        runtimeOverride: request.runtime ?? runtime,
        isolation: request.isolation,
        title: request.title,
      },
    };
  }

  function mapTrustReasonToErrorCode(reason: string): InteractiveErrorCode | string {
    if (
      reason === 'cwd_missing' ||
      reason === 'worktree_unavailable' ||
      reason === 'worktree_missing' ||
      reason === 'acp_session_unavailable' ||
      reason === 'session_busy' ||
      reason === 'acp_load_unsupported' ||
      reason === 'acp_session_not_found' ||
      reason === 'acp_cwd_mismatch' ||
      reason === 'acp_session_history_empty' ||
      reason === 'dispose_failed'
    ) {
      if (reason === 'worktree_missing') return 'worktree_unavailable';
      return reason;
    }
    return 'unavailable';
  }

  function applyUnavailable(
    key: string,
    link: InteractiveAgentLinkV1,
    reason: string,
    extra: Partial<InteractiveAgentEndpoint> = {}
  ): InteractiveEndpointSnapshot {
    // Revoke relay-trusted membership before settling so a synchronous relay
    // listener never observes (old trusted binding + active settle).
    revokeTrustedBranch(key);
    // UI may still claim the key on the tree as unavailable.
    treeClaimKeys.add(key);
    const existing = endpoints.get(key);
    if (existing) {
      const live =
        existing.status === 'starting' ||
        existing.status === 'running' ||
        !!existing.activation ||
        !!existing.client ||
        !!existing.transportReady;
      // Capture before invalidateLiveTransport force-settles and clears activation.
      const hadOpenActivation = !!(existing.activation && !existing.activation.settled);
      if (live) {
        // Atomic invalidation: bump generation, drop transports, force-settle,
        // clear transient, release session ownership — no late T1 can install.
        invalidateLiveTransport(existing, reason);
      } else {
        if (existing.client) {
          const client = existing.client;
          existing.client = undefined;
          void disposeTracked(key, client);
        }
        existing.transportReady = undefined;
        clearTransientActivity(existing);
      }
      if (existing.sessionFile) releaseSessionFile(key, existing.sessionFile);
      existing.status = 'unavailable';
      existing.lastError = reason;
      existing.errorCode = mapTrustReasonToErrorCode(reason);
      existing.bindingId = link.bindingId;
      existing.hostSessionId = link.hostSessionId;
      existing.linkCreatedAt = link.createdAt;
      // unavailable→ later trusted restore must rehydrate, not trust empty view.
      existing.transcriptHydrated = false;
      Object.assign(existing, extra);
      const hasTranscript =
        existing.messages.length > 0 || existing.finalizedMessagesView.length > 0;
      // Settled consumers and the internal endpoint retain the complete bounded
      // transcript through the synchronous settled turn. Evict only later.
      if (hasTranscript && live && hadOpenActivation) {
        const snap = publish(existing, 'full');
        const keyToClear = key;
        queueMicrotask(() => {
          void enqueueTransition(keyToClear, () => {
            const ep = endpoints.get(keyToClear);
            if (!ep) return;
            if (ep.status !== 'unavailable') return;
            if (ep.activation && !ep.activation.settled) return;
            if (ep.finalizedMessagesView.length === 0 && ep.messages.length === 0) return;
            ep.messages = EMPTY_FINALIZED;
            ep.finalizedMessagesView = EMPTY_FINALIZED;
            ep.finalizedMessageBytes = [];
            ep.finalizedMessagesBytes = 0;
            ep.messagesRevision += 1;
            publish(ep, 'full');
          });
        });
        return snap;
      }
      // Bump messagesRevision so detail caches never reuse the prior history.
      if (hasTranscript) {
        existing.messages = EMPTY_FINALIZED;
        existing.finalizedMessagesView = EMPTY_FINALIZED;
        existing.finalizedMessageBytes = [];
        existing.finalizedMessagesBytes = 0;
        existing.messagesRevision += 1;
      } else {
        existing.messages = EMPTY_FINALIZED;
        existing.finalizedMessagesView = EMPTY_FINALIZED;
      }
      return publish(existing, 'full');
    }
    const ep: InteractiveAgentEndpoint = {
      key,
      hostSessionId: link.hostSessionId,
      runId: link.runId,
      unitId: link.unitId,
      bindingId: link.bindingId,
      agent: (extra.agent as string | undefined) ?? link.unitId,
      sessionFile: (extra.sessionFile as string | undefined) ?? '',
      effectiveCwd: (extra.effectiveCwd as string | undefined) ?? '',
      status: 'unavailable',
      messages: EMPTY_FINALIZED,
      finalizedMessagesView: EMPTY_FINALIZED,
      messagesRevision: 0,
      streamRevision: 0,
      activeTools: new Map(),
      steeringQueue: [],
      followUpQueue: [],
      lastError: reason,
      errorCode: mapTrustReasonToErrorCode(reason),
      transportGeneration: 0,
      // Not authoritative empty — trusted restore may hydrate real history.
      transcriptHydrated: false,
      finalizedMessageBytes: [],
      finalizedMessagesBytes: 0,
      lastUsedAt: now(),
      createdAt: link.createdAt,
      linkCreatedAt: link.createdAt,
      ...extra,
    };
    endpoints.set(key, ep);
    return publish(ep);
  }

  function applyTrustedLaunchSpec(
    ep: InteractiveAgentEndpoint,
    resolved: ResolvedArtifacts,
    link: InteractiveAgentLinkV1
  ): void {
    ep.hostSessionId = link.hostSessionId;
    ep.bindingId = link.bindingId;
    ep.linkCreatedAt = link.createdAt;
    ep.createdAt = link.createdAt;
    ep.agent = resolved.agent.name;
    ep.title = resolved.title;
    ep.sessionFile = resolved.sessionFile;
    ep.sessionArtifact = resolved.sessionArtifact;
    ep.effectiveCwd = resolved.effectiveCwd;
    ep.worktreePath = resolved.worktreePath;
    ep.launchSpec = {
      agent: resolved.agent,
      request: resolved.request,
      resolvedSkillPaths: resolved.resolvedSkillPaths,
      sessionFile: resolved.sessionFile,
      sessionArtifact: resolved.sessionArtifact,
      effectiveCwd: resolved.effectiveCwd,
      worktreePath: resolved.worktreePath,
      title: resolved.title,
      modelOverride: resolved.modelOverride,
      thinkingOverride: resolved.thinkingOverride,
      runtimeOverride: resolved.runtimeOverride,
      isolation: resolved.isolation,
      agentScope: resolved.agentScope,
      registrationKind: 'restore',
    };
    if (ep.status === 'unavailable') {
      ep.status = 'detached';
      ep.lastError = undefined;
      ep.errorCode = undefined;
      // Prior unavailable view was empty/non-authoritative; force rehydrate.
      ep.transcriptHydrated = false;
    }
  }

  function restoreActiveBranch(
    ctx: Pick<ExtensionContext, 'sessionManager' | 'cwd'>
  ): InteractiveEndpointSnapshot[] {
    assertNotShutdown();
    const hostSessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    const seen = new Set<string>();
    const restored: InteractiveEndpointSnapshot[] = [];

    for (const entry of branch) {
      if (entry.type !== 'custom') continue;
      const custom = entry as { customType?: string; data?: unknown };
      if (custom.customType !== INTERACTIVE_LINK_TYPE) continue;
      if (!isLinkData(custom.data)) continue;
      const link = custom.data;
      const key = endpointKey(link.runId, link.unitId);
      if (seen.has(key)) continue;
      seen.add(key);
      // UI tree claim only until resolveTrusted succeeds.
      treeClaimKeys.add(key);

      const existing = endpoints.get(key);
      // Always re-validate the current branch link, even when the key already exists
      // (forged/copied link data on the same run:unit must fail closed).
      const trust = resolveTrusted(link, hostSessionId);
      if (!trust.ok) {
        // Revoke trust then settle (applyUnavailable) so relay never sees old binding+active.
        restored.push(
          applyUnavailable(key, link, trust.reason, {
            agent: existing?.agent ?? link.unitId,
            sessionFile: existing?.sessionFile ?? '',
            effectiveCwd: existing?.effectiveCwd ?? ctx.cwd,
          })
        );
        continue;
      }

      // Trusted membership: exact bindingId required for relay isOnActiveBranch.
      grantTrustedBranch(key, link.bindingId);

      if (existing) {
        // Running endpoints keep their live transport; only refresh trusted metadata.
        if (
          existing.status === 'starting' ||
          existing.status === 'running' ||
          existing.activation ||
          existing.client
        ) {
          existing.bindingId = link.bindingId;
          existing.hostSessionId = link.hostSessionId;
          existing.linkCreatedAt = link.createdAt;
          if (existing.status === 'unavailable') {
            // Should not happen while live; fall through to rebuild.
          } else {
            restored.push(publish(existing));
            continue;
          }
        }

        try {
          // Pi-only session-file claim; Grok ACP uses process-global lease at spawn/hydrate.
          if (trust.resolved.sessionArtifact.runtime === 'pi') {
            if (existing.sessionFile && existing.sessionFile !== trust.resolved.sessionFile) {
              releaseSessionFile(key, existing.sessionFile);
            }
            claimSessionFile(key, trust.resolved.sessionFile);
          } else if (existing.sessionFile) {
            releaseSessionFile(key, existing.sessionFile);
          }
        } catch (err) {
          restored.push(
            applyUnavailable(
              key,
              link,
              err instanceof InteractiveAgentError ? err.message : 'session_busy',
              {
                agent: trust.resolved.agent.name,
                sessionFile: trust.resolved.sessionFile,
                sessionArtifact: trust.resolved.sessionArtifact,
                effectiveCwd: trust.resolved.effectiveCwd,
                worktreePath: trust.resolved.worktreePath,
              }
            )
          );
          continue;
        }

        applyTrustedLaunchSpec(existing, trust.resolved, link);
        if (!existing.client && existing.status !== 'error') {
          existing.status = 'detached';
          // Lazy: keep metadata only; transcript loads on get/detail/reopen.
          if (!existing.transcriptHydrated) {
            existing.messages = EMPTY_FINALIZED;
            existing.finalizedMessagesView = EMPTY_FINALIZED;
          }
        }
        restored.push(publish(existing));
        continue;
      }

      try {
        // Pi-only: claim the native session file path. Grok ACP never uses claimSessionFile.
        if (trust.resolved.sessionArtifact.runtime === 'pi' && trust.resolved.sessionFile) {
          claimSessionFile(key, trust.resolved.sessionFile);
        }
      } catch (err) {
        restored.push(
          applyUnavailable(
            key,
            link,
            err instanceof InteractiveAgentError ? err.message : 'session_busy',
            {
              agent: trust.resolved.agent.name,
              sessionFile: trust.resolved.sessionFile,
              sessionArtifact: trust.resolved.sessionArtifact,
              effectiveCwd: trust.resolved.effectiveCwd,
              worktreePath: trust.resolved.worktreePath,
            }
          )
        );
        continue;
      }

      // Metadata-only restore: do not open session files / hydrate child history.
      // Grok ACP: restore full sessionArtifact; sessionFile stays empty (not a path).
      const ep: InteractiveAgentEndpoint = {
        key,
        hostSessionId: link.hostSessionId,
        runId: link.runId,
        unitId: link.unitId,
        bindingId: link.bindingId,
        agent: trust.resolved.agent.name,
        title: trust.resolved.title,
        sessionFile: trust.resolved.sessionFile,
        sessionArtifact: trust.resolved.sessionArtifact,
        effectiveCwd: trust.resolved.effectiveCwd,
        worktreePath: trust.resolved.worktreePath,
        status: 'detached',
        messages: EMPTY_FINALIZED,
        finalizedMessagesView: EMPTY_FINALIZED,
        messagesRevision: 0,
        streamRevision: 0,
        activeTools: new Map(),
        steeringQueue: [],
        followUpQueue: [],
        transportGeneration: 0,
        transcriptHydrated: false,
        finalizedMessageBytes: [],
        finalizedMessagesBytes: 0,
        lastUsedAt: now(),
        createdAt: link.createdAt,
        linkCreatedAt: link.createdAt,
        launchSpec: {
          agent: trust.resolved.agent,
          request: trust.resolved.request,
          resolvedSkillPaths: trust.resolved.resolvedSkillPaths,
          sessionFile: trust.resolved.sessionFile,
          sessionArtifact: trust.resolved.sessionArtifact,
          effectiveCwd: trust.resolved.effectiveCwd,
          worktreePath: trust.resolved.worktreePath,
          title: trust.resolved.title,
          modelOverride: trust.resolved.modelOverride,
          thinkingOverride: trust.resolved.thinkingOverride,
          runtimeOverride: trust.resolved.runtimeOverride,
          isolation: trust.resolved.isolation,
          agentScope: trust.resolved.agentScope,
          registrationKind: 'restore',
        },
        usage: {
          turns: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
        },
      };
      endpoints.set(key, ep);
      restored.push(publish(ep));
    }

    // Drop endpoints no longer on the active branch (except those still running).
    // Removal is synchronous so listVisible/emitEndpointsChanged stay consistent.
    // Running/starting off-branch units stay operable but isOnActiveBranch is false.
    for (const [key, ep] of [...endpoints]) {
      if (seen.has(key)) continue;
      treeClaimKeys.delete(key);
      revokeTrustedBranch(key);
      if (ep.status === 'starting' || ep.status === 'running' || ep.activation) continue;
      clearAbortSettleTimer(key);
      if (ep.client) {
        const client = ep.client;
        ep.client = undefined;
        ep.transportReady = undefined;
        void disposeTracked(key, client);
      }
      outboundPoisonByKey.delete(key);
      coalescedStreamEvents.delete(key);
      streamCoalesceScheduled.delete(key);
      coalesceCellSeq.delete(key);
      releaseSessionFile(key, ep.sessionFile);
      endpoints.delete(key);
    }

    emitEndpointsChanged();
    return restored;
  }

  /**
   * User/session cancel settle: leave a durable list signal for glyphs.
   * After activation is cleared, UI classifies interrupted via usage.stopReason.
   */
  function markCancelledUsage(ep: InteractiveAgentEndpoint): void {
    if (ep.usage) {
      ep.usage.stopReason = 'aborted';
    }
  }

  function settleActivationError(
    ep: InteractiveAgentEndpoint,
    message: string,
    terminal: InteractiveTerminalOverride = 'error'
  ): void {
    // Establish final non-running terminal status first so retention scheduling is not
    // skipped (running-state guard) and settled consumers observe a terminal snapshot.
    if (ep.status === 'starting' || ep.status === 'running' || ep.status === 'registered') {
      if (terminal === 'max_turns') {
        ep.status = 'idle';
      } else if (terminal === 'cancelled') {
        ep.status = 'detached';
      } else {
        ep.status = 'error';
        ep.lastError = message;
        if (!ep.errorCode) ep.errorCode = 'transport_error';
      }
    }
    clearTransientActivity(ep);
    if (!ep.activation || ep.activation.settled) {
      publish(ep, 'full');
      return;
    }
    ep.activation.settled = true;
    ep.activation.error = message;
    ep.activation.terminalOverride = terminal;
    if (terminal === 'cancelled') {
      markCancelledUsage(ep);
    }
    const activationId = ep.activation.id;
    // Synchronous full publish + settle with the complete pre-eviction snapshot.
    publish(ep, 'full');
    emit({
      type: 'activation_settled',
      key: ep.key,
      activationId,
      snapshot: snapshotOf(ep),
    });
    ep.activation = undefined;
    // Queue eviction/compaction only after settled consumers observed the snapshot.
    scheduleIdleTranscriptEviction(ep);
  }

  function handleUnexpectedTransportExit(ep: InteractiveAgentEndpoint, message: string): void {
    // Establish dispose barrier before clearing the client so an immediate
    // reopen awaits process teardown (single writer / fail-closed on dispose).
    const client = ep.client;
    const ready = ep.transportReady;
    const sessionFile = ep.sessionFile;
    ep.client = undefined;
    ep.transportReady = undefined;
    if (client) {
      void disposeTracked(ep.key, client, sessionFile);
    } else if (ready) {
      void noteReadyDispose(ep.key, sessionFile, ready);
    }
    ep.status = 'error';
    ep.lastError = message;
    ep.errorCode = 'transport_error';
    clearTransientActivity(ep);
    settleActivationError(ep, message, 'error');
  }

  /**
   * Re-run dual-binding / path / fingerprint / skill trust checks before lazy reopen.
   * Updates launchSpec from authoritative RunStore resolution on success.
   * Planned-missing grace is live-only (allowPlannedMissingSession); restored
   * endpoints never receive that flag and still require a real session file.
   */
  async function revalidateForReopen(ep: InteractiveAgentEndpoint): Promise<void> {
    const link: InteractiveAgentLinkV1 = {
      version: 1,
      runId: ep.runId,
      unitId: ep.unitId,
      bindingId: ep.bindingId,
      hostSessionId: ep.hostSessionId,
      createdAt: ep.linkCreatedAt,
    };
    // Trust/path/fingerprint checks first (no session read).
    const trust = resolveTrusted(link, ep.hostSessionId, {
      allowPlannedMissing: !!ep.allowPlannedMissingSession,
    });
    if (!trust.ok) {
      ep.status = 'unavailable';
      ep.lastError = trust.reason;
      ep.errorCode = 'unavailable';
      publish(ep);
      throw new InteractiveAgentError('unavailable', trust.reason);
    }
    applyTrustedLaunchSpec(ep, trust.resolved, link);
    // File appeared: drop the live-only planned-missing grace.
    if (ep.allowPlannedMissingSession && fs.existsSync(trust.resolved.sessionFile)) {
      ep.allowPlannedMissingSession = false;
    }
    // Grok ACP reopen keeps a single load transport for the subsequent prompt.
    // Hydrate-only load+dispose would create a lease gap and a wrong baseline —
    // detail reads use ensureTranscript/hydrateGrokAcpTranscript instead.
    const artifact =
      ep.sessionArtifact ??
      (ep.sessionFile
        ? ({ runtime: 'pi' as const, sessionFile: ep.sessionFile } as const)
        : undefined);
    if (artifact?.runtime === 'grok-acp') {
      // Trust revalidation only; transcript + baseline come from spawn load barrier.
      return;
    }
    // Pi reopen needs transcript for baselineMessageCount and detail continuity.
    // ensureTranscriptHydrated awaits the process-scoped writer lease barrier.
    ep.transcriptHydrated = false;
    await ensureTranscriptHydrated(ep, { required: true });
  }

  function reduceEvent(ep: InteractiveAgentEndpoint, event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const evt = event as Record<string, unknown>;
    const type = evt.type;
    // Default meta; transcript/full only for message/tool/settle paths.
    let kind: InteractiveEndpointUpdateKind = 'meta';

    switch (type) {
      case 'agent_start':
        ep.status = 'running';
        ep.lastUsedAt = now();
        if (ep.activation && !ep.activation.settled) {
          ep.activation.observedAgentStart = true;
        }
        // Successful turn start: clear prior transport/reopen errors (do not mask
        // an active error status without a live turn — only clear when running).
        ep.lastError = undefined;
        ep.errorCode = undefined;
        break;
      case 'prompt_completed': {
        // Grok ACP turn completion metadata; settle still comes from agent_settled.
        // Only a real matching prompt response emits this event (never cancel grace).
        // stopReason is formal SingleResult vocabulary (end/max_turns/error/aborted).
        if (ep.usage) {
          const usage = evt.usage as
            | {
                input?: number;
                output?: number;
                cacheRead?: number;
                cacheWrite?: number;
                cost?: number;
                contextTokens?: number;
                turns?: number;
              }
            | undefined;
          if (usage) {
            if (typeof usage.input === 'number') ep.usage.input = usage.input;
            if (typeof usage.output === 'number') ep.usage.output = usage.output;
            if (typeof usage.cacheRead === 'number') ep.usage.cacheRead = usage.cacheRead;
            if (typeof usage.cacheWrite === 'number') ep.usage.cacheWrite = usage.cacheWrite;
            if (typeof usage.cost === 'number') ep.usage.cost = usage.cost;
            if (typeof usage.contextTokens === 'number') {
              ep.usage.contextTokens = usage.contextTokens;
            }
            if (typeof usage.turns === 'number') ep.usage.turns = usage.turns;
          }
          if (typeof evt.model === 'string' && evt.model) {
            ep.usage.model = evt.model;
          }
          if (typeof evt.stopReason === 'string') {
            ep.usage.stopReason = evt.stopReason;
          }
        }
        if (ep.activation && !ep.activation.settled) {
          const formalStop =
            typeof evt.stopReason === 'string' ? evt.stopReason : ep.usage?.stopReason;
          // Non-success formal terminals must fail closed (no delivery).
          if (formalStop && formalStop !== 'end') {
            if (formalStop === 'aborted') {
              ep.activation.terminalOverride = ep.activation.terminalOverride ?? 'cancelled';
            } else if (formalStop === 'max_turns') {
              ep.activation.terminalOverride = 'max_turns';
            } else {
              ep.activation.terminalOverride = 'error';
              ep.status = 'error';
              ep.errorCode = formalStop === 'error' ? 'error' : formalStop;
            }
            const errMsg =
              typeof (evt as { errorMessage?: unknown }).errorMessage === 'string'
                ? (evt as { errorMessage: string }).errorMessage
                : undefined;
            if (errMsg) {
              ep.activation.error = errMsg;
              ep.lastError = errMsg;
            }
            // Real response observed, but not a successful completed delivery.
            ep.activation.promptCompleted = false;
          } else {
            ep.activation.promptCompleted = true;
          }
        }
        kind = 'meta';
        break;
      }
      case 'prompt_failed': {
        // Structured transport/prompt failure: activation must be terminal failed.
        // Delivery must not run (promptCompleted stays false).
        const failMsg =
          typeof evt.error === 'string' && evt.error ? evt.error : 'Grok ACP prompt failed';
        const failCode = typeof evt.code === 'string' && evt.code ? evt.code : 'transport_error';
        ep.status = 'error';
        ep.lastError = failMsg;
        ep.errorCode = failCode;
        if (ep.activation && !ep.activation.settled) {
          ep.activation.terminalOverride = 'error';
          ep.activation.error = failMsg;
        }
        kind = 'meta';
        break;
      }
      // Pi 0.80.6 RPC: agent_end = one low-level run completed (may still retry,
      // compact, or run queued follow-ups). Do not idle, clear queues/tools/streaming,
      // settle activation, trigger relay/LRU, or complete runSingleAgentPiRpc waiters.
      // Only agent_settled means fully settled (no automatic continuation left).
      case 'agent_end': {
        ep.lastUsedAt = now();
        // Diagnostics only: keep status running and activation open.
        kind = 'meta';
        break;
      }
      case 'agent_settled': {
        clearAbortSettleTimer(ep.key);
        if (ep.activation && !ep.activation.settled) {
          // Late/duplicate settle from a prior turn must not close a newer
          // activation that has not observed agent_start (and is not aborting).
          if (!ep.activation.observedAgentStart && !ep.activation.terminalOverride) {
            kind = 'meta';
            break;
          }
          // Grok ACP: settle without a real prompt_completed is cancel-grace or
          // incomplete — never treat as successful completed delivery.
          const isGrokAcp = ep.sessionArtifact?.runtime === 'grok-acp';
          if (isGrokAcp && !ep.activation.promptCompleted && !ep.activation.terminalOverride) {
            ep.activation.terminalOverride = 'cancelled';
            ep.activation.error =
              ep.activation.error ?? 'Prompt cancelled before matching response';
          }
          ep.activation.settled = true;
          const activationId = ep.activation.id;
          // Honour terminal override from abort/max_turns (cancelled stays cancelled).
          if (ep.activation.terminalOverride === 'cancelled') {
            ep.status = 'idle';
            // Persist formal abort reason: list/widget glyphs need it after activation clears.
            markCancelledUsage(ep);
          } else if (ep.activation.terminalOverride === 'error') {
            ep.status = 'error';
          } else {
            ep.status = 'idle';
            ep.lastError = undefined;
            ep.errorCode = undefined;
          }
          // Normal settle clears streaming/tools/queues so UI is not stale.
          clearTransientActivity(ep);
          // Single full publish + settle event (avoid double endpoint_updated).
          const settledSnap = publish(ep, 'full');
          emit({
            type: 'activation_settled',
            key: ep.key,
            activationId,
            snapshot: settledSnap,
          });
          ep.activation = undefined;
          // Deferred idle retention after settled consumers observe the full snapshot.
          scheduleIdleTranscriptEviction(ep);
          void enforceIdleLru();
          return;
        }
        ep.status = 'idle';
        clearTransientActivity(ep);
        kind = 'full';
        break;
      }
      case 'message_start':
      case 'message_update':
        if (evt.message) {
          // Project + bound non-authoritative payloads; freeze so snapshots cannot share mutables.
          ep.streamingMessage = freezeDeep(
            projectTransientDisplayMessage(evt.message as AgentMessage)
          );
        }
        ep.streamRevision += 1;
        kind = 'transcript';
        break;
      case 'message_end':
        if (evt.message) {
          const msg = evt.message as AgentMessage;
          // Finalized messages are append-only and treated as immutable thereafter.
          appendFinalizedMessage(ep, msg);
          ep.streamingMessage = undefined;
          ep.streamRevision += 1;
          if (msg.role === 'assistant' && ep.usage) {
            ep.usage.turns += 1;
            const usage = (
              msg as unknown as {
                usage?: {
                  input?: number;
                  output?: number;
                  cacheRead?: number;
                  cacheWrite?: number;
                  totalTokens?: number;
                  cost?: { total?: number };
                };
              }
            ).usage;
            if (usage) {
              ep.usage.input += usage.input || 0;
              ep.usage.output += usage.output || 0;
              ep.usage.cacheRead += usage.cacheRead || 0;
              ep.usage.cacheWrite += usage.cacheWrite || 0;
              ep.usage.cost += usage.cost?.total || 0;
              ep.usage.contextTokens = usage.totalTokens || 0;
            }
            if ((msg as { model?: string }).model) {
              ep.usage.model = (msg as { model?: string }).model;
            }
            if ((msg as { stopReason?: string }).stopReason) {
              ep.usage.stopReason = (msg as { stopReason?: string }).stopReason;
            }
            // Max-turn policy counts post-baseline assistant messages only.
            if (
              ep.activation &&
              ep.activation.policy?.maxTurns &&
              !ep.activation.terminalOverride
            ) {
              const baseline = ep.activation.baselineMessageCount;
              let postBaselineAssistant = 0;
              for (let i = baseline; i < ep.messages.length; i++) {
                if ((ep.messages[i] as { role?: string }).role === 'assistant') {
                  postBaselineAssistant += 1;
                }
              }
              if (postBaselineAssistant >= ep.activation.policy.maxTurns) {
                ep.activation.terminalOverride = 'max_turns';
                const client = ep.client;
                if (client) {
                  void client.abort().catch(() => undefined);
                }
              }
            }
          }
        }
        // Finalized history + usage/meta for parent tool projection.
        kind = 'full';
        break;
      case 'tool_execution_start': {
        const rawId = String(evt.toolCallId ?? '');
        const mapKey = activeToolMapKey(rawId);
        // Bound complete entry (id/name/args) and freeze nested payloads at ingest.
        // Map key is independently bounded (hash of huge IDs) so retention stays finite.
        ep.activeTools.set(
          mapKey,
          projectActiveToolEntry({
            toolCallId: rawId,
            toolName: evt.toolName,
            args: evt.args,
          })
        );
        ep.streamRevision += 1;
        // Detail transcript only; list/widget do not show live tools.
        kind = 'transcript';
        break;
      }
      case 'tool_execution_update': {
        const rawId = String(evt.toolCallId ?? '');
        const mapKey = activeToolMapKey(rawId);
        const existing = ep.activeTools.get(mapKey);
        if (existing) {
          // Replace frozen entry — never mutate nested args/results in place.
          ep.activeTools.set(
            mapKey,
            projectActiveToolEntry({
              toolCallId: existing.toolCallId,
              toolName: existing.toolName,
              args: existing.args,
              partialResult: evt.partialResult,
              isError: existing.isError,
              ended: existing.ended,
            })
          );
        }
        ep.streamRevision += 1;
        kind = 'transcript';
        break;
      }
      case 'tool_execution_end': {
        const rawId = String(evt.toolCallId ?? '');
        const mapKey = activeToolMapKey(rawId);
        const existing = ep.activeTools.get(mapKey);
        if (existing) {
          ep.activeTools.set(
            mapKey,
            projectActiveToolEntry({
              toolCallId: existing.toolCallId,
              toolName: existing.toolName,
              args: existing.args,
              partialResult: evt.result !== undefined ? evt.result : existing.partialResult,
              isError: Boolean(evt.isError),
              ended: true,
            })
          );
        }
        ep.streamRevision += 1;
        kind = 'transcript';
        break;
      }
      case 'queue_update':
        ep.steeringQueue = projectQueueEntries(evt.steering);
        ep.followUpQueue = projectQueueEntries(evt.followUp);
        // Same queueCount with different content must invalidate detail cache.
        ep.streamRevision += 1;
        break;
      case 'compaction_start':
        ep.isCompacting = true;
        break;
      case 'compaction_end':
        ep.isCompacting = false;
        break;
      case 'auto_retry_start':
        ep.isRetrying = true;
        break;
      case 'auto_retry_end':
        ep.isRetrying = false;
        break;
      case 'extension_ui_request':
        // Diagnostics only; transport already cancels dialogs.
        return;
      default:
        break;
    }
    publish(ep, kind);
  }

  async function spawnTransport(
    ep: InteractiveAgentEndpoint,
    generation: number
  ): Promise<PiRpcTransport | InteractiveAgentTransport> {
    const spec = ep.launchSpec;
    if (!spec) {
      throw new InteractiveAgentError('validation_error', 'Missing launch specification');
    }

    const artifact =
      ep.sessionArtifact ??
      spec.sessionArtifact ??
      (ep.sessionFile
        ? ({ runtime: 'pi' as const, sessionFile: ep.sessionFile } as const)
        : undefined);
    const isGrokAcp = artifact?.runtime === 'grok-acp';

    let tmpPromptPath: string | undefined;
    let tmpPromptDir: string | undefined;
    let transport: PiRpcTransport | InteractiveAgentTransport | undefined;
    let handshakeOk = false;
    let transportDisposed = false;
    let leaseHandedToTransport = false;

    const isCurrentGeneration = (): boolean => {
      const current = endpoints.get(ep.key);
      return !!current && current.transportGeneration === generation;
    };

    // Pre-acquire canonical session lease BEFORE any temp-prompt / factory / getState
    // work so a hanging factory still fail-closes same-session spawns cross-registry.
    // acquire waits for the previous owner (never self — we have no token yet).
    await awaitDisposeBarrier(ep.key);
    if (!isCurrentGeneration()) {
      throw new InteractiveAgentError('rejected', 'Transport generation superseded');
    }
    const leaseKey = isGrokAcp
      ? buildSessionLeaseKey({
          runtime: 'grok-acp',
          cwd: ep.worktreePath ?? ep.effectiveCwd,
          sessionIdentity: artifact.sessionId,
        })
      : ep.sessionFile;
    if (isGrokAcp && !leaseKey) {
      throw new InteractiveAgentError(
        'acp_session_unavailable',
        'Grok ACP spawn requires a non-empty sessionId'
      );
    }
    const lease = await acquireSessionLease(leaseKey);
    // Track pre-acquired lease so shutdown deadline can sticky-settle even when
    // the factory has not returned a transport yet (not in shuttingDownTransports).
    const pending = beginPendingOwner({
      key: ep.key,
      generation,
      release: (err) => lease.release(err),
    });
    const releaseLease = pending.release;

    const disposeSpawned = async (): Promise<void> => {
      // Already scheduled dispose for this spawn: do not release early — the in-flight
      // dispose callback owns lease settlement (success or sticky fail-closed).
      if (transportDisposed) return;
      if (!transport) {
        // No live transport: release the pre-acquired lease immediately.
        releaseLease();
        return;
      }
      transportDisposed = true;
      // Dispose immediately and register on the endpoint barrier for later spawns.
      // Do not await disposeTracked's barrier chain: abort may have chained that
      // barrier behind `ready` (this spawn), which would deadlock. Also do not
      // await the dispose promise itself — killTimeout/gates must not block the
      // spawn rejection path. Session lease stays held until dispose settles.
      // Still share the module WeakMap so shutdown/hydrate/register/execution
      // never invoke transport.dispose() twice for the same instance.
      const owned = transport;
      if (shutdownTransportBag) {
        shutdownTransportBag.push(owned);
      }
      let work = transportDisposePromises.get(owned);
      if (!work) {
        work = Promise.resolve()
          .then(() => owned.dispose())
          .then(
            () => {
              const rel = transportLeaseReleases.get(owned);
              if (rel) {
                transportLeaseReleases.delete(owned);
                // Clean release only when this handle still owns settlement. If
                // shutdown already sticky-settled via the same handle, lease.release
                // is a no-op (settled guard). Never install a second clean path.
                rel();
              } else {
                // Transport map entry already consumed (e.g. deadline sticky-settle).
                // Still call releaseLease so pending bookkeeping clears;
                // session-lease settle is a no-op once sticky.
                releaseLease();
              }
            },
            (err) => {
              const rel = transportLeaseReleases.get(owned);
              const e = err instanceof Error ? err : new Error(String(err));
              if (rel) {
                transportLeaseReleases.delete(owned);
                rel(e);
              } else {
                releaseLease(e);
              }
              throw err;
            }
          );
        transportDisposePromises.set(owned, work);
      }
      void noteDispose(ep.key, work);
    };

    const attachTransportEvents = (t: PiRpcTransport | InteractiveAgentTransport): void => {
      t.subscribe((event) => {
        // Generation guard: stale T1 must never write through T2's endpoint.
        if (!isCurrentGeneration()) return;

        if (isPiRpcTransportExitEvent(event)) {
          // Seal pre-boundary stream cell before the exit transition.
          const sealed = sealCoalescedStream(ep.key);
          void enqueueTransition(ep.key, () => {
            if (!isCurrentGeneration()) return;
            const current = endpoints.get(ep.key);
            if (!current) return;
            if (event.intentional) return;
            if (current.client && current.client !== t) return;
            if (sealed !== undefined) reduceEvent(current, sealed);
            handleUnexpectedTransportExit(current, event.error.message);
          });
          return;
        }

        const evtType =
          event && typeof event === 'object' ? (event as { type?: unknown }).type : undefined;
        // Cumulative stream deltas: keep only the latest while the transition
        // queue is busy; flush before any non-transcript event.
        if (evtType === 'message_update' || evtType === 'message_start') {
          holdCoalescedStream(ep.key, event);
          return;
        }

        // Non-stream boundary: seal pre-boundary held event now so a later U2
        // cannot be consumed by the flush that runs with this boundary.
        const sealed = sealCoalescedStream(ep.key);
        void enqueueTransition(ep.key, () => {
          if (!isCurrentGeneration()) return;
          const current = endpoints.get(ep.key);
          if (!current) return;
          if (current.client !== t) return;
          if (sealed !== undefined) reduceEvent(current, sealed);
          reduceEvent(current, event);
        });
      });
    };

    try {
      if (!isCurrentGeneration()) {
        releaseLease();
        throw new InteractiveAgentError('rejected', 'Transport generation superseded');
      }

      if (isGrokAcp) {
        // Durable TUI resume/reopen: load the existing ACP session on one connection
        // that will also accept the subsequent prompt (same process owner).
        const configuredModel = spec.modelOverride ?? spec.agent.model;
        transport = await createGrokAcpTransport({
          agent: {
            ...spec.agent,
            model: configuredModel,
            thinking: spec.thinkingOverride ?? spec.agent.thinking,
            runtime: spec.runtimeOverride ?? spec.agent.runtime ?? GROK_ACP_RUNTIME,
          },
          cwd: ep.worktreePath ?? ep.effectiveCwd,
          sessionId: artifact.sessionId,
          spawnFn: options.spawnFn as never,
          configuredModel,
          onLoadComplete: (messages) => {
            if (!isCurrentGeneration()) return;
            // Replace transcript wholesale after the load barrier (no dual reduce).
            replaceFinalizedMessages(ep, messages);
            ep.transcriptHydrated = true;
            // Reopen/activate: baseline is post-load so SingleResult only includes
            // this activation's live prompt messages (not historical replay).
            if (ep.activation && !ep.activation.settled) {
              ep.activation.baselineMessageCount = messages.length;
            }
          },
        });

        pending.bindTransport(transport);
        leaseHandedToTransport = true;

        if (!isCurrentGeneration() || shutDown) {
          await disposeSpawned();
          throw new InteractiveAgentError(
            shutDown ? 'shutdown' : 'rejected',
            shutDown ? 'Interactive registry is shut down' : 'Transport generation superseded'
          );
        }

        attachTransportEvents(transport);

        const cancelErr = new InteractiveAgentError('rejected', 'Transport generation superseded');
        const cancelled = new Promise<never>((_, reject) => {
          spawnCancelByKey.set(ep.key, { generation, reject });
        });
        try {
          await Promise.race([transport.getState(), cancelled]);
        } finally {
          const waiter = spawnCancelByKey.get(ep.key);
          if (waiter && waiter.generation === generation) {
            spawnCancelByKey.delete(ep.key);
          }
        }
        if (!isCurrentGeneration() || shutDown) {
          await disposeSpawned();
          throw shutDown
            ? new InteractiveAgentError('shutdown', 'Interactive registry is shut down')
            : cancelErr;
        }
        handshakeOk = true;
        ep.client = transport;
        ep.lastError = undefined;
        ep.errorCode = undefined;
        // Handshake complete: lease ownership stays on transport map; pending
        // entry is no longer needed for deadline coverage of "no transport yet".
        pending.complete();
        // Lease stays held until this transport's dispose path releases it.
        return transport;
      }

      if (spec.agent.systemPrompt.trim()) {
        const tmp = await writePromptToTempFile(spec.agent.name, spec.agent.systemPrompt);
        tmpPromptPath = tmp.filePath;
        tmpPromptDir = tmp.dir;
      }

      const effectiveAgent: AgentConfig = {
        ...spec.agent,
        model: spec.modelOverride ?? spec.agent.model,
        thinking: spec.thinkingOverride ?? spec.agent.thinking,
        runtime: spec.runtimeOverride ?? spec.agent.runtime,
      };
      const childEnv = buildChildAgentEnv(process.env, { agent: effectiveAgent });
      const disableAgentTool = !isAgentDelegationAllowed(childEnv);
      const args = buildPiRpcArgs(effectiveAgent, {
        tmpPromptPath,
        sessionFile: ep.sessionFile,
        resolvedSkillPaths: spec.resolvedSkillPaths,
        disableAgentTool,
      });
      const invocation = getPiInvocation(args);
      const factory =
        options.transportFactory ?? ((opts: PiRpcTransportOptions) => PiRpcTransport.spawn(opts));

      transport = await factory({
        command: invocation.command,
        args: invocation.args,
        cwd: ep.effectiveCwd,
        env: childEnv,
        spawnFn: options.spawnFn,
      });

      // Bind lease release to this transport before any gen check so late dispose paths
      // (disposeTracked / disposeSpawned) settle the correct owner token.
      pending.bindTransport(transport);
      leaseHandedToTransport = true;

      // Abort/detach may have advanced generation while factory was in flight.
      if (!isCurrentGeneration() || shutDown) {
        await disposeSpawned();
        throw new InteractiveAgentError(
          shutDown ? 'shutdown' : 'rejected',
          shutDown ? 'Interactive registry is shut down' : 'Transport generation superseded'
        );
      }

      // Subscribe before handshake so unexpected exit during get_state is observed.
      attachTransportEvents(transport);

      // Handshake: race get_state against generation cancel so abort/invalidate
      // unblocks waiters without awaiting a hung child RPC.
      const cancelErr = new InteractiveAgentError('rejected', 'Transport generation superseded');
      const cancelled = new Promise<never>((_, reject) => {
        spawnCancelByKey.set(ep.key, { generation, reject });
      });
      try {
        await Promise.race([transport.getState(), cancelled]);
      } finally {
        const waiter = spawnCancelByKey.get(ep.key);
        if (waiter && waiter.generation === generation) {
          spawnCancelByKey.delete(ep.key);
        }
      }
      if (!isCurrentGeneration() || shutDown) {
        await disposeSpawned();
        throw shutDown
          ? new InteractiveAgentError('shutdown', 'Interactive registry is shut down')
          : cancelErr;
      }
      handshakeOk = true;

      if (!isCurrentGeneration() || shutDown) {
        await disposeSpawned();
        throw new InteractiveAgentError(
          shutDown ? 'shutdown' : 'rejected',
          shutDown ? 'Interactive registry is shut down' : 'Transport generation superseded'
        );
      }

      // Only the current generation may install the client.
      ep.client = transport;
      // Handshake success: clear prior reopen/transport error without masking an
      // in-flight failure (we only reach here on successful get_state).
      ep.lastError = undefined;
      ep.errorCode = undefined;
      pending.complete();
      // Lease stays held until this transport's dispose path releases it.
      return transport;
    } catch (err) {
      // Dispose a half-started process before removing startup resources.
      // Tracked on the barrier so a concurrent T2 spawn waits for teardown.
      if (transport && (!handshakeOk || !isCurrentGeneration())) {
        await disposeSpawned();
      } else if (!leaseHandedToTransport) {
        // Factory never returned a transport — may still have spawned then failed
        // dispose. Settle lease with structured certainty (never assume never-spawned).
        releaseSessionLeaseWithCertainty(releaseLease, disposalCertaintyFromCaught(err));
      } else if (!transportDisposed && !handshakeOk) {
        // Transport exists but we are not disposing via disposeSpawned — settle carefully.
        releaseSessionLeaseWithCertainty(releaseLease, disposalCertaintyFromCaught(err));
      }
      throw err;
    } finally {
      // Prompt file is retained until get_state returns (or spawn fails completely).
      if (tmpPromptPath) {
        try {
          fs.unlinkSync(tmpPromptPath);
        } catch {
          /* ignore */
        }
      }
      if (tmpPromptDir) {
        try {
          fs.rmdirSync(tmpPromptDir);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * When the child already reports idle (get_state) but an activation is still
   * open, wait for the real registry agent_settled reduction. Never force-settle:
   * inventing a settle races with a late agent_settled and can close B.
   * On timeout: activation-scoped detach A, then fail so the caller can retry.
   */
  async function syncPendingIdleSettle(key: string): Promise<void> {
    const ep = endpoints.get(key);
    if (!ep?.client || !ep.activation || ep.activation.settled) return;
    // Only reconcile live turns; error/detached reopen has its own dispose path.
    if (
      ep.status !== 'running' &&
      ep.status !== 'starting' &&
      ep.status !== 'idle' &&
      // activation open with registered is rare; treat as live
      ep.status !== 'registered'
    ) {
      return;
    }
    const client = ep.client;
    const activationId = ep.activation.id;
    let state: { isStreaming?: boolean; isCompacting?: boolean; running?: boolean };
    try {
      const raw = await client.getState();
      // Pi RPC exposes isStreaming/isCompacting; Grok ACP uses running/idle.
      state = {
        isStreaming:
          'isStreaming' in raw
            ? Boolean((raw as { isStreaming?: boolean }).isStreaming)
            : Boolean((raw as { running?: boolean }).running),
        isCompacting:
          'isCompacting' in raw ? Boolean((raw as { isCompacting?: boolean }).isCompacting) : false,
        running: 'running' in raw ? Boolean((raw as { running?: boolean }).running) : undefined,
      };
    } catch {
      return;
    }
    // Transport may have been replaced while getState was in flight.
    const after = endpoints.get(key);
    if (!after || after.client !== client) return;
    if (state.isStreaming || state.isCompacting) return;
    if (!after.activation || after.activation.id !== activationId || after.activation.settled) {
      return;
    }

    // Wait for real activation_settled (agent_settled reduced) for this activation.
    const outcome = await new Promise<'settled' | 'timeout'>((resolve) => {
      let done = false;
      const finish = (value: 'settled' | 'timeout') => {
        if (done) return;
        done = true;
        timers.clearTimeout(timer);
        unsub();
        resolve(value);
      };
      const unsub = subscribe((ev) => {
        if (
          ev.type === 'activation_settled' &&
          ev.key === key &&
          ev.activationId === activationId
        ) {
          finish('settled');
        }
      });
      // Already settled between getState and subscribe (e.g. transition drained).
      const cur = endpoints.get(key);
      if (!cur?.activation || cur.activation.id !== activationId || cur.activation.settled) {
        finish('settled');
        return;
      }
      const timer = timers.setTimeout(() => {
        finish('timeout');
      }, idleSettleWaitMs);
    });

    if (outcome === 'timeout') {
      // Activation-scoped detach only — never invent a settle for A under B.
      await detach(key, { activationId });
      throw new InteractiveAgentError(
        'rejected',
        'Prior activation did not settle (idle preflight timeout); detached for retry'
      );
    }
  }

  async function activate(
    key: string,
    message: string,
    mode: InteractiveOutboundMode = 'prompt',
    policy?: InteractiveActivationPolicy,
    origin: InteractiveActivationOrigin = 'view'
  ): Promise<{ activationId: string; snapshot: InteractiveEndpointSnapshot }> {
    assertNotShutdown();
    const trimmed = message.trim();
    if (!trimmed) throw new InteractiveAgentError('blank_message', 'Message is empty');
    if (trimmed.startsWith('/')) {
      throw new InteractiveAgentError('slash_message', 'Slash commands are not allowed');
    }

    // Pre-send settle barrier: if child is already idle, wait for real agent_settled
    // before creating B (Pi 0.80.6 get_state can race ahead of async settle).
    const pre = endpoints.get(key);
    if (pre?.client && pre.activation && !pre.activation.settled) {
      await syncPendingIdleSettle(key);
    }

    // Phase 1: pre-send transition — allocate activation / readiness barrier only.
    const prepared = await enqueueTransition(key, async () => {
      const ep = endpoints.get(key);
      if (!ep) throw new InteractiveAgentError('unavailable', `Unknown endpoint ${key}`);
      if (!isBranchVisible(ep)) {
        throw new InteractiveAgentError('unavailable', 'Endpoint is not on the active branch');
      }
      if (ep.status === 'unavailable') {
        throw new InteractiveAgentError('unavailable', ep.lastError ?? 'Endpoint unavailable');
      }

      // Grok ACP: reject text input while starting/running/active BEFORE creating
      // a second activation or mutating queues/endpoints.
      const isGrokAcpEndpoint =
        ep.sessionArtifact?.runtime === 'grok-acp' ||
        ep.launchSpec?.sessionArtifact?.runtime === 'grok-acp' ||
        (ep.client !== undefined &&
          'runningInput' in ep.client &&
          (ep.client as InteractiveAgentTransport).runningInput === 'unsupported');
      if (
        isGrokAcpEndpoint &&
        (ep.activation || ep.status === 'starting' || ep.status === 'running')
      ) {
        throw new InteractiveAgentError(
          'running_input_unsupported',
          'Grok ACP input is unavailable while running; wait or press Ctrl+X to cancel.'
        );
      }

      // Dispose a failed/stale transport fully before revalidation or spawn
      // (single writer: await dispose barrier before any new process).
      if ((ep.status === 'error' || ep.status === 'detached') && ep.client) {
        const failed = ep.client;
        ep.client = undefined;
        ep.transportReady = undefined;
        ep.transportGeneration += 1;
        rejectSpawnWaiter(
          key,
          new InteractiveAgentError('rejected', 'Transport generation superseded')
        );
        await disposeTracked(key, failed);
        ep.transcriptHydrated = false;
      }

      // Revalidation must complete before activation assignment so a throw cannot
      // leave an unsettled zombie activation (no activation_settled mis-event).
      const needsReopenSpawn =
        !ep.client &&
        !ep.transportReady &&
        (ep.status === 'error' || ep.status === 'detached' || ep.status === 'registered');
      if (needsReopenSpawn && (ep.status === 'error' || ep.status === 'detached')) {
        await revalidateForReopen(ep);
      }

      let effectiveMode = mode;
      if (ep.activation || ep.status === 'starting' || ep.status === 'running') {
        if (mode === 'prompt') effectiveMode = 'steer';
      } else if (
        ep.status === 'idle' ||
        ep.status === 'detached' ||
        ep.status === 'error' ||
        ep.status === 'registered'
      ) {
        // Idle/detached: demote stale steer/follow_up to a fresh prompt turn.
        effectiveMode = mode === 'steer' || mode === 'follow_up' ? 'prompt' : mode;
      }
      // Grok ACP never steers or follow-ups — always prompt when idle.
      if (isGrokAcpEndpoint) {
        effectiveMode = 'prompt';
      }

      // Baseline must include any prior session messages on reopen.
      // Hydrate failures throw here — before activation assignment — so activate
      // never leaves a zombie activation without activation_settled.
      // Pi: hydrate from session file. Grok ACP: skip hydrate-only (lease gap);
      // spawnTransport loads once, sets baseline after the load barrier, then prompts.
      if (!ep.activation) {
        if (!isGrokAcpEndpoint) {
          await ensureTranscriptHydrated(ep, { required: true });
        }
      }

      const activationId = `act_${++sequenceCounter}_${now()}`;
      if (!ep.activation) {
        // Invalidate any deferred idle retention scheduled for the prior settle.
        bumpIdleRetentionEpoch(key);
        ep.activation = {
          id: activationId,
          endpointKey: key,
          mode: effectiveMode,
          baselineMessageCount: ep.messages.length,
          sequence: sequenceCounter,
          policy,
          origin,
          settled: false,
          createdAt: now(),
        };
        // New activation resets outbound poison so a prior failed prompt cannot
        // block a fresh turn after reopen/retry.
        outboundPoisonByKey.delete(key);
        // Drop prior-run terminal stopReason (e.g. aborted) so list/widget glyphs
        // do not keep interrupted ⊘ when this turn settles without a new reason.
        if (ep.usage?.stopReason !== undefined) {
          delete ep.usage.stopReason;
        }
      } else if (policy?.maxTurns && !ep.activation.policy?.maxTurns) {
        ep.activation.policy = { ...ep.activation.policy, ...policy };
      }

      // Ensure a single shared transportReady barrier exists for concurrent waiters.
      if (!ep.client && !ep.transportReady) {
        // Wait for any prior dispose (abort/detach/invalidate/cross-registry) before spawning.
        await awaitSpawnDisposeBarriers(key, endpointLeaseKey(ep));
        ep.status = 'starting';
        publish(ep);
        const generation = ++ep.transportGeneration;
        const ready = spawnTransport(ep, generation)
          .then((transport) => {
            // Install only if this generation is still current (T1 late success
            // after T2 must not overwrite ep.client or clear T2).
            if (ep.transportGeneration !== generation) {
              void disposeTracked(ep.key, transport);
              throw new InteractiveAgentError('rejected', 'Transport generation superseded');
            }
            ep.client = transport;
            // Client is installed; drop the ready handle so shutdown/detach
            // dispose the client once (not via ready + client).
            if (ep.transportReady === ready) ep.transportReady = undefined;
            return transport;
          })
          .catch((err) => {
            // Stale generation failure must not mark the live endpoint as error.
            if (ep.transportGeneration !== generation) {
              throw err;
            }
            ep.status = 'error';
            ep.lastError = err instanceof Error ? err.message : String(err);
            // Preserve structured codes (GrokAcpClientError / InteractiveAgentError).
            const structured =
              err instanceof InteractiveAgentError
                ? err.code
                : err &&
                    typeof err === 'object' &&
                    'code' in err &&
                    typeof (err as { code?: unknown }).code === 'string'
                  ? (err as { code: string }).code
                  : undefined;
            ep.errorCode = structured ?? 'transport_error';
            ep.transportReady = undefined;
            if (ep.activation && !ep.activation.settled) {
              // Leave activation for phase-2 catch / abort to settle once.
            }
            publish(ep);
            throw err;
          });
        ep.transportReady = ready;
      }

      // Capture the readiness barrier now: a later failed spawn clears
      // ep.transportReady, but phase 2 must still observe the rejection reason.
      const readyBarrier: Promise<PiRpcTransport | InteractiveAgentTransport> | undefined =
        ep.client ? Promise.resolve(ep.client) : ep.transportReady;
      return {
        activationId: ep.activation.id,
        effectiveMode,
        ep,
        readyBarrier,
      };
    });

    // Phase 2: RPC send outside the endpoint transition queue, but serialized
    // per endpoint so concurrent steer/follow_up preserve acceptance order.
    // Fail-closed on the same activation: a failed prompt poisons later writes.
    try {
      await enqueueOutbound(key, prepared.activationId, async () => {
        const current = endpoints.get(key);
        if (!current) {
          throw new InteractiveAgentError('unavailable', `Unknown endpoint ${key}`);
        }
        // Startup-barrier abort: do not issue the initial prompt.
        if (
          !current.activation ||
          current.activation.id !== prepared.activationId ||
          current.activation.settled ||
          current.activation.terminalOverride === 'cancelled'
        ) {
          throw new InteractiveAgentError('rejected', 'Activation cancelled before send');
        }

        const ready =
          prepared.readyBarrier ??
          (current.client ? Promise.resolve(current.client) : current.transportReady);
        if (!ready) {
          throw new InteractiveAgentError('rejected', 'Activation cancelled before send');
        }
        // Race readiness against activation cancel so a hung handshake cannot
        // block the outbound queue after abort/settle of this activation.
        const transport = await new Promise<PiRpcTransport | InteractiveAgentTransport>(
          (resolve, reject) => {
            let settled = false;
            const finish = (fn: () => void) => {
              if (settled) return;
              settled = true;
              unsub();
              fn();
            };
            const unsub = subscribe((ev) => {
              if (ev.type === 'activation_settled' && ev.activationId === prepared.activationId) {
                finish(() =>
                  reject(new InteractiveAgentError('rejected', 'Activation cancelled before send'))
                );
              }
            });
            // Already cancelled before we subscribed.
            const snap = endpoints.get(key);
            if (
              !snap?.activation ||
              snap.activation.id !== prepared.activationId ||
              snap.activation.settled ||
              snap.activation.terminalOverride === 'cancelled'
            ) {
              finish(() =>
                reject(new InteractiveAgentError('rejected', 'Activation cancelled before send'))
              );
              return;
            }
            void ready.then(
              (t) => finish(() => resolve(t)),
              (err) => finish(() => reject(err))
            );
          }
        );

        const after = endpoints.get(key);
        if (
          !after?.activation ||
          after.activation.id !== prepared.activationId ||
          after.activation.settled ||
          after.activation.terminalOverride === 'cancelled'
        ) {
          // Cancel-ready race: always dispose via tracked helper so lease releases
          // and dispose barriers stay consistent (never raw transport.dispose()).
          if (after?.client === transport) {
            after.client = undefined;
          }
          try {
            await disposeTracked(key, transport, after?.sessionFile);
          } catch (disposeErr) {
            const disposeError =
              disposeErr instanceof Error ? disposeErr : new Error(String(disposeErr));
            throw new InteractiveAgentError('dispose_failed', disposeError.message);
          }
          throw new InteractiveAgentError('rejected', 'Activation cancelled before send');
        }

        // Grok ACP (and any transport with runningInput unsupported) rejects
        // steer/follow-up while starting/running; only idle prompt is accepted.
        const runningInput =
          'runningInput' in transport
            ? (transport as InteractiveAgentTransport).runningInput
            : 'steer-follow-up';
        if (
          runningInput === 'unsupported' &&
          prepared.effectiveMode !== 'prompt' &&
          (after.status === 'starting' || after.status === 'running')
        ) {
          throw new InteractiveAgentError(
            'running_input_unsupported',
            'Grok ACP input is unavailable while running; wait or press Ctrl+X to cancel.'
          );
        }

        if (prepared.effectiveMode === 'prompt') {
          await transport.prompt(trimmed);
        } else if (prepared.effectiveMode === 'steer') {
          if (typeof transport.steer === 'function') {
            await transport.steer(trimmed);
          } else {
            throw new InteractiveAgentError(
              'running_input_unsupported',
              'Steer is not supported for this interactive runtime'
            );
          }
        } else if (typeof transport.followUp === 'function') {
          await transport.followUp(trimmed);
        } else {
          throw new InteractiveAgentError(
            'running_input_unsupported',
            'Follow-up is not supported for this interactive runtime'
          );
        }
      });

      // Phase 3: post-send acceptance tagged with activation id.
      await enqueueTransition(key, () => {
        const current = endpoints.get(key);
        if (!current?.activation || current.activation.id !== prepared.activationId) return;
        if (current.activation.settled) return;
        current.lastUsedAt = now();
        if (
          current.status === 'registered' ||
          current.status === 'detached' ||
          current.status === 'error'
        ) {
          current.status = 'starting';
        }
        publish(current);
      });
    } catch (err) {
      await enqueueTransition(key, () => {
        const current = endpoints.get(key);
        if (!current) return;
        if (current.activation?.id === prepared.activationId && !current.activation.settled) {
          const cancelled =
            err instanceof InteractiveAgentError && err.code === 'rejected' ? 'cancelled' : 'error';
          current.activation.settled = true;
          current.activation.error = err instanceof Error ? err.message : String(err);
          current.activation.terminalOverride = cancelled;
          if (cancelled === 'error') {
            current.status = 'error';
            current.lastError = current.activation.error;
            // Preserve structured codes — never blanket-overwrite as transport_error.
            const structured =
              err instanceof InteractiveAgentError
                ? err.code
                : err &&
                    typeof err === 'object' &&
                    'code' in err &&
                    typeof (err as { code?: unknown }).code === 'string'
                  ? (err as { code: string }).code
                  : undefined;
            current.errorCode = structured ?? 'transport_error';
          } else {
            markCancelledUsage(current);
            if (current.status === 'starting') {
              current.status = 'detached';
            }
          }
          const settledId = current.activation.id;
          publish(current);
          emit({
            type: 'activation_settled',
            key,
            activationId: settledId,
            snapshot: snapshotOf(current),
          });
          current.activation = undefined;
          // After final non-running status + settled publish, schedule idle retention.
          scheduleIdleTranscriptEviction(current);
        }
      });
      throw err;
    }

    const final = endpoints.get(key);
    return {
      activationId: prepared.activationId,
      snapshot: final ? snapshotOf(final) : snapshotOf(prepared.ep),
    };
  }

  async function send(
    key: string,
    message: string,
    mode: InteractiveOutboundMode = 'prompt'
  ): Promise<InteractiveEndpointSnapshot> {
    const result = await activate(key, message, mode, undefined, 'view');
    return result.snapshot;
  }

  async function abort(key: string): Promise<InteractiveEndpointSnapshot> {
    assertNotShutdown();
    return enqueueTransition(key, () => {
      const ep = endpoints.get(key);
      if (!ep) throw new InteractiveAgentError('unavailable', `Unknown endpoint ${key}`);

      // Live client: mark terminal override + publish inside the queue, then
      // fire-and-catch abort RPC (must not await up to 30s transport timeout here —
      // that would block agent_settled processing on the same transition queue).
      if (ep.client && (ep.activation || ep.status === 'running' || ep.status === 'starting')) {
        if (ep.activation && !ep.activation.terminalOverride) {
          ep.activation.terminalOverride = 'cancelled';
        }
        const client = ep.client;
        const activationId = ep.activation?.id;
        void client.abort().catch(() => undefined);
        if (activationId) {
          armAbortSettleTimeout(key, activationId);
        }
        return publish(ep);
      }

      // Handshake / pre-prompt: cancel the activation and tear down any in-flight spawn
      // so the initial prompt never runs and waiters settle as cancelled. Bounded:
      // no await of dispose inside the queue (tracked on the dispose barrier so the
      // next spawn waits). Reject spawn waiters so getState cannot hang forever.
      if (ep.activation && !ep.activation.settled) {
        ep.activation.terminalOverride = 'cancelled';
        const ready = ep.transportReady;
        const sessionFile = ep.sessionFile;
        ep.transportReady = undefined;
        // Invalidate in-flight spawn so late T1 handshake cannot install itself.
        ep.transportGeneration += 1;
        rejectSpawnWaiter(
          key,
          new InteractiveAgentError('rejected', 'Transport generation superseded')
        );
        if (ready) {
          void noteReadyDispose(key, sessionFile, ready);
        }
        if (ep.client) {
          const client = ep.client;
          ep.client = undefined;
          void disposeTracked(key, client, sessionFile);
        }
        clearAbortSettleTimer(key);
        // Final non-running status before settle so retention scheduling is not skipped.
        if (ep.status === 'starting' || ep.status === 'registered') {
          ep.status = 'detached';
        }
        settleActivationError(ep, 'Activation cancelled', 'cancelled');
        return snapshotOf(ep);
      }

      return publish(ep);
    });
  }

  /**
   * Detach transport and optionally remove the endpoint.
   * When `activationId` is set, no-op unless that activation is still current —
   * used by settle timers so a late timeout cannot settle/detach a later activation B.
   */
  async function detach(
    key: string,
    options: {
      remove?: boolean;
      activationId?: string;
      evictTranscript?: boolean;
      /** When set, no-op if a newer activation bumped the idle retention epoch. */
      retentionEpoch?: number;
      /** When set, only detach endpoints that are still idle with no open activation. */
      requireIdle?: boolean;
    } = {}
  ): Promise<void> {
    const ep = endpoints.get(key);
    if (!ep) return;
    await enqueueTransition(key, async () => {
      const current = endpoints.get(key);
      if (!current) return;
      // Retention-scoped: stale oversized/LRU cleanup must not touch a newer turn.
      if (options.retentionEpoch !== undefined) {
        if (getIdleRetentionEpoch(key) !== options.retentionEpoch) return;
        // Never force-settle an in-flight activation from deferred retention work.
        if (current.activation && !current.activation.settled) return;
        if (current.status === 'starting' || current.status === 'running') return;
      }
      // LRU-scoped: a victim selected while idle must not be torn down after a new turn starts.
      if (options.requireIdle) {
        if (current.activation && !current.activation.settled) return;
        if (current.status !== 'idle') return;
      }
      // Activation-scoped: timer for A must not detach B.
      if (options.activationId !== undefined) {
        if (!current.activation || current.activation.id !== options.activationId) {
          return;
        }
      }
      // Force-settle any open activation so timeout/detach never leaves zombies
      // that subsequent send/activate would reuse.
      let settledOpenActivation = false;
      if (current.activation && !current.activation.settled) {
        const terminal = current.activation.terminalOverride ?? 'error';
        const reason =
          terminal === 'max_turns'
            ? 'max_turns settle timeout'
            : terminal === 'cancelled'
              ? 'Endpoint detached'
              : 'Endpoint detached';
        // Detach's terminal status is detached (non-running) before settle so the
        // activation_settled snapshot is terminal and retention scheduling is not skipped.
        if (
          current.status === 'starting' ||
          current.status === 'running' ||
          current.status === 'registered'
        ) {
          current.status = 'detached';
        }
        // Publishes the complete pre-eviction snapshot, emits activation_settled, clears
        // activation, then queues retention. Never clear the transcript synchronously here.
        settleActivationError(current, reason, terminal);
        settledOpenActivation = true;
      } else if (current.activation) {
        current.activation = undefined;
      }
      clearAbortSettleTimer(key);
      const ready = current.transportReady;
      const sessionFile = current.sessionFile;
      current.transportReady = undefined;
      current.transportGeneration += 1;
      rejectSpawnWaiter(
        key,
        new InteractiveAgentError('rejected', 'Transport generation superseded')
      );
      // Drop idle client / start dispose before clearing the transcript view.
      if (ready) {
        void noteReadyDispose(key, sessionFile, ready);
      }
      if (current.client) {
        const client = current.client;
        current.client = undefined;
        // Do not block the transition queue on dispose (kill may take killTimeoutMs);
        // track on the barrier so a later reopen spawn waits for process teardown.
        void disposeTracked(key, client, sessionFile);
      }
      clearTransientActivity(current);
      coalescedStreamEvents.delete(key);
      streamCoalesceScheduled.delete(key);
      coalesceCellSeq.delete(key);
      outboundPoisonByKey.delete(key);
      // Detach always ends non-unavailable endpoints as detached (even when force-settle
      // temporarily used error/idle to leave the running state before activation_settled).
      if (current.status !== 'unavailable') {
        current.status = 'detached';
      }
      if (options.evictTranscript !== false) {
        // Default: detach also releases the in-memory transcript when oversized or requested.
        const total = finalizedTranscriptArrayBytes(current.finalizedMessageBytes ?? []);
        const shouldEvict =
          options.evictTranscript === true || total > INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES;
        if (shouldEvict) {
          if (settledOpenActivation) {
            // Defer eviction to a later microtask/transition so activation_settled
            // consumers always observe the immutable pre-eviction snapshot first.
            // Capture epoch so a newer activation makes this stale eviction no-op.
            const keyToEvict = key;
            const epoch = getIdleRetentionEpoch(keyToEvict);
            queueMicrotask(() => {
              void enqueueTransition(keyToEvict, () => {
                if (getIdleRetentionEpoch(keyToEvict) !== epoch) return;
                const ep = endpoints.get(keyToEvict);
                if (!ep) return;
                if (ep.status === 'starting' || ep.status === 'running') return;
                if (ep.activation && !ep.activation.settled) return;
                if (ep.finalizedMessagesView.length === 0) return;
                evictFinalizedTranscript(ep);
                publish(ep, 'full');
              });
            });
          } else {
            // Still revalidate: never clear a transcript that a newer activation owns.
            if (!current.activation || current.activation.settled) {
              evictFinalizedTranscript(current);
            }
          }
        }
      }
      if (options.remove) {
        releaseSessionFile(key, current.sessionFile);
        treeClaimKeys.delete(key);
        revokeTrustedBranch(key);
        endpoints.delete(key);
        emitEndpointsChanged();
      } else if (!settledOpenActivation) {
        // Settled path already published the pre-eviction snapshot; avoid a duplicate
        // full publish in the same turn (deferred eviction publishes later).
        publish(current, 'full');
      }
    });
  }

  async function enforceIdleLru(): Promise<void> {
    const idle = [...endpoints.values()]
      .filter((e) => e.status === 'idle' && e.client)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (idle.length > idleLimit) {
      const victim = idle.shift();
      if (!victim) break;
      await detach(victim.key, { evictTranscript: true, requireIdle: true });
    }
  }

  /** Wrap any dispose rejection as dispose_failed; preserve existing dispose_failed. */
  function asDisposeFailed(err: Error): InteractiveAgentError {
    if (err instanceof InteractiveAgentError && err.code === 'dispose_failed') return err;
    if (isDisposeFailedError(err)) {
      return err instanceof InteractiveAgentError
        ? err
        : new InteractiveAgentError('dispose_failed', err.message || 'Dispose failed');
    }
    return new InteractiveAgentError(
      'dispose_failed',
      err.message || 'Registry shutdown dispose failed'
    );
  }

  function shutdown(): Promise<void> {
    // Single cached promise: first/repeat callers share success or the same rejection.
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = runShutdown();
    return shutdownPromise;
  }

  async function runShutdown(): Promise<void> {
    shutDown = true;
    // Absolute real-time deadline for abort + settle + dispose + barrier.
    // Uses Date.now() (not the injectable clock) so a fixed test clock cannot
    // freeze remainingMs and hang shutdown forever.
    const realNow = () => Date.now();
    const deadlineAt = realNow() + shutdownDisposeBudgetMs;
    const remainingMs = () => Math.max(0, deadlineAt - realNow());
    // Single non-resetting deadline promise/timer for the whole drain loop.
    let timedOut = false;
    let deadlineTimer: unknown;
    const deadlinePromise = new Promise<void>((resolve) => {
      deadlineTimer = timers.setTimeout(() => {
        timedOut = true;
        resolve();
      }, shutdownDisposeBudgetMs);
    });
    const keys = [...endpoints.keys()];
    /** Live transports taken for dispose — used to fail-closed leases on timeout. */
    const shuttingDownTransports: Array<PiRpcTransport | InteractiveAgentTransport> = [];
    shutdownTransportBag = shuttingDownTransports;

    try {
      for (const key of keys) {
        clearAbortSettleTimer(key);
        const ep = endpoints.get(key);
        if (!ep) continue;
        // Invalidate generation immediately so late factory/getState is guarded
        // and disposed even after maps are cleared at the end of shutdown.
        ep.transportGeneration += 1;
        if (ep.client && (ep.status === 'running' || ep.status === 'starting' || ep.activation)) {
          // Fire-and-catch abort; do not await the full RPC timeout.
          void ep.client.abort().catch(() => undefined);
        }
        // Force-settle any leftover activation so shutdown never hangs waiters.
        if (ep.activation && !ep.activation.settled) {
          settleActivationError(ep, 'Registry shutdown', 'cancelled');
        }
        rejectSpawnWaiter(
          key,
          new InteractiveAgentError('shutdown', 'Interactive registry is shut down')
        );
        const ready = ep.transportReady;
        const sessionFile = ep.sessionFile;
        ep.transportReady = undefined;
        if (ep.client) {
          // Live client owns dispose; do not also dispose via ready (same transport).
          const client = ep.client;
          ep.client = undefined;
          shuttingDownTransports.push(client);
          // Track on barriers. Session lease stays sticky on dispose failure so a
          // new registry cannot open the same session identity.
          void disposeTracked(key, client, sessionFile);
        } else if (ready) {
          // Handshake-only: on success dispose via disposeTracked; on reject the
          // spawn path's disposeSpawned notes barrier work asynchronously. Never
          // treat ready rejection as "no dispose" — dynamic drain waits for late
          // disposeTracked/noteDispose registrations under the shared deadline.
          void noteDispose(
            key,
            ready.then(
              (transport) => {
                shuttingDownTransports.push(transport);
                return disposeTracked(key, transport, sessionFile);
              },
              async () => {
                // Yield so spawnTransport catch can register disposeSpawned on the
                // barrier before the first drain iteration snapshots work.
                await Promise.resolve();
              }
            )
          );
        }
        releaseSessionFile(key, ep.sessionFile);
      }

      // Dispose every pending owner that already has a transport but is not yet
      // installed as ep.client (hydrate-only, registerGrokAcpLive mid-binding,
      // spawn between factory return and handshake install).
      for (const entry of pendingOwners.values()) {
        if (!entry.transport) continue;
        const alreadyQueued = shuttingDownTransports.includes(entry.transport);
        if (alreadyQueued) continue;
        shuttingDownTransports.push(entry.transport);
        const barrierKey = entry.key ?? `pending:${entry.ownerId}`;
        void disposeTracked(barrierKey, entry.transport);
      }

      // Dynamic work set: keep draining disposeBarriers + pending owners until
      // empty or deadline. Late disposeTracked (getState hang → disposeSpawned,
      // hydrate factory return, registerGrokAcpLive mid-await) must still be
      // observed; a single snapshot would miss them and falsely succeed.
      const disposeErrors: Error[] = [];
      const trackedBarriers = new Set<Promise<void>>();
      const inFlight = new Set<Promise<void>>();

      const trackBarrier = (p: Promise<void>): void => {
        if (trackedBarriers.has(p)) return;
        trackedBarriers.add(p);
        const settled = p.then(
          () => undefined,
          (err) => {
            disposeErrors.push(err instanceof Error ? err : new Error(String(err)));
          }
        );
        inFlight.add(settled);
        void settled.finally(() => {
          inFlight.delete(settled);
        });
      };

      while (true) {
        for (const p of disposeBarriers.values()) {
          trackBarrier(p);
        }
        const hasPendingOwners = pendingOwners.size > 0;
        if (inFlight.size === 0 && !hasPendingOwners) {
          // One more scan: a just-settled barrier may have unblocked a microtask
          // that registered new disposal (disposeSpawned after ready reject).
          await Promise.resolve();
          for (const p of disposeBarriers.values()) {
            trackBarrier(p);
          }
          // Also pick up transports bound to pending owners after the yield.
          for (const entry of pendingOwners.values()) {
            if (!entry.transport) continue;
            if (shuttingDownTransports.includes(entry.transport)) continue;
            shuttingDownTransports.push(entry.transport);
            const barrierKey = entry.key ?? `pending:${entry.ownerId}`;
            void disposeTracked(barrierKey, entry.transport);
          }
          for (const p of disposeBarriers.values()) {
            trackBarrier(p);
          }
          if (inFlight.size === 0 && pendingOwners.size === 0) break;
        }
        if (timedOut || remainingMs() <= 0) {
          timedOut = true;
          break;
        }
        await Promise.race([
          // When no barrier work but pending owners lack transport yet, wait only
          // on the shared deadline (or a short real tick for late factory registration).
          inFlight.size > 0
            ? Promise.all([...inFlight])
            : new Promise<void>((resolve) => {
                const tick = timers.setTimeout(() => resolve(), Math.min(remainingMs() || 5, 5));
                void tick;
              }),
          deadlinePromise,
        ]);
        if (timedOut) break;
        if (remainingMs() <= 0 && (inFlight.size > 0 || pendingOwners.size > 0)) {
          timedOut = true;
          break;
        }
      }

      // Background cleanup continues after deadline; do not cancel dispose work.
      if (timedOut) {
        // Fail-closed any lease still bound to a shutting-down transport
        // (live client path and late disposeSpawned handshake path).
        const timeoutErr = new InteractiveAgentError(
          'dispose_failed',
          'Registry shutdown dispose deadline exceeded'
        );
        for (const t of shuttingDownTransports) {
          const rel = transportLeaseReleases.get(t);
          if (rel) {
            transportLeaseReleases.delete(t);
            rel(timeoutErr);
          }
        }
        // Sticky-settle every still-open pending owner (hydrate/register/spawn).
        // Late factory + clean dispose must not clear this failure.
        for (const entry of [...pendingOwners.values()]) {
          entry.release(timeoutErr);
        }
        pendingOwners.clear();
        disposeErrors.push(timeoutErr);
      }
      shutdownTransportBag = undefined;
      pendingOwners.clear();

      endpoints.clear();
      sessionOwners.clear();
      treeClaimKeys.clear();
      trustedBranchBindings.clear();
      outboundPoisonByKey.clear();
      coalescedStreamEvents.clear();
      streamCoalesceScheduled.clear();
      coalesceCellSeq.clear();
      // Per-endpoint barriers only — process-scoped session leases stay sticky so
      // a new registry cannot bypass incomplete/failed same-session disposal.
      disposeBarriers.clear();
      for (const id of abortSettleTimers.values()) timers.clearTimeout(id);
      abortSettleTimers.clear();
      emit({ type: 'shutdown' });
      listeners.clear();

      // Surface dispose failures to callers (sticky fail-closed must not be swallowed).
      // Every rejection is dispose_failed; only an existing dispose_failed is preserved.
      if (disposeErrors.length > 0) {
        const first = asDisposeFailed(
          disposeErrors[0] instanceof Error ? disposeErrors[0] : new Error(String(disposeErrors[0]))
        );
        if (disposeErrors.length === 1) throw first;
        throw new InteractiveAgentError(
          'dispose_failed',
          `Registry shutdown dispose failed (${disposeErrors.length}): ${first.message}`
        );
      }
    } finally {
      // Always clear the single deadline timer so a fast path leaves no residual.
      if (deadlineTimer !== undefined) {
        timers.clearTimeout(deadlineTimer);
      }
    }
  }

  return {
    registerInitial,
    registerGrokAcpLive,
    restoreActiveBranch,
    listVisible,
    listVisibleMeta,
    get,
    getMutable,
    ensureTranscript,
    subscribe,
    activate,
    send,
    abort,
    detach,
    shutdown,
    isOnActiveBranch,
    setHostLinkAppender,
    appendHostLink,
    /** Test helper */
    _endpoints: endpoints,
    /** Test helper: enqueue a transition for coalesce/ordering assertions. */
    _enqueueTransition: enqueueTransition,
    /** Test helper: per-key dispose barrier. */
    _awaitDisposeBarrier: awaitDisposeBarrier,
    /** Test helper: process-scoped session lease wait (canonical key). */
    _awaitSessionFileDispose: awaitSessionFileDispose,
    /** Test helper: acquire a session lease (canonical key). */
    _acquireSessionLease: acquireSessionLease,
    /** Test helper: canonicalize session lease key. */
    _canonicalizeSessionLeaseKey: canonicalizeSessionLeaseKey,
    /** Test helper: process-scoped lease store sizes. */
    _getSessionLeaseStoreSizes: getSessionLeaseStoreSizesForTest,
    /** Test helper: count of pre-acquired pending owners (hydrate/register/spawn). */
    _pendingOwnerCount: () => pendingOwners.size,
  };
}

export type InteractiveAgentRegistry = ReturnType<typeof createInteractiveAgentRegistry>;

export function isTuiMode(mode: string | undefined): boolean {
  return mode === 'tui';
}
