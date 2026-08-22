# 第 6 章 会话核心：Session 生命周期与 turn 状态机

## 本章导读

[第 5 章](ch05-protocol.md)把 `Op`/`EventMsg` 这对协议讲清楚了，但留了一个问题：这些消息**被谁消费、在什么约束下消费**？用户在 TUI 里敲下「帮我把测试修好」之后，内核里到底发生了什么——谁创建会话、谁接收这条输入、谁决定「现在该开一个新回合还是塞进正在跑的回合里」、谁把模型输出广播回界面？

这一层就是本章的主角：`core` crate 里的会话运行时。它要解决的真实问题有三个：

1. **一对多**：同一份内核状态要同时服务 TUI、exec、IDE 三种驱动方，所以「会话」不能是某个 UI 的内部对象，必须是一个独立生命周期、靠通道进出的运行时。
2. **并发与中断**：回合跑到一半，用户按 Esc 打断、或追加一句「顺便把 README 也更新一下」。内核必须能在一个回合正在执行时继续接收指令，并且明确界定「一个回合」的边界。
3. **状态归属**：模型、审批策略、工作目录、沙箱配置……这些设置有些属于整个会话、有些只在单个回合内有效。改错了归属，就会出现「换个模型结果所有回合都变了」或「审批策略在回合中途被悄悄改掉」这类 bug。

如果你在 my-agent 里把 Agent 写成一个单体的 `async function run()`，这三个问题大概率都是以「跑着跑着发现要加锁/加队列/加取消令牌」的方式暴露的。Codex 的答案是先把运行时拆成几个职责单一的对象，再让它们只通过消息交互。本章逐一认识这些对象，并完整走一遍「创建会话 → 提交输入 → 调度任务 → 广播事件 → 回合结束」的链路。注意本章的边界：我们只讲到任务被调度进 `run_turn` 为止，回合内部的模型调用循环是[第 7 章](ch07-agent-loop.md)的内容。

## 源码地图

本章涉及的全部是 `core` crate 内部（外加 protocol 的两个枚举）：

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-rs/core/src/thread_manager.rs` | `ThreadManager`：创建/登记/关闭所有线程 | 会话的「工厂 + 户籍处」 |
| `codex-rs/core/src/codex_thread.rs` | `CodexThread`：对外暴露的线程句柄 | 薄封装，只转发不决策 |
| `codex-rs/core/src/session/mod.rs` | `Session::spawn`、`SessionIo`、事件发送 | 会话的出生证明与总线端点 |
| `codex-rs/core/src/session/session.rs` | `Session` 结构体与 `SessionConfiguration` | 所有可变状态的家 |
| `codex-rs/core/src/session/handlers.rs` | `submission_loop`：Op 的总分发器 | 一个 `match` 看清内核能做什么 |
| `codex-rs/core/src/session/turn_input.rs` | `Op::TurnInput` 的路由决策 | 开始回合还是 steer，只在这里决定 |
| `codex-rs/core/src/session/input_queue.rs` | 待处理输入队列与 mailbox | steer 与多智能体消息的暂存处 |
| `codex-rs/core/src/session/turn_context.rs` | `TurnContext`：单回合的不可变快照 | 回合级设置的冻结点 |
| `codex-rs/core/src/state/turn.rs` | `ActiveTurn` / `RunningTask` / `TurnState` | 「当前正在跑什么」的状态机 |
| `codex-rs/core/src/tasks/mod.rs` | `SessionTask` trait 与任务生命周期 | 回合作为后台 tokio 任务运行 |
| `codex-rs/core/src/tasks/regular.rs` | `RegularTask`：普通对话回合 | 通往 `run_turn` 的最后一公里 |
| `codex-rs/protocol/src/protocol.rs` | `SessionSource` / `AgentStatus` 枚举 | 「谁在驱动我」「我现在什么状态」 |

`Session` 相关的代码按 AGENTS.md 的「避免大模块」纪律已经拆得很细——`session/` 目录下有 30 个文件、约 3 万行。上表只列本章主线用到的；`mcp*.rs`、`rollout_reconstruction.rs` 等留给对应章节。

## 核心数据结构

### CodexThread：对外句柄

`CodexThread`（codex_thread.rs:202-210）是外壳（TUI/app-server/exec）拿到的唯一句柄：

```rust
// 来源：codex-rs/core/src/codex_thread.rs:202-210
pub struct CodexThread {
    pub(crate) session: Arc<Session>,
    pub(crate) io: SessionIo,               // ← 双向通道的持有端
    pub(crate) session_source: SessionSource, // ← 谁在驱动：cli/vscode/exec/...
    session_configured: SessionConfiguredEvent, // ← 创建时的快照事件，用于重放
    rollout_path: Option<PathBuf>,          // ← 本会话的 rollout JSONL 路径
    out_of_band_elicitations: Mutex<OutOfBandElicitations>,
    _diagnostics_guard: GaugeGuard,         // ← 存活性指标，drop 时自动减计数
}
```

它的方法几乎全是转发——`submit` 与 `next_event` 是外壳最常调用的两个（codex_thread.rs:247-249、580-582）：

```rust
// 来源：codex-rs/core/src/codex_thread.rs:247-249、580-582
pub async fn submit(&self, op: Op) -> CodexResult<String> {
    self.io.submit(op).await                 // ← 原样转给 SessionIo
}

