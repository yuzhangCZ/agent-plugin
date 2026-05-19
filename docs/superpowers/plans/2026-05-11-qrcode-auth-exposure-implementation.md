# 二维码授权能力暴露实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让二维码授权能力同时通过 `message-bridge` 宿主私有 Runtime API 和 `@wecode/bridge-runtime-sdk` 根入口稳定暴露，并保持插件产物零运行时依赖约束。

**架构：** 继续以 `@wecode/skill-qrcode-auth` 作为二维码授权语义真源。`message-bridge` 在构建期内嵌该能力并挂载到 `globalThis.__MB_RUNTIME_API__.qrcodeAuth`；`bridge-runtime-sdk` 通过 workspace/package 依赖稳定转导出同一套 facade 与类型，不新增新的生命周期或装配语义。

**技术栈：** TypeScript、Node.js `node:test`、`tsx/esm`、pnpm workspace、esbuild 打包产物验证

---

## 文件结构

**修改文件：**

- `plugins/message-bridge/src/index.ts`
  责任：扩展 `MessageBridgeRuntimeApi`，装配并挂载 `qrcodeAuth` capability。
- `plugins/message-bridge/package.json`
  责任：声明插件构建期所需的 `@wecode/skill-qrcode-auth` workspace 依赖。
- `pnpm-lock.yaml`
  责任：记录 `message-bridge` 与 `bridge-runtime-sdk` 新增 workspace 依赖后的锁文件状态，保证 CI 与本地安装可复现。
- `plugins/message-bridge/tests/integration/plugin.test.mjs`
  责任：验证源码入口安装的宿主 Runtime API 已暴露 `qrcodeAuth`，且能力与 runtime 生命周期解耦。
- `plugins/message-bridge/tests/integration/plugin-distribution.test.mjs`
  责任：验证打包产物安装的全局 Runtime API 也暴露 `qrcodeAuth`，且 Node package load 路径保持可用。
- `packages/bridge-runtime-sdk/src/index.ts`
  责任：在根入口稳定转导出 `qrcodeAuth` 与相关类型。
- `packages/bridge-runtime-sdk/package.json`
  责任：声明 SDK 对 `@wecode/skill-qrcode-auth` 的 package 依赖。
- `packages/bridge-runtime-sdk/tests/public-api-contract.test.ts`
  责任：验证 SDK 根入口新增稳定导出且未泄漏内部实现符号。
- `packages/bridge-runtime-sdk/tests/facade-assembly.test.ts`
  责任：验证根入口导出的 `qrcodeAuth` 可执行，且与能力真源入口保持同一引用语义。
- `docs/design/interfaces/bridge-runtime-sdk-integration.md`
  责任：补充 SDK 根入口聚合导出的二维码授权接入说明。

**不改文件：**

- `packages/skill-qrcode-auth/src/types.ts`
  责任：继续作为二维码授权类型真源；本次只消费，不重写语义。
- `plugins/message-bridge/docs/design/interfaces/private-status-api-contract.md`
  现状已写入 `qrcodeAuth` 摘要，本轮实现以其为验收基线，不再重复扩写。

### 任务 1：扩展 `message-bridge` 宿主 Runtime API

**文件：**
- 修改：`plugins/message-bridge/src/index.ts`
- 修改：`plugins/message-bridge/package.json`
- 测试：`plugins/message-bridge/tests/integration/plugin.test.mjs`

- [ ] **步骤 1：先写宿主 API 暴露测试，固定 `qrcodeAuth` 为新增契约**

```js
test('runtime api exposes qrcodeAuth after module load', async () => {
  const runtimeApi = getRuntimeApi();

  assert.ok(runtimeApi.qrcodeAuth);
  assert.strictEqual(typeof runtimeApi.qrcodeAuth.run, 'function');
});

test('qrcodeAuth remains callable without starting runtime', async () => {
  const snapshots = [];
  const runtimeApi = getRuntimeApi();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      qrcode: 'qr-1',
      weUrl: 'https://we.example.com/qr-1',
      pcUrl: 'https://pc.example.com/qr-1',
      expiresAt: '2026-05-11T00:00:00.000Z',
      status: 'WAIT_SCAN',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  try {
    await assert.rejects(
      runtimeApi.qrcodeAuth.run({
        channel: 'openx',
        mac: '',
        policy: {
          refreshOnExpired: false,
          maxRefreshCount: 0,
          pollIntervalMs: 1,
        },
        onSnapshot: (snapshot) => snapshots.push(snapshot),
      }),
      /timeout|network|fetch|status/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(snapshots[0]?.type, 'qrcode_generated');
});
```

