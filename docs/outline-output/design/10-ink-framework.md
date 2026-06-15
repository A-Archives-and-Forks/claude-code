# 第十章：自研 Fork 的 Ink 框架 —— 为什么不是 src/ink/

> 27,000 行纯 TypeScript 重建的终端 React 渲染器，连 Yoga 布局引擎都是自己写的。

## 一个不存在的目录，一个庞大的包

新接触这个代码库的开发者第一反应往往是去 `src/ink/` 找终端渲染相关代码。这个目录不存在。所有 Ink 代码都在 `packages/@ant/ink/` 里，总共 27,536 行 TypeScript/TSX 源码。

打开 `packages/@ant/ink/package.json:1` 你会看到包名是 `@anthropic/ink` —— 这是反编译重建后重新命名的结果。`@ant` 是 monorepo 里的 workspace 前缀，`@anthropic/ink` 则是原始包名的残留。

这不是一个简单的 fork。打开 `packages/@ant/ink/src/core/` 目录，数一数文件数量：reconciler、dom、yoga-layout、render-node-to-output、hit-test、focus、renderer、screen、selection、events（10 个事件文件）、termio、layout……这是从 react-reconciler 到 Yoga 布局引擎、从终端 I/O 到屏幕缓冲区的完整终端 UI 栈。

## 为什么 fork 而非用上游 Ink

上游 Ink（vadimdemedes/ink）是一个轻量的终端 React 渲染器，大约 5,000 行。它依赖 `yoga-layout` 的原生绑定（yoga-layout-prebuilt），用 C++ 实现的 Yoga 引擎做 flexbox 布局计算。`@ant/ink` 至少有三个上游不支持的核心需求。

**第一：Yoga 布局引擎的纯 TypeScript 重写。** 打开 `packages/@ant/ink/src/core/yoga-layout/index.ts:1`，文件头注释写得很清楚：

```typescript
/**
 * Pure-TypeScript port of yoga-layout (Meta's flexbox engine).
 *
 * This matches the `yoga-layout/load` API surface used by src/ink/layout/yoga.ts.
 * The upstream C++ source is ~2500 lines in CalculateLayout.cpp alone; this port
 * is a simplified single-pass flexbox implementation...
 */
```

这个文件 2,581 行，用纯 TypeScript 实现了 Meta 的 Yoga flexbox 布局引擎——包括 flex-direction、flex-grow/shrink、align-items、justify-content、margin/padding/border/gap、position: relative/absolute、measure functions，甚至还有 flex-wrap 和 baseline alignment 的完整实现。上游 Ink 依赖原生 C++ 绑定，而 Bun 的 FFI 生态与 Node.js 的 N-API 不完全兼容，在交叉编译和跨平台分发（macOS + Linux + Windows）上会遇到摩擦。纯 TypeScript 重写彻底消灭了原生依赖。

**第二：三层层级架构。** 打开 `packages/@ant/ink/src/index.ts:1`，你会看到包被明确组织成三层：

```typescript
/**
 * @anthropic/ink — Terminal React rendering framework
 *
 * Three-layer architecture:
 *   core/        — Rendering engine (reconciler, layout, terminal I/O, screen buffer)
 *   components/  — UI primitives (Box, Text, ScrollBox, App, hooks)
 *   theme/       — Theme system (ThemeProvider, ThemedBox, ThemedText, design-system)
 */
```

上游 Ink 没有这个分层。`theme/` 层里有 ThemeProvider、ThemedBox、ThemedText、Dialog、FuzzyPicker、ProgressBar、Tabs、Ratchet 等高阶组件——这些是 Claude Code UI 的设计系统，跟 Ink 渲染引擎本身无关。把它们放在一起是因为 ThemeProvider 需要直接操作 Box/Text 的 props，上游 Ink 不可能内置这些东西。

**第三：深度定制的交互系统。** `core/events/` 目录下有 10 个事件文件（click-event、dispatcher、emitter、event-handlers、focus-event、input-event、keyboard-event、mouse-action-event、paste-event、terminal-focus-event），加上 `keybindings/` 目录的完整按键绑定系统（解析器、匹配器、上下文切换），以及 `selection.ts` 的文本选择、`hit-test.ts` 的坐标命中测试、`focus.ts` 的 DOM 级焦点管理。上游 Ink 的交互只到"键盘输入+点击"，而 `@ant/ink` 有完整的捕获/冒泡事件分发、焦点栈、Tab 循环、文本选择高亮、鼠标悬停分发。这些都是 REPL 交互（工具权限确认、快捷键、FuzzyPicker、多面板切换）所必需的。

