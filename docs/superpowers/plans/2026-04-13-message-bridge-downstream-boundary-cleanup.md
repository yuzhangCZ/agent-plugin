# Message Bridge Downstream Boundary Cleanup 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 删除 `plugins/message-bridge` 下行链路里由 `gateway-wire-v1` 已经覆盖的重复共享校验，只保留插件私有 compat、错误模型与类型补齐。

**架构：** 保持 `gateway-client -> message-bridge protocol/downstream -> runtime -> action` 这条链路不变，但把 `protocol/downstream` 的职责收紧为“插件私有 compat 清洗 + 本地错误/日志模型适配”，不再重复定义共享 wire schema。`BridgeRuntime` 继续只消费 adapter 结果，并顺手清理 adapter 失败路径上的重复 warning 与脆弱的源码字符串测试。

**技术栈：** TypeScript、Node.js `node:test`、`pnpm`、现有 `gateway-wire-v1` Zod schema、`message-bridge` unit/integration tests

---

## 文件结构

**修改：**
- `plugins/message-bridge/src/gateway-wire/downstream.ts`：删除本地重复共享校验，保留 `assiantId` compat 清洗、错误映射、日志输出与 `welinkSessionId?: undefined` 类型补齐。
- `plugins/message-bridge/src/protocol/downstream/GatewayBusinessMessageAdapter.ts`：保持 adapter 仅作为插件私有边界入口，并补充注释说明“只做 compat / 本地模型转换，不重复共享 schema”。
- `plugins/message-bridge/src/runtime/BridgeRuntime.ts`：adapter 失败时不再额外记第二条 warning，只保留 `tool_error` fail-closed；继续只消费 adapter 结果。
- `plugins/message-bridge/tests/unit/downstream-message-normalizer.test.mjs`：把重复共享校验相关测试改成“行为保持、实现去重”的断言。
- `plugins/message-bridge/tests/unit/gateway-business-message-adapter.test.mjs`：锁定 adapter 的插件私有职责边界。
- `plugins/message-bridge/tests/unit/runtime-protocol.test.mjs`：删除 `toString().includes(...)` 这种脆弱断言，改成行为级测试，验证 runtime 只处理 adapter 结果且不重复 warning。

**可选修改：**
- `plugins/message-bridge/src/protocol/downstream/index.ts`：如果导出面需要精简，可只保留业务入口导出，不额外导出实现细节。

**测试：**
- `plugins/message-bridge/tests/unit/downstream-message-normalizer.test.mjs`
- `plugins/message-bridge/tests/unit/gateway-business-message-adapter.test.mjs`
- `plugins/message-bridge/tests/unit/runtime-protocol.test.mjs`

### 任务 1：先用失败测试锁定“共享层已覆盖，插件层只保留 compat”的目标行为

**文件：**
- 修改：`plugins/message-bridge/tests/unit/downstream-message-normalizer.test.mjs`
- 修改：`plugins/message-bridge/tests/unit/gateway-business-message-adapter.test.mjs`
- 修改：`plugins/message-bridge/tests/unit/runtime-protocol.test.mjs`

- [ ] **步骤 1：编写失败的 normalizer 行为测试**

```js
test('create_session missing welinkSessionId is rejected via shared schema result', () => {
  const { logger, entries } = createLogger();
  const result = normalizeDownstreamMessage(
    {
      type: 'invoke',
      action: 'create_session',
      payload: {},
    },
    logger,
  );

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'missing_required_field');
  assert.strictEqual(result.error.field, 'welinkSessionId');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].message, 'downstream.normalization_failed');
});

test('invalid assistantId is rejected while legacy assiantId is still silently dropped', () => {
  const { logger } = createLogger();

  const invalidAssistant = normalizeDownstreamMessage(
    {
      type: 'invoke',
      welinkSessionId: 'wl-1',
      action: 'chat',
      payload: { toolSessionId: 'tool-1', text: 'hello', assistantId: 123 },
    },
    logger,
  );

  const legacyAssistant = normalizeDownstreamMessage(
    {
      type: 'invoke',
      welinkSessionId: 'wl-2',
      action: 'chat',
      payload: { toolSessionId: 'tool-2', text: 'hello', assiantId: 'persona-a' },
    },
    logger,
  );

  assert.strictEqual(invalidAssistant.ok, false);
  assert.strictEqual(invalidAssistant.error.field, 'payload.assistantId');
  assert.strictEqual(legacyAssistant.ok, true);
  assert.deepStrictEqual(legacyAssistant.value.payload, {
    toolSessionId: 'tool-2',
    text: 'hello',
  });
});
```

