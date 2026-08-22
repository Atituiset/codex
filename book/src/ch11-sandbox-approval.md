# 第 11 章 沙箱与审批安全模型

## 本章导读

到目前为止，本书一直在回答「Agent 怎么运转」；本章回答一个更尖锐的问题：**模型生成的任意命令，凭什么能在你的机器上跑？**

把 Agent Loop（[第 7 章](ch07-agent-loop.md)）剥到底，它做的事情是把一个概率模型的输出直接接到 `exec` 上。模型可能被提示注入污染、可能误判、可能单纯幻觉出一条 `rm -rf`。一个生产级 Coding Agent 必须在这条通路上放闸门，而且要回答三个层层递进的问题：

1. **跑不跑？** —— 命令是否需要用户审批（approval），还是直接放行、直接拒绝；
2. **怎么跑？** —— 决定跑之后，用哪种操作系统级沙箱（sandbox）把它关进笼子：macOS 的 seatbelt、Linux 的 bubblewrap + seccomp、Windows 的 restricted token；
3. **失败了怎么办？** —— 沙箱把一条本来无害的命令拦下了（比如构建工具要写一个没料到的目录），如何优雅地升级到「问用户：要不要放它出笼子跑」。

[第 9 章](ch09-tools.md)已经定位了拦截点：不在路由层，而在 handler 内部的 `ToolOrchestrator`，以「审批 → 选沙箱 → 尝试 → 失败后提权重试」的固定序列包住工具执行。本章把这个黑盒完全拆开：审批策略（`AskForApproval`）如何与 execpolicy 规则引擎协同完成「受信/未受信」判定；沙箱拒绝后如何升级为一次带上下文的审批请求；审批事件如何在内核与 UI 之间往返；以及三套平台机制如何被压进同一个 `SandboxManager` 抽象。

这一章也是全书「为什么用 Rust 写 Agent」的最佳注脚：seccomp 过滤器、Landlock 规则集、Windows ACL/令牌操作，这些都不是 TypeScript 运行时够得着的东西。

## 源码地图

| 文件 | 职责 | 一句话点评 |
|------|------|-----------|
| `codex-rs/protocol/src/protocol.rs` | `AskForApproval` / `SandboxPolicy` / `ReviewDecision` 定义 | 策略与决定的协议层形状，Ch5 已讲类型，本章讲流转 |
| `codex-rs/protocol/src/models.rs` | `SandboxPermissions`（模型可声明的提权意图） | 模型自己说「这条命令要出沙箱」 |
| `codex-rs/core/src/tools/orchestrator.rs` | `ToolOrchestrator`：审批 + 沙箱 + 提权重试 | 本章主战场，`run()` 在 125-534 行 |
| `codex-rs/core/src/tools/sandboxing.rs` | `ToolRuntime`/`SandboxAttempt`/`ExecApprovalRequirement`/审批缓存 | orchestrator 与具体 runtime 之间的契约 |
| `codex-rs/core/src/tools/approvals.rs` | `Session::request_approval`：审批执行与审查者路由 | hooks → guardian → user 的优先级在这里 |
| `codex-rs/core/src/exec_policy.rs` | `ExecPolicyManager`：规则加载、求值、未命中启发式 | execpolicy 在 core 侧的接入层 |
| `codex-rs/core/src/exec_policy/executable_identity.rs` | 剥掉 `bash -lc` 外壳再求值 | 「内层命令能加限制，不能给外壳授权」 |
| `codex-rs/execpolicy/` | 独立 crate：starlark 规则解析与前缀匹配引擎 | 自带 `codex-execpolicy check` CLI，可离线玩 |
| `codex-rs/sandboxing/` | `SandboxManager`：三平台统一抽象 + seatbelt/landlock 参数构造 | 「沙箱即 argv 改写」的落点 |
| `codex-rs/linux-sandbox/` | `codex-linux-sandbox` 辅助二进制：bwrap + seccomp | 真正施加隔离的进程 |
| `codex-rs/windows-sandbox-rs/` | Windows restricted token / ACL / WFP | crate 名 `codex-windows-sandbox`，全部 `cfg(windows)` |
| `codex-rs/network-proxy/` | 托管出网代理（HTTP/SOCKS5 + MITM） | 网络维度的「沙箱」，本章概述 |
| `codex-rs/core/src/session/mod.rs` | `request_command_approval`：oneshot 挂起 + 发事件 | 审批的「等用户」在这里 |
| `codex-rs/core/src/session/handlers.rs` | `Op::ExecApproval` 回收决定 | 事件环路闭环处 |

## 核心数据结构

### 审批策略：`AskForApproval`

用户在配置里选的是「多愿意被打扰」的一档（配置加载见[第 3 章](ch03-config.md)）：

```rust
// 来源：codex-rs/protocol/src/protocol.rs:924-947（节选注释）
pub enum AskForApproval {
    /// Internal policy for projects marked untrusted. Commands require
    /// approval unless an explicit exec policy rule allows them.
    UnlessTrusted,       // ← 未受信项目：规则没放行的都要问

    /// The model decides when to ask the user for approval.
    #[default]
    OnRequest,           // ← 默认：沙箱能兜住的不问，模型可主动请求

    /// Fine-grained controls for individual approval flows.
    Granular(GranularApprovalConfig), // ← 按审批类别单独开关

    /// Never ask the user to approve commands.
    Never,               // ← 永不询问，失败直接回给模型（CI 场景）
}
```

注意一个反直觉点：`OnRequest` 的语义不是「每次问」，而是「**默认不问，靠沙箱兜底；模型认为需要越权时才请求**」。真正的逐条确认模式是 `UnlessTrusted`。

### 模型的提权意图：`SandboxPermissions`

工具调用请求里，模型可以声明这条命令的权限需求：

