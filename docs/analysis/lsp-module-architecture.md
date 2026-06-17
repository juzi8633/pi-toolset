# Claude Code LSP 模块架构分析

> 基于 `claude-code-2.1.88/package-src/src` 源码分析

## 1. 总览

Claude Code 的 LSP 模块实现了完整的 Language Server Protocol 客户端，让 AI Coding Agent 能够像 IDE 一样获取代码语义信息。模块由 **18 个核心源文件** 组成，分为五个子层：

| 层         | 文件数 | 目录                           | 职责                                       |
| ---------- | ------ | ------------------------------ | ------------------------------------------ |
| 通信层     | 1      | `services/lsp/LSPClient.ts`    | 进程启动 + JSON-RPC 通信                   |
| 实例层     | 1      | `services/lsp/LSPServerInstance.ts` | 单 server 生命周期 + 状态机 + 重试         |
| 管理层     | 2      | `services/lsp/LSPServerManager.ts` + `manager.ts` | 多 server 路由 + 全局单例      |
| 诊断层     | 2      | `services/lsp/`                | 被动诊断收集 + 去重 + 限流                |
| 工具层     | 6      | `tools/LSPTool/`               | 9 种 LSP 操作 API + 格式化 + UI            |
| 配置/集成  | 4      | `services/lsp/` + `utils/plugins/` | Plugin 加载 + Schema 校验 + 推荐       |
| UI 通知    | 2      | `hooks/notifs/` + `components/`| 错误通知 + Plugin 推荐                     |

## 2. 架构图

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            Tool: LSPTool                                 │
│  goToDefinition / findReferences / hover / documentSymbol /              │
│  workspaceSymbol / goToImplementation / prepareCallHierarchy /           │
│  incomingCalls / outgoingCalls                                           │
│                                                                          │
│  formatters.ts ── symbolContext.ts ── UI.tsx ── schemas.ts ── prompt.ts │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ 调用 sendRequest(uri, method, params)
┌──────────────────────────────▼───────────────────────────────────────────┐
│                       manager.ts (全局单例)                               │
│  initializeLspServerManager() / getLspServerManager() / shutdown()       │
│  isLspConnected() / reinitializeLspServerManager()                       │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────────────┐
│                    LSPServerManager (单例创建)                             │
│  extensionMap: .ts → [plugin:typst-lsp:typst]                            │
│  servers: Map<name, LSPServerInstance>                                   │
│  openedFiles: Map<uri, serverName>                                       │
│                                                                          │
│  getServerForFile(ext) → sendRequest() → openFile/changeFile/saveFile    │
└──────────────────────┬───────────────────┬───────────────────────────────┘
                       │                   │
       ┌───────────────▼──────┐   ┌────────▼──────────────────────────────┐
       │  LSPServerInstance   │   │  passiveFeedback.ts                   │
       │  (per server)        │   │  + LSPDiagnosticRegistry              │
       │                      │   │                                        │
       │  state machine:      │   │  注册 textDocument/publishDiagnostics  │
       │  stopped → starting  │   │  → formatDiagnosticsForAttachment()   │
       │         → running    │   │  → registerPendingLSPDiagnostic()     │
       │         → stopping   │   │  → checkForLSPDiagnostics() 出队      │
       │         → error      │   │  → 去重(dedup) + 限流(30 total)       │
       │                      │   │                                        │
       │  crash recovery:     │   └──────────────────────────────────────┘
       │  max 3 restarts      │
       │  retry on -32801     │
       └──────────┬───────────┘
                  │
┌─────────────────▼────────────────────────────────────────────────────────┐
│                          LSPClient                                       │
│  spawn(command, args, env) → child_process                              │
│  StreamMessageReader / StreamMessageWriter                               │
│  createMessageConnection (vscode-jsonrpc)                                │
│                                                                          │
│  initialize(InitializeParams) → capabilities                             │
│  sendRequest(method, params) → TResult                                   │
│  sendNotification(method, params)                                        │
│  onNotification / onRequest (反向请求)                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

## 3. 核心层详解

### 3.1 LSPClient — JSON-RPC 通信层

**文件**: `services/lsp/LSPClient.ts`

这是最底层的抽象，封装了与 LSP 服务器进程的 stdio 通信。

**关键实现**：

