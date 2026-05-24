import { randomUUID } from 'node:crypto';

import { type GatewayDownstreamBusinessRequest } from '@agent-plugin/gateway-schema';

import { GatewayInboundPolicy } from '../adapters/gateway/GatewayInboundPolicy.ts';
import { toRuntimeCommand } from '../adapters/gateway/GatewayDownstreamCommandAdapter.ts';
import { GatewayOutboundSinkAdapter } from '../adapters/gateway/GatewayOutboundSinkAdapter.ts';
import { GatewayRuntimeDriver } from '../adapters/gateway/GatewayRuntimeDriver.ts';
import { BridgeGatewayLoggerObservationAdapter } from '../adapters/observation/runtime-logger-observation.ts';
import { RuntimeTraceCollectorAdapter } from '../adapters/observation/runtime-trace-observation.ts';
import {
  ObservedProviderCommandHandlers,
  ProviderApiAdapter,
  type ProviderCommandHandlers,
} from '../adapters/provider/provider-api-adapter.ts';
import { RuntimeContractError } from '../domain/errors.ts';
import type { ThirdPartyAgentProvider } from '../domain/provider.ts';
import { InteractionCoordinator, OutboundCoordinator, RequestRunCoordinator } from './coordinators.ts';
import { FactSequenceValidator } from './fact-sequence-validator.ts';
import { RuntimeLifecycleService } from './lifecycle/RuntimeLifecycleService.ts';
import type { InboundPolicy } from './ports/inbound-policy.ts';
import { InMemoryPendingInteractionRegistry } from '../infrastructure/registries/InMemoryPendingInteractionRegistry.ts';
import { InMemorySessionRuntimeRegistry } from '../infrastructure/registries/InMemorySessionRuntimeRegistry.ts';
import {
  DefaultFactToSkillEventProjector,
  DefaultGatewayCommandResultProjector,
  DefaultRunTerminalSignalProjector,
  DefaultSkillEventToGatewayMessageProjector,
} from './projectors.ts';
import { RuntimeCommandDispatcher } from './RuntimeCommandDispatcher.ts';
import {
  CompositeRuntimeObservationPort,
  DefaultRuntimeObservation,
} from './runtime-observation.ts';
import type { BridgeRuntime } from './runtime.ts';
import { RuntimeCoreService } from './runtime/RuntimeCoreService.ts';
import {
  AbortExecutionUseCase,
  CloseSessionUseCase,
  CreateSessionUseCase,
  QueryStatusUseCase,
  ReplyPermissionUseCase,
  ReplyQuestionUseCase,
  StartRequestRunUseCase,
} from './usecases.ts';
import type {
  BridgeGatewayHostConfig,
  BridgeGatewayHostConnection,
  BridgeGatewayLogger,
} from '../infrastructure/gateway/gateway-host.ts';

/**
 * 创建 host runtime 所需的公开配置。
 */
export interface BridgeRuntimeOptions {
  provider: ThirdPartyAgentProvider;
  gatewayHost: BridgeGatewayHostConfig;
  logger?: BridgeGatewayLogger;
  debug?: boolean;
  traceIdFactory?: () => string;
  onTelemetryUpdated?: () => void;
}

/**
 * Runtime SDK 内部测试缝。
 * @remarks connectionFactory 与 onGatewayConnectionCreated 只用于包内测试和装配验证，
 * 不属于 bridge-runtime-sdk 的 public contract；宿主侧只能通过 gatewayHost 与
 * createBridgeRuntime 创建 runtime。
 */
type BridgeRuntimeInternalOptions = BridgeRuntimeOptions & {
  connectionFactory?: (config: BridgeGatewayHostConfig) => BridgeGatewayHostConnection;
  onGatewayConnectionCreated?: (connection: BridgeGatewayHostConnection) => void;
};

interface GatewayRuntimeSide {
  driver: GatewayRuntimeDriver;
  sink: GatewayOutboundSinkAdapter;
  inboundPolicy: GatewayInboundPolicy;
}

interface ApplicationRuntimeSide {
  core: RuntimeCoreService;
}

function classifyRequestFailureKind(error: unknown): 'command_execution_failure' | 'outbound_validation_failure' {
  if (
    error instanceof RuntimeContractError
    && (error.code === 'fact_sequence_invalid' || error.code === 'pending_interaction_conflict')
  ) {
    return 'outbound_validation_failure';
  }
  return 'command_execution_failure';
}

function getDownstreamToolSessionId(message: GatewayDownstreamBusinessRequest): string | undefined {
  if (
    'payload' in message
    && message.payload
    && typeof message.payload === 'object'
    && 'toolSessionId' in message.payload
    && typeof (message.payload as { toolSessionId?: unknown }).toolSessionId === 'string'
  ) {
    return (message.payload as { toolSessionId: string }).toolSessionId;
  }
  return undefined;
}

