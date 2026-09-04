# 第 19 章 优雅降级：被打断、被杀与自我恢复

## 本章导读

前一章讲了「防止失败」。本章讲「**接受失败**」——当失败不可避免时，一个生产级 Agent 如何把伤害控制到最小。

用户不会感谢你的 Agent 永不崩溃，但会记住：Ctrl-C 之后后台命令还在跑、渲染了一半的对话丢了半小时输入、一个失控的子进程吃满了 CPU。自建 Agent 在 demo 里永远不会遇到这些，一旦进入用户手里，**打断、崩溃、悬挂**就是每天的日常。

Codex 的答案是一套完整的「优雅降级协议」：中断分阶段、历史打标记、进程成组杀、崩溃可恢复。这套协议最值得学的不是某个函数，而是它的**思想：每一次失效都应该是显式的、有记号的、可逆的**。

## 源码地图

| 文件 | 职责 | 点评 |
|------|------|------|
| `codex-rs/core/src/tasks/mod.rs` | 任务中止协议：cancel → 宽限 → abort | 三段式中止 |
| `codex-rs/core/src/unified_exec/process.rs` | 进程终止：terminate/interrupt 双通道 | 区分「杀」与「劝退」 |
| `codex-rs/utils/pty/src/process_group.rs` | 进程组、会话脱离、父死信号 | OS 层的兜底 |
| `codex-rs/utils/pty/src/pipe.rs` | 各平台 kill 实现 | Windows Job 对象 |
| `codex-rs/core/src/session/mod.rs` | `interrupted_turn_history_marker` | 被打断的 turn 留档 |
| `codex-rs/rollout/src/recorder.rs` | 断点续写与 flush | 崩溃恢复的地基 |
| `codex-rs/cli/src/state_db_recovery.rs` | 启动时自检 state_db | 起死回生的入口 |

## 核心数据结构

打断一个正在运行的 turn，远不止「abort 一下」：

```rust
// 来源：codex-rs/core/src/tasks/mod.rs:880-935（删节）
async fn handle_task_abort(self: &Arc<Self>, task: RunningTask, reason: TurnAbortReason) {
    if task.cancellation_token.is_cancelled() {
        return;                                  // ← 幂等：重复打断是无害的
    }
    task.cancellation_token.cancel();            // ① 协作式：通知所有 select! 分支退出
    // ...取消 git enrichment、code mode cells...
    select! {
        _ = task.done.notified() => {},          // ② 等任务自己收尾
        _ = tokio::time::sleep(Duration::from_millis(
            GRACEFULL_INTERRUPTION_TIMEOUT_MS)) => {
            warn!("task {sub_id} didn't complete gracefully..."); // ③ 100ms 后
        }
    }
    task.handle.abort();                         //    强制拔管
    session_task.abort(/*...*/).await;           // ④ 走 turn 级 abort 路径
    if reason == TurnAbortReason::Interrupted
        && let Some(marker) = interrupted_turn_history_marker(/*...*/) {
        self.record_conversation_items(/*...marker...); // ⑤ 历史里立碑
    }
}
```

五段式——**幂等检查、协作取消、宽限等待、强制中止、历史标记**。最容易被忽略的是第 ⑤ 步：被打断的 turn 会在历史里留下一个 marker 条目。为什么？见下文「失效的记号」。

进程层同样有两级语义。`terminate()` 是「杀」，`interrupt()` 是「劝退」：

```rust
// 来源：codex-rs/core/src/unified_exec/process.rs:214-241（删节）
pub(super) fn terminate(&self) {
    match &self.process_handle {
        ProcessHandle::Local(process_handle) => process_handle.terminate(),
        ProcessHandle::ExecServer(process_handle) => {
            let handle = Arc::clone(process_handle);
            tokio::spawn(async move { let _ = handle.terminate().await; });
        }
    }
    self.finish_termination();      // ← 同时杀输出任务、关输出 channel
}

pub(super) async fn interrupt(&self) -> Result<(), UnifiedExecError> {
    // Local: signal(PtyProcessSignal::Interrupt) —— 即 SIGINT
    // ...
}
```

`interrupt` 发 SIGINT（等于用户按 Ctrl-C，进程可以捕获并清理），`terminate` 才是真正的 kill。用户说「停下」，Codex 先劝退再动手——顺序不能反。

## 流程走读：三层进程清理保障

「杀掉一条命令」在 Codex 里是三层防御的叠加，缺一层就会有孤儿进程：

```
① 进程组（process_group.rs）
   spawn 时 setpgid → 命令自成一组
   kill 时 kill_process_group(pgid) → 子进程的子进程也一起死
   ⚠️ 不用 kill(pid) 的原因：shell 的孙子进程会漏杀

② 会话脱离 + 父死信号（Linux）
   detach_from_tty() → 非交互子进程不抢控制终端
   set_parent_death_signal(PDEATHSIG, SIGTERM)
   → Codex 进程崩溃时，内核自动给子进程发 SIGTERM
   ⚠️ 这是「我死了你们也别活」的 OS 级遗嘱
   （实现见 process_group.rs:27-42，含 fork/exec 竞态防护）

③ Windows 特例（pipe.rs）
   Job 对象 terminate() 或 kill_process(pid)
   ⚠️ Unix 进程组概念在 Windows 不存在，用 Job 平替
```

