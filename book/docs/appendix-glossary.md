# 附录 A 术语表

本表汇总全书（前言 + 第 1–17 章）实际使用的术语译法，基于 openai/codex 基线 commit
`4f39251a01` 的源码与各章成文口径整理。第 14–17 章（TUI、app-server、exec、工程实践）
的新词已补录进相应分类表格。

使用约定：

- **类型名、函数名、crate 名一律保留英文**并用反引号包裹（如 `CodexThread`、`run_turn()`），
  本表不为它们编造中文译名，只记录各章为它们配备的中文「解说词」。
- 「首次出现章节」指该译法在成文章节中第一次出现的位置；许多术语在后面的章节才有
  完整展开，备注里会指明「详见」哪一章。章节链接使用 `SUMMARY.md` 中的文件名。
- 「不翻译」的词条（rollout、steer、profile 等）在正文中直接以英文出现。

## 核心概念

| 中文译法 | 英文原文 | 首次出现章节 | 备注 |
|----------|----------|--------------|------|
| 回合 | turn | [第 1 章](ch01-overview.md) | turn id = 受理该回合的 submission id（[第 6 章](ch06-core-session.md)）；回合内事件经 `Event.id` 归因 |
| 主线 / 会话主线 | thread | [前言](intro.md) | 原 conversation；`CodexThread`/`ThreadId` 保留英文。章节内首次实质使用在[第 7 章](ch07-agent-loop.md)（子主线）与[第 12 章](ch12-mcp.md)（每条会话主线）。注意第 1 章的「主线」多为叙事比喻（「全书的主线索」），不是本术语 |
| 会话 | session | [第 1 章](ch01-overview.md) | `Session` 是运行时对象；与「主线」常互换，但持久化身份（thread_id、rollout 文件）属于主线（[第 6 章](ch06-core-session.md)/[第 13 章](ch13-persistence.md)） |
| Agent Loop | agent loop | [第 1 章](ch01-overview.md) | 不翻译；在源码中的落点是 `run_turn()`（[第 7 章](ch07-agent-loop.md)，全书重心） |
| 采样请求 | sampling request | [第 7 章](ch07-agent-loop.md) | 一次模型调用；对应 `run_sampling_request()` / `try_run_sampling_request()`。一个回合含多次采样请求，每次都全量重发历史 |
| steer | steer | [第 6 章](ch06-core-session.md) | 不翻译；回合进行中插入输入（插队）。`Steered` 变体名首见于[第 5 章](ch05-protocol.md)的 `TurnInputSubmission`，机制讲解在第 6 章，生效点在[第 7 章](ch07-agent-loop.md)外层循环开头 |
| 事件 | event | [第 1 章](ch01-overview.md) | `Event`/`EventMsg`；内核 → 外界的单向广播 |
| 条目 | item | [第 4 章](ch04-auth-model.md) | `ResponseItem`/`TurnItem`/`ThreadItem` 中的 Item；双名问题见「类型与 crate 名」表 |
| 工具调用 | tool call | [第 1 章](ch01-overview.md) | 模型侧形态是 `function_call`/`custom_tool_call` 条目，执行侧形态是 `ToolCall`→`ToolInvocation`（[第 9 章](ch09-tools.md)） |
| 内核 / 外壳 | core / shell（比喻） | [第 1 章](ch01-overview.md) | 「外壳」自[第 5 章](ch05-protocol.md)起固定指 TUI/exec/IDE 等协议消费端；内核即 `codex-core` |
| 审批 | approval | [第 1 章](ch01-overview.md) | `AskForApproval`/`ReviewDecision`；详见[第 11 章](ch11-sandbox-approval.md) |
| 沙箱 | sandbox | [第 1 章](ch01-overview.md) | seatbelt/bubblewrap/seccomp 等机制名保留英文；详见[第 11 章](ch11-sandbox-approval.md) |
| 压缩 | compact / compaction | [第 1 章](ch01-overview.md) | 摘要压缩对话历史（[第 8 章](ch08-context-compact.md)）。注意[第 13 章](ch13-persistence.md)另有 rollout 冷数据的 zstd「压缩」（`.zst` sidecar），两义并存、语境可分 |
| 上下文窗口 | context window | [第 8 章](ch08-context-compact.md) | 第 4 章已出现 `ContextWindowExceeded` 错误分类；触顶触发压缩 |
| 历史 / 对话历史 | history | [第 4 章](ch04-auth-model.md) | 内存中是 `ContextManager` 持有的 `Vec<ResponseItemEnvelope>`（[第 8 章](ch08-context-compact.md)）；只增不改，压缩是唯一的「受控改写」 |
| 落史 | （本书造词，对应 record/record_items） | [第 7 章](ch07-agent-loop.md) | 把条目追加进对话历史并写 rollout；「立即落史」是历史一致性的关键纪律 |
| 全量重发 | full-history resend | [第 4 章](ch04-auth-model.md) | 请求带 `store: false`，每次采样请求重发完整历史；服务端不存会话状态 |
| 前缀缓存 | Prompt Caching | [第 4 章](ch04-auth-model.md) | `prompt_cache_key = session_id`；命中量经 `cached_input_tokens` 回传。「前缀缓存」词形首见于[第 7 章](ch07-agent-loop.md) |
| 提供方 | provider | [第 1 章](ch01-overview.md) | model provider；声明式配置 `ModelProviderInfo`（[第 4 章](ch04-auth-model.md)） |
| 取消令牌 | CancellationToken | [第 6 章](ch06-core-session.md) | 令牌树：session → task → 采样请求 → 单个工具（[第 7 章](ch07-agent-loop.md)） |
| 结构化输出 | structured output | [第 6 章](ch06-core-session.md) | `output_schema` / `final_output_json_schema` |
| 多智能体 | multi-agent | [第 6 章](ch06-core-session.md) | 子主线、mailbox、`InterAgentCommunication` |
| mailbox | mailbox | [第 6 章](ch06-core-session.md) | 不翻译；多智能体来信的暂存与投递（`MailboxDeliveryPhase`） |
| 无头模式 | headless mode | [第 1 章](ch01-overview.md) | `codex exec`；默认 `AskForApproval::Never`，详见[第 16 章](ch16-exec.md) |
| 工具清单 | tool list / model-visible specs | [第 9 章](ch09-tools.md) | 随每个 `StepContext` 重建，不是会话级常量 |
| 托管工具 | hosted tool | [第 9 章](ch09-tools.md) | 模型侧执行（web_search），本地无 handler、不进 registry，只作为 spec 发给模型 |
| 动态工具 | dynamic tool | [第 9 章](ch09-tools.md) | 客户端经 app-server 注入（`append_dynamic_tool_runtimes`） |
| 自由格式工具 | freeform tool | [第 9 章](ch09-tools.md) | `ToolSpec::Freeform`，载荷为原始文本（`ToolPayload::Custom`），如 apply_patch |
| 命名空间 | namespace | [第 9 章](ch09-tools.md) | `ToolName.namespace`，默认 `functions`；MCP 双轨命名见[第 12 章](ch12-mcp.md)。注意[第 5 章](ch05-protocol.md)另有「类型命名空间」的泛化用法 |
| 并行门闸 | （`RwLock` 并行准入） | [第 9 章](ch09-tools.md) | 概念与机制首见于[第 7 章](ch07-agent-loop.md)；`ToolExecutor::supports_parallel_tool_calls()` 声明可并行 |
| 注入片段 | contextual fragment | [第 8 章](ch08-context-compact.md) | `ContextualUserFragment`，约 40 种；`markers()` 起止标记保证可识别、可剥离 |
| 降级 | graceful degradation | [第 12 章](ch12-mcp.md) | MCP 服务器 required/optional 分级；可选服务器 1 秒宽限后本次绑定缺席 |
| 预热 | prewarm | [第 7 章](ch07-agent-loop.md) | `prewarmed_client_session` 只给任务的第一个 `run_turn`；MCP pre-warm worker 见[第 12 章](ch12-mcp.md) |
| 乐观渲染 | optimistic rendering | [第 14 章](ch14-tui.md) | 先把用户消息画进历史区、再发 `turn/start`；请求失败需另行收场 |
| 弹窗栈 | popup stack（bottom pane） | [第 14 章](ch14-tui.md) | 实现 `BottomPaneView` 的弹窗叠栈，栈顶先消费按键；终端没有事件冒泡，输入归属靠它手工仲裁 |
| side conversation | side conversation | [第 14 章](ch14-tui.md) | 不翻译；主线/子代理之外的旁路会话，事件经 per-thread 缓冲分拣 |
| JSON-RPC 资源模型 | resource model（thread / turn / item） | [第 15 章](ch15-app-server.md) | app-server v2 对外 API 形态；方法命名 `<resource>/<method>`、资源用单数 |
| 无头安全收紧 | headless lock-down | [第 16 章](ch16-exec.md) | exec 默认 `AskForApproval::Never` + 沙箱 `read-only`，放宽必须显式（`-s`/`--yolo`） |

