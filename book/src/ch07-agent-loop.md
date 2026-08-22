# 第 7 章 Agent Loop 详解（全书重心）

## 本章导读

如果你自己写过一个 Coding Agent，核心大概是这样的（TypeScript 伪代码，约 200 行能跑通）：

```ts
// my-agent 的主循环：一个 while 包打天下
while (true) {
  const res = await llm.stream({ messages, tools });   // 全量重发历史
  for await (const chunk of res) render(chunk);
  if (!res.toolCalls.length) break;                     // 不调用工具就结束
  for (const call of res.toolCalls) {
    const output = await runTool(call);                 // 串行执行
    messages.push(toToolResult(call, output));          // 追加进历史
  }
}
```

这个循环能工作，直到你认真使用它：用户按了 Esc 想打断怎么办？模型流到一半网络断了，已经执行了两个工具、第三个还没跑，历史处于什么状态？用户在模型运行时又敲了一句话，这一回合算完了还是没完？上下文快满了，是硬停还是压缩后继续？这 200 行里每一个 `await` 背后都是一个失控点。

本章逐函数走读 Codex 对这些问题的回答。主角是 `codex-rs/core/src/session/turn.rs` 里的 `run_turn()`——它是全书最重的一个函数，也是「Agent Loop」这个概念在本仓库的真正落点。读完本章你应该能回答：

- 一次回合（turn）内模型被调用多少轮？轮与轮之间历史（history）如何增长？
- 模型的流式输出在哪里被解析成工具调用，工具在哪里被执行，结果如何回到历史？
- 回合什么时候结束：正常结束、被打断、出错、上下文触顶，各走哪条路径？
- `AgentMessageContentDelta` 这类事件在循环的哪个精确位置发出？
- Codex 的循环和你的 my-agent 循环，结构性差异到底在哪？

前置章节里，[第 4 章](ch04-auth-model.md)讲了 HTTP 请求如何构造、SSE 字节流如何解析成 `ResponseEvent`；[第 5 章](ch05-protocol.md)讲了 `ResponseItem`/`EventMsg` 数据模型；[第 6 章](ch06-core-session.md)讲了 Session 与任务模型。本章把它们接到一起：**loop 是消费者**——消费第 4 章的流、驱动第 5 章的事件、在第 6 章的任务壳里运行。

