# 第 14 章 TUI 架构

## 本章导读

前面十三章把 Agent 内核几乎翻了个底朝天，但你日常敲 `codex` 看到的那个终端界面——闪烁的光标、逐行"打字"出来的回答、突然弹出的审批菜单——还没有正面登场。本章回答一个看起来简单、实则很硬的问题：**一个 ratatui 终端 UI，如何与一个异步 Agent 内核共存于同一个进程？**

困难在于终端是一块"独占资源"。键盘输入是全局唯一的一条 stdin 字节流；屏幕是全局唯一的一块画布；而内核那边，模型增量、工具输出、审批（approval）请求、MCP 状态更新随时可能涌进来。如果处理不慎，你会得到教科书级的故障：动画帧把正在打字的用户输入顶掉、审批弹窗和模型输出抢同一块屏幕区域、外部编辑器（`$EDITOR`）和 TUI 同时读 stdin 互相吞字符。你的 my-agent 用 readline 加一个 `await agent.run()` 就能跑，是因为你把「一次只有一个事件源活跃」当成了隐含假设——Codex 不能做这个假设。

本章的第一个关键认知是：**在本基线上，TUI 不直接持有内核句柄，它是 app-server 的一个渲染端**。TUI 进程内部嵌了一个进程内 app-server（`InProcessAppServerClient`），用与 IDE 扩展同一套 JSON-RPC 协议（`thread/start`、`turn/start`、`turn/steer`、审批 `ServerRequest`）与会话通信，只是传输层从 stdio/socket 换成了 tokio channel。这意味着你在第 6、7、11 章学到的内核侧机制，在 TUI 侧看到的都是"翻译过的"形态：内核的 `EventMsg::AgentMessageContentDelta` 变成 app-server 通知 `item/agentMessage/delta`；内核的审批 oneshot 变成 JSON-RPC 的 `ServerRequest` 等待客户端响应。内核世界的两个主角——主线（thread）与回合（turn）——在 TUI 侧同样是组织事件的轴心：每条主线有自己的事件缓冲，每个进行中的回合决定回车键是开新回合还是 steer。

本章按「启动 → 主循环 → 重绘调度 → 输入路径 → 事件回流 → 流式渲染 → 审批闭环」的顺序走读，最后讨论这套设计的代价。读完你应该能回答：为什么 UI 状态变更全部串行在一个 `select!` 循环里？为什么重绘不是"有事件就画"？审批弹窗凭什么能"阻塞"内核而不阻塞 UI？

## 源码地图

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-rs/tui/src/lib.rs` | `run_main` 入口、启动编排、内嵌 app-server 装配 | TUI 与 app-server 的焊接点，:566-590 是本章锚点 |
| `codex-rs/tui/src/startup_orchestration.rs` | `run_main_inner`：CLI 解析→配置→草稿输入→进入 App | 把"慢启动"拆成可被键盘打断的阶段 |
| `codex-rs/tui/src/tui.rs` | `Tui` 终端句柄、`TuiEvent` 定义、alt-screen/panic 善后 | 终端这块"独占资源"的所有者 |
| `codex-rs/tui/src/tui/event_stream.rs` | `EventBroker`/`TuiEventStream`：crossterm 事件→`TuiEvent` | 为"交出 stdin"而生的可丢弃事件流 |
| `codex-rs/tui/src/tui/frame_requester.rs` | `FrameRequester`/`FrameScheduler`：合并重绘请求 | 任何组件都能克隆的"请求画一帧"句柄 |
| `codex-rs/tui/src/tui/frame_rate_limiter.rs` | 帧率上限（约 120 FPS） | 一行常量决定全 UI 的刷新天花板 |
| `codex-rs/tui/src/app.rs` | `App` 顶层状态、`handle_tui_event`、渲染入口 | 900 行，只做编排与接线 |
| `codex-rs/tui/src/app/startup.rs` | `App::run`：主事件循环 `select!` | 全章最重要的一段代码 |
| `codex-rs/tui/src/app_event.rs` | `AppEvent`：UI 内部消息总线 | 组件与 App 之间的唯一语言 |
| `codex-rs/tui/src/app_event_sender.rs` | `AppEventSender`：带类型 helper 的发送端 | 审批决定从这里回发 |
| `codex-rs/tui/src/app_command.rs` | `AppCommand`：发往会话的指令（`UserTurn`/`Interrupt`/`ExecApproval`…） | TUI 侧的"Op"，注意与内核 `Op` 区分 |
| `codex-rs/tui/src/app/app_server_events.rs` | app-server 通知/请求的路由 | 多线程（主线/子代理/side）事件分拣 |
| `codex-rs/tui/src/app/thread_routing.rs` | per-thread 通道、`turn/start` vs `turn/steer` 决策、审批解析 | 本章第二主战场 |
| `codex-rs/tui/src/app/app_server_requests.rs` | 待响应 `ServerRequest` 台账与 `take_resolution` | 审批闭环的"账本" |
| `codex-rs/tui/src/app/thread_events.rs` + `thread_event_buffer.rs` | per-thread 事件缓冲、delta 合并 | 切换主线时靠它重放 |
| `codex-rs/tui/src/app_server_session.rs` | `AppServerSession`：typed JSON-RPC 封装（`turn_start`/`turn_steer`/`resolve_server_request`） | TUI 的"会话客户端" |
| `codex-rs/tui/src/chatwidget.rs` | `ChatWidget` 中央组件（结构定义与模块文档） | 2000+ 行；实现按职责拆在 `chatwidget/` 子目录 |
| `codex-rs/tui/src/chatwidget/protocol.rs` | `handle_server_notification`：通知→UI 状态 | 事件进入 ChatWidget 的总闸门 |
| `codex-rs/tui/src/chatwidget/streaming.rs` + `streaming/controller.rs` | 流式增量缓冲、按行提交动画 | 「打字机效果」的全部秘密 |
| `codex-rs/tui/src/chatwidget/input_submission.rs` | 提交用户消息、构造 `AppCommand::UserTurn` | 乐观渲染（先上屏再请求）在这里 |
| `codex-rs/tui/src/bottom_pane/` | 输入区：`ChatComposer`、弹窗栈、`ApprovalOverlay` | 输入路由的仲裁者 |
| `codex-rs/app-server-client/src/lib.rs` | `InProcessAppServerClient`：进程内客户端 | 有界命令 + 无界本地事件队列，防死锁 |

## 核心数据结构

### 终端事件：`TuiEvent`

TUI 把 crossterm 的原始事件收敛成五个变体，这是主循环"看向终端"的全部视野：

```rust
// 来源：codex-rs/tui/src/tui.rs:559-577
#[derive(Clone, Debug)]
pub enum TuiEvent {
    /// A terminal key event after focus, paste, and protocol bookkeeping has been handled.
    Key(KeyEvent),          // ← 按键（已完成焦点/粘贴协议记账）
    /// A bracketed paste payload normalized by the app layer before it reaches the composer.
    Paste(String),          // ← 括号粘贴，进 composer 前会再做 CRLF 归一化
    /// A terminal size notification and its reported dimensions.
    Resize(Size),           // ← 终端尺寸变化（与 Draw 分开，便于走重排逻辑）
    /// A scheduled repaint that does not necessarily correspond to a terminal size change.
    Draw,                   // ← 一次被"调度出来"的重绘，不对应任何终端事件
    /// The first repaint after returning from process suspension.
    Resume,                 // ← Ctrl+Z 挂起恢复后的第一帧
}
```

注意 `Draw` 不是终端产生的——它来自一个内部的 broadcast 通道，任何组件都能通过 `FrameRequester` 预约一帧。这是"定时重绘"与"事件重绘"统一成一个变体的关键设计，4.3 节展开。

### UI 内部总线：`AppEvent` 与 `AppEventSender`

组件（composer、弹窗、后台任务）不直接调用 `App` 的方法，而是往一条 unbounded channel 里发 `AppEvent`：

```rust
// 来源：codex-rs/tui/src/app_event.rs:1-9（模块文档）
// `AppEvent` is the internal message bus between UI components and the top-level `App` loop.
// Widgets emit events to request actions that must be handled at the app layer (like opening
// pickers, persisting configuration, or shutting down the agent), without needing direct access to
// `App` internals.
```

`AppEvent` 枚举本体有上百个变体（app_event.rs:198 起），你只消记住几个代表：`CodexOp(AppCommand)`（发指令给会话）、`SubmitThreadOp { thread_id, op }`（指定主线发指令）、`InsertHistoryCell(...)`（往对话历史插一格）、`StartCommitAnimation`/`CommitTick`（流式动画节拍）、`Exit(ExitMode)`（请求退出）。发送端被包装成带类型安全 helper 的 `AppEventSender`：

```rust
// 来源：codex-rs/tui/src/app_event_sender.rs:22-43
#[derive(Clone, Debug)]
pub(crate) struct AppEventSender {
    pub app_event_tx: UnboundedSender<AppEvent>, // ← 无界通道，见 5.2 节的取舍讨论
}

