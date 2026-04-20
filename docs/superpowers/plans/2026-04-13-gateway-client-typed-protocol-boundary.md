# Gateway Client Typed Protocol Boundary 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 `packages/gateway-client` 成为共享协议边界的唯一归一码，向上游插件提供 typed inbound / outbound contract，并删除 bridge 侧对共享 downstream normalize 的主路径依赖。

**架构：** 在 `gateway-client` 内新增入站 decode / parse / classify 分层和统一出站 protocol gate，先建立过渡 typed contract，再把 `message-bridge` 与 `message-bridge-openclaw` 的消费链路从 raw/shared-normalized message 迁移为 facade typed message。整个实施严格按 TDD 推进：先写失败测试验证 contract，再做最小实现，最后清理重复 normalize。

**技术栈：** TypeScript、Node.js `node:test`、Vitest 风格类型契约测试（`tsc --noEmit`）、WebSocket runtime、现有 `gateway-wire-v1`

---

## 文件结构

**创建：**
- `packages/gateway-client/src/application/protocol/InboundFrameDecoder.ts`：负责 `event.data -> GatewayInboundFrame` 的 decode / parse 失败建模。
- `packages/gateway-client/src/application/protocol/InboundProtocolAdapter.ts`：负责 parse 成功后的 protocol classify，产出 `control` / `business` / `invalid`。
- `packages/gateway-client/src/application/protocol/OutboundProtocolGate.ts`：统一校验 business outbound 与 internal control outbound。

**修改：**
- `packages/gateway-client/src/ports/GatewayClientMessages.ts`：定义过渡版 typed contract。
- `packages/gateway-client/src/ports/GatewayClient.ts`：收紧 `send()` 契约。
- `packages/gateway-client/src/ports/GatewayClientEvents.ts`：明确 `inbound` / `outbound` / `heartbeat` 语义。
- `packages/gateway-client/src/application/runtime/InboundFrameRouter.ts`：改为消费 typed envelope。
- `packages/gateway-client/src/application/handlers/BusinessMessageHandler.ts`：入参改为 `GatewayBusinessMessage`。
- `packages/gateway-client/src/application/handlers/ControlMessageHandler.ts`：入参改为 typed control message。
- `packages/gateway-client/src/application/runtime/OutboundSender.ts`：改为调用统一出站闸口。
- `packages/gateway-client/src/application/GatewayClientRuntime.ts`：装配 decoder / adapter / gate，并收紧 `send()`。
- `packages/gateway-client/src/factory/createGatewayRuntimeDependencies.ts`：注入新的 protocol 依赖。
- `packages/gateway-client/src/index.ts`：仅在需要时暴露稳定 contract。
- `plugins/message-bridge/src/runtime/BridgeRuntime.ts`：删除共享 normalize 主链路，改为消费 typed message。
- `plugins/message-bridge-openclaw/src/OpenClawGatewayBridge.ts`：删除共享 normalize 主链路，保留 facade 后 compat adapter。

**测试：**
- `packages/gateway-client/tests/gateway-client.test.ts`
- `packages/gateway-client/tests/public-api-contract.test.ts`
- `packages/gateway-client/tests/type-contracts/public-api-positive.ts`
- `packages/gateway-client/tests/type-contracts/public-api-negative.ts`
- `plugins/message-bridge/tests/unit/runtime-protocol.test.mjs`
- `plugins/message-bridge-openclaw/tests/unit/downstream-normalization.test.mjs`
- `plugins/message-bridge-openclaw/tests/unit/connection-logging.test.mjs`

### 任务 1：锁定 gateway-client 的 typed contract

**文件：**
- 修改：`packages/gateway-client/src/ports/GatewayClientMessages.ts`
- 修改：`packages/gateway-client/src/ports/GatewayClient.ts`
- 修改：`packages/gateway-client/src/ports/GatewayClientEvents.ts`
- 测试：`packages/gateway-client/tests/public-api-contract.test.ts`
- 测试：`packages/gateway-client/tests/type-contracts/public-api-positive.ts`
- 测试：`packages/gateway-client/tests/type-contracts/public-api-negative.ts`

- [ ] **步骤 1：编写失败的类型契约测试**

