import { validateToolEvent, validateGatewayWireProtocolMessage } from '../src/index.ts';

export const validateToolEventSpec = validateToolEvent;
export const validateUpstreamTransportSpec = validateGatewayWireProtocolMessage;