impl AppEventSender {
    pub(crate) fn send(&self, event: AppEvent) {
        // Record inbound events for high-fidelity session replay.
        if !matches!(event, AppEvent::CodexOp(_)) {
            session_log::log_inbound_app_event(&event); // ← 可落盘成 JSONL 供回放
        }
        if let Err(e) = self.app_event_tx.send(event) {
            tracing::error!("failed to send event: {e}");
        }
    }
}
```

这个 struct 可以无限克隆、随手传给任何组件——它就是 UI 世界的"依赖注入容器"，只不过注入的是一个发消息的口。

### 发往会话的指令：`AppCommand`

**先澄清一个全书最容易混淆的命名。** 内核协议层没有 `Op::UserTurn`（用户输入走 `Op::TurnInput`，见[第 6 章](ch06-core-session.md)）；但 TUI 侧有一个同义不同层的 `AppCommand::UserTurn`——它是 TUI 内部指令，最终会被翻译成 app-server 的 `turn/start` 或 `turn/steer` JSON-RPC 请求，再由 app-server 落到内核：

```rust
// 来源：codex-rs/tui/src/app_command.rs:26-68（节选）
pub(crate) enum AppCommand {
    Interrupt,                    // ← 打断当前回合
    RunUserShellCommand { command: String }, // ← "!cmd" 本地直跑
    UserTurn {
        items: Vec<UserInput>,               // ← 文本/图片等输入条目
        cwd: PathBuf,
        approval_policy: AskForApproval,     // ← 随回合携带的审批策略快照
        model: String,
        effort: Option<ReasoningEffortConfig>,
        // ...
    },
    ExecApproval {
        id: String,                          // ← 对应内核审批请求的 approval_id/item_id
        turn_id: Option<String>,
        decision: CommandExecutionApprovalDecision, // ← Accept / AcceptForSession / Cancel ...
    },
    PatchApproval { id: String, decision: FileChangeApprovalDecision },
    // ...
}
```

`ExecApproval` 的 `decision` 用的是 app-server 协议的 `CommandExecutionApprovalDecision`，不是内核的 `ReviewDecision`——因为 TUI 回的是 JSON-RPC 响应，`ReviewDecision` 的转换发生在 app-server 内部（[第 11 章](ch11-sandbox-approval.md)讲了内核侧如何等待这个决定）。

### per-thread 事件缓冲：`ThreadBufferedEvent` 与 `ThreadEventStore`

TUI 支持在主线、子代理、side conversation 之间切换，所以每个主线（thread）有自己的事件缓冲：

```rust
// 来源：codex-rs/tui/src/app/thread_events.rs:19-53（节选）
#[derive(Debug, Clone)]
pub(super) enum ThreadBufferedEvent {
    Notification(Box<ServerNotification>),  // ← app-server 推来的通知（增量、条目完成…）
    Request(Box<ServerRequest>),            // ← 需要用户响应的请求（审批、elicitation）
    HistoryEntryResponse(HistoryLookupResponse), // ← 历史查询回包
    FeedbackSubmission(FeedbackThreadEvent),
}

