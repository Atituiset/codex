# 第 5 章 协议层：Thread / Item / Event 数据模型

## 本章导读

第 1 章说过，Codex 的四种产品形态共享同一个内核，内核与外壳之间只靠两类消息通信：`Op` 与 `EventMsg`。本章把那张示意草图展开成真实定义，并回答一个每个自建 Agent 的人都会遇到的问题：**内核和 UI 之间的边界到底应该长什么样？**

如果你写过 my-agent 那样的 TypeScript Agent，你的内核/UI 边界大概率是这样的：Agent loop 是一个 async 函数，构造时注入一组回调——`onText(delta)`、`onToolCall(call)`、`onApprovalNeeded(req)`。单进程、单前端时这完全够用。但 Codex 的处境不同：它的事件消费者不止 TUI，还有跨进程的 IDE 扩展（app-server）、CI 里的 exec、乃至把 Codex 当工具调用的另一个 Agent。回调函数穿不过进程边界，也写不进 JSONL 文件——于是回调必须「降维」成**可序列化的数据**。`codex-protocol` 这个 crate 就是这些数据的全部定义。

这个 crate 最反直觉的特点是：**它几乎不含逻辑**。一万多行代码里 95% 是结构体、枚举和 serde 标注。这不是偷懒，而是深思熟虑的解耦——本章「设计取舍」一节会论证，为什么协议层越「笨」，整个系统越稳。

读完本章，你应该能回答：Op 与 EventMsg 为什么是两个枚举而不是一个；`ResponseItem` 与 OpenAI Responses API 的 wire format 是什么关系；为什么 `EventMsg` 膨胀到 81 个变体仍然没有拆掉。

## 源码地图

