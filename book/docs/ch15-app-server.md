# 第 15 章 app-server 协议族：IDE 集成的 JSON-RPC 层

## 本章导读

到目前为止，本书的读者视角一直是「坐在终端前的人」：TUI 渲染事件，你在键盘上敲审批
决定。但 Codex 的另一个重要消费方根本不是人直接操作的终端——是 **VS Code 扩展**这类
外部进程。IDE 插件是独立进程，和 Codex 内核之间隔着进程边界，甚至可能隔着操作系统
（远程开发场景）。它需要的不是「渲染 ANSI 转义序列」，而是一套**结构化、版本化、可
长期兼容的编程接口**：开一条主线（thread）、发一个回合（turn）、订阅事件流、回答
审批弹窗。

`codex app-server` 就是这个接口：一个长驻的 JSON-RPC 服务，把[第 6 章](ch06-core-session.md)
的内核能力（`CodexThread`、`Op`、`EventMsg`）映射成一套对外承诺稳定的资源 API——
thread / turn / item 三件套。`codex-rs/app-server/README.md` 开篇就写明了它的定位：
"`codex app-server` is the interface Codex uses to power rich interfaces such as the
Codex VS Code extension."

如果你的 my-agent 想做一个 IDE 插件，你会立刻撞到四个真问题：

1. **协议怎么设计？** 事件推送用什么通道？审批这种「需要用户回答」的交互是通知还
   是请求？
2. **类型怎么同步？** 你的 Agent 内核是 TS，插件 UI 也是 TS，字段改一次两边都得
   跟着改——靠什么保证不漂移？
3. **新旧版本怎么共存？** 插件发版节奏和 Agent 二进制发版节奏不同步，老插件连新
   内核、新插件连老内核，谁先坏？
4. **API 凭什么稳定？** 内核内部的类型天天在改，直接把它序列化暴露出去等于没有
   兼容承诺。

本章逐层回答这四个问题。一个会让你印象深刻的事实提前说破：**TUI 自己也是
app-server 的客户端**——本基线上 TUI 不再直接持有内核句柄，而是通过一个进程内嵌的
app-server（`InProcessAppServerClient`，tui/src/lib.rs:566-590）建会话。换句话说，
这套 JSON-RPC API 完整到足以支撑官方自己的旗舰前端，IDE 扩展和 TUI 消费的是同一份
协议。这是衡量「API 完备性」最硬的证据。

与[第 12 章](ch12-mcp.md)的分工：第 12 章讲了 Codex 作为 MCP 客户端接入外部工具，以及
已弃用的 `codex mcp-server` 反向形态；本章讲的是取代后者成为对外稳定面的 app-server
体系——为什么是 JSON-RPC 资源模型而不是 MCP 的 tools/call 语义，[第 12 章](ch12-mcp.md)
4.6 节已经埋下伏笔，本章把这条线索收拢。

## 源码地图

