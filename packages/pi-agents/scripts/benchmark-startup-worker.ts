// ABOUTME: One fresh-process Jiti import sample with host peers loaded outside the timer.
// ABOUTME: Prints a single JSON object with elapsedMs and the resolved entry path.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createJiti } from 'jiti';

import { createHostVirtualModules } from './jiti-host-modules.ts';

function printUsageAndExit(message: string, exitCode: number): never {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    'Usage: bun run scripts/benchmark-startup-worker.ts --entry <absolute-or-relative-path>\n'
  );
  process.exit(exitCode);
}

function parseEntry(argv: readonly string[]): string {
  let entry: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--entry') {
      entry = argv[++i];
      if (!entry) {
        printUsageAndExit('Missing value for --entry', 1);
      }
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsageAndExit('Fresh-process Jiti import sample worker.', 0);
    }
    printUsageAndExit(`Unknown argument: ${arg}`, 1);
  }
  if (!entry) {
    printUsageAndExit('Missing required --entry <path>', 1);
  }
  return entry;
}

async function main(): Promise<void> {
  const entryArg = parseEntry(process.argv.slice(2));
  const entryPath = resolve(entryArg);
  const entryUrl = pathToFileURL(entryPath).href;

  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
    virtualModules: createHostVirtualModules(),
  });

  const started = performance.now();
  const loaded = await jiti.import(entryUrl, { default: true });
  const elapsedMs = performance.now() - started;

  if (typeof loaded !== 'function') {
    throw new Error(`Expected default export function from ${entryPath}, got ${typeof loaded}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      elapsedMs,
      entry: entryPath,
    })}\n`
  );
}

await main();
