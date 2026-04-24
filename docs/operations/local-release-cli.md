# 本地发布 CLI

本仓库为三个工作区包提供统一的本地发布 CLI：

- `@wecode/skill-qrcode-auth`
- `@wecode/skill-opencode-plugin`
- `@wecode/skill-openclaw-plugin`

这个 CLI 面向维护者，适用于在开发机上完成构建、校验、发布，以及生成本地 release git 元数据，而不依赖 GitHub release workflow。

## 入口

```bash
pnpm release:local -- --target <skill-qrcode-auth|message-bridge|message-bridge-openclaw|dual> ...
pnpm release:plan -- --target <skill-qrcode-auth|message-bridge|message-bridge-openclaw|dual> ...
```

- `release:local` 执行完整发布流程。
- `release:plan` 等价于默认开启 `--dry-run` 的同一套 CLI。
- `verify:release-local:e2e` 用于运行隔离的假私仓端到端验证。

## 运行前检查

在执行前，确认以下条件成立：

- 已执行 `pnpm install --frozen-lockfile`
- 目标 npm registry 已通过 `.npmrc` 或环境变量配置完成
- `npm whoami` 在目标 registry 上能成功返回
- 目标版本号已经明确
- 已准备本次官方发布要注入的默认网关地址
- 已理解 `npm publish` 和 git 操作不是原子事务

推荐先执行：

```bash
pnpm install --frozen-lockfile
npm config get registry
npm whoami
```

如果你使用的是类似 `@wecode:registry=...` 的 scope 私仓配置，CLI 会优先解析该 scope 对应的真实 registry，并对这个 registry 做认证检查，而不是只看默认 registry。

## 当前三个包的发布差异

CLI 对外接口统一，但三个包当前的发布根目录不同：

- `skill-qrcode-auth` 从 `packages/skill-qrcode-auth` 发布
- `message-bridge` 从 `plugins/message-bridge` 发布
- `message-bridge-openclaw` 从 `plugins/message-bridge-openclaw/bundle` 发布

这是当前仓库状态下的有意设计。后续统一为源码根发包的重构问题记录在 [openclaw-root-publish-refactor-issue.md](./openclaw-root-publish-refactor-issue.md)。

## 版本输入要求

单包发布必须二选一：

```bash
--version <semver>
--bump <patch|minor|major|prerelease>
```

双包发布必须满足以下两种形式之一：

```bash
--bump <patch|minor|major|prerelease>
```

或：

```bash
--bridge-version <semver> --openclaw-version <semver>
```

## 参数说明

### 目标选择

- `--target message-bridge`
- `--target message-bridge-openclaw`
- `--target skill-qrcode-auth`
- `--target dual`

### 版本选择

- `--version <semver>`
- `--bridge-version <semver>`
- `--openclaw-version <semver>`
- `--default-gateway-url <ws://...|wss://...>`
- `--bump patch|minor|major|prerelease`
- `--preid <alpha|beta|rc>`  
  默认值：`beta`
- `--release stable|prerelease`  
  可选，用于显式校验 release 类型

### 执行控制

- `--dry-run`
- `--skip-publish`
- `--skip-git`
- `--push`
- `--allow-dirty`

非法组合：

- `--skip-publish --push`

## 默认行为

在不额外覆盖参数时：

- 会执行 `npm publish`
- 会创建本地 git commit 和 git tag
- 不会推送远程
- 只有显式传 `--push` 才会把当前分支和新 tag 推到 `origin`
- `--skip-publish` 不能和 `--push` 一起使用
- `message-bridge` / `message-bridge-openclaw` 的官方发布路径必须显式传 `--default-gateway-url`
- 该值会作为构建期环境变量 `MB_DEFAULT_GATEWAY_URL` 注入到需要该配置的 build / verify / publish 子进程

默认安全模型如下：

1. 发布到 npm
2. 创建本地 commit 和 tag
3. 如有需要，再显式推送远程

如果 `npm publish` 成功而后续 git 步骤失败，不要重复发布同一个版本。

## 正式发布示例

给 `skill-qrcode-auth` 发布一个显式版本：

```bash
pnpm release:local -- --target skill-qrcode-auth --version 0.1.0
```

给 `message-bridge` 做一次 patch 版本发布：

```bash
pnpm release:local -- --target message-bridge --bump patch --default-gateway-url wss://gateway.example.com/ws/agent
```

给 `message-bridge-openclaw` 发布一个显式版本，并且只保留本地结果：

```bash
pnpm release:local -- --target message-bridge-openclaw --version 0.2.0 --default-gateway-url wss://gateway.example.com/ws/agent
```

仅预览一次正式发布计划，不改 npm，也不改 git：

```bash
pnpm release:plan -- --target message-bridge --version 1.2.0 --default-gateway-url wss://gateway.example.com/ws/agent
```

## 预发布示例

给 `message-bridge` 生成下一个 beta 版本：

