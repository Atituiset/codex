# 第 16 章 exec 无头模式与 CI 集成

## 本章导读

前十五章里，Codex 的默认画面是一个坐在终端前的人：TUI 弹审批框，人按 y/n，流式文本逐字滚屏。本章把这个人拿走——GitHub Actions 的 runner、定时任务、Docker 容器里，没有 TTY，没有人可以回答「是否允许执行 `rm -rf target`」，甚至 stdout 的另一端不是眼睛而是 `jq`。这就是 `codex exec` 要回答的问题：**在没有终端、没有人的环境里，Agent 怎么跑？**

这个问题拆开来是三个子问题。第一，**输出给谁看**：同一次运行，人类要可读的进度日志，机器要可解析的结构化事件——exec 的答案是「一份事件流、两种渲染器」，stdout 与 stderr 有严格分工。第二，**安全策略怎么定**：TUI 里审批靠人兜底，无头环境里「问人」这个选项不存在，exec 的选择是默认收紧——审批策略直接改成 `Never`，所有审批请求一律拒绝。第三，**结果怎么消费**：shell 脚本靠 exit code 判断成败，CI 靠 JSONL 事件流做断言，exec 为这两者分别设计了语义。

如果你用 TypeScript 写过 my-agent，大概率做过类似的事：给 CLI 加个 `--json` flag，把 `console.log` 换成 `JSON.stringify`。本章会让你看到生产级实现比这一步多考虑了什么——为什么 JSONL 事件不直接序列化内部事件类型、为什么 exit code 要用一个标志位攒到最后、为什么最终消息去不去 stdout 要看 TTY 状态。

## 源码地图

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-rs/exec/src/main.rs` | `codex-exec` 二进制入口 | arg0 分发还兼职 `codex-linux-sandbox`（第 11 章） |
| `codex-rs/exec/src/cli.rs` | exec 的 clap 参数定义 | `--json`/`-o`/`--output-schema` 与 resume/fork/review 子命令 |
| `codex-rs/exec/src/lib.rs` | `run_main`：配置、建会话、事件循环 | 本章主战场，约 2100 行 |
| `codex-rs/exec/src/exec_events.rs` | JSONL 输出的自定义事件词汇 | `thread.started`/`turn.completed` 点分契约 |
| `codex-rs/exec/src/event_processor.rs` | `EventProcessor` trait | 双输出渲染器的统一抽象，仅 48 行 |
| `codex-rs/exec/src/event_processor_with_human_output.rs` | 人类可读渲染器 | 全部走 stderr，最终消息按 TTY 决定去留 |
| `codex-rs/exec/src/event_processor_with_jsonl_output.rs` | JSONL 渲染器 | 把 app-server 通知映射成 exec 自定义事件 |
| `codex-rs/app-server-client/src/lib.rs` | `InProcessAppServerClient` | exec 与内核之间的进程内 JSON-RPC 桥 |
| `codex-rs/cli/src/main.rs` | `codex exec` 子命令分发 | 见[第 2 章](ch02-startup.md) |
| `docs/exec.md` | 用户文档 | 只有三行，指向官方 noninteractive 文档 |

一个容易误判的点先说清：**exec 并不直连 `codex-core`**。它和 TUI 一样，通过进程内 app-server（`InProcessAppServerClient`）与内核会话——exec 消费的是 app-server v2 协议的 `ServerNotification`，而不是内核裸的 `EventMsg`。这个事实是理解全章的钥匙。

## 核心数据结构

### `ThreadEvent`：exec 自己的 JSONL 词汇

`--json` 模式下 stdout 每一行是一个 `ThreadEvent`。注意它**不是** `EventMsg` 的序列化，也不是 app-server 通知的透传，而是 exec crate 自定义的一套点分命名契约（exec_events.rs:9-37）：

```rust
// 来源：codex-rs/exec/src/exec_events.rs:9-37
/// Top-level JSONL events emitted by codex exec
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "type")]
pub enum ThreadEvent {
    /// Emitted when a new thread is started as the first event.
    #[serde(rename = "thread.started")]
    ThreadStarted(ThreadStartedEvent),
    /// Emitted when a turn is started by sending a new prompt to the model.
    #[serde(rename = "turn.started")]
    TurnStarted(TurnStartedEvent),
    /// Emitted when a turn is completed. Typically right after the assistant's response.
    #[serde(rename = "turn.completed")]
    TurnCompleted(TurnCompletedEvent),
    /// Indicates that a turn failed with an error.
    #[serde(rename = "turn.failed")]
    TurnFailed(TurnFailedEvent),
    /// Emitted when a new item is added to the thread...
    #[serde(rename = "item.started")]
    ItemStarted(ItemStartedEvent),
    #[serde(rename = "item.updated")]
    ItemUpdated(ItemUpdatedEvent),
    /// Signals that an item has reached a terminal state—either success or failure.
    #[serde(rename = "item.completed")]
    ItemCompleted(ItemCompletedEvent),
    /// Represents an unrecoverable error emitted directly by the event stream.
    #[serde(rename = "error")]
    Error(ThreadErrorEvent),
}
```

`#[serde(tag = "type")]` 让每个事件行自带判别字段，`jq 'select(.type=="turn.completed")'` 就能过滤。词汇表刻意很小：一条主线（thread）、若干回合（turn）、回合内若干条目（item），外加顶层错误。事件载荷里最值得一提的是条目类型——这里出现了全书第三个名叫 `ThreadItem` 的东西（exec_events.rs:96-133）：

