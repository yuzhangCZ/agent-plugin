# gateway-schema 事件契约

**Version:** 0.3  
**Date:** 2026-04-20  
**Status:** Draft  
**Owner:** agent-plugin maintainers  
**Related:** [Gateway Schema / Protocol 架构设计](../../architecture/gateway-schema-architecture.md), [gateway-wire-v1 事件契约（历史页）](./gateway-wire-v1-event-contract.md)

## 背景

本文是 current-state `tool_event.event` 的主契约页面。历史工作名 `gateway-wire-v1` 仅保留为迁移背景；当前实现与测试均以 `@agent-plugin/gateway-schema` 为主路径。

`plugins/message-bridge/docs/design/interfaces/protocol-contract.md` 仅是插件侧实现文档，不是 current-state 主契约入口，也不与本文并列构成双真源。

- `Reference Host SDK: @opencode-ai/plugin@1.2.15`
- `Reference Host SDK: @opencode-ai/sdk@1.2.15`

本文描述的是基于上述版本可观察行为冻结出的共享外部模型，而不是宿主 SDK 类型的直接别名。

## 范围

### In Scope

- `tool_event.event` 的类型集合
- 每个 `event.type` 的当前字段组成
- 必填 / 可选字段
- `message.updated` 的白名单字段
- fail-closed 规则

### Out of Scope

- raw 宿主事件提取逻辑
- `gateway-client`
- `bridge-mapper` 的语义映射
- `bridge-application` 的决策层

### External Dependencies

- `message-bridge` 的现有上行投影
- `message-bridge-openclaw` 的现有事件合成
- `packages/test-support` 的共享断言

## 总体结构

`tool_event` 的外部形状固定为：

```json
{
  "type": "tool_event",
  "toolSessionId": "tool-001",
  "event": {
    "family": "opencode",
    "type": "message.updated"
  }
}
```

`event` 必须是显式判别联合，不能退化成任意对象。

## 通用规则

- `toolSessionId` 为必填字符串。
- `toolSessionId` 只属于 `tool_event` 外层 envelope，不属于 `tool_event.event` payload。
- `event.family` 为必填字符串，当前允许 `opencode` / `skill`。
- `event.type` 为必填字符串。
- `event.type` 只能来自共享包支持集合。
- 宿主 raw event 不得原样进入共享契约。
- 所有事件都要先通过共享 validator，再发送到 gateway。
- `gateway-client` 只消费共享协议校验结果，不感知 provider family 细节。

## 事件契约总览

当前共享包通过 `family` 分层维护事件白名单，并由 `SUPPORTED_TOOL_EVENT_TYPES` 暴露并集：

- `opencode` family：12 个历史兼容事件
- `skill` family：12 个协议收敛事件（不做兼容兜底）

### opencode family（11）

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
- `permission.replied`
- `question.asked`

### skill family（12）

- `text.delta`
- `text.done`
- `thinking.delta`
- `thinking.done`
- `tool.update`
- `question`
- `permission.ask`
- `permission.reply`
- `step.start`
- `step.done`
- `session.status`
- `session.error`

说明：

- `skill` family 只接受上述 12 个事件，未知或历史别名（如 `question.ask`、`permission.replied`、`session.idle`）必须 fail-closed。
- `skill` family 不包含 `raw` 字段。

## `message.updated`

用途：消息级更新，主要承载内容摘要与模型元信息。

