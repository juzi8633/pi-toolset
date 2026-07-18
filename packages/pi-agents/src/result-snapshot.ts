// ABOUTME: Builds compact, idempotent, mutation-isolated SingleResult snapshots for parent delivery.
// ABOUTME: Projects assistant presentation, bounds non-authoritative fields, and freezes snapshot payloads.

import {
  RESULT_DIAGNOSTIC_MAX_BYTES,
  RESULT_PRESENTATION_ITEM_MAX_BYTES,
  RESULT_PRESENTATION_MAX_BYTES,
  PRESENTATION_NAME_TRUNC_CHARS,
} from './constants.ts';
import { getLatestActivity, getResultFinalOutput, getTranscriptAndFinal } from './output.ts';
import type { DisplayItem, ResultPresentation, SingleResult } from './types.ts';

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function jsonUtf8Bytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

/** Back off from `index` so the slice end does not split a surrogate pair. */
function endOnCodePoint(value: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= value.length) return value.length;
  // If index points at a low surrogate, include it (pair starts at index-1).
  // If the previous code unit is a high surrogate and index is mid-pair, step back.
  const prev = value.charCodeAt(index - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) return index - 1;
  return index;
}

/** Advance from `index` so the slice start does not split a surrogate pair. */
function startOnCodePoint(value: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= value.length) return value.length;
  const code = value.charCodeAt(index);
  if (code >= 0xdc00 && code <= 0xdfff) return index + 1;
  return index;
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes (prefix), on a code-point boundary. */
function truncateUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(value) <= maxBytes) return value;
  let lo = 0;
  let hi = value.length;
  let best = 0;
  while (lo <= hi) {
    const raw = Math.floor((lo + hi) / 2);
    const mid = endOnCodePoint(value, raw);
    if (utf8Bytes(value.slice(0, mid)) <= maxBytes) {
      best = mid;
      lo = raw + 1;
    } else {
      hi = raw - 1;
    }
  }
  return value.slice(0, endOnCodePoint(value, best));
}

/** Truncate a string keeping the tail within `maxBytes` UTF-8 bytes, on a code-point boundary. */
function truncateUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(value) <= maxBytes) return value;
  let lo = 0;
  let hi = value.length;
  let bestStart = value.length;
  while (lo <= hi) {
    const raw = Math.floor((lo + hi) / 2);
    const mid = startOnCodePoint(value, raw);
    if (utf8Bytes(value.slice(mid)) <= maxBytes) {
      bestStart = mid;
      // Try a longer tail (smaller start index).
      hi = raw - 1;
    } else {
      lo = raw + 1;
    }
  }
  return value.slice(startOnCodePoint(value, bestStart));
}

/** Module-private ownership of presentation/structured payloads created here. */
const snapshotOwnedPayloads = new WeakSet<object>();

function markSnapshotOwned<T extends object>(value: T): T {
  snapshotOwnedPayloads.add(value);
  return value;
}

