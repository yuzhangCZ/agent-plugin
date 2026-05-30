# message-bridge SDK runtime 完全切换实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `plugins/message-bridge` 完全切换到 `@wecode/bridge-runtime-sdk` runtime，移除 legacy `BridgeRuntime` 及其专用主链代码，并重排 SDK 与插件侧集成测试边界。

**架构：** `packages/bridge-runtime-sdk` 继续拥有 gateway 下行 intake、runtime command、provider SPI、fact 校验、terminal 和 uplink 投影；`plugins/message-bridge` 只保留 OpenCode provider adapter、配置、启动装配、session isolation、slash/control-plane 与 raw event -> SDK fact 翻译。测试分为 SDK runtime 合同测试、插件 provider adapter/装配测试、插件端到端 smoke 三层，避免继续把插件测试绑死在 legacy runtime 类上。

**技术栈：** TypeScript、Node.js test runner、`tsx`、`@wecode/bridge-runtime-sdk`、`@agent-plugin/gateway-schema`、`@agent-plugin/gateway-client`

---

## 现状判断

1. `plugins/message-bridge/src/runtime/SdkBridgeRuntime.ts` 已经是 SDK-backed runtime，内部通过 `createBridgeRuntime()` 装配 `OpenCodeProviderAdapter`。
2. `plugins/message-bridge/src/runtime/singleton.ts` 默认已走 SDK，但仍保留 `MESSAGE_BRIDGE_RUNTIME_MODE=legacy` 分支和 `BridgeRuntime` 导入。
3. `plugins/message-bridge/src/runtime/BridgeRuntime.ts` 仍有 1580 行 legacy runtime 主链代码，直接拥有 gateway client、action router、event projection、tool_done compat 等职责。
4. 旧测试仍大量 `import { BridgeRuntime } from '../../src/runtime/BridgeRuntime.ts'`，其中 `runtime-protocol.test.mjs` 约 3184 行、`runtime-slash-control-plane.test.mjs` 约 1678 行，不能简单删除，必须先按职责迁移可复用断言。
5. `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts` 已覆盖 SDK facade 的 gateway 消费与 uplink 投影，但还需要把 legacy runtime 测试中的协议兼容、错误收口、terminal、interaction 路径逐项补齐到 SDK 层或插件 adapter 层。

## 文件设计

**删除：**
- `plugins/message-bridge/src/runtime/BridgeRuntime.ts`：legacy runtime 主链。

**修改：**
- `plugins/message-bridge/src/runtime/singleton.ts`：移除 `BridgeRuntime` 导入、`MESSAGE_BRIDGE_RUNTIME_MODE=legacy` 分支和 runtimeMode 选择逻辑；固定装配 `SdkBridgeRuntime`。
- `plugins/message-bridge/src/runtime/index.ts`：停止导出 `BridgeRuntime`，只导出仍需要的 status、managed runtime 与 SDK runtime 入口。
- `plugins/message-bridge/src/runtime/ManagedRuntime.ts`：注释从“legacy/runtime 双实现”更新为“singleton 与 SDK runtime 生命周期边界”。
- `plugins/message-bridge/src/runtime/SdkBridgeRuntime.ts`：必要时补测试注入点，避免插件集成测试继续 monkey-patch legacy `BridgeRuntime.prototype.resolveConfig`。
- `plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter.ts` 及其 `*.translation.ts` / `*.routing.ts`：承接原 legacy event 行为中仍需保留的 raw event -> fact 能力。
- `packages/bridge-runtime-sdk/src/**`：只补跨 provider 稳定 runtime 语义，不放入 OpenCode 专用策略。
- `plugins/message-bridge/package.json`：调整 `test:sdk-runtime` 或删除过渡脚本，使 `test:unit`/`test:integration` 覆盖 SDK runtime 主链。
- `plugins/message-bridge/docs/operations/logging-reference.md`：将 legacy `BridgeRuntime.ts` 日志表更新为 SDK runtime 与 `runtime_sdk.*` 事件。
- `plugins/message-bridge/docs/quality/traceability-matrix.md`：将 runtime 行为证据从 legacy 文件与旧测试迁移到 SDK/runtime adapter 测试。
- `plugins/message-bridge/docs/quality/test-strategy.md`：移除当前测试策略中直接构造 legacy `BridgeRuntime` 的示例，改为 SDK/runtime adapter 测试入口。

