import type {
  BridgeRuntime,
  BridgeRuntimeStatus,
  BridgeRuntimeStatusSnapshot,
  OutboundFact,
  RuntimeOutboundEmitter,
} from '../../src/index.ts';

declare const runtime: BridgeRuntime;
declare const outboundFacts: AsyncIterable<OutboundFact>;

const status = runtime.getStatus();
const snapshot: BridgeRuntimeStatusSnapshot = status;
const state: BridgeRuntimeStatus = status.state;
const failureReason: string | null = status.failureReason;

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
void explicitSnapshot;
void idleSnapshot;
