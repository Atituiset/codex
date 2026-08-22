# 第 13 章 会话持久化与恢复：rollout 与 state_db

## 本章导读

设想这个场景：Codex 帮你改了两个小时代码，回合（turn）正跑到一半，笔记本合盖断电，或者你手滑 `Ctrl+C` 了又后悔了。重开终端，敲 `codex resume --last`，对话原样回来——模型接着上次的上下文继续干活，仿佛什么都没发生。

这个「仿佛什么都没发生」背后有一个硬约束，我们在[第 4 章](ch04-auth-model.md)已经埋下伏笔：Codex 的模型请求带 `store: false`，服务端不保存任何会话状态，每次采样请求（sampling request）都**全量重发**完整历史。这意味着一旦进程死了，服务端那边什么都没有——**客户端本地的持久化记录（rollout）是恢复会话的唯一真相源**。丢一行，模型就永远忘记了那一行。

所以本章要回答的真实问题是：**一份随时可能被 kill -9 打断的、只增不改的事件流，如何做到崩溃后无损重建？** 读完你会看到 Codex 的答案是一个经典架构的翻版：append-only 的 JSONL 事件日志（rollout）作为写入真相源，一个 sqlite 数据库（state_db）作为可重建的读取视图——本质上是一次小型的 CQRS 实践。你的 my-agent 大概率把「会话」当成一个整体对象在存（整个 messages 数组序列化进一个文件或一行 DB 记录），本章会给你一套完全不同的、为崩溃恢复而生的思路。