`codex-protocol` crate 位于 `codex-rs/protocol/`，本章涉及的文件：

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-rs/protocol/src/lib.rs` | crate 导出面，47 行 | 全是 `pub mod` / `pub use`，零逻辑，本身就是设计声明 |
| `codex-rs/protocol/src/protocol.rs` | `Op` / `Event` / `EventMsg` / `SandboxPolicy` / `ReviewDecision` 等 | 6039 行，全 crate 最大的文件，事件总线的双面 |
| `codex-rs/protocol/src/models.rs` | `ResponseItem` / `ResponseInputItem` / `ContentItem` | 与 Responses API wire format 同构的一层 |
| `codex-rs/protocol/src/items.rs` | `TurnItem` 及各类条目结构体 | 面向 UI 的「一个回合里有什么」视图 |
| `codex-rs/protocol/src/approvals.rs` | `ExecApprovalRequestEvent` 等审批载荷 | 审批协议的请求半边，回应半边在 `Op` 里 |
| `codex-rs/protocol/src/user_input.rs` | `UserInput` 枚举 | 用户输入不只是字符串：文本/图片/音频/skill/mention |
| `codex-rs/protocol/src/turn_input.rs` | `TurnInput` / `TurnInputRequest` | 本基线上「开始一个回合」的入口载荷 |
| `codex-rs/protocol/src/legacy_events.rs` | `HasLegacyEvent` 转换层 | 新条目模型向旧事件流的回译，兼容性的化石层 |

crate 的「身份证」也值得一看（`codex-rs/protocol/Cargo.toml`）：包名 `codex-protocol`，依赖里最主要的就是 `serde`、`schemars`（JSON Schema 生成）、`ts-rs`（TypeScript 类型生成）三件套——这个 crate 的存在意义就是让同一份 Rust 定义同时流向三条下游：JSON wire format、JSON Schema、TS SDK。

反向看依赖更能说明地位：`rg -l "codex-protocol" codex-rs/*/Cargo.toml` 能列出 55 个 crate——`core`、`tui`、`exec`、`app-server-*`、`rollout`、`tools`、`mcp-server` 全部依赖它。它是整个 workspace 里被依赖最广的 crate 之一，而它对 workspace 内其它业务 crate 的依赖几乎为零。依赖方向是严格单向的：**所有人都知道协议，协议不知道任何人**。

## 核心数据结构

### Event 与 EventMsg：内核向外说的话

外壳从内核收到的东西，类型是 `Event`：

```rust
// 来源：codex-rs/protocol/src/protocol.rs:1276-1283
/// Event Queue Entry - events from agent
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Event {
    /// Submission `id` that this event is correlated with.
    pub id: String,        // ← 与提交时的 submission id 对应，用于把事件归因到某次 Op
    /// Payload
    pub msg: EventMsg,     // ← 真正的载荷
}
```

`Event` 只是个信封，正文是 `EventMsg`——本基线上有 **81 个变体**（protocol.rs:1296-1506）。节选最具代表性的几个：

```rust
// 来源：codex-rs/protocol/src/protocol.rs:1290-1506（节选，变体有删节）
/// Response event from the agent
/// NOTE: Make sure none of these values have optional types, as it will mess up the extension code-gen.
#[derive(Debug, Clone, Deserialize, Serialize, Display, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]   // ← 序列化为 {"type": "turn_started", ...}
#[ts(tag = "type")]
#[strum(serialize_all = "snake_case")]
pub enum EventMsg {
    /// Error while executing a submission
    Error(ErrorEvent),

    /// Conversation history was compacted (either automatically or manually).
    ContextCompacted(ContextCompactedEvent),

    /// Agent has started a turn.
    /// v1 wire format uses `task_started`; accept `turn_started` for v2 interop.
    #[serde(rename = "task_started", alias = "turn_started")]  // ← 线上格式兼容 v1/v2 两种名字
    TurnStarted(TurnStartedEvent),

    /// Agent has completed all actions.
    #[serde(rename = "task_complete", alias = "turn_complete")]
    TurnComplete(TurnCompleteEvent),

    /// Agent text output message
    AgentMessage(AgentMessageEvent),

    /// Notification that the server is about to execute a command.
    ExecCommandBegin(ExecCommandBeginEvent),

    /// Incremental chunk of output from a running command.
    ExecCommandOutputDelta(ExecCommandOutputDeltaEvent),

    ExecApprovalRequest(ExecApprovalRequestEvent),  // ← 审批请求，UI 弹窗的数据来源

    ItemStarted(ItemStartedEvent),    // ← 条目级生命周期事件，载荷是 TurnItem
    ItemCompleted(ItemCompletedEvent),

    AgentMessageContentDelta(AgentMessageContentDeltaEvent),  // ← 流式文本增量
    // ...（共 81 个变体）
}
```

注意三件事：

1. **`#[serde(tag = "type", rename_all = "snake_case")]`**：序列化后每个事件都是 `{"type": "xxx_yyy", ...}` 形状的 JSON 对象。这就是 exec `--json` 模式输出的每一行，也是 app-server 推给 IDE 的通知形态。
2. **顶部那行 NOTE 注释**（protocol.rs:1291）：「不要给这些值加可选类型，会搞坏扩展代码生成」。事件流是对外 API 面，字段形态受代码生成管线约束——协议层的每一个字段都有下游消费者，改它不是重构，是发版。
3. **`rename` + `alias`**：v1 线上叫 `task_started`，v2 改叫 `turn_started`，serde 序列化时写旧名、反序列化时两个都收。协议演进不靠 breaking change，靠注解层消化。

### Op：外界向内下的指令

反方向是 `Op`（protocol.rs:541-705），本基线上 **28 个变体**：

```rust
// 来源：codex-rs/protocol/src/protocol.rs:541-705（节选，变体有删节）
/// Submission operation
#[derive(Debug)]
#[allow(clippy::large_enum_variant)]
#[non_exhaustive]              // ← 禁止下游 exhaustive match，给未来加变体留路
pub enum Op {
    /// Abort current task without terminating background terminal processes.
    /// This server sends [`EventMsg::TurnAborted`] in response.
    Interrupt,                 // ← Esc 打断当前回合

    /// Submit turn input using the requested routing behavior.
    TurnInput {
        request: Box<TurnInputRequest>,
        mode: TurnInputMode,
        reply: oneshot::Sender<CodexResult<TurnInputSubmission>>,  // ← 关键：带回信通道
    },

    /// Approve a command execution
    ExecApproval {
        /// The id of the submission we are approving
        id: String,
        /// Turn id associated with the approval event, when available.
        turn_id: Option<String>,
        /// The user's decision in response to the request.
        decision: ReviewDecision,
    },

    /// Request the agent to summarize the current conversation context.
    Compact,                   // ← 手动触发上下文压缩（详见第 8 章）

    /// Request to shut down codex instance.
    Shutdown,
    // ...（共 28 个变体）
}
```

与 `EventMsg` 对比，`Op` 头上少了 `Serialize`/`Deserialize`，多了一个 `oneshot::Sender`——这是理解两个枚举「为什么分开」的第一条线索，留到「设计取舍」展开。

先看 `TurnInput` 变体的载荷。旧版协议里有 `Op::UserTurn`，本基线已经移除，提交用户输入走的是 `Op::TurnInput`，请求体定义在 `turn_input.rs`：

```rust
// 来源：codex-rs/protocol/src/turn_input.rs:28-51
/// Input consumed by a regular turn.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum TurnInput {
    UserInput {
        content: Vec<UserInput>,          // ← 一条用户消息 = 一组多模态片段
        client_id: Option<String>,
    },
    ResponseItem(ResponseItem),           // ← 也可以直接注入一条 Responses API 条目
    InterAgentCommunication(InterAgentCommunication),  // ← 多 Agent 协作时的agent间消息
}

/// One turn input and the context that follows it through submission.
#[derive(Clone, Debug)]
pub struct TurnInputRequest {
    pub input: TurnInput,
    pub thread_settings: ThreadSettingsOverrides,      // ← 随本次提交生效的线程设置覆盖
    pub start: TurnStartOptions,
    pub additional_context: BTreeMap<String, AdditionalContextEntry>,
    pub responsesapi_client_metadata: Option<HashMap<String, String>>,
    pub trace: Option<W3cTraceContext>,
}
```

`Vec<UserInput>` 意味着「用户消息」不是字符串。`UserInput` 枚举（user_input.rs:11-55）有七个变体：

```rust
// 来源：codex-rs/protocol/src/user_input.rs:11-55（节选注释）
#[non_exhaustive]
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, TS, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UserInput {
    Text {
        text: String,
        /// UI-defined spans within `text` that should be treated as special elements.
        text_elements: Vec<TextElement>,  // ← 文本里的 @文件 等富元素的占位区间
    },
    Image { image_url: String, /* detail */ .. },       // ← data: URI 图片
    LocalImage { path: std::path::PathBuf, /* .. */ },  // ← 本地图片，序列化时转 base64
    Audio { audio_url: String },
    LocalAudio { path: std::path::PathBuf },
    Skill { name: String, path: std::path::PathBuf },   // ← 用户显式选择的 skill
    Mention { name: String, path: String },             // ← app:// / plugin:// 提及
    // ...
}
```

你在 TUI 里输入「@src/main.rs 解释一下这张图 [粘贴图片]」，跨过协议边界时就是一个 `Vec<UserInput>`：`Text`（带 `text_elements` 标注 mention 区间）+ `LocalImage`。UI 负责把终端里的字符变成结构化输入，内核拿到的永远是结构化的——**解析发生在边界上，不在内核里**。

### ResponseItem：与 Responses API 同构的一层

`models.rs` 里的 `ResponseItem`（models.rs:938-1180）是全书的第二个「贯穿型」类型（第一个是 Op/EventMsg）。它定义了**对话历史里一条记录**的形状，并且刻意与 OpenAI Responses API 的 wire format 保持同构：

```rust
// 来源：codex-rs/protocol/src/models.rs:938-1180（节选，字段有删节）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponseItem {
    Message {
        id: Option<ResponseItemId>,
        role: String,
        content: Vec<ContentItem>,
        phase: Option<MessagePhase>,  // ← "commentary" / "final_answer"，区分过程叙述与最终回答
        // ...
    },
    Reasoning {
        id: Option<ResponseItemId>,
        summary: Vec<ReasoningItemReasoningSummary>,
        content: Option<Vec<ReasoningItemContent>>,
        encrypted_content: Option<String>,  // ← 加密的思维链，原样回传给 API，客户端不解密
    },
    FunctionCall {
        id: Option<ResponseItemId>,
        name: String,
        // The Responses API returns the function call arguments as a *string* that contains
        // JSON, not as an already‑parsed object. We keep it as a raw string here and let
        // Session::handle_function_call parse it into a Value.
        arguments: String,   // ← 注意：是"装着 JSON 的字符串"，不是解析好的对象
        call_id: String,
        // ...
    },
    FunctionCallOutput {
        id: Option<ResponseItemId>,
        call_id: Option<String>,
        output: FunctionCallOutputPayload,  // ← 线上是字符串或结构化 content items 二选一
        // ...
    },
    LocalShellCall { /* call_id, status, action */ .. },
    CustomToolCall { /* call_id, name, input */ .. },
    WebSearchCall { /* status, action */ .. },
    Compaction {
        encrypted_content: String,  // ← 压缩后的历史也是一条 item（详见第 8 章）
        // ...
    },
    #[serde(other)]
    Other,  // ← 兜底：API 返回了不认识的新类型时反序列化不炸
    // ...
}
```

「同构」是什么意思？看 `WebSearchCall` 变体上方源码自带的注释（models.rs:1111-1118）：

```rust
// 来源：codex-rs/protocol/src/models.rs:1111-1118（源码注释原文）
// Emitted by the Responses API when the agent triggers a web search.
// Example payload (from SSE `response.output_item.done`):
// {
//   "id":"ws_...",
//   "type":"web_search_call",
//   "status":"completed",
//   "action": {"type":"search","query":"weather: San Francisco, CA"}
// }
```

这段 JSON 是从 Responses API 的 SSE 流里原样摘出来的。把它喂给 `serde_json::from_str::<ResponseItem>`，就得到 `ResponseItem::WebSearchCall`；反过来序列化，字段名一字不差。`#[serde(tag = "type")]` 让每个变体的线上 `"type"` 值就是变体名的 snake_case——`FunctionCall` ↔ `"function_call"`，`FunctionCallOutput` ↔ `"function_call_output"`，与 API 文档逐一对齐。

