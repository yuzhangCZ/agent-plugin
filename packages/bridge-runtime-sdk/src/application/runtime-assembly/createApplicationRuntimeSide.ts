import {
  ObservedProviderCommandHandlers,
  ProviderApiAdapter,
  type ProviderCommandHandlers,
} from '../../adapters/provider/provider-api-adapter.ts';
import { InMemoryPendingInteractionRegistry } from '../../infrastructure/registries/InMemoryPendingInteractionRegistry.ts';
import { InMemoryPermissionPresentationRegistry } from '../../infrastructure/registries/InMemoryPermissionPresentationRegistry.ts';
import { InMemorySessionRuntimeRegistry } from '../../infrastructure/registries/InMemorySessionRuntimeRegistry.ts';
import { ProviderFactEnricher } from '../ProviderFactEnricher.ts';
import { InteractionCoordinator, OutboundCoordinator, RequestRunCoordinator } from '../coordinators/index.ts';
import { FactSequenceValidator } from '../fact-sequence-validator.ts';
import {
  CommandFailureToolErrorProjector,
  DefaultFactToSkillEventProjector,
  DefaultGatewayCommandResultProjector,
  RequestRunFailureToolErrorProjector,
  DefaultRunTerminalSignalProjector,
  DefaultSkillEventToGatewayMessageProjector,
  ToolErrorMessageCatalog,
} from '../projectors/index.ts';
import { RuntimeCommandDispatcher } from '../RuntimeCommandDispatcher.ts';
import type { DefaultRuntimeObservation } from '../runtime-observation/index.ts';
import { RuntimeCoreService } from '../runtime/RuntimeCoreService.ts';
import {
  AbortExecutionUseCase,
  CloseSessionUseCase,
  CreateSessionUseCase,
  QueryStatusUseCase,
  ReplyPermissionUseCase,
  ReplyQuestionUseCase,
  StartRequestRunUseCase,
} from '../usecases/index.ts';
import type { BridgeRuntimeOptions } from '../create-runtime.ts';
import type { GatewayOutboundSinkAdapter } from '../../adapters/gateway/GatewayOutboundSinkAdapter.ts';

export function createApplicationRuntimeSide(
  options: BridgeRuntimeOptions,
  observation: DefaultRuntimeObservation,
  sink: GatewayOutboundSinkAdapter,
): {
  core: RuntimeCoreService;
  commandFailureToolErrorProjector: CommandFailureToolErrorProjector;
} {
  const sessionRegistry = new InMemorySessionRuntimeRegistry();
  const pendingInteractionRegistry = new InMemoryPendingInteractionRegistry();
  const permissionPresentationRegistry = new InMemoryPermissionPresentationRegistry();
  const factEnricher = new ProviderFactEnricher(permissionPresentationRegistry);
  const factProjector = new DefaultFactToSkillEventProjector();
  const eventProjector = new DefaultSkillEventToGatewayMessageProjector();
  const commandResultProjector = new DefaultGatewayCommandResultProjector();
  const terminalProjector = new DefaultRunTerminalSignalProjector();
  const toolErrorMessageCatalog = new ToolErrorMessageCatalog();
  const commandFailureToolErrorProjector = new CommandFailureToolErrorProjector(toolErrorMessageCatalog);
  const requestRunFailureToolErrorProjector = new RequestRunFailureToolErrorProjector(toolErrorMessageCatalog);
  const validator = new FactSequenceValidator();
  const baseProviderHandlers = new ProviderApiAdapter(options.provider);
  const providerHandlers: ProviderCommandHandlers = new ObservedProviderCommandHandlers(
    baseProviderHandlers,
    observation,
  );
  const interactionCoordinator = new InteractionCoordinator(pendingInteractionRegistry, observation);
  const requestRunCoordinator = new RequestRunCoordinator(
    sessionRegistry,
    interactionCoordinator,
    validator,
    {
      sink,
      factProjector,
      eventProjector,
      observation,
    },
    factEnricher,
    terminalProjector,
    requestRunFailureToolErrorProjector,
  );
  const outboundCoordinator = new OutboundCoordinator(
    sessionRegistry,
    interactionCoordinator,
    validator,
    {
      sink,
      factProjector,
      eventProjector,
      observation,
    },
    factEnricher,
  );
  const dispatcher = new RuntimeCommandDispatcher({
    query_status: new QueryStatusUseCase(providerHandlers, sink, commandResultProjector, observation),
    create_session: new CreateSessionUseCase(
      providerHandlers,
      sessionRegistry,
      sink,
      commandResultProjector,
      observation,
    ),
    start_request_run: new StartRequestRunUseCase(
      providerHandlers,
      sessionRegistry,
      requestRunCoordinator,
      observation,
    ),
    reply_question: new ReplyQuestionUseCase(providerHandlers, interactionCoordinator, observation),
    reply_permission: new ReplyPermissionUseCase(providerHandlers, interactionCoordinator, observation),
    close_session: new CloseSessionUseCase(
      providerHandlers,
      sessionRegistry,
      interactionCoordinator,
      factEnricher,
      observation,
    ),
    abort_execution: new AbortExecutionUseCase(providerHandlers, sessionRegistry, factEnricher, observation),
  }, observation);

  return {
    core: new RuntimeCoreService({
      provider: options.provider,
      dispatcher,
      outboundEmitter: outboundCoordinator,
      traceIdFactory: options.traceIdFactory,
      observation,
    }),
    commandFailureToolErrorProjector,
  };
}