## 源码地图

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-rs/history/src/lib.rs` | `RolloutItem`/`RolloutLine`/`InitialHistory` 等落盘数据模型 | rollout 文件的「行格式」定义 |
| `codex-rs/rollout/src/recorder.rs` | `RolloutRecorder`：后台写入任务、文件命名与路径布局 | 本章主角，2120 行 |
| `codex-rs/rollout/src/policy.rs` | 持久化策略：哪些条目/事件值得落盘 | 瞬态事件（delta 流）在这里被滤掉 |
| `codex-rs/rollout/src/ordinal.rs` | paginated rollout 的序号（ordinal）状态机 | resume 续写时从文件尾部反推下一个序号 |
| `codex-rs/rollout/src/compression.rs` | 冷 rollout 的后台 zstd 压缩（`.zst` sidecar） | 读路径对调用方透明 |
| `codex-rs/rollout/src/state_db.rs` | state_db 的初始化与线程列表查询 | rollout 元数据 → sqlite 的桥 |
| `codex-rs/state/src/` | sqlite state_db 本体（sqlx + migrations） | 50 个迁移文件，纯读取视图 |
| `codex-rs/thread-store/src/store.rs` | `ThreadStore` trait：存储中立的持久化边界 | 本地文件是一种实现，远端服务也可以是 |
| `codex-rs/thread-store/src/live_thread.rs` | `LiveThread`：活跃主线的持久化句柄 | Session 只跟它打交道 |
| `codex-rs/thread-store/src/local/live_writer.rs` | 本地实现的写入编排：先 JSONL 落盘，再投影 sqlite | 「SQLite 是可重建视图」这句话的出处 |
| `codex-rs/core/src/session/mod.rs` | `send_event` 与持久化的接合、`record_conversation_items`、`replace_compacted_history` | 写入路径的调用方 |
| `codex-rs/core/src/session/rollout_reconstruction.rs` | 从 rollout 条目重建内存历史 | resume/fork 的核心算法，反向扫描 |
| `codex-rs/core/src/session/rollout_budget.rs` | rollout 级 token 预算提醒（agent-control 用） | 与本章关系弱，知道存在即可 |
| `codex-rs/core/src/thread_manager.rs` | `resume_thread_from_rollout` / `fork_thread` 入口 | resume 与 fork 的分叉口 |
| `codex-rs/cli/src/state_db_recovery.rs` | state_db 损坏时的备份与恢复交互 | [第 2 章](ch02-startup.md)那个 `loop` 的内幕 |

## 核心数据结构

### rollout 文件的「行」：`RolloutLine` 与 `RolloutItem`

一份 rollout 就是一个 JSONL 文件，每行一条 `RolloutLine`（history/src/lib.rs:200-207）：

```rust
// 来源：codex-rs/history/src/lib.rs:200-207
pub struct RolloutLine {
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordinal: Option<u64>,   // ← paginated 模式下的严格递增序号；legacy 模式为 None
    #[serde(flatten)]           // ← 序列化时 item 的字段直接摊平进本行
    pub item: RolloutItem,
}
```

`RolloutItem` 是落盘条目的总类型（history/src/lib.rs:93-105），九种变体：

```rust
// 来源：codex-rs/history/src/lib.rs:93-105
pub enum RolloutItem {
    SessionMeta(SessionMetaLine),            // ← 文件头：会话元数据，永远是第一条
    ResponseItem(ResponseItemEnvelope),      // ← 模型历史条目（消息/工具调用/推理…）
    InterAgentCommunication(InterAgentCommunication), // ← 多智能体通信
    InterAgentCommunicationMetadata { trigger_turn: bool },
    Compacted(CompactedItem),                // ← 压缩检查点（含替换后的完整历史）
    TurnContext(TurnContextItem),            // ← 每个用户回合的上下文基线快照
    WorldState(WorldStateItem),              // ← 世界状态（环境/权限等）快照或补丁
    SecurityRiskScore(SecurityRiskScore),
    EventMsg(EventMsg),                      // ← UI 语义事件（TurnStarted/TurnComplete/TokenCount…）
}
```

注意它同时容纳了**两种语义的东西**：`ResponseItem` 是「发给模型的历史」，`EventMsg` 是「发给 UI 的事件」。同一份文件既是模型历史的日志，又是 UI 状态的日志——resume 时两类消费者各取所需。这个设计在[第 5 章](ch05-protocol.md)的协议分层里已有铺垫：条目与事件本就共享一套 serde 模型，落盘几乎零成本。

文件头第一条永远是 `SessionMeta`（protocol/src/protocol.rs:2881-2938），它是会话的「出生证明」：

```rust
// 来源：codex-rs/protocol/src/protocol.rs:2881-2938（节选）
pub struct SessionMeta {
    pub session_id: SessionId,
    pub id: ThreadId,                          // ← 主线 ID，文件名里也带一份
    pub forked_from_id: Option<ThreadId>,      // ← fork 血缘：从哪条主线分叉而来
    pub parent_thread_id: Option<ThreadId>,
    pub timestamp: String,
    pub cwd: PathBuf,
    pub originator: String,
    pub cli_version: String,
    pub source: SessionSource,                 // ← Cli / VSCode / exec…（见第 6 章）
    pub base_instructions: Option<BaseInstructions>, // ← 基线系统提示词，resume 时复用
    pub history_mode: ThreadHistoryMode,       // ← Legacy 或 Paginated；TUI/exec 建会话时显式请求 Paginated
    // ... dynamic_tools、selected_capability_roots、history_base 等
}
```

### 压缩检查点：`CompactedItem`

[第 8 章](ch08-context-compact.md)讲过压缩会把整段历史替换成「摘要 + 保留的用户消息」。这个替换动作本身也要落盘，否则 resume 后压缩就白做了（history/src/lib.rs:141-150）：

```rust
// 来源：codex-rs/history/src/lib.rs:141-150
pub struct CompactedItem {
    pub message: String,                                    // ← 摘要文本（助手消息形式）
    pub replacement_history: Option<Vec<ResponseItemEnvelope>>, // ← 压缩后的完整新历史
    pub mcp_resource_origins: Option<McpResourceOriginCheckpoint>,
    pub window_number: Option<u64>,                         // ← 第几个上下文窗口（压缩次数）
    pub first_window_id: Option<String>,
    pub previous_window_id: Option<String>,
    pub window_id: Option<String>,
}
```

关键点：`replacement_history` 里是**完整的替换后历史**，不是 diff。这是一份自包含检查点——重建时找到最近一个带 `replacement_history` 的 `CompactedItem`，它之前的所有条目都可以不再关心（流程走读一节会展开）。旧格式的 rollout 里这个字段可能是 `None`（只有摘要文本），重建逻辑对它有专门的兼容路径。

### 恢复的三种开局：`InitialHistory`

resume 与 fork 的差异在数据层面就是一个枚举（history/src/lib.rs:216-222）：

```rust
// 来源：codex-rs/history/src/lib.rs:216-222
pub enum InitialHistory {
    New,                          // ← 全新会话
    Cleared,                      // ← 清空重来
    Resumed(ResumedHistory),      // ← resume：续写原 rollout 文件，thread_id 不变
    Forked(Vec<RolloutItem>),     // ← fork：拷贝历史，新 thread_id、新文件
}
```

`Resumed` 携带 `conversation_id` 和 `rollout_path`——**续写同一个文件**；`Forked` 只有一把条目——这些条目会被写进一个**全新的** rollout 文件。这是 resume 和 fork 最本质的区别，后面细讲。

最后一个接口层的类型：`PersistContext`（thread-store/src/store.rs:59-65），它回答「这次落盘有多急」：

```rust
// 来源：codex-rs/thread-store/src/store.rs:59-65
pub enum PersistContext {
    /// 标准持久化：让主线与已排队条目变得 durable 且可读，必须完成后才返回。
    Standard,
    /// 回合即将开始采样且输入已记录：允许实现方先入队、在后台完成，
    /// 但要用后续的 flush/shutdown 形成栅栏（fence）兜底。
    TurnStart,
}
```

[第 7 章](ch07-agent-loop.md)提过回合首条输入用 `TurnStart`、steer 插入的输入用 `Standard`——区别就在这里：回合启动的写盘可以被采样请求「盖住」并行做，而 steer 的输入必须落了盘才算数。

## 流程走读

### 13.1 写入路径：为什么持久化与广播绑在一起

[第 6 章](ch06-core-session.md)讲过 `send_event` 的三项职责（持久化、更新状态快照、推给外壳），当时我们刻意没展开第一步。现在看它的完整实现（session/mod.rs:2167-2188）：

```rust
// 来源：codex-rs/core/src/session/mod.rs:2167-2188
async fn send_event_raw_with_persistence(&self, event: Event, persist: bool) {
    self.services.mcp_runtime.observe_event(&event.msg);
    // 先持久化到 rollout；store 内部应用持久化策略做过滤
    if persist {
        let rollout_items = vec![RolloutItem::EventMsg(event.msg.clone())];
        self.persist_rollout_items(&rollout_items).await;   // ← await：落盘完成才继续
    }
    self.services
        .rollout_thread_trace
        .record_protocol_event(&event.msg);
    self.deliver_event_raw(event).await;                    // ← 然后才推进广播通道
}
```

**顺序是铁律：先落盘，后广播。** `persist_rollout_items`（session/mod.rs:3752-3759）调用 `LiveThread::append_items` 并 `await` 到底——对于本地实现，这个 await 一直走到 JSONL 写入并 `flush` 完成（下文 `durable_write`）才返回。也就是说，当 TUI 看到 `TurnComplete` 事件时，这个事件**已经**在磁盘上了。反过来如果先广播后落盘，崩溃窗口里就会出现「UI 显示了、模型历史里却没有」的幽灵状态——恢复后 UI 重放的画面和模型的记忆会对不上。

历史条目（`ResponseItem`）走的是同一条河道：`record_prepared_conversation_items`（session/mod.rs:3078-3117）先更新内存 `ContextManager`，再 `persist_rollout_items`，最后发 `RawResponseItem` 事件——与[第 7 章](ch07-agent-loop.md)讲的「立即落史」是同构的。完整调用链：

```
Session::send_event_raw / record_conversation_items
   │
   ▼
