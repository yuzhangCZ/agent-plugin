# 文档治理台账

**Version:** 0.2
**Date:** 2026-07-09
**Status:** Draft
**Owner:** agent-plugin maintainers
**Related:** `../rules/documentation.md`

本文是按 `docs/rules/documentation.md` 建立的文档治理台账。本文只记录现状判断、建议动作和优先级，不执行迁移、删除或状态批量调整。

## 建议动作

| 动作 | 含义 |
|---|---|
| `keep` | 保留当前位置和职责，后续只做必要元数据或引用校准 |
| `move` | 后续迁移到更合适的目录 |
| `merge` | 后续把长期价值内容合并进已有 active 文档 |
| `mark-historical` | 后续标记为 `Historical`，仅用于追溯 |
| `mark-deprecated` | 后续标记为 `Deprecated`，并指向替代文档或删除计划 |
| `delete-later` | 后续在确认无长期价值并登记后删除 |
| `merge-delete` | 长期价值合并到 active 文档后删除原文件，并保留旧路径与目标路径记录 |

## 目录族台账

| 路径 | 当前状态 | 建议状态 | 归属层级 | 建议动作 | 目标路径 | 优先级 | 备注 |
|---|---|---|---|---|---|---|---|
| `docs/rules/*.md` | Active | Active | 治理级 | keep | 原路径 | P0 | 长期规则规范目录；不新增 `README.md`。 |
| `docs/operations/*.md` | mixed / mostly active | Active | 流程级 | keep | 原路径 | P1 | 发布、AI review 等操作手册保留在根 `docs/operations/`；PR 长期治理收敛到规则目录。 |
| `docs/operations/pull-request-process.md` | no metadata | merged | 流程级 | merge-delete | `docs/rules/change-management.md` | P0 | 稳定 PR 流程和预检要求已合并，原文件删除。 |
| `docs/testing/test-layering.md` | no metadata | merged | 流程级 | merge-delete | `docs/rules/testing.md` | P0 | 测试分层和 runtime-smoke 边界已合并，原文件删除。 |
| `docs/adr/0001-plugin-migration-governance.md` | no metadata | Historical | 仓库级 | mark-historical | 原路径 | P2 | 仓库级 ADR 保留；后续补状态和元数据。 |
| `docs/migration/*.md` | no metadata | Active / Historical | 仓库级 | keep | 原路径 | P1 | 迁移索引类文档保留；后续区分 active 台账和历史记录。 |
| `docs/architecture/*.md` | Draft / Historical | mixed | 仓库级 / 包级 / 历史 | merge | 按文档归属判定 | P1 | 先分类：跨模块架构保留，包级事实下沉，历史目标态标记 Historical。 |
| `docs/design/*.md` | Draft / Historical | mixed | 插件级 / 包级 / 历史 | move | 对应 `plugins/*/docs` 或 `packages/*/docs` | P1 | 根 design 目前混有模块方案；后续按归属下沉或历史化。 |
| `docs/design/interfaces/*.md` | Active / Draft / Historical | mixed | 跨模块 / 包级 / 插件级 | merge | 按契约真源判定 | P1 | `bridge-runtime-sdk-integration.md` 可能保留为跨模块 contract；其余需逐项判定。 |
| `docs/superpowers/plans/*.md` | Historical | Historical | 历史归档 | mark-historical | 原路径或后续归档路径 | P3 | PR5 已补齐 Historical 元数据；有长期价值的结论后续沉淀，否则登记删除。 |
| `docs/superpowers/specs/*.md` | Active / Historical | mixed | 需求输入 / 历史归档 | merge | 对应模块 `product/` 或 `design/` | P3 | PR5 已完成状态分类；Active 需求后续迁入对应模块长期文档。 |
| `plugins/message-bridge/docs/**` | mostly governed | mostly Active / Draft | 插件级 | keep | 原路径 | P2 | 当前结构最完整；后续只做状态值标准化、引用校准和少量历史化。 |
| `plugins/message-bridge-openclaw/docs/**` | mixed / scattered | mixed | 插件级 | move | 标准分类目录 | P2 | PR4 已补入口并迁移 operations / quality / design / migration 明确类型文档；`topics/` 后续按长期价值处理。 |
| `packages/bridge-runtime-sdk/docs/**` | Active | Active | 包级 | keep | 原路径 | P1 | PR3 已将 active 包架构的 `Related` 收敛到 active 依赖；根目标态文档保留为延伸阅读。 |
| `packages/gateway-client/docs/**` | Active / Draft | mixed | 包级 | keep | 原路径 | P1 | PR3 已补齐协议边界设计元数据并修复绝对路径；设计草稿后续补归档策略。 |
| `packages/gateway-schema/docs/**` | Active | Active | 包级 | keep | 原路径 | P1 | PR3 已将 active 包架构的 `Related` 收敛到 active 依赖；根协议文档后续判定历史或跨模块说明。 |
| `packages/skill-plugin-cli/docs/**` | Active / Draft | mixed | 包级 | keep | 原路径 | P2 | PR6 已将输出规格和方案收敛到包级 docs，并统一主要文件命名。 |