pub async fn next_event(&self) -> CodexResult<Event> {
    self.io.next_event().await
}
```

注意 `CodexThread` **不做任何路由决策**。第 5 章说过 `Op::TurnInput` 带三种 mode（StartOrSteer / StartIfIdle / Steer），`CodexThread` 上的 `start_or_steer_turn`（codex_thread.rs:338-344）等方法也只是帮你选好 mode 再调 `submit_turn_input`。真正的「开始还是 steer」判断发生在会话内部——这个设计让决策点只有一个，外壳永远不需要读会话状态。

### Session 与 SessionIo：状态与通道分离

`Session`（session.rs:40-71）是运行时的全部家当。字段很多，先看骨架：

```rust
// 来源：codex-rs/core/src/session/session.rs:40-71（有删节）
pub(crate) struct Session {
    pub(crate) thread_id: ThreadId,
    pub(super) tx_event: Sender<Event>,              // ← 事件出口（写端）
    pub(super) agent_status: watch::Sender<AgentStatus>, // ← 最新状态快照
    pub(super) state: Mutex<SessionState>,           // ← 会话级可变状态（历史等）
    pub(crate) active_turn: Mutex<Option<ActiveTurn>>, // ← 当前回合，最多一个
    pub(crate) input_queue: InputQueue,              // ← 待处理输入
    pub(crate) services: SessionServices,            // ← 跨回合共享的服务集
    // ...
}
```

三类字段值得记住：

- **状态**：`state: Mutex<SessionState>`。`SessionState`（state/session.rs:28-50）里装着对话历史 `history: ContextManager`（[第 8 章](ch08-context-compact.md)的主角）、`session_configuration`（当前生效的会话级配置）、限流快照等。
- **回合**：`active_turn: Mutex<Option<ActiveTurn>>`。`Option` 意味着「可能没有在跑的回合」——会话空闲时它是 `None`。这是 turn 状态机的根。
- **服务**：`services: SessionServices`（state/service.rs:46-100），40 来个字段：`mcp_runtime`、`exec_policy`、`auth_manager`、`model_client`、`live_thread`（持久化）……都是「创建一次、所有回合共享」的依赖。

而通道端点被刻意拆到另一个结构 `SessionIo`（mod.rs:368-376）里：

```rust
// 来源：codex-rs/core/src/session/mod.rs:363-376
/// Queue and lifecycle endpoints for a running [`Session`].
///
/// Runtime state lives on `Session`; keeping these endpoints separate lets all
/// submission senders be dropped to terminate the session loop. The shared
/// completion future observes that shutdown.
pub(crate) struct SessionIo {
    pub(crate) tx_sub: Sender<Submission>,     // ← 指令入口（多生产者）
    pub(crate) rx_event: Receiver<Event>,      // ← 事件出口（外壳持有）
    // Last known status of the agent.
    pub(crate) agent_status: watch::Receiver<AgentStatus>,
    // Shared future for the background submission loop completion so multiple
    // callers can wait for shutdown.
    pub(crate) session_loop_termination: SessionLoopTermination,
}
```

结构体上方的注释说明了为什么拆：`tx_sub` 是可克隆的发送端，可能被很多持有者（`CodexThread`、审批回调、多智能体 mailbox）各拿一份；把它们集中在 `SessionIo` 里，当**所有**发送端都被 drop 时通道自然关闭，会话循环就能检测到「没人再需要我了」并退出。这是 Rust 通道语义带来的免费生命周期管理。

### TurnContext：回合的不可变快照

第 5 章讲过用户改模型/审批策略走 `Op::ThreadSettings`。这些改动生效后，**正在跑的回合不能感知到一半**——所以每个回合启动时拍一张快照，即 `TurnContext`（turn_context.rs:144-192，有删节）：

```rust
// 来源：codex-rs/core/src/session/turn_context.rs:142-192（有删节）
/// The context needed for a single turn of the thread.
pub struct TurnContext {
    pub(crate) sub_id: String,          // ← 回合 id，等于受理它的 submission id
    pub config: Arc<Config>,            // ← 本回合冻结的配置
    pub(crate) model_info: Arc<ModelInfo>, // ← 本回合用的模型
    pub(crate) provider: SharedModelProvider,
    pub(crate) session_source: SessionSource,
    pub(crate) environments: TurnEnvironmentSnapshot, // ← 工作目录/环境选择
    pub(crate) windows_sandbox_level: WindowsSandboxLevel,
    pub(crate) final_output_json_schema: Option<Value>, // ← 结构化输出约束
    pub(crate) turn_metadata_state: Arc<TurnMetadataState>, // ← 父/根 turn 谱系
    pub(crate) terminal_error: Arc<Mutex<Option<ErrorEvent>>>, // ← 回合级致命错误
    // ...
}
```

`Session` 是「现在」，`TurnContext` 是「这个回合看到的现在」。两者通过 `new_turn_with_sub_id`（turn_context.rs:739-825）衔接：它先把 `SessionSettingsUpdate` 应用到 `SessionState.session_configuration`，再用新配置构造 `TurnContext`。也就是说**设置变更只在回合边界生效**——这是「turn 状态机」最重要的不变量。

### ActiveTurn 与 RunningTask：「正在跑什么」

```rust
// 来源：codex-rs/core/src/state/turn.rs:31-35、67-85（有删节）
/// Metadata about the currently running turn.
pub(crate) struct ActiveTurn {
    pub(crate) task: Option<RunningTask>,
    pub(crate) turn_state: Arc<Mutex<TurnState>>,
}

