# bridge-runtime-sdk Unit Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 `packages/bridge-runtime-sdk` 的 focused unit test 覆盖，并让 unit-only 覆盖口径可以稳定执行和审查。

**Architecture:** 保持生产代码不变，先建立 `tests/unit/**/*.test.ts` 的独立执行入口，再按源码目录补充一文件一单元的 focused tests。现有跨多层协作测试要么拆成对应单元测试，要么移动到 integration，避免 `unit` 目录承载隐式集成测试。

**Tech Stack:** Node.js built-in test runner, TypeScript strip-types, package-local `@/...` alias loader, pnpm workspace scripts.

## Global Constraints

- 不修改生产行为；本计划只允许修改测试、测试脚本和测试辅助代码。
- 单元测试按源码目录镜像组织：`tests/unit/<source-dir>/<SourceFile>.test.ts`。
- 单元测试优先 fake/mock 直接依赖；跨 usecase/coordinator/projector/registry 的真实装配应放入 `tests/integration/`。
- 新增测试优先使用 `@/...` import alias，不新增深层 `../../../src/...`。
- 每个任务完成后至少运行 task-local test；最终运行 package test 和 typecheck。

---

## File Structure

- Modify: `packages/bridge-runtime-sdk/scripts/test.mjs`
  - 允许从 CLI 传入 test glob，默认仍为 `tests/**/*.test.ts`。
  - 允许通过环境变量开启 Node test coverage。
- Modify: `packages/bridge-runtime-sdk/package.json`
  - 新增 `test:unit` 和 `coverage:unit` scripts。
- Create: `packages/bridge-runtime-sdk/tests/unit/application/usecases/*.test.ts`
  - 为每个 usecase 建立 focused unit test。
- Create: `packages/bridge-runtime-sdk/tests/unit/application/lifecycle/*.test.ts`
  - 为 lifecycle state/service/probe 建立 focused unit test。
- Create: `packages/bridge-runtime-sdk/tests/unit/application/runtime/RuntimeCoreService.test.ts`
  - 覆盖 runtime core start/stop provider lifecycle。
- Create: `packages/bridge-runtime-sdk/tests/unit/application/RuntimeCommandDispatcher.test.ts`
  - 覆盖 command routing 和 observation。
- Split: `packages/bridge-runtime-sdk/tests/unit/application/runtime-observation/RuntimeObservation.test.ts`
  - 拆到 application observation、adapters observation、adapters provider 对应测试文件。
- Split or move: `packages/bridge-runtime-sdk/tests/unit/application/coordinators/OutboundCoordinator.test.ts`
  - 保留 focused unit 测试；将真实多组件装配用例移动到 integration。
- Create: `packages/bridge-runtime-sdk/tests/unit/application/projectors/*.test.ts`
  - 补齐 default projectors 和 request-run failure projector 的 focused tests。
- Create: `packages/bridge-runtime-sdk/tests/unit/adapters/provider/ProviderResultValidator.test.ts`
  - 覆盖 provider 结果规范化。
- Create: `packages/bridge-runtime-sdk/tests/unit/infrastructure/registries/PermissionPresentationRegistry.test.ts`
  - 覆盖 permission presentation registry 的直接契约。

---

### Task 1: Unit-Only Test Runner

**Files:**
- Modify: `packages/bridge-runtime-sdk/scripts/test.mjs`
- Modify: `packages/bridge-runtime-sdk/package.json`

**Interfaces:**
- Consumes: existing `scripts/register-test-alias-loader.mjs`.
- Produces:
  - `pnpm --dir packages/bridge-runtime-sdk run test:unit`
  - `pnpm --dir packages/bridge-runtime-sdk run coverage:unit`

- [ ] **Step 1: Write the script contract test**

Add assertions to `packages/bridge-runtime-sdk/tests/contract/import-alias.test.ts`:

```ts
test('package exposes unit-only test scripts', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { scripts?: Record<string, string> };

  assert.match(packageJson.scripts?.['test:unit'] ?? '', /tests\/unit\/\*\*\/\*\.test\.ts/);
  assert.match(packageJson.scripts?.['coverage:unit'] ?? '', /BRIDGE_RUNTIME_SDK_TEST_COVERAGE=1/);
});

test('test runner accepts explicit test globs and optional coverage flag', async () => {
  const source = await readFile(new URL('../../scripts/test.mjs', import.meta.url), 'utf8');

  assert.match(source, /process\.argv\.slice\(2\)/);
  assert.match(source, /BRIDGE_RUNTIME_SDK_TEST_COVERAGE/);
});
```