```rust
// 来源：codex-rs/exec/src/exec_events.rs:96-133（节选）
/// Canonical representation of a thread item and its domain-specific payload.
pub struct ThreadItem {
    pub id: String,
    #[serde(flatten)]
    pub details: ThreadItemDetails,  // ← type 字段内联展开到本层
}

#[serde(tag = "type", rename_all = "snake_case")]
pub enum ThreadItemDetails {
    AgentMessage(AgentMessageItem),       // ← 模型回复文本
    Reasoning(ReasoningItem),             // ← 推理摘要
    CommandExecution(CommandExecutionItem), // ← shell 命令：命令串/聚合输出/exit code/状态
    FileChange(FileChangeItem),           // ← apply_patch 的文件变更集
    McpToolCall(McpToolCallItem),         // ← MCP 工具调用（第 12 章）
    CollabToolCall(CollabToolCallItem),   // ← 多 Agent 协作工具
    WebSearch(WebSearchItem),
    TodoList(TodoListItem),               // ← Agent 的计划清单
    Error(ErrorItem),                     // ← 非致命错误也落成条目
}
```

回忆一下命名分层：protocol crate 里的条目类型叫 `TurnItem`（第 5 章），app-server v2 对外的叫 `ThreadItem`（第 15 章），exec 这份 JSONL 契约又自定义了一个 `ThreadItem`。三者结构相似但各自独立演化——这正是「对外契约与内部模型解耦」的代价与收益，设计取舍一节会展开。

`turn.completed` 带 token 用量，`Usage` 的字段值得一看（exec_events.rs:60-73）：除了 `input_tokens`/`output_tokens`，还有 `cached_input_tokens` 与 `cache_write_input_tokens`——因为模型请求带 `store: false`、全量重发历史（第 4 章），prompt cache 命中率直接决定 CI 里每次跑 exec 的成本，这两个字段就是给成本核算留的。

### `EventProcessor` trait：双输出的抽象

人类可读与 JSONL 两种渲染共享一个窄接口（event_processor.rs:13-29）：

```rust
// 来源：codex-rs/exec/src/event_processor.rs:7-29
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexStatus {
    Running,
    InitiateShutdown,   // ← 渲染器通知主循环：回合终结，可以收尾了
}

pub(crate) trait EventProcessor {
    /// Print summary of effective configuration and user prompt.
    fn print_config_summary(
        &mut self,
        config: &Config,
        prompt: &str,
        session_configured: &SessionConfiguredEvent,
    );

    /// Handle a single typed app-server notification emitted by the agent.
    fn process_server_notification(&mut self, notification: ServerNotification) -> CodexStatus;

    /// Handle a local exec warning that is not represented as an app-server notification.
    fn process_warning(&mut self, message: String) -> CodexStatus;

    fn print_final_output(&mut self) {}  // ← 默认空实现，两个渲染器各自覆盖
}
```

注意输入类型：`process_server_notification` 收的是 `codex_app_server_protocol::ServerNotification`，不是 `EventMsg`。渲染器返回 `CodexStatus` 而不是直接退出——「何时结束」的决定权留在主循环，渲染器只建议。

## 流程走读

### 16.1 全景：从子命令到事件循环

```
codex exec [flags] "prompt"
   │
   ▼
cli/src/main.rs:1146-1161 ──► codex_exec::run_main()（exec/src/lib.rs:245）
   │
   ├─ 加载 config.toml + CLI 覆盖（第 3 章）
   ├─ approval_policy 强制覆盖为 Never（无头默认收紧）
   ▼
InProcessAppServerClient::start（进程内 app-server，session_source = Exec）
   │
   ├─ thread/start（或 thread/resume、thread/fork）
   ├─ turn/start（或 review/start）
   ▼
事件循环 tokio::select!（lib.rs:1035-1127）
   ├─ Ctrl-C ─────────────► turn/interrupt
   ├─ ServerRequest ──────► 审批类一律拒绝；elicitation 自动 Cancel
   └─ ServerNotification ─► EventProcessor（按 --json 二选一）
         ├─ human：全程 eprintln 到 stderr，最终消息按 TTY 决定去 stdout
         └─ jsonl：映射成 ThreadEvent，println! 一行一个 JSON
   ▼
turn/completed → thread/unsubscribe → shutdown
   │
   ▼
error_seen ? exit(1) : exit(0)
```

