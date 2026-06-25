// ABOUTME: LSP server config source — reads the dedicated config.json and appends detected recipe servers.
// ABOUTME: Validates servers, preserves user precedence, and applies env substitution.

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Value } from 'typebox/value';
import { getAgentDir, CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';
import { logError, logForDebugging } from './log.ts';
import { BUILTIN_RECIPES, getDetectedRecipeServers } from './recipes.ts';
import type { LspServerRecipe } from './recipes.ts';
import type { InputScopedLspServerConfig, ScopedLspServerConfig } from './types.ts';
import { InputScopedLspServerConfigSchema } from './types.ts';

interface InputLspConfig {
  servers?: Record<string, InputScopedLspServerConfig>;
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
function normalizeServer(
  name: string,
  raw: InputScopedLspServerConfig,
  base?: InputScopedLspServerConfig
): ScopedLspServerConfig | undefined {
  // Layer inputs over the optional recipe base so users can override single
  // fields (e.g. command) without re-declaring extensionToLanguage.
  // Only inherit from the base when the user did not supply the field at all;
  // an explicit JSON `null` should fail schema validation rather than inherit.
  const merged: InputScopedLspServerConfig = base
    ? {
        ...base,
        ...raw,
        env: 'env' in raw ? raw.env : base.env,
        // Allow `extensions` sugar to override a recipe's extensionToLanguage
        // when the user did not explicitly provide extensionToLanguage.
        extensionToLanguage:
          'extensionToLanguage' in raw || 'extensions' in raw
            ? raw.extensionToLanguage
            : base.extensionToLanguage,
        initializationOptions:
          'initializationOptions' in raw ? raw.initializationOptions : base.initializationOptions,
        settings: 'settings' in raw ? raw.settings : base.settings,
      }
    : raw;

  if (!Value.Check(InputScopedLspServerConfigSchema, merged)) {
    const errors = Value.Errors(InputScopedLspServerConfigSchema, merged);
    logError(
      new Error(
        `LSP server '${name}' config invalid: ${errors.map((error) => error.message).join('; ')}`
      )
    );
    return undefined;
  }

  if (!merged.command || typeof merged.command !== 'string' || merged.command.trim() === '') {
    logError(new Error(`LSP server '${name}' missing required 'command' field`));
    return undefined;
  }

  // Commands with spaces must be absolute paths (e.g. "/usr/local/bin/my server").
  // Otherwise the user should split args into the args array.
  if (merged.command.includes(' ') && !path.isAbsolute(merged.command)) {
    logError(
      new Error(
        `LSP server '${name}': command should not contain spaces. Use the args array for arguments.`
      )
    );
    return undefined;
  }

  // Resolve extensionToLanguage, accepting `extensions` as sugar.
  let extensionToLanguage = merged.extensionToLanguage;
  if (!extensionToLanguage) {
    if (!merged.extensions || merged.extensions.length === 0) {
      logError(
        new Error(`LSP server '${name}': missing 'extensionToLanguage' (or 'extensions') mapping`)
      );
      return undefined;
    }
    extensionToLanguage = {};
    for (const ext of merged.extensions) {
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

  const command = substituteEnv(merged.command);
  const args = merged.args?.map((a) => substituteEnv(a));
  const env = merged.env
    ? Object.fromEntries(Object.entries(merged.env).map(([k, v]) => [k, substituteEnv(v)]))
    : undefined;

  const role = merged.role ?? 'primary';
  const startupMode = merged.startupMode ?? 'auto';
  const enabled = merged.enabled ?? true;

  const conflictGroup =
    typeof merged.conflictGroup === 'string' && merged.conflictGroup.length > 0
      ? merged.conflictGroup
      : role === 'primary'
        ? name
        : undefined;

  return {
    command,
    args,
    extensionToLanguage,
    env,
    initializationOptions: merged.initializationOptions,
    settings: merged.settings,
    workspaceFolder: merged.workspaceFolder,
    startupTimeout: merged.startupTimeout,
    shutdownTimeout: merged.shutdownTimeout,
    restartOnCrash: merged.restartOnCrash,
    maxRestarts: merged.maxRestarts,
    transport: merged.transport ?? 'stdio',
    role,
    startupMode,
    enabled,
    conflictGroup,
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
      logForDebugging(`config: failed to read ${filePath}: ${(error as Error).message}`);
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

const CONFIG_FILENAME = path.join('@balaenis', 'pi-lsp', 'config.json');

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
  const globalPath = path.join(getAgentDir(), CONFIG_FILENAME);
  const projectPath = path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME);

  const [globalSettings, projectSettings] = await Promise.all([
    readConfigFile(globalPath),
    readConfigFile(projectPath),
  ]);

  const globalServers = extractServers(globalSettings);
  const projectServers = extractServers(projectSettings);

  const detectedRecipes = getDetectedRecipeServers();

  // All built-in recipes act as the merge base for same-name user entries,
  // regardless of whether the recipe's default binary is on PATH. This lets
  // users supply a custom command while inheriting extensionToLanguage and
  // other defaults.
  const allRecipes: Record<string, InputScopedLspServerConfig> = {};
  for (const recipe of BUILTIN_RECIPES) {
    allRecipes[recipe.name] = recipeToInput(recipe);
  }

  function recipeToInput(recipe: LspServerRecipe): InputScopedLspServerConfig {
    const input: InputScopedLspServerConfig = {
      command: recipe.command,
      args: recipe.args ? [...recipe.args] : undefined,
      extensionToLanguage: { ...recipe.extensionToLanguage },
      role: recipe.role,
      startupTimeout: recipe.startupTimeout,
    };
    if (recipe.settings !== undefined) {
      input.settings = recipe.settings;
    }
    return input;
  }

  // Resolve user-configured servers with recipe defaults as the base.
  // Precedence: recipe defaults < global config < project config.
  // A user entry can override a single field (e.g. command) and inherit the
  // rest from the matching recipe.
  const userServerNames = new Set([...Object.keys(globalServers), ...Object.keys(projectServers)]);

  const userServers: Record<string, ScopedLspServerConfig> = {};
  for (const name of userServerNames) {
    const base = allRecipes[name];
    // Merge global → project first; normalizeServer will layer this over the
    // recipe base. Do not include the base here so that 'in' checks inside
    // normalizeServer can tell which fields the user actually supplied.
    const raw: InputScopedLspServerConfig = {
      ...globalServers[name],
      ...projectServers[name],
    };
    const normalized = normalizeServer(name, raw, base);
    if (normalized) {
      userServers[name] = normalized;
    }
    logForDebugging(`User server '${name}': ${normalized?.command}`);
  }

  // Only enabled auto primary user servers participate in extension-overlap
  // suppression; companions overlap by design, manual primary servers can be
  // configured alongside an auto primary recipe, and disabled servers are ignored.
  const userCoveredExtensions = new Set<string>();
  for (const cfg of Object.values(userServers)) {
    if (cfg.enabled === false || cfg.role !== 'primary' || cfg.startupMode !== 'auto') continue;
    for (const ext of Object.keys(cfg.extensionToLanguage)) {
      userCoveredExtensions.add(ext.toLowerCase());
    }
  }

  // Add recipes that were not merged with user config, skipping any whose
  // extensions overlap an enabled auto-primary user-covered extension.
  const servers: Record<string, ScopedLspServerConfig> = { ...userServers };
  for (const [name, cfg] of Object.entries(detectedRecipes)) {
    if (servers[name]) {
      logForDebugging(`config: recipe '${name}' merged with user config`);
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

  // Drop disabled servers after recipe merge so a disabled entry with the same
  // name as a built-in recipe still suppresses the recipe.
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.enabled === false) {
      logForDebugging(`config: skipping disabled server '${name}'`);
      delete servers[name];
    }
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
): Record<string, InputScopedLspServerConfig> {
  if (!settings) return {};
  const config = settings as InputLspConfig;
  if (!config.servers) return {};
  return config.servers as Record<string, InputScopedLspServerConfig>;
}
