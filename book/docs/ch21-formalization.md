# 第 21 章 形式化收束：六维度、四不变量与一个状态机

## 本章导读

全书走完了 20 章。现在退后一步，把看到的一切压进一个尽量小的形式模型里——压得进去，说明源码读懂了；压不进去的地方，恰好是 Codex 最有趣的设计决策。

先给出模型。一个 Coding Agent 是六元组：

```
Agent = Prompt + Loop + Tools + Context + Session + Model
```

六者缺一不可，且可以形式化为一个状态机：

```
State = (Prompt, Context, Session, PendingInput)

Loop  : State -> Model -> (ToolCalls | Text) -> Tools -> State'
         └─ 预算闸 / 取消 / 重试 在每一步可介入

不变量：
  I1  Session.append 为唯一写路径（可重放）
  I2  Prompt 与 ToolSpecs 同快照（StepContext 原子）
  I3  Context = project(Session)（投影，非重写）
  I4  每次 Model 调用受 Token 预算约束
```

本章前半部分**逐维度深挖**：六个维度各自在状态机里扮演什么角色、在源码里的实施点是什么、参与了哪些不变量、工程取舍何在。后半部分做不变量审计——包括 Codex 的两处「合法破坏」。最后用状态机语言复述全书主线。

为什么值得形式化？因为六个维度描述的是**职责划分**，而状态机与不变量描述的是**职责之间的合同**。自建 Agent 的坑几乎从不在某一维内部，而在维间接口：Prompt 变了 Tools 没跟上（I2 违反）、Session 和 Context 边了界（I3 违反）、Loop 没接预算闸（I4 违反）。形式化就是把合同写下来。

## 源码地图

| 维度/不变量 | 实施点 | 相关章节 |
|--------|--------|----------|
| Prompt | `protocol/src/prompts/base_instructions/default.md` + `models.rs:1438` | 第 7 章 |
| Loop | `core/src/session/turn.rs:301` 主循环 + `run_sampling_request` | 第 7 章 |
| Tools | `core/src/session/step_context.rs:44` + `tools/src/tool_spec.rs` | 第 9 章 |
| Context | `core/src/context_manager/history.rs:206` `for_prompt` | 第 8 章 |
| Session | `core/src/session/mod.rs:3062` 唯一写路径 + rollout | 第 6/13 章 |
| Model | `core/src/session/turn.rs:1340` 采样 + `model-provider-info` | 第 4 章 |
| 观测 | `SessionTelemetry` + tracing + `codex-otel` | 横切 |
| 合法破坏① | `mod.rs:3383` `replace_compacted_history` | 第 8/20 章 |
| 合法破坏② | `input_queue.rs` PendingInput 排队 | 第 6 章 |

---

## 维度一：Prompt——「不变量浓度」最高的一维

**状态机角色**：`State` 的第一个分量。但注意精确措辞——Prompt 不是「一段字符串」，而是**结构化的组装结果**：`base_instructions`（系统提示词）+ `input`（来自 Context 的投影）+ `tools`（ToolSpecs 表）+ `output_schema`。`build_prompt` 把这四样打包成一次请求的全部静态面：

```rust
// 来源：codex-rs/core/src/session/turn.rs:1312-1329
pub(crate) fn build_prompt(
    input: Vec<ResponseItem>,
    step_context: &StepContext,
    base_instructions: BaseInstructions,
) -> Prompt {
    let turn_context = &step_context.turn;
    Prompt {
        input,
        tools: step_context.tool_router.model_visible_specs(),
        parallel_tool_calls: true,
        base_instructions,
        output_schema: turn_context.final_output_json_schema.clone(),
        output_schema_strict: !crate::guardian::is_guardian_reviewer_source(
            &turn_context.session_source,
        ),
    }
}
```

**源码实施**：系统提示词本身是一份 275 行的 markdown，**编译期内嵌**进二进制：

```rust
// 来源：codex-rs/protocol/src/models.rs:1438
pub const BASE_INSTRUCTIONS_DEFAULT: &str =
    include_str!("prompts/base_instructions/default.md");
```

