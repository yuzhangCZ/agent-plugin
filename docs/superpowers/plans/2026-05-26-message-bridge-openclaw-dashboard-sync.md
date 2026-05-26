# Message Bridge OpenClaw Dashboard Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让外部宿主通过 `message-bridge` 接入 OpenClaw 时，宿主会话的用户消息、助手回复、流式状态和会话元数据都能出现在 `openclaw --dev dashboard` 的会话列表与会话记录中。

**Architecture:** 采用 OpenClaw 原生 channel turn 语义作为主路径：`message-bridge-openclaw` 仍然作为 bridge-runtime-sdk 的 `ThirdPartyAgentProvider`，但在调用 OpenClaw reply runtime 前，必须解析 canonical `route.sessionKey`，并通过 OpenClaw 的 session record / prepared turn 流程写入 session store。外部 gateway 所需的 `ProviderFact` 仍由插件本地转换器产出，dashboard 所需的会话可见性由 OpenClaw session store、transcript 和事件广播负责。

**Tech Stack:** TypeScript ESM, OpenClaw plugin runtime, `openclaw/plugin-sdk` subpath APIs, Node test runner `.mjs`, `pnpm --dir plugins/message-bridge-openclaw run test:unit`, `pnpm --dir plugins/message-bridge-openclaw run typecheck`.

---

## 设计决策

推荐方案是“修正 message-bridge-openclaw 适配层，复用 OpenClaw 原生入站 turn 记录语义”，不是在 dashboard 端额外拉取 message-bridge 的 ProviderFact。

原因：

- dashboard 当前数据源是 OpenClaw session store 与 transcript，不是 bridge-runtime-sdk 的 session registry。
- OpenClaw 已经有 `runPreparedChannelTurn` / `recordInboundSession` 这套可复用的 session record 顺序。
- 让 `message-bridge` 作为真正 channel 入站消息进入 OpenClaw，可以天然获得 session list、history、last message、模型元数据、后续 abort/steer 等 dashboard 行为。
- 不把 dashboard 特例写进 `integration/openclaw/src/gateway/server-methods/chat.ts`，避免污染 webchat/dashboard 自身路径。

## 文件结构

- Modify: `plugins/message-bridge-openclaw/src/sdk/OpenClawProviderAdapter.ts`
  - 解析并保存 canonical OpenClaw `route.sessionKey`。
  - 构建 `ctxPayload` 时使用 canonical session key。
  - 优先通过 OpenClaw channel turn record 入口执行 runtime reply。
  - 保持 `ProviderFact` 输出兼容外部宿主。

- Modify: `plugins/message-bridge-openclaw/src/session/SessionRegistry.ts`
  - 保留 `toolSessionId -> MessageBridgeSessionRecord` 映射。
  - 允许在首次路由解析后把 `record.sessionKey` 从插件临时 key 绑定到 OpenClaw canonical key。
  - 保留旧字段名，避免 bridge-runtime-sdk 调用侧受影响。

- Modify: `plugins/message-bridge-openclaw/src/types/openclaw-plugin-sdk-shim.d.ts`
  - 补齐本插件会使用的 `runtime.channel.session.resolveStorePath`、`recordInboundSession`、`readSessionUpdatedAt` 类型。
  - 如使用 `openclaw/plugin-sdk/inbound-reply-dispatch`，补齐相应 shim。

- Modify: `plugins/message-bridge-openclaw/tests/stubs/openclaw/plugin-sdk/channel-runtime.js`
  - 仅当新增 SDK subpath 需要 stub 时修改。

- Modify: `plugins/message-bridge-openclaw/tests/unit/openclaw-provider-adapter.test.mjs`
  - 覆盖 canonical session key、record 调用顺序、fallback 兼容、abort key 映射。

- Modify: `plugins/message-bridge-openclaw/tests/unit/session-registry.test.mjs`
  - 覆盖 session key 绑定行为。

- Optional Modify: `plugins/message-bridge-openclaw/docs/USAGE.zh-CN.md`
  - 记录“外部宿主会话会显示在 OpenClaw dashboard”的预期行为和排障命令。

## Task 1: 让 SessionRegistry 支持 canonical OpenClaw session key 绑定

**Files:**
- Modify: `plugins/message-bridge-openclaw/src/session/SessionRegistry.ts`
- Test: `plugins/message-bridge-openclaw/tests/unit/session-registry.test.mjs`

