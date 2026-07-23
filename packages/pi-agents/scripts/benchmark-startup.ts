// ABOUTME: Orchestrate fresh-process warm Jiti import samples of dist/index.js.
// ABOUTME: Host-peer setup and worker process startup stay outside the measured import interval.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_WARMUP_RUNS = 1;
const DEFAULT_SAMPLE_RUNS = 5;
const DEFAULT_MAX_MEDIAN_MS = 250;
const DEFAULT_WORKER_TIMEOUT_MS = 30_000;

type ParsedArgs = {
  warmups: number;
  samples: number;
  maxMedianMs: number;
  workerTimeoutMs: number;
};

type WorkerSample = {
  elapsedMs: number;
  entry: string;
};

function printUsageAndExit(message: string, exitCode: number): never {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    'Usage: bun run scripts/benchmark-startup.ts [--warmups <n>] [--samples <n>] [--max-median-ms <n>] [--worker-timeout-ms <n>]\n'
  );
  process.exit(exitCode);
}

function parsePositiveNumber(flag: string, raw: string | undefined): number {
  if (raw === undefined) {
    printUsageAndExit(`Missing value for ${flag}`, 1);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    printUsageAndExit(`Invalid value for ${flag}: ${raw}. Expected a positive finite number.`, 1);
  }
  return value;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let warmups = DEFAULT_WARMUP_RUNS;
  let samples = DEFAULT_SAMPLE_RUNS;
  let maxMedianMs = DEFAULT_MAX_MEDIAN_MS;
  let workerTimeoutMs = DEFAULT_WORKER_TIMEOUT_MS;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--warmups':
        warmups = parsePositiveNumber(arg, argv[++i]);
        break;
      case '--samples':
        samples = parsePositiveNumber(arg, argv[++i]);
        break;
      case '--max-median-ms':
        maxMedianMs = parsePositiveNumber(arg, argv[++i]);
        break;
      case '--worker-timeout-ms':
        workerTimeoutMs = parsePositiveNumber(arg, argv[++i]);
        break;
      case '--help':
      case '-h':
        printUsageAndExit(
          'Fresh-process warm Jiti startup benchmark (disk cache warm; not filesystem/antivirus cold).',
          0
        );
        break;
      default:
        printUsageAndExit(`Unknown argument: ${arg}`, 1);
    }
  }

  return { warmups, samples, maxMedianMs, workerTimeoutMs };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function runWorkerSample(
  workerPath: string,
  entryPath: string,
  workerTimeoutMs: number
): Promise<WorkerSample> {
  return new Promise((resolveSample, reject) => {
    const child = spawn(process.execPath, [workerPath, '--entry', entryPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `Worker exceeded timeout of ${workerTimeoutMs}ms\nstderr:\n${stderr || '(empty)'}`
        )
      );
    }, workerTimeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(
          new Error(
            `Worker exited with code ${code ?? 'null'}\nstderr:\n${stderr || '(empty)'}\nstdout:\n${stdout || '(empty)'}`
          )
        );
        return;
      }

      const line = stdout
        .split('\n')
        .map((part) => part.trim())
        .find((part) => part.length > 0);
      if (!line) {
        reject(new Error(`Worker produced no JSON output\nstderr:\n${stderr || '(empty)'}`));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        reject(
          new Error(
            `Worker emitted invalid JSON: ${line}\nparse error: ${err instanceof Error ? err.message : String(err)}\nstderr:\n${stderr || '(empty)'}`
          )
        );
        return;
      }

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof (parsed as WorkerSample).elapsedMs !== 'number' ||
        !Number.isFinite((parsed as WorkerSample).elapsedMs) ||
        typeof (parsed as WorkerSample).entry !== 'string'
      ) {
        reject(
          new Error(
            `Worker emitted unexpected sample shape: ${line}\nstderr:\n${stderr || '(empty)'}`
          )
        );
        return;
      }

      resolveSample(parsed as WorkerSample);
    });
  });
}

async function main(): Promise<void> {
  const { warmups, samples, maxMedianMs, workerTimeoutMs } = parseArgs(process.argv.slice(2));
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const entryPath = resolve(packageRoot, 'dist', 'index.js');
  const workerPath = resolve(packageRoot, 'scripts', 'benchmark-startup-worker.ts');

  for (let i = 0; i < warmups; i += 1) {
    await runWorkerSample(workerPath, entryPath, workerTimeoutMs);
  }

  const sampleMs: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const sample = await runWorkerSample(workerPath, entryPath, workerTimeoutMs);
    sampleMs.push(sample.elapsedMs);
  }

  const minMs = Math.min(...sampleMs);
  const maxMs = Math.max(...sampleMs);
  const medianMs = median(sampleMs);

  const report = {
    kind: 'fresh-process-warm-jiti-benchmark',
    note: 'Fresh-process warm Jiti import with host peers virtualized outside the timer; disk cache is warm. Filesystem/antivirus cold-cache effects are not represented.',
    entry: entryPath,
    warmups,
    samples,
    maxMedianMs,
    workerTimeoutMs,
    minMs,
    medianMs,
    maxMs,
    sampleMs,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (medianMs > maxMedianMs) {
    process.stderr.write(
      `FAIL: fresh-process warm Jiti median ${medianMs.toFixed(2)}ms exceeds --max-median-ms ${maxMedianMs}\n`
    );
    process.exit(1);
  }
}

await main();
