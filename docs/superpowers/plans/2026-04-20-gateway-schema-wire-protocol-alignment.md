# Gateway Schema Wire Protocol Alignment 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 `@agent-plugin/gateway-schema`、`gateway-client`、`plugins/message-bridge`、`plugins/message-bridge-openclaw` 与仓库文档重新对齐 current-state 协议术语，并把 `GatewayWireProtocol` 收敛为独立 protocol root，而不是继续挂在方向性模块上。

**架构：** 协议层拆成三个稳定边界：`downstream.ts` 只定义 `GatewayDownstreamBusinessRequest`，`upstream.ts` 只定义 `GatewayUplinkBusinessMessage`、`GatewayTransportControlMessage` 与方向明确的 `GatewayUpstreamTransportMessage`，新增 `wire-protocol.ts` 作为 `GatewayWireProtocol` 的独立总入口。`gateway-client` 继续承担协议校验职责，但主链路只使用方向明确的入口；`validateGatewayWireProtocolMessage()` 保留为 schema 顶层 umbrella 校验入口，主要服务于测试、审计、调试和文档契约。

**技术栈：** TypeScript、Zod、Node.js `node:test`、`pnpm`、workspace 包 `@agent-plugin/gateway-schema`、`@agent-plugin/gateway-client`

---

## 文件结构

**创建：**
- `packages/gateway-schema/src/contract/schemas/wire-protocol.ts`
  `GatewayWireProtocol` 的独立 protocol root；组合 downstream 与 upstream transport 边界。
- `packages/gateway-schema/src/application/usecases/validate-gateway-upstream-transport-message.ts`
  方向明确的上行 transport 校验 use case。

**修改：**
- `packages/gateway-schema/src/contract/schemas/upstream.ts`
  保持单向语义，只导出 uplink business、transport control 与 `GatewayUpstreamTransportMessage`。
- `packages/gateway-schema/src/contract/schemas/downstream.ts`
  继续只承接 `GatewayDownstreamBusinessRequest`。
- `packages/gateway-schema/src/contract/index.ts`
  暴露新的 `wire-protocol.ts` 与 `GatewayUpstreamTransportMessage` 相关导出。
- `packages/gateway-schema/src/application/ports/transport-message-validator-port.ts`
  返回类型改为 `GatewayUpstreamTransportMessage`。
- `packages/gateway-schema/src/application/usecases/validate-gateway-wire-protocol-message.ts`
  改成 protocol-root 路由入口，只负责 umbrella 校验与单次失败上报。
- `packages/gateway-schema/src/application/usecases/validate-gateway-transport-message.ts`
  作为旧命名入口删除或重命名到 `validate-gateway-upstream-transport-message.ts`，不保留并存双入口。
- `packages/gateway-schema/src/adapters/validators/transport-message-validator.ts`
  继续只校验上行 transport 范围，但类型与注释改为 upstream-only。
- `packages/gateway-schema/src/adapters/facade/gateway-schema-facade.ts`
  暴露 `validateGatewayUpstreamTransportMessage()`，移除 `validateGatewayTransportMessage()` 旧公开方法，并保留 `validateGatewayWireProtocolMessage()` 作为顶层入口。
- `packages/gateway-schema/src/index.ts`
  同步透出新的正式导出。
- `packages/gateway-client/src/ports/GatewayWireCodec.ts`
  增加 `validateGatewayUpstreamTransportMessage()`，删除 `validateGatewayTransportMessage()`，保留 `validateGatewayWireProtocolMessage()` 但不作为主链路默认入口。
- `packages/gateway-client/src/adapters/GatewaySchemaCodecAdapter.ts`
  对接新的 schema facade 方法，并删除旧 `validateGatewayTransportMessage()` 实现。
- `packages/gateway-client/src/application/protocol/InboundProtocolAdapter.ts`
  控制帧校验改用 upstream transport validator，不再借用 umbrella validator。
- `packages/gateway-client/src/application/protocol/OutboundProtocolGate.ts`
  `validateControl()` 改用 `validateGatewayUpstreamTransportMessage()`。
