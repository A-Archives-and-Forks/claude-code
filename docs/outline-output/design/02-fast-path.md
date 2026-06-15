# 第二章：入口的 Fast-Path 优先级链 —— 为什么 --version 必须零模块加载

> 十几条快速路径按优先级串接，--version 的代码路径上没有任何 import。

## 从 main() 的第一条分支说起

打开 `src/entrypoints/cli.tsx:76`，你会看到整个 CLI 的入口函数 `main()`。它做的第一件事是 `process.argv.slice(2)`，然后立刻检查是不是 `--version` 或 `-v`：

```typescript
// src/entrypoints/cli.tsx:80
if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
  console.log(`${MACRO.VERSION} (Claude Code)`);
  return;
}
```

这看起来平淡无奇。但注意注释里写的：**"Fast-path for --version/-v: zero module loading needed"**。整条代码路径不需要任何 `import`。`MACRO.VERSION` 不是运行时变量 -- 它是编译期字面量替换的结果，在产物中会被直接内联为字符串 `"2.7.0"`。打开 `scripts/defines.ts:18`，你会看到它的来源：

```typescript
// scripts/defines.ts:20
'MACRO.VERSION': JSON.stringify(pkg.version),
```

其中 `pkg.version` 读取自 `package.json`。版本号的单一来源是 `package.json`，不是散落在代码各处的 hardcoded 字符串。这是一个看似显而易见、但反编译产物特别容易弄丢的属性 -- 反编译不保留构建元信息，`MACRO.VERSION` 在重建时必须重新接回 `package.json`，否则每次升级都要改两处，版本号漂移就只是时间问题。

**如果不这么做会怎样？** 如果版本号 hardcoded 在 `cli.tsx` 里，`bun run dev` 和 `bun run build` 走两条注入路径（`-d` flag vs `Bun.build define`），两者必须各自维护一份版本号，迟早会漂移。`package.json` 是 npm 生态的约定真相源，所有工具都认它，CI、发布、changelog 生成都从这里读。

## 完整的优先级链

`--version` 之后是 `--dump-system-prompt`（feature-gated，`src/entrypoints/cli.tsx:93`）。这条路径稍微重一点 -- 需要 import `config.js`、`model.js`、`prompts.js`，但仍然是动态 import，不会在 `--version` 被执行时付出任何代价。

然后是 Chrome MCP（`src/entrypoints/cli.tsx:106`）、Computer Use MCP（`src/entrypoints/cli.tsx:116`）、ACP agent（`src/entrypoints/cli.tsx:124`）、weixin（`src/entrypoints/cli.tsx:131`）等独立服务模式的快速路径。

再往下是 `--daemon-worker`（`src/entrypoints/cli.tsx:164`），Bridge/Remote Control（`src/entrypoints/cli.tsx:183`），daemon 子命令（`src/entrypoints/cli.tsx:231`），background sessions 的 `--bg` 快捷方式（`src/entrypoints/cli.tsx:266`），向后兼容的 `ps/logs/attach/kill` 映射（`src/entrypoints/cli.tsx:278`），模板 jobs（`src/entrypoints/cli.tsx:297`），BYOC runners（`src/entrypoints/cli.tsx:319`），tmux worktree（`src/entrypoints/cli.tsx:338`）。

所有路径都满足同一个约束：**只在自身真正需要的模块上做动态 import，然后 return**。没有哪条路径会把无关代码拉进来。

最后，如果没有命中任何快速路径，`src/entrypoints/cli.tsx:375` 才会 `import('../main.jsx')`，加载完整的 Commander.js CLI 定义和 REPL 启动逻辑。

**如果不这么做会怎样？** 如果所有路径都走 `import('../main.jsx')`，那 `claude --version` 的启动延迟就和 `claude` 完整启动一样长。`main.jsx` 有 5674 行，注册了上百个 subcommand，pull 了一整棵依赖树。在一个 code-split 的 600+ chunk 产物中，这意味着 dozens of chunks 要被解析和执行。JSC 又不是 V8 -- 它没有懒解析，每个 chunk 一加载就开始全量编译。

## 一条脆弱但必要的初始化顺序依赖

`src/entrypoints/cli.tsx:52` 到 `cli.tsx:69` 有一段看起来很不寻常的代码：