## 类型与 crate 名译法

类型与 crate 名不翻译；本表记录全书统一使用的中文解说词，避免同一类型在不同章节
被叫成不同名字。

| 中文解说词 | 英文原文 | 首次出现章节 | 备注 |
|------------|----------|--------------|------|
| 操作 / 指令 | `Op` | [第 1 章](ch01-overview.md) | 外界 → 内核；本基线 28 个变体（[第 5 章](ch05-protocol.md)） |
| 事件（消息） | `EventMsg` | [第 1 章](ch01-overview.md) | 内核 → 外界；本基线 81 个变体 |
| 事件信封 | `Event` | [第 5 章](ch05-protocol.md) | `{ id, msg }`；`id` 把事件归因到 submission/turn |
| 响应条目 / 模型历史条目 | `ResponseItem` | [第 4 章](ch04-auth-model.md) | 与 Responses API wire format 同构（[第 5 章](ch05-protocol.md)）；历史、rollout、请求体共用一份数据 |
| 输入条目 | `ResponseInputItem` | [第 5 章](ch05-protocol.md) | 发送方向的新输入，变体少于 `ResponseItem` |
| 条目（回合条目 / 面向 UI 的条目视图） | `TurnItem` / `ThreadItem` | [第 5 章](ch05-protocol.md) | **双名问题**：protocol crate 内叫 `TurnItem`，app-server-protocol v2 对外 API 叫 `ThreadItem`，两者是同构投影，指同一层概念；对外形态详见[第 15 章](ch15-app-server.md) |
| 内容项 | `ContentItem` | [第 5 章](ch05-protocol.md) | `InputText`/`InputImage`/`OutputText` 等 |
| 用户输入（多模态片段） | `UserInput` | [第 5 章](ch05-protocol.md) | 一条用户消息 = `Vec<UserInput>` |
| 回合输入 | `TurnInput` / `Op::TurnInput` | [第 5 章](ch05-protocol.md) | 本基线没有 `Op::UserTurn`，用户输入走 `Op::TurnInput` |
| 回合上下文（不可变快照） | `TurnContext` | [第 6 章](ch06-core-session.md) | 设置变更只在回合边界生效 |
| 请求级快照 / step 级快照 | `StepContext` | [第 7 章](ch07-agent-loop.md) | 每次采样请求钉一份；工具清单、MCP 绑定、审批策略随它冻结 |
| 会话 / 通道端点 / 对外句柄 / 工厂 | `Session` / `SessionIo` / `CodexThread` / `ThreadManager` | [第 6 章](ch06-core-session.md) | 状态与通道分离；`CodexThread` 只转发不决策 |
| 会话任务 / 普通回合任务 | `SessionTask` / `RegularTask` | [第 6 章](ch06-core-session.md) | 回合作为后台 tokio 任务运行 |
| 「纸上世界」/「落地世界」 | `ConfigToml` / `Config` | [第 3 章](ch03-config.md) | 两级配置模型：全 `Option` 的反序列化层 vs 默认值落地的运行时层 |
| 层栈 | `ConfigLayerStack` | [第 3 章](ch03-config.md) | 见「其它」表「层 / 层栈」条 |
| 线上协议 | `WireApi` | [第 4 章](ch04-auth-model.md) | 本基线只剩 `Responses` 变体，`Chat` 已移除 |
| 提供方声明 | `ModelProviderInfo` | [第 4 章](ch04-auth-model.md) | 声明式配置；折叠为传输层 `Provider` |
| 凭据总管 | `AuthManager` | [第 4 章](ch04-auth-model.md) | 缓存、惰性刷新、401 恢复 |
| 一次模型调用的完整输入 | `Prompt` | [第 4 章](ch04-auth-model.md) | 采样请求的请求级输入（[第 7 章](ch07-agent-loop.md)视角） |
| 领域事件（模型流词汇表） | `ResponseEvent` | [第 4 章](ch04-auth-model.md) | SSE 解析层的第一层降噪产物 |
| 工具描述（对模型侧） | `ToolSpec` | [第 9 章](ch09-tools.md) | 序列化即 Responses API 合法 Tool JSON |
| 工具执行契约 / 执行器 | `ToolExecutor` | [第 9 章](ch09-tools.md) | `spec()` 与 `handle()` 同一对象，描述与执行不漂移 |
| 注册表 / 路由器 | `ToolRegistry` / `ToolRouter` | [第 9 章](ch09-tools.md) | 「薄 router，厚 registry」；hooks 在 registry 的 dispatch 主干织入 |
| 编排器 | `ToolOrchestrator` | [第 9 章](ch09-tools.md) | 审批 → 选沙箱 → 尝试 → 提权重试；拦截点在 handler 内部 |
| 工具运行时（并行门闸） | `ToolCallRuntime` | [第 7 章](ch07-agent-loop.md) | `parallel.rs`；`FuturesOrdered` 保序收割 |
| 工具名（带命名空间） | `ToolName` | [第 9 章](ch09-tools.md) | 默认命名空间 `functions` |
| 可见性 / 曝光 | `ToolExposure` | [第 9 章](ch09-tools.md) | Direct/Deferred/CodeModeOnly/Hidden；[第 12 章](ch12-mcp.md)用「曝光策略」词形 |
| 连接集合 / 绑定快照 / 准备好的调用 | `McpConnectionSet` / `McpBinding` / `PreparedMcpCall` | [第 12 章](ch12-mcp.md) | 活集合 + 不可变快照 + `catalog_revision` 校验 |
| 落盘条目 / rollout 行 | `RolloutItem` / `RolloutLine` | [第 13 章](ch13-persistence.md) | 九种变体；`#[serde(flatten)]` 摊平成行 |
| rollout 记录器 | `RolloutRecorder` | [第 13 章](ch13-persistence.md) | mpsc 命令队列 + 独占写盘任务 |
| 会话元数据（出生证明） | `SessionMeta` | [第 13 章](ch13-persistence.md) | rollout 文件头第一条 |
| 压缩检查点 | `CompactedItem` | [第 13 章](ch13-persistence.md) | `replacement_history` 是自包含完整新历史 |
| 审批策略 | `AskForApproval` | [第 3 章](ch03-config.md) | 配置字段首见于此；四档语义展开在[第 11 章](ch11-sandbox-approval.md) |
| 审批决定 | `ReviewDecision` | [第 5 章](ch05-protocol.md) | 用户的裁决结果；与 execpolicy 的 `Decision`（裁决）是两个类型，勿混 |
| 沙箱策略 / 沙箱类型 | `SandboxPolicy` / `SandboxType` | [第 5 章](ch05-protocol.md) / [第 11 章](ch11-sandbox-approval.md) | `LinuxSeccomp` 是活化石命名：文件系统隔离已是 bubblewrap |
| 提权意图（模型自报） | `SandboxPermissions` | [第 11 章](ch11-sandbox-approval.md) | UseDefault/RequireEscalated/WithAdditionalPermissions |
| 裁决 | `Decision` | [第 11 章](ch11-sandbox-approval.md) | `Allow < Prompt < Forbidden`，`max()` 取最严格 |
| 审批需求（三态） | `ExecApprovalRequirement` | [第 9 章](ch09-tools.md) | Skip/NeedsApproval/Forbidden |
| 功能开关 | `Feature` / `Features` / feature flag | [第 2 章](ch02-startup.md) | `--enable/--disable`；`FEATURES` 注册表是单一事实来源（[第 3 章](ch03-config.md)） |
| UI 内部总线 | `AppEvent` / `AppEventSender` | [第 14 章](ch14-tui.md) | 组件与顶层 `App` 之间的唯一语言；unbounded channel |
| TUI 侧指令 | `AppCommand` | [第 14 章](ch14-tui.md) | 「TUI 侧的 Op」；`AppCommand::UserTurn` 与内核 `Op::TurnInput` 是同义不同层的分层命名，勿混 |
| 终端事件 | `TuiEvent` | [第 14 章](ch14-tui.md) | 五变体（Key/Paste/Resize/Draw/Resume）；`Draw` 来自内部 broadcast 而非终端 |
| per-thread 事件缓冲 | `ThreadEventStore` / `ThreadBufferedEvent` | [第 14 章](ch14-tui.md) | 活动主线的事件泵 + 非活动主线的重放日志；delta 就地合并（单条 4KB / 全缓冲 256KB 上限） |
| 进程内 app-server 客户端 | `InProcessAppServerClient` | [第 15 章](ch15-app-server.md) | TUI 与 exec 都经它连内核；有界命令通道 + 无界本地事件队列防死锁 |
| 方法注册表 | `client_request_definitions!` 等宏注册表 | [第 15 章](ch15-app-server.md) | 单一来源同时生成 `ClientRequest`/`ClientResponse`、`method_name()` 与 experimental 门闸 |
| exec 事件词汇 | `ThreadEvent` / `ThreadItemDetails` | [第 16 章](ch16-exec.md) | exec 自定义点分契约（`thread.started`/`item.completed`），与 `EventMsg`、v2 `ThreadItem` 各自独立演化；见「事件词汇（点分命名）」条 |
| 双输出渲染器 | `EventProcessor` | [第 16 章](ch16-exec.md) | human（stderr）与 JSONL（stdout）双实现；`#![deny(clippy::print_stdout)]` 守 stdout 纪律 |
| 测试基建 | `TestCodexBuilder` / `test_codex()` | [第 17 章](ch17-engineering.md) | 「假模型 + 真内核」：wiremock 假 `/responses`，断言内核发出的请求体 |
| 门面 crate | `codex-core-api` | [第 17 章](ch17-engineering.md) | 只 `pub use` 不实现逻辑，给外壳一道窄 API 门 |

