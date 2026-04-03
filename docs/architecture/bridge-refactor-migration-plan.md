# ai-gateway Bridge 重构迁移计划

**Version:** 0.2  
**Date:** 2026-03-30  
**Status:** Draft  
**Owner:** agent-plugin maintainers  
**Related:** [bridge-refactor-architecture.md](./bridge-refactor-architecture.md), [0001-plugin-migration-governance.md](../adr/0001-plugin-migration-governance.md), [test-layering.md](../testing/test-layering.md)

## Summary

本计划采用“外部协议冻结、内部语义后移”的路线推进 bridge 重构：

1. 先冻结文档与行为基线
2. 再抽 `gateway-wire-v1`
3. 再抽 `gateway-client`
4. 再引入 `bridge-mapper`
5. 再引入 `bridge-application`
6. 再收敛 `host-adapter`
7. 最后再规划长期 host 统一层

当前 gateway 协议继续作为唯一外部协议，本轮不改 `ai-gateway` wire shape。

## Planning Rule

本文件只定义实施序列、输入输出、门禁与回滚，不提前冻结最终包名与内部中立命令名。  
`gateway-wire-v1`、`gateway-client`、`bridge-mapper`、`bridge-application`、`host-adapter`、`host-plugin` 均为当前工作名。

## Phase Matrix

| Phase | Inputs | Outputs | Exit Criteria |
|---|---|---|---|
| Phase 0 | 根级文档草案、现有协议测试、`packages/test-support` | 根级文档 + golden contract tests | 外部行为基线冻结，可重复验证 |
| Phase 1 | Phase 0 产物、两个插件现有协议定义 | `gateway-wire-v1` | 协议结构真源统一，外部行为不变 |
| Phase 2 | `gateway-wire-v1`、现有连接实现与测试 | `gateway-client` | 连接基础设施统一，外部行为不变 |
| Phase 3 | Phase 1/2 产物、插件现有 orchestrator 逻辑 | `bridge-mapper` | `wire-v1` 与内部语义开始解耦，外部协议不变 |
| Phase 4 | mapper、现有 compat / identity / capability 逻辑 | `bridge-application` | 编排与决策从插件内收敛到共享应用层 |
| Phase 5 | application、OpenCode/OpenClaw 现有宿主实现 | `host-adapter` | 宿主差异开始标准化，插件保留入口装配 |
| Phase 6 | 前序阶段结果、宿主能力差异 | 长期 host 统一层规划 | 仅完成方向规划，不启动实现 |

## Preconditions

- 根级架构文档已经明确当前阶段只冻结 `wire-v1` 与 `client` 的实施边界。
- 现有协议行为可通过共享测试和插件测试识别。
- 迁移期间允许旧插件内 orchestrator 与新共享层并存。
- 所有阶段都必须保持 `ai-gateway` 对外行为可验证。

## In Scope

- 根级架构文档与迁移计划文档的修订。
- golden contract tests 的冻结与复用。
- 共享协议层、共享连接层、后续 mapper / application / host-adapter 路线的阶段化引入。
- 两个插件的渐进迁移。

## Out of Scope

- 服务端 `ai-gateway` 代码改造。
- 本轮修改 `ai-gateway` 外部协议。
- 第一阶段之前提前冻结内部中立命令名。
- 本轮实现长期 host 统一层。
- 本轮承诺最终包名。

## External Dependencies

- 根级脚本：`pnpm build`、`pnpm test`、`pnpm verify:workspace`
- `packages/test-support` 提供的共享断言与 mock gateway
- `message-bridge` 与 `message-bridge-openclaw` 现有单测 / 集成测 / runtime 测试
- OpenCode SDK 与 OpenClaw runtime 的现有能力边界

## Phase 0: 文档与行为基线冻结

### Inputs

- 根级架构文档草案
- `packages/test-support`
- 两个插件现有协议与运行时测试

### Outputs

- 根级架构设计文档
- 根级迁移计划文档
- golden contract tests 基线

### Exit Criteria

