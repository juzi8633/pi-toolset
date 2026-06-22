# Pull Diagnostics Implementation Plan

**Goal:** Add LSP 3.17 `textDocument/diagnostic` pull diagnostics support so servers such as `vscode-eslint-language-server` can surface diagnostics through the existing pi-lsp passive diagnostic injection pipeline.

**Inputs:** User request on 2026-06-22 to implement `textDocument/diagnostic` support; repository evidence from `packages/pi-lsp/src/client.ts`, `packages/pi-lsp/src/instance.ts`, `packages/pi-lsp/src/manager.ts`, `packages/pi-lsp/src/diagnostics.ts`, `packages/pi-lsp/src/recipes.ts`, `packages/pi-lsp/tests/manager.test.ts`, and `packages/pi-lsp/fixtures/phase2-diagnostics/`.

**Assumptions:**

- The first implementation only needs document pull diagnostics (`textDocument/diagnostic`), not workspace pull diagnostics (`workspace/diagnostic`).
- The client will not send `previousResultId` initially; every pull request asks for a fresh full diagnostic report, avoiding result-id cache state in this pass.
- Related-document diagnostic reports can be ignored in the first pass because the client will advertise `relatedDocumentSupport: false`.
- Pull diagnostic failures must be logged and swallowed so a lint server failure cannot block edit/write tool flows.

**Architecture:** Keep the existing push diagnostic path unchanged and add a second path for servers that advertise `capabilities.diagnosticProvider`. After file lifecycle synchronization (`didOpen` or edit-driven `didChange` + `didSave`), the manager will send `textDocument/diagnostic` to each active, open, pull-capable server and register full report items through the existing `diagnostics.register(serverName, uri, items)` entry point. The implementation also makes server `settings` deliverable through `workspace/configuration`, because the extracted ESLint server requires a non-null configuration object before it can resolve ESLint and compute pull diagnostics.

**Tech Stack:** TypeScript, Bun test runner, `vscode-languageserver-protocol`, `vscode-languageserver-types`, `vscode-jsonrpc`, pi extension lifecycle hooks.

---

## File Map

- Modify: `packages/pi-lsp/src/instance.ts` — advertise pull diagnostic client capability and expose initialized server capabilities to the manager.
- Modify: `packages/pi-lsp/src/manager.ts` — return configured server settings through `workspace/configuration`, request `textDocument/diagnostic` from pull-capable active servers, and register returned diagnostics.
- Modify: `packages/pi-lsp/src/recipes.ts` — give the built-in ESLint recipe a safe default settings object required by `vscode-eslint-language-server` pull diagnostics.
- Modify: `packages/pi-lsp/src/types.ts` — update the `settings` comment to describe delivered `workspace/configuration` settings.
- Modify: `packages/pi-lsp/README.md` — document that `settings` are delivered, note push and pull passive diagnostic support, and clarify ESLint companion behavior.
- Modify: `packages/pi-lsp/fixtures/phase2-diagnostics/README.md` — update the ESLint smoke test expectation to require pull diagnostic support.
- Test: `packages/pi-lsp/tests/manager.test.ts` — add manager-level coverage for pull diagnostic requests, registration, and failure isolation.
- Test: `packages/pi-lsp/tests/recipes.test.ts` — assert the detected ESLint recipe includes default settings.
- Test: `packages/pi-lsp/tests/instance-state-change.test.ts` — assert initialize capabilities include `textDocument.diagnostic` and `workspace.configuration` support, and that server capabilities are exposed after start.

## Tasks

### Task 1: Expose pull diagnostic capabilities from server instances

**Outcome:** The manager can tell whether a running server supports pull diagnostics by reading `server.capabilities?.diagnosticProvider`.

**Files:**

- Modify: `packages/pi-lsp/src/instance.ts`
- Test: `packages/pi-lsp/tests/instance-state-change.test.ts`

**Steps:**