同构带来的直接收益是**对话历史可以原样回传**。Agent Loop 每轮把历史发给模型时，不需要「内部表示 → API 表示」的翻译层：历史就是 `Vec<ResponseItem>`，序列化即是请求体的 `input` 数组。这也是为什么 `Reasoning` 和 `Compaction` 里存的是 `encrypted_content` 不透明字符串——Codex 不解读思维链，只负责保管并在下一轮原样交还给 API。

与 `ResponseItem` 配对的是 `ResponseInputItem`（models.rs:797-833）——发送方向上「新输入」的类型，变体更少（`Message` / `FunctionCallOutput` / `McpToolCallOutput` / `CustomToolCallOutput` / `ToolSearchOutput`），对应 API 请求里允许出现的条目种类。接收方向什么都有可能回来（所以 `ResponseItem` 变体多、还有 `Other` 兜底），发送方向只构造有限的几种——两个枚举的不对称本身就是 API 契约的镜像。

发送方向的最小单元是 `ContentItem`（models.rs:835-853）：

```rust
// 来源：codex-rs/protocol/src/models.rs:835-853（节选）
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentItem {
    InputText { text: String },
    InputImage { image_url: String, detail: Option<ImageDetail> /* .. */ },
    InputAudio { audio_url: String },
    OutputText { text: String },
}
```

