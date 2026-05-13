# Message Bridge Slash Commands 支持需求文档

**Version:** 1.0  
**Date:** 2026-05-08  
**Status:** Final  
**Owner:** agent-plugin maintainers  
**Related:** `integration/opencode/docs/architecture/07-command.md`, `integration/openclaw/docs/learn/slash-commands-tui-perspective.md`

## 1. 背景

`message-bridge` 与 `message-bridge-openclaw` 插件承担 gateway 与宿主会话能力之间的桥接职责。当前 bridge 链路已具备基础消息收发能力，但缺少对常用 slash command 的统一支持，导致用户无法仅通过文本命令完成会话与模型管理。

为提升 bridge 场景下的可操作性，需要在以下两个插件中补齐统一的 slash command 能力：

- `plugins/message-bridge`
- `plugins/message-bridge-openclaw`

本文档只定义目标行为、对外语义与验收标准，不约束具体实现方式。

## 2. 目标

插件需要支持以下 slash command：

- `/new`
- `/sessions`
- `/session <sessionid>`
- `/models`
- `/model <providerId/modelId>`

目标是让用户在 bridge 场景中完成：

- 新建会话
- 查看可切换会话
- 切换当前会话
- 查看宿主提供的 `providerId/modelId` 模型列表
- 切换当前会话模型到指定 `providerId/modelId`

## 3. 适用范围

本需求适用于：

- OpenCode 侧桥接插件：`message-bridge`
- OpenClaw 侧桥接插件：`message-bridge-openclaw`

本需求不要求修改宿主原生 TUI 的 slash command 体系，仅要求插件在 bridge 职责范围内提供等价业务能力。

## 4. 对外标识约定

### 4.1 会话标识

本需求区分两层会话标识：

- `welinkSessionId`
  - 作为插件与 gateway 服务端之间的外部业务会话标识
- `sessionId`
  - 作为 slash command 返回结果与 `/session <sessionId>` 参数中使用的宿主会话选择标识

约束如下：

- 对用户暴露的宿主会话选择标识是 `sessionId`
- 对 gateway 服务端暴露的业务会话标识是 `welinkSessionId`
- 宿主原生会话标识，例如 `session.id`、`sessionKey` 等，不属于对外契约
- 插件负责维护 `welinkSessionId` 与宿主会话之间的绑定关系
- 插件负责向用户返回可用于 `/session <sessionId>` 的宿主会话选择标识

### 4.2 稳定性要求

`sessionId` 需要在宿主可恢复能力允许的范围内支持跨重启恢复。

即：

- 插件或插件依赖的宿主能力，必须能够在重启后恢复 `sessionId` 与宿主实际会话之间的关系
- 重启后，既有 `sessionId` 仍可用于会话列举、会话切换与后续对话续接

### 4.3 恢复责任归属

`sessionId` 的跨重启恢复由宿主侧可持久化能力承载。

即：

- 宿主侧能力负责承载 `sessionId` 与宿主实际会话之间的可恢复关系
- 插件负责使用该宿主能力恢复并维护映射
- gateway 不作为该映射关系的唯一恢复来源

## 5. 命令语义

### 5.1 `/new`

功能目标：

- 创建一个新的会话
- 创建成功后立即切换到该新会话

约束：

- `/new` 的语义是“新建并切换”
- `/new` 不应被定义为“重置当前会话”
- 原会话历史应保留，不应被清空
- `/new` 成功后，应形成新的用户可见 `sessionId`
- 后续消息默认进入该新的 `sessionId` 对应会话

### 5.2 `/sessions`

功能目标：

- 返回可供当前 bridge 场景切换的会话列表

列表范围约束：

- `/sessions` 返回当前宿主作用域下可供切换的会话列表
- 具体列表范围由宿主实现章节定义
- 宿主实现可以基于自身可见范围、会话绑定范围或其他宿主约束收口，但对外统一表现为“当前可切换会话目录”

用户视角要求：

- 用户可以从返回结果中识别每个会话对应的 `sessionId`
- 用户可以识别当前活跃会话

