# 第 17 章 工程实践：crate 划分哲学与测试策略

## 本章导读

前十六章我们沿着一次对话的生命周期，把 Codex 的运行时拆开来读了一遍。这一章换个视角：不再问「这段代码做什么」，而是问「**这 135 个 crate、三千多个 Rust 文件，为什么没有烂成一团？**」

这是每个 Agent 开发者迟早要面对的问题。你的 my-agent 今天可能还是一个 TypeScript 单包：`src/` 下面 `agent.ts`、`tools.ts`、`context.ts` 一字排开，import 来去自由。它跑得很好——直到某天你改了 `types.ts` 里一个字段，发现测试全红；或者你想把 Agent 内核塞进一个 VS Code 扩展，发现它和 CLI 的 `process.stdout` 调用缠在一起撕不开。项目变大的代价不是代码变多，而是**改动的影响半径变得不可预测**。

Codex 的答案可以浓缩成三条：用 crate 边界把影响半径关进编译器能检查的笼子里；用一套「假模型服务 + 真内核」的集成测试模式让行为回归可批量编写；用 cargo + bazel 双构建系统同时服务「本地快速迭代」和「CI 全平台确定性构建」。更妙的是，这些规则没有躺在 Wiki 里吃灰，而是写进了仓库根的 `AGENTS.md`——一份同时给人和 AI 编码 Agent 读的工程宪法。本章我们就来读这份宪法，以及它在代码里的落点。

## 源码地图

本章的「源码」有点特殊：除了 Rust 文件，更多是构建配置和工程规范文档。

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `AGENTS.md`（仓库根） | 工程规范总纲：crate 哲学、模块大小、lint 约定、测试流程 | 全书最值得逐字读的非代码文件 |
| `codex-rs/Cargo.toml` | workspace 定义：135 个成员、统一依赖版本、全局 lint | 单点治理的枢纽 |
| `justfile`（仓库根） | 开发任务入口：`just test` / `just fix` / `just fmt` / bazel 系列 | 所有任务的 working-directory 都是 `codex-rs` |
| `MODULE.bazel` + `defs.bzl` + `.bazelrc` | Bazel 侧构建定义 | 与 Cargo 保持「双构建 parity」的第二套系统 |
| `codex-rs/core/tests/all.rs` + `suite/` | core 集成测试：单一测试二进制聚合 126 个测试模块 | `test_codex` 模式的大本营 |
| `codex-rs/core/tests/common/test_codex.rs` | `TestCodexBuilder` 测试基建 | 集成测试可批量编写的秘密 |
| `codex-rs/core/tests/common/responses.rs` | wiremock 假模型服务 + SSE 构造器 | 不打真实 API 就能测 Agent Loop |
| `codex-rs/tui/src/chatwidget/tests/` + `snapshots/` | insta 快照测试实例（全仓 741 个 .snap） | UI 回归的机器可读形态 |
| `tools/argument-comment-lint/` | 自研 Dylint lint：强制 `/*param*/` 参数注释 | 代码风格规则工具化的样板 |
| `codex-rs/core-api/src/lib.rs` | core 的对外门面 crate | 「给臃肿内核加一道窄门」的实操 |

## 核心数据结构

工程实践章没有运行时数据结构，但有几组「配置即结构」的东西值得当数据结构读。

### workspace：单一事实来源

`codex-rs/Cargo.toml` 的 workspace 定义是全部治理的锚点（`codex-rs/Cargo.toml:1-148`）：

```toml
# 来源：codex-rs/Cargo.toml:1-9, 139-152
[workspace]
members = [
    "aws-auth",
    "analytics",
    "agent-graph-store",
    # ... 共 135 个成员
]
resolver = "2"

[workspace.package]
version = "0.0.0"
# Track the edition for all workspace crates in one place. ...
edition = "2024"        # ← 全 workspace 统一 edition，新 crate 自动继承
license = "Apache-2.0"

[workspace.dependencies]
# Internal
codex-core = { path = "core" }
codex-protocol = { path = "protocol" }
# ... 每个内部 crate 的 path 只在这里写一次
# External
tokio = "1"
serde = { version = "1", features = ["rc"] }
# ...
```

注意三个设计：

- **所有 crate 版本号是 `0.0.0`**。这个 workspace 不发布到 crates.io，版本号无意义，干脆归零——省掉了 changesets 式的版本管理开销。对外发布的只有最终二进制（npm 包壳，见[第 2 章](ch02-startup.md)）。
- **依赖版本单点声明**。成员 crate 的 `Cargo.toml` 里只写 `tokio = { workspace = true }`，版本号全在根文件。升级 `tokio` 只改一行，且保证 135 个 crate 用的是同一个 tokio——不可能出现「两个 crate 各编一份不同版本 serde」的菱形依赖地狱。
- **`edition = "2024"` 统一定义**，注释明说了动机：「Track the edition for all workspace crates in one place」，新 crate `cargo new` 出来自动继承。

再往下是同一份文件里的全局 lint 门禁（`codex-rs/Cargo.toml:503-542`）：