275 行里写了什么？人格（简洁直接）、AGENTS.md 规范（作用域、嵌套优先级、与直接指令的优先关系）、沙箱与审批的自描述。**注意自描述性**：模型被告知的规则与系统真正执行的规则（第 11 章审批策略）是同一份——提示词不是文档，是行为合同的对端副本。

**参与的不变量**：I2 的核心。`build_prompt` 的 `tools` 取自 `step_context.tool_router`，`base_instructions` 是 `sess.get_base_instructions()` 的快照（turn.rs:1351）——**两者都不从全局可变状态现场读取**。快照从哪来？`BaseInstructionsProvenance`：

```rust
// 来源：codex-rs/protocol/src/models.rs:1444-1460（删节）
pub enum BaseInstructionsProvenance {
    /// The instructions were explicitly configured and must survive model changes unchanged.
    Custom,
    /// The instructions were generated from this model's instruction template.
    Model { model: String },
}

pub struct BaseInstructions {
    pub text: String,
    /// Missing on rollouts written before base-instruction provenance was persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<BaseInstructionsProvenance>,
}
```

`Custom` = 用户显式配置，**换模型也不许动**；`Model { model }` = 从该模型的 `instructions_template` 生成（openai_models.rs:505-525），模型切换时按需重渲染。会话继承时还有指纹比对（session.rs:708-715）：继承的文本若恰好等于新模型的模板产出，则改记为 `Model` 来源——**漂移检测在继承时就做完**。

**工程取舍**：为什么用 `include_str!` 而不是运行时读文件？二进制分发的 Agent 不能依赖外部资源路径（npm 壳只是转调器，第 2 章）；且提示词与代码**同版本同 review**——改提示词和改代码走同一个 PR、同一个 diff 审查。为什么 per-model 模板而不是一份通吃？模型的工具调用格式、reasoning 习惯、输出癖好各不相同（第 4 章 provider 抽象），模板变量（`instructions_variables`）+ `PERSONALITY_PLACEHOLDER` 替换让一份模板服务多个人格配置。

---

## 维度二：Loop——状态机的发动机与「合同签署人」

**状态机角色**：`Loop : State -> Model -> ... -> State'` 的执行者。全部不变量在 Loop 里被签署执行——它调 `build_prompt`（I2）、取投影（I3）、写历史走唯一入口（I1）、记预算账（I4）。

**源码实施**：主循环在 turn.rs:301，采样循环嵌套在 `run_sampling_request`（turn.rs:1340）内部——**双层结构**：外层是「回合循环」（一个 turn 可以有多个采样步），内层是「采样重试循环」（第 18 章的重试/降级闸就装在这里）。看内层圈的关键四行：

```rust
// 来源：codex-rs/core/src/session/turn.rs:1366-1372（删节）
    loop {
        let prompt_input = if let Some(input) = initial_input.take() {
            input
        } else {
            sess.clone_history().await          // ← 每次重试重新投影
                .for_prompt(&step_context.model_info.input_modalities)
        };
```

注意这个细节：**重试时不是拿旧 prompt 重发，而是从历史重新投影**。因为失败的那次请求可能已经执行了部分工具调用并写进了历史（I1 保证了写入确实发生），重新投影才能把「已执行」如实带上——直接重发旧 payload 会造成重复执行。

外层圈里，`should_roll_over`（turn.rs:458-470）决定继续还是结束：模型还要调工具 → 继续；`token_limit_reached` → 压缩后 `continue`；模型给了终答 → 出循环。源码注释对「无限循环」的态度值得抄录：压缩工作正常时无需担心无限循环——**Loop 敢无上限，是因为闸门在圈内**（I4）。

**参与的不变量**：全部。Loop 是唯一同时接触六个维度的地方，所以它必须是**最薄的层**——只做调度，不做业务。你看 `run_sampling_request` 的签名（turn.rs:1340-1350）：参数是 session、step_context、cancellation_token……全是「别人的状态」，Loop 自己几乎不持有状态。这是调度层的纪律：**有状态的层不调度，调度的层无状态**。

