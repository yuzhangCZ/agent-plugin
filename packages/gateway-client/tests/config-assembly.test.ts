import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGatewayRegisterMessage,
} from '../src/index.ts';
import { buildGatewayHostRegisterMessage } from '../src/factory/createGatewayClientForHost.ts';

test('buildGatewayRegisterMessage returns register payload and omits blank macAddress', () => {
  const message = buildGatewayRegisterMessage({
    deviceName: 'dev-box',
    os: 'darwin',
    channel: 'openx',
    toolVersion: '1.2.3',
    pluginVersion: '0.2.0',
    macAddress: '   ',
  });

  assert.deepEqual(message, {
    type: 'register',
    deviceName: 'dev-box',
    os: 'darwin',
    channel: 'openx',
    toolVersion: '1.2.3',
    pluginVersion: '0.2.0',
  });
});

test('buildGatewayRegisterMessage preserves explicit macAddress and does not derive fields', () => {
  const message = buildGatewayRegisterMessage({
    deviceName: 'dev-box',
    os: 'linux',
    channel: 'channel',
    toolVersion: '9.9.9',
    sdkVersion: '2.3.4',
    macAddress: ' aa:bb:cc:dd:ee:ff ',
  });

  assert.deepEqual(message, {
    type: 'register',
    deviceName: 'dev-box',
    os: 'linux',
    channel: 'channel',
    toolVersion: '9.9.9',
    sdkVersion: '2.3.4',
    macAddress: ' aa:bb:cc:dd:ee:ff ',
  });
});

test('buildGatewayHostRegisterMessage derives device identity and macAddress', () => {
  const message = buildGatewayHostRegisterMessage(
    {
      channel: 'openx',
      toolVersion: '1.2.3',
      pluginVersion: '0.2.0',
    },
    {
      hostname: () => 'dev-box',
      platform: () => 'darwin',
      networkInterfaces: () => ({
        lo0: [{ internal: true, mac: '11:11:11:11:11:11' } as NodeJS.NetworkInterfaceInfo],
        en0: [{ internal: false, mac: 'aa:bb:cc:dd:ee:ff' } as NodeJS.NetworkInterfaceInfo],
      }),
    },
  );

  assert.deepEqual(message, {
    type: 'register',
    deviceName: 'dev-box',
    os: 'darwin',
    channel: 'openx',
    toolVersion: '1.2.3',
    pluginVersion: '0.2.0',
    macAddress: 'aa:bb:cc:dd:ee:ff',
  });
});

test('buildGatewayHostRegisterMessage omits unusable macAddress and falls back deviceName', () => {
  const message = buildGatewayHostRegisterMessage(
    {
      channel: 'opencode',
      toolVersion: '1.2.3',
      sdkVersion: '0.2.0',
    },
    {
      hostname: () => '   ',
      platform: () => 'linux',
      networkInterfaces: () => ({
        en0: [{ internal: false, mac: '00:00:00:00:00:00' } as NodeJS.NetworkInterfaceInfo],
      }),
    },
  );

  assert.deepEqual(message, {
    type: 'register',
    deviceName: 'unknown-device',
    os: 'linux',
    channel: 'opencode',
    toolVersion: '1.2.3',
    sdkVersion: '0.2.0',
  });
});
