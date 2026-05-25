import type { SkillProviderEvent, ToolEventMessage } from '@agent-plugin/gateway-schema';

import { GATEWAY_UPLINK_MESSAGE_TYPE } from '../constants/gateway-messages.ts';
import type { SkillEventToGatewayMessageProjector, ToolEventEnvelopeFields } from './projector.types.ts';

/**
 * 默认 skill event -> gateway tool_event projector。
 */
export class DefaultSkillEventToGatewayMessageProjector implements SkillEventToGatewayMessageProjector {
  project(toolSessionId: string, event: SkillProviderEvent, envelope?: ToolEventEnvelopeFields): ToolEventMessage {
    return {
      type: GATEWAY_UPLINK_MESSAGE_TYPE.toolEvent,
      toolSessionId,
      ...(envelope?.subagentSessionId ? { subagentSessionId: envelope.subagentSessionId } : {}),
      ...(envelope?.subagentName ? { subagentName: envelope.subagentName } : {}),
      event,
    };
  }
}
