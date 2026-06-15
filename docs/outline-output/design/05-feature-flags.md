# 第五章：Feature Flag 系统的三个硬约束

> `feature()` 不是普通函数，它是 Bun 编译器用来做死代码消除的语法标记。

打开 `src/types/internal-modules.d.ts:10`，你会看到这样一行声明：

```ts
declare module 'bun:bundle' {
  export function feature(name: string): boolean
}
```

这是一个虚假的模块声明 -- `bun:bundle` 不存在于文件系统上，也不是 npm 包。它是 Bun 编译器在打包（`Bun.build()`）时内建的编译期原语。当 `Bun.build()` 看到 `feature('X')` 时，它会根据构建配置中的 `features` 列表决定把调用点替换为 `true` 或 `false`，然后对所有不可达分支执行死代码消除（Dead Code Elimination，DCE）。

反编译重建之后，这个原语不再由编译器直接提供，必须通过类型声明 + 双构建管线各自模拟。这带来了三个硬约束，贯穿了整个代码库的每一个 feature-gated 代码块。

## 约束一：`feature()` 只能出现在 `if` 条件或三元表达式的位置

CLAUDE.md 里有一条铁律：

> `feature()` 只能直接用在 `if` 语句或三元表达式的条件位置，不能赋值给变量、不能放在箭头函数体里、不能作为 `&&` 链的一部分。

打开 `src/hooks/useReplBridge.tsx:117`，你能看到一段注释精确解释了为什么：

```ts
// feature() check must use positive pattern for dead code elimination —
// negative pattern (if (!feature(...)) return) does NOT eliminate
// dynamic imports below.
if (feature('BRIDGE_MODE')) {
```

这个约束的根源是 Bun 编译器 AST 模式匹配的局限性。编译器只识别两种模式：

1. `if (feature('X')) { ... }` -- 把 `feature('X')` 替换为 `false` 后，整个代码块变成 `if (false) { ... }`，DCE 可以整块删除。
2. `feature('X') ? a : b` -- 替换后变成 `false ? a : b` 或 `true ? a : b`，DCE 可以删掉不会走的分支。

如果你写成 `const enabled = feature('X'); if (enabled) { ... }`，编译器看到的是对变量 `enabled` 的判断，无法确定其值为常量，整个 feature-gated 代码块都会保留在产物里。

**反事实推演**：如果 `feature()` 能赋值给变量，整个 `tools.ts` 的条件导入模式就不需要那么别扭的 `feature('X') ? require(...) : null` 三元表达式了。你可以写 `const enabled = feature('X'); const tool = enabled ? require(...) : null;`，代码可读性会好很多。但代价是：所有被 gate 的代码（包括 `require()` 引用不存在的文件）都会被打进产物，运行时可能触发 `MODULE_NOT_FOUND` 崩溃。

### 正面模式与负面模式的陷阱

`src/hooks/useReplBridge.tsx:117` 提到了另一个细微之处：**正面模式**（`if (feature('X'))`）才能触发 DCE，**负面模式**（`if (!feature('X')) return`）不行。

打开 `src/entrypoints/cli.tsx:165` 看一个正面模式的例子：

```ts
if (!feature('DAEMON')) {
  console.error('Error: --daemon-worker requires DAEMON feature...');
  process.exitCode = 1;
  return;
}
```

这里用了 `!feature('DAEMON')`，但注意后面的 `return` 是从 `main()` 函数退出的，不是 return 从一个 require 块。DCE 只需要把 `feature('DAEMON')` 替换为 `false` 后变成 `if (!false)` 即 `if (true)`，保留这个检查分支没问题。真正的问题是当 feature 为 true 时，Bun 需要把 `require('../daemon/workerRegistry.js')` 打进产物 -- 这要求文件存在。如果 DAEMON 在构建 features 列表里，一切正常；如果不在，那 `require()` 所在的分支因为 `!feature()` 为 `false` 会被 DCE 删掉。

关键区别在于：**`if (feature('X'))` 包裹的 `require()` 路径在 `X=false` 时被 DCE 删除**，所以文件可以不存在。但 **`if (!feature('X'))` 包裹的 `require()` 路径在 `X=true` 时必须存在**，因为 DCE 保留的是 `else` 分支。

## 约束二：`if (false)` 必须在 parse 阶段可见，否则 bundler 会崩溃