- [ ] **Step 2: Run contract test to verify it fails**

Run:

```bash
pnpm --dir packages/bridge-runtime-sdk test
```

Expected: FAIL because `test:unit`, `coverage:unit`, and argv handling do not exist yet.

- [ ] **Step 3: Update `scripts/test.mjs`**

Change the `main()` test args construction to this shape:

```js
async function main() {
  await prepareWorkspaceDeps();
  const testGlobs = process.argv.slice(2);
  const nodeArgs = [
    '--import',
    './scripts/register-test-alias-loader.mjs',
    '--experimental-strip-types',
    ...(process.env.BRIDGE_RUNTIME_SDK_TEST_COVERAGE === '1' ? ['--experimental-test-coverage'] : []),
    '--test',
    ...(testGlobs.length > 0 ? testGlobs : ['tests/**/*.test.ts']),
  ];

  await run(process.execPath, nodeArgs, { cwd: packageDir });
}
```

- [ ] **Step 4: Update package scripts**

Modify `packages/bridge-runtime-sdk/package.json` scripts:

```json
{
  "test": "node ./scripts/test.mjs",
  "test:unit": "node ./scripts/test.mjs tests/unit/**/*.test.ts",
  "coverage:unit": "BRIDGE_RUNTIME_SDK_TEST_COVERAGE=1 node ./scripts/test.mjs tests/unit/**/*.test.ts"
}
```

- [ ] **Step 5: Verify task**

Run:

```bash
pnpm --dir packages/bridge-runtime-sdk run test:unit
pnpm --dir packages/bridge-runtime-sdk test
```

Expected: both PASS.

---

### Task 2: Usecase Unit Coverage

**Files:**
- Create: `packages/bridge-runtime-sdk/tests/unit/application/usecases/StartRequestRunUseCase.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/usecases/AbortExecutionUseCase.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/usecases/CreateSessionUseCase.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/usecases/CloseSessionUseCase.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/usecases/ListSlashCommandsUseCase.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/usecases/QueryStatusUseCase.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/usecases/ReplyQuestionUseCase.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/usecases/ReplyPermissionUseCase.test.ts`
- Refactor: move the usecase section out of `packages/bridge-runtime-sdk/tests/unit/application/runtime-observation/RuntimeObservation.test.ts`

**Interfaces:**
- Consumes: usecase classes from `@/application/usecases/index.ts`.
- Produces: one focused test file per usecase.

- [ ] **Step 1: Add shared local fakes per test file**

Each usecase test file should define only the fakes it needs, using this pattern:

```ts
class RecordingObservation {
  readonly events: Array<{ method: string; args: unknown[] }> = [];

  usecaseStarted(...args: unknown[]): void {
    this.events.push({ method: 'usecaseStarted', args });
  }

  usecaseSucceeded(...args: unknown[]): void {
    this.events.push({ method: 'usecaseSucceeded', args });
  }

  usecaseFailed(...args: unknown[]): void {
    this.events.push({ method: 'usecaseFailed', args });
  }

  usecaseConflict(...args: unknown[]): void {
    this.events.push({ method: 'usecaseConflict', args });
  }
}
```

Use `as never` only at the construction boundary when the fake intentionally implements a narrow subset of a port.

- [ ] **Step 2: Cover `StartRequestRunUseCase`**

`StartRequestRunUseCase.test.ts` must include these tests:

```ts
test('StartRequestRunUseCase acquires request run, calls provider, delegates run, then releases lock', async () => {
  // assert provider receives traceId, generated runId, toolSessionId, text, assistantId, extParameters, context
  // assert coordinator receives same runId and welinkSessionId
  // assert releaseRequestRun is called in finally
  // assert observation emits started and succeeded
});

test('StartRequestRunUseCase rejects active run conflict before provider call', async () => {
  // arrange acquireRequestRun returns { ok: false }
  // assert RuntimeContractError code is run_already_active
  // assert provider and coordinator are not called
  // assert usecaseConflict is recorded
});

test('StartRequestRunUseCase releases request run when provider throws', async () => {
  // arrange provider.startRequestRun throws
  // assert releaseRequestRun still runs
  // assert usecaseFailed is recorded
});
```

- [ ] **Step 3: Cover `AbortExecutionUseCase`**

`AbortExecutionUseCase.test.ts` must include these tests:

```ts
test('AbortExecutionUseCase forwards active run id and clears permission presentation state', async () => {
  // arrange getActiveRequestRunId returns run-active
  // assert abortExecution receives run-active
  // assert factEnricher.clearSession is called with toolSessionId
  // assert observation emits started and succeeded
});

test('AbortExecutionUseCase forwards undefined run id when no active run exists', async () => {
  // arrange getActiveRequestRunId returns undefined
  // assert abortExecution receives runId undefined
});

test('AbortExecutionUseCase records failed observation and does not swallow provider failure', async () => {
  // arrange abortExecution throws provider_down
  // assert rejects
  // assert usecaseFailed is recorded
});
```

- [ ] **Step 4: Cover simple gateway response usecases**

Create focused tests for these classes:

```ts
test('QueryStatusUseCase sends projected status response on provider success', async () => {});
test('QueryStatusUseCase sends fallback empty status and records failure on provider failure', async () => {});

test('ListSlashCommandsUseCase sends projected slash command list on provider success', async () => {});
test('ListSlashCommandsUseCase sends empty slash command list and records failure on provider failure', async () => {});

test('CreateSessionUseCase sends projected session_created response and preserves welinkSessionId', async () => {});
test('CreateSessionUseCase records failed observation when provider throws', async () => {});
```

- [ ] **Step 5: Cover reply and close usecases**

Create focused tests:

```ts
test('ReplyQuestionUseCase consumes pending question token and forwards normalized reply', async () => {});
test('ReplyQuestionUseCase projects tool_error when pending question token is missing', async () => {});

test('ReplyPermissionUseCase consumes pending permission token and forwards reply', async () => {});
test('ReplyPermissionUseCase projects tool_error when pending permission token is missing', async () => {});

test('CloseSessionUseCase forwards closeSession and clears session runtime registry', async () => {});
test('CloseSessionUseCase records failed observation when provider throws', async () => {});
```

- [ ] **Step 6: Remove duplicated usecase assertions from mixed observation test**

Delete only the `usecases emit failed observation events for non request-run failures` test from `RuntimeObservation.test.ts` after equivalent focused usecase tests pass.

- [ ] **Step 7: Verify task**

Run:

```bash
pnpm --dir packages/bridge-runtime-sdk run test:unit
pnpm --dir packages/bridge-runtime-sdk test
```

Expected: both PASS.

---

### Task 3: Lifecycle, Runtime Core, and Dispatcher Unit Coverage

**Files:**
- Create: `packages/bridge-runtime-sdk/tests/unit/application/lifecycle/RuntimeLifecycleState.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/lifecycle/RuntimeLifecycleService.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/lifecycle/RuntimeProbeService.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/runtime/RuntimeCoreService.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/RuntimeCommandDispatcher.test.ts`

**Interfaces:**
- Consumes: lifecycle/runtime classes from `@/application/lifecycle/*`, `@/application/runtime/*`, and `@/application/RuntimeCommandDispatcher.ts`.
- Produces: focused coverage for runtime state transitions without using gateway host integration fixtures.

- [ ] **Step 1: Cover `RuntimeLifecycleState`**

Add tests:

```ts
test('RuntimeLifecycleState transitions idle -> starting -> ready and ignores stale start attempt', () => {});
test('RuntimeLifecycleState transitions ready -> stopping -> idle and ignores stale stop attempt', () => {});
test('RuntimeLifecycleState records immutable failed snapshots', () => {});
```

- [ ] **Step 2: Cover `RuntimeLifecycleService`**

Use fake `RuntimeCore`, fake `GatewayRuntimeDriver`, and recording observation. Add tests:

```ts
test('RuntimeLifecycleService starts core and gateway once for concurrent start calls', async () => {});
test('RuntimeLifecycleService disconnects gateway when core stop succeeds', async () => {});
test('RuntimeLifecycleService waits for in-flight stop before a new start', async () => {});
test('RuntimeLifecycleService maps provider start failure into failed runtime status', async () => {});
test('RuntimeLifecycleService maps gateway closed failure into failed runtime status', () => {});
```

- [ ] **Step 3: Cover `RuntimeProbeService`**

Use fake `GatewayProbeDriver`. Add tests:

```ts
test('RuntimeProbeService short-circuits ready runtime without temporary probe', async () => {});
test('RuntimeProbeService skips temporary probe while lifecycle is busy', async () => {});
test('RuntimeProbeService deduplicates concurrent probes by timeout', async () => {});
test('RuntimeProbeService cancels active probes and swallows cancellation rejection', async () => {});
test('RuntimeProbeService maps synchronous probe throw through probe failure classifier', async () => {});
```

