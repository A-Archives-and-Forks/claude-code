# 第十三章：CLAUDE.md 四层层级与 @include 指令

> 一份"配置文件"被设计成有优先级的文件系统爬取协议，原因是 LLM 的注意力分布天然偏向上下文尾部。

## 逆序加载：为什么"离你最近"的指令优先级最高

打开 `src/utils/claudemd.ts` 的头部注释（第 1-26 行），你会看到整个记忆系统的契约声明：

```typescript
/**
 * Files are loaded in the following order:
 *
 * 1. Managed memory (eg. /etc/claude-code/CLAUDE.md) - Global instructions for all users
 * 2. User memory (~/.claude/CLAUDE.md) - Private global instructions for all projects
 * 3. Project memory (CLAUDE.md, .claude/CLAUDE.md, and .claude/rules/*.md in project roots)
 * 4. Local memory (CLAUDE.local.md in project roots) - Private project-specific instructions
 *
 * Files are loaded in reverse order of priority, i.e. the latest files are highest priority
 * with the model paying more attention to them.
 */
```

四层层级：Managed -> User -> Project -> Local。先加载的先拼接，后加载的后拼接。这个顺序不是随意选的——它利用了 LLM 的一个已知特性：**模型对上下文尾部的注意力天然更高**（lost-in-the-middle 效应）。所以 `CLAUDE.local.md`（个人私有项目指令）出现在拼接字符串的最末尾，`/etc/claude-code/CLAUDE.md`（组织管理员策略）出现在最开头。

如果不这么做——比如按"先 Local 后 Managed"拼接——那组织级的"禁止将凭证写入日志"这类安全策略会被埋在上下文深处，模型更可能忽略它。这个逆序设计把最高优先级的指令放在模型注意力最集中的位置。

实现上，`getMemoryFiles()`（`claudemd.ts:789`）严格按 Managed -> User -> Project -> Local 顺序 push 结果数组。注释说的"reverse order of priority"指的是**加载顺序与优先级相反**：最先加载（Managed）优先级最低，最后加载（Local）优先级最高。

## 向上爬取：从 CWD 到根的目录遍历

`getMemoryFiles()` 在处理 Project 和 Local 层级时（`claudemd.ts:848-933`），从 CWD 开始向上遍历到文件系统根：

```typescript
const dirs: string[] = []
const originalCwd = getOriginalCwd()
let currentDir = originalCwd

while (currentDir !== parse(currentDir).root) {
  dirs.push(currentDir)
  currentDir = dirname(currentDir)
}
// Process from root downward to CWD
for (const dir of dirs.reverse()) {
```

注意那个 `.reverse()`：先收集路径（CWD -> root），然后反转成 root -> CWD 的顺序遍历。这样做的效果是：离 CWD 最近的 `CLAUDE.md` 最后被 push 到结果数组，自然获得最高优先级。

一个可能被忽略的细节：每一层目录会同时尝试读取三个位置——`CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`（Project），以及 `CLAUDE.local.md`（Local）。同一个目录可以同时贡献一个 Project 级和多个 rules 文件。

如果不做向上遍历而是只读 CWD 一层，那 monorepo 子目录就无法继承仓库根目录的全局指令。一个 Go 项目根目录的 CLAUDE.md 说"用 gofmt 格式化"，`cmd/server/` 子目录的 CLAUDE.md 补充"这个子模块用 Go 1.22"，两层都需要生效。

## `@include` 指令：四种路径形式与 AST 安全

`@include` 的路径解析在 `extractIncludePathsFromTokens()`（`claudemd.ts:450`）中实现。支持四种前缀：

- `@./relative/path` — 相对于当前文件
- `@path`（无前缀） — 等同于 `@./path`
- `@~/home/path` — 用户主目录
- `@/absolute/path` — 绝对路径

路径解析委托给 `expandPath()`（`src/utils/path.ts:40`），这个函数处理 `~` 展开、POSIX/Windows 路径互转、null 字节安全检查。

关键的边界约束在 `extractIncludePathsFromTokens` 内部：

```typescript
if (element.type === 'code' || element.type === 'codespan') {
  continue
}
```

**代码块和行内代码内的 `@path` 会被跳过**。这不是字符串匹配能做到的——实现上用了 `marked` 的 `Lexer`（`claudemd.ts:31`）将 Markdown 解析成 AST token 树，只从"叶子文本节点"中提取 `@` 路径。`gfm: false` 是必须的（`claudemd.ts:364`），因为 GFM 模式下 `~` 会被解析为删除线 token，导致 `@~/path` 中的 `~` 被吞掉。

如果不走 AST 而用正则暴力匹配，`@include` 在代码块示例中也会被解析——比如 CLAUDE.md 里写着"可以用 `@./config.yaml` 引入配置"这段说明文字，里面的示例路径就会被当成真正的 include 指令执行。

## 防循环与静默忽略