app-server 是一族 crate（这正是[第 1 章](ch01-overview.md)说的 `app-server*`），职责切分
非常干净：

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-rs/app-server-protocol/src/rpc.rs` | JSON-RPC 信封类型 | 只有 88 行；刻意省略 `"jsonrpc":"2.0"` 字段 |
| `codex-rs/app-server-protocol/src/protocol/common.rs` | 方法注册表（宏驱动） | `ClientRequest`/`ServerRequest`/`ServerNotification` 三个枚举都在这里生成，4462 行 |
| `codex-rs/app-server-protocol/src/protocol/v1.rs` | 旧版 payload | 243 行，只剩 `initialize` 与少量 DEPRECATED 方法 |
| `codex-rs/app-server-protocol/src/protocol/v2/*.rs` | 现行 payload 定义 | 约 1.7 万行，按资源分文件（thread.rs/turn.rs/item.rs/...） |
| `codex-rs/app-server-protocol/src/protocol/event_mapping.rs` | `EventMsg` → v2 通知的无状态投影 | 一对一映射的翻译车间 |
| `codex-rs/app-server-protocol/src/export.rs`、`precomputed_exports.rs` | TS / JSON Schema 导出 | 产物内嵌为 `.zst` 预计算包 |
| `codex-rs/app-server/src/lib.rs` | 服务端主循环、连接管理 | 1428 行 |
| `codex-rs/app-server/src/message_processor.rs` | 请求分发中枢 | 初始化门闸、experimental 门闸、串行化队列都在这 |
| `codex-rs/app-server/src/request_processors/*.rs` | 按资源分组的 handler | `thread_processor.rs` 近 6000 行，是最大的一个 |
| `codex-rs/app-server/src/bespoke_event_handling.rs` | `EventMsg` → 通知/审批请求 | 4137 行，本章 4.3/4.5 节的主场 |
| `codex-rs/app-server/src/request_processors/thread_lifecycle.rs` | 每条主线的监听任务 | `next_event()` 循环在这里 |
| `codex-rs/app-server/src/transport.rs` | 出站路由、慢消费者处置 | 广播只发已初始化的连接 |
| `codex-rs/app-server/src/in_process.rs` | 进程内嵌模式 | 用有界 channel 替换 socket/stdio，语义不变 |
| `codex-rs/app-server-transport/src/transport/stdio.rs` | stdio JSONL 传输 | 113 行，一行一条消息 |
| `codex-rs/app-server-client/src/lib.rs` | 官方 Rust 客户端封装 | `InProcessAppServerClient` 与 `Remote` 双形态 |
| `codex-rs/app-server/README.md` | 官方 API 文档（2600 行） | 对外承诺的完整文本，先于代码读它 |
| `sdk/typescript/` | 官方 TS SDK | 本基线走 `codex exec --experimental-json`，见设计取舍 |

另外两处「客户端侧」的证据文件：`codex-rs/tui/src/lib.rs:566-590`（TUI 启动内嵌
app-server）与 `codex-rs/exec/src/lib.rs:539-551, 808`（exec 同样用它）——四种产品
形态中的两种，如今都建立在 app-server 协议之上。

## 核心数据结构

### 信封：刻意「不标准」的 JSON-RPC

先看最底层的信封（rpc.rs:34-88）：

```rust
// 来源：codex-rs/app-server-protocol/src/rpc.rs:34-88（删节）
/// Refers to any valid JSON-RPC object that can be decoded off the wire, or encoded to be sent.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum JSONRPCMessage {
    Request(JSONRPCRequest),
    Notification(JSONRPCNotification),
    Response(JSONRPCResponse),
    Error(JSONRPCError),
}

/// A request that expects a response.
pub struct JSONRPCRequest {
    pub id: RequestId,
    pub method: String,
    pub params: Option<serde_json::Value>,
    /// Optional W3C Trace Context for distributed tracing.
    pub trace: Option<W3cTraceContext>, // ← 可选的分布式追踪上下文
}
```

文件头注释说得直白（rpc.rs:1-2）："We do not do true JSON-RPC 2.0, as we neither send
nor expect the `"jsonrpc": "2.0"` field."——线上消息没有 `"jsonrpc":"2.0"` 头。协议借用
JSON-RPC 2.0 的**语义**（request 有 id 等响应、notification 没有 id），但不背它的
字面包袱，每行省几个字节，解析也更松。`#[serde(untagged)]` 让四种信封靠字段形状
自动区分：有 `id` + `method` 是请求，只有 `method` 是通知，有 `result`/`error` 是
响应/错误。`RequestId` 是字符串或整数的 untagged 联合（rpc.rs:13-21），兼容不同
客户端的编号习惯。

### 方法注册表：一个宏生成三个枚举

所有 wire 方法集中登记在 common.rs 的 `client_request_definitions!` 宏里
（common.rs:203-232）。这不是装饰——宏从同一份声明同时生成 `ClientRequest`（客户端
→服务端请求）、`ClientResponse`（服务端→客户端的带类型响应）、`method_name()`、
序列化作用域判定和 experimental 门闸检查：

```rust
// 来源：codex-rs/app-server-protocol/src/protocol/common.rs:203-232（删节）
macro_rules! client_request_definitions {
    (
        $(
            $(#[experimental($reason:expr)])?
            $variant:ident => $wire:literal {         // ← Rust 变体名 => "wire 方法名"
                params: $params:ty,
                $(inspect_params: $inspect_params:tt,)?
                serialization: $serialization:ident ..., // ← 并发串行化作用域
                response: $response:ty,
            }
        ),* $(,)?
    ) => {
        #[serde(tag = "method", rename_all = "camelCase")]
        pub enum ClientRequest {
            $(
                #[serde(rename = $wire)]
                #[ts(rename = $wire)]
                $variant {
                    #[serde(rename = "id")]
                    request_id: RequestId,
                    params: $params,
                },
            )*
        }
        // ...
    }
}
```

登记表本身长这样（common.rs:487-510，删节）：

```rust
// 来源：codex-rs/app-server-protocol/src/protocol/common.rs:487-517
client_request_definitions! {
    Initialize => "initialize" {
        params: v1::InitializeParams,              // ← 握手类型仍归 v1，见设计取舍
        serialization: None,
        response: v1::InitializeResponse,
    },

    /// NEW APIs
    ThreadStart => "thread/start" {
        params: v2::ThreadStartParams,
        inspect_params: true,                      // ← 方法稳定，但个别字段是实验性的
        serialization: None,
        response: v2::ThreadStartResponse,
    },
    ThreadResume => "thread/resume" { /* ... */ },
    ThreadFork => "thread/fork" { /* ... */ },
    // ...
}
```

命名约定一目了然：`<resource>/<method>`，resource 用单数（`thread/start`、
`turn/steer`、`item/started`）。同一个文件里还有 `server_request_definitions!`
（common.rs:1399-1464，服务端→客户端的反向请求）和 `server_notification_definitions!`
（common.rs:1818 起，服务端→客户端的通知）——三个方向三张注册表，加起来 240+ 个
wire 方法（155 个客户端请求 + 12 个服务端请求 + 77 个通知）。AGENTS.md 的 app-server 开发规范（仓库根 AGENTS.md「App-server API Development
Best Practices」一节）把这些约定写成了硬规则：payload 一律 `*Params`/`*Response`/
`*Notification` 命名、wire 字段 camelCase、新列表方法默认游标分页
（`cursor`/`limit`/`next_cursor`）、所有新 API 只进 v2。

### 资源模型：Thread / Turn / ThreadItem

对外的三个一等资源在 README（Core Primitives 一节，README.md:66-74）里定义得很
克制：Thread 是一次对话，包含多个 Turn；Turn 是一轮交互，包含多个 Item；Item 是
持久化的最小单元（用户消息、agent 回复、命令执行、文件改动……）。它们与内核类型的
对应关系是：Thread ↔ `CodexThread`（[第 6 章](ch06-core-session.md)），Turn ↔ 内核的回合
（turn id 就是 submission id），Item ↔ protocol crate 的 `TurnItem`。

v2 的 `Thread`（thread_data.rs:196-269，删节）：

```rust
// 来源：codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs:196-269
pub struct Thread {
    /// Identifier for this thread. Codex-generated thread IDs are UUIDv7.
    pub id: String,                        // ← 对外是裸 String，UUID 解析留在服务端内部
    /// Session id shared by threads that belong to the same session tree.
    pub session_id: String,                // ← 同一会话树（fork 出来的）共享
    pub forked_from_id: Option<String>,    // ← fork 来源
    pub preview: String,                   // ← 通常是首条用户消息，列表页直接渲染
    pub ephemeral: bool,                   // ← 纯内存会话不落盘
    pub model_provider: String,
    pub created_at: i64,                   // ← Unix 秒；时间戳一律整型 + *_at 命名
    pub updated_at: i64,
    pub status: ThreadStatus,              // ← 运行时状态（活跃/空闲等）
    pub path: Option<PathBuf>,             // ← rollout 文件路径；ephemeral 时为 null
    pub cwd: AbsolutePathBuf,
    pub source: SessionSource,             // ← 谁建的：CLI / VSCode / exec ...
    pub turns: Vec<Turn>,                  // ← 只在 thread/resume、thread/read 等响应里填充
    // ...
}
```

每个字段都能对上 README 文档里的一句承诺。注意两个约定：ID 一律裸 `String`（
`turn.id` 同理，thread_data.rs:350-370），时间戳一律 `i64` Unix 秒——这就是
AGENTS.md 规范里「plain `String` IDs at the API boundary」「timestamps are integer
Unix seconds named `*_at`」的落地。

`ThreadItem` 是对外的条目类型（item.rs:227-340，删节）：

```rust
// 来源：codex-rs/app-server-protocol/src/protocol/v2/item.rs:227-340
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type")]
pub enum ThreadItem {
    UserMessage { id: String, client_id: Option<String>, content: Vec<UserInput> },
    AgentMessage { id: String, text: String, /* phase、memory_citation、delivery */ },
    Reasoning { id: String, summary: Vec<String>, content: Vec<String> },
    CommandExecution {
        id: String,
        command: String,
        cwd: LegacyAppPathString,
        status: CommandExecutionStatus,      // ← inProgress / completed / failed / declined
        command_actions: Vec<CommandAction>, // ← 命令的友好解析，给 UI 摘要用
        aggregated_output: Option<String>,
        exit_code: Option<i32>,
        // ...
    },
    FileChange { id: String, changes: Vec<FileUpdateChange>, status: PatchApplyStatus },
    McpToolCall { id: String, server: String, tool: String, /* status、result、error */ },
    // ... Plan、WebSearch、ImageGeneration、ContextCompaction 等十余种
}
```

这里有一个命名细节值得记住：protocol crate 内部的条目类型叫 `TurnItem`（见
[第 5 章](ch05-protocol.md)），`ThreadItem` 是 app-server-protocol v2 的**对外命名**。两者
内容同构，转换逻辑在 `app-server-protocol/src/protocol/thread_history.rs` 与
`item_builders.rs`——同一份会话数据，对内一张脸、对外一张脸，中间有显式的翻译层。
这正是「内部面可以随便改、对外面必须稳」的结构保障。

### 握手与能力协商：`initialize`

每条连接的第一个请求必须是 `initialize`，它的类型还留在 v1 里
（v1.rs:27-66）：

```rust
// 来源：codex-rs/app-server-protocol/src/protocol/v1.rs:27-66（删节）
pub struct InitializeParams {
    pub client_info: ClientInfo,                    // ← name/title/version，身份上报
    pub capabilities: Option<InitializeCapabilities>,
}

