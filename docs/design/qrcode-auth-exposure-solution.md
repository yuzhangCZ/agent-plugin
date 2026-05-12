# 二维码授权能力暴露方案设计

**Version:** 1.0  
**Date:** 2026-05-11  
**Status:** Draft  
**Owner:** agent-plugin maintainers  
**Related:** [二维码扫码授权方案设计](./qrcode-auth-session-solution.md), [bridge-runtime-sdk 对外集成文档](./interfaces/bridge-runtime-sdk-integration.md), [bridge-runtime-sdk 目标态架构设计](../architecture/bridge-runtime-sdk-architecture.md), [私有 Runtime API 契约](../../plugins/message-bridge/docs/design/interfaces/private-status-api-contract.md)

## 1. 文档定位

本文定义二维码授权能力从 `@wecode/skill-qrcode-auth` 向两个上层边界暴露时的设计结论：

- OpenCode 插件宿主私有访问面
- `@agent-plugin/bridge-runtime-sdk` 根入口稳定导出面

本文只负责冻结能力暴露边界、公开接口语义与职责分界，不负责：

- 实施步骤与迁移顺序
- 逐文件改造方案
- 测试矩阵与验证命令
- 二维码 ASCII 渲染、终端展示实现
- 宿主配置写入与安装流程编排

## 2. 背景与范围升级

现有二维码授权能力已经在 `@wecode/skill-qrcode-auth` 内形成稳定 public facade：调用方通过 `qrcodeAuth.run()` 发起完整授权会话，并通过 `onSnapshot` 接收标准化事件。

此前该能力的正式承诺范围只覆盖统一安装 CLI 场景。`plugin` 与 `bridge-runtime-sdk` 当时被明确排除在当前需求承诺之外。这一边界适合首版能力收敛，但不足以支撑后续两个新增诉求：

1. OpenCode 宿主需要在同进程内直接访问二维码授权能力。
2. SDK 使用方希望从统一入口导入 runtime 能力与二维码授权能力，而不是分别依赖多个 workspace package。

因此，本方案将二维码授权能力的暴露范围正式升级为三层结构：

- `@wecode/skill-qrcode-auth`：二维码授权语义真源
- `message-bridge` 宿主私有 Runtime API 扩版：同进程访问载体
- `@agent-plugin/bridge-runtime-sdk`：宿主复用能力聚合入口

这里的“升级”是新增设计结论，不视为旧需求或旧方案的自然外推。

## 3. 设计结论

### 3.1 `skill-qrcode-auth` 继续作为能力真源

`@wecode/skill-qrcode-auth` 继续拥有二维码授权能力的语义定义权，包括：

- `QrCodeAuth` facade 形状
- `run(input)` 输入约束
- `environment` 默认值与固定环境枚举
- `QrCodeAuthSnapshot` 事件模型
- 会话终态、失败分类与默认策略

上层边界只能暴露该能力，不重新定义其领域语义。

围绕“包真源”和“集成方式”，本方案的直接结论如下：

- `message-bridge`：不是通过 npm/package 依赖集成 `skill-qrcode-auth`；宿主最终消费的是插件构建产物内部已装配好的 `qrcodeAuth` 能力。
- `bridge-runtime-sdk`：对使用方继续作为 `@agent-plugin/bridge-runtime-sdk` 根入口包级消费；SDK 内部可以通过 package 依赖集成 `@wecode/skill-qrcode-auth`，再稳定转导出相关 facade 与类型。

这里需要明确区分三层概念：

- `skill-qrcode-auth` 作为独立能力包，负责语义真源与 public facade。
- 上层边界如何集成该能力，属于各自的内部装配决策，不要求完全一致。
- 业务接入方如何消费能力，取决于上层边界对外暴露的正式入口，而不是仓库内实现细节。

### 3.2 OpenCode 宿主对象扩版为统一能力载体

当前 `message-bridge` 活跃宿主契约仍是 `globalThis.__MB_RUNTIME_API__` 对应的 `MessageBridgeRuntimeApi`。本轮不新增平行 capability 对象，也不将宿主对象 rename 为新的正式接口名。

本轮设计结论是：现有宿主对象在保持访问路径与命名不变的前提下扩版，继续作为 bridge 相关私有能力的统一载体，其中至少包含两类能力：

- runtime 生命周期与状态能力
- 独立的二维码授权能力

因此，宿主侧新增二维码授权能力是 `MessageBridgeRuntimeApi` 的能力面扩展，不表示二维码授权被并入 runtime 生命周期。

宿主侧相关真源分工明确如下：

- 宿主对象访问路径真源：[`globalThis.__MB_RUNTIME_API__`](../../plugins/message-bridge/docs/design/interfaces/private-status-api-contract.md)
- 宿主对象完整 shape 真源：[私有 Runtime API 契约](../../plugins/message-bridge/docs/design/interfaces/private-status-api-contract.md)
- 二维码授权领域语义真源：[二维码扫码授权方案设计](./qrcode-auth-session-solution.md)

`message-bridge` 对 `skill-qrcode-auth` 的集成方式明确如下：

