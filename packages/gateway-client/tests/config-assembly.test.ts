import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGatewayRegisterMessage,
} from '../src/index.ts';

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