## 根架构重点台账

| 路径 | 当前状态 | 建议状态 | 归属层级 | 建议动作 | 目标路径 | 优先级 | 备注 |
|---|---|---|---|---|---|---|---|
| `docs/architecture/bridge-refactor-architecture.md` | Historical | Historical | 仓库级历史 | mark-historical | 原路径 | P1 | PR6 已标记 Historical。 |
| `docs/architecture/bridge-refactor-migration-plan.md` | Historical | Historical | 历史归档 | mark-historical | 原路径或迁移索引 | P2 | PR6 已标记 Historical。 |
| `docs/architecture/bridge-runtime-sdk-architecture.md` | Historical | Historical | 包级 / 历史 | merge | `packages/bridge-runtime-sdk/docs/bridge-runtime-sdk-architecture.md` | P1 | PR6 已标记 Historical；包级 active 架构为当前事实源。 |
| `docs/architecture/gateway-client-architecture.md` | Historical | Historical | 包级 / 历史 | merge | `packages/gateway-client/docs/gateway-client-architecture.md` | P1 | PR6 已标记 Historical；包级 active 架构为当前事实源。 |
| `docs/architecture/gateway-schema-architecture.md` | Historical | Historical | 包级 / 历史 | merge | `packages/gateway-schema/docs/gateway-schema-architecture.md` | P1 | PR6 已标记 Historical；包级 active 架构为当前事实源。 |
| `docs/architecture/gateway-wire-v1-architecture.md` | Historical | Historical | 历史归档 | mark-historical | 原路径或迁移索引 | P1 | PR5 已统一状态值。 |
| `docs/architecture/third-party-agent-runtime-architecture.md` | Active | Active | 仓库级 | keep | 原路径 | P1 | PR6 已确认为跨模块系统级架构事实源。 |

## 根设计重点台账