- `plugins/message-bridge/src/gateway-wire/transport.ts`
  用新的 upstream-only 正式术语替换旧公开命名，并同步更新类型守卫与 re-export。
- `plugins/message-bridge/src/gateway-wire/tool-event.ts`
  保持与共享 schema 的正式术语一致，避免继续暴露历史 alias 语义。
- `plugins/message-bridge/src/gateway-wire/downstream.ts`
  审视并收紧 `export * from '@agent-plugin/gateway-schema'` 带来的公共面，确保硬切后导出术语一致。
- `plugins/message-bridge-openclaw/src/gateway-wire/transport.ts`
  删除把 `UpstreamMessage` 当共享正式术语的 re-export，切换到方向明确的正式类型。
- `plugins/message-bridge-openclaw/src/gateway-wire/tool-event.ts`
  删除 `GatewayToolEvent` 这类模糊 alias，使用 `GatewayToolEventPayload`。
- `packages/test-support/tests/gateway-wire-contracts.test.mjs`
  文档路径、断言文本与术语同步从 `gateway-wire-v1` 收口到 `gateway-schema`。
- `docs/architecture/gateway-schema-architecture.md`
  明确 `GatewayWireProtocol` 位于独立 protocol root，而不是 `upstream.ts`。
- `docs/architecture/gateway-wire-v1-architecture.md`
  降级为历史页或跳转页，不再承载 current-state 主语义。
- `docs/design/gateway-wire-v1-module-design.md`
  降级为历史页或跳转页。
- `docs/design/interfaces/gateway-wire-v1-event-contract.md`
  改成历史引用说明，不再作为当前主契约文档。

**测试：**
- `packages/gateway-schema/tests/transport-contract.test.ts`
- `packages/gateway-schema/tests/wire-contract.test.ts`
- `packages/gateway-client/tests/gateway-client.test.ts`
- `packages/test-support/tests/gateway-wire-contracts.test.mjs`
- `packages/gateway-schema` / `packages/gateway-client` / wrappers 中所有测试标题、断言文本与 fake codec 方法名
  一次性从 `GatewayTransportMessage` / `validateGatewayTransportMessage` 切到 upstream-only 新术语。
- `plugins/message-bridge/tests/unit/gateway-wire.test.mjs`
- `plugins/message-bridge-openclaw` 受影响测试

## 关键决策

- `GatewayWireProtocol` 继续保留并公开，但它是独立 protocol root 的 umbrella term，不再由 `upstream.ts` 反向承载。
- 不引入过宽的 `GatewayTransportMessage`；统一使用方向明确的：
  - `gatewayUpstreamTransportMessageSchema`
  - `GatewayUpstreamTransportMessage`
  - `validateGatewayUpstreamTransportMessage`
- `validateGatewayWireProtocolMessage()` 保留，但定位明确为：
  - current-state 全量协议 umbrella 校验
  - 契约测试、调试、审计工具入口
  - 文档与架构术语真源
- `gateway-client` 主链路只使用方向明确的三个入口：
  - `normalizeDownstream()`
  - `validateGatewayUplinkBusinessMessage()`
  - `validateGatewayUpstreamTransportMessage()`
- 公共命名采用一次性硬切：
  - 废弃 `GatewayTransportMessage`
  - 废弃 `validateGatewayTransportMessage()`
  - 不保留公共兼容别名
- 一次性硬切同时适用于：
  - use case 文件名
  - facade 方法名
  - codec 端口名
  - adapter 方法名
  - 测试标题、断言文本、fake codec stub 名称
- 插件私有 compat 命名可以保留，但跨包共享边界、wrapper re-export、文档主术语不得继续用 `UpstreamMessage`、`GatewayToolEvent` 之类模糊 alias。
- wrapper 迁移范围显式覆盖：
  - `plugins/message-bridge`
  - `plugins/message-bridge-openclaw`

---

### 任务 1：先用失败测试锁定 protocol root 与 upstream-only 边界

