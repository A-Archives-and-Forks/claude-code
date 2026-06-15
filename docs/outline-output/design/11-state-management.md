# 第十一章：三层状态管理 —— 为什么 bootstrap/state.ts 警告 "DO NOT ADD MORE"

> 一个 1761 行的模块、一个 34 行的 store、一个 React Context —— 三层各司其职，边界严格到用注释威胁后来者。

## 为什么会有"三层"，而不是一个全局 store

在大多数 React 应用里，状态管理是一道选择题：Redux、Zustand、Jotai、Recoil…… 选一个，然后把所有东西塞进去。但 Claude Code 没有选——它同时保留了三种完全不同的状态容器，而且彼此之间不能互相替代。打开 `src/bootstrap/state.ts`、`src/state/store.ts`、`src/state/AppState.tsx` 你会看到三段风格迥异的代码，分别服务于三种被运行时约束逼出来的需求。

把这三层的需求列出来，你就能看出为什么合并不了：

| 层 | 容器 | 谁会读它 | 何时确定 | 为什么不能放进 React |
|---|---|---|---|---|
| Bootstrap | 模块级 singleton `STATE` | query loop、tools、telemetry、bootstrap 阶段的早期代码 | 进程启动时 | React 树还没 mount，`useSyncExternalStore` 是个空指针 |
| Store | 手写 zustand-style store | 任何想响应式订阅的代码 | 首次 `createStore()` 调用 | 不能依赖 React Context（headless/SDK 路径不走 React） |
| AppState | React Context 包裹的 store | REPL 组件树 | `<AppStateProvider>` mount 时 | 需要 React 调度、需要细粒度 selector 订阅、需要禁止嵌套 |

反事实推演：如果项目贪图统一，把 bootstrap state 也塞进 React Context 会怎样？`src/entrypoints/cli.tsx` 的 fast-path（`--version`、`--dump-system-prompt`、MCP server 模式）根本不会 mount React 树，但它们需要读 `clientType`、`sessionId`、`cwd` 这些值。React Context 不存在的时候，所有这些读取都会拿到 `undefined`，整个 fast-path 优先级链（见第二章）会瞬间瓦解。

所以三层不是设计冗余，而是"不同代码阶段需要不同的状态容器"这个硬约束的直接产物。下面一层一层拆。

## Bootstrap state：1761 行的"罪恶" singleton

打开 `src/bootstrap/state.ts:31`，你会看到一行用大写字母咆哮的注释：

```ts
// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE
```

这不是装饰性警告。继续往下翻到 `src/bootstrap/state.ts:45`，你会看到一个 `type State = {...}` 的字段清单——总共有 100 多个字段，文件本身 1761 行，导出 63 个 `set*` 函数和 100 个 `get*` 函数。这是一个名副其实的全局变量大杂烩，而且作者完全清楚这一点。

继续翻到 `src/bootstrap/state.ts:254` 和 `src/bootstrap/state.ts:422`，警告还在加码：

```ts
// ALSO HERE - THINK THRICE BEFORE MODIFYING
function getInitialState(): State {
  // ...
}

// AND ESPECIALLY HERE
const STATE: State = getInitialState()
```

三段警告（"DO NOT ADD MORE"、"THINK THRICE"、"ESPECIALLY HERE"）层层递进，构成一个有趣的悖论：**作者一边喊着不要再加，一边持续往里加。** 为什么？

答案藏在字段注释里。打开 `src/bootstrap/state.ts:45` 附近的 `type State`，每一个字段都带着一段解释为什么它必须住在这里而不是别处的故事。比如：

```ts
// CLAUDE.md content cached by context.ts for the auto-mode classifier.
// Breaks the yoloClassifier → claudemd → filesystem → permissions cycle.
cachedClaudeMdContent: string | null
```

这个字段住在 bootstrap 的唯一理由是**打破循环依赖**：`yoloClassifier` 调 `claudemd`，`claudemd` 读文件系统触发 `permissions`，`permissions` 又会回到 `yoloClassifier`。把它从 React/AppState 链条里抽出来，做成模块级 singleton，循环就断了。

再看一组：

