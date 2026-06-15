# Claude Code（反编译重建版）文档大纲

这份文档分两个视角并行展开：**产品文档**面向"想让工具跑起来并融入日常工作流"的使用者，按用户旅程组织；**开发者设计探秘**面向想理解内部原理、挖掘决策背后动机的工程师，按"被约束逼出的设计链"组织。两者覆盖同一套代码，但章节切分、措辞、锚点指向各不相同，让不同读者按自己的路径进入。

---

## 第一部分：产品文档大纲（使用者视角）

按"安装 → 配置 → 日常 → 扩展 → 进阶 → 排错"线性旅程组织。每章标题呼应用户想做什么，而非工具有什么。

### 1. 第一章：从零开始 —— 安装、首次启动与环境要求

章节摘要：把工具装到本机，跑通第一次对话。覆盖 Bun 运行时、Node.js 兼容产物、dev/build 两种使用方式，以及首次启动的信任对话框与初始化流程。

子章节：

- 我需要先装什么？Bun 与 Node.js 的取舍
- 三种安装方式：`bun run dev`、构建产物 `dist/cli.js`、Vite 构建链
- 第一次启动会发生什么：trust dialog、init 流程、telemetry 询问
- 快速路径命令一览（`--version` / `-v` / `--help`）
- 把 `claude` 设为全局命令：`cli-bun.js` 与 `cli-node.js` 双入口
- 环境自检：`bun run health` 与 `claude doctor`

锚点：
- `docs/getting-started/installation.mdx`
- `docs/getting-started/quickstart.mdx`
- `src/entrypoints/cli.tsx`、`src/entrypoints/init.ts`
- `build.ts`、`scripts/dev.ts`
- 命令：`bun run dev` / `bun run build` / `bun run health` / `claude doctor` / `claude --version`

### 2. 第二章：让 Claude 听你的 —— 配置 Provider 与模型

章节摘要：回答"我用哪家 API？"这个最高频问题。覆盖 7 个 Provider 的切换方式、引导式登录、环境变量清单，以及"为什么我切了 Provider 没生效"和"我改了 key 为什么没生效"两个高频排错。

子章节：

- 一张表看懂 7 个 Provider：Anthropic / OpenAI 兼容 / Gemini / Grok / Bedrock / Vertex / Foundry
- 三种切换方式：`/provider` 命令、`/login` 引导式登录、`CLAUDE_CODE_USE_*` 环境变量
- 中国 LLM 引导式登录：DeepSeek / 智谱 GLM / 通义千问 / Moonshot / Cerebras / Groq
- 用 ChatGPT 订阅当后端：`OPENAI_AUTH_MODE=chatgpt` 的设备码流程、`~/.claude/openai-chatgpt-auth.json` 凭证存储、与 Codex CLI 跨工具共享 `~/.codex/auth.json`、5 分钟刷新偏差窗口
- 每个 Provider 的 key 配置清单（`OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROK_API_KEY` 或 `XAI_API_KEY` / `AWS_REGION` / `ANTHROPIC_VERTEX_PROJECT_ID` / `ANTHROPIC_FOUNDRY_*`）
- 模型映射是怎么决定的：`PROVIDER_MODEL` > `PROVIDER_DEFAULT_{FAMILY}_MODEL` > `ANTHROPIC_DEFAULT_*` > 默认表
- 为什么切了 Provider 没生效？`modelType` 优先级、`/provider unset` 只清 Provider 不清 key、`isFirstPartyAnthropicBaseUrl()` TODO 陷阱（只设 `OPENAI_BASE_URL` 没设 `ANTHROPIC_BASE_URL` 会让 firstParty 行为泄漏）
- **我改了 API key 但没生效？** —— 模块级 client cache 陷阱：`getOpenAIClient()`/`getGrokClient()` 会话级缓存客户端实例，中途改 key 必须重启或调用 `clearOpenAIClientCache()`
- 本地模型与自托管端点：Ollama / vLLM / DeepSeek 自托管
- DeepSeek 思维模式自动检测与三格式注入；为什么必须回显 `reasoning_content: ''`（空字符串），否则下一次请求会被 400 拒绝
- `/effort` 与 `CLAUDE_CODE_EFFORT_LEVEL` 的取值语义：`low` / `medium` / `high` / `xhigh` 四档，以及它在 ChatGPT Responses API 上如何落地为 `reasoning.effort` 参数

锚点：
- `docs/getting-started/model-providers.mdx`
- `src/commands/provider.ts`、`src/commands/login/login.tsx`
- `src/components/ConsoleOAuthFlow.tsx`、`src/utils/chinaLlmProviders.ts`
- `src/utils/model/providers.ts`
- `src/services/api/openai/`、`src/services/api/gemini/`、`src/services/api/grok/`
- `src/services/api/openai/client.ts:39`（`getOpenAIClient` 模块级缓存）
- `src/services/api/openai/responsesAdapter.ts`（Responses API 适配器）
- `src/services/api/client.ts`（`isFirstPartyAnthropicBaseUrl` 陷阱）
- `src/services/providerUsage/adapters/openai.ts:62`（限流响应头解析）
- 命令：`/provider <name>` / `/provider unset` / `/login` / `/model` / `/effort`

### 3. 第三章：日常对话 —— 交互式 REPL 怎么用

章节摘要：装好之后每天打开 `claude` 会做什么。覆盖发消息、看流式回复、中断、恢复会话、切模型、切权限模式、查看 token 消耗等高频日常操作。

子章节：

- 发消息、看流式回复、Esc 中断、Ctrl+C 退出
- 会话怎么持久化：恢复上一次对话（`/resume`）、查看历史（`/history`）、清空上下文（`/clear`）
- 切换模型与思考强度：`/model`、`/effort`（low/medium/high/xhigh）、ultrathink 触发词
- 权限模式：默认询问 / 自动批准 / 全部拒绝 / sandbox 切换
- 看 token 与费用：`/cost`、`/usage`、`/stats`、状态栏显示
- 上下文管理与自动压缩：`/compact`、自动 compact 触发条件、`/force-snip` 强制剪裁
- 把对话导出与分享：`/export`、`/share`、`/summary`，各自的产物格式与隐私边界（谁会看到什么、是否包含凭证）
- 更换主题、输出风格、语言：`/theme`、`/output-style`、`/lang`
- 配置项目记忆：CLAUDE.md 与 `@include` 指令、`/memory` 命令

锚点：
- `src/screens/REPL.tsx`、`src/query.ts`、`src/QueryEngine.ts`、`src/context.ts`、`src/utils/claudemd.ts`
- `src/commands/clear/`、`compact/`、`cost/`、`usage/`、`history/`、`resume/`、`model/`、`effort/`、`mode/`、`memory/`、`export/`、`share/`、`theme/`
- 命令：`claude` / `claude -p '...'` / `claude --resume`

