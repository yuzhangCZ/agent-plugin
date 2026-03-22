import type { NormalizedUpstreamEvent } from '../../protocol/upstream/UpstreamEventTypes.js';
import type { GatewayProjectedEvent, UpstreamTransportProjector } from './projection-types.js';
import { projectMessageUpdatedEvent } from './MessageUpdatedProjector.js';

export class DefaultUpstreamTransportProjector implements UpstreamTransportProjector {
  project(normalized: NormalizedUpstreamEvent): GatewayProjectedEvent {
    if (normalized.common.eventType === 'message.updated') {
      return projectMessageUpdatedEvent(normalized.raw);
    }

    return normalized.raw;
  }
}