```ts
// Sticky-on latch for AFK_MODE_BETA_HEADER. Once auto mode is first
// activated, keep sending the header for the rest of the session so
// Shift+Tab toggles don't bust the ~50-70K token prompt cache.
afkModeHeaderLatched: boolean | null
```

这个字段必须住在 bootstrap，是因为它是 **prompt cache 的粘性开关**：一旦 AFK 模式被激活过一次，整个 session 都要保持发送 beta header。如果放在会随 React 重渲染或 `/clear` 重置的容器里，Shift+Tab 来回切就会让服务端 prompt cache（50-70K token 的代价）反复 invalidate。bootstrap state 是唯一一个"进程不死就不重置"的地方。

类似地：

```ts
// Teams created this session via TeamCreate. cleanupSessionTeams()
// removes these on gracefulShutdown so subagent-created teams don't
// persist on disk forever (gh-32730). TeamDelete removes entries to
// avoid double-cleanup. Lives here (not teamHelpers.ts) so
// resetStateForTests() clears it between tests.
sessionCreatedTeams: Set<string>
```

注释直白地说：放在这里是为了 `resetStateForTests()` 能在测试之间清空它。这不是设计美学，这是测试隔离的工程需求。

### 模块级 singleton 的陷阱

为什么模块级 singleton 这么危险，以至于要写三段警告？打开 `src/bootstrap/state.ts:913` 看 `resetStateForTests`：

```ts
// Only used in tests
export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests can only be called in tests')
  }
  Object.entries(getInitialState()).forEach(([key, value]) => {
    STATE[key as keyof State] = value as never
  })
  outputTokensAtTurnStart = 0
  currentTurnTokenBudget = null
  budgetContinuationCount = 0
  sessionSwitched.clear()
}
```

注意 `if (process.env.NODE_ENV !== 'test') throw` 这一行——这是一个**运行时 guard**，防止有人在生产代码里调用这个清理函数。Bun 的 `mock.module` 是 process-global 的（详见第十四章测试策略），这意味着同一个进程里所有测试文件共享同一个 `STATE` 实例。如果某个测试改了 `STATE.sessionId` 没清理，下一个测试就会看到脏数据。

反事实推演：如果没有 `resetStateForTests`，每个测试都要手动 `setSessionId(randomUUID())`、`setCwdState(...)`、`setOriginalCwd(...)` —— 几十个字段。漏一个就是 flaky test。所以 `resetStateForTests` 不是便利函数，而是测试可靠性的兜底。

### 字段级 getter/setter：为什么不用 `STATE.field = x`

bootstrap state 的另一个反直觉设计是：**它不导出 `STATE` 本身**。外部代码只能通过 63 个 `set*` 和 100 个 `get*` 函数访问。打开 `src/bootstrap/state.ts:1059` 看一个典型例子：

```ts
export function setIsInteractive(value: boolean): void {
  STATE.isInteractive = value
}
```

为什么不直接 `export const STATE` 然后让调用方写 `STATE.isInteractive = true`？答案有两层：

1. **保留写入边界**：未来某天 `isInteractive` 需要触发副作用（比如 telemetry），只需改 `setIsInteractive` 一个地方。如果直接导出 `STATE`，所有写入点散落在代码库里，重构成本指数级。
2. **可被 mock**：测试可以 `mock.module('src/bootstrap/state.ts', ...)` 替换某个 getter 而不影响其他字段。直接导出 `STATE` 意味着整个对象要么全 mock 要么不 mock。

值得注意的是 `src/bootstrap/state.ts:17` 的注释：

```ts
// Indirection for browser-sdk build (package.json "browser" field swaps
// crypto.ts for crypto.browser.ts). Pure leaf re-export of node:crypto —
// zero circular-dep risk. Path-alias import bypasses bootstrap-isolation
// (rule only checks ./ and / prefixes); explicit disable documents intent.
// eslint-disable-next-line custom-rules/bootstrap-isolation
import { randomUUID } from 'src/utils/crypto.js'
```

