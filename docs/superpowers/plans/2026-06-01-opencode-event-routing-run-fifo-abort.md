# OpenCode 事件路由 Run FIFO 与 Abort 收口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `message-bridge` 的 OpenCode 上行事件归属从当前 attached owner 改为 `hostSessionId -> active run FIFO 队首`，并补齐 session 级 abort 收口与 stale invalidation 防误删。

**架构：** v1 保留 `ownershipResolver` 作为控制面和无 active run 的 outbound fallback 目标解析来源；运行中事件只按 `hostSessionId` 查队首 run。`ActiveProviderRunHandle` 继续负责单 run 的 facts/result 生命周期，新增 host queue registry 负责 run 归属、cleanup 和同 host abort 收口。

**技术栈：** TypeScript、Node.js test runner、`tsx/esm`、现有 `OpenCodeProviderAdapter` 单元测试夹具。

---

## 文件结构

- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.run.ts`
  - 扩展 `ActiveProviderRunHandle`：增加 `conversationId`、`hostSessionId`、`forceAbortAndClose(reason)` 和 facts closed guard。
  - 将现有 `ActiveRunRegistry` 迁移为 host FIFO 语义，或新增 `HostSessionRunQueueRegistry` 并替换 adapter 注入点。推荐新增类并保留 `ActiveRunRegistry` 名称的兼容导出，降低现有测试和 import 改动量。
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.types.ts`
  - 增加 `EventSessionIdentity`、`ActiveRunIdentity`、`EventRouteTarget`、`OutboundTargetResolverPort`。
  - 将现有 `anchorSessionId` 字段在类型注释中明确为实现兼容名，对应领域 `conversationId`。
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.routing.ts`
  - 让 `EventSessionIdentityResolver` 只解析 `eventSessionId` / `hostSessionId` / `trackingSessionId` / subagent 元信息，不再在 identity 阶段要求 attached owner。
  - 新增或内联 `EventRouteResolver`：按事件分类选择 `active_run` / `outbound` / `drop`。
  - 新增 `DefaultOutboundTargetResolver`：无 active run 的 `session.error` 通过 `ownershipResolver` 解析当前 `conversationId`。
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts`
  - run 创建时用 `conversationId=input.toolSessionId`、`hostSessionId=context.opencodeSessionId` 入队。
  - cleanup 只删除当前 run，并保持 host queue 与 conversation index 一致。
  - `abortSession()` 的 command port 和 fallback 两条路径都用实际被 abort 的 `hostSessionId` 收口本地队列。
  - `promptSession()` terminal 为 `aborted` 时使用 host queue abort 收口，不让 queued run 残留。
- 修改：`plugins/message-bridge/src/runtime/sdk/SdkChatControlPlane.ts`
  - 将 `ExecutionSessionInvalidationPort.invalidateAfterFailure()` 改为对象参数，携带 `conversationId`、`hostSessionId`、`error`。
  - 只有当前 binding 仍指向该 `hostSessionId` 时才 invalidate 和 detach。
- 修改：`plugins/message-bridge/src/adapter/session-isolation/runtime/SessionScopedSdkExecutionBridge.ts`
  - `abort()` 返回实际从 binding 解析到的 `hostSessionId`。
- 修改：`plugins/message-bridge/src/port/session-isolation/dto/results/ResultDtos.ts`
  - `AbortAnchoredRunResult` 的 `aborted` 分支增加 `hostSessionId`。
- 测试：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`
  - 覆盖 FIFO 路由、subagent routing、事件分类、abort 收口、terminal 行为。
- 测试：`plugins/message-bridge/tests/unit/sdk-chat-control-plane.test.mjs`
  - 覆盖 stale invalidation 的 host guard。
- 测试：`plugins/message-bridge/tests/unit/session-isolation-sdk-execution-bridge.test.mjs`
  - 覆盖 abort result 带 `hostSessionId`。

## 术语映射

| 设计术语 | 当前实现字段 | 说明 |
| --- | --- | --- |
| `conversationId` | `toolSessionId` / `anchorSessionId` | 网关侧对话 ID，facts 要回到的 runtime session |
| `hostSessionId` | `opencodeSessionId` / OpenCode `sessionID` | OpenCode 实际 prompt session |
| `eventSessionId` | `rawSessionId` | raw event 里提取的 session id |
| `trackingSessionId` | `trackingSessionId` | message/part 状态隔离 key，subagent 使用 child session |

实现时不要把 `anchorSessionId` 继续当 active run 路由 key；它只能作为 run 的 `conversationId` 兼容字段。

## 验证命令

单文件红绿验证统一使用：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-provider-adapter.test.mjs
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-chat-control-plane.test.mjs
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/session-isolation-sdk-execution-bridge.test.mjs
```

收尾验证：

```bash
pnpm --dir plugins/message-bridge run test:sdk-runtime
pnpm verify:workspace
```

---

### 任务 1：为 host FIFO registry 建立红灯测试

