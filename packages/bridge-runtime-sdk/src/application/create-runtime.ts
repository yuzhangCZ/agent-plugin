import { randomUUID } from 'node:crypto';

import {
  createGatewayClient,
  type GatewayBusinessMessage,
  type GatewayClient,
  type GatewayClientConfig,
  type GatewayClientErrorShape,
  type GatewayClientState,
  type GatewayInboundFrame,
  type GatewayOutboundMessage,
} from '@agent-plugin/gateway-client';
import {
  type GatewayDownstreamBusinessRequest,
  type HeartbeatMessage,
  validateGatewayUplinkBusinessMessage,
} from '@agent-plugin/gateway-schema';

import { RuntimeContractError } from '../domain/errors.ts';
import type { ThirdPartyAgentProvider } from '../domain/provider.ts';
import { toRuntimeCommand } from '../adapters/GatewayDownstreamCommandAdapter.ts';
import type { PendingInteractionRegistry, SessionRuntimeRegistry } from './registries.ts';
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
import { ProviderApiAdapter } from './provider-api-adapter.ts';
import {
  AbortExecutionUseCase,
  CloseSessionUseCase,
  CreateSessionUseCase,
  QueryStatusUseCase,
  ReplyPermissionUseCase,
  ReplyQuestionUseCase,
  StartRequestRunUseCase,
} from './usecases.ts';
import { RuntimeTraceCollector } from './runtime-trace.ts';
import type { BridgeRuntime, BridgeRuntimeStatusSnapshot } from './runtime.ts';

interface BridgeRuntimeCoreOptions {
  provider: ThirdPartyAgentProvider;
  sink: GatewayOutboundSink;
  traceIdFactory?: () => string;
  trace?: RuntimeTraceCollector;
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
  handleDownstream(message: GatewayDownstreamBusinessRequest): Promise<void>;
  getDiagnostics(): ReturnType<RuntimeTraceCollector['snapshot']>;
}

/**
 * gateway 集成层可观测钩子。
 * @remarks
 * 这些钩子只用于宿主 glue 观察 gateway-client 事件，不改变 runtime core 的协议边界。
 */
export interface BridgeRuntimeGatewayObserver {
  onStateChange?(state: GatewayClientState): void;
  onInboundFrame?(frame: GatewayInboundFrame): void;
  onOutboundMessage?(message: GatewayOutboundMessage): void;
  onHeartbeat?(message: HeartbeatMessage): void;
  onError?(error: GatewayClientErrorShape): void;
  adaptDownstreamMessage?(
    message: GatewayBusinessMessage,
  ): GatewayDownstreamBusinessRequest | Promise<GatewayDownstreamBusinessRequest>;
}

/**
 * 创建 host runtime 所需的公开配置。
 */
export interface BridgeRuntimeOptions {
  provider: ThirdPartyAgentProvider;
  gateway: GatewayClientConfig;
  traceIdFactory?: () => string;
  connectionFactory?: (config: GatewayClientConfig) => GatewayClient;
  observer?: BridgeRuntimeGatewayObserver;
}

function normalizeErrorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return error instanceof Error ? error.message : String(error);
}

function classifyRequestFailureKind(error: unknown): 'command_execution_failure' | 'outbound_validation_failure' {
  if (error instanceof RuntimeContractError && error.code === 'fact_sequence_invalid') {
    return 'outbound_validation_failure';
  }
  return 'command_execution_failure';
}

function isGatewayReady(state: GatewayClientState): boolean {
  return state === 'READY';
}

function isGatewayRecovering(state: GatewayClientState): boolean {
  return state === 'CONNECTING' || state === 'CONNECTED' || state === 'DISCONNECTED';
}

function createBridgeRuntimeCore(options: BridgeRuntimeCoreOptions): InternalBridgeRuntimeCore {
  const trace = options.trace ?? new RuntimeTraceCollector();
  const sessionRegistry = options.sessionRegistry ?? new InMemorySessionRuntimeRegistry();
  const pendingInteractionRegistry =
    options.pendingInteractionRegistry ?? new InMemoryPendingInteractionRegistry();
  const factProjector = options.factProjector ?? new DefaultFactToSkillEventProjector();
  const eventProjector = options.eventProjector ?? new DefaultSkillEventToGatewayMessageProjector();
  const commandResultProjector = options.commandResultProjector ?? new DefaultGatewayCommandResultProjector();
  const terminalProjector = options.terminalProjector ?? new DefaultRunTerminalSignalProjector();
  const validator = new FactSequenceValidator();
  const providerHandlers = new ProviderApiAdapter(options.provider, trace);
  const interactionCoordinator = new InteractionCoordinator(pendingInteractionRegistry, trace);
  const requestRunCoordinator = new RequestRunCoordinator(
    sessionRegistry,
    interactionCoordinator,
    validator,
    {
      sink: options.sink,
      factProjector,
      eventProjector,
      trace,
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
      trace,
    },
  );

  const dispatcher = new RuntimeCommandDispatcher({
    query_status: new QueryStatusUseCase(providerHandlers, options.sink, commandResultProjector, trace),
    create_session: new CreateSessionUseCase(
      providerHandlers,
      sessionRegistry,
      options.sink,
      commandResultProjector,
      trace,
    ),
    start_request_run: new StartRequestRunUseCase(providerHandlers, sessionRegistry, requestRunCoordinator),
    reply_question: new ReplyQuestionUseCase(providerHandlers, interactionCoordinator),
    reply_permission: new ReplyPermissionUseCase(providerHandlers, interactionCoordinator),
    close_session: new CloseSessionUseCase(providerHandlers, sessionRegistry, interactionCoordinator),
    abort_execution: new AbortExecutionUseCase(providerHandlers, sessionRegistry),
  });

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
    },
    async stop(): Promise<void> {
      if (!initialized) {
        return;
      }
      await options.provider.dispose?.();
      initialized = false;
    },
    async handleDownstream(message: GatewayDownstreamBusinessRequest): Promise<void> {
      const traceId = options.traceIdFactory?.() ?? randomUUID();
      const command = toRuntimeCommand(message, traceId);
      await dispatcher.dispatch(command);
    },
    getDiagnostics() {
      return trace.snapshot();
    },
  };
}

