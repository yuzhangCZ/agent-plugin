import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionDirectoryResolver } from '../../src/adapter/SessionDirectoryResolver.ts';

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

describe('SessionDirectoryResolver', () => {
  test('returns directory and emits debug log when session.get succeeds', async () => {
    const { logger, entries } = createLoggerSpy();
    const resolver = new SessionDirectoryResolver(() => ({
      session: {
        get: async () => ({
          data: {
            id: 'ses-ok',
            directory: '/tmp/session-dir',
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
      directory: '/tmp/session-dir',
    });
    assert.deepStrictEqual(entries, [
      {
        level: 'debug',
        message: 'session_directory.session_get.directory_resolved',
        extra: {
          toolSessionId: 'ses-ok',
          directory: '/tmp/session-dir',
          hasAgent: true,
        },
      },
    ]);
  });

  test('returns session_not_found evidence when session.get reports NotFoundError', async () => {
    const { logger, entries } = createLoggerSpy();
    const resolver = new SessionDirectoryResolver(() => ({
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
        message: 'session_directory.session_get.not_found',
        extra: {
          toolSessionId: 'ses-missing',
          errorDetail: '{"name":"NotFoundError","data":{"message":"Session not found: ses-missing"}}',
          errorName: 'NotFoundError',
          rawType: 'Object',
        },
      },
    ]);
  });

  test('returns missing_directory when session.get succeeds without directory', async () => {
    const { logger, entries } = createLoggerSpy();
    const resolver = new SessionDirectoryResolver(() => ({
      session: {
        get: async () => ({
          data: {
            id: 'ses-no-dir',
          },
        }),
      },
    }));

    const result = await resolver.resolve({
      sessionId: 'ses-no-dir',
      logger,
    });

    assert.deepStrictEqual(result, {
      success: false,
      reason: 'missing_directory',
      errorEvidence: { sourceOperation: 'session.get' },
    });
    assert.deepStrictEqual(entries, [
      {
        level: 'warn',
        message: 'session_directory.session_get.directory_missing',
        extra: {
          toolSessionId: 'ses-no-dir',
        },
      },
    ]);
  });
});
