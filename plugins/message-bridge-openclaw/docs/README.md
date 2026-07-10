# message-bridge-openclaw 文档入口

**Version:** 0.1
**Date:** 2026-06-18
**Status:** Active
**Owner:** message-bridge-openclaw maintainers
**Related:** `../../../docs/rules/documentation.md`, `./architecture/message-bridge-openclaw-module-architecture.md`

本文是 `plugins/message-bridge-openclaw/docs/` 的文档入口。该目录只保存 OpenClaw 侧插件的长期文档；共享协议、共享 runtime 和跨模块架构应引用根 `docs/` 或对应 `packages/*/docs/` 的事实源，不在本目录重复定义。

## 当前文档

| 路径 | 类型 | 当前用途 |
|---|---|---|
| `architecture/message-bridge-openclaw-module-architecture.md` | architecture | OpenClaw 侧插件当前模块架构事实源 |
| `operations/configuration.md` | operations | 当前配置说明事实源 |
| `operations/configuration-en.md` | operations | 英文配置副本，已标记 Deprecated |
| `operations/usage.md` | operations | 使用、安装和联调说明 |
| `operations/logging-matrix.md` | operations | 日志字段和排查矩阵 |
| `quality/validation.md` | quality | 阶段验证手册 |
| `quality/validation-audit.md` | quality | 历史验证审计记录 |
| `quality/protocol-compat-matrix.md` | quality | 协议兼容矩阵 |
| `design/protocol-sequence.md` | design | 历史协议时序视图 |
| `migration/implementation-plan.md` | migration | 历史阶段性实施计划 |
| `topics/*.md` | historical | 历史专题需求、方案或问题记录，不作为当前行为事实源 |

## 目标分类

后续新增或迁移文档应按以下目录归档：

| 目录 | 用途 |
|---|---|
| `architecture/` | 模块边界、运行时分层、关键数据流 |
| `design/` | 实施方案、协议时序、兼容方案 |
| `design/interfaces/` | 插件级接口、配置契约、宿主适配契约 |
| `quality/` | 验证策略、验证报告、兼容矩阵 |
| `operations/` | 配置、使用、日志、发布和排障说明 |
| `migration/` | 路径迁移映射、历史计划归档和删除登记 |

## 治理规则

1. 全仓文档规则以 `../../../docs/rules/documentation.md` 为准。
2. 本目录没有独立 `AGENTS.md` 时，执行根 `AGENTS.md` 和全仓文档规则。
3. 新增 active 文档应包含 `Version`、`Date`、`Status`、`Owner`、`Related`。
4. 当前混排在根目录的历史文件不在本入口中直接移动；迁移前必须先登记到仓库文档治理台账。
5. 跨模块引用必须说明引用目的，不能替代本插件自己的事实源。
