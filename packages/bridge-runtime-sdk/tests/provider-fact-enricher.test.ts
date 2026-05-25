import test from 'node:test';
import assert from 'node:assert/strict';

import { ProviderFactEnricher } from '../src/application/ProviderFactEnricher.ts';
import { InMemoryPermissionPresentationRegistry } from '../src/infrastructure/registries/InMemoryPermissionPresentationRegistry.ts';

test('permission.ask registers presentation context and permission.reply restores partId/messageId', () => {
  const enricher = new ProviderFactEnricher(new InMemoryPermissionPresentationRegistry());

  const ask = enricher.enrich('tool-1', {
    type: 'permission.ask',
    permissionId: 'perm-1',
    partId: 'part-1',
    messageId: 'msg-1',
    permissionType: 'file_write',
  });
  assert.equal(ask.ok, true);

  const reply = enricher.enrich('tool-1', {
    type: 'permission.reply',
    permissionId: 'perm-1',
    response: 'once',
  });
  assert.deepEqual(reply, {
    ok: true,
    fact: {
      type: 'permission.reply',
      permissionId: 'perm-1',
      response: 'once',
      permissionType: 'file_write',
      messageId: 'msg-1',
      partId: 'part-1',
    },
  });
});

test('permission.ask duplicate with same partId is idempotent and conflicting partId fails closed', () => {
  const enricher = new ProviderFactEnricher(new InMemoryPermissionPresentationRegistry());

  assert.equal(enricher.enrich('tool-1', {
    type: 'permission.ask',
    permissionId: 'perm-1',
    partId: 'part-1',
  }).ok, true);

  assert.equal(enricher.enrich('tool-1', {
    type: 'permission.ask',
    permissionId: 'perm-1',
    partId: 'part-1',
    messageId: 'msg-2',
  }).ok, true);

  assert.deepEqual(enricher.enrich('tool-1', {
    type: 'permission.ask',
    permissionId: 'perm-1',
    partId: 'part-2',
  }), {
    ok: false,
    reason: 'permission_ask_projection_conflict',
    details: {
      toolSessionId: 'tool-1',
      permissionId: 'perm-1',
      existingPartId: 'part-1',
      conflictingPartId: 'part-2',
    },
  });
});

test('permission.reply without presentation context returns explicit miss result', () => {
  const enricher = new ProviderFactEnricher(new InMemoryPermissionPresentationRegistry());

  assert.deepEqual(enricher.enrich('tool-1', {
    type: 'permission.reply',
    permissionId: 'perm-missing',
    response: 'reject',
  }), {
    ok: false,
    reason: 'permission_reply_projection_missed',
    details: {
      toolSessionId: 'tool-1',
      permissionId: 'perm-missing',
    },
  });
});
