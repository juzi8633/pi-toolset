// ABOUTME: LSP server config source — reads the dedicated config.json and appends detected recipe servers.
// ABOUTME: Validates servers, preserves user precedence, and applies env substitution.

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { logError, logForDebugging } from './log.ts';
import { getDetectedRecipeServers } from './recipes.ts';
import type { LspTransport, ScopedLspServerConfig } from './types.ts';

/**
 * Raw server entry as it appears in config.json `servers.<name>`.
 * `extensions` is accepted as sugar and mapped to `extensionToLanguage` via
 * {@link guessLanguageId} when `extensionToLanguage` is absent.
 */
interface RawServerConfig {
  command?: string;
  args?: string[];
  extensionToLanguage?: Record<string, string>;
  /** Sugar: [".ts", ".tsx"] → mapped via guessLanguageId. */
  extensions?: string[];
  env?: Record<string, string>;
  initializationOptions?: unknown;
  settings?: unknown;
  workspaceFolder?: string;
  startupTimeout?: number;
  shutdownTimeout?: number;
  restartOnCrash?: boolean;
  maxRestarts?: number;
  transport?: LspTransport;
}

interface RawLspConfig {
  servers?: Record<string, RawServerConfig>;
}

/**
 * Best-effort languageId guess for the `extensions` sugar. Covers the common
 * TS/JS family and a few popular languages; unknown extensions fall back to
 * "plaintext" so the server still receives a usable languageId.
 */
function guessLanguageId(ext: string): string {
  const normalized = ext.toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.pyw': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.kt': 'kotlin',
    '.rb': 'ruby',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.swift': 'swift',
    '.lua': 'lua',
    '.json': 'json',
    '.jsonc': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.md': 'markdown',
    '.css': 'css',
    '.scss': 'scss',
    '.html': 'html',
    '.xml': 'xml',
    '.sh': 'shellscript',
    '.bash': 'shellscript',
    '.zsh': 'shellscript',
    '.php': 'php',
    '.scala': 'scala',
    '.dart': 'dart',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.clj': 'clojure',
    '.hs': 'haskell',
    '.sql': 'sql',
    '.vue': 'vue',
    '.svelte': 'svelte',
  };
  return map[normalized] ?? 'plaintext';
}

/**
 * Replace `$VAR` and `${VAR}` with `process.env[VAR]`. Undefined env vars
 * expand to an empty string. Applied to command, args, and env values.
 */
function substituteEnv(value: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, braced, bare) => {
      const name = braced ?? bare;
      return process.env[name] ?? '';
    }
  );
}

/**
 * Validate a single raw server entry and convert it to a ScopedLspServerConfig.
 * Returns undefined when the entry is invalid; the caller logs and skips it.
 */
function normalizeServer(name: string, raw: RawServerConfig): ScopedLspServerConfig | undefined {
  if (!raw.command || typeof raw.command !== 'string' || raw.command.trim() === '') {
    logError(new Error(`LSP server '${name}' missing required 'command' field`));
    return undefined;
  }

  // Commands with spaces must be absolute paths (e.g. "/usr/local/bin/my server").
  // Otherwise the user should split args into the args array.
  if (raw.command.includes(' ') && !path.isAbsolute(raw.command)) {
    logError(
      new Error(
        `LSP server '${name}': command should not contain spaces. Use the args array for arguments.`
      )
    );
    return undefined;
  }

  // Resolve extensionToLanguage, accepting `extensions` as sugar.
  let extensionToLanguage = raw.extensionToLanguage;
  if (!extensionToLanguage) {
    if (!raw.extensions || raw.extensions.length === 0) {
      logError(
        new Error(`LSP server '${name}': missing 'extensionToLanguage' (or 'extensions') mapping`)
      );
      return undefined;
    }
    extensionToLanguage = {};
    for (const ext of raw.extensions) {
      const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
      extensionToLanguage[normalized] = guessLanguageId(normalized);
    }
  }

  if (Object.keys(extensionToLanguage).length === 0) {
    logError(new Error(`LSP server '${name}': extensionToLanguage must have at least one mapping`));
    return undefined;
  }

  for (const ext of Object.keys(extensionToLanguage)) {
    if (!ext.startsWith('.')) {
      logError(
        new Error(
          `LSP server '${name}': file extension '${ext}' must start with a dot (e.g. ".ts")`
        )
      );
      return undefined;
    }
  }

  const command = substituteEnv(raw.command);
  const args = raw.args?.map((a) => substituteEnv(a));
  const env = raw.env
    ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, substituteEnv(v)]))
    : undefined;

  return {
    command,
    args,
    extensionToLanguage,
    env,
    initializationOptions: raw.initializationOptions,
    settings: raw.settings,
    workspaceFolder: raw.workspaceFolder,
    startupTimeout: raw.startupTimeout,
    shutdownTimeout: raw.shutdownTimeout,
    restartOnCrash: raw.restartOnCrash,
    maxRestarts: raw.maxRestarts,
    transport: raw.transport ?? 'stdio',
  };
}

