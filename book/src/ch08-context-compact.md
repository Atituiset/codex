# 第 8 章 上下文管理与压缩

## 本章导读

第 7 章走完了 Agent Loop 的主循环：每轮采样都把整段历史重新发给模型。这就埋下一个迟早爆炸的问题——**上下文窗口（context window）是有限的，而对话是无限增长的**。`cat` 一个大文件、`cargo test` 输出几千行、模型自己写的长回复，全都是往历史里堆 token。一个 272K token 的窗口，一次大的工具输出就能吃掉几万。

如果你在 my-agent 里写过 `ContextManager`，大概率是这样：一个 `messages: Message[]` 数组，每次请求前数一下 token，超了就砍掉最老的几条，或者调一次模型让它写摘要、把摘要塞回去。写完你很快会遇到三个麻烦：砍的时候把一个 `tool_use` 砍了却留下了 `tool_result`，API 直接 400；摘要里混进了上一轮的临时指令，模型把摘要当成新指令执行；token 计数和计费对不上，要么过早压缩浪费钱，要么过晚压缩请求被拒。

Codex 对这三个问题都给了工程化的答案，这正是本章要读的内容：

- **token 如何计量**：服务端返回的真实 usage 为主，本地 4 字节/token 的粗估为辅，两者如何合成一个「当前用了多少」的数字；
- **何时触发压缩**：回合（turn）开始前和每轮采样结束后各检查一次，阈值如何计算；
- **压缩如何不破坏工具调用配对**：`function_call` 与 `function_call_output` 必须成对出现，这是 Responses API 的硬性约束，Codex 用一套 normalize 不变量保证任何裁剪都不破坏它。

本章还会讲清本基线里**三条压缩路径**的分工：本地摘要压缩（`compact.rs`）、远端压缩（`compact_remote*.rs`，把压缩交给服务端做）、以及 token-budget 特性下的「开新窗口」式压缩（`compact_token_budget.rs`）。读完后你会理解为什么压缩在 Codex 里不是「删消息」，而是「改写本地历史，下一次全量重发即生效」——这与第 4 章讲的 `store: false` 请求模型是同一个硬币的两面。

