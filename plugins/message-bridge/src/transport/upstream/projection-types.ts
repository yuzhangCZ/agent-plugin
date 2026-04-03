import type { GatewayToolEvent } from '../../gateway-wire/tool-event.js';
import type { NormalizedUpstreamEvent } from '../../protocol/upstream/UpstreamEventTypes.js';

export type GatewayProjectedEvent = GatewayToolEvent;

export interface UpstreamTransportProjector {
  project(normalized: NormalizedUpstreamEvent): GatewayProjectedEvent;
}