**文件：**
- 修改：`packages/gateway-schema/tests/transport-contract.test.ts`
- 修改：`packages/gateway-schema/tests/wire-contract.test.ts`
- 修改：`packages/gateway-client/tests/gateway-client.test.ts`

- [ ] **步骤 1：编写失败的 schema 测试，锁定 `GatewayWireProtocol` 是独立 umbrella union**

```ts
test('gatewayWireProtocolSchema accepts downstream, uplink business, and control frames', () => {
  const cases = [
    { type: 'status_query' },
    {
      type: 'invoke',
      welinkSessionId: 'wl-1',
      action: 'chat',
      payload: { toolSessionId: 'tool-1', text: 'hello' },
    },
    { type: 'status_response', opencodeOnline: true },
    { type: 'heartbeat', timestamp: '2026-03-30T00:00:00.000Z' },
  ];

  for (const message of cases) {
    assert.equal(gatewayWireProtocolSchema.safeParse(message).success, true, message.type);
  }
});
```

- [ ] **步骤 2：编写失败的 schema 测试，锁定 `GatewayUpstreamTransportMessage` 是 upstream-only**

```ts
test('validateGatewayUpstreamTransportMessage rejects downstream requests', () => {
  const result = validateGatewayUpstreamTransportMessage({
    type: 'status_query',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.violation.code, 'unsupported_message');
});
```

- [ ] **步骤 3：编写失败的 `gateway-client` 测试，锁定 control path 不再借用 umbrella validator**

```ts
test('validateControl uses upstream transport validation instead of the umbrella validator', () => {
  let upstreamTransportValidationCount = 0;
  let wireValidationCount = 0;
  const fallbackCodec = new GatewaySchemaCodecAdapter();

  const gate = new DefaultOutboundProtocolGate({
    normalizeDownstream: fallbackCodec.normalizeDownstream.bind(fallbackCodec),
    validateGatewayUplinkBusinessMessage: fallbackCodec.validateGatewayUplinkBusinessMessage.bind(fallbackCodec),
    validateGatewayUpstreamTransportMessage(raw) {
      upstreamTransportValidationCount += 1;
      return fallbackCodec.validateGatewayUpstreamTransportMessage(raw);
    },
    validateGatewayWireProtocolMessage(raw) {
      wireValidationCount += 1;
      return fallbackCodec.validateGatewayWireProtocolMessage(raw);
    },
  });

  gate.validateControl(registerMessage());

  assert.equal(upstreamTransportValidationCount > 0, true);
  assert.equal(wireValidationCount, 0);
});
```

- [ ] **步骤 4：运行测试验证失败**

运行：`pnpm --filter @agent-plugin/gateway-schema test`
预期：FAIL，`wire-protocol.ts` 与 `validateGatewayUpstreamTransportMessage()` 尚未落地。

运行：`pnpm --filter @agent-plugin/gateway-client test`
预期：FAIL，当前公开命名与计划要求的 upstream-only 术语仍不一致。

- [ ] **步骤 5：Commit**

```bash
git add \
  packages/gateway-schema/tests/transport-contract.test.ts \
  packages/gateway-schema/tests/wire-contract.test.ts \
  packages/gateway-client/tests/gateway-client.test.ts
git commit -m "test(protocol): lock protocol root and upstream transport boundaries"
```

---

### 任务 2：重组 `gateway-schema` contract root，建立独立 `wire-protocol.ts`

**文件：**
- 创建：`packages/gateway-schema/src/contract/schemas/wire-protocol.ts`
- 修改：`packages/gateway-schema/src/contract/schemas/upstream.ts`
- 修改：`packages/gateway-schema/src/contract/schemas/downstream.ts`
- 修改：`packages/gateway-schema/src/contract/index.ts`
- 修改：`packages/gateway-schema/src/index.ts`
- 测试：`packages/gateway-schema/tests/wire-contract.test.ts`

- [ ] **步骤 1：新增 protocol root 文件，只在这里定义 `GatewayWireProtocol`**

