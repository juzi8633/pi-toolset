# Phase 3 smoke fixture

A small real workspace for manually validating pi-lsp Phase 3 in a **real Pi session**:
multi-server routing, `/reload` config refresh, call hierarchy two-step, and
`.gitignore` filtering. It ships its own `typescript-language-server` **and**
`pyright` binaries in `node_modules/.bin`, so no global LSP install is required.

> This is the human-acceptance counterpart to the automated checks in
> `docs/plans/lsp-implementation-plan.md` (Acceptance, spec §6). The automated
> checks prove the code paths; this fixture proves the extension is **live in a
> real Pi session** and the model can actually drive the `lsp` tool.

## Layout

```
.pi/settings.json   # two servers: typescript + python (pyright)
.gitignore          # ignores src/ignored.ts (used by the gitignore test)
tsconfig.json
src/main.ts         # callee / target / caller + revealSecret
src/ignored.ts      # gitignored; exports `secret` referenced by main.ts
src/caller.py       # python sample for .py routing
templates/          # baselines restored by `bun run reset`
scripts/run-pi-lsp.sh
```

## Setup

From the repository root:

```sh
mise run build          # builds ../../dist/index.js
cd fixtures/phase3-smoke
bun install             # installs local typescript-language-server + pyright
bun run check           # tsc --noEmit; baseline must be clean
```

## Launch pi with the local extension

From `fixtures/phase3-smoke`:

```sh
bun run pi
```

The script (`scripts/run-pi-lsp.sh`):

- runs pi from this fixture directory so `ctx.cwd` is the workspace;
- prepends this fixture's `node_modules/.bin` to `PATH`, so both
  `typescript-language-server` and `pyright-langserver` are spawnable;
- loads **only** the built local extension (`-ne --no-extensions -e ../../dist/index.js`);
- sets `PI_LSP_DEBUG=1` so the manager lifecycle and gitignore filter decisions
  print to stderr.

> Always launch with `bun run pi`. Launching `pi -e ../../dist/index.js` from a
> shell where this fixture's `node_modules/.bin` is not on `PATH` will make the
> LSP client report the server is not ready.

## Manual acceptance prompts

Run these inside the pi session. Each is self-contained.

### A1 — `.ts` and `.py` route to different servers

```text
Use the lsp tool with operation "hover" on src/main.ts line 7 character 17
(the `target` function). Then use lsp "hover" on src/caller.py line 5
character 5 (the `target` function, on its `def` line). Report which server
each answered from.
```

Expected:

- `src/main.ts` is answered by the **typescript** server (hover returns a
  TypeScript signature for `target`).
- `src/caller.py` is answered by the **python** server (pyright returns a
  Python hover/signature for `target`).
- On stderr (`PI_LSP_DEBUG=1`) you see two different servers started, routed by
  extension via `extensionToLanguage`.

### A2 — adding/removing a server takes effect after `/reload`

1. While pi is running, edit `.pi/settings.json` and delete the `python` server
   block (leave only `typescript`).
2. In pi, run `/reload`.
3. Re-run the python half of A1:

```text
Use the lsp tool with operation "hover" on src/caller.py line 5 character 5.
```

Expected:

- The tool reports no server is available for `.py` (the python server is gone).
- On stderr, `session_shutdown` tears the old manager down and `session_start`
  rebuilds it from the freshly-read config.
- Restore `python` in `.pi/settings.json`, `/reload` again, and the `.py` hover
  works once more — proving config is read fresh on each `session_start`.

### A3 — callHierarchy two-step returns incoming/outgoing

```text
Use the lsp tool with operation "incomingCalls" on src/main.ts line 7
character 17 (the `target` function). Then use "outgoingCalls" on the same
position. Only use the lsp tool.
```

Expected:

- `incomingCalls` returns `caller` (the function that calls `target`).
- `outgoingCalls` returns `callee` (the function `target` calls).
- This is the two-step path: `prepareCallHierarchy` →
  `callHierarchy/incomingCalls` / `callHierarchy/outgoingCalls`.

### A4 — `.gitignore`d files are excluded from results

`src/ignored.ts` is gitignored by this fixture's `.gitignore`. It exports
`secret`, which `src/main.ts` imports and uses.

```text
Use the lsp tool with operation "findReferences" on src/main.ts line 16
character 10 (the `secret` identifier inside revealSecret). Only use the lsp
tool.
```

Expected:

- References inside `src/main.ts` are returned (the import on line 1 and the
  use on line 16).
- The declaration in `src/ignored.ts` is **not** listed, because
  `filterGitIgnoredLocations` dropped it via `git check-ignore`.
- On stderr (`PI_LSP_DEBUG=1`) you see the gitignore filter remove
  `src/ignored.ts`.

> This works because the fixture lives inside the pi-lsp git repository, so
> `git check-ignore` (run with `cwd` = this fixture) resolves to the repo's
> `.git` and reads this fixture's `.gitignore`.

### A5 — cold-start `findReferences` limitation (documented)

The extension opens files lazily. On a cold start, references in files the
server has not indexed may be missing. No eager workspace priming is performed
(this matches Claude Code's default).

To observe it:

```text
Use the lsp tool with operation "findReferences" on src/main.ts line 8
character 10 (the `callee` call inside target). Only use the lsp tool.
```

Expected:

- Returns the references the typescript server has indexed so far (at minimum
  the declaration in `src/main.ts` and the call on line 8).
- References in files the server has never opened may be absent on the first
  call; a second call after the server has settled typically returns more.
- This is the documented limitation, not a bug — see README "Limitations" in the
  repo root and the cold-start note in `docs/plans/lsp-implementation-plan.md`.

## Reset the fixture

```sh
bun run reset
bun run check
```

## What "it works in real use" looks like

You know Phase 3 is live when, in a real pi session:

1. The startup header lists the local extension (no load error on stderr).
2. The model calls a tool labeled **LSP** (not bash/grep) for the prompts above.
3. The tool returns semantic results — call hierarchy names, cross-file
   references with `.gitignore`d entries dropped, and `.ts`/`.py` answered by
   different servers.
