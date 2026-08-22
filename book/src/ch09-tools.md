# 第 9 章 工具系统：ToolSpec、注册与执行器

## 本章导读

[第 7 章](ch07-agent-loop.md)走读 Agent Loop 时，我们把「模型返回 tool_use → 执行 → 回传结果」压缩成了
一个方框。本章把这个方框拆开。几乎所有自研 Agent 都会在工具系统上踩同样的三个坑，
Codex 的答案各不相同，值得逐一对照：

1. **模型看到的工具列表如何生成？** 工具不是一张静态清单。内置 shell、MCP 服务器
   暴露的工具、客户端注入的动态工具、托管在模型侧的 web_search……来源五花八门，
   还要按 feature flag、模型能力、会话模式逐个过滤。你的 my-agent 里那份
   `tools: [...]` 字面量，在生产级 Agent 里是一整套构建流水线。
2. **模型返回的 tool_use 如何路由到具体执行器？** 模型只给出一个名字和一段参数，
   内核要把它变成「找到正确的 handler、校验 payload 类型、执行、把结果序列化回
   `FunctionCallOutput`」的完整链路，并且名字不存在时不能让整个回合（turn）崩溃。
3. **审批（approval）与沙箱（sandbox）在哪个点拦截？** 答案是：不在路由层，
   也不在各个 handler 里各写一遍，而是收敛在一个叫 `ToolOrchestrator` 的编排器里，
   以「审批 → 选沙箱 → 尝试 → 失败后提权重试」的固定序列包住真正会触碰系统的工具。

读完本章，你应该能在源码里定位这三条链路，并理解 Codex 为什么把「给模型看的
描述（ToolSpec）」和「真正执行的代码（handler）」拆成两层。

## 源码地图

工具系统横跨两个 crate：`codex-tools`（独立的 `codex-rs/tools/`，只放与 Responses
API 对齐的纯数据结构，不依赖 `codex-core`）和 `codex-core` 内的
`core/src/tools/`（注册、路由、编排、handler 实现）。

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-rs/tools/src/tool_spec.rs` | `ToolSpec`：发给模型的工具描述 | 序列化结果就是 Responses API 的合法 Tool JSON |
| `codex-rs/tools/src/tool_executor.rs` | `ToolExecutor` trait 与 `ToolExposure` | spec 与执行体焊在一起的契约 |
| `codex-rs/tools/src/tool_payload.rs` | `ToolPayload`：三种调用载荷 | Function / ToolSearch / Custom 三分 |
| `codex-rs/tools/src/responses_api.rs` | `ResponsesApiTool` / `ResponsesApiNamespace` 等 JSON 结构 | 工具命名空间（namespace）的线上格式 |
| `codex-rs/protocol/src/tool_name.rs` | `ToolName`：带命名空间的工具标识 | 默认命名空间叫 `functions` |
| `codex-rs/core/src/tools/mod.rs` | 模块总入口 | 注意几乎所有子模块都是 `pub(crate)` |
| `codex-rs/core/src/tools/spec_plan.rs` | 每个 step 构建工具清单的总装车间 | 全章最核心的一个文件，1381 行 |
| `codex-rs/core/src/tools/registry.rs` | `ToolRegistry` 注册表 + dispatch 主干 | 信任/外部双通道注册，hooks 在这里织入 |
| `codex-rs/core/src/tools/router.rs` | `ToolRouter`：`ResponseItem` → `ToolCall` → 分发 | 路由本身很薄，厚活在 registry |
| `codex-rs/core/src/tools/orchestrator.rs` | `ToolOrchestrator`：审批 + 沙箱 + 重试编排 | 文件头注释自己写明了职责 |
| `codex-rs/core/src/tools/sandboxing.rs` | `ToolRuntime`/`SandboxAttempt`/`ExecApprovalRequirement` | 编排器与具体 runtime 之间的接口 |
| `codex-rs/core/src/tools/parallel.rs` | `ToolCallRuntime`：并行门闸与取消 | 用一把 `RwLock` 做并行准入 |
| `codex-rs/core/src/tools/context.rs` | `ToolInvocation`、`ToolOutput` 等上下文类型 | handler 能摸到的一切都在 `ToolInvocation` 里 |
| `codex-rs/core/src/tools/handlers/` | 全部内置 handler 与 spec | `*_spec.rs` 与执行文件成对出现 |
| `codex-rs/core/src/mcp_tool_exposure.rs` | MCP 工具注册进 registry 的适配层 | 连接管理的细节留给[第 12 章](ch12-mcp.md) |

## 核心数据结构

### ToolSpec：发给模型的那一面

`ToolSpec` 是整个系统的「对模型侧」。它的文档注释说得很直白：序列化为 JSON 后就是
OpenAI Responses API 里一个合法的 Tool。

```rust
// 来源：codex-rs/tools/src/tool_spec.rs:20-56
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type")]
pub enum ToolSpec {
    #[serde(rename = "function")]
    Function(ResponsesApiTool),          // ← 标准 JSON Schema 函数工具
    #[serde(rename = "namespace")]
    Namespace(ResponsesApiNamespace),    // ← 一组工具打包成一个命名空间
    #[serde(rename = "tool_search")]
    ToolSearch {
        execution: String,
        description: String,
        parameters: JsonSchema,
    },
    #[serde(rename = "web_search")]
    WebSearch { /* ... */ },             // ← 模型侧托管工具，本地不执行
    #[serde(rename = "custom")]
    Freeform(FreeformTool),              // ← 自由格式工具（如 apply_patch）
}
```

注意这个 enum 里混着两类东西：`Function`/`Freeform`/`Namespace` 是「客户端执行」的
工具，模型调用后由 Codex 本地跑；`WebSearch` 是「模型侧托管」的工具，Codex 只负责把
描述发过去，执行发生在 OpenAI 服务端，本地没有对应 handler。这是理解后面
`hosted_specs` 与 registry 分头处理的关键。

函数工具本体是 `ResponsesApiTool`（responses_api.rs:31-44）：`name`、`description`、
`strict`、`parameters: JsonSchema`，外加一个不参与序列化的
`output_schema`（`#[serde(skip)]`，只用于本地校验与提示）。