- [ ] In `packages/pi-lsp/src/instance.ts`, extend the `LSPServerInstance` type with `readonly capabilities: ServerCapabilities | undefined`.
- [ ] Import `ServerCapabilities` from `vscode-languageserver-protocol` alongside `InitializeParams`.
- [ ] In the object returned by `createLSPServerInstance`, add a `get capabilities()` accessor that returns `client.capabilities`.
- [ ] In the `InitializeParams.capabilities.textDocument` object, add:

  ```ts
  diagnostic: {
    dynamicRegistration: false,
    relatedDocumentSupport: false,
    markupMessageSupport: false,
  },
  ```

- [ ] In the `InitializeParams.capabilities.workspace` object, change `configuration` from `false` to `true` because the manager will now answer `workspace/configuration` requests.
- [ ] In `packages/pi-lsp/tests/instance-state-change.test.ts`, extend the fake client factory to capture the `InitializeParams` passed to `client.initialize()`.
- [ ] Add a test that starts an instance and asserts the captured initialize params contain `workspace.configuration === true` and `textDocument.diagnostic.dynamicRegistration === false`.
- [ ] Add a test that returns `{ capabilities: { diagnosticProvider: { identifier: 'eslint', interFileDependencies: false, workspaceDiagnostics: false } } }` from the fake client initialize call and asserts `server.capabilities?.diagnosticProvider` is defined after `await server.start()`.

**Validation:**

- Run: `mise run test --package packages/pi-lsp -- tests/instance-state-change.test.ts`
- Expected: the instance tests pass, including the new initialize capability and exposed capability assertions.

### Task 2: Deliver server settings through workspace/configuration

**Outcome:** Servers that request `workspace/configuration` receive their configured `settings` object instead of `null`; servers without settings keep the old null response.

**Files:**

- Modify: `packages/pi-lsp/src/manager.ts`
- Modify: `packages/pi-lsp/src/types.ts`
- Test: `packages/pi-lsp/tests/manager.test.ts`

**Steps:**

- [ ] In `packages/pi-lsp/src/manager.ts`, add a private helper near the existing `workspace/configuration` handler:

  ```ts
  function getWorkspaceConfigurationResponse(
    config: ScopedLspServerConfig,
    items: Array<{ section?: string }>
  ): unknown[] {
    return items.map(() => buildServerSettings(config));
  }
  ```

- [ ] Add `buildServerSettings(config: ScopedLspServerConfig): unknown` that returns `null` when `config.settings === undefined`, returns non-object settings unchanged, and returns object settings merged with a dynamic `workspaceFolder` when that property is absent:

  ```ts
  const workspaceFolder = config.workspaceFolder ?? process.cwd();
  return {
    ...settings,
    workspaceFolder: settings.workspaceFolder ?? {
      uri: pathToFileURL(workspaceFolder).href,
      name: path.basename(workspaceFolder),
    },
  };
  ```

- [ ] Replace the current `workspace/configuration` handler body in `initialize()` with a call to `getWorkspaceConfigurationResponse(config, params.items ?? [])`.
- [ ] Keep the existing debug log, but change the message to include the number of requested items: `LSP: Received workspace/configuration request from ${serverName} (${items.length} item(s))`.
- [ ] In `packages/pi-lsp/src/types.ts`, change the `settings` comment from “pushed via workspace/didChangeConfiguration” to “returned from workspace/configuration”.
- [ ] In `packages/pi-lsp/tests/manager.test.ts`, update `FakeInstance` to store request handlers registered through `onRequest(method, handler)` in a `Map<string, (params: unknown) => unknown | Promise<unknown>>`.
- [ ] Add a test that creates an ESLint companion with `settings: { validate: 'on', packageManager: 'npm' }`, fetches the fake instance’s `workspace/configuration` handler, invokes it with `{ items: [{ section: '' }] }`, and asserts the returned array contains an object with `validate: 'on'`, `packageManager: 'npm'`, and `workspaceFolder.uri` equal to the test cwd URI.
- [ ] Add a test that creates a TypeScript primary without `settings`, invokes its `workspace/configuration` handler with `{ items: [{ section: 'typescript' }] }`, and asserts the result is `[null]`.

**Validation:**