```typescript
// 1. 启动 LSP 服务器子进程
process = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd })

// 2. 等待 spawn 事件确认进程成功启动（防止 ENOENT 等错误变成未处理 rejection）
await new Promise<void>((resolve, reject) => {
  process.once('spawn', resolve)
  process.once('error', reject)
})

// 3. 创建 vscode-jsonrpc 连接
const reader = new StreamMessageReader(process.stdout)
const writer = new StreamMessageWriter(process.stdin)
connection = createMessageConnection(reader, writer)
connection.listen()

// 4. 初始化握手
const result = await connection.sendRequest('initialize', params)
capabilities = result.capabilities
await connection.sendNotification('initialized', {})
```

**精心处理的边界情况**：
- **spawn ENOENT 竞态**: `spawn()` 返回后进程可能立即失败。通过 `once('spawn')` 确认成功，避免了对无效 stream 的写入变成 `unhandledPromiseRejection`
- **连接错误/关闭**: 在 `listen()` 之前注册 `onError`/`onClose` handler，杜绝时序问题
- **stdin stream 错误**: 单独处理 `process.stdin.on('error')`，防止 LSP 进程提前退出导致写入失败
- **Queue handlers**: 在 connection 建立前注册的 notification/request handler 会被暂存，connection ready 后重放
- **stop 安全**: 使用 `isStopping` 标志防止退出时的虚假错误日志，先 `shutdown` 再 `exit`，最后 `kill` 兜底
- **Crash 传播**: `onCrash` 回调将崩溃状态传播给上层 `LSPServerInstance`，触发后续重启逻辑

### 3.2 LSPServerInstance — 单服务器状态机

**文件**: `services/lsp/LSPServerInstance.ts`

封装单个 LSP 服务器的完整生命周期，用闭包管理私有状态（避免 class）。

**状态机**：
```
stopped → starting → running → stopping → stopped
   ↑                    ↓
   └──────────────── error ←────────────────┘
```

**关键设计**：

#### 延迟加载 vscode-jsonrpc
```typescript
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLSPClient } = require('./LSPClient.js') as { ... }
```
`vscode-jsonrpc` (~129KB) 只在真正需要启动 LSP server 时才加载，而非模块 import 时。

#### InitializeParams — 兼容性矩阵
```typescript
const initParams: InitializeParams = {
  processId: process.pid,
  rootPath: workspaceFolder,        // 已废弃，但 typescript-language-server 仍需要
  rootUri: workspaceUri,             // LSP 3.16 废弃，但某些 server 仍依赖
  workspaceFolders: [{ uri, name }], // LSP 3.16+ 标准
  capabilities: {
    textDocument: {
      publishDiagnostics: { relatedInformation: true, ... },
      hover: { contentFormat: ['markdown', 'plaintext'] },
      definition: { linkSupport: true },
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      callHierarchy: { dynamicRegistration: false },
    },
    workspace: { configuration: false, workspaceFolders: false },
    general: { positionEncodings: ['utf-16'] },
  },
}
```
同时提供新旧字段，覆盖 ts-server / rust-analyzer / pyright / gopls 等 server 的兼容需求。

#### 启动超时
```typescript
if (config.startupTimeout !== undefined) {
  await withTimeout(initPromise, config.startupTimeout, `...`)
} else {
  await initPromise
}
```
`withTimeout` 内部用 `Promise.race` 实现，且清理 timer 防止 orphaned callback。

#### Crash 恢复上限
```typescript
const maxRestarts = config.maxRestarts ?? 3
if (state === 'error' && crashRecoveryCount > maxRestarts) {
  throw new Error(`exceeded max crash recovery attempts (${maxRestarts})`)
}
```
防止崩溃的 server 不断重启（每次 `ensureServerStarted` 都会触发）。

#### 瞬态错误重试（rust-analyzer ContentModified）
```typescript
const LSP_ERROR_CONTENT_MODIFIED = -32801
const MAX_RETRIES = 3
// 指数退避: 500ms → 1000ms → 2000ms
for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  try { return await client.sendRequest(method, params) }
  catch (error) {
    if (error.code === -32801 && attempt < MAX_RETRIES) {
      await sleep(500 * Math.pow(2, attempt))
      continue
    }
    throw error
  }
}
```
## 3.3 LSPServerManager — 多服务器路由

**文件**: `services/lsp/LSPServerManager.ts`

管理多个 LSP server，核心数据结构：

