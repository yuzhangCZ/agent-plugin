# bridge-runtime-sdk 替换评估

**Version:** 1.0  
**Date:** 2026-05-16  
**Status:** Draft  
**Owner:** message-bridge maintainers  
**Related:** `./protocol-contract.md`, `./end-to-end-message-flow.md`, `../../migration/path-mapping.md`, `../../../../docs/design/interfaces/bridge-runtime-sdk-integration.md`, `../../../../docs/architecture/bridge-runtime-sdk-architecture.md`

## In Scope

1. 评估当前 `message-bridge` 与 `ai-gateway` 的协议交互是否可以由 `bridge-runtime-sdk` 无功能回归替换。
2. 明确不能直接替换时，哪些能力应补进 SDK public contract / Provider SPI / fact model / terminal result。
3. 明确哪些能力可以在 OpenCode 插件内闭环，不应误判为 SDK 缺口。
4. 按 `gateway-schema` 当前 `tool_event.event` 契约逐事件评估上行字段是否需要进入 SDK。

## Out of Scope

1. 不定义 SDK 或插件代码实现步骤。
2. 不修改 `ai-gateway`、`skill-server` 或 OpenCode 源码。
3. 不新增 PRD 冻结范围外的 gateway 协议字段。

## External Dependencies

1. `@wecode/bridge-runtime-sdk`
2. `@agent-plugin/gateway-schema`
3. OpenCode v2 SDK / API
4. `message-bridge` 当前冻结协议与实现

## 1. 目标与结论

本文只回答一个问题：当前 `message-bridge` 与 `ai-gateway` 的协议交互，能否直接切到 `bridge-runtime-sdk`。

结论：**按本文最初假设，当前不能直接替换；但基于当前仓内实现复核，原先列出的多数 SDK 缺口已补齐**。阻塞原因不再是 SDK 无法承接 `invoke.chat.context`、`permission_reply`、`question_reply`、`question.asked`、`permission.replied` 或 `session.title` 这些稳定语义，而主要收敛为一个待决策点：

1. `permission_reply` 成功后，是否应由 SDK 在命令成功路径上自动统一产出 `PermissionReplyFact`，还是继续要求 provider 在权限真正 resolved 时主动发出该 fact。

非阻塞项如下：

1. `directory`：OpenCode 会话目录解析、复用和 API 参数注入可以在插件内闭环。
2. `session_not_found`：`session.get` 探测和结构化证据判定可以在插件内闭环；SDK 需要通过 `ProviderError.code='session_not_found'` 表达该语义，并在 terminal `tool_error` 输出中携带 gateway-schema 的 `reason` 可选字段。
3. OpenCode raw event 字段路径读取：由插件 provider/adapter 完成；需要通知 gateway / skill-server / miniapp 的语义必须转换为 SDK 正式 `ProviderFact` 或 terminal result。
4. `message.updated` 大 payload 裁剪：若无下游消费证据，本轮不纳入 SDK contract；若需继续通知下游，必须补正式 fact 字段。
5. `suppressReply`：SDK 只需在 `invoke.chat.context` 中透传，是否短路真实 provider runMessage 由插件闭环处理。
6. `session.idle` 与 `tool_done` compat：`session.idle` 历史事件不再作为 SDK 替换必需输出；`tool_done` 完成态由 SDK terminal result 产出。

## 2. 职责边界与判定标准

### 2.1 职责边界

| 边界 | SDK 职责 | 插件职责 |
|---|---|---|
| 下行 command | 承接稳定 command input 和 Provider SPI | 把 gateway 兼容输入转换成 SDK command input |
| Provider facts | 定义跨 provider 稳定事实模型；所有 gateway 上行语义必须由正式 fact 或 terminal result 驱动 | 把 OpenCode raw event 解析成 SDK facts；无法映射为正式 fact 的事件不进入 SDK 上行 |
| 上行输出 | 基于正式 fact / terminal result 统一投影、校验、发送 gateway 上行 | 不支持 OpenCode raw event 透传，也不允许插件直接发送 gateway 消息 |
| Provider API | 不关心 OpenCode 专用 API 参数细节 | 注入 `directory`、workspace、OpenCode direct reply 参数 |
| 错误分类 | 通过 provider error / terminal failed 承载结构化错误语义 | 执行 `session.get` 探测，并在进入 SDK 前转换为结构化错误字段 |

### 2.2 字段来源分层

