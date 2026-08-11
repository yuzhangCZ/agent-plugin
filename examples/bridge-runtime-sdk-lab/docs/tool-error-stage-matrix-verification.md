# Bridge Runtime SDK Lab tool_error stage matrix 验证步骤

Version: 1.0
Date: 2026-08-04
Status: Active
Owner: bridge-runtime-sdk maintainers

Related:

- ../../../docs/design/bridge-runtime-sdk-tool-error-stage-matrix.md
- ./lab-guide.md

## 1. 文档目的

本文用于说明如何使用 Bridge Runtime SDK Lab 验证 `docs/design/bridge-runtime-sdk-tool-error-stage-matrix.md` 中 `4.2.1` 的本轮纳入范围场景。

本轮验证范围不包含 `request_terminal` 和 `outbound_terminal` 两类 stage。对应场景从本文步骤中移除，不作为实验室验证项。

验证结论分为：

- 可直接验证：实验室已有 Stage Matrix Lab 场景或按钮，可以闭环看到下行、Provider 调用、gateway uplink、`tool_error`。
- 可间接验证：实验室已有底层能力，但需要真实 gateway、宿主侧交互、Manual Agent Report，或需要按顺序组合多个操作。
- 当前不能直接验证：实验室缺少专用场景、动态 raw 注入、Fake driver 或 mock facts 编排能力。此类场景会说明原因和建议改造方向。

## 2. 通用前置条件

优先使用 Mock 模式验证 stage 矩阵：

1. 启动 runtime-host 和 web：

   ```bash
   pnpm --dir examples/bridge-runtime-sdk-lab/apps/runtime-host dev
   pnpm --dir examples/bridge-runtime-sdk-lab/apps/web dev
   ```

2. 打开 `http://127.0.0.1:5174/`。
3. 在左侧模式面板选择 `Mock`。
4. 点击 `初始化`。
5. 点击 `启动`。
6. 确认 Runtime 状态进入 ready 或可解释状态。

主要观察面板：

- `Gateway Downstream`：观察 gateway -> SDK 的下行原始报文和 SDK 处理摘要。
- `SDK -> Agent`：开启 mock agent 时观察 SDK 调用 Provider 的输入。
- `Stage Matrix Lab / Gateway Uplink`：观察 SDK -> gateway 的完整上行。
- `Stage Matrix Lab / Tool Error`：观察本次矩阵场景匹配到的 `tool_error`。
- 右侧 `事件流`：筛选 `onMessage` 或 `sendMessage`，观察完整链路事件。
- `最近结果`：观察 API 返回和异常。

## 3. 4.2.1 场景验证矩阵

| 序号 | stage | 4.2.1 场景 | 当前实验室结论 | 推荐验证入口 | 预期 |
|---|---|---|---|---|---|
| 1 | `inbound_invalid` | 入站 `invoke` 协议校验失败 | 可直接验证 | `invalid-chat-missing-text`、`invalid-chat-empty-text`、`invalid-slash-missing-trace`、`invalid-ext-parameters` | 上行 `tool_error`，error 包含 `请求格式异常，请稍后重试`；字段非法时包含 `invalid_field_value: ...` |
| 2 | `command_failure` | unsupported invoke action | 可直接验证 | `unsupported-invoke-action` | 上行 `tool_error`，error 包含“不支持” |
| 3 | `command_failure` | 新建会话失败 | 可直接验证 | `create-session-provider-throws` | 上行 `tool_error`，error 包含 `SDK lab configured createSession failure` |
| 4 | `command_failure` | 发送消息启动失败 | 可直接验证 | `chat-provider-throws` | 上行 `tool_error`，error 包含 `SDK lab configured runMessage failure` |
| 5 | `command_failure` | 同会话重复发送 | 当前不能直接验证 | 需要 Fake driver 或 core-level 并发注入 | 上行 `tool_error`，error 为“当前会话正在处理中，请稍后再试” |
| 6 | `command_failure` | question 回复 pending 不存在 | 可直接验证 | `question-reply-pending-missing` | 上行 `tool_error`，error 包含“当前交互已失效” |
| 7 | `command_failure` | question 回复 Provider 抛错 | 可直接验证 | `question-reply-provider-throws` | 上行 `tool_error`，error 包含 `SDK lab configured replyQuestion failure` |
| 8 | `command_failure` | permission 回复 pending 不存在 | 可直接验证 | `permission-reply-pending-missing` | 上行 `tool_error`，error 包含“当前交互已失效” |
| 9 | `command_failure` | permission 回复 Provider 抛错 | 可直接验证 | `permission-reply-provider-throws` | 上行 `tool_error`，error 包含 `SDK lab configured replyPermission failure` |
| 10 | `command_failure` | 关闭会话失败 | 可直接验证 | `close-session-provider-throws` | 上行 `tool_error`，error 包含 `SDK lab configured closeSession failure` |
| 11 | `command_failure` | 中止执行失败 | 可直接验证 | `abort-session-provider-throws` | 上行 `tool_error`，error 包含 `SDK lab configured abortSession failure` |
| 12 | `command_failure` | request terminal Promise reject | 可直接验证 | `chat-result-reject` | 上行 `tool_error`，error 包含 `ProviderRun.result rejection` |
| 13 | `request_lifecycle` | request facts 生命周期非法 | 可直接验证 | `chat-invalid-facts` | 上行 `tool_error`，error 包含“当前请求处理失败” |
| 14 | `request_lifecycle` | request pending interaction 冲突 | 可直接验证 | `question-pending-interaction-conflict`、`permission-pending-interaction-conflict` | 上行 `tool_error`，error 包含“当前请求处理失败” |