### 4. 第四章：slash 命令速查 —— 不用记全部，按场景找

章节摘要：把上百个 slash 命令按"我想做什么"分类，让用户能快速找到自己需要的那一个，而不是背诵命令清单。

子章节：

- 会话与上下文类：`/clear` `/compact` `/resume` `/history` `/context` `/rewind` `/force-snip`
- 模型与 Provider 类：`/model` `/provider` `/effort` `/login` `/logout`
- 费用与限额类：`/cost` `/usage` `/stats` `/rate-limit-options`（待核实是否存在） `/reset-limits`（待核实是否存在）；实际机制是通过响应头 `x-ratelimit-*-requests/tokens` 与 `Reset-After` 自动追踪限流
- 配置与个性化类：`/theme` `/output-style` `/lang` `/keybindings` `/config` `/env`
- 项目与文件类：`/add-dir` `/files` `/diff` `/context` `/ctx_viz`
- 插件与扩展类：`/plugin` `/skills` `/skill-store` `/reload-plugins` `/hooks`
- 工作流自动化类：`/commit` `/commit-push-pr` `/review` `/plan` `/schedule` `/loop`
- 诊断与帮助类：`/help` `/doctor` `/status` `/version` `/feedback`
- 隐藏与实验类：`/bughunter` `/advisor` `/insights` `/thinkback` `/torch`

锚点：
- `src/commands/`、`src/commands/help/`、`doctor/`、`config/`、`env/`
- 命令：`/help` / `claude <cmd> --help`
- 注意：`/rate-limit-options` 与 `/reset-limits` 在 findings 中没有对应锚点，应标记为"待核实是否存在"，或替换为已验证的"通过响应头追踪限流"机制

### 5. 第五章：扩展 Claude 的能力 —— MCP Server、插件、Skill

章节摘要：当内置工具不够用时怎么办。覆盖接入现成 MCP server、自己写一个、安装社区插件、用 Skill 沉淀工作流。

子章节：

- MCP 是什么？什么时候应该用 MCP 而不是普通工具
- 用 `claude mcp add` 接入现成 MCP server（stdio / SSE / HTTP）
- 管理已接入的 server：`claude mcp list` / `remove` / `serve`
- MCP OAuth 简化流程与认证（`/mcp-auth`）
- 自己写一个 MCP server 的最小骨架
- Computer Use / Chrome 控制 / 语音输入这些内置 MCP 怎么开
- 插件系统：`/plugin` 浏览、安装、启用、禁用、卸载
- Marketplace 浏览与插件市场
- Skill 是什么？`/skills` 与 `/skill-store` 的区别
- 怎么写一个自己的 Skill 并复用
- Skill 搜索与延迟工具加载：SearchExtraTools 与 ExecuteExtraTool

锚点：
- `docs/features/tools/`
- `docs/features/external/chrome-control.md`、`computer-use.md`、`voice-mode.md`、`web-browser-tool.md`
- `src/commands/mcp/`、`plugin/`、`skills/`、`skill-store/`、`skill-search/`
- `src/services/searchExtraTools/`
- `packages/@ant/computer-use-mcp/`、`packages/@ant/claude-for-chrome-mcp/`
- 命令：`claude mcp add/list/remove/serve` / `/plugin` / `/skills` / `/skill-store`

### 6. 第六章：让 Claude 帮你跑大任务 —— 子代理、Plan 模式、Task 系统

章节摘要：当任务超过单次对话、需要并行或分阶段执行时怎么办。覆盖 Agent 工具、Task 系统、Plan 模式、worktree 隔离。

子章节：

- 什么时候该派子代理？单线程 vs 并行 vs 分阶段
- Agent 工具：在对话里 spawn 一个子代理处理子任务
- Task 系统：TaskCreate / TaskUpdate / TaskList / TaskGet 管理任务清单
- Plan 模式：先想清楚再动手（`/plan`、EnterPlanMode、ExitPlanModeV2、VerifyPlanExecution）
- Goal 命令：给定目标后让 Claude 自主推进（`/goal`）
- Worktree 隔离：在独立 git worktree 里跑实验性改动
- Coordinator 模式：多 worker 协作（`COORDINATOR_MODE` feature）
- Workflow 脚本：把多步工作流固化成可重放脚本（`/workflows`）
- Ultra-batch 与 dispatching-parallel-agents Skill 的取舍

锚点：
- `docs/features/agents/`
- `packages/agent-tools/`
- `packages/builtin-tools/src/tools/AgentTool/`、`TaskCreateTool/`、`EnterPlanModeTool/`、`EnterWorktreeTool/`
- `src/commands/plan/`、`goal/`、`workflows/`、`coordinator.ts`
- Skill：ultra-batch / dispatching-parallel-agents / experiment-driven-research

### 7. 第七章：让 Claude 长时间帮你干活 —— Daemon、Background Sessions、Schedule

章节摘要：当任务需要小时级持续运行、定时触发、或后台并行多个会话时怎么办。覆盖 daemon 模式、bg sessions、cron/schedule、loop。

子章节：

- Daemon 是什么？跟普通 REPL 的区别（长驻 supervisor + worker）
- 启停 daemon：`claude daemon start/stop/bg/attach/logs/kill/status`
- `--daemon-worker=<kind>` 精简 worker 的用途
- Background Sessions：`claude --bg` / `claude ps` / `claude attach` / `claude kill`
- Template Jobs：`claude job new/list/reply` 模板化任务
- 定时调度：`/schedule` 创建远程 cron 触发器、`/loop` 本地循环、`cron-list` / `cron-delete`
- 用 `/loop` 让 Claude 每 N 分钟自动跑一次任务
- Schedule 触发器与 RCS 的关系
- 什么时候该用 daemon，什么时候用 background session，什么时候用 schedule

锚点：
- `src/daemon/`、`src/commands/daemon/`、`attach/`、`tasks/`、`job/`、`schedule/`、`loop`
- Skill：loop / cron-list / cron-delete / schedule
- 命令：`claude daemon <subcmd>` / `claude --bg` / `claude ps` / `claude attach` / `claude kill`

### 8. 第八章：跨机器与跨团队协作 —— Bridge、Remote Control、ACP

章节摘要：当 Claude 需要跑在远程机器、被外部客户端调用、或接入 IDE/团队工具时怎么办。覆盖 Bridge 模式、自托管 RCS、ACP 协议、IDE 桥接。

子章节：

- Bridge 模式是什么？什么时候启用（`BRIDGE_MODE` feature）
- Remote Control 快速路径：`claude remote-control` / `rc` / `remote` / `sync` / `bridge`
- 自托管 RCS：Docker 部署、Web UI 控制面板、`bun run rcs`
- RCS Web UI：会话管理、ACP agent 接入、SSE 事件流
- ACP 协议：把 Claude Code 暴露成 ACP agent（`claude --acp`）
- ACP 权限管道与 `session/update` plan 可视化
- acp-link：WebSocket 客户端桥接到 ACP agent
- IDE 桥接：VS Code 集成（`vscode-ide-bridge/`、`/ide` 命令）
- SSH 远程模式：`SSH_REMOTE` feature 与 `/remote-setup`、`/remote-env`
- 与 Codex CLI 跨工具凭证共享（`~/.codex/auth.json`、`~/.claude/openai-chatgpt-auth.json`）

