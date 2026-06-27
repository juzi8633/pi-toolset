# Agent Communication Optimization Implementation Plan

**Goal:** 分阶段增强 `@balaenis/pi-agents` 的代理通信能力，优先落地 package agents、结构化 chain 输出、动态 fanout、worktree 可观测性和强约束 system reminder。

**Inputs:** 用户要求“写一个可用执行的分阶段优化计划”；对比分析 `packages/pi-agents/docs/analysis/agent-communication-comparison.md`；当前实现文件 `packages/pi-agents/src/schema.ts`、`src/types.ts`、`src/tool.ts`、`src/agents.ts`、`src/template.ts`、`src/execution.ts`、`src/invocation.ts`、`src/worktree.ts`、`src/security.ts`；现有测试 `packages/pi-agents/tests/*.test.ts`；当前 README 中已记录 single / parallel / chain、`defaultContext`、`isolation`、`completionCheck`、`maxSubagentDepth` 等行为。

**Assumptions:**

- 保持当前默认行为不变：默认 `agentScope: "user"`，single / parallel / chain 参数继续可用，现有 `{previous}` 与 `{outputs.<name>}` 文本模板不破坏。
- 第一轮不引入新的运行时依赖；`outputSchema` 使用本包内实现的 JSON Schema 子集校验器。如果后续要完整 JSON Schema draft 支持，再单独评估 `ajv` 等依赖并按项目规则验证当前文档。
- Package agents 按 pi `settings.json#packages[]` 发现：user-scope 包在默认 `agentScope: "user"` / `"both"` 加载，project-scope 包在 `"project"` / `"both"` 加载；两者在运行时都走与 project agent 相同的确认流程。
- Chain 输出命名继续使用现有 `name` 字段；第一轮不新增 `as` 别名，避免同时维护两套语义。
- 本计划不直接实现后台 async agent、长生命周期 mailbox 或 Claude Code 风格 prompt-cache fork。这些能力需要运行状态管理器和通知回灌机制，列为后续独立计划。
- 所有新建 TypeScript 代码文件必须以两行 `ABOUTME:` 注释开头，并保持注释最少化。

**Architecture:** 先把 chain 编排从 `tool.ts` 抽到可注入、可单测的 `chain.ts`，再在这个边界上增加结构化输出和动态 fanout。Agent 发现扩展为 builtin / package / user / project 四层，package agent 使用命名空间运行名避免覆盖本地 agent。Worktree 与 system prompt 增强保持 opt-in，所有用户可见配置同步更新 README。

**Tech Stack:** TypeScript, Bun test runner, TypeBox schemas from `@earendil-works/pi-ai`, Node `fs` / `path` / `child_process`, Pi extension API, git worktree, `mise` package tasks, `hk check`.

---

## File Map