```typescript
// src/entrypoints/cli.tsx:55
// Harness-science L0 ablation baseline. Inlined here (not init.ts) because
// BashTool/AgentTool/PowerShellTool capture DISABLE_BACKGROUND_TASKS into
// module-level consts at import time — init() runs too late.
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of [
    'CLAUDE_CODE_SIMPLE',
    'CLAUDE_CODE_DISABLE_THINKING',
    'DISABLE_INTERLEAVED_THINKING',
    'DISABLE_COMPACT',
    'DISABLE_AUTO_COMPACT',
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  ]) {
    process.env[k] ??= '1';
  }
}
```

注释说的很直白：这段代码必须 **inline 在 `cli.tsx` 顶层**，不能放在 `init.ts` 或其他任何晚于工具 import 的地方。原因是什么？打开 `packages/builtin-tools/src/tools/BashTool/BashTool.tsx:296`：

```typescript
// BashTool.tsx:296
const isBackgroundTasksDisabled =
  isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS);
```

这是一个 **模块级 const**。它在 `BashTool.tsx` 被 import 的那一刻求值，之后不再更新。`AgentTool.tsx:118` 和 `PowerShellTool.tsx:254` 也有同样的模式。如果 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 的设置发生在这些工具被 import **之后**，工具会读到 `undefined`，背景任务就不会被禁用。

这就是为什么 ablation baseline 的环境变量注入必须在 `cli.tsx` 顶层 -- 在 `main()` 被调用之前、在任何工具模块被 import 之前。`init.ts` 跑得太晚了，它会被 `main.jsx` 的某处 import 时才执行。

**如果不这么做会怎样？** ablation baseline 的实验数据会失效 -- 某些禁用项会被漏掉，研究者得到的不是真正的 "L0 精简" 基线，而是一个混杂了部分功能的半吊子配置。这在 harness-science 实验里是致命的。

这是一个典型的 **模块求值顺序** 陷阱。在 ESM 中，模块级代码在 import 时执行，而且只执行一次。你不能 "事后补" 一个模块级 const 的值。这不是 bug，这是 ESM 的设计语义 -- 但它在大型工具链中制造了隐式的时序耦合。

`feature('ABLATION_BASELINE')` 的 gate 在外部构建中会被 DCE（Dead Code Elimination）消除。打开 `scripts/defines.ts` 的 `DEFAULT_BUILD_FEATURES` 列表（`scripts/defines.ts:39`），你会发现里面根本没有 `ABLATION_BASELINE`。也就是说，在标准构建产物中，这段代码完全不存在。

## MACRO 编译期注入的三层防线

版本号和构建时间这些常量不是运行时读的。它们有三层注入机制：

**第一层：dev 模式的 `-d` flag**。打开 `scripts/dev.ts:17`，你会看到 `getMacroDefines()` 返回的值被展开为 `-d MACRO.VERSION:"2.7.0"` 之类的命令行参数，传递给 `bun run`。Bun 的 `-d` flag 做的是编译期文本替换，效果等同于 `#define`。

**第二层：build 的 `Bun.build({ define })`**。打开 `build.ts:25`，同样的 `getMacroDefines()` 被传入 `Bun.build` 的 `define` 选项。产物中的 `MACRO.VERSION` 在构建时就变成了字面字符串。

**第三层：运行时 fallback**。打开 `src/entrypoints/cli.tsx:11`，如果 `globalThis.MACRO` 未定义（说明既没有走 dev 也没有走 build，而是直接 `bun src/entrypoints/cli.tsx`），会用环境变量 `CLAUDE_CODE_VERSION` 或 hardcoded 的 fallback 值 `'2.1.888'` 初始化。

为什么需要三层？因为 `cli.tsx` 有三种运行方式：`bun run dev`（dev 脚本注入）、`bun dist/cli.js`（build 注入）、`bun src/entrypoints/cli.tsx`（裸跑，什么注入都没有）。三层防线保证无论哪种方式，`MACRO.VERSION` 都不会是 `undefined`。

**如果不这么做会怎样？** 直接 `bun src/entrypoints/cli.tsx` 时 `MACRO.VERSION` 会抛 `ReferenceError`，因为编译期注入没发生，运行时 fallback 也没装。三层防线确保开发调试时不会被构建系统的遗漏卡住。

## 双入口 cli-bun.js / cli-node.js

`package.json` 的 `bin` 字段注册了两个入口：

