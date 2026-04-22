import type {
  GatewayBusinessMessage,
  GatewayClient,
  GatewayClientErrorShape,
  GatewayClientState,
  GatewayInboundFrame,
} from '@agent-plugin/gateway-client';

export interface GatewayLifecycleStartOptions {
  abortSignal?: AbortSignal;
}

/**
 * gateway 生命周期上行端口。
 * @remarks 只上抛连接生命周期事实与活跃 session 事件，不承载业务路由细节。
 */
export interface GatewayLifecyclePort {
  publishState(state: GatewayClientState): void;
  publishError(error: GatewayClientErrorShape): void;
  handleInbound(frame: GatewayInboundFrame): void;
  handleMessage(message: GatewayBusinessMessage): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void;
}

/**
 * gateway 生命周期协调器。
 * @remarks 负责 active connection 所有权、listener 生命周期与 stale event fail-closed。
 */
export interface GatewayLifecycleCoordinator {
  startSession(connection: GatewayClient, options?: GatewayLifecycleStartOptions): Promise<void>;
  stopSession(): void;
  getActiveConnection(): GatewayClient | null;
}

type ActiveGatewaySession = {
  id: number;
  connection: GatewayClient;
  cleanup: (() => void) | null;
};

type ListenerRemovable = GatewayClient & {
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

/**
 * 默认 gateway 生命周期协调器实现。
 * @remarks runtime 的 stop/start 边界在这里收口，确保旧 session 迟到事件不会回写状态。
 */
export class DefaultGatewayLifecycleCoordinator implements GatewayLifecycleCoordinator {
  private activeSession: ActiveGatewaySession | null = null;
  private nextSessionId = 1;
  private readonly port: GatewayLifecyclePort;

  constructor(port: GatewayLifecyclePort) {
    this.port = port;
  }

  getActiveConnection(): GatewayClient | null {
    return this.activeSession?.connection ?? null;
  }

  async startSession(connection: GatewayClient, options: GatewayLifecycleStartOptions = {}): Promise<void> {
    if (options.abortSignal?.aborted) {
      this.port.log('warn', 'gateway.lifecycle.start.aborted_precheck');
      throw new Error('runtime_start_aborted');
    }

    this.stopSession();

    const sessionId = this.nextSessionId++;
    const isActive = () => this.activeSession?.id === sessionId && this.activeSession.connection === connection;

    const stateChange = (state: GatewayClientState) => {
      if (!isActive()) {
        return;
      }
      this.port.log('info', 'gateway.state.changed', { state });
      this.port.publishState(state);
    };

    const error = (gatewayError: GatewayClientErrorShape) => {
      if (!isActive()) {
        return;
      }
      this.port.publishError(gatewayError);
    };

    const inbound = (frame: GatewayInboundFrame) => {
      if (!isActive()) {
        return;
      }
      this.port.handleInbound(frame);
    };

    const message = (gatewayMessage: GatewayBusinessMessage) => {
      if (!isActive()) {
        return;
      }
      this.port.handleMessage(gatewayMessage);
    };

    connection.on('stateChange', stateChange);
    connection.on('error', error);
    connection.on('inbound', inbound);
    connection.on('message', message);

    const cleanup = () => {
      const removable = connection as ListenerRemovable;
      const remove = removable.off?.bind(removable) ?? removable.removeListener?.bind(removable);
      if (!remove) {
        return;
      }
      remove('stateChange', stateChange as (...args: unknown[]) => void);
      remove('error', error as (...args: unknown[]) => void);
      remove('inbound', inbound as (...args: unknown[]) => void);
      remove('message', message as (...args: unknown[]) => void);
    };

    this.activeSession = {
      id: sessionId,
      connection,
      cleanup,
    };

    try {
      await connection.connect();
      if (!isActive()) {
        this.port.log('warn', 'gateway.lifecycle.start.cancelled', { sessionId });
        throw new Error('runtime_start_aborted');
      }
    } catch (sessionError) {
      if (!isActive()) {
        this.port.log('warn', 'gateway.lifecycle.start.cancelled', { sessionId });
        throw new Error('runtime_start_aborted');
      }
      if (isActive()) {
        this.stopSession();
      }
      throw sessionError;
    }
  }

  stopSession(): void {
    const session = this.activeSession;
    if (!session) {
      return;
    }

    this.activeSession = null;
    session.cleanup?.();
    session.connection.disconnect();
  }
}