| 路径 | 当前状态 | 建议状态 | 归属层级 | 建议动作 | 目标路径 | 优先级 | 备注 |
|---|---|---|---|---|---|---|---|
| `docs/design/interfaces/bridge-runtime-sdk-integration.md` | Active | Active | 跨模块 contract | keep | 原路径 | P1 | 当前仍被多处引用，可作为跨模块 contract 保留。 |
| `docs/design/interfaces/gateway-schema-event-contract.md` | Draft | Active / Historical | 包级 / 跨模块 | merge | 待判定 | P1 | 与 `packages/gateway-schema/docs` 和协议 contract 关系需确认。 |
| `docs/design/interfaces/gateway-wire-v1-event-contract.md` | Historical | Historical | 历史归档 | mark-historical | 原路径或迁移索引 | P1 | PR5 已统一状态值。 |
| `docs/design/interfaces/third-party-agent-provider-v1.md` | Draft | Active / Draft | 跨模块 contract | keep | 原路径 | P2 | 若仍定义 provider contract，可保留根级；否则迁到 SDK 包。 |
| `docs/design/qrcode-auth-session-solution.md` | Draft | Active / Historical | 包级 / 插件级 | move | `packages/skill-qrcode-auth/docs/` 或插件设计目录 | P2 | 需判定二维码授权是否属于包级事实。 |
| `docs/design/qrcode-auth-exposure-solution.md` | Draft | Active / Historical | 包级 / 插件级 | move | 待判定 | P2 | 与私有 runtime API 有跨模块引用，后续拆分事实源。 |
| `packages/skill-plugin-cli/docs/solution.md` | Draft | Draft | 包级 | keep | 原路径 | P2 | PR6 已下沉到包级 docs 并同步引用。 |
| `packages/skill-plugin-cli/docs/install-strategy-solution.md` | Draft | Draft | 包级 | keep | 原路径 | P2 | PR6 已下沉到包级 docs 并同步引用。 |
| `docs/design/message-bridge-slash-commands-*.md` | Draft | Draft | 插件级 | move | `plugins/message-bridge/docs/design/` | P2 | PR6 已下沉到 message-bridge 插件 docs 并同步引用。 |
| `docs/design/message-bridge-opencode-*.md` | Draft / Reviewing | mixed | 插件级 | move | `plugins/message-bridge/docs/design/` | P2 | OpenCode 侧方案应下沉到 message-bridge。 |
| `docs/design/gateway-wire-v1-module-design.md` | Historical | Historical | 历史归档 | mark-historical | 原路径或迁移索引 | P1 | PR5 已统一状态值。 |
| `docs/design/2026-06-11-slash-command-list-report-plan.md` | Historical | Historical | 历史归档 | mark-historical | 原路径或归档记录 | P3 | PR6 已补齐 Historical 元数据，不作为 active 事实源。 |
| `docs/design/toolsessionid-dependency-analysis.md` | Draft | Historical / Active | 分析记录 | merge | 待判定 | P2 | 结论若仍有价值，应沉淀到相关 contract。 |

## 模块重点台账

| 路径 | 当前状态 | 建议状态 | 归属层级 | 建议动作 | 目标路径 | 优先级 | 备注 |
|---|---|---|---|---|---|---|---|
| `plugins/message-bridge/docs/AGENTS.md` | Active | Active | 插件级规则 | keep | 原路径 | P1 | 已引用 `docs/rules/documentation.md`，后续只保持局部差异。 |
| `plugins/message-bridge/docs/product/prd.md` | Active | Active | 插件级 product | keep | 原路径 | P2 | PR5 已将非标准状态映射为 `Active`。 |
| `plugins/message-bridge/docs/quality/test-strategy.md` | Active | Active | 插件级 quality | keep | 原路径 | P2 | PR5 已将非标准状态映射为 `Active`。 |
| `plugins/message-bridge-openclaw/docs/README.md` | Active | Active | 插件级入口 | keep | `plugins/message-bridge-openclaw/docs/README.md` | P2 | PR4 已补齐统一入口；后续按入口分类逐步迁移根目录散落文档。 |
| `plugins/message-bridge-openclaw/docs/CONFIGURATION*.md` | Active / Deprecated | Active / Deprecated | 插件级 operations | keep | `plugins/message-bridge-openclaw/docs/operations/` | P2 | PR4 已迁移为 `operations/configuration.md` 与 `operations/configuration-en.md`，中文为 active，英文副本标记 Deprecated。 |
| `plugins/message-bridge-openclaw/docs/VALIDATION*.md` | Active / Historical | Active / Historical | 插件级 quality | keep | `plugins/message-bridge-openclaw/docs/quality/` | P2 | PR4 已迁移为 `quality/validation.md` 与 `quality/validation-audit.md`。 |
| `plugins/message-bridge-openclaw/docs/LOGGING-MATRIX.zh-CN.md` | Active | Active | 插件级 operations | keep | `plugins/message-bridge-openclaw/docs/operations/logging-matrix.md` | P2 | PR4 已迁移到 operations 并补齐元数据。 |
| `plugins/message-bridge-openclaw/docs/topics/*.md` | Historical | Historical | 插件级历史 | mark-historical | 原路径 | P3 | PR5 已统一标记为 Historical；后续如有长期价值，先沉淀到 active 文档再登记删除。 |
| `packages/skill-plugin-cli/docs/output-spec.md` | Active | Active | 包级 contract | keep | 原路径 | P2 | PR6 已迁移为 kebab-case 并同步引用。 |
| `packages/skill-plugin-cli/docs/output-spec-solution.md` | Draft | Draft / Historical | 包级 design | keep / merge | 待判定 | P2 | PR6 已迁移为 kebab-case 并同步引用；后续评估状态。 |

