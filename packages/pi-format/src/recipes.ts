// ABOUTME: Built-in formatter recipes and conservative availability detection.
// ABOUTME: Recipes resolve to executable commands only when clearly available.

import type { FormatterRecipe, RecipeContext, ResolvedFormatterCommand } from './types.ts';

async function resolveCommand(
  ctx: RecipeContext,
  command: string,
  args: string[]
): Promise<ResolvedFormatterCommand | false> {
  const found = ctx.findExecutable(command);
  if (!found) return false;
  return {
    command: [command, ...args],
  };
}

const PRETTIER_EXTENSIONS = [
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.md',
  '.html',
];

const prettierRecipe: FormatterRecipe = {
  name: 'prettier',
  extensions: PRETTIER_EXTENSIONS,
  async resolve(ctx) {
    if (!ctx.findExecutable('prettier')) return false;
    return { command: ['prettier', '--write', '$FILE'] };
  },
};

const biomeRecipe: FormatterRecipe = {
  name: 'biome',
  extensions: ['.js', '.jsx', '.ts', '.tsx', '.json', '.jsonc', '.css'],
  async resolve(ctx) {
    const configFile = await ctx.findUp(['biome.json', 'biome.jsonc']);
    if (!configFile) return false;
    return resolveCommand(ctx, 'biome', ['format', '--write', '$FILE']);
  },
};

const ruffRecipe: FormatterRecipe = {
  name: 'ruff',
  extensions: ['.py', '.pyi'],
  async resolve(ctx) {
    if (!ctx.findExecutable('ruff')) return false;
    return { command: ['ruff', 'format', '$FILE'] };
  },
};

const gofmtRecipe: FormatterRecipe = {
  name: 'gofmt',
  extensions: ['.go'],
  async resolve(ctx) {
    return resolveCommand(ctx, 'gofmt', ['-w', '$FILE']);
  },
};

const rustfmtRecipe: FormatterRecipe = {
  name: 'rustfmt',
  extensions: ['.rs'],
  async resolve(ctx) {
    return resolveCommand(ctx, 'rustfmt', ['$FILE']);
  },
};

const shfmtRecipe: FormatterRecipe = {
  name: 'shfmt',
  extensions: ['.sh', '.bash', '.zsh'],
  async resolve(ctx) {
    return resolveCommand(ctx, 'shfmt', ['-w', '$FILE']);
  },
};

const clangFormatRecipe: FormatterRecipe = {
  name: 'clang-format',
  extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'],
  async resolve(ctx) {
    const configFile = await ctx.findUp(['.clang-format', '_clang-format']);
    if (!configFile) return false;
    return resolveCommand(ctx, 'clang-format', ['-i', '$FILE']);
  },
};

/**
 * Built-in formatter recipes in deterministic precedence order. Biome is
 * checked before Prettier so projects with an explicit Biome config win.
 */
export const BUILTIN_FORMATTER_RECIPES: readonly FormatterRecipe[] = [
  biomeRecipe,
  prettierRecipe,
  ruffRecipe,
  gofmtRecipe,
  rustfmtRecipe,
  shfmtRecipe,
  clangFormatRecipe,
];
