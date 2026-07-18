// ABOUTME: Chain task template expansion — substitutes {previous}, {outputs.<name>}, and {item} placeholders.
// ABOUTME: Returns ok=false with the unknown name when the template references a missing output.

import { formatChildArtifactDescriptor } from './result-payload.ts';
import type { ChainOutputEntry } from './types.ts';

export interface TemplateContext {
  previous: string;
  outputs: Map<string, ChainOutputEntry>;
  item?: unknown;
  /** Optional previous text ref when previous is a descriptor handoff. */
  previousRef?: ChainOutputEntry['textRef'];
}

export type TemplateResult =
  { ok: true; text: string; requiresArtifactReader?: boolean } | { ok: false; unknown: string };

const TOKEN_RE = /\{(previous|item|outputs\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*))\}/g;

function renderItem(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function renderTaskTemplate(template: string, context: TemplateContext): TemplateResult {
  let unknown: string | undefined;
  let requiresArtifactReader = false;
  const replaced = template.replace(TOKEN_RE, (_match, full: string, name?: string) => {
    if (full === 'previous') {
      if (context.previousRef) {
        requiresArtifactReader = true;
        return formatChildArtifactDescriptor(context.previousRef);
      }
      return context.previous;
    }
    if (full === 'item') {
      if (!('item' in context)) {
        if (unknown === undefined) unknown = 'item';
        return _match;
      }
      return renderItem(context.item);
    }
    if (typeof name === 'string') {
      const entry = context.outputs.get(name);
      if (!entry) {
        if (unknown === undefined) unknown = name;
        return _match;
      }
      if (entry.textRef) {
        requiresArtifactReader = true;
        return formatChildArtifactDescriptor(entry.textRef);
      }
      return entry.text ?? '';
    }
    return _match;
  });
  if (unknown !== undefined) {
    return { ok: false, unknown };
  }
  return {
    ok: true,
    text: replaced,
    ...(requiresArtifactReader ? { requiresArtifactReader: true } : {}),
  };
}
