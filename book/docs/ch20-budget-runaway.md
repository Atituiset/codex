# 第 20 章 失控控制：预算、阈值与「无上限循环」的兜底

## 本章导读

前两章的防线都是**单点**的：一次请求的重试、一个进程的中止。本章面对的是最宏观的失效模式——**累积性失控**：

- 模型陷入自我修改循环，一个 turn 内无限调用工具，token 疯狂燃烧；
- 会话越聊越长，用户不主动压缩就永远逼近窗口上限；
- 多 agent 场景下，一条会话树整体烧掉预算，没有谁在「记账」。

这三类问题的解法在 Codex 里对应三把闸门：**turn 内的采样循环上限、窗口 90% 的自动压缩、会话树级的 rollout 预算**。它们从微观到宏观构成一个漏斗——先耗尽的是最内层，最外层永远不会被触发，但一旦触发就是硬停机。

自建 Agent 通常只有第一把闸门（`max_iterations`），而且数字是拍脑袋的。本章讲三把闸门的联动：**每一层的触发条件、触发后的动作、以及为什么这一层要设在这一层**。

## 源码地图

| 文件 | 职责 | 点评 |
|------|------|------|
| `codex-rs/protocol/src/openai_models.rs` | `auto_compact_token_limit`：90% 阈值推导 | 一行公式，全书最有价值常量 |
| `codex-rs/core/src/rollout_budget.rs` | 会话树共享预算与提醒投递 | 跨 turn/跨 agent 记账 |
| `codex-rs/core/src/config/mod.rs` | `RolloutBudgetConfig`：权重、上限、提醒阈值 | 预算的配置面 |
| `codex-rs/core/src/session/rollout_budget.rs` | 预算记账的接线：记账 + 注入提醒 | fragment 注入的活样本 |
| `codex-rs/core/src/session/turn.rs` | PreTurn/MidTurn 两阶段压缩触发 | 无上限循环的依赖项 |
| `codex-rs/core/src/compact.rs` | 压缩执行与 `ContextWindowExceeded` 重试 | 第三道（事后）防线 |
| `codex-rs/core/src/compact_token_budget.rs` | 手动 token-budget 压缩生命周期 | 压缩的形式化统一 |

## 核心数据结构

第一把闸门的公式在第 8 章见过，但这里要强调它的「单向」性质：

```rust
// 来源：codex-rs/protocol/src/openai_models.rs:486-497
pub fn auto_compact_token_limit(&self) -> Option<i64> {
    let context_limit = self
        .resolved_context_window()
        .map(|context_window| (context_window * 9) / 10);   // ← 窗口的 90%
    let config_limit = self.auto_compact_token_limit;        // 用户配置
    if let Some(context_limit) = context_limit {
        return Some(
            config_limit.map_or(context_limit, |limit| std::cmp::min(limit, context_limit)),
        );   // ← 用户只能调低，永远不能调高过 90%
    }
    config_limit
}
```

用户配置与 90% 推导值取 `min`——**「我想在 95% 才压缩」这个愿望被结构性拒绝**。为什么？因为压缩本身需要调用一次模型（生成本身就是一次大请求），如果你的触发点在 95%，压缩请求很可能直接撞墙 `context_length_exceeded`。90% 留出的 10% 正是「压缩操作的运营空间」。

第三把闸门是很多自建 Agent 完全没有的：**会话树级共享预算**。

```rust
// 来源：codex-rs/core/src/rollout_budget.rs:16-32（删节）
/// Shared accounting and reminder state for one root-thread session tree.
#[derive(Default)]
pub(crate) struct RolloutBudget {
    state: OnceLock<Mutex<RolloutBudgetState>>,
}

struct RolloutBudgetState {
    config: RolloutBudgetConfig,
    weighted_tokens_used: f64,     // ← 加权累计消耗
    deliveries: HashMap<ThreadId, ThreadBudgetDelivery>, // 每线程提醒水位
}
```

注意 doc 注释的措辞：**one root-thread session tree**。预算不属于某个 turn、某个 thread，而是属于从根 thread 派生出的整棵树——包括所有子 agent。这解决了多 agent 的「公地悲剧」：每个子 agent 都觉得自己没超，但整棵树已经烧穿了。

## 流程走读：三把闸门的联动漏斗

