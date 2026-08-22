# 第 4 章 认证与模型接入：登录、Provider 与 SSE 流式解析

## 本章导读

一个 Agent 能跑起来的最低配置是什么？在 my-agent 那样的 TypeScript 项目里，答案通常是：读一个 `OPENAI_API_KEY` 环境变量，拼进 `Authorization: Bearer ...` 头，`fetch` 一下聊天接口，然后按行解析返回的 SSE 文本。这套做法写 demo 够用，但放到生产级 CLI 里会立刻撞上三个真实问题：

**第一，凭据不止一种，而且会过期。** Codex 支持 ChatGPT 账号登录（OAuth 授权码 + PKCE 流程，拿到 access token / refresh token 对）和 API key 两条路。OAuth token 有有效期，到期要自动刷新；刷新可能失败，401 要在请求层面被拦截并重试；多个进程可能共享同一份凭据文件。这不是"读个环境变量"能糊弄的。

**第二，模型提供方（provider）不止一家。** OpenAI 官方 API、ChatGPT 后端、Amazon Bedrock、本地 Ollama/LM Studio，以及用户在 `config.toml` 里自定义的任何 OpenAI 兼容端点——它们的 base URL、认证方式、重试策略、超时都不一样，但对 Agent 内核而言必须长得一模一样。

**第三，流式响应不是"按行 JSON.parse"那么简单。** Responses API 的 SSE 流里有几十种事件类型：文本增量、工具调用增量、条目完成、限流快照、错误分类……解析层要把这些线上字节流翻译成一组干净的领域事件，还要处理空闲超时、断流、错误归类。

本章就把这条链路走完：从 `codex login` 的浏览器跳转，到 `auth.json` 的落盘与刷新，到 provider 抽象层，再到请求构造与 SSE 解析。边界划分上：请求在 Agent Loop 里何时发出、响应如何驱动工具调用，是[第 7 章](ch07-agent-loop.md)的内容；`ResponseItem` 数据模型本身的定义留给[第 5 章](ch05-protocol.md)。本章只负责把"能登录、能寻址、能发出流式请求并把字节流解析成事件"这一段讲透。

## 源码地图

认证与模型接入横跨五个 crate，分层非常清晰——这正是第 1 章说的"crate 划分哲学"的第一个实例：

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-rs/cli/src/login.rs` | `codex login` 子命令分发 | 第 2 章提到的入口，薄薄一层壳 |
| `codex-rs/login/src/server.rs` | OAuth 登录：起本地 HTTP 服务接回调、换 token | 一个 CLI 里内置了微型 Web 服务器 |
| `codex-rs/login/src/pkce.rs` | PKCE code_verifier/challenge 生成 | 27 行，标准的 S256 实现 |
| `codex-rs/login/src/token_data.rs` | `TokenData`：JWT 三元组与 claims 解析 | 客户端自己解 JWT payload 取过期时间 |
| `codex-rs/login/src/auth/storage.rs` | `AuthDotJson` 与存储后端（文件/钥匙串/内存） | 凭据落盘的唯一真相 |
| `codex-rs/login/src/auth/manager.rs` | `AuthManager`：缓存、惰性刷新、401 恢复 | 3000 行，本章的"重文件" |
| `codex-rs/model-provider-info/src/lib.rs` | `ModelProviderInfo`：provider 声明式配置 | 内置 + 用户配置合并的注册表 |
| `codex-rs/model-provider/src/provider.rs` | 运行时 `ModelProvider` trait 与工厂 | 把静态配置变成可执行对象 |
| `codex-rs/codex-api/src/auth.rs` | `AuthProvider` trait：给请求注入认证 | 认证与传输解耦的接缝 |
| `codex-rs/codex-api/src/common.rs` | `ResponsesApiRequest` / `ResponseEvent` | 请求与事件的线上形状 |
| `codex-rs/codex-api/src/endpoint/responses.rs` | `ResponsesClient`：POST /responses | 传输层入口 |
| `codex-rs/codex-api/src/sse/responses.rs` | SSE 字节流 → `ResponseEvent` 的解析器 | 本章后半的主角 |
| `codex-rs/core/src/client.rs` | `ModelClient`：组装请求、串起上面一切 | 2556 行，core 与传输层的接缝 |
| `codex-rs/core/src/client_common.rs` | `Prompt`：一次模型调用的完整输入 | 短小但地位关键 |

读这一章的代码时记住分层方向：`cli → login → core/client → codex-api → 网络`。`AuthManager` 不知道 HTTP 请求长什么样，`ResponsesClient` 不知道 token 怎么刷新——它们之间靠 `AuthProvider` trait 和 `CodexAuth` 类型连接。

## 核心数据结构

### 凭据的持久化形态：`AuthDotJson` 与 `TokenData`

登录成功后凭据落在 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）。它的结构直接对应磁盘上的 JSON：

```rust
// 来源：codex-rs/login/src/auth/storage.rs:40-61
/// Expected structure for $CODEX_HOME/auth.json.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct AuthDotJson {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<AuthMode>,

    #[serde(rename = "OPENAI_API_KEY")]
    pub openai_api_key: Option<String>,   // ← API key 登录只填这个字段

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenData>,        // ← ChatGPT OAuth 登录填这个

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_refresh: Option<DateTime<Utc>>, // ← 上次刷新时间，决定何时再刷
    // ...
}
```

注意 `#[serde(rename = "OPENAI_API_KEY")]`：磁盘文件里的 key 是全大写的，这是历史兼容产物——早期版本的 auth.json 就长这样，改名将破坏所有存量用户。`AuthDotJson` 里还有 `agent_identity`、`personal_access_token`、`bedrock_api_key` 等字段，说明这个文件是多种凭据形态的"并集"，同一时刻只有一部分有值。

ChatGPT 登录的 `tokens` 字段是 `TokenData`：

```rust
// 来源：codex-rs/login/src/token_data.rs:10-25
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
pub struct TokenData {
    /// Flat info parsed from the JWT in auth.json.
    #[serde(
        deserialize_with = "deserialize_id_token",
        serialize_with = "serialize_id_token"
    )]
    pub id_token: IdTokenInfo,    // ← 磁盘上存原始 JWT 字符串，读入时自动解析成结构体

    /// This is a JWT.
    pub access_token: String,     // ← 真正放进 Authorization 头的 token

    pub refresh_token: String,    // ← 用来换新 access token

    pub account_id: Option<String>,
}
```

