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
| 1 | `inbound_invalid` | 入站 `invoke` 协议校验失败 | 可直接验证 | `invalid-chat-missing-text`、`invalid-chat-empty-text`、`invalid-slash-missing-trace`、`invalid-ext-parameters` | 上行 `tool_error`，error 包含 `gateway_invalid_invoke` |
| 2 | `command_failure` | unsupported invoke action | 可直接验证 | `unsupported-invoke-action` | 上行 `tool_error`，error 包含“不支持” |
| 3 | `command_failure` | 新建会话失败 | 可直接验证 | `create-session-provider-throws` | 上行 `tool_error`，error 包含 `SDK lab configured createSession failure` |
| 4 | `command_failure` | 发送消息启动失败 | 可直接验证 | `chat-provider-throws` | 上行 `tool_error`，error 包含 `SDK lab configured runMessage failure` |
| 5 | `command_failure` | 同会话重复发送 | 当前不能直接验证 | 建议新增 `chat-run-already-active` 场景 | 上行 `tool_error`，error 为“当前会话正在处理中，请稍后再试” |
| 6 | `command_failure` | question 回复 pending 不存在 | 可直接验证 | `question-reply-pending-missing` | 上行 `tool_error`，error 包含“当前交互已失效” |
| 7 | `command_failure` | question 回复 Provider 抛错 | 可间接验证 | 真实 gateway + Manual Agent Report + Provider 场景 `replyQuestion=throw` | 上行 `tool_error`，error 包含 Provider 异常 message |
| 8 | `command_failure` | permission 回复 pending 不存在 | 可直接验证 | `permission-reply-pending-missing` | 上行 `tool_error`，error 包含“当前交互已失效” |
| 9 | `command_failure` | permission 回复 Provider 抛错 | 可间接验证 | 真实 gateway + Manual Agent Report + Provider 场景 `replyPermission=throw` | 上行 `tool_error`，error 包含 Provider 异常 message |
| 10 | `command_failure` | 关闭会话失败 | 当前不能直接验证 | 建议新增 `close-session-provider-throws` 场景 | 上行 `tool_error`，error 包含 `SDK lab configured closeSession failure` |
| 11 | `command_failure` | 中止执行失败 | 当前不能直接验证 | 建议新增 `abort-session-provider-throws` 场景 | 上行 `tool_error`，error 包含 `SDK lab configured abortSession failure` |
| 12 | `command_failure` | request terminal Promise reject | 可直接验证 | `chat-result-reject` | 上行 `tool_error`，error 包含 `ProviderRun.result rejection` |
| 13 | `request_lifecycle` | request facts 生命周期非法 | 可直接验证 | `chat-invalid-facts` | 上行 `tool_error`，error 包含“当前请求处理失败” |
| 14 | `request_lifecycle` | request pending interaction 冲突 | 当前不能直接验证 | 建议新增重复 `questionId` / `permissionId` 的 mock facts 场景 | 上行 `tool_error`，error 包含“当前请求处理失败” |

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
5. 在 `Tool Error` 查看 `error` 是否包含 `gateway_invalid_invoke`。
6. 在 `Gateway Uplink` 或右侧事件流 `sendMessage` 查看完整 `tool_error` 上行。

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

### 4.5 question 回复 pending 不存在

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
11. 在 `Tool Error`、`Gateway Uplink` 或右侧事件流筛选 `sendMessage`，确认上行 `tool_error`，error 包含“当前交互已失效”。

说明：

- 该场景验证的是 `InteractionCoordinator.consume()` 找不到 pending question 后的失败收口。
- 真实 gateway 路径模拟的是：宿主侧仍保留旧 question 卡片，但 SDK 重启后本地 pending registry 已丢失，用户再回复时触发 `pending_interaction_not_found`。
- 它不验证 Provider `replyQuestion()` 抛错，因为 pending 不存在时不会调用 Provider。

### 4.6 permission 回复 pending 不存在

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
11. 在 `Tool Error`、`Gateway Uplink` 或右侧事件流筛选 `sendMessage`，确认上行 `tool_error`，error 包含“当前交互已失效”。

说明：

- 该场景验证的是 `InteractionCoordinator.consume()` 找不到 pending permission 后的失败收口。
- 真实 gateway 路径模拟的是：宿主侧仍保留旧 permission 卡片，但 SDK 重启后本地 pending registry 已丢失，用户再点击时触发 `pending_interaction_not_found`。
- 它不验证 Provider `replyPermission()` 抛错，因为 pending 不存在时不会调用 Provider。

### 4.7 ProviderRun.result reject

覆盖场景：序号 12。

步骤：

1. 在 Mock 模式启动 runtime。
2. 在 `Stage Matrix Lab` 选择 `ProviderRun.result reject`。
3. 点击 `运行矩阵场景`。
4. 在 `SDK -> Agent` 确认 SDK 调用了 `provider.runMessage()`。
5. 在 `Tool Error` 确认 stage 为 `command_failure`，error 包含 `SDK lab configured ProviderRun.result rejection`。