项目有一条自定义 lint 规则 `custom-rules/bootstrap-isolation`，禁止 bootstrap 模块 import 任何以 `./` 或 `/` 开头的路径——**bootstrap 必须是依赖图的叶子节点**。这个 `eslint-disable` 是为了说明：`src/utils/crypto.js` 是 node:crypto 的纯叶子 re-export，import 它没有循环依赖风险。这个 lint 规则本身是 bootstrap state "不能太胖" 的结构性防线——如果 bootstrap 开始 import 业务模块，整个依赖图就会失控。

### `createSignal` 的出场：唯一的"可订阅"字段

绝大部分 bootstrap 字段是"写了就写了，没人订阅"。但有一组例外。打开 `src/bootstrap/state.ts:475`：

```ts
const sessionSwitched = createSignal<[id: SessionId]>()
// ...
export const onSessionSwitch = sessionSwitched.subscribe
```

`createSignal` 来自 `src/utils/signal.ts`，是一个手写的极简信号实现。`sessionSwitched` 是 bootstrap state 里少数能让外部代码订阅变化的字段——当 `switchSession()` 被调用（比如 `/resume` 切到另一个 session），订阅者会被通知。

为什么所有字段不都做成 signal？因为 99% 的 bootstrap 字段不需要订阅——它们是"写入即生效"的（比如 `sessionId` 被读的时候就是当前值，不需要响应式）。把所有字段都做成 signal 会让模块复杂度暴涨，而且引入订阅生命周期管理（清理、内存泄漏）。signal 只在最需要的少数几个字段上用，是一种克制的工程选择。

## 手写的 zustand：34 行的 `createStore`

如果说 bootstrap state 是"为了不被重置而存在的 singleton"，那么 `src/state/store.ts` 就是"为了能被订阅而存在的极简 store"。整个文件 34 行，打开 `src/state/store.ts:1` 你就能看完全部：

