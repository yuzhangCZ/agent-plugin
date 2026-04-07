# gateway-wire-v1 架构设计

**Version:** 1.0  
**Date:** 2026-03-30  
**Status:** Frozen  
**Owner:** agent-plugin maintainers  
**Related:** [bridge-refactor-architecture.md](./bridge-refactor-architecture.md), [bridge-refactor-migration-plan.md](./bridge-refactor-migration-plan.md), [gateway-wire-v1-module-design.md](../design/gateway-wire-v1-module-design.md), [gateway-wire-v1-event-contract.md](../design/interfaces/gateway-wire-v1-event-contract.md)

## 背景

`message-bridge` 和 `message-bridge-openclaw` 过去分别维护自己的下行归一化、上行 transport 和事件投影逻辑，导致外部 wire shape 没有单一真源。`gateway-wire-v1` 的目标不是重写桥接逻辑，而是把当前 `ai-gateway` 对外协议冻结成一个独立、可测试、可迁移的协议边界。

## 参考基线

- `Reference Host SDK: @opencode-ai/plugin@1.2.15`
- `Reference Host SDK: @opencode-ai/sdk@1.2.15`

`gateway-wire-v1` 只参考上述版本下当前可观察的宿主行为，不直接依赖宿主类型作为共享真源。宿主版本升级时，必须先重新做事件字段和 transport 契约评审，再决定是否升级共享协议。

## 边界

## 当前源码结构

```text
packages/gateway-wire-v1/src/
  contract/
    literals/
    schemas/
    errors/
  application/
    ports/
    usecases/
  adapters/
    validators/
    reporters/
    facade/
  shared/
  index.ts
```

- `contract/*` 是唯一协议真源，负责字面量、canonical schema 和协议错误。
- 协议公开类型统一由 `z.output<typeof schema>` 派生，不再保留第二份手写协议 model。
- `application/*` 只编排端口与用例，不再承载协议结构定义。
- `adapters/*` 只做 projector、normalizer、validator、reporter 和 façade，不再维护第二份 canonical schema。
- 旧 `src/domain/*` 与 `src/adapters/zod/schemas/*` 兼容层已删除，后续不得回流。

### `gateway-wire-v1` 负责什么

- 冻结 `DownstreamMessage`、`GatewayToolEventV1`、`UpstreamTransportMessage`
- 校验协议输入，产出正式 wire 对象
- 统一协议异常模型
- 提供 façade 和端口接口
- 提供常量与类型守卫的共享入口

### `gateway-wire-v1` 不负责什么

- `gateway-client` 的连接、鉴权、重连、READY gating
- `bridge-mapper` 的语义映射
- `bridge-application` 的 policy、identity、capability 决策
- 宿主 raw event 的提取和投影生成
- 插件私有 legacy 兼容适配

### 分工关系

- 宿主 SDK：产生 raw event 和宿主调用能力
- runtime：负责连接生命周期与运行时编排
- mapper：把 raw event 投影成共享 wire 形状
- `gateway-wire-v1`：只校验最终对外形状，不接管 raw 提取
- 前端 / gateway：只依赖共享字段表消费协议

## 六原则落地

- `SRP`：协议模型、常量、守卫、校验器、异常报告分开。
- `OCP`：新增事件只新增显式类型、常量、validator 和文档条目，不改主流程。
- `LSP`：所有 validator 都遵守同一输入输出约定，插件 wrapper 只做错误映射。
- `ISP`：下行归一化、事件校验、transport 校验、常量、守卫拆成最小接口。
- `DIP`：消费者依赖 façade 和 port，不依赖内部实现目录。
- `LoD`：深层对象读取统一通过共享守卫函数完成，不在业务路径上散落链式穿透。

## 公开入口规则

- 外部消费者优先通过包入口 `@agent-plugin/gateway-wire-v1` 使用共享能力。
- 插件内部若需要本地包装层，应只依赖各自 `gateway-wire/*` 适配入口，不直接穿透到共享包源码内部路径。
- 测试允许为了静态契约校验直接读取 `src/contract/*`，但不得再引用已删除的 `src/domain/*` 或 `src/adapters/zod/schemas/*`。

