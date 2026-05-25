import type { ToolErrorMessage } from '@agent-plugin/gateway-schema';

import { RuntimeContractError } from '../../domain/errors.ts';
import { GATEWAY_UPLINK_MESSAGE_TYPE } from '../constants/gateway-messages.ts';
import { ToolErrorMessageCatalog } from './ToolErrorMessageCatalog.ts';

export type CommandFailureSummary = {
  messageType: string;
  action?: string;
  toolSessionId?: string;
  welinkSessionId?: string;
};

function normalizeErrorMessage(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * downstream command failure -> `tool_error` projector。
 * @remarks
 * 只负责 command failure 的前端回包，不处理 request run 生命周期中途失败。
 */
export class CommandFailureToolErrorProjector {
  private readonly catalog: ToolErrorMessageCatalog;

  constructor(catalog: ToolErrorMessageCatalog) {
    this.catalog = catalog;
  }

  project(input: { summary: CommandFailureSummary; error: unknown }): ToolErrorMessage | null {
    if (input.summary.messageType !== 'invoke') {
      return null;
    }
    if (!input.summary.toolSessionId && !input.summary.welinkSessionId) {
      return null;
    }
    if (!this.isSupportedAction(input.summary.action)) {
      return null;
    }

    const errorMessage = this.resolveErrorMessage(input.error);
    if (!errorMessage) {
      return null;
    }

    return {
      type: GATEWAY_UPLINK_MESSAGE_TYPE.toolError,
      ...(input.summary.toolSessionId ? { toolSessionId: input.summary.toolSessionId } : {}),
      ...(input.summary.welinkSessionId ? { welinkSessionId: input.summary.welinkSessionId } : {}),
      error: errorMessage,
    };
  }

  private resolveErrorMessage(error: unknown): string | null {
    if (error instanceof RuntimeContractError) {
      switch (error.code) {
        case 'run_already_active':
          return this.catalog.get('run_already_active');
        case 'pending_interaction_not_found':
          return this.catalog.get('pending_interaction_not_found');
        case 'fact_sequence_invalid':
        case 'pending_interaction_conflict':
        case 'outbound_already_active':
        case 'session_closed':
        case 'session_not_found':
          return null;
      }
    }

    return normalizeErrorMessage(error);
  }

  private isSupportedAction(action: string | undefined): boolean {
    return action === 'chat'
      || action === 'create_session'
      || action === 'question_reply'
      || action === 'permission_reply'
      || action === 'close_session'
      || action === 'abort_session';
  }
}
