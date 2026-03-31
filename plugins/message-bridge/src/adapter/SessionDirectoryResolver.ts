import type { BridgeLogger } from '../types/logger.js';
import type { OpencodeClient } from '../types/sdk.js';
import { hasError } from '../types/sdk.js';
import type { ToolErrorEvidence } from '../utils/error.js';
import { getErrorDetailsForLog, getToolErrorEvidence } from '../utils/error.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function extractSessionDirectory(result: unknown): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const nested = isRecord(result.data) ? result.data : undefined;
  return pickString(nested?.directory) ?? pickString(result.directory);
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

export type SessionDirectoryResolutionResult =
  | { success: true; directory: string }
  | {
    success: false;
    reason: 'not_found' | 'failed' | 'missing_directory';
    error?: unknown;
    errorEvidence?: ToolErrorEvidence;
  };

export interface ResolveSessionDirectoryInput {
  sessionId: string;
  logger?: BridgeLogger;
  logFields?: Record<string, unknown>;
}

export class SessionDirectoryResolver {
  constructor(private readonly getClient: () => OpencodeClient | null) {}

  async resolve(input: ResolveSessionDirectoryInput): Promise<SessionDirectoryResolutionResult> {
    const client = this.requireClient();

    try {
      const result = await client.session.get({
        sessionID: input.sessionId,
      });

      if (hasError(result)) {
        return this.handleLookupFailure(result.error, input);
      }

      const directory = extractSessionDirectory(result);
      if (!directory) {
        input.logger?.warn('session_directory.session_get.directory_missing', {
          toolSessionId: input.sessionId,
          ...(input.logFields ?? {}),
        });
        return {
          success: false,
          reason: 'missing_directory',
          errorEvidence: { sourceOperation: 'session.get' },
        };
      }

      input.logger?.debug('session_directory.session_get.directory_resolved', {
        toolSessionId: input.sessionId,
        directory,
        ...(input.logFields ?? {}),
      });
      return {
        success: true,
        directory,
      };
    } catch (error) {
      return this.handleLookupFailure(error, input);
    }
  }

  private handleLookupFailure(
    error: unknown,
    input: ResolveSessionDirectoryInput,
  ): SessionDirectoryResolutionResult {
    if (isNotFoundError(error)) {
      input.logger?.warn('session_directory.session_get.not_found', {
        toolSessionId: input.sessionId,
        ...getErrorDetailsForLog(error),
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

    input.logger?.warn('session_directory.session_get.failed', {
      toolSessionId: input.sessionId,
      ...getErrorDetailsForLog(error),
    });
    return {
      success: false,
      reason: 'failed',
      error,
      errorEvidence: getToolErrorEvidence(error, 'session.get') ?? { sourceOperation: 'session.get' },
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