### ToolName：命名空间感知的路由键

早期 Codex 的工具名就是一个扁平字符串。本基线已经改成带命名空间的结构体
（tool_name.rs:11-52）：

```rust
// 来源：codex-rs/protocol/src/tool_name.rs:7-51
pub const DEFAULT_FUNCTION_NAMESPACE: &str = "functions";

pub struct ToolName {
    pub name: String,
    pub namespace: Option<String>,       // ← None 时视为默认命名空间
}

impl ToolName {
    pub fn plain(name: impl Into<String>) -> Self { /* namespace = None */ }
    pub fn namespaced(namespace: impl Into<String>, name: impl Into<String>) -> Self { /* ... */ }

    pub fn with_default_namespace(mut self) -> Self {
        if self.namespace.as_deref().is_none_or(str::is_empty) {
            self.namespace = Some(DEFAULT_FUNCTION_NAMESPACE.to_string());
        }
        self                               // ← 把 None 归一成 "functions"，比较时不再有二义
    }
}
```

`exec_command`、`update_plan` 这类内置工具活在默认命名空间 `functions` 里；MCP 服务器
和多 agent 协作工具可以各占一个命名空间（如 `collaboration`）。registry 的查表键就是
归一化后的 `ToolName`。

### ToolExecutor：spec 与执行体焊在一起的契约

执行侧的核心抽象在 `codex-tools` crate，一个泛型 trait
（tool_executor.rs:101-127）：

```rust
// 来源：codex-rs/tools/src/tool_executor.rs:101-127
/// Shared runtime contract for model-visible tools.
pub trait ToolExecutor<Invocation>: Send + Sync {
    /// The concrete tool name handled by this runtime instance.
    fn tool_name(&self) -> ToolName;

    fn spec(&self) -> ToolSpec;                    // ← 给模型看的描述，由同一个对象产出

    /// The preferred exposure before the host applies step-specific policy.
    fn exposure(&self) -> ToolExposure {
        ToolExposure::Direct
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        false                                      // ← 默认不并行，工具要自己声明线程安全
    }

    fn handle(&self, invocation: Invocation) -> ToolExecutorFuture<'_>;  // ← 执行体
}
```

这段 trait 是本章最重要的设计声明：**同一个对象既回答「你长什么样」（`spec()`），
又回答「你怎么执行」（`handle()`）**。模型可见描述与执行逻辑不可能漂移——不会出现
schema 里写了参数 `cmd` 而 handler 去读 `command` 的事故（除非作者自己写岔）。

`handle` 返回的 `ToolExecutorFuture` 是个类型别名
（tool_executor.rs:10-12）：

```rust
// 来源：codex-rs/tools/src/tool_executor.rs:10-12
pub type ToolExecutorFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Box<dyn ToolOutput>, FunctionCallError>> + Send + 'a>>;
```

输出是 `Box<dyn ToolOutput>`——一个 trait object，负责把执行结果转成三种消费者需要
的形态：日志（`log_output`）、回给模型的 `ResponseInputItem`（`to_response_item`）、
Code Mode 嵌套调用的 JSON（`code_mode_result`）。

`ToolExposure` 控制工具在「哪些面向模型的表面」上可见（tool_executor.rs:50-80）：
`Direct`（直接进初始工具列表）、`Deferred`（不进列表，但能被 `tool_search` 搜到）、
`CodeModeOnly`、`Hidden`（注册可分发但模型完全看不见）等六个变体。这是 Codex 控制
上下文预算的第一道阀门：工具可以注册了但不发 schema。

### ToolCall / ToolPayload / ToolInvocation：一次调用的三段旅程

模型输出流经系统时，一次工具调用有三个形态：

```rust
// 来源：codex-rs/core/src/tools/router.rs:31-37
// 形态一：刚从 ResponseItem 解析出来，还没绑定会话
pub struct ToolCall {
    pub tool_name: ToolName,
    pub call_id: String,
    pub payload: ToolPayload,
    pub encrypted_function_args: Option<Vec<String>>,
}
```

```rust
// 来源：codex-rs/tools/src/tool_payload.rs:6-11
/// Canonical payload shapes accepted by model-visible tool runtimes.
pub enum ToolPayload {
    Function { arguments: String },                  // ← JSON 字符串参数
    ToolSearch { arguments: SearchToolCallParams },  // ← tool_search 的结构化参数
    Custom { input: String },                        // ← freeform 工具的原始文本（如补丁全文）
}
```

```rust
// 来源：codex-rs/core/src/tools/context.rs:55-67
// 形态二：绑定会话上下文后，交给 handler 的完整调用
pub struct ToolInvocation {
    pub session: Arc<Session>,
    pub turn: Arc<TurnContext>,
    pub(crate) step_context: Arc<StepContext>,
    pub cancellation_token: CancellationToken,       // ← 用户按 Esc 时用它中断工具
    pub tracker: SharedTurnDiffTracker,
    pub call_id: String,
    pub tool_name: ToolName,
    pub source: ToolCallSource,                      // ← Direct / CodeMode 嵌套调用等
    pub payload: ToolPayload,
}
```

