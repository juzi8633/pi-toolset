// ABOUTME: Pure Bun metafile helpers for static/dynamic output-closure analysis.
// ABOUTME: Normalizes path separators and classifies ESM startup vs dynamic-import edges.

export type MetafileImportKind =
  | 'import-statement'
  | 'dynamic-import'
  | 'require-call'
  | 'require-resolve'
  | 'import-rule'
  | 'url-token'
  | 'internal'
  | 'entry-point'
  | 'at'
  | string;

export type MetafileImport = {
  path: string;
  kind: MetafileImportKind;
  external?: boolean;
};

export type MetafileOutput = {
  bytes: number;
  imports?: MetafileImport[];
  inputs?: Record<string, { bytesInOutput?: number }>;
  entryPoint?: string;
  exports?: string[];
};

export type Metafile = {
  inputs?: Record<string, unknown>;
  outputs: Record<string, MetafileOutput>;
};

export type GraphAnalysis = {
  entryOutputPath: string;
  startupStaticOutputs: string[];
  startupStaticBytes: number;
  dynamicReachableOutputs: string[];
  dynamicReachableBytes: number;
  totalMainGraphOutputs: string[];
  totalMainGraphBytes: number;
  missingLocalImports: Array<{ from: string; path: string }>;
};

const STARTUP_EDGE_KINDS = new Set(['import-statement']);
const DYNAMIC_EDGE_KINDS = new Set(['dynamic-import']);

/** Normalize metafile / filesystem paths to POSIX separators. */
export function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function stripLeadingDotSlash(path: string): string {
  const normalized = normalizePath(path);
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function dirnamePosix(path: string): string {
  const normalized = stripLeadingDotSlash(path);
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? '' : normalized.slice(0, idx);
}

function joinPosix(baseDir: string, rel: string): string {
  const baseParts = baseDir ? baseDir.split('/').filter(Boolean) : [];
  const relParts = normalizePath(rel).split('/');
  for (const part of relParts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      baseParts.pop();
      continue;
    }
    baseParts.push(part);
  }
  return baseParts.join('/');
}

/**
 * Resolve a metafile import path to an output key.
 *
 * Bun records local output imports as outdir-rooted paths (e.g. `./chunks/a.js`)
 * rather than importer-relative paths. Keep importer-relative resolution as a
 * fallback when the outdir-rooted candidate is absent from `knownOutputs`.
 */
export function resolveOutputImport(
  fromOutput: string,
  importPath: string,
  knownOutputs?: ReadonlySet<string>
): string {
  const from = stripLeadingDotSlash(fromOutput);
  const target = normalizePath(importPath);
  const outdirRooted = stripLeadingDotSlash(target);
  if (!target.startsWith('./') && !target.startsWith('../')) {
    return outdirRooted;
  }
  if (!knownOutputs || knownOutputs.has(outdirRooted)) {
    return outdirRooted;
  }
  return joinPosix(dirnamePosix(from), target);
}

function findEntryOutput(
  outputs: Map<string, MetafileOutput>,
  entryPointSuffix = 'src/index.ts'
): string | undefined {
  const wanted = normalizePath(entryPointSuffix);
  for (const [outputPath, output] of outputs) {
    if (!output.entryPoint) continue;
    const entry = normalizePath(output.entryPoint);
    if (entry === wanted || entry.endsWith(`/${wanted}`) || entry.endsWith(wanted)) {
      return stripLeadingDotSlash(outputPath);
    }
  }
  return undefined;
}

