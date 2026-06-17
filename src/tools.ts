// ABOUTME: Registers the `lsp` tool (Phase 1: goToDefinition, findReferences, hover).
// ABOUTME: Ports Claude Code's LSPTool.call flow onto Pi's registerTool API.

import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringEnum, Type } from '@earendil-works/pi-ai';
import type { Static } from '@earendil-works/pi-ai';
import { truncateTail } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Hover, Location, LocationLink } from 'vscode-languageserver-types';
import {
  formatFindReferencesResult,
  formatGoToDefinitionResult,
  formatHoverResult,
} from './formatters.ts';
import { errorMessage, logError } from './log.ts';
import { getManager, isLspConnected, waitForInitialization } from './manager.ts';
import type { LspToolDetails } from './types.ts';

const MAX_LSP_FILE_SIZE_BYTES = 10_000_000;

const PARAMETERS = Type.Object({
  operation: StringEnum(['goToDefinition', 'findReferences', 'hover'], {
    description: 'The LSP operation to perform.',
  }),
  filePath: Type.String({
    description: 'The absolute or relative path to the file.',
  }),
  line: Type.Number({
    description: 'The line number (1-based, as shown in editors).',
  }),
  character: Type.Number({
    description: 'The character offset (1-based, as shown in editors).',
  }),
});

type Params = Static<typeof PARAMETERS>;

const DESCRIPTION = `Query Language Server Protocol (LSP) servers for code intelligence.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (type signature, documentation) for a symbol

All operations require:
- filePath: The file to operate on
- line: The line number (1-based, as shown in editors)
- character: The character offset (1-based, as shown in editors)

An LSP server must be configured for the file type. If no server is available, a message is returned instead of results.`;

export function registerLspTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof PARAMETERS, LspToolDetails>({
    name: 'lsp',
    label: 'LSP',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return runLsp(params, ctx.cwd);
    },
  });
}

async function runLsp(params: Params, cwd: string): Promise<AgentToolResult<LspToolDetails>> {
  // Wait for any in-flight initialization, then verify a server is connected.
  await waitForInitialization();
  if (!isLspConnected()) {
    return textResult(
      'LSP server is not ready. It may still be starting, or no server is configured for this file type.',
      params,
      { ready: false }
    );
  }

  const manager = getManager();
  if (!manager) {
    return textResult('LSP server manager is not initialized.', params);
  }

  const absolutePath = path.resolve(cwd, params.filePath);

  // SECURITY: skip filesystem stat for UNC paths to avoid NTLM credential leaks.
  const isUnc = absolutePath.startsWith('\\\\') || absolutePath.startsWith('//');

  if (!isUnc) {
    let stats;
    try {
      stats = await stat(absolutePath);
    } catch (error) {
      if (isENOENT(error)) {
        return textResult(`File does not exist: ${params.filePath}`, params);
      }
      return textResult(`Cannot access file: ${params.filePath}. ${errorMessage(error)}`, params);
    }
    if (!stats.isFile()) {
      return textResult(`Path is not a file: ${params.filePath}`, params);
    }
    if (stats.size > MAX_LSP_FILE_SIZE_BYTES) {
      return textResult(
        `File too large for LSP analysis (${Math.ceil(stats.size / 1_000_000)}MB exceeds 10MB limit)`,
        params
      );
    }
  }

  try {
    // Ensure the file is open in the LSP server before making requests.
    // Most servers require textDocument/didOpen before operations.
    if (!manager.isFileOpen(absolutePath)) {
      const content = await readFile(absolutePath, { encoding: 'utf-8' });
      await manager.openFile(absolutePath, content);
    }

    const { method, params: lspParams } = getMethodAndParams(params, absolutePath);

    const result = await manager.sendRequest(absolutePath, method, lspParams);
    if (result === undefined) {
      return textResult(
        `No LSP server available for file type: ${path.extname(absolutePath)}`,
        params
      );
    }

    const { formatted, resultCount, fileCount } = formatResult(params.operation, result, cwd);

    const truncation = truncateTail(formatted);
    const text = truncation.truncated
      ? `${truncation.content}\n\n[Output truncated]`
      : truncation.content;

    return {
      content: [{ type: 'text', text }],
      details: {
        operation: params.operation,
        filePath: params.filePath,
        resultCount,
        fileCount,
        truncated: truncation.truncated,
      },
    };
  } catch (error) {
    logError(
      new Error(
        `LSP tool request failed for ${params.operation} on ${params.filePath}: ${errorMessage(error)}`
      )
    );
    return textResult(`Error performing ${params.operation}: ${errorMessage(error)}`, params);
  }
}

/**
 * Maps an operation to its LSP method and params, converting the 1-based
 * editor position to the 0-based LSP protocol position.
 */
function getMethodAndParams(
  params: Params,
  absolutePath: string
): { method: string; params: unknown } {
  const uri = pathToFileURL(absolutePath).href;
  const position = {
    line: params.line - 1,
    character: params.character - 1,
  };

  if (params.operation === 'findReferences') {
    return {
      method: 'textDocument/references',
      params: {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
      },
    };
  }
  if (params.operation === 'hover') {
    return {
      method: 'textDocument/hover',
      params: { textDocument: { uri }, position },
    };
  }
  // goToDefinition
  return {
    method: 'textDocument/definition',
    params: { textDocument: { uri }, position },
  };
}

/**
 * Formats an LSP result and extracts summary counts.
 */
function formatResult(
  operation: Params['operation'],
  result: unknown,
  cwd: string
): { formatted: string; resultCount: number; fileCount: number } {
  if (operation === 'findReferences') {
    const locations = (result as Location[]) || [];
    const validLocations = locations.filter((loc) => loc && loc.uri);
    return {
      formatted: formatFindReferencesResult(result as Location[] | null, cwd),
      resultCount: validLocations.length,
      fileCount: countUniqueFiles(validLocations),
    };
  }
  if (operation === 'hover') {
    return {
      formatted: formatHoverResult(result as Hover | null, cwd),
      resultCount: result ? 1 : 0,
      fileCount: result ? 1 : 0,
    };
  }
  // goToDefinition
  const rawResults = Array.isArray(result)
    ? result
    : result
      ? [result as Location | LocationLink]
      : [];
  const locations = rawResults.map(toLocation);
  const validLocations = locations.filter((loc) => loc && loc.uri);
  return {
    formatted: formatGoToDefinitionResult(
      result as Location | Location[] | LocationLink | LocationLink[] | null,
      cwd
    ),
    resultCount: validLocations.length,
    fileCount: countUniqueFiles(validLocations),
  };
}

function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return 'targetUri' in item;
}

function toLocation(item: Location | LocationLink): Location {
  if (isLocationLink(item)) {
    return {
      uri: item.targetUri,
      range: item.targetSelectionRange || item.targetRange,
    };
  }
  return item;
}

function countUniqueFiles(locations: Location[]): number {
  return new Set(locations.map((loc) => loc.uri)).size;
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function textResult(
  text: string,
  params: Params,
  extra?: Partial<LspToolDetails>
): AgentToolResult<LspToolDetails> {
  return {
    content: [{ type: 'text', text }],
    details: {
      operation: params.operation,
      filePath: params.filePath,
      ...extra,
    },
  };
}
