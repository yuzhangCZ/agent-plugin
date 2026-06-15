import { GatewayClientError } from '../../errors/GatewayClientError.ts';
import type { GatewayClientErrorCode, GatewayConnectionDisposition } from '../../domain/error-contract.ts';
import type { GatewayInboundFrame } from '../../ports/GatewayClientMessages.ts';
import { buildMessagePreview } from '../telemetry/message-log-fields.ts';

/**
 * 把 invalid inbound frame 统一映射为结构化协议违约错误。
 */
export function buildProtocolViolationError(
  inboundFrame: GatewayInboundFrame & { kind: 'invalid' },
  facts: {
    code: GatewayClientErrorCode;
    disposition: GatewayConnectionDisposition;
  },
): GatewayClientError {
  return new GatewayClientError({
    code: facts.code,
    disposition: facts.disposition,
    retryable: false,
    message: inboundFrame.violation.violation.message,
    details: {
      ...inboundFrame.violation.violation,
      gatewayMessageId: inboundFrame.gatewayMessageId,
      action: inboundFrame.action ?? inboundFrame.violation.violation.action,
      welinkSessionId: inboundFrame.welinkSessionId ?? inboundFrame.violation.violation.welinkSessionId,
      toolSessionId: inboundFrame.toolSessionId ?? inboundFrame.violation.violation.toolSessionId,
      messagePreview: buildMessagePreview(inboundFrame.rawPreview),
    },
    cause: inboundFrame.violation,
  });
}