**工程取舍**：为什么不用队列/事件驱动而用显式 `loop` + `select!`？可审计性。一次 turn 的完整行为可以顺着循环体线性读完（第 7 章就是这么做的）；事件驱动架构里同样的逻辑散布在 N 个 handler，时序只有运行时才知道。代价是循环体长（近 600 行的 `try_run_sampling_request`，第 7 章吐槽过）——但**可读性的问题可以靠拆函数修，时序不可见的问题只能靠重构修**。

---

## 维度三：Tools——「时间」的凝固与仲裁

**状态机角色**：`State -> ... -> Tools -> State'` 的中转站。ToolCalls 的执行结果必须回流成 `State'`——所以 Tools 的全部复杂度都在回答两个问题：**模型此刻能看见什么工具（I2），执行结果如何可靠地回到历史（I1）**。

**源码实施**：先看「凝固」。`StepContext` 把工具世界冻结成值：

```rust
// 来源：codex-rs/core/src/session/step_context.rs:17-47（删节）
/// Request-scoped state that may change between model sampling requests.
pub(crate) struct StepContext {
    pub(crate) turn: Arc<TurnContext>,
    /// Concrete model and capabilities used by this sampling request.
    pub(crate) model_info: Arc<ModelInfo>,
    /// Effective approval policy used by this sampling request's tool actions.
    /// Model-specific Guardian requirements can change this during a model switch.
    pub(crate) approval_policy: AskForApproval,
    /// The exact MCP connections, configuration, and catalog captured for this step.
    pub(crate) mcp: Arc<McpBinding>,
    /// The finalized tool plan advertised and executed for this exact sampling request.
    pub(crate) tool_router: Arc<ToolRouter>,
    /// The canonical AGENTS.md value observed with this environment snapshot.
    pub(crate) loaded_agents_md: Option<Arc<LoadedAgentsMd>>,
}
```

doc 注释里反复出现的 `this sampling request`、`this exact step` 不是废话——**`StepContext` 的存在意义就是把时间冻结成值**。模型切换、审批策略变化、MCP server 上下线，都只能在步间生效（`capture_step_context`，mod.rs:3160，每步开始时重新捕获），步内绝不变。

再看「仲裁」。审批闸（第 11 章）装在 orchestrator：每个 ToolCall 执行前问一次 `AskForApproval` 策略，需要用户批准的先挂起。为什么闸在 Tools 维而不是 Loop 维？因为**批准的对象是具体动作**（这条命令、这个文件写），只有工具层有足够的上下文（命令字符串、diff 内容、沙箱逃逸分析）来陈述「要批准什么」。Loop 只知道「有一个 FunctionCall 要执行」。

**参与的不变量**：I2 的另一半。`build_prompt` 广告的工具表与 orchestrator 执行用的路由是**同一个 `Arc<ToolRouter>` 的两次借用**——「宣传的」与「能执行的」物理上是同一份数据。模型永远不会调用到快照里没有的工具（它根本看不见），执行器也永远不会执行快照外的工具（它拿不到）。

**工程取舍**：为什么审批在 Codex 里是同步阻塞（turn 挂起等用户）而不是异步回调？因为 Agent 的会话语义是**单线程叙事**：用户输入 → 模型思考 → 工具执行 → 结果，审批是叙事中的一个结点。异步审批（先跳过、用户批了再回来）会破坏 I1 的叙事顺序——历史里出现「跳过执行的工具调用」，重放时语义不明。多 agent 场景（mailbox，第 7 章）已经把这个模型推广到了非单线叙事，那是这套约束的合法延伸，而非打破。

---

## 维度四：Context——投影与「记忆的物理层」

**状态机角色**：`Context = project(Session)`。State 分量里它是**最被动**的：不主动产生信息，只决定「哪些历史、以什么形态、发多少」。

**源码实施**：投影本体三行：

