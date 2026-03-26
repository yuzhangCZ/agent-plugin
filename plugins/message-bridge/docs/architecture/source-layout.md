# message-bridge 源码目录说明

**Version:** 1.0  
**Date:** 2026-03-10  
**Status:** Active  
**Owner:** message-bridge maintainers  
**Related:** `./overview.md`

## 1. 目录分层

当前源码目录按架构层级划分：

```text
src/
  contracts/
  protocol/
    upstream/
    downstream/
  runtime/
  action/
  usecase/
  port/
  adapter/
  connection/
  config/
  error/
  event/
  types/
```

## 2. 各目录职责

### `contracts/`

边界契约层。

放置内容：

- `upstream-events.ts`
  - 支持的 OpenCode 上行事件类型
  - `DEFAULT_EVENT_ALLOWLIST`
- `downstream-messages.ts`
  - gateway 下行消息
  - `InvokeAction`
  - action payload/result 契约
- `transport-messages.ts`
  - bridge 发给 gateway 的 transport message
- `envelope.ts`
  - envelope 契约与 helper

判断标准：

- 如果一个类型代表“bridge 与外部如何交互”，放这里

### `protocol/`

协议边界层。

放置内容：

- raw 上下行消息解析
- schema 校验
- 规范化结果类型
- 统一失败日志

判断标准：

- 如果一段代码需要读取 raw `properties.*`、`payload.*`、`type/action`，放这里

### `runtime/`

编排层。

放置内容：

- 生命周期
- 连接启动/停止
- 调用 normalizer / extractor
- action 路由
- transport 发送

判断标准：

- 如果代码只负责“怎么串起来执行”，放这里

### `action/`

业务执行层。

放置内容：

- `ChatAction`
- `CreateSessionAction`
- `CloseSessionAction`
- `PermissionReplyAction`
- `StatusQueryAction`
- router / registry

判断标准：

- 如果代码负责 SDK 调用或业务动作执行，放这里

### `usecase/`

业务编排层。

放置内容：

- create session / chat 的业务决策
- 特殊 channel 的目录解析

判断标准：

- 如果代码只表达“要做什么”，并组合多个端口完成业务规则，放这里

### `port/`

抽象契约层。

放置内容：

- 目录映射查询接口
- 通道判断接口
- Session 网关接口

判断标准：

- 如果代码定义能力边界，不关心文件系统 / SDK 细节，放这里

### `adapter/`

基础设施适配层。

放置内容：

- env adapter
- JSON 映射文件 adapter
- SDK session adapter

判断标准：

- 如果代码直接接触环境变量、文件系统或 SDK，实现 Port 时，放这里

### `connection/`

基础设施连接层。

- `AkSkAuth`
- `GatewayConnection`
- `StateManager`

### `config/`

配置层。

- 默认配置
- 多源配置解析
- 配置校验

### `error/`

错误处理层。

- Fast fail
- 错误码映射
- `tool_error` 构造

### `types/`

内部通用类型层。

放置内容：

- `common.ts`
- `sdk.ts`
- `action-runtime.ts`
- 兼容 re-export

注意：

- 这里不再承载边界协议定义

## 3. 依赖方向

推荐依赖方向：

```text
contracts
  <- protocol
  <- runtime
  <- action

types
  <- protocol
  <- runtime
  <- action

protocol
  <- runtime

runtime
  -> action
  -> connection
  -> usecase
  -> adapter
```

禁止的依赖方向：

- `types -> protocol`
- `action -> raw downstream message`
- `runtime -> raw upstream/downstream fields`

## 4. 规范性结论

当前源码组织遵循这些约束：

1. 只有 `protocol/*` 允许直接读取 raw 协议字段
2. `runtime/*` 不允许新增 schema 解析逻辑
3. `action/*` 不允许重新解析 raw payload
4. `contracts/*` 是查看上下行边界契约的首选入口
5. `types/*` 只放内部共用类型和兼容 re-export

## 5. 推荐阅读顺序

1. `contracts/upstream-events.ts`
2. `contracts/downstream-messages.ts`
3. `contracts/transport-messages.ts`
4. `protocol/upstream/UpstreamEventExtractor.ts`
5. `protocol/downstream/DownstreamMessageNormalizer.ts`
6. `runtime/BridgeRuntime.ts`
