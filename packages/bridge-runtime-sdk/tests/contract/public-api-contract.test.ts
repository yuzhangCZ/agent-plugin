import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as runtimeSdk from '@/index.ts';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function assertTypeFixturePasses(tsconfigPath: string): Promise<void> {
  try {
    await execFileAsync('pnpm', ['exec', 'tsc', '--noEmit', '-p', tsconfigPath], {
      cwd: packageRoot,
    });
  } catch (error) {
    const output = typeof error === 'object' && error
      ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`.trim()
      : '';
    assert.fail(output || (error instanceof Error ? error.message : String(error)));
  }
}

test('stable entry exports executable runtime factory and public contracts', () => {
  assert.equal(typeof runtimeSdk.createBridgeRuntime, 'function');
  assert.equal(typeof runtimeSdk.resolvePackageVersion, 'function');
  assert.equal(typeof runtimeSdk.qrcodeAuth, 'object');
  assert.equal(typeof runtimeSdk.qrcodeAuth.run, 'function');
});

test('public contract keeps qrcode auth types owned by skill-qrcode-auth', async () => {
  const publicContractSource = await readFile(new URL('../../src/public-contract.ts', import.meta.url), 'utf8');
  const indexSource = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');

  assert.match(publicContractSource, /export \{ qrcodeAuth \} from '@wecode\/skill-qrcode-auth';/);
  assert.match(publicContractSource, /QrCodeAssistantInfo/);
  assert.match(publicContractSource, /from '@wecode\/skill-qrcode-auth';/);
  assert.equal(indexSource.includes("from './public-contract.ts';"), true);
});

test('stable entry does not expose internal facade skeleton symbols', () => {
  assert.equal('BridgeRuntimeFacade' in runtimeSdk, false);
  assert.equal('DefaultRuntimeCommandDispatcher' in runtimeSdk, false);
  assert.equal('toRuntimeCommand' in runtimeSdk, false);
  assert.equal('createGatewayClientBridgeRuntime' in runtimeSdk, false);
  assert.equal('probeBridgeGatewayHost' in runtimeSdk, false);
  assert.equal('createQrCodeAuthRuntime' in runtimeSdk, false);
  assert.equal('HttpQrCodeAuthService' in runtimeSdk, false);
  assert.equal('QrCodeAuthSessionController' in runtimeSdk, false);
});

test('public api positive type fixture locks BridgeRuntime status snapshot shape', async () => {
  await assertTypeFixturePasses('tests/type-contracts/tsconfig.positive.json');
});

test('runtime error public contract uses reason-oriented class-first codes', async () => {
  const source = await readFile(new URL('../../src/public-contract.ts', import.meta.url), 'utf8');
  const runtimeErrorSource = await readFile(new URL('../../src/application/runtime-error.ts', import.meta.url), 'utf8');
  const indexSource = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  const runtimeSource = await readFile(new URL('../../src/application/runtime.ts', import.meta.url), 'utf8');
  const lifecycleSource = await readFile(
    new URL('../../src/application/lifecycle/RuntimeLifecycleService.ts', import.meta.url),
    'utf8',
  );
  const probeSource = await readFile(
    new URL('../../src/application/lifecycle/RuntimeProbeService.ts', import.meta.url),
    'utf8',
  );

  assert.equal(source.includes("'gateway_transport_error'"), true);
  assert.equal(source.includes("'provider_unavailable'"), true);
  assert.equal(source.includes("'runtime_start_failed'"), false);
  assert.equal(source.includes("'runtime_stop_failed'"), false);
  assert.equal(source.includes("'runtime_probe_failed'"), false);
  assert.equal(source.includes('export class BridgeRuntimeError extends Error'), true);
  assert.equal(runtimeErrorSource.includes('export type BridgeRuntimeErrorCode ='), false);
  assert.equal(runtimeErrorSource.includes('export class BridgeRuntimeError'), false);
  assert.equal(indexSource.includes("from './application/runtime-error.ts'"), false);
  assert.equal(source.includes('toBridgeRuntimeError'), false);
  assert.equal(source.includes('isCancelledGatewayRuntimeError'), false);
  assert.equal(lifecycleSource.includes('toBridgeRuntimeError'), false);
  assert.equal(lifecycleSource.includes('isCancelledGatewayRuntimeError'), false);
  assert.equal(lifecycleSource.includes('private async startCoreOrFail'), true);
  assert.equal(lifecycleSource.includes('private async connectGatewayOrFail'), true);
  assert.equal(probeSource.includes('toBridgeRuntimeError'), false);
  assert.match(runtimeSource, /error\?: BridgeRuntimeError;/);
});

test('public api negative type fixture rejects extra runtime status fields', async () => {
  await assert.rejects(
    execFileAsync(
      'pnpm',
      ['exec', 'tsc', '--noEmit', '-p', 'tests/type-contracts/tsconfig.negative-status-fields.json'],
      { cwd: packageRoot },
    ),
    (error) => {
      const output = typeof error === 'object' && error
        ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
        : '';
      return output.includes('failure')
        && output.includes('code')
        && output.includes('phase');
    },
  );
});

test('public api negative type fixture rejects gateway-only runtime status state', async () => {
  await assert.rejects(
    execFileAsync(
      'pnpm',
      ['exec', 'tsc', '--noEmit', '-p', 'tests/type-contracts/tsconfig.negative-status-state.json'],
      { cwd: packageRoot },
    ),
    (error) => {
      const output = typeof error === 'object' && error
        ? `${'stdout' in error ? String(error.stdout) : ''}\n${'stderr' in error ? String(error.stderr) : ''}`
        : '';
      return output.includes('closed');
    },
  );
});

test('stable entry source does not re-export gateway connection internals', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');

  assert.equal(source.includes('BridgeGatewayHostConnection'), false);
  assert.equal(source.includes('BridgeGatewayHostState'), false);
  assert.equal(source.includes('BridgeGatewayHostError'), false);
  assert.equal(source.includes('BridgeGatewayHostEvents'), false);
  assert.equal(source.includes('BridgeGatewaySendContext'), false);
});

test('stable entry source exports updated interaction and fact contracts', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');

  assert.equal(source.includes('PermissionReplyFact'), true);
  assert.equal(source.includes('SessionTitleFact'), true);
  assert.equal(source.includes('QuestionAnswer'), true);
  assert.equal(source.includes('QuestionItem'), true);
  assert.equal(source.includes('QuestionOption'), true);
});

test('public contract source locks interaction ids and tool.update boundaries', async () => {
  const source = await readFile(new URL('../../src/domain/provider-contract.ts', import.meta.url), 'utf8');
  const exportedProviderSource = await readFile(new URL('../../src/domain/provider.ts', import.meta.url), 'utf8');
  const factBaseBlock = source.match(/export interface ProviderFactBase \{[\s\S]*?\n\}/)?.[0] ?? '';
  const permissionAskBlock = source.match(/export interface PermissionAskFact[^{]*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const permissionReplyBlock = source.match(/export interface PermissionReplyFact[^{]*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const questionOptionBlock = source.match(/export interface QuestionOption[^{]*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const exportedQuestionOptionBlock =
    exportedProviderSource.match(/export interface QuestionOption[^{]*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const questionAskBlock = source.match(/export interface QuestionAskFact[^{]*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const questionReplyBlock = source.match(/export interface ProviderQuestionReplyInput \{[\s\S]*?\n\}/)?.[0] ?? '';
  const toolUpdateBlock = source.match(/export interface ToolUpdateFact[^{]*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const errorSource = await readFile(new URL('../../src/domain/errors.ts', import.meta.url), 'utf8');

  assert.equal(factBaseBlock.includes('subagentSessionId?: string;'), true);
  assert.equal(factBaseBlock.includes('subagentName?: string;'), true);
  assert.equal(factBaseBlock.includes('toolSessionId:'), false);
  assert.equal(permissionAskBlock.includes('messageId?: string;'), true);
  assert.equal(permissionAskBlock.includes('partId: string;'), true);
  assert.equal(permissionAskBlock.includes('permType: string;'), true);
  assert.equal(permissionAskBlock.includes('permissionType'), false);
  assert.equal(permissionAskBlock.includes('title?: string;'), true);
  assert.equal(permissionAskBlock.includes('toolCallId'), false);
  assert.equal(permissionReplyBlock.includes('permissionId: string;'), true);
  assert.equal(permissionReplyBlock.includes("response: 'once' | 'always' | 'reject';"), true);
  assert.equal(permissionReplyBlock.includes('permType?: string;'), true);
  assert.equal(permissionReplyBlock.includes('permissionType'), false);
  assert.equal(permissionReplyBlock.includes('messageId?: string;'), false);
  assert.equal(permissionReplyBlock.includes('partId'), false);
  assert.equal(questionOptionBlock.includes('label: string;'), true);
  assert.equal(questionOptionBlock.includes('description?: string;'), true);
  assert.equal(exportedQuestionOptionBlock.includes('label: string;'), true);
  assert.equal(exportedQuestionOptionBlock.includes('description?: string;'), true);
  assert.equal(questionAskBlock.includes('partId: string;'), true);
  assert.equal(questionAskBlock.includes('toolCallId?: string;'), true);
  assert.equal(questionAskBlock.includes('status?: string;'), true);
  assert.equal(questionAskBlock.includes('extParam?: unknown;'), true);
  assert.equal(questionAskBlock.includes('questions: QuestionItem[];'), true);
  assert.equal(questionAskBlock.includes('question: string;'), false);
  assert.equal(questionAskBlock.includes('header?: string;'), false);
  assert.equal(questionAskBlock.includes('options?: string[];'), false);
  assert.equal(questionReplyBlock.includes('questionId: string;'), true);
  assert.equal(questionReplyBlock.includes('answers: QuestionAnswer[];'), true);
  assert.equal(toolUpdateBlock.includes('input?: Record<string, unknown>;'), true);
  assert.equal(toolUpdateBlock.includes('output?: string;'), true);
  assert.equal(errorSource.includes("'pending_interaction_conflict'"), true);
  assert.equal(source.includes('welinkSessionId?: string;'), false);
});

test('application ports own runtime orchestration contracts without duplicate local interfaces', async () => {
  const runtimeUsecaseSource = await readFile(new URL('../../src/application/ports/runtime-usecase.ts', import.meta.url), 'utf8');
  const usecasesSource = await readFile(new URL('../../src/application/usecases/index.ts', import.meta.url), 'utf8');
  const dispatcherSource = await readFile(new URL('../../src/application/RuntimeCommandDispatcher.ts', import.meta.url), 'utf8');
  const pendingRegistrySource = await readFile(
    new URL('../../src/application/ports/pending-interaction-registry.ts', import.meta.url),
    'utf8',
  );
  const sessionRegistrySource = await readFile(
    new URL('../../src/application/ports/session-runtime-registry.ts', import.meta.url),
    'utf8',
  );
  const infrastructureIndexSource = await readFile(new URL('../../src/infrastructure/index.ts', import.meta.url), 'utf8');

  assert.equal(runtimeUsecaseSource.includes('ProviderHealthResult'), false);
  assert.equal(runtimeUsecaseSource.includes('ProviderRun'), false);
  assert.equal(runtimeUsecaseSource.includes('ProviderCreateSessionResult'), false);
  assert.equal(runtimeUsecaseSource.includes('RuntimeAppliedResult'), false);
  assert.equal(runtimeUsecaseSource.includes('Promise<void>'), true);
  assert.equal(usecasesSource.includes('export interface RuntimeUseCase'), false);
  assert.equal(dispatcherSource.includes("from './usecases.ts'"), false);
  assert.equal(dispatcherSource.includes("from './ports/runtime-usecase.ts'"), true);
  assert.equal(sessionRegistrySource.includes('export interface SessionRuntimeRegistry'), true);
  assert.equal(pendingRegistrySource.includes('export interface PendingInteractionRegistry'), true);
  assert.equal(pendingRegistrySource.includes('clearSession'), false);
  assert.equal(infrastructureIndexSource.includes("./registries/in-memory-session-runtime-registry.ts"), false);
  assert.equal(infrastructureIndexSource.includes("./registries/in-memory-pending-interaction-registry.ts"), false);
});

test('runtime trace interaction contract does not expose session-level clearing', async () => {
  const publicContractSource = await readFile(new URL('../../src/public-contract.ts', import.meta.url), 'utf8');

  assert.equal(publicContractSource.includes("action: 'register' | 'consume' | 'clear';"), false);
  assert.equal(publicContractSource.includes("action: 'register' | 'consume';"), true);
});

test('gateway host config contract is declared once in public contract', async () => {
  const publicContractSource = await readFile(new URL('../../src/public-contract.ts', import.meta.url), 'utf8');
  const gatewayHostSource = await readFile(new URL('../../src/infrastructure/gateway/gateway-host.ts', import.meta.url), 'utf8');

  assert.match(publicContractSource, /export interface BridgeGatewayHostConfig \{/);
  assert.doesNotMatch(gatewayHostSource, /export interface BridgeGatewayHostConfig \{/);
  assert.match(gatewayHostSource, /import type \{[\s\S]*BridgeGatewayHostConfig[\s\S]*\} from '..\/..\/public-contract\.ts';/);
});

test('package publish contract keeps gateway-client internal to the SDK facade', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

  assert.equal(pkg.exports['./gateway-client'], undefined);
  assert.equal('@agent-plugin/gateway-client' in (pkg.dependencies ?? {}), false);
  assert.equal('@wecode/skill-qrcode-auth' in (pkg.dependencies ?? {}), false);
});
