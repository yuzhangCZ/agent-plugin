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
  assiantId?: string;
};

type CreateSessionPayload = {
  title?: string;
  assiantId?: string;
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
- `assiantId` is optional on `chat` and `create_session`
- when `BRIDGE_CHANNEL === 'assiant'`, `create_session` may resolve a directory by `assiantId` before falling back to `effectiveDirectory`
- `chat` forwards `assiantId` to the SDK `session.prompt(...).agent` field when present
- `assiantId` accepts only string; `null` is treated as invalid payload

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

### 3.1 Upstream Data Model

The upstream path uses three distinct models:

- `RawUpstreamEvent`
  - the original OpenCode event as received from the SDK
  - raw field paths stay owned by the upstream extractor
- `NormalizedUpstreamEvent`
  - the bridge-internal normalized event
  - contains the extracted `common` / `extra` fields plus the raw event for downstream projection
- `GatewayProjectedEvent`
  - the transport-safe upstream event shape sent through `tool_event.event`
  - owns the gateway-facing transport shape, including `message.updated` projection rules
  - current implementation lives in `src/transport/upstream/*`

The current boundary rule is:

- upstream extraction decides what the bridge can understand
- transport projection decides what the gateway can send
- runtime only orchestrates the flow between them

The bridge extracts `toolSessionId` from the normalized event and then emits:

```ts
{
  type: 'tool_event';
  toolSessionId: string;
  event: SupportedUpstreamEvent;
}
```

`message.updated` is the only current exception where bridge transport applies an upstream projector rule before send:

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
