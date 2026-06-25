# 协议契约

**Version:** 2.4
**Date:** 2026-04-04
**Status:** Active
**Owner:** message-bridge maintainers
**Related:** `../../product/prd.md`, `../../architecture/overview.md`, `./config-contract.md`, `./private-status-api-contract.md`

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
  questionId?: string;
  answers: string[][];
  answer?: string; // compat input only: legacy plain string or serialized string[][]
  toolCallId?: string;
};
```

`create_session` 仍要求顶层 `welinkSessionId` 非空；若缺失，运行时会返回 `tool_error`，且不会调用 SDK 的 create 路径。

补充说明：

- `close_session` 调用 `session.delete()`
- `abort_session` 调用 `session.abort()`
- `question_reply` 通过原始 question API 链路完成待答复问题
- `question_reply` 正式 reply target 字段是 `questionId`；历史端侧仍可通过 `toolCallId` 兼容回传
- 当 `questionId` 与 `toolCallId` 同时存在时，归一化优先使用 `questionId`
- `assistantId` 在 `chat` 和 `create_session` 中均为可选字段
- 当最终解析后的 `gateway.channel === 'uniassistant'` 时，`create_session` 可先基于 `assistantId` 解析目录，再回退到 `effectiveDirectory`
- `chat` 在存在 `assistantId` 时，会把它透传到 SDK 的 `session.prompt(...).agent`
- `assistantId` 仅接受字符串输入；`null` 视为未提供并在归一化后被省略
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

### 2.1.2 `create_session` 的 IM 群权限注入规则

在 `create_session.payload.title` 命中 IM 群前缀时，bridge 会在调用 `session.create` 时附加权限 deny 列表：

- 命中条件：`title` 以 `im-group` 开头（正则：`/^im-group/`）
- 注入字段：`permission: Array<{ permission, pattern, action }>`
- 注入策略：`pattern='*'`，`action='deny'`
- 覆盖项：
  - `bash`
  - `read`
  - `glob`
  - `grep`
  - `edit`
  - `write`
  - `task`
  - `webfetch`
  - `myAgentWebFetch`
  - `meeting*`
  - `knowledge*`
  - `playwright*`

非 IM 群会话不会附加 `permission` 字段（而不是传 `permission: undefined`）。

### 2.2 `status_query`

独立形状：

```ts
{
  type: 'status_query';
}
```

补充边界说明：

- `status_query` 属于 gateway 外部协议
- `status_response` 仍只承诺返回 `opencodeOnline:boolean`
- 当前分支新增的私有状态 API 不属于协议契约，不会扩展 `status_response`
- 如需读取 bridge 自身连接状态，应使用 `private-status-api-contract.md` 中定义的插件私有读取面

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
- `permission.replied`
- `question.asked`

默认 allowlist 与上述列表完全一致。

补充口径：

- `question.asked` 的正式 reply target 字段是 `questionId`
- `question.asked.toolCallId` 仅作为历史端侧兼容字段保留
- `question.ask` 上行投影会优先透传真实 `toolCallId`；缺失时回填 `questionId`
- `permission.asked` / `permission.ask` 不再复用 `toolCallId` 命名，正式标识仅为 `permissionId`

### 3.1 上行数据模型

上行链路使用三层模型：

- `RawUpstreamEvent`
  - SDK 接收到的原始 OpenCode 事件
  - 原始字段路径归 OpenCode provider translator 所有
- SDK fact
  - OpenCode provider 输出给 `bridge-runtime-sdk` 的内部事实
  - 负责表达 message、text、thinking、tool、permission、question 等语义
  - gateway 传输形状由 `bridge-runtime-sdk` 统一生成
  - 当前插件实现位于 `src/runtime/sdk/OpenCodeProviderAdapter.translation.ts`

当前边界规则为：

- OpenCode provider translation 决定插件能理解什么
- SDK runtime 决定 gateway 能发送什么
- 插件 runtime 只负责装配 provider、配置和 session isolation 控制面

SDK runtime 会从 provider facts 和运行时上下文中确定 `toolSessionId`，然后发出：

```ts
{
  type: 'tool_event';
  toolSessionId: string;
  event: SupportedUpstreamEvent;
}
```

补充约束：

- `toolSessionId` 只属于 `tool_event` envelope，不属于 `event` payload
- `message-bridge` 上行事件不再注入 `family: 'opencode'`
- 若后续存在 cloud/skill payload，则必须由对应写出方显式带上 `protocol: 'cloud'`

`message.updated` 是当前唯一会在发送前应用上行投影规则的事件：

- 保留 `properties.info.id/sessionID/role/time/model`
- 保留 `summary.additions/deletions/files`
- 保留轻量级 `summary.diffs[*].file/status/additions/deletions`
- 丢弃 `summary.diffs[*].before/after`

OpenCode provider 仍接收完整原始事件；裁剪仅作用于发往 gateway 的 payload。

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

- SDK runtime 普通首次 `create_session` 成功时，`session_created.toolSessionId` 直接等于 OpenCode 真实 `sessionId`
- stale / bootstrap / rebind 等恢复路径仍允许旧 `toolSessionId` 继续作为 anchor 使用
- `chat` 成功时可能发送兼容层 `tool_done`
- `session.idle` 继续作为 `tool_event` 向上游转发
- 仅当该 `toolSessionId` 已进入 compat `chat` 生命周期、且尚未完成 compat 收口时，`session.idle` 才可能触发回退 `tool_done`
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
| `chat` 执行前置探测 | `session.get` 返回其他错误或抛出其他异常 | `undefined` |
| 其他 action（`create_session/close_session/abort_session/permission_reply/question_reply`） | 无会话缺失强证据 | `undefined` |
| `chat` prompt 阶段错误 | 不命中 `action=chat && sourceOperation=session.get && sourceErrorCode=session_not_found*` | `undefined` |

补充说明：

1. `session.get` 是启动必选能力；`chat` 执行时若前置 `session.get` 失败，bridge 直接返回 `tool_error`，不再继续 `session.prompt`。
2. 当前 `session_not_found` 只允许由 `chat` 前置 `session.get` 上报，不允许靠文案、泛化 `404` 或 `session.prompt` 错误推断。
3. 分类器做“action + 结构化证据”映射：仅 `action=chat && sourceOperation=session.get && sourceErrorCode=session_not_found*` 命中 `reason=session_not_found`。
