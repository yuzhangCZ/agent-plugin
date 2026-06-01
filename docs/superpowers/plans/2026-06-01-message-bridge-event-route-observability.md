# message-bridge 事件路由可观测性实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 基于当前代码补齐 `message-bridge` 下行事件路由链路的关键日志与 TSDoc，让事件被接收、翻译、路由、丢弃和 fallback 的原因都可定位，同时保持现有 FIFO run 调度语义不变。

**架构：** 保持现有 `OpenCodeProviderAdapter -> HostSessionRunCoordinator -> ProviderEventCoordinator -> translators -> ActiveProviderRunHandle/outbound` 架构不变。只在 coordinator 的决策边界增加结构化 debug 日志，在协议异常继续使用 warn，在插件/runtime/prompt 异常继续使用 error；TSDoc 聚焦导出 port、导出状态类型、路由器、translator 和 run handle 的职责边界。

**技术栈：** TypeScript、Node test runner、`tsx/esm`、现有 `BridgeLogger` 和 `sdk-provider-adapter.test.mjs`。

---

## 当前代码审查结论

- `plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs` 已有 `createCapturingLogger(logs)`，不要再新增同名 helper；新测试应复用它，按 `logs.filter((entry) => entry.level === 'debug')` 断言。
- 当前已有路由诊断日志：`provider_adapter.event.received`、`provider_adapter.event.translation`、`provider_adapter.event.routed_to_active_run`、`provider_adapter.event.routed_to_outbound`、`provider_adapter.session_isolation_event_observed`。
- 当前 run 队列缺少调度日志：`HostSessionRunCoordinator` 的 enqueue、drain start/skip/end、prompt start、queue shift、unexpected work throw 当前不可观测；`ActiveRunRegistry` 的 supersede/abort queue 处理也缺少结构化日志。
- 当前缺口仍然存在：`ProviderEventCoordinator` 在缺 raw session、无 active run、非 fallback 事件、无 runtime context、无 outbound target、outbound translation 为空时直接 `return false`，没有统一 drop reason。
- `session.updated` 缺 title 当前会通过 `DefaultTranslationObservationPort` 记录 warn，但现有测试名写着 `silently` 且断言 `warnings=[]`；这条行为需要明确为“无 active run 的 detached metadata 先 drop，不进入 translator”，避免新增 drop 日志时误触 warning。
- `HostSessionRunCoordinator` 已有 TSDoc，`ActiveProviderRunHandle` 已新增 prompt start/task finished 状态；计划中的 run TSDoc 必须覆盖这些状态，不能沿用旧版“只等 prompt terminal 与 facts drain”的描述。
- `OpenCodeProviderAdapter.types.ts`、`OpenCodeProviderAdapter.routing.ts`、`OpenCodeProviderAdapter.translation.ts` 的导出类型/类仍基本缺少 TSDoc，是主要注释修复面。

## 文件结构

- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.routing.ts`
  - 增加 drop/fallback 决策日志。
  - 给导出路由类补中文 TSDoc。
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.types.ts`
  - 给导出类型和 port 补中文 TSDoc，说明 `anchorSessionId`、`trackingSessionId`、`hostSessionId` 语义。
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.run.ts`
  - 给导出状态 store、run handle、registry 补 TSDoc。
  - 增加 registry 队列变更的 debug 日志。
  - 注释必须包含当前 prompt FIFO scheduler、`promptStarted`、`promptTaskFinished` 与 cleanup 关系。
- 修改：`plugins/message-bridge/src/runtime/sdk/HostSessionRunCoordinator.ts`
  - 增加 host session FIFO 调度过程的 debug/error 日志。
  - 保持同一 host session 串行 prompt 启动语义不变。
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts`
  - 将 logger 传给 `HostSessionRunCoordinator` 和 `ActiveRunRegistry` 相关创建路径。
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.translation.ts`
  - 给 translator registry 和各导出 translator 补 TSDoc。
  - 不改变 raw event -> fact 映射。
- 测试：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`
  - 复用现有 `createCapturingLogger(logs)`。
  - 扩展已有 ignore/fallback 用例，增加日志级别和丢弃原因回归。

## 日志级别基线

