import {
  Action,
  AbortSessionPayload,
  AbortSessionResultData,
  ActionResult,
  ActionContext,
  ErrorCode,
  stateToErrorCode,
} from '../types/index.js';
import { getErrorDetailsForLog, getErrorMessage } from '../utils/error.js';
import type { SessionScopedActionGatewayPort } from '../port/SessionScopedActionGatewayPort.js';

export class AbortSessionAction implements Action<'abort_session', AbortSessionPayload, AbortSessionResultData> {
  name: 'abort_session' = 'abort_session';

  constructor(private readonly sessionScopedActionGatewayPort: SessionScopedActionGatewayPort) {}

  async execute(
    payload: AbortSessionPayload,
    context: ActionContext,
  ): Promise<ActionResult<AbortSessionResultData>> {
    const startedAt = Date.now();
    context.logger?.info('action.abort_session.started', {
      toolSessionId: payload.toolSessionId,
    });

    try {
      if (context.connectionState !== 'READY') {
        context.logger?.warn('action.abort_session.rejected_state', { state: context.connectionState });
        return {
          success: false,
          errorCode: stateToErrorCode(context.connectionState),
          errorMessage: `Agent not ready. Current state: ${context.connectionState}`,
        };
      }

      const gatewayResult = await this.sessionScopedActionGatewayPort.abortSession({
        sessionId: payload.toolSessionId,
        ...(context.logger ? { logger: context.logger } : {}),
      });

      if (gatewayResult.success) {
        return gatewayResult;
      }

      context.logger?.error('action.abort_session.failed', {
        toolSessionId: payload.toolSessionId,
        error: gatewayResult.errorMessage,
        errorCode: gatewayResult.errorCode,
        latencyMs: Date.now() - startedAt,
      });
      return gatewayResult;
    } catch (error) {
      const errorCode = this.errorMapper(error);
      const errorMessage = getErrorMessage(error);
      context.logger?.error('action.abort_session.exception', {
        toolSessionId: payload.toolSessionId,
        error: errorMessage,
        errorCode,
        ...getErrorDetailsForLog(error),
        latencyMs: Date.now() - startedAt,
      });
      return {
        success: false,
        errorCode,
        errorMessage,
      };
    } finally {
      context.logger?.debug('action.abort_session.finished', { latencyMs: Date.now() - startedAt });
    }
  }

  errorMapper(error: unknown): ErrorCode {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      if (message.includes('timeout') || message.includes('network')) {
        return 'SDK_TIMEOUT';
      }
      if (message.includes('unreachable') || message.includes('connect')) {
        return 'SDK_UNREACHABLE';
      }
      if (message.includes('not found') || message.includes('session')) {
        return 'INVALID_PAYLOAD';
      }
    }

    return 'SDK_UNREACHABLE';
  }
}