pub(crate) enum TaskKind {
    Regular,   // ← 普通对话回合
    Review,    // ← /review 代码评审
    Compact,   // ← /compact 压缩
}

pub(crate) struct RunningTask {
    pub(crate) done: Arc<Notify>,          // ← 「优雅退出完成」信号
    pub(crate) kind: TaskKind,
    pub(crate) task: Arc<dyn AnySessionTask>,
    pub(crate) cancellation_token: CancellationToken, // ← 打断用的取消令牌
    pub(crate) handle: AbortOnDropHandle<()>,         // ← tokio 任务句柄
    pub(crate) turn_context: Arc<TurnContext>,
    // ...
}
```

两层 `Option` 各管一件事：`Session.active_turn: Option<ActiveTurn>` 表示「有没有回合」（含已预留但还没挂任务的中间态），`ActiveTurn.task: Option<RunningTask>` 表示「任务挂上了没有」。`TurnState`（state/turn.rs:88-103）则是回合内的可变状态：挂起的审批（`pending_approvals: HashMap<String, oneshot::Sender<ReviewDecision>>`）、挂起的用户输入请求、待 steer 的输入（`pending_input`）等——都是「发出请求、等待外壳回话」的 oneshot 登记表，第 5 章的审批闭环就是靠它们缝合的。

### SessionSource：谁在驱动这个会话

```rust
// 来源：codex-rs/protocol/src/protocol.rs:2584-2598
#[serde(rename_all = "lowercase")]
pub enum SessionSource {
    Cli,
    #[default]
    VSCode,
    Exec,
    Mcp,
    Custom(String),
    Internal(InternalSessionSource),
    SubAgent(SubAgentSource),
    #[serde(other)]
    Unknown,
}
```

本基线上三种外壳的取值是：TUI 通过内嵌的进程内 app-server 建会话，`session_source` 传 `"cli"`（tui/src/lib.rs:578）；独立 app-server（IDE 用）默认 `VSCode`（app-server/src/lib.rs:424）；`codex exec` 传 `Exec`（exec/src/lib.rs:551）。这个字段不是摆设：会话 spawn 时会按它决定行为差异，例如非根智能体（`Internal`/`SubAgent`，protocol.rs:2720-2725 的 `is_non_root_agent`）的模型列表刷新策略被强制改为 `Offline`（mod.rs:576-580）——子智能体不该在启动时联网拉模型目录。

## 流程走读

### 总图：一次会话的生命周期

```
ThreadManager::start_thread(options)
   │
   ▼
spawn_thread() ──► Session::spawn(SessionSpawnArgs)         [创建]
   │                    │
   │                    ├─ async_channel::bounded(512)  tx_sub/rx_sub
   │                    ├─ async_channel::unbounded     tx_event/rx_event
   │                    ├─ Session::new(...)            装载状态与服务
   │                    ├─ 发出首个事件 SessionConfigured
   │                    └─ tokio::spawn(submission_loop) ← 会话循环启动
   │
   ▼
finalize_thread_spawn(): 校验首个事件 ──► CodexThread::new(session, io)
   │
   ▼                        [运行]
外壳 ──Op──► tx_sub ──► submission_loop ──► handlers / turn_input
                              │                    │
                              │                    ▼
                              │            start_task(RegularTask)
                              │                    │
                              │                    ▼
                              │            run_turn()  ……第 7 章
                              │                    │
                              ▼                    ▼
外壳 ◄──Event── rx_event ◄── send_event ◄── on_task_finished
   │                                            TurnComplete / TurnAborted
   ▼                        [结束]
Op::Shutdown ──► shutdown(): 清理运行时、flush rollout、发 ShutdownComplete
```

### 创建：Session::spawn 与「第一个事件必须是 SessionConfigured」

所有外壳殊途同归到 `ThreadManager::start_thread`（thread_manager.rs:905-907），它包一层 `start_thread_inner`（936-957）补上 `SessionSource` 默认值后，进入 `spawn_thread`（1785-1945）。`spawn_thread` 组装一个 40 字段的 `SessionSpawnArgs`，调用 `Session::spawn`（mod.rs:467-489）。

`Session::spawn_internal`（mod.rs:491-797）做的事可以分成四拍：

```rust
// 来源：codex-rs/core/src/session/mod.rs:533-534、783-794（有删节）
let (tx_sub, rx_sub) = async_channel::bounded(SUBMISSION_CHANNEL_CAPACITY); // ← 512
let (tx_event, rx_event) = async_channel::unbounded();
// ... 装载 ExecPolicy、选定模型、构造 SessionConfiguration ...
let session = Box::pin(Session::new(/* ... */)).await?;