- `debug`：高频、预期内的路由状态、run 队列状态和丢弃原因。例如 `event.received`、`event.translation`、`routed_to_active_run`、`routed_to_outbound`、`event.dropped`、`run_queue.enqueued`、`run_queue.drain_started`。
- `info`：低频生命周期和重要业务阶段。例如 runtime start/stop、run prepare、prompt started/completed。
- `warn`：协议异常、状态不一致、可恢复降级。例如缺少 message id、没有 open message、subagent lookup fail-open、fact drain timeout。
- `error`：捕获到的异常或不可恢复生命周期失败。例如插件 event hook 抛错、runtime 初始化失败、prompt throw。

该基线下，新增的“没有 active run”“无 outbound target”“translation 空结果”等不是系统异常，应使用 `debug`；`subagent_lookup_failed` 保持 `warn`，因为它触发 fail-open 降级。
run 队列中正常的 enqueue/drain/shift/supersede/abort queue 处理也使用 `debug`；只有 scheduler work 在 `HostSessionRunCoordinator` 层意外 throw 时使用 `error`，因为这是被捕获的异常边界。

---

### 任务 1：为路由丢弃原因增加回归测试

**文件：**
- 修改：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`

- [ ] **步骤 1：复用现有日志采集 helper**

确认文件顶部已有：

```js
function createCapturingLogger(logs) {
  const write = (level) => (message, extra) => {
    logs.push({ level, message, extra });
  };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: () => createCapturingLogger(logs),
    getTraceId: () => 'trace-test',
  };
}
```

不要新增另一个 `createCapturingLogger()`。每个新测试使用：

```js
const logs = [];
const logger = createCapturingLogger(logs);
const debugs = logs.filter((entry) => entry.level === 'debug');
const warnings = logs.filter((entry) => entry.level === 'warn');
const errors = logs.filter((entry) => entry.level === 'error');
```

- [ ] **步骤 2：新增缺少 raw session id 的 drop 日志测试**

在 `provider adapter records received upstream event routing diagnostics` 附近新增：

```js
test('provider adapter logs debug drop reason when event has no raw session identity', async () => {
  const logs = [];
  const adapter = createAdapter({ logger: createCapturingLogger(logs) });

  const handled = await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-missing-session',
        role: 'assistant',
      },
    },
  });

  const debugs = logs.filter((entry) => entry.level === 'debug');
  const warnings = logs.filter((entry) => entry.level === 'warn');
  const errors = logs.filter((entry) => entry.level === 'error');
  assert.equal(handled, false);
  assert.equal(warnings.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.event.dropped'
    && entry.extra?.eventType === 'message.updated'
    && entry.extra?.dropReason === 'missing_raw_session_id'), true);
});
```

- [ ] **步骤 3：扩展现有无 active run 测试**

修改现有 `provider adapter ignores message.updated when no active run owns it`：

```js
test('provider adapter ignores message.updated when no active run owns it', async () => {
  const logs = [];
  const adapter = createAdapter({ logger: createCapturingLogger(logs) });

  const handled = await adapter.handleEvent({
    type: 'message.updated',
    properties: {
      info: {
        sessionID: 'tool-session-42',
        id: 'msg-42',
        role: 'assistant',
        time: {
          created: '2026-05-22T12:00:00.000Z',
          completed: '2026-05-22T12:00:01.000Z',
        },
        finish: 'stop',
      },
    },
  });

  const debugs = logs.filter((entry) => entry.level === 'debug');
  const warnings = logs.filter((entry) => entry.level === 'warn');
  const errors = logs.filter((entry) => entry.level === 'error');
  assert.strictEqual(handled, false);
  assert.equal(warnings.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.event.dropped'
    && entry.extra?.eventType === 'message.updated'
    && entry.extra?.rawSessionId === 'tool-session-42'
    && entry.extra?.messageId === 'msg-42'
    && entry.extra?.dropReason === 'missing_active_run'), true);
});
```

- [ ] **步骤 4：新增 `session.error` 无 runtime context 的 drop 日志测试**

该分支当前也会直接返回 false，需要单独覆盖：

```js
test('provider adapter logs debug drop reason when session.error has no runtime context', async () => {
  const logs = [];
  const adapter = createAdapter({ logger: createCapturingLogger(logs) });

  const handled = await adapter.handleEvent({
    type: 'session.error',
    properties: {
      sessionID: 'host-no-runtime-context',
      error: 'boom',
    },
  });

  const debugs = logs.filter((entry) => entry.level === 'debug');
  const warnings = logs.filter((entry) => entry.level === 'warn');
  const errors = logs.filter((entry) => entry.level === 'error');
  assert.equal(handled, false);
  assert.equal(warnings.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.event.dropped'
    && entry.extra?.eventType === 'session.error'
    && entry.extra?.rawSessionId === 'host-no-runtime-context'
    && entry.extra?.dropReason === 'missing_runtime_context'), true);
});
```

- [ ] **步骤 5：新增 `session.error` 无 outbound target 的 drop 日志测试**

```js
test('provider adapter logs debug drop reason when session.error has no outbound target', async () => {
  const logs = [];
  const adapter = createAdapter({ logger: createCapturingLogger(logs) });
  await adapter.initialize({
    outbound: {
      emitOutboundMessage: async () => {
        throw new Error('unexpected outbound call');
      },
    },
  });

  const handled = await adapter.handleEvent({
    type: 'session.error',
    properties: {
      sessionID: 'host-detached',
      error: 'boom',
    },
  });

  const debugs = logs.filter((entry) => entry.level === 'debug');
  const warnings = logs.filter((entry) => entry.level === 'warn');
  const errors = logs.filter((entry) => entry.level === 'error');
  assert.equal(handled, false);
  assert.equal(warnings.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.event.dropped'
    && entry.extra?.eventType === 'session.error'
    && entry.extra?.rawSessionId === 'host-detached'
    && entry.extra?.dropReason === 'missing_outbound_target'), true);
});
```

- [ ] **步骤 6：运行测试验证失败**

运行：

```bash
pnpm --dir plugins/message-bridge test:sdk-runtime
```

预期：新增/扩展的 drop 日志断言失败，原因是当前实现没有 `provider_adapter.event.dropped`。

---

### 任务 2：在 `ProviderEventCoordinator` 增加结构化 drop 日志

**文件：**
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.routing.ts`
- 测试：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`

- [ ] **步骤 1：增加 drop reason 类型和日志 helper**

在 `EventRoutingState` 附近增加：

```ts
type EventDropReason =
  | 'missing_raw_session_id'
  | 'missing_active_run'
  | 'unsupported_event'
  | 'missing_runtime_context'
  | 'missing_outbound_target'
  | 'empty_outbound_translation';
