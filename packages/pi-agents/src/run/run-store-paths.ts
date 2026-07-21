// ABOUTME: Cross-platform runs-root resolution and mandatory filesystem capability probing.
// ABOUTME: Rejects filesystems lacking regular-file fsync or hard-link no-replace publication.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const PACKAGE_RUNS_SEGMENTS = ['@balaenis', 'pi-agents', 'runs'] as const;
const FILE_FSYNC_PROBE_BYTES = Buffer.from('pi-agents-run-store-file-fsync-probe-v1\n', 'utf8');
const HARD_LINK_PROBE_BYTES = Buffer.from('pi-agents-run-store-hard-link-probe-v1\n', 'utf8');

/** Injectable inputs for host-independent root resolution tests. */
export interface ResolveRunsRootInput {
  rootDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
  cwd?: string;
}

/** Capabilities retained after successful root initialization. */
export interface RunStoreCapabilities {
  /** Always true when initialization succeeds; regular-file fsync is mandatory. */
  fileFsync: true;
  /** True when directory open/fsync succeeded; false only for documented platform absences. */
  directoryFsync: boolean;
}

/** Injectable filesystem ops for deterministic capability-probe tests. */
export interface RunsRootProbeFs {
  fsyncSync?: (fd: number) => void;
  linkSync?: (existingPath: string, newPath: string) => void;
  openSync?: typeof fs.openSync;
  unlinkSync?: (path: string) => void;
}

export interface InitializeRunsRootOptions {
  platform?: NodeJS.Platform;
  /** Test seam: override probe filesystem operations; production defaults to node:fs. */
  probeFs?: RunsRootProbeFs;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function pathModuleFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function homeFor(input: ResolveRunsRootInput, platform: NodeJS.Platform): string {
  if (isNonEmptyString(input.homeDir)) return input.homeDir;
  // When callers inject env, use only that map; otherwise read the live process env.
  const env = input.env ?? process.env;
  if (platform === 'win32') {
    if (isNonEmptyString(env.USERPROFILE)) return env.USERPROFILE;
    if (isNonEmptyString(env.HOME)) return env.HOME;
  } else if (isNonEmptyString(env.HOME)) {
    return env.HOME;
  }
  return os.homedir();
}

function cwdFor(input: ResolveRunsRootInput): string {
  if (isNonEmptyString(input.cwd)) return input.cwd;
  return process.cwd();
}

/**
 * Resolve the durable runs root.
 *
 * Precedence:
 * 1. non-empty programmatic `rootDir`
 * 2. non-empty `PI_AGENTS_RUNS_DIR`
 * 3. Windows: non-empty `LOCALAPPDATA`, else `<home>/AppData/Local` (+ package segments)
 * 4. non-Windows: non-empty `XDG_STATE_HOME`, else `<home>/.local/state` (+ package segments)
 *
 * Programmatic and env overrides are complete roots (no package suffix). Relative values
 * resolve against `cwd`. Values are not trimmed. Explicit empty programmatic `rootDir` is
 * rejected; empty `PI_AGENTS_RUNS_DIR` is ignored.
 */
export function resolveRunsRoot(input: ResolveRunsRootInput = {}): string {
  const platform = input.platform ?? process.platform;
  const pathMod = pathModuleFor(platform);
  const env = input.env ?? process.env;
  const cwd = cwdFor(input);

  if (input.rootDir !== undefined) {
    if (!isNonEmptyString(input.rootDir)) {
      throw runStoreError('rootDir must be a non-empty path when provided');
    }
    return pathMod.normalize(pathMod.resolve(cwd, input.rootDir));
  }

  const envRoot = env.PI_AGENTS_RUNS_DIR;
  if (isNonEmptyString(envRoot)) {
    return pathMod.normalize(pathMod.resolve(cwd, envRoot));
  }

  const home = homeFor(input, platform);
  let base: string;
  if (platform === 'win32') {
    base = isNonEmptyString(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : pathMod.join(home, 'AppData', 'Local');
  } else {
    base = isNonEmptyString(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : pathMod.join(home, '.local', 'state');
  }

  return pathMod.normalize(pathMod.resolve(cwd, pathMod.join(base, ...PACKAGE_RUNS_SEGMENTS)));
}

/** Default production runs root for the current process. */
export function getDefaultRunsRoot(): string {
  return resolveRunsRoot();
}

function applyModeBestEffort(targetPath: string, mode: number, platform: NodeJS.Platform): void {
  if (platform === 'win32') return;
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    /* best-effort */
  }
}

function mkdirPrivate(dir: string, platform: NodeJS.Platform): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  applyModeBestEffort(dir, DIR_MODE, platform);
}

function uniqueProbeToken(): string {
  return `${process.pid}.${Date.now()}.${crypto.randomUUID()}`;
}

function runStoreError(message: string): { code: 'run_store_error'; message: string } {
  return { code: 'run_store_error', message };
}

function errnoCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function removeKnownProbeFile(
  filePath: string,
  unlinkSync: (path: string) => void = fs.unlinkSync
): void {
  try {
    unlinkSync(filePath);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return;
    throw runStoreError(`probe cleanup failed for ${path.basename(filePath)}: ${messageOf(err)}`);
  }
}

function isDocumentedDirectoryFsyncUnavailable(
  code: string | undefined,
  platform: NodeJS.Platform
): boolean {
  if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'ENOSYS' || code === 'EISDIR') {
    return true;
  }
  return platform === 'win32' && code === 'EPERM';
}