- [ ] **Step 4: Cover `RuntimeCoreService`**

Use fake provider lifecycle. Add tests:

```ts
test('RuntimeCoreService starts provider once and reports status', async () => {});
test('RuntimeCoreService stops provider once after start', async () => {});
test('RuntimeCoreService leaves stopped status when provider start fails', async () => {});
```

- [ ] **Step 5: Cover `RuntimeCommandDispatcher`**

Use fake usecase map and recording observation. Add tests:

```ts
test('RuntimeCommandDispatcher routes command by kind and records completed observation', async () => {});
test('RuntimeCommandDispatcher records failed observation and rethrows usecase errors', async () => {});
test('RuntimeCommandDispatcher extracts toolSessionId and welinkSessionId from source payload context', async () => {});
```

- [ ] **Step 6: Verify task**

Run:

```bash
pnpm --dir packages/bridge-runtime-sdk run test:unit
```

Expected: PASS.

---

### Task 4: Split Mixed Unit Tests and Fill Projector/Adapter Gaps

**Files:**
- Split: `packages/bridge-runtime-sdk/tests/unit/application/runtime-observation/RuntimeObservation.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/runtime-observation/DefaultRuntimeObservation.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/runtime-observation/CompositeRuntimeObservationPort.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/adapters/observation/BridgeGatewayLoggerObservationAdapter.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/adapters/observation/RuntimeTraceCollectorAdapter.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/adapters/provider/ObservedProviderCommandHandlers.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/adapters/provider/ProviderResultValidator.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/projectors/DefaultFactToSkillEventProjector.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/projectors/DefaultGatewayCommandResultProjector.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/projectors/DefaultRunTerminalSignalProjector.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/projectors/DefaultSkillEventToGatewayMessageProjector.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/application/projectors/RequestRunFailureToolErrorProjector.test.ts`
- Create: `packages/bridge-runtime-sdk/tests/unit/infrastructure/registries/PermissionPresentationRegistry.test.ts`
- Move or refactor: `packages/bridge-runtime-sdk/tests/unit/application/coordinators/OutboundCoordinator.test.ts`

**Interfaces:**
- Consumes: existing behavior currently covered in mixed unit/integration tests.
- Produces: one focused unit test file per production unit.

- [ ] **Step 1: Split runtime observation tests**

Move existing assertions as follows:

```text
logger observation adapter projects observation events into runtime_sdk logs
  -> tests/unit/adapters/observation/BridgeGatewayLoggerObservationAdapter.test.ts

trace observation adapter keeps diagnostics in sync with observation events
  -> tests/unit/adapters/observation/RuntimeTraceCollectorAdapter.test.ts

default runtime observation maps semantic methods into standard events
  -> tests/unit/application/runtime-observation/DefaultRuntimeObservation.test.ts

observed provider handlers emit started and failed observation events
  -> tests/unit/adapters/provider/ObservedProviderCommandHandlers.test.ts
```

Add a small `CompositeRuntimeObservationPort` test:

```ts
test('CompositeRuntimeObservationPort fans out each event to every port in order', () => {});
```

Delete `RuntimeObservation.test.ts` after all moved tests pass.

- [ ] **Step 2: Add provider validator focused test**

`ProviderResultValidator.test.ts`:

```ts
test('ProviderResultValidator keeps valid slash commands and trims descriptions', () => {});
test('ProviderResultValidator drops slash commands without a single slash command token', () => {});
```

- [ ] **Step 3: Add missing projector focused tests**

Add one test file per projector:

```ts
test('DefaultFactToSkillEventProjector maps message lifecycle and text facts into skill events', () => {});
test('DefaultGatewayCommandResultProjector maps status, slash commands, session created, and tool_error results', () => {});
test('DefaultRunTerminalSignalProjector maps completed result to tool_done and error result to tool_error', () => {});
test('DefaultSkillEventToGatewayMessageProjector wraps skill events in gateway tool_event messages', () => {});
test('RequestRunFailureToolErrorProjector emits request_run_failed tool_error for active run lifecycle failures', () => {});
```

- [ ] **Step 4: Add permission presentation registry test**

`PermissionPresentationRegistry.test.ts`:

```ts
test('permission presentation registry stores, retrieves, and clears presentation context by session and permission id', () => {});
test('permission presentation registry overwrites duplicate permission id in the same session without affecting another session', () => {});
```