```ts
// packages/gateway-client/tests/type-contracts/public-api-positive.ts
import type {
  GatewayBusinessMessage,
  GatewayInboundFrame,
  GatewaySendPayload,
} from '../../src/index.ts';

const inbound: GatewayInboundFrame = { kind: 'parse_error', rawPreview: '{"bad":' };
const outbound: GatewaySendPayload = { type: 'status_response', opencodeOnline: true };
const business: GatewayBusinessMessage = { type: 'status_query' };

void inbound;
void outbound;
void business;
```

```ts
// packages/gateway-client/tests/type-contracts/public-api-negative.ts
import type { GatewaySendPayload } from '../../src/index.ts';

const invalidControl: GatewaySendPayload = {
  type: 'heartbeat',
};

void invalidControl;
```

- [ ] **步骤 2：运行类型测试验证失败**

运行：`pnpm --filter @agent-plugin/gateway-client test -- public-api-contract.test.ts`  
预期：FAIL，`GatewayInboundFrame` / `GatewaySendPayload` 仍为 `unknown`，负例无法正确拒绝 control frame。

- [ ] **步骤 3：编写最少 contract 实现**

```ts
// packages/gateway-client/src/ports/GatewayClientMessages.ts
export type GatewayBusinessMessage = DownstreamMessage;

export type GatewayInboundFrame =
  | { kind: 'decode_error'; reason: 'unsupported_binary_frame' | 'text_decode_failed'; rawPreview?: string }
  | { kind: 'parse_error'; rawPreview: string }
  | { kind: 'control'; messageType: string; message: RegisterOkMessage | RegisterRejectedMessage }
  | { kind: 'business'; messageType: string; message: GatewayBusinessMessage }
  | { kind: 'invalid'; messageType?: string; violation: WireContractViolation; rawPreview: unknown };

export type GatewaySendPayload =
  | ToolEventMessage
  | ToolDoneMessage
  | ToolErrorMessage
  | SessionCreatedMessage
  | StatusResponseMessage;
```

- [ ] **步骤 4：运行类型测试验证通过**

运行：`pnpm --filter @agent-plugin/gateway-client test -- public-api-contract.test.ts`  
预期：PASS，正例通过，负例明确拒绝 `heartbeat` / `register`。

- [ ] **步骤 5：Commit**

```bash
git add packages/gateway-client/src/ports/GatewayClientMessages.ts \
  packages/gateway-client/src/ports/GatewayClient.ts \
  packages/gateway-client/src/ports/GatewayClientEvents.ts \
  packages/gateway-client/tests/public-api-contract.test.ts \
  packages/gateway-client/tests/type-contracts/public-api-positive.ts \
  packages/gateway-client/tests/type-contracts/public-api-negative.ts
git commit -m "test(gateway-client): lock typed public protocol contracts"
```

### 任务 2：先用失败测试锁定入站 envelope，再拆 decoder / adapter / router

**文件：**
- 创建：`packages/gateway-client/src/application/protocol/InboundFrameDecoder.ts`
- 创建：`packages/gateway-client/src/application/protocol/InboundProtocolAdapter.ts`
- 修改：`packages/gateway-client/src/application/runtime/InboundFrameRouter.ts`
- 修改：`packages/gateway-client/src/application/handlers/BusinessMessageHandler.ts`
- 修改：`packages/gateway-client/src/application/handlers/ControlMessageHandler.ts`
- 修改：`packages/gateway-client/src/application/GatewayClientRuntime.ts`
- 测试：`packages/gateway-client/tests/gateway-client.test.ts`

- [ ] **步骤 1：编写失败的 runtime 测试**

```ts
test('inbound emits parse_error instead of silently dropping non-json frames', async () => {
  const inbound: unknown[] = [];
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  client.on('inbound', (message) => inbound.push(message));

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  await connecting;
  ws.onmessage?.({ data: '{bad-json' });
  await flushAsyncHandlers();

  assert.deepEqual(inbound.at(-1), { kind: 'parse_error', rawPreview: '{bad-json' });
});

test('message event only emits business envelopes after READY', async () => {
  const messages: unknown[] = [];
  const client = createGatewayClient({
    url: 'ws://localhost:8081/ws/agent',
    registerMessage: registerMessage(),
    webSocketFactory: (url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket,
  });

  client.on('message', (message) => messages.push(message));

  const connecting = client.connect();
  const ws = FakeWebSocket.instances[0]!;
  ws.emitOpen();
  await connecting;
  ws.emitMessage({ type: 'status_query' });

  assert.deepEqual(messages, [{ type: 'status_query' }]);
});
```

