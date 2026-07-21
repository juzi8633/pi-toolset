// ABOUTME: Process-global session lease store keyed by runtime/cwd/session identity.
// ABOUTME: Serializes same-session process ownership across registries and sticky-fails dispose errors.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Deferred, Effect } from 'effect';
import { runEffectPromise } from './effect-runtime.ts';

/**
 * Opaque owner token for a lease. Identity is object reference equality.
 * Store lives on `globalThis` under `Symbol.for` so Jiti `moduleCache: false` reloads
 * (new module instances) still share the same lease map. Process restart clears it.
 */
export type SessionLeaseToken = object;

/**
 * Effect mapping (approach A):
 * - owner `done` Deferred → Deferred.succeed (clean release) / Deferred.fail (sticky)
 * - `done` Promise view via runEffectPromise(Deferred.await) for Promise callers
 * - acquireTails remains a per-key Promise chain serializing install only (not owner lifetime)
 */
type SessionLeaseRecord = {
  token: SessionLeaseToken;
  deferred: Deferred.Deferred<void, Error>;
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

function makeDonePromise(deferred: Deferred.Deferred<void, Error>): Promise<void> {
  const done = runEffectPromise(Deferred.await(deferred));
  // Sticky rejects must not become unhandled when no waiter is attached yet.
  done.catch(() => undefined);
  return done;
}

function completeDeferred(deferred: Deferred.Deferred<void, Error>, err?: Error): void {
  if (err) {
    Effect.runSync(Deferred.fail(deferred, err));
    return;
  }
  Effect.runSync(Deferred.succeed(deferred, undefined));
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
 * Canonical lease key for a session file path (Pi identity).
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

/** Canonicalize an effective cwd/worktree path for lease keys (existing or planned). */
export function canonicalizeLeaseCwd(cwd: string): string {
  if (!cwd) return '';
  return canonicalizeResolvedPath(path.resolve(cwd), new Set());
}

export type SessionLeaseRuntime = 'pi' | 'grok-acp';

/**
 * Build a process-global lease key:
 * `<runtime>\0<canonical-effective-cwd>\0<session-identity>`
 *
 * Pi identity is the canonical native session-file path.
 * Grok ACP identity is the protocol session ID (never a private Grok file path).
 *
 * For Pi path-only compatibility, `acquireSessionLease(sessionFile)` still keys
 * solely by the canonical session path (no runtime/cwd prefix). Interactive Grok
 * ACP paths must use this builder so keys never collide with private storage paths.
 */
export function buildSessionLeaseKey(input: {
  runtime: SessionLeaseRuntime;
  cwd: string;
  sessionIdentity: string;
}): string {
  const runtime = input.runtime;
  const cwd = canonicalizeLeaseCwd(input.cwd);
  const identity =
    runtime === 'pi'
      ? canonicalizeSessionLeaseKey(input.sessionIdentity)
      : input.sessionIdentity.trim();
  if (!identity) return '';
  return `${runtime}\0${cwd}\0${identity}`;
}

/**
 * Wait for any previous session owner to release (or sticky-fail).
 * `key` is either a full buildSessionLeaseKey result or a Pi session path
 * (canonicalized when it does not contain the runtime separator).
 * Does not await self when `selfToken` matches the current owner (avoids deadlock).
 */
export async function awaitSessionLease(
  keyOrSessionFile: string,
  selfToken?: SessionLeaseToken
): Promise<void> {
  if (!keyOrSessionFile) return;
  const key = resolveLeaseKey(keyOrSessionFile);
  if (!key) return;
  const rec = getSessionLeaseStore().leases.get(key);
  if (!rec) return;
  if (selfToken && rec.token === selfToken) return;
  await rec.done;
}

function resolveLeaseKey(keyOrSessionFile: string): string {
  // Full keys from buildSessionLeaseKey contain the runtime\0cwd\0identity form.
  if (keyOrSessionFile.includes('\0')) return keyOrSessionFile;
  return canonicalizeSessionLeaseKey(keyOrSessionFile);
}

/**
 * Wait for prior owner (if any), then install a new owner deferred.
 * Release only via the returned handle (token-guarded); success deletes the lease,
 * failure keeps a sticky rejected promise (fail-closed).
 *
 * Accepts either a full `buildSessionLeaseKey` result or a Pi session-file path
 * (path-only keys preserve existing Pi tests and callers).
 */
export async function acquireSessionLease(keyOrSessionFile: string): Promise<{
  token: SessionLeaseToken;
  key: string;
  release: (err?: Error) => void;
}> {
  const store = getSessionLeaseStore();
  const key = resolveLeaseKey(keyOrSessionFile);
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
    const deferred = Effect.runSync(Deferred.make<void, Error>());
    const done = makeDonePromise(deferred);
    let settled = false;

    const record: SessionLeaseRecord = {
      token,
      deferred,
      done,
      settled: false,
      settle(err?: Error) {
        if (settled) return;
        settled = true;
        record.settled = true;
        if (err) {
          completeDeferred(deferred, err);
          // Keep rejected entry sticky so later acquires fail closed.
        } else {
          completeDeferred(deferred);
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

/**
 * Structured certainty about whether a session process has exited.
 * Lease clean-release is only valid for confirmed exit or never-spawned.
 * Any dispose_failed / uncertain exit must sticky-fail via release(error).
 */
export type DisposalCertainty =
  { kind: 'confirmed' } | { kind: 'never_spawned' } | { kind: 'failed'; error: Error };

/** True when an error advertises dispose_failed (sticky fail-closed). */
export function isDisposeFailedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: unknown }).code === 'dispose_failed';
}

/** Map a thrown open/factory/dispose error into lease-release certainty. */
export function disposalCertaintyFromCaught(err: unknown): DisposalCertainty {
  if (isDisposeFailedError(err)) {
    return {
      kind: 'failed',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  // Factories/open paths that rethrow after a successful cleanup leave no live process.
  return { kind: 'confirmed' };
}

/** Release a session lease according to disposal certainty (never assume !handle ⇒ clean). */
export function releaseSessionLeaseWithCertainty(
  release: ((err?: Error) => void) | undefined,
  certainty: DisposalCertainty
): void {
  if (!release) return;
  if (certainty.kind === 'confirmed' || certainty.kind === 'never_spawned') {
    release();
    return;
  }
  release(certainty.error);
}