- Create: `packages/pi-agents/src/chain.ts` — chain 执行引擎，支持顺序步骤、命名输出、结构化输出、动态 fanout，并通过注入的 `runStep` 便于单测。
- Create: `packages/pi-agents/src/package-agents.ts` — 发现并加载 npm / workspace package 暴露的 agent 定义。
- Create: `packages/pi-agents/src/structured-output.ts` — 结构化输出提取、JSON 解析、JSON Schema 子集校验、输出契约提示词生成。
- Create: `packages/pi-agents/src/json-pointer.ts` — 实现 dynamic fanout 使用的 JSON Pointer 读取。
- Modify: `packages/pi-agents/src/agents.ts` — 扩展 `AgentSource`、`AgentConfig`、agent 加载入口和 package agent 合并顺序。
- Modify: `packages/pi-agents/src/schema.ts` — 扩展 chain step schema：`outputSchema`、fanout step、`expand.from`、`collect.name`、`concurrency`。
- Modify: `packages/pi-agents/src/types.ts` — 增加 `structuredOutput`、`finalOutput`、`ChainOutputEntry`、`outputs`、worktree diff 字段。
- Modify: `packages/pi-agents/src/tool.ts` — 将 chain 分发委托给 `chain.ts`，保持 single / parallel 行为不变。
- Modify: `packages/pi-agents/src/template.ts` — 支持 `{item}`，并把 `outputs` 从 `Map<string, string>` 平滑升级为 chain 输出 entry。
- Modify: `packages/pi-agents/src/output.ts` — 把 `structured_output_error`、`fanout_error`、`worktree_setup_error` 纳入失败 stop reason。
- Modify: `packages/pi-agents/src/worktree.ts` — 增加 worktree setup hook、dirty worktree diff stat / name-status 收集。
- Modify: `packages/pi-agents/src/invocation.ts` — 组合 `criticalSystemReminder` 到子代理 system prompt。
- Modify: `packages/pi-agents/README.md` — 更新 package agents、`outputSchema`、dynamic fanout、worktree hook、critical reminder 用法。
- Modify: `packages/pi-agents/package.json` — 在 `pi` 元数据中声明本包自己的 `agents` 目录，作为 package agents 的示例和回归测试样本。
- Test: `packages/pi-agents/tests/chain.test.ts` — chain 引擎、结构化命名输出、dynamic fanout 的单元测试。
- Test: `packages/pi-agents/tests/package-agents.test.ts` — package agent discovery、命名空间、scope、覆盖顺序测试。
- Test: `packages/pi-agents/tests/structured-output.test.ts` — JSON 提取和 schema 子集校验测试。
- Test: `packages/pi-agents/tests/json-pointer.test.ts` — JSON Pointer 读取、转义、错误路径测试。
- Modify: `packages/pi-agents/tests/agents.test.ts` — 新 frontmatter 字段解析测试。
- Modify: `packages/pi-agents/tests/template.test.ts` — `{item}` 和 entry 输出兼容性测试。
- Modify: `packages/pi-agents/tests/worktree.test.ts` — setup hook、diff stat、失败保留行为测试。
- Modify: `packages/pi-agents/tests/invocation.test.ts` — `criticalSystemReminder` system prompt 组合测试。

## Phased Delivery

| Phase | Deliverable                   | User-visible value                            | Release safety                                 |
| ----- | ----------------------------- | --------------------------------------------- | ---------------------------------------------- |
| 0     | Extract testable chain engine | 无行为变化，为后续能力打测试边界              | Safe, internal refactor                        |
| 1     | Package agents                | 第三方 / workspace 包可分发 agents            | Opt-in via `agentScope: "project"` or `"both"` |
| 2     | Structured chain outputs      | Chain 步骤可返回 JSON 并被后续步骤可靠消费    | Opt-in via `outputSchema`                      |
| 3     | Dynamic fanout / collect      | 上一步输出列表后自动并行处理 N 项             | Opt-in chain step, capped                      |
| 4     | Worktree hook + diff metadata | Worktree 隔离更适合真实项目构建，结果更可审计 | Opt-in via frontmatter / task isolation        |
| 5     | Critical system reminder      | reviewer / verifier 等代理更不容易越界        | Opt-in frontmatter                             |

## Tasks

### Task 1: Extract chain execution into a testable module

**Outcome:** 当前 chain 行为保持不变，但不再把后续结构化输出和 fanout 逻辑塞进 `tool.ts` 私有函数。

**Files:**

- Create: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`

**Steps:**

- [x] 创建 `src/chain.ts`，文件头添加两行 `ABOUTME:` 注释。
- [x] 从 `tool.ts` 移出当前 `runChain()` 的核心循环，导出 `runChainWorkflow(options)`。
- [x] `runChainWorkflow` 参数包含：`ctx`、`agents`、`chain`、`signal`、`onUpdate`、`makeDetails`、`runStep`。其中 `runStep` 在生产路径调用当前 `runStepWithContext`，在测试路径返回合成 `SingleResult`。
- [x] 保留当前行为：按顺序执行；`{previous}` 替换上一步最终文本；`{outputs.<name>}` 替换命名步骤文本；未知输出返回 `template_error` 并停止；任一步失败则停止。
- [x] `tool.ts` 中的 chain 分支改为调用 `runChainWorkflow`，single / parallel 分支不改变。
- [x] 在 `chain.test.ts` 添加用例：两个步骤按顺序执行，第二步 task 收到第一步输出。
- [x] 在 `chain.test.ts` 添加用例：命名输出 `{outputs.plan}` 可被后续步骤替换。
- [x] 在 `chain.test.ts` 添加用例：引用 `{outputs.missing}` 时返回 `isError: true`、结果 `stopReason: "template_error"`，且不调用后续 `runStep`。
- [x] 在 `chain.test.ts` 添加用例：第一步合成失败时 chain 停止，不执行第二步。

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/chain.test.ts`
- Expected: 新增 chain 单测全部通过，且不需要 spawn 真实 `pi` 子进程。
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript 无错误。