```ts
import { z } from 'zod';

import { gatewayDownstreamBusinessRequestSchema } from './downstream.ts';
import { gatewayUpstreamTransportMessageSchema } from './upstream.ts';

export const gatewayWireProtocolSchema = z.union([
  gatewayDownstreamBusinessRequestSchema,
  gatewayUpstreamTransportMessageSchema,
]);

export type GatewayWireProtocol = z.output<typeof gatewayWireProtocolSchema>;
```

- [ ] **步骤 2：把 `upstream.ts` 收敛成单向语义**

```ts
export const gatewayUpstreamTransportMessageSchema = z.union([
  gatewayTransportControlMessageSchema,
  gatewayUplinkBusinessMessageSchema,
]);

export type GatewayUpstreamTransportMessage = z.output<typeof gatewayUpstreamTransportMessageSchema>;
```

- [ ] **步骤 3：补充对外导出，避免消费者继续从方向错误的模块拿 umbrella 类型**

```ts
export * from './schemas/downstream.ts';
export * from './schemas/upstream.ts';
export * from './schemas/wire-protocol.ts';
```

- [ ] **步骤 4：运行 schema 契约测试确认通过**

运行：`pnpm --filter @agent-plugin/gateway-schema test -- --test-name-pattern "wire|transport"`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add \
  packages/gateway-schema/src/contract/schemas/wire-protocol.ts \
  packages/gateway-schema/src/contract/schemas/upstream.ts \
  packages/gateway-schema/src/contract/schemas/downstream.ts \
  packages/gateway-schema/src/contract/index.ts \
  packages/gateway-schema/src/index.ts \
  packages/gateway-schema/tests/wire-contract.test.ts
git commit -m "refactor(schema): introduce wire protocol root"
```

---

### 任务 3：对齐 validator、facade 与 codec 端口命名

**文件：**
- 修改：`packages/gateway-schema/src/application/ports/transport-message-validator-port.ts`
- 修改：`packages/gateway-schema/src/application/usecases/validate-gateway-transport-message.ts`
- 创建：`packages/gateway-schema/src/application/usecases/validate-gateway-upstream-transport-message.ts`
- 修改：`packages/gateway-schema/src/application/usecases/validate-gateway-wire-protocol-message.ts`
- 修改：`packages/gateway-schema/src/adapters/validators/transport-message-validator.ts`
- 修改：`packages/gateway-schema/src/adapters/facade/gateway-schema-facade.ts`
- 修改：`packages/gateway-client/src/ports/GatewayWireCodec.ts`
- 修改：`packages/gateway-client/src/adapters/GatewaySchemaCodecAdapter.ts`
- 测试：`packages/gateway-schema/tests/transport-contract.test.ts`
- 测试：`packages/gateway-client/tests/gateway-client.test.ts`

- [ ] **步骤 1：把 transport validator 端口返回类型收窄成 `GatewayUpstreamTransportMessage`**

```ts
export interface TransportMessageValidatorPort {
  validate(raw: UnknownBoundaryInput): Result<GatewayUpstreamTransportMessage, WireContractViolation>;
}
```

- [ ] **步骤 2：新增 upstream-only use case**

```ts
export function validateGatewayUpstreamTransportMessageUseCase(
  input: ValidateGatewayUpstreamTransportMessageInput,
  deps: ValidateGatewayUpstreamTransportMessageDeps,
): Result<GatewayUpstreamTransportMessage, WireContractViolation> {
  const result = deps.validator.validate(input.raw);
  if (!result.ok) {
    deps.reporter.report(result.error.violation);
  }
  return result;
}
```

- [ ] **步骤 3：删除旧 `validate-gateway-transport-message.ts` 命名入口，不保留并存双入口**

```ts
// 旧文件 `validate-gateway-transport-message.ts` 改名为：
// `validate-gateway-upstream-transport-message.ts`
// 所有引用同步切换到新文件与新导出名。
```

- [ ] **步骤 4：把 umbrella use case 改成 protocol-root 路由入口，只上报一次最终失败**

```ts
export function validateGatewayWireProtocolMessageUseCase(
  input: ValidateGatewayWireProtocolMessageInput,
  deps: ValidateGatewayWireProtocolMessageDeps,
): Result<GatewayWireProtocol, WireContractViolation> {
  const raw = input.raw;

  if (typeof raw === 'object' && raw !== null && 'type' in raw) {
    const type = String((raw as { type?: unknown }).type);
    if (type === 'status_query' || type === 'invoke') {
      const downstream = deps.downstreamNormalizer.normalize(raw);
      if (!downstream.ok) deps.reporter.report(downstream.error.violation);
      return downstream;
    }
  }

  const upstream = deps.transportValidator.validate(raw);
  if (!upstream.ok) deps.reporter.report(upstream.error.violation);
  return upstream;
}
```

- [ ] **步骤 5：在 facade 与 codec 上暴露方向明确的新入口，并删除旧公共方法**

```ts
validateGatewayUpstreamTransportMessage(raw: UnknownBoundaryInput): Result<GatewayUpstreamTransportMessage, WireContractViolation>
```

- [ ] **步骤 6：运行受影响测试确认通过**

运行：`pnpm --filter @agent-plugin/gateway-schema test`
预期：PASS

运行：`pnpm --filter @agent-plugin/gateway-client test`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add \
  packages/gateway-schema/src/application/ports/transport-message-validator-port.ts \
  packages/gateway-schema/src/application/usecases/validate-gateway-transport-message.ts \
  packages/gateway-schema/src/application/usecases/validate-gateway-upstream-transport-message.ts \
  packages/gateway-schema/src/application/usecases/validate-gateway-wire-protocol-message.ts \
  packages/gateway-schema/src/adapters/validators/transport-message-validator.ts \
  packages/gateway-schema/src/adapters/facade/gateway-schema-facade.ts \
  packages/gateway-client/src/ports/GatewayWireCodec.ts \
  packages/gateway-client/src/adapters/GatewaySchemaCodecAdapter.ts
git commit -m "refactor(protocol): align upstream transport validation interfaces"
```

