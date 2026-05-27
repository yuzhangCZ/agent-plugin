import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as runtimeSdk from '../src/index.ts';

test('stable entry exports executable runtime factory and public contracts', () => {
  assert.equal(typeof runtimeSdk.createBridgeRuntime, 'function');
  assert.equal(typeof runtimeSdk.resolvePackageVersion, 'function');
  assert.equal(typeof runtimeSdk.qrcodeAuth, 'object');
  assert.equal(typeof runtimeSdk.qrcodeAuth.run, 'function');
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

test('stable entry source does not re-export gateway connection internals', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

  assert.equal(source.includes('BridgeGatewayHostConnection'), false);
  assert.equal(source.includes('BridgeGatewayHostState'), false);
  assert.equal(source.includes('BridgeGatewayHostError'), false);
  assert.equal(source.includes('BridgeGatewayHostEvents'), false);
  assert.equal(source.includes('BridgeGatewaySendContext'), false);
});

test('stable entry source exports updated interaction and fact contracts', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

  assert.equal(source.includes('PermissionReplyFact'), true);
  assert.equal(source.includes('SessionTitleFact'), true);
  assert.equal(source.includes('QuestionAnswer'), true);
  assert.equal(source.includes('QuestionItem'), true);
  assert.equal(source.includes('QuestionOption'), true);
});

test('public contract source locks interaction ids and tool.update string boundaries', async () => {
  const source = await readFile(new URL('../src/domain/provider-contract.ts', import.meta.url), 'utf8');
  const factBaseBlock = source.match(/export interface ProviderFactBase \{[\s\S]*?\n\}/)?.[0] ?? '';
  const permissionAskBlock = source.match(/export interface PermissionAskFact[^{]*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const permissionReplyBlock = source.match(/export interface PermissionReplyFact[^{]*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const questionAskBlock = source.match(/export interface QuestionAskFact[^{]*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const questionReplyBlock = source.match(/export interface ProviderQuestionReplyInput \{[\s\S]*?\n\}/)?.[0] ?? '';
  const toolUpdateBlock = source.match(/export interface ToolUpdateFact[^{]*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const errorSource = await readFile(new URL('../src/domain/errors.ts', import.meta.url), 'utf8');

  assert.equal(factBaseBlock.includes('subagentSessionId?: string;'), true);
  assert.equal(factBaseBlock.includes('subagentName?: string;'), true);
  assert.equal(factBaseBlock.includes('toolSessionId:'), false);
  assert.equal(permissionAskBlock.includes('messageId?: string;'), true);
  assert.equal(permissionAskBlock.includes('partId: string;'), true);
  assert.equal(permissionAskBlock.includes('title?: string;'), true);
  assert.equal(permissionAskBlock.includes('toolCallId'), false);
  assert.equal(permissionReplyBlock.includes('permissionId: string;'), true);
  assert.equal(permissionReplyBlock.includes("response: 'once' | 'always' | 'reject';"), true);
  assert.equal(permissionReplyBlock.includes('permissionType?: string;'), true);
  assert.equal(permissionReplyBlock.includes('messageId?: string;'), false);
  assert.equal(permissionReplyBlock.includes('partId'), false);
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
  assert.equal(toolUpdateBlock.includes('input?: string;'), true);
  assert.equal(toolUpdateBlock.includes('output?: string;'), true);
  assert.equal(errorSource.includes("'pending_interaction_conflict'"), true);
  assert.equal(source.includes('welinkSessionId?: string;'), false);
});

test('application ports own runtime orchestration contracts without duplicate local interfaces', async () => {
  const runtimeUsecaseSource = await readFile(new URL('../src/application/ports/runtime-usecase.ts', import.meta.url), 'utf8');
  const usecasesSource = await readFile(new URL('../src/application/usecases/index.ts', import.meta.url), 'utf8');
  const dispatcherSource = await readFile(new URL('../src/application/RuntimeCommandDispatcher.ts', import.meta.url), 'utf8');
  const pendingRegistrySource = await readFile(
    new URL('../src/application/ports/pending-interaction-registry.ts', import.meta.url),
    'utf8',
  );
  const sessionRegistrySource = await readFile(
    new URL('../src/application/ports/session-runtime-registry.ts', import.meta.url),
    'utf8',
  );
  const infrastructureIndexSource = await readFile(new URL('../src/infrastructure/index.ts', import.meta.url), 'utf8');

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
  assert.equal(infrastructureIndexSource.includes("./registries/in-memory-session-runtime-registry.ts"), false);
  assert.equal(infrastructureIndexSource.includes("./registries/in-memory-pending-interaction-registry.ts"), false);
});

test('package publish contract keeps gateway-client internal to the SDK facade', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(pkg.exports['./gateway-client'], undefined);
  assert.equal('@agent-plugin/gateway-client' in (pkg.dependencies ?? {}), false);
  assert.equal('@wecode/skill-qrcode-auth' in (pkg.dependencies ?? {}), false);
});