pub(super) struct ThreadEventStore {
    pub(super) session: Option<ThreadSessionState>,
    pub(super) turns: Vec<Turn>,
    pub(super) buffer: VecDeque<ThreadBufferedEvent>, // ← 重放缓冲
    pub(super) active_turn_id: Option<String>,        // ← steer 决策依赖它（4.4 节）
    pub(super) pending_interrupt_turn_id: Option<String>,
    pub(super) capacity: usize,                        // ← 32768（app.rs:259）
    pub(super) active: bool,                           // ← 是否正显示在前台
    pub(super) buffered_agent_message_delta_bytes: usize,
}
```

这个 store 同时承担两个角色：活动主线的事件泵（event pump）和非活动主线的重放日志（replay log）。`TurnStarted`/`TurnCompleted` 通知会顺带维护 `active_turn_id`（thread_events.rs:127-141），这个字段后面要用来回答"用户此刻按回车，应该 `turn/start` 还是 `turn/steer`？"。

### 客户端事件：`AppServerEvent`

从 app-server 看回来，TUI 消费的事件流只有四种形状：

```rust
// 来源：codex-rs/app-server-client/src/lib.rs:96-102
#[derive(Debug, Clone)]
pub enum AppServerEvent {
    Lagged { skipped: usize },               // ← 消费太慢被丢弃过事件（会触发刷新补偿）
    ServerNotification(Box<ServerNotification>), // ← 通知：delta、条目、状态变更…
    ServerRequest(Box<ServerRequest>),       // ← 反向请求：审批、用户输入、MCP elicitation
    Disconnected { message: String },
}
```

`ServerNotification` 与 `ServerRequest` 的区分是整个审批机制的骨架：**通知是 fire-and-forget，请求是挂起等响应的**。内核里"等用户点审批按钮"的 oneshot，跨过 app-server 边界后就变成了一个 JSON-RPC `ServerRequest`，由 TUI 负责回响应（4.7 节）。

## 流程走读

### 4.1 启动：TUI 其实是 app-server 的进程内客户端

`run_main`（lib.rs:929-952）只是个薄壳：它把异常中的"用户取消启动"折叠成正常退出，真正的编排委托给 `startup_orchestration::run_main_inner`（startup_orchestration.rs:8）。这个文件处理 CLI 参数、配置加载、危险模式标志，然后进入 `run_ratatui_app`（lib.rs:955）做真正的装配。装配的核心一步是**先在进程内启动一个 app-server**：

```rust
// 来源：codex-rs/tui/src/lib.rs:566-587（start_embedded_app_server_with 节选）
let client = start_client(InProcessClientStartArgs {
    arg0_paths,
    config: Arc::new(config),
    cli_overrides: cli_kv_overrides,
    // ...
    session_source: serde_json::from_value(serde_json::json!("cli"))
        .unwrap_or_else(|err| panic!("cli session source should deserialize: {err}")),
    // ← 会话来源标记为 "cli"，与 VS Code 等来源区分（第 1 章的 SessionSource）
    enable_codex_api_key_env: false,
    client_name: "codex-tui".to_string(),
    client_version: env!("CARGO_PKG_VERSION").to_string(),
    experimental_api: true,
    channel_capacity: DEFAULT_IN_PROCESS_CHANNEL_CAPACITY,
})
.await
.wrap_err("failed to start embedded app server")?;
```

`InProcessAppServerClient::start`（app-server-client/src/lib.rs:322-419）做三件事：启动内嵌的 app-server 运行时（内部复用与 stdio/socket 版完全相同的 `MessageProcessor`，app-server/src/in_process.rs:366 起），建一条**有界**命令通道发请求，再建一条**无界**本地事件队列收通知。代码里特意留了一段注释解释为什么本地事件队列必须无界：

```rust
// 来源：codex-rs/app-server-client/src/lib.rs:332-337
// e9996ec62a preserved transcript events by awaiting a bounded queue, but that can
// deadlock a foreground request whose response is behind unread notifications.
// Match the remote-client fix in 79ea57715636: only this local consumer queue is
// unbounded; commands and the embedded runtime stay bounded and events remain ordered.
// ← 翻译：若事件队列有界，一个正在等响应的前台请求可能被"排在未读通知后面"而死锁；
//   所以只有本地消费队列放开为无界，命令与运行时侧保持有界，事件顺序不变
```

也就是说：连"进程内"这条传输层，Codex 都按分布式系统的纪律来设计——这正是第 1 章"内核与 UI 用消息协议解耦"在 TUI 内部的递归体现。装配完成后，`App::run` 被调用（lib.rs:1697-1720），启动时序大致如下：

```
run_main (lib.rs:929)
  │  StartupCancelled → 静默退出
  ▼
run_main_inner (startup_orchestration.rs:8)
  │  CLI 参数 → Config（第 3 章）；临时草稿 composer 先接管终端，
  │  让用户在慢初始化期间也能打字（startup_draft）
  ▼
run_ratatui_app (lib.rs:955)
  ├─ start_embedded_app_server ──► InProcessAppServerClient::start
  │      (lib.rs:566-590)             │ 进程内 MessageProcessor
  │                                   ▼
  │                            有界命令通道 + 无界事件队列
  ▼
App::run (app/startup.rs:69)
  ├─ bootstrap：模型目录/账号/rate limit 预取
  ├─ ChatWidget::new_with_app_event（注入 FrameRequester + AppEventSender）
  ├─ 按 SessionSelection 走 StartFresh / Resume / Fork
  ▼
主事件循环（4.2 节）
```

### 4.2 主循环：一个 `select!`  multiplexing 四路事件源

`App::run` 的主体是一个 `loop { select! { ... } }`（app/startup.rs:663-785）。这就是"TUI 如何同时处理键盘、重绘和内核事件"的答案——不是多线程抢锁，而是**单任务多路复用**：

```rust
// 来源：codex-rs/tui/src/app/startup.rs:675-758（大幅删节，保留四分支骨架）
let control = select! {
    // 分支 1：UI 内部消息总线（组件发来的 AppEvent）
    Some(event) = app_event_rx.recv() => {
        match Box::pin(app.handle_event(tui, &mut app_server, event)).await { /* ... */ }
    }
    // 分支 2：当前活动主线的事件通道（app-server 通知经路由后送达）
    active = async {
        if let Some(rx) = app.active_thread_rx.as_mut() { rx.recv().await } else { None }
    }, if App::should_handle_active_thread_events(/* ... */)
        && !has_pending_app_events => {                        // ← guard：先排空 AppEvent
        app.handle_active_thread_event(tui, &mut app_server, event).await /* ... */
    }
    // 分支 3：终端事件（按键/粘贴/Resize/Draw）
    event = tui_events.next(), if !block_terminal_input_for_pending_startup_events => {
        app.handle_tui_event(tui, &mut app_server, event).await /* ... */
    }
    // 分支 4：app-server 原始事件流（通知 + ServerRequest）
    app_server_event = app_server.next_event(), if listen_for_app_server_events => {
        match app_server_event {
            Some(event) => app.handle_app_server_event(&app_server, event).await,
            None => { listen_for_app_server_events = false; /* ... */ }
        }
    }
};
```

四个分支，四种时间尺度：键盘是毫秒级人类输入；`Draw` 是被帧率限制器压到 ≤120 FPS 的重绘；主线事件是内核活动的实时投影；`app_server.next_event()` 是所有主线（含子代理）的总入口。`select!` 的分支可以带 `if` 前置条件（guard），这里就用得很密集——比如"有未处理的 AppEvent 时暂不消费主线事件"（保证 UI 指令先于新事件应用）、"启动期有保护性请求时冻结终端输入"（防止用户还没看清信任弹窗，提前敲的键就误触确认）。

这个结构的直接推论是：**所有 UI 状态变更都是串行的**。没有 `Mutex<ChatWidget>`，没有数据竞争；所有并发都在 channel 边界被吸收、排序、串行化。画一张全景：

```
                 ┌─────────────────── TUI 进程 ───────────────────┐
 键盘/粘贴/Resize │ crossterm EventStream ──► EventBroker ─┐       │
                 │                                        ▼       │
 FrameRequester ─┼─► FrameScheduler ─► broadcast(1) ──► TuiEventStream
 (任意组件)      │        (合并+限速)                    │ TuiEvent │
                 │                                        │       │
                 │   ┌────────────────────────────────────┘       │
                 │   ▼                                            │
 组件/后台任务 ──┼─► AppEvent (unbounded) ──┐                      │
                 │                          │                      │
                 │                          ▼                      │
                 │                    loop { select! { ... } }     │◄─┐
                 │                          │                      │ │
                 │                          ▼                      │ │
                 │              App::handle_* / ChatWidget         │ │
                 │                          │                      │ │
                 │                          ▼                      │ │
                 │                    tui.draw(...) 渲染帧          │ │
                 └────────────────────────────────────────────────┘ │
                                                                    │
 内核(core) ──► app-server MessageProcessor ──► next_event() ───────┘
                  （审批等 ServerRequest 反向到达，4.7 节）
