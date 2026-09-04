# 第 18 章 生产参数手册：超时、重试与预算的全部数字

## 本章导读

读完前 17 章，你已经知道 Codex「怎么运转」。本章换一个视角——**如果你要自己造一个 Codex，你会抄哪些作业？**

自建 Agent 最常见的翻车现场不是逻辑写错，而是**没写防御**：模型流断了你才发现没有重连逻辑、命令输出 2GB 把进程 OOM、用户按了 Ctrl-C 但后台还在跑。这些问题的共同点是——**解法都是数字**：超时多久、重试几次、退避多长、缓冲多大、预算多少。而这些数字在 Codex 里全部有明确出处，不是拍脑袋。

本章把这些散落在十几个文件里的防御参数收拢成一张「生产参数表」。每个数字都标注源码出处与推导理由。你可以直接把这张表抄进 my-agent 的配置里——这是全书里 ROI 最高的一页。

## 源码地图

| 文件 | 职责 | 点评 |
|------|------|------|
| `codex-rs/model-provider-info/src/lib.rs` | 流重试/请求重试/空闲超时的默认值与硬上限 | 生产参数的「宪法」 |
| `codex-rs/core/src/util.rs` | 指数退避 + 抖动函数 `backoff()` | 6 行代码的标准答案 |
| `codex-rs/core/src/responses_retry.rs` | 流重试状态机 + WebSocket→HTTPS 降级 | 双层防线的第二层 |
| `codex-rs/protocol/src/error.rs` | 错误分类：哪些可重试、哪些不可 | 重试的前提是分类 |
| `codex-rs/codex-api/src/sse/responses.rs` | 从错误消息里解析 `Retry-After` | 服务端说了算的优雅处理 |
| `codex-rs/core/src/tasks/mod.rs` | 任务中止：100ms 宽限 + abort | 用户打断的最后一击 |
| `codex-rs/utils/pty/src/process_group.rs` | 进程组信号、父死信号 | 「杀死命令」的底层保障 |

## 核心数据结构：一张参数总表

先上结论——Codex 防御体系的全部关键数字：

| 参数 | 默认值 | 硬上限/备注 | 出处 |
|------|--------|-------------|------|
| 流空闲超时 `stream_idle_timeout` | 300s | 可按 provider 配置 | model-provider-info/src/lib.rs:27 |
| 流重试次数 `stream_max_retries` | 5 | 100 | lib.rs:28、365 |
| 请求重试次数 `request_max_retries` | 4 | 100 | lib.rs:29 |
| WebSocket 连接超时 | 15s | — | lib.rs:31 |
| 初始退避 `INITIAL_DELAY_MS` | 200ms | — | core/src/util.rs:6 |
| 退避因子 `BACKOFF_FACTOR` | 2.0 | ±10% 抖动 | core/src/util.rs:7、89 |
| 连接重试退避 | 5s 起，×2，封顶 60s | 需开启 feature | core/src/responses_retry.rs:17-18 |
| 任务中止宽限 | 100ms 后强制 abort | — | core/src/tasks/mod.rs:66 |
| 命令输出缓冲 | 1 MiB | 头尾各半 | core/src/unified_exec/mod.rs:75 |
| 输出事件上限 | 8 KiB/事件 | — | unified_exec/async_watcher.rs:41 |
| 自动压缩阈值 | 上下文窗口 × 90% | 可配但被 clamp | openai_models.rs:486-497 |
| 压缩摘要上限 | 20_000 tokens | — | core/src/compact.rs:57 |

读这张表有个关键心得：**每个参数都有两个层次——默认值与硬上限**。这是防止用户配置把自己坑死的经典手法：

