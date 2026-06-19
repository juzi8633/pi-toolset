// ABOUTME: Unit tests for the LSP statusLine formatter.
// ABOUTME: Uses an identity/marker color stub so tests verify segment coloring without ANSI.

import { describe, expect, it } from 'bun:test';
import { formatLspStatus, type StatusColorFn } from '../src/statusline.ts';

const markerFg: StatusColorFn = (color, text) => `[${color}]${text}[/${color}]`;

describe('formatLspStatus', () => {
  it('returns undefined when nothing is tracked', () => {
    expect(formatLspStatus({ running: 0, starting: 0, error: 0 }, markerFg)).toBeUndefined();
  });

  it('shows only the bare label when every server is healthy', () => {
    expect(formatLspStatus({ running: 2, starting: 0, error: 0 }, markerFg)).toBe(
      '[success]⚡LSP[/success]'
    );
  });

  it('shows the bare label even with a single running server', () => {
    expect(formatLspStatus({ running: 1, starting: 0, error: 0 }, markerFg)).toBe(
      '[success]⚡LSP[/success]'
    );
  });

  it('appends a dim starting segment when at least one server is starting', () => {
    expect(formatLspStatus({ running: 2, starting: 1, error: 0 }, markerFg)).toBe(
      '[success]⚡LSP[/success] [dim]…1[/dim]'
    );
  });

  it('renders the starting segment when no servers have come up yet', () => {
    expect(formatLspStatus({ running: 0, starting: 1, error: 0 }, markerFg)).toBe(
      '[success]⚡LSP[/success] [dim]…1[/dim]'
    );
  });

  it('appends a red error segment when at least one server has failed', () => {
    expect(formatLspStatus({ running: 2, starting: 0, error: 1 }, markerFg)).toBe(
      '[success]⚡LSP[/success] [error]✕1[/error]'
    );
  });

  it('renders starting before error in mixed states', () => {
    expect(formatLspStatus({ running: 1, starting: 2, error: 3 }, markerFg)).toBe(
      '[success]⚡LSP[/success] [dim]…2[/dim] [error]✕3[/error]'
    );
  });

  it('keeps the recovery indicator visible when only errors remain', () => {
    expect(formatLspStatus({ running: 0, starting: 0, error: 2 }, markerFg)).toBe(
      '[success]⚡LSP[/success] [error]✕2[/error]'
    );
  });
});