- 不以运行时安装 `@wecode/skill-qrcode-auth` 包的方式集成二维码授权能力。
- `qrcodeAuth` 作为插件内部装配能力，在构建期被纳入插件产物，再挂载到 `globalThis.__MB_RUNTIME_API__`。
- 宿主只通过 `globalThis.__MB_RUNTIME_API__.qrcodeAuth` 访问该能力，不直接感知 `skill-qrcode-auth` 的源码路径或包依赖关系。
- 该集成方式不得破坏 `message-bridge` 发布产物零运行时依赖约束。

### 3.3 `bridge-runtime-sdk` 扩边为宿主复用能力聚合入口

`@agent-plugin/bridge-runtime-sdk` 当前以 runtime/provider/gateway 集成为主。本方案允许它在根入口稳定转导出二维码授权 facade，但该决定必须被视为一次显式扩边。

本次扩边的含义是：

- SDK 不再只承载 runtime/provider contract。
- SDK 只允许聚合与宿主接入直接相关、已具备稳定语义真源、且能够以 stable re-export 暴露的复用能力。
- 首个纳入聚合导出的非 runtime 能力为二维码授权 facade。

这不是 convenience export，也不是临时桥接；它是 SDK 对外定位的明确更新。

准入约束如下：

- 被聚合能力必须已经在仓库内拥有独立且稳定的语义真源。
- 被聚合能力必须具备跨宿主复用价值，而不是单次安装编排细节。
- SDK 根入口只能转导出既有 facade 与类型，不新增二次装配面或新的生命周期语义。
- 被聚合能力不得并入 `BridgeRuntimeOptions`、`ThirdPartyAgentProvider`、gateway host config 或 runtime 状态机。

二维码授权满足上述准入条件的原因如下：

- `@wecode/skill-qrcode-auth` 已提供稳定 facade 与相关类型。
- OpenCode 宿主与其他 SDK 使用方都存在直接复用需求。
- `bridge-runtime-sdk` 仅聚合导出该能力，不改写输入含义和事件模型。

`bridge-runtime-sdk` 对 `skill-qrcode-auth` 的集成方式明确如下：

- 对外消费方式：SDK 使用方继续通过 `@agent-plugin/bridge-runtime-sdk` 根入口进行稳定包级导入。
- 内部集成方式：SDK 可以通过 npm/package 依赖引入 `@wecode/skill-qrcode-auth`，并在根入口 stable re-export 相关 facade 与类型。
- 仓库内开发场景可以由 workspace 依赖承载这一 package 集成关系，但对外契约仍是 SDK 根入口包级消费。

以下能力仍不属于 `bridge-runtime-sdk` 根入口聚合范围：

- 安装编排能力
- 配置写入或落盘能力
- 终端渲染与 UI 展示能力
- 需要额外 host orchestration 的高层一键流程

## 4. 公开接口与调用语义

### 4.1 OpenCode 宿主私有 Runtime API 扩版

宿主对象仍沿用 `globalThis.__MB_RUNTIME_API__` 与 `MessageBridgeRuntimeApi` 这组活跃契约；本文不 supersede [私有 Runtime API 契约](../../plugins/message-bridge/docs/design/interfaces/private-status-api-contract.md) 对访问路径与对象命名的定义，只补充其扩版后的新增能力边界。

扩版后的宿主对象包含以下能力形状：

```ts
interface MessageBridgeRuntimeApi {
  getMessageBridgeStatus(): MessageBridgeStatusSnapshot;
  subscribeMessageBridgeStatus(
    listener: (snapshot: MessageBridgeStatusSnapshot) => void,
  ): () => void;
  startMessageBridgeRuntime(): Promise<void>;
  stopMessageBridgeRuntime(): void;
  qrcodeAuth: QrCodeAuth;
}
```

这里的接口代码块仅用于说明扩版后的能力形状；完整对象 shape 真源仍以上述私有 Runtime API 契约文档为准。

语义约束如下：

- `qrcodeAuth` 是独立 capability，不从属于 `startMessageBridgeRuntime()` / `stopMessageBridgeRuntime()` 生命周期。
- 宿主调用 `qrcodeAuth.run()` 时，不要求 runtime 已启动。
- `qrcodeAuth` 与 runtime/status 方法一样，都依赖插件模块已加载、宿主对象已完成注册。
- 插件未加载前，不保证 `globalThis.__MB_RUNTIME_API__` 存在，也不保证 `qrcodeAuth` 属性可读取；这属于宿主读取前置条件未满足，不属于 `qrcodeAuth.run()` 的业务失败模型。
- runtime 状态变化不会驱动二维码授权事件流。
- 二维码授权成功、失败、取消或过期，不直接改变 runtime 状态机。

推荐调用顺序如下：

1. 先完成 `MessageBridgePlugin(input)` 或模块 import。
2. 再读取 `globalThis.__MB_RUNTIME_API__`。
3. 再调用其中的 `qrcodeAuth` 或 runtime/status 方法。

选择 `qrcodeAuth: QrCodeAuth`，而不是扁平 `runQrCodeAuth()`，原因如下：

