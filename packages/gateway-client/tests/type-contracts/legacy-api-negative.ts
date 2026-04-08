import type { GatewayConnectionOptions } from '../../src/legacy/connection-compat.ts';

const _options: GatewayConnectionOptions = {
  url: 'ws://localhost:8081/ws/agent',
  registerMessage: {
    type: 'register',
    deviceName: 'dev',
    os: 'darwin',
    toolType: 'opencode',
    toolVersion: '1.0.0',
  },
  webSocketFactory: () => {
    throw new Error('should not compile');
  },
};