- Run: `mise run test --package packages/pi-lsp -- tests/manager.test.ts`
- Expected: the manager tests pass, including settings delivery and null-preserving behavior for servers without settings.

### Task 3: Add ESLint recipe default settings

**Outcome:** Auto-detected `eslint` servers have the non-null settings object that `vscode-eslint-language-server` needs to resolve ESLint and run pull diagnostics.

**Files:**

- Modify: `packages/pi-lsp/src/recipes.ts`
- Test: `packages/pi-lsp/tests/recipes.test.ts`

**Steps:**

- [ ] In `packages/pi-lsp/src/recipes.ts`, extend the internal recipe type with `settings?: unknown`.
- [ ] Add a constant near the built-in recipes:

  ```ts
  const ESLINT_DEFAULT_SETTINGS = {
    validate: 'on',
    packageManager: 'npm',
    useESLintClass: true,
    useFlatConfig: true,
    experimental: { useFlatConfig: false },
    nodePath: null,
    workingDirectory: { mode: 'location' },
    codeAction: {
      disableRuleComment: { enable: true, location: 'separateLine' },
      showDocumentation: { enable: true },
    },
    codeActionOnSave: { enable: false, mode: 'all' },
    format: false,
    onIgnoredFiles: 'off',
    options: {},
    problems: { shortenToSingleLine: false },
    quiet: false,
    rulesCustomizations: [],
    run: 'onType',
  };
  ```

- [ ] Attach `settings: ESLINT_DEFAULT_SETTINGS` to the built-in ESLint recipe.
- [ ] In `getDetectedRecipeServers()`, copy `recipe.settings` into the returned `ScopedLspServerConfig` when present.
- [ ] In `packages/pi-lsp/tests/recipes.test.ts`, extend the existing ESLint recipe assertion to verify `detected.eslint!.settings` is an object containing `validate: 'on'`, `packageManager: 'npm'`, `useFlatConfig: true`, and `workingDirectory: { mode: 'location' }`.

**Validation:**

- Run: `mise run test --package packages/pi-lsp -- tests/recipes.test.ts`
- Expected: recipe tests pass and confirm the ESLint recipe carries default settings.

### Task 4: Request and register document pull diagnostics

**Outcome:** After file sync, active pull-capable servers return diagnostics through `textDocument/diagnostic`, and those diagnostics are injected through the existing registry on the next context turn.

**Files:**

- Modify: `packages/pi-lsp/src/manager.ts`
- Test: `packages/pi-lsp/tests/manager.test.ts`

**Steps:**

- [ ] In `packages/pi-lsp/src/manager.ts`, import these protocol types from `vscode-languageserver-protocol`:

  ```ts
  import type {
    DocumentDiagnosticParams,
    DocumentDiagnosticReport,
  } from 'vscode-languageserver-protocol';
  ```

- [ ] Add a helper `getDiagnosticProviderIdentifier(server: LSPServerInstance): string | undefined` that returns `server.capabilities.diagnosticProvider.identifier` only when `diagnosticProvider` is an object and the identifier is a non-empty string.
- [ ] Add a helper `hasPullDiagnostics(server: LSPServerInstance): boolean` that returns `true` when `server.capabilities?.diagnosticProvider` is defined.
- [ ] Add a helper `extractFullDiagnostics(report: DocumentDiagnosticReport): LspDiagnostic[] | undefined` that returns `report.items` when `report.kind === 'full'`; returns `undefined` for `kind === 'unchanged'` and logs `LSP: pull diagnostics from ${server.name} unchanged for ${fileUri}` at the call site.
- [ ] Add a private async function `pullDiagnosticsForFile(filePath: string): Promise<void>` that:
  - Resolves `fileUri` with `pathToFileURL(path.resolve(filePath)).href`.
  - Iterates over `getServersForFile(filePath)`.
  - Skips servers that are not `running`, do not have the file open in `openedFiles`, or do not have `diagnosticProvider`.
  - Sends `server.sendRequest<DocumentDiagnosticReport>('textDocument/diagnostic', params)` where `params` is:

    ```ts
    const params: DocumentDiagnosticParams = {
      textDocument: { uri: fileUri },
      ...(identifier ? { identifier } : {}),
    };
    ```

  - Calls `diagnostics.register(server.name, fileUri, items)` for `kind: 'full'` reports, including empty `items` so clean pull results clear that server’s pending diagnostics.
  - Catches request errors per server and logs `LSP: pull diagnostics failed for ${filePath} on ${server.name}: ${errorMessage(error)}` without throwing.

