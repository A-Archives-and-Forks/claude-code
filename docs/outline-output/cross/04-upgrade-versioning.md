# 升级与版本管理

> 同一个 `2.7.0` 在使用者眼里是"该不该 `claude update`、`claude doctor` 里那个 latest 是不是真的比我新"，在开发者眼里是"为什么 `MACRO.VERSION` 必须从 `package.json` 反推、为什么 `--version` 走零模块加载 fast-path、为什么 Bedrock 那段针对性补丁必须留一段写着 probe 文件路径的注释"。升级和版本管理天生是双视角主题——用户想知道"怎么升、升完会不会坏"，开发者想知道"版本号从哪里来、补丁什么时候才能拆"。

## 产品视角（写给使用者）

这一节回答三个问题：**我怎么知道该不该升级**、**怎么升**、**升完之后老的行为会不会变**。读完之后，你应该能判断"我现在跑的版本是不是最新的"、"这次升级会不会把我正在用的 Provider 弄坏"。

### 我怎么知道该不该升级

两条路，任选其一：

- **跑 `claude doctor`**。这是最稳的诊断入口，对应 `src/commands/doctor/doctor.tsx`（命令本身在 `src/commands/doctor/index.ts` 注册）。它会渲染一个 `Doctor` 屏幕（`src/screens/Doctor.tsx`），里面分三段对你最有用的信息：
  - **Diagnostics** 段：`Currently running: <type> (<version>)`、安装路径、被哪个二进制调用、ripgrep 是否可用（`Doctor.tsx:218-232`）。如果你装了多个版本（npm-global + native + package-manager 混着装），这里会显式 warn `Multiple installations found` 并把每个安装的 type 和 path 列出来（`Doctor.tsx:244-254`）。多安装是升级后行为飘移最常见的根因——你 `claude update` 升的是某一个，shell 里 `claude` 还指向另一个。
  - **Updates** 段：`Auto-updates` 的开关、`Update permissions: Yes/No (requires sudo)`、`Auto-update channel`（`latest` 或 `stable`），以及从远端拉下来的 `Stable version` / `Latest version`（`Doctor.tsx:279-289`，远端版本走 `getGcsDistTags` 或 `getNpmDistTags`，见 `Doctor.tsx:91-98`）。
  - **Version Locks** 段（仅当 PID-based locking 启用时）：列出当前被锁住的版本和持有它的 PID（`Doctor.tsx:311-328`）。如果你看到某个 lock 标了 `(stale)`，说明上次升级被中断了，残留了一个进程没清掉的锁。
- **直接跑 `claude --version`**（或 `claude -v` / `claude -V`）。这是最快的路径，只打印一行 `<version> (Claude Code)` 就退出（`src/entrypoints/cli.tsx:80-84`）。**注意**：它只告诉你"当前跑的是几"，不会告诉你"远端最新是几"——要对比必须用 `claude doctor`。

`claude doctor` 还会顺带帮你把一堆"升级之后可能出问题"的信号检查一遍：env 变量是否超上限（`BASH_MAX_OUTPUT_LENGTH` / `TASK_MAX_OUTPUT_LENGTH` / `CLAUDE_CODE_MAX_OUTPUT_TOKENS`，见 `Doctor.tsx:103-128`）、settings 有没有 schema 错误、agent 文件有没有解析失败、MCP server 有没有 parsing warning、keybindings 有没有冲突。升级前先跑一次 `claude doctor`、升级后再跑一次对比，是排错最高效的姿势。

### 怎么升

跑 `claude update`（注册在 `src/main.tsx:5346-5353`，实现是 `src/cli/updateCCB.ts` 的 `updateCCB()`）。它会做这几件事：

1. 读当前版本：先尝试从 `distRoot` 上层的 `package.json` 读 `version`，读不到就退回 `MACRO.VERSION`（`updateCCB.ts:18-29`）。这一步保证"全局装的 ccb"和"开发模式下跑的 cli.tsx"看到的是同一个版本号。
2. 探测包管理器：先看当前进程是不是从 bun 起的（`process.execPath` 含 `bun`，或者 `~/.bun/install/global/node_modules/claude-code-best` 存在），是就用 bun；否则用 npm（`updateCCB.ts:56-77`）。
3. 从 npm registry 拉 latest 版本号：`npm view claude-code-best@latest version --prefer-online`（`updateCCB.ts:79-90`），10 秒超时。
4. 比较：如果 `current >= latest`，直接打印 `ccb is up to date (<version>)` 退出；否则继续（`updateCCB.ts:113-122`）。
5. 实际装：`bun install -g claude-code-best@latest` 或 `npm install -g claude-code-best@latest`，120 秒超时（`updateCCB.ts:131-152`）。

