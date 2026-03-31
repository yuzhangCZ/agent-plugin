import type { CreateSessionResultData } from '../contracts/downstream-messages.js';
import type { SessionGatewayPort } from '../port/SessionGatewayPort.js';
import type { OpencodeClient } from '../types/sdk.js';
import { hasError, safeExecute } from '../types/sdk.js';
import type { ActionResult } from '../types/action-runtime.js';
import { getErrorMessage, getToolErrorEvidence } from '../utils/error.js';

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

function isNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  const name = pickString(error.name);
  if (name === 'NotFoundError') {
    return true;
  }

  if ('error' in error) {
    return isNotFoundError((error as { error?: unknown }).error);
  }

  return false;
}

function buildSessionNotFoundFailure(error: unknown): ActionResult<void> {
  return {
    success: false,
    errorCode: 'SDK_UNREACHABLE',
    errorMessage: `Failed to send message: ${getErrorMessage(error)}`,
    errorEvidence: { sourceErrorCode: 'session_not_found' },
  };
}

export class OpencodeSessionGatewayAdapter implements SessionGatewayPort {
  constructor(private readonly getClient: () => OpencodeClient | null) {}

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
        errorEvidence: getToolErrorEvidence(errorField),
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
  }): Promise<ActionResult<void>> {
    const client = this.requireClient();

    if (typeof client.session.get === 'function') {
      try {
        const getResult = await client.session.get({
          sessionID: parameters.sessionId,
        });

        if (hasError(getResult) && isNotFoundError(getResult.error)) {
          return buildSessionNotFoundFailure(getResult.error);
        }
      } catch (error) {
        if (isNotFoundError(error)) {
          return buildSessionNotFoundFailure(error);
        }
      }
    }

    const executionResult = await safeExecute(
      client.session.prompt({
        sessionID: parameters.sessionId,
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
      const errorMessage = errorField !== undefined ? getErrorMessage(errorField) : 'Unknown error';
      return {
        success: false,
        errorCode: 'SDK_UNREACHABLE',
        errorMessage: `Failed to send message: ${errorMessage}`,
        errorEvidence: getToolErrorEvidence(errorField),
      };
    }

    return {
      success: false,
      errorCode: 'SDK_UNREACHABLE',
      errorMessage: `Failed to send message: ${executionResult.error}`,
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
