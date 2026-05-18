# `message-bridge-openclaw` 流式修复修改说明

## Summary

本次会话围绕 `message-bridge-openclaw` 的 `chat` 主路径流式输出异常展开，目标是让插件优先透传 OpenClaw 宿主产生的真实增量文本，而不是在结束时一次性输出完整结果。

最终保留的实现结论是：

- `chat` 主路径已经从旧的内联分发切到 `dispatchReplyFromConfig + 自定义 dispatcher`
- 插件不再保留 synthetic final replay 这类“假流式”方案
- 真流式来源目前同时覆盖两条宿主链路：
  - `dispatcher.sendBlockReply(...)`
  - `runtime.events.onAgentEvent(stream="assistant")`
- 最终文本仍然通过现有 gateway 协议事件上送，不改外部协议形状

本说明只记录当前代码里真正保留下来的改动，以及中途尝试但最终已移除的路径。

## Key Changes

### 1. `chat` 主路径改为 runtime reply 分发

在 [OpenClawGatewayBridge.ts](../../src/OpenClawGatewayBridge.ts) 中，`handleChat()` 的 runtime reply 路径已经改成：

- 构造 route、envelope、inbound context
- 创建 message-bridge 专用 reply dispatcher
- 调用 `runtime.channel.reply.dispatchReplyFromConfig(...)`
- 在返回后统一等待 dispatcher idle，再做 final 收尾

保留了这些既有行为：

- session ensure
- busy 事件
- model selected 记录
- timeout 与首块前 retry 语义
- subagent fallback 兼容路径

### 2. 新增并对齐宿主 contract 的 reply dispatcher

在 [MessageBridgeReplyDispatcher.ts](../../src/runtime/MessageBridgeReplyDispatcher.ts) 中新增了内部 dispatcher，最终保留的宿主对齐接口包括：

- `sendToolResult`
- `sendBlockReply`
- `sendFinalReply`
- `waitForIdle`
- `getQueuedCounts`
- `markComplete`

修复了早期接口不匹配导致的运行时报错问题，包括：

- `sendFinalReply is not a function`
- `getQueuedCounts is not a function`

### 3. 去掉了 synthetic stream 回放

中途曾实现过：

- final-only 文本拆块回放
- 带节奏 synthetic replay

但这些方案最终已移除，不属于当前保留行为。当前代码明确回到：

- 宿主有真 block 才发 `message.part.delta`
- 宿主没有真 block 时，只发最终 text update
- 不再伪造流式 delta

这部分移除主要发生在 [OpenClawGatewayBridge.ts](../../src/OpenClawGatewayBridge.ts) 中原先的 synthetic chunk / replay 逻辑。

### 4. 修复了真 block 被提前丢弃的问题

`MessageBridgeReplyDispatcher` 早期版本在 `dispatchReplyFromConfig()` 返回后太早进入 complete 状态，导致“稍后异步到达的真 block”可能被拒收。

最终修复是：

- `markComplete()` 只标记完成意图
- 真正封口延后到 `waitForIdle()` 确认没有新的异步 block 进入之后
- 避免了“宿主过程里已经产出 block，但 bridge 只在最后发 final”的时序问题

### 5. 补上了被忽略的 `assistant` 实时事件流

这是本次会话里最关键的最终修复之一。

之前 `handleRuntimeAgentEvent()` 只处理：

- `reasoning`
- `tool`

但 OpenClaw 宿主实际还会发：

- `stream: "assistant"`

这些事件里包含实时文本 `text/delta`。旧实现把这条流完全忽略，导致：

- 宿主过程里有真 delta
- bridge 没有把它转成 `message.part.delta`
- 前端只能等 final

最终新增了 `emitAssistantRuntimeDelta(...)`，处理逻辑是：

- 优先消费 `data.delta`
- 如果只有 `data.text`，则基于 `accumulatedText` 推导 suffix delta
- 对已累积文本做去重，避免和 reply block 双发
- 将实时 assistant 更新映射为现有 assistant text stream state

## Problems Solved

本次会话最终解决或明确收敛了这些问题：

- 修复了 runtime reply dispatcher 接口不匹配导致的宿主运行时异常
- 修复了每个 `text.delta` 后面错误跟一个 `text.done` 的问题
- 修复了 `markComplete()` 过早导致晚到真 block 丢失的问题
- 修复了只处理 reply block、不处理 `assistant` agent event，导致真实流式文本未被转发的问题
- 明确移除了 synthetic replay，避免“假流式”掩盖真实问题
- 保持了 gateway 协议外形不变，未新增 message type

## Reasonableness

当前保留实现整体是合理的，理由如下：

- 对外协议未变，兼容现有 ai-gateway 消费方
- 优先消费宿主真实流式来源，而不是伪造 delta
- 同时兼容 OpenClaw 的两条真实文本流来源，鲁棒性更高
- 收尾顺序仍然保证 `waitForIdle()` 之后才发最终完成态事件

需要明确的边界是：

- 如果宿主既不走 `sendBlockReply(...)`，也不发 `stream: "assistant"`，插件仍然只能在最后发 final
- 当前实现假设 assistant agent event 与 reply final 可能并存，因此依赖 `accumulatedText` 做去重；这在方向上合理，但仍需真实宿主日志继续验证不同模型/provider 组合

## Test Plan

当前代码已经补充并通过了与本次修复直接相关的单测，重点包括：

- `runtime reply final-only emits final text without synthetic delta and still marks status unhealthy`
- `runtime reply preserves late async block replies before final completion`
- `runtime assistant agent events project to assistant text delta before final reply`
- `runtime reply waits for dispatcher idle before emitting session.idle and tool_done`
- 既有 block stream / final reconciliation / fallback / tool / reasoning 场景未回归

当前验证结果基于：

- `pnpm --dir plugins/message-bridge-openclaw run test:unit`
- `pnpm --dir plugins/message-bridge-openclaw run build`

## Assumptions

- 当前说明基于工作区实际保留 diff，而不是中途每一次试错实现
- “整个会话”的总结中，仅将已保留或对最终结论有解释价值的尝试写入文档
- 若要继续扩展正式文档，可基于本文件同步更新 `USAGE.zh-CN.md` 或专题说明
