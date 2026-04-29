# `skill-plugin-cli` 输出规格实施方案设计

**Version:** 0.1  
**Date:** 2026-04-29  
**Status:** Draft  
**Owner:** agent-plugin maintainers  
**Related:** [终端输出规格](./OUTPUT_SPEC.md), [统一安装 CLI 方案设计](../../../docs/design/skill-plugin-cli-solution.md), [二维码扫码授权方案设计](../../../docs/design/qrcode-auth-session-solution.md)

## 1. 文档定位

本文基于 [终端输出规格](./OUTPUT_SPEC.md)，定义 `skill-plugin-cli` 输出层的实现方案与分层边界，用于承接默认模式文案收口、`--verbose` 诊断视图、二维码展示与错误摘要等改造。

本文是 `OUTPUT_SPEC.md` 的实现设计文档，不替代输出规格本身。输出文本真源仍然只有 `OUTPUT_SPEC.md`；本文只回答“如何实现”。

本文负责定义：

- `skill-plugin-cli` 输出层的目标边界与非目标
- 输出编排在 Clean Architecture / Hexagonal Architecture 下的职责分配
- CLI 参数、host adapter、presenter、qrcode adapter、process tracing 的接口调整方向
- 默认模式与 `--verbose` 的统一实现路径
- 二维码刷新、失败摘要、参数错误与 next step 的结构化建模方式
- 建议的实施顺序与测试矩阵

本文不负责定义：

- 安装主流程顺序、宿主命令与完成语义
- `OUTPUT_SPEC.md` 之外的新文案 contract
- `skill-qrcode-auth` 内部认证流程重构
- 发布流程、版本策略与 npm 包发布方式

## 2. 问题陈述

当前 `skill-plugin-cli` 输出层主要存在以下问题：

1. `Presenter` 同时承担内部阶段日志与用户可见终端文案，默认模式会暴露实现细节。
2. `InstallPluginCliUseCase`、`HostAdapter`、`TerminalCliPresenter` 之间通过自由文本协作，缺少稳定的结构化 contract。
3. `ProcessRunner` 的命令执行边界没有统一的规格化输出路径。
4. 二维码刷新次数、失败摘要、时间格式、fallback 文案尚未形成稳定模型。
5. 参数错误发生在 use case 之前，当前没有按规格追加帮助提示。

这些问题导致当前输出既不符合 `OUTPUT_SPEC.md`，也不利于后续维护和测试。

## 3. 设计目标

本次改造冻结以下目标：

1. 默认模式仅输出 `OUTPUT_SPEC.md` 允许的用户可见文本。
2. `--verbose` 仅作为默认流程的附加诊断视图，不引入第二套业务流程。
3. `InstallPluginCliUseCase` 保持为唯一输出编排者。
4. Host adapter 仅返回宿主事实，不直接返回最终展示文案。
5. 二维码 runtime 的共享事件模型与 CLI 展示模型解耦。
6. 所有输出相关测试以结构化事件和固定规格文本为断言基线。

## 4. 非目标

本轮明确不做以下事情：

- 不修改安装策略、参数语义和宿主安装顺序
- 不新增 `OUTPUT_SPEC.md` 之外的终端文本 contract
- 不扩展 OpenCode / OpenClaw 的宿主产品能力
- 不在本轮同步重写 README 或外部说明文档

## 5. 设计原则

### 5.1 规格驱动

输出文本、标签、顺序、时间格式和错误摘要都以 `OUTPUT_SPEC.md` 为唯一真源，不以当前实现文案为准。

### 5.2 应用层单一编排入口

所有终端输出必须由 `InstallPluginCliUseCase` 编排触发；基础设施和 adapter 不允许直接向 presenter 写入用户可见事件。

### 5.3 结构化事实优先

adapter 与 presenter 之间传递结构化事实，而不是 `detail`、`hostLabel`、`nextSteps` 这类自由文本。

### 5.4 默认模式最小暴露

