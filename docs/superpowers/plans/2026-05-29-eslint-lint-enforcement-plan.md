# ESLint 流程落地实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将现有 ESLint 配置接入本地提交、PR CI 和仓库流程文档，让 lint 规则先形成可执行闭环，规则强度后续再独立收敛。

**架构：** 保留现有 `eslint.config.mjs` 规则基线，不在本计划中大规模调整 warning/error。本地提交阶段采用业界常见的 `lint-staged` 直接检查 staged 文件；CI PR 阶段新增一个很小的 diff 脚本计算相对 base 分支的增量文件并执行 `eslint --max-warnings=0`；push 到 `main` 先只跑 error 级全量 lint，避免已有 205 个 warning 阻塞流水线。

**技术栈：** pnpm、ESLint、Node.js 24、GitHub Actions、lint-staged、Git `core.hooksPath=.githooks`。

---

## 文件结构

- 修改：`package.json`
  - 新增 `lint:ci`、`lint:changed` 脚本。
  - 新增 `lint-staged` 配置。
  - 新增必要 devDependencies。
- 修改：`.githooks/pre-commit`
  - 保留禁止在 `main` 分支直接提交的保护。
  - 增加 `pnpm lint-staged`。
- 修改：`pnpm-lock.yaml`
  - 由 `pnpm install --lockfile-only` 更新锁文件。
- 创建：`scripts/lint-changed.mjs`
  - 统一筛选 `plugins/`、`packages/`、`scripts/` 下的 JS/TS 源文件。
  - 支持 `--base <ref>` 检查 PR 增量。
  - 没有匹配文件时直接成功退出。
- 修改：`.github/workflows/ci.yml`
  - 在 `verify-workspace` job 中增加 lint 步骤。
  - PR 使用增量 lint；push 到 `main` 使用全量错误级 lint。
- 修改：`docs/operations/pull-request-process.md`
  - 将 lint 门禁加入 PR 预检清单。
- 修改：`.github/PULL_REQUEST_TEMPLATE.md`
  - 在验证命令区域补充 lint 证据项。

---

### 任务 1：添加 CI 增量 lint 脚本

**文件：**
- 创建：`scripts/lint-changed.mjs`

- [x] **步骤 1：创建脚本**

写入以下实现：

```js
#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';

const SOURCE_FILE_PATTERN = /\.(?:cjs|js|mjs|ts)$/u;
const SOURCE_ROOTS = ['plugins/', 'packages/', 'scripts/'];

function parseArgs(argv) {
  const options = {
    base: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') {
      options.base = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }

  return options;
}

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function listChangedFiles(options) {
  const baseRef = options.base ?? 'origin/main';
  return runGit(['diff', '--name-only', '--diff-filter=ACMRT', `${baseRef}...HEAD`]);
}

function isLintableSource(filePath) {
  return SOURCE_ROOTS.some((root) => filePath.startsWith(root)) && SOURCE_FILE_PATTERN.test(filePath);
}

function runEslint(files) {
  if (files.length === 0) {
    console.log('No changed lintable files under plugins/, packages/, or scripts/.');
    return 0;
  }

  console.log(`Linting ${files.length} changed file(s):`);
  for (const file of files) {
    console.log(`- ${relative(process.cwd(), file)}`);
  }

  const result = spawnSync('pnpm', ['exec', 'eslint', '--max-warnings=0', ...files], {
    stdio: 'inherit',
  });

  return result.status ?? 1;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const files = listChangedFiles(options).filter(isLintableSource);
  process.exit(runEslint(files));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
```

- [x] **步骤 2：验证默认 base 增量路径**

运行：

```bash
node scripts/lint-changed.mjs
```

预期：
- 若当前分支没有 `plugins/`、`packages/` 或 `scripts/` 下 JS/TS 增量，输出 `No changed lintable files under plugins/, packages/, or scripts/.` 并退出 0。
- 若有增量文件，执行 ESLint，warning 会因 `--max-warnings=0` 使命令失败。

- [x] **步骤 3：验证指定 base 增量路径**

运行：

```bash
node scripts/lint-changed.mjs --base origin/main
```

预期：
- 使用指定 base 计算 `base...HEAD` 增量。
- 没有匹配文件时退出 0。
- 有匹配文件且存在 warning/error 时失败。

---

### 任务 2：接入 package 脚本与本地提交钩子

**文件：**
- 修改：`package.json`
- 修改：`pnpm-lock.yaml`

- [x] **步骤 1：更新根脚本**

将根 `package.json` 的 `scripts` 补充为：

```json
"lint": "eslint plugins packages scripts",
"lint:ci": "eslint plugins packages scripts --quiet",
"lint:changed": "node ./scripts/lint-changed.mjs"
```

说明：
- `lint` 保留当前全量报告能力。
- `lint:ci` 只阻断 error，避免现有 warning baseline 立即打爆 `main`。
- `lint:changed` 只用于 CI/PR 增量，对变更文件使用 `--max-warnings=0`。

- [x] **步骤 2：添加本地 hook 配置**

在根 `package.json` 增加：

