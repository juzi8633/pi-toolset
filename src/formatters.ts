// ABOUTME: Formats LSP responses into human-readable text for the agent.
// ABOUTME: Port of Claude Code's LSPTool formatters (Phase 1: definition / references / hover).

import { relative } from 'node:path';
import type {
  Hover,
  Location,
  LocationLink,
  MarkedString,
  MarkupContent,
} from 'vscode-languageserver-types';
import { errorMessage, logForDebugging } from './log.ts';

/**
 * Formats a URI by converting it to a relative path if possible.
 * Handles URI decoding and gracefully falls back to un-decoded path if malformed.
 * Only uses relative paths when shorter and not starting with ../../
 */
function formatUri(uri: string | undefined, cwd?: string): string {
  // Handle undefined/null URIs - this indicates malformed LSP data
  if (!uri) {
    logForDebugging(
      'formatUri called with undefined URI - indicates malformed LSP server response',
      { level: 'warn' }
    );
    return '<unknown location>';
  }

  // Remove file:// protocol if present.
  // On Windows, file:///C:/path becomes /C:/path after replacing file://
  // We need to strip the leading slash for Windows drive-letter paths.
  let filePath = uri.replace(/^file:\/\//, '');
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1);
  }

  // Decode URI encoding - handle malformed URIs gracefully
  try {
    filePath = decodeURIComponent(filePath);
  } catch (error) {
    logForDebugging(
      `Failed to decode LSP URI '${uri}': ${errorMessage(error)}. Using un-decoded path: ${filePath}`,
      { level: 'warn' }
    );
    // filePath already contains the un-decoded path, which is still usable
  }

  // Convert to relative path if cwd is provided
  if (cwd) {
    // Normalize separators to forward slashes for consistent display output
    const relativePath = relative(cwd, filePath).replaceAll('\\', '/');
    // Only use relative path if it's shorter and doesn't start with ../..
    if (relativePath.length < filePath.length && !relativePath.startsWith('../../')) {
      return relativePath;
    }
  }

  // Normalize separators to forward slashes for consistent display output
  return filePath.replaceAll('\\', '/');
}

/**
 * Groups items by their file URI.
 * Generic helper that works with both Location[] and SymbolInformation[].
 */
function groupByFile<T extends { uri: string } | { location: { uri: string } }>(
  items: T[],
  cwd?: string
): Map<string, T[]> {
  const byFile = new Map<string, T[]>();
  for (const item of items) {
    const uri = 'uri' in item ? item.uri : item.location.uri;
    const filePath = formatUri(uri, cwd);
    const existingItems = byFile.get(filePath);
    if (existingItems) {
      existingItems.push(item);
    } else {
      byFile.set(filePath, [item]);
    }
  }
  return byFile;
}

/**
 * Formats a Location with file path and line/character position.
 */
function formatLocation(location: Location, cwd?: string): string {
  const filePath = formatUri(location.uri, cwd);
  const line = location.range.start.line + 1; // Convert to 1-based
  const character = location.range.start.character + 1; // Convert to 1-based
  return `${filePath}:${line}:${character}`;
}

/**
 * Converts LocationLink to Location format for consistent handling.
 */
function locationLinkToLocation(link: LocationLink): Location {
  return {
    uri: link.targetUri,
    range: link.targetSelectionRange || link.targetRange,
  };
}

/**
 * Checks if an object is a LocationLink (has targetUri) vs Location (has uri).
 */
function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return 'targetUri' in item;
}

/**
 * Formats goToDefinition result.
 * Can return Location, LocationLink, or arrays of either.
 */
export function formatGoToDefinitionResult(
  result: Location | Location[] | LocationLink | LocationLink[] | null,
  cwd?: string
): string {
  if (!result) {
    return 'No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.';
  }

  if (Array.isArray(result)) {
    // Convert LocationLinks to Locations for uniform handling
    const locations: Location[] = result.map((item) =>
      isLocationLink(item) ? locationLinkToLocation(item) : item
    );

    const invalidLocations = locations.filter((loc) => !loc || !loc.uri);
    if (invalidLocations.length > 0) {
      logForDebugging(
        `formatGoToDefinitionResult: Filtering out ${invalidLocations.length} invalid location(s) - this should have been caught earlier`,
        { level: 'warn' }
      );
    }

    const validLocations = locations.filter((loc) => loc && loc.uri);

    if (validLocations.length === 0) {
      return 'No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.';
    }
    if (validLocations.length === 1) {
      return `Defined in ${formatLocation(validLocations[0]!, cwd)}`;
    }
    const locationList = validLocations.map((loc) => `  ${formatLocation(loc, cwd)}`).join('\n');
    return `Found ${validLocations.length} definitions:\n${locationList}`;
  }

  // Single result - convert LocationLink if needed
  const location = isLocationLink(result) ? locationLinkToLocation(result) : result;
  return `Defined in ${formatLocation(location, cwd)}`;
}

/**
 * Formats findReferences result.
 */
export function formatFindReferencesResult(result: Location[] | null, cwd?: string): string {
  if (!result || result.length === 0) {
    return 'No references found. This may occur if the symbol has no usages, or if the LSP server has not fully indexed the workspace.';
  }

  const invalidLocations = result.filter((loc) => !loc || !loc.uri);
  if (invalidLocations.length > 0) {
    logForDebugging(
      `formatFindReferencesResult: Filtering out ${invalidLocations.length} invalid location(s) - this should have been caught earlier`,
      { level: 'warn' }
    );
  }

  const validLocations = result.filter((loc) => loc && loc.uri);

  if (validLocations.length === 0) {
    return 'No references found. This may occur if the symbol has no usages, or if the LSP server has not fully indexed the workspace.';
  }

  if (validLocations.length === 1) {
    return `Found 1 reference:\n  ${formatLocation(validLocations[0]!, cwd)}`;
  }

  // Group references by file
  const byFile = groupByFile(validLocations, cwd);

  const lines: string[] = [
    `Found ${validLocations.length} references across ${byFile.size} files:`,
  ];

  for (const [filePath, locations] of byFile) {
    lines.push(`\n${filePath}:`);
    for (const loc of locations) {
      const line = loc.range.start.line + 1;
      const character = loc.range.start.character + 1;
      lines.push(`  Line ${line}:${character}`);
    }
  }

  return lines.join('\n');
}

/**
 * Extracts text content from MarkupContent or MarkedString.
 */
function extractMarkupText(contents: MarkupContent | MarkedString | MarkedString[]): string {
  if (Array.isArray(contents)) {
    return contents
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        return item.value;
      })
      .join('\n\n');
  }

  if (typeof contents === 'string') {
    return contents;
  }

  if ('kind' in contents) {
    // MarkupContent
    return contents.value;
  }

  // MarkedString object
  return contents.value;
}

/**
 * Formats hover result.
 */
export function formatHoverResult(result: Hover | null, _cwd?: string): string {
  if (!result) {
    return 'No hover information available. This may occur if the cursor is not on a symbol, or if the LSP server has not fully indexed the file.';
  }

  const content = extractMarkupText(result.contents);

  if (result.range) {
    const line = result.range.start.line + 1;
    const character = result.range.start.character + 1;
    return `Hover info at ${line}:${character}:\n\n${content}`;
  }

  return content;
}
