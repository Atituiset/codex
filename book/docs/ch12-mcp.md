# 第 12 章 MCP 与扩展生态

## 本章导读

到目前为止，本书讲的所有工具——`exec_command`、`apply_patch`、`view_image`——都是 Codex
内核自带的。但一个 Coding Agent 的能力边界不可能只靠内置工具：查 Linear 工单、读内部
文档库、调公司里的部署系统，这些能力长在别人的进程里。MCP（Model Context Protocol）
就是 Codex 接入这些外部能力的标准协议：外部进程（或远程 HTTP 服务）声明「我有哪些
工具、哪些资源」，Codex 作为 **MCP 客户端**连上去，把那些工具混入模型的工具清单。

如果你的 my-agent 接过 MCP，大概率是用官方 TS SDK 写三行：`new Client()`、
`connect()`、`listTools()`，把结果拼进 `tools` 数组。这在 demo 里成立，放到生产环境
会立刻撞上四个真问题：

1. **多个服务器各暴露一个 `search` 工具，名字撞了怎么办？** 模型看到的名字必须唯一
   且合法，但调协议时又得用对方的原始名——两套命名必须同时维护。
2. **某个服务器启动慢、中途挂掉，回合（turn）要不要等它、为它失败？** 答案是「看
   这个服务器对用户重不重要」，这需要一套分级降级策略。
3. **需要 OAuth 登录的远程服务器怎么处理？** token 存哪、过期怎么刷新、登录怎么
   触发，都是连接层的事。
4. **工具清单会变。** 服务器中途上下线、用户改了配置、插件被选中——[第 9 章](ch09-tools.md)
   说过工具清单随每个 `StepContext` 重建，本章讲这些变化在连接层怎么传导。

本章还会讲反方向的形态：Codex 自己也实现了 MCP 服务端（`mcp-server` crate），把
「跑一个 Codex 会话」暴露成 MCP 工具供其它 Agent 调用。但请注意一个重要事实：**在
本基线上 `codex mcp-server` 子命令已标记弃用**（`cli/src/main.rs:1184-1186` 启动时
打印 deprecation warning），对外服务形态正在向 app-server 体系收敛。我们会如实讲
这条演进线索及其原因。

与[第 9 章](ch09-tools.md)的分工：第 9 章从工具框架角度讲清了 `McpHandler` 如何作为一个普通
`ToolExecutor` 注册进 registry；本章只讲连接层——连接怎么建、怎么复用、怎么降级，
以及工具名怎么从 MCP 服务器的原始命名翻译进模型可见的命名空间。

## 源码地图

MCP 客户端能力横跨三个 crate：`codex-rmcp-client`（对官方 `rmcp` SDK 的封装，管单个
连接）、`codex-mcp`（连接集合、工具聚合、命名规范化）、`codex-core` 内的会话侧集成
（把连接生命周期挂到 Session 上）。

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-rs/config/src/mcp_types.rs` | `McpServerConfig` / `McpServerTransportConfig` 配置类型 | 两种 transport：stdio 与 streamable HTTP |
| `codex-rs/rmcp-client/src/rmcp_client.rs` | `RmcpClient`：单连接状态机 | 基于官方 `rmcp` SDK，1606 行 |
| `codex-rs/rmcp-client/src/perform_oauth_login.rs` | OAuth 登录流程 | 本地回调服务器 + 浏览器授权 |
| `codex-rs/rmcp-client/src/oauth.rs` | token 存储与刷新 | keyring / 文件两种后端 |
| `codex-rs/codex-mcp/src/connection_manager.rs` | `McpConnectionSet`：多服务器连接集合 | 本章核心，启动/复用/降级都在这里 |
| `codex-rs/codex-mcp/src/connection_manager/tool_catalog.rs` | 跨服务器聚合并捕获工具目录 | `OPTIONAL_MCP_STARTUP_GRACE` 只有 1 秒 |
| `codex-rs/codex-mcp/src/tools.rs` | `ToolInfo` 与工具名规范化 | 双轨命名的翻译车间 |
| `codex-rs/codex-mcp/src/binding.rs` | `McpBinding` / `PreparedMcpCall` 不可变快照 | 「一次采样请求看到的世界」的固化 |
| `codex-rs/codex-mcp/src/runtime.rs` | `McpRuntime`：会话级 MCP 状态发布 | `ArcSwap` 原子替换 |
| `codex-rs/codex-mcp/src/mcp/mod.rs` | `McpConfig`、`effective_mcp_servers` | 配置 → 生效服务器集的闸门 |
| `codex-rs/core/src/session/mcp_runtime.rs` | Session 侧安装与发布 | `install_initial_mcp_runtime` |
| `codex-rs/core/src/session/mcp.rs` | 脏标记刷新、elicitation 应答 | `refresh_mcp_if_dirty` 是中枢 |
| `codex-rs/core/src/session/mcp_prewarm.rs` | 后台 pre-warm worker | 75 行，小而关键 |
| `codex-rs/core/src/mcp_tool_call.rs` | `handle_mcp_tool_call`：MCP 工具调用主流程 | 审批与事件在这里织入 |
| `codex-rs/core/src/mcp_tool_exposure.rs` | MCP 工具进 registry 的适配层 | Ch9 已讲骨架，本章引用衔接 |
| `codex-rs/mcp-server/` | Codex 作为 MCP server（已弃用） | 原型形态，见 4.6 节 |
| `codex-rs/cli/src/mcp_cmd.rs` | `codex mcp list/add/login/...` 子命令 | 用户侧管理入口 |

## 核心数据结构

### 配置侧：`McpServerConfig` 与两种 transport

用户在 `config.toml` 里写的 `[mcp_servers.<name>]` 段，反序列化后是这个类型
（mcp_types.rs:181-252，删节）：

```rust
// 来源：codex-rs/config/src/mcp_types.rs:181-252
pub struct McpServerConfig {
    #[serde(flatten)]
    pub transport: McpServerTransportConfig, // ← 内联展开：stdio 或 streamable HTTP
    pub auth: McpServerAuth,                 // ← OAuth（默认）还是 ChatGPT 会话
    pub environment_id: String,              // ← 在哪个执行环境里启动（本地/远程）
    pub enabled: bool,
    pub required: bool,                      // ← true 时 codex exec 启动失败即报错
    pub supports_parallel_tool_calls: bool,  // ← 声明该服务器工具可并行
    pub startup_timeout_sec: Option<Duration>, // ← 启动+首次列工具的超时
    pub tool_timeout_sec: Option<Duration>,    // ← 每次工具调用的默认超时
    pub enabled_tools: Option<Vec<String>>,  // ← 工具白名单
    pub disabled_tools: Option<Vec<String>>, // ← 工具黑名单（在白名单之后再扣）
    pub scopes: Option<Vec<String>>,         // ← OAuth 登录请求的 scope
    pub oauth: Option<McpServerOAuthConfig>,
    // ...
}
```

transport 枚举是 `#[serde(untagged)]` 的——TOML 里没有 `type = "stdio"` 这种标签
字段，靠字段形状区分（mcp_types.rs:512-546）：