```bash
pnpm release:local -- --target message-bridge --bump prerelease --preid beta --default-gateway-url wss://gateway.example.com/ws/agent
```

给 `message-bridge-openclaw` 发布一个显式 RC 版本：

```bash
pnpm release:local -- --target message-bridge-openclaw --version 0.2.0-rc.1 --release prerelease --preid rc --default-gateway-url wss://gateway.example.com/ws/agent
```

## 双包发布示例

两个包按同一种 bump 规则一起发版：

```bash
pnpm release:local -- --target dual --bump patch --default-gateway-url wss://gateway.example.com/ws/agent
```

两个包分别指定版本一起发布：

```bash
pnpm release:local -- --target dual --bridge-version 1.3.0 --openclaw-version 0.2.0 --default-gateway-url wss://gateway.example.com/ws/agent
```

`dual` 模式不是原子事务。如果第一个包发布成功、第二个包失败，第一个版本可能已经进入 registry。

## 构建、校验与发布流程

对每个 target，CLI 会依次执行：

1. 解析目标版本和 dist-tag
2. 执行依赖存在性检查
3. 对需要网关注入的 target 校验 `--default-gateway-url` 是否存在且为合法 `ws://` / `wss://`
4. 改写目标包版本
5. 执行 target 对应的构建步骤
6. 执行 target 对应的 `verify:release`
7. 评估 publish readiness contract
8. 当 readiness 为 `true` 且未指定 `--skip-publish` 时执行发布
9. 当未指定 `--skip-git` 时创建本地 commit 和 tag
10. 当显式指定 `--push` 时推送分支和 tag

publish readiness 是进入不可逆 `npm publish` 之前的最后一道门禁。CLI 会输出：

- `releaseReady`
- `resolvedVersion`
- `resolvedDistTag`
- `resolvedPublishRoot`
- `executedChecks`

## 常见失败场景与恢复

### 工作区不干净

默认情况下，CLI 会拒绝在脏工作区里执行。

只有在你明确知道要保留哪些本地改动、并且不希望它们进入 release commit 时，才使用 `--allow-dirty`。

### Tag 已存在

如果目标 release tag 在本地已经存在，CLI 会在任何构建或发布动作前直接停止。

### Registry 或认证失败

如果 `npm config get registry` 或 `npm whoami` 指向错误目标，CLI 会在发布前失败。

### 默认网关地址缺失或非法

- `message-bridge` / `message-bridge-openclaw` 未传 `--default-gateway-url` 时，CLI 会在首次 build 前失败
- 对这些 target 传入非 `ws://` / `wss://` 地址时，CLI 会在首次 build 前失败
- `skill-qrcode-auth` 不要求该参数

### 发布成功但 Git 失败

这是最重要的恢复场景：

- 包可能已经成功发布
- 本地 commit 和 tag 可能缺失或不完整
- 不要重复发布相同版本
- 先确认 registry 状态，再手动修复 git 状态

### 双包发布部分成功

如果第一个包已发布、第二个包失败：

- 视第一个包的版本已经被占用
- 不要盲目重跑相同版本
- 先确认 registry 中实际内容，再决定补 git 或补第二个包

## 脚本跨平台约定

维护发布或 smoke 脚本时，遵循以下约定：

- 需要隔离临时 home 目录的脚本，必须同时设置 `HOME`、`USERPROFILE`、`XDG_CONFIG_HOME`
- 不要只覆写 `HOME`，否则 Windows 或继承了 `XDG_CONFIG_HOME` 的环境中可能读到宿主配置
- 需要同时支持“直接执行”和“被 import”的 ESM 脚本，必须先用 `fileURLToPath(import.meta.url)` 转成本地路径，再与 `path.resolve(process.argv[1])` 比较
- 不要直接把 `import.meta.url` 和手工拼接的 `file://...` 字符串做比较

## 端到端验证 Harness

如果你要在不触碰真实私仓的前提下验证完整本地发布流程，使用：

```bash
pnpm verify:release-local:e2e
```

默认行为：

- 把当前工作区复制到临时隔离目录
- 初始化临时 git 仓库和本地 bare remote
- 启动临时假 npm registry
- 对两个包执行真实 `npm publish`
- 验证 prerelease dist-tag、dual 发布行为、失败恢复、`--push`，以及 tarball 内默认 `gateway.url` 注入结果

可选环境变量：

- `RELEASE_E2E_REGISTRY_URL`
- `RELEASE_E2E_NPM_TOKEN`
- `RELEASE_E2E_REMOTE_PATH`
- `RELEASE_E2E_KEEP_TMP=1`

如果没有传 `RELEASE_E2E_REGISTRY_URL`，harness 会自行启动临时 Verdaccio。

## 相关文档

- [README.md](../../README.md)
- [plugins/message-bridge/docs/operations/npm-publish-guide.md](../../plugins/message-bridge/docs/operations/npm-publish-guide.md)
- [openclaw-root-publish-refactor-issue.md](./openclaw-root-publish-refactor-issue.md)