## 历史计划台账

| 路径 | 当前状态 | 建议状态 | 归属层级 | 建议动作 | 目标路径 | 优先级 | 备注 |
|---|---|---|---|---|---|---|---|
| `docs/superpowers/plans/*.md` | Historical | Historical | 历史归档 | mark-historical | 原路径或历史归档 | P3 | PR5 已补齐 Historical 元数据；一次性执行计划不参与当前实现决策。 |
| `docs/superpowers/specs/2026-04-02-subagent-closed-loop-repair-design.md` | Historical | Historical | 历史需求输入 | merge | 待判定 | P3 | PR5 已标记 Historical；后续判断是否已沉淀到 active 设计。 |
| `docs/superpowers/specs/2026-04-23-qrcode-auth-requirements.md` | Active | Active | 需求输入 | merge | `packages/skill-qrcode-auth/docs/` 或相关插件 `product/` | P3 | PR5 已标记 Active；后续迁入长期 product/design 事实源。 |
| `docs/superpowers/specs/2026-04-25-skill-plugin-cli.md` | Active | Active | 需求输入 | merge | `packages/skill-plugin-cli/docs/` | P3 | PR5 已标记 Active；后续迁入包级 product/design。 |
| `docs/superpowers/specs/2026-05-08-message-bridge-slash-commands-requirements.md` | Active | Active | 需求输入 | merge | `plugins/message-bridge/docs/product/` 或 design | P3 | PR5 已标记 Active；后续迁入 message-bridge 长期需求或设计文档。 |

## 明显引用风险

| 路径 | 当前状态 | 建议状态 | 归属层级 | 建议动作 | 目标路径 | 优先级 | 备注 |
|---|---|---|---|---|---|---|---|
| `../../../docs/architecture/repository-architecture-overview.md` | missing target | Historical | 仓库级 | mark-historical | `docs/architecture/third-party-agent-runtime-architecture.md` | P1 | PR2 已将 active 引用改为系统级分层架构文档。 |
| `../../message-bridge/docs/architecture/message-bridge-module-architecture.md` | missing target | Historical | 插件级 | mark-historical | `plugins/message-bridge/docs/architecture/overview.md` | P1 | PR2 已将 active 引用改为 message-bridge 架构总览。 |

## 后续批次建议

| 批次 | 目标 | 主要动作 |
|---|---|---|
| PR2 | 入口和断链修复 | 修复 missing target、补齐必要入口、不做争议性状态调整 |
| PR3 | 共享包文档治理 | 处理 `gateway-schema`、`gateway-client`、`bridge-runtime-sdk` 的根/包级关系 |
| PR4 | 插件文档治理 | 处理 `message-bridge-openclaw` 分类入口，再轻量校准 `message-bridge` |
| PR5 | 历史计划和 specs 治理 | 分别处理 plans 和 specs，沉淀长期价值后历史化或登记删除 |
