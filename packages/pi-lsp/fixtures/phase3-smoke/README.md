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
.pi/@balaenis/pi-lsp/config.json   # two servers: typescript + python (pyright)
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
mise run build --package packages/pi-lsp          # builds ../../dist/index.js
cd packages/pi-lsp/fixtures/phase3-smoke
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
- sets `PI_LSP_LOG_LEVEL=debug` so the manager lifecycle and gitignore filter decisions
  are written to `~/.pi/pi-x-ide/debug.log` (override with `PI_LSP_LOG_FILE`).

> Always launch with `bun run pi`. Launching `pi -e ../../dist/index.js` from a
> shell where this fixture's `node_modules/.bin` is not on `PATH` will make the
> LSP client report the server is not ready.

## Manual acceptance prompts

Run these inside the pi session. Each prompt is self-contained.

- **A1–A5** validate the explicit `.pi/@balaenis/pi-lsp/config.json` mode that this fixture
  ships with (multi-server routing, `/reload`, call hierarchy, gitignore
  filtering, cold-start limitation).
- **Z0–Z10** validate the zero-config recipe mode added in Phase 7, covering:
  autodetection with binaries present (Z0/Z1), missing recipe binary (Z2),
  user-configured ENOENT path (Z3), mixed working/broken servers (Z4),
  all-user-entries-invalid fallback (Z5), recipe supplementation (Z6),
  server-name collision skip (Z7), unknown extension silence (Z8),
  per-reason notification dedup (Z9), and user-configured crash with bad
  args (Z10).

### Z0 — zero-config setup and restore

The fixture normally includes `.pi/@balaenis/pi-lsp/config.json` for explicit-config smoke
checks. To validate zero-config autodetection, use the `zero` mode which moves
`.pi/@balaenis/pi-lsp/config.json` aside and launches pi with a minimal PATH containing only
the fixture's binaries, the repo's `pi`, and the node runtime — **no system
paths** so no host LSP install can interfere.

```sh
bun run pi-zero
```

The script:

- backs up `.pi/@balaenis/pi-lsp/config.json` to `.pi/@balaenis/pi-lsp/config.backup.json`;
- removes `.pi/@balaenis/pi-lsp/config.json` so the extension must use recipe autodetection;
- sets `PATH` to `<fixture>/node_modules/.bin:<repo>/node_modules/.bin:<node>`;
- validates that both `typescript-language-server` and `pyright-langserver` are
  on this PATH before launching pi;
- restores `.pi/@balaenis/pi-lsp/config.json` on exit (via `trap EXIT`).

Expected during startup/use:

- `typescript-language-server` and `pyright-langserver` are detected from this
  fixture's `node_modules/.bin`.
- No user config is read; routing comes from the built-in TypeScript and Python
  recipes.

After the zero-config smoke, the script restores settings automatically. If you
need to restore manually (e.g. the script was killed):

```sh
mv .pi/@balaenis/pi-lsp/config.backup.json .pi/@balaenis/pi-lsp/config.json
```

### Z1 — zero-config TypeScript and Python routing

With `.pi/@balaenis/pi-lsp/config.json` moved aside as described in Z0, run:

```text
Use the lsp tool with operation "hover" on src/main.ts line 7 character 17
(the `target` function). Then use lsp "hover" on src/caller.py line 5
character 5 (the `target` function, on its `def` line). Report whether each
answer came from zero-config autodetection rather than .pi/@balaenis/pi-lsp/config.json.
```

Expected:

- `src/main.ts` is answered by the autodetected **typescript** recipe.
- `src/caller.py` is answered by the autodetected **python** recipe.
- In `~/.pi/pi-x-ide/debug.log` (`PI_LSP_LOG_LEVEL=debug`) you see recipe detection for
  `typescript-language-server` and `pyright-langserver` before the servers are
  started lazily by the tool calls.

### Z2 — zero-config: missing recipe binary shows install hint

This check validates the missing-server UX when **no user config exists** and
the recipe binary is absent. The `missing-pyright` mode creates a temp directory
with only `typescript-language-server` (symlinked from the fixture), removes
`.pi/@balaenis/pi-lsp/config.json`, and validates that `pyright-langserver` is **not** on the
constructed PATH before launching pi.

```sh
bun run pi-missing-pyright
```

The script:

- backs up and removes `.pi/@balaenis/pi-lsp/config.json`;
- creates a temp bin with only `typescript-language-server`;
- sets `PATH` to `<tempbin>:<repo>/node_modules/.bin:<node>` — no fixture bin,
  no system paths;
- validates `pyright-langserver` is absent from this PATH (exits with error if
  it leaks in);
- restores settings and cleans up the temp bin on exit.

Inside that pi session, run:

```text
Use the lsp tool with operation "hover" on src/caller.py line 5 character 5.
Then write a small comment-only change to src/caller.py. Report the lsp tool
text and whether a warning notification appeared.
```

