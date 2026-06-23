// ABOUTME: Pi format extension entry point.
// ABOUTME: Registers the format tool, /format command, and automatic post-edit formatting hook.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerFormatCommand } from './command.ts';
import { registerFormatHooks } from './hooks.ts';
import { registerFormatTool } from './tools.ts';

export default function (pi: ExtensionAPI): void {
  registerFormatTool(pi);
  registerFormatCommand(pi);
  registerFormatHooks(pi);
}
