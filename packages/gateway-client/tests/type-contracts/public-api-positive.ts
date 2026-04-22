import {
  type GatewayBusinessMessage,
  type GatewayClientErrorShape,
  type GatewayClientFailureSignal,
  type GatewayInboundFrame,
  type GatewaySendPayload,
  gatewayClientFailureTranslator,
} from '../../src/index.ts';

const inbound: GatewayInboundFrame = { kind: 'parse_error', rawPreview: '{"bad":' };
const outbound: GatewaySendPayload = { type: 'status_response', opencodeOnline: true };
const business: GatewayBusinessMessage = { type: 'status_query' };
const error: GatewayClientErrorShape = {
  code: 'GATEWAY_REGISTER_REJECTED',
  source: 'handshake',
  phase: 'before_ready',
  retryable: false,
  message: 'gateway_register_rejected',
};
const signal: GatewayClientFailureSignal = gatewayClientFailureTranslator.translate(error);

void inbound;
void outbound;
void business;
void signal;