## 源码地图

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-rs/core/src/context_manager/history.rs` | `ContextManager`：内存中的会话历史容器 | 全书的心脏之一，所有裁剪/替换都经过它 |
| `codex-rs/core/src/context_manager/normalize.rs` | 历史规范化：补齐缺失输出、删除孤儿输出、剥离不支持的多模态内容 | 工具调用配对不变量的唯一执行者 |
| `codex-rs/core/src/compact.rs` | 本地压缩：构造摘要 prompt、调模型、重建历史 | 最经典的一条路径，先读它 |
| `codex-rs/core/src/compact_remote.rs` + `compact_remote_request.rs` | 远端压缩：POST `/responses/compact`，服务端返回压缩后的历史 | OpenAI 后端的默认路径 |
| `codex-rs/core/src/compact_remote_v2.rs` | 远端压缩 v2：用 `compaction_trigger` 条目走普通 Responses 端点 | 特性开关 `RemoteCompactionV2` 控制 |
| `codex-rs/core/src/compact_remote_history.rs` | 把历史按「条目 + 附属通知」分组 | 裁剪时以组为单位，避免拆散关联条目 |
| `codex-rs/core/src/compact_token_budget.rs` | token-budget 模式的压缩：不摘要，直接开新上下文窗口 | 同走压缩生命周期（hooks、事件）但跳过重述 |
| `codex-rs/core/src/session/context_window.rs` | 计算 token 状态：当前用量、压缩阈值、是否触顶 | 触发逻辑的「仪表盘」 |
| `codex-rs/core/src/session/token_budget.rs` | token 预算提醒与 fallback prompt 注入 | 接近上限时先礼后兵 |
| `codex-rs/core/src/session/turn.rs` | 压缩的两个触发点（回合前 / 采样后）与三路分发 | 本章流程走读的主线 |
| `codex-rs/core/src/tasks/compact.rs` | `/compact` 手动压缩的任务封装 | `Op::Compact` 的落点 |
| `codex-rs/core/src/context/` | `ContextualUserFragment` 注入片段体系（约 40 种片段） | 历史里那些「不是用户也不是模型说的话」 |
| `codex-rs/prompts/templates/compact/prompt.md` | 摘要 prompt 模板 | 压缩质量的上游 |
| `codex-rs/protocol/src/models.rs` | `ResponseItem` 的 `Compaction` / `CompactionTrigger` / `ContextCompaction` 变体 | 压缩在协议层的痕迹 |

## 核心数据结构

### `ContextManager`：内存中的会话历史

第 5 章讲过 `ResponseItem` 是协议层的通用条目。在内存里，历史就是一个按时间顺序排列的 `ResponseItem` 列表，由 `ContextManager` 持有：

```rust
// 来源：codex-rs/core/src/context_manager/history.rs:43-65
/// Transcript of thread history
#[derive(Debug, Clone, Default)]
pub(crate) struct ContextManager {
    /// The oldest items are at the beginning of the vector. Snapshots share the vector until a
    /// caller needs to mutate it, avoiding deep copies for read-only history consumers.
    items: Arc<Vec<ResponseItemEnvelope>>,
    /// Bumped whenever history is rewritten, such as compaction or rollback.
    history_version: u64,
    token_info: Option<TokenUsageInfo>,
    /// Reference context snapshot used for diffing and producing model-visible
    /// settings update items.
    // ...
    reference_context_item: Option<TurnContextItem>,
    /// World state most recently appended to model-visible history.
    world_state_baseline: Option<WorldStateSnapshot>,
}
```

四个字段各有讲究：

- `items` 用 `Arc<Vec<...>>` 包裹而不是裸 `Vec`：Session 经常要克隆历史快照（比如压缩时、构造请求时），`Arc` 让只读快照零拷贝共享同一份底层数组，真要改的时候 `Arc::make_mut` 才做一次写时拷贝（Rust 侧栏会解释）。
- `history_version` 是「历史被改写过几次」的计数器，压缩和回滚都会让它 +1——外部消费者（如扩展 API 的快照）靠它判断缓存是否失效。
- `token_info` 是最近一次模型响应带回的真实 token 用量，计量一节细讲。
- `reference_context_item` / `world_state_baseline` 是「注入片段」的基线：Codex 不把环境信息一次性写死，而是每回合 diff 出变化再注入，这两个字段就是 diff 的参照物（详见第 7 章对上下文组装的讲解）。

列表里的元素不是裸 `ResponseItem`，而是包了一层信封：

```rust
// 来源：codex-rs/history/src/lib.rs:34-41
/// A model-history item with room for history-only metadata.
///
/// Persistence keeps the response item intact and stores its metadata separately.
#[derive(Debug, Clone, PartialEq)]
pub struct ResponseItemEnvelope {
    pub item: ResponseItem,
    pub metadata: Option<CodexHarnessMetadata>,
}
```

`metadata` 放的是「只属于 harness、不进模型请求」的附加信息（比如这条 developer 消息是不是 app-server 客户端写的）。这个设计让「发给模型的」和「持久化的」可以共享同一份条目，又各自有扩展余地。

### 压缩在协议层的三个变体

压缩不只是一次内部操作，它在 `ResponseItem` 里有正式的条目类型（models.rs:1155-1177）：

```rust
// 来源：codex-rs/protocol/src/models.rs:1155-1177（删节）
#[serde(alias = "compaction_summary")]
Compaction {
    id: Option<ResponseItemId>,
    encrypted_content: String,        // ← 服务端压缩产生的加密摘要
    // ...
},
// Compaction triggers are request controls, not durable response items.
CompactionTrigger {},                  // ← 请求控制：告诉服务端"请压缩"
ContextCompaction {
    id: Option<ResponseItemId>,
    encrypted_content: Option<String>,
    // ...
},
```

注意 `CompactionTrigger` 上方的注释：**它是请求控制，不是可持久化的历史条目**。这一点在 `ContextManager` 里也有对应——`is_api_message`（history.rs:585-605）明确把 `CompactionTrigger` 排除在可记录条目之外。远端压缩 v2 就是靠往请求里塞一个 `CompactionTrigger` 来让服务端就地压缩的。

### token 用量：`TokenUsage` 与 `TokenUsageInfo`

```rust
// 来源：codex-rs/protocol/src/protocol.rs:2079-2107（删节）
pub struct TokenUsage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
    // ...
}

pub struct TokenUsageInfo {
    pub total_token_usage: TokenUsage,      // ← 整个会话累计（计费视角）
    pub last_token_usage: TokenUsage,       // ← 最近一次响应（窗口占用视角）
    pub model_context_window: Option<i64>,
}
```

区分 `total` 与 `last` 是关键：因为 Codex 发请求带 `store: false`、每次全量重发历史（第 4 章），**`last_token_usage.total_tokens` 就近似等于"当前历史的体量"**——上一次请求的输入就是完整历史。于是「当前上下文占了多少窗口」不需要客户端从头到尾数一遍，拿服务端最近一次报数再加一个增量修正即可。

### 注入片段：`ContextualUserFragment`

历史里除了用户消息和模型输出，还有大量 Codex 自己注入的内容：环境上下文、当前时间提醒、token 预算提醒……它们统一实现 `ContextualUserFragment` trait：

```rust
// 来源：codex-rs/context-fragments/src/fragment.rs:14-46（删节）
pub trait ContextualUserFragment {
    fn role(&self) -> &'static str;               // ← 注入成 user 还是 developer 角色

    /// Whether this fragment must be recorded as its own response item.
    fn requires_separate_message(&self) -> bool { false }

    fn markers(&self) -> (&'static str, &'static str);  // ← 起止标记，如 <environment_context>

    fn body(&self) -> String;