```toml
# 来源：codex-rs/Cargo.toml:506-542（节选）
[workspace.lints.clippy]
await_holding_lock = "deny"    # ← .await 期间持有锁，异步死锁温床，直接拒编
disallowed_methods = "deny"
expect_used = "deny"           # ← 库代码不许 .expect()，错误必须显式传播
uninlined_format_args = "deny" # ← format!("{x}") 内联写法，AGENTS.md 同款要求
unwrap_used = "deny"           # ← 同理，不许 .unwrap()
redundant_clone = "deny"
# ... 共 30 余条，全部 deny
```

`unwrap_used = "deny"` 放在 workspace 级别是个强信号：**在这个仓库里，`.unwrap()` 不是风格问题，是编译错误**。测试代码需要松绑时，在测试文件顶部显式写 `#![allow(clippy::unwrap_used)]`——你在 `core/tests/all.rs:1` 和 `suite/prompt_caching.rs:1` 都能看到这行。豁免是局部的、显式的、可被 `rg` 搜出来的，而不是全局放水。

### 两份 Cargo.toml 的体型差

crate 划分是否合理，看 `Cargo.toml` 的长度就有直觉。`codex-protocol` 的全部依赖（`protocol/Cargo.toml:15-46`）：

```toml
# 来源：codex-rs/protocol/Cargo.toml:15-46（节选）
[dependencies]
codex-async-utils = { workspace = true }
codex-execpolicy = { workspace = true }
codex-http-client = { workspace = true }
# ... 内部依赖仅 10 个，其余是 serde/ts-rs/schemars 这类序列化基建
serde = { workspace = true, features = ["derive"] }
serde_json = { workspace = true }
ts-rs = { workspace = true, features = ["uuid-impl", "serde-json-impl", "no-serde-warnings"] }
```

而 `codex-core` 的 `Cargo.toml` 有 175 行，其中 `codex-*` 内部依赖超过 50 个（`core/Cargo.toml:26-65`）：

```toml
# 来源：codex-rs/core/Cargo.toml:26-65（节选）
codex-analytics = { workspace = true }
codex-api = { workspace = true }
codex-apply-patch = { workspace = true }
codex-config = { workspace = true }
codex-login = { workspace = true }
codex-mcp = { workspace = true }
codex-otel = { workspace = true }
codex-rollout = { workspace = true }
codex-tools = { workspace = true }
# ... 总计 50+ 个 codex-* 依赖
```

这个对比就是「协议层 vs 内核层」的量化形态：`protocol` 只依赖序列化基建和少数工具 crate，因此它**几乎不需要重编译**，改动它的字段才会触发下游雪崩；`core` 依赖半个 workspace，因此它**自己天天在变**，但它的变化被 crate 边界挡住，不会强迫 `protocol` 重编译。依赖图的「稳定层在下、易变层在上」不是口号，是可以用依赖数衡量的。

### 测试基建：TestCodexBuilder

集成测试的可写性完全取决于基建。core 的测试支持库是一个独立 crate（`core/tests/common`，在 workspace 里注册为 `core_test_support`），入口是这个 builder（`core/tests/common/test_codex.rs:1330-1357`）：

```rust
// 来源：codex-rs/core/tests/common/test_codex.rs:1330-1357
pub fn test_codex() -> TestCodexBuilder {
    TestCodexBuilder {
        config_mutators: vec![Box::new(|config| {
            config
                .features
                .disable(Feature::Apps) // ← 默认关掉与测试无关的 feature
                .expect("test config should allow Apps override");
            // Snapshot tests opt in explicitly; avoid spawning login shells for every test.
            config
                .features
                .disable(Feature::ShellSnapshot) // ← 默认不拉 login shell，测试更快更稳
                .expect("test config should allow ShellSnapshot override");
        })],
        auth: CodexAuth::from_api_key("dummy"), // ← 假凭据：测试永不过期、永不联网认证
        pre_build_hooks: vec![],
        workspace_setups: vec![],
        // ...
    }
}
```

与之配套的假模型服务在 `core/tests/common/responses.rs`：`start_mock_server()` 起一个 wiremock HTTP 服务，`ev_response_created` / `ev_function_call` / `ev_completed` 等构造函数拼 SSE 事件（`responses.rs:701-930`），`mount_sse_once` 把预录响应挂到 `/responses` 端点上（`responses.rs:1100`），返回的 `ResponseMock`（`responses.rs:39`）还能用 `single_request()`（`responses.rs:50`）取回内核真实发出的请求体做断言。

一句话概括这套基建的哲学：**模型是假的，其它全是真的**——真的 Session、真的回合（turn）状态机、真的工具路由和审批流、真的 rollout 写入。只有最不可控的那个外部依赖（LLM API）被换成了可编程的录放机。

## 流程走读

### 走读一：crate 依赖分层

把 135 个 crate 压成五层，就是第 1 章那张分组表（见[第 1 章](ch01-overview.md)）的依赖方向版：

