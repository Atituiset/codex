---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: Codex CLI 源码深度解读
  text: 面向入门级 Agent 开发者的源码精读
  tagline: 基于 openai/codex（codex-rs）逐函数走读：从一次对话的生命周期，到 Agent Loop、工具系统与安全模型
  actions:
    - theme: brand
      text: 开始阅读 →
      link: /ch01-overview
    - theme: alt
      text: 术语表
      link: /appendix-glossary

features:
  - icon: 🗺️
    title: 全景地图
    details: 100+ Rust crate、3000+ 源文件的产品形态与目录结构，一张主线索地图贯穿全书
  - icon: 🔁
    title: Agent Loop 逐行走读
    details: 第 7 章全书重心：run_turn 主循环、流式事件分发、工具路由与并发执行
  - icon: 🛡️
    title: 安全模型
    details: 三平台沙箱（seatbelt / landlock / windows）、execpolicy 策略引擎与审批流
  - icon: 💾
    title: 持久化与恢复
    details: rollout JSONL 会话记录、sqlite state_db 与崩溃恢复链路
---

# 前言：为什么读 Codex 源码

> 本书基于 openai/codex 仓库 commit **`4f39251a01`**（main 分支，2026-08）撰写。
> 所有代码摘录均来自该基线的 `codex-rs/` 目录，阅读时可随时对照源码。

如果你正在写自己的 Coding Agent——比如一个 TypeScript 版的 my-agent，对标 Claude Code 或 Codex CLI——你大概率已经踩过这些坑：

- Agent Loop 写出来是个 200 行的 while 循环，跑通没问题，但**工具一多就开始失控**：谁来决定哪些工具要审批？命令在沙箱里跑还是直接跑？
- **上下文越滚越长**，token 费用爆炸；想做个"自动压缩历史"，却发现摘要本身也会污染上下文。
- **会话没法恢复**：进程一崩，用户半小时的对话和改动全部丢失。
- 想给 IDE 做个插件，却不知道如何把 Agent 的每一步动作实时推给编辑器。

这些问题，Codex CLI 都在生产环境里回答过。它不是论文，不是 demo，而是每天被大量开发者真实使用的终端 Agent：约 100+ 个 Rust crate、3000 多个源文件，覆盖了配置、认证、模型接入、协议、Agent Loop、工具系统、三平台沙箱、审批流、MCP 扩展、持久化恢复、TUI/IDE/CI 三种产品形态。

**本书的目标**是带你把这个仓库从入口到核心走一遍——不是清单式地罗列模块，而是沿着一次对话的完整生命周期精读源码：用户敲下一句话之后，它经历了哪些数据结构、哪些线程、哪些决策点，最终变成模型请求和工具调用，又如何把结果渲染回屏幕。

读完本书，你应该能回答三个问题：

1. 一个生产级 Coding Agent 的完整运行时是如何运转的？
2. 每个子系统为什么这样设计？取舍是什么？换一种设计会怎样？
3. 自建 Agent 时，哪些设计可以直接借鉴，哪些应该简化？

## 怎么读这本书

- **Part 0 · 导览**（第 1 章）：建立全景地图，搞清产品形态与目录结构，搭好调试环境。
- **Part I · 入门**（第 2–5 章）：跟着一次对话走完全程的外围链路——启动、配置、认证、协议层。
- **Part II · 核心**（第 6–13 章）：Agent Loop 与工具系统。第 7 章是全书重心，逐函数走读 turn 循环。
- **Part III · 进阶专题**（第 14–17 章）：TUI 架构、IDE 集成、无头模式与工程实践。
- **Part IV · Agent 工程学**（第 18–21 章）：从「自建 Agent」的视角提炼可迁移的工程决策——生产参数、优雅降级、失控控制，最后用六元组状态机（Prompt/Loop/Tools/Context/Session/Model）与四条不变量收束全书。

每一章都遵循固定结构：导读 → 源码地图 → 核心数据结构 → 流程走读 → 设计取舍 → 动手实验 → Rust 侧栏 → 小结与思考题。Rust 语言特性不做系统教学，只在侧栏里按需解释。

## 约定

- 类型名、函数名、crate 名保留英文原样并用反引号包裹，如 `CodexThread`、`run_turn()`。
- 统一译法：turn=回合，thread=主线（会话），approval=审批，sandbox=沙箱，compact=压缩，rollout 不翻译（指 JSONL 会话记录）。完整术语表见附录 A。
- 流程图使用 ASCII 字符画，节点名尽量使用真实类型/函数名，方便对照源码。

准备好了吗？先从[第 1 章 全景地图](/ch01-overview)开始。