- [ ] **Step 1: 写失败测试**

在 `plugins/message-bridge-openclaw/tests/unit/session-registry.test.mjs` 追加：

```js
test("bindSessionKey updates an existing tool session to canonical OpenClaw key", () => {
  const registry = new SessionRegistry("message-bridge:acct");
  const initial = registry.ensure("tool_1", "wl_1");

  assert.equal(initial.sessionKey, "message-bridge:acct:tool_1");

  const rebound = registry.bindSessionKey("tool_1", "agent:main:message-bridge:direct:tool_1");
  const again = registry.ensure("tool_1");

  assert.equal(rebound.sessionKey, "agent:main:message-bridge:direct:tool_1");
  assert.equal(again.sessionKey, "agent:main:message-bridge:direct:tool_1");
  assert.equal(again.welinkSessionId, "wl_1");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm --dir plugins/message-bridge-openclaw run test:unit -- session-registry
```

Expected: FAIL，错误包含 `registry.bindSessionKey is not a function`。

- [ ] **Step 3: 实现最小方法**

在 `SessionRegistry` 中加入：

```ts
  bindSessionKey(toolSessionId: string, sessionKey: string): MessageBridgeSessionRecord {
    const record = this.ensure(toolSessionId);
    record.sessionKey = sessionKey;
    record.updatedAt = Date.now();
    return record;
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
pnpm --dir plugins/message-bridge-openclaw run test:unit -- session-registry
```

Expected: PASS。

## Task 2: 为 OpenClawProviderAdapter 增加 canonical route session key 测试

**Files:**
- Modify: `plugins/message-bridge-openclaw/tests/unit/openclaw-provider-adapter.test.mjs`

- [ ] **Step 1: 写失败测试**

在 `openclaw-provider-adapter.test.mjs` 追加：

```js
test("provider adapter uses OpenClaw route session key for runtime reply context and active run mapping", async () => {
  let capturedCtx;
  let capturedRunSessionKey;
  const provider = createAdapter({
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute() {
            return {
              accountId: "acct",
              agentId: "main",
              sessionKey: "agent:main:message-bridge:direct:ses_route_1",
              mainSessionKey: "agent:main:main",
              lastRoutePolicy: "session",
            };
          },
        },
        reply: {
          resolveEnvelopeFormatOptions() {
            return {};
          },
          formatAgentEnvelope({ body }) {
            return body;
          },
          finalizeInboundContext(input) {
            capturedCtx = input;
            return input;
          },
          async dispatchReplyWithBufferedBlockDispatcher({ ctx, dispatcherOptions, replyOptions }) {
            capturedRunSessionKey = ctx.SessionKey;
            replyOptions.onAgentRunStart("host-run-route-1");
            await dispatcherOptions.deliver({ text: "hello" }, { kind: "final" });
          },
        },
      },
    },
  });

  const run = await provider.runMessage({
    traceId: "trace-1",
    runId: "sdk-run-route-1",
    toolSessionId: "ses_route_1",
    text: "hi",
  });

  const facts = [];
  for await (const fact of run.facts) {
    facts.push(fact);
  }

  assert.equal(capturedCtx.SessionKey, "agent:main:message-bridge:direct:ses_route_1");
  assert.equal(capturedRunSessionKey, "agent:main:message-bridge:direct:ses_route_1");
  assert.equal(facts.find((fact) => fact.type === "text.done").content, "hello");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm --dir plugins/message-bridge-openclaw run test:unit -- openclaw-provider-adapter
```

Expected: FAIL，`capturedCtx.SessionKey` 当前仍是 `agent:acct:ses_route_1` 或插件自造 key。

## Task 3: 在 runtime reply 主路径绑定 canonical session key

**Files:**
- Modify: `plugins/message-bridge-openclaw/src/sdk/OpenClawProviderAdapter.ts`

- [ ] **Step 1: 提取 route session key 解析函数**

在 `OpenClawProviderAdapter.ts` 中加入私有方法：

```ts
  private resolveCanonicalSessionKey(route: Record<string, unknown>, fallback: string): string {
    const routed = asTrimmedString(route.sessionKey);
    return routed ?? fallback;
  }
```

- [ ] **Step 2: 在 `runWithReplyRuntime` 解析 route 后绑定 session key**

在 `const route = resolveAgentRoute(...)` 后加入：