如果不 fork 而是在上游 Ink 上叠加这些层，会面临两个问题：上游的 `yoga-layout` 原生绑定限制（上面说了），以及上游的 DOM 节点结构不够灵活（`@ant/ink` 在 DOMElement 上挂了 scrollTop、dirty 标记、_eventHandlers 分离、debugOwnerChain 等 reconcile 渲染优化所需的自定义字段，见 `packages/@ant/ink/src/core/dom.ts:32`）。

## react-reconciler 自建渲染器

`@ant/ink` 的核心是 `packages/@ant/ink/src/core/reconciler.ts` —— 一个基于 `react-reconciler` 包的自建渲染器，523 行。

打开 `packages/@ant/ink/src/core/reconciler.ts:241`，你会看到 `createReconciler` 的完整调用。它把 Ink 的 DOM 节点（DOMElement / TextNode）作为 React 19 的"宿主对象"，实现了完整的 Fiber 协调生命周期：

```typescript
const reconciler = createReconciler<
  ElementNames,
  Props,
  DOMElement,
  DOMElement,
  TextNode,
  DOMElement,
  unknown,
  unknown,
  DOMElement,
  HostContext,
  null, // UpdatePayload - not used in React 19
  NodeJS.Timeout,
  -1,
  null
>({
  getRootHostContext: () => ({ isInsideText: false }),
  // ... 完整生命周期实现
})
```

这不是一个"自定义渲染器"——它是"自定义宿主"。React 的 reconciler 是通用的树协调器，任何东西都可以成为"DOM"——浏览器 DOM、canvas 像素、PDF 页面、或者这里：终端字符网格。`createInstance` 创建 DOMElement，`appendChild` 挂载子节点，`commitUpdate` 差量更新 props 和 style，`removeChild` 清理 Yoga 节点并触发焦点管理回调。

特别值得注意的是 `commitUpdate`（第 433 行）的实现。它先做浅层 diff（只比较 key 级别的变化），再分别处理 style diff 和 props diff。style diff 会调用 `applyStyles(yogaNode, style, newProps['style'] as Styles)` 直接修改 Yoga 布局约束，然后由 `resetAfterCommit` 中的 `onComputeLayout()` 触发重新布局。这个设计让 React 的声明式更新直接映射到 Yoga 的命令式布局 API 上。

`resetAfterCommit`（第 264 行）是整个渲染流程的关键节点——React 完成一次 commit 后，它执行三步：(1) 调用 `rootNode.onComputeLayout()` 让 Yoga 重新计算布局；(2) 调用 `rootNode.onRender()` 生成新的屏幕缓冲区；(3) 差量写入终端。如果去掉这些步骤，React 状态变化后终端上什么都不会显示。

如果不做自建渲染器，而是用 react-dom + ANSI escape code overlay 的方式，会怎样？首先，浏览器 DOM 的布局引擎不能直接映射到终端的字符网格（终端的"像素"是字符单元，不支持亚像素定位）；其次，浏览器 DOM 节点在 Node.js 里不存在；最后，Yoga 布局引擎的 flexbox 模型恰好匹配终端 UI 的需求（flex 行列、padding/margin、overflow: scroll）。

## dedupe：为什么 React 副本是致命的

打开 `vite.config.ts:133`，你会看到：

```typescript
dedupe: ['react', 'react-reconciler', 'react-compiler-runtime'],
```

这个配置强制 Vite 在打包时对这三个包使用单一副本。为什么这很重要？因为 `react-reconciler` 内部维护全局状态（当前 Fiber 树、调度队列、事件优先级系统）。如果同一个应用里存在两个 `react` 副本，reconciler 会绑定到其中一个，而组件可能从另一个 `react` 创建——导致 hooks 状态丢失、context 不可达、 Fiber 树断裂。

在 `@ant/ink` 这个场景下，`packages/@ant/ink/` 自带 `react` 和 `react-reconciler` 作为 dependency（见 `packages/@ant/ink/package.json:21-22`），而 `src/` 下的 149 个组件也依赖 `react`。在 monorepo 里，如果两个 workspace 各自 resolve 自己的 node_modules，就会产生两个副本。`dedupe` 配置确保 `createReconciler` 和所有 `useState` 调用共享同一个 React 实例。

