# AGENTS.md

## 模块定位

`packages/bridge-runtime-sdk` 是统一 bridge runtime SDK，负责把 gateway 下行请求收敛为 runtime command，调用宿主 `ThirdPartyAgentProvider`，校验 provider facts，并投影为 gateway 上行业务消息。

本包不拥有共享网关协议字段真源；协议字段与校验优先依赖 `@agent-plugin/gateway-schema`，连接运行时优先依赖 `@agent-plugin/gateway-client`。

## 常用命令

在本目录或通过根目录 `pnpm --dir packages/bridge-runtime-sdk ...` 执行：

- `pnpm test`
- `pnpm run typecheck`
- `pnpm run build`
- `pnpm run pack:check -- --skip-build`
- `pnpm run verify:core`

代码改动至少运行 `pnpm test` 或相关测试文件覆盖的包内测试；修改 public contract、入口导出、构建脚本或分发形态时优先运行 `pnpm run verify:core`。

## 工作边界

- `src/index.ts` 是稳定入口，只导出宿主需要的 facade、provider contract、诊断和授权能力。
- `src/public-contract.ts` 是对外 contract 汇总源之一，新增或调整 public 类型必须同步考虑 `tests/public-api-contract.test.ts`。
- `src/infrastructure/gateway/gateway-host.ts` 只做 SDK 到 `gateway-client` 的适配，不重新定义 public gateway host config。
- `dist/`、`.tmp/`、`node_modules/` 是生成或安装产物，不作为源码修改目标。
- 不在本包内实现 OpenCode/OpenClaw 具体宿主逻辑；宿主差异应留在对应 plugin 或 provider adapter。

## 分层约束

- `src/domain/`：放 provider contract、runtime command、领域错误和与宿主无关的语义类型。
- `src/application/ports/`：放应用层端口；跨层协作先定义端口，再由 adapter 或 infrastructure 实现。
- `src/application/usecases/`：持有单个 runtime command 的执行语义，不直接操作 gateway transport。
- `src/application/coordinators/`：处理 request run、outbound、pending interaction 等跨 usecase 状态协作。
- `src/application/projectors/`：处理 fact、skill event、gateway message 和 terminal signal 的投影；不调用 provider。
- `src/application/lifecycle/`：只管理 runtime lifecycle 和 probe lifecycle，不处理下行业务命令。
- `src/adapters/gateway/`：连接 gateway、下行转换和上行发送适配；不下沉 provider 业务规则。
- `src/adapters/provider/`：把 provider 调用包装为观测友好的 command handlers，不改写协议语义。
- `src/adapters/observation/`：只投影 observation event 到日志或 diagnostics，不反向驱动业务状态。
- `src/infrastructure/`：放默认实现，例如内存 registry 和 gateway-client host adapter。

## Runtime 与 Gateway 规则

- `BridgeRuntime` facade 只暴露稳定能力：`start`、`stop`、`probe`、`getStatus`、`getDiagnostics`。
- runtime 主连接与临时 probe 连接必须隔离；probe 不 attach runtime observers，也不参与 READY 状态机。
- gateway 未 READY、provider 返回非法 fact、下行 invoke 非法时必须 fail-closed，不继续投影正常业务消息。
- 当前主连接由 `GatewayRuntimeDriver` 承载，临时 probe 由 `GatewayProbeDriver` 承载；调整类名或装配方式时必须保持主连接与旁路 probe 隔离。
- lifecycle 服务不应承载 probe 连接细节；probe 并发、取消和包装错误应留在独立 probe lifecycle 协作对象中。
- diagnostics 中的 gateway 原始错误码应保留排障价值；对外抛错可使用稳定 `BridgeRuntimeErrorCode`。

## Public Contract 规则

- 新增 public API 必须从 `src/index.ts` 明确导出，并补充 public API contract 测试。
- 不从稳定入口导出 `BridgeGatewayHostConnection`、`BridgeGatewayHostState`、`BridgeGatewayHostError`、observer 或 registry 内部类型。
- `BridgeGatewayHostConfig.register.channel` 是业务渠道字符串，SDK 不在类型层收窄具体产品枚举。
- `toolVersion` 表示宿主 agent 版本，`pluginVersion` 表示插件封装版本，`sdkVersion` 由 SDK 自动注入，外部不传。
- `@agent-plugin/gateway-client` 和 `@wecode/skill-qrcode-auth` 不应作为本包 published dependency 直接暴露给调用方。

## Fact 与投影规则

- provider facts 必须先经过 `FactSequenceValidator`，再进入上行投影。
- `tool_event`、`tool_done`、`tool_error` 的生成边界必须清晰，terminal 收口不得重复发送。
- pending question/permission 的 token 由 registry 全局协调，不按 session 粗暴清空。
- `question.ask` 使用结构化 `questions[].options[].description` 作为展示说明，不作为 reply 路由依据。
- `permission.reply` 使用 `permissionId` 路由，保留 `permType` 作为兼容/语义字段。

## Observation 与 Diagnostics

- 新增 runtime 行为优先补充 `RuntimeObservation` facade 方法和 `RuntimeObservationEvent` 类型，再由 logger/trace adapter 投影。
- 查询型结果，例如 probe/status/health check，不写入 `RuntimeDiagnostics.failures`，除非它表示 runtime 失败事件。
- 日志 meta 必须经过脱敏边界，不记录 `ak`、`sk`、`token`、`authorization`、`cookie`、`secret`、`password`、`content`、`text`、`answers` 等敏感字段原文。
- 新增 payload 或 meta 字段时按语义判断是否脱敏，不只依赖固定字段名列表。
- diagnostics 面向排障，应保留原始错误 message/code；public API 错误面向调用方，可提供稳定分类。

## 测试规则

- 修改 lifecycle、gateway driver、probe、observation 或 diagnostics 时，优先补充 `tests/runtime-sdk.test.ts` 或 `tests/runtime-observation.test.ts`。
- 修改稳定入口、public contract、包依赖和导出边界时，必须补充或更新 `tests/public-api-contract.test.ts`。
- 修改 fact sequence、projector、coordinator 时，优先覆盖对应 focused test，并补充端到端 runtime 行为测试。
- 修改 build、publish manifest、dts 生成或 package exports 时，运行 `pnpm run build` 和 `pnpm run pack:check -- --skip-build`。
- 涉及 gateway-client 适配语义时，确认 `packages/gateway-client` 的 public 错误码和状态语义，不在本包猜测或复制实现。

## 注释规则

- 导出的 interface、class、function 继续遵守根级 TSDoc 要求。
- port、facade、validator、runtime lifecycle、probe lifecycle、统一发送/校验入口必须说明职责边界或 fail-closed 语义。
- 注释解释“边界”和“为什么”，不要重复代码字面含义。
- 允许对 lint 阈值使用定向 `eslint-disable-next-line`，但必须写明结构性原因，不允许无说明禁用整类规则。