persist_rollout_items(items)                 session/mod.rs:3753
   │
   ▼
LiveThread::append_items                     thread-store/live_thread.rs:203
   │  ├─ persisted_rollout_items()  ← policy.rs 过滤瞬态条目
   │  └─ metadata_sync 观察条目 → 异步更新标题/预览等元数据
   ▼
LocalThreadStore::append_items               thread-store/local/live_writer.rs:129
   │
   ▼
write_and_project                            live_writer.rs:309
   ├─ 1. durable_write: record_canonical_items + flush ← JSONL 先 durable
   └─ 2. materialize_to_sqlite（paginated 投影进 sqlite，失败只 warn）
   │
   ▼
RolloutRecorder（mpsc 队列）──► 后台 writer task ──► rollout-*.jsonl
   │
   ▼ （全部 await 完成后）
deliver_event_raw → tx_event → TUI / app-server
```

### 13.2 `RolloutRecorder`：一个 mpsc 队列 + 一个后台写盘任务

`RolloutRecorder`（recorder.rs:85-90）本身薄得像纸——它不持有文件句柄，只持有一个命令通道的发送端：

```rust
// 来源：codex-rs/rollout/src/recorder.rs:85-90, 124-136
pub struct RolloutRecorder {
    tx: Sender<RolloutCmd>,              // ← 所有写入都变成命令发进通道
    writer_task: Arc<RolloutWriterTask>, // ← 后台任务的观测状态（句柄 + 终态错误）
    pub(crate) rollout_path: PathBuf,
}

enum RolloutCmd {
    AddItems(Vec<RolloutItem>),                        // ← 追加条目（先入内存队列）
    Persist { ack: oneshot::Sender<io::Result<()>> },  // ← 物化文件 + 写尽缓冲
    Flush { ack: oneshot::Sender<io::Result<()>> },    // ← 栅栏：等此前所有写入提交
    Shutdown { ack: oneshot::Sender<io::Result<()>> },
}
```

创建时（recorder.rs:916-941）建立一个容量 256 的有界 mpsc 通道，并 `tokio::spawn` 一个独立的 writer 任务——文件句柄由这个任务独占。注释里写明了理由：通道只是为了让调用方线程**不做阻塞 I/O**；缓冲区满了，发送方 `.await` 挂起即可，天然形成背压。

文件路径在创建时预计算（recorder.rs:1607-1629），这就是你已知的布局：

```rust
// 来源：codex-rs/rollout/src/recorder.rs:1612-1626
// Resolve ~/.codex/sessions/YYYY/MM/DD path.
let timestamp = OffsetDateTime::now_local() // ... 错误处理略
let mut dir = config.codex_home().to_path_buf();
dir.push(SESSIONS_SUBDIR);                        // ← "sessions"
dir.push(timestamp.year().to_string());           // ← 年
dir.push(format!("{:02}", u8::from(timestamp.month()))); // ← 月
dir.push(format!("{:02}", timestamp.day()));      // ← 日

let rollout_id = rollout_id_override.unwrap_or(thread_id);
let filename = RolloutFileName::new(timestamp, thread_id, rollout_id)
    .render() // ...
