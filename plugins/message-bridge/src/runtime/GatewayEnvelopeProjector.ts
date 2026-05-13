import { randomUUID } from 'crypto';
import type { GatewayEnvelopeProjector } from '../port/SlashCommandControlPlanePort.js';

/** 临时态 envelope projector：外层继续投影为 `toolSessionId`。 */
export class MemoryGatewayEnvelopeProjector implements GatewayEnvelopeProjector {
  projectToolEvent(input: { anchor: string; text: string }): Record<string, unknown> {
    const messageId = `msg_${randomUUID().split('-').join('')}`;
    const partId = `prt_${randomUUID().split('-').join('')}`;
    return {
      type: 'tool_event',
      toolSessionId: input.anchor,
      event: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: partId,
            sessionID: input.anchor,
            messageID: messageId,
            type: 'text',
            text: input.text,
          },
        },
      },
    };
  }

  projectToolDone(input: { anchor: string }): Record<string, unknown> {
    return {
      type: 'tool_done',
      toolSessionId: input.anchor,
    };
  }

  projectToolError(input: { anchor: string; text: string }): Record<string, unknown> {
    return {
      type: 'tool_error',
      toolSessionId: input.anchor,
      error: input.text,
    };
  }
}