到这里三条类型链汇合了：`UserInput`（边界上的用户输入）在内核里被转换成 `ContentItem`（API 输入内容），包进 `ResponseItem::Message` 进入历史——第 7 章走 Agent Loop 时会看到这个转换的调用点。

### TurnItem：面向 UI 的条目视图

`ResponseItem` 是「给模型看的」，`items.rs` 里的 `TurnItem`（items.rs:40-75）是「给用户看的」。同一个回合，两种投影：

```rust
// 来源：codex-rs/protocol/src/items.rs:40-75（节选注释）
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema)]
#[serde(tag = "type")]
#[ts(tag = "type")]
pub enum TurnItem {
    UserMessage(UserMessageItem),
    AgentMessage(AgentMessageItem),
    Plan(PlanItem),
    Reasoning(ReasoningItem),
    CommandExecution(CommandExecutionItem),   // ← 一次命令执行的完整记录
    DynamicToolCall(DynamicToolCallItem),
    CollabAgentToolCall(CollabAgentToolCallItem),
    WebSearch(WebSearchItem),
    FileChange(FileChangeItem),
    McpToolCall(McpToolCallItem),
    ContextCompaction(ContextCompactionItem),
    /// Item whose schema and lifecycle details are owned by an extension.
    Extension(ExtensionItem),   // ← 扩展自定义条目，协议层留出开放口
    // ...
}
```

以 `CommandExecutionItem` 为例（items.rs:212-250），它是 UI 渲染一条「命令执行卡片」所需的全部数据：

```rust
// 来源：codex-rs/protocol/src/items.rs:212-250（节选，字段有删节）
#[derive(Debug, Clone, Deserialize, Serialize, TS, JsonSchema, PartialEq)]
pub struct CommandExecutionItem {
    pub id: String,
    pub command: Vec<String>,               // ← argv 形式的命令
    pub cwd: PathUri,                       // ← 工作目录
    pub parsed_cmd: Vec<ParsedCommand>,     // ← 解析出的命令结构，审批展示用
    pub source: ExecCommandSource,          // ← 谁发起的：Agent? 用户的 !cmd?
    pub status: CommandExecutionStatus,     // ← InProgress/Completed/Failed/Declined
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub exit_code: Option<i32>,
    pub duration: Option<Duration>,
    pub formatted_output: Option<String>,
    // ...
}
```

对比 `ResponseItem::FunctionCall`（只有 name/arguments/call_id）就能看清两种视图的职责划分：`ResponseItem` 记录「模型说了什么、我们回了什么」，`TurnItem` 记录「这件事在用户界面上应该如何呈现」——含状态机、退出码、时长、格式化输出。事件流里的 `ItemStarted`/`ItemCompleted` 携带的就是 `TurnItem`，UI 拿到后基本不需要再向内核对账。

顺带一个命名提示：这套条目模型在 app-server 的对外 v2 API 里叫 `ThreadItem`（定义在 `app-server-protocol` crate，第 15 章展开），与 protocol crate 内部的 `TurnItem` 是同构投影关系。读源码时两个名字指代的是同一层概念，别被误导。

### 审批协议：一次跨越两个枚举的往返

审批是观察 Op/EventMsg 对偶关系的最佳样本。请求半边是 `EventMsg::ExecApprovalRequest` 的载荷（approvals.rs:225-291）：

```rust
// 来源：codex-rs/protocol/src/approvals.rs:225-291（节选，字段有删节）
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, TS)]
pub struct ExecApprovalRequestEvent {
    /// Identifier for the associated command execution item.
    pub call_id: String,
    /// Identifier for this specific approval callback.
    pub approval_id: Option<String>,  // ← 子命令审批（execve 拦截）时与 call_id 不同
    pub turn_id: String,
    /// The command to be executed.
    pub command: Vec<String>,
    pub cwd: AbsolutePathBuf,
    /// Optional human-readable reason for the approval (e.g. retry without sandbox).
    pub reason: Option<String>,
    /// Proposed execpolicy amendment that can be applied to allow future runs.
    pub proposed_execpolicy_amendment: Option<ExecPolicyAmendment>,
    /// Ordered list of decisions the client may present for this prompt.
    pub available_decisions: Option<Vec<ReviewDecision>>,  // ← 内核告诉 UI 可以展示哪些按钮
    pub parsed_cmd: Vec<ParsedCommand>,
    // ...
}
```

回应半边是 `Op::ExecApproval` 里的 `ReviewDecision`（protocol.rs:3877-3915）：

