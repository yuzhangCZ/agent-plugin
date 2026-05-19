import type {
  SlashCommandFailureDeliveryFailureStage,
  SlashCommandFailureDeliveryResult,
  GatewayEnvelopeProjector,
  SlashCommandCompletionPort,
  SlashCommandSuccessDeliveryFailureStage,
  SlashCommandSuccessDeliveryResult,
} from '../port/SlashCommandControlPlanePort.js';

/** runtime 侧 slash 完成态发送实现。 */
export class RuntimeSlashCommandCompletionPort implements SlashCommandCompletionPort {
  constructor(private readonly dependencies: {
    projector: GatewayEnvelopeProjector;
    sender: (message: Record<string, unknown>) => Promise<boolean | void>;
  }) {}

  async completeSuccess(input: { anchor: string; welinkSessionId?: string; text: string }): Promise<SlashCommandSuccessDeliveryResult> {
    return this.deliver(input);
  }

  async completeFailure(input: { anchor: string; welinkSessionId?: string; text: string }): Promise<SlashCommandFailureDeliveryResult> {
    return this.deliver(input);
  }

  /**
   * 统一 slash 完成态发送时序。
   * @remarks success / failure 都必须发送同一组 synthetic assistant reply，并以 tool_done 收尾。
   */
  private async deliver(input: {
    anchor: string;
    welinkSessionId?: string;
    text: string;
  }): Promise<SlashCommandSuccessDeliveryResult | SlashCommandFailureDeliveryResult> {
    const messages = this.dependencies.projector.projectSyntheticAssistantReply(input);
    const stages: Array<SlashCommandSuccessDeliveryFailureStage | SlashCommandFailureDeliveryFailureStage> = [
      'message.updated',
      'message.part.updated.step-start',
      'message.part.updated.text-seed',
      'message.part.delta.text',
      'message.part.updated.text-final',
      'message.part.updated.step-finish',
    ];
    for (const [index, message] of messages.entries()) {
      const sent = await this.trySend(message);
      if (sent === false) {
        return { success: false, failureStage: stages[index] ?? 'message.part.updated.text-final' };
      }
    }
    const toolDoneSent = await this.trySend(this.dependencies.projector.projectToolDone({
      anchor: input.anchor,
      welinkSessionId: input.welinkSessionId,
    }));
    if (toolDoneSent === false) {
      return { success: false, failureStage: 'tool_done' };
    }
    return { success: true };
  }

  private async trySend(message: Record<string, unknown>): Promise<boolean> {
    try {
      return (await this.dependencies.sender(message)) !== false;
    } catch {
      return false;
    }
  }
}