这是 Vite/Rollup 构建管线独有的约束。打开 `scripts/vite-plugin-feature-flags.ts:29`，你会看到注释：

```ts
/**
 * Vite/Rollup plugin that replaces `feature('X')` calls with boolean literals
 * at the transform stage, BEFORE the bundler resolves imports.
 *
 * This approach is necessary because some feature-gated code blocks contain
 * require() calls to files that don't exist (e.g. hunter.js inside
 * feature('REVIEW_ARTIFACT')). The bundler must see these as dead code
 * (`if (false) { ... }`) before attempting import resolution.
 */
```

打开 `src/skills/bundled/index.ts:44`，看这个致命的模式：

```ts
if (feature('REVIEW_ARTIFACT')) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { registerHunterSkill } = require('./hunter.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  registerHunterSkill()
}
```

文件 `src/skills/bundled/hunter.js` **不存在**。你可以在终端里验证：`ls src/skills/bundled/hunter.js` 返回 "No such file or directory"。代码库中完全找不到任何名为 `hunter*` 的文件。

这在 `Bun.build()` 管线下不是问题 -- Bun 的打包器知道 `feature('REVIEW_ARTIFACT')` 返回 `false`（因为它不在 `DEFAULT_BUILD_FEATURES` 列表里，见 `scripts/defines.ts:72` 的注释），直接 DCE 掉整个 `if` 块，从来不会尝试解析 `./hunter.js`。

但 Vite/Rollup 不同。Rollup 的处理管线是：resolve imports -> transform -> bundle。如果 Vite 在 transform 之前尝试 resolve imports，它会看到 `require('./hunter.js')` 然后 `MODULE_NOT_FOUND` 崩溃。

这就是为什么 `vite-plugin-feature-flags.ts` 必须在 `transform` 阶段（而非 `load` 或 `resolveId` 阶段）替换 `feature('X')` 调用。打开 `scripts/vite-plugin-feature-flags.ts:54`，`transform` 函数用正则匹配替换：

```ts
transform(code, id) {
  if (id.includes('node_modules')) return null
  let transformed = code.replace(FEATURE_CALL_RE, (match, flagName) => {
    return features.has(flagName) ? 'true' : 'false'
  })
  // ...
}
```

替换发生在 `resolveId` 之后、bundle 之前。这样 Rollup 看到 `if (false) { require('./hunter.js') }` 就知道整个分支不可达，不会尝试解析 `./hunter.js`。

插件还提供了一个虚拟模块解决 `import { feature } from 'bun:bundle'` 的 "module not found" 错误（`scripts/vite-plugin-feature-flags.ts:47`）：

```ts
load(id) {
  if (id === resolvedVirtualModuleId) {
    return 'export function feature(name) { return false; }'
  }
}
```

这个 stub 的 `return false` 在运行时永远不会被调用，因为所有 `feature()` 调用都在 `transform` 阶段被替换成了字面量。它存在的唯一意义是让 Rollup 不报 unresolved import 错误。

**反事实推演**：如果 `transform` 替换不够早，Vite 构建管线在遇到任何引用不存在文件的 feature-gated `require()` 时都会崩溃。这意味着所有被注释掉的 feature（`CONTEXT_COLLAPSE`、`UDS_INBOX`、`REVIEW_ARTIFACT` 等）在 Vite 管线下都是"定时炸弹" -- 只要它们的代码块里有 `require()` 指向不存在的文件，替换时机不对就会炸。

## 约束三：Vite 的 `using` 声明必须 transpile，否则 Node.js 崩溃

`vite-plugin-feature-flags.ts` 在 feature flag 替换之外还承担了一项额外职责。打开 `scripts/vite-plugin-feature-flags.ts:68`：

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

这段正则把所有 `using _x = expr` 替换成 `const _x = expr`。注释解释了安全性前提：`SLOW_OPERATION_LOGGING` 未启用时，`slowLogging` 返回的 disposable 的 `[Symbol.dispose]()` 是空操作，所以 `using` 和 `const` 行为等价。

但这里有一条脆弱的依赖链：如果有人启用了 `SLOW_OPERATION_LOGGING` 并在 Vite 构建产物上用 Node.js 运行，资源清理就不会执行 -- `using` 的 `Symbol.dispose` 语义被丢弃了。