```json
"lint-staged": {
  "scripts/**/*.{js,mjs,cjs,ts}": "eslint --max-warnings=0",
  "packages/**/*.{js,mjs,cjs,ts}": "eslint --max-warnings=0",
  "plugins/**/*.{js,mjs,cjs,ts}": "eslint --max-warnings=0"
}
```

说明：`lint-staged` 会自动把 staged 文件路径追加到命令后面，因此本地提交阶段不需要自写 diff 脚本。`packages/**/*` 与 `plugins/**/*` 已覆盖包内 `tests/` 和 `scripts/`，根级 `scripts/**/*` 用于覆盖仓库执行脚本和根级脚本测试。仓库已使用 `core.hooksPath=.githooks`，不要再引入 `simple-git-hooks`，避免 `.githooks/pre-commit` 与 `package.json` 生成配置形成双事实源。

- [x] **步骤 3：安装开发依赖并更新锁文件**

运行：

```bash
pnpm add -D lint-staged
```

预期：
- `package.json` 增加 `lint-staged`。
- `pnpm-lock.yaml` 更新。

- [x] **步骤 4：更新仓库 pre-commit hook**

将 `.githooks/pre-commit` 更新为：

```sh
#!/usr/bin/env sh

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"

if [ "$branch" = "main" ]; then
  echo "[pre-commit] 禁止在 main 分支直接提交，请切换到功能分支后再提交。" >&2
  exit 1
fi

pnpm lint-staged
```

说明：`.githooks/pre-commit` 是仓库 hook 的唯一事实源，`package.json` 不再配置 `prepare` 或 `simple-git-hooks`。

- [x] **步骤 5：验证本地 hook 配置**

运行：

```bash
git config --get core.hooksPath
pnpm lint-staged
```

预期：
- `core.hooksPath` 输出 `.githooks`。
- 无 staged 文件时 `pnpm lint-staged` 正常退出。

---

### 任务 3：接入 GitHub Actions

**文件：**
- 修改：`.github/workflows/ci.yml`

- [x] **步骤 1：为 PR fetch base 提供历史**

将 `verify-workspace` job 的 checkout 配置调整为：

```yaml
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          submodules: recursive
          fetch-depth: 0
```

- [x] **步骤 2：增加 lint 步骤**

在 `Install dependencies` 后、`Verify workspace` 前增加：

```yaml
      - name: Lint changed files
        if: github.event_name == 'pull_request'
        run: pnpm lint:changed --base origin/${{ github.base_ref }}

      - name: Lint errors
        if: github.event_name != 'pull_request'
        run: pnpm lint:ci
```

预期：
- PR 上检查相对 base 分支变更文件，warning 也会阻断。
- push 到 `main` 时只阻断 error，不被当前 warning baseline 影响。

---

### 任务 4：更新 PR 流程文档

**文件：**
- 修改：`docs/operations/pull-request-process.md`
- 修改：`.github/PULL_REQUEST_TEMPLATE.md`

- [x] **步骤 1：更新流程预检清单**

在 `docs/operations/pull-request-process.md` 的“规范预检清单”加入：

```markdown
- [ ] 已执行受影响 lint 校验；涉及 `plugins/`、`packages/` 或 `scripts/` 下 JS/TS 文件时，至少执行 `pnpm lint:changed`
```

- [x] **步骤 2：更新 PR 模板验证区域**

在 `.github/PULL_REQUEST_TEMPLATE.md` 的验证命令区域加入：

```markdown
pnpm lint:changed
```

如果模板已有命令列表，将其作为可勾选/可粘贴的验证证据项，不替换 `pnpm verify:workspace`。

---

### 任务 5：端到端验证

**文件：**
- 验证：`package.json`
- 验证：`scripts/lint-changed.mjs`
- 验证：`.github/workflows/ci.yml`

- [x] **步骤 1：验证 package JSON 格式**

运行：

```bash
node -e "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')); console.log('package.json ok')"
```

预期：输出 `package.json ok`。

- [x] **步骤 2：验证全量 lint error 门禁**

运行：

```bash
pnpm lint:ci
```

预期：退出 0。当前仓库只有 warning baseline，不应阻断。

- [x] **步骤 3：验证增量 lint 门禁**

运行：

```bash
pnpm lint:changed
```

预期：
- 无增量文件时退出 0。
- 有增量文件且存在 warning/error 时失败。

- [x] **步骤 4：验证工作区主流程**

运行：

```bash
pnpm verify:workspace
```

预期：保持既有主验证链路通过；lint 已由 CI 独立步骤覆盖，不改变 `verify:workspace` 的耗时与语义。

- [x] **步骤 5：检查仓库状态**

运行：

```bash
git status --short
```

预期：只包含本计划相关文件改动，以及用户已有未跟踪/未提交改动；不要回滚用户已有改动。

---

## 后续规则收敛建议

- 第一阶段：先修复 `no-unused-vars`、`prefer-const`、`no-useless-assignment`、unused disable 等低风险 warning。
- 第二阶段：将 bug 类规则从 `warn` 调整为 `error`。
- 第三阶段：对复杂度和文件长度规则建立豁免策略或模块化重构计划，再考虑 `--max-warnings=0` 全量 CI。