**文件：**
- 测试：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.run.ts`

- [ ] **步骤 1：编写失败的测试**

在 `sdk-provider-adapter.test.mjs` 增加测试，直接导入 registry 类：

```js
import {
  ActiveRunRegistry,
} from '../../src/runtime/sdk/OpenCodeProviderAdapter.run.ts';
```

新增测试：

```js
test('ActiveRunRegistry returns host session head in FIFO order and ignores stale cleanup', () => {
  const logger = createLogger();
  const cleanups = [];
  const registry = new ActiveRunRegistry();
  const first = registry.create({
    anchorSessionId: 'conversation-a',
    hostSessionId: 'host-shared',
    runId: 'run-a',
    initialTrackingSessionId: 'host-shared',
    logger,
    onCleanup: (input) => cleanups.push(input),
  });
  const second = registry.create({
    anchorSessionId: 'conversation-b',
    hostSessionId: 'host-shared',
    runId: 'run-b',
    initialTrackingSessionId: 'host-shared',
    logger,
    onCleanup: (input) => cleanups.push(input),
  });

  assert.equal(registry.getHeadByHostSession('host-shared'), first);
  assert.equal(registry.get('conversation-a'), first);
  assert.equal(registry.get('conversation-b'), second);

  assert.deepEqual(registry.deleteIfCurrentRun('conversation-a', 'stale-run'), {
    deleted: false,
    currentRunId: 'run-a',
  });
  assert.equal(registry.getHeadByHostSession('host-shared'), first);

  assert.deepEqual(registry.deleteIfCurrentRun('conversation-a', 'run-a'), {
    deleted: true,
    currentRunId: 'run-a',
  });
  assert.equal(registry.getHeadByHostSession('host-shared'), second);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-provider-adapter.test.mjs
```

预期：FAIL，报错包含 `getHeadByHostSession is not a function` 或 `hostSessionId` 参数不被 `create()` 接受。

- [ ] **步骤 3：编写最少实现代码**

在 `OpenCodeProviderAdapter.run.ts` 中扩展 `ActiveProviderRunHandle` 构造参数：

```ts
constructor(
  readonly anchorSessionId: string,
  readonly runId: string,
  initialTrackingSessionId: string,
  logger: BridgeLogger,
  private readonly onCleanup: (input: {
    anchorSessionId: string;
    runId: string;
    trackingSessionIds: ReadonlySet<string>;
  }) => void,
  readonly hostSessionId = initialTrackingSessionId,
) {
  // 保持现有初始化逻辑
}
```

更新 `ActiveRunRegistry`：

```ts
export class ActiveRunRegistry {
  private readonly handles = new Map<string, ActiveProviderRunHandle>();
  private readonly hostQueues = new Map<string, ActiveProviderRunHandle[]>();

  create(options: {
    anchorSessionId: string;
    hostSessionId?: string;
    runId: string;
    initialTrackingSessionId: string;
    logger: BridgeLogger;
    onCleanup: (input: {
      anchorSessionId: string;
      runId: string;
      trackingSessionIds: ReadonlySet<string>;
    }) => void;
  }): ActiveProviderRunHandle {
    const hostSessionId = options.hostSessionId ?? options.initialTrackingSessionId;
    const handle = new ActiveProviderRunHandle(
      options.anchorSessionId,
      options.runId,
      options.initialTrackingSessionId,
      options.logger,
      options.onCleanup,
      hostSessionId,
    );
    this.handles.set(options.anchorSessionId, handle);
    const queue = this.hostQueues.get(hostSessionId) ?? [];
    queue.push(handle);
    this.hostQueues.set(hostSessionId, queue);
    return handle;
  }

  getHeadByHostSession(hostSessionId: string): ActiveProviderRunHandle | undefined {
    return this.hostQueues.get(hostSessionId)?.[0];
  }

  deleteIfCurrentRun(anchorSessionId: string, runId: string): { deleted: boolean; currentRunId?: string } {
    const current = this.handles.get(anchorSessionId);
    if (!current) {
      return { deleted: false };
    }
    if (current.runId !== runId) {
      return { deleted: false, currentRunId: current.runId };
    }
    this.handles.delete(anchorSessionId);
    const queue = this.hostQueues.get(current.hostSessionId) ?? [];
    const nextQueue = queue.filter((handle) => handle !== current);
    if (nextQueue.length > 0) {
      this.hostQueues.set(current.hostSessionId, nextQueue);
    } else {
      this.hostQueues.delete(current.hostSessionId);
    }
    return { deleted: true, currentRunId: current.runId };
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行同一步骤 2 命令。预期：新增测试 PASS，既有测试若因构造签名报错，按默认参数兼容修正。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.run.ts
git commit -m "test: cover host session run fifo"
```

### 任务 2：实现 active run 强制 abort 收口

**文件：**
- 测试：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.run.ts`

- [ ] **步骤 1：编写失败的测试**

新增测试：

```js
test('ActiveProviderRunHandle forceAbortAndClose is idempotent and ignores later facts', async () => {
  const logger = createLogger();
  const cleanups = [];
  const registry = new ActiveRunRegistry();
  const run = registry.create({
    anchorSessionId: 'conversation-a',
    hostSessionId: 'host-a',
    runId: 'run-a',
    initialTrackingSessionId: 'host-a',
    logger,
    onCleanup: (input) => cleanups.push(input),
  });

  run.forceAbortAndClose('abort_session');
  run.forceAbortAndClose('abort_session');
  run.pushFacts({
    recognized: true,
    facts: [{ type: 'text.delta', content: 'late' }],
  });

  assert.deepEqual(await collect(run.queue), []);
  assert.deepEqual(await run.result(), { outcome: 'aborted' });
  assert.equal(cleanups.length, 1);
  assert.equal(cleanups[0].runId, 'run-a');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-provider-adapter.test.mjs
```

预期：FAIL，报错包含 `forceAbortAndClose is not a function`。

- [ ] **步骤 3：编写最少实现代码**

在 `ActiveProviderRunHandle` 中增加 guard：

```ts
private forceClosed = false;
```

修改 `pushFacts()`：

```ts
pushFacts(translation: RawEventTranslation): void {
  if (this.forceClosed || this.factsClosed) {
    return;
  }
  this.factDrainTracker.noteRelevantEvent(translation.terminalCandidateMessageId);
  for (const fact of translation.facts) {
    this.queue.push(fact);
  }
}
```

新增方法：

```ts
forceAbortAndClose(_reason: 'abort_session' | 'prompt_terminal_aborted'): void {
  if (this.forceClosed) {
    return;
  }
  this.forceClosed = true;
  this.promptTerminalResolver.settle({ outcome: 'aborted' });
  this.factsClosed = true;
  this.queue.close();
  this.settleRunIfReady();
  this.tryCleanup();
}
```

如果 `FactDrainTracker` 仍持有 timer，会在后续触发 `closeFacts()`。因为 queue close 和 cleanup 已幂等，不需要为本任务扩大改动；若测试出现 timer 泄漏，再补一个 `forceClose()` 小方法清理 timer。

- [ ] **步骤 4：运行测试验证通过**

运行同一步骤 2 命令。预期：新增测试 PASS。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.run.ts
git commit -m "feat: force close aborted provider runs"
```

### 任务 3：为 `abort()` result 返回 hostSessionId

**文件：**
- 测试：`plugins/message-bridge/tests/unit/session-isolation-sdk-execution-bridge.test.mjs`
- 修改：`plugins/message-bridge/src/port/session-isolation/dto/results/ResultDtos.ts`
- 修改：`plugins/message-bridge/src/adapter/session-isolation/runtime/SessionScopedSdkExecutionBridge.ts`

- [ ] **步骤 1：编写失败的测试**

修改现有测试 `abort resolves toolSessionId through anchor binding before calling host gateway` 的断言：

```js
assert.deepStrictEqual(await bridge.abort({ toolSessionId: 'tool-1' }), {
  kind: 'aborted',
  toolSessionId: 'tool-1',
  hostSessionId: 'ses-1',
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/session-isolation-sdk-execution-bridge.test.mjs
```

预期：FAIL，实际结果缺少 `hostSessionId`。

- [ ] **步骤 3：编写最少实现代码**

在 `ResultDtos.ts` 更新类型：

```ts
export type AbortAnchoredRunResult =
  | { kind: 'aborted'; toolSessionId: string; hostSessionId: string }
  | { kind: 'not_active'; toolSessionId: string };
```

在 `SessionScopedSdkExecutionBridge.abort()` 返回 binding session：

```ts
return {
  kind: 'aborted',
  toolSessionId: input.toolSessionId,
  hostSessionId: binding.sessionId,
};
```

- [ ] **步骤 4：运行测试验证通过**

运行同一步骤 2 命令。预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/tests/unit/session-isolation-sdk-execution-bridge.test.mjs plugins/message-bridge/src/port/session-isolation/dto/results/ResultDtos.ts plugins/message-bridge/src/adapter/session-isolation/runtime/SessionScopedSdkExecutionBridge.ts
git commit -m "feat: return aborted host session id"
```

### 任务 4：provider abortSession 成功后收口 host queue

**文件：**
- 测试：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.run.ts`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts`

- [ ] **步骤 1：编写失败的测试**

新增 command port 路径测试：

```js
test('provider adapter abortSession command port closes all runs under returned host session', async () => {
  const promptA = createDeferred();
  const promptB = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
    session: {
      prompt: async () => {
        promptCount += 1;
        return promptCount === 1 ? promptA.promise : promptB.promise;
      },
    },
    abortSessionCommandPort: {
      execute: async (input) => ({
        kind: 'aborted',
        toolSessionId: input.toolSessionId,
        hostSessionId: 'host-shared',
      }),
    },
  });

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  assert.deepEqual(await adapter.abortSession({ toolSessionId: 'conversation-b' }), { applied: true });
  assert.deepEqual(await runA.result(), { outcome: 'aborted' });
  assert.deepEqual(await runB.result(), { outcome: 'aborted' });
  assert.deepEqual(await collect(runA.facts), []);
  assert.deepEqual(await collect(runB.facts), []);
});
```

新增 fallback 路径测试：

```js
test('provider adapter abortSession fallback closes all runs under resolved host session', async () => {
  const abortCalls = [];
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
    session: {
      prompt: async () => new Promise(() => undefined),
      abort: async (input) => {
        abortCalls.push(input);
        return { data: true };
      },
    },
  });

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  assert.deepEqual(await adapter.abortSession({ toolSessionId: 'conversation-b' }), { applied: true });
  assert.equal(abortCalls.length, 1);
  assert.deepEqual(await runA.result(), { outcome: 'aborted' });
  assert.deepEqual(await runB.result(), { outcome: 'aborted' });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-provider-adapter.test.mjs
```

预期：FAIL，run result 不会 resolve 为 aborted，或第二个 run 仍挂起。

- [ ] **步骤 3：编写最少实现代码**

在 `ActiveRunRegistry` 增加：

```ts
abortAllByHostSession(
  hostSessionId: string,
  reason: 'abort_session' | 'prompt_terminal_aborted',
): ActiveProviderRunHandle[] {
  const queue = [...(this.hostQueues.get(hostSessionId) ?? [])];
  for (const handle of queue) {
    handle.forceAbortAndClose(reason);
    this.handles.delete(handle.anchorSessionId);
  }
  this.hostQueues.delete(hostSessionId);
  return queue;
}
```

在 `OpenCodeProviderAdapter.abortSession()` command port 成功分支：

```ts
this.activeRuns.abortAllByHostSession(result.hostSessionId, 'abort_session');
return { applied: true };
```

在 fallback 分支 `abortSession()` 成功后：

```ts
this.activeRuns.abortAllByHostSession(context.opencodeSessionId, 'abort_session');
return { applied: true };
```

`not_active` 和 gateway failure 分支不调用 `abortAllByHostSession()`。

- [ ] **步骤 4：运行测试验证通过**

运行同一步骤 2 命令。预期：新增两个测试 PASS。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.run.ts plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts
git commit -m "feat: abort all runs under host session"
```

### 任务 5：run 创建接入 hostSessionId

**文件：**
- 测试：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts`

- [ ] **步骤 1：编写失败的测试**

新增最小诊断测试，确认不同 `conversationId` 复用同一 host 时同属一个 host queue：

```js
test('provider adapter tracks active runs by resolved host session id', async () => {
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
    session: {
      prompt: async () => new Promise(() => undefined),
    },
  });

  await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  assert.equal(adapter.hasActiveHostSessionRunForTest?.('host-shared'), true);
});
```

本任务使用测试专用只读方法隔离 run 创建接入点；该方法不得暴露可变内部状态，只返回布尔值。

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-provider-adapter.test.mjs
```

预期：FAIL，`hasActiveHostSessionRunForTest` 不存在或返回 false。

- [ ] **步骤 3：编写最少实现代码**

修改 `createActiveRunHandle()` 签名：

```ts
private createActiveRunHandle(
  anchorSessionId: string,
  runId: string,
  hostSessionId: string,
): ActiveProviderRunHandle {
  return this.activeRuns.create({
    anchorSessionId,
    hostSessionId,
    runId,
    initialTrackingSessionId: hostSessionId,
    logger: this.logger,
    onCleanup: (cleanup) => {
      this.cleanupActiveRunState(cleanup);
    },
  });
}
```

保留已有调用：

```ts
const activeRun = this.createActiveRunHandle(
  input.toolSessionId,
  input.runId,
  preprocessed.context.opencodeSessionId,
);
```

如果采用测试专用方法，在 `OpenCodeProviderAdapter` 增加：

```ts
hasActiveHostSessionRunForTest(hostSessionId: string): boolean {
  return Boolean(this.activeRuns.getHeadByHostSession(hostSessionId));
}
```

- [ ] **步骤 4：运行测试验证通过**

运行同一步骤 2 命令。预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts
git commit -m "feat: index active runs by host session"
```

### 任务 6：普通 streaming 事件按 host FIFO 队首路由

**文件：**
- 测试：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.routing.ts`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts`

- [ ] **步骤 1：编写失败的测试**

新增测试：

```js
test('provider adapter routes shared host streaming events to fifo head despite later attached owner', async () => {
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared']],
    session: {
      prompt: async () => {
        promptCount += 1;
        return promptCount === 1 ? firstPrompt.promise : secondPrompt.promise;
      },
    },
  });

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });

  adapter.contextResolver.dependencies.bindingStore.bind('conversation-b', 'host-shared');
  adapter.contextResolver.dependencies.ownershipResolver.attach('host-shared', 'conversation-b');
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'host-shared',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  });
  firstPrompt.resolve(createPromptResponse({
    info: { id: 'msg-a' },
  }));
  const factsA = await collect(runA.facts);
  assert.equal(factsA.some((fact) => fact.type === 'message.start'), true);

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-b',
        sessionID: 'host-shared',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  });
  secondPrompt.resolve(createPromptResponse({
    info: { id: 'msg-b' },
  }));
  const factsB = await collect(runB.facts);
  assert.equal(factsB.some((fact) => fact.type === 'message.start'), true);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-provider-adapter.test.mjs
```

预期：FAIL，第一条事件被路由到 `conversation-b` 或 `runA` 没有收到 facts。

- [ ] **步骤 3：编写最少实现代码**

在 `ProviderEventCoordinator.handleEvent()` 中将：

```ts
const activeRun = this.dependencies.activeRunRegistry.get(factSessionContext.anchorSessionId);
```

替换为：

```ts
const activeRun = this.dependencies.activeRunRegistry.getHeadByHostSession(resolution.hostSessionId);
```

构造 facts context 时，`anchorSessionId` 必须来自队首 run：

```ts
const factSessionContext = this.dependencies.factRoutingContextAssembler.assemble({
  ...resolution,
  anchorSessionId: activeRun?.anchorSessionId ?? resolution.anchorSessionId,
});
```

如果 `EventSessionIdentityResolver` 当前在没有 owner 时返回 `anchor_missing`，先保持 owner 存在用例通过；无 owner fail-open 在任务 7 调整。

- [ ] **步骤 4：运行测试验证通过**

运行同一步骤 2 命令。预期：新增测试 PASS。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.routing.ts
git commit -m "feat: route streaming events to host fifo head"
```

### 任务 7：身份解析不再要求 active run 事件有 attached owner

**文件：**
- 测试：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.types.ts`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.routing.ts`

- [ ] **步骤 1：编写失败的测试**

新增测试：

```js
test('provider adapter keeps active run routing when attached owner is missing during event', async () => {
  const prompt = createDeferred();
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-a']],
    session: {
      prompt: async () => prompt.promise,
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'hello',
  });

  adapter.contextResolver.dependencies.ownershipResolver.detach('host-a');

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'host-a',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  });
  prompt.resolve(createPromptResponse({ info: { id: 'msg-a' } }));

  const facts = await collect(run.facts);
  assert.equal(facts.some((fact) => fact.type === 'message.start'), true);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-provider-adapter.test.mjs
```

预期：FAIL，日志路径为 `event_dropped_without_anchor`，facts 为空。

- [ ] **步骤 3：编写最少实现代码**

更新 `SessionIdentityResolution`：将 `anchorSessionId` 从 resolved 分支移除或改为可选。

```ts
export type SessionIdentityResolution =
  | {
      kind: 'resolved';
      rawSessionId: string;
      trackingSessionId: string;
      hostSessionId: string;
      subagentSessionId?: string;
      subagentName?: string;
    }
  | {
      kind: 'resolved_fail_open';
      rawSessionId: string;
      trackingSessionId: string;
      hostSessionId: string;
      lookupFailedCause: unknown;
    }
  | {
      kind: 'missing_session';
      rawSessionId?: string;
      reason: 'missing_event_session' | 'missing_parent_session';
      lookupFailedCause?: unknown;
    };
```

`EventSessionIdentityResolver.resolve(rawSessionId)` 对普通事件返回：

```ts
return {
  kind: 'resolved',
  rawSessionId,
  trackingSessionId: rawSessionId,
  hostSessionId: rawSessionId,
};
```

`FactRoutingContextAssembler.assemble()` 改为接收 `anchorSessionId` 参数：

```ts
assemble(input: {
  resolution: Extract<SessionIdentityResolution, { kind: 'resolved' | 'resolved_fail_open' }>;
  anchorSessionId: string;
}): FactSessionContext {
  return {
    anchorSessionId: input.anchorSessionId,
    trackingSessionId: input.resolution.trackingSessionId,
    // subagent 字段照旧
  };
}
```

在 active run 分支传 `activeRun.anchorSessionId`；outbound 分支由任务 9 的 resolver 提供。

- [ ] **步骤 4：运行测试验证通过**

运行同一步骤 2 命令。预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.types.ts plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.routing.ts
git commit -m "feat: resolve event identity without attached owner"
```

### 任务 8：subagent 事件按 parent host FIFO 路由，按 child tracking

**文件：**
- 测试：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.routing.ts`

- [ ] **步骤 1：编写失败的测试**

修改或新增测试：

```js
test('provider adapter routes subagent child event through parent host fifo head with child tracking', async () => {
  const prompt = createDeferred();
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-parent']],
    session: {
      prompt: async () => prompt.promise,
      get: async (input) => ({
        data: {
          id: input?.sessionID,
          parentID: input?.sessionID === 'host-child' ? 'host-parent' : undefined,
          title: input?.sessionID === 'host-child' ? 'worker' : 'parent',
          directory: '/workspace/test',
        },
      }),
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-child',
        sessionID: 'host-child',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  });
  prompt.resolve(createPromptResponse({ info: { id: 'msg-child' } }));

  const facts = await collect(run.facts);
  assert.equal(facts.some((fact) => fact.type === 'message.start'), true);
  assert.equal(adapter.hasAssistantMessageTrackingSession('host-child'), false);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-provider-adapter.test.mjs
```

预期：FAIL，child event 无 owner 时被 drop，或 tracking 清理不按 child session。

- [ ] **步骤 3：编写最少实现代码**

在 `EventSessionIdentityResolver` subagent mapped 分支不再调用 `eventAnchorResolver.resolveForEvent(parentSessionId)`，直接返回：

```ts
return {
  kind: 'resolved',
  rawSessionId,
  trackingSessionId: rawSessionId,
  hostSessionId: resolution.mapping.parentSessionId,
  subagentSessionId: resolution.mapping.childSessionId,
  ...(resolution.mapping.agentName ? { subagentName: resolution.mapping.agentName } : {}),
};
```

active run 分支已经通过 `hostSessionId` 找队首 run，因此 child event 会进入 parent host queue。

- [ ] **步骤 4：运行测试验证通过**

运行同一步骤 2 命令。预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.routing.ts
git commit -m "feat: route subagent events through parent host fifo"
```

### 任务 9：事件分类与 outbound fallback 边界

**文件：**
- 测试：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.types.ts`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.routing.ts`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts`

- [ ] **步骤 1：编写失败的测试**

新增测试，覆盖无 active run 的 assistant streaming drop：

```js
test('provider adapter drops assistant streaming event when no active host run exists', async () => {
  const logs = [];
  const adapter = createAdapter({
    logger: createCapturingLogger(logs),
    bindings: [['conversation-a', 'host-a']],
  });

  assert.equal(await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-orphan',
        sessionID: 'host-a',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  }), false);
});
```

新增测试，覆盖 `session.error` outbound fallback：

```js
test('provider adapter routes session.error to outbound owner when no active host run exists', async () => {
  const outboundCalls = [];
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-a']],
  });
  await adapter.initialize({
    outbound: {
      emitOutboundMessage: async (input) => {
        outboundCalls.push({
          toolSessionId: input.toolSessionId,
          messageId: input.messageId,
          facts: await collect(input.facts),
        });
      },
    },
  });

  assert.equal(await adapter.handleEvent({
    type: 'session.error',
    properties: {
      sessionID: 'host-a',
      error: { message: 'boom' },
    },
  }), true);
  assert.equal(outboundCalls[0].toolSessionId, 'conversation-a');
  assert.deepEqual(outboundCalls[0].facts.map((fact) => fact.type), ['error']);
});
```

新增测试，覆盖 active run 存在时 `session.error` 不走 outbound：

```js
test('provider adapter routes session.error to active host run before outbound fallback', async () => {
  const outboundCalls = [];
  const prompt = createDeferred();
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-a']],
    session: {
      prompt: async () => prompt.promise,
    },
  });
  await adapter.initialize({
    outbound: {
      emitOutboundMessage: async (input) => outboundCalls.push(input),
    },
  });
  const run = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'hello',
  });

  await adapter.handleEvent({
    type: 'session.error',
    properties: {
      sessionID: 'host-a',
      error: { message: 'boom' },
    },
  });
  prompt.resolve(createPromptResponse());

  const facts = await collect(run.facts);
  assert.equal(facts.some((fact) => fact.type === 'error'), true);
  assert.deepEqual(outboundCalls, []);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-provider-adapter.test.mjs