```rust
// 来源：codex-rs/protocol/src/models.rs:51-60
pub enum SandboxPermissions {
    /// Run with the turn's configured sandbox policy unchanged.
    #[default]
    UseDefault,                  // ← 老老实实待在沙箱里
    /// Request to run outside the sandbox.
    RequireEscalated,            // ← 模型主动要求出沙箱（必然触发审批）
    /// Request to stay in the sandbox while widening permissions for this
    /// command only.
    WithAdditionalPermissions,   // ← 不出沙箱，但本次放宽一点
}
```

这把「信任」变成了一个显式协商过程：模型声明意图，策略引擎裁决，而不是模型闷头执行。

### 静态判定的产出：`ExecApprovalRequirement`

第一关（规则求值）的输出是三态枚举，[第 9 章](ch09-tools.md)已经露过面，这里给出完整定义：

```rust
// 来源：codex-rs/core/src/tools/sandboxing.rs:152-171
pub(crate) enum ExecApprovalRequirement {
    /// No approval required for this tool call.
    Skip {
        /// The first attempt should skip sandboxing (e.g., when explicitly
        /// greenlit by policy).
        bypass_sandbox: bool,   // ← 规则显式 Allow 时连沙箱都可以不进
        proposed_execpolicy_amendment: Option<ExecPolicyAmendment>,
    },
    /// Approval required for this tool call.
    NeedsApproval {
        reason: Option<String>,
        proposed_execpolicy_amendment: Option<ExecPolicyAmendment>,
    },
    /// Execution forbidden for this tool call.
    Forbidden { reason: String },
}
```

`proposed_execpolicy_amendment` 是个精妙设计：审批弹窗不只问「这次行不行」，还可以附带一条「以后同类命令都放行」的规则修正案，用户点一下就把规则写进策略文件。后面流程走读会看到它如何落盘。

### 规则引擎的裁决：`Decision`

`execpolicy` crate 内部的判定比上面更原始，只有三档，且 `Ord` 派生让「取最严格」成为一次 `max()`：

```rust
// 来源：codex-rs/execpolicy/src/decision.rs:7-16
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    /// Command may run without further approval.
    Allow,
    /// Request explicit user approval; rejected outright when running with `approval_policy="never"`.
    Prompt,
    /// Command is blocked without further consideration.
    Forbidden,
}
```

声明顺序即大小序：`Allow < Prompt < Forbidden`。多条规则命中时取最大者——**任何一条 forbidden 规则都能否决一百条 allow**（policy.rs:401-411 的 `Evaluation::from_matches`）。

### 平台枚举：`SandboxType`

三平台机制最终被抽象成四个值：

```rust
// 来源：codex-rs/sandboxing/src/manager.rs:36-53
pub enum SandboxType {
    None,
    MacosSeatbelt,
    LinuxSeccomp,
    WindowsRestrictedToken,
}

impl SandboxType {
    pub fn as_metric_tag(self) -> &'static str {
        match self {
            SandboxType::None => "none",
            SandboxType::MacosSeatbelt => "seatbelt",
            SandboxType::LinuxSeccomp => "seccomp",   // ← 名字保留历史；文件系统隔离已是 bwrap
            SandboxType::WindowsRestrictedToken => "windows_sandbox",
        }
    }
}
```

`LinuxSeccomp` 这个名字是个活化石：当前基线的 Linux 文件系统隔离由 bubblewrap 完成，seccomp 只剩网络过滤，Landlock 退居 legacy 后备（linux-sandbox/src/landlock.rs:1-4 的模块注释写得很坦白）。

## 流程走读

### 4.1 一条命令的决策链总览

先把全链画出来，再逐段拆：

```
模型产出工具调用（shell 命令 / apply_patch）
   │
   ▼
第一关：静态判定（不执行任何东西）
   ExecPolicyManager::create_exec_approval_requirement_for_shell
   │   剥掉 bash -lc 外壳，逐段求值
   │   ├─ execpolicy 规则命中 → Allow / Prompt / Forbidden
   │   └─ 未命中 → 启发式（危险命令？沙箱可用？审批策略？）
   ▼
   ExecApprovalRequirement（Skip / NeedsApproval / Forbidden）
   │
   ▼
第二关：ToolOrchestrator::run（orchestrator.rs:125-534）
   │
   ├─ 1) 审批：Skip 放行 / NeedsApproval 挂起等用户 / Forbidden 拒绝
   ├─ 2) 选沙箱：SandboxManager::select_initial
   │        seatbelt / bwrap+seccomp / restricted token / None
   ├─ 3) 第一次尝试（沙箱内执行）
   │      │ 成功 → 返回输出，链结束
   │      ▼ 失败且为 SandboxErr::Denied
   ├─ 4) 升级追问：「command failed; retry without sandbox?」
   │      │ 用户拒绝 → 拒绝原因回给模型，模型换路子
   │      ▼ 用户批准
   └─ 5) 第二次尝试（SandboxType::None 或放宽权限）
```

关键认知：**审批（第一、二关的「问不问」）与沙箱（「关不关」）是两个正交维度**。被规则放行的命令仍可能进沙箱；被沙箱拦住的命令可以靠审批放出来。Codex 的策略是默认让沙箱兜底（静默、无打扰），只有沙箱兜不住或命令本身可疑时才消耗用户的注意力。

### 4.2 第一关：execpolicy 与受信/未受信判定

#### 4.2.1 求值入口

以 unified exec（shell 命令工具）为例，handler 在真正构造运行时请求之前先算好审批需求（process_manager.rs:1259-1281）：

```rust
// 来源：codex-rs/core/src/unified_exec/process_manager.rs:1259-1281（节选）
let exec_approval_requirement = context
    .session
    .services
    .exec_policy
    .create_exec_approval_requirement_for_shell(
        ExecApprovalRequest {
            command: &request.command,
            approval_policy: turn.approval_policy(),       // ← 来自回合上下文
            permission_profile: request.turn_environment.permission_profile().clone(),
            environment_policy: request.turn_environment.config().exec_policy.as_ref(),
            windows_sandbox_level: turn.windows_sandbox_level,
            sandbox_permissions: /* ... */,
            prefix_rule: request.prefix_rule.clone(),      // ← 模型自报的建议规则
            allow_prefix_rules: context.step_context.turn.allow_prefix_rules(),
        },
        configured_shell,
        &request.shell_mode,
    )
    .await;
```

