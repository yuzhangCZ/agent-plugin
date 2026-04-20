# Gateway Client 协议边界上推与类型归一化改造设计

## 背景

当前 `gateway-client` 对外消息类型仍以 `unknown` 为主，[packages/gateway-client/src/ports/GatewayClientMessages.ts](/Users/zy/Code/agent-plugin-gateway-client-architecture-cleanup/packages/gateway-client/src/ports/GatewayClientMessages.ts:1) 仅提供空类型别名。虽然包内已经具备部分协议校验能力，但 raw frame 的解释、downstream normalize、业务分流仍大量滞留在 `BridgeRuntime` 和 `OpenClawGatewayBridge` 中。

这导致几个问题：

- `gateway-client` 名义上是 facade，实际上仍未真正拥有协议边界
- bridge runtime 继续消费裸协议对象并承担解释责任
- 同类 normalize / classify / log extract 逻辑在不同插件中重复
- 类型契约不稳定，测试只能围绕 raw object 做间接覆盖

本次 PR2 的目标，是把共享协议的上下行归一化收口到 `gateway-client`，让上层 bridge runtime 尽量只消费 typed 事件，而不是直接处理 raw message。

## 目标

1. 让 `gateway-client` 成为共享协议边界的唯一归一码
2. 为下行提供稳定的 typed inbound envelope / typed business message
3. 为上行提供稳定的 typed business send payload，而不是要求上层直接组 transport payload
4. 让 `BridgeRuntime` / `OpenClawGatewayBridge` 从“协议解释者”收敛为“业务编排者”
5. 为后续协议版本演进保留 adapter 缓冲层，避免 wire schema 直接穿透 facade

## 非目标

1. 不在本次改造中一次性迁移所有 wire schema
2. 不把 `message-bridge` / `openclaw` 的历史兼容逻辑并入 shared `gateway-client`
3. 不在本次中重做生命周期状态模型与发送策略枚举，那属于 PR3
4. 不修改 `integration/opencode-cui` 或 submodule 指针

## 核心设计原则

1. `gateway-schema` 是共享 wire contract，不是 `gateway-client` 的最终 public facade contract
2. `gateway-client` 负责“协议模型 -> facade 模型”的映射
3. 插件专属兼容逻辑保留在各自插件 bounded context，不污染 shared client
4. runtime 只负责编排、状态机、副作用，不负责 raw schema 解释
5. public `send()` 只接受业务上行消息，不暴露内部 control frame 语义

## 一、分层边界

### 1. `packages/gateway-schema`

职责：

- 定义共享 downstream / upstream wire contract
- 提供 validator / normalizer
- 作为协议层依赖被 `gateway-client` 使用

约束：

- 不直接作为 `gateway-client` 稳定 facade API 暴露
- 协议兼容演进优先在这一层处理输入合法性，不直接决定 facade 形态

### 2. `packages/gateway-client`

职责：

- 负责上下行协议归一化
- 对外暴露 typed facade contract
- 负责连接编排、READY gating、心跳、重连协调、发送出口

约束：

- facade 暴露自己的 typed business contract
- 不把插件私有 compat rule 并入 shared client

### 3. `plugins/message-bridge` / `plugins/message-bridge-openclaw`

职责：

- 消费 `gateway-client` 的 typed 事件
- 执行业务编排、action dispatch、插件特有适配
- 保留本插件私有历史兼容逻辑

约束：

- 不再承担共享 downstream 整帧 normalize
- 不再直接消费 raw websocket message 作为主业务输入

## 二、类型策略

### 设计核心

不要把 `GatewayBusinessMessage = GatewayDownstreamBusinessRequest` 固化为长期终态。

原因：

- `GatewayDownstreamBusinessRequest` 是 wire 层模型
- `GatewayBusinessMessage` 应是 facade 层模型
- 如果两者永久等同，`gateway-schema` 的字段演进会直接穿透 `gateway-client` public API

### 过渡版策略

为降低 PR2 范围，允许先用共享 contract 的稳定主链路作为过渡 facade 类型：

```ts
type GatewayBusinessMessage = GatewayDownstreamBusinessRequest;
```

但需要在设计与代码注释中明确：

- 这是 transitional API
- 仅用于先消除 raw/unknown 穿透
- 不应作为长期稳定边界承诺

### 终态策略

后续收敛为 facade 自有类型：

```ts
type GatewayBusinessMessage =
  | GatewayInvokeMessage
  | GatewayStatusQueryMessage;
```

再由 `gateway-client` 内部 protocol adapter 完成：

```ts
GatewayDownstreamBusinessRequest -> GatewayBusinessMessage
```

这样做的收益：

