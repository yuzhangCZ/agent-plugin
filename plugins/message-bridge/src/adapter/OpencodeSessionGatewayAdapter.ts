import type { CreateSessionResultData } from '../contracts/downstream-messages.js';
import type {
  AbortSessionResultData,
  CloseSessionResultData,
  PermissionReplyPayload,
  PermissionReplyResultData,
  QuestionReplyResultData,
} from '../contracts/downstream-messages.js';
import type { SessionCreationPort } from '../port/SessionCreationPort.js';
import type { SessionScopedActionGatewayPort } from '../port/SessionScopedActionGatewayPort.js';
import type { OpencodeClient } from '../types/sdk.js';
import { hasError, safeExecute } from '../types/sdk.js';
import type { ActionResult } from '../types/action-runtime.js';
import type { BridgeLogger } from '../types/logger.js';
import { getErrorMessage, getToolErrorEvidence } from '../utils/error.js';
import { SessionDirectoryResolver, type SessionDirectoryResolutionResult } from './SessionDirectoryResolver.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

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

function buildDirectoryResolutionFailure<TData>(
  failurePrefix: string,
  resolution: Extract<SessionDirectoryResolutionResult, { success: false }>,
): ActionResult<TData> {
  if (resolution.reason === 'missing_directory') {
    return {
      success: false,
      errorCode: 'SDK_UNREACHABLE',
      errorMessage: `${failurePrefix}: session.get returned without directory`,
      errorEvidence: resolution.errorEvidence,
    };
  }

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

export class OpencodeSessionGatewayAdapter implements SessionCreationPort, SessionScopedActionGatewayPort {
  private readonly sessionDirectoryResolver: SessionDirectoryResolver;

  constructor(private readonly getClient: () => OpencodeClient | null) {
    this.sessionDirectoryResolver = new SessionDirectoryResolver(getClient);
  }

  private async withResolvedDirectory<TResult>(parameters: {
    sessionId: string;
    failurePrefix: string;
    logger?: BridgeLogger;
    logFields?: Record<string, unknown>;
    handler: (context: { client: OpencodeClient; directory: string }) => Promise<ActionResult<TResult>>;
  }): Promise<ActionResult<TResult>> {
    const client = this.requireClient();
    const resolution = await this.sessionDirectoryResolver.resolve({
      sessionId: parameters.sessionId,
      logger: parameters.logger,
      logFields: parameters.logFields,
    });
    if (!resolution.success) {
      return buildDirectoryResolutionFailure(parameters.failurePrefix, resolution);
    }

    return parameters.handler({
      client,
      directory: resolution.directory,
    });
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

  async createSession(parameters: { title?: string; directory?: string, permission?: Array<Record<string, unknown>> }): Promise<ActionResult<CreateSessionResultData>> {
    const client = this.requireClient();
    const executionResult = await safeExecute(
      client.session.create({
        ...(parameters.title ? { title: parameters.title } : {}),
        ...(parameters.directory ? { directory: parameters.directory } : {}),
        ...(parameters.permission ? { permission: parameters.permission } : {})
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
    agent?: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<void>> {
    return this.withResolvedDirectory({
      sessionId: parameters.sessionId,
      failurePrefix: 'Failed to send message',
      logger: parameters.logger,
      logFields: { hasAgent: Boolean(parameters.agent) },
      handler: ({ client, directory }) =>
        this.executeSdkCall({
          failurePrefix: 'Failed to send message',
          sourceOperation: 'session.prompt',
          promiseFactory: () => client.session.prompt({
            sessionID: parameters.sessionId,
            directory,
            parts: [{ type: 'text', text: parameters.text }],
            ...(parameters.agent ? { agent: parameters.agent } : {}),
          }),
          onSuccess: () => ({ success: true }),
        }),
    });
  }

  async abortSession(parameters: {
    sessionId: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<AbortSessionResultData>> {
    return this.withResolvedDirectory({
      sessionId: parameters.sessionId,
      failurePrefix: 'Failed to abort session',
      logger: parameters.logger,
      handler: ({ client, directory }) =>
        this.executeSdkCall({
          failurePrefix: 'Failed to abort session',
          sourceOperation: 'session.abort',
          promiseFactory: () => client.session.abort({
            sessionID: parameters.sessionId,
            directory,
          }),
          onSuccess: () => ({
            success: true,
            data: { sessionId: parameters.sessionId, aborted: true },
          }),
        }),
    });
  }

  async closeSession(parameters: {
    sessionId: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<CloseSessionResultData>> {
    return this.withResolvedDirectory({
      sessionId: parameters.sessionId,
      failurePrefix: 'Failed to close session',
      logger: parameters.logger,
      handler: ({ client, directory }) =>
        this.executeSdkCall({
          failurePrefix: 'Failed to close session',
          sourceOperation: 'session.delete',
          promiseFactory: () => client.session.delete({
            sessionID: parameters.sessionId,
            directory,
          }),
          onSuccess: () => ({
            success: true,
            data: { sessionId: parameters.sessionId, closed: true },
          }),
        }),
    });
  }

  async replyPermission(parameters: {
    sessionId: string;
    permissionId: string;
    response: PermissionReplyPayload['response'];
    logger?: BridgeLogger;
  }): Promise<ActionResult<PermissionReplyResultData>> {
    return this.withResolvedDirectory({
      sessionId: parameters.sessionId,
      failurePrefix: 'Failed to reply to permission request',
      logger: parameters.logger,
      handler: ({ client, directory }) =>
        this.executeSdkCall({
          failurePrefix: 'Failed to reply to permission request',
          sourceOperation: 'permission.reply',
          promiseFactory: () => client.postSessionIdPermissionsPermissionId({
            sessionID: parameters.sessionId,
            permissionID: parameters.permissionId,
            response: parameters.response,
            directory,
          }),
          onSuccess: () => ({
            success: true,
            data: {
              permissionId: parameters.permissionId,
              response: parameters.response,
              applied: true,
            },
          }),
        }),
    });
  }

  async replyQuestion(parameters: {
    sessionId: string;
    toolCallId?: string;
    answer: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<QuestionReplyResultData>> {
    return this.withResolvedDirectory({
      sessionId: parameters.sessionId,
      failurePrefix: 'Failed to reply to question',
      logger: parameters.logger,
      handler: async ({ client, directory }) => {
        const listResult = await this.executeSdkCall({
          failurePrefix: 'Failed to reply to question',
          sourceOperation: 'question.list',
          promiseFactory: () => client._client.get({
            url: '/question',
            query: { directory },
          }),
          onSuccess: (data) => ({
            success: true,
            data: extractResultData<unknown>(data),
          }),
        });

        if (!listResult.success) {
          return listResult;
        }

        const requests = Array.isArray(listResult.data)
          ? listResult.data.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
          : [];

        const matchedRequests = requests.filter((request) => {
          const sessionID = readString(request.sessionID);
          if (sessionID !== parameters.sessionId) {
            return false;
          }

          if (!parameters.toolCallId) {
            return true;
          }

          const tool = readRecord(request.tool);
          return readString(tool?.callID) === parameters.toolCallId;
        });

        const requestId = parameters.toolCallId
          ? readString(matchedRequests[0]?.id)
          : matchedRequests.length === 1
            ? readString(matchedRequests[0]?.id)
            : undefined;

        if (!requestId) {
          return {
            success: false,
            errorCode: 'INVALID_PAYLOAD',
            errorMessage: parameters.toolCallId
              ? `Unable to resolve pending question request for toolSessionId=${parameters.sessionId}, toolCallId=${parameters.toolCallId}`
              : `Unable to resolve a unique pending question request for toolSessionId=${parameters.sessionId}`,
          };
        }

        return this.executeSdkCall({
          failurePrefix: 'Failed to reply to question',
          sourceOperation: 'question.reply',
          promiseFactory: () => client._client.post({
            url: '/question/{requestID}/reply',
            path: { requestID: requestId },
            body: { answers: [[parameters.answer]] },
            headers: {
              'Content-Type': 'application/json',
            },
            query: { directory },
          }),
          onSuccess: () => ({
            success: true,
            data: {
              requestId,
              replied: true,
            },
          }),
        });
      },
    });
  }

  private requireClient(): OpencodeClient {
    const client = this.getClient();
    if (!client) {
      throw new Error('runtime.sdk_client_unavailable');
    }
    return client;
  }
}
