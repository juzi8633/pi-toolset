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

export const ChainItem = Type.Object({
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
});

export const AgentScopeSchema = StringEnum(['user', 'project', 'both'] as const, {
  description:
    'Which agent directories to use. Default: "user". Use "project" or "both" to include project-local and package agents.',
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
    Type.Array(ChainItem, { description: 'Array of {agent, task} for sequential execution' })
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