- [ ] **步骤 2：编写失败的 runtime 行为测试**

```js
test('adapter failure emits one normalization warning and one tool_error without extra runtime warning', async () => {
  const appLogs = [];
  const runtime = new BridgeRuntime({
    client: createRuntimeClient({
      app: {
        log: async (options) => {
          appLogs.push(options.body);
          return true;
        },
      },
    }),
  });

  const sent = [];
  runtime.gatewayConnection = { send: (msg) => sent.push(msg), getStatus: () => ({ isReady: () => true }), getState: () => 'READY' };

  await runtime.handleDownstreamMessage({
    type: 'invoke',
    action: 'create_session',
    payload: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].type, 'tool_error');
  assert.strictEqual(appLogs.filter((entry) => entry.message === 'downstream.normalization_failed').length, 1);
  assert.strictEqual(appLogs.filter((entry) => entry.message === 'runtime.downstream_rejected_plugin_boundary').length, 0);
});
```

- [ ] **步骤 3：运行单测验证失败**

运行：`pnpm --dir plugins/message-bridge test -- --test-name-pattern='downstream message normalizer|gateway business message adapter|runtime protocol strictness'`  
预期：FAIL，当前 `BridgeRuntime` 仍会在 adapter 失败后再记一次 `runtime.downstream_rejected_plugin_boundary`，且现有 runtime 边界测试仍依赖 `toString().includes(...)`。

- [ ] **步骤 4：Commit 测试基线**

```bash
git add plugins/message-bridge/tests/unit/downstream-message-normalizer.test.mjs \
  plugins/message-bridge/tests/unit/gateway-business-message-adapter.test.mjs \
  plugins/message-bridge/tests/unit/runtime-protocol.test.mjs
git commit -m "test(message-bridge): lock downstream boundary ownership"
```

### 任务 2：删除 `message-bridge` 对共享 schema 的重复下行校验

**文件：**
- 修改：`plugins/message-bridge/src/gateway-wire/downstream.ts`
- 测试：`plugins/message-bridge/tests/unit/downstream-message-normalizer.test.mjs`
- 测试：`plugins/message-bridge/tests/unit/gateway-business-message-adapter.test.mjs`

- [ ] **步骤 1：移除 `prevalidateCompatibility()` 中重复共享校验**

将下面这些分支从 `prevalidateCompatibility()` 删除：

```ts
if (action === undefined) {
  return createCompatibilityError({
    code: 'missing_required_field',
    field: 'action',
    message: 'action is required',
    messageType: DOWNSTREAM_MESSAGE_TYPE.INVOKE,
    welinkSessionId,
  });
}

if (
  (action === INVOKE_ACTION.CHAT || action === INVOKE_ACTION.CREATE_SESSION) &&
  payload &&
  hasOwn(payload, 'assistantId') &&
  typeof payload.assistantId !== 'string'
) {
  return createCompatibilityError({
    code: 'invalid_field_type',
    field: 'payload.assistantId',
    message: 'payload.assistantId must be a string',
    messageType: DOWNSTREAM_MESSAGE_TYPE.INVOKE,
    action,
    welinkSessionId,
  });
}

if (
  action === INVOKE_ACTION.CREATE_SESSION &&
  typeof message.welinkSessionId === 'string' &&
  !message.welinkSessionId.trim()
) {
  return createCompatibilityError({
    code: 'missing_required_field',
    field: 'welinkSessionId',
    message: 'welinkSessionId is required',
    messageType: DOWNSTREAM_MESSAGE_TYPE.INVOKE,
    action,
    welinkSessionId: message.welinkSessionId,
  });
}
```