锚点：
- `docs/features/modes/remote-control-self-hosting.md`
- `docs/features/agents/acp.md`、`pipes-and-lan.md`
- `src/bridge/`、`src/services/acp/`
- `packages/remote-control-server/`、`packages/acp-link/`、`vscode-ide-bridge/`
- `src/commands/bridge/`、`remoteControlServer/`、`remote-setup/`、`remote-env/`、`ide/`
- 命令：`claude remote-control` / `claude rc` / `claude bridge` / `claude --acp` / `bun run rcs`

### 9. 第九章：省钱、提速、定制 —— 穷鬼模式、缓存、Hooks、配置文件

章节摘要：当 token 账单偏高、响应偏慢、或想让 Claude 自动响应某些事件时怎么办。覆盖穷鬼模式、prompt 缓存、hooks、settings.json、keybindings，以及权限规则写作指南。

子章节：

- 穷鬼模式（`/poor`）：跳过 `extract_memories` / `prompt_suggestion` / `verification_agent`，对各 Provider 都生效（含兼容层），持久化到 `settings.json`
- Prompt 缓存怎么工作？缓存断点检测（`PROMPT_CACHE_BREAK_DETECTION`）
- Token 预算管理：`TOKEN_BUDGET` feature 与 `/cost` 联动
- Hooks：在 `settings.json` 里写"每次 X 发生就执行 Y"
- `settings.json` vs `settings.local.json`：团队共享 vs 个人覆盖
- CLAUDE.md 四层层级与优先级：Managed / User / Project / Local
- `@include` 指令：在 CLAUDE.md 里引用其他文件
- `keybindings.json`：自定义快捷键与 chord
- **权限规则配置指南**：`allow` / `deny` 规则的具体语法（含工具名匹配、glob 模式、规则优先级）、`/permissions` 命令、沙箱模式与 `bypassPermissions` 在非 root/sandbox 环境的可用性检测
- Feature flag 运行时开关：`FEATURE_<NAME>=1`，以及已知禁用清单（`CONTEXT_COLLAPSE` / `HISTORY_SNIP` / `FORK_SUBAGENT` / `UDS_INBOX` / `LAN_PIPES` / `REVIEW_ARTIFACT` / `SKILL_LEARNING` / `TEAMMEM`）与启用后果

锚点：
- `src/commands/poor/poorMode.ts`
- `src/commands/hooks/`、`permissions/`、`config/`、`keybindings/`
- `src/utils/claudemd.ts`、`src/context.ts`
- Skill：update-config / keybindings-help
- 命令：`/poor` / `/hooks` / `/config` / `/permissions` / `/env`

### 10. 第十章：可观测性与排错 —— 卡住了怎么办

章节摘要：当 Claude 报错、卡住、行为异常或想理解它在做什么时怎么办。覆盖 doctor、debug、日志、Langfuse 追踪、常见错误对照表。

子章节：

- 第一步永远先跑：`claude doctor` 与 `bun run health`
- **Provider 报错对照表**：401（key 无效） / 403（地区限制） / 429（限流，看 `x-ratelimit-*` 头与 `Reset-After`） / `overloaded_error`（1305 / 上游过载） / 模型不存在
- OpenAI/Gemini/Grok 兼容层特有坑：模型映射失败（Gemini 硬抛异常）、`reasoning_content` 缺失导致 DeepSeek 400、限流响应头解析
- Bedrock Opus 4.7 的 400 错误与 `anthropic_beta` 体剥离补丁：何时打、SDK 升级后如何通过 `scripts/probe-bedrock-beta-fix.ts` 检测是否还需要
- MCP server 连不上：stdio 路径、SSE 超时、OAuth 失败排查清单
- 权限被拒、工具被禁用、deferred tool 没加载
- 内存膨胀与长会话：`performanceShim`、`clearMarks`、`/compact`、`/force-snip`
- 调试模式：`BUN_INSPECT=<port>`、`--dump-system-prompt`、`/debug-tool-call`
- Langfuse 追踪：每次查询的 `provider` 字段（`openai` / `gemini` / `grok` / `getAPIProvider()`）与 `recordLLMObservation`
- 导出会话给同事看：`/export`、`/share`、`/recap` 的产物格式与隐私边界
- 反馈与上报 bug：`/feedback`、`/perf-issue`、`/bughunter`
- 已知禁用的 feature flag 清单与启用后果

锚点：
- `docs/features/tools/langfuse-monitoring.md`
- `src/commands/doctor/`、`debug-tool-call/`、`feedback/`、`perf-issue/`、`heapdump/`
- `src/utils/performanceShim.ts`
- `src/services/api/bedrockClient.ts:29`
- `src/services/providerUsage/adapters/openai.ts:62`
- `scripts/probe-bedrock-beta-fix.ts`
- 命令：`claude doctor` / `bun run health` / `BUN_INSPECT=9229 bun run dev:inspect` / `claude --dump-system-prompt`

### 11. 第十一章：自动化与 CI 集成 —— 把 Claude 嵌入流水线

章节摘要：当想在 CI、脚本、cron、容器里无交互调用 Claude 时怎么办。覆盖 pipe 模式、headless、BYOC runner、容器环境变量、与 ACP/Bridge 的交汇点。

子章节：

- Pipe 模式：`echo '...' | claude -p` 一次性调用
- Headless 模式：无 TTY 环境下的行为差异
- **BYOC runner**：`claude environment-runner` / `claude self-hosted-runner`（与第八章 ACP、Bridge 的交汇点）
- 容器环境：`CLAUDE_CODE_REMOTE=true` 自动调内存上限（`--max-old-space-size=8192`）
- `CLAUDE_CODE_FORCE_INTERACTIVE`：嵌套 bun 启动的 TTY 欺骗
- `CLAUDE_CODE_ABLATION_BASELINE`：L0 消融基线的用途
- 在 GitHub Actions 里跑 claude（`install-github-app`、`subscribe-pr`、`commit-push-pr`）
- 定时任务：用 `/schedule` 或 cron + pipe 实现巡检
- 退出码与 `pipe-status`：脚本里判断成功失败

锚点：
- `src/entrypoints/cli.tsx`
- `src/commands/pipe-status/`、`install-github-app/`、`subscribe-pr/`、`commit-push-pr.ts`
- 命令：`claude -p` / `claude environment-runner` / `claude self-hosted-runner` / `claude --bg`

### 12. 第十二章：进阶实验性能力与社区生态

