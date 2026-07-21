import assert from 'node:assert/strict';
import test from 'node:test';

import type { BridgeGatewayHostConfig } from '@/index.ts';
import { normalizeBridgeGatewayHostConfig } from '@/infrastructure/gateway/gateway-host.ts';
import { resolvePackageVersion } from '@/packageVersion.ts';

function createGatewayConfig(): BridgeGatewayHostConfig {
  return {
    url: 'ws://gateway.local',
    auth: {
      ak: 'ak',
      sk: 'sk',
    },
    register: {
      channel: 'openx',
      toolVersion: '0.0.0',
      pluginVersion: '0.1.0',
    },
  };
}

test('normalizeBridgeGatewayHostConfig auto injects sdkVersion while preserving pluginVersion', () => {
  const normalized = normalizeBridgeGatewayHostConfig(createGatewayConfig());

  assert.equal((normalized.register as { toolType?: string }).toolType, 'openx');
  assert.equal(normalized.register.sdkVersion, resolvePackageVersion());
  assert.equal(normalized.register.pluginVersion, '0.1.0');
});

test('normalizeBridgeGatewayHostConfig omits sdkVersion when sdk package version is not injected', () => {
  const originalPackageVersion = globalThis.__MB_SDK_PACKAGE_VERSION__;
  delete globalThis.__MB_SDK_PACKAGE_VERSION__;

  try {
    const normalized = normalizeBridgeGatewayHostConfig(createGatewayConfig());
    assert.equal('sdkVersion' in normalized.register, false);
    assert.equal(normalized.register.pluginVersion, '0.1.0');
  } finally {
    if (typeof originalPackageVersion === 'undefined') {
      delete globalThis.__MB_SDK_PACKAGE_VERSION__;
    } else {
      globalThis.__MB_SDK_PACKAGE_VERSION__ = originalPackageVersion;
    }
  }
});
