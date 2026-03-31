import {
  Action,
  CloseSessionResultData,
  CloseSessionPayload,
  ActionResult,
  ActionContext,
  ErrorCode,
  stateToErrorCode
} from '../types/index.js';
import type { SessionScopedActionGatewayPort } from '../port/SessionScopedActionGatewayPort.js';

/**
 * Concrete implementation of close_session action.
 */
export class CloseSessionAction implements Action<'close_session', CloseSessionPayload, CloseSessionResultData> {
  name: 'close_session' = 'close_session';

  constructor(private readonly sessionScopedActionGatewayPort: SessionScopedActionGatewayPort) {}

  /**
   * Execute close session action.
   */
  async execute(payload: CloseSessionPayload, context: ActionContext): Promise<ActionResult<CloseSessionResultData>> {
    const startedAt = Date.now();
    context.logger?.info('action.close_session.started', {
      toolSessionId: payload.toolSessionId,
    });
    try {
      if (context.connectionState !== 'READY') {
        context.logger?.warn('action.close_session.rejected_state', { state: context.connectionState });
        return {
          success: false,
          errorCode: stateToErrorCode(context.connectionState),
          errorMessage: `Agent not ready. Current state: ${context.connectionState}`
        };
      }

      const gatewayResult = await this.sessionScopedActionGatewayPort.closeSession({
        sessionId: payload.toolSessionId,
        ...(context.logger ? { logger: context.logger } : {}),
      });

      if (gatewayResult.success) {
        return gatewayResult;
      }

      context.logger?.error('action.close_session.failed', {
        error: gatewayResult.errorMessage,
        errorCode: gatewayResult.errorCode,
        latencyMs: Date.now() - startedAt,
      });
      return gatewayResult;
    } catch (error) {
      const errorCode = this.errorMapper(error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      context.logger?.error('action.close_session.exception', {
        error: errorMessage,
        errorCode,
        latencyMs: Date.now() - startedAt,
      });

      return {
        success: false,
        errorCode,
        errorMessage
      };
    } finally {
      context.logger?.debug('action.close_session.finished', { latencyMs: Date.now() - startedAt });
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
      } else if (message.includes('not found') || message.includes('session')) {
        return 'INVALID_PAYLOAD';
      }
    }

    return 'SDK_UNREACHABLE';
  }
}
