// ABOUTME: Durable run store — versioned snapshots, event log, and append-only ticket claims.
// ABOUTME: All paths resolve under ~/.pi/agent/@balaenis/pi-agents/runs/; tests inject a temp root.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  AgentRunRecordV1,
  ClaimOwner,
  ClaimResult,
  ClaimTerminal,
  CorruptRunEntry,
  ListRunsResult,
  LoadedRun,
  RunLifecycleEvent,
  RunStoreError,
} from './run-types.ts';
import { RUN_RECORD_VERSION } from './run-types.ts';

/** Fixed-width decimal ticket width; preserves lexical ordering of claim directories. */
const TICKET_WIDTH = 16;

const RUN_STATUS_VALUES = new Set([
  'queued',
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
]);

export function getDefaultRunsRoot(): string {
  // Tests inject a custom rootDir; the process-level HOME env override
  // ensures getDefaultRunsRoot picks up temp directories during testing.
  const home = process.env.HOME ?? os.homedir();
  return path.join(home, '.pi', 'agent', '@balaenis', 'pi-agents', 'runs');
}

const POSIX = process.platform !== 'win32';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function applyMode(targetPath: string, mode: number): void {
  if (!POSIX) return;
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    // best-effort
  }
}

function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  applyMode(dir, DIR_MODE);
}

function fsyncFd(fd: number): void {
  try {
    fs.fsyncSync(fd);
  } catch {
    // best-effort
  }
}

function fsyncDir(dirPath: string): void {
  if (!POSIX) return;
  try {
    const dirFd = fs.openSync(dirPath, 'r');
    fsyncFd(dirFd);
    fs.closeSync(dirFd);
  } catch {
    // best-effort
  }
}

function isUnitIdValid(id: string): boolean {
  return /^[a-z0-9-]+$/.test(id);
}

function isRunIdValid(id: string): boolean {
  if (!id || id.includes(path.sep) || id.includes('/') || id.includes('\\')) return false;
  return /^[a-zA-Z0-9-]+$/.test(id);
}

/** Per-run write queue so overlapping streaming updates cannot interleave temp renames. */
type QueuedTask<T> = () => Promise<T>;
interface RunQueue {
  tail: Promise<unknown>;
}

export interface CreateRunStoreOptions {
  rootDir?: string;
  now?: () => number;
  randomUUID?: () => string;
  pid?: number;
  instanceId?: string;
}

export interface CreateRunInput {
  mode: 'single' | 'parallel' | 'chain';
  agentScope: import('./agents.ts').AgentScope;
  background: boolean;
  request: import('./run-types.ts').StoredRunRequest;
  details: import('./types.ts').SubagentDetails;
  units: Record<string, import('./run-types.ts').RunUnitRecord>;
}

export interface UpdateRunInput {
  record: AgentRunRecordV1;
}

export interface ClaimInfo {
  claimId: string;
  ticket: number;
}

export interface RunStore {
  readonly rootDir: string;
  /** Resolve the on-disk directory for a run id (exists once createRun succeeds). */
  getRunDir(runId: string): string;
  createRun(input: CreateRunInput): Promise<{ runId: string; record: AgentRunRecordV1 }>;
  getRun(runId: string): { ok: true; loaded: LoadedRun } | { ok: false; error: RunStoreError };
  updateRun(runId: string, mutate: (record: AgentRunRecordV1) => void): Promise<AgentRunRecordV1>;
  appendEvent(runId: string, event: RunLifecycleEvent): Promise<void>;
  listRuns(): Promise<ListRunsResult>;
  claimRun(runId: string): Promise<ClaimResult>;
  releaseRun(runId: string, claimId: string): Promise<void>;
  abandonRun(runId: string, claimId: string): Promise<void>;
  /** Inspect published claims for a run without participating. */
  inspectClaims(runId: string):
    | {
        ok: true;
        claims: Array<{
          ticket: number;
          owner?: ClaimOwner;
          terminal?: ClaimTerminal;
          ownerError?: string;
          terminalError?: string;
        }>;
      }
    | { ok: false; error: RunStoreError };
  /** Test/inspection helper: is the given PID alive (false on ESRCH/ENOSYS). */
  isPidAlive(pid: number): boolean;
}