- 保持与能力真源一致，避免插件私有包装层重新定义接口。
- 为后续保留同一命名空间下扩展辅助只读能力的空间。
- 避免把非 runtime 语义继续堆入顶层扁平方法集合。

### 4.2 `bridge-runtime-sdk` 根入口导出面

`@agent-plugin/bridge-runtime-sdk` 根入口稳定导出二维码授权 facade 及其直接相关类型：

- `qrcodeAuth`
- `QrCodeAuth`
- `QrCodeAuthRunInput`
- `QrCodeAuthSnapshot`
- `QrCodeAuthEnvironment`
- `QrCodeAuthPolicy`
- `QrCodeDisplayData`
- `QrCodeAuthFailureReasonCode`
- `QrCodeAuthServiceError`

语义约束如下：

- 这些导出是对 `@wecode/skill-qrcode-auth` public contract 的稳定转导出。
- `bridge-runtime-sdk` 不重写 `run()` 输入含义，不额外定义新的会话状态机。
- `bridge-runtime-sdk` 不承诺宿主默认值注入；调用方仍需自行提供 `channel`、`mac` 和 `onSnapshot`。
- SDK 文档需要将该能力说明为“聚合导出能力”，而不是 runtime 内部子模块。

## 5. 职责边界与宿主责任

### 5.1 `@wecode/skill-qrcode-auth`

职责：

- 提供二维码授权完整会话能力
- 校验 `run(input)` 输入
- 管理默认策略、轮询、过期刷新与终态收口
- 通过 `QrCodeAuthSnapshot` 向调用方输出稳定事件

非职责：

- 宿主 runtime 生命周期管理
- 宿主配置写入
- 插件安装编排
- 终端展示策略

### 5.2 `message-bridge` 宿主私有 Runtime API 扩版

职责：

- 作为同进程宿主访问 bridge 私有能力的统一载体
- 暴露二维码授权 facade
- 保持宿主访问路径稳定

非职责：

- 重写二维码授权领域模型
- 将二维码授权并入 runtime 状态机
- 对 `qrcodeAuth.run()` 结果再做二次归一化

### 5.3 `bridge-runtime-sdk`

职责：

- 作为宿主复用能力的统一导入入口
- 聚合 runtime contract 与二维码授权 facade
- 对外提供稳定 package root import 体验

非职责：

- 接管二维码授权内部实现
- 扩展新的二维码授权生命周期概念
- 将二维码授权纳入 `BridgeRuntimeOptions`、`ThirdPartyAgentProvider` 或 gateway host config

### 5.4 宿主责任说明

本轮暴露的是低层 facade 与宿主接入扩版，不是宿主友好的一键授权流程。

分层责任如下：

- `@wecode/skill-qrcode-auth` 的 `qrcodeAuth.run(input)` 仍是低层 facade；其 public contract 不会替调用方省略 `channel`、`mac` 或 `onSnapshot`。
- `message-bridge` 通过构建期内嵌/内部装配将该能力挂载到宿主私有 Runtime API，不将其暴露为宿主需额外安装的包依赖。
- `@agent-plugin/bridge-runtime-sdk` 通过 package 依赖集成并稳定转导出该 facade 与相关类型，不新增默认值注入。
- 当前 OpenCode 宿主私有接入面可以通过 host adapter 预填宿主侧默认值。

宿主接入层仍需承担以下责任：

- 提供 `channel`
- 提供 `mac`
- 提供 `onSnapshot`
- 决定如何展示 `weUrl` / `pcUrl`
- 决定如何消费 `confirmed` 后的 `ak/sk`

当前 OpenCode 宿主接入策略沿用已冻结的二维码真源结论：

- `mac` 由宿主或 SDK 自动采集，失败传空字符串 `""`
- `channel` 在当前宿主接入方案固定为 `openx`

本轮仍不承诺以下宿主友好能力：

- 终端二维码渲染
- 配置落盘与安装后接入

若未来需要“宿主友好授权入口”，应单独设计 host adapter 或 orchestration facade，而不是在本轮直接改写 `QrCodeAuth` public contract。

## 6. 非目标

本文明确不包含以下内容：

- `BridgeRuntime` 生命周期改造
- `Provider SPI` 扩展
- 新的 `createQrCodeAuth()` 或 adapter factory
- 插件与 SDK 的依赖调整方案
- 逐文件实施步骤
- 测试、发布与迁移策略

## 7. 结论

本方案的核心结论是：二维码授权能力继续由 `@wecode/skill-qrcode-auth` 定义，其公开语义保持不变；`message-bridge` 通过插件构建产物内部装配的方式，将 `qrcodeAuth` 挂载到现有 `globalThis.__MB_RUNTIME_API__` / `MessageBridgeRuntimeApi`；`bridge-runtime-sdk` 则通过 package 依赖集成该能力，并在根入口承担“稳定聚合导出入口”的职责。

通过这一设计，仓库内二维码授权能力可以在不改写既有领域模型的前提下，正式进入插件宿主访问面与 SDK 公共导出面；同时，语义真源、内部集成方式、对外消费方式与宿主默认值策略之间的边界也保持清晰分层。
