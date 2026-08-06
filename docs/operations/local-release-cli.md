# 本地发布 CLI

本仓库为五个工作区包提供统一的本地发布 CLI：

- `@wecode/skill-qrcode-auth`
- `@wecode/skill-plugin-cli`
- `@wecode/skill-opencode-plugin`
- `@wecode/skill-openclaw-plugin`
- `@wecode/bridge-runtime-sdk`

这个 CLI 面向维护者，适用于在开发机上完成构建、校验和发布。CLI 不创建 git commit、不创建 git tag、不执行 git push。

## 入口

```bash
pnpm release:local -- --target <skill-qrcode-auth|skill-plugin-cli|message-bridge|message-bridge-openclaw|bridge-runtime-sdk> --channel <alpha|beta|release> ...
pnpm release:plan -- --target <skill-qrcode-auth|skill-plugin-cli|message-bridge|message-bridge-openclaw|bridge-runtime-sdk> --channel <alpha|beta|release> ...
```

- `release:local` 执行完整发布流程。
- `release:plan` 等价于默认开启 `--dry-run` 的同一套 CLI。
- `verify:release-local:e2e` 用于运行隔离的假私仓端到端验证。

## 运行前检查

在执行前，确认以下条件成立：

- 已执行 `pnpm install --frozen-lockfile`
- 目标 npm registry 已通过 `.npmrc` 或环境变量配置完成
- `npm whoami` 在目标 registry 上能成功返回
- 目标包 `package.json.version` 是稳定 SemVer 基础版本 `x.y.z`
- 已准备本次官方发布要注入的默认网关地址
- 已理解 `npm publish` 成功后同版本不能重复发布

推荐先执行：

```bash
pnpm install --frozen-lockfile
npm config get registry
npm whoami
```

如果你使用的是类似 `@wecode:registry=...` 的 scope 私仓配置，CLI 会优先解析该 scope 对应的真实 registry，并对这个 registry 做认证检查，而不是只看默认 registry。

## 发布目标

- `skill-qrcode-auth` 从 `packages/skill-qrcode-auth` 发布
- `skill-plugin-cli` 先基于 `packages/skill-plugin-cli` 构建发布专用 tarball，再从 `.tmp/release-pack/*.tgz` 发布
- `message-bridge` 从 `plugins/message-bridge` 发布
- `message-bridge-openclaw` 从 `plugins/message-bridge-openclaw/bundle` 发布
- `bridge-runtime-sdk` 先基于 `packages/bridge-runtime-sdk` 构建并打包，再从 `.tmp/release-pack/*.tgz` 发布

构建差异：

- `skill-qrcode-auth`、`skill-plugin-cli` 不要求注入默认网关地址
- `message-bridge`、`message-bridge-openclaw`、`bridge-runtime-sdk` 的官方发布路径都要求注入默认网关地址
- `bridge-runtime-sdk` 默认 `build` 就会输出压缩混淆后的 `dist/index.js`
- `bridge-runtime-sdk` 在本地 release CLI 中会先生成 tarball，再发布该 tarball，避免 publish 阶段依赖切换到包目录
- `bridge-runtime-sdk` 如需本地排查可读产物，需要显式使用包内 `pnpm run build:dev`

## 通道与版本规则

`--channel` 必填，只接受：

- `alpha`
- `beta`
- `release`

基础版本只接受稳定 SemVer `x.y.z`：

- 默认读取目标包 `package.json.version`
- 可用 `--version <x.y.z>` 覆盖基础版本
- `package.json.version` 和 `--version` 都不能带 `-alpha`、`-beta`、`-rc` 等 prerelease 后缀

目标版本和 dist-tag 规则：

| channel | baseVersion | targetVersion | dist-tag |
| --- | --- | --- | --- |
| `alpha` | `1.2.3` | `1.2.3-alpha.<yyyyMMddHHmmss>` | `alpha` |
| `beta` | `1.2.3` | `1.2.3-beta.<yyyyMMddHHmmss>` | `beta` |
| `release` | `1.2.3` | `1.2.3` | `latest` |

时间戳固定按 `Asia/Shanghai` 时区生成，格式为 `yyyyMMddHHmmss`。

`--bump`、`--preid`、`--release`、`--target dual`、`--bridge-version`、`--openclaw-version` 已移除，不再兼容。

## 参数说明

### 目标选择

- `--target message-bridge`
- `--target message-bridge-openclaw`
- `--target skill-qrcode-auth`
- `--target skill-plugin-cli`
- `--target bridge-runtime-sdk`

### 版本选择

- `--channel alpha|beta|release`
- `--version <x.y.z>`
- `--default-gateway-url <ws://...|wss://...>`

