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
import { DEFAULT_RUNTIME, GROK_ACP_RUNTIME, GROK_RUNTIME } from './constants.ts';
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

export const INTERACTIVE_LINK_TYPE = 'pi-agents-interactive-link';
export const MAX_IDLE_TRANSPORTS = 4;

export type InteractiveEndpointStatus =
  | 'registered'
  | 'starting'
  | 'running'
  | 'idle'
  | 'detached'
  | 'error'
  | 'unavailable';

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
  | 'rejected';

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
}

export interface InteractiveLaunchSpec {
  agent: AgentConfig;
  request: StoredRunRequest;
  resolvedSkillPaths?: string[];
  sessionFile: string;
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
  sessionFile: string;
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
  transportReady?: Promise<PiRpcTransport>;
  lastError?: string;
  errorCode?: InteractiveErrorCode | string;
  client?: PiRpcTransport;
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
> & {
  /** Read-only finalized messages; consumers must not push or mutate nested content. */
  messages: readonly AgentMessage[];
  activeTools: InteractiveToolActivity[];
  hasTransport: boolean;
  queueCount: number;
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

/**
 * Isolate one message for the shared finalized view: clone once then deep-freeze.
 * Call only on message_end / hydrate / restore — never per delta.
 */
function isolateFinalizedMessage(msg: AgentMessage): AgentMessage {
  return freezeDeep(structuredClone(msg));
}

/** Build a frozen readonly array of isolated finalized messages. */
function isolateFinalizedMessages(messages: readonly AgentMessage[]): readonly AgentMessage[] {
  if (messages.length === 0) return EMPTY_FINALIZED;
  return Object.freeze(messages.map((m) => (Object.isFrozen(m) ? m : isolateFinalizedMessage(m))));
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
}

/** Append one finalized message (clone+freeze once) and publish a new readonly array. */
function appendFinalizedMessage(ep: InteractiveAgentEndpoint, msg: AgentMessage): void {
  const frozen = isolateFinalizedMessage(msg);
  const view = Object.freeze([...ep.finalizedMessagesView, frozen]);
  ep.messages = view;
  ep.finalizedMessagesView = view;
  ep.messagesRevision += 1;
}

/**
 * Build a read-only endpoint snapshot with structure sharing.
 * Finalized messages use the stable view (no slice on transcript publishes).
 * Streaming payloads are replaced wholesale by the transport, so the current
 * streamingMessage ref is shared without structuredClone.
 */
function snapshotOf(ep: InteractiveAgentEndpoint): InteractiveEndpointSnapshot {
  return {
    key: ep.key,
    hostSessionId: ep.hostSessionId,
    runId: ep.runId,
    unitId: ep.unitId,
    bindingId: ep.bindingId,
    agent: ep.agent,
    title: ep.title,
    sessionFile: ep.sessionFile,
    effectiveCwd: ep.effectiveCwd,
    worktreePath: ep.worktreePath,
    status: ep.status,
    messages: ep.finalizedMessagesView,
    messagesRevision: ep.messagesRevision,
    streamRevision: ep.streamRevision,
    streamingMessage: ep.streamingMessage,
    activeTools: [...ep.activeTools.values()].map((t) => ({ ...t })),
    steeringQueue: ep.steeringQueue.slice(),
    followUpQueue: ep.followUpQueue.slice(),
    activation: ep.activation ? { ...ep.activation } : undefined,
    lastError: ep.lastError,
    errorCode: ep.errorCode,
    lastUsedAt: ep.lastUsedAt,
    createdAt: ep.createdAt,
    linkCreatedAt: ep.linkCreatedAt,
    usage: ep.usage ? { ...ep.usage } : undefined,
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
    effectiveCwd: ep.effectiveCwd,
    worktreePath: ep.worktreePath,
    status: ep.status,
    lastError: ep.lastError,
    errorCode: ep.errorCode,
    lastUsedAt: ep.lastUsedAt,
    createdAt: ep.createdAt,
    linkCreatedAt: ep.linkCreatedAt,
    usage: ep.usage ? { ...ep.usage } : undefined,
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
 * Process-scoped session writer lease (canonical path → owner).
 * Installed at the start of spawnTransport (before temp prompt / factory / getState)
 * and held until that owner transport confirms dispose or spawn fails with cleanup.
 * Survives registry shutdown so a new registry cannot open the same session while a
 * prior factory hang, dispose, or sticky dispose failure is still outstanding.
 *
 * Store lives on `globalThis` under `Symbol.for` so Jiti `moduleCache: false` reloads
 * (new module instances) still share the same lease map. Process restart clears it.
 */
export type SessionLeaseToken = object;

type SessionLeaseRecord = {
  token: SessionLeaseToken;
  /** Settles when owner releases (resolve) or sticky-fails (reject). */
  done: Promise<void>;
  settle: (err?: Error) => void;
  settled: boolean;
};

const SESSION_LEASE_STORE_VERSION = 1;
const SESSION_LEASE_GLOBAL_KEY = Symbol.for('@balaenis/pi-agents/session-lease-store@v1');

type SessionLeaseStore = {
  version: typeof SESSION_LEASE_STORE_VERSION;
  leases: Map<string, SessionLeaseRecord>;
  /** Serializes concurrent acquire attempts per canonical key (install only). */
  acquireTails: Map<string, Promise<void>>;
};

function isSessionLeaseStore(value: unknown): value is SessionLeaseStore {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<SessionLeaseStore>;
  return (
    v.version === SESSION_LEASE_STORE_VERSION &&
    v.leases instanceof Map &&
    v.acquireTails instanceof Map
  );
}

function getSessionLeaseStore(): SessionLeaseStore {
  const g = globalThis as typeof globalThis & {
    [SESSION_LEASE_GLOBAL_KEY]?: unknown;
  };
  const existing = g[SESSION_LEASE_GLOBAL_KEY];
  if (isSessionLeaseStore(existing)) return existing;
  const store: SessionLeaseStore = {
    version: SESSION_LEASE_STORE_VERSION,
    leases: new Map(),
    acquireTails: new Map(),
  };
  g[SESSION_LEASE_GLOBAL_KEY] = store;
  return store;
}

/**
 * Per-transport release for the lease acquired by that spawn. WeakMap so a disposed
 * transport does not pin the release closure forever. Module-local is fine: transports
 * are never shared across Jiti reloads.
 */
const transportLeaseReleases = new WeakMap<PiRpcTransport, (err?: Error) => void>();

/**
 * Canonical lease key for a session file path.
 * - Existing real path: realpath
 * - Dangling symlink: resolve via lstat/readlink to the target path, then nearest
 *   existing parent realpath + remaining components (stable once the target appears)
 * - Missing planned path: realpath(nearest existing parent) + remaining components
 * Symlink aliases and restore canonical paths must hash to the same key.
 */
export function canonicalizeSessionLeaseKey(sessionFile: string): string {
  if (!sessionFile) return '';
  return canonicalizeResolvedPath(path.resolve(sessionFile), new Set());
}

/**
 * Walk missing path components up to the nearest existing ancestor, realpath that
 * ancestor, and rejoin the trailing components for a stable planned key.
 */
function canonicalizeMissingPath(resolved: string): string {
  const trailing: string[] = [];
  let cur = resolved;
  for (;;) {
    try {
      if (fs.existsSync(cur)) {
        const real = fs.realpathSync(cur);
        return path.normalize(path.join(real, ...trailing.reverse()));
      }
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    trailing.push(path.basename(cur));
    cur = parent;
  }
  return path.normalize(resolved);
}

function canonicalizeResolvedPath(resolved: string, seen: Set<string>): string {
  if (seen.has(resolved)) {
    // Cycle: fall back to planned-missing resolution on the last path.
    return canonicalizeMissingPath(resolved);
  }
  seen.add(resolved);

  try {
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = fs.readlinkSync(resolved);
      } catch {
        return canonicalizeMissingPath(resolved);
      }
      const absTarget = path.resolve(path.dirname(resolved), target);
      // Follow the link text (dangling or not) so alias and final realpath match.
      return canonicalizeResolvedPath(absTarget, seen);
    }
    // Existing non-link: realpath (resolves intermediate dir symlinks).
    return fs.realpathSync(resolved);
  } catch {
    /* path missing — planned or intermediate */
  }
  return canonicalizeMissingPath(resolved);
}

/**
 * Wait for any previous session owner to release (or sticky-fail).
 * Does not await self when `selfToken` matches the current owner (avoids deadlock).
 * Separate from acquire so callers can validate before installing ownership.
 */
export async function awaitSessionLease(
  sessionFile: string,
  selfToken?: SessionLeaseToken
): Promise<void> {
  if (!sessionFile) return;
  const key = canonicalizeSessionLeaseKey(sessionFile);
  const rec = getSessionLeaseStore().leases.get(key);
  if (!rec) return;
  if (selfToken && rec.token === selfToken) return;
  await rec.done;
}

/**
 * Wait for prior owner (if any), then install a new owner deferred.
 * Release only via the returned handle (token-guarded); success deletes the lease,
 * failure keeps a sticky rejected promise (fail-closed).
 * Acquire-tail entries are dropped when the install slot completes so the map
 * does not grow unboundedly across many sessions (sticky leases keep only `leases`).
 */
export async function acquireSessionLease(sessionFile: string): Promise<{
  token: SessionLeaseToken;
  key: string;
  release: (err?: Error) => void;
}> {
  const store = getSessionLeaseStore();
  const key = canonicalizeSessionLeaseKey(sessionFile);
  if (!key) {
    const token: SessionLeaseToken = Object.create(null);
    return { token, key: '', release: () => undefined };
  }

  // Serialize acquire install so two waiters cannot both become owner.
  const prevTail = store.acquireTails.get(key) ?? Promise.resolve();
  let releaseAcquireSlot!: () => void;
  const mySlot = new Promise<void>((r) => {
    releaseAcquireSlot = r;
  });
  const myChain = prevTail.then(
    () => mySlot,
    () => mySlot
  );
  store.acquireTails.set(key, myChain);

  await prevTail.catch(() => undefined);
  try {
    // Prior owner (including sticky fail) must finish before we install.
    const existing = store.leases.get(key);
    if (existing) {
      await existing.done;
    }

    const token: SessionLeaseToken = Object.create(null);
    let settled = false;
    let resolveDone!: () => void;
    let rejectDone!: (e: Error) => void;
    const done = new Promise<void>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    // Sticky rejects must not become unhandled when no waiter is attached yet.
    done.catch(() => undefined);

    const record: SessionLeaseRecord = {
      token,
      done,
      settled: false,
      settle(err?: Error) {
        if (settled) return;
        settled = true;
        record.settled = true;
        if (err) {
          rejectDone(err);
          // Keep rejected entry sticky so later acquires fail closed.
        } else {
          resolveDone();
          if (store.leases.get(key)?.token === token) {
            store.leases.delete(key);
          }
        }
      },
    };
    store.leases.set(key, record);

    return {
      token,
      key,
      release(err?: Error) {
        // Only this owner may settle; ignore late foreign releases.
        if (settled) return;
        const cur = store.leases.get(key);
        if (cur && cur.token !== token) return;
        record.settle(err);
      },
    };
  } finally {
    releaseAcquireSlot();
    // Drop completed acquire tail when we still own the slot entry.
    if (store.acquireTails.get(key) === myChain) {
      store.acquireTails.delete(key);
    }
  }
}

/** @deprecated Use awaitSessionLease — kept as the dispose-barrier alias for call sites. */
async function awaitSessionFileDispose(sessionFile: string): Promise<void> {
  await awaitSessionLease(sessionFile);
}

/**
 * Test seam: process-scoped lease store sizes (leases + acquire tails).
 * Successful acquire/release leaves tails empty; sticky fail retains only leases.
 */
export function getSessionLeaseStoreSizesForTest(): {
  leases: number;
  acquireTails: number;
} {
  const store = getSessionLeaseStore();
  return { leases: store.leases.size, acquireTails: store.acquireTails.size };
}

/** Test seam: Symbol.for key used for the process-scoped lease container. */
export function getSessionLeaseGlobalKeyForTest(): symbol {
  return SESSION_LEASE_GLOBAL_KEY;
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
  const idleLimit = options.idleLimit ?? MAX_IDLE_TRANSPORTS;
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
   * Dispose a transport and track it on the per-endpoint barrier.
   * Session lease release is bound to the transport at spawn time (WeakMap);
   * dispose settles that lease (success or sticky fail-closed).
   */
  function disposeTracked(
    key: string,
    transport: PiRpcTransport,
    _sessionFile?: string
  ): Promise<void> {
    const work = Promise.resolve()
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
    return noteDispose(key, work);
  }

  /** Await endpoint dispose barrier + process-scoped session lease before spawn. */
  async function awaitSpawnDisposeBarriers(key: string, sessionFile: string): Promise<void> {
    await awaitDisposeBarrier(key);
    await awaitSessionLease(sessionFile);
  }

  /**
   * Track dispose of a transport that resolves from a ready promise.
   * Lease was acquired inside spawnTransport; disposeTracked releases it.
   * Spawn rejection without a transport releases the lease in spawnTransport.
   */
  function noteReadyDispose(
    key: string,
    _sessionFile: string,
    ready: Promise<PiRpcTransport>
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
      settleActivationError(ep, reason, 'error');
    } else if (ep.activation) {
      ep.activation = undefined;
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

  function branchHasLink(
    entries: Array<{ type: string; customType?: string; data?: unknown }>,
    runId: string,
    unitId: string
  ): boolean {
    for (const entry of entries) {
      if (entry.type !== 'custom' || entry.customType !== INTERACTIVE_LINK_TYPE) continue;
      if (!isLinkData(entry.data)) continue;
      if (entry.data.runId === runId && entry.data.unitId === unitId) return true;
    }
    return false;
  }

  async function registerInitial(
    input: InteractiveRegisterInput
  ): Promise<InteractiveEndpointSnapshot> {
    assertNotShutdown();
    const key = endpointKey(input.runId, input.unitId);
    if (endpoints.has(key)) {
      const existing = endpoints.get(key)!;
      grantTrustedBranch(key, existing.bindingId);
      return snapshotOf(existing);
    }

    const sessionFile = input.launchSpec.sessionFile;
    if (input.launchSpec.registrationKind === 'initial') {
      // Planned path may not exist yet.
    } else if (!fs.existsSync(sessionFile)) {
      throw new InteractiveAgentError(
        'validation_error',
        `Session file missing for registration: ${sessionFile}`
      );
    }

    claimSessionFile(key, sessionFile);

    const bindingId = crypto.randomBytes(16).toString('hex');
    const createdAt = now();
    const binding: InteractiveAgentBindingV1 = {
      bindingId,
      hostSessionId: input.hostSessionId,
      createdAt,
    };

    try {
      await persistBinding(input.runId, input.unitId, binding);

      if (!branchHasLink(input.getBranchEntries(), input.runId, input.unitId)) {
        const link: InteractiveAgentLinkV1 = {
          version: 1,
          runId: input.runId,
          unitId: input.unitId,
          bindingId,
          hostSessionId: input.hostSessionId,
          createdAt,
        };
        if (input.appendLink) {
          input.appendLink(link);
        } else {
          appendHostLink(link);
        }
      }
    } catch (err) {
      // Binding or link persistence failed: roll back the in-process session claim
      // so a retry can re-register without session_busy.
      releaseSessionFile(key, sessionFile);
      throw err;
    }

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

    const ep: InteractiveAgentEndpoint = {
      key,
      hostSessionId: input.hostSessionId,
      runId: input.runId,
      unitId: input.unitId,
      bindingId,
      agent: launchSpec.agent.name,
      title: launchSpec.title,
      sessionFile,
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
      lastUsedAt: createdAt,
      createdAt,
      linkCreatedAt: createdAt,
      launchSpec,
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
    // Fresh planned path (file not created yet): empty view is authoritative for
    // live turns, but reopen may still need the planned-missing grace flag.
    // Existing session (fork/resume): wait for any prior writer lease, then hydrate
    // so baseline reflects the final JSONL (never a partial dispose write).
    if (!fs.existsSync(sessionFile)) {
      ep.transcriptHydrated = true;
      ep.allowPlannedMissingSession = true;
    } else {
      // Non-read validation (claim/bind/path) already completed above; only now read.
      await awaitSessionLease(sessionFile);
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
    endpoints.set(key, ep);
    grantTrustedBranch(key, bindingId);
    emitEndpointsChanged();
    return publish(ep);
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
    if (unit.capability !== 'session') return { ok: false, reason: 'non_session_capability' };
    const runtime = unit.runtime ?? record.request.runtime ?? DEFAULT_RUNTIME;
    if (runtime === GROK_RUNTIME || runtime === GROK_ACP_RUNTIME) {
      return { ok: false, reason: 'non_pi_runtime' };
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
    if (!unit.sessionFile) return { ok: false, reason: 'session_missing' };

    const sessionsDir = path.join(loaded.loaded.runDir, 'sessions');
    const resolvedSessionsDir = fs.existsSync(sessionsDir)
      ? fs.realpathSync(sessionsDir)
      : path.resolve(sessionsDir);
    let resolvedSession: string;
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
        effectiveCwd,
        worktreePath: unit.worktreePath,
        agent,
        request,
        agentScope,
        resolvedSkillPaths,
        modelOverride: request.model,
        thinkingOverride: request.thinking,
        runtimeOverride: request.runtime,
        isolation: request.isolation,
        title: request.title,
      },
    };
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
      existing.errorCode = reason === 'session_busy' ? 'session_busy' : 'unavailable';
      existing.bindingId = link.bindingId;
      existing.hostSessionId = link.hostSessionId;
      existing.linkCreatedAt = link.createdAt;
      // unavailable→ later trusted restore must rehydrate, not trust empty view.
      // Bump messagesRevision so detail caches never reuse the prior history.
      existing.transcriptHydrated = false;
      if (existing.messages.length > 0 || existing.finalizedMessagesView.length > 0) {
        existing.messages = EMPTY_FINALIZED;
        existing.finalizedMessagesView = EMPTY_FINALIZED;
        existing.messagesRevision += 1;
      } else {
        existing.messages = EMPTY_FINALIZED;
        existing.finalizedMessagesView = EMPTY_FINALIZED;
      }
      Object.assign(existing, extra);
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
      errorCode: reason === 'session_busy' ? 'session_busy' : 'unavailable',
      transportGeneration: 0,
      // Not authoritative empty — trusted restore may hydrate real history.
      transcriptHydrated: false,
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
    ep.effectiveCwd = resolved.effectiveCwd;
    ep.worktreePath = resolved.worktreePath;
    ep.launchSpec = {
      agent: resolved.agent,
      request: resolved.request,
      resolvedSkillPaths: resolved.resolvedSkillPaths,
      sessionFile: resolved.sessionFile,
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
          if (existing.sessionFile && existing.sessionFile !== trust.resolved.sessionFile) {
            releaseSessionFile(key, existing.sessionFile);
          }
          claimSessionFile(key, trust.resolved.sessionFile);
        } catch (err) {
          restored.push(
            applyUnavailable(
              key,
              link,
              err instanceof InteractiveAgentError ? err.message : 'session_busy',
              {
                agent: trust.resolved.agent.name,
                sessionFile: trust.resolved.sessionFile,
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
        claimSessionFile(key, trust.resolved.sessionFile);
      } catch (err) {
        restored.push(
          applyUnavailable(
            key,
            link,
            err instanceof InteractiveAgentError ? err.message : 'session_busy',
            {
              agent: trust.resolved.agent.name,
              sessionFile: trust.resolved.sessionFile,
              effectiveCwd: trust.resolved.effectiveCwd,
              worktreePath: trust.resolved.worktreePath,
            }
          )
        );
        continue;
      }

      // Metadata-only restore: do not open session files / hydrate child history.
      const ep: InteractiveAgentEndpoint = {
        key,
        hostSessionId: link.hostSessionId,
        runId: link.runId,
        unitId: link.unitId,
        bindingId: link.bindingId,
        agent: trust.resolved.agent.name,
        title: trust.resolved.title,
        sessionFile: trust.resolved.sessionFile,
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
        lastUsedAt: now(),
        createdAt: link.createdAt,
        linkCreatedAt: link.createdAt,
        launchSpec: {
          agent: trust.resolved.agent,
          request: trust.resolved.request,
          resolvedSkillPaths: trust.resolved.resolvedSkillPaths,
          sessionFile: trust.resolved.sessionFile,
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

  function settleActivationError(
    ep: InteractiveAgentEndpoint,
    message: string,
    terminal: InteractiveTerminalOverride = 'error'
  ): void {
    clearTransientActivity(ep);
    if (!ep.activation || ep.activation.settled) {
      publish(ep, 'full');
      return;
    }
    ep.activation.settled = true;
    ep.activation.error = message;
    ep.activation.terminalOverride = terminal;
    const activationId = ep.activation.id;
    publish(ep, 'full');
    emit({
      type: 'activation_settled',
      key: ep.key,
      activationId,
      snapshot: snapshotOf(ep),
    });
    ep.activation = undefined;
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
    // Reopen needs transcript for baselineMessageCount and detail continuity.
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
          ep.activation.settled = true;
          const activationId = ep.activation.id;
          // Honour terminal override from abort/max_turns (cancelled stays cancelled).
          if (ep.activation.terminalOverride === 'cancelled') {
            ep.status = 'idle';
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
          // Share the transport-owned message object; replaced wholesale each delta.
          ep.streamingMessage = evt.message as AgentMessage;
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
        const id = String(evt.toolCallId ?? '');
        ep.activeTools.set(id, {
          toolCallId: id,
          toolName: String(evt.toolName ?? 'tool'),
          args: (evt.args as Record<string, unknown>) ?? {},
        });
        ep.streamRevision += 1;
        // Detail transcript only; list/widget do not show live tools.
        kind = 'transcript';
        break;
      }
      case 'tool_execution_update': {
        const id = String(evt.toolCallId ?? '');
        const existing = ep.activeTools.get(id);
        if (existing) {
          existing.partialResult = evt.partialResult;
        }
        ep.streamRevision += 1;
        kind = 'transcript';
        break;
      }
      case 'tool_execution_end': {
        const id = String(evt.toolCallId ?? '');
        const existing = ep.activeTools.get(id);
        if (existing) {
          existing.ended = true;
          existing.isError = Boolean(evt.isError);
          existing.partialResult = evt.result ?? existing.partialResult;
        }
        ep.streamRevision += 1;
        kind = 'transcript';
        break;
      }
      case 'queue_update':
        ep.steeringQueue = Array.isArray(evt.steering) ? (evt.steering as string[]) : [];
        ep.followUpQueue = Array.isArray(evt.followUp) ? (evt.followUp as string[]) : [];
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
  ): Promise<PiRpcTransport> {
    const spec = ep.launchSpec;
    if (!spec) {
      throw new InteractiveAgentError('validation_error', 'Missing launch specification');
    }

    let tmpPromptPath: string | undefined;
    let tmpPromptDir: string | undefined;
    let transport: PiRpcTransport | undefined;
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
    const lease = await acquireSessionLease(ep.sessionFile);
    let leaseReleased = false;
    const releaseLease = (err?: Error): void => {
      if (leaseReleased) return;
      leaseReleased = true;
      lease.release(err);
    };

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
      // Do not await disposeTracked chain: abort may have chained that barrier behind
      // `ready` (this spawn), which would deadlock. Also do not await the dispose
      // promise itself — killTimeout/gates must not block the spawn rejection path.
      // Session lease stays held until dispose settles (success or sticky fail-closed).
      const owned = transport;
      const d = owned.dispose().then(
        () => {
          const rel = transportLeaseReleases.get(owned);
          if (rel) {
            transportLeaseReleases.delete(owned);
            rel();
          } else {
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
      void noteDispose(ep.key, d);
    };

    try {
      if (!isCurrentGeneration()) {
        releaseLease();
        throw new InteractiveAgentError('rejected', 'Transport generation superseded');
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
      transportLeaseReleases.set(transport, releaseLease);
      leaseHandedToTransport = true;

      // Abort/detach may have advanced generation while factory was in flight.
      if (!isCurrentGeneration()) {
        await disposeSpawned();
        throw new InteractiveAgentError('rejected', 'Transport generation superseded');
      }

      // Subscribe before handshake so unexpected exit during get_state is observed.
      transport.subscribe((event) => {
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
            if (current.client && current.client !== transport) return;
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
          if (current.client !== transport) return;
          if (sealed !== undefined) reduceEvent(current, sealed);
          reduceEvent(current, event);
        });
      });

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
      if (!isCurrentGeneration()) {
        await disposeSpawned();
        throw cancelErr;
      }
      handshakeOk = true;

      if (!isCurrentGeneration()) {
        await disposeSpawned();
        throw new InteractiveAgentError('rejected', 'Transport generation superseded');
      }

      // Only the current generation may install the client.
      ep.client = transport;
      // Handshake success: clear prior reopen/transport error without masking an
      // in-flight failure (we only reach here on successful get_state).
      ep.lastError = undefined;
      ep.errorCode = undefined;
      // Lease stays held until this transport's dispose path releases it.
      return transport;
    } catch (err) {
      // Dispose a half-started process before removing startup resources.
      // Tracked on the barrier so a concurrent T2 spawn waits for teardown.
      if (transport && (!handshakeOk || !isCurrentGeneration())) {
        await disposeSpawned();
      } else if (!leaseHandedToTransport) {
        // Factory never returned a transport (or failed before bind): release now.
        releaseLease();
      } else if (!transportDisposed && !handshakeOk) {
        // Transport exists but we are not disposing via disposeSpawned — still release.
        releaseLease();
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
    let state: { isStreaming?: boolean; isCompacting?: boolean };
    try {
      state = await client.getState();
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

      // Baseline must include any prior session messages on reopen.
      // Hydrate failures throw here — before activation assignment — so activate
      // never leaves a zombie activation without activation_settled.
      // ensureTranscriptHydrated awaits the writer lease barrier before disk open.
      if (!ep.activation) {
        await ensureTranscriptHydrated(ep, { required: true });
      }

      const activationId = `act_${++sequenceCounter}_${now()}`;
      if (!ep.activation) {
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
      } else if (policy?.maxTurns && !ep.activation.policy?.maxTurns) {
        ep.activation.policy = { ...ep.activation.policy, ...policy };
      }

      // Ensure a single shared transportReady barrier exists for concurrent waiters.
      if (!ep.client && !ep.transportReady) {
        // Wait for any prior dispose (abort/detach/invalidate/cross-registry) before spawning.
        await awaitSpawnDisposeBarriers(key, ep.sessionFile);
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
            ep.errorCode = 'transport_error';
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
      const readyBarrier: Promise<PiRpcTransport> | undefined = ep.client
        ? Promise.resolve(ep.client)
        : ep.transportReady;
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
        const transport = await new Promise<PiRpcTransport>((resolve, reject) => {
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
        });

        const after = endpoints.get(key);
        if (
          !after?.activation ||
          after.activation.id !== prepared.activationId ||
          after.activation.settled ||
          after.activation.terminalOverride === 'cancelled'
        ) {
          try {
            await transport.dispose();
          } catch {
            /* ignore */
          }
          throw new InteractiveAgentError('rejected', 'Activation cancelled before send');
        }

        if (prepared.effectiveMode === 'prompt') {
          await transport.prompt(trimmed);
        } else if (prepared.effectiveMode === 'steer') {
          await transport.steer(trimmed);
        } else {
          await transport.followUp(trimmed);
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
            current.errorCode = 'transport_error';
          } else if (current.status === 'starting') {
            current.status = 'detached';
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
        settleActivationError(ep, 'Activation cancelled', 'cancelled');
        if (ep.status === 'starting' || ep.status === 'registered') {
          ep.status = 'detached';
          publish(ep);
        }
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
    options: { remove?: boolean; activationId?: string } = {}
  ): Promise<void> {
    const ep = endpoints.get(key);
    if (!ep) return;
    await enqueueTransition(key, async () => {
      const current = endpoints.get(key);
      if (!current) return;
      // Activation-scoped: timer for A must not detach B.
      if (options.activationId !== undefined) {
        if (!current.activation || current.activation.id !== options.activationId) {
          return;
        }
      }
      // Force-settle any open activation so timeout/detach never leaves zombies
      // that subsequent send/activate would reuse.
      if (current.activation && !current.activation.settled) {
        const terminal = current.activation.terminalOverride ?? 'error';
        const reason =
          terminal === 'max_turns'
            ? 'max_turns settle timeout'
            : terminal === 'cancelled'
              ? 'Endpoint detached'
              : 'Endpoint detached';
        settleActivationError(current, reason, terminal);
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
      if (current.status !== 'unavailable' && current.status !== 'error') {
        current.status = 'detached';
      }
      if (options.remove) {
        releaseSessionFile(key, current.sessionFile);
        treeClaimKeys.delete(key);
        revokeTrustedBranch(key);
        endpoints.delete(key);
        emitEndpointsChanged();
      } else {
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
      await detach(victim.key);
    }
  }

  async function shutdown(): Promise<void> {
    if (shutDown) return;
    shutDown = true;
    // One absolute deadline for abort + settle + dispose + barrier (not two serial races).
    const deadlineAt = now() + shutdownDisposeBudgetMs;
    const remainingMs = () => Math.max(0, deadlineAt - now());
    const keys = [...endpoints.keys()];
    const disposeWork: Promise<void>[] = [];

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
        // Track on barriers (local + sessionFile). Session barrier stays sticky on
        // dispose failure so a new registry cannot open the same sessionFile.
        disposeWork.push(disposeTracked(key, client, sessionFile));
      } else if (ready) {
        // Handshake-only: dispose when the spawn promise settles; share the budget.
        disposeWork.push(noteReadyDispose(key, sessionFile, ready));
      }
      releaseSessionFile(key, ep.sessionFile);
    }

    // Wait for all dispose work + any leftover barriers under the shared absolute deadline.
    // Session-file barriers are process-scoped and intentionally NOT cleared here so a
    // new registry cannot bypass incomplete/failed same-session disposal.
    const pending = [...disposeWork, ...disposeBarriers.values()];
    if (pending.length > 0) {
      await Promise.race([
        Promise.all(pending.map((p) => p.catch(() => undefined))),
        new Promise<void>((resolve) => {
          timers.setTimeout(() => resolve(), remainingMs());
        }),
      ]);
    }

    endpoints.clear();
    sessionOwners.clear();
    treeClaimKeys.clear();
    trustedBranchBindings.clear();
    outboundPoisonByKey.clear();
    coalescedStreamEvents.clear();
    streamCoalesceScheduled.clear();
    coalesceCellSeq.clear();
    disposeBarriers.clear();
    for (const id of abortSettleTimers.values()) timers.clearTimeout(id);
    abortSettleTimers.clear();
    emit({ type: 'shutdown' });
    listeners.clear();
  }

  return {
    registerInitial,
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
  };
}

export type InteractiveAgentRegistry = ReturnType<typeof createInteractiveAgentRegistry>;

export function isTuiMode(mode: string | undefined): boolean {
  return mode === 'tui';
}
