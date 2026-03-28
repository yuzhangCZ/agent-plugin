import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EnvBridgeChannelAdapter } from '../../src/adapter/EnvBridgeChannelAdapter.ts';

test('EnvBridgeChannelAdapter recognizes uniassistant channel', () => {
  const adapter = new EnvBridgeChannelAdapter('uniassistant');

  assert.equal(adapter.getChannel(), 'uniassistant');
  assert.equal(adapter.isAssiantChannel(), true);
});

test('EnvBridgeChannelAdapter does not treat legacy assiant value as valid', () => {
  const adapter = new EnvBridgeChannelAdapter('assiant');

  assert.equal(adapter.isAssiantChannel(), false);
});