```typescript
servers: Map<serverName, LSPServerInstance>  // "plugin:ts-lsp:ts" → instance
extensionMap: Map<ext, serverName[]>          // ".ts" → ["plugin:ts-lsp:ts"]
openedFiles: Map<uri, serverName>            // "file:///a.ts" → "plugin:ts-lsp:ts"
```

**文件同步协议**：
```
openFile(path, content)  → didOpen  { uri, languageId, version, text }
changeFile(path, content) → didChange { uri, version, contentChanges }
saveFile(path)            → didSave   { uri }
closeFile(path)           → didClose  { uri }
```

- `changeFile` 如果是首次同步会自动退化为 `openFile`
- `openFile` 幂等：已打开不重复发送
- `saveFile` 用于写完磁盘后触发 server 重新诊断

**workspace/configuration 处理**：
```typescript
instance.onRequest('workspace/configuration', (params) => {
  return params.items.map(() => null) // 返回空配置，满足协议但不提供实际配置
})
```

### 3.4 manager.ts — 全局单例

**文件**: `services/lsp/manager.ts`

管理 LSP 系统的全局生命周期：

```
initializeLspServerManager()  ← 启动时调用（不阻塞）
  ├── 创建 LSPServerManager 实例
  ├── 启动 async initialize()（加载 plugin 配置）
  ├── 成功后 registerLSPNotificationHandlers()
  └── 失败后设为 undefined

shutdownLspServerManager()    ← 退出时调用
reinitializeLspServerManager() ← /reload-plugins 时调用
```

**Generation Counter** 防止 stale init：
```typescript
let initializationGeneration = 0
// 每次 init 时 ++generation
// 完成后检查 currentGeneration === initializationGeneration
// 防止快速重试导致旧 promise 覆盖新状态
```

**isLspConnected()** 支持 `LSPTool.isEnabled()`：
```typescript
export function isLspConnected(): boolean {
  if (initializationState === 'failed') return false
  const manager = getLspServerManager()
  if (!manager) return false
  for (const server of manager.getAllServers().values()) {
    if (server.state !== 'error') return true  // 至少有一个非 error server
  }
  return false
}
```

## 4. 诊断系统（Passive Feedback）

这是 LSP 能力的"被动"利用——Agent 无需主动请求，LSP server 会自动推送诊断信息。

### 4.1 流程

```
LSP Server → publishDiagnostics notification
  → passiveFeedback.ts handler (注册在每个 server 上)
  → formatDiagnosticsForAttachment() → 转换 URI、映射 severity
  → registerPendingLSPDiagnostic() → 存入 Registry
  → (下一轮对话时)
  → checkForLSPDiagnostics() → 出队 + 去重 + 限流
  → 作为 Attachment 发送给 LLM
```

### 4.2 LSPDiagnosticRegistry 核心机制

**去重**：
- **同批次内**: 按 `{message, severity, range, source, code}` 生成 key，同文件内去重
- **跨轮次**: 用 `LRUCache<fileUri, Set<key>>`（max 500 files）追踪已投递的诊断，避免对同一代码问题重复提示

**限流**：
```typescript
MAX_DIAGNOSTICS_PER_FILE = 10  // 每文件最多 10 条
MAX_TOTAL_DIAGNOSTICS = 30     // 总计最多 30 条
```
按 severity 排序（Error > Warning > Info > Hint），优先保留严重问题。

**编辑感知清理**：
```typescript
clearDeliveredDiagnosticsForFile(fileUri)
```
当 Agent 编辑文件后调用，让新产生的相同诊断能再次被展示。

## 5. LSP Tool — 9 种操作

**文件**: `tools/LSPTool/LSPTool.ts`

### 5.1 支持的操作

| 操作                   | LSP Method                        | 说明                     |
| ---------------------- | --------------------------------- | ------------------------ |
| `goToDefinition`      | `textDocument/definition`         | 跳转到定义               |
| `findReferences`      | `textDocument/references`         | 查找引用                 |
| `hover`               | `textDocument/hover`              | 悬停信息（类型/文档）    |
| `documentSymbol`      | `textDocument/documentSymbol`     | 文档符号大纲             |
| `workspaceSymbol`     | `workspace/symbol`                | 工作区符号搜索           |
| `goToImplementation`  | `textDocument/implementation`     | 跳转到实现               |
| `prepareCallHierarchy`| `textDocument/prepareCallHierarchy`| 准备调用层次             |
| `incomingCalls`       | `callHierarchy/incomingCalls`     | 谁调用了这个函数         |
| `outgoingCalls`       | `callHierarchy/outgoingCalls`     | 这个函数调用了谁         |