- [ ] Call `await pullDiagnosticsForFile(filePath)` at the end of `openFile(filePath, content)` after all `didOpen` notifications finish.
- [ ] Call `await pullDiagnosticsForFile(filePath)` at the end of `syncFileChange(filePath)` after `await changeFile(filePath, content)` and `await saveFile(filePath)`.
- [ ] Do not call `pullDiagnosticsForFile()` inside `changeFile()` or `saveFile()` to avoid duplicate pulls during `syncFileChange()`.
- [ ] In `packages/pi-lsp/tests/manager.test.ts`, update the fake instance to accept optional fake server capabilities and optional request return values for `textDocument/diagnostic`.
- [ ] Add a test that creates a TypeScript primary without `diagnosticProvider` and an ESLint companion with `diagnosticProvider: { identifier: 'eslint', interFileDependencies: false, workspaceDiagnostics: false }`, configures the fake ESLint request response as `{ kind: 'full', items: [diagnostic with message 'Unexpected console statement.', source 'eslint', code 'no-console'] }`, writes `src/app.ts`, calls `await manager.syncFileChange(filePath)`, and asserts:
  - The ESLint fake instance has one `textDocument/diagnostic` request.
  - The request params include `textDocument.uri` for `filePath` and `identifier: 'eslint'`.
  - The TypeScript fake instance has no `textDocument/diagnostic` request.
  - `diagnostics.drain(cwdDir)` contains `Unexpected console statement.` and `[no-console]`.
- [ ] Add a test where the fake ESLint `textDocument/diagnostic` request throws `new Error('diagnostic pull failed')`, then assert `await manager.syncFileChange(filePath)` resolves, lifecycle notifications were still sent, and `diagnostics.drain(cwdDir)` returns `null`.
- [ ] Add a test where the fake ESLint pull response is `{ kind: 'full', items: [] }`, after first registering an ESLint diagnostic for the same URI with `diagnostics.register('eslint', uri, [diag])`, then assert `await manager.syncFileChange(filePath)` followed by `diagnostics.drain(cwdDir)` does not contain the old ESLint message.

**Validation:**

- Run: `mise run test --package packages/pi-lsp -- tests/manager.test.ts tests/diagnostics.test.ts`
- Expected: pull-capable servers are requested, diagnostics are registered/cleared correctly, request failures do not throw, and existing diagnostic registry behavior remains unchanged.

### Task 5: Update documentation and smoke-test instructions

**Outcome:** Users know that pi-lsp supports both push and pull diagnostics, and the phase2 ESLint smoke test accurately describes the required behavior.

**Files:**

- Modify: `packages/pi-lsp/README.md`
- Modify: `packages/pi-lsp/fixtures/phase2-diagnostics/README.md`

**Steps:**

- [ ] In `packages/pi-lsp/README.md`, update the configuration table entry for `settings` from “Accepted for schema compatibility; not delivered to the server yet” to “Returned to the server from `workspace/configuration`; built-in ESLint uses defaults required by `vscode-eslint-language-server`.”
- [ ] In `packages/pi-lsp/README.md`, update the passive diagnostics text to state that diagnostics are collected from both push servers (`textDocument/publishDiagnostics`) and pull servers (`textDocument/diagnostic` when `diagnosticProvider` is advertised).
- [ ] In `packages/pi-lsp/README.md`, update the ESLint companion example note to mention that the built-in recipe provides default ESLint language-server settings and that user `settings` override/augment only when they configure their own server entry.
- [ ] In `packages/pi-lsp/fixtures/phase2-diagnostics/README.md`, update the ESLint companion diagnostic section to mention that this smoke test verifies pull diagnostics from `vscode-eslint-language-server`, not a `publishDiagnostics` notification.
- [ ] In `packages/pi-lsp/fixtures/phase2-diagnostics/README.md`, keep the two-turn instruction intact: Turn 1 appends `console.log(message);`; Turn 2 reads injected diagnostics without calling the `lsp` tool.

