# Solution Design

## 1. Design Decision

The current design uses an SDK runtime composition architecture:

```text
contracts -> SdkBridgeRuntime -> OpenCodeProviderAdapter -> bridge-runtime-sdk
```

This replaces the older model where plugin runtime and actions both interpreted raw protocol payloads.

## 2. Why This Design

This structure solves four concrete problems:

1. duplicated schema ownership across plugin runtime and actions
2. weak boundary visibility for upstream and downstream contracts
3. inconsistent raw field parsing across modules
4. higher regression risk when protocol fields evolve

## 3. Layer Responsibilities

### 3.1 `contracts`

Defines external interaction contracts only:

- upstream OpenCode events
- downstream gateway messages
- transport messages
- envelope

### 3.2 SDK runtime

Owns gateway protocol normalization and transport:

- downstream gateway command normalization
- runtime orchestration
- uplink transport message assembly

### 3.3 `runtime`

Owns:

- config resolution
- connection lifecycle
- provider adapter composition
- session isolation control-plane composition

It does not own gateway wire schema.

### 3.4 OpenCode provider adapter

Owns:

- OpenCode SDK calls
- raw OpenCode event to SDK fact translation
- host-specific permission/question handling

It does not own gateway transport.

## 4. Upstream Design

The upstream path is:

```text
raw OpenCode event
  -> EventFilter
  -> OpenCodeProviderAdapter
  -> bridge-runtime-sdk
  -> tool_event
```

Supported event types are explicit. There is no wildcard default allowlist.

## 5. Downstream Design

The downstream path is:

```text
raw gateway message
  -> bridge-runtime-sdk
  -> OpenCodeProviderAdapter / session isolation control plane
  -> SDK runtime response
```

Supported actions:

- `chat`
- `create_session`
- `close_session`
- `permission_reply`
- `status_query`
- `abort_session`
- `question_reply`

## 6. Compatibility Rules

The refactor preserves external behavior:

- transport message shapes remain stable
- `tool_event` remains `{ type, toolSessionId, event }`
- `tool_error`, `session_created`, `status_response` retain existing semantics
- compatibility fields such as `welinkSessionId` remain supported where already used

## 6.1 Tool Done Compatibility Design

This section defines the current `tool_done` compatibility design.

### Problem Statement

- legacy `pc-agent` emits `tool_done` as a completion signal
- the UI currently consumes `tool_done`
- forwarding `session.idle` as `tool_event` remains required, but it does not replace the compatibility contract expected by older consumers

### Architectural Position

Restoring `tool_done` is a compatibility decision, not a new core domain model.

The core facts remain:

- downstream invoke actions complete successfully
- upstream session lifecycle events such as `session.idle` and `session.status` continue to flow through the normalized event path

`tool_done` is therefore treated as a compatibility projection derived from those facts. It must not become a first-class runtime truth and must not push compatibility rules back into the `protocol` layer.

Acceptable approach:

- a dedicated compat module decides when to synthesize `tool_done`

Non-acceptable approaches:

- hardcoding `tool_done` decisions directly inside `handleEvent()`
- letting each action success branch compose its own independent `tool_done` behavior
- treating `tool_done` as the canonical completion event of the bridge

### Layer Ownership

- `contracts`
  - retain the existing `tool_done` transport shape
  - do not introduce a new completion message type
- `protocol`
  - does not decide whether `tool_done` should be emitted
  - does not encode compatibility inference rules
- `runtime`
  - invokes the compat layer at explicit lifecycle boundaries only
  - does not own the compatibility decision logic
- `runtime/compat`
  - is the single owner of `tool_done` trigger, deduplication, fallback, and compat logging
- `action`
  - continues to own SDK execution only
  - does not own compatibility event synthesis

### Trigger Model

- proactive completion trigger:
  - `chat`
- non-completion actions do not trigger `tool_done`:
  - `create_session`
  - `close_session`
  - `abort_session`
  - `permission_reply`
  - `question_reply`
- fallback trigger:
  - when upstream `session.idle` arrives and no `tool_done` has been emitted for the same execution, the compat layer emits one

### Deduplication Model

- one execution emits at most one `tool_done`
- if an action success path already emitted `tool_done`, the later `session.idle` still forwards as `tool_event` but does not emit a second `tool_done`
- if no proactive emission happened, `session.idle` becomes the fallback emission point
- deduplication state is owned only by the compat layer

### Compatibility Output Semantics

- `session.idle -> tool_event` remains unchanged
- `tool_done` is restored as a UI-facing compatibility completion signal for the current implementation
- `tool_done` does not replace `tool_event(session.idle)`; both may coexist
- `tool_done` does not require `usage` in this recovery

### Logging

SDK runtime cutover 后，插件侧不再维护独立的 `tool_done` compat 日志源；完成态投影与诊断以 SDK runtime 和 provider adapter 的当前日志为准。

## 7. Config and Distribution

Current design also keeps:

## 8. Directory Context Design

This section records the implemented design for `BRIDGE_DIRECTORY`.

### 8.1 Problem

The bridge currently uses `workspacePath` for config discovery, while the
directory context expected by SDK calls is not modeled as a single explicit
runtime concept.

### 8.2 Target-State Model

The implementation uses a three-layer single-source-of-truth model:

1. `SdkBridgeRuntime` resolves `effectiveDirectory` during SDK runtime composition
2. provider/control-plane adapters distribute `effectiveDirectory`
3. SDK runtime commands attach `directory` to supported provider requests

### 8.3 Decision Rules

- `workspacePath` remains dedicated to config discovery
- `effectiveDirectory` is resolved once using:
  1. `BRIDGE_DIRECTORY`
  2. otherwise `input.worktree || input.directory`
  3. otherwise `undefined`
- actions must not read `process.env.BRIDGE_DIRECTORY` directly
- actions must not implement their own directory fallback logic

### 8.4 Request Scope

The implementation treats `directory` as a request-context value, not a
create-only field. For bridge actions that already map to SDK methods
supporting `directory`, the same `effectiveDirectory` should be reused
consistently across related calls.

### 8.5 `create_session` Payload Decision

The formal contract for `create_session.payload` is traced from the
upstream business chain:

- UI request model
- skill-server payload construction
- gateway downstream invoke contract

Based on that chain, the formal payload is:

```ts
type CreateSessionPayload = {
  title?: string;
};
```

Historical residual fields have been removed from the bridge-side payload
contract and SDK mapping.

- multi-source config resolution with json/jsonc project and user config
- structured logging through `client.app.log()`
- single-file plugin distribution build
- plugin load verification script

## 8. Architectural Conclusion

The current design target is not just cleaner structure. It is a constraint:

- schema owner must stay inside `protocol`
- boundary contracts must stay visible inside `contracts`
- runtime must stay orchestration-only
- actions must stay execute-only

Any new upstream event or downstream action should be added by updating:

1. `contracts`
2. `protocol`
3. runtime registration
4. tests

The change must not bypass protocol normalization.
