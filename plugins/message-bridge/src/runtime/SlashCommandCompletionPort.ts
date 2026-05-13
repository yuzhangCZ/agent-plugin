import type {
  GatewayEnvelopeProjector,
  SlashCommandCompletionPort,
} from '../port/SlashCommandControlPlanePort.js';

/** runtime 侧 slash 完成态发送实现。 */
export class RuntimeSlashCommandCompletionPort implements SlashCommandCompletionPort {
  constructor(private readonly dependencies: {
    projector: GatewayEnvelopeProjector;
    sender: (message: Record<string, unknown>) => Promise<void>;
  }) {}

  async completeSuccess(input: { anchor: string; text: string }): Promise<void> {
    await this.dependencies.sender(this.dependencies.projector.projectToolEvent(input));
    await this.dependencies.sender(this.dependencies.projector.projectToolDone({ anchor: input.anchor }));
  }

  async completeFailure(input: { anchor: string; text: string }): Promise<void> {
    await this.dependencies.sender(this.dependencies.projector.projectToolError(input));
  }
}
