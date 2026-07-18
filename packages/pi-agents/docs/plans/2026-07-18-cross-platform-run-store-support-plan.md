# Cross-Platform RunStore Support Implementation Plan

**Goal:** Replace the Linux-specific RunStore filesystem binding with one pathname-based implementation that supports all Node-supported operating systems while preserving cooperative concurrency, Version 1 validation, and crash consistency.

**Inputs:** The agreed trusted-runs threat model, cross-platform state-directory decision, current `packages/pi-agents/src/run-store.ts`, artifact persistence and reader code, existing tests, package documentation, repository validation tasks, and CI workflow.

**Assumptions:**

- The complete runs root is application-owned, trusted per-user storage. Intentional same-user insertion of symlinks, junctions, reparse points, or replacement paths is unsupported and may cause failure or data loss.
- Supplying an empty `CreateRunStoreOptions.rootDir` is invalid rather than an alias for the current working directory.
- Non-empty environment paths are used without trimming; empty strings are ignored.
- Existing Version 1 run records, transaction markers, lock owners, intents, claims, and artifact references remain compatible.
- Filesystems under the runs root expose stable `fs.Stats.dev` and `ino` values where the cooperative lock-generation state machine requires them. Native CI must surface violations.
- The package is currently unpublished at Version `0.0.1`; no automatic legacy-root migration is required.
- Existing unrelated working-tree changes must remain untouched.

**Architecture:** Keep transaction, lock, claim, recovery, and validation logic in `run-store.ts`, but address protocol entries through ordinary paths beneath a resolved runs root. Add a small `run-store-paths.ts` helper for cross-platform root resolution, startup filesystem capability probing, sync capability state, and no-replace contention classification. This intentionally trades hostile same-user filesystem-mutation resistance for cross-platform simplicity without weakening cooperative concurrency or crash-consistency behavior.

**Tech Stack:** TypeScript, Node/Bun `node:fs`, `node:path`, `node:os`, `node:crypto`, Bun 1.3.14, `bun:test`, Mise, HK, and GitHub Actions.

---

## Scope

### In Scope

- One pathname-based RunStore on Linux, Windows, macOS, FreeBSD, and other Node-supported systems.
- Cross-platform persistent state-root resolution and recursive root creation.
- Startup file-fsync and hard-link capability probing with no weaker publication fallback.
- Exclusive temporary writes followed by atomic rename.
- Existing prepared/committed transaction recovery.
- Complete lock-candidate publication, immutable intents, owner tokens, lock generations, monotonic deadlines, and stale-owner recovery.
- Version 1 schema, digest, size, run ID, token, and syntactic path-containment validation.
- Cross-platform claims, lifecycle events, artifacts, artifact reads, listing, and resume-supporting state.
- Native Windows and macOS CI.

### Out of Scope

- Defending against intentional symlink, junction, reparse-point, or pathname replacement under the application-owned runs root.
- `/proc/self/fd`, `openPathComponentNoFollow`, `O_NOFOLLOW`, `O_DIRECTORY`, directory-fd sessions, or component-by-component symlink checks for RunStore data.
- A platform-backend abstraction or separate Linux, Windows, and macOS RunStore implementations.
- Parent `lstat`/`fstat` revalidation intended to resist hostile path mutation.
- Generic quarantine-before-delete defenses. Protocol tombstones required for cooperative lock release remain in scope.
- Symlink/junction adversarial RunStore tests or Windows link-privilege setup.
- Lock-age-based stale-owner stealing.
- `/tmp`, `os.tmpdir()`, or another temporary directory as authoritative production storage.
- Automatic migration from the legacy `~/.pi/agent/@balaenis/pi-agents/runs` location.
- Native filesystem addons or weak fallbacks when hard links or regular-file fsync are unavailable.

## File Map

Each source or test file has one implementation-task owner. Later tasks may run its tests but do not reopen its implementation scope.

