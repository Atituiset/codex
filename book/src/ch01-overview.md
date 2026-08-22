# 第 1 章 全景地图

## 本章导读

在读任何一行核心代码之前，你需要先回答一个问题：**Codex CLI 到底是什么形状的软件？**

很多教程把 Coding Agent 描述成「LLM + 工具调用循环」的三行伪代码。真实的 Codex 是一个多形态的桌面级系统：同一个 Agent 内核（`codex-rs/core`）被四种不同的外壳复用——

1. **TUI**：终端交互界面，你在终端里敲 `codex` 看到的就是它；
2. **exec**：无头模式 `codex exec "fix the failing test"`，用于脚本和 CI；
3. **app-server**：一个 JSON-RPC 长驻服务，VS Code / Cursor 等 IDE 扩展通过它与内核通信；
4. **MCP server**：`codex mcp-server` 把 Codex 自身暴露为一个 MCP（Model Context Protocol）工具服务器，可以被其它 Agent 调用。

这带来本书第一个重要的架构结论：**Agent 内核与 UI 严格解耦**。内核只通过事件流（`EventMsg`）对外广播状态、通过操作队列（`Op`）接收指令。TUI、exec、app-server 都只是这套消息协议的不同"渲染端"。这个设计直接决定了协议层 crate 的形态——第 5 章会展开。

另一个宏观事实是规模：`codex-rs/` 是一个 Cargo workspace，含 **100+ 个 crate**、约 **3272 个 Rust 文件**。初学者最容易在这里迷路，所以本章先给你一张地图，并告诉你哪些地方值得精读、哪些只需要知道存在。

## 源码地图

先看仓库顶层：

| 目录/文件 | 职责 | 点评 |
|-----------|------|------|
| `codex-cli/` | npm 包壳，安装后转调平台二进制 | 你 `npm i -g @openai/codex` 装的就是它 |
| `codex-rs/` | Rust workspace，本书全部内容 | 约 100+ crate |
| `docs/` | 用户文档（config.md 等） | 本书只引用不翻译 |
| `sdk/typescript/`, `sdk/python/` | 对 app-server 的官方 SDK 绑定 | 说明 app-server 是对外稳定面 |
| `justfile` | 开发任务入口（构建/测试/fmt） | 日常开发的起点 |

`codex-rs/` 内部 crate 很多，按功能分组记忆比逐个记有效得多。下面这张分组表就是全书的主线索——每一组对应后面的一到几章：

```
┌─ 入口与产品形态 ─────────────────────────────────────────────┐
│ cli          codex 主二进制，子命令分发            → Ch2     │
│ tui          终端 UI（ratatui）                    → Ch14    │
│ exec         无头模式                              → Ch16    │
│ app-server*  IDE 集成 JSON-RPC 服务族              → Ch15    │
│ mcp-server   Codex 作为 MCP server                 → Ch12    │
│ cloud-tasks* 云端任务客户端                        （略讲）  │
├─ 协议与配置 ─────────────────────────────────────────────────┤
│ protocol     Op/EventMsg/Item 核心数据模型         → Ch5     │
│ config       ConfigToml→Config 两级配置            → Ch3     │
│ features     功能开关                                        │
│ app-server-protocol  v2 JSON-RPC payload 定义      → Ch15    │
├─ 认证与模型接入 ─────────────────────────────────────────────┤
│ login        ChatGPT 登录 / API key                → Ch4     │
│ model-provider-info / model-provider  多提供方抽象  → Ch4     │
│ codex-api    Responses API 客户端传输层            → Ch4/7   │
│ auth         凭据存储刷新                          → Ch4     │
├─ Agent 内核 ─────────────────────────────────────────────────┤
│ core         Session/turn 循环/压缩/审批编排        → Ch6-11  │
│ tools        ToolSpec/注册/执行器                  → Ch9     │
│ apply-patch  diff 补丁解析与应用                   → Ch10    │
│ context-manager 相关逻辑在 core 内               → Ch8      │
├─ 安全与隔离 ─────────────────────────────────────────────────┤
│ linux-sandbox / windows-sandbox-rs               → Ch11     │
│ execpolicy   命令前缀策略引擎                      → Ch11    │
│ network-proxy 出网代理                            → Ch11     │
├─ 扩展生态 ───────────────────────────────────────────────────┤
│ rmcp-client  MCP 客户端                            → Ch12    │
│ codex-mcp    MCP 连接管理                          → Ch12    │
│ skills / plugins / connectors                     （略讲）   │
├─ 会话持久化 ─────────────────────────────────────────────────┤
│ rollout      JSONL 会话记录                        → Ch13    │
│ state / state-db（sqlite）                        → Ch13     │
│ thread-store 会话存储接口                          → Ch13    │
└──────────────────────────────────────────────────────────────┘
```

