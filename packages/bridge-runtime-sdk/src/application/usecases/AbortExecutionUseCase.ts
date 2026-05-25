import type { ProviderCommandHandlers } from '../../adapters/provider/provider-api-adapter.ts';
import type { RuntimeCommand } from '../../domain/runtime-command.ts';
import type { AbortExecutionUseCase as AbortExecutionUseCasePort } from '../ports/runtime-usecase.ts';
import type { SessionRuntimeRegistry } from '../ports/session-runtime-registry.ts';
import type { ProviderFactEnricher } from '../ProviderFactEnricher.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';

export class AbortExecutionUseCase implements AbortExecutionUseCasePort {
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

  async execute(command: Extract<RuntimeCommand, { kind: 'abort_execution' }>): Promise<void> {
    const record = this.sessionRegistry.get(command.source.payload.toolSessionId);
    const context = {
      toolSessionId: command.source.payload.toolSessionId,
      runId: record?.activeRunId,
    };
    this.observation.usecaseStarted('abort_execution', command.traceId, context);
    try {
      await this.handlers.abortExecution({
        traceId: command.traceId,
        toolSessionId: command.source.payload.toolSessionId,
        runId: record?.activeRunId,
      });
      this.sessionRegistry.markAborting(command.source.payload.toolSessionId);
      this.factEnricher.clearSession(command.source.payload.toolSessionId);
      this.observation.usecaseSucceeded('abort_execution', command.traceId, context);
    } catch (error) {
      this.observation.usecaseFailed('abort_execution', command.traceId, error, undefined, context);
      throw error;
    }
  }
}