/** Read and parse a config.json file, returning undefined on any error. */
async function readConfigFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await readFile(filePath, { encoding: 'utf-8' });
    // Strip JSONC comments (// line and /* block */) before parsing. config.json
    // commonly uses comments; JSON.parse rejects them.
    const stripped = stripJsonc(content);
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch (error) {
    // Missing file is the common, silent case; only log unexpected errors.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logForDebugging(`config: failed to read ${filePath}: ${(error as Error).message}`, {
        level: 'warn',
      });
    }
    return undefined;
  }
}

/** Strip JSONC comments (slash-slash line and slash-star block) from text. */
function stripJsonc(text: string): string {
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
      // Line comment: skip to end of line.
      i += 2;
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      // Block comment: skip to closing */.
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Per-extension config subdirectory under the agent dir / project config dir.
 * Keeping config in a dedicated dir avoids key collisions in Pi's shared
 * settings.json and survives package updates (the installed package dir is
 * overwritten by `pi update`).
 */
const CONFIG_SUBDIR = path.join('@balaenis', 'pi-lsp');
const CONFIG_FILENAME = 'config.json';

/**
 * Get all configured LSP servers.
 *
 * Reads `servers` from `~/.pi/agent/@balaenis/pi-lsp/config.json` then
 * `<cwd>/.pi/@balaenis/pi-lsp/config.json` (project overrides global),
 * normalizes user entries, then appends built-in recipes detected on PATH for
 * any languages the user has not already covered.
 *
 * - With no valid user config: returns just the autodetected recipes (zero-config).
 * - With user config: user server names and user-covered extensions win; recipes
 *   are added only for uncovered languages and non-conflicting server names.
 */
export async function getAllLspServers(cwd: string): Promise<{
  servers: Record<string, ScopedLspServerConfig>;
}> {
  const globalPath = path.join(getAgentDir(), CONFIG_SUBDIR, CONFIG_FILENAME);
  const projectPath = path.join(cwd, '.pi', CONFIG_SUBDIR, CONFIG_FILENAME);

  const [globalSettings, projectSettings] = await Promise.all([
    readConfigFile(globalPath),
    readConfigFile(projectPath),
  ]);

  const globalServers = extractServers(globalSettings);
  const projectServers = extractServers(projectSettings);

  // Project overrides global on key collision.
  const merged: Record<string, RawServerConfig> = {
    ...globalServers,
    ...projectServers,
  };

  const userServers: Record<string, ScopedLspServerConfig> = {};
  for (const [name, raw] of Object.entries(merged)) {
    const normalized = normalizeServer(name, raw);
    if (normalized) {
      userServers[name] = normalized;
    }
    logForDebugging(`User server '${name}': ${normalized?.command}`);
  }

  const recipes = getDetectedRecipeServers();
  const userCoveredExtensions = new Set<string>();
  for (const cfg of Object.values(userServers)) {
    for (const ext of Object.keys(cfg.extensionToLanguage)) {
      userCoveredExtensions.add(ext.toLowerCase());
    }
  }

  // Start with the user-validated entries, then layer recipes that do not
  // collide on server name or any covered extension.
  const servers: Record<string, ScopedLspServerConfig> = { ...userServers };
  for (const [name, cfg] of Object.entries(recipes)) {
    if (servers[name]) {
      logForDebugging(
        `config: skipping detected recipe '${name}' — already covered by user config`
      );
      continue;
    }
    const recipeExts = Object.keys(cfg.extensionToLanguage).map((e) => e.toLowerCase());
    const overlap = recipeExts.some((ext) => userCoveredExtensions.has(ext));
    if (overlap) {
      logForDebugging(
        `config: skipping detected recipe '${name}' — extensions overlap user config`
      );
      continue;
    }
    servers[name] = cfg;
  }

  if (Object.keys(servers).length === 0) {
    logForDebugging('config: no user servers and no recipe binaries on PATH');
    return { servers: {} };
  }

  logForDebugging(
    `config: loaded ${Object.keys(servers).length} LSP server(s): ${Object.keys(servers).join(', ')}`
  );
  return { servers };
}

/** Extract the `servers` record from a parsed config object. */
function extractServers(
  settings: Record<string, unknown> | undefined
): Record<string, RawServerConfig> {
  if (!settings) return {};
  const config = settings as RawLspConfig;
  if (!config.servers) return {};
  return config.servers as Record<string, RawServerConfig>;
}
