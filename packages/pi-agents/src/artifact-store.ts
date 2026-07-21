// ABOUTME: Content-addressed run-local text/JSON artifact writes and verified reads.
// ABOUTME: Publishes immutable SHA-256 paths under a run directory via exclusive create + rename.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Effect } from 'effect';
import { RUN_ARTIFACT_MAX_BYTES } from './constants.ts';
import { runEffectPromise } from './effect-runtime.ts';
import type { RunArtifactPayload, RunArtifactRefV1 } from './run-types.ts';

const POSIX = process.platform !== 'win32';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export type ArtifactMediaType = RunArtifactRefV1['mediaType'];

export class ArtifactStoreError extends Error {
  readonly code:
    | 'artifact_too_large'
    | 'artifact_write_error'
    | 'artifact_missing'
    | 'artifact_corrupt'
    | 'artifact_invalid';

  constructor(code: ArtifactStoreError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ArtifactStoreError';
    this.code = code;
  }
}

function assertJsonValue(value: unknown, pathLabel = 'value'): void {
  if (value === undefined) {
    throw new ArtifactStoreError('artifact_invalid', `${pathLabel} cannot be undefined`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new ArtifactStoreError('artifact_invalid', `${pathLabel} must be a finite number`);
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new ArtifactStoreError(
      'artifact_invalid',
      `${pathLabel} has unsupported type ${typeof value}`
    );
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertJsonValue(value[i], `${pathLabel}[${i}]`);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) {
      throw new ArtifactStoreError('artifact_invalid', `${pathLabel}.${k} cannot be undefined`);
    }
    assertJsonValue(v, `${pathLabel}.${k}`);
  }
}