```

文件名形如 `rollout-2026-08-22T04-53-26-<thread_id>.jsonl`（rollout_file_name.rs:62-74）；`thread/revert` 会用 `rollout_id_override` 生成 `rollout-<ts>-<thread_id>_<rollout_id>.jsonl`——revert 保持 thread_id 不变但换一个新的不可变 rollout 文件，这就是文件名里出现两个 ID 的原因（recorder.rs:98-104 的注释）。

writer 任务的主循环（recorder.rs:1820-1850）是个教科书式的 actor：

```rust
// 来源：codex-rs/rollout/src/recorder.rs:1820-1850
async fn rollout_writer(
    mut state: RolloutWriterState,
    mut rx: mpsc::Receiver<RolloutCmd>,
) -> std::io::Result<()> {
    while let Some(cmd) = rx.recv().await {
        match cmd {
            RolloutCmd::AddItems(items) => {
                state.add_items(items);              // ← 先进内存缓冲
                state.flush_if_materialized().await; // ← 文件已存在则顺手写掉
            }
            RolloutCmd::Persist { ack } => { let _ = ack.send(state.persist().await); }
            RolloutCmd::Flush { ack } => { let _ = ack.send(state.flush().await); }
            RolloutCmd::Shutdown { ack } => match state.shutdown().await { /* 排空后退出 */ },
        }
    }
    Ok(())
}
```

`RolloutWriterState`（recorder.rs:1653-1668）的三个设计细节值得停下来看：

1. **延迟物化（deferred creation）**：新会话创建时**不建文件**，只把 `SessionMeta` 攒在内存里。直到第一次 `persist`（回合开始的 `TurnStart`）或 `flush` 才真正创建文件、写入头部。这就是为什么一个只打开没说话的会话不会在 `~/.codex/sessions/` 留垃圾文件。相应地，事件侧有个配套入口 `send_event_raw_without_materializing_rollout`（session/mod.rs:2155-2165）：线程还没物化时，事件只广播不建文件。
2. **失败保缓冲**：`pending_items` 只在写成功后才从队列里移除（recorder.rs:1788-1817）。I/O 出错时 `enter_recovery_mode` 丢弃文件句柄但**保留未写出的条目**，下一次屏障（persist/flush/shutdown）会重开文件重试（`write_pending_with_recovery`，recorder.rs:1702-1727：先试一次，失败就重开再试一次）。
3. **序号续接**：paginated 模式的每行带 `ordinal`。resume 续写时从文件尾部反向扫描出最后一行的序号再 +1（ordinal.rs:56-101），保证续写部分序号严格衔接——序号是后面 revert/分页投影的锚点。

### 13.3 持久化策略：不是什么都能进 rollout

事件流里大量东西是**瞬态**的——`AgentMessageContentDelta` 这种流式增量每秒几十条，落盘毫无意义（完整文本会以 `ResponseItem` 形式落史）。过滤规则集中在 policy.rs，`is_persisted_rollout_item`（policy.rs:9-22）是第一道闸：

```rust
// 来源：codex-rs/rollout/src/policy.rs:9-22
pub fn is_persisted_rollout_item(item: &RolloutItem, history_mode: ThreadHistoryMode) -> bool {
    match item {
        RolloutItem::ResponseItem(item) => should_persist_response_item(&item.item),
        RolloutItem::InterAgentCommunication(_)
        | RolloutItem::InterAgentCommunicationMetadata { .. } => true,
        RolloutItem::EventMsg(ev) => should_persist_event_msg(ev, history_mode),
        // 压缩、回合上下文、世界状态等「执行层标记」一律落盘，供回放分析
        RolloutItem::Compacted(_)
        | RolloutItem::TurnContext(_)
        | RolloutItem::WorldState(_)
        | RolloutItem::SecurityRiskScore(_)
        | RolloutItem::SessionMeta(_) => true,
    }
}
```

`should_persist_event_msg`（policy.rs:88-185）按三类划分：`TurnStarted`/`TurnComplete`/`TurnAborted`/`TokenCount` 等**回合骨架事件**必落（它们是重建时的定界符）；`UserMessage`/`AgentMessage` 等 legacy 事件只在 `Legacy` 历史模式下落（paginated 模式改落 `ItemCompleted`）；而所有 `*Delta`、`ItemStarted`、审批请求、错误流等一律不落。`ResponseItem` 侧（policy.rs:40-60）则把 `CompactionTrigger`（第 8 章讲过它只是请求控制，不是历史条目）和 `AdditionalTools` 排除在外。

这份策略表值得你通读一遍——它精确地回答了「**重建一个会话到底需要多少信息**」：模型历史条目 + 回合定界符 + 上下文基线 + 压缩检查点，仅此而已。

### 13.4 resume：反向扫描重建内存状态

入口链路：`codex resume`（picker 或 `--last`，cli/src/main.rs:192-193, 2704-2728）→ `ThreadManager::resume_thread_from_rollout`（thread_manager.rs:996-1013）→ `RolloutRecorder::get_rollout_history`（recorder.rs:1074-1089）读出 `InitialHistory::Resumed` → `Session::new` 里 `record_initial_history`（session/mod.rs:1359-1407）→ `reconstruct_history_from_rollout`。

第一步读文件（`load_rollout_items`，recorder.rs:1009-1072）本身就是防御性编程的范例：**逐行解析，坏行跳过并计数**，不让一行损坏拖死整个恢复：

```rust
// 来源：codex-rs/rollout/src/recorder.rs:1023-1071（节选）
let mut value: Value = match serde_json::from_str(&line) {
    Ok(value) => value,
    Err(e) => {
        warn!("failed to parse line as JSON: {line:?}, error: {e}");
        parse_errors = parse_errors.saturating_add(1);
        continue;                              // ← 单行损坏不致命
    }
};
// ...
if thread_id.is_none()
    && let RolloutItem::SessionMeta(session_meta_line) = &item
{
    thread_id = Some(session_meta_line.meta.id); // ← 第一个 SessionMeta 定主线身份
}
items.push(item);
```

这正是 append-only JSONL 的红利：崩溃可能截断最后一行，但此前每一行都是完整的记录，截断处之后没有「半个对象」需要抢救。

重建算法（rollout_reconstruction.rs:113-438）是本章最精巧的一段。它**从新到旧反向扫描**，而不是 naive 地从头重放。核心思想：一旦找到最近一个「存活」的压缩检查点，它之前的历史对重建再无影响（rollout_reconstruction.rs:83-89 的注释原话：*"a surviving replacement-history checkpoint is a complete history base"*）。反向扫描时按回合切分段落（segment），遇到 `Compacted` 且带 `replacement_history` 就锁定历史基线（rollout_reconstruction.rs:157-188）：

```rust
// 来源：codex-rs/core/src/session/rollout_reconstruction.rs:155-188, 289-298（节选）
for (index, item) in rollout_items.iter().enumerate().rev() {   // ← 反向！
    match item {
        RolloutItem::Compacted(compacted) => {
            // ... 记录窗口号、标记上下文基线被清除
            if active_segment.base_replacement_history.is_none()
                && let Some(replacement_history) = &compacted.replacement_history
            {
                active_segment.base_replacement_history = Some(replacement_history);
                rollout_suffix = &rollout_items[index + 1..];    // ← 只需重放检查点之后的尾巴
            }
        }
        RolloutItem::EventMsg(EventMsg::ThreadRolledBack(rollback)) => {
            pending_rollback_turns = pending_rollback_turns      // ← 回滚标记：跳过最近 N 个用户回合
                .saturating_add(usize::try_from(rollback.num_turns).unwrap_or(usize::MAX));
        }
        // ... TurnComplete/TurnAborted/UserMessage/TurnContext 参与定界与元数据恢复
    }

    if base_replacement_history.is_some()
        && previous_turn_settings.is_some()
        && !matches!(reference_context_item, TurnReferenceContextItem::NeverSet)
    {
        break;  // ← 历史基线 + 恢复元数据都齐了，更早的条目不再影响结果
    }
}
```

扫完得到三样东西：历史基线（检查点的 `replacement_history`）、需要正向重放的尾巴 `rollout_suffix`、恢复元数据（上一回合的模型设置 `previous_turn_settings`、上下文基线 `reference_context_item`、世界状态基线、压缩窗口号）。然后正向重放尾巴（rollout_reconstruction.rs:320-378）：`ResponseItem` 逐条进 `ContextManager`；遇到 `ThreadRolledBack` 就 `drop_last_n_user_turns`；若遇到没有 `replacement_history` 的旧式压缩条目，则用「收集用户消息 + 摘要」现场重建一份压缩历史（rollout_reconstruction.rs:349-367，与第 8 章 `build_compacted_history` 是同一套函数）。

回到调用方 `record_initial_history`（session/mod.rs:1359-1407），resume 还做了两件人性化的事：如果 rollout 里记录的最后状态是被打断（`AgentStatus::Interrupted`），把会话状态也恢复成 `Interrupted`；如果上次用的模型和这次不同，发一条 `Warning` 事件提醒「This session was recorded with model X but is resuming with Y」。token 用量也从最后一条 `TokenCount` 事件里捞回来（`last_token_info_from_rollout`），TUI 底部的统计在 resume 瞬间就是对的。

整个 resume 流程一张图：

```
codex resume --last
   │
   ▼
