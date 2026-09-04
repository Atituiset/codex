# 第 10 章 Shell 执行与 apply_patch

## 本章导读

[第 9 章](ch09-tools.md)把工具系统拆到了「handler 骨架」这一层：`exec_command` 的 spec
长什么样、`ApplyPatchHandler` 如何声明自己只接受 freeform 载荷、审批与沙箱在
`ToolOrchestrator` 的哪个点拦截。本章往下再走一层，回答两个非常具体的问题：

1. **模型发来一个字符串命令，内核如何把它变成一个真实进程，并把它的输出安全地
   带回来？** 这中间有一长串隐形工序：把 `cmd` 包成 `bash -lc` 的 argv、经编排器
   过审批与沙箱、开 PTY 起进程、流式捕获 stdout/stderr、用双端缓冲防止内存爆炸、
   按 token 预算截断、把 exit code 和「进程还在跑，会话 ID 是多少」一并报告给模型。
   你自己写 my-agent 时大概率用 `child_process.exec` 加 `.slice(0, N)` 就完事了——
   读完本章你会知道那一刀切掉的是什么。
2. **为什么 Codex 不让模型直接写文件，而是发明了一种 `apply_patch` 补丁格式？**
   这是一种专门为「模型生成」设计的文本格式：不用 JSON 转义、不用精确行号、允许
   模糊匹配。它的解析器是一个逐行的流式状态机，应用算法靠四级递进宽松的序列匹配
   定位插入点。更有意思的是，它有两条进入路径——模型可以直接调 `apply_patch` 工具，
   也可以在 shell 里敲 `apply_patch <<'EOF' ...`，后者会被内核**拦截**下来走同一条
   验证与审批管线。

本章刻意不碰的部分：沙箱三平台实现与审批 UI 流转留给[第 11 章](ch11-sandbox-approval.md)；
spec 生成与工具注册留给[第 9 章](ch09-tools.md)。这里只讲「执行体」。

## 源码地图

Shell 执行一侧横跨三个 crate；apply_patch 一侧是一个独立 crate 加 core 里的薄集成层：

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-rs/core/src/tools/handlers/unified_exec.rs` | `ExecCommandArgs` 参数结构与 `get_command()` | handler 模块的共享根部 |
| `codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs` | `exec_command` handler 主体 | 参数解析 → 拦截补丁 → 交给进程管理器 |
| `codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs` | `write_stdin` handler | 长驻进程的「继续读输出 / 喂输入」通道 |
| `codex-rs/core/src/unified_exec/process_manager.rs` | `UnifiedExecProcessManager`：编排、进程表、输出收集 | 本章 shell 侧的重心，1621 行 |
| `codex-rs/core/src/unified_exec/process.rs` | `UnifiedExecProcess`：PTY 进程句柄与输出任务 | 本地 PTY 与远程 exec-server 的统一封装 |
| `codex-rs/core/src/unified_exec/head_tail_buffer.rs` | `HeadTailBuffer`：保头保尾丢中间的定容缓冲 | 防 OOM 的第一道闸门 |
| `codex-rs/core/src/unified_exec/async_watcher.rs` | 输出流式转发为 `ExecCommandOutputDelta` 事件 | TUI 实时滚动就靠它 |
| `codex-rs/core/src/exec.rs` | 非 PTY 的经典管道执行路径（`process_exec_tool_call`） | app-server 命令执行与提权 helper 仍在用 |
| `codex-rs/core/src/command_canonicalization.rs` | 审批缓存键的命令规范化 | 只有 42 行，但解决了一个真实痛点 |
| `codex-rs/shell-command/src/bash.rs` | tree-sitter 解析 `bash -lc` 脚本 | 规范化与安全分析的共同地基 |
| `codex-rs/shell-command/src/parse_command.rs` | `parse_command`：给用户看的命令摘要 | 注释自嘲「DO NOT REVIEW BY HAND」 |
| `codex-rs/core/src/tools/context.rs` | `ExecCommandToolOutput` 与模型侧截断 | 输出回给模型前的最后一道工序 |
| `codex-rs/utils/output-truncation/src/lib.rs` | `truncate_text` 等截断原语 | 独立小 crate，token 估算在这里 |
| `codex-rs/apply-patch/src/parser.rs` | 补丁文本 → `Hunk` 列表 | 模块头的 Lark 文法注释就是格式定义 |
| `codex-rs/apply-patch/src/streaming_parser.rs` | 逐行流式状态机解析器 | 解析与 TUI 边收边渲染共用 |
| `codex-rs/apply-patch/src/seek_sequence.rs` | 四级宽松度的序列定位算法 | 全 crate 最精巧的 100 行 |
| `codex-rs/apply-patch/src/file_update.rs` | 由 chunks 推导文件新内容、生成 unified diff | 纯函数，不碰文件系统写入 |
| `codex-rs/apply-patch/src/invocation.rs` | 识别 argv 是否为 apply_patch 调用（含 heredoc） | 拦截器的识别引擎，tree-sitter 第二次登场 |
| `codex-rs/apply-patch/src/lib.rs` | `apply_hunks_to_files`：把 hunk 落到文件系统 | 附带「已提交变更」delta 追踪 |
| `codex-rs/apply-patch/src/standalone_executable.rs` | 独立进程入口 `main()` | helper 进程模式的另一半 |
| `codex-rs/core/src/tools/handlers/apply_patch.rs` | core 侧 handler + `intercept_apply_patch` | 两条进入路径在这里汇合 |
| `codex-rs/core/src/apply_patch.rs` | `prepare_apply_patch`：安全评估 → 审批需求 | 评估逻辑本身在 `safety.rs`，Ch11 展开 |
| `codex-rs/core/src/tools/runtimes/apply_patch.rs` | `ApplyPatchRuntime`：编排器眼里的补丁执行体 | `escalate_on_failure() → true` |

## 核心数据结构

### ExecCommandArgs：模型填的那张表

`exec_command` 是 JSON Schema 函数工具，模型填写的参数反序列化进这个结构
（handlers/unified_exec.rs:27-48）：

```rust
// 来源：codex-rs/core/src/tools/handlers/unified_exec.rs:27-48
#[derive(Debug, Deserialize)]
pub(crate) struct ExecCommandArgs {
    pub(crate) cmd: String,                       // ← 唯一必填：一段 shell 脚本字符串
    #[serde(default)]
    shell: Option<String>,                        // ← 模型可指定 shell 路径（Direct 模式）
    #[serde(default)]
    login: Option<bool>,                          // ← 是否 login shell（受配置约束）
    #[serde(default = "default_tty")]
    tty: bool,                                    // ← 默认 false
    #[serde(default = "default_exec_yield_time_ms")]
    yield_time_ms: u64,                           // ← 默认 10_000：等多久就返回快照
    #[serde(default)]
    max_output_tokens: Option<usize>,             // ← 模型可自限输出预算
    #[serde(default)]
    sandbox_permissions: Option<SandboxPermissions>,
    #[serde(default)]
    additional_permissions: Option<AdditionalPermissionProfile>,
    #[serde(default)]
    justification: Option<String>,                // ← 要提权时给用户的理由
    #[serde(default)]
    prefix_rule: Option<Vec<String>>,
}
```

注意 `cmd` 是**字符串**而不是数组。内核要自己决定用什么 shell、拼什么参数来执行
它——这就是 4.1 节 `get_command()` 的工作。`yield_time_ms` 与 `max_output_tokens`
两个参数暴露给模型，意味着「等多久」和「要多少输出」是模型可调的旋钮，默认值
（10 秒、10_000 token）只是兜底。

### ExecCommandToolOutput：一次执行的全部产出

执行结果在回给模型之前，先收敛成这个结构（context.rs:310-325）：

```rust
// 来源：codex-rs/core/src/tools/context.rs:310-325
#[derive(Debug, Clone, PartialEq)]
pub struct ExecCommandToolOutput {
    pub event_call_id: String,
    pub chunk_id: String,                        // ← 输出的分块标识，供 UI 对齐流式片段
    pub wall_time: Duration,
    /// Raw bytes returned for this unified exec call before any truncation.
    pub raw_output: Vec<u8>,                     // ← 原始字节，截断发生在序列化时
    pub truncation_policy: TruncationPolicy,     // ← 模型信息里带的默认截断策略
    pub max_output_tokens: Option<usize>,        // ← 本次调用的覆盖预算
    pub process_id: Option<i32>,                 // ← Some = 进程还活着，可 write_stdin
    pub exit_code: Option<i32>,                  // ← Some = 进程已退出
    pub original_token_count: Option<usize>,
    /// Bytes omitted by the output collection cap before model-facing truncation.
    pub output_omitted_bytes: Option<NonZeroUsize>, // ← 收集阶段就丢掉的中段字节数
    pub hook_command: Option<String>,
}
```

两个 `Option` 字段编码了进程状态机：`process_id.is_some()` 表示命令还没跑完、返回
的是一个可继续交互的会话句柄；`exit_code.is_some()` 表示已经结束。也可能两者皆空
——被拦截的补丁调用没有任何进程。而
`raw_output` 存原始字节、截断策略随行携带——**截断不在收集时做，而在「给模型看」
时做**，这样遥测日志（`log_output`）能看到比模型更完整的输出。

### Hunk 与 UpdateFileChunk：补丁的解析产物

apply_patch 的格式（4.4 节详述）解析出来是一组 `Hunk`
（apply-patch/src/parser.rs:66-82）：

```rust
// 来源：codex-rs/apply-patch/src/parser.rs:66-82
pub enum Hunk {
    AddFile {
        path: PathBuf,
        contents: String,
    },
    DeleteFile {
        path: PathBuf,
    },
    UpdateFile {
        path: PathBuf,
        move_path: Option<PathBuf>,              // ← "*** Move to:" 重命名目标

        /// Chunks should be in order, i.e. the `change_context` of one chunk
        /// should occur later in the file than the previous chunk.
        chunks: Vec<UpdateFileChunk>,            // ← 一个文件内的多处修改，按位置有序
    },
}
```

真正承载「改哪里」语义的是 `UpdateFileChunk`（parser.rs:114-132）：

```rust
// 来源：codex-rs/apply-patch/src/parser.rs:114-132
#[derive(Debug, Default, PartialEq, Clone)]
pub struct UpdateFileChunk {
    /// A single line of context used to narrow down the position of the chunk
    /// (this is usually a class, method, or function definition.)
    pub change_context: Option<String>,          // ← "@@ fn foo():" 提供的定位锚点