默认模式只展示用户完成安装所需的最小信息，不暴露内部阶段术语、命令边界或重复提示。

## 6. 总体架构

本次改造后的职责分层如下：

- `application`
  - `InstallPluginCliUseCase`：安装流程与输出编排唯一入口
  - `ResolveInstallContextUseCase`：补齐输入上下文默认值
- `domain ports`
  - `HostAdapter`：宿主事实与能力边界
  - `QrCodeAuthPort`：二维码认证流程边界
  - `ProcessRunner`：命令执行与 tracing 事实边界
  - `Presenter`：规格事件到终端文本的渲染边界
- `adapters`
  - `OpenClawHostAdapter` / `OpencodeHostAdapter`：宿主命令与配置写入
  - `QrCodeAuthAdapter`：runtime snapshot 到 CLI 展示 DTO 的映射
  - `TerminalCliPresenter`：终端输出
  - `NodeProcessRunner`：进程执行与 tracing 事实采集

关键约束如下：

- use case 是唯一 presenter 调用方
- `ProcessRunner` 只回传 tracing 事实，不直接驱动 presenter
- host adapter 只返回宿主事实，不返回中文句子
- qrcode shared snapshot 不直接塑造成 CLI 展示模型

## 7. 关键方案

### 7.1 CLI 参数与上下文扩展

扩展输入模型：

```ts
export interface ParsedInstallCommand {
  command: "install";
  host: "opencode" | "openclaw";
  environment?: "uat" | "prod";
  registry?: string;
  url?: string;
  verbose?: boolean;
}

export interface InstallContext {
  command: "install";
  host: "opencode" | "openclaw";
  environment: "uat" | "prod";
  registry: string;
  url?: string;
  mac: string;
  channel: "openx";
  verbose: boolean;
}
```

约束如下：

- `parseInstallArgv()` 新增 `--verbose`
- `ResolveInstallContextUseCase` 补齐 `verbose=false`
- `formatHelp()` 完全对齐 `OUTPUT_SPEC.md` 6.1

参数错误收口规则：

- `INSTALLER_USAGE_ERROR` 仍由 `main.ts` 顶层捕获
- 除原始错误文案外，固定追加：
  - `可执行 skill-plugin-cli --help 查看用法`

### 7.2 HostAdapter 返回语义事实

现有 `hostLabel` / `detail` / `nextSteps` 模式不再保留。改为以下结构：

```ts
export interface HostMetadata {
  host: "opencode" | "openclaw";
  hostDisplayName: "opencode" | "openclaw";
  packageName: string;
  primaryConfigPath: string;
}

export interface HostPreflightResult {
  metadata: HostMetadata;
  version?: string;
}

export interface HostConfigureResult {
  primaryConfigPath: string;
  additionalConfigPaths: string[];
}

export interface HostAvailabilityResult {
  nextAction: {
    kind: "restart_host" | "restart_gateway";
    manual: boolean;
    effect:
      | "gateway_config_effective"
      | "plugin_and_config_effective";
    command?: string;
  };
}
```

约束如下：

- `hostDisplayName` 统一小写
- `primaryConfigPath` 必须是真实绝对路径
- `additionalConfigPaths` 只传路径，不传说明文案
- 默认模式不展示 `additionalConfigPaths`，但 use case 必须完整保留该事实，供 `--verbose` 或相关失败场景消费
- `version` 仅 `openclaw` 需要展示
- `HostAvailabilityResult` 必须足以无歧义生成规格中的 next step

next step 不再由 adapter 返回中文句子，而是由 presenter 基于 `HostAvailabilityResult.nextAction` 的语义事实生成规格文本。

示例约束如下：

- `openclaw`
  - `kind = "restart_gateway"`
  - `manual = true`
  - `effect = "gateway_config_effective"`
  - `command = "openclaw gateway restart"`
- `opencode`
  - `kind = "restart_host"`
  - `manual = true`
  - `effect = "plugin_and_config_effective"`
  - `command = undefined`

这样 presenter 无需根据宿主名临场推导 next step 差异，只需应用规格模板。