## 协议冻结

### 下行

- `status_query`
- `invoke.chat`
- `invoke.create_session`
- `invoke.close_session`
- `invoke.abort_session`
- `invoke.permission_reply`
- `invoke.question_reply`

### 上行 transport

- `register`
- `heartbeat`
- `tool_event`
- `tool_done`
- `tool_error`
- `session_created`
- `status_response`

其中 `register.macAddress` 允许缺省。

- 当宿主能解析到可用物理网卡地址时，发送非空字符串。
- 当宿主拿不到可用 MAC 地址时，协议层不再要求伪造占位值，发送端应省略该字段。

### `tool_event.event`

`tool_event.event` 只允许使用 `gateway-wire-v1-event-contract.md` 中列出的 11 个类型：

- `message.updated`
- `message.part.updated`
- `message.part.delta`
- `message.part.removed`
- `session.status`
- `session.idle`
- `session.updated`
- `session.error`
- `permission.updated`
- `permission.asked`
- `question.asked`

这些类型必须与共享包 `SUPPORTED_TOOL_EVENT_TYPES` 保持一致。

## 异常建模

- `WireContractViolation`：正式协议不满足，作为返回值处理。
- `WireCompatibilityViolation`：插件私有 legacy adapter 映射失败，只出现在迁移期。
- `WireInvariantError`：共享包内部不变式破坏，属于实现错误。
- `WireUsageError`：消费者错误使用 façade 或端口，属于接线错误。

协议错误和业务错误不能混用。`tool_error` 是 transport 层的外部行为，不是共享协议内部异常本身。
其中 `WireViolation`、`WireErrorCode`、`WireContractViolation` 等正式协议错误统一归属 `contract/errors/*`。

## `unknown` 规则

- `unknown` 只允许出现在输入边界、宿主原始返回边界、错误对象边界。
- 非边界目录若必须保留 `unknown`，对应代码必须有中文注释说明原因和收窄位置。
- 共享协议模型中的业务字段不使用开放索引签名来兜底。

## 宿主升级流程

宿主版本升级时，按以下顺序重新评审：

1. 先对照新宿主版本重新采样 raw event。
2. 再核对 `tool_event` 字段表是否变化。
3. 再更新共享 fixture 和 validator。
4. 再更新插件投影和回归测试。
5. 所有 eval 通过后，才允许修改参考版本声明。

如果任何字段变化无法在现有 v1 里表达，必须新开版本，而不是把共享协议改回开放结构。

## AI-First Eval Matrix

| 编号 | 场景 | 通过标准 |
|---|---|---|
| E1 | 参考版本与仓库依赖一致 | 文档版本声明与 `package.json` / `pnpm-lock.yaml` 一致 |
| E2 | `tool_event` 类型集合一致 | 文档、共享常量、fixture、validator 完全一致 |
| E3 | 字段表一致 | 每个事件的文档字段与测试 fixture 一致 |
| E4 | 白名单投影 | `message.updated` 只保留冻结字段 |
| E5 | 开放索引签名 | 共享协议模型中不存在 `[key: string]: unknown` |
| E6 | 裸字面量 | 协议实现目录不再散落裸协议字符串 |
| E7 | `unknown` 规约 | 非边界目录新增 `unknown` 必须带中文说明 |
| E8 | 插件接入 | 两侧插件都通过共享 validator |
| E9 | 外部行为 | `status_query`、`tool_done`、`tool_error` 等行为不漂移 |
| E10 | 工作区门禁 | `pnpm test` 与 `pnpm verify:workspace` 通过 |
| E11 | 旧路径护栏 | 工作区代码不再引用已删除的 `src/domain/*` 与 `src/adapters/zod/schemas/*` |

## 结论

`gateway-wire-v1` 是 Phase 1 的协议真源层，只负责外部 wire 的稳定边界。它必须显式定义 `tool_event.event`，必须用可验证的字段表冻结行为，并且不能再依赖宿主 SDK 类型作为共享真源。
