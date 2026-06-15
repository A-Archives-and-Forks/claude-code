# 序章：一份被反编译重建的 CLI，为什么处处是"约束的印记"

> 这不是原版代码，而是反编译产物在 Bun/JSC 约束下重建出来的东西——每一个奇怪的设计都有具体的根因。

## 反编译的语义：stub、feature gate、_c() 都是正常的

打开 `src/types/global.d.ts:1`，你会看到这份代码开宗明义的声明：

```ts
/**
 * Global declarations for compile-time macros and internal-only identifiers
 * that are eliminated via Bun's MACRO/bundle feature system.
 */
```

这不是普通的 TypeScript 项目。这份代码的源头是编译后的产物，而不是人类手写的源码。类型声明文件里塞满了"只在编译期存在、运行时会被消除"的标识符：`MACRO.VERSION`、`MACRO.BUILD_TIME`、`resolveAntModel()`、`Gates`、`TungstenPill()`。这些东西在原版 Anthropic 内部构建链里是真实的函数和对象，但在反编译产物里，它们只剩下一个类型签名——一个空壳。

再往下看 `global.d.ts:59`：

```ts
// T — Generic type parameter leaked from React compiler output
// (react/compiler-runtime emits compiled JSX that loses generic type params)
declare type T = unknown
```

`T = unknown`。这不是谁偷懒写了无意义的类型别名。React Compiler（react-compiler-runtime）在编译 JSX 时会把泛型参数丢掉，反编译产物于是到处出现裸露的 `T`。为了让 TypeScript 编译器不报错，只能声明 `type T = unknown`。这是一个典型的"反编译痕迹"——它不是设计决策，而是信息丢失后的补救。

打开 `src/types/react-compiler-runtime.d.ts:1`，类型声明更简洁：

```ts
declare module 'react/compiler-runtime' {
  export function c(size: number): unknown[]
}
```

一个函数 `c`，接受一个数字参数，返回 `unknown[]`。这个函数在原版 Anthropic 代码库里是 React Compiler 的运行时 memoization 辅助函数，用于生成 `$` 变量（你在反编译的 React 组件里会看到 `const $ = _c(N)` 这样的模式）。但在反编译产物里，编译器把它内联了，原始模块不复存在。为了不破坏下游 import，只能声明一个 `unknown[]` 返回值——类型系统在说"我知道这里有东西，但我不知道它是什么"。

## 全书的叙事主线：约束驱动架构

这本书的组织逻辑不是"这个项目有什么功能"，而是"哪些约束逼出了哪些设计决策"。这个区别很重要。

你将要读到的每一章，都在追问同一个问题：**如果不这么做会怎样？**

- 第一章讲 Code Splitting——答案是"RSS 暴涨到 1GB，CLI 启动就要吃掉你一整 GB 内存"。这不是优化，是生存需求。
- 第三章讲 performanceShim——答案是"JSC 的 Performance 实现有个永不收缩的 C++ Vector，长会话累积数百 MB 死容量"。
- 第五章讲 Feature Flag 的三个硬约束——答案是"Bun 编译器 DCE 的 AST 模式匹配限制，`feature()` 只能出现在 `if` 条件位置"。

这本书里几乎每一个看似奇怪的设计——`feature()` 不能赋值给变量、`--version` 必须零模块加载、构建产物要正则替换 `globalThis.Bun`——都指向同一个主题：**你面对的不是一张白纸，而是 JSC 内存模型、Bun 编译器限制、反编译信息丢失这三重约束的交叉压力。**

## 如何阅读本书：打开编辑器，对照锚点

每个章节末尾的"锚点"不是装饰，而是邀请。每一条锚点都是 `文件:行号` 格式，指向代码库中真实存在的代码。

比如本章提到 `src/types/global.d.ts:59` 的 `T = unknown`。你可以现在就打开那个文件，跳到第 59 行，亲眼看到那行代码和它上方的注释。再比如本章开头引用了 `CLAUDE.md`（项目根目录下的那份），第一句话就是：