pub struct InitializeCapabilities {
    /// Opt into receiving experimental API methods and fields.
    pub experimental_api: bool,                     // ← 实验性 API 总开关
    /// Opt into `attestation/generate` requests ...
    pub request_attestation: bool,
    /// Exact notification method names that should be suppressed for this
    /// connection (for example `thread/started`).
    pub opt_out_notification_methods: Option<Vec<String>>, // ← 按方法名精确退订通知
    /// MCP extension settings declared by the app-server client.
    pub extensions: Option<HashMap<String, serde_json::Value>>,
}
```

三个能力位各自对应一类真实需求：`experimental_api` 是「稳定面 / 全量面」的分水岭
（4.1 节和设计取舍展开）；`opt_out_notification_methods` 让带宽敏感的客户端按方法名
精确退订（比如不要 `item/agentMessage/delta` 的逐 token 推送）；`extensions` 声明
MCP 扩展能力（[第 12 章](ch12-mcp.md)的 elicitation 表单经这里协商）。服务端在握手完成前
拒绝一切其它请求——「Not initialized」错误（message_processor.rs:887-889），重复
`initialize` 得到「Already initialized」（README.md:87）。

### `TurnStartParams`：一次回合的全部旋钮

`turn/start` 的 params（v2/turn.rs:66-161，删节）是「对外 API 能控制什么」的
最佳样本：

```rust
// 来源：codex-rs/app-server-protocol/src/protocol/v2/turn.rs:66-161
pub struct TurnStartParams {
    pub thread_id: String,
    pub client_user_message_id: Option<String>,     // ← 客户端侧去重/关联用
    pub input: Vec<UserInput>,                      // ← 文本/图片/音频的判别联合
    /// Override the approval policy for this turn and subsequent turns.
    #[experimental(nested)]
    pub approval_policy: Option<AskForApproval>,    // ← 嵌套类型里可能有实验变体
    /// Override the sandbox policy for this turn and subsequent turns.
    pub sandbox_policy: Option<SandboxPolicy>,
    /// Override the model for this turn and subsequent turns.
    pub model: Option<String>,
    pub effort: Option<ReasoningEffort>,
    /// Optional JSON Schema used to constrain the final assistant message ...
    pub output_schema: Option<JsonValue>,           // ← 结构化输出，只管本回合
    #[experimental("turn/start.collaborationMode")]
    pub collaboration_mode: Option<CollaborationMode>,
    // ...
}
```

两条设计语义藏在注释里：其一，大多数 override（model、cwd、approval policy……）
是「本回合及后续回合」生效——改的是主线状态；唯独 `output_schema` 只作用于当前
回合（README.md:900）。其二，`#[ts(optional = nullable)]` 出现在每个可选字段上——
AGENTS.md 规定可选字段必须显式 nullable，禁止用 `skip_serializing_if` 把「省略」和
「null」合并，让 TS 客户端能区分「没传」和「传了空」。

## 流程走读

### 4.1 总览：一条消息的旅程

先把全章的主线图立起来——以 stdio 传输为例：

```
IDE 扩展（VS Code 插件进程）                       codex app-server 进程
        │  spawn("codex app-server --stdio")             │
        └───────────────────────────────────────────────►│
        │  initialize 请求（JSONL 一行）                  │
        ├───────────────────────────────────────────────►│ stdio.rs 读行
        │                                                │   │
        │◄─── InitializeResponse（userAgent/codexHome）──┤   ▼
        │  initialized 通知                              │ MessageProcessor
        ├───────────────────────────────────────────────►│ 初始化门闸放行
        │  thread/start ────────────────────────────────►│ thread_processor
        │◄── thread/started 通知 + 响应（Thread 对象）────┤  └► 内核建会话(Ch6)
        │  turn/start ──────────────────────────────────►│ turn_processor
        │◄── turn/started、item/started、delta... ───────┤  └► 内核回合(Ch7)
        │                                                │ 监听任务：next_event()
        │◄── item/commandExecution/requestApproval ──────┤  └► 事件翻译层
        │  （服务端反向请求，等待审批回答）                  │
        │  { decision: "accept" } ──────────────────────►│
        │◄── serverRequest/resolved、item/completed ─────┤
        │◄── turn/completed ─────────────────────────────┤
```

