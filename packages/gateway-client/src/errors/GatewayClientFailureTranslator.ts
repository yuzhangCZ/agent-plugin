import type {
  GatewayClientErrorShape,
  GatewayClientFailureClass,
  GatewayClientFailureSignal,
  GatewayClientFailureTranslator,
} from '../domain/error-contract.ts';

function resolveFailureClass(error: GatewayClientErrorShape): GatewayClientFailureClass {
  switch (error.code) {
    case 'GATEWAY_AUTH_REJECTED':
    case 'GATEWAY_HANDSHAKE_TIMEOUT':
    case 'GATEWAY_HANDSHAKE_REJECTED':
    case 'GATEWAY_HANDSHAKE_INVALID':
      return 'handshake_failure';
    case 'GATEWAY_TRANSPORT_ERROR':
      return 'transport_failure';
    case 'GATEWAY_INBOUND_PROTOCOL_INVALID':
    case 'GATEWAY_OUTBOUND_PROTOCOL_INVALID':
      return 'protocol_diagnostic';
    case 'GATEWAY_CONNECT_ABORTED':
    case 'GATEWAY_CONNECT_PARAMETER_INVALID':
    case 'GATEWAY_NOT_CONNECTED':
    case 'GATEWAY_NOT_READY':
      return 'state_gate';
  }
}

/**
 * gateway-client 默认公开的中性失败翻译器。
 * @remarks 上层应直接复用这段规则，而不是重新解释底层事实字段。
 */
export const gatewayClientFailureTranslator: GatewayClientFailureTranslator = {
  translate(error: GatewayClientErrorShape): GatewayClientFailureSignal {
    return {
      failureClass: resolveFailureClass(error),
      code: error.code,
      disposition: error.disposition,
      stage: error.stage,
      retryable: error.retryable,
    };
  },
};

/**
 * 将错误事实层翻译为最小稳定失败信号的便捷函数。
 */
export function translateGatewayClientFailure(error: GatewayClientErrorShape): GatewayClientFailureSignal {
  return gatewayClientFailureTranslator.translate(error);
}