- Create: `packages/pi-agents/src/run-store-paths.ts` — cross-platform root resolution, startup filesystem capability probing, sync capability state, and no-replace contention classification.
- Create: `packages/pi-agents/tests/run-store-paths.test.ts` — injected platform/environment/home/cwd path matrix and capability-probe coverage.
- Create: `packages/pi-agents/tests/run-store-cross-platform.test.ts` — pathname transactions, crash recovery, locking, claims, liveness, and persistence smoke coverage.
- Modify: `packages/pi-agents/src/run-store.ts` — replace proc-fd and hostile-path machinery with one pathname implementation while retaining protocol state machines.
- Modify: `packages/pi-agents/tests/run-store.test.ts` — retain Version 1/API coverage and retire hostile runs-tree mutation cases.
- Modify: `packages/pi-agents/src/artifact-store.ts` — cross-platform pathname artifact publication and digest/size verification.
- Modify: `packages/pi-agents/src/artifact-reader-extension.ts` — artifact reads without `O_NOFOLLOW`, retaining caller-input and content validation.
- Modify: `packages/pi-agents/tests/artifact-store.test.ts` — cross-platform publication contention, corruption, containment, and deduplication.
- Modify: `packages/pi-agents/tests/artifact-reader-extension.test.ts` — caller-input, digest, size, chunk, containment, and error-collapse coverage without runs-tree symlink attacks.
- Modify if native CI requires: `packages/pi-agents/tests/session-lease.test.ts` — narrowly guard unsupported Windows symlink setup without changing production behavior.
- Modify if native CI requires: `packages/pi-agents/tests/package-agents.test.ts` — narrowly guard unsupported Windows link setup without changing package-discovery security.
- Modify: `packages/pi-agents/README.md` — platform paths, configuration, migration, trusted storage, filesystem requirements, privacy, and liveness limitations.
- Modify: `packages/pi-agents/docs/reference.md` — exact root-selection and RunStore protocol reference.
- Modify: `.github/workflows/pr.yml` — retain Ubuntu and add native Windows and macOS package jobs.

## Tasks

### Task 1: Build Root Resolution and Capability Probing

**Outcome:** A standalone helper resolves persistent per-user roots and rejects filesystems lacking mandatory regular-file fsync or hard-link no-replace publication before RunStore integration.

**Files:**

- Create: `packages/pi-agents/src/run-store-paths.ts`
- Create: `packages/pi-agents/tests/run-store-paths.test.ts`

**Steps:**

- [ ] Capture `git status --short` before implementation and record pre-existing changes; never reset, clean, stash, or replace them.
- [ ] Start both new TypeScript files with the required two-line `ABOUTME:` comment.
- [ ] Introduce `ResolveRunsRootInput` with injectable `rootDir`, `platform`, `env`, `homeDir`, and `cwd`.
- [ ] Select `path.win32` for injected `win32` tests and `path.posix` for injected non-Windows tests so the resolution matrix is host-independent.
- [ ] Implement root precedence exactly:
  1. non-empty programmatic `rootDir`;
  2. non-empty `PI_AGENTS_RUNS_DIR`;
  3. on Windows, non-empty `LOCALAPPDATA`, otherwise `<home>/AppData/Local`;
  4. on every non-Windows platform, non-empty `XDG_STATE_HOME`, otherwise `<home>/.local/state`.
- [ ] Treat programmatic `rootDir` and `PI_AGENTS_RUNS_DIR` as complete runs roots. Resolve relative values against injected/current `cwd`; do not append package segments.
- [ ] Append `@balaenis/pi-agents/runs` only to platform-default bases.
- [ ] Return an absolute normalized path. Do not inspect `TMPDIR`, `TEMP`, `TMP`, `os.tmpdir()`, or `/tmp`.
- [ ] Define `RunStoreCapabilities` with mandatory regular-file fsync support and optional directory-fsync support.
- [ ] Implement root initialization: recursive directory creation, best-effort POSIX `0700`, then capability probing with unique exclusively created files inside the runs root.
- [ ] Probe regular-file fsync by writing, calling `fsyncSync`, closing, and reading back exact bytes. Any open/write/fsync/read mismatch or error fails initialization with actionable `run_store_error`; never silently mark file fsync unsupported.
- [ ] Probe hard-link publication by linking an exclusive source to an absent destination, verifying both paths expose the expected shared cooperative generation, then attempting publication onto an occupied destination and requiring no replacement.
- [ ] Missing, denied, or non-no-replace hard-link behavior fails initialization; do not add rename, overwrite, in-place-write, or advisory-lock fallback.
- [ ] Probe directory fsync independently. Treat only documented platform-unavailable results as optional capability absence: `EINVAL`, `ENOTSUP`, `ENOSYS`, `EISDIR`, plus `EPERM` when `platform === "win32"`. Any other directory open/fsync error fails initialization.
- [ ] Remove only exact known probe files. A probe cleanup error fails initialization rather than leaving ambiguous capability state.
- [ ] Add `isNoReplaceContentionError`: `EEXIST`/`ENOTEMPTY` are contention; Windows `EPERM` is contention only when a caller-supplied destination-exists check succeeds; other errors are not contention.
- [ ] Add tests for every precedence branch, absolute/relative explicit roots, empty environment values, Windows fallback, Linux/macOS/FreeBSD defaults, proof temp variables are ignored, recursive creation, mandatory file-fsync failure, hard-link failure, occupied-destination no-replace behavior, directory-fsync optional codes, unexpected directory-fsync failure, and exact probe cleanup.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store-paths.test.ts`
- Expected: The resolver/capability suite exits zero; file-fsync and hard-link failures are fatal, documented directory-fsync absence is optional, and no default resolves under a temporary directory.

### Task 2: Migrate the Complete RunStore Protocol to Pathnames

**Outcome:** Creation, loading, updates, transactions, locks, events, claims, listing, and resume-supporting state use one cross-platform pathname implementation while retaining cooperative correctness.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/tests/run-store.test.ts`
- Create: `packages/pi-agents/tests/run-store-cross-platform.test.ts`