state_db / 文件扫描找到最新 rollout 路径（list.rs，见 13.6）
   │
   ▼
RolloutRecorder::get_rollout_history(path)     recorder.rs:1074
   │  逐行解析 → Vec<RolloutItem>（坏行跳过）
   ▼
InitialHistory::Resumed { conversation_id, history, rollout_path }
   │
   ├─► Session::new: LiveThread::resume（session/session.rs:895-917）
   │      └─ RolloutRecorderParams::Resume → 打开同一文件追加写
   │         （从尾部反推下一个 ordinal，ordinal.rs:56-101）
   │
   └─► record_initial_history（session/mod.rs:1359）
          └─ reconstruct_history_from_rollout（反向扫描）
             ├─ 最近压缩检查点 → replacement_history 作为历史基线
             ├─ 检查点之后的尾巴正向重放进 ContextManager
             ├─ ThreadRolledBack → 丢弃最近 N 个用户回合
             └─ 恢复窗口号 / 上一回合模型 / 世界状态基线
```

### 13.5 fork：拷一份历史，换一个新身份

fork 的入口是 `ThreadManager::fork_thread`（thread_manager.rs:1176-1199）：从源 rollout 读出历史，按 `ForkSnapshot` 截断，然后以 `InitialHistory::Forked` 起一条**新主线**。`fork_history_from_snapshot`（thread_manager.rs:2168-2199）处理两种截断：

```rust
// 来源：codex-rs/core/src/thread_manager.rs:2168-2198（节选）
match snapshot {
    ForkSnapshot::TruncateBeforeNthUserMessage(nth_user_message) => {
        truncate_before_nth_user_message(history, nth_user_message, &snapshot_state)
    }                                   // ← 「回到第 N 条用户消息之前」重新分叉
    ForkSnapshot::Interrupted => {
        // ...
        if snapshot_state.ends_mid_turn {
            append_interrupted_boundary(history, snapshot_state.active_turn_id, ...)
            // ← 源主线死在回合中途：补一个 TurnAborted 边界，
            //   否则新主线开头挂着半个没收尾的回合
        } else {
            history
        }
    }
}
```

resume 与 fork 的全部区别，落到持久化层就三行事实：

| | resume | fork |
|---|---|---|
| thread_id | 不变 | 新生成 |
| rollout 文件 | 续写原文件 | 新建文件，历史条目整体拷贝写入 |
| `SessionMeta` | 不重写（文件头早就有了） | 新头部，`forked_from_id` 指向源主线 |

在 `record_initial_history` 的 `Forked` 分支（session/mod.rs:1409-1457）里还能看到：拷贝来的条目会先补全缺失的 ID（`assign_missing_rollout_response_item_ids`），再整体 `persist_rollout_items` 进新文件并立刻物化（注释原话：*"Forked threads should remain file-backed immediately after startup"*）。另外本基线还有一种 `ForkPersistence::Referenced`（session/mod.rs:1424-1433）：不拷贝条目，只在 `SessionMeta.history_base` 里记录「继承自另一个 rollout 的前 N 条」——分页架构下 fork 大历史的零拷贝优化，目前主要服务于子智能体场景。

### 13.6 state_db：为什么一份真相源还不够

到目前为止我们只用了 JSONL。那 sqlite 存什么？看建表语句（state/migrations/0001_threads.sql）：

```sql
-- 来源：codex-rs/state/migrations/0001_threads.sql
CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,      -- ← 指向 JSONL 真相源
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,            -- ← cli / vscode / ...
    model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    sandbox_policy TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    has_user_event INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    -- ... git_sha / git_branch 等
);
```

注意表里**没有消息内容**。state_db 存的是主线元数据（标题、预览、cwd、token 数、归档状态、所在分区 section、血缘关系），外加日志、目标（goal）、记忆、队列等其它运行态库（state/src/sqlite.rs:26-31：`state_5.sqlite`、`logs_2.sqlite`、`goals_1.sqlite`、`memories_1.sqlite`、`queue_1.sqlite`、`thread_history_1.sqlite` 分库存放）。数据从哪来？从 rollout **提取**——`apply_rollout_item`（state/src/extract.rs:15-30）对每条落盘条目做增量抽取，更新 `threads` 行；`LiveThread::append_items` 里的 `metadata_sync`（live_thread.rs:203-227）在每次追加后顺带算出标题/预览补丁写进 sqlite。

分工因此非常清晰：

- **rollout（JSONL）是写入真相源（source of truth）**：追加写、崩溃友好、内容即模型历史本身，恢复时只读它。
- **state_db（sqlite）是可重建的读取视图（read model）**：为「列出最近会话」「按目录过滤」「搜索标题」这类查询服务。`codex resume` 的 picker 要秒开，总不能每次全目录扫描几千个 JSONL 再逐个读文件头。

「可重建」不是修辞，是架构承诺。`write_and_project`（live_writer.rs:309-352）里的注释写得直白：

```rust
// 来源：codex-rs/thread-store/src/local/live_writer.rs:331-347
if matches!(history_mode, ThreadHistoryMode::Legacy) {
    durable_write(&recorder, write_op).await?;
} else {
    let rollout_path = recorder.rollout_path();
    // SQLite 是可重建视图。flush 栅栏必须先赢，投影才开始——
    // 投影可以落后于 JSONL，但绝不能跑到规范历史前面。
    durable_write(&recorder, write_op).await?;
    if let Err(err) = super::thread_history_materialization::materialize_to_sqlite(
        store, rollout_id, rollout_path,
    ).await {
        warn!("failed to project durable rollout for {thread_id}: {err}"); // ← 投影失败只警告
    }
}
```

JSONL 落盘失败是错误（向上传播），sqlite 投影失败只是 `warn`——丢了随时能从 rollout 重建。启动时 `state_db::init`（rollout/src/state_db.rs:40-54）会做 backfill 对账；列表查询也走「文件系统优先 + 读修复（read-repair）」策略（recorder.rs:507-595）：扫到的文件若 sqlite 里缺行或过期，顺手补写。sqlite 在这里的角色约等于搜索引擎的索引，而非数据库。

既然是索引，损坏了就不该是灾难。TUI 启动时 state_db 打不开，`LocalStateDbStartupError` 一路抛到 CLI 层——这就是[第 2 章](ch02-startup.md)提到的 `local_state_db` 恢复循环（cli/src/main.rs:2619-2637），其内脏在 `state_db_recovery.rs`：

```rust
// 来源：codex-rs/cli/src/state_db_recovery.rs:24-34, 42-46（节选）
pub(crate) fn is_auto_backup_recoverable(startup_error: &LocalStateDbStartupError) -> bool {
    is_corruption(startup_error.detail()) || sqlite_home_is_blocking_file(startup_error)
}   // ← sqlite 报损坏，或 sqlite 目录路径被某个普通文件挡住

