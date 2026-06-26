// ABOUTME: Discovers agents exposed by installed npm packages via their `pi.agents` package.json field.
// ABOUTME: Returns one PackageAgentDir per declared path so the caller can load .md files with a packageName namespace.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PackageAgentDir {
  packageName: string;
  packageRoot: string;
  agentPath: string;
}

function findNearestPackageJson(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, 'package.json');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    const parent = path.dirname(currentDir);
    if (parent === currentDir) return null;
    currentDir = parent;
  }
}

function safeReadJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

function collectDependencyNames(pkg: unknown): string[] {
  if (!pkg || typeof pkg !== 'object') return [];
  const names = new Set<string>();
  const groups = ['dependencies', 'devDependencies', 'optionalDependencies'];
  for (const group of groups) {
    const entry = (pkg as Record<string, unknown>)[group];
    if (entry && typeof entry === 'object') {
      for (const key of Object.keys(entry as Record<string, unknown>)) {
        names.add(key);
      }
    }
  }
  return Array.from(names);
}

function resolvePackageRoot(startDir: string, packageName: string): string | null {
  let currentDir = startDir;
  while (true) {
    const candidate = path.join(currentDir, 'node_modules', packageName, 'package.json');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.dirname(candidate);
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) return null;
    currentDir = parent;
  }
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

export function discoverPackageAgentDirs(cwd: string): PackageAgentDir[] {
  const projectPackageJson = findNearestPackageJson(cwd);
  if (!projectPackageJson) return [];

  const projectPkg = safeReadJson(projectPackageJson);
  const projectDir = path.dirname(projectPackageJson);
  const depNames = collectDependencyNames(projectPkg);

  const dirs: PackageAgentDir[] = [];
  for (const depName of depNames) {
    const packageRoot = resolvePackageRoot(projectDir, depName);
    if (!packageRoot) continue;

    const depPkg = safeReadJson(path.join(packageRoot, 'package.json'));
    const agentPaths = readPiAgentsField(depPkg);
    if (agentPaths.length === 0) continue;

    for (const relPath of agentPaths) {
      const absPath = path.resolve(packageRoot, relPath);
      if (!fs.existsSync(absPath)) continue;
      let realAbsPath: string;
      let realRoot: string;
      try {
        realAbsPath = fs.realpathSync(absPath);
        realRoot = fs.realpathSync(packageRoot);
      } catch {
        continue;
      }
      const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
      if (realAbsPath !== realRoot && !realAbsPath.startsWith(rootWithSep)) continue;
      dirs.push({ packageName: depName, packageRoot, agentPath: absPath });
    }
  }
  return dirs;
}