`codex exec` 的分发在[第 2 章](ch02-startup.md)已经走过：`Subcommand::Exec` 臂合并 root 级共享选项后调用 `codex_exec::run_main`（cli/src/main.rs:1146-1161）。顺带一提，顶层 `codex review` 也复用同一条 `run_main` 路径（cli/src/main.rs:1162-1181），只是把子命令换成 `Review`——代码评审这个 CI 高频场景因此白得了 exec 的全部输出契约。

### 16.2 审批默认值：无头环境的安全收紧

`run_main` 构造 `ConfigOverrides` 时写死了无头模式最重要的一个默认（lib.rs:406-434）：

```rust
// 来源：codex-rs/exec/src/lib.rs:406-434（节选）
let overrides = ConfigOverrides {
    model,
    review_model: None,
    // Default to never ask for approvals in headless mode. Rebuild below if
    // the fully resolved reviewer is AutoReview.
    approval_policy: Some(AskForApproval::Never),  // ← 没人可问，所以默认不问
    approvals_reviewer: None,
    sandbox_mode,     // ← 仅来自 -s/--sandbox 或 --yolo，否则沿用配置默认
    // ...
};
```

对比 TUI：交互模式默认 `AskForApproval::OnRequest`——默认不问、靠沙箱兜底，沙箱兜不住或模型主动请求时才弹审批框等人裁决（第 11 章）。exec 把默认改成 `Never`——**不是「自动批准」，而是「永不询问」**：策略引擎（execpolicy）放行的命令在沙箱里直接跑，需要审批的命令直接失败。沙箱这边 exec 不设自己的默认值，沿用配置默认 `read-only`（`SandboxMode` 的 serde 默认值，protocol/src/config_types.rs:104-114）；要放宽必须显式 `-s workspace-write` 或 `--dangerously-bypass-approvals-and-sandbox`（别名 `--yolo`，utils/cli/src/shared_options.rs:52-59），后者会连 git 仓库检查一起跳过（lib.rs:797-805）。

还有一个弹性细节：`--approve-for-me`（shared_options.rs:43-50）会把审批路由给「自动评审」机制，此时 `approval_policy` 需要回到 `on-request` 才能工作。`build_exec_config`（lib.rs:582-615）处理的就是这个矛盾：先用 `Never` 构建一次，如果发现解析出的 reviewer 是 `AutoReview`，就清掉头显式覆盖再构建一次，让配置里的审批策略生效。

### 16.3 建会话：exec 也走 app-server

第 1 章说过「TUI、exec、app-server 都只是消息协议的不同渲染端」。到本基线，这句话变得更彻底：**exec 连「直连内核」的特权都没有了**，它和 TUI 一样通过进程内 app-server 建会话（lib.rs:539-559）：

```rust
// 来源：codex-rs/exec/src/lib.rs:539-559（节选）
let in_process_start_args = InProcessClientStartArgs {
    arg0_paths,
    config: std::sync::Arc::new(config.clone()),
    cli_overrides: run_cli_overrides,
    // ...
    session_source: SessionSource::Exec,   // ← 内核据此知道驱动者是 exec
    client_name: "codex_exec".to_string(),
    experimental_api: true,
    channel_capacity: DEFAULT_IN_PROCESS_CHANNEL_CAPACITY,
    // ...
};
```

随后 `InProcessAppServerClient::start`（lib.rs:807-812）在同一个进程里拉起 app-server 运行时。这个客户端的文档注释把设计意图写得很直白（app-server-client/src/lib.rs:289-299）：它「刻意保留 server 的 request/notification/event 模型，而不暴露 core 的直接句柄」，让进程内调用方与 app-server 行为对齐，同时省去进程边界。传输层换成了 tokio mpsc channel，协议一字未改。

建会话参数与 TUI 同构，包括[第 13 章](ch13-persistence.md)讲过的 paginated 历史模式（lib.rs:1168-1191）：

```rust
// 来源：codex-rs/exec/src/lib.rs:1176-1190（节选）
ThreadStartParams {
    model: config.model.clone(),
    // ...
    approval_policy: Some(config.permissions.approval_policy.value().into()),
    ephemeral: Some(config.ephemeral),
    history_mode: (!config.ephemeral).then_some(ThreadHistoryMode::Paginated), // ← 与 TUI 一致
    thread_source: Some(ThreadSource::User),
    ..ThreadStartParams::default()
}
```

注意 `--ephemeral`（cli.rs:30-32，不落盘会话文件）会关掉 paginated 模式——没有 rollout 文件就无所谓分页历史。`start_thread` 里还有一段兼容逻辑（lib.rs:1140-1166）：如果 server 报「paginated threads require thread/turns/list support」就降级重试，这是为远端/异构 exec-server 组合留的退路。