## 事件与协议词汇

| 中文译法 | 英文原文 | 首次出现章节 | 备注 |
|----------|----------|--------------|------|
| 事件流 / 事件总线 | event stream / SQ·EQ | [第 1 章](ch01-overview.md) | SQ（Submission Queue）走 `Op`，EQ（Event Queue）走 `Event`；命名见[第 5 章](ch05-protocol.md) |
| 提交 id | submission id | [第 5 章](ch05-protocol.md) | UUID7；受理回合后升格为 turn id（[第 6 章](ch06-core-session.md)） |
| 回执 | oneshot reply | [第 5 章](ch05-protocol.md) | `TurnInputSubmission`：Started/Steered/NotSubmitted |
| 流式增量 | delta | [第 4 章](ch04-auth-model.md) | `*Delta` 事件族；瞬态、不落 rollout（[第 13 章](ch13-persistence.md)） |
| 打字机效果 | typewriter effect | [第 4 章](ch04-auth-model.md) | UI 逐字渲染靠 `*Delta` 同流并发 |
| 流式文本增量事件 | `AgentMessageContentDelta` | [第 1 章](ch01-overview.md) | 助手文本增量的对外事件形态 |
| 审批请求事件 | `ExecApprovalRequest` | [第 1 章](ch01-overview.md) | 与 `Op::ExecApproval` 构成一次跨枚举往返（[第 5 章](ch05-protocol.md)） |
| 回合开始 / 完成 / 中止事件 | `TurnStarted` / `TurnComplete` / `TurnAborted` | [第 5 章](ch05-protocol.md) | 线上兼容 v1 名 `task_started`/`task_complete`（serde alias） |
| 条目生命周期事件 | `ItemStarted` / `ItemCompleted` | [第 5 章](ch05-protocol.md) | 载荷是 `TurnItem`；粗粒度条目流正在收编细粒度事件 |
| token 统计 / 回合 diff 事件 | `TokenCount` / `TurnDiff` | [第 7 章](ch07-agent-loop.md) | `TokenCount` 故意等工具收割完才发 |
| MCP 启动事件 | `McpStartupUpdate` / `McpStartupComplete` | [第 12 章](ch12-mcp.md) | app-server 转成 `McpServerStatusUpdated` 通知推给客户端 |
| 事件词汇（点分命名） | dotted event vocabulary | [第 5 章](ch05-protocol.md) | exec `--json` 的 `thread.started`/`turn.completed`/`item.completed`，定义在 `exec/src/exec_events.rs`，**不是** `EventMsg` 的直接序列化；详见[第 16 章](ch16-exec.md) |
| 线上格式 | wire format | [第 5 章](ch05-protocol.md) | 不翻译；`ResponseItem` 与 Responses API 保持同构 |
| 哑协议 | dumb pipe | [第 5 章](ch05-protocol.md) | protocol crate「几乎不含逻辑」的纪律 |
| 回译 | legacy back-translation | [第 5 章](ch05-protocol.md) | `HasLegacyEvent`：新条目事件回译成旧事件流喂兼容消费者 |
| elicitation（反向提问） | elicitation | [第 12 章](ch12-mcp.md) | 不翻译；MCP 服务器执行中反向向用户提问，审批策略 `Never` 时自动拒绝。字段名首见于[第 6 章](ch06-core-session.md)（`OutOfBandElicitations`） |
| 通知 | notification | [第 12 章](ch12-mcp.md) | app-server 侧 JSON-RPC notification；详见[第 15 章](ch15-app-server.md) |
| 透传/回传 加密条目 | `encrypted_content` | [第 5 章](ch05-protocol.md) | 思维链与压缩摘要对客户端不透明，原样回传 API |
| 反向请求 | `ServerRequest` | [第 14 章](ch14-tui.md) | 服务端→客户端带 id 的 JSON-RPC 请求，挂起等响应；审批、elicitation、动态工具调用都走它（机制展开在[第 15 章](ch15-app-server.md) 4.6 节） |
| CommitTick 动画 | `AppEvent::StartCommitAnimation` / `CommitTick` | [第 14 章](ch14-tui.md) | 普通线程按 8.3ms 节拍打拍子，每拍从流式队列放出若干行；「打字机匀速输出」的限速器，与模型吐字节奏解耦 |
| 流式增量通知 | `item/agentMessage/delta` | [第 14 章](ch14-tui.md) | 内核 `EventMsg::AgentMessageContentDelta` 经 app-server 翻译后的对外形态（`ServerNotification::AgentMessageDelta`）；与内核名分层共存，勿误改 |
| experimental 门闸 | experimental gate | [第 15 章](ch15-app-server.md) | `#[experimental]` 标注 + 握手 `experimentalApi` opt-in + 出站剥字段三层隔离，稳定面/实验面共用代码路径 |