升级完成之后**必须重启 `claude`**。原因有两条：

- `claude update` 只动磁盘上的文件，不动当前正在运行的进程内存。你的 REPL 还跑着旧代码。
- 多个兼容层的客户端（OpenAI / Grok）走的是模块级缓存（见 cross/03-security.md 的"为什么 OpenAI 客户端是模块级缓存"），重启之外没有任何方式让它们重新读 key 和 endpoint。

如果 `claude update` 失败，错误信息会直接建议你手动跑对应的 `bun install -g claude-code-best@latest` 或 `npm install -g claude-code-best@latest`（`updateCCB.ts:155-173`）。这两个命令本质上和 `claude update` 跑的是同一条 shell，区别只是 `claude update` 多了一层"探测包管理器 + 比较版本"的逻辑——失败时跳过这层逻辑直接装 latest 是最快的恢复方式。

### 升级之后老的行为会不会变

会，但只有两种情况值得你担心：

- **版本号最小限制**。`assertMinVersion()`（`src/utils/autoUpdater.ts:79-111`）会在启动时从远端 Statsig config `tengu_version_config` 读 `minVersion`，如果你跑的版本低于这个值，CLI 会**直接退出**并打印 `It looks like your version of Claude Code (<version>) needs to update`。这是服务端 kill switch——某些重大变更（API schema 不兼容、安全修复）上线时，官方会把这个值推高，强制所有人升级。**用户侧含义**：如果你某天打开 `claude` 发现它拒绝启动并提示要 update，先 `claude update` 再说。
- **最大版本回退**。`getMaxVersion()`（`autoUpdater.ts:125-141`）从同一个远端 config 读 `external` / `ant` 字段，作为"当前允许的最高版本"。这是 incident 时的紧急刹车——如果新版本被发现有严重 bug，官方会把 max 版本设到上一个稳定版，auto-updater 就不会把用户升到坏版本。**用户侧含义**：你手动 `claude update` 后看到的版本可能比 npm registry 上的 `latest` 旧，这是有意的回退，不是你装错了。

注意 `assertMinVersion` 的注释（`autoUpdater.ts:46-60`）专门讲了一处容易混淆的设计：版本号格式 `X.X.X+SHA`（continuous deployment 用的带 build metadata 的 semver）里，**比较版本大小**（`assertMinVersion`）会忽略 `+SHA`，**检测是否有更新**（`claude update`）会用精确字符串比较不忽略。所以你可能看到 `claude --version` 显示 `2.7.0+abc123`、npm 上 latest 也是 `2.7.0`，但 `claude update` 还是会重新装一遍——因为它在比 SHA，发现你本地的 SHA 不是最新的。这不是 bug，是为了让 continuous deployment 的每次 commit 都能推到用户。

### 升级前自检清单

- `claude doctor` 看一下 `Auto-update channel`、`Update permissions`、有没有 `Multiple installations found` 警告。多安装的情况下先想清楚 shell 里 `which claude` 指向哪一个。
- 如果你在用 OpenAI / Gemini / Grok 兼容层，记录一下当前 `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROK_API_KEY` 的值（升级本身不动 key，但万一升级过程中断了重装，可能要重设）。
- 如果你在 Bridge / Daemon / 后台 session 模式下长跑，升级前先 `claude daemon stop` / `claude kill` 把它们停掉——升级会替换二进制，但不会通知正在跑的进程。

## 设计视角（写给开发者）

设计大纲原本只在第二章入口链里点了一句"版本号单一来源 `package.json`"。这一节把版本号怎么流到运行时、针对性补丁什么时候该拆、双构建管线的版本一致性这三件事讲透。每个决策背后都有一个具体的约束（漂移、SDK 漏洞、bun/node 双运行时）。

### 为什么版本号必须从 `package.json` 反推，而不是 hardcoded

打开 `scripts/defines.ts:7-24`：

```ts
const pkgPath = resolve(__dirname, '..', 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

export function getMacroDefines(): Record<string, string> {
  return {
    'MACRO.VERSION': JSON.stringify(pkg.version),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    // ...
  }
}
```

注释里写得很直白：`VERSION is read from package.json to avoid version drift`。版本号如果既写在 `package.json`、又写在 `defines.ts`、又出现在某处字符串字面量，发版时一定有人忘了同步其中一个，用户看到的 `claude --version` 就会和 npm 上的版本对不上。

但"单一来源"的实现路径很有意思——它必须穿过三层 MACRO 注入才能到达运行时：