章节摘要：给愿意折腾的用户一张"还能玩什么"的地图。覆盖实验 feature、buddy、监控、advisor、teleport 等小众但强大的命令。

子章节：

- 实验性 feature flag 速览：`BUDDY` / `KAIROS` / `LODESTONE` / `ULTRAPLAN` / `MONITOR_TOOL`
- Skill 搜索实验：`EXPERIMENTAL_SKILL_SEARCH` / `EXPERIMENTAL_SEARCH_EXTRA_TOOLS`（编译进 build，运行时默认 OFF，`SKILL_SEARCH_ENABLED=1` 开启）
- Buddy 协作与 `/buddy` 命令
- Kairos 简报与 `/brief`、Away Summary、`/recap`
- Advisor、insights、thinkback：让 Claude 反思自己的输出
- Teleport 与 pipes：跨会话消息传递
- Local vault 与 memory stores：长期记忆的多后端
- TUI 实验、stickers、output-style 自定义
- 贡献者生态：`/feedback`、GitHub issues、`bun run docs:dev` 本地起文档站

锚点：
- `src/commands/buddy/`、`brief.ts`、`recap/`、`advisor.ts`、`insights.ts`、`thinkback/`、`teleport/`、`pipes/`、`local-vault/`、`memory-stores/`、`tui/`、`stickers/`、`output-style/`
- 命令：`bun run docs:dev` / `FEATURE_<NAME>=1 bun run dev`

### 13. 第十三章：安全 —— 凭证、权限、刷新、共享（交叉补充）

章节摘要：当前两份大纲都没有连贯的安全章节。把凭证存储、权限模式、OAuth 刷新、跨工具凭证共享集中讲清楚，让用户知道自己的密钥和令牌去了哪里。

子章节：

- 凭证存储位置清单：`~/.claude/`、`~/.claude/openai-chatgpt-auth.json`、`~/.codex/auth.json`、`~/.claude.json`、`settings.json` / `settings.local.json`
- OAuth 设备码流程：ChatGPT 订阅路径与 Anthropic OAuth 各自的设备码握手
- OAuth 令牌自动刷新的 5 分钟偏差窗口
- 权限模式语义：默认询问 / 自动批准 / 全部拒绝 / sandbox / `bypassPermissions`（非 root/sandbox 环境检测）
- JWT 认证（Bridge 模式）：token 签发、传输、回收
- `/share` 与 `/export` 的隐私边界：哪些字段会泄漏、是否包含凭证、给同事前要做什么
- 跨工具凭证共享的隐私影响：Codex CLI 共享 `~/.codex/auth.json` 的含义

锚点：
- `src/commands/login/login.tsx`
- `src/services/api/openai/chatgptAuth.ts:327`
- `src/components/ConsoleOAuthFlow.tsx:1294`
- `src/commands/permissions/`、`share/`、`export/`
- `src/services/acp/permissions.ts`

---

## 第二部分：开发者设计探秘大纲（开发者视角）

按"被约束逼出的决策链"组织：从最戏剧性的设计动机（JSC 内存暴涨）出发，逐层剥开入口、核心循环、工具系统、Provider 抽象、UI 框架、状态管理、运行时补丁、Feature Flag、特殊模式、测试策略、反编译指纹。每章都回答"为什么这么设计？"。

### 1. 序章：一份被反编译重建的 CLI，为什么处处是"约束的印记"

章节摘要：开篇先回答整个项目最根本的好奇心——这不是 Anthropic 原版，而是反编译产物在 Bun/JSC 约束下的重建。点明全书主线：每一个看似奇怪的设计背后，都藏着一个具体的运行时约束或反编译痕迹。

子章节：

- 反编译的语义：为什么 stub 模块、feature-gated 代码、React Compiler 的 `_c()` 是正常的
- 全书的叙事主线：约束（JSC 内存、Bun DCE、运行时类型补丁）如何驱动架构
- 如何阅读本书：每章锚点都指向真实 `文件:行号`，请打开编辑器对照
- 两类禁用 feature 的诚实区分：反编译丢失导致的 stub（`CONTEXT_COLLAPSE` / `HISTORY_SNIP` / `FORK_SUBAGENT`）vs 功能原本就 stubbed 的（`SKILL_LEARNING` / `TEAMMEM`）—— 这两类经常被混淆

锚点：
- `src/types/react-compiler-runtime.d.ts:1`
- `src/types/global.d.ts:9`、`global.d.ts:59`
- `CLAUDE.md`

### 2. 第一章：Code Splitting 不是优化，是生存需求

章节摘要：全书最戏剧性的设计动机——单文件 17MB 产物让 Bun/JSC 全量解析导致 RSS 暴涨到 ~1GB，而 Node/V8 懒解析仅需 ~220MB。项目因此被迫切成 600+ chunks，`--version` 的 RSS 从 966MB 骤降到 35MB。

子章节：

- JSC 的贪婪解析 vs V8 懒解析：实验数据（17MB → 1GB vs 220MB）
- 为什么 Vite 必须代码分割而不是单文件：Bun 按需加载 chunks 的原理
- 双构建管线：`Bun.build()` vs Vite，各自的 chunk 布局（`dist/` vs `dist/chunks/`）
- post-build 阶段为什么必须 patch `globalThis.Bun` 解构（`@anthropic-ai/sandbox-runtime` 在 Node.js 启动会崩）
- 构建产物同时兼容 bun/node：`import.meta.require` → `createRequire` 的运行时探测

锚点：
- `build.ts:23`、`build.ts:43`、`build.ts:62`
- `vite.config.ts:94`
- `scripts/post-build.ts`
- `src/utils/distRoot.ts:15`

### 3. 第二章：入口的 Fast-Path 优先级链 —— 为什么 --version 必须零模块加载

章节摘要：`cli.tsx` 的 `main()` 函数按优先级串起十几条快速路径，最极端的是 `--version` / `-v` 零模块加载。背后的设计哲学：CLI 启动延迟是用户体验第一杀手，每个子命令都应该尽可能晚地加载它真正需要的代码。

子章节：

- Fast-Path 优先级链：`--version` → `--dump-system-prompt` → MCP servers → `daemon-worker` → bridge → BG sessions → 默认 `main.tsx`
- **为什么 `CLAUDE_CODE_ABLATION_BASELINE` 必须 inline 在 cli.tsx 顶层**：BashTool / AgentTool / PowerShellTool 在 import 时就把 `DISABLE_BACKGROUND_TASKS` 等环境变量捕获进模块级 `const`，`init()` 跑得太晚无法影响它们 —— 这是一条脆弱但必要的初始化顺序依赖
- MACRO 编译期注入的三层防线：dev 模式 `-d` flag、build `Bun.build define`、运行时 fallback `globalThis.MACRO`
- 为什么版本号单一来源在 `package.json` 而不是 hardcoded（避免漂移）
- 双入口 `cli-bun.js` / `cli-node.js`：同一份产物被两个运行时执行