```ts
    const routeRecord = asRecord(route) ?? {};
    const canonicalSessionKey = this.resolveCanonicalSessionKey(routeRecord, state.sessionKey);
    if (canonicalSessionKey !== state.sessionKey) {
      this.activeRunsBySessionKey.delete(state.sessionKey);
      state.sessionKey = canonicalSessionKey;
      this.options.sessionRegistry.bindSessionKey(state.toolSessionId, canonicalSessionKey);
      this.activeRunsBySessionKey.set(canonicalSessionKey, state);
    }
```

同时把后续 `SessionKey`、`sessionKeyByRunId`、debug log 都继续使用 `state.sessionKey`。

- [ ] **Step 3: 运行 Task 2 测试**

Run:

```bash
pnpm --dir plugins/message-bridge-openclaw run test:unit -- openclaw-provider-adapter
```

Expected: Task 2 新增测试 PASS，既有 abort/debug 测试仍 PASS。

## Task 4: 复用 OpenClaw session record 入口，而不是裸调 dispatcher

**Files:**
- Modify: `plugins/message-bridge-openclaw/src/sdk/OpenClawProviderAdapter.ts`
- Modify: `plugins/message-bridge-openclaw/src/types/openclaw-plugin-sdk-shim.d.ts`
- Optional Modify: `plugins/message-bridge-openclaw/tests/stubs/openclaw/plugin-sdk/channel-runtime.js`

- [ ] **Step 1: 写失败测试，要求记录发生在 dispatch 前**

在 `openclaw-provider-adapter.test.mjs` 追加：

```js
test("provider adapter records inbound session before runtime reply dispatch", async () => {
  const calls = [];
  const provider = createAdapter({
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute() {
            return {
              accountId: "acct",
              agentId: "main",
              sessionKey: "agent:main:message-bridge:direct:ses_record_1",
              mainSessionKey: "agent:main:main",
              lastRoutePolicy: "session",
            };
          },
        },
        session: {
          resolveStorePath(_store, opts) {
            calls.push({ kind: "resolveStorePath", agentId: opts.agentId });
            return "/tmp/openclaw-session-store.json";
          },
          async recordInboundSession(input) {
            calls.push({
              kind: "recordInboundSession",
              sessionKey: input.sessionKey,
              provider: input.ctx.Provider,
              body: input.ctx.BodyForAgent,
            });
          },
          readSessionUpdatedAt() {
            return undefined;
          },
        },
        reply: {
          resolveEnvelopeFormatOptions() {
            return {};
          },
          formatAgentEnvelope({ body }) {
            return body;
          },
          finalizeInboundContext(input) {
            return input;
          },
          async dispatchReplyWithBufferedBlockDispatcher({ ctx, dispatcherOptions }) {
            calls.push({ kind: "dispatch", sessionKey: ctx.SessionKey });
            await dispatcherOptions.deliver({ text: "recorded" }, { kind: "final" });
          },
        },
      },
    },
  });

  const run = await provider.runMessage({
    traceId: "trace-1",
    runId: "sdk-run-record-1",
    toolSessionId: "ses_record_1",
    text: "hi dashboard",
  });

  for await (const _fact of run.facts) {}

  assert.deepEqual(calls, [
    { kind: "resolveStorePath", agentId: "main" },
    {
      kind: "recordInboundSession",
      sessionKey: "agent:main:message-bridge:direct:ses_record_1",
      provider: "message-bridge",
      body: "hi dashboard",
    },
    { kind: "dispatch", sessionKey: "agent:main:message-bridge:direct:ses_record_1" },
  ]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm --dir plugins/message-bridge-openclaw run test:unit -- openclaw-provider-adapter
```

Expected: FAIL，当前不会调用 `runtime.channel.session.recordInboundSession`。

- [ ] **Step 3: 增加 runtime session 类型守卫**

在 `OpenClawProviderAdapter.ts` 增加类型：

```ts
type RuntimeSessionRecord = {
  resolveStorePath(store: string | undefined, opts: { agentId: string }): string;
  recordInboundSession(input: {
    storePath: string;
    sessionKey: string;
    ctx: Record<string, unknown>;
    createIfMissing?: boolean;
    onRecordError: (err: unknown) => void;
  }): Promise<void>;
  readSessionUpdatedAt?(params: { storePath: string; sessionKey: string }): number | undefined;
};
```

增加方法：