```
┌─ 外壳层 ─ cli / tui / exec / app-server ───────────────┐
│  产品形态；尽量只经 core-api 门面接触内核                │
├─ 内核层 ─ core（Session / turn / 编排）                 │
│  依赖半个 workspace；AGENTS.md 明令「别再喂它」          │
├─ 能力层 ─ tools / apply-patch / execpolicy / 沙箱族      │
│  一个 crate 一个职责，可独立于内核被测试                 │
├─ 协议层 ─ protocol / app-server-protocol / features     │
│  只放类型与序列化；依赖最少、最稳定                      │
└─ 地基层 ─ utils/* / async-utils / file-system           │
   人人可依赖；自己不依赖任何内部 crate                    │

依赖方向只允许向下。改动越靠下，级联重编译越广，
所以越靠下的层越被要求「少放逻辑、少变化」。
```

这条「依赖方向向下」的规则，`AGENTS.md` 用两段话把它制度化了。其一，针对内核层的「节食令」（`AGENTS.md:70-76` 附近）：

> Over time, the `codex-core` crate ... has become bloated because it is the largest crate ... To that end: **resist adding code to codex-core**!

这段英文原文值得玩味：它承认了一个组织行为学事实——**往最大的 crate 里加代码永远是阻力最小的路**，所以光靠自觉没用，必须把「先考虑别的 crate、或者新开一个 crate」写成明文规则，并且授权 reviewer 拒绝此类 PR（"do not hesitate to push back on PRs that would unnecessarily add code to codex-core"）。

其二，针对外壳层的「门面令」：`codex-core-api` crate（`core-api/src/lib.rs:1-30`）的存在本身就是落实——它不实现任何逻辑，只做一件事：从 core 和周边 crate 里挑出外壳真正需要的类型，`pub use` 出去：

```rust
// 来源：codex-rs/core-api/src/lib.rs:1-3, 25-30（节选）
//! Public facade for thread management APIs built on `codex-core`.

pub use codex_config::config_toml::ProjectConfig;
pub use codex_core::CodexThread;
pub use codex_core::CodexThreadSettingsOverrides;
// ...
```

tui、app-server 这些外壳面对的是一个被策展过的窄 API 面，而不是 core 的全部 `pub` 项。配合 `AGENTS.md` 的另一条规则「Prefer private modules and explicitly exported public crate API」，core 内部可以大刀阔斧重构，只要门面不变，外壳无感。这正是第 5 章讲的「协议解耦」（详见[第 5 章](ch05-protocol.md)）在 crate 粒度上的复刻：**同一招，既用在运行时消息上，也用在编译期依赖上**。

### 走读二：一条改动在双构建系统里的旅程

假设你改了 `Cargo.toml` 里一个依赖版本。这条改动要经历什么才能合入？

```
你修改 codex-rs/Cargo.toml / Cargo.lock
   │
   ▼
cargo 侧立刻生效（cargo check / just test 本地验证）
   │
   ▼
just bazel-lock-update
   │   └─ bazel mod deps --lockfile_mode=update   (justfile:143-145)
   ▼
MODULE.bazel.lock 刷新 ──► 与代码改动同 PR 提交
   │
   ▼
CI 双跑：
   ├─ cargo 侧：cargo nextest（just test，justfile:87-88）
   ├─ bazel 侧：bazel test //... （just bazel-test，justfile:156-157）
   └─ 锁文件检查：--lockfile_mode=error，漂移即红
        （scripts/check-module-bazel-lock.sh 全文就 9 行）
```

为什么要两套构建？看 `MODULE.bazel` 里 bazel 侧如何消化 Cargo 的依赖图（`MODULE.bazel:268-287`）：

```python
# 来源：MODULE.bazel:268-287
crate = use_extension("@rules_rs//rs:extensions.bzl", "crate")
crate.from_cargo(
    cargo_lock = "//codex-rs:Cargo.lock",     # ← 单一事实来源仍是 Cargo.lock
    cargo_toml = "//codex-rs:Cargo.toml",
    platform_triples = [
        "aarch64-unknown-linux-gnu",
        "aarch64-unknown-linux-musl",
        "aarch64-apple-darwin",
        # ... 共 11 个平台三元组，含 windows msvc/gnullvm 双 ABI
        "x86_64-pc-windows-gnullvm",
    ],
)
```

关键设计：**bazel 不维护自己的依赖清单，而是从 `Cargo.lock` 生成**（`crate.from_cargo`）。所以 cargo 是事实来源，bazel 是放大器——它把同一张依赖图放大到 11 个平台三元组上，配上 hermetic LLVM 工具链（`MODULE.bazel:84` 的 `register_toolchains`），换来 cargo 给不了的东西：跨平台交叉编译、远程缓存与远程执行、细粒度增量。代价是每次依赖变动都必须刷新 `MODULE.bazel.lock`，于是有了 `just bazel-lock-update` 和 CI 的漂移检查这对「生成-校验」闭环。

crate 级别的 parity 则由一个宏保证。每个 crate 目录下都有一个 `BUILD.bazel`，调用仓库根 `defs.bzl` 里定义的 `codex_rust_crate`（`defs.bzl:184-216`）：

