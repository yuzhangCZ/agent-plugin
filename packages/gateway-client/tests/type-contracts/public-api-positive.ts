import {
  type GatewayClientAvailability,
  type GatewayBusinessMessage,
  type GatewayClientErrorShape,
<<<<<<< HEAD
  type GatewayInboundFrame,
  type GatewaySendPayload,
  mapGatewayClientAvailability,
=======
  type GatewayClientFailureSignal,
  type GatewayInboundFrame,
  type GatewaySendPayload,
  gatewayClientFailureTranslator,
>>>>>>> ec1bccb (refactor: stabilize gateway client failure facts)
} from '../../src/index.ts';

const inbound: GatewayInboundFrame = { kind: 'parse_error', rawPreview: '{"bad":' };
const outbound: GatewaySendPayload = { type: 'status_response', opencodeOnline: true };
const business: GatewayBusinessMessage = { type: 'status_query' };
const error: GatewayClientErrorShape = {
<<<<<<< HEAD
  code: 'GATEWAY_HANDSHAKE_REJECTED',
  disposition: 'startup_failure',
  stage: 'handshake',
  retryable: false,
  message: 'gateway_register_rejected',
};
const availability: GatewayClientAvailability = mapGatewayClientAvailability(error);
=======
  code: 'GATEWAY_REGISTER_REJECTED',
  source: 'handshake',
  phase: 'before_ready',
  retryable: false,
  message: 'gateway_register_rejected',
};
const signal: GatewayClientFailureSignal = gatewayClientFailureTranslator.translate(error);
>>>>>>> ec1bccb (refactor: stabilize gateway client failure facts)

void inbound;
void outbound;
void business;
<<<<<<< HEAD
void availability;
=======
void signal;
>>>>>>> ec1bccb (refactor: stabilize gateway client failure facts)