- `status_query -> status_response` 被测试固定
- `create_session` 当前约束被测试固定
- `chat -> tool_event -> tool_done/tool_error` 被测试固定
- `session.idle` 与 compat `tool_done` 的关系被测试固定
- `permission_reply/question_reply` 的当前支持与 fail-closed 行为被测试固定

### 保持不变行为

- 两个插件的公开协议行为不变
- 现有构建、测试、发布脚本不变

### 回滚点

- 若文档或契约测试不稳定，则停留在现状，不开始共享层拆分

## Phase 1: 引入 `gateway-wire-v1`

### Inputs

- Phase 0 冻结后的协议测试
- 两个插件现有的 message types、payload shapes、normalizer、error shape

### Outputs

- 共享 `gateway-wire-v1`
- 统一的 downstream / upstream 类型定义
- 统一的 normalizer / validator
- 统一的协议错误形状

### Exit Criteria

- 共享协议层覆盖现有 golden contract tests
- 两个插件不再各自维护一份 gateway 协议类型和 downstream normalizer
- 共享协议层不承载 capability decision、compat policy、identity 业务语义

### 保持不变行为

- 现有 wire shape 不变
- `chat`、`status_query`、`permission_reply`、`question_reply` 等外部动作名不变
- 插件内现有 orchestrator 继续解释这些动作的业务含义

### 回滚点

- 插件可保留旧协议导出，必要时切回旧引用

## Phase 2: 引入 `gateway-client`

### Inputs

- `gateway-wire-v1`
- 现有 `AkSkAuth` 与 `GatewayConnection` 实现
- 现有连接层测试

### Outputs

- 共享 `gateway-client`
- 统一的建链、鉴权、心跳、重连、READY gating
- 统一的 typed send/receive 与 transport error/state events

### Exit Criteria

- 两个插件不再各自维护一份 `AkSkAuth`、`GatewayConnection`、连接状态机与重连逻辑
- `gateway-client` 不暴露 `onInvoke()`、`onStatusQuery()` 这类 bridge 语义 API
- READY 前业务消息不会被误处理
- 连接状态机外部行为不漂移

### 保持不变行为

- 插件现有 runtime / orchestrator、compat policy、identity handling 保持不变
- 外部协议行为不变

### 回滚点

- 插件内部仍可切回旧连接层，不阻断测试通过

## Phase 3: 引入 `bridge-mapper`

### Inputs

- `gateway-wire-v1`
- `gateway-client`
- 插件现有对 `chat`、`status_query` 与上行事件投影的解释逻辑

### Outputs

- `wire-v1 <-> bridge semantics` 的共享映射层
- 下行动作到内部命令的映射
- 上行 bridge 事件到 `wire-v1` 的投影

### Exit Criteria

- `chat`、`status_query`、上行事件投影开始通过 mapper 进入内部语义
- 外部 `ai-gateway` 协议不变
- mapper 只做转换，不做宿主执行、不做 capability 决策

### 保持不变行为

- 插件仍可保留现有 orchestrator 作为业务执行主体
- `tool_done` compat 与 `session.idle` fallback 的最终决策尚未共享化

### 回滚点

- 单个动作可回退到插件内旧解释路径

## Phase 4: 引入 `bridge-application`

### Inputs

- mapper
- 插件现有 compat / identity / capability 逻辑
- 现有 action / runtime 回归测试

### Outputs

- 共享 `bridge-application`
- use case、policy、identity model、capability decision
- compat policy，包括 `tool_done` 与 `session.idle` 相关共享决策

### Exit Criteria

- identity 与 capability 的决策从插件内 orchestrator 收敛到应用层
- unsupported / fail-closed 由共享应用层统一决策
- `tool_done` compat、`session.idle` fallback 的共享决策稳定

### 保持不变行为

- 外部 `ai-gateway` 协议不变
- OpenCode / OpenClaw 宿主差异仍通过各自实现承接

### 回滚点

- 单个 use case 可回退到插件内旧实现

## Phase 5: 收敛 `host-adapter`