    fn render(&self) -> String {
        let (start_marker, end_marker) = self.markers();
        let body = self.body();
        if start_marker.is_empty() && end_marker.is_empty() {
            return body;
        }
        format!("{start_marker}{body}{end_marker}")     // ← 标记包裹正文
    }
    // ...
}
```

`codex-rs/core/src/context/` 下有约 40 个这样的片段类型。为什么需要 `markers()`？因为注入的内容混在历史里，日后要能**认出来**——回滚时要剥掉它们（history.rs:532-560 的 `trim_pre_turn_context_updates`），对扩展 API 暴露历史时要过滤它们（history.rs:82-88），token-budget 的提醒片段也是这么被认出来的。没有标记的纯文本消息一旦进历史就再也分不清是用户写的还是系统塞的，这是 my-agent 式「直接 push 一条 user 消息」做法的典型坑，Codex 用标记把这个问题消灭了。

## 流程走读

### 全景：从用户输入到压缩完成的链路

```
用户输入 / /compact 命令
   │
   ├─ Op::TurnInput ──► RegularTask ──► run_turn() (turn.rs)
   │                        │
   │                        ├─ run_pre_sampling_compact()   ← 触发点 1：回合开始前
   │                        │      token_limit_reached? ──► run_auto_compact()
   │                        │
   │                        ├─ run_sampling_request()  ← 正常 Agent Loop（Ch7）
   │                        │      │
   │                        │      ▼ 采样结束后
   │                        ├─ context_window_token_status()  ← 触发点 2：每轮采样后
   │                        │      token_limit_reached? ──► run_auto_compact()（MidTurn）
   │                        │
   └─ Op::Compact ──► handlers::compact() ──► CompactTask ──► run_compact_task()（手动）

run_auto_compact() (turn.rs:1178-1258) 三路分发：
   ├─ Feature::TokenBudget 开启     ──► compact_token_budget.rs   （开新窗口，不摘要）
   ├─ provider 支持远端压缩          ──► compact_remote.rs / _v2   （服务端压缩）
   └─ 否则                           ──► compact.rs               （本地摘要压缩）
                                        │
                                        ▼
                        sess.replace_compacted_history()  ← 改写本地历史
                                        │
                                        ▼
                        下一次采样 for_prompt() ──► normalize_history() 保证配对
```

### 第一步：token 如何计量

Codex 用的是「服务端真实用量 + 本地增量估算」的混合策略。核心在 `ContextManager::get_total_token_usage`（history.rs:421-438）：

```rust
// 来源：codex-rs/core/src/context_manager/history.rs:421-438（删节）
pub(crate) fn get_total_token_usage(&self, server_reasoning_included: bool) -> i64 {
    let last_tokens = self
        .token_info
        .as_ref()
        .map(|info| info.last_token_usage.total_tokens)
        .unwrap_or(0);
    let items_after_last_model_generated_tokens = self
        .items_after_last_model_generated_item()
        .map(estimate_item_token_count)
        .fold(0i64, i64::saturating_add);
    if server_reasoning_included {
        last_tokens.saturating_add(items_after_last_model_generated_tokens)
    } else {
        last_tokens
            .saturating_add(self.get_non_last_reasoning_items_tokens())
            .saturating_add(items_after_last_model_generated_tokens)
    }
}
```

逻辑是：**以最近一次响应的 `total_tokens` 为基数，加上那之后本地追加的条目（主要是工具输出）的估算值**。因为工具输出是在收到上次响应之后才执行、才进历史的，服务端还没见过它们，只能本地估。`server_reasoning_included` 区分服务端是否已把加密 reasoning 的 token 计入用量，避免重复计算。

本地估算本身是个刻意的粗活——4 字节按 1 token 算：

```rust
// 来源：codex-rs/utils/string/src/truncate.rs:4,71-78
const APPROX_BYTES_PER_TOKEN: usize = 4;
// ...
pub fn approx_token_count(text: &str) -> usize {
    let len = text.len();
    len.saturating_add(APPROX_BYTES_PER_TOKEN.saturating_sub(1)) / APPROX_BYTES_PER_TOKEN
}
```

单条目的估算在 `estimate_item_token_count`（history.rs:623-626）：把条目 JSON 序列化，按字节数换算。序列化的字节数天然包含了 JSON 结构开销，是个保守的下界。对 base64 图片/音频另有折算（history.rs:650-686），因为一张图的 base64 字节数远不等于它的视觉 token 数。为什么不接真 tokenizer？设计取舍一节再谈。

### 第二步：阈值与触发时机

每回合开始前（`run_pre_sampling_compact`，turn.rs:1011-1041）和每轮采样结束后（turn.rs:411-498），都会调用 `context_window_token_status` 算一次状态：

```rust
// 来源：codex-rs/core/src/session/context_window.rs:53-79（删节）
// The model's full context window is a hard cap, independent of the auto-compaction scope.
let full_context_window_limit = turn_context.model_context_window();

