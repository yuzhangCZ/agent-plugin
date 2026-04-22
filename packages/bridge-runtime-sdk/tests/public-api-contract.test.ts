import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as runtimeSdk from '../src/index.ts';

test('stable entry exports executable runtime factory and public contracts', () => {
  assert.equal(typeof runtimeSdk.createBridgeRuntime, 'function');
});

test('stable entry does not expose internal facade skeleton symbols', () => {
  assert.equal('BridgeRuntimeFacade' in runtimeSdk, false);
  assert.equal('DefaultRuntimeCommandDispatcher' in runtimeSdk, false);
  assert.equal('toRuntimeCommand' in runtimeSdk, false);
  assert.equal('createGatewayClientBridgeRuntime' in runtimeSdk, false);
  assert.equal('probeBridgeGatewayHost' in runtimeSdk, false);
});

test('stable entry source does not re-export gateway connection internals', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

  assert.equal(source.includes('BridgeGatewayHostConnection'), false);
  assert.equal(source.includes('BridgeGatewayHostState'), false);
  assert.equal(source.includes('BridgeGatewayHostError'), false);
  assert.equal(source.includes('BridgeGatewayHostEvents'), false);
  assert.equal(source.includes('BridgeGatewaySendContext'), false);
});

test('package keeps gateway-client as main entry dependency instead of companion subpath', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(pkg.exports['./gateway-client'], undefined);
  assert.equal('@agent-plugin/gateway-client' in (pkg.dependencies ?? {}), true);
});
