# 第十五章：biome.json 的 42 条规则关闭 —— 反编译产物的指纹

> 42 条 lint 规则被关闭不是偷懒，是反编译代码对 linter 提出的最后通牒

## 一份任何现代项目都不敢提交的 biome 配置

打开 `biome.json:24`，你会看到一个让大多数 linter 爱好者血压升高的配置。`suspicious` 组关了 12 条，`style` 组关了 9 条，`complexity` 组关了 12 条，`correctness` 组关了 9 条。加上 `a11y` 和 `nursery` 两个 recommended 集整体关闭，总共 44 处 `"off"`。CLAUDE.md 说的"42 条"是其中 42 个具名规则（不算 a11y/nursery 的 recommended 整体关闭）。

```json
// biome.json:26-38
"suspicious": {
  "noExplicitAny": "off",
  "noAssignInExpressions": "off",
  "noDoubleEquals": "off",
  "noRedeclare": "off",
  "noImplicitAnyLet": "off",
  "noGlobalIsNan": "off",
  "noFallthroughSwitchClause": "off",
  "noShadowRestrictedNames": "off",
  "noArrayIndexKey": "off",
  "noConsole": "off",
  "noConfusingLabels": "off",
  "useIterableCallbackReturn": "off"
}
```

如果你在一个全新项目中提交这样的配置，code review 的第一条评论一定是："你确定要关 `noExplicitAny`？`noDoubleEquals`？`noConsole`？" 在正常项目中，这些是底线中的底线。

但这个项目不是正常项目。这是一个反编译重建的 CLI，几十万行 TypeScript 的每一行都经过 decompiler 的洗礼，变量名是合成的，类型信息是推断的，控制流是还原的。逐行修复 42 条规则意味着重写整个代码库——这恰好是反编译重建工作要避免的。

## 关闭的每一条规则背后都有一个反编译的必然

关掉的 42 条规则可以分成四个阵营，每个阵营对应反编译产物的一个系统性特征。

### suspicious 组：decompiler 不生成的代码

`noExplicitAny`（`biome.json:27`）—— 反编译器在无法还原类型标注时，默认产出 `any`。`src/services/api/` 下的流适配器满是 `any`，因为原始代码的类型在编译为 JavaScript 后被擦除。decompiler 只能从运行时行为推断，推断不出来就给 `any`。

`noDoubleEquals`（`biome.json:29`）—— decompiler 还原比较表达式时偶尔产出 `==` 而非 `===`，因为原始 JavaScript 中的 `==` 和 `===` 编译到同一份字节码后，decompiler 无法区分原始意图。全局搜索项目中的 `==`，你会发现它们集中在 decompiler 输出的早期模块中。

`noRedeclare`（`biome.json:30`）—— decompiler 有时会为同一个变量生成多个声明（来自不同作用域的合并或 switch-case 的变量提升）。这不是你手写的代码会犯的错误，但 decompiler 的控制流重建算法不可避免。

`noFallthroughSwitchClause`（`biome.json:33`）—— 原始代码可能利用了 switch fallthrough，decompiler 如实还原。手写代码不应该用 fallthrough，但反编译产物必须忠实于原始行为。

`noConsole`（`biome.json:36`）—— 29 个文件在文件顶部声明 `biome-ignore-all lint/suspicious/noConsole`。打开 `src/utils/claudeInChrome/chromeNativeHost.ts:1`：

```ts
// biome-ignore-all lint/suspicious/noConsole: file uses console intentionally
```

这个文件作为 Chrome Native Host 运行，`console.log` 是它与宿主通信的标准通道。反编译产物中大量 `console.log` 用于调试桥接层，关掉规则比逐个审查每一条 console 调用的意图更务实。

### style 组：decompiler 的代码风格不是你的代码风格

`useConst`（`biome.json:41`）—— decompiler 统一产出 `let`，即使在语义上应该是 `const`。这因为 JavaScript 运行时不区分 `let` 和 `const`（除了 TDZ），字节码中只有一个变量声明指令。decompiler 不知道原始源码用的是 `let` 还是 `const`，保守地全部输出 `let`。

`useTemplate`（`biome.json:46`）—— 字符串拼接 vs 模板字面量的选择在编译后完全消失。decompiler 还原时，有时输出 `'hello' + name`，有时输出 `` `hello${name}` ``，取决于它如何重建 AST。这不是一个可以在不改变语义的情况下批量修复的问题。