```ts
type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,

    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },

    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

这就是整个 store。三个 API：`getState`、`setState`、`subscribe`。两个细节值得拆。

### `Object.is` 短路：为什么是 `Object.is` 而不是 `===`

`setState` 里有一行 `if (Object.is(next, prev)) return`——如果 updater 返回的是同一个引用，直接 short-circuit，不通知任何订阅者。这看起来像 `===`，但 `Object.is` 比 `===` 更严格也更聪明：

- `Object.is(NaN, NaN)` 是 `true`（`===` 是 `false`）
- `Object.is(-0, 0)` 是 `false`（`===` 是 `true`）
- `Object.is({}, {})` 是 `false`（两个不同的对象引用）

对于 store 来说，`Object.is` 是**最佳短路判定**：当调用方 `setState(prev => prev)`（返回同一个引用），订阅者不会被惊动。这鼓励了一种风格——只在状态真的变了的时候才创建新对象。`src/state/__tests__/store.test.ts:23` 直接测了这一点：

```ts
test('setState does not notify when state unchanged (Object.is)', () => {
  const store = createStore({ count: 0 })
  let notified = false
  store.subscribe(() => {
    notified = true
  })
  store.setState(prev => prev)
  expect(notified).toBe(false)
})
```

反事实推演：如果用 `JSON.stringify(next) === JSON.stringify(prev)` 做"深度比较"呢？每次 `setState` 都要序列化整个 state 树（AppState 有几十个字段），在大对象上是 O(n) 的开销。而 `Object.is` 是 O(1)。这个差异在 REPL 里每个按键、每个流式 token 都可能触发 `setState` 的场景下，是不可忽视的。

### `Set<Listener>`：为什么订阅者用 Set 而不是 Array

`listeners = new Set<Listener>()` 是另一个值得注意的选择。`subscribe` 返回一个 unsubscribe 函数 `() => listeners.delete(listener)`，这是经典的"disposable pattern"。

如果用 Array：unsubscribe 要 `indexOf` 找到下标再 `splice`，O(n)；而且如果同一个 listener 被 subscribe 多次，Array 会有重复，Set 不会。Set 的语义刚好是"同一个订阅者只通知一次"，即使你意外 subscribe 两次。

### 为什么不直接用 zustand

项目里明明有 `packages/` workspace 机制（见 CLAUDE.md），可以装 zustand 这种 1KB 的库。为什么不装？三个理由：

1. **零依赖**：`store.ts` 不依赖任何外部包。在反编译重建的项目里，每多一个依赖都意味着多一个潜在的安全审计面和多一个 upgrade 风险。手写 34 行换零依赖，是非常划算的交易。
2. **完全可控**：`onChange` 回调是项目特有的扩展。zustand 有 `subscribeWithSelector` middleware 可以实现类似功能，但 API 更复杂。手写版直接把 `onChange` 焊在 `createStore` 签名里，调用方（`AppState.tsx`）不需要任何额外配置。
3. **极简语义**：整个 store 的行为可以用一句话描述——"`setState` 用 `Object.is` 短路，变了就通知所有 listener"。zustand 的 middleware 系统（`devtools`、`persist`、`immer`）在 terminal CLI 里大部分用不上。

## AppState.tsx：把 store 包进 React Context

第三层是 `src/state/AppState.tsx`。打开 `src/state/AppState.tsx:59`，你会看到 `AppStateProvider` 函数的开头：

```tsx
export function AppStateProvider({ children, initialState, onChangeAppState }: Props): React.ReactNode {
  // Don't allow nested AppStateProviders.
  const hasAppStateContext = useContext(HasAppStateContext);
  if (hasAppStateContext) {
    throw new Error('AppStateProvider can not be nested within another AppStateProvider');
  }

  // Store is created once and never changes -- stable context value means
  // the provider never triggers re-renders. Consumers subscribe to slices
  // via useSyncExternalStore in useAppState(selector).
  const [store] = useState(() => createStore<AppState>(initialState ?? getDefaultAppState(), onChangeAppState));
```

这段代码做了三件值得拆的事。

### `useState(() => createStore(...))`：lazy initialization

注意 store 不是在模块顶层创建的，而是放在 `useState` 的 lazy initializer 里。这保证了：

1. **每个 `<AppStateProvider>` 实例有独立的 store**：如果同一个 React 树里 mount 了两个 provider（虽然在嵌套禁令下不可能，但测试场景可能模拟），它们的 store 互不干扰。
2. **store 引用稳定**：`useState` 的 lazy initializer 只在首次 render 时调用一次，之后 `store` 引用永远不变。这点至关重要——`AppStoreContext.Provider value={store}` 不会因为 store 引用变化而触发下游所有 consumer 重新订阅。

反事实推演：如果写成 `const store = createStore(...)`（模块顶层），那么所有 `<AppStateProvider>` 会共享同一个 store，破坏隔离性。如果写成 `const [store] = useState(createStore(...))`（不带 arrow function），每次 render 都会调用 `createStore`，创建新 store，丢失所有订阅者和状态。

### `HasAppStateContext` 主动 throw：为什么禁止嵌套

`HasAppStateContext` 是一个独立的 `React.createContext<boolean>(false)`，唯一目的就是检测嵌套。当某个组件树里已经有一个 `<AppStateProvider>`，再 mount 第二个就会触发 throw。

这个限制看起来很激进——React Context 本身是允许嵌套的，内层会 shadow 外层。为什么这里禁止？

打开 `src/state/AppState.tsx:90` 附近看 provider 树：

```tsx
return (
  <HasAppStateContext.Provider value={true}>
    <AppStoreContext.Provider value={store}>
      <MailboxProvider>
        <VoiceProvider>{children}</VoiceProvider>
      </MailboxProvider>
    </AppStoreContext.Provider>
  </HasAppStateContext.Provider>
)
```

provider 内部还嵌套了 `MailboxProvider` 和 `VoiceProvider`——它们都依赖外层的 store。如果允许嵌套，内层 `<AppStateProvider>` 会创建一个**新的** store，但 `MailboxProvider`/`VoiceProvider` 已经绑定了外层 store。两个 store 不同步会导致 mailbox 和 voice state 与 app state 漂移。禁止嵌套是最简单的保护。

这也呼应了第十章"为什么 fork Ink 而不是用上游"的设计哲学：**对结构不变量主动 throw，而不是用警告日志**。throw 会让 bug 在开发阶段立刻暴露，而不是在用户环境里慢慢漂移。

### `useSyncExternalStore` 订阅 slice：为什么不用 `useContext` + `useMemo`

打开 `src/state/AppState.tsx:129` 的 `useAppState` hook：

```tsx
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore();

  const get = () => {
    const state = store.getState();
    const selected = selector(state);

    if (process.env.USER_TYPE === 'ant' && state === selected) {
      throw new Error(
        `Your selector in \`useAppState(${selector.toString()})\` returned the original state, which is not allowed. You must instead return a property for optimised rendering.`,
      );
    }

    return selected;
  };

  return useSyncExternalStore(store.subscribe, get, get);
}
```

这里用的是 React 18 的 `useSyncExternalStore`——专门为"订阅外部 store"设计的 hook。它解决了 `useContext` 的一个根本问题：**Context 的细粒度订阅**。

如果用 `useContext(AppStoreContext)`，每个 consumer 都会在 store 变化时 re-render，哪怕它只关心 `state.verbose` 这一个字段。`useSyncExternalStore` + selector 模式让每个 consumer 只在自己关心的 slice 变了的时候才 re-render。

`get` 函数是 selector 的执行器，`useSyncExternalStore` 会在每次 store 通知时调用 `get`，然后用 `Object.is` 比较返回值——如果没变，跳过 re-render。这与 `store.ts` 的 `Object.is` 短路是一致的协议。

### `USER_TYPE === 'ant'` 时强制 selector：内部 dogfooding

注意 `if (process.env.USER_TYPE === 'ant' && state === selected) throw`——当运行环境是 Anthropic 内部开发模式时，如果 selector 返回了整个 state（`state === selected`），直接抛错。

为什么内部模式更严格？因为返回整个 state 会让 `Object.is` 永远看到"变了"（每次 setState 都创建新 state 对象），consumer 会无差别 re-render，细粒度订阅形同虚设。这是一个**性能保护**：内部开发者（ant）被强制写出正确的 selector，外部用户（community）拿到的是更宽松的 runtime——可能慢一点，但不会因为不小心 return 了整个 state 就崩溃。

这个 pattern 在反编译产物里特别有趣：它揭示了 Anthropic 内部对 dogfooding 的态度——**自己人用更严格的版本**。类似的内部/外部差异在项目里还出现在多处（比如 `replBridgeActive` 只在 `USER_TYPE === 'ant'` 时出现，见 `src/bootstrap/state.ts:386`）。

## 三层之间的边界：谁该住在哪里

有了三层状态容器，每个新字段都要回答一个问题：**它该住哪一层？** 项目的判断标准大致是：

| 字段特征 | 应该住在 |
|---|---|
| 进程启动时就需要、React 还没 mount | bootstrap |
| 需要在测试之间被 `resetStateForTests()` 清空 | bootstrap |
| 是 prompt cache 的粘性 latch（session 级不可变） | bootstrap |
| 需要响应式订阅、UI 会消费 | AppState（经 store） |
| 跨 turn 持久但只在 React 树里用 | AppState |
| 是计算派生值（`getViewedTeammateTask`） | selector（`src/state/selectors.ts`） |

注意 selector 是第四层——`src/state/selectors.ts` 里的函数（`getViewedTeammateTask`、`getActiveAgentForInput`）是 **pure function**，不持有任何 state。它们的存在让 UI 组件不用每次都重新写派生逻辑：

```ts
export function getViewedTeammateTask(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
): InProcessTeammateTaskState | undefined {
```

接受 `Pick<AppState, ...>` 而不是完整 `AppState`，是为了让 selector 的依赖一目了然——这又是一种"显式优于隐式"的工程克制。

反事实推演：如果所有派生逻辑都直接写在组件里，每个组件都要 import 整个 AppState 然后自己拼。结果是组件测试时要 mock 整个 state，而且改一个派生逻辑要改 N 处。selector 抽出来，既复用又可测。

## `onChangeAppState`：唯一的副作用集中点

最后看一个跨层的设计：`onChange` 回调。打开 `src/state/onChangeAppState.ts:42`：

```ts
export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}) {
  // toolPermissionContext.mode — single choke point for CCR/SDK mode sync.
  //
  // Prior to this block, mode changes were relayed to CCR by only 2 of 8+
  // mutation paths: a bespoke setAppState wrapper in print.ts (headless/SDK
  // mode only) and a manual notify in the set_permission_mode handler.
  // Every other path — Shift+Tab cycling, ExitPlanModePermissionRequest
  // dialog options, the /plan slash command, rewind, the REPL bridge's
  // onSetPermissionMode — mutated AppState without telling
  // CCR, leaving external_metadata.permission_mode stale and the web UI out
  // of sync with the CLI's actual mode.
  //
  // Hooking the diff here means ANY setAppState call that changes the mode
  // notifies CCR (via notifySessionMetadataChanged → ccrClient.reportMetadata)
  // and the SDK status stream (via notifyPermissionModeChanged → registered
  // in print.ts). The scattered callsites above need zero changes.
```

这段注释是整个三层状态管理的精华。它讲了一个真实的故事：

曾经有 8+ 个地方会改 `toolPermissionContext.mode`（Shift+Tab、`/plan`、ExitPlanMode dialog、rewind、bridge 回调……），但只有 2 个地方会通知外部（CCR web UI、SDK status stream）。其他路径会改 AppState 但不通知，导致 web UI 显示的权限模式与 CLI 实际不一致。

修复方案不是"在每个修改点都加 notify"——那会有 N 个遗漏点。而是**在 `onChangeAppState` 这一个 choke point 做 diff**：任何 mode 变化都会触发 notify，调用方完全无感。这是一个教科书级的"集中副作用"案例。

这个 pattern 与 `store.ts` 的设计是配合的：`createStore` 接受 `onChange` 回调，回调在 `Object.is` 短路之后、listener 通知之前调用。所以 `onChangeAppState` 只在 state 真的变了的时候被调用，不会收到噪声通知。

## 反编译产物的特殊痕迹

这章涉及的代码里有几个值得指出的反编译痕迹：

1. **`src/types/utils.ts:2` 的 `DeepImmutable<T> = T` 是 stub**。`AppState` 类型用 `DeepImmutable<{...}>` 包裹（见 `src/state/AppStateStore.ts:91`），原本应该是递归 readonly 类型，但反编译产物把它退化成了 `T`。这意味着 `AppState` 实际上没有任何编译期不可变性保护——`store.ts` 的 `Object.is` 短路是唯一防线。如果哪天有人直接 `state.field = value` 而不是 `setState(prev => ({...prev, field: value}))`，TypeScript 不会报错，但所有订阅者都不会被通知。

2. **`USER_TYPE === 'ant'` 检查**：bootstrap state 和 AppState 都有 `USER_TYPE === 'ant'` 分支。这是 Anthropic 内部构建系统的产物——`USER_TYPE=ant` 触发内部 only 的字段（比如 `replBridgeActive`）和更严格的 runtime 检查（比如 selector 必须返回属性）。社区用户跑 `USER_TYPE=community` 或不设置时拿到的是更宽松但更脆弱的版本。

3. **`process.env.NODE_ENV !== 'test'` guard**：`resetStateForTests` 用运行时检查而不是编译期 DCE 来保护自己。这是因为反编译产物的 build pipeline 不一定可靠地 strip 掉测试 only 代码——运行时 guard 是最后一道防线。

## 延伸阅读

- 想看 bootstrap state 的循环依赖是怎么被 `cachedClaudeMdContent` 字段打破的，见 [第十三章：CLAUDE.md 四层层级与 @include 指令](./13-claudemd.md)
- 想看 `USER_TYPE === 'ant'` 的更多分支差异和反编译 stub 痕迹，见 [序章：一份被反编译重建的 CLI](./00-prologue.md)
- 想看 `Object.is` 短路在流式 token 场景下的性能影响，见 [第四章：核心 Query Loop](./04-query-loop.md)
- 想看 `onChangeAppState` 通知的 CCR/SDK 外部消费者，见 [第十二章：ACP / Bridge / Daemon](./12-acp-bridge-daemon.md)