// Report remaining tokens against the base (unbuffered) window, capped by the full context.
let base_window_tokens_remaining = [
    tokens_remaining(auto_compact_scope_limit, auto_compact_scope_tokens),
    tokens_remaining(full_context_window_limit, active_context_tokens),
]
.into_iter()
.flatten()
.min();
// ...
// Force compaction once the buffered window or the model's full context window is reached.
let full_context_window_limit_reached =
    full_context_window_limit.is_some_and(|limit| active_context_tokens >= limit);
let token_limit_reached = buffered_auto_compact_limit
    .is_some_and(|limit| auto_compact_scope_tokens >= limit)
    || full_context_window_limit_reached;
```

阈值来自两条线的较小者：`model_auto_compact_token_limit`（压缩预算）和模型的完整上下文窗口（硬顶）。压缩预算的默认值在 `ModelInfo::auto_compact_token_limit`（openai_models.rs:486-497）：

```rust
// 来源：codex-rs/protocol/src/openai_models.rs:486-497
pub fn auto_compact_token_limit(&self) -> Option<i64> {
    let context_limit = self
        .resolved_context_window()
        .map(|context_window| (context_window * 9) / 10);
    let config_limit = self.auto_compact_token_limit;
    if let Some(context_limit) = context_limit {
        return Some(
            config_limit.map_or(context_limit, |limit| std::cmp::min(limit, context_limit)),
        );
    }
    config_limit
}
```

也就是**默认在窗口用到 90% 时压缩**，留 10% 余量给下一轮的输出。这个 `* 9 / 10` 是个有味道的数字：压缩不是免费的（要发一次完整请求），阈值定太低会频繁压缩、费钱且丢信息；定太高则可能压缩请求本身都塞不下。

触发点有两个阶段（`CompactionPhase`）：`PreTurn`（回合开始前，turn.rs:1024-1038）和 `MidTurn`（采样循环中发现需要继续但 token 已满，turn.rs:458-497）。MidTurn 的判定条件值得看一眼：

```rust
// 来源：codex-rs/core/src/session/turn.rs:458-459
let should_roll_over = needs_follow_up
    && (sess.take_new_context_window_request().await || token_limit_reached);
```

只有模型还需要继续干活（`needs_follow_up`）且 token 触顶时才中途压缩——如果模型已经说完最后一句，这个回合直接结束就好，没必要压缩。MidTurn 压缩后 `continue` 回采样循环，Agent Loop 带着瘦身后的历史继续跑，对模型和用户都无感。

### 第三步：三路压缩的分工

`run_auto_compact`（turn.rs:1178-1258）是个分发器，根据特性开关和 provider 能力选路：

```rust
// 来源：codex-rs/core/src/session/turn.rs:1189-1256（删节）
if turn_context.config.features.enabled(Feature::TokenBudget) {
    // Compaction is the reset request, so force a new context window
    // instead of consuming a pending `new_context` tool request.
    crate::compact_token_budget::run_inline_auto_compact_task(/* ... */).await?;
    return Ok(());
}

match turn_context.provider.capabilities().remote_compaction {
    RemoteCompactionSupport::V2
        if turn_context.config.features.enabled(Feature::RemoteCompactionV2) =>
    {
        run_inline_remote_auto_compact_task_v2(/* ... */).await?;   // compaction_trigger 模式
    }
    RemoteCompactionSupport::V2 => {
        run_inline_remote_auto_compact_task(/* ... */).await?;      // /responses/compact 模式
    }
    RemoteCompactionSupport::Unsupported => {
        run_inline_auto_compact_task(/* ... */).await?;             // 本地摘要
    }
}
```

三条路对应三种现实：

- **本地摘要压缩**（`compact.rs`）：兜底路径。任何 provider 都能用，因为它就是一次普通的模型调用——把摘要 prompt 追加到历史尾部，让模型自己写交接摘要。第三方 OpenAI 兼容 API 走的就是这条路。
- **远端压缩**（`compact_remote.rs` / `compact_remote_v2.rs`）：OpenAI 后端的专属路径。把整个历史 POST 给 `/responses/compact`（client.rs:163 定义了端点常量），服务端用专门调优过的压缩模型返回一份「压缩后的新历史」，客户端原样安装。v2 则更进一步，在普通 Responses 请求里放一个 `CompactionTrigger` 条目，压缩与下一轮推理在同一个请求里完成。
- **token-budget 开新窗口**（`compact_token_budget.rs`）：实验性的另一种哲学——根本不摘要，直接丢弃旧历史、开一个全新上下文窗口，靠 `TokenBudgetContext` 片段把窗口 ID 链（first/previous/current window id）注入新历史，让模型知道「你刚换了窗口，需要的信息去工具里重新取」。文件头注释说得很直白：`Token-budget compaction skips model/server summarization and installs a fresh context window instead.`（compact_token_budget.rs:21-25）

三条路共享同一套生命周期外壳：pre/post compact hooks、`ContextCompaction` 回合条目的 started/completed 事件、压缩分析埋点（`CompactionAnalyticsAttempt`，compact.rs:396-484）。UI 上看到的效果一致，只是实现不同。

### 第四步：本地压缩详解

本地路径是理解压缩语义的最好样本。`run_compact_task_inner_impl`（compact.rs:240-394）做三件事：

**(1) 把摘要 prompt 当成一条用户输入追加进历史，正常走一次流式请求：**

```rust
// 来源：codex-rs/core/src/compact.rs:118-128（run_inline_auto_compact_task 内）
let prompt = turn_context
    .config
    .compact_prompt
    .as_deref()
    .unwrap_or(SUMMARIZATION_PROMPT)      // ← 可用 config 里的 compact_prompt 覆盖
    .to_string();