**Steps:**

- [ ] Start the new test file with the required two-line `ABOUTME:` comment and update `run-store.ts` comments to describe cross-platform pathname transactions.
- [ ] Make `getDefaultRunsRoot()` and `createRunStore({ rootDir })` use Task 1 root resolution and root initialization. Remove the legacy `~/.pi/agent/...` default and root `realpathSync` canonicalization.
- [ ] Run capability probing before any `run-*` directory is created and retain the returned directory-fsync capability for publication/removal helpers.
- [ ] Remove `RunDirSession`, `procFdBase`, `childViaDirFd`, `openPathComponentNoFollow`, directory-fd open/close helpers, `O_DIRECTORY`, `O_NOFOLLOW`, public-path identity binding, uid ownership enforcement, and hostile path revalidation.
- [ ] Keep safe run IDs and reject invalid IDs before `path.join` in `getRunDir`/`runDirOf`.
- [ ] Keep internal protocol names as fixed constants. Continue validating parsed owner tokens and generated temporary names as safe single basenames.
- [ ] Address `run.json`, rollback, marker, lock entries, events, claims, sessions, and artifacts through `path.join` beneath the validated run directory.
- [ ] Consolidate regular-file publication: fixed-shape local temp basename, `O_CREAT | O_EXCL`, complete write, mandatory file fsync, close, atomic rename, then directory fsync only when the probe marked it supported.
- [ ] Preserve `StrictRunTxPhase`, `STRICT_TX_BYPASS_CLEANUP`, fault-injection options, marker schemas, digest/size checks, and Version 1 error mapping.
- [ ] Preserve the transaction sequence: rollback publication, immutable `prepared` marker, new `run.json` rename, `committed` marker, committed-order cleanup.
- [ ] Remove checks used only for hostile parent, symlink, marker, rollback, or pathname replacement. Keep generation checks used by cooperative lock transitions.
- [ ] Unlink only exact known marker, rollback, and temp basenames. Never recursively remove unknown protocol entries.
- [ ] Keep complete lock-candidate publication: unique candidate directory, exclusive fully written/fsynced owner temp, owner rename, optional candidate-directory fsync, then candidate rename to `.run.json.tx.lock`.
- [ ] Use Task 1 contention classification for lock and claim directory publication. Windows `EPERM` is retryable only when the competing destination exists.
- [ ] Keep hard links as the only atomic no-replace mechanism for fixed steal/release intents and claim terminal publication.
- [ ] Preserve immutable intent publication, strict token equality, owner/current/previous combinations, temp digest/size checks, intent schemas, release tombstones, and cooperative `dev`/`ino` generation checks.
- [ ] Do not present cooperative generation checks as defense against user filesystem tampering.
- [ ] Enumerate lock candidates/tombstones and claim staging directories; remove only recognized protocol files, then `rmdir`. Leave unknown entries and fail/retry according to the state machine.
- [ ] Keep monotonic lock deadlines and ignore owner timestamps for stealing.
- [ ] Keep `/proc/<pid>/stat` only for Linux process-start/PID-reuse detection. Remove all `/proc/self/fd` filesystem use.
- [ ] On non-Linux platforms use `process.kill(pid, 0)`: `ESRCH` means dead; success, `EPERM`, and unknown errors mean busy; never steal based on lock age.
- [ ] Preserve `unsupported-<platform>-<pid>` owner identities for Version 1 compatibility.
- [ ] Keep lifecycle-event ordering, monotonically increasing claim tickets, owner/terminal validation, release isolation, and dead-owner abandonment behavior.
- [ ] Retire RunStore tests based on symlink insertion, intermediate/parent replacement, no-follow behavior, hostile inode replacement, directory-fd binding, or forensic preservation under same-user tampering.
- [ ] Keep tests for run-ID traversal rejection, fixed names, strict lock tokens, malformed JSON, unknown versions, exact marker/intent schemas, digest/size mismatches, unknown protocol entries, and all transaction/lock crash phases.
- [ ] Add cross-platform tests using `process.execPath`, argument arrays, filesystem barriers, and natural child exit for prepared/committed recovery, complete candidate publication, Windows contention normalization, immutable intents, live-owner timeout, exited-owner recovery, steal/release crash recovery, concurrent writers, merged updates, no age stealing, events, claims, listing, and persisted resume fields.
- [ ] Replace fake dead PIDs where practical with real exited children. Keep Linux-only PID-reuse tests scoped to `/proc/<pid>/stat`.
- [ ] Assert successful operations leave no known marker, rollback, temp, lock candidate, fixed lock, tombstone, intent temp, or claim staging entries.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts tests/run-store-cross-platform.test.ts`
- Expected: Version 1, transaction, lock, event, claim, listing, and recovery tests pass without proc-fd or no-follow filesystem requirements; Linux `/proc` remains only in process-liveness coverage.

### Task 3: Make Artifact Persistence and Reading Cross-Platform

**Outcome:** Artifact storage and `pi_agents_read_artifact` work on all supported systems without hostile runs-tree link defenses.

**Files:**

- Modify: `packages/pi-agents/src/artifact-store.ts`
- Modify: `packages/pi-agents/src/artifact-reader-extension.ts`
- Modify: `packages/pi-agents/tests/artifact-store.test.ts`
- Modify: `packages/pi-agents/tests/artifact-reader-extension.test.ts`

**Steps:**

- [ ] Refactor `artifact-store.ts` to derive `artifacts/sha256/<prefix>/<digest>.{txt,json}`, create directories recursively, stage through exclusive creation, write and mandatory-fsync, then publish through rename.
- [ ] When a concurrent destination exists, verify exact size and SHA-256 before treating it as successful deduplication.
- [ ] Keep `RunArtifactRefV1`, media type/payload validation, JSON serialization checks, `RUN_ARTIFACT_MAX_BYTES`, relative-path validation, and digest/size checks.
- [ ] Replace artifact `realpath`, intermediate-link, inode-identity, and `O_NOFOLLOW` defenses with syntactic containment: resolve the run directory and derived artifact path, use `path.relative`, reject absolute or `..` escapes, read bytes, and verify size plus SHA-256.
- [ ] Return the syntactically derived absolute artifact path after verification rather than requiring canonical realpath identity.
- [ ] Simplify `ArtifactReaderFs` to ordinary open/stat/read/close operations; remove realpath, lstat, and inode dependencies used only for hostile path mutation.
- [ ] Keep the child reader free of caller-supplied paths. Validate owning `runId`, lowercase SHA-256, media type, regular-file status, maximum size, stable read size, digest, offset, UTF-8 boundaries, chunk limits, and syntactic containment.
- [ ] Continue collapsing filesystem details to `artifact_unavailable`.
- [ ] Retire artifact tests based solely on runs-tree symlink rejection, intermediate replacement, lstat/fstat mismatch, unavailable inode identity, parent realpath replacement, or same-inode path attacks.
- [ ] Keep tests for caller/path traversal rejection, malformed references, digest/size corruption, media types, serialization, deduplication, concurrent publication, chunking, UTF-8 boundaries, and error collapsing.
- [ ] Add a normal cross-platform spilled-artifact read test that succeeds without `O_NOFOLLOW`.
- [ ] Assert successful writes leave no known artifact staging entries.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/artifact-store.test.ts tests/artifact-reader-extension.test.ts`
- Expected: Artifacts round-trip and deduplicate, bounded validation remains intact, and valid child reads no longer require no-follow or realpath identity checks.