## 4. 可直接验证场景步骤

### 4.1 入站 `invoke` 协议校验失败

覆盖场景：序号 1。

步骤：

1. 按通用前置条件切换到 Mock 模式并启动 runtime。
2. 在 `Stage Matrix Lab` 选择以下任一场景：
   - `chat 缺少 text`
   - `chat text 为空`
   - `query_slash_commands 缺少 traceId`
   - `extParameters.platformExtParam 非 JSON object`
3. 点击 `运行矩阵场景`。
4. 在 `Gateway Downstream` 查看 mock gateway 发送的非法下行报文。
5. 在 `Tool Error` 查看 `error` 是否包含 `请求格式异常，请稍后重试`。
6. 对 `chat 缺少 text` 或 `chat text 为空`，继续确认 `error` 包含 `invalid_field_value: payload.text`。
7. 在 `Gateway Uplink` 或右侧事件流 `sendMessage` 查看完整 `tool_error` 上行。

不能验证的变体：

- 如果非法 frame 同时缺少 `toolSessionId` 和 `welinkSessionId`，SDK 无法构造可路由 `tool_error`。该变体可用 `非法 invoke 无路由目标` 验证为 `failure_only`，不属于“通过 5 类 stage 上报”的闭环场景。

### 4.2 unsupported invoke action

覆盖场景：序号 2。

步骤：

1. 在 Mock 模式启动 runtime。
2. 在 `Stage Matrix Lab` 选择 `unsupported invoke action`。
3. 点击 `运行矩阵场景`。
4. 在 `Gateway Downstream` 确认下行动作为 `rename_session`。
5. 在 `Tool Error` 确认 stage 为 `command_failure`，error 包含“不支持”或 `unsupported_action` 语义。
6. 在右侧事件流筛选 `sendMessage`，确认完整上行报文类型为 `tool_error`。

### 4.3 新建会话失败

覆盖场景：序号 3。

步骤：

1. 在 Mock 模式启动 runtime。
2. 在 `Stage Matrix Lab` 选择 `create_session Provider 抛错`。
3. 点击 `运行矩阵场景`。
4. 在 `SDK -> Agent` 或事件流中确认 SDK 调用了 `provider.createSession()`。
5. 在 `Tool Error` 确认 stage 为 `command_failure`，error 包含 `SDK lab configured createSession failure`。
6. 在 `Gateway Uplink` 确认 `tool_error` 带有 `welinkSessionId`。

### 4.4 发送消息启动失败

覆盖场景：序号 4。

步骤：

1. 在 Mock 模式启动 runtime。
2. 在 `Stage Matrix Lab` 选择 `chat Provider 抛错`。
3. 点击 `运行矩阵场景`。
4. 在 `SDK -> Agent` 确认 SDK 调用了 `provider.runMessage()`，且输入包含 `toolSessionId` 和用户文本。
5. 在 `Tool Error` 确认 stage 为 `command_failure`，error 包含 `SDK lab configured runMessage failure`。
6. 在 `Gateway Uplink` 确认 `tool_error.toolSessionId` 与下行 payload 一致。

### 4.5 同会话重复发送

覆盖场景：序号 5。

当前不能通过 Stage Matrix Lab 直接验证。

原因：

1. `run_already_active` 要求同一 `toolSessionId` 的第一轮 request run 尚未释放时，第二条 chat 已进入 `StartRequestRunUseCase`。
2. 当前 MockGateway 通过 gateway-client 下发业务消息，实际处理链路会串行透传下行；第二条 chat 会等第一条处理完成后再进入 SDK，无法稳定构造 active run 冲突。
3. 即使在 TestProvider 内部尝试 reentrant 注入第二条下行，也仍会被 gateway-client 串行化，不能产生预期 `tool_error`。