```rust
// 来源：codex-rs/protocol/src/protocol.rs:3877-3915（节选注释）
/// User's decision in response to an ExecApprovalRequest.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Display, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    /// User has approved this command and the agent should execute it.
    Approved,
    /// User has approved this command and wants to apply the proposed execpolicy
    /// amendment so future matching commands are permitted.
    ApprovedExecpolicyAmendment { proposed_execpolicy_amendment: ExecPolicyAmendment },
    /// User has approved this request and wants future prompts in the same
    /// session-scoped approval cache to be automatically approved.
    ApprovedForSession,
    /// User has denied this command and the agent should not execute it, but
    /// it should continue the session and try something else.
    Denied { rejection: String },
    /// User has denied this command and the agent should not do anything until
    /// the user's next command.
    Abort,
    // ...
}
```

注意这个设计里藏着的产品语义：「批准」不止一种。`Approved`（这次）、`ApprovedForSession`（本会话都别再问）、`ApprovedExecpolicyAmendment`（把命令前缀写进策略，以后永远放行）是三种不同半径的授权；`Denied`（换条路走）和 `Abort`（停手等我）是两种不同的拒绝。审批不是布尔值，是一个小型策略语言——第 11 章讲安全模型时会回到这里。

## 流程走读

### SQ/EQ：一条双向消息总线

`protocol.rs` 的文件头注释（protocol.rs:1-4）自己给出了最佳概括：

```rust
// 来源：codex-rs/protocol/src/protocol.rs:1-4
//! Defines the protocol for a Codex session between a client and an agent.
//!
//! Uses a SQ (Submission Queue) / EQ (Event Queue) pattern to asynchronously communicate
//! between user and agent.
```

SQ（Submission Queue）走 `Op`，EQ（Event Queue）走 `Event`。挂在这条总线两端的就是 `CodexThread` 的两个方法（第 6 章会展开它的内部）：

```rust
// 来源：codex-rs/core/src/codex_thread.rs:247-249
pub async fn submit(&self, op: Op) -> CodexResult<String> {
    self.io.submit(op).await
}

// 来源：codex-rs/core/src/codex_thread.rs:580-582
pub async fn next_event(&self) -> CodexResult<Event> {
    self.io.next_event().await
}
```

把第 1 章的全景图局部放大，协议层的位置是这样的：

```
TUI / exec / IDE(app-server)
      │                          ▲
      │ submit(Op)               │ next_event() → Event
      ▼                          │
┌─────────────────────────────────────────────┐
│  SQ (Submission Queue)      EQ (Event Queue)│  ← protocol crate 只定义
│  ────────────────           ────────────────│    线上流动的类型
│  Op::TurnInput              EventMsg::TurnStarted
│  Op::ExecApproval           EventMsg::ItemStarted(TurnItem)
│  Op::Interrupt              EventMsg::AgentMessageContentDelta
│  Op::Compact                EventMsg::ExecApprovalRequest
│  ...                        ... (共 81 变体)
└─────────────────────────────────────────────┘
      │                          ▲
      ▼                          │
              Session / Agent Loop (core, Ch6-7)
      │                          ▲
      │ Vec<ResponseItem>        │ ResponseItem 流式解析
      ▼                          │
            Responses API（models.rs 同构层）
```

三类类型各管一段：`Op`/`EventMsg` 管内核↔外壳，`ResponseItem`/`ResponseInputItem` 管内核↔模型 API，`TurnItem` 管内核→UI 的呈现投影。它们都在同一个 crate 里，因为它们本质上是同一份协议的三个切面。

### 一个审批的完整往返

用一次审批把两个枚举串起来。假设模型要求执行 `rm -rf build/`，沙箱策略判定需要人工确认：

```
core (工具执行前, Ch9/11)                    外壳 (TUI / IDE)
      │                                        ▲
      │ Event { id: "sub-42",                  │
      │   msg: ExecApprovalRequest {           │
      │     call_id: "call_7",                 │
      │     command: ["rm","-rf","build/"],    │
      │     available_decisions: [Approved,    │
      │       ApprovedForSession, Denied,      │
      │       Abort], ... } }                  │
      ├────────────────────────────►│  UI 按 available_decisions 渲染按钮
      │                                        │  用户点「本次允许」
      │  Op::ExecApproval {                    │
      │    id: "call_7",                       │
      │    decision: Approved }                │
      │◄───────────────────────────────────────┤  submit(Op)
      ▼                                        │
 审批结果回到挂起的工具执行点，命令真正进入沙箱执行
```

三个细节值得注意：

- **关联靠 id**。`Event.id` 关联到产生审批的那次 submission，`ExecApprovalRequestEvent.call_id`/`approval_id` 标识具体命令，`Op::ExecApproval.id` 原样带回。异步总线上没有「函数调用栈」，全靠这些 id 把请求与响应缝合起来——这也是 `Event { id, msg }` 信封存在的意义。
- **UI 不知道命令该不该批**。`available_decisions` 由内核给出，UI 只负责渲染内核允许的选项。安全策略的判定全部留在内核一侧，外壳无条件信任协议数据——这正是「逻辑不下沉到协议消费端」的体现。
- **内核在等待时不阻塞总线**。审批挂起期间，`AgentMessageContentDelta` 等其它事件照常流动（比如另一个后台任务）。消息模型天然支持这种并发，回调模型则需要手动维护状态机。