### 5.2 调用流程

```
1. waitForInitialization() — 等待 LSP 系统就绪
2. getLspServerManager() — 获取全局 manager
3. 检查 isFileOpen()，未打开则：
   a. 读取文件内容（限 10MB）
   b. manager.openFile() → didOpen
4. manager.sendRequest(uri, method, params)
5. (对于 incomingCalls/outgoingCalls) 两步：
   a. 先 prepareCallHierarchy 获取 CallHierarchyItem
   b. 再用 item 请求 calls
6. filterGitIgnoredLocations() — 过滤被 .gitignore 排除的文件
7. formatResult() → 人性化输出
```

### 5.3 Gitignore 过滤

```typescript
async function filterGitIgnoredLocations(locations, cwd) {
  // 提取唯一文件路径
  const uniquePaths = uniq(locations.map(l => uriToFilePath(l.uri)))
  // 批量调用 git check-ignore（每批 50 个，5s 超时）
  for (batch of chunks(uniquePaths, 50)) {
    const result = await execFileNoThrowWithCwd('git', ['check-ignore', ...batch], { cwd })
    // 收集被忽略的路径
  }
  // 从结果中移除被忽略的路径
  return locations.filter(loc => !ignoredPaths.has(path))
}
```

### 5.4 输入验证

`validateInput` 使用 discriminated union（`lspToolInputSchema`），支持 9 种操作的精确类型。额外检查：
- 文件是否存在
- 是否为普通文件
- UNC 路径跳过（防止 NTLM credential leak）

## 6. 格式化层

**文件**: `tools/LSPTool/formatters.ts`

将 LSP 原始响应转换为 Agent 可读的文本：

```
goToDefinition → "Defined in src/foo.ts:42:10"
                 "Found 3 definitions:\n  src/a.ts:10:5\n  src/b.ts:20:3"

findReferences → "Found 15 references across 4 files:\n\nsrc/a.ts:\n  Line 10:5\n..."

hover          → "Hover info at 42:10:\n\nfunction foo(x: number): string"

documentSymbol → "Document symbols:\nFoo (Class) - Line 10\n  bar (Method) - Line 15"

workspaceSymbol → "Found 42 symbols in workspace:\n\nsrc/a.ts:\n  Foo (Class) - Line 10"
```

统一处理：
- `formatUri()`: 解 `file://` URI → 相对路径，解码百分号编码
- `symbolKindToString()`: 27 种 SymbolKind 枚举 → 可读字符串
- `groupByFile()`: 按文件分组结果，输出时层次清晰

## 7. 配置系统

### 7.1 配置来源

LSP server 配置只来自 **plugins**（不支持用户/项目级别的 setting）。

**Plugin 配置两种来源**：
1. **`.lsp.json` 文件**（plugin 根目录）
2. **`manifest.lspServers` 字段**（可内联或引用外部 JSON）

### 7.2 Schema 校验

`LspServerConfigSchema` (Zod) 定义：

```typescript
z.strictObject({
  command: z.string().min(1)
    .refine(cmd => !cmd.includes(' ') || cmd.startsWith('/')),
  args: z.array(nonEmptyString()).optional(),
  extensionToLanguage: z.record(fileExtension(), nonEmptyString())
    .refine(r => Object.keys(r).length > 0),
  transport: z.enum(['stdio', 'socket']).default('stdio'),
  env: z.record(z.string(), z.string()).optional(),
  initializationOptions: z.unknown().optional(),
  settings: z.unknown().optional(),
  workspaceFolder: z.string().optional(),
  startupTimeout: z.number().int().positive().optional(),
  shutdownTimeout: z.number().int().positive().optional(), // 声明但未实现
  maxRestarts: z.number().int().min(0).optional(),          // 声明但未实现
  restartOnCrash: z.boolean().optional(),                    // 声明但未实现
})
```

### 7.3 环境变量替换

`resolvePluginLspEnvironment()` 处理三层替换：
1. `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` → 插件目录
2. `${user_config.KEY}` → 用户在 plugin options 中配置的值
3. `$VAR` / `${VAR}` → 系统环境变量