- [ ] **步骤 2：运行插件集成测试，确认新契约当前失败**

运行：

```bash
node --import tsx/esm --test-isolation=none --test --test-timeout=60000 --test-force-exit plugins/message-bridge/tests/integration/plugin.test.mjs
```

预期：FAIL，报错类似 `Cannot read properties of undefined (reading 'run')` 或 `runtimeApi.qrcodeAuth` 不存在。

- [ ] **步骤 3：在源码入口装配 `qrcodeAuth` 并扩展接口定义**

```ts
import { qrcodeAuth } from '@wecode/skill-qrcode-auth';
import type { QrCodeAuth } from '@wecode/skill-qrcode-auth';

interface MessageBridgeRuntimeApi {
  getMessageBridgeStatus(): MessageBridgeStatusSnapshot;
  subscribeMessageBridgeStatus(
    listener: (snapshot: MessageBridgeStatusSnapshot) => void,
  ): () => void;
  startMessageBridgeRuntime(): Promise<void>;
  stopMessageBridgeRuntime(): void;
  qrcodeAuth: QrCodeAuth;
}

const runtimeApi: MessageBridgeRuntimeApi = getInstalledRuntimeApi() ?? Object.freeze({
  getMessageBridgeStatus,
  subscribeMessageBridgeStatus,
  startMessageBridgeRuntime,
  stopMessageBridgeRuntime,
  qrcodeAuth,
});
```

- [ ] **步骤 4：补齐插件构建期依赖声明，但不引入运行时外部依赖**

```json
{
  "devDependencies": {
    "@wecode/skill-qrcode-auth": "workspace:*"
  }
}
```

要求：

- 只放在 `devDependencies`，保持发布包 `files` 与运行时加载模型不变。
- 不新增插件对 `@wecode/skill-qrcode-auth` 的对外 named export。

- [ ] **步骤 5：刷新 workspace lockfile，确保依赖图可复现**

运行：

```bash
pnpm install --lockfile-only
```

预期：`pnpm-lock.yaml` 增加 `plugins/message-bridge` 对 `@wecode/skill-qrcode-auth` 的 workspace 依赖记录，且不引入无关 importer 漂移。

- [ ] **步骤 6：重新运行插件集成测试，确认宿主源码入口通过**

运行：

```bash
node --import tsx/esm --test-isolation=none --test --test-timeout=60000 --test-force-exit plugins/message-bridge/tests/integration/plugin.test.mjs
```

预期：PASS，且 `exports named and default as same plugin function` 与新增 `qrcodeAuth` 断言同时通过。

- [ ] **步骤 7：提交这一轮宿主 API 改造**

```bash
git add plugins/message-bridge/src/index.ts plugins/message-bridge/package.json plugins/message-bridge/tests/integration/plugin.test.mjs pnpm-lock.yaml
git commit -m "feat: expose qrcode auth on message bridge runtime api"
```

### 任务 2：验证 `message-bridge` 打包产物继续可加载且暴露 `qrcodeAuth`

**文件：**
- 修改：`plugins/message-bridge/tests/integration/plugin-distribution.test.mjs`
- 测试：`plugins/message-bridge/tests/integration/plugin-distribution.test.mjs`

- [ ] **步骤 1：先写分发产物断言，固定全局 Runtime API 的新 shape**

```js
function assertRuntimeApiInstalled() {
  const runtimeApi = globalThis.__MB_RUNTIME_API__;

  assert.ok(runtimeApi && typeof runtimeApi === 'object');
  assert.strictEqual(typeof runtimeApi.qrcodeAuth, 'object');
  assert.strictEqual(typeof runtimeApi.qrcodeAuth.run, 'function');
}
```

并补充 Node package load 路径的 stdout 断言：

```js
console.log(
  typeof api?.getMessageBridgeStatus,
  typeof api?.startMessageBridgeRuntime,
  typeof api?.stopMessageBridgeRuntime,
  typeof api?.subscribeMessageBridgeStatus,
  typeof api?.qrcodeAuth,
  typeof api?.qrcodeAuth?.run,
);
```

- [ ] **步骤 2：运行分发产物测试，确认当前构建产物还没带上该能力**

运行：

```bash
node --import tsx/esm --test-isolation=none --test --test-timeout=60000 --test-force-exit plugins/message-bridge/tests/integration/plugin-distribution.test.mjs
```

