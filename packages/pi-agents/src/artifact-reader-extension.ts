// ABOUTME: Child-only Pi extension that exposes bounded run-local artifact reads.
// ABOUTME: Derives digest paths from private env; never accepts caller-supplied filesystem paths.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ARTIFACT_READER_CHUNK_MAX_BYTES } from './constants.ts';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const MIN_CHUNK = 4;

function envRunId(): string | undefined {
  return process.env.PI_AGENTS_RUN_ID;
}

function envArtifactDir(): string | undefined {
  return process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
}

function unavailable(): never {
  throw new Error('artifact_unavailable');
}

function invalidOffset(): never {
  throw new Error('invalid_artifact_offset');
}

function isUtf8Boundary(buf: Buffer, index: number): boolean {
  if (index <= 0 || index >= buf.length) return true;
  // Continuation bytes are 10xxxxxx.
  return (buf[index]! & 0b1100_0000) !== 0b1000_0000;
}

function retreatToUtf8Boundary(buf: Buffer, end: number): number {
  let i = end;
  while (i > 0 && !isUtf8Boundary(buf, i)) i--;
  return i;
}

/** Narrow filesystem operations dependency injected at registration time. */
export interface ArtifactReaderFs {
  fstatSync: (fd: number) => fs.Stats;
  lstatSync: (path: string) => fs.Stats;
  openSync: (path: string, flags: number) => number;
  readFileSync: (fd: number) => Buffer;
  closeSync: (fd: number) => void;
  realpathSync: (path: string) => string;
}

const defaultFs: ArtifactReaderFs = {
  fstatSync: (fd: number) => fs.fstatSync(fd),
  lstatSync: (p: string) => fs.lstatSync(p),
  openSync: (p: string, flags: number) => fs.openSync(p, flags),
  readFileSync: (fd: number) => fs.readFileSync(fd),
  closeSync: (fd: number) => fs.closeSync(fd),
  realpathSync: (p: string) => fs.realpathSync(p),
};

/**
 * Open the digest-derived artifact with no-follow semantics, verify the
 * inode against a trusted root, then read/hash/chunk against the same
 * file descriptor. Every filesystem and security error collapses to
 * `artifact_unavailable` without path-existence details.
 */
function readArtifactFile(
  afs: ArtifactReaderFs,
  runId: string,
  sha256: string,
  mediaType: 'text' | 'json'
): Buffer {
  const fstatSync = afs.fstatSync;
  const lstatSync = afs.lstatSync;

  // All path work happens inside the single error-collapse boundary so no
  // filesystem/security error can leak a path or native message.
  let fd: number | undefined;
  let securityError = false;
  try {
    const root = envArtifactDir();
    const envId = envRunId();
    if (!root || !envId || envId !== runId) unavailable();
    if (!SHA256_HEX.test(sha256)) unavailable();

    const ext = mediaType === 'json' ? 'json' : 'txt';
    const relative = path.join('artifacts', 'sha256', sha256.slice(0, 2), `${sha256}.${ext}`);
    const absolute = path.resolve(root, relative);

    // Resolve the trusted root once; every containment check uses this real path.
    const rootReal = afs.realpathSync(root);
    const rel = path.relative(rootReal, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel)) unavailable();

    // Validate every intermediate component from the trusted root through
    // artifacts/sha256/<prefix> with lstat before open; reject symlinks and
    // non-directories.
    validateIntermediateComponents(afs, rootReal, relative);

    // Open the final file with O_NOFOLLOW where supported. On targets that
    // lack O_NOFOLLOW, fail closed rather than falling back to pathname reads.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const noFollowFlag: number | undefined = (fs.constants as any).O_NOFOLLOW;
    if (noFollowFlag === undefined) unavailable();
    fd = afs.openSync(absolute, fs.constants.O_RDONLY | noFollowFlag);

    // Pre-read stat: must be a regular file.
    const preStat = fstatSync(fd);
    if (!preStat.isFile()) unavailable();

    // Compare fstat identity (dev/ino where available) with a post-open lstat
    // of the digest-derived path so a pathname swap after open is detected.
    const postOpenLstat = lstatSync(absolute);
    if (!postOpenLstat.isFile()) unavailable();
    if (!sameFileIdentity(preStat, postOpenLstat)) unavailable();

    // Resolve the opened path after open and require its real path to be
    // contained under the real run root and to correspond to the expected
    // digest-derived location.
    const openedReal = afs.realpathSync(absolute);
    const openedRel = path.relative(rootReal, openedReal);
    if (openedRel.startsWith('..') || path.isAbsolute(openedRel)) unavailable();
    if (openedRel !== relative.split(path.sep).join(path.posix.sep)) unavailable();

    const expectedSize = preStat.size;

    // Read the entire file through the same fd.
    const buf = afs.readFileSync(fd);

    // Verify digest.
    const digest = crypto.createHash('sha256').update(buf).digest('hex');
    if (digest !== sha256) unavailable();

    // Post-read stat: size must match and fd must still be a regular file.
    const postStat = fstatSync(fd);
    if (!postStat.isFile() || postStat.size !== expectedSize) unavailable();

    // Repeat path identity and intermediate-component checks after read so a
    // swap or symlink insertion during read cannot go undetected.
    const postReadLstat = lstatSync(absolute);
    if (!postReadLstat.isFile()) unavailable();
    if (!sameFileIdentity(postStat, postReadLstat)) unavailable();
    validateIntermediateComponents(afs, rootReal, relative);

    return buf;
  } catch (err) {
    if (err instanceof Error && err.message === 'artifact_unavailable') {
      securityError = true;
      throw err;
    }
    // Collapse every unexpected filesystem/permission/IO error.
    if (!securityError) unavailable();
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        afs.closeSync(fd);
      } catch {
        // Close error must not replace a security error.
        if (!securityError) unavailable();
      }
    }
  }
}