- wire 层兼容字段可以被 adapter 吸收
- facade 只暴露稳定语义，不暴露底层协议细节
- 上层 runtime 与 `gateway-schema` 解耦

## 三、目标类型模型

### 1. 下行业务消息

`GatewayBusinessMessage`

语义：

- 表示通过共享协议校验、且可被上层业务消费的消息
- 默认覆盖 `status_query` 与 `invoke` 主链路
- `invoke` 继续按 action 细分 typed 结构

过渡阶段：

- 可先别名至共享 `GatewayDownstreamBusinessRequest` 主链路

终态：

- 迁移为 facade 自有判别联合

### 2. 入站观测 envelope

`GatewayInboundFrame`

语义：

- 表示一帧入站消息经过 decode / parse / classify 后的稳定 envelope
- 用于 telemetry、control handling、诊断观测
- 必须覆盖成功路径与失败路径，避免 decode / parse failure 重新散落在 router 的旁路分支

推荐结构：

```ts
type GatewayInboundFrame =
  | {
      kind: 'decode_error';
      reason: 'unsupported_binary_frame' | 'text_decode_failed';
      rawPreview?: string;
    }
  | {
      kind: 'parse_error';
      rawPreview: string;
    }
  | {
      kind: 'control';
      messageType: string;
      message: GatewayControlInboundMessage;
    }
  | {
      kind: 'business';
      messageType: string;
      message: GatewayBusinessMessage;
    }
  | {
      kind: 'invalid';
      messageType?: string;
      gatewayMessageId?: string;
      action?: string;
      welinkSessionId?: string;
      toolSessionId?: string;
      violation: WireContractViolation;
      rawPreview: unknown;
    };
```

约束：

- `decode_error` / `parse_error` / `invalid` 都必须进入统一 `inbound` 观测口
- `invalid` 只保留 `rawPreview`，不暴露完整 `raw`
- `invalid` 允许附带 best-effort 路由字段，供上层插件在不重新解析 raw 的前提下做诊断或回包决策
- 避免 facade 重新鼓励上层 fallback 到 raw parsing
- `GatewayClientError.details` 与 runtime 日志不应直接展开 `rawPreview`，只保留裁剪后的 `messagePreview`

### 3. 上行业务发送类型

`GatewaySendPayload`

语义：

- facade 公共 `send()` 允许发送的业务消息
- 仅包含业务上行，不包含 runtime 内部 control frame

范围：

- `tool_event`
- `tool_done`
- `tool_error`
- `session_created`
- `status_response`

### 4. 出站观测消息

`GatewayOutboundMessage`

语义：

- 发送后用于观测的 envelope / message
- 可包含业务上行与内部 control 上行

约束：

- 观测口可以看见 `register` / `heartbeat`
- 但 public `send()` 不允许调用方直接发送 `register` / `heartbeat`

## 四、模块切分

当前 `InboundFrameRouter` 同时承担：

- 数据解码
- JSON parse
- protocol classify
- control/business 分流
- READY gating
- 副作用编排

职责过多，需要拆分。

### 1. `InboundFrameDecoder`

位置建议：

- `packages/gateway-client/src/application/protocol/InboundFrameDecoder.ts`

职责：

- `event.data -> GatewayInboundFrame`
- 负责字符串解码与 JSON parse
- 对 decode failure / parse failure 产出结构化 envelope
- 不做协议分类与业务判断

### 2. `InboundProtocolAdapter`

位置建议：

- `packages/gateway-client/src/application/protocol/InboundProtocolAdapter.ts`

职责：

- `unknown -> GatewayInboundFrame`
- 使用共享 protocol normalizer / validator
- 区分 `control` / `business` / `invalid`
- 产出 facade 语义 envelope

约束：

- 只处理“已成功 parse 的 unknown”，不重复承担 decode / parse
- 不做 READY gating
- 不做 transport close / heartbeat start 等副作用

### 3. `InboundFrameRouter`

保留位置：

- `packages/gateway-client/src/application/runtime/InboundFrameRouter.ts`

新职责：

- 消费 `GatewayInboundFrame`
- `decode_error` / `parse_error` / `invalid` -> 统一日志与错误发射
- control frame -> `ControlMessageHandler`
- business frame -> `BusinessMessageHandler`
- 负责 READY gating、副作用触发、事件派发

当前实现补充约束：

- invalid business frame 发射 `GATEWAY_PROTOCOL_VIOLATION`，但不因此断链
- invalid control frame 继续 fail-closed，避免握手停在半连接状态
- protocol violation 的 error details 与日志统一只保留裁剪后的 `messagePreview`

### 4. `BusinessOutboundProtocolAdapter`

