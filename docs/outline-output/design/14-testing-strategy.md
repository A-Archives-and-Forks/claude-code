# 第十四章：测试策略 —— 为什么 mock 必须从底层 HTTP 开始

> Bun 的 mock.module 是进程全局的，一个测试文件的 mock 会让整个进程中毒

## mock.module 不是 Jest 的 jest.mock

大多数从 Jest/Vitest 迁移到 `bun:test` 的开发者会自然地假设 `mock.module` 和 `jest.mock` 一样——per-file 隔离，每个测试文件有自己独立的 mock 命名空间。Bun 打破了这个假设。

打开 `tests/mocks/axios.ts:1`，文件顶部的注释直接点出了这个问题的本质：

```
Each call to `setupAxiosMock()` registers its own `mock.module('axios', ...)`
that only knows about the handle returned to that call. No shared state between
test files — eliminates cross-file mock pollution.
```

这句话暗示了一个残酷的事实：`mock.module` 在 Bun 中是 **process-global last-write-wins**。你在测试文件 A 里调用 `mock.module('src/utils/log.ts', fakeLog)`，同进程里任何后续 `require('src/utils/log.ts')` 或 `import ... from 'src/utils/log.ts'` 都会拿到 `fakeLog`——无论调用方用的是什么路径字符串，无论它写在哪个文件里。`require()` 和 `import()` 共享同一张模块注册表。

这意味着：如果你在 `launchSchedule.test.ts` 里 mock 了 `triggersApi.ts`（上层业务模块），同目录的 `api.test.ts`（回归测试）再 `import('../triggersApi.js')` 时拿到的已经是 mock 版本——它本来要测试的"真实 HTTP 方法/URL/错误处理逻辑"全部消失了。

这就是 CLAUDE.md 里那条铁律的来源：

> **不要 mock 被测模块的上层业务模块。**

## 副作用链：为什么 log.ts 和 debug.ts 是必须 mock 的根

测试中 mock 的唯一合法动机是"被 mock 的模块有副作用，阻止它在测试环境正常加载"。

打开 `src/bootstrap/state.ts:7`，你会看到文件顶部有两个 import：

```ts
import { realpathSync } from 'fs'
```

`bootstrap/state.ts` 在模块加载时调用 `realpathSync` 去解析当前工作目录（`state.ts:266`），同时用 `randomUUID` 生成 session ID（`state.ts:326`）。这俩都是真正的 I/O 副作用——在测试进程里，工作目录可能不存在，或者你不想要真实的 session ID。

`log.ts` 和 `debug.ts` 都依赖 `bootstrap/state.ts`。打开 `tests/mocks/log.ts:4`，注释写得一清二楚：

```
Cuts the bootstrap/state.ts dependency chain (module-level realpathSync + randomUUID).
Must be called via mock.module("src/utils/log.ts", logMock) BEFORE any import that
transitively depends on log.ts.
```

所以依赖链是这样的：

```
log.ts → bootstrap/state.ts → realpathSync (I/O 副作用)
debug.ts → bootstrap/state.ts → randomUUID (I/O 副作用)
```

必须 mock `log.ts` / `debug.ts` 才能安全地导入任何依赖它们的模块。但这引出了一个问题：为什么不直接 mock `bootstrap/state.ts` 呢？

打开 `tests/mocks/state.ts:1`，答案是：**两者都 mock 了**。`stateMock` 存在，但 `log.ts` / `debug.ts` 的共享 mock 优先被使用，因为它们更轻量——大多数测试只需要 "log 别崩溃"，不需要一个完整的 90 行 state mock。

`logMock` 本身只有 23 行（`tests/mocks/log.ts:10-24`），把所有导出替换成 noop。`debugMock` 也只有 25 行（`tests/mocks/debug.ts:10-25`），所有函数返回 false/null/noop。两者都是 **factory 函数**（`export function logMock() { return { ... } }`），因为 `mock.module` 要求每次调用返回一个新对象——这是 Bun 的约束，不是设计选择。

如果不这么做会怎样？如果某个测试文件直接 mock `bootstrap/state.ts` 而其他文件通过 `log.ts` 间接依赖它，后者的 mock 会被前者的 `mock.module` 覆盖（last-write-wins）。共享 mock 文件确保了 "log 在所有测试里都是同一个 mock"。

## launch*.test.ts 和 api.test.ts 的共生关系

打开 `src/commands/schedule/__tests__/` 目录，你会看到两个文件并排：

- `launchSchedule.test.ts` — 集成测试，测 `callSchedule()` 的完整调用链
- `api.test.ts` — 回归测试，测 `triggersApi.ts` 的 HTTP 方法/URL/重试逻辑

`api.test.ts` 的测试目标很具体（`api.test.ts:6` 的注释）：