1. **dev 模式**：`scripts/dev.ts:18-29` 把 `getMacroDefines()` 的返回值用 `-d` flag 一条条传给 `bun run`。注释（`dev.ts:5-9`）专门解释了为什么不用 `bunfig.toml` 的 `[define]`——因为它不会传播到 dynamically imported modules。
2. **build 模式**：`build.ts` 把同样的 defines 喂给 `Bun.build({ define })`，由 Bun 编译器在 transpile 阶段做字面量替换。
3. **运行时兜底**：如果有人直接跑 `bun src/entrypoints/cli.tsx`（既不走 `bun run dev` 也不走 dist/），`cli.tsx:9-21` 会检测 `globalThis.MACRO === undefined` 并填一个 fallback，`VERSION` 从 `process.env.CLAUDE_CODE_VERSION || '2.1.888'` 取。这个 `'2.1.888'` 是写死的 fallback——它只在"完全脱离工具链直接跑源码"时才出现，正常使用路径上永远不会看到这个版本号。

**为什么 `--version` fast-path 必须零模块加载**：`cli.tsx:79-84` 的逻辑只有一行 `console.log(\`${MACRO.VERSION} (Claude Code)\`)`。这之所以能做到"零模块加载"，恰恰是因为 `MACRO.VERSION` 在 transpile 阶段就已经被替换成了字面量字符串——运行时不需要 import 任何东西就能拿到版本号。如果版本号是从某个模块的 `getVersion()` 函数读出来的，`--version` 就必须 import 那个模块，fast-path 就破了。**版本号的单一来源约束反过来塑造了 fast-path 的实现方式**——这是约束驱动设计的一个干净例子。

### `claude update` 为什么自己重新发明了版本比较，而不是用现成的 semver 库

看 `src/cli/updateCCB.ts:124-134`：

```ts
function gte(a: string, b: string): boolean {
  const parseVer = (v: string) => v.replace(/^\D/, '').split('.').map(Number)
  const pa = parseVer(a)
  const pb = parseVer(b)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false
  }
  return true
}
```

一个手写的、只有 8 行的 `gte`。**为什么不复用 `src/utils/semver.ts`**？因为 `updateCCB.ts` 是一个**必须能独立运行的子命令**——它从 `getCurrentVersion()` 开始就要能在"用户刚装好 ccb、还没装依赖"的极简环境下工作。它 import 的全是 `node:child_process` / `node:fs` / `node:os` 这种 zero-dependency 标准库，加上项目内部的 `distRoot` / `execFileNoThrowWithCwd` / `gracefulShutdown` / `process` / `debug` / `chalk`。`semver.ts` 依赖的图更大，引入它会让 updateCCB 的启动时间变长、潜在故障面变大。

代价是这个 `gte` **不处理 build metadata**：`2.7.0+abc` 和 `2.7.0+def` 在这个比较里是相等的。`updateCCB.ts:120` 那条 `latestVersion === currentVersion || gte(currentVersion, latestVersion)` 的 `||` 短路就是补偿——先用精确字符串比较（能区分 SHA），相等了再退到手写 semver 比较（防 latest 比当前旧这种边界情况）。这个组合策略和 `autoUpdater.ts:46-60` 那段注释承认的"两套比较逻辑并存"是同一个权衡的延伸。

### Bedrock 补丁为什么必须留一段写着 probe 文件路径的注释

这是整个项目里最有"工程纪律"感的一段代码。打开 `src/services/api/bedrockClient.ts:1-35`：

```ts
/**
 * Extends AnthropicBedrock to work around an upstream bug where the SDK
 * re-plants the `anthropic-beta` HTTP header value into the request body
 * as `anthropic_beta`. Bedrock's Opus 4.7 endpoint rejects any request with
 * `anthropic_beta` in the body with a 400 "invalid beta flag" error.
 *
 * Source of the bug (SDK 0.26.4, still present through 0.28.1):
 *   node_modules/@anthropic-ai/bedrock-sdk/client.js lines 122-127
 *
 * When upstream ships a fix, verify the probe in scripts/probe-bedrock-beta-fix.ts
 * shows "bug reproduced: false", then delete this class and change
 * services/api/client.ts to instantiate `AnthropicBedrock` directly.
 */
```

这段注释干了两件不寻常的事：

1. **精确锁定漏洞的范围**：SDK 版本（0.26.4-0.28.1）、出问题的源码行号（`client.js` 122-127）、错误现象（body 里多了 `anthropic_beta` 字段、Opus 4.7 返回 400）、上游 issue 编号（`anthropics/claude-code#49238`）。所有信息都精确到能在 5 秒内验证。
2. **指明补丁的拆除条件**：当上游修复后，跑某个 probe 脚本确认 bug 不再复现，就可以**删掉整个 `BedrockClient` 类**，把 `services/api/client.ts` 改回直接 `new AnthropicBedrock(...)`。

