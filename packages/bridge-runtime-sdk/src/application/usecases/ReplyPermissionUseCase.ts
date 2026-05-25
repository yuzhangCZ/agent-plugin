import type { ProviderCommandHandlers } from '../../adapters/provider/provider-api-adapter.ts';
import type { RuntimeCommand } from '../../domain/runtime-command.ts';
import type { InteractionCoordinator } from '../coordinators/index.ts';
import type { ReplyPermissionUseCase as ReplyPermissionUseCasePort } from '../ports/runtime-usecase.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';

export class ReplyPermissionUseCase implements ReplyPermissionUseCasePort {
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

  async execute(command: Extract<RuntimeCommand, { kind: 'reply_permission' }>): Promise<void> {
    this.observation.usecaseStarted('reply_permission', command.traceId);
    try {
      this.interactionCoordinator.consume('permission', command.source.payload.permissionId);
      await this.handlers.replyPermission({
        traceId: command.traceId,
        permissionId: command.source.payload.permissionId,
        reply: command.source.payload.response,
      });
      this.observation.usecaseSucceeded('reply_permission', command.traceId);
    } catch (error) {
      this.observation.usecaseFailed('reply_permission', command.traceId, error);
      throw error;
    }
  }
}