```

预期：FAIL，`session.error` 可能仍依赖 translator 自带 `toolSessionId`，或 active run/drop 分支不符合分类。

- [ ] **步骤 3：编写最少实现代码**

在 `OpenCodeProviderAdapter.types.ts` 增加：

```ts
export type EventRouteTarget =
  | { kind: 'active_run'; run: ActiveProviderRunHandle; anchorSessionId: string }
  | { kind: 'outbound'; anchorSessionId: string; reason: 'attached_owner' }
  | { kind: 'drop'; reason: 'missing_active_run' | 'missing_outbound_target' | 'unsupported_event' | 'missing_session_identity' };
```

在 routing 文件增加分类函数：

```ts
function classifyEvent(type: BridgeEvent['type']):
  | 'run_scoped'
  | 'run_scoped_with_outbound_fallback'
  | 'run_adjacent_metadata'
  | 'control_metadata'
  | 'unsupported' {
  switch (type) {
    case 'message.updated':
    case 'message.part.delta':
    case 'message.part.updated':
    case 'question.asked':
    case 'permission.asked':
      return 'run_scoped';
    case 'session.error':
      return 'run_scoped_with_outbound_fallback';
    case 'session.updated':
    case 'permission.replied':
      return 'run_adjacent_metadata';
    case 'session.created':
    case 'session.deleted':
      return 'control_metadata';
    default:
      return 'unsupported';
  }
}
```

在 `ProviderEventCoordinator` 构造依赖增加 `outboundTargetResolver`，最小实现：

```ts
export class DefaultOutboundTargetResolver {
  constructor(private readonly dependencies: { eventAnchorResolver: EventAnchorResolver }) {}