### 4.8 request facts 生命周期非法

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

## 5. 可间接验证场景步骤

### 5.1 question 回复 Provider 抛错

覆盖场景：序号 7。

当前可行路径依赖真实 gateway 和宿主侧交互：

1. 切换到真实 gateway。
2. 点击 `初始化` 和 `启动`。
3. 开启 `手动 ProviderFact 上报`。
4. 让宿主用户发送一条 chat 消息，使 SDK 调用 `runMessage()` 并在 Manual Agent Report 出现 active run。
5. 在 Manual Agent Report 选择 `message.start` 并上报。
6. 选择 `question.ask`，编辑问题内容后上报。
7. 在宿主侧确认出现 question 卡片。
8. 在 Provider 场景面板设置 `command=replyQuestion`、`kind=throw`、`delay=0`，点击 `应用场景`。
9. 在宿主侧回复 question 卡片。
10. 在实验室右侧事件流筛选 `onMessage`，确认收到 `question_reply` 下行。
11. 筛选 `sendMessage`，确认 SDK 上行 `tool_error`，error 包含 `SDK lab configured replyQuestion failure`。

当前限制：

- Mock 模式没有“根据已注册 questionId 自动构造 reply 下行”的按钮。
- Stage Matrix Lab 的 raw 只预览不可编辑，无法直接把动态 `questionId` 注入到 `question_reply` 场景。
- 因此该路径依赖真实宿主侧 UI 能展示并点击 question 卡片。

可改造方向：

1. 在 Manual Agent Report 上报 `question.ask` 后，把最新 `questionId` 暴露为可点击回复目标。
2. 新增 `Reply Interaction Lab` 面板，自动读取 pending question/permission，构造合法 `question_reply` / `permission_reply` 下行。
3. 新增 Stage Matrix 场景 `question-reply-provider-throws`，运行前先通过 mock facts 注册 pending question，再配置 `replyQuestion=throw` 并注入 reply 下行。

### 5.2 permission 回复 Provider 抛错

覆盖场景：序号 9。

当前可行路径依赖真实 gateway 和宿主侧交互：

1. 切换到真实 gateway。
2. 点击 `初始化` 和 `启动`。
3. 开启 `手动 ProviderFact 上报`。
4. 让宿主用户发送一条 chat 消息，使 SDK 调用 `runMessage()` 并在 Manual Agent Report 出现 active run。
5. 在 Manual Agent Report 选择 `message.start` 并上报。
6. 选择 `permission.ask`，编辑授权文案后上报。
7. 在宿主侧确认出现 permission 卡片。
8. 在 Provider 场景面板设置 `command=replyPermission`、`kind=throw`、`delay=0`，点击 `应用场景`。
9. 在宿主侧点击授权或拒绝。
10. 在实验室右侧事件流筛选 `onMessage`，确认收到 `permission_reply` 下行。
11. 筛选 `sendMessage`，确认 SDK 上行 `tool_error`，error 包含 `SDK lab configured replyPermission failure`。

当前限制和可改造方向同 question 回复 Provider 抛错。

## 6. 当前不能直接验证的场景

### 6.1 同会话重复发送

覆盖场景：序号 5。

不能直接验证原因：

1. Stage Matrix Lab 目前每个场景只发送一条固定下行。
2. `run_already_active` 需要同一个 `toolSessionId` 的第一轮 request run 仍未结束时，再发送第二条 chat。
3. 当前 `TestProvider` 的 `timeout` 能让 run 长时间不结束，但 Stage Matrix 没有内置“两次同 toolSessionId chat”的组合场景，也没有可编辑 raw 注入入口。

可以通过改造实验室完善：

1. 新增 Stage Matrix 场景 `chat-run-already-active`。
2. 场景执行逻辑：
   - 配置 `runMessage=timeout` 或开启 manual mode 并保持 terminal 不完成。
   - 发送第一条 `chat`，`toolSessionId=tool-run-active`。
   - 立即发送第二条 `chat`，复用同一个 `toolSessionId=tool-run-active`。
   - 捕获第二条下行对应的 `tool_error`。
3. 预期：stage 为 `command_failure`，error 为“当前会话正在处理中，请稍后再试”。

### 6.2 关闭会话失败

覆盖场景：序号 10。

不能直接验证原因：

1. `TestProvider.closeSession()` 已支持通过 Provider 场景 `closeSession=throw` 抛错。
2. 但 Stage Matrix 当前只有 `close_session 缺少 toolSessionId` 的入站非法场景，没有合法 `close_session` + Provider 抛错场景。
3. 前端 Stage Matrix raw 只展示不可编辑，无法临时注入合法 close 下行并绑定 `closeSession=throw`。

可以通过改造实验室完善：

1. 新增 Stage Matrix 场景 `close-session-provider-throws`。
2. raw 示例：

   ```json
   {
     "type": "invoke",
     "action": "close_session",
     "welinkSessionId": "wl-close-provider-error",
     "payload": {
       "toolSessionId": "tool-close-provider-error"
     }
   }
   ```