Expected:

- The lsp tool text says **"No LSP server is configured for .py files"** and
  includes the Pyright install hint.
- Pi shows a non-blocking warning notification for the `.py` lsp tool trigger
  (reason `tool`) and another for the first `.py` edit trigger (reason `edit`),
  both with the same install hint.
- Repeating the same `.py` edit in the same session does **not** repeat the
  `edit` warning; repeating the same lsp request does **not** repeat the `tool`
  warning.
- TypeScript still works through the temp bin's TypeScript recipe.

### Z3 — user-configured server with binary not on PATH (ENOENT)

This validates the **wrong path** failure mode: the user has a server entry in
`.pi/@balaenis/pi-lsp/config.json` but the configured command is not on PATH. The message
must say **"failed to start"** with the actual error reason (e.g. `spawn
pyright-langserver-typo ENOENT`), **not** "no server is configured".

The `broken-python` mode writes a settings file where the python server's
command is `pyright-langserver-typo` (deliberately missing).

```sh
bun run pi-broken-python
```

The script:

- backs up the original `.pi/@balaenis/pi-lsp/config.json`;
- writes a config with a working typescript server and a broken python server
  (`command: "pyright-langserver-typo"`);
- sets `PATH` to `<fixture>/node_modules/.bin:<repo>/node_modules/.bin:<node>`;
- restores the original settings on exit.

Inside that pi session, run:

```text
Use the lsp tool with operation "hover" on src/caller.py line 5 character 5.
Then write a small comment-only change to src/caller.py. Report the lsp tool
text and whether a warning notification appeared.
```

Expected:

- The lsp tool text says **"LSP server 'python' failed to start: spawn
  pyright-langserver-typo ENOENT. Check that the configured command is
  installed and on PATH."** — the error reason (`ENOENT`) tells the user the
  path is wrong.
- The text does **not** say "No LSP server is configured" and does **not**
  include the recipe install hint (the user configured their own server).
- The edit notification carries the same "failed to start" message.
- TypeScript still works normally — the broken python server does not affect
  the typescript server.

### Z4 — mixed config: one server works, one fails

This validates that a working server is unaffected by a broken peer. Launch with
the same broken-python config from Z3:

```sh
bun run pi-broken-python
```

```text
Use the lsp tool with operation "hover" on src/main.ts line 7 character 17
(the `target` function). Then use lsp "hover" on src/caller.py line 5
character 5. Report both results.
```

Expected:

- `src/main.ts` hover succeeds — the typescript server started and answered.
- `src/caller.py` hover fails with **"LSP server 'python' failed to start"**
  and the Pyright install hint.
- On stderr you see the typescript server start successfully and the python
  server fail independently.

### Z5 — all user entries invalid: falls back to recipes

When every user-configured server is invalid (e.g. all commands are typos), the
extension must fall back to autodetected recipes rather than leaving the session
with zero servers.

The `all-invalid` mode writes a settings file where both server entries are
structurally invalid (missing the `command` field), matching the
`config.test.ts` "falls back to recipes when all user entries are invalid"
test case.

```sh
bun run pi-all-invalid
```

The script:

- backs up the original `.pi/@balaenis/pi-lsp/config.json`;
- writes a config with two servers that both lack a `command` field;
- validates that the real binaries are on PATH (for recipe fallback);
- restores the original settings on exit.

Inside that pi session, run:

```text
Use the lsp tool with operation "hover" on src/main.ts line 7 character 17
(the `target` function). Then use lsp "hover" on src/caller.py line 5
character 5. Report which server answered each request.
```

Expected:

- Both hovers succeed — the extension fell back to the autodetected
  `typescript-language-server` and `pyright-langserver` recipes from the
  fixture's `node_modules/.bin`.
- On stderr you see validation errors for the invalid user entries, then recipe
  detection and successful server starts.

### Z6 — user covers one language, recipe supplements another

When the user configures a server for one language but not another, the recipe
for the uncovered language must still be added.

The `user-ts-only` mode writes a settings file with only a custom-named
TypeScript server.

```sh
bun run pi-user-ts-only
```

The script:

- backs up the original `.pi/@balaenis/pi-lsp/config.json`;
- writes a config with a single `my-ts` server covering `.ts`;
- restores the original settings on exit.

Inside that pi session, run:

```text
Use the lsp tool with operation "hover" on src/main.ts line 7 character 17.
Then use lsp "hover" on src/caller.py line 5 character 5. Report which server
answered each request.
```

Expected:

- `src/main.ts` is answered by the user's **my-ts** server (user config wins).
- `src/caller.py` is answered by the autodetected **python** recipe (recipe
  supplements the uncovered language).
- On stderr you see one user server loaded plus one recipe server detected.

### Z7 — user server name collides with recipe: recipe is skipped

When the user configures a server with the same **name** as a built-in recipe,
the recipe is skipped entirely — even if the user's extension set is narrower.