```
Key invariants under test:
  - updateTrigger MUST use POST, not PATCH
  - All CRUD endpoints hit /v1/code/triggers (not /v1/agents)
  - 401/403/404/429/5xx classified correctly
  - withRetry retries only 5xx, not 4xx
```

这些不变量测试的是 `triggersApi.ts` **真实的 HTTP 行为**。如果你在 `launchSchedule.test.ts` 里 mock 了 `triggersApi.ts`，`api.test.ts` 导入的 `triggersApi` 就变成了一个空壳——POST/PATCH 区分、URL 路径、错误分类逻辑全丢了。

所以铁律是：**`launch*.test.ts` mock axios（底层 HTTP 层），`api.test.ts` 让真实的 `triggersApi` 跑在 mock 的 axios 之上**。两个测试文件共享同一个 `setupAxiosMock()` 基础设施，但互不干扰。

打开 `launchSchedule.test.ts:1-9`，策略声明很明确：

```
Strategy per feedback_mock_dependency_not_subject:
- DO NOT mock triggersApi.ts itself (would pollute api.test.ts)
- Mock axios (the underlying HTTP layer) to control API responses
- Mock auth dependencies so real triggersApi functions can build headers
- Let real triggersApi functions run real code paths
```

`launchVault.test.ts:4` 和 `launchSkillStore.test.ts:8` 也用了同样的策略注释。这不是临时约定，而是整个项目的统一规范。

## setupAxiosMock：为什么它不是普通的 shared mock

打开 `tests/mocks/axios.ts:61-121`，`setupAxiosMock()` 的实现很有意思。它不是普通的 "返回一组 stub 函数"——它注册了一个 `mock.module('axios', ...)`，但这个 mock **只在 handle.useStubs 为 true 时生效**：

```ts
export function setupAxiosMock(): AxiosMockHandle {
  const handle: AxiosMockHandle = { useStubs: false, stubs: {} }

  mock.module('axios', () => {
    const route = (method: keyof AxiosMethodStubs): AnyFn => {
      const realFn = _realDefault[method] as AnyFn | undefined
      return (...args: unknown[]) => {
        if (handle.useStubs) {
          const stub = handle.stubs[method] as AnyFn | undefined
          if (stub) return stub(...args)
        }
        if (typeof realFn === 'function') return realFn(...args)
        throw new Error(`axios.${method} is not available on real axios`)
      }
    }
    // ...
  })
```

注意第 30 行：`const _realAxios = require('axios')`。它在 mock 注册**之前**就拿到了真实的 axios 模块引用。这意味着即使 mock 激活后，`route` 函数内部仍然可以 fall through 到真实的 axios 方法。`useStubs` 开关控制的是 "用 stub 还是用真实的 axios"。

这种设计的巧妙之处在于：**不需要恢复 mock**。`afterAll(() => { axiosHandle.useStubs = false })` 就足够了——mock 仍然存在，但所有请求都 fall through 到真实 axios。后续测试文件如果也调用 `setupAxiosMock()`，Bun 的 last-write-wins 会用新 mock 替换旧的（但这正是预期的行为——每个测试文件拿到自己的 handle）。

如果不这么做会怎样？如果 `setupAxiosMock` 在 `afterAll` 里调用 `mock.module('axios', () => realAxios)` 来恢复，那么第二个测试文件的 `setupAxiosMock()` 注册的 mock 会在第一个文件的 `afterAll` 执行后被**覆盖回真实 axios**。这种时序依赖正是 Bun 的 process-global mock 带来的根本问题——`useStubs` 开关巧妙地绕开了它。

## node:fs/promises 的 require() 逃逸技巧

`launchSkillStore.test.ts:87-114` 展示了一个更极端的防御措施。它需要 mock `node:fs/promises` 的 `mkdir` 和 `writeFile`，但 `node:fs/promises` 有几十个导出（readFile、readdir、unlink、chmod...）。如果只 mock 这两个，同进程里其他测试的 `readFile` 调用全部会崩溃。

解决方案：**在 mock factory 内部用 `require()` 拿到真实的 fs/promises 模块，然后 spread 它**：

```ts
mock.module('node:fs/promises', () => {
  const real = require('node:fs/promises') as Record<string, unknown>
  return {
    ...real,
    mkdir: (...args: unknown[]) =>
      useSkillStoreFsStubs
        ? mkdirMock(...args)
        : (real.mkdir as (...a: unknown[]) => Promise<unknown>)(...args),
    writeFile: (...args: unknown[]) =>
      useSkillStoreFsStubs
        ? writeFileMock(...args)
        : (real.writeFile as (...a: unknown[]) => Promise<unknown>)(...args),
  }
})
```

注释（第 88-91 行）解释了为什么这是必要的：

```
Bun's mock.module is global per-process and last-write-wins. Replacing
node:fs/promises with only mkdir + writeFile breaks every other test in
the same `bun test` run that imports readFile / readdir / unlink / chmod /
etc.
```