### Task 4: Audit Remaining Native Test Portability

**Outcome:** The complete package test suite runs on Windows and macOS without expanding RunStore’s threat model or weakening unrelated production security.

**Files:**

- Modify if required: `packages/pi-agents/tests/session-lease.test.ts`
- Modify if required: `packages/pi-agents/tests/package-agents.test.ts`

**Steps:**

- [ ] Run the complete package suite on native Windows and macOS before changing either file.
- [ ] If `session-lease.test.ts` fails only because Windows denies test symlink creation, guard only that individual setup error; do not change `session-lease.ts` behavior.
- [ ] If `package-agents.test.ts` fails only because Windows denies link creation, guard only that individual setup error; do not change package-discovery containment behavior.
- [ ] Rethrow all non-privilege setup failures and keep link assertions mandatory wherever creation succeeds.
- [ ] Do not add RunStore junction tests or change the accepted trusted-runs boundary.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: The complete Linux package suite passes; native Windows/macOS CI determines whether the narrowly scoped test-only guards are needed.

### Task 5: Document Paths, Migration, Filesystem Requirements, and Trust Boundary

**Outcome:** Users can locate, configure, migrate, and protect durable runs on every supported platform.

**Files:**

- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/reference.md`

**Steps:**

- [ ] Document defaults:
  - Windows: `%LOCALAPPDATA%\@balaenis\pi-agents\runs`, falling back to `<home>\AppData\Local\@balaenis\pi-agents\runs`;
  - non-Windows: `$XDG_STATE_HOME/@balaenis/pi-agents/runs`, falling back to `~/.local/state/@balaenis/pi-agents/runs`.
- [ ] Document programmatic `CreateRunStoreOptions.rootDir` as highest precedence and `PI_AGENTS_RUNS_DIR` as the user-facing override.
- [ ] State that overrides are complete roots, receive no appended suffix, and resolve relative paths against process cwd.
- [ ] Add `PI_AGENTS_RUNS_DIR` to the reference environment-variable table.
- [ ] State that production RunStore data is never placed in `/tmp` or `os.tmpdir()`.
- [ ] Document the trusted per-user runs boundary: user-created symlinks, junctions, reparse points, or replacement paths are unsupported; behavior may include failure or data loss; no forensic-preservation or containment guarantee applies under tampering.
- [ ] Explain that run-ID validation, fixed basenames, schema validation, and syntactic containment still prevent ordinary API path traversal.
- [ ] Document mandatory regular-file fsync and hard-link-capable filesystem requirements, startup probing, and no weak fallback.
- [ ] Document capability-based directory fsync and Windows sudden-power-loss limitations.
- [ ] Document stale-owner behavior: Linux can detect PID reuse through `/proc/<pid>/stat`; non-Linux only proves death through `ESRCH`; success, `EPERM`, or unknown liveness stays busy; lock age is ignored.
- [ ] Document Version 1 compatibility and no automatic migration.
- [ ] Give two legacy options: stop all agents and move the complete old root to the new default, or set `PI_AGENTS_RUNS_DIR` to the old root.
- [ ] Retain privacy guidance for prompts, outputs, cwd paths, sessions, continuations, claims, and artifacts.

**Validation:**

- Run: `hk check`
- Expected: Documentation formatting passes and no text claims proc-fd binding, hostile runs-tree mutation protection, temporary authoritative storage, or automatic migration.

### Task 6: Add Native Windows and macOS CI

**Outcome:** Every pull request validates the same RunStore implementation on Ubuntu, Windows, and macOS.

**Files:**

- Modify: `.github/workflows/pr.yml`

**Steps:**

- [ ] Leave the existing Ubuntu `check` job and Mise commands unchanged.
- [ ] Add `macos-pi-agents` on `macos-latest` with `actions/checkout@v4`, the existing pinned `jdx/mise-action`, `mise run setup`, and exact package commands:

```sh
mise run setup
mise run typecheck --package packages/pi-agents
mise run test --package packages/pi-agents
mise run build --package packages/pi-agents
```

- [ ] Add `windows-pi-agents` on `windows-latest` with `actions/checkout@v4` and `ref: ${{ github.event.pull_request.head.sha || github.ref }}`.
- [ ] Use `oven-sh/setup-bun@v2` with `bun-version: 1.3.14`; run `bun install --frozen-lockfile` at repository root.
- [ ] Do not use Mise tasks on Windows because current tasks use Bash tooling and `mise.toml` excludes Windows for `usage`.
- [ ] From `packages/pi-agents`, run:

```powershell
bunx tsc --noEmit
bun test
```

- [ ] Build both entry points with:

```powershell
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$externalArgs = @()
$pkg.peerDependencies.PSObject.Properties.Name | ForEach-Object {
  $externalArgs += @("--external", $_)
}
$pkg.pi.external | ForEach-Object {
  $externalArgs += @("--external", $_)
}

