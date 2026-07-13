import assert from 'node:assert/strict';
import test from 'node:test';

import { BridgeGatewayLoggerObservationAdapter } from '@/adapters/observation/runtime-logger-observation.ts';
import type { BridgeGatewayLogger } from '@/infrastructure/gateway/gateway-host.ts';

type RecordedLog = {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
};

class RecordingLogger implements BridgeGatewayLogger {
  readonly logs: RecordedLog[] = [];

  debug(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'debug', message, meta });
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'info', message, meta });
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'warn', message, meta });
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.logs.push({ level: 'error', message, meta });
  }
}

function hasLog(logs: RecordedLog[], message: string, level?: RecordedLog['level']): boolean {
  return logs.some((log) => log.message === message && (!level || log.level === level));
}

test('logger observation adapter projects observation events into runtime_sdk logs', () => {
  const logger = new RecordingLogger();
  const adapter = new BridgeGatewayLoggerObservationAdapter(logger);

  adapter.record({ type: 'runtime_lifecycle', action: 'start_requested' });
  adapter.record({
    type: 'provider_call',
    phase: 'started',
    command: 'startRequestRun',
    traceId: 'trace-1',
    toolSessionId: 'tool-1',
    runId: 'run-1',
  });
  adapter.record({
    type: 'provider_call',
    phase: 'failed',
    command: 'startRequestRun',
    traceId: 'trace-1',
    toolSessionId: 'tool-1',
    runId: 'run-1',
    error: 'provider_unavailable',
  });
  adapter.record({
    type: 'provider_call',
    phase: 'succeeded',
    command: 'listSlashCommands',
    traceId: 'trace-list',
    slashCommandCount: 1,
    slashCommands: [{ command: '/new', description: '新建会话' }],
  });
  adapter.record({
    type: 'fact_processed',
    phase: 'received',
    toolSessionId: 'tool-1',
    fact: { type: 'message.start', messageId: 'msg-1' },
    profile: 'request_run',
  });

  assert.equal(hasLog(logger.logs, 'runtime_sdk.start.requested', 'info'), true);
  assert.equal(hasLog(logger.logs, 'runtime_sdk.provider.startRequestRun.started', 'debug'), true);
  assert.equal(hasLog(logger.logs, 'runtime_sdk.provider.startRequestRun.failed', 'error'), true);
  const slashLog = logger.logs.find((log) => log.message === 'runtime_sdk.provider.listSlashCommands.succeeded');
  assert.equal(slashLog?.level, 'info');
  assert.deepEqual(slashLog?.meta?.slashCommands, [{ command: '/new', description: '新建会话' }]);
  assert.equal(slashLog?.meta?.slashCommandCount, 1);
  assert.equal(hasLog(logger.logs, 'runtime_sdk.fact.received', 'debug'), true);
});