```python
# 来源：defs.bzl:184-216（节选）
def codex_rust_crate(
        name,
        crate_name,
        compile_data = [],
        integration_test_timeout = None,
        test_data_extra = [],
        extra_binaries = [],
        run_tests_with_wine_exec = False):
    """Defines a Rust crate with library, binaries, and tests wired for Bazel + Cargo parity.
```

看 `core/BUILD.bazel` 的实际调用，你能读到 bazel 与 cargo 的「世界差异」具体在哪：

```python
# 来源：codex-rs/core/BUILD.bazel（节选）
codex_rust_crate(
    name = "core",
    compile_data = glob(include = ["**"], ...),  # ← bazel 的沙箱里文件要显式声明
    extra_binaries = [
        "//codex-rs/linux-sandbox:codex-linux-sandbox",  # ← 测试要 spawn 的第一方二进制
        "//codex-rs/cli:codex",
        # ...
    ],
    rustc_env = {
        # Keep manifest-root path lookups inside the Bazel execroot ...
        "CARGO_MANIFEST_DIR": "codex-rs/core",  # ← bazel 下没有真 cargo，手动补环境变量
    },
    test_data_extra = [
        "config.schema.json",
    ] + glob(["src/**/snapshots/**"]),  # ← insta 快照文件也要喂进 bazel 沙箱
    # ...
)
```

这解释了 `AGENTS.md` 里一条看似费解的规则：「Bazel does not automatically make source-tree files available to compile-time Rust file access. If you add `include_str!` ... update the crate's `BUILD.bazel`」。cargo 构建时工作目录就是源码树，`include_str!`、测试里读 fixture 都「自然能读到」；bazel 在隔离的 execroot 里构建，文件不进 `compile_data`/`test_data` 就等于不存在。双构建共存的最大隐性成本，就是这类「cargo 里免费、bazel 里要显式声明」的差异——`codex_rust_crate` 宏把它们收敛到了一处。

连 lint 都要双跑。`.bazelrc:110-120` 定义了 `build:clippy` 配置，把 `codex-rs/Cargo.toml` 里那 30 余条 deny 用 `--@rules_rust//rust/settings:clippy_flag=--deny=...` 逐条复刻，注释里写着：「Keep this deny-list in sync with `codex-rs/Cargo.toml` `[workspace.lints.clippy]`」——bazel 的 clippy aspect 读不了 Cargo 的 lint 声明，只能人工保持同步。这是双构建最真实的代价：**凡是 cargo 原生的配置，都要在 bazel 侧再表达一次**。

workspace 根部还有一个容易被扫过的段落值得停留——`[patch.crates-io]`（`codex-rs/Cargo.toml:587-592`）：

```toml
# 来源：codex-rs/Cargo.toml:587-592
[patch.crates-io]
crossterm = { git = "https://github.com/openai-oss-forks/crossterm", rev = "45fecb9508105988f42fe6ff0441783ed3717f92" }
tokio-tungstenite = { git = "https://github.com/openai-oss-forks/tokio-tungstenite", rev = "0e5b2d73aa18dd9f0a50ee9ff199d5aef7594186" }
tungstenite = { git = "https://github.com/openai-oss-forks/tungstenite-rs", rev = "4fffad30fe373adbdcffab9545e9e9bf4f2fc19f" }
```

三个底层依赖（终端控制、WebSocket）被整体换成了 OpenAI 自己维护的 fork 并钉死 rev。这是巨型项目的另一课：**对关键路径上的上游依赖，fork 是比等上游发版更可控的风险管理**。`[patch]` 的好处是全 workspace 透明生效，不用改任何成员 crate 的依赖声明——版本治理仍然单点。

### 走读三：「生成-校验闭环」是这个仓库的元模式

把上面锁文件的例子抽象一下，你会发现这个仓库反复使用同一个工程模式：**凡是「从源码派生的文件」，都配一对「重新生成命令 + CI 校验」**。除了 `MODULE.bazel.lock`，至少还有三处：

- `just write-config-schema`（`justfile:177-178`）：从 `ConfigToml` 类型重新生成 `codex-rs/core/config.schema.json`（第 3 章讲配置系统时见过它）。`AGENTS.md` 明确规定改了配置类型必须跑这条命令，否则 CI 红。
- `just write-app-server-schema`（`justfile:181-182`）：从 v2 协议类型重新生成 app-server 的 schema fixtures 与 TypeScript 绑定（第 15 章的主题）。
- `cargo insta accept`：快照文件从渲染结果派生，`.snap.new` 待审机制就是校验环节。

这个模式的收益是**派生物永远可重建、漂移永远可检测**：reviewer 不需要核对生成文件的内容是否与源码一致，CI 替你做。回看锁文件检查脚本 `scripts/check-module-bazel-lock.sh`，全文只有 9 行——`bazel mod deps --lockfile_mode=error`，漂移即退出非零。校验逻辑可以这么简单，恰恰因为生成逻辑被收敛成了一条 just 命令。对读者的启示很直接：你的 my-agent 里如果有「从代码生成的 openapi.json / 类型定义 / 文档」，照抄这个模式——一条 `pnpm gen` 生成，一条 CI diff 校验，杜绝手改派生物。