> This is a **reverse-engineered / decompiled** version of Anthropic's official Claude Code CLI tool.

这不是隐喻。这份代码库的每一个角落都带着反编译的指纹。有些指纹很明显——`declare type T = unknown`、`export function c(size: number): unknown[]`；有些指纹很隐蔽——feature flag 系统的硬约束、模块级单例状态、"42 条 lint 规则关闭"（那是第十五章的内容）。

建议你用 VS Code 或任何编辑器打开这个项目的根目录。每次看到锚点引用时，花十秒钟跳过去看一下。你会发现文档描述和实际代码之间的对应关系非常精确——这比任何架构图都直观。

## 两类禁用 feature：丢失的 stub vs 原本就 stubbed 的

`scripts/defines.ts:39` 的 `DEFAULT_BUILD_FEATURES` 列表里有 65+ 个 feature flag。其中有 8 个被注释掉了：

```ts
// 'HISTORY_SNIP', // 已禁用：snip 功能暂时关闭
// 'CONTEXT_COLLAPSE', // 已禁用：实现是空壳 stub，启用后会抑制 auto compact 导致上下文管理完全失效
// 'FORK_SUBAGENT', // 已禁用：通过 Agent tool 的特殊方式实现了等效功能，无需再开
// 'UDS_INBOX', // 进程间通信管道（inbox/pipe/peers 等命令）构建后 nodejs 环境卡住
// 'LAN_PIPES', // 局域网管道，依赖 UDS_INBOX 构建后 nodejs 环境卡住
// 'REVIEW_ARTIFACT', // 代码审查产物（API 请求无响应，待排查 schema 兼容性）
// 'SKILL_LEARNING',
// 'TEAMMEM', // 已禁用：依赖 COORDINATOR_MODE，邮箱文件无限增长
```

表面上看它们都是"被禁用的"，但禁用的原因截然不同。混淆这两类会导致严重误判。

**第一类：反编译丢失导致的 stub。** `CONTEXT_COLLAPSE`、`HISTORY_SNIP`、`FORK_SUBAGENT`、`UDS_INBOX`、`LAN_PIPES`、`REVIEW_ARTIFACT` 属于这一类。

打开 `src/setup.ts:290` 你会看到：

```ts
if (feature('CONTEXT_COLLAPSE')) {
  require('./services/contextCollapse/index.js').initContextCollapse()
}
```

`src/services/contextCollapse/` 目录确实存在，里面有 `index.ts`、`operations.ts`、`persist.ts` 三个文件。但注释明确说"实现是空壳 stub，启用后会抑制 auto compact 导致上下文管理完全失效"。反编译过程保留了文件结构和函数签名，但丢失了核心逻辑。如果你强行启用 `FEATURE_CONTEXT_COLLAPSE=1`，init 函数会跑起来，但它做的事情是错误的——它会抑制自动压缩，导致长对话的上下文管理彻底崩溃。

`HISTORY_SNIP` 的情况类似。打开 `src/commands.ts:92`：

```ts
const forceSnip = feature('HISTORY_SNIP')
  ? require('./commands/force-snip.js').default
  : null
```

但 `src/commands/force-snip/` 目录根本不存在。如果你启用这个 feature，运行时会直接 `MODULE_NOT_FOUND`。这个 feature 在原版里指向一个完整的消息历史裁剪子系统（`src/utils/messages.ts:2652` 里有它的运行时检查逻辑），但反编译过程丢失了 `force-snip` 命令模块。

**第二类：功能原本就 stubbed 的。** `SKILL_LEARNING` 和 `TEAMMEM` 属于这一类。

打开 `src/services/skillLearning/featureCheck.ts:11`：

```ts
export function isSkillLearningCompiledIn(): boolean {
  if (feature('SKILL_LEARNING')) return true
  return false
}
```

这个目录下有 20+ 个文件（`agentGenerator.ts`、`evolution.ts`、`instinctParser.ts`、`skillLifecycle.ts` 等），结构完整。这不是反编译丢失——这是 Anthropic 原版里本身就 stubbed 的功能。feature flag 注释写的也很清楚：`SKILL_LEARNING` 的 slash command 被编译进 build，但运行时默认 OFF，需要 operator 主动 `/skill-learning start` 开启。这不是"丢了"，而是"还没开放"。

