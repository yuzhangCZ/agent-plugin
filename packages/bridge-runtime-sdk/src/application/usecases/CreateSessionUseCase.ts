import type { ProviderCommandHandlers } from '../../adapters/provider/provider-api-adapter.ts';
import type { RuntimeCommand } from '../../domain/runtime-command.ts';
import type { GatewayCommandResultProjector } from '../projectors/index.ts';
import type { OutboundSink } from '../ports/outbound-sink.ts';
import type { CreateSessionUseCase as CreateSessionUseCasePort } from '../ports/runtime-usecase.ts';
import type { SessionRuntimeRegistry } from '../ports/session-runtime-registry.ts';
import type { RuntimeObservation } from '../runtime-observation/index.ts';

export class CreateSessionUseCase implements CreateSessionUseCasePort {
  private readonly handlers: ProviderCommandHandlers;
  private readonly sessionRegistry: SessionRuntimeRegistry;
  private readonly sink: OutboundSink;
  private readonly projector: GatewayCommandResultProjector;
  private readonly observation: RuntimeObservation;

  constructor(
    handlers: ProviderCommandHandlers,
    sessionRegistry: SessionRuntimeRegistry,
    sink: OutboundSink,
    projector: GatewayCommandResultProjector,
    observation: RuntimeObservation,
  ) {
    this.handlers = handlers;
    this.sessionRegistry = sessionRegistry;
    this.sink = sink;
    this.projector = projector;
    this.observation = observation;
  }

  async execute(command: Extract<RuntimeCommand, { kind: 'create_session' }>): Promise<void> {
    const context = {
      welinkSessionId: command.source.welinkSessionId,
    };
    this.observation.usecaseStarted('create_session', command.traceId, context);
    try {
      const result = await this.handlers.createSession({
        traceId: command.traceId,
        title: command.source.payload.title,
        assistantId: command.source.payload.assistantId,
        ...(command.source.payload.extParameters !== undefined
          ? { extParameters: command.source.payload.extParameters }
          : {}),
      });
      this.sessionRegistry.ensure({
        toolSessionId: result.toolSessionId,
        welinkSessionId: command.source.welinkSessionId,
      });
      const uplink = this.projector.projectSessionCreated({
        welinkSessionId: command.source.welinkSessionId,
        toolSessionId: result.toolSessionId,
      });
      this.observation.uplinkEmitted(uplink);
      await this.sink.send(uplink);
      this.observation.usecaseSucceeded('create_session', command.traceId, {
        ...context,
        toolSessionId: result.toolSessionId,
      });
    } catch (error) {
      this.observation.usecaseFailed('create_session', command.traceId, error, undefined, context);
      throw error;
    }
  }
}