### 从 SSE 字节流到 ResponseItem

第 4 章讲过 SSE 流式解析，这里补齐类型层面的收口。模型返回的每个 output item 走完这样一条路：

```
Responses API SSE 流
  │  response.output_item.done 事件，item 是 JSON：
  │  {"type":"function_call","name":"shell",
  │   "arguments":"{\"cmd\":...}","call_id":"call_7",...}
  ▼
serde_json 反序列化（tag = "type" 分发）
  ▼
ResponseItem::FunctionCall { name, arguments, call_id, ... }
  │  ├─► 追加进对话历史（Vec<ResponseItem>，下轮原样回传）
  │  ├─► 写入 rollout JSONL（Ch13，持久化的就是同一份数据）
  │  ├─► EventMsg::RawResponseItem 广播给需要原始流的消费者
  │  └─► 内核解释执行：路由到工具系统（Ch9）
  ▼
工具产出 FunctionCallOutputPayload
  ▼
ResponseItem::FunctionCallOutput { call_id: "call_7", output }
  └─► 追加进历史，Agent Loop 进入下一轮（Ch7）
```

关键点在于 **一条数据，三种用途**：同一份 `ResponseItem` 既是发给 API 的历史、又是写进 rollout 的持久化记录、还是事件流的广播内容。协议层的 serde 定义让「内存中的对话历史」「磁盘上的会话记录」「发给模型的请求体」三者保持位级一致——会话 resume（第 13 章）之所以能从 JSONL 无损重建上下文，靠的就是这个同构。

## 设计取舍

### 为什么 Op 和 EventMsg 是两个枚举

回到本章开头的问题：为什么不像 my-agent 那样，定义一个 `AgentEvent` 联合类型加一个回调完事？源码里藏着三层理由。

**方向不同，能力就不同。** `EventMsg` 派生了 `Serialize + Deserialize`——事件必须能跨过进程边界（app-server 推给 IDE）、能落盘（rollout）。`Op` 只派生了 `Debug`，因为它的变体里装着**不可序列化的东西**：

```rust
// 来源：codex-rs/protocol/src/protocol.rs:572-577
/// Submit turn input using the requested routing behavior.
TurnInput {
    request: Box<TurnInputRequest>,
    mode: TurnInputMode,
    reply: oneshot::Sender<CodexResult<TurnInputSubmission>>,
},
```

`reply` 是一个 tokio oneshot 通道的发送端——提交方持有接收端，就能 `await` 到「内核已受理（Started/Steered/NotSubmitted）」的确切回执。这是进程内的零拷贝优化：同进程通信时不必把「请求-响应」降级成两条靠 id 关联的消息。但代价就是 `Op` 永远无法整体序列化。app-server 需要跨进程提交 Op 时，是在 JSON-RPC 层把请求翻译成 Op 构造调用、把 oneshot 的回复翻译回 RPC response（第 15 章展开）——序列化缺口在边界处由适配层补上，而不是牺牲进程内的表达力。

**演进节奏不同。** `EventMsg` 是对外 API 面，加字段都受代码生成约束（还记得那行 NOTE 注释）；`Op` 是内部控制面，头上挂着 `#[non_exhaustive]`，作者随时可以加变体而不算 breaking change。两个枚举的变更策略一个保守一个宽松，合成一个枚举就只好取交集——两头受罪。

**读者集不同。** 81 个事件变体是给「所有消费者」的并集：TUI 关心 `AgentMessageContentDelta`，CI 关心 `TurnComplete`，IDE 关心 `TurnDiff`。而 28 个 Op 变体是「所有驱动者」的并集。消费者的并集和驱动者的并集本来就是两个集合，分开定义让每一侧的 `match` 都只面对自己该关心的世界。

对照你的 my-agent：TS 里你很自然地会写

```ts
type AgentCallbacks = {
  onText: (delta: string) => void;
  onApprovalNeeded: (req: ApprovalRequest) => Promise<ReviewDecision>;
  // ...
};
```

注意 `onApprovalNeeded` 返回 `Promise`——你已经无意识地把「请求-响应」塞进了回调模型。这在单进程里很优雅，但当第二个消费者（比如一个 Web 前端）出现时，回调引用传不过去，你只能回头把回调重构成事件流，再把 `Promise<ReviewDecision>` 拆成「approval_request 事件 + submit_decision 方法」。Codex 的答案是**一开始就把边界画在数据上**：`ExecApprovalRequestEvent` 与 `Op::ExecApproval` 是同一枚硬币的两面，中间没有函数签名，只有可序列化的数据和 id 关联。重构成本在第一天就付掉了，换来的是第四个消费者（MCP server）出现时内核一行未改。

### 为什么这个 crate 几乎不含逻辑

翻遍 `protocol.rs` 的 6039 行，你能找到的「逻辑」只有几类：serde 的自定义序列化（如 `FunctionCallOutputPayload` 的字符串/结构化二态）、`SandboxPolicy` 的纯函数查询（`has_full_disk_write_access` 这类对枚举的只读归纳）、以及 `ReviewDecision::to_opaque_string` 这种展示辅助。**没有任何 async fn，没有任何 I/O，没有任何对 core/tui 的引用。**