  resolve(hostSessionId: string): { anchorSessionId: string } | undefined {
    const resolved = this.dependencies.eventAnchorResolver.resolveForEvent(hostSessionId);
    return resolved?.anchor ? { anchorSessionId: resolved.anchor } : undefined;
  }
}
```

路由规则：

```ts
const eventClass = classifyEvent(event.type);
const activeRun = this.dependencies.activeRunRegistry.getHeadByHostSession(resolution.hostSessionId);
if (activeRun && eventClass !== 'control_metadata' && eventClass !== 'unsupported') {
  // active_run translator path
}
if (eventClass === 'run_scoped_with_outbound_fallback') {
  const outboundTarget = this.dependencies.outboundTargetResolver.resolve(resolution.hostSessionId);
  if (!outboundTarget) {
    return false;
  }
  // outbound translator path with outboundTarget.anchorSessionId
}
return false;
```

translator 不再负责选择目标；如果 outbound translator 返回 `toolSessionId`，用 resolver 的 `anchorSessionId` 覆盖 emit input。

- [ ] **步骤 4：运行测试验证通过**

运行同一步骤 2 命令。预期：PASS，既有 `permission.replied`、`session.updated` active run 测试仍通过。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.types.ts plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.routing.ts plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts
git commit -m "feat: separate event routing from outbound targeting"
```