如果不做 dedupe，最可能出现的症状是：某些组件的 `useTheme()` 返回 `undefined`（因为它从另一个 React 实例的 Provider 下面读取），或者 hooks 的 state 在 re-render 之间被重置。

## React Compiler 的 _c() 痕迹：已清理但类型声明还在

大纲里提到 `_c()` memoization 模板作为反编译产物的典型痕迹。在当前代码树中，`_c()` 调用已经被清理掉了（源码不再包含 `_c(` 模式），但类型声明文件 `src/types/react-compiler-runtime.d.ts:1` 仍然保留：

```typescript
declare module 'react/compiler-runtime' {
  export function c(size: number): unknown[]
}
```

这个声明是给 `react/compiler-runtime` 模块的，对应 React Compiler 的 memoization cache 函数 `c()`（注意是 `c` 不是 `_c`）。`_c()` 是编译后的产物——React Compiler 把每个组件的 memoization 缓存编译成 `$ = _c(N)` 的形式，其中 N 是缓存槽位数。反编译后这些调用变成了直接的函数引用。

`src/types/global.d.ts:59-61` 有一条更相关的声明：

```typescript
// T — Generic type parameter leaked from React compiler output
// (react/compiler-runtime emits compiled JSX that loses generic type params)
declare type T = unknown
```

这是反编译的典型痕迹：React Compiler 在优化泛型组件时，会在编译后的 JSX 中丢失类型参数，最终泄漏为裸的 `T` 类型。`declare type T = unknown` 是一个通用的补丁，让所有这种泄漏的类型都能通过类型检查。

## global.d.ts 的 declare type T = unknown 补丁

这值得单独讲，因为它是一个非常反编译特有的设计决策。

正常手写的 TypeScript 代码不会出现一个全局的 `type T = unknown`。但在反编译场景中，React Compiler 会把泛型组件编译成非泛型形式——类型参数在编译过程中被擦除，只留下类型约束。反编译器无法恢复原始泛型签名，只能把所有 `T` 统一声明为 `unknown`。

打开 `src/types/global.d.ts:59`，你会看到注释已经说明了原因：`(react/compiler-runtime emits compiled JSX that loses generic type params)`。这个声明覆盖了所有组件中出现的裸 `T` 引用，确保 `tsc --strict` 能通过。

如果不做这个补丁，tsc 会报告 `Cannot find name 'T'`，每一个涉及 React Compiler 产物的组件都会报错。这不是一个"能绕过"的问题——在 strict 模式下它是硬错误。

如果用 `declare type T = any` 代替 `unknown` 呢？在 strict 模式下这本身就是一个 lint 错误（`noExplicitAny`），但即便不考虑 lint，`unknown` 也比 `any` 更安全——它迫使调用方在使用前做类型收窄，而不是让类型错误静默传播。

## 如果不做自建渲染器

回到最根本的问题：为什么不把终端 UI 做成 Web 应用（electron、Tauri、webview），而是坚持在终端里用 React？

首先，Claude Code 的核心用户群是命令行开发者——他们已经在终端里工作，切换到 GUI 应用是摩擦。其次，MCP、pipe 模式、shell 工具、文件操作——这些能力天然在终端环境里，GUI 化需要大量管道适配。最后，代码分割章节（第一章）展示的 35MB RSS 基线（`--version`），如果在 electron 里只能更糟（chromium 渲染进程本身就吃几百 MB）。

那如果用上游 Ink 加 patch 呢？上游 Ink 的 DOM 节点结构不够灵活，无法支持 `@ant/ink` 所需的 scroll state、dirty marking、event handler 分离、debug owner chain 等扩展。每次上游发版都需要 rebase 大量 patch——维护成本远大于 fork 后独立演进的成本。而且 Yoga 的纯 TypeScript 重写本身就是一个重大工程（2,581 行），上游 Ink 的发布节奏不可能接受这种规模的 PR。

## 延伸阅读

- 想看代码分割如何影响 Ink 框架的加载行为，见 [第一章 Code Splitting](./01-code-splitting.md)
- 想看 React Compiler 产物在 performanceShim 里的影响，见 [第三章 performanceShim](./03-performance-shim.md)
- 想看 feature flag 如何控制 devtools 的加载，见 [第五章 Feature Flag](./05-feature-flags.md)
- 想看 AppState 的 React Context 如何与 Ink 的 reconciler 交互，见 [第十一章 三层状态管理](./11-state-management.md)