```rust
// 来源：codex-rs/core/src/context_manager/history.rs:206-221（删节）
    pub(crate) fn for_prompt(self, input_modalities: &[InputModality]) -> Vec<ResponseItem> {
        self.for_prompt_annotated(input_modalities)   // ← 同一函数链
            .into_iter()
            .map(ResponseItemEnvelope::into_item)
            .collect()
    }

    pub(crate) fn for_prompt_annotated(
        mut self,
        input_modalities: &[InputModality],
    ) -> Vec<ResponseItemEnvelope> {
        self.normalize_history(input_modalities);   // ← 投影前的形状修复
        Arc::unwrap_or_clone(self.items)
    }
```

但 Context 维度的真正深度在投影的**外沿**——那些决定投影质量的机制，全在第 8 章：

- **模态过滤**：`input_modalities` 决定图像条目去留——多模态模型与纯文本模型对同一 Session 投影出不同的 Context；
- **压缩**（第 8/20 章）：窗口水位超 90% 时，投影逻辑升级为「摘要替换原历史」——唯一的合法破坏①，见下文；
- **缓存稳定性**：`normalize_history` 的 UUIDv5 合成 ID（normalize.rs:146-153）让投影的前缀字节级稳定，直连 prompt caching 的前缀匹配——**投影的设计直接影响价格**；
- **注入纪律**：所有进入投影的合成条目（环境上下文、预算提醒、`AGENTS.md`）必须是 `ContextualUserFragment`（fragment.rs:14-46），**有界、显式、可审计**——第 20 章的余额提醒就是这么进来的。

**参与的不变量**：I3 全部，且是唯一「知道自己可被牺牲」的维度——投影丢了重算即可，Session 无损。

**工程取舍**：为什么不把 Context 做成增量（只发 delta）？两个原因：其一，无状态请求的容错性——任何一次失败重发全量投影即可，不用维护 delta 链；其二，服务端 prompt caching 的粒度是**前缀**，稳定前缀全量重发反而命中缓存（第 17 章实验）。WebSocket 路径有增量优化（`get_incremental_items`，第 4 章），那是传输层的合法优化，语义层仍是全量投影。

---

## 维度五：Session——真相源与「唯一写路径」

**状态机角色**：`Session.append` 为唯一写路径（I1）——Session 是**唯一真相源**（source of truth），其他一切都是它的视图或投影。

**源码实施**：所有新条目流经同一个入口：

```rust
// 来源：codex-rs/core/src/session/mod.rs:3062-3076（删节）
pub(crate) async fn record_conversation_items(
    &self,
    turn_context: &TurnContext,
    items: &[ResponseItem],
) {
    let (items, image_preparations) =
        self.prepare_conversation_items_for_history(turn_context, items); // ← 规范化
    let items = items
        .into_owned()
        .into_iter()
        .map(ResponseItemEnvelope::new)      // ← 统一信封：条目 + 元数据
        .collect();
    self.record_prepared_conversation_items(turn_context, items, image_preparations)
        .await;                              // ← 唯一落点：历史 + rollout 同步写
}
```

**「唯一入口」的直接回报是可重放**（第 13 章）：rollout JSONL 是 Session 的逐条镜像，重放即重建——崩溃恢复、`codex resume`、多端同步全部免费获得。这就是不变量的经济学：**一次纪律，三个特性**。反过来，散布式写入（my-agent 的 `messages.push()` 在 N 个文件）从结构上排除重放——谁也不知道漏记了哪条 push。Codex 把写入收敛成 pub(crate) 方法，让编译器帮你数入口。

Session 与 State 的对应关系值得精确一遍：`State = (Prompt, Context, Session, PendingInput)` 里，Session 是真相源，Context 是投影，Prompt 是请求级组装，PendingInput 是输入缓冲——**四个分量里三个是 Session 的视图**。状态机的「状态迁移」本质上几乎全是 Session 的 append。

**工程取舍**：为什么 rollout 是 JSONL 而不是 sqlite（state_db 明明是 sqlite）？**读写模式不同**：历史是 append-only 顺序流，JSONL 天然匹配（且与重放语义同构）；state_db 存的是**索引/聚合**（线程列表、审计、内存），需要随机查询。第 13 章的分库设计本质是 CQRS 的朴素形态：命令侧 JSONL、查询侧 sqlite。