`id_token` 的自定义反序列化器（`token_data.rs:163-169`）是个精巧设计：磁盘上只存原始 JWT 字符串，加载时用 `parse_chatgpt_jwt_claims`（`token_data.rs:137-161`）解开 payload 里的 claims——邮箱、套餐类型（`chatgpt_plan_type`）、账号 ID。客户端**不验签**，只是 base64 解码取字段（`decode_jwt_payload`，`token_data.rs:117-128`）。这是合理的：验签是服务端的事，客户端解 JWT 只是为了做"何时该刷新"这类本地决策。`access_token` 的过期时间也是这样被 `parse_jwt_expiration`（`token_data.rs:130-135`）读出来的，后面刷新策略要用。

### 内存中的凭据：`CodexAuth` 与 `AuthMode`

磁盘格式是"并集"，内存里则是枚举。`CodexAuth` 是当前生效的认证机制：

```rust
// 来源：codex-rs/login/src/auth/manager.rs:74-84
/// Authentication mechanism used by the current user.
#[derive(Debug, Clone)]
pub enum CodexAuth {
    ApiKey(ApiKeyAuth),                          // ← codex login --with-api-key 写入
    Chatgpt(ChatgptAuth),                        // ← Codex 托管的 OAuth，会自动刷新
    ChatgptAuthTokens(ChatgptAuthTokens),        // ← 宿主应用（如 IDE）注入的 token
    Headers(AuthHeaders),                        // ← 外部直接给整组请求头
    AgentIdentity(AgentIdentityAuth),
    PersonalAccessToken(PersonalAccessTokenAuth),
    BedrockApiKey(BedrockApiKeyAuth),
}
```

本书只展开前两个主流程，其余变体都是同一模式的特化。配套的 `AuthMode`（`codex-rs/protocol/src/auth.rs:9-34`）是可序列化的"模式标签"，它比 `CodexAuth` 少带数据、可以进配置文件和遥测。注意 `Chatgpt` 与 `ChatgptAuthTokens` 的区别（`manager.rs:468-490` 的 `auth_mode()` vs `api_auth_mode()`）：前者表示"Codex 自己管刷新"，后者表示"token 是别人给的，刷新不归我管"——这个区分直接决定 401 时走不走刷新逻辑。

取 token 时各变体行为不同，`get_token` 把差异收敛成一个接口（`manager.rs:546-564`）：ApiKey 直接返回 key，ChatGPT 系返回 `access_token`，而 Headers/AgentIdentity 等"没有 bearer token 概念"的变体返回 `Err`——调用方不得依赖"任何凭据都能取出一个 token 字符串"的假设。

### 提供方声明：`ModelProviderInfo` 与 `WireApi`

provider 层的一切从这份声明式配置开始：

```rust
// 来源：codex-rs/model-provider-info/src/lib.rs:94-151（有删节）
/// Serializable representation of a provider definition.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, JsonSchema)]
pub struct ModelProviderInfo {
    /// Friendly display name.
    #[serde(default)]
    pub name: String,
    /// Base URL for the provider's OpenAI-compatible API.
    pub base_url: Option<String>,
    /// Environment variable that stores the user's API key for this provider.
    pub env_key: Option<String>,          // ← 如 "OPENAI_API_KEY"；只存变量名不存值
    // ...
    /// Which wire protocol this provider expects.
    #[serde(default)]
    pub wire_api: WireApi,
    /// Additional HTTP headers to include in requests to this provider
    pub http_headers: Option<HashMap<String, RedactedString>>,
    /// ... value 来自环境变量的 headers
    pub env_http_headers: Option<HashMap<String, String>>,
    /// Maximum number of times to retry a failed HTTP request to this provider.
    pub request_max_retries: Option<u64>,
    /// Number of times to retry reconnecting a dropped streaming response
    pub stream_max_retries: Option<u64>,
    /// Idle timeout (in milliseconds) for streaming responses
    pub stream_idle_timeout_ms: Option<u64>,
    // ...
    /// Does this provider require an OpenAI API Key or ChatGPT login token?
    #[serde(default)]
    pub requires_openai_auth: bool,       // ← true 才会走 auth.json 那套登录体系
    // ...
}
```

几个字段值得单独说：

- `env_key` 存的是**环境变量的名字**而非 key 本身（`lib.rs:339-355` 的 `api_key()` 现场读环境）。这让 config.toml 可以安全地提交/分享。
- `RedactedString` 包装的 header 值在 Debug 输出时会脱敏，避免 key 被打进日志。
- `requires_openai_auth` 是路由开关：为 true 时凭据来自 `auth.json` 体系（ChatGPT 登录或 `OPENAI_API_KEY`），为 false 时要么无认证（本地 Ollama），要么走 `env_key`/`experimental_bearer_token`/`auth` 命令/AWS SigV4 中的一条。`validate()`（`lib.rs:193-261`）负责在配置加载时拒绝这些互斥字段同时出现。

`WireApi` 目前只有一个变体（`lib.rs:62-91`）：

```rust
// 来源：codex-rs/model-provider-info/src/lib.rs:62-68
/// Wire protocol that the provider speaks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WireApi {
    /// The Responses API exposed by OpenAI at `/v1/responses`.
    #[default]
    Responses,
}
```

历史上曾有 `Chat`（Chat Completions API）变体，本基线上已被移除——反序列化 `"chat"` 会直接报错并给出迁移指引（`lib.rs:57, 85-89`）。这是个信号：**Codex 已全量押注 Responses API**，多 provider 的差异不靠"多套协议实现"吸收，而靠"同一协议 + 不同端点/认证/重试配置"吸收。这是本章设计取舍一节要展开的关键判断。

### 请求与事件：`Prompt`、`ResponsesApiRequest`、`ResponseEvent`

core 侧对模型的一次调用，输入是 `Prompt`：

```rust
// 来源：codex-rs/core/src/client_common.rs:17-37（有删节）
/// API request payload for a single model turn
#[derive(Debug, Clone)]
pub struct Prompt {
    /// Conversation context input items.
    pub input: Vec<ResponseItem>,          // ← 对话历史，Responses API 的 input 数组

    /// Tools available to the model
    pub(crate) tools: Arc<[ToolSpec]>,     // ← 工具定义（第 9 章展开）

    pub base_instructions: BaseInstructions, // ← 系统提示词

    /// Optional the output schema for the model's response.
    pub output_schema: Option<Value>,      // ← 结构化输出 schema
    // ...
}
```