### 7.3 Presenter 改为规格事件接口

旧的 `stageStarted` / `stageSucceeded` / `success` / `failure` 接口整体替换为规格事件接口：

```ts
export interface Presenter {
  installStarted(input: {
    host: "opencode" | "openclaw";
    packageName: string;
  }): void;

  hostVersionResolved(input: {
    host: "opencode" | "openclaw";
    version: string;
  }): void;

  hostConfigPathResolved(input: {
    host: "opencode" | "openclaw";
    primaryConfigPath: string;
  }): void;

  stageProgress(input: {
    host: "opencode" | "openclaw";
    stage:
      | "parse_install_args"
      | "check_host_environment"
      | "prepare_npm_registry"
      | "install_plugin"
      | "verify_plugin_installation"
      | "create_welink_assistant"
      | "write_host_configuration"
      | "check_connection_availability";
    status: "started" | "succeeded" | "failed";
    packageName?: string;
    verboseDetail?: string;
  }): void;

  commandBoundary(input: {
    phase: "started" | "finished";
    command: string;
    exitCode?: number;
  }): void;

  pluginInstalled(): void;
  qrSnapshot(snapshot: CliQrSnapshot): void;

  assistantCreated(input: {
    host: "opencode" | "openclaw";
    primaryConfigPath: string;
    additionalConfigPaths: string[];
  }): void;

  availabilityChecked(): void;

  completed(input: {
    host: "opencode" | "openclaw";
    availability: HostAvailabilityResult;
  }): void;

  failed(input: PresenterFailure): void;
}
```

`stageProgress` 只在 `--verbose` 使用，阶段名使用规格层 8 个固定名称，不暴露内部 `INSTALL_STAGES`。其中 `install_plugin` 必须通过 `packageName` 渲染为 `安装插件 <packageName>`，而不是由 use case 直接传完整中文句子。

### 7.4 PresenterFailure

失败统一走结构化入口：

```ts
export type PresenterFailure =
  | {
      kind: "usage_error";
      message: string;
      showHelpHint: true;
    }
  | {
      kind: "qrcode_error";
      summary:
        | { type: "network_error"; code?: string; message?: string }
        | { type: "auth_service_error"; businessCode?: string; error?: string; message?: string; httpStatus?: number };
      verboseMessage?: string;
    }
  | {
      kind: "cancelled";
      message: string;
    }
  | {
      kind: "install_error";
      stage?:
        | "parse_install_args"
        | "check_host_environment"
        | "prepare_npm_registry"
        | "install_plugin"
        | "verify_plugin_installation"
        | "create_welink_assistant"
        | "write_host_configuration"
        | "check_connection_availability";
      message: string;
      verboseMessage?: string;
      additionalConfigPaths?: string[];
    };
```

这样默认模式和 `--verbose` 都能从同一份结构化失败事实出发，不再拼接多套自由文本。

### 7.5 ProcessRunner tracing 只回传事实

`ProcessRunner` 增加 tracing 事实，但不直接推送到 presenter：

```ts
export interface ProcessCommandTrace {
  phase: "started" | "finished";
  command: string;
  args: string[];
  exitCode?: number;
}

export interface ProcessTraceSink {
  push(trace: ProcessCommandTrace): void;
  drain(): ProcessCommandTrace[];
}
```

约束如下：

- `NodeProcessRunner` 通过构造注入的 `ProcessTraceSink` 上报 tracing 事实
- `runtime.ts` 负责创建同一个 in-memory sink，并同时注入 `NodeProcessRunner` 与 `InstallPluginCliUseCase`
- `NodeProcessRunner` 在 `exec` / `spawn` 发出 `started/finished` tracing，在 `spawnDetached` 只发出可确认的 `started` tracing
- 只有 use case 才能消费 `ProcessTraceSink`，并把 tracing 转成 `presenter.commandBoundary(...)`
- 不允许 `ProcessRunner -> Presenter` 直连
- 不允许给每次 `exec` / `spawn` 调用单独传 tracing hooks