位置建议：

- `packages/gateway-client/src/application/protocol/BusinessOutboundProtocolAdapter.ts`

职责：

- `GatewaySendPayload -> validated business transport message`
- 向上游暴露业务发送语义
- 对 business transport payload 进行校验和归一化

### 5. `InternalControlMessageFactory`

位置建议：

- `packages/gateway-client/src/application/protocol/InternalControlMessageFactory.ts`

职责：

- 仅构造 runtime 内部 control message
- `register`
- `heartbeat`
- 不负责最终协议放行判定

约束：

- 不进入公共 facade API
- 只供 runtime 内部协作对象使用

### 6. `OutboundProtocolGate`

位置建议：

- `packages/gateway-client/src/application/protocol/OutboundProtocolGate.ts`

职责：

- 作为统一 fail-closed 出站闸口
- 校验并归一化 business outbound message
- 校验并归一化 internal control message

约束：

- 所有实际写入 transport 的消息都必须经过这一层
- 不允许 business path 与 internal control path 分别维护各自独立的最终协议校验规则

## 五、端口设计调整

现有 `GatewayWireCodec` 同时承担上下行两个方向：

- `normalizeDownstream`
- `validateTransportMessage`

语义过宽，建议拆分。

### 1. `GatewayInboundProtocolPort`

职责：

- `unknown -> GatewayInboundFrame` 或结构化违约

### 2. `GatewayOutboundProtocolPort`

职责：

- `GatewaySendPayload -> GatewayBusinessOutboundMessage`
- `InternalControlMessage -> GatewayInternalControlTransportMessage`
- 为两类出站消息提供统一 fail-closed 校验结果

收益：

- 上下行依赖更清晰
- 单测更直接
- 替换实现或多协议版本兼容时边界更稳定

## 六、运行时职责调整

### 1. `BusinessMessageHandler`

当前问题：

- 只做 READY gating，仍接受 `unknown`

调整后：

- 入参改为 `GatewayBusinessMessage`
- 只做 READY gating 与业务事件派发决策
- 不再承担任何协议解释责任

### 2. `ControlMessageHandler`

当前问题：

- 仍接受 `unknown`，内部依赖 codec 做二次校验

调整后：

- 直接消费 typed control message
- 只做控制态决策：`ready` / `rejected` / `noop`
- 不再承担 raw validation

### 3. `OutboundSender`

当前问题：

- 既知道 control/business，也通过 `type` 字面量做分支
- public `send()` 实际上允许外部以协议层视角构造消息

调整后：

- public path 只接收 `GatewaySendPayload`
- internal control 走独立入口
- `OutboundSender` 只负责状态校验、调用统一出站闸口、序列化、telemetry、transport send
- 不再分别持有 business/control 的最终协议判定逻辑

### 4. `ConnectSession` / `HeartbeatLoop`

调整后：

- `register` 与 `heartbeat` 通过 `InternalControlMessageFactory` 构造
- 最终仍需经过统一 `OutboundProtocolGate` 校验后才能写入 transport
- 继续由 runtime 内部驱动，不暴露给 facade 调用方

## 七、对 bridge runtime 的影响

### 1. `plugins/message-bridge/src/runtime/BridgeRuntime.ts`

当前问题：

- `connection.on('message')` 后继续本地 `normalizeDownstreamMessage(raw, ...)`
- runtime 仍是共享协议解释者

调整后：

- `connection.on('message')` 直接获得 typed `GatewayBusinessMessage`
- `handleDownstreamMessage(raw: unknown)` 改为 `handleDownstreamMessage(message: GatewayBusinessMessage)`
- 删除 bridge 侧共享 downstream normalize 主链路
- runtime 只保留业务 dispatch、日志、错误处理
- 若仍需插件专属兼容，改为在 facade message 之后追加本地 adapter，而不是回退到 raw normalize
- `adaptGatewayBusinessMessage()` 当前直接对 typed facade 做本地 shape 收口：补齐可选 `welinkSessionId` 的 `undefined` 语义
- `DownstreamMessageNormalizer` 已降级为 raw/shared 包装器，只供 isolated normalization 测试或原始输入场景复用，不再作为 runtime typed 主链路入口

### 2. `plugins/message-bridge-openclaw/src/OpenClawGatewayBridge.ts`

当前问题：

- `message` 事件仍传入 normalize 前对象
- openclaw bridge 继续承担整帧 downstream normalize

调整后：

- 直接消费 typed `GatewayBusinessMessage`
- 状态查询与 invoke 主链路基于 typed message 分发
- 仅保留 openclaw 私有 compat adapter，例如 legacy create-session payload 处理
- 不再对整帧做共享协议 normalize
- compat adapter 的输入改为 facade typed message，而不是 raw/shared-normalized message

