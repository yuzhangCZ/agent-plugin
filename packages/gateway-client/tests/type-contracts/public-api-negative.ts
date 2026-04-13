import type { GatewaySendPayload } from '../../src/index.ts';

const invalidControl: GatewaySendPayload = {
  type: 'heartbeat',
};

void invalidControl;
