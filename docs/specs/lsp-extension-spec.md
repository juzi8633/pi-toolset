# Pi LSP 扩展实现规格书

> 可行性评估:[../analysis/lsp-pi-port-feasibility.md](../analysis/lsp-pi-port-feasibility.md)
> 架构参考:[../analysis/lsp-module-architecture.md](../analysis/lsp-module-architecture.md)
> CC 源码参考:`/home/julian/workspace/source/claude-code-2.1.88/package-src/src`

本规格描述把 Claude Code 的 LSP 客户端能力以扩展形式移植到 Pi 的具体实现方案。目标是让 Pi 的 Agent 获得 `goToDefinition` / `findReferences` / `hover` 等语义能力,并被动获得 LSP 诊断。

## 1. 范围

### 1.1 目标(In Scope)

- 启动并管理 LSP server 子进程(stdio + JSON-RPC)
- 文件同步协议(`didOpen` / `didChange` / `didSave` / `didClose`)
- 9 种 LSP 操作作为 Agent 可调用工具
- 被动诊断推送(去重、限流、编辑感知清理)
- 多 server 路由(按文件扩展名)
- 通过 `settings.json` 配置 server

### 1.2 非目标(Out of Scope,初版)

- CC 的 plugin marketplace / 推荐菜单
- socket transport(只支持 stdio)
- `restartOnCrash` 自动重启(手动 restart 命令可选)
- 折叠/展开富 UI(纯文本输出即可)

## 2. 技术约束

- 本扩展是**独立可发布的 Pi package**(`pi-lsp`),根目录唯一 `package.json`,构建产物在 `dist/`
- 核心 SDK(`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` / `typebox`)用 `peerDependencies: "*"`,**不打包**;第三方运行时依赖(`vscode-jsonrpc`)进 `dependencies`
- 进程/定时器/watcher 不得在 factory 启动,只能在 `session_start` 或按需启动
- `session_shutdown` 必须幂等清理(在 `/reload` `/new` `/resume` `/fork` 时都会触发)
- 工具枚举用 `@earendil-works/pi-ai` 的 `StringEnum`,不用 `Type.Union` / `Type.Literal`
- `Type` 从 `@earendil-works/pi-ai` 导入(由 Pi 转出 typebox),不直接依赖 `@sinclair/typebox`
- 工具输出用 `truncateHead` / `truncateTail` 截断
- 全部 `import type` 引用 Pi SDK 类型,与本仓库现有扩展保持一致

## 3. 目录结构

独立仓库,源码在 `src/`,Pi 通过 `pi.extensions` 指向构建产物 `dist/index.js`:

```
pi-lsp/
├── package.json            # 唯一 package.json:pi manifest + deps
├── tsconfig.json           # noEmit,bun 原生(allowImportingTsExtensions)
├── mise.toml / hk.pkl      # 工具链与 lint/check hooks
├── dist/                   # 构建产物,pi.extensions 指向此处
└── src/
    ├── index.ts            # 扩展入口:default export (pi) => void
    ├── client.ts           # LSPClient:spawn + JSON-RPC(照搬 CC LSPClient.ts)
    ├── instance.ts         # LSPServerInstance:状态机/重试/崩溃恢复
    ├── manager.ts          # LSPServerManager:多 server 路由 + 文件同步
    ├── diagnostics.ts      # DiagnosticRegistry:去重 + 限流 + 编辑清理
    ├── tools.ts            # registerTool:9 种操作 + 输入 schema
    ├── formatters.ts       # LSP 响应 → 可读文本(照搬 CC formatters.ts)
    ├── symbol-context.ts   # 光标符号提取(照搬 CC symbolContext.ts)
    ├── config.ts           # settings.json 读取 + 校验 + 环境变量替换
    └── types.ts            # 共享类型
```

注册:`package.json` 的 `pi.extensions` 指向 `./dist/index.js`,其 default export 被识别为扩展。本地迭代可临时把它改成 `./src/index.ts`(Pi 用 jiti 直接加载 `.ts`),或用 `pi -e ./src/index.ts` 试跑。

每个 `.ts` 文件首两行加 `ABOUTME:` 注释(遵循全局规范)。

## 4. 模块规格

### 4.1 `client.ts` — JSON-RPC 通信层

照搬 CC `services/lsp/LSPClient.ts`,工厂函数 `createLSPClient(config)`。保留 CC 已处理的边界:

- `spawn` 后 `once('spawn')` 确认,避免 ENOENT 竞态
- `listen()` 前注册 `onError` / `onClose`
- `process.stdin.on('error')` 单独处理
- connection ready 前的 handler 暂存重放
- `isStopping` 标志 + `shutdown` → `exit` → `kill` 兜底
- `onCrash` 回调向上传播

接口:

```ts
interface LSPClient {
  initialize(params: InitializeParams): Promise<InitializeResult>;
  sendRequest<T>(method: string, params: unknown): Promise<T>;
  sendNotification(method: string, params: unknown): void;
  onNotification(method: string, handler: (params: unknown) => void): void;
  onRequest(method: string, handler: (params: unknown) => unknown): void;
  stop(): Promise<void>;
}
```