```
模型输出 token usage（response.completed）
   │
   ▼
① turn 级记账: record_rollout_budget_usage()
   budget.record_usage(usage) == true？
   │  是 ──► Err(SessionBudgetExceeded)，turn 硬停机（最外层，最后触发）
   │  否
   ▼
② 提醒水位检查: pending_reminder(thread_id, window_id)
   │  remaining_tokens <= 某阈值 && 未提醒过
   │  ──► 注入 RolloutBudgetContext fragment（模型可见的「余额警告」）
   │
   ▼
③ 窗口水位: PreTurn(1024) / MidTurn(458) 检查 total usage
   total >= auto_compact_token_limit（窗口×90%）？
   │  是 ──► run_auto_compact()：本地/远程/兜底 三路分发
   │          压缩后 history 替换，循环继续
   ▼
④ 都没触发 ──> 继续 turn 循环（turn.rs 的 loop 无 max_iterations）
```

三个层次的分工精妙在**动作的烈度递增**：

- 水位提醒（②）只是**注入一条上下文**让模型自知：「你还剩 X tokens」——模型可能因此主动收敛。这是最温和的干预，也是最先触发的。
- 自动压缩（③）**重写历史**但保留语义——对话继续，只是物理换了一页。注意它的触发有 PreTurn/MidTurn 两相（第 8 章详述）：回合边界压缩最干净，回合中途压缩是应急。
- 预算停机（①）**终止一切**——`SessionBudgetExceeded` 是不可重试错误（error.rs:367 把它归入 `is_retryable == false` 的清单）。有意思的是它比提醒「晚」触发但「早」检查：记账每次响应都做，停机只在真正耗尽时发生。

## 记账的权重设计

预算不是简单数 token。看 `record_usage` 的加权：

```rust
// 来源：codex-rs/core/src/rollout_budget.rs:46-64（删节）
pub(crate) fn record_usage(&self, usage: &TokenUsage) -> CodexResult<bool> {
    let Some(mut state) = self.lock() else { return Ok(false); };
    let units = if let Some(units) = usage.codex_rollout_budget_units.as_ref() {
        // 服务端直接给出的预算单位（如 ChatGPT 计划额度），信任它
        let units = units.as_f64().unwrap_or(f64::NAN);
        if !units.is_finite() || units < 0.0 {
            return Err(CodexErr::Fatal("...must be finite and non-negative"...));
        }
        units
    } else {
        // 本地加权：输出全价，prefill 打折
        usage.output_tokens.max(0) as f64 * state.config.sampling_token_weight
            + usage.non_cached_input() as f64 * state.config.prefill_token_weight
    };
    state.weighted_tokens_used += units;
    Ok(state.weighted_tokens_used >= state.config.limit_tokens as f64)
}
```

两个设计点：**其一**，如果服务端返回 `codex_rollout_budget_units`，直接采用（它可能代表真实计费额度，比如订阅计划的另一种计量单位）；**其二**，本地加权区分输出与 prefill——缓存命中（cached）的输入不计入 `non_cached_input()`，这鼓励你保持 prompt 前缀稳定（正好呼应第 17 章的 prompt caching 实验）。**成本模型驱动行为模型**：你按什么计费，模型就被塑造成什么形状。

## 「无上限循环」为什么敢无上限

第 7 章提过 turn.rs 的主循环没有迭代上限，被标注为「无限循环」（turn.rs:469 附近的注释）。现在能补全这个论证了——它敢无上限，是因为**失控的定义权交给了预算层，而不是循环层**：

- 若 `max_iterations = 40`（常见的自建 Agent 写法），第 41 次迭代被硬切，用户看到「iterations exceeded」，前 40 次的成果全部作废，且**这个数字跟任务复杂度无关**——重构一个大模块 60 步是正常的。
- Codex 的方案：循环继续跑，但每次响应记账；真烧穿预算，停机错误是 `SessionBudgetExceeded`——它意味着「**这条会话树的总量**超了」，语义是资源耗尽而非逻辑失败。

这不是说 max_iterations 没用——它是**防御模型死循环**（不产出任何东西的空转）的最后一击。Codex 把「模型卡死」（应该停）与「任务真的很大」（应该跑）的区分，交给了预算和压缩的组合：前者烧预算也烧得慢（空转也要采样），后者烧得快但可能值。当然，若模型真的空转，用户 Esc 打断（第 19 章）永远在场。

## 设计取舍

**为什么预算是会话树级而不是 thread 级？** 子 agent（multi-agent 模式）共享父预算才不会「分身逃债」。但树级记账带来一个微妙问题：每条子 thread 都可能在不知情的情况下烧掉别人的份额——所以 `pending_reminder` 的投递记录按 `(ThreadId, window_id)` 维度（rollout_budget.rs:67-91），**每条线程各自看到一次余额警告**，不是全局只警告一次。提醒的去重逻辑用「本线程上次已投递的水位 ≥ 本次水位」判断，保证水位下降时每条线程都会再次被提醒。

