import type { ProviderCommandHandlers } from '../../adapters/provider/provider-api-adapter.ts';
import type { RuntimeCommand } from '../../domain/runtime-command.ts';
import type { InteractionCoordinator } from '../coordinators/index.ts';
import type { ReplyQuestionUseCase as ReplyQuestionUseCasePort } from '../ports/runtime-usecase.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';

export class ReplyQuestionUseCase implements ReplyQuestionUseCasePort {
  private readonly handlers: ProviderCommandHandlers;
  private readonly interactionCoordinator: InteractionCoordinator;
  private readonly observation: RuntimeObservation;

  constructor(
    handlers: ProviderCommandHandlers,
    interactionCoordinator: InteractionCoordinator,
    observation: RuntimeObservation,
  ) {
    this.handlers = handlers;
    this.interactionCoordinator = interactionCoordinator;
    this.observation = observation;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'reply_question' }>): Promise<void> {
    this.observation.usecaseStarted('reply_question', command.traceId);
    try {
      this.interactionCoordinator.consume('question', command.source.payload.questionId);
      await this.handlers.replyQuestion({
        traceId: command.traceId,
        questionId: command.source.payload.questionId,
        answers: command.source.payload.answers,
        ...(command.source.payload.extParameters !== undefined
          ? { extParameters: command.source.payload.extParameters }
          : {}),
      });
      this.observation.usecaseSucceeded('reply_question', command.traceId);
    } catch (error) {
      this.observation.usecaseFailed('reply_question', command.traceId, error);
      throw error;
    }
  }
}