### 7.4 安全校验

```typescript
function validatePathWithinPlugin(pluginPath, relativePath) {
  const resolved = resolve(pluginPath, relativePath)
  // 检查是否在插件目录内
  if (relative(pluginPath, resolved).startsWith('..')) return null
  return resolved
}
```
防止 `manifest.lspServers` 通过 `../` 进行目录穿越攻击。

## 8. UI 集成

### 8.1 LSP 工具结果渲染

**文件**: `tools/LSPTool/UI.tsx`

- **折叠模式**（默认）: `Found 15 references across 4 files [Ctrl+O to expand]`
- **展开模式** (verbose): `⎿ Found 15 references across 4 files\n  src/a.ts:\n    Line 10:5 ...`
- **错误显示**: 简化为 `LSP operation failed`，展开时显示完整错误

### 8.2 符号上下文提取

**文件**: `tools/LSPTool/symbolContext.ts`

```typescript
export function getSymbolAtPosition(filePath, line, character) {
  // 只读前 64KB（~1000 行），避免大文件 I/O
  const { buffer } = fs.readSync(absolutePath, { length: 64 * 1024 })
  // 正则: [\w$'!]+ | [运算符]+
  const symbolPattern = /[\w$'!]+|[+\-*/%&|^~<>=]+/g
  // 匹配光标位置的 symbol，截断到 30 字符
}
```

用于 tool use message 中展示被操作的符号名，例如：
```
operation: "goToDefinition", symbol: "handleClick", in: "src/App.tsx"
```

### 8.3 错误通知

**文件**: `hooks/notifs/useLspInitializationNotification.tsx`

- 每 5 秒轮询 LSP 状态
- Manager 初始化失败 → 通知 `LSP initialization failed`
- 单个 server 进入 error 状态 → 通知 `LSP for ts-server failed · /plugin for details`
- 去重：已通知过的错误不再重复
- 同步到 `appState.plugins.errors`（`/doctor` 可见）

### 8.4 Plugin 推荐

**文件**: `components/LspRecommendation/LspRecommendationMenu.tsx` + `hooks/useLspPluginRecommendation.tsx`

当 Agent 操作的文件类型有对应的 marketplace plugin 时，弹出推荐菜单：
- "Yes, install X" / "No, not now" / "Never for X" / "Disable all LSP recommendations"
- 30 秒自动消失（默认忽略）

## 9. 关键设计模式总结

### 9.1 闭包工厂模式（避免 class）
```typescript
export function createLSPServerManager(): LSPServerManager {
  const servers: Map<string, LSPServerInstance> = new Map()
  // ...
  return { initialize, shutdown, getServerForFile, ... }
}
```
所有模块使用工厂函数 + 闭包，不用 class，保持私有状态的真实封装。

### 9.2 懒加载
- `vscode-jsonrpc` (~129KB) 在 `LSPServerInstance.start()` 时才 `require()`
- LSP server 在 `ensureServerStarted()` 时才启动（on-demand）

### 9.3 优雅降级
- LSP 是可选功能：`--bare` 模式跳过，初始化失败不阻塞启动
- 配置加载失败不回滚整个系统：单个 server 失败不影响其他 server
- 诊断处理中的任何异常都被捕获，不破坏 notification 循环

### 9.4 防御编程
- `startFailed` / `checkStartFailed()` 在每次请求前检查，提供明确错误信息而非 `undefined is not a function`
- URI 解码容错：malformed URI 使用原始路径
- `undefined` location.uri 在多个层级被过滤并记录
- 每层都有专属的 `logError` + `logForDebugging`，生产监控友好

### 9.5 上线时尚未实现的能力
- `restartOnCrash` — Server 崩溃后自动重启（手动 restart 已实现）
- `shutdownTimeout` — 可配置的 shutdown 超时
- `closeFile()` — closeFile 操作已实现但未与 compaction 集成（TODO 注释）

## 10. 与其他模块的关系

```
initializeLspServerManager()  ← setup.ts（启动时调用）
shutdownLspServerManager()    ← 退出流程
reinitializeLspServerManager() ← refreshActivePlugins()（/reload-plugins）
LSPTool.isEnabled()           ← Tool registration 时检查 isLspConnected()
```

扩展点的 Register 使用 `LspServerConfigSchema` 校验 manifest 中的 `lspServers` 声明。