这是刻意维持的「哑协议（dumb pipe）」纪律，收益有三：

1. **编译解耦**。55 个下游 crate 依赖 `codex-protocol`，它自身几乎不依赖业务 crate。改 `core` 的内部实现不会触发 TUI 重编；协议层的改动虽然影响面广，但 diff 本身永远是数据形状的增删，review 成本极低。
2. **序列化唯一真相**。`serde` + `schemars` + `ts-rs` 三个 derive 挂在同一份 Rust 定义上，JSON wire format、JSON Schema、`sdk/typescript` 的 `.d.ts` 从同一来源生成。TS SDK 与 Rust 内核的类型漂移在编译期就被杜绝——这是「手写两份类型」的 TS 项目最容易腐烂的地方。
3. **可测试的边界**。协议是纯数据，意味着内核与外壳的集成测试可以完全用构造好的 `EventMsg`/`Op` 值来驱动，不需要 mock 任何函数行为（本书核心测试工具 `core_test_support` 正是这么做的）。

代价也不是没有：所有字段必须对所有消费者可理解，导致协议层堆满了 `plugin_id`、`guardian`、`collab` 这类单一产品形态才用的字段，类型命名空间越来越挤。但从「55 个 crate 共享一份定义且从不循环依赖」这个事实看，这条纪律被执行得很成功。

### EventMsg 变体爆炸的代价

第 1 章埋的问题到这里必须结账了：**81 个变体，值得吗？**

先承认代价是真实的。每个事件消费者都要面对 81 种可能；`Display`、`strum`、TS 类型、JSON Schema 全都要为每个变体生成一份代码；`legacy_events.rs` 的存在本身（639 行）就是为了处理「协议已经有两代事件模型」这个事实——它定义的 `HasLegacyEvent` trait（legacy_events.rs:67）负责把新的 `TurnItem` 生命周期事件**回译**成旧版 `EventMsg` 流，喂给还没迁移的兼容消费者：

```rust
// 来源：codex-rs/protocol/src/legacy_events.rs:66-69
/// Converts canonical item lifecycle events back into the legacy raw event stream used by
/// compatibility consumers that have not migrated to `TurnItem`.
pub trait HasLegacyEvent {
    fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg>;
}
```

也就是说，Codex 其实已经在做「事件模型瘦身」——从细粒度的 81 变体事件流，演进为 `ItemStarted(TurnItem)`/`ItemCompleted(TurnItem)` 的粗粒度条目流，UI 主要消费 `TurnItem`；旧事件流降级为兼容层，由这个回译 trait 生成。变体爆炸的终点不是继续加变体，而是**换一个抽象层级**：从「内核发生的每件小事一个变体」到「回合里出现了什么条目」。`#[serde(rename = "task_started", alias = "turn_started")]` 这类注解就是迁移期的脚手架。

为什么没有一步到位拆成多个枚举（比如 `TurnLifecycleEvent | ToolEvent | ApprovalEvent`）？因为事件流是单一有序序列——消费者按到达顺序处理事件，拆成多个通道就要自己处理通道间的相对顺序，而「先收到审批请求还是先收到打断」这种顺序恰恰是正确性攸关的。单枚举 + 顺序队列是最简单的正确性保证，81 个变体是为「有序」付的税。

对你的 my-agent 的启示：变体数量本身不是病，**没有抽象层级**才是病。协议设计的目标不该是「变体少」，而是「存在一个稳定的粗粒度核心（TurnItem 生命周期），细粒度事件可以演进、可以废弃、可以被回译」。如果你的 Agent 事件已经有 20+ 种且还在长，值得考虑的不是拆枚举，而是定义你的 `TurnItem`。

## 动手实验

以下命令都是只读观察，在仓库根目录执行。

数一数两个枚举的真实规模：

```shell
awk 'NR>=545 && NR<=705 && /^    [A-Z]/' codex-rs/protocol/src/protocol.rs | wc -l
# 预期输出：28（Op 的变体数）

awk 'NR>=1296 && NR<=1506 && /^    [A-Z]/' codex-rs/protocol/src/protocol.rs | wc -l
# 预期输出：81（EventMsg 的变体数）
```

确认 protocol crate 的「哑」程度——全 crate 没有任何 async 函数定义：

```shell
rg -n "async fn" codex-rs/protocol/src/ | wc -l
# 预期输出：0
# 对比：rg -c "async fn" codex-rs/core/src/ | head -5 会看到几十上百
```

观察 serde tag 注解如何决定线上 JSON 形状：

```shell
rg -n 'serde\(tag = "type"' codex-rs/protocol/src/*.rs
# 预期输出：EventMsg / ResponseItem / ResponseInputItem / ContentItem /
#   TurnItem / UserInput 等多处——所有跨边界枚举共享同一种判别字段约定
```

看协议的 TS 投影长什么样（ts-rs 生成物）：