算出来的 `ExecApprovalRequirement` 被打包进 `UnifiedExecRequest`，后面 orchestrator 直接取用（unified_exec.rs:187-192 的 `exec_approval_requirement()` 就是把它交出去）。

#### 4.2.2 先剥壳：`bash -lc "..."` 不能成为盲区

模型给出的通常不是裸命令，而是 `["bash", "-lc", "cargo test && rm -rf x"]` 这样的 shell 包裹。如果对整串做前缀匹配，`bash -lc` 会匹配一切，规则形同虚设。所以求值前先解析（executable_identity.rs:18-51）：

```rust
// 来源：codex-rs/core/src/exec_policy/executable_identity.rs:18-51（节选）
pub(crate) async fn create_exec_approval_requirement_for_shell(
    &self,
    mut request: ExecApprovalRequest<'_>,
    configured_shell: &Shell,
    shell_mode: &UnifiedExecShellMode,
) -> ExecApprovalRequirement {
    let command = request.command;
    let executable = shell_approval_command(command, configured_shell, shell_mode);
    if executable.len() == command.len() {
        return self
            .create_exec_approval_requirement_for_command(request)
            .await;
    }
    // ...
    // Evaluate the executable alongside its apparent commands. Inner
    // commands can add restrictions, but cannot grant the executable trust.
    policy_commands.commands.insert(0, executable.to_vec());
    request.command = executable;
    self.create_exec_approval_requirement_for_parsed_commands(request, policy_commands)
        .await
}
```

`commands_for_exec_policy`（exec_policy.rs:831-858）用 `parse_shell_lc_plain_commands` 把脚本拆成 `cargo test`、`rm -rf x` 等「平命令」，每一段独立求值。那句注释是本节的题眼：**内层命令只能让判定更严格，不能借外壳的信任蒙混过关**——`Decision::max()` 的聚合语义在这里兑现。

#### 4.2.3 规则长什么样：starlark 前缀规则

execpolicy 的规则文件用 starlark（Bazel 同款方言）书写，核心构造是 `prefix_rule`：

```python
# 来源：codex-rs/execpolicy/examples/example.codexpolicy（节选）
prefix_rule(
    pattern = ["git", "reset", "--hard"],
    decision = "forbidden",
    justification = "destructive operation",
    match = [ ["git", "reset", "--hard"] ],
    not_match = [ ["git", "reset", "--keep"] ],
)

prefix_rule(
    pattern = ["cp"],
    decision = "prompt",          # ← 不给 decision 默认 allow
    match = [ ["cp", "foo", "bar"] ],
)
```

规则从配置层各目录的 `rules/*.rules` 加载（`load_exec_policy`，exec_policy.rs:641-695），用户级修正统一追加到 `~/.codex/rules/default.rules`（`default_policy_path`，exec_policy.rs:827-829）。匹配是纯前缀逐 token 比较（rule.rs:46-59 的 `matches_prefix`）：`pattern = ["git", "push"]` 放行 `git push origin main`，但对 `git pushd` 不适用——token 级而非字符串级，避免了前缀误伤。

#### 4.2.4 未命中时怎么办：启发式兜底

大多数命令命中不了任何规则。此时由 `render_decision_for_unmatched_command`（exec_policy.rs:731-815）给出兜底裁决，这段代码值得逐行读：

```rust
// 来源：codex-rs/core/src/exec_policy.rs:753-799（节选）
// If the command is flagged as dangerous or we have no sandbox protection,
// we should never allow it to run without approval.
if dangerous_command_match.is_some() || windows_managed_fs_restrictions_without_sandbox_backend
{
    return match approval_policy {
        AskForApproval::Never => Decision::Forbidden,   // ← 不让问就宁可禁
        AskForApproval::OnRequest
        | AskForApproval::UnlessTrusted
        | AskForApproval::Granular(_) => Decision::Prompt,
    };
}

match approval_policy {
    AskForApproval::Never => {
        // We allow the command to run, relying on the sandbox for
        // protection.
        Decision::Allow                     // ← 沙箱兜底，放行
    }
    AskForApproval::UnlessTrusted => {
        // Projects marked untrusted require approval for every command
        // that is not explicitly allowed by an exec policy rule.
        Decision::Prompt                    // ← 未受信项目：规则没写就一律问
    }
    AskForApproval::OnRequest => {
        match file_system_sandbox_policy.kind {
            FileSystemSandboxKind::Unrestricted | FileSystemSandboxKind::ExternalSandbox => {
                Decision::Allow             // ← 本来就全开放，问了也白问
            }
            FileSystemSandboxKind::Restricted => {
                // In restricted sandboxes, do not prompt for non-escalated,
                // non-dangerous commands; let the sandbox enforce
                // restrictions without a user prompt.
                if sandbox_permissions.requests_sandbox_override() {
                    Decision::Prompt        // ← 模型自己想出沙箱，得问
                } else {
                    Decision::Allow         // ← 有沙箱兜底，静默放行
                }
            }
        }
    }
    // ...
}
```

这段函数就是「**trusted vs untrusted 命令判定**」的完整答案，逻辑收敛成一张表：

| 命令情形 | 裁决 |
|----------|------|
| 规则显式 allow | `Allow`（且可带 `bypass_sandbox`，见 4.3） |
| 规则 prompt / forbidden | 照办；`Never` 策略下 prompt 降级为 forbidden |
| 未命中 + 危险启发式（`dangerous_command_match`） | `Prompt`；`Never` 下 `Forbidden` |
| 未命中 + 沙箱可用 + 不请求越权 | `Allow`——沙箱兜底，不打扰用户 |
| 未命中 + `UnlessTrusted` | 一律 `Prompt` |

