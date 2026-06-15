# 第一章：从零开始 —— 安装、首次启动与环境要求

> 把工具装到本机，跑通第一次对话。

## 我需要先装什么？Bun 与 Node.js 的取舍

这一份 Claude Code（反编译重建版，下面统一叫 CCB）有两种运行形态，对应两套前置依赖。**普通使用者只需要 Node.js**：通过 npm 装好 `ccb` 命令后，`ccb` 默认就是用 Node.js 跑的（`package.json` 里的 `"ccb": "dist/cli-node.js"`）。Node.js 用 18 或更新的版本即可，没有特别严格的版本要求。

如果你打算从源码克隆、改代码、跑测试或调试，那需要装 Bun。源码模式对 Bun 版本有硬性要求：`package.json` 的 `engines.bun` 字段写明 `>=1.3.0`，安装文档进一步建议 `bun upgrade` 升到最新，老版本会触发一些奇怪的 BUG（路径解析、热重载偶发失败等）。装 Bun 的方式：

```bash
# Linux / macOS
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

为什么要同时支持两个运行时？源码构建出的产物是同一份 JS（`dist/cli.js` 加几百个 chunk 文件），两个 shebang 入口只是把它喂给不同的解释器：

- `dist/cli-bun.js` 头部是 `#!/usr/bin/env bun`，启动快、内存占用低（`--version` RSS 大约 35MB）
- `dist/cli-node.js` 头部是 `#!/usr/bin/env node`，兼容性更好，不依赖 Bun

`build.ts` 末尾会自动生成这两个入口，所以你不用纠结——装好哪个运行时就调对应那个命令即可。

## 三种安装方式：npm 全局、源码 dev、构建产物

### 方式一：npm 全局安装（最常用）

一行命令搞定，适合只想把工具用起来的人：

```sh
npm i -g claude-code-best
ccb --version        # 应输出类似 2.7.0 (Claude Code)
```

装完后会得到三个全局命令：`ccb`（Node 形态，默认推荐）、`ccb-bun`（Bun 形态，启动更快）、`claude-code-best`（与 `ccb` 等价的别名）。日常调用用 `ccb` 就行；如果你的机器装了 Bun 且追求更冷启动，可以试 `ccb-bun`。

更新到最新版的命令是：

```sh
ccb update
```

> 不推荐 `bun i -g claude-code-best`：bun 全局安装在部分平台有路径冲突。如果一定要用 bun，先跑 `bun pm -g trust claude-code-best @claude-code-best/mcp-chrome-bridge` 解除信任限制。

### 方式二：源码 dev 模式（贡献者/想折腾的人）

需要 Bun ≥ 1.3.0：

```bash
git clone https://github.com/claude-code-best/claude-code.git
cd claude-code
bun install
bun run dev
```

`bun run dev` 实际执行的是 `scripts/dev.ts`：它通过 `bun -d MACRO.X:Y` 把版本号等常量在启动时注入，再通过 `--feature <name>` 把 `DEFAULT_BUILD_FEATURES` 列表里的功能开关逐个打开。也就是说，dev 模式默认启用全部功能，最贴近"完整体验"。

带调试器启动：

```bash
BUN_INSPECT=9229 bun run dev:inspect
```

`BUN_INSPECT` 环境变量被 `scripts/dev.ts` 读取后会自动加上 `--inspect-wait=9229`，浏览器或 VS Code 连上 `chrome://inspect` 即可断点调试。

一次性管道调用：

```bash
echo "say hello" | bun run src/entrypoints/cli.tsx -p
```

### 方式三：构建产物

把源码编出 `dist/` 目录，之后既可以用 bun 也可以用 node 跑：

```bash
bun run build        # 默认走 Bun.build，输出 dist/cli.js + chunks/
# 或
bun run build:vite   # 备选 Vite 链，chunk 体积更小

node dist/cli.js --version
```

`build.ts` 做了四件事：用 `Bun.build` 切分代码（`splitting: true`），把 `import.meta.require` 改写成 Node 兼容版本，给第三方依赖里 `var { x } = globalThis.Bun` 这类解构加 `typeof` 守卫，再把 `vendor/audio-capture/` 和 `src/utils/vendor/ripgrep/` 拷到 `dist/vendor/` 下。

## 第一次启动会发生什么：trust dialog、init 流程

进入任意项目目录后启动：

```bash
cd my-project
ccb
```

第一次（或换了新目录）会依次经过这几个阶段：

**1. 信任对话框（Trust Dialog）**

弹出一个红框问你 "Is this a project you trust?"，下面列出当前目录绝对路径，选项只有两个：

- `Yes, I trust this folder` —— 把"已信任"标记写到当前项目的 `.claude/settings.json`（`hasTrustDialogAccepted: true`），之后这个目录不再询问
- `No, exit` —— 直接退出，进程返回码 1

这一步不是仪式感的，它真在守门：在用户确认信任之前，CLAUDE.md 预读、系统上下文预取、MCP server 拉起等副作用统统不会跑。`src/main.tsx` 里通过 `checkHasTrustDialogAccepted()` 判断，未信任时只 prefetch 安全内容。源码在 `src/components/TrustDialog/TrustDialog.tsx`。

**2. 初始化（init）**

