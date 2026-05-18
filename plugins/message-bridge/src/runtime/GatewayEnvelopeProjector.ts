import type { GatewayEnvelopeProjector } from '../port/SlashCommandControlPlanePort.js';
import { SyntheticAssistantReplySequenceBuilder } from './SyntheticAssistantReplySequenceBuilder.js';

/** slash completion 侧 envelope projector：复用统一 synthetic assistant reply shape。 */
export class MemoryGatewayEnvelopeProjector implements GatewayEnvelopeProjector {
  private readonly sequenceBuilder = new SyntheticAssistantReplySequenceBuilder();

  projectSyntheticAssistantReply(input: { anchor: string; text: string }): Record<string, unknown>[] {
    const sequence = this.sequenceBuilder.build({
      toolSessionId: input.anchor,
      text: input.text,
    });
    return [
      sequence.messageUpdated,
      sequence.stepStart,
      sequence.text,
      sequence.stepFinish,
    ];
  }

  projectToolDone(input: { anchor: string }): Record<string, unknown> {
    return {
      type: 'tool_done',
      toolSessionId: input.anchor,
    };
  }
}