`SessionConfiguredEvent` 不再等事件流，而是直接从 `thread/start`（或 resume/fork）的响应里重建（lib.rs:1280-1392），注释说明原因：等流式 `SessionConfigured` 事件会给进程内路径带来最多 10 秒无谓的启动延迟（lib.rs:923-926）。

### 16.4 prompt 输入：stdin 与管道的三种行为

无头模式的输入侧同样有 CI 考量：prompt 不一定来自命令行参数。exec 用三态枚举区分 stdin 的角色（lib.rs:181-191）：

```rust
// 来源：codex-rs/exec/src/lib.rs:181-191
enum StdinPromptBehavior {
    /// Read stdin only when there is no positional prompt, which is the legacy
    /// `codex exec` behavior for `codex exec` with piped input.
    RequiredIfPiped,
    /// Always treat stdin as the prompt, used for the explicit `codex exec -`
    /// sentinel and similar forced-stdin call sites.
    Forced,
    /// If stdin is piped alongside a positional prompt, treat stdin as
    /// additional context to append rather than as the primary prompt.
    OptionalAppend,
}
```

三条规则对应三类 CI 用法（解析入口 `resolve_root_prompt`/`resolve_prompt`，lib.rs:2085-2113）：`codex exec "fix this"` 无管道时最普通；`git diff | codex exec "review this"` 时 stdin 不覆盖位置参数，而是被包成一个上下文块追加进去（`prompt_with_stdin_context`，lib.rs:2076-2083）——prompt 变成 `"review this\n\n<stdin>\n<diff 内容>\n</stdin>"`，「指令 + 被操作内容」各就各位；`codex exec - < prompt.txt` 则强制从 stdin 读全文。读入的字节还要过一道编码检查 `decode_prompt_bytes`（lib.rs:1982-2010）：剥 UTF-8 BOM、识别 UTF-16/UTF-32 并给出「用 iconv 转 UTF-8」的 actionable 报错——管道输入来自别的工具，编码假设不能像 TTY 输入那样偷懒。

### 16.5 发起回合与事件循环

回合发起是一次普通的 app-server 请求（lib.rs:962-1000）：`turn/start` 带上用户输入、`approval_policy`、以及可选的 `output_schema`（`--output-schema`，JSON Schema 约束最终回复的结构，CI 里想让模型输出严格 JSON 时用这个）。返回值里的 `turn.id` 就是后续过滤事件的锚点——turn id 即 submission id，和第 6 章的约定一致。

事件循环是本章的中枢（lib.rs:1035-1127），骨架如下：

```rust
// 来源：codex-rs/exec/src/lib.rs:1035-1060（节选）
loop {
    let server_event = tokio::select! {
        maybe_interrupt = interrupt_rx.recv(), if interrupt_channel_open => {
            // Ctrl-C：发 turn/interrupt 后继续循环
            if let Err(err) = send_request_with_response::<TurnInterruptResponse>(
                &client,
                ClientRequest::TurnInterrupt { /* thread_id, turn_id */ },
                "turn/interrupt",
            ).await { warn!("turn/interrupt failed: {err}"); }
            continue;
        }
        maybe_event = client.next_event() => maybe_event,
    };
    let Some(server_event) = server_event else { break };  // ← 事件流关闭，退出循环
    // ...
}
```

`tokio::select!` 同时等两支：Ctrl-C 信号（lib.rs:942-948 里一个独立 task 监听 `ctrl_c()` 并往 channel 里丢消息）和服务端事件。CI 里 `timeout` 命令发 SIGINT 时，exec 有机会礼貌地中断回合而不是被直接杀死。

收到 `ServerNotification` 后做两层过滤。第一层是**错误记账**（lib.rs:1072-1089）：`Error` 通知（`will_retry == false`）或 `TurnCompleted` 状态为 `Failed`/`Interrupted` 时置 `error_seen = true`——这个标志位就是 exit code 语义的全部来源。第二层是**归属过滤** `should_process_notification`（lib.rs:1398-1456）：逐变体比对 `thread_id`/`turn_id`，只有属于本主线本回合的通知才进渲染器。为什么需要过滤？因为内核可能同时存在子 Agent 主线（collab 工具会 spawn 别的 thread），它们的事件也在同一条流上。

过滤之后还有一个补救动作 `maybe_backfill_turn_completed_items`（lib.rs:1458-1499），它自己的注释解释了存在理由：进程内传输在背压下可能丢弃非终结的 item 通知，但保证 `turn/completed` 必达；而 app-server 发出的完成通知里 `turn.items` 是空的。所以 exec 在收到完成通知时补发一次 `thread/read`，把最终条目捞回来，渲染器才能拿到最后那条 agent message。这是一个「传输层有损、控制面兜底」的典型补丁。

### 16.6 ServerRequest：所有「问人」通道的统一应答

