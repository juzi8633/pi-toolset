// ABOUTME: Child-only Pi extension that exposes bounded run-local artifact reads.
// ABOUTME: Derives digest paths from private env; never accepts caller-supplied filesystem paths.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ARTIFACT_READER_CHUNK_MAX_BYTES, RUN_ARTIFACT_MAX_BYTES } from '../shared/constants.ts';

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

/** Ordinary open/stat/read/close operations injected at registration time. */
export interface ArtifactReaderFs {
  fstatSync: (fd: number) => fs.Stats;
  openSync: (path: string, flags: number) => number;
  readFileSync: (fd: number) => Buffer;
  closeSync: (fd: number) => void;
}

const defaultFs: ArtifactReaderFs = {
  fstatSync: (fd: number) => fs.fstatSync(fd),
  openSync: (p: string, flags: number) => fs.openSync(p, flags),
  readFileSync: (fd: number) => fs.readFileSync(fd),
  closeSync: (fd: number) => fs.closeSync(fd),
};

/**
 * Open the digest-derived artifact via ordinary pathnames under the trusted
 * run artifact directory. Validate syntactic containment, regular-file status,
 * size, and SHA-256. Collapse every filesystem detail to artifact_unavailable.
 */
function readArtifactFile(
  afs: ArtifactReaderFs,
  runId: string,
  sha256: string,
  mediaType: 'text' | 'json'
): Buffer {
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

    // Syntactic containment under the configured run root (no realpath/inode).
    const rootResolved = path.resolve(root);
    const rel = path.relative(rootResolved, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel)) unavailable();
    // Expected relative form must match digest-derived location.
    if (
      rel.split(path.sep).join(path.posix.sep) !== relative.split(path.sep).join(path.posix.sep)
    ) {
      unavailable();
    }

    fd = afs.openSync(absolute, fs.constants.O_RDONLY);

    const preStat = afs.fstatSync(fd);
    if (!preStat.isFile()) unavailable();
    const expectedSize = preStat.size;
    if (expectedSize > RUN_ARTIFACT_MAX_BYTES) unavailable();

    const buf = afs.readFileSync(fd);

    const digest = crypto.createHash('sha256').update(buf).digest('hex');
    if (digest !== sha256) unavailable();

    const postStat = afs.fstatSync(fd);
    if (!postStat.isFile() || postStat.size !== expectedSize) unavailable();
    if (buf.length !== expectedSize) unavailable();

    return buf;
  } catch (err) {
    if (err instanceof Error && err.message === 'artifact_unavailable') {
      securityError = true;
      throw err;
    }
    if (!securityError) unavailable();
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        afs.closeSync(fd);
      } catch {
        if (!securityError) unavailable();
      }
    }
  }
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
      // Validate original digest as lowercase hex; do not normalize case.
      const sha256 = String(params.sha256);
      if (!SHA256_HEX.test(sha256)) unavailable();
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