**压缩的「事后防线」**：就算 90% 的预测失手（比如单条用户输入就超 10% 窗口），`run_compact_task_inner_impl` 里还有 `ContextWindowExceeded` 捕获（compact.rs:309-318）：请求真被拒了，就地做一次压缩再重试。防线从来不是一道，是「预测 + 事后补救」的组合——**失败预期本身是设计的一部分**。

**对比你的 my-agent**：TS Agent 的预算通常只是 API key 的账单告警——事后、被动、不在循环里。把本章的漏斗抄过去：a) 用 tiktoken 在每次响应后本地记账（加权：输出全价、缓存免费）；b) 水位提醒做成 system prompt 注入；c) 硬预算抛专用错误类型。代码量约 100 行，换来的是「账单不再是你和用户之间的惊吓」。

## 动手实验

验证 90% 公式与用户配置的交互：

```shell
cd codex-rs
rg -n "auto_compact_token_limit" protocol/src/openai_models.rs
# 预期：486-497，min() 保证用户只能调低

rg -n "reminder_at_remaining_tokens" core/src/config/mod.rs core/src/rollout_budget.rs
# 预期：配置定义（Vec<i64> 阈值列表）与消费点（filter + count 得水位）
```

追踪预算错误的全链路：

```shell
rg -n "SessionBudgetExceeded" protocol/src/error.rs core/src/session/rollout_budget.rs
# 预期：错误定义 → is_retryable 白名单（不在）→ 记账处抛出
# 注意它映射到 CodexErrorInfo::SessionBudgetExceeded 走 UI 专属展示

rg -n "RolloutBudgetContext" core/src/context/
# 预期：余额提醒作为 ContextualUserFragment 的定义——
# 第 8 章讲过的 fragment 纪律（有界、显式、可审计）的又一实例
```

亲手触发一次自动压缩（安全实验）：

```shell
# 在 codex TUI 里反复粘贴大文件内容（>10% 窗口），直到底栏 token 计数逼近上限
# 观察：TurnComplete 后、下一 turn 开始前，rollout 里出现 compacted 条目
ls ~/.codex/sessions/ | tail -1
# 找到最新 rollout 文件，grep '"compacted"' 会看到 replacement_history
```

## Rust 侧栏

- **`OnceLock<Mutex<T>>` 的双层惰性**：`RolloutBudget::state` 先 `OnceLock` 再 `Mutex`——前者保证「配置第一次到来时才创建状态」，后者保证并发记账。比 `LazyLock` 好在：未配置的会话零开销。TS 里没有直接对应物，最接近的是 `let state = config ? create() : null` 的手动判断。
- **`unwrap_or_else(PoisonError::into_inner)`**：锁中毒（持锁线程 panic）时把数据「捞出来」继续用（rollout_budget.rs:123-125）。预算记账宁可读旧数据也不死锁——**可用性优先于精确性**的取舍，值得抄。TS 没有锁中毒概念，但「try/catch 后继续用部分状态」是同一种决策。
- **`as_f64().unwrap_or(f64::NAN)` + `is_finite()` 校验**：服务端数值字段的防御三件套：解析失败得 NaN，NaN 过不了 `is_finite()`，负数过不了 `< 0.0`。永远不要 `as_f64().unwrap()`。
- **`map_or`**：`config_limit.map_or(context_limit, |limit| min(limit, context_limit))`——Option 上的「有值用值、无值用默认」一步到位，等价于 `match` 但无嵌套。

## 小结 + 思考题

失控控制是三层漏斗：水位提醒（注入上下文，最温和）→ 自动压缩（重写历史，中烈度）→ 预算停机（硬终止，最后手段）。90% 阈值留给压缩操作本身运营空间；预算按输出/prefill 加权，且服务端额度优先；无上限循环的「上限」概念被移到了预算层。

思考题：

1. 多 agent 树共享预算时，某条子 agent 的余额提醒是它「自己」的历史里注入的。父 agent 如何知道总额已耗尽？（提示：`SessionBudgetExceeded` 停的是谁的 turn？查 turn.rs 的记账调用点在哪个循环层）
2. 90% 阈值假定了「压缩请求的规模 ≈ 未压缩历史的规模」。如果压缩 prompt 本身已接近窗口，90% 够吗？源码里哪段代码在补救这种情况？
3. 给 my-agent 设计预算时，`sampling_token_weight` 与 `prefill_token_weight` 你会设多少？设 0 会怎样？（提示：non_cached_input() 为 0 时模型还被「收费」吗？这与缓存稳定性激励的关系）

---

*全书到这里收束：从一次 `codex` 命令的启动，到 turn 循环的每一次采样，再到宏观预算的三层漏斗——一个生产级 Agent 的「工程性」，正体现在这些层层递进的失效预期里。回到[第 1 章](/ch01-overview) 的主线地图，现在再走一遍那条链路，每一步你都应该能说出「它失败时怎么办」。*