### 任务 10：prompt terminal aborted 触发同 host 收口

**文件：**
- 测试：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts`

- [ ] **步骤 1：编写失败的测试**

新增测试：

```js
test('provider adapter aborts all host runs when prompt terminal is aborted', async () => {
  let promptCount = 0;
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
    session: {
      prompt: async () => {
        promptCount += 1;
        return promptCount === 1 ? firstPrompt.promise : secondPrompt.promise;
      },
    },
  });

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  firstPrompt.resolve({
    success: true,
    data: { terminal: { kind: 'aborted' } },
  });

  assert.deepEqual(await runA.result(), { outcome: 'aborted' });
  assert.deepEqual(await runB.result(), { outcome: 'aborted' });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-provider-adapter.test.mjs
```

预期：FAIL，runB 不会 resolve 或 host queue 未清空。

- [ ] **步骤 3：编写最少实现代码**

在 `bindPromptTerminal()` 成功分支中，记录日志后增加分支：

```ts
if (promptResult.data.terminal.kind === 'aborted') {
  this.activeRuns.abortAllByHostSession(context.opencodeSessionId, 'prompt_terminal_aborted');
  return;
}
activeRun.settlePromptTerminal(toProviderTerminalResult(promptResult.data.terminal));
```

避免对当前 run 同时执行 `abortAllByHostSession()` 和 `activeRun.settlePromptTerminal()`；后续幂等仍保留作为防线。

- [ ] **步骤 4：运行测试验证通过**

运行同一步骤 2 命令。预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts
git commit -m "feat: close host queue on aborted prompt terminal"
```