锚点：
- `src/entrypoints/cli.tsx:5`、`cli.tsx:11`、`cli.tsx:56`、`cli.tsx:76`、`cli.tsx:79`
- `scripts/defines.ts:18`、`defines.ts:39`
- `scripts/dev.ts:17`

### 4. 第三章：performanceShim —— JSC 内存泄漏的运行时补丁

章节摘要：`src/utils/performanceShim.ts` 必须是 `cli.tsx` 的第一行 import。JSC 的原生 Performance 把 marks/measures 存进永不收缩的 C++ Vector，长会话累积数百 MB 死容量。这个 shim 在 React/OTel 捕获原生引用之前劫持全局 performance。

子章节：

- JSC 原生 Performance 的陷阱：C++ Vector 永不收缩
- 为什么保留 `performance.now()` 走原生，只劫持 `mark` / `measure` / `getEntries`
- 为什么必须最先 import：React reconciler 和 OTel 会捕获原生引用
- `query.ts` 的 finally 块兜底 `clearMarks` / `clearMeasures` —— 防 sub-agent 直接 import query 时 shim 没装上
- 为什么 dev 模式 `NODE_ENV='production'`：避免 6,889+ `_debugStack` Error 对象（12MB）

锚点：
- `src/utils/performanceShim.ts:1`、`performanceShim.ts:18`、`performanceShim.ts:162`
- `src/query.ts:460`

### 5. 第四章：核心 Query Loop —— 为什么 query() 是 async generator

章节摘要：`src/query.ts` 的 `query()` 是 `async function*`，yield `StreamEvent` / `Message` / `TombstoneMessage` / `ToolUseSummaryMessage`，最终 return `Terminal`。背后的设计：流式响应必须能够把"结果"与"副作用"解耦，调用方可以选择性消费。

子章节：

- async generator vs callback：为什么用 yield 而不是事件发射器
- `queryLoop()` 的委托模式：thinking 块的 3 条硬约束（`max_thinking_length>0`、不能是最后一块、跨工具轨迹保留）
- `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT=3`：`max_output_tokens` 错误为什么会对调用方扣留（yield 会终止会话）
- `QueryEngine` 作为 `query()` 之上的会话编排器：messages / fileCache / usage 跨 turn 持久
- `snipReplay` 回调：让 feature-gated 字符串留在 gated 模块外，`QueryEngine` 在 `bun test` 下仍可测

锚点：
- `src/query.ts:181`、`query.ts:276`、`query.ts:367`、`query.ts:393`、`query.ts:460`
- `src/QueryEngine.ts:138`、`QueryEngine.ts:192`、`QueryEngine.ts:217`

### 6. 第五章：Feature Flag 系统的三个硬约束

章节摘要：`feature()` 不是普通的运行时函数——它有 Bun 编译器强加的三个硬约束：(1) 只能出现在 `if` 条件或三元表达式（DCE 限制）；(2) 不能赋值给变量；(3) vite 插件必须在 transform 阶段替换为字面量，否则 bundler 会尝试解析不存在的 import。

子章节：

- 为什么 `feature()` 不是布尔变量：Bun 编译器 DCE 的 AST 模式匹配限制
- `vite-plugin-feature-flags.ts` 的 transform 时机：import 解析之前的字面量替换
- `REVIEW_ARTIFACT` 内的 `hunter.js` 根本不存在：为什么 `if(false)` 必须在 parse 阶段可见
- Build 默认 65+ feature vs Dev 全开 vs 运行时 `FEATURE_<NAME>=1`：三层切换机制
- 反编译产物的 stub 陷阱：明确区分反编译丢失的 stub（`CONTEXT_COLLAPSE` / `HISTORY_SNIP` / `FORK_SUBAGENT`，启用会破坏核心功能）vs 功能原本就 stubbed 的（`SKILL_LEARNING` / `TEAMMEM`）

锚点：
- `scripts/vite-plugin-feature-flags.ts:29`
- `src/types/internal-modules.d.ts:10`

### 7. 第六章：工具系统的延迟加载与 CORE_TOOLS 白名单

章节摘要：60 个工具不会一次性全部加载——`CORE_TOOLS` 38 个白名单是"always-available"核心，其余通过 `SearchExtraToolsTool` 按需 TF-IDF 搜索。背后的设计：tool schema 本身会消耗 token，必须按对话需求动态展开。

子章节：

- `CORE_TOOLS` 白名单制：`isDeferredTool` 的判定逻辑
- `SearchExtraToolsTool`：用 TF-IDF 语义搜索延迟工具（复用 `localSearch.ts` 的 `computeWeightedTf` / `computeIdf` / `cosineSimilarity`）
- `toolIndex.ts` 的共享算法：为什么 skill prefetch 和 tool prefetch 用独立的去重 Set（`discoveredToolsThisSession` 互不影响）
- feature-gated 工具：`feature()` 条件加载模式 `const x = feature('X') ? require('./x.js') : null`
- `SyntheticOutput`：`CORE_TOOLS` 中用于延迟工具按需加载的特殊工具

锚点：
- `src/constants/tools.ts`
- `src/tools.ts`
- `src/services/searchExtraTools/toolIndex.ts`、`prefetch.ts`
- `packages/builtin-tools/src/tools/`

### 8. 第七章：7-Provider 抽象层的单一调度点

章节摘要：`claude.ts:1344` 是整个 Provider 系统的心脏——在共享预处理（消息归一化、工具过滤、媒体剔除）之后、Anthropic 特定逻辑（betas/thinking/caching）之前动态导入 Provider 路径。兼容层因此自然跳过 Prompt 缓存/beta 功能，无需 feature flag。

子章节：

- Provider 路由优先级链：`modelType` 参数 > `CLAUDE_CODE_USE_*` 环境变量 > firstParty 默认
- 为什么调度点位置这么精确：兼容层"结构性跳过"betas/thinking 的优雅
- **调度点的不对称：给 OpenAI 路径传 `tools`（全池）但给 gemini/grok 传 `filteredTools`（裁剪后）**—— 因为 OpenAI 路径在内部模拟 Anthropic 延迟工具加载给 `SearchExtraToolsTool`，需要访问完整池。这恰恰是"调度点位置精确"论点的最强证据
- `getAPIProvider()` 是单一真相源：`/provider` 命令、Langfuse 追踪、模型映射都依赖它
- Provider 切换的原子性：`/provider` 命令同时清除所有 `CLAUDE_CODE_USE_*` 再 `applyConfigEnvironmentVariables`
- Anthropic 内部 4 Provider 统一伪装成 `Anthropic` SDK 类型——代码注释承认的"类型谎言"
- `isFirstPartyAnthropicBaseUrl()` 的 TODO 陷阱：firstParty 行为可能泄漏到兼容层

