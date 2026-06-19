// ABOUTME: Unit tests for the LSP statusLine formatter.
// ABOUTME: Uses an identity/marker color stub so tests verify segment coloring without ANSI.

import { describe, expect, it } from 'bun:test';
import { formatLspStatus, type StatusColorFn } from '../src/statusline.ts';

const markerFg: StatusColorFn = (color, text) => `[${color}]${text}[/${color}]`;

describe('formatLspStatus', () => {
  it('returns undefined when all tracked counts are zero', () => {
    expect(formatLspStatus({ running: 0, starting: 0, error: 0 }, markerFg)).toBeUndefined();
  });

  it('renders running-only with a border-colored bolt prefix', () => {
    expect(formatLspStatus({ running: 2, starting: 0, error: 0 }, markerFg)).toBe(
      '[border]⚡[/border]LSP 🟢2'
    );
  });

  it('renders only the starting segment when no servers are running yet', () => {
    expect(formatLspStatus({ running: 0, starting: 1, error: 0 }, markerFg)).toBe(
      '[border]⚡[/border]LSP [dim]🟡1[/dim]'
    );
  });

  it('appends a dim starting segment when at least one server is starting', () => {
    expect(formatLspStatus({ running: 2, starting: 1, error: 0 }, markerFg)).toBe(
      '[border]⚡[/border]LSP 🟢2 [dim]🟡1[/dim]'
    );
  });

  it('appends a red error segment when at least one server has failed', () => {
    expect(formatLspStatus({ running: 2, starting: 0, error: 1 }, markerFg)).toBe(
      '[border]⚡[/border]LSP 🟢2 [error]🔴1[/error]'
    );
  });

  it('renders running, starting, then error in mixed states', () => {
    expect(formatLspStatus({ running: 1, starting: 2, error: 3 }, markerFg)).toBe(
      '[border]⚡[/border]LSP 🟢1 [dim]🟡2[/dim] [error]🔴3[/error]'
    );
  });

  it('omits zero starting/error segments while keeping running', () => {
    expect(formatLspStatus({ running: 1, starting: 0, error: 0 }, markerFg)).toBe(
      '[border]⚡[/border]LSP 🟢1'
    );
  });

  it('treats only-error as visible (recovery indicator must surface)', () => {
    expect(formatLspStatus({ running: 0, starting: 0, error: 2 }, markerFg)).toBe(
      '[border]⚡[/border]LSP [error]🔴2[/error]'
    );
  });
});