`vscode-jsonrpc` 延迟 `require`,只在真正 start 时加载。

### 4.2 `instance.ts` — 单 server 状态机

照搬 CC `LSPServerInstance.ts`。状态机:`stopped → starting → running → stopping`,异常进 `error`。保留:

- `InitializeParams` 新旧字段并存(`rootPath` / `rootUri` / `workspaceFolders`)的兼容矩阵
- `startupTimeout` 用 `Promise.race` + timer 清理
- 崩溃恢复上限 `maxRestarts ?? 3`
- 瞬态错误重试:`-32801`(ContentModified),指数退避 500/1000/2000ms,`MAX_RETRIES = 3`
- `startFailed` / `checkStartFailed()` 前置检查

### 4.3 `manager.ts` — 多 server 路由 + 全局单例

合并 CC 的 `LSPServerManager.ts` + `manager.ts`。数据结构:

```ts
servers: Map<serverName, LSPServerInstance>
extensionMap: Map<ext, serverName[]>      // ".ts" → ["typescript"]
openedFiles: Map<uri, serverName>
```

文件同步协议(幂等):

```
openFile(path, content)   → didOpen
changeFile(path, content) → didChange(首次自动退化为 openFile)
saveFile(path)            → didSave
closeFile(path)           → didClose
```

`workspace/configuration` 请求返回 `items.map(() => null)`。
保留 generation counter 防 stale init。
导出 `getManager()` / `isLspConnected()` 供工具的 `isEnabled` 判断。

### 4.4 `diagnostics.ts` — 被动诊断

照搬 CC `LSPDiagnosticRegistry` 纯逻辑:

- 同批次去重:key = `{message, severity, range, source, code}`
- 跨轮次去重:`LRUCache<fileUri, Set<key>>`(max 500 files)
- 限流:`MAX_DIAGNOSTICS_PER_FILE = 10`,`MAX_TOTAL_DIAGNOSTICS = 30`,按 severity 排序
- `clearDeliveredDiagnosticsForFile(uri)`:编辑后清理

接口:

```ts
interface DiagnosticRegistry {
  register(uri: string, diagnostics: Diagnostic[]): void;   // publishDiagnostics handler 调用
  drain(): string | null;                                    // 出队 + 格式化为注入文本块
  clearForFile(uri: string): void;
}
```

### 4.5 `tools.ts` — 9 种操作

采用**单工具 + discriminated union 输入**(贴近 CC `lspToolInputSchema`)。`operation` 用 `StringEnum`:

```ts
import { Type, StringEnum } from "@earendil-works/pi-ai";

const parameters = Type.Object({
  operation: StringEnum([
    "goToDefinition", "findReferences", "hover",
    "documentSymbol", "workspaceSymbol", "goToImplementation",
    "prepareCallHierarchy", "incomingCalls", "outgoingCalls",
  ]),
  file: Type.Optional(Type.String()),     // workspaceSymbol 不需要
  line: Type.Optional(Type.Number()),     // 1-based
  character: Type.Optional(Type.Number()),
  query: Type.Optional(Type.String()),    // workspaceSymbol 用
});
```

操作 → LSP method 映射(同 CC):

| operation             | LSP method                          |
| --------------------- | ----------------------------------- |
| goToDefinition        | textDocument/definition             |
| findReferences        | textDocument/references             |
| hover                 | textDocument/hover                  |
| documentSymbol        | textDocument/documentSymbol         |
| workspaceSymbol       | workspace/symbol                    |
| goToImplementation    | textDocument/implementation         |
| prepareCallHierarchy  | textDocument/prepareCallHierarchy   |
| incomingCalls         | callHierarchy/incomingCalls         |
| outgoingCalls         | callHierarchy/outgoingCalls         |

`execute` 流程(同 CC):

1. `isLspConnected()` 检查,未就绪返回提示
2. 文件存在性 / 普通文件 / UNC 路径跳过校验
3. 未 open 则读文件(限 10MB)→ `openFile`
4. `manager.sendRequest(uri, method, params)`
5. callHierarchy 两步:先 `prepareCallHierarchy` 拿 item,再请求 calls
6. `filterGitIgnoredLocations`:`git check-ignore` 分批(50/批,5s 超时)
7. `formatResult` → 文本,经 `truncateTail` 截断

### 4.6 `formatters.ts` / `symbol-context.ts`

照搬 CC 同名文件:`formatUri()`、`symbolKindToString()`(27 种)、`groupByFile()`;符号提取只读前 64KB。

### 4.7 `config.ts` — 配置(必须重写)

从 `settings.json` 读 `lsp` 段(全局 `~/.pi/agent/settings.json`,项目 `<cwd>/.pi/settings.json` 覆盖):