`processMemoryFile()`（`claudemd.ts:617`）用 `processedPaths: Set<string>` 追踪已处理文件，遇到重复路径直接返回空数组。同时在 `depth >= MAX_INCLUDE_DEPTH`（`claudemd.ts:629`，最大深度 5）时截断。

```typescript
const normalizedPath = normalizePathForComparison(filePath)
if (processedPaths.has(normalizedPath) || depth >= MAX_INCLUDE_DEPTH) {
  return []
}
```

对符号链接做了双重追踪（`claudemd.ts:644-647`）——同时记录原始路径和解析后的路径，防止通过 symlink 绕过去重。

文件不存在（ENOENT）不会报错——`handleMemoryFileReadError`（`claudemd.ts:401`）对 ENOENT 和 EISDIR 直接 return。这个设计是有意为之的：CLAUDE.md 经常在仓库间复制粘贴，`@include` 引用的路径在另一个项目里可能不存在。如果每次遇到不存在的文件就抛异常，CLAUDE.md 就失去了可移植性。

如果不静默忽略而是抛错，用户从别人的项目模板复制 CLAUDE.md 后就会因为一个缺失的 include 路径而无法启动。`ENOENT` 静默处理是可移植性换安全性的典型取舍。

## 60+ 种扩展名：为什么不是只有 .md

`TEXT_FILE_EXTENSIONS`（`claudemd.ts:95`）是一个包含 60+ 种扩展名的 Set。不仅有 `.md`、`.txt`，还有 `.ts`、`.py`、`.rs`、`.swift`、`.sql`、`.graphql`、`.proto`、`.vue`、`.svelte`...

这个列表的存在是因为 `@include` 被设计为**项目知识的引用机制**，不只是 Markdown 的 include。你可以在 CLAUDE.md 里写 `@./src/types/api.ts` 把 API 类型定义直接喂给模型，让模型理解项目的类型系统。也可以写 `@./schema.graphql` 引入 GraphQL schema。

在 `parseMemoryFileContent()`（`claudemd.ts:342`）中，非文本扩展名的文件会被跳过：

```typescript
const ext = extname(filePath).toLowerCase()
if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) {
  logForDebugging(`Skipping non-text file in @include: ${filePath}`)
  return { info: null, includePaths: [] }
}
```

注意判断逻辑：**有扩展名但不在白名单里才跳过**。无扩展名文件（如 `Makefile`、`Dockerfile`）不会被拦截——因为很多经典的项目配置文件没有扩展名。这是一个可能让人意外的边界：你可以 `@./Makefile`，但不能 `@./image.png`。

如果不限制扩展名，用户（或模型自己）的 `@include` 可能意外引入二进制文件（`.png`、`.pdf`、`.zip`），这些二进制数据会直接注入系统提示的 token 流，不仅浪费 token，还可能导致模型解析错误。

## 40,000 字符上限与 HTML 注释剥离

`MAX_MEMORY_CHARACTER_COUNT = 40000`（`claudemd.ts:91`）限制了单个记忆文件的推荐最大长度。超过这个值的文件不会被截断（这个常量名说的是"推荐"），但在 `getLargeMemoryFiles()`（`claudemd.ts:1131`）中会被标记为"大文件"。

另一个处理是 `stripHtmlComments()`（`claudemd.ts:291`）——块级 HTML 注释 `<!-- ... -->` 会被剥离。这用的是 `marked` 的 Lexer 来识别块级 HTML token，保留行内注释和代码块内的注释不动。未闭合的 `<!--` 也不会被处理——防止一个打字错误吞掉整个文件。

为什么 HTML 注释要剥离？因为 CLAUDE.md 的作者经常用 `<!-- 内部笔记 -->` 写给自己看的备注，这些内容不应该进入模型的上下文——它们是给人读的元信息，不是给模型的指令。

## `@include` 的外部文件安全警告

`@include` 允许引用 CWD 之外的文件，但这会触发一个安全机制。`getExternalClaudeMdIncludes()`（`claudemd.ts:1403`）会扫描所有已加载的记忆文件，找出"非 User 类型且有 parent 且路径在 CWD 之外"的 include。

```typescript
export function getExternalClaudeMdIncludes(
  files: MemoryFileInfo[],
): ExternalClaudeMdInclude[] {
  const externals: ExternalClaudeMdInclude[] = []
  for (const file of files) {
    if (file.type !== 'User' && file.parent && !pathInOriginalCwd(file.path)) {
      externals.push({ path: file.path, parent: file.parent })
    }
  }
  return externals
}
```

注意 `file.type !== 'User'`：User 级别的 CLAUDE.md 可以自由 include 任何路径（`claudemd.ts:832` 传 `includeExternal: true`），这是用户的私有全局配置。但 Project 级别的 include 只在用户明确批准后才允许引用外部文件（`config.hasClaudeMdExternalIncludesApproved`）。

这个区分的合理性在于：User 级 CLAUDE.md 在 `~/.claude/` 下，是用户完全控制的私有空间。而 Project 级 CLAUDE.md 是签入代码仓库的，如果它 `@include` 引用了 `/etc/shadow` 之类的敏感路径，就构成了一个通过代码仓库投毒的攻击面。