**迁移或重写测试：**
- `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts`：承接 gateway 下行命令、status、invalid invoke、terminal、fact 投影、interaction reply、session registry 行为。
- `packages/bridge-runtime-sdk/tests/runtime-registry-contract.test.ts`、`fact-semantics-validator.test.ts`、`command-failure-tool-error-projector.test.ts`：承接原 legacy runtime 中跨 provider 的稳定语义。
- `plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`：承接 OpenCode raw event 翻译、session_not_found 探测、suppressReply、directory、permission/question direct reply 映射。
- `plugins/message-bridge/tests/unit/sdk-runtime-register.test.mjs`：承接 `SdkBridgeRuntime` 启动、register metadata、状态同步、配置关闭、health/capability 失败。
- `plugins/message-bridge/tests/integration/plugin.test.mjs`：改为通过 public runtime API 和 `SdkBridgeRuntime` 测试启动闭环，不再 patch legacy 类。
- `plugins/message-bridge/tests/integration/protocol-connect.test.mjs`、`protocol-chat-stream.test.mjs`、`protocol-directory.test.mjs`、`protocol-question.test.mjs`、`protocol-permission.test.mjs`、`protocol-message-updated-large-payload.test.mjs`、`example.test.mjs`：按矩阵拆分；跨 provider 协议路径迁往 SDK 包，OpenCode 专用断言迁往 provider adapter，完成后删除这些直接构造 legacy runtime 的 integration 文件。
- `plugins/message-bridge/tests/unit/runtime-protocol.test.mjs`、`runtime-slash-control-plane.test.mjs`、`plugin-event-relay.test.mjs`：完成迁移后删除或改名为 SDK runtime/adapter 测试，不能继续导入 `BridgeRuntime.ts`。

## 测试分层目标

| 层级 | 所属包 | 负责验证 | 不负责验证 |
|---|---|---|---|
| SDK runtime 合同层 | `packages/bridge-runtime-sdk/tests` | gateway 下行到 `RuntimeCommand`、provider SPI 调用、fact sequence、interaction registry、terminal/tool_error、status/probe/logging | OpenCode raw event 字段路径、directory、slash command 策略 |
| message-bridge adapter 层 | `plugins/message-bridge/tests/unit/sdk-*.test.mjs` | OpenCode client 适配、session isolation、raw event -> `ProviderFact`、direct reply 映射、suppressReply、directory/session_not_found 闭环 | gateway client 状态机、SDK fact 投影细节 |
| message-bridge 集成层 | `plugins/message-bridge/tests/integration` 和 e2e smoke | 插件 public API、配置读取、register metadata、SDK runtime 装配、mock gateway + mock OpenCode 的主路径 | 逐 action 的协议矩阵和 SDK 内部状态机 |

## 任务 1：建立迁移前测试清单与归属矩阵

**文件：**
- 创建：`docs/superpowers/plans/2026-05-27-message-bridge-sdk-runtime-test-matrix.md`
- 读取：`plugins/message-bridge/tests/unit/runtime-protocol.test.mjs`
- 读取：`plugins/message-bridge/tests/unit/runtime-slash-control-plane.test.mjs`
- 读取：`plugins/message-bridge/tests/integration/protocol-*.test.mjs`
- 读取：`packages/bridge-runtime-sdk/tests/*.test.ts`

- [ ] **步骤 1：列出所有直接依赖 legacy runtime 的测试**

运行：

```bash
rg -n "BridgeRuntime|MESSAGE_BRIDGE_RUNTIME_MODE|runtimeMode.*legacy" plugins/message-bridge/tests plugins/message-bridge/src
```

预期：输出只作为清单输入；重点记录 `runtime-protocol.test.mjs`、`runtime-slash-control-plane.test.mjs`、`plugin-event-relay.test.mjs`、`protocol-*.test.mjs`、`plugin.test.mjs` 中的直接导入和 monkey-patch。

- [ ] **步骤 2：创建测试归属矩阵**

写入 `docs/superpowers/plans/2026-05-27-message-bridge-sdk-runtime-test-matrix.md`：