`--verbose` 命令边界输出固定为：

- `正在执行命令：<完整命令>`
- 原始命令输出
- `命令执行结束：<完整命令>`

### 7.6 二维码 shared snapshot 与 CLI DTO 解耦

共享认证 runtime 继续保留认证事实导向的 `QrCodeAuthSnapshot`。CLI 输出层通过 `QrCodeAuthAdapter` 映射为 `CliQrSnapshot`：

```ts
export type CliQrSnapshot =
  | {
      type: "qrcode_generated";
      weUrl: string;
      pcUrl: string;
      expiresAt: string;
      refresh?: { index: number; max: number };
    }
  | { type: "expired" }
  | { type: "confirmed" }
  | { type: "cancelled"; message: string }
  | {
      type: "failed";
      summary:
        | { type: "network_error"; code?: string; message?: string }
        | { type: "auth_service_error"; businessCode?: string; error?: string; message?: string; httpStatus?: number };
    };
```

约束如下：

- 刷新总次数 `max` 的唯一来源，是 `QrCodeAuthPolicy.maxRefreshCount` 的最终生效值
- 若调用方未显式提供 `policy.maxRefreshCount`，使用 `skill-qrcode-auth` 已冻结的默认值 `3`
- `QrCodeAuthAdapter` 负责在调用 runtime 前 resolve 最终 policy，并保存该 `maxRefreshCount` 作为后续所有 refresh 事件的唯一真源
- 刷新次数 `index` 由 `QrCodeAuthAdapter` 维护
- 初始二维码不带 `refresh`
- 只有过期后重新生成的新二维码才携带 `refresh: { index, max }`
- presenter 不直接依赖 shared snapshot 拼会话状态机

这样可以避免把 CLI 展示语义长期固化进共享认证类型。

## 8. 输出策略

### 8.1 默认模式

默认模式只允许以下规格事件落文本：

- `installStarted`
- `contextResolved`
- `pluginInstalled`
- `qrSnapshot`
- `assistantCreated`
- `availabilityChecked`
- `completed`
- `failed`

默认模式禁止输出：

- 内部阶段名
- 命令边界
- 宿主安装命令开始/结束提示
- 重复安装开始提示
- `安装成功` / `安装失败` / `安装已取消`
- `宿主配置接入` / `结果确认` / `结束收口` / `可用`

### 8.2 `--verbose`

`--verbose` 在同一业务流程上追加：

- 固定 8 个阶段名
- 参数摘要：`environment=<env>, registry=<registry>, url=<url>`
- 命令边界
- 阶段失败上下文
- 附加配置路径

不允许因为 `--verbose` 改变成功、失败、取消语义。

## 9. UseCase 输出编排

`InstallPluginCliUseCase` 是唯一输出编排入口。成功流顺序固定为：

1. `installStarted`
2. `hostVersionResolved`
3. `hostConfigPathResolved`
4. `pluginInstalled`
5. `qrSnapshot`
6. `assistantCreated`
7. `availabilityChecked`
8. `completed`

失败流顺序固定为：

- 任一阶段失败
- use case 将错误转换为 `PresenterFailure`
- presenter 依据模式输出规格文案

特别约束：

- 二维码过期不是终态
- 二维码确认不是安装完成态
- 写入宿主配置不是最终完成态
- 只有完成可用性检查后才允许输出 `接入完成`
- `openclaw` 版本不满足时，只允许输出 `hostVersionResolved`，不得输出 `hostConfigPathResolved`
- `assistantCreated` 必须在 `configureHost()` 返回之后触发，并消费真实 `primaryConfigPath` 与 `additionalConfigPaths`

## 10. `TerminalCliPresenter` 渲染规则

### 10.1 二维码块

首次二维码：

- `请使用 WeLink 扫码创建助理`
- ASCII 二维码块
- 若 ASCII 渲染失败，改为输出 `weUrl: <url>`
- `pc WeLink 创建助理地址: <pcUrl>`
- `二维码有效期至: <formattedTime>`
- `请在 WeLink 中创建助理`