export function serializeJsonArtifact(value: unknown): string {
  assertJsonValue(value);
  try {
    return `${JSON.stringify(value, null, 2)}\n`;
  } catch (err) {
    throw new ArtifactStoreError(
      'artifact_invalid',
      `JSON artifact value is not serializable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function measureTextArtifactBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function measureJsonArtifactBytes(value: unknown): number {
  return Buffer.byteLength(serializeJsonArtifact(value), 'utf8');
}

export function artifactRelativePath(sha256: string, mediaType: ArtifactMediaType): string {
  const ext = mediaType === 'application/json' ? 'json' : 'txt';
  return path.posix.join('artifacts', 'sha256', sha256.slice(0, 2), `${sha256}.${ext}`);
}

export function isRunArtifactRef(value: unknown): value is RunArtifactRefV1 {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<RunArtifactRefV1>;
  return (
    r.kind === 'run-artifact' &&
    r.version === 1 &&
    typeof r.runId === 'string' &&
    typeof r.payload === 'string' &&
    typeof r.relativePath === 'string' &&
    typeof r.sha256 === 'string' &&
    typeof r.bytes === 'number' &&
    (r.mediaType === 'text/plain; charset=utf-8' || r.mediaType === 'application/json')
  );
}

function applyMode(targetPath: string, mode: number): void {
  if (!POSIX) return;
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    /* best-effort */
  }
}

function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  applyMode(dir, DIR_MODE);
}

function defaultFileFsync(fd: number): void {
  try {
    fs.fsyncSync(fd);
  } catch (err) {
    throw new ArtifactStoreError(
      'artifact_write_error',
      `fsync failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

function defaultDirectorySync(dirPath: string): void {
  let dirFd: number | undefined;
  try {
    dirFd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(dirFd);
  } catch (err) {
    throw new ArtifactStoreError(
      'artifact_write_error',
      `directory fsync failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  } finally {
    if (dirFd !== undefined) {
      try {
        fs.closeSync(dirFd);
      } catch {
        /* ignore */
      }
    }
  }
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function assertValidRefShape(runId: string, ref: RunArtifactRefV1): void {
  if (ref.kind !== 'run-artifact' || ref.version !== 1) {
    throw new ArtifactStoreError('artifact_corrupt', 'artifact ref has invalid kind/version');
  }
  if (ref.runId !== runId) {
    throw new ArtifactStoreError('artifact_corrupt', 'artifact ref runId does not match owner run');
  }
  if (!SHA256_HEX.test(ref.sha256)) {
    throw new ArtifactStoreError('artifact_corrupt', 'artifact ref sha256 is not lowercase hex');
  }
  if (!Number.isInteger(ref.bytes) || ref.bytes < 0) {
    throw new ArtifactStoreError('artifact_corrupt', 'artifact ref bytes is invalid');
  }
  if (ref.bytes > RUN_ARTIFACT_MAX_BYTES) {
    throw new ArtifactStoreError('artifact_too_large', 'artifact exceeds 64 MiB budget');
  }
  const expected = artifactRelativePath(ref.sha256, ref.mediaType);
  if (ref.relativePath !== expected) {
    throw new ArtifactStoreError('artifact_corrupt', 'artifact relativePath does not match digest');
  }
  if (ref.relativePath.includes('..') || path.isAbsolute(ref.relativePath)) {
    throw new ArtifactStoreError('artifact_corrupt', 'artifact relativePath escapes run directory');
  }
}

/** Syntactic containment under the run directory (no realpath/inode identity). */
function resolveContainedArtifactPath(runDir: string, relativePath: string): string {
  if (relativePath.includes('..') || path.isAbsolute(relativePath)) {
    throw new ArtifactStoreError('artifact_corrupt', 'artifact relativePath escapes run directory');
  }
  const absolute = path.resolve(runDir, ...relativePath.split('/'));
  const rel = path.relative(path.resolve(runDir), absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ArtifactStoreError('artifact_corrupt', 'artifact path escapes run directory');
  }
  return absolute;
}

export interface ArtifactStore {
  writeTextArtifact(
    runId: string,
    runDir: string,
    payload: RunArtifactPayload,
    text: string
  ): Promise<RunArtifactRefV1>;
  writeJsonArtifact(
    runId: string,
    runDir: string,
    payload: RunArtifactPayload,
    value: unknown
  ): Promise<RunArtifactRefV1>;
  readTextArtifact(runId: string, runDir: string, ref: RunArtifactRefV1): Promise<string>;
  readJsonArtifact(runId: string, runDir: string, ref: RunArtifactRefV1): Promise<unknown>;
  resolveArtifactPath(runId: string, runDir: string, ref: RunArtifactRefV1): Promise<string>;
}

export interface CreateArtifactStoreOptions {
  /**
   * Whether directory fsync is supported for this runs root.
   * Required: callers must pass a probed or known capability (no silent true default).
   * RunStore wires this from RunStoreCapabilities.directoryFsync.
   */
  directoryFsync: boolean;
  /** Test seam: regular-file fsync used before rename publication (mandatory). */
  fileFsync?: (fd: number) => void;
  /** Test seam: directory sync (defaults to real fsync when directoryFsync is true). */
  directorySync?: (dirPath: string) => void;
  /** Test seam: inject staging root under runDir. */
  stagingName?: string;
}

export function createArtifactStore(options: CreateArtifactStoreOptions): ArtifactStore {
  const stagingName = options.stagingName ?? `.artifact-staging`;
  const directoryFsync = options.directoryFsync;
  const fileFsync = options.fileFsync ?? defaultFileFsync;
  const directorySyncImpl = options.directorySync ?? defaultDirectorySync;

  function syncDir(dirPath: string): void {
    if (!directoryFsync) return;
    directorySyncImpl(dirPath);
  }

  /**
   * Effect core for trusted read/verify. Failures are ArtifactStoreError on the
   * typed channel; Promise façades use runEffectPromise (preserves Error identity).
   */
  function verifyFile(
    runId: string,
    runDir: string,
    ref: RunArtifactRefV1
  ): Effect.Effect<{ absolute: string; buf: Buffer }, ArtifactStoreError> {
    return Effect.try({
      try: () => {
        assertValidRefShape(runId, ref);
        const absolute = resolveContainedArtifactPath(runDir, ref.relativePath);
        let st: fs.Stats;
        try {
          st = fs.statSync(absolute);
        } catch (err) {
          throw new ArtifactStoreError(
            'artifact_missing',
            `artifact missing: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err }
          );
        }
        if (!st.isFile()) {
          throw new ArtifactStoreError('artifact_corrupt', 'artifact is not a regular file');
        }
        if (st.size !== ref.bytes) {
          throw new ArtifactStoreError('artifact_corrupt', 'artifact size does not match ref');
        }

        let fd: number | undefined;
        try {
          fd = fs.openSync(absolute, fs.constants.O_RDONLY);
          const buf = fs.readFileSync(fd);
          if (buf.length !== ref.bytes) {
            throw new ArtifactStoreError('artifact_corrupt', 'artifact size does not match ref');
          }
          const digest = sha256Hex(buf);
          if (digest !== ref.sha256) {
            throw new ArtifactStoreError('artifact_corrupt', 'artifact digest mismatch');
          }
          return { absolute, buf };
        } catch (err) {
          if (err instanceof ArtifactStoreError) throw err;
          throw new ArtifactStoreError(
            'artifact_corrupt',
            `artifact read failed: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err }
          );
        } finally {
          if (fd !== undefined) {
            try {
              fs.closeSync(fd);
            } catch {
              /* ignore */
            }
          }
        }
      },
      catch: (err) =>
        err instanceof ArtifactStoreError
          ? err
          : new ArtifactStoreError(
              'artifact_corrupt',
              `artifact read failed: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err }
            ),
    });
  }

  function writeBytes(
    runId: string,
    runDir: string,
    payload: RunArtifactPayload,
    mediaType: ArtifactMediaType,
    bytes: Buffer
  ): Effect.Effect<RunArtifactRefV1, ArtifactStoreError> {
    return Effect.gen(function* () {
      if (bytes.length > RUN_ARTIFACT_MAX_BYTES) {
        return yield* Effect.fail(
          new ArtifactStoreError('artifact_too_large', 'artifact exceeds 64 MiB budget')
        );
      }
      const sha256 = sha256Hex(bytes);
      const relativePath = artifactRelativePath(sha256, mediaType);
      const absolute = resolveContainedArtifactPath(runDir, relativePath);
      const parent = path.dirname(absolute);
      mkdirPrivate(path.join(runDir, 'artifacts'));
      mkdirPrivate(path.join(runDir, 'artifacts', 'sha256'));
      mkdirPrivate(parent);

      const ref: RunArtifactRefV1 = {
        kind: 'run-artifact',
        version: 1,
        runId,
        payload,
        relativePath,
        sha256,
        bytes: bytes.length,
        mediaType,
      };

      // Dedup: existing digest path must verify exact bytes.
      if (fs.existsSync(absolute)) {
        yield* verifyFile(runId, runDir, ref);
        return ref;
      }

      const stagingRoot = path.join(runDir, stagingName);
      mkdirPrivate(stagingRoot);
      const staging = path.join(
        stagingRoot,
        `${sha256}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
      );

      // Keep try/finally fully synchronous (no yield*) so staging cleanup always runs.
      type PublishOutcome =
        { kind: 'ok' } | { kind: 'dedup' } | { kind: 'fail'; error: ArtifactStoreError };
      const outcome: PublishOutcome = (() => {
        let fd: number | undefined;
        let renamed = false;
        try {
          fd = fs.openSync(
            staging,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
            FILE_MODE
          );
          fs.writeFileSync(fd, bytes);
          fileFsync(fd);
          fs.closeSync(fd);
          fd = undefined;
          applyMode(staging, FILE_MODE);
          fs.renameSync(staging, absolute);
          renamed = true;
          syncDir(parent);
          syncDir(path.join(runDir, 'artifacts', 'sha256'));
          syncDir(path.join(runDir, 'artifacts'));
          syncDir(runDir);
          return { kind: 'ok' };
        } catch (err) {
          if (err instanceof ArtifactStoreError) {
            return { kind: 'fail', error: err };
          }
          // Concurrent creator may have published the same digest before our rename.
          if (!renamed && fs.existsSync(absolute)) {
            return { kind: 'dedup' };
          }
          return {
            kind: 'fail',
            error: new ArtifactStoreError(
              'artifact_write_error',
              `artifact write failed: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err }
            ),
          };
        } finally {
          if (fd !== undefined) {
            try {
              fs.closeSync(fd);
            } catch {
              /* ignore */
            }
          }
          // Clean only this writer's exact staging pathname, then try non-recursive rmdir.
          try {
            if (fs.existsSync(staging)) fs.unlinkSync(staging);
          } catch {
            /* ignore */
          }
          try {
            fs.rmdirSync(stagingRoot);
          } catch {
            /* not empty or missing — preserve competing/unknown entries */
          }
        }
      })();

      if (outcome.kind === 'ok') return ref;
      if (outcome.kind === 'dedup') {
        yield* verifyFile(runId, runDir, ref);
        return ref;
      }
      return yield* Effect.fail(outcome.error);
    });
  }

  function writeTextEffect(
    runId: string,
    runDir: string,
    payload: RunArtifactPayload,
    text: string
  ): Effect.Effect<RunArtifactRefV1, ArtifactStoreError> {
    const bytes = Buffer.from(text, 'utf8');
    return writeBytes(runId, runDir, payload, 'text/plain; charset=utf-8', bytes);
  }

  function writeJsonEffect(
    runId: string,
    runDir: string,
    payload: RunArtifactPayload,
    value: unknown
  ): Effect.Effect<RunArtifactRefV1, ArtifactStoreError> {
    return Effect.gen(function* () {
      if (value === undefined) {
        return yield* Effect.fail(
          new ArtifactStoreError('artifact_invalid', 'JSON artifact value cannot be undefined')
        );
      }
      const text = yield* Effect.try({
        try: () => serializeJsonArtifact(value),
        catch: (err) =>
          err instanceof ArtifactStoreError
            ? err
            : new ArtifactStoreError(
                'artifact_invalid',
                `JSON artifact value is not serializable: ${err instanceof Error ? err.message : String(err)}`,
                { cause: err }
              ),
      });
      yield* Effect.try({
        try: () => {
          JSON.parse(text);
        },
        catch: (err) =>
          new ArtifactStoreError(
            'artifact_invalid',
            `JSON artifact is not re-parseable: ${err instanceof Error ? err.message : String(err)}`
          ),
      });
      return yield* writeBytes(
        runId,
        runDir,
        payload,
        'application/json',
        Buffer.from(text, 'utf8')
      );
    });
  }

  function readTextEffect(
    runId: string,
    runDir: string,
    ref: RunArtifactRefV1
  ): Effect.Effect<string, ArtifactStoreError> {
    return Effect.gen(function* () {
      if (ref.mediaType !== 'text/plain; charset=utf-8') {
        return yield* Effect.fail(
          new ArtifactStoreError('artifact_corrupt', 'artifact mediaType is not text')
        );
      }
      const { buf } = yield* verifyFile(runId, runDir, ref);
      return buf.toString('utf8');
    });
  }

  function readJsonEffect(
    runId: string,
    runDir: string,
    ref: RunArtifactRefV1
  ): Effect.Effect<unknown, ArtifactStoreError> {
    return Effect.gen(function* () {
      if (ref.mediaType !== 'application/json') {
        return yield* Effect.fail(
          new ArtifactStoreError('artifact_corrupt', 'artifact mediaType is not json')
        );
      }
      const { buf } = yield* verifyFile(runId, runDir, ref);
      return yield* Effect.try({
        try: () => JSON.parse(buf.toString('utf8')) as unknown,
        catch: (err) =>
          new ArtifactStoreError(
            'artifact_corrupt',
            `artifact JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err }
          ),
      });
    });
  }

  function resolvePathEffect(
    runId: string,
    runDir: string,
    ref: RunArtifactRefV1
  ): Effect.Effect<string, ArtifactStoreError> {
    return Effect.gen(function* () {
      const { absolute } = yield* verifyFile(runId, runDir, ref);
      return absolute;
    });
  }

  return {
    writeTextArtifact(runId, runDir, payload, text) {
      return runEffectPromise(writeTextEffect(runId, runDir, payload, text));
    },

    writeJsonArtifact(runId, runDir, payload, value) {
      return runEffectPromise(writeJsonEffect(runId, runDir, payload, value));
    },

    readTextArtifact(runId, runDir, ref) {
      return runEffectPromise(readTextEffect(runId, runDir, ref));
    },

    readJsonArtifact(runId, runDir, ref) {
      return runEffectPromise(readJsonEffect(runId, runDir, ref));
    },

    resolveArtifactPath(runId, runDir, ref) {
      return runEffectPromise(resolvePathEffect(runId, runDir, ref));
    },
  };
}

/** Test helper: create a unique temp run dir under os.tmpdir(). */
export function makeTempRunDir(prefix = 'pi-agents-artifact-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  mkdirPrivate(dir);
  return dir;
}
