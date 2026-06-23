# @balaenis/pi-format

Format files from [Pi](https://github.com/earendil-works/pi) using project-local
formatters. Provides an LLM-callable `format` tool, a `/format` slash command,
and automatic formatting after successful built-in `write`/`edit` tool calls.

## Features

- Explicit formatting via the `format` tool or `/format` command.
- Automatic formatting after Pi's built-in `write` and `edit` tools succeed.
- Built-in detection for Prettier, Biome, Ruff, gofmt, rustfmt, shfmt, and
  clang-format.
- User-defined formatters and per-project overrides via JSONC config.

## Usage

Install the package (once published):

```sh
pi install npm:@balaenis/pi-format
```

For local development, build the package and load it with `-e`:

```sh
mise run build --package packages/pi-format
pi -e ./packages/pi-format/dist/index.js
```

Format a file explicitly:

```sh
/format src/index.ts
/format --formatter prettier src/index.ts
```

The `format` tool can also be called by the LLM when it needs to format files.

## Configuration

Global config: `~/.pi/agent/@balaenis/pi-format/config.json`
Project config: `<cwd>/.pi/@balaenis/pi-format/config.json`

Project config overrides global config by formatter name.

```jsonc
{
  "enabled": true,
  "formatOnWrite": true,
  "formatters": {
    "prettier": {
      "disabled": false,
      "command": ["bunx", "prettier", "--write", "$FILE"],
      "extensions": [".js", ".jsx", ".ts", ".tsx", ".json", ".md"],
    },
    "biome": {
      "disabled": true,
    },
    "custom-md": {
      "command": ["markdownfmt", "$FILE"],
      "extensions": [".md"],
    },
  },
}
```

### Config fields

- `enabled` — master switch. `false` disables the tool, command, and automatic
  hook but still registers them so the user sees a clear disabled message.
- `formatOnWrite` — when `false`, disables automatic post-`write`/`edit`
  formatting while keeping explicit formatting available.
- `formatters.<name>.disabled` — disable a single formatter.
- `formatters.<name>.command` — override a built-in command or define a custom
  formatter. Must include the `$FILE` token.
- `formatters.<name>.extensions` — override supported extensions. Required for
  custom formatters. Each entry must start with `.`.
- `formatters.<name>.timeoutMs` — per-formatter timeout in milliseconds.

## Automatic formatting

When `enabled` and `formatOnWrite` are both `true`, successful built-in `write`
and `edit` tool results automatically trigger formatting on the target file.
Automatic formatting is best-effort: a formatter failure does not convert a
successful `write`/`edit` result into an error.

Automatic formatting uses `tool_result` event handling and
`withFileMutationQueue` to serialize with other mutations on the same file. It
does not override Pi's built-in `write`/`edit` tools.

Because formatting runs after the edit result is computed, the diff shown by
Pi's built-in `edit` tool does not include formatter-produced changes.

## Built-in formatter recipes

| Formatter      | Extensions                                                                                           | Detection rule                                 |
| -------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `biome`        | `.js` `.jsx` `.ts` `.tsx` `.json` `.jsonc` `.css`                                                    | `biome.json`/`biome.jsonc` and `biome` on PATH |
| `prettier`     | `.js` `.jsx` `.ts` `.tsx` `.mjs` `.cjs` `.css` `.scss` `.json` `.jsonc` `.yaml` `.yml` `.md` `.html` | `prettier` on PATH                             |
| `ruff`         | `.py` `.pyi`                                                                                         | `ruff` on PATH                                 |
| `gofmt`        | `.go`                                                                                                | `gofmt` on PATH                                |
| `rustfmt`      | `.rs`                                                                                                | `rustfmt` on PATH                              |
| `shfmt`        | `.sh` `.bash` `.zsh`                                                                                 | `shfmt` on PATH                                |
| `clang-format` | `.c` `.cc` `.cpp` `.cxx` `.h` `.hh` `.hpp` `.hxx`                                                    | `.clang-format` and `clang-format` on PATH     |

Detection is conservative: if a formatter is not clearly available it is not
used. Recipes are never installed implicitly.

## Future optimization: write/edit overrides

An advanced alternative would be to register replacement `write` and `edit`
tools. This implementation intentionally avoids that approach because it has
higher maintenance risk when Pi core tool schemas, details, and rendering
assumptions change.

## Development

```sh
mise run test --package packages/pi-format
mise run typecheck --package packages/pi-format
mise run build --package packages/pi-format
hk check
```