```

在 `ProviderEventCoordinator` 内、`logEventReceived` 附近增加：

```ts
  private logEventDropped(input: {
    event: BridgeEvent;
    reason: EventDropReason;
    routeSummary?: Record<string, unknown>;
  }): void {
    this.dependencies.logger.debug?.('provider_adapter.event.dropped', {
      ...(input.routeSummary ?? { eventType: input.event.type }),
      dropReason: input.reason,
    });
  }
```

使用 `routeSummary` 时不要重复覆盖其中的 `eventType`。

- [ ] **步骤 2：为缺少 raw session id 增加 debug 日志**

修改 `resolveRoutingState`：

```ts
    const rawSessionId = this.dependencies.rawSessionLocator.locate(event);
    if (!rawSessionId) {
      this.logEventDropped({
        event,
        reason: 'missing_raw_session_id',
      });
      return undefined;
    }
```

- [ ] **步骤 3：为 active run 路由失败增加 debug 日志**

修改 `tryRouteToActiveRun`：

```ts
    if (!routingState.activeRun) {
      if (routingState.eventClass !== 'run_scoped_with_outbound_fallback') {
        this.logEventDropped({
          event: routingState.event,
          reason: 'missing_active_run',
          routeSummary: routingState.eventRouteSummary,
        });
      }
      return false;
    }
    if (!this.canRouteToActiveRun(routingState.eventClass)) {
      this.logEventDropped({
        event: routingState.event,
        reason: 'unsupported_event',
        routeSummary: routingState.eventRouteSummary,
      });
      return false;
    }
```

注意：`session.error` 没 active run 时要留给 outbound fallback，不在这里记录 `missing_active_run`。

- [ ] **步骤 4：为 outbound fallback 失败增加 debug 日志**

修改 `tryRouteToOutbound`：

```ts
    if (routingState.eventClass !== 'run_scoped_with_outbound_fallback') {
      return false;
    }
    if (!routingState.runtimeContext) {
      this.logEventDropped({
        event: routingState.event,
        reason: 'missing_runtime_context',
        routeSummary: routingState.eventRouteSummary,
      });
      return false;
    }
```

然后在 outbound target 和 translation 分支增加：

```ts
    if (!outboundTarget) {
      this.logEventDropped({
        event: routingState.event,
        reason: 'missing_outbound_target',
        routeSummary: routingState.eventRouteSummary,
      });
      return false;
    }