**反事实推演**：如果不做这个 transpile，Vite 构建的产物在 Node.js v22 上会直接 `SyntaxError: Unexpected token 'using'`。这意味着整个 "产物兼容 bun/node" 的承诺（`build.ts` 的 post-build `import.meta.require` 补丁）在 Vite 管线上多了一个前提条件。

## 三层切换机制：Build 默认、Dev 全开、运行时环境变量

打开 `scripts/defines.ts:39`，你会看到 `DEFAULT_BUILD_FEATURES` 列表，65+ 个 feature flag 中大约有 40 个默认启用，其余被注释掉。打开 `scripts/dev.ts:39`，dev 模式使用同一个列表：

```ts
const allFeatures = [...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures])]
const featureArgs = allFeatures.flatMap(name => ['--feature', name])
```

但 dev 模式可以通过 `FEATURE_<NAME>=1` 环境变量额外启用。例如 `FEATURE_REVIEW_ARTIFACT=1 bun run dev` 会尝试启用 `REVIEW_ARTIFACT`，然后代码会尝试 `require('./hunter.js')`，由于文件不存在而崩溃。

三层机制的行为差异：

| 层级 | 何时生效 | feature() 的值 | DCE 是否生效 |
|------|----------|---------------|-------------|
| `Bun.build()` | 构建时 | 编译期常量 | 是 -- 不可达代码被删除 |
| `vite build` | 构建时（通过 transform 插件） | transform 后的字面量 | 是 -- Rollup 删除不可达分支 |
| `bun run dev` | 运行时（通过 `--feature` flag） | 运行时布尔值 | 否 -- 所有分支都在内存中 |

这意味着 dev 模式下所有 feature-gated 的 `require()` 路径都必须实际存在，否则运行时会崩溃。对 Bun 原生 dev 来说 `--feature` flag 是 Bun 运行时提供的；对 Vite dev 来说 `feature()` 被 transform 插件替换为字面量，运行时不存在 `bun:bundle` 模块。

## 反编译产物的 stub 陷阱：两类禁用，一个混淆

`DEFAULT_BUILD_FEATURES` 中被注释掉的 feature 可以分为两类。打开 `scripts/defines.ts:62-72`，看注释中的措辞差异：

**第一类：反编译丢失导致的空壳 stub**：

```ts
// 'CONTEXT_COLLAPSE', // 已禁用：实现是空壳 stub，启用后会抑制 auto compact 导致上下文管理完全失效
// 'HISTORY_SNIP',     // 已禁用：snip 功能暂时关闭
```

这些 feature 在原始 Claude Code 中是完整功能，反编译过程中逻辑丢失，留下的实现要么是空壳（`CONTEXT_COLLAPSE`），要么会破坏核心功能（`HISTORY_SNIP` 启用后 `SnipTool` 出现但上下文管理不正常）。启用它们不是"多了一个功能"，而是"引入了一个损坏的功能"。

**第二类：功能原本就 stubbed 或已废弃**：

```ts
// 'SKILL_LEARNING',  // 已禁用
// 'TEAMMEM',         // 已禁用：依赖 COORDINATOR_MODE，邮箱文件无限增长
// 'REVIEW_ARTIFACT', // 已禁用：代码审查产物（API 请求无响应，待排查 schema 兼容性）
```

`SKILL_LEARNING` 和 `TEAMMEM` 在原始版本中也是 stubbed 或内部工具，并非完整的对外功能。`REVIEW_ARTIFACT` 更有趣 -- 它的 `hunter.js` 根本不存在于反编译产物中，说明要么原始代码中也是动态加载的（但反编译时丢失了），要么是整个 hunter 子系统在某个版本中被删除但 feature gate 的引用没清理干净。

打开 `src/tools.ts:148`，`ReviewArtifactTool` 的条件加载用的是标准的三元模式：

```ts
const ReviewArtifactTool = feature('REVIEW_ARTIFACT')
  ? require('@claude-code-best/builtin-tools/tools/ReviewArtifactTool/ReviewArtifactTool.js')
      .ReviewArtifactTool
  : null
```

打开 `packages/builtin-tools/src/tools/ReviewArtifactTool/` 验证一下 -- 这个目录是存在的，工具实现也完整。但 `hunter.js`（注册 hunter skill 的模块）不存在。这意味着 `REVIEW_ARTIFACT` 是"工具存在但 skill 不存在"的半死状态。