/**
 * Classify no-replace publication errors.
 * `EEXIST` / `ENOTEMPTY` are always contention.
 * Windows `EPERM` is contention only when `destinationExists()` is true.
 */
export function isNoReplaceContentionError(
  err: unknown,
  destinationExists: () => boolean,
  platform: NodeJS.Platform = process.platform
): boolean {
  const code = errnoCode(err);
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return true;
  if (platform === 'win32' && code === 'EPERM') {
    try {
      return destinationExists();
    } catch {
      return false;
    }
  }
  return false;
}

function probeFileFsync(
  rootDir: string,
  platform: NodeJS.Platform,
  token: string,
  probeFs: RunsRootProbeFs = {}
): void {
  const fsyncSync = probeFs.fsyncSync ?? fs.fsyncSync.bind(fs);
  const openSync = probeFs.openSync ?? fs.openSync.bind(fs);
  const unlinkSync = probeFs.unlinkSync ?? fs.unlinkSync.bind(fs);
  const probePath = path.join(rootDir, `.capability-file-fsync.${token}`);
  let fd: number | undefined;
  try {
    fd = openSync(
      probePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      FILE_MODE
    );
    applyModeBestEffort(probePath, FILE_MODE, platform);
    fs.writeFileSync(fd, FILE_FSYNC_PROBE_BYTES);
    try {
      fsyncSync(fd);
    } catch (err) {
      throw runStoreError(
        `regular-file fsync is required but failed: ${messageOf(err)}. ` +
          'Use a filesystem that supports durable file sync for the runs root.'
      );
    }
    fs.closeSync(fd);
    fd = undefined;
    const readBack = fs.readFileSync(probePath);
    if (!readBack.equals(FILE_FSYNC_PROBE_BYTES)) {
      throw runStoreError(
        'regular-file fsync probe read-back mismatch; refusing to initialize RunStore'
      );
    }
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'run_store_error') {
      throw err;
    }
    throw runStoreError(
      `regular-file fsync probe failed: ${messageOf(err)}. ` +
        'Use a filesystem that supports exclusive create and durable file sync.'
    );
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    removeKnownProbeFile(probePath, unlinkSync);
  }
}

