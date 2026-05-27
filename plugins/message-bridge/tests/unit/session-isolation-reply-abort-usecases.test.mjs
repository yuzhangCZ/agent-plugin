import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DefaultAbortAnchoredRunUseCase,
  DefaultPermissionReplyCommandUseCase,
  DefaultQuestionReplyCommandUseCase,
} from '../../src/usecase/session-isolation/index.ts';

function createSdkExecutionBridge() {
  const calls = [];
  return {
    calls,
    bridge: {
      abort: async (input) => {
        calls.push({ method: 'abort', input });
        return { kind: 'aborted', toolSessionId: input.toolSessionId };
      },
      replyQuestion: async (input) => {
        calls.push({ method: 'replyQuestion', input });
        return { applied: true };
      },
      replyPermission: async (input) => {
        calls.push({ method: 'replyPermission', input });
        return { applied: true };
      },
    },
  };
}

function createInteractionLookupBridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    bridge: {
      findQuestion: async (questionId) => {
        calls.push({ method: 'findQuestion', questionId });
        return { kind: 'found', toolSessionId: 'tool-1', sessionId: 'ses-1' };
      },
      findPermission: async (permissionId) => {
        calls.push({ method: 'findPermission', permissionId });
        return { kind: 'found', toolSessionId: 'tool-1', sessionId: 'ses-1' };
      },
      ...overrides,
    },
  };
}

describe('session-isolation reply and abort use cases', () => {
  test('AbortAnchoredRunUseCase delegates to SdkExecutionBridge without mutating ownership state', async () => {
    const { bridge, calls } = createSdkExecutionBridge();
    const useCase = new DefaultAbortAnchoredRunUseCase({ sdkExecutionBridge: bridge });

    assert.deepStrictEqual(await useCase.execute({ toolSessionId: 'tool-1' }), {
      kind: 'aborted',
      toolSessionId: 'tool-1',
    });
    assert.deepStrictEqual(calls, [{
      method: 'abort',
      input: { toolSessionId: 'tool-1' },
    }]);
  });

  test('QuestionReplyCommandUseCase resolves pending interaction before applying SDK reply', async () => {
    const sdk = createSdkExecutionBridge();
    const lookup = createInteractionLookupBridge();
    const useCase = new DefaultQuestionReplyCommandUseCase({
      interactionLookupBridge: lookup.bridge,
      sdkExecutionBridge: sdk.bridge,
    });

    assert.deepStrictEqual(await useCase.execute({ questionId: 'q-1', answer: 'yes' }), {
      applied: true,
    });
    assert.deepStrictEqual(lookup.calls, [{ method: 'findQuestion', questionId: 'q-1' }]);
    assert.deepStrictEqual(sdk.calls, [{
      method: 'replyQuestion',
      input: { questionId: 'q-1', answer: 'yes' },
    }]);
  });

  test('QuestionReplyCommandUseCase fails closed when pending interaction is missing', async () => {
    const sdk = createSdkExecutionBridge();
    const lookup = createInteractionLookupBridge({
      findQuestion: async (questionId) => {
        lookup.calls.push({ method: 'findQuestion', questionId });
        return { kind: 'missing' };
      },
    });
    const useCase = new DefaultQuestionReplyCommandUseCase({
      interactionLookupBridge: lookup.bridge,
      sdkExecutionBridge: sdk.bridge,
    });

    await assert.rejects(
      () => useCase.execute({ questionId: 'q-missing', answer: 'yes' }),
      /question interaction not found/u,
    );
    assert.deepStrictEqual(sdk.calls, []);
  });

  test('PermissionReplyCommandUseCase resolves pending interaction before applying SDK reply', async () => {
    const sdk = createSdkExecutionBridge();
    const lookup = createInteractionLookupBridge();
    const useCase = new DefaultPermissionReplyCommandUseCase({
      interactionLookupBridge: lookup.bridge,
      sdkExecutionBridge: sdk.bridge,
    });

    assert.deepStrictEqual(await useCase.execute({ permissionId: 'p-1', response: 'once' }), {
      applied: true,
    });
    assert.deepStrictEqual(lookup.calls, [{ method: 'findPermission', permissionId: 'p-1' }]);
    assert.deepStrictEqual(sdk.calls, [{
      method: 'replyPermission',
      input: { permissionId: 'p-1', response: 'once' },
    }]);
  });

  test('PermissionReplyCommandUseCase fails closed when pending interaction is missing', async () => {
    const sdk = createSdkExecutionBridge();
    const lookup = createInteractionLookupBridge({
      findPermission: async (permissionId) => {
        lookup.calls.push({ method: 'findPermission', permissionId });
        return { kind: 'missing' };
      },
    });
    const useCase = new DefaultPermissionReplyCommandUseCase({
      interactionLookupBridge: lookup.bridge,
      sdkExecutionBridge: sdk.bridge,
    });

    await assert.rejects(
      () => useCase.execute({ permissionId: 'p-missing', response: 'reject' }),
      /permission interaction not found/u,
    );
    assert.deepStrictEqual(sdk.calls, []);
  });
});
