import {
  Action,
  CreateSessionResultData,
  CreateSessionPayload,
  ActionResult,
  ActionContext,
  ErrorCode,
  hasError,
  safeExecute,
  stateToErrorCode
} from '../types/index.js';
import { getErrorDetailsForLog, getErrorMessage } from '../utils/error.js';
import { attachDirectory } from './directory.js';
import type { CreateSessionUseCase, PreparedCreateSession } from '../usecase/CreateSessionUseCase.js';

/**
 * Concrete implementation of create_session action for creating OpenCode sessions
 */
export class CreateSessionAction implements Action<'create_session', CreateSessionPayload, CreateSessionResultData> {
  name: 'create_session' = 'create_session';

  constructor(private readonly createSessionUseCase?: CreateSessionUseCase) {}

  /**
   * Execute create session action
   */
  async execute(payload: CreateSessionPayload, context: ActionContext): Promise<ActionResult<CreateSessionResultData>> {
    const startedAt = Date.now();
    const payloadKeys = Object.keys(payload ?? {});
    let resolvedDirectory: string | undefined;
    let resolvedDirectorySource: PreparedCreateSession['resolvedDirectorySource'] | undefined;

    try {
      if (context.connectionState !== 'READY') {
        context.logger?.warn('action.create_session.rejected_state', { state: context.connectionState });
        return {
          success: false,
          errorCode: stateToErrorCode(context.connectionState),
          errorMessage: `Agent not ready. Current state: ${context.connectionState}`
        };
      }

      if (this.createSessionUseCase) {
        const preparedCreateSession = await this.createSessionUseCase.resolveCreateSession({
          payload,
          effectiveDirectory: context.effectiveDirectory,
          mappingConfigured: context.assiantDirectoryMappingConfigured,
        });
        resolvedDirectory = preparedCreateSession.resolvedDirectory;
        resolvedDirectorySource = preparedCreateSession.resolvedDirectorySource;
        this.logCreateSessionStarted(context, payloadKeys, preparedCreateSession);

        const useCaseResult = await this.createSessionUseCase.execute({
          payload,
          effectiveDirectory: context.effectiveDirectory,
          mappingConfigured: context.assiantDirectoryMappingConfigured,
        }, preparedCreateSession);

        if (useCaseResult.success) {
          return useCaseResult;
        }

        context.logger?.error('action.create_session.failed', {
          requestedTitle: payload.title,
          resolvedDirectory: preparedCreateSession.resolvedDirectory,
          resolvedDirectorySource: preparedCreateSession.resolvedDirectorySource,
          payloadKeys,
          error: useCaseResult.errorMessage,
          errorCode: useCaseResult.errorCode,
          latencyMs: Date.now() - startedAt,
        });
        return useCaseResult;
      }

      const fallbackResolvedDirectory = this.resolveFallbackDirectory(context.effectiveDirectory);
      resolvedDirectory = fallbackResolvedDirectory.resolvedDirectory;
      resolvedDirectorySource = fallbackResolvedDirectory.resolvedDirectorySource;
      this.logCreateSessionStarted(context, payloadKeys, fallbackResolvedDirectory);

      const executionResult = await safeExecute(
        context.client.session.create(attachDirectory({
          ...(payload.title ? { title: payload.title } : {}),
        }, fallbackResolvedDirectory.resolvedDirectory)),
        (error) => `Create session failed: ${getErrorMessage(error)}`
      );

      if (executionResult.success) {
        if (!hasError(executionResult.data)) {
          const root = executionResult.data as Record<string, unknown> | undefined;
          const nested = root?.data as Record<string, unknown> | undefined;
          const sessionObject = nested ?? root ?? {};
          const pick = (value: unknown): string | undefined =>
            typeof value === 'string' && value.trim() ? value : undefined;
          const returnedSessionId =
            pick(root?.sessionId) ??
            pick(root?.id) ??
            pick(nested?.sessionId) ??
            pick(nested?.id);

          return {
            success: true,
            data: {
              sessionId: returnedSessionId,
              session: sessionObject,
            }
          };
        }

        const errorField =
          executionResult.data && typeof executionResult.data === 'object' && 'error' in executionResult.data
            ? (executionResult.data as { error: unknown }).error
            : undefined;
        const errorMessage = errorField !== undefined ? getErrorMessage(errorField) : 'Unknown error';

        context.logger?.error('action.create_session.sdk_error_payload', {
          requestedTitle: payload.title,
          resolvedDirectory: fallbackResolvedDirectory.resolvedDirectory,
          resolvedDirectorySource: fallbackResolvedDirectory.resolvedDirectorySource,
          payloadKeys,
          error: errorMessage,
          ...(errorField !== undefined ? getErrorDetailsForLog(errorField) : {}),
          latencyMs: Date.now() - startedAt,
        });
        return {
          success: false,
          errorCode: 'SDK_UNREACHABLE',
          errorMessage: `Failed to create session: ${errorMessage}`
        };
      }

      context.logger?.error('action.create_session.failed', {
        requestedTitle: payload.title,
        resolvedDirectory: fallbackResolvedDirectory.resolvedDirectory,
        resolvedDirectorySource: fallbackResolvedDirectory.resolvedDirectorySource,
        payloadKeys,
        error: executionResult.error,
        latencyMs: Date.now() - startedAt,
      });
      return {
        success: false,
        errorCode: 'SDK_UNREACHABLE',
        errorMessage: executionResult.error
      };
    } catch (error) {
      const errorCode = this.errorMapper(error);
      const errorMessage = getErrorMessage(error);
      context.logger?.error('action.create_session.exception', {
        requestedTitle: payload.title,
        resolvedDirectory,
        resolvedDirectorySource,
        payloadKeys,
        error: errorMessage,
        errorCode,
        ...getErrorDetailsForLog(error),
        latencyMs: Date.now() - startedAt,
      });

      return {
        success: false,
        errorCode,
        errorMessage
      };
    } finally {
      context.logger?.debug('action.create_session.finished', { latencyMs: Date.now() - startedAt });
    }
  }

  /**
   * Map SDK errors to appropriate error codes
   */
  errorMapper(error: unknown): ErrorCode {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      if (message.includes('timeout') || message.includes('network')) {
        return 'SDK_TIMEOUT';
      } else if (message.includes('unreachable') || message.includes('connect')) {
        return 'SDK_UNREACHABLE';
      } else if (message.includes('invalid') || message.includes('bad request')) {
        return 'INVALID_PAYLOAD';
      }
    }

    return 'SDK_UNREACHABLE';
  }

  private logCreateSessionStarted(
    context: ActionContext,
    payloadKeys: string[],
    preparedCreateSession: PreparedCreateSession,
  ): void {
    context.logger?.info('action.create_session.started', {
      payloadKeys,
      resolvedDirectory: preparedCreateSession.resolvedDirectory,
      resolvedDirectorySource: preparedCreateSession.resolvedDirectorySource,
    });
  }

  private resolveFallbackDirectory(effectiveDirectory?: string): PreparedCreateSession {
    return {
      directory: effectiveDirectory,
      source: effectiveDirectory ? 'effective' : 'none',
      resolvedDirectory: effectiveDirectory,
      resolvedDirectorySource: effectiveDirectory ? 'effective' : 'none',
    };
  }
}
