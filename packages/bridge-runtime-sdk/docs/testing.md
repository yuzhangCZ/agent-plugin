# bridge-runtime-sdk 测试运行说明

**Version:** 1.0
**Date:** 2026-07-13
**Status:** Active
**Owner:** bridge-runtime-sdk maintainers

本包测试运行时固定为 Node.js `node:test`。不要用 Bun for Visual Studio Code 作为本包测试 runner；Bun 插件可以保留安装，但本包依赖 Node 参数：

- `--import ./scripts/register-test-alias-loader.mjs`
- `--experimental-strip-types`
- `--test`
- `--test-name-pattern`（单 case 运行时）

## CLI

运行全量包内测试：

```bash
pnpm --dir packages/bridge-runtime-sdk test
```

运行单个文件：

```bash
pnpm --dir packages/bridge-runtime-sdk test -- tests/unit/application/lifecycle/RuntimeLifecycleService.test.ts
```

运行单个测试用例：

```bash
pnpm --dir packages/bridge-runtime-sdk test -- --test-name-pattern "RuntimeLifecycleService starts core" tests/unit/application/lifecycle/RuntimeLifecycleService.test.ts
```

也可以使用单 case 快捷脚本：

```bash
pnpm --dir packages/bridge-runtime-sdk run test:case -- "RuntimeLifecycleService starts core" tests/unit/application/lifecycle/RuntimeLifecycleService.test.ts
```

## VSCode

仓库根目录提供 `.vscode/settings.json`，用于 `connor4312.nodejs-testing`：

- 只扫描 `packages/bridge-runtime-sdk/tests`。
- 识别 `**/*.test.ts`。
- 运行测试前执行 `packages/bridge-runtime-sdk/scripts/prepare-workspace-deps.mjs`。
- 对 TypeScript 测试进程传入 `@/...` alias loader 和 `--experimental-strip-types`。

如果安装插件后侧边栏没有出现测试按钮，执行 VSCode 的 `Developer: Reload Window`，或在 Testing 侧边栏点击刷新测试。

仓库根目录提供 `.vscode/tasks.json`：

- `bridge-runtime-sdk: test current file`
- `bridge-runtime-sdk: test selected case`

运行单 case 时，先选中完整 `test(...)` 名称字符串，再执行 `bridge-runtime-sdk: test selected case`。

仓库根目录也提供 `.vscode/launch.json`：

- `bridge-runtime-sdk: debug current test file`
- `bridge-runtime-sdk: debug selected test case`

这两组配置都直接使用 Node runner，并复用本包的 `@/...` alias loader。