## 源码地图

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-rs/core/src/session/handlers.rs` | `submission_loop`：Op 的总分发 | `Op::TurnInput` 在这里进入回合世界 |
| `codex-rs/core/src/session/turn_input.rs` | 决定输入是「开新回合」还是「插队（steer）」 | Core 中唯一做这个判断的地方 |
| `codex-rs/core/src/session/input_queue.rs` | `TurnInput` 类型与回合内挂起输入队列 | 用户在模型运行时输入的消息存在这里 |
| `codex-rs/core/src/tasks/regular.rs` | `RegularTask`：普通对话回合的任务壳 | 壳很薄，全部重量在 `run_turn` |
| `codex-rs/core/src/tasks/mod.rs` | `SessionTask` trait、spawn/finish/abort 生命周期 | `TurnComplete`/`TurnAborted` 在这里发出 |
| `codex-rs/core/src/session/turn.rs` | **`run_turn` 主循环 + 采样请求 + 流消费** | 本章主体，2791 行 |
| `codex-rs/core/src/session/step_context.rs` | `StepContext`：一次模型调用的请求级快照 | 工具列表、模型、审批策略都钉在这里 |
| `codex-rs/core/src/session/turn_context.rs` | `TurnContext`：整个回合的稳定配置 | turn 级与 step 级的二分是本基线的关键设计 |
| `codex-rs/core/src/stream_events_utils.rs` | `handle_output_item_done`：模型输出条目的分发 | 工具调用与非工具输出在这里分家 |
| `codex-rs/core/src/tools/parallel.rs` | `ToolCallRuntime`：工具并发执行与取消 | 并行门闸、超时中止都在这 |
| `codex-rs/core/src/tools/router.rs` | `ToolRouter::build_tool_call`：`ResponseItem` → `ToolCall` | 路由细节见[第 9 章](ch09-tools.md) |
| `codex-rs/core/src/client.rs` | `ModelClientSession::stream`：回合内复用的模型连接 | 构造侧见[第 4 章](ch04-auth-model.md) |
| `codex-rs/core/src/client_common.rs` | `Prompt` / `ResponseStream` 定义 | 循环与传输层之间的接口 |
| `codex-rs/codex-api/src/common.rs` | `ResponseEvent` 枚举 | 流消费侧 `match` 的就是它 |
| `codex-rs/core/src/context_manager/history.rs` | `ContextManager`：历史的读写 | 本章只用接口，细节见[第 8 章](ch08-context-compact.md) |
| `codex-rs/core/src/responses_retry.rs` | 流错误的重试决策 | 退避、降级、通知用户都在这 |

## 核心数据结构

### `TurnInput`：回合的输入单元

进入 loop 之前，用户输入先被包装成 `TurnInput`。它还会出现在 `SessionTask::run` 的签名里（`Vec<TurnInput>`），是任务系统与 session 之间的通用输入类型：

```rust
// 来源：codex-rs/core/src/session/input_queue.rs:19-30
/// Input consumed by a regular turn.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum TurnInput {
    UserInput {
        content: Vec<UserInput>,        // ← 文本/图片等用户输入
        client_id: Option<String>,      // ← 客户端侧消息 id，用于幂等
    },
    ResponseItem(#[serde(with = "turn_input_response_item")] ResponseItemEnvelope),
    InterAgentCommunication(InterAgentCommunication),  // ← 子 Agent 来信
}
```

三个变体对应三种"往回合里塞东西"的途径：用户打字、外部注入一个合成条目（如 hook、环境上下文）、多 Agent 场景下子主线（thread）的 mailbox 来信。后两种解释了为什么 loop 顶部每轮都要检查挂起输入——输入不只来自回合开始时。

### `Prompt`：发给模型的一发请求

第 4 章讲过它如何被翻译成 `ResponsesApiRequest`；在 loop 视角下，它是**一次采样请求的完整输入**：

```rust
// 来源：codex-rs/core/src/client_common.rs:19-37
pub struct Prompt {
    pub input: Vec<ResponseItem>,        // ← 全量历史（store:false 的代价与自由）
    pub(crate) tools: Arc<[ToolSpec]>,   // ← 本轮对模型可见的工具清单
    pub(crate) parallel_tool_calls: bool, // ← Codex 固定为 true
    pub base_instructions: BaseInstructions, // ← 系统提示词
    pub output_schema: Option<Value>,    // ← 结构化输出约束（如 review 模式）
    pub output_schema_strict: bool,
}
```

### `ResponseEvent`：模型流的词汇表

第 4 章讲了 SSE 字节如何被解析成这个枚举；本章是消费侧，loop 里那个巨大的 `match` 匹配的就是这些变体：

```rust
// 来源：codex-rs/codex-api/src/common.rs:76-123（删节）
pub enum ResponseEvent {
    Created,
    OutputItemDone(ResponseItem),     // ← 一个完整条目（工具调用/消息）到达：执行或记录
    OutputItemAdded(ResponseItem),    // ← 条目开始流出：发 TurnItem Started 事件
    Completed {
        response_id: String,
        token_usage: Option<TokenUsage>,
        end_turn: Option<bool>,       // ← 模型是否明确宣告"我说完了"
    },
    OutputTextDelta(String),          // ← 助手文本增量 → AgentMessageContentDelta
    ToolCallInputDelta { item_id: String, call_id: Option<String>, delta: String },
    ReasoningSummaryDelta { delta: String, summary_index: i64 },
    ReasoningContentDelta { delta: String, content_index: i64 },
    RateLimits(RateLimitSnapshot),
    // ...
}
```

`OutputItemAdded`/`OutputItemDone` 与各种 `*Delta` 的二分是 Responses API 流式协议的形状：条目（item）是骨架，delta 是附着在"当前活动条目"上的增量血肉。loop 里用 `active_item` 跟踪这个附着关系，后面会讲。

### `TurnContext` 与 `StepContext`：回合级与请求级的二分

`TurnContext`（`session/turn_context.rs:144` 起）是回合创建时定下的稳定配置：`sub_id`（回合 id）、`config`、`provider`、`session_source`、`mode`（普通/Plan 模式）等。它在整个回合内不变。

而本基线有一个重要演进：**模型切换可以发生在回合中途**（fallback、压缩用不同模型），所以每次采样请求还要再钉一份"请求级快照"：

```rust
// 来源：codex-rs/core/src/session/step_context.rs:17-47（删节）
/// Request-scoped state that may change between model sampling requests.
pub(crate) struct StepContext {
    pub(crate) turn: Arc<TurnContext>,
    pub(crate) model_info: Arc<ModelInfo>,        // ← 本次请求实际用的模型
    pub(crate) reasoning_effort: Option<ReasoningEffort>,
    pub(crate) approval_policy: AskForApproval,   // ← 可能随模型切换而变化
    pub(crate) environments: TurnEnvironmentSnapshot,
    pub(crate) mcp: Arc<McpBinding>,              // ← 本次请求时的 MCP 连接快照
    pub(crate) tool_router: Arc<ToolRouter>,      // ← 本次请求对模型 advertised 的工具全集
    pub(crate) loaded_agents_md: Option<Arc<LoadedAgentsMd>>,
    // ...
}
```

注意 `tool_router` 的注释：「The finalized tool plan advertised and executed for this exact sampling request」。**模型看到的工具清单和它发起的工具调用必须来自同一份快照**——否则模型调了一个"上一轮还在、这轮被卸了"的工具就无解了。`StepContext` 就是这份一致性契约。结构体里多个字段标注"step-scoped execution should use `StepContext` 而不是 `TurnContext` 的 legacy 字段"，说明这个二分正在进行中，读代码时认准 step 级。

### `ContextManager`：历史的守门人

历史不是 `Vec<ResponseItem>` 裸奔，而是包了一层（`context_manager/history.rs:45-65`）：

```rust
// 来源：codex-rs/core/src/context_manager/history.rs:43-65（删节）
/// Transcript of thread history
pub(crate) struct ContextManager {
    /// 快照共享底层 vector，只读消费者零拷贝；写入时 copy-on-write
    items: Arc<Vec<ResponseItemEnvelope>>,
    /// 历史被改写（压缩/回滚）时递增的版本号
    history_version: u64,
    token_info: Option<TokenUsageInfo>,
    reference_context_item: Option<TurnContextItem>, // ← 上下文 diff 的基线
    world_state_baseline: Option<WorldStateSnapshot>,
}
```

loop 只用到它的三个接口，本章记住签名即可，内部机制（截断、归一化、token 估算）是[第 8 章](ch08-context-compact.md)的内容：

```rust
// 来源：codex-rs/core/src/context_manager/history.rs:162-211（删节）
pub(crate) fn record_items<I>(&mut self, items: I, policy: TruncationPolicy) // ← 追加
pub(crate) fn for_prompt(self, input_modalities: &[InputModality]) -> Vec<ResponseItem>
//    ↑ 消费一份克隆，归一化后产出"可发给模型"的历史
pub(crate) fn raw_items(&self) -> impl Clone + ExactSizeIterator<Item = &ResponseItem> + ...
```

`for_prompt(self, ...)` 的签名很讲究：它**消费** `self`（一份 `clone_history()` 得来的克隆），在克隆上做归一化（剥除模型不支持模态的图片/音频、合并等），绝不弄脏共享历史。

## 流程走读

### 7.1 全景：三层嵌套循环

`run_turn` 不是一个循环，而是三层嵌套，每层职责单一：

```
RegularTask::run()                    ← 任务壳（SessionTask 体系，第 6 章）
 │
 ▼
run_turn()
 │  loop {                       ← 外层：turn 循环；每迭代 = 一次采样请求
 │    drain pending_input        ← 取用户在模型运行时敲的插队消息
 │    capture StepContext        ← 钉住本轮的模型/工具/审批快照
 │    clone_history().for_prompt() ──► Prompt（全量历史）
 │      │
 │      ▼
 │    run_sampling_request()
 │      loop {                   ← 中层：网络重试循环
 │        try_run_sampling_request()
 │          loop {               ← 内层：流消费循环
 │            stream.next() ──► match ResponseEvent
 │              OutputItemDone(工具调用)
 │                ──► 立即记入 history；工具 future 入 in_flight
 │              Completed ──► break
 │          }
 │          drain_in_flight()：工具按发起顺序收割，
 │          FunctionCallOutput 逐个记入 history
 │      }   可重试错误 ──► 重发整份历史
 │  }   needs_follow_up ──► 继续；否则出循环
 ▼
on_task_finished() ──► EventMsg::TurnComplete / TurnAborted
```

关键直觉：**外层循环的每次迭代都把完整历史重新发给模型**（`store: false`，见[第 4 章](ch04-auth-model.md)），历史在迭代之间只增不改；中层重试循环是网络不可靠的对冲；内层流消费循环是事件流的源头。三层拆开，每层都能单独理解、单独测试。

### 7.2 入口：从 `Op::TurnInput` 到 `run_turn`

第 6 章讲过 Session 的 `submission_loop` 如何收 `Op`。`Op::TurnInput` 的分发臂很薄：

```rust
// 来源：codex-rs/core/src/session/handlers.rs:570-578
Op::TurnInput {
    request,
    mode,
    reply,
} => {
    let result = turn_input::handle(&sess, *request, mode, sub.id.clone()).await;
    let _ = reply.send(result);   // ← 立刻回复"受理结果"，不等回合跑完
    false
}
```

`turn_input::handle`（`session/turn_input.rs:141-156`）按 `TurnInputMode` 分流，主路径是 `start_or_steer`（`turn_input.rs:167-250`）。它先尝试 `steer_input`——如果当前有活跃回合且任务类型是 `Regular`，就把输入**追加到该回合的挂起队列**而不是开新回合：

```rust
// 来源：codex-rs/core/src/session/turn_input.rs:488-523（删节）
let mut active = self.active_turn.lock().await;
let Some(active_turn) = active.as_mut() else {
    return Err(NotSubmittedReason::NoActiveTurn);  // ← 没有活跃回合：走"开新回合"
};
// ...
match active_task.kind {
    crate::state::TaskKind::Regular => {}
    crate::state::TaskKind::Review => {
        return Err(NotSubmittedReason::ActiveTurnNotSteerable {
            turn_kind: NonSteerableTurnKind::Review,
        });
    }
    // Compact 同理，不可插队
}
if input.is_empty() {
    return Err(NotSubmittedReason::EmptyInput);
}
```

这就是 TUI 里"模型还在跑，你又敲了一句，那句话排队等插话"的机制：`TurnInputMode::StartOrSteer` 让同一份 UI 代码不用关心当前是否有回合在跑——有就 steer，没有就 start。开新回合时（`turn_input.rs:241-243`）：

```rust
// 来源：codex-rs/core/src/session/turn_input.rs:241-246
session
    .spawn_task(turn_context, task_input, RegularTask::new())
    .await;
