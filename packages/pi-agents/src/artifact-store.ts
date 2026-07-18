// ABOUTME: Content-addressed run-local text/JSON artifact writes and verified reads.
// ABOUTME: Publishes immutable SHA-256 paths under a run directory with strict sync helpers.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RUN_ARTIFACT_MAX_BYTES } from './constants.ts';
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

function fsyncFdStrict(fd: number): void {
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

function fsyncDirStrict(dirPath: string): void {
  if (!POSIX) return;
  let dirFd: number | undefined;
  try {
    dirFd = fs.openSync(dirPath, 'r');
    fsyncFdStrict(dirFd);
  } catch (err) {
    if (err instanceof ArtifactStoreError) throw err;
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

function openNoFollow(filePath: string, flags: number, mode?: number): number {
  const openFlags =
    typeof fs.constants.O_NOFOLLOW === 'number' ? flags | fs.constants.O_NOFOLLOW : flags;
  return fs.openSync(filePath, openFlags, mode);
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

export function createArtifactStore(options?: {
  /** Test seam: inject staging root under runDir. */
  stagingName?: string;
}): ArtifactStore {
  const stagingName = options?.stagingName ?? `.artifact-staging`;

  async function writeBytes(
    runId: string,
    runDir: string,
    payload: RunArtifactPayload,
    mediaType: ArtifactMediaType,
    bytes: Buffer
  ): Promise<RunArtifactRefV1> {
    if (bytes.length > RUN_ARTIFACT_MAX_BYTES) {
      throw new ArtifactStoreError('artifact_too_large', 'artifact exceeds 64 MiB budget');
    }
    const sha256 = sha256Hex(bytes);
    const relativePath = artifactRelativePath(sha256, mediaType);
    const absolute = path.join(runDir, ...relativePath.split('/'));
    const parent = path.dirname(absolute);
    mkdirPrivate(path.join(runDir, 'artifacts'));
    mkdirPrivate(path.join(runDir, 'artifacts', 'sha256'));
    mkdirPrivate(parent);

    // Dedup: existing digest path must verify exact bytes.
    if (fs.existsSync(absolute)) {
      await verifyFile(runId, runDir, {
        kind: 'run-artifact',
        version: 1,
        runId,
        payload,
        relativePath,
        sha256,
        bytes: bytes.length,
        mediaType,
      });
      return {
        kind: 'run-artifact',
        version: 1,
        runId,
        payload,
        relativePath,
        sha256,
        bytes: bytes.length,
        mediaType,
      };
    }

    const stagingRoot = path.join(runDir, stagingName);
    mkdirPrivate(stagingRoot);
    const staging = path.join(
      stagingRoot,
      `${sha256}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    );

    let fd: number | undefined;
    try {
      fd = openNoFollow(
        staging,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        FILE_MODE
      );
      fs.writeFileSync(fd, bytes);
      fsyncFdStrict(fd);
      fs.closeSync(fd);
      fd = undefined;
      applyMode(staging, FILE_MODE);
      fs.renameSync(staging, absolute);
      fsyncDirStrict(parent);
      if (POSIX) {
        fsyncDirStrict(path.join(runDir, 'artifacts', 'sha256'));
        fsyncDirStrict(path.join(runDir, 'artifacts'));
        fsyncDirStrict(runDir);
      }
    } catch (err) {
      if (err instanceof ArtifactStoreError) throw err;
      // Concurrent creator may have published the same digest.
      if (fs.existsSync(absolute)) {
        await verifyFile(runId, runDir, {
          kind: 'run-artifact',
          version: 1,
          runId,
          payload,
          relativePath,
          sha256,
          bytes: bytes.length,
          mediaType,
        });
        return {
          kind: 'run-artifact',
          version: 1,
          runId,
          payload,
          relativePath,
          sha256,
          bytes: bytes.length,
          mediaType,
        };
      }
      throw new ArtifactStoreError(
        'artifact_write_error',
        `artifact write failed: ${err instanceof Error ? err.message : String(err)}`,
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
      try {
        if (fs.existsSync(staging)) fs.unlinkSync(staging);
      } catch {
        /* ignore */
      }
    }

    return {
      kind: 'run-artifact',
      version: 1,
      runId,
      payload,
      relativePath,
      sha256,
      bytes: bytes.length,
      mediaType,
    };
  }

  async function verifyFile(
    runId: string,
    runDir: string,
    ref: RunArtifactRefV1
  ): Promise<{ absolute: string; buf: Buffer }> {
    assertValidRefShape(runId, ref);
    const absolute = path.join(runDir, ...ref.relativePath.split('/'));
    const runReal = fs.realpathSync(runDir);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(absolute);
    } catch (err) {
      throw new ArtifactStoreError(
        'artifact_missing',
        `artifact missing: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new ArtifactStoreError('artifact_corrupt', 'artifact is not a regular file');
    }
    if (st.size !== ref.bytes) {
      throw new ArtifactStoreError('artifact_corrupt', 'artifact size does not match ref');
    }
    let real: string;
    try {
      real = fs.realpathSync(absolute);
    } catch (err) {
      throw new ArtifactStoreError(
        'artifact_corrupt',
        `artifact realpath failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    const rel = path.relative(runReal, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ArtifactStoreError('artifact_corrupt', 'artifact path escapes run directory');
    }

    let fd: number | undefined;
    try {
      fd = openNoFollow(absolute, fs.constants.O_RDONLY);
      const buf = fs.readFileSync(fd);
      if (buf.length !== ref.bytes) {
        throw new ArtifactStoreError('artifact_corrupt', 'artifact size does not match ref');
      }
      const digest = sha256Hex(buf);
      if (digest !== ref.sha256) {
        throw new ArtifactStoreError('artifact_corrupt', 'artifact digest mismatch');
      }
      return { absolute: real, buf };
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
  }

  return {
    async writeTextArtifact(runId, runDir, payload, text) {
      const bytes = Buffer.from(text, 'utf8');
      return writeBytes(runId, runDir, payload, 'text/plain; charset=utf-8', bytes);
    },

    async writeJsonArtifact(runId, runDir, payload, value) {
      // Reject non-JSON values that JSON.stringify would drop or mangle silently.
      if (value === undefined) {
        throw new ArtifactStoreError('artifact_invalid', 'JSON artifact value cannot be undefined');
      }
      const text = serializeJsonArtifact(value);
      // Round-trip check for non-finite numbers etc.
      try {
        JSON.parse(text);
      } catch (err) {
        throw new ArtifactStoreError(
          'artifact_invalid',
          `JSON artifact is not re-parseable: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return writeBytes(runId, runDir, payload, 'application/json', Buffer.from(text, 'utf8'));
    },

    async readTextArtifact(runId, runDir, ref) {
      if (ref.mediaType !== 'text/plain; charset=utf-8') {
        throw new ArtifactStoreError('artifact_corrupt', 'artifact mediaType is not text');
      }
      const { buf } = await verifyFile(runId, runDir, ref);
      return buf.toString('utf8');
    },

    async readJsonArtifact(runId, runDir, ref) {
      if (ref.mediaType !== 'application/json') {
        throw new ArtifactStoreError('artifact_corrupt', 'artifact mediaType is not json');
      }
      const { buf } = await verifyFile(runId, runDir, ref);
      try {
        return JSON.parse(buf.toString('utf8'));
      } catch (err) {
        throw new ArtifactStoreError(
          'artifact_corrupt',
          `artifact JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    },

    async resolveArtifactPath(runId, runDir, ref) {
      const { absolute } = await verifyFile(runId, runDir, ref);
      return absolute;
    },
  };
}

/** Test helper: create a unique temp run dir under os.tmpdir(). */
export function makeTempRunDir(prefix = 'pi-agents-artifact-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  mkdirPrivate(dir);
  return dir;
}