| 来源 | 作用 | 说明 |
|---|---|---|
| `gateway-schema` `opencode-provider-event` | 当前 `tool_event.event` 外部兼容 shape | 字段存在不代表必须进入 SDK fact |
| OpenCode v2 SDK / API | provider 原始事实来源 | 若字段只存在于 OpenCode v2，应标注“OpenCode 原始字段，当前 `gateway-schema` 未承接” |
| `bridge-runtime-sdk` `ProviderFact` / command contract | SDK 稳定事实和 public contract 目标 | 所有需通知 gateway / skill-server / miniapp 的上行语义必须落入该层 |
| `message-bridge` 当前实现 | 兼容行为和运行时策略来源 | 包括 directory、subagent 映射、完成态兼容策略、错误 reason 分类 |

### 2.3 结论判定标准

| 结论 | 判定标准 | 典型证据 |
|---|---|---|
| `SDK 已满足` | 该行评估项的全部必要稳定语义都能映射到现有 SDK command / fact / terminal 字段 | 可直接映射到 `ProviderRunMessageInput.*`、`TextDeltaFact.*`、`SessionErrorFact.*` 等 |
| `SDK 需补充` | 该行评估项需要通知 gateway / skill-server / miniapp，或是跨 provider 稳定语义 / runtime 行为，但当前 SDK 缺少明确 contract、fact、policy 或 terminal 字段；不补会丢失行为或交互能力 | 例如新的 direct reply target、尚未建模的权限 resolved 统一策略、未收敛的终态错误语义等 |
| `插件闭环` | 该行评估项只在进入 SDK 前、调用 provider API 前或插件内部策略中完成；不产生 SDK fact，不产生 gateway 上行事件 | `directory`、`suppressReply` provider run 短路、插件基于 context 的 permission 管控、OpenCode raw event 字段路径读取、OpenCode direct reply 参数转换、`message.part.delta` part type 判定 |
| `待确认` | 字段可能是 SDK 稳定语义，也可能可由插件闭环；必须写明缺少的证据和改判方向 | 尚未确认下游消费或 provider 行为语义的字段 |
| `不纳入` | 字段既不是 SDK 稳定语义，也没有已证实的 gateway 输出兼容要求；纳入 SDK 会扩大稳定 contract | 无外部兼容证据的 OpenCode 内部生命周期字段 |

结论列必须只填写上表中的一个状态。若同一消息或事件同时包含多个判断，应拆成多行，不能写成复合结论；闭环方式、消费证据和风险写入说明列。

硬规则：

1. 需要通知 gateway / skill-server / miniapp 的字段或事件，必须是 `SDK 已满足` 或 `SDK 需补充`；不能用 `插件闭环` 承接。
2. 消费关系必须有证据，不能凭猜测判断 ai-gateway、skill-server 或 miniapp 是否消费。
3. 某字段能映射到 SDK fact 只证明该字段 `SDK 已满足`，不代表整个 raw event `SDK 已满足`。
4. 只有当字段参与跨 provider runtime 语义、command target、交互回复、终态判定或错误归因时，才应纳入 SDK contract / fact。
5. SDK contract 先收紧后放开：只有当前替换必需、且有 gateway/bridge 输入来源或下游消费证据的字段才纳入；provider API 可选字段不因存在而自动进入 SDK contract。
6. 不支持 OpenCode raw event 透传，不支持 provider 私有上行扩展，也不允许插件直接发送历史 `tool_event`。
7. `插件闭环` 必须写清闭环位置，且只能是进入 SDK 前、调用 provider API 前或插件内部策略；不得表示 gateway 上行兼容输出。

## 3. 下行替换评估