`Prompt` 还是 core 的内部概念；真正发到线上的是 `ResponsesApiRequest`——它基本就是 Responses API 请求体的 Rust 镜像：

```rust
// 来源：codex-rs/codex-api/src/common.rs:251-275
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ResponsesApiRequest {
    pub model: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub instructions: String,              // ← base_instructions 的落点
    pub input: Vec<ResponseItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<ResponsesApiTools>,
    pub tool_choice: String,
    pub parallel_tool_calls: bool,
    pub reasoning: Option<Reasoning>,
    pub store: bool,                       // ← Codex 固定 false：不在服务端存响应
    pub stream: bool,                      // ← 固定 true：永远流式
    // ...
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<String>,  // ← Prompt Caching 的会话亲和键
    // ...
}
```

返回方向是 `ResponseEvent`——SSE 解析器产出的领域事件枚举：

```rust
// 来源：codex-rs/codex-api/src/common.rs:75-123（有删节）
#[derive(Debug)]
pub enum ResponseEvent {
    Created,
    OutputItemDone(ResponseItem),        // ← 一个完整条目（消息/工具调用）产出
    OutputItemAdded(ResponseItem),
    OutputTextDelta(String),             // ← 文本增量，TUI 打字机效果靠它
    ToolCallInputDelta { item_id: String, call_id: Option<String>, delta: String },
    ReasoningSummaryDelta { delta: String, summary_index: i64 },
    ReasoningContentDelta { delta: String, content_index: i64 },
    RateLimits(RateLimitSnapshot),       // ← 从响应头解析的限流快照
    Completed {
        response_id: String,
        token_usage: Option<TokenUsage>, // ← 含 cached_input_tokens，缓存命中可见
        end_turn: Option<bool>,
    },
    // ...
}
```

线上 SSE 事件类型有几十种，但 `ResponseEvent` 只有十几个变体：**解析层做了第一层降噪**，把线上协议的细节挡在 core 之外。

## 流程走读

### 4.1 登录：`codex login` 的一次浏览器往返

第 2 章讲过 `codex login` 由 `codex-rs/cli/src/login.rs` 分发。它有三条路径（`cli/src/login.rs` 顶部的 import 可见）：浏览器 OAuth（`run_login_server`）、stdin 读 API key（`login_with_api_key`，对应 `codex login --with-api-key`）、无浏览器环境用的设备码（`run_device_code_login`，`login/src/device_code_auth.rs`）。这里走读主路径 OAuth：

```
codex login
   │
   ▼
run_login_server(opts)                     login/src/server.rs:160
   │  generate_pkce() ──► code_verifier + code_challenge (S256)
   │  bind_server(port) ──► 本地 HTTP 服务监听 127.0.0.1
   │  build_authorize_url() ──► https://auth.openai.com/oauth/authorize?...
   ▼
webbrowser::open(auth_url) ──► 用户在浏览器里登录 ChatGPT
   │
   ▼
浏览器重定向到 http://localhost:{port}/auth/callback?code=...&state=...
   │
   ▼
process_request()                          server.rs:326-460
   │  校验 state（防 CSRF）
   │  exchange_code_for_tokens() ──► POST {issuer}/oauth/token
   │       换得 id_token / access_token / refresh_token
   │  obtain_api_key() ──► 顺带换一个 API key（供需要 key 的场景）
   ▼
persist_tokens_async() ──► 写入 ~/.codex/auth.json
```

几个细节值得展开。**PKCE**（Proof Key for Code Exchange）的实现只有 27 行（`login/src/pkce.rs:12-27`）：随机 64 字节做 `code_verifier`，其 SHA-256 的 base64url 编码做 `code_challenge`。CLI 是无法保守 client secret 的公开客户端，PKCE 保证即使授权码被截获，没有 verifier 也换不到 token——这是 OAuth 公开客户端的标准做法，Codex 按教科书实现。

**授权 URL 的组装**在 `build_authorize_url`（`server.rs:576-612`）：

```rust
// 来源：codex-rs/login/src/server.rs:584-601（有删节）
let mut query = vec![
    ("response_type".to_string(), "code".to_string()),
    ("client_id".to_string(), client_id.to_string()),
    ("redirect_uri".to_string(), redirect_uri.to_string()),
    (
        "scope".to_string(),
        "openid profile email offline_access api.connectors.read api.connectors.invoke"
            .to_string(),
    ),
    ("code_challenge".to_string(), pkce.code_challenge.to_string()),
    ("code_challenge_method".to_string(), "S256".to_string()),
    // ...
    ("state".to_string(), state.to_string()),
    ("originator".to_string(), originator().value),
];
```

注意 scope 里的 `offline_access`——这是换取 refresh token 的关键，没有它就无法离线刷新。`state` 是 32 字节随机数（`server.rs:614-618`），回调时严格比对（`server.rs:352-375`），不匹配直接 400，防跨站请求伪造。

**本地回调服务**用的是同步微型 HTTP 库跑在独立线程里，通过 `mpsc` channel 把请求桥接进 tokio 世界（`server.rs:190-206` 的 `blocking_send`）。回调处理在 `process_request`（`server.rs:326-460`）：校验 state → `exchange_code_for_tokens`（`server.rs:809-845`）用 `application/x-www-form-urlencoded` 表单把 `code + code_verifier` POST 给 `{issuer}/oauth/token` → 拿到三元组后 `persist_tokens_async` 落盘。之后浏览器被重定向到成功页。

API key 路径则简单得多——`login_with_api_key`（`manager.rs:959-980`）只是构造一份只含 `openai_api_key` 字段的 `AuthDotJson` 写盘，没有任何网络往返。CLI 侧对应 `printenv OPENAI_API_KEY | codex login --with-api-key`（`cli/src/main.rs:497-500` 的 flag 定义），从 stdin 读 key 避免它出现在进程参数里。

### 4.2 凭据生命周期：缓存、刷新、注入请求头

运行时的凭据总管是 `AuthManager`：

```rust
// 来源：codex-rs/login/src/auth/manager.rs:1999-2017
pub struct AuthManager {
    codex_home: PathBuf,
    inner: RwLock<CachedAuth>,              // ← 内存缓存的当前凭据
    auth_change_tx: watch::Sender<u64>,     // ← 凭据变更广播（UI 可订阅）
    enable_codex_api_key_env: bool,
    auth_credentials_store_mode: AuthCredentialsStoreMode,
    // ...
    refresh_lock: Semaphore,                // ← 容量 1：全局同时只允许一次刷新
    // ...
    external_auth: RwLock<Option<Arc<dyn ExternalAuth>>>,
    // ...
}
```

