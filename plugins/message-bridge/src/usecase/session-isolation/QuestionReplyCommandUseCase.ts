import type { QuestionReplyCommandPort } from '../../port/session-isolation/inbound/index.js';
import type {
  InteractionLookupBridge,
  SdkExecutionBridge,
} from '../../port/session-isolation/outbound/index.js';
import type { QuestionReplyCommandInput } from '../../port/session-isolation/dto/commands/index.js';
import type { QuestionReplyCommandResult } from '../../port/session-isolation/dto/results/index.js';

/**
 * question reply 的应用层入口：先确认 pending interaction 仍属于已绑定 anchor，再交给 SDK 执行。
 */
export class DefaultQuestionReplyCommandUseCase implements QuestionReplyCommandPort {
  constructor(private readonly dependencies: {
    interactionLookupBridge: InteractionLookupBridge;
    sdkExecutionBridge: SdkExecutionBridge;
  }) {}

  async execute(input: QuestionReplyCommandInput): Promise<QuestionReplyCommandResult> {
    const lookup = await this.dependencies.interactionLookupBridge.findQuestion(input.questionId);
    if (lookup.kind !== 'found') {
      throw new Error(`question interaction not found: ${input.questionId}`);
    }

    return this.dependencies.sdkExecutionBridge.replyQuestion(input);
  }
}
