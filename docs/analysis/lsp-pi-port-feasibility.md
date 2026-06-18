# LSP 模块移植到 Pi 扩展的可行性评估

> 配套文档:[lsp-module-architecture.md](./lsp-module-architecture.md)(Claude Code LSP 架构分析)
> 实现规格:[../specs/lsp-extension-spec.md](../specs/lsp-extension-spec.md)

## 1. 结论速览

**完全可行,且 Pi 的扩展模型与 LSP 客户端的需求高度契合。**

Claude Code(下称 CC)的 LSP 模块中约 70% 是与宿主无关的纯逻辑(JSON-RPC 通信、状态机、诊断去重、格式化),可以近乎原样搬运。真正依赖宿主的三个集成点——① 注册工具、② 被动推送诊断、③ 编辑后触发文件同步——Pi 全部提供对应机制。其中"被动推送诊断"在 Pi 中属于一等能力(`context` / `before_agent_start` hook + `sendMessage`)。

主要工作量不在技术难度,而在于:把 CC 的 5 个核心层重新组织成单个 Pi 扩展,并替换掉 CC 专有的 plugin 配置体系。

整体评级:**中等复杂度,低风险**。大部分是可单元验证的纯逻辑搬运,集成点齐全无硬性缺口。

## 2. 移植映射表

| CC 模块                                     | 宿主依赖       | Pi 对应机制                                                     | 复杂度          |
| ------------------------------------------- | -------------- | --------------------------------------------------------------- | --------------- |
| `LSPClient`(spawn + JSON-RPC)               | 无(纯 Node)    | `node:child_process` + `vscode-jsonrpc`,直接照搬                | 低·直接复用     |
| `LSPServerInstance`(状态机/重试/崩溃恢复)   | 无(纯逻辑)     | 模块级闭包单例                                                  | 低·直接复用     |
| `LSPServerManager`(多 server 路由/文件同步) | 无(纯逻辑)     | 同上                                                            | 低·直接复用     |
| `manager.ts`(全局单例生命周期)              | 启动/退出时机  | `session_start` 内 lazy spawn,`session_shutdown` 内 kill        | 中·改造时机     |
| **诊断被动推送**                            | **上下文注入** | **`context` hook 重写 messages / `before_agent_start.message`** | **中·核心改造** |
| `LSPTool`(9 种操作)                         | 工具注册       | `pi.registerTool({ parameters, execute })`                      | 低·机械改写     |
| `formatters.ts` / `symbolContext.ts`        | 无             | 直接照搬                                                        | 低·直接复用     |
| gitignore 过滤(`git check-ignore`)          | 无             | `ctx.exec("git", ...)` 或直接 spawn                             | 低·直接复用     |
| **配置系统**(plugin `.lsp.json`)            | CC plugin 体系 | **需重写** → 读独立 `@balaenis/pi-lsp/config.json` 或内置配置表 | 中·必须重写     |
| UI 渲染(折叠/展开/推荐菜单)                 | CC 专有 UI     | `renderResult` 可选;推荐菜单用 `ctx.ui.select`                  | 低·可后置/裁剪  |
| 错误通知轮询                                | CC hooks       | `ctx.ui.notify` + 定时器                                        | 低·可后置       |

## 3. 三个关键集成点

### 3.1 工具注册(直接对应)

CC 的 9 种操作映射为 Pi 工具。两种组织方式:

- **单工具 + discriminated union 输入**:贴近 CC 的 `lspToolInputSchema`
- **9 个独立工具**:对 LLM 更直观,工具描述更聚焦

TypeBox schema 用 `Type.Object(...)`;枚举字段必须用 `@earendil-works/pi-ai` 的 `StringEnum`,**不能**用 `Type.Union` / `Type.Literal`(Google API 兼容性限制)。工具输出必须截断(默认 50KB / 2000 行),使用 Pi 导出的 `truncateHead` / `truncateTail`。

### 3.2 被动诊断推送(最核心的改造)

CC 的"被动诊断"是 Agent 无需主动请求、由 LSP server 自动推送的能力。Pi 提供三种可叠加机制:

| 机制                                    | 时机                    | 适用场景                                   |
| --------------------------------------- | ----------------------- | ------------------------------------------ |
| `context` hook                          | 每次 LLM 调用前         | 注入当前诊断 + 剥离上一轮旧诊断(最贴近 CC) |
| `before_agent_start` 返回 `message`     | 每个用户回合开始        | 注入隐藏消息(`display:false`)              |
| `sendMessage({ deliverAs:"nextTurn" })` | LSP server 异步 push 时 | 带外触发,排队到下一回合                    |

