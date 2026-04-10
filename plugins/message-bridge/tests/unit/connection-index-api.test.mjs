import test from 'node:test';
import assert from 'node:assert/strict';

import * as connectionApi from '../../src/connection/index.ts';

test('connection index removes legacy aliases and internal auth export', () => {
  const legacyType = 'Gateway' + 'Connection';
  const legacyOptionsType = legacyType + 'Options';
  const legacyEventsType = legacyType + 'Events';

  assert.strictEqual(legacyType in connectionApi, false);
  assert.strictEqual(legacyOptionsType in connectionApi, false);
  assert.strictEqual(legacyEventsType in connectionApi, false);
  assert.strictEqual('DefaultAkSkAuth' in connectionApi, false);
  assert.strictEqual('AkSkAuth' in connectionApi, false);
});