---

### 任务 4：迁移 `gateway-client` 与 wrapper 到新术语

**文件：**
- 修改：`packages/gateway-client/src/application/protocol/InboundProtocolAdapter.ts`
- 修改：`packages/gateway-client/src/application/protocol/OutboundProtocolGate.ts`
- 修改：`plugins/message-bridge/src/gateway-wire/transport.ts`
- 修改：`plugins/message-bridge/src/gateway-wire/tool-event.ts`
- 修改：`plugins/message-bridge/src/gateway-wire/downstream.ts`
- 修改：`plugins/message-bridge-openclaw/src/gateway-wire/transport.ts`
- 修改：`plugins/message-bridge-openclaw/src/gateway-wire/tool-event.ts`
- 修改：`plugins/message-bridge-openclaw/src/OpenClawGatewayBridge.ts`
- 测试：`packages/gateway-client/tests/gateway-client.test.ts`
- 测试：`plugins/message-bridge/tests/unit/gateway-wire.test.mjs`
- 测试：`plugins/message-bridge-openclaw` 受影响测试

- [ ] **步骤 1：`gateway-client` 主链路切换到方向明确入口**

```ts
// InboundProtocolAdapter
const validation = this.wireCodec.validateGatewayUpstreamTransportMessage(raw);

// OutboundProtocolGate
const validation = this.wireCodec.validateGatewayUpstreamTransportMessage(message);
```

- [ ] **步骤 2：wrapper 层去掉模糊共享 alias**

```ts
// plugins/message-bridge/src/gateway-wire/transport.ts
export {
  gatewayUpstreamTransportMessageSchema,
  type GatewayUpstreamTransportMessage,
  type GatewayUplinkBusinessMessage,
} from '@agent-plugin/gateway-schema';
```

- [ ] **步骤 3：同步迁移两个 wrapper，并保留插件内部 compat 命名但不再对跨包 API 外泄**

```ts
// 仅在插件内部文件继续保留 DownstreamMessage / compat alias，
// 不再从 plugins/message-bridge 或 plugins/message-bridge-openclaw 的 gateway-wire wrapper re-export。
```

- [ ] **步骤 4：运行 client 与两个 wrapper 相关测试**