### 5.3 `/session <sessionid>`

功能目标：

- 将当前活跃会话切换到指定 `sessionId`

期望结果：

- 当 `sessionId` 有效时，后续消息进入该会话
- 当切换失败时，返回统一、可理解的失败提示
- 切换结果对后续对话立即生效

### 5.4 `/models`

功能目标：

- 返回宿主提供的模型列表，供用户查看与选择

约束：

- 模型列表来源于宿主
- 返回结果中的模型标识统一为 `providerId/modelId`
- 该列表是宿主模型目录视图
- 本需求不要求列表中的每个模型在切换后都保证可正常可用
- v1 返回宿主模型目录，不要求显示当前模型

用户视角要求：

- 用户可以从返回结果中识别每个模型的 `providerId/modelId`

### 5.5 `/model <providerId/modelId>`

功能目标：

- 将当前活跃会话的模型切换为指定 `providerId/modelId`

作用域约束：

- 仅影响当前活跃会话
- 仅对该会话的后续对话生效
- 不影响其他会话
- 不修改宿主默认模型
- 不定义为 bridge 用户级全局模型切换

期望结果：

- 当切换命令被接受时，后续消息按新的 `providerId/modelId` 设置进入该会话
- 当切换失败时，返回统一、可理解的失败提示

## 6. 一致性要求

虽然 OpenCode 与 OpenClaw 的宿主机制不同，但两侧插件在对外语义上应保持一致：

- 相同命令表达相同意图
- 相同命令产生相同类型的用户结果
- 对外统一使用 `sessionId` 作为宿主会话选择标识
- “当前会话”的含义在 bridge 场景中保持一致
- 会话列表、会话切换、模型列表、模型切换、失败反馈等行为语义尽量统一

## 7. 用户视角要求

从用户视角，以上命令应满足以下要求：

- 输入格式简单明确
- 成功时有清晰反馈
- 失败时有统一、可理解的失败提示
- 命令执行结果对后续对话行为稳定、可预期

用户无需了解宿主内部的 command 分类、session store、runtime 细节或 ID 映射方式。

## 8. 非目标

本需求当前不包含以下内容：

- 不要求扩展更多 slash command
- 不要求改造宿主原生命令帮助系统
- 不要求规定具体 UI 呈现形式
- 不要求规定具体协议字段设计
- 不要求规定具体状态存储结构
- 不要求规定 OpenCode 与 OpenClaw 各自的实现落点
- 不要求在本阶段统一宿主内部已有命令架构
- 不要求保证宿主模型列表中的每个模型切换后都一定可正常运行

## 9. 验收标准

满足以下条件可认为需求达成：

1. 在 `message-bridge` 中，`/new`、`/sessions`、`/session <sessionId>`、`/models`、`/model <providerId/modelId>` 均可被识别并产生预期业务结果。
2. 在 `message-bridge-openclaw` 中，上述五种命令均可被识别并产生预期业务结果。
3. `/new` 后，系统进入新建会话，形成新的 `sessionId`，且原会话历史保留。
4. `/sessions` 能返回当前宿主作用域下可供切换的会话列表。
5. `/session <sessionId>` 能切换到指定会话，并使后续消息进入该会话。
6. `/models` 能返回宿主提供的 `providerId/modelId` 列表。
7. `/model <providerId/modelId>` 仅影响当前活跃会话的后续对话，不影响其他会话或宿主默认模型。
8. 命令执行失败时，系统应返回统一、可理解的失败提示。失败提示至少应能够区分新建会话失败、会话列表获取失败、会话切换失败、模型列表获取失败、模型切换失败等命令意图层级。
9. 重启后，既有 `sessionId` 仍可用于列举、切换和续接原有会话。

## 10. 假设

- `sessionid` 在需求语义上等同于 slash command 层对用户暴露的宿主会话选择标识
- 宿主内部会话标识不属于对外契约
- 模型列表是宿主目录视图，不承诺切换后一定可运行
- 插件不要求自带独立持久化；跨重启恢复能力由宿主侧承载