```

### 4.3 重绘调度：`FrameRequester`、合并与 120 FPS 上限

如果每个模型增量都触发一次终端写入，滚屏会糊成一片且 CPU 飙升。Codex 的做法是把"我想重绘"变成一个可投递的请求，由专职任务合并：

```rust
// 来源：codex-rs/tui/src/tui/frame_requester.rs:30-54（节选）
#[derive(Clone, Debug)]
pub struct FrameRequester {
    frame_schedule_tx: mpsc::UnboundedSender<Instant>, // ← 投递"期望绘制时刻"
}

impl FrameRequester {
    pub fn new(draw_tx: broadcast::Sender<()>) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let scheduler = FrameScheduler::new(rx, draw_tx);
        tokio::spawn(scheduler.run()); // ← 专职调度任务（actor/handler 模式）
        Self { frame_schedule_tx: tx }
    }

    pub fn schedule_frame(&self) {
        let _ = self.frame_schedule_tx.send(Instant::now());
    }
}
```

`FrameScheduler`（frame_requester.rs:74-120）的循环只做一件事：把所有请求的时刻取最小值，睡到这个时刻，然后往 `broadcast` 通道发一个 `()`。注释写明了意图："A single draw notification is sent for multiple requests scheduled before the next draw deadline"——**截止时间前到达的 N 个请求只产生一次绘制**。限速在 `FrameRateLimiter`：

```rust
// 来源：codex-rs/tui/src/tui/frame_rate_limiter.rs:13
pub(super) const MIN_FRAME_INTERVAL: Duration = Duration::from_nanos(8_333_334);
// ← ≈ 8.3ms，即 120 FPS 上限
```

注意 draw 通道是 `broadcast::channel(1)`（tui.rs:628）：容量为 1，消费方来不及收就收到 `Lagged` 错误——而 `TuiEventStream::poll_draw_event` 把 `Lagged` 也映射成一次 `TuiEvent::Draw`（event_stream.rs:242-244），因为"画一次"是幂等的，丢几个 draw 通知无所谓。这是典型的"状态同步优于事件同步"：绘制请求不带数据，只表示"状态可能变了，有空来画"。

事件流侧还有一个细节值得看：`TuiEventStream` 手写了 `Stream::poll_next`，在 crossterm 事件与 draw 订阅之间做**轮询**：

```rust
// 来源：codex-rs/tui/src/tui/event_stream.rs:294-316（节选）
fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
    // approximate fairness + no starvation via round-robin.
    let draw_first = self.poll_draw_first;
    self.poll_draw_first = !self.poll_draw_first; // ← 每次翻转优先序

    if draw_first {
        if let Poll::Ready(event) = self.poll_draw_event(cx) { return Poll::Ready(event); }
        if let Poll::Ready(event) = self.poll_crossterm_event(cx) { return Poll::Ready(event); }
    } else {
        if let Poll::Ready(event) = self.poll_crossterm_event(cx) { return Poll::Ready(event); }
        if let Poll::Ready(event) = self.poll_draw_event(cx) { return Poll::Ready(event); }
    }
    Poll::Pending
}
```

为什么需要这个翻转？因为 `poll_next` 手写时如果永远先查 draw，那么"模型狂喷增量 → 源源不断的 Draw"会饿死键盘分支——`tokio::select!` 默认随机选分支，但手写的嵌套 if-else 是固定顺序的，必须用轮询补偿公平性。

### 4.4 键盘输入路径：从回车键到 `turn/start` 或 `turn/steer`

现在跟一遍"用户敲完提示词按回车"的完整链路。

**第一站：输入仲裁。** `ChatWidget::handle_key_event`（chatwidget/interaction.rs:11 起）的第一条规则是：bottom pane 有活动弹窗（审批、选择列表等）时，按键先给弹窗；弹窗不消费才轮到 composer 和全局快捷键。这个"谁先看到键"的顺序是有明文文档的（bottom_pane/mod.rs:7-12）：bottom pane 决定本地路由（弹窗 vs composer），`ChatWidget` 决定进程级意图（Ctrl+C 是打断还是退出二连击）。

**第二站：composer 状态机。** `ChatComposer` 是一个 1.2 万行的状态机（chat_composer.rs），其模块文档（:1-80）本身就是一篇状态机说明：回车是提交还是换行、斜杠命令何时固化为原子元素、粘贴爆发（paste burst）如何检测。提交的结果是 `InputResult`：

```rust
// 来源：codex-rs/tui/src/bottom_pane/chat_composer.rs:344-354（节选）
pub enum InputResult {
    Submitted {
        text: String,
        text_elements: Vec<TextElement>, // ← @提及/图片占位符的范围映射
    },
    Queued {
        text: String,
        text_elements: Vec<TextElement>,
        action: QueuedInputAction,        // ← 回合进行中 Tab 入队而非提交
        pending_pastes: Vec<(String, String)>,
    },
    // ...
}
```

**第三站：构造指令 + 乐观渲染。** `ChatWidget` 把文本、当前审批策略、模型、effort 等快照打包成 `AppCommand::UserTurn`：

```rust
// 来源：codex-rs/tui/src/chatwidget/input_submission.rs:339-374（节选）
let op = AppCommand::user_turn(
    items,
    self.config.cwd.to_path_buf(),
    AskForApproval::from(self.config.permissions.approval_policy.value()),
    active_permission_profile,
    effective_mode.model().to_string(),
    effective_mode.reasoning_effort(),
    /*summary*/ None,
    service_tier,
    /*final_output_json_schema*/ None,
    collaboration_mode,
    personality,
);
// ...
// App-event submissions are handled serially, and turn/start can wait on remote work.
// Queue the optimistic prompt first so the user's input is visible while that happens.
if render_before_submit {
    self.on_user_message_display(user_message_display_for_history(/* ... */));
    // ← 先把用户消息画进历史区，再发请求（乐观渲染）
}
if !self.submit_op(op.clone()) {
    return (false, None);
}
```

`submit_op`（chatwidget.rs:1797-1831）在生产路径上走 `CodexOpTarget::AppEvent`，即把指令包成 `AppEvent::CodexOp` 投进总线（另有一条 `Direct` 通道留给测试）。指令随后被主循环分支 1 取出，经 `submit_thread_op`（thread_routing.rs:435-469）进入决策点：

**第四站：steer 还是 start？** `try_submit_active_thread_op_via_app_server`（thread_routing.rs:573 起）对 `UserTurn` 的处理是一个小状态机：

```rust
// 来源：codex-rs/tui/src/app/thread_routing.rs:664-673（节选）
let mut should_start_turn = true;
if let Some(turn_id) = self.active_turn_id_for_thread(thread_id).await {
    // ← 主线还有进行中的回合（active_turn_id 由 TurnStarted/Completed 通知维护）
    let mut steer_turn_id = turn_id;
    let mut retried_after_turn_mismatch = false;
    loop {
        match app_server
            .turn_steer(thread_id, steer_turn_id.clone(), items.to_vec())
            .await
        {
            Ok(_) => return Ok(true), // ← steer 成功：输入插入进行中的回合
            // ... Err 分支处理三种竞态：不可 steer / 无活动回合 / turn id 过期（重试一次）
        }
    }
}
if should_start_turn {
    let response = app_server.turn_start(thread_id, items.to_vec(), /* ... */).await
    // ← 无活动回合：正常开新回合
}
```

这段代码把"steer"（回合进行中插入输入）的分布式竞态处理得很诚实：TUI 缓存的 `active_turn_id` 可能过期——服务端返回 "expected active turn id `X` but found `Y`" 时，TUI 用服务端报的 id 重同步并重试一次（thread_routing.rs:694-711）。`turn_start`/`turn_steer` 本体只是 typed JSON-RPC 封装（app_server_session.rs:1041-1089 与 :1117-1137），app-server 收到后落到内核，新回合的输入最终成为内核的 `Op::TurnInput`（[第 6 章](ch06-core-session.md)）。

### 4.5 事件回流：从内核到屏幕的路由

反方向——模型输出了增量、工具开始执行——走主循环分支 4 进来。`handle_app_server_event`（app_server_events.rs:54-83）先把 `Lagged`/`Disconnected` 这类传输层信号消化掉，然后对 `ServerNotification` 做**按主线分拣**：

```rust
// 来源：codex-rs/tui/src/app/app_server_events.rs:228-267（删节）
match server_notification_thread_target(&notification) {
    ServerNotificationThreadTarget::Thread(thread_id) => {
        // ... 若干"这条通知该不该收"的过滤（未知主线、孤儿子代理等）
        let result = if self.primary_thread_id == Some(thread_id)
            || self.primary_thread_id.is_none()
        {
            self.enqueue_primary_thread_notification(notification).await // ← 主主线
        } else {
            self.enqueue_thread_notification(thread_id, notification).await // ← 子代理/side
        };
        // ...
        return;
    }
    // ... InvalidThreadId / AppScoped / Global
}
self.chat_widget.handle_server_notification(notification, /*replay_kind*/ None);
// ← 全局通知（如账号变更）直接进 ChatWidget
```

被分拣进某条主线的通知，先写入该主线的 `ThreadEventStore`（重放日志），若该主线正显示在前台，再经 per-thread channel 送到 `active_thread_rx`——也就是主循环分支 2——最终由 `handle_active_thread_event`（thread_routing.rs:1742 起）转交 `ChatWidget::handle_server_notification`。后者是事件进入 UI 的总闸门（chatwidget/protocol.rs:4-100）：

```rust
// 来源：codex-rs/tui/src/chatwidget/protocol.rs:62-99（节选）
match notification {
    ServerNotification::TurnStarted(notification) => {
        self.turn_lifecycle.last_turn_id = Some(notification.turn.id);
        if !matches!(replay_kind, Some(ReplayKind::ResumeInitialMessages)) {
            self.on_task_started(); // ← 转圈状态、状态栏
        }
    }
    ServerNotification::TurnCompleted(notification) => {
        self.handle_turn_completed_notification(notification, replay_kind);
    }
    ServerNotification::ItemStarted(notification) => { /* 工具调用等条目开始 */ }
    ServerNotification::ItemCompleted(notification) => { /* 条目定稿，进历史区 */ }
    ServerNotification::AgentMessageDelta(notification) => {
        self.on_agent_message_delta(notification.delta); // ← 流式增量，4.6 节
    }
    ServerNotification::PlanDelta(notification) => self.on_plan_delta(notification.delta),
    ServerNotification::ReasoningSummaryTextDelta(notification) => {
        self.on_agent_reasoning_delta(notification.delta);
    }
    ServerNotification::CommandExecutionOutputDelta(notification) => {
        self.on_exec_command_output_delta(&notification.item_id, &notification.delta);
    }
    // ...
}
```

回看[第 5 章](ch05-protocol.md)的 `EventMsg` 家族，这里没有一个变体直接叫 `AgentMessageContentDelta`——TUI 看到的是 app-server 翻译后的 `item/agentMessage/delta`（app-server-protocol/src/protocol/common.rs:1862）。翻译发生在 app-server 的 bespoke 事件处理层（[第 15 章](ch15-app-server.md)展开）。

为什么还需要 per-thread 缓冲（4.3 节之外的第二套缓冲）？因为用户可以在子代理之间切换前台，非前台主线的事件不能丢、也不能直接画到屏幕上，于是进 `ThreadEventStore` 存着，切换时按序重放（`replay_kind` 参数就是给重放事件打标，避免重复触发"任务开始"动画）。缓冲是有界的（容量 32768，app.rs:259），而流式增量是最容易撑爆缓冲的类别，`thread_event_buffer.rs` 专门给 delta 做了**合并**：

```rust
// 来源：codex-rs/tui/src/app/thread_event_buffer.rs:8-34（节选）
const MAX_COALESCED_AGENT_MESSAGE_DELTA_BYTES: usize = 4 * 1024;   // ← 单条合并上限
const MAX_BUFFERED_AGENT_MESSAGE_DELTA_BYTES: usize = 256 * 1024;  // ← 全线缓冲上限