    /// A contiguous block of lines that should be replaced with `new_lines`.
    pub old_lines: Vec<String>,                  // ← 待替换的旧行（来自 "-" 与上下文行）
    pub new_lines: Vec<String>,                  // ← 替换后的新行（来自 "+" 与上下文行）

    /// Pairs of indices into `old_lines` and `new_lines` that identify lines
    /// parsed as context rather than inferred to be equal by their contents.
    pub context_line_indices: Vec<(usize, usize)>, // ← 显式上下文行在两侧的下标对

    /// If set to true, `old_lines` must occur at the end of the source file.
    pub is_end_of_file: bool,                    // ← "*** End of File" 锚定文件末尾
}
```

这里能看到格式的核心设计：**没有行号**。模型不需要知道「第 47 行」，只需要给出
一小段它记得的旧文本（`old_lines`）和一个可选的上文锚点（`change_context`），
由内核去文件里找。找的过程（`seek_sequence`）允许模糊匹配——这是 apply_patch 与
标准 unified diff 最本质的区别，也是它对模型友好的根源。

### ApplyPatchAction：验证后的补丁

解析（parse）只检查文本格式；**验证（verify）**会把 hunk 对着真实文件系统展开，
算出每个文件的确切变更（apply-patch/src/lib.rs:159-205，删节）：

```rust
// 来源：codex-rs/apply-patch/src/lib.rs:159-205（有删节）
pub enum ApplyPatchFileChange {
    Add { content: String },
    Delete { content: String },                  // ← 验证时已把旧内容读出来备好
    Update {
        unified_diff: String,                    // ← 验证时预生成的标准 diff（展示用）
        move_path: Option<PathUri>,
        /// new_content that will result after the unified_diff is applied.
        new_content: String,                     // ← 替换后的完整新内容
    },
}

/// ApplyPatchAction is the result of parsing an `apply_patch` command. By
/// construction, all paths should be absolute paths.
pub struct ApplyPatchAction {
    changes: HashMap<PathUri, ApplyPatchFileChange>, // ← 全部路径已解析为绝对路径
    update_file_mode: ApplyPatchFileUpdateMode,
    /// The raw patch argument that can be used to apply the patch.
    pub patch: String,                           // ← 原始补丁文本，执行阶段按它重放
    /// The working directory that was used to resolve relative paths in the patch.
    pub cwd: PathUri,
}
```

「验证」与「执行」分离是这个数据结构存在的理由：验证阶段算出 `new_content` 和
`unified_diff`（用于审批弹窗里给用户展示 diff），执行阶段再按 `patch` 原文重放。
中间隔着审批——用户看到的就是将要发生的，而不是模型声称要发生的。

## 流程走读

### 4.1 从 `cmd` 字符串到进程：exec_command 的执行链路

先把整链路画出来（审批与沙箱节点只标位置，实现留给[第 11 章](ch11-sandbox-approval.md)）：

```
模型输出 FunctionCall { name: "exec_command", arguments: {...} }
   │
   ▼ ToolRegistry 分发（Ch9）
