# gateway-wire-v1 事件契约

**Version:** 1.0  
**Date:** 2026-03-30  
**Status:** Frozen  
**Owner:** agent-plugin maintainers  
**Related:** [gateway-wire-v1-architecture.md](../../architecture/gateway-wire-v1-architecture.md), [gateway-wire-v1-module-design.md](../gateway-wire-v1-module-design.md), [protocol-contract.md](../../../plugins/message-bridge/docs/design/interfaces/protocol-contract.md)

## 背景

本文定义 `tool_event.event` 的正式事件契约。它不是宿主 SDK 类型的直接别名，而是基于 `@opencode-ai/plugin@1.2.15` / `@opencode-ai/sdk@1.2.15` 的当前可观察行为冻结出的共享外部模型。

## 范围

### In Scope

- `tool_event.event` 的类型定义
- 每个 `event.type` 的字段组成
- 必填 / 可选字段
- `message.updated` 字段白名单
- 失败规则

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
    "type": "message.updated"
  }
}
```

`event` 必须是显式判别联合，不能退化成任意对象。

## 通用规则

- `toolSessionId` 为必填字符串。
- `event.type` 为必填字符串。
- `event.type` 只能来自共享包支持集合。
- 宿主 raw event 不得原样进入共享契约。
- 所有事件都要先通过共享 validator，再发送到 gateway。

## 事件契约总览

当前共享包支持的 `tool_event.event.type` 只有 11 个，必须与 `SUPPORTED_TOOL_EVENT_TYPES` 一致：

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
      },
      "model": {
        "provider": "openai",
        "name": "gpt-5"
      },
      "summary": {
        "additions": 1,
        "deletions": 0,
        "files": 1,
        "diffs": [
          {
            "file": "src/index.ts",
            "status": "modified",
            "additions": 1,
            "deletions": 0
          }
        ]
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
| `properties.info.time.updated` | number | 否 | 时间戳 | 最近更新时间 | 当前可观察行为 | 同上 |
| `properties.info.model` | object | 否 | - | 模型信息 | 宿主投影 | 同上 |
| `properties.info.model.provider` | string | 否 | - | 模型提供方 | 宿主投影 | 同上 |
| `properties.info.model.name` | string | 否 | - | 模型名称 | 宿主投影 | 同上 |
| `properties.info.model.thinkLevel` | string | 否 | - | 推理强度 | 宿主投影 | 同上 |
| `properties.info.summary` | object | 否 | - | 消息摘要 | 当前可观察行为 | 同上 |
| `properties.info.summary.additions` | number | 否 | - | 新增行数 | 宿主摘要 | 同上 |
| `properties.info.summary.deletions` | number | 否 | - | 删除行数 | 宿主摘要 | 同上 |
| `properties.info.summary.files` | number | 否 | - | 影响文件数 | 宿主摘要 | 同上 |
| `properties.info.summary.diffs` | array<object> | 否 | - | 摘要 diff 列表 | 宿主摘要 | 同上 |
| `properties.info.summary.diffs[*].file` | string | 否 | - | 文件路径 | 宿主摘要 | 同上 |
| `properties.info.summary.diffs[*].status` | string | 否 | - | diff 状态 | 宿主摘要 | 同上 |
| `properties.info.summary.diffs[*].additions` | number | 否 | - | diff 新增行数 | 宿主摘要 | 同上 |
| `properties.info.summary.diffs[*].deletions` | number | 否 | - | diff 删除行数 | 宿主摘要 | 同上 |

说明：

- `summary` 只保留白名单字段。
- `summary.diffs[*]` 只保留表中列出的字段。
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
      "type": "tool",
      "tool": "search",
      "callID": "call-001",
      "state": {
        "status": "running",
        "title": "Searching",
        "output": {
          "items": []
        }
      }
    },
    "delta": "hello"
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
| `properties.part.type` | string | 是 | 当前实现可见为 `text` / `tool` | 分片类型 | 宿主分片投影 | 同上 |
| `properties.part.text` | string | 否 | - | 文本内容 | 文本分片投影 | 同上 |
| `properties.part.tool` | string | 否 | - | 工具名 | 工具分片投影 | 同上 |
| `properties.part.callID` | string | 否 | - | 工具调用 ID | 工具分片投影 | 同上 |
| `properties.part.state` | object | 否 | - | 工具分片状态 | 工具分片投影 | 同上 |
| `properties.part.state.status` | string | 条件必填 | `running` / `completed` / `error` | 工具状态 | 工具分片投影 | 同上 |
| `properties.part.state.title` | string | 否 | - | 状态标题 | 工具分片投影 | 同上 |
| `properties.part.state.error` | string | 否 | - | 状态错误信息 | 工具分片投影 | 同上 |
| `properties.part.state.output` | JSON value | 否 | - | 工具输出载荷 | 工具分片投影 | 同上 |
| `properties.delta` | string | 否 | - | 文本增量 | 当前可观察行为 | 同上 |

说明：

- `state` 只在工具分片场景出现。
- `output` 作为 JSON 载荷处理，不在共享层解释内部结构。

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
| `properties.field` | string | 是 | 当前实现可见为 `text` | 增量字段 | 宿主投影 | 同上 |
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
| `properties.status.type` | string | 是 | 当前实现可见为 `busy` / `idle` | 状态类型 | 宿主投影 | 同上 |

## `session.idle`

用途：会话进入空闲态。

```json
{
  "type": "session.idle",
  "properties": {
    "sessionID": "sess-001"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `type` | string | 是 | `session.idle` | 事件类型 | 共享 validator + 当前宿主可观察行为 | 同上 |
| `properties.sessionID` | string | 是 | - | 会话 ID | 宿主投影 | 同上 |

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
    "permissionID": "perm-001",
    "status": "granted"
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
| `type` | string | 是 | `permission.updated` | 事件类型 | 共享 validator + 当前宿主可观察行为 | 同上 |
| `properties.sessionID` | string | 是 | - | 会话 ID | 宿主投影 | 同上 |
| `properties.permissionID` | string | 是 | - | 权限请求 ID，用于标识被更新的审批对象 | 宿主投影 | 同上 |
| `properties.status` | string | 是 | 当前已观察值如 `granted` / `rejected` | 权限结果状态 | 宿主投影 | 同上 |

## `permission.asked`

用途：权限请求。

```json
{
  "type": "permission.asked",
  "properties": {
    "id": "perm-001",
    "sessionID": "sess-001",
    "messageID": "msg-001",
    "type": "tool",
    "title": "Need approval",
    "metadata": {
      "source": "test"
    }
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

## `question.asked`

用途：问题请求。

```json
{
  "type": "question.asked",
  "properties": {
    "id": "question-001",
    "sessionID": "sess-001",
    "questions": [
      {
        "question": "Proceed?",
        "header": "Confirm",
        "options": [
          {
            "label": "Yes"
          }
        ]
      }
    ],
    "tool": {
      "messageID": "msg-001",
      "callID": "call-001"
    }
  }
}
```

| 字段路径 | 类型 | 必填 | 取值/枚举 | 说明 | 来源 | 参考宿主版本 |
|---|---|---|---|---|---|---|
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

`tool_event.event` 是 `gateway-wire-v1` 最重要的可观察边界。它必须显式字段化、可测试、可回滚，不能继续依赖宿主 SDK 类型直接外泄。
