// ABOUTME: Built-in LSP server recipes, PATH executable discovery, and install-hint lookup.
// ABOUTME: Drives zero-config activation when no user servers config exists or covers a given file.

import { accessSync, constants, statSync } from 'node:fs';
import * as path from 'node:path';
import { logForDebugging } from './log.ts';
import type { ScopedLspServerConfig } from './types.ts';

/**
 * A built-in LSP server recipe. Recipes are advisory: a recipe is only
 * activated when its `command` is found on `PATH`, and user-configured
 * servers always win on server name and covered extensions.
 */
export interface LspServerRecipe {
  /** Server name used in the manager's server map. */
  name: string;
  /** Executable looked up on PATH. */
  command: string;
  /** Optional command arguments. */
  args?: string[];
  /** Extension → LSP languageId mapping for routing and didOpen. */
  extensionToLanguage: Record<string, string>;
  /** Human-readable install hint shown when the command is not on PATH. */
  installHint: string;
  /** Server role in multi-server routing; defaults to primary. */
  role?: ScopedLspServerConfig['role'];
  startupTimeout?: number;
  /** Optional default settings returned to the server via workspace/configuration. */
  settings?: unknown;
}

/**
 * Default `vscode-eslint-language-server` settings required for the server to
 * resolve ESLint and compute diagnostics. These mirror VS Code's defaults and
 * are merged with the dynamic `workspaceFolder` at request time inside the
 * manager.
 */
const ESLINT_DEFAULT_SETTINGS = {
  validate: 'on',
  packageManager: 'npm',
  useESLintClass: true,
  useFlatConfig: true,
  experimental: { useFlatConfig: false },
  nodePath: null,
  workingDirectory: { mode: 'location' },
  codeAction: {
    disableRuleComment: { enable: true, location: 'separateLine' },
    showDocumentation: { enable: true },
  },
  codeActionOnSave: { enable: false, mode: 'all' },
  format: false,
  onIgnoredFiles: 'off',
  options: {},
  problems: { shortenToSingleLine: false },
  quiet: false,
  rulesCustomizations: [],
  run: 'onType',
} as const;

/**
 * The first-iteration built-in recipe set. Order is significant: the first
 * recipe whose extension matches an unsupported file determines the install
 * hint surfaced to the user.
 */