图中三处「└►」的具体落点：`thread/start` 落到
`ThreadManager::start_thread`（thread_processor.rs:1386-1411），`turn/start` 落到
`CodexThread::start_or_steer_turn`（turn_processor.rs:553-568），事件翻译层就是
`apply_bespoke_event_handling`（bespoke_event_handling.rs:143 起）。

三个结构要点先在图上认出来：**双向都是 JSON-RPC**（客户端能调服务端，服务端也能
反向调客户端）；**每条主线挂一个监听任务**把内核事件流翻译成通知；**审批走的是
反向请求而不是通知**——因为它需要回答。

### 4.2 传输与握手

stdio 传输极简：一行一条 JSON 消息（newline-delimited JSON），
`start_stdio_connection`（app-server-transport/src/transport/stdio.rs:24-80）起一个
读循环，`BufReader::lines()` 逐行读，每行经 `forward_incoming_message` 送进
`TransportEvent` 通道；写出走另一条有界 `mpsc` 队列。除了 stdio，README（Protocol
一节，README.md:24-29）还列出 websocket（`--listen ws://IP:PORT`，标注
experimental/unsupported）与 unix socket（`unix://`，经 HTTP Upgrade 握手走
websocket 帧）；CLI 侧入口是 `codex app-server`（cli/src/main.rs:547-596），
`--stdio` 等价于 `--listen stdio://`。

连接建立后的第一件事是握手门闸。`handle_client_request`
（message_processor.rs:835-878）把 `Initialize` 单独摘出来处理，其余一切请求进
`dispatch_initialized_client_request`（message_processor.rs:880-948），前两道检查
是：

```rust
// 来源：codex-rs/app-server/src/message_processor.rs:886-895
        if !session.initialized() {
            return Err(invalid_request("Not initialized"));
        }

        if let Some(reason) = codex_request.experimental_reason()
            && !session.experimental_api_enabled()
        {
            return Err(invalid_request(experimental_required_message(reason)));
        }
```

第一道是握手门闸，第二道是 **experimental 门闸**：每个 `ClientRequest` 变体在编译
期就带着自己的实验标记（common.rs:81-94 的 `experimental_reason_expr!` 宏——整个
方法标了 `#[experimental("...")]` 就直接返回那个 reason；标了 `inspect_params: true`
的（如 `thread/start`）则递归检查 params 里被标 `#[experimental]` 的字段）。没
opt-in 的客户端碰实验面，得到形如
`thread/start.mockExperimentalField requires experimentalApi capability` 的错误
（README.md:2537-2547）。这套机制让「稳定 API」和「实验 API」共用同一套代码路径，
只在边界上分流——schema 导出时同理：`codex app-server generate-ts` 默认只导出稳定
面，`--experimental` 才带上实验面（precomputed_exports.rs:62-92）。

### 4.3 thread/start：从 RPC 到内核会话

`thread/start` 的 handler 在 thread_processor.rs。主流程
`thread_start_task`（thread_processor.rs:1241-1440）做的事按顺序是：加载配置
（应用客户端给的 config override）；一个值得注意的副作用——当 cwd 落在
workspace-write 或更高权限下且项目未信任时，把该项目标记为 trusted 并写回
`config.toml`（thread_processor.rs:1283-1334，README.md:164 也记录了这一行为）；
然后调内核建会话：

```rust
// 来源：codex-rs/app-server/src/request_processors/thread_processor.rs:1386-1428（删节）
        let new_thread = listener_task_context
            .thread_manager
            .start_thread(StartThreadOptions {
                initial_history: match session_start_source
                    .unwrap_or(codex_app_server_protocol::ThreadStartSource::Startup)
                {
                    ThreadStartSource::Startup => InitialHistory::New,
                    ThreadStartSource::Clear => InitialHistory::Cleared,
                },
                history_mode,
                thread_source,
                dynamic_tools,
                environments: Some(environments),
                client_mcp_extensions,
                ..start_options
            })
            .await;
        let NewThread { thread_id, thread, session_configured, .. } = match new_thread {
            // ← 失败映射成 invalid_request / method_not_found / internal_error
        };
```

`ThreadManager::start_thread` 就是[第 6 章](ch06-core-session.md)讲的内核建会话入口；到
这里 RPC 层的工作已经做完，剩下的是「把内核包装成资源」：把 `CodexThread` 投影成
对外的 `Thread` 结构、注册监听任务（下一节）、回响应并广播 `thread/started` 通知
（thread_processor.rs:1522-1540 附近）。`thread/resume` 与 `thread/fork` 同构，
区别只在 `InitialHistory`（[第 13 章](ch13-persistence.md)讲过 rollout 恢复）。

`ThreadStartParams`（v2/thread.rs:59-156）里有个字段呼应前章：`history_mode`。
trait 的默认历史模式是 `Legacy`，但 TUI 建会话时显式传
`ThreadHistoryMode::Paginated`（tui/src/app_server_session.rs:1717：
`history_mode: (!config.ephemeral).then_some(ThreadHistoryMode::Paginated)`），并且
带版本回退——老服务端不认识 `historyMode` 时降级重发不带它的请求
（tui/src/app_server_session.rs:203-233）。这是「客户端版本 ≠ 服务端版本」现实下
的兼容写法，值得做 IDE 插件的读者抄。

### 4.4 事件翻译层：从 EventMsg 到 ServerNotification

每条加载的主线都有一个监听任务（thread_lifecycle.rs:282-411），核心是一个
`tokio::select!` 循环，监听三类信号：取消令牌、监听命令、以及
`conversation.next_event()` 的内核事件。拿到事件后先更新主线本地状态，再交给翻译
层：

```rust
// 来源：codex-rs/app-server/src/request_processors/thread_lifecycle.rs:307-360（删节）
                event = conversation.next_event() => {
                    let event = match event { /* 出错则退出循环 */ };
                    // ← 先 track_current_turn_event 同步本地状态（如 raw events 开关）
                    let subscribed_connection_ids = thread_state_manager
                        .subscribed_connection_ids(conversation_id)
                        .await;                 // ← 只发给订阅了这条主线的连接
                    let thread_outgoing = ThreadScopedOutgoingMessageSender::new(
                        outgoing_for_task.clone(),
                        subscribed_connection_ids,
                        conversation_id,
                    );
                    apply_bespoke_event_handling(
                        event.clone(),
                        conversation_id,
                        conversation.clone(),
                        // ...
                        thread_outgoing,
                        // ...
                    )
                    .await;
                }
```