| Gateway 消息 | 评估项 | 当前关键字段 | SDK 当前能力 | 结论 | 说明 |
|---|---|---|---|---|---|
| `status_query` | 状态查询 | 无额外业务字段 | `RuntimeCommand.kind='query_status' -> health({ traceId })` | `SDK 已满足` | `status_response.opencodeOnline` 可由 SDK 现有结果投影承接 |
| `invoke.create_session` | 基础建会字段 | `welinkSessionId`、`payload.title`、`payload.assistantId` | SDK 已有 `title/assistantId`；`welinkSessionId` 只用于 gateway 回包上下文 | `SDK 已满足` | `welinkSessionId` 不进入 provider input |
| `invoke.create_session` | `permission` 注入结果 | 群聊上下文派生 deny 列表 | SDK 不建模 permission 管控策略 | `插件闭环` | 闭环位置：adapter/action。permission 管控由插件基于 `invoke.chat.context`、群聊上下文和 OpenCode provider 能力自行完成，不进入 SDK create-session contract；服务端/前端不消费该 deny 列表作为独立协议字段 |
| `invoke.create_session` | `directory` | OpenCode 会话目录 | SDK 不建模 directory | `插件闭环` | 闭环位置：adapter/action。目录解析、复用和 OpenCode API 参数注入由插件完成；当前证据只要求 OpenCode provider 调用正确，不要求服务端或前端感知 directory 字段 |
| `invoke.chat` | 基础聊天字段 | `toolSessionId`、`text`、`assistantId` | SDK 已有 `toolSessionId/text/assistantId` | `SDK 已满足` | `assistantId` 保留顶层，作为 provider agent selector |
| `invoke.chat` | 业务上下文 | `assistantAccount`、`sendUserAccount`、`imGroupId`、`suppressReply` | SDK 已有 typed `context` 并透传到 provider SPI | `SDK 已满足` | `context: { assistantAccount?, sendUserAccount?, imGroupId?, suppressReply? }` 已进入 `ProviderRunMessageInput`；其中 `suppressReply` 仍只透传给插件 |
| `invoke.chat` | 回复抑制策略 | `suppressReply` | SDK 不内建 provider run 短路策略 | `插件闭环` | 闭环位置：adapter/action。SDK 透传字段，插件基于该字段自行决定是否调用真实 provider `runMessage`，不要求 SDK runtime 建模 pre-run policy |
| `invoke.permission_reply` | direct reply target | 当前 bridge `permissionId + response` | SDK 已使用 `permissionId + reply` | `SDK 已满足` | runtime intake 继续消费 gateway `response`，进入 provider SPI 前归一为 `reply`；OpenCode provider 内部把 `permissionId` 映射到 `requestID` |
| `invoke.question_reply` | direct reply target | 当前 bridge `questionId + answers` | SDK 当前使用 `questionId + answers: string[][]` | `SDK 已满足` | gateway 下行优先使用 `answers`；仅 legacy 单字符串 `answer` 在 runtime intake 归一为 `answers: [[answer]]` |
| `invoke.close_session` | 关闭会话 | `toolSessionId` | `ProviderCloseSessionInput.toolSessionId` | `SDK 已满足` | 无额外 SDK contract 缺口 |
| `invoke.abort_session` | 终止会话 | `toolSessionId`、runtime 派生 `runId` | `ProviderAbortSessionInput.toolSessionId/runId?` | `SDK 已满足` | `runId` 由 SDK runtime 管理 |

### 3.1 `invoke.chat` 目标 contract

```ts
interface ProviderRunMessageInput {
  traceId: string;
  runId: string;
  toolSessionId: string;
  text: string;
  assistantId?: string;
  context?: {
    assistantAccount?: string;
    sendUserAccount?: string;
    imGroupId?: string;
    suppressReply?: boolean;
  };
}
```

`assistantId` 保留在顶层，因为它是 provider agent selector。`assistantAccount/sendUserAccount/imGroupId` 是上游业务上下文，进入 typed `context`，不使用无结构 `metadata`。`suppressReply` 暂时作为 `context` 透传字段，由插件侧自行短路真实 provider `runMessage`；SDK 不内建该策略。

### 3.2 `permission_reply` 目标 contract

```ts
interface ProviderPermissionReplyInput {
  traceId: string;
  permissionId: string; // maps to OpenCode requestID
  reply: 'once' | 'always' | 'reject';
}
```

OpenCode v2 direct reply 目标是 `POST /permission/{requestID}/reply`，body 为 `{ reply, message? }`。SDK public contract 使用 `permissionId + reply`：`permissionId` 保持当前 gateway / bridge 外部命名，在 OpenCode provider 内部映射到 `requestID`；`response` 只作为兼容输入命名，进入 SDK 前转换为 `reply`。OpenCode API 的 `message` 是可选字段，但当前 `gateway-schema` / `message-bridge` 下行 `permission_reply` 没有输入来源，也没有服务端或前端消费证据，本轮不纳入 SDK contract。SDK 当前 `toolSessionId` 依赖应移除。

### 3.3 `question_reply` 目标 contract