### Task 2: Add package agent discovery

**Outcome:** 通过 pi 安装的包（`~/.pi/agent/settings.json` 与项目 `.pi/settings.json` 中的 `packages[]`）可以通过 package metadata 暴露 agents，调用时使用命名空间运行名；npm/git/local 三种 source 与 pi 官方 package manager 一致。

**Files:**

- Create: `packages/pi-agents/src/package-agents.ts`
- Modify: `packages/pi-agents/src/agents.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/package.json`
- Test: `packages/pi-agents/tests/package-agents.test.ts`
- Modify: `packages/pi-agents/README.md`

**Steps:**

- [x] 在 `package.json` 的 `pi` 字段中增加 `"agents": ["./agents"]`，作为本包发布 package agents 的示例。
- [x] 扩展 `AgentSource` 为 `'builtin' | 'package' | 'user' | 'project'`。
- [x] 扩展 `AgentConfig`：`localName?: string`、`packageName?: string`。
- [x] 创建 `package-agents.ts`，文件头添加两行 `ABOUTME:` 注释，并实现 `discoverPackageAgentDirs(cwd: string): PackageAgentDir[]`。
- [x] `discoverPackageAgentDirs(cwd, scope)` 从 `~/.pi/agent/settings.json`（user 作用域）与最近祖先 `.pi/settings.json`（project 作用域）读取 `packages[]`，与 pi 官方 package manager 一致地解析 `npm:`、`git:`、本地路径三种 source 到 packageRoot。
- [x] 对每个 packageRoot 读取 `package.json#pi.agents` 字段（字符串或字符串数组），路径相对 packageRoot 解析，可指向目录或单个 `.md` 文件；不再扫描项目 `node_modules` 或读取项目 `dependencies`。
- [x] 加载 package agent 时保留 frontmatter 中的本地名到 `localName`，运行名设为 `${packageName}.${localName}`，例如 `@acme/pi-frontend.react-reviewer`。
- [x] Package agent 的 `source` 设置为 `package`，`packageName` 设置为真实包名，`filePath` 指向 `.md` 文件。
- [x] 修改 `discoverAgents(cwd, scope)`：合并顺序为 builtin → package → user → project；user 作用域包仅在 `scope === "user" || scope === "both"` 时加载，project 作用域包仅在 `scope === "project" || scope === "both"` 时加载。
- [x] 修改 project agent 确认逻辑：当请求的 agent 来源是 `project` 或 `package`，且 `confirmProjectAgents !== false` 且 `ctx.hasUI`，确认弹窗列出 agent 名称和来源路径（与 `agentScope` 无关，依据实际 source）。
- [x] 在 `package-agents.test.ts` 用临时目录搭建假的 `~/.pi/agent/{settings.json, npm/node_modules/...}` 和 `<project>/.pi/{settings.json, npm/node_modules/..., git/...}`，覆盖 `npm:`、`git:`、本地路径与对象形式的 `{source}` 条目。
- [x] 测试 `discoverAgents(tempProject, "project")` 不包含仅在 user `settings.json` 中声明的包 agent。
- [x] 测试 `discoverAgents(tempProject, "user")` 或 `"both"` 包含 `@acme/pi-demo.reviewer`，并且 `localName === "reviewer"`、`packageName === "@acme/pi-demo"`、`source === "package"`。
- [x] 测试无 `pi.agents` 或路径不存在的包被跳过，不抛异常。
- [x] README 增加 package agent 发布格式、运行名、scope 与安全确认说明。

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/package-agents.test.ts tests/agents.test.ts`
- Expected: package discovery 单测通过，现有 builtin / user / project agent 解析不回归。
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript 无错误。

### Task 3: Add structured output extraction and schema validation

**Outcome:** 本包具备无新依赖的结构化输出解析与校验能力，可被 chain step 使用。

**Files:**

- Create: `packages/pi-agents/src/structured-output.ts`
- Modify: `packages/pi-agents/src/types.ts`
- Test: `packages/pi-agents/tests/structured-output.test.ts`

**Steps:**

- [x] 创建 `src/structured-output.ts`，文件头添加两行 `ABOUTME:` 注释。
- [x] 定义 `JsonValue`、`JsonObject`、`JsonSchemaSubset` 类型。Schema 子集支持：`type`、`properties`、`required`、`items`、`enum`、`additionalProperties`、`minItems`、`maxItems`。
- [x] 实现 `extractJsonFromFinalOutput(text: string): { ok: true; value: JsonValue } | { ok: false; error: string }`。
- [x] `extractJsonFromFinalOutput` 接受两种格式：trim 后是完整 JSON；或整段文本只包含一个 fenced code block，语言为 `json` 或空语言，block 内容是完整 JSON。
- [x] 实现 `validateStructuredOutput(value: JsonValue, schema: JsonSchemaSubset): string[]`，返回人类可读错误路径，例如 `$.items[0].path: expected string`。
- [x] `validateStructuredOutput` 对 `type: "object"` 检查 plain object；按 `required` 检查缺失字段；按 `properties` 递归检查已声明字段；当 `additionalProperties === false` 时拒绝未声明字段。
- [x] `validateStructuredOutput` 对 `type: "array"` 检查数组；按 `items` 递归检查每个元素；按 `minItems` / `maxItems` 检查长度。
- [x] `validateStructuredOutput` 对 `string`、`number`、`integer`、`boolean`、`null` 执行类型检查；`integer` 必须 `Number.isInteger(value)`。
- [x] `validateStructuredOutput` 对 `enum` 使用 JSON 字符串化后的严格相等比较。
- [x] 实现 `buildStructuredOutputInstruction(schema)`，返回要追加到 task 的明确契约：最终 assistant message 必须只输出符合 schema 的 JSON，不要 Markdown、解释或 fenced block。
- [x] 在 `types.ts` 给 `SingleResult` 增加 `finalOutput?: string`、`structuredOutput?: unknown`、`structuredOutputError?: string`。
- [x] 在 `structured-output.test.ts` 覆盖：纯 JSON 成功、fenced JSON 成功、普通 Markdown 失败、缺失 required 字段失败、数组 items 类型失败、`additionalProperties: false` 失败、enum 成功与失败。

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/structured-output.test.ts`
- Expected: 结构化输出解析和 schema 子集校验测试全部通过。
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript 无错误。