export const BUILTIN_RECIPES: readonly LspServerRecipe[] = [
  {
    name: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensionToLanguage: {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.mts': 'typescript',
      '.cts': 'typescript',
    },
    installHint:
      'Install `typescript-language-server` and `typescript` (for example `npm install -g typescript typescript-language-server`) and ensure the command is on PATH.',
  },
  {
    name: 'eslint',
    command: 'vscode-eslint-language-server',
    args: ['--stdio'],
    extensionToLanguage: {
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.mts': 'typescript',
      '.cts': 'typescript',
      '.vue': 'vue',
    },
    role: 'companion',
    settings: ESLINT_DEFAULT_SETTINGS,
    installHint:
      'Install `vscode-langservers-extracted` (for example `npm install -g vscode-langservers-extracted`) which provides `vscode-eslint-language-server` on PATH.',
  },
  {
    name: 'python',
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensionToLanguage: {
      '.py': 'python',
      '.pyw': 'python',
    },
    installHint:
      'Install `pyright` (for example `npm install -g pyright`) and ensure `pyright-langserver` is on PATH.',
  },
  {
    name: 'rust',
    command: 'rust-analyzer',
    extensionToLanguage: {
      '.rs': 'rust',
    },
    installHint:
      'Install `rust-analyzer` (for example `rustup component add rust-analyzer` or an OS package) and ensure it is on PATH.',
  },
  {
    name: 'go',
    command: 'gopls',
    extensionToLanguage: {
      '.go': 'go',
    },
    installHint:
      'Install `gopls` (for example `go install golang.org/x/tools/gopls@latest`) and ensure it is on PATH.',
  },
  {
    name: 'kotlin',
    command: 'kotlin-lsp',
    args: ['--stdio'],
    extensionToLanguage: {
      '.kt': 'kotlin',
    },
    startupTimeout: 60000,
    installHint:
      'Install JetBrains `kotlin-lsp` (for example `brew install JetBrains/utils/kotlin-lsp`, or download a release from https://github.com/Kotlin/kotlin-lsp and symlink `kotlin-lsp.sh` as `kotlin-lsp` on PATH) and ensure it is on PATH. Requires Java 17+.',
  },
  {
    name: 'lua',
    command: 'lua-language-server',
    extensionToLanguage: {
      '.lua': 'lua',
    },
    installHint:
      'Install `lua-language-server` (for example `pacman -S lua-language-server`, `brew install lua-language-server`, or download a release from https://github.com/LuaLS/lua-language-server) and ensure it is on PATH.',
  },
  {
    name: 'clangd',
    command: 'clangd',
    extensionToLanguage: {
      '.c': 'c',
      '.h': 'c',
      '.cc': 'cpp',
      '.cpp': 'cpp',
      '.cxx': 'cpp',
      '.c++': 'cpp',
      '.hh': 'cpp',
      '.hpp': 'cpp',
      '.hxx': 'cpp',
      '.h++': 'cpp',
      '.m': 'objective-c',
      '.mm': 'objective-cpp',
    },
    installHint:
      'Install `clangd` (for example `pacman -S clang`, `brew install llvm`, or `apt install clangd`) and ensure it is on PATH.',
  },
  {
    name: 'bash',
    command: 'bash-language-server',
    args: ['start'],
    extensionToLanguage: {
      '.sh': 'shellscript',
      '.bash': 'shellscript',
      '.zsh': 'shellscript',
      '.ksh': 'shellscript',
    },
    installHint:
      'Install `bash-language-server` (for example `npm install -g bash-language-server`) and ensure it is on PATH.',
  },
  {
    name: 'json',
    command: 'vscode-json-language-server',
    args: ['--stdio'],
    extensionToLanguage: {
      '.json': 'json',
      '.jsonc': 'jsonc',
    },
    installHint:
      'Install `vscode-langservers-extracted` (for example `npm install -g vscode-langservers-extracted`) which provides `vscode-json-language-server` on PATH.',
  },
  {
    name: 'yaml',
    command: 'yaml-language-server',
    args: ['--stdio'],
    extensionToLanguage: {
      '.yaml': 'yaml',
      '.yml': 'yaml',
    },
    installHint:
      'Install `yaml-language-server` (for example `npm install -g yaml-language-server`) and ensure it is on PATH.',
  },
  {
    name: 'html',
    command: 'vscode-html-language-server',
    args: ['--stdio'],
    extensionToLanguage: {
      '.html': 'html',
      '.htm': 'html',
    },
    installHint:
      'Install `vscode-langservers-extracted` (for example `npm install -g vscode-langservers-extracted`) which provides `vscode-html-language-server` on PATH.',
  },
  {
    name: 'css',
    command: 'vscode-css-language-server',
    args: ['--stdio'],
    extensionToLanguage: {
      '.css': 'css',
      '.scss': 'scss',
      '.less': 'less',
    },
    installHint:
      'Install `vscode-langservers-extracted` (for example `npm install -g vscode-langservers-extracted`) which provides `vscode-css-language-server` on PATH.',
  },
  {
    name: 'vue',
    command: 'vue-language-server',
    args: ['--stdio'],
    extensionToLanguage: {
      '.vue': 'vue',
    },
    installHint:
      'Install `@vue/language-server` (for example `npm install -g @vue/language-server`) and ensure `vue-language-server` is on PATH.',
  },
];

/** Windows executable suffixes consulted when the command has no extension. */
const WINDOWS_EXEC_SUFFIXES = ['.exe', '.cmd', '.bat', '.com'];