## 安全与沙箱

| 中文译法 | 英文原文 | 首次出现章节 | 备注 |
|----------|----------|--------------|------|
| 未受信 | untrusted | [第 11 章](ch11-sandbox-approval.md) | `AskForApproval::UnlessTrusted`：规则没放行的一律问；面向未受信项目的内部策略。[第 3 章](ch03-config.md)对项目层用「不可信」表述信任门，是同族概念 |
| 受信 / 外部（注册双通道） | trusted / external | [第 9 章](ch09-tools.md) | `register_trusted*` 重名即 panic，`register_external*` 宽容跳过；与安全语义的 trusted 是同词不同用法 |
| 规则引擎 | execpolicy | [第 11 章](ch11-sandbox-approval.md) | 独立 crate，starlark 规则 + token 级前缀匹配；自带 `codex-execpolicy check` CLI |
| 前缀规则 | `prefix_rule` | [第 11 章](ch11-sandbox-approval.md) | 逐 token 前缀比较，不做字符串 `startsWith` |
| 平命令 | plain command | [第 11 章](ch11-sandbox-approval.md) | 剥掉 `bash -lc` 外壳后逐段求值；内层只能加严，不能借外壳信任放行 |
| 危险命令启发式 | dangerous-command heuristics | [第 11 章](ch11-sandbox-approval.md) | `dangerous_command_match`；只能把命令往严格方向推 |
| 提权 / 提权重试 | escalation / escalated retry | [第 9 章](ch09-tools.md) | 沙箱 `Denied` 后追问「command failed; retry without sandbox?」，批准后放宽沙箱重跑 |
| 沙箱拒绝 | `SandboxErr::Denied` | [第 9 章](ch09-tools.md) | 唯一触发提权升级的错误分类 |
| 审批缓存（会话级） | session-scoped approval cache | [第 9 章](ch09-tools.md) | `ApprovedForSession`；缓存键含命令规范化结果（[第 10 章](ch10-shell-applypatch.md)） |
| 命令规范化 | command canonicalization | [第 10 章](ch10-shell-applypatch.md) | `canonicalize_command_for_approval`；与[第 8 章](ch08-context-compact.md)历史「规范化/归一化」（`normalize_history`）是两个词、两件事 |
| 审批修正案 | execpolicy amendment | [第 5 章](ch05-protocol.md) | `ApprovedExecpolicyAmendment`；落盘 `~/.codex/rules/default.rules` 并热更新（[第 11 章](ch11-sandbox-approval.md)） |
| Guardian 自动审查 | Guardian auto-review | [第 9 章](ch09-tools.md) | 审批三级路由：hooks → Guardian → 用户（[第 11 章](ch11-sandbox-approval.md)）；guardian 审查模式下工具清单受限。[第 5 章](ch05-protocol.md)已见 `guardian` 字段名 |
| hooks | hooks | [第 7 章](ch07-agent-loop.md) | 不翻译；Stop hooks、PreToolUse/PostToolUse hooks（[第 9 章](ch09-tools.md)）、PermissionRequest hooks（[第 11 章](ch11-sandbox-approval.md)） |
| 网络审批 / 出网代理 | network approval / network-proxy | [第 11 章](ch11-sandbox-approval.md) | 第三条独立审批维度；`ReviewDecision::NetworkPolicyAmendment` |
| 平台沙箱机制名 | seatbelt / bubblewrap（bwrap）/ seccomp / Landlock / restricted token | [第 11 章](ch11-sandbox-approval.md) | 均不翻译；Landlock 已退居 legacy 后备 |
| 默认拒绝 | fail-closed | [第 11 章](ch11-sandbox-approval.md) | 审批 oneshot 断开即按 `Abort` 处理，绝不放行 |
| 沙箱即 argv 改写 | sandbox-as-argv-rewriting | [第 11 章](ch11-sandbox-approval.md) | `SandboxManager::transform` 的统一抽象 |