危险命令启发式来自 `codex-shell-command` crate 的 `dangerous_command_match`（exec_policy.rs:697-708 接入），比如递归删除、写裸磁盘这类模式。注意它的定位：**启发式只能把命令往严格方向推，永远不能放宽规则已经给出的结论**。

求值结果映射回三态需求在 exec_policy.rs:375-440。其中 `Decision::Allow` 分支里有个细节（exec_policy.rs:419-433）：`bypass_sandbox` 为真当且仅当**每一个**拆出的平命令段都被规则显式 allow——`cargo test && curl evil.com` 不会因为前半段可信就整体免检出沙箱。

### 4.3 第二关：ToolOrchestrator 的审批闸门

进入 orchestrator。`run()` 的第 1 步把 `ExecApprovalRequirement` 变成行动（orchestrator.rs:169-229）：

```rust
// 来源：codex-rs/core/src/tools/orchestrator.rs:169-229（节选）
let requirement = tool.exec_approval_requirement(req).unwrap_or_else(|| {
    default_exec_approval_requirement(approval_policy, &file_system_sandbox_policy)
});
match &requirement {
    ExecApprovalRequirement::Skip { .. } => {
        if strict_auto_review {
            // ... Guardian 自动审查路径
        } else {
            otel.tool_decision(/* ... */ ReviewDecision::Approved, /* ... */);
        }
    }
    ExecApprovalRequirement::Forbidden { reason } => {
        return Err(ToolError::Rejected(reason.clone()));   // ← 不执行，原因回模型
    }
    ExecApprovalRequirement::NeedsApproval { reason, .. } => {
        let action = tool.approval_action(req, &tool_ctx.call_id) /* ... */?;
        let approval_ctx = ApprovalContext {
            review_context: GuardianReviewContext::from(&tool_ctx.step_context),
            // ...
            approval_reason: reason.clone(),
            retry_reason: None,
            network_approval_context: None,
        };
        tool_ctx
            .session
            .request_approval(action, approval_ctx)   // ← 挂起，等审批结果
            .await?;
        already_approved = true;                      // ← 记住：这次问过了
    }
}
```

`Forbidden` 路径返回 `ToolError::Rejected`，这个「拒绝」不是异常终止回合（turn），而是作为工具输出回传给模型——模型看到「这条命令被策略禁止」，会换一条路走。安全拦截对模型是**可读的反馈**，而非黑箱失败。

`default_exec_approval_requirement`（sandboxing.rs:194-230）是没提供自定义需求时的兜底：`UnlessTrusted` 恒需审批；`OnRequest`/`Granular` 只在文件系统受限时才需要；`Never` 永远跳过。

### 4.4 沙箱尝试与失败升级

第 2 步选沙箱（orchestrator.rs:264-281）：

```rust
// 来源：codex-rs/core/src/tools/orchestrator.rs:264-281（节选）
let sandbox_requested = match sandbox_override {
    SandboxOverride::BypassSandboxFirstAttempt => false,  // ← 规则显式放行，免检
    SandboxOverride::NoOverride => self.sandbox.should_sandbox(
        &permissions,
        sandbox_preference,
        managed_network_active,
    ),
};
let initial_sandbox = if sandbox_requested && !executor_managed_process_sandbox {
    self.sandbox.select_initial(
        &permissions,
        sandbox_preference,
        turn_ctx.windows_sandbox_level,
        managed_network_active,
    )
} else {
    SandboxType::None
};
```

`should_sandbox`（manager.rs:310-329）把「策略上需不需要沙箱」与「本机能不能提供沙箱」分开回答；`select_initial` 再映射到具体 `SandboxType`。策略侧判定在 `should_require_platform_sandbox`（policy_transforms.rs:541-561）：有托管网络要求必沙箱；网络受限时除 external-sandbox 外都要沙箱；文件系统受限且非全盘可写时才需要平台沙箱。

第 3 步第一次尝试。失败时最关键的是分支条件：只有 `SandboxErr::Denied`（沙箱主动拦截，而非命令自己报错）才进入升级逻辑。升级前有连续四道闸（orchestrator.rs:356-400），第一道就是工具自己表不表态：

```rust
// 来源：codex-rs/core/src/tools/orchestrator.rs:356-400（节选）
if !tool.escalate_on_failure() {
    // ... 工具声明「我失败了就别提权」，直接返回错误
    return Err(ToolError::Codex(err));
}
// Under `Never` or `OnRequest`, do not retry without sandbox;
// surface a concise sandbox denial that preserves the
// original output.
if !tool.wants_no_sandbox_approval(approval_policy) {
    // ... OnRequest/Never 下不问「出沙箱重跑」，直接报沙箱拒绝
    return Err(ToolError::Codex(err));
}
if !unsandboxed_allowed && network_approval_context.is_none() {
    // ... 策略里有 deny-read 路径时，无沙箱执行会丢掉这层保护，禁止绕过
    return Err(ToolError::Codex(err));
}
```

通过闸口后，第二次审批弹窗的文案来自一个刻意保持稳定的函数（orchestrator.rs:549-553）：

```rust
// 来源：codex-rs/core/src/tools/orchestrator.rs:549-553
fn build_denial_reason_from_output(_output: &ExecToolCallOutput) -> String {
    // Keep approval reason terse and stable for UX/tests, but accept the
    // output so we can evolve heuristics later without touching call sites.
    "command failed; retry without sandbox?".to_string()
}
```

用户在 TUI 里看到的「沙箱内失败，要不要直接跑？」就是它。批准后以 `SandboxType::None` 重跑（orchestrator.rs:444-491）；若 `unsandboxed_allowed` 为假（存在 deny-read 限制），则保持沙箱只放宽其它维度。`already_approved` 标记保证同一命令不会在升级时再被全量重问一遍——这就是文件头注释里「no re-approval thanks to caching」的一半含义（另一半是 4.5 的会话级缓存）。

### 4.5 审批的往返：事件、oneshot 与会话级缓存

`session.request_approval`（approvals.rs:439-501）是审批的总入口。它先决定**谁来批**——优先级写死在代码里（approvals.rs:454-474）：

