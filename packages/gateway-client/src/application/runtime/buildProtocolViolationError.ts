import { GatewayClientError } from '../../errors/GatewayClientError.ts';
import type { GatewayClientErrorCode, GatewayConnectionDisposition, GatewayConnectionStage } from '../../domain/error-contract.ts';
import type { GatewayInboundFrame } from '../../ports/GatewayClientMessages.ts';
import { buildMessagePreview } from '../telemetry/message-log-fields.ts';

/**
 * 把 invalid inbound frame 统一映射为结构化协议违约错误。
 */
export function buildProtocolViolationError(
  inboundFrame: GatewayInboundFrame & { kind: 'invalid' },
  facts: {
    code?: GatewayClientErrorCode;
    disposition?: GatewayConnectionDisposition;
    stage?: GatewayConnectionStage;
  } = {},
): GatewayClientError {
  return new GatewayClientError({
    code: facts.code ?? 'GATEWAY_INBOUND_PROTOCOL_INVALID',
    disposition: facts.disposition ?? 'diagnostic',
    stage: facts.stage ?? 'ready',
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
