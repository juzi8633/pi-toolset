# Changelog

## [0.3.0](https://github.com/balaenis/pi-toolset/compare/pi-remote-v0.2.0...pi-remote-v0.3.0) (2026-08-27)


### Features

* **pi-remote:** add /ssh:cwd to switch the remote working directory ([d11c4f7](https://github.com/balaenis/pi-toolset/commit/d11c4f7431315d8281f43e06f4a5d7cfb9ed9a66))


### Bug Fixes

* **pi-remote:** harden SSH prompts and surface failure reasons ([0b70fa7](https://github.com/balaenis/pi-toolset/commit/0b70fa76dd6ad037310417091448b6f231db9c07))
* **version:** align embedded versions with release-please ([a6196e3](https://github.com/balaenis/pi-toolset/commit/a6196e31ef71d83490dfd9d38dd4dda8c5ed70c0))

## [0.2.0](https://github.com/balaenis/pi-toolset/compare/pi-remote-v0.1.0...pi-remote-v0.2.0) (2026-08-08)


### Features

* **pi-remote:** add interactive /ssh command ([3b65de3](https://github.com/balaenis/pi-toolset/commit/3b65de3bec7a6dc5e7ba1162ac838e1309176cff))
* **pi-remote:** add SSH remote tool execution package ([37d6bcf](https://github.com/balaenis/pi-toolset/commit/37d6bcfec94f7ad9e8b4ade7fee0a34cf8ea8eb2))
* **pi-remote:** reuse one OpenSSH multiplexed connection per session ([2792382](https://github.com/balaenis/pi-toolset/commit/27923823b2fafe4e1794d61975571d8ff35c5ba7))
* **pi-remote:** rewrite SSH mode system prompt block ([ad6deb4](https://github.com/balaenis/pi-toolset/commit/ad6deb4f192204b41230e33d906bf33a710526d1))


### Bug Fixes

* **pi-remote:** correct stale package name references ([328c028](https://github.com/balaenis/pi-toolset/commit/328c028a326f31260f66a83382c72d9c3b629f60))
* **pi-remote:** distinguish missing paths from transport failures ([9a1e35b](https://github.com/balaenis/pi-toolset/commit/9a1e35b0ecd6e936e020f5a48689bc64d0b260c1))
* **pi-remote:** register SSH tools only on remote connect ([7d77876](https://github.com/balaenis/pi-toolset/commit/7d7787665a1a4ad2c69d38773e7fbe9fd56fdf08))