bun build ./src/index.ts --outdir dist --target node @externalArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

bun build ./src/artifact-reader-extension.ts --outdir dist --target node @externalArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

- [ ] Require full RunStore concurrency and crash-recovery tests on both native jobs.
- [ ] Do not require symlink/junction privileges or add adversarial runs-tree link setup.

**Validation:**

- Run: `hk check`
- Expected: Workflow YAML passes repository checks.
- Native CI expected: Ubuntu, `macos-pi-agents`, and `windows-pi-agents` complete package typecheck, tests, and builds.

### Task 7: Run the Full Regression and Threat-Model Audit

**Outcome:** The implementation is cross-platform, retains cooperative correctness, and contains none of the superseded hostile-filesystem architecture.

**Files:**

- None; inspection and validation only.

**Steps:**

- [ ] Compare final `git status --short` and diffs with the initial snapshot; confirm unrelated changes are untouched.
- [ ] Confirm every new TypeScript file starts with two `ABOUTME:` lines.
- [ ] Confirm package version and Version 1 constants/formats remain unchanged.
- [ ] Confirm no automatic migration, temporary authoritative root, weak capability fallback, or lock-age stealing exists.
- [ ] Confirm protocol cleanup never recursively deletes unknown entries.
- [ ] Run:

```sh
rg '/proc/self/fd|openPathComponentNoFollow|O_NOFOLLOW|O_DIRECTORY|RunDirSession|run-store-platform' \
  packages/pi-agents/src packages/pi-agents/tests
```