app-server 协议里 server 可以反向请求 client（第 15 章），其中大量是「问人」类请求。exec 的应答策略整齐划一（lib.rs:1787-1928）：

```rust
// 来源：codex-rs/exec/src/lib.rs:1793-1822（节选）
let handle_result = match request {
    ServerRequest::McpServerElicitationRequest { request_id, .. } => {
        // Exec auto-cancels elicitation instead of surfacing it
        // interactively.
        match canceled_mcp_server_elicitation_response() {   // ← action: Cancel
            Ok(value) => resolve_server_request(
                &client, request_id, value, "mcpServer/elicitation/request",
            ).await,
            Err(err) => Err(err),
        }
    }
    ServerRequest::CommandExecutionRequestApproval { request_id, params } => {
        reject_server_request(
            &client, request_id, &method,
            format!(
                "command execution approval is not supported in exec mode for thread `{}`",
                params.thread_id
            ),
        ).await
    }
    // FileChangeRequestApproval / ToolRequestUserInput / DynamicToolCall /
    // ApplyPatchApproval / ExecCommandApproval / PermissionsRequestApproval ……一律 reject
```

两类处理值得区分。MCP elicitation（MCP server 向用户索要输入，第 12 章）走 **resolve + Cancel**——这是一个合法的协议响应，server 端会把它当成用户取消而不是错误；而所有审批类请求直接 **reject** 报错。正常情况下 `approval_policy: Never` 意味着内核根本不会发审批请求，这些 reject 是纵深防御：子 Agent 主线、策略不一致等边角情况漏过来的请求，在这里被统一摁死，绝不让进程挂在一个永远等不到回答的通道上。

### 16.7 双输出渲染器：一份通知，两种投影

渲染器选择在回合开始前完成（lib.rs:677-684）：

```rust
// 来源：codex-rs/exec/src/lib.rs:677-684
let mut event_processor: Box<dyn EventProcessor> = match json_mode {
    true => Box::new(EventProcessorWithJsonOutput::new(last_message_file.clone())),
    _ => Box::new(EventProcessorWithHumanOutput::create_with_ansi(
        stderr_with_ansi,
        &config,
        last_message_file.clone(),
    )),
};
```

两个渲染器遵守的铁律写在 crate 文档注释里（lib.rs:1-5）：

```rust
// 来源：codex-rs/exec/src/lib.rs:1-5
// - In the default output mode, it is paramount that the only thing written to
//   stdout is the final message (if any).
// - In --json mode, stdout must be valid JSONL, one event per line.
// For both modes, any other output must be written to stderr.
#![deny(clippy::print_stdout)]
```

`#![deny(clippy::print_stdout)]` 把「stdout 纪律」升级成编译错误：整个 crate 里想 `println!` 必须显式 `#[allow]`，全文件只有 JSONL 渲染器的 `emit` 和人类渲染器的最终消息两处拿到豁免。

**人类渲染器**的一切输出都走 `eprintln!`（stderr）：开头的配置摘要（workdir/model/approval/sandbox/session id，event_processor_with_human_output.rs:210-224）、命令执行状态、推理摘要、token 统计。唯独最终消息有 TTY 判断（event_processor_with_human_output.rs:507-513）：

```rust
// 来源：codex-rs/exec/src/event_processor_with_human_output.rs:507-513
fn should_print_final_message_to_stdout(
    final_message: Option<&str>,
    stdout_is_terminal: bool,
    stderr_is_terminal: bool,
) -> bool {
    final_message.is_some() && !(stdout_is_terminal && stderr_is_terminal)
}
```

逻辑是：交互终端里（stdout、stderr 都是 TTY），最终消息在流式过程中已经渲染过了，不再重复；一旦 stdout 被管道接走（CI 场景），就把最终消息干净地写到 stdout——`codex exec "..." | pbcopy`、`RESULT=$(codex exec ...)` 这类用法拿到的是纯结果，进度日志仍在 stderr 不污染管道。

**JSONL 渲染器**则是一次协议翻译。核心映射 `map_item_with_id`（event_processor_with_jsonl_output.rs:142-313）把 app-server v2 的 `ThreadItem` 逐变体翻译成 exec 自己的 `ThreadItemDetails`——字段裁剪、状态枚举重命名（如 `PatchApplyStatus::Declined` 折叠进 `Failed`），这是刻意维护的「对外契约窄于内部模型」。整条管线：

```
core 内部 EventMsg
   │ app-server 转换（第 15 章 bespoke_event_handling.rs）
   ▼
ServerNotification（app-server-protocol v2，camelCase）
   │ EventProcessorWithJsonOutput::collect_thread_events（逐变体映射）
   ▼
ThreadEvent（exec 点分词汇，详情 snake_case）
   │ serde_json::to_string → println!（一行一个）
   ▼
stdout JSONL
```