- [ ] **步骤 2：保留插件私有 compat 清洗与本地错误模型**

保留并确认以下代码不变：

```ts
function remapAssistantIdInput(raw: unknown): unknown {
  const message = asRecord(raw);
  if (!message || message.type !== DOWNSTREAM_MESSAGE_TYPE.INVOKE) {
    return raw;
  }

  const payload = asRecord(message.payload);
  if (!payload || !hasOwn(payload, 'assiantId')) {
    return raw;
  }

  const { assiantId: _legacyAssistantId, ...restPayload } = payload;
  return {
    ...message,
    payload: restPayload,
  };
}

export function normalizeDownstreamMessage(
  raw: unknown,
  logger?: Pick<BridgeLogger, 'warn'>,
): NormalizeResult<NormalizedDownstreamMessage> {
  const result = normalizeSharedDownstream(remapAssistantIdInput(raw));
  if (!result.ok) {
    const error = toNormalizationError(result.error);
    if (logger) {
      logDownstreamNormalizationFailure(logger, raw, error);
    }
    return { ok: false, error };
  }

  return {
    ok: true,
    value: remapAssistantIdOutput(
      result.value.type === DOWNSTREAM_MESSAGE_TYPE.INVOKE && !('welinkSessionId' in result.value)
        ? { ...result.value, welinkSessionId: undefined }
        : (result.value as NormalizedDownstreamMessage),
    ),
  };
}
```

- [ ] **步骤 3：运行受影响单测验证通过**

运行：`pnpm --dir plugins/message-bridge test -- --test-name-pattern='downstream message normalizer|gateway business message adapter'`  
预期：PASS，`create_session.welinkSessionId` / `assistantId` / `permission_reply` / `question_reply` 的失败行为保持不变，但来源统一来自共享 schema。

- [ ] **步骤 4：Commit**

```bash
git add plugins/message-bridge/src/gateway-wire/downstream.ts \
  plugins/message-bridge/tests/unit/downstream-message-normalizer.test.mjs \
  plugins/message-bridge/tests/unit/gateway-business-message-adapter.test.mjs
git commit -m "refactor(message-bridge): remove duplicated shared downstream validation"
```

### 任务 3：收紧 adapter 与 runtime 的职责边界，并清理重复 warning

**文件：**
- 修改：`plugins/message-bridge/src/protocol/downstream/GatewayBusinessMessageAdapter.ts`
- 修改：`plugins/message-bridge/src/runtime/BridgeRuntime.ts`
- 修改：`plugins/message-bridge/tests/unit/runtime-protocol.test.mjs`

- [ ] **步骤 1：把 adapter 注释与职责写死为“插件私有 compat 入口”**

```ts
/**
 * `message-bridge` 插件私有下行适配入口。
 *
 * @remarks
 * 共享 `gateway-client` 已经完成主链路 typed facade 归一化；这里仅保留
 * `message-bridge` 自身 bounded context 的 compat 清洗、本地错误模型与类型补齐，
 * 不再重复定义共享 wire schema。
 */
export function adaptGatewayBusinessMessage(
  message: GatewayBusinessMessage,
  logger?: Pick<BridgeLogger, 'warn'>,
): NormalizeResult<NormalizedDownstreamMessage> {
  return normalizeDownstreamMessage(message, logger);
}
```

- [ ] **步骤 2：删除 runtime 上的第二条 warning**

把下面这段 warning 删掉，仅保留 `sendToolError(...)` fail-closed：

```ts
if (!adaptedMessage.ok) {
  messageLogger.warn('runtime.downstream_rejected_plugin_boundary', {
    stage: adaptedMessage.error.stage,
    errorCode: adaptedMessage.error.code,
    field: adaptedMessage.error.field,
    action: adaptedMessage.error.action,
    welinkSessionId: adaptedMessage.error.welinkSessionId,
  });
  this.sendToolError(...);
  return;
}
```

修改为：

