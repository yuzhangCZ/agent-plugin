import type {
  ActiveRunChatPolicy,
  BridgeGatewayHostConfig,
  BridgeRuntime,
  BridgeRuntimeError,
  BridgeRuntimeErrorCode,
  BridgeRuntimeOptions,
  BridgeRuntimeStatus,
  BridgeRuntimeStatusSnapshot,
  OutboundFact,
  ProviderAbortSessionInput,
  RequestRunPolicyOptions,
  RuntimeOutboundEmitter,
  ThirdPartyAgentProvider,
} from '../../src/index.ts';

declare const runtime: BridgeRuntime;
declare const outboundFacts: AsyncIterable<OutboundFact>;
declare const provider: ThirdPartyAgentProvider;
declare const gatewayHost: BridgeGatewayHostConfig;

const status = runtime.getStatus();
const snapshot: BridgeRuntimeStatusSnapshot = status;
const state: BridgeRuntimeStatus = status.state;
const failureReason: string | null = status.failureReason;
const statusError: BridgeRuntimeError | undefined = status.error;
const gatewayTransportErrorCode: BridgeRuntimeErrorCode = 'gateway_transport_error';
const activeRunChatPolicy: ActiveRunChatPolicy = 'forwardToProvider';
const requestRunPolicy: RequestRunPolicyOptions = { activeRunChatPolicy };
const runtimeOptionsWithPolicy: BridgeRuntimeOptions = {
  provider,
  gatewayHost,
  requestRunPolicy,
};
const providerAbortSessionInput: ProviderAbortSessionInput = {
  traceId: 'trace-1',
  toolSessionId: 'tool-session-1',
  runIds: ['run-1'],
};

const explicitSnapshot: BridgeRuntimeStatusSnapshot = {
  state: 'failed',
  failureReason: 'gateway transport error',
};

const idleSnapshot: BridgeRuntimeStatusSnapshot = {
  state: 'idle',
  failureReason: null,
};

const outboundEmitter: RuntimeOutboundEmitter = {
  /**
   * @deprecated 这里保留调用形态，确保废弃接口仍在 public contract 中。
   */
  emitOutboundMessage: async () => ({ applied: true }),
  emitOutboundRun: async () => ({ applied: true }),
};

void outboundEmitter.emitOutboundRun({
  toolSessionId: 'tool-session-1',
  runId: 'run-1',
  trigger: 'webhook',
  facts: outboundFacts,
});

void snapshot;
void state;
void failureReason;
void statusError;
void gatewayTransportErrorCode;
void runtimeOptionsWithPolicy;
void providerAbortSessionInput;
void explicitSnapshot;
void idleSnapshot;