可改造方向：

1. 增加 Fake driver 验证入口，绕过 gateway-client 的串行消息派发，直接并发触发 SDK runtime driver handler。
2. 或增加 core-level test harness，直接并发调用 `start_request_run` usecase。
3. 改造完成后新增 `chat-run-already-active` 矩阵场景，预期 stage 为 `command_failure`，error 包含“当前会话正在处理中”。

### 4.6 question 回复 pending 不存在

覆盖场景：序号 6。

Mock 快速验证步骤：

1. 在 Mock 模式启动 runtime。
2. 在 `Stage Matrix Lab` 选择 `question_reply pending 不存在`。
3. 点击 `运行矩阵场景`。
4. 在 `Gateway Downstream` 确认下行动作为 `question_reply`，`questionId` 为不存在的 ID。
5. 在 `Tool Error` 确认 stage 为 `command_failure`，error 包含“当前交互已失效”。

真实 gateway + 手动上报验证步骤：

1. 切换到真实 gateway。
2. 点击 `初始化` 和 `启动`。
3. 开启 `手动 ProviderFact 上报`。
4. 让宿主用户发送一条 chat 消息，使 SDK 调用 `runMessage()` 并在 Manual Agent Report 出现 active run。
5. 在 Manual Agent Report 选择 `message.start` 并上报。
6. 选择 `question.ask`，确认 `questionId`，必要时编辑问题内容后上报。
7. 在宿主侧确认 question 卡片已经展示。
8. 在实验室点击 `停止`，再点击 `启动`；如需要更彻底清空本地 pending 状态，可执行 `停止` -> `初始化` -> `启动`。
9. 在宿主侧回复刚才的 question 卡片。
10. 在 `Gateway Downstream` 或右侧事件流筛选 `onMessage`，确认 SDK 收到 `question_reply` 下行。
11. 如果真实 `question_reply` 下行没有携带 `toolSessionId` 或 `welinkSessionId`，预期只在 `Gateway Downstream` 看到 `phase=failed`，`code=pending_interaction_not_found`，`error=question interaction not found`；此时不会再上行 `tool_error`。
12. 只有当真实 `question_reply` 下行具备可回包路由目标时，才继续在 `Tool Error`、`Gateway Uplink` 或右侧事件流筛选 `sendMessage`，确认上行 `tool_error`，error 包含“当前交互已失效”。

说明：

- 该场景验证的是 `InteractionCoordinator.consume()` 找不到 pending question 后的失败收口。
- 真实 gateway 路径模拟的是：宿主侧仍保留旧 question 卡片，但 SDK 重启后本地 pending registry 已丢失，用户再回复时触发 `pending_interaction_not_found`。
- Mock 矩阵场景会显式在 `question_reply` 下行中携带 `welinkSessionId`，因此可以稳定验证 `tool_error` 上行；真实 gateway 路径取决于服务端实际下行是否带路由目标。
- 它不验证 Provider `replyQuestion()` 抛错，因为 pending 不存在时不会调用 Provider。

### 4.7 question 回复 Provider 抛错

覆盖场景：序号 7。

步骤：

1. 在 Mock 模式启动 runtime。
2. 在 `Stage Matrix Lab` 选择 `question_reply Provider 抛错`。
3. 点击 `运行矩阵场景`。
4. 在 payload 预览中确认该场景会先发送 chat 注册固定 `questionId=question-conflict-fixed`，等待上行后再配置 `replyQuestion=throw` 并发送 `question_reply`。
5. 在 `SDK -> Agent` 确认 SDK 先调用 `runMessage()`，后调用 `replyQuestion()`。
6. 在 `Tool Error` 确认 stage 为 `command_failure`，error 包含 `SDK lab configured replyQuestion failure`。

说明：

- 该场景不依赖真实宿主卡片点击，MockGateway 会自动构造合法 reply 下行。

### 4.8 permission 回复 pending 不存在

覆盖场景：序号 8。

Mock 快速验证步骤：

1. 在 Mock 模式启动 runtime。
2. 在 `Stage Matrix Lab` 选择 `permission_reply pending 不存在`。
3. 点击 `运行矩阵场景`。
4. 在 `Gateway Downstream` 确认下行动作为 `permission_reply`，`permissionId` 为不存在的 ID。
5. 在 `Tool Error` 确认 stage 为 `command_failure`，error 包含“当前交互已失效”。

真实 gateway + 手动上报验证步骤：