pub(crate) async fn backup_files_for_fresh_start(
    startup_error: &LocalStateDbStartupError,
) -> std::io::Result<Vec<RuntimeDbBackup>> {
    codex_state::backup_runtime_db_for_fresh_start(startup_error.database_path()).await
}   // ← 把损坏的库文件挪进备份目录，然后用全新库重试启动
```

流程是：判定可恢复（损坏或路径被文件阻塞）→ 打印「Moving the damaged local database aside...」→ 备份坏库 → 用户按回车确认 → 以新库重试启动（每个库只重试一次，`attempted_backups` 去重防死循环）→ 后台 backfill 从 rollout 文件重建索引。若是锁竞争（另一个 Codex 进程在用）则直接给出「退出其它 Codex 进程」的指引（state_db_recovery.rs:80-84）。sqlite 侧的配置也配合这个定位：WAL 模式 + `synchronous = NORMAL`（state/src/sqlite.rs:282-283），索引库不必为每次写 fsync 付出真相源级别的代价。

## 设计取舍

**为什么用 append-only 事件日志，而不是「保存会话对象」？** 对比 my-agent 最自然的写法：把 `messages: Message[]` 整个 JSON.stringify 写进 `~/.my-agent/sessions/<id>.json`，每条消息落一次盘。这个方案有三个系统性弱点：其一，**整体重写不是崩溃安全的**——写到一半断电，整个文件损坏，只能靠写临时文件再 rename 补救；append-only 的 JSONL 最坏只损失最后半行，且读端逐行容错（13.4 节）。其二，**整体重写是 O(n²) 的 I/O**——两小时的会话每来一条消息就重写几十 MB；append 是 O（新增量）。其三，「会话对象」模式存不下**过程信息**：`TurnStarted`/`TurnAborted`/压缩检查点这些「不属于消息列表、但恢复时必需」的事实无处可放，你只能发明越来越多的特殊字段。事件日志把「发生过什么」作为一等公民，会话状态只是日志的左折叠（fold）——这正是 `reconstruct_history_from_rollout` 做的事。代价是读路径复杂：恢复要跑一个反向扫描的状态机，而不是 `JSON.parse` 一把梭；列表查询要额外维护 sqlite 索引。Codex 用 `state` crate 把这份复杂完全挡在了恢复路径之外。

**为什么持久化和广播绑在同一个 `send_event` 里，而不是让 UI 各自去存？** 因为「UI 看到的」与「恢复用的」必须是同一份数据的不同投影。如果 TUI 自己维护一份展示状态、rollout 另记一份，崩溃恢复后两者必然漂移。绑定在同一个函数里、且落盘在前广播在后，保证了一个不变量：**任何被用户看到的事件，要么已在磁盘上，要么按策略本就不需要持久化**（瞬态 delta 在 policy.rs 被明确排除）。你的 my-agent 如果现在是「UI 渲染一份、history 数组一份、落盘又一份」的三份状态，这个设计就是合并它们的范式：一份事件流，多个投影。

**为什么要两个存储（JSONL + sqlite），而不是全放 sqlite？** 全放 sqlite 的诱惑很大——事务、索引、查询一把抓。但模型历史条目里有大块不透明 payload（加密的 reasoning 项、图片、工具输出），把它们拆进关系表是纯粹的阻抗失配；而 JSONL 对「原样保存 Responses API 的条目」是零映射成本。反过来，纯文件方案又撑不起 picker 的「按更新时间分页、按 cwd 过滤、标题搜索」。Codex 的答案是让两种介质各干各的：JSONL 对写入路径和崩溃恢复最优，sqlite 对查询最优，中间用单向投影连接，且**投影只允许落后、不允许超前**（live_writer.rs 那句注释）。这就是事件溯源（event sourcing）+ CQRS 在桌面软件里的一次落地。

**坦诚说局限。** 其一，resume 目前是**全量加载**：`load_rollout_items` 把整个文件读进内存再反向扫描。`rollout_reconstruction.rs` 开头的注释坦承这是「eager bridge」，设计上已为「可断点续传的反向惰性读取」留好形状（`ReverseJsonlScanner` 已在 ordinal 续接中使用），但长会话 resume 的内存与时间开销仍在。其二，双写（JSONL + sqlite 投影）不是事务性的——靠「投影可落后不可超前 + 启动对账 + 读修复」三件套兜底，而不是分布式事务；这在桌面单写者场景下是对的取舍，但你若把这套搬到多写者的服务端，需要更强的对账机制。其三，冷数据压缩（`.zst` sidecar，compression.rs:18-31）让读路径多了「解压/物化」分支，recovery 工具直接读文件时也要走 `open_rollout_line_reader` 而非裸读。

## 动手实验

**实验 1：观察 rollout 的实时增长。** 开一个 Codex TUI 会话随便聊两轮，另开一个终端：

```shell
ls ~/.codex/sessions/$(date +%Y/%m/%d)/
# 预期：rollout-2026-08-22T04-53-26-<uuid>.jsonl 之类，文件名含时间戳和 thread_id

