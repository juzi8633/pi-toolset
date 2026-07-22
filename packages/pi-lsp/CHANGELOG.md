# Changelog

## [0.1.1](https://github.com/balaenis/pi-toolset/compare/pi-lsp-v0.1.0...pi-lsp-v0.1.1) (2026-07-22)


### Bug Fixes

* **build:** exclude source files from published packages ([18fa8c0](https://github.com/balaenis/pi-toolset/commit/18fa8c0daae92eaf2bfd64ddd54d2906e7c6ab4d))

## [0.1.0](https://github.com/balaenis/pi-toolset/compare/pi-lsp-v0.0.1...pi-lsp-v0.1.0) (2026-07-22)


### ⚠ BREAKING CHANGES

* **pi-agents:** rename debug agent to debugger, skip disabled lsp recipes
* **pi-lsp:** remove startupMode and manual session enablement

### Features

* **lsp:** add /lsp diagnostics command to inspect pending and delivered diagnostics ([7d2fdfb](https://github.com/balaenis/pi-toolset/commit/7d2fdfb1a63390de2e79000d58d42c6998f354b8))
* **lsp:** add pull diagnostics and ESLint companion server ([5137aad](https://github.com/balaenis/pi-toolset/commit/5137aad9c64f16765a52c238c90ec70902cdaf05))
* **lsp:** implement multi-server routing with primary/companion and auto/manual modes ([e4cf0ea](https://github.com/balaenis/pi-toolset/commit/e4cf0eaa4fa7d2df26f41a27d01176d2ed8890a9))
* **pi-format:** add format extension package ([524bfdc](https://github.com/balaenis/pi-toolset/commit/524bfdc5cea6243b4fc86b58f44b1d7646038be8))
* **pi-lsp:** add /lsp clean command to refresh or force-clear diagnostics ([bdbe6e1](https://github.com/balaenis/pi-toolset/commit/bdbe6e1299200bc8f62c36ff2048be7bc7040452))
* **pi-lsp:** add built-in Tailwind CSS language server recipe ([64fae7b](https://github.com/balaenis/pi-toolset/commit/64fae7bd1c527f937d534cd979b317b14d991ba9))
* **pi-lsp:** add enabled flag to disable LSP servers ([a0e3b51](https://github.com/balaenis/pi-toolset/commit/a0e3b516e47cd30fc4f0cd786480c238ef77fab0))
* **pi-lsp:** add JSON Schema generation for LSP server config ([631de78](https://github.com/balaenis/pi-toolset/commit/631de782d334b469a9dee69353ab2cdae4e69f10))
* **pi-lsp:** add Windows batch shim support for LSP server spawn ([be20e78](https://github.com/balaenis/pi-toolset/commit/be20e7813be695013ae6fd89e7307bb3b6535583))
* **pi-lsp:** color statusline bolt by diagnostic presence ([f6afe60](https://github.com/balaenis/pi-toolset/commit/f6afe607ad17ef8a7e8a8c5e95ba3f74c7485c64))
* **pi-lsp:** default-disable Tailwind and add /lsp config ([6b8e5ba](https://github.com/balaenis/pi-toolset/commit/6b8e5bafd1c21b4f997e9ee1bb26e47c86897444))
* **pi-lsp:** embed schema descriptions in Typebox and auto-generate on build ([d658454](https://github.com/balaenis/pi-toolset/commit/d65845406ba525211e01cb0d57de2b5db1401f77))
* **pi-lsp:** lifecycle-batch diagnostic delivery via before_agent_start ([4bc5101](https://github.com/balaenis/pi-toolset/commit/4bc51016fc5d711397cd9ed24b4739bec575be80))
* **pi-lsp:** merge recipe defaults with same-name user config entries ([2671efc](https://github.com/balaenis/pi-toolset/commit/2671efc43b9806751e362c5ea54d7c81a6410cad))
* **pi-lsp:** replace ephemeral context diagnostics with durable microtask delivery ([2e047e4](https://github.com/balaenis/pi-toolset/commit/2e047e43a972c84c9532070f832ff53b66003c14)), closes [#87](https://github.com/balaenis/pi-toolset/issues/87)


### Bug Fixes

* make `pi install git:github.com/balaenis/pi-toolset` work ([5defc2e](https://github.com/balaenis/pi-toolset/commit/5defc2eba6b890167d37147b830ea4860b11fcd9))


### Reverts

* undo 5defc2e except @balaenis/pi-log version change ([3484228](https://github.com/balaenis/pi-toolset/commit/3484228d3364f5e98f40f8108dd64d6bd94e1a0b))


### Code Refactoring

* **pi-agents:** rename debug agent to debugger, skip disabled lsp recipes ([ab4a560](https://github.com/balaenis/pi-toolset/commit/ab4a560dae409e47cae0ab7412499d15439969e9))
* **pi-lsp:** remove startupMode and manual session enablement ([640090d](https://github.com/balaenis/pi-toolset/commit/640090d6f0ba51516cb8d5b306f13a8f404eafad))

## Changelog

All notable changes to this project will be documented here by Release Please.