**值得注意的事实**：注释里提到的 `scripts/probe-bedrock-beta-fix.ts` **目前并不存在于仓库里**（`find scripts -name '*probe*'` 只能找到 `probe-local-wiring.ts` 和 `probe-subscription-endpoints.ts`）。这不是文档错——这是注释作者留下的**意图标记**：补丁本身写了，但配套的"自动检测修复后能否拆除"的 probe 脚本还没补。读者看到这段注释时，应该理解成"这个补丁是临时的，未来某天上游修了就要拆，但目前没人持续监控上游 SDK 的变化"。

这正是 probe 模式的**价值与代价**：

- **价值**：每个针对性补丁都明确标注"我为什么存在、什么时候可以消失"。两年后某个新人接手代码，看到 `BedrockClient` 不会一脸懵——他能从注释里立刻判断"这个补丁还要不要留"。
- **代价**：probe 脚本必须有人维护。注释里写的那个文件不存在，意味着拆除条件目前**没有自动验证**——上游 SDK 升级到修复版之后，没有人会被自动通知"现在可以删 BedrockClient 了"。补丁会一直留着，直到某次 code review 有人手动翻到这段注释、手动验证、手动拆。

**根因**：针对性补丁是技术债的一种特殊形态——它承认"我在等上游修"。probe 模式是把这种"等"变得**可追踪**：每段补丁都自带拆除说明书。但说明书本身不会自动执行，所以 probe 模式的实际效果取决于团队是否真的定期跑 probe。这个项目目前的状态是"说明书有了，自动化还没跟上"。

### 为什么 MACRO 必须用编译期字面量替换，而不是运行时函数

版本号和构建时间这种常量，理论上完全可以写成一个普通的 `export const VERSION = pkg.version`。为什么非要走 MACRO 编译期替换？

答案藏在 `--version` 的 fast-path 设计里。如果 VERSION 是普通 export，`cli.tsx:80-84` 那段代码就必须 `import { VERSION } from '...constants...'`，这次 import 会触发常量模块所在依赖图的解析——`constants/` 里如果还有别的导出、还有别的副作用，fast-path 就不再是"零模块加载"。

MACRO 替换绕开了这个问题：`MACRO.VERSION` 在 transpile 阶段被替换成字符串字面量 `'2.7.0'`，运行时 `cli.tsx` 里那行就是 `console.log(\`2.7.0 (Claude Code)\`)`——没有任何 import、没有任何模块解析、没有任何副作用。`--version` 的 RSS 因此能从"加载整个 CLI"降到几十 MB（见 cross/02-performance-memory.md）。

这个选择还顺手解决了**dev 和 build 的版本号一致性**：`dev.ts` 和 `build.ts` 都从同一个 `getMacroDefines()` 读 defines（`defines.ts:14`），所以 dev 模式跑出来的 `--version` 和 build 出来的 dist 跑出来的 `--version` 一定是同一个值。如果走 `export const VERSION`，dev 模式读源码 `package.json`、build 模式读 build 时打包进去的 `package.json`，两边就有漂移风险。

**根因**：MACRO 不是"为了语义清晰而引入的抽象"，而是"为了让 fast-path 真的快、为了让 dev/build 版本一致而被迫引入的编译期机制"。它是性能和一致性约束的共同产物。

### 双构建管线（Bun.build vs Vite）的版本号一致性

项目有两套构建管线（详见设计大纲第一章）：`build.ts` 跑 `Bun.build()`、`vite.config.ts` 跑 Vite。两者都从 `scripts/defines.ts` 读 MACRO defines：

- **Bun.build 路径**：`build.ts` 直接调 `getMacroDefines()` 喂给 `Bun.build({ define })`。
- **Vite 路径**：`scripts/vite-plugin-feature-flags.ts` 在 transform 阶段做字面量替换。

两条路径用的是同一个 defines 函数，所以产物的版本号一致。这看起来是显然的，但它是**有意设计**——如果两条路径各自硬编码版本号、或各自从不同地方读，就会有"Vite 构建的 `--version` 和 Bun 构建的 `--version` 不一致"这种诡异 bug。`defines.ts` 既是单一来源，也是两条管线的契约。

