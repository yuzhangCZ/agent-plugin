import type { ProviderCommandHandlers } from '../../adapters/provider/provider-api-adapter.ts';
import type { RuntimeCommand } from '../../domain/runtime-command.ts';
import type { CloseSessionUseCase as CloseSessionUseCasePort } from '../ports/runtime-usecase.ts';
import type { SessionRuntimeRegistry } from '../ports/session-runtime-registry.ts';
import type { ProviderFactEnricher } from '../ProviderFactEnricher.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';

export class CloseSessionUseCase implements CloseSessionUseCasePort {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sessionRegistry: SessionRuntimeRegistry;
  private readonly factEnricher: ProviderFactEnricher;
  private readonly observation: RuntimeObservation;

  constructor(
    handlers: ProviderCommandHandlers,
    sessionRegistry: SessionRuntimeRegistry,
    factEnricher: ProviderFactEnricher,
    observation: RuntimeObservation,
  ) {
    this.handlers = handlers;
    this.sessionRegistry = sessionRegistry;
    this.factEnricher = factEnricher;
    this.observation = observation;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'close_session' }>): Promise<void> {
    const context = { toolSessionId: command.source.payload.toolSessionId };
    this.observation.usecaseStarted('close_session', command.traceId, context);
    try {
      await this.handlers.closeSession({
        traceId: command.traceId,
        toolSessionId: command.source.payload.toolSessionId,
        extParameters: command.source.payload.extParameters,
      });
      this.factEnricher.clearSession(command.source.payload.toolSessionId);
      this.sessionRegistry.delete(command.source.payload.toolSessionId);
      this.observation.usecaseSucceeded('close_session', command.traceId, context);
    } catch (error) {
      this.observation.usecaseFailed('close_session', command.traceId, error, undefined, context);
      throw error;
    }
  }
}