预期：FAIL，断言 `runtimeApi.qrcodeAuth` 不存在。

- [ ] **步骤 3：在测试里锁定“零运行时依赖但能力可用”的验收点**

```js
assertNoPrivateRuntimeNamedExports(mod);
assertRuntimeApiInstalled();
assert.strictEqual(typeof mod.qrcodeAuth, 'undefined');
```

说明：

- 插件模块对外仍只导出 `default` 与 `MessageBridgePlugin`。
- `qrcodeAuth` 只能经由 `globalThis.__MB_RUNTIME_API__` 访问，不能新增模块公共导出。

- [ ] **步骤 4：重新运行分发产物测试，确认 bundle 已内嵌该能力**

运行：

```bash
node --import tsx/esm --test-isolation=none --test --test-timeout=60000 --test-force-exit plugins/message-bridge/tests/integration/plugin-distribution.test.mjs
```

预期：PASS，打包产物导入后 `globalThis.__MB_RUNTIME_API__.qrcodeAuth.run` 可读取，且 package load 断言同步通过。

- [ ] **步骤 5：提交这一轮产物验证补强**

```bash
git add plugins/message-bridge/tests/integration/plugin-distribution.test.mjs
git commit -m "test: cover qrcode auth in plugin runtime artifact"
```

### 任务 3：扩展 `bridge-runtime-sdk` 根入口聚合导出

**文件：**
- 修改：`packages/bridge-runtime-sdk/package.json`
- 修改：`packages/bridge-runtime-sdk/src/index.ts`
- 修改：`packages/bridge-runtime-sdk/tests/public-api-contract.test.ts`
- 修改：`packages/bridge-runtime-sdk/tests/facade-assembly.test.ts`

- [ ] **步骤 1：先写 SDK 根入口契约测试，固定新增导出集合**

```ts
test('stable entry re-exports qrcode auth facade and related types', () => {
  assert.equal(typeof runtimeSdk.qrcodeAuth, 'object');
  assert.equal(typeof runtimeSdk.qrcodeAuth.run, 'function');
  assert.equal('createQrCodeAuthRuntime' in runtimeSdk, false);
});
```

在导出面断言中补充：

```ts
assert.equal('HttpQrCodeAuthService' in runtimeSdk, false);
assert.equal('QrCodeAuthSessionController' in runtimeSdk, false);
```

在装配测试中补充：

```ts
import { qrcodeAuth } from '@wecode/skill-qrcode-auth';
import * as runtimeSdk from '../src/index.ts';

test('sdk root re-exports qrcode auth singleton facade', () => {
  assert.strictEqual(runtimeSdk.qrcodeAuth, qrcodeAuth);
});
```

- [ ] **步骤 2：运行 SDK 测试，确认根入口尚未暴露二维码能力**

运行：

```bash
node --experimental-strip-types --test packages/bridge-runtime-sdk/tests/public-api-contract.test.ts packages/bridge-runtime-sdk/tests/facade-assembly.test.ts
```

预期：FAIL，报错 `runtimeSdk.qrcodeAuth` 为 `undefined`，或源码断言不满足。

- [ ] **步骤 3：为 SDK 增加 package 依赖并在根入口稳定转导出**

```json
{
  "dependencies": {
    "@agent-plugin/gateway-client": "workspace:*",
    "@agent-plugin/gateway-schema": "workspace:*",
    "@wecode/skill-qrcode-auth": "workspace:*"
  }
}
```

```ts
export {
  qrcodeAuth,
} from '@wecode/skill-qrcode-auth';

export type {
  QrCodeAuth,
  QrCodeAuthEnvironment,
  QrCodeAuthFailureReasonCode,
  QrCodeAuthPolicy,
  QrCodeAuthRunInput,
  QrCodeAuthServiceError,
  QrCodeAuthSnapshot,
  QrCodeDisplayData,
} from '@wecode/skill-qrcode-auth';
```

约束：

- 只做 stable re-export。
- 不新增 `createQrCodeAuthRuntime()`、宿主默认值 helper、或任何新的二维码装配 API。

- [ ] **步骤 4：刷新 workspace lockfile，确保 SDK 依赖变更被锁定**

运行：

```bash
pnpm install --lockfile-only
```

预期：`pnpm-lock.yaml` 增加 `packages/bridge-runtime-sdk` 对 `@wecode/skill-qrcode-auth` 的 workspace 依赖记录，且不破坏其他 importer。