```ts
  private getUsableSessionRecordRuntime(): RuntimeSessionRecord | null {
    const session = this.options.runtime.channel?.session as RuntimeSessionRecord | undefined;
    if (
      session &&
      typeof session.resolveStorePath === "function" &&
      typeof session.recordInboundSession === "function"
    ) {
      return session;
    }
    return null;
  }
```

- [ ] **Step 4: 在 dispatch 前记录 inbound session**

在 `runWithReplyRuntime` 构建 `ctxPayload` 后、调用 `dispatchReplyWithBufferedBlockDispatcher` 前加入：

```ts
    const sessionRuntime = this.getUsableSessionRecordRuntime();
    if (sessionRuntime) {
      const storePath = sessionRuntime.resolveStorePath(undefined, { agentId: route.agentId });
      await sessionRuntime.recordInboundSession({
        storePath,
        sessionKey: state.sessionKey,
        ctx: ctxPayload as Record<string, unknown>,
        createIfMissing: true,
        onRecordError: (error) => {
          this.options.logger.warn("runtime.session_record.failed", {
            toolSessionId: state.toolSessionId,
            sessionKey: state.sessionKey,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
    }
```

注意：这个步骤只解决 session list 可见性。用户 turn 的 transcript 即时可见性依赖 Task 5。

- [ ] **Step 5: 跑新增测试**

Run:

```bash
pnpm --dir plugins/message-bridge-openclaw run test:unit -- openclaw-provider-adapter
```

Expected: PASS。

## Task 5: 让 dashboard history 立即看到外部宿主用户消息

**Files:**
- Modify: `plugins/message-bridge-openclaw/src/sdk/OpenClawProviderAdapter.ts`
- Modify: `plugins/message-bridge-openclaw/src/types/openclaw-plugin-sdk-shim.d.ts`

- [ ] **Step 1: 选择实现边界**

采用“先只写 session store，不手写 transcript”的保守实现。如果实际联调发现 dashboard 列表出现但 history 缺少用户 turn，再补一个 OpenClaw 侧正式 SDK helper，而不是在插件里复制 `gateway/server-methods/chat.ts` 的 `emitSessionTranscriptUpdate` 内部逻辑。

应新增的 OpenClaw SDK helper 设计如下：

```ts
// openclaw/plugin-sdk/session-transcript-runtime
export async function appendInboundUserMessageToSessionTranscript(input: {
  agentId: string;
  sessionKey: string;
  text: string;
  idempotencyKey: string;
  provider: string;
  timestamp?: number;
}): Promise<{ ok: true; messageId?: string } | { ok: false; reason: string }>;
```

该 helper 应在 `integration/openclaw/src/config/sessions/transcript.ts` 附近实现，内部复用 `appendSessionTranscriptMessage`，不要复制 gateway webchat 的媒体处理分支。

- [ ] **Step 2: 写联调验证脚本或手动验证记录**

手动验证步骤：

```bash
pnpm --dir plugins/message-bridge-openclaw run build
openclaw --dev dashboard
```

然后从外部宿主通过 `message-bridge` 发起一条新会话消息，预期：

- dashboard session list 出现 `Message Bridge` 或 `ai-gateway:<toolSessionId>` 来源的会话。
- 会话 key 是 `agent:<agentId>:...` 形态。
- history 中至少出现助手回复。
- 如果 history 暂时没有用户 turn，执行 Task 5 SDK helper 扩展。

## Task 6: fallback subagent 路径同步使用 canonical key

**Files:**
- Modify: `plugins/message-bridge-openclaw/src/sdk/OpenClawProviderAdapter.ts`
- Test: `plugins/message-bridge-openclaw/tests/unit/openclaw-provider-adapter.test.mjs`

- [ ] **Step 1: 写失败测试**

新增测试：

