# 三方 Agent 集成接口文档 v1

**Version:** 1.0-draft  
**Date:** 2026-04-16  
**Status:** Draft  
**Owner:** agent-plugin maintainers  
**Related:** [bridge-refactor-architecture.md](../../architecture/bridge-refactor-architecture.md), [protocol-contract.md](../../../plugins/message-bridge/docs/design/interfaces/protocol-contract.md)

## 背景

本文面向三方 agent 集成方，定义接入 bridge 的 v1 外部接口。

你可以把 bridge 理解为一个托管运行时：

- 它负责和 gateway 建立连接
- 它负责把 gateway 下发的请求转成 provider 调用
- 它负责把 provider 返回的事件转换成 gateway 可消费的结果

集成方不需要直接处理 gateway 连接细节，也不需要直接构造 gateway 协议消息。  
你只需要：

1. 创建并启动 Runtime SDK
2. 实现一个 Provider
3. 在 Provider 中完成会话、消息执行、交互回复、关闭和中断能力
4. 按文档要求输出事件流

本文档中的业务事件命名参考 miniapp / 云端链路的已翻译业务事件模型，不以 OpenCode 原始事件名作为外部契约基础。  
同时，v1 明确支持 **同一 `runMessage()` 下产生多条 assistant message**。SDK 不再假设“一次 run 只有一条主 message”。

这是对当前 `1.0-draft` 的重新定稿，不承诺与旧草案中的事件集合和 Provider 最小 SPI 向后兼容。

## 范围

### In Scope

- Runtime SDK 的公开入口
- Provider 的最小实现接口
- 当前 v1 支持的下行能力
- 当前 v1 支持的外部事件模型
- `question` / `permission` 的完整回复闭环
- 快速接入示例
- 外部集成方必须遵守的行为约束

### Out of Scope

- 内部实现细节
- gateway 协议内部结构说明
- provider 默认持久化方案
- 文件类 part、图片类 part 等未列入本文的其他内容类型
- 未在本文列出的其他事件类型

### External Dependencies

- 可访问的 gateway 服务
- 合法的 AK / SK 凭证
- 三方 agent 自身的会话、消息执行和交互回复能力

## 你需要做什么

对集成方来说，v1 接入只有两类工作：

### 1. 启动 Runtime SDK

Runtime SDK 负责：

- 建立连接
- 启动接入流程
- 接收请求
- 将请求转发给你实现的 Provider
- 维护 question / permission 的挂起交互索引

### 2. 实现 Provider

Provider 负责：

- 返回宿主在线状态
- 创建宿主会话
- 启动一次 run
- 在同一 run 内继续处理 question / permission 回复
- 关闭宿主会话
- 中断宿主会话或正在执行的 run
- 产出事件流和终态

## 快速开始

### 步骤 1：创建 Runtime

```ts
import { createBridgeRuntime } from '@your-scope/agent-bridge-sdk';

const runtime = createBridgeRuntime({
  gateway: {
    url: 'wss://gateway.example.com/ws/agent',
    ak: process.env.BRIDGE_AUTH_AK!,
    sk: process.env.BRIDGE_AUTH_SK!,
    channel: 'my-agent-channel',
  },
});
```

### 步骤 2：实现 Provider

```ts
import type {
  ProviderRun,
  ThirdPartyAgentProvider,
} from '@your-scope/agent-bridge-sdk';

class MyAgentProvider implements ThirdPartyAgentProvider {
  async health() {
    return { online: true };
  }

  async createSession(input) {
    const providerSessionId = await myAgent.createSession({
      title: input.title,
      assistantId: input.assistantId,
    });

    return { providerSessionId };
  }

  async runMessage(input): Promise<ProviderRun> {
    return startMyProviderRun(input);
  }

  async replyQuestion(input) {
    await myAgent.replyQuestion({
      sessionId: input.providerSessionId,
      questionId: input.questionId,
      answer: input.answer,
    });

    return { accepted: true };
  }

  async replyPermission(input) {
    await myAgent.replyPermission({
      sessionId: input.providerSessionId,
      permissionId: input.permissionId,
      response: input.response,
    });

    return { accepted: true };
  }

  async closeSession(input) {
    await myAgent.closeSession(input.providerSessionId);
    return { accepted: true };
  }

  async abortSession(input) {
    await myAgent.abortSession(input.providerSessionId, input.runId);
    return { accepted: true };
  }
}
```

### 步骤 3：注册 Provider 并启动

```ts
runtime.registerProvider(new MyAgentProvider());
await runtime.start();
```

## Runtime SDK

### API

