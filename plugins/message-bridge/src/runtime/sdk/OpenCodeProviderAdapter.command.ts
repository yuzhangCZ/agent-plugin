import type {
  ProviderError,
  ProviderRunMessageInput,
} from '@wecode/bridge-runtime-sdk';
import type { OpencodeSessionGatewayAdapter } from '../../adapter/index.js';
import type {
  CommandSessionResultData,
  PromptSessionAssistantError,
  PromptSessionTerminal,
} from '../../port/SessionScopedActionGatewayPort.js';
import type { ActionResult } from '../../types/action-runtime.js';
import { getErrorMessage } from '../../utils/error.js';
import type { BridgeLogger } from '../AppLogger.js';
import type {
  ChatExecutionContext,
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

type CommandSessionActionResult = ActionResult<CommandSessionResultData>;

/**
 * 绑定 OpenCode native command 的终态。
 * @remarks `session.command` 调用失败后不回落 `session.prompt`，避免部分执行后的重复消息。
 */
export async function bindProviderCommandTerminal(input: {
  activeRun: ActiveProviderRunHandle;
  message: ProviderRunMessageInput;
  context: ChatExecutionContext;
  commandName: string;
  arguments: string;
  effectiveDirectory?: string;
  logger: BridgeLogger;
  gatewayAdapter: OpencodeSessionGatewayAdapter;
  executionSessionInvalidationPort: ExecutionSessionInvalidationPort;
  activeRuns: ActiveRunRegistry;
}): Promise<void> {
  const startedAt = Date.now();
  input.logger.info('provider_adapter.command.started', {
    toolSessionId: input.message.toolSessionId,
    opencodeSessionId: input.context.opencodeSessionId,
    runId: input.activeRun.runId,
    commandName: input.commandName,
    hasArguments: Boolean(input.arguments),
    hasAssistantId: Boolean(input.message.assistantId),
  });

  try {
    // session.command 返回 command 生成的 assistant message；provider 终态在本层显式映射。
    const commandResult = await input.gatewayAdapter.commandSession({
      sessionId: input.context.opencodeSessionId,
      commandName: input.commandName,
      arguments: input.arguments,
      ...(input.effectiveDirectory ? { directory: input.effectiveDirectory } : {}),
      agent: input.message.assistantId,
      modelOverride: input.context.modelOverride,
      logger: input.logger,
    });

    if (!commandResult.success) {
      handleCommandFailure(input, startedAt, commandResult);
      return;
    }
    handleCommandSuccess(input, startedAt, commandResult);
  } catch (error) {
    handleCommandException(input, startedAt, error);
  }
}

function handleCommandFailure(
  input: Parameters<typeof bindProviderCommandTerminal>[0],
  startedAt: number,
  commandResult: Extract<CommandSessionActionResult, { success: false }>,
): void {
  invalidateExecutionSessionAfterFailure(input, commandResult);
  const sourceOperation = commandResult.errorEvidence?.sourceOperation;
  const sourceErrorCode = commandResult.errorEvidence?.sourceErrorCode;
  input.logger.warn('provider_adapter.command.failed', {
    toolSessionId: input.message.toolSessionId,
    opencodeSessionId: input.context.opencodeSessionId,
    runId: input.activeRun.runId,
    commandName: input.commandName,
    durationMs: Math.max(0, Date.now() - startedAt),
    providerOutcome: 'failed',
    mappedProviderErrorCode: mapCommandFailureCode(sourceOperation, sourceErrorCode),
    error: commandResult.errorMessage ?? 'provider_unavailable',
    sourceOperation,
    sourceErrorCode,
    httpStatus: commandResult.errorEvidence?.httpStatus,
  });
  input.activeRun.settlePromptTerminal({
    outcome: 'failed',
    error: buildCommandFailureError(commandResult, sourceOperation, sourceErrorCode),
  });
}

function handleCommandSuccess(
  input: Parameters<typeof bindProviderCommandTerminal>[0],
  startedAt: number,
  commandResult: Extract<CommandSessionActionResult, { success: true }>,
): void {
  const terminal = deriveCommandTerminal(commandResult.data);
  input.logger.info('provider_adapter.command.completed', appendTerminalSourceEvidence({
    toolSessionId: input.message.toolSessionId,
    opencodeSessionId: input.context.opencodeSessionId,
    runId: input.activeRun.runId,
    commandName: input.commandName,
    durationMs: Math.max(0, Date.now() - startedAt),
    terminalKind: terminal.kind,
    providerOutcome: terminal.kind === 'failed' ? 'failed' : 'completed',
  }, terminal.kind === 'failed' ? terminal.errorDetails : undefined));
  if (terminal.kind === 'aborted') {
    input.activeRuns.abortAllByHostSession(input.context.opencodeSessionId, 'prompt_terminal_aborted');
    return;
  }
  input.activeRun.settlePromptTerminal(toProviderTerminalResult(terminal));
}

function handleCommandException(
  input: Parameters<typeof bindProviderCommandTerminal>[0],
  startedAt: number,
  error: unknown,
): void {
  invalidateExecutionSessionAfterFailure(input, error);
  input.logger.error('provider_adapter.command.threw', appendTerminalSourceEvidence({
    toolSessionId: input.message.toolSessionId,
    opencodeSessionId: input.context.opencodeSessionId,
    runId: input.activeRun.runId,
    commandName: input.commandName,
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
  input: Parameters<typeof bindProviderCommandTerminal>[0],
  error: unknown,
): void {
  input.executionSessionInvalidationPort.invalidateAfterFailure({
    conversationId: input.message.toolSessionId,
    hostSessionId: input.context.opencodeSessionId,
    error,
  });
}

function mapCommandFailureCode(
  sourceOperation: unknown,
  sourceErrorCode: unknown,
): 'session_not_found' | 'provider_unavailable' {
  return sourceOperation === 'session.get' && sourceErrorCode === 'session_not_found'
    ? 'session_not_found'
    : 'provider_unavailable';
}

function buildCommandFailureError(
  commandResult: Extract<CommandSessionActionResult, { success: false }>,
  sourceOperation: unknown,
  sourceErrorCode: unknown,
): ProviderError {
  if (mapCommandFailureCode(sourceOperation, sourceErrorCode) === 'session_not_found') {
    return {
      code: 'session_not_found',
      message: commandResult.errorMessage ?? 'session_not_found',
    };
  }
  return {
    code: 'provider_unavailable',
    message: commandResult.errorMessage ?? 'provider_unavailable',
  };
}

function deriveCommandTerminal(result: CommandSessionResultData): PromptSessionTerminal {
  const error = result.message.info.error;
  if (!error) {
    return { kind: 'completed' };
  }
  if (error.name === 'MessageAbortedError') {
    return { kind: 'aborted' };
  }
  return {
    kind: 'failed',
    errorCode: 'internal_error',
    errorMessage: formatCommandError(error),
    errorDetails: {
      name: error.name,
      ...(error.details ?? {}),
    },
  };
}

function formatCommandError(error: PromptSessionAssistantError): string {
  return error.message ? `${error.name}: ${error.message}` : error.name;
}
