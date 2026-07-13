import { setTimeout as sleep } from 'node:timers/promises';

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
  ListSlashCommandsUseCase,
  QueryStatusUseCase,
  ReplyPermissionUseCase,
  ReplyQuestionUseCase,
  StartRequestRunUseCase,
} from '../usecases/index.ts';
import type { BridgeRuntimeOptions } from '../create-runtime.ts';
import type { GatewayOutboundSinkAdapter } from '../../adapters/gateway/GatewayOutboundSinkAdapter.ts';
import type { BridgeRuntimeInternalOptions } from './runtime-options.types.ts';
import { DEFAULT_TOOL_DONE_COMPAT_DELAY_MS } from '../constants/runtime.ts';
import { resolveRequestRunPolicy } from '../request-run-policy.ts';

// eslint-disable-next-line max-lines-per-function -- composition root 需要集中表达 runtime 依赖装配关系。
export function createApplicationRuntimeSide(
  options: BridgeRuntimeOptions,
  internalOptions: BridgeRuntimeInternalOptions,
  observation: DefaultRuntimeObservation,
  sink: GatewayOutboundSinkAdapter,
): {
  core: RuntimeCoreService;
  commandFailureToolErrorProjector: CommandFailureToolErrorProjector;
} {
  const sessionRegistry = new InMemorySessionRuntimeRegistry();
  const pendingInteractionRegistry = new InMemoryPendingInteractionRegistry();
  const permissionPresentationRegistry = new InMemoryPermissionPresentationRegistry();
  const requestRunPolicy = resolveRequestRunPolicy(options.requestRunPolicy);
  const factEnricher = new ProviderFactEnricher(permissionPresentationRegistry);
  const factProjector = new DefaultFactToSkillEventProjector();
  const eventProjector = new DefaultSkillEventToGatewayMessageProjector();
  const commandResultProjector = new DefaultGatewayCommandResultProjector();
  const terminalProjector = new DefaultRunTerminalSignalProjector();
  const toolDoneCompatDelay = {
    sleep: internalOptions.toolDoneCompatDelay?.sleep ?? sleep,
    delayMs: internalOptions.toolDoneCompatDelay?.delayMs ?? DEFAULT_TOOL_DONE_COMPAT_DELAY_MS,
  };
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
    interactionCoordinator,
    validator,
    {
      sink,
      factProjector,
      eventProjector,
      observation,
      toolDoneCompatDelay,
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
      toolDoneCompatDelay,
    },
    factEnricher,
    terminalProjector,
  );
  const dispatcher = new RuntimeCommandDispatcher({
    query_status: new QueryStatusUseCase(providerHandlers, sink, commandResultProjector, observation),
    list_slash_commands: new ListSlashCommandsUseCase(providerHandlers, sink, commandResultProjector, observation),
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
      requestRunPolicy,
    ),
    reply_question: new ReplyQuestionUseCase(providerHandlers, interactionCoordinator, observation),
    reply_permission: new ReplyPermissionUseCase(providerHandlers, interactionCoordinator, observation),
    close_session: new CloseSessionUseCase(
      providerHandlers,
      sessionRegistry,
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