```rust
// 来源：codex-rs/core/src/tools/approvals.rs:454-474
// Approval precedence is:
// 1. Hooks
// 2. If StrictAutoReview || Guardian enabled, then Guardian. Else, user.
let resolution = match run_permission_request_hooks(
    self,
    ctx.review_context.turn(),
    &permission_request_run_id,
    action.permission_request_payload(),
)
.await
{
    Some(PermissionRequestDecision::Allow) => ApprovalResolution {
        decision: ReviewDecision::Approved,
        source: ApprovalResolutionSource::Hook,       // ← 用户配置的 hook 直接放行
    },
    Some(PermissionRequestDecision::Deny { message }) => ApprovalResolution {
        decision: ReviewDecision::denied(message),
        source: ApprovalResolutionSource::Hook,
    },
    None => self.request_reviewer_approval(action, &ctx).await,  // ← 没人接管才往下走
};
```

三级审查者：**hooks**（用户配置的 PermissionRequest 钩子脚本）→ **Guardian**（自动审查子系统）→ **用户**。前两者任一给出结论就短路，用户弹窗是最后的兜底。决定回来后在 `into_tool_result`（approvals.rs:407-436）里翻译成工具层结果：`Denied` → `Rejected`，`Abort` → `TurnAborted`，其余放行。

走到用户这一级时，`request_command_approval`（session/mod.rs:2390-2472）完成「挂起-等待」：

```rust
// 来源：codex-rs/core/src/session/mod.rs:2409-2416, 2452-2471（节选）
// Add the tx_approve callback to the map before sending the request.
let (tx_approve, rx_approve) = oneshot::channel();
let prev_entry = {
    let mut active = self.active_turn.lock().await;
    match active.as_mut() {
        Some(at) => {
            let mut ts = at.turn_state.lock().await;
            ts.insert_pending_approval(effective_approval_id.clone(), tx_approve)
        }
        None => None,
    }
};
// ...
let event = EventMsg::ExecApprovalRequest(ExecApprovalRequestEvent {
    call_id,
    // ...
    available_decisions: Some(available_decisions),  // ← 内核告诉 UI 能展示哪些按钮
    parsed_cmd,
});
self.send_event(turn_context, event).await;
rx_approve.await.unwrap_or(ReviewDecision::Abort)   // ← 挂起；回合没了就当 Abort
```

回路在 `Op::ExecApproval` 的 handler（handlers.rs:616-623 → `exec_approval`，handlers.rs:174-199）：按 `approval_id` 从 pending 表取出 oneshot 发送端，把 `ReviewDecision` 推回去；若决定是 `ApprovedExecpolicyAmendment`，顺手把规则修正案持久化进 `default.rules`（`persist_execpolicy_amendment` → `append_amendment_and_update`，exec_policy.rs:443-491，先写文件再热更新内存中的 `ArcSwap<Policy>`）。整体时序：

```
内核侧                                         外壳侧（TUI / IDE）
─────────────────────────────────────────────────────────────────
Session::request_approval
  ├─ hooks → Allow/Deny？ ─┐
  ├─ Guardian 自动审查 ────┤ 任一给出结论即短路
  └─ request_user_approval ┘
        │ oneshot 挂起（rx_approve.await）
        ▼
EventMsg::ExecApprovalRequest ──────────► 弹窗渲染（Ch14 / Ch15）
                                              │ 用户选择
        ◄────────────── Op::ExecApproval { id, decision }
        │
exec_approval()（handlers.rs:174-199）
        │ 按 id 找到 pending oneshot，送回 ReviewDecision
        ▼
orchestrator 从 .await 苏醒，继续执行或把拒绝回给模型
```

注意 `unwrap_or(ReviewDecision::Abort)`：如果等待期间回合被打断（比如用户按了 Esc），oneshot 发送端被丢弃，`await` 拿到 `Err`，命令按 Abort 处理——**默认拒绝（fail-closed）**，绝不会因为通道异常而放行。

会话级缓存在 `with_cached_approval`（sandboxing.rs:70-116）：用户选「本会话总是允许」（`ApprovedForSession`）后，按序列化后的 key（命令、cwd、tty 等，approvals.rs:197-236 的 `cache_keys`）记录决定；后续 key 全部命中就不再弹窗。apply_patch 的 key 按文件逐个记录，所以「批准改 A 和 B」之后再改 A 不必重问。

### 4.6 三平台沙箱：一个抽象，三套机制

#### 4.6.1 统一抽象：沙箱即 argv 改写

所有平台的分歧被压进 `SandboxManager::transform`（manager.rs:331-482）：输入 `SandboxCommand`（程序 + 参数 + cwd + env + 权限档案），输出 `SandboxExecRequest`——一个**改写后的 argv**。执行层不需要知道 macOS 和 Linux 有什么区别，它 spawn 的就是 transform 返回的命令行。三个分支各写一个包装器：

```rust
// 来源：codex-rs/sandboxing/src/manager.rs:365-436（节选）
let (argv, arg0_override, pending_sandboxed_request) = match sandbox {
    SandboxType::None => (os_argv_to_strings(argv), None, None),
    #[cfg(target_os = "macos")]
    SandboxType::MacosSeatbelt => {
        // ...
        let mut args = create_seatbelt_command_args_with_profile(/* ... */)?;
        let mut full_command = Vec::with_capacity(1 + args.len());
        full_command.push(MACOS_PATH_TO_SEATBELT_EXECUTABLE.to_string()); // ← /usr/bin/sandbox-exec
        full_command.append(&mut args);
        (full_command, None, Some(pending))
    }
    // ...
    SandboxType::LinuxSeccomp => {
        // ...
        let mut args = create_linux_sandbox_command_args_for_permission_profile(
            os_argv_to_strings(argv),
            pending.native_command_cwd.as_path(),
            &pending.effective_permission_profile,
            /* ... */
        );
        let mut full_command = Vec::with_capacity(1 + args.len());
        full_command.push(os_string_to_command_component(exe.as_os_str().to_owned())); // ← codex-linux-sandbox
        full_command.append(&mut args);
        (full_command, Some(linux_sandbox_arg0_override(exe)), Some(pending))
    }
    // Windows 分支：spawn 前由 direct-spawn 包装器再处理（manager.rs:522-628）
};
```

