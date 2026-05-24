import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionLookupResolver } from '../../src/adapter/SessionLookupResolver.ts';

function createLoggerSpy() {
  const entries = [];
  return {
    entries,
    logger: {
      debug: (message, extra) => entries.push({ level: 'debug', message, extra }),
      info: (message, extra) => entries.push({ level: 'info', message, extra }),
      warn: (message, extra) => entries.push({ level: 'warn', message, extra }),
      error: (message, extra) => entries.push({ level: 'error', message, extra }),
      child() {
        return this;
      },
      getTraceId: () => 'trace-test',
    },
  };
}

describe('SessionLookupResolver', () => {
  test('returns minimal session view when session.get succeeds', async () => {
    const { logger, entries } = createLoggerSpy();
    const resolver = new SessionLookupResolver(() => ({
      session: {
        get: async () => ({
          data: {
            id: 'ses-ok',
            directory: '/tmp/session-dir',
            title: 'ignored',
          },
        }),
      },
    }));

    const result = await resolver.resolve({
      sessionId: 'ses-ok',
      logger,
      logFields: { hasAgent: true },
    });

    assert.deepStrictEqual(result, {
      success: true,
      session: {
        id: 'ses-ok',
        directory: '/tmp/session-dir',
      },
    });
    assert.deepStrictEqual(entries, [
      {
        level: 'debug',
        message: 'session_lookup.session_get.succeeded',
        extra: {
          toolSessionId: 'ses-ok',
          hasDirectory: true,
          hasAgent: true,
        },
      },
    ]);
  });

  test('maps payload NotFoundError to not_found', async () => {
    const { logger, entries } = createLoggerSpy();
    const resolver = new SessionLookupResolver(() => ({
      session: {
        get: async () => ({
          error: {
            name: 'NotFoundError',
            data: { message: 'Session not found: ses-missing' },
          },
        }),
      },
    }));

    const result = await resolver.resolve({
      sessionId: 'ses-missing',
      logger,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'not_found');
    assert.strictEqual(result.errorEvidence?.sourceErrorCode, 'session_not_found');
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'session.get');
    assert.deepStrictEqual(entries, [
      {
        level: 'warn',
        message: 'session_lookup.session_get.not_found',
        extra: {
          toolSessionId: 'ses-missing',
          errorDetail: '{"name":"NotFoundError","data":{"message":"Session not found: ses-missing"}}',
          errorName: 'NotFoundError',
          rawType: 'Object',
        },
      },
    ]);
  });

  test('maps thrown NotFoundError to not_found', async () => {
    const resolver = new SessionLookupResolver(() => ({
      session: {
        get: async () => {
          throw {
            name: 'NotFoundError',
            data: { message: 'Session not found: ses-throw' },
          };
        },
      },
    }));

    const result = await resolver.resolve({
      sessionId: 'ses-throw',
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'not_found');
    assert.strictEqual(result.errorEvidence?.sourceErrorCode, 'session_not_found');
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'session.get');
  });

  test('maps non-not-found failure to failed', async () => {
    const { logger, entries } = createLoggerSpy();
    const resolver = new SessionLookupResolver(() => ({
      session: {
        get: async () => {
          throw new Error('session lookup timed out');
        },
      },
    }));

    const result = await resolver.resolve({
      sessionId: 'ses-any',
      logger,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'failed');
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'session.get');
    assert.deepStrictEqual(entries, [
      {
        level: 'warn',
        message: 'session_lookup.session_get.failed',
        extra: {
          toolSessionId: 'ses-any',
          errorDetail: 'session lookup timed out',
          errorName: 'Error',
          errorType: 'Error',
          rawType: 'Error',
        },
      },
    ]);
  });

  test('fails closed when session.get succeeds without a valid session id', async () => {
    const { logger, entries } = createLoggerSpy();
    const resolver = new SessionLookupResolver(() => ({
      session: {
        get: async () => ({
          data: {
            directory: '/tmp/no-id',
          },
        }),
      },
    }));

    const result = await resolver.resolve({
      sessionId: 'ses-no-id',
      logger,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'failed');
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'session.get');
    assert.deepStrictEqual(entries, [
      {
        level: 'warn',
        message: 'session_lookup.session_get.failed',
        extra: {
          toolSessionId: 'ses-no-id',
          errorDetail: 'Invalid session.get response shape: missing session id for ses-no-id',
          errorName: 'Error',
          errorType: 'Error',
          rawType: 'Error',
        },
      },
    ]);
  });

  test('maps sdk_client_unavailable to failed instead of throwing', async () => {
    const resolver = new SessionLookupResolver(() => null);

    const result = await resolver.resolve({
      sessionId: 'ses-no-client',
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'failed');
    assert.strictEqual(result.errorEvidence?.sourceOperation, 'session.get');
  });
});
