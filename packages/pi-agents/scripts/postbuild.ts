// ABOUTME: Postbuild structural gate for the pi-agents main extension graph.
// ABOUTME: Enforces metafile closures, ACP placement, host peers, size, and Jiti smoke.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

import {
  analyzeBundleGraph,
  collectInputPathsContributing,
  inputPathLooksLikeAcpSdk,
  inputPathLooksLikeZod,
  normalizePath,
  outputContainsAcpSdk,
  type Metafile,
  type MetafileOutput,
} from './bundle-graph.ts';

const MAX_STARTUP_STATIC_GRAPH_BYTES = 1_325_000;
const MAX_TOTAL_MAIN_GRAPH_BYTES = 2_621_440;

const FORBIDDEN_EXTERNAL_PACKAGES = ['effect', '@agentclientprotocol/sdk'] as const;

const REQUIRED_HOST_IMPORTS = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui',
] as const;

const IMPORT_SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(|\bexport\s*\*?\s*from\s*)['"]([^'"]+)['"]/g;

function packageRootFromScript(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function fail(message: string): never {
  process.stderr.write(`postbuild: ${message}\n`);
  process.exit(1);
}

function packageNameOfSpecifier(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0] ?? specifier;
}

function isForbiddenExternal(specifier: string): boolean {
  if (specifier === 'effect' || specifier.startsWith('effect/')) {
    return true;
  }
  return packageNameOfSpecifier(specifier) === '@agentclientprotocol/sdk';
}

function collectImportSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (specifier) {
      found.add(specifier);
    }
  }
  return [...found].sort();
}

function readPackageJson(packageRoot: string): {
  pi?: { build?: { splitting?: boolean }; extensions?: string[] };
} {
  return JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
    pi?: { build?: { splitting?: boolean }; extensions?: string[] };
  };
}