item id 也要重排：内核给的原始 id 不适合对外，渲染器维护 `raw_to_exec_item_id` 映射表，发出的是 `item_0`、`item_1` 这样的自增 id（event_processor_with_jsonl_output.rs:99-101, 315-329），保证 `item.started` 与 `item.completed` 能用同一 id 配对。映射过程被刻意做成可单测的纯函数风格：`collect_thread_events` 返回 `CollectedThreadEvents { events, status }`（event_processor_with_jsonl_output.rs:75-79），`EventProcessor` 实现只负责 `emit`——单测不用碰 stdout（event_processor_with_jsonl_output_tests.rs 就是这么测的）。

JSONL 模式下的「配置摘要」退化为第一行的 `thread.started`（event_processor_with_jsonl_output.rs:593-601）：

```rust
// 来源：codex-rs/exec/src/event_processor_with_jsonl_output.rs:593-601
impl EventProcessor for EventProcessorWithJsonOutput {
    fn print_config_summary(
        &mut self,
        _: &Config,
        _: &str,
        session_configured: &SessionConfiguredEvent,
    ) {
        self.emit(Self::thread_started_event(session_configured));  // ← 第一行永远是 thread.started
    }
    // ...
}
```

`thread_id` 就在这一行里——CI 脚本可以从首行抓 id，之后用 `codex exec resume <id>` 接续（见 16.9）。

### 16.8 exit code：一个标志位的语义

exec 的 exit code 只有两档：0 与 1，全部决策集中在主循环末尾（lib.rs:1129-1137）：

```rust
// 来源：codex-rs/exec/src/lib.rs:1129-1137
if let Err(err) = client.shutdown().await {
    warn!("in-process app-server shutdown failed: {err}");
}
event_processor.print_final_output();
if error_seen {
    std::process::exit(1);   // ← 回合失败/被打断/不可重试错误
}

Ok(())
```

`error_seen` 在事件循环里被三处置位：不可重试的 `Error` 通知、`TurnCompleted` 状态为 `Failed` 或 `Interrupted`、以及拒绝 ServerRequest 失败（lib.rs:1924-1927）。此外配置加载失败、不在 git 仓库且未加 `--skip-git-repo-check` 等启动期错误直接 `std::process::exit(1)`（如 lib.rs:799-805）。

这个设计的要点在于**错误不在中途退出**。模型流中断、工具失败这类错误发生时，事件流继续走完——JSONL 消费者还能收到 `turn.failed` 和完整的错误条目，人类能看到 stderr 上的错误渲染——直到收尾阶段才用 exit code 汇报。exit code 是给 `set -e` 的，事件流是给日志的，两者各管一段。

### 16.9 resume 与 fork：CI 里的多步编排

exec 的 resume 是子命令形态（cli.rs:143-153）：`codex exec resume [SESSION_ID] [PROMPT]`、`codex exec resume --last [PROMPT]`、`codex exec fork <SESSION_ID> [PROMPT]`。有个 clap 层面的小机关：`--last` 后面的位置参数实际是 prompt 而不是 session id，clap 表达不了这种条件位置参数，于是定义了 `ResumeArgsRaw` 再手工转换（cli.rs:227-244）。

session id 的解析在 `resolve_resume_thread_id`（lib.rs:1570-1706），优先级链条是：

1. **UUID 直通**：能 parse 成 UUID 就直接用；
2. **`--last`**：走 app-server 的 `thread/list`（按 `UpdatedAt` 倒序、每页 100），先查 state_db 投影，miss 了再扫 rollout 文件修复（与[第 13 章](ch13-persistence.md)的「投影可落后」对账逻辑呼应）；默认按当前目录过滤，`--all` 关闭过滤——CI 里每个 job 的工作目录不同，这个过滤正好让 `--last` 捞到的是「本仓库的最近一次」；
3. **按名字查**：state_db 精确标题匹配 → 全局搜索兜底。

找到后通过 `thread/resume` 恢复，`exclude_turns: true`（lib.rs:1216）表示不把历史回合的条目拉进响应——exec 不需要展示旧对话，只要内核把历史装进上下文。这与模型请求「全量重发历史、`prompt_cache_key = session_id`」的事实（第 4 章）叠加起来，意味着 resume 后的第一个请求就能命中上次回合写下的 prompt cache——CI 里分步跑 exec 的成本因此远低于想象。

## 设计取舍

