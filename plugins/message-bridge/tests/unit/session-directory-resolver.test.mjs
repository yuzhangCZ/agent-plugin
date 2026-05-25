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
  test('returns directory from session view and emits debug log', () => {
    const { logger, entries } = createLoggerSpy();
    const resolver = new SessionDirectoryResolver();

    const result = resolver.resolve({
      sessionId: 'ses-ok',
      session: {
        id: 'ses-ok',
        directory: '/tmp/session-dir',
      },
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
        message: 'session_directory.session_view.directory_resolved',
        extra: {
          toolSessionId: 'ses-ok',
          directory: '/tmp/session-dir',
          hasAgent: true,
        },
      },
    ]);
  });

  test('returns missing_directory when session view omits directory', () => {
    const { logger, entries } = createLoggerSpy();
    const resolver = new SessionDirectoryResolver();

    const result = resolver.resolve({
      sessionId: 'ses-no-dir',
      session: {
        id: 'ses-no-dir',
      },
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
        message: 'session_directory.session_view.directory_missing',
        extra: {
          toolSessionId: 'ses-no-dir',
        },
      },
    ]);
  });
});