```rust
// 来源：codex-rs/config/src/mcp_types.rs:512-546
#[serde(untagged, deny_unknown_fields, rename_all = "snake_case")]
pub enum McpServerTransportConfig {
    Stdio {
        command: String,                   // ← 本地拉起子进程，stdin/stdout 走 JSON-RPC
        args: Vec<String>,
        env: Option<HashMap<String, String>>,
        // ...
    },
    StreamableHttp {
        url: String,                       // ← 远程服务器
        bearer_token_env_var: Option<String>, // ← 静态 token：只配环境变量名，不落盘
        http_headers: Option<HashMap<String, String>>,
        env_http_headers: Option<HashMap<String, String>>,
        http_headers_helper: Option<String>,  // ← 本地命令动态产 header
    },
}
```

注意 `bearer_token_env_var` 的设计：配置里只存**环境变量的名字**，secret 本身永远
不进 config.toml。这是远程服务器最简单的一种认证，OAuth 是另一条路（4.5 节）。

### `ToolInfo`：原始身份与模型可见名的双轨

这是理解全章最重要的一张结构（tools.rs:24-61）：

```rust
// 来源：codex-rs/codex-mcp/src/tools.rs:24-55
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInfo {
    /// Raw MCP server name used for routing the tool call.
    pub server_name: String,               // ← 原始服务器名，路由与协议调用用它
    pub supports_parallel_tool_calls: bool,
    pub server_origin: Option<String>,     // ← 来源（config/plugin/...），遥测用
    /// Model-visible tool name used in Responses API tool declarations.
    pub callable_name: String,             // ← 模型可见名（已 sanitize）
    pub callable_namespace: String,        // ← 模型可见命名空间
    pub namespace_description: Option<String>,
    /// Raw MCP tool definition; `tool.name` is sent back to the MCP server.
    pub tool: Tool,                        // ← 原始工具定义；调协议时发 tool.name
    pub connector_id: Option<String>,      // ← ChatGPT connector 归属（Codex Apps）
    pub connector_name: Option<String>,
    pub plugin_display_names: Vec<String>,
    // ...
}
```

同一个工具挂着两套名字：`tool.name`（对方的原始名，协议层面唯一有效）与
`callable_namespace` + `callable_name`（模型可见名，被 sanitize、可能带 hash 后缀）。
为什么需要两套？因为 Responses API 对工具名有字符集与长度限制（128 字节），而 MCP
服务器名和工具名是任意外部输入，可以含空格、点号、超长串。双轨制让「对模型合法」
与「对协议忠实」互不妥协。4.3 节讲翻译规则。

### `McpConnectionSet`：一条主线的全部 MCP 连接

每条会话主线（thread）的 MCP 状态由一个连接集合承载
（connection_manager.rs:179-191）：

```rust
// 来源：codex-rs/codex-mcp/src/connection_manager.rs:178-191
/// A published view over a set of running MCP server connections.
pub(crate) struct McpConnectionSet {
    servers: HashMap<String, McpServerView>, // ← 服务器名 → 视图
    protocol_mode: crate::McpProtocolMode,
    required_servers: Vec<String>,           // ← 启动失败必须上报的服务器
    optional_startup_deadline: OnceLock<tokio::time::Instant>, // ← 可选服务器的 1 秒宽限
    tool_catalog_revision: Arc<RwLock<u64>>, // ← 工具目录版本号，快照校验用
    codex_apps_tools_override: RwLock<Option<Vec<ToolInfo>>>,
    prefix_mcp_tool_names: bool,             // ← 是否保留历史 mcp__ 前缀
    non_prefixed_mcp_tool_servers: Vec<String>,
    elicitation_requests: ElicitationRequestManager, // ← 服务器反向提问的管理器
    // ...
}
```

每个 `McpServerView`（connection_manager.rs:154-161）包着一条连接
（`Arc<McpConnection>`）、元数据、该服务器的工具过滤器（`ToolFilter`，由
`enabled_tools`/`disabled_tools` 生成，tools.rs:66-96）和工具超时。连接本体
`McpServerConnection`（connection_manager.rs:79-84）里是一个
`AsyncManagedClient`——一个**可共享的启动 future**，这是连接层并发模型的关键，
4.2 节展开。

### `RmcpClient`：单连接的三态状态机

再往下钻一层，单个连接由 `codex-rmcp-client` crate 的 `RmcpClient` 管理
（rmcp-client/src/rmcp_client.rs:372-380）：

```rust
// 来源：codex-rs/rmcp-client/src/rmcp_client.rs:370-380
/// MCP client implemented on top of the official `rmcp` SDK.
/// https://github.com/modelcontextprotocol/rust-sdk
pub struct RmcpClient {
    state: Mutex<ClientState>,
    stdio_process: Option<StdioServerProcessHandle>, // ← stdio 服务器的子进程句柄
    transport_recipe: TransportRecipe,   // ← 重建 transport 所需的一切参数（恢复用）
    protocol_mode: McpProtocolMode,
    initialize_context: Mutex<Option<InitializeContext>>,
    session_recovery_lock: Semaphore,    // ← 会话恢复串行化
    elicitation_pause_state: ElicitationPauseState,
}
```

`ClientState` 是个三态枚举（rmcp-client/src/rmcp_client.rs:122-131）：

```rust
// 来源：codex-rs/rmcp-client/src/rmcp_client.rs:122-131
enum ClientState {
    Connecting {
        transport: Option<PendingTransport>, // ← transport 已建、握手未做
    },
    Ready {
        service: Arc<RunningService<RoleClient, ElicitationClientService>>,
        oauth: Option<OAuthPersistor>,
    },
    Closed,
}
```