翻译层是 `apply_bespoke_event_handling`
（bespoke_event_handling.rs:143 起）——一个 4000 多行的大 `match`，把每个
`EventMsg` 变体翻译成对外的通知或反向请求。[第 12 章](ch12-mcp.md)已经见过其中一个
翻译：内核的 `McpStartupUpdate` 变成 `mcpServer/startupStatus/updated` 通知
（bespoke_event_handling.rs:206-233）：

```rust
// 来源：codex-rs/app-server/src/bespoke_event_handling.rs:206-233
        EventMsg::McpStartupUpdate(update) => {
            let (status, error, failure_reason) = match update.status {
                codex_protocol::protocol::McpStartupStatus::Starting => {
                    (McpServerStartupState::Starting, None, None)
                }
                codex_protocol::protocol::McpStartupStatus::Failed { error, reason } => (
                    McpServerStartupState::Failed,
                    Some(error),
                    reason.map(Into::into),
                ),
                // ... Ready / Cancelled
            };
            let notification = McpServerStatusUpdatedNotification {
                thread_id: Some(conversation_id.to_string()),
                name: update.server,
                status,
                error,
                failure_reason,
            };
            outgoing
                .send_server_notification(ServerNotification::McpServerStatusUpdated(notification))
                .await;
        }
```

翻译分两类。**无状态的一对一投影**被抽到了协议 crate 里：
`item_event_to_server_notification`（app-server-protocol/src/protocol/event_mapping.rs:
30-77）直接吃一个 `EventMsg` 吐出 `ServerNotification`——协议 crate 同时依赖内核
类型与 v2 类型，天然是翻译层的家。**有状态的翻译**留在 app-server：比如
`TurnStarted` 要先从 `thread_state` 取活跃回合快照、通知 watch manager、再发
`turn/started`（bespoke_event_handling.rs:159-188）。流式 delta 则是两类的接合处：
`bespoke_event_handling.rs:907-918` 把 `AgentMessageContentDelta`（[第 5 章](ch05-protocol.md)
的流式文本事件）等 delta 类事件委托给 `item_event_to_server_notification`，投影成
`item/agentMessage/delta` 通知（event_mapping.rs:362-371）——拼接完整文本是客户端
的事，服务端只负责按序透传。对外承诺的生命周期序列是 README（Turn events，
README.md:1614-1628）钉死的：`turn/started` → 每个条目的
`item/started` → 若干 delta → `item/completed` → `turn/completed`。

**订阅模型**值得单独说一句：通知不是全局广播。`thread/start`（fork 同理，
README.md:166）会把发起连接自动订阅到这条主线（README.md:164），后续事件只推给订阅者；
`thread/unsubscribe` 退订（README.md:541-547 列出 `unsubscribed`/`notSubscribed`/
`notLoaded` 三种结果）。这让一个 app-server 进程可以同时服务多个窗口/多个插件，
各自只看自己的主线。

### 4.5 turn/start、steer、interrupt：回合三件套

`turn/start` 的 handler（turn_processor.rs:478-614）把 v2 输入映射成内核输入后，
调 `CodexThread` 上的组合入口：

```rust
// 来源：codex-rs/app-server/src/request_processors/turn_processor.rs:516-582（删节）
        // Map v2 input items to core input items.
        let mapped_items: Vec<CoreInputItem> = params
            .input
            .into_iter()
            .map(V2UserInput::into_core)
            .collect();
        // ...
        let submission = thread
            .start_or_steer_turn(
                TurnInputRequest::new(TurnInput::UserInput {
                    content: mapped_items,
                    client_id: client_user_message_id,
                })
                .with_thread_settings(thread_settings)      // ← 模型/审批/沙箱等覆盖
                .on_start(TurnStartOptions {
                    final_output_json_schema: params.output_schema,
                    ..Default::default()
                })
                .with_additional_context(additional_context)
                .with_trace(self.request_trace_context(&request_id).await),
            )
            .await?;
        let (turn_id, started) = match submission {
            TurnInputSubmission::Started { turn_id } => (turn_id, true),
            TurnInputSubmission::Steered { turn_id } => (turn_id, false), // ← 空转 steer
            TurnInputSubmission::NotSubmitted { reason } => { /* 报错 */ }
        };
```

注意 `start_or_steer_turn` 的语义：如果主线空闲就起新回合，如果已有活跃回合就
自动并入（steer）。响应立即返回 `{ turn: { id, status: "inProgress", items: [] } }`
——真正的进度全靠通知流推送，响应只承诺「受理了」。

`turn/steer`（turn_processor.rs:918-1060）是显式的 steer：要求客户端传
`expectedTurnId` 作前置条件，服务端调 `thread.steer_turn(..., expected_turn_id)`，
内核裁决后返回丰富的失败原因（turn_processor.rs:970-1040）：没有活跃回合
（`NoActiveTurn`）、turn id 不匹配（`ExpectedTurnMismatch`，防竞态——你 steer 的
那个回合可能已经结束了）、当前回合不可 steer（review/compact 回合，
`ActiveTurnNotSteerable`）、输出 schema 不一致等。这些失败原因同时映射成
`CodexErrorInfo` 变体，出现在 README 的错误清单里（README.md:1694-1708）。
`turn/interrupt` 则朴素得多——翻译成一个 `Op::Interrupt` 提交给内核
（turn_processor.rs:1514），打断逻辑全在[第 7 章](ch07-agent-loop.md)的 Agent Loop 里。

审批与沙箱拦截依然在内核 handler 内部的 `ToolOrchestrator`（见
[第 9 章](ch09-tools.md)与[第 11 章](ch11-sandbox-approval.md)）；app-server 不复制这套裁决，它只
负责把「内核要审批」翻译成「客户端弹窗」。

### 4.6 反向通道：审批为什么是请求而不是通知