形态三是执行完的 `AnyToolResult`（registry.rs:186-210），它的
`into_response()` 把结果折叠回 `ResponseInputItem`，等待追加进对话历史——[第 5 章](ch05-protocol.md)
讲过的条目（item）模型在这里收口。

## 流程走读

### 4.1 工具清单的生成：每个 step 重建一次 ToolRouter

先给全景，再逐段拆：

```
StepContext 构建（session/mod.rs:3255）
   │
   ▼
built_tools() ──► spec_plan.rs::build_tool_router()
   │                   │
   │                   ├─ add_core_tool_sources()     内置工具（按 flag 过滤）
   │                   ├─ append_mcp_tools()          MCP 工具（Ch12）
   │                   ├─ append_extension_tool_executors()  扩展工具
   │                   ├─ append_dynamic_tool_runtimes()     动态工具
   │                   └─ hosted_model_tool_specs()   托管工具 web_search
   │                   │
   │                   ▼
   │            finalize_tool_router()：冲突处理 + tool_search 后处理
   │                   │
   │                   ▼
   │            build_model_visible_specs()：按 ToolExposure 过滤
   │                   │
   ▼                   ▼
ToolRouter { registry, model_visible_specs }
   │
   ▼
build_prompt()：Prompt { tools, parallel_tool_calls: true, .. }
   │
   ▼
序列化为 Responses API 请求（Ch4 的 ModelClient）
```

第一个反直觉的事实：**工具清单不是会话级常量，而是随 `StepContext` 重建的**。
`built_tools()`（turn.rs:1494-1570）在每个 step 的上下文构建时被调用
（session/mod.rs:3255 附近），拿到全新的 `ToolRouter`。为什么？因为工具集本身是
动态变化的：MCP 服务器可能中途上线，feature flag 可能被改，guardian 审查模式
（一种受限的自动审查来源）只允许 `exec_command`/`write_stdin`/`view_image` 三个工具
（spec_plan.rs:888-928 的分支）。每步重建让「此刻模型能用什么」永远由当前状态决定。

`build_tool_router()`（spec_plan.rs:116-172）的主体是往一个空的 `ToolRegistry`
里按来源灌工具：

```rust
// 来源：codex-rs/core/src/tools/spec_plan.rs:141-172（删节）
let mut registry = ToolRegistry::default();
add_core_tool_sources(&context, &mut registry);

let hosted_specs = if crate::guardian::is_guardian_reviewer_source(&turn_context.session_source)
{
    Vec::new()                                     // ← guardian 审查员不碰外部工具
} else {
    let registered_mcp_tools = session.services.mcp_handler_cache.append_mcp_tools(
        mcp, &turn_context.config, apps_enabled,
        &mcp.config().mcp_server_catalog,
        search_tool_enabled(turn_context),
        &mut registry,
    );                                             // ← MCP 工具在这里汇入（详见 Ch12）
    apply_mcp_tool_exposure_policy(turn_context, mcp, &registered_mcp_tools, &mut registry);
    let standalone_web_search_tool = append_extension_tool_executors(
        turn_context,
        extension_tool_executors(session, step_store),
        &mut registry,
    );
    append_dynamic_tool_runtimes(&turn_context.dynamic_tools, &mut registry);
    hosted_model_tool_specs(turn_context, standalone_web_search_tool.as_slice())
};
```

五路来源汇成两类产物：进 `registry` 的「本地可执行工具」，和只作为 spec 存在的
「托管工具」（`hosted_specs`，目前主要是 web_search）。`add_core_tool_sources`
（spec_plan.rs:888-934）再细分四组：shell 工具（`add_shell_tools`，spec_plan.rs:957-986，
注册 `ExecCommandHandler` 和 `WriteStdinHandler`）、MCP 资源工具、核心工具
（`add_core_utility_tools`，spec_plan.rs:1009-1115，按 flag 加 `PlanHandler`、
`ViewImageHandler`、`ApplyPatchHandler` 等）、协作工具（`add_collaboration_tools`，
注册 spawn/wait/send 等多 agent 工具）。每个 `registry.add(...)` 外面都裹着
`features.enabled(...)` 或配置判断——这就是「模型看到什么」的全部决策点。

收尾在 `finalize_tool_router()`（spec_plan.rs:313-448）：处理 tool_search 与
code_mode 的互斥注册、可选的命名冲突报错（`error_on_tool_collisions`），最后调用
`build_model_visible_specs()`（spec_plan.rs:483-519）产出发给模型的列表：

```rust
// 来源：codex-rs/core/src/tools/spec_plan.rs:490-518（删节）
let mut specs = Vec::new();
for tool in registry.entries() {
    let exposure = tool.exposure;
    if !exposure.is_direct() {
        continue;                                  // ← Deferred/Hidden 工具不进初始列表
    }
    // ...
    let spec = tool.runtime.spec();
    specs.push(spec_for_model_request(/* ... */));
}
specs.extend(hosted_specs);                        // ← 托管工具只出现在这里，不进 registry

merge_into_namespaces(specs)
    .into_iter()
    .filter(|spec| {
        namespace_tools_enabled(turn_context) || !matches!(spec, ToolSpec::Namespace(_))
    })
    .collect()
```

`merge_into_namespaces()`（spec_plan.rs:814-864）把同名命名空间的工具合并、排序，
并给空描述补上默认文案。如果提供方（provider）不支持命名空间工具，最后的
`filter` 会把命名空间整体剥掉——同一个 registry，输出形态跟着 provider 能力走。

最终，`build_prompt()`（turn.rs:1311-1328）把这份列表钉进请求：

```rust
// 来源：codex-rs/core/src/session/turn.rs:1316-1322
Prompt {
    input,
    tools: step_context.tool_router.model_visible_specs(),  // ← 上一步的产物
    parallel_tool_calls: true,                              // ← 允许模型一次返回多个 tool_use
    // ...
}
```

