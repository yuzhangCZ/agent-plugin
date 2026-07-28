import assert from 'node:assert/strict';
import test from 'node:test';

import { ReplyPermissionUseCase } from '@/application/usecases/index.ts';

class RecordingObservation {
  readonly events: Array<{ method: string; args: unknown[] }> = [];

  usecaseStarted(...args: unknown[]): void {
    this.events.push({ method: 'usecaseStarted', args });
  }

  usecaseSucceeded(...args: unknown[]): void {
    this.events.push({ method: 'usecaseSucceeded', args });
  }

  usecaseFailed(...args: unknown[]): void {
    this.events.push({ method: 'usecaseFailed', args });
  }
}

function createCommand(payload: Record<string, unknown> = {}) {
  return {
    kind: 'reply_permission',
    traceId: 'trace-permission',
    source: {
      type: 'invoke',
      action: 'permission_reply',
      payload: { permissionId: 'permission-1', response: 'once', ...payload },
    },
  } as never;
}

test('ReplyPermissionUseCase consumes pending permission token and forwards reply', async () => {
  const consumed: unknown[] = [];
  const replies: unknown[] = [];
  const observation = new RecordingObservation();
  const useCase = new ReplyPermissionUseCase(
    {
      async replyPermission(input: unknown) {
        replies.push(input);
        return { applied: true as const };
      },
    } as never,
    {
      consume(kind: string, tokenId: string) {
        consumed.push({ kind, tokenId });
        return { toolSessionId: 'tool-1', kind, tokenId };
      },
    } as never,
    observation as never,
  );

  await useCase.execute(createCommand());

  assert.deepEqual(consumed, [{ kind: 'permission', tokenId: 'permission-1' }]);
  assert.deepEqual(replies, [{ traceId: 'trace-permission', permissionId: 'permission-1', reply: 'once' }]);
  assert.deepEqual(observation.events.map((event) => event.method), ['usecaseStarted', 'usecaseSucceeded']);
});

test('ReplyPermissionUseCase forwards optional extParameters to provider', async () => {
  const replies: unknown[] = [];
  const useCase = new ReplyPermissionUseCase(
    {
      async replyPermission(input: unknown) {
        replies.push(input);
        return { applied: true as const };
      },
    } as never,
    {
      consume(kind: string, tokenId: string) {
        return { toolSessionId: 'tool-1', kind, tokenId };
      },
    } as never,
    new RecordingObservation() as never,
  );

  await useCase.execute(createCommand({ extParameters: { requestId: 'ext-permission' } }));

  assert.deepEqual(replies, [{
    traceId: 'trace-permission',
    permissionId: 'permission-1',
    reply: 'once',
    extParameters: { requestId: 'ext-permission' },
  }]);
});

test('ReplyPermissionUseCase records failed observation when pending permission token is missing', async () => {
  const observation = new RecordingObservation();
  const useCase = new ReplyPermissionUseCase(
    {
      async replyPermission() {
        throw new Error('unexpected');
      },
    } as never,
    {
      consume() {
        throw new Error('pending_interaction_not_found');
      },
    } as never,
    observation as never,
  );

  await assert.rejects(() => useCase.execute(createCommand()), /pending_interaction_not_found/);

  assert.deepEqual(observation.events.map((event) => event.method), ['usecaseStarted', 'usecaseFailed']);
});
