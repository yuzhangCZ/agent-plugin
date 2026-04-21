# bridge-runtime-sdk 首版实施方案

> **面向 AI 代理的工作者：** 如按本文实施，优先把本文视为“首版落地决策与执行边界”真源；架构边界仍以 `docs/architecture/bridge-runtime-sdk-architecture.md` 为准，对外接口仍以 `docs/design/interfaces/third-party-agent-provider-v2.md` 为准。

**目标：** 在 `packages/bridge-runtime-sdk` 落地首版 runtime SDK，使其承接统一的命令编排、上行投影与状态协调能力；首个接入方为 `message-bridge-openclaw`，现有 `message-bridge` 主 runtime 不在本轮迁移范围内。

**架构立场：**
- `bridge-runtime-sdk` 只负责 runtime 语义、application orchestration 与 protocol-agnostic core。
- `bridge-runtime-sdk` 不内置具体 agent/provider 集成适配器；OpenClaw 等宿主适配逻辑归属各自插件。
- SDK 对外可先提供方法式 `ThirdPartyAgentProvider`，但 core 内部只依赖显式时序 contract，不直接依赖隐含时序的方法语义。
- `ProviderFact` 是有序事实流；`SkillProviderEvent` 不是 `ProviderFact` 的一一映射，部分 lifecycle facts 只驱动 runtime 状态。
- `gateway-schema` 继续作为协议层真源，`third-party-agent-provider-v2.md` 继续作为对外 Provider 契约真源。

**技术栈：** TypeScript、Node.js test runner、workspace packages、`@agent-plugin/gateway-schema`、`@agent-plugin/gateway-client`

---

## 1. 背景与非目标

当前仓库已有 runtime 架构文档与 Provider 对外接口文档，但尚缺一份首版可执行实施方案，用于承接目录分层、模块落位、迁移顺序和测试矩阵等阶段性决策。

本方案的非目标：

- 本轮不改造 `plugins/message-bridge` 现有主 runtime
- 本轮不在 SDK 内提供 legacy/provider integration adapter
- 本轮不把实现阶段类名、测试命令和复选框任务写回架构文档
- 本轮不重新定义 `GatewayDownstreamBusinessRequest`、`GatewayUplinkBusinessMessage` 或 Provider v2 字段真源
- 本轮不为 `session.error` 赋予稳定运行时语义；其正式采纳需后续单独设计

---

## 2. 包与目录设计

首版在 `packages/bridge-runtime-sdk` 下采用分层目录：

```text
src/
  domain/
  application/
  adapters/
  infrastructure/
  index.ts
```

各层职责如下：

- `domain`：`RuntimeCommand`、运行时状态模型、错误分类、核心不变量
- `application`：7 个 UseCase、`RuntimeCommandDispatcher`、`RequestRunCoordinator`、`OutboundCoordinator`、`InteractionCoordinator`、Projector/Registry/Handler ports
- `adapters`：`GatewayCommandSource` 适配、`GatewayOutboundSink` 适配、Provider API adapter、projector adapter
- `infrastructure`：日志、时钟、in-memory registry、默认装配

对外导出面限制如下：

- 只导出 facade、ports、必要类型与工厂函数
- 不导出 coordinator、registry 默认实现、dispatcher 具体实现与内部 adapter

---

## 3. 内部执行模型

### 3.1 命令闭集与 UseCase

首版完整覆盖以下 `RuntimeCommand`：

- `query_status`
- `create_session`
- `start_request_run`
- `reply_question`
- `reply_permission`
- `close_session`
- `abort_execution`

对应 UseCase 固定为：

- `QueryStatusUseCase`
- `CreateSessionUseCase`
- `StartRequestRunUseCase`
- `ReplyQuestionUseCase`
- `ReplyPermissionUseCase`
- `CloseSessionUseCase`
- `AbortExecutionUseCase`

`RuntimeCommandDispatcher` 只做路由，不承载命令规则。

内部 provider execution boundary 也必须锁定为 7 个 command 闭集：

- `queryStatus`
- `createSession`
- `startRequestRun`
- `replyQuestion`
- `replyPermission`
- `closeSession`
- `abortExecution`

其中：

- `startRequestRun` 是唯一返回 run handle 的 command handler，必须暴露 `facts` 与 `result()`
- 其他 command handlers 只返回命令结果，不得伪造 request run 终态
- handler 只负责 provider 调用边界与错误归一，不负责 registry 检查、interaction 判定、terminal 投影或状态推进

### 3.2 Coordinator 与 Registry

首版运行时协作对象：

- `RequestRunCoordinator`
- `OutboundCoordinator`
- `InteractionCoordinator`
- `SessionRuntimeRegistry`
- `PendingInteractionRegistry`

Registry 端口必须提供原子语义：

- active run：原子 acquire / release
- active outbound：原子 acquire / release
- pending interaction：原子 register / consume

冲突、未命中等情况通过结构化结果表达，不依赖异常做常规流程控制。

### 3.3 上下行链路

下行链路：

```text
GatewayDownstreamBusinessRequest
  -> RuntimeCommand
  -> RuntimeCommandDispatcher
  -> UseCase
  -> Provider Handler
```