[第 4 章](ch04-auth-model.md)讲过请求是全量重发历史、`prompt_cache_key = session_id`；这里的
`tools` 列表同样每次全量带上。列表内容稳定（同样的注册顺序、排序后的命名空间）
对 prompt cache 命中率是有意义的——这也是 `IndexMap` 保序注册和
`merge_into_namespaces` 排序的一个隐性收益。

### 4.2 tool_use 的路由：薄 router，厚 registry

模型流式返回的每个条目在 `handle_output_item_done()`
（stream_events_utils.rs:288-328）里过一道分拣：

```rust
// 来源：codex-rs/core/src/stream_events_utils.rs:297-327（删节）
match ToolRouter::build_tool_call(item.clone()) {
    // The model emitted a tool call; log it, persist the item immediately, and queue the tool execution.
    Ok(Some(call)) => {
        // ...
        let cancellation_token = ctx.cancellation_token.child_token();
        let tool_future: InFlightFuture<'static> = Box::pin(
            ctx.tool_runtime
                .clone()
                .handle_tool_call(call, cancellation_token),   // ← 立刻 spawn，不等上一个工具结束
        );
        output.needs_follow_up = true;
        output.tool_future = Some(tool_future);
    }
    // ...
}
```

`ToolRouter::build_tool_call()`（router.rs:147-200）是纯函数式的解析：
`ResponseItem::FunctionCall` → `ToolPayload::Function`，
`ResponseItem::CustomToolCall` → `ToolPayload::Custom`，
`ResponseItem::ToolSearchCall`（且 `execution == "client"`）→ `ToolPayload::ToolSearch`，
其余条目（文本、reasoning 等）返回 `Ok(None)` 走普通条目通道。解析失败的
`tool_search` 参数直接变成 `FunctionCallError::RespondToModel`——把错误反馈给模型
而不是让回合崩掉，这个模式后面还会反复出现。

```
ResponseItem::FunctionCall { name, namespace, arguments, call_id }
   │
   ▼ ToolRouter::build_tool_call()（router.rs:147-200）
ToolCall { tool_name, call_id, payload }
   │
   ▼ ToolCallRuntime::handle_tool_call()（parallel.rs:72-89）
tokio::spawn ──► 并行门闸（read/write lock）
   │
   ▼ ToolRouter::dispatch_tool_call_with_terminal_outcome()（router.rs:227-247）
组装 ToolInvocation
   │
   ▼ ToolRegistry::dispatch_any_with_terminal_outcome()（registry.rs:479-753）
   │   ├─ 查表：tool() 找不到 → RespondToModel("unsupported call: ...")
   │   ├─ matches_kind() 校验 payload 类型
   │   ├─ PreToolUse hooks（可拦截/改写参数）
   │   ├─ handle_any_tool() → tool.handle(invocation)   ← handler 真正执行
   │   └─ PostToolUse hooks（可否决/改写结果）
   ▼
AnyToolResult → into_response() → ResponseInputItem::FunctionCallOutput
   │
   ▼ drain_in_flight()（turn.rs:2130-2152）
追加进对话历史 → 下一次模型请求带上
```

`ToolRouter` 本身的 dispatch（router.rs:249-285）只做一件事：把 `ToolCall` 加上
`session`/`step_context`/`cancellation_token` 等上下文，组装成 `ToolInvocation`，
然后转手给 registry。真正的分发主干在
`ToolRegistry::dispatch_any_with_terminal_outcome()`（registry.rs:479-753），它按
顺序做五件事，每件都值得知道位置：

1. **计数与遥测**（registry.rs:507-547）：回合级 `tool_calls` 计数、沙箱/策略 tag。
2. **查表**（registry.rs:516-535）：`self.tool(&tool_name)` 查不到时返回
   `FunctionCallError::RespondToModel("unsupported call: {tool_name}")`——模型幻觉出
   不存在的工具名，代价只是这一条 tool call 返回错误文本，回合继续。
3. **payload 类型校验**（registry.rs:548-564）：`matches_kind()` 确保
   freeform 工具不会被 JSON 参数调用、函数工具不会被 freeform 载荷调用，不匹配是
   `Fatal`（这属于内核内部不一致，不该发生）。
4. **PreToolUse hooks**（registry.rs:566-618）：外部 hook 可以 `Blocked`（拦下这次
   调用并把原因喂回模型），也可以 `Continue { updated_input }`（改写参数后放行，
   走 `with_updated_hook_input` 重建 invocation）。
5. **执行 + PostToolUse hooks**（registry.rs:643-753）：`handle_any_tool()`
   （registry.rs:769-794）调用 `tool.handle(invocation)` 拿到 `Box<dyn ToolOutput>`；
   之后 PostToolUse hook 可以否决结果（`should_block`）或替换模型可见的输出文本
   （`PostToolUseFeedbackOutput` 包装，registry.rs:212-233）。

注意一个分层：hooks、遥测、生命周期通知这些横切关注点全在 registry 的 dispatch
主干里织入，handler 自己只管执行。这就是为什么新增一个工具不需要关心 hook 协议。

### 4.3 spec 与 handler 的分离：三个样本

「分离」在两个尺度上存在。第一个尺度是**文件**：`handlers/` 目录里 `*_spec.rs`
文件只负责生成 `ToolSpec`（纯函数、无副作用），同名执行文件实现
`ToolExecutor`。第二个尺度是**trait 方法**：`spec()` 与 `handle()` 是同一个对象
上两个互不依赖的方法，registry 在「列清单」时只调 `spec()`，在「分发」时只调
`handle()`。

