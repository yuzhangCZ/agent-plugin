# Issue 草案：将 `message-bridge-openclaw` 改为源码根发包

## 摘要

将 `plugins/message-bridge-openclaw` 的发布流程从当前的 `bundle/` 目录发布，重构为直接从源码包根发布。

## 背景

- 当前发布路径多了一层 `bundle/` 包装。
- 从 `bundle/` 发布会让真实发布物和源码树结构产生分叉。
- 如果能直接从源码根发布，pack 校验、发布脚本和后续演进都会更容易理解和维护。

## 计划变更

- 如果运行时或本地安装流程仍然需要，继续保留 `bundle` 生成逻辑。
- npm 发布根从 `plugins/message-bridge-openclaw/bundle` 切换为 `plugins/message-bridge-openclaw`。
- 发布 tarball 改为由源码根的 `files` 白名单决定，而不是由 `bundle/` 目录决定。
- 同步更新 release workflow、本地 release 文档，以及所有仍然假设 `bundle/` 是发布根的 pack 校验逻辑。

## 非目标

- 不修改运行时插件 identity。
- 不修改 OpenClaw 的配置 key、channel id 或安装路径语义。
- 不重新设计 release tag 命名规则。

## 风险与迁移说明

- 重构后仍然必须保证 tarball 保持最小化，不能因为改成源码根发布就把多余文件带进包里。
- 本地发布脚本和 CI 发布脚本必须同步迁移，避免再次出现“本地一套、CI 一套”的发布根分叉。
- pack 校验仍然要继续拦截 `docs/`、`dist/` 和 sourcemap 进入最终发布包。

## 验收标准

- 在源码根执行 `npm pack` 和 `npm publish` 可以正常工作。
- 最终发布 tarball 只包含预期的运行时文件。
- release workflow 不再依赖 `bundle/` 作为 publish 目录。
- 相关文档和失败恢复说明同步更新为源码根发包路径。