**存储是多后端的。** `AuthCredentialsStoreMode`（`codex-rs/config/src/types.rs:108-118`）有四档：`File`（auth.json 明文文件）、`Keyring`（操作系统钥匙串）、`Auto`（钥匙串优先、文件兜底）、`Ephemeral`（纯内存）。统一抽象在 `AuthStorageBackend` trait（`storage.rs:163-167`），只有 `load/save/delete` 三个方法，`FileAuthStorage`、`DirectKeyringAuthStorage`、`AutoAuthStorage`、`EphemeralAuthStorage` 各自实现。默认 `File`。

**读取是惰性刷新的。** 业务代码每次要凭据都调 `auth()`（`manager.rs:2311-2325`）：

```rust
// 来源：codex-rs/login/src/auth/manager.rs:2311-2325
pub async fn auth(&self) -> Option<CodexAuth> {
    if self.has_external_auth() {
        self.reload().await;
        return self.auth_cached();
    }

    let auth = self.auth_cached()?;
    if Self::should_refresh_proactively(&auth)
        && let Err(err) = self.refresh_token().await
    {
        tracing::error!("Failed to refresh token: {}", err);
        return Some(auth);          // ← 刷新失败也先返回旧凭据，让请求自己去碰 401
    }
    self.auth_cached()
}
```

"该不该主动刷新"由 `should_refresh_proactively`（`manager.rs:2884-2906`）决定：解开 access_token 的 JWT 读 `exp`，如果距过期不足 5 分钟（`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES`，`manager.rs:186`）就刷；解不出 exp 则退化为"距上次刷新超过 8 天"的保守策略。注意这只在 `Chatgpt` 变体上做——API key 没有过期概念，直接短路（`refresh_token` 开头的早退，`manager.rs:2740-2746`）。

**刷新的并发与多进程安全**是这段代码最有意思的部分：

```rust
// 来源：codex-rs/login/src/auth/manager.rs:2733-2766（有删节）
pub async fn refresh_token(&self) -> Result<(), RefreshTokenError> {
    let _refresh_guard = self.refresh_lock.acquire().await?;  // ← 进程内串行化

    let auth_before_reload = self.auth_cached();
    // ... API key 直接返回
    let expected_account_id = auth_before_reload
        .as_ref()
        .and_then(CodexAuth::get_account_id);

    match self
        .reload_if_account_id_matches(expected_account_id.as_deref())
        .await
    {
        ReloadOutcome::ReloadedChanged => {
            // ← 磁盘上的凭据已被别的进程换新，直接用新的，不用刷
            tracing::info!("Skipping token refresh because auth changed after guarded reload.");
            Ok(())
        }
        ReloadOutcome::ReloadedNoChange => self.refresh_token_from_authority_impl().await,
        ReloadOutcome::Skipped => Err(/* 账号对不上，视为永久失败 */),
    }
}
```

为什么拿到锁之后还要先 `reload`？因为**你可能同时开着两个 Codex 进程**（比如 TUI 和 IDE 扩展），它们共享同一份 auth.json。进程 A 刚刷完写盘，进程 B 的内存缓存就过期了。B 拿到刷新锁后先重读磁盘：如果磁盘上的凭据已经变了（A 刷过了），直接采纳，避免用旧 refresh token 再刷一次——OAuth 服务通常把 refresh token 设计成一次性轮换，重复用旧 token 刷新会被判为 `refresh_token_reused` 导致双双登出。这层防御在 error 分类里也有体现：`classify_refresh_token_failure`（`manager.rs:1606-1635`）把 `refresh_token_expired / reused / invalidated` 都归为**永久失败**，只有网络抖动这类才归为**可重试的临时失败**。

真正的刷新请求在 `request_chatgpt_token_refresh`（`manager.rs:1553-1604`）：POST `{client_id, grant_type: "refresh_token", refresh_token}` 到 token 端点，成功后新三元组写回存储。`CLIENT_ID` 是硬编码的 OAuth 客户端 ID `app_EMoamEEZ73f0CkXaXp7hrann`（`manager.rs:1678`）——公开客户端的 client_id 本来就不是秘密。

**注入请求头**发生在每次请求发出前，接缝是 `codex-api` 里的 `AuthProvider` trait：

```rust
// 来源：codex-rs/codex-api/src/auth.rs:26-70（有删节）
/// Applies authentication to API requests.
pub trait AuthProvider: Send + Sync {
    /// Adds any auth headers that are available without request body access.
    fn add_auth_headers(&self, headers: &mut HeaderMap);

    /// Resolves auth headers for an outbound request.
    /// ... implementations may perform asynchronous work to refresh
    /// credentials before returning.
    fn resolve_auth_headers(&self) -> AuthHeadersFuture<'_> {
        Box::pin(async { Ok(self.to_auth_headers()) })
    }

    /// Applies auth to a complete outbound request and returns the request to send.
    fn apply_auth(&self, request: Request) -> AuthProviderFuture<'_> {
        Box::pin(async move {
            let mut request = request;
            request.headers.extend(self.resolve_auth_headers().await?);
            Ok(request)
        })
    }
}
```

设计意图写在注释里：header 型认证用默认实现即可；**需要给整个请求签名**的认证（比如 AWS SigV4 要读 body）可以 override `apply_auth`。调用点在传输层 `EndpointSession::stream_encoded_json_with`（`codex-rs/codex-api/src/endpoint/session.rs:139-152`）：每次发送前 `auth.apply_auth(req).await`，然后才交给 transport。

`AuthManager` 与 `AuthProvider` 之间的桥是 `AuthManagerAuthProvider`（`codex-rs/model-provider/src/auth.rs:126-169`）——它的 `resolve_auth_headers` 每次都回 `auth_manager.auth().await` 取**当前快照**，所以刷新后的新 token 会自动被下一次请求用上，无需重启。ChatGPT 账号除了 `Authorization: Bearer` 还会带 `ChatGPT-Account-ID` 头（`model-provider/src/auth.rs:105-107`），因为同一用户可能属于多个 workspace，服务端要靠它路由。

