import { defineConfig } from 'vitepress'

// 与 SUMMARY.md 对应的导航/侧栏结构
const part = (text, items) => ({ text, items })
const chapter = (text, link) => ({ text, link: `/${link.replace(/\.md$/, '')}` })

export default defineConfig({
  lang: 'zh-CN',
  title: 'Codex CLI 源码深度解读',
  description:
    '面向入门级 Agent 开发者的 OpenAI Codex CLI（codex-rs）源码精读：从一次对话的生命周期，到 Agent Loop、工具系统与安全模型',
  head: [['meta', { name: 'og:title', content: 'Codex CLI 源码深度解读' }]],

  themeConfig: {
    siteTitle: 'Codex CLI 源码深度解读',

    nav: [
      { text: '前言', link: '/' },
      { text: '导览', link: '/ch01-overview' },
      { text: '入门', link: '/ch02-startup' },
      { text: '核心', link: '/ch07-agent-loop' },
      { text: '进阶', link: '/ch14-tui' },
      { text: '工程学', link: '/ch18-production-params' },
      { text: '术语表', link: '/appendix-glossary' },
    ],

    sidebar: [
      {
        text: '前言',
        items: [chapter('为什么读 Codex 源码', 'index.md')],
      },
      part('Part 0 · 导览', [
        chapter('第 1 章 全景地图', 'ch01-overview.md'),
      ]),
      part('Part I · 入门：跟着一次对话走完全程', [
        chapter('第 2 章 启动链路', 'ch02-startup.md'),
        chapter('第 3 章 配置系统', 'ch03-config.md'),
        chapter('第 4 章 认证与模型接入', 'ch04-auth-model.md'),
        chapter('第 5 章 协议层', 'ch05-protocol.md'),
      ]),
      part('Part II · 核心：Agent Loop 与工具系统', [
        chapter('第 6 章 会话核心', 'ch06-core-session.md'),
        chapter('第 7 章 Agent Loop 详解（全书重心）', 'ch07-agent-loop.md'),
        chapter('第 8 章 上下文管理与压缩', 'ch08-context-compact.md'),
        chapter('第 9 章 工具系统', 'ch09-tools.md'),
        chapter('第 10 章 Shell 执行与 apply_patch', 'ch10-shell-applypatch.md'),
        chapter('第 11 章 沙箱与审批安全模型', 'ch11-sandbox-approval.md'),
        chapter('第 12 章 MCP 与扩展生态', 'ch12-mcp.md'),
        chapter('第 13 章 会话持久化与恢复', 'ch13-persistence.md'),
      ]),
      part('Part III · 进阶专题', [
        chapter('第 14 章 TUI 架构', 'ch14-tui.md'),
        chapter('第 15 章 app-server 协议族', 'ch15-app-server.md'),
        chapter('第 16 章 exec 无头模式与 CI 集成', 'ch16-exec.md'),
        chapter('第 17 章 工程实践', 'ch17-engineering.md'),
      ]),
      part('Part IV · Agent 工程学', [
        chapter('第 18 章 生产参数手册', 'ch18-production-params.md'),
        chapter('第 19 章 优雅降级', 'ch19-graceful-degradation.md'),
        chapter('第 20 章 失控控制', 'ch20-budget-runaway.md'),
        chapter('第 21 章 形式化收束', 'ch21-formalization.md'),
      ]),
      {
        text: '附录',
        items: [chapter('附录 A 术语表', 'appendix-glossary.md')],
      },
    ],

    outline: { level: [2, 3], label: '本页目录' },

    docFooter: { prev: '上一章', next: '下一章' },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '没有找到结果',
            resetButtonTitle: '清除查询',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },

    editLink: {
      pattern:
        'https://github.com/Atituiset/codex/edit/main/book/docs/:path',
      text: '在 GitHub 上编辑本页',
    },

    lastUpdated: {
      text: '最后更新',
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/Atituiset/codex' },
    ],

    footer: {
      message: '基于 openai/codex 源码（commit 4f39251a01）撰写，仅用于学习交流。',
      copyright: 'CC BY-NC-SA 4.0 · 源码版权归原作者所有',
    },
  },

  markdown: {
    lineNumbers: false,
    theme: { light: 'github-light', dark: 'github-dark' },
  },

  // GitHub Pages 项目站点：https://atituiset.github.io/codex/
  base: '/codex/',
})
