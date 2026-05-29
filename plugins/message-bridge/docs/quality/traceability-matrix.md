# Traceability Matrix

## 1. Architecture Constraints

| Constraint | Current implementation |
|---|---|
| Boundary contracts are explicit | `src/contracts/*` |
| Schema owner is centralized | `src/protocol/*` |
| Runtime orchestration is SDK-owned | `packages/bridge-runtime-sdk/src/application/**`; plugin composition root: `src/runtime/SdkBridgeRuntime.ts` |
| Upstream transport projection is explicit | `src/transport/upstream/*` |
| Actions are execute-only | `src/action/*` |
| Upstream allowlist is exact | `DEFAULT_EVENT_ALLOWLIST` in `contracts/upstream-events.ts` |
| Default config is centralized | `src/config/default-config.ts` |

## 2. Downstream Coverage

| Message / action | Contract | Normalizer | Action |
|---|---|---|---|
| `status_query` | `contracts/downstream-messages.ts` + `src/gateway-wire/downstream.ts` | `packages/bridge-runtime-sdk/src/adapters/gateway/GatewayDownstreamCommandAdapter.ts` | SDK runtime status response |
| `invoke/chat` | same | same | `action/ChatAction.ts` |
| `invoke/create_session` | same | same | `action/CreateSessionAction.ts` |
| `invoke/close_session` | same | same | `action/CloseSessionAction.ts` |
| `invoke/permission_reply` | same | same | `action/PermissionReplyAction.ts` |
| `invoke/status_query` | same | same | SDK runtime status response |
| `invoke/abort_session` | same | same | `action/AbortSessionAction.ts` |
| `invoke/question_reply` | same | same | `action/QuestionReplyAction.ts` |

## 3. Upstream Coverage

| Event type | Contract | Extractor |
|---|---|---|
| `message.updated` | `contracts/upstream-events.ts` | `protocol/upstream/UpstreamEventExtractor.ts` |
| `message.part.updated` | same | same |
| `message.part.delta` | same | same |
| `message.part.removed` | same | same |
| `session.status` | same | same |
| `session.idle` | same | same |
| `session.updated` | same | same |
| `session.error` | same | same |
| `permission.updated` | same | same |
| `permission.asked` | same | same |
| `question.asked` | same | same |

## 4. Verification Mapping

| Verification goal | Evidence |
|---|---|
| Type safety / unit+integration / coverage / pack check | `pnpm run verify:core` |
| Environment prerequisites and ports validation | `pnpm run verify:env` |
| Unit coverage for protocol/runtime/action | `pnpm run test:unit` |
| Coverage threshold gate (unit+integration) | `pnpm run test:coverage` |
| Distribution artifact validation | `tests/integration/plugin-distribution.test.mjs` |
| Plugin load verification | `pnpm run verify:opencode-load` |
| Release verification chain | `pnpm run verify:release` |
| Release rehearsal chain | `pnpm run verify:release:dry` |

## 5. Upstream Projection Mapping

| Event type | Projection layer | Behavior evidence |
|---|---|---|
| `message.updated` | `src/transport/upstream/DefaultUpstreamTransportProjector.ts` + `MessageUpdatedProjector.ts` | Keeps lightweight summary metadata and drops `summary.diffs[*].before/after` before websocket send |
| `message.part.updated` | `src/transport/upstream/DefaultUpstreamTransportProjector.ts` | Passes through unchanged |
| `message.part.delta` | `src/transport/upstream/DefaultUpstreamTransportProjector.ts` | Passes through unchanged |
| `message.part.removed` | `src/transport/upstream/DefaultUpstreamTransportProjector.ts` | Passes through unchanged |
| `session.status` | `src/transport/upstream/DefaultUpstreamTransportProjector.ts` | Passes through unchanged |
| `session.idle` | `src/transport/upstream/DefaultUpstreamTransportProjector.ts` | Passes through unchanged |
| `session.updated` | `src/transport/upstream/DefaultUpstreamTransportProjector.ts` | Passes through unchanged |
| `session.error` | `src/transport/upstream/DefaultUpstreamTransportProjector.ts` | Passes through unchanged |
| `permission.updated` | `src/transport/upstream/DefaultUpstreamTransportProjector.ts` | Passes through unchanged |
| `permission.asked` | `src/transport/upstream/DefaultUpstreamTransportProjector.ts` | Passes through unchanged |
| `question.asked` | `src/transport/upstream/DefaultUpstreamTransportProjector.ts` | Passes through unchanged |

## 6. PRD Alignment Addendum

| PRD requirement | Implementation | Verification |
|---|---|---|
| PRD §12 `message.updated` transport pruning keeps lightweight summary fields and drops `before/after` | `src/transport/upstream/DefaultUpstreamTransportProjector.ts` + `MessageUpdatedProjector.ts` | `tests/unit/upstream-transport-projector.test.mjs` |
| PRD §12 transport pruning must not mutate the original upstream event | `src/transport/upstream/MessageUpdatedProjector.ts` returns a projected copy before send | `tests/unit/upstream-transport-projector.test.mjs` |
| PRD §12 payload reduction must stay below the defined threshold | `src/transport/upstream/*` projects `tool_event` payload before the SDK runtime sends uplink messages | `tests/unit/upstream-transport-projector.test.mjs` |

Gate classification:

- Mandatory by default: `verify:core`
- Release gate: `verify:release`
- Environment preflight: `verify:env`
- Environment-dependent optional gates: `test:e2e`, `test:e2e:smoke`, `verify:opencode-load`
- Diagnostic-only tools: `smoke:e2e`, `debug:e2e`, `logs:fetch`

## 7. Current Conclusions

The current implementation satisfies the main refactor goal:

- raw protocol parsing is isolated to `protocol/*`
- external message shapes are isolated to `contracts/*`
- runtime orchestration is owned by `bridge-runtime-sdk`; plugin runtime only wires provider/gateway/configuration
- actions no longer own payload schema