```json
{
  "type": "message.updated",
  "properties": {
    "info": {
      "id": "msg-001",
      "sessionID": "sess-001",
      "role": "assistant",
      "time": {
        "created": 1730000000000
      }
    }
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `type` | string | 是 | `message.updated` | 事件类型 | 共享 validator + 当前宿主可观察行为 | `@opencode-ai/plugin@1.2.15` / `@opencode-ai/sdk@1.2.15` |
| `properties.info` | object | 是 | - | 消息元信息 | message-bridge / openclaw 投影 | 同上 |
| `properties.info.id` | string | 是 | - | 消息 ID | 宿主消息元信息 | 同上 |
| `properties.info.sessionID` | string | 是 | - | 会话 ID | 宿主消息元信息 | 同上 |
| `properties.info.role` | string | 是 | `user` / `assistant` | 消息角色 | 宿主消息元信息 | 同上 |
| `properties.info.time.created` | number | 是 | 时间戳 | 创建时间 | 宿主消息元信息 | 同上 |
| `properties.info.model` | object | 否 | - | 模型信息 | 宿主投影 | 同上 |
| `properties.info.summary` | object | 否 | - | 冻结后的摘要白名单 | 当前可观察行为 | 同上 |
| `properties.info.summary.diffs` | array<object> | 否 | - | 摘要 diff 列表 | 宿主摘要 | 同上 |

说明：

- `summary` 只保留白名单字段。
- `before`、`after` 等非白名单字段不进入共享契约。

## `message.part.updated`

用途：消息分片更新，文本分片和工具分片都走这里。

```json
{
  "type": "message.part.updated",
  "properties": {
    "part": {
      "id": "part-001",
      "sessionID": "sess-001",
      "messageID": "msg-001",
      "type": "tool"
    }
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `type` | string | 是 | `message.part.updated` | 事件类型 | 共享 validator + 当前宿主可观察行为 | 同上 |
| `properties.part` | object | 是 | - | 分片信息 | 宿主分片投影 | 同上 |
| `properties.part.id` | string | 是 | - | 分片 ID | 宿主分片投影 | 同上 |
| `properties.part.sessionID` | string | 是 | - | 会话 ID | 宿主分片投影 | 同上 |
| `properties.part.messageID` | string | 是 | - | 消息 ID | 宿主分片投影 | 同上 |
| `properties.part.type` | string | 是 | `text` / `tool` | 分片类型 | 宿主分片投影 | 同上 |
| `properties.part.text` | string | 否 | - | 文本内容 | 文本分片投影 | 同上 |
| `properties.part.tool` | string | 否 | - | 工具名 | 工具分片投影 | 同上 |
| `properties.part.callID` | string | 否 | - | 工具调用 ID | 工具分片投影 | 同上 |
| `properties.part.state` | object | 否 | - | 工具分片状态 | 工具分片投影 | 同上 |
| `properties.delta` | string | 否 | - | 文本增量 | 当前可观察行为 | 同上 |

## `message.part.delta`

用途：消息分片增量。

```json
{
  "type": "message.part.delta",
  "properties": {
    "sessionID": "sess-001",
    "messageID": "msg-001",
    "partID": "part-001",
    "field": "text",
    "delta": "he"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `type` | string | 是 | `message.part.delta` | 事件类型 | 共享 validator + 当前宿主可观察行为 | 同上 |
| `properties.sessionID` | string | 是 | - | 会话 ID | 宿主投影 | 同上 |
| `properties.messageID` | string | 是 | - | 消息 ID | 宿主投影 | 同上 |
| `properties.partID` | string | 是 | - | 分片 ID | 宿主投影 | 同上 |
| `properties.field` | string | 是 | `text` | 增量字段 | 宿主投影 | 同上 |
| `properties.delta` | string | 是 | - | 增量内容 | 宿主投影 | 同上 |

## `message.part.removed`

用途：消息分片删除。

```json
{
  "type": "message.part.removed",
  "properties": {
    "sessionID": "sess-001",
    "messageID": "msg-001",
    "partID": "part-001"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `type` | string | 是 | `message.part.removed` | 事件类型 | 共享 validator + 当前宿主可观察行为 | 同上 |
| `properties.sessionID` | string | 是 | - | 会话 ID | 宿主投影 | 同上 |
| `properties.messageID` | string | 是 | - | 消息 ID | 宿主投影 | 同上 |
| `properties.partID` | string | 是 | - | 分片 ID | 宿主投影 | 同上 |

## `session.status`

用途：会话状态变化。

```json
{
  "type": "session.status",
  "properties": {
    "sessionID": "sess-001",
    "status": {
      "type": "busy"
    }
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `type` | string | 是 | `session.status` | 事件类型 | 共享 validator + 当前宿主可观察行为 | 同上 |
| `properties.sessionID` | string | 是 | - | 会话 ID | 宿主投影 | 同上 |
| `properties.status` | object | 是 | - | 会话状态对象 | 宿主投影 | 同上 |
| `properties.status.type` | string | 是 | `busy` / `idle` | 状态类型 | 宿主投影 | 同上 |

## `session.idle`

用途：会话进入空闲态。

```json
{
  "family": "opencode",
  "type": "session.idle",
  "properties": {
    "sessionID": "sess-001"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `family` | string | 是 | `opencode` | payload family discriminator | 共享协议层 | current-state |
| `type` | string | 是 | `session.idle` | 事件类型 | 共享 validator + 当前宿主可观察行为 | 同上 |
| `properties.sessionID` | string | 是 | - | 会话 ID | 宿主投影 | 同上 |

说明：`session.idle` 仅属于 `opencode` family；`skill` family 使用 `session.status` 表达会话状态。

## `session.updated`

用途：会话元信息更新。

```json
{
  "type": "session.updated",
  "properties": {
    "info": {
      "id": "sess-001"
    }
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `type` | string | 是 | `session.updated` | 事件类型 | 共享 validator + 当前宿主可观察行为 | 同上 |
| `properties.info` | object | 是 | - | 会话信息 | 宿主投影 | 同上 |
| `properties.info.id` | string | 是 | - | 会话 ID | 宿主投影 | 同上 |

## `session.error`

用途：会话错误通知。

```json
{
  "type": "session.error",
  "properties": {
    "sessionID": "sess-001",
    "error": {
      "message": "failed"
    }
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `type` | string | 是 | `session.error` | 事件类型 | 共享 validator + 当前宿主可观察行为 | 同上 |
| `properties.sessionID` | string | 是 | - | 会话 ID | 宿主投影 | 同上 |
| `properties.error` | object | 否 | - | 错误对象 | 宿主投影 | 同上 |
| `properties.error.message` | string | 是 | - | 错误消息 | 宿主投影 | 同上 |

## `permission.updated`

用途：权限状态变化。

```json
{
  "type": "permission.updated",
  "properties": {
    "sessionID": "sess-001",
    "id": "perm-001",
    "status": "granted"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `type` | string | 是 | `permission.updated` | 事件类型 | 共享 validator + 当前宿主可观察行为 | 同上 |
| `properties.sessionID` | string | 是 | - | 会话 ID | 宿主投影 | 同上 |
| `properties.id` | string | 否 | - | 权限请求 ID | 宿主投影 | 同上 |
| `properties.messageID` | string | 否 | - | 关联消息 ID | 宿主投影 | 同上 |
| `properties.type` | string | 否 | - | 请求类型 | 宿主投影 | 同上 |
| `properties.title` | string | 否 | - | 请求标题 | 宿主投影 | 同上 |
| `properties.metadata` | object | 否 | - | 附加元数据 | 宿主投影 | 同上 |
| `properties.status` | string | 否 | `granted` / `rejected` 等 | 当前权限结果 | 宿主投影 | 同上 |
| `properties.response` | string | 否 | - | 归一化后的响应结果 | 宿主投影 | 同上 |
| `properties.resolved` | boolean | 否 | `true` / `false` | 是否已决议 | 宿主投影 | 同上 |

说明：

- legacy 输入允许使用 `permissionID`、`permission`、`decision`、`answer`、`isResolved` 等别名。
- 共享契约对外统一收敛为 `id`、`type`、`response`、`resolved`。

## `permission.asked`

用途：权限请求。

```json
{
  "type": "permission.asked",
  "properties": {
    "id": "perm-001",
    "sessionID": "sess-001",
    "title": "Need approval"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `type` | string | 是 | `permission.asked` | 事件类型 | 共享 validator + 当前宿主可观察行为 | 同上 |
| `properties.id` | string | 否 | - | 权限请求 ID | 宿主投影 | 同上 |
| `properties.sessionID` | string | 是 | - | 会话 ID | 宿主投影 | 同上 |
| `properties.messageID` | string | 否 | - | 关联消息 ID | 宿主投影 | 同上 |
| `properties.type` | string | 否 | - | 请求类型 | 宿主投影 | 同上 |
| `properties.title` | string | 否 | - | 请求标题 | 宿主投影 | 同上 |
| `properties.metadata` | object | 否 | - | 附加元数据 | 宿主投影 | 同上 |
| `properties.status` | string | 否 | - | 审批状态 | 宿主投影 | 同上 |
| `properties.response` | string | 否 | - | 归一化后的响应结果 | 宿主投影 | 同上 |
| `properties.resolved` | boolean | 否 | `true` / `false` | 是否已决议 | 宿主投影 | 同上 |

## `permission.replied`

用途：权限请求回复事件。

```json
{
  "family": "opencode",
  "type": "permission.replied",
  "properties": {
    "sessionID": "sess-001",
    "requestID": "perm-001",
    "reply": "always"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `family` | string | 是 | `opencode` | payload family discriminator | 共享协议层 | current-state |
| `type` | string | 是 | `permission.replied` | 事件类型 | `@opencode-ai/sdk` v2 `EventPermissionReplied` | `@opencode-ai/sdk@1.2.15` |
| `properties.sessionID` | string | 是 | - | 会话 ID | 宿主事件字段 | 同上 |
| `properties.requestID` | string | 是 | - | 权限请求 ID | 宿主事件字段 | 同上 |
| `properties.reply` | string | 是 | `once` / `always` / `reject` | 权限回复结果 | 宿主事件字段 | 同上 |

说明：`permission.replied` 按 OpenCode SDK v2 字段原名冻结为 `requestID` / `reply`，不在 schema 层改写为 `id` / `response`。

## `question.asked`

用途：问题请求。

```json
{
  "family": "opencode",
  "type": "question.asked",
  "properties": {
    "id": "question-001",
    "sessionID": "sess-001",
    "questions": [
      {
        "question": "Proceed?"
      }
    ]
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `family` | string | 是 | `opencode` | payload family discriminator | 共享协议层 | current-state |
| `type` | string | 是 | `question.asked` | 事件类型 | 共享 validator + 当前宿主可观察行为 | 同上 |
| `properties.id` | string | 否 | - | 问题请求 ID | 宿主投影 | 同上 |
| `properties.sessionID` | string | 是 | - | 会话 ID | 宿主投影 | 同上 |
| `properties.questions` | array<object> | 否 | - | 问题列表 | 宿主投影 | 同上 |
| `properties.questions[*].question` | string | 是 | - | 问题文本 | 宿主投影 | 同上 |
| `properties.questions[*].header` | string | 否 | - | 问题标题 | 宿主投影 | 同上 |
| `properties.questions[*].options` | array<object> | 否 | - | 选项列表 | 宿主投影 | 同上 |
| `properties.questions[*].options[*].label` | string | 是 | - | 选项标签 | 宿主投影 | 同上 |
| `properties.tool` | object | 否 | - | 关联工具信息 | 宿主投影 | 同上 |
| `properties.tool.messageID` | string | 是 | - | 关联消息 ID | 宿主投影 | 同上 |
| `properties.tool.callID` | string | 是 | - | 工具调用 ID | 宿主投影 | 同上 |

说明：`question.asked` 仅属于 `opencode` family；`skill` family 使用 `question` 事件并采用独立字段集。

## `text.delta`

用途：`skill` family 文本增量事件。

```json
{
  "family": "skill",
  "type": "text.delta",
  "properties": {
    "messageId": "msg-001",
    "partId": "part-001",
    "content": "he"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `family` | string | 是 | `skill` | payload family discriminator | SDK runtime projector | 同上 |
| `type` | string | 是 | `text.delta` | 事件类型 | `ProviderFact -> SkillProviderEvent` 投影 | 同上 |
| `properties.messageId` | string | 是 | - | 消息 ID | provider fact | 同上 |
| `properties.partId` | string | 是 | - | 文本分片 ID | provider fact | 同上 |
| `properties.content` | string | 是 | - | 文本增量内容 | provider fact | 同上 |

## `text.done`

用途：`skill` family 文本分片收口事件。

```json
{
  "family": "skill",
  "type": "text.done",
  "properties": {
    "messageId": "msg-001",
    "partId": "part-001",
    "content": "hello"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `family` | string | 是 | `skill` | payload family discriminator | SDK runtime projector | 同上 |
| `type` | string | 是 | `text.done` | 事件类型 | `ProviderFact -> SkillProviderEvent` 投影 | 同上 |
| `properties.messageId` | string | 是 | - | 消息 ID | provider fact | 同上 |
| `properties.partId` | string | 是 | - | 文本分片 ID | provider fact | 同上 |
| `properties.content` | string | 是 | - | 文本收口内容 | provider fact | 同上 |

## `thinking.delta`

用途：`skill` family thinking 增量事件。

```json
{
  "family": "skill",
  "type": "thinking.delta",
  "properties": {
    "messageId": "msg-001",
    "partId": "thinking-001",
    "content": "thinking..."
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `family` | string | 是 | `skill` | payload family discriminator | SDK runtime projector | 同上 |
| `type` | string | 是 | `thinking.delta` | 事件类型 | `ProviderFact -> SkillProviderEvent` 投影 | 同上 |
| `properties.messageId` | string | 是 | - | 消息 ID | provider fact | 同上 |
| `properties.partId` | string | 是 | - | thinking 分片 ID | provider fact | 同上 |
| `properties.content` | string | 是 | - | thinking 增量内容 | provider fact | 同上 |

## `thinking.done`

用途：`skill` family thinking 分片收口事件。

```json
{
  "family": "skill",
  "type": "thinking.done",
  "properties": {
    "messageId": "msg-001",
    "partId": "thinking-001",
    "content": "done thinking"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `family` | string | 是 | `skill` | payload family discriminator | SDK runtime projector | 同上 |
| `type` | string | 是 | `thinking.done` | 事件类型 | `ProviderFact -> SkillProviderEvent` 投影 | 同上 |
| `properties.messageId` | string | 是 | - | 消息 ID | provider fact | 同上 |
| `properties.partId` | string | 是 | - | thinking 分片 ID | provider fact | 同上 |
| `properties.content` | string | 是 | - | thinking 收口内容 | provider fact | 同上 |

## `tool.update`

用途：`skill` family 工具调用状态更新。

```json
{
  "family": "skill",
  "type": "tool.update",
  "properties": {
    "messageId": "msg-001",
    "partId": "tool-001",
    "toolName": "search",
    "toolCallId": "call-001",
    "status": "completed"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `family` | string | 是 | `skill` | payload family discriminator | SDK runtime projector | 同上 |
| `type` | string | 是 | `tool.update` | 事件类型 | `ProviderFact -> SkillProviderEvent` 投影 | 同上 |
| `properties.messageId` | string | 是 | - | 消息 ID | provider fact | 同上 |
| `properties.partId` | string | 是 | - | tool part ID | provider fact | 同上 |
| `properties.toolName` | string | 是 | - | 工具名 | provider fact | 同上 |
| `properties.status` | string | 是 | `pending` / `running` / `completed` / `error` | 工具状态 | provider fact | 同上 |
| `properties.toolCallId` | string | 否 | - | 工具调用 ID | provider fact | 同上 |
| `properties.title` | string | 否 | - | 工具标题 | provider fact | 同上 |
| `properties.input` | unknown | 否 | - | 工具输入快照 | provider fact | 同上 |
| `properties.output` | unknown | 否 | - | 工具输出快照 | provider fact | 同上 |
| `properties.error` | string | 否 | - | 错误消息 | provider fact | 同上 |

## `question`

用途：`skill` family 问题请求。

```json
{
  "family": "skill",
  "type": "question",
  "properties": {
    "messageId": "msg-001",
    "partId": "call-001",
    "toolCallId": "call-001",
    "question": "Proceed?"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `family` | string | 是 | `skill` | payload family discriminator | SDK runtime projector | 同上 |
| `type` | string | 是 | `question` | 事件类型 | `ProviderFact -> SkillProviderEvent` 投影 | 同上 |
| `properties.messageId` | string | 是 | - | 消息 ID | provider fact | 同上 |
| `properties.partId` | string | 是 | - | 交互 part ID | provider fact | 同上 |
| `properties.toolCallId` | string | 否 | - | 工具调用 ID | provider fact | 同上 |
| `properties.question` | string | 是 | - | 问题文本 | provider fact | 同上 |
| `properties.header` | string | 否 | - | 问题标题 | provider fact | 同上 |
| `properties.options` | array<string> | 否 | - | 选项列表 | provider fact | 同上 |

## `permission.ask`

用途：`skill` family 权限请求。

```json
{
  "family": "skill",
  "type": "permission.ask",
  "properties": {
    "messageId": "msg-001",
    "partId": "perm-001",
    "permissionId": "perm-001"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `family` | string | 是 | `skill` | payload family discriminator | SDK runtime projector | 同上 |
| `type` | string | 是 | `permission.ask` | 事件类型 | `ProviderFact -> SkillProviderEvent` 投影 | 同上 |
| `properties.messageId` | string | 是 | - | 消息 ID | provider fact | 同上 |
| `properties.partId` | string | 是 | - | 交互 part ID | provider fact | 同上 |
| `properties.permissionId` | string | 是 | - | 权限请求 ID | provider fact | 同上 |
| `properties.permType` | string | 否 | - | 权限类型 | provider fact | 同上 |
| `properties.metadata` | object | 否 | - | 附加元数据 | provider fact | 同上 |

## `permission.reply`

用途：`skill` family 权限回复结果。

```json
{
  "family": "skill",
  "type": "permission.reply",
  "properties": {
    "messageId": "msg-001",
    "partId": "perm-001",
    "permissionId": "perm-001",
    "response": "once"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `family` | string | 是 | `skill` | payload family discriminator | SDK runtime projector | 同上 |
| `type` | string | 是 | `permission.reply` | 事件类型 | `ProviderFact -> SkillProviderEvent` 投影 | 同上 |
| `properties.messageId` | string | 是 | - | 消息 ID | provider / projector | 同上 |
| `properties.partId` | string | 是 | - | 交互 part ID | provider / projector | 同上 |
| `properties.permissionId` | string | 是 | - | 权限请求 ID | provider / projector | 同上 |
| `properties.response` | string | 是 | `once` / `always` / `reject` | 回复结果 | provider / projector | 同上 |

## `step.start`

用途：`skill` family message 生命周期开始事件。

```json
{
  "family": "skill",
  "type": "step.start",
  "properties": {
    "messageId": "msg-001"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `family` | string | 是 | `skill` | payload family discriminator | SDK runtime 内部派生 | 同上 |
| `type` | string | 是 | `step.start` | 事件类型 | `message.start` 派生 | 同上 |
| `properties.messageId` | string | 是 | - | 消息 ID | runtime 派生 | 同上 |

## `step.done`

用途：`skill` family message 生命周期收口事件。

```json
{
  "family": "skill",
  "type": "step.done",
  "properties": {
    "messageId": "msg-001",
    "reason": "stop"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `family` | string | 是 | `skill` | payload family discriminator | SDK runtime 内部派生 | 同上 |
| `type` | string | 是 | `step.done` | 事件类型 | `message.done` 派生 | 同上 |
| `properties.messageId` | string | 是 | - | 消息 ID | runtime 派生 | 同上 |
| `properties.tokens` | unknown | 否 | - | token 用量 | provider fact | 同上 |
| `properties.cost` | number | 否 | - | 成本 | provider fact | 同上 |
| `properties.reason` | string | 否 | - | 收口原因 | provider fact | 同上 |

## 失败规则

- 未知 `event.type` 必须 fail-closed。
- 缺少必填字段必须 fail-closed。
- 字段类型错误必须 fail-closed。
- `message.updated` 超出白名单的字段必须被剥离或拒绝，具体策略以共享测试冻结。

## 与插件实现的关系

- `message-bridge` 负责把宿主事件投影成这里定义的事件模型。
- `message-bridge-openclaw` 负责把 OpenClaw runtime 事件合成成这里定义的事件模型。
- 共享契约只负责最终对外形状，不负责 raw event 抽取。

## 结论

`tool_event.event` 是 `gateway-schema` 当前最重要的可观察边界。它必须显式字段化、可测试、可回滚；`gateway-wire-v1` 只作为历史工作名保留，不再是 current-state 主路径。
