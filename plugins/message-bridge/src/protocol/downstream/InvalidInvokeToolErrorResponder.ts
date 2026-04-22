import type { GatewayInboundFrame } from '@agent-plugin/gateway-client';

import type { ActionResult } from '../../types/index.js';
import type { BridgeLogger } from '../../runtime/AppLogger.js';

interface InvalidInvokeToolErrorSendOptions {
  logger?: BridgeLogger;
  traceId?: string;
  gatewayMessageId?: string;
  action?: string;
  toolSessionId?: string;
}

interface InvalidInvokeToolErrorResponderOptions {
  sendToolError: (result: ActionResult, welinkSessionId?: string, logOptions?: InvalidInvokeToolErrorSendOptions) => void;
  canReply: () => boolean;
  getConnectionState?: () => string | undefined;
}

function buildInvalidInvokeToolError(code: string): string {
  return `gateway_invalid_invoke:${code}`;
}

/**
 * invalid invoke responder。
 * @remarks 仅消费 gateway-client 暴露的 invalid inbound envelope，best-effort 翻译为 tool_error；
 * 不重复承担共享协议校验，也不通过 error 事件触发回包。
 */
export class InvalidInvokeToolErrorResponder {
  private readonly sendToolError: InvalidInvokeToolErrorResponderOptions['sendToolError'];
  private readonly canReply: InvalidInvokeToolErrorResponderOptions['canReply'];
  private readonly getConnectionState?: InvalidInvokeToolErrorResponderOptions['getConnectionState'];

  constructor(options: InvalidInvokeToolErrorResponderOptions) {
    this.sendToolError = options.sendToolError;
    this.canReply = options.canReply;
    this.getConnectionState = options.getConnectionState;
  }

  respond(frame: GatewayInboundFrame, logger: BridgeLogger): boolean {
    if (frame.kind !== 'invalid' || frame.messageType !== 'invoke') {
      return false;
    }

    const { gatewayMessageId, action, welinkSessionId, toolSessionId, rawPreview } = frame;
    const diagnostics = {
      gatewayMessageId,
      action,
      welinkSessionId,
      toolSessionId,
      errorCode: frame.violation.violation.code,
      stage: frame.violation.violation.stage,
      field: frame.violation.violation.field,
      violationMessage: frame.violation.violation.message,
      rawPreview,
    };

    if (!welinkSessionId && !toolSessionId) {
      logger.warn('runtime.invalid_invoke.unreplyable', diagnostics);
      return true;
    }

    if (!this.canReply()) {
      logger.warn('runtime.invalid_invoke.skipped_not_ready', {
        ...diagnostics,
        state: this.getConnectionState?.(),
      });
      return true;
    }

    logger.warn('runtime.invalid_invoke.replying_tool_error', diagnostics);
    this.sendToolError(
      {
        success: false,
        errorCode: 'INVALID_PAYLOAD',
        errorMessage: buildInvalidInvokeToolError(frame.violation.violation.code),
      },
      welinkSessionId,
      {
        logger,
        traceId: gatewayMessageId ?? logger.getTraceId(),
        gatewayMessageId,
        action,
        toolSessionId,
      },
    );
    return true;
  }
}