```

```ts
    if (!translation.recognized || translation.facts.length === 0 || !translation.envelopeMessageId) {
      this.logEventDropped({
        event: routingState.event,
        reason: 'empty_outbound_translation',
        routeSummary: {
          ...routingState.eventRouteSummary,
          recognized: translation.recognized,
          factCount: translation.facts.length,
          hasEnvelopeMessageId: Boolean(translation.envelopeMessageId),
        },
      });
      return false;
    }
```

- [ ] **步骤 5：复查 `session.updated` detached 行为**

确认 `session.updated` 无 active run 时会在 `tryRouteToActiveRun` 记录 `missing_active_run` 后返回 false，不进入 `SessionUpdatedTranslator`，因此现有 `provider adapter ignores detached session.updated without title silently` 的 `warnings=[]` 仍然成立。

- [ ] **步骤 6：运行测试验证通过**

运行：

```bash
pnpm --dir plugins/message-bridge test:sdk-runtime
```

预期：任务 1 新增/扩展测试通过，既有 provider adapter 测试通过。

---

### 任务 3：补齐 routing 与 run 边界 TSDoc

**文件：**
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.routing.ts`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.run.ts`

- [ ] **步骤 1：给 routing 导出类补 TSDoc**

在各导出类前加入职责说明：

```ts
/**
 * 将 raw event 中不同结构的 session 字段统一抽取为宿主 session id。
 * @remarks
 * 这里只做身份定位，不读取消息正文，也不承担 raw event -> fact 翻译。
 */