// This task will run until Op::Shutdown is received.
let session_for_loop = Arc::clone(&session);
let session_loop_handle = tokio::spawn(async move {
    submission_loop(session_for_loop, configured_config, rx_sub)
        .instrument(info_span!("session_loop", thread_id = %thread_id))
        .await;
});
let io = SessionIo { tx_sub, rx_event, /* ... */ };
Ok((session, io))
```

两个通道的不对称是刻意的：指令通道**有界**（容量 512，mod.rs:461）——外壳提交太快时 `submit` 会挂起等待，形成背压；事件通道**无界**——内核绝不希望自己因为一个慢消费者而阻塞，`EventMsg` 的爆发（比如流式 delta）宁可堆在通道里。

`Session::new` 内部（session.rs:1489-1524）做的最后一件事，是把 `EventMsg::SessionConfigured` 作为**第一个事件**推进事件通道，载荷里有 thread_id、模型、审批策略、rollout 路径、resume 时的初始消息等。随后 `finalize_thread_spawn`（thread_manager.rs:1947-1990）会亲自消费这个事件来验证不变量：

```rust
// 来源：codex-rs/core/src/thread_manager.rs:1953-1974（有删节）
let thread_id = session.thread_id();
let event = io.next_event().await?;
let session_configured = match event {
    Event {
        id,
        msg: EventMsg::SessionConfigured(session_configured),
    } if id == INITIAL_SUBMIT_ID => session_configured,   // ← 必须是首个事件
    _ => {
        return Err(CodexErr::SessionConfiguredNotFirstEvent);
    }
};
// 登记到 ThreadManager 的线程表，然后构造对外句柄
let thread = Arc::new(CodexThread::new(
    session, io, session_configured.clone(),
    session_configured.rollout_path.clone(), session_source,
));
```

为什么用「通道里的第一个事件」而不是直接返回配置？因为 app-server 这类外壳拿到 `CodexThread` 后可能**换一批消费者**来接管事件流；把配置放进事件流本身，任何后来的消费者都能从 `session_configured()` 拿到同一份快照重放（CodexThread 上专门存了这个字段，codex_thread.rs:206）。协议即数据，连「握手」也是一条事件。

### 分发：submission_loop 是内核唯一的前门

`SessionIo::submit`（mod.rs:802-838）把 `Op` 包进 `Submission`（配上 UUID7 的 submission id，mod.rs:918-920）送进 `tx_sub`。通道另一头，`submission_loop`（handlers.rs:515-706）逐个取出并分发：

```rust
// 来源：codex-rs/core/src/session/handlers.rs:515-530、570-578、675-684（有删节）
pub(super) async fn submission_loop(
    sess: Arc<Session>,
    config: Arc<Config>,
    rx_sub: Receiver<Submission>,
) {
    // To break out of this loop, send Op::Shutdown.
    let mut shutdown_received = false;
    while let Ok(sub) = rx_sub.recv().await {
        let should_exit = async {
            match sub.op {
                Op::Interrupt => { interrupt(&sess).await; false }
                // ...
                Op::TurnInput { request, mode, reply } => {
                    let result = turn_input::handle(&sess, *request, mode, sub.id.clone()).await;
                    let _ = reply.send(result);   // ← 通过 oneshot 送回执
                    false
                }
                // ...
                Op::Shutdown => shutdown(&sess, sub.id.clone()).await, // ← 返回 true 退出
                _ => false, // Ignore unknown ops; enum is non_exhaustive to allow extensions.
            }
        }
        .instrument(dispatch_span)
        .await;
        if should_exit { shutdown_received = true; break; }
    }
    // 通道意外关闭（所有发送端 drop）时也要兜底清理：
    if !shutdown_received { /* shutdown_session_runtime 等 */ }
}
```

28 个 `Op` 变体在这里分成三类去处：

- **立即处理**：`Interrupt`、`ExecApproval`/`PatchApproval`（通知挂起的 oneshot）、`ResolveElicitation`、`RefreshMcpServers` 等。它们在循环里就地完成，不进任务队列。
- **生成任务**：`TurnInput` → `RegularTask`、`Compact` → `CompactTask`（handlers.rs:244-249）、`Review` → 评审子线程、`RunUserShellCommand` → `UserShellCommandTask`（handlers.rs:104-129）。
- **生命周期**：`Shutdown` 做完整清理（停任务、关 MCP、flush rollout、发 `ShutdownComplete`，handlers.rs:435-479）并退出循环。

每个 Op 的分发都包在一个 `op.dispatch.<op名>` 的 tracing span 里（handlers.rs:748-776 的 `submission_dispatch_span`），动手实验环节我们会用日志亲眼看到它。

关键设计：**这个循环本身永不执行回合**。回合被 `tokio::spawn` 成独立后台任务（下文），所以 `Op::Interrupt` 可以在 `RegularTask` 跑到一半时被循环接收并处理。这就是「消息循环 + 后台任务」对比「单体 async loop」的本质差异。

### 路由：turn_input.rs 决定「开始、steer、还是拒绝」

`Op::TurnInput` 落到 `turn_input::handle`（turn_input.rs:141-156），按 mode 分进三个函数。以最常用的 `StartOrSteer` 为例（turn_input.rs:167-250）：

```rust
// 来源：codex-rs/core/src/session/turn_input.rs:195-249（有删节）
match session
    .steer_input(&mut items, /* ... */)
    .await
{
    Ok(turn_id) => {
        settings.apply_steered(session, submission_id).await?;
        Ok(TurnInputSubmission::Steered { turn_id })     // ← 塞进了在跑的回合
    }
    Err(NotSubmittedReason::NoActiveTurn) => {
        let turn_context = settings
            .apply_started(session, submission_id.clone())
            .await?;                                    // ← 拍 TurnContext 快照
        // ...
        session
            .spawn_task(turn_context, task_input, RegularTask::new())
            .await;                                     // ← 开新回合
        Ok(TurnInputSubmission::Started { turn_id: submission_id })
    }
    Err(reason) => Ok(TurnInputSubmission::NotSubmitted { reason }),
}
```

逻辑只有两条岔路：

1. **有活跃回合 → steer**。`steer_input`（turn_input.rs:478-565）做一连串校验：期望的 turn_id 是否匹配、活跃任务是不是 `Regular`（`Review`/`Compact` 不可 steer，返回 `ActiveTurnNotSteerable`）、结构化输出 schema 是否一致；通过后把输入追加进该回合 `TurnState.pending_input`，等回合内下一轮模型请求时取走。
2. **没有活跃回合 → 开始新回合**。`apply_started` 先应用设置、构造 `TurnContext`，然后 `spawn_task` 把 `RegularTask` 调度出去。

`submission id` 在这里升格为 **turn id**——`TurnContext.sub_id` 就是受理这次输入的 submission id（turn_context.rs:145）。第 5 章说过 `Event.id` 用来归因事件；对回合内事件而言，这个 id 就是 turn id，外壳据此把事件归入正确的回合气泡。

### 调度：SessionTask 与 start_task

所有会占满一个回合的工作都实现 `SessionTask` trait（tasks/mod.rs:187-227）：

```rust
// 来源：codex-rs/core/src/tasks/mod.rs:179-211（有删节）
/// Async task that drives a [`Session`] turn.
pub(crate) trait SessionTask: Send + Sync + 'static {
    /// Describes the type of work the task performs so the session can
    /// surface it in telemetry and UI.
    fn kind(&self) -> TaskKind;

    fn span_name(&self) -> &'static str;

    /// Executes the task until completion or cancellation.
    fn run(
        self: Arc<Self>,
        session: Arc<Session>,
        ctx: Arc<TurnContext>,
        input: Vec<TurnInput>,
        cancellation_token: CancellationToken,
    ) -> impl std::future::Future<Output = SessionTaskResult> + Send;

    fn abort(/* ... */) -> impl std::future::Future<Output = ()> + Send { /* 默认 no-op */ }
}
```

`start_task`（tasks/mod.rs:291-432）是任务的「接生婆」，顺序很关键：

1. 从 `input_queue.get_pending_input` 收走积压输入（比如 mailbox 里 `trigger_turn` 的多智能体消息）；
2. 在 `active_turn` 上登记 `RunningTask`——**先占位再 spawn**，保证 `active_turn` 的非空判断与任务挂载是原子的；
3. `tokio::spawn` 一个异步块：先 `task.run(...)`，跑完 `flush_rollout()`（[第 13 章](ch13-persistence.md)），然后统一调 `on_task_finished`；
4. `RunningTask` 持有 `CancellationToken` 和 `AbortOnDropHandle`——打断与强杀的两级开关。

注意第 3 步的收尾位置：「flush rollout + on_task_finished」写在 spawn 出来的异步块里而不是各个任务的 `run` 里，注释原话是 *"Finish uniformly from the spawn site so all tasks share the same lifecycle"*（tasks/mod.rs:408）。四种任务（Regular/Review/Compact/UserShellCommand）共享同一套完成协议，新增任务类型不用重抄收尾逻辑。

### 回合内：RegularTask 与 run_turn 的入口

`RegularTask::run`（tasks/regular.rs:39-91）是通往第 7 章的门厅：

```rust
// 来源：codex-rs/core/src/tasks/regular.rs:46-91（有删节）
async fn run(
    self: Arc<Self>,
    sess: Arc<Session>,
    ctx: Arc<TurnContext>,
    input: Vec<TurnInput>,
    cancellation_token: CancellationToken,
) -> SessionTaskResult {
    let run_turn_span = trace_span!("run_turn");
    // Regular turns emit `TurnStarted` inline so first-turn lifecycle does
    // not wait on startup prewarm resolution.
    let prewarmed_client_session = async {
        let event = EventMsg::TurnStarted(TurnStartedEvent {
            turn_id: ctx.sub_id.clone(),
            // ...
        });
        sess.send_event(ctx.as_ref(), event).await;   // ← 回合正式开始
        // ... 等待启动预热的模型客户端会话 ...
    }
    .instrument(trace_span!("regular_task.prepare_run_turn"))
    .await;
    // ...
    let mut next_input = input;
    loop {
        let last_agent_message = run_turn(
            Arc::clone(&sess),
            Arc::clone(&ctx),
            next_input,
            prewarmed_client_session.take(),
            cancellation_token.child_token(),
        )
        .await?;
        if !sess.input_queue.has_pending_input(&sess.active_turn).await {
            return Ok(last_agent_message);            // ← 没有新输入，回合结束
        }
        next_input = Vec::new();                      // ← 有 steer 输入，原地再跑一轮
    }
}
```

三件事值得划线：

- **`TurnStarted` 在 `run_turn` 之前发出**。外壳收到它就可以把 spinner 亮起来；回合内部的模型调用全部留给 `run_turn`（turn.rs:153-159），下一章从那里接着讲。
- **steer 的汇合点在这个 `loop`**。用户中途追加的输入进了 `pending_input`，`run_turn` 返回后这里发现队列非空，就用同一个 `TurnContext` 再跑一轮——对模型而言这就是「用户又说话了」，不需要新开回合、不需要重建上下文。
- **`cancellation_token.child_token()`**。任务持有父令牌，`run_turn` 拿子令牌；`Op::Interrupt` 取消父令牌时整棵子树一起收到取消信号。

### 打断：Op::Interrupt 的两级停止

`Op::Interrupt` → `Session::interrupt_task`（mod.rs:4151-4158）→ `abort_all_tasks(TurnAbortReason::Interrupted)`（tasks/mod.rs:494-522）。核心在 `handle_task_abort`（tasks/mod.rs:880-973）：

```rust
// 来源：codex-rs/core/src/tasks/mod.rs:886-917（有删节）
trace!(task_kind = ?task.kind, sub_id, "aborting running task");
task.cancellation_token.cancel();                 // ← 第一级：协作式取消
// ...
select! {
    _ = task.done.notified() => {
        // 任务看到令牌取消，自己跑完了清理
    },
    _ = tokio::time::sleep(Duration::from_millis(GRACEFULL_INTERRUPTION_TIMEOUT_MS)) => {
        // 100ms 内没响应，放弃等待
        warn!("task {sub_id} didn't complete gracefully after {}ms", ...);
    }
}
task.handle.abort();                              // ← 第二级：tokio 强杀
session_task.abort(Arc::clone(self), Arc::clone(&task.turn_context)).await;
```

先 `cancel()` 给任务 100ms 体面收尾（flush、发事件），超时后 `handle.abort()` 强制取消 future——沙箱里卡死的子进程不会让 Esc 键失灵。打断后还会往历史里写一条 `<turn_aborted>` 标记（tasks/mod.rs:919-937），让模型在下一个回合知道「上次话说到一半被打断了」，这个细节第 7 章会再遇到。

### 完成：on_task_finished 统一收口

任务正常结束、出错、被取消，最终都汇到 `on_task_finished`（tasks/mod.rs:571-846）。它做的事按序是：取出并清空 `active_turn` 里的任务 → 收走残留 `pending_input` 记进历史 → 记录 token 用量指标 → 按结局发出 `EventMsg::TurnComplete` 或 `EventMsg::TurnAborted` → 清空 `active_turn` → 检查 mailbox 里有没有 `trigger_turn` 的消息，有就立刻用 `maybe_start_turn_for_pending_work`（tasks/mod.rs:463-492）自动开下一个回合。

最后一步让「状态机」闭合了：**回合结束不是终点，而是检查待办的时刻**。多智能体场景里子线程给根线程发信，根线程空闲时就这样被自动唤醒——不需要外壳轮询。

### 广播：事件如何流出内核

回合内外所有 `sess.send_event(...)` 调用都走同一条管道（mod.rs:1932-1975）：

```rust
// 来源：codex-rs/core/src/session/mod.rs:1932-1936、1952-1956，2167-2188（有删节）
pub(crate) async fn send_event(&self, turn_context: &TurnContext, msg: EventMsg) {
    // ... 记录 terminal_error、rollout trace ...
    let event = Event {
        id: turn_context.sub_id.clone(),   // ← 事件 id = 回合 id
        msg,
    };
    self.send_event_raw(event).await;
    // ... 还会派生 legacy 兼容事件再各发一份（见第 5 章） ...
}