### 执行控制

- `--dry-run`
- `--skip-publish`
- `--skip-verify`
- `--install-deps`
- `--install-deps-update-lockfile`

## 默认行为

在不额外覆盖参数时：

- 会执行 `npm publish`
- 会执行依赖检查、build、`verify:release` 和 publish readiness
- 不会执行 `git add`、`git commit`、`git tag`、`git push`
- 仍会检查目标 release tag 是否已存在；如果 `tagPrefix + targetVersion` 已存在，会在构建或发布前阻断
- 对于要求构建期默认网关地址的 target，官方发布路径必须显式传 `--default-gateway-url`
- 该值会作为构建期环境变量 `MB_DEFAULT_GATEWAY_URL` 注入到需要该配置的 build / verify / publish 子进程

当前需要 `--default-gateway-url` 的 target：

- `message-bridge`
- `message-bridge-openclaw`
- `bridge-runtime-sdk`

## 示例

发布 alpha：

```bash
pnpm release:local -- --target message-bridge --channel alpha --default-gateway-url wss://gateway.example.com/ws/agent
```

发布 beta：

```bash
pnpm release:local -- --target message-bridge --channel beta --default-gateway-url wss://gateway.example.com/ws/agent
```

发布稳定版本：

```bash
pnpm release:local -- --target message-bridge --channel release --default-gateway-url wss://gateway.example.com/ws/agent
```

覆盖基础版本并发布 alpha：

```bash
pnpm release:local -- --target message-bridge --channel alpha --version 1.2.4 --default-gateway-url wss://gateway.example.com/ws/agent
```

只预览发布计划：

```bash
pnpm release:plan -- --target bridge-runtime-sdk --channel beta --version 0.1.0 --default-gateway-url wss://gateway.example.com/ws/agent
```

无需网关注入的包：

```bash
pnpm release:local -- --target skill-plugin-cli --channel release --version 0.1.0
```

## 构建、校验与发布流程

对每个 target，CLI 会依次执行：

1. 解析 `baseVersion`、`targetVersion` 和 dist-tag
2. 检查目标 release tag 是否已存在
3. 执行依赖存在性检查
4. 对需要网关注入的 target 校验 `--default-gateway-url` 是否存在且为合法 `ws://` / `wss://`
5. 临时改写目标包版本为 `targetVersion`
6. 执行 target 对应的构建步骤
7. 执行 target 对应的 `verify:release`
8. 评估 publish readiness contract
9. 当 readiness 为 `true` 且未指定 `--skip-publish` 时执行发布

readiness 必须在临时写入 `targetVersion` 之后执行，确保 `manifest-version-match` 校验的是实际发布版本。npm publish、tarball 文件名、readiness 输出和发布计划都使用 `targetVersion`。

其中 `bridge-runtime-sdk` 的官方 release 路径有额外约束：

- build 步骤默认执行 `packages/bridge-runtime-sdk` 下的混淆构建
- `verify:release` 会验证压缩混淆后的 JS 产物、声明产物和 tarball 内容
- 日常开发如果只想生成便于排查的可读产物，应显式使用包内 `pnpm run build:dev`

publish readiness 是进入不可逆 `npm publish` 之前的最后一道门禁。CLI 会输出：

- `releaseReady`
- `resolvedVersion`
- `resolvedDistTag`
- `resolvedPublishRoot`
- `executedChecks`

## 恢复语义

### Publish 前失败

如果失败发生在 publish 尝试前，CLI 会恢复目标包原始 `package.json.version`。

### Publish 已尝试或成功后失败

如果 publish 已经尝试或成功，CLI 不主动恢复版本，避免本地状态与 registry 状态不一致。先确认 registry 中实际内容，再决定如何修复本地状态或重试新版本。

### Tag 已存在

如果目标 release tag 在本地已经存在，CLI 会在任何构建或发布动作前直接停止。

### Registry 或认证失败

如果 `npm config get registry` 或 `npm whoami` 指向错误目标，CLI 会在发布前失败。

### 默认网关地址缺失或非法

- `message-bridge` / `message-bridge-openclaw` / `bridge-runtime-sdk` 未传 `--default-gateway-url` 时，CLI 会在首次 build 前失败
- 对这些 target 传入非 `ws://` / `wss://` 地址时，CLI 会在首次 build 前失败
- `skill-qrcode-auth`、`skill-plugin-cli` 不要求该参数

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
- 初始化临时 git 仓库
- 启动临时假 npm registry
- 执行真实 `npm publish`
- 验证 beta / release dist-tag、失败恢复，以及 tarball 内默认 `gateway.url` 注入结果

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
