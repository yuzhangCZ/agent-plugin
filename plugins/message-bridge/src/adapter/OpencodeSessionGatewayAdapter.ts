/* eslint-disable max-lines -- 历史适配器集中承载 OpenCode 兼容解析，本次只调整 question reply 契约。 */
import type { CreateSessionResultData } from '../contracts/downstream-messages.js';
import type {
  AbortSessionResultData,
  CloseSessionResultData,
  PermissionReplyPayload,
  PermissionReplyResultData,
  QuestionReplyResultData,
} from '../contracts/downstream-messages.js';
import type { SessionModelOverride } from '../port/SlashCommandControlPlanePort.js';
import type { SessionCreationPort } from '../port/SessionCreationPort.js';
import type {
  PromptSessionAssistantError,
  PromptSessionAssistantTokens,
  PromptSessionMessagePart,
  PromptSessionResultData,
  PromptSessionTerminal,
  SessionScopedActionGatewayPort,
} from '../port/SessionScopedActionGatewayPort.js';
import type { BridgeSdkClient } from '../types/sdk.js';
import { hasError, safeExecute } from '../types/sdk.js';
import type { ActionResult } from '../types/action-runtime.js';
import type { BridgeLogger } from '../types/logger.js';
import type { ToolErrorEvidence } from '../utils/error.js';
import { getErrorMessage, getToolErrorEvidence } from '../utils/error.js';
import { SessionLookupResolver, type SessionLookupResult } from './SessionLookupResolver.js';

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function extractSessionObject(result: unknown): {
  sessionId?: string;
  session: Record<string, unknown>;
} {
  if (result && typeof result === 'object') {
    const root = result as Record<string, unknown>;
    const nested = root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : undefined;
    const session = nested ?? {};
    return {
      sessionId: pickString(nested?.id),
      session,
    };
  }
  return { session: {} };
}

function buildPreflightFailure<TData>(
  failurePrefix: string,
  resolution: Extract<SessionLookupResult, { success: false }>,
): ActionResult<TData> {
  return {
    success: false,
    errorCode: 'SDK_UNREACHABLE',
    errorMessage: `${failurePrefix}: ${getErrorMessage(resolution.error)}`,
    errorEvidence: resolution.errorEvidence,
  };
}

function buildSdkPayloadFailure<TData>(
  failurePrefix: string,
  errorField: unknown,
  sourceOperation?: Parameters<typeof getToolErrorEvidence>[1],
): ActionResult<TData> {
  const errorMessage = errorField !== undefined ? getErrorMessage(errorField) : 'Unknown error';
  return {
    success: false,
    errorCode: 'SDK_UNREACHABLE',
    errorMessage: `${failurePrefix}: ${errorMessage}`,
    errorEvidence: getToolErrorEvidence(errorField, sourceOperation) ?? (sourceOperation ? { sourceOperation } : undefined),
  };
}

