import assert from 'node:assert/strict';
import test from 'node:test';
import { KNOWN_TOOL_TYPES, isKnownToolType } from '../../src/contracts/transport-messages.ts';

test('known tool types include openx, uniassistant, codeagent', () => {
  assert.deepEqual(KNOWN_TOOL_TYPES, ['openx', 'uniassistant', 'codeagent']);
  assert.equal(isKnownToolType('openx'), true);
  assert.equal(isKnownToolType('uniassistant'), true);
  assert.equal(isKnownToolType('codeagent'), true);
  assert.equal(isKnownToolType('legacy-tool'), false);
});