`PendingTransport` 对应配置的两种 transport 加一个进程内变体
（rmcp-client/src/rmcp_client.rs:103-120）：`InProcess`、`Stdio`、
`StreamableHttp`、`StreamableHttpWithOAuth`、`StreamableHttpWithAccessTokenOnly`。
`initialize()`（rmcp-client/src/rmcp_client.rs:584-647）把 `Connecting` 消费掉、做
MCP 初始化握手、把状态翻成 `Ready`——状态机用 `Mutex<ClientState>` 把「同一条连接
不会被并发初始化两次」钉死在类型层面。

### `McpBinding` 与 `PreparedMcpCall`：一次采样请求的不可变快照

连接集合是「活的」（服务器随时上下线），但一次采样请求发给模型的工具清单必须和
真正执行调用的句柄是同一份世界。Codex 的解法是**捕获快照**（binding.rs:30-38）：

```rust
// 来源：codex-rs/codex-mcp/src/binding.rs:30-38
/// The exact tool catalog and execution handles shared by compatible sampling steps.
pub struct McpBinding {
    connections: Arc<McpConnectionSet>,      // ← 活连接集合（共享）
    clients: Arc<McpBindingClients>,         // ← 捕获时刻的确切客户端句柄
    config: Arc<McpConfig>,                  // ← 捕获时刻的配置
    plugins_available: bool,
    tools: Vec<ToolInfo>,                    // ← 冻结的模型可见目录
    calls: HashMap<(String, String), PreparedMcpCall>, // ← (服务器, 工具) → 执行句柄
}
```

`PreparedMcpCall`（binding.rs:168-213）把一次调用需要的全部「授权上下文」捆在一起：
确切的客户端、配置、工具信息，以及捕获时的 `catalog_revision`。执行前会校验版本号
没变（binding.rs:293-299），变了就拒绝调用——防止「模型按旧清单调了一个已经换
了 schema 的工具」。这个设计呼应[第 7 章](ch07-agent-loop.md)的 `StepContext.mcp` 字段：每次
采样请求钉一份 `Arc<McpBinding>` 快照。

## 流程走读

### 4.1 从配置到生效服务器集

不是配置里写了的服务器都会被启动。`effective_mcp_servers_from_configured()`
（codex-mcp/src/mcp/mod.rs:309-339）是最后一道闸门：

```rust
// 来源：codex-rs/codex-mcp/src/mcp/mod.rs:309-339（删节）
pub fn effective_mcp_servers_from_configured(
    configured_servers: HashMap<String, McpServerConfig>,
    config: &McpConfig,
    auth: Option<&CodexAuth>,
) -> HashMap<String, EffectiveMcpServer> {
    let mut servers = configured_servers
        .into_iter()
        .map(|(name, mut server)| {
            match server.auth.clone() {
                McpServerAuth::ChatGpt => {
                    // ← 只对可信的第一方 origin 保留 ChatGPT 认证，否则降级为 OAuth
                    if !is_trusted_chatgpt_mcp_server(&server.transport, &config.chatgpt_base_url) {
                        server.auth = McpServerAuth::OAuth;
                    }
                }
                McpServerAuth::OAuth => {}
            }
            // ...
        })
        .collect::<HashMap<_, _>>();
    if !host_owned_codex_apps_enabled(config, auth) {
        servers.remove(CODEX_APPS_MCP_SERVER_NAME); // ← 未开 apps 或无 ChatGPT 登录，移除内置服务器
    }
    servers
}
```

两个值得注意的裁决：`auth = "chatgpt"` 只被允许指向 OpenAI 第一方域名（防止把
ChatGPT 会话 token 发给任意外部服务器）；内置的 `codex_apps` 服务器
（`CODEX_APPS_MCP_SERVER_NAME = "codex_apps"`，mcp/mod.rs:60）只有开了 apps 功能且
当前是 ChatGPT 后端登录时才存在。除此之外，企业级 requirements 还能整批禁用服务器
（配置层的强制约束，见[第 3 章](ch03-config.md)），`enabled = false` 的在更早的目录解析阶段
就被滤掉（connection_manager.rs:274-277 只迭代 `server.enabled()` 的条目）。

### 4.2 连接生命周期：启动、pre-warm、失败降级

Session 创建时安装初始 MCP 运行时（session/session.rs:1555-1563）：

```rust
// 来源：codex-rs/core/src/session/session.rs:1555-1563（删节）
sess.install_initial_mcp_runtime(
    &session_configuration,
    latest_auth,
    mcp_projection,
    &resolved_environments,
    mcp_runtime_cwd,
)
.await?;
sess.start_mcp_prewarm_worker(mcp_prewarm_rx, mcp_auth_changes); // ← 后台预热 worker
```

`install_initial_mcp_runtime()`（core/src/session/mcp_runtime.rs:104-142）组装
`McpRuntimeInput` 后调 `McpRuntime::replace()`（codex-mcp/src/runtime.rs:246-258），
后者用 `ArcSwap` 原子地把新的 `McpConnectionSet` 发布出去。全貌图：

```
Session 创建（session.rs:1555-1563）
   │
   ├─ install_initial_mcp_runtime() ──► McpRuntime::replace()
   │      （core/session/mcp_runtime.rs:104-142）      │
   │                                                   ▼
   │                              McpConnectionSet::new()
   │                              （connection_manager.rs:196-718）
   │                                                   │
   │        ┌──────────────────────┬───────────────────┴───────────┐
   │        ▼                      ▼                               ▼
   │   复用旧连接？           延迟启动                        立即启动
   │   reusable_client()      （有缓存工具 + Lazy 策略）     JoinSet 并发拉起
   │   （87-122 行）          watch 触发器休眠               每个服务器一个任务
   │        │                      │（527-532 行）                 │
   │        └──────────────────────┴───────────────────────────────┘
   │                               ▼
   │         每个服务器发 McpStartupUpdateEvent
   │         （Starting → Ready / Failed / Cancelled）
   │                               ▼
   │         全部结束后发 McpStartupCompleteEvent 汇总
   │         （ready / failed / cancelled 三清单）
   │
   └─ start_mcp_prewarm_worker()（mcp_prewarm.rs:14-56）
         监听 auth 变化 / 脏标记 → refresh_mcp_if_dirty()
```