这是全协议里最反直觉也最值得学的设计：**服务端会向客户端发 JSON-RPC 请求**。
内核产生 `EventMsg::ExecApprovalRequest` 时，翻译层（bespoke_event_handling.rs:
605-736）组装 `CommandExecutionRequestApprovalParams` 后：

```rust
// 来源：codex-rs/app-server/src/bespoke_event_handling.rs:716-735（删节）
            let (pending_request_id, rx) = outgoing
                .send_request(ServerRequestPayload::CommandExecutionRequestApproval(
                    params,
                ))
                .await;
            tokio::spawn(async move {
                on_command_execution_request_approval_response(
                    event_turn_id,
                    conversation_id,
                    approval_id,
                    call_id,
                    completion_item,
                    pending_request_id,
                    rx,                      // ← oneshot：等客户端的 decision
                    conversation,
                    outgoing,
                    thread_state.clone(),
                    permission_guard,
                )
                .await;
            });
```

`send_request` 给客户端发一条带 id 的 JSON-RPC 请求，返回一个 oneshot 接收端；
spawn 出的任务 `await` 客户端的响应，把 `decision` 送回内核（审批流继续）。
消息顺序由 README（Approvals，README.md:1712-1739）规定：`item/started`（先展示
待执行的命令）→ `item/commandExecution/requestApproval`（反向请求，客户端弹窗）→
客户端回 `{ "decision": "accept" }` 等 → `serverRequest/resolved`（清理确认）→
`item/completed`（终态）。文件改动审批同构，走 `item/fileChange/requestApproval`。

反向请求清单在 `server_request_definitions!`（common.rs:1663-1734）里，除了两种
审批，还有 `item/tool/requestUserInput`（request_user_input 工具）、
`mcpServer/elicitation/request`（[第 12 章](ch12-mcp.md)的 MCP elicitation）、
`item/permissions/requestApproval`（request_permissions 工具）、`item/tool/call`
（客户端侧动态工具——内核可以让**客户端**执行一个工具，这是 IDE 集成的杀手锏：
让模型调用只有 IDE 才知道的能力）。为什么必须是请求？因为「等用户回答」是一个有
状态的挂起操作：内核回合在等答案，连接断开要能兜底（`connection_cleanup.rs` 会把
挂起的请求失败回去，审批不会永远挂着），回合结束/打断时也要批量清理
（`abort_pending_server_requests`，bespoke_event_handling.rs:161、191）。通知没有
id、没有响应语义，装不下这些。

### 4.7 出站路由：每条连接有自己的规则

出站侧的最后一公里在 `route_outgoing_envelope`（transport.rs:200-239）。两条规则
值得记住：

```rust
// 来源：codex-rs/app-server/src/transport.rs:156-173, 214-226（删节）
    if connection_state.can_disconnect() {
        match writer.try_send(queued_message) {
            Ok(()) => false,
            Err(mpsc::error::TrySendError::Full(_)) => {
                warn!("disconnecting slow connection after outbound queue filled: ...");
                disconnect_connection(connections, connection_id)  // ← 慢消费者直接断开
            }
            // ...
        }
    }

// 广播只发给已完成初始化的连接：
        OutgoingEnvelope::Broadcast { message } => {
            let target_connections: Vec<ConnectionId> = connections
                .iter()
                .filter_map(|(connection_id, connection_state)| {
                    if connection_state.initialized.load(Ordering::Acquire)
                        && !should_skip_notification_for_connection(connection_state, &message)
                    // ← should_skip_* 应用 optOutNotificationMethods 退订表
```

其一，广播只投给**已初始化**的连接，并应用每连接的退订表；其二，出站队列是
有界的，慢消费者堆积到上限会被**断开**而不是让服务端内存膨胀——长驻服务面对
不可信客户端的标准自保。另外出站前还有一次按连接的字段过滤：
`filter_outgoing_message_for_connection`（transport.rs:176-198）会给没开
`experimentalApi` 的连接剥掉审批请求里的实验字段（
`strip_experimental_fields`）——实验门闸不仅在入站拦，也在出站滤。

### 4.8 进程内模式：TUI 自己就是客户端

最后一块拼图解释了本章导读的悬念。`app-server/src/in_process.rs` 的模块注释
（in_process.rs:1-39）把设计意图写得很清楚：用**有界内存 channel 替换
socket/stdio 传输**，但「transport-local but not protocol-free」——请求仍是带类型的
`ClientRequest`，响应仍走与 stdio/websocket 完全相同的 JSON-RPC 结果信封，「避免
为进程内造第二套执行契约」。`app-server-client` crate 再把它包成异步门面
`InProcessAppServerClient`（app-server-client/src/lib.rs:289-427）：一个 worker 任务
桥接调用方的 `mpsc` 通道与内嵌的 `MessageProcessor`，请求等待被分离到独立任务上，
避免「前台请求排在未读通知后面」的死锁（lib.rs:333-336 的注释记录了这段历史）。
`AppServerClient` 枚举（app-server-client/src/lib.rs:312-320）有 `InProcess` 与
`Remote` 两个变体，同一份代码既能连内嵌服务也能连远程 daemon。

TUI 的启动代码（tui/src/lib.rs:566-590）：

```rust
// 来源：codex-rs/tui/src/lib.rs:566-590（删节）
    let client = start_client(InProcessClientStartArgs {
        arg0_paths,
        config: Arc::new(config),
        // ...
        session_source: serde_json::from_value(serde_json::json!("cli"))
            .unwrap_or_else(|err| panic!("cli session source should deserialize: {err}")),
        client_name: "codex-tui".to_string(),
        client_version: env!("CARGO_PKG_VERSION").to_string(),
        experimental_api: true,                  // ← TUI 开了实验面
        // ...
    })
    .await
    .wrap_err("failed to start embedded app server")?;
```

exec 无头模式同样走这条路（exec/src/lib.rs:539-551 构造参数、808 行启动，
`session_source` 传 `SessionSource::Exec`）。这意味着：**你在 TUI 里看到的一切
——流式文本、审批弹窗、MCP 启动状态——都是 app-server 协议的消费结果**。
[第 14 章](ch14-tui.md)讲的 TUI 事件循环消费的就是 `ServerNotification` 流。对外的 API 面因此有一个罕见
的性质：它被自家两个旗舰前端 7×24 小时地 dogfood 着，残缺会立刻暴露。

