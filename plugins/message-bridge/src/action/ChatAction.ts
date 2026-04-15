import {
  Action,
  ChatPayload,
  ActionResult,
  ActionContext,
  ErrorCode,
  stateToErrorCode
} from '../types/index.js';
import type { ChatUseCase } from '../usecase/ChatUseCase.js';

/**
 * Concrete implementation of chat action for sending messages to OpenCode
 */
export class ChatAction implements Action<'chat', ChatPayload, void> {
  name: 'chat' = 'chat';

  constructor(private readonly chatUseCase: ChatUseCase) {
    if (!chatUseCase) {
      throw new Error('chat_use_case_required');
    }
  }

  /**
   * Execute chat action
   */
  async execute(payload: ChatPayload, context: ActionContext): Promise<ActionResult<void>> {
    const startedAt = Date.now();
    context.logger?.info('action.chat.started', {
      toolSessionId: payload.toolSessionId,
      messageLength: payload.text.length,
    });
    if (context.connectionState !== 'READY') {
      context.logger?.warn('action.chat.rejected_state', { state: context.connectionState });
      return {
        success: false,
        errorCode: stateToErrorCode(context.connectionState),
        errorMessage: `Agent not ready. Current state: ${context.connectionState}`
      };
    }

    try {
      const useCaseResult = await this.chatUseCase.execute({
        payload,
        logger: context.logger,
      });

      if (useCaseResult.success) {
        return {
          success: true,
        }
      }

      context.logger?.error('action.chat.failed', {
        error: useCaseResult.errorMessage,
        errorCode: useCaseResult.errorCode,
        latencyMs: Date.now() - startedAt,
      });
      return {
        success: false,
        errorCode: useCaseResult.errorCode ?? 'SDK_UNREACHABLE',
        errorMessage: useCaseResult.errorMessage ?? 'Failed to send message',
        errorEvidence: useCaseResult.errorEvidence,
      };
    } catch (error) {
      const errorCode = this.errorMapper(error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      context.logger?.error('action.chat.exception', {
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
      context.logger?.debug('action.chat.finished', { latencyMs: Date.now() - startedAt });
    }
  }

  /**
   * Map SDK errors to appropriate error codes
   * Abort-safe: handles all error types without throwing
   */
  errorMapper(error: unknown): ErrorCode {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      if (message.includes('timeout') || message.includes('timed out')) {
        return 'SDK_TIMEOUT';
      } else if (message.includes('unreachable') || message.includes('connect') || message.includes('connection')) {
        return 'SDK_UNREACHABLE';
      } else if (message.includes('not found') || message.includes('session') && message.includes('not found')) {
        return 'INVALID_PAYLOAD';
      } else if (message.includes('abort') || message.includes('cancelled')) {
        return 'INVALID_PAYLOAD';
      }
    } else if (typeof error === 'string') {
      const message = error.toLowerCase();
      if (message.includes('timeout')) {
        return 'SDK_TIMEOUT';
      } else if (message.includes('unreachable') || message.includes('connect')) {
        return 'SDK_UNREACHABLE';
      }
    }

    return 'SDK_UNREACHABLE';
  }
}