/**
 * Validate every intermediate component from the trusted real root through the
 * digest-derived parent directory. Rejects symlinks and non-directories.
 * Each component is lstat'd; a symlink or non-directory anywhere on the path
 * fails closed.
 */
function validateIntermediateComponents(
  afs: ArtifactReaderFs,
  rootReal: string,
  relative: string
): void {
  const parts = relative.split(path.sep).filter((p) => p.length > 0);
  let current = rootReal;
  // The final component is the artifact file itself (validated by open+lstat);
  // only validate intermediate directories here.
  for (let i = 0; i < parts.length - 1; i++) {
    current = path.join(current, parts[i]!);
    let st: fs.Stats;
    try {
      st = afs.lstatSync(current);
    } catch {
      unavailable();
    }
    if (st.isSymbolicLink()) unavailable();
    if (!st.isDirectory()) unavailable();
  }
}

/**
 * Compare two stats for file identity.
 * Requires stable dev and ino on both stats and exact equality.
 * If either identity is unavailable or unusable, fail closed (return false).
 * Size equality is never a substitute for missing identity.
 */
function sameFileIdentity(a: fs.Stats, b: fs.Stats): boolean {
  if (
    typeof a.dev !== 'number' ||
    typeof b.dev !== 'number' ||
    typeof a.ino !== 'number' ||
    typeof b.ino !== 'number'
  ) {
    return false;
  }
  return a.dev === b.dev && a.ino === b.ino;
}

export default function registerArtifactReaderExtension(
  pi: ExtensionAPI,
  fsOps?: ArtifactReaderFs
): void {
  const afs: ArtifactReaderFs = fsOps ?? defaultFs;
  pi.registerTool({
    name: 'pi_agents_read_artifact',
    label: 'Read run artifact',
    description:
      'Read a bounded chunk of a run-local artifact previously handed off to this child. ' +
      'Pass runId, sha256, mediaType (text|json), offsetBytes, and optional maxBytes.',
    parameters: Type.Object({
      runId: Type.String(),
      sha256: Type.String(),
      mediaType: Type.Union([Type.Literal('text'), Type.Literal('json')]),
      offsetBytes: Type.Integer({ minimum: 0 }),
      maxBytes: Type.Optional(
        Type.Integer({ minimum: MIN_CHUNK, maximum: ARTIFACT_READER_CHUNK_MAX_BYTES })
      ),
    }),
    async execute(_toolCallId, params) {
      const runId = String(params.runId);
      const sha256 = String(params.sha256).toLowerCase();
      const mediaType = params.mediaType === 'json' ? 'json' : 'text';
      const offsetBytes = Number(params.offsetBytes);
      const maxBytes = Math.min(
        Math.max(Number(params.maxBytes ?? ARTIFACT_READER_CHUNK_MAX_BYTES), MIN_CHUNK),
        ARTIFACT_READER_CHUNK_MAX_BYTES
      );

      const buf = readArtifactFile(afs, runId, sha256, mediaType);
      if (!Number.isInteger(offsetBytes) || offsetBytes < 0 || offsetBytes > buf.length) {
        invalidOffset();
      }
      if (offsetBytes < buf.length && !isUtf8Boundary(buf, offsetBytes)) {
        invalidOffset();
      }

      if (offsetBytes === buf.length) {
        return {
          content: [{ type: 'text', text: '' }],
          details: {
            offsetBytes,
            nextOffsetBytes: offsetBytes,
            bytesReturned: 0,
            eof: true,
          },
        };
      }

      let end = Math.min(buf.length, offsetBytes + maxBytes);
      end = retreatToUtf8Boundary(buf, end);
      if (end <= offsetBytes) {
        // Ensure progress of at least one code point when possible.
        end = Math.min(buf.length, offsetBytes + 1);
        while (end < buf.length && !isUtf8Boundary(buf, end)) end++;
      }
      const slice = buf.subarray(offsetBytes, end);
      const content = slice.toString('utf8');
      const bytesReturned = slice.length;
      const nextOffsetBytes = offsetBytes + bytesReturned;
      return {
        content: [{ type: 'text', text: content }],
        details: {
          offsetBytes,
          nextOffsetBytes,
          bytesReturned,
          eof: nextOffsetBytes >= buf.length,
        },
      };
    },
  });
}