### 任务 11：completed / failed terminal 只 cleanup 当前 run

**文件：**
- 测试：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.run.ts`

- [ ] **步骤 1：编写失败的测试**

新增测试：

```js
test('provider adapter completed terminal only advances fifo head for current run', async () => {
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    bindings: [['conversation-a', 'host-shared'], ['conversation-b', 'host-shared']],
    session: {
      prompt: async () => {
        promptCount += 1;
        return promptCount === 1 ? firstPrompt.promise : secondPrompt.promise;
      },
    },
  });

  const runA = await adapter.runMessage({
    traceId: 'trace-a',
    runId: 'run-a',
    toolSessionId: 'conversation-a',
    text: 'first',
  });
  const runB = await adapter.runMessage({
    traceId: 'trace-b',
    runId: 'run-b',
    toolSessionId: 'conversation-b',
    text: 'second',
  });

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-a',
        sessionID: 'host-shared',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  });
  firstPrompt.resolve(createPromptResponse({ info: { id: 'msg-a' } }));
  await runA.result();

  await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-b',
        sessionID: 'host-shared',
        role: 'assistant',
        time: { created: Date.now() },
      },
    },
  });
  secondPrompt.resolve(createPromptResponse({ info: { id: 'msg-b' } }));
  const factsB = await collect(runB.facts);
  assert.equal(factsB.some((fact) => fact.type === 'message.start'), true);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-provider-adapter.test.mjs