function isSnapshotOwnedPayload(value: unknown): boolean {
  return typeof value === 'object' && value !== null && snapshotOwnedPayloads.has(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

function textItemFits(text: string): boolean {
  return jsonUtf8Bytes({ type: 'text', text }) <= RESULT_PRESENTATION_ITEM_MAX_BYTES;
}

function boundTextItem(text: string): DisplayItem {
  if (textItemFits(text)) return { type: 'text', text };

  const originalBytes = utf8Bytes(text);
  const markerFor = (omitted: number) =>
    `\n\n[Transcript item truncated: ${omitted} bytes omitted]`;

  // Binary-search the largest prefix such that prefix + marker fits the item budget.
  let lo = 0;
  let hi = originalBytes;
  let best: string | undefined;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const aligned = truncateUtf8Prefix(text, mid);
    const omitted = originalBytes - utf8Bytes(aligned);
    const marked = `${aligned}${markerFor(omitted)}`;
    if (textItemFits(marked)) {
      best = marked;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best !== undefined) return { type: 'text', text: best };

  // Extremely tight budget: marker-only fallback.
  let omitted = originalBytes;
  for (;;) {
    const marked = `[Transcript item truncated: ${omitted} bytes omitted]`;
    if (textItemFits(marked) || omitted === 0) return { type: 'text', text: marked };
    omitted = Math.floor(omitted / 2);
  }
}

function boundToolCallItem(name: string, args: Record<string, unknown>): DisplayItem {
  // Size-check the source args without cloning first so large payloads are never duplicated.
  const fullSize = jsonUtf8Bytes({ type: 'toolCall', name, args });
  if (fullSize <= RESULT_PRESENTATION_ITEM_MAX_BYTES) {
    return { type: 'toolCall', name, args: structuredClone(args) };
  }

  const originalBytes = jsonUtf8Bytes(args);
  const candidates: DisplayItem[] = [
    {
      type: 'toolCall',
      name,
      args: {
        _omitted: true,
        omittedBytes: originalBytes,
        message:
          'Tool-call arguments exceeded the presentation budget. Inspect the child session history for the full payload.',
      },
    },
    {
      type: 'toolCall',
      name: name.slice(0, PRESENTATION_NAME_TRUNC_CHARS),
      args: {
        _omitted: true,
        omittedBytes: originalBytes,
        message: 'Tool-call arguments omitted; inspect child session history.',
      },
    },
    {
      type: 'toolCall',
      name: 'tool',
      args: { _omitted: true, omittedBytes: originalBytes },
    },
  ];

  for (const candidate of candidates) {
    if (jsonUtf8Bytes(candidate) <= RESULT_PRESENTATION_ITEM_MAX_BYTES) return candidate;
  }
  return candidates[candidates.length - 1]!;
}

function boundDisplayItem(item: DisplayItem): DisplayItem {
  if (item.type === 'text') return boundTextItem(item.text);
  return boundToolCallItem(item.name, item.args);
}

function isTextIdenticalToFinal(item: DisplayItem, finalOutput: string): boolean {
  return item.type === 'text' && item.text === finalOutput;
}

/**
 * Keep the newest presentation items whose complete UTF-8 JSON representation
 * (including explicit latest activity) fits the total presentation budget.
 * Uses a reverse size pass so fitting is linear in item count.
 */
function fitPresentation(
  transcript: DisplayItem[],
  latestActivity: DisplayItem | undefined,
  finalOutput: string,
  priorOmitted = 0
): ResultPresentation {
  // De-duplication uses the pre-bound identity; callers must pass latest only when it differs.
  const explicitLatest =
    latestActivity && !isTextIdenticalToFinal(latestActivity, finalOutput)
      ? latestActivity
      : undefined;

  const itemJsonSizes = transcript.map((item) => jsonUtf8Bytes(item));
  const latestSize = explicitLatest ? jsonUtf8Bytes(explicitLatest) : 0;

  // Empty presentation JSON overhead: `{"transcript":[]}` = 16 bytes; with truncation fields more.
  // Compute exactly by building candidates only for the chosen suffix.
  const build = (
    items: DisplayItem[],
    latest: DisplayItem | undefined,
    omitted: number
  ): ResultPresentation => {
    if (omitted > 0) {
      return {
        transcript: items,
        ...(latest ? { latestActivity: latest } : {}),
        truncated: true,
        omittedItems: omitted,
      };
    }
    return {
      transcript: items,
      ...(latest ? { latestActivity: latest } : {}),
    };
  };

  // Fast path: full set fits.
  let candidate = build(transcript, explicitLatest, priorOmitted);
  if (jsonUtf8Bytes(candidate) <= RESULT_PRESENTATION_MAX_BYTES) return candidate;

  // Reverse pass: accumulate newest items until adding another would exceed budget.
  // Estimate by summing item JSON sizes plus a generous object overhead, then verify exactly.
  const OVERHEAD_BUDGET = 256; // braces, keys, commas, truncation fields, latestActivity key
  const budgetForItems = RESULT_PRESENTATION_MAX_BYTES - latestSize - OVERHEAD_BUDGET;

  let used = 0;
  let start = transcript.length;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const size = itemJsonSizes[i]! + (i < transcript.length - 1 || explicitLatest ? 1 : 0); // comma
    if (used + size > budgetForItems && start < transcript.length) break;
    if (used + size > budgetForItems) break;
    used += size;
    start = i;
  }

  // Verify and back off if estimate was optimistic.
  for (;;) {
    const retained = transcript.slice(start);
    const omitted = priorOmitted + start;
    candidate = build(retained, explicitLatest, Math.max(1, omitted));
    if (jsonUtf8Bytes(candidate) <= RESULT_PRESENTATION_MAX_BYTES) return candidate;
    if (start >= transcript.length) break;
    start += 1;
  }

  // Drop latestActivity if it alone (with empty transcript) still overflows after estimate.
  if (explicitLatest) {
    const omitted = priorOmitted + transcript.length + 1;
    candidate = build([], undefined, Math.max(1, omitted));
    if (jsonUtf8Bytes(candidate) <= RESULT_PRESENTATION_MAX_BYTES) return candidate;
  }

  return {
    transcript: [],
    truncated: true,
    omittedItems: Math.max(1, priorOmitted + transcript.length + (latestActivity ? 1 : 0)),
  };
}

function boundDiagnosticPrefix(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const original = utf8Bytes(value);
  if (original <= RESULT_DIAGNOSTIC_MAX_BYTES) return value;

  const markerFor = (omitted: number) => `\n\n[${label} truncated: ${omitted} bytes omitted]`;
  let lo = 0;
  let hi = original;
  let best: string | undefined;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const prefix = truncateUtf8Prefix(value, mid);
    const omitted = original - utf8Bytes(prefix);
    const marked = `${prefix}${markerFor(omitted)}`;
    if (utf8Bytes(marked) <= RESULT_DIAGNOSTIC_MAX_BYTES) {
      best = marked;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best !== undefined) return best;
  return truncateUtf8Prefix(
    `[${label} truncated: ${original} bytes omitted]`,
    RESULT_DIAGNOSTIC_MAX_BYTES
  );
}

function boundDiagnosticTail(value: string, label: string): string {
  const original = utf8Bytes(value);
  if (original <= RESULT_DIAGNOSTIC_MAX_BYTES) return value;

  const markerFor = (omitted: number) => `[${label} truncated: ${omitted} bytes omitted]\n\n`;
  let lo = 0;
  let hi = original;
  let best: string | undefined;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const tail = truncateUtf8Tail(value, mid);
    const omitted = original - utf8Bytes(tail);
    const marked = `${markerFor(omitted)}${tail}`;
    if (utf8Bytes(marked) <= RESULT_DIAGNOSTIC_MAX_BYTES) {
      best = marked;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best !== undefined) return best;
  return truncateUtf8Tail(
    `[${label} truncated: ${original} bytes omitted]`,
    RESULT_DIAGNOSTIC_MAX_BYTES
  );
}

/** True when a result is already a snapshot-owned compact payload safe to share. */
function isSnapshotOwnedCompact(result: SingleResult): boolean {
  if (result.messages.length !== 0 || result.presentation === undefined) return false;
  // Ownership, not external freeze, authorizes the fast path.
  if (!isSnapshotOwnedPayload(result.presentation)) return false;
  // Primitive / null structuredOutput cannot be WeakSet-owned; only objects need ownership.
  if (
    result.structuredOutput !== undefined &&
    result.structuredOutput !== null &&
    typeof result.structuredOutput === 'object' &&
    !isSnapshotOwnedPayload(result.structuredOutput)
  ) {
    return false;
  }
  return true;
}

/** Re-apply diagnostic caps so mutated shell strings cannot bypass the 64 KiB bound. */
function rebindDiagnostics(result: SingleResult): {
  stderr: string;
  errorMessage: string | undefined;
  errorStack: string | undefined;
} {
  return {
    stderr: boundDiagnosticTail(result.stderr ?? '', 'stderr'),
    errorMessage: boundDiagnosticPrefix(result.errorMessage, 'errorMessage'),
    errorStack: boundDiagnosticPrefix(result.errorStack, 'errorStack'),
  };
}

/**
 * Internal owned-shell copier. Caller must guarantee snapshot-owned presentation
 * (and object structuredOutput when present). Always re-bounds diagnostics.
 */
function copyOwnedSnapshotShell(result: SingleResult): SingleResult {
  const diagnostics = rebindDiagnostics(result);
  return {
    ...result,
    messages: [],
    usage: { ...result.usage },
    fanout: result.fanout ? { ...result.fanout } : undefined,
    worktreeChangedFiles: result.worktreeChangedFiles
      ? [...result.worktreeChangedFiles]
      : undefined,
    presentation: result.presentation,
    structuredOutput: result.structuredOutput,
    stderr: diagnostics.stderr,
    errorMessage: diagnostics.errorMessage,
    errorStack: diagnostics.errorStack,
  };
}

/**
 * Create a new top-level result shell for aggregate delivery.
 * Shares presentation/structuredOutput only when snapshot-owned; otherwise reprojects
 * through `snapshotSingleResult()`. Always re-bounds diagnostic strings.
 */
export function copySnapshotShell(result: SingleResult): SingleResult {
  if (isSnapshotOwnedCompact(result)) {
    return copyOwnedSnapshotShell(result);
  }
  // Unowned / external frozen compact-looking shells must be fully reprojected.
  return snapshotSingleResult(result);
}

interface DerivedPresentation {
  finalOutput: string;
  /** Unbounded source items (may share arg object refs with the source). */
  transcript: DisplayItem[];
  /** Unbounded latest activity before de-duplication / bounding. */
  latestActivity: DisplayItem | undefined;
  priorOmitted: number;
}

function deriveSourcePresentation(result: SingleResult): DerivedPresentation {
  const finalOutput = getResultFinalOutput(result);

  if (result.presentation) {
    // Shallow item refs only — boundDisplayItem clones retained payloads.
    const transcript = result.presentation.transcript.map((item) =>
      item.type === 'text'
        ? { type: 'text' as const, text: item.text }
        : { type: 'toolCall' as const, name: item.name, args: item.args }
    );
    let latestActivity: DisplayItem | undefined;
    if (result.presentation.latestActivity) {
      const latest = result.presentation.latestActivity;
      latestActivity =
        latest.type === 'text'
          ? { type: 'text', text: latest.text }
          : { type: 'toolCall', name: latest.name, args: latest.args };
    } else if (result.finalOutput !== undefined) {
      // Reconstruct de-duplicated latest text so de-dup can re-apply before bounding.
      latestActivity = { type: 'text', text: finalOutput };
    }
    const priorOmitted =
      'truncated' in result.presentation && result.presentation.truncated
        ? result.presentation.omittedItems
        : 0;
    return { finalOutput, transcript, latestActivity, priorOmitted };
  }

  const derived = getTranscriptAndFinal(result.messages);
  const resolvedFinal = result.finalOutput !== undefined ? result.finalOutput : derived.finalOutput;
  const latest = getLatestActivity(result.messages);
  return {
    finalOutput: resolvedFinal,
    // Shallow items: text is immutable string; tool args keep source ref until size-checked.
    transcript: derived.transcript.map((item) =>
      item.type === 'text'
        ? { type: 'text' as const, text: item.text }
        : { type: 'toolCall' as const, name: item.name, args: item.args }
    ),
    latestActivity: latest
      ? latest.type === 'text'
        ? { type: 'text', text: latest.text }
        : { type: 'toolCall', name: latest.name, args: latest.args }
      : undefined,
    priorOmitted: 0,
  };
}

/**
 * Convert a mutable live or legacy result into a compact, frozen presentation snapshot.
 * Excludes raw child tool-result bodies. Idempotent for snapshot-owned compact results.
 */
export function snapshotSingleResult(result: SingleResult): SingleResult {
  // Use the private owned copier (not the public entry) to avoid recursion.
  if (isSnapshotOwnedCompact(result)) {
    return copyOwnedSnapshotShell(result);
  }

  const { finalOutput, transcript, latestActivity, priorOmitted } =
    deriveSourcePresentation(result);

  // Decide de-duplication against the original latest text BEFORE per-item bounding,
  // so an oversized final text does not reappear as a truncated latestActivity marker.
  const keepLatest =
    latestActivity !== undefined && !isTextIdenticalToFinal(latestActivity, finalOutput)
      ? latestActivity
      : undefined;

  const boundedTranscript = transcript.map(boundDisplayItem);
  const boundedLatest = keepLatest ? boundDisplayItem(keepLatest) : undefined;
  const presentation = markSnapshotOwned(
    deepFreeze(fitPresentation(boundedTranscript, boundedLatest, finalOutput, priorOmitted))
  );

  let structuredOutput: SingleResult['structuredOutput'];
  let structuredOutputRef: SingleResult['structuredOutputRef'];
  if (result.structuredOutputRef) {
    // Copy ref shell without resolving or cloning payload.
    structuredOutputRef = { ...result.structuredOutputRef };
    structuredOutput = undefined;
  } else if (result.structuredOutput !== undefined) {
    const cloned = structuredClone(result.structuredOutput);
    structuredOutput =
      cloned !== null && typeof cloned === 'object'
        ? (markSnapshotOwned(deepFreeze(cloned)) as SingleResult['structuredOutput'])
        : cloned;
  }

  const diagnostics = rebindDiagnostics(result);
  const snap: SingleResult = {
    ...result,
    messages: [],
    presentation,
    usage: { ...result.usage },
    fanout: result.fanout ? { ...result.fanout } : undefined,
    worktreeChangedFiles: result.worktreeChangedFiles
      ? [...result.worktreeChangedFiles]
      : undefined,
    stderr: diagnostics.stderr,
    errorMessage: diagnostics.errorMessage,
    errorStack: diagnostics.errorStack,
  };
  // Own-property mutual exclusion: never leave both inline and ref keys present.
  delete snap.finalOutput;
  delete snap.finalOutputRef;
  delete snap.structuredOutput;
  delete snap.structuredOutputRef;
  if (result.finalOutputRef) {
    snap.finalOutputRef = { ...result.finalOutputRef };
  } else {
    snap.finalOutput = finalOutput;
  }
  if (structuredOutputRef) {
    snap.structuredOutputRef = structuredOutputRef;
  } else if (structuredOutput !== undefined) {
    snap.structuredOutput = structuredOutput;
  }
  return snap;
}

/**
 * Running/provisional snapshot: strips all authoritative inline values and refs.
 * Retains only bounded presentation, diagnostics, usage, identity, and status.
 */
export function snapshotProvisionalResult(result: SingleResult): SingleResult {
  const base = snapshotSingleResult(result);
  const finalText = base.finalOutput;
  const provisional: SingleResult = {
    ...base,
    messages: [],
  };
  delete provisional.finalOutput;
  delete provisional.finalOutputRef;
  delete provisional.structuredOutput;
  delete provisional.structuredOutputRef;
  // snapshotSingleResult de-duplicates final text out of transcript into finalOutput.
  // After stripping finalOutput, restore it as latestActivity so parent UI still sees it.
  if (
    typeof finalText === 'string' &&
    finalText.length > 0 &&
    provisional.presentation &&
    !provisional.presentation.latestActivity
  ) {
    const hasText = provisional.presentation.transcript.some(
      (i) => i.type === 'text' && i.text === finalText
    );
    if (!hasText) {
      provisional.presentation = markSnapshotOwned(
        deepFreeze({
          ...provisional.presentation,
          latestActivity: { type: 'text' as const, text: finalText },
        })
      );
    }
  }
  return provisional;
}

export function snapshotResults(results: SingleResult[]): SingleResult[] {
  return results.map(snapshotSingleResult);
}