信任通过后，`src/entrypoints/init.ts` 的 `init()` 接管。它会：启用配置系统（`enableConfigs`）、应用 `.claude/settings.json` 里的环境变量（先应用"安全"子集，再在信任后应用全集）、配置代理与 mTLS、初始化 Sentry 与 Langfuse（没配 key 就是 no-op）、对 Anthropic API 做 TCP+TLS 预连接（重叠 100~200ms 握手时间）。`init()` 用 `lodash-es/memoize` 包了一层，整个进程只会跑一次。

**3. 进入 REPL**

最后渲染欢迎框：

```
╭─────────────────────────────────────────────╮
│  ✻ Welcome to Claude Code Best              │
│  /help for commands, ctrl+c to exit         │
╰─────────────────────────────────────────────╯
>
```

第一次还没配 API 的话，发任何消息都会被引导去 `/login` 配置 Provider（见第二章）。

## 快速路径命令一览

`src/entrypoints/cli.tsx` 的 `main()` 按优先级串了十几条"快速路径"，意图是让某些子命令几乎零模块加载就返回，避免动辄加载几 MB 代码。

最常用、最快的就是看版本：

```bash
ccb --version
# 或
ccb -v
```

`cli.tsx` 第 80 行的判断只匹配参数数量为 1 且就是 `--version` / `-v` / `-V`，命中后直接 `console.log` MACRO 里编译期注入的版本号就 return，**完全不加载任何其他模块**。版本号的单一来源是 `package.json`（`scripts/defines.ts` 的 `getMacroDefines()` 读它注入 `MACRO.VERSION`），避免多处写死产生漂移。

其他快速路径包括：

```bash
ccb --dump-system-prompt        # 输出渲染后的系统提示（feature-gated，外部构建会被 DCE 掉）
ccb --computer-use-mcp          # 启动 Computer Use MCP server 模式
ccb --chrome-native-host        # Chrome native messaging host 模式
ccb remote-control              # Bridge / Remote Control 模式（也叫 rc / remote / sync / bridge）
ccb daemon start                # Daemon 长驻模式
ccb ps / logs / attach / kill   # 后台会话管理
ccb --resume                    # 恢复上次会话
ccb -c                          # 继续当前目录最近一次会话
```

完整子命令列表在 `src/main.tsx`（Commander.js 注册），想看自己关心的命令用法：

```bash
ccb --help
ccb mcp --help
ccb doctor --help
```

## 把 `ccb` 设为全局命令：`cli-bun.js` 与 `cli-node.js` 双入口

如果走 npm 全局安装，`ccb` 命令已经自动注册好。如果走源码模式想让全局也能直接调，可以手动把 `dist/cli-bun.js` 或 `dist/cli-node.js` 软链到 PATH 里。两个入口内容极简：

```js
// dist/cli-bun.js
#!/usr/bin/env bun
import "./cli.js"

// dist/cli-node.js
#!/usr/bin/env node
import "./cli.js"
```

实际逻辑都在 `dist/cli.js`（以及几百个按需加载的 chunk）。两个入口只是换运行时，`build.ts` 最后用 `chmodSync(path, 0o755)` 给它们加了可执行位。

选哪个？机器装了 Bun 就用 `cli-bun.js`（启动更快、内存占用更低，`--version` 的 RSS 实测从 966MB 降到 35MB），没装或不想装就用 `cli-node.js`（兼容性更好）。注意 `package.json` 里的 `"bin"` 字段默认把 `ccb` 指向 `dist/cli-node.js`——也就是说普通用户拿到的是 Node 版本，想用 Bun 版本要么显式调 `ccb-bun`，要么自己改 bin。

## 环境自检：`ccb doctor`

`ccb doctor`（在 `src/main.tsx` 第 5282 行注册）是一个独立的健康检查子命令，会跳过信任对话框、跳过启动 `setup()`，专门用来诊断安装状态。它渲染的是 `src/screens/Doctor.tsx`，列出：

- 当前版本号、npm 上最新版本与稳定版本（通过 `getNpmDistTags()` 拉取）
- 安装类型（`native` 还是 npm 全局）
- 当前生效的设置文件路径与解析错误
- MCP server 连接状态、agent 定义加载情况
- 沙箱状态（`SandboxDoctorSection`）
- 文件锁状态（`getAllLockInfo`、`cleanupStaleLocks`）

跑一次：

```bash
ccb doctor
```

它的描述里有句重要警告："The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust."（信任对话框被跳过，stdio 类 MCP server 会被拉起做检查，**只在信任的目录里跑**）。

升级到最新版：

```bash
ccb update
```

`ccb update` 对应 `src/cli/updateCCB.ts`：先看当前是不是 bun 装的（看 `process.execPath` 是不是落在 bun 的全局路径），是的话用 `bun update -g`，否则用 `npm install -g`。

## 下一步

- 想配 API（Anthropic / OpenAI 兼容 / Gemini / Grok / 国产大模型），看 [第二章：让 Claude 听你的 —— 配置 Provider 与模型](./02-providers.md)
- 想直接发消息、看流式回复、切权限模式，看 [第三章：日常对话 —— 交互式 REPL 怎么用](./03-repl.md)
- 想知道有哪些 slash 命令、按场景找，看 [第四章：slash 命令速查](./04-slash-commands.md)