---

## 维度六：Model——被隔离的「不可控因素」

**状态机角色**：`State -> Model -> (ToolCalls | Text)` 的右端。Model 是六维里**唯一完全不可控**的维度——你只能选它（provider 抽象）、喂它（Prompt）、防它（预算闸、重试闸），不能改它。

**源码实施**：不可控性被两层抽象吸收：

- **`ModelInfo`**（protocol/src/openai_models.rs）：模型的**能力声明**——上下文窗口、输入模态、压缩支持、指令模板。`StepContext.model_info` 就是它的快照（I2）。全部决策逻辑问的是能力而非身份：`auto_compact_token_limit` 问 `resolved_context_window`，投影问 `input_modalities`，压缩问 `RemoteCompactionSupport`。**对模型编程而非对具体模型编程**。
- **`ModelProviderInfo`**（model-provider-info）：模型的**接入面**——base_url、wire API（responses vs chat）、重试参数、流超时。第 18 章的参数表全部住在这里。

采样调用本身则把「Model 可能怎样坏」写成穷尽 match（turn.rs:1398-1415）：`ContextWindowExceeded` → 标记窗口满（触发压缩路径）；`UsageLimitReached` → 更新速率限制并终止（不可重试）；其他 → 进第 18 章的重试状态机。**每种失败都有对应的 State 变更**——失败也是状态迁移，不是异常控制流。

**参与的不变量**：I4 的作用对象。预算闸约束的就是 Model 调用——第 20 章的三层漏斗（水位提醒→压缩→会话树预算）逐层拦住失控的采样。

**工程取舍**：为什么 Model 维不持有任何业务逻辑？因为它是**最大的变化源**——换模型、换 provider、换 API 版本都不该影响其他五维。Codex 的做法是把 Model 相关的一切收敛进两个 info 结构 + 一个 client 层，接口边界上只流通「能力」和「事件」。你的 my-agent 应当抄这条：**模型相关代码的 LOC 占比，是架构健康度的反向指标**。

---

## 横切维度：观测——为状态机装上仪表盘

六元组之外必须补一个横切面。你的框架里画了 `▲ └─ 观测（Trace/Metrics）`——它不属于任何一维，却**依赖所有维的纪律**才能做好：

- **Trace**：`#[tracing::instrument]` 沿调用链传播 `turn_id`/`trace_id`（第 7 章侧栏讲过 instrument 约定）——一次 turn 的完整轨迹可从日志线性重建。观测粒度对齐了状态机的步：**每个采样步、每个工具调用、每次重试都是一个 span**。
- **Metrics**：`codex-diagnostics` 的 Gauge（如 input_queue.rs:17 的 `PENDING_MAILBOX_MESSAGES`）暴露 State 分量的水位——队列深度、token 余额（第 20 章 `maybe_record` 的记录面）。
- **审计**：rollout 本身就是最高级的观测——**因为 I1，观测与真相同源**。这不是巧合：可重放性（I1）+ 可观测性（trace/metrics）共用同一条纪律。对比 my-agent：日志和会话存储各写各的，「日志说的」和「实际发生的」永远对不上账。

---

## 不变量审计：两处合法破坏

严格的不变量会杀死必要的功能。Codex 的做法不是删掉不变量，而是**把破坏做成协议**。

**破坏①：压缩重写历史**（`replace_compacted_history`，mod.rs:3383）。物理上替换了整个 history，违反 I3 与 I1 精神。但看它如何破坏：替换走**唯一的写方法族**、rollout 同步写入 `RolloutItem::Compacted`（含 `replacement_history`，重放器知道发生过替换，第 13 章）、替换后 `history_version` 递增（history.rs:50）使旧投影引用失效。准确说法：压缩把 I1 从「append-only」升级为「append + 带 tombstone 的 replace」——**不变量没有被删除，被版本化了**。