export class EventRawSessionLocator {
```

```ts
/**
 * 将宿主 session id 解析为 fact 路由身份。
 * @remarks
 * 子 agent 会话映射失败时返回 fail-open 身份，保证宿主事件不会因为本地索引异常被硬丢弃。
 */
export class EventSessionIdentityResolver {
```

```ts
/**
 * 组装 fact 上的会话路由字段。
 * @remarks
 * `anchorSessionId` 是对外展示会话，`trackingSessionId` 是生命周期状态跟踪会话。
 */
export class FactRoutingContextAssembler {
```

```ts
/**
 * 为无 active run 的 `session.error` 查找 outbound 兜底目标。
 * @remarks
 * 只允许已 attach 的宿主会话 fallback 到对应 anchor，避免把游离事件发给错误会话。
 */
export class DefaultOutboundTargetResolver implements OutboundTargetResolverPort {
```

```ts
/**
 * 记录 `session.created` 中的父子会话关系。
 * @remarks
 * 该类只更新子 agent 映射，不产生 provider fact。
 */
export class SessionCreatedRecorder {
```

```ts
/**
 * OpenCode raw event 的路由协调器。
 * @remarks
 * 负责 session 身份解析、active run 优先路由、`session.error` outbound fallback 和诊断日志；
 * 具体 raw event -> fact 映射由 translator registry 完成。
 */
export class ProviderEventCoordinator {
```

- [ ] **步骤 2：给 run 导出类补 TSDoc，使用当前 FIFO 调度语义**

```ts
/**
 * assistant message 生命周期状态表。
 * @remarks
 * 用于拒绝没有 open message 的 part/question 事件，避免生成顺序错误的 facts。
 */
export class AssistantMessageStateStore implements AssistantMessageStateStorePort {
```

```ts
/**
 * message part 类型记忆表。
 * @remarks
 * `message.part.delta` 不总是携带完整 part 类型，因此需要用先前的 part.updated 判断 text/reasoning。
 */
export class PartKindStore implements PartKindStorePort {
```

```ts
/**
 * 单次 provider run 的 fact 队列、prompt 启动状态和 terminal 收口句柄。
 * @remarks
 * run result 需要 prompt terminal 与 facts drain 都完成；cleanup 还要等待已启动的 prompt task 返回，
 * 以便 `HostSessionRunCoordinator` 在同一 host session 内维持 FIFO prompt 调度。
 */
export class ActiveProviderRunHandle {
```

```ts
/**
 * active run 注册表。
 * @remarks
 * 对外按 anchor session 管理当前 run，对内按 host session 维护事件路由队列；
 * 已启动 prompt 的 superseded run 会保留到 task finished，未启动的 queued run 可直接移出队列。
 */
export class ActiveRunRegistry {
```

- [ ] **步骤 3：运行类型检查**

运行：

```bash
pnpm --dir plugins/message-bridge typecheck
```

预期：类型检查通过。

---

### 任务 4：补齐 types 和 translator TSDoc

**文件：**
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.types.ts`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.translation.ts`

- [ ] **步骤 1：给关键导出 type/port 补 TSDoc**

示例补充：

```ts
/**
 * raw event 翻译后的 provider fact 包。
 * @remarks
 * `recognized=true` 表示事件类型已被 translator 接管；`facts=[]` 表示事件有效但当前状态下不应输出 fact。
 */
export type RawEventTranslation = {
```

```ts
/**
 * fact 路由使用的会话上下文。
 * @remarks
 * `anchorSessionId` 面向 bridge-runtime-sdk；`trackingSessionId` 面向本地 lifecycle store。
 */
export type FactSessionContext = {
```

```ts
/**
 * outbound fallback 目标解析端口。
 * @remarks
 * 只能返回当前宿主会话已 attach 的 anchor，找不到时必须返回 `undefined` 并让调用方 fail-closed。
 */
export interface OutboundTargetResolverPort {
```

```ts
/**
 * raw event 翻译过程中的协议诊断出口。
 * @remarks
 * 用于记录可恢复但值得关注的上游协议异常，调用方按 warn 级别输出。
 */
export interface ProtocolDiagnosticPort {
```

```ts
/**
 * 待用户交互记录端口。
 * @remarks
 * question/permission fact 成功路由到 active run 后记录 reply token 与宿主会话的关系。
 */
export interface PendingInteractionRecorderPort {
```

同时给 `SessionIdentityResolution`、`TranslationContext`、`AssistantMessageStateStorePort`、`PartKindStorePort` 补一句中文 TSDoc，避免关键导出接口仍裸露。

- [ ] **步骤 2：给 translator registry 和各 translator 补 TSDoc**

```ts
/**
 * 事件类型到 translator 的只读运行期注册表。
 * @remarks
 * registry 只决定是否识别事件；具体校验、状态机和 fact 生成由 translator 实现。
 */
export class EventTranslatorRegistry {
```

```ts
/**
 * 翻译 `message.updated` assistant 消息生命周期。
 * @remarks
 * 根据 created/completed 生成 `message.start` 和 `message.done`，并维护 message open/closed 状态。
 */
export class AssistantMessageEventTranslator implements EventTranslator {
```

```ts
/**
 * 翻译 `message.part.delta` 增量文本。
 * @remarks
 * 依赖 `PartKindStore` 区分 text/thinking；没有 open message 时 fail-closed 并记录协议诊断。
 */
export class MessagePartDeltaTranslator implements EventTranslator {
```

```ts
/**
 * 翻译 `message.part.updated` 的 part 完成态与工具状态。
 * @remarks
 * text/reasoning 产出 done fact，tool 产出 update fact，step-start/step-finish 只作为已识别空事件处理。
 */
export class MessagePartUpdatedTranslator implements EventTranslator {
```

```ts
/**
 * 翻译 `question.asked` 为 `question.ask` fact。
 * @remarks
 * questionId 只作为 reply target；缺少 open message 时按构造参数决定是否拒绝。
 */
export class QuestionAskedTranslator implements EventTranslator {
```

```ts
/**
 * 翻译 `permission.asked` 为 `permission.ask` fact。
 * @remarks
 * permissionId 只作为 reply target；缺少 permission type 时不输出 fact 并记录诊断。
 */
export class PermissionAskedTranslator implements EventTranslator {
```

```ts
/**
 * 翻译 `permission.replied` 为 `permission.reply` fact。
 * @remarks
 * 只接受 `once`、`always`、`reject` 三类响应，其它响应被视为已识别空事件。
 */
export class PermissionRepliedTranslator implements EventTranslator {
```

```ts
/**
 * 翻译 `session.error` 为 provider session error fact。
 * @remarks
 * active run 优先消费；无 active run 时由 coordinator 走 outbound fallback。
 */
export class SessionErrorTranslator implements EventTranslator {
```

```ts
/**
 * 翻译 `session.updated` 标题变更。
 * @remarks
 * 只有进入 active run 的 session.updated 才会产出 `session.title`；detached metadata 由 coordinator drop。
 */
export class SessionUpdatedTranslator implements EventTranslator {
```

- [ ] **步骤 3：运行类型检查**

运行：

```bash
pnpm --dir plugins/message-bridge typecheck
```

预期：类型检查通过。

---

### 任务 5：补齐 run 队列调度日志

**文件：**
- 修改：`plugins/message-bridge/src/runtime/sdk/HostSessionRunCoordinator.ts`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.run.ts`
- 测试：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`

- [ ] **步骤 1：先新增 run 队列日志回归测试**

在 `sdk-provider-adapter.test.mjs` 顶部补充 import：

```js
import { HostSessionRunCoordinator } from '../../src/runtime/sdk/HostSessionRunCoordinator.ts';
```

新增测试。注意这里必须使用两个不同 anchor 绑定到同一个 host session，避免同 anchor 触发 supersede，从而真正验证 host FIFO：

```js
test('provider adapter records host run queue scheduling diagnostics', async () => {
  const logs = [];
  const firstPrompt = createDeferred();
  const secondPrompt = createDeferred();
  let promptCount = 0;
  const adapter = createAdapter({
    logger: createCapturingLogger(logs),
    bindings: [
      ['conversation-run-queue-a', 'host-run-queue-shared'],
      ['conversation-run-queue-b', 'host-run-queue-shared'],
    ],
    session: {
      prompt: async () => {
        promptCount += 1;
        return promptCount === 1 ? firstPrompt.promise : secondPrompt.promise;
      },
    },
  });

  const firstRun = await adapter.runMessage({
    traceId: 'trace-run-queue-1',
    runId: 'run-queue-1',
    toolSessionId: 'conversation-run-queue-a',
    text: 'first',
  });
  const secondRun = await adapter.runMessage({
    traceId: 'trace-run-queue-2',
    runId: 'run-queue-2',
    toolSessionId: 'conversation-run-queue-b',
    text: 'second',
  });

  await Promise.resolve();
  assert.equal(promptCount, 1);
  firstPrompt.resolve(createPromptResponse());
  await firstRun.result();
  await Promise.resolve();
  assert.equal(promptCount, 2);
  secondPrompt.resolve(createPromptResponse());
  await secondRun.result();

  const debugs = logs.filter((entry) => entry.level === 'debug');
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.run_queue.enqueued'
    && entry.extra?.hostSessionId === 'host-run-queue-shared'
    && entry.extra?.anchorSessionId === 'conversation-run-queue-a'
    && entry.extra?.runId === 'run-queue-1'), true);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.run_queue.enqueued'
    && entry.extra?.hostSessionId === 'host-run-queue-shared'
    && entry.extra?.anchorSessionId === 'conversation-run-queue-b'
    && entry.extra?.runId === 'run-queue-2'), true);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.run_queue.drain_skipped'
    && entry.extra?.hostSessionId === 'host-run-queue-shared'
    && entry.extra?.reason === 'already_draining'), true);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.run_queue.prompt_started'
    && entry.extra?.runId === 'run-queue-1'), true);
  assert.equal(debugs.some((entry) => entry.message === 'provider_adapter.run_queue.prompt_started'
    && entry.extra?.runId === 'run-queue-2'), true);
});
```

- [ ] **步骤 2：新增 scheduler work throw 的日志回归测试**

直接单测 `HostSessionRunCoordinator`，避免构造难以触发的 adapter 异常路径：

```js
test('HostSessionRunCoordinator logs scheduler work failure and fails run closed', async () => {
  const logs = [];
  const registry = new ActiveRunRegistry();
  const run = registry.create({
    anchorSessionId: 'tool-run-queue-failed',
    hostSessionId: 'host-run-queue-failed',
    runId: 'run-queue-failed',
    initialTrackingSessionId: 'host-run-queue-failed',
    logger: createCapturingLogger(logs),
    onCleanup: () => undefined,
  });
  const coordinator = new HostSessionRunCoordinator(createCapturingLogger(logs));

  coordinator.enqueue(run, async () => {
    throw new Error('scheduler boom');
  });

  assert.deepEqual(await run.result(), {
    outcome: 'failed',
    error: {
      code: 'internal_error',
      message: 'scheduler boom',
    },
  });
  assert.equal(logs.some((entry) => entry.level === 'error'
    && entry.message === 'provider_adapter.run_queue.prompt_task_failed'
    && entry.extra?.runId === 'run-queue-failed'
    && entry.extra?.error === 'scheduler boom'), true);
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：

```bash
pnpm --dir plugins/message-bridge test:sdk-runtime
```

预期：新增日志断言失败，原因是当前实现没有 run queue 日志；如果 import 已添加但 constructor 还不接收 logger，也会先出现类型/运行错误，这是红灯阶段可接受的失败。

- [ ] **步骤 4：让 `HostSessionRunCoordinator` 接收可选 logger**

修改 `HostSessionRunCoordinator.ts`：

```ts
import type { BridgeLogger } from '../AppLogger.js';
import type { ActiveProviderRunHandle } from './OpenCodeProviderAdapter.run.js';

export class HostSessionRunCoordinator {
  private readonly hostQueues = new Map<string, HostSessionRunTask[]>();
  private readonly drainingHosts = new Set<string>();

  constructor(private readonly logger?: BridgeLogger) {}
```

在 `OpenCodeProviderAdapter.ts` 中把字段初始化改成构造函数内初始化：

```ts
  private readonly runCoordinator: HostSessionRunCoordinator;
```

```ts
    this.logger = options.logger;
    this.runCoordinator = new HostSessionRunCoordinator(this.logger);
```

- [ ] **步骤 5：在 run queue 正常路径增加 debug 日志**

在 `HostSessionRunCoordinator` 内增加日志 helper：

```ts
  private logDebug(message: string, handle: ActiveProviderRunHandle, extra?: Record<string, unknown>): void {
    this.logger?.debug?.(message, {
      hostSessionId: handle.hostSessionId,
      anchorSessionId: handle.anchorSessionId,
      runId: handle.runId,
      ...(extra ?? {}),
    });
  }
```

在关键路径加日志：

```ts
  enqueue(handle: ActiveProviderRunHandle, work: () => Promise<void>): void {
    const queue = this.hostQueues.get(handle.hostSessionId) ?? [];
    queue.push({ handle, work });
    this.hostQueues.set(handle.hostSessionId, queue);
    this.logDebug('provider_adapter.run_queue.enqueued', handle, {
      queueLength: queue.length,
    });
    void this.drain(handle.hostSessionId);
  }
```

```ts
    if (this.drainingHosts.has(hostSessionId)) {
      this.logger?.debug?.('provider_adapter.run_queue.drain_skipped', {
        hostSessionId,
        reason: 'already_draining',
        queueLength: this.hostQueues.get(hostSessionId)?.length ?? 0,
      });
      return;
    }
```

```ts
    this.logger?.debug?.('provider_adapter.run_queue.drain_started', {
      hostSessionId,
      queueLength: this.hostQueues.get(hostSessionId)?.length ?? 0,
    });
```

```ts
    this.logger?.debug?.('provider_adapter.run_queue.drain_finished', {
      hostSessionId,
      remainingQueueLength: this.hostQueues.get(hostSessionId)?.length ?? 0,
    });
```

```ts
    this.logDebug('provider_adapter.run_queue.prompt_started', task.handle);
```

```ts
    this.logger?.debug?.('provider_adapter.run_queue.shifted', {
      hostSessionId,
      remainingQueueLength: queue.length,
    });
```

- [ ] **步骤 6：在异常或不可启动路径增加日志**

`runStartedPromptTask` catch 是 scheduler work 的异常边界，使用 `error`：

```ts
    } catch (error) {
      this.logger?.error?.('provider_adapter.run_queue.prompt_task_failed', {
        hostSessionId: task.handle.hostSessionId,
        anchorSessionId: task.handle.anchorSessionId,
        runId: task.handle.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      task.handle.forceFailAndClose({
        code: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      });
```

`closeUnexpectedStartableTask` 中记录 debug；如果 `canStartPrompt()` 为 true 但 `tryStartPrompt()` 已失败，说明状态异常但本地会 abort 收口：

```ts
  private closeUnexpectedStartableTask(handle: ActiveProviderRunHandle): void {
    this.logDebug('provider_adapter.run_queue.prompt_start_skipped', handle, {
      canStartPrompt: handle.canStartPrompt(),
    });
    if (handle.canStartPrompt()) {
      handle.forceAbortAndClose('abort_session');
    }
  }
```

- [ ] **步骤 7：补齐 `ActiveRunRegistry` 队列变更日志**

先把 logger 保存在 `ActiveProviderRunHandle` 上，供 registry 后续队列操作使用：

```ts
export class ActiveProviderRunHandle {
  readonly queue = new AsyncIterableQueue<ProviderFact>();
  readonly logger: BridgeLogger;
```

```ts
  constructor(options: ActiveProviderRunHandleOptions) {
    this.logger = options.logger;
```

`ActiveRunRegistry.create` 当前已经要求 `logger: BridgeLogger`，不需要新增入参；在 supersede 分支补充 debug：

```ts
    if (previous) {
      options.logger.debug?.('provider_adapter.active_run.superseded', {
        anchorSessionId: options.anchorSessionId,
        hostSessionId,
        previousRunId: previous.runId,
        nextRunId: options.runId,
        previousPromptStarted: previous.hasPromptStarted(),
      });
      previous.forceAbortAndClose('superseded_run');
      if (!previous.hasPromptStarted()) {
        this.removeFromHostQueue(previous);
        options.logger.debug?.('provider_adapter.active_run.removed_unstarted_superseded_run', {
          anchorSessionId: previous.anchorSessionId,
          hostSessionId: previous.hostSessionId,
          runId: previous.runId,
        });
      }
    }
```

在 `abortAllByHostSession` 中补充：

```ts
      handle.forceAbortAndClose(reason);
      this.handles.delete(handle.anchorSessionId);
      handle.logger.debug?.('provider_adapter.active_run.host_run_aborted', {
        anchorSessionId: handle.anchorSessionId,
        hostSessionId,
        runId: handle.runId,
        reason,
        promptStarted,
      });
```

不要删除现有 `if (!promptStarted) { this.removeFromHostQueue(handle); }` 逻辑；日志只插入现有 force close/delete/remove queue 流程，不能改变未启动 run 立即移出 host queue 的行为。

不要引入全局 logger；registry 只使用 create options 或 handle 上已有 logger。

- [ ] **步骤 8：运行队列相关测试验证通过**

运行：

```bash
pnpm --dir plugins/message-bridge test:sdk-runtime
```

预期：任务 5 新增测试通过，既有 provider adapter 测试通过。

---

### 任务 6：验证日志级别划分与全量回归

**文件：**
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.routing.ts`
- 修改：`plugins/message-bridge/src/runtime/sdk/HostSessionRunCoordinator.ts`
- 修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.run.ts`
- 修改：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`

- [ ] **步骤 1：人工扫描日志级别**

运行：

```bash
rg -n "logger\\.(debug|info|warn|error)|protocol_diagnostic|event\\.dropped|run_queue|active_run\\.|routed_to|translation|received|subagent_lookup_failed|session_updated_ignored" plugins/message-bridge/src/runtime plugins/message-bridge/src/runtime/sdk
```

检查结果：
- 高频路由状态和预期 drop 为 `debug`。
- run queue 的 enqueue/drain/shift/supersede/abort queue 状态为 `debug`。
- 生命周期阶段为 `info`。
- 协议异常、降级、drain timeout 为 `warn`。
- catch 到的异常为 `error`。
- 不要把 `provider_adapter.event_dropped_without_session_identity` 在本任务中改成 `debug`；它来自 identity resolver 的 `missing_session` 分支，当前代码按协议/索引异常处理为 `warn`。

- [ ] **步骤 2：运行受影响包测试**

运行：

```bash
pnpm --dir plugins/message-bridge test:sdk-runtime
```

预期：通过。

- [ ] **步骤 3：运行类型检查**

运行：

```bash
pnpm --dir plugins/message-bridge typecheck
```

预期：通过。

- [ ] **步骤 4：跨插件边界未改动时不跑 workspace 全量；如实现中触碰 SDK contract 再跑全量**

如果只改上述文件，运行：

```bash
pnpm --dir plugins/message-bridge test:sdk-runtime
pnpm --dir plugins/message-bridge typecheck
```

如果实现过程中修改了 `packages/` 或 runtime SDK contract，再运行：

```bash
pnpm verify:workspace
```

预期：对应命令通过。

---

## 自检

- 规格覆盖：计划覆盖了当前代码仍缺的 drop reason 日志、run 队列调度日志、TSDoc 缺口、日志级别划分，以及新引入 FIFO scheduler 后的 run 注释语义。
- 占位符扫描：没有使用“待定”“后续实现”等占位步骤；每个代码改动任务都给出具体片段。
- 类型一致性：新增路由 drop 日志统一使用 `provider_adapter.event.dropped`，字段统一为 `dropReason`、`eventType` 和已有 route summary 字段；新增队列日志统一使用 `provider_adapter.run_queue.*` / `provider_adapter.active_run.*`，测试复用当前已有 `createCapturingLogger(logs)`。