锚点：
- `src/utils/model/providers.ts:15`
- `src/services/api/claude.ts:1344`（调度点 + tools/filteredTools 不对称）
- `src/services/api/client.ts:84`
- `src/services/api/claude.ts:2999`
- `src/commands/provider.ts:39`

### 9. 第八章：流适配器 —— 让 OpenAI/Gemini/Grok 假装自己是 Anthropic

章节摘要：`adaptOpenAIStreamToAnthropic` / `adaptGeminiStreamToAnthropic` 是纯 async generator，把第三方流格式转换成 `BetaRawMessageStreamEvent`。下游 `claude.ts` 的 `contentBlocks` 累加器与原生 Anthropic 路径完全一致——零分支。这是整个多 API 兼容层最巧妙的设计。

子章节：

- 流适配器模式：async generator 作为格式翻译器
- 为什么下游零分支：`contentBlocks` 累加器不知道上游是什么 Provider
- **`message_stop` 后兜底：OpenAI/Grok 适配器在内存累积 `contentBlocks` 仅在 `message_stop` 时组装，网络中断时存在重复发射风险；post-loop 安全回退在 `partialMessage` 未重置时重发** —— 这是"下游零分支"叙事里少数有针对性修补的点
- `@ant/model-provider` 作为无副作用转换器库 vs `src/services/api` 作为客户端实例化器
- DeepSeek 思维模式的三层兼容：官方 `thinking` / 自托管 `enable_thinking` / 小米 `chat_template_kwargs`
- 为什么 Grok 复用整个 OpenAI 适配器栈：只有 client 和 `resolveGrokModel` 是 Grok 特有
- ChatGPT 订阅路径：Responses API 是 OpenAI 内部的第二个适配器（`input_text` / `input_image` / `role` messages 转换 + `adaptResponsesStreamToAnthropic` vs Chat Completions 流适配器）

锚点：
- `packages/@ant/model-provider/src/shared/openaiStreamAdapter.ts:35`
- `packages/@ant/model-provider/src/shared/openaiConvertMessages.ts:32`
- `src/services/api/openai/index.ts:214`
- `src/services/api/openai/requestBody.ts:70`
- `src/services/api/openai/responsesAdapter.ts:1`
- `src/services/api/gemini/client.ts:26`
- `src/services/api/grok/index.ts:51`

### 10. 第九章：Usage 字段映射与模型映射的优先级链

章节摘要：三个兼容层的模型映射都用四级优先级链：`PROVIDER_MODEL` 环境变量 > `PROVIDER_DEFAULT_{FAMILY}_MODEL` > `ANTHROPIC_DEFAULT_{FAMILY}_MODEL` > `DEFAULT_MODEL_MAP` 查找表。但 Gemini 是唯一在都缺失时抛异常的。Usage 字段映射则有镜像设计 + cache 字段保留策略，是"下游零分支"叙事里唯一一个有针对性修补的例外。

子章节：

- 正则 `/haiku|sonnet|opus/i` 推断模型系列的设计权衡
- `GROK_MODEL_MAP` JSON：为什么 Grok 唯一支持用户自定义 JSON 映射
- 防御性清理：`replace(/\[1m\]$/, '')` 剥离终端加粗 ANSI 后缀
- `getOpenAIClient` / `getGrokClient` 的模块级缓存：会话中改 API key 必须 `clearOpenAIClientCache()`；对比 `getAnthropicClient()` 按 model/region 参数化的设计差异
- **Usage 字段映射兼容性**：`updateOpenAIUsage` 与 `claude.ts:updateUsage` 的镜像设计；`cache_creation_input_tokens` / `cache_read_input_tokens` 在增量省略时保留，防止适配器差异导致缓存计数器被静默清零 —— 值得专门讲，因为它是"下游零分支"的唯一例外
- BedrockClient 的针对性变通：剥离 `anthropic_beta` 体（SDK 0.26.4-0.28.1 漏洞）+ probe 脚本检测修复

锚点：
- `packages/@ant/model-provider/src/providers/openai/modelMapping.ts:36`
- `packages/@ant/model-provider/src/providers/gemini/modelMapping.ts:8`
- `packages/@ant/model-provider/src/providers/grok/modelMapping.ts:51`
- `src/services/api/openai/shared.ts`（`updateOpenAIUsage`）
- `src/services/api/claude.ts`（`updateUsage` 镜像）
- `src/services/api/bedrockClient.ts:29`
- `src/services/api/openai/client.ts:39`
- `src/services/api/grok/client.ts:15`

### 11. 第十章：自研 Fork 的 Ink 框架 —— 为什么不是 src/ink/

章节摘要：`packages/@ant/ink/`（package.json name: `@anthropic/ink`）是基于 `react-reconciler` 自建的终端 React 渲染器。`core/` 目录有完整的 `reconciler.ts`、`dom.ts`、`yoga-layout/`、`render-node-to-output.ts`、`hit-test.ts`、`focus.ts`——这是一个完整的终端 DOM + 布局引擎，不是上游 Ink 库。

子章节：

- 为什么 fork 而非用上游 Ink：完整终端 DOM + Yoga 布局引擎的掌控需求
- react-reconciler 自建渲染器：`reconciler.ts` / `dom.ts` / `yoga-layout` / `render-node-to-output` / `hit-test`
- `vite.config.ts` 的 `dedupe: ['react', 'react-reconciler', 'react-compiler-runtime']` —— 为什么必须保证单副本
- React Compiler 输出的 `_c()` memoization 模板 —— 为什么这是正常的
- `global.d.ts` 的 `declare type T = unknown` —— 反编译产物特有的类型补丁（编译 JSX 丢失泛型）

锚点：
- `packages/@ant/ink/package.json:1`
- `packages/@ant/ink/src/core/reconciler.ts:1`
- `vite.config.ts:94`
- `src/types/react-compiler-runtime.d.ts:1`
- `src/types/global.d.ts:9`、`global.d.ts:59`

### 12. 第十一章：三层状态管理 —— 为什么 bootstrap/state.ts 警告 "DO NOT ADD MORE"

章节摘要：`src/bootstrap/state.ts` 是模块级 singleton（sessionId、cwd、projectRoot、token counters），文件顶部警告不要再加。`src/state/store.ts` 是手写 33 行 zustand-style store。`src/state/AppState.tsx` 用 React Context 包裹 store——三层各司其职，边界严格。

子章节：

- Bootstrap state：模块级 singleton 的诱惑与陷阱（"DO NOT ADD MORE STATE HERE"）
- 手写 zustand-style store：33 行代码（`createStore` 返回 `getState` / `setState` / `subscribe`，`Object.is` 短路、`Set<Listener>`）
- `AppState.tsx` 的 React Context 包裹：`useSyncExternalStore` 订阅 slice
- `USER_TYPE==='ant'` 时返回根 state 会抛错：强制细粒度订阅避免全量 re-render
- `HasAppStateContext` 主动 throw 防嵌套："AppStateProvider can not be nested"