`useImportType`（`biome.json:49`）—— `import type { X }` vs `import { X }` 在编译后都是同样的 `require` 调用。decompiler 无法判断一个导入是否只在类型位置使用，所以统一生成普通 import。

### complexity 组：decompiler 的 AST 还原策略

`noForEach`（`biome.json:52`）—— decompiler 将 `for...of` 和 `.forEach()` 互相转换没有固定偏好。原始代码用 `for...of` 的地方可能被还原成 `.forEach()`，反之亦然。批量统一风格的工作量与收益不成比例。

`useArrowFunction`（`biome.json:62`）—— 同理。`function` 和箭头函数在编译后只有微妙的 `this` 绑定差异，decompiler 不一定能正确还原。全局搜索你会发现项目里两种风格并存——反编译产物中 `this` 绑定的原始上下文已经丢失。

`noBannedTypes`（`biome.json:53`）—— `Function`、`Object`、`{}` 这些 banned types 在反编译产物的类型声明中大量出现，因为 decompiler 的类型推断粒度就是 `Object`。

### correctness 组：死代码与 unreachable 的诚实保留

`noUnreachable`（`biome.json:70`）—— 反编译产物中有大量 feature-gated 的不可达代码。当 `feature('X')` 被 Bun 编译器 DCE 后变成 `if (false)` 时，分支内的代码变成 unreachable。但 source 层面它们仍然存在——你需要它们存在，因为 dev 模式下 `feature()` 返回 `true`。

`noConstantCondition`（`biome.json:73`）—— 同理。`if ('production' === 'development')` 是 MACRO 替换后的永假比较。这个判断在 `build.ts` 中通过 `Bun.build({ define })` 把 `'production'` 注入为字面量，dev 模式下注入 `'development'`。tsc 不理解 define 注入，报错——只能用 `@ts-expect-error` 压制。

`noUnusedVariables`（`biome.json:66`）和 `noUnusedImports`（`biome.json:67`）—— 反编译产物的变量使用模式经常是"先声明后使用在另一个 switch-case 分支中"，decompiler 的作用域重建不一定能正确识别跨分支的引用关系。

`useExhaustiveDependencies`（`biome.json:68`）—— React hooks 的依赖数组在编译后完全消失。decompiler 无法还原 `useEffect` / `useMemo` 的原始依赖数组，只能产出空数组或不完整的数组。这是 React Compiler 的 `_c()` memoization 模板出现后尤其明显的问题（参见第十章）。

## .tsx 的特权：lineWidth 120 + 强制分号

`biome.json:102-113` 的 overrides 区域有一条令人好奇的规则：

```json
// biome.json:102-113
"overrides": [
  {
    "includes": ["**/*.tsx"],
    "javascript": {
      "formatter": {
        "semicolons": "always"
      }
    },
    "formatter": {
      "lineWidth": 120
    }
  }
]
```

所有 `.tsx` 文件享有 120 字符行宽（其他文件 80）和强制分号（其他文件 `asNeeded`）。这不是拍脑袋的决定。

120 字符行宽是因为 JSX 的嵌套结构天然占宽度。一个包含 `className`、`onClick`、`condition && <Component />` 的 JSX 表达式，80 字符行宽下几乎必然被格式化器断成碎片——每个属性一行、每个嵌套标签一行。120 字符让一个完整的组件调用能留在同一行，可读性显著提升。

强制分号的原因更微妙。`.tsx` 文件使用 React Compiler 输出（`_c()` memoization 调用），这些调用在 decompiler 还原时已经定型。`asNeeded` 模式下 Biome 可能删除某些 ASI（Automatic Semicolon Insertion）安全位置的分号，但 React Compiler 的 `_c()` 模板假设分号存在——去掉分号可能改变 ASI 边界的行为。`always` 是最安全的选择。

## 52 个 biome-ignore-all：ANT-ONLY 标记的禁区

全局搜索 `biome-ignore-all`，你会发现 `src/` 下有 30 个文件、`packages/` 下也有若干文件在文件顶部声明了这个指令。其中最常见的一条是：

```ts
// src/commands.ts:1
// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
```

29 个文件使用完全相同的 `ANT-ONLY import markers must not be reordered` 理由。这些文件的 import 语句中混入了特殊标记——`ANT-ONLY` 注释标记了只有内部版本才会编译进去的 import 路径。Biome 的 `organizeImports` assist 功能会重排 import 语句，但这些标记的位置和顺序不能被打乱，否则 `bun:bundle` 的编译期处理会出错。