```shell
ls sdk/typescript/src/ 2>/dev/null; rg -ln "TurnItem|EventMsg" sdk/typescript/ | head -5
# 预期输出：能在 SDK 里找到与 Rust 枚举对应的 TS 类型定义，
# 字段名与 serde 注解一致（snake_case 的 type 判别字段）
```

如果愿意跑起来看真实事件流（需要编译，首次较慢）：

```shell
cargo run --bin codex -- exec --json "say hi"
# 预期输出形态：stdout 每行一个 JSON 对象，带 "type" 字段，
# 依次出现 thread.started / turn.started / item.completed ... turn.completed
# （exec 的 --json 契约见 codex-rs/exec/src/lib.rs:3：
#  "In --json mode, stdout must be valid JSONL, one event per line."）
```

注意一个细节：exec 的 JSONL 并不是 `EventMsg` 的直接序列化，而是 `codex-rs/exec/src/exec_events.rs` 定义的**第三套事件词汇**（`thread.started` / `item.completed` 等点分命名），由 app-server 的通知翻译而来。这正是「设计取舍」里说的抽象分层在另一个消费端的体现——每个外壳都可以把协议数据投影成自己的事件模型。

## Rust 侧栏

本章密集出现的语言/库特性：

- **`#[serde(tag = "type")]`（internally tagged enum）**：serde 把枚举序列化为 `{"type": "variant_name", ...字段}` 的扁平 JSON 对象，判别字段与数据字段同级。这正是 TypeScript 社区熟悉的 discriminated union 的 JSON 形态，也是 Responses API 的 wire 约定——一个注解同时满足了类型安全与 API 兼容。
- **`#[serde(other)]`**：枚举兜底变体。`ResponseItem::Other` 让客户端遇到 API 新增、本地还不认识的 item 类型时反序列化不报错。协议层面对外部演进的「防弹衣」。
- **`#[non_exhaustive]`**：标注在 `Op`、`UserInput` 上，禁止**其它 crate** 对这些枚举写不带通配臂的 `match`。作者以后加变体不破坏下游编译——用类型系统购买「演进自由」，代价是下游必须写 `_ =>` 兜底臂。
- **`oneshot::Sender<T>`**：tokio 的一次性通道。`Op::TurnInput` 带着它的发送端进入队列，内核受理后通过它送回执；提交方 `await` 接收端即可。相当于 TS 里把 `Promise` 的 resolve 函数作为参数传进去——但类型系统保证最多 resolve 一次。
- **`Box<TurnInputRequest>` 与 `clippy::large_enum_variant`**：枚举的大小由最大变体决定。大载荷变体用 `Box` 包一层，枚举本身保持苗条；`#[allow(clippy::large_enum_variant)]` 是作者确认过取舍后的显式豁免，而不是视而不见。
- **derive 三件套 `Serialize + JsonSchema + TS`**：一个结构体标注三个宏，同时获得 JSON 序列化、JSON Schema 生成、TypeScript 类型生成。`protocol.rs` 几乎每个类型都挂着这套组合——这是「单一类型来源，多语言投影」的工程实现。

## 小结 + 思考题

本章把第 1 章的协议草图落成了真实定义：`Op`（28 变体，进程内指令，可携带 oneshot 回执）与 `EventMsg`（81 变体，可序列化事件，受对外兼容约束）构成 SQ/EQ 双向总线；`ResponseItem` 与 Responses API wire format 同构，让对话历史、rollout 持久化、模型请求体三者共用一份数据；`TurnItem` 是同一回合面向 UI 的呈现投影；整个 crate 以「几乎无逻辑」的哑协议纪律，支撑 55 个下游 crate 的单向依赖。第 1 章埋的「变体爆炸」问题也有了答案：Codex 正在用 `TurnItem` 生命周期事件作为更粗的抽象层收编细粒度事件，`legacy_events.rs` 是迁移期的回译层。

下一章进入 `core`：`CodexThread::submit`/`next_event` 背后的 Session 如何创建、任务如何排队、回合状态机如何流转——本章定义的每个类型都将在那里被真正「驱动」起来（详见[第 6 章](ch06-core-session.md)，Agent Loop 的主体见[第 7 章](ch07-agent-loop.md)）。

思考题：

1. `Op::Interrupt` 不打草稿就能执行，而 `Op::TurnInput` 必须等 oneshot 回执——从 `TurnInputSubmission` 的三个变体（Started/Steered/NotSubmitted）反推，为什么「提交输入」需要一个明确的受理结果而「打断」不需要？（提示：turn_input.rs:155-170 的注释）
2. `ResponseItem::FunctionCall` 的 `arguments` 为什么是 `String` 而不是 `serde_json::Value`？除了源码注释给出的理由，这个选择对**流式解析**（arguments 分片到达）有什么好处？
3. 如果让你给 my-agent 设计 `TurnItem` 层：你现有的 UI 渲染代码里，哪些状态（spinner、命令卡片、diff 视图）其实应该来自条目数据而不是回调时序？
4. `legacy_events.rs` 用「新模型回译旧事件」维持兼容。反过来做（旧事件翻译成新条目）会遇到什么信息丢失问题？（提示：对比 `ExecCommandBeginEvent` 与 `CommandExecutionItem` 的字段）
