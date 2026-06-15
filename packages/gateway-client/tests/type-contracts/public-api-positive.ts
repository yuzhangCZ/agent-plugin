import {
  type GatewayClientAvailability,
  type GatewayBusinessMessage,
  type GatewayClientErrorShape,
  type GatewayClientUnknownError,
  type GatewayInboundFrame,
  type GatewaySendPayload,
  mapGatewayClientAvailability,
} from '../../src/index.ts';

const inbound: GatewayInboundFrame = { kind: 'parse_error', rawPreview: '{"bad":' };
const outbound: GatewaySendPayload = { type: 'status_response', opencodeOnline: true };
const business: GatewayBusinessMessage = { type: 'status_query' };
const error: GatewayClientErrorShape = {
  code: 'GATEWAY_HANDSHAKE_REJECTED',
  disposition: 'startup_failure',
  retryable: false,
  message: 'gateway_register_rejected',
};
const availability: GatewayClientAvailability = mapGatewayClientAvailability(error);
const unknownError: GatewayClientErrorShape = {
  code: 'GATEWAY_UNKNOWN_ERROR',
  disposition: 'diagnostic',
  retryable: false,
  message: 'gateway client send failed: unknown error',
};
declare const unknownErrorClass: GatewayClientUnknownError;

void inbound;
void outbound;
void business;
void availability;
void unknownError;
void unknownErrorClass;
