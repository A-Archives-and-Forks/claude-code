# Claude Code（反编译重建版）文档

本目录是基于 [`docs-outline-draft.md`](../../docs-outline-draft.md) 大纲生成的完整文档，分三个视角：

- **[user/](./user/)** — 产品文档（使用者视角）：按"安装 → 配置 → 日常 → 进阶 → 排错"用户旅程组织
- **[design/](./design/)** — 开发者设计探秘：按"被约束逼出的决策链"组织，每章回答"为什么这么设计"
- **[cross/](./cross/)** — 交叉主题：两个视角都需要覆盖的横切主题

---

## 第一部分：产品文档（user/）

| # | 章节 | 文件 |
|---|------|------|
| 1 | 从零开始 —— 安装、首次启动与环境要求 | [01-installation.md](./user/01-installation.md) |
| 2 | 让 Claude 听你的 —— 配置 Provider 与模型 | [02-providers.md](./user/02-providers.md) |
| 3 | 日常对话 —— 交互式 REPL 怎么用 | [03-repl-daily.md](./user/03-repl-daily.md) |
| 4 | slash 命令速查 —— 按场景找 | [04-slash-commands.md](./user/04-slash-commands.md) |
| 5 | 扩展 Claude 的能力 —— MCP、插件、Skill | [05-mcp-plugins-skills.md](./user/05-mcp-plugins-skills.md) |
| 6 | 让 Claude 跑大任务 —— 子代理、Plan、Task | [06-agents-plan-tasks.md](./user/06-agents-plan-tasks.md) |
| 7 | 让 Claude 长时间干活 —— Daemon、BG、Schedule | [07-daemon-bg-schedule.md](./user/07-daemon-bg-schedule.md) |
| 8 | 跨机器与团队协作 —— Bridge、RCS、ACP | [08-bridge-rcs-acp.md](./user/08-bridge-rcs-acp.md) |
| 9 | 省钱、提速、定制 —— 穷鬼模式、Hooks、配置 | [09-budget-hooks-config.md](./user/09-budget-hooks-config.md) |
| 10 | 可观测性与排错 —— 卡住了怎么办 | [10-observability-troubleshooting.md](./user/10-observability-troubleshooting.md) |
| 11 | 自动化与 CI 集成 —— 嵌入流水线 | [11-ci-integration.md](./user/11-ci-integration.md) |
| 12 | 进阶实验性能力与社区生态 | [12-experimental-community.md](./user/12-experimental-community.md) |
| 13 | 安全 —— 凭证、权限、刷新、共享 | [13-security.md](./user/13-security.md) |

## 第二部分：开发者设计探秘（design/）

| # | 章节 | 文件 |
|---|------|------|
| 0 | 序章：被反编译重建的 CLI 处处是"约束的印记" | [00-prologue.md](./design/00-prologue.md) |
| 1 | Code Splitting 不是优化，是生存需求 | [01-code-splitting.md](./design/01-code-splitting.md) |
| 2 | 入口 Fast-Path 优先级链 —— --version 零模块加载 | [02-fast-path.md](./design/02-fast-path.md) |
| 3 | performanceShim —— JSC 内存泄漏的运行时补丁 | [03-performance-shim.md](./design/03-performance-shim.md) |
| 4 | 核心 Query Loop —— 为什么 query() 是 async generator | [04-query-loop.md](./design/04-query-loop.md) |
| 5 | Feature Flag 系统的三个硬约束 | [05-feature-flags.md](./design/05-feature-flags.md) |
| 6 | 工具系统的延迟加载与 CORE_TOOLS 白名单 | [06-tools-deferred.md](./design/06-tools-deferred.md) |
| 7 | 7-Provider 抽象层的单一调度点 | [07-provider-dispatch.md](./design/07-provider-dispatch.md) |
| 8 | 流适配器 —— OpenAI/Gemini/Grok 假装是 Anthropic | [08-stream-adapters.md](./design/08-stream-adapters.md) |
| 9 | Usage 字段映射与模型映射的优先级链 | [09-usage-mapping.md](./design/09-usage-mapping.md) |
| 10 | 自研 Fork 的 Ink 框架 —— 为什么不是 src/ink/ | [10-ink-framework.md](./design/10-ink-framework.md) |
| 11 | 三层状态管理 —— bootstrap/state.ts 警告 "DO NOT ADD MORE" | [11-state-management.md](./design/11-state-management.md) |
| 12 | ACP / Bridge / Daemon —— 三个长驻模式的接线 | [12-acp-bridge-daemon.md](./design/12-acp-bridge-daemon.md) |
| 13 | CLAUDE.md 四层层级与 @include 指令 | [13-claudemd.md](./design/13-claudemd.md) |
| 14 | 测试策略 —— 为什么 mock 必须从底层 HTTP 开始 | [14-testing-strategy.md](./design/14-testing-strategy.md) |
| 15 | biome.json 的 42 条规则关闭 —— 反编译产物的指纹 | [15-biome-config.md](./design/15-biome-config.md) |
| 16 | 尾声：哪些坑我们没踩 —— 读者可继续挖掘的方向 | [16-epilogue.md](./design/16-epilogue.md) |

## 第三部分：交叉主题（cross/）

| # | 主题 | 文件 |
|---|------|------|
| 1 | 排错与错误对照 | [01-troubleshooting.md](./cross/01-troubleshooting.md) |
| 2 | 性能与内存 | [02-performance-memory.md](./cross/02-performance-memory.md) |
| 3 | 安全 | [03-security.md](./cross/03-security.md) |
| 4 | 升级与版本管理 | [04-upgrade-versioning.md](./cross/04-upgrade-versioning.md) |
| 5 | 与其他工具集成 | [05-tool-integration.md](./cross/05-tool-integration.md) |
| 6 | 可观测性 | [06-observability.md](./cross/06-observability.md) |
| 7 | 凭证与认证生命周期 | [07-credentials-auth.md](./cross/07-credentials-auth.md) |

---

## 阅读建议

- **想用工具**：直接看 [user/](./user/)，从 [01-installation.md](./user/01-installation.md) 开始
- **想理解架构**：从 [design/00-prologue.md](./design/00-prologue.md) 序章开始
- **遇到问题**：先看 [cross/01-troubleshooting.md](./cross/01-troubleshooting.md) 排错对照表