`#[cfg(target_os = ...)]` 让非本平台的代码根本不参与编译；macOS 上选到 `LinuxSeccomp` 这类错配在类型层面就不会发生。

#### 4.6.2 macOS：seatbelt，策略是编译期打包的 .sbpl

macOS 直接调系统自带的 `/usr/bin/sandbox-exec`（seatbelt.rs:52-56；刻意只信 `/usr/bin` 下的，防 PATH 劫持），策略文件用 `include_str!` 打进二进制（seatbelt.rs:21-27）。基础策略是「默认全拒」范式：

```lisp
; 来源：codex-rs/sandboxing/src/seatbelt_base_policy.sbpl:1-13（节选）
(version 1)

; inspired by Chrome's sandbox policy
; start with closed-by-default
(deny default)

; child processes inherit the policy of their parent
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
```

`(deny default)` 起手，再逐条放开：进程创建、必要的 sysctl、可写根目录的文件写、按网络策略放开的出站连接（seatbelt_network_policy.sbpl）。策略注释自述灵感来自 Chromium 的沙箱 profile——这是经过实战检验的「先全关、再白名单」路线。

#### 4.6.3 Linux：helper 二进制 + bubblewrap + seccomp

Linux 没有在主进程里直接施加隔离，而是把命令包给 `codex-linux-sandbox` 辅助二进制（transform 的 Linux 分支上面已见；参数构造在 sandboxing/src/landlock.rs:23-60）：

```rust
// 来源：codex-rs/sandboxing/src/landlock.rs:42-59（节选）
let mut linux_cmd: Vec<String> = vec![
    "--sandbox-policy-cwd".to_string(),
    sandbox_policy_cwd,
    "--command-cwd".to_string(),
    command_cwd,
    "--permission-profile".to_string(),
    permission_profile_json,        // ← 整个权限档案序列化成 JSON 传给 helper
];
if use_legacy_landlock && !allow_network_for_proxy {
    linux_cmd.push("--use-legacy-landlock".to_string());
}
if allow_network_for_proxy {
    linux_cmd.push("--allow-network-for-proxy".to_string());
}
linux_cmd.push("--".to_string());
linux_cmd.extend(command);          // ← 真正的用户命令垫在 -- 后面
```

helper 内部分两层（linux-sandbox/src/lib.rs:1-6 模块注释）：**bubblewrap** 负责文件系统（挂载命名空间里只绑定可写根）；**seccomp + no_new_privs** 负责网络与提权封锁（landlock.rs:42-88）：

```rust
// 来源：codex-rs/linux-sandbox/src/landlock.rs:56-69（节选）
// `PR_SET_NO_NEW_PRIVS` is required for seccomp, but it also prevents
// setuid privilege elevation. Many `bwrap` deployments rely on setuid, so
// we avoid this unless we need seccomp or we are explicitly using the
// legacy Landlock filesystem pipeline.
if network_seccomp_mode.is_some()
    || (apply_landlock_fs && !file_system_sandbox_policy.has_full_disk_write_access())
{
    set_no_new_privs()?;
}

if let Some(mode) = network_seccomp_mode {
    install_network_seccomp_filter_on_current_thread(mode)?;  // ← 禁网=拦 socket 系调用
}
```

「禁网」在 Linux 上的落点是 seccomp 过滤器拦截 socket 相关系统调用；「文件系统只读」的落点是 bwrap 的挂载视图。两个机制管两个维度，互不替代。

#### 4.6.4 Windows：restricted token + ACL + WFP

Windows 没有 seatbelt/bwrap 这样的现成原语，`codex-windows-sandbox` crate 自己拼了一套（windows-sandbox-rs/src/lib.rs:49-124 的模块表就是成分清单）：`token.rs` 降权令牌、`acl.rs`/`workspace_acl.rs` 给工作区目录改访问控制表、`deny_read_acl.rs` 实现 deny-read、`desktop.rs` 私有桌面隔离 UI、`wfp.rs` 用 Windows Filtering Platform 做网络过滤。强度分档（config_types.rs:297-302）：

```rust
// 来源：codex-rs/protocol/src/config_types.rs:297-302
pub enum WindowsSandboxLevel {
    #[default]
    Disabled,          // ← 默认关：Windows 沙箱仍是显式开启的能力
    RestrictedToken,
    Elevated,          // ← 托管网络（network-proxy）要求这一档
}
```

代价也写在代码里：`get_platform_sandbox`（manager.rs:62-76）在 Windows 上只有显式启用才返回 `Some`，macOS/Linux 则是默认就位；`render_decision_for_unmatched_command` 里还有专门分支处理「Windows 沙箱没开但策略声称受限」的保守兜底（exec_policy.rs:745-751）。三平台的成熟度差异被诚实地暴露为配置，而不是假装一致。

#### 4.6.5 出网治理：network-proxy 概述

文件系统沙箱管不住「把代码传出去」。`codex-network-proxy` 提供托管出网通道：HTTP/SOCKS5 代理 + 可选 MITM（自签 CA 做 TLS 终结，network-proxy/src/lib.rs 的导出面可见 `mitm`、`certs`、`connect_policy` 等模块），每条连接按域名策略裁决，被拦时可以升级为一次网络审批——`ReviewDecision::NetworkPolicyAmendment`（protocol.rs:3899-3903）就是用户「永久放行/拦截某域名」的协议形状。orchestrator 为它留了完整通路：`begin_network_approval` 在每次尝试前挂上代理与取消令牌（orchestrator.rs:66-104），沙箱拒绝且错误里带网络策略裁决时，升级审批的理由会变成更具体的 `Network access to "<host>" is blocked by policy.`（orchestrator.rs:401-409）。细节超出本章范围，知道「网络是第三条独立审批维度」即可。