**启动是并发且带超时的。** 每个服务器的启动任务进一个 `JoinSet` 并发执行；单个
服务器的启动超时默认 30 秒（`DEFAULT_STARTUP_TIMEOUT`，codex-mcp/src/rmcp_client.rs:94，
可被 `startup_timeout_sec` 覆盖，rmcp_client.rs:317-320），超时即判定失败：

```rust
// 来源：codex-rs/codex-mcp/src/rmcp_client.rs:296-353（删节）
fn start(&self) -> ManagedClientFuture {
    // ...
    let startup_timeout = server
        .config()
        .startup_timeout_sec
        .unwrap_or(DEFAULT_STARTUP_TIMEOUT); // ← 默认 30 秒
    async move {
        let outcome = match async {
            // ...
            let client = match tokio::time::timeout(
                startup_timeout,
                make_rmcp_client(/* ... */),
            )
            .await
            {
                Ok(result) => Arc::new(result?),
                Err(_) => {
                    return Err(StartupOutcomeError::from(anyhow!(
                        "MCP client startup timed out after {startup_timeout:?}"
                    )));
                }
            };
            start_server_task(/* ... */).await // ← 握手 + 首次 tools/list
        }
        // ← .or_cancel(&cancel_token)：会话被打断时启动随树取消（Ch7 的 CancellationToken）
        // ...
        startup_complete.store(true, Ordering::Release);
        outcome
    }
    .in_current_span()
    .boxed()
    .shared()                              // ← 关键：启动 future 变成可共享
}
```

末尾的 `.shared()` 值得停留：`ManagedClientFuture` 是
`Shared<BoxFuture<...>>`（rmcp_client.rs:147-148）。任何代码想要这条连接的客户端，
`await` 的都是**同一次启动**——十个并发的工具调用等待同一个慢服务器，只启动一次，
十份 await 各自拿到同一个结果。这是「启动去重」在类型层面的落地（Rust 侧栏会解释
`Shared` 与 TS Promise 的差别）。

**启动结果通过事件流对用户透明。** 每个服务器的状态变化发
`EventMsg::McpStartupUpdate`（Starting/Ready/Failed/Cancelled），全部结束后汇总一条
`EventMsg::McpStartupComplete`（connection_manager.rs:676-716）：

```rust
// 来源：codex-rs/protocol/src/protocol.rs:3498-3539（删节）
pub struct McpStartupUpdateEvent {
    pub server: String,
    pub status: McpStartupStatus, // ← Starting / Ready / Failed{error,reason} / Cancelled
}

pub struct McpStartupCompleteEvent {
    pub ready: Vec<String>,
    pub failed: Vec<McpStartupFailure>,   // ← { server, error }
    pub cancelled: Vec<String>,
}
```

你在客户端看到的「MCP 服务器启动中/就绪/失败」提示就是这条事件链的投影：app-server
把 `McpStartupUpdate` 转成 `McpServerStatusUpdated` 通知推给客户端
（app-server/src/bespoke_event_handling.rs:206-233），TUI 与 IDE 扩展消费的就是它
（TUI 本身是进程内 app-server 客户端，见[第 1 章](ch01-overview.md)）。内核与 UI 解耦的好处在
这里兑现：连接层的任何状态变化不需要专门的通知通道，走标准事件流即可。

**失败分级：required 与 optional 的分野。** `required = true` 的服务器启动失败时，
`install_initial_mcp_runtime` 末尾的 `validate_required_servers()`
（core/session/mcp_runtime.rs:141）会让会话（特别是 `codex exec`）直接报错——配置
注释写明了语义：「`codex exec` exits with an error if this MCP server fails to
initialize」（mcp_types.rs:196-198）。而可选服务器走的是宽松路径：捕获绑定时，
未就绪的可选服务器只有一个极短的宽限期（tool_catalog.rs:35, 199-221）：

```rust
// 来源：codex-rs/codex-mcp/src/connection_manager/tool_catalog.rs:35, 199-221（删节）
const OPTIONAL_MCP_STARTUP_GRACE: Duration = Duration::from_secs(1); // ← 只有 1 秒

// ...must_wait_for_startup 为 false 的可选服务器：
let optional_startup_deadline = /* 首个捕获时刻 + 1 秒宽限 */;
if tokio::time::timeout_at(startup_deadline, view.connection.client())
    .await
    .is_err()
{
    trace!(server_name = %server_name, "omitting pending optional MCP server");
    return;                               // ← 直接不进本次绑定，回合照常开始
}
```

1 秒等不到就**本次不带它的工具**，回合照跑——模型甚至不知道这个服务器存在。之后
服务器就绪了，下一次 `StepContext` 重建工具清单（[第 9 章](ch09-tools.md)）时自然出现。这就是
「可选能力永不阻塞主线」的降级哲学。

**延迟启动与缓存目录。** 启动策略分两档（codex-mcp/src/runtime.rs:58-65）：
`Eager`（发布即启动）与 `LazyWhenCached`（有磁盘缓存的工具目录就先不启动，第一次
真正用到再拉起）。子 Agent（`SessionSource::SubAgent`）用后者
（core/session/mcp_runtime.rs:357-362），普通会话用前者。对 Lazy 连接，
`McpConnectionSet::new` 给它配一个 `watch::channel(false)` 触发器
（connection_manager.rs:527-532），连接处于「休眠」态；第一次 `client()` 调用把
触发器拨成 `true`（connection_manager.rs:124-129），启动任务才被唤醒。

**配置变了怎么办：复用 + 脏标记刷新。** MCP 配置并非一成不变（approval policy、
环境、auth 都可能中途变化）。Session 侧用「脏标记 + 集中刷新」模型
（core/session/mcp.rs:174-239）：任何变化调 `mark_mcp_runtime_dirty()`，下一次需要
MCP 状态时 `refresh_mcp_if_dirty()` 重新计算期望状态并 `publish_mcp_runtime()`。
但全量重建连接代价高，所以 `McpConnectionSet::new` 收到旧的集合做 `previous`，对
每个服务器先问 `reusable_client()`（connection_manager.rs:87-122）能不能复用：

