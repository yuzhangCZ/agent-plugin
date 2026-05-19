# Message-Bridge SDK 迁移方案文档修订计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修订 `message-bridge` SDK 迁移方案文档中 3 处已确认的接口设计问题，使其与 SDK public contract、gateway-schema 约束和替换评估真源保持一致。

**架构：** 本次仅修改文档，不改 TypeScript 实现和协议 schema。修订重点是收紧 `permission_reply` 的 `messageId` 规则、把关键时序图改回 `ProviderRun` 心智模型、以及把 `PermissionReplyFact` 的原始事件来源固定为 `permission.replied`。所有改动必须与 `docs/design/interfaces/bridge-runtime-sdk-integration.md`、`plugins/message-bridge/docs/design/interfaces/bridge-runtime-sdk-replacement-assessment.md` 和 `packages/gateway-schema` 现有契约一致。

**技术栈：** Markdown、Mermaid、TypeScript 契约文档、Zod schema 参考

---

### 任务 1：统一 `permission_reply` continuation 的 `messageId` 规则

**文件：**
- 修改：`plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md`
- 参考：`docs/design/interfaces/bridge-runtime-sdk-integration.md`
- 参考：`packages/bridge-runtime-sdk/src/domain/provider-contract.ts`

- [ ] **步骤 1：定位所有仍要求“沿用原 `permission.ask.messageId`”的段落**

运行：`rg -n "沿用最初|不重新生成新的 messageId|outbound continuation|permission.ask" plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md`
预期：至少命中摘要第 4 节、`6.7 permission_reply` 固定结论、`7.8.3 continuation 回流规则`。

- [ ] **步骤 2：把摘要与 `6.7` 章节改成和 `7.8.3` 一致的单一口径**

将以下旧口径：

```md
- `messageId` 默认沿用最初 `permission.ask` 注册时关联的 `messageId`。
```

替换为：

```md
- 若 resolved 不属于当前 `runMessage().facts` 流，provider 必须通过 `ProviderRuntimeContext.outbound.emitOutboundMessage()` 回流。
- 若 `permission.reply` 仍属于原 `runMessage().facts` 流，可以继续沿用该消息流既有的 `messageId`。
- 若 `permission.reply` 改走 outbound continuation，provider 必须为该 outbound facts 批次生成新的 `messageId`，并保证它在当前 `toolSessionId` 内唯一。
- 原始 `permission.ask` 关联的 `messageId` 只作为关联锚点、诊断线索或回放线索，不再作为 outbound continuation 的强制 message identity。
```

- [ ] **步骤 3：核对措辞与 SDK integration 真源一致**

运行：`rg -n "messageId.*唯一|outbound facts|EmitOutboundMessageInput.messageId" docs/design/interfaces/bridge-runtime-sdk-integration.md packages/bridge-runtime-sdk/src/domain/provider-contract.ts`
预期：能看到 `messageId` 在 `toolSessionId` 内唯一、同批 outbound facts 的 `messageId` 与 `EmitOutboundMessageInput.messageId` 一致的约束。

- [ ] **步骤 4：人工复读一遍 `6.7` 和 `7.8.3`，确认两节不再自相矛盾**

运行：`sed -n '470,490p' plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md && sed -n '707,717p' plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md`
预期：两节都明确区分“原 facts 流复用旧 `messageId`”与“outbound continuation 生成新 `messageId`”。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md docs/superpowers/plans/2026-05-19-message-bridge-sdk-migration-doc-fixes.md
git commit -m "docs: unify permission reply message id rules"
```

### 任务 2：把关键时序图收敛到真实 `ProviderRun` 契约

**文件：**
- 修改：`plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md`
- 参考：`packages/bridge-runtime-sdk/src/domain/provider-contract.ts`

- [ ] **步骤 1：定位把 `runMessage()` 画成“直接返回 facts 或 terminal”的图**

运行：`rg -n "runMessage\\(|ProviderTerminalResult\\(|ProviderFact\\*|terminal completed" plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md`
预期：至少命中 `6.2 chat`、`6.3 session_not_found`、`6.4 suppressReply`。

- [ ] **步骤 2：改写 `6.2 chat` 时序图**

将核心链路改成：

```md
  UC->>MBPROV: runMessage(input)
  MBPROV-->>UC: ProviderRun
  MBPROV->>MBPOLICY: resolve session probe / directory / deny policy
  MBPOLICY-->>MBPROV: ProviderExecutionContext
  MBPROV->>OCSDK: prompt / subscribe
  OCSDK->>OC: prompt / subscribe
  OC-->>OCSDK: raw events
  OCSDK-->>MBPROV: raw events
  MBPROV-->>MBRT: ProviderRun.facts -> ProviderFact*
  MBPROV-->>MBRT: ProviderRun.result() -> ProviderTerminalResult