pub(super) fn push_replay_notification(&mut self, notification: Cow<'_, ServerNotification>) {
    // ...
    if let ServerNotification::AgentMessageDelta(delta) = notification.as_ref()
        && let Some(ThreadBufferedEvent::Notification(previous)) = self.buffer.back_mut()
        && let ServerNotification::AgentMessageDelta(previous) = previous.as_mut()
        && previous.thread_id == delta.thread_id
        && previous.turn_id == delta.turn_id
        && previous.item_id == delta.item_id
        && previous.delta.len().saturating_add(delta.delta.len())
            <= MAX_COALESCED_AGENT_MESSAGE_DELTA_BYTES
    {
        previous.delta.push_str(&delta.delta); // ← 相邻同条目 delta 直接拼进缓冲尾
        // ...
        return;
    }
    self.push_buffered_event(ThreadBufferedEvent::Notification(Box::new(notification.into_owned())));
}
```

同一条目、同回合、相邻到达的增量在缓冲尾部就地拼接，一条"通知"最多攒 4KB；整个缓冲的 delta 总量封顶 256KB，超出按 FIFO 驱逐。

### 4.6 流式增量渲染：`StreamController` 与 CommitTick 动画

`AgentMessageDelta` 到达 `on_agent_message_delta` 后，并不直接往屏幕上贴字符——贴的是一个"还没画完的字幕队列"。这条链路分三层：

**第一层：追加与提交边界。** `StreamController::push` → `StreamCore::push_delta`（streaming/controller.rs:134-158）只在 delta 含换行时把"已完整"的部分提交去渲染：

```rust
// 来源：codex-rs/tui/src/streaming/controller.rs:127-156（节选注释保留）
/// Push a streaming delta and enqueue any newly-stable rendered lines.
///
/// Only newline-terminated source is committed for rendering. This is
/// important for tables because an unterminated partial row must stay out
/// of both the stable queue and the live tail until its structure is
/// unambiguous; otherwise the user can briefly see malformed columns that
/// immediately disappear on the next delta.
fn push_delta(&mut self, delta: &str) -> bool {
    self.state.collector.push_delta(delta);
    let mut enqueued = false;
    if delta.contains('\n')
        && let Some(range) = self.state.collector.commit_complete_source()
    {
        // ← 只对"换行结尾的完整前缀"做增量 markdown 渲染并入队
        self.render.append(source, committed_source, self.width, /* ... */);
        enqueued = self.sync_stable_queue();
    }
    enqueued
}
```

未换行的尾巴保持"活尾"状态，因为半个 markdown 表格行渲染出来是一闪而过的坏帧。这是"增量渲染"最反直觉的一点：**正确性靠克制——不画比乱画好**。

**第二层：动画节拍。** 有新行入队后，ChatWidget 发 `AppEvent::StartCommitAnimation`；App 侧（app/event_dispatch.rs:581-602）起一个**普通线程**按固定节拍打拍子：

```rust
// 来源：codex-rs/tui/src/app/event_dispatch.rs:581-602（节选）
AppEvent::StartCommitAnimation => {
    if self
        .commit_anim_running
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_ok()                                  // ← 已在跑就不重复起线程
    {
        let tx = self.app_event_tx.clone();
        let running = self.commit_anim_running.clone();
        thread::spawn(move || {
            while running.load(Ordering::Relaxed) {
                thread::sleep(COMMIT_ANIMATION_TICK); // ← = TARGET_FRAME_INTERVAL，8.3ms
                tx.send(AppEvent::CommitTick);
            }
        });
    }
}
AppEvent::StopCommitAnimation => { self.commit_anim_running.store(false, Ordering::Release); }
AppEvent::CommitTick => { self.chat_widget.on_commit_tick(); } // ← 每拍从队列放出若干行
```

注意这个节拍是 **wall-clock 的**，与模型吐出 delta 的节奏解耦：模型快，队列积压，每拍多放几行（catch-up）；模型慢，每拍一行。你看到的"打字机匀速输出"其实是这个限速器制造的幻觉——顺便也充当了反压：渲染节奏不再取决于网络抖动的节奏。

**第三层：定稿。** 条目完成（`ItemCompleted`）时，`finalize` 用**全量原始 markdown** 重渲染一遍（controller.rs:160-178 的注释明说这是故意的："re-renders from the full raw source instead of trying to stitch together queued stable lines and the current tail"），保证进历史区的最终单元格是规范形态，流式过程只是它的近似。

### 4.7 审批弹窗：UI 侧的完整闭环

[第 11 章](ch11-sandbox-approval.md)讲了内核侧：拦截点在 handler 内的 `ToolOrchestrator`，审批时 `Session::request_approval` 挂起一个 oneshot 并发事件。本章补上 UI 侧——内核的 oneshot 跨过 app-server 后如何变成一个会"挡住键盘"的弹窗，决定又如何回到内核。

**入站：`ServerRequest` 到达。** 主循环分支 4 收到 `AppServerEvent::ServerRequest`，`PendingAppServerRequests::note_server_request`（app/app_server_requests.rs:97-199）先记账——以 `(thread_id, approval_id)` 为键登记 JSON-RPC `request_id`，这一步把"UI 层的审批对象"和"RPC 层的请求句柄"关联起来：

```rust
// 来源：codex-rs/tui/src/app/app_server_requests.rs:102-111（节选）
ServerRequest::CommandExecutionRequestApproval { request_id, params } => {
    let approval_id = params
        .approval_id
        .clone()
        .unwrap_or_else(|| params.item_id.clone()); // ← approval_id 缺省回退 item_id
    self.exec_approvals.insert(
        (Self::canonical_thread_id(&params.thread_id), approval_id),
        request_id.clone(),
    );
    None
}
```

同一模块还明确拒绝了 TUI 尚不支持的请求类型（`DynamicToolCall`、`ApplyPatchApproval` 等，:165-197），走"干净拒绝"通道——挂起的 RPC 不能被遗忘，要么响应要么报错，否则内核会永远等下去。

**弹窗接管输入。** `interactive_request_for_thread_request`（thread_routing.rs:206-247）把 RPC 参数翻译成 UI 层的 `ApprovalRequest::Exec`（拆命令、组装可选决定），经 `push_thread_interactive_request`（:338-359）交给 `ChatWidget::push_approval_request`，bottom pane 弹出 `ApprovalOverlay`：

```rust
// 来源：codex-rs/tui/src/bottom_pane/approval_overlay.rs:171-182（节选）
pub(crate) struct ApprovalOverlay {
    current_request: Option<ApprovalRequest>,
    queue: Vec<ApprovalRequest>,        // ← 多个审批排队，一次只显示一个
    app_event_tx: AppEventSender,
    list: ListSelectionView,            // ← 选项列表（Approve / Always / Cancel …）
    options: Vec<ApprovalOption>,
    current_complete: bool,
    done: bool,
    // ...
}
```

从这一刻起，4.4 节讲过的输入仲裁生效了：bottom pane 有活动 view，`ChatWidget::handle_key_event` 会把按键先交给 overlay（interaction.rs:11-37），composer 收不到字符。**UI 并未"阻塞"——键盘事件照常到达主循环，只是路由变了**；真正被阻塞的是内核侧的 oneshot，它悬在 app-server 的 JSON-RPC `ServerRequest` 上等响应。

**决定回传。** 用户选中选项，`apply_selection` → `handle_exec_decision`（approval_overlay.rs:353-390）做两件事：往历史区插一格"谁批准了什么命令"的决策单元格，再发审批指令：

```rust
// 来源：codex-rs/tui/src/bottom_pane/approval_overlay.rs:385-389
self.app_event_tx.send(AppEvent::InsertHistoryCell(cell)); // ← 决策留痕
let thread_id = request.thread_id();
self.app_event_tx
    .exec_approval(thread_id, id.to_string(), decision);   // ← AppEvent::SubmitThreadOp