```rust
// 来源：codex-rs/codex-mcp/src/connection_manager.rs:86-122（删节）
async fn reusable_client(&self, desired: &McpServerConnectionIdentity) -> Option<ManagedClient> {
    let current = self.identity.as_ref()?;
    if !current.has_same_connection_config(desired) {
        return None;                       // ← 连接配置（URL/命令/环境）变了：重建
    }
    if !self.client.startup_complete.load(Ordering::Acquire) {
        return None;                       // ← 还没启动完：不算可复用
    }
    let client = self.client.client().await.ok()?;
    if client.client.is_closed().await {
        return None;                       // ← 已断开：重建
    }
    // ← OAuth 凭据也参与比较：登录态变了必须换新连接
    // ...
    if reusable { Some(client) } else { None }
}
```

只有「连接配置一致、启动完成、未关闭、OAuth 凭据匹配」四条件全满足才复用，否则
静默换新连接。这让「改一个无关配置」不会把所有 MCP 服务器重启一遍。

**内置 codex_apps 服务器的特殊待遇：后台重连。** 对 ChatGPT 托管的 `codex_apps`
服务器，启动失败不是终局：`CodexAppsStartupReconnect`
（codex-mcp/src/rmcp_client.rs:165-272）带指数退避在后台重试——初始 1 秒、封顶
30 秒（rmcp_client.rs:97-98, 267-272），期间用缓存的工具目录照常服务，恢复成功后
补发一条 `McpStartupStatus::Ready` 事件。普通用户配置的服务器没有这套重连，失败
就在本次绑定里缺席，等下一次刷新。

**pre-warm worker。** 最后一块拼图是 `mcp_prewarm.rs`（全文仅 75 行）：一个后台任务
监听两类信号——显式的刷新请求（经有界 channel，`try_send` 天然合并重复请求）和
auth 变化通知（`watch::Receiver<u64>`），收到就标脏并触发 `refresh_mcp_if_dirty()`
（mcp_prewarm.rs:21-51）。文件头注释把定位说得很清楚：pre-warm 只是「尽力提前把
状态准备好」的优化，每个采样步（step）开始时的精确解析才是正确性路径
（`mcp_runtime_for_step`，core/session/mcp.rs:310-358）。

### 4.3 工具命名空间：`mcp__server__tool` 是怎样炼成的

连接就绪后，每个服务器的 `tools/list` 结果要翻译成模型可见的工具清单。翻译在
`normalize_tools_for_model_with_prefix()`（tools.rs:113-214），分四步：

1. **去重**：以 `(server_name, callable_namespace, connector_id, callable_name,
   tool.name)` 拼出的原始身份为键，重复的直接 warn + 跳过（tools.rs:121-137）。
2. **清洗**：`sanitize_responses_api_tool_name()` 把命名空间和工具名变成 Responses
   API 合法字符集；`prefix_mcp_tool_names` 为真时给命名空间加 `mcp__` 前缀
   （`non_prefixed_mcp_tool_servers` 里的除外，tools.rs:139-151, 228-234）。
3. **冲突消解**：两个不同来源的服务器清洗后命名空间撞名（比如都叫 `docs`）→
   各自追加 12 位 SHA-1 hash 后缀；同命名空间下工具名撞名同理（tools.rs:153-195,
   243-263）。hash 输入是完整原始身份，所以结果**确定性**——同样的配置永远产出
   同样的名字，这对 prompt cache 友好（[第 9 章](ch09-tools.md)讨论过工具列表稳定性的价值）。
4. **长度兜底**：拼出的模型名超过 128 字节（`MAX_TOOL_NAME_LENGTH`，tools.rs:226）
   时截断并附 hash（tools.rs:269-316）。

经过 `McpBinding::tools()` 冻结后，这份 `Vec<ToolInfo>` 在每个 step 经
`McpHandlerCache::append_mcp_tools()`（core/src/mcp_tool_exposure.rs:37-71）转成
`McpHandler` 注册进 registry——正是[第 9 章](ch09-tools.md)4.3 节讲过的入口。注意曝光策略的
衔接（mcp_tool_exposure.rs:90-94）：开了 `tool_search` 的会话里 MCP 工具默认以
`ToolExposure::Deferred` 注册（不进初始清单、可被搜索到），否则 `Direct`。agent
插件来源的工具还有 spec 字节预算（单工具 8 KB、总计 64 KB，
mcp_tool_exposure.rs:19-20），超预算直接 `Hidden`。模型最终看到的形态是一个
`ToolSpec::Namespace`（handlers/mcp.rs:446-452）：命名空间名 + 描述 + 一个函数
工具。

还要提一句反向过滤器：`tool_is_model_visible()`（tool_catalog.rs:43-58）允许
MCP 服务器通过 `_meta.ui.visibility` 元数据声明某些工具不给模型看（比如只给 UI
组件用的工具），没有该元数据的工具默认可见。

### 4.4 一次 MCP 工具调用的完整链路

把第 9 章的路由和本章的连接层拼起来，一次 MCP 工具调用的全貌：

```
模型输出 FunctionCall（名字形如 mcp__docs__search）
   │
   ▼ ToolRouter/registry 分发（Ch9 4.2 节；MCP 与内置工具无差别）
McpHandler::handle_call()（core/src/tools/handlers/mcp.rs:168-214）
   │
   ▼
handle_mcp_tool_call()（core/src/mcp_tool_call.rs:113-）
   │  ├─ 解析 arguments（空串合法，非法 JSON 直接回错误给模型）
   │  ├─ session.prepare_mcp_call(server, tool)
   │  │      （core/session/mcp_runtime.rs:60-71）
   │  │      └─ 先 refresh_mcp_if_dirty()，再从当前 binding 取 PreparedMcpCall
   │  ├─ 发 McpToolCallBegin 事件 → TUI 显示「调用 MCP 工具」
   │  └─ maybe_request_mcp_tool_approval()（mcp_tool_call.rs:236-248）
   │         └─ 按审批策略决定放行 / 弹审批 / 拒绝（Ch11）
   ▼
PreparedMcpCall::call_with_preparation()（codex-mcp/src/binding.rs:277-309）
   │  ├─ 校验 catalog_revision 未变（清单若已换血，拒绝这次调用）
   │  ├─ effective_timeout = min(服务器 tool_timeout_sec, 调用方要求)
   │  ▼
   RmcpClient::call_tool()（rmcp-client/src/rmcp_client.rs:771-836）
   │  ├─ refresh_oauth_if_needed()      ← 每次调用前检查 token 是否该刷新
   │  └─ tools/call 经 stdio 或 streamable HTTP 发出（带默认 300 秒超时）
   ▼
CallToolResult → 包装为 McpToolOutput → FunctionCallOutput 落史
   （随下一次采样请求全量重发，Ch4/Ch7）
```