ExecCommandHandler::handle_call()（exec_command.rs:108-413）
   │
   ├─ 解析 ExecCommandArgs；按 environment 解析 workdir/cwd
   ├─ get_command()：cmd 字符串 → ["bash","-lc", cmd] argv
   ├─ intercept_apply_patch()：这条命令是不是伪装的补丁？
   │      ├─ 是 → 走 apply_patch 管线（4.4），本次不起进程
   │      └─ 否 → 继续
   ▼
UnifiedExecProcessManager::exec_command()（process_manager.rs:468-756）
   │
   ├─ open_session_with_sandbox()（process_manager.rs:1224-1330）
   │     │  组装 env（UNIFIED_EXEC_ENV 十项固定变量）
   │     ▼  ToolOrchestrator::run()（审批 → 选沙箱 → 尝试，Ch11）
   │     UnifiedExecRuntime::run()
   │     ▼
   │  open_session_with_prepared_exec_env()（process_manager.rs:1112-1222）
   │     ├─ 远程环境 → exec-server backend.start()
   │     └─ 本地     → codex_sandboxing::spawn_process() 起 PTY
   ▼
UnifiedExecProcess（process.rs）：输出任务持续把 PTY 字节灌进 HeadTailBuffer
   │
   ▼ collect_output_until_deadline()：等到 yield_time_ms 或进程退出
ExecCommandToolOutput { process_id? exit_code? raw_output }
   │
   ▼ to_response_item()：截断 + 头部元信息 → FunctionCallOutput
