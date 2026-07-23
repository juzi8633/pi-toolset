// ABOUTME: Postbuild structural gate for the pi-agents main bundle artifact.
// ABOUTME: Enforces runtime bundling, host-peer externalization, size, and factory shape.

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_MAIN_BUNDLE_BYTES = 2_621_440;

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

async function main(): Promise<void> {
  const packageRoot = packageRootFromScript();
  const mainBundlePath = resolve(packageRoot, 'dist', 'index.js');

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(mainBundlePath);
  } catch {
    fail(`missing main bundle at ${mainBundlePath}`);
  }

  if (!stats.isFile()) {
    fail(`main bundle is not a file: ${mainBundlePath}`);
  }

  const byteSize = stats.size;
  if (byteSize > MAX_MAIN_BUNDLE_BYTES) {
    fail(
      `main bundle is ${byteSize} bytes; exceeds MAX_MAIN_BUNDLE_BYTES=${MAX_MAIN_BUNDLE_BYTES}`
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

  const externalPackages = [...new Set(importSpecifiers.map(packageNameOfSpecifier))].sort();

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        mainBundlePath,
        byteSize,
        maxMainBundleBytes: MAX_MAIN_BUNDLE_BYTES,
        externalPackages,
        requiredHostImports: REQUIRED_HOST_IMPORTS,
        forbiddenExternalPackages: FORBIDDEN_EXTERNAL_PACKAGES,
      },
      null,
      2
    ) + '\n'
  );
}

await main();