function collectClosure(
  start: string,
  outputs: Map<string, MetafileOutput>,
  edgeKinds: Set<string>
): { files: string[]; missing: Array<{ from: string; path: string }> } {
  const visited = new Set<string>();
  const missing: Array<{ from: string; path: string }> = [];
  const queue: string[] = [start];
  const known = new Set(outputs.keys());

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const output = outputs.get(current);
    if (!output) continue;
    for (const edge of output.imports ?? []) {
      if (edge.external) continue;
      if (!edgeKinds.has(edge.kind)) continue;
      const resolved = resolveOutputImport(current, edge.path, known);
      if (!outputs.has(resolved)) {
        missing.push({ from: current, path: resolved });
        continue;
      }
      if (!visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return { files: [...visited], missing };
}

function collectDynamicReachable(
  startupFiles: readonly string[],
  outputs: Map<string, MetafileOutput>
): { files: string[]; missing: Array<{ from: string; path: string }> } {
  const visited = new Set<string>();
  const missing: Array<{ from: string; path: string }> = [];
  const queue: string[] = [];
  const known = new Set(outputs.keys());
  const startupSet = new Set(startupFiles);

  for (const start of startupFiles) {
    const output = outputs.get(start);
    if (!output) continue;
    for (const edge of output.imports ?? []) {
      if (edge.external) continue;
      if (!DYNAMIC_EDGE_KINDS.has(edge.kind)) continue;
      const resolved = resolveOutputImport(start, edge.path, known);
      if (!outputs.has(resolved)) {
        missing.push({ from: start, path: resolved });
        continue;
      }
      if (!visited.has(resolved) && !startupSet.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const output = outputs.get(current);
    if (!output) continue;
    for (const edge of output.imports ?? []) {
      if (edge.external) continue;
      if (!STARTUP_EDGE_KINDS.has(edge.kind) && !DYNAMIC_EDGE_KINDS.has(edge.kind)) continue;
      const resolved = resolveOutputImport(current, edge.path, known);
      if (!outputs.has(resolved)) {
        missing.push({ from: current, path: resolved });
        continue;
      }
      if (!visited.has(resolved) && !startupSet.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return { files: [...visited], missing };
}

function sumBytes(files: readonly string[], outputs: Map<string, MetafileOutput>): number {
  let total = 0;
  for (const file of files) {
    total += outputs.get(file)?.bytes ?? 0;
  }
  return total;
}

/** Analyze a Bun metafile for the main extension entry static/dynamic closures. */
export function analyzeBundleGraph(
  metafile: Metafile,
  options: { entryPointSuffix?: string } = {}
): GraphAnalysis {
  const outputs = new Map<string, MetafileOutput>();
  for (const [rawPath, output] of Object.entries(metafile.outputs ?? {})) {
    outputs.set(stripLeadingDotSlash(rawPath), output);
  }

  const entryOutputPath = findEntryOutput(outputs, options.entryPointSuffix);
  if (!entryOutputPath) {
    throw new Error(
      `Could not find entry output for ${options.entryPointSuffix ?? 'src/index.ts'} in metafile`
    );
  }
  if (!outputs.has(entryOutputPath)) {
    throw new Error(`Entry output ${entryOutputPath} is missing from metafile outputs`);
  }

  const staticClosure = collectClosure(entryOutputPath, outputs, STARTUP_EDGE_KINDS);
  const dynamic = collectDynamicReachable(staticClosure.files, outputs);
  const totalSet = new Set([...staticClosure.files, ...dynamic.files]);
  const totalMainGraphOutputs = [...totalSet].sort();
  const missingLocalImports = [...staticClosure.missing, ...dynamic.missing];

  return {
    entryOutputPath,
    startupStaticOutputs: [...staticClosure.files].sort(),
    startupStaticBytes: sumBytes(staticClosure.files, outputs),
    dynamicReachableOutputs: [...dynamic.files].sort(),
    dynamicReachableBytes: sumBytes(dynamic.files, outputs),
    totalMainGraphOutputs,
    totalMainGraphBytes: sumBytes(totalMainGraphOutputs, outputs),
    missingLocalImports,
  };
}

const ACP_SDK_MARKERS = [
  'node_modules/@agentclientprotocol/sdk/',
  'node_modules/.bun/@agentclientprotocol+sdk@',
  '/@agentclientprotocol/sdk/',
] as const;

const ZOD_MARKERS = ['node_modules/zod/', 'node_modules/.bun/zod@', '/zod/'] as const;

export function inputPathLooksLikeAcpSdk(inputPath: string): boolean {
  const path = normalizePath(inputPath);
  return ACP_SDK_MARKERS.some((marker) => path.includes(marker));
}

export function inputPathLooksLikeZod(inputPath: string): boolean {
  const path = normalizePath(inputPath);
  if (!ZOD_MARKERS.some((marker) => path.includes(marker))) return false;
  // Avoid matching package names that merely contain "zod" as a substring elsewhere.
  return (
    path.includes('node_modules/zod/') ||
    path.includes('node_modules/.bun/zod@') ||
    /\/zod@[^/]+\/node_modules\/zod\//.test(path)
  );
}

export function outputContainsAcpSdk(output: MetafileOutput): boolean {
  for (const inputPath of Object.keys(output.inputs ?? {})) {
    if (inputPathLooksLikeAcpSdk(inputPath)) return true;
  }
  return false;
}

export function outputContainsZod(output: MetafileOutput): boolean {
  for (const inputPath of Object.keys(output.inputs ?? {})) {
    if (inputPathLooksLikeZod(inputPath)) return true;
  }
  return false;
}

export function collectInputPathsContributing(
  outputs: Record<string, MetafileOutput>,
  outputPaths: readonly string[],
  predicate: (inputPath: string) => boolean
): string[] {
  const found = new Set<string>();
  for (const outputPath of outputPaths) {
    const key = stripLeadingDotSlash(outputPath);
    const output =
      outputs[key] ??
      outputs[`./${key}`] ??
      Object.entries(outputs).find(([p]) => stripLeadingDotSlash(p) === key)?.[1];
    if (!output) continue;
    for (const inputPath of Object.keys(output.inputs ?? {})) {
      if (predicate(inputPath)) found.add(normalizePath(inputPath));
    }
  }
  return [...found].sort();
}