3. expected 配置 `providerScenario: { "command": "closeSession", "kind": "throw" }`。
4. 预期：上行 `tool_error`，stage 为 `command_failure`，error 包含 `SDK lab configured closeSession failure`。

### 6.3 中止执行失败

覆盖场景：序号 11。

不能直接验证原因：

1. `TestProvider.abortSession()` 已支持通过 Provider 场景 `abortSession=throw` 抛错。
2. 但 Stage Matrix 当前只有 `abort_session 缺少 toolSessionId` 的入站非法场景，没有合法 `abort_session` + Provider 抛错场景。

可以通过改造实验室完善：

1. 新增 Stage Matrix 场景 `abort-session-provider-throws`。
2. raw 示例：

   ```json
   {
     "type": "invoke",
     "action": "abort_session",
     "welinkSessionId": "wl-abort-provider-error",
     "payload": {
       "toolSessionId": "tool-abort-provider-error"
     }
   }
   ```

3. expected 配置 `providerScenario: { "command": "abortSession", "kind": "throw" }`。
4. 预期：上行 `tool_error`，stage 为 `command_failure`，error 包含 `SDK lab configured abortSession failure`。

### 6.4 request pending interaction 冲突

覆盖场景：序号 14。

不能直接验证原因：

1. `pending_interaction_conflict` 要求两个不同 `toolSessionId` 注册相同的 `questionId` 或 `permissionId`。
2. 当前 `TestProvider` 的 `question.ask` / `permission.ask` 模板会生成随机 ID。
3. Manual Agent Report 可以手动编辑 ID，但一次 active run 只对应一个 `toolSessionId`，同 session 重复 ID 会被 SDK 按幂等处理，不触发 conflict。
4. Stage Matrix 当前没有“两轮不同 toolSessionId + 相同 questionId/permissionId”的组合 mock facts 场景。

可以通过改造实验室完善：

1. 在 `TestProvider` 增加 `ProviderScenarioKind`：
   - `question_conflict`
   - `permission_conflict`
2. 在 `DownstreamScenarioRunner` 增加组合场景能力，支持一个场景发送多条下行。
3. 新增 Stage Matrix 场景：
   - 第一条 chat：`toolSessionId=tool-conflict-a`，facts 输出 `question.ask questionId=question-conflict-fixed`。
   - 第二条 chat：`toolSessionId=tool-conflict-b`，facts 输出相同 `questionId=question-conflict-fixed`。
4. 预期：第二条 run 在 `request_lifecycle` 阶段上行 `tool_error`，error 包含“当前请求处理失败”。
5. permission 冲突同理，固定 `permissionId=permission-conflict-fixed`。

## 7. 建议新增实验室能力

为让 4.2.1 全量场景都能在实验室内稳定闭环，建议新增以下能力：

1. Stage Matrix 支持组合步骤
   - 一个场景可包含多步：配置 Provider、发送第一条下行、等待指定事件、发送第二条下行、断言 uplink。
   - 用于 `run_already_active`、pending interaction conflict、reply Provider 抛错。

2. Stage Matrix 支持动态 facts 场景
   - `TestProvider` 增加固定 ID 的 `question.ask` / `permission.ask` facts。
   - 支持 facts 中途抛错、重复 ID、跨 session 冲突等精细变体。

3. 新增 Reply Interaction Lab
   - 展示 SDK 已注册的 pending `questionId` / `permissionId`。
   - 提供按钮构造合法 `question_reply` / `permission_reply` 下行。
   - 可在发送前配置 `replyQuestion=throw` 或 `replyPermission=throw`。

4. Stage Matrix raw 编辑器
   - 当前界面只展示 scenario raw。
   - 增加“复制为自定义 raw / 运行自定义 raw”后，可临时验证合法 close、abort、reply 等变体。

5. Scenario 断言增强
   - 当前结果主要按 uplink 类型、errorIncludes、reason 判断。
   - 建议补充断言 `toolSessionId`、`welinkSessionId`、事件顺序、Provider API 是否被调用、是否没有额外 `tool_done`。

## 8. 总结

当前实验室已能直接验证本文范围内 14 个可拆分场景里的 8 个：

- `inbound_invalid` 主链路
- unsupported action
- createSession throw
- runMessage throw
- pending question/permission 不存在
- ProviderRun.result reject
- request facts 生命周期非法

仍需改造后才能稳定直接验证的场景有 4 个：

- 同会话重复发送 `run_already_active`
- closeSession Provider 抛错
- abortSession Provider 抛错
- request pending interaction conflict

可通过真实 gateway + Manual Agent Report 间接验证的场景有 2 个：

- replyQuestion Provider 抛错
- replyPermission Provider 抛错

推荐优先补齐 Stage Matrix 组合步骤和 Reply Interaction Lab。这样可以把真实宿主侧依赖降到最低，让本文范围内的 `4.2.1` 场景都能通过 Mock 模式稳定回归。