### 走读四：一个集成测试的生命周期

core 的集成测试聚合成**单一测试二进制**：`core/tests/all.rs` 只做一件事——`mod suite;`，而 `suite/mod.rs` 把 126 个测试模块全部收编。为什么合成一个二进制而不是 cargo 默认的「每个 `tests/*.rs` 一个二进制」？因为 126 个独立二进制意味着链接 126 次 core——磁盘和链接时间双双爆炸。单二进制 + nextest 并行执行，是这个体量下的必然选择。

`suite/mod.rs` 开头还有一段容易被忽略但极关键的机关（`core/tests/suite/mod.rs:1-25` 附近）：用 `#[ctor]` 在测试 main 之前执行，让测试二进制能根据 `argv[0]`/`argv[1]` 伪装成 `apply_patch`、`codex-linux-sandbox` 等辅助进程。第 10、11 章讲过内核会 spawn 这些第一方二进制（见[第 10 章](ch10-shell-applypatch.md)、[第 11 章](ch11-sandbox-approval.md)）；测试里 spawn 的就是测试二进制自己的分身，不需要额外构建产物。

一个典型测试长这样（`core/tests/suite/prompt_caching.rs:119-135`）：

```rust
// 来源：codex-rs/core/tests/suite/prompt_caching.rs:119-135（节选）
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn prompt_tools_are_consistent_across_requests() -> anyhow::Result<()> {
    skip_if_no_network!(Ok(())); // ← 无网环境（如沙箱 CI）整体跳过

    let server = start_mock_server().await; // ← wiremock 假模型服务
    let req1 = mount_sse_once(
        &server,
        sse(vec![ev_response_created("resp-1"), ev_completed("resp-1")]), // ← 预录第 1 次响应
    )
    .await;
    let req2 = mount_sse_once(
        &server,
        sse(vec![ev_response_created("resp-2"), ev_completed("resp-2")]), // ← 预录第 2 次响应
    )
    .await;

    let TestCodex { codex, config, thread_manager, .. } = test_codex()
        .with_pre_build_hook(write_global_instructions)
        .with_config(|config| {
            config.model = Some("gpt-5.2".to_string()); // ← 钉死模型，防止默认值漂移
            // ...
        })
        .build(&server) // ← 真内核，但所有模型流量指向假服务
        .await?;
    // ... 后续：提交回合、等事件、断言 req1/req2 收到的请求体
}
```

把这个模式画成数据流：

```
#[tokio::test] my_test()
   │
   ▼
start_mock_server()                wiremock 假 /responses 端点
   │
   ▼
mount_sse_once(server, sse([ev_*...]))   按顺序预录模型响应
   │
   ▼
test_codex().with_config(...).build(&server)
   │        真 Config + 真 Session + 假凭据 + 临时 HOME
   ▼
codex.submit(Op::TurnInput { ... })      走真实 Agent Loop（第 6/7 章）
   │
   ▼
wait_for_event(...) 等到回合结束
   │
   ▼
mock.single_request() ──► 断言内核发给「模型」的请求体 JSON
```

断言的对象是**内核发给模型的请求体**，这非常讲究：Agent 产品的核心质量属性——上下文里装了什么、工具清单长什么样、`prompt_cache_key` 对不对——全都凝结在这一坨 JSON 里（第 4、7、8 章的主线）。模型响应可以录放，请求体必须精确断言，这就是「假模型 + 真内核」模式的断言锚点。

这个模式还有个进阶变体：同一个 `TestCodexBuilder` 提供 `build_with_auto_env()`（`test_codex.rs:493`）、`build_with_remote_and_local_env()`（`test_codex.rs:510`）等方法，支持「app-server 与 exec-server 跑在不同操作系统」的远程矩阵测试——`AGENTS.md` 要求新测试默认用 `build_with_auto_env()`，正是为了让每个新测试自动获得跨 OS 覆盖。测试基建的一次投入，换来的是所有后续测试免费继承的能力。

### 走读五：UI 快照测试的审阅闭环

TUI 侧（第 14 章，[ch14-tui.md](ch14-tui.md)）的回归用 insta 快照。两种形态都在 `tui/src/chatwidget/tests/exec_flow.rs` 里。内联快照适合短输出（`exec_flow.rs:4-20`）：

```rust
// 来源：codex-rs/tui/src/chatwidget/tests/exec_flow.rs:4-20（节选）
#[tokio::test]
async fn compact_command_activity_groups_successes_and_preserves_full_transcript() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.on_task_started();

    let first = begin_exec(&mut chat, "call-first", "printf first");
    end_exec(&mut chat, first, "first\n", "", /*exit_code*/ 0);

    let second = begin_exec(&mut chat, "call-second", "printf second");
    insta::assert_snapshot!(active_blob(&chat), @r"• Ran 1 command · ctrl + t to view transcript
• Running printf second
");
    // ...
}
```