```

指令经 `submit_thread_op` 到达 `try_resolve_app_server_request`（thread_routing.rs:872-905），它调 `take_resolution` 用 `(thread_id, approval_id)` 换出当初登记的 `request_id`，序列化出 `CommandExecutionRequestApprovalResponse { decision }`（app_server_requests.rs:201-228），最后 `resolve_server_request` 把它作为该 JSON-RPC 请求的响应发回。app-server 内的等待方拿到响应，内核的审批 oneshot 解开，`ToolOrchestrator` 继续走沙箱执行。整条闭环：

```
内核 ToolOrchestrator         app-server                 TUI
─────────────────────────────────────────────────────────────────
Session::request_approval
  ├─ oneshot 挂起
  └─ 审批事件 ──► bespoke 事件处理 ─► ServerRequest::  ─► note_server_request
       （第 11 章）           CommandExecution-        记账 (thread,id)→req_id
                              RequestApproval               │
                                                            ▼
                              ◄─ JSON-RPC response ── ApprovalOverlay
                                （decision）            用户按键选择
                                                            │
                                                            ▼
  oneshot 解开 ◄─ ReviewDecision ◄─ take_resolution ◄─ AppCommand::ExecApproval
  ToolOrchestrator 继续
```

MCP 工具的审批走另一条路：内核侧是 `handle_mcp_tool_call` 与 elicitation 通道（不经 `ToolOrchestrator`，见[第 11 章](ch11-sandbox-approval.md)与[第 12 章](ch12-mcp.md)），在 TUI 侧对应 `ServerRequest::McpServerElicitationRequest` → `McpServerElicitationOverlay`（thread_routing.rs:267-313）——同一个"ServerRequest 挂起等 UI 响应"的模式，只是换了一种弹窗。

## 设计取舍

**为什么 TUI 也要走 app-server，而不是直接持有一个 `CodexThread` 句柄？** 历史上 TUI 确实直连内核（`submit_op` 里那条 `CodexOpTarget::Direct` 通道就是遗留形态，如今只用于测试）。改成进程内 app-server 客户端后，TUI 被迫遵守与 IDE 扩展完全相同的协议纪律——事件模型、审批往返、多主线路由只有一份实现，远程 workspace（`AppServerTarget::Remote`，lib.rs:275-304）几乎免费获得：同一个 `AppServerSession`，换一条传输层就能驱动另一台机器上的会话。代价也真实存在：类型要翻译两遍（`EventMsg`→`ServerNotification`→UI 状态；`AppCommand`→`ClientRequest`→`Op`），每次协议演进要动三层，JSON 序列化在进程内场景纯属开销。

对比你的 my-agent：TypeScript 里最常见的形态是 UI 组件直接 `await agent.run()`、靠回调或 EventEmitter 更新界面。单前端时这没有问题——问题是第二个前端（VS Code 插件、CI 无头模式）出现时，你要一次性补回所有解耦：事件协议、生命周期、审批往返。Codex 的做法是把这笔债**提前还清**，而且让自家 TUI 也吃这份狗粮，协议有没有缺陷 TUI 第一个疼。如果你预判 my-agent 只会有一个前端，直连更简单；只要"可能有第二个消费者"，消息协议版的前期成本几乎总是值的。

**为什么是单 `select!` 循环 + channel 边界，而不是每事件 spawn 任务？** 因为 UI 状态机天然讨厌并发：审批弹窗弹到一半来了个 Resize，历史区正在流式提交时用户切了主线——如果每个事件一个任务，这些交错全是数据竞争。串行循环让所有状态变更按到达顺序逐个应用，推理成本极低；并发被推挤到 channel 之外（app-server  worker、帧调度器、动画线程、文件搜索），它们只通过消息与主循环交谈。这在 TS 世界有精确的对应物：Redux 的单 store + action 队列，或浏览器主线程的 event loop——**UI 单线程串行化不是 Rust 的被迫，是交互系统的普适解**。my-agent 里你大概已经用 EventEmitter 顺序分发做到了这一点，差别只是 Rust 用 channel 把边界类型化了。

**为什么重绘要"合并 + 限速"，而不是有事件就画？** 终端写入是进程里最慢的系统调用之一，且 ratatui 的 diff 渲染成本随帧数线性增长。120 FPS 上限（frame_rate_limiter.rs:13）+ `broadcast(1)` 的"丢帧无害"语义 + FrameScheduler 的截止合并，本质是把绘制从"事件驱动"降级为"状态轮询"：事件只负责改状态，绘制按节拍来。这在游戏引擎里是常识（render loop 与 logic loop 解耦），在 TUI 里同样成立。反面代价：低频事件（比如一次性通知）也要等下一拍才可见——但对人眼而言 8ms 不可感知。

**输入仲裁为什么用显式弹窗栈，而不是"禁用 composer"？** 终端没有 DOM，没有事件冒泡，没有 `stopPropagation`——键盘事件的归属必须由代码手工仲裁。bottom_pane 的弹窗栈（`ApprovalOverlay`、选择列表等实现 `BottomPaneView`）就是这套手工仲裁的数据结构：栈顶 view 先消费，消费不了往下传。浏览器开发者初看会觉得笨拙，但它换来了完全显式的路由规则（mod.rs 开头那段注释就是规则书），不会出现"某个全局快捷键神秘失灵"这类 DOM 事件代理的经典 bug。

**坦诚的局限。** 其一，`AppEvent` 通道是无界的（app/startup.rs:115），长时间堵死主循环理论上会积压内存——团队的选择是优先保证不丢事件、不死锁（app-server-client 里那段无界队列注释是同一哲学的传输层版本），靠事件量天然有界来兜底。其二，`App` 与 `ChatWidget` 仍然是巨型结构体（字段上百个），仓库自己的 AGENTS.md 都明令"避免再给 chatwidget.rs 加独立方法、新功能开新模块"——本章展示的 `chatwidget/`、`app/` 子目录拆分正是这条规则的外科手术成果，属于"承认熵增、局部隔离"而非根治。其三，流式渲染的"只提交换行结尾前缀"策略意味着纯单行的超长输出（无换行的巨型 JSON 行）要等定稿才可见——这是正确性与实时性之间的有意识偏斜。

## 动手实验

**1. 定位主循环与事件类型（只读命令，秒级返回）：**

```shell
cd codex-rs
rg -n "enum TuiEvent" tui/src/tui.rs
# 预期输出：tui.rs:560:pub enum TuiEvent {（±几行）

