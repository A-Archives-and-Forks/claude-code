# WSL CI Runbook — feat/autofix-pr-test 本地验证

**目的**：在 WSL Ubuntu 把 fork CI 流水线（typecheck / test / build / coverage）整套跑通，
绕过 Bun 1.3.12 + Windows panic，算出本次 PR 的 **patch coverage** 真实数字。

**当前分支**：`feat/autofix-pr-test`（3 个 squash commit，HEAD = `0c5f1104`）
**目标基线**：`origin/feat/autofix-pr`（HEAD = `b5659846`）
**改动规模**：67 文件 / +5738 / -385

---

## 0. 一次性准备（已装可跳过）

WSL 里运行：

```bash
# 检查 Bun
bun --version
# 期望 ≥ 1.3.11，建议升级到 1.3.12 与 Windows 主机对齐
bun upgrade

# 检查 Node（用于 nvm 兼容，不是必须，但 npm 触发 lifecycle 会用到）
node --version       # v24.x

# 安装 lcov 工具集（patch coverage 报告需要）
sudo apt update
sudo apt install -y lcov

# 验证 lcov
lcov --version       # 期望 ≥ 1.14
genhtml --version
```

---

## 1. 把代码同步到 WSL ext4（强烈推荐，IO 快 5-10×）

跨文件系统访问 `/mnt/e/...` 走 9P 协议非常慢，会让 `bun install` 和 `bun test` 慢得不可接受。

```bash
# 在 WSL 用户家目录建工作区
mkdir -p ~/work
cd ~/work

# 选项 A：clone fork 远端 + checkout 我们的 branch（推荐，一次到位）
git clone https://github.com/amDosion/claude-code-bast.git claude-code-bast
cd claude-code-bast
# 添加 unraid / gitea 远端（可选，跟 Windows worktree 远端一致）
# git remote add upstream https://github.com/claude-code-best/claude-code.git

# 我们的 squash 是本地 commit，origin 还没有 → 需要从 Windows 同步
# 选项 A.1：先在 Windows 推到 origin
#   (在 Windows PowerShell)  cd E:\Source_code\Claude-code-bast-autofix-pr-test
#   git push -u origin feat/autofix-pr-test
# 然后在 WSL 拉
git fetch origin
git checkout -b feat/autofix-pr-test origin/feat/autofix-pr-test

# 选项 B：直接 rsync 从 Windows worktree（不走远端）
# rsync -aH --delete --exclude=node_modules --exclude=dist --exclude=.squash-tmp \
#   /mnt/e/Source_code/Claude-code-bast-autofix-pr-test/ \
#   ~/work/claude-code-bast/

# 验证当前 HEAD
git log --oneline -3
# 期望前 3 行：
#   0c5f1104 feat(login): allow switch / replace / remove of workspace API key
#   0f3412b6 feat(commands): /local-memory + /local-vault interactive panels + path render fixes
#   acbbd5e2 feat(local-wiring): wire LocalMemoryRecall + VaultHttpFetch tools end-to-end
```

---

## 2. 安装依赖

```bash
cd ~/work/claude-code-bast

# 跳过 Chrome MCP 安装（CI 也跳过）
export CLAUDE_CODE_SKIP_CHROME_MCP_SETUP=1

bun install --frozen-lockfile
# 期望：~30s 完成，无 lockfile 冲突
# 若报 "lockfile mismatch" → 先在 Windows 跑 bun install 同步 lockfile，commit 再 push
```

---

## 3. 跑 CI 完整流水线（与 .github/workflows/ci.yml 一致）

```bash
# Step 1: typecheck
bun run typecheck
echo "exit=$?"
# 期望 exit=0（0 errors）

# Step 2: 全量测试 + lcov 覆盖率（CI 这一步用 grep/sed 过滤噪音，本地直接看完整输出）
mkdir -p coverage
bun test --coverage --coverage-reporter lcov --coverage-dir coverage 2>&1 | tee /tmp/test-output.log | tail -10

# 验证 lcov.info 生成
test -s coverage/lcov.info && echo "✓ lcov.info present ($(wc -l < coverage/lcov.info) lines)"
grep -c '^SF:' coverage/lcov.info
# 期望：~370 SF entries（每个 source file 一个）

# Step 3: build
bun run build:vite
echo "exit=$?"
# 期望 exit=0；产物在 dist/，预期看到几个 chunk: REPL / sentry / loadAgentsDir 等
```

