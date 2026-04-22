import type { NormalizedUpstreamEvent } from '../../protocol/upstream/UpstreamEventTypes.js';
import type { GatewayProjectedEvent, UpstreamTransportProjector } from './projection-types.js';
import { projectMessageUpdatedEvent } from './MessageUpdatedProjector.js';
import { TOOL_EVENT_TYPE } from '../../gateway-wire/tool-event.js';

export class DefaultUpstreamTransportProjector implements UpstreamTransportProjector {
  project(normalized: NormalizedUpstreamEvent): GatewayProjectedEvent {
    if (normalized.common.eventType === TOOL_EVENT_TYPE.MESSAGE_UPDATED) {
      return projectMessageUpdatedEvent(normalized.raw) as GatewayProjectedEvent;
    }

    return normalized.raw as GatewayProjectedEvent;
  }
}
