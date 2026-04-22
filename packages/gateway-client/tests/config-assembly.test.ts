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
    toolType: 'openx',
    toolVersion: '1.2.3',
    macAddress: '   ',
  });

  assert.deepEqual(message, {
    type: 'register',
    deviceName: 'dev-box',
    os: 'darwin',
    toolType: 'openx',
    toolVersion: '1.2.3',
  });
});

test('buildGatewayRegisterMessage preserves explicit macAddress and does not derive fields', () => {
  const message = buildGatewayRegisterMessage({
    deviceName: 'dev-box',
    os: 'linux',
    toolType: 'channel',
    toolVersion: '9.9.9',
    macAddress: ' aa:bb:cc:dd:ee:ff ',
  });

  assert.deepEqual(message, {
    type: 'register',
    deviceName: 'dev-box',
    os: 'linux',
    toolType: 'channel',
    toolVersion: '9.9.9',
    macAddress: ' aa:bb:cc:dd:ee:ff ',
  });
});

test('buildGatewayHostRegisterMessage derives device identity and macAddress', () => {
  const message = buildGatewayHostRegisterMessage(
    {
      toolType: 'openx',
      toolVersion: '1.2.3',
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
    toolType: 'openx',
    toolVersion: '1.2.3',
    macAddress: 'aa:bb:cc:dd:ee:ff',
  });
});

test('buildGatewayHostRegisterMessage omits unusable macAddress and falls back deviceName', () => {
  const message = buildGatewayHostRegisterMessage(
    {
      toolType: 'opencode',
      toolVersion: '1.2.3',
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
    toolType: 'opencode',
    toolVersion: '1.2.3',
  });
});
