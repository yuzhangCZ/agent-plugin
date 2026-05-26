import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DefaultEventOwnershipResolver,
  DefaultEventSessionLocator,
  DefaultSessionDeletedEventHandler,
} from '../../src/adapter/session-isolation/event/index.ts';
import { DefaultHostEventUseCase } from '../../src/usecase/session-isolation/index.ts';

class MemoryAttachOwnerRepository {
  records = new Map();

  async get(sessionId) {
    return this.records.get(sessionId);
  }

  async upsert(record) {
    this.records.set(record.sessionId, record);
  }

  async delete(sessionId) {
    this.records.delete(sessionId);
  }
}

describe('session-isolation host event seams', () => {
  test('EventSessionLocator extracts host session ids from supported OpenCode event shapes', () => {
    const locator = new DefaultEventSessionLocator();

    assert.strictEqual(locator.locate({
      type: 'question.asked',
      properties: { sessionID: 'ses-question' },
    }), 'ses-question');
    assert.strictEqual(locator.locate({
      type: 'message.updated',
      properties: { info: { sessionID: 'ses-message' } },
    }), 'ses-message');
    assert.strictEqual(locator.locate({
      type: 'message.part.updated',
      properties: { part: { sessionID: 'ses-part' } },
    }), 'ses-part');
    assert.strictEqual(locator.locate({
      type: 'session.idle',
      properties: { sessionID: 'ses-idle' },
    }), 'ses-idle');
    assert.strictEqual(locator.locate({
      type: 'unknown.event',
      properties: { sessionID: 'ses-ignored' },
    }), undefined);
  });

  test('EventOwnershipResolver maps host session id to attached tool anchor', async () => {
    const attachOwnerRepository = new MemoryAttachOwnerRepository();
    await attachOwnerRepository.upsert({ sessionId: 'ses-1', toolSessionId: 'tool-1' });
    const resolver = new DefaultEventOwnershipResolver({ attachOwnerRepository });

    assert.deepStrictEqual(await resolver.resolve('ses-1'), {
      kind: 'owned',
      sessionId: 'ses-1',
      toolSessionId: 'tool-1',
    });
    assert.deepStrictEqual(await resolver.resolve('ses-missing'), {
      kind: 'unowned',
      sessionId: 'ses-missing',
    });
  });

  test('SessionDeletedEventHandler converts session.deleted into reconcile input', () => {
    const handler = new DefaultSessionDeletedEventHandler();

    assert.deepStrictEqual(handler.toInput({
      type: 'session.deleted',
      properties: { info: { id: 'ses-deleted' } },
    }), { sessionId: 'ses-deleted' });
    assert.strictEqual(handler.toInput({
      type: 'session.deleted',
      properties: { info: { id: '  ' } },
    }), undefined);
  });

  test('HostEventUseCase forwards owned events through OwnedHostEventForwarder', async () => {
    const forwarded = [];
    const useCase = new DefaultHostEventUseCase({
      eventSessionLocator: { locate: () => 'ses-1' },
      eventOwnershipResolver: {
        resolve: async () => ({ kind: 'owned', sessionId: 'ses-1', toolSessionId: 'tool-1' }),
      },
      ownedHostEventForwarder: {
        forward: async (input) => {
          forwarded.push(input);
          return { applied: true };
        },
      },
      sessionDeletedEventHandler: { toInput: () => undefined },
      sessionDeletedReconcileUseCase: {
        execute: async () => ({ applied: true }),
      },
    });
    const event = { type: 'question.asked', properties: { sessionID: 'ses-1' } };

    assert.deepStrictEqual(await useCase.handle(event), {
      kind: 'forwarded',
      toolSessionId: 'tool-1',
    });
    assert.deepStrictEqual(forwarded, [{ toolSessionId: 'tool-1', event }]);
  });

  test('HostEventUseCase reconciles session.deleted without forwarding it', async () => {
    const reconciled = [];
    const useCase = new DefaultHostEventUseCase({
      eventSessionLocator: { locate: () => undefined },
      eventOwnershipResolver: {
        resolve: async () => {
          throw new Error('resolver must not be called for session.deleted');
        },
      },
      ownedHostEventForwarder: {
        forward: async () => {
          throw new Error('forwarder must not be called for session.deleted');
        },
      },
      sessionDeletedEventHandler: { toInput: () => ({ sessionId: 'ses-deleted' }) },
      sessionDeletedReconcileUseCase: {
        execute: async (input) => {
          reconciled.push(input);
          return { applied: true };
        },
      },
    });

    assert.deepStrictEqual(await useCase.handle({ type: 'session.deleted' }), {
      kind: 'reconciled',
      sessionId: 'ses-deleted',
    });
    assert.deepStrictEqual(reconciled, [{ sessionId: 'ses-deleted' }]);
  });

  test('HostEventUseCase drops events without routable session or attached owner', async () => {
    const missingSessionUseCase = new DefaultHostEventUseCase({
      eventSessionLocator: { locate: () => undefined },
      eventOwnershipResolver: { resolve: async () => ({ kind: 'unowned', sessionId: 'unused' }) },
      ownedHostEventForwarder: { forward: async () => ({ applied: true }) },
      sessionDeletedEventHandler: { toInput: () => undefined },
      sessionDeletedReconcileUseCase: { execute: async () => ({ applied: true }) },
    });
    const unownedUseCase = new DefaultHostEventUseCase({
      eventSessionLocator: { locate: () => 'ses-unowned' },
      eventOwnershipResolver: { resolve: async () => ({ kind: 'unowned', sessionId: 'ses-unowned' }) },
      ownedHostEventForwarder: { forward: async () => ({ applied: true }) },
      sessionDeletedEventHandler: { toInput: () => undefined },
      sessionDeletedReconcileUseCase: { execute: async () => ({ applied: true }) },
    });

    assert.deepStrictEqual(await missingSessionUseCase.handle({ type: 'unsupported.event' }), {
      kind: 'dropped',
      reason: 'unsupported_event',
    });
    assert.deepStrictEqual(await unownedUseCase.handle({ type: 'question.asked' }), {
      kind: 'ignored',
      reason: 'unowned_event',
    });
  });
});