**401 的闭环**在 core 侧完成。`stream_responses_api`（`core/src/client.rs:1462-1586`）的请求循环里，`ApiError::Transport` 且被判定为可恢复认证错误时，进入 `handle_unauthorized`（`client.rs:2257-2399`）：先给 provider 自己一次恢复机会（`provider.recover_from_unauthorized()`，比如命令型凭据重新执行命令），再走 `AuthManager` 的 `UnauthorizedRecovery` 状态机刷新 token，然后 `continue` 重发整个请求。刷新结果是永久失败才向上抛 `CodexErr::RefreshTokenFailed`——TUI 会据此提示重新登录。

### 4.3 Provider 抽象：一份声明，处处可用

第 3 章讲过 `config.toml` 的加载；`model_providers` 表里的每一项最终都解析成 `ModelProviderInfo`。它与内置项合并的逻辑在 `merge_configured_model_providers`（`model-provider-info/src/lib.rs:541-581`）：内置 provider 原则上不可被覆盖，Bedrock 是特例（只允许改 `base_url`/`auth` 等白名单字段）；用户的新 provider 用 `entry().or_insert()` 并入。内置清单在 `built_in_model_providers`（`lib.rs:502-534`）：OpenAI、两个 Amazon Bedrock 变体、Ollama、LM Studio。注释说得很直白——"我们不做第三方 provider 的裁判"，第三方全部留给用户配置。

声明式配置要成为"能发请求的对象"，经过两次转换。第一次是 `create_model_provider`（`codex-rs/model-provider/src/provider.rs:308-317`）：

```rust
// 来源：codex-rs/model-provider/src/provider.rs:307-317
/// Creates the default runtime model provider for configured provider metadata.
pub fn create_model_provider(
    provider_info: ModelProviderInfo,
    auth_manager: Option<Arc<AuthManager>>,
) -> SharedModelProvider {
    if provider_info.is_amazon_bedrock() {
        Arc::new(AmazonBedrockModelProvider::new(provider_info, auth_manager))
    } else {
        Arc::new(ConfiguredModelProvider::new(provider_info, auth_manager))
    }
}
```

第二次是 `ModelProviderInfo::to_api_provider`（`model-provider-info/src/lib.rs:292-334`），把声明折叠成 `codex-api` 的传输层配置 `Provider`（`codex-api/src/provider.rs:43-50`，只有 base_url、headers、query_params、retry、stream_idle_timeout 六个字段）。这里有个容易忽略的分叉（`lib.rs:293-306`）：

```rust
// 来源：codex-rs/model-provider-info/src/lib.rs:293-310（有删节）
let default_base_url = if matches!(
    auth_mode,
    Some(
        AuthMode::Chatgpt
            | AuthMode::ChatgptAuthTokens
            | AuthMode::Headers
            | AuthMode::AgentIdentity
            | AuthMode::PersonalAccessToken
    )
) {
    CHATGPT_CODEX_BASE_URL          // ← "https://chatgpt.com/backend-api/codex"
} else {
    "https://api.openai.com/v1"     // ← API key 走公开 API
};
```

**同样叫 "OpenAI"，ChatGPT 登录和 API key 打到的是不同端点**。这就是为什么 provider 抽象必须感知 auth_mode——`to_api_provider(auth_mode)` 的参数不是可选装饰，而是路由输入。

### 4.4 发出流式请求：ModelClient 的组装线

`ModelClient` 是 core 侧的模型门面，会话级创建一次（`core/src/client.rs:255-260`、构造在 `client.rs:430-475`）：构造时 `create_model_provider(provider_info, auth_manager)` 把 provider 声明和凭据总管绑在一起（`client.rs:445`）。每个回合（turn）再从它派生一个 `ModelClientSession`（`client.rs:503-509`）——回合级状态（如服务端下发的 `x-codex-turn-state` 粘性路由 token，存在 `OnceLock` 里）都挂在 session 上，回合结束即弃。

发请求的入口是 `ModelClientSession::stream`（`client.rs:1883-1934`）：

```rust
// 来源：codex-rs/core/src/client.rs:1883-1934（有删节）
pub async fn stream(
    &mut self,
    prompt: &Prompt,
    model_info: &ModelInfo,
    // ...
) -> Result<ResponseStream> {
    let wire_api = self.client.state.provider.info().wire_api;
    match wire_api {
        WireApi::Responses => {
            if self.client.responses_websocket_enabled() {
                // ← 优先尝试 Responses-over-WebSocket，失败可回退 HTTP
                match self.stream_responses_websocket(/* ... */).await? {
                    WebsocketStreamOutcome::Stream(stream) => return Ok(stream),
                    WebsocketStreamOutcome::FallbackToHttp => {
                        self.try_switch_fallback_transport(session_telemetry, model_info);
                    }
                }
            }
            self.stream_responses_api(/* ... */).await   // ← HTTP + SSE 主路径
        }
    }
}
```

本基线上 WebSocket 传输已存在（provider 声明里的 `supports_websockets`），但 HTTP+SSE 仍是主路径和兜底，本书聚焦后者。

HTTP 路径 `stream_responses_api`（`client.rs:1462-1586`）做的事按顺序是：解析当前认证与 provider（`current_client_setup`，`client.rs:991-1009`）→ 构造请求体 → 组装 `ResponsesClient` → `stream_request` → 成功后用 `map_response_stream` 把 API 层流包装成 core 层流；遇 401 走 4.2 节的恢复循环。

请求体构造在 `build_responses_request`（`client.rs:867-963`），结尾处拼装 `ResponsesApiRequest`：

```rust
// 来源：codex-rs/core/src/client.rs:944-962
let prompt_cache_key = Some(self.prompt_cache_key(responses_metadata));
let service_tier = model_info.service_tier_for_request(service_tier);
let request = ResponsesApiRequest {
    model: model_info.slug.clone(),
    instructions,
    input,
    tools,
    tool_choice: "auto".to_string(),
    parallel_tool_calls: prompt.parallel_tool_calls && !model_info.use_responses_lite,
    reasoning: Some(reasoning),
    store: false,                    // ← 不让服务端存响应；历史完全由客户端维护
    stream: true,
    stream_options,
    include,
    service_tier,
    prompt_cache_key,
    text,
    client_metadata: Some(responses_metadata.client_metadata()),
};
```