- [ ] **步骤 2：运行单测验证失败**

运行：`pnpm --filter @agent-plugin/gateway-client test -- gateway-client.test.ts`  
预期：FAIL，当前 router 仍直接 `JSON.parse()` 并吞掉 parse failure，`message` / `inbound` 事件仍透出 raw object。

- [ ] **步骤 3：编写最少实现代码**

```ts
// InboundFrameDecoder.ts
export class InboundFrameDecoder {
  async decode(data: string | Blob | ArrayBuffer | Uint8Array): Promise<GatewayInboundFrame> {
    if (typeof data !== 'string') {
      return { kind: 'decode_error', reason: 'unsupported_binary_frame' };
    }
    try {
      return { kind: 'parsed', value: JSON.parse(data) } as never;
    } catch {
      return { kind: 'parse_error', rawPreview: data };
    }
  }
}
```

```ts
// InboundProtocolAdapter.ts
export class InboundProtocolAdapter {
  adapt(raw: unknown): GatewayInboundFrame {
    const normalized = this.wireCodec.normalizeDownstream(raw);
    if (!normalized.ok) {
      return { kind: 'invalid', messageType: getMessageType(raw), violation: normalized.error, rawPreview: raw };
    }
    return isControlMessage(normalized.value)
      ? { kind: 'control', messageType: normalized.value.type, message: normalized.value }
      : { kind: 'business', messageType: normalized.value.type, message: normalized.value };
  }
}
```

- [ ] **步骤 4：运行单测验证通过**

运行：`pnpm --filter @agent-plugin/gateway-client test -- gateway-client.test.ts`  
预期：PASS，`inbound` 能稳定表达 `parse_error` / `control` / `business` / `invalid`，`message` 只透出 typed business message。

- [ ] **步骤 5：Commit**

```bash
git add packages/gateway-client/src/application/protocol/InboundFrameDecoder.ts \
  packages/gateway-client/src/application/protocol/InboundProtocolAdapter.ts \
  packages/gateway-client/src/application/runtime/InboundFrameRouter.ts \
  packages/gateway-client/src/application/handlers/BusinessMessageHandler.ts \
  packages/gateway-client/src/application/handlers/ControlMessageHandler.ts \
  packages/gateway-client/src/application/GatewayClientRuntime.ts \
  packages/gateway-client/tests/gateway-client.test.ts
git commit -m "test(gateway-client): move inbound decoding behind typed envelope"
```

### 任务 3：先写失败测试，再引入统一 OutboundProtocolGate

**文件：**
- 创建：`packages/gateway-client/src/application/protocol/OutboundProtocolGate.ts`
- 修改：`packages/gateway-client/src/application/runtime/OutboundSender.ts`
- 修改：`packages/gateway-client/src/application/GatewayClientRuntime.ts`
- 修改：`packages/gateway-client/src/factory/createGatewayRuntimeDependencies.ts`
- 测试：`packages/gateway-client/tests/gateway-client.test.ts`

- [ ] **步骤 1：编写失败的出站测试**

```ts
test('public send rejects heartbeat while internal heartbeat still reaches transport through one gate', async () => {
  const transport = new FakeTransport();
  const runtime = new GatewayClientRuntime(
    { url: 'ws://localhost:8081/ws/agent', registerMessage: registerMessage() },
    buildFakeDependencies({ transport }),
    createFakeSink(),
  );

  assert.throws(() => runtime.send({ type: 'heartbeat' } as never), /GATEWAY_PROTOCOL_VIOLATION|type/i);
});
```