**样本一：`exec_command`（JSON Schema 函数工具）。** spec 侧，
`create_exec_command_tool_with_environment_id()`（shell_spec.rs:21-111）用
`BTreeMap` 拼出参数 schema——`cmd`（必填）、`workdir`、`tty`、`yield_time_ms`、
`max_output_tokens`，再按 `ExecCommandHandlerOptions` 条件性地追加 `shell`、
`login`、`environment_id` 参数：

```rust
// 来源：codex-rs/core/src/tools/handlers/shell_spec.rs:91-110
ToolSpec::Function(ResponsesApiTool {
    name: "exec_command".to_string(),
    description: if cfg!(windows) {
        format!(
            "Runs a command in a PTY, returning output or a session ID for ongoing interaction.\n\n{}",
            windows_shell_guidance()          // ← Windows 专用的安全指引也写在 spec 里
        )
    } else {
        "Runs a command in a PTY, returning output or a session ID for ongoing interaction."
            .to_string()
    },
    strict: false,
    defer_loading: None,
    parameters: JsonSchema::object(
        properties,
        Some(vec!["cmd".to_string()]),
        Some(false.into()),
    ),
    output_schema: Some(unified_exec_output_schema()),
})
```

执行侧，`ExecCommandHandler`（exec_command.rs:82-105）的 impl 短得可以整段引用——
它正好展示了 `ToolExecutor` 契约的最小实现：

```rust
// 来源：codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs:82-105
impl ToolExecutor<ToolInvocation> for ExecCommandHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("exec_command")
    }

    fn spec(&self) -> ToolSpec {
        create_exec_command_tool_with_environment_id(  // ← spec 由 shell_spec.rs 的纯函数生成
            CommandToolOptions { /* ... */ },
            self.options.include_environment_id,
            self.options.include_shell_parameter,
        )
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true                                           // ← shell 工具声明可并行
    }

    fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_> {
        Box::pin(self.handle_call(invocation))
    }
}
```

`handle_call()`（exec_command.rs:108 起）解析参数、确定工作目录与 shell，最后交给
unified exec 进程管理器执行——命令执行与 diff 的细节是[第 10 章](ch10-shell-applypatch.md)的内容。

**样本二：`apply_patch`（freeform 工具 + 语法约束）。** 它的 spec 不是 JSON Schema，
而是一段 Lark 语法（apply_patch_spec.rs:9-27）：

```rust
// 来源：codex-rs/core/src/tools/handlers/apply_patch_spec.rs:9-27（删节）
const APPLY_PATCH_LARK_GRAMMAR: &str = include_str!("apply_patch.lark");

pub fn create_apply_patch_freeform_tool(include_environment_id: bool) -> ToolSpec {
    let definition = /* 按 include_environment_id 决定是否扩展语法 */ ;
    ToolSpec::Freeform(FreeformTool {
        name: "apply_patch".to_string(),
        description: "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.".to_string(),
        defer_loading: None,
        format: FreeformToolFormat {
            r#type: "grammar".to_string(),
            syntax: "lark".to_string(),        // ← 模型输出被约束为合法补丁文本
            definition,
        },
    })
}
```

因为载荷是原始文本而非 JSON，`ApplyPatchHandler` 在 `CoreToolRuntime` 里覆写了
`matches_kind`（apply_patch.rs:458-461），声明自己只接受
`ToolPayload::Custom { input }`；`handle_call()`（apply_patch.rs:366-455）先用
`codex_apply_patch::parse_patch` 解析文本，再走 `execute_verified_patch()`——后者
（apply_patch.rs:557-620）是我们下一节的入口，因为它把活儿交给了
`ToolOrchestrator`。apply_patch 还实现了一个可选能力
`create_diff_consumer()`（apply_patch.rs:463-465）：模型流式输出补丁文本时，TUI
可以边收边渲染 diff 预览，不必等整个工具调用完成。

**样本三：`update_plan`（无沙箱的纯控制工具）。** 不是所有工具都碰文件系统。
`PlanHandler`（plan.rs:48-103）的 `handle_call` 只是解析参数、发一个
`EventMsg::PlanUpdate` 事件给 UI，然后返回固定的 "Plan updated"。它甚至覆写了
`is_builtin_control_tool() → true`（plan.rs:99-103）让遥测把它归为控制工具。
这个样本的价值在于证明框架的下限很低：一个工具可以只有「名字 + schema + 一个
async 函数」，完全不沾审批和沙箱。

**MCP 工具呢？** 框架对 MCP 的容纳方式漂亮地验证了抽象的通用性：`McpHandler`
（handlers/mcp.rs:115-166）就是一个普通的 `ToolExecutor`——`spec()` 返回连接建立
时缓存好的 spec（`immutable_spec`，mcp.rs:216-219，避免每步重算），`handle_call()`
（mcp.rs:168-214）把 `ToolPayload::Function` 的参数转发给 MCP 连接管理器并把
`CallToolResult` 包成 `McpToolOutput`。它还利用 `supports_parallel_tool_calls()`
声明「只读 MCP 工具可并行」（mcp.rs:124-135）。连接生命周期、重连、服务器目录这些
真正的 MCP 复杂度在[第 12 章](ch12-mcp.md)展开；本章只需要记住：**对 registry 来说，MCP 工具与
内置工具毫无区别**，它们经 `mcp_tool_exposure.rs` 的 `append_mcp_tools()`
（mcp_tool_exposure.rs:37-71）以 `register_external` 通道进表。

### 4.4 审批与沙箱：ToolOrchestrator 的两道闸门