function buildSdkExecutionFailure<TData>(failurePrefix: string, errorMessage: string): ActionResult<TData> {
  return {
    success: false,
    errorCode: 'SDK_UNREACHABLE',
    errorMessage: `${failurePrefix}: ${errorMessage}`,
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractResultData<T>(result: unknown): T | undefined {
  const resultRecord = readRecord(result);
  if (!resultRecord) {
    return undefined;
  }
  if ('data' in resultRecord) {
    return resultRecord.data as T;
  }
  return result as T;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolvePromptAssistantErrorDetails(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!record) {
    return undefined;
  }
  const nestedDetails = readRecord(record.data);
  const legacyDetails = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== 'name' && key !== 'data'),
  );
  const merged = {
    ...legacyDetails,
    ...(nestedDetails ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizePromptAssistantError(value: unknown): PromptSessionAssistantError | undefined {
  const record = readRecord(value);
  const name = readString(record?.name);
  if (!name) {
    return undefined;
  }
  const details = resolvePromptAssistantErrorDetails(record);
  const message = readString(details?.message);
  return {
    name,
    ...(message ? { message } : {}),
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// eslint-disable-next-line complexity -- 兼容 OpenCode prompt tokens 多字段缺省判断，后续适配器拆分时统一收敛。
function normalizePromptAssistantTokens(value: unknown): PromptSessionAssistantTokens | undefined {
  const record = readRecord(value);
  const cache = readRecord(record?.cache);
  const input = readNumber(record?.input);
  const output = readNumber(record?.output);
  const reasoning = readNumber(record?.reasoning);
  const read = readNumber(cache?.read);
  const write = readNumber(cache?.write);
  if (
    input === undefined
    || output === undefined
    || reasoning === undefined
    || read === undefined
    || write === undefined
  ) {
    return undefined;
  }
  return {
    ...(readNumber(record?.total) !== undefined ? { total: readNumber(record?.total) } : {}),
    input,
    output,
    reasoning,
    cache: {
      read,
      write,
    },
  };
}

// eslint-disable-next-line complexity -- 兼容 OpenCode prompt message 多分支解析，当前 PR 不改动该历史结构。
function normalizePromptMessage(result: unknown): PromptSessionResultData['message'] | undefined {
  const data = extractResultData<unknown>(result);
  const root = readRecord(data);
  const info = readRecord(root?.info);
  const id = readString(info?.id);
  const tokens = normalizePromptAssistantTokens(info?.tokens);
  const cost = readNumber(info?.cost);
  const parts = Array.isArray(root?.parts)
    ? root.parts
      .map((part) => readRecord(part))
      .filter((part): part is Record<string, unknown> => Boolean(part))
      // eslint-disable-next-line complexity -- 单个 part 归一化需同时兼容 text/tool/reasoning 等旧结构。
      .map((part): PromptSessionMessagePart | undefined => {
        const id = readString(part.id);
        const sessionID = readString(part.sessionID);
        const messageID = readString(part.messageID);
        const type = readString(part.type);
        if (!id || !sessionID || !messageID || !type) {
          return undefined;
        }
        const tool = readRecord(part.tool);
        const state = readRecord(part.state);
        return {
          id,
          sessionID,
          messageID,
          type,
          ...(readString(part.text) ? { text: readString(part.text) } : {}),
          ...(readString(part.reason) ? { reason: readString(part.reason) } : {}),
          ...(normalizePromptAssistantTokens(part.tokens) ? { tokens: normalizePromptAssistantTokens(part.tokens) } : {}),
          ...(readNumber(part.cost) !== undefined ? { cost: readNumber(part.cost) } : {}),
          ...(tool
            ? {
                tool: {
                  ...(readString(tool.callID) ? { callID: readString(tool.callID) } : {}),
                  ...(readString(tool.name) ? { name: readString(tool.name) } : {}),
                },
              }
            : {}),
          ...(state
            ? {
                state: {
                  status: (readString(state?.status) as NonNullable<PromptSessionMessagePart['state']>['status'] | undefined) ?? 'pending',
                  ...(readRecord(state.input) ? { input: readRecord(state.input) } : {}),
                  ...(readString(state.raw) ? { raw: readString(state.raw) } : {}),
                  ...(readString(state.title) ? { title: readString(state.title) } : {}),
                  ...(readString(state.output) ? { output: readString(state.output) } : {}),
                  ...(readString(state.error) ? { error: readString(state.error) } : {}),
                  ...(readRecord(state.metadata) ? { metadata: readRecord(state.metadata) } : {}),
                },
              }
            : {}),
        };
      })
      .filter((part): part is PromptSessionMessagePart => Boolean(part))
    : [];
  if (!id || !tokens || cost === undefined) {
    return undefined;
  }

  return {
    info: {
      id,
      ...(normalizePromptAssistantError(info?.error) ? { error: normalizePromptAssistantError(info?.error) } : {}),
      ...(readString(info?.finish) ? { finish: readString(info?.finish) } : {}),
      cost,
      tokens,
    },
    parts,
  };
}

function readPromptRawAssistantError(result: unknown): Record<string, unknown> | undefined {
  const data = extractResultData<Record<string, unknown>>(result);
  const info = readRecord(data?.info);
  return readRecord(info?.error);
}

function logPromptAssistantErrorDiagnostic(parameters: {
  logger?: BridgeLogger;
  sessionId: string;
  result: unknown;
  normalizedError: PromptSessionAssistantError;
}): void {
  const rawError = readPromptRawAssistantError(parameters.result);
  const rawDetails = resolvePromptAssistantErrorDetails(rawError);
  parameters.logger?.debug('session_prompt.assistant_error.normalized', {
    toolSessionId: parameters.sessionId,
    rawErrorName: readString(rawError?.name),
    rawDataHasMessage: Boolean(readString(rawDetails?.message)),
    rawDataStatusCode: readNumber(rawDetails?.statusCode),
    rawDataIsRetryable: readBoolean(rawDetails?.isRetryable) ?? readBoolean(rawDetails?.retryable),
    normalizedErrorName: parameters.normalizedError.name,
    normalizedHasMessage: Boolean(parameters.normalizedError.message),
    normalizedStatusCode: readNumber(parameters.normalizedError.details?.statusCode),
    normalizedIsRetryable: readBoolean(parameters.normalizedError.details?.isRetryable)
      ?? readBoolean(parameters.normalizedError.details?.retryable),
  });
}

function derivePromptTerminal(message: PromptSessionResultData['message']): PromptSessionTerminal {
  if (!message.info.error) {
    return { kind: 'completed' };
  }
  if (message.info.error.name === 'MessageAbortedError') {
    return { kind: 'aborted' };
  }

  return {
    kind: 'failed',
    errorCode: 'internal_error',
    errorMessage: formatPromptTerminalError(message.info.error),
    errorDetails: buildPromptTerminalErrorDetails(message.info.error),
  };
}

function buildPromptTerminalErrorDetails(error: PromptSessionAssistantError): Record<string, unknown> {
  return {
    name: error.name,
    ...(error.details ?? {}),
  };
}

function formatPromptTerminalError(error: PromptSessionAssistantError): string {
  const base = error.message
    ? `${error.name}: ${error.message}`
    : error.name;

  const statusCode = readNumber(error.details?.statusCode);
  if (statusCode === undefined) {
    return base;
  }

  return `${base} statusCode=${statusCode}`;
}

function buildPromptPayloadFailure(
  failurePrefix: string,
  sourceOperation: NonNullable<ToolErrorEvidence['sourceOperation']>,
  result: unknown,
): ActionResult<PromptSessionResultData> {
  const message = normalizePromptMessage(result);
  if (message) {
    return {
      success: true,
      data: {
        message,
        terminal: derivePromptTerminal(message),
      },
    };
  }

  const errorField = result && typeof result === 'object' && 'error' in (result as Record<string, unknown>)
    ? (result as { error: unknown }).error
    : undefined;
  const errorMessage = errorField !== undefined ? getErrorMessage(errorField) : 'Invalid prompt response';
  return {
    success: false,
    errorCode: 'SDK_UNREACHABLE',
    errorMessage: `${failurePrefix}: ${errorMessage}`,
    errorEvidence: getToolErrorEvidence(errorField ?? result, sourceOperation) ?? { sourceOperation },
  };
}

export class OpencodeSessionGatewayAdapter implements SessionCreationPort, SessionScopedActionGatewayPort {
  private readonly sessionLookupResolver: SessionLookupResolver;

  constructor(private readonly getClient: () => BridgeSdkClient | null) {
    this.sessionLookupResolver = new SessionLookupResolver(getClient);
  }

  private async executeSdkCall<TResult>(parameters: {
    failurePrefix: string;
    sourceOperation?: Parameters<typeof getToolErrorEvidence>[1];
    promiseFactory: () => Promise<unknown>;
    onSuccess: (data: unknown) => ActionResult<TResult>;
  }): Promise<ActionResult<TResult>> {
    const executionResult = await safeExecute(
      parameters.promiseFactory(),
      (error) => getErrorMessage(error),
    );

    if (!executionResult.success) {
      return buildSdkExecutionFailure(parameters.failurePrefix, executionResult.error);
    }

    if (hasError(executionResult.data)) {
      return buildSdkPayloadFailure(
        parameters.failurePrefix,
        this.extractSdkErrorField(executionResult.data),
        parameters.sourceOperation,
      );
    }

    return parameters.onSuccess(executionResult.data);
  }

  private extractSdkErrorField(result: unknown): unknown {
    return result && typeof result === 'object' && 'error' in result
      ? (result as { error: unknown }).error
      : undefined;
  }

  async createSession(parameters: {
    title?: string;
    directory?: string;
    permission?: Array<Record<string, unknown>>;
  }): Promise<ActionResult<CreateSessionResultData>> {
    const client = this.requireClient();
    const executionResult = await safeExecute(
      client.session.create({
        ...(parameters.title ? { title: parameters.title } : {}),
        ...(parameters.directory ? { directory: parameters.directory } : {}),
        ...(parameters.permission ? { permission: parameters.permission } : {}),
      }),
      (error) => getErrorMessage(error),
    );

    if (executionResult.success) {
      if (!hasError(executionResult.data)) {
        const { sessionId, session } = extractSessionObject(executionResult.data);
        return {
          success: true,
          data: {
            sessionId,
            session,
          },
        };
      }

      const errorField =
        executionResult.data && typeof executionResult.data === 'object' && 'error' in executionResult.data
          ? (executionResult.data as { error: unknown }).error
          : undefined;
      const errorMessage = errorField !== undefined ? getErrorMessage(errorField) : 'Unknown error';
      return {
        success: false,
        errorCode: 'SDK_UNREACHABLE',
        errorMessage: `Failed to create session: ${errorMessage}`,
        errorEvidence: getToolErrorEvidence(errorField, 'session.create'),
      };
    }

    return {
      success: false,
      errorCode: 'SDK_UNREACHABLE',
      errorMessage: executionResult.error,
    };
  }

  async promptSession(parameters: {
    sessionId: string;
    text: string;
    directory?: string;
    agent?: string;
    modelOverride?: SessionModelOverride;
    logger?: BridgeLogger;
  }): Promise<ActionResult<PromptSessionResultData>> {
    const preflight = await this.preparePromptPreflight({
      sessionId: parameters.sessionId,
      agent: parameters.agent,
      logger: parameters.logger,
    });
    if (!preflight.success) {
      return preflight;
    }
    return this.executePreparedPromptSession(parameters);
  }

  async preparePromptPreflight(parameters: {
    sessionId: string;
    agent?: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<{ sessionId: string }>> {
    const lookup = await this.sessionLookupResolver.resolve({
      sessionId: parameters.sessionId,
      logger: parameters.logger,
      logFields: { hasAgent: Boolean(parameters.agent) },
    });
    if (!lookup.success) {
      return buildPreflightFailure('Failed to send message', lookup);
    }

    return {
      success: true,
      data: {
        sessionId: lookup.session.id ?? parameters.sessionId,
      },
    };
  }

  async executePreparedPromptSession(
    parameters: {
      sessionId: string;
      text: string;
      directory?: string;
      agent?: string;
      modelOverride?: SessionModelOverride;
      logger?: BridgeLogger;
    },
  ): Promise<ActionResult<PromptSessionResultData>> {
    const client = this.requireClient();
    parameters.logger?.debug('session_prompt.request.prepared', {
      sessionId: parameters.sessionId,
      directory: parameters.directory,
      providerID: parameters.modelOverride?.providerId,
      modelID: parameters.modelOverride?.modelId,
      hasAgent: Boolean(parameters.agent),
    });
    return this.executeSdkCall({
      failurePrefix: 'Failed to send message',
      sourceOperation: 'session.prompt',
      promiseFactory: () => client.session.prompt({
        sessionID: parameters.sessionId,
        ...(parameters.directory ? { directory: parameters.directory } : {}),
        ...(parameters.modelOverride
          ? {
              model: {
                providerID: parameters.modelOverride.providerId,
                modelID: parameters.modelOverride.modelId,
              },
            }
          : {}),
        parts: [{ type: 'text', text: parameters.text }],
        ...(parameters.agent ? { agent: parameters.agent } : {}),
      }),
      onSuccess: (result) => {
        const promptResult = buildPromptPayloadFailure('Failed to send message', 'session.prompt', result);
        if (promptResult.success && promptResult.data.message.info.error) {
          logPromptAssistantErrorDiagnostic({
            logger: parameters.logger,
            sessionId: parameters.sessionId,
            result,
            normalizedError: promptResult.data.message.info.error,
          });
        }
        return promptResult;
      },
    });
  }

  async abortSession(parameters: {
    sessionId: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<AbortSessionResultData>> {
    const client = this.requireClient();
    return this.executeSdkCall({
      failurePrefix: 'Failed to abort session',
      sourceOperation: 'session.abort',
      promiseFactory: () => client.session.abort({
        sessionID: parameters.sessionId,
      }),
      onSuccess: () => ({
        success: true,
        data: { sessionId: parameters.sessionId, aborted: true },
      }),
    });
  }

  async closeSession(parameters: {
    sessionId: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<CloseSessionResultData>> {
    const client = this.requireClient();
    return this.executeSdkCall({
      failurePrefix: 'Failed to close session',
      sourceOperation: 'session.delete',
      promiseFactory: () => client.session.delete({
        sessionID: parameters.sessionId,
      }),
      onSuccess: () => ({
        success: true,
        data: { sessionId: parameters.sessionId, closed: true },
      }),
    });
  }

  async replyPermission(parameters: {
    permissionId: string;
    response: PermissionReplyPayload['response'];
    logger?: BridgeLogger;
  }): Promise<ActionResult<PermissionReplyResultData>> {
    const client = this.requireClient();
    return this.executeSdkCall({
      failurePrefix: 'Failed to reply to permission request',
      sourceOperation: 'permission.reply',
      promiseFactory: () => client.permission.reply({
        permissionId: parameters.permissionId,
        response: parameters.response,
      }),
      onSuccess: () => ({
        success: true,
        data: {
          permissionId: parameters.permissionId,
          response: parameters.response,
          applied: true,
        },
      }),
    });
  }

  async replyQuestion(parameters: {
    questionId: string;
    answers: string[][];
    logger?: BridgeLogger;
  }): Promise<ActionResult<QuestionReplyResultData>> {
    const client = this.requireClient();
    return this.executeSdkCall({
      failurePrefix: 'Failed to reply to question',
      sourceOperation: 'question.reply',
      promiseFactory: () => client.question.reply({
        questionId: parameters.questionId,
        answers: parameters.answers,
      }),
      onSuccess: () => ({
        success: true,
        data: {
          requestId: parameters.questionId,
          replied: true,
        },
      }),
    });
  }

  private requireClient(): BridgeSdkClient {
    const client = this.getClient();
    if (!client) {
      throw new Error('runtime.sdk_client_unavailable');
    }
    return client;
  }
}