### Task 4: Wire `outputSchema` into chain steps

**Outcome:** Chain 中任一步可以声明 `outputSchema`，该步最终输出会被解析和校验，并以 `structuredOutput` 返回给父代理和后续工作流。

**Files:**

- Modify: `packages/pi-agents/src/schema.ts`
- Modify: `packages/pi-agents/src/types.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/template.ts`
- Modify: `packages/pi-agents/src/output.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`
- Test: `packages/pi-agents/tests/template.test.ts`
- Modify: `packages/pi-agents/README.md`

**Steps:**

- [x] 在 `schema.ts` 的 sequential chain item 中增加 `outputSchema: Type.Optional(Type.Any({ description: ... }))`。
- [x] 在 `types.ts` 增加 `ChainOutputEntry`：`{ text: string; structured?: unknown; agent: string; step: number }`。
- [x] 在 `SubagentDetails` 增加可选 `outputs?: Record<string, ChainOutputEntry>`。
- [x] 在 `template.ts` 把 `TemplateContext.outputs` 从 `Map<string, string>` 改为 `Map<string, ChainOutputEntry>`，`{outputs.<name>}` 仍替换为 entry 的 `text`，保持兼容。
- [x] 在 `chain.ts` 执行有 `outputSchema` 的步骤前，把 `buildStructuredOutputInstruction(schema)` 追加到该步 task 后面。
- [x] 在步骤完成后，把 `getFinalOutput(result.messages)` 写入 `result.finalOutput`。
- [x] 当步骤有 `outputSchema` 时，调用 `extractJsonFromFinalOutput(result.finalOutput)` 和 `validateStructuredOutput`。
- [x] 如果解析或校验失败，把该 result 标记为失败：`exitCode = 1`、`stopReason = "structured_output_error"`、`structuredOutputError` 与 `errorMessage` 填入具体原因；chain 停止在该步。
- [x] 如果成功，把解析后的值写入 `result.structuredOutput`。
- [x] 当步骤有 `name` 时，写入 outputs map：`text` 为最终文本，`structured` 为 `result.structuredOutput`，`agent` 与 `step` 来自当前步骤。
- [x] `chain.ts` 最终返回的 `details` 带上 `outputs` 对象，key 为 step `name`。
- [x] 在 `output.ts` 的失败集合中加入 `structured_output_error`。
- [x] `chain.test.ts` 添加成功用例：第一步 `outputSchema` 要求 `{ files: string[] }`，合成输出 `{"files":["a.ts"]}`，details 中 `outputs.context.structured.files[0] === "a.ts"`。
- [x] `chain.test.ts` 添加失败用例：schema 要求 `files`，合成输出 `{}`，chain 停止，`stopReason === "structured_output_error"`。
- [x] `template.test.ts` 添加兼容用例：`{outputs.plan}` 仍替换 entry.text。
- [x] README 添加 chain `outputSchema` 示例和失败行为说明。

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/chain.test.ts tests/template.test.ts tests/structured-output.test.ts`
- Expected: 结构化 chain 输出测试通过，原模板替换语义不回归。
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript 无错误。

### Task 5: Add dynamic fanout and collect

**Outcome:** Chain 可以从前序结构化输出中取数组，自动生成并行子任务，收集结果后作为命名输出传给后续步骤。

**Files:**

- Create: `packages/pi-agents/src/json-pointer.ts`
- Modify: `packages/pi-agents/src/schema.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/template.ts`
- Modify: `packages/pi-agents/src/constants.ts`
- Modify: `packages/pi-agents/src/output.ts`
- Test: `packages/pi-agents/tests/json-pointer.test.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`
- Modify: `packages/pi-agents/README.md`

**Steps:**

- [x] 在 `constants.ts` 增加 `MAX_FANOUT_ITEMS = MAX_PARALLEL_TASKS`，默认最大动态展开数量与现有 parallel 上限一致。
- [x] 创建 `json-pointer.ts`，文件头添加两行 `ABOUTME:` 注释，并实现 `readJsonPointer(value, pointer)`。支持空指针 `""` 返回根值；支持 `/items/0/path`；支持 JSON Pointer 转义 `~0` → `~`、`~1` → `/`。
- [x] `readJsonPointer` 返回 `{ ok: true; value }` 或 `{ ok: false; error }`，错误包含缺失路径段。
- [x] 在 `schema.ts` 添加 fanout chain item schema：
  - `expand: { from: { output: string, path: string }, maxItems?: number }`
  - `parallel: { agent: string, task: string, cwd?: string, isolation?: IsolationSchema, outputSchema?: Type.Any() }`
  - `collect: { name: string }`
  - `concurrency?: number`
- [x] 把 `SubagentParams.chain` 从 `Type.Array(ChainItem)` 改为 sequential item 与 fanout item 的 union。
- [x] 在 `template.ts` 支持 `{item}`；当 item 是 object 或 array 时替换为 `JSON.stringify(item)`，其他 JSON 值用 `String(value)`，`null` 替换为 `null`。
- [x] 在 `chain.ts` 检测 fanout item：先从 outputs map 中读取 `expand.from.output`，必须存在且有 `structured` 值。
- [x] 使用 `readJsonPointer(entry.structured, expand.from.path)` 读取数组。若输出不存在、无 structured 值、路径不存在或路径结果不是数组，创建合成失败 result，`stopReason = "fanout_error"`，chain 停止。
- [x] fanout 数组长度超过 `maxItems ?? MAX_FANOUT_ITEMS` 时，截断到上限并在 collect 文本中记录被跳过数量；如果调用方提供的 `maxItems` 大于 `MAX_FANOUT_ITEMS`，仍按 `MAX_FANOUT_ITEMS` 上限执行。
- [x] 对每个 item 渲染 `parallel.task`，模板上下文包含 `previous`、`outputs`、`item`。
- [x] 使用现有 `mapWithConcurrencyLimit` 执行 fanout 子任务，实际并发为 `Math.min(step.concurrency ?? MAX_CONCURRENCY, MAX_CONCURRENCY)`。
- [x] fanout 子任务传入 `taskIndex` 时使用原 chain step index 加 fanout item index，确保 worktree 名称不冲突。
- [x] 如果 `parallel.outputSchema` 存在，对每个 fanout 子任务执行与 Task 4 相同的结构化输出解析和校验。
- [x] 所有 fanout 子任务完成后，如果任一 result 失败，chain 返回 `isError: true`，content 文本包含 `Fanout failed: <success>/<total> succeeded`，details 保留所有结果。
- [x] 如果全部成功，`collect.name` 写入 outputs map：`structured` 为数组，数组元素取 `result.structuredOutput ?? result.finalOutput ?? getFinalOutput(result.messages)`；`text` 为该数组的 pretty JSON。
- [x] 在 `output.ts` 的失败集合中加入 `fanout_error`。
- [x] `json-pointer.test.ts` 覆盖根指针、数组索引、对象属性、`~0` / `~1` 转义、缺失路径。
- [x] `chain.test.ts` 添加 fanout 成功用例：前一步 structured 输出 `{ "items": ["a", "b"] }`，fanout worker 收到 `Process a` 与 `Process b`，collect 输出 structured 数组长度为 2。
- [x] `chain.test.ts` 添加 fanout 路径非数组失败用例，断言 `stopReason === "fanout_error"`。
- [x] `chain.test.ts` 添加 fanout 子任务失败用例，断言所有已展开任务执行完后 chain 返回错误摘要。
- [x] README 添加 dynamic fanout 示例，包含 `expand.from.output`、JSON Pointer path、`{item}`、`collect.name` 和上限说明。

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/json-pointer.test.ts tests/chain.test.ts`
- Expected: fanout / collect 语义测试全部通过。
- Run: `mise run test --package packages/pi-agents -- tests/template.test.ts`
- Expected: `{previous}`、`{outputs.<name>}`、`{item}` 模板测试全部通过。
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript 无错误。