三个细节值得记住：

**超时是两层取小。** 服务器配置的 `tool_timeout_sec`（默认 300 秒，
codex-mcp/src/rmcp_client.rs:95）与调用方要求的超时取 `min`
（binding.rs:286-291；连接层的 `call_tool` 同样逻辑，connection_manager.rs:902-907）。
调用方只能收紧、不能放宽服务器声明的上限。

**审批不在 `ToolOrchestrator`。** [第 9 章](ch09-tools.md)说过审批与沙箱的拦截点在 handler 内部
的 `ToolOrchestrator`——但那只包 `exec_command`/`apply_patch` 这类本地触碰文件系统
的工具。MCP 工具的执行发生在对方进程里，本地沙箱无意义，所以 MCP 的安全闸是两样
东西：`handle_mcp_tool_call` 里的审批请求（按服务器的 `default_tools_approval_mode`
与全局审批策略），以及 elicitation——MCP 服务器可以在执行中**反向**向用户提问
（`Session::request_mcp_server_elicitation`，core/session/mcp.rs:529-600），问题经
`EventMsg::ElicitationRequest` 事件弹到 UI，回答经 oneshot 通道送回服务器。这让
「远程工具需要用户确认/补参」有了标准通道，审批策略为 `Never` 时自动拒绝
（mcp.rs:822-845）。

**handler 会等服务器就绪。** `McpHandler` 实现了
`CoreToolRuntime::wait_until_ready()`（handlers/mcp.rs:238-244）：执行前先
`session.wait_for_mcp_server(server_name)`，确保延迟启动的连接在被调用时已经拉起。
这就是为什么 Lazy 策略对用户透明——第一个真正调用该服务器工具的动作会等它完成
启动。

### 4.5 OAuth 型服务器：登录、存储与运行时恢复

远程 MCP 服务器越来越多地用 OAuth 保护。Codex 的处理分三条时间线：

**登录是独立动作。** 连接启动时如果发现认证不足且没有静态 token，启动失败被标记
为「需要认证」（`StartupOutcomeError::is_authentication_required`），失败原因落成
`McpStartupFailureReason::ReauthenticationRequired`
（connection_manager/startup.rs:54-106），经 `McpStartupUpdate` 事件提示用户去登录。
登录由 `codex mcp login <name>` 触发（cli/src/mcp_cmd.rs:531-600），核心在
`perform_oauth_login()`（rmcp-client/src/perform_oauth_login.rs:89-123）：本地起一
个 `tiny_http` 回调服务器（`spawn_callback_server`，perform_oauth_login.rs:252）、
打开浏览器走授权码 + PKCE 流程、拿到 token 后落盘。`codex mcp add` 一个 HTTP
服务器时也会自动探测 OAuth 支持并提示登录（mcp_cmd.rs:448-483）。

**存储可配置。** token 存哪由 `mcp_oauth_credentials_store_mode` 决定
（config/src/types.rs:120-135）：

```rust
// 来源：codex-rs/config/src/types.rs:120-135
pub enum OAuthCredentialsStoreMode {
    /// Prefer `Keyring` and use `File` when keyring storage is unavailable.
    Auto,    // ← 默认：优先 OS keyring，不可用时退到文件
    /// CODEX_HOME/.credentials.json
    File,    // ← 明文文件，同用户其它进程可读
    /// Keyring when available, otherwise fail.
    Keyring, // ← 只用 keyring，没有就报错
}
```

**运行时会自动恢复。** 这是最容易被忽略的一条：用户在另一个终端跑完
`codex mcp login` 后，**正在运行的会话不需要重启**。每个 step 开始时
`mcp_runtime_for_step()`（core/session/mcp.rs:310-358）会检查
`updated_oauth_credentials_after_auth_failure()`（connection_manager.rs:767-802）——
扫一遍认证失败的服务器，比对磁盘上的凭据是否已更新；有更新就标脏触发刷新，
连接用新凭据重建，认证失败的服务器自动「复活」。此外每次 `call_tool` 前
`refresh_oauth_if_needed()`（rmcp-client/src/rmcp_client.rs:778）会用 refresh token
原地续期。

### 4.6 反向形态：Codex 自己当 MCP server（及其弃用）

最后看反方向：`codex-rs/mcp-server/` crate 把 Codex 本身包装成 MCP 服务器，让其它
Agent（Claude Code、IDE 里的别的助手）把「跑一个 Codex 会话」当成工具调用。形态
非常朴素——stdio 上的行分隔 JSON-RPC，三个 tokio 任务
（mcp-server/src/lib.rs:126-206）：一个从 stdin 读行解析成消息、一个
`MessageProcessor` 分发处理、一个把响应写回 stdout。对外只暴露两个工具
（mcp-server/src/message_processor.rs:336-358 的 `handle_list_tools` 与
357-358 的分发）：

- `codex`：给定 prompt 开一个全新 Codex 会话跑完一个回合，返回最终文本；
- `codex-reply`：带 `threadId` 继续之前的会话。

`run_codex_tool_session()`（codex_tool_runner.rs:66-120）内部就是创建一个
`CodexThread`、提交 `Op::TurnInput`、把内核事件流转成 MCP 通知——又一次印证
「内核与外壳解耦」：MCP server 只是第四种外壳。会话 ID 通过 `structuredContent`
里的 `threadId` 回传（codex_tool_runner.rs:37-52），供 `codex-reply` 续接。

但本基线上这条入口已经**标记弃用**（cli/src/main.rs:1183-1198）：

```rust
// 来源：codex-rs/cli/src/main.rs:1183-1197
Some(Subcommand::McpServer(McpServerCommand { strict_config })) => {
    eprintln!(
        "warning: `codex mcp-server` is deprecated and will be removed in a future release."
    );
    // ...
    codex_mcp_server::run_main(/* ... */).await?;
}
```