> 名字带 `*` 的是一族 crate（如 `app-server-*` 有 transport/protocol/daemon/client 五个），不是单个。

## 核心数据结构

全景层面你只需要记住三个「贯穿全书」的类型名，它们在后续章节反复出现：

```rust
// 来源：codex-rs/protocol/src/protocol.rs（结构示意，真实变体名见第 5 章）
// Op：外界 → 内核 的指令。UI 说"我想做什么"
pub enum Op {
    TurnInput { /* 用户输入一个回合 */ },
    Interrupt { /* 打断当前 turn */ },
    // ...
}

// 来源：codex-rs/protocol/src/protocol.rs（结构示意）
// EventMsg：内核 → 外界 的事件流。内核说"发生了什么"
pub enum EventMsg {
    TaskStarted(/* ... */),
    AgentMessageContentDelta(/* ... */), // 模型输出的增量文本
    ExecApprovalRequest(/* ... */), // 请求用户审批命令
    TaskComplete(/* ... */),
    // ...
}
```

以及承载它们的那条总线（细节在第 6 章）：

```rust
// 来源：codex-rs/core/src/codex_thread.rs:202 附近
pub struct CodexThread {
    pub(crate) session: Arc<Session>,
    pub(crate) io: SessionIo,          // submit(Op) 与 next_event() 都走这里
    pub(crate) session_source: SessionSource, // 来自 TUI? exec? IDE?
    session_configured: SessionConfiguredEvent,
    rollout_path: Option<PathBuf>,     // 本会话的 JSONL 记录文件
    // ...
}
```

`SessionSource` 这个字段值得停留一秒：同一个 `CodexThread` 知道自己被谁驱动。这正是"多形态外壳"在数据结构上的落点。

## 流程走读：一次对话的全景链路

把全书浓缩成一张图——这是你读完 Part I 和 Part II 之后应该能徒手画出的东西：

```
npm 壳 (codex-cli/)
  │  spawn 平台二进制
  ▼
cli/src/main.rs ──arg0 分发──► tui::run_main() 或 exec 或 app-server
  │                                            │
  │ (Ch2 启动链路)                              │ JSON-RPC over stdio
  ▼                                            ▼
加载配置 config::Config (Ch3) ◄────── app-server 同样构造内核
  │
  ▼
认证 AuthManager：ChatGPT token 或 API key (Ch4)
  │
  ▼
ThreadManager::new_conversation() ──► CodexThread + Session (Ch6)
  │
  ▼
用户输入 ──► Op::TurnInput ──► 任务队列 ──► RegularTask (Ch6)
  │
  ▼
session/turn.rs::run_turn()  ★ Agent Loop（Ch7 全书重心）
  │
  ├─ 组装上下文：history + environment_context + 注入片段 (Ch7/8)
  ├─ ModelClient 流式请求模型 (Ch4)
  │     │  SSE/WebSocket 增量返回
  │     ▼
  ├─ ResponseItem::FunctionCall / LocalShellCall ...（Ch5）
  │     │
  │     ▼
  ├─ 工具路由 tools/router.rs → orchestrator.rs (Ch9)
  │     ├─ 审批？──EventMsg::ExecApprovalRequest──► UI 弹窗 (Ch11)
  │     ├─ 选沙箱：seatbelt / landlock / windows (Ch11)
  │     └─ shell / apply_patch / MCP tool 执行 (Ch9/10/12)
  │     │
  │     ▼
  └─ FunctionCallOutput 追加进 history ──► 回到模型调用（循环）
        │ 直到模型不再调用工具 → turn 结束
        ▼
每一步同时写入 rollout JSONL (Ch13)；事件流实时推给 TUI/app-server (Ch14/15)
```

