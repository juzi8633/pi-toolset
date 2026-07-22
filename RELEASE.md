# Release Process

This is a monorepo (`pi-toolset`) of independently versioned Pi extension packages. Each package under `packages/` is released on its own version, changelog, git tag, and npm publish cadence using [release-please](https://github.com/googleapis/release-please) **manifest mode** + [Npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC).

There are two release channels per package:

- **Stable (`latest`):** merging a release-please release PR publishes a stable version to the `latest` npm dist-tag.
- **Pre-release (`next`):** opening/updating a release-please release PR publishes a `x.x.x-next.N` snapshot to the `next` npm dist-tag for testing.

You can also trigger a manual release from the GitHub Actions tab (see [Manual Releases](#manual-releases)).

## Repository Layout

```
release-please-config.json        # manifest-mode config: one entry per package
.release-please-manifest.json     # per-package current version tracker
packages/<name>/package.json      # each package owns its version
```

Only list packages that exist in `release-please-config.json` (release-please errors on a configured path with no `package.json`).

## Conventional Commits

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `fix:` patches
- `feat:` minor features
- `feat!:` or `fix!:` breaking changes

release-please attributes a commit to a package by the path it touches. A commit touching `packages/pi-lsp/**` bumps only `pi-lsp`. Commits touching multiple packages bump all of them in one consolidated release PR. Root-only commits (e.g. `chore:` on `mise.toml`) bump nothing unless a package path is also touched.

### Pre-1.0 Versioning

While a package version is `0.x.x`, breaking changes bump **minor** (`bump-minor-pre-major: true`).

## Tags

Tags are component-scoped (`include-component-in-tag: true`): `pi-lsp-v0.1.0`, `other-package-v0.2.0`. This prevents collisions between packages.

## First Release (per package)

Before automated releases work for a package, perform its first release manually. Repeat for each package.

Why:

- This uses [Npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers).
- The first release creates the npm package on npmjs.com.
- That then allows trusted publishing with GitHub Actions for future releases.

### Package Map

| Package path         | npm package           | Bootstrap tag      |
| -------------------- | --------------------- | ------------------ |
| `packages/pi-lsp`    | `@balaenis/pi-lsp`    | `pi-lsp-v0.0.1`    |
| `packages/pi-format` | `@balaenis/pi-format` | `pi-format-v0.0.1` |
| `packages/pi-agents` | `@balaenis/pi-agents` | `pi-agents-v0.0.1` |

### Prerequisites

- Use an npm account with permission to create and publish packages in the `@balaenis` npm organization.
- Install the repository toolchain with `mise install` and `mise run setup`.
- Ensure the scoped package name is available on npm.
- Use local npm authentication for the first publish. GitHub OIDC is available only inside the trusted GitHub Actions workflow and cannot bootstrap a package that does not yet exist.

### Steps

1. Confirm the package's `package.json` is correct:
   - `version` is `0.0.1`
   - `name` uses the `@balaenis/` scope
   - `repository.url` is `https://github.com/balaenis/pi-toolset.git`
   - `publishConfig.access` is `public`
   - `files`, `exports`, and `pi.extensions` are correct

2. Authenticate locally with the npm account that has access to the organization:

   ```sh
   npm login --registry=https://registry.npmjs.org --auth-type=web
   npm whoami
   ```

   `devDependencies`, npm organization membership, and local credentials are separate concerns. The package's scoped `name` determines that `npm publish` targets the `@balaenis` organization; the logged-in npm account must have permission to create that package.

3. Run a dry run from the repository root. The publish task builds the package before packing it:

   ```sh
   mise run publish --package packages/pi-lsp --tag latest --dry-run
   ```

   Inspect the included files and confirm that no secrets, fixtures, or development-only artifacts are present.

4. Publish the first public version:

   ```sh
   mise run publish --package packages/pi-lsp --tag latest
   ```

   If npm requires a one-time password for publishing, pass it explicitly:

   ```sh
   mise run publish --package packages/pi-lsp --tag latest --otp <your-2fa-code>
   ```

   The task runs `npm publish --access public`. With `name: "@balaenis/pi-lsp"`, this creates the package in the `@balaenis` npm organization. Local publishing uses the credentials stored by `npm login`; it does not use OIDC.

5. Verify the published package:

   ```sh
   npm view @balaenis/pi-lsp version dist-tags repository.url
   ```

6. Push a **bootstrap component tag** so the `next` self-skip logic has a baseline. The tag must match `include-component-in-tag: true`:

   ```sh
   git tag pi-lsp-v0.0.1
   git push origin pi-lsp-v0.0.1
   ```

7. On npmjs.com, open the package's **Settings → Trusted Publisher**, select **GitHub Actions**, and configure:
   - **Organization or user:** `balaenis`
   - **Repository:** `pi-toolset`
   - **Workflow filename:** `publish.yml` — enter only the filename, not `.github/workflows/publish.yml`
   - **Environment:** leave empty unless the workflow job is later bound to a matching GitHub environment
   - **Allowed actions:** select at least `npm publish`

   Trusted publishing is configured separately for every npm package. A personal GitHub repository can publish to an npm organization package because npm validates the explicitly trusted repository and workflow; the GitHub owner and npm package owner do not need to be the same kind of account.

8. Confirm that `.github/workflows/publish.yml` retains these permissions:

   ```yaml
   permissions:
     id-token: write
     contents: read
   ```

   During `npm publish`, npm CLI requests a short-lived GitHub OIDC token and exchanges it for package-scoped publish authorization. No `NPM_TOKEN` is required for this workflow. OIDC authentication exists only for the publish operation, so `npm whoami` does not report it.

9. After a trusted publish succeeds, [restrict token access](https://docs.npmjs.com/trusted-publishers#recommended-restrict-token-access-when-using-trusted-publishers) and revoke obsolete automation tokens.

Repeat the procedure for each package, substituting the package path, npm name, and component tag from the table above.

## Release Workflow

### Automated process

1. Push commits to `main`.
2. release-please (`release.yml`) analyzes commits per package and opens/updates a single consolidated release PR with version bumps, `CHANGELOG.md` updates, and `package.json`/`src/version.ts` bumps for each changed package.
   - Opening/updating the release PR dispatches a `next` publish for every workspace package (packages with no new commits since their last component tag self-skip).
3. Review and merge the release PR.
   - Merging dispatches a `latest` publish for each path that had a release created (`paths_released`).

### Version sources

| Channel  | Trigger                   | Version                                                         | Example         |
| -------- | ------------------------- | --------------------------------------------------------------- | --------------- |
| `latest` | release PR merged         | release-please `default` strategy from conventional commits     | `0.1.0`         |
| `next`   | release PR opened/updated | `<release-of-last-released>-next.<commits-since-component-tag>` | `0.0.1-next.14` |

The `next` snapshot is a prerelease of the **last-released** version plus the commits since that package's last component tag (a preview of "what is on `main` since the last release"). It is computed by the `publish` task, not release-please.

## Manual Releases

Trigger `publish.yml` from the GitHub Actions tab ("Run workflow"), supplying:

- **path:** the package directory, e.g. `packages/pi-lsp`
- **tag:** `latest` or `next`

This builds and publishes that one package via OIDC trusted publishing. Use manual releases for hot-fixes outside the normal release cycle.

## Publishing

Releases are published to npm when the release-please PR is merged (`latest`) or when it is opened/updated (`next`).

### NPM Trusted Publishing

No npm tokens are needed — authentication is handled via OIDC. Each publish uses short-lived, cryptographically-signed tokens specific to the workflow, with automatic provenance attestations.

Trusted publishing is configured **per npm package**, all pointing at the shared `publish.yml` workflow in this repo (see [First Release](#first-release-per-package)).

## Advanced Release Features

### Force a Specific Version

Use the `Release-As` footer in a commit message (touching the package path) to force a specific version:

```sh
git commit --allow-empty -m "chore: release pi-lsp 2.0.0" -m "Release-As: 2.0.0"
```

release-please will open a PR for version `2.0.0` for that package regardless of commit message types.

### Update Extra Files During Release

`src/version.ts` is updated per package via `extra-files` in `release-please-config.json`. The `x-release-please-version` magic comment marks the version constant. To track version in additional files, add them to that package's `extra-files` array.

Supported file types: generic, JSON (JSONPath), YAML (JSONPath), XML (XPath), TOML (JSONPath).

### Magic Comments for Version Markers

- `// x-release-please-version` — full semver
- `// x-release-please-major` / `x-release-please-minor` / `x-release-please-patch` — individual numbers

## Do Not

- Manually edit release-please release PRs
- Manually create GitHub releases for a package
- Manually edit a package's `version` (release-please owns `latest`; the `publish` task owns `next`)
- Delete a package's component tags (the `next` self-skip relies on them)
