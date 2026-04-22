# Gateway Schema SkillProviderEvent 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 先把 `tool_event.event` 的协议边界从“隐式 shape 猜测”收紧为“显式、可测试、可回滚的 family 识别机制”，再单独判断 `SkillProviderEvent` 是否应该在本次进入 current-state 共享契约。

**架构立场：**
- `gateway-schema` 继续作为 current-state 协议层真源。
- `gateway-client` 继续只依赖 `GatewayWireCodec` 与 `validateGatewayUplinkBusinessMessage()`，不能感知 provider family 细节。
- `tool_event` 外层 envelope 与 `event` 内层 payload 必须保持分层，不能把 transport 语义重新塞回 payload。
- 当前文档语义仍成立：`OpencodeProviderEvent` 是 current-state 已落地来源；`SkillProviderEvent` 是否进入共享契约，需要单独采纳决策，而不是默认并入。

**技术栈：** TypeScript、Zod、Node.js test runner、workspace 包 `@agent-plugin/gateway-schema`、`@agent-plugin/gateway-client`

---

## 计划拆分

本计划拆为两个阶段，避免把目标态 runtime 模型一次性压进 current-state 协议层：

### 阶段 A：Protocol Hardening

目标：先解决 `tool_event.event` 的 family 判定机制、边界位置、validator 分流方式与 client 依赖方向。

交付物：
- 明确 `family` 是否进入 current-state 协议
- 明确 `family` 落在 `event` payload 内，而不是由 validator 猜测
- 明确 `toolSessionId` 仍只属于 `tool_event` envelope
- 明确 `gateway-client` 不新增 family-specific 分支

### 阶段 B：Skill Family Adoption

目标：只有在阶段 A 收敛完成后，才决定 `SkillProviderEvent` 是否以 current-state 共享契约身份进入 `GatewayToolEventPayload`。

交付物：
- 明确 `SkillProviderEvent` 这次是“正式进入 current-state”还是“继续停留在目标态文档”
- 如果正式进入，则同步 schema、常量、事件契约文档、架构文档与测试
- 如果不进入，则只保留 family 预留机制，不公开 `SkillProviderEvent`

---

## 非目标

- 本次不重写 `gateway-client` 的业务发送模型
- 本次不把 runtime projector / provider SPI 语义并入 `gateway-schema`
- 本次不把 `tool_event.event` 扩展成全量上行业务协议
- 在未完成文档同步前，不默认新增 `message.started`、`message.completed` 等新事件类型

---

## 硬性边界

### 1. 分层边界

- `GatewayUplinkBusinessMessage` 是上行业务消息边界。
- `tool_event` 是 transport/business envelope。
- `GatewayToolEventPayload` 是 `tool_event.event` 的 payload family。
- `ToolEventValidatorPort` 只负责“已进入共享契约的 payload family 准入”，不承担 runtime projector 语义。

### 2. 字段归属

- `toolSessionId` 只属于 `tool_event` 外层 envelope。
- `event` payload 内不得重复建模 `toolSessionId`，除非后续有独立文档先明确“内外层重复字段”的一致性规则。
- `family` 如果进入协议，应位于 `event` payload 内，并作为显式 discriminator。

### 3. 依赖方向

- `gateway-client -> GatewayWireCodec -> gateway-schema facade` 是唯一允许的协议校验依赖路径。
- `gateway-client` 不能 import 任意 family-specific schema/type 来做业务分支。
- `gateway-schema` 的 adapter 可以按 family 分流，但 `gateway-client` 不得知道这种分流存在。

### 4. 真源同步

若阶段 B 让 `SkillProviderEvent` 正式进入 current-state，则以下内容必须同步更新：
- `packages/gateway-schema/src/contract/schemas/tool-event/*`
- `packages/gateway-schema/src/contract/literals/tool-event.ts`
- `docs/design/interfaces/gateway-schema-event-contract.md`
- `docs/architecture/gateway-schema-architecture.md`

---

## 阶段 A：Protocol Hardening

### 任务 A1：固定 transport / payload 边界，不让 skill 语义反向污染 envelope