```ts
if (!adaptedMessage.ok) {
  this.sendToolError(
    this.toDownstreamValidationFailure(adaptedMessage.error),
    adaptedMessage.error.welinkSessionId ?? downstreamFields.welinkSessionId,
    {
      logger: messageLogger,
      traceId,
      gatewayMessageId: downstreamFields.gatewayMessageId,
      action: adaptedMessage.error.action ?? downstreamFields.action,
      toolSessionId: downstreamFields.toolSessionId,
    },
  );
  return;
}
```

- [ ] **步骤 3：把 runtime 的源码字符串测试换成行为测试**

删除这类断言：

```js
assert.equal(
  BridgeRuntime.prototype.handleDownstreamMessage.toString().includes('adaptGatewayBusinessMessage'),
  true,
);
```

改成黑盒行为断言：

```js
test('invalid downstream message is rejected before action routing', async () => {
  const runtime = new BridgeRuntime({ client: createRuntimeClient() });
  const sent = [];
  let routeCalls = 0;

  runtime.gatewayConnection = {
    send: (msg) => sent.push(msg),
    getStatus: () => ({ isReady: () => true }),
    getState: () => 'READY',
  };
  runtime.actionRouter = {
    route: async () => {
      routeCalls += 1;
      return { success: true };
    },
  };

  await runtime.handleDownstreamMessage({
    type: 'invoke',
    action: 'create_session',
    payload: {},
  });

  assert.strictEqual(routeCalls, 0);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].type, 'tool_error');
});
```

- [ ] **步骤 4：运行受影响单测验证通过**

运行：`pnpm --dir plugins/message-bridge test -- --test-name-pattern='runtime protocol strictness'`  
预期：PASS，runtime 仍然 fail-closed，但不再通过源码字符串证明边界，也不再重复 warning。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/src/protocol/downstream/GatewayBusinessMessageAdapter.ts \
  plugins/message-bridge/src/runtime/BridgeRuntime.ts \
  plugins/message-bridge/tests/unit/runtime-protocol.test.mjs
git commit -m "refactor(message-bridge): narrow downstream adapter and runtime boundary"
```

### 任务 4：完整验证并记录收口结果

**文件：**
- 修改：如有必要，更新 `packages/gateway-client/docs/protocol-boundary-typed-messages-design.md`
- 修改：如有必要，更新 `plugins/message-bridge/docs/architecture/overview.md`

- [ ] **步骤 1：运行完整验证**

运行：`pnpm --dir plugins/message-bridge run typecheck`  
预期：PASS

运行：`pnpm --dir plugins/message-bridge test -- --test-name-pattern='downstream message normalizer|gateway business message adapter|runtime protocol strictness'`  
预期：PASS

- [ ] **步骤 2：如代码语义变化，补文档**

若实现完成后 `protocol/downstream` 的职责已经明确收敛为“compat 清洗 + 错误模型转换”，在文档中将下面描述更新为更精确口径：

```md
- `protocol/downstream`
  - 将 gateway 下行报文归一化为强类型命令
  - 失败时记录 `downstream.normalization_failed`
```

修改为：

```md
- `protocol/downstream`
  - 接收 facade typed message 后执行插件私有 compat 清洗与本地错误模型适配
  - 不重复定义共享 `gateway-wire-v1` schema
  - 失败时记录 `downstream.normalization_failed`
```

- [ ] **步骤 3：Commit**

```bash
git add plugins/message-bridge/docs/architecture/overview.md \
  packages/gateway-client/docs/protocol-boundary-typed-messages-design.md
git commit -m "docs(message-bridge): clarify downstream boundary ownership"
```

## 自检

- 规格覆盖度：已覆盖“删除重复共享校验”“保留插件私有 compat”“runtime 只消费 adapter 结果”“去除重复 warning”“替换脆弱测试”五个目标。
- 占位符扫描：计划中没有 `TODO` / “后续实现” / “适当处理” 这类占位描述；每步都给了目标代码或命令。
- 类型一致性：整个计划统一使用 `GatewayBusinessMessageAdapter`、`normalizeDownstreamMessage`、`downstream.normalization_failed`、`GatewaySendPayload` 这些当前代码中的真实名称，没有引入未定义的新接口名。

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-04-13-message-bridge-downstream-boundary-cleanup.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点
