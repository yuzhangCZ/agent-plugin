import type {
  GatewayClientErrorShape,
  GatewayClientFailureClass,
  GatewayClientFailureSignal,
  GatewayClientFailureTranslator,
} from '../domain/error-contract.ts';

function resolveFailureClass(error: GatewayClientErrorShape): GatewayClientFailureClass {
  switch (error.source) {
    case 'handshake':
      return 'handshake_failure';
    case 'transport':
      return 'transport_failure';
    case 'inbound_protocol':
    case 'outbound_protocol':
      return 'protocol_diagnostic';
    case 'state_gate':
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
      phase: error.phase,
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