上行链路：

```text
ProviderFact
  -> FactSequenceValidator / RuntimeStateAdvance
  -> FactToSkillEventProjector
  -> SkillProviderEvent
  -> SkillEventToGatewayMessageProjector
  -> GatewayUplinkBusinessMessage
  -> GatewayOutboundSink
```

补充规则：

- `GatewayCommandResultProjector` 只负责 `status_response`、`session_created`
- `RunTerminalSignalProjector` 只负责 `tool_done`、`tool_error`
- family-specific 分支只允许存在于 adapter / projector adapter 边界
- `ProviderFact` 与 `SkillProviderEvent` 不是一一映射关系；部分 lifecycle facts 只驱动 runtime 状态，不进入统一业务事件层

### 3.4 事实流时序校验

`ProviderFact` 在 runtime 中是受生命周期约束的有序事实流，而不是无序事件集合。

首版应新增 `FactSequenceValidator`（或等价职责），在 `FactToSkillEventProjector` 之前完成：

- request run / outbound 的事实流顺序校验
- runtime 内部 message / run / interaction 状态推进
- 对 lifecycle facts 的消费，即使这些 facts 不产出 `SkillProviderEvent`

首版需要显式建模并校验以下语义：

- `message.start -> ... -> message.done`
- `text.delta* -> text.done`
- `thinking.delta* -> thinking.done`
- `message.done` 后禁止继续接收 message-scoped facts
- run terminal 后禁止继续接收 run-scoped facts

`message.start`、`message.done` 等 lifecycle facts 参与时序校验与状态推进，但不默认进入 `SkillProviderEvent`。

`step.start` / `step.done` 不属于 provider 直接暴露的 `ProviderFact` 闭集。首版中它们是 runtime 基于 `message.*`、`text.*`、`thinking.*`、`tool.update` 等事实派生出的内部阶段性事件或状态切换；相应校验属于内部派生语义校验，而不是对外 fact 契约校验。

### 3.5 Request Run / Outbound 双 Profile

request run 与 outbound 共享 `ProviderFact` 类型集合与基础顺序约束，但不得共用同一套 lifecycle 收口规则。

首版应采用：

- `RequestRunLifecycleProfile`
- `OutboundLifecycleProfile`

其中：

- request run profile 以 `ProviderRun.result()` 为 terminal 真源，`message.done` 不能替代 terminal 结论
- outbound profile 不引入 run terminal 语义，`message.done` 可作为自然收口条件
- 公共 validator 负责基础顺序约束；terminal 解释由 profile 与 coordinator 共同决定
- `session.error` 在首版中视为 reserved fact：可接收并进入诊断 trace，但不参与 terminal 判定、状态推进或业务事件投影

### 3.6 Abort / Close 竞争规则

首版对 `abort_execution` 与 `close_session` 采用不同的 in-flight facts 策略：

- `abort_execution`：进入 `aborting` 状态，允许有限尾部 facts，直到 `ProviderRun.result()` 收口
- `close_session`：一旦 close 已应用成功，session 立即进入 fail-closed，不再接受新的 session-scoped / run-scoped facts

收口规则如下：

- `aborting` 状态接受尾部 facts，但 `result()` 之后所有 run-scoped facts 一律拒绝
- `closed` 状态下所有 session-scoped facts 一律拒绝
- 使用语义窗口而不是时间窗口；是否允许继续接收 facts 取决于 `result()` 是否收口，而不是固定超时

`abort_execution` 后允许的尾部 facts 仅限“已存在对象的收尾型 facts”，例如：

- 已存在 message 的 `text.delta` / `text.done`
- 已存在 message 的 `thinking.delta` / `thinking.done`
- 已存在 `toolCallId` 的收敛型 `tool.update`
- 已存在 message 的 `message.done`

以下新活动型 facts 一律拒绝：

- 新的 `message.start`
- 新的 `question.ask`
- 新的 `permission.ask`
- abort 后首次出现的新 `toolCallId`
- 任何会开启新业务阶段的事实

---

## 4. 集成协议演进策略

首版公开的 Provider 接口仍可采用方法式 `ThirdPartyAgentProvider`。

但 SDK 内部不把该方法式接口视为核心依赖，而是通过 `ProviderApiAdapter` 把外部集成 API 收敛为内部显式时序 contract。换言之：

- 对外：method-based API contract
- 对内：显式时序 contract 与 handler-style application ports

该策略的目的如下：

- 避免 `RuntimeCore`、UseCase、Coordinator 绑定具体 API 组织方式或隐含时序关系
- 若某个 provider-facing API 不能显式表达前置状态、后置状态与终态归属，则不得直接进入 core
- 后续若 Provider API 改为 handler-based 或其他协议形态，只替换 adapter 层
- 保持 application core 对 agent 集成方式演进不敏感

`ProviderApiAdapter` 的职责边界如下：

- 把外部 Provider API 适配为内部 command handlers / run handles / lifecycle effects
- 显式收敛命令 apply 阶段、执行期终态与 facts 流的职责边界
- 不承载 registry 检查、interaction pending 判定、terminal signal 投影等 runtime 业务编排