```ts
test('internal register and heartbeat use the same outbound validation gate', async () => {
  const gateCalls: string[] = [];
  const dependencies = buildFakeDependencies({
    outboundProtocolGate: {
      validateBusiness(message) {
        gateCalls.push(`business:${message.type}`);
        return message;
      },
      validateControl(message) {
        gateCalls.push(`control:${message.type}`);
        return message;
      },
    },
  });

  // connect -> register, ready -> heartbeat
  // assert gateCalls contains control:register and control:heartbeat
});
```

- [ ] **步骤 2：运行单测验证失败**

运行：`pnpm --filter @agent-plugin/gateway-client test -- gateway-client.test.ts`  
预期：FAIL，当前 `send()` 仍可从 public path 视角接受 control frame，且 control/business 终态校验逻辑散落在 `OutboundSender`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// OutboundProtocolGate.ts
export interface OutboundProtocolGate {
  validateBusiness(message: GatewaySendPayload): GatewayBusinessOutboundMessage;
  validateControl(message: RegisterMessage | HeartbeatMessage): RegisterMessage | HeartbeatMessage;
}
```

```ts
// OutboundSender.ts
send(message: GatewaySendPayload, logContext?: GatewaySendContext): void {
  const normalizedMessage = this.outboundProtocolGate.validateBusiness(message);
  this.dispatch(normalizedMessage, false, logContext);
}

sendInternalControl(message: RegisterMessage | HeartbeatMessage): void {
  const normalizedMessage = this.outboundProtocolGate.validateControl(message);
  this.dispatch(normalizedMessage, true);
}
```

- [ ] **步骤 4：运行单测验证通过**

运行：`pnpm --filter @agent-plugin/gateway-client test -- gateway-client.test.ts`  
预期：PASS，public `send()` 无法发送 control frame，runtime 内部 control 仍可通过统一闸口发送。

- [ ] **步骤 5：Commit**

```bash
git add packages/gateway-client/src/application/protocol/OutboundProtocolGate.ts \
  packages/gateway-client/src/application/runtime/OutboundSender.ts \
  packages/gateway-client/src/application/GatewayClientRuntime.ts \
  packages/gateway-client/src/factory/createGatewayRuntimeDependencies.ts \
  packages/gateway-client/tests/gateway-client.test.ts
git commit -m "test(gateway-client): enforce unified outbound protocol gate"
```

### 任务 4：迁移 message-bridge 到 typed facade message

**文件：**
- 修改：`plugins/message-bridge/src/runtime/BridgeRuntime.ts`
- 测试：`plugins/message-bridge/tests/unit/runtime-protocol.test.mjs`

- [ ] **步骤 1：编写失败的 bridge 单测**

```js
test('handleDownstreamMessage consumes typed gateway business message without local normalize', async () => {
  const runtime = new BridgeRuntime({ client: createRuntimeClient() });
  runtime.gatewayConnection = createGatewayConnectionMock('READY');

  await runtime.handleDownstreamMessage({
    type: 'invoke',
    welinkSessionId: 'wl_1',
    action: 'chat',
    payload: { toolSessionId: 'tool_1', text: 'hello' },
  });

  assert.equal(typeof runtime.normalizeDownstreamMessage, 'undefined');
});
```

- [ ] **步骤 2：运行单测验证失败**

运行：`pnpm --filter @agent-plugin/message-bridge test -- runtime-protocol.test.mjs`  
预期：FAIL，`BridgeRuntime` 仍在 `handleDownstreamMessage(raw)` 内做共享 normalize。

- [ ] **步骤 3：编写最少实现代码**

```ts
// BridgeRuntime.ts
connection.on('message', (message) => {
  this.handleDownstreamMessage(message as GatewayBusinessMessage).catch(/* existing logging */);
});

private async handleDownstreamMessage(message: GatewayBusinessMessage): Promise<void> {
  // 删除 normalizeDownstreamMessage(raw, this.logger)
  // 直接按 typed message.type / action 分发
}
```

- [ ] **步骤 4：运行单测验证通过**

运行：`pnpm --filter @agent-plugin/message-bridge test -- runtime-protocol.test.mjs`  
预期：PASS，bridge 只保留业务 dispatch / 错误处理，不再承担共享协议解释。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/src/runtime/BridgeRuntime.ts \
  plugins/message-bridge/tests/unit/runtime-protocol.test.mjs
git commit -m "test(message-bridge): consume typed gateway business messages"
```