读源码时始终带着这条主线。任何让你困惑的代码，先问自己：**它在主线的哪一段？为谁服务？**

## 设计取舍

**为什么是 Rust，而不是像大多数 Agent 框架那样用 Python/TypeScript？**

三个现实原因：其一，沙箱需要精细的进程控制（namespace、Seatbelt profile 编译、文件描述符管理），Rust 对系统调用的一等支持让三平台隔离成为可能；其二，CLI 要单二进制分发，Rust 编译出无运行时依赖的可执行文件，npm 包只是个壳；其三，长驻的 TUI 渲染和并发工具执行对延迟敏感，没有 GC 停顿的语言更可控。代价是开发速度和生态——所以你能看到 OpenAI 在 MCP、SDK 层大量使用 TypeScript 补足。

**为什么内核与 UI 用 Op/Event 消息协议解耦，而不是函数调用？**

对比一下 my-agent 的常见写法：TS 里 Agent loop 通常是一个 async 函数直接 `await` 工具执行，UI 更新靠回调注入。这种写法在单一前端时没问题，但 Codex 需要同一内核支撑 TUI、IDE、CI 三种消费者，且 IDE 消费者可能跨进程。消息协议让「内核状态」可以无损地序列化为事件流（rollout 持久化用的也是同构数据），UI 只是事件的投影。副作用是类型爆炸——`EventMsg` 变体极多，第 5 章会讨论这个代价是否值得。

## 动手实验

先把开发环境跑起来（假设已装 Rust 工具链）：

```shell
# 在仓库根目录；所有 just 任务的工作目录都在 codex-rs/
just codex --help          # 编译并以 debug 模式启动 codex
cargo run --bin codex -- exec "list files in this directory"   # 无头模式跑一次
```

观察二进制的多形态入口：

```shell
cargo run --bin codex -- --help
# 注意子命令：exec / mcp-server / app-server / apply / login ...
# 这份子命令列表就是 Ch2 要走的分发表
```

找到主线代码的位置（后续章节会反复用到）：

```shell
cd codex-rs
rg -n "pub async fn run_turn" core/src/session/turn.rs
rg -n "pub struct ModelClient" core/src/client.rs
rg -n "enum EventMsg" protocol/src/protocol.rs
```

想看运行时日志的话：

```shell
RUST_LOG=codex_core=debug cargo run --bin codex -- exec "say hi" 2>&1 | head -50
# tracing 输出会显示 Session 创建、模型请求、工具执行的时间线
```

## Rust 侧栏

本章出现的语言特性，只做最小必要说明：

- **workspace 与 crate**：Cargo workspace 允许多个 crate 共享一个 `Cargo.lock` 与 `target/`。`codex-rs/Cargo.toml` 的 `[workspace] members` 列出了全部成员。crate 之间以 `codex-xxx` 包名互相依赖。
- **`Arc<T>`**：原子引用计数指针，多个任务共享同一份数据（如 `Arc<Session>`）。配合 `tokio` 异步运行时跨 `.await` 点传递。
- **`pub(crate)`**：可见性修饰，仅在本 crate 内可见——`core` 大量用它把实现细节挡在 crate 边界内，只暴露窄 API。
- **enum 即代数数据类型**：`Op`/`EventMsg` 都是「标签联合」，`match` 强制处理所有变体，这是协议演进的编译期保障。

## 小结 + 思考题

本章建立了三件事：Codex 的四产品形态共享一个内核；100+ crate 按「入口/协议/认证/内核/安全/扩展/持久化」七组分块；一条从 npm 壳到 Agent Loop 再回到屏幕的主线。

思考题：

1. `codex mcp-server` 和 `codex app-server` 都是对外提供服务，为什么需要两个？它们的消费方分别是谁？（提示：Ch12 与 Ch15）
2. 如果让你把 my-agent 从单进程回调风格改成 Op/Event 消息风格，第一步会改什么？哪些代码会自然消失？
3. 在 `codex-rs/Cargo.toml` 里找出 `core` 依赖了哪些 crate，猜猜哪些会在 Ch7 的 run_turn 里出现。