async fn send_event_raw_with_persistence(&self, event: Event, persist: bool) {
    if persist {
        let rollout_items = vec![RolloutItem::EventMsg(event.msg.clone())];
        self.persist_rollout_items(&rollout_items).await;   // ← 先落 rollout
    }
    self.deliver_event_raw(event).await;
}

async fn deliver_event_raw(&self, event: Event) {
    // Record the last known agent status.
    if let Some(status) = agent_status_from_event(&event.msg) {
        self.agent_status.send_replace(status);   // ← watch 通道更新状态快照
    }
    if let Err(e) = self.tx_event.send(event).await {
        debug!("dropping event because channel is closed: {e}");
    }
}
```

每个事件做三件事：**持久化**（写 rollout，第 13 章）、**更新状态快照**（`AgentStatus`，protocol.rs:1748-1764：`PendingInit/Running/Interrupted/Completed/Errored/Shutdown`，由事件推导）、**推给外壳**。外壳侧的 `CodexThread::next_event()` 只是 `rx_event.recv().await`（mod.rs:899-906）；通道关闭时返回 `CodexErr::InternalAgentDied`——「会话循环死了」在协议层就是一个普通错误，外壳据此退出事件循环。

## 设计取舍

**为什么 CodexThread 与 Session 分离，而不是一个对象？** 因为两者的生命周期和可见性不同：`Session` 是 `pub(crate)` 的实现细节，里面全是 `Mutex` 与内部服务；`CodexThread` 是对外壳的窄接口（60 来个公开方法，绝大多数单行转发）。分离后，外壳**无法**绕过消息协议直接摸会话状态——编译器强制执行了「内核与 UI 解耦」这条[第 1 章](ch01-overview.md)的架构结论。代价是 `CodexThread` 上有不少纯转发样板代码，但相比外壳直接持有 `Arc<Session>` 造成的耦合，这点样板是便宜的。

**为什么只有一个串行的 submission_loop，而不是每个 Op 一个任务？** 串行分发让「Op 的处理顺序 = 提交顺序」成为免费保证：`Op::ThreadSettings` 改了模型之后紧跟的 `Op::TurnInput` 一定用新模型开回合，不需要任何锁协议。真正耗时的回合执行被挪到后台任务里，所以循环本身几乎不阻塞——这是「串行决策、并行执行」的经典分工。

**对比 my-agent：取消与中断。** 你的 TS 项目里大概率是 `AbortController` + 一路向下传 `signal`。Codex 的结构本质相同（`CancellationToken` 树），但有两个 TS 里不容易做到的强化：其一，**两级停止**——`cancel()` 后等 100ms 再 `handle.abort()` 强杀，TS 里没有等价物，Promise 无法被外部强制取消，你只能靠每个 `await` 点自觉检查 `signal`；其二，**取消是消息**——`Op::Interrupt` 和审批决定走同一条队列，所以「打断」天然与会话内其他操作全序排列，不存在「UI 的 AbortController 和 Agent loop 的时序对不上」这类竞态。你在 my-agent 里如果遇到过「用户按了取消但工具已经发出去了」的 bug，根因就是取消信号绕过了主事件流；Codex 把它收编进了主事件流。

**steer 为什么值得单独一套机制？** 简单方案是「回合运行中收到的输入排队，回合结束再开新回合」。Codex 选择让输入**插入当前回合的下一轮模型请求**（`pending_input` + `RegularTask` 里的 loop），因为对话历史是增量追加的（第 5 章），同一回合内继续采样能复用已组装的上下文与 `TurnContext`，模型也能看到「用户是在我干活的中途插话的」。代价是 `input_queue.rs` 里 600 多行的投递阶段管理（`MailboxDeliveryPhase` 等，state/turn.rs:48-56），这是为多智能体 mailbox 付出的复杂度，单用户场景确实用不满。

**局限与演进方向。** `TurnContext` 字段里能看到时代的遗迹：`cwd` 被标了 `#[deprecated]`（turn_context.rs:170-171），注释指向按环境（environment）选择 cwd 的新模型——Codex 正在从「一个会话一个工作目录」演进到「一个会话可挂多个执行环境」，`TurnContext` 是这场迁移的前线。另外 `Session` 结构体本身（70 字段）与 `SessionServices`（40 字段）的体量说明 `core` 的拆分仍在进行中，AGENTS.md 里「resist adding to codex-core」的告诫就是为这个病灶开的。