```ts
export interface CreateBridgeRuntimeOptions {
  gateway: {
    url: string;
    ak: string;
    sk: string;
    channel: string;
    heartbeatIntervalMs?: number;
    reconnect?: {
      baseMs: number;
      maxMs: number;
      exponential: boolean;
    };
    readyTimeoutMs?: number;
  };
  logger?: BridgeLogger;
}

export interface BridgeRuntimeStatus {
  connectionState: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'READY';
  providerRegistered: boolean;
  gatewayReady: boolean;
}

export interface BridgeRuntimeSdk {
  registerProvider(provider: ThirdPartyAgentProvider): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): BridgeRuntimeStatus;
}

export function createBridgeRuntime(
  options: CreateBridgeRuntimeOptions,
): BridgeRuntimeSdk;
```

### 方法说明

| 方法 | 说明 |
|---|---|
| `createBridgeRuntime(options)` | 创建一个 Runtime SDK 实例 |
| `registerProvider(provider)` | 注册一个 Provider 实现 |
| `start()` | 建立连接并开始接收请求 |
| `stop()` | 停止运行并释放资源 |
| `getStatus()` | 获取当前运行状态 |

### 使用要求

- `registerProvider()` 必须在 `start()` 之前调用
- v1 只支持注册一个 Provider
- `start()` 成功后，runtime 才会开始对外提供服务

## Provider SPI

### API

```ts
export interface ThirdPartyAgentProvider {
  health(input: ProviderHealthInput): Promise<ProviderHealthResult>;

  createSession(input: ProviderCreateSessionInput): Promise<ProviderCreateSessionResult>;

  runMessage(input: ProviderRunMessageInput): Promise<ProviderRun>;

  replyQuestion(input: ProviderQuestionReplyInput): Promise<{ accepted: true }>;

  replyPermission(input: ProviderPermissionReplyInput): Promise<{ accepted: true }>;

  closeSession(input: ProviderCloseSessionInput): Promise<{ accepted: true }>;

  abortSession(input: ProviderAbortSessionInput): Promise<{ accepted: true }>;

  dispose?(): Promise<void>;
}
```

### 方法说明

| 方法 | 用途 |
|---|---|
| `health()` | 返回当前 agent 是否在线 |
| `createSession()` | 创建一个新的宿主会话 |
| `runMessage()` | 启动一次 run 并返回事件流 |
| `replyQuestion()` | 提交 question 回复并在同一 run 内继续执行 |
| `replyPermission()` | 提交 permission 回复并在同一 run 内继续执行 |
| `closeSession()` | 关闭一个已存在的会话 |
| `abortSession()` | 中断一个正在执行的会话或运行 |
| `dispose()` | 可选，用于释放 provider 自身资源 |

补充约束：

- `health()`、`createSession()`、`runMessage()`、`replyQuestion()`、`replyPermission()`、`closeSession()`、`abortSession()` 在 apply 失败时，必须以 rejected promise / throw 返回 `ProviderCommandError`。
- command failure 不属于 `ProviderError`、`session.error` 或 `run.terminal.error` 的覆盖范围。

## 请求与响应类型

```ts
export interface ProviderHealthInput {
  traceId: string;
}

export interface ProviderHealthResult {
  online: boolean;
}

export interface ProviderCreateSessionInput {
  traceId: string;
  toolSessionId: string;
  title?: string;
  assistantId?: string;
}

export interface ProviderCreateSessionResult {
  providerSessionId: string;
  title?: string;
}

export interface ProviderRunMessageInput {
  traceId: string;
  runId: string;
  toolSessionId: string;
  providerSessionId: string;
  text: string;
  assistantId?: string;
}

export interface ProviderQuestionReplyInput {
  traceId: string;
  runId: string;
  toolSessionId: string;
  providerSessionId: string;
  questionId: string;
  answer: string;
  toolCallId?: string;
}

export interface ProviderPermissionReplyInput {
  traceId: string;
  runId: string;
  toolSessionId: string;
  providerSessionId: string;
  permissionId: string;
  response: 'once' | 'always' | 'reject';
}

export interface ProviderCloseSessionInput {
  traceId: string;
  toolSessionId: string;
  providerSessionId: string;
}

export interface ProviderAbortSessionInput {
  traceId: string;
  runId?: string;
  toolSessionId: string;
  providerSessionId: string;
}

export interface ProviderCommandError {
  code:
    | 'invalid_input'
    | 'not_found'
    | 'not_supported'
    | 'provider_unavailable'
    | 'internal_error';
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `toolSessionId` | bridge 分配的会话标识 |
| `providerSessionId` | provider 自己的会话标识 |
| `runId` | 单次消息执行标识 |
| `traceId` | 诊断与追踪标识 |
| `questionId` | question 回复的稳定主键 |
| `permissionId` | permission 回复的稳定主键 |
| `toolCallId` | 可选的工具调用关联标识，不作 question 主键 |
| `assistantId` | 可选的助手或 agent 配置标识 |

说明：

- 集成方应将 `providerSessionId` 视为自己的主会话标识。
- 集成方不应假设 `toolSessionId` 和 `providerSessionId` 相同。
- 对存在稳定底层交互请求标识的宿主，SDK 必须优先复用底层标识，不额外生成新的 question 主键。
- 对 OpenCode 类宿主，`questionId` 直接映射到底层 `requestID`。

## Run 与事件流

### `ProviderRun`

```ts
export interface ProviderRun {
  runId: string;
  events: AsyncIterable<ProviderEvent>;
  result(): Promise<ProviderTerminalResult>;
}
```

### 说明

- `events` 用于输出当前 run 的异步事件流
- `result()` 用于返回本次执行的最终结果
- `runId` 必须与输入中的 `runId` 一致
- 同一 `runId` 下允许产出多条 assistant message
- question / permission 等待用户输入期间，`events` 必须保持打开，`result()` 不得提前 resolve

## 事件模型

v1 采用 miniapp 风格的业务事件名，并保留 `run.terminal` 作为 SDK 生命周期控制事件。

```ts
export type ProviderEvent =
  | TextDeltaEvent
  | TextDoneEvent
  | ThinkingDeltaEvent
  | ThinkingDoneEvent
  | ToolUpdateEvent
  | QuestionEvent
  | PermissionAskEvent
  | PermissionReplyEvent
  | StepStartEvent
  | StepDoneEvent
  | SessionStatusEvent
  | SessionErrorEvent
  | RunTerminalEvent;