## 设计取舍

**为什么 v1 和 v2 并存？** 历史原因直白：v1 是早期的「直接把内核类型序列化出去」
的协议（方法名是 `newConversation`、`sendUserTurn` 这种动词式命名，payload 大量复用
内核类型），v2 重构成了资源模型（thread/turn/item + `<resource>/<method>`）。但旧
客户端不能瞬间消失，所以本基线上 v1 的残余被明确圈在 common.rs:1351 的
`/// DEPRECATED APIs below` 注释之下——只剩 `getConversationSummary`、
`gitDiffToRemote`、`getAuthStatus`、`fuzzyFileSearch` 四个请求和两个旧审批反向请求
（common.rs:1721-1734 的 `ApplyPatchApproval`/`ExecCommandApproval`，注释写明仅供
legacy 回合使用）。`initialize` 是特例：它的 payload 类型仍归 v1（common.rs:488-492），
因为握手必须先于任何版本协商发生。AGENTS.md 把演进规则钉死：「All active API
development should happen in app-server v2. Do not add new API surface area to v1.」
v1 只退不进，直到彻底移除。

**为什么 app-server-protocol 是对外稳定面，而 protocol crate 是内部面？** 两个
crate 的变更纪律完全不同。[第 5 章](ch05-protocol.md)的 `protocol` crate 服务内核与 UI 解耦，
`EventMsg` 变体随内核需要随时增改——它是「内部面」，没有对外兼容承诺。
`app-server-protocol` 则是**承诺**：它的每个类型同时带 `JsonSchema` 与 `TS`（ts-rs）
派生，`codex app-server generate-ts` / `generate-json-schema` 能导出与当前二进制
严格一致的客户端绑定（README.md:57-64）；schema 以预计算的 `.zst` 包内嵌
（precomputed_exports.rs:14-18），由 `just write-app-server-schema` 重新生成，CI 有
fixture 测试守着（`schema_fixtures_tests.rs`）。实验性能力不进稳定承诺——用
`#[experimental]` 标注 + 握手 opt-in + 出站字段过滤三层隔离。这套机器的成本不低
（每个新字段都要想命名、nullable、gating），它买的是：IDE 扩展可以按自己的节奏
发版，不怕内核下周重构。

**对比 my-agent：手写 JSONL 协议与宏驱动注册表的差距。** TS 侧做插件协议，典型
写法是父子进程间传 JSONL，消息类型用字符串字面量拼一个 union：

```typescript
// my-agent 式插件协议：能跑，但没有任何机器校验
type HostMessage =
  | { type: "userInput"; text: string }
  | { type: "approvalResponse"; callId: string; decision: "accept" | "decline" };
type AgentMessage =
  | { type: "textDelta"; delta: string }
  | { type: "approvalRequest"; callId: string; command: string }
  // ... 新增一种消息 = 改两个 union + 两边 switch，靠自觉对齐
```

对照本章，Codex 多出来的机器买了五样东西：

| my-agent 的坑 | Codex 的对应物 |
|----------------|----------------|
| 消息类型两边手写，靠 review 对齐 | 宏注册表单一来源，`generate-ts` 导出机器可校验的 TS 类型 |
| 加了字段老客户端直接崩或静默丢 | experimental opt-in + 出站剥字段；稳定面承诺不破坏 |
| 「等用户回答」用回调 Map 挂起，进程死了一直挂 | 反向 JSON-RPC 请求 + oneshot + 连接断开时统一失败回去 |
| 事件全员广播，多个窗口互相串台 | 按主线订阅（`thread/start` 自动订阅、`unsubscribe` 退订） |
| 协议文档与实现漂移 | README 即对外契约，schema fixture 测试兜底 |

如果你的插件和 Agent 永远同仓库同版本发布，手写 union 没什么错——Codex 这套只有
在「客户端与服务端独立发版」时才收回成本。但有两件便宜事建议直接抄：**把「需要
回答」的交互建模成带 id 的请求而非通知**（这决定了断连、超时、批量清理都能统一
处理），以及**方法命名用 `<resource>/<method>` 加单数资源名**（REST 直觉搬到 RPC
上，方法数涨到 240+ 时仍然可导航）。

**为什么审批走反向请求而不是「客户端轮询」？** 除了 4.6 节讲的状态语义，还有延迟：
审批在 Agent Loop 的关键路径上（[第 9 章](ch09-tools.md)），轮询会把「用户已点同意」的生效
时间拖到下一个轮询周期。反向请求让延迟等于一次进程内/管道写。