## 动手实验

找到本章主角的定义位置（在仓库根目录执行）：

```shell
cd codex-rs
rg -n "pub struct CodexThread" core/src/codex_thread.rs
rg -n "pub\(crate\) struct Session\b" core/src/session/session.rs
rg -n "pub\(crate\) trait SessionTask" core/src/tasks/mod.rs
rg -n "pub enum SessionSource" protocol/src/protocol.rs
# 预期输出：各打印 1 行定义位置，与本章引用的行号吻合
```

数一数 Op 的变体，验证书中「28 个」的说法：

```shell
rg -n "^pub enum Op \{" protocol/src/protocol.rs   # 找到起始行（545）
# 然后阅读 545-705 行数变体；或粗略计数：
sed -n '545,705p' protocol/src/protocol.rs | rg -c "^    [A-Z]"
# 预期输出：28（含带 payload 的变体）
```

用日志亲眼观察分发循环。每个 Op 分发都会进 `op.dispatch.*` span（handlers.rs:748-776）：

```shell
cd codex-rs
RUST_LOG=codex_core=debug cargo run --bin codex -- exec "say hi" 2>&1 \
  | rg "Submission|op.dispatch|session_loop|thread_spawn" | head -20
# 预期输出形态：
#   ... DEBUG ... Submission { id: "...", op: TurnInput { ... } }
#   ...  INFO session_loop ... thread_id=...
#   ...  op.dispatch.turn_input ... submission.id=...
# 不同版本的 tracing 格式略有差异，关键是能看到 op 名与 submission id
```