rg -n "let control = select!" tui/src/app/startup.rs
# 预期输出：startup.rs:675 附近，四个 select! 分支紧随其后
```

**2. 观察启动时序日志。** TUI 启动后在 tracing 里打了一条分段计时（app/startup.rs:612-620）：

```shell
RUST_LOG=codex_tui=info cargo run --bin codex 2>/tmp/codex-tui.log
# 启动后立即退出（Esc Esc 或 Ctrl+C），然后：
grep "tui startup initial frame scheduled" /tmp/codex-tui.log
# 预期输出形态：一行含 duration_ms / bootstrap_ms / thread_and_widget_ms /
# initial_session_ms / event_stream_ms 的 INFO 日志，
# 数值大小直观告诉你启动耗时分摊在哪几个阶段
```

**3. 录一份 UI 事件回放带。** TUI 内置高保真会话录制（session_log.rs:84-101）：

```shell
CODEX_TUI_RECORD_SESSION=1 cargo run --bin codex
# 随便发一条消息、触发一次审批后退出
ls ~/.codex/log/session-*.jsonl
# 预期输出：形如 session-20260822T052200Z.jsonl 的文件，
# 每行一个 JSON：{"ts": ..., "dir": "in"/"out"/"meta", "kind": ...}
# 用 `jq -r .kind` 能看到 AppEvent 与 outbound op 的交错序列
```

**4. 追踪一条 delta 的旅程。** 不改代码也能看到三段关键路径：

```shell
rg -n "on_agent_message_delta" tui/src/chatwidget/streaming.rs tui/src/chatwidget/protocol.rs
# 预期输出：protocol.rs 的分发点（:79 附近）与 streaming.rs 的入口（:141 附近）

