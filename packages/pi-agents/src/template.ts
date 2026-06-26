// ABOUTME: Chain task template expansion — substitutes {previous} and {outputs.<name>} placeholders.
// ABOUTME: Returns ok=false with the unknown name when the template references a missing output.

export interface TemplateContext {
  previous: string;
  outputs: Map<string, string>;
}

export type TemplateResult = { ok: true; text: string } | { ok: false; unknown: string };

const TOKEN_RE = /\{(previous|outputs\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*))\}/g;

export function renderTaskTemplate(template: string, context: TemplateContext): TemplateResult {
  let unknown: string | undefined;
  const replaced = template.replace(TOKEN_RE, (_match, full: string, name?: string) => {
    if (full === 'previous') return context.previous;
    if (typeof name === 'string') {
      if (!context.outputs.has(name)) {
        if (unknown === undefined) unknown = name;
        return _match;
      }
      return context.outputs.get(name) ?? '';
    }
    return _match;
  });
  if (unknown !== undefined) {
    return { ok: false, unknown };
  }
  return { ok: true, text: replaced };
}
