# 协议契约

**Version:** 2.3
**Date:** 2026-03-30
**Status:** Active
**Owner:** message-bridge maintainers
**Related:** `../../product/prd.md`, `../../architecture/overview.md`, `./config-contract.md`

## 1. 边界层

当前协议契约拆分为：

- `contracts/upstream-events.ts`
- `contracts/downstream-messages.ts`
- `contracts/transport-messages.ts`

`protocol/` 层基于这些契约对原始消息做归一化。

## 2. 下行契约

支持的下行消息类型：

- `invoke`
- `status_query`

### 2.1 `invoke`

基本形状：

```ts
{
  type: 'invoke';
  welinkSessionId?: string;
  action: InvokeAction;
  payload: InvokePayloadByAction[InvokeAction];
}
```

action 约束：

- `create_session` 要求顶层 `welinkSessionId` 为非空字符串
- 其他 `invoke` action 可以省略 `welinkSessionId`

支持的 `action`：

- `chat`
- `create_session`
- `close_session`
- `permission_reply`
- `abort_session`
- `question_reply`

payload 形状：

```ts
type ChatPayload = {
  toolSessionId: string;
  text: string;
  assistantId?: string;
};

type CreateSessionPayload = {
  title?: string;
  assistantId?: string;
};

type CloseSessionPayload = {
  toolSessionId: string;
};

type PermissionReplyPayload = {
  permissionId: string;
  toolSessionId: string;
  response: 'once' | 'always' | 'reject';
};

type AbortSessionPayload = {
  toolSessionId: string;
};

type QuestionReplyPayload = {
  toolSessionId: string;
  answer: string;
  toolCallId?: string;
};
```

`create_session` 仍要求顶层 `welinkSessionId` 非空；若缺失，运行时会返回 `tool_error`，且不会调用 SDK 的 create 路径。

补充说明：

- `close_session` 调用 `session.delete()`
- `abort_session` 调用 `session.abort()`
- `question_reply` 通过原始 question API 链路完成待答复问题
- `assistantId` 在 `chat` 和 `create_session` 中均为可选字段
- 当最终解析后的 `gateway.channel === 'uniassistant'` 时，`create_session` 可先基于 `assistantId` 解析目录，再回退到 `effectiveDirectory`
- `chat` 在存在 `assistantId` 时，会把它透传到 SDK 的 `session.prompt(...).agent`
- `assistantId` 仅接受字符串；`null` 视为无效 payload
- 旧字段 `assiantId` 已废弃；当前会被当作未知字段静默忽略，不会触发 `agent` 透传，也不会触发目录映射

### 2.1.1 `create_session.payload` 收敛结论

仓库当前明确区分：

- 历史实现残留
- 正式协议契约

正式结论：

- `create_session.payload` 的正式契约为 `title?: string`
- 该结论来自已追踪的上游业务链路：
  - UI `CreateSessionParams`
  - skill-server `buildCreateSessionPayload(title)`
  - gateway `invoke.create_session` 示例

实现说明：

- bridge 类型定义与归一化逻辑已经与 `title?: string` 对齐
- 其余更宽的历史引用都应视为历史残留，而不是当前协议

### 2.2 `status_query`

独立形状：

```ts
{
  type: 'status_query';
}
```

## 3. 上行事件契约

支持的上行事件类型：

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

默认 allowlist 与上述列表完全一致。

### 3.1 上行数据模型

上行链路使用三层模型：

- `RawUpstreamEvent`
  - SDK 接收到的原始 OpenCode 事件
  - 原始字段路径归 upstream extractor 所有
- `NormalizedUpstreamEvent`
  - bridge 内部归一化后的事件
  - 包含提取出的 `common` / `extra` 字段，以及后续投影所需的原始事件
- `GatewayProjectedEvent`
  - 发送到 `tool_event.event` 的传输安全形状
  - 负责 gateway 面向的传输层投影规则，包括 `message.updated` 的裁剪规则
  - 当前实现位于 `src/transport/upstream/*`

当前边界规则为：

- upstream extraction 决定 bridge 能理解什么
- transport projection 决定 gateway 能发送什么
- runtime 只负责在两者之间编排

bridge 会从归一化事件中提取 `toolSessionId`，然后发出：

```ts
{
  type: 'tool_event';
  toolSessionId: string;
  event: SupportedUpstreamEvent;
}
```

`message.updated` 是当前唯一会在发送前应用上行投影规则的事件：

- 保留 `properties.info.id/sessionID/role/time/model`
- 保留 `summary.additions/deletions/files`
- 保留轻量级 `summary.diffs[*].file/status/additions/deletions`
- 丢弃 `summary.diffs[*].before/after`

upstream extractor 仍返回完整原始 OpenCode 事件；裁剪仅作用于发往 gateway 的 payload。

## 4. 传输层契约

bridge 发往 gateway 的传输消息：

```ts
type UpstreamMessage =
  | RegisterMessage
  | HeartbeatMessage
  | ToolEventMessage
  | ToolErrorMessage
  | SessionCreatedMessage
  | StatusResponseMessage;
```

关键形状：

```ts
type ToolErrorMessage = {
  type: 'tool_error';
  welinkSessionId?: string;
  toolSessionId?: string;
  error: string;
  reason?: 'session_not_found';
};

type SessionCreatedMessage = {
  type: 'session_created';
  welinkSessionId: string;
  toolSessionId?: string;
  session?: CreateSessionResultData;
};

type StatusResponseMessage = {
  type: 'status_response';
  opencodeOnline: boolean;
};
```

完成态行为：

- `chat` 成功时可能发送兼容层 `tool_done`
- `session.idle` 继续作为 `tool_event` 向上游转发
- 如果同一次执行尚未发送兼容完成态，`session.idle` 可能触发回退 `tool_done`
- 当前实现中，`create_session`、`close_session`、`abort_session`、`permission_reply`、`question_reply` 不会主动发送 `tool_done`

## 5. 失败语义

协议解析采用 fail-closed。

上行归一化失败：

- 记录日志事件：`event.extraction_failed`
- 丢弃该事件

下行归一化失败：

- 记录日志事件：`downstream.normalization_failed`
- bridge 按现有 `tool_error` 语义返回错误

`tool_error.reason` 判定边界（当前实现）：

| 错误来源 | 证据 | reason |
|---|---|---|
| `chat` 执行前置探测 | `session.get` 返回 `NotFoundError` | `session_not_found` |
| 其他 action（`create_session/close_session/abort_session/permission_reply/question_reply`） | 无会话缺失强证据 | `undefined` |
| 非会话类错误 | 不命中 `action=chat && sourceErrorCode=session_not_found*` | `undefined` |

补充说明：

1. 当前 `session_not_found` 只允许由 `chat` 错误源上报，不允许靠文案或泛化 `404` 推断。
2. 分类器做“action + 结构化证据”映射：仅 `action=chat && sourceErrorCode=session_not_found*` 命中 `reason=session_not_found`。