- [ ] **步骤 5：重新运行 SDK 契约测试，确认根入口聚合导出通过**

运行：

```bash
node --experimental-strip-types --test packages/bridge-runtime-sdk/tests/public-api-contract.test.ts packages/bridge-runtime-sdk/tests/facade-assembly.test.ts
```

预期：PASS，且现有 “不暴露内部符号” 断言保持通过。

- [ ] **步骤 6：提交这一轮 SDK 根入口扩边**

```bash
git add packages/bridge-runtime-sdk/package.json packages/bridge-runtime-sdk/src/index.ts packages/bridge-runtime-sdk/tests/public-api-contract.test.ts packages/bridge-runtime-sdk/tests/facade-assembly.test.ts pnpm-lock.yaml
git commit -m "feat: re-export qrcode auth from bridge runtime sdk"
```

### 任务 4：更新 SDK 接入文档并完成受影响验证

**文件：**
- 修改：`docs/design/interfaces/bridge-runtime-sdk-integration.md`
- 测试：`packages/bridge-runtime-sdk/tests/public-api-contract.test.ts`
- 测试：`plugins/message-bridge/tests/integration/plugin.test.mjs`
- 测试：`plugins/message-bridge/tests/integration/plugin-distribution.test.mjs`

- [ ] **步骤 1：补充 SDK 文档中的根入口导入示例与语义说明**

```md
import {
  createBridgeRuntime,
  qrcodeAuth,
  type QrCodeAuthRunInput,
  type QrCodeAuthSnapshot,
} from '@wecode/bridge-runtime-sdk';
```

```md
- `qrcodeAuth` 属于根入口聚合导出能力，不并入 `BridgeRuntimeOptions`。
- 调用方仍需自行提供 `channel`、`mac` 与 `onSnapshot`。
- 该导出与 `@wecode/skill-qrcode-auth` 的 public contract 保持一致。
```

- [ ] **步骤 2：运行 `message-bridge` 受影响测试集**

运行：

```bash
pnpm --dir plugins/message-bridge test -- --test-name-pattern="plugin contract|plugin distribution artifact"
```

预期：PASS；如脚本不接受筛选参数，则退回分别执行两个 `node --test ...` 文件命令。

- [ ] **步骤 3：运行 `bridge-runtime-sdk` 全量测试**

运行：

```bash
pnpm --dir packages/bridge-runtime-sdk test
```

预期：PASS，新增二维码导出不会破坏现有 runtime/provider 相关测试。

- [ ] **步骤 4：执行跨边界回归验证**

运行：

```bash
pnpm verify:workspace
```

预期：PASS；重点确认：

- `packages/skill-qrcode-auth` 可正常 build / pack
- `plugins/message-bridge` 打包产物仍通过 pack/check
- `bridge-runtime-sdk` 新依赖未破坏 workspace 构建和测试边界

- [ ] **步骤 5：提交文档与最终验证收口**

```bash
git add docs/design/interfaces/bridge-runtime-sdk-integration.md
git commit -m "docs: document qrcode auth sdk entrypoint"
```

## 自检结果

### 规格覆盖度

- `message-bridge` 私有 Runtime API 扩版：由任务 1、任务 2 覆盖。
- `bridge-runtime-sdk` 根入口聚合导出：由任务 3 覆盖。
- 不改变 `skill-qrcode-auth` 语义真源：通过文件结构中的“不改文件”与任务约束明确锁定。
- 宿主与 runtime 生命周期解耦：由任务 1 的测试与实现约束覆盖。
- SDK 只做 stable re-export、不新增新装配面：由任务 3 的实现约束覆盖。
- 文档侧 SDK 接入说明更新：由任务 4 覆盖。

### 占位符扫描

本计划未使用 “TODO”“后续实现”“适当处理” 之类占位词；每个步骤都给出目标文件、代码骨架、命令和预期结果。

### 类型一致性

- 宿主 API 始终使用 `qrcodeAuth: QrCodeAuth`。
- SDK 根入口始终使用 `qrcodeAuth` 与 `QrCodeAuth*` 现有类型名。
- 未引入 `runQrCodeAuth()`、`createHostQrCodeAuth()` 等新命名，避免与冻结设计冲突。
- SDK 验收标准只锁定稳定导出与禁止泄漏的内部装配符号，不绑定具体源码写法。

计划已完成并保存到 `docs/superpowers/plans/2026-05-11-qrcode-auth-exposure-implementation.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