**预期结果汇总**：

| Step | 命令 | 期望 |
|---|---|---|
| typecheck | `bun run typecheck` | exit=0 |
| test | `bun test --coverage ...` | ≈4944 pass / ≈138 fail（pre-existing flaky）/ 1 error；lcov.info ≈ 数 MB |
| build | `bun run build:vite` | exit=0；dist/ 产物 |

138 fail 是 pre-existing 的 Bun mock pollution 抖动，**不是我们引入的**。
要确认这一点，本地已有 baseline 对比：基线 138 fail，当前 139 fail，其中 27 vs 27 对称差异 = 测试顺序导致。
真实新引入失败 = 0。

---

## 4. 算 patch coverage（仅本次 PR 改动行的覆盖率）

GitHub 上的 Codecov 默认会自己算 patch coverage（基于 PR diff），但本地想先看真实数字。

### 4.1 提取 patch 文件清单

```bash
cd ~/work/claude-code-bast
mkdir -p coverage/patch

# 67 个改动文件
git diff origin/feat/autofix-pr..HEAD --name-only > coverage/patch/files.txt
wc -l coverage/patch/files.txt   # 期望 67

# lcov 只关心源代码文件（排除 docs/scripts/test 文件）
grep -E '\.(ts|tsx)$' coverage/patch/files.txt \
  | grep -vE '__tests__|\.test\.' \
  | grep -vE '^scripts/' \
  | grep -vE '^docs/' \
  > coverage/patch/prod-files.txt
wc -l coverage/patch/prod-files.txt   # 大约 35-40 个 prod 源文件
```

### 4.2 用 lcov 提取 patch 子集

```bash
# 把 67 文件清单转成 lcov --extract 接受的 pattern 列表
PATTERNS=$(awk '{printf "%s ", $0}' coverage/patch/prod-files.txt)

# extract 仅 patch 文件的覆盖数据
lcov --extract coverage/lcov.info $PATTERNS \
     --output-file coverage/patch/patch.info \
     --rc lcov_branch_coverage=0 \
     --ignore-errors unused 2>&1 | tail -10

# 看 summary
lcov --summary coverage/patch/patch.info
# 输出会有：
#   lines......: XX.X% (NN of MM lines)
#   functions..: XX.X% (NN of MM functions)
```

### 4.3 生成 HTML 详细报告（可选但很直观）

```bash
genhtml coverage/patch/patch.info \
        --output-directory coverage/patch/html \
        --title "feat/autofix-pr-test patch coverage" \
        --quiet

# 在 Windows 浏览器里打开
echo "file:///mnt/$(realpath coverage/patch/html/index.html | sed 's|^/mnt/c|c|;s|/|\\|g' | sed 's|^c|c:|')"
# 或简单：
# explorer.exe coverage/patch/html  # 直接调出 Windows 资源管理器
```

### 4.4 解读结果

- **lines% ≥ 80%** → 合格，可以推 PR
- **lines% 60-80%** → 可以推，PR 描述里说明哪些文件难测（UI / Ink TUI / barrel exports）
- **lines% < 60%** → 看 4.3 HTML 报告，找出未覆盖的关键 prod 文件，针对性补单测后再推

**不是 prod 代码但会拉低数字的"假阳性"**：
- `tests/mocks/toolContext.ts` — 是测试 fixture，本身不应算入 patch
- `packages/builtin-tools/src/index.ts` — 仅是 export barrel
- `src/commands/*/index.ts` — 仅注册 + USAGE 字符串，逻辑在 launch*.ts
- UI 组件：`*.tsx` 用 React Compiler，难直接单测

如果 patch coverage 数字偏低，但全是上述类型，可以在 PR 描述里说明。

