// ABOUTME: Shared filesystem and environment helpers for the format extension.
// ABOUTME: PATH lookup, find-up, JSONC stripping, and env variable substitution.

import { accessSync, constants, readFileSync } from 'node:fs';
import * as path from 'node:path';

const isWindows = process.platform === 'win32';

/**
 * Find an executable on PATH. Returns the absolute path when found and
 * executable, otherwise undefined.
 */
export function findExecutable(name: string, pathEnv?: string): string | undefined {
  const searchPath = pathEnv ?? process.env.PATH;
  if (!searchPath) return undefined;

  if (path.isAbsolute(name)) {
    try {
      accessSync(name, constants.X_OK);
      return name;
    } catch {
      return undefined;
    }
  }

  const candidates =
    isWindows && !name.includes('.') ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  const dirs = searchPath.split(isWindows ? ';' : ':');

  for (const dir of dirs) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        // continue searching
      }
    }
  }
  return undefined;
}

/**
 * Walk from cwd up to the filesystem root looking for one of the named files.
 */
export async function findUp(cwd: string, names: string[]): Promise<string | undefined> {
  let current = path.resolve(cwd);
  const root = path.parse(current).root;

  while (true) {
    for (const name of names) {
      const full = path.join(current, name);
      try {
        accessSync(full, constants.F_OK);
        return full;
      } catch {
        // continue
      }
    }
    if (current === root) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Read and parse a package.json file if it exists.
 */
export async function readPackageJson(cwd: string): Promise<unknown> {
  try {
    const content = readFileSync(path.join(cwd, 'package.json'), { encoding: 'utf-8' });
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Strip JSONC line and block comments, plus trailing commas, without breaking
 * string literals.
 */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let stringEscape = false;

  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (stringEscape) {
        stringEscape = false;
      } else if (ch === '\\') {
        stringEscape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  return stripTrailingCommas(out);
}

function stripTrailingCommas(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let stringEscape = false;

  while (i < text.length) {
    const ch = text[i]!;

    if (inString) {
      out += ch;
      if (stringEscape) {
        stringEscape = false;
      } else if (ch === '\\') {
        stringEscape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Replace `$VAR` and `${VAR}` with `process.env[VAR]`. Undefined env vars
 * expand to an empty string.
 */
export function substituteEnv(value: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, braced, bare) => {
      const name = braced ?? bare;
      return process.env[name] ?? '';
    }
  );
}