```ts
type QuestionAnswer = string[];

interface ProviderQuestionReplyInput {
  traceId: string;
  questionId: string; // maps to OpenCode requestID
  answers: QuestionAnswer[];
}
```

OpenCode `Question.Answer = string[]`，`Question.Reply = { answers: QuestionAnswer[] }`。`answers` 按 `questions[]` 顺序排列；每个问题的答案数组可表达单选、多选和自定义输入。`message-bridge` 内部和 OpenCode 调用链路使用 `answers: string[][]`；legacy `answer: string` 只在 gateway-schema 输入兼容层折叠为 `answers: [[answer]]`。

## 4. 上行事件替换评估

上行评估以 `gateway-schema` 当前 `opencode-provider-event` union 为事件清单，只评估 `OpenCode raw event / gateway-schema opencode-provider-event -> SDK ProviderFact / contract`。切换 SDK 后，所有 gateway 上行必须由 SDK 正式 `ProviderFact` 或 terminal result 驱动；历史 OpenCode raw event shape 若无正式 SDK fact 承载则不保留。

### 4.1 `tool_event` envelope

| 字段 | 当前 gateway 契约 | SDK 能力 | 结论 | 说明 |
|---|---|---|---|---|
| `type='tool_event'` | 上行业务 envelope | SDK 统一上行输出 | `SDK 已满足` | envelope 类型可承接 |
| `toolSessionId` | envelope 会话字段 | SDK `ToolEventMessage.toolSessionId` | `SDK 已满足` | envelope 会话归属可承接 |
| `event` | 当前可为 OpenCode canonical shape | SDK 默认输出正式 skill event / gateway event；历史 OpenCode raw shape 不作为独立 contract 保留 | `SDK 已满足` | envelope 由 SDK 承接；具体 `event` 只能来自正式 fact / terminal result 的投影，不支持 OpenCode raw event 透传 |

### 4.2 事件级评估表