### Task 6: Add worktree setup hook and diff metadata

**Outcome:** 使用 `isolation: "worktree"` 的代理可以在子代理启动前运行准备命令，并在 dirty worktree 保留时返回可审计的 diff 摘要。

**Files:**

- Modify: `packages/pi-agents/src/agents.ts`
- Modify: `packages/pi-agents/src/types.ts`
- Modify: `packages/pi-agents/src/worktree.ts`
- Modify: `packages/pi-agents/src/tool.ts` or `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/output.ts`
- Test: `packages/pi-agents/tests/agents.test.ts`
- Test: `packages/pi-agents/tests/worktree.test.ts`
- Modify: `packages/pi-agents/README.md`

**Steps:**

- [x] 在 `AgentConfig` 增加 `worktreeSetupHook?: string`。
- [x] 在 `agents.ts` 解析 frontmatter `worktreeSetupHook`，仅接受非空字符串；空字符串忽略。
- [x] 在 `SingleResult` 增加 `worktreeDiffStat?: string`、`worktreeChangedFiles?: string[]`、`worktreeSetupError?: string`。
- [x] 在 `worktree.ts` 添加 `runWorktreeSetupHook(worktreePath: string, command: string)`，使用 `spawnSync(command, { cwd: worktreePath, shell: true, encoding: "utf-8" })` 执行。
- [x] `runWorktreeSetupHook` 成功时返回 stdout / stderr；失败时返回 exit code 和 stderr / stdout 摘要。
- [x] 在创建 worktree 后、spawn 子 `pi` 前执行 hook；如果 hook 失败，返回合成失败 result：`exitCode = 1`、`stopReason = "worktree_setup_error"`、`errorMessage` 包含命令与退出码。
- [x] Hook 失败时对 worktree 执行安全清理：若 `git status --porcelain` 干净则删除；脏或状态未知则保留并设置 `worktreePath` / `worktreeDirty`。
- [x] 在 `worktree.ts` 添加 `getWorktreeDiffSummary(worktreePath)`，dirty worktree 时执行 `git diff --stat --no-ext-diff` 和 `git diff --name-only --no-ext-diff`。
- [x] 在 `finalizeWorktree` dirty 分支写入 `result.worktreeDiffStat` 和 `result.worktreeChangedFiles`。
- [x] 在 `output.ts` 的失败集合中加入 `worktree_setup_error`。
- [x] `agents.test.ts` 覆盖 `worktreeSetupHook: "bun install"` 解析成功，空字符串被忽略。
- [x] `worktree.test.ts` 添加成功 hook 用例：hook 写入一个文件，子代理模拟成功后 worktree dirty，被保留，并返回 changed files。
- [x] `worktree.test.ts` 添加失败 hook 用例：hook `exit 7`，返回 `worktree_setup_error`，clean worktree 被删除。
- [x] README 记录 hook 运行时机、安全模型、失败行为、diff metadata 字段。

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/agents.test.ts tests/worktree.test.ts`
- Expected: worktree hook 与 diff metadata 测试通过。
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript 无错误。

### Task 7: Add critical system reminder support

**Outcome:** Agent 作者可以在 frontmatter 声明强约束提醒，子代理 system prompt 会包含该提醒，适合 reviewer / verifier 这类不应改文件的代理。

**Files:**

- Modify: `packages/pi-agents/src/agents.ts`
- Modify: `packages/pi-agents/src/invocation.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Test: `packages/pi-agents/tests/agents.test.ts`
- Test: `packages/pi-agents/tests/invocation.test.ts`
- Modify: `packages/pi-agents/agents/reviewer.md`
- Modify: `packages/pi-agents/README.md`

