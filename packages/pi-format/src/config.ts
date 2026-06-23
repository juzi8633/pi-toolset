// ABOUTME: Format extension config loader and normalizer.
// ABOUTME: Loads global and project config, merges them, validates formatter entries.

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Value } from 'typebox/value';
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent';
import { logDebug, logError } from './log.ts';
import { stripJsonc } from './utils.ts';
import {
  InputFormatterConfigSchema,
  type FormatterConfig,
  type InputFormatConfig,
  type InputFormatterConfig,
} from './types.ts';

const CONFIG_FILENAME = path.join('@balaenis', 'pi-format', 'config.json');
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Read and parse a JSONC config file. Returns undefined when the file is
 * missing or cannot be parsed.
 */
async function readConfigFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await readFile(filePath, { encoding: 'utf-8' });
    const stripped = stripJsonc(content);
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logDebug(`config: failed to read ${filePath}: ${(error as Error).message}`);
    }
    return undefined;
  }
}

/**
 * Normalize a file extension to lowercase. Requires a leading dot.
 */
export function normalizeExtension(ext: string): string | undefined {
  const trimmed = ext.trim();
  if (!trimmed.startsWith('.')) return undefined;
  return trimmed.toLowerCase();
}

/**
 * Validate and normalize a single raw formatter config entry. Returns
 * undefined when the entry is invalid; the caller logs and skips it.
 */
export function normalizeFormatterConfig(
  name: string,
  raw: InputFormatterConfig
): FormatterConfig | undefined {
  if (!Value.Check(InputFormatterConfigSchema, raw)) {
    const errors = Value.Errors(InputFormatterConfigSchema, raw);
    logError(
      new Error(
        `Formatter '${name}' config invalid: ${errors.map((error) => error.message).join('; ')}`
      )
    );
    return undefined;
  }

  if (raw.command !== undefined) {
    if (raw.command.length === 0) {
      logError(new Error(`Formatter '${name}' command array must not be empty`));
      return undefined;
    }
    if (!raw.command.some((arg) => arg.includes('$FILE'))) {
      logError(new Error(`Formatter '${name}' command must include a $FILE token`));
      return undefined;
    }
  }

  let extensions: string[] = [];
  if (raw.extensions !== undefined) {
    const normalized: string[] = [];
    for (const ext of raw.extensions) {
      const value = normalizeExtension(ext);
      if (!value) {
        logError(new Error(`Formatter '${name}' extension '${ext}' must start with a leading dot`));
        return undefined;
      }
      normalized.push(value);
    }
    if (normalized.length === 0) {
      logError(new Error(`Formatter '${name}' extensions array must not be empty`));
      return undefined;
    }
    extensions = normalized;
  }

  return {
    name,
    disabled: raw.disabled ?? false,
    command: raw.command ?? [],
    extensions,
    timeoutMs: raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    source: 'user',
  };
}

function extractFormatters(
  settings: Record<string, unknown> | undefined
): Record<string, InputFormatterConfig> {
  if (!settings) return {};
  const config = settings as InputFormatConfig;
  if (!config.formatters) return {};
  return config.formatters as Record<string, InputFormatterConfig>;
}

/**
 * Merge global and project formatter records. Project entries override global
 * entries by formatter name.
 */
function mergeFormatterRecords(
  global: Record<string, InputFormatterConfig>,
  project: Record<string, InputFormatterConfig>
): Record<string, InputFormatterConfig> {
  return { ...global, ...project };
}

/**
 * Load and normalize format configuration for the given working directory.
 */
export async function getFormatConfig(cwd: string): Promise<{
  enabled: boolean;
  formatOnWrite: boolean;
  formatters: Record<string, FormatterConfig>;
}> {
  const globalPath = path.join(getAgentDir(), CONFIG_FILENAME);
  const projectPath = path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME);

  const [globalSettings, projectSettings] = await Promise.all([
    readConfigFile(globalPath),
    readConfigFile(projectPath),
  ]);

  let enabled = true;
  let formatOnWrite = true;

  enabled = readBoolean(globalSettings, 'enabled', enabled);
  formatOnWrite = readBoolean(globalSettings, 'formatOnWrite', formatOnWrite);
  enabled = readBoolean(projectSettings, 'enabled', enabled);
  formatOnWrite = readBoolean(projectSettings, 'formatOnWrite', formatOnWrite);

  const rawFormatters = mergeFormatterRecords(
    extractFormatters(globalSettings),
    extractFormatters(projectSettings)
  );

  const formatters: Record<string, FormatterConfig> = {};
  for (const [name, raw] of Object.entries(rawFormatters)) {
    if (!name.trim()) {
      logError(new Error(`Formatter name must not be empty`));
      continue;
    }
    const normalized = normalizeFormatterConfig(name, raw);
    if (normalized) {
      formatters[name] = normalized;
    }
  }

  logDebug(
    `config: enabled=${enabled} formatOnWrite=${formatOnWrite} formatters=${Object.keys(formatters).join(', ')}`
  );

  return { enabled, formatOnWrite, formatters };
}

/** Default timeout used when a formatter does not specify one. */
export { DEFAULT_TIMEOUT_MS };

function readBoolean(
  settings: Record<string, unknown> | undefined,
  key: string,
  fallback: boolean
): boolean {
  if (!settings) return fallback;
  const value = settings[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    logError(new Error(`config: '${key}' must be a boolean, got ${typeof value}`));
    return fallback;
  }
  return value;
}
