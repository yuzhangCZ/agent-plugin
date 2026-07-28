import assert from 'node:assert/strict';
import test from 'node:test';

import { ReplyQuestionUseCase } from '@/application/usecases/index.ts';

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
    kind: 'reply_question',
    traceId: 'trace-question',
    source: {
      type: 'invoke',
      action: 'question_reply',
      payload: { questionId: 'question-1', answers: [['yes'], ['no']], ...payload },
    },
  } as never;
}

test('ReplyQuestionUseCase consumes pending question token and forwards normalized reply', async () => {
  const consumed: unknown[] = [];
  const replies: unknown[] = [];
  const observation = new RecordingObservation();
  const useCase = new ReplyQuestionUseCase(
    {
      async replyQuestion(input: unknown) {
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

  assert.deepEqual(consumed, [{ kind: 'question', tokenId: 'question-1' }]);
  assert.deepEqual(replies, [{
    traceId: 'trace-question',
    questionId: 'question-1',
    answers: [['yes'], ['no']],
    extParameters: undefined,
  }]);
  assert.deepEqual(observation.events.map((event) => event.method), ['usecaseStarted', 'usecaseSucceeded']);
});

test('ReplyQuestionUseCase forwards optional extParameters to provider', async () => {
  const replies: unknown[] = [];
  const useCase = new ReplyQuestionUseCase(
    {
      async replyQuestion(input: unknown) {
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

  await useCase.execute(createCommand({ extParameters: { requestId: 'ext-question' } }));

  assert.deepEqual(replies, [{
    traceId: 'trace-question',
    questionId: 'question-1',
    answers: [['yes'], ['no']],
    extParameters: { requestId: 'ext-question' },
  }]);
});

test('ReplyQuestionUseCase records failed observation when pending question token is missing', async () => {
  const observation = new RecordingObservation();
  const useCase = new ReplyQuestionUseCase(
    {
      async replyQuestion() {
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
