import type {
  ProviderError,
  ProviderFact,
  ProviderRun,
  ProviderTerminalResult,
} from '@wecode/bridge-runtime-sdk';
import type { PromptSessionTerminal } from '../../port/SessionScopedActionGatewayPort.js';
import { getToolErrorEvidence } from '../../utils/error.js';

export function fromFacts<T extends ProviderFact>(facts: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const fact of facts) {
        yield fact;
      }
    },
  };
}

export function toProviderTerminalResult(terminal: PromptSessionTerminal): ProviderTerminalResult {
  switch (terminal.kind) {
    case 'completed':
      return { outcome: 'completed' };
    case 'aborted':
      return { outcome: 'aborted' };
    case 'failed':
      return {
        outcome: 'failed',
        error: {
          code: terminal.errorCode,
          message: terminal.errorMessage,
          ...(terminal.errorDetails ? { details: terminal.errorDetails } : {}),
        },
      };
  }
}

export function buildImmediateFailedRun(toolSessionId: string, error: ProviderError): ProviderRun {
  return {
    runId: `immediate-${toolSessionId}`,
    facts: fromFacts([]),
    async result() {
      return {
        outcome: 'failed',
        error,
      };
    },
  };
}

export function appendTerminalSourceEvidence(
  extra: Record<string, unknown>,
  errorDetails: unknown,
): Record<string, unknown> {
  const evidence = getToolErrorEvidence(errorDetails);
  return {
    ...extra,
    ...(evidence?.sourceOperation ? { sourceOperation: evidence.sourceOperation } : {}),
    ...(evidence?.sourceErrorCode ? { sourceErrorCode: evidence.sourceErrorCode } : {}),
    ...(evidence?.httpStatus !== undefined ? { httpStatus: evidence.httpStatus } : {}),
  };
}

export function hasPlatformBusinessSessionId(extParameters: unknown): boolean {
  if (typeof extParameters !== 'object' || extParameters === null || Array.isArray(extParameters)) {
    return false;
  }
  const platformExtParam = (extParameters as Record<string, unknown>).platformExtParam;
  if (typeof platformExtParam !== 'object' || platformExtParam === null || Array.isArray(platformExtParam)) {
    return false;
  }
  const businessSessionId = (platformExtParam as Record<string, unknown>).businessSessionId;
  return typeof businessSessionId === 'string' && businessSessionId.trim().length > 0;
}