路由层（4.2）不做任何安全决策。真正会触碰系统资源的 handler（exec、apply_patch）
在内部再包一层 `ToolOrchestrator`。这个文件的模块注释（orchestrator.rs:1-8）把设计
意图写得比任何文档都清楚：

```rust
// 来源：codex-rs/core/src/tools/orchestrator.rs:1-8
/*
Module: orchestrator

Central place for approvals + sandbox selection + retry semantics. Drives a
simple sequence for any ToolRuntime: approval → select sandbox → attempt →
retry with an escalated sandbox strategy on denial (no re‑approval thanks to
caching).
*/
```

「approval → select sandbox → attempt → retry」四步在 `run()`
（orchestrator.rs:125-534）里依次展开：

```
ToolOrchestrator::run(tool, req, tool_ctx, approval_policy)
   │
   ├─ 1) 审批判定：tool.exec_approval_requirement(req)
   │      │        （默认由 default_exec_approval_requirement 按策略推导）
   │      ├─ Skip          → 直接放行（strict_auto_review 时仍过一次审查）
   │      ├─ Forbidden     → ToolError::Rejected，根本不执行
   │      └─ NeedsApproval → session.request_approval() ──► UI 弹审批（Ch11）
   │
   ├─ 2) 选沙箱：SandboxManager::select_initial()
   │      └─ seatbelt / landlock / windows / None（Ch11）
   │
   ├─ 3) 首次尝试：run_attempt()（沙箱内执行）
   │      │
   │      └─ 失败且为 SandboxErr::Denied？
   │              │
   ├─ 4) 提权重试 ◄┘ 再次 request_approval（带 retry_reason）
   │      └─ 无沙箱或放宽沙箱重跑一次
   ▼
OrchestratorRunResult { output, deferred_network_approval }
```

第一步的分叉由 `ExecApprovalRequirement` 三态驱动
（sandboxing.rs:151-171）：`Skip`（含是否可绕过沙箱的标记）、`NeedsApproval`
（含给用户的理由与 execpolicy 修正建议）、`Forbidden`。工具可以通过
`exec_approval_requirement(req)` 按本次参数自定义（比如 `git status` 只读可跳过），
也可以回落到 `default_exec_approval_requirement` 按全局审批策略推导
（orchestrator.rs:169-171）。

第三、四步是 Codex 特有的体验优化：**沙箱拒绝不等于终局**。首次在沙箱内执行返回
`SandboxErr::Denied` 时，编排器判断工具是否声明了 `escalate_on_failure()`
（orchestrator.rs:356），再按审批策略决定是否追问用户「command failed; retry
without sandbox?」（orchestrator.rs:549-553），批准后以放宽的沙箱重试
（orchestrator.rs:444-519）。你平时在 TUI 里看到的「沙箱内失败，要不要直接跑？」
弹窗就来自这条路径。审批决策还有会话级缓存（`with_cached_approval`，
sandboxing.rs:70-116）：用户选了「本会话总是允许」，后续同类调用直接放行。

编排器是泛型的：`run<Rq, Out, T: ToolRuntime<Rq, Out>>`，`ToolRuntime` trait
（sandboxing.rs 中定义）把「这个工具需要什么沙箱权限、怎么构造审批动作、失败要不
要提权」抽象成一组方法。apply_patch 的 `execute_verified_patch()` 里那几行
（apply_patch.rs:597-608）就是标准用法：

```rust
// 来源：codex-rs/core/src/tools/handlers/apply_patch.rs:597-608
let mut orchestrator = ToolOrchestrator::new();
let mut runtime = ApplyPatchRuntime::new();
let result = orchestrator
    .run(
        &mut runtime,
        &request,
        &tool_ctx,
        tool_ctx.step_context.turn.as_ref(),
        tool_ctx.step_context.turn.approval_policy(),  // ← 审批策略从回合上下文来
    )
    .await
    .map(|result| result.output);
```

审批 UI 怎么弹、沙箱三平台怎么实现、`execpolicy` 怎么参与判定，全部留给[第 11 章](ch11-sandbox-approval.md)；
本章只需记住拦截的**位置**：在 handler 内部、在具体执行之前，由一个共享编排器
统一收口。

### 4.5 并行工具执行：一把 RwLock 门闸

`Prompt` 里 `parallel_tool_calls: true`（turn.rs:1321）允许模型一次返回多个
tool_use。回看 4.2 的 `handle_output_item_done`：每个 tool call 都立即
`handle_tool_call()` 生成一个 future 塞进 `in_flight` 队列
（turn.rs:2391-2392），流处理循环不等待；直到回合需要收尾时才由
`drain_in_flight()`（turn.rs:2130-2152）用 `FuturesOrdered` 按入队顺序收结果、
逐条写入历史。

但「立即 spawn」不等于「立即并行执行」。`ToolCallRuntime` 内部有一把
`RwLock<()>` 门闸（parallel.rs:40-61），每个被 spawn 的 dispatch 任务先过闸：

```rust
// 来源：codex-rs/core/src/tools/parallel.rs:152-156
let _guard = if supports_parallel {
    Either::Left(lock.read().await)    // ← 声明可并行的工具：读锁，彼此不阻塞
} else {
    Either::Right(lock.write().await)  // ← 其余工具：写锁，独占执行
};
```

`supports_parallel` 来自前面见过的
`ToolExecutor::supports_parallel_tool_calls()`——`exec_command` 返回 `true`，只读
MCP 工具返回 `true`，其余默认 `false`。效果：模型连发三个 `exec_command` 会真正
并行跑；但一个 `apply_patch` 会把其它未声明并行的工具挡在闸外，避免两个写操作
同时改工作区。

