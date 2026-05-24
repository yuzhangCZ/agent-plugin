import { randomUUID } from 'node:crypto';

import { type GatewayInboundFrame } from '@agent-plugin/gateway-client';
import {
  type GatewayDownstreamBusinessRequest,
  type ToolErrorMessage,
  validateGatewayUplinkBusinessMessage,
} from '@agent-plugin/gateway-schema';

import { RuntimeContractError } from '../domain/errors.ts';
import type { ThirdPartyAgentProvider } from '../domain/provider.ts';
import { toRuntimeCommand } from '../adapters/GatewayDownstreamCommandAdapter.ts';
import type { PendingInteractionRegistry } from './ports/pending-interaction-registry.ts';
import type { SessionRuntimeRegistry } from './ports/session-runtime-registry.ts';
import {
  DefaultFactToSkillEventProjector,
  DefaultGatewayCommandResultProjector,
  DefaultRunTerminalSignalProjector,
  DefaultSkillEventToGatewayMessageProjector,
  type FactToSkillEventProjector,
  type GatewayCommandResultProjector,
  type GatewayOutboundSink,
  type RunTerminalSignalProjector,
  type SkillEventToGatewayMessageProjector,
} from './projectors.ts';
import { RuntimeCommandDispatcher } from './RuntimeCommandDispatcher.ts';
import {
  InMemoryPendingInteractionRegistry,
  InMemorySessionRuntimeRegistry,
} from '../infrastructure/InMemoryRegistries.ts';
import { FactSequenceValidator } from './fact-sequence-validator.ts';
import { InteractionCoordinator, OutboundCoordinator, RequestRunCoordinator } from './coordinators.ts';
import {
  ObservedProviderCommandHandlers,
  ProviderApiAdapter,
  type ProviderCommandHandlers,
} from './provider-api-adapter.ts';
import {
  createDefaultBridgeGatewayHostConnection,
  normalizeBridgeGatewayHostConfig,
  probeBridgeGatewayHost,
  type BridgeGatewayHostConfig,
  type BridgeGatewayHostConnection,
  type BridgeGatewayHostError,
  type BridgeGatewayHostState,
  type BridgeGatewayLogger,
  type BridgeGatewayProbeResult,
} from './gateway-host.ts';
import {
  AbortExecutionUseCase,
  CloseSessionUseCase,
  CreateSessionUseCase,
  QueryStatusUseCase,
  ReplyPermissionUseCase,
  ReplyQuestionUseCase,
  StartRequestRunUseCase,
} from './usecases.ts';
import {
  BridgeGatewayLoggerObservationAdapter,
} from './runtime-logger-observation.ts';
import {
  CompositeRuntimeObservationPort,
  DefaultRuntimeObservation,
  type RuntimeObservation,
  type RuntimeObservationCommand,
} from './runtime-observation.ts';
import { RuntimeTraceCollectorAdapter } from './runtime-trace-observation.ts';
import type { BridgeRuntime, BridgeRuntimeStatusSnapshot } from './runtime.ts';

interface BridgeRuntimeCoreOptions {
  provider: ThirdPartyAgentProvider;
  sink: GatewayOutboundSink;
  traceIdFactory?: () => string;
  observation: RuntimeObservation;
  sessionRegistry?: SessionRuntimeRegistry;
  pendingInteractionRegistry?: PendingInteractionRegistry;
  factProjector?: FactToSkillEventProjector;
  eventProjector?: SkillEventToGatewayMessageProjector;
  commandResultProjector?: GatewayCommandResultProjector;
  terminalProjector?: RunTerminalSignalProjector;
}

interface InternalBridgeRuntimeCore {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleDownstream(message: GatewayDownstreamBusinessRequest): Promise<RuntimeObservationCommand>;
}

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

