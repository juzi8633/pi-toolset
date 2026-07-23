// ABOUTME: Fresh-process Jiti smoke for emitted dist/index.js and the Grok ACP runtime chunk.
// ABOUTME: Asserts the main default export and lazy façade exports without invoking the factory.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createJiti } from 'jiti';

import { analyzeBundleGraph, type Metafile } from './bundle-graph.ts';
import { createHostVirtualModules } from './jiti-host-modules.ts';

function fail(message: string): never {
  process.stderr.write(`smoke-built-lazy-runtime: ${message}\n`);
  process.exit(1);
}

function packageRootFromScript(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function findGrokRuntimeOutput(metafile: Metafile): string {
  for (const [outputPath, output] of Object.entries(metafile.outputs)) {
    const entry = output.entryPoint ? output.entryPoint.replaceAll('\\', '/') : '';
    if (
      entry.endsWith('src/runtime/grok-acp/grok-acp-runtime.ts') ||
      entry.endsWith('/runtime/grok-acp/grok-acp-runtime.ts') ||
      entry === 'src/runtime/grok-acp/grok-acp-runtime.ts'
    ) {
      return outputPath.replaceAll('\\', '/').replace(/^\.\//, '');
    }
  }
  // Fallback: locate by inputs when entryPoint is not set on a dynamic chunk.
  for (const [outputPath, output] of Object.entries(metafile.outputs)) {
    for (const inputPath of Object.keys(output.inputs ?? {})) {
      const normalized = inputPath.replaceAll('\\', '/');
      if (normalized.endsWith('src/runtime/grok-acp/grok-acp-runtime.ts')) {
        return outputPath.replaceAll('\\', '/').replace(/^\.\//, '');
      }
    }
  }
  // Filename fallback for hashed dynamic façades.
  for (const outputPath of Object.keys(metafile.outputs)) {
    const normalized = outputPath.replaceAll('\\', '/').replace(/^\.\//, '');
    if (normalized.includes('grok-acp-runtime-') && normalized.endsWith('.js')) {
      return normalized;
    }
  }
  fail('could not identify grok-acp-runtime output in metafile');
}

async function main(): Promise<void> {
  const packageRoot = packageRootFromScript();
  const metafilePath = process.env.PI_BUILD_METAFILE;
  if (!metafilePath) {
    fail('PI_BUILD_METAFILE is required');
  }

  let metafile: Metafile;
  try {
    metafile = JSON.parse(readFileSync(metafilePath, 'utf8')) as Metafile;
  } catch (err) {
    fail(
      `failed to read metafile at ${metafilePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Ensure the metafile is for the main entry before importing chunks.
  analyzeBundleGraph(metafile);

  const mainPath = resolve(packageRoot, 'dist', 'index.js');
  // Metafile output paths are relative to --outdir (dist/).
  const runtimeRel = findGrokRuntimeOutput(metafile);
  const runtimeAbs = resolve(packageRoot, 'dist', runtimeRel);

  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
    virtualModules: createHostVirtualModules(),
  });

  const mainLoaded = await jiti.import(pathToFileURL(mainPath).href, { default: true });
  if (typeof mainLoaded !== 'function') {
    fail(`dist/index.js default export must be a function; got ${typeof mainLoaded}`);
  }

  const runtimeLoaded = (await jiti.import(pathToFileURL(runtimeAbs).href)) as {
    runSingleAgentGrokAcp?: unknown;
    createGrokAcpInteractiveTransport?: unknown;
  };
  if (typeof runtimeLoaded.runSingleAgentGrokAcp !== 'function') {
    fail('Grok ACP runtime chunk is missing runSingleAgentGrokAcp');
  }
  if (typeof runtimeLoaded.createGrokAcpInteractiveTransport !== 'function') {
    fail('Grok ACP runtime chunk is missing createGrokAcpInteractiveTransport');
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        mainPath,
        runtimePath: runtimeAbs,
      },
      null,
      2
    ) + '\n'
  );
}

await main();