### Inputs

- application
- OpenCode / OpenClaw 现有宿主实现
- 插件现有 host-specific tests

### Outputs

- 宿主能力的共享 adapter 边界
- OpenCode / OpenClaw 对共享应用层的标准化接入

### Exit Criteria

- 宿主实现差异开始通过 adapter 边界承接
- 插件只保留入口装配、配置与少量宿主私有薄逻辑
- `sessionKey` 仍只留在 OpenClaw 私有实现内

### 保持不变行为

- 外部 `ai-gateway` 协议不变
- 插件公开身份、安装路径、配置键不变

### 回滚点

- 单个宿主可回退到插件内旧适配路径

## Phase 6: 长期 host 统一层规划

### Inputs

- 前序阶段收敛结果
- 宿主能力差异与复用观察

### Outputs

- 长期 host 统一层的输入边界与方向文档

### Exit Criteria

- 仅完成方向规划，不要求实现
- 不冻结最终命名和包结构

### 保持不变行为

- 当前桥接链路不引入新的运行时实现

### 回滚点

- 若规划未收敛，则不进入实现阶段

## Acceptance Gates

- Phase 0 必须冻结当前外部行为基线
- Phase 1 和 Phase 2 的验收只归属于共享基础设施，不归属于未来 `mapper` 或 `application`
- Phase 3 到 Phase 5 才逐步把语义转换、编排决策、宿主适配的所有权迁移到共享层
- 全量验证优先使用：
  - `pnpm test`
  - `pnpm verify:workspace`
  - 必要时补跑 `pnpm run test:openclaw:runtime`

## Verification Map

| Contract / Behavior | 当前阶段责任归属 | 共享层责任归属起点 | Verification |
|---|---|---|---|
| `status_query -> status_response` | 插件现有 orchestrator | Phase 3 之后逐步迁入 `bridge-application` | `pnpm test` + 共享断言 |
| `create_session` 当前约束 | 插件现有 orchestrator | Phase 3 之后逐步迁入 `bridge-application` | runtime 回归 + 共享断言 |
| `chat -> tool_event -> tool_done/tool_error` | 插件现有 orchestrator | Phase 3 之后逐步迁入 `bridge-application` | unit/integration/runtime 测试 |
| `session.idle` 与 compat `tool_done` | 插件现有 compat policy | Phase 4 | `runtime-protocol` 回归 |
| gateway message types / normalizer / validator | Phase 1 | Phase 1 | golden contract tests |
| `AkSkAuth` / `GatewayConnection` / READY gating | Phase 2 | Phase 2 | connection tests + 回归测试 |
| unsupported / fail-closed 行为 | 插件现有 orchestrator | Phase 4 | capability 回归测试 |
| OpenCode / OpenClaw 宿主能力实现 | 插件现有实现 | Phase 5 | 插件 unit/integration/runtime 测试 |

## Rollback Strategy

- 新共享层先引入，旧插件实现并存
- 按阶段和能力粒度切流，避免一次性重切
- 如果任一阶段未过门禁，停止进入下一阶段
- 保留兼容导出或旧实现分支，直到验证通过后再清理

## Risks / Dependencies

- 如果第一阶段把 capability、identity、compat 提前塞进共享层，会重新制造耦合
- 如果 `gateway-client` 暴露带 bridge 语义的 API，后续再引入 mapper 会变成破坏式重构
- 如果 golden contract tests 覆盖不足，Phase 1/2 的基础设施收敛会引入行为漂移
- 如果插件内现有 orchestrator 责任未明确保留，阶段边界会再次模糊

## Assumptions

- 本轮只修订文档，不执行代码改动
- `gateway-wire-v1`、`gateway-client`、`bridge-mapper`、`bridge-application`、`host-adapter`、`host-plugin` 都是工作名
- 现有 `ai-gateway` 协议继续作为唯一外部协议
- 第一阶段之前不提前冻结内部中立命令名
- `chat` 继续作为 `wire-v1` 外部动作名存在
