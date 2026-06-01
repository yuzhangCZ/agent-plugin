# Traceability Matrix

## 1. Architecture Constraints

| Constraint | Current implementation |
|---|---|
| Boundary contracts are explicit | `src/contracts/*` |
| Gateway schema owner is SDK-owned | `packages/bridge-runtime-sdk/src/adapters/gateway/*` |
| Runtime orchestration is SDK-owned | `packages/bridge-runtime-sdk/src/application/**`; plugin composition root: `src/runtime/SdkBridgeRuntime.ts` |
| OpenCode event translation is provider-owned | `src/runtime/sdk/OpenCodeProviderAdapter.translation.ts` |
| Provider actions are SDK-owned | `packages/bridge-runtime-sdk/src/application/**`; OpenCode host operations in `src/runtime/sdk/OpenCodeProviderAdapter.ts` and session-isolation use cases |
| Upstream allowlist is exact | `DEFAULT_EVENT_ALLOWLIST` in `contracts/upstream-events.ts` |
| Default config is centralized | `src/config/default-config.ts` |

## 2. Downstream Coverage

| Message / action | Contract | Normalizer | Action |
|---|---|---|---|
| `status_query` | `contracts/downstream-messages.ts` | `packages/bridge-runtime-sdk/src/adapters/gateway/GatewayDownstreamCommandAdapter.ts` | SDK runtime status response |
| `invoke/chat` | same | same | `src/runtime/sdk/OpenCodeProviderAdapter.ts` |
| `invoke/create_session` | same | same | `src/runtime/sdk/OpenCodeProviderAdapter.ts` + session-isolation command port |
| `invoke/close_session` | same | same | session-isolation command port |
| `invoke/permission_reply` | same | same | session-isolation command port |
| `invoke/status_query` | same | same | SDK runtime status response |
| `invoke/abort_session` | same | same | session-isolation command port |
| `invoke/question_reply` | same | same | session-isolation command port |

## 3. Upstream Coverage

| Event type | Contract | Extractor |
|---|---|---|
| `message.updated` | `contracts/upstream-events.ts` | `runtime/sdk/OpenCodeProviderAdapter.translation.ts` |
| `message.part.updated` | same | same |
| `message.part.delta` | same | same |
| `message.part.removed` | same | same |
| `session.status` | same | SDK runtime/provider path |
| `session.idle` | same | SDK runtime/provider path |
| `session.updated` | same | SDK runtime/provider path |
| `session.error` | same | `runtime/sdk/OpenCodeProviderAdapter.translation.ts` |
| `permission.updated` | same | SDK runtime/provider path |
| `permission.asked` | same | `runtime/sdk/OpenCodeProviderAdapter.translation.ts` |
| `question.asked` | same | `runtime/sdk/OpenCodeProviderAdapter.translation.ts` |

## 4. Verification Mapping

| Verification goal | Evidence |
|---|---|
| Type safety / unit+integration / coverage / pack check | `pnpm run verify:core` |
| Environment prerequisites and ports validation | `pnpm run verify:env` |
| Unit coverage for SDK runtime/provider/session isolation | `pnpm run test:unit` |
| Coverage threshold gate (unit+integration) | `pnpm run test:coverage` |
| Distribution artifact validation | `tests/integration/plugin-distribution.test.mjs` |
| Plugin load verification | `pnpm run verify:opencode-load` |
| Release verification chain | `pnpm run verify:release` |
| Release rehearsal chain | `pnpm run verify:release:dry` |

## 5. OpenCode Event Translation Mapping

| Event type | Translation layer | Behavior evidence |
|---|---|---|
| `message.updated` | `src/runtime/sdk/OpenCodeProviderAdapter.translation.ts` | Emits SDK message facts; terminal events are closed by provider state |
| `message.part.updated` | same | Emits text/thinking/tool facts based on OpenCode part shape |
| `message.part.delta` | same | Emits delta facts only when the message is open |
| `message.part.removed` | same | Emits removal/terminal facts when applicable |
| `session.error` | same | Emits SDK session error facts |
| `permission.asked` | same | Emits permission ask facts |
| `question.asked` | same | Emits question ask facts |

## 6. PRD Alignment Addendum

| PRD requirement | Implementation | Verification |
|---|---|---|
| PRD §12 uplink payload stays SDK-owned after runtime cutover | `packages/bridge-runtime-sdk/src/application/**` owns gateway uplink assembly | `pnpm run test:bridge:sdk-runtime` |
| OpenCode raw event translation remains plugin-owned | `src/runtime/sdk/OpenCodeProviderAdapter.translation.ts` emits SDK facts | `tests/unit/sdk-provider-adapter.test.mjs` |
| Session isolation commands remain plugin-owned | `src/runtime/sdk/session-isolation/*` and `src/usecase/session-isolation/*` | `tests/unit/session-isolation-*.test.mjs` |

Gate classification:

- Mandatory by default: `verify:core`
- Release gate: `verify:release`
- Environment preflight: `verify:env`
- Environment-dependent optional gates: `test:e2e`, `test:e2e:smoke`, `verify:opencode-load`
- Diagnostic-only tools: `smoke:e2e`, `debug:e2e`, `logs:fetch`

## 7. Current Conclusions

The current implementation satisfies the main refactor goal:

- gateway protocol parsing is owned by `bridge-runtime-sdk`
- external message shapes are isolated to `contracts/*`
- runtime orchestration is owned by `bridge-runtime-sdk`; plugin runtime only wires provider/gateway/configuration
- legacy action router no longer owns payload schema
