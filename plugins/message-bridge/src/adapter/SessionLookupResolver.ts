import type { BridgeLogger } from '../types/logger.js';
import type { BridgeSdkClient } from '../types/sdk.js';
import { hasError } from '../types/sdk.js';
import type { ToolErrorEvidence } from '../utils/error.js';
import { getErrorDetailsForLog, getToolErrorEvidence } from '../utils/error.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  if (pickString(error.name) === 'NotFoundError') {
    return true;
  }

  if ('error' in error) {
    return isNotFoundError((error as { error?: unknown }).error);
  }

  return false;
}

function extractSessionView(result: unknown): SessionLookupView {
  if (!isRecord(result)) {
    return {};
  }

  const nested = isRecord(result.data) ? result.data : undefined;
  return {
    ...(pickString(nested?.id) ? { id: pickString(nested?.id) } : {}),
    ...(pickString(nested?.directory) ? { directory: pickString(nested?.directory) } : {}),
  };
}

function buildInvalidSessionLookupError(sessionId: string): Error {
  return new Error(`Invalid session.get response shape: missing session id for ${sessionId}`);
}

/** session.get 预检后暴露给后续阶段的最小 session 视图。 */
export interface SessionLookupView {
  id?: string;
  directory?: string;
}

export type SessionLookupResult =
  | {
    success: true;
    session: SessionLookupView;
  }
  | {
    success: false;
    reason: 'not_found' | 'failed';
    error?: unknown;
    errorEvidence?: ToolErrorEvidence;
  };

/** session.get 预检输入。 */
export interface ResolveSessionLookupInput {
  sessionId: string;
  logger?: BridgeLogger;
  logFields?: Record<string, unknown>;
}

/**
 * session.get 预检解析器。
 * @remarks 仅负责确认 session 是否存在，并提取 prompt 目录策略所需的最小视图。
 */
export class SessionLookupResolver {
  constructor(private readonly getClient: () => BridgeSdkClient | null) {}

  async resolve(input: ResolveSessionLookupInput): Promise<SessionLookupResult> {
    try {
      const client = this.requireClient();
      const result = await client.session.get({
        sessionID: input.sessionId,
      });

      if (hasError(result)) {
        return this.handleLookupFailure(result.error, input);
      }

      const session = extractSessionView(result);
      if (!session.id) {
        return this.handleLookupFailure(buildInvalidSessionLookupError(input.sessionId), input);
      }
      input.logger?.debug('session_lookup.session_get.succeeded', {
        toolSessionId: input.sessionId,
        hasDirectory: Boolean(session.directory),
        ...(input.logFields ?? {}),
      });
      return {
        success: true,
        session,
      };
    } catch (error) {
      return this.handleLookupFailure(error, input);
    }
  }

  private handleLookupFailure(
    error: unknown,
    input: ResolveSessionLookupInput,
  ): SessionLookupResult {
    if (isNotFoundError(error)) {
      input.logger?.warn('session_lookup.session_get.not_found', {
        toolSessionId: input.sessionId,
        ...getErrorDetailsForLog(error),
        ...(input.logFields ?? {}),
      });
      return {
        success: false,
        reason: 'not_found',
        error,
        errorEvidence: {
          sourceErrorCode: 'session_not_found',
          sourceOperation: 'session.get',
        },
      };
    }

    input.logger?.warn('session_lookup.session_get.failed', {
      toolSessionId: input.sessionId,
      ...getErrorDetailsForLog(error),
      ...(input.logFields ?? {}),
    });
    return {
      success: false,
      reason: 'failed',
      error,
      errorEvidence: getToolErrorEvidence(error, 'session.get') ?? { sourceOperation: 'session.get' },
    };
  }

  private requireClient(): BridgeSdkClient {
    const client = this.getClient();
    if (!client) {
      throw new Error('runtime.sdk_client_unavailable');
    }
    return client;
  }
}