`store: false` 与 `prompt_cache_key` 是一对值得对照的字段。前者意味着 Codex **不使用** Responses API 的服务端会话存储——每回合都把完整历史重新发上去（这也正是"上下文只增不改"原则的要求，见[第 8 章](ch08-context-compact.md)）。那重复前缀的推理开销怎么办？靠 **Prompt Caching**：`prompt_cache_key()`（`client.rs:485-497`）默认取 `responses_metadata.session_id`——同一会话的连续请求带着相同的 cache key 和不断增长的前缀，服务端命中缓存，省掉前缀部分的重复计算。缓存命中量会随 `response.completed` 事件的 usage 回来（见 4.5 的 `cached_input_tokens`）。

请求到达传输层，`ResponsesClient::stream_request`（`codex-api/src/endpoint/responses.rs:70-98`）补上会话类 header（`x-client-request-id` 等），`stream_encoded`（`endpoint/responses.rs:128-163`）做最后一步：

```rust
// 来源：codex-rs/codex-api/src/endpoint/responses.rs:140-162（有删节）
let stream_response = self
    .session
    .stream_encoded_json_with(
        Method::POST,
        Self::path(),              // ← "responses"
        extra_headers,
        Some(body),
        |req| {
            req.headers.insert(
                http::header::ACCEPT,
                HeaderValue::from_static("text/event-stream"),  // ← 声明要 SSE
            );
            req.compression = request_compression;
        },
    )
    .await?;

Ok(spawn_response_stream(
    stream_response,
    self.session.provider().stream_idle_timeout,   // ← 默认 300 秒
    self.sse_telemetry.clone(),
    turn_state,
))
```

到这里 HTTP POST 已发出，拿到的是一个字节流响应。注意这个函数**立即返回**——解析发生在后台任务里。

### 4.5 SSE 解析：从字节流到 ResponseEvent

`spawn_response_stream`（`codex-api/src/sse/responses.rs:34-100`）是整个解析层的入口，它先做三件"响应头级别"的事，再 spawn 后台任务转字节流：

```rust
// 来源：codex-rs/codex-api/src/sse/responses.rs:34-100（有删节）
pub fn spawn_response_stream(
    stream_response: StreamResponse,
    idle_timeout: Duration,
    telemetry: Option<Arc<dyn SseTelemetry>>,
    turn_state: Option<Arc<OnceLock<String>>>,
) -> ResponseStream {
    let rate_limit_snapshots = parse_all_rate_limits(&stream_response.headers);
    // ... 从响应头提取 server_model / x-request-id / X-Models-Etag
    if let Some(turn_state) = turn_state.as_ref()
        && let Some(header_value) = stream_response
            .headers
            .get(X_CODEX_TURN_STATE_HEADER)
            .and_then(|value| value.to_str().ok())
    {
        let _ = turn_state.set(header_value.to_string());  // ← 回合粘性路由 token 落袋
    }
    let (tx_event, rx_event) = mpsc::channel::<Result<ResponseEvent, ApiError>>(1600);
    tokio::spawn(async move {
        // 先把响应头里的事件（ServerModel / RateLimits / ...）发出去
        process_sse_with_treatment(stream_response.bytes, tx_event, ...).await;
    });

    ResponseStream { rx_event, upstream_request_id }
}
```

设计要点：**解析器与消费方用 mpsc channel 解耦**（容量 1600），消费方看到的是一个实现了 `futures::Stream` 的 `ResponseStream`。TUI 渲染增量文本的速度和网速天然解耦；channel 满了会自然背压。core 侧还有第二层 channel（`map_response_events`，`core/src/client.rs:2031-2082`），边转发边记录本回合新增条目、统计 TTFT（首 token 时间）等遥测——两层 channel 各管一摊。

解析主循环 `process_sse_with_treatment`（`sse/responses.rs:541-652`）：

```rust
// 来源：codex-rs/codex-api/src/sse/responses.rs:548-594（有删节）
let mut stream = stream.eventsource();     // ← eventsource-stream crate 处理 SSE 帧切分
let mut response_error: Option<ApiError> = None;

loop {
    let response = timeout(idle_timeout, stream.next()).await;  // ← 空闲超时守门
    let sse = match response {
        Ok(Some(Ok(sse))) => sse,
        Ok(None) => {
            // ← 流在 response.completed 之前就关了：把之前记下的错误发出去
            let error = response_error.unwrap_or(ApiError::Stream(
                "stream closed before response.completed".into(),
            ));
            let _ = tx_event.send(Err(error)).await;
            return;
        }
        Err(_) => {
            let _ = tx_event
                .send(Err(ApiError::Stream("idle timeout waiting for SSE".into())))
                .await;
            return;
        }
        // ...
    };

    let event: ResponsesStreamEvent = match serde_json::from_str(&sse.data) {
        Ok(event) => event,
        Err(e) => {
            debug!(/* ... */ "Failed to parse SSE event");
            continue;                     // ← 单条事件解析失败不致命，跳过继续
        }
    };
    // ...
}
```

三条防线各管一种故障：`timeout(idle_timeout, ...)` 管"流没断但半天不来数据"（默认 300 秒，provider 可配）；`Ok(None)` 管"流提前关闭"；JSON 解析失败只记 debug 日志后 `continue`——服务端随时可能新增事件字段，客户端不该因此崩掉整个回合。

每条 SSE 事件的 `data` 先被反序列化成 `ResponsesStreamEvent`（`sse/responses.rs:163-179`）——一个"线上所有事件类型的并集"结构体，字段几乎全是 `Option`：`kind`（即线上的 `type` 字段）、`delta`、`item`、`response`、`summary_index`……然后 `process_responses_event`（`sse/responses.rs:348-522`）按 `kind` 做模式匹配，翻译成 `ResponseEvent`：

```rust
// 来源：codex-rs/codex-api/src/sse/responses.rs:351-407（有删节）
match event.kind.as_str() {
    "response.output_item.done" => {
        if let Some(item_val) = event.item {
            if let Ok(item) = serde_json::from_value::<ResponseItem>(item_val) {
                return Ok(Some(ResponseEvent::OutputItemDone(item)));  // ← 完整条目
            }
        }
    }
    "response.output_text.delta" => {
        if let Some(delta) = event.delta {
            return Ok(Some(ResponseEvent::OutputTextDelta(delta)));    // ← 文本增量
        }
    }
    "response.created" => {
        if event.response.is_some() {
            return Ok(Some(ResponseEvent::Created {}));
        }
    }
    // ... reasoning 摘要增量、工具调用增量等
}
```

