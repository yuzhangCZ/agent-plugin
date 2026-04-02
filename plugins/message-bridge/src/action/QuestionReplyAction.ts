import {
  Action,
  QuestionReplyPayload,
  QuestionReplyResultData,
  ActionResult,
  ActionContext,
  ErrorCode,
  stateToErrorCode,
} from '../types/index.js';
import { getErrorDetailsForLog, getErrorMessage } from '../utils/error.js';
import type { SessionScopedActionGatewayPort } from '../port/SessionScopedActionGatewayPort.js';

export class QuestionReplyAction implements Action<'question_reply', QuestionReplyPayload, QuestionReplyResultData> {
  name: 'question_reply' = 'question_reply';

  constructor(private readonly sessionScopedActionGatewayPort: SessionScopedActionGatewayPort) {}

  async execute(
    payload: QuestionReplyPayload,
    context: ActionContext,
  ): Promise<ActionResult<QuestionReplyResultData>> {
    const startedAt = Date.now();
    context.logger?.info('action.question_reply.started', {
      toolSessionId: payload.toolSessionId,
      toolCallId: payload.toolCallId,
      answerLength: payload.answer.length,
    });

    if (context.connectionState !== 'READY') {
      context.logger?.warn('action.question_reply.rejected_state', { state: context.connectionState });
      return {
        success: false,
        errorCode: stateToErrorCode(context.connectionState),
        errorMessage: `Agent not ready. Current state: ${context.connectionState}`,
      };
    }

    try {
      const gatewayResult = await this.sessionScopedActionGatewayPort.replyQuestion({
        sessionId: payload.toolSessionId,
        toolCallId: payload.toolCallId,
        answer: payload.answer,
        ...(context.logger ? { logger: context.logger } : {}),
      });

      if (gatewayResult.success) {
        return gatewayResult;
      }

      context.logger?.error('action.question_reply.failed', {
        toolSessionId: payload.toolSessionId,
        toolCallId: payload.toolCallId,
        error: gatewayResult.errorMessage,
        errorCode: gatewayResult.errorCode,
        latencyMs: Date.now() - startedAt,
      });
      return gatewayResult;
    } catch (error) {
      const errorCode = this.errorMapper(error);
      const errorMessage = getErrorMessage(error);
      context.logger?.error('action.question_reply.exception', {
        toolSessionId: payload.toolSessionId,
        toolCallId: payload.toolCallId,
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
      context.logger?.debug('action.question_reply.finished', { latencyMs: Date.now() - startedAt });
    }
  }

  errorMapper(error: unknown): ErrorCode {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      if (message.includes('timeout') || message.includes('timed out')) {
        return 'SDK_TIMEOUT';
      }
      if (message.includes('unreachable') || message.includes('connect') || message.includes('connection')) {
        return 'SDK_UNREACHABLE';
      }
      if (message.includes('not found') || (message.includes('session') && message.includes('not found'))) {
        return 'INVALID_PAYLOAD';
      }
      if (message.includes('abort') || message.includes('cancelled')) {
        return 'INVALID_PAYLOAD';
      }
    } else if (typeof error === 'string') {
      const message = error.toLowerCase();
      if (message.includes('timeout') || message.includes('timed out')) {
        return 'SDK_TIMEOUT';
      }
      if (message.includes('unreachable') || message.includes('connect')) {
        return 'SDK_UNREACHABLE';
      }
    }

    return 'SDK_UNREACHABLE';
  }
}