长输出用命名快照，存成独立 `.snap` 文件（`exec_flow.rs:472-475`）：

```rust
// 来源：codex-rs/tui/src/chatwidget/tests/exec_flow.rs:472-475
    let decision = cells.next().expect("expected decision cell in history");
    assert_chatwidget_snapshot!(
        "exec_approval_history_decision_approved_short",
```

对应的快照文件 `tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__exec_approval_history_decision_approved_short.snap` 内容是：

```text
---
source: tui/src/chatwidget/tests/exec_flow.rs
assertion_line: 47
expression: lines_to_single_string(&decision)
---
✔ You approved codex to run echo hello world this time
```

注意上面 Rust 代码里的 `/*model_override*/ None` 和 `/*exit_code*/ 0`——这正是 `argument_comment_lint` 的 `/*param*/` 注释约定在真实测试里的样子（下一节细讲）。

`AGENTS.md` 给快照测试规定的流程是一个「生成-审阅-接受」三段式（`AGENTS.md:180-202`）：

1. 跑 `just test -p codex-tui`，失败的断言会生成 `*.snap.new` 待审文件；
2. `cargo insta pending-snapshots -p codex-tui` 查看待审列表，`cargo insta show` 逐个人工读 diff；
3. 确认是预期变更后 `cargo insta accept -p codex-tui`，把 `.snap.new` 转正并随 PR 提交。

关键点在于：**快照文件是进 code review 的**。UI 改动在 PR 里呈现为 `.snap` 文件的文本 diff，reviewer 不需要跑起来就能看到「这个改动把审批弹窗长什么样改成了什么样」。全仓 741 个 `.snap` 文件（tui 一个 crate 占 687 个），就是这个流程积累下来的 UI 行为档案。`AGENTS.md` 甚至把它写成硬性要求：「any change that affects user-visible UI ... must include corresponding `insta` snapshot coverage」——**改 UI 不更新快照，约等于改逻辑不写测试**。

### 走读六：把风格规则做成编译器——argument-comment-lint

最后看一个「规则工具化」的极致样本。`AGENTS.md:15-24` 规定了参数注释约定：位置上传 `None`、`false`、数字字面量这类「读不出含义」的实参时，前面要写 `/*param_name*/` 注释。这种规则靠 reviewer 人眼盯，三天就会破窗。Codex 的做法是写了一个 Dylint 自定义 lint（`tools/argument-comment-lint/`），两个 lint 规则（`tools/argument-comment-lint/src/lib.rs:46, 86` 的两处 `declare_lint!`）：

- `argument_comment_mismatch`（默认 warn）：写了 `/*param*/` 注释但参数名和真实 callee 签名对不上——比如函数改名后注释没跟上；
- `uncommented_anonymous_literal_argument`（默认 allow，按需开启）：`None`/`true`/`false`/数字字面量裸传、没有 `/*param*/` 注释的，直接标出来。

`tools/argument-comment-lint/README.md` 给出的对照例子一目了然：

```rust
// 来源：tools/argument-comment-lint/README.md（示例代码）
// 通过：
create_openai_url(/*base_url*/ None, /*retry_count*/ 3);
// argument_comment_mismatch 报警（参数名写错了）：
create_openai_url(/*api_base*/ None, 3);
```

README 开头还有一句更重要的元规则：「Prefer self-documenting APIs over comment-heavy call sites when possible」——**注释是次优解，首选是把 API 改成不需要注释的形状**（枚举代替 bool、newtype 代替裸数字）。这与 `AGENTS.md` 的「Avoid bool or ambiguous `Option` parameters」互为表里：lint 管存量，API 设计规范管增量。

执行侧又绕回了双构建：`just argument-comment-lint`（`justfile:190-196`）不带参数时走 bazel（`bazel build --config=argument-comment-lint`），带参数时跑预编译二进制的 Python 包装器。连 lint 工具自己的 crates.io 依赖都在 `MODULE.bazel:288-304` 里单独 `crate.from_cargo` 了一份——为了让它能在 bazel 的 hermetic 环境里跑。

## 设计取舍

### crate 划分的真实标准：不是「职责单一」，而是「变化频率」

教科书会说按职责拆包。Codex 的实际划分透露的是另一条标准：**按「谁会因为什么理由变」来拆**。`protocol`（第 5 章）独立，因为它的变化理由是「协议演进」，而它的下游最多——把它做小做稳定，是在给全仓的重编译时间买保险。`config`（第 3 章）独立，因为它同时被内核、TUI、app-server 三方消费，任何一方都不该把另两方拖进自己的编译单元。`tools`（第 9 章）独立，因为工具清单增长最快，而 `ToolSpec` 的抽象让增长不碰内核。反例也有：`context-manager` 相关逻辑仍住在 `core` 里（第 1 章分组表注明了「相关逻辑在 core 内」），说明拆分是渐进的、按需的，不是一次到位的理想设计。