| OpenCode event | gateway-schema 字段 | SDK ProviderFact / contract 目标 | 结论 | 说明 |
|---|---|---|---|---|
| `message.updated` | `properties.info.sessionID` | `MessageStartFact.toolSessionId` 或 `MessageDoneFact.toolSessionId` | `SDK 已满足` | 会话归属字段已可由消息 facts 承载 |
| `message.updated` | `properties.info.id` | `MessageStartFact.messageId` 或 `MessageDoneFact.messageId` | `SDK 已满足` | 消息标识已可由消息 facts 承载 |
| `message.updated` | `properties.info.finish.reason` | `MessageDoneFact.reason` | `SDK 已满足` | 完成原因可进入 message done fact |
| `message.updated` | `properties.info.role` | 无对应 SDK fact 字段 | `不纳入` | `role=user` 是历史 OpenCode echo 兼容逻辑；`skill-server` 已在入站链路保存用户消息并广播 `message.user`，`GatewayMessageRouter` 明确丢弃 user echo。SDK 切换后用户消息不依赖 provider 上行回放 |
| `message.updated` | `properties.info.time` | 无对应 SDK fact 字段 | `不纳入` | 下游流协议的 `emittedAt` 由服务端发送时生成，不需要承接 OpenCode message time |
| `message.updated` | `properties.info.model` | 无对应 SDK fact 字段 | `不纳入` | 当前无证据表明 skill-server / miniapp 基于 message model 做交互；模型选择属于下行或会话策略，不因 OpenCode raw 字段存在进入 SDK fact |
| `message.updated` | `properties.info.summary` | 无对应 SDK fact 字段 | `不纳入` | 历史测试只证明旧 `message.updated` 传输会裁剪 summary，不证明 SDK 替换后仍需通知下游；若后续确认前端需要 diff 摘要，应补正式 message summary fact |
| `message.part.updated` | `properties.part`，按 `part.type` 展开，见第 4.3 节 | 见第 4.3 节逐字段承载关系 | `SDK 已满足` | 本轮支持范围内已满足：`text/reasoning/tool/step-start/step-finish` 已有正式 fact 承接；`file` 暂不支持并明确不纳入；question tool part 不在该事件评估 |
| `message.part.delta` | `properties.sessionID` | `TextDeltaFact.toolSessionId` 或 `ThinkingDeltaFact.toolSessionId` | `SDK 已满足` | 会话归属字段已可由文本或 thinking 增量 fact 承载 |
| `message.part.delta` | `properties.messageID` | `TextDeltaFact.messageId` 或 `ThinkingDeltaFact.messageId` | `SDK 已满足` | 消息归属字段已可由文本或 thinking 增量 fact 承载 |
| `message.part.delta` | `properties.partID` | `TextDeltaFact.partId` 或 `ThinkingDeltaFact.partId` | `SDK 已满足` | part 归属字段已可由文本或 thinking 增量 fact 承载 |
| `message.part.delta` | `properties.delta` | `TextDeltaFact.content` 或 `ThinkingDeltaFact.content` | `SDK 已满足` | 增量内容字段已可由文本或 thinking 增量 fact 承载 |
| `message.part.delta` | `properties.field` + `partID -> part.type` | 无对应 SDK fact 字段 | `插件闭环` | 闭环位置：provider adapter。OpenCode delta 的 `field` 当前只允许 `text`，不能区分正文和 reasoning；插件必须通过 `partID` 查到对应 part 的 `type`，`part.type='text'` 时产出 `TextDeltaFact`，`part.type='reasoning'` 时产出 `ThinkingDeltaFact`。该判定不进入 SDK stable fact |
| `message.part.removed` | `properties.sessionID/messageID/partID` | 无对应 SDK fact 字段 | `不纳入` | 当前无 SDK stable fact 语义、无服务端/前端消费场景、无继续输出兼容需求；SDK provider adapter 可以忽略该 OpenCode raw event，不定义 remove fact |
| `session.status` | `properties.sessionID/status.type` | 无对应 SDK fact 字段 | `不纳入` | OpenCode 状态机展示信号，不是 provider fact 必需字段 |
| `session.idle` | `properties.sessionID` | 无对应 SDK fact 字段 | `不纳入` | 仅用于旧 `tool_event(session.idle)` 输出时不纳入；`tool_done` 完成态由 SDK terminal result 承接。若后续确认 miniapp 需要 session idle 状态，应补正式 `SessionStatusFact` |
| `session.updated` | `properties.sessionID/info.id/info.title` | `SessionTitleFact.toolSessionId/title` | `SDK 已满足` | `opencode-cui` 已证明 `session.updated.info.title -> session.title -> miniapp updateSessionTitle` 是有效下游消费链路；当前 SDK 已有 `{ type: 'session.title', toolSessionId, title }` fact 与 projector |
| `session.error` | `properties.sessionID` | `SessionErrorFact.toolSessionId` | `SDK 已满足` | 错误归属字段已可承载 |
| `session.error` | `properties.error` | `SessionErrorFact.error` | `SDK 已满足` | 错误内容已可承载 |
| terminal `tool_error` | `session_not_found` 分类与 `tool_error.reason` | `ProviderError.code='session_not_found'` -> `ToolErrorMessage.reason='session_not_found'` | `SDK 已满足` | `gateway-schema` 已定义 `tool_error.reason?: 'session_not_found'`，`skill-server` 会基于该字段触发会话重建；插件负责识别 stale session 并构造 `ProviderError.code`，SDK 已在统一 terminal projector 输出 `reason` |
| `permission.updated` | `properties.sessionID/id/messageID/type/title/metadata/status/response/resolved` | 无对应 SDK fact 字段 | `不纳入` | 收紧原则：OpenCode raw `permission.updated/status` 不作为 SDK 权限 resolved 来源；权限 resolved 统一由 `PermissionReplyFact` 表达 |
| `permission.asked` | gateway-schema 字段见第 4.4 节 | 见第 4.4 节逐字段承载关系 | `SDK 已满足` | 当前 SDK 已有 `PermissionAskFact`；本节只评估 gateway-schema 字段到现有 fact 的承载关系 |
| `permission.replied` | `properties.sessionID` | `PermissionReplyFact.toolSessionId` | `SDK 已满足` | 当前 SDK 已有会话归属字段，可用于通知 gateway 权限卡片已处理 |
| `permission.replied` | `properties.requestID` | `PermissionReplyFact.permissionId` | `SDK 已满足` | OpenCode `requestID` 在 SDK fact 中统一命名为 `permissionId`，用于匹配已有权限卡片 |
| `permission.replied` | `properties.reply` | `PermissionReplyFact.response` | `SDK 已满足` | `reply` 归一为 `once/always/reject` 后进入 `PermissionReplyFact.response`；当前 projector 已可投影该 resolved 事件 |
| `question.asked` | gateway-schema 字段见第 4.5 节 | 见第 4.5 节逐字段承载关系 | `SDK 已满足` | `questionId` 与完整 `questions[]` 已进入正式 fact，且 SDK public contract 已收紧为 `questions[]` 真源 |

