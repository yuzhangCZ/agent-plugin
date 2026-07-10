# 测试治理规则

**Version:** 1.1
**Date:** 2026-07-09
**Status:** Active
**Owner:** agent-plugin maintainers

本文定义 `agent-plugin` 仓库的长期测试治理规则。

## 基本原则

1. 验证范围随风险和影响面扩大：单包改动跑受影响包测试，跨插件或跨包契约改动优先跑 `pnpm verify:workspace`。
2. 测试应证明行为和契约，不复制实现细节。
3. 修改 public API、协议字段、配置项、包导出、构建或发布形态时，必须补充或更新契约测试。
4. 纯文档改动不运行代码测试，但必须校验路径、命令和作用域与仓库事实一致。

## 测试分层

| 层级 | 目标 | 禁止依赖 |
|---|---|---|
| unit | schema、normalizer、状态聚合、session state、纯逻辑 | 真实 host 进程、真实 bundle、真实网络、真实安装目录 |
| integration | 插件内部协作、fake runtime、fake connection、共享协议 fixture | 真实 OpenClaw 进程、真实安装目录、外部服务栈 |
| runtime-smoke | bundle 加载、注册、初始化、最小消息流 | 真实安装目录、完整 Redis/MariaDB/ai-gateway 栈 |

runtime-smoke 可使用临时 HOME/workspace、共享 mock gateway、bundle 产物和 OpenClaw CLI，但不得依赖真实安装目录或完整外部服务栈。

`packages/test-support` 只作为内部测试支持包；生产代码不得导入它。

## 验证选择

| 改动类型 | 最低验证 |
|---|---|
| 纯文档 | 路径、链接、命令和作用域检查 |
| 单包实现 | 受影响包测试 |
| public contract、入口导出、构建脚本、发布 manifest | 受影响包测试 + contract/build/pack 相关验证 |
| 跨包协议、runtime、gateway-client 语义 | 受影响包测试，优先 `pnpm verify:workspace` |
| 集成夹具或 submodule 指针 | `pnpm verify:integration:fixture` |
| OpenClaw runtime 行为 | `pnpm run test:openclaw:runtime` 或更聚焦的 OpenClaw runtime 测试 |

## 证据要求

1. 完成改动前必须记录实际运行过的验证命令和结果。
2. 未运行应运行的验证时，必须说明原因和剩余风险。
3. 测试失败不能只改期望值；先确认行为、契约和测试意图是否一致。
4. 如果测试暴露需要改变业务语义的问题，应停止扩大改动，并将语义变化作为独立任务评估。

## 测试支持边界

1. shared fixture、transport helper、timing helper 和 wire-level assertion 可以沉淀到 `packages/test-support`。
2. 宿主特定 runtime helper 留在对应插件测试目录。
3. 测试工具不得泄漏到生产依赖和发布产物。