- [ ] **Step 5: Clean up `OutboundCoordinator` layer purity**

Choose one of these outcomes during implementation:

```text
Preferred:
  Convert tests/unit/application/coordinators/OutboundCoordinator.test.ts to use faked projectors, sink, observation, registries, and interaction coordinator so it stays focused on OutboundCoordinator branching.

Allowed:
  Move the current real-collaborator tests to tests/integration/application/coordinators/OutboundCoordinator.test.ts, then create a smaller unit test file for OutboundCoordinator with fakes.
```

Focused unit assertions must include:

```ts
test('OutboundCoordinator releases outbound emission lock when sink send throws', async () => {});
test('OutboundCoordinator records terminal received/projected events before sending terminal uplink', async () => {});
```

- [ ] **Step 6: Verify task**

Run:

```bash
pnpm --dir packages/bridge-runtime-sdk run test:unit
pnpm --dir packages/bridge-runtime-sdk test
```

Expected: both PASS.

---

### Task 5: Coverage Review and Acceptance Gate

**Files:**
- Modify only if needed: `packages/bridge-runtime-sdk/package.json`
- No production source changes.

**Interfaces:**
- Consumes: all unit tests from Tasks 1-4.
- Produces: repeatable evidence for unit coverage and full package health.

- [ ] **Step 1: Run unit-only coverage**

Run:

```bash
pnpm --dir packages/bridge-runtime-sdk run coverage:unit
```

Expected: PASS, with Node test coverage output. Use the report as a trend signal, not as a hard release gate unless thresholds are later agreed.

- [ ] **Step 2: Inspect unit file structure**

Run:

```bash
find packages/bridge-runtime-sdk/tests/unit -type f | sort
```

Expected:

```text
tests/unit/application/usecases contains one test file per usecase.
tests/unit/application/lifecycle contains one test file per lifecycle unit.
tests/unit/application/projectors contains one test file per projector.
tests/unit/adapters contains adapter focused tests.
tests/unit/infrastructure/registries contains one test file per registry.
```

- [ ] **Step 3: Check for mixed-layer unit tests**

Run:

```bash
rg -n "@/infrastructure|@/adapters|@/application/coordinators|@/application/projectors" packages/bridge-runtime-sdk/tests/unit/application
```

Expected: review each hit. Hits are allowed only when the source unit under test directly depends on that collaborator and the test uses it intentionally; otherwise replace with fakes or move the test to integration.

- [ ] **Step 4: Run final verification**

Run:

```bash
pnpm --dir packages/bridge-runtime-sdk run test:unit
pnpm --dir packages/bridge-runtime-sdk test
pnpm --dir packages/bridge-runtime-sdk run typecheck
```

Expected: all PASS.

- [ ] **Step 5: Record outcome**

Final implementation note must include:

```text
Unit files added/split:
- <count> files under tests/unit

Verification:
- pnpm --dir packages/bridge-runtime-sdk run test:unit: PASS
- pnpm --dir packages/bridge-runtime-sdk test: PASS
- pnpm --dir packages/bridge-runtime-sdk run typecheck: PASS

Known residual risk:
- <only list if a source unit remains intentionally covered by integration rather than unit>
```

---

## Acceptance Criteria

- `packages/bridge-runtime-sdk/tests/unit` mirrors major source responsibilities instead of grouping unrelated units into large files.
- `StartRequestRunUseCase`, `AbortExecutionUseCase`, `RequestRunCoordinator`, `RuntimeLifecycleService`, and `RuntimeProbeService` have focused unit coverage before active-run policy implementation proceeds.
- Existing integration behavior remains unchanged: `pnpm --dir packages/bridge-runtime-sdk test` passes.
- Unit-only command exists and passes: `pnpm --dir packages/bridge-runtime-sdk run test:unit`.
- Coverage command exists for local review: `pnpm --dir packages/bridge-runtime-sdk run coverage:unit`.
- No root-level ordinary `.test.ts` files are reintroduced under `packages/bridge-runtime-sdk/tests`.

## Self-Review

- Spec coverage: plan addresses unit coverage degree, source-mirrored unit structure, mixed-layer cleanup, and repeatable verification.
- Placeholder scan: no task uses TBD/TODO/fill-in-later. Empty test bodies in examples name exact assertions to implement and are not accepted final code.
- Type consistency: all referenced paths and scripts are scoped to `packages/bridge-runtime-sdk`; `@/...` alias remains package-internal.