```markdown
# message-bridge SDK runtime 测试迁移矩阵

| 旧测试文件 | 行为 | 新归属 | 新测试文件 | 处理方式 |
|---|---|---|---|---|
| `plugins/message-bridge/tests/unit/runtime-protocol.test.mjs` | `status_query` -> `status_response` | SDK runtime 合同层 | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts` | 迁移断言 |
| `plugins/message-bridge/tests/unit/runtime-protocol.test.mjs` | invalid invoke -> `tool_error` | SDK runtime 合同层 | `packages/bridge-runtime-sdk/tests/command-failure-tool-error-projector.test.ts` | 迁移断言 |
| `plugins/message-bridge/tests/unit/runtime-protocol.test.mjs` | OpenCode `message.part.delta` -> text/thinking fact | message-bridge adapter 层 | `plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs` | 迁移断言 |
| `plugins/message-bridge/tests/unit/runtime-slash-control-plane.test.mjs` | `/new`、`/session`、`/sessions` | message-bridge adapter 层 | `plugins/message-bridge/tests/unit/sdk-chat-control-plane.test.mjs` 或 session-isolation 测试 | 迁移断言 |
| `plugins/message-bridge/tests/integration/protocol-directory.test.mjs` | directory 注入和复用 | message-bridge adapter 层 | `plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs` / `sdk-runtime-register.test.mjs` | 迁移断言 |
| `plugins/message-bridge/tests/integration/plugin.test.mjs` | public API 启停 | message-bridge 集成层 | 原文件 | 改写为 smoke |
```

- [ ] **步骤 3：补齐矩阵到所有旧测试场景**

要求每一条旧测试至少落入以下处理方式之一：`迁移断言`、`已有覆盖`、`改写为 smoke`、`删除且说明原因`。不能使用“待定”。

矩阵必须按旧行为粒度记录，不允许只用“整个 `runtime-protocol.test.mjs` 已有覆盖”这类粗粒度结论。最低粒度要求：

- SDK 稳定语义按 action / frame / terminal 分类，例如 `status_query`、invalid invoke、`question_reply`、`session_not_found`。
- OpenCode 专用语义按 raw event、slash/control-plane、directory、session isolation、pending interaction 分类。
- 每一条“已有覆盖”必须写出新测试文件；执行任务 2 或任务 3 时需用测试名确认具体 case 存在，缺失则改为“迁移断言”。

- [ ] **步骤 4：运行清单命令复核没有漏掉直接导入**

运行：

```bash
rg -n "from ['\"]../../src/runtime/BridgeRuntime|BridgeRuntime\\.js|MESSAGE_BRIDGE_RUNTIME_MODE|runtimeMode.*legacy|new BridgeRuntime|class BridgeRuntime|src/runtime/BridgeRuntime" plugins/message-bridge/tests plugins/message-bridge/src plugins/message-bridge/package.json
```

预期：输出与矩阵中的旧测试集合一致。

- [ ] **步骤 5：Commit**

```bash
git add docs/superpowers/plans/2026-05-27-message-bridge-sdk-runtime-test-matrix.md
git commit -m "docs: map message bridge sdk runtime test migration"
```

## 任务 2：补齐 SDK runtime 合同测试

**文件：**
- 修改：`packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts`
- 修改：`packages/bridge-runtime-sdk/tests/command-failure-tool-error-projector.test.ts`
- 修改：`packages/bridge-runtime-sdk/tests/runtime-registry-contract.test.ts`
- 修改：`packages/bridge-runtime-sdk/tests/fact-semantics-validator.test.ts`
- 可选修改：`packages/bridge-runtime-sdk/src/**`

- [ ] **步骤 1：先迁移 `status_query`、`create_session`、`chat` 主路径断言**

在 `runtime-sdk.test.ts` 增加或复用 fake gateway/provider，断言 downstream frame 进入 SDK 后产生正确 uplink：

```ts
connection.emitMessage({
  type: 'status_query',
  messageId: 'gw-status-1',
  welinkSessionId: 'wl-1',
});

await flushEvents();

assert.deepEqual(connection.sent.at(-1), {
  type: 'status_response',
  welinkSessionId: 'wl-1',
  opencodeOnline: true,
});
```

- [ ] **步骤 2：运行 SDK 测试确认新断言失败或定位缺口**

运行：

```bash
pnpm --filter @wecode/bridge-runtime-sdk test
```

预期：如果 SDK 已满足则 PASS；如果 FAIL，失败必须落在 SDK command/projector/registry 层，不能通过插件侧 direct send 修复。

- [ ] **步骤 3：迁移 invalid invoke 和 unsupported action 的 `tool_error` 断言**

在 `command-failure-tool-error-projector.test.ts` 或 `runtime-sdk.test.ts` 覆盖：

```ts
assert.equal(toolError.type, 'tool_error');
assert.equal(toolError.toolSessionId, 'tool-invalid-1');
assert.equal(toolError.error.code, 'missing_required_field');
```

- [ ] **步骤 4：迁移 interaction reply 合同**

覆盖 `question_reply` 和 `permission_reply`：

```ts
assert.deepEqual(providerCalls.replyQuestion.at(-1), {
  traceId: 'trace-fixed',
  questionId: 'question-1',
  answers: [['Vite']],
});

assert.deepEqual(providerCalls.replyPermission.at(-1), {
  traceId: 'trace-fixed',
  permissionId: 'perm-1',
  reply: 'once',
});
```

- [ ] **步骤 5：迁移 terminal 和 session registry 行为**

覆盖 completed / aborted / failed / `session_not_found`：

```ts
assert.equal(connection.sent.some((message) => message.type === 'tool_done'), true);
assert.equal(connection.sent.some((message) => message.type === 'tool_error'), true);
assert.equal(toolError.reason, 'session_not_found');
```

- [ ] **步骤 6：实现 SDK 层缺口**

如果步骤 1-5 暴露缺口，只在 `packages/bridge-runtime-sdk/src` 内补跨 provider 稳定语义。例如：

```ts
// Runtime SDK 只处理稳定错误分类，不读取 OpenCode raw error shape。
if (providerError.code === 'session_not_found') {
  return { ...message, reason: 'session_not_found' };
}
```

- [ ] **步骤 7：运行 SDK 包验证**

运行：

```bash
pnpm --filter @wecode/bridge-runtime-sdk test
pnpm --filter @wecode/bridge-runtime-sdk typecheck
```

预期：全部 PASS。

- [ ] **步骤 8：Commit**

```bash
git add packages/bridge-runtime-sdk/src packages/bridge-runtime-sdk/tests
git commit -m "test: cover bridge runtime sdk cutover contracts"
```

## 任务 3：补齐 message-bridge provider adapter 与控制面测试

**文件：**
- 修改：`plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`
- 修改：`plugins/message-bridge/tests/unit/sdk-chat-control-plane.test.mjs`
- 修改：`plugins/message-bridge/tests/unit/session-isolation-*.test.mjs`
- 可选修改：`plugins/message-bridge/src/runtime/sdk/OpenCodeProviderAdapter*.ts`
- 可选修改：`plugins/message-bridge/src/runtime/sdk/session-isolation/*.ts`

- [ ] **步骤 1：把 OpenCode raw event 翻译断言迁入 provider adapter 测试**

从旧 `runtime-protocol.test.mjs` / `plugin-event-relay.test.mjs` 迁移事件 fixture，直接调用 `OpenCodeProviderAdapter.handleEvent()`，断言产出 SDK fact 或 runtime outbound：

```js
await adapter.handleEvent({
  type: 'message.part.delta',
  properties: {
    sessionID: 'tool-1',
    messageID: 'msg-1',
    partID: 'part-1',
    delta: 'hello',
  },
});

assert.deepEqual(collectedFacts.at(-1), {
  type: 'text.delta',
  toolSessionId: 'tool-1',
  messageId: 'msg-1',
  partId: 'part-1',
  content: 'hello',
});
```

- [ ] **步骤 2：覆盖 OpenCode 专用闭环策略**

在 adapter/control-plane 测试覆盖：

```js
assert.equal(promptCalls.length, 0, 'suppressReply=true should not call provider prompt');
assert.equal(createSessionCalls.at(-1).directory, '/workspace/from-config');
assert.equal(error.code, 'session_not_found');
```

- [ ] **步骤 3：迁移 slash/control-plane 行为**

将旧 `runtime-slash-control-plane.test.mjs` 中 `/new`、`/session`、`/sessions`、model override、business entry/session isolation 断言迁到 `sdk-chat-control-plane.test.mjs` 或对应 `session-isolation-*.test.mjs`。

- [ ] **步骤 4：删除对 legacy control-plane wiring 的依赖**

如果测试仍需要旧 `BridgeRuntime` 私有方法，改为构造显式 port：

```js
const chatPreprocessor = new SdkChatPreprocessor({
  chatEntryPolicy,
  slashExecutionUseCase,
  contextResolver,
  businessEntryContextResolver,
  normalChatSessionResolver,
  effectiveDirectory: '/workspace',
});
```

- [ ] **步骤 5：运行插件 SDK runtime 相关测试**

运行：

```bash
pnpm --filter @wecode/skill-opencode-plugin run test:sdk-runtime
node --import tsx/esm --test --test-force-exit plugins/message-bridge/tests/unit/session-isolation-*.test.mjs
```

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```bash
git add plugins/message-bridge/src/runtime/sdk plugins/message-bridge/tests/unit
git commit -m "test: migrate message bridge sdk provider coverage"
```

## 任务 4：将 singleton 固定为 SDK runtime

**文件：**
- 修改：`plugins/message-bridge/src/runtime/singleton.ts`
- 修改：`plugins/message-bridge/src/runtime/ManagedRuntime.ts`
- 修改：`plugins/message-bridge/tests/integration/plugin.test.mjs`
- 修改：`plugins/message-bridge/tests/unit/sdk-runtime-register.test.mjs`

- [ ] **步骤 1：先写 singleton 不支持 legacy 分支的测试**

在 `plugin.test.mjs` 或新增 singleton 单测中设置 legacy env，断言仍创建 SDK runtime：

```js
process.env.MESSAGE_BRIDGE_RUNTIME_MODE = 'legacy';
await assert.doesNotReject(startMessageBridgeRuntime());
assert.equal(findLog('runtime.singleton.initialized').body.extra.runtimeMode, 'sdk');
```

- [ ] **步骤 2：运行测试确认当前行为失败**

运行：

```bash
pnpm --filter @wecode/skill-opencode-plugin run test:integration -- plugin.test.mjs
```

预期：当前代码会走 legacy 分支或记录 `runtimeMode=legacy`，测试 FAIL。

- [ ] **步骤 3：修改 `singleton.ts` 固定装配 `SdkBridgeRuntime`**

将：

```ts
import { BridgeRuntime } from './BridgeRuntime.js';

function resolveRuntimeMode(): 'sdk' | 'legacy' {
  return process.env.MESSAGE_BRIDGE_RUNTIME_MODE?.trim() === 'legacy' ? 'legacy' : 'sdk';
}

const runtimeMode = resolveRuntimeMode();
const candidate: ManagedRuntime = runtimeMode === 'legacy'
  ? new BridgeRuntime(...)
  : new SdkBridgeRuntime(...);
```

改为：

```ts
const runtimeMode = 'sdk' as const;
const candidate: ManagedRuntime = new SdkBridgeRuntime({
  workspacePath: input.worktree || input.directory,
  hostDirectory: input.worktree || input.directory,
  client: input.client,
  runtimeTraceId: ensureCurrentRuntimeTraceId(),
});
```

- [ ] **步骤 4：更新 `ManagedRuntime.ts` 注释**

将注释改为：

```ts
/**
 * 插件 runtime 在 singleton 中暴露的最小统一接口。
 * @remarks
 * singleton 只关心生命周期与宿主事件入口，不感知 SDK runtime 内部装配细节。
 */