function createGatewayRuntimeSide(
  options: BridgeRuntimeOptions,
  internalOptions: BridgeRuntimeInternalOptions,
  observation: DefaultRuntimeObservation,
): GatewayRuntimeSide {
  let inboundPolicyImpl: GatewayInboundPolicy | null = null;
  const inboundPolicyProxy: InboundPolicy = {
    handle(frame, input) {
      inboundPolicyImpl?.handle(frame, input);
    },
  };

  const driver = new GatewayRuntimeDriver({
    gatewayHost: options.gatewayHost,
    logger: options.logger,
    debug: options.debug,
    observation,
    inboundPolicy: inboundPolicyProxy,
    onTelemetryUpdated: options.onTelemetryUpdated,
    connectionFactory: internalOptions.connectionFactory,
    onGatewayConnectionCreated: internalOptions.onGatewayConnectionCreated,
  });
  const sink = new GatewayOutboundSinkAdapter(driver, observation);
  inboundPolicyImpl = new GatewayInboundPolicy(observation, sink);

  return {
    driver,
    sink,
    inboundPolicy: inboundPolicyImpl,
  };
}

function createApplicationRuntimeSide(
  options: BridgeRuntimeOptions,
  observation: DefaultRuntimeObservation,
  sink: GatewayOutboundSinkAdapter,
): ApplicationRuntimeSide {
  const sessionRegistry = new InMemorySessionRuntimeRegistry();
  const pendingInteractionRegistry = new InMemoryPendingInteractionRegistry();
  const factProjector = new DefaultFactToSkillEventProjector();
  const eventProjector = new DefaultSkillEventToGatewayMessageProjector();
  const commandResultProjector = new DefaultGatewayCommandResultProjector();
  const terminalProjector = new DefaultRunTerminalSignalProjector();
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
    terminalProjector,
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
      observation,
    ),
    abort_execution: new AbortExecutionUseCase(providerHandlers, sessionRegistry, observation),
  }, observation);

  return {
    core: new RuntimeCoreService({
      provider: options.provider,
      dispatcher,
      outboundEmitter: outboundCoordinator,
      traceIdFactory: options.traceIdFactory,
      observation,
    }),
  };
}

function attachRuntimeDriverHandlers(input: {
  driver: GatewayRuntimeDriver;
  core: RuntimeCoreService;
  lifecycle: RuntimeLifecycleService;
  observation: DefaultRuntimeObservation;
  traceIdFactory?: () => string;
}): void {
  input.driver.attach({
    onGatewayStateChanged: (state) => {
      input.lifecycle.handleGatewayStateChanged(state);
    },
    onBusinessMessage: (message: GatewayDownstreamBusinessRequest) => {
      const summary = {
        messageType: message.type,
        action: 'action' in message ? message.action : undefined,
        toolSessionId: getDownstreamToolSessionId(message),
        welinkSessionId: 'welinkSessionId' in message ? message.welinkSessionId : undefined,
      };
      input.observation.downstreamReceived(summary);
      void (async () => {
        try {
          const traceId = input.traceIdFactory?.() ?? randomUUID();
          const command = toRuntimeCommand(message, traceId);
          const handledCommand = await input.core.handleCommand(command);
          input.observation.downstreamHandled(summary, handledCommand);
        } catch (error) {
          input.observation.downstreamFailed(
            summary,
            error,
            error instanceof RuntimeContractError ? error.code : undefined,
          );
          input.lifecycle.recordFailure(
            error instanceof Error && error.message.startsWith('Unsupported downstream action:')
              ? 'inbound_validation_failure'
              : classifyRequestFailureKind(error),
            'runtime',
            error,
            error instanceof RuntimeContractError ? error.code : undefined,
          );
        }
      })();
    },
    onNonRetryableError: (error) => {
      input.lifecycle.handleGatewayRuntimeError(error);
    },
  });
}

/**
 * 创建默认 bridge runtime。
 * @remarks
 * 该入口只负责 host runtime bootstrap 与 composition root。
 */
export async function createBridgeRuntime(options: BridgeRuntimeOptions): Promise<BridgeRuntime> {
  const internalOptions = options as BridgeRuntimeInternalOptions;
  const traceAdapter = new RuntimeTraceCollectorAdapter();
  const observationPort = new CompositeRuntimeObservationPort([
    traceAdapter,
    new BridgeGatewayLoggerObservationAdapter(options.logger),
  ]);
  const observation = new DefaultRuntimeObservation(observationPort);
  const gatewaySide = createGatewayRuntimeSide(options, internalOptions, observation);
  const applicationSide = createApplicationRuntimeSide(options, observation, gatewaySide.sink);
  const lifecycle = new RuntimeLifecycleService(
    applicationSide.core,
    gatewaySide.driver,
    observation,
    options.onTelemetryUpdated,
  );

  attachRuntimeDriverHandlers({
    driver: gatewaySide.driver,
    core: applicationSide.core,
    lifecycle,
    observation,
    traceIdFactory: options.traceIdFactory,
  });

  return {
    async start(): Promise<void> {
      return lifecycle.start();
    },
    async stop(): Promise<void> {
      return lifecycle.stop();
    },
    getStatus() {
      return lifecycle.getStatus();
    },
    async probe(input = { timeoutMs: 5_000 }) {
      return lifecycle.probe(input);
    },
    getDiagnostics() {
      return traceAdapter.snapshot();
    },
  };
}