## 存储与持久化

| 中文译法 | 英文原文 | 首次出现章节 | 备注 |
|----------|----------|--------------|------|
| rollout | rollout | [第 1 章](ch01-overview.md) | 不翻译；append-only JSONL 会话记录，位于 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`。崩溃恢复的唯一真相源（因为 `store: false`） |
| state_db | state_db | [第 13 章](ch13-persistence.md) | 不翻译；sqlite 读取视图（`state_5.sqlite` 等分库），损坏可自动备份重建 |
| 事件溯源 | event sourcing | [第 13 章](ch13-persistence.md) | 事件日志是真相源，会话状态是日志的左折叠；与 CQRS 一并提及 |
| 写入真相源 | source of truth | [第 13 章](ch13-persistence.md) | rollout JSONL |
| 读取视图 | read model | [第 13 章](ch13-persistence.md) | state_db；为 picker/搜索等查询服务 |
| 投影 | projection | [第 13 章](ch13-persistence.md) | rollout → sqlite 的单向派生，「可落后、不可超前」。注意[第 1 章](ch01-overview.md)「UI 只是事件的投影」、[第 5 章](ch05-protocol.md)「呈现投影」是同一思想的泛化用法 |
| 物化 | materialize | [第 13 章](ch13-persistence.md) | rollout 延迟物化：首次 persist/flush 才创建文件。[第 3 章](ch03-config.md)另有「层被物化为 `ConfigLayer`」用法 |
| 反向扫描 | reverse scan | [第 13 章](ch13-persistence.md) | `reconstruct_history_from_rollout` 自新向旧扫，找到最近压缩检查点即锁定历史基线 |
| 检查点 / 压缩检查点 | checkpoint / `CompactedItem` | [第 13 章](ch13-persistence.md) | `replacement_history` 自包含，检查点之前的历史重建时不需再读 |
| resume / fork | resume / fork | [第 13 章](ch13-persistence.md) | 不翻译；resume 续写原文件、thread_id 不变，fork 拷贝历史、换全新身份 |
| 序号 | ordinal | [第 13 章](ch13-persistence.md) | paginated 模式的行级序号；续写时从文件尾部反推下一个 |
| 栅栏 | fence（flush/persist） | [第 13 章](ch13-persistence.md) | `PersistContext::TurnStart` 允许后台写盘，但由后续 flush/shutdown 兜底 |
| 背压 | backpressure | [第 4 章](ch04-auth-model.md) | 有界 channel 满则发送方挂起；指令通道有界（512）、事件通道无界（[第 6 章](ch06-core-session.md)） |
| 瞬态事件 | transient event | [第 13 章](ch13-persistence.md) | `*Delta`、审批请求等不落盘（`rollout/src/policy.rs`） |
| 冷数据压缩 | zstd sidecar（`.zst`） | [第 13 章](ch13-persistence.md) | 与上下文「压缩」不同义，注意区分 |
| 延迟物化 | deferred creation | [第 13 章](ch13-persistence.md) | 空会话不留垃圾文件的原因 |

## 其它（启动、配置与工程词汇）

| 中文译法 | 英文原文 | 首次出现章节 | 备注 |
|----------|----------|--------------|------|
| npm 壳 | npm wrapper / shim | [第 1 章](ch01-overview.md) | `codex-cli/bin/codex.js`；机制展开在[第 2 章](ch02-startup.md) |
| 平台分包 | platform packages | [第 2 章](ch02-startup.md) | `optionalDependencies` 由打包脚本在发布时注入 |
| arg0 分发 | arg0 dispatch | [第 1 章](ch01-overview.md) | 按 argv[0]/argv[1] 识别沙箱助手、apply_patch 等特殊身份；详见[第 2 章](ch02-startup.md) |
| busybox 模式 | busybox pattern | [第 2 章](ch02-startup.md) | 一个二进制按 argv[0] 扮演多个工具 |
| 陪护式 spawn | supervised spawn | [第 2 章](ch02-startup.md) | npm 壳全程陪护：转发信号、镜像退出码 |
| 层 / 层栈 | layer / `ConfigLayerStack` | [第 3 章](ch03-config.md) | 九类来源各带 `precedence()` 分数，从低到高压栈 |
| 生效配置 | effective config | [第 3 章](ch03-config.md) | `effective_config()` 逐层深合并出的 TOML 值树 |
| 要求层 / 管理员约束 | requirements | [第 3 章](ch03-config.md) | `ConfigRequirements`；与配置层平行的另一轨道，凌驾一切层包括命令行 |
| 来源追踪 | provenance / origins | [第 3 章](ch03-config.md) | `origins()` 逐键记录「这个值来自哪一层」 |
| profile | profile（v2） | [第 3 章](ch03-config.md) | 不翻译；`--profile <name>` 加载 `~/.codex/<name>.config.toml` 作为第二个用户层；旧式 `profile = "name"` 选择器已硬报错移除 |
| 单一事实来源 | single source of truth | [第 3 章](ch03-config.md) | 如 `FEATURES` 注册表、`ConfigToml` 类型之于 schema |
| 双轨命名 | dual-track naming | [第 12 章](ch12-mcp.md) | 模型可见名（sanitize + hash 消歧）与协议原始名（`tool.name`）同时维护 |
| 启动去重 | startup dedup | [第 12 章](ch12-mcp.md) | `Shared<BoxFuture>`：多处并发 await 同一次连接启动 |
| 脏标记刷新 | dirty-mark refresh | [第 12 章](ch12-mcp.md) | `mark_mcp_runtime_dirty()` + `refresh_mcp_if_dirty()` |
| 双端缓冲 / 保头保尾 | head/tail buffer | [第 10 章](ch10-shell-applypatch.md) | `HeadTailBuffer` 1 MiB 定容，丢中段、计 `omitted_bytes` |
| 中段截断 | middle truncation | [第 10 章](ch10-shell-applypatch.md) | `truncate_middle_*`；输出回模型前的最后一道工序 |
| 拦截 | interception | [第 10 章](ch10-shell-applypatch.md) | shell 里的 `apply_patch` 被 tree-sitter 识别并收编进补丁管线 |
| 策略语言 | policy language | [第 5 章](ch05-protocol.md) | 「审批不是布尔值，是一个小型策略语言」 |
| 两级停止 | two-level stop | [第 6 章](ch06-core-session.md) | `cancel()` 后等 100ms，再 `handle.abort()` 强杀 |
| 看门人清理 | janitor cleanup | [第 2 章](ch02-startup.md) | arg0 临时别名目录的文件锁 + 清理 |
| 快照测试 | snapshot test（insta） | [第 14 章](ch14-tui.md) | UI 回归的机器可读形态；`.snap.new` 待审、`cargo insta accept` 转正，快照随 PR 进 code review（流程详见[第 17 章](ch17-engineering.md)） |
| 假模型 + 真内核 | fake model + real kernel | [第 17 章](ch17-engineering.md) | 集成测试元模式：wiremock 录放 SSE，其余（Session/回合/工具/rollout）全真；断言锚点是内核发出的请求体 |
| 生成-校验闭环 | generate-and-verify loop | [第 17 章](ch17-engineering.md) | 派生物必配「一条生成命令 + 一条 CI 校验」：`just write-config-schema`、`just bazel-lock-update`、`cargo insta accept` 等 |
| 双构建 | dual build（cargo + bazel） | [第 17 章](ch17-engineering.md) | `Cargo.lock` 为单一事实来源，bazel 经 `crate.from_cargo` 放大到 11 平台；代价是 cargo 原生配置要付「同步税」 |

## 双名与一词多义速查

统稿与阅读时最容易踩的术语坑，集中列在这里：

- **`TurnItem` vs `ThreadItem`**：同一层「面向 UI 的条目」概念。protocol crate 内叫
  `TurnItem`，app-server-protocol v2 对外叫 `ThreadItem`。读源码看到两个名字不要当
  成两套模型（[第 5 章](ch05-protocol.md)）。
- **「压缩」两义**：上下文压缩（compact/compaction，[第 8 章](ch08-context-compact.md)）
  与 rollout 冷数据 zstd 压缩（[第 13 章](ch13-persistence.md)）。前者是改写历史，
  后者只是文件存储优化。
- **「规范化」两义**：历史规范化 `normalize_history`（补齐/删除工具调用配对，
  [第 8 章](ch08-context-compact.md)，各章也写「归一化」）与命令规范化
  `canonicalize_command_for_approval`（审批缓存键，[第 10 章](ch10-shell-applypatch.md)）。
- **「物化」两义**：rollout 延迟物化（[第 13 章](ch13-persistence.md)）与配置层物化
  为 `ConfigLayer`（[第 3 章](ch03-config.md)）。
- **「投影」多处复用**：UI 是事件的投影（[第 1 章](ch01-overview.md)）、`TurnItem`
  是呈现投影（[第 5 章](ch05-protocol.md)）、state_db 是 rollout 的投影
  （[第 13 章](ch13-persistence.md)）。思想一致，严格程度递增。
- **「裁决」vs「审批决定」**：`Decision`（execpolicy 规则引擎产出，Allow/Prompt/
  Forbidden）是裁决；`ReviewDecision`（用户或审查者对审批请求的答复）是审批决定。
  前者判定「要不要问」，后者回答「批不批」（[第 11 章](ch11-sandbox-approval.md)）。
- **「粘性路由 token」**：已统一。`x-codex-turn-state` 响应头携带的回合级路由 token，
  [第 4 章](ch04-auth-model.md)（首现，保留英文括注）与[第 7 章](ch07-agent-loop.md)
  现均作「粘性路由 token」；早期的「粘滞路由令牌」词形已废弃。
- **「并行门闸」**：已统一。指 `ToolCallRuntime` 的 `RwLock` 准入，
  [第 7 章](ch07-agent-loop.md)与[第 9 章](ch09-tools.md)现均作「并行门闸」；
  早期的「并行闸/并发闸」词形已废弃。
- **「会话」vs「主线」**：日常叙述可互换；涉及持久化身份（thread_id、rollout 文件、
  resume/fork）时用「主线」，涉及运行时对象（`Session`、事件通道）时用「会话」。
- **回合输入的三层同名**：内核协议层是 `Op::TurnInput`（本基线没有 `Op::UserTurn`）；
  TUI 内部指令叫 `AppCommand::UserTurn`；app-server 线上是 `turn/start`/`turn/steer`。
  同理，流式文本增量在内核叫 `EventMsg::AgentMessageContentDelta`，app-server 通知叫
  `AgentMessageDelta`（`item/agentMessage/delta`）。同义不同层，各层命名都是合法的
  （[第 14 章](ch14-tui.md)）。
