import {
  Action,
  PermissionReplyPayload,
  PermissionReplyResultData,
  ActionResult,
  ActionContext,
  ErrorCode,
  stateToErrorCode
} from '../types/index.js';
import type { SessionScopedActionGatewayPort } from '../port/SessionScopedActionGatewayPort.js';

/**
 * Concrete implementation of permission_reply action.
 * Target format only: { permissionId, toolSessionId, response: 'once'|'always'|'reject' }
 */
export class PermissionReplyAction implements Action<'permission_reply', PermissionReplyPayload, PermissionReplyResultData> {
  name: 'permission_reply' = 'permission_reply';

  constructor(private readonly sessionScopedActionGatewayPort: SessionScopedActionGatewayPort) {}

  /**
   * Execute permission reply action
   */
  async execute(payload: PermissionReplyPayload, context: ActionContext): Promise<ActionResult<PermissionReplyResultData>> {
    const startedAt = Date.now();
    context.logger?.info('action.permission_reply.started', {
      permissionId: payload.permissionId,
      toolSessionId: payload.toolSessionId,
      response: payload.response,
    });

    try {
      if (context.connectionState !== 'READY') {
        context.logger?.warn('action.permission_reply.rejected_state', { state: context.connectionState });
        return {
          success: false,
          errorCode: stateToErrorCode(context.connectionState),
          errorMessage: `Agent not ready. Current state: ${context.connectionState}`
        };
      }

      const gatewayResult = await this.sessionScopedActionGatewayPort.replyPermission({
        sessionId: payload.toolSessionId,
        permissionId: payload.permissionId,
        response: payload.response,
        ...(context.logger ? { logger: context.logger } : {}),
      });

      if (gatewayResult.success) {
        return gatewayResult;
      }

      context.logger?.error('action.permission_reply.failed', {
        error: gatewayResult.errorMessage,
        errorCode: gatewayResult.errorCode,
        latencyMs: Date.now() - startedAt,
      });
      return gatewayResult;
    } catch (error) {
      const errorCode = this.errorMapper(error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      context.logger?.error('action.permission_reply.exception', {
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
      context.logger?.debug('action.permission_reply.finished', { latencyMs: Date.now() - startedAt });
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
      } else if (message.includes('invalid') || message.includes('permission')) {
        return 'INVALID_PAYLOAD';
      }
    }

    return 'SDK_UNREACHABLE';
  }
}
