// ABOUTME: Tests for format config loading, normalization, and merge rules.
// ABOUTME: Uses a temp agent dir and cwd to isolate global/project config state.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getFormatConfig, normalizeExtension, normalizeFormatterConfig } from '../src/config.ts';

let tmpRoot: string;
let agentDir: string;
let cwdDir: string;

const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

function writeAgentSettings(content: string): void {
  const dir = path.join(agentDir, '@balaenis', 'pi-format');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), content);
}

function writeProjectSettings(content: string): void {
  const dir = path.join(cwdDir, '.pi', '@balaenis', 'pi-format');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), content);
}

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-format-config-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
});

beforeEach(() => {
  const sub = mkdtempSync(path.join(tmpRoot, 'case-'));
  agentDir = path.join(sub, 'agent');
  cwdDir = path.join(sub, 'cwd');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwdDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

describe('getFormatConfig', () => {
  it('defaults enabled and formatOnWrite to true when no config exists', async () => {
    const config = await getFormatConfig(cwdDir);
    expect(config.enabled).toBe(true);
    expect(config.formatOnWrite).toBe(true);
    expect(Object.keys(config.formatters)).toEqual([]);
  });

  it('loads global config', async () => {
    writeAgentSettings(
      JSON.stringify({
        formatters: {
          prettier: {
            command: ['prettier', '--write', '$FILE'],
            extensions: ['.ts', '.tsx'],
          },
        },
      })
    );
    const config = await getFormatConfig(cwdDir);
    expect(config.formatters.prettier).toBeDefined();
    expect(config.formatters.prettier?.command).toEqual(['prettier', '--write', '$FILE']);
    expect(config.formatters.prettier?.extensions).toEqual(['.ts', '.tsx']);
  });

  it('lets project config override global config by formatter name', async () => {
    writeAgentSettings(
      JSON.stringify({
        formatters: {
          prettier: {
            command: ['prettier', '--write', '$FILE'],
            extensions: ['.ts'],
          },
        },
      })
    );
    writeProjectSettings(
      JSON.stringify({
        formatters: {
          prettier: {
            command: ['biome', 'format', '--write', '$FILE'],
            extensions: ['.js'],
          },
        },
      })
    );
    const config = await getFormatConfig(cwdDir);
    expect(config.formatters.prettier?.command).toEqual(['biome', 'format', '--write', '$FILE']);
    expect(config.formatters.prettier?.extensions).toEqual(['.js']);
  });

  it('honors enabled and formatOnWrite overrides', async () => {
    writeAgentSettings(JSON.stringify({ enabled: true, formatOnWrite: true }));
    writeProjectSettings(JSON.stringify({ enabled: false, formatOnWrite: false }));
    const config = await getFormatConfig(cwdDir);
    expect(config.enabled).toBe(false);
    expect(config.formatOnWrite).toBe(false);
  });

  it('supports JSONC comments', async () => {
    writeProjectSettings(`{
      // auto formatting switch
      "formatOnWrite": false,
      "formatters": {
        "prettier": {
          /* disabled for now */
          "disabled": true
        }
      }
    }`);
    const config = await getFormatConfig(cwdDir);
    expect(config.formatOnWrite).toBe(false);
    expect(config.formatters.prettier?.disabled).toBe(true);
  });

  it('preserves env-variable literals in command arrays', async () => {
    process.env.PI_FORMAT_TEST_WIDTH = '120';
    try {
      writeProjectSettings(
        JSON.stringify({
          formatters: {
            custom: {
              command: ['fmt', '--width', '$PI_FORMAT_TEST_WIDTH', '$FILE'],
              extensions: ['.md'],
            },
          },
        })
      );
      const config = await getFormatConfig(cwdDir);
      expect(config.formatters.custom?.command).toEqual([
        'fmt',
        '--width',
        '$PI_FORMAT_TEST_WIDTH',
        '$FILE',
      ]);
    } finally {
      delete process.env.PI_FORMAT_TEST_WIDTH;
    }
  });

  it('skips invalid formatter entries and keeps valid siblings', async () => {
    writeProjectSettings(
      JSON.stringify({
        formatters: {
          bad: {
            command: ['fmt', '$FILE'],
            extensions: [],
          },
          good: {
            command: ['fmt', '$FILE'],
            extensions: ['.txt'],
          },
        },
      })
    );
    const config = await getFormatConfig(cwdDir);
    expect(config.formatters.bad).toBeUndefined();
    expect(config.formatters.good).toBeDefined();
  });

  it('supports JSONC trailing commas', async () => {
    writeProjectSettings(`{
      "formatters": {
        "custom": {
          "command": ["fmt", "$FILE",],
          "extensions": [".ts",],
        },
      },
    }`);
    const config = await getFormatConfig(cwdDir);
    expect(config.formatters.custom?.command).toEqual(['fmt', '$FILE']);
  });

  it('falls back to default when enabled is not a boolean', async () => {
    writeProjectSettings(JSON.stringify({ enabled: 'false' }));
    const config = await getFormatConfig(cwdDir);
    expect(config.enabled).toBe(true);
  });

  it('falls back to default when formatOnWrite is not a boolean', async () => {
    writeProjectSettings(JSON.stringify({ formatOnWrite: 'no' }));
    const config = await getFormatConfig(cwdDir);
    expect(config.formatOnWrite).toBe(true);
  });

  it('skips formatters with empty names', async () => {
    writeProjectSettings(
      JSON.stringify({
        formatters: {
          '': { command: ['fmt', '$FILE'], extensions: ['.ts'] },
          good: { command: ['fmt', '$FILE'], extensions: ['.ts'] },
        },
      })
    );
    const config = await getFormatConfig(cwdDir);
    expect(config.formatters['']).toBeUndefined();
    expect(config.formatters.good).toBeDefined();
  });
});

describe('normalizeExtension', () => {
  it('lowercases an extension with a leading dot', () => {
    expect(normalizeExtension('.TS')).toBe('.ts');
    expect(normalizeExtension('  .TS  ')).toBe('.ts');
  });

  it('returns undefined when the extension lacks a leading dot', () => {
    expect(normalizeExtension('ts')).toBeUndefined();
    expect(normalizeExtension('')).toBeUndefined();
  });
});

describe('normalizeFormatterConfig', () => {
  it('rejects commands without $FILE', () => {
    const result = normalizeFormatterConfig('bad', {
      command: ['fmt'],
      extensions: ['.ts'],
    });
    expect(result).toBeUndefined();
  });

  it('rejects empty command arrays', () => {
    const result = normalizeFormatterConfig('bad', {
      command: [],
      extensions: ['.ts'],
    });
    expect(result).toBeUndefined();
  });

  it('rejects empty extension arrays', () => {
    const result = normalizeFormatterConfig('bad', {
      command: ['fmt', '$FILE'],
      extensions: [],
    });
    expect(result).toBeUndefined();
  });

  it('rejects extensions without a leading dot', () => {
    const result = normalizeFormatterConfig('bad', {
      command: ['fmt', '$FILE'],
      extensions: ['ts'],
    });
    expect(result).toBeUndefined();
  });

  it('applies defaults for optional fields', () => {
    const result = normalizeFormatterConfig('good', {
      command: ['fmt', '$FILE'],
      extensions: ['.ts'],
    });
    expect(result).toBeDefined();
    expect(result?.disabled).toBe(false);
    expect(result?.timeoutMs).toBe(30_000);
  });
});