```

**第一步，参数与环境。** `handle_call()`（exec_command.rs:108-196）的前 90 行都在
做「解析」：拆 JSON 参数、按 `environment_id` 选出目标环境（本地或远程
exec-server）、把 `workdir` 拼到环境 cwd 上。对本地环境还要求 cwd 能转成宿主机
原生路径——因为沙箱权限配置里的路径匹配要在原生路径上做。

**第二步，命令数组化。** `get_command()`（handlers/unified_exec.rs:97-142）把
`cmd` 字符串包成 argv。两种模式：`Direct` 下用模型指定的 shell 或会话默认 shell，
经 `Shell::derive_exec_args()`（shell.rs:22-49）拼出经典三元组；`ZshFork`（一种
本地加速模式）下强制 zsh 且不允许模型换 shell，直接构造
`[zsh_path, "-lc"|"-c", cmd]`。前者的实现：

```rust
// 来源：codex-rs/core/src/shell.rs:22-31（删节）
pub fn derive_exec_args(&self, command: &str, use_login_shell: bool) -> Vec<String> {
    match self.shell_type {
        ShellType::Zsh | ShellType::Bash | ShellType::Sh => {
            let arg = if use_login_shell { "-lc" } else { "-c" };
            vec![
                self.shell_path.to_string_lossy().to_string(),
                arg.to_string(),
                command.to_string(),
            ]
        }
        // PowerShell → -NoProfile -Command；Cmd → /c（删节）
```

所以模型写的 `cargo test` 实际变成 `["/bin/zsh", "-lc", "cargo test"]`。
**记住这个 argv 形态**，4.3 节的规范化和 4.4 节的补丁拦截都要先认出它。

**第三步，补丁拦截。** 在真正分配进程之前，handler 先做一件事
（exec_command.rs:321-354）：把拼好的 argv 交给 `intercept_apply_patch()`。如果
这条命令其实是 `apply_patch <<'EOF' ...` 的 shell 包装，就**不起任何进程**，直接
转入 apply_patch 管线（4.4），把补丁文本作为工具输出返回。拦截返回
`Ok(None)`（不是补丁）才继续往下走。注意 handler 还预留了 `process_id`
（exec_command.rs:237），拦截成功时要 `release_process_id` 归还——进程号是先占坑
后使用的。

**第四步，进程管理器接管。** `UnifiedExecProcessManager::exec_command()`
（process_manager.rs:468-756）先调 `open_session_with_sandbox()`
（process_manager.rs:1224-1330）：组装环境变量——其中十项是写死的
（process_manager.rs:84-95），`NO_COLOR=1`、`TERM=dumb`、`PAGER=cat`、
`GIT_PAGER=cat`、`CODEX_CI=1`……每一条都是踩坑记录（不许工具进交互式分页器、
不许输出 ANSI 颜色），然后进入 `ToolOrchestrator::run()`。编排器内部完成审批判定
与沙箱选择后回调 `UnifiedExecRuntime::run()`，最终落到
`open_session_with_prepared_exec_env()`（process_manager.rs:1112-1222）：远程环境走
exec-server 的 `backend.start()`；本地走 `codex_sandboxing::spawn_process()`
（process_manager.rs:1206-1217）起一个 **PTY** 进程。

为什么是 PTY 而不是管道？因为 exec_command 同时承担「跑一条命令拿结果」和「开一个
可交互终端会话」两种职责（`tty` 参数），很多程序（`git`、`npm`、测试 runner）检测
到 stdout 不是 TTY 会改变行为。统一用 PTY 让两种用法共享同一条代码路径——这就是
「unified」的含义。在本基线里，旧的单发 `shell` 工具已经不复存在：配置枚举
`ConfigShellToolType` 只剩 `UnifiedExec` 和 `Disabled` 两个变体
（protocol/src/openai_models.rs:299-303），`shell_command` 等旧名只是指向
`UnifiedExec` 的 serde 别名。注册侧也只有 `ExecCommandHandler` +
`WriteStdinHandler` 这一对（spec_plan.rs:957-986）。

**第五步，收集与返回。** 进程起来后，管理器做三件看似重复实则分工明确的事
（process_manager.rs:498-578）：

```rust
// 来源：codex-rs/core/src/unified_exec/process_manager.rs:498-578（删节）
let transcript = Arc::new(tokio::sync::Mutex::new(HeadTailBuffer::default()));
// ...
start_streaming_output(&process, context, Arc::clone(&transcript));  // ← 流式事件给 UI
// Persist live sessions before the initial yield wait so interrupting the
// turn cannot drop the last Arc and terminate the background process.
let process_started_alive = !process.has_exited() && process.exit_code().is_none();
// ...还活着就存入进程表（process_id → ProcessEntry）...
let deadline = start + Duration::from_millis(yield_time_ms);
let collected_output = Self::collect_output_until_deadline(           // ← 给模型的快照
    process.output_handles(),
    Some(context.session.subscribe_elicitation_pause_state()),
    deadline,
)
.await;
```

`transcript` 是全量的会话记录（带 1 MiB 上限），供 UI 回放；`collected_output`
是这次工具调用的快照。**关键语义：等待 `yield_time_ms` 到期就返回，而不是等进程
结束。** 到期时进程还活着，就把它留在进程表里（上限 `MAX_UNIFIED_EXEC_PROCESSES =
64`，unified_exec/mod.rs:77），把 `process_id` 写进输出返回给模型；模型后续用
`write_stdin` 工具拿这个 ID 继续读输出或喂按键（write_stdin.rs）。「跑
`npm run dev` 起个服务」因此不会卡死回合——exec_command 十秒后带着
`Process running with session ID 12345` 返回，进程在后台继续跑。

### 4.2 输出处理：流式捕获、双端缓冲与截断

一条 `yes | head -c 1G` 就能把不做防护的 Agent 内存打爆。Codex 的防护是三层叠加：

**第一层：进程侧定容缓冲。** PTY 字节由一个独立任务持续读出（本地路径
`spawn_local_output_task`，process.rs:587-622），每到一个 chunk 同时做两件事：
`push_chunk` 进共享的 `output_buffer`，并向 `broadcast` channel 发一份拷贝。
缓冲区的类型是 `HeadTailBuffer`（head_tail_buffer.rs:11-19）：

```rust
// 来源：codex-rs/core/src/unified_exec/head_tail_buffer.rs:5-19
/// A capped buffer that preserves a stable prefix ("head") and suffix ("tail"),
/// dropping the middle once it exceeds the configured maximum. The buffer is
/// symmetric meaning 50% of the capacity is allocated to the head and 50% is
/// allocated to the tail.
pub(crate) struct HeadTailBuffer<const MAX_BYTES: usize = UNIFIED_EXEC_OUTPUT_MAX_BYTES> {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    omitted_bytes: usize,
}

impl<const MAX_BYTES: usize> HeadTailBuffer<MAX_BYTES> {
    const HEAD_BUDGET: usize = MAX_BYTES / 2;
    const TAIL_BUDGET: usize = MAX_BYTES.saturating_sub(Self::HEAD_BUDGET);
```

容量上限 `UNIFIED_EXEC_OUTPUT_MAX_BYTES = 1 MiB`（unified_exec/mod.rs:75）。`push_chunk`
（head_tail_buffer.rs:45-48）先填满头部 512 KiB，剩余进尾部队列、挤掉最旧字节，
被挤掉的字节数累计进 `omitted_bytes`。为什么保头又保尾？头部有命令的初始报错
（编译错误的第一条），尾部有最终摘要（测试通过率），中段往往是刷屏日志——这正是
「对模型最有信息密度」的取舍。导出时如果丢过字节，就在头尾之间插入一行
`... N bytes omitted ...`（`to_bytes_with_omission_marker`，head_tail_buffer.rs:106-124；
标记文案在 unified_exec/mod.rs:216-218），让模型知道中间有洞。

**第二层：收集窗口。** `collect_output_until_deadline()`
（process_manager.rs:1332-1423）是一个 `tokio::select!` 循环：每到一批输出就
`push_buffer` 合并进本次收集的缓冲；没输出就等 `output_notify` 通知、进程退出信号
或 deadline，先到先得。进程退出后还有一个 50ms 的收尾窗口
（`POST_EXIT_CLOSE_WAIT_CAP`）等管道里残余的字节，避免「进程退了但最后一行没读到」。

**第三层：模型侧截断。** 收集回来的 `raw_output` 最长 1 MiB，直接进上下文还是太
贵。`ExecCommandToolOutput::truncated_output_with_policy()`（context.rs:426-453）
在序列化成 `FunctionCallOutput` 时按预算做中段截断，预算取
`max_output_tokens`（模型自报，默认 `DEFAULT_MAX_OUTPUT_TOKENS = 10_000`，
unified_exec/mod.rs:74）与模型自带 `truncation_policy` 中更小的那个
（`model_output_policy`，context.rs:412-420）。截断原语在
`codex-utils-output-truncation` crate（utils/output-truncation/src/lib.rs:12-30）：

```rust
// 来源：codex-rs/utils/output-truncation/src/lib.rs:12-30
pub fn formatted_truncate_text(content: &str, policy: TruncationPolicy) -> String {
    if content.len() <= policy.byte_budget() {
        return content.to_string();
    }
    let original_token_count = approx_token_count(content);
    let total_lines = content.lines().count();
    let result = truncate_text(content, policy);
    format!(
        "Warning: truncated output (original token count: {original_token_count})\nTotal output lines: {total_lines}\n\n{result}"
    )
}

pub fn truncate_text(content: &str, policy: TruncationPolicy) -> String {
    match policy {
        TruncationPolicy::Bytes(bytes) => truncate_middle_chars(content, bytes),
        TruncationPolicy::Tokens(tokens) => truncate_middle_with_token_budget(content, tokens).0,
    }
}
```

注意又是**中段截断**（`truncate_middle_*`），与 HeadTailBuffer 的保头保尾一脉相承。
token 估算是按字节数近似（约 4 字节一个 token），不跑真 tokenizer——热路径上这是
唯一现实的选择。

最终回给模型的文本由 `response_text()`（context.rs:481-506）拼装：
`response_header()`（context.rs:455-479）先写元信息行——`Chunk ID`、
`Wall time`、`Process exited with code 0` 或 `Process running with session ID N`、
`Original token count`——然后接截断后的 `Output:`。还有一处细节：history 层对完整
响应还有一次预算校验，所以这里预留了头部余量并循环收紧策略，避免「截断过的输出
再被截一次」把警告行吃掉（context.rs:488-503 的注释写明了这点）。

**旁路：流式事件。** 与收集并行，`start_streaming_output()`
（async_watcher.rs:59-79）把 broadcast channel 里的字节按 UTF-8 边界切成
`ExecCommandOutputDelta` 事件推给 UI，每次调用最多 10_000 条 delta
（`MAX_EXEC_OUTPUT_DELTAS_PER_CALL`，exec.rs:83），单条最大 8 KiB
（async_watcher.rs:41）。这就是 TUI 里命令输出逐行滚动的来源（渲染见[第 14 章](ch14-tui.md)）。

**对照：非 PTY 的经典路径。** `core/src/exec.rs` 是另一条更老的执行路径：
`process_exec_tool_call()`（exec.rs:291-311）→ `sandboxing::execute_env` →
`execute_exec_request()` → `exec()`（exec.rs:879-936）。它用 `tokio::process`
加管道而非 PTY，stdout/stderr 各起一个 `read_output` 任务（exec.rs:1079-1133），
每个流只保留前 `EXEC_OUTPUT_MAX_BYTES` 字节（`append_capped` 写满即弃，
exec.rs:814-821），`aggregate_output()`（exec.rs:823-865）合并时
给 stdout 预留 1/3、stderr 2/3 的配额。超时与取消在 `consume_output()`
（exec.rs:940-1077）里用 `tokio::select!` 竞速：超时杀进程组并合成
`128 + 64` 的 exit status（模仿 shell 的 `128 + signal` 约定；相关常量定义在
exec.rs:65-68）。本基线中这条路径主要服务 app-server
的命令执行（app-server/src/command_exec.rs:205）与 zsh-fork 提权 helper；
模型侧工具已统一走 PTY 的 unified exec。两条路径共享同一套截断与沙箱原语，
差异只在「是否需要交互终端」。

### 4.3 命令规范化：审批缓存的稳定键

用户在审批弹窗里选了「本会话总是允许 `npm test`」，五分钟后模型又发出
`cd /repo && npm test`——这两条命令该不该命中同一条缓存？答案取决于怎么定义
「同一条命令」。`canonicalize_command_for_approval()`
（command_canonicalization.rs:14-38，整个文件只有 42 行）就是干这个的：

```rust
// 来源：codex-rs/core/src/command_canonicalization.rs:8-38
/// Canonicalize command argv for approval-cache matching.
///
/// This keeps approval decisions stable across wrapper-path differences (for
/// example `/bin/bash -lc` vs `bash -lc`) and across shell wrapper tools while
/// preserving exact script text for complex scripts where we cannot safely
/// recover a tokenized command sequence.
pub(crate) fn canonicalize_command_for_approval(command: &[String]) -> Vec<String> {
    if let Some(commands) = parse_shell_lc_plain_commands(command)
        && let [single_command] = commands.as_slice()
    {
        return single_command.clone();            // ← bash -lc "npm test" → ["npm","test"]
    }

    if let Some((_shell, script)) = extract_bash_command(command) {
        let shell_mode = command.get(1).cloned().unwrap_or_default();
        return vec![
            CANONICAL_BASH_SCRIPT_PREFIX.to_string(),  // "__codex_shell_script__"
            shell_mode,
            script.to_string(),                   // ← 复杂脚本：原样保留全文
        ];
    }
    // PowerShell 分支与兜底 command.to_vec()（删节）
}
```

三级策略：**能安全拆解就拆成词序列**（`bash -lc "npm test"` → `["npm", "test"]`，
壳的路径差异被抹平）；**拆不动就保留脚本全文**但打上 `__codex_shell_script__`
前缀标记（说明这段文本是脚本不是 argv）；**完全不认识就原样返回**。审批缓存的键
在 `cache_keys()`（tools/approvals.rs:197-215）里由规范化后的命令加上
cwd、tty、沙箱权限等字段组成。

「安全拆解」的判定在 shell-command crate 里，用的是真语法解析而非字符串切分。
`parse_shell_lc_plain_commands()`（bash.rs:124-127）先认出
`bash|zsh|sh -lc|-c <script>` 形态（`extract_bash_command`，bash.rs:106-119），
再用 tree-sitter 把脚本解析成 AST，然后白名单式地遍历
（`try_parse_word_only_commands_sequence`，bash.rs:29-98）：

```rust
// 来源：codex-rs/shell-command/src/bash.rs:34-52（删节）
// List of allowed (named) node kinds for a "word only commands sequence".
// If we encounter a named node that is not in this list we reject.
const ALLOWED_KINDS: &[&str] = &[
    "program", "list", "pipeline",
    "command", "command_name", "word",
    "string", "string_content", "raw_string", "number", "concatenation",
];
// Allow only safe punctuation / operator tokens; anything else causes reject.
const ALLOWED_PUNCT_TOKENS: &[&str] = &["&&", "||", ";", "|", "\"", "'"];
```

只允许「纯单词命令 + 安全连接符」：一旦出现重定向、命令替换、变量展开、括号，
立即放弃拆解、回落到「保留脚本全文」。**宁可不规范化，不可错规范化**——审批缓存
键错了等于静默放行用户没批准过的命令。同一个 crate 里的 `parse_command()`
（parse_command.rs:54-72）则用类似解析为 TUI 生成「这条命令在干什么」的摘要
（`ParsedCommand::Read`/`ListFiles` 等），那是展示层的用途，与安全无关。另外
`shlex_join()`（parse_command.rs:10-13）负责把 argv 拼回可显示字符串，日志和
错误消息里的命令都经它格式化。

### 4.4 apply_patch：从补丁文本到文件变更

现在换到第二条主线。先看格式本身——它有一份正式的 Lark 文法，直接放在 spec 里
发给模型做语法约束（[第 9 章](ch09-tools.md)展示过 spec 侧），文件内容就是完整定义：

```text
// 来源：codex-rs/core/src/tools/handlers/apply_patch.lark
start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
```

与 unified diff 对比着看：没有 `---`/`+++` 文件头、没有 `@@ -1,4 +1,5 @@` 行号区间、
没有 `/index` 哈希。`@@` 后面跟的是**一行任意的上文文本**（通常是函数签名），定位
完全靠内容匹配。三种操作（Add/Delete/Update）加一个移动（Move to），就是一个
Coding Agent 对文件系统的全部写需求。

**解析：逐行流式状态机。** `parse_patch()`（apply-patch/src/parser.rs:145-152）先
校验首尾标记（`*** Begin Patch` / `*** End Patch`，parser.rs:256-274），再把正文
喂给 `StreamingPatchParser`（streaming_parser.rs:21-46）：

```rust
// 来源：codex-rs/apply-patch/src/streaming_parser.rs:21-46
#[derive(Debug, Default, Clone)]
pub struct StreamingPatchParser {
    line_buffer: String,                     // ← 没凑满一行的残余字节
    state: StreamingParserState,
    line_number: usize,
}

#[derive(Debug, Default, Clone, Copy)]
enum StreamingParserMode {
    #[default]
    NotStarted,
    StartedPatch,
    AddFile,
    DeleteFile,
    UpdateFile { hunk_line_number: usize },
    EndedPatch,
}
```

之所以做成「可以反复 `push_delta` 的增量解析器」，是因为模型流式输出补丁文本时
TUI 要边收边渲染 diff 预览（[第 9 章](ch09-tools.md)的 `create_diff_consumer` 挂的就是它）；
`finish()` 时一次性产出 `Vec<Hunk>`。解析错误带着行号回报
（`InvalidHunkError { line_number, .. }`），这个行号会原样进入回给模型的错误
文本——模型能据此自我修正。

解析有一个**宽容模式**（`ParseMode::Lenient`，parser.rs:154-191）：如果整体不是合法
补丁，但长得像 heredoc（首行 `<<EOF`/`<<'EOF'`/`<<"EOF"`，末行 `EOF`），就剥掉
heredoc 外壳再试一次（`check_patch_boundaries_lenient`，parser.rs:232-254）。注释
坦白这是为 gpt-4.1 的已知癖好打的补丁——它爱把补丁包成 heredoc 形式。常量
`PARSE_IN_STRICT_MODE = false`（parser.rs:53）意味着宽容模式对所有模型生效。

**识别：这条 shell 命令是不是补丁？** 4.1 节的拦截点依赖
`maybe_parse_apply_patch()`（invocation.rs:113-138），它识别两种形态：

1. 直接 argv：`["apply_patch", "<patch>"]`（命令名允许 `applypatch` 这个历史拼写，
   invocation.rs:28）；
2. shell 包装：`bash -lc "apply_patch <<'EOF'\n...\nEOF"` 或
   `cd <dir> && apply_patch <<'EOF' ...`。

第二种形态要**从 shell 脚本里精确抠出 heredoc 正文**，字符串处理极不可靠（引号、
转义、嵌套），所以这里第二次请出 tree-sitter（invocation.rs:317-447）：编译一条
带锚点的查询，要求 heredoc 重定向语句是脚本的**唯一顶层语句**，`cd` 与
`apply_patch` 之间必须是 `&&`，`cd` 只能带一个裸词参数——注释（invocation.rs:297-316）
明确说了设计原则是**保守**：匹配不上就当普通 shell 命令放行，绝不错把复杂脚本
当补丁。

识别后还有一个防呆分支：`maybe_parse_apply_patch_verified_with_mode()`
（invocation.rs:160-188）先检查「整个 argv 或整个脚本本身就是一段裸补丁文本」——
这是模型忘了写 `apply_patch` 命令名的常见错误——此时返回
`CorrectnessError(ImplicitInvocation)`，错误文案直接教模型正确姿势：

```rust
// 来源：codex-rs/apply-patch/src/lib.rs:110-114
/// A raw patch body was provided without an explicit `apply_patch` invocation.
#[error(
    "patch detected without explicit call to apply_patch. Rerun as [\"apply_patch\", \"<patch>\"]"
)]
ImplicitInvocation,
```

**验证：对着文件系统预演。** 识别出补丁后，`try_verify_apply_patch_args()`
（invocation.rs:214-295）把每个 hunk 摊开：相对路径拼到 cwd 上、同一文件被多个
hunk 操作要报错、Delete 要真的读到文件内容、Update 要调用
`unified_diff_from_chunks_with_mode()` 算出 `new_content` 和给人看的
`unified_diff`。后者（file_update.rs:256-335）复用同一份替换计算，再用 `similar`
crate 生成标准 diff——**验证阶段就把「改完之后长什么样」完整算出来了**。

**应用算法：定位 → 替换 → 倒序落盘。** 核心在
`derive_new_contents_from_chunks()`（file_update.rs:26-82）→
`compute_replacements()`（file_update.rs:87-221）。对每个 chunk：

1. 有 `change_context` 就先用 `seek_sequence` 找到锚点行，把搜索起点推过去
   （file_update.rs:99-113）；
2. 在锚点之后搜索 `old_lines` 的精确位置（file_update.rs:144-151）；找不到且
   `old_lines` 末尾是空串（文件末尾换行的哨兵）就剥掉再试（file_update.rs:155-170）；
3. 找到则记一条 `(start_idx, old_len, new_lines)` 替换，搜索起点越过这段继续下一个
   chunk——这就是「chunks 必须有序」的实现方式；
4. 找不到就整个补丁失败，错误里带上没匹配到的旧文本（file_update.rs:210-214）。

`seek_sequence()`（seek_sequence.rs:12-115）是全 crate 最精巧的部分：**四级递进
宽松**的序列匹配——先精确匹配，再忽略行尾空白，再忽略两端空白，最后把 Unicode
排版字符（弯引号、各种破折号、不换行空格）归一成 ASCII 再比：

```rust
// 来源：codex-rs/apply-patch/src/seek_sequence.rs:84-99（normalise 函数节选）
fn normalise(s: &str) -> String {
    s.trim()
        .chars()
        .map(|c| match c {
            // Various dash / hyphen code-points → ASCII '-'
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            // Fancy single quotes → '\''
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            // Fancy double quotes → '"'
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            // Non-breaking space and other odd spaces → normal space
            '\u{00A0}' | /* ... */ '\u{3000}' => ' ',
            other => other,
        })
        .collect::<String>()
}
```

为什么需要第四级？模型读代码时看到的 `"…"` 可能是排版引号，它生成补丁时写成
ASCII 直引号；源文件里是 `—`，模型写 `-`。没有这层归一化，这类补丁会全部匹配
失败。文件头注释（seek_sequence.rs:1-11）还记录了防御性特例：空模式返回起点、
模式长于文件直接返回 `None`——后者是 2025 年 4 月修掉的一个真实越界 panic。

所有替换算完后按位置排序，`apply_replacements()`（file_update.rs:225-246）
**倒序**应用——先改文件尾部再改头部，前面的替换不会挪动后面替换的行号。

**落盘与 delta 追踪。** `apply_hunks_to_files()`（lib.rs:470-726）按 hunk 类型执行：
Add 写文件（父目录不存在先递归创建，`write_file_with_missing_parent_retry`，
lib.rs:801-858）；Delete 先快照旧内容再删；Update 写入验证阶段算好的
`new_contents`；带 `move_path` 的 Update 先写新路径再删旧路径。全程维护一个
`AppliedPatchDelta`（lib.rs:245-278）——**已经成功提交的变更清单**，外加一个
`exact` 标志：只要任何一次读写的结果不完全确定（比如写入失败前可能已截断文件），
就把 `exact` 置假。失败后这个 delta 随 `ApplyPatchFailure`（lib.rs:310-336）返回，
上层可以如实告诉模型「前两个文件已经改了，第三个失败」。补丁不是事务，但至少要
**可交代**。成功的输出是固定格式的摘要（`print_summary`，lib.rs:862-877）：

```text
Success. Updated the following files:
A src/new_file.rs
M src/main.rs
D src/old.rs
```

**core 侧的两条进入路径在 handler 汇合。** 直接调工具的路径：
`ApplyPatchHandler::handle_call()`（handlers/apply_patch.rs:366-455）`parse_patch` →
`verify_apply_patch_args_with_mode` → `execute_verified_patch()`。shell 拦截的路径：
`intercept_apply_patch()`（handlers/apply_patch.rs:507-555）→ 同一个
`execute_verified_patch()`（handlers/apply_patch.rs:557-620）。后者把验证产物交给
`prepare_apply_patch()`（core/src/apply_patch.rs:22-61）做安全评估——
`assess_patch_safety()`（safety.rs:26 起）检查所有目标路径是否落在可写根内，产出
`AutoApprove`/`AskUser`/`Reject` 三态；然后 `ToolOrchestrator` 按[第 9 章](ch09-tools.md)
的四步序列驱动 `ApplyPatchRuntime::run()`（runtimes/apply_patch.rs:166-235），在
`FileSystemSandboxContext` 约束下重放补丁原文。这个 runtime 声明了
`escalate_on_failure() → true`（runtimes/apply_patch.rs:118-120）：沙箱把写入挡下
时，编排器会走「问用户要不要无沙箱重试」的提权路径。

**helper 进程模式：PATH 上的 `apply_patch` 是真的能跑的。** 如果拦截器没认出来
（比如模型把 heredoc 写得太花哨），命令会照常起进程执行——此时 shell 在 PATH 上
找到的 `apply_patch` 是什么？[第 2 章](ch02-startup.md)讲过 arg0 分发的 busybox 模式，
这里补上后半段：启动时 codex 会在 `~/.codex/tmp/arg0/` 下建一个会话级临时目录，
里面放着指向 codex 二进制自身的 `apply_patch`（和 `applypatch`）symlink，并把这个
目录 prepend 到 PATH（arg0/src/lib.rs:325-410 的
`prepare_path_entry_for_codex_aliases`）。被以 `apply_patch` 为 argv[0] 唤起时，
`arg0_dispatch()` 直接转入 `codex_apply_patch::main()`
（arg0/src/lib.rs:98-100）。Windows 没有 symlink，退化为按 argv[1] 分发：临时目录里
放的是 `apply_patch.bat`，内容是
`"{exe}" --codex-run-as-apply-patch %*`——这个常量就是
`CODEX_CORE_APPLY_PATCH_ARG1`（apply-patch/src/lib.rs:55），分发实现见
arg0/src/lib.rs:114-155。两种入口最终都落到
`standalone_executable.rs:11-90` 的 `run_main()`：从参数或 stdin 读补丁文本，
以当前目录为 cwd 调 `apply_patch_with_options()`，成功退出码 0、失败 1、用法错 2。
也就是说，**即使拦截完全失效，模型在 shell 里写的 apply_patch 依然能正确工作**——
只是那条路径跑在普通进程沙箱里、享受不到补丁专用的审批与 diff 预览。这是典型的
纵深防御：快捷路径做体验，兜底路径保正确。

## 设计取舍

**为什么发明 apply_patch，而不是给模型一个 `write_file`？** 用你 my-agent 的视角
做实质对比。TS 里最直接的写法是：

```typescript
// my-agent 典型的 write_file 工具
async function writeFile(path: string, content: string) {
  await fs.writeFile(path, content);       // 全量覆盖
  return { ok: true };
}
```

对小文件这没问题，但生产场景会连踩四坑，每一坑都能在 apply_patch 的设计里找到
对应的解法：

1. **全量重写大文件既贵又不可靠。** 改一个 2000 行文件里的 3 行，`write_file`
   要求模型重新输出全部 2000 行——token 开销大，且任何一处记错就静默损坏文件。
   apply_patch 的 Update 只携带 `old_lines`/`new_lines` 片段，输出量与改动大小
   成正比。
2. **行号定位对模型是酷刑。** 标准 diff 的 `@@ -47,3 +47,4 @@` 要求模型精确
   数行，而模型的「行号感」极差。apply_patch 干脆取消行号，用 `@@ fn signature`
   内容锚点 + 四级模糊匹配（`seek_sequence`）定位。你在 my-agent 里完全可以抄这一
   点：实现一个 `seekSequence(lines, pattern)`，先精确后 trim 再归一化引号，
   50 行 TS 就能让编辑成功率肉眼可见地上升。
3. **没法审批。** `write_file` 的参数是「最终内容」，审批弹窗要么显示全文（看不
   出改了哪），要么自己再 diff 一遍。apply_patch 的验证阶段顺手产出
   `unified_diff`，审批 UI 拿到的是现成的 diff（`ApplyPatchFileChange::Update`
   里的 `unified_diff` 字段），安全评估还能按路径逐个判断是否落在可写根内
   （`assess_patch_safety`）。
4. **JSON 转义地狱。** 多行代码塞进 JSON 字符串参数，引号、反斜杠、`\n` 层层
   转义，模型极易写错。apply_patch 走 freeform 工具（`ToolPayload::Custom`），
   载荷就是补丁原文，还可以用 Lark 文法在解码层做约束生成——schema 错误这一类
   失败模式被整体消除。

代价也真实存在：多文件补丁不是事务（中途失败留下半成品，靠 `AppliedPatchDelta`
如实上报兜底）；模糊匹配理论上可能定位到错误位置（四级宽松度是把双刃剑，越靠后
的级别越「猜」）；格式是 Codex 私有约定，模型需要训练或提示词才能熟练生成——
这也是为什么 freeform spec 里直接内嵌了 Lark 文法。

**为什么是「拦截」而不是禁止 shell 里的 apply_patch？** 训练数据里模型大量学到
的是 `apply_patch <<'EOF'` 这种 shell 用法，禁掉它等于和模型的肌肉记忆对抗。
拦截的设计让两种写法殊途同归：能认出来就走体验更好的内建管线（审批按补丁粒度、
TUI 有 diff 预览、不付进程启动开销），认不出来还有 PATH 上的 helper 进程兜底。
**对用户可观察行为兼容，对内部实现收编**——这比「报错让模型换一种写法」省心得多，
后者在弱模型上会把回合浪费在格式拉锯上。

**保头保尾 vs 截尾 vs 全量。** my-agent 的 `.slice(0, MAX)` 是截尾：编译错误的
第一条能看到，但「500 个测试只挂了最后 1 个」的摘要在尾部，永远被切掉。
`HeadTailBuffer` 的观察是：命令输出的信息密度呈 U 形分布，中段最没价值。1 MiB
对半分头尾是启发式，不是最优解（Rust 侧栏会提它的 const generics 实现），但
它把「无限增长」变成了「恒定内存 + 信息量最大的 1 MiB」，而且 `omitted_bytes`
计数让模型知道洞有多大，可以决定要不要用 `write_stdin` 再捞。局限是 1 MiB 上限
对超长日志仍然不够——此时正确做法是模型自己加 `| tail -100`，这也是工具描述里
引导的行为。

**`yield_time_ms` 会话模型 vs 同步等待。** 经典 shell 工具（包括 exec.rs 的经典
路径）是同步的：跑完或超时，二选一。unified exec 把它推广成「等 N 毫秒拿快照，
进程不死就发会话 ID」。这让模型能管理长驻进程（dev server、watch 模式的测试），
代价是内核要维护进程表、处理「回合结束了后台进程怎么办」（进程条目里持有
`Weak<Session>` 与退出 watcher，`process_manager.rs` 的 `spawn_exit_watcher` 负责
在进程退出时补发结束事件）。复杂度的增加是实打实的，换来的是「Agent 能起服务再
去 curl 它」这类真实工作流。

**局限与演进方向。** 命令规范化目前只服务审批缓存键，没有参与「这两条命令是否
等价」的更广义判断；`parse_command` 的注释自嘲「DO NOT REVIEW THIS CODE BY HAND」
（parse_command.rs:44-47），说明命令理解的维护成本已经靠测试驱动在硬扛；
apply_patch 的 `PreserveLineEndings` 模式还在 feature flag 后面
（handlers/apply_patch.rs:61-71），CRLF 仓库的默认体验仍是归一化为 LF。读这份
代码时不必假设现状即终态。

## 动手实验

以下命令都在仓库根目录执行；前三个是纯只读源码观察，后两个会实际运行本地二进制
（不需要联网、不需要模型）。

**1. 找到补丁格式的全部标记与解析状态机**（预期输出：`parser.rs` 里 9 个
`const ... &str` 标记常量，以及 `streaming_parser.rs` 的六个 `StreamingParserMode`
变体）：

```shell
rg -n '_MARKER: &str' codex-rs/apply-patch/src/parser.rs
rg -n "enum StreamingParserMode" -A 12 codex-rs/apply-patch/src/streaming_parser.rs
```

对照 4.4 节的文法块，确认每个标记在文法里的位置。

**2. 观察四级模糊匹配的测试用例**（预期输出：`seek_sequence.rs` 尾部测试模块里
rstrip/trim/越界防护三个用例）：

```shell
rg -n "fn test_" codex-rs/apply-patch/src/seek_sequence.rs
```

注意没有第四级（Unicode 归一化）的专门测试——试着给它写一个：`pattern` 里是
ASCII 引号、`lines` 里是 `\u{201C}...\u{201D}`，断言匹配成功。

**3. 追踪命令规范化的消费方**（预期输出：定义在 `command_canonicalization.rs:14`，
唯一非测试调用点在 `tools/approvals.rs:210`）：

```shell
rg -n "canonicalize_command_for_approval" codex-rs/core/src --glob '!*_tests.rs'
```

**4. 亲手跑一次 helper 进程形态的 apply_patch。** argv1 分发路径不需要 symlink，
直接可跑（预期输出形态：`Success. Updated the following files:` 加一行 `A ...`，
退出码 0）：

```shell
mkdir -p /tmp/codex-ch10 && cd /tmp/codex-ch10
cargo run --manifest-path ~/Projects/codex/codex-rs/Cargo.toml --bin codex -- \
  --codex-run-as-apply-patch '*** Begin Patch
*** Add File: hello.txt
+hello from apply_patch
*** End Patch'
echo "exit=$?" && cat hello.txt
```

再观察解析失败的路径——喂一段非法补丁（预期输出：退出码 1，stderr 打印
`Invalid patch: The first line of the patch must be '*** Begin Patch'`，即
`check_start_and_end_lines_strict` 的报错文案）：

```shell
cargo run --manifest-path ~/Projects/codex/codex-rs/Cargo.toml --bin codex -- \
  --codex-run-as-apply-patch 'this is not a patch'
echo "exit=$?"
```

顺带一提：argv1 分发只接受「补丁文本」这一个形态，正文提到的
`ImplicitInvocation` 防呆检查（裸补丁没带命令名）发生在内核拦截路径的 argv 检查里，
helper 进程入口不会经过它——同一段补丁文本，两条路径的报错文案不同，可以对照
4.4 节读。

**5. 找到 PATH 里的 apply_patch 替身。** 启动一次 codex TUI 后另开终端：

```shell
ls -la ~/.codex/tmp/arg0/*/   # 预期：每个会话目录里有 apply_patch/applypatch symlink
```

会话结束后目录被清理——这也解释了为什么 helper 目录要带锁与 janitor 清理
（arg0/src/lib.rs:358-364）。

## Rust 侧栏

- **const generics**：`HeadTailBuffer<const MAX_BYTES: usize = ...>`
  （head_tail_buffer.rs:11）把容量写进类型参数，`HEAD_BUDGET`/`TAIL_BUDGET` 是
  编译期算好的常量，测试可以用小容量实例（`HeadTailBuffer<16>`）复现溢出逻辑而
  不用真的灌 1 MiB。相当于 TS 泛型，但参数是值而不是类型。
- **`broadcast` / `watch` / `Notify` 三件套**：`UnifiedExecProcess` 用
  `broadcast::Sender<Vec<u8>>` 做输出扇出（多个订阅者各收一份，慢订阅者收到
  `Lagged` 错误，process.rs:613），用 `watch::Sender<ProcessState>` 存「最新进程
  状态」（只留最新值，process.rs:96-97），用 `Notify` 做「有新输出了」的
  单次唤醒。三者解决的是三种不同的同步问题，tokio 里选型看「要历史还是只要
  最新」「要数据还是只要信号」。
- **`macro_rules!` 局部宏**：`apply_hunks_to_files` 里的 `try_write!`
  （lib.rs:492-502）把「失败就标记 delta 不精确并提前返回」这段重复逻辑包成宏。
  它捕获了外层变量 `delta`，所以只能定义在使用处附近——这是 Rust 里替代
  「小闭包借用冲突」的常见手法。
- **`LazyLock` 与 tree-sitter `Query`**：`APPLY_PATCH_QUERY`
  （invocation.rs:341-386）用 `static ... = LazyLock::new(|| ...)` 实现首次访问时
  编译查询、之后共享。tree-sitter 查询字符串里的 `#any-of?`/`#eq?` 是谓词断言，
  把「命令名必须是 apply_patch」这类约束写在查询里而不是后处理里。
- **`#[serde(default)]` 家族**：`ExecCommandArgs` 几乎每个字段都有默认值
  （handlers/unified_exec.rs:27-48），`default_exec_yield_time_ms()` 这类函数指针
  形式允许默认值是计算出来的。模型少传参数不会反序列化失败——对「模型是合作但
  不可靠的调用方」这个现实，这是标准防御姿势。

## 小结 + 思考题

本章走完了两条执行链路。Shell 一侧：`cmd` 字符串经 `derive_exec_args` 包成
shell argv，过编排器后在 PTY 里执行，输出经 `HeadTailBuffer` 定容、
`yield_time_ms` 窗口收集、token 预算中段截断后才回给模型，没跑完的进程以
session ID 的形式交给 `write_stdin` 续命。补丁一侧：apply_patch 是一种为模型生成
优化的无行号补丁格式，解析是流式状态机，定位靠四级模糊序列匹配，验证与执行分离
让审批看到真实 diff；shell 里的 `apply_patch` 调用被 tree-sitter 识别并拦截进同一
管线，PATH 上的 arg0 helper 进程则保证拦截失效时行为依然正确。两条链路的共同
主题是：**把模型当作一个聪明但不可靠的调用方——格式上迁就它，安全上不相信它。**

思考题：

1. `intercept_apply_patch` 在 `ShellParseError` 时返回 `Ok(None)` 放行普通执行
   （handlers/apply_patch.rs:549-552），而不是报错给模型。结合 helper 进程的存在，
   解释为什么这是正确选择；如果改成报错，会发生什么？
2. `HeadTailBuffer` 头尾对半分。如果一个命令的关键报错恰好出现在输出的 40% 处
   （中段），模型会看到什么？它能用什么手段自救？（提示：`write_stdin` 的
   `max_output_tokens` 与 transcript 的关系）
3. `seek_sequence` 的四级宽松度里，第四级（Unicode 归一化）会不会导致「补丁打到
   了不该打的位置」？到 `file_update.rs:172-216` 确认替换计算用的是匹配到的原始
   行还是归一化后的行，回答：归一化只影响定位还是也影响内容？
4. 审批缓存键包含规范化后的命令（approvals.rs:207-215）。模型能不能构造两条
   文本不同但规范化后相同的命令，其中一条危险一条安全，从而「骗过」缓存？结合
   `try_parse_word_only_commands_sequence` 的白名单说明为什么难。
