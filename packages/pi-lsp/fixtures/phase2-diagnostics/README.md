# Phase 2 diagnostics fixture

This is a small real TypeScript workspace for manually validating pi-lsp Phase 2 passive
diagnostics. It uses real `typescript-language-server` and
`vscode-eslint-language-server` binaries from this fixture's `node_modules/.bin`.

## Setup

From the repository root:

```sh
mise run build --package packages/pi-lsp
cd packages/pi-lsp/fixtures/phase2-diagnostics
bun install
bun run check
```

The baseline must be clean (`tsc --noEmit` exits 0).

## Launch pi with the local extension

From `fixtures/phase2-diagnostics`:

```sh
bun run pi
```

The script:

- runs pi from this fixture directory so `ctx.cwd` is the TypeScript workspace;
- prepends `node_modules/.bin` to `PATH`, so the hardcoded Phase 1 config can find
  `typescript-language-server` and the ESLint recipe can find
  `vscode-eslint-language-server`;
- loads the built local extension from `../../dist/index.js` with `-e`.

If `../../dist/index.js` is missing, run `mise run build --package packages/pi-lsp` from the repository root.

> **Always launch with `bun run pi`.** Do not run `pi -e ../../dist/index.js`
> directly. The script prepends this fixture's `node_modules/.bin` to `PATH` so the
> LSP client can spawn `typescript-language-server` and `vscode-eslint-language-server`.
> If you launch pi without it (for example from a terminal where mise is not
> activated), a server cannot start and the `lsp` tool reports it is not ready.

### Troubleshooting: "LSP server is not ready"

If the `lsp` tool prints something like:

```text
LSP server is not ready. ... Last error: typescript: Executable not found in $PATH: "typescript-language-server"
```

the pi child process could not find `typescript-language-server`. Re-launch via
`bun run pi` from this fixture directory. If the error persists, confirm the
binary exists at `node_modules/.bin/typescript-language-server` (`bun install`).

## Timing: diagnostics arrive on the NEXT turn

The LSP server publishes diagnostics **asynchronously**. After an edit:

- `syncFileChange` sends `didOpen` / `didSave` to the LSP server.
- The LSP server re-indexes and publishes diagnostics via a `publishDiagnostics`
  notification.
- The `context` hook fires BEFORE the same-turn LLM call, at which point the
  server has typically not finished publishing yet.
- Diagnostics are stored in a registry and injected by the **next** user turn
  (or later continuation).

This matches Claude Code's behavior (diagnostics delivered on the next query).
Each prompt below is therefore a **two-step** sequence: trigger the edit, then
send a second message to read the injected diagnostics.

You can watch the full lifecycle in `~/.pi/pi-x-ide/debug.log` when the launch
script sets `PI_LSP_LOG_LEVEL=debug` (`tail -f ~/.pi/pi-x-ide/debug.log`). Look for:

- `diagnostics: registered …` — publishDiagnostics handler stored diagnostics.
- `diagnostics: delivering …` — the `context` hook drained and formatted them.
- If you never see `registered`, the LSP server is not publishing or the handler
  is not firing. Check `LSP SERVER` / `LSP PROTOCOL` lines for clues.

## Manual validation prompts

Use these prompts inside the pi session.

### 1. Passive diagnostic after edit (two turns)

**Turn 1** — introduce a type error:

```text
Use the edit tool to change `const greeting = formatGreeting(userName);` in
`src/app.ts` to `const greeting: number = formatGreeting(userName);`.
```

The assistant should report that the edit succeeded. Do **not** ask it to
report diagnostics yet — the server hasn't published them.

**Turn 2** — read the injected diagnostics:

```text
What LSP diagnostics do you see in the current context?
Do NOT call the lsp tool. Just read any diagnostic information that is already
present in your context.
```

Expected:

- The assistant sees an injected block starting with `New LSP diagnostics
detected`.
- It reports a TypeScript diagnostic similar to:
  `Type 'string' is not assignable to type 'number'.` at the edited line.

### 2. Diagnostic does not reappear after fix (two turns)

**Turn 1** — fix the error:

```text
Use the edit tool to restore `const greeting: number = formatGreeting(userName);`
in `src/app.ts` back to `const greeting = formatGreeting(userName);`.
```

**Turn 2** — confirm clean:

```text
What LSP diagnostics do you see?
Do NOT call the lsp tool.
```

Expected:

- No diagnostic for `src/app.ts` is injected.
- Repeating the question without another edit should not re-deliver the old
  diagnostic (cross-turn dedup).

### 3. Per-file throttle with many diagnostics (two turns)

**Turn 1** — write 40 type errors:

```text
Read `templates/heavy-errors.ts.txt`, then use the write tool to replace
`src/heavy.ts` with exactly that content. Do not run tsc.
```

**Turn 2** — observe the cap:

```text
What LSP diagnostics do you see?
Do NOT call the lsp tool.
```

Expected:

- `templates/heavy-errors.ts.txt` contains 40 type errors.
- The injected diagnostics for `src/heavy.ts` are capped at 10 because Phase 2
  applies `MAX_DIAGNOSTICS_PER_FILE = 10` before the global
  `MAX_TOTAL_DIAGNOSTICS = 30` cap.
- Diagnostics are errors first.

### 4. ESLint companion diagnostic (two turns)

This fixture includes an `eslint.config.js` that enables the built-in
`no-console` rule, plus the `vscode-eslint-language-server` binary. Use it to
verify that ESLint companion diagnostics surface alongside TypeScript
diagnostics.

**Turn 1** — introduce an ESLint error:

```text
Use the edit tool to append `console.log(message);` to `src/app.ts`.
```

The assistant should report that the edit succeeded. Do **not** ask it to report
diagnostics yet — the server hasn't computed them.

**Turn 2** — read the injected diagnostics:

```text
What LSP diagnostics do you see in the current context?
Do NOT call the lsp tool. Just read any diagnostic information that is already
present in your context.
```

Expected:

- The assistant sees an injected block starting with `New LSP diagnostics
detected`.
- It reports an ESLint diagnostic similar to:
  `Unexpected console statement.` at the line you added, sourced from `eslint`.
- The diagnostic is delivered through the pull (`textDocument/diagnostic`)
  path, not a `publishDiagnostics` notification, because
  `vscode-eslint-language-server` advertises `diagnosticProvider`.
- TypeScript may also report a `Cannot find name 'console'.` diagnostic unless
  `console` is declared as a global in the ESLint config. The fixture config
  declares `console` as a global, so only the ESLint `no-console` diagnostic
  should appear.

## Reset the fixture

After a manual run, restore baseline files:

```sh
bun run reset
bun run check
```