**文件：**
- 测试：`packages/gateway-schema/tests/tool-event-boundary.test.ts`
- 文档：`docs/architecture/gateway-schema-architecture.md`
- 文档：`docs/design/interfaces/gateway-schema-event-contract.md`

- [ ] **步骤 1：先写边界测试，固定当前分层约束**

```ts
test('toolSessionId belongs to tool_event envelope instead of event payload', () => {
  const result = gatewaySchema.toolEventMessageSchema.safeParse({
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: createGatewayWireMessageUpdatedEvent(),
  });

  assert.equal(result.success, true);
});
```

- [ ] **步骤 2：补文档约束，明确以下规则**

```md
- `toolSessionId` 只属于 `tool_event` envelope。
- `tool_event.event` 是 payload family，不重复表达 envelope transport 标识。
- `gateway-client` 不感知 provider family。
```

- [ ] **步骤 3：运行受影响测试**

运行：`pnpm --filter @agent-plugin/gateway-schema test -- --test-name-pattern "tool-event-boundary|transport"`

预期：PASS

---

### 任务 A2：把 family 判定从“shape 猜测”收紧为显式协议决策点

**文件：**
- 修改：`packages/gateway-schema/src/adapters/validators/tool-event-validator.ts`
- 修改：`packages/gateway-schema/src/adapters/validators/transport-message-validator.ts`
- 修改：`packages/gateway-schema/src/adapters/facade/gateway-schema-facade.ts`
- 测试：`packages/gateway-schema/tests/transport-contract.test.ts`

- [ ] **步骤 1：先写 transport 级测试，固定 validator 分层行为**

```ts
test('tool_event validator keeps two-stage validation: envelope first, event second', () => {
  const result = validateGatewayUpstreamTransportMessage({
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: {
      type: 'session.status',
      properties: {},
    },
  });

  assert.equal(result.ok, false);
});
```

- [ ] **步骤 2：在计划实现前先做一条技术决策**

二选一：
- 方案 A：`family` 这次正式进入 current-state 协议
- 方案 B：`family` 仍留在 adapter 内部能力，current-state 共享 schema 继续只公开 `OpencodeProviderEvent`

未完成此决策前，不进入阶段 B。

- [ ] **步骤 2.1：固定 validator 路由规则，禁止再回退到 shape 猜测**

无论采用方案 A 还是方案 B，都要先把“由谁决定执行哪个 family validator”写清楚：

```text
tool_event envelope
  -> event payload
    -> family discriminator
      -> opencodeProviderEvent validator
      -> skillProviderEvent validator
```

约束如下：
- 选择执行哪个 validator，一级决策点只能是 `family`，不能是字段 shape。
- 进入某个 family validator 之后，才允许再按 `event.type` 做该 family 内部的事件级判定。
- `session.idle`、`question.asked` 这类可能跨 family 重名的事件，不能再靠字段长相猜来源。
- 若采用方案 A：
  `event.family` 是协议字段；缺失 `family``/`未知 `family` 都返回结构化 violation。
- 若采用方案 B：
  `family` 可不进入 public contract，但 adapter 内部仍必须先得到显式 family 决策结果，再进入对应 validator；禁止在 validator 内部通过字段 shape 反推来源。

推荐伪代码：

```ts
function validateToolEventPayload(raw: unknown) {
  const family = readExplicitFamily(raw);
  if (!family) {
    return violation('family is required or unsupported');
  }

  switch (family) {
    case 'opencode':
      return validateOpencodeProviderEvent(raw);
    case 'skill':
      return validateSkillProviderEvent(raw);
    default:
      return violation('family is required or unsupported');
  }
}
```

- [ ] **步骤 3：若选择方案 A，则在 validator 中实现“显式 family 分流”**

要求：
- 缺失 `family` 时返回结构化 violation
- 不再通过字段 shape 猜测来源
- transport validator 仍保持 envelope 校验与 event 校验分离

- [ ] **步骤 4：若选择方案 B，则只允许内部显式分流，不修改 public contract**

