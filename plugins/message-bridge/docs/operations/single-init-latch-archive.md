# Message-Bridge 单进程单次初始化方案归档

**Version:** 1.0  
**Date:** 2026-04-07  
**Status:** Active  
**Owner:** message-bridge maintainers  
**Related:** `./change-log.md`, `../product/prd.md`, `../../src/runtime/singleton.ts`

## 背景

在 OpenCode 多工作区场景下，不同工作区实例会重复触发插件入口。若首次连接失败，后续入口调用会再次执行初始化，产生重复握手与噪音日志，影响排障效率。

## 决策

本次采用“单进程仅一次初始化尝试”的最简策略：

1. 进程内仅允许一次 `BridgeRuntime.start()` 尝试。
2. 首次尝试若失败（不区分失败类型），状态锁存为 `failed_latched`。
3. 首次尝试成功后状态为 `succeeded`。当运行态被停止后，入口不会隐式重试初始化。
4. 仅 `stopRuntime()` 显式重置门禁后，才允许下一次初始化尝试。
5. 测试通过 `__resetRuntimeForTests()` 强制重置状态。

## 状态机定义

`singleton` 使用显式状态机：

- `never`
- `initializing`
- `succeeded`
- `failed_latched`

状态流转：

- `never -> initializing -> succeeded`
- `never -> initializing -> failed_latched`
- `succeeded`：仅复用既有 runtime，不再进入重复初始化
- `failed_latched`：直接阻断，不再进入重复初始化
- `stopRuntime()`：重置到 `never`，允许下一次初始化尝试

## 行为边界

### In Scope

- `plugins/message-bridge/src/runtime/singleton.ts` 初始化门禁与状态机。
- 插件侧日志增强与集成测试覆盖。

### Out of Scope

- 不修改 `ai-gateway` / `skill-server`。
- 不引入冷却窗口、配置指纹或自动恢复策略。

### External Dependencies

- OpenCode 进程/工作区生命周期由宿主控制；本方案仅保证单进程内行为。

## 测试覆盖与验证

新增/更新集成测试覆盖以下场景：

1. 首次失败后，跨工作区再次调用入口会被直接阻断。
2. 失败后无第二次初始化副作用（如 WebSocket 构造次数不增加）。
3. 并发首次调用共享同一个 `initializing` Promise。
4. 首次成功后，多工作区调用复用同一 runtime，且 `stopRuntime()` 可重置并再次初始化。

验证命令：

```bash
pnpm --filter @wecode/skill-opencode-plugin test:integration -- tests/integration/plugin.test.mjs
```