---

## 5. 把结果带回 Windows（汇报用）

```bash
# 关键摘要复制到 Windows 可见的位置
{
  echo "# CI Run Summary — $(date -Iseconds)"
  echo ""
  echo "## Branch"
  git log --oneline origin/feat/autofix-pr..HEAD
  echo ""
  echo "## Test Results"
  grep -E "^ [0-9]+ (pass|fail|error)" /tmp/test-output.log | tail -4
  echo ""
  echo "## Coverage"
  lcov --summary coverage/patch/patch.info 2>&1 | grep -E "lines|functions|branches"
  echo ""
  echo "## Build"
  echo "build:vite — see dist/ in WSL ext4"
} | tee /mnt/e/Source_code/Claude-code-bast-autofix-pr-test/.wsl-ci-summary.md

# 然后回到 Windows，cat .wsl-ci-summary.md 可以看到
```

---

## 6. 故障排查

### 6.1 `bun install` 卡在 postinstall

CI 用环境变量 `CLAUDE_CODE_SKIP_CHROME_MCP_SETUP=1` 跳过 Chrome MCP setup。本地一定也要 export 它，否则 postinstall 会等几分钟。

### 6.2 `bun test --coverage` panic（Bun 1.3.12 + Windows 已知问题）

WSL 是 Linux 内核，**不会 panic**。如果在 WSL 也 panic，先 `bun upgrade` 到最新版。

### 6.3 lcov.info 里没有任何 SF: 行

可能是 bun 测试一启动就 crash。先不带 `--coverage` 跑一次 `bun test` 确认测试套件本身能跑。

### 6.4 patch coverage 显示 0%

最常见原因：`lcov --extract` 的 PATTERNS 路径跟 lcov.info 里的 SF 路径不匹配。
检查：

```bash
head -50 coverage/lcov.info | grep '^SF:'
# 看 SF 路径是绝对路径还是相对路径，调整 prod-files.txt 让它一致
```

### 6.5 跨文件系统执行很慢

确保你**在 `~/work/` 而不是 `/mnt/e/...`** 跑命令。`pwd` 应该是 `/home/USERNAME/work/claude-code-bast`，不是 `/mnt/e/...`。

### 6.6 git push 报 "no upstream"

```bash
git push -u origin feat/autofix-pr-test
```

---

## 7. 完成后做什么？

跑完拿到 patch coverage 数字后，回到 Windows 这边继续 `/prp-pr` 流程：

1. **数字 ≥ 80%**：直接推 PR `--base feat/autofix-pr`，让 GitHub Codecov 复算并 PR review。
2. **数字 60-80%**：PR 描述里写明哪些文件没测、为什么。
3. **数字 < 60%**：补关键单测（重点：`login.tsx`、`permissionValidation.ts`、`sanitize.ts`），再回到 step 3 重跑。

**不要**为了凑数硬补 UI 组件单测——Ink TUI + React Compiler 的组件本身很难有意义地测，强测会写出脆弱、跟实现细节耦合的测试。

---

## 附录 A：CI workflow 实际命令对照

`.github/workflows/ci.yml` 里的步骤（runs-on: ubuntu-latest）：

```yaml
- bun install --frozen-lockfile
  env: CLAUDE_CODE_SKIP_CHROME_MCP_SETUP=1
- bun run typecheck
- bun test --coverage --coverage-reporter lcov --coverage-dir coverage
  | grep -vE '^\s*\(pass|skip\)' | sed '/^.*\/__tests__\/.*:$/d' | cat -s
- # codecov-action upload (PR from same repo only)
- bun run build:vite
```

本地完全等价：忽略 `grep | sed | cat` 输出修饰，那只是减噪。

## 附录 B：Codecov 默认行为

仓库**没有** `codecov.yml`，Codecov 用默认配置：

- **Project coverage status check**：informational（不会 fail PR）
- **Patch coverage status check**：informational（不会 fail PR）
- 没有 hard 阈值

所以 100% 不是必须。但 patch coverage 越高，reviewer 越放心。