### 任务 5：迁移 openclaw bridge，并把 compat adapter 挪到 facade 之后

**文件：**
- 修改：`plugins/message-bridge-openclaw/src/OpenClawGatewayBridge.ts`
- 测试：`plugins/message-bridge-openclaw/tests/unit/downstream-normalization.test.mjs`
- 测试：`plugins/message-bridge-openclaw/tests/unit/connection-logging.test.mjs`

- [ ] **步骤 1：编写失败的 openclaw 测试**

```js
test('openclaw bridge applies legacy compat after typed facade message instead of raw normalize', async () => {
  const bridge = createOpenClawGatewayBridgeForTest();

  await bridge.handleDownstreamMessage({
    type: 'invoke',
    welinkSessionId: 'wl_legacy',
    action: 'create_session',
    payload: {},
  });

  assert.equal(bridge.lastCompatInput.type, 'invoke');
});
```

- [ ] **步骤 2：运行单测验证失败**

运行：`pnpm --filter @agent-plugin/message-bridge-openclaw test -- downstream-normalization.test.mjs connection-logging.test.mjs`  
预期：FAIL，`OpenClawGatewayBridge` 仍把 raw/shared-normalized message 作为主输入。

- [ ] **步骤 3：编写最少实现代码**

```ts
// OpenClawGatewayBridge.ts
connection.on('message', (message) => {
  this.handleDownstreamMessage(message as GatewayBusinessMessage).catch(/* existing logging */);
});

async handleDownstreamMessage(message: GatewayBusinessMessage): Promise<void> {
  const adapted = this.applyCompatAdapter(message);
  // status_query / invoke 分发继续沿用现有业务逻辑
}
```

- [ ] **步骤 4：运行单测验证通过**

运行：`pnpm --filter @agent-plugin/message-bridge-openclaw test -- downstream-normalization.test.mjs connection-logging.test.mjs`  
预期：PASS，typed message 成为主输入，legacy compat 仅作为 facade 后 adapter。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge-openclaw/src/OpenClawGatewayBridge.ts \
  plugins/message-bridge-openclaw/tests/unit/downstream-normalization.test.mjs \
  plugins/message-bridge-openclaw/tests/unit/connection-logging.test.mjs
git commit -m "test(openclaw): move legacy compat behind typed gateway facade"
```

### 任务 6：全链路验证与回归收口

**文件：**
- 测试：`packages/gateway-client/tests/gateway-client.test.ts`
- 测试：`packages/gateway-client/tests/public-api-contract.test.ts`
- 测试：`plugins/message-bridge/tests/unit/runtime-protocol.test.mjs`
- 测试：`plugins/message-bridge-openclaw/tests/unit/downstream-normalization.test.mjs`

- [ ] **步骤 1：运行 gateway-client 定向测试**

运行：`pnpm --filter @agent-plugin/gateway-client test`  
预期：PASS，包含 runtime、config assembly、public api contract。

- [ ] **步骤 2：运行跨插件定向测试**

运行：`pnpm --filter @agent-plugin/message-bridge test -- runtime-protocol.test.mjs`  
运行：`pnpm --filter @agent-plugin/message-bridge-openclaw test -- downstream-normalization.test.mjs connection-logging.test.mjs`  
预期：PASS，bridge 侧消费 typed facade message 后无行为回退。

- [ ] **步骤 3：运行工作区验证**

运行：`pnpm verify:workspace`  
预期：PASS，跨插件边界改动没有破坏 workspace 约束。

- [ ] **步骤 4：整理重构并确认无重复 normalize 主链路**

```bash
rg -n "normalizeDownstreamMessage\\(|normalizeDownstream\\(" \
  packages/gateway-client plugins/message-bridge plugins/message-bridge-openclaw
```

预期：只保留 `gateway-client` 协议层实现与插件私有 compat adapter，不再在两个 bridge runtime 的主接收链路中出现共享 normalize。

- [ ] **步骤 5：Commit**

```bash
git add .
git commit -m "refactor: complete typed gateway protocol boundary migration"
```

