import test from 'node:test';
import assert from 'node:assert/strict';

import { GatewaySchemaCodecAdapter } from '../src/adapters/GatewaySchemaCodecAdapter.ts';
import { BusinessMessageHandler } from '../src/application/handlers/BusinessMessageHandler.ts';
import { HandshakeFrameProcessor } from '../src/application/runtime/HandshakeFrameProcessor.ts';
import { InboundFrameClassifier } from '../src/application/runtime/InboundFrameClassifier.ts';
import { InboundFrameRouter } from '../src/application/runtime/InboundFrameRouter.ts';
import type {
  GatewayRuntimeContext,
  GatewayRuntimeStatePort,
} from '../src/application/runtime/GatewayRuntimeContracts.ts';
import { GatewayClientStatus } from '../src/domain/state.ts';
import { GatewayClientError } from '../src/errors/GatewayClientError.ts';

function createContext(overrides: Partial<GatewayRuntimeContext> = {}): GatewayRuntimeContext {
  return {
    options: {
      url: 'ws://localhost:8081/ws/agent',
      registerMessage: {
        type: 'register',
        deviceName: 'dev',
        os: 'darwin',
        toolType: 'opencode',
        toolVersion: '1.0.0',
        pluginVersion: '0.2.0',
      },
    },
    telemetry: {
      logRawFrame() {},
      markReceived(raw: unknown) {
        const messageType =
          raw && typeof raw === 'object' && 'type' in raw ? (raw as { type?: string }).type : undefined;
        return { messageType, gatewayMessageId: undefined };
      },
    } as GatewayRuntimeContext['telemetry'],
    sink: {
      emitStatusChange() {},
      emitInbound() {},
      emitOutbound() {},
      emitHeartbeat() {},
      emitMessage() {},
    },
    reconnectEnabled: true,
    authSubprotocolBuilder: () => 'auth.test',
    ...overrides,
  };
}

function createState(status: GatewayClientStatus = GatewayClientStatus.connecting()): GatewayRuntimeStatePort {
  let currentStatus = status;
  return {
    getStatus() {
      return currentStatus;
    },
    isConnected() {
      return currentStatus.isReady();
    },
    isManuallyDisconnected() {
      return false;
    },
    beginConnect() {
      return { generation: 0, sessionId: 1 };
    },
    finishConnectIfCurrent() {
      currentStatus = GatewayClientStatus.ready();
      return true;
    },
    markReconnectingIfCurrent() {
      currentStatus = GatewayClientStatus.reconnecting();
      return true;
    },
    beginReconnectWindow() {
      currentStatus = GatewayClientStatus.reconnecting();
      return 0;
    },
    closeReconnectExhaustedIfCurrent() {
      currentStatus = GatewayClientStatus.closed(new GatewayClientError({
        code: 'GATEWAY_RECONNECT_EXHAUSTED',
        disposition: 'runtime_failure',
        retryable: false,
        message: 'gateway_reconnect_exhausted',
      }));
      return true;
    },
    isCurrentGeneration() {
      return true;
    },
    closeIfCurrent(_token, error) {
      currentStatus = GatewayClientStatus.closed(error);
      return true;
    },
    isCurrentSession() {
      return true;
    },
  };
}

test('handshake frame processor interprets register_ok and register_rejected without side effects', () => {
  const processor = new HandshakeFrameProcessor();

  assert.deepEqual(
    processor.process({
      kind: 'control',
      messageType: 'register_ok',
      message: { type: 'register_ok' },
    }),
    { kind: 'ready' },
  );

  const rejected = processor.process({
    kind: 'control',
    messageType: 'register_rejected',
    message: { type: 'register_rejected', reason: 'duplicate_connection' },
  });

  assert.equal(rejected.kind, 'rejected');
  assert.equal(rejected.error.code, 'GATEWAY_HANDSHAKE_REJECTED');
  assert.equal(rejected.error.disposition, 'startup_failure');
});

test('inbound frame classifier separates handshake control from business and invalid frames', async () => {
  const classifier = new InboundFrameClassifier(createContext(), new GatewaySchemaCodecAdapter());

  const handshake = await classifier.classify({ data: JSON.stringify({ type: 'register_ok' }) });
  assert.equal(handshake.kind, 'handshake-control');

  const business = await classifier.classify({ data: JSON.stringify({ type: 'status_query' }) });
  assert.equal(business.kind, 'business');

  const invalidControl = await classifier.classify({ data: JSON.stringify({ type: 'register_rejected' }) });
  assert.equal(invalidControl.kind, 'handshake-control');

  const parseError = await classifier.classify({ data: '{"bad":' });
  assert.equal(parseError.kind, 'nonparsed');
});

test('inbound frame router surfaces invalid business frames without transport side effects', async () => {
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const messages: unknown[] = [];
  const inbound: unknown[] = [];
  const state = createState(GatewayClientStatus.ready());
  const router = new InboundFrameRouter(
    new BusinessMessageHandler(),
    createContext({
      logger: {
        error(message, meta) {
          logs.push({ message, meta });
        },
      },
      sink: {
        emitStatusChange() {},
        emitInbound(message) {
          inbound.push(message);
        },
        emitOutbound() {},
        emitHeartbeat() {},
        emitMessage(message) {
          messages.push(message);
        },
      },
    }),
    state,
  );

  await router.route({
    kind: 'invalid-business',
    frame: {
      kind: 'invalid',
      messageType: 'invoke',
      rawPreview: { type: 'invoke', payload: {} },
      violation: {
        violation: {
          stage: 'payload',
          code: 'missing_required_field',
          field: 'payload.text',
          message: 'payload.text is required',
          messageType: 'invoke',
        },
      },
    },
  });

  assert.equal(messages.length, 0);
  assert.equal(inbound.length, 0);
  assert.equal(logs[0]?.message, 'gateway.business.validation_failed');
});