### 4.3 `message.part.updated` 按 `part.type` 展开

| `part.type` | gateway-schema 字段 | SDK ProviderFact / contract 目标 | 结论 | 理由 |
|---|---|---|---|---|
| `text` | `id/sessionID/messageID/text` | `TextDoneFact.partId/toolSessionId/messageId/content` | `SDK 已满足` | 现有 SDK 已有 text done fact；插件只需把 OpenCode full part updated 规范化为 `TextDoneFact` |
| `reasoning` | `id/sessionID/messageID/text` | `ThinkingDoneFact.partId/toolSessionId/messageId/content` | `SDK 已满足` | 现有 SDK 已有 thinking done fact；与 `message.part.delta` 的 `ThinkingDeltaFact` 形成增量/完成闭环 |
| `tool`（通用 tool update） | `id/sessionID/messageID/tool/callID/state.status/state.title/state.output/state.error` | `ToolUpdateFact.partId/toolSessionId/messageId/toolName/toolCallId/status/title/output/error` | `SDK 已满足` | 仅评估普通工具调用状态；OpenCode question 交互以独立 `question.asked` 事件进入 SDK，不从 question tool part 推导 SDK fact |
| `step-start` | `id/sessionID/messageID` | `MessageStartFact.toolSessionId/messageId` | `SDK 已满足` | SDK 已用 `MessageStartFact` 投影 `step.start`；OpenCode part `id` 不参与当前下游语义 |
| `step-finish` | `id/sessionID/messageID/tokens/cost/reason` | `MessageDoneFact.toolSessionId/messageId/tokens/cost/reason` | `SDK 已满足` | `step.done` 的 reason/tokens/cost 可由现有 `MessageDoneFact` 承接 |
| `file` | `id/sessionID/messageID/filename/url/mime` | 无对应 SDK fact 字段 | `不纳入` | 本轮 SDK 替换暂不支持 file 展示，不定义对应 SDK fact；后续如重新要求 file 能力，再单独评审 |

### 4.4 `permission.asked` 字段来源分层

| OpenCode event | gateway-schema 字段 | SDK ProviderFact / contract 目标 | 结论 | 说明 |
|---|---|---|---|---|
| `permission.asked` | `properties.sessionID` | `PermissionAskFact.toolSessionId` | `SDK 已满足` | 权限请求会话归属已有 fact 字段承载 |
| `permission.asked` | `properties.partID/partId` | `PermissionAskFact.partId` | `SDK 已满足` | `partId` 已独立进入 fact；只表示消息组成部分的稳定分片 ID |
| `permission.asked` | `properties.id` | `PermissionAskFact.permissionId` | `SDK 已满足` | 当前 gateway-schema 使用 `id`，进入 SDK fact 时统一命名为 `permissionId` |
| `permission.asked` | `properties.toolCallId` | 无 | `不纳入` | `permission.ask` 共享 contract 已移除 `toolCallId`；正式标识仅保留 `permissionId` |
| `permission.asked` | `properties.messageID` | `PermissionAskFact.messageId` | `SDK 已满足` | 用于关联触发权限请求的消息 |
| `permission.asked` | `properties.type` | `PermissionAskFact.permissionType` | `SDK 已满足` | gateway-schema `type` 可映射到现有 `permissionType` |
| `permission.asked` | `properties.title` | `PermissionAskFact.title` | `SDK 已满足` | title 已提升为 typed 展示字段，不再依赖 `metadata.title` |
| `permission.asked` | `properties.metadata` | `PermissionAskFact.metadata` | `SDK 已满足` | provider 附加上下文，作为 metadata 透传 |
| `permission.asked` | `properties.status` / `properties.response` / `properties.resolved` | 无对应 SDK fact 字段 | `不纳入` | `permission.asked` 初始事件不应携带已处理状态；状态变化由 `permission.replied -> PermissionReplyFact` 表达 |

### 4.5 `question.asked` 字段评估