```

- [ ] **步骤 5：运行 singleton 与 SDK runtime 测试**

运行：

```bash
pnpm --filter @wecode/skill-opencode-plugin run test:sdk-runtime
pnpm --filter @wecode/skill-opencode-plugin run test:integration -- plugin.test.mjs
```

预期：全部 PASS；日志中的 `runtimeMode` 固定为 `sdk`。

- [ ] **步骤 6：Commit**

```bash
git add plugins/message-bridge/src/runtime/singleton.ts \
  plugins/message-bridge/src/runtime/ManagedRuntime.ts \
  plugins/message-bridge/tests/integration/plugin.test.mjs \
  plugins/message-bridge/tests/unit/sdk-runtime-register.test.mjs
git commit -m "refactor: force message bridge sdk runtime"
```

## 任务 5：删除 legacy runtime 类并整理导出

**文件：**
- 删除：`plugins/message-bridge/src/runtime/BridgeRuntime.ts`
- 修改：`plugins/message-bridge/src/runtime/index.ts`
- 修改：`plugins/message-bridge/tests/**/*.test.mjs`
- 修改：`plugins/message-bridge/package.json`

- [ ] **步骤 1：先确保没有运行时代码依赖 `BridgeRuntime.ts`**

运行：

```bash
rg -n "from ['\"].*BridgeRuntime|BridgeRuntime\\.js|MESSAGE_BRIDGE_RUNTIME_MODE|runtimeMode.*legacy|new BridgeRuntime|class BridgeRuntime|src/runtime/BridgeRuntime" plugins/message-bridge/src --glob '!runtime/BridgeRuntime.ts'
```

预期：无 legacy runtime 命中。`SdkBridgeRuntime`、`BridgeRuntimeStatusAdapter`、`ManagedRuntime` 等非 legacy 名称允许存在，但不能再有 `import { BridgeRuntime }`、`BridgeRuntime.js`、`new BridgeRuntime` 或 `MESSAGE_BRIDGE_RUNTIME_MODE`。

- [ ] **步骤 2：删除 legacy 文件**

```bash
git rm plugins/message-bridge/src/runtime/BridgeRuntime.ts
```

- [ ] **步骤 3：更新 runtime barrel**

将 `plugins/message-bridge/src/runtime/index.ts` 从：

```ts
export * from './BridgeRuntime.js';
export * from './BridgeRuntimeStatusAdapter.js';
```

改为：

```ts
export * from './BridgeRuntimeStatusAdapter.js';
export * from './ManagedRuntime.js';
export * from './SdkBridgeRuntime.js';
```

- [ ] **步骤 4：删除或改写旧测试文件**

对矩阵中标记为“已迁移”或“删除且说明原因”的 legacy unit 文件执行：

```bash
git rm plugins/message-bridge/tests/unit/runtime-protocol.test.mjs
git rm plugins/message-bridge/tests/unit/runtime-slash-control-plane.test.mjs
git rm plugins/message-bridge/tests/unit/plugin-event-relay.test.mjs
```

如果某个文件仍有未迁移场景，先补到任务 2 或任务 3 的新归属测试，再删除。

- [ ] **步骤 5：删除或改写旧 integration protocol 测试文件**

这些文件都直接构造 legacy `BridgeRuntime`，不能在删除 `BridgeRuntime.ts` 后继续由 `test:integration` 通配入口加载。按矩阵完成迁移后执行：

```bash
git rm plugins/message-bridge/tests/integration/example.test.mjs
git rm plugins/message-bridge/tests/integration/protocol-connect.test.mjs
git rm plugins/message-bridge/tests/integration/protocol-chat-stream.test.mjs
git rm plugins/message-bridge/tests/integration/protocol-directory.test.mjs
git rm plugins/message-bridge/tests/integration/protocol-question.test.mjs
git rm plugins/message-bridge/tests/integration/protocol-permission.test.mjs
git rm plugins/message-bridge/tests/integration/protocol-message-updated-large-payload.test.mjs
```

如需保留少量端到端 smoke，只能在 `plugins/message-bridge/tests/integration/plugin.test.mjs` 中通过 public plugin API 和 mock gateway 覆盖，不再新增直接 `new BridgeRuntime(...)` 的 integration 测试。

- [ ] **步骤 6：整理 `package.json` 脚本**

确保 `test:unit` 不再依赖已删除文件，`test:sdk-runtime` 不再是过渡脚本。可保留为快速入口：

```json
"test:sdk-runtime": "node --import tsx/esm --test --test-force-exit tests/unit/sdk-runtime-register.test.mjs tests/unit/sdk-provider-adapter.test.mjs tests/unit/sdk-chat-control-plane.test.mjs"
```

- [ ] **步骤 7：运行搜索确认 legacy runtime 已移除**

运行：

```bash
rg -n "from ['\"]../../src/runtime/BridgeRuntime|BridgeRuntime\\.js|src/runtime/BridgeRuntime|MESSAGE_BRIDGE_RUNTIME_MODE|runtimeMode.*legacy|new BridgeRuntime|class BridgeRuntime" plugins/message-bridge packages/bridge-runtime-sdk docs
```

预期：没有运行时代码和测试命中；文档若命中必须是 `docs/superpowers/plans/` 下的历史/执行计划，或已在任务 6 明确标为历史背景。

- [ ] **步骤 8：运行插件测试**

运行：

```bash
pnpm --filter @wecode/skill-opencode-plugin run test:unit
pnpm --filter @wecode/skill-opencode-plugin run test:integration
```

预期：全部 PASS。

- [ ] **步骤 9：Commit**

```bash
git add plugins/message-bridge/src/runtime plugins/message-bridge/tests plugins/message-bridge/package.json
git commit -m "refactor: remove legacy message bridge runtime"
```

## 任务 6：更新文档与运维参考

**文件：**
- 修改：`plugins/message-bridge/docs/operations/logging-reference.md`
- 修改：`plugins/message-bridge/docs/quality/traceability-matrix.md`
- 修改：`plugins/message-bridge/docs/quality/test-strategy.md`
- 修改：`plugins/message-bridge/docs/design/interfaces/end-to-end-message-flow.md`
- 修改：`plugins/message-bridge/docs/architecture/source-layout.md`
- 可选修改：`plugins/message-bridge/docs/design/interfaces/bridge-runtime-sdk-replacement-assessment.md`

- [ ] **步骤 1：更新日志参考**

把 `src/runtime/BridgeRuntime.ts` 的 legacy 日志来源改为 `src/runtime/SdkBridgeRuntime.ts`、`packages/bridge-runtime-sdk/src/**` 或 provider adapter。示例：

```markdown
| `runtime.start.completed` | info | SDK runtime 启动完成 | `runtimeMode`,`effectiveDirectory` | `src/runtime/SdkBridgeRuntime.ts` |
| `runtime_sdk.downstream.received` | info | SDK runtime 收到 gateway 下行 | `messageType`,`action`,`toolSessionId`,`welinkSessionId` | `packages/bridge-runtime-sdk/src/application/runtime-assembly/downstream.ts` |
```

- [ ] **步骤 2：更新追踪矩阵**

将：

```markdown
| Runtime does orchestration only | `src/runtime/BridgeRuntime.ts` |
```

改为：

```markdown
| Runtime orchestration owned by SDK | `packages/bridge-runtime-sdk/src/application/runtime-assembly/*`, `plugins/message-bridge/src/runtime/SdkBridgeRuntime.ts` |
```

- [ ] **步骤 3：更新端到端消息流引用**

将 `Related` 中的 `../../../src/runtime/BridgeRuntime.ts` 改为：

```markdown
`../../../src/runtime/SdkBridgeRuntime.ts`, `../../../../packages/bridge-runtime-sdk/docs/bridge-runtime-sdk-architecture.md`
```

- [ ] **步骤 4：更新测试策略**

把 `plugins/message-bridge/docs/quality/test-strategy.md` 中直接构造 legacy runtime 的示例：

```js
const runtime = new BridgeRuntime({ client: {} });
```

改为 SDK/runtime adapter 测试入口说明，例如：

```js
const runtime = new SdkBridgeRuntime({ client, workspacePath, hostDirectory });
```

或改写为“SDK runtime 合同由 `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts` 覆盖，OpenCode adapter 由 `tests/unit/sdk-provider-adapter.test.mjs` 覆盖”。当前质量文档不得继续把 `BridgeRuntime.ts` 当作可执行测试对象。

- [ ] **步骤 5：更新 source layout**

删除 `runtime/BridgeRuntime.ts` 条目，新增或更新：

```markdown
6. `runtime/SdkBridgeRuntime.ts`
   SDK runtime composition root，负责插件配置、OpenCode provider adapter 装配和状态同步。
```

- [ ] **步骤 6：文档规则检查**

运行：

```bash
rg -n "BridgeRuntime.ts|new BridgeRuntime|MESSAGE_BRIDGE_RUNTIME_MODE|legacy runtime" plugins/message-bridge/docs
```

预期：只允许历史评估文档中保留背景说明；当前架构、质量、运维文档不得继续指向 legacy runtime。

- [ ] **步骤 7：Commit**

```bash
git add plugins/message-bridge/docs
git commit -m "docs: document sdk runtime cutover"
```

## 任务 7：全仓验证与收口

**文件：**
- 修改：按前序任务结果

- [ ] **步骤 1：运行 SDK 包验证**

```bash
pnpm --filter @wecode/bridge-runtime-sdk run verify:core
```

预期：build、typecheck、test、pack check 全部 PASS。

- [ ] **步骤 2：运行 message-bridge 包验证**

```bash
pnpm --filter @wecode/skill-opencode-plugin run verify:core
```

预期：release tracking、typecheck、unit、integration、coverage、pack check 全部 PASS。

- [ ] **步骤 3：运行跨包验证**

```bash
pnpm verify:workspace
```

预期：全部 PASS；如果只因已有无关改动失败，记录失败命令、失败测试和与本计划的关系。

- [ ] **步骤 4：最终搜索**

```bash
rg -n "from ['\"]../../src/runtime/BridgeRuntime|BridgeRuntime\\.js|src/runtime/BridgeRuntime|MESSAGE_BRIDGE_RUNTIME_MODE|runtimeMode.*legacy|new BridgeRuntime|class BridgeRuntime" plugins/message-bridge packages/bridge-runtime-sdk
```

预期：无运行时代码和测试命中。`BridgeRuntimeStatusAdapter`、`SdkBridgeRuntime`、SDK 包公开类型 `BridgeRuntime` 允许存在；如搜索命中这些非 legacy 名称，不视为失败，但必须确认没有指向 `plugins/message-bridge/src/runtime/BridgeRuntime.ts`。

- [ ] **步骤 5：确认 stage 范围**

运行：

```bash
git status --short
```

预期：只包含本计划相关文件。不要 stage `.pnpm-store/`、`integration/opencode-cui` 或其他无关文件。

- [ ] **步骤 6：Commit**

```bash
git add docs/superpowers/plans/2026-05-27-message-bridge-sdk-runtime-cutover-plan.md \
  docs/superpowers/plans/2026-05-27-message-bridge-sdk-runtime-test-matrix.md \
  packages/bridge-runtime-sdk/src packages/bridge-runtime-sdk/tests \
  plugins/message-bridge/src plugins/message-bridge/tests plugins/message-bridge/package.json \
  plugins/message-bridge/docs
git commit -m "chore: verify sdk runtime cutover"
```

## 验收标准

1. `plugins/message-bridge/src/runtime/BridgeRuntime.ts` 已删除。
2. `plugins/message-bridge/src/runtime/singleton.ts` 不再支持 `MESSAGE_BRIDGE_RUNTIME_MODE=legacy`，固定创建 `SdkBridgeRuntime`。
3. `plugins/message-bridge/tests` 不再直接导入 legacy `BridgeRuntime`。
4. 原 legacy runtime 测试中的稳定 runtime 语义已迁移到 `packages/bridge-runtime-sdk/tests`。
5. OpenCode 专用行为已迁移到 `plugins/message-bridge/tests/unit/sdk-provider-adapter.test.mjs`、`sdk-chat-control-plane.test.mjs` 或 session-isolation 测试。
6. 插件集成测试只验证 public API、装配、配置、register metadata 和少量 mock gateway smoke，不再承担 SDK 内部协议矩阵。
7. `pnpm --filter @wecode/bridge-runtime-sdk run verify:core`、`pnpm --filter @wecode/skill-opencode-plugin run verify:core`、`pnpm verify:workspace` 均通过，或失败项已明确不是本迁移引入。

## 风险与处理

1. 风险：旧 `runtime-protocol.test.mjs` 覆盖面很大，直接删除会丢语义。
   处理：任务 1 先建立矩阵，所有删除必须有新归属或明确删除理由。
2. 风险：把 OpenCode 专用策略补进 SDK 会污染 public contract。
   处理：只有 gateway 下行、provider SPI、fact、terminal、registry 这类跨 provider 稳定语义进入 SDK；directory、suppressReply、raw event 字段路径留在插件 adapter。
3. 风险：插件集成测试若继续 mock legacy 私有方法，会阻塞删除。
   处理：改为 public runtime API、`SdkBridgeRuntime.resolveConfig()` 子类覆写或显式测试装配端口。
4. 风险：日志/文档仍指向 legacy 文件，导致后续排障误导。
   处理：任务 6 用 `rg` 清理当前架构、质量、运维文档引用。
