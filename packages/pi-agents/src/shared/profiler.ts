// ABOUTME: CPU profiling helper controlled via PI_AGENTS_CPU_PROFILE env var.
// ABOUTME: Wraps node:inspector to start/stop V8 CPU profiling on demand during agent execution.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as inspector from 'node:inspector';

/** Root dir for .cpuprofile output; defaults to /tmp/pi-agents-profiles. */
const PROFILE_DIR =
  process.env.PI_AGENTS_CPU_PROFILE_DIR || path.join('/tmp', 'pi-agents-profiles');

/** How long the CPU profiler should sample (ms). Default 0 = manual stop only. */
const SAMPLING_DURATION_MS = Number(process.env.PI_AGENTS_CPU_PROFILE_DURATION_MS || 0) || 0;

/** Sampling interval in microseconds. Default 1000µs = 1ms. */
const SAMPLING_INTERVAL_US = Number(process.env.PI_AGENTS_CPU_PROFILE_INTERVAL_US || 1000) || 1000;

interface ActiveProfile {
  session: inspector.Session;
  label: string;
  startedAt: number;
}

let active: ActiveProfile | null = null;
let autoStopTimer: ReturnType<typeof setTimeout> | undefined;
let signalHandlersInstalled = false;

function ensureDir(): void {
  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
  }
}

function profilePath(label: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  return path.join(PROFILE_DIR, `cpu-${safe}-${ts}.cpuprofile`);
}

function postPromise(
  session: inspector.Session,
  method: string,
  params?: object
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    session.post(method, params ?? {}, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function signalExitCode(signal: string): number {
  return 128 + (signal === 'SIGINT' ? 2 : 15);
}

/**
 * Dump the active profile to disk synchronously, then exit.
 * Called from SIGINT/SIGTERM handlers. V8 Profiler.stop is async via callback,
 * but the inspector runs in-process so the callback fires before the event loop
 * tears down. A 2s safety net ensures we don't hang forever.
 */
function dumpAndExit(signal: string): void {
  if (!active) {
    process.exit(signalExitCode(signal));
  }

  const { session, label } = active;
  active = null;
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = undefined;
  }

  let settled = false;
  const done = (): void => {
    if (settled) return;
    settled = true;
    process.exit(signalExitCode(signal));
  };

  try {
    session.post('Profiler.stop' as never, (err, result) => {
      if (!err && result) {
        try {
          const outPath = profilePath(label);
          const profile = (result as { profile?: object }).profile ?? result;
          fs.writeFileSync(outPath, JSON.stringify(profile, null, 2));
          // eslint-disable-next-line no-console
          console.error(`[pi-agents] CPU profile written to ${outPath}`);
        } catch {
          /* ignore write errors */
        }
      }
      done();
    });

    // Safety net: if the callback never fires, exit anyway.
    setTimeout(done, 2000).unref();
  } catch {
    done();
  }
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  process.once('SIGINT', () => {
    dumpAndExit('SIGINT');
  });
  process.once('SIGTERM', () => {
    dumpAndExit('SIGTERM');
  });
}

/**
 * Start CPU profiling. No-op unless PI_AGENTS_CPU_PROFILE=1 or PI_AGENTS_CPU_PROFILE=true.
 * Safe to call when already profiling (ignored).
 * Installs SIGINT/SIGTERM handlers so interrupted runs still get a flamegraph.
 */
export function startProfile(label = 'agent-run'): void {
  if (process.env.PI_AGENTS_CPU_PROFILE !== '1' && process.env.PI_AGENTS_CPU_PROFILE !== 'true') {
    return;
  }
  if (active) return;

  ensureDir();
  installSignalHandlers();

  const session = new inspector.Session();
  session.connect();
  postPromise(session, 'Profiler.enable');
  postPromise(session, 'Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
  postPromise(session, 'Profiler.start');

  active = { session, label, startedAt: Date.now() };

  if (SAMPLING_DURATION_MS > 0) {
    autoStopTimer = setTimeout(() => {
      void stopProfile();
    }, SAMPLING_DURATION_MS);
  }
}

/**
 * Stop CPU profiling and write the .cpuprofile file to disk.
 * No-op when not profiling. Safe to call multiple times.
 * Returns the output path, or null if profiling was not active.
 */
export async function stopProfile(): Promise<string | null> {
  if (!active) return null;
  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = undefined;
  }

  const { session, label } = active;
  active = null;

  try {
    const raw = await postPromise(session, 'Profiler.stop' as never);
    const profile = (raw as { profile?: object }).profile ?? raw;
    const outPath = profilePath(label);
    fs.writeFileSync(outPath, JSON.stringify(profile, null, 2));
    postPromise(session, 'Profiler.disable');
    session.disconnect();
    return outPath;
  } catch {
    try {
      postPromise(session, 'Profiler.disable');
      session.disconnect();
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * Number of milliseconds since profiling started, or 0 when idle.
 */
export function profileElapsedMs(): number {
  if (!active) return 0;
  return Date.now() - active.startedAt;
}