## 设计取舍

**为什么审批拦截点收敛在 orchestrator，而不是路由层或各 handler？** [第 9 章](ch09-tools.md)给过结论，本章能看到机制层面的原因：升级重试需要「第一次尝试的结果」作为输入（只有 `SandboxErr::Denied` 才升级），这个状态机只有包住执行本身的那层能写。放路由层会让 router 背上两次执行的复杂度；放 handler 会让每个工具各写一遍四道闸。`ToolRuntime` trait（sandboxing.rs:363-384）把「不同点」（怎么跑、怎么构造审批动作）留给工具，「相同点」（审批序列、沙箱选择、提权）收进泛型 orchestrator——shell 和 apply_patch 共享同一套安全语义，新增工具自动获得。

**为什么默认「先跑后问」（沙箱兜底），而不是「先问后跑」？** 这是对「审批疲劳」的工程学回答。如果每条命令都弹窗，用户会在第一百次时无脑点允许，审批形同虚设。Codex 把默认路径设计为：沙箱内静默执行 → 只有沙箱拦不住（deny）或命令本质可疑（危险启发式、`UnlessTrusted`、模型自报提权）才消耗用户注意力。`OnRequest` 下沙箱失败甚至**不再追问**（orchestrator.rs:366-389），直接把拒绝回给模型——因为模型往往换个写法就能在沙箱内完成，这比打扰用户更优。安全与可用性的平衡点被精确地放在了「弹窗次数」这个指标上。

**为什么规则引擎用 starlark + 前缀匹配，而不是正则或完整脚本？** 前缀匹配的可推理成本极低：用户看一眼 `["git", "push"]` 就知道放行了什么，不存在正则的回溯陷阱和意外匹配。starlark 是无图灵完备能力的确定性语言，规则文件不可能变成攻击载荷本身。代价是表达力——`prefix_rule` 表达不了「允许 push 到 origin 但不许到 upstream」这种参数值级条件，只能靠更长的前缀近似。这是刻意选的「宁可欠拟合，不可误放行」。

**对比 my-agent：最小可行安全阶梯。** TypeScript 版 my-agent 大概率没有沙箱——Node 运行时够不着 seccomp/namespace，这是事实约束而非懒惰。那么从 Codex 反推一条可落地的阶梯：

1. **第 0 级（裸奔）**：`exec(command)` 直接跑。绝大多数 Agent demo 停在这里。
2. **第 1 级（审批提示）**：执行前把命令打印出来等用户回车。对应 `AskForApproval::UnlessTrusted` 的退化版。一天就能写完，但只有「人」这一道闸。
3. **第 2 级（规则放行）**：加一个命令前缀 allowlist（`["git status", "cargo test"]`），命中免审批。对应 execpolicy 的最小子集——注意 Codex 的规则匹配是 **token 级前缀**而非字符串 `startsWith`，后者会被 `git stat` 这种笔误绕过。
4. **第 3 级（危险模式硬拒）**：`rm -rf /`、`> /dev/sda` 这类模式直接 forbidden，不问不跑。对应 `dangerous_command_match` + `Decision::Forbidden`。
5. **第 4 级（真隔离）**：把整个 Agent 放进 Docker 容器 / devcontainer / 云沙箱跑。这是 TS 项目唯一现实的「沙箱」——隔离边界从「每条命令」粗化成「整个会话」，换来的是实现成本归零。

Codex 自己的答案是在 1-3 级之外，用 Rust 把第 4 级细化回每条命令。my-agent 不必一步到位，但第 1-3 级是纯 TS 一周内能抄走的——而且请先抄第 3 级：**硬拒清单是性价比最高的安全投资**。

**坦诚的局限。** 其一，沙箱拒绝的判定依赖 `SandboxErr::Denied` 错误分类，命令在沙箱内「合法但语义有害」（如沙箱内写坏工作区）不在此列——沙箱管边界不管意图。其二，execpolicy 对多态命令（`python -c`、管道组合）只能拆段求值，`BANNED_PREFIX_SUGGESTIONS`（exec_policy.rs:56-145）那 90 来个被禁的建议前缀（`bash -c`、`python -c`、`node -e`……）本身就承认了解析的局限：模型自报的 `prefix_rule` 若是这类万能前缀，会被拒绝采纳。其三，Windows 沙箱默认关闭，三平台的安全水位并不齐平。

## 动手实验

### 1. 离线玩 execpolicy 规则引擎

`execpolicy` crate 自带 CLI（main.rs:1-18），不用启动 Codex 就能观察裁决：

```shell
cd codex-rs

cat > /tmp/demo.rules <<'EOF'
prefix_rule(pattern = ["git", "status"], decision = "allow")
prefix_rule(pattern = ["git", "reset", "--hard"], decision = "forbidden",
            justification = "destructive operation")
prefix_rule(pattern = ["npm", "install"], decision = "prompt")
EOF

cargo run -p codex-execpolicy -- check -r /tmp/demo.rules --pretty -- git status
```

预期输出形态（JSON，`decision` 取所有命中规则的最严格值）：

```json
{
  "matchedRules": [
    { "prefixRuleMatch": { "matchedPrefix": ["git", "status"], "decision": "allow" } }
  ],
  "decision": "allow"
}
```

再试两条对照：

```shell
cargo run -p codex-execpolicy -- check -r /tmp/demo.rules --pretty -- git reset --hard
# 预期：decision = "forbidden"，matchedRules 里带 justification

cargo run -p codex-execpolicy -- check -r /tmp/demo.rules --pretty -- git log
# 预期：{"matchedRules":[]} —— 无命中时 decision 字段整个不出现，
# 真实运行时由启发式兜底接管（exec_policy.rs:731-815），CLI 不模拟那一层
```

### 2. 观察沙箱包装后的真实进程

```shell
# 终端 A（Linux 示例；macOS 换成 grep sandbox-exec）
cargo run --bin codex -- exec "sleep 60" &
sleep 5
ps -ef | grep -E "codex-linux-sandbox|sandbox-exec" | grep -v grep
```

