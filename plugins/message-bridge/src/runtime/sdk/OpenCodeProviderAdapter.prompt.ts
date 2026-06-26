import type {
  ProviderError,
} from '@wecode/bridge-runtime-sdk';
import type { OpencodeSessionGatewayAdapter } from '../../adapter/index.js';
import type { PromptSessionResultData } from '../../port/SessionScopedActionGatewayPort.js';
import type { ActionResult } from '../../types/action-runtime.js';
import { getErrorMessage } from '../../utils/error.js';
import type {
  ChatActionContext,
  ExecutionSessionInvalidationPort,
} from './SdkChatControlPlane.js';
import type {
  ActiveProviderRunHandle,
  ActiveRunRegistry,
} from './OpenCodeProviderAdapter.run.js';
import {
  appendTerminalSourceEvidence,
  toProviderTerminalResult,
} from './OpenCodeProviderAdapter.helpers.js';

type PromptSessionActionResult = ActionResult<PromptSessionResultData>;

export async function bindProviderPromptTerminal(input: {
  activeRun: ActiveProviderRunHandle;
  context: ChatActionContext;
  gatewayAdapter: OpencodeSessionGatewayAdapter;
  executionSessionInvalidationPort: ExecutionSessionInvalidationPort;
  activeRuns: ActiveRunRegistry;
}): Promise<void> {
  const startedAt = Date.now();
  logPromptStarted(input, startedAt);

  try {
    const promptResult = await input.gatewayAdapter.promptSession({
      sessionId: input.context.sessionContext.opencodeSessionId,
      text: input.context.message.text,
      ...(input.context.effectiveDirectory ? { directory: input.context.effectiveDirectory } : {}),
      agent: input.context.message.assistantId,
      modelOverride: input.context.sessionContext.modelOverride,
      logger: input.context.logger,
    });

    if (!promptResult.success) {
      handlePromptFailure(input, startedAt, promptResult);
      return;
    }
    handlePromptSuccess(input, startedAt, promptResult);
  } catch (error) {
    handlePromptException(input, startedAt, error);
  }
}

function logPromptStarted(
  input: Parameters<typeof bindProviderPromptTerminal>[0],
  startedAt: number,
): void {
  void startedAt;
  input.context.logger?.info('provider_adapter.prompt.started', {
    toolSessionId: input.context.anchor,
    opencodeSessionId: input.context.sessionContext.opencodeSessionId,
    runId: input.activeRun.runId,
    hasAssistantId: Boolean(input.context.message.assistantId),
    textLength: input.context.message.text.length,
  });
}

function handlePromptFailure(
  input: Parameters<typeof bindProviderPromptTerminal>[0],
  startedAt: number,
  promptResult: Extract<PromptSessionActionResult, { success: false }>,
): void {
  invalidateExecutionSessionAfterFailure(input, promptResult);
  const sourceOperation = promptResult.errorEvidence?.sourceOperation;
  const sourceErrorCode = promptResult.errorEvidence?.sourceErrorCode;
  input.context.logger?.warn('provider_adapter.prompt.failed', {
    toolSessionId: input.context.anchor,
    opencodeSessionId: input.context.sessionContext.opencodeSessionId,
    runId: input.activeRun.runId,
    durationMs: Math.max(0, Date.now() - startedAt),
    providerOutcome: 'failed',
    mappedProviderErrorCode: mapPromptFailureCode(sourceOperation, sourceErrorCode),
    error: promptResult.errorMessage ?? 'provider_unavailable',
    sourceOperation,
    sourceErrorCode,
    httpStatus: promptResult.errorEvidence?.httpStatus,
  });
  input.activeRun.settlePromptTerminal({
    outcome: 'failed',
    error: buildPromptFailureError(promptResult, sourceOperation, sourceErrorCode),
  });
}

function handlePromptSuccess(
  input: Parameters<typeof bindProviderPromptTerminal>[0],
  startedAt: number,
  promptResult: Extract<PromptSessionActionResult, { success: true }>,
): void {
  logPromptCompleted(input, startedAt, promptResult.data.terminal);
  if (promptResult.data.terminal.kind === 'aborted') {
    input.activeRuns.abortAllByHostSession(input.context.sessionContext.opencodeSessionId, 'prompt_terminal_aborted');
    return;
  }
  input.activeRun.settlePromptTerminal(toProviderTerminalResult(promptResult.data.terminal));
}

function handlePromptException(
  input: Parameters<typeof bindProviderPromptTerminal>[0],
  startedAt: number,
  error: unknown,
): void {
  invalidateExecutionSessionAfterFailure(input, error);
  input.context.logger?.error('provider_adapter.prompt.threw', appendTerminalSourceEvidence({
    toolSessionId: input.context.anchor,
    opencodeSessionId: input.context.sessionContext.opencodeSessionId,
    runId: input.activeRun.runId,
    durationMs: Math.max(0, Date.now() - startedAt),
    error: getErrorMessage(error),
    providerOutcome: 'failed',
    mappedProviderErrorCode: 'internal_error',
  }, error));
  input.activeRun.settlePromptTerminal({
    outcome: 'failed',
    error: {
      code: 'internal_error',
      message: getErrorMessage(error),
    },
  });
}

function invalidateExecutionSessionAfterFailure(
  input: Parameters<typeof bindProviderPromptTerminal>[0],
  error: unknown,
): void {
  input.executionSessionInvalidationPort.invalidateAfterFailure({
    conversationId: input.context.anchor,
    hostSessionId: input.context.sessionContext.opencodeSessionId,
    error,
  });
}

function mapPromptFailureCode(
  sourceOperation: unknown,
  sourceErrorCode: unknown,
): 'session_not_found' | 'provider_unavailable' {
  return sourceOperation === 'session.get' && sourceErrorCode === 'session_not_found'
    ? 'session_not_found'
    : 'provider_unavailable';
}

function buildPromptFailureError(
  promptResult: Extract<PromptSessionActionResult, { success: false }>,
  sourceOperation: unknown,
  sourceErrorCode: unknown,
): ProviderError {
  if (mapPromptFailureCode(sourceOperation, sourceErrorCode) === 'session_not_found') {
    return {
      code: 'session_not_found',
      message: promptResult.errorMessage ?? 'session_not_found',
    };
  }
  return {
    code: 'provider_unavailable',
    message: promptResult.errorMessage ?? 'provider_unavailable',
  };
}

function logPromptCompleted(
  input: Parameters<typeof bindProviderPromptTerminal>[0],
  startedAt: number,
  terminal: PromptSessionResultData['terminal'],
): void {
  input.context.logger?.info('provider_adapter.prompt.completed', appendTerminalSourceEvidence({
    toolSessionId: input.context.anchor,
    opencodeSessionId: input.context.sessionContext.opencodeSessionId,
    runId: input.activeRun.runId,
    durationMs: Math.max(0, Date.now() - startedAt),
    terminalKind: terminal.kind,
    providerOutcome: mapPromptTerminalOutcome(terminal.kind),
    ...(terminal.kind === 'failed'
      ? {
          terminalErrorCode: terminal.errorCode,
          terminalErrorMessage: terminal.errorMessage,
          terminalErrorDetails: terminal.errorDetails,
        }
      : {}),
  }, terminal.kind === 'failed' ? terminal.errorDetails : undefined));
}

function mapPromptTerminalOutcome(kind: PromptSessionResultData['terminal']['kind']): 'completed' | 'aborted' | 'failed' {
  if (kind === 'failed') {
    return 'failed';
  }
  if (kind === 'aborted') {
    return 'aborted';
  }
  return 'completed';
}