「resist adding to codex-core」的本质，是承认**依赖图会自然向最大的节点聚集**（加哪都不如加 core 顺手），所以要用明文规则制造反向压力。这条规则零工具成本，却是全仓最有杠杆的一条。

### 模块大小：数字管理的价值与局限

`AGENTS.md:49-56` 给了硬数字：模块目标 500 LoC 以下（不含测试），超过约 800 LoC 就「新功能去新模块」，并点名了 `tui/src/app.rs`、`chatwidget.rs` 这些「高触文件」。现实是 `tui/src/chatwidget.rs` 至今仍有 2064 行、`app.rs` 有 900 行——规则没能完全驯服存量，但你能在目录结构里看到正在进行的拆解（`tui/src/chatwidget/`、`tui/src/app/` 子目录就是「拆出去的新模块」）。这是一种诚实的工程态度：**规则约束增量的方向，不假装能一夜清偿存量的债**。配套的还有变更大小门禁（`AGENTS.md:125-130`）：非机械性改动不超过 800 行，复杂逻辑改动压到 500 行以下，超了就拆成可独立 review 的阶段。

### 双构建：为确定性付出的同步税

cargo 是开发回路（`just test`、`just fix` 秒级反馈），bazel 是交付回路（11 平台 hermetic 构建、远程缓存、release 二进制）。这套组合的代价本章已列全：锁文件要同步（`just bazel-lock-update`）、clippy deny 清单要在 `.bazelrc` 里复刻、`include_str!` 和测试数据要在 `BUILD.bazel` 里显式声明、连 `CARGO_MANIFEST_DIR` 都要手工注入。值得吗？对 Codex 值得——它要往 Linux/macOS/Windows（含两个 ABI）发单二进制，还要在 CI 里跑跨 OS 的远程执行矩阵（wine 跑 Windows 测试那种）。对单平台项目几乎肯定不值得。**双构建不是先进，是用复杂度换分发确定性的交易**，入场费是每条 cargo 原生配置都要付一次「同步税」。

### 对比 my-agent：TS 单包什么时候该拆

现在把镜头对准你的 my-agent。TypeScript 生态里对应物大致是：npm/pnpm workspaces ≈ cargo workspace，tsconfig project references ≈ crate 边界，Vitest 快照 ≈ insta，msw/nock ≈ wiremock。但有两个本质差异，决定了你不能照搬：

1. **Rust 的边界是编译器强制，TS 的边界是自觉**。`pub(crate)` 和 crate 私有模块让「越界 import」直接编译失败；TS 里深路径 import `../../agent/internal/foo` 畅通无阻，要靠 eslint-plugin-boundaries 这类 lint 兜底，强度差一个量级。所以 **TS 单包不用急着拆**——你先用 `src/` 下的目录边界 + 「只允许从 `index.ts` 导出」的约定就能拿到 80% 收益。Codex 的 `core-api` 门面模式在 TS 里的对应物，不过是一个 `internal.ts` 不导出、`api.ts` 只 re-export 的约定。

2. **拆包的真实触发信号是编译/测试时间和消费者数量，不是代码行数**。什么时候拆？对照 Codex 的 crate 边界，就是当你出现这些时刻：想把内核塞进第二个前端（IDE 扩展）——把 `protocol`/`types` 拆成无运行时依赖的纯类型包；发现改了工具实现，UI 的测试也要跟着全跑——把 tools 拆出去；CI 里 lint/typecheck 超过十分钟——project references 或拆包按需编译。在那之前，一个包 + 严格目录纪律 + msw 录放模型响应，就是 Codex 这套哲学的 TS 平价版。

真正不分语言、现在就能抄的有三条：**「假模型 + 真内核」的集成测试模式**（msw 录 SSE，断言发出去的请求体——你 Agent 的质量全在那个请求体里）；**「resist adding to core」式的明文反向压力**（在你的 `AGENTS.md`/`CONTRIBUTING.md` 里写下「加代码前先看能不能不进 `agent/` 目录」）；**把风格规则工具化**（能写成 ESLint 规则的，绝不留在 PR 评论里说）。

### 局限与演进

坦诚说几处不完美：core 175 行的 `Cargo.toml` 和 50+ 内部依赖说明「节食令」来得偏晚，内核仍是个引力中心；`.bazelrc` 里靠注释提醒人工同步 lint 清单，是双构建最脆弱的一环；快照测试对「时序型 UI」（动画、异步渲染中的中间帧）覆盖天然薄弱，快照冻结的是稳态。另外 `AGENTS.md` 本身是写给 AI 编码 Agent 看的规范——当贡献者里混着 Agent，把工程约定写成精确、无歧义、可检索的命令与数字（而不是「尽量保持模块小巧」），就从 nice-to-have 变成了必需品。这或许是这份文件给所有团队的最大启示。

## 动手实验

以下命令全部只读，在仓库根执行即可（不需要编译）。

统计 workspace 规模：

