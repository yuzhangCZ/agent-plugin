# P0 专题：probe 与 runtime 连接竞争及 duplicate_connection 问题归档

**问题标识**: `MB-OPENCLAW-P0-PROBE-RACE`  
**状态**: draft  
**更新时间**: 2026-03-18

## 1. 问题现象

在 `openclaw --dev gateway run` 场景下，ai-gateway 曾出现 `duplicate_connection`。

已确认的现象包括：

- runtime 正式链路已经在线时，额外 probe 会再次尝试注册 websocket
- OpenClaw 侧此前通常看不到这条“第二个连接”的完整日志
- 注释 probe 相关入口后，`duplicate_connection` 现象消失

该问题并不等于 message-bridge 主链路不可用，更准确地说是探活策略、连接仲裁和日志可观测性同时缺失。

## 2. 根因结论

### 2.1 probe 之前是额外真实建连

此前 `probeAccount` 会创建独立的 `DefaultGatewayConnection`，而不是复用 live runtime 已建立的 websocket。

直接结果：

- runtime 已在线时，probe 额外注册会撞上 ai-gateway 的单连接约束
- ai-gateway 侧出现 `duplicate_connection`

### 2.2 runtime 与 probe 之前缺少账号级连接仲裁

此前没有明确的账号级“谁能建连”的仲裁状态，导致两类 race 都可能出现：

1. runtime 正在首连或重连时，probe 插入并发起真实建连
2. probe 已经开始真实建连时，runtime 启动并与 probe 竞争注册名额

### 2.3 probe 默认静默

此前 probe 默认使用静默 logger。

结果：

- ai-gateway 侧能看到 `duplicate_connection`
- OpenClaw 侧却可能完全看不到 probe 的额外连接日志

## 3. 修复原则

本次修复固定采用以下原则：

1. runtime 优先级高于 probe
2. 同一 `accountId` 任一时刻最多只允许一个真实 websocket 建连尝试
3. runtime `ready` 时，probe 必须短路，不得真实建连
4. runtime `connecting` 时，probe 必须等待或跳过，不得真实建连
5. probe 已真实建连时，如 runtime 启动，probe 必须取消让路
6. probe 必须具备日志，不再静默

本次修复不依赖 ai-gateway 放宽单连接策略，全部逻辑收敛在 `message-bridge-openclaw` 侧完成。

## 4. 修复后行为

### 4.1 进程内连接仲裁状态

插件进程内按 `accountId` 维护共享连接协调状态，至少包含：

- `runtimePhase`: `idle | connecting | ready | stopping`
- `probePhase`: `idle | connecting`
- `probeAbortController`
- `runtimeStartedAt`
- `probeStartedAt`

这是 probe / runtime 连接仲裁的主真相源。

### 4.2 runtime 状态机

runtime 状态机语义固定如下：

- `idle`: 没有运行中的正式 bridge
- `connecting`: 正在首连，或运行中断线后正在自动重连
- `ready`: 已收到 `register_ok`
- `stopping`: 正在停机

关键约束：

- 运行中的 websocket 异常断联后，如果 runtime 仍会自动重连，则业务态保持 `connecting`
- 不再把“断线待重连”错误暴露成 `idle`

### 4.3 probe 判定顺序

probe 的决策顺序固定为：

1. 优先读取进程内协调状态
2. 协调状态是 `ready`，直接返回 `ready`
3. 协调状态是 `connecting`，等待短窗口；未恢复则返回 `connecting`
4. 协调状态不命中时，再用 runtime snapshot 做健康兜底
5. 只有协调状态和 runtime snapshot 都不能证明 runtime 健康时，probe 才允许真实建连

runtime snapshot 的健康判定只看：

- `connected === true`
- `lastReadyAt` 有值
- `lastHeartbeatAt` 在阈值内，或 heartbeat 尚未开始但已 ready

这里不把 `runtimePhase` 当成硬门槛，以避免 probe 健康判断不必要地耦合到单个新增字段。

### 4.4 长时间断联重连时的 probe 结果

如果 websocket 长时间断联，runtime 一直在自动重连，则：

- `runtimePhase` 维持为 `connecting`
- probe 不发起真实 websocket
- probe 结果返回：

```json
{
  "ok": false,
  "state": "connecting",
  "reason": "runtime_connecting_probe_skipped"
}
```

这表示“正式 runtime 正在重连，因此 probe 被跳过”，不表示 probe 自身连接失败。

整体健康结论仍由以下信号补充判断：

- `connected`
- `lastHeartbeatAt`
- `lastInboundAt`
- `lastOutboundAt`
- `lastError`

因此，runtime 可在 probe 结果为 `connecting` 的同时，被 `doctor` 或状态汇总判定为“不健康且长期未恢复”。

### 4.5 probe 被 runtime 抢占

如果 probe 已经开始真实建连，而 runtime 此时启动：

- runtime 抢占优先级
- probe 被取消
- probe 返回：

```json
{
  "ok": false,
  "state": "cancelled",
  "reason": "probe_cancelled_for_runtime_start"
}
```

## 5. 日志与排障

修复后 probe 不再静默，新增日志事件：

- `probe.requested`
- `probe.short_circuit.runtime_ready`
- `probe.short_circuit.runtime_connecting`
- `probe.wait_runtime.started`
- `probe.wait_runtime.completed`
- `probe.connect.started`
- `probe.connect.ready`
- `probe.connect.rejected`
- `probe.connect.timeout`
- `probe.connect.error`
- `probe.connect.cancelled_for_runtime`

这些日志用于区分：

- probe 是直接短路
- probe 是等待 runtime
- probe 是否真的建连
- probe 是否被 runtime 抢占取消

## 6. 验证口径

修复后至少要满足：

1. runtime `ready` 时，probe 不再额外建 websocket
2. runtime `connecting` 时，probe 不再额外建 websocket
3. 运行中断线并自动重连时，runtime 业务态保持 `connecting`
4. probe 已建连、runtime 后启动时，probe 被取消
5. OpenClaw 侧可见 probe 路径日志
6. `channels status --probe` / `doctor` 不再把健康运行态误报为 `duplicate_connection`

当前实现与测试已覆盖：

- `runtime disconnect while still running keeps runtimePhase in connecting`
- `probeMessageBridgeAccount short-circuits from connection coordinator before connecting`
- `probeMessageBridgeAccount falls back to healthy runtime snapshot without runtimePhase`