export interface TextDeltaEvent {
  type: 'text.delta';
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

export interface TextDoneEvent {
  type: 'text.done';
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

export interface ThinkingDeltaEvent {
  type: 'thinking.delta';
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

export interface ThinkingDoneEvent {
  type: 'thinking.done';
  toolSessionId: string;
  messageId: string;
  partId: string;
  content: string;
  raw?: unknown;
}

export interface ToolUpdateEvent {
  type: 'tool.update';
  toolSessionId: string;
  messageId: string;
  partId: string;
  toolCallId: string;
  toolName: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  title?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  raw?: unknown;
}

export interface QuestionEvent {
  type: 'question';
  toolSessionId: string;
  messageId: string;
  questionId: string;
  toolCallId?: string;
  header?: string;
  question: string;
  options?: string[];
  context?: Record<string, unknown>;
  raw?: unknown;
}

export interface PermissionAskEvent {
  type: 'permission.ask';
  toolSessionId: string;
  messageId: string;
  permissionId: string;
  toolCallId?: string;
  permissionType?: string;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

export interface PermissionReplyEvent {
  type: 'permission.reply';
  toolSessionId: string;
  messageId: string;
  permissionId: string;
  response: 'once' | 'always' | 'reject';
  raw?: unknown;
}

export interface StepStartEvent {
  type: 'step.start';
  toolSessionId: string;
  messageId: string;
  raw?: unknown;
}

export interface StepDoneEvent {
  type: 'step.done';
  toolSessionId: string;
  messageId: string;
  tokens?: unknown;
  cost?: number;
  reason?: string;
  raw?: unknown;
}

export interface SessionStatusEvent {
  type: 'session.status';
  toolSessionId: string;
  status: 'busy' | 'idle';
  raw?: unknown;
}

export interface SessionErrorEvent {
  type: 'session.error';
  toolSessionId: string;
  error: ProviderError;
  raw?: unknown;
}

export interface RunTerminalEvent {
  type: 'run.terminal';
  toolSessionId: string;
  runId: string;
  outcome: 'completed' | 'failed' | 'aborted';
  error?: ProviderError;
  raw?: unknown;
}

export interface ProviderTerminalResult {
  outcome: 'completed' | 'failed' | 'aborted';
  usage?: unknown;
  error?: ProviderError;
}

export interface ProviderError {
  code:
    | 'not_found'
    | 'invalid_input'
    | 'not_supported'
    | 'timeout'
    | 'rate_limited'
    | 'provider_unavailable'
    | 'internal_error';
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}
```

一致性约束：

- `outcome: 'completed'` 时，`error` 必须为空。
- `outcome: 'aborted'` 时，`error` 默认应为空；如需补充上下文，应放入 `details`，而不是再使用独立的 `aborted` 错误码。
- `ProviderError` 是 provider-originated error，只用于表达执行期错误和终态失败原因。
- `ProviderError` 不用于表达 command apply failure。

### 事件语义

#### `text.delta` / `text.done`

- 用于 assistant 文本输出
- `content` 表示文本内容
- `text.delta` 表示某个 `partId` 的增量片段
- `text.done` 表示该 `partId` 的最终完整内容与 part 收口
- `text.done` 只结束该 part，不结束 message，更不结束 run

#### `thinking.delta` / `thinking.done`

- 用于推理类文本输出
- 字段与 `text.*` 对齐
- `thinking.done` 只结束该推理 part，不结束 message，更不结束 run

#### `tool.update`

- 表示工具调用状态变化
- `partId` 是该工具展示节点的稳定标识
- `toolCallId` 是该工具调用的稳定标识
- 单个 `toolCallId` 只能归属一个 `messageId`
- 不允许跨两个 assistant message 复用同一个 `toolCallId`

#### `question`

- 表示 provider 需要用户回答一个问题
- 必须携带稳定 `questionId`
- Runtime 收到后必须建立：
  `questionId -> { runId, toolSessionId, providerSessionId, traceId }`

#### `permission.ask`

- 表示 provider 请求用户确认权限操作
- 必须携带稳定 `permissionId`
- Runtime 收到后必须建立：
  `permissionId -> { runId, toolSessionId, providerSessionId, traceId }`

#### `permission.reply`

- 仅表示底层权限回复已经成功落地
- 不表示“用户刚刚提交”这个动作本身
- 同一个 `permissionId` 最多发一次 `permission.reply`

#### `step.start` / `step.done`

- 它们是 **message 级元事件**，不是内容 part
- 不创建新的文本、推理或工具 part
- 单个 `messageId` 在一次 message 生命周期内至多出现一对 `step.start` / `step.done`
- `step.done` 表示该 message 的本轮生成收口，可附带 `tokens`、`cost`、`reason`
- `step.done` 不是 run 终态，不能替代 `run.terminal`

#### `session.status`

- v1 仅保留 `busy | idle`
- 这是 SDK 对外规范化结果，不要求底层宿主原始事件天然提供同样状态语义
- question / permission 等待用户输入期间必须保持 `busy`

#### `session.error`

- 表示会话级错误通知
- 可用于可恢复或不可恢复错误
- 不能替代 `run.terminal`
- 不用于表达 `health()`、`createSession()`、`runMessage()`、`reply*()`、`closeSession()`、`abortSession()` 的 command apply failure

#### `run.terminal`

- 表示单次 run 的最终控制事件
- 必须且只能出现一次
- `result()` 必须与 `run.terminal` 一致

## 支持的下行能力

v1 对集成方要求支持的能力如下：

| 能力 | Provider 方法 |
|---|---|
| 健康检查 | `health()` |
| 创建会话 | `createSession()` |
| 执行消息 | `runMessage()` |
| 回复问题 | `replyQuestion()` |
| 回复权限 | `replyPermission()` |
| 关闭会话 | `closeSession()` |
| 中断会话 | `abortSession()` |

## 行为约束

集成方必须遵守以下规则：

1. 单个 `runId` 只能结束一次。
2. `run.terminal` 发出后，事件流必须结束。
3. `result()` 必须与 `run.terminal` 保持一致。
4. 如果不支持同一会话并发运行，应通过 command 响应链路返回 `ProviderCommandError`，而不是把该失败编码进 `ProviderError`。
5. `closeSession()` / `abortSession()` 只表示请求已接受，不表示宿主已同步完成关闭或中断。
6. 未列入本文的事件类型不属于 v1 契约。
7. 外部契约中的事件名以本文定义为准，不要求与某个具体宿主的原始事件名一致。

### message 与 part 生命周期约束

1. `messageId` 由 Provider 生成。
2. `partId` 由 Provider 在对应 `messageId` 下生成并保持稳定。
3. 同一 `runId` 下允许出现多条 assistant message。
4. 每条业务内容或工具事件都必须归属到明确的 `messageId`。
5. 同一 `messageId` 下的 `partId` 不得复用到其他 message。
6. 一个新的 assistant message 只能在前一条 assistant message 已发出 `step.done` 之后开启。
7. `step.done` 之前，后续 `text.*`、`thinking.*`、`tool.update`、`question`、`permission.ask` 仍归属当前 `messageId`。
8. `question` / `permission.ask` 之后恢复执行，默认开启新的 assistant `messageId`。
9. 不继续向已进入 `step.done` 的旧 message 追加新的内容 part。
10. 若底层宿主原生会回到旧 message，Provider 仍需对外规范化为新的 assistant message。

### question / permission 闭环约束

1. Runtime 是 `replyQuestion()` / `replyPermission()` 的唯一调用方。
2. Provider 是宿主交互回复的唯一处理方。
3. question 成功回复并被 Provider 接受后，Runtime 必须清理对应 `questionId` 的挂起索引。
4. 收到 `permission.reply` 后，Runtime 必须清理对应 `permissionId` 的挂起索引。
5. 收到 `run.terminal`、run 被 abort、或 Runtime 判定 run 已不可继续时，必须清理该 run 的所有挂起交互索引。
6. 如果 `replyQuestion()` / `replyPermission()` 在 apply 阶段失败，应通过 command 响应链路返回 `ProviderCommandError`，而不是先发 `session.error`。
7. 如果回复已被 Provider 接受，但后续恢复执行失败，才应发 `session.error`；若最终终止，再发 `run.terminal(failed)`。

### 同一 run 内挂起与恢复约束

1. 发出 `question` 或 `permission.ask` 后，如果 run 进入等待用户输入：
   - `ProviderRun.events` 必须保持打开
   - `result()` 不得 resolve
   - 不得发出 `run.terminal`
   - `session.status` 必须保持 `busy`
2. 收到 `replyQuestion()` / `replyPermission()` 后：
   - Provider 必须在同一 `runId` 下继续产出事件
   - 默认开启新的 assistant `messageId`
   - 不允许隐式开启第二条 run
   - 不允许开启第二条独立事件流
3. 只有当该 run 真正完成、失败或中断时，才能：
   - 发出唯一一次 `run.terminal`
   - 结束 `events`
   - 让 `result()` 返回一致终态
   - 将 `session.status` 切到 `idle`

### abort 竞争约束

1. 如果 run 正在等待 `question` / `permission` 回复时收到 `abortSession()`：
   - Provider 应尽力中断底层执行
   - 最终必须发出 `run.terminal(aborted)`
   - 结束 `events`
   - `result()` 返回 `aborted`
2. 一旦 run 已进入 aborted 终态：
   - 后续 `replyQuestion()` / `replyPermission()` 必须被拒绝
   - 应通过 command 响应链路返回 `ProviderCommandError`
3. 如果 Provider 已接受 reply 并恢复执行，随后又收到 abort：
   - 仍允许 abort 生效
   - 最终终态以 `aborted` 为准
4. 一个已结束的 run 不能被任何 reply 重新激活。

## `runMessage()` 应如何理解

`runMessage()` 不是“直接返回最终答案”，而是“启动一次 run 并返回 `ProviderRun`”。

- `ProviderRun.events` 是这次执行的异步事件流
- `ProviderRun.result()` 是这次执行的最终收敛结果
- 一个 run 中可以有多条 assistant message
- 每条 assistant message 都有自己的 `messageId`
- `step.done(reason: 'tool-calls')` 表示该 message 这一轮生成先收口，后续仍可在同一 run 中继续执行

## `runMessage()` 最小实现示例

下面示例展示一个 provider 如何：

- 在同一 run 中先输出第一条 assistant message
- 触发 `permission.ask`
- 在等待用户输入时保持事件流打开
- 收到 `replyPermission()` 后继续输出第二条 assistant message
- 最终发出 `run.terminal`

```ts
type ProviderPush = (event: ProviderEvent) => void;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function createEventStream() {
  const queue: ProviderEvent[] = [];
  let done = false;
  let notify: (() => void) | undefined;

  return {
    push(event: ProviderEvent) {
      queue.push(event);
      notify?.();
      notify = undefined;
    },
    finish() {
      done = true;
      notify?.();
      notify = undefined;
    },
    async *iterate(): AsyncIterable<ProviderEvent> {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          continue;
        }

        yield queue.shift()!;
      }
    },
  };
}

export function startMyProviderRun(
  input: ProviderRunMessageInput,
): ProviderRun {
  const resultDeferred = createDeferred<ProviderTerminalResult>();
  const stream = createEventStream();

  const state = {
    currentMessageIndex: 0,
    active: true,
    aborted: false,
    awaitingPermission: false,
  };

  const nextMessageId = () =>
    `msg_${input.runId}_${++state.currentMessageIndex}`;

  const failRun = (error: ProviderError) => {
    stream.push({
      type: 'session.error',
      toolSessionId: input.toolSessionId,
      error,
    });
    stream.push({
      type: 'run.terminal',
      toolSessionId: input.toolSessionId,
      runId: input.runId,
      outcome: 'failed',
      error,
    });
    stream.push({
      type: 'session.status',
      toolSessionId: input.toolSessionId,
      status: 'idle',
    });
    state.active = false;
    stream.finish();
    resultDeferred.resolve({ outcome: 'failed', error });
  };

  const abortRun = () => {
    stream.push({
      type: 'run.terminal',
      toolSessionId: input.toolSessionId,
      runId: input.runId,
      outcome: 'aborted',
    });
    stream.push({
      type: 'session.status',
      toolSessionId: input.toolSessionId,
      status: 'idle',
    });
    state.active = false;
    state.aborted = true;
    stream.finish();
    resultDeferred.resolve({ outcome: 'aborted' });
  };

  void (async () => {
    try {
      const firstMessageId = nextMessageId();
      const thinkingPartId = `${firstMessageId}_thinking_1`;
      const textPartId = `${firstMessageId}_text_1`;
      const toolPartId = `${firstMessageId}_tool_1`;
      const toolCallId = `${firstMessageId}_call_1`;
      const permissionId = `${firstMessageId}_permission_1`;

      stream.push({
        type: 'session.status',
        toolSessionId: input.toolSessionId,
        status: 'busy',
      });
      stream.push({
        type: 'step.start',
        toolSessionId: input.toolSessionId,
        messageId: firstMessageId,
      });
      stream.push({
        type: 'thinking.delta',
        toolSessionId: input.toolSessionId,
        messageId: firstMessageId,
        partId: thinkingPartId,
        content: '正在准备写入文件...',
      });
      stream.push({
        type: 'thinking.done',
        toolSessionId: input.toolSessionId,
        messageId: firstMessageId,
        partId: thinkingPartId,
        content: '正在准备写入文件...',
      });
      stream.push({
        type: 'text.delta',
        toolSessionId: input.toolSessionId,
        messageId: firstMessageId,
        partId: textPartId,
        content: '我将先申请写入权限。',
      });
      stream.push({
        type: 'text.done',
        toolSessionId: input.toolSessionId,
        messageId: firstMessageId,
        partId: textPartId,
        content: '我将先申请写入权限。',
      });
      stream.push({
        type: 'tool.update',
        toolSessionId: input.toolSessionId,
        messageId: firstMessageId,
        partId: toolPartId,
        toolCallId,
        toolName: 'write',
        status: 'pending',
      });
      stream.push({
        type: 'permission.ask',
        toolSessionId: input.toolSessionId,
        messageId: firstMessageId,
        permissionId,
        toolCallId,
        permissionType: 'edit',
        metadata: { filePath: '/tmp/demo.txt' },
      });
      stream.push({
        type: 'step.done',
        toolSessionId: input.toolSessionId,
        messageId: firstMessageId,
        reason: 'tool-calls',
      });

      state.awaitingPermission = true;
    } catch (cause) {
      failRun({
        code: 'internal_error',
        message: 'run bootstrap failed',
        details: { cause },
      });
    }
  })();

  return {
    runId: input.runId,
    events: stream.iterate(),
    result: () => resultDeferred.promise,
  };
}
```

上面的 `runMessage()` 只负责启动 run。真正的恢复执行在 `replyPermission()` / `replyQuestion()` 内完成。示例：

```ts
async function replyPermission(
  input: ProviderPermissionReplyInput,
  push: ProviderPush,
  complete: (result: ProviderTerminalResult) => void,
  failRun: (error: ProviderError) => void,
) {
  try {
    await myAgent.replyPermission({
      sessionId: input.providerSessionId,
      permissionId: input.permissionId,
      response: input.response,
    });

    const secondMessageId = `msg_${input.runId}_2`;
    const toolPartId = `${secondMessageId}_tool_1`;
    const textPartId = `${secondMessageId}_text_1`;

    push({
      type: 'permission.reply',
      toolSessionId: input.toolSessionId,
      messageId: secondMessageId,
      permissionId: input.permissionId,
      response: input.response,
    });
    push({
      type: 'step.start',
      toolSessionId: input.toolSessionId,
      messageId: secondMessageId,
    });
    push({
      type: 'tool.update',
      toolSessionId: input.toolSessionId,
      messageId: secondMessageId,
      partId: toolPartId,
      toolCallId: `${secondMessageId}_call_1`,
      toolName: 'write',
      status: 'completed',
      output: 'Wrote file successfully.',
    });
    push({
      type: 'text.delta',
      toolSessionId: input.toolSessionId,
      messageId: secondMessageId,
      partId: textPartId,
      content: '已完成写入。',
    });
    push({
      type: 'text.done',
      toolSessionId: input.toolSessionId,
      messageId: secondMessageId,
      partId: textPartId,
      content: '已完成写入。',
    });
    push({
      type: 'step.done',
      toolSessionId: input.toolSessionId,
      messageId: secondMessageId,
      reason: 'stop',
    });
    push({
      type: 'run.terminal',
      toolSessionId: input.toolSessionId,
      runId: input.runId,
      outcome: 'completed',
    });
    push({
      type: 'session.status',
      toolSessionId: input.toolSessionId,
      status: 'idle',
    });

    complete({ outcome: 'completed' });
  } catch (cause) {
    failRun({
      code: 'internal_error',
      message: 'permission reply failed',
      details: { cause },
    });
  }
}
```

### 示例要点

- 第一条 message 用于准备文本、工具挂起和 `permission.ask`
- 第一条 message 以 `step.done(reason: 'tool-calls')` 收口，而不是 run 结束
- `replyPermission()` 后在同一 `runId` 下继续输出第二条 assistant message
- 第二条 message 结束后才发 `run.terminal(completed)`
- 若恢复执行失败，应先发 `session.error`，再发 `run.terminal(failed)`
- 若收到 abort，应最终收敛到 `run.terminal(aborted)` 并结束事件流

## OpenCode 原始事件到 SDK v1 事件的映射建议

本节不是新增协议约束，而是帮助接入 OpenCode 类宿主时，将原始事件规范化为 SDK v1 对外事件。

### 一对一或一对多映射

| OpenCode 原始事件 | 关键字段 | SDK v1 建议事件 | 映射说明 |
|---|---|---|---|
| `message.part.updated` with `part.type = "step-start"` | `part.messageID` | `step.start` | 直接映射为 message 级元事件，`messageId = part.messageID` |
| `message.part.updated` with `part.type = "reasoning"` 且 `text = ""` | `part.id`, `part.messageID` | 可忽略或等待后续 delta | 空 reasoning 初始化通常不需要立刻对外发事件 |
| `message.part.delta` with reasoning part | `messageID`, `partID`, `delta` | `thinking.delta` | `content = delta` |
| `message.part.updated` with `part.type = "reasoning"` and final `text` | `part.id`, `part.messageID`, `part.text` | `thinking.done` | `content = part.text`，表示该 reasoning part 收口 |
| `message.part.updated` with `part.type = "text"` 且 `text = ""` | `part.id`, `part.messageID` | 可忽略或等待后续 delta | 空 text 初始化通常不需要立刻对外发事件 |
| `message.part.delta` with text part | `messageID`, `partID`, `delta` | `text.delta` | `content = delta` |
| `message.part.updated` with `part.type = "text"` and final `text` | `part.id`, `part.messageID`, `part.text` | `text.done` | `content = part.text`，表示该 text part 收口 |
| `message.part.updated` with `part.type = "tool"` and `state.status = "pending"` | `part.id`, `part.messageID`, `part.tool`, `part.callID` | `tool.update` | `status = pending` |
| `message.part.updated` with `part.type = "tool"` and `state.status = "running"` | 同上 | `tool.update` | `status = running` |
| `message.part.updated` with `part.type = "tool"` and `state.status = "completed"` | 同上，加 `state.output` | `tool.update` | `status = completed`，`output = state.output` |
| `message.part.updated` with `part.type = "tool"` and `state.status = "error"` | 同上，加错误字段 | `tool.update` | `status = error`，`error = ...` |
| `permission.asked` | `properties.id`, `properties.sessionID`, `tool.messageID`, `tool.callID` | `permission.ask` | `permissionId = properties.id`，`messageId = tool.messageID`，`toolCallId = tool.callID` |
| `permission.replied` | `requestID`, `reply`, `sessionID` | `permission.reply` | `permissionId = requestID`，`response = reply` |
| `question.asked` | `questions[0].requestID`, `tool.callID`, `question` | `question` | `questionId = requestID`，直接复用底层请求标识 |
| `message.part.updated` with `part.type = "step-finish"` | `part.messageID`, `tokens`, `cost`, `reason` | `step.done` | `messageId = part.messageID`，`tokens`、`cost`、`reason` 映射到 `step.done` |
| `session.status` | `status.type` | `session.status` | 仅保留 `busy \| idle`；其他原始状态需先规范化 |
| `session.error` | `error` | `session.error` | 转成 `ProviderError` 结构 |
| `message.updated` with `info.finish = "tool-calls"` | `info.id`, `finish` | 通常不单独映射 | 作为 `step.done.reason = "tool-calls"` 的旁证，不必单独成为 SDK 事件 |
| `message.updated` with `info.finish = "stop"` | `info.id`, `finish` | 通常不单独映射 | 作为 `step.done.reason = "stop"` 的旁证，不必单独成为 SDK 事件 |
| `session.updated` | `info` | 通常不映射 | 当前 SDK v1 不暴露此类会话元数据更新 |
| `file.edited` / `file.watcher.updated` / `server.heartbeat` / `session.diff` | 各自属性 | 不映射 | 不属于当前 SDK v1 对外事件模型 |

### 基于实际日志的推荐收敛方式

对于常见的“先触发工具或权限、再继续生成最终回复”的 OpenCode 日志，建议对外规范化为两段 assistant message：

#### 第一条 assistant message

1. `step.start`
2. `thinking.delta`
3. `thinking.done`
4. `text.delta`
5. `text.done`
6. `tool.update(status = pending)`
7. `permission.ask`
8. `tool.update(status = running)`
9. 等待用户回复，`events` 保持打开，`session.status = busy`
10. `permission.reply`
11. `tool.update(status = completed)`
12. `step.done(reason = 'tool-calls')`

#### 第二条 assistant message

1. `step.start`
2. `thinking.delta`
3. `thinking.done`
4. `text.delta`
5. `text.done`
6. `step.done(reason = 'stop')`
7. `run.terminal(completed)`
8. `session.status(idle)`

### 映射时的规范化建议

- `message.updated` 不建议直接暴露成 SDK v1 事件，应主要作为内部归因信息使用。
- `step-finish` 不能直接当作 run 结束，因为同一 run 中后面仍可能继续出现新的 assistant message。
- `permission.asked` / `permission.replied` 应优先使用它们自己的请求主键，不应退化成只靠 `toolCallId` 追踪。
- `question.asked` 同样应直接复用底层 `requestID` 作为 `questionId`。
- `session.status` 需要 SDK 侧规范化，不能机械直通宿主原始状态流。

### 简版映射规则

```ts
message.part.delta(reasoning) -> thinking.delta
message.part.updated(reasoning final) -> thinking.done

message.part.delta(text) -> text.delta
message.part.updated(text final) -> text.done

message.part.updated(tool state) -> tool.update
permission.asked -> permission.ask
permission.replied -> permission.reply
question.asked -> question

message.part.updated(step-start) -> step.start
message.part.updated(step-finish) -> step.done

session.status -> session.status
session.error -> session.error

run terminal:
  not from a single OpenCode raw event
  but from provider/runtime convergence
```

## 版本说明

本文档为 **v1 外部集成契约**。

v1 的目标是：

- 提供最小可接入能力
- 降低集成复杂度
- 建立稳定的 Provider 实现模式
- 为 question / permission 闭环定义统一行为

后续版本可能：

- 增加新的事件类型
- 增加新的字段
- 扩展更多 action 能力

如后续版本发生变化，将优先采用向后兼容方式扩展。  
但本文档相对旧版 `1.0-draft` 的修订本身不承诺向后兼容。

## FAQ

### 1. 我需要自己和 gateway 建立连接吗？

不需要。  
连接由 Runtime SDK 负责，你只需要创建 runtime 并注册 provider。

### 2. 我需要自己构造 gateway 上下行协议吗？

不需要。  
你只需要实现 Provider 接口，并输出本文定义的事件。

### 3. `toolSessionId` 和 `providerSessionId` 有什么区别？

- `toolSessionId` 是 bridge 分配给当前会话的外部标识
- `providerSessionId` 是你的 agent 系统内部会话标识

两者不要求相同。

### 4. 为什么业务事件名不直接使用 OpenCode 原始事件名？

因为本文档面向外部集成方，目标是提供稳定的 bridge 公共契约。  
如果直接使用某个宿主的原始事件名，会提高后续演进成本。

因此 v1 采用 miniapp 风格的外部业务事件名，并将 `run.terminal` 保留为 SDK 生命周期事件。

### 5. 为什么仍然保留 `run.terminal`？

因为业务事件中的 `text.done`、`thinking.done`、`step.done` 都不等于 run 终态：

- `text.done` / `thinking.done` 结束的是 part
- `step.done` 结束的是某条 message 的本轮生成
- `run.terminal` 才表示整个 run 的最终完成、失败或中断

### 6. 为什么 v1 允许单 run 多条 assistant message？

因为宿主原生行为可能在一次 run 中先产出一条 `tool-calls` 类 message，等待 question / permission 或工具结果后，再继续产出后续 assistant message。  
SDK 协议层保持这种能力，不强行压平成一条 message。

### 7. `step.start` / `step.done` 和宿主原始 `message.finish` 有什么区别？

- `step.start` / `step.done` 是 SDK 的 message 级元事件
- 它们表达的是该 message 一轮生成的开始与收口
- 它们不替代宿主原始 `message.finish`
- 它们也不替代 `run.terminal`

### 8. `closeSession()` 返回 accepted 是否表示一定关闭成功？

不表示。  
它只表示关闭请求已经被接受处理，不代表宿主已经同步完成关闭。

### 9. `runMessage()` 应该如何理解？

把它理解成“启动一次 run 并返回事件流句柄”，而不是“同步返回最终答案”。

- `events` 负责流式输出
- `result()` 负责最终收敛
- question / permission 回复会在同一 run 内继续执行
- 同一 run 下可以有多条 assistant message
