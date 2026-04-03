# 私有状态原因收敛规格归档

**Version:** 1.0
**Date:** 2026-04-02
**Status:** Archived
**Owner:** message-bridge maintainers
**Related:** `../../product/prd.md`, `../../architecture/overview.md`, `./private-status-api-contract.md`

## 摘要

本文用于归档 `message-bridge` 私有状态 API 在连调阶段形成的状态原因收敛方案。

本文记录的是插件侧接口语义设计，不构成 `docs/product/prd.md` 冻结范围外的新需求结论；后续若要正式落地，仍需以实现评审和代码契约为准。

## In Scope

- 归档私有状态快照中 `unavailableReason` 的目标语义
- 归档运行时信号到状态原因的映射原则
- 归档日志与接口文档需要保持一致的命名口径

## Out of Scope

- 不修改 `status_query/status_response` 协议
- 不定义宿主级通用插件状态中心
- 不新增 `failureDomain` 等新字段
- 不改服务端业务逻辑
- 不承诺对所有握手失败都能 100% 精确识别为服务端拒绝

## External Dependencies

- WebSocket 握手与 close code 语义由服务端定义
- AK/SK 当前通过 WebSocket 子协议传递
- 服务端是否返回 `register_rejected` 或拒绝性 close code，决定插件侧可观测证据强弱

## 1. 背景

当前私有状态 API 的不可用原因偏底层实现态，不利于宿主和三方应用从业务角度判断问题归因。

本归档规格的目标是让调用方能直接区分以下几类情况：

- 未启动
- 已禁用
- 配置错误
- 插件内部故障
- 服务端问题
- 网络问题

更细的技术细节继续由 `lastError` 和运行时日志承担。

## 2. 对外状态模型

保留当前字段名 `unavailableReason`，不改为 `failureReason`，避免把“未就绪”和“已禁用”误表示为 failure。

```ts
type MessageBridgePhase = 'connecting' | 'ready' | 'unavailable';

type MessageBridgeUnavailableReason =
  | 'not_ready'
  | 'disabled'
  | 'config_invalid'
  | 'plugin_failure'
  | 'server_failure'
  | 'network_failure';

interface MessageBridgeStatusSnapshot {
  connected: boolean;
  phase: MessageBridgePhase;
  unavailableReason: MessageBridgeUnavailableReason | null;
  willReconnect: boolean | null;
  lastError: string | null;
  updatedAt: number;
  lastReadyAt: number | null;
}
```

## 3. 字段语义

### 3.1 `connected`

- 含义：是否已连接成功
- 规则：仅当 `phase='ready'` 时为 `true`

### 3.2 `phase`

- `connecting`
  - 首次连接或自动重连中
- `ready`
  - 已连接并完成注册
- `unavailable`
  - 当前不可用，需要结合 `unavailableReason` 判断原因

### 3.3 `unavailableReason`

- `not_ready`
  - 插件尚未初始化
- `disabled`
  - 插件被显式关闭
- `config_invalid`
  - 配置缺失、配置非法、环境变量错误
- `plugin_failure`
  - 插件内部启动失败、依赖能力异常、运行时内部故障
- `server_failure`
  - 服务端侧导致当前不可用
- `network_failure`
  - 网络或链路层异常

### 3.4 `willReconnect`

- `true`
  - 当前会自动重连
- `false`
  - 当前不会自动重连
- `null`
  - 当前状态不适用该语义

### 3.5 `lastError`

- 最近一次可读错误信息
- 用于排障，不作为主状态判断字段

## 4. 状态不变量

- `phase='ready'`
  - `connected=true`
  - `unavailableReason=null`
- `phase='connecting'`
  - `connected=false`
  - `unavailableReason=null`
  - `willReconnect=true`
- `phase='unavailable'`
  - `connected=false`
  - `unavailableReason!=null`
  - `willReconnect=false`

## 5. 映射规则

### 5.1 默认态

- runtime 未创建
  - `phase='unavailable'`
  - `unavailableReason='not_ready'`

### 5.2 配置态

- `enabled=false`
  - `unavailableReason='disabled'`
- 配置加载成功但校验失败
  - `unavailableReason='config_invalid'`

### 5.3 插件内部故障

以下场景映射为 `plugin_failure`：

- 启动前依赖能力缺失
- 插件内部初始化异常
- 运行时内部异常，且可确认不属于网络问题或服务端拒绝

### 5.4 服务端故障

以下场景映射为 `server_failure`：

- 收到 `register_rejected`
- 收到拒绝性 close code
- 有明确证据表明服务端拒绝当前连接或注册
- AK/SK 非空，且握手失败同时具备服务端拒绝性证据

### 5.5 网络故障

以下场景映射为 `network_failure`：

- 普通断连
- 非拒绝性 close
- 连接不可达
- 握手失败但没有明确服务端拒绝证据

## 6. AK/SK 特殊规则

### 6.1 本地配置问题

- AK/SK 缺失、为空、未配置
  - `config_invalid`

### 6.2 服务端认证问题

- AK/SK 非空，且存在明确服务端拒绝证据
  - `server_failure`

### 6.3 不确定链路失败

- AK/SK 非空，但只观察到通用连接失败，无法证明是服务端拒绝
  - `network_failure`

说明：

- 不将所有 AK/SK 失败无条件归入 `server_failure`
- 仅在存在拒绝性证据时归入 `server_failure`

## 7. 旧值到新值映射

- `uninitialized` -> `not_ready`
- `disabled` -> `disabled`
- `config_invalid` -> `config_invalid`
- `startup_failed` -> `plugin_failure`
- `register_rejected` -> `server_failure`
- `server_disconnected` -> `server_failure`
- `disconnected` -> `network_failure`

## 8. 架构约束

### 8.1 职责划分

- `MessageBridgeStatus.ts`
  - 定义状态模型、不变量、快照构造 helper
- `BridgeRuntimeStatusAdapter.ts`
  - 负责运行时信号到对外状态的映射
- `BridgeRuntime.ts`
  - 在具体异常点提供更准确的失败来源
- `MessageBridgeStatusStore.ts`
  - 负责存储、订阅、状态日志收口

### 8.2 依赖方向

- runtime 提供失败来源信号
- adapter 负责对外状态翻译
- store 不负责故障推断

## 9. 日志要求

保留并使用现有私有状态 API 日志：

- `status_api.query`
- `status_api.subscribe`
- `status_api.unsubscribe`
- `status_api.changed`

要求：

- 日志字段与新枚举语义一致
- `status_api.changed` 仅在状态语义发生变化时输出
- 与 `runtime.status_query.*` 协议日志严格区分

## 10. 验证范围

至少覆盖以下场景：

- 初始态 -> `not_ready`
- disabled -> `disabled`
- 配置校验失败 -> `config_invalid`
- 本地启动失败 -> `plugin_failure`
- `register_rejected` -> `server_failure`
- 拒绝性 close -> `server_failure`
- 普通断开 -> `network_failure`

## 11. 归档结论

本规格确定：

- 保留字段名 `unavailableReason`
- 收敛枚举为业务归因模型
- 服务端拒绝与网络失败按“是否存在明确拒绝证据”区分
- 细粒度技术原因不再作为对外契约的一部分，而由 `lastError` 和日志承担