**如果不区分这两类**，有人可能觉得"注释掉的 feature 只要改一行配置就能启用"。对第二类也许可以，但对第一类，启用 `CONTEXT_COLLAPSE` 会让 auto compact 失效、启用 `UDS_INBOX` 会让 Node.js 构建卡住（`scripts/defines.ts:68` 的注释明确说了）。

## `const x = feature()` 为什么到处存在

CLAUDE.md 说 "不能赋值给变量"，但你打开 `src/main.tsx:119` 就能看到违反这条规则的代码：

```ts
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js'))
  : null;
```

这不矛盾。CLAUDE.md 说的"不能赋值给变量"指的是你不能把 `feature()` 的返回值单独赋给变量然后在 `if` 里用那个变量。但 `feature() ? a : null` 是三元表达式 -- `feature()` 在条件位置。Bun 编译器的 DCE 看到的是 `feature('X')` 这个 AST 节点在三元条件的根，它知道可以替换。

同样的模式在 `src/tools.ts:140-158` 中大量出现：

```ts
const SnipTool = feature('HISTORY_SNIP')
  ? require('@claude-code-best/builtin-tools/tools/SnipTool/SnipTool.js').SnipTool
  : null
const ReviewArtifactTool = feature('REVIEW_ARTIFACT')
  ? require('@claude-code-best/builtin-tools/tools/ReviewArtifactTool/ReviewArtifactTool.js').ReviewArtifactTool
  : null
```

这是 "feature gate + 条件 require + null fallback" 三合一模式。如果 `feature()` 在条件位置，DCE 生效，`require()` 路径在 false 时不会被解析。如果写成 `const enabled = feature('X'); const tool = enabled ? require(...) : null;`，第二行的 require 不在 `feature()` 的 AST 子树里，DCE 无法保证它在 false 时被消除。

打开 `src/main.tsx:703`，看一个更微妙的三元用法：

```ts
const _pendingConnect: PendingConnect | undefined = feature('DIRECT_CONNECT')
  ? {
      url: undefined,
      authToken: undefined,
      dangerouslySkipPermissions: false,
    }
  : undefined;
```

这里不是 require，而是一个对象字面量。`feature('DIRECT_CONNECT')` 在三元条件位置，DCE 可以把 false 分支（对象字面量）消除。如果不这么做，`PendingConnect` 类型可能引用的内部模块会被全量引入。

## feature 字符串本身的 DCE

还有一个容易被忽略的 DCE 细节。打开 `src/components/TokenWarning.tsx:87`：

```ts
// Each feature() block stands alone so the flag strings DCE from
// external builds independently.
if (feature('REACTIVE_COMPACT')) {
  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
    reactiveOnlyMode = true;
  }
}
if (feature('CONTEXT_COLLAPSE')) {
  const { isContextCollapseEnabled } =
    require('../services/contextCollapse/index.js');
  // ...
}
```

注释说 "each feature() block stands alone"。为什么不合并成一个 `if (feature('A') || feature('B'))` 块？因为合并后，即使 `A` 和 `B` 都为 false，`else` 分支中的 feature flag 字符串 `'REACTIVE_COMPACT'` 和 `'CONTEXT_COLLAPSE'` 可能不会从产物中消除。独立的 `if` 块让每个 flag 字符串在自己的 DCE 作用域里 -- `feature('X')` 替换为 `false` 后，整个 `if (false) { ... }` 块包括其中的字符串字面量都会被删除。

这对内部工具来说很重要：feature flag 的名称（如 `CONTEXT_COLLAPSE`）本身可能泄露内部项目代号或功能名称。独立 DCE 确保外部构建的产物里找不到任何被注释掉的 feature 名称。

## 延伸阅读

- 想看 feature flag 如何与代码分割交互（为什么 600+ chunks 中的某些 chunks 只在特定 feature 启用时加载），见 [第一章：Code Splitting 不是优化，是生存需求](./01-code-splitting.md)
- 想看入口函数如何用 feature gate 实现零模块加载的快速路径，见 [第二章：入口的 Fast-Path 优先级链](./02-fast-path.md)
- 想看工具系统如何用 feature gate 实现延迟加载与白名单过滤，见 [第六章：工具系统的延迟加载与 CORE_TOOLS 白名单](./06-tools-deferred.md)
- 想看 biome.json 关闭 42 条规则背后的反编译痕迹，见 [第十五章：biome.json 的 42 条规则关闭](./15-biome-42-rules.md)
