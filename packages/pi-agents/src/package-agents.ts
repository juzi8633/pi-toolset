// ABOUTME: Discovers agents from packages installed via pi (user and project settings.json `packages[]`).
// ABOUTME: Resolves npm:/git:/local sources to package roots, then reads `pi.agents` from each package.json.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent';

export interface PackageAgentDir {
  packageName: string;
  packageRoot: string;
  agentPath: string;
}

export type PackageDiscoveryScope = 'user' | 'project' | 'both';

interface ParsedSource {
  type: 'npm' | 'git' | 'local';
  identity: string;
  npmName?: string;
  gitSuffix?: string;
  localPath?: string;
}

interface ResolvedPackage {
  identity: string;
  packageRoot: string;
  scope: 'user' | 'project';
}

function safeReadJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

function readSettingsPackages(settingsFile: string): string[] {
  const settings = safeReadJson(settingsFile);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return [];
  const packages = (settings as Record<string, unknown>).packages;
  if (!Array.isArray(packages)) return [];

  const out: string[] = [];
  for (const entry of packages) {
    if (typeof entry === 'string') {
      out.push(entry);
    } else if (entry && typeof entry === 'object') {
      const src = (entry as Record<string, unknown>).source;
      if (typeof src === 'string') out.push(src);
    }
  }
  return out;
}

function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    value.split(/[\\/]/).every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function parseNpmSpec(spec: string): { name: string } | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  const name = match?.[1] ?? trimmed;
  return isSafePathSegment(name) ? { name } : null;
}

function stripGitRef(repoPath: string): string {
  const atIndex = repoPath.indexOf('@');
  const hashIndex = repoPath.indexOf('#');
  const candidates = [atIndex, hashIndex].filter((i) => i >= 0).sort((a, b) => a - b);
  return candidates.length === 0 ? repoPath : repoPath.slice(0, candidates[0]);
}

function isValidGitHost(host: string): boolean {
  if (!host || !isSafePathSegment(host)) return false;
  return host === 'localhost' || host.includes('.');
}

function containsUnsafeChars(value: string): boolean {
  // Reject percent-encoded sequences and other characters pi's reference parser
  // never round-trips through filesystem paths.
  return /[%\0]/.test(value);
}

function normalizeGitParts(
  host: string,
  repoPath: string
): { host: string; repoPath: string } | null {
  const normalized = stripGitRef(repoPath)
    .replace(/\.git$/, '')
    .replace(/^\/+/, '');
  if (
    !isValidGitHost(host) ||
    !isSafePathSegment(normalized) ||
    normalized.split(/[\\/]/).length < 2
  ) {
    return null;
  }
  return { host, repoPath: normalized };
}

function parseGitSpec(spec: string): { host: string; repoPath: string } | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;

  const scpLike = trimmed.match(/^git@([^:]+):(.+)$/);
  if (scpLike) {
    return normalizeGitParts(scpLike[1] ?? '', scpLike[2] ?? '');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return normalizeGitParts(url.hostname, url.pathname.replace(/^\/+/, ''));
    } catch {
      return null;
    }
  }
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex < 0) return null;
  return normalizeGitParts(trimmed.slice(0, slashIndex), trimmed.slice(slashIndex + 1));
}

function expandLocalPath(input: string, baseDir: string): string {
  let s = input.trim();
  if (/^file:\/\//.test(s)) {
    try {
      return fileURLToPath(s);
    } catch {
      // fall through to literal handling below
    }
  }
  if (s.startsWith('file:')) s = s.slice(5);
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  if (path.isAbsolute(s)) return s;
  return path.resolve(baseDir, s);
}

function parseSettingsSource(source: string, baseDir: string): ParsedSource | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  if (containsUnsafeChars(trimmed)) return null;
  // Bare SCP shorthand (`git@host:path`) without the `git:` prefix is rejected,
  // matching pi's convention that unprefixed sources must be protocol URLs or local paths.
  if (/^git@[^:]+:/.test(trimmed)) return null;

  if (trimmed.startsWith('npm:')) {
    const parsed = parseNpmSpec(trimmed.slice(4));
    if (!parsed) return null;
    return { type: 'npm', identity: `npm:${parsed.name}`, npmName: parsed.name };
  }

  // Order matters: a bare `git://...` URL technically starts with `git:` but is
  // a protocol URL, not the pi-package `git:` prefix. Check protocol URLs first,
  // then the `git:` prefix (which is what pi uses for SCP shorthand or unprefixed
  // host/path forms).
  const isProtocolUrl = /^(?:https?|ssh|git):\/\//i.test(trimmed);
  const hasGitPrefix = !isProtocolUrl && trimmed.startsWith('git:');
  if (isProtocolUrl || hasGitPrefix) {
    const spec = hasGitPrefix ? trimmed.slice(4) : trimmed;
    const parsed = parseGitSpec(spec);
    if (!parsed) return null;
    const suffix = `${parsed.host}/${parsed.repoPath}`;
    return { type: 'git', identity: `git:${suffix}`, gitSuffix: suffix };
  }

  const resolved = canonicalizeLocalPath(path.resolve(expandLocalPath(trimmed, baseDir)));
  return { type: 'local', identity: `local:${resolved}`, localPath: resolved };
}