**Steps:**

- [x] 在 `AgentConfig` 增加 `criticalSystemReminder?: string`。
- [x] 在 `agents.ts` 解析 frontmatter `criticalSystemReminder`，仅接受非空字符串。
- [x] 在 `invocation.ts` 增加 `buildAgentSystemPrompt(agent)`：返回 `agent.systemPrompt`；如果有 `criticalSystemReminder`，追加一个明确分隔块：`<critical-system-reminder>\n...\n</critical-system-reminder>`。
- [x] 在 `execution.ts` 写临时 system prompt 文件时改用 `buildAgentSystemPrompt(agent)`，而不是直接写 `agent.systemPrompt`。
- [x] 保持 `systemPromptMode` 行为不变：`replace` 仍使用 `--system-prompt`，`append` 仍使用 `--append-system-prompt`。
- [x] 在 `agents/reviewer.md` 增加 `criticalSystemReminder`，内容明确：reviewer 只做审查，不编辑文件，不修复代码，输出 findings。
- [x] `agents.test.ts` 覆盖字段解析。
- [x] `invocation.test.ts` 覆盖 `buildAgentSystemPrompt`：无 reminder 时原样返回，有 reminder 时包含 XML-like 分隔块和原始 system prompt。
- [x] README 记录该能力不是 Claude Code 的“每轮注入”，而是在子代理 system prompt 中追加强约束；适合和 `excludeTools` 一起使用。