```rust
// 来源：codex-rs/model-provider-info/src/lib.rs:25-38
/// Hard cap for user-configured `stream_max_retries`.
const MAX_STREAM_MAX_RETRIES: u64 = 100;
/// Hard cap for user-configured `request_max_retries`.
const MAX_REQUEST_MAX_RETRIES: u64 = 100;

const DEFAULT_STREAM_IDLE_TIMEOUT_MS: u64 = 300_000;
const DEFAULT_STREAM_MAX_RETRIES: u64 = 5;
const DEFAULT_REQUEST_MAX_RETRIES: u64 = 4;
```

```rust
// 来源：codex-rs/model-provider-info/src/lib.rs:362-368
    pub fn stream_max_retries(&self) -> u64 {
        self.stream_max_retries
            .unwrap_or(DEFAULT_STREAM_MAX_RETRIES)   // ← 未配置用默认值
            .min(MAX_STREAM_MAX_RETRIES)            // ← 配置再大也压回 100
    }
```

my-agent 若允许用户配重试次数，`min()` 那一行就是你的必修课。

## 流程走读：一次流断之后的完整防线

假设模型正在流式返回，第 3 个 SSE chunk 后连接断了。这时发生什么？

```
SSE/WebSocket 流中断（Timeout / ConnectionFailed / 5xx）
   │
   ▼
error.rs::is_retryable() ──── 不可重试（QuotaExceeded 等）──► 直接上报用户
   │ 可重试
   ▼
handle_retryable_response_stream_error()          (responses_retry.rs:44)
   │
   ├─ 服务端给了延迟提示？
   │    └─ 是 → try_parse_retry_after() 解析 "try again in 11.054s"
   │            └─ error.retry_delay() 直接采用，不用自己的 backoff
   │         （sse/responses.rs:654-681，正则 (?i)try again in (\d+) (s|ms)）
   │
   ├─ 否则 → backoff(retry_count)：
   │         200ms × 2^(n-1) × jitter(0.9~1.1)
   │         = 第1次约200ms，第2次400ms，第3次800ms…（±10%）
   │
   ▼
第 N 次重试仍失败 && 用的是 WebSocket？
   │
   ▼
try_switch_fallback_transport()  ── WebSocket 降级为 HTTPS
   │  (responses_retry.rs:86-99；重试计数清零，重来一轮)
   ▼
再失败 max_retries 次 ──► Err 上抛，turn 以错误结束
```

三个值得抄的细节：

**第一，服务端优先于本地策略。** 退避算法是「猜」，`Retry-After` 是「告知」。注意它连单位都解析了：

```rust
// 来源：codex-rs/codex-api/src/sse/responses.rs:711-716
    RE.get_or_init(|| {
        regex_lite::Regex::new(
            r"(?i)try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)"
        ).unwrap()
    })
```

**第二，抖动用乘法不做加法。** `random_range(0.9..1.1)`（util.rs:89）而不是 ±固定毫秒——因为退避到秒级之后，固定毫秒抖动毫无作用。百分比抖动在任何量级都有效。

**第三，双层防线**：流内重试（chunk 断了续传）与传输降级（WebSocket 整体切 HTTPS）是独立的两层。你的 my-agent 大概率只有一层——甚至没有。

## 超时的三层结构

「超时」不是一个数，是三层嵌套的定时体系：

1. **HTTP 请求超时**：单次请求等待响应头的时限（`RetryConfig` 之外的连接层）。
2. **流空闲超时**：300s（lib.rs:27）——不是「整个流最多跑 300s」，而是「**任意相邻两个事件之间**最多等 300s」。这个区别是本质的：一个长回答可以有 10 分钟，只要 token 在持续到达。
3. **压缩请求超时**：`stream_idle_timeout × COMPACT_REQUEST_TIMEOUT_IDLE_MULTIPLIER`（core/src/client.rs:647-649）——因为压缩请求的 prompt 特别长，超时按比例放大。

my-agent 常见错误是把第 2 层做成第 1 层（「整个请求 30s 超时」），于是长回答必然被掐死。正确语义是 **watchdog：喂狗就续命，不喂才咬**。

## 设计取舍