打开 `src/commands.ts:1`，紧跟着 import 标记注释的就是一大段命令注册代码——每个命令都是一个独立的 import。反编译产物的 import 顺序不是按字母序的，而是按原始模块的注册顺序。`organizeImports` 会把它们重排成字母序，破坏隐含的初始化顺序依赖。

`biome-ignore-all` 在这些文件中是 `//` 行级注释——整文件生效，不分具体规则。这说明"不要碰这个文件的 import"是一条不可妥协的红线。

## tsc vs biome 的零和博弈

`biome.json` 关了 42 条规则，但有一条它没关：`noUnusedPrivateClassMembers`（`correctness/recommended` 默认启用）。这条规则与 TypeScript 的严格模式产生了一个有趣的两难。

打开 `src/native-ts/file-index/index.ts:51`：

```ts
// biome-ignore lint/correctness/noUnusedPrivateClassMembers: used via destructuring in search()
```

tsc 在 strict 模式下要求类属性必须有类型声明。某些情况下，一个类属性只在赋值时使用（通过解构赋值读取），tsc 要求声明但不读取——biome 则报告"声明了但从未读取"。两个工具的语义不兼容：tsc 要求声明是为了类型完整性，biome 报 unused 是因为它只看读取行为。

解决方案是 `biome-ignore` 注释——逐个压制。这不是一个能通过改 biome 配置解决的问题，因为关掉这条规则会让真正未使用的私有成员溜过去。CLAUDE.md 里的指导原则是：

> 用 `// biome-ignore lint/correctness/noUnusedPrivateClassMembers: <原因>` 抑制 lint 警告，保留类型声明。

每个 `biome-ignore` 必须附带原因——这是防止"关规则变成文化"的最后防线。

## `@ts-expect-error` 的维护纪律

`@ts-expect-error` 在反编译代码中有两类用途，维护纪律截然不同。

第一类是 MACRO 替换产生的永假比较。`scripts/defines.ts:18` 定义了 `MACRO.VERSION` 等编译期常量，`build.ts` 和 `scripts/dev.ts` 分别用 `Bun.build({ define })` 和 `bun -d` 注入。当 `NODE_ENV` 被替换为 `'production'` 时，`'production' === 'development'` 永假——tsc 不知道 define 注入，会报 TS2578。这个 `@ts-expect-error` 必须永久保留。

第二类是类型系统更新后变为多余的 directive。当 TypeScript 版本升级或类型声明补全后，原来需要 `@ts-expect-error` 的代码可能不再有类型错误。此时 tsc 报 TS2578（Unused '@ts-expect-error' directive），意味着 directive 本身变成了错误。CLAUDE.md 的规则是：

> 如果类型系统已更新导致 directive 变为 unused（TS2578），直接移除注释。

这是 `bun run precheck` 能通过的前提——`precheck` 同时跑 tsc 和 biome，任何多余的 `@ts-expect-error` 或不足的 `biome-ignore` 都会导致 CI 失败。

## CI 的 `biome ci .` 零容忍

`biome.json` 关了 42 条规则，但 CI 的 `ci.yml` 仍然跑 `bunx biome ci .`。这不是矛盾——42 条关闭之外，所有 `recommended` 规则仍然生效。

`ci.yml` 的工作流是：先安装依赖，然后 lint，再 typecheck，最后 build 和 test。`biome ci` 如果发现任何 warning，CI 就失败。这意味着：

1. 新代码不能引入新的 `any`（除非你也在 `biome.json` 里关掉 `noExplicitAny`，而它已经关了）。
2. 新代码不能引入新的 `console.log`（除非文件顶部有 `biome-ignore-all`）。
3. 每个局部 `biome-ignore` 必须附带原因注释，否则 PR review 会打回。

42 条规则关闭是"历史债"的合法化。`biome ci` 零容忍是"不再积累新债"的纪律。两者并存，构成一个有趣的平衡：承认过去无法重写，但也不允许未来继续退化。

如果不这么做——如果不关这 42 条规则——你有两个选择：(A) 逐行重构几十万行反编译代码（工程量相当于重写），或者 (B) 不用 biome（lint 基线完全丧失）。A 不现实，B 不可接受。所以 42 条关闭是唯一的可行路径。

## `using _` 的脆弱 transpile