**Validation:**

- Run: `mise run test --package packages/pi-agents -- tests/agents.test.ts tests/invocation.test.ts`
- Expected: reminder 解析与 prompt 组合测试通过。
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript 无错误。

### Task 8: Update documentation and examples

**Outcome:** 用户能按 README 直接使用新能力，且知道每个能力的安全边界。

**Files:**

- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/prompts/explore-and-plan.md` if it benefits from structured output examples
- Modify: `packages/pi-agents/prompts/implement.md` if it benefits from structured output examples

**Steps:**

- [x] 在 README “Features” 中增加 package agents、structured chain outputs、dynamic fanout、worktree setup / diff、critical reminder。
- [x] 在 README “Tool Modes” 中保留原 single / parallel / chain 表，并新增 “Structured chain output” 与 “Dynamic fanout” 小节。
- [x] 给 `outputSchema` 提供完整可复制 JSON 示例：先用 `explore` 输出 `{ "files": [...] }`，再由 `planner` 使用 `{outputs.context}`。
- [x] 给 dynamic fanout 提供完整可复制示例：先输出 `{ "items": [...] }`，再 `expand.from.path: "/items"`，`parallel.task: "Process {item}"`，`collect.name: "results"`。
- [x] 在 README “Agent Definitions” 表中新增 `worktreeSetupHook` 与 `criticalSystemReminder`。
- [x] 在 README “Security Model” 中说明 package agents 和 project agents 一样需要信任项目；worktree setup hook 是 shell 命令，来自 agent 定义，必须只在可信来源运行。
- [x] 在 README “Limitations” 中加入：dynamic fanout 最多展开 `MAX_FANOUT_ITEMS` 项；`outputSchema` 使用本包 JSON Schema 子集，不等同完整 JSON Schema draft。
- [x] 如果修改 workflow prompt，保持 prompt 仍使用现有 `agent` tool 参数，不引入尚未实现的 `as` 字段。

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: 文档变更不影响 TypeScript。
- Run: `mise run build --package packages/pi-agents`
- Expected: 包仍可构建成功。

### Task 9: Final package validation

**Outcome:** 所有阶段合并后，包级测试、类型检查、构建和仓库级 lint / format 都通过。

**Files:**

- No additional source files beyond Tasks 1-8.

**Steps:**

- [x] 运行 package 全量测试。
- [x] 运行 package TypeScript 检查。
- [x] 运行 package build。
- [x] 运行 repo-wide lint / format check。
- [x] 如果 `hk check` 修改建议只涉及格式，运行 `hk fix` 后重新跑 `hk check`。
- [x] 手动检查 `packages/pi-agents/README.md` 中的新示例没有使用未实现字段。

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: `packages/pi-agents` 全部 Bun tests 通过。
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript 无错误。
- Run: `mise run build --package packages/pi-agents`
- Expected: `dist/index.js` 等输出成功生成。
- Run: `hk check`
- Expected: eslint + prettier 检查通过。

## Final Validation

- Run: `mise run test --package packages/pi-agents`
- Expected: 全部 package tests 通过。
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript 无错误。
- Run: `mise run build --package packages/pi-agents`
- Expected: package 构建成功。
- Run: `hk check`
- Expected: repo-wide lint / format 通过。

## Rollout Notes

- 推荐按 phase 顺序合并，每个 phase 单独 PR 或单独 commit：Phase 0 纯重构；Phase 1 package agents；Phase 2 structured output；Phase 3 fanout；Phase 4 worktree hook；Phase 5 reminder。
- Phase 1 改变 agent discovery：默认 `agentScope: "user"` 会加载 `~/.pi/agent/agents` 与 user-scope package agents（`~/.pi/agent/settings.json#packages`）。默认安全边界依靠 confirm 提示 + path-escape / symlink 防护，不再依靠 scope 的“不加载”。
- Phase 2 和 Phase 3 都是 opt-in。没有 `outputSchema` 或 fanout step 的现有 chain 行为保持不变。
- Phase 4 的 `worktreeSetupHook` 会运行 shell 命令，必须在 README 中明确只对可信 agent 来源使用。Project / package 来源仍走确认流程。
- Phase 5 的 `criticalSystemReminder` 不是运行时 sandbox；它必须与 `tools` / `excludeTools`、`maxSubagentDepth` 搭配使用。
- 本计划完成后，再单独评估 mailbox / async。入口条件：需要稳定的 `runId`、持久化 run directory、agent registry、通知回灌机制；不应在当前 synchronous `executeAgentTool` 中临时拼接。

