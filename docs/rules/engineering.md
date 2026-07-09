# 代码治理规则

**Version:** 1.0
**Date:** 2026-06-18
**Status:** Active
**Owner:** agent-plugin maintainers
**Related:** `../../AGENTS.md`, `./testing.md`, `./change-management.md`

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

1. TypeScript 导出接口、导出类、导出函数默认使用 TSDoc 注释块 `/** ... */`。
2. 关键流程接口、跨层边界入口、统一发送出口必须补充简洁中文注释，说明职责边界、输入输出语义或 fail-closed 约束。
3. 优先注释 `facade`、`port`、`validator`、runtime 协作对象、统一发送/校验入口。
4. 不要求为简单 getter、纯数据字段或显而易见的实现细节补注释。
5. 注释应解释“为什么这里存在”“边界是什么”“为什么这样做”，避免重复代码字面含义。
6. 关键分支允许使用 1-2 行中文行注释 `//`，用于说明非直观决策、兼容约束、重连、状态机或 READY gating 等关键行为。
7. 推荐使用精简 TSDoc 标签：`@remarks`、`@param`、`@returns`、`@throws`、`@deprecated`。
8. 禁止空洞或翻译式注释，例如“设置变量”“发送消息”“判断状态”。

## 类型与协议边界

1. JSON 对象、plain object、数组、字符串等协议边界判断必须优先使用所在包内共享 type guard 或 schema helper。
2. 禁止在业务文件中重复散落 `value !== null && typeof value === 'object' && !Array.isArray(value)` 这类对象判断。
3. 如果所在包缺少对应 helper，应先补充包内共享工具，再在业务逻辑中引用。
4. 跨包不要为了复用 type guard 引入反向依赖；各包可保留自己的边界工具，但同一包内必须收敛到一处。

## 错误处理与 fail-closed

1. 协议边界、provider fact、gateway 状态和 public 输入非法时，默认 fail-closed，不继续投影正常业务消息。
2. 对外错误要提供稳定分类；diagnostics 可保留排障所需的原始 code/message。
3. 查询型健康检查或状态查询不应写入失败诊断，除非它表示 runtime 失败事件。
4. 错误处理不得吞掉可操作上下文；也不得向用户或日志暴露敏感字段原文。

## 日志与脱敏

1. 日志和 diagnostics meta 必须经过脱敏边界。
2. 不记录 `ak`、`sk`、`token`、`authorization`、`cookie`、`secret`、`password`、`content`、`text`、`answers` 等敏感字段原文。
3. 新增 payload 或 meta 字段时按语义判断是否脱敏，不只依赖固定字段名列表。
4. 日志事件命名应稳定、可检索，并与模块职责一致。
