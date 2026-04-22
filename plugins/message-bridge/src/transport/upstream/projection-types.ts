import type { GatewayToolEventPayload } from '../../gateway-wire/tool-event.js';
import type { NormalizedUpstreamEvent } from '../../protocol/upstream/UpstreamEventTypes.js';

export type GatewayProjectedEvent = GatewayToolEventPayload;

export interface UpstreamTransportProjector {
  project(normalized: NormalizedUpstreamEvent): GatewayProjectedEvent;
}
