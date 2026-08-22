# 《Codex CLI 源码深度解读》写作风格指南（内部规范，不进目录）

本书基于 openai/codex 仓库 commit `4f39251a01`（main 分支）撰写。所有源码引用必须来自该基线。

## 每章固定结构（8 节，标题可微调但顺序不变）

1. `## 本章导读` — 该子系统解决什么真实问题；与读者自己写 Agent 的痛点挂钩。2-4 段。
2. `## 源码地图` — 涉及文件清单表格：| 文件 | 职责 | 一句话点评 |。路径写法：`codex-rs/<crate>/src/<file>`。
3. `## 核心数据结构` — 带中文注释的真实代码块（见下方代码规范），每个结构讲清字段为何存在。
4. `## 流程走读` — ASCII/Unicode 字符画流程图 + 关键函数逐段讲解，串起完整调用链。这是章节主体。
5. `## 设计取舍` — 为什么这样设计？对比其它方案（至少一处对比"如果你自己在 TypeScript 里写 my-agent 会怎么做"）。坦诚指出局限与演进方向。
6. `## 动手实验` — 可运行的观察命令（rg/cargo run/log 观察），标注预期输出形态。
7. `## Rust 侧栏` — 本章用到的语言特性简释（面向会一点 Rust 的读者），每条 3-6 行，用 blockquote 或列表。
8. `## 小结 + 思考题` — 3-5 句小结 + 2-4 道思考题（鼓励读者回源码验证）。

## 代码块硬规范

- 所有代码摘自真实源码，禁止凭记忆编造 API、函数签名、路径。
- 每个代码块上方用注释标明来源：`// 来源：codex-rs/core/src/session/turn.rs`
- 删节处用 `// ...` 并保证上下文仍能读懂；允许为讲解加中文行尾注释，格式统一 `// ← 中文注解`
- 引用函数时给出 `文件路径:大致行号区间`（如 turn.rs:120-180），行号允许 ±20 偏差，但必须先实际读过该文件确认存在。
- 写作前必须用 Read/Grep 实际读取源文件。宁可少引一段代码，不可编造。

## 流程图规范

用 ASCII/Unicode 字符画（零依赖），例如：

```
用户输入
   │
   ▼
Op::TurnInput ──► SessionIo ──► 任务队列 ──► RegularTask::run()
                                                │
                                    ┌───────────┴───────────┐
                                    ▼                       ▼
                              run_turn()              TurnStarted 事件
```

图宽 ≤ 80 列。图中节点名尽量使用真实类型/函数名。

## 统一术语表（中文正文用左列译法，首次出现括注英文）

| 中文 | 英文原文 | 备注 |
|------|----------|------|
| 回合 | turn | 首次出现写「回合（turn）」 |
| 主线 / 会话主线 | thread | 原 conversation，CodexThread 类型名保留英文 |
| 会话 | session | Session 类型 |
| 事件 | event | EventMsg 等 |
| 条目 | item | ThreadItem/ResponseItem 中的 Item |
| 审批 | approval | AskForApproval / ReviewDecision |
| 沙箱 | sandbox | seatbelt/landlock 等保留英文 |
| 工具调用 | tool call | |
| 上下文窗口 | context window | |
| 压缩 | compact/compaction | 摘要压缩对话历史 |
| rollout（不翻译） | rollout | JSONL 会话文件，rollout 不翻译 |
| 提供方 | provider | model provider |

类型名、函数名、crate 名一律保留英文原样，用反引号包裹。

## 行文要求

- 深入到源码逻辑层，拒绝清单式罗列。每个结论都要有源码证据支撑。
- 面向「有 TS 项目经验、会一点 Rust」的读者：Rust 语法靠侧栏解释，不展开教学。
- 多用「为什么」：为什么用 mpsc channel？为什么 Event 与 Op 分开？为什么工具要先审批再执行？
- 对比锚点：读者的 my-agent 项目（TypeScript，对标 Claude Code/Codex CLI 的简易 Agent），在「设计取舍」节至少出现一次实质对比。
- 每章篇幅约 500-900 行 markdown；第 7 章（全书重心）可到 1100 行。
- 章内交叉引用格式：`详见[第 9 章](ch09-tools.md)`；文件名必须与 SUMMARY.md 一致。

## 禁止事项

- 不要修改仓库中任何现有文件；只写入分配给你的那一个章节文件。
- 不要运行 cargo build/test/just（浪费时间且无必要）；只做只读的 rg/grep/read。
- 不要在书中出现「作为 AI」「本助手」等措辞；以技术作者口吻行文。
- 不要罗列大段无关代码凑字数；每段代码都要被讲解消化。