1. 切换到真实 gateway。
2. 点击 `初始化` 和 `启动`。
3. 开启 `手动 ProviderFact 上报`。
4. 让宿主用户发送一条 chat 消息，使 SDK 调用 `runMessage()` 并在 Manual Agent Report 出现 active run。
5. 在 Manual Agent Report 选择 `message.start` 并上报。
6. 选择 `permission.ask`，确认 `permissionId`，必要时编辑授权内容后上报。
7. 在宿主侧确认 permission 卡片已经展示。
8. 在实验室点击 `停止`，再点击 `启动`；如需要更彻底清空本地 pending 状态，可执行 `停止` -> `初始化` -> `启动`。
9. 在宿主侧点击刚才的 permission 卡片，例如授权一次、始终授权或拒绝。
10. 在 `Gateway Downstream` 或右侧事件流筛选 `onMessage`，确认 SDK 收到 `permission_reply` 下行。
11. 如果真实 `permission_reply` 下行没有携带 `toolSessionId` 或 `welinkSessionId`，预期只在 `Gateway Downstream` 看到 `phase=failed`，`code=pending_interaction_not_found`，`error=permission interaction not found`；此时不会再上行 `tool_error`。
12. 只有当真实 `permission_reply` 下行具备可回包路由目标时，才继续在 `Tool Error`、`Gateway Uplink` 或右侧事件流筛选 `sendMessage`，确认上行 `tool_error`，error 包含“当前交互已失效”。

说明：

- 该场景验证的是 `InteractionCoordinator.consume()` 找不到 pending permission 后的失败收口。
- 真实 gateway 路径模拟的是：宿主侧仍保留旧 permission 卡片，但 SDK 重启后本地 pending registry 已丢失，用户再点击时触发 `pending_interaction_not_found`。
- Mock 矩阵场景会显式在 `permission_reply` 下行中携带 `welinkSessionId`，因此可以稳定验证 `tool_error` 上行；真实 gateway 路径取决于服务端实际下行是否带路由目标。
- 它不验证 Provider `replyPermission()` 抛错，因为 pending 不存在时不会调用 Provider。

### 4.9 permission 回复 Provider 抛错

覆盖场景：序号 9。

步骤：

1. 在 Mock 模式启动 runtime。
2. 在 `Stage Matrix Lab` 选择 `permission_reply Provider 抛错`。
3. 点击 `运行矩阵场景`。
4. 在 payload 预览中确认该场景会先发送 chat 注册固定 `permissionId=permission-conflict-fixed`，等待上行后再配置 `replyPermission=throw` 并发送 `permission_reply`。
5. 在 `SDK -> Agent` 确认 SDK 先调用 `runMessage()`，后调用 `replyPermission()`。
6. 在 `Tool Error` 确认 stage 为 `command_failure`，error 包含 `SDK lab configured replyPermission failure`。

### 4.10 关闭会话失败

覆盖场景：序号 10。

步骤：

1. 在 Mock 模式启动 runtime。
2. 在 `Stage Matrix Lab` 选择 `close_session Provider 抛错`。
3. 点击 `运行矩阵场景`。
4. 在 `SDK -> Agent` 确认 SDK 调用了 `provider.closeSession()`。
5. 在 `Tool Error` 确认 stage 为 `command_failure`，error 包含 `SDK lab configured closeSession failure`。

### 4.11 中止执行失败

覆盖场景：序号 11。

步骤：

1. 在 Mock 模式启动 runtime。
2. 在 `Stage Matrix Lab` 选择 `abort_session Provider 抛错`。
3. 点击 `运行矩阵场景`。
4. 在 `SDK -> Agent` 确认 SDK 调用了 `provider.abortSession()`。
5. 在 `Tool Error` 确认 stage 为 `command_failure`，error 包含 `SDK lab configured abortSession failure`。

### 4.12 ProviderRun.result reject

覆盖场景：序号 12。

步骤：

1. 在 Mock 模式启动 runtime。
2. 在 `Stage Matrix Lab` 选择 `ProviderRun.result reject`。
3. 点击 `运行矩阵场景`。
4. 在 `SDK -> Agent` 确认 SDK 调用了 `provider.runMessage()`。
5. 在 `Tool Error` 确认 stage 为 `command_failure`，error 包含 `SDK lab configured ProviderRun.result rejection`。

### 4.13 request facts 生命周期非法

覆盖场景：序号 13。

Mock 快速验证步骤：

1. 在 Mock 模式启动 runtime。
2. 在 `Stage Matrix Lab` 选择 `chat facts 顺序非法`。
3. 点击 `运行矩阵场景`。
4. 在事件流中查看 `provider.call` 和后续 failure 记录。
5. 在 `Tool Error` 确认 stage 为 `request_lifecycle`，error 包含“当前请求处理失败”。