注意两个层次的"增量 vs 完整"：`response.output_text.delta` 是逐片段的文本（喂给 UI 做打字机效果），`response.output_item.done` 是整条 item 的最终形态（进历史、驱动工具调度）。Agent Loop 主要靠 `OutputItemDone` 工作，UI 主要靠 `*Delta` 工作——一条流同时服务两种消费者。

**终止与用量**在 `response.completed`（`sse/responses.rs:464-481`）：反序列化成内部的 `ResponseCompleted` 结构，usage 转成 `TokenUsage`（`sse/responses.rs:133-149`）：

```rust
// 来源：codex-rs/codex-api/src/sse/responses.rs:133-148
impl From<ResponseCompletedUsage> for TokenUsage {
    fn from(val: ResponseCompletedUsage) -> Self {
        let input_tokens_details = val.input_tokens_details.unwrap_or_default();
        TokenUsage {
            input_tokens: val.input_tokens,
            cached_input_tokens: input_tokens_details.cached_tokens,  // ← 缓存命中量
            cache_write_input_tokens: input_tokens_details.cache_write_tokens,
            output_tokens: val.output_tokens,
            reasoning_output_tokens: val
                .output_tokens_details
                .map(|d| d.reasoning_tokens)
                .unwrap_or(0),
            total_tokens: val.total_tokens,
            // ...
        }
    }
}
```

4.4 节发出去的 `prompt_cache_key` 在这里得到回声：`cached_input_tokens` 就是本次请求命中缓存的 token 数。TUI 底部的 token 统计、第 8 章压缩决策的依据，都源于这个结构。

**错误不是字符串，是分类。** `response.failed` 事件（`sse/responses.rs:408-452`）会把服务端错误归进 `ApiError` 的具体变体：上下文超限（`ContextWindowExceeded`，Agent Loop 据此触发压缩）、配额耗尽（`QuotaExceeded`）、`Retryable { delay }`（带 Retry-After 解析，`sse/responses.rs:654-678`）等。上层不需要解析错误文案做判断——这是"传输层把线上协议磨平成领域模型"的最后一块。

整个 4.4–4.5 的调用链收拢成一张图：

```
ModelClientSession::stream()              core/src/client.rs:1883
   │
   ▼
stream_responses_api()  ──loop──►  401? handle_unauthorized() → 刷新后重试
   │                                   client.rs:1462 / 2257
   ▼
build_responses_request()                 client.rs:867
   │  Prompt → ResponsesApiRequest；prompt_cache_key = session_id
   ▼
ResponsesClient::stream_request()         codex-api/endpoint/responses.rs:70
   │  EndpointSession: apply_auth() 注入 Authorization 等头
   ▼
POST {base_url}/responses  (Accept: text/event-stream)
   │
   ▼
spawn_response_stream()                   codex-api/sse/responses.rs:34
   │  响应头 → RateLimits / turn_state / request_id
   ▼
process_sse_with_treatment()  ──loop──►   sse/responses.rs:541
   │  idle 超时 / 断流 / 解析失败 三道防线
   ▼
process_responses_event()                 sse/responses.rs:348
   │  response.output_text.delta  → OutputTextDelta
   │  response.output_item.done   → OutputItemDone(ResponseItem)
   │  response.completed          → Completed { token_usage }
   │  response.failed             → ApiError 分类
   ▼
mpsc channel ──► ResponseStream ──► map_response_events (core 遥测/记录)
   │
   ▼
Agent Loop 消费（第 7 章）；UI 消费增量（第 14 章）
```

## 设计取舍

**为什么登录用"本地 HTTP 服务 + PKCE"，而不是嵌入式浏览器或手动粘贴？** 桌面 CLI 拿不到安全的客户端密钥，OAuth 公开客户端 + PKCE 是唯一标准答案；在 localhost 起临时 HTTP 服务接回调，比让用户手动复制粘贴授权码少一步、少一类错误。代价是代码里出现了一个迷你 Web 服务器（`server.rs` 1300 行）和无浏览器环境走不通的死角——所以才有设备码流程（`device_code_auth.rs`）兜底。my-agent 是 Node 进程，完全可以照抄这个模式：`http.createServer` 监听随机端口 + 相同的 PKCE 公式，不需要任何框架。

**为什么刷新要做成"惰性 + 守卫式重载"？** 对照 my-agent 的典型写法：凭据是启动时读一次的常量，401 了报个错就完事。Codex 面对的是"OAuth token 会过期 + 多进程共享凭据文件 + 长会话可能跑几小时"的组合。它的答案是三层：`auth()` 每次取用前检查是否临近过期（惰性，避免后台定时器）；`Semaphore(1)` 保证进程内不并发刷新；拿到锁后先 `reload` 比对磁盘（守卫，避免多进程重复刷新导致 refresh token 轮换冲突）。这套机制比"启动时读一次"复杂一个量级，但每一层都对应一个真实故障模式。如果你的 my-agent 只跑单进程短会话，照搬全套是过度设计——**先加"401 时刷新重试一次"这最低一层就够了**，其余等遇到再加。

**多 provider 靠什么抽象？** my-agent 里常见的做法是 `if (provider === 'openai') ... else if (provider === 'ollama') ...` 散在请求代码里。Codex 的判断更激进：既然大家都（被迫或自愿）说 Responses API，那就不抽象"协议"，只抽象"端点配置 + 认证 + 重试策略"——`ModelProviderInfo` 一张声明表，`WireApi` 只剩一个变体。换来的是传输层零分支，以及 `chat` wire_api 这种历史包袱可以干脆删掉。局限也明显：想接一家不说 Responses API 的模型服务，今天没有干净的扩展点（Anthropic 风格 API 就塞不进来）。这是一个"用收敛换简单"的赌注，赌的是 OpenAI 系协议的事实标准地位。

**SSE 为什么走 channel 而不是直接回调/迭代器？** TS 里你会写 `for await (const line of readlines(stream))`，处理逻辑和 IO 缠在一起。Codex 把"字节流 → 事件"放进后台任务，用 mpsc channel 递给消费方：解析失败、限流事件、响应头事件都能作为普通元素流过同一条管道；消费方慢时 channel 满形成背压；消费方提前放弃时 `ResponseStream` 的 `Drop` 会 cancel `consumer_dropped` token（`client_common.rs:120-124`），后台任务随之退出（`client.rs:2061-2069`），不会泄漏一个对着空气解析的任务。**增量（`*Delta`）与完整条目（`OutputItemDone`）同流并发**这一点也值得借鉴：UI 和 Agent Loop 各取所需，不必为两种消费者开两条流。

