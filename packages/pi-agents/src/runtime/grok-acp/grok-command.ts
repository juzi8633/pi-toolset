// ABOUTME: Resolves Grok CLI argument arrays into subprocess invocation descriptors.
// ABOUTME: Shared by one-shot and interactive Grok ACP transports.

import { GROK_BINARY } from '../../shared/constants.ts';

export function getGrokInvocation(args: string[]): { command: string; args: string[] } {
  return { command: GROK_BINARY, args };
}
