// ABOUTME: TypeBox parameter schemas for the `agent` tool — single, parallel, chain, and scope inputs.
// ABOUTME: `SubagentParams` is registered with `pi.registerTool`; helper schemas back the parameter shape.

import { StringEnum, Type } from '@earendil-works/pi-ai';

export const IsolationSchema = StringEnum(['none', 'worktree'] as const, {
  description:
    'Per-task isolation. "worktree" runs the child in a fresh git worktree under .worktrees/.',
});

export const TaskItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({ description: 'Task to delegate to the agent' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
  isolation: Type.Optional(IsolationSchema),
});

export const SequentialChainItem = Type.Object({
  agent: Type.String({ description: 'Name of the agent to invoke' }),
  task: Type.String({
    description:
      'Task with optional {previous} or {outputs.<name>} placeholders that reference earlier chain outputs',
  }),
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
        'JSON Schema subset describing the required structured final output for this step. When set, the step task is augmented with a JSON-only contract and the result is parsed and validated. Supports type/properties/required/items/enum/additionalProperties/minItems/maxItems.',
    })
  ),
});

export const FanoutChainItem = Type.Object({
  expand: Type.Object({
    from: Type.Object({
      output: Type.String({ description: 'Name of a previous structured chain output' }),
      path: Type.String({ description: 'JSON Pointer path to an array inside the output' }),
    }),
    maxItems: Type.Optional(Type.Number({ description: 'Maximum items to expand' })),
  }),
  parallel: Type.Object({
    agent: Type.String({ description: 'Name of the agent to invoke for every item' }),
    task: Type.String({ description: 'Task template with optional {item} placeholder' }),
    cwd: Type.Optional(Type.String({ description: 'Working directory for the agent process' })),
    isolation: Type.Optional(IsolationSchema),
    outputSchema: Type.Optional(
      Type.Any({ description: 'Optional structured output schema for each fanout item' })
    ),
  }),
  collect: Type.Object({
    name: Type.String({ description: 'Name used to reference collected fanout results' }),
  }),
  concurrency: Type.Optional(Type.Number({ description: 'Maximum concurrent fanout workers' })),
});

export const ChainItem = Type.Union([SequentialChainItem, FanoutChainItem], {
  description: 'Sequential step or dynamic fanout step',
});

export const AgentScopeSchema = StringEnum(['user', 'project', 'both'] as const, {
  description:
    'Which agent directories to use. Default: "user". "user" loads ~/.pi/agent/agents plus packages installed via `pi install` in user settings (~/.pi/agent/settings.json). "project" loads .pi/agents plus packages installed in project settings (.pi/settings.json). "both" merges them with project overriding user.',
  default: 'user',
});

export const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({ description: 'Name of the agent to invoke (for single mode)' })
  ),
  task: Type.Optional(Type.String({ description: 'Task to delegate (for single mode)' })),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: 'Array of {agent, task} for parallel execution' })
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, {
      description: 'Array of sequential chain steps and optional dynamic fanout steps',
    })
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: 'Prompt before running project-local or package agents. Default: true.',
      default: true,
    })
  ),
  cwd: Type.Optional(
    Type.String({ description: 'Working directory for the agent process (single mode)' })
  ),
  isolation: Type.Optional(IsolationSchema),
});