## Risks and Mitigations

- Risk: TypeBox union schema 让 tool 参数提示变复杂，模型更难正确调用 fanout。 — Mitigation: README 给完整 JSON 示例；schema descriptions 写清楚 sequential step 与 fanout step 二选一；保留旧 sequential shape 完全兼容。
- Risk: 本地 JSON Schema 子集与用户预期的完整 JSON Schema 不一致。 — Mitigation: README 明确支持字段列表；校验错误返回具体路径；后续如需完整 draft 支持再引入专门依赖。
- Risk: Package agents 来源路径扫描过宽，导致意外加载不受控的 prompts。 — Mitigation: 只读取 pi `settings.json` `packages[]` 中明确声明的包；只加载包 `package.json` 明确声明的 `pi.agents` 路径；user 与 project 作用域按 `agentScope` 独立加载，`project` 胜出 `user`。
- Risk: Dynamic fanout 造成过多子进程或 token 消耗。 — Mitigation: 使用 `MAX_FANOUT_ITEMS = MAX_PARALLEL_TASKS`；并发上限仍受 `MAX_CONCURRENCY` 约束；超过上限时截断并在 collect 文本记录跳过数量。
- Risk: Worktree setup hook 运行任意 shell 命令。 — Mitigation: hook 只来自 agent frontmatter；project / package agent 需要确认；README 明确安全模型；失败时保留 dirty worktree 供检查。
- Risk: `criticalSystemReminder` 被误解为强安全边界。 — Mitigation: 文档明确它只是 prompt-level 约束，真正的工具能力仍由 `tools` / `excludeTools` 和深度守卫控制。