```

要求：图意必须体现 `runMessage()` 的直接输出是 `ProviderRun`，而不是 `ProviderFact*`。

- [ ] **步骤 3：改写 `6.3 session_not_found` 与 `6.4 suppressReply`**

将两节都改成“provider 返回 `ProviderRun`，然后由该 run 的 `facts`/`result()` 表达运行过程”的口径。至少要包含下列文案：

```md
- `session_not_found` 由 provider 返回一个可立即收敛的 `ProviderRun`，其 `result()` 返回 `ProviderTerminalResult(error.code='session_not_found')`。
- synthetic deny fast path 由 provider 返回 synthetic `ProviderRun`；其 `facts` 产出最小事实序列，`result()` 返回 `completed`。
```

- [ ] **步骤 4：检查 `7.5 Provider Adapter 边界` 与 `6.x` 时序图是否完全对齐**

运行：`sed -n '624,639p' plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md && sed -n '305,405p' plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md`
预期：`7.5` 表里的 `runMessage() -> ProviderRun` 与 `6.2/6.3/6.4` 时序图不再冲突。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md
git commit -m "docs: align runtime sequence diagrams with provider run contract"
```

### 任务 3：收紧 `PermissionReplyFact` 的原始事件来源

**文件：**
- 修改：`plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md`
- 参考：`plugins/message-bridge/docs/design/interfaces/bridge-runtime-sdk-replacement-assessment.md`

- [ ] **步骤 1：定位所有把权限回执来源写成泛化“resolved evidence”的段落**

运行：`rg -n "resolved evidence|permission.replied|PermissionReplyFact" plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md`
预期：命中 `6.7 permission_reply` 时序图附近和相关固定结论。

- [ ] **步骤 2：把原始事件来源改成单一真源表述**

将下列模糊表述：

```md
permission.replied / resolved evidence
```

改为：

```md
permission.replied
```

并在 `6.7` 或 `7.6 Fact 收敛边界` 增补硬规则：

```md
- `PermissionReplyFact` 的唯一原始事件来源是 `permission.replied`。
- `permission.updated` 及其 `status` / `response` / `resolved` 字段变化不作为生成 `PermissionReplyFact` 的依据。
```

- [ ] **步骤 3：核对替换评估真源没有被回退**

运行：`sed -n '186,191p' plugins/message-bridge/docs/design/interfaces/bridge-runtime-sdk-replacement-assessment.md`
预期：能看到 `permission.updated` 标记为 `不纳入`，`permission.replied` 才是 `PermissionReplyFact` 的承载来源。

- [ ] **步骤 4：通读 `4.4`、`6.7`、`7.6`，确认“单一转换点”与“单一原始来源”同时成立**

运行：`sed -n '221,226p' plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md && sed -n '481,505p' plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md && sed -n '642,656p' plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md`
预期：文档既保留“provider 真源产出 resolved fact”，又明确 `permission.replied` 是唯一允许的原始事件来源。

- [ ] **步骤 5：Commit**

```bash
git add plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md
git commit -m "docs: tighten permission reply raw event source"
```

### 任务 4：整体一致性检查

**文件：**
- 修改：`plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md`
- 参考：`docs/design/interfaces/bridge-runtime-sdk-integration.md`
- 参考：`plugins/message-bridge/docs/design/interfaces/bridge-runtime-sdk-replacement-assessment.md`
- 参考：`packages/gateway-schema/src/contract/schemas/upstream-business.ts`

- [ ] **步骤 1：执行最小一致性 grep**

运行：`rg -n "沿用最初|不重新生成新的 messageId|resolved evidence|ProviderTerminalResult\\(|ProviderFact\\*" plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md`
预期：不再命中旧口径；若仍命中，继续修正文档直到清零或仅剩合法上下文。

- [ ] **步骤 2：检查与 gateway-schema 的上行扁平契约没有冲突**

运行：`sed -n '24,68p' packages/gateway-schema/src/contract/schemas/upstream-business.ts && sed -n '27,35p' packages/gateway-schema/src/contract/schemas/tool-event/skill-provider-event/permission.ts`
预期：文档没有引入新的上行字段，也没有要求修改 `tool_event(permission.reply)` 的扁平形状。

- [ ] **步骤 3：查看最终 diff，确认只有文档改动**

运行：`git diff -- plugins/message-bridge/docs/design/message-bridge-sdk-migration-solution.md docs/superpowers/plans/2026-05-19-message-bridge-sdk-migration-doc-fixes.md`
预期：仅包含计划文件与迁移方案文档的语义修订，无实现代码改动。

- [ ] **步骤 4：如需合并提交，整理为一条文档修订 commit**

运行：`git status --short`
预期：只剩本计划范围内的文档文件处于已修改状态。

