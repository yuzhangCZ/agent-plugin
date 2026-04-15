import type { GatewayInboundFrame } from "@agent-plugin/gateway-client";

import type { ToolErrorMessage } from "../gateway-wire/transport.js";
import { UPSTREAM_MESSAGE_TYPE } from "../gateway-wire/transport.js";
import type { BridgeLogger } from "../types.js";

interface UpstreamSendContext {
  gatewayMessageId?: string;
  action?: string;
  welinkSessionId?: string;
  toolSessionId?: string;
}

interface InvalidInvokeToolErrorResponderOptions {
  sendToolError: (message: ToolErrorMessage, context?: UpstreamSendContext) => void;
  canReply: () => boolean;
  getConnectionState?: () => string | undefined;
}

function buildInvalidInvokeToolError(code: string): string {
  return `gateway_invalid_invoke:${code}`;
}

/**
 * invalid invoke responder。
 * @remarks 仅消费 gateway-client 产出的 invalid inbound envelope，并将可路由的 invoke 协议违约
 * best-effort 翻译为标准 tool_error；不通过 error 事件触发回包。
 */
export class InvalidInvokeToolErrorResponder {
  private readonly sendToolError: InvalidInvokeToolErrorResponderOptions["sendToolError"];
  private readonly canReply: InvalidInvokeToolErrorResponderOptions["canReply"];
  private readonly getConnectionState?: InvalidInvokeToolErrorResponderOptions["getConnectionState"];

  constructor(options: InvalidInvokeToolErrorResponderOptions) {
    this.sendToolError = options.sendToolError;
    this.canReply = options.canReply;
    this.getConnectionState = options.getConnectionState;
  }

  respond(frame: GatewayInboundFrame, logger: BridgeLogger): boolean {
    if (frame.kind !== "invalid" || frame.messageType !== "invoke") {
      return false;
    }

    const diagnostics = {
      gatewayMessageId: frame.gatewayMessageId,
      action: frame.action,
      welinkSessionId: frame.welinkSessionId,
      toolSessionId: frame.toolSessionId,
      errorCode: frame.violation.violation.code,
      stage: frame.violation.violation.stage,
      field: frame.violation.violation.field,
      violationMessage: frame.violation.violation.message,
      rawPreview: frame.rawPreview,
    };

    if (!frame.welinkSessionId && !frame.toolSessionId) {
      logger.warn("runtime.invalid_invoke.unreplyable", diagnostics);
      return true;
    }

    if (!this.canReply()) {
      logger.warn("runtime.invalid_invoke.skipped_not_ready", {
        ...diagnostics,
        state: this.getConnectionState?.(),
      });
      return true;
    }

    logger.warn("runtime.invalid_invoke.replying_tool_error", diagnostics);
    this.sendToolError(
      {
        type: UPSTREAM_MESSAGE_TYPE.TOOL_ERROR,
        welinkSessionId: frame.welinkSessionId,
        toolSessionId: frame.toolSessionId,
        error: buildInvalidInvokeToolError(frame.violation.violation.code),
      },
      {
        gatewayMessageId: frame.gatewayMessageId,
        action: frame.action,
        welinkSessionId: frame.welinkSessionId,
        toolSessionId: frame.toolSessionId,
      },
    );
    return true;
  }
}