**为什么 JSONL 不直接序列化 `EventMsg`？** 这是全章最值得借鉴的决策。直接序列化内部事件类型几乎零成本（`EventMsg` 本来就 derive 了 `Serialize`），早期版本大概也是这么想的——`--json` 至今仍保留 `experimental-json` 别名（cli.rs:54-58），是那段历史的化石。但内部事件类型随内核演进天天在变，一旦外部脚本依赖了它，内核重构就会打破别人的 CI。exec 的答案是三层各自独立：内核 `EventMsg` → app-server `ServerNotification` → exec `ThreadEvent`，每一层都是一次显式的、有单测覆盖的映射。点分命名（`thread.started`/`item.completed`）、`item_N` 自增 id、`Usage` 成本字段，都是只为外部消费者设计的稳定面。对比 my-agent 的常见做法：TS 里 `console.log(JSON.stringify(internalEvent))` 一行搞定，爽的是今天，痛的是第一次重构 loop 时所有下游脚本集体暴毙。如果你要给 my-agent 加机器可读输出，抄这份作业的要点是：**定义一个只属于输出的类型，再写一个显式映射函数**——TypeScript 里就是一个 `type ExecEvent = ...` 加一个 `toExecEvent(e: InternalEvent): ExecEvent | null`，几十行代码换来重构自由。

**为什么 exec 也要绕一层 app-server？** 直觉上无头模式直连内核最省事，早期 exec 也确实是独立驱动内核的。本基线把它收编到 `InProcessAppServerClient` 之下，收益是行为对齐：thread/resume/fork、turn 生命周期、通知过滤语义，exec 与 IDE 扩展走同一条代码路径，bug 只修一遍；代价是多一层协议翻译（比如 16.5 的 backfill 补丁就是为了补这层的传输损耗）。对 my-agent 的启示反过来了：你的 Agent 如果只有一个 CLI 前端，过早引入这层是过度设计；但一旦你打算做 IDE 扩展或 HTTP 服务，先把协议层立起来、让 CLI 也消费它，比事后给两个前端对齐行为便宜得多。

**为什么默认 `Never` 而不是「自动批准全部」？** 无头环境问不了人，两条路：全部放行（`--yolo`）或默认收紧。exec 选了后者，放行成为显式 opt-in。这和沙箱默认 `read-only` 是一套组合拳：CI 里最常见的用法（跑测试、读代码、生成报告）不需要写权限，需要写权限的场景（自动修代码）由运维者显式放宽并配合外部隔离（容器、一次性 VM）。「默认安全、显式放宽」在无人环境比交互环境更重要，因为没有人能在出事前按 Ctrl-C。

**坦诚说局限。** 其一，JSONL 是**有损投影**：流式增量（`AgentMessageContentDelta` 那一层）被折叠成完成时的整条消息，`item.updated` 目前只服务 todo 列表，想做「实时显示 AI 正在打字」的 CI 日志做不到。其二，exit code 只有 0/1 两档，`turn.failed`（模型侧错误）与「不在 git 仓库」（用法错误）不可区分，重试策略只能自己解析 JSONL 里的错误条目。其三，16.5 的 backfill 说明进程内传输在背压下会丢非终结通知——对 JSONL 消费者意味着不能假设每个 `item.started` 都有配对的完成事件，健壮的消费端要自己 reconcile。

## 动手实验

> 以下命令需要已登录（第 4 章）。沙箱环境 `CODEX_SANDBOX_NETWORK_DISABLED=1` 下模型请求会失败——正好可以顺便观察 `turn.failed` 与 exit code 1 的形态。

最基本的一次运行，观察 stdout/stderr 分工：

```shell
cargo run --bin codex -- exec "say hi" > /tmp/out.txt 2> /tmp/err.txt
echo "exit=$?"
# 预期：/tmp/err.txt 是配置摘要（OpenAI Codex v…/workdir/model/approval: never/sandbox: read-only）
#      加执行过程日志与 tokens used 统计
#      /tmp/out.txt 只有最终回复一行（因为 stdout 被重定向，不是 TTY）
```

JSONL 模式，观察事件序列：

```shell
cargo run --bin codex -- exec --json "what is 2+2" | tee events.jsonl | head -3
# 预期首行：{"type":"thread.started","thread_id":"..."}
# 随后 turn.started → item.completed(agent_message) → turn.completed(带 usage)
```

用 `jq` 模拟 CI 消费者的两个典型断言：

```shell
# 只取最终回复文本
jq -r 'select(.type=="item.completed" and .item.type=="agent_message") | .item.text' events.jsonl

# 取 token 用量做成本记录（注意 cached_input_tokens，prompt cache 命中量）
jq 'select(.type=="turn.completed") | .usage' events.jsonl
```

验证 exit code 语义——跑完上面的命令后 `echo $?`，成功为 0；把网络断掉（或给个无效 prompt 触发错误）再跑，`turn.failed` 出现在 JSONL 里且 `$?` 为 1。

resume 接续：

```shell
THREAD_ID=$(jq -r 'select(.type=="thread.started") | .thread_id' events.jsonl | head -1)
cargo run --bin codex -- exec resume "$THREAD_ID" "and what is that plus 10"
# 预期：第二 run 的 stderr 摘要里 session id 与第一次相同；模型知道 "that" 指的是 4
```

机器可消费产物的另外两个开关：