```js
test("provider adapter fallback passes canonical session key to subagent runtime when route resolver exists", async () => {
  const calls = [];
  const provider = createAdapter({
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute() {
            return {
              accountId: "acct",
              agentId: "main",
              sessionKey: "agent:main:message-bridge:direct:ses_fallback_route_1",
              mainSessionKey: "agent:main:main",
              lastRoutePolicy: "session",
            };
          },
        },
      },
    },
    getSubagentRuntime: () => ({
      async run(input) {
        calls.push({ kind: "run", sessionKey: input.sessionKey, message: input.message });
        return { runId: "sub-route-1" };
      },
      async waitForRun() {
        return { status: "ok" };
      },
      async getSessionMessages(input) {
        calls.push({ kind: "get", sessionKey: input.sessionKey });
        return { messages: [{ role: "assistant", content: "fallback routed" }] };
      },
    }),
  });

  const run = await provider.runMessage({
    traceId: "trace-1",
    runId: "sdk-run-fallback-route-1",
    toolSessionId: "ses_fallback_route_1",
    text: "hi fallback",
  });

  for await (const _fact of run.facts) {}

  assert.deepEqual(calls, [
    {
      kind: "run",
      sessionKey: "agent:main:message-bridge:direct:ses_fallback_route_1",
      message: "hi fallback",
    },
    { kind: "get", sessionKey: "agent:main:message-bridge:direct:ses_fallback_route_1" },
  ]);
});
```

- [ ] **Step 2: 实现 route 预解析**

把 route 解析提取为 `resolveMessageBridgeRoute(state)`，在 runtime reply 和 subagent fallback 两条路径都调用。若没有 route resolver，则 fallback 保持当前临时 key。

- [ ] **Step 3: 跑测试**

Run:

```bash
pnpm --dir plugins/message-bridge-openclaw run test:unit -- openclaw-provider-adapter
```

Expected: PASS。

## Task 7: 状态与文档

**Files:**
- Modify: `plugins/message-bridge-openclaw/docs/USAGE.zh-CN.md`
- Optional Modify: `plugins/message-bridge-openclaw/docs/LOGGING-MATRIX.zh-CN.md`

- [ ] **Step 1: 文档补充**

在 `USAGE.zh-CN.md` 增加：

```md
### Dashboard 会话同步

外部宿主通过 `message-bridge` 发送的会话会映射到 OpenClaw 的 agent session key，并显示在 `openclaw --dev dashboard` 会话列表中。

排查顺序：

1. 确认 message-bridge channel 状态为 connected。
2. 确认日志没有 `runtime.session_record.failed`。
3. 确认会话 key 为 `agent:<agentId>:...`，而不是 `message-bridge:<accountId>:...`。
4. 若列表可见但历史缺少用户 turn，检查 OpenClaw session transcript helper 是否可用。
```

- [ ] **Step 2: 跑文档相关快速检查**

Run:

```bash
pnpm --dir plugins/message-bridge-openclaw run typecheck
```

Expected: PASS。

## Task 8: 最终验证

**Files:**
- No code changes.

- [ ] **Step 1: 插件单测**

Run:

```bash
pnpm --dir plugins/message-bridge-openclaw run test:unit
```

Expected: PASS。

- [ ] **Step 2: 插件类型检查**

Run:

```bash
pnpm --dir plugins/message-bridge-openclaw run typecheck
```

Expected: PASS。

- [ ] **Step 3: 插件核心验证**

Run:

```bash
pnpm --dir plugins/message-bridge-openclaw run verify:core
```

Expected: PASS。

- [ ] **Step 4: 手动 dashboard 验证**

Run:

```bash
pnpm --dir plugins/message-bridge-openclaw run build
openclaw --dev dashboard
```

从外部宿主发送一条消息，确认：

- dashboard session list 出现新会话。
- 会话 key 为 `agent:<agentId>:...`。
- 会话详情能看到助手回复。
- 若 Task 5 helper 已实现，会话详情也能看到用户消息。
- abort / close 仍作用在同一个 canonical session key。

## 风险与回滚

- 最大风险：`recordInboundSession` 只写 session store，不保证 transcript 中有用户消息。解决方式是 Task 5 新增正式 transcript helper。
- 兼容风险：旧测试假设 session key 是 `agent:acct:<toolSessionId>`。需要同步调整为 `route.sessionKey` 优先，fallback 才用旧 key。
- 回滚方式：保留 `SessionRegistry` 的 fallback key 生成逻辑；若 OpenClaw runtime 缺少 `channel.session`，主路径仍可继续执行，只是 dashboard 同步降级。

## 自检

- 覆盖目标：session list 可见、canonical key、record 顺序、fallback、abort、文档和验证命令均有任务。
- 无占位：没有 `TBD` 或未定义行为；Task 5 明确了分阶段边界。
- 类型一致：`sessionKey` 统一优先使用 `route.sessionKey`，ProviderFact 仍使用 `toolSessionId` 对外。