`TEAMMEM` 也是类似情况。`src/memdir/memdir.ts:7`、`src/utils/memoryFileDetection.ts:17` 等多处引用了 `feature('TEAMMEM')` 的分支逻辑，相关代码路径是完整的。禁用的原因是"依赖 COORDINATOR_MODE，邮箱文件无限增长"——这是一个产品决策，不是反编译事故。

**区分这两类的实用方法**：看被注释掉的那行注释。如果注释说"实现是空壳 stub"或"构建后环境卡住"，那是反编译丢失（第一类）。如果注释说"依赖某 feature"或"待排查"，那是功能本身的问题（第二类）。第一类强行启用会破坏核心功能；第二类启用后可能有 bug 但不会让系统崩溃。

## bun:bundle 的幽灵模块

`src/types/internal-modules.d.ts:10` 声明了一个不存在的模块：

```ts
declare module 'bun:bundle' {
  export function feature(name: string): boolean
}
```

`bun:bundle` 是 Bun 运行时的内置模块，由 Bun 编译器在构建时解析。你在 Bun 以外的环境里跑 `import { feature } from 'bun:bundle'` 会报错——这个模块只存在于 Bun 的编译管道里。类型声明文件把它写出来，纯粹是为了让 TypeScript 不报 `Cannot find module 'bun:bundle'` 错误。

这个幽灵模块贯穿整个代码库。`scripts/vite-plugin-feature-flags.ts:29` 里有一个 Rollup 插件，专门在 Vite 构建时把 `bun:bundle` 虚拟化为一个始终返回 `false` 的 stub：

```ts
load(id) {
  if (id === resolvedVirtualModuleId) {
    return 'export function feature(name) { return false; }'
  }
}
```

同一个 `feature()` 函数，在 Bun 构建里是编译器的 DCE（dead code elimination）钩子，在 Vite 构建里被插件替换为字面量。两种构建管道对同一个函数的理解完全不同，但产出的行为一致。这种"双管道、单语义"的设计是反编译重建工作的典型特征——你不需要理解原版为什么这么做，你只需要在两条路径上复现相同的行为。

## 反编译产物的类型补丁成本

`bun:bundle` 不是唯一的幽灵模块。同一个文件里还声明了 `bun:ffi`（`internal-modules.d.ts:14`），以及 `bidi-js`、`asciichart`、`@napi-rs/keyring` 等没有 `@types` 包的第三方模块。所有导出都被类型化为 `any` 或最小接口。

这意味着什么？意味着你在阅读代码时看到的类型签名，有很多是"人为补丁"而非"原始设计"。`T = unknown` 是最极端的例子，但更常见的模式是 `Record<string, unknown>`——当反编译丢掉了结构信息时，退化为字典类型是唯一安全的选项。

如果你在代码里看到某个函数接收 `Record<string, unknown>` 参数，或者在某个地方有 `as unknown as SomeType` 的双重断言，那大概率是反编译信息丢失的痕迹。这不是代码质量问题，而是信息损失的必然结果——就像你把一栋建筑拆成零件再重建，总有些螺丝的规格对不上，只能用万能件替代。

## 延伸阅读

- 想了解 Feature Flag 系统为什么有"三个硬约束"，见 [第五章：Feature Flag 系统的三个硬约束](./05-feature-flags.md)
- 想看 Code Splitting 是怎么被 JSC 内存压力逼出来的，见 [第一章：Code Splitting 不是优化，是生存需求](./01-code-splitting.md)
- 想了解 biome.json 关掉 42 条规则的反编译指纹，见 [第十五章：biome.json 的 42 条规则关闭](./15-biome-42-rules.md)
- 想看 performanceShim 如何修补 JSC 内存泄漏，见 [第三章：performanceShim —— JSC 内存泄漏的运行时补丁](./03-performance-shim.md)