tail -f ~/.codex/sessions/$(date +%Y/%m/%d)/rollout-*.jsonl \
  | python3 -c 'import sys,json; [print(json.loads(l).get("type")) for l in sys.stdin]'
# 预期输出形态：session_meta → turn_context → response_item → event_msg(TurnStarted)
#   → response_item ... → event_msg(TurnComplete) 交替出现
# 注意：看不到任何 delta 事件——它们在 policy.rs 被过滤了
```

**实验 2：验证「先落盘再广播」。** 在实验 1 的会话里发一条消息，**立刻**（模型还在输出时）`kill -9` 掉 codex 进程，然后：

```shell
tail -3 ~/.codex/sessions/$(date +%Y/%m/%d)/rollout-*.jsonl | cut -c1-120
# 预期：文件末尾完整停在最后一条「开始过」的条目上；
# 可能有半行截断的 JSON（崩溃瞬间正在写），但之前的行全部完好

codex resume --last
# 预期：会话原样恢复，TUI 历史与模型记忆一致；
# 若上次模型与本次不同，会看到 Warning: This session was recorded with model ...
```

**实验 3：找到压缩检查点。** 在会话里执行 `/compact`（或聊到触发 auto-compact），然后：

```shell
rg -l '"type":"compacted"' ~/.codex/sessions | head -3
rg '"type":"compacted"' ~/.codex/sessions/$(date +%Y/%m/%d)/rollout-*.jsonl \
  | python3 -c 'import sys,json; d=json.loads(sys.stdin.readline()); p=d["payload"]; print("keys:", sorted(p.keys())); print("replacement_history len:", len(p.get("replacement_history") or []))'