function canonicalizeLocalPath(absPath: string): string {
  try {
    return fs.realpathSync(absPath);
  } catch {
    return absPath;
  }
}

let cachedGlobalNpmRoot: string | null | undefined;

function getGlobalNpmRoot(): string | null {
  if (cachedGlobalNpmRoot !== undefined) return cachedGlobalNpmRoot;
  try {
    const out = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    cachedGlobalNpmRoot = out ? fs.realpathSync(out) : null;
  } catch {
    cachedGlobalNpmRoot = null;
  }
  return cachedGlobalNpmRoot;
}

function resolveNpmRoot(
  npmName: string,
  baseDir: string,
  scope: 'user' | 'project'
): string | null {
  const managed = path.join(baseDir, 'npm', 'node_modules', npmName);
  if (fs.existsSync(managed)) return managed;
  if (scope !== 'user') return null;
  const globalRoot = getGlobalNpmRoot();
  if (!globalRoot) return null;
  const legacy = path.join(globalRoot, npmName);
  return fs.existsSync(legacy) ? legacy : null;
}

function resolvePackageRoot(
  parsed: ParsedSource,
  baseDir: string,
  scope: 'user' | 'project'
): string | null {
  switch (parsed.type) {
    case 'npm':
      return parsed.npmName ? resolveNpmRoot(parsed.npmName, baseDir, scope) : null;
    case 'git':
      return parsed.gitSuffix ? path.join(baseDir, 'git', parsed.gitSuffix) : null;
    case 'local':
      return parsed.localPath ?? null;
  }
}

function collectPackagesForScope(
  settingsFile: string,
  baseDir: string,
  scope: 'user' | 'project'
): ResolvedPackage[] {
  const sources = readSettingsPackages(settingsFile);
  const out: ResolvedPackage[] = [];
  for (const source of sources) {
    const parsed = parseSettingsSource(source, baseDir);
    if (!parsed) continue;
    const root = resolvePackageRoot(parsed, baseDir, scope);
    if (!root) continue;
    out.push({ identity: parsed.identity, packageRoot: root, scope });
  }
  return out;
}

function readPiAgentsField(pkg: unknown): string[] {
  if (!pkg || typeof pkg !== 'object') return [];
  const pi = (pkg as Record<string, unknown>).pi;
  if (!pi || typeof pi !== 'object') return [];
  const agents = (pi as Record<string, unknown>).agents;
  if (typeof agents === 'string') return [agents];
  if (Array.isArray(agents)) return agents.filter((v): v is string => typeof v === 'string');
  return [];
}

function readPackageManifest(packageRoot: string): { name: string; agentPaths: string[] } | null {
  const pkg = safeReadJson(path.join(packageRoot, 'package.json'));
  if (!pkg || typeof pkg !== 'object') return null;
  const name = (pkg as Record<string, unknown>).name;
  if (typeof name !== 'string' || name.length === 0) return null;
  return { name, agentPaths: readPiAgentsField(pkg) };
}

function findNearestProjectConfigDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // fallthrough
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) return null;
    currentDir = parent;
  }
}

function dedupeByIdentity(packages: ResolvedPackage[]): ResolvedPackage[] {
  // Project entries override user entries when identities collide.
  const byIdentity = new Map<string, ResolvedPackage>();
  for (const pkg of packages) {
    const existing = byIdentity.get(pkg.identity);
    if (!existing || (existing.scope === 'user' && pkg.scope === 'project')) {
      byIdentity.set(pkg.identity, pkg);
    }
  }
  return Array.from(byIdentity.values());
}

export function discoverPackageAgentDirs(
  cwd: string,
  scope: PackageDiscoveryScope = 'both'
): PackageAgentDir[] {
  const packages: ResolvedPackage[] = [];

  if (scope === 'user' || scope === 'both') {
    const userBase = getAgentDir();
    packages.push(
      ...collectPackagesForScope(path.join(userBase, 'settings.json'), userBase, 'user')
    );
  }

  if (scope === 'project' || scope === 'both') {
    const projectConfigDir = findNearestProjectConfigDir(cwd);
    if (projectConfigDir) {
      packages.push(
        ...collectPackagesForScope(
          path.join(projectConfigDir, 'settings.json'),
          projectConfigDir,
          'project'
        )
      );
    }
  }

  const deduped = dedupeByIdentity(packages);

  const dirs: PackageAgentDir[] = [];
  for (const { packageRoot } of deduped) {
    const normalizedRoot = path.resolve(packageRoot);
    if (!fs.existsSync(normalizedRoot)) continue;

    const manifest = readPackageManifest(normalizedRoot);
    if (!manifest || manifest.agentPaths.length === 0) continue;

    let realRoot: string;
    try {
      realRoot = fs.realpathSync(normalizedRoot);
    } catch {
      continue;
    }
    const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;

    for (const rel of manifest.agentPaths) {
      const abs = path.resolve(normalizedRoot, rel);
      if (!fs.existsSync(abs)) continue;
      let realAbs: string;
      try {
        realAbs = fs.realpathSync(abs);
      } catch {
        continue;
      }
      if (realAbs !== realRoot && !realAbs.startsWith(rootWithSep)) continue;
      dirs.push({ packageName: manifest.name, packageRoot: normalizedRoot, agentPath: abs });
    }
  }

  return dirs;
}