### 3. invalid invoke 的桥接回包

在 typed `message` 主链路之外，两个 bridge runtime 还会消费 `connection.on('inbound')` 暴露的 `GatewayInboundFrame.invalid`。

当前实现约束：

- 仅 `kind === 'invalid' && messageType === 'invoke'` 进入插件侧 responder
- responder 只消费 `inbound.invalid`，不通过 `error` 事件触发回包
- 至少存在 `welinkSessionId` 或 `toolSessionId` 之一才允许 best-effort 回 `tool_error`
- 连接未到 `READY` 时只记录 `runtime.invalid_invoke.skipped_not_ready`，不强行发送
- 回包统一使用 `gateway_invalid_invoke:<code>` 作为 `tool_error.error`
- 这条逻辑属于插件 bounded context，`gateway-client` 不直接发送 `tool_error`

## 八、兼容边界

这是本设计最重要的约束之一。

### 共享层负责什么

`gateway-client` 只负责：

- 共享协议主链路的 decode / validate / classify / facade mapping
- typed message / typed send payload 的稳定输出

### 共享层不负责什么

`gateway-client` 不负责：

- `message-bridge` 特有 downstream compat
- `openclaw` 特有 legacy payload 兼容
- 插件内业务映射与业务补偿逻辑

### 插件侧 compat 的归属

插件专属 compat 属于各自 bounded context，必须留在：

- `plugins/message-bridge/src/protocol/*`
- `plugins/message-bridge-openclaw/src/protocol/*`
- `plugins/message-bridge-openclaw/src/adapters/*`

这样才能避免 shared client 被历史包袱污染。

### 插件侧 compat 的输入边界

为避免“只是把 raw normalize 挪个位置”，插件侧 compat 必须接在 facade 之后：

```ts
GatewayBusinessMessage -> PluginCompatAdapter -> PluginNormalizedMessage
```

约束：

- PR2 期间，插件 compat 不再直接接收 raw websocket frame
- 也不再以 shared normalize 结果作为主输入
- 若 `GatewayBusinessMessage` 仍暂时别名到 `GatewayDownstreamBusinessRequest`，需要在文档和类型注释中明确其 transitional 属性，避免被误当成长期稳定边界
- 若插件私有 compat 仍需访问共享归一化前的 payload 片段，应改走 `GatewayInboundFrame.business` 这类观测入口，在插件私有 adapter 中消费，而不是污染 `GatewayBusinessMessage` 主链路

## 九、观测事件约束

### 1. `inbound`

- 作为统一入站观测口，必须覆盖 `decode_error`、`parse_error`、`invalid`、`control`、`business`
- 调用方可以基于 `kind` 做诊断、指标与日志，不需要重新猜测失败发生在哪一层
- `inbound.invalid` 是插件侧唯一允许驱动 invalid invoke -> `tool_error` 翻译的端口

### 2. `outbound` 与 `heartbeat`

- `outbound` 是完整出站观测面，可观测 business message 与 internal control message
- `heartbeat` 是从 `outbound` 中派生出的语义快捷事件，只用于需要单独关注心跳的调用方
- 同一条 heartbeat 不应在观测语义上被当成两条独立出站消息

### 3. `error`

- `error` 用于共享层协议违约、连接状态与统一观测，不负责驱动插件侧 `tool_error` 回包
- invalid business frame 可以同时触发 `inbound.invalid` 与 `GATEWAY_PROTOCOL_VIOLATION`
- 对 invalid invoke 的业务回包决策必须基于 `inbound.invalid`，避免 `error` 与 `inbound` 双消费造成重复回包

## 十、迁移策略

采用渐进式迁移，先收口 raw/unknown，再逐步收紧 facade 模型。

### 阶段 1：建立过渡类型

- 在 `GatewayClientMessages.ts` 定义过渡版 typed contract
- `GatewayBusinessMessage` 可暂时别名共享稳定主链路
- 对确有历史兼容需求的插件，应通过插件私有 compat adapter 读取观测入口中的原始 payload 上下文，而不是继续把它挂在 facade 业务消息上
- 新增 `GatewayInboundFrame`
- 明确 `GatewayInboundFrame` 必须覆盖 decode / parse / invalid / control / business 五类路径

### 阶段 2：拆分入站协议层

- 引入 `InboundFrameDecoder`
- 引入 `InboundProtocolAdapter`
- `InboundFrameRouter` 改为消费 typed envelope
- 删除 router 内部对 decode / JSON parse failure 的旁路吞掉逻辑