为什么要弃用一个能用的形态？三个层面的证据。其一，这个 crate 自己的定位：lib.rs
第一行注释就是 `//! Prototype MCP server`——它是早期原型，只暴露「跑会话」这
一个粒度。其二，对外服务的重心已经移到 app-server：官方 TypeScript / Python SDK
（仓库根 `sdk/` 目录）绑定的是 app-server 的 JSON-RPC 资源模型（thread/turn/item
是一等资源，见[第 15 章](ch15-app-server.md)），IDE 集成也走它；连 TUI 自己都不再直接持有
`ThreadManager`，而是通过进程内 app-server 客户端建会话（`InProcessAppServerClient`，
tui/src/lib.rs:566-590，`session_source` 传 `"cli"`）。其三，维护两个对外协议面
（MCP 的 tools/call 语义 vs app-server 的资源语义）对每个新能力都要做两遍映射；
收敛到一个面，演进成本减半。对你设计自己的 Agent 这是重要信号：**MCP 适合「把
工具喂给别人的 Agent」，自家 Agent 的完整会话能力更适合自定义 RPC**——粒度不匹配
是 MCP server 形态的天花板，一次 `tools/call` 装不下 steer、审批、打断这些交互。

## 设计取舍

**为什么是「活连接集合 + 不可变绑定快照」双层结构，而不是每次调用现查？**

`McpConnectionSet` 是可变的（服务器上下线、配置刷新），`McpBinding` 是冻结的。
如果每次工具调用都现查活集合，会出现「模型按清单 A 决定调用、执行时世界已变成
B」的竞态：服务器刚下线，调用打到空气上；或者更糟，服务器换了版本、同名工具
schema 变了，旧参数悄悄错位。快照 + `catalog_revision` 校验（binding.rs:293-299）
把这类竞态变成**显式错误**：清单换血后，按旧清单准备的调用被拒绝，错误文本回给
模型，模型下一步自然按新清单行动。代价是要维护 revision 计数与捕获逻辑——和
[第 8 章](ch08-context-compact.md)「全量重发历史」、[第 9 章](ch09-tools.md)「每步重建工具清单」是同一种哲学：
宁可重算，不维护易错的增量一致性。

**为什么双轨命名，而不是强制 MCP 服务器起名合法？**

因为你管不了别人的服务器。MCP 生态里服务器名和工具名是任意外部输入，而
Responses API 对工具名有硬性约束。Codex 的选择是「入乡随俗 + 保留原样」：对模型
侧 sanitize + hash 消歧 + 128 字节截断，对协议侧永远用原始名。hash 后缀的输入
包含 `(server_name, callable_namespace, connector_id, callable_name, tool.name)`
五元组（tools.rs:124-133），保证不同来源的同名工具得到不同后缀且结果确定。
确定性不只是工程洁癖——工具列表稳定直接决定 prompt cache 命中率。

**对比 my-agent：三行接 MCP 与生产级连接层的差距。**

TS 里的典型写法大概是这样：

```typescript
// my-agent 式接法：成功路径很美，失败路径没有答案
const client = new Client({ name: "my-agent", version: "0.1" });
await client.connect(new StdioClientTransport({ command: "docs-server" }));
const { tools } = await client.listTools();
tools.forEach(t => registry.set(`mcp__docs__${t.name}`, {
  schema: t.inputSchema,
  execute: (args) => client.callTool({ name: t.name, arguments: args }),
}));
```

对照本章，Codex 多出来的几千行买了六样东西，每样都对应一个真实故障模式：

| my-agent 的坑 | Codex 的对应物 |
|----------------|----------------|
| 服务器启动慢，整个 Agent 卡在启动 | 并发 JoinSet 启动 + 30s 超时 + 可选服务器 1 秒宽限后降级缺席 |
| 一个服务器挂掉，整个进程报错退出 | required/optional 分级；optional 失败只进 `McpStartupComplete.failed` 清单 |
| 两个服务器撞工具名，后者覆盖前者 | 双轨命名 + hash 消歧，注册走 `register_external` 宽容跳过（Ch9） |
| 模型看到的清单和执行时的连接不是同一版本 | `McpBinding` 快照 + `catalog_revision` 校验 |
| token 过期后调用莫名 401 | 每次调用前 `refresh_oauth_if_needed`；外部登录后运行时会话自动恢复 |
| 改配置只能重启进程 | 脏标记 + `refresh_mcp_if_dirty` + 四条件连接复用 |

如果你的 my-agent 只打算接一两个可信的内部服务器，TS 三行写法没什么错——Codex
这套机器的成本只有服务器来源不可控、数量上规模时才收得回来。但其中两件便宜事
建议直接抄：**启动去重**（多处并发等待同一次连接，TS 里缓存同一个 Promise 即可）
和**名字翻译与协议调用分离**（注册表里存 `{displayName, rawName, client}` 三件套）。

**「扩展生态」不止 MCP。** 本章聚焦 MCP，但本基线的扩展面还有 skills、plugins、
connectors（`codex-mcp/src/plugin_config.rs`、`catalog.rs` 负责把它们注册进服务器
目录）与 Codex Apps（ChatGPT 托管 connector 经内置 `codex_apps` 服务器接入）。它们
共享同一套连接与命名基础设施——MCP 是这些形态的公共底座，这也是连接层要处理
`connector_id`、插件归属、`ToolPluginProvenance` 这些字段的原因。

**局限与演进方向。** 连接层的复杂度已经相当高：`McpConnectionSet::new` 一个函数
500 余行（connection_manager.rs:196-718），复用判定有四个分支交错（pending 复用、
auth 失败复用、就绪复用、全新创建）；普通服务器失败后没有自动重连（只有
codex_apps 有退避重连），想恢复要等下一次刷新；`Legacy` 与 `V20260728` 两种协议
模式并存（`McpProtocolMode`）说明协议版本迁移仍在途中。读这部分代码时，把它当
「正在向更声明式的 reconciler 演进的中态」会更贴近现实。

## 动手实验

以下命令在仓库根目录执行；前两条是只读检索，后三条会用到 `codex` 二进制
（可用 `cargo run --bin codex -- ...` 代替，注意首次编译较慢）。

**1. 看 `codex mcp` 家族的用户入口**（预期输出：`list`/`get`/`add`/`remove`/
`login`/`logout` 六个子命令，与 mcp_cmd.rs:46-70 的注释一一对应）：