- [ ] Expected: no RunStore/artifact matches. Verify remaining `/proc/<pid>/stat` references are confined to Linux process-start liveness logic and tests.
- [ ] Confirm RunStore/artifact tests contain no symlink/junction adversarial runs-tree cases.
- [ ] Confirm traversal, Version 1 schema, digest/size, exclusive creation, contention, concurrency, liveness, and every crash phase remain tested.
- [ ] Run package typecheck, tests, build, repository checks, and native Windows/macOS CI before merge.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.
- Run: `mise run test --package packages/pi-agents`
- Expected: All package tests pass, including cross-process concurrency and crash recovery.
- Run: `mise run build --package packages/pi-agents`
- Expected: `dist/index.js` and `dist/artifact-reader-extension.js` build successfully.
- Run: `hk check`
- Expected: Repository ESLint and Prettier checks pass.
- Run: `git diff --check`
- Expected: No whitespace errors.

## Final Validation

### Linux / Repository

```sh
mise run typecheck --package packages/pi-agents
mise run test --package packages/pi-agents
mise run build --package packages/pi-agents
hk check
git diff --check
```

Expected: Every command exits zero; the pathname implementation retains Version 1 validation, cooperative locking, merged read-modify-write updates, and prepared/committed crash recovery.

### macOS CI

```sh
mise run setup
mise run typecheck --package packages/pi-agents
mise run test --package packages/pi-agents
mise run build --package packages/pi-agents
```

Expected: All commands exit zero on `macos-latest`; capability probing succeeds, non-Linux liveness remains conservative, and full package tests require no proc-fd or no-follow support.

### Windows CI

```powershell
bun install --frozen-lockfile
Set-Location packages/pi-agents
bunx tsc --noEmit
bun test
```

Then run the PowerShell build block from Task 6.

Expected: Typecheck, full package tests, and both builds exit zero on `windows-latest`; contention, hard-link publication, cross-process exclusion, crash recovery, claims, and artifact reads use the same pathname implementation as Linux and macOS.

## Failure Behavior