CC 的 `LSPDiagnosticRegistry`(LRU 去重 + 限流 30 条 + severity 排序)是纯逻辑,原样保留;只需把"出队"那一步接到 `context` hook 上。**推荐方案**:`context` hook 每次调用前注入新诊断块并剥离旧块,避免上下文堆积——这是对 CC 自动推送行为最忠实的复刻。

> Pi 没有 attachment 一等概念,诊断以普通消息形式注入。语义等价,机制不同;代价是需自行管理"注入/剥离"生命周期。

### 3.3 编辑后文件同步

Pi **没有** `file_edit` 事件。替代方案:监听 `tool_result` 事件,当 `event.toolName === "edit" | "write"` 时:

1. 向 LSP server 发送 `textDocument/didChange` + `didSave`
2. 清理该文件的已投递诊断缓存(对应 CC 的 `clearDeliveredDiagnosticsForFile`),让新诊断能再次展示

**缺口**:用户在 Pi 之外的编辑器修改的文件不会触发该事件,需依赖 LSP server 自身的文件监听,或自建 `fs.watch`(参考 `examples/extensions/file-trigger.ts`)。

## 4. 必须重写 / 无法照搬的部分

1. **配置加载**(最大的一块)
   CC 的 server 配置只来自 plugin(`.lsp.json` + `manifest.lspServers`),配套 Zod schema 校验、`${CLAUDE_PLUGIN_ROOT}` / `${user_config.KEY}` / `$VAR` 三层环境变量替换、`../` 目录穿越防护。Pi 没有这套 plugin 体系。替代:读独立 `@balaenis/pi-lsp/config.json`,或在扩展内置一份 server 配置表。环境变量替换与路径校验逻辑可保留。

2. **生命周期时机**
   CC 在 `setup.ts` 启动。Pi **明确禁止在 factory 里 spawn 进程/起定时器/开 watcher**,必须延迟到 `session_start`。且 `session_shutdown` 在 `/reload`、`/new`、`/resume`、`/fork` 时都会触发,需要在新的 `session_start` 中重建 server。

3. **UI 层**
   CC 的折叠/展开渲染、plugin 推荐菜单、`/doctor` 集成均为 CC 专有。Pi 的 `renderResult` 是可选的,初版可全部裁掉,纯文本输出即可。TUI-only 能力(`ctx.ui.select` / dialog)在非 TUI 模式为 no-op,需用 `ctx.hasUI` 守卫。

## 5. 风险与缺口

| 项                        | 说明                                                   | 缓解                                              |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| 无 attachment 一等概念    | 诊断以消息注入,需管理注入/剥离避免上下文堆积           | `context` hook 出队 + 剥离旧块                    |
| 无文件编辑事件            | 只能拦 `edit`/`write` 工具;外部编辑不可见              | 依赖 LSP 文件监听或自建 `fs.watch`                |
| `vscode-jsonrpc` 依赖     | ~129KB,需进扩展自己的 `package.json` 的 `dependencies` | 目录式扩展 + 独立 `package.json`                  |
| TUI-only UI 在非 TUI 失效 | 推荐菜单等需守卫                                       | `ctx.hasUI` / `ctx.mode === "tui"` 判断           |
| 进程时机约束              | 不能在 factory spawn                                   | `session_start` lazy 启动,`session_shutdown` 清理 |

## 6. 复杂度评估与分阶段建议

整体属于中等复杂度、低风险。建议分三阶段,每阶段独立可用:

- **阶段一(MVP·核心链路)**:`LSPClient` + `LSPServerInstance` + 单 server,硬编码一个 server 配置(如 typescript-language-server),注册 `goToDefinition` / `findReferences` / `hover` 三个工具。验证 spawn / JSON-RPC / 工具调用链路打通。
- **阶段二(被动诊断·差异化价值)**:搬运 `LSPDiagnosticRegistry`,接 `context` hook 推送诊断 + `tool_result` 触发 `didChange` / 清理。这是相对内置 grep 的核心增量价值。
- **阶段三(多 server + 配置 + 补全)**:`LSPServerManager` 多语言路由、`@balaenis/pi-lsp/config.json` 配置加载、补齐 callHierarchy / workspaceSymbol、gitignore 过滤、可选 UI。

详细的模块划分、API 契约、目录结构与各阶段验收标准见[实现规格书](../specs/lsp-extension-spec.md)。