### 阶段 3：收紧 handler 入参

- `BusinessMessageHandler` 改 typed
- `ControlMessageHandler` 改 typed

### 阶段 4：拆分上行协议层

- 引入 `BusinessOutboundProtocolAdapter`
- 引入 `InternalControlMessageFactory`
- 引入统一 `OutboundProtocolGate`
- public `send()` 改为只接受业务上行

### 阶段 5：迁移 bridge runtime

- `BridgeRuntime` 改为消费 typed `message`
- `OpenClawGatewayBridge` 改为消费 typed `message`
- 插件私有 compat adapter 改为接收 facade typed message

### 阶段 6：删除重复 normalize

- 删除 bridge 内共享 downstream normalize 主链路
- 保留插件私有 compat adapter
- `message-bridge` runtime 主链路改为 direct mapping，不再二次调用共享 `normalizeDownstream()`
- `DownstreamMessageNormalizer` 仅保留为 raw/shared 包装用途

### 阶段 7：为终态 facade 模型留口

- 后续把 `GatewayBusinessMessage` 从共享别名替换为 facade 自有模型
- adapter 层保留桥接逻辑，不影响上层

## 十一、测试策略

### 1. `packages/gateway-client`

新增或补强以下测试：

- inbound frame decode contract
- inbound frame parse failure contract
- inbound protocol classify contract
- invalid frame contract
- control frame typed handling
- business message READY gating
- outbound business payload contract
- internal control send contract
- unified outbound protocol gate contract
- public type contract test

重点验证：

- `message` 事件不再透出 raw unknown
- `inbound` 事件能表达 decode_error/parse_error/control/business/invalid 五类
- invalid business frame 会发 `GATEWAY_PROTOCOL_VIOLATION`，但不会被当作 business message 继续派发
- invalid control frame 仍 fail-closed
- public `send()` 不接受 control frame
- business 与 internal control 最终都经过统一出站校验闸口

### 2. `plugins/message-bridge`

验证：

- typed downstream receive path
- status_query 主链路
- invoke 主链路
- 删除本地 normalize 后行为不回退
- invalid invoke 仅通过 `inbound.invalid` 触发 best-effort `tool_error`
- `error` 事件不会触发 invalid invoke 回包
- 仅 `welinkSessionId` 或仅 `toolSessionId` 的单边路由场景仍可回包

### 3. `plugins/message-bridge-openclaw`

验证：

- typed invoke consume path
- status_query consume path
- legacy create-session adapter 仍按预期生效
- invalid invoke -> `tool_error` responder 与主插件保持同语义

### 4. workspace

执行：

```bash
pnpm verify:workspace
```

如果跨插件边界有改动，这是默认收口验证命令。

## 十二、收益

### 1. 架构收益

- `gateway-client` 真正拥有共享协议边界
- runtime 与 wire contract 解耦
- bridge runtime 从“协议解释者”收敛为“业务编排者”

### 2. 类型收益

- 下行与上行类型契约明确
- raw/unknown 穿透显著减少
- facade 对外语义更稳定

### 3. 测试收益

- 单测可以直接围绕 typed contract 建立
- 协议分类与业务分流可独立验证
- 多协议版本兼容更容易通过 adapter 层扩展

### 4. 演进收益

- 为后续 facade 自有 business model 预留空间
- `gateway-schema` 演进不会直接污染 `gateway-client` 公共 API

## 十三、风险与控制

### 风险 1：把共享 wire contract 直接永久暴露为 facade contract

控制：

- 只允许作为 transitional API
- 设计中明确终态为 facade 自有类型

### 风险 2：shared client 吸收插件私有 compat

控制：

- 在设计和实现边界中明确禁止
- compat 保留在插件 protocol / adapter 层

### 风险 3：迁移过程引起 runtime 行为漂移

控制：

- 先建立 typed envelope，再替换上层消费点
- 不在同一阶段同时改生命周期模型

### 风险 4：public send API 意外暴露 control frame

控制：

- control message 通过 internal factory 单独发送
- business 与 internal control 最终统一经过 `OutboundProtocolGate`
- public `send()` 明确只接受业务类型

## 十四、结论

本设计的最终结论是：

- `gateway-client` 应承担共享协议上下行消息的类型归一化
- 但它不应把 `gateway-schema` 原始 contract 原样固化为长期 public facade contract
- 本次 PR2 先以过渡类型收口 raw/unknown 穿透，再通过 protocol adapter 建立从 wire model 到 facade model 的稳定边界
- `BridgeRuntime` 与 `OpenClawGatewayBridge` 在改造后将主要消费 typed 事件，不再直接承担共享协议解释责任
