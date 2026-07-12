// ABOUTME: TypeBox parameter schemas for the `agent` tool — single, parallel, chain, and scope inputs.
// ABOUTME: `SubagentParams` is registered with `pi.registerTool`; helper schemas back the parameter shape.

import { StringEnum, Type } from '@earendil-works/pi-ai';

export const IsolationSchema = StringEnum(['none', 'worktree'] as const, {
  description:
    'Per-task isolation. "worktree" runs the child in a fresh git worktree under .worktrees/.',
});

export const TitleSchema = Type.String({
  maxLength: 30,
  description:
    'Short label (max 30 chars) shown in the collapsed summary instead of the task preview (e.g. "fix lint"). Omit to use the task preview.',
});

export const RuntimeSchema = StringEnum(['pi', 'grok', 'grok-acp'] as const, {
  description:
    "Override the agent config `runtime` for every agent in this call. `pi` (default) spawns the pi CLI; `grok` spawns Grok streaming-json; `grok-acp` spawns Grok ACP over stdio. Defaults to each agent's configured runtime.",
});

export const TaskItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task to delegate to the agent' }),
  title: Type.Optional(TitleSchema),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
  isolation: Type.Optional(IsolationSchema),
});

export const SequentialChainItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({
    description:
      'Task with optional {previous} or {outputs.<name>} placeholders that reference earlier chain outputs',
  }),
  title: Type.Optional(TitleSchema),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
  isolation: Type.Optional(IsolationSchema),
  name: Type.Optional(
    Type.String({
      description:
        'Name used to reference this step’s output as `{outputs.<name>}` from later chain steps',
    })
  ),
  outputSchema: Type.Optional(
    Type.Any({
      description:
        'JSON Schema subset for the required structured output of this step. When set, the result is parsed and validated against it. Supports type/properties/required/items/enum/additionalProperties/minItems/maxItems.',
    })
  ),
});

export const FanoutChainItem = Type.Object({
  expand: Type.Object({
    from: Type.Object({
      output: Type.String({
        description:
          'Name of a previous chain output that produced structured output (a step with `outputSchema` set and validated). Fanout fails if the referenced output has no structured data.',
      }),
      path: Type.String({
        description:
          'JSON Pointer path (RFC 6901, e.g. "/items" or "/results/0/data") to an array inside the structured output.',
      }),
    }),
    maxItems: Type.Optional(Type.Number({ description: 'Maximum items to expand' })),
  }),
  parallel: Type.Object({
    agent: Type.String({ description: 'Name of the agent to invoke for every item' }),
    task: Type.String({ description: 'Task template with optional {item} placeholder' }),
    title: Type.Optional(TitleSchema),
    cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
    isolation: Type.Optional(IsolationSchema),
    outputSchema: Type.Optional(
      Type.Any({ description: 'Optional structured output schema for each fanout item' })
    ),
  }),
  collect: Type.Object({
    name: Type.String({
      description:
        "Name used to reference collected fanout results as `{outputs.<name>}` from later chain steps. The value is a JSON array of all items' outputs (or each item's structured output when `outputSchema` is set).",
    }),
  }),
  concurrency: Type.Optional(Type.Number({ description: 'Maximum concurrent fanout workers' })),
});

export const ChainItem = Type.Union([SequentialChainItem, FanoutChainItem], {
  description: 'Sequential step or dynamic fanout step',
});

export const AgentScopeSchema = StringEnum(['user', 'project', 'both'] as const, {
  description:
    'Which agent directories to load. "both" (default) merges user and project agents with project overriding user; "user" or "project" limits to that scope.',
  default: 'both',
});

export const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({ description: 'Name of the agent to invoke (for single mode)' })
  ),
  task: Type.Optional(Type.String({ description: 'Task to delegate (for single mode)' })),
  title: Type.Optional(TitleSchema),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: 'Array of {agent, task} for parallel execution' })
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, {
      description: 'Array of sequential chain steps and optional dynamic fanout steps',
    })
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  cwd: Type.Optional(
    Type.String({ description: 'Working directory for the agent process (single mode)' })
  ),
  isolation: Type.Optional(IsolationSchema),
  runInBackground: Type.Optional(
    Type.Boolean({
      description:
        'Run this agent workflow in the background. The tool returns immediately and the parent session is notified when it completes.',
    })
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Override the agent config `model` for every agent in this call. Defaults to each agent's configured model; set only to force a specific model.",
    })
  ),
  thinking: Type.Optional(
    Type.String({
      description:
        "Override the agent config `thinking` for every agent in this call. Defaults to each agent's configured thinking; set only to force a specific thinking level.",
    })
  ),
  runtime: Type.Optional(RuntimeSchema),
});
