# pi-toolset

A monorepo of [Pi](https://github.com/earendil-works/pi) extension packages. Each package under `packages/` is independently versioned and released.

## Packages

| Package                            | npm                   | Description                                                                    |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------------------ |
| [`pi-lsp`](packages/pi-lsp/)       | `@balaenis/pi-lsp`    | LSP support for Pi (language-server lifecycle, diagnostics, tools, statusline) |
| [`pi-format`](packages/pi-format/) | `@balaenis/pi-format` | Format files via tool, `/format` command, and automatic post-write/edit hook   |

See each package's `README.md` for usage and configuration.

## Repository Layout

```
packages/<name>/          # independently released packages
release-please-config.json        # manifest-mode release config
.release-please-manifest.json     # per-package version tracker
.mise/tasks/              # parameterized tasks (build/test/typecheck/publish take --package)
```

## Development

This repo uses [`mise`](https://mise.jdx.dev) for tooling and [`bun`](https://bun.sh) as the package manager (bun workspaces). Per-package tasks take `--package`:

```sh
mise run setup                                        # install workspace deps + hk
mise run typecheck --package packages/pi-lsp
mise run test --package packages/pi-lsp
mise run build --package packages/pi-lsp
mise run check                                        # hk check (eslint + prettier, repo-wide)
```

## Releasing

Releases are automated via release-please manifest mode + NPM Trusted Publishing. Each package has independent `latest` (stable) and `next` (prerelease) channels. See [RELEASE.md](RELEASE.md) for the full process, including first-release setup per package.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