## `.claude/rules/` 的 frontmatter 路径匹配

`.claude/rules/*.md` 下的文件支持 frontmatter 中的 `paths:` 字段来做条件匹配（`claudemd.ts:248-278`）。这种文件只在处理特定路径的文件时才被加载，而不是一开始就全部注入上下文。

```yaml
---
paths:
  - "src/services/api/**"
  - "src/utils/model/**"
---
这里写与 Provider 系统相关的指令...
```

解析逻辑在 `parseFrontmatterPaths()`（`claudemd.ts:253`）：提取 `paths` 字段，去掉 `/**` 后缀（因为 `ignore` 库会自动匹配子目录），然后用 `picomatch` 做 glob 匹配（`claudemd.ts:571`，调用 `ignore().add(globs).ignores(relativePath)`）。

这个设计的意图是节省 token：一个大型项目可能有几十个 rules 文件，但如果每次对话都全部注入，就是巨大的 token 浪费。frontmatter paths 让 rules 文件只在"相关"时才被加载——当模型正在编辑 `src/services/api/claude.ts` 时，`paths: ["src/services/api/**"]` 的规则才会生效。

## 从记忆文件到系统提示：context.ts 的装配线

`src/context.ts` 是最终的装配车间。`getSystemContext()`（`context.ts:116`）负责 git status、日期、缓存断点注入；`getUserContext()`（`context.ts:155`）负责 CLAUDE.md 的加载和拼接。

```typescript
const claudeMd = shouldDisableClaudeMd
  ? null
  : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
```

注意调用链：`getMemoryFiles()` 返回 `MemoryFileInfo[]` -> `filterInjectedMemoryFiles()` 根据 GrowthBook feature flag 过滤 AutoMem/TeamMem -> `getClaudeMds()` 拼接成最终字符串。

`getClaudeMds()`（`claudemd.ts:1152`）给每种类型的文件加了描述性后缀：

- Project: `" (project instructions, checked into the codebase)"`
- Local: `" (user's private project instructions, not checked in)"`
- User/Managed: `" (user's private global instructions for all projects)"`
- TeamMem: `" (shared team memory, synced across the organization)"`

这些后缀直接出现在模型的系统提示中，帮助模型区分哪些指令是团队共享的、哪些是个人私有的。

最终，`getMemoryFiles` 被 `lodash.memoize` 缓存（`claudemd.ts:789`），整个会话期间只执行一次文件系统遍历。缓存失效通过 `clearMemoryFileCaches()` 和 `resetGetMemoryFilesCache()` 控制——后者额外设置一个标记让 InstructionsLoaded hook 在下次加载时触发。

## worktree 嵌套的处理：一个容易被忽略的边界

`getMemoryFiles()` 有一个专门处理 git worktree 嵌套的逻辑（`claudemd.ts:858-883`）。当你在 worktree 内运行 Claude Code 时，向上遍历会经过 worktree root 和 main repo root，两个目录都可能有 `CLAUDE.md`。如果不做特殊处理，同一份签入文件会被加载两次。

```typescript
const gitRoot = findGitRoot(originalCwd)
const canonicalRoot = findCanonicalGitRoot(originalCwd)
const isNestedWorktree =
  gitRoot !== null &&
  canonicalRoot !== null &&
  normalizePathForComparison(gitRoot) !==
    normalizePathForComparison(canonicalRoot) &&
  pathInWorkingPath(gitRoot, canonicalRoot)
```

当检测到嵌套 worktree 时，main repo root 范围内的 Project 文件会被跳过（`skipProject` 标记），但 `CLAUDE.local.md` 仍然被加载——因为它是 gitignored 的，只在 main repo 中存在。

这个边界处理的触发条件非常特殊：你必须在 worktree 目录内启动 Claude Code，且 worktree 嵌套在 main repo 的工作树中。大多数用户永远不会遇到，但如果遇到"为什么我的 CLAUDE.md 指令重复了"，答案就在这里。

## 延伸阅读

- 想看系统提示的完整装配过程（git status / date / CLAUDE.md / memory files 如何组装），见 [第十五章：测试策略](./15-testing-strategy.md) 中关于 `getSystemContext` / `getUserContext` memoize 缓存与测试 mock 的讨论
- 想看 `context.ts` 的 memoize 缓存如何与 `query.ts` 的流式响应交互，见 [第四章：核心 Query Loop](./04-query-loop.md)
- 想看 feature flag 如何控制 AutoMem / TeamMem 的加载，见 [第五章：Feature Flag 系统的三个硬约束](./05-feature-flags.md)
- 想看 `.claude/rules/` 的 conditional rules 在嵌套目录遍历中的加载策略，见 [第六章：工具系统的延迟加载与 CORE_TOOLS 白名单](./06-tools-deferred.md) 中关于 token 预算管理的讨论
