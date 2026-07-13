import type { RuntimeTraceProviderCall } from '../../src/index.ts';

const abortExecutionTrace: RuntimeTraceProviderCall = {
  command: 'abortExecution',
  toolSessionId: 'tool-session-1',
};

void abortExecutionTrace;