- Invalid or escaping run ID — reject before joining or accessing a run path.
- Invalid explicit root — throw actionable `run_store_error` before protocol initialization.
- Root creation failure — throw `run_store_error`; never fall back to temporary storage.
- Regular-file fsync probe failure — fail initialization; never silently disable file durability.
- Missing hard-link support — fail initialization before the first run; never use a weaker publication mechanism.
- Documented unsupported directory-fsync result — continue with directory sync disabled and file fsync still mandatory.
- Unexpected directory-fsync error — fail initialization.
- Windows `EPERM` with an existing destination during no-replace publication — classify as contention.
- Windows `EPERM` without a destination — propagate as filesystem/permission failure.
- Malformed Version 1 JSON, unsupported version, invalid digest/size, or contradictory state — return the existing corruption/error family without recursive cleanup.
- Prepared crash — recover old `run.json` authority from matching rollback bytes.
- Committed crash — retain new authority and finish known cleanup idempotently.
- Ambiguous marker, intent, owner, or cooperative generation state — return the existing corruption, busy, or durable error appropriate to that state.
- Live, inaccessible, or indeterminate owner — wait until the monotonic deadline and return `run_busy`.
- Proven-dead owner — perform immutable-intent recovery and generation-checked transfer.
- Unknown entry in a protocol candidate/tombstone/staging directory — leave the directory rather than recursively deleting it.
- Intentional same-user mutation inside the runs tree — unsupported and undefined; failure or data loss is permitted by the accepted threat model.

## Privacy and Security

- Runs contain prompts, outputs, cwd paths, session identifiers, continuations, claims, artifacts, and error details. No logging or telemetry is added.
- The complete runs root is trusted, application-owned, per-user storage.
- This plan intentionally gives up hostile filesystem-mutation resistance for a smaller cross-platform implementation.
- The implementation does not defend against same-user insertion of symlinks, junctions, reparse points, or replacement paths and does not promise forensic preservation under such mutation.
- Safe run IDs, strict lock tokens, fixed internal basenames, exact Version 1 schemas, digest/size validation, and syntactic containment remain mandatory for normal API and protocol correctness.
- Callers never provide artifact filesystem paths; locations are derived from trusted run context, validated run ID, digest, and media type.
- Hard-link no-replace publication, complete candidates, immutable intents, owner generations, monotonic deadlines, and crash recovery continue to protect cooperating pi-agents processes.
- POSIX `0700`/`0600` modes remain best effort and are not presented as Windows privacy controls. Windows privacy depends on the user profile and filesystem ACLs.

## Rollout Notes

- The package remains unpublished at Version `0.0.1`; no record-version bump is required.
- Existing Version 1 records remain readable after moving the complete runs directory or pointing `PI_AGENTS_RUNS_DIR` at it.
- There is no automatic scan, copy, or migration from `~/.pi/agent/@balaenis/pi-agents/runs`.
- Users must stop all pi-agents processes before manually moving a legacy runs directory.
- Users who retain the old location may set `PI_AGENTS_RUNS_DIR=~/.pi/agent/@balaenis/pi-agents/runs`.
- First RunStore initialization probes mandatory filesystem capabilities and may fail early on filesystems without regular-file fsync or hard links.
- Existing unrelated working-tree changes must be preserved throughout implementation and validation.

## Risks and Mitigations

- **Windows rename errors vary by destination state** — Normalize `EPERM` only after confirming destination existence and exercise behavior on native Windows CI.
- **Hard links may be disabled by filesystem or policy** — Fail early with an actionable error; do not weaken publication semantics.
- **Regular-file fsync may fail** — Fail initialization or the active durable write rather than silently disabling it.
- **Directory fsync is unavailable on some platforms** — Accept only documented unsupported codes, keep mandatory file fsync, and document the sudden-power-loss limitation.
- **Non-Linux PID reuse cannot be detected** — Treat success, `EPERM`, and unknown liveness as busy; never use timestamps or lock age.
- **Lock-generation identities may vary by runtime/filesystem** — Exercise real transitions on Windows and macOS CI and stop rather than silently removing cooperative generation checks.
- **Current RunStore mixes protocol and hostile-path defenses extensively** — Remove mechanisms in Task 2 while preserving transaction and lock-state tests throughout that task.
- **Changing the default root can make old runs appear missing** — Document manual move and the exact `PI_AGENTS_RUNS_DIR` compatibility setting.
- **Trusted-tree tampering can redirect pathname operations** — This is an explicit accepted trade-off and may cause failure or data loss.
- **Other Node-supported systems lack native CI** — Keep platform branching limited to path syntax/defaults, POSIX modes, directory-fsync capability, Windows contention normalization, and Linux process-start liveness.

## Open Questions

None. If native Windows or macOS CI shows mandatory file fsync, hard links, or cooperative lock-generation identities do not work on the runner filesystem, stop and report the evidence rather than introducing a weaker fallback.