观察事件的起点与终点：

```shell
rg -n "EventMsg::SessionConfigured" core/src/session/session.rs
# 预期：1496 行附近——Session::new 发出的第一个事件
rg -n "fn finalize_thread_spawn" core/src/thread_manager.rs
# 预期：1947 行——消费并校验这个事件的地方
```

如果你是本书环境的沙箱里（`CODEX_SANDBOX_NETWORK_DISABLED=1`），`cargo run` 的模型请求会失败，但 `Submission`/`op.dispatch` 的日志在请求发出前就已打印，观察链路不受影响。

## Rust 侧栏

本章用到的语言与并发设施：

- **`async_channel::bounded` vs `unbounded`**：有界通道满了之后 `send().await` 挂起，形成背压（指令通道，容量 512）；无界通道永不阻塞发送方（事件通道）。取舍：宁可让外壳等待，也不让内核丢事件或积压到 OOM。
- **`watch::channel`**：tokio 的「最新值广播」通道，只保留**最近一个**值，任意多订阅者随时 `borrow()` 当前值。`AgentStatus` 用它正合适——没人关心中间态，只要「现在是什么状态」。
- **`CancellationToken`（tokio-util）**：可克隆的取消信号，`child_token()` 形成树。父令牌取消时整棵树收到信号——`Session → RunningTask → run_turn` 就是一条令牌链。相比 `AbortController`，它天然支持多对多的「谁都可以取消、谁都可以监听」。
- **`AbortOnDropHandle`**：包一层 `JoinHandle`，drop 时自动 `abort()` 对应的 tokio 任务。`RunningTask` 用它保证「任务记录被清掉 ⇒ 后台任务一定被杀」，不会泄漏孤儿任务。RAII 思想在并发对象上的应用。
- **`Shared<BoxFuture>`**：`SessionLoopTermination` 的类型（mod.rs:378），把一个 future 变成可 clone、可多方 `await` 的共享完成信号——多处代码（`shutdown_and_wait`、`suspend_turn_and_shutdown`）都要等同一个「会话循环已退出」时刻。
- **trait 返回 `impl Future + Send`（RPITIT）**：`SessionTask::run` 的签名（tasks/mod.rs:205-211）是 Rust 原生异步 trait 写法，不需要 `#[async_trait]` 宏；返回 `impl Future` 让实现方可以写 `async fn`。`AnySessionTask` 那层 `BoxFuture` 包装（tasks/mod.rs:229-243）则是为了能把不同任务类型塞进同一个 `Arc<dyn ...>`——静态分发留给单点调用，动态分发留给异构存储。