```jsonc
{
  "lsp": {
    "servers": {
      "typescript": {
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "extensions": [".ts", ".tsx", ".js", ".jsx"],
        "env": {},                       // 支持 ${VAR} 替换
        "startupTimeout": 10000,
        "maxRestarts": 3
      }
    }
  }
}
```

保留 CC 的 Zod 校验(`command` 不含空格除非绝对路径)、`$VAR` / `${VAR}` 环境变量替换。删去 `${CLAUDE_PLUGIN_ROOT}` 等 plugin 专有项。初版可内置一份默认配置表作为兜底。

### 4.8 `index.ts` — 扩展入口与生命周期

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  // 不在此 spawn 任何进程

  pi.on("session_start", async (_event, ctx) => {
    await initManager(ctx.cwd);          // lazy 启动配置中的 server
  });

  pi.on("session_shutdown", async () => {
    await shutdownManager();             // 幂等
  });

  // 编辑后同步 + 诊断清理
  pi.on("tool_result", async (event) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const path = extractPath(event);
      await getManager()?.changeFileFromDisk(path);   // didChange + didSave
      diagnostics.clearForFile(toUri(path));
    }
  });

  // 被动诊断注入:每次 LLM 调用前,注入新诊断、剥离旧诊断块
  pi.on("context", (event) => {
    const block = diagnostics.drain();
    const messages = stripPreviousDiagnosticBlocks(event.messages);
    if (block) messages.push(makeDiagnosticMessage(block));
    return { messages };
  });

  registerLspTool(pi);                   // 4.5
}
```

`publishDiagnostics` 在每个 server 上注册,handler 调用 `diagnostics.register(uri, list)`。

## 5. 依赖

根目录唯一 `package.json`。依赖分类遵循 Pi package 规则:

- **`dependencies`**(随 package 安装):`vscode-jsonrpc`(运行时 JSON-RPC transport)
- **`peerDependencies: "*"`**(Pi 宿主提供,**不打包**,否则会引入与宿主不同实例的 SDK):`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`typebox`
- **`devDependencies`**:上述 peer 包的本地副本(供 typecheck)、`vscode-languageserver-protocol`(仅类型)、eslint / prettier / vitest 等工具链

```jsonc
{
  "dependencies": {
    "vscode-jsonrpc": "^8.2.1"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "typebox": "*"
  }
}
```

`vscode-languageserver-protocol` 只用其类型,放 `devDependencies`,避免运行时膨胀。

## 6. 分阶段交付与验收标准

### 阶段一 — MVP·核心链路

**交付**:`client.ts` + `instance.ts` + 单 server(硬编码 typescript-language-server)+ `goToDefinition` / `findReferences` / `hover`。

**验收**:
- [ ] 在一个 TS 项目中调用 `goToDefinition` 返回正确 `file:line:col`
- [ ] `findReferences` 返回多文件引用并按文件分组
- [ ] `hover` 返回类型签名
- [ ] server 启动失败时工具返回明确错误而非崩溃
- [ ] `session_shutdown` 后进程被 kill(`ps` 验证无残留)
- [ ] `bunx tsc --noEmit` + `hk check` 通过

### 阶段二 — 被动诊断

**交付**:`diagnostics.ts` + `context` hook 注入 + `tool_result` 触发 `didChange` / 清理。

**验收**:
- [ ] 编辑引入类型错误后,下一回合上下文出现该诊断
- [ ] 修复后诊断不再重复出现(去重生效)
- [ ] 大量诊断时限流到 ≤30 条且 Error 优先
- [ ] 旧诊断块在新 LLM 调用前被剥离(不堆积)
- [ ] `bunx tsc --noEmit` + `hk check` 通过

### 阶段三 — 多 server + 配置 + 补全

**交付**:`manager.ts` 多语言路由 + `config.ts`(settings.json)+ callHierarchy / workspaceSymbol / documentSymbol / goToImplementation + gitignore 过滤。

**验收**:
- [ ] 同会话内 `.ts` 与 `.py` 路由到不同 server
- [ ] `settings.json` 增删 server 后 `/reload` 生效
- [ ] callHierarchy 两步调用返回 incoming/outgoing
- [ ] `.gitignore` 中的文件不出现在结果里
- [ ] `bunx tsc --noEmit` + `hk check` 通过

## 7. 验证

每阶段结束运行 `bunx tsc --noEmit` 做类型检查、`hk check`(eslint + prettier)做 lint/format。功能验证需在真实 TS / Python 项目中实测真实 LSP server(遵循"不使用 mock"约束)。

## 8. 开放问题

- `context` hook 注入诊断 vs `before_agent_start` 注入:需实测哪种在 Pi 中体验更稳(上下文位置、是否被 compaction 影响)
- 文件 URI ↔ 路径转换在 WSL / Windows 下的一致性
- `tool_result` 事件中如何稳定提取被编辑文件路径(依赖内置 edit/write 工具的 `details` 形状)
- 多 server 并发启动的资源占用上限是否需要限制