运行：`pnpm --filter @agent-plugin/gateway-client test`
预期：PASS

运行：`pnpm --filter @agent-plugin/message-bridge test -- --test-name-pattern "gateway-wire"`
预期：PASS

运行：`pnpm verify:workspace`
预期：PASS，至少确认 schema、client、wrapper 协同无回归。

- [ ] **步骤 5：统一硬切测试标题、断言文本与 fake codec 方法名**

```ts
test('validateGatewayUpstreamTransportMessage rejects downstream requests', ...)
```

```ts
validateGatewayUpstreamTransportMessage(raw) {
  return fallbackCodec.validateGatewayUpstreamTransportMessage(raw);
}
```

- [ ] **步骤 6：Commit**

```bash
git add \
  packages/gateway-client/src/application/protocol/InboundProtocolAdapter.ts \
  packages/gateway-client/src/application/protocol/OutboundProtocolGate.ts \
  plugins/message-bridge/src/gateway-wire/transport.ts \
  plugins/message-bridge/src/gateway-wire/tool-event.ts \
  plugins/message-bridge/src/gateway-wire/downstream.ts \
  plugins/message-bridge-openclaw/src/gateway-wire/transport.ts \
  plugins/message-bridge-openclaw/src/gateway-wire/tool-event.ts \
  plugins/message-bridge-openclaw/src/OpenClawGatewayBridge.ts \
  packages/gateway-client/tests/gateway-client.test.ts
git commit -m "refactor(client): use explicit upstream transport terminology"
```

---

### 任务 5：同步文档与历史页降级

**文件：**
- 修改：`packages/test-support/tests/gateway-wire-contracts.test.mjs`
- 修改：`docs/architecture/gateway-schema-architecture.md`
- 修改：`docs/architecture/gateway-wire-v1-architecture.md`
- 修改：`docs/design/gateway-wire-v1-module-design.md`
- 修改：`docs/design/interfaces/gateway-wire-v1-event-contract.md`

- [ ] **步骤 1：把主文档术语改成 protocol root + directional boundaries**

```md
- `GatewayWireProtocol` 位于独立 `wire-protocol.ts`
- `upstream.ts` / `downstream.ts` 只是方向性子边界
- `validateGatewayWireProtocolMessage()` 是 umbrella 校验入口，不是 `gateway-client` 主链路 API
```

- [ ] **步骤 2：把 `gateway-wire-v1` 文档降级为历史页**

```md
本页仅保留历史背景与迁移说明；current-state 主契约请参见 `gateway-schema` 文档。
```

- [ ] **步骤 3：更新测试与文档引用路径**

```js
assert.match(docPath, /gateway-schema/);
assert.doesNotMatch(docPath, /gateway-wire-v1/);
```

- [ ] **步骤 4：运行文档/契约相关测试**

运行：`pnpm --filter @agent-plugin/gateway-schema test`
预期：PASS

运行：`pnpm verify:workspace`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add \
  packages/test-support/tests/gateway-wire-contracts.test.mjs \
  docs/architecture/gateway-schema-architecture.md \
  docs/architecture/gateway-wire-v1-architecture.md \
  docs/design/gateway-wire-v1-module-design.md \
  docs/design/interfaces/gateway-wire-v1-event-contract.md
git commit -m "docs(protocol): align gateway schema terminology"
```

---

## 自检

- 覆盖度：已覆盖 protocol root 重组、upstream-only 命名、validator/facade/codec 迁移、client/wrapper 主链路迁移、文档历史页降级。
- 已锁定一次性硬切公共命名，不再要求为 `GatewayTransportMessage` / `validateGatewayTransportMessage()` 设计兼容别名。
- 占位符扫描：未使用 “TODO/待定/后续实现/类似任务” 之类占位语。
- 类型一致性：统一使用 `GatewayWireProtocol`、`GatewayUpstreamTransportMessage`、`validateGatewayUpstreamTransportMessage()`、`validateGatewayWireProtocolMessage()` 这组命名，没有保留 `GatewayTransportMessage`。