function attachGatewayClientObservers(
  client: GatewayClient,
  observer: BridgeRuntimeGatewayObserver | undefined,
  onGatewayStateChange: (state: GatewayClientState) => void,
  onBusinessMessage: (message: GatewayBusinessMessage) => void,
  onNonRetryableError: (error: GatewayClientErrorShape) => void,
): () => void {
  const stateChange = (state: GatewayClientState) => {
    observer?.onStateChange?.(state);
    onGatewayStateChange(state);
  };
  const inbound = (frame: GatewayInboundFrame) => {
    observer?.onInboundFrame?.(frame);
  };
  const outbound = (message: GatewayOutboundMessage) => {
    observer?.onOutboundMessage?.(message);
  };
  const heartbeat = (message: HeartbeatMessage) => {
    observer?.onHeartbeat?.(message);
  };
  const message = (payload: GatewayBusinessMessage) => {
    onBusinessMessage(payload);
  };
  const error = (gatewayError: GatewayClientErrorShape) => {
    observer?.onError?.(gatewayError);
    if (!gatewayError.retryable) {
      onNonRetryableError(gatewayError);
    }
  };

  client.on('stateChange', stateChange);
  client.on('inbound', inbound);
  client.on('outbound', outbound);
  client.on('heartbeat', heartbeat);
  client.on('message', message);
  client.on('error', error);

  return () => {
    const eventEmitter = client as GatewayClient & {
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
  const trace = new RuntimeTraceCollector();
  const currentClient = options.connectionFactory?.(options.gateway) ?? createGatewayClient(options.gateway);
  const sink: GatewayOutboundSink = {
    send(message) {
      const validation = validateGatewayUplinkBusinessMessage(message);
      if (!validation.ok) {
        trace.recordFailure({
          kind: 'outbound_validation_failure',
          phase: 'runtime',
          message: validation.error.violation.message,
          code: validation.error.violation.code,
        });
        return;
      }
      currentClient.send(validation.value);
    },
  };
  const core = createBridgeRuntimeCore({
    provider: options.provider,
    sink,
    traceIdFactory: options.traceIdFactory,
    trace,
  });

  let status: BridgeRuntimeStatusSnapshot = {
    state: 'idle',
    connected: false,
    ready: false,
    lastError: null,
  };
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
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
    trace.recordFailure({ kind, phase, message, code });
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
      ready: false,
      lastError: message,
    };
  };

  attachGatewayClientObservers(
    currentClient,
    options.observer,
    (gatewayState) => {
      if (status.state === 'idle' || status.state === 'stopping' || status.state === 'stopped' || status.state === 'failed') {
        return;
      }
      if (isGatewayReady(gatewayState)) {
        status = {
          ...status,
          state: 'ready',
          connected: currentClient.isConnected(),
          ready: true,
          gatewayState,
          lastError: null,
        };
        return;
      }
      if (status.state !== 'starting' && isGatewayRecovering(gatewayState)) {
        status = {
          ...status,
          state: 'reconnecting',
          connected: currentClient.isConnected(),
          ready: false,
          gatewayState,
        };
      }
    },
    (message) => {
      void (async () => {
        try {
          const adapted =
            (await options.observer?.adaptDownstreamMessage?.(message)) ?? message;
          await core.handleDownstream(adapted);
        } catch (error) {
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
    },
  );

  const diagnostics = () => core.getDiagnostics();

  return {
    async start(): Promise<void> {
      if (status.state === 'ready') {
        return;
      }
      if (startPromise) {
        return startPromise;
      }

      status = {
        ...status,
        state: 'starting',
        connected: false,
        ready: false,
        lastError: null,
      };

      startPromise = (async () => {
        try {
          await core.start();
          await currentClient.connect();
          const gatewayStatus = currentClient.getStatus();
          if (!gatewayStatus.isReady()) {
            throw new Error('gateway_client_not_ready');
          }
          status = {
            state: 'ready',
            connected: currentClient.isConnected(),
            ready: true,
            gatewayState: currentClient.getState(),
            lastError: null,
          };
        } catch (error) {
          setFailed('startup_failure', 'start', error);
          throw error;
        } finally {
          startPromise = null;
        }
      })();

      return startPromise;
    },
    async stop(): Promise<void> {
      if (status.state === 'idle' || status.state === 'stopped') {
        return;
      }
      if (stopPromise) {
        return stopPromise;
      }

      status = {
        ...status,
        state: 'stopping',
        ready: false,
      };

      stopPromise = (async () => {
        try {
          if (startPromise) {
            await startPromise.catch(() => undefined);
          }
          currentClient.disconnect();
          await core.stop();
          status = {
            state: 'stopped',
            connected: false,
            ready: false,
            lastError: null,
          };
        } catch (error) {
          setFailed('gateway_runtime_failure', 'stop', error);
          throw error;
        } finally {
          stopPromise = null;
        }
      })();

      return stopPromise;
    },
    getStatus(): BridgeRuntimeStatusSnapshot {
      return {
        ...status,
        ...(currentClient
          ? {
              connected: currentClient.isConnected(),
              gatewayState: currentClient.getState(),
            }
          : {}),
      };
    },
    getDiagnostics() {
      return diagnostics();
    },
  };
}
