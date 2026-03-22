# Protocol Contract

## 1. Boundary Layers

The current protocol contract is split into:

- `contracts/upstream-events.ts`
- `contracts/downstream-messages.ts`
- `contracts/transport-messages.ts`

The `protocol/` layer normalizes raw messages against these contracts.

## 2. Downstream Contract

Supported downstream message types:

- `invoke`
- `status_query`

### 2.1 `invoke`

Shape:

```ts
{
  type: 'invoke';
  welinkSessionId?: string;
  action: InvokeAction;
  payload: InvokePayloadByAction[InvokeAction];
}
```

Action-specific constraint:

- `create_session` requires a non-empty top-level `welinkSessionId`
- other `invoke` actions may omit `welinkSessionId`

Supported `action` values:

- `chat`
- `create_session`
- `close_session`
- `permission_reply`
- `abort_session`
- `question_reply`

Payloads:

```ts
type ChatPayload = {
  toolSessionId: string;
  text: string;
};

type CreateSessionPayload = {
  title?: string;
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

`create_session` also requires a non-empty top-level `welinkSessionId`; if it is missing, runtime returns `tool_error` and does not call the SDK create path.

Notes:

- `close_session` calls `session.delete()`
- `abort_session` also calls `session.abort()`
- `question_reply` resolves a pending question through the raw question API chain

### 2.1.1 `create_session.payload` Decision Narrowing

This repository is intentionally distinguishing between:

- historical implementation residue
- formal protocol contract

Formal decision:

- the formal `create_session.payload` contract is `title?: string`
- this decision is derived from the traced upstream business chain:
  - UI `CreateSessionParams`
  - skill-server `buildCreateSessionPayload(title)`
  - gateway `invoke.create_session` examples

Implementation note:

- bridge types and normalization now align to `title?: string`
- any broader residual references should be treated as historical, not current protocol

### 2.2 `status_query`

Standalone shape:

```ts
{
  type: 'status_query';
}
```

## 3. Upstream Event Contract

Supported upstream event types:

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

Default allowlist is the same exact list.

The bridge extracts `toolSessionId` from the normalized event and then emits:

```ts
{
  type: 'tool_event';
  toolSessionId: string;
  event: SupportedUpstreamEvent;
}
```

`message.updated` is the only exception where bridge transport applies a runtime projection before send:

- keep `properties.info.id/sessionID/role/time/model`
- keep `summary.additions/deletions/files`
- keep lightweight `summary.diffs[*].file/status/additions/deletions`
- drop `summary.diffs[*].before/after`

The upstream extractor still returns the full raw OpenCode event. The projection only applies to the outgoing bridge-to-gateway payload.

## 4. Transport Contract

Bridge-to-gateway transport messages:

```ts
type UpstreamMessage =
  | RegisterMessage
  | HeartbeatMessage
  | ToolEventMessage
  | ToolErrorMessage
  | SessionCreatedMessage
  | StatusResponseMessage;
```

Key shapes:

```ts
type ToolErrorMessage = {
  type: 'tool_error';
  welinkSessionId?: string;
  toolSessionId?: string;
  error: string;
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

Completion behavior:

- `chat` success may emit a compat `tool_done`
- `session.idle` continues to be forwarded upstream as `tool_event`
- when no compat completion has been emitted for the same execution, `session.idle` may trigger a fallback `tool_done`
- `create_session`, `close_session`, `abort_session`, `permission_reply`, and `question_reply` do not emit proactive `tool_done` in the current implementation

## 5. Failure Semantics

Protocol parsing is fail-closed.

Upstream normalization failure:

- log event: `event.extraction_failed`
- event is dropped

Downstream normalization failure:

- log event: `downstream.normalization_failed`
- bridge returns existing `tool_error` semantics