`biome.json` 本身不涉及 transpile，但整个 lint 配置的生存依赖于一条脆弱的构建期替换。

打开 `scripts/vite-plugin-feature-flags.ts:68-74`：

```ts
// 2. Transpile `using _ = expr;` to `const _ = expr;` for Node.js compat.
//    Node.js v22 does not support `using` declarations (Explicit Resource Management).
//    Safe because: SLOW_OPERATION_LOGGING is not enabled, so slowLogging returns
//    a no-op disposable whose [Symbol.dispose]() is empty.
if (transformed.includes('using _')) {
  transformed = transformed.replace(/\busing\s+(_\w*)\s*=/g, 'const $1 =')
  modified = true
}
```

Vite 构建插件把所有 `using _ = slowLogging\`...\`` 正则替换为 `const _ = slowLogging\`...\``。这是因为 Node.js v22 不支持 `using` 声明（Explicit Resource Management 提案），而构建产物必须兼容 Node.js 运行。

打开 `src/utils/slowOperations.ts:191`，你会看到源码中使用 `using` 的典型模式：

```ts
using _ = slowLogging`JSON.stringify(${value})`
return JSON.stringify(value, replacer as Parameters<typeof JSON.stringify>[1], space)
```

`slowLogging` 是一个 tagged template，返回 `Disposable`（`slowOperations.ts:155-160`）。当 `SLOW_OPERATION_LOGGING` 未启用时（默认情况），它返回一个 no-op disposable（`slowOperations.ts:126`），`[Symbol.dispose]()` 是空函数。正则替换把 `using _` 换成 `const _` 后，这个 no-op 对象被赋值给 `_` 然后立刻丢弃——行为等价，但不再依赖 ESM Explicit Resource Management。

这条 transpile 的安全性依赖于一个前提：`SLOW_OPERATION_LOGGING` 未启用。如果启用了，`slowLogging` 返回 `AntSlowLogger`（`slowOperations.ts:95`），它的 `[Symbol.dispose]()` 真正执行计时和日志——替换成 `const` 后 dispose 永远不会被调用，慢操作检测静默失效。`DEFAULT_BUILD_FEATURES` 列表（`scripts/defines.ts:39`）里没有 `SLOW_OPERATION_LOGGING`，所以当前构建安全。但这是一种隐式契约——如果将来有人把 `SLOW_OPERATION_LOGGING` 加到默认 features 里，`biome ci .` 仍然通过（因为 `using` 已被 transpile 掉），但慢操作检测会静默失效。没有编译期或运行时的机制阻止这种错误。

## 如果不这么做会怎样

假设你决定不关这 42 条规则——逐行修复反编译产物。你面对的第一个问题是 `noExplicitAny`：`src/services/api/` 下的流适配器有数百个 `any`，每个都需要手动推断原始类型。由于类型在编译时被擦除，你的推断只有"合理猜测"的精度。猜错了，运行时行为就变了——反编译产物最脆弱的地方就是"看起来对但行为不同"的代码。

第二个问题是 `noUnusedVariables` 和 `noUnusedImports`。decompiler 产出的变量使用模式中，跨 switch-case 分支的引用、feature-gated 的条件使用、React Compiler `_c()` 的隐式引用——这些都不是简单的"声明了但没用"，而是"在反编译器的控制流重建中，使用点被放到了 lint 工具看不到的地方"。批量删除这些"unused"变量，你会破坏运行时逻辑。

第三个问题是工程成本。几十万行代码逐条修复 42 类 lint 问题，保守估计需要数人月。而反编译重建工作的核心目标是恢复功能，不是美化代码。42 条关闭是一个理性的资源分配决策：把有限的人力放在功能恢复和测试覆盖上，而不是放在让 linter 满意上。

## 延伸阅读

- 想看 feature flag 编译期替换如何与 linter 交互（`if (false)` 产生 unreachable），见 [第五章：Feature Flag 系统的三个硬约束](./05-feature-flags.md)
- 想看 React Compiler 的 `_c()` 模板如何在反编译产物中大量出现并与 lint 规则冲突，见 [第十章：自研 Fork 的 Ink 框架](./10-ink-framework.md)
- 想看 `using _` transpile 所在的 Vite 构建管线，见 [第一章：Code Splitting 不是优化，是生存需求](./01-code-splitting.md)
- 想看测试如何与 mock 污染共存（另一个"承认现状、守住底线"的案例），见 [第十四章：测试策略](./14-testing-strategy.md)