## 小结 + 思考题

本章把「一次会话」拆成了五个各司其职的对象：`ThreadManager` 管创建与户籍，`CodexThread` 是对外壳的窄句柄，`Session` 持有全部运行时状态，`SessionIo` 提供有背压的指令通道与无界的事件通道，`TurnContext` 冻结单个回合的配置快照。一条 `submission_loop` 串行分发 28 种 `Op`；回合作为 `SessionTask` 后台任务运行，所以打断、审批回复能在回合进行中抵达；`ActiveTurn`/`TurnState` 界定了回合边界——设置变更只在边界生效，steer 输入在边界内汇入。事件流统一经 `send_event` 落 rollout、更新 `AgentStatus`、推给外壳。下一章进入 `run_turn` 内部：上下文组装、模型流式调用与工具执行循环。

思考题：

1. `finalize_thread_spawn` 用「通道里的第一个事件」而不是返回值来交接 `SessionConfigured`，如果改成 `Session::spawn` 直接返回配置结构体会丢失什么能力？（提示：考虑 app-server 换消费者接管事件流的场景，thread_manager.rs:1947-1990）
2. `steer_input` 拒绝向 `Compact`/`Review` 回合插入用户输入（turn_input.rs:507-519）。如果允许 steer 进 `CompactTask`，协议层和历史记录会出什么乱子？
3. 指令通道容量是 512（mod.rs:461）。假设一个失控的外壳死循环提交 `Op::Interrupt`，容量满之后会发生什么？这个设计把压力推给了谁，合理吗？
4. 在 my-agent 里实现「回合进行中追加用户输入」：你现有的 loop 里哪一段相当于 `RegularTask::run` 末尾的 `has_pending_input` 检查？如果还没有这个检查点，用户插话会在你的架构里走到哪里？