**局限与演进**：HTTP+SSE 每回合一次连接、重新发全量历史，延迟和流量都有代价——这正是 Responses-over-WebSocket 传输（`responses_websocket.rs`、`WebsocketSession` 的连接复用与增量请求）在本基线上已经在推进的原因。本章讲的 SSE 路径仍是默认与兜底，但如果你在写自己的 Agent，可以跳过 SSE 直接评估长连接方案。

## 动手实验

观察凭据文件的形态（注意脱敏，别把内容贴给任何人）：

```shell
cat ~/.codex/auth.json | jq 'keys'
# 预期输出形态（ChatGPT 登录后）：
# [ "OPENAI_API_KEY", "auth_mode", "last_refresh", "tokens" ]
jq '.tokens | keys' ~/.codex/auth.json
# 预期： [ "access_token", "account_id", "id_token", "refresh_token" ]
```

确认内置 provider 清单与默认值：

```shell
cd codex-rs
rg -n "built_in_model_providers" model-provider-info/src/lib.rs
# 预期：定位到 lib.rs:502 附近的函数，逐个看 openai / amazon-bedrock / ollama / lmstudio 的字段差异
rg -n "DEFAULT_STREAM_IDLE_TIMEOUT_MS|DEFAULT_STREAM_MAX_RETRIES|DEFAULT_REQUEST_MAX_RETRIES" model-provider-info/src/lib.rs
# 预期输出：300_000（5 分钟空闲超时）、5 次流重连、4 次请求重试
```

跑一次最小请求并观察传输层日志（需要已登录或设了 `OPENAI_API_KEY`）：

```shell
cargo run --bin codex -- exec "say hi" 2>&1 | head -30
# 加日志看 SSE 解析细节（原始事件 payload 会逐条打印）：
RUST_LOG=codex_api=debug,codex_api::sse=trace cargo run --bin codex -- exec "say hi" 2>&1 | rg "SSE event|responses"
# 预期：能看到 "SSE event: {\"type\":\"response.created\"...}"、
#   一串 response.output_text.delta、最后 response.completed 含 usage 字段
```

亲手感受 SSE 的线上格式（需要 API key）：

```shell
curl -N https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-5", "input": "say hi", "stream": true}' | head -40
# 预期：一段段 "event: response.xxx" + "data: {...}" 的文本块；
# 对照 sse/responses.rs:348 的 match 分支逐个认出它们
```

追踪一次 token 刷新的代码路径（纯阅读练习）：

```shell
rg -n "should_refresh_proactively" login/src/auth/manager.rs
rg -n "refresh_token_reused|RefreshTokenFailedReason" login/src/auth/manager.rs | head
# 预期：找到 2884 行的判定函数与 1606 行的失败分类函数，
# 自己推一遍"临近过期 → 加锁 → reload 比对 → 刷新 → 写盘"的完整路径
```

## Rust 侧栏

- **`OnceLock<T>`**：只能写入一次的单元格，`set` 成功后 `get` 随时可读。`x-codex-turn-state` 粘性路由 token 用它存（`client.rs:288`）：回合内第一次响应到达时写入，之后所有请求重放，且保证不会被二次覆盖。
- **`Semaphore::new(1)` 当异步互斥锁**：`refresh_lock.acquire().await` 拿到的 guard 在离开作用域时自动归还许可。与 `Mutex` 的区别是没有"受保护的数据"，纯粹做并发计数——这里用来保证全进程同时最多一个刷新在飞。
- **`tokio::sync::mpsc` 与 `Stream` 的适配**：`mpsc::Receiver` 本身不是 `futures::Stream`，`client_common.rs:112-118` 手动实现 `poll_next` 转调 `poll_recv` 完成适配——这是手写 `Stream` 的最小样板：一个 `poll_next` 方法而已。
- **`#[serde(skip_serializing_if = "Option::is_none")]`**：`None` 字段直接不出现在 JSON 里。`ResponsesApiRequest` 大量使用，保证请求体最小化；配合 `#[serde(rename_all = "...")]` 控制线上字段命名风格。
- **`Arc<dyn AuthProvider>`**：trait 对象。`AuthProvider` 有泛型无关的多个实现（API key、ChatGPT、header、无认证……），调用方只想统一地 `apply_auth(req)`，`Arc<dyn ...>` 抹掉具体类型。代价是一次动态分发，对每回合几次的调用频率完全无所谓。
- **let-chain（`if let ... && let ...`）**：如 `sse/responses.rs:62-69`、`manager.rs:2894-2899`，把多层 `if let` 压成一行条件，本仓库（较新 Rust edition）大量使用，读源码时见到不要意外。

## 小结 + 思考题

本章走完了"从登录到流式响应"的完整链路：`codex login` 用本地 HTTP 回调 + PKCE 完成 ChatGPT OAuth，凭据以 `AuthDotJson` 落盘（文件/钥匙串/内存三后端）；运行时 `AuthManager` 缓存凭据、惰性刷新、401 时守卫式恢复；provider 层用 `ModelProviderInfo` 一份声明吸收多端点差异，统一折叠成传输层 `Provider`；`ModelClient` 把 `Prompt` 组装成 `ResponsesApiRequest`（含 `prompt_cache_key`），POST 到 `/responses` 后由 SSE 解析器把字节流翻译成 `ResponseEvent` 流，经 mpsc channel 交给上层。

思考题：

1. `refresh_token` 里"拿到锁之后先 reload 比对磁盘"防的是什么故障？如果两个进程同时用同一个旧 refresh token 刷新，服务端会怎样惩罚（提示：`manager.rs:1606-1635` 的分类）？
2. `WireApi` 只剩 `Responses` 一个变体，为什么还保留这个枚举而不是删掉？（提示：想一个它仍在编译期提供的保证。）
3. 如果 my-agent 要支持"会话内 token 自动续期"，最小改动是哪几处？哪些 Codex 机制（Semaphore、reload 守卫、永久失败分类）可以暂时不做？
4. `process_sse_with_treatment` 对单条事件 JSON 解析失败选择 `continue`，对 `response.failed` 却向上抛错——两种"失败"的区别是什么？这个边界划得合理吗？

下一章：[第 5 章](ch05-protocol.md)，把本章反复出现却未展开的 `ResponseItem` / `EventMsg` 数据模型一次讲透。