# 预期：payload 含 message / replacement_history / window_number / window_id 等键，
# replacement_history 是完整的新历史（通常几十条）
```

再 `codex resume --last` 恢复该会话，然后用 debug 日志确认重建路径走了检查点分支（`RUST_LOG=codex_core=trace`，观察 `reconstruct_history_from_rollout` 的 span 与 `rollout_item_count` 字段）。

**实验 4：解剖 state_db。** 需要本机有 `sqlite3`：

```shell
sqlite3 ~/.codex/state_5.sqlite \
  "SELECT substr(title,1,40), tokens_used, archived, rollout_path FROM threads ORDER BY updated_at DESC LIMIT 5;"
# 预期：最近几条主线的标题、累计 token、归档位、对应 rollout 文件路径
# 对照实验：删掉（或改名）这个 sqlite 文件再启动 codex —— 列表短暂为空后
# 被 backfill 重建；而 ~/.codex/sessions/ 下的 JSONL 一个都没少
```

**实验 5：模拟 state_db 损坏。** 把 `~/.codex/state_5.sqlite` 换成一个文本文件再启动 TUI：

```shell
mv ~/.codex/state_5.sqlite ~/.codex/state_5.sqlite.bak
echo "not a database" > ~/.codex/state_5.sqlite
codex
# 预期输出形态：
#   Codex couldn't start because its local database appears to be damaged.
#   Moving the damaged local database aside so Codex can rebuild it from saved data.
#   Technical details:
#     Location: /home/<you>/.codex/state_5.sqlite
#     Cause: ...
#   Press Enter to continue.
# 按回车后正常启动；损坏文件被挪进备份目录，新库由 rollout 重建
# （实验完记得对比确认 sessions/ 目录未受影响）
```

## Rust 侧栏

- **`mpsc` + `oneshot` 的命令模式**：`RolloutRecorder` 把写盘变成发命令（`RolloutCmd`），需要等结果的命令（Persist/Flush/Shutdown）自带一个 `oneshot::Sender` 回执——发送方 `rx.await` 就是一次「跨任务的函数调用」。这是 tokio 里替代「共享对象 + 锁」的经典 actor 写法：文件句柄永远只有一个所有者，无需 `Arc<Mutex<File>>`。
- **`#[serde(flatten)]`**：`RolloutLine` 用 `#[serde(flatten)]` 把 `item` 的字段摊平到行顶层，所以 JSONL 里每行是 `{"timestamp":..., "type":"response_item", "payload":{...}}` 而不是嵌套一层 `item`。代价是反序列化要走自定义缓冲（`decode_rollout_line`，rollout/src/lib.rs:45-65），注释里解释了 serde 的浮点重放缺陷。
- **`Arc<dyn ThreadStore>` 与 boxed future**：`ThreadStore` 是对象安全 trait，方法返回 `Pin<Box<dyn Future<...>>>`（store.rs:56）而不是 `async fn`——这是 RPITIT 普及前对象安全异步 trait 的标准写法，本仓库新代码已倾向后者（见 AGENTS.md），这里是尚未迁移的旧接口。
- **`Option::is_none_or` / `let`-chain**：重建代码里大量 `if let Some(x) = ... && let Some(y) = ...` 的 let-chain 与 `is_none_or`，是 Rust 2024 edition 收编的模式，能把「多层可选值」的匹配压进一个条件。
- **反向迭代与切片借用**：`rollout_items.iter().enumerate().rev()` 反向扫描，`rollout_suffix = &rollout_items[index + 1..]` 用切片零拷贝地「记住尾巴」——全程没有克隆历史条目，`Vec` 的所有权始终在读端手里。

## 小结 + 思考题

本章把持久化拆成了一条链和一个分工。链上：`send_event` 把「先落盘、后广播」固化成不变量，`RolloutRecorder` 用 mpsc 命令队列 + 独占写盘任务保证顺序与崩溃安全，policy.rs 精确裁剪出恢复所需的最小信息集。恢复时：`load_rollout_items` 逐行容错读入，`reconstruct_history_from_rollout` 反向扫描找到最近的压缩检查点、只重放其后的尾巴；resume 续写原文件，fork 拷贝历史换新身份。分工上：rollout JSONL 是写入真相源与恢复的唯一依据（因为 `store: false`，服务端什么都没有），state_db 只是可重建、可自动修复的查询索引——「投影可落后，不可超前」。

思考题：

1. `TurnAborted` 事件为什么要持久化（policy.rs 把它列为必落）？如果崩溃时这条事件还没落盘，resume 后的重建会在哪个环节出问题？（提示：`fork_history_from_snapshot` 的 `ends_mid_turn` 分支在补什么。）
2. `CompactedItem.replacement_history` 存的是完整新历史而非 diff。如果改成只存 diff，13.4 的反向扫描还能在找到第一个检查点就 `break` 吗？存储体积和重建复杂度各会怎样变化？
3. 你的 my-agent 现在是「每次写整个 messages 数组」的话，改造为 append-only 事件日志的最小一步是什么？你会把哪几类「事件」和「条目」分开？（对照 policy.rs 的三分类。）
4. `send_event_raw_with_persistence` 里落盘在前、广播在后。如果某个高频事件（比如 `TokenCount`）的落盘延迟达到 50ms，会对 TUI 体验产生什么影响？Codex 用什么机制缓解（提示：`TurnStart` 与 `Standard` 的区别、writer 任务的内存缓冲）？
