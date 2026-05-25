import type { ProviderCommandHandlers } from '../../adapters/provider/provider-api-adapter.ts';
import type { RuntimeCommand } from '../../domain/runtime-command.ts';
import type { GatewayCommandResultProjector } from '../projectors/index.ts';
import type { OutboundSink } from '../ports/outbound-sink.ts';
import type { QueryStatusUseCase as QueryStatusUseCasePort } from '../ports/runtime-usecase.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';

export class QueryStatusUseCase implements QueryStatusUseCasePort {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sink: OutboundSink;
  private readonly projector: GatewayCommandResultProjector;
  private readonly observation: RuntimeObservation;

  constructor(
    handlers: ProviderCommandHandlers,
    sink: OutboundSink,
    projector: GatewayCommandResultProjector,
    observation: RuntimeObservation,
  ) {
    this.handlers = handlers;
    this.sink = sink;
    this.projector = projector;
    this.observation = observation;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'query_status' }>): Promise<void> {
    this.observation.usecaseStarted('query_status', command.traceId);
    try {
      const result = await this.handlers.queryStatus({ traceId: command.traceId });
      const uplink = this.projector.projectStatus({ online: result.online });
      this.observation.uplinkEmitted(uplink);
      await this.sink.send(uplink);
      this.observation.usecaseSucceeded('query_status', command.traceId);
    } catch (error) {
      this.observation.usecaseFailed('query_status', command.traceId, error);
      throw error;
    }
  }
}