let input = vec![UserInput::Text {
    text: prompt,
    // Compaction prompt is synthesized; no UI element ranges to preserve.
    text_elements: Vec::new(),
}];
```

`SUMMARIZATION_PROMPT` 的内容（prompts/templates/compact/prompt.md）很短，定位是「交接摘要」：

```text
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue
```

**(2) 流式收完，把模型输出的最后一条 assistant 消息当作摘要：** `drain_to_completed`（compact.rs:719-779）消费事件流，条目照常落进历史，直到 `Completed`。随后取最后一条 assistant 消息，拼上前缀（compact.rs:347-351）：

```rust
// 来源：codex-rs/core/src/compact.rs:347-351
let history_snapshot = sess.clone_history().await;
let history_items = history_snapshot.annotated_items();
let summary_suffix =
    get_last_assistant_message_from_turn(history_snapshot.raw_items()).unwrap_or_default();
let summary_text = format!("{SUMMARY_PREFIX}\n{summary_suffix}");
```

`SUMMARY_PREFIX`（prompts/templates/compact/summary_prefix.md）是写给「下一个模型」的说明：「另一个语言模型已经在这个问题上工作过并产出了思考摘要……请在此基础上继续，避免重复劳动。」压缩后这条带前缀的摘要会以 **user 角色**的消息出现在新历史里——注意不是 system，也不是 assistant，这与「模型把它当成交接文档而非新指令」的预期行为有关。

**(3) 重建历史：保留最近的真实用户消息 + 摘要：** `build_compacted_history`（compact.rs:639-717）：

```rust
// 来源：codex-rs/core/src/compact.rs:658-700（删节）
let mut selected_messages: Vec<CompactedUserMessage> = Vec::new();
if max_tokens > 0 {
    let mut remaining = max_tokens;              // ← COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000
    for message in user_messages.iter().rev() {  // ← 从最新往最旧挑
        // ...
        let tokens = approx_token_count(&message.message);
        if tokens <= remaining {
            selected_messages.push(message.clone());
            remaining = remaining.saturating_sub(tokens);
        } else {
            let truncated =
                truncate_text(&message.message, TruncationPolicy::Tokens(remaining));
            // ← 装不下的那条截断后也保留
            selected_messages.push(CompactedUserMessage { message: truncated, /* ... */ });
            break;
        }
    }
    selected_messages.reverse();
}
```

新历史 = 最近 20K token 以内的真实用户消息（从后往前挑，保留用户原始诉求）+ 一条摘要消息。所有 assistant 消息、reasoning、工具调用记录全部丢弃。随后 `sess.replace_compacted_history(...)`（session/mod.rs:3383-3432）安装新历史：给缺 ID 的条目补 ID、把 `RolloutItem::Compacted`（含完整替换历史）写进 rollout 文件（第 13 章会讲 resume 如何从这里重建）、递增 `history_version`。

还有一个容易忽略的防御：如果**压缩请求本身**都超过窗口了怎么办？compact.rs:309-318 的答案是循环里删掉最老的一条再重试：

```rust
// 来源：codex-rs/core/src/compact.rs:309-318（删节）
Err(e) if matches!(e.details(), CodexErrorDetails::ContextWindowExceeded) => {
    if turn_input_len > 1 {
        // Trim from the beginning to preserve cache (prefix-based) and keep recent messages intact.
        error!(
            "Context window exceeded while compacting; removing oldest history item. Error: {e}"
        );
        history.remove_first_item();
        retries = 0;
        continue;
    }
    // ...
}
```

`remove_first_item`（history.rs:279-291）删首条时会调用 `normalize::remove_corresponding_for` 把配对的另一半也删掉——配对不变量在任何裁剪路径上都被维护，下一节细说。

### 第五步：远端压缩详解

远端路径把「怎么压」整个外包给服务端，但客户端仍有不少工作。`run_remote_compact_attempt`（compact_remote_request.rs:23-102）：

```rust
// 来源：codex-rs/core/src/compact_remote_request.rs:31-46,61-70（删节）
let turn_context = &step_context.turn;
let mut history = sess.clone_history().await;
let base_instructions = sess.get_base_instructions().await;
let (rewritten_outputs, estimated_deleted_tokens) =
    trim_function_call_history_to_fit_context_window(
        &mut history,
        turn_context.as_ref(),
        &base_instructions,
    );