export function createRunStore(options: CreateRunStoreOptions = {}): RunStore {
  const rootDir = options.rootDir ?? getDefaultRunsRoot();
  const now = options.now ?? (() => Date.now());
  const randomUUID = options.randomUUID ?? crypto.randomUUID;
  const pid = options.pid ?? process.pid;
  const instanceId = options.instanceId ?? `${process.ppid ?? 0}-${Date.now()}-${randomUUID()}`;

  mkdirPrivate(rootDir);

  const queues = new Map<string, RunQueue>();

  function getQueue(runId: string): RunQueue {
    let q = queues.get(runId);
    if (!q) {
      q = { tail: Promise.resolve() };
      queues.set(runId, q);
    }
    return q;
  }

  function runSerial<T>(runId: string, task: QueuedTask<T>): Promise<T> {
    const q = getQueue(runId);
    const result = q.tail.then(task, task);
    q.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  function runDirOf(runId: string): string {
    return path.join(rootDir, runId);
  }

  function getRunDir(runId: string): string {
    return runDirOf(runId);
  }

  function runJsonPath(runId: string): string {
    return path.join(runDirOf(runId), 'run.json');
  }

  function eventsPath(runId: string): string {
    return path.join(runDirOf(runId), 'events.jsonl');
  }

  function claimsDir(runId: string): string {
    return path.join(runDirOf(runId), 'claims');
  }

  function validateRunRecord(
    raw: unknown,
    expectedRunId: string,
    expectedDir: string
  ): { ok: true; record: AgentRunRecordV1 } | { ok: false; error: RunStoreError } {
    if (!raw || typeof raw !== 'object') {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'record is not an object' },
      };
    }
    const r = raw as Partial<AgentRunRecordV1>;
    if (r.version !== RUN_RECORD_VERSION) {
      return {
        ok: false,
        error: {
          code: 'corrupt_run',
          runId: expectedRunId,
          message: `unsupported version ${String(r.version)}`,
        },
      };
    }
    if (r.runId !== expectedRunId) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'runId mismatch' },
      };
    }
    if (typeof r.mode !== 'string' || !['single', 'parallel', 'chain'].includes(r.mode)) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'invalid mode' },
      };
    }
    if (typeof r.status !== 'string' || !RUN_STATUS_VALUES.has(r.status)) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'invalid status' },
      };
    }
    if (typeof r.details !== 'object' || r.details === null) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'invalid details' },
      };
    }
    if (typeof r.units !== 'object' || r.units === null) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'invalid units' },
      };
    }
    const requestError = validateStoredRequest(r.request, r.mode);
    if (requestError) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: requestError },
      };
    }
    for (const [unitId, unit] of Object.entries(r.units)) {
      if (!isUnitIdValid(unitId)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `invalid unit id ${unitId}`,
          },
        };
      }
      if (!unit || typeof unit !== 'object') {
        return {
          ok: false,
          error: { code: 'corrupt_run', runId: expectedRunId, message: `invalid unit ${unitId}` },
        };
      }
      const u = unit as unknown as Record<string, unknown>;
      if (u.sessionFile !== undefined && typeof u.sessionFile !== 'string') {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} sessionFile not string`,
          },
        };
      }
      if (u.acpSessionId !== undefined) {
        if (
          typeof u.acpSessionId !== 'string' ||
          u.acpSessionId.trim().length === 0 ||
          u.acpSessionId !== u.acpSessionId.trim()
        ) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} acpSessionId must be a trimmed non-empty string`,
            },
          };
        }
      }
      if (u.worktreePath !== undefined && typeof u.worktreePath !== 'string') {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} worktreePath not string`,
          },
        };
      }
    }
    if (r.continuationTasks !== undefined) {
      if (!Array.isArray(r.continuationTasks)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: 'continuationTasks is not an array',
          },
        };
      }
      for (let i = 0; i < r.continuationTasks.length; i++) {
        if (typeof r.continuationTasks[i] !== 'string') {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationTasks[${i}] is not a string`,
            },
          };
        }
      }
    }
    if (r.continuationDelivery !== undefined) {
      if (typeof r.continuationDelivery !== 'object' || r.continuationDelivery === null) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: 'continuationDelivery is not an object',
          },
        };
      }
      const continuationTaskCount = Array.isArray(r.continuationTasks)
        ? r.continuationTasks.length
        : 0;
      const units =
        r.units && typeof r.units === 'object' && r.units !== null
          ? (r.units as Record<string, unknown>)
          : undefined;
      for (const [unitId, entry] of Object.entries(r.continuationDelivery)) {
        // Orphan delivery keys (no matching unit) are corrupt.
        if (!units || !(unitId in units)) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationDelivery[${unitId}] has no matching unit`,
            },
          };
        }
        if (!entry || typeof entry !== 'object') {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationDelivery[${unitId}] is not an object`,
            },
          };
        }
        const deliveredCount = (entry as { deliveredCount?: unknown }).deliveredCount;
        if (
          typeof deliveredCount !== 'number' ||
          !Number.isInteger(deliveredCount) ||
          deliveredCount < 0
        ) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationDelivery[${unitId}].deliveredCount is invalid`,
            },
          };
        }
        // deliveredCount is how many of continuationTasks[0..n) were confirmed.
        if (deliveredCount > continuationTaskCount) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationDelivery[${unitId}].deliveredCount ${deliveredCount} exceeds continuationTasks length ${continuationTaskCount}`,
            },
          };
        }
      }
    }
    void expectedDir;
    return { ok: true, record: r as AgentRunRecordV1 };
  }

  /**
   * Validate StoredRunRequest shape and mode/topology consistency.
   * Returns an error message or undefined when valid. Never throws.
   */
  function validateStoredRequest(request: unknown, mode: string): string | undefined {
    if (!request || typeof request !== 'object') {
      return 'request is not an object';
    }
    const req = request as Record<string, unknown>;
    if (req.mode !== mode) {
      return `request.mode (${String(req.mode)}) does not match record.mode (${mode})`;
    }
    if (typeof req.agentScope !== 'string') {
      return 'request.agentScope is not a string';
    }
    for (const key of [
      'model',
      'thinking',
      'runtime',
      'isolation',
      'agent',
      'task',
      'title',
      'cwd',
    ] as const) {
      if (req[key] !== undefined && typeof req[key] !== 'string') {
        return `request.${key} is not a string`;
      }
    }
    if (mode === 'single') {
      if (typeof req.agent !== 'string' || typeof req.task !== 'string') {
        return 'request single mode requires agent and task strings';
      }
      if (req.tasks !== undefined || req.chain !== undefined) {
        return 'request single mode must not include tasks or chain';
      }
    } else if (mode === 'parallel') {
      if (!Array.isArray(req.tasks) || req.tasks.length === 0) {
        return 'request parallel mode requires a non-empty tasks array';
      }
      for (let i = 0; i < req.tasks.length; i++) {
        const item = req.tasks[i];
        if (!item || typeof item !== 'object') {
          return `request.tasks[${i}] is not an object`;
        }
        const t = item as Record<string, unknown>;
        if (typeof t.agent !== 'string' || typeof t.task !== 'string') {
          return `request.tasks[${i}] requires agent and task strings`;
        }
        for (const key of ['title', 'cwd', 'isolation'] as const) {
          if (t[key] !== undefined && typeof t[key] !== 'string') {
            return `request.tasks[${i}].${key} is not a string`;
          }
        }
      }
      if (req.chain !== undefined) {
        return 'request parallel mode must not include chain';
      }
    } else if (mode === 'chain') {
      if (!Array.isArray(req.chain) || req.chain.length === 0) {
        return 'request chain mode requires a non-empty chain array';
      }
      for (let i = 0; i < req.chain.length; i++) {
        const item = req.chain[i];
        if (!item || typeof item !== 'object') {
          return `request.chain[${i}] is not an object`;
        }
        const step = item as Record<string, unknown>;
        const isFanout = 'expand' in step && !('agent' in step);
        if (isFanout) {
          if (!step.expand || typeof step.expand !== 'object') {
            return `request.chain[${i}].expand is invalid`;
          }
          if (!step.parallel || typeof step.parallel !== 'object') {
            return `request.chain[${i}].parallel is invalid`;
          }
          if (!step.collect || typeof step.collect !== 'object') {
            return `request.chain[${i}].collect is invalid`;
          }
          const parallel = step.parallel as Record<string, unknown>;
          if (typeof parallel.agent !== 'string' || typeof parallel.task !== 'string') {
            return `request.chain[${i}].parallel requires agent and task strings`;
          }
          const collect = step.collect as Record<string, unknown>;
          if (typeof collect.name !== 'string') {
            return `request.chain[${i}].collect.name is not a string`;
          }
          const expand = step.expand as Record<string, unknown>;
          if (!expand.from || typeof expand.from !== 'object') {
            return `request.chain[${i}].expand.from is invalid`;
          }
          const from = expand.from as Record<string, unknown>;
          if (typeof from.output !== 'string' || typeof from.path !== 'string') {
            return `request.chain[${i}].expand.from requires output and path strings`;
          }
        } else {
          if (typeof step.agent !== 'string' || typeof step.task !== 'string') {
            return `request.chain[${i}] requires agent and task strings`;
          }
        }
      }
      if (req.tasks !== undefined) {
        return 'request chain mode must not include tasks';
      }
    }
    return undefined;
  }

  function loadRunJson(
    runId: string
  ): { ok: true; loaded: LoadedRun } | { ok: false; error: RunStoreError } {
    const dir = runDirOf(runId);
    const file = runJsonPath(runId);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          ok: false,
          error: { code: 'run_not_found', runId, message: 'run.json not found' },
        };
      }
      return {
        ok: false,
        error: { code: 'corrupt_run', runId, message: `cannot read run.json: ${messageOf(err)}` },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'corrupt_run',
          runId,
          message: `run.json is not valid JSON: ${messageOf(err)}`,
        },
      };
    }
    const validated = validateRunRecord(parsed, runId, dir);
    if (!validated.ok) return validated;
    return { ok: true, loaded: { runDir: dir, record: validated.record } };
  }

  function writeRunContents(runId: string, record: AgentRunRecordV1): void {
    const dir = runDirOf(runId);
    const target = path.join(dir, 'run.json');
    const tmp = path.join(dir, `.run.json.${instanceId}.${randomUUID()}.tmp`);
    const data = `${JSON.stringify(record, null, 2)}\n`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, 'w', FILE_MODE);
      fs.writeFileSync(fd, data);
      fsyncFd(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, target);
      fsyncDir(dir);
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  function writeRunJsonAtomic(runId: string, record: AgentRunRecordV1): Promise<void> {
    return runSerial(runId, async () => {
      writeRunContents(runId, record);
    });
  }

  function appendEventLine(runId: string, event: RunLifecycleEvent): Promise<void> {
    return runSerial(runId, async () => {
      const file = eventsPath(runId);
      mkdirPrivate(runDirOf(runId));
      const line = `${JSON.stringify(event)}\n`;
      let fd: number | undefined;
      try {
        fd = fs.openSync(file, 'a', FILE_MODE);
        fs.writeFileSync(fd, line);
        fsyncFd(fd);
        fs.closeSync(fd);
        fd = undefined;
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
    });
  }

  function ticketDirName(ticket: number): string {
    return ticket.toString().padStart(TICKET_WIDTH, '0');
  }

  function listPublishedTickets(runId: string): number[] {
    const dir = claimsDir(runId);
    if (!fs.existsSync(dir)) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const tickets: number[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const n = parseInt(entry.name, 10);
      if (Number.isFinite(n) && entry.name === ticketDirName(n)) {
        tickets.push(n);
      }
    }
    return tickets.sort((a, b) => a - b);
  }

  function readOwner(
    ticket: number,
    runId: string
  ): { ok: true; owner: ClaimOwner } | { ok: false; error: RunStoreError } {
    const ownerPath = path.join(claimsDir(runId), ticketDirName(ticket), 'owner.json');
    let content: string;
    try {
      content = fs.readFileSync(ownerPath, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `cannot read owner.json: ${messageOf(err)}`,
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `owner.json is not valid JSON: ${messageOf(err)}`,
        },
      };
    }
    if (!parsed || typeof parsed !== 'object') {
      return {
        ok: false,
        error: { code: 'claim_corrupt', runId, message: 'owner.json is not an object' },
      };
    }
    const o = parsed as Partial<ClaimOwner>;
    if (
      typeof o.runId !== 'string' ||
      typeof o.claimId !== 'string' ||
      typeof o.instanceId !== 'string' ||
      typeof o.pid !== 'number' ||
      typeof o.acquiredAt !== 'number'
    ) {
      return {
        ok: false,
        error: { code: 'claim_corrupt', runId, message: 'owner.json missing required fields' },
      };
    }
    return { ok: true, owner: o as ClaimOwner };
  }

  function readTerminal(
    ticket: number,
    runId: string
  ):
    | { ok: true; terminal: ClaimTerminal }
    | { ok: false; error: RunStoreError }
    | { ok: false; missing: true } {
    const terminalPath = path.join(claimsDir(runId), ticketDirName(ticket), 'terminal.json');
    let content: string;
    try {
      content = fs.readFileSync(terminalPath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false, missing: true };
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `cannot read terminal.json: ${messageOf(err)}`,
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `terminal.json is not valid JSON: ${messageOf(err)}`,
        },
      };
    }
    if (!parsed || typeof parsed !== 'object') {
      return {
        ok: false,
        error: { code: 'claim_corrupt', runId, message: 'terminal.json is not an object' },
      };
    }
    const t = parsed as Partial<ClaimTerminal>;
    if (
      typeof t.claimId !== 'string' ||
      typeof t.timestamp !== 'number' ||
      (t.state !== 'released' && t.state !== 'abandoned')
    ) {
      return {
        ok: false,
        error: { code: 'claim_corrupt', runId, message: 'terminal.json missing required fields' },
      };
    }
    return { ok: true, terminal: t as ClaimTerminal };
  }

  function publishClaimTerminal(
    runId: string,
    ticket: number,
    claimId: string,
    state: 'released' | 'abandoned'
  ): Promise<void> {
    return runSerial(runId, async () => {
      const ticketDirectory = path.join(claimsDir(runId), ticketDirName(ticket));
      const terminalPath = path.join(ticketDirectory, 'terminal.json');
      const stagedPath = path.join(ticketDirectory, `.terminal.${instanceId}.${randomUUID()}.tmp`);
      const payload = JSON.stringify({ claimId, state, timestamp: now() }) + '\n';
      let fd: number | undefined;
      try {
        fd = fs.openSync(stagedPath, 'w', FILE_MODE);
        fs.writeFileSync(fd, payload);
        fsyncFd(fd);
        fs.closeSync(fd);
        fd = undefined;
        try {
          fs.linkSync(stagedPath, terminalPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') {
            const winner = readTerminal(ticket, runId);
            if ('ok' in winner && !winner.ok && !('missing' in winner)) {
              throw winner.error;
            }
            // If the winner's claimId does not match ours, another claimant
            // published a terminal for our ticket directory. Record the
            // diagnostic but do not throw — our release is still durable.
            if ('ok' in winner && winner.ok && winner.terminal.claimId !== claimId) {
              void winner;
            }
            // A terminal already exists; our release is redundant but not an error.
          } else {
            throw err;
          }
        }
        fsyncDir(ticketDirectory);
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
        try {
          if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
        } catch {
          /* ignore */
        }
      }
    });
  }

  function stageOwner(
    runId: string,
    ticket: number,
    owner: ClaimOwner
  ): { stagingDir: string; ticketDirectory: string; stagedOwnerPath: string } {
    const ticketDirectory = path.join(claimsDir(runId), ticketDirName(ticket));
    const stagingDir = path.join(claimsDir(runId), `.staging-${randomUUID()}`);
    mkdirPrivate(stagingDir);
    const stagedOwnerPath = path.join(stagingDir, 'owner.json');
    const data = JSON.stringify(owner, null, 2) + '\n';
    let fd: number | undefined;
    try {
      fd = fs.openSync(stagedOwnerPath, 'w', FILE_MODE);
      fs.writeFileSync(fd, data);
      fsyncFd(fd);
      fs.closeSync(fd);
      fd = undefined;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
    return { stagingDir, ticketDirectory, stagedOwnerPath };
  }

  function cleanupStaging(stagingDir: string): void {
    try {
      if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  type PublishResult =
    { ok: true } | { ok: false; retry: true } | { ok: false; error: RunStoreError };

  function publishStagedOwner(
    runId: string,
    ticket: number,
    stagingDir: string,
    _stagedOwnerPath: string
  ): PublishResult {
    const ticketDirectory = path.join(claimsDir(runId), ticketDirName(ticket));
    try {
      fs.renameSync(stagingDir, ticketDirectory);
      applyMode(ticketDirectory, DIR_MODE);
      return { ok: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        // A competing claimant won this ticket; retry with a higher ticket.
        return { ok: false, retry: true };
      }
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `failed to publish owner: ${messageOf(err)}`,
        },
      };
    }
  }

  function writeOwnerForTicket(
    runId: string,
    ticket: number,
    claimId: string
  ): { stagingDir: string; stagedOwnerPath: string; owner: ClaimOwner } {
    const owner: ClaimOwner = {
      runId,
      claimId,
      instanceId,
      pid,
      acquiredAt: now(),
    };
    const { stagingDir, stagedOwnerPath } = stageOwner(runId, ticket, owner);
    return { stagingDir, stagedOwnerPath, owner };
  }

  function lowestEligibleTicket(
    runId: string
  ): { ok: true; ticket: number; owner?: ClaimOwner } | { ok: false; error: RunStoreError } {
    const tickets = listPublishedTickets(runId);
    for (const ticket of tickets) {
      const ownerResult = readOwner(ticket, runId);
      if (!ownerResult.ok) {
        return { ok: false, error: ownerResult.error };
      }
      const terminal = readTerminal(ticket, runId);
      if (!terminal.ok && !('missing' in terminal)) {
        return { ok: false, error: terminal.error };
      }
      if (terminal.ok) {
        // This ticket has terminated; skip it regardless of state.
        continue;
      }
      // Live or abandoned-without-terminal: candidate. Check PID liveness below.
      const owner = ownerResult.owner;
      if (owner.pid === pid && owner.instanceId === instanceId) {
        return { ok: true, ticket, owner };
      }
      if (isPidAlive(owner.pid)) {
        // Another live process owns this lower ticket; we must withdraw.
        return { ok: true, ticket, owner };
      }
      // Dead owner — abandon it so the high-water mark advances.
      try {
        publishClaimTerminalSync(runId, ticket, owner.claimId, 'abandoned');
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'claim_corrupt',
            runId,
            message: `failed to abandon dead claim: ${messageOf(err)}`,
          },
        };
      }
      continue;
    }
    return { ok: true, ticket: -1 };
  }

  function publishClaimTerminalSync(
    runId: string,
    ticket: number,
    claimId: string,
    state: 'released' | 'abandoned'
  ): void {
    const ticketDirectory = path.join(claimsDir(runId), ticketDirName(ticket));
    const terminalPath = path.join(ticketDirectory, 'terminal.json');
    const stagedPath = path.join(ticketDirectory, `.terminal.${instanceId}.${randomUUID()}.tmp`);
    const payload = JSON.stringify({ claimId, state, timestamp: now() }) + '\n';
    let fd: number | undefined;
    try {
      fd = fs.openSync(stagedPath, 'w', FILE_MODE);
      fs.writeFileSync(fd, payload);
      fsyncFd(fd);
      fs.closeSync(fd);
      fd = undefined;
      try {
        fs.linkSync(stagedPath, terminalPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw err;
      }
      fsyncDir(ticketDirectory);
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      try {
        if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
      } catch {
        /* ignore */
      }
    }
  }

  function isPidAlive(pid: number): boolean {
    if (pid <= 0) return false;
    if (pid === (options.pid ?? process.pid)) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH' || code === 'ENOSYS' || code === 'EPERM') {
        // EPERM means the process exists but we lack permission — treat as alive.
        return code === 'EPERM';
      }
      return false;
    }
  }

  async function createRun(
    input: CreateRunInput
  ): Promise<{ runId: string; record: AgentRunRecordV1 }> {
    const runId = `run-${randomUUID()}`;
    if (!isRunIdValid(runId)) {
      throw new Error(`Invalid generated run id: ${runId}`);
    }
    const dir = runDirOf(runId);
    mkdirPrivate(dir);
    mkdirPrivate(claimsDir(runId));
    mkdirPrivate(path.join(dir, 'sessions'));
    const ts = now();
    const record: AgentRunRecordV1 = {
      version: RUN_RECORD_VERSION,
      runId,
      mode: input.mode,
      status: 'queued',
      request: input.request,
      background: input.background,
      agentScope: input.agentScope,
      createdAt: ts,
      updatedAt: ts,
      details: input.details,
      units: input.units,
      eventsFile: 'events.jsonl',
    };
    await writeRunJsonAtomic(runId, record);
    await appendEventLine(runId, { version: 1, event: 'run_created', runId, timestamp: ts });
    return { runId, record };
  }

  function getRun(runId: string): ReturnType<RunStore['getRun']> {
    if (!isRunIdValid(runId)) {
      return { ok: false, error: { code: 'run_not_found', runId, message: 'invalid run id' } };
    }
    return loadRunJson(runId);
  }

  async function updateRun(
    runId: string,
    mutate: (record: AgentRunRecordV1) => void
  ): Promise<AgentRunRecordV1> {
    return runSerial(runId, async () => {
      const loaded = loadRunJson(runId);
      if (!loaded.ok) throw loaded.error;
      const record = loaded.loaded.record;
      mutate(record);
      record.updatedAt = now();
      writeRunContents(runId, record);
      return record;
    });
  }

  async function appendEvent(runId: string, event: RunLifecycleEvent): Promise<void> {
    await appendEventLine(runId, event);
  }

  async function listRuns(): Promise<ListRunsResult> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const results: ListRunsResult = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      if (!isRunIdValid(runId)) continue;
      const loaded = loadRunJson(runId);
      if (loaded.ok) {
        results.push(loaded.loaded);
      } else {
        const corrupt: CorruptRunEntry = {
          runId,
          runDir: runDirOf(runId),
          code: 'corrupt_run',
          message: loaded.error.message,
        };
        results.push(corrupt);
      }
    }
    results.sort((a, b) => {
      const at = 'record' in a ? a.record.updatedAt : 0;
      const bt = 'record' in b ? b.record.updatedAt : 0;
      return bt - at;
    });
    return results;
  }

  async function claimRun(runId: string): Promise<ClaimResult> {
    if (!isRunIdValid(runId)) {
      return { ok: false, error: { code: 'run_not_found', runId, message: 'invalid run id' } };
    }
    const loaded = loadRunJson(runId);
    if (!loaded.ok) return { ok: false, error: loaded.error };

    const claimId = randomUUID();
    let ticket = 1;
    let attempt = 0;
    // Publish our ticket directory, retrying with higher tickets until we win or withdraw.
    for (;;) {
      attempt++;
      const tickets = listPublishedTickets(runId);
      if (tickets.length > 0) {
        ticket = tickets[tickets.length - 1] + 1;
      } else {
        ticket = 1;
      }
      const { stagingDir, stagedOwnerPath, owner } = writeOwnerForTicket(runId, ticket, claimId);
      const publish = publishStagedOwner(runId, ticket, stagingDir, stagedOwnerPath);
      if ('ok' in publish && publish.ok) {
        fsyncDir(path.join(claimsDir(runId), ticketDirName(ticket)));
        // We published a ticket. Determine if it is the lowest eligible.
        const lowest = lowestEligibleTicket(runId);
        cleanupStaging(stagingDir);
        if (!lowest.ok) {
          // Withdraw our published claim.
          await publishClaimTerminal(runId, ticket, claimId, 'released');
          return { ok: false, error: lowest.error };
        }
        if (lowest.ticket === ticket) {
          // We are the lowest eligible.
          try {
            await updateRun(runId, (record) => {
              record.owner = {
                claimId,
                ticket,
                instanceId,
                pid,
                acquiredAt: owner.acquiredAt,
              };
            });
          } catch (err) {
            await publishClaimTerminal(runId, ticket, claimId, 'released');
            return {
              ok: false,
              error: { code: 'run_store_error', runId, message: messageOf(err) },
            };
          }
          return { ok: true, claimId, ticket };
        }
        // A lower eligible ticket exists. Withdraw and report run_active.
        await publishClaimTerminal(runId, ticket, claimId, 'released');
        return {
          ok: false,
          error: { code: 'run_active', runId, message: 'another live claim holds this run' },
        };
      }
      if (!publish.ok && 'error' in publish) {
        cleanupStaging(stagingDir);
        return { ok: false, error: publish.error };
      }
      // Retry with a higher ticket.
      cleanupStaging(stagingDir);
      if (attempt > 10_000) {
        return {
          ok: false,
          error: { code: 'run_store_error', runId, message: 'claim loop overflow' },
        };
      }
    }
  }

  async function releaseRun(runId: string, claimId: string): Promise<void> {
    await releaseClaim(runId, claimId, 'released');
  }

  async function abandonRun(runId: string, claimId: string): Promise<void> {
    await releaseClaim(runId, claimId, 'abandoned');
  }

  async function releaseClaim(
    runId: string,
    claimId: string,
    state: 'released' | 'abandoned'
  ): Promise<void> {
    // Resolve the ticket directory whose owner matches this claimId, and verify
    // the immutable owner payload belongs to *this* store instance. A foreign
    // caller must never terminate another owner's claim.
    const tickets = listPublishedTickets(runId);
    let resolvedTicket: number | undefined;
    for (const ticket of tickets) {
      const ownerResult = readOwner(ticket, runId);
      if (
        ownerResult.ok &&
        ownerResult.owner.claimId === claimId &&
        ownerResult.owner.instanceId === instanceId &&
        ownerResult.owner.pid === pid
      ) {
        resolvedTicket = ticket;
        break;
      }
    }
    if (resolvedTicket === undefined) {
      // No published claim owned by this instance+p+c with the given claimId.
      // A release for a foreign or nonexistent claim is a no-op; treat the
      // claim directory as durable precedent and do not modify it.
      return;
    }
    await publishClaimTerminal(runId, resolvedTicket, claimId, state);
  }

  function inspectClaims(runId: string):
    | {
        ok: true;
        claims: Array<{
          ticket: number;
          owner?: ClaimOwner;
          terminal?: ClaimTerminal;
          ownerError?: string;
          terminalError?: string;
        }>;
      }
    | { ok: false; error: RunStoreError } {
    if (!isRunIdValid(runId)) {
      return { ok: false, error: { code: 'run_not_found', runId, message: 'invalid run id' } };
    }
    const tickets = listPublishedTickets(runId);
    const claims: Array<{
      ticket: number;
      owner?: ClaimOwner;
      terminal?: ClaimTerminal;
      ownerError?: string;
      terminalError?: string;
    }> = [];
    for (const ticket of tickets) {
      const owner = readOwner(ticket, runId);
      const terminal = readTerminal(ticket, runId);
      claims.push({
        ticket,
        owner: owner.ok ? owner.owner : undefined,
        terminal: 'ok' in terminal && terminal.ok ? terminal.terminal : undefined,
        ...(!owner.ok ? { ownerError: owner.error.message } : {}),
        ...(!('ok' in terminal) || !terminal.ok
          ? !('missing' in terminal)
            ? { terminalError: (terminal as { error: RunStoreError }).error.message }
            : {}
          : {}),
      });
    }
    return { ok: true, claims };
  }

  return {
    rootDir,
    getRunDir,
    createRun,
    getRun,
    updateRun,
    appendEvent,
    listRuns,
    claimRun,
    releaseRun,
    abandonRun,
    inspectClaims,
    isPidAlive,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