function loadMetafile(path: string): Metafile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    fail(`missing or unreadable PI_BUILD_METAFILE at ${path}`);
  }
  try {
    return JSON.parse(raw) as Metafile;
  } catch (err) {
    fail(
      `malformed PI_BUILD_METAFILE at ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function listJsFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function outputMap(metafile: Metafile): Map<string, MetafileOutput> {
  const map = new Map<string, MetafileOutput>();
  for (const [raw, output] of Object.entries(metafile.outputs)) {
    map.set(normalizePath(raw).replace(/^\.\//, ''), output);
  }
  return map;
}

function runSmoke(packageRoot: string, metafilePath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const smokePath = resolve(packageRoot, 'scripts', 'smoke-built-lazy-runtime.ts');
    const child = spawn(process.execPath, [smokePath], {
      cwd: packageRoot,
      env: { ...process.env, PI_BUILD_METAFILE: metafilePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        if (stdout.trim()) process.stdout.write(stdout);
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `lazy-runtime smoke failed (exit ${code ?? 'null'})\nstderr:\n${stderr || '(empty)'}\nstdout:\n${stdout || '(empty)'}`
        )
      );
    });
  });
}

async function main(): Promise<void> {
  const packageRoot = packageRootFromScript();
  const pkg = readPackageJson(packageRoot);
  const splitting = pkg.pi?.build?.splitting === true;
  const mainBundlePath = resolve(packageRoot, 'dist', 'index.js');
  const extensions = pkg.pi?.extensions ?? [];
  if (!extensions.includes('./dist/index.js')) {
    fail('package.json pi.extensions must include ./dist/index.js as the extension entry');
  }

  if (!existsSync(mainBundlePath) || !statSync(mainBundlePath).isFile()) {
    fail(`missing main bundle at ${mainBundlePath}`);
  }

  if (!splitting) {
    // Legacy single-bundle gate retained for rollback without pi.build.splitting.
    const byteSize = statSync(mainBundlePath).size;
    if (byteSize > MAX_TOTAL_MAIN_GRAPH_BYTES) {
      fail(
        `main bundle is ${byteSize} bytes; exceeds MAX_TOTAL_MAIN_GRAPH_BYTES=${MAX_TOTAL_MAIN_GRAPH_BYTES}`
      );
    }
    const source = readFileSync(mainBundlePath, 'utf8');
    const importSpecifiers = collectImportSpecifiers(source);
    const forbidden = importSpecifiers.filter(isForbiddenExternal);
    if (forbidden.length > 0) {
      fail(`main bundle still externalizes forbidden runtime packages: ${forbidden.join(', ')}`);
    }
    const missingHosts = REQUIRED_HOST_IMPORTS.filter(
      (host) =>
        !importSpecifiers.some(
          (specifier) =>
            specifier === host ||
            specifier.startsWith(`${host}/`) ||
            packageNameOfSpecifier(specifier) === host
        )
    );
    if (missingHosts.length > 0) {
      fail(`main bundle is missing required host-peer imports: ${missingHosts.join(', ')}`);
    }
    const loaded = await import(pathToFileURL(mainBundlePath).href);
    if (typeof loaded.default !== 'function') {
      fail(`main bundle default export must be a function; got ${typeof loaded.default}`);
    }
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          mode: 'single-bundle',
          mainBundlePath,
          byteSize,
          maxTotalMainGraphBytes: MAX_TOTAL_MAIN_GRAPH_BYTES,
          externalPackages: [...new Set(importSpecifiers.map(packageNameOfSpecifier))].sort(),
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  const metafilePath = process.env.PI_BUILD_METAFILE;
  if (!metafilePath) {
    fail(
      'pi.build.splitting is true but PI_BUILD_METAFILE is unset. Run via `mise run build --package packages/pi-agents` so the build task supplies a transient metafile.'
    );
  }

  const metafile = loadMetafile(metafilePath);
  let graph;
  try {
    graph = analyzeBundleGraph(metafile);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  if (graph.missingLocalImports.length > 0) {
    const details = graph.missingLocalImports.map((m) => `${m.from} -> ${m.path}`).join('; ');
    fail(`metafile references missing local outputs: ${details}`);
  }

  const outputs = outputMap(metafile);
  const distRoot = resolve(packageRoot, 'dist');
  const toAbs = (outdirRel: string) => resolve(distRoot, outdirRel);
  const toPackageRel = (outdirRel: string) => normalizePath(join('dist', outdirRel));

  for (const rel of graph.totalMainGraphOutputs) {
    const abs = toAbs(rel);
    if (!existsSync(abs)) {
      fail(`referenced main-graph file is missing on disk: ${toPackageRel(rel)}`);
    }
  }

  if (graph.startupStaticBytes > MAX_STARTUP_STATIC_GRAPH_BYTES) {
    fail(
      `startup static graph is ${graph.startupStaticBytes} bytes; exceeds MAX_STARTUP_STATIC_GRAPH_BYTES=${MAX_STARTUP_STATIC_GRAPH_BYTES}`
    );
  }
  if (graph.totalMainGraphBytes > MAX_TOTAL_MAIN_GRAPH_BYTES) {
    fail(
      `total main graph is ${graph.totalMainGraphBytes} bytes; exceeds MAX_TOTAL_MAIN_GRAPH_BYTES=${MAX_TOTAL_MAIN_GRAPH_BYTES}`
    );
  }

  const startupAcpInputs = collectInputPathsContributing(
    metafile.outputs,
    graph.startupStaticOutputs,
    inputPathLooksLikeAcpSdk
  );
  const startupZodInputs = collectInputPathsContributing(
    metafile.outputs,
    graph.startupStaticOutputs,
    inputPathLooksLikeZod
  );
  if (startupAcpInputs.length > 0) {
    fail(
      `startup static graph still contains @agentclientprotocol/sdk inputs: ${startupAcpInputs.slice(0, 5).join(', ')}`
    );
  }
  if (startupZodInputs.length > 0) {
    fail(
      `startup static graph still contains zod inputs: ${startupZodInputs.slice(0, 5).join(', ')}`
    );
  }

  const acpContainingOutputs = graph.dynamicReachableOutputs.filter((rel) => {
    const output = outputs.get(rel);
    return output ? outputContainsAcpSdk(output) : false;
  });
  if (acpContainingOutputs.length === 0) {
    // Also allow ACP in total graph outputs that are only dynamically reached.
    const anyDynamicAcp = graph.totalMainGraphOutputs.some((rel) => {
      if (graph.startupStaticOutputs.includes(rel)) return false;
      const output = outputs.get(rel);
      return output ? outputContainsAcpSdk(output) : false;
    });
    if (!anyDynamicAcp) {
      fail(
        'no dynamically reachable output contains @agentclientprotocol/sdk input; lazy ACP boundary is missing'
      );
    }
  }

  const externalPackages = new Set<string>();
  for (const rel of graph.totalMainGraphOutputs) {
    const abs = toAbs(rel);
    const source = readFileSync(abs, 'utf8');
    for (const specifier of collectImportSpecifiers(source)) {
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        // Emitted JS uses importer-relative paths; resolve against the file on disk.
        const resolvedAbs = resolve(dirname(abs), specifier);
        if (!existsSync(resolvedAbs) && !existsSync(`${resolvedAbs}.js`)) {
          fail(`local import from ${toPackageRel(rel)} does not resolve on disk: ${specifier}`);
        }
        continue;
      }
      externalPackages.add(packageNameOfSpecifier(specifier));
      if (isForbiddenExternal(specifier)) {
        fail(`${toPackageRel(rel)} externalizes forbidden runtime package: ${specifier}`);
      }
    }
  }

  const startupSource = readFileSync(mainBundlePath, 'utf8');
  const startupSpecifiers = collectImportSpecifiers(startupSource);
  const missingHosts = REQUIRED_HOST_IMPORTS.filter(
    (host) =>
      !startupSpecifiers.some(
        (specifier) =>
          specifier === host ||
          specifier.startsWith(`${host}/`) ||
          packageNameOfSpecifier(specifier) === host
      )
  );
  if (missingHosts.length > 0) {
    fail(`startup graph is missing required host-peer imports: ${missingHosts.join(', ')}`);
  }

  const loaded = await import(pathToFileURL(mainBundlePath).href);
  if (typeof loaded.default !== 'function') {
    fail(`main bundle default export must be a function; got ${typeof loaded.default}`);
  }

  // Stale chunk detection: every file under dist/chunks must be in the main graph.
  const chunksDir = resolve(packageRoot, 'dist', 'chunks');
  const emittedChunkPaths = listJsFilesRecursive(chunksDir).map((abs) =>
    normalizePath(relative(packageRoot, abs))
  );
  const graphSet = new Set(graph.totalMainGraphOutputs.map((p) => toPackageRel(p)));
  const staleChunks = emittedChunkPaths.filter((p) => !graphSet.has(p));
  if (staleChunks.length > 0) {
    fail(`stale unreferenced files under dist/chunks: ${staleChunks.join(', ')}`);
  }

  try {
    await runSmoke(packageRoot, metafilePath);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const mapOutdirPaths = (paths: readonly string[]) => paths.map(toPackageRel);
  const reportAcpOutputs =
    acpContainingOutputs.length > 0
      ? acpContainingOutputs
      : graph.totalMainGraphOutputs.filter((rel) => {
          if (graph.startupStaticOutputs.includes(rel)) return false;
          const output = outputs.get(rel);
          return output ? outputContainsAcpSdk(output) : false;
        });

  const report = {
    ok: true,
    mode: 'splitting',
    entryOutputPath: toPackageRel(graph.entryOutputPath),
    startupStaticFiles: mapOutdirPaths(graph.startupStaticOutputs),
    startupStaticBytes: graph.startupStaticBytes,
    maxStartupStaticGraphBytes: MAX_STARTUP_STATIC_GRAPH_BYTES,
    dynamicReachableFiles: mapOutdirPaths(graph.dynamicReachableOutputs),
    dynamicReachableBytes: graph.dynamicReachableBytes,
    totalMainGraphBytes: graph.totalMainGraphBytes,
    maxTotalMainGraphBytes: MAX_TOTAL_MAIN_GRAPH_BYTES,
    acpContainingOutputs: mapOutdirPaths(reportAcpOutputs),
    externalPackages: [...externalPackages].sort(),
    requiredHostImports: REQUIRED_HOST_IMPORTS,
    forbiddenExternalPackages: FORBIDDEN_EXTERNAL_PACKAGES,
    emittedChunkPaths,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