构建后还有一道独立的 post-process（`build.ts:43-46`）：把 `import.meta.require` 替换成 `typeof import.meta.require === "function" ? import.meta.require : (await import("module")).createRequire(import.meta.url)`。这道 patch 让产物**同时兼容 bun 和 node**——同一份 dist 文件，bun 跑用 `import.meta.require`（Bun 原生支持），node 跑用 `createRequire`（Node 标准 API）。这是双入口 `cli-bun.js` / `cli-node.js` 能共用同一份 chunk 的前提。

### 升级流程为什么不走"热替换"

`claude update` 装完新版本后，**当前进程不会被替换**。REPL 还跑着旧代码，直到用户手动退出重开。为什么不像浏览器那样做热替换？

打开 `cli/updateCCB.ts:131-152` 看实际逻辑：它跑的是 `execSync('bun install -g ...@latest')` 或 `execSync('npm install -g ...@latest')`。这是**子进程同步执行**，完成后新文件就位，但**父进程（当前 REPL）的 require 缓存、模块级 const、模块级 client 缓存全部不动**。

热替换需要解决三个难题：

1. **模块级缓存的失效**。`getOpenAIClient` / `getGrokClient`（见 cross/03-security.md）把客户端实例缓存到模块级变量，热替换要遍历所有这些模块、清掉缓存。
2. **模块级 const 的重捕获**。`cli.tsx:56-69` 那段 ablation 逻辑，`BashTool` / `AgentTool` / `PowerShellTool` 在 import 时就把环境变量捕获进模块级 `const`。热替换要重新 import 这些模块，让 const 重新捕获——但这意味着工具实例全部重建，正在跑的 agent / 后台 task 全部丢失。
3. **React 状态树的保留**。REPL 是 Ink 渲染的 React 树，messages / tools / MCP 连接全是 state。热替换要保证 state 不丢——但新版代码的 state shape 可能变了（schema migration）。

三个难题都没好解。所以项目选择了一个朴素但鲁棒的方案：**升级只动磁盘，重启靠用户**。代价是多了一次手动重启，收益是绝对不会出现"半新半旧"的不一致状态。这个权衡和 `/logout` 必须先 flushTelemetry 再清凭证（见 cross/03-security.md）是同一种风格——**宁可让用户多做一步，也不接受状态不一致**。

## 两视角如何呼应

用户视角的每一个升级困惑，几乎都能在设计视角找到对应的设计决策：

- **"我怎么知道该不该升"**（产品视角）对应 **"`--version` 为什么是零模块加载 fast-path"**（设计视角）——用户看到的是"一行命令秒出"，开发者看到的是"MACRO 编译期替换让版本号成为字面量、绕开 import 触发的模块解析"。
- **"`claude update` 装的是哪个版本"**（产品视角）对应 **"为什么版本号必须从 `package.json` 反推"**（设计视角）——用户看到的是"升级提示很准"，开发者看到的是"`scripts/defines.ts` 的单一来源约束 + dev/build 双管线共用同一个 defines 函数"。
- **"为什么 `claude update` 之后还要手动重启"**（产品视角）对应 **"为什么升级不走热替换"**（设计视角）——用户看到的是"多一步操作"，开发者看到的是"模块级缓存 + 模块级 const + React state 三重难题的工程权衡"。
- **"为什么我的版本号带 `+SHA` 后缀，npm 上的 latest 看起来一样却还是要重装"**（产品视角）对应 **"`assertMinVersion` 的两套比较逻辑"**（设计视角）——用户看到的是"莫名其妙的重复升级"，开发者看到的是"continuous deployment 的 SHA 比较与 semver 比较并存的诚实设计"。
- **"Bedrock 报 400 invalid beta flag 怎么办"**（产品视角，详见 cross/01-troubleshooting.md）对应 **"BedrockClient 为什么必须留 probe 注释"**（设计视角）——用户看到的是"升级 SDK 之后某个错误消失了或出现了"，开发者看到的是"针对性补丁的拆除条件被写成注释、probe 脚本作为意图标记但当前仓库里还没建"。
- **"升级之后 key 还在不在"**（产品视角）对应 **"升级为什么只动磁盘不动进程"**（设计视角）——用户看到的是"key 不变、设置不变"，开发者看到的是"`updateCCB.ts` 只跑 npm/bun install、完全不碰 ~/.claude/ 下的凭证文件"。

这种呼应关系是升级与版本管理章必须双视角覆盖的核心原因：用户视角告诉你**怎么升才安全**，设计视角告诉你**这个升级机制覆盖了什么、没覆盖什么**。两个视角合在一起，才能让使用者正确评估"我现在该不该升、升完之后哪些东西会变、哪些不会变"——不会盲目相信"升级就是好的"，也不会因为某次升级出过 bug 就永远不敢再升。