if rewritten_outputs > 0 {
    info!(
        turn_id = %turn_context.sub_id,
        rewritten_outputs,
        "rewrote history outputs before remote compaction"
    );
}
// ...
let prompt_input = history.for_prompt(&turn_context.model_info.input_modalities);
```

两个要点：

1. **发送前先做一轮本地瘦身**（`trim_function_call_history_to_fit_context_window`，compact_remote.rs:399-455）：从最新的条目往前扫描，把过大的工具输出整体替换成一句占位文本 `"Output exceeded the available model context and was truncated"`，直到估算总量降进窗口。替换只动 `output` 字段，`call_id` 原样保留——配对不破。这一步保证压缩请求本身能被服务端接受。
2. **安装前先做一轮过滤**（`should_keep_compacted_history_item`，compact_remote.rs:370-397）：服务端返回的新历史里，`developer` 消息、会话前缀包装等一律丢弃，只保留真实用户消息、assistant 消息和压缩条目——因为环境上下文等注入片段会由当前会话重新注入最新值，留着旧的只会造成重复和过期。

v2 路径（`compact_remote_v2.rs`）的差异主要在传输层：不再调独立的 `/responses/compact` 端点，而是在常规请求中放置 `CompactionTrigger` 条目，由 provider 能力枚举 `RemoteCompactionSupport::V2`（model-provider/src/provider.rs:46-51，注释写明 "supports `compaction_trigger` items over the Responses endpoint"）和 `RemoteCompactionV2` 特性开关共同控制。两条远端路径失败时还有跨模型 fallback（`compact_model_fallback.rs`，在 compact_remote.rs:224-263 中被调用），属于进阶细节，知道存在即可。

### 第六步：配对不变量——压缩与裁剪的安全网

为什么必须保持 `function_call` / `function_call_output` 配对？因为 Responses API 会校验：历史里出现一个 `function_call` 而找不到同 `call_id` 的 output，请求直接被拒。反之孤儿 output（有 output 没 call）同样是脏数据。任何对历史的裁剪——压缩、回滚、`remove_first_item`——都可能制造这两种残缺，所以 Codex 在**每次构造请求前的最后一公里**统一兜底，`normalize_history`（history.rs:446-464）：

```rust
// 来源：codex-rs/core/src/context_manager/history.rs:446-464
/// This function enforces a couple of invariants on the in-memory history:
/// 1. every call (function/custom) has a corresponding output entry
/// 2. every output has a corresponding call entry or names an external tool event
/// 3. unsupported image and audio content is stripped from messages and tool outputs
fn normalize_history(&mut self, input_modalities: &[InputModality]) {
    let items = Arc::make_mut(&mut self.items);

    // all function/tool calls must have a corresponding output
    normalize::ensure_call_outputs_present(items);

    // Paired outputs must have a corresponding call; named external outputs stand alone.
    normalize::remove_orphan_outputs(items);

    // strip images when model does not support them
    normalize::strip_images_when_unsupported(input_modalities, items);

    // strip audio when model does not support it
    normalize::strip_audio_when_unsupported(input_modalities, items);
}
```

两个方向的修复策略不对称，很能说明设计意图：

- **缺 output 就补**（`ensure_call_outputs_present`，normalize.rs:21-138）：给没有配对的 call 合成一个 output，内容就是 `"aborted"`——告诉模型「这个调用没跑完」。注意合成条目的 ID 用 UUIDv5 从源 call 的 ID 确定性派生（normalize.rs:146-153），注释写明原因：normalize 在每次请求前都会跑，ID 必须稳定，否则 `prompt_cache_key` 命中的前缀缓存就失效了。
- **多 output 就删**（`remove_orphan_outputs`，normalize.rs:155-225）：孤儿 output 无法向模型解释，直接移除。

为什么「缺」要补而「多」要删？因为 call 是模型自己发出的意图，历史里留着它却没有结果，模型会困惑（甚至会重发同样的调用）；补一个 "aborted" 是给模型一个交代。而孤儿 output 是模型从未要求过的东西，留着只会污染。这个不对称是「以模型视角理解历史」的好例子。

多模态剥离（`strip_images_when_unsupported` / `strip_audio_when_unsupported`，normalize.rs:330-421）解决另一个实际问题：会话中途切换了不支持图片的模型，历史里的 `InputImage` 会被替换成占位文本 `"image content omitted because you do not support image input"`，而不是让请求报错。

## 设计取舍

**压缩 = 改写本地历史，而不是删消息。** 这是全章最重要的一句话，也是 `store: false` 架构（第 4 章）的自然推论。既然服务端不存会话状态、每次请求都全量重发历史，那么「压缩」在客户端眼里就是一次纯本地的 `replace_annotated_history`：下一次请求发出去的 `input` 自然就是新历史，不需要任何服务端协调。副作用是缓存命中策略要精心设计——所以才有 `prompt_cache_key = session_id`、合成 output 用确定性 ID、裁剪从头部开始（保住前缀）这些细节。整条链路都在为「全量重发 + 前缀缓存命中」服务。

**为什么默认 90% 才压缩？** 对比一下 my-agent 里常见的做法：设一个保守阈值比如 60%，宁可多压几次。Codex 选了 90%（`context_window * 9 / 10`），背后是压缩成本的核算：压缩本身是一次全量请求（本地路径甚至是一整个 turn），压得越频繁，token 开销越大、信息损失越多。配合 `store: false` 下每次全量重发的计费模型，晚压缩 = 让前缀缓存多命中几轮。当然代价是贴顶运行时一次超大的工具输出可能直接打爆窗口——所以才有请求被拒后 `remove_first_item` 循环重试的兜底（compact.rs:309-318）。这是一个「常态省、异常兜底」而非「处处保守」的工程决策。

**本地压缩 vs 远端压缩：把「怎么压」放在哪里。** my-agent 的 ContextManager 大概率是本地压缩：自己写摘要 prompt、自己拼装新历史。Codex 的本地路径（`compact.rs`）验证了这条路可行，但远端路径说明了它的天花板——客户端写摘要 prompt，能用的只有通用模型；服务端可以做专门训练的压缩模型，直接产出结构化的压缩历史（`Compaction` 加密条目），质量和 token 效率都更高。客户端的角色从「压缩的执行者」退化为「压缩结果的过滤器与安装者」（`should_keep_compacted_history_item`）。如果你的 my-agent 只接第三方 API，本地路径就是正确答案；如果哪天你的后端愿意提供一个 `/compact` 端点，客户端代码几乎不用动——Codex 的三路分发结构已经把扩展点留好了。

**摘要污染问题：Codex 怎么防。** 自己写过摘要压缩的人大多踩过这个坑：摘要文本里混着「上一轮你打算做 X」之类的计划，被当成新指令留在历史里，几轮压缩后模型行为越来越怪。Codex 有内外两层防护。外层是标记与过滤：摘要消息带 `SUMMARY_PREFIX` 前缀，`is_summary_message`（compact.rs:567-569）靠它把旧摘要从「真实用户消息」里剔除，避免摘要套摘要无限嵌套；注入片段靠 `markers()` 识别与剥离，不会混进摘要。内层是 prefix 本身的措辞——「另一个语言模型产出了这份摘要」，把摘要定性为**二手资料**而非指令，模型被训练为参照它而不是服从它。这不是银弹（`compact.rs:389-392` 在压缩后还会发一条 Warning 事件提醒用户：长会话多次压缩会降低准确性，建议开新主线），但比「裸塞摘要」健康得多。

**token 估算：为什么不用真 tokenizer？** `approx_token_count` 的 4 字节/token 启发式对中文等语言偏差很大（一个汉字在 UTF-8 是 3 字节，往往就是 1 个 token，估算会偏保守 3 倍）。但注意它的使用位置：只用于**增量估算**（上次响应后新增的工具输出）和**裁剪预算**（保留多少用户消息）。这两个场景都要的是「快且保守的上下界」，而不是精确值——偏差由 90% 阈值留下的 10% 余量吸收。真正决定触发的基数是服务端返回的 `last_token_usage.total_tokens`，那是精确值。在热路径上跑一次真 tokenizer（对整段历史做 BPE）的开销和依赖体积，换来的只是估算精度，Codex 认为不值。my-agent 里用 `js-tiktoken` 数全文的做法在 TS 生态可行，但放进每轮采样的热路径同样值得掂量。

**局限与演进方向。** 本地压缩丢弃全部工具调用记录，意味着「读过哪个文件、跑过什么命令」这类操作记忆只能靠摘要的文字描述幸存，摘要漏了就真丢了——`compact_token_budget.rs` 的「开新窗口」路线干脆承认这一点，让模型用工具按需重取，配合窗口 ID 链让模型知道自己身处第几个窗口。另外 `ContextManager` 仍是单个 `Vec`，超长线会话下「保留最近 20K token 用户消息」的策略也会丢早期需求；world state diff、reference context 这些机制（`context/world_state/`）是在往「结构化状态而非线性历史」方向演进的信号。

## 动手实验

以下命令都在仓库根目录执行，纯只读。

**(1) 找到压缩的三个触发入口：**

```shell
rg -n "run_auto_compact" codex-rs/core/src/session/turn.rs
```

预期输出形态：5 行命中——4 个调用点（`run_pre_sampling_compact` 的 PreTurn 分支、采样循环内的 MidTurn 分支、`maybe_run_previous_model_inline_compact` 里模型切换/comp_hash 变化触发的两处）加上 1178 行的函数定义本身。

**(2) 看压缩阈值怎么算出来的：**

```shell
rg -n "auto_compact_token_limit" codex-rs/protocol/src/openai_models.rs
rg -n "model_auto_compact_token_limit" codex-rs/core/src/session/context_window.rs
```

预期能看到 `* 9 / 10` 的默认 90% 规则和 `config` 覆盖取 `min` 的逻辑。

**(3) 验证配对不变量的实现位置：**

```shell
rg -n "fn ensure_call_outputs_present|fn remove_orphan_outputs|fn remove_corresponding_for" \
  codex-rs/core/src/context_manager/normalize.rs
