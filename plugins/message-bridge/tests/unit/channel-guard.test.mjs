import assert from 'node:assert/strict';
import test from 'node:test';
import { KNOWN_CHANNELS, isKnownChannel } from '../../src/contracts/transport-messages.ts';

test('known channels include opencode, openx, uniassistant, codeagent', () => {
  assert.deepEqual(KNOWN_CHANNELS, ['opencode', 'openx', 'uniassistant', 'codeagent']);
  assert.equal(isKnownChannel('opencode'), true);
  assert.equal(isKnownChannel('openx'), true);
  assert.equal(isKnownChannel('uniassistant'), true);
  assert.equal(isKnownChannel('codeagent'), true);
  assert.equal(isKnownChannel('legacy-tool'), false);
});