锚点：
- `src/bootstrap/state.ts:31`、`state.ts:45`
- `src/state/store.ts:1`
- `src/state/AppState.tsx:59`、`AppState.tsx:129`
- `src/state/AppStateStore.ts:42`

### 13. 第十二章：ACP / Bridge / Daemon —— 三个长驻模式的接线

章节摘要：ACP（Agent Client Protocol）、Bridge（Remote Control）、Daemon（supervisor）是三种长驻运行模式。共同特征：feature-gated、独立 entry、跨进程通信。这一章揭示它们如何共享底层 query loop 又各自增加编排层，并与产品大纲第十一章（CI / BYOC runner）形成交叉。

子章节：

- ACP agent 实现：`agent.ts` / `bridge.ts` / `permissions.ts` / `entry.ts` + `createAcpCanUseTool` 统一权限流水线
- `acp-link` 包：WebSocket 客户端桥接到 ACP agent（REST 注册 + WS identify 两步流程）
- Bridge 模式：JWT 认证、消息传输、权限回调（feature `BRIDGE_MODE`）
- Daemon 模式：`workerRegistry.ts` 管 worker，`--daemon-worker=<kind>` 派生精简 worker（无 analytics sink）
- 自托管 RCS：`packages/remote-control-server/` Docker 部署 + Web UI（React 19 + Vite + Radix UI）
- **交叉点**：`claude environment-runner` / `self-hosted-runner` BYOC runner 正是 ACP/Bridge/CI 三条线的交汇点，产品大纲第十一章与此章应建立交叉引用

锚点：
- `src/services/acp/`
- `packages/acp-link/`
- `src/bridge/bridgeMain.ts`
- `src/daemon/main.ts`、`workerRegistry.ts`
- `packages/remote-control-server/`

### 14. 第十三章：CLAUDE.md 四层层级与 @include 指令

章节摘要：CLAUDE.md 不是单个文件，而是四层层级：Managed → User → Project → Local，后加载的优先级更高（模型更关注）。`@include` 指令支持 60+ 种文本扩展名，防循环、不存在静默忽略，`MAX_MEMORY_CHARACTER_COUNT=40000`。

子章节：

- 为什么逆序优先：离当前目录越近的文件越晚加载，模型关注度越高
- `@include` 的四种路径形式：`@path` / `@./rel` / `@~/home` / `@/abs`
- `@include` 的边界：仅限叶子文本节点（非代码块内），防循环，不存在静默忽略
- 为什么支持 60+ 种扩展名（`.md` / `.ts` / `.py` / `.rs` / `.swift` / `.sql` / `.graphql` ...）
- `context.ts` 如何把 git status / date / CLAUDE.md / memory files 组装成系统提示

锚点：
- `src/utils/claudemd.ts:1`、`claudemd.ts:88`、`claudemd.ts:95`
- `src/context.ts:36`、`context.ts:116`

### 15. 第十四章：测试策略 —— 为什么 mock 必须从底层 HTTP 开始

章节摘要：Bun 的 `mock.module` 是 process-global 的（last-write-wins），不是 per-file 隔离。一个测试文件的 mock 会污染同进程所有 require/import。所以项目立下铁律：只 mock 有副作用的依赖链（log.ts / debug.ts / bun:bundle / axios），不 mock 纯函数。

子章节：

- Bun `mock.module` 的进程全局陷阱：last-write-wins，测试文件执行顺序不保证字母序
- 为什么不能 mock 被测模块的上层业务模块：`launch*.test.ts` 必须 mock axios 而非 `triggersApi`
- 共享 mock 文件 `tests/mocks/log.ts` 和 `tests/mocks/debug.ts`：源文件导出变更只需改一处
- 集成测试 vs 回归测试的目录布局：`launch*.test.ts` 和 `api.test.ts` 同目录的判断标准
- 排查 mock 污染的 4 步法：单独运行 / 同目录运行 / `console.error` milestone / specifier 解析

锚点：
- `tests/mocks/log.ts`、`debug.ts`、`axios.ts`
- `tests/integration/`

### 16. 第十五章：biome.json 的 42 条规则关闭 —— 反编译产物的指纹

章节摘要：biome.json 关掉了 42 条 lint 规则——suspicious 关 `noExplicitAny` / `noConsole`，style 关 `useConst` / `useTemplate`，complexity 关 `noForEach` / `useArrowFunction`，correctness 关 `noUnusedVariables` / `useExhaustiveDependencies`。这不是偷懒，而是反编译产物的必然：decompiled 代码无法逐行重构，只能保留 recommended 基线。

子章节：

- 42 条规则关闭的分类与原因：suspicious / style / complexity / correctness
- 为什么 `.tsx` 特殊：`lineWidth 120` + 强制分号（其他文件 80 + asNeeded）
- tsc vs biome 的冲突：`noUnusedPrivateClassMembers` 与声明属性的两难，`biome-ignore` 注释保留类型
- `@ts-expect-error` 的维护纪律：MACRO 永真比较保留，类型系统更新后 directive 变 unused 必须移除
- CI 的 `biome ci .` 必须 zero warnings —— 42 条关闭之外仍守底线
- Node.js v22 不支持 `using` 声明的脆弱 transpile：vite 插件把 `using _x =` 正则替换成 `const _x =`，安全前提是 `SLOW_OPERATION_LOGGING` 未启用 —— 一条脆弱的 transpile 依赖

锚点：
- `biome.json:24`、`biome.json:102`
- `.editorconfig`

### 17. 尾声：哪些坑我们没踩 —— 读者可以继续挖掘的方向

章节摘要：本章列出探索过程中因模型过载未能深挖的子系统，邀请读者沿着锚点继续挖掘。同时也诚实交代反编译重建工作的边界。

子章节：

- 未深挖：`ConsoleOAuthFlow.tsx` 的 `china_provider_select` 表单 + `CHINA_LLM_PROVIDERS` 预设表
- 未深挖：ChatGPT 订阅路径与 Codex CLI 跨工具凭证共享（`~/.codex/auth.json`）
- 未深挖：`poorMode`（`/poor` 命令）持久化到 `settings.json` + 跨所有兼容层复用
- 未深挖：`isFirstPartyAnthropicBaseUrl()` TODO 陷阱与 `clearOpenAIClientCache` 模块级缓存陷阱 —— 给读者可追踪的线索
- 未深挖：`vendor/ripgrep/arm64-darwin` 二进制缺失的实际后果（Grep 工具 spawn 该路径 ENOENT，`distRoot.ts` vendor 复制逻辑就是为了解决这个）
- 反编译工作的诚实边界：哪些 stub 是因为反编译丢失，哪些是因为功能原本就 stubbed
- 邀请读者：带上编辑器，沿着锚点继续探索