```json
"bin": {
  "ccb": "dist/cli-node.js",
  "ccb-bun": "dist/cli-bun.js",
  "claude-code-best": "dist/cli-node.js"
}
```

打开 `dist/cli-bun.js` 和 `dist/cli-node.js`，内容各只有两行：

```javascript
// dist/cli-bun.js
#!/usr/bin/env bun
import "./cli.js"

// dist/cli-node.js
#!/usr/bin/env node
import "./cli.js"
```

同一份 `dist/cli.js` 产物被两个 shebang 不同的 wrapper 引用。`cli-bun.js` 走 Bun 运行时，`cli-node.js` 走 Node.js 运行时。这之所以可行，是因为 `build.ts` 的 post-build 阶段做了两个兼容性修补（`build.ts:43` 和 `build.ts:62`）：把 `import.meta.require` 替换为 Node.js 兼容的 `createRequire`，把 `globalThis.Bun` 解构改为带 fallback 的安全写法。

**如果不这么做会怎样？** 如果只有 `#!/usr/bin/env node` 一个入口，Bun 专属的 `bun:bundle` 模块（`feature()` 函数的来源）在 Node.js 里根本不存在。Node.js 用户会得到 `ERR_MODULE_NOT_FOUND`。反过来，如果只有 bun 入口，就无法在 CI 环境中利用预装的 Node.js 而不必额外安装 Bun。

## 每条快速路径的 feature() gate 都在 parse 阶段可见

整条优先级链里，除了 `--version` 之外，每条快速路径都被 `feature()` 保护。打开 `src/entrypoints/cli.tsx:93`：

```typescript
if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
```

以及 `cli.tsx:116`：

```typescript
} else if (feature('CHICAGO_MCP') && process.argv[2] === '--computer-use-mcp') {
```

这些 `feature()` 调用不是运行时布尔值查询。打开 `src/types/internal-modules.d.ts:10`，你会看到 `bun:bundle` 模块声明的 `feature` 函数签名。在 Bun 构建时，`feature('FLAG_NAME')` 会被编译器替换为字面量 `true` 或 `false`。如果 flag 未启用，`if (feature('DUMP_SYSTEM_PROMPT') && ...)` 整个分支会在 DCE 阶段被删除，连里面的动态 import 都不会被 Bun 打包进 chunk。

这就是为什么 `feature()` 只能出现在 `if` 条件或三元表达式的直接位置（Bun 编译器的 AST 模式匹配限制），不能赋值给变量、不能放在回调里、不能做 `&&` 链的一部分。它必须在 parse 阶段就可见为可以被静态分析的布尔分支。

**如果不这么做会怎样？** 如果 feature gate 是运行时函数调用，DCE 无法工作，所有快速路径的代码都会被 Bun 打包进产物。即使某个 feature 在目标构建中完全不需要，它的依赖树（import 的模块、那些模块的依赖）仍然会被打包。产物体积膨胀，启动时间变长。在 code-split 的架构下，这意味着更多 chunks 要被解析，RSS 随之上涨。

## startupProfiler: 快速路径的时间戳

非 `--version` 的路径会第一个 import `startupProfiler.js`（`src/entrypoints/cli.tsx:87`），调用 `profileCheckpoint('cli_entry')`。之后每条快速路径都有自己的 checkpoint 名称：`cli_dump_system_prompt_path`、`cli_claude_in_chrome_mcp_path`、`cli_bridge_path` 等等。这形成了一条完整的启动时间线，可以精确测量每个阶段的耗时。

`startupProfiler` 本身有采样控制（`src/utils/startupProfiler.ts:30`）：0.5% 的外部用户和 100% 的内部用户会被采样，其余用户不付出任何性能代价。这个模块不是快速路径本身，但它衡量了快速路径的效果 -- 如果 `--version` 的 checkpoint 和进程退出的时间差大于 10ms，说明有什么东西不该被加载。

## 延伸阅读

- 想看为什么 `performanceShim` 必须是 `cli.tsx` 的第一行 import，见 [第三章](./03-performance-shim.md)
- 想看 `feature()` 的三个硬约束为什么决定了整个构建管线的设计，见 [第五章](./05-feature-flags.md)
- 想看 code splitting 如何让快速路径的 chunk 加载成本趋近于零，见 [第一章](./01-code-splitting.md)