function normalizeErrorMessage(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return error instanceof Error ? error.message : String(error);
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

function isGatewayReady(state: BridgeGatewayHostState): boolean {
  return state === 'READY';
}

function isGatewayRecovering(state: BridgeGatewayHostState): boolean {
  return state === 'CONNECTING' || state === 'CONNECTED' || state === 'DISCONNECTED';
}

function isRuntimeReady(state: BridgeRuntimeStatusSnapshot['state']): state is 'ready' {
  return state === 'ready';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildInvalidInvokeToolError(code: string): string {
  return `gateway_invalid_invoke:${code}`;
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

type InvalidInvokeGatewayInboundFrame = Extract<GatewayInboundFrame, { kind: 'invalid' }> & {
  messageType: 'invoke';
};

function shouldReplyToInvalidInvoke(frame: GatewayInboundFrame): frame is InvalidInvokeGatewayInboundFrame {
  return frame.kind === 'invalid' && frame.messageType === 'invoke';
}

function handleInvalidInvokeInboundFrame(
  frame: InvalidInvokeGatewayInboundFrame,
  client: BridgeGatewayHostConnection,
  observation: RuntimeObservation,
  sink: GatewayOutboundSink,
): void {
  observation.failureRecorded(
    'inbound_validation_failure',
    'runtime',
    frame.violation.violation.message,
    frame.violation.violation.code,
  );

  if (!frame.welinkSessionId && !frame.toolSessionId) {
    return;
  }

  const gatewayStatus = client.getStatus?.();
  if (typeof gatewayStatus?.isReady === 'function' && !gatewayStatus.isReady()) {
    return;
  }

  observation.invalidInvokeRejected({
    toolSessionId: frame.toolSessionId,
    welinkSessionId: frame.welinkSessionId,
  }, frame.violation.violation.message, frame.violation.violation.code);

  const toolError: ToolErrorMessage = {
    type: 'tool_error',
    ...(frame.welinkSessionId ? { welinkSessionId: frame.welinkSessionId } : {}),
    ...(frame.toolSessionId ? { toolSessionId: frame.toolSessionId } : {}),
    error: buildInvalidInvokeToolError(frame.violation.violation.code),
  };
  observation.uplinkEmitted(toolError);
  sink.send(toolError);
}

function createBridgeRuntimeCore(options: BridgeRuntimeCoreOptions): InternalBridgeRuntimeCore {
  const sessionRegistry = options.sessionRegistry ?? new InMemorySessionRuntimeRegistry();
  const pendingInteractionRegistry =
    options.pendingInteractionRegistry ?? new InMemoryPendingInteractionRegistry();
  const factProjector = options.factProjector ?? new DefaultFactToSkillEventProjector();
  const eventProjector = options.eventProjector ?? new DefaultSkillEventToGatewayMessageProjector();
  const commandResultProjector = options.commandResultProjector ?? new DefaultGatewayCommandResultProjector();
  const terminalProjector = options.terminalProjector ?? new DefaultRunTerminalSignalProjector();
  const validator = new FactSequenceValidator();
  const baseProviderHandlers = new ProviderApiAdapter(options.provider);
  const providerHandlers: ProviderCommandHandlers = new ObservedProviderCommandHandlers(
    baseProviderHandlers,
    options.observation,
  );
  const interactionCoordinator = new InteractionCoordinator(pendingInteractionRegistry, options.observation);
  const requestRunCoordinator = new RequestRunCoordinator(
    sessionRegistry,
    interactionCoordinator,
    validator,
    {
      sink: options.sink,
      factProjector,
      eventProjector,
      observation: options.observation,
    },
    terminalProjector,
  );
  const outboundCoordinator = new OutboundCoordinator(
    sessionRegistry,
    interactionCoordinator,
    validator,
    {
      sink: options.sink,
      factProjector,
      eventProjector,
      observation: options.observation,
    },
  );

  const dispatcher = new RuntimeCommandDispatcher({
    query_status: new QueryStatusUseCase(providerHandlers, options.sink, commandResultProjector, options.observation),
    create_session: new CreateSessionUseCase(
      providerHandlers,
      sessionRegistry,
      options.sink,
      commandResultProjector,
      options.observation,
    ),
    start_request_run: new StartRequestRunUseCase(
      providerHandlers,
      sessionRegistry,
      requestRunCoordinator,
      options.observation,
    ),
    reply_question: new ReplyQuestionUseCase(providerHandlers, interactionCoordinator, options.observation),
    reply_permission: new ReplyPermissionUseCase(providerHandlers, interactionCoordinator, options.observation),
    close_session: new CloseSessionUseCase(
      providerHandlers,
      sessionRegistry,
      interactionCoordinator,
      options.observation,
    ),
    abort_execution: new AbortExecutionUseCase(providerHandlers, sessionRegistry, options.observation),
  }, options.observation);

  let initialized = false;

  return {
    async start(): Promise<void> {
      if (initialized) {
        return;
      }
      await options.provider.initialize?.({
        outbound: {
          emitOutboundMessage: async (input) => {
            return outboundCoordinator.emitOutbound({
              toolSessionId: input.toolSessionId,
              messageId: input.messageId,
              facts: input.facts,
            });
          },
        },
      });
      initialized = true;
      options.observation.runtimeCoreStarted();
    },
    async stop(): Promise<void> {
      if (!initialized) {
        return;
      }
      await options.provider.dispose?.();
      initialized = false;
      options.observation.runtimeCoreStopped();
    },
    async handleDownstream(message: GatewayDownstreamBusinessRequest): Promise<RuntimeObservationCommand> {
      const traceId = options.traceIdFactory?.() ?? randomUUID();
      const command = toRuntimeCommand(message, traceId);
      await dispatcher.dispatch(command);
      return command.kind;
    },
  };
}

function attachGatewayClientObservers(
  client: BridgeGatewayHostConnection,
  observation: RuntimeObservation,
  sink: GatewayOutboundSink,
  onGatewayStateChange: (state: BridgeGatewayHostState) => void,
  onBusinessMessage: (message: GatewayDownstreamBusinessRequest) => void,
  onNonRetryableError: (error: BridgeGatewayHostError) => void,
  onTelemetryUpdated?: () => void,
): () => void {
  const stateChange = (state: BridgeGatewayHostState) => {
    observation.gatewayStateChanged(state, Date.now());
    onGatewayStateChange(state);
    onTelemetryUpdated?.();
  };
  const inbound = (frame: GatewayInboundFrame) => {
    observation.gatewayInboundActivity(Date.now());
    if (shouldReplyToInvalidInvoke(frame)) {
      handleInvalidInvokeInboundFrame(frame, client, observation, sink);
    }
    onTelemetryUpdated?.();
  };
  const outbound = () => {
    observation.gatewayOutboundActivity(Date.now());
    onTelemetryUpdated?.();
  };
  const heartbeat = () => {
    observation.gatewayHeartbeatActivity(Date.now());
    onTelemetryUpdated?.();
  };
  const message = (payload: GatewayDownstreamBusinessRequest) => {
    onBusinessMessage(payload);
    onTelemetryUpdated?.();
  };
  const error = (gatewayError: BridgeGatewayHostError) => {
    if (!gatewayError.retryable) {
      onNonRetryableError(gatewayError);
    }
    onTelemetryUpdated?.();
  };

  client.on('stateChange', stateChange);
  client.on('inbound', inbound as (frame: unknown) => void);
  client.on('outbound', outbound);
  client.on('heartbeat', heartbeat);
  client.on('message', message as (message: unknown) => void);
  client.on('error', error);

  return () => {
    const eventEmitter = client as BridgeGatewayHostConnection & {
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    const remove = eventEmitter.off?.bind(eventEmitter) ?? eventEmitter.removeListener?.bind(eventEmitter);
    if (!remove) {
      return;
    }
    remove('stateChange', stateChange as (...args: unknown[]) => void);
    remove('inbound', inbound as (...args: unknown[]) => void);
    remove('outbound', outbound as (...args: unknown[]) => void);
    remove('heartbeat', heartbeat as (...args: unknown[]) => void);
    remove('message', message as (...args: unknown[]) => void);
    remove('error', error as (...args: unknown[]) => void);
  };
}

/**
 * 创建默认 bridge runtime。
 * @remarks
 * 该入口只负责 host runtime bootstrap；runtime core 仍作为内部实现细节存在。
 */
export async function createBridgeRuntime(options: BridgeRuntimeOptions): Promise<BridgeRuntime> {
  const internalOptions = options as BridgeRuntimeInternalOptions;
  const traceAdapter = new RuntimeTraceCollectorAdapter();
  const observationPort = new CompositeRuntimeObservationPort([
    traceAdapter,
    new BridgeGatewayLoggerObservationAdapter(options.logger),
  ]);
  const observation = new DefaultRuntimeObservation(observationPort);
  const gatewayHost = normalizeBridgeGatewayHostConfig(options.gatewayHost, {
    logger: options.logger,
    debug: options.debug,
  });
  let currentClient: BridgeGatewayHostConnection | null = null;
  let detachGatewayObservers: (() => void) | null = null;
  const ensureCurrentClient = (): BridgeGatewayHostConnection => {
    if (!currentClient) {
      throw new Error('gateway_client_not_connected');
    }
    return currentClient;
  };
  const sink: GatewayOutboundSink = {
    send(message) {
      observation.uplinkSending(message);
      const validation = validateGatewayUplinkBusinessMessage(message);
      if (!validation.ok) {
        observation.uplinkValidationFailed(
          message,
          validation.error.violation.code,
          validation.error.violation.field,
          validation.error.violation.message,
        );
        observation.failureRecorded(
          'outbound_validation_failure',
          'runtime',
          validation.error.violation.message,
          validation.error.violation.code,
        );
        return;
      }
      observation.uplinkValidated(validation.value);
      ensureCurrentClient().send(validation.value);
    },
  };
  const core = createBridgeRuntimeCore({
    provider: options.provider,
    sink,
    traceIdFactory: options.traceIdFactory,
    observation,
  });

  let status: BridgeRuntimeStatusSnapshot = {
    state: 'idle',
    failureReason: null,
  };
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let probePromise: Promise<BridgeGatewayProbeResult> | null = null;
  let probeAbortController: AbortController | null = null;
  const recordFailure = (
    kind:
      | 'startup_failure'
      | 'gateway_runtime_failure'
      | 'command_execution_failure'
      | 'inbound_validation_failure'
      | 'outbound_validation_failure',
    phase: 'start' | 'runtime' | 'stop',
    error: unknown,
    code?: string,
  ): string => {
    const message = normalizeErrorMessage(error);
    observation.failureRecorded(kind, phase, message, code);
    return message;
  };

  const setFailed = (
    kind: 'startup_failure' | 'gateway_runtime_failure',
    phase: 'start' | 'runtime' | 'stop',
    error: unknown,
    code?: string,
  ): void => {
    const message = recordFailure(kind, phase, error, code);
    status = {
      ...status,
      state: 'failed',
      failureReason: message,
    };
  };

  const attachClient = (client: BridgeGatewayHostConnection): void => {
    if (currentClient === client && detachGatewayObservers) {
      return;
    }
    detachGatewayObservers?.();
    currentClient = client;
    internalOptions.onGatewayConnectionCreated?.(client);
    detachGatewayObservers = attachGatewayClientObservers(
      client,
      observation,
      sink,
      (gatewayState) => {
        if (status.state === 'idle' || status.state === 'stopping' || status.state === 'failed') {
          return;
        }
        if (isGatewayReady(gatewayState)) {
          status = {
            state: 'ready',
            failureReason: null,
          };
          options.onTelemetryUpdated?.();
          return;
        }
        if (status.state !== 'starting' && isGatewayRecovering(gatewayState)) {
          status = {
            state: 'reconnecting',
            failureReason: null,
          };
          options.onTelemetryUpdated?.();
        }
      },
      (message) => {
        const summary = {
          messageType: message.type,
          action: 'action' in message ? message.action : undefined,
          toolSessionId: getDownstreamToolSessionId(message),
          welinkSessionId: 'welinkSessionId' in message ? message.welinkSessionId : undefined,
        };
        observation.downstreamReceived(summary);
        void (async () => {
          try {
            const command = await core.handleDownstream(message);
            observation.downstreamHandled(summary, command);
          } catch (error) {
            observation.downstreamFailed(
              summary,
              error,
              error instanceof RuntimeContractError ? error.code : undefined,
            );
            recordFailure(
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
      (error) => {
        setFailed('gateway_runtime_failure', 'runtime', error, error.code);
        options.onTelemetryUpdated?.();
      },
      options.onTelemetryUpdated,
    );
  };

  const createConnection = (): BridgeGatewayHostConnection =>
    internalOptions.connectionFactory?.(options.gatewayHost) ?? createDefaultBridgeGatewayHostConnection(gatewayHost);

  const cancelProbeForStart = async (): Promise<void> => {
    if (!probePromise || !probeAbortController) {
      return;
    }
    probeAbortController.abort(new Error('probe_cancelled_for_runtime_start'));
    await probePromise.catch(() => undefined);
  };

  const detachClient = (): void => {
    detachGatewayObservers?.();
    detachGatewayObservers = null;
    currentClient = null;
  };

  const disconnectCurrentClient = (): void => {
    currentClient?.disconnect();
    detachClient();
  };

  return {
    async start(): Promise<void> {
      if (status.state === 'ready') {
        return;
      }
      if (startPromise) {
        return startPromise;
      }

      observation.runtimeStartRequested();
      status = {
        state: 'starting',
        failureReason: null,
      };
      options.onTelemetryUpdated?.();

      startPromise = (async () => {
        try {
          await cancelProbeForStart();
          await core.start();
          const client = createConnection();
          attachClient(client);
          await client.connect();
          status = {
            state: 'ready',
            failureReason: null,
          };
          observation.runtimeStartCompleted();
          options.onTelemetryUpdated?.();
        } catch (error) {
          disconnectCurrentClient();
          setFailed('startup_failure', 'start', error);
          observation.runtimeStartFailed(error);
          options.onTelemetryUpdated?.();
          throw error;
        } finally {
          startPromise = null;
        }
      })();

      return startPromise;
    },
    async stop(): Promise<void> {
      if (probePromise) {
        await cancelProbeForStart();
      }
      if (status.state === 'idle') {
        return;
      }
      if (stopPromise) {
        return stopPromise;
      }

      observation.runtimeStopRequested();
      status = {
        state: 'stopping',
        failureReason: null,
      };
      options.onTelemetryUpdated?.();

      stopPromise = (async () => {
        try {
          await cancelProbeForStart();
          if (startPromise) {
            currentClient?.disconnect();
            await startPromise.catch(() => undefined);
          }
          disconnectCurrentClient();
          await core.stop();
          status = {
            state: 'idle',
            failureReason: null,
          };
          observation.runtimeStopCompleted();
          options.onTelemetryUpdated?.();
        } catch (error) {
          setFailed('gateway_runtime_failure', 'stop', error);
          observation.runtimeStopFailed(error);
          options.onTelemetryUpdated?.();
          throw error;
        } finally {
          stopPromise = null;
        }
      })();

      return stopPromise;
    },
    getStatus(): BridgeRuntimeStatusSnapshot {
      return { ...status };
    },
    async probe(input = { timeoutMs: 5_000 }): Promise<BridgeGatewayProbeResult> {
      const startedAt = Date.now();
      if (status.state === 'ready') {
        return {
          state: 'ready',
          latencyMs: 0,
          reason: 'runtime_ready',
        };
      }

      if (status.state === 'starting' || status.state === 'reconnecting') {
        const waitMs = Math.min(input.timeoutMs, 1_000);
        if (startPromise) {
          await Promise.race([startPromise.catch(() => undefined), sleep(waitMs)]);
        } else {
          await sleep(waitMs);
        }
        const postWaitState = status.state;
        if (isRuntimeReady(postWaitState)) {
          return {
            state: 'ready',
            latencyMs: Math.max(0, Date.now() - startedAt),
            reason: 'runtime_connected_after_wait',
          };
        }
        return {
          state: 'connecting',
          latencyMs: Math.max(0, Date.now() - startedAt),
          reason: 'runtime_connecting_probe_skipped',
        };
      }

      if (probePromise) {
        return probePromise;
      }

      probeAbortController = new AbortController();
      probePromise = probeBridgeGatewayHost(
        {
          gatewayHost,
          timeoutMs: input.timeoutMs,
          abortSignal: probeAbortController.signal,
        },
        {
          connectionFactory: internalOptions.connectionFactory
            ? () => internalOptions.connectionFactory!(options.gatewayHost)
            : undefined,
        },
      ).finally(() => {
        probePromise = null;
        probeAbortController = null;
      });
      return probePromise;
    },
    getDiagnostics() {
      return traceAdapter.snapshot();
    },
  };
}