**局限与演进方向。** 坦诚说几点：其一，websocket 传输仍标注 experimental/
unsupported（README.md:27, 37），远程场景的生产路径还在打磨（app-server-daemon
与 remoteControl/* 方法族是这条线的雏形）。其二，方法面已经很宽——240+ 个方法
里 realtime、queue、project、marketplace 等族都在实验状态，「稳定面」实际比方法
总数小得多，接入时以 `generate-ts` 默认输出为准。其三，本基线的官方 TS SDK
（sdk/typescript/）并不直连 app-server——`CodexExec` spawn 的是
`codex exec --experimental-json`（sdk/typescript/src/exec.ts:90），消费的是
[第 16 章](ch16-exec.md)讲的 exec 点分事件流（`thread.started`/`turn.completed`）。这提醒
我们：app-server 是「富交互前端」的面（IDE、TUI），一次性脚本场景 exec 事件流就够
了，两个面并存是有意的分工而不是疏漏。

## 动手实验

以下命令在仓库根目录执行；需要 `codex` 二进制的地方可用
`cargo run --bin codex -- ...` 代替（首次编译较慢）。

**1. 导出协议 schema。**（预期输出：`/tmp/codex-schema/` 下生成一批 `.ts` 文件，
含 `ClientRequest.ts`、`ServerNotification.ts`、`v2/` 目录等；追加 `--experimental`
再导一次，`diff -r` 两个目录能看到实验面大出一圈）：

```shell
cargo run --bin codex -- app-server generate-ts --out /tmp/codex-schema
ls /tmp/codex-schema | head
cargo run --bin codex -- app-server generate-json-schema --out /tmp/codex-jsonschema
```

**2. 手工驱动一次 stdio 会话。** 直接往 app-server 的 stdin 喂 JSONL
（注意：`initialized` 是**通知**，没有 `id` 字段）：

```shell
printf '%s\n' \
  '{"id":0,"method":"initialize","params":{"clientInfo":{"name":"book-demo","title":"Book Demo","version":"0.0.1"}}}' \
  '{"method":"initialized"}' \
  '{"id":1,"method":"thread/start","params":{"ephemeral":true}}' \
  | cargo run --bin codex -- app-server
```

预期输出形态：先回 `{"id":0,"result":{"userAgent":...,"codexHome":...}}`；随后出现
一条 `thread/started` 通知和对 `id:1` 的响应，`result.thread` 里有 UUID 形式的
`id`、`"ephemeral":true`、`"path":null`。`ephemeral:true` 保证不写 rollout 文件。
此时再喂一行 `turn/start` 就会真实发起模型请求（需要可用凭据与网络），观察
`turn/started` → `item/*` → `turn/completed` 的完整通知序列；在离线环境下则会
看到 `turn/completed` 带 `status:"failed"` 与 `codexErrorInfo`。

**3. 验证门闸。** 把实验 2 的 `initialize` 行删掉、直接发 `thread/start`：
预期收到 `{"id":1,"error":{...,"message":"Not initialized"}}`。再试试不开
`experimentalApi` 却传实验字段（比如 `"historyMode":"paginated"`）：预期收到
`... requires experimentalApi capability` 的 invalid request 错误。

**4. 读注册表与翻译层。**（预期输出：各命中若干行，可直接跳转读上下文）：

```shell
cd codex-rs
rg -n 'TurnStart => "turn/start"' app-server-protocol/src/protocol/common.rs
rg -n 'EventMsg::McpStartupUpdate' app-server/src/bespoke_event_handling.rs
rg -n 'fn item_event_to_server_notification' app-server-protocol/src/protocol/event_mapping.rs
rg -n 'InProcessClientStartArgs' tui/src/lib.rs exec/src/lib.rs
```

**5. 看官方文档即契约。** `codex-rs/app-server/README.md` 有 2600 行，先读
「Lifecycle Overview」（README.md:76-83）与「Approvals」（README.md:1712-1739）两节，
再回头对照本章 4.5/4.6 节的代码，体会「文档先行」的协议开发方式。

## Rust 侧栏

- **`macro_rules!` 声明式宏当「注册表」用。** `client_request_definitions!`
  （common.rs:203-232）按模式匹配每一条声明，把同一份信息展开成枚举变体、
  `method_name()` 匹配臂、serde rename、`TryFrom` 转换等多处代码。新增一个方法
  只改一处，编译器保证各处一致——这就是「单一来源」在 Rust 里的典型实现。
- **serde 的内部标签枚举。** `#[serde(tag = "method")]` 让 `ClientRequest` 序列化
  成 `{"method":"turn/start","id":..,"params":..}`——判别字段内联在对象里而不是
  包一层。`#[serde(untagged)]`（如 `JSONRPCMessage`）则相反：不带标签，靠字段
  形状逐个变体试匹配。
- **派生宏双导出。** 每个 v2 类型同时 derive `JsonSchema`（schemars）与 `TS`
  （ts-rs），`#[ts(export_to = "v2/")]` 指定 TS 产物落点，`#[ts(optional = nullable)]`
  控制 TS 侧的可选形态。一次 Rust 定义，同时产出 JSON Schema 与 TypeScript 类型。
- **`tokio::select!` + `biased`。** 监听循环（thread_lifecycle.rs:283-404）用
  `select!` 同时等取消、命令、内核事件三个源；`biased` 让分支按书写顺序优先
  轮询——取消永远最先被看到，避免退出前多处理一条事件。
- **oneshot 与「请求-响应」桥接。** 反向审批用 `tokio::sync::oneshot`：发请求时
  拿到接收端 `rx`，spawn 任务去 `await` 它。oneshot 是「恰好一次」的单值通道，
  比 mpsc 更精确地表达「一个请求只会有一个响应」。

## 小结 + 思考题

本章走完了一条完整链路：IDE 扩展经 stdio JSONL 连上 `codex app-server`，
`initialize` 握手完成能力协商；`thread/start` 经 `ThreadManager::start_thread` 建
内核会话并把连接订阅到主线；每条主线的监听任务把 `EventMsg` 流翻译成
`ServerNotification`（`McpStartupUpdate` → `mcpServer/startupStatus/updated` 是
样本）；`turn/start`/`turn/steer`/`turn/interrupt` 映射到内核回合原语；审批以
**反向 JSON-RPC 请求**回到客户端，回答经 oneshot 送回内核。v1 被圈在 DEPRECATED
区只退不进，v2 靠宏注册表 + ts-rs/schemars 双导出 + experimental 门闸维持「对外
稳定、对内可演进」。TUI 与 exec 都以进程内模式消费同一协议——这是它完备性的最硬
证据。对 my-agent 的 IDE 插件之路，可直接抄的是：`<resource>/<method>` 命名、
「需要回答的交互一律建模为请求」、schema 单一来源导出、按主线订阅而非全员广播。

思考题：

1. `turn/start` 的响应立即返回 `status:"inProgress"` 的空回合，进度全靠通知流。
   如果改成「响应等回合结束才返回」，会丢掉哪些能力？（提示：steer、打断、
   审批分别会发生什么？）
2. 反向审批请求在客户端进程崩溃时会怎样？到 `connection_cleanup.rs` 与
   `bespoke_event_handling.rs:161, 191` 找证据，说明为什么审批不会永远挂起。
3. `turn/steer` 要求 `expectedTurnId` 前置条件（turn_processor.rs:962-988）。
   如果省掉这个字段，客户端会撞上什么竞态？为什么这个错误应该返回给调用方而
   不是静默并入新回合？
4. experimental 门闸在入站（message_processor.rs:891-895）与出站
   （transport.rs:176-198）各有一层。只保留入站那一层，会漏掉什么场景？
5. 官方 TS SDK 选择走 `codex exec --experimental-json` 而非 app-server
   （sdk/typescript/src/exec.ts:90）。如果让你给 my-agent 设计对外 SDK，什么
   场景该选「一次性事件流」，什么场景必须上「长驻 JSON-RPC 会话」？
