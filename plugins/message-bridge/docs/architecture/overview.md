# message-bridge 架构总览

**Version:** 2.2
**Date:** 2026-03-28
**Status:** Active
**Owner:** message-bridge maintainers
**Related:** `../product/prd.md`, `../design/interfaces/protocol-contract.md`, `../design/interfaces/config-contract.md`

## 1. 目标

当前实现围绕以下四个约束组织：

1. 保持对外协议行为稳定
2. 明确边界契约归属
3. 将原始协议字段读取限制在协议边界层
4. 将运行时编排与业务执行分离

整体流转如下：

```text
原始事件/报文
  -> contracts
  -> protocol
  -> runtime
  -> usecase / action / transport
```

## 2. 分层

### 2.1 `contracts`

定义对外边界形状：

- `contracts/upstream-events.ts`
- `contracts/downstream-messages.ts`
- `contracts/transport-messages.ts`

该层回答 bridge 与 OpenCode、gateway 之间交换什么数据。

### 2.2 `protocol`

负责 schema 归一化与提取。

- `protocol/upstream`
  - 校验支持的上行事件
  - 提取 `toolSessionId`
  - 失败时记录 `event.extraction_failed`
- `protocol/downstream`
  - 将 gateway 下行报文归一化为强类型命令
  - 失败时记录 `downstream.normalization_failed`

只有该层允许读取原始协议字段。

### 2.3 `runtime`

只负责编排：

- 生命周期
- 配置加载
- 连接管理
- action 路由
- gateway 发送
- usecase 与 adapter 装配

`runtime` 不解析原始上下行 payload。

### 2.4 `usecase`

负责业务规则与决策：

- 特殊通道下的目录解析
- `chat` 的 agent 透传
- SDK 调用前的 create-session 编排

### 2.5 `action`

负责仅执行型业务逻辑：

- 状态门控
- SDK 调用
- 结果映射
- 错误映射

`action` 不再负责 payload 归一化。

## 3. 上行流

```text
OpenCode 事件
  -> EventFilter
  -> extractUpstreamEvent()
  -> runtime.handleEvent()
  -> gateway.send({ type: 'tool_event', toolSessionId, event })
```

当前精确白名单：

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

## 4. 下行流

```text
gateway 下行消息
  -> normalizeDownstreamMessage()
  -> runtime.handleDownstreamMessage()
  -> actionRouter.route()
  -> action.execute()
  -> runtime 发送传输层响应
```

支持的下行消息类型：

- `invoke`
- `status_query`

支持的 `invoke.action`：

- `chat`
- `create_session`
- `close_session`
- `permission_reply`
- `abort_session`
- `question_reply`

当前与目录解析相关的结论：

- 仅当 `BRIDGE_CHANNEL === 'assiant'` 且下行 payload 提供 `assistantId` 时，运行时才会按映射文件解析 `create_session` 目录
- 若目录映射未命中，则继续回退到 `effectiveDirectory`
- 若 `effectiveDirectory` 也不存在，则省略目录字段
- 旧字段 `assiantId` 已废弃；当前会被视为未知字段并静默忽略，不会触发 agent 透传或目录映射

## 5. 传输层行为

bridge 发往 gateway 的消息类型：

- `register`
- `heartbeat`
- `tool_event`
- `tool_done`
- `tool_error`
- `session_created`
- `status_response`

协议说明：

- `tool_event` 仍保持 `{ type: 'tool_event', toolSessionId, event }`
- 响应消息不再携带 `sessionId` 或 `envelope`
- `session.idle` 继续作为 `tool_event` 向上游转发
- `tool_done` 作为兼容层完成态投影保留给 UI 消费者
- 上行白名单默认值不支持通配符

## 6. 配置与日志

配置解析以当前实现为准，完整配置项、环境变量映射、兼容别名与校验规则统一维护在 `design/interfaces/config-contract.md`。

配置来源从高到低：

1. 环境变量：`BRIDGE_*`
2. 项目级配置：`.opencode/message-bridge.jsonc` / `.json`
3. 用户级配置：`~/.config/opencode/message-bridge.jsonc` / `.json`
4. 内建默认值

补充说明：

- 同目录下优先读取 `.jsonc`
- 项目级配置会从工作目录开始向父目录递归查找，直到文件系统根目录
- `gateway.channel` 是配置侧字段名，注册报文中仍映射到协议字段 `toolType`
- `deviceName`、`macAddress`、`toolVersion` 由运行时自动采集，不属于可配置项

结构化日志在 `client.app.log()` 可用时上报。关键协议失败事件：

- `event.extraction_failed`
- `downstream.normalization_failed`

## 7. 当前结论

当前代码满足以下架构结论：

- 边界契约集中在 `contracts/`
- schema 所有权集中在 `protocol/`
- `runtime` 已收缩为编排层
- `action` 主执行链路不再拥有 payload schema

少量兼容层仍保留在旧入口，以避免打断已有导入；新开发应遵循 `contracts -> protocol -> runtime -> action` 路径。