```

预期：FAIL，如果 cleanup 删除了错误 run 或 host queue 未 advance，第二条事件无法进入 runB。

- [ ] **步骤 3：编写最少实现代码**

确认 `cleanupActiveRunState()` 仍使用：

```ts
const result = this.activeRuns.deleteIfCurrentRun(input.anchorSessionId, input.runId);
```

并且 `deleteIfCurrentRun()` 只从当前 handle 的 host queue 删除当前对象，不清空整个 host queue。

- [ ] **步骤 4：运行测试验证通过**

运行同一步骤 2 命令。预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.run.ts
git commit -m "test: cover fifo advancement after terminal"
```

### 任务 12：stale invalidation 必须携带 hostSessionId

**文件：**
- 测试：`plugins/message-bridge/tests/unit/sdk-chat-control-plane.test.mjs`
- 修改：`plugins/message-bridge/src/runtime/sdk/SdkChatControlPlane.ts`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts`
- 修改：`plugins/message-bridge/src/runtime/SdkBridgeRuntime.ts`
- 可能修改：其它直接调用 `invalidateAfterFailure` 的测试或类型位置

- [ ] **步骤 1：编写失败的测试**

在 `sdk-chat-control-plane.test.mjs` 增加：

```js
test('DefaultExecutionSessionInvalidationPort does not invalidate binding switched to another host session', () => {
  const bindingStore = new InMemoryToolSessionBindingStore();
  const ownershipResolver = new InMemoryOpencodeSessionOwnershipResolver();
  bindingStore.bind('conversation-a', 'host-old');
  ownershipResolver.attach('host-old', 'conversation-a');
  bindingStore.bind('conversation-a', 'host-new');
  ownershipResolver.detach('host-old');
  ownershipResolver.attach('host-new', 'conversation-a');

  const port = new DefaultExecutionSessionInvalidationPort({
    bindingStore,
    ownershipResolver,
  });

  port.invalidateAfterFailure({
    conversationId: 'conversation-a',
    hostSessionId: 'host-old',
    error: {
      errorEvidence: {
        sourceOperation: 'session.prompt',
        sourceErrorCode: 'session_not_found',
      },
    },
  });

  assert.equal(bindingStore.get('conversation-a')?.status, 'active');
  assert.equal(bindingStore.get('conversation-a')?.activeOpencodeSessionId, 'host-new');
  assert.equal(ownershipResolver.resolveAttachedAnchor('host-new'), 'conversation-a');
});
```

修改既有 `DefaultExecutionSessionInvalidationPort only invalidates stale binding evidence` 测试的调用：

```js
port.invalidateAfterFailure({
  conversationId: 'anchor-5',
  hostSessionId: 'ses-5',
  error: {
    errorEvidence: {
      sourceOperation: 'session.prompt',
      sourceErrorCode: 'session_not_found',
    },
  },
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-chat-control-plane.test.mjs
```

预期：FAIL，旧接口不接受对象参数或仍 invalidate 新 binding。

- [ ] **步骤 3：编写最少实现代码**

修改接口：

```ts
export interface ExecutionSessionInvalidationPort {
  invalidateAfterFailure(input: {
    conversationId: string;
    hostSessionId: string;
    error: unknown;
  }): void;
}
```

修改实现：

```ts
invalidateAfterFailure(input: {
  conversationId: string;
  hostSessionId: string;
  error: unknown;
}): void {
  const evidence = this.extractEvidence(input.error);
  if (evidence.sourceErrorCode !== 'session_not_found') {
    return;
  }
  if (evidence.sourceOperation !== 'session.get' && evidence.sourceOperation !== 'session.prompt') {
    return;
  }
  const binding = this.dependencies.bindingStore.get(input.conversationId);
  if (!binding || binding.activeOpencodeSessionId !== input.hostSessionId) {
    return;
  }
  this.dependencies.bindingStore.invalidate(input.conversationId);
  this.dependencies.ownershipResolver.detach(input.hostSessionId);
}
```

修改 `OpenCodeProviderAdapter.bindPromptTerminal()` 两个调用点：

```ts
this.executionSessionInvalidationPort.invalidateAfterFailure({
  conversationId: input.toolSessionId,
  hostSessionId: context.opencodeSessionId,
  error: promptResult,
});
```

和：

```ts
this.executionSessionInvalidationPort.invalidateAfterFailure({
  conversationId: input.toolSessionId,
  hostSessionId: context.opencodeSessionId,
  error,
});
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-chat-control-plane.test.mjs
```

预期：PASS。

- [ ] **步骤 5：运行 provider adapter 测试确认接口迁移完整**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-provider-adapter.test.mjs
```

预期：PASS。若 TypeScript runtime 报旧签名调用，逐个迁移，不保留旧签名重载。

- [ ] **步骤 6：Commit**

```bash
git add plugins/message-bridge/tests/unit/sdk-chat-control-plane.test.mjs plugins/message-bridge/src/runtime/sdk/SdkChatControlPlane.ts plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts plugins/message-bridge/src/runtime/SdkBridgeRuntime.ts
git commit -m "fix: guard stale invalidation by host session"
```

### 任务 13：收尾验证和回归清理

**文件：**
- 检查：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.run.ts`
- 检查：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.routing.ts`
- 检查：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts`
- 检查：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`

- [ ] **步骤 1：搜索旧路由 key 使用**

运行：

```bash
rg -n "activeRunRegistry\\.get\\(|invalidateAfterFailure\\(|resolveForEvent\\(|anchor_missing|event_dropped_without_anchor" plugins/message-bridge/src plugins/message-bridge/tests/unit
```

预期：
- active run routing 不再使用 `activeRunRegistry.get(factSessionContext.anchorSessionId)`。
- `invalidateAfterFailure()` 没有旧的双参数调用。
- `anchor_missing` 只用于 outbound fallback 缺目标或控制面兼容日志，不阻断 active run。

- [ ] **步骤 2：运行 focused tests**

运行：

```bash
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-provider-adapter.test.mjs
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/sdk-chat-control-plane.test.mjs
pnpm --dir plugins/message-bridge exec node --import tsx/esm --test --test-force-exit tests/unit/session-isolation-sdk-execution-bridge.test.mjs
```

预期：三条命令全部 PASS。

- [ ] **步骤 3：运行 SDK runtime 回归**

运行：

```bash
pnpm --dir plugins/message-bridge run test:sdk-runtime
```

预期：PASS。

- [ ] **步骤 4：运行 workspace 验证**

运行：

```bash
pnpm verify:workspace
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/src/runtime/sdk plugins/message-bridge/tests/unit
git commit -m "test: cover opencode fifo abort routing regressions"
```

---

## 自检

- 规格覆盖：
  - 同 host FIFO 路由：任务 1、5、6、11。
  - attached owner 不影响运行中事件归属：任务 6、7。
  - subagent parent host routing + child tracking：任务 8。
  - `session.error` active run 优先与 outbound fallback：任务 9。
  - `permission.replied`、`session.updated` active run 保持：任务 9 要求保留既有测试。
  - `abort_session` 成功后同 host 全 run aborted：任务 3、4。
  - TUI/外部 aborted terminal 同 host 收口：任务 10。
  - completed/failed terminal 只影响当前 run：任务 11。
  - `forceAbortAndClose()` 幂等、关闭 queue、忽略后续 facts：任务 2。
  - 无 active run assistant event drop：任务 9。
  - stale invalidation 不误删新 binding：任务 12。
- 红旗词检查：本计划没有使用模糊任务描述；每个代码相关任务都包含测试、失败预期、最小实现和验证命令。
- 类型一致性：
  - `conversationId` 在代码兼容字段中仍写作 `anchorSessionId` / `toolSessionId`。
  - `hostSessionId` 在 prompt context 中来自 `context.opencodeSessionId`，在 raw event 中来自 OpenCode `sessionID`。
  - abort result 的 `hostSessionId` 必须来自实际 abort binding 或 fallback resolved context。
