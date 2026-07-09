# 变更治理规则

**Version:** 1.0
**Date:** 2026-06-18
**Status:** Active
**Owner:** agent-plugin maintainers
**Related:** `../../AGENTS.md`, `../operations/pull-request-process.md`, `../operations/local-release-cli.md`, `./documentation.md`, `./testing.md`

本文定义 `agent-plugin` 仓库的长期变更治理规则。PR、发布等详细流程继续由 `docs/operations/` 下的专项文档维护。

## 分支与 PR

1. 当前仓库默认向 `main` 提 PR；本仓库未使用 `canary` 作为日常开发基线。
2. 提 PR 时必须使用 `.github/PULL_REQUEST_TEMPLATE.md`。
3. PR 详细流程、字段要求、检查项统一维护在 `docs/operations/pull-request-process.md`。
4. PR 描述必须写明当前行为、改后行为、变化点、未变化边界、验证证据和剩余风险。
5. 只暂存本次改动，避免混入无关文件或用户未提交改动。

## Issue

1. 提 Issue 时使用 `.github/ISSUE_TEMPLATE/` 下对应表单。
2. 需求、缺陷、文档任务和支持问题应选择对应模板，避免把长期需求埋在自由文本中。

## 发布

1. 发布流程以 `docs/operations/local-release-cli.md` 和根级 `package.json` 的稳定脚本为准。
2. 发布相关变更必须声明目标包、版本来源、dry-run 结果、发布影响和回滚方式。
3. 改动 package exports、发布 manifest、bundle 产物或版本来源时，必须运行对应 build、pack 或 release plan 验证。

## 兼容性与废弃

1. 默认值变化、配置项变化、协议字段变化、错误码变化和 public API 变化必须显式声明兼容性影响。
2. 废弃字段或接口应保留清晰迁移路径；删除时必须说明删除原因和受影响范围。
3. 兼容字段必须标注语义和保留期限，不得长期形成双真源。
4. 破坏性变更必须拆成独立任务评审，不混入无关重构。

## 迁移记录

1. 文档路径迁移按 `docs/rules/documentation.md` 登记。
2. 代码或协议迁移应在对应模块文档中记录新旧入口、迁移步骤和回滚边界。
3. 历史计划、调研或草稿完成后应删除，或沉淀为长期文档；只有具备追溯价值时才转入 `migration/`。

## 冲突停机规则

出现以下任一情况时，停止自动执行并先确认：

1. 通用规则与仓库事实冲突。
2. 找不到模板、脚本或专项流程文档。
3. 改动涉及默认行为、兼容性、迁移或发布影响，但影响范围不清楚。
4. 需要在速度和规范完整性之间做取舍。