**破坏②：PendingInput 的存在**。输入在成为历史条目之前，先存在于非 append-only 的队列（input_queue.rs）——I1 的缓冲破坏。代价是状态机必须回答「队列何时排空、能否插队（steer，第 7 章）、崩溃时丢不丢」——`steer_input` 与 `drain_in_flight`（turn.rs:2130）的全部复杂度都来自这个决定。收益：**模型的采样原子性不被用户敲键盘打断**，`Esc`（打断）与「继续输入」正交。

---

## 用状态机重读全书主线

把第 1 章的全景链路翻译成状态机语言，作为收束：

```
Op::TurnInput(PendingInput 入队)
   │
   ▼
Loop 单圈（turn.rs:301 的 loop）：
   State 组装：capture StepContext（I2：Prompt 与 ToolSpecs 同快照）
        │
        ▼  build_prompt(input = Context 投影, tools = 同快照)     ← I3
   Model 采样（run_sampling_request，重试/降级闸：Ch18）
        │
        ├── ToolCalls ──► Tools 执行（审批闸：Ch11；沙箱：Ch11）
        │        │  结果 ──► record_conversation_items（I1 唯一写路径）
        │        ▼
        │    记账：token_budget::maybe_record（I4）──── 超限 ──► 压缩（合法破坏①）
        │        │ 未超限
        │        ▼
        └── Text（终答）──► record_conversation_items ──► turn 结束
                                 │
                                 ▼
   PendingInput 检查：drain_in_flight（合法破坏②）── 有积压 ──► 新 turn
```

六元组、双层循环、四条不变量、两个合法破坏、一个横切观测面——这是全书一万多行源码走读能压缩出来的最大密度。如果只带走一句话：**Agent 工程的全部难点，不在让 Loop 转起来，而在让 Loop 转一万圈之后，Session 依然可信、Context 依然有界、预算依然未爆**。

## 动手实验

逐维度验证实施点：

```shell
cd codex-rs
# Prompt：编译期内嵌 + 溯源
head -5 protocol/src/prompts/base_instructions/default.md   # 275 行的「出厂人格」
rg -n "BaseInstructionsProvenance" protocol/src/models.rs    # Custom vs Model 双源

# Loop：双层结构
rg -n "loop \{" core/src/session/turn.rs                     # 预期：301(回合) / 1368(重试) / 2250(输出事件)

# Tools：快照冻结
rg -n "this exact step|this sampling request" core/src/session/step_context.rs  # doc 注释的快照宣言

# Context：投影
rg -n "fn for_prompt" core/src/context_manager/history.rs    # 206

# Session：唯一写路径
rg -n "record_conversation_items" core/src/session/mod.rs | wc -l   # 定义 + 全部入口调用

# Model：能力抽象
rg -n "input_modalities" protocol/src/openai_models.rs | head -3
```

亲手触发一次「合法破坏」的完整落盘：

```shell
# 触发一次自动压缩（见第 20 章实验），然后：
rg -n "Compacted" rollout/src/rollout_payload.rs | head -3
# 预期：wire 标记 "compacted" 与 replacement_history 字段
```

## 思考题

1. 六维中哪一维在你的 my-agent 里最薄？多数 TS Agent 的答案恰好是 Session（没有唯一写路径）与 Context（数组即历史，投影即本体）——为什么这两维最容易被忽视？（提示：框架教程从 Loop 和 Tools 开始教）
2. I2 说「Prompt 与 ToolSpecs 同快照」。如果 Codex 支持「采样中途动态卸载一个 MCP server」，I2 会要求发生什么？现状（步间生效）是唯一解吗？
3. 把四条不变量按「实现成本」排序。I1 需要写路径收敛，I3 需要双结构分离——哪条对语言/运行时有硬要求？哪条纯靠纪律？（提示：想想 I2 的「把时间冻结成值」对 TS 对象引用意味着什么）
4. 你的框架把观测画成指向 Loop 的箭头。基于本章的审计，观测最应该对齐的其实是**哪个数据结构**？为什么？（提示：与真相同源的那个）

---

*从 npm 壳的第一行 spawn，到这里的一个状态机——全书的源码证据链闭合了。回到[前言](/) 的问题：「自建 Agent 时，哪些设计可以直接借鉴？」现在你有了带着源码坐标系的答案。*