注意 `require('node:fs/promises')` 写在 factory 函数**内部**——`mock.module` 的 factory 是惰性求值的，每次模块被 require/import 时才执行。这意味着 `require()` 在 factory 内部能绕过 mock 注册表，拿到真正的原始模块。

如果没有这个技巧，要么每次 `bun test` 只跑一个文件（丧失并行效率），要么为 `node:fs/promises` 维护一个包含所有导出的巨型 mock（维护噩梦）。

## 排查 mock 污染的四步法

CLAUDE.md 里记录的排查方法值得逐条拆解：

**第 1 步：单独运行确认通过。** `bun test path/to/suspect.test.ts`。如果单独跑就失败，问题不在 mock 污染，在测试本身。

**第 2 步：同目录一起跑定位污染源。** `bun test path/to/__tests__/`。如果同目录的文件一起跑时 `api.test.ts` 开始失败，而单独跑时通过，说明同目录某个文件在 mock 被测模块的上层。

**第 3 步：console.error milestone 追踪顺序。** 在两个文件头部各加 `console.error('[filename] milestone')`。因为 Bun 的测试文件执行顺序不是严格的字母序，你不能假设 `api.test.ts` 一定在 `launchSchedule.test.ts` 之后执行。实际的执行顺序取决于 `bun test` 的内部文件遍历策略。

**第 4 步：检查 specifier 解析。** 即使两个测试文件写的是不同的路径字符串（一个写 `'../triggersApi.js'`，另一个写 `'src/commands/schedule/triggersApi.js'`），如果 Bun 把它们解析到同一个模块 ID，`mock.module` 仍然会污染。这是 Bun 模块解析的特性——路径别名（`src/*`）和相对路径可能指向同一个文件。

## 为什么不切换到 Vitest 或 Jest

看到这里你可能在想：既然 `bun:test` 的 mock 这么坑，为什么不用 Vitest 的 `vi.mock`（per-file 隔离）或 Jest 的 `jest.mock`（同样 per-file 隔离）？

答案是 **运行时一致性**。这个项目在 Bun 运行时上构建（`build.ts` 用 `Bun.build()`，`scripts/dev.ts` 用 `bun -d` 注入 MACRO），测试需要在相同运行时执行才能覆盖 `bun:bundle`、`bun:ffi`、Bun 特有的 `import.meta` 行为。Vitest 底层用的是 Vite（Node.js），无法还原这些运行时特性。

`bun:test` 的 `mock.module` 是 process-global 这一事实，是 "用 Bun 的测试框架就得接受 Bun 的约束" 的又一个例证——跟第一章（Code Splitting 生存需求）、第三章（performanceShim JSC 补丁）的叙事主线一致：**每一个看似奇怪的决定背后都有一个具体的运行时约束**。

## 共享 mock 的维护纪律

回到 `tests/mocks/` 目录。打开任一 mock 文件，你会看到统一的模式：factory 函数 + 注释说明为什么要 mock。`stateMock`（`tests/mocks/state.ts`）是最重量级的，90 行，覆盖了 `bootstrap/state.ts` 的所有导出。但它不是默认使用的——只有直接测试 state 相关逻辑时才引入。

核心原则：**mock 的表面应该和被 mock 模块的导出表保持同步**。源文件新增导出时，如果某个测试因此报错，应该更新 `tests/mocks/` 下的对应文件——而不是在测试文件内联 mock。这样所有依赖同一个 mock 的测试文件都自动受益。

CLAUDE.md 把这条写成了硬规则：

```
源文件导出变更时只需更新 tests/mocks/ 下的对应文件，不需要逐个修改测试。
```

如果没有这条规则和共享 mock 机制，每个测试文件都会内联自己的 log mock / debug mock / state mock。一旦 `log.ts` 新增一个导出，你需要在几十个文件里同步修改。这不仅是维护噩梦，还容易出现版本漂移——有的测试 mock 了旧版本的导出表，有的 mock 了新版本的，导致不可预测的测试行为。

## 延伸阅读

- 想看依赖 `bootstrap/state.ts` 模块级副作用的根本原因（为什么 `realpathSync` 和 `randomUUID` 在 import 时执行），见 [第十一章：三层状态管理](./11-state-management.md)
- 想看 `bun:test` 的 process-global mock 如何影响了 `node:fs/promises` 的测试隔离（require 逃逸技巧），见 [第一章：Code Splitting 不是优化，是生存需求](./01-code-splitting.md) 中关于 Bun 运行时约束的讨论
- 想看 `setupAxiosMock` 的 mock 开关机制与 `triggersApi.ts` 中 `withRetry` 重试逻辑的交互，见 [第九章：Usage 字段映射与模型映射的优先级链](./09-usage-mapping.md) 中关于 429/5xx 错误分类的部分