The `name-collision` mode writes a settings file with a user server named
`typescript` (colliding with the built-in recipe) that only covers `.ts`.

```sh
bun run pi-name-collision
```

The script:

- backs up the original `.pi/@balaenis/pi-lsp/config.json`;
- writes a config with a `typescript` server covering only `.ts` (valid args,
  so the server actually starts);
- restores the original settings on exit.

Inside that pi session, run:

```text
Use the lsp tool with operation "hover" on src/main.ts line 7 character 17.
Report the result.
```

Expected:

- Hover succeeds — the user's **typescript** server started and answered.
- The built-in TypeScript recipe was skipped because the server name
  `typescript` collides with the user entry.
- `.js` and `.jsx` files have **no** server — the user's typescript server only
  covers `.ts`, and the recipe was skipped entirely (name collision).

### Z8 — unknown extension: no notification, no hint

When the agent edits a file with an extension that no recipe and no user server
covers, the extension must stay silent — no notification, no hint in tool
output beyond the generic "no server" message.

Use the default explicit config:

```sh
bun run pi
```

Then inside the pi session:

```text
Write a small file named notes.txt with any content. Then use the lsp tool
with operation "hover" on notes.txt line 1 character 1. Report whether any
warning notification appeared and what the lsp tool returned.
```

Expected:

- No warning notification appears (`.txt` is not covered by any recipe or user
  server).
- The lsp tool returns a generic "no server available" message without an
  install hint.

### Z9 — notification dedup across reasons

This validates that the dedup key includes the reason (`tool` vs `edit`), so
each reason gets its own first notification, but repeats within the same reason
are suppressed.

Launch with the broken-python config:

```sh
bun run pi-broken-python
```

Inside that pi session:

```text
1. Use the lsp tool with operation "hover" on src/caller.py line 5 character 5.
2. Use the lsp tool with operation "hover" on src/caller.py line 5 character 5
   again.
3. Write a small comment-only change to src/caller.py.
4. Write another small comment-only change to src/caller.py.

After each step, note whether a warning notification appeared.
```

Expected:

- Step 1: one `tool` warning appears.
- Step 2: **no** warning (same reason `tool`, same extension `.py`).
- Step 3: one `edit` warning appears (different reason).
- Step 4: **no** warning (same reason `edit`, same extension `.py`).
- Total: exactly 2 warnings — one `tool`, one `edit`.

### Z10 — user-configured server with invalid args (crash)

This validates the **bad args** failure mode: the user's command is on PATH and
spawns successfully, but the server crashes immediately because it doesn't
recognize the supplied arguments. The error reason should be the crash exit
code, distinguishing this from the ENOENT case in Z3.

The `bad-args` mode writes a settings file where the typescript server uses
valid command (`typescript-language-server`) but invalid args (`--my-flag`).

```sh
bun run pi-bad-args
```

The script:

- backs up the original `.pi/@balaenis/pi-lsp/config.json`;
- writes a config with `typescript` server using `args: ["--stdio", "--my-flag"]`;
- the python server is configured normally so it can answer requests and prove
  the broken typescript server doesn't poison the manager;
- restores the original settings on exit.

Inside that pi session, run:

```text
Use the lsp tool with operation "hover" on src/main.ts line 7 character 17.
Then write a small comment-only change to src/main.ts. Report the lsp tool
text and whether a warning notification appeared. Also confirm pi did NOT
```

Expected:

- The lsp tool text says **"LSP server 'typescript' failed to start: crashed
  with exit code 1. Check that the configured command is installed and on
  PATH."** — the error reason (`crashed with exit code 1`) tells the user the
  command spawned but failed; combined with the stderr line
  `error: unknown option '--my-flag'` (visible in `~/.pi/pi-x-ide/debug.log` with `PI_LSP_LOG_LEVEL=debug`), the
  user can pinpoint the bad arg.
- The text does **not** say "No LSP server is configured" and does **not**
  include the recipe install hint.
- The edit notification carries the same "failed to start" message.
- Pi does **not** hang in "Working..." — the 30s default startup timeout and
  the connection-disposal-on-crash fix ensure the request returns promptly.
- Python still works normally — the crashed typescript server does not affect
  the python server.

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
- In `~/.pi/pi-x-ide/debug.log` (`PI_LSP_LOG_LEVEL=debug`) you see two different servers started, routed by
  extension via `extensionToLanguage`.

### A2 — adding/removing a server takes effect after `/reload`

1. While pi is running, edit `.pi/@balaenis/pi-lsp/config.json` and delete the `python` server
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
- Restore `python` in `.pi/@balaenis/pi-lsp/config.json`, `/reload` again, and the `.py` hover
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
- In `~/.pi/pi-x-ide/debug.log` (`PI_LSP_LOG_LEVEL=debug`) you see the gitignore filter remove
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