取消语义也在这层：用户中断时 `cancellation_token` 触发，`tokio::select!` 里
（parallel.rs:179-205）abort 掉 dispatch 任务，并给模型回一条
"aborted by user after Xs" 的 `FunctionCallOutput`——注意这里仍然是**回结果给模型**
而不是静默丢弃，因为模型已经发出了这个 tool_use，历史里必须有一个对应的输出，
否则下一次全量重发历史时协议就不完整了（呼应[第 4 章](ch04-auth-model.md)的 `store: false` 全量重发）。

## 设计取舍

**为什么 spec 与 handler 是「一个对象的两个方法」，而不是 my-agent 式的一张表？**

你的 my-agent 大概率长这样：

```typescript
const tools = {
  shell: { schema: shellSchema, execute: runShell },
  readFile: { schema: readSchema, execute: readFile },
};
const tool = tools[call.name];
if (!tool) { /* 返回错误 */ }
return tool.execute(JSON.parse(call.arguments));
```

这张表把三件事揉在一处：模型可见描述、路由、执行。规模小时完全够用，Codex 早期
（`function_tool.rs` 时代）也接近这个形态。但当工具来源变成五路（内置/MCP/扩展/
动态/托管）、可见性变成三态（Direct/Deferred/CodeMode）、执行需要审批与沙箱时，
「一张表」会逼迫你把所有维度塞进同一个 entry 结构体，每加一个维度就改一遍所有
工具的注册代码。Codex 的拆法是：

- `ToolExecutor` trait 只规定最小契约（名字、spec、exposure、handle），横切关注点
  （hooks、遥测、生命周期）由 registry 的 dispatch 主干统一织入；
- 可见性从「在不在列表里」升级为 `ToolExposure` 枚举，由 `build_model_visible_specs`
  集中过滤，而不是各个工具自己决定要不要出现在列表；
- 安全决策不进路由层，由 `ToolOrchestrator` 以泛型包住需要它的 runtime。

对 my-agent 的直接借鉴：**先拆 spec 与 execute 两个字段的演进路径**——让 schema
由 handler 对象上的方法产出（Codex 的 `spec()`），而不是两处各写一份；再给路由
表加一层「可见性/来源」元数据，而不是布尔 `enabled`。这两步不需要 Rust，也不需要
 trait，TS 里一个 interface 就能落地，却能把后续加 MCP、加延迟加载时的改动面压住。

**为什么工具清单每步重建，而不是会话启动时注册一次？**

代价是显然的：每个 step 都重跑一遍注册逻辑、重算 spec。换来的是正确性的简化——
MCP 服务器中途上下线、guardian 模式切换、feature flag 变更，都不需要「增量更新
工具列表」这种极易出 bug 的逻辑；`McpHandlerCache`（mcp_tool_exposure.rs:26-71）
用缓存把重复构建 spec 的成本压掉了。这是典型的「用不可变重建换状态一致性」，
和[第 8 章](ch08-context-compact.md)上下文管理里「全量重发历史」是同一种哲学：宁可重算，不维护易错的增量。

**冲突处理的双通道：trusted vs external。**

`ToolRegistry` 注册分两个等级（registry.rs:302-372）：内置工具走
`register_trusted*`，重名直接 `error_or_panic`——内置工具撞名是程序 bug，应该
炸在开发期；外部工具（MCP、动态、扩展）走 `register_external*`，重名只是
`tracing::warn!` 跳过并记录 `first_collision`，可选地在
`error_on_tool_collisions` 开启时升级为错误。外部世界不可信、不可控，同名工具
（两个 MCP 服务器都暴露 `search`）必须优雅降级而不是崩掉整个回合。这个「对自己
人严格、对外部宽容」的不对称，很值得抄进任何要接插件的系统。

**Deferred 与 tool_search：上下文经济学的阀门。**

MCP 生态的工具数量可以轻松破百，每个 schema 都是几百 token。Codex 的答案是
`ToolExposure::Deferred`：工具注册进 registry 但不进初始列表，模型通过
`tool_search` 工具按需「搜索并加载」schema（`mcp_tool_to_deferred_responses_api_tool`
等，配合 spec_plan.rs:335-370 的 tool_search 注册逻辑）。这是把「工具发现」本身
变成一个工具的思路，代价是多一次模型往返。局限也很坦诚：依赖模型会正确使用
搜索工具，小模型上效果会打折——所以 `search_tool_enabled` 要同时看模型能力与
provider 能力（spec_plan.rs:578-580）。

**局限与演进方向。** 这套系统也有明显的历史负担：`ToolInvocation.turn` 字段旁挂着
TODO 注释（context.rs:58）说明 handler 尚未完全迁移到 `step_context`；
`flat_tool_name()`（mod.rs:39-53）的存在说明扁平命名与命名空间命名还在共存过渡；
orchestrator.rs 单文件 553 行、retry 分支层层嵌套，可读性已经在报警。这些都是
「真实生产代码」的常态，读源码时不必假设现状即终态。

## 动手实验

以下命令都在仓库根目录执行，只涉及只读操作与日志观察。

**1. 枚举全部内置工具的注册点**（预期输出：`registry.add(...)` 调用清单，约 20+ 行，
每行一个 handler 类型）：

```shell
rg -n "registry\.(add|add_with_exposure|register_trusted)" codex-rs/core/src/tools/spec_plan.rs
```

对照输出数一数：哪些注册被 `features.enabled(...)` 包裹？哪些是 unconditional 的？
这就是「模型看到的工具列表」的全部决策来源。

**2. 找出所有实现了执行契约的 handler**（预期输出：每个 handler 文件里的
`impl ToolExecutor<ToolInvocation>` 行，20+ 个）：

```shell
rg -ln "impl ToolExecutor<ToolInvocation>" codex-rs/core/src/tools/handlers/
```

