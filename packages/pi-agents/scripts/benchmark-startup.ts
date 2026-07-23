// ABOUTME: Measure warm Jiti import of dist/index.js with Pi host peers virtualized.
// ABOUTME: Approximates Pi binary extension loading without launching a model.

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as piAgentCore from '@earendil-works/pi-agent-core';
import * as piAiCompat from '@earendil-works/pi-ai/compat';
import * as piCodingAgent from '@earendil-works/pi-coding-agent';
import * as piTui from '@earendil-works/pi-tui';
import { createJiti } from 'jiti';
import * as typebox from 'typebox';

const DEFAULT_WARMUP_RUNS = 1;
const DEFAULT_SAMPLE_RUNS = 5;
const DEFAULT_MAX_MEDIAN_MS = 250;

const HOST_VIRTUAL_MODULES = {
  '@earendil-works/pi-coding-agent': piCodingAgent,
  '@earendil-works/pi-agent-core': piAgentCore,
  '@earendil-works/pi-tui': piTui,
  '@earendil-works/pi-ai': piAiCompat,
  typebox,
} as const;

type ParsedArgs = {
  warmups: number;
  samples: number;
  maxMedianMs: number;
};

function printUsageAndExit(message: string, exitCode: number): never {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    'Usage: bun run scripts/benchmark-startup.ts [--warmups <n>] [--samples <n>] [--max-median-ms <n>]\n'
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
      case '--help':
      case '-h':
        printUsageAndExit('Warm Jiti startup benchmark (not disk-cold).', 0);
        break;
      default:
        printUsageAndExit(`Unknown argument: ${arg}`, 1);
    }
  }

  return { warmups, samples, maxMedianMs };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

async function importExtensionOnce(entryPath: string): Promise<void> {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
    virtualModules: { ...HOST_VIRTUAL_MODULES },
  });
  const loaded = await jiti.import(pathToFileURL(entryPath).href, {
    default: true,
  });
  if (typeof loaded !== 'function') {
    throw new Error(`Expected default export function from ${entryPath}, got ${typeof loaded}`);
  }
}

async function main(): Promise<void> {
  const { warmups, samples, maxMedianMs } = parseArgs(process.argv.slice(2));
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const entryPath = resolve(packageRoot, 'dist', 'index.js');

  for (let i = 0; i < warmups; i += 1) {
    await importExtensionOnce(entryPath);
  }

  const sampleMs: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    await importExtensionOnce(entryPath);
    sampleMs.push(performance.now() - started);
  }

  const minMs = Math.min(...sampleMs);
  const maxMs = Math.max(...sampleMs);
  const medianMs = median(sampleMs);

  const report = {
    kind: 'warm-jiti-benchmark',
    note: 'Warm Jiti import with host peers virtualized; not a disk-cold measurement.',
    entry: entryPath,
    warmups,
    samples,
    maxMedianMs,
    minMs,
    medianMs,
    maxMs,
    sampleMs,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (medianMs > maxMedianMs) {
    process.stderr.write(
      `FAIL: warm Jiti median ${medianMs.toFixed(2)}ms exceeds --max-median-ms ${maxMedianMs}\n`
    );
    process.exit(1);
  }
}

await main();