**Validation:**

- Run: `hk check`
- Expected: repository formatting and lint checks pass for the modified docs and code files.

### Task 6: Manual ESLint smoke test in the phase2 fixture

**Outcome:** The real `vscode-eslint-language-server` publishes an ESLint `no-console` issue into pi-lsp context through the new pull diagnostic path.

**Files:**

- Modify: none unless the smoke test exposes a bug.
- Test: `packages/pi-lsp/fixtures/phase2-diagnostics/README.md`

**Steps:**

- [ ] From the repository root, run `mise run build --package packages/pi-lsp`.
- [ ] Run `cd packages/pi-lsp/fixtures/phase2-diagnostics && bun install` to ensure `vscode-eslint-language-server` is present in fixture `node_modules/.bin`.
- [ ] Run `bun run reset && bun run check && bun run lint` from `packages/pi-lsp/fixtures/phase2-diagnostics` and confirm the baseline is clean.
- [ ] Launch pi from the fixture with `bun run pi`.
- [ ] In the pi session, run the README ESLint smoke prompt: append `console.log(message);` to `src/app.ts`.
- [ ] On the next user turn, ask for current-context diagnostics without calling the `lsp` tool.
- [ ] Confirm the injected block includes `Unexpected console statement.` with code `no-console`, sourced from `eslint` or `server: eslint`.
- [ ] Restore the fixture with `bun run reset`.

**Validation:**

- Run: manual two-turn fixture smoke test described above.
- Expected: the second turn receives `New LSP diagnostics detected` containing the ESLint `no-console` diagnostic for `src/app.ts`.

## Final Validation

- Run: `mise run test --package packages/pi-lsp`
- Expected: all package tests pass, including new pull diagnostic, settings, recipe, and instance capability tests.
- Run: `mise run typecheck --package packages/pi-lsp`
- Expected: TypeScript type checking exits 0.
- Run: `hk check`
- Expected: eslint and prettier checks pass for all modified files.
- Run: manual phase2 fixture smoke test from Task 6.
- Expected: ESLint `no-console` appears in the next-turn injected diagnostic block without calling the `lsp` tool.

## Rollout Notes

- This changes the advertised client capability from `workspace.configuration: false` to `true`; servers may now request configuration more eagerly. Servers without `config.settings` still receive `[null]` responses to preserve existing behavior as much as possible.
- Built-in ESLint recipe behavior changes from “server starts but cannot produce diagnostics in pi-lsp” to “server receives default VS Code-style settings and is pull-diagnosed after file sync.”
- The implementation deliberately does not add a public configuration option for pull diagnostics. Support is inferred from the server’s `diagnosticProvider` capability.

## Risks and Mitigations

- **Risk:** Some servers that support both push and pull diagnostics could produce duplicate or competing updates. — **Mitigation:** Pull requests only run for servers advertising `diagnosticProvider`, and `diagnostics.register()` already stores latest diagnostics per `(serverName, uri)`, so the most recent publish/pull result for that server wins.
- **Risk:** Returning settings through `workspace/configuration` could change behavior for servers with user-provided settings. — **Mitigation:** Only servers with `config.settings` receive a settings object; servers without settings keep the previous `[null]` behavior.
- **Risk:** ESLint default settings may be incomplete for future `vscode-eslint-language-server` versions. — **Mitigation:** Defaults are based on fields accessed by the bundled `vscode-langservers-extracted@4.10.0` server and covered by the real phase2 smoke test.
- **Risk:** Ignoring `kind: 'unchanged'` reports could miss diagnostics if a server returns unchanged without `previousResultId`. — **Mitigation:** The client does not send `previousResultId`, so compliant servers should return `kind: 'full'`; unchanged reports are logged and can be addressed with result-id caching in a later focused change if observed.