rg -n "MAX_COALESCED_AGENT_MESSAGE_DELTA_BYTES" tui/src/app/thread_event_buffer.rs
# 预期输出：:9 的常量定义与若干使用点——缓冲合并策略的全部参数
```

**5. 观察帧率上限。** `FrameRequester` 注释里写着 120 FPS，验证它：

```shell
rg -n "MIN_FRAME_INTERVAL" tui/src/tui/frame_rate_limiter.rs
# 预期输出：:13 定义 8_333_334 纳秒；:23 附近的 clamp_deadline 是限速落点
```

如果改了相关代码想验证 UI，本 crate 的快照测试是 `just test -p codex-tui` + `cargo insta review`（详见[第 17 章](ch17-engineering.md)的测试策略一节）。

## Rust 侧栏

- **`tokio::select!` 与 guard**：`select!` 同时等待多个 future，任一就绪即执行对应分支并取消其余。分支可带 `, if 条件 =>` 前置条件，条件不满足的分支本轮不参与等待——4.2 节用它实现"AppEvent 未排空时暂停消费主线事件"。被"取消"的分支只是 drop 掉 future，`mpsc::recv()` 这类操作取消安全（不丢消息）。
- **channel 三兄弟的语义差**：`mpsc::channel(n)` 有界，写满时发送方挂起（背压）；`mpsc::unbounded_channel` 无界，永不阻塞发送方（本进程内的事件总线/录制队列）；`tokio::sync::broadcast` 多订阅者、定长环形缓冲，消费慢会收到 `RecvError::Lagged` 被告知"你丢了 N 条"——4.3 节的 draw 通道利用的正是"丢帧无害"。
- **`thread::spawn` + `Arc<AtomicBool>`**：CommitTick 动画用的是**操作系统线程**而非 tokio 任务，因为它只做 `sleep` + 发消息，不进 `.await` 点；停止信号用 `AtomicBool` 配合 `compare_exchange`（CAS：只有当前值确实是 `false` 才置 `true` 并返回成功），保证重复收到 `StartCommitAnimation` 也不会起两个线程。
- **手写 `impl Stream`**：`Stream` trait 的核心是 `poll_next(&mut self, cx) -> Poll<Option<Item>>`——就绪返回 `Poll::Ready(Some(x))`，没货返回 `Poll::Pending` 并登记 waker 等唤醒。`TuiEventStream` 手写它是为了在两个子流之间做轮询（4.3 节），这是异步 Rust 里"组合器不够用就自己写poll"的典型场景。
- **`Box<dyn HistoryCell>`**：历史区的每一格（命令输出、审批决策、模型消息）是不同的具体类型，统一塞进 `Vec<Box<dyn HistoryCell>>`。`dyn` trait 对象抹掉具体类型、走虚表调用 `render`——用一次间接跳转换"异构列表"，对应 TS 里"一组实现同一接口的对象"。
- **`Cow<'_, T>`**：thread_events.rs 里 `push_notification_inner(Cow<'_, ServerNotification>)` 允许调用方传引用（ borrowed ）或所有权（ owned ），只在确实要入缓冲时才 `into_owned()` 克隆——避免热路径上的无条件 `clone()`。

## 小结 + 思考题

本章把 TUI 拆成了五块拼图：进程内 app-server 客户端（TUI 只是协议的一个渲染端）、单 `select!` 四路复用主循环（串行化一切 UI 状态变更）、合并+限速的重绘调度（绘制与事件解耦）、"先弹窗后 composer"的手工输入仲裁（审批弹窗的本质是按键路由变更 + 远端 oneshot 挂起）、以及"换行才提交、按拍放出、定稿重渲染"的三段式流式管线。回头看第 1 章那张全景图，TUI 这一格现在已经没有黑盒了。

思考题：

1. `submit_user_message` 为什么先把用户消息画进历史区、再发 `turn/start`（input_submission.rs:360-374 的注释）？如果请求最终失败，这个"乐观渲染"该怎么收场？去 `chatwidget/` 里找失败路径验证你的猜想。
2. 审批弹窗激活期间用户按了 `!ls` 想跑本地命令，这个按键会走到哪里、被谁拦下？沿着 interaction.rs → bottom_pane 的路由规则推一遍。
3. `TuiEventStream::poll_next` 的轮询翻转（event_stream.rs:296-297）如果被删掉，构造一个"键盘输入被饿死"的场景：需要哪些事件源以什么速率到达？
4. 如果让你给 my-agent 加一个"回合进行中插入输入"（steer）能力，参考 thread_routing.rs:664-728 的三种竞态处理，你的 TS 实现需要缓存什么状态、处理哪几种服务端错误？