要求：
- 不公开 `SkillProviderEvent`
- 不修改 `gatewayToolEventPayloadSchema` 的公开类型
- 只在 validator 内为未来 family 扩展预留内部结构

- [ ] **步骤 5：运行 schema 包测试**

运行：`pnpm --filter @agent-plugin/gateway-schema test`

预期：PASS

---

### 任务 A3：固定 client 依赖方向，防止 family-specific 类型泄漏

**文件：**
- 修改：`packages/gateway-client/src/ports/GatewayWireCodec.ts`
- 修改：`packages/gateway-client/src/application/protocol/OutboundProtocolGate.ts`
- 测试：`packages/gateway-client/tests/gateway-client.test.ts`

- [ ] **步骤 1：增加 send-path 回归测试，证明 client 只依赖 codec，不依赖 family-specific 类型**

```ts
test('outbound protocol gate delegates business validation to wire codec', () => {
  let called = false;
  const wireCodec = {
    validateGatewayUplinkBusinessMessage(raw: unknown) {
      called = true;
      return { ok: true as const, value: raw as GatewayUplinkBusinessMessage };
    },
    validateGatewayUpstreamTransportMessage() {
      throw new Error('not used');
    },
    normalizeDownstream() {
      throw new Error('not used');
    },
    validateGatewayWireProtocolMessage() {
      throw new Error('not used');
    },
  };

  const gate = new DefaultOutboundProtocolGate(wireCodec);
  gate.validateBusiness({
    type: 'tool_event',
    toolSessionId: 'tool-1',
    event: createGatewayWireMessageUpdatedEvent(),
  });

  assert.equal(called, true);
});
```

- [ ] **步骤 2：仅补注释，不新增 `if skill ... else if opencode ...` 分支**

注释需要明确：
- client 不理解 `tool_event.event` 内部 family
- family 判定由共享协议层负责
- gate 只收口 control/business 协议校验

- [ ] **步骤 3：运行 client 测试**

运行：`pnpm --filter @agent-plugin/gateway-client test`

预期：PASS

---

## 阶段 B：Skill Family Adoption

> 只有阶段 A 完成且明确选择“方案 A：`family` 正式进入 current-state 协议”后，才执行本阶段。

### 进入条件

以下条件缺一不可：
- 已确认 `family` 是 current-state 协议字段，而不是内部实现细节
- 已确认 `toolSessionId` 不进入 `event.properties`
- 已确认 `SkillProviderEvent` 本次不是“目标态文档占位”，而是 current-state 共享契约的一部分
- 已确认事件 taxonomy 与 `SUPPORTED_TOOL_EVENT_TYPES` 的同步策略

---

### 任务 B1：定义最小 skill family 范围，而不是一次铺开全部 runtime 语义

**文件：**
- 创建：`packages/gateway-schema/src/contract/schemas/tool-event/skill-provider-event/index.ts`
- 可选创建：`session.ts`
- 可选创建：`interaction.ts`
- 可选创建：`message.ts`
- 测试：`packages/gateway-schema/tests/tool-event-skill-provider-contract.test.ts`

- [ ] **步骤 1：先锁定本次最小闭集**

推荐优先级：
1. `session.idle`
2. `question.asked`
3. `permission.asked` 或 `session.error`

本次未纳入闭集的事件，不提前建 schema 文件占位。

- [ ] **步骤 2：先写契约测试，明确 skill payload 不重复 envelope 字段**

```ts
test('skill event payload does not duplicate tool_event envelope fields', () => {
  const result = validateToolEvent({
    family: 'skill',
    type: 'session.idle',
    properties: {},
  });

  assert.equal(result.ok, true);
});
```

- [ ] **步骤 3：实现最小 skill family schema**

要求：
- `family: 'skill'` 是显式 discriminator
- `type` 仍是事件级 discriminator
- `properties` 只表达 payload 业务语义
- 不照搬 opencode 私有 message 结构

- [ ] **步骤 4：如果 skill 事件类型超出当前 11 个支持集合，则同步更新常量与文档**

必须同步：
- `packages/gateway-schema/src/contract/literals/tool-event.ts`
- `docs/design/interfaces/gateway-schema-event-contract.md`