```shell
# 数成员 crate：预期输出 135
python3 -c "import re; t=open('codex-rs/Cargo.toml').read(); \
  print(len(re.findall(r'\"', re.search(r'members = \[(.*?)\]', t, re.S).group(1)))//2)"

# 对比协议层与内核层的依赖体量
# 预期：protocol/Cargo.toml 约 66 行，core/Cargo.toml 约 175 行
wc -l codex-rs/protocol/Cargo.toml codex-rs/core/Cargo.toml
```

感受「工程宪法」的存在感：

```shell
# 看 AGENTS.md 里的 crate 节食令与模块大小规则
rg -n "resist adding|500 LoC|800 LoC" AGENTS.md
# 预期输出约 4-6 行，含 "**resist adding code to codex-core**!"

# 数高触文件现在的行数，对照 500/800 规则
wc -l codex-rs/tui/src/chatwidget.rs codex-rs/tui/src/app.rs
# 预期：chatwidget.rs 约 2000+ 行（规则正在约束中的存量债）
```

探索测试基建：

```shell
# core 集成测试套件规模
ls codex-rs/core/tests/suite/*.rs | wc -l    # 预期 126

# 找一个「假模型 + 真内核」测试实例来读
rg -ln "test_codex\(\)" codex-rs/core/tests/suite/ | head -5

# 数快照文件
find codex-rs/tui -name "*.snap" | wc -l     # 预期约 687
find codex-rs -name "*.snap" | wc -l         # 预期约 741
```

追踪双构建的同步点：

```shell
# bazel 侧从 Cargo.lock 生成依赖图的入口
rg -n "from_cargo" MODULE.bazel

# 锁文件检查脚本全文（9 行）
cat scripts/check-module-bazel-lock.sh

# bazel 如何复刻 cargo 的 clippy deny 清单
rg -n "build:clippy" .bazelrc | head -8
```

## Rust 侧栏

本章涉及的语言与工具特性：

- **`pub use` re-export（门面模式）**：`core-api/src/lib.rs` 整文件都是 `pub use codex_core::...;`——把别的 crate 的条目再导出一次，不增加任何运行时代码，只改变「谁能从哪拿到它」。这是 Rust 里构造窄 API 面的标准手法。
- **`#![deny(...)]` / `#![allow(...)]` 属性**：`#![...]` 作用于整个 crate/模块。workspace 级 `unwrap_used = "deny"` 全局禁 `unwrap()`，测试文件顶部 `#![allow(clippy::unwrap_used)]` 局部豁免——lint 等级可以沿作用域层层覆盖。
- **`#[ctor]`**：来自 `ctor` crate 的属性，标记的静态初始化代码在 `main`（或测试 harness）之前运行。`suite/mod.rs` 用它抢在所有测试之前装好 argv 分发器。
- **Dylint**：用 Rust 编译器内部的 `rustc_lint` API 写自定义 lint 的框架。`dylint_library!()`（`lib.rs:35`）注册 lint 库，`declare_lint!` 声明规则，`LateLintPass`（`lib.rs:139`）在类型检查之后拿到完整类型信息做分析——所以它能知道 `None` 对应的形参真名。
- **insta 的内联快照**：`assert_snapshot!(expr, @"...")` 把期望值直接写进源码，`cargo insta` 能自动改写源码里的期望值——快照即代码，diff 即 review。
- **wiremock**：HTTP  mock 库，按「路径 + 方法 + 请求特征」挂载响应模板，并记录所有收到的请求供事后断言。`mount_sse_once` 就是「匹配一次 `/responses` 的 POST，返回这段 SSE，顺便记住请求体」的封装。

## 小结 + 思考题

本章回答了「100+ crate 如何不烂掉」：crate 按变化频率与下游广度划分，`protocol` 小而稳、`core` 大而受节食令约束、`core-api` 做窄门面；测试呈金字塔——单元测试贴实现、`test_codex` 集成测试用「假模型 + 真内核」覆盖行为、insta 快照把 UI 变成可 review 的文本 diff；cargo 与 bazel 双构建以 `Cargo.lock` 为单一事实来源，用 `just bazel-lock-update` 加 CI 漂移检查维持同步；`AGENTS.md` 把这一切写成精确到命令与数字的工程宪法，同时服务人类与 AI 贡献者。

思考题：

1. `AGENTS.md` 规定模块超 800 LoC 就该拆，但 `chatwidget.rs` 仍有 2000+ 行。如果你接手拆解，第一步会拆什么出去？去 `tui/src/chatwidget/` 目录里看看已经拆了哪些，验证你的判断是否同向。
2. 为什么说「假模型 + 真内核」模式里，断言 `mock.single_request()` 的请求体比断言最终输出文本更有价值？结合第 7 章的上下文组装逻辑想想。
3. 你的 my-agent 如果明天要支持「CLI + VS Code 扩展」双前端，按本章的分层标准，第一个该拆出去的包是什么？它应该对应 Codex 的哪个 crate？
4. `AGENTS.md` 里「Do not create small helper methods that are referenced only once」这类规则，你认为主要读者是人类还是 AI Agent？为什么这类规则对 AI 贡献者尤其重要？