锚点：
- `src/components/ConsoleOAuthFlow.tsx:1294`
- `src/utils/chinaLlmProviders.ts:44`
- `src/services/api/openai/chatgptAuth.ts:327`
- `src/commands/poor/poorMode.ts`
- `src/services/api/client.ts`（`isFirstPartyAnthropicBaseUrl`）
- `src/services/api/openai/client.ts:39`（`clearOpenAIClientCache`）
- `src/utils/distRoot.ts`、`src/utils/vendor/ripgrep/`

---

## 第三部分：交叉主题（两个视角都需要覆盖）

下列主题在产品与设计两个视角下都需要覆盖，但写法、深度、锚点指向各不相同。

### 1. 排错与错误对照

- 产品视角：作为第十章主体。给一张"Provider 报错对照表"（401 / 403 / 429 / `overloaded_error` 1305 / 模型不存在），配兼容层特有坑（DeepSeek `reasoning_content` 400、Bedrock `anthropic_beta` 400、Gemini 硬抛异常、OpenAI 限流头解析）。措辞用"我遇到了 X，怎么办？"
- 设计视角：当前设计大纲**完全没有排错章**，是最大缺口。建议补一节"排错的工程化"：为什么 Bedrock 补丁必须配 probe 脚本（`scripts/probe-bedrock-beta-fix.ts`）、为什么 DeepSeek 必须回显空 `reasoning_content`、`isFirstPartyAnthropicBaseUrl` TODO 为什么泄漏。措辞用"这个错误的根因是 Y 设计决策"。

### 2. 性能与内存

- 产品视角：第十章一笔带过即可。给"长会话变卡怎么办"的解决路径：`/compact` → `/force-snip` → 重启。RSS 数据用一句话引用。
- 设计视角：第一、三、四章是深水区。给完整数据链（17MB → 1GB vs 220MB；`--version` RSS 966MB → 35MB；6,889 `_debugStack` Error 12MB；`performanceShim` 兜底）。讲清 JSC C++ Vector 永不收缩的根因。

### 3. 安全

- 产品视角：新增第十三章（当前完全缺失）。措辞用"我的密钥去了哪里"。覆盖凭证存储路径清单、OAuth 刷新窗口、`/share` / `/export` 隐私边界、跨工具凭证共享的隐私影响。
- 设计视角：作为"反编译重建的安全约束"穿插在相关章节。措辞用"为什么这么存"。讲 `bypassPermissions` 在非 root/sandbox 的可用性检测、JWT 在 Bridge 的设计、`HasAppStateContext` 主动 throw 防嵌套的安全含义。

### 4. 升级与版本管理

- 产品视角：第十章的 `claude doctor` 子章节展开。给"我该怎么升级"工作流：`claude doctor` 版本检查 → `bun run update` → 重启。
- 设计视角：第二章的"版本号单一来源 `package.json`"展开。讲 MACRO 三层注入、`scripts/probe-bedrock-beta-fix.ts` 作为"SDK 漏洞 probe 模式"的工程实践示范（如何检测上游 SDK 修复后安全删除针对性补丁）。

### 5. 与其他工具集成

- 产品视角：第八章（ACP/Bridge/IDE）+ 第十一章（GitHub Actions）。给"我能在 X 里用 Claude 吗"的清单式回答。
- 设计视角：当前设计大纲**完全没有跨工具集成视角**，是第二大缺口。建议在第十二章（ACP/Bridge/Daemon）补一节"集成边界"：acp-link 与 Codex CLI 凭证共享、`vscode-ide-bridge` 的协议设计、`install-github-app` / `subscribe-pr` / `commit-push-pr` 的工作流契约。

### 6. 可观测性

- 产品视角：第十章子章节。措辞用"我想知道 Claude 在做什么"。覆盖 Langfuse 追踪、`--dump-system-prompt`、`/debug-tool-call`、`BUN_INSPECT` 调试。
- 设计视角：当前设计大纲仅第七章锚点提到 `claude.ts:2999`。建议补一节"观测的注入点"：`recordLLMObservation` 的 `provider` 字段如何从 `getAPIProvider()` 取值、为什么 Langfuse 追踪必须用单一真相源、`performanceShim` 与 OTel 的耦合关系。

### 7. 凭证与认证生命周期

- 产品视角：第二章 + 第十三章交叉。措辞用"我的令牌怎么刷新、什么时候过期"。覆盖 OAuth 设备码、ChatGPT 订阅 5 分钟刷新偏差、China LLM 表单写入流程、`/login` 与 `/logout` 副作用、`/provider unset` 只清 Provider 不清 key。
- 设计视角：在第七、八章穿插。措辞用"为什么 token 这样存"。讲模块级 client cache 的设计权衡（`getAnthropicClient` 参数化 vs `getOpenAIClient` 模块级缓存）、ChatGPT 订阅路径为何读 `~/.codex/auth.json`（与 Codex CLI 复用凭证的设计决策）、5 分钟刷新偏差窗口的容错考量。

---

## 下一步建议

### 建议先写的章节（价值最高）

1. **产品第二章 + 第十章排错对照表**（含"我改了 API key 但没生效"与"为什么切了 Provider 没生效"两个高频困惑）—— 这是用户最高频的痛点，写完立竿见影降低 issue 量。
2. **设计第一章（Code Splitting 是生存需求）+ 第三章（performanceShim）**—— 这两章是全书的叙事引擎，"为什么这么设计"的最戏剧性证据，先写好它们能定调整本书的好奇心基调。
3. **交叉主题"安全"章（产品第十三章）**—— 当前两份大纲都完全缺失，是最显眼的空白；凭证存储、权限模式、OAuth 刷新一旦写清楚，能避免大量误用。
4. **设计第七章（单一调度点）补 tools/filteredTools 不对称段 + 第九章（Usage 字段映射）新增**—— 这两段是"下游零分支"叙事的核心证据与唯一例外，写好了能让设计大纲的 Provider 章节真正立住。
5. **产品第四章（slash 命令速查）按场景分类表**—— 用户最常翻的一章，写好就是一张长期参考表，ROI 极高。

### 会因图示或代码示例受益的章节

1. **设计第一章 Code Splitting**——RSS 数据柱状图（17MB 单文件 1GB / 切分后 35MB / Node 220MB）一张图胜千言。
2. **设计第七/八章 Provider 调度点 + 流适配器**——一张调度流程图：消息归一化 → 工具过滤（tools vs filteredTools 分叉）→ 调度点 → 三条 Provider 路径（Anthropic 原生 / OpenAI/Grok 流适配器 / Gemini 流适配器）→ 统一 `contentBlocks` 累加器。
3. **产品第十章 Provider 报错对照表 + 产品第十三章凭证存储**——前者是表格，后者是 `~/.claude/` 与 `~/.codex/` 的目录树图，直观显示哪些文件含密钥。