/**
 * Locate `command` on `PATH`. Returns the absolute path when found, otherwise
 * undefined. Absolute paths are checked directly; relative entries with a path
 * separator are resolved against `cwd`.
 *
 * On POSIX the file must be executable (X_OK). On Windows, executability is
 * inferred from the suffix list when `command` lacks an extension.
 */
export function findExecutable(
  command: string,
  pathValue: string | undefined = process.env.PATH
): string | undefined {
  if (!command) return undefined;

  const isWindows = process.platform === 'win32';
  const sep = isWindows ? ';' : ':';
  const candidates = expandCandidates(command, isWindows);

  // Absolute or path-bearing commands are tried directly.
  if (path.isAbsolute(command) || command.includes(path.sep) || command.includes('/')) {
    for (const c of candidates) {
      if (isExecutableFile(c, isWindows)) return c;
    }
    return undefined;
  }

  if (!pathValue) return undefined;

  for (const dir of pathValue.split(sep)) {
    if (!dir) continue;
    for (const variant of candidates) {
      const candidate = path.join(dir, variant);
      if (isExecutableFile(candidate, isWindows)) return candidate;
    }
  }
  return undefined;
}

function expandCandidates(command: string, isWindows: boolean): string[] {
  if (!isWindows) return [command];
  const ext = path.extname(command).toLowerCase();
  if (ext && WINDOWS_EXEC_SUFFIXES.includes(ext)) return [command];
  return [command, ...WINDOWS_EXEC_SUFFIXES.map((s) => command + s)];
}

function isExecutableFile(filePath: string, isWindows: boolean): boolean {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    if (isWindows) return true;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect built-in recipes whose command is on PATH. Returns a record keyed by
 * server name suitable for merging into the configured server map.
 */
export function getDetectedRecipeServers(
  pathValue: string | undefined = process.env.PATH
): Record<string, ScopedLspServerConfig> {
  const out: Record<string, ScopedLspServerConfig> = {};
  for (const recipe of BUILTIN_RECIPES) {
    const resolved = findExecutable(recipe.command, pathValue);
    if (!resolved) continue;
    out[recipe.name] = {
      command: recipe.command,
      args: recipe.args ? [...recipe.args] : undefined,
      extensionToLanguage: { ...recipe.extensionToLanguage },
      startupTimeout: recipe.startupTimeout ?? 10000,
      maxRestarts: 3,
      transport: 'stdio',
      role: recipe.role ?? 'primary',
      startupMode: 'auto',
      enabled: true,
      conflictGroup: recipe.role === 'companion' ? undefined : recipe.name,
      ...(recipe.settings !== undefined ? { settings: recipe.settings } : {}),
    };
    logForDebugging(`recipes: detected ${recipe.name} (${recipe.command} -> ${resolved})`);
  }
  return out;
}

/**
 * Look up the install hint for a known file extension. Returns undefined when
 * no built-in recipe handles the extension. Primary recipes win over
 * companions (e.g. `.vue` should surface the Vue install hint, not ESLint's),
 * which matters when the agent reports a missing language server for a file
 * type — navigation needs a primary, so the hint should drive the user toward
 * installing one.
 */
export function getRecipeHintForExtension(ext: string): string | undefined {
  if (!ext) return undefined;
  const normalized = ext.toLowerCase();
  let companionHint: string | undefined;
  for (const recipe of BUILTIN_RECIPES) {
    if (!recipe.extensionToLanguage[normalized]) continue;
    if ((recipe.role ?? 'primary') === 'primary') return recipe.installHint;
    if (companionHint === undefined) companionHint = recipe.installHint;
  }
  return companionHint;
}

/**
 * Whether any built-in recipe claims this extension. Used to decide if a
 * "missing server" notification has actionable guidance to offer.
 */
export function recipeCoversExtension(ext: string): boolean {
  return getRecipeHintForExtension(ext) !== undefined;
}
