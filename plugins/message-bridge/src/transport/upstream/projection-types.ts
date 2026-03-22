import type { BridgeEvent } from '../../runtime/types.js';
import type { NormalizedUpstreamEvent } from '../../protocol/upstream/UpstreamEventTypes.js';

export type GatewayProjectedEvent = BridgeEvent;

export interface UpstreamTransportProjector {
  project(normalized: NormalizedUpstreamEvent): GatewayProjectedEvent;
}
