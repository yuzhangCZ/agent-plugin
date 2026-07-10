# 代码治理规则

**Version:** 1.5
**Date:** 2026-07-09
**Status:** Active
**Owner:** agent-plugin maintainers

本文定义 `agent-plugin` 仓库的长期代码治理规则。子目录 `AGENTS.md` 可在其作用域内补充更严格规则。

## 工作边界

1. 默认只在 `plugins/` 和 `packages/` 下做主开发。
2. 非专门任务不要修改 `integration/opencode-cui` 的内容或 submodule 指针。
3. 不把外部夹具、上游 SDK 或集成样例里的模式直接提升为主仓规范；需要沉淀时先转化为 `plugins/` 或 `packages/` 的本仓规则。
4. 代码标识符、命令、配置键、协议字段保持英文；用户可见输出、仓库文档和注释默认使用简体中文。

## 分层与依赖

1. 插件宿主差异留在 `plugins/*`；可复用协议、连接、runtime、测试支持能力优先放在对应 `packages/*`。
2. 跨包依赖必须遵守职责方向，不为复用单个 helper 引入反向依赖。
3. 协议字段和校验真源优先放在协议或 schema 包；业务文件不重复定义协议边界。
4. 新增共享能力前先确认是否已有包内 helper、schema、port 或 facade 可复用。

## Public API 与契约

1. 新增或调整 public API、入口导出、协议字段、配置项、错误码时，必须同步考虑契约测试和文档。
2. public contract 的稳定入口必须明确导出，不通过内部路径隐式暴露。
3. 默认值、兼容字段、废弃字段和行为变化必须在变更说明中显式声明。
4. 删除或替换 public 行为时，必须给出迁移路径、兼容策略或明确的破坏性变更说明。

## 注释规则

设计、实现或评审 TypeScript API 注释时，应参考
[`tsdoc-comments` skill](../../.agents/skills/tsdoc-comments/SKILL.md) 中的 TSDoc 结构、标签和示例写法。

## 类型与协议边界

1. JSON 对象、plain object、数组、字符串等协议边界判断必须优先使用所在包内共享 type guard 或 schema helper。
2. 禁止在业务文件中重复散落 `value !== null && typeof value === 'object' && !Array.isArray(value)` 这类对象判断。
3. 如果所在包缺少对应 helper，应先补充包内共享工具，再在业务逻辑中引用。
4. 跨包不要为了复用 type guard 引入反向依赖；各包可保留自己的边界工具，但同一包内必须收敛到一处。

### 外部输入校验

Truthy 判断只能判断 JavaScript 真值，不能证明值是 plain object；字符串、数组和函数等 truthy
值仍会被放行。用于字段映射时，truthy 判断还会把 `''`、`0`、`false` 与字段缺失混为一谈。

反例：

```ts
const payload = input.payload ? input.payload : {};
const record = input.payload as Record<string, unknown>;
const options =
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
```

正例：

```ts
// asRecord 代表所在包已有的共享 helper，实际名称以包内实现为准。
const payload = asRecord(input.payload) ?? {};
```

需要严格拒绝非法输入时，应使用所在包的 schema 或 validator 返回失败，不得用 `{}` 静默伪装为合法值。

### 可选字段映射

目标契约已将字段声明为可选时，直接传递字段值，不要仅为省略 `undefined` 增加条件对象展开。

反例：

```ts
const request = {
  ...(input.assistantId ? { agent: input.assistantId } : {}),
};
```

正例：

```ts
const request = {
  agent: input.assistantId,
};
```

仅当下游明确区分“字段缺失”和“字段值为 `undefined`”，或字段是否存在取决于真实业务条件时，才允许条件展开；
条件必须表达该语义，不能只做 truthy 判断。

## 错误处理与 fail-closed

设计、实现或评审 TypeScript/JavaScript 错误处理时，应参考
[`error-handling` skill](../../.agents/skills/error-handling/SKILL.md) 中的类型化错误、重试、
错误边界和用户提示等模式。

## 日志与脱敏

1. 日志和 diagnostics meta 必须经过脱敏边界。
2. 不记录 `ak`、`sk`、`token`、`authorization`、`cookie`、`secret`、`password`、`content`、`text`、`answers` 等敏感字段原文。
3. 新增 payload 或 meta 字段时按语义判断是否脱敏，不只依赖固定字段名列表。
4. 日志事件命名应稳定、可检索，并与模块职责一致。