刷新二维码：

- `二维码已过期，正在刷新`
- `========= 已刷新二维码（第 N/M 次） =========`
- 重新输出完整二维码块

### 10.2 时间格式

- 统一输出 `YYYY-MM-DD HH:mm:ss UTC`
- 不直接输出 ISO 8601
- 默认模式和 `--verbose` 使用同一格式

### 10.3 错误摘要

网络错误：

- `错误摘要：network_error, code=<code>, message=<message>`
- 字段缺失时省略缺失片段
- 最小兜底：`错误摘要：network_error`

服务端错误：

- `错误摘要：businessCode=<businessCode>, error=<error>, message=<message>, httpStatus=<httpStatus>`
- 字段缺失时省略缺失片段
- 最小兜底：`错误摘要：auth_service_error`

### 10.4 渲染失败 fallback

二维码 ASCII 渲染失败时，正式 fallback contract 固定为 `weUrl: <url>`，不允许输出 `二维码渲染失败`、`<二维码渲染失败>` 或旧的 hyperlink label / `pcUrl（可复制打开）` 口径。

## 11. 实施顺序

建议按以下顺序实施：

1. 扩展 `ParsedInstallCommand` / `InstallContext` / `formatHelp()` / `main.ts` 参数错误收口
2. 重构 host adapter 返回模型为语义事实
3. 为 qrcode 增加 CLI 专用 DTO 映射
4. 给 `ProcessRunner` 增加 tracing 事实回传
5. 替换 presenter 为规格事件接口
6. 重写 `InstallPluginCliUseCase` 输出编排
7. 更新单元测试与集成测试

## 12. 测试矩阵

### 12.1 单元测试

- `parse-argv.test.ts`
  - 支持 `--verbose`
  - `--help` 匹配规格
  - 参数错误附加帮助提示
- `presenter.test.ts`
  - openclaw / opencode 默认成功流
  - `--verbose` 固定 8 个阶段名
  - 二维码首次、刷新、连续刷新
  - UTC 时间格式
  - 网络错误摘要 / 服务端错误摘要
- host adapter tests
  - 返回结构化语义事实
  - 主配置路径为真实绝对路径
  - `HostAvailabilityResult` 语义正确
- `ProcessRunner` tests
  - `exec` / `spawn` / `spawnDetached` tracing 事实正确

### 12.2 集成测试

- `--help` 匹配 `OUTPUT_SPEC.md` 6.1
- openclaw 默认成功流匹配 6.2
- opencode 默认成功流匹配 6.3
- `--url` 成功流匹配 6.4
- 默认模式不出现内部提示
- `--verbose` 出现参数摘要与命令边界
- 未安装宿主、版本不满足、插件安装失败、参数错误、二维码取消、二维码失败走规格文案

## 13. 风险与控制

### 风险 1

Presenter 接口替换范围较大，现有测试会集中失效。

控制：

- 先固定新接口与测试断言基线
- 再改 presenter 实现
- 最后改 use case 编排

### 风险 2

二维码刷新次数如果没有稳定来源，`第 N/M 次` 无法满足规格。

控制：

- 在 adapter 层显式承接 refresh 计数来源
- 未补齐前不实现最终刷新标题

### 风险 3

命令 tracing 若直连 presenter，会破坏应用层唯一编排入口。

控制：

- tracing 仅回传事实
- 所有输出仍由 use case 发起

## 14. 结论

本方案的核心不是调整几条终端文案，而是把 `skill-plugin-cli` 输出层从“内部实现日志输出”切换为“规格事件驱动输出”。

完成后将获得：

- 默认模式稳定、可测试、可维护的输出 contract
- `--verbose` 作为受控诊断视图而非内部日志泄漏
- host / qrcode / process tracing 与 presenter 之间清晰的分层边界
- 后续规格演进时可围绕结构化事件局部调整，而不再依赖自由文本耦合