```shell
# -o：最终消息落文件，供下游步骤读取
cargo run --bin codex -- exec -o /tmp/last.md "summarize this repo in one sentence"
cat /tmp/last.md

# --output-schema：用 JSON Schema 约束最终回复结构（配合 --json 食用）
echo '{"type":"object","properties":{"answer":{"type":"number"}},"required":["answer"]}' > /tmp/schema.json
cargo run --bin codex -- exec --json --output-schema /tmp/schema.json "what is 2+2" \
  | jq 'select(.type=="item.completed" and .item.type=="agent_message")'
# 预期：agent_message 的 text 是符合 schema 的 JSON 字符串
```

想看 exec 与 TUI 共用 app-server 路径的证据：

```shell
rg -n "InProcessAppServerClient::start" codex-rs/exec/src/lib.rs codex-rs/tui/src/lib.rs
rg -n "session_source" codex-rs/exec/src/lib.rs
# 预期：exec 命中 lib.rs:808 附近与 :551 的 SessionSource::Exec
```

## Rust 侧栏

- **`#[serde(tag = "type")]` 内标签枚举**：`ThreadEvent`/`ThreadItemDetails` 的序列化形态由这个属性决定——判别字段 `type` 内联进 JSON 对象而不是包一层 `{"ThreadStarted": {...}}`。这是「Rust 类型即 JSON 契约」的关键语法，配合 `#[serde(rename = "thread.started")]` 得到点分命名。
- **trait object（`Box<dyn EventProcessor>`）**：`--json` 与否是运行期决定，所以用动态分发的 trait 对象装两种渲染器。泛型静态分发在这里也能写（整个主循环泛型化），但会传染所有调用方签名——`Box<dyn>` 是「只此一处多态」时的务实选择。
- **`tokio::select!`**：lib.rs:1036 同时等待 Ctrl-C channel 与事件流，任一分支就绪即执行，`if interrupt_channel_open` 守卫让 channel 关闭后该分支自动退出轮询。等价于 TS 的 `Promise.race`，但每轮循环都会重新 race 一次。
- **`std::process::exit(1)` 不跑析构**：它立即终止进程，局部变量的 `Drop` 不执行。exec 在调用前显式 `client.shutdown().await` 并 `print_final_output()`（lib.rs:1129-1134），就是知道这个函数之后没有任何清理机会。
- **`impl Deref` 的 CLI 结构体**：exec 的 `Cli` 通过 `Deref<Target = SharedCliOptions>`（cli.rs:78-84）直接透出共享字段，调用方写 `cli.model` 而不必 `cli.shared.0.model`。这是 clap 参数复用的惯用法，代价是字段来源不明显——读代码时找不到的字段去 `Deref` 目标里找。

## 小结 + 思考题

本章把无头模式拆成了三个答案：输出上，一份 app-server 通知流经 `EventProcessor` 抽象投影成人类日志（stderr）与机器 JSONL（stdout 的 `thread.started`/`item.completed`/`turn.completed` 点分契约），stdout 纪律用 `#![deny(clippy::print_stdout)]` 钉死；安全上，审批默认 `Never`、沙箱沿用 `read-only`、所有「问人」通道统一拒绝或取消，放宽必须显式；结果消费上，exit code 用 `error_seen` 攒到收尾统一汇报，`--output-last-message` 与 `--output-schema` 给下游结构化产物。架构上的大事实则是：exec 已不再直连内核，它与 TUI、IDE 一样是 app-server 协议的一个客户端——「多形态外壳」在第 1 章是比喻，到这里成了字面事实。

思考题：

1. `turn.completed` 的 `usage` 来自 `ThreadTokenUsageUpdated` 通知的最后一份快照（event_processor_with_jsonl_output.rs:117-128, 497-500）。如果回合中途流断了重试过一次，这个「最后快照」还准确吗？回到[第 7 章](ch07-agent-loop.md)的 token 统计逻辑验证你的判断。
2. 16.5 的 backfill 补丁说明 `item.*` 事件可能缺失。如果你是 JSONL 消费者，怎样设计解析逻辑才能容忍「有 `item.started` 没有 `item.completed`」？（提示：`turn.completed` 时渲染器自己已经做了一次 reconcile，见 `reconcile_unfinished_started_items`。）
3. 如果让你给 my-agent 设计 `--json` 输出，你会选择 exec 这种「独立契约 + 显式映射」，还是 Claude Code 式的「每种消息一行透传」？各自在「内核重构」与「消费者想拿增量文本」两个场景下的代价是什么？
4. exec 把审批请求 reject 当成「不应发生」的防御，而 MCP elicitation 却要认真回一个 `Cancel`。为什么不统一 reject？（提示：reject 在 JSON-RPC 里是错误响应，Cancel 是合法结果——想想 MCP server 拿到错误会怎么上报这次工具调用。）
