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
  const permissionAskBlock = source.match(/export interface PermissionAskFact \{[\s\S]*?\n\}/)?.[0] ?? '';
  const questionAskBlock = source.match(/export interface QuestionAskFact \{[\s\S]*?\n\}/)?.[0] ?? '';
  const questionReplyBlock = source.match(/export interface ProviderQuestionReplyInput \{[\s\S]*?\n\}/)?.[0] ?? '';
  const toolUpdateBlock = source.match(/export interface ToolUpdateFact \{[\s\S]*?\n\}/)?.[0] ?? '';
  const errorSource = await readFile(new URL('../src/domain/errors.ts', import.meta.url), 'utf8');

  assert.equal(permissionAskBlock.includes('partId: string;'), true);
  assert.equal(permissionAskBlock.includes('title?: string;'), true);
  assert.equal(permissionAskBlock.includes('toolCallId'), false);
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
});

test('package publish contract keeps gateway-client internal to the SDK facade', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(pkg.exports['./gateway-client'], undefined);
  assert.equal('@agent-plugin/gateway-client' in (pkg.dependencies ?? {}), false);
  assert.equal('@wecode/skill-qrcode-auth' in (pkg.dependencies ?? {}), false);
});