随便挑一个没读过的（比如 `sleep.rs` 或 `current_time.rs`），验证它的结构是否与
4.3 节的三个样本同构：`tool_name()` + `spec()` + `handle()`。

**3. 观察运行时工具调用日志**（需要能联网调用模型）：

```shell
cd codex-rs
RUST_LOG=codex_core=info cargo run --bin codex -- exec "list files in this directory, then tell me the count"
```

预期输出形态：stderr 里能看到 `ToolCall: exec_command {...}` 的信息行
（来自 stream_events_utils.rs:309-314 的 `tracing::info!`），以及每条工具调用结束
时的 `event.name="codex.tool_call"` 结构化日志，带
`dispatch_duration_ms`/`handler_duration_ms` 两个耗时（来自 parallel.rs 的
`ToolCallTimingGuard`）。比较两者之差，就能直观看到并行门闸让工具排队等了多久。

**4. 观察沙箱拒绝在 exec 下的直接失败形态**（接上一条）：

```shell
RUST_LOG=codex_core=info cargo run --bin codex -- exec --sandbox read-only \
  "write a file named hello.txt containing hi, then read it back"
```

预期形态：写入命令在沙箱内被 `SandboxErr::Denied` 拦下后**不会**有任何审批弹窗——
exec 无头模式默认 `AskForApproval::Never`（exec/src/lib.rs:406-434），而
`wants_no_sandbox_approval` 对 `Never`/`OnRequest` 都返回 `false`
（sandboxing.rs:330-337），于是 orchestrator.rs:366-389 的分支直接把沙箱拒绝
作为工具错误回给模型，由模型自己决定下一步。想看「command failed; retry
without sandbox?」的升级追问，得去 TUI 的未受信目录（`UnlessTrusted` 策略）
里触发，完整步骤见第 11 章实验 3。

## Rust 侧栏

- **`Box<dyn Trait>` 与 `Arc<dyn Trait>`**：`ToolOutput`、`CoreToolRuntime` 都是
  trait object。`Box<dyn ToolOutput>` 让不同 handler 返回不同类型的结果而统一收纳；
  `Arc<dyn CoreToolRuntime>` 让 registry 持有可能被多个并行任务共享的执行器。
  代价是动态分发与不能 downcast 的约束——换来异构集合的便利。
- **类型别名收敛复杂签名**：`ToolExecutorFuture<'a>`（tool_executor.rs:10-12）把
  `Pin<Box<dyn Future<Output = ...> + Send>>` 这坨类型起个名字。Rust 的 async fn
  在 trait 里返回匿名 Future 类型，需要跨 trait object 边界时必须手动 box 成这种
  形态；起别名是所有调用点的救命稻草。
- **`bitflags!` 宏**：`ToolExposures`（tool_executor.rs:14-29）用位标志把
  DIRECT/DEFERRED/CODE_MODE 三个布尔维压进一个 `u8`，支持 `|`、`contains`、
  `difference` 等集合运算。适合「少量开关的组合」场景，比三个 bool 字段紧凑且
  可比较。
- **`IndexMap` 与 Entry API**：registry 用 `IndexMap`（registry.rs:272）保序——
  注册顺序即模型看到的工具顺序（对 prompt cache 友好）；`match self.tools.entry(...)`
  的 `Vacant`/`Occupied` 分叉（registry.rs:313-321）是 Rust 标准 Entry 模式：
  一次查表同时完成「在不在」与「插入」，避免二次哈希。
- **`Cow<'_, str>`（写时克隆）**：`flat_tool_name()`（mod.rs:39-53）对默认命名空间
  直接借用原字符串（`Cow::Borrowed`），只有带命名空间时才分配新串
  （`Cow::Owned`）。热路径上的零分配优化，语义由借用检查器保证。

## 小结 + 思考题

本章拆开了 Agent Loop 里的「工具」方框：模型看到的列表由 `spec_plan.rs` 按来源
（内置/MCP/扩展/动态/托管）每步重建、按 `ToolExposure` 过滤；模型返回的 tool_use
经 `ToolRouter::build_tool_call` 解析成 `ToolCall`，由 registry 的 dispatch 主干
织入 hooks 与遥测后路由到实现 `ToolExecutor` 的 handler；审批与沙箱不在路由层，
而在 handler 内部的 `ToolOrchestrator` 里按「审批 → 沙箱 → 尝试 → 提权重试」
统一收口；并行由 `parallel_tool_calls: true` + `FuturesOrdered` + 一把区分
read/write 的门闸实现。spec 与 handler 同属一个对象但各司其职，是整套系统最值得
带走的设计。

思考题：

1. `build_tool_call` 对未知工具名返回 `RespondToModel` 错误而不是让回合失败。
   如果改成「回合直接报错」，模型的行为会发生什么变化？结合[第 4 章](ch04-auth-model.md)的全量重发
   历史，哪种设计对 prompt cache 更友好？
2. `ExecCommandHandler::supports_parallel_tool_calls()` 返回 `true`，而
   `apply_patch` 没有覆写该方法（默认 `false`）。如果 apply_patch 也声明可并行，
   可能出什么乱子？门闸的 `RwLock` 语义能挡住吗？
3. 假如要给 my-agent 加 MCP 支持：沿用 Codex 的思路，你的「工具表」最小改动是
   什么？（提示：让表项的 schema 由一个方法产出，执行体统一收
   `(name, argsJson)`。）
4. `ToolExposure::Deferred` 把工具发现做成了工具（`tool_search`）。到
   `spec_plan.rs:335-370` 读 tool_search 的注册条件，回答：什么情况下一个已注册
   的工具对模型既不可见也搜不到？这是 bug 还是特性？
