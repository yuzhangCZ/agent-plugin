import {
  createGatewayClient,
  createAkSkAuthProvider,
  type GatewayBusinessMessage,
  type GatewayClientConfig,
  type GatewayClientErrorCode,
  type GatewayInboundFrame,
  type GatewayOutboundMessage,
  type GatewaySendPayload,
} from '../../src/index.ts';

const authProvider = createAkSkAuthProvider('ak', 'sk');

const config: GatewayClientConfig = {
  url: 'ws://localhost:8081/ws/agent',
  authPayloadProvider: () => authProvider.generateAuthPayload(),
  registerMessage: {
    type: 'register',
    deviceName: 'dev',
    os: 'darwin',
    toolType: 'opencode',
    toolVersion: '1.0.0',
  },
  reconnect: {
    baseMs: 1000,
    maxMs: 30000,
    exponential: true,
  },
};

const client = createGatewayClient(config);

client.on('message', (_message: GatewayBusinessMessage) => {});
client.on('inbound', (_message: GatewayInboundFrame) => {});
client.on('outbound', (_message: GatewayOutboundMessage) => {});

const payload: GatewaySendPayload = { type: 'tool_done', toolSessionId: 'tool-1' };
const _errorCode: GatewayClientErrorCode = 'GATEWAY_NOT_READY';
client.send(payload);
client.getStatus().isReady();