真实 gateway + 手动上报验证步骤：

1. 切换到真实 gateway。
2. 点击 `初始化` 和 `启动`。
3. 开启 `手动 ProviderFact 上报`。
4. 让宿主用户发送一条 chat 消息，使 SDK 调用 `runMessage()` 并在 Manual Agent Report 出现 active run。
5. 不上报 `message.start`。
6. 在 Manual Agent Report 选择 `text.delta`，确认 JSON 中有当前 active run 的 `messageId`、`partId` 和 `content` 后，点击 `上报 Fact`。
7. 按需点击 `完成 completed` 走完流程；如果 SDK 已在非法 fact 阶段终止，本步可能已经无法继续提交，按页面状态观察即可。
8. 在 `Tool Error`、`Gateway Uplink` 或右侧事件流筛选 `sendMessage`，确认上行 `tool_error`，error 包含“当前请求处理失败，请重试”。

说明：

- 当前内置 `invalid_fact` 是未先发送 `message.start` 就发送 `text.delta`。
- 真实 gateway 路径模拟的是：mock agent 输出的 ProviderFact 缺少必要前置生命周期事件，SDK 无法把下行 request 正常投影成 gateway 上行消息。
- 手动验证时不要点击“按当前 text.done 补齐并完成”，该按钮会自动补齐 `message.start -> text.delta -> text.done -> message.done`，无法触发本场景。
- 如需验证更多 facts 顺序问题，例如 `message.done` 重复、`tool.update` 字段非法，应新增细分 mock facts 场景或允许 Stage Matrix 编辑 raw facts。

### 4.14 request pending interaction 冲突

覆盖场景：序号 14。

question 冲突步骤：

1. 在 Mock 模式启动 runtime。
2. 在 `Stage Matrix Lab` 选择 `question pending interaction 冲突`。
3. 点击 `运行矩阵场景`。
4. 在 payload 预览中确认该场景会对两个不同 `toolSessionId` 输出相同 `questionId=question-conflict-fixed`。
5. 在 `Tool Error` 确认 stage 为 `request_lifecycle`，error 包含“当前请求处理失败”。

permission 冲突步骤：

1. 在 Mock 模式启动 runtime。
2. 在 `Stage Matrix Lab` 选择 `permission pending interaction 冲突`。
3. 点击 `运行矩阵场景`。
4. 在 payload 预览中确认该场景会对两个不同 `toolSessionId` 输出相同 `permissionId=permission-conflict-fixed`。
5. 在 `Tool Error` 确认 stage 为 `request_lifecycle`，error 包含“当前请求处理失败”。

说明：

- 该场景验证 `InteractionCoordinator.registerFromFact()` 检测到跨会话复用 reply target 后抛出 `pending_interaction_conflict`。
- 同一 `toolSessionId` 重复 question/permission ID 会被 SDK 视为幂等吸收，不触发本场景。

## 5. 已增强实验室能力

本轮已补齐以下能力：

1. Stage Matrix 支持组合步骤
   - 一个场景可按顺序配置 Provider、发送多条下行、等待上行后再继续。
   - 用于 reply Provider 抛错、pending interaction conflict。

2. Stage Matrix 支持固定 interaction facts
   - `TestProvider` 新增 `question_conflict` 和 `permission_conflict` kind。
   - 固定输出 `questionId=question-conflict-fixed` 或 `permissionId=permission-conflict-fixed`，用于构造 reply 和跨会话冲突。

3. 新增 Provider 抛错矩阵场景
   - `question-reply-provider-throws`
   - `permission-reply-provider-throws`
   - `close-session-provider-throws`
   - `abort-session-provider-throws`

4. Stage Matrix 多步骤预览
   - 多步骤场景在 payload 预览中展示 `steps`，便于确认每一步下行和 Provider 配置。

## 6. 总结

当前实验室已能直接验证本文范围内 13 个可拆分场景：

- `inbound_invalid` 主链路
- unsupported action
- createSession throw
- runMessage throw
- pending question/permission 不存在
- replyQuestion/replyPermission Provider 抛错
- closeSession/abortSession Provider 抛错
- ProviderRun.result reject
- request facts 生命周期非法
- request pending interaction conflict

`request_terminal` 和 `outbound_terminal` 两类 stage 仍不纳入本文验证范围。

本文范围内仍不能通过当前实验室直接验证的场景是同会话重复发送 `run_already_active`，需要新增 Fake driver 或 core-level 并发注入能力。