预期形态：能看到 `sleep 60` 并非被直接 spawn，而是包在
`codex-linux-sandbox --sandbox-policy-cwd ... --permission-profile '{"..."}' -- sleep 60`
（Linux）或 `/usr/bin/sandbox-exec -p '...' sleep 60`（macOS）之下——这就是 `SandboxManager::transform` 的 argv 改写产物（4.6.1）。`--permission-profile` 后面那段 JSON 可以复制出来 `jq .` 看当前生效的权限档案。

### 3. 触发「沙箱拒绝 → 升级审批」路径

升级追问只在 `UnlessTrusted`（或开了 `sandbox_approval` 的 `Granular`）策略下出现（orchestrator.rs:366-389 的 `wants_no_sandbox_approval` 闸口），而 CLI 的 `-a/--ask-for-approval` 只暴露 `on-request`/`never` 两档（utils/cli/src/approval_mode_cli_arg.rs:9-16），`untrusted` 是面向未受信项目的内部策略。所以这条路径要在 TUI 里触发——找一个未建立信任的目录（或在 `config.toml` 里写 `approval_policy = "untrusted"`）：

```shell
mkdir -p /tmp/codex-untrusted-demo && cd /tmp/codex-untrusted-demo
cargo run --manifest-path ~/Projects/codex/codex-rs/Cargo.toml --bin codex -- --sandbox read-only
# 进入 TUI 后让它写工作区外的文件，例如：
#   create a file /tmp/codex-sandbox-test.txt containing hi
```

预期形态：read-only 沙箱拦下写 `/tmp` 的尝试，`SandboxErr::Denied` 触发升级逻辑，TUI 弹出审批框，reason 正是那句固定文案 `command failed; retry without sandbox?`（orchestrator.rs:549-553）。批准后趁命令还在跑用实验 2 的 `ps` 观察，会发现第二次尝试的进程**没有**沙箱包装——`SandboxType::None` 的实证。对照组：`codex exec`（无头模式默认 `Never`，exec/src/lib.rs:406-434）跑同一条命令，预期不追问，沙箱拒绝直接作为工具输出回给模型。

### 4. 验证审批修正案的落盘

在 TUI 里审批一条命令时选择带规则修正案的选项（`ApprovedExecpolicyAmendment`），然后：

```shell
cat ~/.codex/rules/default.rules
```

预期形态：文件末尾新增一行 `prefix_rule(pattern=[...], decision="allow")`——这是 `append_amendment_and_update`（exec_policy.rs:443-491）的写入结果。同会话内再发同类命令，不再弹窗（规则命中 + 会话缓存双保险）。

## Rust 侧栏

- **`#[cfg(target_os = "...")]` 条件编译**：属性标注的代码在不匹配的平台上根本不进编译产物。`transform` 的 seatbelt 分支在 Linux 上不存在（manager.rs:367），所以跨平台枚举错配是编译期错误而非运行时 bug——TS 里对应物只能靠运行时 `if (process.platform === ...)`，错了要到那台机器上才炸。
- **`oneshot::channel`**：一次性单发通道。审批等待（session/mod.rs:2410）用它把「UI 的异步回包」接回「orchestrator 的 `.await` 续命」；发送端被 drop 时接收端拿到 `Err`，天然实现了 fail-closed 的 `unwrap_or(Abort)`。
- **`ArcSwap<Policy>`**：无锁原子替换的 `Arc`。规则修正案落盘后整个 `Policy` 被换掉（exec_policy.rs:489），正在求值的线程继续用旧快照读完，新请求拿到新策略——读写不互斥，也不需要 `Mutex`。
- **派生 `Ord` 的顺序语义**：`Decision` 的三个变体按声明顺序定大小（decision.rs:7），`Allow < Prompt < Forbidden` 是写进类型系统的业务规则，`max()` 一行完成「取最严格」。变体顺序即策略，改顺序就是改安全语义。
- **`include_str!`**：把文件内容编译期嵌入字符串字面量。seatbelt 的 .sbpl 策略（seatbelt.rs:21-27）随二进制分发，不存在「策略文件被篡改/丢失」的运行时依赖；代价是改策略要重编译。

## 小结 + 思考题

本章拆开了 Codex 的安全模型：命令先过 execpolicy 的静态三态裁决（规则命中照办，未命中看危险启发式与沙箱兜底能力），再进 `ToolOrchestrator` 的「审批 → 选沙箱 → 尝试 → 失败升级」序列；审批经 hooks → Guardian → 用户三级路由，以 oneshot + 事件往返，并有会话级缓存削减打扰；执行侧由 `SandboxManager` 把三平台差异压成 argv 改写——seatbelt 的 .sbpl、Linux 的 helper + bwrap + seccomp、Windows 的 restricted token + ACL + WFP。核心哲学是**沙箱兜底、审批节制、默认拒绝**：用户的注意力是稀缺资源，只在沙箱和规则都兜不住时才消耗它。

思考题：

1. `render_decision_for_unmatched_command` 里，`Never` 策略下危险命令被 `Forbidden` 而非 `Allow`，但普通命令反而 `Allow`——为什么这组搭配在 CI 场景是自洽的？如果 CI 里想连危险命令也放行，该改配置还是改代码？
2. 升级重试时 `already_approved` 避免了重复弹窗，但 `bypass_retry_approval` 还要求 `network_approval_context.is_none()`（orchestrator.rs:413-415）。为什么网络维度的拒绝不允许复用之前的批准？
3. 如果让你在 my-agent 里实现第 2 级（前缀 allowlist），你会把规则存成什么格式、在哪个时机求值？对比 Codex 的 starlark + 加载期解析，你的方案的攻击面差在哪？
4. `bypass_sandbox` 要求「每一个平命令段都被规则显式 allow」（exec_policy.rs:419-433）。构造一条模型可能发出的命令，说明少了这个「每一段」的要求会打开什么洞。