```

预期输出三个函数定义，行号分别在 21 / 155 / 227 附近。

**(4) 观察一次真实的自动压缩（需要可用的模型凭据）：**

```shell
RUST_LOG=codex_core=trace cargo run --bin codex -- exec "repeat a 5000-word essay three times" 2>&1 \
  | rg "post sampling token usage|compact"
```

预期在 token 触顶时看到一行 `post sampling token usage` trace 日志，内含 `total_usage_tokens`、`auto_compact_scope_limit`、`token_limit_reached=true` 等字段，随后出现 compaction 相关 span（`run_auto_compact` 带 `reason=ContextLimit, phase=MidTurn` 字段）。

**(5) 手动触发压缩并观察 rollout：** 在 TUI 里输入 `/compact`，然后查看会话的 rollout 文件：

```shell
ls -t ~/.codex/sessions/ | head -3        # 找到最近的 rollout 目录
rg '"type":"compacted"' ~/.codex/sessions -l | head -3
```

预期能在最新的 rollout JSONL 里找到 `"type":"compacted"` 行，内含 `replacement_history` 字段——那就是压缩后的新历史全貌（第 13 章会讲 resume 如何消费它）。

## Rust 侧栏

- **`Arc::make_mut` 写时拷贝（copy-on-write）**：`ContextManager.items` 是 `Arc<Vec<...>>`。克隆历史只是 `Arc` 计数 +1，O(1)；真要修改时 `Arc::make_mut` 检查引用计数，独占就直接改，共享就先克隆底层 `Vec` 再改。压缩路径大量克隆历史快照（`sess.clone_history()`），全靠这个机制避免深拷贝整段历史。
- **`Deref` 与迭代器适配器**：`record_items` 接受 `I::Item: Deref<Target = ResponseItem>`（history.rs:162-168），让调用方传 `&ResponseItem` 或 `ResponseItemEnvelope` 都行，靠 `Deref` 自动解引用统一成 `&ResponseItem`。
- **`saturating_add` / `saturating_sub`**：token 计量代码几乎不用 `+`，全用饱和运算——估算值溢出 i64 时钉在 `i64::MAX` 而不是 panic 或回绕。对「宁可误判触顶、不可误判安全」的场景，饱和语义正好是对的失败方向。
- **`let ... else` 发散语法**：`let Some(&idx) = positions.first() else { return ... };`（history.rs:327-330）——模式不匹配时走 `else` 分支且必须发散（return/break/continue）。比 `match` 少一层缩进，适合前置校验。
- **`Box<dyn Trait>` 与对象安全**：`Vec<Box<dyn ContextualUserFragment>>`（如 history.rs:132 的返回类型）让约 40 种片段类型能装进同一个容器。代价是动态分发和堆分配，换来的是新增一种片段不用改任何调用处。

## 小结 + 思考题

本章回答了一个问题：上下文窗口有限，对话无限增长，Codex 怎么办。答案是四层配合——用「服务端真实用量 + 本地 4 字节/token 增量估算」计量；在回合前和每轮采样后检查，默认 90% 阈值触发；按 provider 能力在本地摘要、远端压缩、token-budget 开新窗口三条路径间分发；最后无论哪条路径，压缩产物都经过 `normalize_history` 补齐缺失 output、删除孤儿 output，保证 `function_call` 配对完整。压缩的本质在 `store: false` 架构下格外纯粹：**改写本地历史，下一次全量重发即生效**。

思考题：

1. `build_compacted_history` 保留的是「最近 20K token 的**用户消息**」而不是最近的完整对话。为什么保留用户消息比保留 assistant 消息更有价值？反过来会出什么问题？（提示：摘要是谁写的？）
2. `ensure_call_outputs_present` 给缺失 output 的 call 补一个 `"aborted"` 占位。如果改成直接删掉那个 call，会对 prompt 缓存和模型行为各有什么影响？（提示：normalize.rs:19 的注释）
3. 在 `store: false` 全量重发模型下，压缩后第一轮请求的 `cached_input_tokens` 会怎样变化？用第 4 章的 prompt caching 知识推一遍，再去 `codex-rs/core/tests/suite/compact.rs` 找对应测试验证。
4. my-agent 的 ContextManager 如果要支持「压缩后回滚到压缩前」（Codex 靠 rollout 里的 `CompactedItem` 实现 resume，见第 13 章），最小需要持久化什么？

**下一章**：[第 9 章 工具系统](ch09-tools.md)——历史里那些 `function_call` 是从哪来、怎么被路由和执行的。