function probeHardLink(
  rootDir: string,
  platform: NodeJS.Platform,
  token: string,
  probeFs: RunsRootProbeFs = {}
): void {
  const fsyncSync = probeFs.fsyncSync ?? fs.fsyncSync.bind(fs);
  const linkSync = probeFs.linkSync ?? fs.linkSync.bind(fs);
  const openSync = probeFs.openSync ?? fs.openSync.bind(fs);
  const unlinkSync = probeFs.unlinkSync ?? fs.unlinkSync.bind(fs);
  const sourcePath = path.join(rootDir, `.capability-hardlink-src.${token}`);
  const destPath = path.join(rootDir, `.capability-hardlink-dst.${token}`);
  const occupiedPath = path.join(rootDir, `.capability-hardlink-occupied.${token}`);
  let srcFd: number | undefined;
  let occFd: number | undefined;
  try {
    srcFd = openSync(
      sourcePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      FILE_MODE
    );
    applyModeBestEffort(sourcePath, FILE_MODE, platform);
    fs.writeFileSync(srcFd, HARD_LINK_PROBE_BYTES);
    fsyncSync(srcFd);
    fs.closeSync(srcFd);
    srcFd = undefined;

    occFd = openSync(
      occupiedPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      FILE_MODE
    );
    applyModeBestEffort(occupiedPath, FILE_MODE, platform);
    fs.writeFileSync(occFd, Buffer.from('occupied\n', 'utf8'));
    fsyncSync(occFd);
    fs.closeSync(occFd);
    occFd = undefined;

    try {
      linkSync(sourcePath, destPath);
    } catch (err) {
      throw runStoreError(
        `hard-link publication is required but failed: ${messageOf(err)}. ` +
          'Use a filesystem that supports hard links under the runs root.'
      );
    }

    const srcStat = fs.statSync(sourcePath);
    const dstStat = fs.statSync(destPath);
    if (srcStat.dev !== dstStat.dev || srcStat.ino !== dstStat.ino) {
      throw runStoreError(
        'hard-link probe did not produce a shared cooperative generation (dev/ino mismatch)'
      );
    }
    const linkedBytes = fs.readFileSync(destPath);
    if (!linkedBytes.equals(HARD_LINK_PROBE_BYTES)) {
      throw runStoreError('hard-link probe destination content mismatch');
    }

    try {
      linkSync(sourcePath, occupiedPath);
      // If link succeeded onto an existing name, the filesystem replaced or aliased
      // incorrectly — mandatory no-replace semantics are missing.
      throw runStoreError(
        'hard-link probe replaced an occupied destination; no-replace publication is required'
      );
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        (err as { code?: unknown }).code === 'run_store_error'
      ) {
        throw err;
      }
      if (
        !isNoReplaceContentionError(
          err,
          () => {
            try {
              fs.lstatSync(occupiedPath);
              return true;
            } catch {
              return false;
            }
          },
          platform
        )
      ) {
        throw runStoreError(
          `hard-link no-replace probe failed unexpectedly: ${messageOf(err)}. ` +
            'Use a filesystem that rejects hard links onto existing destinations.'
        );
      }
    }

    // Occupied destination content must remain unchanged.
    const occupiedBytes = fs.readFileSync(occupiedPath);
    if (!occupiedBytes.equals(Buffer.from('occupied\n', 'utf8'))) {
      throw runStoreError('hard-link probe mutated an occupied destination');
    }
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'run_store_error') {
      throw err;
    }
    throw runStoreError(`hard-link capability probe failed: ${messageOf(err)}`);
  } finally {
    if (srcFd !== undefined) {
      try {
        fs.closeSync(srcFd);
      } catch {
        /* ignore */
      }
    }
    if (occFd !== undefined) {
      try {
        fs.closeSync(occFd);
      } catch {
        /* ignore */
      }
    }
    removeKnownProbeFile(sourcePath, unlinkSync);
    removeKnownProbeFile(destPath, unlinkSync);
    removeKnownProbeFile(occupiedPath, unlinkSync);
  }
}

function probeDirectoryFsync(
  rootDir: string,
  platform: NodeJS.Platform,
  probeFs: RunsRootProbeFs = {}
): { directoryFsync: boolean } {
  const fsyncSync = probeFs.fsyncSync ?? fs.fsyncSync.bind(fs);
  const openSync = probeFs.openSync ?? fs.openSync.bind(fs);
  let dirFd: number | undefined;
  try {
    dirFd = openSync(rootDir, 'r');
    try {
      fsyncSync(dirFd);
    } catch (err) {
      const code = errnoCode(err);
      if (isDocumentedDirectoryFsyncUnavailable(code, platform)) {
        return { directoryFsync: false };
      }
      throw runStoreError(
        `directory fsync probe failed unexpectedly (${code ?? 'unknown'}): ${messageOf(err)}`
      );
    }
    return { directoryFsync: true };
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'run_store_error') {
      throw err;
    }
    const code = errnoCode(err);
    if (isDocumentedDirectoryFsyncUnavailable(code, platform)) {
      return { directoryFsync: false };
    }
    throw runStoreError(
      `directory fsync probe open failed unexpectedly (${code ?? 'unknown'}): ${messageOf(err)}`
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

/**
 * Create the runs root (recursive, best-effort 0700) and probe mandatory capabilities.
 * Fails closed when regular-file fsync or hard-link no-replace publication is unavailable.
 */
export function initializeRunsRoot(
  rootDir: string,
  options: InitializeRunsRootOptions = {}
): RunStoreCapabilities {
  if (!isNonEmptyString(rootDir)) {
    throw runStoreError('runs root must be a non-empty path');
  }
  const platform = options.platform ?? process.platform;
  const absoluteRoot = path.resolve(rootDir);
  try {
    mkdirPrivate(absoluteRoot, platform);
  } catch (err) {
    throw runStoreError(`cannot create runs root: ${messageOf(err)}`);
  }

  const token = uniqueProbeToken();
  const probeFs = options.probeFs ?? {};
  probeFileFsync(absoluteRoot, platform, token, probeFs);
  probeHardLink(absoluteRoot, platform, token, probeFs);
  const { directoryFsync } = probeDirectoryFsync(absoluteRoot, platform, probeFs);

  return { fileFsync: true, directoryFsync };
}