Ok(TurnInputSubmission::Started {
    turn_id: submission_id,
})
```

`spawn_task`（`tasks/mod.rs:279-289`）会先 `abort_all_tasks(TurnAbortReason::Replaced)`（新回合顶掉旧任务），然后 `start_task` 里 `tokio::spawn` 出后台任务（`tasks/mod.rs:382-415`），任务体是 `SessionTask::run`，完成后统一走 `on_task_finished`。`RegularTask::run`（`tasks/regular.rs:39-91`）先发 `TurnStarted` 事件，然后调用 `run_turn`，并且自己还有一个小循环：

```rust
// 来源：codex-rs/core/src/tasks/regular.rs:74-91
let mut next_input = input;
let mut prewarmed_client_session = prewarmed_client_session;
loop {
    let last_agent_message = run_turn(
        Arc::clone(&sess),
        Arc::clone(&ctx),
        next_input,
        prewarmed_client_session.take(),   // ← 预热连接只给第一次
        cancellation_token.child_token(),
    )
    .instrument(run_turn_span.clone())
    .await?;
    if !sess.input_queue.has_pending_input(&sess.active_turn).await {
        return Ok(last_agent_message);
    }
    next_input = Vec::new();   // ← 还有挂起输入：把 run_turn 再跑一遍
}
```

也就是说，`run_turn` 返回不代表任务结束——只要挂起队列里还有用户输入，`RegularTask` 会立刻再开一个 `run_turn`。从用户视角这是一次连续对话；从代码视角，**一个 Task 可以包含多个 `run_turn`**。

### 7.3 `run_turn` 开场：压缩、快照、落史

`run_turn`（`session/turn.rs:153-589`）签名：

```rust
// 来源：codex-rs/core/src/session/turn.rs:139-159
/// Takes initial turn input and runs a loop where, at each sampling request,
/// the model replies with either:
///
/// - requested function calls
/// - an assistant message
///
/// While it is possible for the model to return multiple of these items in a
/// single sampling request, in practice, we generally one item per sampling request:
///
/// - If the model requests a function call, we execute it and send the output
///   back to the model in the next sampling request.
/// - If the model sends only an assistant message, we record it in the
///   conversation history and consider the turn complete.
pub(crate) async fn run_turn(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    input: Vec<TurnInput>,
    prewarmed_client_session: Option<ModelClientSession>,
    cancellation_token: CancellationToken,
) -> CodexResult<Option<String>> {
```

开头的文档注释就是 Agent Loop 的教科书定义，值得逐句对照后面的代码。返回值 `Option<String>` 是"本回合最后一条助手消息"——它会一路传回 `on_task_finished`，放进 `TurnComplete` 事件。

开场按顺序做四件事（`turn.rs:160-283`）：

1. **取或建 `ModelClientSession`**（163-164 行）：这是**回合级**的模型连接句柄，缓存 WebSocket 连接与 `x-codex-turn-state` 粘性路由 token（`client.rs:262-289` 的文档注释明确警告：跨回合复用会把上一回合的路由 token 带进新回合，违反客户端/服务端契约）。TUI 启动时预热的连接经 `RegularTask` 只传给本任务的第一个 `run_turn`（上节 `prewarmed_client_session.take()`），此后每回合自建。
2. **回合前压缩**（169-190 行）：`run_pre_sampling_compact`（`turn.rs:1012-1041`）先算 `context_window_token_status`，若 token 已触顶（`token_limit_reached`），先做一次 `CompactionPhase::PreTurn` 的自动压缩再开始。压缩机制本身是[第 8 章](ch08-context-compact.md)的内容，本章只需知道它是 loop 的两个"旁路调用"之一。
3. **捕获首个 `StepContext`**（207-222 行）：`capture_step_context_with_required_mcp_servers`（`session/mod.rs:3173-3281`）刷新 AGENTS.md、解析环境能力根、拉起本步需要的 MCP server、构建 `ToolRouter`，最后打包成 `StepContext`。这一步可能耗时（MCP 冷启动），所以放在循环外只做一次，后续迭代按需重捕获。
4. **输入落史**（266-281 行）：`run_hooks_and_record_inputs`（`turn.rs:615-643`）先让 hook 检查输入（hook 可以拦截并替换为 additional context），然后把每条 `TurnInput` 转成 `ResponseItem` 追加进历史并写 rollout。注意 PersistContext 参数：回合首条输入用 `TurnStart`，中途插队输入用 `Standard`。

到这里，用户消息已经在历史里了。接下来进入外层 `loop`（`turn.rs:301`）。

### 7.4 外层循环（上）：组装一次采样请求

每次迭代开头（`turn.rs:301-393`）：

```rust
// 来源：codex-rs/core/src/session/turn.rs:301-323（删节）
loop {
    // Note that pending_input would be something like a message the user
    // submitted through the UI while the model was running.
    let pending_input = if can_drain_pending_input {
        sess.input_queue
            .get_pending_input(&sess.active_turn)
            .await
            .0
    } else {
        Vec::new()
    };

    if run_hooks_and_record_inputs(
        &sess, &turn_context, &pending_input, PersistContext::Standard,
    )
    .await
    {
        break;   // ← hook 拦停了全部输入：回合直接结束
    }
```

`can_drain_pending_input` 初始为 `input.is_empty()`——回合刚开始时**故意不取**挂起队列，让本回合的新鲜输入先被模型看到（`turn.rs:295-298` 的注释解释了这两个例外）。之后每轮迭代开头，用户在上一轮模型运行期间敲的消息在这里被取走、落史，从而出现在本次请求的末尾。这就是 steer 的生效点：**不是打断模型，而是在下一次请求里自然出现**。

接着捕获本轮的 `StepContext`（334-356 行）：首轮复用开场捕获的那份；后续轮次如果有挂起输入且带了新的 MCP 依赖，要重新解析 `required_mcp_servers_for_input` 再捕获。然后组装模型输入：

```rust
// 来源：codex-rs/core/src/session/turn.rs:369-392（删节）
// Construct the input that we will send to the model.
let sampling_request_input: Vec<ResponseItem> = async {
    sess.clone_history()
        .await
        .for_prompt(&step_context.model_info.input_modalities)
}
.instrument(trace_span!("run_turn.prepare_sampling_request_input"))
.await;

let responses_metadata = sess
    .responses_metadata(turn_context.as_ref(), CodexResponsesRequestKind::Turn)
    .await;
run_sampling_request(
    Arc::clone(&sess),
    Arc::clone(&step_context),
    Arc::clone(&turn_context.extension_data),
    Arc::clone(&turn_diff_tracker),
    &mut client_session,
    &responses_metadata,
    sampling_request_input,
    cancellation_token.child_token(),
)
.await
```

`clone_history()` 拿到 `ContextManager` 的克隆，`for_prompt` 归一化出全量历史——**每次采样请求都是全量重发**，新内容只是末尾追加的几条（用户输入、工具结果）。配合 `prompt_cache_key = session_id` 的服务端前缀缓存（[第 4 章](ch04-auth-model.md) 4.4 节），重复前缀的推理开销被缓存吸收。"上下文只增不改"在这里不只是软件工程洁癖，而是缓存命中率的前提：改了中间任何一条，缓存全废。

### 7.5 中层：`run_sampling_request` 的重试循环

`run_sampling_request`（`turn.rs:1340-1440`）是一次采样请求加网络重试的外壳：

```rust
// 来源：codex-rs/core/src/session/turn.rs:1363-1399（删节）
let max_retries = turn_context.provider.info().stream_max_retries();  // ← provider 级配置
let mut retry_state = ResponsesStreamRetryState::default();
let mut initial_input = Some(input);
let mut original_input = None;
let mut executed_tool_calls_by_output = HashMap::new();
loop {
    let prompt_input = if let Some(input) = initial_input.take() {
        input
    } else {
        // 重试时重新取历史：此前迭代可能已有工具结果落史
        sess.clone_history()
            .await
            .for_prompt(&step_context.model_info.input_modalities)
    };
    // ...
    let prompt = build_prompt(
        prompt_input,
        step_context.as_ref(),
        base_instructions.clone(),
    );
    let err = match try_run_sampling_request(
        tool_runtime.clone(),
        // ...
        &prompt,
        cancellation_token.child_token(),
    )
    .await
    {
        Ok(output) => {
            return Ok((output, original_input.unwrap_or(prompt.input)));
        }
        Err(err) => match err.details() {
            CodexErrorDetails::ContextWindowExceeded => {
                sess.set_total_tokens_full(&turn_context).await;  // ← 标记窗口已满，交给外层压缩
                return Err(err);
            }
            CodexErrorDetails::UsageLimitReached(e) => {
                // 速率限制不重试，更新限额信息后上交
                return Err(err);
            }
            _ => err,
        },
    };
```

两个细节：

- `build_prompt`（`turn.rs:1312-1328`）把历史、`step_context.tool_router.model_visible_specs()`（本步对模型可见的工具清单）、`parallel_tool_calls: true`、base instructions、输出 schema 打包成 `Prompt`。
- 重试时**重新** `clone_history().for_prompt()`，而不是复用失败时的那份——因为流消费过程中可能已经有工具执行结果落史（下面会看到条目是完成一条记一条的），重试请求需要带上它们。

不可重试错误直接 `return Err`；可重试错误交给 `handle_retryable_response_stream_error`（`responses_retry.rs:44-129`）决策，它有三级策略：

1. **连接失败**且开了 `UnboundedConnectionRetries` feature：5 秒起步、指数退避封顶 60 秒，**无限重试**，并发 `StreamError` 事件告诉用户"Reconnecting..."——长任务挂在墙上的 exec 场景不能让一次网络抖动杀死；
2. **普通可重试错误**：按 provider 配置的 `stream_max_retries` 上限退避重试，第二次起向 UI 发 `StreamError`（首次静默，减少噪音，`responses_retry.rs:108-122`）；
3. **重试耗尽**：如果是 WebSocket 传输，降级到 HTTPS 再试一轮（`try_switch_fallback_transport`），并向用户发 Warning 说明降级。

```rust
// 来源：codex-rs/core/src/responses_retry.rs:85-99（删节）
if retry_state.retries >= max_retries
    && client_session.try_switch_fallback_transport(
        &turn_context.session_telemetry,
        &turn_context.model_info,
    )
{
    sess.send_event(
        turn_context,
        EventMsg::Warning(WarningEvent {
            message: format!("Falling back from WebSockets to HTTPS transport. {err:#}"),
        }),
    )
    .await;
    retry_state.retries = 0;   // ← 换传输后重试计数清零，再给一整轮机会
    return Ok(());
}
```

### 7.6 内层：`try_run_sampling_request` 的流消费循环

这是全章最密的一段（`turn.rs:2179-2776`）。函数先发起流请求拿到 `ResponseStream`：

```rust
// 来源：codex-rs/core/src/session/turn.rs:2210-2225
let mut stream = client_session
    .stream(
        prompt,
        &step_context.model_info,
        &step_context.session_telemetry,
        step_context.reasoning_effort.clone(),
        step_context.reasoning_summary,
        step_context.service_tier.clone(),
        responses_metadata,
        &inference_trace,
    )
    .instrument(trace_span!("stream_request"))
    .or_cancel(&cancellation_token)   // ← 打断信号可以 cancel 掉这个 await
    .await??;
let mut in_flight: FuturesOrdered<BoxFuture<'static, CodexResult<ResponseInputItem>>> =
    FuturesOrdered::new();            // ← 并发执行、按提交顺序收割的工具 future 队列
```

`ResponseStream` 本身是一个 mpsc channel 的接收端（`client_common.rs:105-124`）：SSE/WebSocket 的解析在后台任务里做，解析好的 `ResponseEvent` 一个个推进 channel。`Drop` 时自动 cancel `consumer_dropped` 令牌，通知解析任务"没人听了，停"——流的生命周期靠 RAII 管理。

然后是 `loop` + `match event`（`turn.rs:2250-2733`）。逐变体看 loop 做了什么（变体全表见上文「核心数据结构」里的 `ResponseEvent`，这里按行为分组）：

**组 1：骨架事件——条目的开始与结束。**

`OutputItemAdded(item)`（2406-2483 行）：一个新条目开始流出。非工具条目（消息、推理）被转成 `TurnItem`，调 `sess.emit_turn_item_started(...)`——TUI 里"助手正在输入"的占位块就从这里来。同时把这个 `TurnItem` 记为 `active_item`，后续 delta 都挂在它下面。

`OutputItemDone(item)`（2295-2405 行）：一个条目完整到达，这是**执行侧的分叉口**，委托给 `handle_output_item_done`（`stream_events_utils.rs:289-391`），下一小节展开。

**组 2：增量事件——往 UI 转发。**

`OutputTextDelta(delta)`（2585-2616 行）：助手文本增量。经过 `AssistantTextStreamParser`（处理 Plan 模式、剥离引用标记等）后发出：

```rust
// 来源：codex-rs/core/src/session/turn.rs:2588-2615（删节）
if let Some(active) = active_item.as_ref() {
    // ...
    let item_id = active.id();
    if matches!(active, TurnItem::AgentMessage(_)) {
        let parsed = assistant_message_stream_parsers.parse_delta(&item_id, &delta);
        emit_streamed_assistant_text_delta(/* ... */).await;  // ← AgentMessage 走解析管线
    } else {
        let event = AgentMessageContentDeltaEvent {
            thread_id: sess.thread_id.to_string(),
            turn_id: turn_context.sub_id.clone(),
            item_id,
            delta,
        };
        sess.send_event(&turn_context, EventMsg::AgentMessageContentDelta(event))
            .await;
    }
} else {
    error_or_panic("OutputTextDelta without active item".to_string());
}
```

注意那个 `error_or_panic`：delta 到达时没有 `active_item` 是协议违例，debug 构建直接 panic，release 记 error。**事件的顺序不变量（ItemAdded → Delta* → ItemDone）由发送方（服务端）保证，消费侧只做校验**。`ReasoningSummaryDelta`、`ReasoningContentDelta` 等同理，分别变成 `ReasoningContentDelta`/`ReasoningRawContentDelta` 事件。`ToolCallInputDelta`（2617-2634 行）不直接发事件，而是喂给 `ToolArgumentDiffConsumer`——工具参数的流式 diff（比如 TUI 实时渲染 apply_patch 的补丁预览）。

**组 3：元数据事件——记状态、少发事件。**

`RateLimits` 更新内部限额状态但**不立刻发事件**（注释说等 token usage 到了一起发，避免重复 `TokenCount`）；`ServerModel` 在实际服务模型与请求模型不一致时警告一次；`ModelsEtag` 触发模型列表缓存刷新。这些都不影响 loop 走向。

**组 4：终止事件——`Completed`。**

```rust
// 来源：codex-rs/core/src/session/turn.rs:2539-2584（删节）
ResponseEvent::Completed {
    response_id,
    token_usage,
    end_turn,
} => {
    // ... 上报 analytics、冲刷助手文本缓冲、发 RawResponseCompleted
    let budget_result = sess
        .record_token_usage_info(&turn_context, token_usage.as_ref())
        .await;
    should_emit_token_count = true;
    should_emit_turn_diff = true;
    if let Err(err) = budget_result {
        break Err(err);
    }
    if let Some(false) = end_turn {
        needs_follow_up = true;   // ← 服务端明确说"还没说完"
    }
    break Ok(SamplingRequestResult {
        needs_follow_up,
        last_agent_message,
    });
}
```

`end_turn` 是三态的：`Some(false)` 表示服务端明确说还要续（此时即使没工具调用也要 follow-up），`None` 时靠"有没有工具调用"的兜底逻辑。token usage 在这里入账（`TokenCount` 事件、第 8 章压缩决策的数据源）。

**循环出口之后**（2734-2775 行）还有三步收尾，顺序讲究：

```rust
// 来源：codex-rs/core/src/session/turn.rs:2744-2775（删节）
let tool_blocking_timing_guard = if in_flight.is_empty() {
    None
} else {
    Some(turn_context.turn_timing_state.begin_tool_blocking())
};
drain_in_flight(&mut in_flight, sess.clone(), turn_context.clone()).await?;
drop(tool_blocking_timing_guard);

if should_emit_token_count {
    // A tool call such as request_user_input can intentionally pause the turn. Emit token
    // counts only after pending tools resolve so clients do not see progress events while the
    // turn is waiting on the user.
    sess.send_token_count_event(&turn_context).await;
}

if cancellation_token.is_cancelled() {
    return Err(CodexErr::TurnAborted);
}

if should_emit_turn_diff {
    let unified_diff = {
        let tracker = turn_diff_tracker.lock().await;
        tracker.get_unified_diff()
    };
    if let Some(unified_diff) = unified_diff {
        let msg = EventMsg::TurnDiff(TurnDiffEvent { unified_diff });
        sess.clone().send_event(&turn_context, msg).await;
    }
}

outcome
```

`drain_in_flight`（`turn.rs:2130-2154`）逐个收割工具 future，把每个 `ResponseInputItem`（即工具结果）`record_conversation_items` 落史。`FuturesOrdered` 保证**按提交顺序收割**——即使第二个工具先跑完，历史里结果的顺序也与模型发起调用的顺序一致，这对历史可读性和缓存前缀稳定都重要。`TokenCount` 故意等工具跑完才发（注释解释了原因：`request_user_input` 这类工具会暂停回合等用户，不能让用户看到进度事件假装还在跑）。最后检查打断令牌、发 `TurnDiff`（本回合累计的文件改动 diff）。

还有一点容易被忽略：这段收尾代码在 `outcome` 为 `Err` 时**同样执行**（`outcome` 直到最后才返回）。也就是说流中途网络出错时，已经发出的工具调用依然会跑完、结果落史，然后错误才上抛给 7.5 的重试循环——这正是重试时必须重新 `clone_history()` 的原因：失败的那次尝试并非"什么都没发生"。

### 7.7 工具分发的分叉口：`handle_output_item_done`

`handle_output_item_done`（`stream_events_utils.rs:289-391`）先用 `ToolRouter::build_tool_call`（`tools/router.rs:148-200`）尝试把 `ResponseItem` 翻译成 `ToolCall`——`FunctionCall`/`CustomToolCall`/客户端执行的 `ToolSearchCall` 是工具，其余（消息、推理、服务端执行的调用）返回 `Ok(None)`。然后三分叉：

```rust
// 来源：codex-rs/core/src/stream_events_utils.rs:297-327（删节）
match ToolRouter::build_tool_call(item.clone()) {
    // The model emitted a tool call; log it, persist the item immediately,
    // and queue the tool execution.
    Ok(Some(call)) => {
        // ...
        record_completed_response_item(ctx.sess.as_ref(), ctx.turn_context.as_ref(), &item)
            .await;                                  // ← ① 工具调用条目立即落史

        let cancellation_token = ctx.cancellation_token.child_token();
        let tool_future: InFlightFuture<'static> = Box::pin(
            ctx.tool_runtime
                .clone()
                .handle_tool_call(call, cancellation_token),
        );                                           // ← ② 生成执行 future，但不 await

        output.needs_follow_up = true;               // ← ③ 调了工具 ⇒ 还要再来一轮
        output.tool_future = Some(tool_future);
    }
```

注意顺序：**先把 `FunctionCall` 条目本身落史，再开始执行**。函数文档注释（`stream_events_utils.rs:190-192`）说明理由：「This records items immediately so history and rollout stay in sync even if the turn is later cancelled」——回合中途被打断时，rollout 里不会出现"有工具结果却没有工具调用"的孤儿条目。顺序永远是 `FunctionCall` →（执行）→ `FunctionCallOutput`。

`Ok(None)` 分支（330-361 行）处理非工具输出：转成 `TurnItem`，发 `ItemStarted`/`ItemCompleted` 事件，落史，并提取 `last_agent_message`（助手消息的正文，用于回合结束时的 `TurnComplete`）。**注意这个分支不设 `needs_follow_up`**——纯文本回复意味着模型说完了，这是正常终止的核心信号。

`Err(FunctionCallError::RespondToModel(message))` 分支（363-383 行）很有意思：有些"错误"不是给用户的，是**给模型的**——比如 `tool_search` 参数解析失败。Codex 把错误消息包装成 `FunctionCallOutput` 直接落史，设 `needs_follow_up = true`，让模型在下一轮自己看到这个错误并修正。这就是"让模型自我纠错"的机制化：解析失败不打断回合，而是变成上下文的一部分。

`Err(FunctionCallError::Fatal(message))` 才是致命的，直接 `CodexErr::Fatal` 上抛终止回合。

### 7.8 工具执行：`ToolCallRuntime` 与并行门闸

`handle_output_item_done` 只造 future，真正的执行在 `ToolCallRuntime::handle_tool_call`（`tools/parallel.rs:73-89`）→ `handle_tool_call_with_source`（92-208 行）。后者把 dispatch 包进 `tokio::spawn`，外层用 `tokio::select!` 同时等两个分支：

```rust
// 来源：codex-rs/core/src/tools/parallel.rs:177-206（删节）
async move {
    let _tool_call_timing_guard = tool_call_timing_guard;
    tokio::select! {
        res = &mut dispatch_handle => res.map_err(Self::tool_task_join_error)?,
        _ = cancellation_token.cancelled() => {
            if terminal_outcome_reached.load(Ordering::Acquire) || dispatch_handle.is_finished() {
                dispatch_handle.await.map_err(Self::tool_task_join_error)?
                // ← 已经跑到终态（结果/错误已产生）：让它收完，保留结果
            } else {
                // ...
                dispatch_handle.abort();   // ← 还在跑：杀掉
                // ...
                let response = Self::aborted_response(&call, secs);  // ← 合成"被中止"的输出
                notify_tool_aborted(/* ... */).await;
                Ok(response)
            }
        }
    }
}
```

被打断的工具不会让回合崩掉：它产出一个合成的 `"aborted by user after N.Ns"` 工具结果（`parallel.rs:254-258`）。这样即使按了 Esc，历史里 `FunctionCall`/`FunctionCallOutput` 仍然成对完整——**历史一致性优先于"如实反映没跑完"**。模型下一回合看到的是"工具被用户中止"，而不是一个悬空调用。

并发控制是一个 `RwLock`（`parallel.rs:46, 152-156`）：声明支持并行的工具（只读类，如文件读取）拿读锁可以并发跑；其余拿写锁独占。工具是否支持并行由 `ToolRouter::tool_supports_parallel` 决定（路由与审批细节见[第 9 章](ch09-tools.md)、[第 11 章](ch11-sandbox-approval.md)）。`Prompt.parallel_tool_calls = true` 允许模型一次响应里发多个调用，配合 `FuturesOrdered`，多个工具**并发执行、按序收割**。

### 7.9 历史增长时序：一轮一轮看清楚

把前面所有片段拼成一次典型回合（两次采样请求）的历史视角时序：

```
采样请求 #1  input = [..., UserMessage("修一下那个报错")]
   │  流消费：
   │    OutputItemDone(FunctionCall{name:"shell", call_id:"c1"})
   │      → FunctionCall 立即落史；future 入 in_flight；needs_follow_up=true
   │    Completed{end_turn: None}
   ▼  drain_in_flight：shell 跑完
   FunctionCallOutput{call_id:"c1"} 落史（+ rollout）
history = [..., UserMessage, FunctionCall c1, FunctionCallOutput c1]
   │
外层循环：needs_follow_up ⇒ 再来一轮
   │
采样请求 #2  input = 全量 history（上面那整份，末尾多了两条）
   │  流消费：
   │    OutputItemAdded(AgentMessage)  → TurnItem Started 事件
   │    OutputTextDelta × N           → AgentMessageContentDelta 事件 × N
   │    OutputItemDone(Message)       → 落史；last_agent_message 更新
   │    Completed{end_turn: Some(true)}
   ▼
history = [..., UserMessage, FCall c1, FCallOutput c1, AssistantMessage]
needs_follow_up = false ⇒ 外层循环收尾
```

每一轮之间历史只往末尾追加，从不修改前面的条目（压缩除外，那是"受控改写"，见[第 8 章](ch08-context-compact.md)）。全量重发 + 前缀缓存让这个朴素策略在生产上成立。

### 7.10 外层循环（下）：终止与继续的决策点

`run_sampling_request` 返回后，外层循环的决策段（`turn.rs:394-551`）是回合的"交通指挥中心"。核心变量：

- `model_needs_follow_up`：本轮有工具调用，或服务端 `end_turn == Some(false)`；
- `has_pending_input`：用户在模型运行时又敲了消息（挂起队列非空）；
- `token_limit_reached`：`context_window_token_status`（`session/context_window.rs:23-91`）算出 token 触顶。

```rust
// 来源：codex-rs/core/src/session/turn.rs:458-470（删节）
let should_roll_over = needs_follow_up
    && (sess.take_new_context_window_request().await || token_limit_reached);
let allow_auto_compact_fallback = !should_roll_over && !token_limit_reached;
super::token_budget::maybe_record(
    sess.as_ref(),
    turn_context.as_ref(),
    token_status.base_window_tokens_remaining,
    allow_auto_compact_fallback,
)
.await;

// as long as compaction works well in getting us way below the token limit,
// we shouldn't worry about being in an infinite loop.
if should_roll_over {
    if let Err(err) = run_auto_compact(
        &sess,
        Arc::clone(&step_context),
        /*fallback_step_context*/ None,
        &mut client_session,
        // ...
        CompactionReason::ContextLimit,
        CompactionPhase::MidTurn,      // ← 回合中压缩
    )
    .await
    { /* ... */ }
    // ...
    continue;   // ← 压缩完历史变短了，继续循环
}
```

注意 469 行那句注释，它是理解 Codex 终止设计的关键：**`run_turn` 没有"最大工具调用轮数"上限**。防爆靠的是两个机制：token 触顶触发压缩把历史压短（而不是停），以及用户随时可以打断。这与 my-agent 常见的 `max_iterations = 50` 是不同的哲学，设计取舍一节展开。

然后是正常终止路径（500-551 行）：`!needs_follow_up` 时还要过两道闸——

1. **Stop hooks**（502-538 行）：`run_turn_stop_hooks` 允许配置的 hook"拦停"回合结束并注入续跑指令（`should_block` + 构造 hook prompt 落史后 `continue`）。回合结束不是模型单方面说了算。
2. **legacy after-agent hook**（539-548 行）。

都过了就 `break`，`run_turn` 返回 `Ok(last_agent_message)`。`RegularTask` 的外层小循环再检查一次挂起队列，干净则任务结束，`on_task_finished`（`tasks/mod.rs:571-…`）发出终态事件：

```rust
// 来源：codex-rs/core/src/tasks/mod.rs:806-815
EventMsg::TurnComplete(TurnCompleteEvent {
    turn_id: turn_context.sub_id.clone(),
    last_agent_message,          // ← 从 run_turn 一路传回来的最终回复
    error,
    started_at,
    completed_at,
    duration_ms,
    time_to_first_token_ms,
})
```

错误路径在 `turn.rs:553-584`：`TurnAborted`（打断）原样上抛，最终变成 `EventMsg::TurnAborted`；`InvalidImageRequest` 等特殊错误转成友好提示；其余错误发 `EventMsg::Error` 后 `break`——注释说「let the user continue the conversation」，**一次采样失败不杀死主线**，用户可以继续发消息。

打断的完整链路：`Op::Interrupt` → `handlers.rs:60-62` 的 `interrupt()` → `Session::interrupt_task`（`session/mod.rs:4151-4158`）→ `abort_all_tasks(Interrupted)`（`tasks/mod.rs:494-…`）cancel 任务的 `CancellationToken`。这个令牌树一路传到 `stream.next().or_cancel(...)`、工具执行的 `select!` 分支——**打断不是轮询标志位，而是结构化的取消信号**，每个 `.await` 点都是响应点。

### 7.11 事件流时序：UI 看到什么

把一次成功回合对外发的事件按时间排一遍（括号里是发出位置）：

```
TurnStarted                        (RegularTask::run, regular.rs:50-57)
  ├─ TurnItem Started(AgentMessage)      (OutputItemAdded, turn.rs:2463)
  │    AgentMessageContentDelta × N       (OutputTextDelta, turn.rs:2610)
  ├─ TurnItem Started(CommandExecution)   (工具类条目的 started)
  │    （工具参数 diff 事件，TUI 渲染补丁预览）
  │    TurnItem Completed(CommandExecution)（工具跑完）
  ├─ TokenCount                          (drain 完之后, turn.rs:2757)
  ├─ TurnDiff                            (本回合文件改动, turn.rs:2770)
  │    …若有下一轮工具调用，上面序列重复…
  └─ StreamError("Reconnecting...")      （仅在重试时, responses_retry.rs:116）
TurnComplete / TurnAborted / Error   (on_task_finished, tasks/mod.rs:788-816)
```

TUI 屏幕上你看到的"逐字打印 → 命令卡片 → diff 摘要 → 输入框亮起"，就是这条事件流的渲染（渲染侧见[第 14 章](ch14-tui.md)）。app-server 客户端收到的是同一条流（[第 15 章](ch15-app-server.md)）。

## 设计取舍

### 对照 my-agent：200 行循环的五个失控点

回到开头那段 200 行 while 循环，逐点对比：

**失控点 1：打断。** my-agent 的 `await runTool(call)` 是不可中断的：Esc 只能设置一个标志位，等当前工具跑完才生效；更糟的是 `for await (const chunk of res)` 也在等网络。Codex 的做法是 `CancellationToken` 树：`start_task` 建根令牌，每个采样请求、每个工具调用都拿 `child_token()`（`turn.rs:389, 1397`、`stream_events_utils.rs:319`），`abort_all_tasks` cancel 根，整棵树枯萎。每个 `.await` 都用 `.or_cancel(&token)` 或 `select!` 包裹。这不是语言差异（TS 有 `AbortController`），是**纪律差异**：取消令牌作为一等参数贯穿所有签名，而不是挂在全局。

**失控点 2：回合中输入。** my-agent 里用户中途输入的消息只能 push 进 `messages`，要等本轮 `break` 后才被看到——如果模型正在连发十个工具调用，用户的话要等十轮。Codex 的挂起队列（`TurnInputQueue`）在外层循环**每轮开头**被 drain 落史（`turn.rs:305-323`），下一次采样请求自然带上；`start_or_steer` 让"开新回合"和"插队"共用一个入口。结构上，输入源从"循环参数"变成了"循环每轮都检查的队列"。

**失控点 3：流式失败时的历史一致性。** my-agent 的典型 bug：流中途网络错误，已经执行了两个工具，第三个工具调用在响应里但还没收到完整 JSON——`messages` 里现在有两个 `FunctionCallOutput` 没有对应 `FunctionCall`，下一次请求直接被 API 拒绝（Anthropic/OpenAI 都校验配对）。Codex 的三条防线：`OutputItemDone` 时**立即落史**工具调用条目（先于执行）；工具被中止时合成 aborted 输出补齐配对（`parallel.rs:177-206`）；中层重试时重新 `clone_history()` 而不是复用旧输入（`turn.rs:1369-1375`）。历史的每个前缀都合法。

**失控点 4：死循环。** my-agent 靠 `max_iterations` 硬顶——顶到了就半途而废，任务做了一半。Codex 干脆没有这个上限，回合中 token 触顶走 `run_auto_compact`（`CompactionPhase::MidTurn`）把历史压短**继续干活**（`turn.rs:469-498`），那句注释「as long as compaction works well in getting us way below the token limit, we shouldn't worry about being in an infinite loop」就是这个赌注的书面化。赌注的代价是：压缩质量成了可用性关键路径（第 8 章），而且如果模型陷入"调同一个工具失败一百次"的模式，只能靠用户打断——这是坦诚的局限。

**失控点 5：工具并发与顺序。** my-agent 串行 `await` 每个工具，慢但简单；想并发就得自己处理结果顺序、错误聚合、部分取消。Codex 用 `FuturesOrdered` 拿并发执行 + 保序收割，用 `RwLock` 做"只读工具并行、其余独占"的准入闸，用 per-call 的 `child_token` 做选择性中止。每条都不复杂，但组合起来就是那 600 行 `parallel.rs`。

### 其它值得注意的取舍

**为什么历史要"立即落史"而不是攒到回合结束？** 除了上面说的配对完整性，还有 rollout 持久化的同构需求：rollout JSONL 是逐条 append 的（[第 13 章](ch13-persistence.md)），内存历史与磁盘历史共用同一条 `record_conversation_items` 路径（`session/mod.rs:3062-3117`），崩溃恢复时能精确重建到"最后一个完成的条目"。

**为什么一个回合一份 `ModelClientSession`？** WebSocket 复用 + 增量请求（`get_incremental_items`，`client.rs:1244-1282`）让回合内第二轮起只发送历史**增量**而不是全量——这与"逻辑上全量重发"不矛盾：协议层仍是全量语义，传输层在确认"本轮输入是上一轮输入 + 上轮响应条目的严格超集"时才走增量捷径，否则回退全量。粘性路由 token（`turn_state`）同理，回合内复用、回合间必须丢弃。这是一处"逻辑简单、传输优化"的干净分层。

**为什么 step 级快照（`StepContext`）而不是全用 `TurnContext`？** 注释里满屏的「Legacy turn model; step-scoped execution should use `StepContext`」说明这是演进中的重构：模型 fallback、压缩用模型、Guardian 审批策略都可能在回合中途变化。把"这次请求"的不变量钉成一个结构体，比在 40 个字段的 `TurnContext` 里争论"这个字段此刻还有效吗"要可靠。

**代价。** `turn.rs` 单文件 2791 行，`try_run_sampling_request` 一个函数近 600 行、11 个参数、`match` 十几个变体——它已经顶到仓库自己 AGENTS.md 里「模块超 800 行就该拆」的红线。Plan 模式的流式状态（`PlanModeStreamState`）、multi-agent mailbox 抢占（`preempt_for_mailbox_mail`）、analytics 采样都挤在这个循环里，读代码时要有意识地过滤。功能上，无上限循环依赖压缩兜底这一点，对非 OpenAI provider（压缩能力参差）是真实风险。

## 动手实验

**实验 1：找到三层循环。**

```shell
cd codex-rs
rg -n "pub\(crate\) async fn run_turn" core/src/session/turn.rs
# 预期：turn.rs:153
rg -n "async fn (run_sampling_request|try_run_sampling_request)" core/src/session/turn.rs
# 预期：turn.rs:1340 和 turn.rs:2179
```

**实验 2：用日志看 loop 的真实节奏。** 工具调用在分发时会打一条 info 日志（`stream_events_utils.rs:309-314` 的 `ToolCall: ...`），采样后的 token 决策打 trace：

```shell
RUST_LOG=codex_core=info cargo run --bin codex -- exec \
  "list the files in the current directory, then tell me which is largest" \
  2>&1 | rg "ToolCall|sampling|TurnStarted"
# 预期形态：至少一条 ToolCall: <工具名> <参数预览>（模型列目录），
# 随后模型基于输出再回答——两个 sampling 阶段，至少一条工具调用
```

把日志级别调到 trace 能看到外层循环每轮的 token 决策（`turn.rs:426-440` 的 `post sampling token usage`，含 `needs_follow_up`、`token_limit_reached` 等字段），这是观察"外层循环跑了几轮、每轮为什么继续/停止"的最直接窗口。

**实验 3：从 rollout 文件验证历史增长。** 回合进行中打开本会话的 rollout（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）：

```shell
tail -f ~/.codex/sessions/$(date +%Y/%m/%d)/rollout-*.jsonl | rg '"type"'
# 预期形态：依次出现
#   ... "type":"function_call"  （OutputItemDone 时立即落史）
#   ... "type":"function_call_output" （drain_in_flight 收割后）
#   ... "type":"message" role:"assistant" （回合收尾）
# 若在工具执行时按 Esc，会看到 function_call_output 里带着 aborted 字样——
# 那就是 parallel.rs 合成的中止输出，配对依然完整
```

**实验 4：观察打断路径。**

```shell
rg -n "TurnAborted" core/src/session/turn.rs core/src/tasks/mod.rs | head
# 预期：turn.rs 里流消费、压缩等处的 TurnAborted 上抛点，
#       tasks/mod.rs:791-797 的 TurnAborted 事件构造
rg -n "or_cancel" core/src/session/turn.rs | head
# 预期：每个可能长等 await 上的取消点
```

## Rust 侧栏

- **`CancellationToken` 树（tokio-util）**：`child_token()` 派生的子令牌随父令牌一起被取消，也可单独取消。Codex 把它当"结构化并发的中断线"用：session → task → 采样请求 → 单个工具，层层派生。配合 `.or_cancel(&token).await`（本仓库 `codex_async_utils` 的扩展 trait）把任意 future 变成"可被取消、取消时返回 `CancelErr`"。TS 类比：`AbortSignal`，但没有"取消是返回值的正常分支"这层类型保障，全靠约定。
- **`FuturesOrdered`**：`futures` crate 的并发容器，`push_back` 进去的未来并发轮询，`next().await` 按**入队顺序**吐结果。比 `join_all` 灵活（可以边产生边消费），比 `FuturesUnordered` 多保序。代价是头部阻塞：第一个 future 卡住会挡住后面已完成的结果——对"工具结果必须按调用顺序落史"这正是想要的语义。
- **`Arc::make_mut` 写时复制**：`ContextManager` 的历史是 `Arc<Vec<...>>`；`clone_history()` 克隆只复制 Arc 指针（O(1)），真正 `record_items` 写入时 `Arc::make_mut` 检测到共享就深拷贝一份再改。读者（for_prompt、快照）永远看不到写一半的状态，也无需锁。TS 里没有对应物——这利用了 Rust 的所有权：`make_mut` 在"还有别的引用"时才会复制，独占时直接原地改。
- **trait 里的 `impl Future`（RPITIT）**：`SessionTask::run` 的签名是 `fn run(...) -> impl Future<Output = SessionTaskResult> + Send`（`tasks/mod.rs:205-211`），不需要 `#[async_trait]` 宏的装箱开销；跨 trait 对象分发时再用 `AnySessionTask` 的 `BoxFuture` 桥接（`tasks/mod.rs:229-276`）。读这套代码时认出"泛型静态分发 → trait object 动态分发"的两段式即可。
- **`loop { ... break Err(...); }` 作为表达式**：`try_run_sampling_request` 里 `let outcome: CodexResult<_> = loop { ... }`——Rust 的 `loop` 可以带值 `break`，把"循环直到分出胜负"写成一个表达式，`match` 臂里 `break Err(err)` 直接决定整个结果，避免一坨标志位。

## 小结 + 思考题

本章走完了 Agent Loop 的完整实现：`Op::TurnInput` 经 `turn_input::handle` 判定 start/steer，`RegularTask` 壳里 `run_turn` 开跑；外层循环每轮 drain 挂起输入、捕获 `StepContext`、全量重发历史；中层重试循环对冲网络故障并可降级传输；内层流消费循环把 `ResponseEvent` 逐条变成"落史 + 事件 + 工具 future"；工具经 `ToolCallRuntime` 并发执行、按序收割、结果成对落史；回合在"模型不再调工具且无挂起输入"时正常结束，在 token 触顶时压缩续跑，在打断时沿 `CancellationToken` 树快速收尸。对照 my-agent 的 200 行循环，Codex 多出来的几千行买的主要是五样东西：可打断、可插队、历史始终合法、无硬上限、并发保序。

思考题：

1. `OutputItemDone` 时工具调用条目**先于执行**落史。如果改成"执行完连同结果一起落史"，会在哪些场景出问题？（提示：打断 + rollout 恢复，见[第 13 章](ch13-persistence.md)。）
2. `run_turn` 没有最大轮数上限。如果让你给 my-agent 设计同样的"无上限但可控"机制，除了压缩你还需要什么信号？（提示：`turn.rs:469` 注释成立的前提是什么？）
3. steer 输入在外层循环开头才落史，而不是到达时立刻落史。为什么？如果到达时立刻落史，正在途中的那次采样请求的响应条目会落在这条用户消息**之后**——而模型生成它时根本没看到这条消息。这对"请求-响应"的时序对应关系意味着什么？
4. 读 `try_run_sampling_request` 里 `preempt_for_mailbox_mail` 分支（`turn.rs:2361-2404`）：什么样的条目会让 loop 提前中断当前流去处理子 Agent 来信？这个设计和 steer 的"等下一轮自然带上"有何不同，为什么？
