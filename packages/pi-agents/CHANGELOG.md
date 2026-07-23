# Changelog

## Unreleased

### Performance

- **pi-agents:** lazy-load the optional Grok ACP runtime (and bundled ACP SDK/Zod graph) behind one memoized dynamic import with opt-in Bun code splitting under `dist/chunks/`. Extension import and Pi runtime paths no longer pay the ACP graph cost up front; the first `runtime: "grok-acp"` call loads the hashed façade chunk. Public tool schema, `package.json` exports, and the Pi extension entry (`dist/index.js`) are unchanged — published installs must retain `dist/chunks/`.

## [0.2.2](https://github.com/balaenis/pi-toolset/compare/pi-agents-v0.2.1...pi-agents-v0.2.2) (2026-07-23)


### Bug Fixes

* release new version ([cca4587](https://github.com/balaenis/pi-toolset/commit/cca4587e86e2411b7bde189d73abfd4918c73904))

## [0.2.1](https://github.com/balaenis/pi-toolset/compare/pi-agents-v0.2.0...pi-agents-v0.2.1) (2026-07-23)

### Bug Fixes

- **pi-agents:** remove agents path from manifest and update doc examples ([7c66f81](https://github.com/balaenis/pi-toolset/commit/7c66f816913489d5e8165180b8b22677df58384b))

## [0.2.0](https://github.com/balaenis/pi-toolset/compare/pi-agents-v0.1.0...pi-agents-v0.2.0) (2026-07-22)

### Features

- **pi-agents:** optimize builds with runtime bundling and subpath Effect imports ([ecaadc8](https://github.com/balaenis/pi-toolset/commit/ecaadc851619f4c67f621925c8d5a4ed6e948aba))

### Bug Fixes

- **build:** exclude source files from published packages ([18fa8c0](https://github.com/balaenis/pi-toolset/commit/18fa8c0daae92eaf2bfd64ddd54d2906e7c6ab4d))

## [0.1.0](https://github.com/balaenis/pi-toolset/compare/pi-agents-v0.0.1...pi-agents-v0.1.0) (2026-07-22)

### ⚠ BREAKING CHANGES

- **pi-agents:** rename debug agent to debugger, skip disabled lsp recipes
- **pi-agents:** runtime "grok", allowReplay, and replay resume capability are no longer supported. Legacy records using them fail closed; start a new grok-acp run instead.
- **agents:** setWidget now receives a factory function returning a Component instead of string arrays. Consumers using the old string[] widget API must switch to Component-based widgets.
- **pi-agents:** `completionGuard` field is replaced by `completionCheck: string[]`.

### Features

- **agents:** add tools field to reviewer agent ([1aec4b3](https://github.com/balaenis/pi-toolset/commit/1aec4b383864217938e647ac64034df44e9376e4))
- **grok-parser:** split stream into per-turn messages via thought boundaries ([1e8139d](https://github.com/balaenis/pi-toolset/commit/1e8139d7e62d8ed268ddbcf3afbcb4d7350dddde))
- **pi-agents:** add /agent and /agent:&lt;name&gt; slash-command invocation ([b7b95f1](https://github.com/balaenis/pi-toolset/commit/b7b95f139ad55489dfc392cd7798a880c5fd22a2))
- **pi-agents:** add /agent config TUI with session-scoped overrides ([d8c0508](https://github.com/balaenis/pi-toolset/commit/d8c0508e4d96052a27c0f256e3f30636136efdec))
- **pi-agents:** add abort Effect mapping and Effect waitForIdle ([2ab123d](https://github.com/balaenis/pi-toolset/commit/2ab123daf150b5f9d44a18e1d20b899b5857761a))
- **pi-agents:** add ACP session persistence, resume, and interactive transport ([2f42b8c](https://github.com/balaenis/pi-toolset/commit/2f42b8cb5489bb56c73f52ecc94607779555bd0a))
- **pi-agents:** add agent config overrides and remove confirmation prompt ([224a61f](https://github.com/balaenis/pi-toolset/commit/224a61fe142f25f48fce3d24320313b7e27e2203))
- **pi-agents:** add agent output rendering, chain cancellation, and title support ([074238f](https://github.com/balaenis/pi-toolset/commit/074238fb482d7c82ed529c97c2f4477ea2662a25))
- **pi-agents:** add background agent execution with session-scoped job manager ([abac49b](https://github.com/balaenis/pi-toolset/commit/abac49b89ebe7108a00125a8079fac6ec273df98))
- **pi-agents:** add compact idempotent result snapshots ([ca5cf41](https://github.com/balaenis/pi-toolset/commit/ca5cf419c96144c97cd9d7dde1b82395f26abacb))
- **pi-agents:** add compact result presentation contract ([abf6b7b](https://github.com/balaenis/pi-toolset/commit/abf6b7b90efd440b9582db6d10241e165f658f7a))
- **pi-agents:** add completion guard and worktree isolation for mutating agents ([c3765c0](https://github.com/balaenis/pi-toolset/commit/c3765c027a954353f7975f659d0a7f0411a5657d))
- **pi-agents:** add continuous spinner animation with lifecycle cleanup ([995497e](https://github.com/balaenis/pi-toolset/commit/995497e6766d127f022795ae9a9bdffe253c1b8d))
- **pi-agents:** add Ctrl+R host resume from Agent View detail panel ([7000512](https://github.com/balaenis/pi-toolset/commit/70005120161cb3fbd16e87931f5f6f42db44f1ec))
- **pi-agents:** add disk fallback for skills discovery and make resolution async ([5dde88f](https://github.com/balaenis/pi-toolset/commit/5dde88f6bb1171452a26993072807c4de05fce20))
- **pi-agents:** add durable runs and interactive agent mode ([dbfd6f9](https://github.com/balaenis/pi-toolset/commit/dbfd6f934955433fe80bec1427a78b230c0f9c78))
- **pi-agents:** add dynamic fanout and collect chain steps ([00ceab9](https://github.com/balaenis/pi-toolset/commit/00ceab9265ac2cddfae7e683f965230471354a39))
- **pi-agents:** add Effect runtime bridge and freeze phase-0 conventions ([5c0f176](https://github.com/balaenis/pi-toolset/commit/5c0f1760242c9c4cb78fb4060a7da23e5cdc0f6c))
- **pi-agents:** add frontmatter extensions and security depth guard ([0b3f135](https://github.com/balaenis/pi-toolset/commit/0b3f13512de2d1a2fc319f9d5badfb4c8d9c73e7))
- **pi-agents:** add Grok ACP runtime for structured tool calls and usage stats ([466bcdf](https://github.com/balaenis/pi-toolset/commit/466bcdf34f23574d91a7a201353a4554d61728cc))
- **pi-agents:** add Grok CLI runtime support for subagent execution ([185368e](https://github.com/balaenis/pi-toolset/commit/185368e48da8aca3cae6bf674c14fa2b277da48c))
- **pi-agents:** add incremental Pi RPC record projector ([79ee744](https://github.com/balaenis/pi-toolset/commit/79ee744734d99d512d70510594711f89ae3efe92))
- **pi-agents:** add left/right arrow navigation to agent navigator ([7948c4b](https://github.com/balaenis/pi-toolset/commit/7948c4b763729d0bca3063a858355825ad1fd3c7))
- **pi-agents:** add named chain outputs with {outputs.&lt;name&gt;} template syntax ([243010f](https://github.com/balaenis/pi-toolset/commit/243010f83e325ed8fac782df8978061460ed130f))
- **pi-agents:** add per-agent maxSubagentDepth and PI_AGENT_TOOL_AVAILABLE guard ([943ff8c](https://github.com/balaenis/pi-toolset/commit/943ff8c174c016631321bb679ecf3617099a00e4))
- **pi-agents:** add per-invocation model/thinking override to agent tool ([fbeb13b](https://github.com/balaenis/pi-toolset/commit/fbeb13ba868abf4f6e1a94c4a14de3705ff3da9a))
- **pi-agents:** add per-invocation runtime override for subagent tool calls ([99996e4](https://github.com/balaenis/pi-toolset/commit/99996e4093ecf2ad8f56d61523e568e292119be6))
- **pi-agents:** add run-local artifacts and payload externalization ([79d64ae](https://github.com/balaenis/pi-toolset/commit/79d64ae47c04699a79dc0e35667a8ba21a38fc30))
- **pi-agents:** add runId-based resume and remove agent_job tool ([ee8ae36](https://github.com/balaenis/pi-toolset/commit/ee8ae3677eb2d9ae6b4616daf30fd4838a70d6e0))
- **pi-agents:** add skills allowlist support for agent children ([f6e851f](https://github.com/balaenis/pi-toolset/commit/f6e851fa6469ee414a54bb613c8e4825cd243e04))
- **pi-agents:** add status glyphs (◐/●/⊘) to agent nav and widget with theme colors ([4b3c86f](https://github.com/balaenis/pi-toolset/commit/4b3c86f871b9dda6ae50d814c9d43d1cd14ae1e3))
- **pi-agents:** add structured output extraction and schema subset validator ([a5ca754](https://github.com/balaenis/pi-toolset/commit/a5ca754553151dbd432aa1f6e7fa0a5b9bfcb522))
- **pi-agents:** add subagent package for delegating tasks to specialized agents ([2da9035](https://github.com/balaenis/pi-toolset/commit/2da9035ffb9eea4cc1e6980252eff8e814587cd8))
- **pi-agents:** add systematic debug bundled agent ([28e5678](https://github.com/balaenis/pi-toolset/commit/28e567824cc4a7510ff9fc805d168039b68ec291))
- **pi-agents:** add themed title and body styling to below-editor agent chrome ([23a8716](https://github.com/balaenis/pi-toolset/commit/23a871622cf065bd883eb70f3df16af7cafb0214))
- **pi-agents:** add transaction lock system and strict write phases for run.json durability ([429aed2](https://github.com/balaenis/pi-toolset/commit/429aed253ead946b0f28b0fb208dc9a5b3e65bc3))
- **pi-agents:** add update-driven spinner animation to agent tool TUI rendering ([58be797](https://github.com/balaenis/pi-toolset/commit/58be797a20426a9d81db111cd3f16fa1e3275f07))
- **pi-agents:** add worktreeSetupHook and criticalSystemReminder ([986ec2c](https://github.com/balaenis/pi-toolset/commit/986ec2c069eb26b359f44aef1aacbdf3430b7b06))
- **pi-agents:** add write tool to planner agent ([b1866d7](https://github.com/balaenis/pi-toolset/commit/b1866d7605925e7c73c88b0d38b92481a65d9995))
- **pi-agents:** adopt Either internals for template and completion-check ([f14f1a0](https://github.com/balaenis/pi-toolset/commit/f14f1a094e8ad342edf2a2985af7fc71417f870c))
- **pi-agents:** adopt Either internals for worktree helpers ([2f30223](https://github.com/balaenis/pi-toolset/commit/2f302231c73b70d8fe4f68c44622a407f92d0a20))
- **pi-agents:** animate collapsed running status with outline-fill spinner ([882eff7](https://github.com/balaenis/pi-toolset/commit/882eff7c864a3af816ed81681dc09297730052af))
- **pi-agents:** async continuation spill and stricter run finalization ([320e0ea](https://github.com/balaenis/pi-toolset/commit/320e0ea9a9e93244b443a02b5db353c49612c0a2))
- **pi-agents:** await terminal barriers and provisional running updates ([5108140](https://github.com/balaenis/pi-toolset/commit/51081400829305d3c272844d5305f52f899eb3b3))
- **pi-agents:** capitalize agent names in render output ([b385e41](https://github.com/balaenis/pi-toolset/commit/b385e41340f9736fbb218930ccd98a9b4f51d464))
- **pi-agents:** compact snapshots at runtime and terminal boundaries ([0f1baaf](https://github.com/balaenis/pi-toolset/commit/0f1baaf3043bc501f21ba5791c97dd62afb5d544))
- **pi-agents:** cross-platform RunStore with path normalization, directory sync hardening, and expanded test coverage ([fe6bcaf](https://github.com/balaenis/pi-toolset/commit/fe6bcaf879d6be037c23613449b33e27dfbcd59d))
- **pi-agents:** Effect-ify runSerial and document post-program lock leftover ([bf22a7d](https://github.com/balaenis/pi-toolset/commit/bf22a7dc1a128873e387f4651df041f6ddfc9ce8))
- **pi-agents:** Effect-sleep lock wait on mutating store paths ([f7301d4](https://github.com/balaenis/pi-toolset/commit/f7301d421e00d4e5a4395569f6a17b228f4dc11f))
- **pi-agents:** enforce compact durable results on write and resume ([c1376f3](https://github.com/balaenis/pi-toolset/commit/c1376f373408648626c2bf1f54aad42a71c066a2))
- **pi-agents:** implement fork-context via prepareAgentContext and runStepWithContext ([a925f9b](https://github.com/balaenis/pi-toolset/commit/a925f9b21fd6a5d6106ec46ec8bae142aa9140e0))
- **pi-agents:** inject artifact reader on Pi launches when required ([7edc7de](https://github.com/balaenis/pi-toolset/commit/7edc7decfa222c1852ee8aa5f9f291e1ac60d110))
- **pi-agents:** mark chain handoffs that require artifact reader ([4ece419](https://github.com/balaenis/pi-toolset/commit/4ece419f0f731c82dbb4ff03d3048b33158f32b8))
- **pi-agents:** project oversized canonical RPC events in transport ([276e642](https://github.com/balaenis/pi-toolset/commit/276e642954b69e8e313c9ec66a311c6c92c931d7))
- **pi-agents:** raise RPC stdout record limit from 2 MiB to 8 MiB ([6978aa8](https://github.com/balaenis/pi-toolset/commit/6978aa8366ceb3f1d7a5738d73b8be6a4b13e24e))
- **pi-agents:** refresh skill cache before /agent slash-command execution ([4fa0dbc](https://github.com/balaenis/pi-toolset/commit/4fa0dbc1d78650a01252d5b1b13713d785cccd5f))
- **pi-agents:** rehydrate projected Pi shells at agent_settled ([5fbda75](https://github.com/balaenis/pi-toolset/commit/5fbda755e387b0f6c65908531d9eccfd0cc654b2))
- **pi-agents:** remove hard title maxLength; unify collapsed preview clamp at 30 columns ([2ecd247](https://github.com/balaenis/pi-toolset/commit/2ecd2477b8a7b1ecba2cee773d5245b7f34292d0))
- **pi-agents:** render below-editor agent list as a tree with ├─/└─ branches ([d2384a3](https://github.com/balaenis/pi-toolset/commit/d2384a3f20c02bb5ab0f6d5aa53600e49fc06ebf))
- **pi-agents:** replace completionGuard boolean with configurable completionCheck ([3ed738f](https://github.com/balaenis/pi-toolset/commit/3ed738f568eb93225c2e45acf9d88fbbddd3079c))
- **pi-agents:** resolve fanout itemsRef on chain resume ([0696070](https://github.com/balaenis/pi-toolset/commit/0696070c33037510c2c6511a814840ded461c683))
- **pi-agents:** resolve parent symlinks in runs root and improve store error formatting ([6ec6d65](https://github.com/balaenis/pi-toolset/commit/6ec6d65ff2edd7a9383ca877573627111bf04db3))
- **pi-agents:** rework package agent discovery via settings.json packages[] ([f4ccb69](https://github.com/balaenis/pi-toolset/commit/f4ccb69a207f02506352dc17fa492290221eb53d))
- **pi-agents:** RPC overflow review fixes rounds 1-7 with epoch safety and structural projection validation ([c3cbc21](https://github.com/balaenis/pi-toolset/commit/c3cbc213a6c3951bcc8c8456532483a85ea87ffb))
- **pi-agents:** run artifact-store IO through Effect boundary ([0575a52](https://github.com/balaenis/pi-toolset/commit/0575a52123618dfa4ab857ef3eb6511672fadf6f))
- **pi-agents:** run durable write queue tasks through Effect ([0fd5095](https://github.com/balaenis/pi-toolset/commit/0fd5095c28cc9d5c118d86ab9b24536f594cd5ab))
- **pi-agents:** scaffold Effect adoption with multi-phase plan and dependency ([f93f90b](https://github.com/balaenis/pi-toolset/commit/f93f90b63185698a8aba992f6e5298bdb458ad98))
- **pi-agents:** schedule chain fanout workers via Effect ([a79d554](https://github.com/balaenis/pi-toolset/commit/a79d55485b6ece316cae357bd7f8e79fdcefb8b1))
- **pi-agents:** ship artifact reader entry and document budgets ([e7e7f5e](https://github.com/balaenis/pi-toolset/commit/e7e7f5e45895a3f0603d46b07ab1cd8005d004f9))
- **pi-agents:** show live progress widget during agent command invocation ([665a7a2](https://github.com/balaenis/pi-toolset/commit/665a7a2b15328229550e8c6d563a66827933910f)), closes [#2](https://github.com/balaenis/pi-toolset/issues/2)
- **pi-agents:** show progressive usage fields for grok-acp mid-turn ([ce1fbc8](https://github.com/balaenis/pi-toolset/commit/ce1fbc89ff87e97f99d5e59fe1fa1e259d0cbe2b))
- **pi-agents:** show thinking level in usage stats display ([082df64](https://github.com/balaenis/pi-toolset/commit/082df6418787391c4224fa385a8eed1c8bb65d25))
- **pi-agents:** spill oversized fanout aggregates to itemsRef ([8d05136](https://github.com/balaenis/pi-toolset/commit/8d05136750b73a18f2964dbf1c0d38a2313904b5))
- **pi-agents:** support package-published agents under project scope ([c5a5149](https://github.com/balaenis/pi-toolset/commit/c5a5149b7775d5cd800b1abe0f36c477bc812b5c))
- **pi-agents:** truncate collapsed activity lines to available width ([76e5126](https://github.com/balaenis/pi-toolset/commit/76e5126aed320fb0481030f6df1977b32ccc13b0)), closes [#37](https://github.com/balaenis/pi-toolset/issues/37)
- **pi-agents:** update spinner frames and timing ([66a3f57](https://github.com/balaenis/pi-toolset/commit/66a3f57d69adb3a3571d8c15eb47d11667f67c84))
- **pi-agents:** use Effect Deferred for session-lease ownership ([4238de7](https://github.com/balaenis/pi-toolset/commit/4238de74485391a77d6972ce8cc159048e81733a))
- **pi-agents:** validate structured chain outputs ([313de8c](https://github.com/balaenis/pi-toolset/commit/313de8c6fbe2e18ee9438381ff5477e10de12fd7))
- **pi-agents:** validate working directory before spawning agent ([fd95fee](https://github.com/balaenis/pi-toolset/commit/fd95fee0a5f24f28bfd6aef749ad4409366467f3))
- **pi-agents:** wire artifact reader handoff hooks and docs ([c1a013e](https://github.com/balaenis/pi-toolset/commit/c1a013e7b6e411c944b46a7351b0796db91172c9))
- **pi-agents:** wire up maxTurns, systemPromptMode, noContextFiles, noSkills runtime behavior ([be6e668](https://github.com/balaenis/pi-toolset/commit/be6e668fb987f3d98ffcadaf61e434957233922f))

### Bug Fixes

- **build:** externalize peers/deps and strip CRLF from jq ([3f76214](https://github.com/balaenis/pi-toolset/commit/3f76214048bcd1d6a2e74008e5b15de4e0349602))
- make `pi install git:github.com/balaenis/pi-toolset` work ([5defc2e](https://github.com/balaenis/pi-toolset/commit/5defc2eba6b890167d37147b830ea4860b11fcd9))
- **pi-agents:** allow fresh single/parallel runs without allowReplay ([b38c2dd](https://github.com/balaenis/pi-toolset/commit/b38c2dd9181c6c13d334761b37f0556c25aa8eca))
- **pi-agents:** apply dim theme consistently to summary line content ([088be7d](https://github.com/balaenis/pi-toolset/commit/088be7d1cd0510344b425e8376454327befd7f7c))
- **pi-agents:** bound interactive projection, validate durable shell, fix ANSI truncate ([bdefbff](https://github.com/balaenis/pi-toolset/commit/bdefbffb5926da69a689ca6e1a2fc37f6dc74eb9))
- **pi-agents:** break jiti cycle that broke parallel emptyUsage ([2a61401](https://github.com/balaenis/pi-toolset/commit/2a614014d45bffa87a7a97fb55f12757bede4eb2))
- **pi-agents:** close chain/fanout/resume artifact handoff paths ([6abecac](https://github.com/balaenis/pi-toolset/commit/6abecacc039f7507eb31f12bea7dc27b81f905a1))
- **pi-agents:** close continuation/terminal barrier review findings ([a98c7e8](https://github.com/balaenis/pi-toolset/commit/a98c7e8737cfebc10e6dbb45b0e58f6678b47a45))
- **pi-agents:** collapse multi-line tool output and queues to single terminal rows ([3191ca5](https://github.com/balaenis/pi-toolset/commit/3191ca587c10083fc0cbd01c01b2a4b753421e93))
- **pi-agents:** deliver prior same-chunk RPC records before failure ([dd5505e](https://github.com/balaenis/pi-toolset/commit/dd5505e892b1c31b05010a028b320bb55f52ebeb))
- **pi-agents:** flatten agent_job params schema for OpenAI tool compatibility ([57b0582](https://github.com/balaenis/pi-toolset/commit/57b05820c3d8507a7c6a3c0dbb25c2a54c561d6f))
- **pi-agents:** harden explore agent tool denylist ([457e153](https://github.com/balaenis/pi-toolset/commit/457e153ca66d02f280519226950f03021c21d260))
- **pi-agents:** harden finishUnit races and strict durable sync ([4784b8d](https://github.com/balaenis/pi-toolset/commit/4784b8d9060db965a3a1bc51f27905fd8785571c))
- **pi-agents:** harden projected settle rehydrate failure paths ([4f40eab](https://github.com/balaenis/pi-toolset/commit/4f40eabd26b195e2281d30c0656721078e32f532))
- **pi-agents:** harden RPC projector budgets and UTF-8 accounting ([a71d632](https://github.com/balaenis/pi-toolset/commit/a71d6321ea147ff767c5f73223c3c5eb2cd7761f))
- **pi-agents:** hide empty collapsed activity lines from inline preview ([b82a6ac](https://github.com/balaenis/pi-toolset/commit/b82a6aca3a434a9f439c0aafae62ed96e8882a4a))
- **pi-agents:** lock 8 MiB RPC baseline and disable get_messages ([d4206dd](https://github.com/balaenis/pi-toolset/commit/d4206ddda7ef53a5dda33a800369c0ace3e53df4))
- **pi-agents:** normalize Plan heading level and completion check ([9359282](https://github.com/balaenis/pi-toolset/commit/93592828888bb5a181b4be58c3a954020d293640))
- **pi-agents:** preserve failure stacks and stop mislabeling context_error ([069adf1](https://github.com/balaenis/pi-toolset/commit/069adf15e09fa5c1f26f17788cdabe436cbf0a12))
- **pi-agents:** rename widget key to match package name and improve explore agent description ([5d7d918](https://github.com/balaenis/pi-toolset/commit/5d7d918d6c4256d705849d23218523fa8de4eff4))
- **pi-agents:** round 1-8 review remediation — snapshot isolation, fanout cancel ordering, test coverage ([033ba4e](https://github.com/balaenis/pi-toolset/commit/033ba4eae30e3e113a4b9f4cf1e90ff510fd0388))
- **pi-agents:** strip SGR full-reset from truncated display strings ([68daa11](https://github.com/balaenis/pi-toolset/commit/68daa1159afb9d45d22a92be8eddf6f9c054ebb8))
- **pi-agents:** use separate promptTimeoutMs for prompt stage to prevent timeout mis-kill ([3b70b84](https://github.com/balaenis/pi-toolset/commit/3b70b844100d9548998bebc9ecc9fdfd87bf0846))
- **pi-agents:** use write-capable handle in fsyncPathStrict to fix Windows EPERM ([7e62ba7](https://github.com/balaenis/pi-toolset/commit/7e62ba70751c27d720518bb6fa0e91da1bcc9838))
- replace workspace protocol with explicit version for npm compatibility ([f8cd088](https://github.com/balaenis/pi-toolset/commit/f8cd0881067cfb7e72f53d320c69f6398e264e6e))

### Performance Improvements

- **pi-agents:** bound interactive transcript retention ([60b7d66](https://github.com/balaenis/pi-toolset/commit/60b7d666de3e73c7417bfeb549f852fc133cca43))
- **pi-agents:** coalesce high-frequency content updates ([f3bf5b0](https://github.com/balaenis/pi-toolset/commit/f3bf5b01dc462944a34fcb813a745e62bce0369d))
- **pi-agents:** structure-share frozen tool payloads in interactive snapshots ([9b9b710](https://github.com/balaenis/pi-toolset/commit/9b9b71086eda76418ac60e6448f1a5aa03018ee3))
- **pi-agents:** use copy-on-write shells for parallel and chain aggregates ([864c263](https://github.com/balaenis/pi-toolset/commit/864c263d926cfb983331ca33b6b25d4e7d298bad))

### Reverts

- undo 5defc2e except @balaenis/pi-log version change ([3484228](https://github.com/balaenis/pi-toolset/commit/3484228d3364f5e98f40f8108dd64d6bd94e1a0b))

### Code Refactoring

- **agents:** migrate agent status widget from string arrays to TUI Container ([2e779b6](https://github.com/balaenis/pi-toolset/commit/2e779b62e0f0929c4166125f4df920c6da5e2069))
- **pi-agents:** remove plain Grok runtime and harden durable resume ([4da9940](https://github.com/balaenis/pi-toolset/commit/4da9940aea2870a8bd93e86dc33da71b9e99b180))
- **pi-agents:** rename debug agent to debugger, skip disabled lsp recipes ([ab4a560](https://github.com/balaenis/pi-toolset/commit/ab4a560dae409e47cae0ab7412499d15439969e9))