错误边界固定如下：

- command handler apply 失败统一表现为 `ProviderCommandError`
- request run 执行期失败统一经 `ProviderRun.result()` 暴露为 `ProviderTerminalResult`
- `startRequestRun` 不能被扁平化为普通 `{ applied: true }` 结果

---

## 5. 接入与迁移顺序

首版迁移顺序固定为：

1. 在 `packages/bridge-runtime-sdk` 建立最小可装配骨架与 public API
2. 落地 `RuntimeCommand`、UseCase、Coordinator、Registry ports 与默认 in-memory 实现
3. 落地 `FactSequenceValidator`、request run / outbound lifecycle profiles 与上行 / 下行 projector ports
4. 明确 normalized trace contract 与字段归一化规则，再实现 trace harness
5. 在 `message-bridge-openclaw` 插件侧实现 provider adapter，把宿主能力映射到 SDK port
6. 建立 legacy runtime 与 sdk runtime 的 trace 对照回归 harness
7. 让 `message-bridge-openclaw` 切换到 SDK runtime 核心链路
8. 补齐 family adapter 与边界测试

本轮不做以下迁移：

- 不把 `message-bridge` 主 runtime 同步切到 SDK
- 不在 SDK 内提供 OpenClaw-specific 或 legacy-specific 兼容层

---

## 6. 测试矩阵

### 6.1 命令与路由

- `GatewayDownstreamBusinessRequest -> RuntimeCommand` 映射测试
- dispatcher 路由正确性测试
- 每个 UseCase 的输入约束、handler 调用与结果投影测试
- `start_request_run` 单独验证 run handle、`facts`、`result()` 的职责边界与错误语义

### 6.2 事实流时序与状态机

- 同一 `toolSessionId` 并发双 `start_request_run`，仅允许一个成功
- 同一 `toolSessionId` 并发 outbound，仅允许一个活跃 message
- 重复 `reply_question` / `reply_permission`，首次成功、后续未命中
- `abort_execution` 与 `ProviderRun.result()` race 不得产生双终态上报
- `message.done` 后禁止续写
- 合法外部 fact 时序通过，例如 `message.start -> text.delta -> text.done -> message.done`
- 非法时序 fail-closed，例如无 `message.start` 的 `text.delta`、`message.done` 后续写、terminal 后续写
- 内部派生 step 生命周期单测：runtime 可从外部 facts 派生稳定的 step 开始/结束事件或状态切换

### 6.3 双 Profile 与竞争规则

- request run profile 显式等待 `ProviderRun.result()` 收口
- outbound profile 使用 `message.done` 收口且不引入 run terminal 语义
- `abort_execution` 进入 `aborting` 后仅允许已存在对象的尾部收尾 facts，`result()` 后拒绝续写
- `close_session` 应用成功后立即 fail-closed
- pending interaction 不可重放，`close_session` 后收到 reply 直接拒绝
- `session.error` 首版只验证“可接收并记录诊断 trace，但不参与业务语义”

### 6.4 投影与协议边界

- `ProviderFact -> SkillProviderEvent -> GatewayUplinkBusinessMessage` 投影覆盖
- `status_response`、`session_created`、`tool_done`、`tool_error` 单独覆盖
- family-specific 逻辑只在 adapter 层出现，`application/domain` 层不得出现 family 分支
- 覆盖“消费 fact 但不产出 `SkillProviderEvent`”的路径，确保 lifecycle facts 不因无投影而丢失语义

### 6.5 Trace 等价回归与集成验证

- 在 openclaw 切换前，对同一 fixture 运行 legacy runtime 与 sdk runtime，对齐以下可观察 trace：
- provider 调用序列
- fact 序列
- uplink business message 序列
- terminal 结果
- interaction 生命周期
- trace 采用 normalized contract trace，而不是原始对象 dump
- 先定义 normalization rules：时间戳、随机 ID、非稳定 details、debug 噪声需归一化或排除
- 任一 trace 差异默认视为阻断项，除非单独评审接受行为变更
- `message-bridge-openclaw` 通过插件侧 provider adapter 接入 SDK
- 跑通 `create_session`、`start_request_run`、`reply_*`、`close_session`、`abort_execution`
- 验证 openclaw 接入后 runtime 核心链路已由 SDK 承担，而非插件内自持编排

---

## 7. 风险与回滚

首版重点风险：

- active run / active outbound 冲突处理不当，导致双活或重复发送
- `abort_execution` 与 run terminal race，导致双终态上报
- interaction reply 重放，导致 pending interaction 被重复消费
- facts 顺序不稳定或 lifecycle 校验缺失，导致错误投影或隐式行为漂移
- trace 归一化规则不完整，导致 legacy / sdk 对照结果不可比较
- family-specific 判断泄漏进 core/application 层
- openclaw 接入 SDK 后，与旧 runtime 行为不一致

回滚原则：

- 若 openclaw 接入 SDK 后出现核心行为回归，应优先回退接入点，而不是回退架构文档与对外接口文档
- 架构边界仍以架构文档为真源；实现方案只调整首版落地路径，不反向修改长期边界
