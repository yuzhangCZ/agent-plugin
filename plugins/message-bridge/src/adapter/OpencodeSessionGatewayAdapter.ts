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
    const session = nested ?? root;
    return {
      sessionId:
        pickString(root.sessionId) ??
        pickString(root.id) ??
        pickString(nested?.sessionId) ??
        pickString(nested?.id),
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
    errorEvidence: getToolErrorEvidence(errorField, sourceOperation),
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

  async createSession(parameters: { title?: string; directory?: string }): Promise<ActionResult<CreateSessionResultData>> {
    const client = this.requireClient();
    const executionResult = await safeExecute(
      client.session.create({
        ...(parameters.title ? { title: parameters.title } : {}),
        ...(parameters.directory ? { directory: parameters.directory } : {}),
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
    const client = this.requireClient();
    const resolution = await this.sessionDirectoryResolver.resolve({
      sessionId: parameters.sessionId,
      logger: parameters.logger,
      logFields: { hasAgent: Boolean(parameters.agent) },
    });
    if (!resolution.success) {
      return buildDirectoryResolutionFailure('Failed to send message', resolution);
    }

    const executionResult = await safeExecute(
      client.session.prompt({
        sessionID: parameters.sessionId,
        directory: resolution.directory,
        parts: [{ type: 'text', text: parameters.text }],
        ...(parameters.agent ? { agent: parameters.agent } : {}),
      }),
      (error) => getErrorMessage(error),
    );

    if (executionResult.success) {
      if (!hasError(executionResult.data)) {
        return { success: true };
      }

      const errorField =
        executionResult.data && typeof executionResult.data === 'object' && 'error' in executionResult.data
          ? (executionResult.data as { error: unknown }).error
          : undefined;
      return buildSdkPayloadFailure('Failed to send message', errorField, 'session.prompt');
    }

    return buildSdkExecutionFailure('Failed to send message', executionResult.error);
  }

  async abortSession(parameters: {
    sessionId: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<AbortSessionResultData>> {
    const client = this.requireClient();
    const resolution = await this.sessionDirectoryResolver.resolve({
      sessionId: parameters.sessionId,
      logger: parameters.logger,
    });
    if (!resolution.success) {
      return buildDirectoryResolutionFailure('Failed to abort session', resolution);
    }

    const executionResult = await safeExecute(
      client.session.abort({
        sessionID: parameters.sessionId,
        directory: resolution.directory,
      }),
      (error) => getErrorMessage(error),
    );

    if (executionResult.success) {
      if (!hasError(executionResult.data)) {
        return {
          success: true,
          data: { sessionId: parameters.sessionId, aborted: true },
        };
      }

      const errorField =
        executionResult.data && typeof executionResult.data === 'object' && 'error' in executionResult.data
          ? (executionResult.data as { error: unknown }).error
          : undefined;
      return buildSdkPayloadFailure('Failed to abort session', errorField, 'session.abort');
    }

    return buildSdkExecutionFailure('Failed to abort session', executionResult.error);
  }

  async closeSession(parameters: {
    sessionId: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<CloseSessionResultData>> {
    const client = this.requireClient();
    const resolution = await this.sessionDirectoryResolver.resolve({
      sessionId: parameters.sessionId,
      logger: parameters.logger,
    });
    if (!resolution.success) {
      return buildDirectoryResolutionFailure('Failed to close session', resolution);
    }

    const executionResult = await safeExecute(
      client.session.delete({
        sessionID: parameters.sessionId,
        directory: resolution.directory,
      }),
      (error) => getErrorMessage(error),
    );

    if (executionResult.success) {
      if (!hasError(executionResult.data)) {
        return {
          success: true,
          data: { sessionId: parameters.sessionId, closed: true },
        };
      }

      const errorField =
        executionResult.data && typeof executionResult.data === 'object' && 'error' in executionResult.data
          ? (executionResult.data as { error: unknown }).error
          : undefined;
      return buildSdkPayloadFailure('Failed to close session', errorField, 'session.delete');
    }

    return buildSdkExecutionFailure('Failed to close session', executionResult.error);
  }

  async replyPermission(parameters: {
    sessionId: string;
    permissionId: string;
    response: PermissionReplyPayload['response'];
    logger?: BridgeLogger;
  }): Promise<ActionResult<PermissionReplyResultData>> {
    const client = this.requireClient();
    const resolution = await this.sessionDirectoryResolver.resolve({
      sessionId: parameters.sessionId,
      logger: parameters.logger,
    });
    if (!resolution.success) {
      return buildDirectoryResolutionFailure('Failed to reply to permission request', resolution);
    }

    const executionResult = await safeExecute(
      client.postSessionIdPermissionsPermissionId({
        sessionID: parameters.sessionId,
        permissionID: parameters.permissionId,
        response: parameters.response,
        directory: resolution.directory,
      }),
      (error) => getErrorMessage(error),
    );

    if (executionResult.success) {
      if (!hasError(executionResult.data)) {
        return {
          success: true,
          data: {
            permissionId: parameters.permissionId,
            response: parameters.response,
            applied: true,
          },
        };
      }

      const errorField =
        executionResult.data && typeof executionResult.data === 'object' && 'error' in executionResult.data
          ? (executionResult.data as { error: unknown }).error
          : undefined;
      return buildSdkPayloadFailure('Failed to reply to permission request', errorField, 'permission.reply');
    }

    return buildSdkExecutionFailure('Failed to reply to permission request', executionResult.error);
  }

  async replyQuestion(parameters: {
    sessionId: string;
    toolCallId?: string;
    answer: string;
    logger?: BridgeLogger;
  }): Promise<ActionResult<QuestionReplyResultData>> {
    const client = this.requireClient();
    const resolution = await this.sessionDirectoryResolver.resolve({
      sessionId: parameters.sessionId,
      logger: parameters.logger,
    });
    if (!resolution.success) {
      return buildDirectoryResolutionFailure('Failed to reply to question', resolution);
    }

    const listExecutionResult = await safeExecute(
      client._client.get({
        url: '/question',
        query: { directory: resolution.directory },
      }),
      (error) => getErrorMessage(error),
    );

    if (!listExecutionResult.success) {
      return buildSdkExecutionFailure('Failed to reply to question', listExecutionResult.error);
    }

    if (hasError(listExecutionResult.data)) {
      return buildSdkPayloadFailure('Failed to reply to question', listExecutionResult.data.error, 'question.list');
    }

    const pendingQuestions = extractResultData<unknown>(listExecutionResult.data);
    const requests = Array.isArray(pendingQuestions)
      ? pendingQuestions.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
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

    const replyExecutionResult = await safeExecute(
      client._client.post({
        url: '/question/{requestID}/reply',
        path: { requestID: requestId },
        body: { answers: [[parameters.answer]] },
        headers: {
          'Content-Type': 'application/json',
        },
        query: { directory: resolution.directory },
      }),
      (error) => getErrorMessage(error),
    );

    if (!replyExecutionResult.success) {
      return buildSdkExecutionFailure('Failed to reply to question', replyExecutionResult.error);
    }

    if (hasError(replyExecutionResult.data)) {
      return buildSdkPayloadFailure('Failed to reply to question', replyExecutionResult.data.error, 'question.reply');
    }

    return {
      success: true,
      data: {
        requestId,
        replied: true,
      },
    };
  }

  private requireClient(): OpencodeClient {
    const client = this.getClient();
    if (!client) {
      throw new Error('runtime.sdk_client_unavailable');
    }
    return client;
  }
}