**为什么默认值这么保守？** 300s 空闲 + 5 次重试，最坏情况用户盯着屏幕等半小时？不是——因为每次重试前都 `notify_stream_error` 推送 `Reconnecting... n/5` 给 UI（responses_retry.rs:113-121）。用户始终知道发生了什么，就不会觉得是死机。**重试与静默是敌人：宁可暴露重试，不可假装没断**。有意思的是它还区分 debug/release：release 下第一次 WebSocket 重试不通知（大概率瞬断自愈），debug 下全量显示。

**为什么压缩超时用乘法而不是独立配置？** 一个新配置项的认知成本 ≈ 文档 + 错误信息 + 用户心智负担。用已有参数推导（×multiplier）得到的值 90% 场景都对——这是「参数经济学」：**能推导的不要让用户配**。

**对比你的 my-agent（TypeScript 版）**：多数 TS Agent 的重试是 `p-retry` 默认配置（3 次固定退避），没有：a) 错误分类（429 和 401 都重试）；b) Retry-After 解析；c) 抖动；d) 降级传输。抄这张表大概 150 行 TS 代码，但它会把你的 Agent 从「demo 级」提到「敢连生产 API」的级别。

## 动手实验

观察参数的运行时取值：

```shell
cd codex-rs
rg -n "INITIAL_DELAY_MS|BACKOFF_FACTOR" core/src/util.rs
# 预期：6-7 行，200 与 2.0

rg -n "DEFAULT_STREAM_MAX_RETRIES|MAX_STREAM_MAX_RETRIES" \
  model-provider-info/src/lib.rs
# 预期：默认 5，上限 100，两个 const 分居两处

rg -n "GRACEFULL" core/src/tasks/mod.rs
# 预期：100ms 宽限常量 + 两处使用（select! 竞争 done 通知）
```

亲手体验退避序列：

```rust
// 任意 Rust playground / 单测里
for n in 1..=6 {
    println!("attempt {n}: {:?}", backoff(n as u64));
}
// 预期：约 200/400/800/1600/3200/6400ms，每次 ±10% 随机
```

## Rust 侧栏

- **`Duration::from_millis` / `from_secs_f64`**：`try_parse_retry_after` 解析 `11.054s` 用的是 `from_secs_f64`——秒可以带小数，毫秒走 `from_millis`。
- **`OnceLock` 静态初始化**：`rate_limit_regex()`（sse/responses.rs:711）用 `OnceLock<Regex>` 把「编译正则」变成首次调用时一次、之后零成本。TS 里对应的是模块级 `const`，但 Rust 的 `static` 需要 `OnceLock`/`Lazy` 才能装运行期构造的值。
- **`saturating_mul`/`min`**：退避翻倍用 `saturating_mul(2).min(MAX)`（responses_retry.rs:79-80）——防溢出与防超限一行搞定。数值防御性编程的日常。
- **`#[expect(...)]`**：`expect(clippy::unwrap_used)` 是比 `#[allow]` 更强的写法——若未来该 lint 不再触发会编译报错，防止「永久 allow」漂移。

## 小结 + 思考题

本章把 Codex 防御体系的 12 个关键数字收成一张表：默认值 + 硬上限的两层结构、服务端优先的退避、三层超时语义、100ms 中止宽限。这些数字每一个都对应一次真实故障的教训。

思考题：

1. `stream_idle_timeout = 300s` 对本地 Ollama 合适吗？你会怎么为慢模型调这个值？（提示：`model-provider-info` 的 per-provider 字段）
2. `backoff()` 抖动范围 0.9~1.1。为什么不用 0.5~1.5？什么时候**应该**扩大抖动？（提示：想想很多客户端同时收到 429 的场景）
3. 中止流程 100ms 宽限后 abort——但正在写的 rollout 文件怎么办？谁负责刷盘？（提示：回看第 13 章 recorder 的 flush 时机）

下一章把视角从「数字」升到「失效模式」：当这些防线全部被击穿，系统如何优雅地死。
