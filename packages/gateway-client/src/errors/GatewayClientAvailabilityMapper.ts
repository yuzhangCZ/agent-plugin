import type {
  GatewayClientAvailability,
  GatewayClientErrorShape,
} from '../domain/error-contract.ts';

/**
 * 将 gateway-client 错误事实映射为共享可用性语义。
 * @remarks
 * 该入口只表达宿主是否应将 gateway 视为 unavailable，不承载配置错误、
 * UI 文案或产品态名称。消费方若需要 `config_invalid` 等本地语义，应在自身
 * adapter 层单独特判。
 */
export function mapGatewayClientAvailability(error: GatewayClientErrorShape): GatewayClientAvailability {
  switch (error.code) {
    case 'GATEWAY_TRANSPORT_ERROR':
      return error.disposition === 'startup_failure' || error.disposition === 'runtime_failure'
        ? 'transport_unavailable'
        : null;
    case 'GATEWAY_AUTH_REJECTED':
    case 'GATEWAY_HANDSHAKE_TIMEOUT':
    case 'GATEWAY_HANDSHAKE_REJECTED':
    case 'GATEWAY_HANDSHAKE_INVALID':
      return error.disposition === 'startup_failure'
        ? 'remote_unavailable'
        : null;
    case 'GATEWAY_CONNECT_ABORTED':
      return error.disposition === 'cancelled'
        ? null
        : null;
    case 'GATEWAY_CONNECT_PARAMETER_INVALID':
    case 'GATEWAY_INBOUND_PROTOCOL_INVALID':
    case 'GATEWAY_OUTBOUND_PROTOCOL_INVALID':
    case 'GATEWAY_NOT_CONNECTED':
    case 'GATEWAY_NOT_READY':
      return null;
  }
}