第 ② 层值得所有自建 Agent 作者抄写。`PDEATHSIG` 的实现还处理了 fork/exec 竞态（process_group.rs:27-42）：先记录父 pid，`prctl` 之后核对 `getppid()`，不一致就当场自我 SIGTERM——防止「给错人当爹」。

**失效的记号**：第 ⑥ 个要点藏在 rollouts 里。被打断的 turn 写入 `interrupted_turn_history_marker` 后，下次恢复会话时系统能区分「模型说完了」和「用户掐断的」——这两种历史对模型的意义完全不同。恢复后模型会看到「上次说到一半被打断」，而不是对着一个悬空的 `FunctionCall` 猜测发生了什么。这就是第 13 章讲过的 rollout replay 能成立的前提之一。

## 设计取舍

**为什么任务取消要「协作式优先，抢占式兜底」？** 纯抢占（直接 abort task）的问题：正在写 rollout 的写操作被腰斩，文件半截；正在持有的锁不会释放。纯协作（只发信号不强制）的问题：一个卡死的 `.await` 永远等不到。Codex 的答案：`cancellation_token` + `select!`（协作面）+ 100ms 后 `abort()`（保底面）。**100ms 这个数字决定了「优雅的上限」——再长的宽限都只是把卡死任务的自私转嫁给用户**。

**为什么中断是 SIGINT 而不是直接 kill？** 你在终端跑 `cargo build`，想中断是因为「太慢了」，不是「想毁掉 target/ 目录」。SIGINT 让进程自己 flush、清理、写缓存。这与 approval 系统（第 11 章）共享同一个哲学：**默认动作选择可撤销的那一个**。

**对比你的 my-agent**：TS Agent 的「打断」通常是 `AbortController.abort()`——只覆盖了网络请求，正在跑的 `child_process` 完全不受管。要达到 Codex 的水位，你需要：a) spawn 时 `detached: true`（Unix）+ 进程组 kill；b) `process.on('exit')` 里递归杀子进程；c) 崩溃时的 best-effort 清理 handler。这就是从「能跑」到「敢交给用户」的距离。

## 动手实验

亲手验证进程组清理：

```shell
cd codex-rs
rg -n "PDEATHSIG|set_process_group|detach_from_tty" utils/pty/src/process_group.rs
# 预期：PDEATHSIG 仅 Linux 分支；三个函数各一处定义

rg -n "kill_process_group" utils/pty/src/pipe.rs
# 预期：Linux 直接按组杀；macOS 有 member_fallback 变体
# （macOS 的 killpg 对孤儿组有兼容问题，见 fallback 函数注释）
```

观察中断标记在历史里的落点：

```shell
rg -n "interrupted_turn_history_marker" core/src/tasks/mod.rs core/src/session/mod.rs
# 预期：定义与使用分离——tasks 层判断时机，session 层写历史
```

跑一次「被劝退」的命令：

```shell
# 在 codex TUI 里让它执行一个 sleep 100，然后立刻 Esc 中断
# 观察日志：先 interrupt（SIGINT），进程若不退才 terminate
RUST_LOG=codex_core=debug cargo run --bin codex -- exec "sleep 100" &
# 然后给 exec 发 SIGINT，日志里能看到两段式
```

## Rust 侧栏

- **`select!` 作为「先到先得」结构**：中止协议的核心是两个未来赛跑——`done.notified()` vs `sleep(100ms)`。谁先到走谁分支。这是 Rust 异步里表达「带超时的等待」最惯用的形状，比 `timeout()` 更可组合。
- **`notify_one` / `Notified`**：`task.done` 是 `tokio::sync::Notify`——单比特信号量。与 oneshot/watch 的区别：它不携带数据，只为「事件发生过」这件事作证，且不会因无人监听而丢失语义。
- **`prctl(PR_SET_PDEATHSIG)`**：Linux 特有的系统调用，「父进程死亡时给我发信号」。POSIX 没有可移植等价物，所以它被 `#[cfg(target_os = "linux")]` 圈起来——平台特定能力就该显式圈地。
- **`cfg!` vs `#[cfg]`**：前者编译期布尔（代码两个分支都编译，如 `cfg!(debug_assertions)`），后者直接条件剔除代码。`rate_limit_regex` 附近见过前者——用于日志策略。

## 小结 + 思考题

优雅降级 = 幂等的中止协议 + 两级进程信号 + 三层清理保障 + 历史里的失效记号。核心思想：**失效要显式、可区分、可恢复**——用户打断和系统崩溃对下一次会话的意义不同，历史必须能区分它们。

思考题：

1. 100ms 中止宽限里，如果任务正在 `.await` 一个**不可取消**的阻塞（如 `std::fs::write`），abort 能终止它吗？会发生什么？（提示：tokio abort 只作用于 async 任务边界）
2. `PDEATHSIG` 只在 Linux 有效。macOS 上 Codex 靠什么防「Codex 死了子进程还在」？（提示：想想第 11 章沙箱监督进程的设计）
3. 若让你给 my-agent 设计 turn 中断协议，TS 里对应 `cancellation_token` 的原语是什么？宽限期怎么实现？

下一章是最后一章：当单个数字和单层防御都不够时，系统如何用「预算」从宏观上保证不失控。