```shell
cargo run --bin codex -- mcp --help
```

**2. 找到命名翻译与降级的关键代码**（预期输出：各命中 1-2 行）：

```shell
cd codex-rs
rg -n "fn normalize_tools_for_model_with_prefix" codex-mcp/src/tools.rs
rg -n "OPTIONAL_MCP_STARTUP_GRACE" codex-mcp/src/connection_manager/tool_catalog.rs
rg -n "McpStartupCompleteEvent" protocol/src/protocol.rs
```

**3. 配一个真实服务器并观察启动事件。** 用官方示例服务器（需要本机有 Node）：

```shell
cargo run --bin codex -- mcp add everything -- npx -y @modelcontextprotocol/server-everything
cargo run --bin codex -- mcp list
# 预期输出：everything 一行，含 enabled 状态与 auth_status（stdio 服务器为 unsupported）
```

随后跑一次 exec 并开连接层日志：

```shell
RUST_LOG=codex_mcp=debug cargo run --bin codex -- exec "say hi"
# 预期形态：stderr 出现 MCP 启动相关 tracing 行；交互客户端（TUI/IDE）里能看到
# 服务器启动状态变化（经 McpStartupUpdate → McpServerStatusUpdated 通知链）
```

试完记得 `codex mcp remove everything` 清理配置。

**4. 观察弃用警告**（预期输出：首行 stderr 打印
`warning: \`codex mcp-server\` is deprecated and will be removed in a future release.`，
随后正常打印 help）：

```shell
cargo run --bin codex -- mcp-server --help
```

**5. 验证 required 语义。** 给配置加一个故意起不来的 required 服务器：

```shell
cargo run --bin codex -- mcp add broken -- /nonexistent-binary-xyz
# 然后手工把 ~/.codex/config.toml 里 [mcp_servers.broken] 加上 required = true
cargo run --bin codex -- exec "say hi"
# 预期形态：exec 直接报错退出（validate_required_servers，mcp_runtime.rs:141）；
# 把 required 去掉再跑，预期：回合正常完成，失败只出现在 MCP 启动失败提示里
```

## Rust 侧栏

- **`Shared<BoxFuture>`：可多次 await 的 future。** Rust 的 async 是惰性的：一个
  future 只能被消费一次。`futures::FutureExt::shared()`（rmcp_client.rs:392-393）
  把它包成 `Shared`，内部轮询一次、结果克隆分发给所有 awaiter——效果等价于 TS
  里「同一个 Promise 可以被任意多处 `await`」。Codex 用它实现 MCP 启动去重。
- **`watch::channel`：只保留最新值的广播。** tokio 的 `watch` 通道发送方覆盖写、
  接收方读「当前最新值」。本章两处用法：延迟启动的触发器（connection_manager.rs:
  527-532，拨成 `true` 唤醒启动任务）和发布门闸 `McpPublicationGate`
  （runtime.rs:129-161，新连接集合发布前，旧任务的事件不发）。适合「状态信号」
  而非「消息流」。
- **`ArcSwap`：无锁的原子指针替换。** `McpRuntime.current`（runtime.rs:93）用它把
  「发布新的连接集合」变成一个原子操作：读者永远拿到一份完整的旧或新集合，没有
  中间态，也不用给读取路径上锁。TS 里没有直接对应物——单线程事件循环里赋值引用
  本来就是原子的，这是 Rust 共享内存并发特有的工具。
- **`#[serde(untagged)]`：无标签枚举。** `McpServerTransportConfig` 序列化时不带
  类型标签，反序列化靠「字段形状匹配」挨个尝试变体。配置文件因此写起来像一张平
  表，代价是字段重叠时会歧义——所以两个变体的必填字段（`command` vs `url`）
  刻意不重叠。
- **`OnceLock`：只允许初始化一次的格子。** `optional_startup_deadline`
  （connection_manager.rs:183）是「第一个捕获时刻 + 1 秒」的全局死线，谁先算好
  谁写入，后来者直接读。比 `lazy_static` 轻，语义是「恰好一次」。

## 小结 + 思考题

本章把 MCP 这条线从两端走了一遍。客户端方向：配置经 `effective_mcp_servers` 闸门
落成生效服务器集；`McpConnectionSet` 并发启动所有连接（30 秒超时、required/
optional 分级、1 秒宽限降级），状态经 `McpStartupUpdate`/`McpStartupComplete` 事件
透明化；工具名经 sanitize + hash 消歧变成模型可见的命名空间，随 `McpBinding`
快照进入每次采样请求；调用经 `PreparedMcpCall` 校验 revision、收紧超时后发给
`RmcpClient`；OAuth 登录、存储、刷新、运行时恢复有完整闭环。服务端方向：
`mcp-server` crate 以 stdio JSON-RPC 暴露 `codex`/`codex-reply` 两个工具，但该
形态已弃用，对外服务正向 app-server 体系收敛——MCP 适合喂工具，装不下完整会话。

思考题：

1. 可选服务器启动超过 1 秒宽限期时，本次绑定里没有它的工具。它之后就绪了，
   模型在哪一步会「看见」这些工具？结合[第 9 章](ch09-tools.md)工具清单重建机制与
   `tool_catalog_revision` 回答。
2. `PreparedMcpCall::call_with_preparation` 执行前校验 `catalog_revision`
   （binding.rs:293-299）。构造一个「不校验就会出错」的具体场景，并说明错误为什么
   应该返回给模型而不是让回合失败（呼应[第 9 章](ch09-tools.md)的 `RespondToModel` 模式）。
3. 双轨命名里 hash 输入是 `(server_name, callable_namespace, connector_id,
   callable_name, tool.name)` 五元组（tools.rs:124-133）。如果只用
   `(server_name, tool.name)`，什么现实场景会撞名？
4. 如果给 my-agent 加 MCP OAuth 支持，Codex 的哪些模块边界可以直接翻译成 TS
   模块？（提示：`perform_oauth_login` / `oauth.rs` 的存储抽象 / 每次调用前的
   `refresh_oauth_if_needed`，各自对应什么？）
5. `codex mcp-server` 被弃用而 app-server 成为对外稳定面。反过来说，什么能力
   **仍然**适合以 MCP server 形态暴露？（提示：想想 MCP 客户端生态里有哪些
   消费方永远不会去接 app-server。）