| OpenCode event | gateway-schema 字段 | SDK ProviderFact / contract 目标 | 结论 | 说明 |
|---|---|---|---|---|
| `question.asked` | `properties.sessionID` | `QuestionAskFact.toolSessionId` | `SDK 已满足` | 问题请求会话归属已有 fact 字段承载 |
| `question.asked` | `properties.id` | `QuestionAskFact.questionId` | `SDK 已满足` | `questionId` 已成为稳定 direct reply target，并要求全局唯一 |
| `question.asked` | `properties.questions[0].question` / `properties.questions[0].header` | `QuestionAskFact.questions[0].question/header` | `SDK 已满足` | `skill-server` 当前通过 `resolveQuestionPayload` 只取第一个问题；展示层可直接从 `questions[0]` 读取，不再依赖 SDK 平铺快捷字段 |
| `question.asked` | `properties.questions[0].options[].label` | `QuestionAskFact.questions[0].options[]` | `SDK 已满足` | `gateway-schema` 当前 options 只保留 `label`，`skill-server` 也只提取 label 列表；SDK 以 `questions[]` 为唯一真源 |
| `question.asked` | `properties.questions[]` | `QuestionAskFact.questions[]` | `SDK 已满足` | `questions[]` 已成为正式真源；SDK public contract 不再要求平铺 `question/header/options` 字段 |
| `question.asked` | `properties.tool.messageID` / `properties.tool.callID` | 无对应 SDK fact 字段 | `不纳入` | question 回复目标以 `properties.id -> QuestionAskFact.questionId` 为准；当前没有证据表明下游仍需要 `messageID/callID` 关联字段，SDK 不为可选 tool ref 扩大 contract |

`questions[]` 的每个元素至少包含 `question/header/options[]`，其中当前 `gateway-schema` 的 `options[]` 元素只保留 `label`。SDK 目标模型必须保留多问题、多选和自定义输入兼容性；下行回复以 `answers: string[][]` 为真源。

## 5. SDK 待决策清单

1. `permission_reply` 成功路径是否由 SDK 自动补发 `PermissionReplyFact`  
   当前 SDK 已具备 `PermissionReplyFact`、对应 projector 与 gateway-schema 承接能力，也支持 provider 主动上报 `permission.reply`。仍待决策的是：用户下行 `permission_reply` 成功后，是否应由 SDK 在命令成功路径自动统一生成 resolved fact，还是继续要求 provider 在权限真正 resolved 时主动发出该 fact。若选择前者，需同步定义与 provider 主动上报之间的幂等 / 去重边界。

## 6. 插件闭环 / 非 SDK 缺口清单

1. `directory` 解析、复用和 OpenCode API 参数注入：闭环位置为 adapter/action；当前没有服务端/前端消费 directory 字段的证据。
2. 插件基于 context 的 permission 管控：闭环位置为 adapter/action；SDK 只需要承接 `invoke.chat.context`，不定义 permission deny 列表或 OpenCode permission 注入策略。
3. `suppressReply` 回复抑制策略：闭环位置为 adapter/action；SDK 只透传 `context.suppressReply`，插件决定是否调用真实 provider `runMessage`。
4. `session_not_found` 前置探测和结构化证据判定：闭环位置为 adapter/action；插件把探测结果转换为 SDK `ProviderError.code='session_not_found'`，不直接对接 gateway `tool_error.reason`。
5. OpenCode raw event 字段路径读取：闭环位置为 provider adapter；SDK 只接收规范化 facts。
6. `message.part.delta` 的 `partID -> part.type` 判定：闭环位置为 provider adapter；只用于选择 `TextDeltaFact` 或 `ThinkingDeltaFact`，不直接产生 gateway 上行。
7. `message.part.removed/session.status/session.idle` raw event 存在本身：当前无证据表明需要继续作为 gateway 上行输出，也不参与 SDK 稳定语义；若后续发现服务端/前端消费，应改判为 `SDK 需补充`。

## 7. 验收标准

1. 开头章节必须能直接回答是否可替换、阻塞项、非阻塞项和职责边界。
2. 上行章节必须覆盖 `gateway-schema` 当前 12 个 OpenCode provider event。
3. 每个上行事件必须给出单一结论状态：`SDK 已满足`、`SDK 需补充`、`插件闭环`、`待确认` 或 `不纳入`。
4. 每个 SDK 缺口必须给出目标 contract 形态或待决字段范围。
5. `permission.asked` 只以当前 `gateway-schema` 字段为评估对象，不纳入 OpenCode v2 原始字段扩展讨论。
