import { randomUUID } from 'node:crypto';

import {
  type GatewayInboundFrame,
} from '@agent-plugin/gateway-client';
import {
  type GatewayDownstreamBusinessRequest,
  type ToolErrorMessage,
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

type InvalidInvokeGatewayInboundFrame = Extract<GatewayInboundFrame, { kind: 'invalid' }> & {
  messageType: 'invoke';
};

function shouldReplyToInvalidInvoke(frame: GatewayInboundFrame): frame is InvalidInvokeGatewayInboundFrame {
  return frame.kind === 'invalid' && frame.messageType === 'invoke';
}

function handleInvalidInvokeInboundFrame(
  frame: InvalidInvokeGatewayInboundFrame,
  client: BridgeGatewayHostConnection,
  trace: RuntimeTraceCollector,
  sink: GatewayOutboundSink,
): void {
  trace.recordFailure({
    kind: 'inbound_validation_failure',
    phase: 'runtime',
    message: frame.violation.violation.message,
    code: frame.violation.violation.code,
  });

  if (!frame.welinkSessionId && !frame.toolSessionId) {
    return;
  }

  const gatewayStatus = client.getStatus?.();
  if (typeof gatewayStatus?.isReady === 'function' && !gatewayStatus.isReady()) {
    return;
  }

  const toolError: ToolErrorMessage = {
    type: 'tool_error',
    ...(frame.welinkSessionId ? { welinkSessionId: frame.welinkSessionId } : {}),
    ...(frame.toolSessionId ? { toolSessionId: frame.toolSessionId } : {}),
    error: buildInvalidInvokeToolError(frame.violation.violation.code),
  };
  trace.recordUplink(toolError);
  sink.send(toolError);
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
  client: BridgeGatewayHostConnection,
  trace: RuntimeTraceCollector,
  sink: GatewayOutboundSink,
  onGatewayStateChange: (state: BridgeGatewayHostState) => void,
  onBusinessMessage: (message: GatewayDownstreamBusinessRequest) => void,
  onNonRetryableError: (error: BridgeGatewayHostError) => void,
  onTelemetryUpdated?: () => void,
): () => void {
  const stateChange = (state: BridgeGatewayHostState) => {
    trace.recordGatewayState(state);
    if (state === 'READY') {
      trace.recordReadyAt(Date.now());
    }
    onGatewayStateChange(state);
    onTelemetryUpdated?.();
  };
  const inbound = (frame: GatewayInboundFrame) => {
    trace.recordInboundAt(Date.now());
    if (shouldReplyToInvalidInvoke(frame)) {
      handleInvalidInvokeInboundFrame(frame, client, trace, sink);
    }
    onTelemetryUpdated?.();
  };
  const outbound = () => {
    trace.recordOutboundAt(Date.now());
    onTelemetryUpdated?.();
  };
  const heartbeat = () => {
    trace.recordHeartbeatAt(Date.now());
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
  client.on('inbound', inbound);
  client.on('outbound', outbound);
  client.on('heartbeat', heartbeat);
  client.on('message', message);
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
  const trace = new RuntimeTraceCollector();
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
      ensureCurrentClient().send(validation.value);
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
      trace,
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
        void (async () => {
          try {
            await core.handleDownstream(message);
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
          options.onTelemetryUpdated?.();
        } catch (error) {
          disconnectCurrentClient();
          setFailed('startup_failure', 'start', error);
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
          options.onTelemetryUpdated?.();
        } catch (error) {
          setFailed('gateway_runtime_failure', 'stop', error);
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
      return diagnostics();
    },
  };
}