- [ ] **步骤 5：运行 schema 包测试**

运行：`pnpm --filter @agent-plugin/gateway-schema test`

预期：PASS

---

### 任务 B2：把 `GatewayToolEventPayload` 扩展为双 family，仅在 current-state 正式采纳后进行

**文件：**
- 修改：`packages/gateway-schema/src/contract/schemas/tool-event/index.ts`
- 修改：`packages/gateway-schema/src/contract/index.ts`
- 修改：`packages/gateway-schema/src/index.ts`
- 测试：`packages/gateway-schema/tests/tool-event-boundary.test.ts`

- [ ] **步骤 1：先写公开面测试**

```ts
test('public API exposes both payload families after skill family adoption', () => {
  assert.equal('OpencodeProviderEvent' in gatewaySchema, true);
  assert.equal('SkillProviderEvent' in gatewaySchema, true);
  assert.equal('skillProviderEventSchema' in gatewaySchema, true);
});
```

- [ ] **步骤 2：实现双 family 公开 union**

实现前提：
- 不能直接把现有 `opencodeProviderEventSchema` 当作 `family` 级 discriminated union 成员使用，除非先定义稳定包裹方式
- 必须先解决 Zod 组合方式与现有 `type` 级 discriminated union 的兼容问题

- [ ] **步骤 3：运行边界测试**

运行：`pnpm --filter @agent-plugin/gateway-schema test -- --test-name-pattern "tool-event-boundary"`

预期：PASS

---

### 任务 B3：同步 transport、文档与跨包回归

**文件：**
- 修改：`packages/gateway-schema/tests/transport-contract.test.ts`
- 修改：`docs/design/interfaces/gateway-schema-event-contract.md`
- 修改：`docs/architecture/gateway-schema-architecture.md`
- 测试：`packages/gateway-client/tests/gateway-client.test.ts`

- [ ] **步骤 1：增加 `tool_event(event=SkillProviderEvent)` transport 场景**

- [ ] **步骤 2：同步事件契约文档**

至少补齐：
- `family` 是否为必填字段
- skill family 支持的事件类型
- `SUPPORTED_TOOL_EVENT_TYPES` 是否变化

- [ ] **步骤 3：同步架构文档**

把以下表述从“目标态待补项”更新为“已进入 current-state”：
- `GatewayToolEventPayload`
- `SkillProviderEvent`
- current-state / target-state 关系

- [ ] **步骤 4：运行跨包回归**

运行：
- `pnpm --filter @agent-plugin/gateway-schema test`
- `pnpm --filter @agent-plugin/gateway-client test`
- `pnpm verify:workspace`

预期：PASS

---

## 建议提交切分

建议按边界递进提交，而不是把协议、schema、client、文档混成一个 commit：

1. `refactor: harden tool_event protocol boundaries`
2. `refactor: prepare explicit tool event family routing`
3. `feat: adopt skill provider event family in gateway schema`
4. `docs: sync gateway schema event contract for skill family`

---

## 完成定义

只有同时满足以下条件，才算本计划完成：
- `tool_event` envelope 与 `event` payload 的字段边界已被测试固定
- `gateway-client` 仍不感知 provider family
- `ToolEventValidatorPort` 没有承担 runtime projector 职责
- 若 skill family 已采纳，则 schema、常量、架构文档、事件契约文档全部同步
- `pnpm --filter @agent-plugin/gateway-schema test` 通过
- `pnpm --filter @agent-plugin/gateway-client test` 通过
- `pnpm verify:workspace` 通过

---

## 关键设计结论

- 先做协议硬化，再做 family 采纳，能避免 current-state 与 target-state 语义混写。
- `toolSessionId` 应留在 `tool_event` envelope，不能默认下沉进 payload。
- `gateway-client` 只能依赖 `GatewayWireCodec`，不能知道 provider family。
- `SkillProviderEvent` 不是“只要开始实现就自动进入 current-state”；它必须经过显式采纳决策。
- 若后续还会出现第三种 payload family，应继续扩展明确的协议决策点，而不是让 validator 回退到 shape 猜测。
