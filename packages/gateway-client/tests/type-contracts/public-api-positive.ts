import {
  type GatewayBusinessMessage,
  type GatewayInboundFrame,
  type GatewaySendPayload,
} from '../../src/index.ts';

const inbound: GatewayInboundFrame = { kind: 'parse_error', rawPreview: '{"bad":' };
const outbound: GatewaySendPayload = { type: 'status_response', opencodeOnline: true };
const business: GatewayBusinessMessage = { type: 'status_query' };

void inbound;
void outbound;
void business;
