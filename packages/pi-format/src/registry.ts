// ABOUTME: Formatter registry that merges user config with built-in recipes.
// ABOUTME: Selects the first enabled formatter matching a file extension.

import * as path from 'node:path';
import type { FormatterConfig, FormatterRecipe, RecipeContext } from './types.ts';
import { findExecutable, findUp, readPackageJson } from './utils.ts';

export interface FormatterRegistry {
  getFormatterForFile(filePath: string): Promise<FormatterMatch | undefined>;
  getFormatterByName(name: string, filePath: string): Promise<FormatterByNameResult>;
}

export interface FormatterMatch {
  formatter: FormatterConfig;
  command: string[];
  timeoutMs: number;
}

export type FormatterByNameResult =
  | { kind: 'match'; match: FormatterMatch }
  | { kind: 'unknown' }
  | { kind: 'disabled' }
  | { kind: 'unavailable' }
  | { kind: 'extension-mismatch'; supported: string[] };

interface InternalFormatterEntry {
  config: FormatterConfig;
  recipe?: FormatterRecipe;
}

export function createFormatterRegistry(
  cwd: string,
  userFormatters: Record<string, FormatterConfig>,
  recipes: readonly FormatterRecipe[]
): FormatterRegistry {
  const recipeByName = new Map<string, FormatterRecipe>(recipes.map((r) => [r.name, r]));
  const recipeCache = new Map<string, ResolvedRecipe | false>();

  const customUserEntries: InternalFormatterEntry[] = [];
  const overrideByName = new Map<string, FormatterConfig>();

  for (const [name, config] of Object.entries(userFormatters)) {
    if (recipeByName.has(name)) {
      overrideByName.set(name, config);
    } else {
      customUserEntries.push({ config });
    }
  }

  const builtInEntries: InternalFormatterEntry[] = [];
  for (const recipe of recipes) {
    const override = overrideByName.get(recipe.name);
    if (override) {
      builtInEntries.push({
        config: {
          ...override,
          extensions: override.extensions.length > 0 ? override.extensions : recipe.extensions,
        },
        recipe,
      });
    } else {
      builtInEntries.push({
        config: {
          name: recipe.name,
          disabled: false,
          command: [],
          extensions: recipe.extensions,
          timeoutMs: 30_000,
          source: 'builtin',
        },
        recipe,
      });
    }
  }

  // Precedence: custom user formatters in config order, then built-ins in
  // their declared order (overrides keep the built-in position).
  const orderedEntries: InternalFormatterEntry[] = [...customUserEntries, ...builtInEntries];

  const recipeContext: RecipeContext = {
    cwd,
    findExecutable: (name) => findExecutable(name),
    readPackageJson: (dir) => readPackageJson(dir),
    findUp: (names) => findUp(cwd, names),
  };

  async function resolveRecipe(recipe: FormatterRecipe): Promise<ResolvedRecipe | false> {
    const cached = recipeCache.get(recipe.name);
    if (cached !== undefined) return cached;
    const resolved = await recipe.resolve(recipeContext);
    if (resolved === false) {
      recipeCache.set(recipe.name, false);
      return false;
    }
    const result: ResolvedRecipe = {
      command: resolved.command,
    };
    recipeCache.set(recipe.name, result);
    return result;
  }

  async function resolveEntry(
    entry: InternalFormatterEntry
  ): Promise<{ command: string[] } | undefined> {
    if (entry.config.disabled) return undefined;

    if (entry.config.command.length > 0) {
      return {
        command: entry.config.command,
      };
    }

    if (!entry.recipe) return undefined;
    const resolved = await resolveRecipe(entry.recipe);
    if (resolved === false) return undefined;

    return {
      command: resolved.command,
    };
  }

  return {
    async getFormatterForFile(filePath) {
      const dotted = path.extname(filePath).toLowerCase();
      if (!dotted) return undefined;

      for (const entry of orderedEntries) {
        if (entry.config.disabled) continue;
        if (!entry.config.extensions.includes(dotted)) continue;

        const resolved = await resolveEntry(entry);
        if (!resolved) continue;

        return {
          formatter: entry.config,
          command: resolved.command,
          timeoutMs: entry.config.timeoutMs,
        };
      }

      return undefined;
    },
    async getFormatterByName(name, filePath) {
      const entry = orderedEntries.find((e) => e.config.name === name);
      if (!entry) return { kind: 'unknown' };
      if (entry.config.disabled) return { kind: 'disabled' };

      const dotted = path.extname(filePath).toLowerCase();
      if (!dotted || !entry.config.extensions.includes(dotted)) {
        return { kind: 'extension-mismatch', supported: [...entry.config.extensions] };
      }

      const resolved = await resolveEntry(entry);
      if (!resolved) return { kind: 'unavailable' };

      return {
        kind: 'match',
        match: {
          formatter: entry.config,
          command: resolved.command,
          timeoutMs: entry.config.timeoutMs,
        },
      };
    },
  };
}

interface ResolvedRecipe {
  command: string[];
}
